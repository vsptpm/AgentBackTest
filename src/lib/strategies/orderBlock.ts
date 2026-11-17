import type { Candle, Strategy } from "@/lib/types";
import { atr, highest, lowest } from "@/lib/indicators";
import { longStopTarget, memoByCandles, num, shortStopTarget } from "./helpers";

interface Zone {
  side: "bull" | "bear";
  top: number;
  bottom: number;
  createdAt: number;
  touched: boolean;
}

/**
 * Order Block retest (Smart Money Concepts).
 * Impulse = `impulseBars` consecutive same-colour candles whose combined range exceeds `atrMult` × ATR
 * AND whose last close breaks the prior `lookback`-bar high (bull) / low (bear).
 * Order block = the last opposite-colour candle before the impulse. Zone = that candle's body (or wick range).
 * Entry: price returns into the zone and then closes back out in the impulse direction.
 * Stop beyond the zone, target R multiple. Zone invalidated on a close through its far side or after `maxAgeBars`.
 */
export function createOrderBlock(): Strategy {
  const ind = memoByCandles((candles, params) => {
    const lb = num(params, "lookback", 20);
    return {
      atr: atr(candles, 14),
      hh: highest(candles.map((c) => c.high), lb),
      ll: lowest(candles.map((c) => c.low), lb),
    };
  });

  let zones: Zone[] = [];
  let lastCandles: Candle[] | null = null;

  function detectImpulse(candles: Candle[], i: number, n: number, atrNow: number, mult: number, hh: number[], ll: number[]): "bull" | "bear" | null {
    if (i - n < 1) return null;
    let bull = true;
    let bear = true;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      const c = candles[k];
      if (c.close <= c.open) bull = false;
      if (c.close >= c.open) bear = false;
      hi = Math.max(hi, c.high);
      lo = Math.min(lo, c.low);
    }
    if (!bull && !bear) return null;
    if (hi - lo < atrNow * mult) return null;
    const startIdx = i - n; // bar before impulse
    // Break of structure: impulse close beyond prior lookback extreme measured before the impulse began.
    if (bull && Number.isFinite(hh[startIdx]) && candles[i].close > hh[startIdx]) return "bull";
    if (bear && Number.isFinite(ll[startIdx]) && candles[i].close < ll[startIdx]) return "bear";
    return null;
  }

  return {
    id: "order-block",
    name: "Order Block Retest",
    description:
      "Marks the last opposite candle before an impulsive break of structure (the 'order block'), then trades the first retest of that zone in the impulse direction. Stop beyond the zone.",
    intervals: ["1d", "15m", "5m"],
    warmup: 40,
    params: [
      { key: "impulseBars", label: "Impulse candles", type: "number", default: 3, min: 2, max: 6, step: 1, grid: [2, 3] },
      { key: "atrMult", label: "Impulse size ≥ ATR ×", type: "number", default: 2, min: 1, max: 5, step: 0.5, grid: [1.5, 2, 3] },
      { key: "lookback", label: "Structure lookback", type: "number", default: 20, min: 5, max: 60, step: 5, grid: [10, 20] },
      { key: "zoneMode", label: "Zone", type: "select", default: "body", options: ["body", "wick"], grid: ["body", "wick"] },
      { key: "rr", label: "Target R", type: "number", default: 2, min: 0.5, max: 5, step: 0.5, grid: [1.5, 2, 3] },
      { key: "maxAgeBars", label: "Zone expiry (bars)", type: "number", default: 60, min: 10, max: 300, step: 10, grid: [40, 80] },
      { key: "stopBufferAtr", label: "Stop buffer ATR ×", type: "number", default: 0.25, min: 0, max: 1, step: 0.05, grid: [0.1, 0.25] },
    ],
    onBar(ctx) {
      if (ctx.candles !== lastCandles) {
        lastCandles = ctx.candles;
        zones = [];
      }
      const { atr: a, hh, ll } = ind(ctx);
      const i = ctx.index;
      const c = ctx.candles[i];
      const p = ctx.params;
      const atrNow = a[i];
      if (!Number.isFinite(atrNow) || atrNow <= 0) return null;
      const n = num(p, "impulseBars", 3);
      const maxAge = num(p, "maxAgeBars", 60);
      const wick = (p.zoneMode ?? "body") === "wick";

      // 1. Age out / invalidate zones.
      zones = zones.filter((z) => {
        if (i - z.createdAt > maxAge) return false;
        if (z.side === "bull" && c.close < z.bottom) return false;
        if (z.side === "bear" && c.close > z.top) return false;
        return true;
      });

      // 2. Detect a new impulse ending at this bar; record the OB before it.
      const imp = detectImpulse(ctx.candles, i, n, atrNow, num(p, "atrMult", 2), hh, ll);
      if (imp) {
        // Walk back from the impulse start to find the last opposite-colour candle.
        for (let k = i - n; k >= Math.max(0, i - n - 5); k--) {
          const ob = ctx.candles[k];
          const isOpp = imp === "bull" ? ob.close < ob.open : ob.close > ob.open;
          if (!isOpp) continue;
          const top = wick ? ob.high : Math.max(ob.open, ob.close);
          const bottom = wick ? ob.low : Math.min(ob.open, ob.close);
          if (top > bottom) zones.push({ side: imp, top, bottom, createdAt: i, touched: false });
          break;
        }
      }

      if (ctx.position) return null;
      const rr = num(p, "rr", 2);
      const buf = atrNow * num(p, "stopBufferAtr", 0.25);

      // 3. Retest: price enters the zone (touch), then closes back out in the impulse direction.
      for (const z of zones) {
        if (z.createdAt === i) continue;
        if (z.side === "bull") {
          if (c.low <= z.top) z.touched = true;
          if (z.touched && c.close > z.top && c.low >= z.bottom - buf) {
            z.touched = false;
            zones = zones.filter((x) => x !== z);
            return { action: "enter", side: "long", ...longStopTarget(c.close, z.bottom - buf, rr), reason: `OB retest ${z.bottom.toFixed(1)}–${z.top.toFixed(1)}` };
          }
        } else {
          if (c.high >= z.bottom) z.touched = true;
          if (z.touched && c.close < z.bottom && c.high <= z.top + buf) {
            z.touched = false;
            zones = zones.filter((x) => x !== z);
            return { action: "enter", side: "short", ...shortStopTarget(c.close, z.top + buf, rr), reason: `OB retest ${z.bottom.toFixed(1)}–${z.top.toFixed(1)}` };
          }
        }
      }
      return null;
    },
  };
}
