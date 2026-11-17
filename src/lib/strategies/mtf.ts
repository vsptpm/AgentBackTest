import type { Candle, Overlay, Params, Strategy } from "@/lib/types";
import { atr, ema, highest, lowest, sma } from "@/lib/indicators";
import { closes, istDay, istMinutes, longStopTarget, memoByCandles, num, SESSION_OPEN_MIN, shortStopTarget, str } from "./helpers";
import { resample, type HtfInterval } from "./resample";

/**
 * Multi-timeframe trend + lower-timeframe entry.
 *
 * Direction (HTF, e.g. 1h): last CLOSED HTF bar's close vs its EMA, and EMA slope over `slopeBars`.
 *   above & rising → longs only; below & falling → shorts only; otherwise flat.
 * Entry (LTF, e.g. 5m), in HTF direction only:
 *   breakout: close beyond the highest high / lowest low of the previous `lookback` LTF bars (the resistance / support).
 *   pullback: price touches the LTF EMA, then closes beyond the prior bar's high/low.
 * Confirmation of a breakout:
 *   none   – enter on the break bar.
 *   close  – break bar must close at least `confirmAtr` × ATR beyond the level (no wick-only breaks).
 *   retest – after the break, wait up to `retestBars` for price to come back to the level and close beyond it again.
 *   volume – break bar volume ≥ `volMult` × 20-bar average volume (stocks only; indices have no volume).
 * Stop: swing (lowest low / highest high of `lookback`) or ATR multiple. Target = R multiple.
 */
