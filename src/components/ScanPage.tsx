"use client";

import { useEffect, useRef, useState } from "react";
import type { ScanClosed, ScanInterval, ScanOpen, ScanRecent, ScanRequest, ScanResponse } from "@/lib/scan";
import { isAffordable, sharesAffordable, type InPlay } from "@/lib/scan/inplay";
import {
  NO_RECORD,
  edge,
  isProven,
  judge,
  planTrade,
  type Judgement,
  type StrategyRecord,
  type TradePlan,
  type Verdict,
} from "@/lib/scan/verdict";
import {
  ENTRY_END,
  ENTRY_START,
  MAX_DAILY_LOSS,
  MAX_TRADES_PER_DAY,
  inEntryWindow,
  stoppedOutMinutesAgo,
  type PaperRequest,
  type PaperState,
  type PaperTrade,
} from "@/lib/paper/settle";
import type { StrategyInfo, SymbolInfo } from "@/lib/mock";
import { fmtINR, fmtISTDateTime, fmtNum, parseINR } from "@/lib/format";
import { errorMessage } from "@/components/api";
import { useCatalog } from "@/components/useCatalog";
import { CapitalInput } from "@/components/CapitalInput";
import { Banner, Field, Spinner, capitalError, pnlClass } from "@/components/ui";

const SCAN_INTERVALS: ScanInterval[] = ["5m", "15m"];
const MAX_SYMBOLS = 40;
const REFRESH_MS = 60_000;
// v2: the default strategy set depends on the mode, so strategy sets saved by v1 must not override it.
const STORE_KEY = "scan-settings-v2";
const OLD_STORE_KEY = "scan-settings-v1";
/** How many of the most active stocks to scan. */
const IN_PLAY_TOP = 12;
/** Trend-following strategies: the only ones ticked by default for the most active stocks. */
const MOMENTUM_IDS = ["orb", "vwap-reclaim", "mtf-trend", "supertrend"];
const LEVERAGES = [1, 2, 3, 5];
/** Cards shown up front; the rest sit under "More setups". */
const CARDS_UP_FRONT = 3;
/** Below this much capital, margin is what puts most stocks within reach. */
const SMALL_CAPITAL = 10_000;

interface Saved {
  mode?: "inplay" | "watchlist";
  symbols?: string[];
  strategies?: string[];
  interval?: ScanInterval;
  capitalRaw?: string;
  riskPct?: number;
  leverage?: number;
}

function loadSaved(): Saved {
  const read = (key: string): Saved | null => {
    const raw = window.localStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Saved) : null;
  };
  try {
    const now = read(STORE_KEY);
    if (now) return now;
    // Carry over everything from the old settings except the strategy choice.
    const old = read(OLD_STORE_KEY);
    return old ? { ...old, strategies: undefined } : {};
  } catch {
    return {};
  }
}

function save(s: Saved) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings just don't persist */
  }
}

async function postScan(req: ScanRequest): Promise<ScanResponse> {
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !body) {
    const msg = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body as ScanResponse;
}

