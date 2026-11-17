"use client";

import { useMemo, useState } from "react";
import type { FinderRow, Metrics } from "@/lib/types";
import { fmtINR, fmtNum, fmtParams, fmtPct, fmtPctRaw, fmtR } from "@/lib/format";
import { pnlClass } from "@/components/ui";

type MetricKey = "lossRate" | "profitFactor" | "expectancyR" | "maxDrawdownPct" | "totalTrades" | "netPnl" | "winRate";
/** ho = untouched holdout, oos = ranking (select) slice, is = tuning slice. */
type Slice = "ho" | "oos" | "is";
type SortKey = "symbol" | "strategyName" | "score" | `${Slice}.${MetricKey}`;

interface Col {
  key: MetricKey;
  label: string;
  fmt: (n: number) => string;
  lowerBetter: boolean;
}

// An infinite profit factor only means "no losing trade in this sample", not a real number.
const fmtPF = (n: number) => (Number.isFinite(n) ? fmtNum(n, 2) : "n/a");

const C: Record<MetricKey, Col> = {
  netPnl: { key: "netPnl", label: "Result", fmt: (n) => fmtINR(n), lowerBetter: false },
  winRate: { key: "winRate", label: "Win %", fmt: (n) => fmtPct(n), lowerBetter: false },
  lossRate: { key: "lossRate", label: "Loss rate", fmt: (n) => fmtPct(n), lowerBetter: true },
  profitFactor: { key: "profitFactor", label: "Profit factor", fmt: fmtPF, lowerBetter: false },
  expectancyR: { key: "expectancyR", label: "Avg R", fmt: fmtR, lowerBetter: false },
  maxDrawdownPct: { key: "maxDrawdownPct", label: "Worst dip", fmt: (n) => fmtPctRaw(n), lowerBetter: true },
  totalTrades: { key: "totalTrades", label: "Trades", fmt: (n) => String(n), lowerBetter: false },
};

/** Detail columns, hidden until "Show all numbers". */
const HOLDOUT_EXTRA_COLS: Col[] = [C.lossRate, C.expectancyR, C.maxDrawdownPct];
const RANKING_COLS: Col[] = [C.netPnl, C.winRate, C.profitFactor, C.expectancyR, C.maxDrawdownPct, C.totalTrades];
const TUNED_COLS: Col[] = [C.netPnl, C.lossRate, C.profitFactor, C.expectancyR, C.maxDrawdownPct, C.totalTrades];

/** Fewer holdout trades than this proves nothing either way. */
export const MIN_HOLDOUT_TRADES = 8;

export type Verdict = "holds" | "weak" | "fails" | "unproven";

/** Judged only on the final slice, which was never used to tune or to rank. */
export function verdict(row: FinderRow): Verdict {
  const h = row.holdout;
  if (!h || h.totalTrades < MIN_HOLDOUT_TRADES) return "unproven";
  if (!(h.netPnl > 0)) return "fails";
  return h.profitFactor >= 1.2 ? "holds" : "weak";
}

const VERDICT: Record<Verdict, { label: string; cls: string }> = {
  holds: { label: "Holds up", cls: "border-green/40 bg-green/10 text-green" },
  weak: { label: "Weak", cls: "border-amber/40 bg-amber/10 text-amber" },
  unproven: { label: "Unproven — too few trades", cls: "border-border bg-surface-2 text-muted" },
  fails: { label: "Fails on untouched data", cls: "border-red/40 bg-red/10 text-red" },
};

/** RELIANCE.NS → RELIANCE, ^NSEI → NSEI */
function shortSymbol(s: string): string {
  return s.replace(/\.(NS|BO)$/, "").replace(/^\^/, "");
}

function sliceOf(row: FinderRow, slice: Slice): Metrics | undefined {
  return slice === "ho" ? row.holdout : slice === "oos" ? row.outSample : row.inSample;
}

function get(row: FinderRow, key: SortKey): number | string {
  if (key === "symbol" || key === "strategyName" || key === "score") return row[key];
  const [slice, metric] = key.split(".") as [Slice, MetricKey];
  const m = sliceOf(row, slice);
  return m ? m[metric] : NaN;
}

