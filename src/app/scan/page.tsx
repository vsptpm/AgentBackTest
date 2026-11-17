import type { Metadata } from "next";
import { ScanPage } from "@/components/ScanPage";

export const metadata: Metadata = { title: "Scanner" };

export default function Scan() {
  return <ScanPage />;
}