/** `amount` = the trading capital; the server needs it to say where the daily limits stand. */
async function paperApi(amount: number | undefined, body?: unknown): Promise<PaperState> {
  const res = await fetch(
    body === undefined && amount ? `/api/paper?amount=${encodeURIComponent(amount)}` : "/api/paper",
    body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const out: unknown = await res.json().catch(() => null);
  if (!res.ok || !out) {
    throw new Error(out && typeof out === "object" && "error" in out && typeof out.error === "string" ? out.error : `Request failed (${res.status})`);
  }
  return out as PaperState;
}

/** "HH:MM" in IST. */
function istTime(ms: number): string {
  return fmtISTDateTime(ms).split(", ").pop() ?? "—";
}

/** "40 s ago", "3 min ago" */
function agoText(sec: number): string {
  return sec < 90 ? `${Math.max(0, Math.round(sec))} s ago` : `${Math.round(sec / 60)} min ago`;
}

/** RELIANCE.NS → RELIANCE, ^NSEI → NSEI */
function shortSymbol(s: string): string {
  return s.replace(/\.(NS|BO)$/, "").replace(/^\^/, "");
}

function rupees(n: number): string {
  return `₹${fmtNum(n)}`;
}

function toggle(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function CheckList({
  items,
  selected,
  onToggle,
  maxHeight,
}: {
  items: { key: string; label: string; sub?: string }[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  maxHeight: number;
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

/** Only capital is up front. Everything else has a working default and lives under "Change…". */
function ScanForm({
  strategies,
  symbols,
  onRun,
  running,
}: {
  strategies: StrategyInfo[];
  symbols: SymbolInfo[];
  onRun: (req: ScanRequest) => void;
  running: boolean;
}) {
  const [saved] = useState(loadSaved);
  const [symSel, setSymSel] = useState<Set<string>>(() => {
    const known = new Set(symbols.map((s) => s.symbol));
    const kept = (saved.symbols ?? []).filter((s) => known.has(s));
    return new Set(kept.length > 0 ? kept : symbols.slice(0, 10).map((s) => s.symbol));
  });
  const [mode, setMode] = useState<"inplay" | "watchlist">(saved.mode === "watchlist" ? "watchlist" : "inplay");
  const [interval, setIntervalState] = useState<ScanInterval>(saved.interval === "15m" ? "15m" : "5m");
  // Until the user ticks a strategy themselves, the ticked set follows the mode.
  const [stratTouched, setStratTouched] = useState(!!saved.strategies?.length);
  function defaultStrategies(m: "inplay" | "watchlist"): Set<string> {
    const all = strategies.filter((s) => s.intervals.includes("5m")).map((s) => s.id);
    const momentum = all.filter((id) => MOMENTUM_IDS.includes(id));
    return new Set(m === "inplay" && momentum.length > 0 ? momentum : all);
  }
  const [stratSel, setStratSel] = useState<Set<string>>(() =>
    saved.strategies?.length ? new Set(saved.strategies) : defaultStrategies(saved.mode === "watchlist" ? "watchlist" : "inplay"),
  );
  const [leverage, setLeverage] = useState(saved.leverage != null && LEVERAGES.includes(saved.leverage) ? saved.leverage : 1);
  const [capitalRaw, setCapitalRaw] = useState(saved.capitalRaw ?? "100000");
  const [capitalTouched, setCapitalTouched] = useState(false);
  const [riskPct, setRiskPct] = useState(saved.riskPct && saved.riskPct > 0 ? saved.riskPct : 1);

  const usable = strategies.filter((s) => s.intervals.includes(interval));
  const chosen = usable.filter((s) => stratSel.has(s.id)).map((s) => s.id);
  const capital = parseINR(capitalRaw);
  const capErr = capitalError(capital, capitalRaw);
  const selErr =
    mode === "inplay"
      ? chosen.length === 0
        ? "Pick at least one strategy."
        : undefined
      : symSel.size === 0
      ? "Pick at least one stock."
      : symSel.size > MAX_SYMBOLS
        ? `At most ${MAX_SYMBOLS} stocks per scan.`
        : chosen.length === 0
          ? "Pick at least one strategy."
          : undefined;
  const valid = !capErr && !selErr;

  function go() {
    if (!valid) return;
    save({ mode, symbols: [...symSel], strategies: stratTouched ? [...stratSel] : undefined, interval, capitalRaw, riskPct, leverage });
    const common = { strategyIds: chosen, interval, capital, riskPerTrade: riskPct / 100, leverage };
    onRun(mode === "inplay" ? { ...common, symbols: [], inPlay: { top: IN_PLAY_TOP, keep: [] } } : { ...common, symbols: [...symSel] });
  }

  // Open the page → see signals. No click needed when the remembered settings are valid.
  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  });
  useEffect(() => {
    goRef.current();
  }, []);

  const indices = symbols.filter((s) => s.kind === "index").map((s) => s.symbol);
  const stocks = symbols.filter((s) => s.kind === "stock").map((s) => s.symbol);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setCapitalTouched(true);
        if (!running) go();
      }}
      className="card flex flex-col gap-3 p-3"
    >
      <CapitalInput raw={capitalRaw} onRaw={setCapitalRaw} touched={capitalTouched} onTouched={() => setCapitalTouched(true)} />

      <Field
        label="Max risk per trade %"
        hint={Number.isFinite(capital) ? `One losing trade costs at most ${fmtINR((capital * riskPct) / 100)}.` : undefined}
      >
        <input className="input" type="number" min={0.1} max={10} step={0.1} value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value) || 1)} />
      </Field>

      <button type="submit" className="btn btn-primary w-full py-2" disabled={running || !valid}>
        {running ? <Spinner label="Checking…" /> : "Check for signals"}
      </button>
      {selErr ? <p className="-mt-1 text-center text-[11px] text-red">{selErr}</p> : null}

      <p className="text-[11px] text-muted">
        {mode === "inplay" ? `Watching today's ${IN_PLAY_TOP} most active stocks you can afford` :`Watching ${symSel.size} stock${symSel.size === 1 ? "" : "s"}`} with {chosen.length} strateg{chosen.length === 1 ? "y" : "ies"} on {interval}{" "}
        bars, risking {riskPct}% per trade{leverage > 1 ? `, ${leverage}× margin` : ""}.
      </p>

      <details className="rounded-md border border-border px-2 py-1.5">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-muted">Change watchlist &amp; settings</summary>
        <div className="mt-3 flex flex-col gap-3">
          <Field
            label="Which stocks"
            hint={
              mode === "inplay"
                ? "Picked fresh every few minutes: stocks your amount can buy, with the biggest move on unusually heavy volume."
                : "Only the stocks you tick below."
            }
          >
            <div className="flex gap-1 rounded-md border border-border bg-bg p-0.5">
              {(["inplay", "watchlist"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`flex-1 rounded px-2 py-1 text-center text-sm ${m === mode ? "bg-surface-2 text-text" : "text-muted hover:text-text"}`}
                  onClick={() => {
                    setMode(m);
                    if (!stratTouched) setStratSel(defaultStrategies(m));
                  }}
                >
                  {m === "inplay" ? "Most active today" : "My watchlist"}
                </button>
              ))}
            </div>
          </Field>

          {mode === "watchlist" ? (
          <Field label={`Watchlist (${symSel.size}/${MAX_SYMBOLS})`}>
            <div className="mb-1 flex flex-wrap gap-1">
              <button type="button" className="btn px-2 py-0.5 text-[11px]" onClick={() => setSymSel(new Set(indices))}>
                Indices
              </button>
              <button type="button" className="btn px-2 py-0.5 text-[11px]" onClick={() => setSymSel(new Set(stocks.slice(0, MAX_SYMBOLS)))}>
                Stocks (first {Math.min(MAX_SYMBOLS, stocks.length)})
              </button>
              <button type="button" className="btn px-2 py-0.5 text-[11px]" onClick={() => setSymSel(new Set())}>
                None
              </button>
            </div>
            <CheckList
              items={symbols.map((s) => ({ key: s.symbol, label: shortSymbol(s.symbol), sub: s.name }))}
              selected={symSel}
              onToggle={(k) => setSymSel((s) => toggle(s, k))}
              maxHeight={220}
            />
          </Field>
          ) : null}

          <Field
            label="Strategies"
            hint={
              mode === "inplay"
                ? "For the most active stocks only the trend-following ones start ticked. The others bet on a reversal or react late, and fight a stock that is running."
                : undefined
            }
          >
            <CheckList
              items={usable.map((s) => ({ key: s.id, label: s.name }))}
              selected={stratSel}
              onToggle={(k) => {
                setStratTouched(true);
                setStratSel((s) => toggle(s, k));
              }}
              maxHeight={150}
            />
          </Field>

          <Field label="Margin" hint="Upstox gives up to 5× for intraday. More margin = bigger position, same stop-loss risk limit.">
            <select className="input" value={leverage} onChange={(e) => setLeverage(Number(e.target.value) || 1)}>
              {LEVERAGES.map((l) => (
                <option key={l} value={l}>
                  {l === 1 ? "1× (no leverage)" : `${l}×`}
                </option>
              ))}
            </select>
          </Field>

          <div>
            <Field label="Bar size">
              <select className="input" value={interval} onChange={(e) => setIntervalState(e.target.value as ScanInterval)}>
                {SCAN_INTERVALS.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      </details>
    </form>
  );
}

