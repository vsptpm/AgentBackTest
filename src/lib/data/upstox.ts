// Upstox market data: login token, instrument lookup and live intraday candles.
// Server-side only. READ-ONLY: nothing in this file can place, change or cancel an order.
//
// Config (.env.local, never sent to the browser):
//   UPSTOX_API_KEY, UPSTOX_API_SECRET   from the Upstox developer console (My Apps)
//   UPSTOX_REDIRECT_URI                 optional; must equal the redirect URL registered for the app.
//                                       Default http://localhost:3111/api/upstox/callback
//   UPSTOX_ACCESS_TOKEN                 optional; paste a token instead of using the login button
//
// An Upstox access token is valid until 03:30 IST the next morning, so login is once per trading day.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { Candle } from "@/lib/types";
import { IST_OFFSET_MS } from "@/lib/types";
import { filterSession, istDateKey, normalizeCandles } from "@/lib/data/yahoo";

const API = "https://api.upstox.com";
const INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const DAY_MS = 24 * 60 * 60 * 1000;

const dir = () => path.join(process.cwd(), ".cache");
const tokenFile = () => path.join(dir(), "upstox-token.json");

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export function upstoxLoginConfigured(): boolean {
  return !!process.env.UPSTOX_API_KEY?.trim() && !!process.env.UPSTOX_API_SECRET?.trim();
}

export function upstoxRedirectUri(): string {
  return process.env.UPSTOX_REDIRECT_URI?.trim() || "http://localhost:3111/api/upstox/callback";
}

/** A token obtained at `obtainedAt` stops working at the next 03:30 IST. */
export function tokenExpiry(obtainedAt: number): number {
  const ist = obtainedAt + IST_OFFSET_MS;
  const cutoffToday = Math.floor(ist / DAY_MS) * DAY_MS + 3.5 * 60 * 60 * 1000;
  return (ist < cutoffToday ? cutoffToday : cutoffToday + DAY_MS) - IST_OFFSET_MS;
}

/** Current access token, or null when not logged in / expired. */
export async function getUpstoxToken(now: number = Date.now()): Promise<string | null> {
  try {
    const saved = JSON.parse(await readFile(tokenFile(), "utf8")) as { accessToken?: string; obtainedAt?: number };
    if (saved.accessToken && saved.obtainedAt && now < tokenExpiry(saved.obtainedAt)) return saved.accessToken;
  } catch {
    /* no saved token */
  }
  return process.env.UPSTOX_ACCESS_TOKEN?.trim() || null;
}

export function upstoxLoginUrl(state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: process.env.UPSTOX_API_KEY?.trim() ?? "",
    redirect_uri: upstoxRedirectUri(),
    state,
  });
  return `${API}/v2/login/authorization/dialog?${q}`;
}

