import type { CostModel, Interval, Side } from "@/lib/types";

/** 5m / 15m are intraday; 1d is delivery. */
export function isIntradayInterval(interval: Interval): boolean {
  return interval === "5m" || interval === "15m";
}

/** Delivery STT: 0.1% on both legs. */
const DELIVERY_STT_RATE = 0.001;
/** Delivery stamp duty: 0.015% on buy leg. */
const DELIVERY_STAMP_RATE = 0.00015;

export interface TradeCostArgs {
  side: Side;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  model: CostModel;
  intraday: boolean;
}

export interface TradeCostBreakdown {
  /** Turnover of the buy leg (entry for long, exit for short). */
  buyTurnover: number;
  /** Turnover of the sell leg (exit for long, entry for short). */
  sellTurnover: number;
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  total: number;
}

/** Per executed order: flat fee or a percentage of the order value, whichever is lower. */
function brokerageForLeg(turnover: number, model: CostModel): number {
  return Math.min(model.brokeragePerOrder, turnover * model.brokerageRate);
}

/**
 * Indian equity round-trip cost breakdown.
 * - Brokerage: per leg min(model.brokeragePerOrder, model.brokerageRate x leg turnover).
 *   Upstox intraday equity: Rs 20 or 0.1%, whichever is lower.
 * - STT: intraday -> model.sttRate on sell leg only; delivery -> 0.1% both legs.
 * - Exchange txn + SEBI: model rates on total turnover.
 * - Stamp duty: buy leg only; intraday model.stampRate, delivery 0.015%.
 * - GST: model.gstRate on (brokerage + exchange + sebi).
 */
export function breakdownTradeCosts(args: TradeCostArgs): TradeCostBreakdown {
  const { side, entryPrice, exitPrice, qty, model, intraday } = args;
  const entryTurnover = entryPrice * qty;
  const exitTurnover = exitPrice * qty;
  const buyTurnover = side === "long" ? entryTurnover : exitTurnover;
  const sellTurnover = side === "long" ? exitTurnover : entryTurnover;
  const totalTurnover = buyTurnover + sellTurnover;

  const brokerage =
    brokerageForLeg(buyTurnover, model) + brokerageForLeg(sellTurnover, model);
  const stt = intraday
    ? sellTurnover * model.sttRate
    : totalTurnover * DELIVERY_STT_RATE;
  const exchange = totalTurnover * model.exchangeRate;
  const sebi = totalTurnover * model.sebiRate;
  const stamp = buyTurnover * (intraday ? model.stampRate : DELIVERY_STAMP_RATE);
  const gst = (brokerage + exchange + sebi) * model.gstRate;
  const total = brokerage + stt + exchange + sebi + stamp + gst;

  return { buyTurnover, sellTurnover, brokerage, stt, exchange, sebi, stamp, gst, total };
}

/** Total INR cost of a round trip. See breakdownTradeCosts for the rules. */
export function computeTradeCosts(args: TradeCostArgs): number {
  return breakdownTradeCosts(args).total;
}
