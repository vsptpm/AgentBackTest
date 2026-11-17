import { NextResponse, type NextRequest } from "next/server";
import { completeUpstoxLogin } from "@/lib/data/upstox";

/** Upstox sends the browser back here with a one-time code after login. */
export async function GET(req: NextRequest) {
  const back = (result: string) => {
    const res = NextResponse.redirect(new URL(`/scan?upstox=${result}`, req.url));
    res.cookies.delete("upstox_state");
    return res;
  };
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expected = req.cookies.get("upstox_state")?.value;
  if (!code || !state || !expected || state !== expected) return back("failed");
  try {
    await completeUpstoxLogin(code);
    return back("connected");
  } catch {
    return back("failed");
  }
}
