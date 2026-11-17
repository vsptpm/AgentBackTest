// Yahoo Finance chart API client with disk cache and IST helpers.
// Server-side only (uses node:fs). Pure helpers (toIST, istDateKey, filterSession)
// are safe to import anywhere.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle, CandleRequest, Interval } from "@/lib/types";
import { IST_OFFSET_MS } from "@/lib/types";

// ---------------------------------------------------------------------------
// IST helpers
// ---------------------------------------------------------------------------

/**
 * Returns a Date whose UTC getters (getUTCHours, getUTCDate, ...) yield IST
 * wall-clock values for the given epoch-ms instant. Do not use local getters
 * on the returned object; it is a shifted instant, not a timezone-aware Date.
 */
export function toIST(ms: number): Date {
  return new Date(ms + IST_OFFSET_MS);
}

/** YYYY-MM-DD of the IST calendar day containing `ms`. */
export function istDateKey(ms: number): string {
  const d = toIST(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Minutes since IST midnight for `ms`. */
export function istMinutesOfDay(ms: number): number {
  const d = toIST(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** HH:MM in IST. */
export function istTimeKey(ms: number): string {
  const d = toIST(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

const SESSION_OPEN_MIN = 9 * 60 + 15; // 09:15
const SESSION_CLOSE_MIN = 15 * 60 + 30; // 15:30

/**
 * For intraday intervals, drop bars whose IST bar-start time falls outside
 * 09:15–15:30 (inclusive on both ends; a 15:30 bar start occasionally appears
 * in Yahoo data as the closing print). Daily data is returned unchanged.
 */
export function filterSession(candles: Candle[], interval: Interval): Candle[] {
  if (interval === "1d") return candles;
  return candles.filter((c) => {
    const m = istMinutesOfDay(c.time);
    return m >= SESSION_OPEN_MIN && m <= SESSION_CLOSE_MIN;
  });
}

const INTERVAL_MINUTES: Record<Interval, number> = { "1d": 0, "15m": 15, "5m": 5 };

/**
 * Drop intraday bars whose IST time is not on the interval grid anchored at
 * 09:15. Yahoo stamps the still-forming live bar with the current clock time
 * (e.g. 13:55 on a 15m chart), so such bars are partial and must not feed a
 * backtest. Daily data is returned unchanged.
 */
export function dropOffGridBars(candles: Candle[], interval: Interval): Candle[] {
  const step = INTERVAL_MINUTES[interval];
  if (!step) return candles;
  return candles.filter((c) => (istMinutesOfDay(c.time) - SESSION_OPEN_MIN) % step === 0);
}

/** Sort ascending by time and drop duplicate timestamps (keeps last seen). */
export function normalizeCandles(candles: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// Range handling
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Yahoo retention for intraday intervals, in days. */
const INTRADAY_LIMIT_DAYS: Record<Interval, number | null> = {
  "1d": null,
  "15m": 60,
  "5m": 60,
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDateUTC(s: string, label: string): number {
  if (!ISO_DATE_RE.test(s)) {
    throw new Error(`Invalid ${label} date "${s}"; expected YYYY-MM-DD`);
  }
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid ${label} date "${s}"`);
  return ms;
}

function isoDateFromUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Resolve the request range into unix seconds for Yahoo, treating `from` as
 * IST start-of-day and `to` as IST end-of-day. Clamps intraday ranges to
 * Yahoo's retention window and returns the effective ISO `from`.
 */
export function resolveRange(
  req: CandleRequest,
  now: number = Date.now(),
): { period1: number; period2: number; from: string; to: string; warnings: string[] } {
  const warnings: string[] = [];
  let fromUtcMidnight = parseIsoDateUTC(req.from, "from");
  const toUtcMidnight = parseIsoDateUTC(req.to, "to");
  if (fromUtcMidnight > toUtcMidnight) {
    throw new Error(`"from" (${req.from}) is after "to" (${req.to}) for ${req.symbol}`);
  }

  const limitDays = INTRADAY_LIMIT_DAYS[req.interval];
  if (limitDays != null) {
    // Leave a small margin below the hard limit so the request is accepted.
    const earliest = now - (limitDays - 1) * DAY_MS;
    const earliestMidnight = Math.floor(earliest / DAY_MS) * DAY_MS;
    if (fromUtcMidnight < earliestMidnight) {
      fromUtcMidnight = earliestMidnight;
      warnings.push(
        `Yahoo serves ${req.interval} data for ~${limitDays} days only; range clamped to ${isoDateFromUTC(fromUtcMidnight)}`,
      );
    }
  }

  // IST midnight = UTC midnight - 5.5h. End of IST day = next IST midnight - 1s.
  const period1 = Math.floor((fromUtcMidnight - IST_OFFSET_MS) / 1000);
  const period2 = Math.floor((toUtcMidnight - IST_OFFSET_MS + DAY_MS) / 1000) - 1;

  return {
    period1,
    period2,
    from: isoDateFromUTC(fromUtcMidnight),
    to: req.to,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Yahoo response parsing
// ---------------------------------------------------------------------------

interface YahooQuote {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  volume?: (number | null)[];
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: YahooQuote[] };
    }> | null;
    error?: { code?: string; description?: string } | null;
  };
}

/** Convert a Yahoo chart payload into candles (epoch ms, nulls skipped). */
export function parseYahooChart(json: unknown, symbol: string): Candle[] {
  const body = json as YahooChartResponse;
  const chart = body?.chart;
  if (!chart) throw new Error(`Yahoo returned an unexpected payload for ${symbol}`);
  if (chart.error) {
    const desc = chart.error.description ?? chart.error.code ?? "unknown error";
    throw new Error(`Yahoo error for ${symbol}: ${desc}`);
  }
  const result = chart.result?.[0];
  if (!result) throw new Error(`Yahoo returned no data for ${symbol}`);

  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const open = q.open ?? [];
  const high = q.high ?? [];
  const low = q.low ?? [];
  const close = q.close ?? [];
  const volume = q.volume ?? [];

  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = open[i];
    const h = high[i];
    const l = low[i];
    const c = close[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    out.push({
      time: ts[i] * 1000,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: volume[i] ?? 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function buildYahooUrl(symbol: string, interval: Interval, period1: number, period2: number): string {
  const encoded = encodeURIComponent(symbol); // handles ^ and & (M&M.NS)
  return (
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}` +
    `?period1=${period1}&period2=${period2}&interval=${interval}` +
    `&includePrePost=false&events=div%2Csplit`
  );
}

async function fetchYahooJson(url: string, symbol: string): Promise<unknown> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(1000);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json,text/plain,*/*",
        },
        cache: "no-store",
      });
    } catch (e) {
      lastErr = new Error(`Network error fetching ${symbol} from Yahoo: ${(e as Error).message}`);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Yahoo responded ${res.status} for ${symbol}`);
      continue;
    }
    if (!res.ok) {
      // 4xx other than 429: not retryable. Try to surface Yahoo's message.
      let detail = "";
      try {
        const j = (await res.json()) as YahooChartResponse;
        detail = j?.chart?.error?.description ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(
        `Yahoo responded ${res.status} for ${symbol}${detail ? `: ${detail}` : ""}. Check the symbol (e.g. RELIANCE.NS, ^NSEI).`,
      );
    }
    try {
      return await res.json();
    } catch (e) {
      throw new Error(`Yahoo returned non-JSON for ${symbol}: ${(e as Error).message}`);
    }
  }
  throw lastErr ?? new Error(`Failed to fetch ${symbol} from Yahoo`);
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  fetchedAt: number;
  candles: Candle[];
  warnings: string[];
}

const INTRADAY_CACHE_TTL_MS = 15 * 60 * 1000;

export function sanitizeSymbol(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9_-]/g, "_");
}

function cacheDir(): string {
  return path.join(process.cwd(), ".cache");
}

function cachePath(symbol: string, interval: Interval, from: string, to: string): string {
  return path.join(cacheDir(), `${sanitizeSymbol(symbol)}_${interval}_${from}_${to}.json`);
}

async function readCache(
  file: string,
  interval: Interval,
  now: number,
  rangeIncludesToday: boolean,
  maxAgeMs?: number,
): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(file, "utf8");
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry || !Array.isArray(entry.candles)) return null;
    // 1d ranges that end in the past never change; everything else expires in 15 min
    // (intraday always, and 1d when the range includes today's still-forming bar).
    const volatile = interval !== "1d" || rangeIncludesToday;
    if (volatile && now - entry.fetchedAt > INTRADAY_CACHE_TTL_MS) return null;
    // Caller-requested freshness (live scanner): intraday entries older than maxAgeMs are stale.
    if (maxAgeMs != null && interval !== "1d" && now - entry.fetchedAt > maxAgeMs) return null;
    return entry;
  } catch {
    return null;
  }
}

async function writeCache(file: string, entry: CacheEntry): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(file, JSON.stringify(entry), "utf8");
  } catch {
    // Cache failures are non-fatal.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch OHLCV candles for an NSE symbol from Yahoo Finance.
 * - Candle.time is epoch milliseconds.
 * - Intraday bars outside the 09:15–15:30 IST session are dropped.
 * - Intraday ranges older than ~60 days are clamped with a warning.
 * - Results are cached on disk under `.cache/` (1d forever, intraday 15 min).
 */
export async function fetchCandles(
  req: CandleRequest,
  opts?: { maxAgeMs?: number },
): Promise<{ candles: Candle[]; warnings: string[] }> {
  if (!req.symbol || !req.symbol.trim()) throw new Error("Symbol is required");
  const symbol = req.symbol.trim();
  const now = Date.now();
  const range = resolveRange({ ...req, symbol }, now);
  const warnings = [...range.warnings];

  const file = cachePath(symbol, req.interval, range.from, range.to);
  const cached = await readCache(file, req.interval, now, range.to >= istDateKey(now), opts?.maxAgeMs);
  if (cached) {
    return { candles: cached.candles, warnings: [...warnings, ...cached.warnings.filter((w) => !warnings.includes(w))] };
  }

  const url = buildYahooUrl(symbol, req.interval, range.period1, range.period2);
  const json = await fetchYahooJson(url, symbol);
  const parsed = parseYahooChart(json, symbol);
  const inSession = filterSession(parsed, req.interval);
  const onGrid = dropOffGridBars(inSession, req.interval);
  const candles = normalizeCandles(onGrid);

  const fetchWarnings: string[] = [];
  if (onGrid.length < inSession.length) {
    fetchWarnings.push(
      `Dropped ${inSession.length - onGrid.length} partial (still-forming) ${req.interval} bar(s) for ${symbol}`,
    );
  }
  if (candles.length === 0) {
    fetchWarnings.push(`Yahoo returned no ${req.interval} candles for ${symbol} between ${range.from} and ${range.to}`);
  }

  await writeCache(file, { fetchedAt: now, candles, warnings: fetchWarnings });
  return { candles, warnings: [...warnings, ...fetchWarnings] };
}
