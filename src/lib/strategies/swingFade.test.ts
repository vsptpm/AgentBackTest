import { describe, expect, it } from "vitest";
import type { Candle, Params, Signal } from "@/lib/types";
import { atr } from "@/lib/indicators";
import { createStrategy, defaultParams, listStrategies } from "./index";
import {
  cellIndex,
  createSwingFade,
  pickTarget,
  pivotHigh,
  pivotLow,
  SWING_FADE_DEFAULTS,
  SwingFadeCore,
  swingFadeConfig,
  wilsonLower,
  type Cluster,
  type EntryPlan,
  type SwingFadeConfig,
} from "./swingFade";
import { SESSION_OPEN_MIN } from "./helpers";

const IST = 5.5 * 60 * 60 * 1000;
const BARS_PER_DAY = 75;
const DAY0 = Date.parse("2026-03-02T00:00:00Z") - IST;

/** Time of the n-th 5m bar, 75 bars a session from 09:15 IST, one session per calendar day. */
function barTime(n: number): number {
  const day = Math.floor(n / BARS_PER_DAY);
  return DAY0 + day * 86_400_000 + (SESSION_OPEN_MIN + (n % BARS_PER_DAY) * 5) * 60_000;
}

function bar(n: number, high: number, low: number, close: number, volume = 1000): Candle {
  return { time: barTime(n), open: close, high, low, close, volume };
}

const cfg = (over: Partial<SwingFadeConfig> = {}): SwingFadeConfig => ({ ...SWING_FADE_DEFAULTS, ...over });

/** Seeded random walk with ATR-sized bars, so the zig-zag turns often. */
function randomWalk(n: number, seed = 7): Candle[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: Candle[] = [];
  let px = 500;
  for (let i = 0; i < n; i++) {
    const open = px;
    const close = Math.max(50, open + (rnd() - 0.5) * 4);
    const high = Math.max(open, close) + rnd() * 1.5;
    const low = Math.min(open, close) - rnd() * 1.5;
    out.push({ time: barTime(i), open, high, low, close, volume: 1000 + Math.floor(rnd() * 5000) });
    px = close;
  }
  return out;
}

/** Loose settings so the walk produces plenty of entries. */
const LOOSE: Partial<SwingFadeConfig> = { warmN: 5, lbMin: 0.3, minExt: 1, rhoMin: 0.1, rhoMax: 0.95, useSweep: false, useDay: false };
const LOOSE_PARAMS: Params = { warmN: 5, lbMin: 0.3, minExt: 1, rhoMin: 0.1, rhoMax: 0.95, useSweep: "off", useDay: "off" };

interface Row {
  i: number;
  plan: EntryPlan;
  pe: number;
  atre: number;
  close: number;
  clusters: Cluster[];
  kept0: number;
  kept1: number;
}

function runCore(candles: Candle[], c: SwingFadeConfig): { core: SwingFadeCore; rows: Row[] } {
  const core = new SwingFadeCore(c);
  const a = atr(candles, c.atrLen);
  const rows: Row[] = [];
  for (let i = 0; i < candles.length; i++) {
    const plan = core.step(candles, i, a[i], true);
    if (plan) {
      rows.push({ i, plan, pe: core.pe, atre: core.atre, close: candles[i].close, clusters: core.clusters.map((x) => ({ ...x })), kept0: core.kept0, kept1: core.kept1 });
    }
  }
  return { core, rows };
}

