// Order-book imbalance research: the pure maths.
//
// Question being measured: does the imbalance between resting buy and sell orders predict the next
// 5 seconds to 5 minutes of price movement, and is the predicted move big enough to pay for the
// spread and the charges?
//
// This file is the ONE home of the maths. It is imported by the unit test (vitest) and, unchanged,
// by scripts/analyze-depth.mjs (Node runs .ts files directly by stripping the types). To keep that
// working it must stay dependency-free: no imports, no enums, no path aliases.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One price level of the book: [price, quantity, number of orders]. */
export type Level = [number, number, number];

/** One recorded snapshot of one stock (a line of .cache/depth/YYYY-MM-DD.jsonl). */
export interface DepthSample {
  /** Local receive time, epoch ms. */
  t: number;
  /** NSE trading symbol. */
  s: string;
  ltp: number;
  /** Day volume so far. */
  vol: number;
  /** Total buy / sell quantity resting in the whole book. */
  tbq: number;
  tsq: number;
  /** Best five bids, best first. */
  b: Level[];
  /** Best five asks, best first. */
  a: Level[];
  /** Exchange time of the last trade, epoch ms, when the API gave it. */
  ltt?: number;
}

/** A snapshot boiled down to the numbers the maths needs. Only exists for a valid two-sided book. */
export interface Quote {
  t: number;
  bid: number;
  ask: number;
  /** Quantity at the best bid / best ask. */
  bq: number;
  aq: number;
  /** Quantity summed over the (up to five) visible bid / ask levels. */
  b5: number;
  a5: number;
  tbq: number;
  tsq: number;
}

export const MEASURES = ["I1", "I5", "ITot", "OFI"] as const;
export type Measure = (typeof MEASURES)[number];

export const MEASURE_LABEL: Record<Measure, string> = {
  I1: "top-of-book imbalance",
  I5: "5-level imbalance",
  ITot: "whole-book imbalance (total buy vs sell quantity)",
  OFI: "order-flow imbalance (change at the best level since the previous snapshot)",
};

/** Horizons the study looks ahead, in seconds. */
export const HORIZONS_S = [5, 15, 30, 60, 300];

/** Round-trip charges as a fraction of traded value. */
export const COST_SMALL = 0.0027; // Upstox intraday at about Rs 1,000 a trade
export const COST_LARGE = 0.0007; // Upstox intraday at large size

/**
 * |t| a result must reach to be called real. 3, not the usual 2, because the report looks at
 * 4 measures x 5 horizons = 20 combinations and then quotes the best one.
 */
export const T_REQUIRED = 3;

// ---------------------------------------------------------------------------
// Session clock (NSE: 09:15-15:30 IST, Monday-Friday)
// ---------------------------------------------------------------------------

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const SESSION_OPEN_S = 9 * 3600 + 15 * 60;
export const SESSION_CLOSE_S = 15 * 3600 + 30 * 60;
export const SESSION_SECONDS = SESSION_CLOSE_S - SESSION_OPEN_S; // 22,500 s = 6.25 h

