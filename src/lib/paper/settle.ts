// Paper trading: pure rules. No I/O, safe to import anywhere (types are used by the UI).

import { DEFAULT_COSTS, IST_OFFSET_MS, type Candle, type Side } from "@/lib/types";
import { computeTradeCosts, istDayKey, istTimeHHMM } from "@/lib/backtest";

// Upstox force-closes intraday positions in most liquid stocks at 15:10 (fee about Rs 88). Be out first.
export const PAPER_SQUARE_OFF = "15:05";

// --- House rules. Shared by the scanner, the paper ledger and the signals screen. -------------

/** New trades are only taken from this IST time (the first 15 minutes are too wild)… */
export const ENTRY_START = "09:30";
/** …and before this one (too little time left before the 15:05 square-off). */
export const ENTRY_END = "14:45";
export const MAX_TRADES_PER_DAY = 3;
/** Fraction of the trading amount. Once today's result is this bad, no more trades today. */
export const MAX_DAILY_LOSS = 0.02;
export const MAX_LOSERS_IN_ROW = 2;
/** Minutes to stay out of a stock after it hit your stop. */
export const COOLDOWN_AFTER_STOP_MIN = 30;
/** Fraction of the stop distance price may have run in favour since the signal. More = chasing. */
export const MAX_CHASE = 0.3;
/** Fraction of the stop distance price may have gone against the signal. */
export const MAX_ADVERSE = 0.5;
/** After costs. Only applied when the trade has a real target. */
export const MIN_REWARD_TO_RISK = 1.5;
/** % of price. A closer stop is taken out by normal noise and charges. */
export const MIN_STOP_PCT = 0.35;
/** A new signal older than this (seconds since its bar closed) has been missed. */
export const MAX_SIGNAL_AGE_SEC: Record<"5m" | "15m", number> = { "5m": 90, "15m": 180 };
/** Fraction of price lost on the entry fill (market order). */
export const ENTRY_SLIPPAGE = 0.0005;

export interface PaperTrade {
  id: string;
  placedAt: number;
  /** Yahoo symbol, e.g. RELIANCE.NS */
  symbol: string;
  strategyName: string;
  side: Side;
  qty: number;
  /** The fill: the price asked for, made worse by ENTRY_SLIPPAGE. */
  entryPrice: number;
  stop: number;
  target?: number;
  /** Margin multiplier the trade was taken with. Missing on old ledger rows = 1. */
  leverage?: number;
  status: "open" | "closed";
  /** Last seen price while open. */
  lastPrice?: number;
  /** Gross, while open. */
  unrealisedPnl?: number;
  exitPrice?: number;
  exitTime?: number;
  exitReason?: "stop" | "target" | "squareoff" | "manual";
  /** After brokerage and taxes, once closed. */
  netPnl?: number;
  /** What happened when the entry order was sent to the Upstox sandbox. */
  upstox: { orderId?: string; error?: string; connected: boolean };
}

export interface PaperRequest {
  symbol: string;
  strategyName: string;
  side: Side;
  qty: number;
  /** The price right now, where the trade would be entered. */
  entryPrice: number;
  /** The price when the signal fired. Lets the server refuse a chased or failed signal. */
  signalPrice?: number;
  stop?: number;
  /** Only a real, fixed target. Leave out for strategies that exit on their own signal. */
  target?: number;
  /** Margin multiplier, 1 = no leverage. Default 1. */
  leverage?: number;
  /** Money available for paper trading, INR. */
  amount: number;
  /** Max fraction of `amount` that one trade may lose at its stop, e.g. 0.01. */
  maxRisk: number;
}

export interface AccountStatus {
  /** No more new trades today. */
  locked: boolean;
  /** Why, in plain words. Only when locked. */
  reason?: string;
  /** Paper trades placed on the current IST day. */
  tradesToday: number;
  /** Today's result so far: closed trades after charges plus the running result of open ones. Negative = losing. */
  lossToday: number;
  tradesLeft: number;
}