describe("swing-fade helpers", () => {
  it("Wilson lower bound matches a hand calculation", () => {
    // p 0.7, n 30, z 1.28: z^2 = 1.6384; centre 0.7 + 0.0273067 = 0.7273067;
    // sqrt(0.21/30 + 1.6384/3600) = sqrt(0.0074551) = 0.086343; x 1.28 = 0.110519;
    // (0.7273067 - 0.110519) / (1 + 0.0546133) = 0.58485
    expect(wilsonLower(0.7, 30, 1.28)).toBeCloseTo(0.58485, 4);
    // p 0.5, n 10, z 1: (0.5 + 0.05 - sqrt(0.025 + 0.0025)) / 1.1 = (0.55 - 0.165831) / 1.1 = 0.349244
    expect(wilsonLower(0.5, 10, 1)).toBeCloseTo(0.349244, 5);
    expect(wilsonLower(0.9, 0, 1.28)).toBe(0);
    // More evidence at the same rate raises the bound; it never exceeds p.
    expect(wilsonLower(0.7, 300, 1.28)).toBeGreaterThan(wilsonLower(0.7, 30, 1.28));
    expect(wilsonLower(0.7, 300, 1.28)).toBeLessThan(0.7);
  });

  it("indexes cells by direction, retrace bucket and size bucket", () => {
    expect(cellIndex(0, 0.45, 1.2)).toEqual({ cell: 8, marginal: 2 });
    expect(cellIndex(1, 0.95, 3)).toEqual({ cell: 38, marginal: 9 });
    expect(cellIndex(0, 0, 0)).toEqual({ cell: 0, marginal: 0 });
    // Retrace is clamped to 0..1 and the top bucket is 4.
    expect(cellIndex(0, -0.3, 1)).toEqual({ cell: 0, marginal: 0 });
    expect(cellIndex(0, 1, 1)).toEqual({ cell: 16, marginal: 4 });
    expect(cellIndex(0, 7, 1)).toEqual({ cell: 16, marginal: 4 });
    // Size bucket edges: < 1.5, < 2.5, < 4, else.
    expect(cellIndex(1, 0.1, 1.49).cell).toBe(20);
    expect(cellIndex(1, 0.1, 1.5).cell).toBe(21);
    expect(cellIndex(1, 0.1, 2.5).cell).toBe(22);
    expect(cellIndex(1, 0.1, 4).cell).toBe(23);
    // Same float division as Pine: 0.6 / 0.2 is 2.9999999999999996, so 0.6 sits in bucket 2.
    expect(cellIndex(0, 0.6, 0).marginal).toBe(2);
    expect(cellIndex(0, 0.61, 0).marginal).toBe(3);
    // Every index stays inside the 40 / 10 tables.
    for (const d of [0, 1]) for (let rho = -1; rho <= 2; rho += 0.07) for (const r of [0, 2, 3, 9]) {
      const { cell, marginal } = cellIndex(d, rho, r);
      expect(cell).toBeGreaterThanOrEqual(0);
      expect(cell).toBeLessThan(40);
      expect(marginal).toBeGreaterThanOrEqual(0);
      expect(marginal).toBeLessThan(10);
    }
  });

  it("finds pivots only once pivLen bars have passed, and breaks ties toward the later bar", () => {
    const highs = [100, 100, 100, 102, 100, 100, 100, 100];
    const candles = highs.map((h, n) => bar(n, h, 99, 99.5));
    expect(pivotHigh(candles, 4, 2)).toBeNaN();
    expect(pivotHigh(candles, 5, 2)).toBe(102);
    expect(pivotHigh(candles, 6, 2)).toBeNaN();
    // Flat lows: no bar is strictly below the bars after it.
    expect(pivotLow(candles, 5, 2)).toBeNaN();
    // Two equal highs: only the later one is a pivot.
    const tie = [100, 100, 102, 102, 100, 100, 100].map((h, n) => bar(n, h, 99, 99.5));
    expect(pivotHigh(tie, 4, 2)).toBeNaN();
    expect(pivotHigh(tie, 5, 2)).toBe(102);
  });

  it("picks the nearest opposite cluster between 1R and 4R, else rr x risk", () => {
    const below = (price: number): Cluster => ({ price, mass: 1, side: 1 });
    const above = (price: number): Cluster => ({ price, mass: 1, side: -1 });
    // Short from 100 with risk 1: 99.5 is nearer than 1R, 95.5 is beyond 4R, 98.2 is the nearest valid.
    const cl = [below(99.5), below(97), below(98.2), below(95.5), above(102)];
    expect(pickTarget(true, 100, 1, 1.5, cl, true)).toEqual({ target: 98.2, fromCluster: true });
    expect(pickTarget(true, 100, 1, 1.5, cl, false)).toEqual({ target: 98.5, fromCluster: false });
    expect(pickTarget(true, 100, 1, 1.5, [below(99.5), below(95.5)], true)).toEqual({ target: 98.5, fromCluster: false });
    // Exactly 1R and exactly 4R are allowed.
    expect(pickTarget(true, 100, 1, 1.5, [below(96)], true).target).toBe(96);
    expect(pickTarget(true, 100, 1, 1.5, [below(99)], true).target).toBe(99);
    // Long: clusters above, nearest wins; clusters below are ignored.
    const up = [above(100.5), above(103), above(101.4), above(104.5), below(98)];
    expect(pickTarget(false, 100, 1, 2, up, true)).toEqual({ target: 101.4, fromCluster: true });
    expect(pickTarget(false, 100, 1, 2, [below(98)], true)).toEqual({ target: 102, fromCluster: false });
  });

  it("is registered with the script's defaults", () => {
    const meta = listStrategies().find((s) => s.id === "swing-fade");
    expect(meta?.name).toBe("Swing exhaustion fade");
    expect(createStrategy("swing-fade").id).toBe("swing-fade");
    expect(swingFadeConfig(defaultParams(meta!))).toEqual(SWING_FADE_DEFAULTS);
    expect(swingFadeConfig({})).toEqual(SWING_FADE_DEFAULTS);
  });
});

