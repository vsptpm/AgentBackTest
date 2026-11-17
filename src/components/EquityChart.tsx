"use client";

import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EquityPoint } from "@/lib/types";
import { fmtINR, fmtISTDateTime, fmtISTMonth, fmtPctRaw } from "@/lib/format";

interface Point {
  time: number;
  equity: number;
  /** negative percent, e.g. -12.3 */
  ddPct: number;
}

function toPoints(equity: EquityPoint[]): Point[] {
  let peak = -Infinity;
  return equity.map((p) => {
    peak = Math.max(peak, p.equity);
    const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
    return { time: p.time, equity: p.equity, ddPct: -dd };
  });
}

/** Structural subset of Recharts' TooltipContentProps so the generic variance does not bite. */
interface TooltipBoxProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
}

function TooltipBox({ active, payload }: TooltipBoxProps) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0]?.payload as Point | undefined;
  if (!p) return null;
  return (
    <div className="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs shadow-lg">
      <div className="text-muted">{fmtISTDateTime(p.time)}</div>
      <div className="mt-0.5 font-medium">{fmtINR(p.equity)}</div>
      <div className={p.ddPct < 0 ? "text-red" : "text-muted"}>DD {fmtPctRaw(p.ddPct)}</div>
    </div>
  );
}

export function EquityChart({ equity, capital }: { equity: EquityPoint[]; capital: number }) {
  const data = useMemo(() => toPoints(equity), [equity]);
  if (data.length === 0) {
    return <div className="card flex h-80 items-center justify-center text-sm text-muted">No equity data</div>;
  }
  const last = data[data.length - 1].equity;
  const stroke = last >= capital ? "var(--green)" : "var(--red)";

  return (
    <div className="card px-1 pt-2 pb-1" style={{ height: 320 }}>
      <ResponsiveContainer width="100%" height="68%">
        <ComposedChart data={data} syncId="equity" margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.3} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="2 4" />
          <XAxis
            dataKey="time"
            type="number"
            domain={["dataMin", "dataMax"]}
            scale="time"
            tickFormatter={fmtISTMonth}
            minTickGap={48}
            tickLine={false}
            axisLine={false}
            hide
          />
          <YAxis
            dataKey="equity"
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => fmtINR(v, { compact: true })}
            width={64}
            tickLine={false}
            axisLine={false}
          />
          <ReferenceLine y={capital} stroke="var(--border-strong)" strokeDasharray="3 3" />
          <Tooltip content={TooltipBox} cursor={{ stroke: "var(--border-strong)" }} isAnimationActive={false} />
          <Area
            type="monotone"
            dataKey="equity"
            stroke={stroke}
            strokeWidth={1.5}
            fill="url(#eqFill)"
            isAnimationActive={false}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <ResponsiveContainer width="100%" height="32%">
        <ComposedChart data={data} syncId="equity" margin={{ top: 0, right: 12, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} strokeDasharray="2 4" />
          <XAxis
            dataKey="time"
            type="number"
            domain={["dataMin", "dataMax"]}
            scale="time"
            tickFormatter={fmtISTMonth}
            minTickGap={48}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            dataKey="ddPct"
            domain={["dataMin", 0]}
            tickFormatter={(v: number) => fmtPctRaw(v, 0)}
            width={64}
            tickLine={false}
            axisLine={false}
            tickCount={3}
          />
          <Tooltip content={() => null} cursor={{ stroke: "var(--border-strong)" }} />
          <Area
            type="step"
            dataKey="ddPct"
            stroke="var(--red)"
            strokeWidth={1}
            fill="var(--red)"
            fillOpacity={0.25}
            isAnimationActive={false}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
