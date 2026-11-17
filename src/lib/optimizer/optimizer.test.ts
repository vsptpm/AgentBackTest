import { describe, expect, it } from "vitest";
import type { BacktestConfig, Candle, FinderConfig, Strategy, Trade } from "@/lib/types";
import { DEFAULT_COSTS } from "@/lib/types";
import { runFinderCore, runSlice, shrunkR, splitBounds, tradesInSlice, type FinderStrategy } from "./index";

// ---------- helpers ----------

const DAY_MS = 24 * 60 * 60 * 1000;
/** 2020-01-01 09:15 IST */
const DAY0 = Date.UTC(2020, 0, 1, 3, 45);
const BARS = 1000;
const CYCLE = 5;

/**
 * Flat price of 100 in 5-bar cycles. The fake strategy signals on phase 0, fills on phase 1,
 * and phase 2 either spikes to 103 (target 102 hit: win) or drops to 97 (stop 98 hit: loss).
 * `wins(cycle)` decides which.
 */
function makeCandles(wins: (cycle: number) => boolean, bars = BARS): Candle[] {
  const out: Candle[] = [];
  for (let k = 0; k < bars; k++) {
    const phase = k % CYCLE;
    const win = wins(Math.floor(k / CYCLE));
    out.push({
      time: DAY0 + k * DAY_MS,
      open: 100,
      high: phase === 2 && win ? 103 : 100,
      low: phase === 2 && !win ? 97 : 100,
      close: 100,
      volume: 1000,
    });
  }
  return out;
}

/** Keys off candle time, not array index, so it behaves the same on a slice carrying history. */
function fakeStrategy(): Strategy {
  return {
    id: "fake",
    name: "Fake",
    description: "test",
    intervals: ["1d"],
    params: [],
    warmup: 0,
    onBar(ctx) {
      const k = Math.round((ctx.candles[ctx.index].time - DAY0) / DAY_MS);
      if (ctx.position || k % CYCLE !== 0) return null;
      return { action: "enter", side: "long", stop: 98, target: 102 };
    },
  };
}

const FAKE: FinderStrategy = {
  meta: { id: "fake", name: "Fake", description: "test", intervals: ["1d"], params: [], warmup: 0 },
  create: fakeStrategy,
};

function finderConfig(symbols: string[], over: Partial<FinderConfig> = {}): FinderConfig {
  return {
    symbols,
    strategyIds: ["fake"],
    interval: "1d",
    from: "2020-01-01",
    to: "2022-12-31",
    capital: 100_000,
    riskPerTrade: 0.01,
    trainFraction: 0.5,
    minTrades: 20,
    objective: "score",
    maxCombos: 10,
    ...over,
  };
}

const BT: BacktestConfig = {
  symbol: "A.NS",
  interval: "1d",
  from: "2020-01-01",
  to: "2022-12-31",
  strategyId: "fake",
  params: {},
  capital: 100_000,
  riskPerTrade: 0.01,
  positionFraction: 1,
  squareOffTime: "15:15",
  costs: DEFAULT_COSTS,
  allowShort: true,
};

function trade(entryTime: number, netPnl: number, rMultiple: number): Trade {
  return {
    id: 1,
    side: "long",
    entryTime,
    entryPrice: 100,
    exitTime: entryTime + DAY_MS,
    exitPrice: 101,
    qty: 1,
    grossPnl: netPnl,
    costs: 0,
    netPnl,
    rMultiple,
    exitReason: "target",
    barsHeld: 1,
    mae: 0,
    mfe: 0,
  };
}

const mostlyWins = (c: number) => c % 5 !== 0; // 4 wins in 5
const TUNE_CYCLES = 100; // bars 0..499
const SELECT_END_CYCLE = 150; // bars 500..749; holdout is 750..999

// ---------- tests ----------

describe("splitBounds", () => {
  it("gives tune = trainFraction and splits the rest evenly", () => {
    expect(splitBounds(1000, 0.5)).toEqual({ tuneEnd: 500, selectEnd: 750 });
    expect(splitBounds(1000, 0.7)).toEqual({ tuneEnd: 700, selectEnd: 850 });
  });
});

describe("slice helper", () => {
  it("tradesInSlice keeps only trades entered at or after the slice start", () => {
    const start = DAY0 + 10 * DAY_MS;
    const trades = [trade(start - DAY_MS, 5000, 5), trade(start, 100, 1), trade(start + DAY_MS, -40, -0.5)];
    const res = tradesInSlice(trades, start, 100_000, []);
    expect(res.trades).toHaveLength(2);
    expect(res.metrics.totalTrades).toBe(2);
    expect(res.metrics.netPnl).toBeCloseTo(60, 6);
    expect(res.metrics.wins).toBe(1);
    expect(res.metrics.losses).toBe(1);
  });

  it("runSlice with carried history counts only trades entered inside the slice", () => {
    const candles = makeCandles(mostlyWins);
    const withHistory = runSlice(BT, candles, 500, 750, fakeStrategy(), 800);
    // 250 bars / 5-bar cycle = 50 entries; the 100 trades in the carried 500 bars are excluded.
    expect(withHistory.metrics.totalTrades).toBe(50);
    expect(withHistory.trades.every((t) => t.entryTime >= candles[500].time)).toBe(true);
    // History must not change what happens inside the slice.
    const noHistory = runSlice(BT, candles, 500, 750, fakeStrategy(), 0);
    expect(noHistory.metrics.totalTrades).toBe(50);
    expect(withHistory.metrics.netPnl).toBeCloseTo(noHistory.metrics.netPnl, 6);
  });
});