describe("swing-fade swing engine", () => {
  // ATR is passed as 1 on every bar, k = 2.5. pivLen is large so no clusters form.
  const c = cfg({ kMult: 2.5, pivLen: 30 });
  const candles = [
    bar(0, 100, 99, 99.5), // start: up leg from 99, extreme 100
    bar(1, 103, 100, 102.5), // new high 103
    bar(2, 102.8, 101, 101.2), // retrace 2.0
    bar(3, 101.5, 100.4, 100.6), // retrace 2.6 -> confirm the high, flip down
    bar(4, 100.9, 99, 99.2), // new low 99
    bar(5, 101.6, 99.5, 101.5), // bounce 2.6 -> confirm the low, flip up
    bar(6, 104, 101.5, 103.8), // new high 104
    bar(7, 103.9, 101.2, 101.4), // retrace 2.8 -> confirm, flip down; first leg that is scored
  ];

  it("confirms swings at the right bars and flips direction", () => {
    const core = new SwingFadeCore(c);
    const snap = () => ({ sid: core.sid, dir: core.dir, p0: core.p0, b0: core.b0, pe: core.pe, be: core.be, conf: core.confirmed });

    core.step(candles, 0, 1, true);
    expect(snap()).toEqual({ sid: 0, dir: 1, p0: 99, b0: 0, pe: 100, be: 0, conf: false });
    core.step(candles, 1, 1, true);
    expect(snap()).toEqual({ sid: 0, dir: 1, p0: 99, b0: 0, pe: 103, be: 1, conf: false });
    core.step(candles, 2, 1, true);
    expect(snap()).toEqual({ sid: 0, dir: 1, p0: 99, b0: 0, pe: 103, be: 1, conf: false });
    expect(core.deep).toBe(101);
    // rho = (103 - 101.2) / 2.5, ext = (103 - 99) / 1
    expect(core.rho).toBeCloseTo(0.72, 10);
    expect(core.ext).toBeCloseTo(4, 10);

    core.step(candles, 3, 1, true);
    // The confirmed high becomes the new leg start; the new extreme is the deepest low, stamped at this bar.
    expect(snap()).toEqual({ sid: 1, dir: -1, p0: 103, b0: 1, pe: 100.4, be: 3, conf: true });
    expect(core.deep).toBe(100.6);

    core.step(candles, 4, 1, true);
    expect(snap()).toEqual({ sid: 1, dir: -1, p0: 103, b0: 1, pe: 99, be: 4, conf: false });
    core.step(candles, 5, 1, true);
    expect(snap()).toEqual({ sid: 2, dir: 1, p0: 99, b0: 4, pe: 101.6, be: 5, conf: true });

    // The first two confirmations are not scored.
    expect(core.kept0 + core.kept1).toBe(0);
    expect(core.cN.reduce((x, y) => x + y, 0)).toBe(0);

    core.step(candles, 6, 1, true);
    expect(snap()).toEqual({ sid: 2, dir: 1, p0: 99, b0: 4, pe: 104, be: 6, conf: false });
    core.step(candles, 7, 1, true);
    expect(snap()).toEqual({ sid: 3, dir: -1, p0: 104, b0: 6, pe: 101.2, be: 7, conf: true });
  });

  it("scores each bar of a finished leg: 1 if the extreme was already in", () => {
    const core = new SwingFadeCore(c);
    for (let i = 0; i < candles.length; i++) core.step(candles, i, 1, true);
    // The up leg confirmed at bar 7 recorded bars 5 and 6. Its extreme came at bar 6: bar 5 -> 0, bar 6 -> 1.
    expect(core.kept0).toBe(1);
    expect(core.kept1).toBe(0);
    expect(core.cN.reduce((x, y) => x + y, 0)).toBe(2);
    expect(core.cH.reduce((x, y) => x + y, 0)).toBe(1);
    expect(core.mN.reduce((x, y) => x + y, 0)).toBe(2);
    expect(core.mH.reduce((x, y) => x + y, 0)).toBe(1);
    // Bar 5: rho = (101.6 - 101.5) / 2.5 = 0.04, ext/k = 2.6 / 2.5 -> cell 0 (miss).
    // Bar 6: rho = (104 - 103.8) / 2.5 = 0.08, ext/k = 5 / 2.5 = 2 -> cell 1 (hit).
    expect(core.cN[0]).toBe(1);
    expect(core.cH[0]).toBe(0);
    expect(core.cN[1]).toBe(1);
    expect(core.cH[1]).toBe(1);
    expect(core.ready).toBe(false);
  });

  it("reads shrunk odds and the Wilson bound from the tables", () => {
    const core = new SwingFadeCore(cfg({ kMult: 2.5, pivLen: 30, shrinkK: 10, zConf: 1.28 }));
    for (let i = 0; i < candles.length; i++) core.step(candles, i, 1, true);
    // Bar 7 after the flip: down leg, rho = (101.4 - 101.2) / 2.5 = 0.08 -> empty cell and empty marginal.
    // pIn = (0 + 10 x 0.5) / 10 = 0.5 on n = 10.
    expect(core.pIn).toBeCloseTo(0.5, 12);
    expect(core.lbIn).toBeCloseTo(wilsonLower(0.5, 10, 1.28), 12);
  });
});

