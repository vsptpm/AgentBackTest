import { NextResponse } from "next/server";
import { z } from "zod";
import type { Candle, FinderConfig } from "@/lib/types";
import { fetchBestCandles } from "@/lib/data/history";
import { getUpstoxToken } from "@/lib/data/upstox";
import { runFinder } from "@/lib/optimizer";

// A cold one-year run on five stocks is ~65 paced Upstox requests (about 80 s) before the search starts;
// more stocks or years take proportionally longer the first time, then come from disk.
export const maxDuration = 800;

const schema = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(60),
  strategyIds: z.array(z.string().min(1)).min(1),
  interval: z.enum(["1d", "15m", "5m"]),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  capital: z.number().min(1_000, "Capital must be at least ₹1,000"),
  riskPerTrade: z.number().min(0.0005).max(0.1).default(0.01),
  // Share of bars used to tune; the remainder is split evenly into a ranking slice and an untouched holdout.
  trainFraction: z.number().min(0.5).max(0.9).default(0.5),
  minTrades: z.number().int().min(5).max(500).default(30),
  objective: z.enum(["lossRate", "profitFactor", "expectancyR", "score"]).default("score"),
  maxCombos: z.number().int().min(1).max(300).default(60),
});

export async function POST(req: Request) {
  const started = Date.now();
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
  const config: FinderConfig = parsed.data;

  const candlesBySymbol: Record<string, Candle[]> = {};
  const warnings: string[] = [];

  // Indices cannot be traded as intraday equity; runFinder skips them with a warning, so do not fetch them.
  const fetchable = config.symbols.filter((s) => !s.startsWith("^"));
  // Upstox locks the app out after a burst, so with Upstox the stocks are fetched strictly one after
  // another (the history store paces every request). Yahoo tolerates small batches.
  const viaUpstox = config.interval !== "1d" && !!(await getUpstoxToken());
  const batch = viaUpstox ? 1 : 4;
  const sources = new Set<"upstox" | "yahoo">();
  let upstoxRequests = 0;
  for (let i = 0; i < fetchable.length; i += batch) {
    const slice = fetchable.slice(i, i + batch);
    const results = await Promise.allSettled(
      slice.map((symbol) => fetchBestCandles({ symbol, interval: config.interval, from: config.from, to: config.to })),
    );
    results.forEach((r, k) => {
      const symbol = slice[k];
      if (r.status === "fulfilled") {
        candlesBySymbol[symbol] = r.value.candles;
        sources.add(r.value.source);
        upstoxRequests += r.value.upstoxRequests;
        // Partial-bar notices are expected whenever the market is open; not worth showing.
        for (const w of r.value.warnings) if (!w.startsWith("Dropped ") && !warnings.includes(w)) warnings.push(w);
      } else {
        warnings.push(`${symbol}: ${(r.reason as Error).message}`);
      }
    });
  }
  // "mixed": Upstox failed part-way (see warnings), so some stocks have only Yahoo's ~60 days.
  const source = sources.size > 1 ? "mixed" : (sources.values().next().value ?? "yahoo");

  try {
    const out = runFinder({ config, candlesBySymbol });
    return NextResponse.json({
      rows: out.rows,
      warnings: [...warnings, ...out.warnings],
      candidatesTested: out.candidatesTested,
      sessions: out.sessions,
      source,
      upstoxRequests,
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
