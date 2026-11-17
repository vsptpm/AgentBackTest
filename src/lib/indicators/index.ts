// Pure technical indicators. No dependencies.
// Every function returns arrays aligned to the input length, with NaN during warmup.

import type { Candle } from "@/lib/types";
import { istDateKey } from "@/lib/data/yahoo";

function nanArray(n: number): number[] {
  return new Array<number>(n).fill(NaN);
}

function validPeriod(period: number): number {
  if (!Number.isFinite(period) || period < 1) throw new Error(`Invalid period ${period}`);
  return Math.floor(period);
}

// ---------------------------------------------------------------------------
// Moving averages
// ---------------------------------------------------------------------------

export function sma(values: number[], period: number): number[] {
  const p = validPeriod(period);
  const n = values.length;
  const out = nanArray(n);
  if (n < p) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= p) sum -= values[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values, multiplier 2/(p+1). */
export function ema(values: number[], period: number): number[] {
  const p = validPeriod(period);
  const n = values.length;
  const out = nanArray(n);
  if (n < p) return out;
  const k = 2 / (p + 1);
  let sum = 0;
  for (let i = 0; i < p; i++) sum += values[i];
  let prev = sum / p;
  out[p - 1] = prev;
  for (let i = p; i < n; i++) {
    prev = (values[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA): seed with SMA, then prev + (x - prev) / p. */
function wilder(values: number[], period: number, start = 0): number[] {
  const p = validPeriod(period);
  const n = values.length;
  const out = nanArray(n);
  const seedEnd = start + p - 1;
  if (seedEnd >= n) return out;
  let sum = 0;
  for (let i = start; i <= seedEnd; i++) sum += values[i];
  let prev = sum / p;
  out[seedEnd] = prev;
  for (let i = seedEnd + 1; i < n; i++) {
    prev = prev + (values[i] - prev) / p;
    out[i] = prev;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Oscillators
// ---------------------------------------------------------------------------

/** RSI with Wilder smoothing. First value at index `period`. */
export function rsi(values: number[], period: number): number[] {
  const p = validPeriod(period);
  const n = values.length;
  const out = nanArray(n);
  if (n <= p) return out;

  const gains = nanArray(n);
  const losses = nanArray(n);
  gains[0] = 0;
  losses[0] = 0;
  for (let i = 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  const avgGain = wilder(gains, p, 1);
  const avgLoss = wilder(losses, p, 1);
  for (let i = p; i < n; i++) {
    const g = avgGain[i];
    const l = avgLoss[i];
    if (Number.isNaN(g) || Number.isNaN(l)) continue;
    if (l === 0) out[i] = g === 0 ? 50 : 100;
    else out[i] = 100 - 100 / (1 + g / l);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Volatility
// ---------------------------------------------------------------------------

export function trueRange(candles: Candle[]): number[] {
  const n = candles.length;
  const out = nanArray(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (i === 0) {
      out[i] = c.high - c.low;
      continue;
    }
    const pc = candles[i - 1].close;
    out[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  return out;
}

/** Average True Range with Wilder smoothing. First value at index `period - 1`. */
export function atr(candles: Candle[], period: number): number[] {
  return wilder(trueRange(candles), period, 0);
}

/** Bollinger Bands using population standard deviation. */
export function bollinger(
  values: number[],
  period: number,
  mult: number,
): { upper: number[]; mid: number[]; lower: number[] } {
  const p = validPeriod(period);
  const n = values.length;
  const mid = sma(values, p);
  const upper = nanArray(n);
  const lower = nanArray(n);
  for (let i = p - 1; i < n; i++) {
    const m = mid[i];
    let sq = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const d = values[j] - m;
      sq += d * d;
    }
    const sd = Math.sqrt(sq / p);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { upper, mid, lower };
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

/**
 * Session VWAP: cumulative (typical price x volume) / cumulative volume,
 * resetting at each IST calendar day. Falls back to close when the input has
 * no volume at all (indices), and to typical price while a session's volume
 * is still zero.
 */
export function vwap(candles: Candle[]): number[] {
  const n = candles.length;
  const out = nanArray(n);
  if (n === 0) return out;
  const anyVolume = candles.some((c) => c.volume > 0);
  if (!anyVolume) return candles.map((c) => c.close);

  let day = "";
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const key = istDateKey(c.time);
    if (key !== day) {
      day = key;
      cumPV = 0;
      cumV = 0;
    }
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumV += c.volume;
    out[i] = cumV > 0 ? cumPV / cumV : tp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

/**
 * Supertrend. direction 1 = bullish (price above line), -1 = bearish, 0 = warmup.
 */
export function supertrend(
  candles: Candle[],
  period: number,
  multiplier: number,
): { line: number[]; direction: (1 | -1 | 0)[] } {
  const n = candles.length;
  const line = nanArray(n);
  const direction: (1 | -1 | 0)[] = new Array(n).fill(0);
  const a = atr(candles, period);

  let prevUpper = NaN;
  let prevLower = NaN;
  let prevDir: 1 | -1 | 0 = 0;

  for (let i = 0; i < n; i++) {
    if (Number.isNaN(a[i])) continue;
    const c = candles[i];
    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + multiplier * a[i];
    const basicLower = hl2 - multiplier * a[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;

    let upper = basicUpper;
    let lower = basicLower;
    if (!Number.isNaN(prevUpper)) {
      upper = basicUpper < prevUpper || prevClose > prevUpper ? basicUpper : prevUpper;
      lower = basicLower > prevLower || prevClose < prevLower ? basicLower : prevLower;
    }

    let dir: 1 | -1;
    if (prevDir === 0) {
      dir = c.close > upper ? 1 : c.close < lower ? -1 : 1;
    } else if (prevDir === -1) {
      dir = c.close > upper ? 1 : -1;
    } else {
      dir = c.close < lower ? -1 : 1;
    }

    line[i] = dir === 1 ? lower : upper;
    direction[i] = dir;
    prevUpper = upper;
    prevLower = lower;
    prevDir = dir;
  }
  return { line, direction };
}

/** Average Directional Index with Wilder smoothing. */
export function adx(
  candles: Candle[],
  period: number,
): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const p = validPeriod(period);
  const n = candles.length;
  const plusDI = nanArray(n);
  const minusDI = nanArray(n);
  const adxOut = nanArray(n);
  if (n < 2) return { adx: adxOut, plusDI, minusDI };

  const tr = trueRange(candles);
  const plusDM = nanArray(n);
  const minusDM = nanArray(n);
  plusDM[0] = 0;
  minusDM[0] = 0;
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  const sTR = wilder(tr, p, 1);
  const sPlus = wilder(plusDM, p, 1);
  const sMinus = wilder(minusDM, p, 1);

  const dx = nanArray(n);
  for (let i = p; i < n; i++) {
    if (Number.isNaN(sTR[i])) continue;
    const pdi = sTR[i] === 0 ? 0 : (100 * sPlus[i]) / sTR[i];
    const mdi = sTR[i] === 0 ? 0 : (100 * sMinus[i]) / sTR[i];
    plusDI[i] = pdi;
    minusDI[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
  }

  const smoothed = wilder(dx, p, p);
  for (let i = 0; i < n; i++) adxOut[i] = smoothed[i];
  return { adx: adxOut, plusDI, minusDI };
}

// ---------------------------------------------------------------------------
// Rolling extremes / channels
// ---------------------------------------------------------------------------

/** Rolling max over the last `period` values, inclusive of the current bar. */
export function highest(values: number[], period: number): number[] {
  const p = validPeriod(period);
  const n = values.length;
  const out = nanArray(n);
  for (let i = p - 1; i < n; i++) {
    let m = -Infinity;
    for (let j = i - p + 1; j <= i; j++) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}

/** Rolling min over the last `period` values, inclusive of the current bar. */
export function lowest(values: number[], period: number): number[] {
  const p = validPeriod(period);
  const n = values.length;
  const out = nanArray(n);
  for (let i = p - 1; i < n; i++) {
    let m = Infinity;
    for (let j = i - p + 1; j <= i; j++) if (values[j] < m) m = values[j];
    out[i] = m;
  }
  return out;
}

/**
 * Donchian channel over the PREVIOUS `period` bars, excluding the current bar.
 * upper[i] = max(high[i-period .. i-1]); lower[i] = min(low[i-period .. i-1]).
 * A close/high above upper[i] at bar i is therefore a valid breakout signal.
 */
export function donchian(candles: Candle[], period: number): { upper: number[]; lower: number[] } {
  const p = validPeriod(period);
  const n = candles.length;
  const hi = highest(candles.map((c) => c.high), p);
  const lo = lowest(candles.map((c) => c.low), p);
  const upper = nanArray(n);
  const lower = nanArray(n);
  for (let i = 1; i < n; i++) {
    upper[i] = hi[i - 1];
    lower[i] = lo[i - 1];
  }
  return { upper, lower };
}

// ---------------------------------------------------------------------------
// Cross detection
// ---------------------------------------------------------------------------

/** True if `a` crossed above `b` at index i. False if i < 1 or any value is NaN. */
export function crossover(a: number[], b: number[], i: number): boolean {
  if (i < 1 || i >= a.length || i >= b.length) return false;
  const a0 = a[i - 1];
  const a1 = a[i];
  const b0 = b[i - 1];
  const b1 = b[i];
  if (Number.isNaN(a0) || Number.isNaN(a1) || Number.isNaN(b0) || Number.isNaN(b1)) return false;
  return a0 <= b0 && a1 > b1;
}

/** True if `a` crossed below `b` at index i. False if i < 1 or any value is NaN. */
export function crossunder(a: number[], b: number[], i: number): boolean {
  if (i < 1 || i >= a.length || i >= b.length) return false;
  const a0 = a[i - 1];
  const a1 = a[i];
  const b0 = b[i - 1];
  const b1 = b[i];
  if (Number.isNaN(a0) || Number.isNaN(a1) || Number.isNaN(b0) || Number.isNaN(b1)) return false;
  return a0 >= b0 && a1 < b1;
}
