// Shared contract for the whole app. Every module imports from here.
// Keep this file dependency-free.

/** Candle timestamps are epoch milliseconds (UTC). Display converts to IST. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Interval = "1d" | "15m" | "5m";

export interface CandleRequest {
  /** Yahoo symbol: RELIANCE.NS, ^NSEI, ^NSEBANK */
  symbol: string;
  interval: Interval;
  /** ISO date YYYY-MM-DD, inclusive */
  from: string;
  /** ISO date YYYY-MM-DD, inclusive */
  to: string;
}

export type Side = "long" | "short";

/** What a strategy emits for one bar. Engine fills on NEXT bar open. */
export interface Signal {
  action: "enter" | "exit";
  side: Side;
  /** Optional hard stop price. Engine honours it bar-by-bar. */
  stop?: number;
  /** Optional target price. */
  target?: number;
  /** Free text, shown in trade list. */
  reason?: string;
}

export interface ParamSpec {
  key: string;
  label: string;
  type: "number" | "select";
  default: number | string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** Candidate values for optimizer grid. If omitted, optimizer uses min..max by step. */
  grid?: (number | string)[];
}

export type Params = Record<string, number | string>;

export interface StrategyContext {
  candles: Candle[];
  /** Index of current bar. Strategy must only read candles[0..index]. */
  index: number;
  params: Params;
  position: { side: Side; entryPrice: number; entryIndex: number } | null;
  interval: Interval;
}

/** A line the chart draws over the candles, e.g. an HTF EMA or a breakout level. */
export interface Overlay {
  name: string;
  color?: string;
  /** "line" joins points; "step" holds each value until the next point (levels). */
  style?: "line" | "step";
  points: { time: number; value: number }[];
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  /** Which intervals this strategy makes sense on. */
  intervals: Interval[];
  params: ParamSpec[];
  /** Called per bar with full context. Return null for no action. */
  onBar(ctx: StrategyContext): Signal | null;
  /** Minimum bars needed before onBar is called (indicator warmup). */
  warmup: number;
  /** Optional: series for the chart, computed once over the full candle array after the run. */
  overlays?(candles: Candle[], params: Params): Overlay[];
}

export interface CostModel {
  /** Flat per executed order, INR. Default 20. */
  brokeragePerOrder: number;
  /** Brokerage is min(brokeragePerOrder, brokerageRate x order value). Upstox intraday equity: 0.001 (0.1%). */
  brokerageRate: number;
  /** Fraction of traded value, applied per side where applicable. */
  sttRate: number;
  exchangeRate: number;
  sebiRate: number;
  stampRate: number;
  gstRate: number;
  /** Slippage as fraction of price, applied adversely on every fill. */
  slippage: number;
  /** Slippage on stop-loss exits (market orders into a move). Defaults to 2 x slippage when undefined. */
  stopSlippage?: number;
}

export interface BacktestConfig {
  symbol: string;
  interval: Interval;
  from: string;
  to: string;
  strategyId: string;
  params: Params;
  /** INR. Asked from user before every run. */
  capital: number;
  /** Fraction of capital risked per trade when a stop exists, e.g. 0.01 */
  riskPerTrade: number;
  /** If no stop in signal, use this fraction of capital as position value. */
  positionFraction: number;
  /** Close all intraday positions at this IST time, HH:MM. Only for 5m/15m. */
  squareOffTime: string;
  costs: CostModel;
  allowShort: boolean;

  // --- Intraday risk controls. All optional; undefined = off (legacy behaviour). ---
  /** Intraday only. Entries whose FILL bar IST time is before this are dropped. HH:MM. */
  entryStart?: string;
  /** Intraday only. Entries whose FILL bar IST time is at/after this are dropped. HH:MM. */
  entryEnd?: string;
  /** Intraday only. Max entries filled per IST day. undefined or 0 = unlimited. */
  maxTradesPerDay?: number;
  /** Intraday only. Fraction of capital, e.g. 0.02. Once the IST day's realised net loss reaches it, no more entries that day. */
  maxDailyLoss?: number;
  /** Buying-power multiplier (MIS margin), e.g. 5. Default 1. Qty cap = capital * leverage / price. */
  leverage?: number;
  /** Skip entries whose round-trip costs + slippage exceed this fraction of the trade's risk (e.g. 0.25). undefined = off. */
  maxFrictionR?: number;
  /** Move the stop to the entry price once price has moved this many R in favour (needs a stop). undefined or 0 = off. */
  breakevenAtR?: number;
}

