// "Stocks in play": which stocks are moving AND trading unusually heavily today.
// Pure ranking logic, no I/O.

import type { Candle } from "@/lib/types";
import { istDayKey } from "@/lib/backtest";
import { IST_OFFSET_MS } from "@/lib/types";

// This file is imported by the browser too, so it must not pull in server-only modules
// (data/yahoo reads the disk). Hence a local copy of this one-liner.
/** Minutes since IST midnight. */
function istMinutesOfDay(ms: number): number {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export interface InPlay {
  symbol: string;
  /** Last traded price, INR. */
  price: number;
  /** % change of the last price vs the previous day's close. */
  changePct: number;
  /** Today's volume so far ÷ the usual volume by this time of day. 1 = normal. NaN if unknown. */
  relVol: number;
  /** |changePct| × relVol (capped). Higher = more in play. */
  score: number;
}

/** Days of history needed before "usual volume" means anything. */
const MIN_HISTORY_DAYS = 3;
/** One freak print should not dominate the ranking. */
const REL_VOL_CAP = 5;

/**
 * Measure one stock on its latest day in the data. Returns null when there is no previous day to
 * compare with, or when that latest day is not `today` (stale data must not look like a mover).
 *
 * Volume is compared like-for-like: today's volume up to the latest bar against the average
 * volume up to the same clock time on earlier days, because volume is always heavy at the open.
 */
export function measureInPlay(symbol: string, candles: Candle[], today: string): InPlay | null {
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  if (istDayKey(last.time) !== today) return null;
  const cutoff = istMinutesOfDay(last.time);

  const volByDay = new Map<string, number>();
  let prevClose = NaN;
  for (const c of candles) {
    const day = istDayKey(c.time);
    if (day !== today) prevClose = c.close; // candles are ascending, so this ends on the previous day's last bar
    if (istMinutesOfDay(c.time) <= cutoff) volByDay.set(day, (volByDay.get(day) ?? 0) + c.volume);
  }
  if (!(prevClose > 0)) return null;

  const changePct = ((last.close - prevClose) / prevClose) * 100;
  const todayVol = volByDay.get(today) ?? 0;
  const earlier = [...volByDay.entries()].filter(([d, v]) => d !== today && v > 0).map(([, v]) => v);
  const usual = earlier.length >= MIN_HISTORY_DAYS ? earlier.reduce((s, v) => s + v, 0) / earlier.length : NaN;
  const relVol = usual > 0 && todayVol > 0 ? todayVol / usual : NaN;

  // Unknown volume counts as normal volume: the stock can still rank on its move alone.
  const score = Math.abs(changePct) * Math.min(Number.isFinite(relVol) ? relVol : 1, REL_VOL_CAP);
  return { symbol, price: last.close, changePct, relVol, score };
}

/** Most in play first. */
export function rankInPlay(candlesBySymbol: Record<string, Candle[]>, today: string): InPlay[] {
  const out: InPlay[] = [];
  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    const m = measureInPlay(symbol, candles, today);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Fewer shares than this gives no control over the size of a trade. */
export const MIN_SHARES = 2;
/** Cheaper than this (INR) behaves like a penny stock: one tick is too big a part of the price. */
export const MIN_PRICE = 20;
/** A stock must be up or down at least this much today (%)… */
export const MIN_MOVE_PCT = 1.0;
/** …or trading at least this many times its usual volume. Otherwise the move cannot beat the charges. */
export const MIN_REL_VOL = 2;
/** With fewer movers than this, the movement floor is dropped so there is still something to look at. */
export const MIN_MOVERS = 5;

/** How many shares the account can hold at this price, margin included. */
export function sharesAffordable(price: number, capital: number, leverage: number): number {
  return price > 0 && capital > 0 ? Math.floor((capital * Math.max(1, leverage)) / price) : 0;
}

/** The account can take a sensible position: at least MIN_SHARES shares, and not a penny stock. */
export function isAffordable(price: number, capital: number, leverage: number): boolean {
  return price >= MIN_PRICE && sharesAffordable(price, capital, leverage) >= MIN_SHARES;
}

/** Moving enough today that a trade can earn more than it costs. */
export function isMoving(p: Pick<InPlay, "changePct" | "relVol">): boolean {
  return Math.abs(p.changePct) >= MIN_MOVE_PCT || (Number.isFinite(p.relVol) && p.relVol >= MIN_REL_VOL);
}

export interface PickArgs {
  /** How many stocks to scan. */
  top: number;
  capital: number;
  /** Intraday margin multiplier, 1 = none. */
  leverage: number;
  /** Stocks with a live signal: stay on screen while still affordable. */
  keep?: string[];
  /** Stocks with an open paper trade: always stay on screen. */
  held?: string[];
}

export interface Picked {
  picks: InPlay[];
  /** How many of the ranked stocks the account can trade at all. */
  affordableCount: number;
  /** The dearest share the account can buy MIN_SHARES of. */
  maxPrice: number;
  /** Too few stocks were moving, so quiet ones were let in. */
  movementRelaxed: boolean;
}

/**
 * The stocks to scan: the `top` most in play that the account can actually trade and that are
 * moving enough to beat charges. Stocks in `keep` stay while affordable; stocks in `held` (an open
 * paper trade) always stay, so a stock does not vanish from the screen while you are in it.
 */
export function pickInPlay(ranked: InPlay[], args: PickArgs): Picked {
  const { top, capital, leverage, keep = [], held = [] } = args;
  const affordable = ranked.filter((p) => isAffordable(p.price, capital, leverage));
  const moving = affordable.filter(isMoving);
  const movementRelaxed = moving.length < MIN_MOVERS && affordable.length > moving.length;
  // Relaxed: the real movers still come first, then the quieter ones in ranking order.
  const candidates = movementRelaxed ? [...moving, ...affordable.filter((p) => !isMoving(p))] : moving;

  const picks = candidates.slice(0, top);
  const have = new Set(picks.map((p) => p.symbol));
  for (const p of ranked) {
    if (have.has(p.symbol)) continue;
    if (held.includes(p.symbol) || (keep.includes(p.symbol) && isAffordable(p.price, capital, leverage))) {
      picks.push(p);
      have.add(p.symbol);
    }
  }
  return { picks, affordableCount: affordable.length, maxPrice: (capital * Math.max(1, leverage)) / MIN_SHARES, movementRelaxed };
}

/**
 * Rough share of a normal day's volume that has traded by a given IST time. NSE volume is heavy
 * at the open and the close and thin over lunch. It is the same for every stock at a given moment,
 * so an imperfect curve shifts every "x usual volume" figure together and leaves the ranking alone.
 */
const VOLUME_CURVE: [number, number][] = [
  [9 * 60 + 15, 0],
  [9 * 60 + 30, 0.1],
  [10 * 60, 0.2],
  [11 * 60, 0.35],
  [12 * 60, 0.47],
  [13 * 60, 0.57],
  [14 * 60, 0.68],
  [15 * 60, 0.86],
  [15 * 60 + 30, 1],
];

export function expectedVolumeFraction(minutesOfDay: number): number {
  if (minutesOfDay <= VOLUME_CURVE[0][0]) return 0;
  for (let i = 1; i < VOLUME_CURVE.length; i++) {
    const [t1, f1] = VOLUME_CURVE[i];
    if (minutesOfDay <= t1) {
      const [t0, f0] = VOLUME_CURVE[i - 1];
      return f0 + ((f1 - f0) * (minutesOfDay - t0)) / (t1 - t0);
    }
  }
  return 1;
}

/** Same measure as `measureInPlay`, from a live quote and the stock's average daily volume. */
export function measureFromQuote(
  symbol: string,
  q: { last: number; prevClose: number; volume: number },
  avgDailyVolume: number | undefined,
  minutesOfDay: number,
): InPlay | null {
  if (!(q.prevClose > 0) || !(q.last > 0)) return null;
  const changePct = ((q.last - q.prevClose) / q.prevClose) * 100;
  const expected = (avgDailyVolume ?? 0) * expectedVolumeFraction(minutesOfDay);
  const relVol = expected > 0 && q.volume > 0 ? q.volume / expected : NaN;
  const score = Math.abs(changePct) * Math.min(Number.isFinite(relVol) ? relVol : 1, REL_VOL_CAP);
  return { symbol, price: q.last, changePct, relVol, score };
}
