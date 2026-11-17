// "Should I take this?" — one verdict per signal card, with the reasons in plain words.
// Pure logic, no I/O. The signals screen takes both the verdict and the state of its
// "Paper trade" button from judge(), so the two can never disagree.

import type { Side } from "@/lib/types";
import { fmtINR, fmtNum } from "@/lib/format";
import {
  ENTRY_END,
  ENTRY_START,
  MAX_ADVERSE,
  MAX_CHASE,
  MAX_SIGNAL_AGE_SEC,
  MAX_TRADES_PER_DAY,
  MIN_REWARD_TO_RISK,
  MIN_STOP_PCT,
  marginFor,
  movedSinceSignal,
  tradeNumbers,
  type TradeNumbers,
} from "@/lib/paper/settle";
import { MIN_SHARES, isMoving, sharesAffordable } from "./inplay";

/** A stock up or down this much today (%) is not traded against. */
export const AGAINST_DAY_PCT = 1.5;
/** A strategy's pooled record must have this many trades… */
export const PROVEN_MIN_TRADES = 30;
/** …and this average result per trade (in units of risk), after pulling it towards zero by this many imaginary flat trades. */
export const PROVEN_SHRINK = 20;
export const PROVEN_MIN_EDGE = 0.05;
/** Fewer trades than this on one stock says nothing. */
export const STOCK_MIN_TRADES = 8;

/** A strategy's recent results added up over every stock in the scan. */
export interface StrategyRecord {
  trades: number;
  wins: number;
  netPnl: number;
  /** Sum and count of each trade's result in units of its own risk. */
  sumR: number;
  nR: number;
}

export const NO_RECORD: StrategyRecord = { trades: 0, wins: 0, netPnl: 0, sumR: 0, nR: 0 };

/** The average result per trade, pulled towards zero when there are few trades. */
export function edge(p: StrategyRecord): number {
  return p.sumR / (p.nR + PROVEN_SHRINK);
}

/** "Made money recently": enough trades across all scanned stocks, a real average edge, and a profit in rupees. */
export function isProven(p: StrategyRecord): boolean {
  return p.nR >= PROVEN_MIN_TRADES && edge(p) >= PROVEN_MIN_EDGE && p.netPnl > 0;
}

// --- The trade you would actually get if you entered now ---------------------------------------

export interface PlanInput {
  side: Side;
  /** The signal fired on the last completed bar: enter at the signal price. Otherwise at the price now. */
  fresh: boolean;
  signalPrice: number;
  lastPrice: number;
  stop?: number;
  target?: number;
  /** Shares the scanner sized the signal at. */
  signalQty: number;
  capital: number;
  /** Max fraction of capital one trade may lose at its stop. */
  riskPerTrade: number;
  leverage: number;
}

export interface TradePlan {
  /** Price to enter near. */
  entry: number;
  qty: number;
  /** Money the trade ties up. */
  margin: number;
  /** null when there is nothing to size: no stop, zero shares, or price already past the stop. */
  numbers: TradeNumbers | null;
  /** Reward ÷ risk after charges. -Infinity without a fixed target. */
  ratio: number;
}

function isPastStop(side: Side, entry: number, stop: number | undefined): boolean {
  return stop != null && (side === "long" ? stop >= entry : stop <= entry);
}

export function planTrade(p: PlanInput): TradePlan {
  const entry = p.fresh ? p.signalPrice : p.lastPrice;
  // Size for the price now: never more shares than the signal had, never more risk than the limit.
  let qty = p.signalQty;
  if (p.stop != null) {
    const dist = Math.abs(entry - p.stop);
    if (dist > 0) qty = Math.min(qty, Math.floor((p.capital * p.riskPerTrade) / dist));
  }
  qty = Math.max(0, Math.min(qty, sharesAffordable(entry, p.capital, p.leverage)));
  const numbers =
    p.stop != null && qty >= 1 && !isPastStop(p.side, entry, p.stop)
      ? tradeNumbers({ side: p.side, qty, entryPrice: entry, stop: p.stop, target: p.target })
      : null;
  const ratio = numbers?.reward != null && numbers.risk > 0 ? numbers.reward / numbers.risk : -Infinity;
  return { entry, qty, margin: marginFor(qty, entry, p.leverage), numbers, ratio };
}