/** IST calendar date of an instant, as YYYY-MM-DD. */
export function istDay(t: number): string {
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Seconds since IST midnight. */
export function istSecondOfDay(t: number): number {
  const ms = (((t + IST_OFFSET_MS) % 86_400_000) + 86_400_000) % 86_400_000;
  return ms / 1000;
}

/** True between 09:15:00 and 15:30:00 IST on a weekday. (Exchange holidays are not known here.) */
export function inSession(t: number): boolean {
  const dow = new Date(t + IST_OFFSET_MS).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const s = istSecondOfDay(t);
  return s >= SESSION_OPEN_S && s <= SESSION_CLOSE_S;
}

// ---------------------------------------------------------------------------
// One snapshot
// ---------------------------------------------------------------------------

/** Compact a recorded snapshot. Null when a side is missing or the book is locked / crossed. */
export function toQuote(s: DepthSample): Quote | null {
  let bid = 0;
  let bq = 0;
  let b5 = 0;
  for (const l of s.b ?? []) {
    const [p, q] = l;
    if (!(p > 0) || !(q > 0)) continue;
    b5 += q;
    if (p > bid) {
      bid = p;
      bq = q;
    }
  }
  let ask = Infinity;
  let aq = 0;
  let a5 = 0;
  for (const l of s.a ?? []) {
    const [p, q] = l;
    if (!(p > 0) || !(q > 0)) continue;
    a5 += q;
    if (p < ask) {
      ask = p;
      aq = q;
    }
  }
  if (!(bid > 0) || !Number.isFinite(ask) || !(ask > bid)) return null;
  return { t: s.t, bid, ask, bq, aq, b5, a5, tbq: Number(s.tbq) || 0, tsq: Number(s.tsq) || 0 };
}

export function mid(q: Quote): number {
  return (q.bid + q.ask) / 2;
}

export function spread(q: Quote): number {
  return q.ask - q.bid;
}

/** Size-weighted mid: leans toward the side with LESS resting quantity (the side likely to give way). */
export function microprice(q: Quote): number {
  const d = q.bq + q.aq;
  return d > 0 ? (q.bid * q.aq + q.ask * q.bq) / d : mid(q);
}

/** (buy - sell) / (buy + sell): +1 all buyers, -1 all sellers. NaN when both are zero. */
export function imbalance(buyQty: number, sellQty: number): number {
  const d = buyQty + sellQty;
  return d > 0 ? (buyQty - sellQty) / d : NaN;
}

export function imbalanceTop(q: Quote): number {
  return imbalance(q.bq, q.aq);
}

export function imbalance5(q: Quote): number {
  return imbalance(q.b5, q.a5);
}

export function imbalanceTotal(q: Quote): number {
  return imbalance(q.tbq, q.tsq);
}

/**
 * Order-flow imbalance between two consecutive snapshots at the best level (Cont, Kukanov and
 * Stoikov 2014), in shares:
 *   + bid quantity now      if the bid price did not fall
 *   - bid quantity before   if the bid price did not rise
 *   - ask quantity now      if the ask price did not rise
 *   + ask quantity before   if the ask price did not fall
 * Positive = net buying pressure arrived. The paper sums this over every book event; with snapshots
 * a few seconds apart this is the snapshot approximation (events in between are netted out).
 */
export function ofi(prev: Quote, cur: Quote): number {
  let e = 0;
  if (cur.bid >= prev.bid) e += cur.bq;
  if (cur.bid <= prev.bid) e -= prev.bq;
  if (cur.ask <= prev.ask) e -= cur.aq;
  if (cur.ask >= prev.ask) e += prev.aq;
  return e;
}

/** OFI divided by the best-level quantity involved, so it lies in [-1, 1] and can be pooled across stocks. */
export function ofiNormalized(prev: Quote, cur: Quote): number {
  const d = prev.bq + prev.aq + cur.bq + cur.aq;
  return d > 0 ? ofi(prev, cur) / d : NaN;
}

/**
 * Tick size in rupees inferred from observed prices: the greatest common divisor, in paise, of
 * every price seen. `prevPaise` carries the running value between calls (0 to start).
 */
export function gcdPaise(prices: number[], prevPaise = 0): number {
  let g = prevPaise;
  for (const p of prices) {
    let a = Math.round(p * 100);
    if (!(a > 0)) continue;
    let b = g;
    while (b) [a, b] = [b, a % b];
    g = a;
  }
  return g;
}

// ---------------------------------------------------------------------------
// Time series of one stock
// ---------------------------------------------------------------------------

/** Typical gap between consecutive snapshots, ms (median, so restarts and stalls do not distort it). */
export function medianInterval(ts: number[]): number {
  const d: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i] - ts[i - 1];
    if (dt > 0) d.push(dt);
  }
  return d.length ? median(d) : 0;
}