interface LiveRow {
  symbol: string;
  strategyName: string;
  lastPrice: number;
  /** % change today, from the scanned bars. NaN if unknown. */
  dayChangePct: number;
  open: ScanOpen;
  /** This strategy on this stock. */
  recent: ScanRecent;
  /** This strategy across all scanned stocks. */
  pooled: StrategyRecord;
  /** Other strategies signalling the same side on this stock right now. */
  alsoBy: string[];
  /** Set when strategies point both ways on this stock: who says what. */
  disagree?: { buy: string[]; sell: string[] };
  /** Today's move and volume, when the scan picked its own stocks. */
  move?: InPlay;
}

/** "+2.4% today · 3.1× usual volume" */
function moveText(m: InPlay): string {
  const pct = `${m.changePct >= 0 ? "+" : "−"}${Math.abs(m.changePct).toFixed(1)}% today`;
  return Number.isFinite(m.relVol) ? `${pct} · ${m.relVol.toFixed(1)}× usual volume` : pct;
}

interface ClosedRow {
  symbol: string;
  strategyName: string;
  trade: ScanClosed;
}

function poolByStrategy(rows: ScanResponse["rows"]): Map<string, StrategyRecord> {
  const out = new Map<string, StrategyRecord>();
  for (const r of rows) {
    for (const s of r.strategies) {
      const p = out.get(s.strategyId) ?? { ...NO_RECORD };
      p.trades += s.recent.trades;
      p.wins += s.recent.trades > 0 ? Math.round(s.recent.winRate * s.recent.trades) : 0;
      p.netPnl += s.recent.netPnl;
      p.sumR += s.recent.sumR ?? 0;
      p.nR += s.recent.nR ?? 0;
      out.set(s.strategyId, p);
    }
  }
  return out;
}

/**
 * One card per stock. When several strategies agree, the card uses the one with the best record
 * and names the others. When they disagree on the side, the card says who says what and is skipped.
 */
function onePerStock(rows: LiveRow[]): LiveRow[] {
  const groups = new Map<string, LiveRow[]>();
  for (const r of rows) groups.set(r.symbol, [...(groups.get(r.symbol) ?? []), r]);
  const out: LiveRow[] = [];
  for (const g of groups.values()) {
    const buy = g.filter((r) => r.open.side === "long");
    const sell = g.filter((r) => r.open.side === "short");
    g.sort(
      (a, b) =>
        Number(b.open.fresh) - Number(a.open.fresh) || Number(isProven(b.pooled)) - Number(isProven(a.pooled)) || edge(b.pooled) - edge(a.pooled),
    );
    if (buy.length > 0 && sell.length > 0) {
      out.push({ ...g[0], alsoBy: [], disagree: { buy: buy.map((r) => r.strategyName), sell: sell.map((r) => r.strategyName) } });
    } else {
      out.push({ ...g[0], alsoBy: g.slice(1).map((r) => r.strategyName) });
    }
  }
  return out;
}

/** What the trader's settings and account allow right now. */
interface Rules {
  capital: number;
  riskPerTrade: number;
  leverage: number;
  interval: ScanInterval;
  /** Money not tied up in open paper trades. */
  free: number;
  /** The clock, and when the scan was made. */
  now: number;
  asOf: number;
  /** The daily limits have stopped trading for today, and why. */
  locked: boolean;
  lockedReason?: string;
  tradesLeft?: number;
  trades: PaperTrade[];
  priceSource: ScanResponse["priceSource"];
  /** The scan picked its own stocks: a signal against the day's move is held back. */
  mostActive: boolean;
}

/** One card: the trade at the price now, and whether to take it. Every rule lives in judge(). */
interface Assessed {
  row: LiveRow;
  plan: TradePlan;
  /** Seconds since the signal, counted up to the clock. */
  ageSec: number;
  judgement: Judgement;
}