// --- The verdict -----------------------------------------------------------------------------

export type Verdict = "take" | "wait" | "skip";

export interface Reason {
  ok: boolean;
  text: string;
}

export interface Judgement {
  verdict: Verdict;
  /** One line: the verdict and the single most important reason. */
  headline: string;
  /** The checklist, in reading order. Every line is a tick or a cross. */
  reasons: Reason[];
}

export interface JudgeInput {
  symbol: string;
  side: Side;
  fresh: boolean;
  /** Seconds since the signal, counted up to the clock. */
  signalAgeSec: number;
  /** Price when the signal fired. */
  signalPrice: number;
  stop?: number;
  target?: number;
  /** "signal" = no fixed target; the strategy exits on its own. */
  exitRule: "target" | "signal";
  /** From planTrade(): the trade at the price now. */
  plan: TradePlan;

  /** Today's move (%) and volume against usual. Leave out when unknown. */
  changePct?: number;
  relVol?: number;
  /** Hold back signals that fight a stock's move today (the "most active" list). */
  checkDirection: boolean;

  /** This strategy across all scanned stocks, and on this stock alone. */
  strategy: StrategyRecord;
  stock: { trades: number; wins: number };
  /** Other strategies point the other way on this stock right now. */
  disagree: boolean;

  capital: number;
  leverage: number;
  /** Money not tied up in open paper trades. */
  free: number;
  interval: "5m" | "15m";
  priceSource: "upstox" | "yahoo" | "mixed";
  /** The clock is inside the hours when new trades are taken. */
  inEntryWindow: boolean;
  /** The daily limits have stopped trading for today, and why. */
  locked: boolean;
  lockedReason?: string;
  tradesLeft?: number;
  /** Minutes since this stock hit your stop, while still inside the cool-down. */
  stoppedOutMinAgo: number | null;
}

const price = (n: number) => `₹${fmtNum(n)}`;
/** Small amounts keep their paise: "₹2.30" tells more than "₹2". */
const money = (n: number) => fmtINR(n, { decimals: Math.abs(n) < 100 && !Number.isInteger(n) });
const shares = (n: number) => `${fmtNum(n, 0)} ${n === 1 ? "share" : "shares"}`;
const ago = (sec: number) => (sec < 90 ? `${Math.max(0, Math.round(sec))} s ago` : `${Math.round(sec / 60)} min ago`);

/**
 * Take, wait or skip — and why.
 * - skip: a house rule fails. These are the rules that block the "Paper trade" button.
 * - wait: nothing fails, but the setup is unproven, fights the day, is barely moving, or prices are delayed.
 * - take: every line of the checklist is a tick.
 */
