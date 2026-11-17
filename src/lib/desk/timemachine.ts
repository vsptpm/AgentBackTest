// Agent 4 — "Time machine": simulated price paths plus a replay of earlier real sessions.
// Pure, deterministic for a given seed, and browser-safe (no data-layer imports).

import { computeTradeCosts } from "@/lib/backtest/costs";
import { DEFAULT_COSTS, IST_OFFSET_MS, type Candle } from "@/lib/types";
import type { SimResult, TradePlan } from "./types";

const DAY_MS = 86_400_000;
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;
/** Intraday positions are force-closed at 15:05 IST. */
const EXIT_MIN = 15 * 60 + 5;
const BAR_MIN = 5;
const FULL_SESSION_BARS = (EXIT_MIN - SESSION_OPEN_MIN) / BAR_MIN; // 70
const BLOCK = 6;
const STOP_SLIP = 0.001;
const SESSION_SLIP = 0.0005;
const RUIN_DAYS = 500;
const RUIN_TRADES = 3;
const BUCKETS = 12;

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const istDay = (t: number) => Math.floor((t + IST_OFFSET_MS) / DAY_MS);
const istMinute = (t: number) => Math.floor((((t + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);
const round2 = (x: number) => Math.round(x * 100) / 100;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

interface PoolBar {
  /** Log return of the bar's close versus where the bar started. */
  ret: number;
  /** Log excursion of the high (>= 0) and the low (<= 0) from the bar's start. */
  up: number;
  down: number;
}

export function simulate(
  plan: TradePlan,
  candles: Candle[],
  now: number,
  opts?: { paths?: number; seed?: number; dailyLossLimit?: number },
): SimResult {
  const paths = Math.max(1, Math.floor(opts?.paths ?? 2000));
  const rand = mulberry32(opts?.seed ?? 1);
  const dir = plan.side === "long" ? 1 : -1;
  const { entry, stop, qty } = plan;
  const target = plan.targets[0];
  const risk = Math.abs(entry - stop);

  const pnlAt = (exit: number, from = entry, size = qty): number =>
    dir * (exit - from) * size -
    computeTradeCosts({ side: plan.side, entryPrice: from, exitPrice: exit, qty: size, model: DEFAULT_COSTS, intraday: true });
  /** `frac` worse than `price` for this plan's side. */
  const worse = (price: number, frac: number) => price * (1 - dir * frac);

  // --- Completed past sessions only: before today and before the latest day in the data. ---
  const nowDay = istDay(now);
  const lastDay = candles.length ? istDay(candles[candles.length - 1].time) : nowDay;
  const cutoff = Math.min(nowDay, lastDay);
  const sessions = new Map<number, Candle[]>();
  for (const c of candles) {
    const day = istDay(c.time);
    const minute = istMinute(c.time);
    if (day >= cutoff || minute < SESSION_OPEN_MIN || minute >= SESSION_CLOSE_MIN) continue;
    if (!(c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)) continue;
    const list = sessions.get(day);
    if (list) list.push(c);
    else sessions.set(day, [c]);
  }

  const pool: PoolBar[] = [];
  for (const bars of sessions.values()) {
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      // The first bar of a session is measured from its own open so overnight gaps stay out of the pool.
      const ret = Math.log(b.close / (i === 0 ? b.open : bars[i - 1].close));
      pool.push({
        ret,
        up: Math.max(Math.log(b.high / b.open), ret, 0),
        down: Math.min(Math.log(b.low / b.open), ret, 0),
      });
    }
  }

  // --- Monte Carlo ---
  const nowMin = istMinute(now);
  const inSession = nowMin >= SESSION_OPEN_MIN && nowMin < EXIT_MIN;
  const barsLeft = inSession ? Math.max(1, Math.ceil((EXIT_MIN - nowMin) / BAR_MIN)) : FULL_SESSION_BARS;
  const targetPnl = pnlAt(target);
  const stopPnl = pnlAt(worse(stop, STOP_SLIP));

  const results: number[] = new Array(paths);
  let hitTarget = 0;
  let hitStop = 0;
  for (let p = 0; p < paths; p++) {
    let price = entry;
    let outcome: number | null = null;
    let start = 0;
    for (let k = 0; k < barsLeft && outcome === null && pool.length > 0; k++) {
      if (k % BLOCK === 0) start = Math.floor(rand() * pool.length);
      const bar = pool[(start + (k % BLOCK)) % pool.length];
      const high = price * Math.exp(bar.up);
      const low = price * Math.exp(bar.down);
      // Both inside one bar: assume the stop went first.
      if (dir === 1 ? low <= stop : high >= stop) {
        outcome = stopPnl;
        hitStop++;
      } else if (dir === 1 ? high >= target : low <= target) {
        outcome = targetPnl;
        hitTarget++;
      } else {
        price *= Math.exp(bar.ret);
      }
    }
    results[p] = outcome ?? pnlAt(worse(price, SESSION_SLIP));
  }

  const sorted = [...results].sort((a, b) => a - b);
  const worst = sorted[0];
  const best = sorted[sorted.length - 1];
  const width = (best - worst) / BUCKETS;
  const histogram = Array.from({ length: BUCKETS }, (_, i) => ({
    from: round2(worst + width * i),
    to: round2(worst + width * (i + 1)),
    count: 0,
  }));
  for (const x of results) {
    histogram[width > 0 ? Math.min(BUCKETS - 1, Math.floor((x - worst) / width)) : 0].count++;
  }
  const p50 = percentile(sorted, 0.5);

  // --- Risk of ruin: days of three consecutive trades drawn from the simulated results. ---
  const limit = opts?.dailyLossLimit ?? 2 * plan.maxLoss;
  let ruined = 0;
  if (limit > 0) {
    for (let d = 0; d < RUIN_DAYS; d++) {
      let total = 0;
      let hit = false;
      for (let t = 0; t < RUIN_TRADES; t++) {
        total += results[Math.floor(rand() * paths)];
        if (total <= -limit) hit = true;
      }
      if (hit) ruined++;
    }
  }

  // --- Deterministic scenarios ---
  const scenarios: SimResult["scenarios"] = [
    { name: "Moves your way immediately", pnl: targetPnl, note: "Price goes straight to the first target and the trade is closed there." },
    { name: "Moves against you immediately", pnl: stopPnl, note: "Price goes straight to the stop; this is the planned loss plus slippage and charges." },
    { name: "Goes sideways until the close", pnl: pnlAt(entry), note: "Nothing happens and you exit where you entered, so you pay only the charges." },
    { name: "False breakout", pnl: stopPnl, note: "Price covers 60% of the way to the target, then reverses all the way to the stop." },
    { name: "Sudden volatility spike", pnl: pnlAt(stop - dir * 0.5 * risk), note: "Price jumps through the stop and fills a further half of your risk beyond it." },
    { name: "Opening-gap style jump against you", pnl: pnlAt(entry - dir * 1.5 * risk), note: "Price jumps past the stop and you get out 1.5 times your risk away from entry." },
  ];
  if (plan.targets[1] !== undefined) {
    scenarios.push({ name: "Reaches target 2", pnl: pnlAt(plan.targets[1]), note: "The move extends and the whole position is closed at the second target." });
  }
  scenarios.push({
    name: "Late exit at the close, half-way to target",
    pnl: pnlAt(worse((entry + target) / 2, SESSION_SLIP)),
    note: "Price gets half-way to the target and you are closed out at 15:05.",
  });
  for (const s of scenarios) s.pnl = round2(s.pnl);

  // --- Replay the same entry time and percentage distances on earlier real sessions ---
  const replayMin = inSession ? nowMin : SESSION_OPEN_MIN;
  const stopRatio = stop / entry;
  const targetRatio = target / entry;
  let wins = 0;
  let losses = 0;
  let flat = 0;
  let replayTotal = 0;
  for (const bars of sessions.values()) {
    let at = -1;
    for (let i = 0; i < bars.length; i++) {
      if (istMinute(bars[i].time) <= replayMin) at = i;
      else break;
    }
    if (at < 0) continue;
    const from = bars[at].close;
    const s = from * stopRatio;
    const t = from * targetRatio;
    let last = from;
    let pnl: number | null = null;
    for (let i = at + 1; i < bars.length && istMinute(bars[i].time) < EXIT_MIN; i++) {
      const b = bars[i];
      if (dir === 1 ? b.low <= s : b.high >= s) {
        pnl = pnlAt(worse(s, STOP_SLIP), from);
        losses++;
        break;
      }
      if (dir === 1 ? b.high >= t : b.low <= t) {
        pnl = pnlAt(t, from);
        wins++;
        break;
      }
      last = b.close;
    }
    if (pnl === null) {
      pnl = pnlAt(worse(last, SESSION_SLIP), from);
      flat++;
    }
    replayTotal += pnl;
  }
  const replayed = wins + losses + flat;

  return {
    paths,
    pTarget: hitTarget / paths,
    pStop: hitStop / paths,
    pNeither: (paths - hitTarget - hitStop) / paths,
    expectedValue: round2(results.reduce((a, b) => a + b, 0) / paths),
    medianPnl: round2(p50),
    best: round2(best),
    worst: round2(worst),
    percentiles: {
      p5: round2(percentile(sorted, 0.05)),
      p25: round2(percentile(sorted, 0.25)),
      p50: round2(p50),
      p75: round2(percentile(sorted, 0.75)),
      p95: round2(percentile(sorted, 0.95)),
    },
    histogram,
    riskOfRuin: ruined / RUIN_DAYS,
    scenarios,
    replay: {
      sessions: replayed,
      wins,
      losses,
      flat,
      winRate: replayed ? wins / replayed : 0,
      avgPnl: replayed ? round2(replayTotal / replayed) : 0,
    },
  };
}
