"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DeskCandidate, DeskRequest, DeskResponse, DeskStep, NewsItem, RiskVerdict, SimResult, TradePlan } from "@/lib/desk/types";
import type { PaperRequest, PaperState } from "@/lib/paper/settle";
import { fmtINR, fmtISTDateTime, fmtNum, parseINR } from "@/lib/format";
import { errorMessage } from "@/components/api";
import { CapitalInput } from "@/components/CapitalInput";
import { Banner, Field, Spinner, capitalError, pnlClass } from "@/components/ui";

const STORE_KEY = "desk-settings-v1";
const LEVERAGES = [1, 2, 3, 5];
const TOPS = [3, 5, 8];

const AGENTS: { agent: DeskStep["agent"]; does: string }[] = [
  { agent: "Market scanner", does: "Finds today's most active stocks that your money can buy." },
  { agent: "Technical analyst", does: "Reads each stock's chart and says if it is going up, down or nowhere." },
  { agent: "News analyst", does: "Looks for fresh news and company filings on each stock." },
  { agent: "Trade strategist", does: "Writes a full plan: where to get in, where to get out, how many shares." },
  { agent: "Time machine", does: "Replays the plan on the stock's own past moves to see what usually happens." },
  { agent: "Risk manager", does: "Checks the plan against your loss limits and rejects anything over them." },
];

interface Saved {
  capitalRaw?: string;
  riskPct?: number;
  dailyPct?: number;
  leverage?: number;
  top?: number;
}

function loadSaved(): Saved {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Saved) : {};
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

async function readJson<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !body) {
    const msg = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body as T;
}

async function postDesk(req: DeskRequest): Promise<DeskResponse> {
  return readJson<DeskResponse>(
    await fetch("/api/desk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) }),
  );
}

async function paperApi(amount: number | undefined, body?: unknown): Promise<PaperState> {
  return readJson<PaperState>(
    await fetch(
      body === undefined && amount ? `/api/paper?amount=${encodeURIComponent(amount)}` : "/api/paper",
      body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    ),
  );
}

/** The clock, read only from event handlers and effects. */
function stamp(): number {
  return Date.now();
}

/** "HH:MM" in IST. */
function istTime(ms: number): string {
  return fmtISTDateTime(ms).split(", ").pop() ?? "—";
}

/** "30 Oct 2026" in IST. */
function istDay(ms: number): string {
  return fmtISTDateTime(ms).split(", ")[0] ?? "";
}

function shortSymbol(s: string): string {
  return s.replace(/\.(NS|BO)$/, "").replace(/^\^/, "");
}

function rupees(n: number): string {
  return `₹${fmtNum(n)}`;
}

function signedPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
}

/** Share 0–1 → "42%". */
function share(n: number): string {
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "—";
}

