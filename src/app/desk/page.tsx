import type { Metadata } from "next";
import { DeskPage } from "@/components/DeskPage";

export const metadata: Metadata = { title: "Trading desk" };

export default function Desk() {
  return <DeskPage />;
}
