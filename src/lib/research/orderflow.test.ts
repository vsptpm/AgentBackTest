import { describe, expect, it } from "vitest";
import {
  COST_LARGE,
  COST_SMALL,
  analyze,
  buildObs,
  correlationCell,
  decileTable,
  forwardIndex,
  gcdPaise,
  hitRate,
  imbalance,
  imbalance5,
  imbalanceTop,
  imbalanceTotal,
  inSession,
  istDay,
  meanT,
  measureSeries,
  medianInterval,
  microprice,
  mid,
  nonOverlapping,
  ofi,
  ofiNormalized,
  olsSlope,
  pearson,
  quantile,
  ranks,
  spearman,
  spread,
  syntheticSamples,
  tStatCorr,
  toQuote,
  tradableTest,
  type DepthSample,
  type Quote,
} from "./orderflow";

/** 2026-01-05 is a Monday. Time of day in IST -> epoch ms. */
const at = (hms: string, day = "2026-01-05") => Date.parse(`${day}T${hms}+05:30`);

const quote = (t: number, bid: number, ask: number, bq = 100, aq = 100, extra: Partial<Quote> = {}): Quote => ({
  t,
  bid,
  ask,
  bq,
  aq,
  b5: bq,
  a5: aq,
  tbq: 1000,
  tsq: 1000,
  ...extra,
});

/** Snapshots every 3 s from 10:00:00 with the given bids (ask = bid + 0.10). */
const every3s = (bids: number[], start = at("10:00:00")) => bids.map((b, i) => quote(start + i * 3000, b, Math.round((b + 0.1) * 100) / 100));

describe("session clock", () => {
  it("knows the IST date and the 09:15-15:30 weekday session", () => {
    expect(istDay(at("00:10:00"))).toBe("2026-01-05");
    expect(inSession(at("09:14:59"))).toBe(false);
    expect(inSession(at("09:15:00"))).toBe(true);
    expect(inSession(at("15:30:00"))).toBe(true);
    expect(inSession(at("15:30:01"))).toBe(false);
    expect(inSession(at("11:00:00", "2026-01-10"))).toBe(false); // Saturday
  });
});

