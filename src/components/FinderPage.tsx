"use client";

import { useRef, useState } from "react";
import { DEFAULT_COSTS, type BacktestConfig, type BacktestResult, type FinderConfig, type FinderRow } from "@/lib/types";
import { errorMessage, runBacktest, runFinder, type FinderResponse } from "@/components/api";
import { useCatalog } from "@/components/useCatalog";
import { FinderForm } from "@/components/FinderForm";
import { FinderTable, verdict } from "@/components/FinderTable";
import { ResultReport } from "@/components/ResultReport";
import { Banner, SectionTitle, Spinner } from "@/components/ui";

export function FinderPage() {
  const catalog = useCatalog();
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState(0);
  const [config, setConfig] = useState<FinderConfig | null>(null);
  const [response, setResponse] = useState<FinderResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<FinderRow | null>(null);
  const [detail, setDetail] = useState<BacktestResult | null>(null);
  const [detailRunning, setDetailRunning] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  async function onRun(cfg: FinderConfig) {
    setRunning(true);
    setError(null);
    setResponse(null);
    setSelected(null);
    setDetail(null);
    setConfig(cfg);
    setRunId((n) => n + 1);
    try {
      setResponse(await runFinder(cfg));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  async function onSelect(row: FinderRow) {
    if (!config) return;
    setSelected(row);
    setDetailRunning(true);
    setDetailError(null);
    const bt: BacktestConfig = {
      symbol: row.symbol,
      interval: config.interval,
      from: config.from,
      to: config.to,
      strategyId: row.strategyId,
      params: row.params,
      capital: config.capital,
      riskPerTrade: config.riskPerTrade,
      // Must match the Finder's own runs (src/lib/optimizer) so row and detail agree.
      positionFraction: 1,
      squareOffTime: "15:05",
      costs: DEFAULT_COSTS,
      allowShort: true,
    };
    try {
      setDetail(await runBacktest(bt));
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (e) {
      setDetailError(errorMessage(e));
    } finally {
      setDetailRunning(false);
    }
  }

  const shown = response?.rows.length ?? 0;
  const holds = (response?.rows ?? []).filter((r) => verdict(r) === "holds").length;
  const tried = response?.candidatesTested;
  const sessions = response?.sessions;
  const totalSessions = sessions ? sessions.tune + sessions.select + sessions.holdout : null;

  return (
    <div className="grid flex-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="lg:sticky lg:top-[60px] lg:self-start">
        {catalog.loading ? (
          <div className="card flex h-40 items-center justify-center">
            <Spinner label="Loading strategies & symbols…" />
          </div>
        ) : (
          <FinderForm strategies={catalog.strategies} symbols={catalog.symbols} onRun={onRun} running={running} />
        )}
        {catalog.error ? <div className="mt-2"><Banner tone="red">{catalog.error}</Banner></div> : null}
      </aside>

      <section className="flex min-w-0 flex-col gap-4">
        {error ? <Banner tone="red">Search failed: {error}</Banner> : null}

        {running ? (
          <div className="card flex h-64 flex-col items-center justify-center gap-2">
            <Spinner label="Searching…" />
            <p className="px-4 text-center text-xs text-muted">
              Tuning each strategy on the first part of the period, ranking on the next part, then checking on a final part nothing else touched.
            </p>
          </div>
        ) : response ? (
          <>
            {response.warnings.length > 0 ? (
              <Banner tone="amber">
                <ul className="list-disc space-y-0.5 pl-4">
                  {response.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Banner>
            ) : null}
            {totalSessions !== null && totalSessions < 60 ? (
              <Banner tone="amber">
                Only about {totalSessions} trading day{totalSessions === 1 ? "" : "s"} of data — treat every row as a hypothesis, not proof.
              </Banner>
            ) : null}
            <div className="flex flex-col gap-2">
              <div>
                <h2 className="text-base font-semibold">
                  {shown === 0
                    ? tried !== undefined
                      ? `Nothing passed — out of ${tried} combination${tried === 1 ? "" : "s"} tried`
                      : "Nothing to show yet"
                    : `${holds} of ${shown} shown hold${holds === 1 ? "s" : ""} up on untouched data${
                        tried !== undefined ? ` — out of ${tried} combination${tried === 1 ? "" : "s"} tried` : ""
                      }. With that many tries, a few will look good by luck.`}
                </h2>
                <p className="text-xs text-muted">Ranked on a separate slice; the result shown was never used to pick or rank.</p>
                {sessions ? (
                  <p className="text-[11px] text-muted">
                    Tuned on {sessions.tune} days, ranked on {sessions.select}, checked on {sessions.holdout}. Click a row to see every trade.
                  </p>
                ) : null}
              </div>
              <FinderTable key={runId} rows={response.rows} onSelect={onSelect} selected={selected} />
            </div>
          </>
        ) : (
          <div className="card flex h-64 flex-col items-center justify-center gap-1 text-center text-sm text-muted">
            <p>Find out which strategy has actually been working on which stock.</p>
            <p>Enter your capital and press “Find what works”.</p>
          </div>
        )}

        <div ref={detailRef}>
          {detailError ? <Banner tone="red">Backtest failed: {detailError}</Banner> : null}
          {detailRunning ? (
            <div className="card flex h-40 items-center justify-center">
              <Spinner label={`Backtesting ${selected?.symbol ?? ""} · ${selected?.strategyName ?? ""} over the full range…`} />
            </div>
          ) : detail ? (
            <section>
              <SectionTitle>Every trade over the whole period</SectionTitle>
              <ResultReport result={detail} strategyName={selected?.strategyName} />
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}
