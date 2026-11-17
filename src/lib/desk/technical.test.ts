import { describe, expect, it } from "vitest";
import { MIN_STOP_PCT } from "@/lib/paper/settle";
import { IST_OFFSET_MS, type Candle } from "@/lib/types";
import { analyse, buildPlan } from "./technical";
import type { DeskAccount, TechnicalView } from "./types";

const BAR = 5 * 60_000;
const DAY = 86_400_000;
const BASE = 300;
const TODAY_BARS = 40;

/** 20 weekday sessions from Mon 2 Nov 2026; the last one follows `shape` (offset from BASE per bar). */
function series(shape: (i: number) => number, range = 0.3): { candles: Candle[]; now: number } {
  const candles: Candle[] = [];
  const firstOpen = Date.UTC(2026, 10, 2, 9, 15) - IST_OFFSET_MS;
  let days = 0;
  for (let d = 0; days < 20; d++) {
    const open = firstOpen + d * DAY;
    const dow = new Date(open + IST_OFFSET_MS).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    days++;
    const isLast = days === 20;
    const n = isLast ? TODAY_BARS : 75;
    let prev = BASE;
    for (let i = 0; i < n; i++) {
      const close = isLast ? BASE + shape(i) : BASE + range * Math.sin(i);
      candles.push({
        time: open + i * BAR,
        open: prev,
        high: Math.max(prev, close) + range,
        low: Math.min(prev, close) - range,
        close,
        volume: 1000,
      });
      prev = close;
    }
  }
  return { candles, now: candles[candles.length - 1].time + BAR };
}

const account: DeskAccount = { capital: 100_000, riskPerTrade: 0.01, maxDailyLoss: 0.02, leverage: 5, maxPositions: 2 };
const up = series((i) => 0.004 * i * i + 0.05 * Math.sin(i));
const down = series((i) => -0.004 * i * i - 0.05 * Math.sin(i));

function mustView(s: { candles: Candle[]; now: number }): TechnicalView {
  const v = analyse("TEST.NS", s.candles, s.now);
  if (!v) throw new Error("expected a view");
  return v;
}

describe("analyse", () => {
  it("reads an uptrend day as bullish", () => {
    const v = mustView(up);
    expect(v.bias).toBe("bullish");
    expect(v.score).toBeGreaterThan(0);
    expect(v.score).toBeLessThanOrEqual(100);
    expect(v.price).toBeGreaterThan(v.indicators.vwap);
    expect(v.indicators.relVol).toBeCloseTo(1, 5);
    expect(v.indicators.dayChangePct).toBeGreaterThan(0);
    expect(v.reasons.length).toBeGreaterThanOrEqual(5);
    expect(v.reasons.length).toBeLessThanOrEqual(8);
    expect(v.reasons.some((r) => r.ok)).toBe(true);
  });

  it("reads a downtrend day as bearish", () => {
    const v = mustView(down);
    expect(v.bias).toBe("bearish");
    expect(v.score).toBeLessThan(0);
  });

  it("gives no plan for a flat, tiny-range series", () => {
    const flat = series(() => 0, 0.01);
    const v = mustView(flat);
    expect(["sideways", "no-trade"]).toContain(v.bias);
    expect(buildPlan(v, flat.candles, account)).toBeNull();
  });

  it("returns null on too few bars", () => {
    expect(analyse("TEST.NS", up.candles.slice(-30), up.now)).toBeNull();
    expect(analyse("TEST.NS", [], up.now)).toBeNull();
  });

  it("drops a bar that is still forming", () => {
    const v = mustView({ candles: up.candles, now: up.now - 60_000 });
    expect(v.time).toBe(up.candles[up.candles.length - 2].time);
  });
});

describe("buildPlan", () => {
  it("builds a long plan for the uptrend", () => {
    const v = mustView(up);
    const p = buildPlan(v, up.candles, account);
    if (!p) throw new Error("expected a plan");
    expect(p.side).toBe("long");
    expect(p.entry).toBe(v.price);
    expect(p.stop).toBeLessThan(p.entry);
    expect(p.targets.length).toBeGreaterThanOrEqual(2);
    expect(p.targets[0]).toBeGreaterThan(p.entry);
    for (let i = 1; i < p.targets.length; i++) expect(p.targets[i]).toBeGreaterThan(p.targets[i - 1]);
    expect(p.entryZone[0]).toBeLessThanOrEqual(p.entry);
    expect(p.entryZone[1]).toBeGreaterThanOrEqual(p.entry);
    expect(p.capitalRequired).toBeCloseTo((p.qty * p.entry) / account.leverage, 6);
    expect(p.maxLoss).toBeCloseTo((p.entry - p.stop) * p.qty + p.costs, 6);
    expect(p.rewardToRisk).toBeGreaterThan(0);
  });

  it("builds a short plan for the downtrend", () => {
    const p = buildPlan(mustView(down), down.candles, account);
    if (!p) throw new Error("expected a plan");
    expect(p.side).toBe("short");
    expect(p.stop).toBeGreaterThan(p.entry);
    expect(p.targets[0]).toBeLessThan(p.entry);
    for (let i = 1; i < p.targets.length; i++) expect(p.targets[i]).toBeLessThan(p.targets[i - 1]);
  });

  it("sizes within the risk cap and the leverage cap", () => {
    const v = mustView(up);
    const byRisk = buildPlan(v, up.candles, account);
    if (!byRisk) throw new Error("expected a plan");
    expect(byRisk.qty).toBeGreaterThanOrEqual(1);
    expect(byRisk.maxLoss).toBeLessThanOrEqual(account.capital * account.riskPerTrade);
    expect(byRisk.qty).toBeLessThanOrEqual(Math.floor((account.capital * account.leverage) / byRisk.entry));

    const loose: DeskAccount = { ...account, riskPerTrade: 0.5, leverage: 1 };
    const byLeverage = buildPlan(v, up.candles, loose);
    if (!byLeverage) throw new Error("expected a plan");
    expect(byLeverage.qty).toBe(Math.floor(loose.capital / byLeverage.entry));

    expect(buildPlan(v, up.candles, { ...account, capital: 100, leverage: 1 })).toBeNull();
  });

  it("clamps the stop distance to [MIN_STOP_PCT, 1.5]% of entry", () => {
    const v = mustView(up);
    const pct = (p: { entry: number; stop: number }) => (Math.abs(p.entry - p.stop) / p.entry) * 100;

    const far: TechnicalView = { ...v, indicators: { ...v.indicators, vwap: v.price * 0.9 } };
    const wide = buildPlan(far, up.candles, account);
    if (!wide) throw new Error("expected a plan");
    expect(pct(wide)).toBeLessThanOrEqual(1.5);
    expect(pct(wide)).toBeGreaterThan(1.4);

    const near: TechnicalView = { ...v, indicators: { ...v.indicators, vwap: v.price, atr: 0.01 } };
    const tight = buildPlan(near, [], account);
    if (!tight) throw new Error("expected a plan");
    expect(pct(tight)).toBeGreaterThanOrEqual(MIN_STOP_PCT);
    expect(pct(tight)).toBeLessThan(MIN_STOP_PCT + 0.05);
  });
});
