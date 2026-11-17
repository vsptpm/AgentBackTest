import type {
  BacktestConfig,
  Candle,
  EquityPoint,
  FinderConfig,
  FinderRow,
  Metrics,
  ParamSpec,
  Params,
  Strategy,
  Trade,
} from "@/lib/types";
import { DEFAULT_COSTS } from "@/lib/types";
import { computeMetrics, istDayKey, runBacktest } from "@/lib/backtest";
import { createStrategy, listStrategies, type StrategyMeta } from "@/lib/strategies";

/** Cartesian product of param grids, deterministically subsampled to `max` combos. */
export function paramGrid(specs: ParamSpec[], max: number): Params[] {
  const axes = specs.map((s) => {
    if (s.grid && s.grid.length) return { key: s.key, values: s.grid };
    if (s.type === "select" && s.options) return { key: s.key, values: s.options as (number | string)[] };
    if (s.type === "number" && s.min !== undefined && s.max !== undefined && s.step) {
      const vals: number[] = [];
      for (let v = s.min; v <= s.max + 1e-9; v += s.step) vals.push(Number(v.toFixed(6)));
      return { key: s.key, values: vals.slice(0, 8) as (number | string)[] };
    }
    return { key: s.key, values: [s.default] };
  });

  let combos: Params[] = [{}];
  for (const ax of axes) {
    const next: Params[] = [];
    for (const c of combos) for (const v of ax.values) next.push({ ...c, [ax.key]: v });
    combos = next;
  }
  if (combos.length <= max) return combos;
  // Even stride sample so the grid stays spread rather than clustered at the start.
  const out: Params[] = [];
  const stride = combos.length / max;
  for (let k = 0; k < max; k++) out.push(combos[Math.floor(k * stride)]);
  return out;
}

/**
 * Phantom zero-R trades added to the denominator of the score. A small sample is pulled
 * hard toward zero; a large one barely moves.
 */
export const SHRINK_TRADES = 60;
/** Bars of earlier history a later slice carries so indicators (and higher-timeframe series) are hot. */
export const HISTORY_BARS = 800;
/** Trade-count floors. Tune uses max(config.minTrades, MIN_TUNE_TRADES). */
export const MIN_TUNE_TRADES = 20;
export const MIN_SELECT_TRADES = 10;
/** Below this many holdout trades a row is still returned, but the UI labels it unproven. */
export const MIN_HOLDOUT_TRADES = 8;

/**
 * Sample-size-aware score: sum of R-multiples / (n + SHRINK_TRADES), n = trades with a finite R.
 * Equivalent to mean R shrunk toward zero, so 5 lucky trades cannot outrank 40 steady ones.
 * If NO trade has a finite R (strategy sets no stops), R is approximated as netPnl / riskUnit
 * (riskUnit = capital x riskPerTrade) so such strategies are still comparable with each other.
 */
export function shrunkR(trades: Trade[], riskUnit?: number): number {
  let sum = 0;
  let n = 0;
  for (const t of trades) {
    if (Number.isFinite(t.rMultiple)) {
      sum += t.rMultiple;
      n += 1;
    }
  }
  if (n === 0 && riskUnit !== undefined && riskUnit > 0) {
    for (const t of trades) sum += t.netPnl / riskUnit;
    n = trades.length;
  }
  return sum / (n + SHRINK_TRADES);
}

/** Bar indices of the three slices: tune [0, tuneEnd), select [tuneEnd, selectEnd), holdout [selectEnd, n). */
export function splitBounds(n: number, trainFraction: number): { tuneEnd: number; selectEnd: number } {
  const tuneEnd = Math.floor(n * trainFraction);
  const selectEnd = tuneEnd + Math.floor((n - tuneEnd) / 2);
  return { tuneEnd, selectEnd };
}

export interface SliceResult {
  trades: Trade[];
  metrics: Metrics;
}

