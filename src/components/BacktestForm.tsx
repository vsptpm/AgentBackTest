"use client";

import { useEffect, useMemo, useState } from "react";
import { DEFAULT_COSTS, type BacktestConfig, type Interval, type Params } from "@/lib/types";
import { istToday, parseINR } from "@/lib/format";
import type { StrategyInfo, SymbolInfo } from "@/lib/mock";
import { Field, Spinner, capitalError } from "@/components/ui";
import { CapitalInput } from "@/components/CapitalInput";
import { SymbolCombobox } from "@/components/SymbolCombobox";
import { ParamFields, defaultParams } from "@/components/ParamFields";

export const INTERVALS: Interval[] = ["1d", "15m", "5m"];

export function isIntraday(i: Interval): boolean {
  return i !== "1d";
}

type DateRange = { from: string; to: string };

/** Quick ranges offered for 5m / 15m bars when Upstox history is connected. */
const QUICK_RANGES: { label: string; shift: { days?: number; years?: number } }[] = [
  { label: "2 months", shift: { days: -61 } },
  { label: "6 months", shift: { days: -183 } },
  { label: "1 year", shift: { years: -1 } },
  { label: "2 years", shift: { years: -2 } },
];
const DEFAULT_QUICK = QUICK_RANGES[1];

/** 1d → last 3 years; intraday → last 6 months with Upstox history, else last 55 days (Yahoo limit ~60d). */
export function defaultRange(interval: Interval, upstox = false): DateRange {
  const from = !isIntraday(interval) ? istToday({ years: -3 }) : upstox ? istToday(DEFAULT_QUICK.shift) : istToday({ days: -55 });
  return { from, to: istToday() };
}

/**
 * Whether Upstox history is connected (false until known). When it is, a range still on the
 * 55-day Yahoo default is widened to the 6-month default.
 */
export function useUpstoxHistory(setRange: (update: (r: DateRange) => DateRange) => void): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/upstox/status")
      .then((r) => r.json())
      .then((s: { connected?: boolean }) => {
        if (!alive || !s.connected) return;
        setConnected(true);
        setRange((r) => (r.from === defaultRange("5m").from ? defaultRange("5m", true) : r));
      })
      .catch(() => {
        /* status unknown: keep the short default */
      });
    return () => {
      alive = false;
    };
  }, [setRange]);
  return connected;
}

