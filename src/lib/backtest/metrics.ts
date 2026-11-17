import type { Candle, EquityPoint, Metrics, MonthlyPnl, Trade } from "@/lib/types";
import { IST_OFFSET_MS } from "@/lib/types";

/** Trading days per year used to annualise the daily Sharpe. */
const TRADING_DAYS_PER_YEAR = 252;
/** Below this many trading days a Sharpe ratio is noise; it is reported as NaN. */
export const MIN_SHARPE_DAYS = 60;

/** IST calendar day (YYYY-MM-DD) of an epoch-ms timestamp. */
function istDay(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Longest run of consecutive trades (in order) satisfying the predicate. */
export function maxConsecutive(trades: Trade[], predicate: (t: Trade) => boolean): number {
  let best = 0;
  let run = 0;
  for (const t of trades) {
    if (predicate(t)) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n - 1). */
function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/**
 * Fill every field of Metrics.
 * - win: netPnl > 0, loss: netPnl < 0, breakeven: netPnl === 0.
 * - grossLoss is the (negative) sum of losing trades' net P&L; avgLoss and largestLoss are negative too.
 * - profitFactor = grossProfit / |grossLoss|; Infinity when profits exist with no losses; 0 with no trades.
 * - tradingDays: distinct IST days in the candles passed.
 * - Sharpe: DAILY returns on capital (net P&L summed per IST day of exit, zero for candle days
 *   with no closed trade), mean / sample std * sqrt(252). NaN when tradingDays < 60 (too little
 *   data to mean anything); 0 only when the std is 0 (or capital is not positive).
 * - buyHoldReturnPct uses the first and last close of the candles passed.
 */
export function computeMetrics(
  trades: Trade[],
  equity: EquityPoint[],
  capital: number,
  candles: Candle[],
): Metrics {
  const totalTrades = trades.length;
  const winners = trades.filter((t) => t.netPnl > 0);
  const losers = trades.filter((t) => t.netPnl < 0);
  const wins = winners.length;
  const losses = losers.length;
  const breakeven = totalTrades - wins - losses;

  const grossProfit = winners.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = losers.reduce((s, t) => s + t.netPnl, 0);
  const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const totalCosts = trades.reduce((s, t) => s + t.costs, 0);

  let profitFactor = 0;
  if (totalTrades > 0) {
    if (grossLoss < 0) profitFactor = grossProfit / Math.abs(grossLoss);
    else profitFactor = grossProfit > 0 ? Infinity : 0;
  }

  const rValues = trades.map((t) => t.rMultiple).filter((r) => Number.isFinite(r));

  // Drawdown from the equity curve: peak-to-trough in INR and as % of the peak at that time.
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let peak = -Infinity;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPct = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }

  // Sharpe from daily net P&L (by IST day of exit), flat days included as zero.
  const dailyPnl = new Map<string, number>();
  for (const c of candles) dailyPnl.set(istDay(c.time), 0);
  const tradingDays = dailyPnl.size;
  let sharpe = NaN;
  if (tradingDays >= MIN_SHARPE_DAYS) {
    for (const t of trades) {
      const day = istDay(t.exitTime);
      dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.netPnl);
    }
    const returns = capital > 0 ? [...dailyPnl.values()].map((p) => p / capital) : [];
    const sd = stdDev(returns);
    sharpe = sd > 0 ? (mean(returns) / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0;
  }

  let buyHoldReturnPct = 0;
  if (candles.length >= 1) {
    const firstClose = candles[0].close;
    const lastClose = candles[candles.length - 1].close;
    buyHoldReturnPct = firstClose > 0 ? (lastClose / firstClose - 1) * 100 : 0;
  }

  return {
    totalTrades,
    wins,
    losses,
    breakeven,
    winRate: totalTrades > 0 ? wins / totalTrades : 0,
    lossRate: totalTrades > 0 ? losses / totalTrades : 0,
    grossProfit,
    grossLoss,
    netPnl,
    netReturnPct: capital > 0 ? (netPnl / capital) * 100 : 0,
    profitFactor,
    expectancy: totalTrades > 0 ? netPnl / totalTrades : 0,
    expectancyR: rValues.length > 0 ? mean(rValues) : 0,
    avgWin: wins > 0 ? grossProfit / wins : 0,
    avgLoss: losses > 0 ? grossLoss / losses : 0,
    largestWin: wins > 0 ? Math.max(...winners.map((t) => t.netPnl)) : 0,
    largestLoss: losses > 0 ? Math.min(...losers.map((t) => t.netPnl)) : 0,
    maxDrawdown,
    maxDrawdownPct,
    maxConsecutiveLosses: maxConsecutive(trades, (t) => t.netPnl < 0),
    maxConsecutiveWins: maxConsecutive(trades, (t) => t.netPnl > 0),
    sharpe,
    avgBarsHeld: totalTrades > 0 ? mean(trades.map((t) => t.barsHeld)) : 0,
    totalCosts,
    buyHoldReturnPct,
    tradingDays,
  };
}

/** IST calendar month (YYYY-MM) of an epoch-ms timestamp. */
export function istMonthKey(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 7);
}

/** Net P&L and trade count grouped by IST month of exit, ascending. */
export function computeMonthly(trades: Trade[]): MonthlyPnl[] {
  const map = new Map<string, MonthlyPnl>();
  for (const t of trades) {
    const month = istMonthKey(t.exitTime);
    const row = map.get(month);
    if (row) {
      row.pnl += t.netPnl;
      row.trades += 1;
    } else {
      map.set(month, { month, pnl: t.netPnl, trades: 1 });
    }
  }
  return [...map.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}
