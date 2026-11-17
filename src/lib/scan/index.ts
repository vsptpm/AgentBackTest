// Live scanner: what are the strategies signalling on the latest IST day?
// Pure logic (no I/O). Runs the normal backtest engine over a short recent window and
// reads today's trades back out of the result.

import { DEFAULT_COSTS, type BacktestConfig, type Candle, type Interval, type Side, type Strategy, type Trade } from "@/lib/types";
import { computeTradeCosts, runBacktest, istDayKey, istTimeHHMM } from "@/lib/backtest";
import { createStrategy, defaultParams } from "@/lib/strategies";
import { ENTRY_END, ENTRY_START } from "@/lib/paper/settle";
import type { InPlay } from "./inplay";

export type ScanInterval = Extract<Interval, "5m" | "15m">;

// Upstox force-closes intraday positions in most liquid stocks at 15:10 and charges about Rs 88 for it.
// Be out before that.
export const SCAN_SQUARE_OFF = "15:05";
const INTERVAL_MS: Record<ScanInterval, number> = { "5m": 5 * 60_000, "15m": 15 * 60_000 };

export interface ScanOpen {
  side: Side;
  /** true = the signal fired on the last completed bar; no fill yet, enter now ≈ last close. */
  fresh: boolean;
  /** Fresh: time of the bar that fired the signal. Otherwise: the fill bar time. */
  entryTime: number;
  entryPrice: number;
  stop?: number;
  target?: number;
  qty: number;
  /** Estimated brokerage + taxes for getting in and out once, INR. */
  estCosts: number;
  /** Gross, at the last close. 0 for fresh signals. */
  unrealisedPnl: number;
  /** Distance from last price to stop / target, % of last price (positive = not hit yet). */
  stopDistPct?: number;
  targetDistPct?: number;
  reason?: string;
  /**
   * Fresh: seconds since the bar that fired the signal closed. Otherwise: seconds since the fill bar's time.
   * Measured at the scan's `now`.
   */
  signalAgeSec: number;
  /**
   * How far the last price has run from entryPrice, in units of the stop distance.
   * Positive = in the trade's favour. 0 for fresh signals, undefined without a stop.
   */
  movedR?: number;
  /** Stop distance as % of entryPrice. Undefined without a stop. */
  stopPct?: number;
  /** "target" = the strategy gave a real fixed target. "signal" = it exits on its own indicator. */
  exitRule: "target" | "signal";
}

export interface ScanClosed {
  side: Side;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  qty: number;
  reason: Trade["exitReason"];
  netPnl: number;
  rMultiple: number;
}

export interface ScanRecent {
  trades: number;
  winRate: number;
  netPnl: number;
  /** Infinity when there are wins and no losses; NaN when there are no trades. */
  profitFactor: number;
  /** Sum and count of finite rMultiple over the same trades, so results can be pooled across stocks. */
  sumR: number;
  nR: number;
}

export interface ScanStrategyResult {
  strategyId: string;
  strategyName: string;
  open: ScanOpen | null;
  closedToday: ScanClosed[];
  recent: ScanRecent;
}

export interface ScanSymbolResult {
  symbol: string;
  /** Start time of the last completed bar used. */
  lastBarTime: number;
  lastPrice: number;
  /** % change of lastPrice vs the previous IST day's last close. NaN if only one day of data. */
  dayChangePct: number;
  /** YYYY-MM-DD (IST) of the latest day in the data. */
  day: string;
  /** Latest day in the data is not the IST day of `now` (weekend, holiday, or stale feed). */
  stale: boolean;
  strategies: ScanStrategyResult[];
}

export interface ScanCoreArgs {
  symbol: string;
  candles: Candle[];
  strategies: Strategy[];
  interval: ScanInterval;
  capital: number;
  riskPerTrade: number;
  /** Intraday margin multiplier, 1..5. Default 1 (no leverage). */
  leverage?: number;
  now: number;
}

/** A target further than this many stop distances from entry is a sanity cap, not a real target. */
const MAX_TARGET_STOP_DISTANCES = 3.5;

/**
 * Some strategies exit on their indicator and pass a far-away placeholder as the target
 * (0 for shorts, a huge number for longs, or an 8-ATR cap against a 2-ATR stop). That is
 * "no target", not a price to show a trader. With a stop, anything further than 3.5 stop
 * distances from entry counts as no target.
 */