describe("one snapshot", () => {
  const sample: DepthSample = {
    t: at("10:00:00"),
    s: "TEST",
    ltp: 100,
    vol: 5000,
    tbq: 6000,
    tsq: 2000,
    b: [
      [100.0, 300, 4],
      [99.95, 200, 2],
      [99.9, 500, 5],
      [0, 0, 0],
      [0, 0, 0],
    ],
    a: [
      [100.1, 100, 1],
      [100.15, 400, 3],
      [100.2, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
  };
  const q = toQuote(sample) as Quote;

  it("reads best bid/ask and sums the visible levels, ignoring empty ones", () => {
    expect(q).toMatchObject({ bid: 100, ask: 100.1, bq: 300, aq: 100, b5: 1000, a5: 500, tbq: 6000, tsq: 2000 });
  });

  it("mid, spread and microprice", () => {
    expect(mid(q)).toBeCloseTo(100.05, 10);
    expect(spread(q)).toBeCloseTo(0.1, 10);
    // (100 * 100 + 100.1 * 300) / 400 = 100.075: three quarters of the way to the ask, the thin side
    expect(microprice(q)).toBeCloseTo(100.075, 10);
    expect(microprice(quote(0, 100, 100.1, 50, 50))).toBeCloseTo(100.05, 10);
  });

  it("imbalance measures", () => {
    expect(imbalance(300, 100)).toBeCloseTo(0.5, 12);
    expect(imbalanceTop(q)).toBeCloseTo(0.5, 12); // (300-100)/400
    expect(imbalance5(q)).toBeCloseTo(1 / 3, 12); // (1000-500)/1500
    expect(imbalanceTotal(q)).toBeCloseTo(0.5, 12); // (6000-2000)/8000
    expect(imbalance(0, 0)).toBeNaN();
    expect(imbalance(0, 10)).toBe(-1);
  });

  it("microprice sits half a spread times I1 above the mid", () => {
    expect(microprice(q) - mid(q)).toBeCloseTo((spread(q) / 2) * imbalanceTop(q), 10);
  });

  it("rejects one-sided, empty, locked and crossed books", () => {
    expect(toQuote({ ...sample, b: [[0, 0, 0]] })).toBeNull();
    expect(toQuote({ ...sample, a: [] })).toBeNull();
    expect(toQuote({ ...sample, a: [[100.0, 50, 1]] })).toBeNull(); // locked
    expect(toQuote({ ...sample, a: [[99.9, 50, 1]] })).toBeNull(); // crossed
  });

  it("infers the tick size from observed prices", () => {
    expect(gcdPaise([300.05, 300.1, 299.95])).toBe(5);
    expect(gcdPaise([120.37, 120.4])).toBe(1);
    expect(gcdPaise([1500.1, 1500.4], gcdPaise([1499.9]))).toBe(10);
    expect(gcdPaise([])).toBe(0);
  });
});

describe("order-flow imbalance (Cont-Kukanov-Stoikov)", () => {
  const base = quote(0, 100, 100.1, 500, 400);

  it("same prices: change in bid size minus change in ask size", () => {
    expect(ofi(base, quote(1, 100, 100.1, 700, 400))).toBe(200); // buyers added
    expect(ofi(base, quote(1, 100, 100.1, 500, 650))).toBe(-250); // sellers added
    expect(ofi(base, base)).toBe(0);
  });

  it("bid price up: the whole new bid counts as buying", () => {
    // bid term +300 (new queue); ask unchanged -> 0
    expect(ofi(base, quote(1, 100.05, 100.1, 300, 400))).toBe(300);
  });

  it("bid price down: the whole old bid is counted as gone", () => {
    expect(ofi(base, quote(1, 99.95, 100.1, 900, 400))).toBe(-500);
  });

  it("ask price down: new ask is selling pressure; ask price up: old ask was consumed", () => {
    expect(ofi(base, quote(1, 100, 100.05, 500, 250))).toBe(-250);
    expect(ofi(base, quote(1, 100, 100.15, 500, 250))).toBe(400);
  });

  it("price ticks up through the ask: both terms are buying", () => {
    // bid up: +600; ask up: +400 (old ask)
    expect(ofi(base, quote(1, 100.1, 100.2, 600, 100))).toBe(1000);
  });

  it("normalised form stays within [-1, 1]", () => {
    expect(ofiNormalized(base, quote(1, 100.1, 100.2, 600, 100))).toBeCloseTo(1000 / 1600, 12);
    expect(ofiNormalized(base, quote(1, 99.9, 100.0, 1, 5000))).toBeGreaterThanOrEqual(-1);
  });

  it("is undefined for the first snapshot and across a hole", () => {
    const q = every3s([100, 100, 100]);
    q[1] = { ...q[1], bq: 300 };
    q[2] = { ...q[2], t: q[1].t + 30_000 }; // 30 s hole
    const m = measureSeries(q, 3000);
    expect(m.OFI[0]).toBeNaN();
    expect(m.OFI[1]).toBeCloseTo(200 / 600, 12); // bid 100 -> 300 at an unchanged price, over 100+100+300+100
    expect(m.OFI[2]).toBeNaN();
    expect(m.I1[1]).toBeCloseTo(0.5, 12);
  });
});

describe("forward pairing", () => {
  const ts = Array.from({ length: 200 }, (_, i) => at("10:00:00") + i * 3000);

  it("median interval ignores a stall", () => {
    expect(medianInterval([0, 3000, 6000, 9000, 60_000, 63_000])).toBe(3000);
    expect(medianInterval([5])).toBe(0);
  });

  it("picks the nearest later snapshot", () => {
    expect(forwardIndex(ts, 0, 5_000, 3000)).toBe(2); // 6 s is nearer to 5 s than 3 s is
    expect(forwardIndex(ts, 0, 15_000, 3000)).toBe(5);
    expect(forwardIndex(ts, 10, 60_000, 3000)).toBe(30);
    expect(forwardIndex(ts, 0, 300_000, 3000)).toBe(100);
  });

  it("returns -1 when the data ends before the horizon", () => {
    expect(forwardIndex(ts, 195, 60_000, 3000)).toBe(-1);
    expect(forwardIndex(ts, 199, 5_000, 3000)).toBe(-1);
  });

  it("drops a pair that spans a hole longer than 2 x interval", () => {
    const holed = ts.slice(0, 10).concat(ts.slice(10).map((t) => t + 20_000)); // 23 s hole between 9 and 10
    expect(forwardIndex(holed, 5, 60_000, 3000)).toBe(-1); // would land on a real sample, but crosses the hole
    expect(forwardIndex(holed, 9, 5_000, 3000)).toBe(-1); // nothing near +5 s, the next sample is 23 s away
    expect(forwardIndex(holed, 2, 15_000, 3000)).toBe(7); // entirely before the hole
    expect(forwardIndex(holed, 10, 15_000, 3000)).toBe(15); // entirely after it
    // one missed sample (6 s step) is tolerated, it is not more than 2 x interval
    const oneMissed = ts.filter((_, i) => i !== 3);
    expect(forwardIndex(oneMissed, 0, 15_000, 3000)).toBe(4);
  });

  it("never pairs across the session end or into the next day", () => {
    const eod = [at("15:29:54"), at("15:29:57"), at("15:30:00"), at("15:30:03"), at("15:30:06")];
    expect(forwardIndex(eod, 0, 5_000, 3000)).toBe(2);
    expect(forwardIndex(eod, 1, 5_000, 3000)).toBe(-1); // lands at 15:30:03, after the close
    const overnight = [at("15:29:57"), at("15:30:00"), at("09:15:00", "2026-01-06"), at("09:15:03", "2026-01-06")];
    expect(forwardIndex(overnight, 1, 5_000, 3000)).toBe(-1);
    expect(forwardIndex(overnight, 2, 5_000, 3000)).toBe(-1); // only +3 s exists: too far from +5 s to stand in for it
  });

  it("buildObs gives the known forward return and spread-crossing P&L", () => {
    // bid 100.00 -> 100.00 -> 100.20 (ask always +0.10)
    const obs = buildObs(every3s([100, 100, 100.2]), 5, 3000);
    expect(obs.t).toHaveLength(1); // only the first snapshot has a sample ~5 s later
    expect(obs.tExit[0] - obs.t[0]).toBe(6000);
    expect(obs.fwd[0]).toBeCloseTo(0.2 / 100.05, 12); // mid 100.05 -> 100.25
    expect(obs.fwdHs[0]).toBeCloseTo(4, 9); // 0.20 move / 0.05 half-spread
    expect(obs.longNet[0]).toBeCloseTo((100.2 - 100.1) / 100.1, 12); // buy 100.10, sell 100.20
    expect(obs.shortNet[0]).toBeCloseTo((100 - 100.3) / 100, 12); // sell 100.00, buy back 100.30
    expect(obs.x.I1[0]).toBe(0);
  });
});

describe("statistics", () => {
  it("pearson, ranks and spearman", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNaN();
    expect(ranks([10, 30, 20, 30])).toEqual([1, 3.5, 2, 3.5]);
    // monotone but not linear: rank correlation is perfect, linear correlation is not
    expect(spearman([1, 2, 3, 4, 5], [1, 8, 27, 64, 125])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4, 5], [1, 8, 27, 64, 125])).toBeLessThan(0.99);
    // textbook: d = (0,-1,1,0), sum d^2 = 2, rho = 1 - 6*2/(4*15) = 0.8
    expect(spearman([1, 2, 3, 4], [1, 3, 2, 4])).toBeCloseTo(0.8, 12);
  });

  it("t of a correlation, quantile, slope", () => {
    expect(tStatCorr(0.5, 27)).toBeCloseTo(0.5 * Math.sqrt(25 / 0.75), 12);
    expect(tStatCorr(0, 100)).toBe(0);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6, 12);
    expect(olsSlope([0, 1, 2, 3], [1, 3, 5, 7])).toBeCloseTo(2, 12);
  });

  it("mean and t, with and without a cost", () => {
    const r = meanT([0.01, 0.03, 0.02]);
    expect(r.mean).toBeCloseTo(0.02, 12);
    expect(r.sd).toBeCloseTo(0.01, 12);
    expect(r.t).toBeCloseTo(0.02 / (0.01 / Math.sqrt(3)), 9);
    const c = meanT([0.01, 0.03, 0.02], 0.025);
    expect(c.mean).toBeCloseTo(-0.005, 12);
    expect(c.sd).toBeCloseTo(0.01, 12); // a fixed cost shifts the mean, not the spread of outcomes
    expect(c.t).toBeLessThan(0);
    expect(meanT([]).n).toBe(0);
    expect(meanT([0.5]).t).toBeNaN();
  });

  it("hit rate leaves out flat moves and zero imbalance", () => {
    const h = hitRate([0.5, 0.5, -0.5, -0.5, 0.9, 0, NaN], [0.01, -0.01, -0.01, -0.02, 0, 0.01, 0.01]);
    expect(h.n).toBe(4);
    expect(h.hit).toBeCloseTo(0.75, 12);
    expect(h.flatShare).toBeCloseTo(1 / 6, 12);
  });

  it("deciles on a tiny set", () => {
    // 20 rows: imbalance -0.95..0.95, forward move = imbalance * 10 bp, half-spreads = imbalance * 2
    const x = Array.from({ length: 20 }, (_, i) => (i - 9.5) / 10);
    const shuffled = [7, 0, 19, 3, 12, 5, 16, 1, 9, 14, 2, 18, 4, 11, 6, 15, 8, 13, 10, 17].map((i) => x[i]);
    const rows = decileTable(
      shuffled,
      shuffled.map((v) => v * 0.001),
      shuffled.map((v) => v * 2),
    );
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.n === 2)).toBe(true);
    expect(rows[0].x).toBeCloseTo(-0.9, 12); // mean of -0.95 and -0.85
    expect(rows[0].bps).toBeCloseTo(-9, 9);
    expect(rows[0].halfSpreads).toBeCloseTo(-1.8, 12);
    expect(rows[9].x).toBeCloseTo(0.9, 12);
    expect(rows[9].bps).toBeCloseTo(9, 9);
    for (let i = 1; i < 10; i++) expect(rows[i].bps).toBeGreaterThan(rows[i - 1].bps);
  });

  it("non-overlapping selection is per stock and frees up at the exit time", () => {
    const sym = [0, 0, 0, 0, 1, 1];
    const t = [0, 3, 6, 9, 0, 3];
    const tExit = [6, 9, 12, 15, 6, 9];
    expect(nonOverlapping(sym, t, tExit, [0, 1, 2, 3, 4, 5])).toEqual([0, 2, 4]);
    expect(nonOverlapping(sym, t, tExit, [1, 2, 3, 5])).toEqual([1, 3, 5]);
  });
});