export function judge(i: JudgeInput): Judgement {
  const { plan } = i;
  const { entry, qty, numbers } = plan;
  const long = i.side === "long";
  const verb = long ? "buy" : "sell";
  const withMargin = i.leverage > 1 ? ` and ${fmtNum(i.leverage, 0)}× margin` : "";

  // Lowest rank = the reason that matters most; it becomes the headline.
  const hard: { rank: number; why: string }[] = [];
  const soft: { rank: number; why: string }[] = [];
  const reasons: Reason[] = [];
  const tick = (text: string) => reasons.push({ ok: true, text });
  const block = (rank: number, why: string, text: string) => {
    hard.push({ rank, why });
    reasons.push({ ok: false, text });
  };
  const hold = (rank: number, why: string, text: string) => {
    soft.push({ rank, why });
    reasons.push({ ok: false, text });
  };

  const pastStop = isPastStop(i.side, entry, i.stop);
  const moved = i.fresh || i.stop == null ? 0 : movedSinceSignal(i.side, i.signalPrice, entry, i.stop);

  // 1. Can you afford it?
  const canHold = sharesAffordable(entry, i.capital, i.leverage);
  if (i.symbol.startsWith("^")) {
    block(0, "an index cannot be bought as a share", "This is an index, not a share you can trade");
  } else if (canHold < MIN_SHARES) {
    block(
      10,
      `you cannot afford ${MIN_SHARES} shares`,
      `At ${price(entry)} a share, ${fmtINR(i.capital)}${withMargin} does not buy ${MIN_SHARES} shares`,
    );
  } else if (qty < 1) {
    block(10, "too small to trade with this amount", "Your loss limit per trade is too small for even 1 share here");
  } else if (plan.margin > i.free) {
    block(
      14,
      `it needs ${fmtINR(plan.margin)} and only ${fmtINR(Math.max(0, i.free))} is free`,
      `Needs ${fmtINR(plan.margin)}, but only ${fmtINR(Math.max(0, i.free))} of your ${fmtINR(i.capital)} is free`,
    );
  } else if (i.leverage > 1) {
    tick(`You can ${verb} ${shares(qty)} worth ${fmtINR(qty * entry)}, using ${fmtINR(plan.margin)} of your ${fmtINR(i.capital)}`);
  } else {
    tick(`You can ${verb} ${shares(qty)} for ${fmtINR(qty * entry)} of your ${fmtINR(i.capital)}`);
  }

  // 2. Is it moving, and the right way?
  if (i.changePct != null && Number.isFinite(i.changePct)) {
    const relVol = i.relVol != null && Number.isFinite(i.relVol) ? i.relVol : NaN;
    const dir = `${i.changePct >= 0 ? "up" : "down"} ${Math.abs(i.changePct).toFixed(1)}% today`;
    const vol = Number.isFinite(relVol) ? ` on ${relVol.toFixed(1)}× usual volume` : "";
    const against = i.checkDirection && (long ? i.changePct <= -AGAINST_DAY_PCT : i.changePct >= AGAINST_DAY_PCT);
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    if (against) {
      hold(1, "this goes against the stock's direction today", `${cap(dir)}, but this is a ${verb} — against the day's direction`);
    } else if (!isMoving({ changePct: i.changePct, relVol })) {
      hold(2, "this stock is barely moving today", `Only ${dir}${vol} — barely moving`);
    } else {
      tick(`${cap(dir)}${vol} — it is moving`);
    }
  }

  // 3. What you risk and what you can make, after charges.
  if (i.stop == null) {
    block(2, "no stop loss, so the loss cannot be limited", "No stop loss — the loss cannot be limited");
  } else if (pastStop) {
    block(7, "price is already past the stop", "Price is already past the stop loss — this signal is over");
  } else if (numbers == null) {
    reasons.push({ ok: false, text: "No shares to trade, so nothing to risk or make" });
  } else if (numbers.reward == null) {
    tick(`Risk ${money(numbers.risk)} after ${money(numbers.costs)} charges. No fixed target — you exit when the strategy says so`);
  } else if (numbers.reward <= 0) {
    block(12, "charges would eat the profit", `Risk ${money(numbers.risk)} to make nothing — the ${money(numbers.costs)} charges eat the profit`);
  } else if (numbers.reward < MIN_REWARD_TO_RISK * numbers.risk) {
    block(
      12,
      "the profit is too small for the risk after charges",
      `Risk ${money(numbers.risk)} to make ${money(numbers.reward)} after ${money(numbers.costs)} charges — not worth it`,
    );
  } else {
    tick(`Risk ${money(numbers.risk)} to make ${money(numbers.reward)} after ${money(numbers.costs)} charges`);
  }

  // 4. Is the stop far enough away?
  if (i.stop != null && !pastStop && entry > 0) {
    const stopPct = (Math.abs(entry - i.stop) / entry) * 100;
    if (stopPct < MIN_STOP_PCT) {
      block(11, "the stop is too close", `Stop is only ${stopPct.toFixed(2)}% away — normal price wiggles would hit it`);
    } else {
      tick(`Stop is ${stopPct.toFixed(1)}% away — far enough`);
    }
  }

  // 5. Timing.
  const when = ago(i.signalAgeSec);
  if (!i.inEntryWindow) {
    block(4, "outside trading hours", `Outside trading hours — new trades are taken ${ENTRY_START}–${ENTRY_END}`);
  } else if (i.fresh && i.signalAgeSec > MAX_SIGNAL_AGE_SEC[i.interval]) {
    const min = Math.max(2, Math.round(i.signalAgeSec / 60));
    block(5, `the signal is ${min} min old, wait for the next one`, `Signal fired ${min} min ago — too late, wait for the next one`);
  } else if (i.stoppedOutMinAgo != null) {
    block(
      6,
      `this stock hit your stop ${i.stoppedOutMinAgo} min ago`,
      `This stock hit your stop ${i.stoppedOutMinAgo} min ago — give it time before trying again`,
    );
  } else if (moved > MAX_CHASE) {
    block(8, "you missed it, do not chase", `Signal was at ${price(i.signalPrice)}, ${when} — price has already run, do not chase`);
  } else if (moved < -MAX_ADVERSE) {
    block(9, "price has gone against the signal", `Signal was at ${price(i.signalPrice)}, ${when} — price has gone against it since`);
  } else if (i.fresh) {
    tick(`Signal fired ${when}`);
  } else {
    tick(`Signal was at ${price(i.signalPrice)}, ${when} — price is still close to it`);
  }

  // 6. Has this strategy been making money?
  const p = i.strategy;
  const onStock = i.stock.trades >= STOCK_MIN_TRADES ? ` (on this stock: ${i.stock.wins} of ${i.stock.trades})` : "";
  if (i.disagree) {
    block(1, "strategies disagree on direction", "Strategies disagree here: some say buy, some say sell");
  } else if (p.trades === 0) {
    hold(0, "this strategy has no recent trades to judge it by", "No recent trades to judge this strategy by");
  } else if (p.nR < PROVEN_MIN_TRADES) {
    hold(
      0,
      "this strategy has too few recent trades to trust",
      `This strategy has only ${p.trades} recent ${p.trades === 1 ? "trade" : "trades"} — too few to trust${onStock}`,
    );
  } else if (p.netPnl <= 0) {
    hold(
      0,
      "this strategy has not been making money lately",
      `This strategy won ${p.wins} of ${p.trades} recent trades and lost money overall${onStock}`,
    );
  } else if (!isProven(p)) {
    hold(
      0,
      "this strategy has barely been making money lately",
      `This strategy won ${p.wins} of ${p.trades} recent trades but only just made money${onStock}`,
    );
  } else {
    tick(`This strategy won ${p.wins} of ${p.trades} recent trades and made money overall${onStock}`);
  }

  // 7. Your account for today, and how fresh the prices are.
  if (i.locked) {
    block(3, "you are done trading for today", i.lockedReason ?? "No more trades today");
  } else if (i.priceSource !== "upstox") {
    hold(3, "prices are delayed, check the live price first", "Prices are delayed by up to 15 minutes — check the live price first");
  } else if (i.tradesLeft != null) {
    tick(`Prices are live. You have ${i.tradesLeft} of ${MAX_TRADES_PER_DAY} trades left today`);
  } else {
    tick("Prices are live");
  }

  const first = (list: { rank: number; why: string }[]) => list.reduce((a, b) => (b.rank < a.rank ? b : a)).why;
  if (hard.length > 0) return { verdict: "skip", headline: `Skip — ${first(hard)}`, reasons };
  if (soft.length > 0) return { verdict: "wait", headline: `Wait — ${first(soft)}`, reasons };
  return { verdict: "take", headline: "Worth taking — every check passes", reasons };
}
