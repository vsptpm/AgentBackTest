import { describe, expect, it } from "vitest";
import type { BacktestConfig, Candle, CostModel, EquityPoint, Signal, Strategy, Trade } from "@/lib/types";
import { IST_OFFSET_MS } from "@/lib/types";
import { computeTradeCosts } from "./costs";
import { runBacktest } from "./engine";
import { computeMetrics, computeMonthly, maxConsecutive } from "./metrics";

// ---------- helpers ----------

const DAY_MS = 24 * 60 * 60 * 1000;
/** 2024-01-01 09:15 IST */
const DAY0 = Date.UTC(2024, 0, 1, 3, 45);

const ZERO_COSTS: CostModel = {
  brokeragePerOrder: 0,
  brokerageRate: 0,
  sttRate: 0,
  exchangeRate: 0,
  sebiRate: 0,
  stampRate: 0,
  gstRate: 0,
  slippage: 0,
};

type OHLC = [number, number, number, number];

function dailyCandles(rows: OHLC[]): Candle[] {
  return rows.map(([open, high, low, close], i) => ({
    time: DAY0 + i * DAY_MS,
    open,
    high,
    low,
    close,
    volume: 1000,
  }));
}

/** Epoch ms for an IST wall-clock time. */
function ist(y: number, m: number, d: number, hh: number, mm: number): number {
  return Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MS;
}

/** 15m bars 09:15..15:15 inclusive (25 bars) for one IST day, flat at `price`. */
function intradayDay(y: number, m: number, d: number, price = 100): Candle[] {
  const out: Candle[] = [];
  for (let k = 0; k < 25; k++) {
    const minutes = 9 * 60 + 15 + k * 15;
    const time = ist(y, m, d, Math.floor(minutes / 60), minutes % 60);
    out.push({ time, open: price, high: price + 1, low: price - 1, close: price, volume: 100 });
  }
  return out;
}

function scripted(signals: Record<number, Signal>, warmup = 0): Strategy & { seen: number[] } {
  const seen: number[] = [];
  return {
    id: "scripted",
    name: "Scripted",
    description: "test",
    intervals: ["1d", "15m", "5m"],
    params: [],
    warmup,
    seen,
    onBar(ctx) {
      seen.push(ctx.index);
      return signals[ctx.index] ?? null;
    },
  };
}

function config(overrides: Partial<BacktestConfig> = {}, costs: Partial<CostModel> = {}): BacktestConfig {
  return {
    symbol: "TEST.NS",
    interval: "1d",
    from: "2024-01-01",
    to: "2024-12-31",
    strategyId: "scripted",
    params: {},
    capital: 100_000,
    riskPerTrade: 0.01,
    positionFraction: 0.5,
    squareOffTime: "15:15",
    costs: { ...ZERO_COSTS, ...costs },
    allowShort: true,
    ...overrides,
  };
}

// ---------- fills ----------