describe("tradable test: paying the spread", () => {
  /** 400 snapshots, 3 s apart; each row's own bid qty sets I1, and `move(i)` ticks of 0.05 happen right after row i. */
  function scripted(move: (i: number, i1: number) => number): Quote[] {
    const out: Quote[] = [];
    let bidTicks = 2000; // Rs 100.00
    for (let i = 0; i < 400; i++) {
      const strong = i % 5 === 0; // a tenth of rows strongly bid, a tenth strongly offered
      const up = strong && i % 10 === 0;
      const bq = strong ? (up ? 950 : 50) : 500 + ((i * 37) % 21) - 10; // I1 = +0.9 / -0.9, else about 0
      const aq = 1000 - bq;
      const bid = bidTicks * 0.05;
      out.push(quote(at("10:00:00") + i * 3000, bid, bid + 0.05, bq, aq));
      bidTicks += move(i, (bq - aq) / 1000);
    }
    return out;
  }

  it("a right call that moves less than the spread still loses", () => {
    // After a strong imbalance the price moves ONE tick the predicted way; the spread is one tick.
    const obs = buildObs(
      scripted((_, i1) => (Math.abs(i1) > 0.5 ? Math.sign(i1) : 0)),
      5,
      3000,
    );
    const r = tradableTest(obs, "I1");
    expect(r.n).toBe(80);
    expect(r.nLong).toBe(40);
    expect(r.nShort).toBe(40);
    expect(r.gross.mean).toBeGreaterThan(0); // direction was right every time
    expect(r.gross.mean).toBeCloseTo(0.05 / 100, 4);
    expect(r.net.mean).toBeCloseTo(0, 6); // bought at the ask, sold one tick up at the bid = same price
    expect(r.netSmall.mean).toBeCloseTo(-COST_SMALL, 6);
    expect(r.netLarge.mean).toBeCloseTo(-COST_LARGE, 6);
    expect(r.netSmall.t).toBeLessThan(0);
  });

  it("a move of three ticks leaves two after the spread, and the sign flips if the call is wrong", () => {
    const right = tradableTest(buildObs(scripted((_, i1) => (Math.abs(i1) > 0.5 ? 3 * Math.sign(i1) : 0)), 5, 3000), "I1");
    expect(right.net.mean).toBeCloseTo(0.1 / 100, 4); // two ticks of 0.05 on about Rs 100
    expect(right.net.mean).toBeGreaterThan(0);
    expect(right.net.t).toBeGreaterThan(3);
    expect(right.netLarge.mean).toBeCloseTo(right.net.mean - COST_LARGE, 12);
    expect(right.netSmall.mean).toBeLessThan(0); // 0.10% is still far below the 0.27% charges

    const wrong = tradableTest(buildObs(scripted((_, i1) => (Math.abs(i1) > 0.5 ? -3 * Math.sign(i1) : 0)), 5, 3000), "I1");
    expect(wrong.gross.mean).toBeLessThan(0);
    expect(wrong.net.mean).toBeCloseTo(-0.2 / 100, 4); // three ticks against plus the one-tick spread
  });

  it("takes no trades when the imbalance never varies", () => {
    const flat = every3s(Array.from({ length: 50 }, () => 100));
    expect(tradableTest(buildObs(flat, 5, 3000), "I1").n).toBe(0);
  });

  it("holds one position per stock at a time", () => {
    // Every snapshot is extreme (alternating blocks), so candidates are everywhere; trades must not overlap.
    const q = Array.from({ length: 300 }, (_, i) => quote(at("10:00:00") + i * 3000, 100, 100.05, i % 40 < 20 ? 990 : 10, i % 40 < 20 ? 10 : 990));
    const obs = buildObs(q, 60, 3000);
    const r = tradableTest(obs, "I1");
    expect(r.n).toBeGreaterThan(0);
    expect(r.n).toBeLessThanOrEqual(Math.ceil((300 * 3) / 60));
  });
});

