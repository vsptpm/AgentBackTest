import type { Candle, Params, Signal, Strategy } from "@/lib/types";
import { atr } from "@/lib/indicators";
import { istDay, istMinutes, num, SESSION_OPEN_MIN, str } from "./helpers";

/** Inputs of the TradingView script, same names and defaults. */
export interface SwingFadeConfig {
  kMult: number;
  atrLen: number;
  lbMin: number;
  rhoMin: number;
  rhoMax: number;
  minExt: number;
  shrinkK: number;
  zConf: number;
  warmN: number;
  useSweep: boolean;
  sweepBack: number;
  pivLen: number;
  tierA: number;
  tierB: number;
  tierC: number;
  mergeTol: number;
  decayF: number;
  maxCl: number;
  useDay: boolean;
  dayProx: number;
  adrLen: number;
  stopBuf: number;
  rrTarget: number;
  useMagTg: boolean;
  maxBars: number;
  allowL: boolean;
  allowS: boolean;
}

export const SWING_FADE_DEFAULTS: SwingFadeConfig = {
  kMult: 2.5,
  atrLen: 14,
  lbMin: 0.6,
  rhoMin: 0.35,
  rhoMax: 0.8,
  minExt: 2,
  shrinkK: 10,
  zConf: 1.28,
  warmN: 20,
  useSweep: true,
  sweepBack: 12,
  pivLen: 8,
  tierA: 1,
  tierB: 2,
  tierC: 4,
  mergeTol: 0.35,
  decayF: 0.995,
  maxCl: 24,
  useDay: true,
  dayProx: 0.5,
  adrLen: 14,
  stopBuf: 0.25,
  rrTarget: 1.5,
  useMagTg: true,
  maxBars: 40,
  allowL: true,
  allowS: true,
};

/** Volume z-score window (fixed at 50 in the script). */
const VOL_LEN = 50;

/** Pine `f_wilson`: Wilson score lower bound of a proportion p seen on n trials. 0 when n is 0. */
export function wilsonLower(p: number, n: number, z: number): number {
  if (!(n > 0)) return 0;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt(Math.max((p * (1 - p)) / n + z2 / (4 * n * n), 0))) / (1 + z2 / n);
}

/**
 * Pine `f_cell`. d = 0 for an up leg, 1 for a down leg; rho = retrace as a fraction of k; r = leg size / k.
 * The 0.2 bucket uses the same float division as Pine, so 0.6 lands in bucket 2 (0.6 / 0.2 = 2.9999...).
 */
export function cellIndex(d: number, rho: number, r: number): { cell: number; marginal: number } {
  const ri = Math.min(Math.trunc(Math.max(Math.min(rho, 1), 0) / 0.2), 4);
  const xi = r < 1.5 ? 0 : r < 2.5 ? 1 : r < 4 ? 2 : 3;
  return { cell: d * 20 + ri * 4 + xi, marginal: d * 5 + ri };
}

/** A resting-liquidity level. side -1 = above price (from a pivot high), 1 = below (from a pivot low). */
export interface Cluster {
  price: number;
  mass: number;
  side: -1 | 1;
}

/**
 * Target price. Default rr x risk from the close; with `useMag`, the nearest opposite-side cluster
 * that is between 1R and 4R away replaces it (below the close for a short, above for a long).
 */
export function pickTarget(
  isShort: boolean,
  close: number,
  risk: number,
  rr: number,
  clusters: Cluster[],
  useMag: boolean,
): { target: number; fromCluster: boolean } {
  let best = NaN;
  if (useMag) {
    for (const c of clusters) {
      if (isShort && c.side === 1) {
        const dist = close - c.price;
        if (dist >= risk && dist <= 4 * risk && (Number.isNaN(best) || c.price > best)) best = c.price;
      }
      if (!isShort && c.side === -1) {
        const dist = c.price - close;
        if (dist >= risk && dist <= 4 * risk && (Number.isNaN(best) || c.price < best)) best = c.price;
      }
    }
  }
  if (!Number.isNaN(best)) return { target: best, fromCluster: true };
  return { target: isShort ? close - rr * risk : close + rr * risk, fromCluster: false };
}

/**
 * `ta.pivothigh(high, len, len)` seen from bar i: the bar `len` back is a pivot when its high is the
 * highest of the 2*len+1 window and no later bar in the window equals it. NaN otherwise.
 */
