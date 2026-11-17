#!/usr/bin/env node
// Records the live order book (best five bids and asks) of a set of liquid NSE stocks, one snapshot
// every few seconds, into .cache/depth/YYYY-MM-DD.jsonl. READ-ONLY: it only asks Upstox for quotes.
//
//   node scripts/record-depth.mjs [--symbols ITC,TATASTEEL,...] [--interval 3] [--until 15:30] [--once]
//
// One HTTP request per snapshot covers every symbol (Upstox "full market quote", up to 500 keys).
// See scripts/README-depth.md.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".cache");
// Test hooks (used only to rehearse the loop against a local fake server; never set these for real recording):
//   DEPTH_TEST_URL              fake quote endpoint; the real token is NOT sent to it
//   DEPTH_TEST_CLOCK_OFFSET_MS  shifts this script's clock, to pretend the market is open
//   DEPTH_TEST_OUT              write somewhere other than .cache/depth
const TEST_URL = process.env.DEPTH_TEST_URL || "";
const CLOCK_OFFSET_MS = Number(process.env.DEPTH_TEST_CLOCK_OFFSET_MS) || 0;
const nowMs = () => Date.now() + CLOCK_OFFSET_MS;
const OUT_DIR = process.env.DEPTH_TEST_OUT || path.join(CACHE, "depth");
const QUOTE_URL = TEST_URL || "https://api.upstox.com/v2/market-quote/quotes";
const INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