/** Swap the one-time login code for an access token and remember it until it expires. */
export async function completeUpstoxLogin(code: string, now: number = Date.now()): Promise<void> {
  const res = await fetch(`${API}/v2/login/authorization/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: process.env.UPSTOX_API_KEY?.trim() ?? "",
      client_secret: process.env.UPSTOX_API_SECRET?.trim() ?? "",
      redirect_uri: upstoxRedirectUri(),
      grant_type: "authorization_code",
    }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as { access_token?: string; errors?: { message?: string }[] } | null;
  if (!res.ok || !body?.access_token) {
    throw new Error(body?.errors?.[0]?.message ?? `Upstox login failed (${res.status})`);
  }
  await mkdir(dir(), { recursive: true });
  await writeFile(tokenFile(), JSON.stringify({ accessToken: body.access_token, obtainedAt: now }), "utf8");
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/** Yahoo index symbol → Upstox index name (matched case-insensitively against the instrument list). */
const INDEX_NAMES: Record<string, string> = { "^NSEI": "NIFTY 50", "^NSEBANK": "NIFTY BANK", "^CNXIT": "NIFTY IT" };

interface InstrumentMap {
  /** NSE trading symbol → instrument key, e.g. RELIANCE → NSE_EQ|INE002A01018 */
  equity: Record<string, string>;
  /** Upper-cased index name → instrument key, e.g. NIFTY 50 → NSE_INDEX|Nifty 50 */
  index: Record<string, string>;
  /** Trading symbols of stocks that have futures: the exchange's own list of liquid names. */
  fno: string[];
}

let instrumentCache: { day: string; map: InstrumentMap } | null = null;

/** Downloaded once per IST day (Upstox refreshes the list around 6 AM). No login needed. */
async function instruments(now: number): Promise<InstrumentMap> {
  const day = istDateKey(now);
  if (instrumentCache?.day === day) return instrumentCache.map;
  const file = path.join(dir(), `upstox-nse-${day}.json`);
  try {
    const map = JSON.parse(await readFile(file, "utf8")) as InstrumentMap;
    if (map.equity && map.index && map.fno) {
      instrumentCache = { day, map };
      return map;
    }
  } catch {
    /* not cached yet */
  }
  const res = await fetch(INSTRUMENTS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Upstox instrument list responded ${res.status}`);
  const rows = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8")) as {
    segment?: string;
    instrument_type?: string;
    trading_symbol?: string;
    name?: string;
    instrument_key?: string;
    underlying_symbol?: string;
    underlying_type?: string;
  }[];
  const map: InstrumentMap = { equity: {}, index: {}, fno: [] };
  const fno = new Set<string>();
  for (const r of rows) {
    if (!r.instrument_key) continue;
    if (r.segment === "NSE_EQ" && r.instrument_type === "EQ" && r.trading_symbol) map.equity[r.trading_symbol] = r.instrument_key;
    else if (r.segment === "NSE_FO" && r.instrument_type === "FUT" && r.underlying_type === "EQUITY" && r.underlying_symbol) fno.add(r.underlying_symbol);
    else if (r.segment === "NSE_INDEX") {
      if (r.trading_symbol) map.index[r.trading_symbol.toUpperCase()] = r.instrument_key;
      if (r.name) map.index[r.name.toUpperCase()] ??= r.instrument_key;
    }
  }
  map.fno = [...fno].filter((s) => map.equity[s]).sort();
  instrumentCache = { day, map };
  try {
    await mkdir(dir(), { recursive: true });
    await writeFile(file, JSON.stringify(map), "utf8");
  } catch {
    /* cache failure is non-fatal */
  }
  return map;
}

/** About 200 liquid NSE stocks (those with futures), as Yahoo-style symbols like RELIANCE.NS. */
export async function upstoxLiquidStocks(now: number = Date.now()): Promise<string[]> {
  return (await instruments(now)).fno.map((s) => `${s}.NS`);
}

/** Upstox instrument key for a Yahoo symbol (RELIANCE.NS, ^NSEI), or null if Upstox does not list it. */
export async function upstoxInstrumentKey(symbol: string, now: number = Date.now()): Promise<string | null> {
  const map = await instruments(now);
  if (symbol.startsWith("^")) {
    const name = INDEX_NAMES[symbol];
    return (name && map.index[name]) || null;
  }
  return map.equity[symbol.replace(/\.NS$/, "")] ?? null;
}

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

type RawCandle = [string, number, number, number, number, number, ...unknown[]];

/** Upstox candle rows ([ISO time with +05:30, o, h, l, c, volume, oi], any order) → Candle[]. */
export function parseUpstoxCandles(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) return [];
  const out: Candle[] = [];
  for (const r of rows as RawCandle[]) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const time = Date.parse(r[0]);
    const [, open, high, low, close] = r;
    if (![time, open, high, low, close].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    out.push({ time, open, high, low, close, volume: typeof r[5] === "number" ? r[5] : 0 });
  }
  return out;
}

/**
 * The candle endpoints sit behind a rate limiter far stricter than the documented 50 a second:
 * a burst of a few hundred requests got this app locked out for five minutes (HTTP 429, error
 * 1015). So candle requests go out one at a time, four a second, and after any 429 the app stops
 * calling Upstox until the lock-out it was told about has passed. Even four a second, sustained for a
 * minute, was locked out, so the pace is two a second and background work goes slower still.
 */