export interface PaperState {
  trades: PaperTrade[];
  /** Margin tied up in open trades. */
  inUse: number;
  /** Net result of trades closed on the current IST day. */
  closedTodayPnl: number;
  /** Gross running result of open trades. */
  openPnl: number;
  upstoxConnected: boolean;
  /** Daily limits. `locked` is always false when the amount is not known. */
  status: AccountStatus;
}

const rupee = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const bare = (symbol: string) => symbol.replace(/\.(NS|BO)$/, "");

function clampLeverage(l: number | undefined): number {
  return l != null && Number.isFinite(l) && l >= 1 ? Math.min(l, 5) : 1;
}

/** Money a trade ties up. */
export function marginFor(qty: number, price: number, leverage?: number): number {
  return (qty * price) / clampLeverage(leverage);
}

/** Mon–Fri, ENTRY_START (inclusive) to ENTRY_END (exclusive), IST. Exchange holidays are NOT handled. */
export function inEntryWindow(now: number): boolean {
  const dow = new Date(now + IST_OFFSET_MS).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const t = istTimeHHMM(now);
  return t >= ENTRY_START && t < ENTRY_END;
}

/**
 * How far price has run since the signal, in units of the signal's stop distance.
 * Positive = in the trade's favour (entering now is chasing), negative = against it.
 */
export function movedSinceSignal(side: Side, signalPrice: number, priceNow: number, stop: number): number {
  const unit = Math.abs(signalPrice - stop);
  if (!(unit > 0)) return 0;
  return ((priceNow - signalPrice) * (side === "long" ? 1 : -1)) / unit;
}

export interface TradeNumbers {
  /** Distance to the stop, % of the entry price. */
  stopPct: number;
  /** Lost if the stop is hit, charges included. */
  risk: number;
  /** Made if the target is hit, charges taken off. null when there is no fixed target. */
  reward: number | null;
  /** Brokerage and taxes for getting in and out once (at the target if there is one, else at the stop). */
  costs: number;
}

/** What a trade can lose and make in rupees, after charges. The card and the server both use this. */
export function tradeNumbers(t: { side: Side; qty: number; entryPrice: number; stop: number; target?: number }): TradeNumbers {
  const cost = (exitPrice: number) =>
    computeTradeCosts({ side: t.side, entryPrice: t.entryPrice, exitPrice, qty: t.qty, model: DEFAULT_COSTS, intraday: true });
  const atStop = cost(t.stop);
  const atTarget = t.target == null ? null : cost(t.target);
  return {
    stopPct: (Math.abs(t.entryPrice - t.stop) / t.entryPrice) * 100,
    risk: Math.abs(t.entryPrice - t.stop) * t.qty + atStop,
    reward: t.target == null || atTarget == null ? null : Math.abs(t.target - t.entryPrice) * t.qty - atTarget,
    costs: atTarget ?? atStop,
  };
}

/** Minutes since this stock last hit a stop, if that was within the cool-down. Otherwise null. */
export function stoppedOutMinutesAgo(ledger: PaperTrade[], symbol: string, now: number): number | null {
  let latest = -Infinity;
  for (const t of ledger) {
    if (t.status === "closed" && t.symbol === symbol && t.exitReason === "stop" && t.exitTime != null && t.exitTime <= now) {
      latest = Math.max(latest, t.exitTime);
    }
  }
  const min = (now - latest) / 60_000;
  return min < COOLDOWN_AFTER_STOP_MIN ? Math.floor(min) : null;
}