describe("runBacktest fills", () => {
  it("fills an entry on the next bar's open with adverse slippage and closes at end of data", () => {
    const candles = dailyCandles([
      [100, 105, 95, 102],
      [100, 105, 95, 102],
      [110, 112, 108, 111],
      [111, 115, 109, 114],
    ]);
    const res = runBacktest(config({}, { slippage: 0.001 }), candles, scripted({ 1: { action: "enter", side: "long" } }));

    expect(res.trades).toHaveLength(1);
    const t = res.trades[0];
    expect(t.entryTime).toBe(candles[2].time);
    expect(t.entryPrice).toBeCloseTo(110 * 1.001, 10);
    // positionFraction sizing: floor(50000 / 110.11)
    expect(t.qty).toBe(Math.floor(50_000 / (110 * 1.001)));
    expect(t.exitReason).toBe("end");
    expect(t.exitTime).toBe(candles[3].time);
    // End-of-data exit takes plain adverse slippage too.
    expect(t.exitPrice).toBeCloseTo(114 * 0.999, 10);
    expect(t.barsHeld).toBe(1);
    expect(Number.isNaN(t.rMultiple)).toBe(true);
    expect(t.grossPnl).toBeCloseTo((114 * 0.999 - 110 * 1.001) * t.qty, 8);

    expect(res.equity).toHaveLength(4);
    expect(res.equity[3].equity).toBeCloseTo(100_000 + t.netPnl, 8);
    expect(res.period).toEqual({ from: candles[0].time, to: candles[3].time, bars: 4 });
  });

  it("drops a signal on the last bar", () => {
    const candles = dailyCandles([
      [100, 105, 95, 102],
      [100, 105, 95, 102],
    ]);
    const res = runBacktest(config(), candles, scripted({ 1: { action: "enter", side: "long" } }));
    expect(res.trades).toHaveLength(0);
  });

  it("exits at the stop when the bar's low touches it (intrabar)", () => {
    const candles = dailyCandles([
      [100, 105, 95, 102],
      [100, 105, 98, 102],
      [99, 101, 94, 96],
      [96, 97, 95, 96],
    ]);
    const res = runBacktest(config(), candles, scripted({ 0: { action: "enter", side: "long", stop: 95 } }));
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0];
    expect(t.entryPrice).toBe(100);
    // Delivery STT (0.1% both legs) and stamp (0.015% buy leg) are hard-coded, so costs > 0 even with a zero model.
    // Sizing: qty0 = floor(1000 / 5) = 200, costs(200) = 42 -> 0.21 / share, qty = floor(1000 / 5.21) = 191.
    expect(t.qty).toBe(191);
    expect(t.exitReason).toBe("stop");
    expect(t.exitPrice).toBe(95);
    expect(t.exitTime).toBe(candles[2].time);
    expect(t.grossPnl).toBe(-955);
    expect(t.costs).toBeCloseTo(0.001 * (19_100 + 18_145) + 0.00015 * 19_100, 8); // 40.11
    expect(t.netPnl).toBeCloseTo(-995.11, 8);
    // The stated 1% risk (1000) is now honoured net of charges.
    expect(-t.netPnl).toBeLessThanOrEqual(1000);
    expect(t.rMultiple).toBeCloseTo(t.netPnl / 955, 10);
    expect(t.mae).toBeCloseTo(0.06, 10); // low 94
    expect(t.mfe).toBeCloseTo(0.05, 10); // high 105 on entry bar
    expect(t.barsHeld).toBe(1);
  });

  it("fills at the open when a bar gaps through the stop", () => {
    const candles = dailyCandles([
      [100, 105, 95, 102],
      [100, 105, 98, 102],
      [90, 92, 88, 91],
    ]);
    const res = runBacktest(
      config({}, { slippage: 0.001 }),
      candles,
      scripted({ 0: { action: "enter", side: "long", stop: 95 } }),
    );
    expect(res.trades[0].exitReason).toBe("stop");
    // Stop exits take stopSlippage, default 2 x slippage.
    expect(res.trades[0].exitPrice).toBeCloseTo(90 * 0.998, 10);
  });

  it("assumes the stop when stop and target are both hit in one bar", () => {
    const candles = dailyCandles([
      [100, 105, 95, 102],
      [100, 102, 99, 101],
      [100, 110, 94, 105],
    ]);
    const res = runBacktest(
      config(),
      candles,
      scripted({ 0: { action: "enter", side: "long", stop: 95, target: 105 } }),
    );
    expect(res.trades[0].exitReason).toBe("stop");
    expect(res.trades[0].exitPrice).toBe(95);
  });

  it("exits at the target when hit", () => {
    const candles = dailyCandles([
      [100, 105, 95, 102],
      [100, 102, 99, 101],
      [100, 106, 98, 105],
      [105, 106, 104, 105],
    ]);
    const res = runBacktest(
      config({}, { slippage: 0.001 }),
      candles,
      scripted({ 0: { action: "enter", side: "long", stop: 95, target: 105 } }),
    );
    const t = res.trades[0];
    expect(t.exitReason).toBe("target");
    expect(t.exitPrice).toBeCloseTo(105 * 0.999, 10);
    expect(t.exitTime).toBe(candles[2].time);
  });

  it("exit signal fills on the next bar's open", () => {
    const candles = dailyCandles([
      [100, 105, 95, 102],
      [100, 105, 98, 102],
      [101, 103, 99, 102],
      [104, 106, 103, 105],
      [105, 106, 103, 104],
    ]);
    const res = runBacktest(
      config({}, { slippage: 0.001 }),
      candles,
      scripted({ 0: { action: "enter", side: "long" }, 2: { action: "exit", side: "long" } }),
    );
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0];
    expect(t.exitReason).toBe("signal");
    expect(t.exitTime).toBe(candles[3].time);
    expect(t.exitPrice).toBeCloseTo(104 * 0.999, 10);
    expect(t.barsHeld).toBe(2);
  });

  it("ignores enter while in position and exit while flat", () => {
    const candles = dailyCandles([
      [100, 105, 95, 102],
      [100, 105, 98, 102],
      [101, 103, 99, 102],
      [104, 106, 103, 105],
    ]);
    const res = runBacktest(
      config(),
      candles,
      scripted({
        0: { action: "exit", side: "long" }, // flat: ignored
        1: { action: "enter", side: "long" },
        2: { action: "enter", side: "long" }, // in position: ignored
      }),
    );
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0].entryTime).toBe(candles[2].time);
  });

  it("handles shorts (mirrored fills) and respects allowShort", () => {
    const candles = dailyCandles([
      [100, 105, 95, 102],
      [100, 102, 98, 101],
      [100, 102, 94, 95],
      [95, 96, 94, 95],
    ]);
    const sig = { 0: { action: "enter", side: "short", stop: 105, target: 95 } as Signal };
    const res = runBacktest(config({}, { slippage: 0.001 }), candles, scripted(sig));
    const t = res.trades[0];
    expect(t.side).toBe("short");
    expect(t.entryPrice).toBeCloseTo(100 * 0.999, 10);
    expect(t.exitReason).toBe("target");
    expect(t.exitPrice).toBeCloseTo(95 * 1.001, 10);
    expect(t.grossPnl).toBeGreaterThan(0);

    const blocked = runBacktest(config({ allowShort: false }), candles, scripted(sig));
    expect(blocked.trades).toHaveLength(0);
    expect(blocked.warnings.some((w) => /allowShort/.test(w))).toBe(true);
  });
});

// ---------- sizing ----------