export function pivotHigh(candles: Candle[], i: number, len: number): number {
  const c = i - len;
  if (c - len < 0) return NaN;
  const v = candles[c].high;
  for (let k = c - len; k < c; k++) if (candles[k].high > v) return NaN;
  for (let k = c + 1; k <= i; k++) if (candles[k].high >= v) return NaN;
  return v;
}

/** Mirror of `pivotHigh` for lows. */
export function pivotLow(candles: Candle[], i: number, len: number): number {
  const c = i - len;
  if (c - len < 0) return NaN;
  const v = candles[c].low;
  for (let k = c - len; k < c; k++) if (candles[k].low < v) return NaN;
  for (let k = c + 1; k <= i; k++) if (candles[k].low <= v) return NaN;
  return v;
}

/** (volume - SMA50) / population stdev50 at bar i; 0 while there are fewer than 50 bars or stdev is 0. */
function volumeZ(candles: Candle[], i: number): number {
  if (i < VOL_LEN - 1) return 0;
  let sum = 0;
  for (let k = i - VOL_LEN + 1; k <= i; k++) sum += candles[k].volume;
  const mean = sum / VOL_LEN;
  let sq = 0;
  for (let k = i - VOL_LEN + 1; k <= i; k++) sq += (candles[k].volume - mean) ** 2;
  const sd = Math.sqrt(sq / VOL_LEN);
  return sd > 0 ? (candles[i].volume - mean) / sd : 0;
}

/** What the script would send to the broker on this bar. */
export interface EntryPlan {
  side: "long" | "short";
  stop: number;
  target: number;
  risk: number;
  targetFromCluster: boolean;
  /** Wilson lower bound and shrunk probability the script read from its tables for this bar. */
  lb: number;
  pIn: number;
  rho: number;
  ext: number;
  sid: number;
}

/**
 * The script's whole per-bar state machine, one `step` per bar, in Pine's order:
 * day range -> liquidity clusters (add, purge, decay, cap) -> swing engine -> live odds -> signals.
 * Nothing here knows about the backtest engine; `flat` is passed in.
 * State is never reset by a new day: swings, clusters and the learned tables persist for the whole run.
 */
export class SwingFadeCore {
  readonly cfg: SwingFadeConfig;

  // Swing engine.
  started = false;
  sid = 0;
  dir: 1 | -1 = 1;
  b0 = -1;
  p0 = NaN;
  atr0 = NaN;
  pe = NaN;
  be = -1;
  atre = NaN;
  deep = NaN;
  lastTradeSid = -1;
  /** Swings counted into the tables: up legs / down legs. */
  kept0 = 0;
  kept1 = 0;
  /** Learned tables: 40 cells and 10 marginals, trials and hits. */
  cN = new Array<number>(40).fill(0);
  cH = new Array<number>(40).fill(0);
  mN = new Array<number>(10).fill(0);
  mH = new Array<number>(10).fill(0);
  private liveT: number[] = [];
  private liveC: number[] = [];
  private liveM: number[] = [];

  // Liquidity.
  clusters: Cluster[] = [];
  lastPurgeUp = -1;
  lastPurgeDn = -1;

  // Day range and daily ATR of finished sessions.
  private dayKey = "";
  dayHi = NaN;
  dayLo = NaN;
  private dayClose = NaN;
  private dayIsWhole = false;
  private dailyCount = 0;
  private dailySum = 0;
  private dailyAtr = NaN;
  private prevDailyClose = NaN;
  /** Daily ATR as of yesterday's close. NaN until `adrLen` whole sessions have finished. */
  adr = NaN;

  // Read-outs of the last step, for tests and diagnostics.
  /** True on the bar a swing was confirmed (after the flip, `b0`/`p0` hold the confirmed extreme). */
  confirmed = false;
  rho = NaN;
  ext = NaN;
  lbIn = NaN;
  pIn = NaN;
  ready = false;
  oddsOk = false;

  constructor(cfg: SwingFadeConfig) {
    this.cfg = cfg;
  }

