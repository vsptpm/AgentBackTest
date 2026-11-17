"use client";

import { useState } from "react";
import type { FinderConfig, Interval } from "@/lib/types";
import { parseINR } from "@/lib/format";
import type { StrategyInfo, SymbolInfo } from "@/lib/mock";
import { Field, Spinner, capitalError } from "@/components/ui";
import { CapitalInput } from "@/components/CapitalInput";
import { HistoryRange, INTERVALS, defaultRange, isIntraday, useUpstoxHistory } from "@/components/BacktestForm";

const OBJECTIVES: { value: FinderConfig["objective"]; label: string }[] = [
  { value: "score", label: "Steady gain per trade (recommended)" },
  { value: "profitFactor", label: "Profit factor (won ÷ lost)" },
  { value: "expectancyR", label: "Average gain per unit of risk" },
  { value: "lossRate", label: "Fewest losing trades" },
];

const START_INTERVAL: Interval = INTERVALS.includes("5m") ? "5m" : INTERVALS[0];

/** RELIANCE.NS → RELIANCE, ^NSEI → NSEI */
function shortSymbol(s: string): string {
  return s.replace(/\.(NS|BO)$/, "").replace(/^\^/, "");
}

export function defaultMinTrades(i: Interval): number {
  return isIntraday(i) ? 20 : 30;
}