export function createMtfTrend(): Strategy {
  const ind = memoByCandles((candles, params) => compute(candles, params));

  // Per-run state for the retest confirmation and daily limits.
  let lastCandles: Candle[] | null = null;
  let pending: { side: "long" | "short"; level: number; since: number } | null = null;
  let dayKey = "";
  let tradesToday = 0;

  return {
    id: "mtf-trend",
    name: "MTF Trend + LTF Entry",
    description:
      "Higher timeframe (1h/4h/1d, closed bars only) sets direction via EMA; lower timeframe takes breakout or pullback entries in that direction, with optional close/retest/volume confirmation.",
    intervals: ["5m", "15m"],
    warmup: 60,
    params: [
      { key: "htf", label: "Direction timeframe", type: "select", default: "1h", options: ["1h", "4h", "1d"], grid: ["1h", "4h"] },
      { key: "htfEma", label: "HTF EMA", type: "number", default: 10, min: 5, max: 100, step: 1, grid: [10, 20] },
      { key: "slopeBars", label: "EMA slope bars (0 = off)", type: "number", default: 3, min: 0, max: 10, step: 1, grid: [0, 3] },
      { key: "entry", label: "Entry", type: "select", default: "breakout", options: ["breakout", "pullback"], grid: ["breakout", "pullback"] },
      { key: "lookback", label: "Level lookback (LTF bars)", type: "number", default: 20, min: 5, max: 100, step: 1, grid: [12, 20, 36] },
      { key: "confirm", label: "Confirmation", type: "select", default: "volume", options: ["none", "close", "retest", "volume"], grid: ["none", "close", "retest", "volume"] },
      { key: "confirmAtr", label: "Close beyond level ≥ ATR ×", type: "number", default: 0.25, min: 0, max: 2, step: 0.05, grid: [0.25] },
      { key: "retestBars", label: "Retest window (bars)", type: "number", default: 6, min: 2, max: 30, step: 1, grid: [6] },
      { key: "volMult", label: "Volume ≥ avg ×", type: "number", default: 1.5, min: 1, max: 4, step: 0.1, grid: [1.5] },
      { key: "stopMode", label: "Stop", type: "select", default: "swing", options: ["swing", "atr"], grid: ["swing", "atr"] },
      { key: "atrMult", label: "ATR stop ×", type: "number", default: 1.5, min: 0.5, max: 4, step: 0.25, grid: [1.5] },
      { key: "rr", label: "Target R", type: "number", default: 2, min: 0.5, max: 5, step: 0.5, grid: [1.5, 2, 3] },
      { key: "maxTradesDay", label: "Max trades / day", type: "number", default: 2, min: 1, max: 6, step: 1, grid: [2] },
      { key: "lastEntryMin", label: "No entries after (min from open)", type: "number", default: 300, min: 60, max: 360, step: 15, grid: [300] },
    ],
    onBar(ctx) {
      if (ctx.candles !== lastCandles) {
        lastCandles = ctx.candles;
        pending = null;
        dayKey = "";
        tradesToday = 0;
      }
      const d = ind(ctx);
      const i = ctx.index;
      const c = ctx.candles[i];
      const p = ctx.params;
      const day = istDay(c.time);
      if (day !== dayKey) {
        dayKey = day;
        tradesToday = 0;
        pending = null;
      }
      if (ctx.position) return null;
      if (tradesToday >= num(p, "maxTradesDay", 2)) return null;
      if (istMinutes(c.time) - SESSION_OPEN_MIN > num(p, "lastEntryMin", 300)) {
        pending = null;
        return null;
      }

      const dir = d.direction[i];
      if (dir === 0) {
        pending = null;
        return null;
      }
      const a = d.atr[i];
      if (!Number.isFinite(a) || a <= 0) return null;
      const rr = num(p, "rr", 2);
      const confirm = str(p, "confirm", "close");
      const entryMode = str(p, "entry", "breakout");

      const stopFor = (side: "long" | "short"): number => {
        if (str(p, "stopMode", "swing") === "atr") return side === "long" ? c.close - a * num(p, "atrMult", 1.5) : c.close + a * num(p, "atrMult", 1.5);
        return side === "long" ? d.swingLow[i] : d.swingHigh[i];
      };
      const fire = (side: "long" | "short", why: string) => {
        const stop = stopFor(side);
        if (side === "long" && !(stop < c.close)) return null;
        if (side === "short" && !(stop > c.close)) return null;
        tradesToday++;
        pending = null;
        return side === "long"
          ? ({ action: "enter", side, ...longStopTarget(c.close, stop, rr), reason: why } as const)
          : ({ action: "enter", side, ...shortStopTarget(c.close, stop, rr), reason: why } as const);
      };

      // ---- Pullback entry ----
      if (entryMode === "pullback") {
        if (i < 1 || !Number.isFinite(d.ltfEma[i])) return null;
        const prev = ctx.candles[i - 1];
        if (dir === 1 && prev.low <= d.ltfEma[i - 1] && c.close > prev.high && c.close > d.ltfEma[i]) return fire("long", `Pullback to EMA, break of ${prev.high.toFixed(2)}`);
        if (dir === -1 && prev.high >= d.ltfEma[i - 1] && c.close < prev.low && c.close < d.ltfEma[i]) return fire("short", `Pullback to EMA, break of ${prev.low.toFixed(2)}`);
        return null;
      }

      // ---- Breakout entry ----
      const res = d.resistance[i]; // highest high of previous `lookback` bars (excludes current)
      const sup = d.support[i];
      if (!Number.isFinite(res) || !Number.isFinite(sup)) return null;

      // Retest state machine: a prior break set `pending`; wait for a pullback to the level and a re-close beyond it.
      if (pending) {
        if (pending.side !== (dir === 1 ? "long" : "short") || i - pending.since > num(p, "retestBars", 6)) {
          pending = null;
        } else if (pending.side === "long") {
          if (c.close < pending.level - a * 0.5) pending = null; // failed break
          else if (c.low <= pending.level && c.close > pending.level) return fire("long", `Retest hold of ${pending.level.toFixed(2)}`);
          return null;
        } else {
          if (c.close > pending.level + a * 0.5) pending = null;
          else if (c.high >= pending.level && c.close < pending.level) return fire("short", `Retest hold of ${pending.level.toFixed(2)}`);
          return null;
        }
      }

      const brokeUp = dir === 1 && c.close > res;
      const brokeDown = dir === -1 && c.close < sup;
      if (!brokeUp && !brokeDown) return null;
      const level = brokeUp ? res : sup;
      const side: "long" | "short" = brokeUp ? "long" : "short";

      switch (confirm) {
        case "none":
          return fire(side, `Break of ${level.toFixed(2)}`);
        case "close": {
          const beyond = brokeUp ? c.close - level : level - c.close;
          if (beyond >= a * num(p, "confirmAtr", 0.25)) return fire(side, `Confirmed close beyond ${level.toFixed(2)}`);
          return null;
        }
        case "volume": {
          const avg = d.volAvg[i];
          if (!Number.isFinite(avg) || avg <= 0) return fire(side, `Break of ${level.toFixed(2)} (no volume data)`);
          if (c.volume >= avg * num(p, "volMult", 1.5)) return fire(side, `Break of ${level.toFixed(2)} on ${(c.volume / avg).toFixed(1)}× volume`);
          return null;
        }
        case "retest":
          pending = { side, level, since: i };
          return null;
        default:
          return null;
      }
    },
    overlays(candles, params) {
      const d = compute(candles, params);
      const htfName = str(params, "htf", "1h");
      const pts = (arr: number[]) => candles.map((c, i) => ({ time: c.time, value: arr[i] })).filter((x) => Number.isFinite(x.value));
      const out: Overlay[] = [
        { name: `${htfName} EMA ${num(params, "htfEma", 20)} (closed bars)`, color: "#f59e0b", style: "step", points: pts(d.htfEmaOnLtf) },
      ];
      if (str(params, "entry", "breakout") === "pullback") {
        out.push({ name: "LTF EMA", color: "#60a5fa", style: "line", points: pts(d.ltfEma) });
      } else {
        out.push({ name: "Resistance (lookback high)", color: "#ef4444", style: "step", points: pts(d.resistance) });
        out.push({ name: "Support (lookback low)", color: "#22c55e", style: "step", points: pts(d.support) });
      }
      // Direction as a thin line at the candle low ±: easier read is a step series of 1/-1 — drawn as EMA colour already.
      return out;
    },
  };
}

