import { NextResponse } from "next/server";
import { listStrategies } from "@/lib/strategies";

export function GET() {
  return NextResponse.json({ strategies: listStrategies() });
}
