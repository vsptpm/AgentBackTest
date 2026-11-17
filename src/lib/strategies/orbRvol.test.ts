import { describe, expect, it } from "vitest";
import type { Candle, Params, Signal } from "@/lib/types";
import { createOrbRvol } from "./orbRvol";
import { SESSION_OPEN_MIN } from "./helpers";

const IST = 5.5 * 60 * 60 * 1000;
const BARS = 75;

type BarPatch = Partial<Omit<Candle, "time">>;

/** One 5m session 09:15..15:25. Flat bars (100 / 101 / 99 / 100, volume 1000) unless patched by bar number. */
function day(dayNo: number, patches: Record<number, BarPatch> = {}, firstBar = 0): Candle[] {
  const dayStart = Date.parse("2026-03-02T00:00:00Z") + dayNo * 86_400_000 - IST;
  const out: Candle[] = [];
  for (let k = firstBar; k < BARS; k++) {
    out.push({
      time: dayStart + (SESSION_OPEN_MIN + k * 5) * 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1000,
      ...patches[k],
    });
  }
  return out;
}

/** Quiet bar that stays inside the test day's opening range. */
const QUIET: BarPatch = { open: 100.4, high: 100.7, low: 100.1, close: 100.4 };

/** A test day whose bars after the open are all quiet unless patched. */
function testDay(dayNo: number, patches: Record<number, BarPatch>): Candle[] {
  const all: Record<number, BarPatch> = {};
  for (let k = 1; k < BARS; k++) all[k] = QUIET;
  return day(dayNo, { ...all, ...patches });
}

function prior(n: number): Candle[] {
  const out: Candle[] = [];
  for (let d = 0; d < n; d++) out.push(...day(d));
  return out;
}

const DEFAULTS: Params = { orMinutes: 5, rvolMin: 2, rvolDays: 14, lastEntryMin: 60, atrFrac: 0.25, minStopPct: 0.35, rr: 0 };

function run(candles: Candle[], params: Params = {}, upTo = candles.length - 1): { index: number; signal: Signal }[] {
  const s = createOrbRvol();
  const out: { index: number; signal: Signal }[] = [];
  for (let i = s.warmup; i <= upTo; i++) {
    const signal = s.onBar({ candles, index: i, params: { ...DEFAULTS, ...params }, position: null, interval: "5m" });
    if (signal) out.push({ index: i, signal });
  }
  return out;
}

/** Up opening bar: range 99.9..100.8, close above open. */
const upOpen = (volume: number): BarPatch => ({ open: 100, high: 100.8, low: 99.9, close: 100.6, volume });
/** Down opening bar: range 99.2..100.1, close below open. */
const downOpen = (volume: number): BarPatch => ({ open: 100, high: 100.1, low: 99.2, close: 99.4, volume });
const BREAK_UP: BarPatch = { open: 100.6, high: 101.3, low: 100.5, close: 101.2 };
const BREAK_DOWN: BarPatch = { open: 99.4, high: 99.5, low: 98.7, close: 98.8 };