function assess(row: LiveRow, rules: Rules): Assessed {
  const o = row.open;
  const plan = planTrade({
    side: o.side,
    fresh: o.fresh,
    signalPrice: o.entryPrice,
    lastPrice: row.lastPrice,
    stop: o.stop,
    target: o.target,
    signalQty: o.qty,
    capital: rules.capital,
    riskPerTrade: rules.riskPerTrade,
    leverage: rules.leverage,
  });
  const ageSec = (Number.isFinite(o.signalAgeSec) ? o.signalAgeSec : 0) + Math.max(0, (rules.now - rules.asOf) / 1000);
  const judgement = judge({
    symbol: row.symbol,
    side: o.side,
    fresh: o.fresh,
    signalAgeSec: ageSec,
    signalPrice: o.entryPrice,
    stop: o.stop,
    target: o.target,
    exitRule: o.exitRule,
    plan,
    changePct: row.move?.changePct ?? row.dayChangePct,
    relVol: row.move?.relVol,
    checkDirection: rules.mostActive,
    strategy: row.pooled,
    stock: { trades: row.recent.trades, wins: row.recent.trades > 0 ? Math.round(row.recent.winRate * row.recent.trades) : 0 },
    disagree: !!row.disagree,
    capital: rules.capital,
    leverage: rules.leverage,
    free: rules.free,
    interval: rules.interval,
    priceSource: rules.priceSource,
    inEntryWindow: inEntryWindow(rules.now),
    locked: rules.locked,
    lockedReason: rules.lockedReason,
    tradesLeft: rules.tradesLeft,
    stoppedOutMinAgo: stoppedOutMinutesAgo(rules.trades, row.symbol, rules.now),
  });
  return { row, plan, ageSec, judgement };
}

const VERDICT_STYLE: Record<Verdict, string> = {
  take: "border-green/40 bg-green/10 text-green",
  wait: "border-amber/40 bg-amber/10 text-amber",
  skip: "border-red/25 bg-red/5 text-red/80",
};
const VERDICT_ORDER: Record<Verdict, number> = { take: 0, wait: 1, skip: 3 };

/** The verdict in one coloured line. */
function VerdictLine({ judgement }: { judgement: Judgement }) {
  return <p className={`rounded border px-2 py-1.5 text-sm font-semibold ${VERDICT_STYLE[judgement.verdict]}`}>{judgement.headline}</p>;
}

