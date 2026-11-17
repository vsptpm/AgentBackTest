import type { Candle, Interval, Overlay, Params, Side, Strategy } from "@/lib/types";
import { istDay, istMinutes, num, SESSION_OPEN_MIN } from "./helpers";

/** Prior sessions needed before a day can be traded (for both RVOL and the daily ATR). */
export const ORB_RVOL_MIN_SESSIONS = 5;
/** Daily ATR length, as in the paper. */
const ATR_DAYS = 14;

/** One finished session, built from intraday bars. */
interface DayRecord {
  /** Volume traded inside the opening-range window. */
  orVol: number;
  high: number;
  low: number;
  close: number;
}

function barMinutes(interval: Interval): number {
  return interval === "15m" ? 15 : interval === "5m" ? 5 : 0;
}

/** Simple mean of the true range over the last `ATR_DAYS` finished sessions. NaN if fewer than the minimum. */
export function dailyAtr(days: DayRecord[]): number {
  if (days.length < ORB_RVOL_MIN_SESSIONS) return NaN;
  const start = Math.max(0, days.length - ATR_DAYS);
  let sum = 0;
  let n = 0;
  for (let k = start; k < days.length; k++) {
    const d = days[k];
    let tr = d.high - d.low;
    if (k > 0) {
      const pc = days[k - 1].close;
      tr = Math.max(tr, Math.abs(d.high - pc), Math.abs(d.low - pc));
    }
    sum += tr;
    n++;
  }
  return n > 0 ? sum / n : NaN;
}

/**
 * Opening range breakout on unusual volume. Port of Zarattini, Barbon & Aziz (2024),
 * "A Profitable Day Trading Strategy for the U.S. Equity Market", adapted to a per-symbol bar engine.
 *
 * Rules:
 * - Opening range = bars starting in the first `orMinutes` minutes from 09:15 IST.
 * - RVOL = today's opening-range volume / mean opening-range volume of the previous `rvolDays`
 *   sessions (at least 5 needed, else no trade). Trade only if RVOL >= `rvolMin` (0 = filter off).
 * - Direction: range close > range open -> long only; < -> short only; equal -> no trade.
 * - Entry: first completed bar after the range that CLOSES beyond the range high (long) / low (short),
 *   and that finishes within `lastEntryMin` minutes of the open. The engine fills at the next bar's open.
 * - Stop: max(`atrFrac` x 14-day ATR of PRIOR sessions, `minStopPct` % of price) from the signal close.
 * - Exit: stop or the engine's square-off. `rr` > 0 adds a fixed target at rr x stop distance.
 * - One signal per day.
 *
 * Differences from the paper: the paper rests a stop order at the range edge (we enter one bar after
 * a close beyond it, so later and at a worse price); the paper picks the top 20 stocks by RVOL out of
 * thousands each day (here every symbol is judged on its own against a fixed RVOL threshold); the
 * paper's stop is 10% of ATR from the entry price (here 25% by default with a percentage floor,
 * because Indian charges make tighter stops untradable).
 *
 * No look-ahead: state is built bar by bar from candles[0..index] only. Sessions whose first bar is
 * not 09:15 (a slice that starts mid-day) are neither traded nor used as history.
 */