describe("runBacktest position sizing", () => {
  const candles = dailyCandles([
    [100, 105, 95, 102],
    [100, 105, 98, 102],
    [101, 103, 99, 102],
  ]);

  it("sizes by risk when a stop is given", () => {
    const res = runBacktest(
      config({ capital: 200_000, riskPerTrade: 0.02 }),
      candles,
      scripted({ 0: { action: "enter", side: "long", stop: 98 } }),
    );
    // qty0 = 4000 / 2 = 2000; delivery costs(2000, 100 -> 98) = 396 + 30 = 426 -> 0.213 / share;
    // qty = floor(4000 / 2.213) = 1807.
    expect(res.trades[0].qty).toBe(1807);
  });

  it("caps qty so position value never exceeds capital", () => {
    const res = runBacktest(
      config({ capital: 10_000, riskPerTrade: 0.5 }),
      candles,
      scripted({ 0: { action: "enter", side: "long", stop: 99.5 } }),
    );
    expect(res.trades[0].qty).toBe(100); // raw 6997 (5000 / 0.7145), capped to floor(10000 / 100)
  });

  it("skips the entry and warns when qty < 1", () => {
    const res = runBacktest(config({ capital: 50 }), candles, scripted({ 0: { action: "enter", side: "long" } }));
    expect(res.trades).toHaveLength(0);
    expect(res.warnings.some((w) => /too small/i.test(w))).toBe(true);
  });

  it("skips the entry and warns when the stop is on the wrong side", () => {
    const res = runBacktest(config(), candles, scripted({ 0: { action: "enter", side: "long", stop: 105 } }));
    expect(res.trades).toHaveLength(0);
    expect(res.warnings.some((w) => /wrong side/i.test(w))).toBe(true);
  });

  it("dedupes identical warnings", () => {
    const flat = dailyCandles([
      [100, 105, 95, 102],
      [100, 105, 98, 102],
      [100, 103, 99, 102],
      [100, 103, 99, 102],
    ]);
    const res = runBacktest(
      config({ capital: 50 }),
      flat,
      scripted({ 0: { action: "enter", side: "long" }, 1: { action: "enter", side: "long" } }),
    );
    expect(res.warnings).toHaveLength(1);
  });
});

// ---------- warmup ----------

describe("runBacktest warmup", () => {
  it("starts calling onBar at warmup and builds equity/period from there", () => {
    const candles = dailyCandles([
      [100, 105, 95, 102],
      [100, 105, 95, 102],
      [100, 105, 95, 102],
      [100, 105, 95, 102],
      [100, 105, 95, 102],
    ]);
    const strat = scripted({}, 2);
    const res = runBacktest(config(), candles, strat);
    expect(strat.seen).toEqual([2, 3, 4]);
    expect(res.equity).toHaveLength(3);
    expect(res.period).toEqual({ from: candles[2].time, to: candles[4].time, bars: 3 });
  });

  it("returns an empty result with a warning when there are not enough bars", () => {
    const candles = dailyCandles([[100, 105, 95, 102]]);
    const res = runBacktest(config(), candles, scripted({}, 5));
    expect(res.trades).toHaveLength(0);
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});

// ---------- intraday square-off ----------

describe("runBacktest intraday square-off", () => {
  const candles = [...intradayDay(2024, 1, 1), ...intradayDay(2024, 1, 2)];

  it("squares off at the open of the 15:15 IST bar and blocks entries for the rest of the day", () => {
    const res = runBacktest(
      config({ interval: "15m" }, { slippage: 0.001 }),
      candles,
      scripted({
        0: { action: "enter", side: "long" }, // fills 09:30 day 1
        24: { action: "enter", side: "long" }, // 15:15 day 1: last bar of day -> dropped
        25: { action: "enter", side: "long" }, // 09:15 day 2 -> fills 09:30 day 2
      }),
    );
    expect(res.trades).toHaveLength(2);
    const [t1, t2] = res.trades;
    expect(t1.entryTime).toBe(ist(2024, 1, 1, 9, 30));
    expect(t1.exitReason).toBe("squareoff");
    expect(t1.exitTime).toBe(ist(2024, 1, 1, 15, 15));
    expect(t1.exitPrice).toBeCloseTo(100 * 0.999, 10);
    expect(t2.entryTime).toBe(ist(2024, 1, 2, 9, 30));
    expect(t2.exitReason).toBe("squareoff");
    expect(t2.exitTime).toBe(ist(2024, 1, 2, 15, 15));
  });

  it("closes at end of data when the data ends before square-off time", () => {
    const partial = intradayDay(2024, 1, 1).slice(0, 10); // 09:15 .. 11:30
    const res = runBacktest(config({ interval: "15m" }), partial, scripted({ 0: { action: "enter", side: "long" } }));
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0].exitReason).toBe("end");
  });

  it("drops an entry whose fill bar is at or past square-off time", () => {
    const res = runBacktest(
      config({ interval: "15m" }),
      candles,
      scripted({ 23: { action: "enter", side: "long" } }), // fill would be 15:15 bar
    );
    expect(res.trades).toHaveLength(0);
  });

  it("does not square off on daily bars", () => {
    const daily = dailyCandles([
      [100, 105, 95, 102],
      [100, 105, 98, 102],
      [101, 103, 99, 102],
    ]);
    const res = runBacktest(config({ interval: "1d" }), daily, scripted({ 0: { action: "enter", side: "long" } }));
    expect(res.trades[0].exitReason).toBe("end");
  });
});

// ---------- intraday risk controls ----------

