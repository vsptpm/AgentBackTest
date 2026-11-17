import { NextResponse } from "next/server";
import { z } from "zod";
import { runDesk } from "@/lib/desk/orchestrator";

export const maxDuration = 180;

const schema = z.object({
  capital: z.number().min(1_000, "Capital must be at least ₹1,000"),
  riskPerTrade: z.number().min(0.0005).max(0.05).default(0.01),
  maxDailyLoss: z.number().min(0.005).max(0.1).default(0.02),
  leverage: z.number().min(1).max(5).default(1),
  top: z.number().int().min(3).max(8).default(5),
});

/** Run every agent once and return the full report. Analysis and paper trading only. */
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
  try {
    return NextResponse.json(await runDesk(parsed.data));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
