import type { Metrics } from "@/lib/types";
import { fmtINR, fmtNum, fmtPct, fmtPctRaw, fmtR } from "@/lib/format";
import { pnlClass } from "@/components/ui";

export function lossRateClass(rate: number): string {
  if (!Number.isFinite(rate)) return "text-muted";
  if (rate < 0.35) return "text-green";
  if (rate <= 0.5) return "text-amber";
  return "text-red";
}

interface Tile {
  label: string;
  value: string;
  sub?: string;
  cls?: string;
}

function Tile({ t }: { t: Tile }) {
  return (
    <div className="card flex flex-col justify-between px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">{t.label}</div>
      <div className={`mt-1 text-lg font-semibold leading-tight ${t.cls ?? ""}`}>{t.value}</div>
      {t.sub ? <div className="text-[11px] text-muted">{t.sub}</div> : null}
    </div>
  );
}

export function MetricTiles({ m }: { m: Metrics }) {
  const pfText = Number.isFinite(m.profitFactor) ? fmtNum(m.profitFactor, 2) : "∞";
  const excess = m.netReturnPct - m.buyHoldReturnPct;
  const tiles: Tile[] = [
    {
      label: "Profit factor",
      value: pfText,
      sub: `${fmtINR(m.grossProfit, { compact: true })} / ${fmtINR(Math.abs(m.grossLoss), { compact: true })}`,
      cls: m.profitFactor >= 1.5 ? "text-green" : m.profitFactor >= 1 ? "text-amber" : "text-red",
    },
    {
      label: "Expectancy",
      value: fmtINR(m.expectancy),
      sub: `${fmtR(m.expectancyR)} per trade`,
      cls: pnlClass(m.expectancy),
    },
    {
      label: "Max drawdown",
      value: fmtINR(-m.maxDrawdown),
      sub: fmtPctRaw(-m.maxDrawdownPct),
      cls: "text-red",
    },
    {
      label: "Win rate",
      value: fmtPct(m.winRate),
      sub: `${m.wins}W · ${m.losses}L · ${m.breakeven}BE`,
    },
    { label: "Net P&L", value: fmtINR(m.netPnl), cls: pnlClass(m.netPnl) },
    { label: "Net return", value: fmtPctRaw(m.netReturnPct), cls: pnlClass(m.netReturnPct) },
    {
      label: "vs Buy & Hold",
      value: fmtPctRaw(excess),
      sub: `B&H ${fmtPctRaw(m.buyHoldReturnPct)}`,
      cls: pnlClass(excess),
    },
    { label: "Total trades", value: String(m.totalTrades) },
    {
      label: "Max consec. losses",
      value: String(m.maxConsecutiveLosses),
      sub: `max wins ${m.maxConsecutiveWins}`,
      cls: m.maxConsecutiveLosses >= 6 ? "text-red" : m.maxConsecutiveLosses >= 4 ? "text-amber" : "",
    },
    // Sharpe is NaN (null over JSON) when the run covers fewer than 60 trading days.
    Number.isFinite(m.sharpe)
      ? { label: "Sharpe", value: fmtNum(m.sharpe, 2), cls: m.sharpe >= 1 ? "text-green" : "" }
      : { label: "Sharpe", value: "n/a", sub: "needs 60+ trading days", cls: "text-muted" },
    { label: "Avg bars held", value: fmtNum(m.avgBarsHeld, 1) },
    {
      label: "Total costs",
      value: fmtINR(m.totalCosts),
      sub: m.totalTrades ? `${fmtINR(m.totalCosts / m.totalTrades)} / trade` : undefined,
    },
    {
      label: "Avg win / loss",
      value: `${fmtINR(m.avgWin, { compact: true })} / ${fmtINR(m.avgLoss, { compact: true })}`,
      sub: `best ${fmtINR(m.largestWin, { compact: true })} · worst ${fmtINR(m.largestLoss, { compact: true })}`,
    },
  ];

  // Four numbers a trader needs first, in plain words. Everything else sits behind "All numbers".
  const headline: Tile[] = [
    { label: "Profit after costs", value: fmtINR(m.netPnl), sub: `${fmtPctRaw(m.netReturnPct)} on capital`, cls: pnlClass(m.netPnl) },
    {
      label: "Trades lost",
      value: fmtPct(m.lossRate),
      sub: `${m.losses} of ${m.totalTrades} trades · lower is better`,
      cls: lossRateClass(m.lossRate),
    },
    { label: "Average per trade", value: fmtINR(m.expectancy), sub: `costs ${fmtINR(m.totalTrades ? m.totalCosts / m.totalTrades : 0)} each`, cls: pnlClass(m.expectancy) },
    { label: "Worst losing stretch", value: fmtINR(-m.maxDrawdown), sub: `${m.maxConsecutiveLosses} losses in a row at worst`, cls: "text-red" },
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {headline.map((t) => (
          <Tile key={t.label} t={t} />
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-muted hover:text-text">All numbers</summary>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {tiles.map((t) => (
            <Tile key={t.label} t={t} />
          ))}
        </div>
      </details>
    </div>
  );
}
