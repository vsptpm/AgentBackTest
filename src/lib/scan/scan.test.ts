import { describe, expect, it } from "vitest";
import type { Candle, Strategy } from "@/lib/types";
import { isMarketOpen, realTarget, scanSymbolWith } from "./index";

const STEP = 5 * 60_000;
// 09:15 IST = 03:45 UTC. 2026-11-10 is a Tuesday, 11th a Wednesday.
const day1 = Date.UTC(2026, 10, 10, 3, 45);
const day2 = Date.UTC(2026, 10, 11, 3, 45);

function bars(start: number, n: number, price: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: start + i * STEP,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 1000,
  }));
}

/** Enters long on the bar whose time is `at`, stop 2% below, target 4% above (or as given). */
function fake(at: number, stopFrac = 0.02, targetFrac = 0.04): Strategy {
  return {
    id: "fake",
    name: "Fake",
    description: "",
    intervals: ["5m"],
    params: [],
    warmup: 0,
    onBar(ctx) {
      const c = ctx.candles[ctx.index];
      if (c.time !== at || ctx.position) return null;
      return { action: "enter", side: "long", stop: c.close * (1 - stopFrac), target: c.close * (1 + targetFrac) };
    },
  };
}

const base = { symbol: "X.NS", interval: "5m" as const, capital: 100_000, riskPerTrade: 0.01 };

describe("scanSymbolWith", () => {
  // Day 1: full session at 100. Day 2: 10 bars at 110 (09:15..10:00).
  const candles = [...bars(day1, 75, 100), ...bars(day2, 10, 110)];
  const last = candles[candles.length - 1];
  const now = last.time + STEP + 1000;

  it("flags a signal on the last completed bar as fresh, priced at the last close", () => {
    const r = scanSymbolWith({ ...base, candles, strategies: [fake(last.time)], now })!;
    expect(r.lastBarTime).toBe(last.time);
    expect(r.lastPrice).toBe(110);
    expect(r.dayChangePct).toBeCloseTo(10, 6);
    expect(r.stale).toBe(false);
    const o = r.strategies[0].open!;
    expect(o).not.toBeNull();
    expect(o.fresh).toBe(true);
    expect(o.side).toBe("long");
    expect(o.entryTime).toBe(last.time);
    expect(o.entryPrice).toBe(110);
    expect(o.unrealisedPnl).toBe(0);
    expect(o.qty).toBeGreaterThan(0);
    expect(o.stopDistPct).toBeCloseTo(2, 6);
    expect(o.targetDistPct).toBeCloseTo(4, 6);
    expect(r.strategies[0].recent.trades).toBe(0);
    // Honest signal data: the bar closed 1 s before `now`, nothing has moved yet.
    expect(o.signalAgeSec).toBe(1);
    expect(o.movedR).toBe(0);
    expect(o.stopPct).toBeCloseTo(2, 6);
    expect(o.exitRule).toBe("target");
    expect(o.target).toBeCloseTo(114.4, 6);
  });

  it("reports an earlier fill as an open (not fresh) position", () => {
    const r = scanSymbolWith({ ...base, candles, strategies: [fake(day2 + 2 * STEP)], now })!;
    const o = r.strategies[0].open!;
    expect(o.fresh).toBe(false);
    expect(o.entryTime).toBe(day2 + 3 * STEP);
    expect(r.strategies[0].closedToday).toHaveLength(0);
    // Filled at 110 + 0.05% slippage = 110.055 against a stop at 107.8; last close is 110.
    const dist = 110.055 - 107.8;
    expect(o.entryPrice).toBeCloseTo(110.055, 6);
    expect(o.movedR).toBeCloseTo((110 - 110.055) / dist, 6);
    expect(o.stopPct).toBeCloseTo((dist / 110.055) * 100, 6);
    // Fill bar 09:30, `now` = 10:05:01.
    expect(o.signalAgeSec).toBe(7 * 300 + 1);
    expect(o.exitRule).toBe("target");
  });

  it("calls a far-away sanity cap 'no fixed target': the strategy exits on its own signal", () => {
    // Stop 2% away, "target" 10% away = 5 stop distances.
    const r = scanSymbolWith({ ...base, candles, strategies: [fake(last.time, 0.02, 0.1)], now })!;
    const o = r.strategies[0].open!;
    expect(o.target).toBeUndefined();
    expect(o.targetDistPct).toBeUndefined();
    expect(o.exitRule).toBe("signal");
  });

  it("only takes entries inside the entry window", () => {
    // Signal on the 09:15 bar would fill at 09:20, before 09:30: dropped.
    const early = scanSymbolWith({ ...base, candles, strategies: [fake(day2)], now })!;
    expect(early.strategies[0].open).toBeNull();
    // Signal on the 14:40 bar would fill at 14:45: dropped. 14:35 → fills 14:40: kept.
    const late = [...bars(day1, 75, 100), ...bars(day2, 66, 110)]; // last bar 14:40
    const end = late[late.length - 1];
    const a = scanSymbolWith({ ...base, candles: late, strategies: [fake(end.time)], now: end.time + STEP + 1 })!;
    expect(a.strategies[0].open).toBeNull();
    const b = scanSymbolWith({ ...base, candles: late, strategies: [fake(end.time - STEP)], now: end.time + STEP + 1 })!;
    expect(b.strategies[0].open).not.toBeNull();
  });

  it("lets margin raise the position cap, not the risk", () => {
    // Stop 0.5% away (110.055 fill, 109.45 stop): the risk limit allows more shares than the cash buys.
    const one = scanSymbolWith({ ...base, candles, strategies: [fake(last.time, 0.005, 0.01)], now })!;
    expect(one.strategies[0].open!.qty).toBe(Math.floor(100_000 / 110.055)); // 908: all the cash
    const five = scanSymbolWith({ ...base, leverage: 5, candles, strategies: [fake(last.time, 0.005, 0.01)], now })!;
    const qty5 = five.strategies[0].open!.qty;
    expect(qty5).toBeGreaterThan(908);
    expect(qty5).toBeLessThanOrEqual(Math.floor(500_000 / 110.055));
    expect(qty5 * (110.055 - 109.45)).toBeLessThanOrEqual(1000); // still at most 1% at the stop
  });

  it("ignores a still-forming last bar", () => {
    const r = scanSymbolWith({ ...base, candles, strategies: [fake(last.time)], now: last.time + 60_000 })!;
    expect(r.lastBarTime).toBe(last.time - STEP);
    expect(r.strategies[0].open).toBeNull();
  });

  it("does not surface fresh signals at/after square-off or on a stale day", () => {
    const full = [...bars(day1, 75, 100), ...bars(day2, 75, 110)];
    const end = full[full.length - 1];
    const a = scanSymbolWith({ ...base, candles: full, strategies: [fake(end.time)], now: end.time + STEP + 1 })!;
    expect(a.strategies[0].open).toBeNull();

    const b = scanSymbolWith({ ...base, candles, strategies: [fake(last.time)], now: now + 3 * 24 * 3600_000 })!;
    expect(b.stale).toBe(true);
    expect(b.strategies[0].open).toBeNull();
  });

  it("lists trades closed today and skips strategies that do not support the interval", () => {
    // Day-1 entry gets squared off; day-2 has no trade.
    const r = scanSymbolWith({ ...base, candles, strategies: [fake(day1 + 5 * STEP), { ...fake(0), intervals: ["1d"] }], now })!;
    expect(r.strategies).toHaveLength(1);
    expect(r.strategies[0].closedToday).toHaveLength(0);
    expect(r.strategies[0].recent.trades).toBe(1);
    // Pooling data: one finished trade with a stop. Flat price, so it lost slippage and charges only.
    const rec = r.strategies[0].recent;
    expect(rec.nR).toBe(1);
    expect(rec.netPnl).toBeLessThan(0);
    expect(rec.sumR).toBeLessThan(0);
    expect(rec.sumR).toBeGreaterThan(-0.5);
    // Trades without a stop have no risk to measure against: counted in trades, not in nR.
    const noStop: Strategy = {
      ...fake(0),
      onBar(ctx) {
        return ctx.candles[ctx.index].time === day1 + 5 * STEP && !ctx.position ? { action: "enter", side: "long" } : null;
      },
    };
    const n = scanSymbolWith({ ...base, candles, strategies: [noStop], now })!.strategies[0].recent;
    expect(n.trades).toBe(1);
    expect(n.nR).toBe(0);
    expect(n.sumR).toBe(0);
    expect(scanSymbolWith({ ...base, candles: [], strategies: [], now })).toBeNull();
  });
});