function compute(candles: Candle[], params: Params) {
  const htf = str(params, "htf", "1h") as HtfInterval;
  const rs = resample(candles, htf);
  const htfCloses = rs.htf.map((c) => c.close);
  const htfEma = ema(htfCloses, num(params, "htfEma", 20));
  const slopeBars = num(params, "slopeBars", 3);

  // Map the last CLOSED HTF bar's EMA/direction onto every LTF bar.
  const htfEmaOnLtf = new Array<number>(candles.length).fill(NaN);
  const direction = new Array<1 | -1 | 0>(candles.length).fill(0);
  for (let i = 0; i < candles.length; i++) {
    const j = rs.completedAt[i];
    if (j < 0 || !Number.isFinite(htfEma[j])) continue;
    htfEmaOnLtf[i] = htfEma[j];
    const above = htfCloses[j] > htfEma[j];
    const below = htfCloses[j] < htfEma[j];
    let rising = true;
    let falling = true;
    if (slopeBars > 0) {
      const k = j - slopeBars;
      if (k < 0 || !Number.isFinite(htfEma[k])) continue;
      rising = htfEma[j] > htfEma[k];
      falling = htfEma[j] < htfEma[k];
    }
    if (above && rising) direction[i] = 1;
    else if (below && falling) direction[i] = -1;
  }

  const lb = num(params, "lookback", 20);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  // Levels from the PREVIOUS `lb` bars so the current bar can break them.
  const hh = highest(highs, lb);
  const ll = lowest(lows, lb);
  const resistance = candles.map((_, i) => (i >= 1 ? hh[i - 1] : NaN));
  const support = candles.map((_, i) => (i >= 1 ? ll[i - 1] : NaN));

  return {
    direction,
    htfEmaOnLtf,
    resistance,
    support,
    swingLow: ll,
    swingHigh: hh,
    atr: atr(candles, 14),
    ltfEma: ema(closes(candles), 20),
    volAvg: sma(candles.map((c) => c.volume), 20),
  };
}
