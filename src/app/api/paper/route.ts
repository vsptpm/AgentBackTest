import { NextResponse } from "next/server";
import { z } from "zod";
import { closePaperTrade, getPaperState, placePaperTrade, resetPaper } from "@/lib/paper";

export const maxDuration = 60;

const placeSchema = z.object({
  symbol: z.string().min(1),
  strategyName: z.string().min(1),
  side: z.enum(["long", "short"]),
  qty: z.number().int().min(1),
  entryPrice: z.number().positive(),
  /** Price when the signal fired; lets the server refuse a chased signal. */
  signalPrice: z.number().positive().optional(),
  stop: z.number().positive().optional(),
  target: z.number().positive().optional(),
  leverage: z.number().min(1).max(5).default(1),
  amount: z.number().min(1_000),
  maxRisk: z.number().min(0.0005).max(0.1),
});

// `amount` (money set aside for trading) lets the reply say where the daily limits stand.
const amount = z.number().positive().optional();
const actionSchema = z.union([z.object({ close: z.string().min(1), amount }), z.object({ reset: z.literal(true), amount })]);

const fail = (e: unknown, status: number) => NextResponse.json({ error: (e as Error).message }, { status });

/** Current paper trades, brought up to date with the latest prices. `?amount=` fills in the daily-limit status. */
export async function GET(req: Request) {
  try {
    const raw = Number(new URL(req.url).searchParams.get("amount"));
    return NextResponse.json(await getPaperState(Number.isFinite(raw) && raw > 0 ? raw : undefined));
  } catch (e) {
    return fail(e, 500);
  }
}

/** Take a paper trade, or `{ close: id }` / `{ reset: true }`. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = actionSchema.safeParse(body);
  if (action.success) {
    try {
      return NextResponse.json("close" in action.data ? await closePaperTrade(action.data.close, action.data.amount) : await resetPaper(action.data.amount));
    } catch (e) {
      return fail(e, 500);
    }
  }

  const parsed = placeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  }
  try {
    return NextResponse.json(await placePaperTrade(parsed.data));
  } catch (e) {
    // Rejections (not enough money, too risky, daily limit, chasing, duplicate) are the caller's to fix.
    return fail(e, 400);
  }
}