export function realTarget(target: number | undefined, entryPrice: number, stop?: number): number | undefined {
  if (target == null || !Number.isFinite(target)) return undefined;
  if (!(target > entryPrice * 0.5 && target < entryPrice * 1.5)) return undefined;
  if (stop != null && Math.abs(target - entryPrice) > MAX_TARGET_STOP_DISTANCES * Math.abs(entryPrice - stop)) return undefined;
  return target;
}

function recentStats(trades: Trade[]): ScanRecent {
  let wins = 0;
  let gp = 0;
  let gl = 0;
  let net = 0;
  let sumR = 0;
  let nR = 0;
  for (const t of trades) {
    net += t.netPnl;
    if (Number.isFinite(t.rMultiple)) {
      sumR += t.rMultiple;
      nR++;
    }
    if (t.netPnl > 0) {
      wins++;
      gp += t.netPnl;
    } else if (t.netPnl < 0) gl += -t.netPnl;
  }
  const n = trades.length;
  return {
    trades: n,
    winRate: n ? wins / n : NaN,
    netPnl: net,
    profitFactor: n === 0 ? NaN : gl > 0 ? gp / gl : gp > 0 ? Infinity : NaN,
    sumR,
    nR,
  };
}

/** Core: takes Strategy instances (fresh, unused) so it can be tested with fakes. */
export function scanSymbolWith(args: ScanCoreArgs): ScanSymbolResult | null {
  const { symbol, interval, capital, riskPerTrade, now } = args;
  const leverage = args.leverage != null && Number.isFinite(args.leverage) ? Math.min(5, Math.max(1, args.leverage)) : 1;
  const step = INTERVAL_MS[interval];
  let candles = args.candles;
  // Yahoo's newest bar is usually still forming; a strategy must not act on a partial bar.
  while (candles.length && candles[candles.length - 1].time + step > now) candles = candles.slice(0, -1);
  if (candles.length === 0) return null;

  const last = candles[candles.length - 1];
  const day = istDayKey(last.time);
  const stale = istDayKey(now) !== day;

  let prevClose = NaN;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (istDayKey(candles[i].time) !== day) {
      prevClose = candles[i].close;
      break;
    }
  }

  // The engine fills at the NEXT bar's open, so a signal on the last completed bar has no
  // trade yet. Append one flat synthetic bar so it shows up as an open trade entered there.
  const synthTime = last.time + step;
  const useSynth =
    !stale &&
    istTimeHHMM(last.time) < SCAN_SQUARE_OFF &&
    istTimeHHMM(synthTime) < SCAN_SQUARE_OFF &&
    istDayKey(synthTime) === day;
  const runCandles: Candle[] = useSynth
    ? [...candles, { time: synthTime, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0 }]
    : candles;
  const endTime = runCandles[runCandles.length - 1].time;

  const strategies: ScanStrategyResult[] = [];
  for (const strategy of args.strategies) {
    if (!strategy.intervals.includes(interval)) continue;
    const config: BacktestConfig = {
      symbol,
      interval,
      from: istDayKey(candles[0].time),
      to: day,
      strategyId: strategy.id,
      params: defaultParams(strategy),
      capital,
      riskPerTrade,
      positionFraction: 0.5,
      squareOffTime: SCAN_SQUARE_OFF,
      costs: DEFAULT_COSTS,
      allowShort: true,
      // The track record and the live signals follow the same entry window as the paper ledger.
      entryStart: ENTRY_START,
      entryEnd: ENTRY_END,
      leverage,
    };
    const { trades } = runBacktest(config, runCandles, strategy);

    let open: ScanOpen | null = null;
    const closedToday: ScanClosed[] = [];
    const completed: Trade[] = [];
    for (const t of trades) {
      const isOpen = t.exitReason === "end" && t.exitTime === endTime;
      if (isOpen) {
        // Past square-off (or on a stale day) an "end" trade is not something to act on.
        if (stale || istTimeHHMM(last.time) >= SCAN_SQUARE_OFF) continue;
        const fresh = useSynth && t.entryTime === synthTime;
        const dir = t.side === "long" ? 1 : -1;
        const entryPrice = fresh ? last.close : t.entryPrice;
        const target = realTarget(t.target, entryPrice, t.stop);
        const stopDist = t.stop == null ? undefined : Math.abs(entryPrice - t.stop);
        open = {
          side: t.side,
          fresh,
          entryTime: fresh ? last.time : t.entryTime,
          entryPrice,
          stop: t.stop,
          target,
          qty: t.qty,
          estCosts: computeTradeCosts({ side: t.side, entryPrice, exitPrice: target ?? entryPrice, qty: t.qty, model: DEFAULT_COSTS, intraday: true }),
          unrealisedPnl: fresh ? 0 : (last.close - entryPrice) * dir * t.qty,
          stopDistPct: t.stop == null ? undefined : (((last.close - t.stop) * dir) / last.close) * 100,
          targetDistPct: target == null ? undefined : (((target - last.close) * dir) / last.close) * 100,
          reason: t.entryReason,
          signalAgeSec: Math.max(0, Math.floor((now - (fresh ? synthTime : t.entryTime)) / 1000)),
          movedR: stopDist == null ? undefined : fresh || stopDist === 0 ? 0 : ((last.close - entryPrice) * dir) / stopDist,
          stopPct: stopDist == null ? undefined : (stopDist / entryPrice) * 100,
          exitRule: target == null ? "signal" : "target",
        };
        continue;
      }
      completed.push(t);
      if (istDayKey(t.entryTime) === day) {
        closedToday.push({
          side: t.side,
          entryTime: t.entryTime,
          entryPrice: t.entryPrice,
          // An exit signal on the last real bar fills on the synthetic bar; report the real bar.
          exitTime: Math.min(t.exitTime, last.time),
          exitPrice: t.exitPrice,
          qty: t.qty,
          reason: t.exitReason,
          netPnl: t.netPnl,
          rMultiple: t.rMultiple,
        });
      }
    }
    strategies.push({ strategyId: strategy.id, strategyName: strategy.name, open, closedToday, recent: recentStats(completed) });
  }

  return {
    symbol,
    lastBarTime: last.time,
    lastPrice: last.close,
    dayChangePct: Number.isFinite(prevClose) && prevClose > 0 ? ((last.close - prevClose) / prevClose) * 100 : NaN,
    day,
    stale,
    strategies,
  };
}

