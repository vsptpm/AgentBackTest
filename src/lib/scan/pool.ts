// Server side of "stocks in play": choose the pool of liquid stocks, fetch their candles and rank.
// The ranking is remembered for a few minutes so a scan every minute does not re-fetch the whole pool.

import type { Candle } from "@/lib/types";
import { SYMBOLS } from "@/lib/data/symbols";
import { istDateKey, istMinutesOfDay } from "@/lib/data/yahoo";
import { fetchLiveCandles } from "@/lib/data/live";
import { fetchUpstoxQuotes, getUpstoxToken, upstoxAvgDailyVolume, upstoxLiquidStocks } from "@/lib/data/upstox";
import { istDayKey } from "@/lib/backtest";
import { isMarketOpen } from "./index";
import { measureFromQuote, rankInPlay, type InPlay } from "./inplay";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 15:30 IST: by then a whole day's volume has traded. */
const FULL_SESSION_MINUTE = 15 * 60 + 30;

export interface InPlayRanking {
  ranked: InPlay[];
  /** How many stocks were looked at. */
  poolSize: number;
  rankedAt: number;
  /** "liquid" = ~200 stocks with futures (needs Upstox); "catalogue" = the app's built-in list. */
  pool: "liquid" | "catalogue";
  warnings: string[];
}

let cache: { key: string; value: InPlayRanking } | null = null;

/** Same date window as the scanner, so both share one cached download per stock. */
export function scanWindow(now: number): { from: string; to: string } {
  return { from: istDateKey(now - 20 * DAY_MS), to: istDateKey(now) };
}

/** The candle-based ranking only ever covers the built-in list: a few dozen stocks is all it can afford. */
async function choosePool(now: number): Promise<{ symbols: string[]; pool: InPlayRanking["pool"]; live: boolean }> {
  const catalogue = SYMBOLS.filter((s) => s.kind === "stock").map((s) => s.symbol);
  return { symbols: catalogue, pool: "catalogue", live: !!(await getUpstoxToken(now)) };
}

/**
 * With Upstox: one quote request prices the whole pool, so the ranking is live and cheap.
 * Volume is judged against each stock's average daily volume, which loads in the background on
 * the first run of the day; until it arrives a stock ranks on its price move alone.
 */
async function rankFromQuotes(symbols: string[], token: string, now: number): Promise<InPlay[]> {
  const [quotes, avg] = await Promise.all([fetchUpstoxQuotes(symbols, token, now), upstoxAvgDailyVolume(symbols, token, now)]);
  // Outside market hours a quote holds the whole last session, so judge its volume against a full day.
  const minute = isMarketOpen(now) ? istMinutesOfDay(now) : FULL_SESSION_MINUTE;
  const out: InPlay[] = [];
  for (const [symbol, q] of Object.entries(quotes)) {
    const m = measureFromQuote(symbol, q, avg[symbol], minute);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function getInPlayRanking(interval: "5m" | "15m", now: number = Date.now()): Promise<InPlayRanking> {
  const token = await getUpstoxToken(now);
  if (token) {
    const key = `quotes|${istDateKey(now)}`;
    if (cache?.key === key && now - cache.value.rankedAt < 60_000) return cache.value;
    try {
      const liquid = await upstoxLiquidStocks(now);
      const ranked = await rankFromQuotes(liquid, token, now);
      if (ranked.length > 0) {
        const value: InPlayRanking = { ranked, poolSize: liquid.length, rankedAt: now, pool: "liquid", warnings: [] };
        cache = { key, value };
        return value;
      }
    } catch {
      /* quotes unavailable: rank the built-in list from candles below */
    }
  }

  const { symbols, pool, live } = await choosePool(now);
  // A big pool costs many requests; refresh it less often.
  const ttl = symbols.length > 60 ? 10 * 60_000 : 5 * 60_000;
  const key = `${interval}|${pool}|${istDateKey(now)}`;
  if (cache?.key === key && now - cache.value.rankedAt < ttl) return cache.value;

  const { from, to } = scanWindow(now);
  const candlesBy: Record<string, Candle[]> = {};
  let failed = 0;
  // Small batches: both Yahoo and Upstox punish bursts.
  const batch = 4;
  void live;
  for (let i = 0; i < symbols.length; i += batch) {
    const slice = symbols.slice(i, i + batch);
    const results = await Promise.allSettled(slice.map((symbol) => fetchLiveCandles({ symbol, interval, from, to }, now, ttl)));
    results.forEach((r, k) => {
      if (r.status === "fulfilled") candlesBy[slice[k]] = r.value.candles;
      else failed++;
    });
  }

  // Market closed (evening, weekend, holiday): rank the last session instead, as a list for next time.
  let ranked = rankInPlay(candlesBy, istDateKey(now));
  if (ranked.length === 0 && !isMarketOpen(now)) {
    let lastDay = "";
    for (const candles of Object.values(candlesBy)) {
      const day = candles.length > 0 ? istDayKey(candles[candles.length - 1].time) : "";
      if (day > lastDay) lastDay = day;
    }
    if (lastDay) ranked = rankInPlay(candlesBy, lastDay);
  }

  const value: InPlayRanking = {
    ranked,
    poolSize: symbols.length,
    rankedAt: now,
    pool,
    warnings: failed > 0 ? [`Could not get prices for ${failed} of ${symbols.length} stocks while ranking`] : [],
  };
  // Do not remember an empty ranking (before the open, or a data outage): try again next time.
  if (value.ranked.length > 0) cache = { key, value };
  return value;
}