  private finishDay() {
    if (!this.dayKey || !this.dayIsWhole) return;
    const n = Math.max(1, Math.floor(this.cfg.adrLen));
    let tr = this.dayHi - this.dayLo;
    if (Number.isFinite(this.prevDailyClose)) {
      tr = Math.max(tr, Math.abs(this.dayHi - this.prevDailyClose), Math.abs(this.dayLo - this.prevDailyClose));
    }
    this.dailyCount++;
    if (this.dailyCount <= n) {
      this.dailySum += tr;
      if (this.dailyCount === n) this.dailyAtr = this.dailySum / n;
    } else {
      this.dailyAtr += (tr - this.dailyAtr) / n;
    }
    this.prevDailyClose = this.dayClose;
  }

  private addCluster(price: number, mass: number, side: -1 | 1, atrV: number) {
    const tol = atrV * this.cfg.mergeTol;
    const hit = this.clusters.find((c) => c.side === side && Math.abs(c.price - price) <= tol);
    if (hit) {
      hit.price = (hit.price * hit.mass + price * mass) / (hit.mass + mass);
      hit.mass += mass;
    } else {
      this.clusters.push({ price, mass, side });
    }
  }

  /** Process bar i. `atrV` is ATR(atrLen) at i (NaN during its warmup). Returns the entry the script would place. */
  step(candles: Candle[], i: number, atrV: number, flat: boolean): EntryPlan | null {
    const cfg = this.cfg;
    const c = candles[i];
    const hasAtr = Number.isFinite(atrV);

    // ---- day range; yesterday's daily ATR
    const key = istDay(c.time);
    if (key !== this.dayKey) {
      this.finishDay();
      this.adr = this.dailyAtr;
      // A first session that starts mid-day (a slice cut inside a day) is not a daily bar.
      this.dayIsWhole = this.dayKey !== "" || istMinutes(c.time) === SESSION_OPEN_MIN;
      this.dayKey = key;
      this.dayHi = c.high;
      this.dayLo = c.low;
    } else {
      if (c.high > this.dayHi) this.dayHi = c.high;
      if (c.low < this.dayLo) this.dayLo = c.low;
    }
    this.dayClose = c.close;

    // ---- liquidity clusters: add on confirmed pivots
    if (hasAtr) {
      const ph = pivotHigh(candles, i, cfg.pivLen);
      const pl = pivotLow(candles, i, cfg.pivLen);
      if (!Number.isNaN(ph) || !Number.isNaN(pl)) {
        const baseM = 1 + Math.max(volumeZ(candles, i), 0) * 0.6;
        if (!Number.isNaN(ph)) {
          if (cfg.tierA > 0) this.addCluster(ph * (1 + cfg.tierA / 100), baseM * 0.8, -1, atrV);
          if (cfg.tierB > 0) this.addCluster(ph * (1 + cfg.tierB / 100), baseM, -1, atrV);
          if (cfg.tierC > 0) this.addCluster(ph * (1 + cfg.tierC / 100), baseM, -1, atrV);
        }
        if (!Number.isNaN(pl)) {
          if (cfg.tierA > 0) this.addCluster(pl * (1 - cfg.tierA / 100), baseM * 0.8, 1, atrV);
          if (cfg.tierB > 0) this.addCluster(pl * (1 - cfg.tierB / 100), baseM, 1, atrV);
          if (cfg.tierC > 0) this.addCluster(pl * (1 - cfg.tierC / 100), baseM, 1, atrV);
        }
      }
    }

    // ---- sweeps consume clusters
    let purgeUp = false;
    let purgeDn = false;
    for (let k = this.clusters.length - 1; k >= 0; k--) {
      const cl = this.clusters[k];
      if (cl.side === -1 && c.high >= cl.price) {
        purgeUp = true;
        this.clusters.splice(k, 1);
      } else if (cl.side === 1 && c.low <= cl.price) {
        purgeDn = true;
        this.clusters.splice(k, 1);
      }
    }
    if (purgeUp) this.lastPurgeUp = i;
    if (purgeDn) this.lastPurgeDn = i;

    // ---- decay and cap
    for (let k = this.clusters.length - 1; k >= 0; k--) {
      this.clusters[k].mass *= cfg.decayF;
      if (this.clusters[k].mass < 0.25) this.clusters.splice(k, 1);
    }
    while (this.clusters.length > cfg.maxCl) {
      let weakest = 0;
      for (let k = 1; k < this.clusters.length; k++) if (this.clusters[k].mass < this.clusters[weakest].mass) weakest = k;
      this.clusters.splice(weakest, 1);
    }

    // ---- swing engine
    let conf = false;
    if (!this.started && hasAtr) {
      this.started = true;
      this.dir = 1;
      this.b0 = i;
      this.p0 = c.low;
      this.atr0 = atrV;
      this.pe = c.high;
      this.be = i;
      this.atre = atrV;
      this.deep = c.close;
    } else if (this.started) {
      if (this.dir === 1) {
        if (c.high > this.pe) {
          this.pe = c.high;
          this.be = i;
          this.atre = atrV;
          this.deep = c.close;
        } else {
          this.deep = Math.min(this.deep, c.low);
        }
        conf = this.pe - this.deep >= cfg.kMult * this.atre;
      } else {
        if (c.low < this.pe) {
          this.pe = c.low;
          this.be = i;
          this.atre = atrV;
          this.deep = c.close;
        } else {
          this.deep = Math.max(this.deep, c.high);
        }
        conf = this.deep - this.pe >= cfg.kMult * this.atre;
      }
      if (conf) {
        // Label every bar recorded during the finished leg: 1 if the extreme was already in at that bar.
        if (this.sid >= 2 && this.liveT.length > 0) {
          for (let k = 0; k < this.liveT.length; k++) {
            const y = this.be <= this.liveT[k] ? 1 : 0;
            const cc = this.liveC[k];
            const mm = this.liveM[k];
            this.cN[cc] += 1;
            this.cH[cc] += y;
            this.mN[mm] += 1;
            this.mH[mm] += y;
          }
          if (this.dir === 1) this.kept0 += 1;
          else this.kept1 += 1;
        }
        this.liveT = [];
        this.liveC = [];
        this.liveM = [];
        this.sid += 1;
        this.p0 = this.pe;
        this.b0 = this.be;
        this.atr0 = this.atre;
        this.pe = this.deep;
        this.be = i;
        this.atre = atrV;
        this.deep = c.close;
        this.dir = this.dir === 1 ? -1 : 1;
      }
    }
    this.confirmed = conf;

    // ---- live odds
    this.rho = NaN;
    this.ext = NaN;
    this.lbIn = NaN;
    this.pIn = NaN;
    if (this.started) {
      const d = this.dir === 1 ? 0 : 1;
      const rho = (this.dir * (this.pe - c.close)) / (cfg.kMult * this.atre);
      const ext = (this.dir * (this.pe - this.p0)) / this.atr0;
      // A zero ATR (dead-flat data) makes these non-finite; Pine would read na. Skip the bar.
      if (Number.isFinite(rho) && Number.isFinite(ext)) {
        this.rho = rho;
        this.ext = ext;
        const { cell, marginal } = cellIndex(d, rho, ext / cfg.kMult);
        this.liveT.push(i);
        this.liveC.push(cell);
        this.liveM.push(marginal);
        const nC = this.cN[cell];
        const hC = this.cH[cell];
        const nM = this.mN[marginal];
        const pm = nM > 0 ? this.mH[marginal] / nM : 0.5;
        const n = nC + cfg.shrinkK;
        this.pIn = n > 0 ? (hC + cfg.shrinkK * pm) / n : NaN;
        this.lbIn = wilsonLower(this.pIn, n, cfg.zConf);
      }
    }
    this.ready = this.kept0 >= cfg.warmN && this.kept1 >= cfg.warmN;

    // ---- signals
    this.oddsOk =
      this.started &&
      this.ready &&
      Number.isFinite(this.lbIn) &&
      this.lbIn >= cfg.lbMin &&
      this.ext >= cfg.minExt &&
      this.rho >= cfg.rhoMin &&
      this.rho <= cfg.rhoMax;
    if (!this.oddsOk || !flat || this.sid === this.lastTradeSid) return null;

    const isShort = this.dir === 1;
    if (isShort ? !cfg.allowS : !cfg.allowL) return null;
    if (cfg.useSweep) {
      const last = isShort ? this.lastPurgeUp : this.lastPurgeDn;
      if (last < 0 || i - last > cfg.sweepBack) return null;
    }
    if (cfg.useDay) {
      // The script gets the daily ATR from the daily chart, which always has history. Here it is built
      // from prior sessions of the same data, so until `adrLen` sessions exist there is no trade.
      if (!(this.adr > 0)) return null;
      const dist = isShort ? this.dayHi - c.close : c.close - this.dayLo;
      if (!(dist / this.adr <= cfg.dayProx)) return null;
    }

    const stop = isShort ? this.pe + cfg.stopBuf * this.atre : this.pe - cfg.stopBuf * this.atre;
    const risk = Math.abs(stop - c.close);
    if (!(risk > 0)) return null;
    const { target, fromCluster } = pickTarget(isShort, c.close, risk, cfg.rrTarget, this.clusters, cfg.useMagTg);
    this.lastTradeSid = this.sid;
    return {
      side: isShort ? "short" : "long",
      stop,
      target,
      risk,
      targetFromCluster: fromCluster,
      lb: this.lbIn,
      pIn: this.pIn,
      rho: this.rho,
      ext: this.ext,
      sid: this.sid,
    };
  }
}

