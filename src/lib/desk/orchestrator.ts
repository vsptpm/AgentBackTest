// The central orchestrator: runs the agents in order and assembles the final report.
// Server-side only. Analysis and paper trading only — nothing here can place an order.

import type { Candle } from "@/lib/types";
import { SYMBOLS } from "@/lib/data/symbols";
import { fetchLiveCandles } from "@/lib/data/live";
import { isMarketOpen } from "@/lib/scan";
import { pickInPlay, type InPlay } from "@/lib/scan/inplay";
import { getInPlayRanking, scanWindow } from "@/lib/scan/pool";
import { getPaperState } from "@/lib/paper";
import { analyse, buildPlan } from "./technical";
import { simulate } from "./timemachine";
import { fetchNews } from "./news";
import { assessRisk } from "./risk";
import type { DeskAccount, DeskCandidate, DeskRequest, DeskResponse, DeskStep, NewsItem, SimResult, TechnicalView, TradePlan } from "./types";

const NAMES: Record<string, string> = Object.fromEntries(SYMBOLS.map((s) => [s.symbol, s.name]));
const bare = (s: string) => s.replace(/\.(NS|BO)$/, "");

async function timed<T>(steps: DeskStep[], agent: DeskStep["agent"], run: () => Promise<{ value: T; status?: DeskStep["status"]; detail: string }>, fallback: T): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await run();
    steps.push({ agent, status: r.status ?? "ok", detail: r.detail, ms: Date.now() - t0 });
    return r.value;
  } catch (e) {
    steps.push({ agent, status: "fail", detail: (e as Error).message, ms: Date.now() - t0 });
    return fallback;
  }
}