const DEFAULT_SYMBOLS =
  "ITC,TATASTEEL,ONGC,BPCL,COALINDIA,POWERGRID,NTPC,WIPRO,SAIL,BANKBARODA,PNB,CANBK,IOC,GAIL,BEL,TATAPOWER,VEDL,ASHOKLEY,NMDC,PETRONET";

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const OPEN_S = 9 * 3600 + 15 * 60;
const CLOSE_S = 15 * 3600 + 30 * 60;
/** Give up for the day if no stock has shown a two-sided book for this long during market hours. */
const HOLIDAY_AFTER_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { symbols: DEFAULT_SYMBOLS, interval: 3, until: "15:30", once: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${k} needs a value`);
      return v;
    };
    if (k === "--symbols") a.symbols = next();
    else if (k === "--interval") a.interval = Number(next());
    else if (k === "--until") a.until = next();
    else if (k === "--once") a.once = true;
    else if (k === "--help" || k === "-h") {
      console.log("node scripts/record-depth.mjs [--symbols ITC,TATASTEEL,...] [--interval 3] [--until 15:30] [--once]");
      process.exit(0);
    } else fail(`Unknown option ${k}`);
  }
  if (!(a.interval >= 1)) fail("--interval must be 1 second or more (Upstox locks accounts out for bursts)");
  const m = /^(\d{1,2}):(\d{2})$/.exec(a.until);
  if (!m) fail("--until must look like 15:30");
  a.untilS = Math.min(CLOSE_S, Number(m[1]) * 3600 + Number(m[2]) * 60);
  a.symbolList = [...new Set(a.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (a.symbolList.length === 0) fail("No symbols given");
  if (a.symbolList.length > 500) fail("At most 500 symbols fit in one request");
  return a;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Clock (IST)
// ---------------------------------------------------------------------------

const istDate = (t) => new Date(t + IST_OFFSET_MS);
const istDay = (t) => istDate(t).toISOString().slice(0, 10);
const istClock = (t) => istDate(t).toISOString().slice(11, 19);
const istSecond = (t) => ((t + IST_OFFSET_MS) % 86_400_000) / 1000;
const isWeekday = (t) => {
  const d = istDate(t).getUTCDay();
  return d !== 0 && d !== 6;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Epoch ms of the next 09:15 IST on a weekday, at or after `t`. */
function nextOpen(t) {
  let midnight = Math.floor((t + IST_OFFSET_MS) / 86_400_000) * 86_400_000 - IST_OFFSET_MS;
  for (let i = 0; i < 8; i++, midnight += 86_400_000) {
    const open = midnight + OPEN_S * 1000;
    if (open >= t && isWeekday(open)) return open;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Token and instrument keys
// ---------------------------------------------------------------------------

/** The read-only access token from .env.local. It is only ever put in the Authorization header. */
function readToken() {
  let text = "";
  try {
    text = readFileSync(path.join(ROOT, ".env.local"), "utf8");
  } catch {
    /* no file: fall through to the environment */
  }
  const m = /^\s*UPSTOX_ACCESS_TOKEN\s*=\s*(.*)$/m.exec(text);
  const token = (m ? m[1] : (process.env.UPSTOX_ACCESS_TOKEN ?? "")).trim().replace(/^["']|["']$/g, "");
  if (!token) fail("No UPSTOX_ACCESS_TOKEN in .env.local. Add the read-only token from the Upstox developer console.");
  return token;
}

/** NSE trading symbol -> Upstox instrument key. Uses the app's cached list when present, else downloads it (no login needed). */
async function instrumentKeys(symbols, now) {
  const fromFile = (name) => {
    try {
      const map = JSON.parse(readFileSync(path.join(CACHE, name), "utf8"));
      return map && typeof map.equity === "object" ? map.equity : null;
    } catch {
      return null;
    }
  };
  let equity = fromFile(`upstox-nse-${istDay(now)}.json`);
  let source = "today's cached list";
  if (!equity) {
    try {
      const res = await fetch(INSTRUMENTS_URL, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8"));
      equity = {};
      for (const r of rows) {
        if (r.segment === "NSE_EQ" && r.instrument_type === "EQ" && r.trading_symbol && r.instrument_key) equity[r.trading_symbol] = r.instrument_key;
      }
      source = "list downloaded from Upstox";
    } catch (e) {
      const older = existsSync(CACHE) ? readdirSync(CACHE).filter((n) => /^upstox-nse-\d{4}-\d\d-\d\d\.json$/.test(n)).sort().pop() : undefined;
      equity = older ? fromFile(older) : null;
      if (!equity) fail(`Could not get the Upstox instrument list (${e.message}) and no cached copy exists.`);
      source = `older cached list (${older}); download failed: ${e.message}`;
    }
  }
  const keyToSymbol = new Map();
  const missing = [];
  for (const s of symbols) {
    if (equity[s]) keyToSymbol.set(equity[s], s);
    else missing.push(s);
  }
  if (missing.length) console.log(`Not on the NSE equity list, skipped: ${missing.join(", ")}`);
  if (keyToSymbol.size === 0) fail("None of the symbols are on the NSE equity list.");
  return { keyToSymbol, source };
}

// ---------------------------------------------------------------------------
// One snapshot = one request
// ---------------------------------------------------------------------------

const levels = (side) =>
  (Array.isArray(side) ? side : [])
    .slice(0, 5)
    .map((l) => [Number(l?.price) || 0, Number(l?.quantity) || 0, Number(l?.orders) || 0]);

const liveLevels = (ls) => ls.filter((l) => l[0] > 0 && l[1] > 0);

/**
 * Fetch the full quote for every key in one request.
 * Returns { ok: true, rows, latency } or { ok: false, status, retryAfterS, message }.
 */
async function snapshot(url, token, keyToSymbol, timeoutMs) {
  const started = nowMs();
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, status: 0, message: e?.name === "TimeoutError" ? "timed out" : `network error (${e?.cause?.code ?? e?.message ?? "unknown"})` };
  }
  if (res.status === 429) {
    const h = res.headers.get("retry-after");
    let wait = Number(h);
    if (!(wait > 0) && h) wait = (Date.parse(h) - nowMs()) / 1000; // the header may be a date
    await res.arrayBuffer().catch(() => null);
    return { ok: false, status: 429, retryAfterS: wait > 0 ? Math.ceil(wait) : 60, message: "rate limited" };
  }
  const body = await res.json().catch(() => null);
  const t = nowMs();
  if (!res.ok || body?.status !== "success" || !body.data) {
    const err = body?.errors?.[0];
    return { ok: false, status: res.status, message: `${err?.errorCode ?? err?.error_code ?? ""} ${err?.message ?? `HTTP ${res.status}`}`.trim() };
  }
  const rows = [];
  for (const q of Object.values(body.data)) {
    const s = keyToSymbol.get(q?.instrument_token);
    if (!s) continue;
    const row = {
      t,
      s,
      ltp: Number(q.last_price) || 0,
      vol: Number(q.volume) || 0,
      tbq: Number(q.total_buy_quantity) || 0,
      tsq: Number(q.total_sell_quantity) || 0,
      b: levels(q.depth?.buy),
      a: levels(q.depth?.sell),
    };
    const ltt = Number(q.last_trade_time);
    if (ltt > 0) row.ltt = ltt;
    rows.push(row);
  }
  return { ok: true, rows, latency: t - started };
}

const twoSided = (r) => liveLevels(r.b).length > 0 && liveLevels(r.a).length > 0;

function gcdPaise(prices) {
  let g = 0;
  for (const p of prices) {
    let a = Math.round(p * 100);
    let b = g;
    while (b) [a, b] = [b, a % b];
    g = a;
  }
  return g;
}

// ---------------------------------------------------------------------------
// --once: one snapshot, summary without prices
// ---------------------------------------------------------------------------

async function once(url, token, keyToSymbol) {
  const now = nowMs();
  const open = isWeekday(now) && istSecond(now) >= OPEN_S && istSecond(now) <= CLOSE_S;
  console.log(`${istDay(now)} ${istClock(now)} IST - market is ${open ? "OPEN" : "CLOSED (the book below is whatever Upstox still holds, probably empty or stale)"}`);
  const r = await snapshot(url, token, keyToSymbol, 15_000);
  if (!r.ok) {
    console.log(`Request failed: HTTP ${r.status || "-"} ${r.message}${r.retryAfterS ? ` (retry after ${r.retryAfterS} s)` : ""}`);
    process.exit(1);
  }
  console.log(`HTTP 200 in ${r.latency} ms, ${r.rows.length} of ${keyToSymbol.size} symbols returned. Prices are not shown.`);
  console.log("symbol       bid levels  ask levels  5+5 present  spread (ticks)  tbq>0  tsq>0  last trade (IST)");
  for (const row of r.rows.sort((x, y) => (x.s < y.s ? -1 : 1))) {
    const b = liveLevels(row.b);
    const a = liveLevels(row.a);
    let spreadTicks = "n/a";
    if (b.length && a.length) {
      const tick = gcdPaise([...b, ...a].map((l) => l[0]));
      const sp = Math.round((a[0][0] - b[0][0]) * 100);
      spreadTicks = tick > 0 ? `${sp / tick}${b.length + a.length < 4 ? "?" : ""}` : "n/a";
    }
    const ltt = row.ltt ? `${istDay(row.ltt)} ${istClock(row.ltt)}` : "not given";
    console.log(
      `${row.s.padEnd(12)} ${String(b.length).padEnd(11)} ${String(a.length).padEnd(11)} ${(b.length === 5 && a.length === 5 ? "yes" : "no").padEnd(12)} ${String(spreadTicks).padEnd(15)} ${(row.tbq > 0 ? "yes" : "no").padEnd(6)} ${(row.tsq > 0 ? "yes" : "no").padEnd(6)} ${ltt}`,
    );
  }
  const good = r.rows.filter(twoSided).length;
  console.log(`${good} of ${r.rows.length} symbols have a two-sided book right now. Nothing was written to disk (--once).`);
  const bytes = r.rows.length ? Math.round(r.rows.reduce((n, row) => n + JSON.stringify(row).length + 1, 0) / r.rows.length) : 0;
  if (bytes) console.log(`One recorded line would be about ${bytes} bytes.`);
}

// ---------------------------------------------------------------------------
// Recording loop
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = TEST_URL ? "test" : readToken();
  if (TEST_URL || CLOCK_OFFSET_MS) console.log("TEST MODE: fake endpoint and/or shifted clock. This is not a real recording.");
  const { keyToSymbol, source } = await instrumentKeys(args.symbolList, nowMs());
  const url = `${QUOTE_URL}?instrument_key=${encodeURIComponent([...keyToSymbol.keys()].join(","))}`;
  console.log(`${keyToSymbol.size} symbols (${source}): ${[...keyToSymbol.values()].join(", ")}`);

  if (args.once) return once(url, token, keyToSymbol);

  const intervalMs = Math.round(args.interval * 1000);
  const stats = { requests: 0, okRequests: 0, failed: 0, lines: 0, samples: 0, lastLatency: 0, lastOk: 0, lastSymbolsOk: 0, rateLimited: 0 };
  let stopping = false;
  const summary = () => `${stats.samples} snapshots, ${stats.lines} lines written, ${stats.requests} requests (${stats.failed} failed, ${stats.rateLimited} rate-limited)`;
  process.on("SIGINT", () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log(`\nStopped by Ctrl+C. ${summary()}. Run the same command to continue; it appends.`);
    process.exit(0);
  });

  // Wait for the market.
  let now = nowMs();
  const closedNow = !isWeekday(now) || istSecond(now) < OPEN_S || istSecond(now) >= args.untilS;
  if (closedNow) {
    const open = nextOpen(now);
    const sameDay = istDay(open) === istDay(now);
    console.log(`Market is closed — will start at 09:15 IST${sameDay ? "" : ` on ${istDate(open).toUTCString().slice(0, 3)} ${istDay(open)}`} (now ${istClock(now)} IST). Leave this window open, or press Ctrl+C.`);
    while (nowMs() < open) await sleep(Math.min(open - nowMs(), 60_000)); // short naps survive a sleeping laptop
  }

  now = nowMs();
  const day = istDay(now);
  const dayMidnight = Math.floor((now + IST_OFFSET_MS) / 86_400_000) * 86_400_000 - IST_OFFSET_MS;
  const endAt = dayMidnight + args.untilS * 1000;
  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${day}.jsonl`);
  console.log(`Recording every ${args.interval} s until ${args.until} IST into ${path.relative(ROOT, file)} (appending). Ctrl+C stops it safely.`);

  const startedAt = nowMs();
  let lastHeartbeat = startedAt;
  let lastTwoSidedAt = startedAt;
  let consecutiveFailures = 0;
  let nextAt = startedAt;

  while (nowMs() < endAt) {
    await sleep(nextAt - nowMs());
    if (nowMs() >= endAt) break;

    stats.requests++;
    const r = await snapshot(url, token, keyToSymbol, Math.max(5000, Math.min(10_000, intervalMs * 3)));
    let pauseMs = 0;
    if (r.ok) {
      consecutiveFailures = 0;
      stats.okRequests++;
      stats.lastLatency = r.latency;
      const good = r.rows.filter(twoSided);
      stats.lastSymbolsOk = good.length;
      if (good.length > 0) {
        // One synchronous append per snapshot: nothing is buffered, so Ctrl+C never loses or tears a line.
        appendFileSync(file, good.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
        stats.lines += good.length;
        stats.samples++;
        stats.lastOk = nowMs();
        lastTwoSidedAt = stats.lastOk;
      } else if (nowMs() - lastTwoSidedAt > HOLIDAY_AFTER_MS) {
        console.log(`${istClock(nowMs())} No stock has shown a live two-sided order book for 15 minutes. Exchange holiday? Stopping. ${summary()}.`);
        return;
      }
    } else {
      stats.failed++;
      consecutiveFailures++;
      if (r.status === 429) {
        stats.rateLimited++;
        pauseMs = r.retryAfterS * 1000;
        console.log(`${istClock(nowMs())} Upstox says slow down (HTTP 429). Pausing ${r.retryAfterS} s as told, then continuing.`);
      } else if (r.status === 401 || r.status === 403) {
        console.log(`${istClock(nowMs())} Upstox rejected the access token (HTTP ${r.status}: ${r.message}). Fix UPSTOX_ACCESS_TOKEN in .env.local and start again. ${summary()}.`);
        process.exit(1);
      } else {
        // Anything else (network blip, 5xx): back off 3 s, 6 s, 12 s ... up to a minute. Never a tight retry loop.
        pauseMs = Math.min(60_000, intervalMs * 2 ** Math.min(consecutiveFailures - 1, 6));
        if (consecutiveFailures <= 3 || consecutiveFailures % 20 === 0) {
          console.log(`${istClock(nowMs())} Snapshot failed: ${r.status ? `HTTP ${r.status} ` : ""}${r.message}. Trying again in ${Math.round(pauseMs / 1000)} s.`);
        }
      }
    }

    const t = nowMs();
    if (t - lastHeartbeat >= 60_000) {
      lastHeartbeat = t;
      console.log(
        `${istClock(t)} ${stats.samples} snapshots, ${stats.lines} lines written | symbols OK ${stats.lastSymbolsOk}/${keyToSymbol.size} | last latency ${stats.lastLatency} ms | failed requests ${stats.failed}`,
      );
    }
    // Next slot on the fixed grid; slots missed while a request was slow or paused are skipped, never bunched.
    const earliest = t + pauseMs;
    nextAt += Math.max(1, Math.ceil((earliest - nextAt) / intervalMs)) * intervalMs;
  }
  console.log(`${istClock(nowMs())} Reached ${args.until} IST. Done for today: ${summary()}. File: ${path.relative(ROOT, file)}`);
}

main().catch((e) => {
  console.error(`Recorder stopped on an unexpected error: ${e?.message ?? e}`);
  process.exit(1);
});