/**
 * Index of the snapshot to use as "the price `horizonMs` later" for snapshot i, or -1.
 * Picks the later snapshot nearest to t[i] + horizon, and refuses when
 *   - none lies within 0.6 of a sampling interval of that target (with steady sampling the nearest
 *     snapshot is never more than half an interval away; the rest is allowance for timing jitter),
 *   - the stretch from i to it contains a hole (two consecutive snapshots more than 2 x interval apart),
 *   - it falls on another day or outside the 09:15-15:30 session.
 */
export function forwardIndex(ts: number[], i: number, horizonMs: number, intervalMs: number): number {
  const n = ts.length;
  const target = ts[i] + horizonMs;
  let lo = i + 1;
  let hi = n;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (ts[m] < target) lo = m + 1;
    else hi = m;
  }
  // lo = first snapshot at or after the target; lo - 1 = last one before it.
  let j = -1;
  const tol = 0.6 * intervalMs;
  const after = lo < n ? ts[lo] - target : Infinity;
  const before = lo - 1 > i ? target - ts[lo - 1] : Infinity;
  if (after <= before && after <= tol) j = lo;
  else if (before < after && before <= tol) j = lo - 1;
  if (j < 0) return -1;
  if (!inSession(ts[i]) || !inSession(ts[j]) || istDay(ts[i]) !== istDay(ts[j])) return -1;
  for (let k = i + 1; k <= j; k++) if (ts[k] - ts[k - 1] > 2 * intervalMs) return -1;
  return j;
}

/** The four imbalance measures for every snapshot (NaN where undefined). */
export function measureSeries(quotes: Quote[], intervalMs: number): Record<Measure, number[]> {
  const out: Record<Measure, number[]> = { I1: [], I5: [], ITot: [], OFI: [] };
  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i];
    out.I1.push(imbalanceTop(q));
    out.I5.push(imbalance5(q));
    out.ITot.push(imbalanceTotal(q));
    const p = i > 0 ? quotes[i - 1] : null;
    const contiguous = p !== null && q.t - p.t > 0 && q.t - p.t <= 2 * intervalMs && istDay(p.t) === istDay(q.t);
    out.OFI.push(contiguous && p ? ofiNormalized(p, q) : NaN);
  }
  return out;
}

/** Observations for one horizon: one row per snapshot that has a usable later snapshot. Columnar. */
export interface ObsSet {
  horizonS: number;
  /** Stock id (so rows of many stocks can be pooled and still be told apart). */
  sym: number[];
  /** Entry and exit time, epoch ms. */
  t: number[];
  tExit: number[];
  /** Forward mid-to-mid return, as a fraction. */
  fwd: number[];
  /** The same move in units of the half-spread at entry (1 = the move just pays for crossing once). */
  fwdHs: number[];
  /** Buy at the ask now, sell at the bid later: return as a fraction (the spread is paid). */
  longNet: number[];
  /** Sell at the bid now, buy back at the ask later. */
  shortNet: number[];
  x: Record<Measure, number[]>;
}

export function emptyObs(horizonS: number): ObsSet {
  return { horizonS, sym: [], t: [], tExit: [], fwd: [], fwdHs: [], longNet: [], shortNet: [], x: { I1: [], I5: [], ITot: [], OFI: [] } };
}