describe("shrunkR", () => {
  it("prefers 40 trades at +0.2R over 5 trades at +1R", () => {
    const many = Array.from({ length: 40 }, (_, i) => trade(DAY0 + i * DAY_MS, 200, 0.2));
    const few = Array.from({ length: 5 }, (_, i) => trade(DAY0 + i * DAY_MS, 1000, 1));
    expect(shrunkR(many)).toBeGreaterThan(shrunkR(few));
  });

  it("ignores non-finite R and is finite for an empty sample", () => {
    expect(shrunkR([])).toBe(0);
    const mixed = [trade(DAY0, 100, 1), trade(DAY0, 100, NaN)];
    expect(shrunkR(mixed)).toBeCloseTo(shrunkR([trade(DAY0, 100, 1)]), 12);
  });
});

describe("runFinderCore", () => {
  it("returns tune / select / holdout metrics, candidatesTested and sessions", () => {
    const out = runFinderCore({
      config: finderConfig(["A.NS"]),
      candlesBySymbol: { "A.NS": makeCandles(mostlyWins) },
      strategies: [FAKE],
    });
    expect(out.candidatesTested).toBe(1);
    expect(out.sessions).toEqual({ tune: 500, select: 250, holdout: 250 });
    expect(out.rows).toHaveLength(1);
    const row = out.rows[0];
    expect(row.inSample.totalTrades).toBe(100);
    expect(row.outSample.totalTrades).toBe(50);
    expect(row.holdout?.totalTrades).toBe(50);
    expect(row.outSample.netPnl).toBeGreaterThan(0);
  });

  it("rejects rows with non-positive select or tune P&L", () => {
    const badSelect = makeCandles((c) => (c >= TUNE_CYCLES && c < SELECT_END_CYCLE ? false : mostlyWins(c)));
    const badTune = makeCandles((c) => (c < TUNE_CYCLES ? false : mostlyWins(c)));
    const out = runFinderCore({
      config: finderConfig(["GOOD.NS", "BADSEL.NS", "BADTUNE.NS"]),
      candlesBySymbol: { "GOOD.NS": makeCandles(mostlyWins), "BADSEL.NS": badSelect, "BADTUNE.NS": badTune },
      strategies: [FAKE],
    });
    expect(out.candidatesTested).toBe(3);
    expect(out.rows.map((r) => r.symbol)).toEqual(["GOOD.NS"]);
  });

  it("drops rows below the trade floors", () => {
    const out = runFinderCore({
      config: finderConfig(["A.NS"], { minTrades: 101 }),
      candlesBySymbol: { "A.NS": makeCandles(mostlyWins) },
      strategies: [FAKE],
    });
    expect(out.rows).toHaveLength(0);
  });

  it("skips index symbols with a warning", () => {
    const out = runFinderCore({
      config: finderConfig(["^NSEI", "A.NS"]),
      candlesBySymbol: { "^NSEI": makeCandles(mostlyWins), "A.NS": makeCandles(mostlyWins) },
      strategies: [FAKE],
    });
    expect(out.rows.map((r) => r.symbol)).toEqual(["A.NS"]);
    expect(out.candidatesTested).toBe(1);
    expect(out.warnings.some((w) => w.includes("^NSEI") && w.includes("indices cannot be traded as intraday equity"))).toBe(true);
  });

  it("never uses the holdout to rank or filter", () => {
    const holdoutGood = makeCandles(mostlyWins);
    const holdoutBad = makeCandles((c) => (c >= SELECT_END_CYCLE ? false : mostlyWins(c)));

    for (const objective of ["score", "lossRate", "profitFactor", "expectancyR"] as const) {
      const config = finderConfig(["A.NS", "B.NS"], { objective });
      const first = runFinderCore({ config, candlesBySymbol: { "A.NS": holdoutGood, "B.NS": holdoutBad }, strategies: [FAKE] });
      const swapped = runFinderCore({ config, candlesBySymbol: { "A.NS": holdoutBad, "B.NS": holdoutGood }, strategies: [FAKE] });

      // Identical on tune and select, so order is the same whichever one has the good holdout.
      expect(first.rows.map((r) => r.symbol)).toEqual(["A.NS", "B.NS"]);
      expect(swapped.rows.map((r) => r.symbol)).toEqual(["A.NS", "B.NS"]);
      expect(first.rows[0].score).toBe(first.rows[1].score);
      expect(first.rows[0].outSample.netPnl).toBe(first.rows[1].outSample.netPnl);

      // The holdouts really do differ, and a losing holdout is still returned.
      expect(first.rows[0].holdout!.netPnl).toBeGreaterThan(0);
      expect(first.rows[1].holdout!.netPnl).toBeLessThan(0);
      expect(swapped.rows[0].holdout!.netPnl).toBeLessThan(0);
      expect(swapped.rows[1].holdout!.netPnl).toBeGreaterThan(0);
    }
  });
});
