import type { Strategy } from "@/lib/types";
import { adx, supertrend } from "@/lib/indicators";
import { longStopTarget, memoByCandles, num, shortStopTarget } from "./helpers";

export function createSupertrend(): Strategy {
  const ind = memoByCandles((candles, params) => ({
    st: supertrend(candles, num(params, "period", 10), num(params, "mult", 3)),
    adx: adx(candles, 14),
  }));

  return {
    id: "supertrend",
    name: "Supertrend Flip",
    description:
      "Enter when Supertrend flips direction, stop at the Supertrend line, exit on the next flip. Optional ADX filter to skip chop.",
    intervals: ["1d", "15m", "5m"],
    warmup: 40,
    params: [
      { key: "period", label: "ATR period", type: "number", default: 10, min: 5, max: 30, step: 1, grid: [7, 10, 14] },
      { key: "mult", label: "Multiplier", type: "number", default: 3, min: 1, max: 6, step: 0.5, grid: [2, 3, 4] },
      { key: "minAdx", label: "Min ADX (0 = off)", type: "number", default: 0, min: 0, max: 50, step: 5, grid: [0, 20, 25] },
      { key: "rr", label: "Target R (0 = none)", type: "number", default: 0, min: 0, max: 6, step: 0.5, grid: [0, 2, 3] },
    ],
    onBar(ctx) {
      const { st, adx: a } = ind(ctx);
      const i = ctx.index;
      const dir = st.direction[i];
      const prev = st.direction[i - 1];
      if (dir === 0 || prev === 0 || dir === prev) return null;
      const minAdx = num(ctx.params, "minAdx", 0);
      const adxOk = minAdx === 0 || (Number.isFinite(a.adx[i]) && a.adx[i] >= minAdx);
      const c = ctx.candles[i].close;
      const line = st.line[i];
      const rr = num(ctx.params, "rr", 0);
      const far = 1e9;

      if (dir === 1) {
        if (ctx.position?.side === "short") return { action: "exit", side: "short", reason: "ST flip up" };
        if (!ctx.position && adxOk && line < c) {
          const t = rr > 0 ? longStopTarget(c, line, rr) : { stop: line, target: far };
          return { action: "enter", side: "long", ...t, reason: "ST flip up" };
        }
      } else {
        if (ctx.position?.side === "long") return { action: "exit", side: "long", reason: "ST flip down" };
        if (!ctx.position && adxOk && line > c) {
          const t = rr > 0 ? shortStopTarget(c, line, rr) : { stop: line, target: 0 };
          return { action: "enter", side: "short", ...t, reason: "ST flip down" };
        }
      }
      return null;
    },
  };
}