/** Why: every check as a tick or a cross. */
function Checklist({ judgement }: { judgement: Judgement }) {
  return (
    <ul className="flex flex-col gap-1 text-[12px] leading-snug">
      {judgement.reasons.map((r, i) => (
        <li key={i} className="flex gap-1.5">
          <span className={`w-3 shrink-0 text-center font-semibold ${r.ok ? "text-green" : "text-red"}`} aria-label={r.ok ? "Passes" : "Fails"}>
            {r.ok ? "✓" : "✕"}
          </span>
          <span className={r.ok ? "text-muted" : "text-text"}>{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** One signal, in the words a trader would use. */
function SignalCard({
  card,
  taken,
  busy,
  onPaper,
}: {
  card: Assessed;
  /** A paper trade in this stock is already open. */
  taken: boolean;
  busy: boolean;
  onPaper: () => void;
}) {
  const { row, plan, judgement } = card;
  const o = row.open;
  const long = o.side === "long";
  // What you actually keep or lose: brokerage and taxes are charged either way.
  const risk = plan.numbers?.risk ?? null;
  const reward = plan.numbers?.reward ?? null;
  const verdict = judgement.verdict;

  // Strategies point both ways: there is no single trade to describe.
  if (row.disagree) {
    return (
      <div className="card flex flex-col gap-2 p-3">
        <VerdictLine judgement={judgement} />
        <p className="text-lg font-semibold">{shortSymbol(row.symbol)}</p>
        <p className="text-[11px] text-muted">
          Buy: {row.disagree.buy.join(", ")}
          <br />
          Sell: {row.disagree.sell.join(", ")}
        </p>
      </div>
    );
  }

  return (
    <div className={`card flex flex-col gap-2 p-3 ${verdict === "take" && !taken ? "border-green/50" : ""}`}>
      {taken ? (
        <p className="rounded border border-border px-2 py-1.5 text-sm font-semibold text-muted">You are in this trade — see Paper trades below</p>
      ) : (
        <VerdictLine judgement={judgement} />
      )}

      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>{o.fresh ? `New signal · ${agoText(card.ageSec)}` : `Signal from ${istTime(o.entryTime)}`}</span>
        <span className="text-right">{row.strategyName}</span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className={`text-lg font-semibold ${long ? "text-green" : "text-red"}`}>{long ? "BUY" : "SELL"}</span>
        <span className="text-lg font-semibold">{shortSymbol(row.symbol)}</span>
      </div>

      <p className="text-sm">
        {row.move ? <span className="mb-1 block text-[11px] text-muted">{moveText(row.move)}</span> : null}
        {fmtNum(plan.qty, 0)} {plan.qty === 1 ? "share" : "shares"} near <span className="font-medium tabular-nums">{rupees(plan.entry)}</span>
        {!o.fresh ? (
          <span className="block text-[11px] text-muted tabular-nums">
            Price now. The signal was at {rupees(o.entryPrice)}, {agoText(card.ageSec)}.
          </span>
        ) : null}
      </p>

      <div className="grid grid-cols-2 gap-2 text-sm tabular-nums">
        <div className="rounded bg-red/10 px-2 py-1">
          <div className="text-[11px] text-muted">Stop loss</div>
          <div className="font-medium">{o.stop == null ? "none" : rupees(o.stop)}</div>
          {risk != null ? <div className="text-[11px] text-red">lose {fmtINR(risk)}</div> : null}
        </div>
        <div className="rounded bg-green/10 px-2 py-1">
          <div className="text-[11px] text-muted">Target</div>
          <div className="font-medium">{o.target == null ? "No fixed target" : rupees(o.target)}</div>
          {o.target == null ? (
            <div className="text-[11px] text-muted">exit when the strategy says so</div>
          ) : reward != null ? (
            <div className={`text-[11px] ${reward > 0 ? "text-green" : "text-red"}`}>{reward > 0 ? `make ${fmtINR(reward)}` : "charges eat the profit"}</div>
          ) : null}
        </div>
      </div>

      {plan.numbers ? <p className="text-[11px] text-muted">After about {fmtINR(plan.numbers.costs)} brokerage and taxes.</p> : null}
      {row.alsoBy.length > 0 ? <p className="text-[11px] text-muted">Also signalled by {row.alsoBy.join(", ")}</p> : null}

      <div className="border-t border-border/60 pt-2">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Why</p>
        <Checklist judgement={judgement} />
        <p className="mt-1 text-[10px] text-muted">Strategy record: the last 3 weeks, across today&apos;s stocks.</p>
      </div>

      {taken ? (
        <p className="rounded border border-border px-2 py-1.5 text-center text-xs text-muted">Paper trade open</p>
      ) : verdict === "skip" ? (
        <p className="rounded border border-border px-2 py-1.5 text-center text-xs text-muted">{judgement.headline}</p>
      ) : (
        <button type="button" className={`btn w-full py-1.5 text-sm ${verdict === "take" ? "btn-primary" : ""}`} disabled={busy} onClick={onPaper}>
          {verdict === "take" ? "Paper trade" : "Paper trade anyway"} · uses {fmtINR(plan.margin)}
        </button>
      )}
    </div>
  );
}

/** "₹12.6", "₹1,340": a price short enough for a chip. */
function shortPrice(n: number): string {
  return `₹${fmtNum(n, n < 100 ? 1 : 0)}`;
}

function signedPct(n: number): string {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
}

/** Outside trading hours: the affordable movers, as a list to come back to. */
function Watchlist({ picks, capital, leverage, marketOpen }: { picks: InPlay[]; capital: number; leverage: number; marketOpen: boolean }) {
  return (
    <div className="card flex flex-col gap-2 p-3">
      <h3 className="text-sm font-semibold">Watchlist for next session</h3>
      <p className="text-xs text-muted">
        {marketOpen ? "No new trades right now" : "Market is closed"} — new trades are taken {ENTRY_START}–{ENTRY_END} on trading days. These are the
        stocks your amount can buy that moved the most in the latest session.
      </p>
      {picks.length === 0 ? (
        <p className="text-xs text-muted">No stock within your reach has prices yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-[11px] text-muted">
                <th className="py-1 pr-3 font-medium">Stock</th>
                <th className="py-1 pr-3 text-right font-medium">Price</th>
                <th className="py-1 pr-3 text-right font-medium">Move</th>
                <th className="py-1 pr-3 text-right font-medium">Volume vs usual</th>
                <th className="py-1 text-right font-medium">You can buy up to</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {picks.map((p) => {
                const n = sharesAffordable(p.price, capital, leverage);
                return (
                  <tr key={p.symbol}>
                    <td className="py-1 pr-3 font-medium">{shortSymbol(p.symbol)}</td>
                    <td className="py-1 pr-3 text-right">{rupees(p.price)}</td>
                    <td className={`py-1 pr-3 text-right ${pnlClass(p.changePct)}`}>{signedPct(p.changePct)}</td>
                    <td className="py-1 pr-3 text-right">{Number.isFinite(p.relVol) ? `${p.relVol.toFixed(1)}×` : "—"}</td>
                    <td className="py-1 text-right text-muted">
                      {fmtNum(n, 0)} {n === 1 ? "share" : "shares"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PaperPanel({
  paper,
  amount,
  ended,
  busy,
  onClose,
  onReset,
}: {
  paper: PaperState;
  amount: number;
  /** Ids of open trades whose strategy has since ended its signal. */
  ended: Set<string>;
  busy: boolean;
  onClose: (t: PaperTrade) => void;
  onReset: () => void;
}) {
  const open = paper.trades.filter((t) => t.status === "open");
  const closed = paper.trades.filter((t) => t.status === "closed").sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0));
  const why: Record<NonNullable<PaperTrade["exitReason"]>, string> = {
    stop: "stop loss hit",
    target: "target hit",
    squareoff: "closed at 15:05",
    manual: "closed by you",
  };
  return (
    <div className="card flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">Paper trades</h3>
        <span className="text-xs text-muted">
          {fmtINR(paper.inUse)} of {fmtINR(amount)} in use · open <span className={pnlClass(paper.openPnl)}>{fmtINR(paper.openPnl)}</span> · closed
          today <span className={pnlClass(paper.closedTodayPnl)}>{fmtINR(paper.closedTodayPnl)}</span>
        </span>
        <span className={`ml-auto text-[11px] ${paper.upstoxConnected ? "text-green" : "text-muted"}`}>
          {paper.upstoxConnected ? "Also sent to Upstox sandbox" : "Paper only — no order is sent anywhere"}
        </span>
      </div>

      {open.length === 0 && closed.length === 0 ? (
        <p className="text-xs text-muted">No paper trades yet. Press “Paper trade” on a signal — no real money is used.</p>
      ) : null}

      {open.length > 0 ? (
        <ul className="divide-y divide-border/50 text-sm tabular-nums">
          {open.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5">
              <span className={`font-semibold ${t.side === "long" ? "text-green" : "text-red"}`}>{t.side === "long" ? "BUY" : "SELL"}</span>
              <span className="font-medium">{shortSymbol(t.symbol)}</span>
              <span className="text-muted">
                {t.qty} at {rupees(t.entryPrice)} · {istTime(t.placedAt)} · stop {rupees(t.stop)}
                {t.target != null ? ` · target ${rupees(t.target)}` : ""}
              </span>
              {ended.has(t.id) ? <span className="text-[11px] text-amber">Signal has ended — consider closing.</span> : null}
              {t.upstox.error ? <span className="text-[11px] text-amber">Upstox: {t.upstox.error}</span> : null}
              {t.upstox.orderId ? <span className="text-[11px] text-muted">Upstox order {t.upstox.orderId}</span> : null}
              <span className={`ml-auto ${pnlClass(t.unrealisedPnl ?? 0)}`}>{fmtINR(t.unrealisedPnl ?? 0)}</span>
              <button type="button" className="btn px-2 py-0.5 text-[11px]" disabled={busy} onClick={() => onClose(t)}>
                Close now
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {closed.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted hover:text-text">Finished paper trades ({closed.length})</summary>
          <ul className="mt-1 divide-y divide-border/50 text-sm tabular-nums">
            {closed.map((t) => (
              <li key={t.id} className="flex flex-wrap items-baseline gap-x-2 py-1">
                <span className={`font-semibold ${t.side === "long" ? "text-green" : "text-red"}`}>{t.side === "long" ? "BUY" : "SELL"}</span>
                <span className="font-medium">{shortSymbol(t.symbol)}</span>
                <span className="text-muted">
                  {t.qty} · {rupees(t.entryPrice)} → {rupees(t.exitPrice ?? NaN)} · {t.exitReason ? why[t.exitReason] : ""}
                </span>
                <span className={`ml-auto ${pnlClass(t.netPnl ?? 0)}`}>{fmtINR(t.netPnl ?? 0)}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="mt-2 text-[11px] text-muted underline hover:text-text" disabled={busy} onClick={onReset}>
            Clear all paper trades
          </button>
        </details>
      ) : null}
    </div>
  );
}

export function ScanPage() {
  const catalog = useCatalog();
  const [request, setRequest] = useState<ScanRequest | null>(null);
  const [response, setResponse] = useState<ScanResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const keepRef = useRef<Set<string>>(new Set());
  /** Stocks with an open paper trade: these stay on screen even if the account can no longer afford them. */
  const heldRef = useRef<Set<string>>(new Set());
  // Result of the Upstox login round-trip (/api/upstox/login → Upstox → /scan?upstox=…).
  const [upstoxNote] = useState<{ tone: "muted" | "red" | "amber"; text: string } | null>(() => {
    if (typeof window === "undefined") return null;
    const r = new URLSearchParams(window.location.search).get("upstox");
    if (r === "connected") return { tone: "muted", text: "Upstox connected. Prices are live until 3:30 AM tomorrow, then connect again." };
    if (r === "failed") return { tone: "red", text: "Upstox login did not complete. Try “Connect Upstox” again." };
    if (r === "setup")
      return {
        tone: "amber",
        text: "Upstox is not set up yet: add UPSTOX_API_KEY and UPSTOX_API_SECRET to .env.local and restart the app.",
      };
    return null;
  });
  const [paper, setPaper] = useState<PaperState | null>(null);
  const [paperBusy, setPaperBusy] = useState(false);
  const [paperError, setPaperError] = useState<string | null>(null);
  // A slow clock, so signal ages and the entry window stay right between scans.
  // Starts at 0 and is set once the page is in the browser: reading the time while the page is
  // being prepared on the server would freeze that moment into it.
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const first = window.setTimeout(() => setClock(Date.now()), 0);
    const id = window.setInterval(() => setClock(Date.now()), 10_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, []);

  async function paperCall(body: Record<string, unknown>) {
    setPaperBusy(true);
    setPaperError(null);
    try {
      setPaper(await paperApi(request?.capital, body));
    } catch (e) {
      setPaperError(errorMessage(e));
    } finally {
      setPaperBusy(false);
    }
  }

  function takePaper(r: LiveRow, plan: TradePlan, req: ScanRequest) {
    const o = r.open;
    const body: PaperRequest = {
      symbol: r.symbol,
      strategyName: r.strategyName,
      side: o.side,
      qty: plan.qty,
      // A signal that fired earlier is entered at the price now, not the price then.
      entryPrice: plan.entry,
      signalPrice: o.entryPrice,
      stop: o.stop,
      target: o.target,
      leverage: req.leverage ?? 1,
      amount: req.capital,
      maxRisk: req.riskPerTrade,
    };
    void paperCall({ ...body });
  }

  async function run(req: ScanRequest) {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setError(null);
    setRequest(req);
    try {
      // A stock with a live signal or an open paper trade stays on screen even if it cools off.
      const sent = req.inPlay
        ? { ...req, inPlay: { ...req.inPlay, keep: [...keepRef.current].slice(0, 40), held: [...heldRef.current].slice(0, 40) } }
        : req;
      const res = await postScan(sent);
      setResponse(res);
      setClock(Date.now());
      const keep = new Set<string>();
      for (const r of res.rows) if (r.strategies.some((s) => s.open)) keep.add(r.symbol);
      keepRef.current = keep;
      // Paper trades follow the same clock: every scan also updates their prices.
      const p = await paperApi(req.capital).catch(() => null);
      setPaper(p);
      // Keep the last known list if the ledger could not be read: a stock you are in must not vanish.
      if (p) heldRef.current = new Set(p.trades.filter((t) => t.status === "open").map((t) => t.symbol));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
      setRunning(false);
    }
  }

  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  // Refreshes by itself every minute while the market is open.
  const marketOpen = response?.marketOpen ?? false;
  useEffect(() => {
    if (!request || !marketOpen) return;
    const id = window.setInterval(() => void runRef.current(request), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [request, marketOpen]);

  const moves = new Map((response?.inPlay?.picks ?? []).map((p) => [p.symbol, p]));
  const pooled = poolByStrategy(response?.rows ?? []);
  const all: LiveRow[] = [];
  const closed: ClosedRow[] = [];
  for (const r of response?.rows ?? []) {
    const move = moves.get(r.symbol);
    for (const s of r.strategies) {
      if (s.open) {
        all.push({
          symbol: r.symbol,
          strategyName: s.strategyName,
          lastPrice: r.lastPrice,
          dayChangePct: r.dayChangePct,
          open: s.open,
          recent: s.recent,
          pooled: pooled.get(s.strategyId) ?? NO_RECORD,
          alsoBy: [],
          move,
        });
      }
      for (const t of s.closedToday) closed.push({ symbol: r.symbol, strategyName: s.strategyName, trade: t });
    }
  }
  closed.sort((a, b) => b.trade.exitTime - a.trade.exitTime);

  const status = paper?.status;
  const openTrades = (paper?.trades ?? []).filter((t) => t.status === "open");
  const rules: Rules | null =
    request && response
      ? {
          capital: request.capital,
          riskPerTrade: request.riskPerTrade,
          leverage: request.leverage ?? 1,
          interval: request.interval,
          free: request.capital - (paper?.inUse ?? 0),
          now: Math.max(clock, response.asOf),
          asOf: response.asOf,
          locked: !!status?.locked,
          lockedReason: status?.reason,
          tradesLeft: status?.tradesLeft,
          trades: paper?.trades ?? [],
          priceSource: response.priceSource,
          mostActive: !!response.inPlay,
        }
      : null;

  // Worth taking first, then worth watching, then trades you are already in, then the ones to skip.
  // Within each: new signals first, then the best reward for the risk.
  const cards = rules
    ? onePerStock(all)
        .map((row) => {
          const card = assess(row, rules);
          const taken = openTrades.some((t) => t.symbol === row.symbol);
          return { card, taken, rank: taken ? 2 : VERDICT_ORDER[card.judgement.verdict] };
        })
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            Number(b.card.row.open.fresh) - Number(a.card.row.open.fresh) ||
            b.card.plan.ratio - a.card.plan.ratio ||
            a.card.row.symbol.localeCompare(b.card.row.symbol),
        )
    : [];
  const takeCount = cards.filter((c) => !c.taken && c.card.judgement.verdict === "take").length;
  const waitCount = cards.filter((c) => !c.taken && c.card.judgement.verdict === "wait").length;
  const upFront = cards.slice(0, CARDS_UP_FRONT);
  const more = cards.slice(CARDS_UP_FRONT);
  const renderCard = (c: (typeof cards)[number]) => (
    <SignalCard
      key={c.card.row.symbol}
      card={c.card}
      taken={c.taken}
      busy={paperBusy || !request}
      onPaper={((row: LiveRow, plan: TradePlan) => () => request && takePaper(row, plan, request))(c.card.row, c.card.plan)}
    />
  );

  // What the account can reach: the chips and the watchlist only show stocks it can actually trade.
  const capitalNow = request?.capital ?? 0;
  const leverageNow = request?.leverage ?? 1;
  const affordablePicks = (response?.inPlay?.picks ?? []).filter((p) => isAffordable(p.price, capitalNow, leverageNow));
  const tradingHours = rules ? inEntryWindow(rules.now) : false;

  // A strategy with no fixed target exits on its own signal. Flag paper trades it has already left.
  const ended = new Set<string>();
  for (const t of openTrades) {
    if (t.target != null) continue;
    const row = response?.rows.find((r) => r.symbol === t.symbol);
    const strat = row && !row.stale ? row.strategies.find((s) => s.strategyName === t.strategyName) : undefined;
    if (strat && strat.open?.side !== t.side) ended.add(t.id);
  }

  const dayStop = (request?.capital ?? 0) * MAX_DAILY_LOSS;
  const noBarsToday = (response?.rows ?? []).length > 0 && (response?.rows ?? []).every((r) => r.stale);
  const closedNet = closed.reduce((s, r) => s + r.trade.netPnl, 0);

  return (
    <div className="grid flex-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="lg:sticky lg:top-[60px] lg:self-start">
        {catalog.loading ? (
          <div className="card flex h-40 items-center justify-center">
            <Spinner label="Loading…" />
          </div>
        ) : (
          <ScanForm strategies={catalog.strategies} symbols={catalog.symbols} onRun={run} running={running} />
        )}
        {catalog.error ? <div className="mt-2"><Banner tone="red">{catalog.error}</Banner></div> : null}
      </aside>

      <section className="flex min-w-0 flex-col gap-4">
        {error ? <Banner tone="red">Could not check signals: {error}</Banner> : null}

        {response ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-base font-semibold">
                {takeCount > 0
                  ? `${takeCount} worth taking now`
                  : waitCount > 0
                    ? `Nothing worth taking right now — ${waitCount} to watch`
                    : "Nothing to trade right now"}
              </h2>
              <span className="text-xs text-muted">
                {response.marketOpen ? "Market open" : "Market closed"} · updated {istTime(response.asOf)} IST
                {response.marketOpen ? " · refreshes every minute" : ""}
              </span>
              {running ? <Spinner /> : null}
              <span className="ml-auto text-xs">
                {response.priceSource === "upstox" ? (
                  <span className="text-green">● Live prices · Upstox</span>
                ) : (
                  <>
                    <span className="text-amber">
                      ● {response.priceSource === "mixed" ? "Some prices delayed" : "Delayed prices (1–15 min)"}
                    </span>
                    {!response.upstox.connected ? (
                      <a className="ml-2 underline hover:text-text" href="/api/upstox/login">
                        Connect Upstox for live prices
                      </a>
                    ) : null}
                  </>
                )}
              </span>
            </div>

            {upstoxNote ? <Banner tone={upstoxNote.tone}>{upstoxNote.text}</Banner> : null}

            {response.inPlay && request ? (
              <div className="text-xs text-muted">
                <p className="text-sm text-text">
                  With {fmtINR(request.capital)}
                  {leverageNow > 1 ? ` and ${leverageNow}× margin` : ""} you can trade stocks up to {fmtINR(response.inPlay.maxPrice)} —{" "}
                  {response.inPlay.affordableCount} of {response.inPlay.poolSize} active stocks.
                </p>
                {leverageNow === 1 && request.capital < SMALL_CAPITAL ? (
                  <p className="mt-0.5 text-amber">Turn on margin in settings to reach more stocks (same loss limit per trade).</p>
                ) : null}
                {response.inPlay.movementRelaxed ? (
                  <p className="mt-0.5">Few of them are moving much today, so quieter ones are included.</p>
                ) : null}
                <p className="mt-0.5">
                  Showing the ones moving the most on unusually heavy volume · ranked {istTime(response.inPlay.rankedAt)}
                  {response.inPlay.pool === "catalogue" ? " · connect Upstox to rank about 200 stocks" : ""}
                </p>
                {tradingHours ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {affordablePicks.map((p) => (
                      <span key={p.symbol} className="rounded border border-border px-1.5 py-0.5 tabular-nums" title={moveText(p)}>
                        <span className="font-medium text-text">{shortSymbol(p.symbol)}</span> {shortPrice(p.price)}{" "}
                        <span className={pnlClass(p.changePct)}>{signedPct(p.changePct)}</span>
                        {Number.isFinite(p.relVol) ? ` · ${p.relVol.toFixed(1)}×` : ""}
                      </span>
                    ))}
                    {affordablePicks.length === 0 ? <span>No stock within your reach has traded today yet.</span> : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {response.inPlay && request && !tradingHours ? (
              <Watchlist picks={affordablePicks} capital={request.capital} leverage={leverageNow} marketOpen={response.marketOpen} />
            ) : !tradingHours ? (
              <Banner tone="muted">
                {response.marketOpen ? "No new trades right now" : "Market is closed"} — new trades are taken {ENTRY_START}–{ENTRY_END} on trading days.
              </Banner>
            ) : null}

            {noBarsToday ? <Banner tone="muted">No prices for today yet (before open, weekend or holiday).</Banner> : null}

            {response.warnings.length > 0 ? (
              <details className="text-xs text-amber">
                <summary className="cursor-pointer">{response.warnings.length} data warning(s)</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {response.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            ) : null}

            {paperError ? <Banner tone="red">Paper trade not taken. {paperError}</Banner> : null}

            {status?.locked ? (
              <Banner tone="red">{status.reason ?? "No more trades today."}</Banner>
            ) : status && request ? (
              <p className="text-xs text-muted tabular-nums">
                Today: {status.tradesToday} of {MAX_TRADES_PER_DAY} trades used · result{" "}
                <span className={pnlClass(status.lossToday)}>{fmtINR(status.lossToday)}</span> · stop for the day at {fmtINR(-dayStop)}
              </p>
            ) : null}

            {upFront.length > 0 ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{upFront.map(renderCard)}</div> : null}

            {more.length > 0 ? (
              <details>
                <summary className="cursor-pointer text-sm text-muted hover:text-text">More setups ({more.length})</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{more.map(renderCard)}</div>
              </details>
            ) : null}

            {paper && request ? (
              <PaperPanel
                paper={paper}
                amount={request.capital}
                ended={ended}
                busy={paperBusy}
                onClose={(t) => void paperCall({ close: t.id, amount: request.capital })}
                onReset={() => void paperCall({ reset: true, amount: request.capital })}
              />
            ) : null}

            {closed.length > 0 ? (
              <details className="card px-3 py-2">
                <summary className="cursor-pointer text-sm">
                  Already finished today: {closed.length} trade{closed.length === 1 ? "" : "s"},{" "}
                  <span className={pnlClass(closedNet)}>{fmtINR(closedNet)}</span> if you had taken all
                </summary>
                <ul className="mt-2 divide-y divide-border/50 text-sm tabular-nums">
                  {closed.map((r, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-2 py-1">
                      <span className={`font-semibold ${r.trade.side === "long" ? "text-green" : "text-red"}`}>
                        {r.trade.side === "long" ? "BUY" : "SELL"}
                      </span>
                      <span className="font-medium">{shortSymbol(r.symbol)}</span>
                      <span className="text-muted">
                        {istTime(r.trade.entryTime)} → {istTime(r.trade.exitTime)} · {r.strategyName} · {r.trade.reason}
                      </span>
                      <span className={`ml-auto ${pnlClass(r.trade.netPnl)}`}>{fmtINR(r.trade.netPnl)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : running ? (
          <div className="card flex h-64 items-center justify-center">
            <Spinner label="Checking your watchlist…" />
          </div>
        ) : !error ? (
          <div className="card flex h-64 items-center justify-center text-sm text-muted">Enter your capital and check for signals.</div>
        ) : null}

        <p className="text-[11px] text-muted">
          {response?.priceSource === "upstox"
            ? "Prices are live from Upstox. Signals appear when a 5 or 15 minute bar closes."
            : "Prices can be 1–15 minutes late, so check the live price before acting."}{" "}
          Not investment advice.
        </p>
      </section>
    </div>
  );
}