/** Where the account stands against the daily limits. `amount` unknown → never locked. */
export function accountStatus(ledger: PaperTrade[], amount: number | undefined, now: number): AccountStatus {
  const today = istDayKey(now);
  let tradesToday = 0;
  let lossToday = 0;
  const closedToday: PaperTrade[] = [];
  for (const t of ledger) {
    if (istDayKey(t.placedAt) === today) tradesToday++;
    if (t.status === "open") lossToday += t.unrealisedPnl ?? 0;
    else if (t.exitTime != null && istDayKey(t.exitTime) === today) {
      lossToday += t.netPnl ?? 0;
      closedToday.push(t);
    }
  }
  const tradesLeft = Math.max(0, MAX_TRADES_PER_DAY - tradesToday);
  const base = { tradesToday, lossToday, tradesLeft };
  if (amount == null || !(amount > 0)) return { locked: false, ...base };

  const limit = MAX_DAILY_LOSS * amount;
  if (lossToday <= -limit) return { locked: true, reason: `Daily loss limit reached (${rupee(limit)}). No more trades today.`, ...base };

  closedToday.sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0));
  const lastFew = closedToday.slice(-MAX_LOSERS_IN_ROW);
  if (lastFew.length === MAX_LOSERS_IN_ROW && lastFew.every((t) => (t.netPnl ?? 0) < 0)) {
    return { locked: true, reason: "Two losses in a row — stop for today.", ...base };
  }
  if (tradesToday >= MAX_TRADES_PER_DAY) {
    return { locked: true, reason: `You have taken ${tradesToday} trades today. The limit is ${MAX_TRADES_PER_DAY} a day.`, ...base };
  }
  return { locked: false, ...base };
}

/**
 * Why this trade may not be taken, in plain words. Returns null when it passes every rule.
 * `ledger` is ALL paper trades (open and closed); the daily limits need today's closed ones.
 */
export function rejectReason(req: PaperRequest, ledger: PaperTrade[], now: number): string | null {
  if (req.symbol.startsWith("^")) return "An index cannot be bought as a share. Pick a stock.";
  if (!(req.qty >= 1) || !(req.entryPrice > 0)) return "Nothing to buy: quantity is zero.";
  if (req.stop == null) return "This signal has no stop loss, so its risk cannot be limited.";
  const stop = req.stop;
  const open = ledger.filter((t) => t.status === "open");
  if (open.some((t) => t.symbol === req.symbol)) return "You already have an open paper trade in this stock.";

  if (!inEntryWindow(now)) return `New trades are only taken between ${ENTRY_START} and ${ENTRY_END}.`;

  const status = accountStatus(ledger, req.amount, now);
  if (status.locked) return status.reason ?? "No more trades today.";

  const ago = stoppedOutMinutesAgo(ledger, req.symbol, now);
  if (ago != null) {
    return `${bare(req.symbol)} hit your stop ${ago} min ago. Wait ${COOLDOWN_AFTER_STOP_MIN} minutes before trading it again.`;
  }

  const long = req.side === "long";
  if (long ? stop >= req.entryPrice : stop <= req.entryPrice) return "Price is already past the stop loss. This signal is over.";

  const n = tradeNumbers({ side: req.side, qty: req.qty, entryPrice: req.entryPrice, stop, target: req.target });
  if (n.stopPct < MIN_STOP_PCT) {
    return `Stop is too close (${n.stopPct.toFixed(2)}% away). Normal price noise and charges would take it out.`;
  }

  if (req.signalPrice != null) {
    const moved = movedSinceSignal(req.side, req.signalPrice, req.entryPrice, stop);
    if (moved > MAX_CHASE) return "Missed it — price has already moved. Do not chase.";
    if (moved < -MAX_ADVERSE) return "Price has gone against the signal; wait for a new one.";
  }

  if (n.reward != null && n.reward < MIN_REWARD_TO_RISK * n.risk) {
    return `Not worth it: you risk ${rupee(n.risk)} to make ${rupee(Math.max(0, n.reward))} after charges.`;
  }

  const cost = marginFor(req.qty, req.entryPrice, req.leverage);
  const free = req.amount - open.reduce((s, t) => s + marginFor(t.qty, t.entryPrice, t.leverage), 0);
  if (cost > free) return `Not enough money left: this trade needs ${rupee(cost)}, you have ${rupee(Math.max(0, free))} free.`;

  const risk = Math.abs(req.entryPrice - stop) * req.qty;
  const allowed = req.amount * req.maxRisk;
  // 5% tolerance: the signal was sized a moment ago at a slightly different price.
  if (risk > allowed * 1.05) return `Too risky: could lose ${rupee(risk)}, your limit is ${rupee(allowed)} per trade.`;
  return null;
}

/** A market order fills a little worse than the price on screen. */
export function entryFill(side: Side, price: number): number {
  return side === "long" ? price * (1 + ENTRY_SLIPPAGE) : price * (1 - ENTRY_SLIPPAGE);
}

