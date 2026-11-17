import { describe, expect, it } from "vitest";
import { assessRisk, type RiskInputs } from "./risk";
import type { SimResult, TechnicalView, TradePlan } from "./types";

// 11:00 IST on Monday 15 Jan 2024: inside trading hours.
const NOW = Date.UTC(2024, 0, 15, 11, 0) - 5.5 * 3600_000;

const plan: TradePlan = {
  symbol: "ITC.NS",
  side: "long",
  entry: 300,
  entryZone: [299.5, 300.5],
  trigger: "",
  stop: 297,
  targets: [306, 309],
  qty: 3,
  capitalRequired: 180,
  maxLoss: 9.5,
  rewardToRisk: 1.7,
  costs: 0.5,
  holding: "",
  invalidation: "",
  timeExit: "",
};
const technical = { symbol: "ITC.NS", indicators: { atrPct: 0.3 } } as TechnicalView;
const sim = { expectedValue: 2, riskOfRuin: 0.05 } as SimResult;

const base = (over: Partial<RiskInputs> = {}): RiskInputs => ({
  plan,
  technical,
  sim,
  news: [],
  account: { capital: 1000, riskPerTrade: 0.01, maxDailyLoss: 0.02, leverage: 5, maxPositions: 1 },
  book: { inUse: 0, resultToday: 0, openSymbols: [], locked: false },
  relVol: 2,
  pricesLive: true,
  now: NOW,
  ...over,
});

describe("assessRisk", () => {
  it("approves a trade that passes every check", () => {
    const v = assessRisk(base());
    expect(v.reason).toBeUndefined();
    expect(v.approved).toBe(true);
    expect(v.checks.every((c) => c.ok)).toBe(true);
  });
  it("rejects a loss bigger than the per-trade limit", () => {
    const v = assessRisk(base({ plan: { ...plan, maxLoss: 25 } }));
    expect(v.approved).toBe(false);
    expect(v.reason).toMatch(/more than your ₹10 per-trade limit/);
  });
  it("rejects when a loss would breach the daily stop", () => {
    expect(assessRisk(base({ book: { inUse: 0, resultToday: -15, openSymbols: [], locked: false } })).reason).toMatch(/past your stop/);
  });
  it("does not loosen limits after a profitable day", () => {
    const v = assessRisk(base({ plan: { ...plan, maxLoss: 25 }, book: { inUse: 0, resultToday: 500, openSymbols: [], locked: false } }));
    expect(v.approved).toBe(false);
  });
  it("rejects without free money, at the position limit, or when locked", () => {
    expect(assessRisk(base({ book: { inUse: 900, resultToday: 0, openSymbols: [], locked: false } })).reason).toMatch(/only ₹100 is free/);
    expect(assessRisk(base({ book: { inUse: 0, resultToday: 0, openSymbols: ["TCS.NS"], locked: false } })).reason).toMatch(/limit of 1 open/);
    expect(assessRisk(base({ book: { inUse: 0, resultToday: 0, openSymbols: [], locked: true, lockedReason: "Two losses in a row" } })).reason).toBe("Two losses in a row");
  });
  it("rejects delayed prices, off-hours, poor reward, heavy charges and a losing simulation", () => {
    expect(assessRisk(base({ pricesLive: false })).reason).toMatch(/delayed/);
    expect(assessRisk(base({ now: NOW + 5 * 3600_000 })).reason).toMatch(/Outside trading hours/);
    expect(assessRisk(base({ plan: { ...plan, rewardToRisk: 1.1 } })).reason).toMatch(/Pays only/);
    expect(assessRisk(base({ plan: { ...plan, costs: 4 } })).reason).toMatch(/quarter of the risk/);
    expect(assessRisk(base({ sim: { ...sim, expectedValue: -1 } })).reason).toMatch(/loses on average/);
    expect(assessRisk(base({ sim: null })).reason).toMatch(/could not run/);
  });
  it("rejects when significant news points the other way, and ignores minor news", () => {
    const item = { headline: "ITC slumps on tax fear", source: "x", publishedAt: NOW, url: "", symbol: "ITC.NS", sentiment: "negative", verified: "news-report" } as const;
    expect(assessRisk(base({ news: [{ ...item, impact: "high" }] })).reason).toMatch(/News against the trade/);
    expect(assessRisk(base({ news: [{ ...item, impact: "low" }] })).approved).toBe(true);
  });
});