describe("the whole study on synthetic data with a known answer", () => {
  const load = (k: number, seed: number) => {
    const by = new Map<string, Quote[]>();
    for (let s = 0; s < 3; s++) {
      const quotes = syntheticSamples({ symbol: `S${s}`, seed: seed + s, days: 2, k })
        .map(toQuote)
        .filter((q): q is Quote => q !== null);
      by.set(`S${s}`, quotes);
    }
    return by;
  };

  it("recovers a planted edge: right measure, right size, and it does not pay the spread", () => {
    const data = load(0.05, 100);
    const a = analyze(data, { ticks: { S0: 0.05, S1: 0.05, S2: 0.05 } });
    expect(a.intervalMs).toBeGreaterThan(2900);
    expect(a.intervalMs).toBeLessThan(3100);
    expect(a.fullSessions).toBe(2);
    expect(a.enoughData).toBe(true);
    expect(a.symbols[0].medianSpreadTicks).toBeCloseTo(1, 6);
    expect(a.best).toBe("I1");
    expect(a.verdicts[0].predicts).toBe(true);
    expect(a.verdicts[0].paysSpread).toBe(false);
    expect(a.verdicts[0].paysSmall).toBe(false);
    expect(a.pooled.ITot[0].t).toBeLessThan(3); // the whole-book totals were pure noise
    // Planted: expected move over the next 2 steps (the "5 s" horizon lands on +6 s) is
    // 2k(1+phi) ticks = 4k(1+phi) half-spreads per unit of imbalance = 0.38.
    const obs = buildObs(data.get("S0") ?? [], 5, a.intervalMs);
    const slope = olsSlope(obs.x.I1, obs.fwdHs);
    expect(slope).toBeGreaterThan(0.38 * 0.7);
    expect(slope).toBeLessThan(0.38 * 1.3);
    // deciles rise from the sell-heavy end to the buy-heavy end
    expect(a.deciles[0][9].halfSpreads).toBeGreaterThan(0.1);
    expect(a.deciles[0][0].halfSpreads).toBeLessThan(-0.1);
  });

  it("finds nothing when nothing was planted", () => {
    const a = analyze(load(0, 200));
    for (const v of a.verdicts) {
      expect(v.predicts).toBe(false);
      expect(v.paysSpread).toBe(false);
    }
    expect(Math.abs(a.pooled.I1[0].spearman)).toBeLessThan(0.02);
  });

  it("says so when there is too little data", () => {
    const one = new Map<string, Quote[]>([
      [
        "S0",
        syntheticSamples({ days: 1, k: 0.05 })
          .map(toQuote)
          .filter((q): q is Quote => q !== null),
      ],
    ]);
    const a = analyze(one);
    expect(a.fullSessions).toBe(1);
    expect(a.enoughData).toBe(false);
    // half a day is not a full session
    const half = new Map([["S0", (one.get("S0") ?? []).slice(0, 3000)]]);
    expect(analyze(half).fullSessions).toBe(0);
  });

  it("correlationCell uses fewer, non-overlapping rows for its t-statistic", () => {
    const q = syntheticSamples({ days: 1, k: 0.05, seed: 7 })
      .map(toQuote)
      .filter((v): v is Quote => v !== null);
    const c = correlationCell(buildObs(q, 60, 3000), "I1");
    expect(c.n).toBeGreaterThan(7000);
    expect(c.nIndependent).toBeLessThanOrEqual(376); // 22,500 s / 60 s
    expect(c.nIndependent).toBeGreaterThan(350);
  });
});