export interface Trade {
  id: number;
  side: Side;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  qty: number;
  /** Gross P&L before costs, INR */
  grossPnl: number;
  costs: number;
  /** Net P&L after costs, INR */
  netPnl: number;
  /** netPnl / initial risk. NaN if no stop. */
  rMultiple: number;
  /** Why it closed: signal | stop | target | squareoff | end */
  exitReason: "signal" | "stop" | "target" | "squareoff" | "end";
  entryReason?: string;
  /** Stop and target in force for this trade, for charting. Undefined if the signal had none. */
  stop?: number;
  target?: number;
  barsHeld: number;
  /** Max adverse excursion as fraction of entry price. */
  mae: number;
  /** Max favourable excursion as fraction of entry price. */
  mfe: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
  drawdown: number;
}

export interface Metrics {
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  /** losses / totalTrades. THE headline number for this tool. */
  lossRate: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  netReturnPct: number;
  profitFactor: number;
  /** Mean net P&L per trade, INR */
  expectancy: number;
  /** Mean R multiple over trades with a stop */
  expectancyR: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  maxConsecutiveLosses: number;
  maxConsecutiveWins: number;
  /** Annualised, from per-trade returns. 0 if < 2 trades. */
  sharpe: number;
  avgBarsHeld: number;
  totalCosts: number;
  /** Buy-and-hold net return % over same period for comparison */
  buyHoldReturnPct: number;
  /** Number of distinct IST trading days in the candles used. */
  tradingDays: number;
}

export interface MonthlyPnl {
  /** YYYY-MM */
  month: string;
  pnl: number;
  trades: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: Trade[];
  equity: EquityPoint[];
  metrics: Metrics;
  monthly: MonthlyPnl[];
  /** First and last candle time actually used */
  period: { from: number; to: number; bars: number };
  warnings: string[];
  /** Candles the run used, included by the API so the UI can chart trades. Omitted in Finder rows. */
  candles?: Candle[];
  overlays?: Overlay[];
}

/** One row of the Finder leaderboard. */
export interface FinderRow {
  symbol: string;
  strategyId: string;
  strategyName: string;
  params: Params;
  inSample: Metrics;
  outSample: Metrics;
  /** Final slice that was never used to tune OR to rank. The only honest number in the row. */
  holdout?: Metrics;
  /** Composite score used for default sort. Higher is better. */
  score: number;
}

export interface FinderConfig {
  symbols: string[];
  strategyIds: string[];
  interval: Interval;
  from: string;
  to: string;
  capital: number;
  riskPerTrade: number;
  /** 0..1 fraction of bars used for in-sample. Default 0.7 */
  trainFraction: number;
  /** Rows with fewer in-sample trades are dropped. Default 30 (daily) / 20 (intraday). */
  minTrades: number;
  objective: "lossRate" | "profitFactor" | "expectancyR" | "score";
  /** Cap on param combos per strategy. Default 60. */
  maxCombos: number;
}

export const DEFAULT_COSTS: CostModel = {
  brokeragePerOrder: 20,
  // Upstox equity intraday: Rs 20 per executed order or 0.1%, whichever is lower (rate card, Nov 2026).
  brokerageRate: 0.001,
  // Equity intraday: STT 0.025% on sell side. Delivery: 0.1% both sides.
  // We use intraday rate on sell; engine applies per side rules.
  sttRate: 0.00025,
  // NSE transaction charge from 1 Mar 2026.
  exchangeRate: 0.0000307,
  sebiRate: 0.000001,
  stampRate: 0.00003,
  gstRate: 0.18,
  slippage: 0.0005,
};

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export const NSE_SESSION = { open: "09:15", close: "15:30" } as const;