describe("runBacktest risk controls", () => {
  const enter: Signal = { action: "enter", side: "long" };
  const exit: Signal = { action: "exit", side: "long" };

  it("entryStart / entryEnd drop entries whose fill bar is outside the window, without blocking the day", () => {
    const candles = intradayDay(2024, 1, 1);
    const res = runBacktest(
      config({ interval: "15m", entryStart: "09:45", entryEnd: "10:15" }),
      candles,
      scripted({
        0: enter, // fill 09:30 < entryStart -> dropped
        1: enter, // fill 09:45 -> taken
        2: exit, // exit at 10:00
        3: enter, // fill 10:15 >= entryEnd -> dropped
        5: enter, // fill 10:45 -> dropped
      }),
    );
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0].entryTime).toBe(ist(2024, 1, 1, 9, 45));
    expect(res.trades[0].exitTime).toBe(ist(2024, 1, 1, 10, 0));

    // A dropped early entry must not block a later one in the window.
    const res2 = runBacktest(
      config({ interval: "15m", entryStart: "09:45" }),
      candles,
      scripted({ 0: enter, 4: enter }),
    );
    expect(res2.trades).toHaveLength(1);
    expect(res2.trades[0].entryTime).toBe(ist(2024, 1, 1, 10, 30));
  });

  it("intraday-only controls are ignored on daily bars", () => {
    const daily = dailyCandles([
      [100, 105, 95, 102],
      [100, 105, 98, 102],
      [101, 103, 99, 102],
    ]);
    const res = runBacktest(
      config({ entryStart: "10:00", entryEnd: "10:01", maxTradesPerDay: 1, maxDailyLoss: 0.0001 }),
      daily,
      scripted({ 0: enter }),
    );
    expect(res.trades).toHaveLength(1);
  });

  it("maxTradesPerDay caps entries per IST day and resets the next day", () => {
    const candles = [...intradayDay(2024, 1, 1), ...intradayDay(2024, 1, 2)];
    const signals: Record<number, Signal> = {
      0: enter, 2: exit, // trade 1, day 1
      4: enter, 6: exit, // trade 2, day 1
      8: enter, 10: exit, // dropped (limit 2)
      25: enter, 27: exit, // day 2: allowed again
    };
    const res = runBacktest(config({ interval: "15m", maxTradesPerDay: 2 }), candles, scripted(signals));
    expect(res.trades.map((t) => t.entryTime)).toEqual([
      ist(2024, 1, 1, 9, 30),
      ist(2024, 1, 1, 10, 30),
      ist(2024, 1, 2, 9, 30),
    ]);

    const unlimited = runBacktest(config({ interval: "15m", maxTradesPerDay: 0 }), candles, scripted(signals));
    expect(unlimited.trades).toHaveLength(4);
  });

  it("maxDailyLoss stops new entries for the day once realised loss reaches the limit", () => {
    const day1 = intradayDay(2024, 1, 1);
    // Bar 2 (09:45) drops through the stop at 98.
    day1[2] = { ...day1[2], low: 97 };
    const candles = [...day1, ...intradayDay(2024, 1, 2)];
    const signals: Record<number, Signal> = {
      0: { action: "enter", side: "long", stop: 98 }, // fill 09:30 @100, qty 500, stopped 09:45: -1000
      4: enter, // dropped when limit is 1%
      25: enter, // next day: allowed
    };
    const res = runBacktest(config({ interval: "15m", maxDailyLoss: 0.01 }), candles, scripted(signals));
    expect(res.trades).toHaveLength(2);
    expect(res.trades[0].exitReason).toBe("stop");
    expect(res.trades[0].netPnl).toBeLessThanOrEqual(-1000);
    expect(res.trades[1].entryTime).toBe(ist(2024, 1, 2, 9, 30));

    // Limit not reached -> the second day-1 entry is taken.
    const loose = runBacktest(config({ interval: "15m", maxDailyLoss: 0.05 }), candles, scripted(signals));
    expect(loose.trades).toHaveLength(3);
    expect(loose.trades[1].entryTime).toBe(ist(2024, 1, 1, 10, 30));
  });

  it("leverage raises the affordability cap; invalid values behave as 1", () => {
    const candles = dailyCandles([
      [100, 105, 95, 102],
      [100, 105, 98, 102],
      [101, 103, 99, 102],
    ]);
    const sig = { 0: { action: "enter", side: "long", stop: 99.5 } as Signal };
    const base = { capital: 10_000, riskPerTrade: 0.5 }; // raw qty 6997
    expect(runBacktest(config(base), candles, scripted(sig)).trades[0].qty).toBe(100);
    expect(runBacktest(config({ ...base, leverage: 5 }), candles, scripted(sig)).trades[0].qty).toBe(500);
    expect(runBacktest(config({ ...base, leverage: 0.2 }), candles, scripted(sig)).trades[0].qty).toBe(100);
    expect(runBacktest(config({ ...base, leverage: NaN }), candles, scripted(sig)).trades[0].qty).toBe(100);
  });

  it("breakevenAtR moves the stop to entry from the next bar and keeps the initial stop/risk on the trade", () => {
    const candles = dailyCandles([
      [100, 101, 99, 100], // signal
      [100, 101, 99, 100], // fill @100, stop 95 (risk 5)
      [100, 106, 99, 104], // high 106 >= 100 + 1R -> stop moves to 100 for the next bar
      [104, 105, 99, 101], // low 99 <= 100 -> stopped at breakeven
      [101, 102, 100, 101],
    ]);
    const sig = { 0: { action: "enter", side: "long", stop: 95 } as Signal };

    const res = runBacktest(config({ breakevenAtR: 1 }), candles, scripted(sig));
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0];
    expect(t.exitReason).toBe("stop");
    expect(t.exitPrice).toBe(100);
    expect(t.exitTime).toBe(candles[3].time);
    expect(t.grossPnl).toBe(0);
    expect(t.stop).toBe(95); // initial stop reported
    expect(t.rMultiple).toBeCloseTo(t.netPnl / (t.qty * 5), 10); // initial risk

    // Off: the same path is still open at the end.
    const off = runBacktest(config(), candles, scripted(sig));
    expect(off.trades[0].exitReason).toBe("end");
  });

  it("breakevenAtR never acts inside the trigger bar or on the fill bar", () => {
    // Trigger bar: high 106 reaches +1R and low 99.5 is below entry, but the stop is still 95 on that bar.
    const sameBar = dailyCandles([
      [100, 101, 99, 100],
      [100, 101, 99, 100], // fill
      [100, 106, 99.5, 104],
      [104, 105, 101, 104],
    ]);
    const sig = { 0: { action: "enter", side: "long", stop: 95 } as Signal };
    const res = runBacktest(config({ breakevenAtR: 1 }), sameBar, scripted(sig));
    expect(res.trades[0].exitReason).toBe("end");

    // Fill bar reaches +1R: not armed, so a later dip to entry does not stop out.
    const fillBar = dailyCandles([
      [100, 101, 99, 100],
      [100, 106, 99, 100], // fill, high 106
      [100, 101, 99, 100], // would stop at 100 if armed
      [100, 101, 99.5, 100],
    ]);
    const res2 = runBacktest(config({ breakevenAtR: 1 }), fillBar, scripted(sig));
    expect(res2.trades[0].exitReason).toBe("end");
  });

  it("breakevenAtR works for shorts", () => {
    const candles = dailyCandles([
      [100, 101, 99, 100],
      [100, 101, 99, 100], // fill short @100, stop 105
      [100, 101, 94, 96], // low 94 <= 100 - 1R
      [96, 100.5, 95, 99], // high >= 100 -> stopped at entry
      [99, 100, 98, 99],
    ]);
    const res = runBacktest(
      config({ breakevenAtR: 1 }),
      candles,
      scripted({ 0: { action: "enter", side: "short", stop: 105 } }),
    );
    const t = res.trades[0];
    expect(t.exitReason).toBe("stop");
    expect(t.exitPrice).toBe(100);
    expect(t.stop).toBe(105);
  });
});