describe("orb-rvol", () => {
  const N = 10;
  const base = N * BARS;

  it("trades when the opening range has 3x its usual volume", () => {
    const candles = [...prior(N), ...testDay(N, { 0: upOpen(3000), 2: BREAK_UP })];
    const sigs = run(candles);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].index).toBe(base + 2);
    expect(sigs[0].signal.side).toBe("long");
    expect(sigs[0].signal.action).toBe("enter");
  });

  it("does not trade when the opening range has 0.8x its usual volume", () => {
    const candles = [...prior(N), ...testDay(N, { 0: upOpen(800), 2: BREAK_UP })];
    expect(run(candles)).toHaveLength(0);
  });

  it("rvolMin 0 switches the volume filter off", () => {
    const candles = [...prior(N), ...testDay(N, { 0: upOpen(800), 2: BREAK_UP })];
    expect(run(candles, { rvolMin: 0 })).toHaveLength(1);
  });

  it("uses only the opening-range window for relative volume", () => {
    // Heavy volume later in prior sessions must not raise the baseline.
    const heavy: Candle[] = [];
    for (let d = 0; d < N; d++) heavy.push(...day(d, { 10: { volume: 1_000_000 } }));
    const candles = [...heavy, ...testDay(N, { 0: upOpen(3000), 2: BREAK_UP })];
    expect(run(candles)).toHaveLength(1);
  });

  it("goes long only after an up opening range and short only after a down one", () => {
    // Up open, then a close below the range low: no short.
    const upThenDown = [...prior(N), ...testDay(N, { 0: upOpen(3000), 2: { open: 100, high: 100.1, low: 99.0, close: 99.2 } })];
    expect(run(upThenDown)).toHaveLength(0);

    const down = [...prior(N), ...testDay(N, { 0: downOpen(3000), 2: BREAK_DOWN })];
    const sigs = run(down, {}, base + 2);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].signal.side).toBe("short");

    // Down open, then a close above the range high: no long.
    const downThenUp = [...prior(N), ...testDay(N, { 0: downOpen(3000), 2: { open: 100, high: 100.9, low: 99.9, close: 100.8 } })];
    expect(run(downThenUp, {}, base + 2)).toHaveLength(0);
  });

  it("does not trade a doji opening range", () => {
    const candles = [...prior(N), ...testDay(N, { 0: { open: 100, high: 100.8, low: 99.9, close: 100, volume: 3000 }, 2: BREAK_UP })];
    expect(run(candles)).toHaveLength(0);
  });

  it("enters only on a close beyond the range, not on a wick", () => {
    const wick: BarPatch = { open: 100.5, high: 101.5, low: 100.4, close: 100.7 };
    const candles = [...prior(N), ...testDay(N, { 0: upOpen(3000), 1: wick, 2: wick, 4: BREAK_UP })];
    const sigs = run(candles);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].index).toBe(base + 4);
  });

  it("does not enter after lastEntryMin", () => {
    // Bar 11 starts at 55 min and finishes at 60: allowed. Bar 12 finishes at 65: too late.
    const ok = [...prior(N), ...testDay(N, { 0: upOpen(3000), 11: BREAK_UP })];
    expect(run(ok)).toHaveLength(1);
    const late = [...prior(N), ...testDay(N, { 0: upOpen(3000), 12: BREAK_UP })];
    expect(run(late)).toHaveLength(0);
    expect(run(late, { lastEntryMin: 120 })).toHaveLength(1);
  });

  it("sets the stop at max(atrFrac x daily ATR, minStopPct) and no target by default", () => {
    // Prior sessions: high 101, low 99 every day -> daily ATR 2.
    const candles = [...prior(N), ...testDay(N, { 0: upOpen(3000), 2: BREAK_UP })];
    const atrWins = run(candles)[0].signal;
    expect(atrWins.stop).toBeCloseTo(101.2 - 0.5, 6);
    expect(atrWins.target).toBeUndefined();

    // 0.1 x 2 = 0.2 is tighter than 0.35% of 101.2 = 0.3542 -> the percentage floor wins.
    const pctWins = run(candles, { atrFrac: 0.1 })[0].signal;
    expect(pctWins.stop).toBeCloseTo(101.2 - 0.3542, 6);

    const withTarget = run(candles, { rr: 2 })[0].signal;
    expect(withTarget.target).toBeCloseTo(101.2 + 2 * 0.5, 6);

    const short = run([...prior(N), ...testDay(N, { 0: downOpen(3000), 2: BREAK_DOWN })], { rr: 2 })[0].signal;
    expect(short.stop).toBeCloseTo(98.8 + 0.5, 6);
    expect(short.target).toBeCloseTo(98.8 - 1, 6);
  });

  it("excludes today from the daily ATR", () => {
    // A huge bar today before the signal must not widen the stop.
    const spike: BarPatch = { open: 100.4, high: 100.7, low: 80, close: 100.4 };
    const candles = [...prior(N), ...testDay(N, { 0: upOpen(3000), 1: spike, 2: BREAK_UP })];
    expect(run(candles)[0].signal.stop).toBeCloseTo(101.2 - 0.5, 6);
  });

  it("emits one signal per day", () => {
    const candles = [...prior(N), ...testDay(N, { 0: upOpen(3000), 2: BREAK_UP, 3: BREAK_UP, 5: BREAK_UP })];
    expect(run(candles)).toHaveLength(1);
    // And trades again on the next qualifying day.
    const two = [...candles, ...testDay(N + 1, { 0: upOpen(3000), 2: BREAK_UP })];
    expect(run(two)).toHaveLength(2);
  });

  it("does not trade without 5 prior sessions", () => {
    const four = [...prior(4), ...testDay(4, { 0: upOpen(3000), 2: BREAK_UP })];
    expect(run(four)).toHaveLength(0);
    const five = [...prior(5), ...testDay(5, { 0: upOpen(3000), 2: BREAK_UP })];
    expect(run(five)).toHaveLength(1);
  });

  it("ignores a session that does not start at 09:15", () => {
    // A partial first session is not history: 4 full + 1 partial is still not enough.
    const candles = [...day(0, {}, 30), ...[1, 2, 3, 4].flatMap((d) => day(d)), ...testDay(5, { 0: upOpen(3000), 2: BREAK_UP })];
    expect(run(candles)).toHaveLength(0);
  });

  it("has no look-ahead: changing future bars does not change the signal at bar i", () => {
    const candles = [...prior(N), ...testDay(N, { 0: upOpen(3000), 2: BREAK_UP }), ...day(N + 1)];
    const i = base + 2;
    const at = (cs: Candle[], idx: number) => run(cs, {}, idx).find((s) => s.index === idx)?.signal ?? null;
    const before = at(candles, i);
    expect(before).not.toBeNull();

    const mutated = candles.map((c, k) =>
      k > i ? { ...c, open: c.open * 3, high: c.high * 5, low: c.low * 0.2, close: c.close * 3, volume: c.volume * 1000 } : c,
    );
    expect(at(mutated, i)).toEqual(before);

    // Same for a bar with no signal, and for every bar of the day.
    for (let k = base; k < base + BARS; k++) expect(at(mutated, k)).toEqual(at(candles, k));
  });

  it("gives the same answer when called at one bar only (catch-up) as bar by bar", () => {
    const candles = [...prior(N), ...testDay(N, { 0: upOpen(3000), 2: BREAK_UP })];
    const s = createOrbRvol();
    const direct = s.onBar({ candles, index: base + 2, params: DEFAULTS, position: null, interval: "5m" });
    expect(direct).toEqual(run(candles)[0].signal);
  });
});
