import type { Metadata } from "next";
import { FinderPage } from "@/components/FinderPage";

export const metadata: Metadata = { title: "Finder" };

export default function Finder() {
  return <FinderPage />;
}