/** Pair every snapshot of one stock with the snapshot `horizonS` later. `quotes` must be in time order. */
export function buildObs(quotes: Quote[], horizonS: number, intervalMs: number, symId = 0, into: ObsSet = emptyObs(horizonS)): ObsSet {
  const ts = quotes.map((q) => q.t);
  const m = measureSeries(quotes, intervalMs);
  for (let i = 0; i < quotes.length; i++) {
    const j = forwardIndex(ts, i, horizonS * 1000, intervalMs);
    if (j < 0) continue;
    const a = quotes[i];
    const b = quotes[j];
    const m0 = mid(a);
    const m1 = mid(b);
    into.sym.push(symId);
    into.t.push(a.t);
    into.tExit.push(b.t);
    into.fwd.push((m1 - m0) / m0);
    into.fwdHs.push((m1 - m0) / (spread(a) / 2));
    into.longNet.push((b.bid - a.ask) / a.ask);
    into.shortNet.push((a.bid - b.ask) / a.bid);
    for (const k of MEASURES) into.x[k].push(m[k][i]);
  }
  return into;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function mean(v: number[]): number {
  if (v.length === 0) return NaN;
  let s = 0;
  for (const x of v) s += x;
  return s / v.length;
}

export function median(v: number[]): number {
  return quantile(v, 0.5);
}

/** Linear-interpolated quantile (p in 0..1). NaN for an empty list. */
export function quantile(v: number[], p: number): number {
  if (v.length === 0) return NaN;
  const s = Float64Array.from(v).sort();
  const pos = (s.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return NaN;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** Ranks 1..n, ties sharing their average rank. */
export function ranks(v: number[]): number[] {
  const n = v.length;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => v[a] - v[b]);
  const r = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && v[idx[j + 1]] === v[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}

/** Rank correlation: does a higher x go with a higher y, whatever the shape of the relation. */
export function spearman(x: number[], y: number[]): number {
  return pearson(ranks(x), ranks(y));
}

/** t-statistic of a correlation r measured on n independent pairs. */
export function tStatCorr(r: number, n: number): number {
  if (!Number.isFinite(r) || n < 3) return NaN;
  if (Math.abs(r) >= 1) return r > 0 ? Infinity : -Infinity;
  return r * Math.sqrt((n - 2) / (1 - r * r));
}

/** Slope of the least-squares line y = a + slope * x. */
export function olsSlope(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return NaN;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) * (x[i] - mx);
    sxy += (x[i] - mx) * (y[i] - my);
  }
  return sxx > 0 ? sxy / sxx : NaN;
}

export interface MeanT {
  n: number;
  mean: number;
  sd: number;
  /** mean / (sd / sqrt(n)); NaN below two values. */
  t: number;
}

/** Mean and its t-statistic against zero, after subtracting a fixed `cost` from every value. */
export function meanT(v: number[], cost = 0): MeanT {
  const n = v.length;
  if (n === 0) return { n, mean: NaN, sd: NaN, t: NaN };
  const m = mean(v) - cost;
  if (n < 2) return { n, mean: m, sd: NaN, t: NaN };
  let ss = 0;
  const raw = m + cost;
  for (const x of v) ss += (x - raw) * (x - raw);
  const sd = Math.sqrt(ss / (n - 1));
  const se = sd / Math.sqrt(n);
  const t = se > 0 ? m / se : m === 0 ? 0 : m > 0 ? Infinity : -Infinity;
  return { n, mean: m, sd, t };
}

/**
 * From candidate rows (indices into the obs arrays, each stock's rows in time order), keep only rows
 * whose holding period does not overlap the previously kept row of the same stock. This is how the
 * report gets honest t-statistics: snapshots 3 seconds apart looking 60 seconds ahead share 95% of
 * their future, so counting them all as independent would fake significance.
 */
export function nonOverlapping(sym: number[], t: number[], tExit: number[], candidates: number[]): number[] {
  const freeAt = new Map<number, number>();
  const keep: number[] = [];
  for (const i of candidates) {
    const free = freeAt.get(sym[i]);
    if (free !== undefined && t[i] < free) continue;
    keep.push(i);
    freeAt.set(sym[i], tExit[i]);
  }
  return keep;
}

/** Share of rows where the imbalance pointed the way the price then moved. Flat moves and zero imbalance are left out. */
export function hitRate(x: number[], fwd: number[]): { n: number; hit: number; flatShare: number } {
  let n = 0;
  let ok = 0;
  let flat = 0;
  let total = 0;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(fwd[i])) continue;
    total++;
    if (fwd[i] === 0) {
      flat++;
      continue;
    }
    if (x[i] === 0) continue;
    n++;
    if (x[i] > 0 === fwd[i] > 0) ok++;
  }
  return { n, hit: n > 0 ? ok / n : NaN, flatShare: total > 0 ? flat / total : NaN };
}

