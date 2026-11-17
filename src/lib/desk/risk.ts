// Agent 5 — the risk manager. It has the last word: any failed check rejects the trade.
// Pure; safe to import in the browser.

import { MIN_REWARD_TO_RISK, MIN_STOP_PCT, inEntryWindow } from "@/lib/paper/settle";
import type { DeskAccount, NewsItem, RiskVerdict, SimResult, TechnicalView, TradePlan } from "./types";

export interface RiskInputs {
  plan: TradePlan;
  technical: TechnicalView;
  sim: SimResult | null;
  news: NewsItem[];
  account: DeskAccount;
  /** From the paper ledger. */
  book: {
    /** Margin already tied up, INR. */
    inUse: number;
    /** Today's result so far, INR (negative = losing). */
    resultToday: number;
    openSymbols: string[];
    locked: boolean;
    lockedReason?: string;
  };
  /** Today's volume ÷ usual. NaN if unknown. */
  relVol: number;
  pricesLive: boolean;
  now: number;
}

const rupee = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Every check is listed, pass or fail, so the trader sees the whole picture. The limits never
 * loosen after a good day: they are fractions of the capital the user set, not of today's profit.
 */
export function assessRisk(i: RiskInputs): RiskVerdict {
  const { plan, account, book, sim } = i;
  const checks: { ok: boolean; text: string }[] = [];
  const add = (ok: boolean, pass: string, fail: string) => checks.push({ ok, text: ok ? pass : fail });

  const riskLimit = account.capital * account.riskPerTrade;
  const dayLimit = account.capital * account.maxDailyLoss;
  const free = account.capital - book.inUse;
  const stopPct = (Math.abs(plan.entry - plan.stop) / plan.entry) * 100;
  const against = i.news.filter((n) => n.impact !== "low" && n.sentiment === (plan.side === "long" ? "negative" : "positive"));

  add(!book.locked, "Daily limits allow another trade", book.lockedReason ?? "Daily limit reached — no more trades today");
  add(inEntryWindow(i.now), "Inside trading hours (09:30–14:45)", "Outside trading hours — new trades are taken 09:30–14:45 on trading days");
  add(i.pricesLive, "Prices are live", "Prices are delayed — cannot trust the entry price");
  add(plan.maxLoss <= riskLimit * 1.05, `Worst case ${rupee(plan.maxLoss)} is within your ${rupee(riskLimit)} per-trade limit`, `Worst case ${rupee(plan.maxLoss)} is more than your ${rupee(riskLimit)} per-trade limit`);
  add(
    book.resultToday - plan.maxLoss > -dayLimit,
    `A loss here keeps you above today's stop of −${rupee(dayLimit)}`,
    `A loss here would take today's result past your stop of −${rupee(dayLimit)}`,
  );
  add(plan.capitalRequired <= free, `Needs ${rupee(plan.capitalRequired)}; you have ${rupee(Math.max(0, free))} free`, `Needs ${rupee(plan.capitalRequired)} but only ${rupee(Math.max(0, free))} is free`);
  add(plan.qty >= 2, `${plan.qty} shares — enough to size the trade`, "Only 1 share affordable — no control over the size of the loss");
  add(!book.openSymbols.includes(plan.symbol), "No open trade in this stock", "You already have an open trade in this stock");
  add(book.openSymbols.length < account.maxPositions, `Open trades: ${book.openSymbols.length} of ${account.maxPositions} allowed`, `Already at the limit of ${account.maxPositions} open trades`);
  add(stopPct >= MIN_STOP_PCT, `Stop is ${stopPct.toFixed(2)}% away — clear of normal price noise`, `Stop is only ${stopPct.toFixed(2)}% away — normal noise would hit it`);
  add(
    plan.rewardToRisk >= MIN_REWARD_TO_RISK,
    `Pays ₹${plan.rewardToRisk.toFixed(1)} for each ₹1 risked, after charges`,
    `Pays only ₹${plan.rewardToRisk.toFixed(1)} for each ₹1 risked after charges (need ${MIN_REWARD_TO_RISK})`,
  );
  add(
    plan.costs <= 0.25 * Math.abs(plan.entry - plan.stop) * plan.qty,
    `Charges ${rupee(plan.costs)} are small against the risk`,
    `Charges ${rupee(plan.costs)} are more than a quarter of the risk — the trade is too small to be worth it`,
  );
  add(!(i.relVol < 0.7), Number.isFinite(i.relVol) ? `Volume is ${i.relVol.toFixed(1)}× usual — enough interest` : "Volume history unknown — not held against it", `Volume is only ${i.relVol.toFixed(1)}× usual — thin trading`);
  add(i.technical.indicators.atrPct <= 1.2, "Price swings are normal for 5-minute bars", "Price is swinging unusually hard — stop could be jumped");
  add(against.length === 0, "No significant news against the trade", `News against the trade: “${against[0]?.headline.slice(0, 90) ?? ""}”`);
  if (sim) {
    add(sim.expectedValue > 0, `Time machine: average result ${rupee(sim.expectedValue)} per trade`, `Time machine: this trade loses on average (${rupee(sim.expectedValue)} per trade)`);
    add(sim.riskOfRuin <= 0.25, `Three trades like this rarely hit your daily stop (${(sim.riskOfRuin * 100).toFixed(0)}%)`, `Three trades like this hit your daily stop ${(sim.riskOfRuin * 100).toFixed(0)}% of the time`);
  } else {
    add(false, "", "Time machine could not run — no evidence for this trade");
  }

  const failed = checks.find((c) => !c.ok);
  return { approved: !failed, checks, reason: failed?.text };
}
