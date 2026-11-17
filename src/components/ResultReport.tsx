"use client";

import { useCallback, useRef, useState } from "react";
import type { BacktestResult } from "@/lib/types";
import { fmtINR, fmtISTDate, fmtParams } from "@/lib/format";
import { MetricTiles } from "@/components/MetricTiles";
import { EquityChart } from "@/components/EquityChart";
import { MonthlyHeatmap } from "@/components/MonthlyHeatmap";
import { IntradayPanel } from "@/components/IntradayPanel";
import { TradeTable } from "@/components/TradeTable";
import { TradeChart } from "@/components/TradeChart";
import { Banner, SectionTitle } from "@/components/ui";

/** One plain-language line: is this worth trading? Thresholds are rules of thumb, not statistics. */
function Verdict({ result }: { result: BacktestResult }) {
  const m = result.metrics;
  if (m.totalTrades === 0) return <Banner tone="muted">No trades in this period — nothing to judge.</Banner>;

  const pf = Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞";
  const facts = `${fmtINR(m.netPnl)} net after costs over ${m.totalTrades} trades · wins ${(m.winRate * 100).toFixed(0)}% · profit factor ${pf} · worst drawdown ${m.maxDrawdownPct.toFixed(1)}%`;

  let label: string;
  let cls: string;
  if (m.netPnl <= 0) {
    label = "Loses money after costs";
    cls = "border-red/40 bg-red/10 text-red";
  } else if (m.totalTrades < 20) {
    label = "Profitable, but too few trades to trust";
    cls = "border-amber/40 bg-amber/10 text-amber";
  } else if (m.profitFactor < 1.3) {
    label = "Marginal edge — costs or slippage could erase it";
    cls = "border-amber/40 bg-amber/10 text-amber";
  } else {
    label = "Profitable in this backtest";
    cls = "border-green/40 bg-green/10 text-green";
  }
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${cls}`} role="status">
      <span className="font-semibold">{label}.</span> <span className="text-text">{facts}</span>
    </div>
  );
}

export function ResultReport({ result, strategyName }: { result: BacktestResult; strategyName?: string }) {
  const { config, metrics, period, warnings } = result;
  const paramStr = fmtParams(config.params);
  const hasCandles = (result.candles?.length ?? 0) > 0;

  const [selectedTradeId, setSelectedTradeId] = useState<number | null>(null);
  const chartAnchorRef = useRef<HTMLElement>(null);

  // A new result means the old selection no longer refers to anything (reset during render, per React docs).
  const [prevResult, setPrevResult] = useState(result);
  if (prevResult !== result) {
    setPrevResult(result);
    setSelectedTradeId(null);
  }

  const onSelectFromChart = useCallback((id: number | null) => setSelectedTradeId(id), []);

  // Table rows can be far below the chart; bring the chart back into view when a row is picked.
  const onSelectFromTable = useCallback((id: number | null) => {
    setSelectedTradeId(id);
    if (id != null) chartAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="text-base font-semibold">{config.symbol}</span>
        <span className="text-muted">·</span>
        <span>{strategyName ?? config.strategyId}</span>
        {paramStr ? <span className="font-mono text-xs text-muted">({paramStr})</span> : null}
        <span className="text-muted">·</span>
        <span className="font-mono text-xs">{config.interval}</span>
        <span className="text-muted">·</span>
        <span className="text-muted">
          {fmtISTDate(period.from)} → {fmtISTDate(period.to)}
        </span>
        <span className="text-muted">·</span>
        <span className="text-muted">{period.bars.toLocaleString("en-IN")} bars</span>
        <span className="text-muted">·</span>
        <span>
          capital <span className="font-medium">{fmtINR(config.capital)}</span>
        </span>
        <span className="text-muted">·</span>
        <span className="text-muted">risk {(config.riskPerTrade * 100).toFixed(2)}%</span>
        {!config.allowShort ? <span className="text-muted">· long only</span> : null}
      </div>

      {warnings.length > 0 ? (
        <Banner tone="amber">
          <ul className="list-disc space-y-0.5 pl-4">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <Verdict result={result} />

      <MetricTiles m={metrics} />

      {hasCandles ? (
        <section ref={chartAnchorRef} className="scroll-mt-[60px]">
          <SectionTitle
            right={
              <span className="text-[11px] text-muted">
                IST · ▲ long entry · ▼ short entry · ● exit (SL / TP / SIG / SQ / END) · red = risk zone, green = reward zone
              </span>
            }
          >
            Trades on chart
          </SectionTitle>
          <TradeChart
            candles={result.candles ?? []}
            trades={result.trades}
            overlays={result.overlays}
            interval={config.interval}
            selectedTradeId={selectedTradeId}
            onSelectTrade={onSelectFromChart}
          />
        </section>
      ) : null}

      <section>
        <SectionTitle>Equity &amp; drawdown</SectionTitle>
        <EquityChart equity={result.equity} capital={config.capital} />
      </section>

      {config.interval !== "1d" && result.trades.length > 0 ? (
        <details className="card px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Best and worst days, hours and weekdays</summary>
          <div className="mt-3">
            <IntradayPanel trades={result.trades} capital={config.capital} />
          </div>
        </details>
      ) : null}

      <details className="card px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">Month by month</summary>
        <div className="mt-3">
          <MonthlyHeatmap monthly={result.monthly} />
        </div>
      </details>

      <details className="card px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">
          All {result.trades.length} trades
          <span className="font-normal text-muted">{hasCandles ? " · click a row to see it on the chart" : ""}</span>
        </summary>
        <div className="mt-3">
          <TradeTable
            trades={result.trades}
            selectedId={hasCandles ? selectedTradeId : null}
            onSelect={hasCandles ? onSelectFromTable : undefined}
          />
        </div>
      </details>
    </div>
  );
}