/** Shown under the dates for 5m / 15m bars: quick ranges when Upstox is connected, a pointer when not. */
export function HistoryRange({ connected, range, onRange }: { connected: boolean; range: DateRange; onRange: (r: DateRange) => void }) {
  if (!connected) return <p className="text-[11px] text-muted">Connect Upstox for more than 60 days of history.</p>;
  const today = istToday();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {QUICK_RANGES.map((q) => {
          const from = istToday(q.shift);
          const active = range.from === from && range.to === today;
          return (
            <button
              key={q.label}
              type="button"
              aria-pressed={active}
              className={`btn px-2 py-0.5 text-[11px] ${active ? "bg-surface-2 text-text" : ""}`}
              onClick={() => onRange({ from, to: today })}
            >
              {q.label}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-muted">
        Live Upstox history — 5-minute data back to 2022. First run of a long range takes about a minute; later runs are instant.
      </p>
    </div>
  );
}

export function BacktestForm({
  strategies,
  symbols,
  onRun,
  running,
}: {
  strategies: StrategyInfo[];
  symbols: SymbolInfo[];
  onRun: (config: BacktestConfig) => void;
  running: boolean;
}) {
  const [symbol, setSymbol] = useState<string>((symbols.find((s) => s.kind === "stock") ?? symbols[0])?.symbol ?? "");
  const [strategyId, setStrategyId] = useState<string>(strategies[0]?.id ?? "");
  const strategy = useMemo(
    () => strategies.find((s) => s.id === strategyId) ?? strategies[0],
    [strategies, strategyId],
  );
  const [params, setParams] = useState<Params>(() => defaultParams(strategy?.params ?? []));
  // Intraday-first: start on 5m whenever the strategy supports it.
  const firstInterval: Interval = strategy?.intervals.includes("5m") ? "5m" : (strategy?.intervals[0] ?? "1d");
  const [interval, setInterval] = useState<Interval>(firstInterval);
  const [range, setRange] = useState(() => defaultRange(firstInterval));
  const upstox = useUpstoxHistory(setRange);
  const [capitalRaw, setCapitalRaw] = useState("100000");
  const [capitalTouched, setCapitalTouched] = useState(false);
  const [riskPct, setRiskPct] = useState(1);
  const [allowShort, setAllowShort] = useState(true);
  const [squareOff, setSquareOff] = useState("15:05");
  const [slippagePct, setSlippagePct] = useState(0.05);
  // Intraday risk controls. Kept as raw strings so a field can be cleared (empty / 0 = off).
  const [entryStart, setEntryStart] = useState("09:30");
  const [entryEnd, setEntryEnd] = useState("14:30");
  const [maxTradesRaw, setMaxTradesRaw] = useState("3");
  const [maxDailyLossRaw, setMaxDailyLossRaw] = useState("2");
  const [leverageRaw, setLeverageRaw] = useState("1");
  const [breakevenRaw, setBreakevenRaw] = useState("0");

  // Note: the page mounts this form only after the catalog has loaded,
  // so the initial state above already reflects real symbols/strategies.

  function changeStrategy(id: string) {
    const s = strategies.find((x) => x.id === id);
    if (!s) return;
    setStrategyId(id);
    setParams(defaultParams(s.params));
    if (!s.intervals.includes(interval)) changeInterval(s.intervals[0]);
  }

  function changeInterval(i: Interval) {
    setInterval(i);
    setRange(defaultRange(i, upstox));
  }

  const capital = parseINR(capitalRaw);
  const capErr = capitalError(capital, capitalRaw);
  const dateErr = range.from >= range.to ? "From must be before To." : undefined;
  const intraday = isIntraday(interval);
  const windowErr =
    intraday && entryStart && entryEnd && entryStart >= entryEnd ? "Start must be before end." : undefined;
  const canRun = !running && !capErr && !dateErr && !windowErr && !!symbol && !!strategy;

  /** Parse an optional numeric control: empty / 0 / invalid → undefined (off), else clamped. */
  function optNum(raw: string, min: number, max: number, integer = false): number | undefined {
    if (raw.trim() === "") return undefined;
    let n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    if (integer) n = Math.round(n);
    n = Math.min(max, Math.max(min, n));
    return n > 0 ? n : undefined;
  }

  /** Only set for 5m/15m; every key is omitted when its control is off, so 1d payloads are unchanged. */
  function riskControls(): Partial<BacktestConfig> {
    if (!intraday) return {};
    const out: Partial<BacktestConfig> = {};
    if (entryStart) out.entryStart = entryStart;
    if (entryEnd) out.entryEnd = entryEnd;
    const maxTrades = optNum(maxTradesRaw, 1, 50, true);
    if (maxTrades !== undefined) out.maxTradesPerDay = maxTrades;
    const lossPct = optNum(maxDailyLossRaw, 0, 50);
    if (lossPct !== undefined) out.maxDailyLoss = lossPct / 100;
    const lev = optNum(leverageRaw, 1, 10);
    if (lev !== undefined && lev !== 1) out.leverage = lev;
    const be = optNum(breakevenRaw, 0, 10);
    if (be !== undefined) out.breakevenAtR = be;
    return out;
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setCapitalTouched(true);
    if (!canRun || !strategy) return;
    const config: BacktestConfig = {
      ...riskControls(),
      symbol,
      interval,
      from: range.from,
      to: range.to,
      strategyId: strategy.id,
      params,
      capital,
      riskPerTrade: riskPct / 100,
      positionFraction: 1,
      squareOffTime: squareOff,
      costs: { ...DEFAULT_COSTS, slippage: slippagePct / 100 },
      allowShort,
    };
    onRun(config);
  }

  return (
    <form onSubmit={submit} className="card flex flex-col gap-3 p-3">
      <Field label="Symbol">
        <SymbolCombobox symbols={symbols} value={symbol} onChange={setSymbol} />
      </Field>

      <Field label="Strategy" hint={strategy?.description}>
        <select className="input" value={strategyId} onChange={(e) => changeStrategy(e.target.value)}>
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Interval">
        <div className="flex gap-1 rounded-md border border-border bg-bg p-0.5">
          {INTERVALS.map((i) => {
            const enabled = strategy?.intervals.includes(i) ?? false;
            const active = i === interval;
            return (
              <label
                key={i}
                className={`flex-1 cursor-pointer rounded px-2 py-1 text-center text-sm transition-colors ${
                  active ? "bg-surface-2 text-text" : "text-muted"
                } ${enabled ? "hover:text-text" : "cursor-not-allowed opacity-40"}`}
              >
                <input
                  type="radio"
                  name="interval"
                  className="sr-only"
                  value={i}
                  disabled={!enabled}
                  checked={active}
                  onChange={() => changeInterval(i)}
                />
                {i}
              </label>
            );
          })}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="From">
          <input
            className="input"
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </Field>
        <Field label="To" error={dateErr}>
          <input
            className="input"
            type="date"
            value={range.to}
            min={range.from}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </Field>
      </div>
      {intraday ? <HistoryRange connected={upstox} range={range} onRange={setRange} /> : null}

      <CapitalInput raw={capitalRaw} onRaw={setCapitalRaw} touched={capitalTouched} onTouched={() => setCapitalTouched(true)} />

      <details className="rounded-md border border-border px-2 py-1.5">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-muted">
          Advanced · strategy settings, risk{intraday ? ", intraday limits" : ""}
        </summary>
        <div className="mt-3 flex flex-col gap-3">
      {strategy ? <ParamFields specs={strategy.params} values={params} onChange={setParams} /> : null}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Risk / trade %">
          <input
            className="input"
            type="number"
            min={0.1}
            max={10}
            step={0.1}
            value={riskPct}
            onChange={(e) => setRiskPct(Number(e.target.value) || 1)}
          />
        </Field>
        <Field label="Slippage %">
          <input
            className="input"
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={slippagePct}
            onChange={(e) => setSlippagePct(Math.max(0, Number(e.target.value) || 0))}
          />
        </Field>
        {isIntraday(interval) ? (
          <Field label="Square-off (IST)">
            <input className="input" type="time" value={squareOff} onChange={(e) => setSquareOff(e.target.value || "15:05")} />
          </Field>
        ) : null}
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={allowShort} onChange={(e) => setAllowShort(e.target.checked)} />
          Allow short
        </label>
      </div>

      {intraday ? (
        <fieldset className="rounded-md border border-border p-2">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            Intraday risk controls
          </legend>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Entry from (IST)" hint="No entries before. Clear = off.">
              <input className="input" type="time" value={entryStart} onChange={(e) => setEntryStart(e.target.value)} />
            </Field>
            <Field label="Entry until (IST)" hint="No entries at/after. Clear = off." error={windowErr}>
              <input className="input" type="time" value={entryEnd} onChange={(e) => setEntryEnd(e.target.value)} />
            </Field>
            <Field label="Max trades / day" hint="0 or empty = unlimited.">
              <input
                className="input"
                type="number"
                min={0}
                max={50}
                step={1}
                value={maxTradesRaw}
                onChange={(e) => setMaxTradesRaw(e.target.value)}
              />
            </Field>
            <Field label="Max daily loss %" hint="Stop entries for the day. 0 = off.">
              <input
                className="input"
                type="number"
                min={0}
                max={50}
                step={0.1}
                value={maxDailyLossRaw}
                onChange={(e) => setMaxDailyLossRaw(e.target.value)}
              />
            </Field>
            <Field label="Leverage ×" hint="MIS up to 5x. 1 = none.">
              <input
                className="input"
                type="number"
                min={1}
                max={10}
                step={0.5}
                value={leverageRaw}
                onChange={(e) => setLeverageRaw(e.target.value)}
              />
            </Field>
            <Field label="Breakeven at R" hint="Stop to entry after +R. 0 = off.">
              <input
                className="input"
                type="number"
                min={0}
                max={10}
                step={0.25}
                value={breakevenRaw}
                onChange={(e) => setBreakevenRaw(e.target.value)}
              />
            </Field>
          </div>
        </fieldset>
      ) : null}
        </div>
      </details>

      {intraday ? (
        <p className="text-[11px] text-muted">
          Intraday limits on: entries {entryStart || "open"}–{entryEnd || "close"}
          {Number(maxTradesRaw) > 0 ? `, max ${maxTradesRaw} trades/day` : ""}
          {Number(maxDailyLossRaw) > 0 ? `, stop after ${maxDailyLossRaw}% day loss` : ""}. Change in Advanced.
        </p>
      ) : null}

      <button type="submit" className="btn btn-primary mt-1 w-full py-2" disabled={!canRun}>
        {running ? <Spinner label="Running backtest…" /> : "Run backtest"}
      </button>
      {windowErr ? (
        <p className="-mt-1 text-center text-[11px] text-red">Entry window in Advanced: start must be before end.</p>
      ) : null}
      {!running && capErr ? (
        <p className="-mt-1 text-center text-[11px] text-muted">Enter capital to enable Run.</p>
      ) : null}
    </form>
  );
}