export interface DecileRow {
  /** 1 = most sell-heavy tenth, 10 = most buy-heavy tenth. */
  decile: number;
  n: number;
  /** Mean imbalance in the bucket. */
  x: number;
  /** Mean forward move in basis points (1 bp = 0.01%). */
  bps: number;
  /** Mean forward move in half-spreads. */
  halfSpreads: number;
}

/** Sort rows by imbalance, cut into `bins` equal-count buckets, average the forward move in each. */
export function decileTable(x: number[], fwd: number[], fwdHs: number[], bins = 10): DecileRow[] {
  const idx: number[] = [];
  for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i]) && Number.isFinite(fwd[i])) idx.push(i);
  idx.sort((a, b) => x[a] - x[b]);
  const n = idx.length;
  const rows: DecileRow[] = [];
  for (let d = 0; d < bins; d++) {
    const from = Math.floor((d * n) / bins);
    const to = Math.floor(((d + 1) * n) / bins);
    let sx = 0;
    let sf = 0;
    let sh = 0;
    for (let k = from; k < to; k++) {
      sx += x[idx[k]];
      sf += fwd[idx[k]];
      sh += fwdHs[idx[k]];
    }
    const c = to - from;
    rows.push({ decile: d + 1, n: c, x: c ? sx / c : NaN, bps: c ? (sf / c) * 1e4 : NaN, halfSpreads: c ? sh / c : NaN });
  }
  return rows;
}

export interface Cell {
  /** Rows with a usable later price. */
  n: number;
  pearson: number;
  spearman: number;
  /** Rows left after removing overlapping holding periods, the rank correlation on those, and its t. */
  nIndependent: number;
  spearmanIndependent: number;
  t: number;
  /** Direction hit rate over rows where the price moved, and how many such rows. */
  hit: number;
  hitN: number;
  /** Share of rows where the mid price did not move at all. */
  flatShare: number;
}

/** One measure x one horizon: how well does the imbalance line up with what the price did next. */
export function correlationCell(obs: ObsSet, m: Measure): Cell {
  const xs = obs.x[m];
  const idx: number[] = [];
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i])) idx.push(i);
  const x = idx.map((i) => xs[i]);
  const y = idx.map((i) => obs.fwd[i]);
  const ind = nonOverlapping(obs.sym, obs.t, obs.tExit, idx);
  const rInd = spearman(
    ind.map((i) => xs[i]),
    ind.map((i) => obs.fwd[i]),
  );
  const h = hitRate(x, y);
  return {
    n: idx.length,
    pearson: pearson(x, y),
    spearman: spearman(x, y),
    nIndependent: ind.length,
    spearmanIndependent: rInd,
    t: tStatCorr(rInd, ind.length),
    hit: h.hit,
    hitN: h.n,
    flatShare: h.flatShare,
  };
}

export interface TradableResult {
  /** Imbalance at or above `hi` (and positive) = buy; at or below `lo` (and negative) = sell short. */
  hi: number;
  lo: number;
  /** Non-overlapping trades taken. */
  n: number;
  nLong: number;
  nShort: number;
  /** What those trades made mid-to-mid, in the traded direction: the edge before any cost. */
  gross: MeanT;
  /** After paying the spread (in at the far side, out at the far side). */
  net: MeanT;
  /** After the spread and round-trip charges at small size (0.27%) and at large size (0.07%). */
  netSmall: MeanT;
  netLarge: MeanT;
}

/**
 * The "could you actually trade it" test. When the imbalance is in its top tenth, buy at the ASK and
 * sell at the BID `horizon` later; when in its bottom tenth, sell at the BID and buy back at the ASK.
 * One position per stock at a time, so the trades do not overlap and the t-statistics are honest.
 * The top/bottom-tenth thresholds are taken from the same data (in-sample), which flatters the
 * result slightly; a rule that fails here fails for certain.
 */
