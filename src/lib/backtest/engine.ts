import type {
  BacktestConfig,
  BacktestResult,
  Candle,
  EquityPoint,
  Side,
  Signal,
  Strategy,
  StrategyContext,
  Trade,
} from "@/lib/types";
import { IST_OFFSET_MS } from "@/lib/types";
import { computeTradeCosts, isIntradayInterval } from "./costs";
import { computeMetrics, computeMonthly } from "./metrics";

type ExitReason = Trade["exitReason"];

interface OpenPosition {
  side: Side;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  qty: number;
  /** Working stop. May be moved to entryPrice by breakevenAtR. */
  stop?: number;
  /** Stop as given at entry; reported on the Trade and never moved. */
  initialStop?: number;
  /** |entryPrice - initialStop|, 0 if no stop. rMultiple always uses this. */
  initialRisk: number;
  /** True once the stop has been moved to breakeven. */
  atBreakeven: boolean;
  target?: number;
  entryReason?: string;
  /** Lowest low / highest high seen while held (for MAE / MFE). */
  minLow: number;
  maxHigh: number;
}

/** IST "HH:MM" of an epoch-ms timestamp. */
export function istTimeHHMM(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
}

/** IST calendar day "YYYY-MM-DD" of an epoch-ms timestamp. */
export function istDayKey(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function emptyResult(config: BacktestConfig, candles: Candle[], warnings: string[]): BacktestResult {
  const first = candles[0]?.time ?? 0;
  const last = candles[candles.length - 1]?.time ?? 0;
  return {
    config,
    trades: [],
    equity: [],
    metrics: computeMetrics([], [], config.capital, candles),
    monthly: [],
    period: { from: first, to: last, bars: 0 },
    warnings,
  };
}

/**
 * Run a strategy over candles. Rules (see README in final report):
 * - onBar is called for bars warmup..n-1. The strategy must only read candles[0..index]
 *   (not enforced here).
 * - One position at a time. Signals fill at the NEXT bar's open with adverse slippage.
 *   A signal on the last bar is dropped.
 * - Stops/targets are fixed at entry (no trailing). Stop is checked before target on
 *   every bar from the fill bar onward; both hit in one bar -> stop. Gaps through the
 *   stop fill at the open.
 * - Slippage: entries, targets, signal exits, square-offs and the end-of-data exit take
 *   costs.slippage against the trade. Stop exits (at the stop or gapped through at the open)
 *   are market orders into a move and take costs.stopSlippage, default 2 x costs.slippage.
 * - Intraday intervals square off at the first bar whose IST time >= squareOffTime,
 *   at that bar's open, and block new entries for the rest of that IST day. Entries whose
 *   fill would land on another IST day are dropped.
 * - Intraday positions never ride overnight: if a position is still open when bar i starts
 *   a new IST day (the data had no bar at/after squareOffTime), it is closed first thing at
 *   the previous bar's close with adverse slippage, exit index i-1, reason "squareoff", and
 *   a warning is added.
 * - Open position at end of data is closed at the last close with adverse slippage, reason "end".
 * - Sizing never compounds: it always uses config.capital.
 * - Sizing with a stop honours the stated risk after friction:
 *     qty0 = floor(risk / (|fill - stop| + fill * stopSlippage))
 *     qty  = floor(risk / (|fill - stop| + fill * stopSlippage + costs(qty0, fill -> stop) / qty0))
 *   where risk = capital * riskPerTrade, so a stopped trade loses about the stated risk net of
 *   charges and stop slippage (a gap through the stop can still lose more). Without a stop,
 *   qty = floor(capital * positionFraction / fill). The leverage cap applies afterwards.
 *
 * Optional risk controls (all undefined = off, legacy behaviour):
 * - maxFrictionR (needs a stop): frictionR = (round-trip charges at entry = exit = fill
 *   + (slippage + stopSlippage) * fill * qty) / (qty * |fill - stop|). Entries with
 *   frictionR > maxFrictionR are skipped with a single warning. 0 = off.
 * - entryStart / entryEnd (intraday only): a pending entry is dropped when its FILL bar's
 *   IST time is < entryStart or >= entryEnd. This does not block the rest of the day.
 * - maxTradesPerDay (intraday only): entries filled are counted per IST day; once the count
 *   reaches the limit, further pending entries that day are dropped. 0 = unlimited.
 * - maxDailyLoss (intraday only): realised net P&L is tracked per IST day of the EXIT bar;
 *   once it is <= -(capital * maxDailyLoss), further pending entries that day are dropped.
 *   Open positions are not force-closed. 0 = off.
 * - leverage: qty cap is floor(capital * leverage / fillPrice). Non-finite or < 1 -> 1.
 *   It only raises the cap; risk-based and positionFraction sizing are computed as above.
 * - breakevenAtR (needs a stop): on bars AFTER the fill bar, once that bar's stop/target
 *   check has left the position open, if the bar's favourable extreme (high for longs, low
 *   for shorts) has reached entry +/- breakevenAtR * initial risk, the working stop moves
 *   to the entry price. It takes effect from the NEXT bar (no intrabar look-ahead). The
 *   exit reason stays "stop"; Trade.stop and rMultiple keep using the INITIAL stop/risk.
 */
export function runBacktest(config: BacktestConfig, candles: Candle[], strategy: Strategy): BacktestResult {
  const warningSet = new Set<string>();
  const warn = (msg: string) => warningSet.add(msg);

  const n = candles.length;
  const warmup = Math.max(0, Math.floor(strategy.warmup));
  if (n === 0) {
    warn("No candles supplied.");
    return emptyResult(config, candles, [...warningSet]);
  }
  if (n <= warmup) {
    warn(`Not enough bars: ${n} supplied, strategy needs more than ${warmup} for warmup.`);
    return emptyResult(config, candles, [...warningSet]);
  }

  const intraday = isIntradayInterval(config.interval);
  const slippage = config.costs.slippage;
  /** Stop-loss exits are market orders into a move: worse fills than a planned exit. */
  const stopSlippage = config.costs.stopSlippage ?? 2 * slippage;
  const capital = config.capital;
  const lastIndex = n - 1;

  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  let realised = 0;
  let peak = -Infinity;

  let position: OpenPosition | null = null;
  let pendingEntry: Signal | null = null;
  let pendingExit = false;
  /** IST day on which a square-off happened; no new entries for the rest of it. */
  let blockedDay: string | null = null;

  // Optional risk controls (normalised; see doc comment).
  const entryStart = intraday && config.entryStart ? config.entryStart : null;
  const entryEnd = intraday && config.entryEnd ? config.entryEnd : null;
  const maxTradesPerDay =
    intraday && config.maxTradesPerDay !== undefined && config.maxTradesPerDay > 0 ? config.maxTradesPerDay : 0;
  const maxDailyLossInr =
    intraday && config.maxDailyLoss !== undefined && config.maxDailyLoss > 0 ? capital * config.maxDailyLoss : 0;
  const leverage =
    config.leverage !== undefined && Number.isFinite(config.leverage) && config.leverage >= 1 ? config.leverage : 1;
  const breakevenAtR =
    config.breakevenAtR !== undefined && Number.isFinite(config.breakevenAtR) && config.breakevenAtR > 0
      ? config.breakevenAtR
      : 0;
  const maxFrictionR =
    config.maxFrictionR !== undefined && Number.isFinite(config.maxFrictionR) && config.maxFrictionR > 0
      ? config.maxFrictionR
      : 0;
  /** Per IST day (intraday only): entries filled, and realised net P&L by exit day. */
  const dayEntries = new Map<string, number>();
  const dayPnl = new Map<string, number>();

  const closePosition = (pos: OpenPosition, exitIndex: number, exitPrice: number, reason: ExitReason) => {
    const bar = candles[exitIndex];
    const dir = pos.side === "long" ? 1 : -1;
    const grossPnl = (exitPrice - pos.entryPrice) * pos.qty * dir;
    const costs = computeTradeCosts({
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      qty: pos.qty,
      model: config.costs,
      intraday,
    });
    const netPnl = grossPnl - costs;
    const riskPerShare = pos.initialRisk;
    const rMultiple = riskPerShare > 0 ? netPnl / (pos.qty * riskPerShare) : NaN;
    const adverse = pos.side === "long" ? pos.entryPrice - pos.minLow : pos.maxHigh - pos.entryPrice;
    const favourable = pos.side === "long" ? pos.maxHigh - pos.entryPrice : pos.entryPrice - pos.minLow;

    trades.push({
      id: trades.length + 1,
      side: pos.side,
      entryTime: pos.entryTime,
      entryPrice: pos.entryPrice,
      exitTime: bar.time,
      exitPrice,
      qty: pos.qty,
      grossPnl,
      costs,
      netPnl,
      rMultiple,
      exitReason: reason,
      entryReason: pos.entryReason,
      stop: pos.initialStop,
      target: pos.target,
      barsHeld: exitIndex - pos.entryIndex,
      mae: Math.max(0, adverse) / pos.entryPrice,
      mfe: Math.max(0, favourable) / pos.entryPrice,
    });
    realised += netPnl;
    if (intraday) {
      const key = istDayKey(bar.time);
      dayPnl.set(key, (dayPnl.get(key) ?? 0) + netPnl);
    }
    position = null;
  };

  const tryOpenPosition = (signal: Signal, i: number): OpenPosition | null => {
    const bar = candles[i];
    const side = signal.side;
    const fillPrice = side === "long" ? bar.open * (1 + slippage) : bar.open * (1 - slippage);
    if (!(fillPrice > 0)) {
      warn(`Skipped entry at bar ${i}: non-positive fill price ${fillPrice}.`);
      return null;
    }

    const stop = signal.stop;
    if (stop !== undefined) {
      const wrongSide = side === "long" ? stop >= fillPrice : stop <= fillPrice;
      if (wrongSide) {
        warn(
          `Skipped ${side} entry: stop ${stop} is on the wrong side of fill price ${fillPrice.toFixed(2)}.`,
        );
        return null;
      }
    }

    let qty: number;
    if (stop !== undefined) {
      // Risk per share = stop distance + expected stop slippage + charges, so a stopped
      // trade loses about the stated risk in rupees, not the stated risk plus friction.
      const riskInr = capital * config.riskPerTrade;
      const perShare = Math.abs(fillPrice - stop) + fillPrice * stopSlippage;
      const qty0 = Math.floor(riskInr / perShare);
      if (qty0 >= 1) {
        const costs0 = computeTradeCosts({
          side,
          entryPrice: fillPrice,
          exitPrice: stop,
          qty: qty0,
          model: config.costs,
          intraday,
        });
        qty = Math.floor(riskInr / (perShare + costs0 / qty0));
      } else {
        qty = 0;
      }
    } else {
      qty = Math.floor((capital * config.positionFraction) / fillPrice);
    }
    const maxAffordable = Math.floor((capital * leverage) / fillPrice);
    if (qty > maxAffordable) qty = maxAffordable;

    if (qty < 1) {
      warn(`Capital too small for ${side} entry at price ${fillPrice.toFixed(2)} (qty < 1); entry skipped.`);
      return null;
    }

    if (maxFrictionR > 0 && stop !== undefined) {
      const charges = computeTradeCosts({
        side,
        entryPrice: fillPrice,
        exitPrice: fillPrice,
        qty,
        model: config.costs,
        intraday,
      });
      const friction = charges + (slippage + stopSlippage) * fillPrice * qty;
      const frictionR = friction / (qty * Math.abs(fillPrice - stop));
      if (frictionR > maxFrictionR) {
        warn(
          `Skipped entries where charges and slippage exceed ${+(maxFrictionR * 100).toFixed(1)}% of the risk.`,
        );
        return null;
      }
    }

    return {
      side,
      entryIndex: i,
      entryTime: bar.time,
      entryPrice: fillPrice,
      qty,
      stop,
      initialStop: stop,
      initialRisk: stop !== undefined ? Math.abs(fillPrice - stop) : 0,
      atBreakeven: false,
      target: signal.target,
      entryReason: signal.reason,
      minLow: bar.low,
      maxHigh: bar.high,
    };
  };

  /** Check stop/target on bar i. Returns true if the position was closed. */
  const checkStopTarget = (pos: OpenPosition, i: number): boolean => {
    const bar = candles[i];
    if (pos.side === "long") {
      if (pos.stop !== undefined) {
        if (bar.open < pos.stop) {
          closePosition(pos, i, bar.open * (1 - stopSlippage), "stop");
          return true;
        }
        if (bar.low <= pos.stop) {
          closePosition(pos, i, pos.stop * (1 - stopSlippage), "stop");
          return true;
        }
      }
      if (pos.target !== undefined && bar.high >= pos.target) {
        // Gap above the target fills at the open (a resting limit order would).
        const px = bar.open > pos.target ? bar.open : pos.target;
        closePosition(pos, i, px * (1 - slippage), "target");
        return true;
      }
    } else {
      if (pos.stop !== undefined) {
        if (bar.open > pos.stop) {
          closePosition(pos, i, bar.open * (1 + stopSlippage), "stop");
          return true;
        }
        if (bar.high >= pos.stop) {
          closePosition(pos, i, pos.stop * (1 + stopSlippage), "stop");
          return true;
        }
      }
      if (pos.target !== undefined && bar.low <= pos.target) {
        const px = bar.open < pos.target ? bar.open : pos.target;
        closePosition(pos, i, px * (1 + slippage), "target");
        return true;
      }
    }
    return false;
  };

  for (let i = warmup; i < n; i++) {
    const bar = candles[i];
    const dayKey = intraday ? istDayKey(bar.time) : null;
    const atOrPastSquareOff = intraday && istTimeHHMM(bar.time) >= config.squareOffTime;

    // 0. MIS positions never ride overnight: a position still open when a new IST day
    //    starts is closed at the previous bar's close, before anything else on this bar.
    if (intraday && position && i > 0 && istDayKey(candles[i - 1].time) !== dayKey) {
      const pos: OpenPosition = position;
      const prevClose = candles[i - 1].close;
      const px = pos.side === "long" ? prevClose * (1 - slippage) : prevClose * (1 + slippage);
      closePosition(pos, i - 1, px, "squareoff");
      warn("Position carried past the session end; closed at the last bar of the day.");
      pendingExit = false;
      // The previous bar's equity point was marked to market while the position was open.
      if (equity.length > 0) {
        const eq = capital + realised;
        equity[equity.length - 1] = { time: candles[i - 1].time, equity: eq, drawdown: eq - peak };
      }
    }

    // 1. Fill signals emitted on the previous bar at this bar's open.
    if (pendingExit) {
      pendingExit = false;
      if (position) {
        const pos: OpenPosition = position;
        const px = pos.side === "long" ? bar.open * (1 - slippage) : bar.open * (1 + slippage);
        closePosition(pos, i, px, "signal");
      }
    }
    if (pendingEntry) {
      const signal = pendingEntry;
      pendingEntry = null;
      if (!position) {
        if (atOrPastSquareOff) {
          // Would be squared off at the same price on the same bar; pointless round trip.
          blockedDay = dayKey;
        } else if (dayKey !== null && entryStart !== null && istTimeHHMM(bar.time) < entryStart) {
          // Before the entry window: dropped.
        } else if (dayKey !== null && entryEnd !== null && istTimeHHMM(bar.time) >= entryEnd) {
          // At/after the end of the entry window: dropped.
        } else if (dayKey !== null && maxTradesPerDay > 0 && (dayEntries.get(dayKey) ?? 0) >= maxTradesPerDay) {
          // Daily trade limit reached: dropped.
        } else if (dayKey !== null && maxDailyLossInr > 0 && (dayPnl.get(dayKey) ?? 0) <= -maxDailyLossInr) {
          // Daily loss limit reached: dropped.
        } else {
          position = tryOpenPosition(signal, i);
          if (position && dayKey !== null) dayEntries.set(dayKey, (dayEntries.get(dayKey) ?? 0) + 1);
        }
      }
    }

    // 2. Manage the open position on this bar.
    if (position) {
      const pos: OpenPosition = position;
      if (bar.low < pos.minLow) pos.minLow = bar.low;
      if (bar.high > pos.maxHigh) pos.maxHigh = bar.high;

      if (atOrPastSquareOff) {
        blockedDay = dayKey;
        const px = pos.side === "long" ? bar.open * (1 - slippage) : bar.open * (1 + slippage);
        closePosition(pos, i, px, "squareoff");
      } else {
        const closed = checkStopTarget(pos, i);
        // Breakeven: only on bars after the fill bar, and only effective from the next bar.
        if (!closed && breakevenAtR > 0 && !pos.atBreakeven && pos.initialRisk > 0 && i > pos.entryIndex) {
          const trigger = breakevenAtR * pos.initialRisk;
          const reached =
            pos.side === "long" ? bar.high >= pos.entryPrice + trigger : bar.low <= pos.entryPrice - trigger;
          if (reached) {
            pos.stop = pos.entryPrice;
            pos.atBreakeven = true;
          }
        }
      }
    } else if (atOrPastSquareOff) {
      blockedDay = dayKey;
    }

    // 3. Ask the strategy.
    const held: OpenPosition | null = position;
    const ctx: StrategyContext = {
      candles,
      index: i,
      params: config.params,
      position: held ? { side: held.side, entryPrice: held.entryPrice, entryIndex: held.entryIndex } : null,
      interval: config.interval,
    };
    const signal = strategy.onBar(ctx);

    if (signal) {
      if (signal.action === "enter") {
        if (position) {
          // Already in a position: ignore.
        } else if (signal.side === "short" && !config.allowShort) {
          warn("Short entry signals ignored because allowShort is false.");
        } else if (i === lastIndex) {
          // No next bar to fill on: dropped.
        } else if (intraday && (blockedDay === dayKey || istDayKey(candles[i + 1].time) !== dayKey)) {
          // After square-off, or last bar of the IST day (fill would be tomorrow): dropped.
        } else {
          pendingEntry = signal;
        }
      } else if (signal.action === "exit") {
        if (position && i !== lastIndex) pendingExit = true;
      }
    }

    // 4. Equity: realised + mark-to-market at close.
    let unrealised = 0;
    if (position) {
      const pos: OpenPosition = position;
      unrealised = pos.side === "long" ? (bar.close - pos.entryPrice) * pos.qty : (pos.entryPrice - bar.close) * pos.qty;
    }
    const eq = capital + realised + unrealised;
    if (eq > peak) peak = eq;
    equity.push({ time: bar.time, equity: eq, drawdown: eq - peak });
  }

  // 5. End of data: close any open position at the last close, with adverse slippage.
  if (position) {
    const pos: OpenPosition = position;
    const lastClose = candles[lastIndex].close;
    const px = pos.side === "long" ? lastClose * (1 - slippage) : lastClose * (1 + slippage);
    closePosition(pos, lastIndex, px, "end");
    const eq = capital + realised;
    if (eq > peak) peak = eq;
    equity[equity.length - 1] = { time: candles[lastIndex].time, equity: eq, drawdown: eq - peak };
  }

  const usedCandles = candles.slice(warmup);
  return {
    config,
    trades,
    equity,
    metrics: computeMetrics(trades, equity, capital, usedCandles),
    monthly: computeMonthly(trades),
    period: { from: candles[warmup].time, to: candles[lastIndex].time, bars: n - warmup },
    warnings: [...warningSet],
  };
}
