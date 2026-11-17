import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchLiveCandles, upstoxStatus, type PriceSource } from "@/lib/data/live";
import { isMarketOpen, scanSymbol, type ScanResponse, type ScanSymbolResult } from "@/lib/scan";
import { pickInPlay } from "@/lib/scan/inplay";
import { getInPlayRanking, scanWindow } from "@/lib/scan/pool";

export const maxDuration = 180;

const schema = z
  .object({
    /** The watchlist. Ignored when `inPlay` is given. */
    symbols: z.array(z.string().min(1)).max(40).default([]),
    /** Scan today's most active stocks instead of a fixed watchlist. */
    inPlay: z
      .object({
        top: z.number().int().min(3).max(25).default(12),
        /** Stocks to keep scanning even if they drop out of the top (open signals, open trades). */
        keep: z.array(z.string().min(1)).max(40).default([]),
        /** Stocks with an open paper trade: kept even when the account can no longer afford them. */
        held: z.array(z.string().min(1)).max(40).default([]),
      })
      .optional(),
    strategyIds: z.array(z.string().min(1)).min(1),
    interval: z.enum(["15m", "5m"]),
    capital: z.number().min(1_000, "Capital must be at least ₹1,000"),
    riskPerTrade: z.number().min(0.0005).max(0.1).default(0.01),
    /** Intraday margin multiplier. 1 = no leverage. */
    leverage: z.number().min(1).max(5).default(1),
  })
  .refine((v) => v.inPlay || v.symbols.length > 0, { message: "Pick at least one stock", path: ["symbols"] });

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  }
  const cfg = parsed.data;
  const now = Date.now();
  const { from, to } = scanWindow(now);

  const rows: ScanSymbolResult[] = [];
  const warnings: string[] = [];
  const sources = new Set<PriceSource>();

  let symbols = cfg.symbols;
  let inPlay: ScanResponse["inPlay"];
  if (cfg.inPlay) {
    const ranking = await getInPlayRanking(cfg.interval, now);
    // Only stocks this account can actually trade, and that are moving enough to beat charges.
    const picked = pickInPlay(ranking.ranked, {
      top: cfg.inPlay.top,
      capital: cfg.capital,
      leverage: cfg.leverage,
      keep: cfg.inPlay.keep,
      held: cfg.inPlay.held,
    });
    symbols = picked.picks.map((p) => p.symbol);
    inPlay = {
      picks: picked.picks,
      poolSize: ranking.poolSize,
      pool: ranking.pool,
      rankedAt: ranking.rankedAt,
      affordableCount: picked.affordableCount,
      maxPrice: picked.maxPrice,
      movementRelaxed: picked.movementRelaxed,
    };
    warnings.push(...ranking.warnings);
  }

  // Fetch sequentially in small batches; Yahoo rate-limits bursts.
  const batch = 4;
  for (let i = 0; i < symbols.length; i += batch) {
    const slice = symbols.slice(i, i + batch);
    const results = await Promise.allSettled(slice.map((symbol) => fetchLiveCandles({ symbol, interval: cfg.interval, from, to }, now)));
    results.forEach((r, k) => {
      const symbol = slice[k];
      if (r.status !== "fulfilled") {
        warnings.push(`${symbol}: ${(r.reason as Error).message}`);
        return;
      }
      sources.add(r.value.source);
      // Partial-bar notices are expected on every live fetch; not worth showing.
      for (const w of r.value.warnings) if (!w.startsWith("Dropped ") && !warnings.includes(w)) warnings.push(w);
      try {
        const row = scanSymbol({
          symbol,
          candles: r.value.candles,
          strategyIds: cfg.strategyIds,
          interval: cfg.interval,
          capital: cfg.capital,
          riskPerTrade: cfg.riskPerTrade,
          leverage: cfg.leverage,
          now,
        });
        if (row) rows.push(row);
        else warnings.push(`${symbol}: no completed ${cfg.interval} bars`);
      } catch (e) {
        warnings.push(`${symbol}: ${(e as Error).message}`);
      }
    });
  }

  // marketOpen is clock-based only (Mon–Fri 09:15–15:30 IST); exchange holidays are not handled.
  const priceSource = sources.size > 1 ? "mixed" : sources.has("upstox") ? "upstox" : "yahoo";
  const out: ScanResponse = {
    rows,
    warnings,
    asOf: now,
    marketOpen: isMarketOpen(now),
    priceSource,
    upstox: await upstoxStatus(now),
    inPlay,
  };
  return NextResponse.json(out);
}