const on = (params: Params, key: string, fallback: boolean) => str(params, key, fallback ? "on" : "off") === "on";

export function swingFadeConfig(params: Params): SwingFadeConfig {
  const d = SWING_FADE_DEFAULTS;
  return {
    kMult: num(params, "kMult", d.kMult),
    atrLen: Math.max(2, Math.floor(num(params, "atrLen", d.atrLen))),
    lbMin: num(params, "lbMin", d.lbMin),
    rhoMin: num(params, "rhoMin", d.rhoMin),
    rhoMax: num(params, "rhoMax", d.rhoMax),
    minExt: num(params, "minExt", d.minExt),
    shrinkK: num(params, "shrinkK", d.shrinkK),
    zConf: num(params, "zConf", d.zConf),
    warmN: num(params, "warmN", d.warmN),
    useSweep: on(params, "useSweep", d.useSweep),
    sweepBack: num(params, "sweepBack", d.sweepBack),
    pivLen: Math.max(1, Math.floor(num(params, "pivLen", d.pivLen))),
    tierA: num(params, "tierA", d.tierA),
    tierB: num(params, "tierB", d.tierB),
    tierC: num(params, "tierC", d.tierC),
    mergeTol: num(params, "mergeTol", d.mergeTol),
    decayF: num(params, "decayF", d.decayF),
    maxCl: Math.max(1, Math.floor(num(params, "maxCl", d.maxCl))),
    useDay: on(params, "useDay", d.useDay),
    dayProx: num(params, "dayProx", d.dayProx),
    adrLen: Math.max(1, Math.floor(num(params, "adrLen", d.adrLen))),
    stopBuf: num(params, "stopBuf", d.stopBuf),
    rrTarget: num(params, "rrTarget", d.rrTarget),
    useMagTg: on(params, "useMagTg", d.useMagTg),
    maxBars: num(params, "maxBars", d.maxBars),
    allowL: on(params, "allowL", d.allowL),
    allowS: on(params, "allowS", d.allowS),
  };
}

