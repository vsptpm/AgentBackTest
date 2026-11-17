import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchBestCandles } from "@/lib/data/history";

// A long 5m / 15m range not yet on disk is downloaded from Upstox one month at a time.
export const maxDuration = 300;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const QuerySchema = z
  .object({
    symbol: z.string().trim().min(1, "symbol is required").max(32),
    interval: z.enum(["1d", "15m", "5m"]),
    from: z.string().regex(ISO_DATE, "from must be YYYY-MM-DD"),
    to: z.string().regex(ISO_DATE, "to must be YYYY-MM-DD"),
  })
  .refine((q) => q.from <= q.to, { message: "from must be on or before to", path: ["from"] });

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    symbol: searchParams.get("symbol") ?? undefined,
    interval: searchParams.get("interval") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
  });

  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ");
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const { candles, warnings, source } = await fetchBestCandles(parsed.data);
    return NextResponse.json({ candles, warnings, source });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to fetch candles";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
