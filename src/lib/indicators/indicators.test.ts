import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { IST_OFFSET_MS } from "@/lib/types";
import {
  adx,
  atr,
  bollinger,
  crossover,
  crossunder,
  donchian,
  ema,
  highest,
  lowest,
  rsi,
  sma,
  supertrend,
  vwap,
} from "./index";

const close = (p: number): number => Math.round(p * 100) / 100;

function mkCandles(rows: Array<[number, number, number, number, number?]>, startMs = 0, stepMs = 60_000): Candle[] {
  return rows.map(([o, h, l, c, v], i) => ({
    time: startMs + i * stepMs,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v ?? 0,
  }));
}

function expectNaNUntil(arr: number[], idx: number) {
  for (let i = 0; i < idx; i++) expect(Number.isNaN(arr[i]), `expected NaN at ${i}`).toBe(true);
  expect(Number.isNaN(arr[idx]), `expected a value at ${idx}`).toBe(false);
}

describe("sma", () => {
  it("matches hand-computed values and is aligned to input", () => {
    const out = sma([1, 2, 3, 4, 5, 6], 3);
    expect(out).toHaveLength(6);
    expectNaNUntil(out, 2);
    expect(out.slice(2)).toEqual([2, 3, 4, 5]);
  });

  it("returns all NaN when input shorter than period", () => {
    expect(sma([1, 2], 3).every(Number.isNaN)).toBe(true);
  });
});

describe("ema", () => {
  it("seeds with SMA and applies 2/(p+1)", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expectNaNUntil(out, 2);
    expect(out[2]).toBeCloseTo(2, 10); // SMA seed
    expect(out[3]).toBeCloseTo(3, 10); // 2 + (4-2)*0.5
    expect(out[4]).toBeCloseTo(4, 10); // 3 + (5-3)*0.5
  });

  it("ema(period=1) equals the input", () => {
    expect(ema([3, 1, 4], 1)).toEqual([3, 1, 4]);
  });
});

describe("rsi", () => {
  // Classic StockCharts / Wilder tutorial dataset.
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0,
    46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66,
    43.13,
  ];

  it("reproduces the classic RSI(14) example", () => {
    const out = rsi(closes, 14);
    expect(out).toHaveLength(closes.length);
    expectNaNUntil(out, 14);
    expect(out[14]).toBeCloseTo(70.5, 0); // first value ~70.46-70.53 depending on rounding
    expect(Math.abs(out[14] - 70.5)).toBeLessThan(0.15);
    // Later StockCharts values (rounded in their sheet): 66.32, 66.55, 69.41, 66.36, 57.97 ...
    expect(Math.abs(out[15] - 66.32)).toBeLessThan(0.15);
    expect(Math.abs(out[19] - 57.97)).toBeLessThan(0.15);
    expect(Math.abs(out[closes.length - 1] - 37.77)).toBeLessThan(0.2);
  });

  it("is 100 on a pure uptrend and bounded in [0, 100]", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const out = rsi(up, 14);
    expect(out[29]).toBe(100);
    const mixed = rsi(closes, 5);
    for (const v of mixed) if (!Number.isNaN(v)) expect(v >= 0 && v <= 100).toBe(true);
  });
});

describe("atr", () => {
  it("computes true range with Wilder smoothing", () => {
    const candles = mkCandles([
      [10, 12, 9, 11],
      [11, 13, 10, 12], // TR = max(3, |13-11|, |10-11|) = 3
      [12, 12.5, 10.5, 11], // TR = max(2, 0.5, 1.5) = 2
      [11, 14, 11, 13], // TR = max(3, 3, 0) = 3
    ]);
    const out = atr(candles, 3);
    expectNaNUntil(out, 2);
    // first TR = high-low = 3; (3 + 3 + 2) / 3 = 8/3
    expect(out[2]).toBeCloseTo(8 / 3, 10);
    expect(out[3]).toBeCloseTo(8 / 3 + (3 - 8 / 3) / 3, 10);
    expect(out.every((v) => Number.isNaN(v) || v >= 0)).toBe(true);
  });

  it("uses gaps in true range", () => {
    const candles = mkCandles([
      [10, 10, 10, 10],
      [20, 20, 20, 20], // gap: TR = |20 - 10| = 10 though high-low = 0
    ]);
    expect(atr(candles, 1)[1]).toBe(10);
  });
});

describe("bollinger", () => {
  it("mid equals sma and bands use population std dev", () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9]; // population sd = 2, mean = 5
    const { upper, mid, lower } = bollinger(values, 8, 2);
    expect(mid).toEqual(sma(values, 8));
    expect(mid[7]).toBe(5);
    expect(upper[7]).toBeCloseTo(9, 10);
    expect(lower[7]).toBeCloseTo(1, 10);
    expectNaNUntil(upper, 7);
  });
});

describe("highest / lowest", () => {
  it("rolls over a window inclusive of the current bar", () => {
    const v = [5, 3, 8, 1, 9, 2];
    expect(highest(v, 3).slice(2)).toEqual([8, 8, 9, 9]);
    expect(lowest(v, 3).slice(2)).toEqual([3, 1, 1, 1]);
    expectNaNUntil(highest(v, 3), 2);
    expect(highest(v, 1)).toEqual(v);
  });
});

