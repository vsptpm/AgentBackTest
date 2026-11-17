import { NextResponse } from "next/server";
import { SYMBOLS } from "@/lib/data/symbols";

export function GET() {
  return NextResponse.json({ symbols: SYMBOLS });
}