describe("isMarketOpen", () => {
  it("is open Mon–Fri 09:15–15:30 IST only", () => {
    expect(isMarketOpen(day2)).toBe(true);
    expect(isMarketOpen(day2 - 60_000)).toBe(false);
    expect(isMarketOpen(Date.UTC(2026, 10, 11, 10, 0))).toBe(false); // 15:30 IST
    expect(isMarketOpen(Date.UTC(2026, 10, 14, 5, 0))).toBe(false); // Saturday
  });
});

describe("realTarget", () => {
  it("drops a target further than 3.5 stop distances from entry", () => {
    expect(realTarget(106, 100, 98)).toBe(106); // 3 stop distances
    expect(realTarget(107, 100, 98)).toBe(107); // exactly 3.5: still a target
    expect(realTarget(110, 100, 98)).toBeUndefined(); // 5: a sanity cap, not a target
    expect(realTarget(93.5, 100, 102)).toBe(93.5); // shorts
    expect(realTarget(92, 100, 102)).toBeUndefined();
    expect(realTarget(110, 100)).toBe(110); // no stop: only the placeholder rule applies
  });

  it("keeps a normal target and drops far-away placeholders", () => {
    expect(realTarget(287, 284.3)).toBe(287);
    expect(realTarget(1e9, 284.3)).toBeUndefined(); // "no target" placeholder for longs
    expect(realTarget(0, 284.3)).toBeUndefined(); // placeholder for shorts
    expect(realTarget(undefined, 284.3)).toBeUndefined();
  });
});
