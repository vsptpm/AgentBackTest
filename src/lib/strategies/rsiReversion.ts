import type { Strategy } from "@/lib/types";
import { atr, rsi, sma } from "@/lib/indicators";
import { closes, longStopTarget, memoByCandles, num, shortStopTarget } from "./helpers";

export function createRsiReversion(): Strategy {
  const ind = memoByCandles((candles, params) => {
    const c = closes(candles);
    const trendPeriod = num(params, "trendSma", 200);
    return {
      rsi: rsi(c, num(params, "period", 14)),
      // 0 means "no trend filter"; sma() rejects period 0, so return an all-NaN series instead.
      trend: trendPeriod > 0 ? sma(c, trendPeriod) : c.map(() => NaN),
      atr: atr(candles, 14),
    };
  });

  return {
    id: "rsi-reversion",
    name: "RSI Mean Reversion",
    description:
      "Buy when RSI drops below oversold (optionally only above the trend SMA), exit when RSI recovers past the exit level. Short mirrored. ATR stop.",
    intervals: ["1d", "15m", "5m"],
    warmup: 210,
    params: [
      { key: "period", label: "RSI period", type: "number", default: 14, min: 2, max: 30, step: 1, grid: [2, 5, 14] },
      { key: "oversold", label: "Oversold", type: "number", default: 30, min: 5, max: 45, step: 1, grid: [20, 25, 30] },
      { key: "overbought", label: "Overbought", type: "number", default: 70, min: 55, max: 95, step: 1, grid: [70, 75, 80] },
      { key: "exitLevel", label: "Exit RSI (long)", type: "number", default: 55, min: 40, max: 80, step: 1, grid: [50, 55, 60] },
      { key: "trendSma", label: "Trend SMA (0 = off)", type: "number", default: 200, min: 0, max: 300, step: 10, grid: [0, 200] },
      { key: "atrMult", label: "Stop = ATR ×", type: "number", default: 2, min: 0.5, max: 5, step: 0.5, grid: [2, 3] },
    ],
    onBar(ctx) {
      const { rsi: r, trend, atr: a } = ind(ctx);
      const i = ctx.index;
      const c = ctx.candles[i].close;
      const p = ctx.params;
      if (!Number.isFinite(r[i])) return null;
      const useTrend = num(p, "trendSma", 200) > 0;
      const aboveTrend = !useTrend || (Number.isFinite(trend[i]) && c > trend[i]);
      const belowTrend = !useTrend || (Number.isFinite(trend[i]) && c < trend[i]);
      const risk = a[i] * num(p, "atrMult", 2);
      if (!Number.isFinite(risk) || risk <= 0) return null;
      const exitLvl = num(p, "exitLevel", 55);

      if (ctx.position?.side === "long" && r[i] > exitLvl) return { action: "exit", side: "long", reason: `RSI ${r[i].toFixed(0)} > ${exitLvl}` };
      if (ctx.position?.side === "short" && r[i] < 100 - exitLvl) return { action: "exit", side: "short", reason: `RSI ${r[i].toFixed(0)} < ${100 - exitLvl}` };
      if (ctx.position) return null;

      if (r[i] < num(p, "oversold", 30) && aboveTrend) {
        // Target far away; this is an indicator-exit strategy, target acts as a sanity cap.
        return { action: "enter", side: "long", ...longStopTarget(c, c - risk, 4), reason: `RSI ${r[i].toFixed(0)} oversold` };
      }
      if (r[i] > num(p, "overbought", 70) && belowTrend) {
        return { action: "enter", side: "short", ...shortStopTarget(c, c + risk, 4), reason: `RSI ${r[i].toFixed(0)} overbought` };
      }
      return null;
    },
  };
}