/** Thin wrapper: resolves registered strategy ids to fresh instances with default params. */
export function scanSymbol(args: Omit<ScanCoreArgs, "strategies"> & { strategyIds: string[] }): ScanSymbolResult | null {
  const { strategyIds, ...rest } = args;
  return scanSymbolWith({ ...rest, strategies: strategyIds.map((id) => createStrategy(id)) });
}

/** NSE cash session, Mon–Fri 09:15–15:30 IST. Exchange holidays are NOT handled. */
export function isMarketOpen(now: number): boolean {
  const d = new Date(now + 5.5 * 60 * 60 * 1000);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 9 * 60 + 15 && m < 15 * 60 + 30;
}

export interface ScanRequest {
  /** The watchlist. Ignored when `inPlay` is set. */
  symbols: string[];
  /** Scan today's most active stocks instead: the top N, plus `keep` so stocks you are in stay on screen. */
  inPlay?: {
    top: number;
    /** Stocks with a live signal: kept while the account can still afford them. */
    keep: string[];
    /** Stocks with an open paper trade: always kept. */
    held?: string[];
  };
  strategyIds: string[];
  interval: ScanInterval;
  capital: number;
  riskPerTrade: number;
  /** Intraday margin multiplier, 1..5. Default 1 (no leverage). */
  leverage?: number;
}

export interface ScanResponse {
  rows: ScanSymbolResult[];
  warnings: string[];
  asOf: number;
  marketOpen: boolean;
  /** Where the prices came from. "mixed" = some symbols fell back to delayed Yahoo prices. */
  priceSource: "upstox" | "yahoo" | "mixed";
  upstox: { configured: boolean; connected: boolean };
  /** Present when the scan chose its own stocks. */
  inPlay?: {
    picks: InPlay[];
    /** How many stocks were looked at. */
    poolSize: number;
    pool: "liquid" | "catalogue";
    rankedAt: number;
    /** How many of the pool the account can trade: at least MIN_SHARES shares, price at least MIN_PRICE. */
    affordableCount: number;
    /** The dearest share the account can buy MIN_SHARES of: capital × margin ÷ MIN_SHARES. */
    maxPrice: number;
    /** Too few affordable stocks were moving, so quieter ones were let in. */
    movementRelaxed: boolean;
  };
}
