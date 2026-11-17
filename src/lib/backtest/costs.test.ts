import { describe, expect, it } from "vitest";
import { DEFAULT_COSTS } from "@/lib/types";
import { breakdownTradeCosts, computeTradeCosts, isIntradayInterval } from "./costs";

describe("isIntradayInterval", () => {
  it("treats 5m and 15m as intraday, 1d as delivery", () => {
    expect(isIntradayInterval("5m")).toBe(true);
    expect(isIntradayInterval("15m")).toBe(true);
    expect(isIntradayInterval("1d")).toBe(false);
  });
});

describe("computeTradeCosts", () => {
  // Long 100 @ 100 -> 101. Buy turnover 10,000; sell turnover 10,100.
  const base = { side: "long" as const, entryPrice: 100, exitPrice: 101, qty: 100, model: DEFAULT_COSTS };

  it("hand-computed intraday long example", () => {
    const b = breakdownTradeCosts({ ...base, intraday: true });
    // Brokerage: min(20, 0.1% * 10000) + min(20, 0.1% * 10100) = 10 + 10.1
    expect(b.brokerage).toBeCloseTo(20.1, 6);
    // STT intraday: 0.025% on sell leg only
    expect(b.stt).toBeCloseTo(2.525, 6);
    expect(b.exchange).toBeCloseTo(0.0000307 * 20100, 6); // 0.61707
    expect(b.sebi).toBeCloseTo(0.000001 * 20100, 6);
    // Stamp: 0.003% on buy leg
    expect(b.stamp).toBeCloseTo(0.3, 6);
    expect(b.gst).toBeCloseTo(0.18 * (20.1 + 0.61707 + 0.0201), 6); // 3.7326906
    expect(b.total).toBeCloseTo(27.2948606, 6);
    expect(computeTradeCosts({ ...base, intraday: true })).toBeCloseTo(27.2948606, 6);
  });

  it("hand-computed delivery long example (STT both legs, stamp 0.015%)", () => {
    const b = breakdownTradeCosts({ ...base, intraday: false });
    expect(b.brokerage).toBeCloseTo(20.1, 6);
    expect(b.stt).toBeCloseTo(0.001 * 20100, 6); // 20.1
    expect(b.stamp).toBeCloseTo(0.00015 * 10000, 6); // 1.5
    expect(b.total).toBeCloseTo(46.0698606, 6);
    expect(computeTradeCosts({ ...base, intraday: false })).toBeGreaterThan(
      computeTradeCosts({ ...base, intraday: true }),
    );
  });

  it("short trade: entry is the sell leg, exit is the buy leg", () => {
    const b = breakdownTradeCosts({ ...base, side: "short", intraday: true });
    expect(b.sellTurnover).toBe(10000);
    expect(b.buyTurnover).toBe(10100);
    expect(b.stt).toBeCloseTo(0.00025 * 10000, 6);
    expect(b.stamp).toBeCloseTo(0.00003 * 10100, 6);
    expect(b.total).toBeCloseTo(27.2728606, 6);
  });

  it("brokerage is flat ₹20 per leg when 0.1% of turnover exceeds it", () => {
    const b = breakdownTradeCosts({
      side: "long",
      entryPrice: 1000,
      exitPrice: 1000,
      qty: 100, // turnover 1,00,000 per leg -> 0.1% = 100 > 20
      model: DEFAULT_COSTS,
      intraday: true,
    });
    expect(b.brokerage).toBe(40);
  });

  it("brokerage is the percentage when it is below the flat fee, and follows the model's rate", () => {
    const args = { side: "long" as const, entryPrice: 50, exitPrice: 50, qty: 100, intraday: true }; // 5,000 per leg
    expect(breakdownTradeCosts({ ...args, model: DEFAULT_COSTS }).brokerage).toBeCloseTo(10, 10); // 2 x 0.1% x 5000
    expect(breakdownTradeCosts({ ...args, model: { ...DEFAULT_COSTS, brokerageRate: 0.0005 } }).brokerage).toBeCloseTo(5, 10);
    expect(breakdownTradeCosts({ ...args, model: { ...DEFAULT_COSTS, brokeragePerOrder: 2 } }).brokerage).toBe(4);
  });

  it("reproduces the Upstox brokerage calculator example (intraday buy 100 @ 500, sell @ 520)", () => {
    const b = breakdownTradeCosts({
      side: "long",
      entryPrice: 500,
      exitPrice: 520,
      qty: 100,
      model: DEFAULT_COSTS,
      intraday: true,
    });
    expect(b.brokerage).toBeCloseTo(40, 2); // Rs 20 x 2 (0.1% would be 50 and 52)
    expect(b.stt).toBeCloseTo(13, 2); // 0.025% x 52,000
    expect(b.stamp).toBeCloseTo(1.5, 2); // 0.003% x 50,000
    // Upstox shows ~Rs 66 in total; their exchange line uses a slightly different rate.
    expect(Math.abs(b.total - 66)).toBeLessThanOrEqual(1.5);
    // Our own figure: 40 + 13 + 3.1314 + 0.102 + 1.5 + 0.18 x 43.2334
    expect(b.total).toBeCloseTo(65.515412, 6);
  });
});