export function FinderTable({
  rows,
  onSelect,
  selected,
}: {
  rows: FinderRow[];
  onSelect: (row: FinderRow) => void;
  selected?: FinderRow | null;
}) {
  // null = the server's ranking order (ranked on the ranking slice, never on the untouched one).
  // Parent remounts this table per finder run (key), so every run starts in ranking order.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = get(a, sort.key);
      const bv = get(b, sort.key);
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * sort.dir;
      const an = Number(av);
      const bn = Number(bv);
      if (Number.isNaN(an)) return 1;
      if (Number.isNaN(bn)) return -1;
      if (an === bn) return 0;
      return an > bn ? sort.dir : -sort.dir;
    });
    return copy;
  }, [rows, sort]);

  function click(key: SortKey, lowerBetter: boolean) {
    setSort((s) => (s && s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: lowerBetter ? 1 : -1 }));
  }

  // Plain render helper (not a component) so React keeps header identity across renders.
  function th(k: SortKey, label: string, lowerBetter = false, cls = "") {
    const active = sort?.key === k;
    return (
      <th
        key={k}
        onClick={() => click(k, lowerBetter)}
        className={`cursor-pointer select-none whitespace-nowrap px-2 py-1.5 font-medium hover:text-text ${active ? "text-text" : ""} ${cls}`}
        aria-sort={active ? (sort?.dir === 1 ? "ascending" : "descending") : "none"}
      >
        {label}
        {active ? <span className="ml-1 text-accent">{sort?.dir === 1 ? "▲" : "▼"}</span> : null}
      </th>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="card px-3 py-6 text-center text-sm text-muted">
        Nothing made money often enough to judge. Try more stocks or a longer period.
      </div>
    );
  }

  const isSame = (a: FinderRow, b: FinderRow) =>
    a.symbol === b.symbol && a.strategyId === b.strategyId && fmtParams(a.params) === fmtParams(b.params);

  const firstBorder = (i: number) => (i === 0 ? "border-l border-border" : "");

  return (
    <div className="flex flex-col gap-1.5">
      <div className="card max-h-[560px] overflow-auto">
        <table className={`w-full border-collapse text-sm ${showAll ? "min-w-[1680px]" : "min-w-[680px]"}`}>
          <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-muted">
            <tr>
              {th("symbol", "Stock", false, "text-left")}
              {th("strategyName", "Strategy", false, "text-left")}
              {th("ho.netPnl", "Untouched-data result", false, "text-right")}
              {th("ho.winRate", "Win %", false, "text-right")}
              {th("ho.profitFactor", "Profit factor", false, "text-right")}
              {th("ho.totalTrades", "Trades", false, "text-right")}
              <th className="px-2 py-1.5 text-left font-medium">Verdict</th>
              {showAll
                ? [
                    ...HOLDOUT_EXTRA_COLS.map((c, i) => th(`ho.${c.key}`, `Untouched: ${c.label}`, c.lowerBetter, `text-right ${firstBorder(i)}`)),
                    ...RANKING_COLS.map((c, i) => th(`oos.${c.key}`, `Ranking: ${c.label}`, c.lowerBetter, `text-right ${firstBorder(i)}`)),
                    ...TUNED_COLS.map((c, i) => th(`is.${c.key}`, `Tuning: ${c.label}`, c.lowerBetter, `text-right ${firstBorder(i)}`)),
                    th("score", "Rank score", false, "text-right border-l border-border"),
                  ]
                : null}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => {
              const v = VERDICT[verdict(r)];
              const active = selected ? isSame(r, selected) : false;
              const params = fmtParams(r.params);
              const ho = r.holdout;
              return (
                <tr
                  key={`${r.symbol}|${r.strategyId}|${params}|${i}`}
                  onClick={() => onSelect(r)}
                  className={`cursor-pointer border-t border-border hover:bg-surface-2/60 ${active ? "bg-surface-2" : ""}`}
                  title="Click to see every trade"
                >
                  <td className="px-2 py-1.5 font-medium">{shortSymbol(r.symbol)}</td>
                  <td className="px-2 py-1.5">
                    <div className="whitespace-nowrap">{r.strategyName}</div>
                    {params ? (
                      <div className="max-w-[220px] truncate text-[11px] text-muted" title={params}>
                        {params}
                      </div>
                    ) : null}
                  </td>
                  <td className={`px-2 py-1.5 text-right font-semibold tabular-nums ${ho ? pnlClass(ho.netPnl) : "text-muted"}`}>
                    {ho ? fmtINR(ho.netPnl) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{ho ? fmtPct(ho.winRate) : "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{ho ? fmtPF(ho.profitFactor) : "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{ho ? ho.totalTrades : "—"}</td>
                  <td className="px-2 py-1.5">
                    <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-semibold ${v.cls}`}>{v.label}</span>
                  </td>
                  {showAll ? (
                    <>
                      {HOLDOUT_EXTRA_COLS.map((c, j) => (
                        <td key={`ho.${c.key}`} className={`px-2 py-1.5 text-right text-xs tabular-nums ${firstBorder(j)}`}>
                          {ho ? c.fmt(ho[c.key]) : "—"}
                        </td>
                      ))}
                      {RANKING_COLS.map((c, j) => (
                        <td key={`oos.${c.key}`} className={`px-2 py-1.5 text-right text-xs tabular-nums ${firstBorder(j)}`}>
                          {c.fmt(r.outSample[c.key])}
                        </td>
                      ))}
                      {TUNED_COLS.map((c, j) => (
                        <td key={`is.${c.key}`} className={`px-2 py-1.5 text-right text-xs tabular-nums text-muted ${firstBorder(j)}`}>
                          {c.fmt(r.inSample[c.key])}
                        </td>
                      ))}
                      <td className="border-l border-border px-2 py-1.5 text-right text-xs tabular-nums">{fmtNum(r.score, 3)}</td>
                    </>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="text-xs text-muted underline hover:text-text" onClick={() => setShowAll((s) => !s)}>
          {showAll ? "Hide extra numbers" : "Show all numbers"}
        </button>
        {sort ? (
          <button type="button" className="text-xs text-muted underline hover:text-text" onClick={() => setSort(null)}>
            Back to ranking order
          </button>
        ) : null}
      </div>
    </div>
  );
}