// ---------- realism: overnight carry, stop slippage, friction-aware sizing, friction gate ----------

describe("runBacktest realism", () => {
  /** Upstox-like intraday model with round numbers for hand-checking. */
  const REAL_COSTS: Partial<CostModel> = {
    brokeragePerOrder: 20,
    brokerageRate: 0.001,
    sttRate: 0.00025,
    exchangeRate: 0.0000307,
    sebiRate: 0.000001,
    stampRate: 0.00003,
    gstRate: 0.18,
    slippage: 0.0005,
  };

  it("closes an intraday position at the last bar of the day when the data has no square-off bar", () => {
    // Day 1 ends at 11:30 (bars 0..9), long before squareOffTime; day 2 is complete.
    const day1 = intradayDay(2024, 1, 1).slice(0, 10);
    day1[9] = { ...day1[9], close: 102, high: 103 };
    const candles = [...day1, ...intradayDay(2024, 1, 2, 110)];
    const res = runBacktest(
      config({ interval: "15m" }, { slippage: 0.001 }),
      candles,
      scripted({ 0: { action: "enter", side: "long" }, 9: { action: "exit", side: "long" } }),
    );
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0];
    expect(t.entryTime).toBe(ist(2024, 1, 1, 9, 30));
    expect(t.exitReason).toBe("squareoff");
    expect(t.exitTime).toBe(ist(2024, 1, 1, 11, 30)); // bar 9, not the next morning's gap to 110
    expect(t.exitPrice).toBeCloseTo(102 * 0.999, 10);
    expect(t.barsHeld).toBe(8);
    expect(res.warnings).toContain("Position carried past the session end; closed at the last bar of the day.");
    // The day-1 closing equity point is the realised figure, and day 2 is flat.
    expect(res.equity[9].equity).toBeCloseTo(100_000 + t.netPnl, 8);
    expect(res.equity[res.equity.length - 1].equity).toBeCloseTo(100_000 + t.netPnl, 8);
  });

  it("day-boundary exit mirrors for shorts and does not apply to daily bars", () => {
    const day1 = intradayDay(2024, 1, 1).slice(0, 10);
    const candles = [...day1, ...intradayDay(2024, 1, 2, 90)];
    const res = runBacktest(
      config({ interval: "15m" }, { slippage: 0.001 }),
      candles,
      scripted({ 0: { action: "enter", side: "short" } }),
    );
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0].exitReason).toBe("squareoff");
    expect(res.trades[0].exitTime).toBe(ist(2024, 1, 1, 11, 30));
    expect(res.trades[0].exitPrice).toBeCloseTo(100 * 1.001, 10);

    const daily = dailyCandles([
      [100, 105, 95, 102],
      [100, 105, 98, 102],
      [101, 103, 99, 102],
    ]);
    const d = runBacktest(config(), daily, scripted({ 0: { action: "enter", side: "long" } }));
    expect(d.trades[0].exitReason).toBe("end");
    expect(d.warnings).toHaveLength(0);
  });

  it("stop exits use stopSlippage (default 2 x slippage); other exits keep plain slippage", () => {
    const day = intradayDay(2024, 1, 1);
    day[3] = { ...day[3], low: 97 }; // 10:00 trades through the stop at 98
    const sig = { 0: { action: "enter", side: "long", stop: 98 } as Signal };

    const dflt = runBacktest(config({ interval: "15m" }, { slippage: 0.001 }), day, scripted(sig)).trades[0];
    expect(dflt.entryPrice).toBeCloseTo(100 * 1.001, 10);
    expect(dflt.exitReason).toBe("stop");
    expect(dflt.exitPrice).toBeCloseTo(98 * 0.998, 10);

    const explicit = runBacktest(
      config({ interval: "15m" }, { slippage: 0.001, stopSlippage: 0.005 }),
      day,
      scripted(sig),
    ).trades[0];
    expect(explicit.exitPrice).toBeCloseTo(98 * 0.995, 10);

    // Short stop, at the stop level.
    const up = intradayDay(2024, 1, 1);
    up[3] = { ...up[3], high: 103 };
    const short = runBacktest(
      config({ interval: "15m" }, { slippage: 0.001 }),
      up,
      scripted({ 0: { action: "enter", side: "short", stop: 102 } }),
    ).trades[0];
    expect(short.exitReason).toBe("stop");
    expect(short.exitPrice).toBeCloseTo(102 * 1.002, 10);

    // Target and square-off exits are unaffected by stopSlippage.
    const tgt = intradayDay(2024, 1, 1);
    tgt[3] = { ...tgt[3], high: 103 };
    const target = runBacktest(
      config({ interval: "15m" }, { slippage: 0.001, stopSlippage: 0.01 }),
      tgt,
      scripted({ 0: { action: "enter", side: "long", stop: 95, target: 102 } }),
    ).trades[0];
    expect(target.exitReason).toBe("target");
    expect(target.exitPrice).toBeCloseTo(102 * 0.999, 10);

    const sq = runBacktest(
      config({ interval: "15m" }, { slippage: 0.001, stopSlippage: 0.01 }),
      intradayDay(2024, 1, 1),
      scripted({ 0: { action: "enter", side: "long" } }),
    ).trades[0];
    expect(sq.exitReason).toBe("squareoff");
    expect(sq.exitPrice).toBeCloseTo(100 * 0.999, 10);
  });

  it("sizes so that a stopped trade loses no more than the stated risk after charges and slippage", () => {
    const day = intradayDay(2024, 1, 1);
    day[3] = { ...day[3], low: 94 }; // through the stop at 95
    const cfg = config({ interval: "15m" }, REAL_COSTS); // capital 1,00,000, risk 1% = 1000
    const t = runBacktest(cfg, day, scripted({ 0: { action: "enter", side: "long", stop: 95 } })).trades[0];

    const fill = 100 * 1.0005; // 100.05
    const perShare = fill - 95 + fill * 0.001; // stop distance 5.05 + stop slippage 0.10005
    const qty0 = Math.floor(1000 / perShare);
    expect(qty0).toBe(194);
    const costs0 = computeTradeCosts({ side: "long", entryPrice: fill, exitPrice: 95, qty: qty0, model: cfg.costs, intraday: true });
    const expectedQty = Math.floor(1000 / (perShare + costs0 / qty0));
    expect(t.qty).toBe(expectedQty);
    // Legacy sizing would have been floor(1000 / 5.05) = 198 shares.
    expect(t.qty).toBeLessThan(Math.floor(1000 / (fill - 95)));

    expect(t.exitReason).toBe("stop");
    expect(t.exitPrice).toBeCloseTo(95 * 0.999, 10);
    expect(-t.netPnl).toBeLessThanOrEqual(1000);
    expect(-t.netPnl).toBeGreaterThan(985); // and not needlessly small
    expect(t.rMultiple).toBeCloseTo(t.netPnl / (t.qty * (fill - 95)), 10);
  });

  it("friction-aware sizing mirrors for shorts and still respects the leverage cap", () => {
    const day = intradayDay(2024, 1, 1);
    day[3] = { ...day[3], high: 106 };
    const cfg = config({ interval: "15m" }, REAL_COSTS);
    const t = runBacktest(cfg, day, scripted({ 0: { action: "enter", side: "short", stop: 105 } })).trades[0];
    const fill = 100 * 0.9995;
    const perShare = 105 - fill + fill * 0.001;
    const qty0 = Math.floor(1000 / perShare);
    const costs0 = computeTradeCosts({ side: "short", entryPrice: fill, exitPrice: 105, qty: qty0, model: cfg.costs, intraday: true });
    expect(t.qty).toBe(Math.floor(1000 / (perShare + costs0 / qty0)));
    expect(t.exitReason).toBe("stop");
    expect(-t.netPnl).toBeLessThanOrEqual(1000);

    // Tight stop: the risk-based qty is far above what capital can buy, so the cap decides.
    const capped = runBacktest(
      config({ interval: "15m", capital: 10_000, riskPerTrade: 0.05 }, REAL_COSTS),
      intradayDay(2024, 1, 1),
      scripted({ 0: { action: "enter", side: "long", stop: 99.5 } }),
    ).trades[0];
    expect(capped.qty).toBe(Math.floor(10_000 / (100 * 1.0005))); // 99
  });

  it("maxFrictionR skips entries whose charges and slippage eat too much of the risk, and warns once", () => {
    const candles = intradayDay(2024, 1, 1);
    const tight: Signal = { action: "enter", side: "long", stop: 99.8 }; // risk 0.25 / share vs 0.15 slippage alone
    const wide: Signal = { action: "enter", side: "long", stop: 95 };
    const exit: Signal = { action: "exit", side: "long" };
    const signals: Record<number, Signal> = { 0: tight, 2: tight, 4: wide, 6: exit };

    const gated = runBacktest(config({ interval: "15m", maxFrictionR: 0.25 }, REAL_COSTS), candles, scripted(signals));
    expect(gated.trades).toHaveLength(1);
    expect(gated.trades[0].entryTime).toBe(ist(2024, 1, 1, 10, 30));
    expect(gated.trades[0].stop).toBe(95);
    expect(gated.warnings).toEqual(["Skipped entries where charges and slippage exceed 25% of the risk."]);

    // Check the wide trade's friction by hand: it is well inside the limit.
    const q = gated.trades[0].qty;
    const fill = gated.trades[0].entryPrice;
    const charges = computeTradeCosts({ side: "long", entryPrice: fill, exitPrice: fill, qty: q, model: gated.config.costs, intraday: true });
    const frictionR = (charges + (0.0005 + 0.001) * fill * q) / (q * (fill - 95));
    expect(frictionR).toBeGreaterThan(0.05);
    expect(frictionR).toBeLessThan(0.25);

    // Off (undefined or 0): the first tight entry is taken.
    for (const maxFrictionR of [undefined, 0]) {
      const off = runBacktest(config({ interval: "15m", maxFrictionR }, REAL_COSTS), candles, scripted(signals));
      expect(off.trades[0].entryTime).toBe(ist(2024, 1, 1, 9, 30));
      expect(off.trades[0].stop).toBe(99.8);
      expect(off.warnings.some((w) => /exceed/.test(w))).toBe(false);
    }

    // A limit just under the wide trade's friction blocks it too.
    const strict = runBacktest(
      config({ interval: "15m", maxFrictionR: frictionR - 0.001 }, REAL_COSTS),
      candles,
      scripted(signals),
    );
    expect(strict.trades).toHaveLength(0);
  });

  it("maxFrictionR does not apply to entries without a stop", () => {
    const res = runBacktest(
      config({ interval: "15m", maxFrictionR: 0.0001 }, REAL_COSTS),
      intradayDay(2024, 1, 1),
      scripted({ 0: { action: "enter", side: "long" } }),
    );
    expect(res.trades).toHaveLength(1);
  });
});