export function createOrbRvol(): Strategy {
  let lastCandles: Candle[] | null = null;
  let lastIdx = -1;
  let paramsKey = "";
  let lastParams: Params | null = null;

  /** Finished sessions, oldest first. */
  let history: DayRecord[] = [];

  // Current session.
  let dayKey = "";
  let startedAtOpen = false;
  let orOpen = NaN;
  let orClose = NaN;
  let orHigh = -Infinity;
  let orLow = Infinity;
  let orVol = 0;
  let dayHigh = -Infinity;
  let dayLow = Infinity;
  let dayClose = NaN;
  let tradedToday = false;
  /** Decided once, on the first bar after the range: side to trade today, or null for no trade. */
  let decided = false;
  let todaySide: Side | null = null;
  let todayAtr = NaN;
  let todayRvol = NaN;

  const resetAll = () => {
    history = [];
    dayKey = "";
    lastIdx = -1;
  };

  const startDay = (key: string, minsFromOpen: number) => {
    if (dayKey && startedAtOpen && Number.isFinite(orOpen)) {
      history.push({ orVol, high: dayHigh, low: dayLow, close: dayClose });
      if (history.length > 80) history.shift();
    }
    dayKey = key;
    startedAtOpen = minsFromOpen === 0;
    orOpen = NaN;
    orClose = NaN;
    orHigh = -Infinity;
    orLow = Infinity;
    orVol = 0;
    dayHigh = -Infinity;
    dayLow = Infinity;
    dayClose = NaN;
    tradedToday = false;
    decided = false;
    todaySide = null;
    todayAtr = NaN;
    todayRvol = NaN;
  };

  /** Fold one bar into the state. Returns minutes from the open. */
  const absorb = (c: Candle, orMin: number): number => {
    const minsFromOpen = istMinutes(c.time) - SESSION_OPEN_MIN;
    const key = istDay(c.time);
    if (key !== dayKey) startDay(key, minsFromOpen);
    if (c.high > dayHigh) dayHigh = c.high;
    if (c.low < dayLow) dayLow = c.low;
    dayClose = c.close;
    if (minsFromOpen >= 0 && minsFromOpen < orMin) {
      if (!Number.isFinite(orOpen)) orOpen = c.open;
      orClose = c.close;
      if (c.high > orHigh) orHigh = c.high;
      if (c.low < orLow) orLow = c.low;
      orVol += c.volume;
    }
    return minsFromOpen;
  };

  const decide = (rvolDays: number, rvolMin: number) => {
    decided = true;
    todaySide = null;
    if (!startedAtOpen || !Number.isFinite(orOpen) || !(orHigh > orLow)) return;
    if (history.length < ORB_RVOL_MIN_SESSIONS) return;
    todayAtr = dailyAtr(history);
    if (!(todayAtr > 0)) return;

    const look = history.slice(-Math.max(ORB_RVOL_MIN_SESSIONS, Math.floor(rvolDays)));
    let sum = 0;
    for (const d of look) sum += d.orVol;
    const mean = sum / look.length;
    todayRvol = mean > 0 ? orVol / mean : NaN;
    if (rvolMin > 0 && !(todayRvol >= rvolMin)) return;

    if (orClose > orOpen) todaySide = "long";
    else if (orClose < orOpen) todaySide = "short";
  };

  return {
    id: "orb-rvol",
    name: "Opening range breakout on unusual volume",
    description:
      "Zarattini, Barbon & Aziz (2024). Trade only on days the opening range trades at least N times its usual volume, in the direction of the opening range, on the first close beyond it. Stop is a fraction of the daily ATR; held to the square-off unless a target is set.",
    intervals: ["5m", "15m"],
    // State is built from bar 0, so no warmup bars are skipped. Trading starts after 5 full sessions.
    warmup: 0,
    params: [
      { key: "orMinutes", label: "Range minutes", type: "number", default: 5, min: 5, max: 30, step: 5, grid: [5, 15] },
      { key: "rvolMin", label: "Min relative volume (0 = off)", type: "number", default: 2, min: 0, max: 10, step: 0.5, grid: [1, 1.5, 2, 3] },
      { key: "rvolDays", label: "Relative volume lookback (sessions)", type: "number", default: 14, min: 5, max: 60, step: 1, grid: [14] },
      { key: "lastEntryMin", label: "No entries after (min from open)", type: "number", default: 60, min: 10, max: 360, step: 5, grid: [30, 60, 120] },
      { key: "atrFrac", label: "Stop as fraction of daily ATR", type: "number", default: 0.25, min: 0.05, max: 2, step: 0.05, grid: [0.1, 0.25, 0.5] },
      { key: "minStopPct", label: "Min stop % of price", type: "number", default: 0.35, min: 0, max: 3, step: 0.05, grid: [0.35] },
      { key: "rr", label: "Target R (0 = hold to close)", type: "number", default: 0, min: 0, max: 10, step: 0.5, grid: [0, 2] },
    ],
    onBar(ctx) {
      // The engine passes the same params object every bar; only re-check its contents when it changes.
      if (ctx.params !== lastParams) {
        const key = JSON.stringify(ctx.params);
        if (key !== paramsKey) resetAll();
        paramsKey = key;
        lastParams = ctx.params;
      }
      if (ctx.candles !== lastCandles || ctx.index <= lastIdx) {
        resetAll();
        lastCandles = ctx.candles;
      }
      const orMin = num(ctx.params, "orMinutes", 5);

      // Catch up on any bars not seen yet (none in the engine, which calls every bar in order).
      for (let k = lastIdx + 1; k < ctx.index; k++) absorb(ctx.candles[k], orMin);
      const c = ctx.candles[ctx.index];
      const minsFromOpen = absorb(c, orMin);
      lastIdx = ctx.index;

      if (minsFromOpen < orMin) return null;
      if (!decided) decide(num(ctx.params, "rvolDays", 14), num(ctx.params, "rvolMin", 2));
      if (!todaySide || tradedToday || ctx.position) return null;
      // The signal bar must have finished within the entry window.
      if (minsFromOpen + barMinutes(ctx.interval) > num(ctx.params, "lastEntryMin", 60)) return null;

      const broke = todaySide === "long" ? c.close > orHigh : c.close < orLow;
      if (!broke) return null;

      const dist = Math.max(
        num(ctx.params, "atrFrac", 0.25) * todayAtr,
        (num(ctx.params, "minStopPct", 0.35) / 100) * c.close,
      );
      if (!(dist > 0)) return null;
      tradedToday = true;
      const rr = num(ctx.params, "rr", 0);
      const rvolTxt = Number.isFinite(todayRvol) ? todayRvol.toFixed(1) : "n/a";
      if (todaySide === "long") {
        return {
          action: "enter",
          side: "long",
          stop: c.close - dist,
          ...(rr > 0 ? { target: c.close + rr * dist } : {}),
          reason: `ORB long > ${orHigh.toFixed(2)}, RVOL ${rvolTxt}`,
        };
      }
      return {
        action: "enter",
        side: "short",
        stop: c.close + dist,
        ...(rr > 0 ? { target: c.close - rr * dist } : {}),
        reason: `ORB short < ${orLow.toFixed(2)}, RVOL ${rvolTxt}`,
      };
    },
    overlays(candles, params) {
      const orMin = num(params, "orMinutes", 5);
      const high: Overlay = { name: "Range high", color: "#16a34a", style: "step", points: [] };
      const low: Overlay = { name: "Range low", color: "#dc2626", style: "step", points: [] };
      let day = "";
      let hi = -Infinity;
      let lo = Infinity;
      let drawn = false;
      for (const c of candles) {
        const d = istDay(c.time);
        if (d !== day) {
          day = d;
          hi = -Infinity;
          lo = Infinity;
          drawn = false;
        }
        const m = istMinutes(c.time) - SESSION_OPEN_MIN;
        if (m >= 0 && m < orMin) {
          if (c.high > hi) hi = c.high;
          if (c.low < lo) lo = c.low;
        } else if (!drawn && Number.isFinite(hi) && Number.isFinite(lo)) {
          drawn = true;
          high.points.push({ time: c.time, value: hi });
          low.points.push({ time: c.time, value: lo });
        }
      }
      return [high, low];
    },
  };
}