describe("swing-fade liquidity clusters", () => {
  /** Flat bars (high 100, low 99) with chosen highs patched in. Flat lows never make a pivot low. */
  const flat = (n: number, highs: Record<number, number>): Candle[] =>
    Array.from({ length: n }, (_, k) => bar(k, highs[k] ?? 100, 99, 99.5));
  const run = (candles: Candle[], c: SwingFadeConfig, upTo: number) => {
    const core = new SwingFadeCore(c);
    for (let i = 0; i <= upTo; i++) core.step(candles, i, 1, true);
    return core;
  };
  // kMult is huge so the swing engine never flips.
  const base = cfg({ pivLen: 3, kMult: 1000, decayF: 0.995 });

  it("adds three tiers above a confirmed pivot high, pivLen bars late", () => {
    const candles = flat(12, { 5: 102 });
    expect(run(candles, base, 7).clusters).toHaveLength(0);
    const core = run(candles, base, 8);
    expect(core.clusters.map((x) => x.side)).toEqual([-1, -1, -1]);
    expect(core.clusters[0].price).toBeCloseTo(102 * 1.01, 10);
    expect(core.clusters[1].price).toBeCloseTo(102 * 1.02, 10);
    expect(core.clusters[2].price).toBeCloseTo(102 * 1.04, 10);
    // Volume z-score is 0 (fewer than 50 bars), so base mass 1; tier A is 0.8. One decay on the same bar.
    expect(core.clusters[0].mass).toBeCloseTo(0.8 * 0.995, 12);
    expect(core.clusters[1].mass).toBeCloseTo(0.995, 12);
    // A tier set to 0 is skipped.
    expect(run(candles, { ...base, tierA: 0 }, 8).clusters).toHaveLength(2);
  });

  it("mirrors the tiers below a pivot low", () => {
    const candles = Array.from({ length: 12 }, (_, k) => bar(k, 100, k === 5 ? 97 : 99, 99.5));
    const core = run(candles, base, 8);
    expect(core.clusters.map((x) => x.side)).toEqual([1, 1, 1]);
    expect(core.clusters[0].price).toBeCloseTo(97 * 0.99, 10);
    expect(core.clusters[2].price).toBeCloseTo(97 * 0.96, 10);
  });

  it("weights the mass by a positive volume z-score", () => {
    const candles = Array.from({ length: 60 }, (_, k) => bar(k, k === 52 ? 102 : 100, 99, 99.5, k === 55 ? 6000 : 1000));
    const core = run(candles, base, 55);
    // Window of 50 with one 6000 among 1000s: mean 1100, population sd 700, z = 7. Mass = 1 + 7 x 0.6.
    expect(core.clusters[1].mass).toBeCloseTo((1 + 7 * 0.6) * 0.995, 9);
    expect(core.clusters[0].mass).toBeCloseTo((1 + 7 * 0.6) * 0.8 * 0.995, 9);
  });

  it("merges a new level within mergeTol x ATR into the old one, mass-weighted", () => {
    const candles = flat(20, { 5: 102, 12: 102.1 });
    const core = run(candles, base, 15);
    expect(core.clusters).toHaveLength(3);
    // Tier A: old 103.02 with mass 0.8 x 0.995^7 (bars 8..14), new 103.121 with mass 0.8.
    const w = 0.8 * 0.995 ** 7;
    expect(core.clusters[0].price).toBeCloseTo((103.02 * w + 103.121 * 0.8) / (w + 0.8), 9);
    expect(core.clusters[0].mass).toBeCloseTo((w + 0.8) * 0.995, 12);
    // With a tiny tolerance they stay separate.
    expect(run(candles, { ...base, mergeTol: 0.01 }, 15).clusters).toHaveLength(6);
  });

  it("a bar trading through a level consumes it and stamps the sweep", () => {
    const candles = flat(20, { 5: 102, 10: 103.5 });
    const before = run(candles, base, 9);
    expect(before.clusters).toHaveLength(3);
    expect(before.lastPurgeUp).toBe(-1);
    const core = run(candles, base, 10);
    // 103.5 takes out tier A (103.02) only.
    expect(core.clusters).toHaveLength(2);
    expect(core.clusters[0].price).toBeCloseTo(104.04, 10);
    expect(core.lastPurgeUp).toBe(10);
    expect(core.lastPurgeDn).toBe(-1);
  });

  it("decays masses every bar and drops levels under 0.25", () => {
    const candles = flat(14, { 5: 102 });
    const fast = { ...base, decayF: 0.5 };
    // Bar 8: 0.4, 0.5, 0.5. Bar 9: tier A 0.2 dropped; the others are exactly 0.25 and stay. Bar 10: gone.
    expect(run(candles, fast, 8).clusters.map((x) => x.mass)).toEqual([0.4, 0.5, 0.5]);
    expect(run(candles, fast, 9).clusters.map((x) => x.mass)).toEqual([0.25, 0.25]);
    expect(run(candles, fast, 10).clusters).toHaveLength(0);
  });

  it("keeps at most maxCl levels, removing the weakest first", () => {
    const candles = flat(12, { 5: 102 });
    const core = run(candles, { ...base, maxCl: 2 }, 8);
    expect(core.clusters.map((x) => x.price)).toEqual([102 * 1.02, 102 * 1.04]);
  });
});

