import type { Strategy } from "@/lib/types";
import { atr, bollinger, rsi } from "@/lib/indicators";
import { closes, memoByCandles, num } from "./helpers";

export function createBollingerReversion(): Strategy {
  const ind = memoByCandles((candles, params) => {
    const c = closes(candles);
    return {
      bb: bollinger(c, num(params, "period", 20), num(params, "mult", 2)),
      rsi: rsi(c, 14),
      atr: atr(candles, 14),
    };
  });

  return {
    id: "bb-reversion",
    name: "Bollinger Reversion",
    description:
      "Long when close drops below the lower band and closes back inside it, target the middle band, stop ATR beyond the band. Short mirrored. Optional RSI confirmation.",
    intervals: ["1d", "15m", "5m"],
    warmup: 40,
    params: [
      { key: "period", label: "Period", type: "number", default: 20, min: 10, max: 50, step: 1, grid: [20] },
      { key: "mult", label: "Std dev ×", type: "number", default: 2, min: 1, max: 3.5, step: 0.25, grid: [2, 2.5] },
      { key: "atrMult", label: "Stop = ATR × beyond band", type: "number", default: 1, min: 0.25, max: 3, step: 0.25, grid: [0.5, 1, 1.5] },
      { key: "rsiFilter", label: "RSI confirm (0 = off)", type: "number", default: 0, min: 0, max: 40, step: 5, grid: [0, 30] },
    ],
    onBar(ctx) {
      const { bb, rsi: r, atr: a } = ind(ctx);
      const i = ctx.index;
      if (i < 1 || !Number.isFinite(bb.lower[i]) || !Number.isFinite(bb.lower[i - 1])) return null;
      const cur = ctx.candles[i];
      const prevClose = ctx.candles[i - 1].close;
      const risk = a[i] * num(ctx.params, "atrMult", 1);
      if (!Number.isFinite(risk) || risk <= 0) return null;
      const rsiF = num(ctx.params, "rsiFilter", 0);

      if (ctx.position?.side === "long" && cur.close >= bb.mid[i]) return { action: "exit", side: "long", reason: "Hit mid band" };
      if (ctx.position?.side === "short" && cur.close <= bb.mid[i]) return { action: "exit", side: "short", reason: "Hit mid band" };
      if (ctx.position) return null;

      // Re-entry into the band after a close outside it.
      const reenterLow = prevClose < bb.lower[i - 1] && cur.close > bb.lower[i];
      const reenterHigh = prevClose > bb.upper[i - 1] && cur.close < bb.upper[i];

      if (reenterLow && (rsiF === 0 || r[i] < rsiF + 10)) {
        return { action: "enter", side: "long", stop: bb.lower[i] - risk, target: bb.mid[i], reason: "Re-entered from below lower band" };
      }
      if (reenterHigh && (rsiF === 0 || r[i] > 90 - rsiF)) {
        return { action: "enter", side: "short", stop: bb.upper[i] + risk, target: bb.mid[i], reason: "Re-entered from above upper band" };
      }
      return null;
    },
  };
}
