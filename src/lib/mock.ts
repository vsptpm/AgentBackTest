// Deterministic mock data used when the API routes are unavailable.
// Every generator is seeded, so renders are stable across reloads.

import {
  DEFAULT_COSTS,
  type BacktestConfig,
  type BacktestResult,
  type Candle,
  type EquityPoint,
  type FinderRow,
  type Interval,
  type Metrics,
  type MonthlyPnl,
  type Overlay,
  type ParamSpec,
  type Trade,
} from "@/lib/types";

export interface StrategyInfo {
  id: string;
  name: string;
  description: string;
  intervals: Interval[];
  params: ParamSpec[];
  warmup: number;
}

export interface SymbolInfo {
  symbol: string;
  name: string;
  kind: "index" | "stock";
  sector?: string;
}

/** mulberry32 PRNG */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MOCK_STRATEGIES: StrategyInfo[] = [
  {
    id: "ema-cross",
    name: "EMA Crossover",
    description:
      "Long when fast EMA crosses above slow EMA, short on the reverse cross. ATR-based stop.",
    intervals: ["1d", "15m", "5m"],
    warmup: 60,
    params: [
      { key: "fast", label: "Fast EMA", type: "number", default: 9, min: 3, max: 50, step: 1 },
      { key: "slow", label: "Slow EMA", type: "number", default: 21, min: 10, max: 200, step: 1 },
      { key: "atrMult", label: "ATR stop ×", type: "number", default: 2, min: 0.5, max: 5, step: 0.5 },
      {
        key: "exitMode",
        label: "Exit",
        type: "select",
        default: "cross",
        options: ["cross", "trail", "target"],
      },
    ],
  },
  {
    id: "orb",
    name: "Opening Range Breakout",
    description:
      "Break of the first N-minute range after 09:15 IST. Stop at range midpoint, square-off at session end.",
    intervals: ["15m", "5m"],
    warmup: 20,
    params: [
      { key: "rangeMins", label: "Range (min)", type: "number", default: 15, min: 5, max: 60, step: 5 },
      { key: "rr", label: "Reward:Risk", type: "number", default: 2, min: 1, max: 4, step: 0.5 },
      {
        key: "filter",
        label: "Trend filter",
        type: "select",
        default: "none",
        options: ["none", "vwap", "ema20"],
      },
    ],
  },
];

export const MOCK_SYMBOLS: SymbolInfo[] = [
  { symbol: "^NSEI", name: "NIFTY 50", kind: "index" },
  { symbol: "^NSEBANK", name: "NIFTY BANK", kind: "index" },
  { symbol: "RELIANCE.NS", name: "Reliance Industries", kind: "stock", sector: "Energy" },
  { symbol: "HDFCBANK.NS", name: "HDFC Bank", kind: "stock", sector: "Financials" },
  { symbol: "INFY.NS", name: "Infosys", kind: "stock", sector: "IT" },
];

const DAY = 86_400_000;

function computeMetrics(trades: Trade[], capital: number, equity: EquityPoint[], tradingDays: number): Metrics {
  const n = trades.length;
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const rs = trades.map((t) => t.rMultiple).filter((r) => Number.isFinite(r));
  let maxConsL = 0;
  let maxConsW = 0;
  let cl = 0;
  let cw = 0;
  for (const t of trades) {
    if (t.netPnl < 0) {
      cl++;
      cw = 0;
    } else if (t.netPnl > 0) {
      cw++;
      cl = 0;
    }
    maxConsL = Math.max(maxConsL, cl);
    maxConsW = Math.max(maxConsW, cw);
  }
  let peak = -Infinity;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.equity);
    const dd = peak - p.equity;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = (dd / peak) * 100;
    }
  }
  const rets = trades.map((t) => t.netPnl / capital);
  const mean = rets.reduce((s, r) => s + r, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  return {
    totalTrades: n,
    wins: wins.length,
    losses: losses.length,
    breakeven: n - wins.length - losses.length,
    winRate: wins.length / n,
    lossRate: losses.length / n,
    grossProfit,
    grossLoss,
    netPnl,
    netReturnPct: (netPnl / capital) * 100,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : Infinity,
    expectancy: netPnl / n,
    expectancyR: rs.reduce((s, r) => s + r, 0) / Math.max(1, rs.length),
    avgWin: grossProfit / Math.max(1, wins.length),
    avgLoss: -grossLoss / Math.max(1, losses.length),
    largestWin: Math.max(...trades.map((t) => t.netPnl)),
    largestLoss: Math.min(...trades.map((t) => t.netPnl)),
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    maxConsecutiveLosses: maxConsL,
    maxConsecutiveWins: maxConsW,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(20) : 0,
    avgBarsHeld: trades.reduce((s, t) => s + t.barsHeld, 0) / n,
    totalCosts: trades.reduce((s, t) => s + t.costs, 0),
    buyHoldReturnPct: 28.4,
    tradingDays,
  };
}

