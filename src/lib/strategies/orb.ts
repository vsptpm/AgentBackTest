import type { Strategy } from "@/lib/types";
import { istDay, istMinutes, longStopTarget, num, SESSION_OPEN_MIN, shortStopTarget, str } from "./helpers";

/**
 * Opening Range Breakout. Ported from the trader-entry / trader-exit skills:
 * - Range = first N minutes of the session.
 * - Enter on the first bar that CLOSES beyond the range (long above high, short below low).
 * - Stop at range midpoint (default) or opposite side of range. Target = R multiple.
 * - One trade per day. Engine square-off handles the close.
 */
export function createOrb(): Strategy {
  // Per-day state. Keyed by IST day so re-runs on the same candle array reset naturally.
  let dayKey = "";
  let orHigh = -Infinity;
  let orLow = Infinity;
  let orDone = false;
  let tradedToday = false;

  return {
    id: "orb",
    name: "Opening Range Breakout",
    description:
      "First N minutes set the range. Enter on first close beyond it. Stop at range midpoint (trader-exit default) or range edge. One trade per day.",
    intervals: ["15m", "5m"],
    warmup: 5,
    params: [
      { key: "orMinutes", label: "Range minutes", type: "number", default: 15, min: 5, max: 60, step: 5, grid: [15, 30] },
      { key: "stopMode", label: "Stop at", type: "select", default: "midpoint", options: ["midpoint", "range"], grid: ["midpoint", "range"] },
      { key: "rr", label: "Target R", type: "number", default: 2, min: 0.5, max: 5, step: 0.5, grid: [1, 1.5, 2, 3] },
      { key: "lastEntryMin", label: "No entries after (min from open)", type: "number", default: 180, min: 30, max: 360, step: 15, grid: [120, 180] },
      { key: "minRangePct", label: "Min range % of price", type: "number", default: 0.2, min: 0, max: 3, step: 0.1, grid: [0, 0.2, 0.4] },
    ],
    onBar(ctx) {
      const c = ctx.candles[ctx.index];
      const day = istDay(c.time);
      if (day !== dayKey) {
        dayKey = day;
        orHigh = -Infinity;
        orLow = Infinity;
        orDone = false;
        tradedToday = false;
      }
      const minsFromOpen = istMinutes(c.time) - SESSION_OPEN_MIN;
      const orMin = num(ctx.params, "orMinutes", 15);

      // Bar timestamp is bar start. Bar belongs to the range if it starts before orMin.
      if (minsFromOpen < orMin) {
        orHigh = Math.max(orHigh, c.high);
        orLow = Math.min(orLow, c.low);
        return null;
      }
      if (!orDone) {
        orDone = Number.isFinite(orHigh) && Number.isFinite(orLow);
        if (!orDone) return null;
      }
      if (ctx.position || tradedToday) return null;
      if (minsFromOpen > num(ctx.params, "lastEntryMin", 180)) return null;

      const range = orHigh - orLow;
      if (range <= 0) return null;
      if ((range / c.close) * 100 < num(ctx.params, "minRangePct", 0.2)) return null;

      const mid = (orHigh + orLow) / 2;
      const rr = num(ctx.params, "rr", 2);
      const stopMode = str(ctx.params, "stopMode", "midpoint");

      if (c.close > orHigh) {
        tradedToday = true;
        const stop = stopMode === "midpoint" ? mid : orLow;
        return { action: "enter", side: "long", ...longStopTarget(c.close, stop, rr), reason: `ORB long > ${orHigh.toFixed(2)}` };
      }
      if (c.close < orLow) {
        tradedToday = true;
        const stop = stopMode === "midpoint" ? mid : orHigh;
        return { action: "enter", side: "short", ...shortStopTarget(c.close, stop, rr), reason: `ORB short < ${orLow.toFixed(2)}` };
      }
      return null;
    },
  };
}
