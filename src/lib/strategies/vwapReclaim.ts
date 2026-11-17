import type { Strategy } from "@/lib/types";
import { lowest, highest, vwap } from "@/lib/indicators";
import { istDay, istMinutes, longStopTarget, memoByCandles, num, SESSION_OPEN_MIN, shortStopTarget } from "./helpers";

/**
 * VWAP reclaim (intraday). Price spends `belowBars` bars below VWAP then closes back above it:
 * long, stop at the lowest low of those bars, target R multiple. Short mirrored.
 */
export function createVwapReclaim(): Strategy {
  const ind = memoByCandles((candles, params) => {
    const n = num(params, "belowBars", 3);
    return {
      vwap: vwap(candles),
      lo: lowest(candles.map((c) => c.low), n + 1),
      hi: highest(candles.map((c) => c.high), n + 1),
    };
  });
  let dayKey = "";
  let tradesToday = 0;

  return {
    id: "vwap-reclaim",
    name: "VWAP Reclaim",
    description:
      "After N bars below VWAP, first close back above it goes long with stop at the swing low. Short mirrored. Intraday, stocks only (indices have no volume, so no VWAP).",
    intervals: ["15m", "5m"],
    warmup: 10,
    params: [
      { key: "belowBars", label: "Bars beyond VWAP before reclaim", type: "number", default: 3, min: 1, max: 12, step: 1, grid: [2, 3, 5] },
      { key: "rr", label: "Target R", type: "number", default: 2, min: 0.5, max: 5, step: 0.5, grid: [1.5, 2, 3] },
      { key: "maxTradesDay", label: "Max trades / day", type: "number", default: 2, min: 1, max: 6, step: 1, grid: [1, 2] },
      { key: "lastEntryMin", label: "No entries after (min from open)", type: "number", default: 240, min: 30, max: 360, step: 15, grid: [180, 240] },
    ],
    onBar(ctx) {
      const { vwap: v, lo, hi } = ind(ctx);
      const i = ctx.index;
      const c = ctx.candles[i];
      const day = istDay(c.time);
      if (day !== dayKey) {
        dayKey = day;
        tradesToday = 0;
      }
      if (ctx.position) return null;
      if (tradesToday >= num(ctx.params, "maxTradesDay", 2)) return null;
      if (istMinutes(c.time) - SESSION_OPEN_MIN > num(ctx.params, "lastEntryMin", 240)) return null;
      const n = num(ctx.params, "belowBars", 3);
      if (i < n + 1 || !Number.isFinite(v[i])) return null;

      // Previous n bars must all be on one side of VWAP and in the same IST day.
      let allBelow = true;
      let allAbove = true;
      for (let k = i - n; k < i; k++) {
        if (istDay(ctx.candles[k].time) !== day) return null;
        if (!(ctx.candles[k].close < v[k])) allBelow = false;
        if (!(ctx.candles[k].close > v[k])) allAbove = false;
      }
      const rr = num(ctx.params, "rr", 2);
      if (allBelow && c.close > v[i]) {
        const stop = lo[i];
        if (!(stop < c.close)) return null;
        tradesToday++;
        return { action: "enter", side: "long", ...longStopTarget(c.close, stop, rr), reason: "VWAP reclaim" };
      }
      if (allAbove && c.close < v[i]) {
        const stop = hi[i];
        if (!(stop > c.close)) return null;
        tradesToday++;
        return { action: "enter", side: "short", ...shortStopTarget(c.close, stop, rr), reason: "VWAP loss" };
      }
      return null;
    },
  };
}