export function mockBacktestResult(partial: Partial<BacktestConfig> = {}): BacktestResult {
  const config: BacktestConfig = {
    symbol: "RELIANCE.NS",
    interval: "1d",
    from: "2023-10-30",
    to: "2026-10-30",
    strategyId: "ema-cross",
    params: { fast: 9, slow: 21, atrMult: 2, exitMode: "cross" },
    capital: 500_000,
    riskPerTrade: 0.01,
    positionFraction: 1,
    squareOffTime: "15:15",
    costs: DEFAULT_COSTS,
    allowShort: true,
    ...partial,
  };
  const rand = rng(42);
  const start = Date.UTC(2023, 9, 30, 3, 45); // 09:15 IST
  const bars = 740;
  // The chart, equity curve and trades all share one 300-slot grid over the period,
  // so trade times land exactly on candle times.
  const GRID = 300;
  const gridTime = (k: number) => start + Math.floor((k / GRID) * bars) * DAY;
  const tradeCount = 60;
  const trades: Trade[] = [];
  const reasons: Trade["exitReason"][] = ["signal", "stop", "target", "squareoff", "end"];
  let price = 2400;
  for (let i = 0; i < tradeCount; i++) {
    const entryK = Math.min(GRID - 2, Math.floor((i / tradeCount) * GRID) + Math.floor(rand() * 2));
    // held <= 3 keeps consecutive trades from sharing a bar (entries are 5 slots apart)
    const held = Math.min(GRID - 1 - entryK, 1 + Math.floor(rand() * 3));
    const side = rand() < 0.6 ? "long" : "short";
    price = price * (1 + (rand() - 0.48) * 0.06);
    const entryPrice = Math.round(price * 100) / 100;
    const riskPerShare = entryPrice * 0.02;
    const qty = Math.max(1, Math.floor((config.capital * config.riskPerTrade) / riskPerShare));
    const noStop = i % 9 === 4;
    const exitReason = noStop ? "signal" : reasons[Math.floor(rand() * (i < tradeCount - 1 ? 4 : 5))];
    // slight positive edge, fat left tail; stop/target exits land on their level
    const r =
      exitReason === "stop" ? -1 : exitReason === "target" ? 2 : rand() < 0.42 ? -(0.5 + rand() * 0.7) : 0.6 + rand() * 2.4;
    const move = (r * riskPerShare) / entryPrice;
    const exitPrice = Math.round(entryPrice * (1 + (side === "long" ? move : -move)) * 100) / 100;
    const gross = (side === "long" ? exitPrice - entryPrice : entryPrice - exitPrice) * qty;
    const costs = 40 + entryPrice * qty * 2 * 0.0006;
    const net = gross - costs;
    const dir = side === "long" ? 1 : -1;
    trades.push({
      id: i + 1,
      side,
      entryTime: gridTime(entryK),
      entryPrice,
      exitTime: gridTime(entryK + held),
      exitPrice,
      qty,
      grossPnl: Math.round(gross),
      costs: Math.round(costs),
      netPnl: Math.round(net),
      rMultiple: noStop ? NaN : net / (riskPerShare * qty),
      exitReason,
      entryReason: side === "long" ? "fast>slow" : "fast<slow",
      stop: noStop ? undefined : Math.round((entryPrice - dir * riskPerShare) * 100) / 100,
      target: noStop ? undefined : Math.round((entryPrice + dir * 2 * riskPerShare) * 100) / 100,
      barsHeld: held,
      mae: -(0.002 + rand() * 0.03),
      mfe: 0.003 + rand() * 0.05,
    });
  }

  // Synthetic OHLC: a noisy path through every trade's entry and exit so markers sit on the bars.
  const anchors = new Map<number, number>();
  for (const t of trades) {
    anchors.set(t.entryTime, t.entryPrice);
    anchors.set(t.exitTime, t.exitPrice);
  }
  const anchorTimes = [...anchors.keys()].sort((a, b) => a - b);
  const pathAt = (t: number): number => {
    if (t <= anchorTimes[0]) return anchors.get(anchorTimes[0])!;
    for (let i = 1; i < anchorTimes.length; i++) {
      if (t <= anchorTimes[i]) {
        const t0 = anchorTimes[i - 1];
        const t1 = anchorTimes[i];
        const f = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
        return anchors.get(t0)! + (anchors.get(t1)! - anchors.get(t0)!) * f;
      }
    }
    return anchors.get(anchorTimes[anchorTimes.length - 1])!;
  };
  const candles: Candle[] = [];
  let prevClose = pathAt(gridTime(0));
  for (let k = 0; k < GRID; k++) {
    const t = gridTime(k);
    const base = pathAt(t);
    const close = anchors.has(t) ? base : base * (1 + (rand() - 0.5) * 0.008);
    const open = k === 0 ? close * (1 + (rand() - 0.5) * 0.004) : prevClose * (1 + (rand() - 0.5) * 0.004);
    const hi = Math.max(open, close) * (1 + rand() * 0.006);
    const lo = Math.min(open, close) * (1 - rand() * 0.006);
    candles.push({
      time: t,
      open: Math.round(open * 100) / 100,
      high: Math.round(hi * 100) / 100,
      low: Math.round(lo * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: Math.round(2_000_000 + rand() * 6_000_000),
    });
    prevClose = close;
  }

  // One overlay: the slow EMA from the strategy params.
  const slow = typeof config.params.slow === "number" ? config.params.slow : 21;
  const alpha = 2 / (slow + 1);
  let ema = candles[0].close;
  const emaPoints: Overlay["points"] = [];
  candles.forEach((c, k) => {
    ema = k === 0 ? c.close : c.close * alpha + ema * (1 - alpha);
    if (k >= slow) emaPoints.push({ time: c.time, value: Math.round(ema * 100) / 100 });
  });
  const overlays: Overlay[] = [{ name: `EMA ${slow}`, color: "#f59e0b", style: "line", points: emaPoints }];

  const equity: EquityPoint[] = [];
  let eq = config.capital;
  let peak = eq;
  let ti = 0;
  for (let i = 0; i < GRID; i++) {
    const t = gridTime(i);
    while (ti < trades.length && trades[ti].exitTime <= t) {
      eq += trades[ti].netPnl;
      ti++;
    }
    peak = Math.max(peak, eq);
    equity.push({ time: t, equity: Math.round(eq), drawdown: (peak - eq) / peak });
  }

  const monthlyMap = new Map<string, MonthlyPnl>();
  for (const t of trades) {
    const d = new Date(t.exitTime + 5.5 * 3_600_000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const row = monthlyMap.get(key) ?? { month: key, pnl: 0, trades: 0 };
    row.pnl += t.netPnl;
    row.trades += 1;
    monthlyMap.set(key, row);
  }
  const monthly = [...monthlyMap.values()].sort((a, b) => a.month.localeCompare(b.month));

  return {
    config,
    trades,
    equity,
    metrics: computeMetrics(trades, config.capital, equity, new Set(candles.map((c) => c.time)).size),
    monthly,
    period: { from: start, to: start + bars * DAY, bars },
    warnings: ["MOCK DATA — API route unavailable, showing a deterministic sample result."],
    candles,
    overlays,
  };
}

function mockMetrics(rand: () => number, bias: number): Metrics {
  const lossRate = Math.min(0.75, Math.max(0.2, 0.3 + bias + (rand() - 0.5) * 0.2));
  const pf = Math.max(0.6, 1.9 - lossRate * 1.6 + (rand() - 0.5) * 0.4);
  const n = 25 + Math.floor(rand() * 90);
  const netPnl = (pf - 1) * 60_000 + (rand() - 0.5) * 20_000;
  return {
    totalTrades: n,
    wins: Math.round(n * (1 - lossRate)),
    losses: Math.round(n * lossRate),
    breakeven: 0,
    winRate: 1 - lossRate,
    lossRate,
    grossProfit: Math.max(0, netPnl) + 80_000,
    grossLoss: 80_000,
    netPnl,
    netReturnPct: netPnl / 5_000,
    profitFactor: pf,
    expectancy: netPnl / n,
    expectancyR: (pf - 1) * 0.5 + (rand() - 0.5) * 0.2,
    avgWin: 4_000,
    avgLoss: -2_200,
    largestWin: 14_000,
    largestLoss: -6_500,
    maxDrawdown: 20_000 + rand() * 60_000,
    maxDrawdownPct: 4 + rand() * 18,
    maxConsecutiveLosses: 3 + Math.floor(rand() * 6),
    maxConsecutiveWins: 3 + Math.floor(rand() * 6),
    sharpe: (pf - 1) * 1.4,
    avgBarsHeld: 4 + rand() * 10,
    totalCosts: n * 95,
    buyHoldReturnPct: 22,
    tradingDays: 250,
  };
}

export function mockFinderRows(): FinderRow[] {
  const rand = rng(7);
  const rows: FinderRow[] = [];
  const symbols = MOCK_SYMBOLS.map((s) => s.symbol);
  for (let i = 0; i < 10; i++) {
    const strat = MOCK_STRATEGIES[i % 2];
    const inSample = mockMetrics(rand, -0.05);
    const outSample = mockMetrics(rand, i % 3 === 0 ? 0.2 : 0.0);
    const params: Record<string, number | string> = {};
    for (const p of strat.params) {
      params[p.key] =
        p.type === "select" && p.options
          ? p.options[Math.floor(rand() * p.options.length)]
          : Math.round(((p.min ?? 1) + rand() * ((p.max ?? 10) - (p.min ?? 1))) / (p.step ?? 1)) *
            (p.step ?? 1);
    }
    rows.push({
      symbol: symbols[i % symbols.length],
      strategyId: strat.id,
      strategyName: strat.name,
      params,
      inSample,
      outSample,
      score: (1 - outSample.lossRate) * 50 + outSample.profitFactor * 20 - outSample.maxDrawdownPct,
    });
  }
  return rows;
}
