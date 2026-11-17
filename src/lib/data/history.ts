// Long 5m / 15m history from Upstox (back to January 2022), kept on disk one calendar month per
// file so each month is downloaded once. Server-side only. READ-ONLY market data.
//
// Upstox locks this app out for minutes after a burst of candle requests, so downloads here are
// strictly one at a time, at most one every 1.2 seconds, across every caller in the process, and
// a lock-out stops the download at once instead of retrying.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle, CandleRequest } from "@/lib/types";
import { fetchCandles, filterSession, istDateKey, normalizeCandles, sanitizeSymbol } from "@/lib/data/yahoo";
import { fetchUpstoxMinuteRange, fetchUpstoxMinuteToday, getUpstoxToken, upstoxBlockedMs, upstoxInstrumentKey } from "@/lib/data/upstox";

/** Upstox keeps 1–15 minute candles from this date. */
export const HISTORY_FROM = "2022-01-01";
/** Longest range served in one call. */
export const HISTORY_MAX_YEARS = 3;
/** Minimum time between the starts of two history downloads. */
const HISTORY_GAP_MS = 1200;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface MonthChunk {
  /** YYYY-MM */
  month: string;
  /** First day of the month, YYYY-MM-DD. */
  from: string;
  /** Last day of the month, YYYY-MM-DD. */
  to: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Whole calendar months touched by `from`..`to` (inclusive ISO dates), oldest first. */
export function monthChunks(from: string, to: string): MonthChunk[] {
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to) || from > to) return [];
  const out: MonthChunk[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push({ month: `${y}-${pad(m)}`, from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay)}` });
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/**
 * Fit a requested range to what Upstox can serve: nothing after today, nothing before January
 * 2022, at most three years. `today` is the current IST date.
 */
export function clampHistoryRange(from: string, to: string, today: string): { from: string; to: string; warnings: string[] } {
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) throw new Error("Dates must be YYYY-MM-DD");
  const warnings: string[] = [];
  if (to > today) to = today;
  if (from > to) throw new Error(`"from" (${from}) is after "to" (${to})`);
  if (from < HISTORY_FROM) {
    from = HISTORY_FROM;
    warnings.push(`Upstox 5m/15m history starts in January 2022; range starts at ${from}`);
    if (from > to) throw new Error(`Upstox has no 5m/15m history before ${HISTORY_FROM}`);
  }
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - HISTORY_MAX_YEARS);
  const earliest = d.toISOString().slice(0, 10);
  if (from < earliest) {
    from = earliest;
    warnings.push(`Range limited to the last ${HISTORY_MAX_YEARS} years; it starts at ${from}`);
  }
  return { from, to, warnings };
}

/**
 * Can a saved month be used as is? A copy written after the month ended is complete and kept for
 * good. A copy written during the month is missing later days, so it is good only for the IST day
 * it was written on.
 */
export function chunkIsFresh(chunk: MonthChunk, fetchedAt: number, now: number): boolean {
  const savedOn = istDateKey(fetchedAt);
  return savedOn > chunk.to || savedOn === istDateKey(now);
}

/** File name for one saved month: {instrument key}_{minutes}_{YYYY-MM}.json */
export function chunkFileName(instrumentKey: string, minutes: number, month: string): string {
  return `${sanitizeSymbol(instrumentKey)}_${minutes}_${month}.json`;
}

/** Thrown when Upstox has locked this app out; the message tells the user how long to wait. */
export class UpstoxRateLimitError extends Error {
  constructor(waitMs: number) {
    const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
    super(`Upstox is rate limiting; try again in ${minutes} minute${minutes === 1 ? "" : "s"}`);
    this.name = "UpstoxRateLimitError";
  }
}

// ---------------------------------------------------------------------------
// Disk store and pacing
// ---------------------------------------------------------------------------

type Row = [number, number, number, number, number, number];
interface SavedChunk {
  fetchedAt: number;
  /** [time ms, open, high, low, close, volume], oldest first. */
  rows: Row[];
}

const histDir = () => path.join(process.cwd(), ".cache", "upstox-hist");

async function readChunk(name: string): Promise<{ fetchedAt: number; candles: Candle[] } | null> {
  try {
    const saved = JSON.parse(await readFile(path.join(histDir(), name), "utf8")) as SavedChunk;
    if (typeof saved?.fetchedAt !== "number" || !Array.isArray(saved.rows)) return null;
    return {
      fetchedAt: saved.fetchedAt,
      candles: saved.rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume })),
    };
  } catch {
    return null;
  }
}

async function writeChunk(name: string, fetchedAt: number, candles: Candle[]): Promise<void> {
  try {
    await mkdir(histDir(), { recursive: true });
    const saved: SavedChunk = { fetchedAt, rows: candles.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]) };
    await writeFile(path.join(histDir(), name), JSON.stringify(saved), "utf8");
  } catch {
    /* cache failure is non-fatal */
  }
}

/** Shared by every route in the process (and kept across dev hot reloads). */
interface HistoryState {
  /** Tail of the one-at-a-time queue. */
  tail: Promise<unknown>;
  /** When the last download started. */
  lastAt: number;
  /** Today's bars per instrument|minutes, kept briefly so repeat runs do not call Upstox again. */
  today: Map<string, { at: number; candles: Candle[] }>;
}
const g = globalThis as typeof globalThis & { __upstoxHistory?: HistoryState };
const state: HistoryState = (g.__upstoxHistory ??= { tail: Promise.resolve(), lastAt: 0, today: new Map() });

/** Run `fn` after every earlier history job has finished: never two downloads at once. */
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = state.tail.then(fn, fn);
  state.tail = run.catch(() => undefined);
  return run;
}

async function pace(): Promise<void> {
  const wait = state.lastAt + HISTORY_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  state.lastAt = Date.now();
}

/** Everything that touches the network, the disk or the clock; replaced by fakes in tests. */
export interface HistoryDeps {
  instrumentKey(symbol: string, now: number): Promise<string | null>;
  fetchRange(instrumentKey: string, minutes: 5 | 15, from: string, to: string, token: string): Promise<Candle[]>;
  fetchToday(instrumentKey: string, minutes: 5 | 15, token: string): Promise<Candle[]>;
  readChunk(name: string): Promise<{ fetchedAt: number; candles: Candle[] } | null>;
  writeChunk(name: string, fetchedAt: number, candles: Candle[]): Promise<void>;
  /** Waits until the next download may start. */
  pace(): Promise<void>;
  /** Milliseconds left on an Upstox lock-out, 0 when free. */
  blockedMs(): number;
  today: Map<string, { at: number; candles: Candle[] }>;
}

const realDeps: HistoryDeps = {
  instrumentKey: upstoxInstrumentKey,
  fetchRange: fetchUpstoxMinuteRange,
  fetchToday: fetchUpstoxMinuteToday,
  readChunk,
  writeChunk,
  pace,
  blockedMs: () => upstoxBlockedMs(),
  today: state.today,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UpstoxHistory {
  candles: Candle[];
  /** Requests actually sent to Upstox for this call. */
  requests: number;
  /** Months served from disk without a request. */
  cachedChunks: number;
  warnings: string[];
}

/**
 * 5m / 15m candles from Upstox for any range since January 2022 (at most three years), oldest
 * first, session hours only, no bar that is still forming. Months already on disk cost nothing;
 * each missing month is one request, sent one at a time. Throws UpstoxRateLimitError as soon as
 * Upstox locks the app out; months downloaded before that stay on disk.
 */
export async function fetchUpstoxHistory(
  req: { symbol: string; interval: "5m" | "15m"; from: string; to: string },
  token: string,
  now: number = Date.now(),
  deps: HistoryDeps = realDeps,
): Promise<UpstoxHistory> {
  const today = istDateKey(now);
  const yesterday = istDateKey(now - DAY_MS);
  const range = clampHistoryRange(req.from, req.to, today);
  const key = await deps.instrumentKey(req.symbol, now);
  if (!key) throw new Error(`${req.symbol} is not in the Upstox NSE list`);
  const minutes = req.interval === "5m" ? 5 : 15;

  let requests = 0;
  let cachedChunks = 0;

  /** One paced request; a lock-out before or because of it becomes a clear error. */
  const download = async (fn: () => Promise<Candle[]>): Promise<Candle[]> => {
    if (deps.blockedMs() > 0) throw new UpstoxRateLimitError(deps.blockedMs());
    await deps.pace();
    requests++;
    try {
      return await fn();
    } catch (e) {
      if (deps.blockedMs() > 0) throw new UpstoxRateLimitError(deps.blockedMs());
      throw e;
    }
  };

  const all: Candle[] = [];
  for (const chunk of monthChunks(range.from, range.to)) {
    // The history endpoint is asked for finished days only; today comes from the intraday endpoint.
    const lastDay = chunk.to < yesterday ? chunk.to : yesterday;
    if (lastDay < chunk.from) continue;
    const name = chunkFileName(key, minutes, chunk.month);
    let saved = await deps.readChunk(name);
    if (saved && chunkIsFresh(chunk, saved.fetchedAt, now)) {
      cachedChunks++;
    } else {
      saved = await oneAtATime(async () => {
        // Another run may have saved this month while we were waiting in the queue.
        const again = await deps.readChunk(name);
        if (again && chunkIsFresh(chunk, again.fetchedAt, now)) {
          cachedChunks++;
          return again;
        }
        const rows = await download(() => deps.fetchRange(key, minutes, chunk.from, lastDay, token));
        const candles = normalizeCandles(filterSession(rows, req.interval));
        await deps.writeChunk(name, now, candles);
        return { fetchedAt: now, candles };
      });
    }
    for (const c of saved.candles) all.push(c);
  }

  if (range.to >= today) {
    const cacheKey = `${key}|${minutes}`;
    const hit = deps.today.get(cacheKey);
    let live: Candle[];
    if (hit && now - hit.at >= 0 && now - hit.at < 60_000 && istDateKey(hit.at) === today) live = hit.candles;
    else {
      live = await oneAtATime(() => download(() => deps.fetchToday(key, minutes, token)));
      if (deps.today.size > 500) deps.today.clear();
      deps.today.set(cacheKey, { at: now, candles: live });
    }
    // A bar that has not finished yet must not feed a backtest.
    for (const c of live) if (c.time + minutes * 60_000 <= now) all.push(c);
  }

  const fromMs = Date.parse(`${range.from}T00:00:00+05:30`);
  const toMs = Date.parse(`${range.to}T00:00:00+05:30`) + DAY_MS;
  const candles = normalizeCandles(filterSession(all, req.interval)).filter((c) => c.time >= fromMs && c.time < toMs);
  return { candles, requests, cachedChunks, warnings: range.warnings };
}

export interface BestCandles {
  candles: Candle[];
  warnings: string[];
  source: "upstox" | "yahoo";
  /** Upstox requests sent for this call (0 when everything came from disk or from Yahoo). */
  upstoxRequests: number;
}

/**
 * The best candles available for a backtest. 5m / 15m with Upstox connected: Upstox history, any
 * range back to 2022. Otherwise, or when Upstox fails: Yahoo, which keeps about 60 days of 5m /
 * 15m data, with a warning saying so. Daily bars always come from Yahoo.
 */
export async function fetchBestCandles(req: CandleRequest, now: number = Date.now()): Promise<BestCandles> {
  if (req.interval === "1d") {
    const y = await fetchCandles(req);
    return { ...y, source: "yahoo", upstoxRequests: 0 };
  }
  const symbol = req.symbol.trim();
  const token = await getUpstoxToken(now);
  let why = "Upstox is not connected";
  let upstoxRequests = 0;
  if (token) {
    try {
      const h = await fetchUpstoxHistory({ symbol, interval: req.interval, from: req.from, to: req.to }, token, now);
      if (h.candles.length > 0) return { candles: h.candles, warnings: h.warnings, source: "upstox", upstoxRequests: h.requests };
      upstoxRequests = h.requests;
      why = `Upstox returned no candles for ${symbol}`;
    } catch (e) {
      why = (e as Error).message;
    }
  }
  const y = await fetchCandles({ ...req, symbol });
  return {
    candles: y.candles,
    warnings: [`Used delayed Yahoo prices, which go back only about 60 days: ${why}.`, ...y.warnings],
    source: "yahoo",
    upstoxRequests,
  };
}
