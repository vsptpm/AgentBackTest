import { describe, expect, it } from "vitest";
import { computeTradeCosts } from "@/lib/backtest/costs";
import { DEFAULT_COSTS, IST_OFFSET_MS, type Candle } from "@/lib/types";
import { simulate } from "./timemachine";
import type { TradePlan } from "./types";

const DAY_MS = 86_400_000;
const DAYS = 20;
const day0 = Date.UTC(2026, 9, 5) - IST_OFFSET_MS; // 00:00 IST
const istTime = (day: number, hh: number, mm: number) => day0 + day * DAY_MS + (hh * 60 + mm) * 60_000;

/** Driftless random walk: 20 sessions of 75 five-minute bars, the last one cut off at `now`. */
function makeCandles(now: number): Candle[] {
  let state = 12345;
  const rnd = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const out: Candle[] = [];
  for (let d = 0; d < DAYS; d++) {
    let price = 100;
    for (let i = 0; i < 75; i++) {
      const time = istTime(d, 9, 15) + i * 5 * 60_000;
      if (time >= now) break;
      const open = price;
      const close = open * (1 + (rnd() - 0.5) * 0.004);
      const high = Math.max(open, close) * (1 + rnd() * 0.0005);
      const low = Math.min(open, close) * (1 - rnd() * 0.0005);
      out.push({ time, open, high, low, close, volume: 1000 });
      price = close;
    }
  }
  return out;
}

function makePlan(over: Partial<TradePlan> = {}): TradePlan {
  return {
    symbol: "TEST.NS",
    side: "long",
    entry: 100,
    entryZone: [99.9, 100.1],
    trigger: "test",
    stop: 99,
    targets: [102, 103],
    qty: 100,
    capitalRequired: 2000,
    maxLoss: 120,
    rewardToRisk: 2,
    costs: 10,
    holding: "intraday",
    invalidation: "test",
    timeExit: "15:05",
    ...over,
  };
}

const now = istTime(DAYS - 1, 11, 0);
const candles = makeCandles(now);

describe("simulate", () => {
  it("is deterministic for a fixed seed and varies with the seed", () => {
    const a = simulate(makePlan(), candles, now, { seed: 7 });
    const b = simulate(makePlan(), candles, now, { seed: 7 });
    const c = simulate(makePlan(), candles, now, { seed: 8 });
    expect(a).toEqual(b);
    expect(c.expectedValue).not.toBe(a.expectedValue);
    expect(a.paths).toBe(2000);
  });

  it("probabilities sum to 1 and the distribution is ordered", () => {
    const r = simulate(makePlan(), candles, now);
    expect(r.pTarget + r.pStop + r.pNeither).toBeCloseTo(1, 10);
    const { p5, p25, p50, p75, p95 } = r.percentiles;
    expect(r.worst).toBeLessThanOrEqual(p5);
    expect(p5).toBeLessThanOrEqual(p25);
    expect(p25).toBeLessThanOrEqual(p50);
    expect(p50).toBeLessThanOrEqual(p75);
    expect(p75).toBeLessThanOrEqual(p95);
    expect(p95).toBeLessThanOrEqual(r.best);
    expect(r.medianPnl).toBe(p50);
    expect(r.riskOfRuin).toBeGreaterThanOrEqual(0);
    expect(r.riskOfRuin).toBeLessThanOrEqual(1);
  });

  it("histogram has 12 buckets whose counts sum to the paths", () => {
    const r = simulate(makePlan(), candles, now, { paths: 500 });
    expect(r.histogram).toHaveLength(12);
    expect(r.histogram.reduce((a, b) => a + b.count, 0)).toBe(500);
  });

  it("a near target with a far stop favours the target, and the reverse", () => {
    const nearTarget = simulate(makePlan({ stop: 97, targets: [100.15] }), candles, now);
    expect(nearTarget.pTarget).toBeGreaterThan(nearTarget.pStop);
    const nearStop = simulate(makePlan({ stop: 99.85, targets: [103] }), candles, now);
    expect(nearStop.pStop).toBeGreaterThan(nearStop.pTarget);
    const shortNearTarget = simulate(makePlan({ side: "short", stop: 103, targets: [99.85] }), candles, now);
    expect(shortNearTarget.pTarget).toBeGreaterThan(shortNearTarget.pStop);
  });

  it("the stop scenario equals the slipped risk plus charges", () => {
    const plan = makePlan();
    const r = simulate(plan, candles, now);
    const fill = plan.stop * (1 - 0.001);
    const costs = computeTradeCosts({
      side: "long", entryPrice: plan.entry, exitPrice: fill, qty: plan.qty, model: DEFAULT_COSTS, intraday: true,
    });
    const against = r.scenarios.find((s) => s.name === "Moves against you immediately");
    expect(Math.abs(against!.pnl - (-(plan.entry - fill) * plan.qty - costs))).toBeLessThan(1);
    expect(r.scenarios.find((s) => s.name === "Moves your way immediately")!.pnl).toBeGreaterThan(0);
    expect(r.scenarios.some((s) => s.name === "Reaches target 2")).toBe(true);
    expect(simulate(makePlan({ targets: [102] }), candles, now).scenarios.some((s) => s.name === "Reaches target 2")).toBe(false);
  });

  it("replay uses prior sessions only and its counts add up", () => {
    const { replay } = simulate(makePlan(), candles, now);
    expect(replay.sessions).toBe(DAYS - 1);
    expect(replay.wins + replay.losses + replay.flat).toBe(replay.sessions);
    expect(replay.winRate).toBeCloseTo(replay.wins / replay.sessions, 10);
  });

  it("ignores the latest day entirely (no look-ahead)", () => {
    const tampered = candles.map((c) => (c.time >= istTime(DAYS - 1, 0, 0) ? { ...c, high: c.high * 2, low: c.low / 2, close: c.close * 1.5 } : c));
    expect(simulate(makePlan(), tampered, now)).toEqual(simulate(makePlan(), candles, now));
  });

  it("still works when the market is closed or there is no history", () => {
    const closed = simulate(makePlan(), candles, istTime(DAYS - 1, 20, 0));
    expect(closed.pTarget + closed.pStop + closed.pNeither).toBeCloseTo(1, 10);
    const empty = simulate(makePlan(), [], now, { paths: 50 });
    expect(empty.pNeither).toBe(1);
    expect(empty.replay.sessions).toBe(0);
  });
});