const REQUEST_GAP_MS = 500;
let nextSlot = 0;
let blockedUntil = 0;

async function waitTurn(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + REQUEST_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** GET an Upstox data URL. Throws on any failure, including while locked out. */
async function upstoxGet<T>(url: string, token: string, throttled: boolean): Promise<T> {
  if (Date.now() < blockedUntil) throw new Error("Upstox is rate limiting this app; waiting it out");
  if (throttled) await waitTurn();
  if (Date.now() < blockedUntil) throw new Error("Upstox is rate limiting this app; waiting it out");
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after"));
    blockedUntil = Date.now() + (Number.isFinite(wait) && wait > 0 ? wait : 60) * 1000;
    throw new Error("Upstox is rate limiting this app; waiting it out");
  }
  const body = (await res.json().catch(() => null)) as { status?: string; data?: T; errors?: { message?: string }[] } | null;
  if (!res.ok || body?.status !== "success" || body.data == null) {
    throw new Error(body?.errors?.[0]?.message ?? `Upstox responded ${res.status}`);
  }
  return body.data;
}

async function getCandles(url: string, token: string): Promise<Candle[]> {
  return parseUpstoxCandles((await upstoxGet<{ candles?: unknown }>(url, token, true)).candles);
}

/** Milliseconds left on a rate-limit lock-out Upstox imposed on this app; 0 when free to call. */
export function upstoxBlockedMs(now: number = Date.now()): number {
  return Math.max(0, blockedUntil - now);
}

/** Past 5m / 15m candles for `from`..`to` (IST dates, at most one month). One throttled request. */
export function fetchUpstoxMinuteRange(instrumentKey: string, minutes: 5 | 15, from: string, to: string, token: string): Promise<Candle[]> {
  return getCandles(`${API}/v3/historical-candle/${encodeURIComponent(instrumentKey)}/minutes/${minutes}/${to}/${from}`, token);
}

/** Today's 5m / 15m candles, including the bar still forming. One throttled request. */
export function fetchUpstoxMinuteToday(instrumentKey: string, minutes: 5 | 15, token: string): Promise<Candle[]> {
  return getCandles(`${API}/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/${minutes}`, token);
}

// ---------------------------------------------------------------------------
// Quotes: one request prices hundreds of stocks
// ---------------------------------------------------------------------------

export interface UpstoxQuote {
  last: number;
  /** Previous day's close. */
  prevClose: number;
  /** Shares traded so far today. */
  volume: number;
}

/** Latest price, previous close and today's volume for many stocks at once (Yahoo-style symbols in and out). */
export async function fetchUpstoxQuotes(symbols: string[], token: string, now: number = Date.now()): Promise<Record<string, UpstoxQuote>> {
  const bySymbol: Record<string, UpstoxQuote> = {};
  const keyToSymbol = new Map<string, string>();
  for (const s of symbols) {
    const k = await upstoxInstrumentKey(s, now);
    if (k) keyToSymbol.set(k, s);
  }
  const keys = [...keyToSymbol.keys()];
  for (let i = 0; i < keys.length; i += 250) {
    const q = encodeURIComponent(keys.slice(i, i + 250).join(","));
    const data = await upstoxGet<Record<string, { last_price?: number; instrument_token?: string; volume?: number; cp?: number }>>(
      `${API}/v3/market-quote/ltp?instrument_key=${q}`,
      token,
      false,
    );
    for (const row of Object.values(data)) {
      const symbol = row.instrument_token ? keyToSymbol.get(row.instrument_token) : undefined;
      if (!symbol || !(Number(row.last_price) > 0) || !(Number(row.cp) > 0)) continue;
      bySymbol[symbol] = { last: Number(row.last_price), prevClose: Number(row.cp), volume: Number(row.volume) || 0 };
    }
  }
  return bySymbol;
}

// ---------------------------------------------------------------------------
// Average daily volume: fetched slowly in the background, once per day
// ---------------------------------------------------------------------------