// ---------- equity curve ----------

describe("runBacktest equity", () => {
  it("marks to market at close and tracks drawdown from running peak", () => {
    const candles = dailyCandles([
      [100, 105, 95, 100],
      [100, 105, 98, 110],
      [110, 112, 100, 100],
      [100, 104, 99, 104],
    ]);
    const res = runBacktest(config(), candles, scripted({ 0: { action: "enter", side: "long" } }));
    const qty = 500; // 50000 / 100
    expect(res.trades[0].qty).toBe(qty);
    // Open bars are marked to market at close with no costs; the final point is the realised net P&L.
    const finalEq = 100_000 + res.trades[0].netPnl;
    expect(res.equity.map((p) => p.equity)).toEqual([100_000, 100_000 + 10 * qty, 100_000, finalEq]);
    expect(res.equity.map((p) => p.drawdown)).toEqual([0, 0, -10 * qty, finalEq - (100_000 + 10 * qty)]);
    expect(res.metrics.maxDrawdown).toBe(10 * qty);
  });
});

// ---------- metrics ----------

function mkTrade(netPnl: number, exitTime: number, rMultiple = NaN, barsHeld = 1): Trade {
  return {
    id: 0,
    side: "long",
    entryTime: exitTime - DAY_MS,
    entryPrice: 100,
    exitTime,
    exitPrice: 100,
    qty: 1,
    grossPnl: netPnl,
    costs: 0,
    netPnl,
    rMultiple,
    exitReason: "signal",
    barsHeld,
    mae: 0,
    mfe: 0,
  };
}

