// "Trading desk": five specialised agents and an orchestrator. This file is the contract between
// them. Dependency-free except for shared app types; safe to import in the browser.

import type { Side } from "@/lib/types";

export type Bias = "bullish" | "bearish" | "sideways" | "no-trade";

/** Agent 1/3 — what the chart says about one stock right now. */
export interface TechnicalView {
  symbol: string;
  /** Last completed bar's close and its time (epoch ms). */
  price: number;
  time: number;
  bias: Bias;
  /** −100 (strongly bearish) … +100 (strongly bullish). */
  score: number;
  indicators: {
    vwap: number;
    rsi: number;
    macd: number;
    macdSignal: number;
    ema9: number;
    ema20: number;
    ema50: number;
    ema200: number;
    prevDayHigh: number;
    prevDayLow: number;
    /** First 15 minutes of today's session. */
    orHigh: number;
    orLow: number;
    /** Today's volume so far ÷ usual by this time. NaN if unknown. */
    relVol: number;
    /** ATR(14) of 5-minute bars, in rupees and as % of price. */
    atr: number;
    atrPct: number;
    dayChangePct: number;
  };
  /** Plain-language findings; ok = supports the bias. */
  reasons: { ok: boolean; text: string }[];
}

export interface DeskAccount {
  /** Money set aside for intraday today, INR. */
  capital: number;
  /** Fraction of capital one trade may lose, e.g. 0.01. */
  riskPerTrade: number;
  /** Fraction of capital that ends the day when lost, e.g. 0.02. */
  maxDailyLoss: number;
  /** Intraday margin multiplier, 1–5. */
  leverage: number;
  maxPositions: number;
}

/** Agent 3 — a complete trade proposal. */
export interface TradePlan {
  symbol: string;
  side: Side;
  entry: number;
  entryZone: [number, number];
  /** What must happen before entering, in words. */
  trigger: string;
  stop: number;
  /** One to three targets, nearest first. */
  targets: number[];
  qty: number;
  /** Margin needed = qty × entry ÷ leverage. */
  capitalRequired: number;
  /** Loss at the stop including charges, INR. */
  maxLoss: number;
  /** To the first target, after charges. */
  rewardToRisk: number;
  /** Estimated round-trip brokerage and taxes, INR. */
  costs: number;
  holding: string;
  invalidation: string;
  timeExit: string;
}

/** Agent 4 — replay of past sessions plus simulated price paths. Probabilities are simulated, not promised. */
export interface SimResult {
  paths: number;
  /** Share of simulated paths that hit the first target / the stop / neither before the session exit. */
  pTarget: number;
  pStop: number;
  pNeither: number;
  /** Mean and median result per trade after charges, INR. */
  expectedValue: number;
  medianPnl: number;
  best: number;
  worst: number;
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number };
  /** Result distribution for a bar chart. */
  histogram: { from: number; to: number; count: number }[];
  /** Chance of hitting the daily loss limit if this trade were repeated all day at this size. */
  riskOfRuin: number;
  scenarios: { name: string; pnl: number; note: string }[];
  /** The same entry rule replayed on earlier real sessions. */
  replay: { sessions: number; wins: number; losses: number; flat: number; winRate: number; avgPnl: number };
}

export interface NewsItem {
  headline: string;
  source: string;
  /** Epoch ms, or null if the feed gave none. */
  publishedAt: number | null;
  url: string;
  symbol: string;
  sentiment: "positive" | "negative" | "neutral";
  impact: "high" | "medium" | "low";
  /** "official" = exchange/company filing; "news-report" = a named outlet; "unverified" = anything else. */
  verified: "official" | "news-report" | "unverified";
}

export interface RiskVerdict {
  approved: boolean;
  checks: { ok: boolean; text: string }[];
  /** The first failed check, in words. */
  reason?: string;
}

export type Decision = "BUY CANDIDATE" | "SELL CANDIDATE" | "NO TRADE";

export interface DeskCandidate {
  symbol: string;
  /** Today's move and volume from the scanner. */
  changePct: number;
  relVol: number;
  technical: TechnicalView;
  plan: TradePlan | null;
  sim: SimResult | null;
  news: NewsItem[];
  risk: RiskVerdict;
  decision: Decision;
  /** One or two sentences: why this decision. */
  summary: string;
}

export interface DeskStep {
  agent: "Market scanner" | "Technical analyst" | "News analyst" | "Trade strategist" | "Time machine" | "Risk manager";
  status: "ok" | "warn" | "fail";
  detail: string;
  ms: number;
}

export interface DeskRequest {
  capital: number;
  riskPerTrade: number;
  maxDailyLoss: number;
  leverage: number;
  /** How many of the most active affordable stocks to analyse (3–8). */
  top: number;
}

export interface DeskResponse {
  asOf: number;
  marketOpen: boolean;
  priceSource: "upstox" | "yahoo" | "mixed";
  account: DeskAccount;
  universe: { poolSize: number; affordableCount: number; maxPrice: number };
  steps: DeskStep[];
  candidates: DeskCandidate[];
  warnings: string[];
}
