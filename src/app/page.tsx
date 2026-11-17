import type { Metadata } from "next";
import { BacktestPage } from "@/components/BacktestPage";

export const metadata: Metadata = { title: "Backtest" };

export default function Home() {
  return <BacktestPage />;
}