export function tradableTest(obs: ObsSet, m: Measure, tail = 0.1): TradableResult {
  const xs = obs.x[m];
  const valid: number[] = [];
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i])) valid.push(xs[i]);
  const hi = quantile(valid, 1 - tail);
  const lo = quantile(valid, tail);
  const side = (i: number): 1 | -1 | 0 => (xs[i] >= hi && xs[i] > 0 ? 1 : xs[i] <= lo && xs[i] < 0 ? -1 : 0);
  const cand: number[] = [];
  if (valid.length > 0 && hi > lo) for (let i = 0; i < xs.length; i++) if (side(i) !== 0) cand.push(i);
  const taken = nonOverlapping(obs.sym, obs.t, obs.tExit, cand);
  const gross: number[] = [];
  const net: number[] = [];
  let nLong = 0;
  for (const i of taken) {
    const s = side(i);
    if (s > 0) nLong++;
    gross.push(s * obs.fwd[i]);
    net.push(s > 0 ? obs.longNet[i] : obs.shortNet[i]);
  }
  return {
    hi,
    lo,
    n: taken.length,
    nLong,
    nShort: taken.length - nLong,
    gross: meanT(gross),
    net: meanT(net),
    netSmall: meanT(net, COST_SMALL),
    netLarge: meanT(net, COST_LARGE),
  };
}

// ---------------------------------------------------------------------------
// The whole study
// ---------------------------------------------------------------------------

export interface SymbolStats {
  symbol: string;
  /** Valid two-sided snapshots inside the session. */
  samples: number;
  /** Hours actually covered (gaps excluded). */
  hours: number;
  /** Holes longer than 2 x the sampling interval within a day. */
  gaps: number;
  tick: number;
  medianSpread: number;
  medianSpreadTicks: number;
  medianSpreadBps: number;
  /** Per measure, one cell per horizon. */
  cells: Record<Measure, Cell[]>;
}

export interface DayCoverage {
  day: string;
  /** Hours covered by the best-covered stock that day. */
  hours: number;
  full: boolean;
  samples: number;
}

export interface Verdict {
  horizonS: number;
  predicts: boolean;
  paysSpread: boolean;
  paysSmall: boolean;
  paysLarge: boolean;
  cell: Cell;
  trade: TradableResult;
}

export interface Analysis {
  intervalMs: number;
  horizons: number[];
  symbols: SymbolStats[];
  days: DayCoverage[];
  fullSessions: number;
  /** False below two full sessions: nothing can be concluded yet. */
  enoughData: boolean;
  totalSamples: number;
  pooled: Record<Measure, Cell[]>;
  trades: Record<Measure, TradableResult[]>;
  /** Measure with the largest average |rank correlation| across horizons (pooled). */
  best: Measure;
  /** Decile table of the best measure, one per horizon. */
  deciles: DecileRow[][];
  verdicts: Verdict[];
}

/** A session counts as full when at least 90% of its 6.25 hours were recorded. */
export const FULL_SESSION_HOURS = (SESSION_SECONDS / 3600) * 0.9;
export const MIN_FULL_SESSIONS = 2;