let avgVol: { day: string; map: Record<string, number>; loading: boolean } | null = null;
const avgVolFile = (day: string) => path.join(dir(), `upstox-avgvol-${day}.json`);

/**
 * Average daily volume over the last ~10 sessions, per symbol. Returns what is known so far and
 * never waits: missing symbols are fetched in the background (one request each, throttled), so a
 * cold start fills in over about a minute and is then kept on disk for the day.
 */
export async function upstoxAvgDailyVolume(symbols: string[], token: string, now: number = Date.now()): Promise<Record<string, number>> {
  const day = istDateKey(now);
  if (avgVol?.day !== day) {
    let map: Record<string, number> = {};
    try {
      map = JSON.parse(await readFile(avgVolFile(day), "utf8")) as Record<string, number>;
    } catch {
      /* nothing saved for today yet */
    }
    avgVol = { day, map, loading: false };
  }
  const state = avgVol;
  const missing = symbols.filter((s) => !(s in state.map));
  if (missing.length > 0 && !state.loading) {
    state.loading = true;
    void (async () => {
      const to = istDateKey(now - DAY_MS);
      const from = istDateKey(now - 16 * DAY_MS);
      try {
        for (const symbol of missing) {
          const key = await upstoxInstrumentKey(symbol, now);
          if (!key) {
            state.map[symbol] = 0;
            continue;
          }
          // Background work must never crowd out the live scan: one request every ~1.5 s.
          await new Promise((r) => setTimeout(r, 1000));
          const days = await getCandles(`${API}/v3/historical-candle/${encodeURIComponent(key)}/days/1/${to}/${from}`, token);
          const vols = days.map((c) => c.volume).filter((v) => v > 0);
          state.map[symbol] = vols.length >= 3 ? vols.reduce((a, v) => a + v, 0) / vols.length : 0;
        }
      } catch {
        /* locked out or offline: keep what we have, the next ranking tries the rest */
      } finally {
        state.loading = false;
        try {
          await mkdir(dir(), { recursive: true });
          await writeFile(avgVolFile(day), JSON.stringify(state.map), "utf8");
        } catch {
          /* cache failure is non-fatal */
        }
      }
    })();
  }
  return state.map;
}

/** Past days never change, so keep them for the rest of the IST day. Key: instrument|minutes|from|day. */
const historyCache = new Map<string, Candle[]>();

/**
 * Real-time 5m / 15m candles from Upstox for `from`..`to` (IST dates, at most ~1 month, the API's
 * limit for these intervals). Today's bars come from the intraday endpoint and include the bar
 * still forming; callers that must not act on a partial bar already drop it by time.
 */
export async function fetchUpstoxCandles(
  req: { symbol: string; interval: "5m" | "15m"; from: string; to: string },
  token: string,
  now: number = Date.now(),
): Promise<Candle[]> {
  const key = await upstoxInstrumentKey(req.symbol, now);
  if (!key) throw new Error(`${req.symbol} is not in the Upstox NSE list`);
  const minutes = req.interval === "5m" ? 5 : 15;
  const enc = encodeURIComponent(key);
  const today = istDateKey(now);

  let history: Candle[] = [];
  if (req.from < today) {
    if (Date.parse(req.to) - Date.parse(req.from) > 31 * DAY_MS) throw new Error("Upstox serves at most one month of 5m/15m candles per request");
    const yesterday = istDateKey(now - DAY_MS);
    const histTo = req.to < today ? req.to : yesterday;
    const cacheKey = `${key}|${minutes}|${req.from}|${histTo}|${today}`;
    const hit = historyCache.get(cacheKey);
    if (hit) history = hit;
    else {
      history = await getCandles(`${API}/v3/historical-candle/${enc}/minutes/${minutes}/${histTo}/${req.from}`, token);
      if (historyCache.size > 500) historyCache.clear();
      historyCache.set(cacheKey, history);
    }
  }

  const live = req.to >= today ? await getCandles(`${API}/v3/historical-candle/intraday/${enc}/minutes/${minutes}`, token) : [];
  return normalizeCandles(filterSession([...history, ...live], req.interval));
}