describe("swing-fade entries", () => {
  const candles = randomWalk(6000);

  it("does not trade before both directions have warmN scored swings", () => {
    const { rows, core } = runCore(candles, cfg(LOOSE));
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(r.kept0).toBeGreaterThanOrEqual(5);
      expect(r.kept1).toBeGreaterThanOrEqual(5);
    }
    // A later warm-up means a later first trade; an unreachable one means none.
    const late = runCore(candles, cfg({ ...LOOSE, warmN: 15 })).rows;
    expect(late[0].i).toBeGreaterThan(rows[0].i);
    expect(late[0].kept0).toBeGreaterThanOrEqual(15);
    expect(runCore(candles, cfg({ ...LOOSE, warmN: core.kept0 + core.kept1 + 1 })).rows).toHaveLength(0);
  });

  it("takes one trade per swing", () => {
    const { rows } = runCore(candles, cfg(LOOSE));
    const sids = rows.map((r) => r.plan.sid);
    expect(new Set(sids).size).toBe(sids.length);
    expect(rows.some((r) => r.plan.side === "long")).toBe(true);
    expect(rows.some((r) => r.plan.side === "short")).toBe(true);
  });

  it("emits nothing while a position is open", () => {
    const core = new SwingFadeCore(cfg(LOOSE));
    const a = atr(candles, 14);
    for (let i = 0; i < candles.length; i++) expect(core.step(candles, i, a[i], false)).toBeNull();
  });

  it("puts the stop stopBuf x ATR beyond the extreme and the target at rr x risk", () => {
    const { rows } = runCore(candles, cfg({ ...LOOSE, useMagTg: false, stopBuf: 0.25, rrTarget: 1.5 }));
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      const s = r.plan.side === "short" ? 1 : -1;
      expect(r.plan.stop).toBeCloseTo(r.pe + s * 0.25 * r.atre, 9);
      expect(r.plan.risk).toBeCloseTo(Math.abs(r.plan.stop - r.close), 9);
      expect(r.plan.target).toBeCloseTo(r.close - s * 1.5 * r.plan.risk, 9);
      expect(r.plan.targetFromCluster).toBe(false);
      // The stop is on the losing side of the close, the target on the winning side.
      expect(s * (r.plan.stop - r.close)).toBeGreaterThan(0);
      expect(s * (r.close - r.plan.target)).toBeGreaterThan(0);
      // The filters hold on the signal bar.
      expect(r.plan.lb).toBeGreaterThanOrEqual(0.3);
      expect(r.plan.rho).toBeGreaterThanOrEqual(0.1);
      expect(r.plan.rho).toBeLessThanOrEqual(0.95);
      expect(r.plan.ext).toBeGreaterThanOrEqual(1);
    }
  });

  it("uses a cluster target only when it is 1R to 4R away on the profit side", () => {
    // Tiers close to price so that clusters are often in range.
    const { rows } = runCore(candles, cfg({ ...LOOSE, useMagTg: true, tierA: 0.5, tierB: 1, tierC: 1.5, pivLen: 3 }));
    const magnet = rows.filter((r) => r.plan.targetFromCluster);
    expect(magnet.length).toBeGreaterThan(3);
    expect(rows.length).toBeGreaterThan(magnet.length);
    for (const r of rows) {
      const isShort = r.plan.side === "short";
      const expected = pickTarget(isShort, r.close, r.plan.risk, 1.5, r.clusters, true);
      expect(r.plan.target).toBe(expected.target);
      const dist = isShort ? r.close - r.plan.target : r.plan.target - r.close;
      if (r.plan.targetFromCluster) {
        expect(dist).toBeGreaterThanOrEqual(r.plan.risk);
        expect(dist).toBeLessThanOrEqual(4 * r.plan.risk);
      } else {
        expect(dist).toBeCloseTo(1.5 * r.plan.risk, 9);
      }
    }
  });

  it("requires a sweep on the leg's side within sweepBack bars", () => {
    const c = cfg({ ...LOOSE, useSweep: true, sweepBack: 12, tierA: 0.3, tierB: 0.6, tierC: 1, pivLen: 3 });
    const core = new SwingFadeCore(c);
    const a = atr(candles, 14);
    let n = 0;
    for (let i = 0; i < candles.length; i++) {
      const plan = core.step(candles, i, a[i], true);
      if (!plan) continue;
      n++;
      const last = plan.side === "short" ? core.lastPurgeUp : core.lastPurgeDn;
      expect(last).toBeGreaterThanOrEqual(0);
      expect(i - last).toBeLessThanOrEqual(12);
    }
    expect(n).toBeGreaterThan(3);
    expect(n).toBeLessThan(runCore(candles, cfg({ ...c, useSweep: false })).rows.length);
  });

  it("day filter: needs adrLen finished sessions, then trades only near the day's extreme", () => {
    const c = cfg({ ...LOOSE, useDay: true, adrLen: 14, dayProx: 0.5 });
    const core = new SwingFadeCore(c);
    const a = atr(candles, 14);
    let n = 0;
    for (let i = 0; i < candles.length; i++) {
      const plan = core.step(candles, i, a[i], true);
      if (i < 14 * BARS_PER_DAY) expect(core.adr).toBeNaN();
      if (!plan) continue;
      n++;
      expect(i).toBeGreaterThanOrEqual(14 * BARS_PER_DAY);
      const dist = plan.side === "short" ? core.dayHi - candles[i].close : candles[i].close - core.dayLo;
      expect(dist / core.adr).toBeLessThanOrEqual(0.5);
    }
    expect(n).toBeGreaterThan(3);
  });

  it("daily ATR is yesterday's: today's bars do not change it", () => {
    const c = cfg({ ...LOOSE, useDay: true });
    const a = atr(candles, 14);
    const at = (cs: Candle[], upTo: number) => {
      const core = new SwingFadeCore(c);
      for (let i = 0; i <= upTo; i++) core.step(cs, i, a[i], true);
      return core.adr;
    };
    const dayStart = 20 * BARS_PER_DAY;
    const spiked = candles.map((x, k) => (k === dayStart + 3 ? { ...x, high: x.high + 500, low: x.low - 400 } : x));
    expect(at(spiked, dayStart + 40)).toBe(at(candles, dayStart + 40));
    // It shows up the next day.
    expect(at(spiked, dayStart + BARS_PER_DAY)).toBeGreaterThan(at(candles, dayStart + BARS_PER_DAY));
  });

  it("longs-only and shorts-only switches work", () => {
    expect(runCore(candles, cfg({ ...LOOSE, allowS: false })).rows.every((r) => r.plan.side === "long")).toBe(true);
    expect(runCore(candles, cfg({ ...LOOSE, allowL: false })).rows.every((r) => r.plan.side === "short")).toBe(true);
  });
});