/** Stop and square-off exits are market orders: they fill a little worse too. */
function exitFill(side: Side, price: number): number {
  return side === "long" ? price * (1 - DEFAULT_COSTS.slippage) : price * (1 + DEFAULT_COSTS.slippage);
}

/** A stop-loss is a market order into a move: same harsher slippage the backtest charges (2x normal). */
function stopFill(side: Side, price: number): number {
  const slip = DEFAULT_COSTS.stopSlippage ?? 2 * DEFAULT_COSTS.slippage;
  return side === "long" ? price * (1 - slip) : price * (1 + slip);
}

function close(t: PaperTrade, exitPrice: number, exitTime: number, exitReason: NonNullable<PaperTrade["exitReason"]>): PaperTrade {
  const dir = t.side === "long" ? 1 : -1;
  const gross = (exitPrice - t.entryPrice) * t.qty * dir;
  const costs = computeTradeCosts({ side: t.side, entryPrice: t.entryPrice, exitPrice, qty: t.qty, model: DEFAULT_COSTS, intraday: true });
  return { ...t, status: "closed", exitPrice, exitTime, exitReason, netPnl: gross - costs, lastPrice: exitPrice, unrealisedPnl: undefined };
}

/** Close an open trade at a given price (the "Close now" button). */
export function closeManually(t: PaperTrade, price: number, now: number): PaperTrade {
  return t.status === "open" ? close(t, price, now, "manual") : t;
}

/**
 * Walk the bars that started after the trade was placed and apply the same rules as the backtest:
 * stop is checked before target, a gap through the stop fills at the open, and everything is
 * squared off at the first bar at/after 15:05 IST. A trade left over from an earlier day is closed
 * at that day's last price. Otherwise the trade stays open, marked to the latest price.
 * Square-off exits lose DEFAULT_COSTS.slippage and stop exits twice that, as in the backtest; a target is a resting limit order and does not.
 */
export function settleTrade(t: PaperTrade, candles: Candle[], now: number): PaperTrade {
  if (t.status !== "open") return t;
  const day = istDayKey(t.placedAt);
  const bars = candles.filter((c) => istDayKey(c.time) === day && c.time >= t.placedAt);
  const long = t.side === "long";

  for (const b of bars) {
    if (istTimeHHMM(b.time) >= PAPER_SQUARE_OFF) return close(t, exitFill(t.side, b.open), b.time, "squareoff");
    if (long ? b.open <= t.stop : b.open >= t.stop) return close(t, stopFill(t.side, b.open), b.time, "stop");
    if (long ? b.low <= t.stop : b.high >= t.stop) return close(t, stopFill(t.side, t.stop), b.time, "stop");
    if (t.target != null && (long ? b.high >= t.target : b.low <= t.target)) return close(t, t.target, b.time, "target");
  }

  const last = bars[bars.length - 1];
  if (istDayKey(now) !== day) {
    // Intraday trades never carry overnight.
    return close(t, exitFill(t.side, last?.close ?? t.lastPrice ?? t.entryPrice), last?.time ?? t.placedAt, "squareoff");
  }
  if (!last) return t;
  return { ...t, lastPrice: last.close, unrealisedPnl: (last.close - t.entryPrice) * t.qty * (long ? 1 : -1) };
}

/** `amount` is the money set aside for trading; without it the daily limits cannot be judged. */
export function summarise(trades: PaperTrade[], now: number, upstoxConnected: boolean, amount?: number): PaperState {
  const today = istDayKey(now);
  let inUse = 0;
  let closedTodayPnl = 0;
  let openPnl = 0;
  for (const t of trades) {
    if (t.status === "open") {
      inUse += marginFor(t.qty, t.entryPrice, t.leverage);
      openPnl += t.unrealisedPnl ?? 0;
    } else if (t.exitTime != null && istDayKey(t.exitTime) === today) {
      closedTodayPnl += t.netPnl ?? 0;
    }
  }
  return { trades, inUse, closedTodayPnl, openPnl, upstoxConnected, status: accountStatus(trades, amount, now) };
}