const ON_OFF = ["on", "off"];

/**
 * Swing exhaustion fade. Port of the TradingView Pine v6 strategy "Swing Exhaustion Fade" (drawing code left out).
 *
 * Rules, per bar, in the script's order:
 * 1. Liquidity clusters. Each confirmed pivot high (`pivLen` bars each side, so known `pivLen` bars late)
 *    adds levels at +tierA/B/C % above it, each pivot low the mirror below. Mass = 1 + 0.6 x max(volume
 *    z-score over 50 bars, 0), x0.8 for tier A. Levels of one side within `mergeTol` x ATR merge
 *    (mass-weighted price). A bar that trades through a level removes it and counts as a sweep. Masses
 *    decay by `decayF` per bar, levels under 0.25 are dropped, at most `maxCl` are kept.
 * 2. Swing engine: ATR zig-zag. A leg is confirmed once price retraces `kMult` x ATR (ATR taken at the
 *    extreme bar) from its extreme; then the direction flips.
 * 3. Learned odds. On every bar the current leg is bucketed by direction, retrace so far (5 buckets) and
 *    leg size (4 buckets). When the leg is confirmed, each of its bars is scored 1 if the extreme was
 *    already in at that bar. The estimate for a bucket is shrunk toward its marginal (`shrinkK`) and the
 *    Wilson lower bound (`zConf`) must be >= `lbMin`. No trade until `warmN` up legs and `warmN` down
 *    legs have been scored.
 * 4. Entry: fade the leg (short an up leg, long a down leg) when the odds pass, the leg is >= `minExt`
 *    ATR, the retrace is between `rhoMin` and `rhoMax` of k, a sweep on the leg's side happened within
 *    `sweepBack` bars, and the close is within `dayProx` x yesterday's daily ATR of the day's extreme.
 *    One entry per swing. Stop = extreme +/- `stopBuf` x ATR. Target = `rrTarget` x risk, or the nearest
 *    opposite cluster 1R to 4R away.
 * 5. Time stop: exit signal once `maxBars` bars have passed since the signal bar.
 *
 * Swings, clusters and the learned tables carry across days for the whole run, as in the script.
 *
 * Not the same as the script:
 * - The app's engine squares off at 15:05 IST and never holds overnight; the script holds up to
 *   `maxBars` bars and carries overnight. Signals on the last bar of a day or after the square-off are
 *   dropped by the engine, and the swing is still marked as traded.
 * - Sizing is the engine's (risk per trade, capped by capital x leverage); the script's default is 40%
 *   of equity per trade, compounding.
 * - Charges are the app's Upstox model with slippage; the script uses 0.05% commission and 2 ticks.
 * - The daily ATR is built from the intraday bars of prior sessions (Wilder, `adrLen` days). Until
 *   `adrLen` sessions have finished the day filter cannot be evaluated and no trade is taken; the
 *   script reads the daily chart, which always has history.
 * - Pivot ties: the bar must be strictly beyond every later bar in the window and at least equal to
 *   every earlier one.
 * - If the next bar opens beyond the stop the engine skips the entry; the script would enter and stop out.
 *
 * No look-ahead: one `step` per bar from bar 0, reading candles[0..index] only.
 */