export async function runDesk(req: DeskRequest, now: number = Date.now()): Promise<DeskResponse> {
  const account: DeskAccount = {
    capital: req.capital,
    riskPerTrade: req.riskPerTrade,
    maxDailyLoss: req.maxDailyLoss,
    leverage: req.leverage,
    // One position per ~₹25,000, at least one, at most three: a small account cannot spread itself.
    maxPositions: Math.max(1, Math.min(3, Math.floor(req.capital / 25_000) || 1)),
  };
  const steps: DeskStep[] = [];
  const warnings: string[] = [];
  const marketOpen = isMarketOpen(now);

  const paper = await getPaperState(account.capital, now).catch(() => null);
  const openSymbols = (paper?.trades ?? []).filter((t) => t.status === "open").map((t) => t.symbol);

  // 1. Market scanner: liquid stocks this account can afford that are moving on volume.
  let universe = { poolSize: 0, affordableCount: 0, maxPrice: 0 };
  const picks = await timed<InPlay[]>(
    steps,
    "Market scanner",
    async () => {
      const ranking = await getInPlayRanking("5m", now);
      warnings.push(...ranking.warnings);
      const picked = pickInPlay(ranking.ranked, { top: req.top, capital: account.capital, leverage: account.leverage, keep: [], held: openSymbols });
      universe = { poolSize: ranking.poolSize, affordableCount: picked.affordableCount, maxPrice: picked.maxPrice };
      return {
        value: picked.picks,
        status: picked.picks.length ? "ok" : "warn",
        detail: picked.picks.length
          ? `Looked at ${ranking.poolSize} stocks; ${picked.affordableCount} fit your money; picked the ${picked.picks.length} moving most: ${picked.picks.map((p) => bare(p.symbol)).join(", ")}`
          : `Looked at ${ranking.poolSize} stocks; none both fits your money and is moving`,
      };
    },
    [],
  );

  // Candles for the picks. One at a time: the broker's candle service punishes bursts.
  const { from, to } = scanWindow(now);
  const candlesBy: Record<string, Candle[]> = {};
  const sources = new Set<string>();
  for (const p of picks) {
    try {
      const r = await fetchLiveCandles({ symbol: p.symbol, interval: "5m", from, to }, now);
      candlesBy[p.symbol] = r.candles;
      sources.add(r.source);
      for (const w of r.warnings) if (!w.startsWith("Dropped ") && !warnings.includes(w)) warnings.push(w);
    } catch (e) {
      warnings.push(`${bare(p.symbol)}: ${(e as Error).message}`);
    }
  }
  const priceSource: DeskResponse["priceSource"] = sources.size > 1 ? "mixed" : sources.has("upstox") ? "upstox" : "yahoo";

  // 2. Technical analyst.
  const views = await timed<Record<string, TechnicalView>>(
    steps,
    "Technical analyst",
    async () => {
      const out: Record<string, TechnicalView> = {};
      for (const p of picks) {
        const v = candlesBy[p.symbol] ? analyse(p.symbol, candlesBy[p.symbol], now) : null;
        if (v) out[p.symbol] = v;
      }
      const n = Object.values(out);
      const count = (b: string) => n.filter((v) => v.bias === b).length;
      return {
        value: out,
        status: n.length ? "ok" : "warn",
        detail: n.length ? `${count("bullish")} leaning up, ${count("bearish")} leaning down, ${count("sideways") + count("no-trade")} with no clear direction` : "No stock had enough price history to read",
      };
    },
    {},
  );

  // 3. News analyst (runs for every stock read, with or without a plan).
  const news = await timed<NewsItem[]>(
    steps,
    "News analyst",
    async () => {
      const r = await fetchNews(Object.keys(views), NAMES, now);
      warnings.push(...r.warnings);
      const heavy = r.items.filter((x) => x.impact === "high").length;
      return {
        value: r.items,
        status: r.warnings.length && !r.items.length ? "warn" : "ok",
        detail: r.items.length ? `${r.items.length} recent headlines, ${heavy} that could move a price` : "No recent headlines found for these stocks",
      };
    },
    [],
  );

  // 4. Trade strategist.
  const plans = await timed<Record<string, TradePlan>>(
    steps,
    "Trade strategist",
    async () => {
      const out: Record<string, TradePlan> = {};
      for (const [symbol, v] of Object.entries(views)) {
        const plan = buildPlan(v, candlesBy[symbol], account);
        if (plan) out[symbol] = plan;
      }
      const n = Object.keys(out).length;
      return { value: out, status: n ? "ok" : "warn", detail: n ? `Drew up ${n} trade plan${n === 1 ? "" : "s"} with entry, stop and targets` : "No stock gave a clear enough direction to plan a trade" };
    },
    {},
  );

  // 5. Time machine.
  const sims = await timed<Record<string, SimResult>>(
    steps,
    "Time machine",
    async () => {
      const out: Record<string, SimResult> = {};
      for (const [symbol, plan] of Object.entries(plans)) {
        out[symbol] = simulate(plan, candlesBy[symbol], now, { paths: 2000, seed: 1, dailyLossLimit: account.capital * account.maxDailyLoss });
      }
      const n = Object.values(out);
      const good = n.filter((s) => s.expectedValue > 0).length;
      return {
        value: out,
        status: "ok",
        detail: n.length ? `Replayed past sessions and ran ${n[0].paths.toLocaleString("en-IN")} simulated paths per plan; ${good} of ${n.length} come out ahead on average` : "Nothing to simulate",
      };
    },
    {},
  );

  // 6. Risk manager — final say.
  const candidates: DeskCandidate[] = [];
  const t0 = Date.now();
  for (const p of picks) {
    const technical = views[p.symbol];
    if (!technical) continue;
    const plan = plans[p.symbol] ?? null;
    const sim = sims[p.symbol] ?? null;
    const items = news.filter((n) => n.symbol === p.symbol);

    let risk: DeskCandidate["risk"];
    let decision: DeskCandidate["decision"] = "NO TRADE";
    let summary: string;
    if (!plan) {
      const leans = technical.bias === "bullish" || technical.bias === "bearish";
      // A clear lean with no plan means no whole number of shares keeps the loss, charges included, inside the limit.
      const why = leans
        ? `No size fits: even the smallest position would lose more than your ₹${Math.round(account.capital * account.riskPerTrade).toLocaleString("en-IN")} limit once charges are counted`
        : "No trade plan — the chart gives no clear direction";
      risk = { approved: false, checks: [{ ok: false, text: why }], reason: why };
      summary = leans
        ? `Chart leans ${technical.bias === "bullish" ? "up" : "down"}, but the trade cannot be made small enough for your risk limit at this share price. Skip it.`
        : technical.bias === "no-trade"
          ? "Barely moving. Nothing to trade here."
          : "Signals point both ways. No clear direction, so no trade.";
    } else {
      risk = assessRisk({
        plan,
        technical,
        sim,
        news: items,
        account,
        book: {
          inUse: paper?.inUse ?? 0,
          resultToday: paper?.status.lossToday ?? 0,
          openSymbols,
          locked: paper?.status.locked ?? false,
          lockedReason: paper?.status.reason,
        },
        relVol: p.relVol,
        pricesLive: priceSource === "upstox",
        now,
      });
      if (risk.approved) {
        decision = plan.side === "long" ? "BUY CANDIDATE" : "SELL CANDIDATE";
        summary = `Chart leans ${plan.side === "long" ? "up" : "down"}, the time machine comes out ahead on average, and every risk check passes. A candidate, not a certainty.`;
      } else {
        summary = `Chart leans ${plan.side === "long" ? "up" : "down"}, but the risk manager says no: ${risk.reason}.`;
      }
    }
    candidates.push({ symbol: p.symbol, changePct: p.changePct, relVol: p.relVol, technical, plan, sim, news: items, risk, decision, summary });
  }
  const approved = candidates.filter((c) => c.decision !== "NO TRADE").length;
  steps.push({
    agent: "Risk manager",
    status: "ok",
    detail: candidates.length ? `Approved ${approved} of ${candidates.length}; rejected ${candidates.length - approved}` : "Nothing to judge",
    ms: Date.now() - t0,
  });
  candidates.sort((a, b) => Number(b.decision !== "NO TRADE") - Number(a.decision !== "NO TRADE") || Math.abs(b.technical.score) - Math.abs(a.technical.score));

  return { asOf: now, marketOpen, priceSource, account, universe, steps, candidates, warnings: [...new Set(warnings)] };
}
