"use client";

import { useState } from "react";
import type { BacktestConfig, BacktestResult } from "@/lib/types";
import { errorMessage, runBacktest } from "@/components/api";
import { useCatalog } from "@/components/useCatalog";
import { BacktestForm } from "@/components/BacktestForm";
import { ResultReport } from "@/components/ResultReport";
import { Banner, Spinner } from "@/components/ui";

export function BacktestPage() {
  const catalog = useCatalog();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRun(config: BacktestConfig) {
    setRunning(true);
    setError(null);
    try {
      const r = await runBacktest(config);
      setResult(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  const strategyName = result
    ? catalog.strategies.find((s) => s.id === result.config.strategyId)?.name
    : undefined;

  return (
    <div className="grid flex-1 gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <aside className="lg:sticky lg:top-[60px] lg:self-start">
        {catalog.loading ? (
          <div className="card flex h-40 items-center justify-center">
            <Spinner label="Loading strategies & symbols…" />
          </div>
        ) : (
          <BacktestForm
            strategies={catalog.strategies}
            symbols={catalog.symbols}
            onRun={onRun}
            running={running}
          />
        )}
        {catalog.error ? <div className="mt-2"><Banner tone="red">{catalog.error}</Banner></div> : null}
      </aside>

      <section className="min-w-0">
        {error ? (
          <div className="mb-3">
            <Banner tone="red">Backtest failed: {error}</Banner>
          </div>
        ) : null}
        {running ? (
          <div className="card flex h-64 items-center justify-center">
            <Spinner label="Fetching candles and running the engine…" />
          </div>
        ) : result ? (
          <ResultReport result={result} strategyName={strategyName} />
        ) : (
          <div className="card flex h-64 flex-col items-center justify-center gap-1 text-center text-sm text-muted">
            <p>No result yet.</p>
            <p>Pick a symbol and strategy, enter capital, then run.</p>
            <p className="text-xs">You get a plain verdict first, then the detail.</p>
          </div>
        )}
      </section>
    </div>
  );
}
