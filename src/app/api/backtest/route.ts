import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_COSTS, type BacktestConfig } from "@/lib/types";
import { fetchBestCandles } from "@/lib/data/history";
import { runBacktest } from "@/lib/backtest";
import { createStrategy, listStrategies, normaliseParams } from "@/lib/strategies";

// A cold three-year 5m download from Upstox is ~37 paced requests (about 45 s) before the backtest runs.
export const maxDuration = 300;

const costSchema = z.object({
  brokeragePerOrder: z.number().min(0),
  brokerageRate: z.number().min(0).max(0.05),
  stopSlippage: z.number().min(0).max(0.1),
  sttRate: z.number().min(0),
  exchangeRate: z.number().min(0),
  sebiRate: z.number().min(0),
  stampRate: z.number().min(0),
  gstRate: z.number().min(0),
  slippage: z.number().min(0).max(0.05),
});

const schema = z.object({
  symbol: z.string().min(1),
  interval: z.enum(["1d", "15m", "5m"]),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strategyId: z.string().min(1),
  params: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
  capital: z.number().min(1_000, "Capital must be at least ₹1,000"),
  riskPerTrade: z.number().min(0.0005).max(0.1).default(0.01),
  positionFraction: z.number().min(0.01).max(1).default(0.5),
  squareOffTime: z.string().regex(/^\d{2}:\d{2}$/).default("15:05"),
  costs: costSchema.partial().default({}),
  allowShort: z.boolean().default(true),
  entryStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  entryEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  maxTradesPerDay: z.number().int().min(0).max(50).optional(),
  maxDailyLoss: z.number().min(0).max(0.5).optional(),
  leverage: z.number().min(1).max(10).optional(),
  breakevenAtR: z.number().min(0).max(10).optional(),
  maxFrictionR: z.number().min(0).max(2).optional(),
});

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
  const input = parsed.data;

  const meta = listStrategies().find((s) => s.id === input.strategyId);
  if (!meta) return NextResponse.json({ error: `Unknown strategy ${input.strategyId}` }, { status: 400 });
  if (!meta.intervals.includes(input.interval)) {
    return NextResponse.json({ error: `${meta.name} does not support ${input.interval}` }, { status: 400 });
  }

  const config: BacktestConfig = {
    ...input,
    params: normaliseParams(meta, input.params),
    costs: { ...DEFAULT_COSTS, ...input.costs },
  };

  try {
    const { candles, warnings, source, upstoxRequests } = await fetchBestCandles({ symbol: config.symbol, interval: config.interval, from: config.from, to: config.to });
    if (candles.length <= meta.warmup + 5) {
      return NextResponse.json({ error: `Only ${candles.length} candles for ${config.symbol}; strategy needs > ${meta.warmup}` }, { status: 400 });
    }
    const strategy = createStrategy(config.strategyId);
    const result = runBacktest(config, candles, strategy);
    result.warnings = [...warnings, ...result.warnings];
    // Chart payload: the candles actually used plus any strategy overlay lines.
    result.candles = candles;
    if (strategy.overlays) {
      try {
        result.overlays = strategy.overlays(candles, config.params);
      } catch (e) {
        result.warnings.push(`Overlay error: ${(e as Error).message}`);
      }
    }
    return NextResponse.json({ ...result, source, upstoxRequests });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