export function analyze(
  bySymbol: Map<string, Quote[]>,
  opts: { horizons?: number[]; intervalMs?: number; ticks?: Record<string, number> } = {},
): Analysis {
  const horizons = opts.horizons ?? HORIZONS_S;
  const names = [...bySymbol.keys()].sort();
  const series = names.map((s) => (bySymbol.get(s) ?? []).filter((q) => inSession(q.t)).sort((a, b) => a.t - b.t));

  const perSymbolInterval = series.map((q) => medianInterval(q.map((r) => r.t))).filter((v) => v > 0);
  const intervalMs = opts.intervalMs ?? (perSymbolInterval.length ? median(perSymbolInterval) : 3000);

  const pooledObs = horizons.map((h) => emptyObs(h));
  const symbols: SymbolStats[] = [];
  const dayHours = new Map<string, { hours: number; samples: number }>();

  names.forEach((symbol, id) => {
    const q = series[id];
    let coveredMs = 0;
    let gaps = 0;
    const perDayMs = new Map<string, number>();
    for (let i = 0; i < q.length; i++) {
      const day = istDay(q[i].t);
      const d = dayHours.get(day) ?? { hours: 0, samples: 0 };
      d.samples++;
      dayHours.set(day, d);
      if (i === 0 || istDay(q[i - 1].t) !== day) {
        // every snapshot stands for one interval of the session, including the first of a day
        perDayMs.set(day, (perDayMs.get(day) ?? 0) + intervalMs);
        continue;
      }
      const dt = q[i].t - q[i - 1].t;
      if (dt > 2 * intervalMs) {
        gaps++;
        perDayMs.set(day, (perDayMs.get(day) ?? 0) + intervalMs);
      } else perDayMs.set(day, (perDayMs.get(day) ?? 0) + dt);
    }
    for (const [day, ms] of perDayMs) {
      coveredMs += ms;
      const d = dayHours.get(day);
      if (d) d.hours = Math.max(d.hours, ms / 3_600_000);
    }
    const spreads = q.map(spread);
    const tick = opts.ticks?.[symbol] ?? 0;
    const medSpread = median(spreads);
    const cells: Record<Measure, Cell[]> = { I1: [], I5: [], ITot: [], OFI: [] };
    horizons.forEach((h, hi) => {
      const obs = buildObs(q, h, intervalMs, id);
      for (const m of MEASURES) cells[m].push(correlationCell(obs, m));
      appendObs(pooledObs[hi], obs);
    });
    symbols.push({
      symbol,
      samples: q.length,
      hours: coveredMs / 3_600_000,
      gaps,
      tick,
      medianSpread: medSpread,
      medianSpreadTicks: tick > 0 ? medSpread / tick : NaN,
      medianSpreadBps: median(q.map((r) => (spread(r) / mid(r)) * 1e4)),
      cells,
    });
  });

  const days: DayCoverage[] = [...dayHours.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, d]) => ({ day, hours: d.hours, samples: d.samples, full: d.hours >= FULL_SESSION_HOURS }));
  const fullSessions = days.filter((d) => d.full).length;

  const pooled: Record<Measure, Cell[]> = { I1: [], I5: [], ITot: [], OFI: [] };
  const trades: Record<Measure, TradableResult[]> = { I1: [], I5: [], ITot: [], OFI: [] };
  for (const m of MEASURES) {
    for (const obs of pooledObs) {
      pooled[m].push(correlationCell(obs, m));
      trades[m].push(tradableTest(obs, m));
    }
  }

  let best: Measure = "I1";
  let bestScore = -1;
  for (const m of MEASURES) {
    const v = pooled[m].map((c) => Math.abs(c.spearman)).filter((r) => Number.isFinite(r));
    const score = v.length ? mean(v) : -1;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }

  const deciles = pooledObs.map((obs) => decileTable(obs.x[best], obs.fwd, obs.fwdHs));
  const verdicts: Verdict[] = horizons.map((h, i) => {
    const cell = pooled[best][i];
    const trade = trades[best][i];
    const pays = (r: MeanT) => r.mean > 0 && r.t >= T_REQUIRED;
    return {
      horizonS: h,
      predicts: cell.spearman > 0 && cell.t >= T_REQUIRED && cell.hit > 0.5,
      paysSpread: pays(trade.net),
      paysSmall: pays(trade.netSmall),
      paysLarge: pays(trade.netLarge),
      cell,
      trade,
    };
  });

  return {
    intervalMs,
    horizons,
    symbols,
    days,
    fullSessions,
    enoughData: fullSessions >= MIN_FULL_SESSIONS,
    totalSamples: symbols.reduce((a, s) => a + s.samples, 0),
    pooled,
    trades,
    best,
    deciles,
    verdicts,
  };
}