function timeAgo(then: number | null, now: number): string {
  if (then == null || !Number.isFinite(then)) return "time unknown";
  const min = Math.max(0, Math.round((now - then) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function Ticks({ items }: { items: { ok: boolean; text: string }[] }) {
  if (items.length === 0) return <p className="text-xs text-muted">Nothing to show.</p>;
  return (
    <ul className="flex flex-col gap-1 text-[12px] leading-snug">
      {items.map((r, i) => (
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

function Section({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="rounded-md border border-border px-2 py-1.5">
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-text">{title}</summary>
      <div className="mt-2 flex flex-col gap-2">{children}</div>
    </details>
  );
}

function Cell({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: string; sub?: ReactNode }) {
  return (
    <div className={`rounded px-2 py-1 ${tone ?? "bg-surface-2"}`}>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
      {sub ? <div className="text-[11px] text-muted tabular-nums">{sub}</div> : null}
    </div>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="text-[12px] leading-snug">
      <span className="text-muted">{label}: </span>
      {children}
    </p>
  );
}

function DeskForm({ saved, onRun, running }: { saved: Saved; onRun: (req: DeskRequest) => void; running: boolean }) {
  const [capitalRaw, setCapitalRaw] = useState(saved.capitalRaw ?? "1000");
  const [capitalTouched, setCapitalTouched] = useState(false);
  const [riskPct, setRiskPct] = useState(saved.riskPct && saved.riskPct > 0 ? saved.riskPct : 1);
  const [dailyPct, setDailyPct] = useState(saved.dailyPct && saved.dailyPct > 0 ? saved.dailyPct : 2);
  const [leverage, setLeverage] = useState(saved.leverage != null && LEVERAGES.includes(saved.leverage) ? saved.leverage : 5);
  const [top, setTop] = useState(saved.top != null && TOPS.includes(saved.top) ? saved.top : 5);

  const capital = parseINR(capitalRaw);
  const valid = !capitalError(capital, capitalRaw) && riskPct > 0 && dailyPct > 0;

  function go() {
    if (!valid) return;
    save({ capitalRaw, riskPct, dailyPct, leverage, top });
    onRun({ capital, riskPerTrade: riskPct / 100, maxDailyLoss: dailyPct / 100, leverage, top });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setCapitalTouched(true);
        if (!running) go();
      }}
      className="card flex flex-col gap-3 p-3"
    >
      <p className="text-sm font-semibold">How much are you trading with today?</p>
      <CapitalInput raw={capitalRaw} onRaw={setCapitalRaw} touched={capitalTouched} onTouched={() => setCapitalTouched(true)} />

      <Field
        label="Most you will lose on one trade (%)"
        hint={Number.isFinite(capital) ? `One losing trade costs at most ${fmtINR((capital * riskPct) / 100)}.` : undefined}
      >
        <input className="input" type="number" min={0.1} max={10} step={0.1} value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value) || 1)} />
      </Field>

      <Field
        label="Stop for the day after losing (%)"
        hint={Number.isFinite(capital) ? `You stop for the day after losing ${fmtINR((capital * dailyPct) / 100)}.` : undefined}
      >
        <input className="input" type="number" min={0.1} max={20} step={0.1} value={dailyPct} onChange={(e) => setDailyPct(Number(e.target.value) || 2)} />
      </Field>

      <Field label="Margin" hint="Money the broker lends you for the day. More margin = more shares, same loss limit.">
        <select className="input" value={leverage} onChange={(e) => setLeverage(Number(e.target.value) || 1)}>
          {LEVERAGES.map((l) => (
            <option key={l} value={l}>
              {l}×
            </option>
          ))}
        </select>
      </Field>

      <Field label="Stocks to analyse" hint="More stocks take longer.">
        <select className="input" value={top} onChange={(e) => setTop(Number(e.target.value) || 5)}>
          {TOPS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>

      <button type="submit" className="btn btn-primary w-full py-2" disabled={running || !valid}>
        {running ? <Spinner label="Working…" /> : "Run the desk"}
      </button>
      <p className="text-[11px] text-muted">A run takes about half a minute.</p>
    </form>
  );
}

const STEP_ICON: Record<DeskStep["status"], { mark: string; cls: string; label: string }> = {
  ok: { mark: "✓", cls: "text-green", label: "Done" },
  warn: { mark: "!", cls: "text-amber", label: "Done with a warning" },
  fail: { mark: "✕", cls: "text-red", label: "Failed" },
};

function AgentList({ running, steps }: { running: boolean; steps: DeskStep[] }) {
  return (
    <ul className="card flex flex-col divide-y divide-border/50 px-3 py-1 text-sm">
      {AGENTS.map((a) => {
        const step = running ? undefined : steps.find((s) => s.agent === a.agent);
        const icon = step ? STEP_ICON[step.status] : null;
        return (
          <li key={a.agent} className="flex items-baseline gap-2 py-1.5">
            <span className="flex w-4 shrink-0 justify-center">
              {running ? (
                <span className="spinner" />
              ) : icon ? (
                <span className={`font-semibold ${icon.cls}`} aria-label={icon.label}>
                  {icon.mark}
                </span>
              ) : (
                <span className="text-muted">·</span>
              )}
            </span>
            <span className="shrink-0 font-medium">{a.agent}</span>
            <span className="min-w-0 text-xs text-muted">{step ? step.detail : running ? a.does : "Did not run."}</span>
            {step ? <span className="ml-auto shrink-0 text-[11px] text-muted tabular-nums">{(step.ms / 1000).toFixed(1)} s</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function PlanSection({ plan }: { plan: TradePlan | null }) {
  if (!plan) return <p className="text-xs text-muted">No plan — chart is not giving a clear direction</p>;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Cell label="Entry" value={rupees(plan.entry)} sub={`zone ${rupees(plan.entryZone[0])} – ${rupees(plan.entryZone[1])}`} />
        <Cell label="Stop loss" value={rupees(plan.stop)} tone="bg-red/10" />
        {[0, 1, 2].map((i) => (
          <Cell key={i} label={`Target ${i + 1}`} value={plan.targets[i] != null ? rupees(plan.targets[i]) : "—"} tone="bg-green/10" />
        ))}
        <Cell label="Shares" value={fmtNum(plan.qty, 0)} />
        <Cell label="Money needed" value={fmtINR(plan.capitalRequired)} />
        <Cell label="Most you can lose" value={<span className="text-red">{fmtINR(plan.maxLoss)}</span>} />
        <Cell label="Reward for each ₹1 risked" value={Number.isFinite(plan.rewardToRisk) ? `₹${plan.rewardToRisk.toFixed(1)}` : "—"} />
        <Cell label="Charges" value={fmtINR(plan.costs)} sub="brokerage and taxes" />
      </div>
      <Line label="Enter when">{plan.trigger}</Line>
      <Line label="Idea is wrong if">{plan.invalidation}</Line>
      <Line label="Exit by">{plan.timeExit}</Line>
      <Line label="Holding time">{plan.holding}</Line>
    </>
  );
}

function ChartSection({ c }: { c: DeskCandidate }) {
  const i = c.technical.indicators;
  const cells: [string, string][] = [
    ["Day's average price", rupees(i.vwap)],
    ["RSI", fmtNum(i.rsi, 0)],
    ["EMA 9", rupees(i.ema9)],
    ["EMA 20", rupees(i.ema20)],
    ["EMA 50", rupees(i.ema50)],
    ["EMA 200", rupees(i.ema200)],
    ["Yesterday's high", rupees(i.prevDayHigh)],
    ["Yesterday's low", rupees(i.prevDayLow)],
    ["Opening range", `${rupees(i.orLow)} – ${rupees(i.orHigh)}`],
    ["ATR %", Number.isFinite(i.atrPct) ? `${i.atrPct.toFixed(2)}%` : "—"],
  ];
  return (
    <>
      <Ticks items={c.technical.reasons} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {cells.map(([label, value]) => (
          <Cell key={label} label={label} value={value} />
        ))}
      </div>
    </>
  );
}

function Histogram({ bins }: { bins: SimResult["histogram"] }) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  if (bins.length === 0) return null;
  return (
    <div>
      <div className="flex h-20 items-end gap-px" role="img" aria-label="How often each result happened">
        {bins.map((b, i) => (
          <div
            key={i}
            className={`min-w-0 flex-1 rounded-t-sm ${(b.from + b.to) / 2 < 0 ? "bg-red/70" : "bg-green/70"}`}
            style={{ height: `${Math.max(2, (b.count / max) * 100)}%` }}
            title={`${fmtINR(b.from)} to ${fmtINR(b.to)}: ${b.count} times`}
          />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-muted tabular-nums">
        <span>{fmtINR(bins[0].from)}</span>
        <span>result per trade</span>
        <span>{fmtINR(bins[bins.length - 1].to)}</span>
      </div>
    </div>
  );
}

function SimSection({ sim }: { sim: SimResult | null }) {
  const caption = <p className="text-[11px] text-muted">Simulated from this stock&apos;s own past 5-minute moves. These are estimates, not promises.</p>;
  if (!sim) {
    return (
      <>
        <p className="text-xs text-muted">Nothing to replay — there is no plan for this stock.</p>
        {caption}
      </>
    );
  }
  return (
    <>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded bg-green/10 px-2 py-1.5">
          <div className="text-xl font-semibold text-green tabular-nums">{share(sim.pTarget)}</div>
          <div className="text-[11px] text-muted">Hits target</div>
        </div>
        <div className="rounded bg-red/10 px-2 py-1.5">
          <div className="text-xl font-semibold text-red tabular-nums">{share(sim.pStop)}</div>
          <div className="text-[11px] text-muted">Hits stop</div>
        </div>
        <div className="rounded bg-surface-2 px-2 py-1.5">
          <div className="text-xl font-semibold tabular-nums">{share(sim.pNeither)}</div>
          <div className="text-[11px] text-muted">Neither</div>
        </div>
      </div>
      <p className="text-[12px] leading-relaxed tabular-nums">
        Average result per trade <span className={pnlClass(sim.expectedValue)}>{fmtINR(sim.expectedValue)}</span> · Typical (median){" "}
        <span className={pnlClass(sim.medianPnl)}>{fmtINR(sim.medianPnl)}</span> · Best / worst <span className={pnlClass(sim.best)}>{fmtINR(sim.best)}</span> /{" "}
        <span className={pnlClass(sim.worst)}>{fmtINR(sim.worst)}</span>
      </p>
      <Histogram bins={sim.histogram} />
      {sim.scenarios.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[11px] text-muted">
                <th className="py-1 pr-3 font-medium">What if</th>
                <th className="py-1 pr-3 text-right font-medium">Result</th>
                <th className="py-1 font-medium">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {sim.scenarios.map((s, i) => (
                <tr key={i}>
                  <td className="py-1 pr-3">{s.name}</td>
                  <td className={`py-1 pr-3 text-right tabular-nums ${pnlClass(s.pnl)}`}>{fmtINR(s.pnl)}</td>
                  <td className="py-1 text-muted">{s.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="text-[12px] tabular-nums">
        Same entry on the last {sim.replay.sessions} sessions: won {sim.replay.wins}, lost {sim.replay.losses}, flat {sim.replay.flat} — average{" "}
        <span className={pnlClass(sim.replay.avgPnl)}>{fmtINR(sim.replay.avgPnl)}</span>
      </p>
      <p className="text-[12px] tabular-nums">Chance of hitting your daily stop with three trades like this: {share(sim.riskOfRuin)}</p>
      {caption}
    </>
  );
}

const CHIP = "rounded border px-1.5 py-0.5 text-[10px] font-medium";
const SENTIMENT: Record<NewsItem["sentiment"], { text: string; cls: string }> = {
  positive: { text: "Good news", cls: "border-green/40 bg-green/10 text-green" },
  negative: { text: "Bad news", cls: "border-red/40 bg-red/10 text-red" },
  neutral: { text: "Neutral", cls: "border-border text-muted" },
};
const VERIFIED: Record<NewsItem["verified"], { text: string; cls: string }> = {
  official: { text: "Official filing", cls: "border-green/40 bg-green/10 text-green" },
  "news-report": { text: "News report", cls: "border-border text-muted" },
  unverified: { text: "Unverified", cls: "border-amber/40 bg-amber/10 text-amber" },
};

function NewsSection({ news, now }: { news: NewsItem[]; now: number }) {
  if (news.length === 0) return <p className="text-xs text-muted">No recent news found</p>;
  return (
    <ul className="flex flex-col divide-y divide-border/50">
      {news.map((n, i) => (
        <li key={i} className="flex flex-col gap-1 py-1.5 first:pt-0">
          <a className="text-[13px] leading-snug underline decoration-border hover:text-text" href={n.url} target="_blank" rel="noopener">
            {n.headline}
          </a>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <span>
              {n.source} · {timeAgo(n.publishedAt, now)}
            </span>
            <span className={`${CHIP} ${SENTIMENT[n.sentiment].cls}`}>{SENTIMENT[n.sentiment].text}</span>
            <span className={`${CHIP} border-border`}>{n.impact} impact</span>
            <span className={`${CHIP} ${VERIFIED[n.verified].cls}`}>{VERIFIED[n.verified].text}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function RiskSection({ risk }: { risk: RiskVerdict }) {
  return (
    <>
      <Ticks items={risk.checks} />
      {risk.approved ? (
        <p className="rounded border border-green/40 bg-green/10 px-2 py-1.5 text-sm font-semibold text-green">Passed every risk check</p>
      ) : (
        <p className="rounded border border-red/40 bg-red/10 px-2 py-1.5 text-sm font-semibold text-red">
          Rejected{risk.reason ? ` — ${risk.reason}` : ""}
        </p>
      )}
    </>
  );
}

const DECISION_STYLE: Record<DeskCandidate["decision"], string> = {
  "BUY CANDIDATE": "border-green/40 bg-green/10 text-green",
  "SELL CANDIDATE": "border-red/40 bg-red/10 text-red",
  "NO TRADE": "border-border bg-surface-2 text-muted",
};

function CandidateCard({
  c,
  now,
  placed,
  error,
  busy,
  onPaper,
}: {
  c: DeskCandidate;
  now: number;
  placed: boolean;
  error?: string;
  busy: boolean;
  onPaper: () => void;
}) {
  const tradable = c.decision !== "NO TRADE";
  return (
    <div className={`card flex min-w-0 flex-col gap-2 p-3 ${c.decision === "BUY CANDIDATE" ? "border-green/50" : c.decision === "SELL CANDIDATE" ? "border-red/40" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded border px-2 py-1 text-sm font-bold tracking-wide ${DECISION_STYLE[c.decision]}`}>{c.decision}</span>
        <span className="text-lg font-semibold">{shortSymbol(c.symbol)}</span>
        <span className="ml-auto text-lg font-medium tabular-nums">{rupees(c.technical.price)}</span>
      </div>
      <p className="text-[11px] text-muted tabular-nums">
        <span className={pnlClass(c.changePct)}>{signedPct(c.changePct)} today</span>
        {Number.isFinite(c.relVol) ? ` · ${c.relVol.toFixed(1)}× usual volume` : ""}
      </p>
      <p className="text-sm leading-snug">{c.summary}</p>

      <Section title="The plan" open>
        <PlanSection plan={c.plan} />
      </Section>
      <Section title="What the chart says">
        <ChartSection c={c} />
      </Section>
      <Section title="Time machine — what usually happens">
        <SimSection sim={c.sim} />
      </Section>
      <Section title="News">
        <NewsSection news={c.news} now={now} />
      </Section>
      <Section title="Risk manager">
        <RiskSection risk={c.risk} />
      </Section>

      {error ? <Banner tone="red">{error}</Banner> : null}
      {placed ? (
        <p className="rounded border border-green/40 bg-green/10 px-2 py-1.5 text-center text-sm font-semibold text-green">Paper trade placed</p>
      ) : tradable && c.risk.approved && c.plan ? (
        <button type="button" className="btn btn-primary w-full py-1.5 text-sm" disabled={busy} onClick={onPaper}>
          Paper trade · uses {fmtINR(c.plan.capitalRequired)}
        </button>
      ) : null}
    </div>
  );
}

function TodayBox({ paper, at, amount, loading, onRefresh }: { paper: PaperState | null; at: number; amount: number; loading: boolean; onRefresh: () => void }) {
  const today = istDay(at);
  const closedToday = (paper?.trades ?? []).filter((t) => t.status === "closed" && t.exitTime != null && istDay(t.exitTime) === today);
  const wins = closedToday.filter((t) => (t.netPnl ?? 0) > 0).length;
  const losses = closedToday.filter((t) => (t.netPnl ?? 0) < 0).length;
  const s = paper?.status;
  return (
    <div className="card flex flex-col gap-2 p-3">
      <div className="flex items-baseline gap-3">
        <h3 className="text-sm font-semibold">Today so far</h3>
        {loading ? <Spinner /> : null}
        <button type="button" className="ml-auto text-[11px] text-muted underline hover:text-text" disabled={loading} onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {paper && s ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Cell label="Trades taken" value={s.tradesToday} />
            <Cell label="Wins" value={<span className={wins > 0 ? "text-green" : ""}>{wins}</span>} />
            <Cell label="Losses" value={<span className={losses > 0 ? "text-red" : ""}>{losses}</span>} />
            <Cell label="Net result" value={<span className={pnlClass(paper.closedTodayPnl)}>{fmtINR(paper.closedTodayPnl)}</span>} sub="charges are included" />
            <Cell label="Open result" value={<span className={pnlClass(paper.openPnl)}>{fmtINR(paper.openPnl)}</span>} sub="trades still running" />
            <Cell label="Money in use" value={fmtINR(paper.inUse)} sub={amount > 0 ? `of ${fmtINR(amount)}` : undefined} />
          </div>
          {s.locked ? (
            <Banner tone="red">{s.reason ?? "No more trades today."}</Banner>
          ) : (
            <p className="text-xs text-muted">
              {s.tradesLeft} {s.tradesLeft === 1 ? "trade" : "trades"} left today.
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-muted">{loading ? "Loading…" : "No paper trades to show yet."}</p>
      )}
    </div>
  );
}

export function DeskPage() {
  // Read in the browser only, after the first paint, so the server-made page and the browser agree.
  const [saved, setSaved] = useState<Saved | null>(null);
  const [response, setResponse] = useState<DeskResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const [paper, setPaper] = useState<PaperState | null>(null);
  const [paperAt, setPaperAt] = useState(0);
  const [paperLoading, setPaperLoading] = useState(false);
  const [paperBusy, setPaperBusy] = useState(false);
  const [placed, setPlaced] = useState<Set<string>>(new Set());
  const [paperErrors, setPaperErrors] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState(0);

  async function refreshPaper(amt: number) {
    setPaperLoading(true);
    try {
      const p = await paperApi(amt > 0 ? amt : undefined);
      setPaper(p);
      setPaperAt(stamp());
    } catch {
      /* the box keeps what it had */
    } finally {
      setPaperLoading(false);
    }
  }

  const refreshRef = useRef(refreshPaper);
  useEffect(() => {
    refreshRef.current = refreshPaper;
  });

  useEffect(() => {
    const id = window.setTimeout(() => {
      const s = loadSaved();
      const amount = parseINR(s.capitalRaw ?? "1000");
      const amt = Number.isFinite(amount) ? amount : 0;
      setAmount(amt);
      setSaved(s);
      void refreshRef.current(amt);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  async function run(req: DeskRequest) {
    if (busy.current) return;
    busy.current = true;
    setAmount(req.capital);
    setRunning(true);
    setError(null);
    setPlaced(new Set());
    setPaperErrors({});
    try {
      setResponse(await postDesk(req));
      await refreshPaper(req.capital);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
      setRunning(false);
    }
  }

  async function takePaper(c: DeskCandidate, res: DeskResponse) {
    const plan = c.plan;
    if (!plan) return;
    const body: PaperRequest = {
      symbol: c.symbol,
      strategyName: "Trading desk",
      side: plan.side,
      qty: plan.qty,
      entryPrice: plan.entry,
      signalPrice: plan.entry,
      stop: plan.stop,
      target: plan.targets[0],
      leverage: res.account.leverage,
      amount: res.account.capital,
      maxRisk: res.account.riskPerTrade,
    };
    setPaperBusy(true);
    setPaperErrors((m) => {
      const next = { ...m };
      delete next[c.symbol];
      return next;
    });
    try {
      setPaper(await paperApi(res.account.capital, { ...body }));
      setPaperAt(stamp());
      setPlaced((s) => new Set(s).add(c.symbol));
    } catch (e) {
      const msg = errorMessage(e);
      setPaperErrors((m) => ({ ...m, [c.symbol]: `Paper trade not taken. ${msg}` }));
    } finally {
      setPaperBusy(false);
    }
  }

  const candidates = response
    ? [...response.candidates].sort((a, b) => Number(a.decision === "NO TRADE") - Number(b.decision === "NO TRADE"))
    : [];
  const consider = candidates.filter((c) => c.decision !== "NO TRADE").length;
  const rejected = candidates.length - consider;

  return (
    <div className="grid flex-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="lg:sticky lg:top-[60px] lg:self-start">
        {saved ? (
          <DeskForm saved={saved} onRun={run} running={running} />
        ) : (
          <div className="card flex h-40 items-center justify-center">
            <Spinner label="Loading…" />
          </div>
        )}
      </aside>

      <section className="flex min-w-0 flex-col gap-4">
        {error ? <Banner tone="red">The desk could not finish: {error}</Banner> : null}

        {running ? (
          <>
            <p className="text-sm text-muted">The six agents are working. This takes about half a minute.</p>
            <AgentList running steps={[]} />
          </>
        ) : response ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-base font-semibold">
                {consider} to consider · {rejected} rejected
              </h2>
              <span className="text-xs text-muted">
                {response.marketOpen ? "Market open" : "Market closed"} · updated {istTime(response.asOf)} IST
              </span>
              <span className="ml-auto text-xs">
                {response.priceSource === "upstox" ? (
                  <span className="text-green">● Live prices · Upstox</span>
                ) : (
                  <span className="text-amber">● Delayed prices</span>
                )}
              </span>
            </div>

            <p className="text-sm">
              With {fmtINR(response.account.capital)} and {response.account.leverage}× margin you can trade stocks up to{" "}
              {fmtINR(response.universe.maxPrice)} — {response.universe.affordableCount} of {response.universe.poolSize} active stocks.
            </p>

            <AgentList running={false} steps={response.steps} />

            {response.warnings.length > 0 ? (
              <details className="text-xs text-amber">
                <summary className="cursor-pointer">{response.warnings.length} warning(s)</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {response.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            ) : null}

            {candidates.length === 0 ? <Banner tone="muted">No stocks to show. Try again later or with more margin.</Banner> : null}

            <div className="grid gap-3 xl:grid-cols-2">
              {candidates.map((c) => (
                <CandidateCard
                  key={c.symbol}
                  c={c}
                  now={response.asOf}
                  placed={placed.has(c.symbol)}
                  error={paperErrors[c.symbol]}
                  busy={paperBusy}
                  onPaper={() => void takePaper(c, response)}
                />
              ))}
            </div>
          </>
        ) : !error ? (
          <div className="card flex flex-col gap-3 p-4">
            <h2 className="text-base font-semibold">Six agents check each stock before you risk any money</h2>
            <p className="text-sm text-muted">Tell the desk how much you are trading with, then press “Run the desk”.</p>
            <ol className="flex flex-col gap-2 text-sm">
              {AGENTS.map((a, i) => (
                <li key={a.agent} className="flex gap-2">
                  <span className="w-4 shrink-0 text-muted tabular-nums">{i + 1}</span>
                  <span>
                    <span className="font-medium">{a.agent}.</span> <span className="text-muted">{a.does}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        <TodayBox paper={paper} at={paperAt} amount={amount} loading={paperLoading} onRefresh={() => void refreshPaper(amount)} />

        <p className="text-[11px] text-muted">Paper trading and analysis only. Nothing here places a real order. Not investment advice.</p>
      </section>
    </div>
  );
}
