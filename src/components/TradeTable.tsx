"use client";

import { useMemo, useState } from "react";
import type { Trade } from "@/lib/types";
import { fmtINR, fmtISTDateTime, fmtNum, fmtPct, fmtR } from "@/lib/format";
import { pnlClass } from "@/components/ui";

type SortKey =
  | "id"
  | "side"
  | "entryTime"
  | "entryPrice"
  | "exitTime"
  | "exitPrice"
  | "qty"
  | "grossPnl"
  | "costs"
  | "netPnl"
  | "rMultiple"
  | "exitReason"
  | "barsHeld"
  | "mae"
  | "mfe";

interface Col {
  key: SortKey;
  label: string;
  align?: "left" | "right";
}

const COLS: Col[] = [
  { key: "id", label: "#" },
  { key: "side", label: "Side", align: "left" },
  { key: "entryTime", label: "Entry time", align: "left" },
  { key: "entryPrice", label: "Entry" },
  { key: "exitTime", label: "Exit time", align: "left" },
  { key: "exitPrice", label: "Exit" },
  { key: "qty", label: "Qty" },
  { key: "grossPnl", label: "Gross" },
  { key: "costs", label: "Costs" },
  { key: "netPnl", label: "Net" },
  { key: "rMultiple", label: "R" },
  { key: "exitReason", label: "Exit reason", align: "left" },
  { key: "barsHeld", label: "Bars" },
  { key: "mae", label: "MAE%" },
  { key: "mfe", label: "MFE%" },
];

const REASON_CLS: Record<Trade["exitReason"], string> = {
  signal: "bg-accent/15 text-accent",
  stop: "bg-red/15 text-red",
  target: "bg-green/15 text-green",
  squareoff: "bg-amber/15 text-amber",
  end: "bg-surface-2 text-muted",
};

function compare(a: Trade, b: Trade, key: SortKey): number {
  const av = a[key];
  const bv = b[key];
  if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv);
  const an = typeof av === "number" ? av : 0;
  const bn = typeof bv === "number" ? bv : 0;
  // NaN (no-stop R) sorts last regardless of direction
  if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
  if (Number.isNaN(an)) return 1;
  if (Number.isNaN(bn)) return -1;
  return an - bn;
}

export function TradeTable({
  trades,
  selectedId = null,
  onSelect,
}: {
  trades: Trade[];
  /** Highlighted row. Clicking the highlighted row again deselects (calls onSelect(null)). */
  selectedId?: number | null;
  onSelect?(id: number | null): void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("id");
  const [dir, setDir] = useState<1 | -1>(1);

  const sorted = useMemo(() => {
    const copy = [...trades];
    copy.sort((a, b) => {
      const c = compare(a, b, sortKey);
      // keep NaN last even in descending order
      if (Number.isNaN(a[sortKey] as number) || Number.isNaN(b[sortKey] as number)) return c;
      return c * dir;
    });
    return copy;
  }, [trades, sortKey, dir]);

  function onSort(key: SortKey) {
    if (key === sortKey) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setDir(key === "id" || key === "entryTime" || key === "exitTime" ? 1 : -1);
    }
  }

  if (trades.length === 0) {
    return <div className="card px-3 py-6 text-center text-sm text-muted">No trades</div>;
  }

  return (
    <div className="card max-h-[480px] overflow-auto">
      <table className="w-full min-w-[1100px] border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-surface-2 text-muted">
          <tr>
            {COLS.map((c) => {
              const active = c.key === sortKey;
              return (
                <th
                  key={c.key}
                  onClick={() => onSort(c.key)}
                  className={`cursor-pointer select-none whitespace-nowrap px-2 py-1.5 font-medium hover:text-text ${
                    c.align === "left" ? "text-left" : "text-right"
                  } ${active ? "text-text" : ""}`}
                  aria-sort={active ? (dir === 1 ? "ascending" : "descending") : "none"}
                >
                  {c.label}
                  {active ? <span className="ml-1 text-accent">{dir === 1 ? "▲" : "▼"}</span> : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => {
            const active = t.id === selectedId;
            return (
            <tr
              key={t.id}
              onClick={onSelect ? () => onSelect(active ? null : t.id) : undefined}
              aria-selected={onSelect ? active : undefined}
              className={`border-t border-border ${onSelect ? "cursor-pointer" : ""} ${
                active ? "bg-accent/15 hover:bg-accent/20" : "hover:bg-surface-2/60"
              }`}
            >
              <td className={`px-2 py-1 text-right ${active ? "text-accent" : "text-muted"}`}>{t.id}</td>
              <td className={`px-2 py-1 uppercase ${t.side === "long" ? "text-green" : "text-red"}`}>{t.side}</td>
              <td className="whitespace-nowrap px-2 py-1 text-muted">{fmtISTDateTime(t.entryTime)}</td>
              <td className="px-2 py-1 text-right">{fmtNum(t.entryPrice, 2)}</td>
              <td className="whitespace-nowrap px-2 py-1 text-muted">{fmtISTDateTime(t.exitTime)}</td>
              <td className="px-2 py-1 text-right">{fmtNum(t.exitPrice, 2)}</td>
              <td className="px-2 py-1 text-right">{fmtNum(t.qty, 0)}</td>
              <td className={`px-2 py-1 text-right ${pnlClass(t.grossPnl)}`}>{fmtINR(t.grossPnl)}</td>
              <td className="px-2 py-1 text-right text-muted">{fmtINR(t.costs)}</td>
              <td className={`px-2 py-1 text-right font-medium ${pnlClass(t.netPnl)}`}>{fmtINR(t.netPnl)}</td>
              <td className={`px-2 py-1 text-right ${pnlClass(t.rMultiple)}`}>{fmtR(t.rMultiple)}</td>
              <td className="px-2 py-1">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${REASON_CLS[t.exitReason]}`}
                  title={t.entryReason ? `entry: ${t.entryReason}` : undefined}
                >
                  {t.exitReason}
                </span>
              </td>
              <td className="px-2 py-1 text-right">{t.barsHeld}</td>
              <td className="px-2 py-1 text-right text-red">{fmtPct(-Math.abs(t.mae))}</td>
              <td className="px-2 py-1 text-right text-green">{fmtPct(Math.abs(t.mfe))}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
