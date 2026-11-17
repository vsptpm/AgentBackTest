import type { Candle, Params, StrategyContext } from "@/lib/types";

/**
 * Strategies compute indicators once per candle array and reuse across bars.
 * The engine passes the same `candles` reference every bar, so identity check is enough.
 */
export function memoByCandles<T>(compute: (candles: Candle[], params: Params) => T) {
  let lastCandles: Candle[] | null = null;
  let lastParamsKey = "";
  let value: T | null = null;
  return (ctx: StrategyContext): T => {
    const key = JSON.stringify(ctx.params);
    if (ctx.candles !== lastCandles || key !== lastParamsKey || value === null) {
      lastCandles = ctx.candles;
      lastParamsKey = key;
      value = compute(ctx.candles, ctx.params);
    }
    return value;
  };
}

export function num(params: Params, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function str(params: Params, key: string, fallback: string): string {
  const v = params[key];
  return typeof v === "string" ? v : fallback;
}

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

/** Minutes since midnight IST for a candle time. */
export function istMinutes(ms: number): number {
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** YYYY-MM-DD in IST. Duplicated here to avoid importing the data layer into strategies. */
export function istDay(ms: number): string {
  return new Date(ms + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export const SESSION_OPEN_MIN = 9 * 60 + 15;

export function longStopTarget(entry: number, stop: number, rr: number) {
  const risk = entry - stop;
  return { stop, target: entry + risk * rr };
}

export function shortStopTarget(entry: number, stop: number, rr: number) {
  const risk = stop - entry;
  return { stop, target: entry - risk * rr };
}