function CheckList<T extends { key: string; label: string; sub?: string }>({
  items,
  selected,
  onToggle,
  maxHeight = 176,
}: {
  items: T[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  maxHeight?: number;
}) {
  return (
    <div className="overflow-auto rounded-md border border-border bg-bg" style={{ maxHeight }}>
      {items.map((it) => (
        <label key={it.key} className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm hover:bg-surface-2">
          <input type="checkbox" checked={selected.has(it.key)} onChange={() => onToggle(it.key)} />
          <span className="font-medium">{it.label}</span>
          {it.sub ? <span className="ml-auto truncate text-xs text-muted">{it.sub}</span> : null}
        </label>
      ))}
      {items.length === 0 ? <div className="px-2 py-2 text-xs text-muted">None</div> : null}
    </div>
  );
}

export function FinderForm({
  strategies,
  symbols,
  onRun,
  running,
}: {
  strategies: StrategyInfo[];
  symbols: SymbolInfo[];
  onRun: (config: FinderConfig) => void;
  running: boolean;
}) {
  // Page mounts this form after the catalog loads; default to all indices + all strategies.
  const [symSel, setSymSel] = useState<Set<string>>(() => {
    // Intraday equity first: indices cannot be bought as shares.
    const stocks = symbols.filter((s) => s.kind === "stock").map((s) => s.symbol);
    return new Set((stocks.length ? stocks : symbols.map((s) => s.symbol)).slice(0, 5));
  });
  const [stratSel, setStratSel] = useState<Set<string>>(() => new Set(strategies.map((s) => s.id)));
  const [interval, setIntervalState] = useState<Interval>(START_INTERVAL);
  const [range, setRange] = useState(() => defaultRange(START_INTERVAL));
  const upstox = useUpstoxHistory(setRange);
  const [capitalRaw, setCapitalRaw] = useState("100000");
  const [capitalTouched, setCapitalTouched] = useState(false);
  const [riskPct, setRiskPct] = useState(1);
  const [trainPct, setTrainPct] = useState(50);
  const [minTrades, setMinTrades] = useState(defaultMinTrades(START_INTERVAL));
  const [objective, setObjective] = useState<FinderConfig["objective"]>("score");
  const [maxCombos, setMaxCombos] = useState(60);

  function toggle(set: Set<string>, key: string): Set<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  function changeInterval(i: Interval) {
    setIntervalState(i);
    setRange(defaultRange(i, upstox));
    setMinTrades(defaultMinTrades(i));
  }

  const capital = parseINR(capitalRaw);
  const capErr = capitalError(capital, capitalRaw);
  const unsupported = [...stratSel].filter((id) => {
    const s = strategies.find((x) => x.id === id);
    return s && !s.intervals.includes(interval);
  });
  // Indices cannot be traded as intraday equity; the Finder skips them.
  const indexCount = [...symSel].filter((s) => s.startsWith("^")).length;
  const stockCount = symSel.size - indexCount;
  const selErr =
    stockCount === 0
      ? indexCount > 0
        ? "Indices can't be traded as shares. Pick at least one stock."
        : "Pick at least one stock."
      : stratSel.size === 0
        ? "Pick at least one strategy."
        : undefined;
  const dateErr = range.from >= range.to ? "From must be before To." : undefined;
  const canRun = !running && !capErr && !selErr && !dateErr;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setCapitalTouched(true);
    if (!canRun) return;
    onRun({
      symbols: [...symSel],
      strategyIds: [...stratSel],
      interval,
      from: range.from,
      to: range.to,
      capital,
      riskPerTrade: riskPct / 100,
      trainFraction: trainPct / 100,
      minTrades,
      objective,
      maxCombos,
    });
  }

  const stocks = symbols.filter((s) => s.kind === "stock").map((s) => s.symbol);

  const usableCount = stratSel.size - unsupported.length;
  // What is left after tuning is split evenly: one half ranks, the other is the untouched check.
  const holdoutPct = Math.round((100 - trainPct) / 2);
  const formErr = selErr ?? dateErr ?? (usableCount === 0 ? `None of the chosen strategies work on ${interval} bars.` : undefined);

  return (
    <form onSubmit={submit} className="card flex flex-col gap-3 p-3">
      <CapitalInput raw={capitalRaw} onRaw={setCapitalRaw} touched={capitalTouched} onTouched={() => setCapitalTouched(true)} />

      <button type="submit" className="btn btn-primary w-full py-2" disabled={!canRun || usableCount === 0}>
        {running ? <Spinner label="Searching…" /> : "Find what works"}
      </button>
      {formErr ? <p className="-mt-1 text-center text-[11px] text-red">{formErr}</p> : null}

      <p className="text-[11px] text-muted">
        {running
          ? upstox && isIntraday(interval)
            ? "Trying every setting on every stock. The first run of a long range downloads its history and can take a minute or two."
            : "Trying every setting on every stock. This can take 10–60 seconds."
          : `Testing ${usableCount} strateg${usableCount === 1 ? "y" : "ies"} on ${stockCount} stock${stockCount === 1 ? "" : "s"} with ${interval} bars, ${range.from} to ${range.to}. The last ${holdoutPct}% of that period is never used to tune or rank; it only checks the results.`}
      </p>
      {indexCount > 0 && stockCount > 0 ? (
        <p className="-mt-2 text-[11px] text-amber">
          {indexCount} index{indexCount === 1 ? "" : "es"} selected will be skipped: indices can&apos;t be traded as shares.
        </p>
      ) : null}

      <details className="rounded-md border border-border px-2 py-1.5">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-muted">Change stocks &amp; settings</summary>
        <div className="mt-3 flex flex-col gap-3">
          <Field label={`Stocks (${symSel.size})`}>
            <div className="mb-1 flex flex-wrap gap-1">
              <button type="button" className="btn px-2 py-0.5 text-[11px]" onClick={() => setSymSel(new Set(stocks))}>
                All stocks
              </button>
              <button type="button" className="btn px-2 py-0.5 text-[11px]" onClick={() => setSymSel(new Set())}>
                None
              </button>
            </div>
            <CheckList
              items={symbols.filter((s) => s.kind === "stock").map((s) => ({ key: s.symbol, label: shortSymbol(s.symbol), sub: s.name }))}
              selected={symSel}
              onToggle={(k) => setSymSel((s) => toggle(s, k))}
            />
          </Field>

          <Field
            label={`Strategies (${stratSel.size})`}
            hint={unsupported.length ? `${unsupported.length} of these can't run on ${interval} bars and will be skipped.` : undefined}
          >
            <CheckList
              items={strategies.map((s) => ({ key: s.id, label: s.name, sub: s.intervals.join("/") }))}
              selected={stratSel}
              onToggle={(k) => setStratSel((s) => toggle(s, k))}
              maxHeight={120}
            />
          </Field>

          <Field label="Bar size">
            <div className="flex gap-1 rounded-md border border-border bg-bg p-0.5">
              {INTERVALS.map((i) => (
                <label
                  key={i}
                  className={`flex-1 cursor-pointer rounded px-2 py-1 text-center text-sm ${
                    i === interval ? "bg-surface-2 text-text" : "text-muted hover:text-text"
                  }`}
                >
                  <input type="radio" name="f-interval" className="sr-only" checked={i === interval} onChange={() => changeInterval(i)} />
                  {i}
                </label>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="From">
              <input className="input" type="date" value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
            </Field>
            <Field label="To">
              <input className="input" type="date" value={range.to} min={range.from} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
            </Field>
          </div>
          {isIntraday(interval) ? <HistoryRange connected={upstox} range={range} onRange={setRange} /> : null}

          <div className="grid grid-cols-2 gap-2">
            <Field label="Risk / trade %">
              <input className="input" type="number" min={0.1} max={10} step={0.1} value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value) || 1)} />
            </Field>
            <Field label="Tune on first %" hint={`Settings are tuned on the first ${trainPct}%, ranked on the next ${100 - trainPct - holdoutPct}%, and the last ${holdoutPct}% is an untouched final check.`}>
              <input className="input" type="number" min={50} max={90} step={5} value={trainPct} onChange={(e) => setTrainPct(Math.min(90, Math.max(50, Number(e.target.value) || 50)))} />
            </Field>
            <Field label="Min trades to count">
              <input className="input" type="number" min={5} max={500} step={1} value={minTrades} onChange={(e) => setMinTrades(Math.max(1, Math.round(Number(e.target.value) || 1)))} />
            </Field>
            <Field label="Max settings tried">
              <input className="input" type="number" min={1} max={500} step={1} value={maxCombos} onChange={(e) => setMaxCombos(Math.max(1, Math.round(Number(e.target.value) || 1)))} />
            </Field>
          </div>

          <Field label="Rank by">
            <select className="input" value={objective} onChange={(e) => setObjective(e.target.value as FinderConfig["objective"])}>
              {OBJECTIVES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </details>
    </form>
  );
}
