// Prices for the live screens (Today's signals, paper trades): real-time Upstox candles when the
// user is logged in to Upstox, otherwise delayed Yahoo candles. Server-side only.

import type { Candle } from "@/lib/types";
import { fetchCandles } from "@/lib/data/yahoo";
import { fetchUpstoxCandles, getUpstoxToken, upstoxLoginConfigured } from "@/lib/data/upstox";

export type PriceSource = "upstox" | "yahoo";

export interface LiveCandles {
  candles: Candle[];
  warnings: string[];
  source: PriceSource;
}

export interface UpstoxStatus {
  /** API key and secret are present, so the "Connect Upstox" button can work. */
  configured: boolean;
  /** A valid access token for today exists. */
  connected: boolean;
}

export async function upstoxStatus(now: number = Date.now()): Promise<UpstoxStatus> {
  return { configured: upstoxLoginConfigured(), connected: !!(await getUpstoxToken(now)) };
}

/** Never throws because of Upstox: any Upstox failure falls back to Yahoo with a warning. */
export async function fetchLiveCandles(
  req: { symbol: string; interval: "5m" | "15m"; from: string; to: string },
  now: number = Date.now(),
  /** How old a cached delayed (Yahoo) answer may be. Default one minute. */
  maxAgeMs: number = 60_000,
): Promise<LiveCandles> {
  const token = await getUpstoxToken(now);
  let fallbackNote: string | null = null;
  if (token) {
    try {
      const candles = await fetchUpstoxCandles(req, token, now);
      if (candles.length > 0) return { candles, warnings: [], source: "upstox" };
      fallbackNote = `${req.symbol}: Upstox returned no candles, using delayed prices`;
    } catch (e) {
      fallbackNote = `${req.symbol}: Upstox failed (${(e as Error).message}), using delayed prices`;
    }
  }
  const y = await fetchCandles(req, { maxAgeMs });
  return { candles: y.candles, warnings: fallbackNote ? [fallbackNote, ...y.warnings] : y.warnings, source: "yahoo" };
}