describe("computeMetrics", () => {
  const candles = dailyCandles([
    [100, 101, 99, 100],
    [100, 101, 99, 110],
    [110, 111, 109, 120],
  ]);

  it("computes rates, profit factor, expectancy and streaks", () => {
    const trades = [
      mkTrade(300, DAY0, 1.5),
      mkTrade(-100, DAY0 + DAY_MS, -1),
      mkTrade(-100, DAY0 + 2 * DAY_MS, -1),
      mkTrade(-200, DAY0 + 3 * DAY_MS),
      mkTrade(0, DAY0 + 4 * DAY_MS),
      mkTrade(200, DAY0 + 5 * DAY_MS, 2),
    ];
    const m = computeMetrics(trades, [], 100_000, candles);
    expect(m.totalTrades).toBe(6);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(3);
    expect(m.breakeven).toBe(1);
    expect(m.lossRate).toBeCloseTo(0.5, 10);
    expect(m.winRate).toBeCloseTo(2 / 6, 10);
    expect(m.grossProfit).toBe(500);
    expect(m.grossLoss).toBe(-400);
    expect(m.netPnl).toBe(100);
    expect(m.profitFactor).toBeCloseTo(1.25, 10);
    expect(m.expectancy).toBeCloseTo(100 / 6, 10);
    expect(m.expectancyR).toBeCloseTo((1.5 - 1 - 1 + 2) / 4, 10);
    expect(m.avgWin).toBe(250);
    expect(m.avgLoss).toBeCloseTo(-400 / 3, 10);
    expect(m.largestWin).toBe(300);
    expect(m.largestLoss).toBe(-200);
    expect(m.maxConsecutiveLosses).toBe(3);
    expect(m.maxConsecutiveWins).toBe(1);
    expect(m.netReturnPct).toBeCloseTo(0.1, 10);
    expect(m.buyHoldReturnPct).toBeCloseTo(20, 10);
    expect(m.avgBarsHeld).toBe(1);
    expect(m.tradingDays).toBe(3);
    // 3 trading days is far too little for a Sharpe ratio.
    expect(Number.isNaN(m.sharpe)).toBe(true);
  });

  it("counts distinct IST trading days in the candles", () => {
    const intraday = [...intradayDay(2024, 1, 1), ...intradayDay(2024, 1, 2), ...intradayDay(2024, 1, 4)];
    expect(computeMetrics([], [], 100_000, intraday).tradingDays).toBe(3);
    expect(computeMetrics([], [], 100_000, []).tradingDays).toBe(0);
  });

  it("Sharpe uses daily net P&L (flat days count as zero) and needs 60+ trading days", () => {
    const flat = (days: number) => dailyCandles(Array.from({ length: days }, (): OHLC => [100, 101, 99, 100]));

    // 60 days, one day with +1000 on 1,00,000 (two trades on that day are summed), 59 flat days.
    // mean = 0.01 / 60, sample sd = 0.01 / sqrt(60) -> mean / sd = 1 / sqrt(60); x sqrt(252) = sqrt(4.2).
    const trades = [mkTrade(400, DAY0 + 10 * DAY_MS), mkTrade(600, DAY0 + 10 * DAY_MS + 60_000)];
    const m = computeMetrics(trades, [], 100_000, flat(60));
    expect(m.tradingDays).toBe(60);
    expect(m.sharpe).toBeCloseTo(Math.sqrt(4.2), 10);

    // Same trades, 59 days: not enough data.
    const short = computeMetrics(trades, [], 100_000, flat(59));
    expect(short.tradingDays).toBe(59);
    expect(Number.isNaN(short.sharpe)).toBe(true);

    // Enough days but no variation in daily P&L: 0.
    expect(computeMetrics([], [], 100_000, flat(60)).sharpe).toBe(0);

    // A losing day gives a negative Sharpe of the same size.
    const loss = computeMetrics([mkTrade(-1000, DAY0 + 5 * DAY_MS)], [], 100_000, flat(60));
    expect(loss.sharpe).toBeCloseTo(-Math.sqrt(4.2), 10);
  });

  it("handles no trades and no losses", () => {
    const none = computeMetrics([], [], 100_000, candles);
    expect(none.lossRate).toBe(0);
    expect(none.profitFactor).toBe(0);
    expect(Number.isNaN(none.sharpe)).toBe(true); // 3 trading days
    expect(none.expectancyR).toBe(0);

    const onlyWins = computeMetrics([mkTrade(100, DAY0), mkTrade(50, DAY0 + DAY_MS)], [], 100_000, candles);
    expect(onlyWins.profitFactor).toBe(Infinity);
    expect(onlyWins.lossRate).toBe(0);
  });

  it("computes max drawdown in INR and as % of the peak", () => {
    const eq: EquityPoint[] = [100, 120, 90, 130, 117].map((e, i) => ({ time: DAY0 + i * DAY_MS, equity: e, drawdown: 0 }));
    const m = computeMetrics([], eq, 100, candles);
    expect(m.maxDrawdown).toBe(30);
    expect(m.maxDrawdownPct).toBeCloseTo(25, 10);
  });
});

describe("maxConsecutive", () => {
  it("finds the longest run", () => {
    const trades = [1, -1, -1, -1, 1, -1].map((p, i) => mkTrade(p, DAY0 + i * DAY_MS));
    expect(maxConsecutive(trades, (t) => t.netPnl < 0)).toBe(3);
    expect(maxConsecutive(trades, (t) => t.netPnl > 0)).toBe(1);
    expect(maxConsecutive([], (t) => t.netPnl > 0)).toBe(0);
  });
});

describe("computeMonthly", () => {
  it("groups by IST month of exit and sorts ascending", () => {
    const trades = [
      mkTrade(50, ist(2024, 3, 5, 10, 0)),
      mkTrade(100, ist(2024, 1, 15, 10, 0)),
      // 2024-01-31 20:00 UTC is 2024-02-01 01:30 IST -> February
      mkTrade(-30, Date.UTC(2024, 0, 31, 20, 0)),
      mkTrade(20, ist(2024, 1, 20, 10, 0)),
    ];
    expect(computeMonthly(trades)).toEqual([
      { month: "2024-01", pnl: 120, trades: 2 },
      { month: "2024-02", pnl: -30, trades: 1 },
      { month: "2024-03", pnl: 50, trades: 1 },
    ]);
  });
});