function appendObs(into: ObsSet, from: ObsSet): void {
  const cols: (keyof Omit<ObsSet, "horizonS" | "x">)[] = ["sym", "t", "tExit", "fwd", "fwdHs", "longNet", "shortNet"];
  for (const c of cols) for (const v of from[c]) into[c].push(v);
  for (const m of MEASURES) for (const v of from.x[m]) into.x[m].push(v);
}

// ---------------------------------------------------------------------------
// Synthetic data with a KNOWN answer (for the self-test and the unit tests)
// ---------------------------------------------------------------------------

/** Small deterministic random generator (mulberry32) so a seed always gives the same day. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticOptions {
  symbol?: string;
  seed?: number;
  /** Number of full sessions; the first is `startDay`, weekends are skipped. */
  days?: number;
  /** A weekday, YYYY-MM-DD. */
  startDay?: string;
  intervalS?: number;
  price?: number;
  tick?: number;
  /** Chance of the price ticking up (and, separately, down) per step when the book is balanced. */
  p0?: number;
  /**
   * Predictive strength. Each step the price ticks up with probability p0 + k*I and down with
   * p0 - k*I, where I is the top-of-book imbalance just shown. So the expected move over the next
   * step is exactly 2*k*I ticks. k = 0 means the imbalance tells you nothing.
   */
  k?: number;
  /** Persistence of the imbalance from one step to the next (0..1) and the size of its random shocks. */
  phi?: number;
  shock?: number;
}

/**
 * A made-up stock whose book is always one tick wide and whose top-of-book imbalance predicts the
 * next move by a known amount. The deeper levels and the whole-book totals are pure noise.
 */
export function syntheticSamples(o: SyntheticOptions = {}): DepthSample[] {
  const { symbol = "SYNTH", seed = 1, days = 1, startDay = "2026-01-05", intervalS = 3, price = 300, tick = 0.05, p0 = 0.1, k = 0, phi = 0.9, shock = 0.15 } = o;
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const out: DepthSample[] = [];
  const steps = Math.floor(SESSION_SECONDS / intervalS);
  let dayStart = Date.parse(`${startDay}T00:00:00+05:30`);
  let bidTicks = Math.round(price / tick);
  let made = 0;
  while (made < days) {
    const dow = new Date(dayStart + IST_OFFSET_MS).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      let x = 0;
      let vol = 0;
      for (let n = 0; n < steps; n++) {
        const t = dayStart + (SESSION_OPEN_S + n * intervalS) * 1000 + Math.round((rand() - 0.5) * 200);
        const bq = Math.max(1, Math.min(9999, Math.round((10_000 * (1 + x)) / 2)));
        const aq = 10_000 - bq;
        const bid = bidTicks * tick;
        const b: Level[] = [[r2(bid), bq, 10]];
        const a: Level[] = [[r2(bid + tick), aq, 10]];
        for (let l = 1; l < 5; l++) {
          b.push([r2(bid - l * tick), 1000 + Math.floor(rand() * 9000), 10]);
          a.push([r2(bid + tick + l * tick), 1000 + Math.floor(rand() * 9000), 10]);
        }
        vol += Math.floor(rand() * 500);
        out.push({ t, s: symbol, ltp: r2(bid), vol, tbq: 200_000 + Math.floor(rand() * 200_000), tsq: 200_000 + Math.floor(rand() * 200_000), b, a, ltt: t });
        const u = rand();
        const i1 = (bq - aq) / 10_000;
        if (u < p0 + k * i1) bidTicks++;
        else if (u > 1 - (p0 - k * i1)) bidTicks--;
        x = Math.max(-0.98, Math.min(0.98, phi * x + shock * gauss()));
      }
      made++;
    }
    dayStart += 86_400_000;
  }
  return out;
}
