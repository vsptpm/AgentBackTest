import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { upstoxLoginConfigured, upstoxLoginUrl } from "@/lib/data/upstox";

/** Send the browser to the Upstox login page. Upstox returns to /api/upstox/callback. */
export async function GET(req: Request) {
  if (!upstoxLoginConfigured()) {
    return NextResponse.redirect(new URL("/scan?upstox=setup", req.url));
  }
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(upstoxLoginUrl(state));
  // Checked on return so a login started elsewhere cannot be completed here.
  res.cookies.set({ name: "upstox_state", value: state, httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