describe("crossover / crossunder", () => {
  const a = [1, 2, 3, 3, 2, 1, NaN, 5];
  const b = [2, 2, 2, 2, 2, 2, 2, 2];

  it("detects a strict cross above after being at-or-below", () => {
    expect(crossover(a, b, 1)).toBe(false); // 1<=2 then 2>2 false (equal)
    expect(crossover(a, b, 2)).toBe(true); // 2<=2 then 3>2
    expect(crossover(a, b, 3)).toBe(false); // already above
  });

  it("detects cross under", () => {
    expect(crossunder(a, b, 4)).toBe(false); // 3>=2 then 2<2 false (equal)
    expect(crossunder(a, b, 5)).toBe(true); // 2>=2 then 1<2
  });

  it("returns false at index 0, out of range, or with NaN", () => {
    expect(crossover(a, b, 0)).toBe(false);
    expect(crossover(a, b, 100)).toBe(false);
    expect(crossover(a, b, 6)).toBe(false);
    expect(crossover(a, b, 7)).toBe(false); // prev is NaN
    expect(crossunder(a, b, 7)).toBe(false);
  });
});

describe("donchian", () => {
  it("excludes the current bar so a breakout is detectable", () => {
    const candles = mkCandles([
      [1, 10, 5, 7],
      [1, 11, 4, 7],
      [1, 12, 6, 7],
      [1, 20, 3, 15], // breakout bar: high 20 > prior max 12, low 3 < prior min 4
    ]);
    const { upper, lower } = donchian(candles, 3);
    expect(Number.isNaN(upper[2])).toBe(true); // only 2 prior bars
    expect(upper[3]).toBe(12);
    expect(lower[3]).toBe(4);
    expect(candles[3].high > upper[3]).toBe(true);
    expect(Number.isNaN(upper[0])).toBe(true);
  });
});

describe("vwap", () => {
  it("resets per IST session and weights by volume", () => {
    // 2024-01-02 09:15 IST
    const day1 = Date.UTC(2024, 0, 2, 9, 15) - IST_OFFSET_MS;
    const day2 = day1 + 24 * 60 * 60 * 1000;
    const candles: Candle[] = [
      { time: day1, open: 10, high: 12, low: 8, close: 10, volume: 100 }, // tp 10
      { time: day1 + 60_000, open: 10, high: 22, low: 18, close: 20, volume: 100 }, // tp 20 -> vwap 15
      { time: day2, open: 30, high: 33, low: 27, close: 30, volume: 50 }, // new day -> tp 30
    ];
    const out = vwap(candles);
    expect(out[0]).toBe(10);
    expect(out[1]).toBe(15);
    expect(out[2]).toBe(30);
  });

  it("falls back to close when there is no volume at all", () => {
    const candles = mkCandles([
      [1, 2, 0, 1.5],
      [1, 3, 1, 2.5],
    ]);
    expect(vwap(candles)).toEqual([1.5, 2.5]);
  });
});

describe("supertrend", () => {
  it("is bullish in a steady uptrend with the line below price", () => {
    const rows: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 40; i++) {
      const base = 100 + i * 2;
      rows.push([base, base + 1.5, base - 1, close(base + 1)]);
    }
    const candles = mkCandles(rows);
    const { line, direction } = supertrend(candles, 10, 3);
    expect(line).toHaveLength(40);
    expect(direction).toHaveLength(40);
    expect(direction[5]).toBe(0);
    expect(direction[39]).toBe(1);
    expect(line[39]).toBeLessThan(candles[39].close);
  });

  it("flips bearish after a sharp drop", () => {
    const rows: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 30; i++) rows.push([100, 101, 99, 100]);
    for (let i = 0; i < 5; i++) {
      const b = 100 - (i + 1) * 10;
      rows.push([b + 5, b + 5, b - 1, b]);
    }
    const { direction, line } = supertrend(mkCandles(rows), 10, 3);
    expect(direction[34]).toBe(-1);
    expect(line[34]).toBeGreaterThan(rows[34][3]);
  });
});

describe("adx", () => {
  it("has aligned output and DI values within [0, 100]", () => {
    const rows: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 60; i++) {
      const base = 100 + Math.sin(i / 3) * 5 + i * 0.5;
      rows.push([base, base + 1, base - 1, close(base + 0.2)]);
    }
    const { adx: a, plusDI, minusDI } = adx(mkCandles(rows), 14);
    expect(a).toHaveLength(60);
    expect(Number.isNaN(a[20])).toBe(true); // needs ~2*period bars
    expect(Number.isNaN(a[59])).toBe(false);
    for (let i = 14; i < 60; i++) {
      expect(plusDI[i] >= 0 && plusDI[i] <= 100).toBe(true);
      expect(minusDI[i] >= 0 && minusDI[i] <= 100).toBe(true);
    }
    expect(a[59] >= 0 && a[59] <= 100).toBe(true);
  });

  it("is strongly trending on a straight ramp", () => {
    const rows: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 60; i++) rows.push([100 + i, 101 + i, 99 + i, 100.5 + i]);
    const { adx: a, plusDI, minusDI } = adx(mkCandles(rows), 14);
    expect(plusDI[59]).toBeGreaterThan(minusDI[59]);
    expect(minusDI[59]).toBe(0);
    expect(a[59]).toBeGreaterThan(50);
  });
});