/**
 * Keep only trades ENTERED at or after `sliceStartTime` and recompute metrics from them.
 * Equity is rebuilt from the kept trades (realised P&L at each exit, starting from `capital`),
 * so nothing that happened in the carried history leaks into the slice's numbers.
 */
export function tradesInSlice(trades: Trade[], sliceStartTime: number, capital: number, sliceCandles: Candle[]): SliceResult {
  const kept = trades.filter((t) => t.entryTime >= sliceStartTime);
  const equity: EquityPoint[] = [{ time: sliceStartTime, equity: capital, drawdown: 0 }];
  let eq = capital;
  let peak = capital;
  for (const t of kept) {
    eq += t.netPnl;
    if (eq > peak) peak = eq;
    equity.push({ time: t.exitTime, equity: eq, drawdown: eq - peak });
  }
  return { trades: kept, metrics: computeMetrics(kept, equity, capital, sliceCandles) };
}

/**
 * Backtest the slice candles[start, end). The run is given up to `historyBars` earlier bars so
 * indicators are warm at the slice start, but only trades entered inside the slice are counted.
 */
export function runSlice(
  config: BacktestConfig,
  candles: Candle[],
  start: number,
  end: number,
  strategy: Strategy,
  historyBars: number = HISTORY_BARS,
): SliceResult {
  const from = Math.max(0, start - Math.max(0, historyBars));
  const res = runBacktest(config, candles.slice(from, end), strategy);
  return tradesInSlice(res.trades, candles[start].time, config.capital, candles.slice(start, end));
}

function countSessions(candles: Candle[], start: number, end: number): number {
  const days = new Set<string>();
  for (let i = start; i < end; i++) days.add(istDayKey(candles[i].time));
  return days.size;
}

export interface FinderProgress {
  done: number;
  total: number;
  current?: string;
}

export interface FinderSessions {
  tune: number;
  select: number;
  holdout: number;
}

export interface FinderOutput {
  rows: FinderRow[];
  warnings: string[];
  /** Symbol x strategy x param combos actually backtested. */
  candidatesTested: number;
  /** Distinct trading days per slice, for the first usable symbol. */
  sessions: FinderSessions;
}

export interface FinderInput {
  config: FinderConfig;
  /** Pre-fetched candles per symbol. Finder does no I/O itself. */
  candlesBySymbol: Record<string, Candle[]>;
  onProgress?: (p: FinderProgress) => void;
}

export interface FinderStrategy {
  meta: StrategyMeta;
  /** Fresh instance per backtest: strategies hold per-run state. */
  create: () => Strategy;
}

export interface FinderCoreInput extends FinderInput {
  strategies: FinderStrategy[];
}

/** Higher is better. Always read from the SELECT slice. Infinite/NaN values are "unknown" and sort last. */
function objectiveKey(objective: FinderConfig["objective"], select: Metrics, score: number): number {
  switch (objective) {
    case "lossRate":
      return -select.lossRate;
    case "profitFactor":
      return Number.isFinite(select.profitFactor) ? select.profitFactor : -Infinity;
    case "expectancyR":
      return Number.isFinite(select.expectancyR) ? select.expectancyR : -Infinity;
    default:
      return score;
  }
}

/**
 * Three-way search. Each candidate is run on:
 *  - tune    (first `trainFraction` of bars): must be profitable with enough trades;
 *  - select  (first half of the rest): the ONLY slice used to rank;
 *  - holdout (last part): reported, never used to rank or filter.
 */