export function createSwingFade(): Strategy {
  let lastCandles: Candle[] | null = null;
  let lastParams: Params | null = null;
  let paramsKey = "";
  let lastIdx = -1;
  let core: SwingFadeCore | null = null;
  let atrSeries: number[] = [];

  return {
    id: "swing-fade",
    name: "Swing exhaustion fade",
    description:
      "Port of the TradingView script \"Swing Exhaustion Fade\". Fades an ATR zig-zag leg when its own statistics say the extreme is probably in, after a sweep of a liquidity level and near the day's extreme. Stop beyond the extreme, target 1.5R or the nearest opposite level, time stop after 40 bars. Positions are squared off the same day here; the original holds overnight.",
    intervals: ["5m", "15m"],
    // The state machine is fed every bar from 0 whatever this is; 50 covers ATR, pivots and the volume window.
    warmup: 50,
    params: [
      { key: "kMult", label: "Swing size k (ATR)", type: "number", default: 2.5, min: 0.5, max: 10, step: 0.1, grid: [2, 2.5, 3] },
      { key: "atrLen", label: "ATR length", type: "number", default: 14, min: 2, max: 100, step: 1, grid: [14] },
      { key: "lbMin", label: "Min odds (Wilson lower bound)", type: "number", default: 0.6, min: 0.3, max: 0.99, step: 0.01, grid: [0.55, 0.6, 0.65] },
      { key: "rhoMin", label: "Min retrace (fraction of k)", type: "number", default: 0.35, min: 0, max: 0.9, step: 0.05, grid: [0.35] },
      { key: "rhoMax", label: "Max retrace (fraction of k)", type: "number", default: 0.8, min: 0.1, max: 1, step: 0.05, grid: [0.8] },
      { key: "minExt", label: "Min swing size (ATR)", type: "number", default: 2, min: 0.5, max: 20, step: 0.1, grid: [2] },
      { key: "shrinkK", label: "Shrinkage", type: "number", default: 10, min: 0, max: 100, step: 1, grid: [10] },
      { key: "zConf", label: "Wilson z", type: "number", default: 1.28, min: 0, max: 4, step: 0.01, grid: [1.28] },
      { key: "warmN", label: "Swings per direction before trading", type: "number", default: 20, min: 5, max: 500, step: 1, grid: [20] },
      { key: "useSweep", label: "Require a recent sweep", type: "select", default: "on", options: ON_OFF, grid: ["on", "off"] },
      { key: "sweepBack", label: "Sweep lookback (bars)", type: "number", default: 12, min: 1, max: 200, step: 1, grid: [12] },
      { key: "pivLen", label: "Pivot length", type: "number", default: 8, min: 3, max: 30, step: 1, grid: [8] },
      { key: "tierA", label: "Tier A % (0 = off)", type: "number", default: 1, min: 0, max: 20, step: 0.25, grid: [1] },
      { key: "tierB", label: "Tier B % (0 = off)", type: "number", default: 2, min: 0, max: 20, step: 0.25, grid: [2] },
      { key: "tierC", label: "Tier C % (0 = off)", type: "number", default: 4, min: 0, max: 20, step: 0.25, grid: [4] },
      { key: "mergeTol", label: "Merge tolerance (ATR)", type: "number", default: 0.35, min: 0.1, max: 5, step: 0.05, grid: [0.35] },
      { key: "decayF", label: "Mass decay per bar", type: "number", default: 0.995, min: 0.98, max: 1, step: 0.001, grid: [0.995] },
      { key: "maxCl", label: "Max clusters", type: "number", default: 24, min: 6, max: 40, step: 1, grid: [24] },
      { key: "useDay", label: "Require entry near the day's extreme", type: "select", default: "on", options: ON_OFF, grid: ["on"] },
      { key: "dayProx", label: "Max distance from day extreme (daily ATR)", type: "number", default: 0.5, min: 0.05, max: 5, step: 0.05, grid: [0.5] },
      { key: "adrLen", label: "Daily ATR length (days)", type: "number", default: 14, min: 3, max: 60, step: 1, grid: [14] },
      { key: "stopBuf", label: "Stop buffer beyond extreme (ATR)", type: "number", default: 0.25, min: 0, max: 5, step: 0.05, grid: [0.25] },
      { key: "rrTarget", label: "Target (R)", type: "number", default: 1.5, min: 0.5, max: 10, step: 0.1, grid: [1, 1.5, 2] },
      { key: "useMagTg", label: "Target nearest opposite cluster (1R-4R away)", type: "select", default: "on", options: ON_OFF, grid: ["on", "off"] },
      { key: "maxBars", label: "Time stop (bars)", type: "number", default: 40, min: 3, max: 500, step: 1, grid: [40] },
      { key: "allowL", label: "Longs", type: "select", default: "on", options: ON_OFF, grid: ["on"] },
      { key: "allowS", label: "Shorts", type: "select", default: "on", options: ON_OFF, grid: ["on"] },
    ],
    onBar(ctx): Signal | null {
      let reset = ctx.candles !== lastCandles || ctx.index <= lastIdx || core === null;
      if (ctx.params !== lastParams) {
        const key = JSON.stringify(ctx.params);
        if (key !== paramsKey) reset = true;
        paramsKey = key;
        lastParams = ctx.params;
      }
      if (reset || core === null) {
        const cfg = swingFadeConfig(ctx.params);
        core = new SwingFadeCore(cfg);
        // Wilder ATR is causal: the value at k depends on candles[0..k] only.
        atrSeries = atr(ctx.candles, cfg.atrLen);
        lastCandles = ctx.candles;
        lastIdx = -1;
      }
      const cfg = core.cfg;

      // Bars the engine did not show us (the warmup) are processed here, as if flat.
      for (let k = lastIdx + 1; k < ctx.index; k++) core.step(ctx.candles, k, atrSeries[k], true);
      const plan = core.step(ctx.candles, ctx.index, atrSeries[ctx.index], ctx.position === null);
      lastIdx = ctx.index;

      if (ctx.position) {
        // The script counts from the signal bar, one before the fill bar.
        if (ctx.index - (ctx.position.entryIndex - 1) >= cfg.maxBars) {
          return { action: "exit", side: ctx.position.side, reason: "time stop" };
        }
        return null;
      }
      if (!plan) return null;
      const tgt = plan.targetFromCluster ? "cluster" : `${cfg.rrTarget}R`;
      return {
        action: "enter",
        side: plan.side,
        stop: plan.stop,
        target: plan.target,
        reason: `Fade ${plan.side} lb ${(plan.lb * 100).toFixed(1)}% p ${(plan.pIn * 100).toFixed(1)}% rho ${plan.rho.toFixed(2)} ext ${plan.ext.toFixed(1)} tgt ${tgt}`,
      };
    },
  };
}
