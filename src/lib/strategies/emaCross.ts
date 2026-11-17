import type { Strategy } from "@/lib/types";
import { atr, crossover, crossunder, ema } from "@/lib/indicators";
import { closes, longStopTarget, memoByCandles, num, shortStopTarget } from "./helpers";

export function createEmaCross(): Strategy {
  const ind = memoByCandles((candles, params) => {
    const c = closes(candles);
    return {
      fast: ema(c, num(params, "fast", 9)),
      slow: ema(c, num(params, "slow", 21)),
      atr: atr(candles, num(params, "atrPeriod", 14)),
    };
  });

  return {
    id: "ema-cross",
    name: "EMA Crossover",
    description:
      "Long when fast EMA crosses above slow EMA, short on cross below. ATR-based stop, fixed R target. Exit on opposite cross.",
    intervals: ["1d", "15m", "5m"],
    warmup: 60,
    params: [
      { key: "fast", label: "Fast EMA", type: "number", default: 9, min: 3, max: 50, step: 1, grid: [5, 9, 13, 21] },
      { key: "slow", label: "Slow EMA", type: "number", default: 21, min: 10, max: 200, step: 1, grid: [21, 34, 50, 100] },
      { key: "atrPeriod", label: "ATR period", type: "number", default: 14, min: 5, max: 50, step: 1, grid: [14] },
      { key: "atrMult", label: "Stop = ATR ×", type: "number", default: 2, min: 0.5, max: 5, step: 0.5, grid: [1.5, 2, 3] },
      { key: "rr", label: "Target R", type: "number", default: 2, min: 0.5, max: 5, step: 0.5, grid: [1.5, 2, 3] },
    ],
    onBar(ctx) {
      const { fast, slow, atr: a } = ind(ctx);
      const i = ctx.index;
      if (num(ctx.params, "fast", 9) >= num(ctx.params, "slow", 21)) return null;
      const c = ctx.candles[i].close;
      const risk = a[i] * num(ctx.params, "atrMult", 2);
      if (!Number.isFinite(risk) || risk <= 0) return null;
      const rr = num(ctx.params, "rr", 2);

      if (crossover(fast, slow, i)) {
        if (ctx.position?.side === "short") return { action: "exit", side: "short", reason: "EMA cross up" };
        if (!ctx.position) return { action: "enter", side: "long", ...longStopTarget(c, c - risk, rr), reason: "EMA cross up" };
      }
      if (crossunder(fast, slow, i)) {
        if (ctx.position?.side === "long") return { action: "exit", side: "long", reason: "EMA cross down" };
        if (!ctx.position) return { action: "enter", side: "short", ...shortStopTarget(c, c + risk, rr), reason: "EMA cross down" };
      }
      return null;
    },
  };
}