export function runFinderCore({ config, candlesBySymbol, onProgress, strategies }: FinderCoreInput): FinderOutput {
  const usable = strategies.filter((s) => config.strategyIds.includes(s.meta.id) && s.meta.intervals.includes(config.interval));
  const warnings: string[] = [];
  const sessions: FinderSessions = { tune: 0, select: 0, holdout: 0 };
  let sessionsSet = false;

  const jobs: { symbol: string; strat: FinderStrategy; params: Params }[] = [];
  for (const symbol of config.symbols) {
    if (symbol.startsWith("^")) {
      warnings.push(`${symbol}: skipped, indices cannot be traded as intraday equity`);
      continue;
    }
    const candles = candlesBySymbol[symbol];
    if (!candles || candles.length < 100) {
      warnings.push(`${symbol}: not enough candles (${candles?.length ?? 0}), skipped`);
      continue;
    }
    if (!sessionsSet) {
      const { tuneEnd, selectEnd } = splitBounds(candles.length, config.trainFraction);
      sessions.tune = countSessions(candles, 0, tuneEnd);
      sessions.select = countSessions(candles, tuneEnd, selectEnd);
      sessions.holdout = countSessions(candles, selectEnd, candles.length);
      sessionsSet = true;
    }
    for (const strat of usable) {
      for (const params of paramGrid(strat.meta.params, config.maxCombos)) jobs.push({ symbol, strat, params });
    }
  }

  const minTune = Math.max(config.minTrades, MIN_TUNE_TRADES);
  const riskUnit = config.capital * config.riskPerTrade;
  const scored: { row: FinderRow; key: number }[] = [];
  let candidatesTested = 0;
  let done = 0;

  for (const job of jobs) {
    const candles = candlesBySymbol[job.symbol];
    const n = candles.length;
    const { tuneEnd, selectEnd } = splitBounds(n, config.trainFraction);
    const warm = job.strat.meta.warmup;
    const history = Math.max(warm, HISTORY_BARS);
    done++;
    onProgress?.({ done, total: jobs.length, current: `${job.symbol} ${job.strat.meta.name}` });
    if (tuneEnd <= warm + 20 || selectEnd - tuneEnd < 10 || n - selectEnd < 10) continue;

    const base: BacktestConfig = {
      symbol: job.symbol,
      interval: config.interval,
      from: config.from,
      to: config.to,
      strategyId: job.strat.meta.id,
      params: job.params,
      capital: config.capital,
      riskPerTrade: config.riskPerTrade,
      // Same as the drill-down backtest in FinderPage, so row and detail agree.
      positionFraction: 1,
      squareOffTime: "15:05",
      costs: DEFAULT_COSTS,
      allowShort: true,
    };

    try {
      candidatesTested++;
      const tune = runSlice(base, candles, 0, tuneEnd, job.strat.create(), 0);
      if (tune.metrics.totalTrades < minTune || !(tune.metrics.netPnl > 0)) continue;

      const select = runSlice(base, candles, tuneEnd, selectEnd, job.strat.create(), history);
      if (select.metrics.totalTrades < MIN_SELECT_TRADES || !(select.metrics.netPnl > 0)) continue;

      // Reported only. Nothing below this line may read `holdout` to rank or filter.
      const holdout = runSlice(base, candles, selectEnd, n, job.strat.create(), history);

      const score = shrunkR(select.trades, riskUnit);
      scored.push({
        row: {
          symbol: job.symbol,
          strategyId: job.strat.meta.id,
          strategyName: job.strat.meta.name,
          params: job.params,
          inSample: tune.metrics,
          outSample: select.metrics,
          holdout: holdout.metrics,
          score,
        },
        key: objectiveKey(config.objective, select.metrics, score),
      });
    } catch (e) {
      warnings.push(`${job.symbol} / ${job.strat.meta.id}: ${(e as Error).message}`);
    }
  }

  // Stable sort: objective on the select slice, then shrunk R on the select slice.
  scored.sort((a, b) => {
    if (a.key !== b.key) return b.key > a.key ? 1 : -1;
    return b.row.score - a.row.score;
  });
  return { rows: scored.map((s) => s.row), warnings, candidatesTested, sessions };
}

export function runFinder(input: FinderInput): FinderOutput {
  const strategies = listStrategies().map((meta) => ({ meta, create: () => createStrategy(meta.id) }));
  return runFinderCore({ ...input, strategies });
}
