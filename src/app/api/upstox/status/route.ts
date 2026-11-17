import { NextResponse } from "next/server";
import { HISTORY_FROM } from "@/lib/data/history";
import { getUpstoxToken } from "@/lib/data/upstox";

/** Whether long Upstox history is available. Never returns the token itself. */
export async function GET() {
  return NextResponse.json({ connected: !!(await getUpstoxToken()), historyFrom: HISTORY_FROM });
}
