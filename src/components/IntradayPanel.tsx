"use client";

import { useMemo } from "react";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Trade } from "@/lib/types";
import { computeIntradayStats } from "@/lib/backtest/intraday";
import type { DayPnl, GroupStat, HourBucket } from "@/lib/backtest/intraday";
import { fmtINR, fmtISTDate, fmtNum, fmtPct, fmtPctRaw, fmtR } from "@/lib/format";
import { pnlClass } from "@/components/ui";

const REASON_LABEL: Record<Trade["exitReason"], string> = {
  signal: "Signal",
  stop: "Stop-loss",
  target: "Target",
  squareoff: "Square-off",
  end: "End of data",
};

/** "YYYY-MM-DD" (IST day) → "30 Oct 2026". */
function fmtDay(day: string): string {
  return fmtISTDate(Date.parse(`${day}T00:00:00+05:30`));
}

function Tile({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="card flex flex-col justify-between px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold leading-tight ${cls ?? ""}`}>{value}</div>
      {sub ? <div className="text-[11px] text-muted">{sub}</div> : null}
    </div>
  );
}

interface TooltipBoxProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
}

function DayTooltip({ active, payload }: TooltipBoxProps) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0]?.payload as DayPnl | undefined;
  if (!d) return null;
  return (
    <div className="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs shadow-lg">
      <div className="text-muted">{fmtDay(d.day)}</div>
      <div className={`mt-0.5 font-medium ${pnlClass(d.pnl)}`}>{fmtINR(d.pnl)}</div>
      <div className="text-muted">
        {d.trades} trade{d.trades === 1 ? "" : "s"}
      </div>
    </div>
  );
}

const th = "px-2 py-1.5 text-right font-medium";
const td = "border-t border-border px-2 py-1.5 text-right";

function Badge({ tone, children }: { tone: "green" | "red"; children: ReactNode }) {
  const cls = tone === "green" ? "border-green/40 bg-green/10 text-green" : "border-red/40 bg-red/10 text-red";
  return (
    <span className={`ml-1.5 rounded border px-1 py-px text-[10px] font-semibold uppercase tracking-wide ${cls}`}>
      {children}
    </span>
  );
}