describe("swing-fade strategy wrapper", () => {
  const candles = randomWalk(4000, 11);

  function run(cs: Candle[], params: Params, upTo = cs.length - 1): Map<number, Signal> {
    const s = createSwingFade();
    const p = { ...defaultParams(s), ...params };
    const out = new Map<number, Signal>();
    for (let i = s.warmup; i <= upTo; i++) {
      const signal = s.onBar({ candles: cs, index: i, params: p, position: null, interval: "5m" });
      if (signal) out.set(i, signal);
    }
    return out;
  }

  it("emits the same entries as the core, with stop and target", () => {
    const sigs = run(candles, LOOSE_PARAMS);
    const { rows } = runCore(candles, cfg(LOOSE));
    expect(sigs.size).toBe(rows.length);
    expect(sigs.size).toBeGreaterThan(10);
    for (const r of rows) {
      const s = sigs.get(r.i);
      expect(s?.action).toBe("enter");
      expect(s?.side).toBe(r.plan.side);
      expect(s?.stop).toBe(r.plan.stop);
      expect(s?.target).toBe(r.plan.target);
      expect(s?.reason).toContain(`lb ${(r.plan.lb * 100).toFixed(1)}%`);
    }
  });

  it("exits on the time stop, counted from the signal bar", () => {
    const s = createSwingFade();
    const params = { ...defaultParams(s), maxBars: 40 };
    // Signal at bar 999, filled at 1000. The script closes when bar - signal bar >= 40, i.e. at bar 1039.
    const position = { side: "short" as const, entryPrice: 500, entryIndex: 1000 };
    for (let i = s.warmup; i < 1000; i++) s.onBar({ candles, index: i, params, position: null, interval: "5m" });
    for (let i = 1000; i < 1039; i++) {
      expect(s.onBar({ candles, index: i, params, position, interval: "5m" })).toBeNull();
    }
    expect(s.onBar({ candles, index: 1039, params, position, interval: "5m" })).toEqual({ action: "exit", side: "short", reason: "time stop" });
  });

  it("has no look-ahead: changing bars after i does not change any signal up to i", () => {
    const full = run(candles, LOOSE_PARAMS);
    const idx = [...full.keys()];
    expect(idx.length).toBeGreaterThan(10);
    // Cut at signal bars, at the bar before one, and at arbitrary bars.
    const cuts = [idx[0], idx[3], idx[idx.length - 1], idx[5] - 1, 1234, 2500];
    for (const i of cuts) {
      const mutated = candles.map((c, k) =>
        k > i ? { ...c, open: c.open * 3, high: c.high * 5, low: c.low * 0.2, close: c.close * 3, volume: c.volume * 1000 } : c,
      );
      const got = run(mutated, LOOSE_PARAMS, i);
      const want = new Map([...full].filter(([k]) => k <= i));
      expect(got).toEqual(want);
    }
    // And with every filter on (defaults except a short warm-up).
    const strict: Params = { warmN: 5, lbMin: 0.3, tierA: 0.3, tierB: 0.6, tierC: 1, pivLen: 3 };
    const fullStrict = run(candles, strict);
    expect(fullStrict.size).toBeGreaterThan(0);
    const j = [...fullStrict.keys()][Math.floor(fullStrict.size / 2)];
    const mutated = candles.map((c, k) => (k > j ? { ...c, high: c.high * 5, low: c.low * 0.2, close: c.close * 2, volume: 1 } : c));
    expect(run(mutated, strict, j)).toEqual(new Map([...fullStrict].filter(([k]) => k <= j)));
  });

  it("gives the same answer when first called late (catch-up from bar 0) as bar by bar", () => {
    const full = run(candles, LOOSE_PARAMS);
    const i = [...full.keys()][0];
    const s = createSwingFade();
    const direct = s.onBar({ candles, index: i, params: { ...defaultParams(s), ...LOOSE_PARAMS }, position: null, interval: "5m" });
    expect(direct).toEqual(full.get(i));
  });

  it("starts from scratch on a new candle array or new params", () => {
    const s = createSwingFade();
    const p = { ...defaultParams(s), ...LOOSE_PARAMS };
    const collect = (cs: Candle[], params: Params) => {
      const out: number[] = [];
      for (let i = s.warmup; i < cs.length; i++) if (s.onBar({ candles: cs, index: i, params, position: null, interval: "5m" })) out.push(i);
      return out;
    };
    const first = collect(candles, p);
    expect(collect([...candles], p)).toEqual(first);
    expect(collect(candles, { ...p })).toEqual(first);
  });
});