function HourTable({ rows }: { rows: HourBucket[] }) {
  const active = rows.filter((r) => r.trades > 0);
  const maxAbs = Math.max(...active.map((r) => Math.abs(r.pnl)), 0);
  // Only call out a best / worst hour when there is something to compare.
  const best = active.length > 1 ? active.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  const worst = active.length > 1 ? active.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null;
  const isBest = (r: HourBucket) => best !== null && r.hour === best.hour && r.pnl > 0;
  const isWorst = (r: HourBucket) => worst !== null && r.hour === worst.hour && r.pnl < 0;

  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-xs">
        <thead>
          <tr className="text-muted">
            <th className="px-2 py-1.5 text-left font-medium">Entry time (IST)</th>
            <th className={th}>Trades</th>
            <th className={th}>Win rate</th>
            <th className={th}>Avg R</th>
            <th className={th}>Net P&amp;L</th>
            <th className="w-[30%] px-2 py-1.5 text-left font-medium" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const empty = r.trades === 0;
            const rowBg = isBest(r) ? "bg-green/10" : isWorst(r) ? "bg-red/10" : "";
            const width = maxAbs > 0 ? `${Math.max(2, (Math.abs(r.pnl) / maxAbs) * 100)}%` : "0%";
            return (
              <tr key={r.hour} className={rowBg}>
                <td className="border-t border-border px-2 py-1.5 text-left font-mono whitespace-nowrap">
                  <span className={empty ? "text-muted" : ""}>{r.label}</span>
                  {isBest(r) ? <Badge tone="green">Best</Badge> : null}
                  {isWorst(r) ? <Badge tone="red">Worst</Badge> : null}
                </td>
                <td className={`${td} ${empty ? "text-muted" : ""}`}>{r.trades}</td>
                <td className={td}>{empty ? <span className="text-muted">—</span> : fmtPct(r.winRate, 0)}</td>
                <td className={`${td} ${pnlClass(r.avgR)}`}>{fmtR(r.avgR)}</td>
                <td className={`${td} font-semibold ${pnlClass(r.pnl)}`}>
                  {empty ? "—" : fmtINR(r.pnl, { compact: true })}
                </td>
                <td className="border-t border-border px-2 py-1.5">
                  {!empty && r.pnl !== 0 ? (
                    <div
                      className="h-2 rounded-sm"
                      style={{ width, backgroundColor: r.pnl > 0 ? "var(--green)" : "var(--red)", opacity: 0.75 }}
                      title={`${r.label} · ${fmtINR(r.pnl)} · ${r.wins}/${r.trades} wins`}
                    />
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GroupTable({ head, rows }: { head: string; rows: ({ name: string } & GroupStat)[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-muted">
            <th className="px-2 py-1.5 text-left font-medium">{head}</th>
            <th className={th}>Trades</th>
            <th className={th}>Win rate</th>
            <th className={th}>Net P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const empty = r.trades === 0;
            return (
              <tr key={r.name}>
                <td className={`border-t border-border px-2 py-1.5 text-left ${empty ? "text-muted" : ""}`}>{r.name}</td>
                <td className={`${td} ${empty ? "text-muted" : ""}`}>{r.trades}</td>
                <td className={td}>{empty ? <span className="text-muted">—</span> : fmtPct(r.winRate, 0)}</td>
                <td className={`${td} font-semibold ${pnlClass(r.pnl)}`}>
                  {empty ? "—" : fmtINR(r.pnl, { compact: true })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function IntradayPanel({ trades, capital }: { trades: Trade[]; capital: number }) {
  const s = useMemo(() => computeIntradayStats(trades, capital), [trades, capital]);
  if (s.tradingDays === 0) return null;

  const streakCls = s.maxConsecutiveLossDays >= 5 ? "text-red" : s.maxConsecutiveLossDays >= 3 ? "text-amber" : "";

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Tile
          label="Win days"
          value={fmtPct(s.winDayRate)}
          sub={`${s.winDays} up · ${s.lossDays} down of ${s.tradingDays} days`}
          cls={s.winDayRate >= 0.5 ? "text-green" : "text-amber"}
        />
        <Tile label="Avg day P&L" value={fmtINR(s.avgDayPnl)} cls={pnlClass(s.avgDayPnl)} />
        <Tile
          label="Best day"
          value={s.bestDay ? fmtINR(s.bestDay.pnl) : "—"}
          sub={s.bestDay ? fmtDay(s.bestDay.day) : undefined}
          cls={pnlClass(s.bestDay?.pnl ?? 0)}
        />
        <Tile
          label="Worst day"
          value={s.worstDay ? fmtINR(s.worstDay.pnl) : "—"}
          sub={s.worstDay ? `${fmtDay(s.worstDay.day)} · ${fmtPctRaw(s.worstDayPctOfCapital, 2)} of capital` : undefined}
          cls={pnlClass(s.worstDay?.pnl ?? 0)}
        />
        <Tile label="Max losing-day streak" value={String(s.maxConsecutiveLossDays)} sub="consecutive red days" cls={streakCls} />
        <Tile label="Avg trades / day" value={fmtNum(s.avgTradesPerDay, 1)} sub={`max ${s.maxTradesInDay} in a day`} />
      </div>

      <div className="card px-1 pt-2 pb-1" style={{ height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={s.days} margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="2 4" />
            <XAxis
              dataKey="day"
              tickFormatter={(d: string) => fmtDay(d).slice(0, 6)}
              minTickGap={48}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tickFormatter={(v: number) => fmtINR(v, { compact: true })}
              width={64}
              tickLine={false}
              axisLine={false}
            />
            <ReferenceLine y={0} stroke="var(--border-strong)" />
            <Tooltip content={DayTooltip} cursor={{ fill: "var(--border)", opacity: 0.4 }} isAnimationActive={false} />
            <Bar dataKey="pnl" isAnimationActive={false} maxBarSize={18}>
              {s.days.map((d) => (
                <Cell key={d.day} fill={d.pnl >= 0 ? "var(--green)" : "var(--red)"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <HourTable rows={s.byHour} />

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <GroupTable head="Weekday" rows={s.byWeekday.map((w) => ({ name: w.weekday, ...w }))} />
        <GroupTable head="Exit reason" rows={s.byExitReason.map((r) => ({ name: REASON_LABEL[r.reason] ?? r.reason, ...r }))} />
        <GroupTable
          head="Side"
          rows={[
            { name: "Long", ...s.bySide.long },
            { name: "Short", ...s.bySide.short },
          ]}
        />
      </div>
    </div>
  );
}
