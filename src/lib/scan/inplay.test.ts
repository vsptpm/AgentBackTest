import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { isAffordable, MIN_PRICE, MIN_SHARES, measureInPlay, pickInPlay, rankInPlay, type InPlay } from "./inplay";

// IST wall-clock time on 2024-01-(day) as epoch ms.
const at = (day: number, hh: number, mm: number) => Date.UTC(2024, 0, day, hh, mm) - 5.5 * 3600_000;
const bar = (time: number, close: number, volume: number): Candle => ({ time, open: close, high: close, low: close, close, volume });

/** Three bars a day (09:15, 09:20, 09:25) at a flat price with the given per-bar volume. */
const day = (d: number, close: number, vol: number, bars = 3) =>
  [0, 5, 10].slice(0, bars).map((m) => bar(at(d, 9, 15 + m), close, vol));

const history = [...day(15, 100, 1000), ...day(16, 100, 1000), ...day(17, 100, 1000)];

describe("measureInPlay", () => {
  it("computes % change from the previous close and volume against the same time of day", () => {
    // Today: only two bars so far, each with 3x the usual volume, price up 2%.
    const m = measureInPlay("A", [...history, ...day(18, 102, 3000, 2)], "2024-01-18");
    expect(m?.changePct).toBeCloseTo(2);
    expect(m?.price).toBe(102);
    expect(m?.relVol).toBeCloseTo(3); // 6000 so far vs the usual 2000 by 09:20, not vs a full day
    expect(m?.score).toBeCloseTo(6);
  });
  it("ranks a falling stock by the size of the move", () => {
    const m = measureInPlay("A", [...history, ...day(18, 97, 1000)], "2024-01-18");
    expect(m?.changePct).toBeCloseTo(-3);
    expect(m?.score).toBeCloseTo(3);
  });
  it("caps freak volume and treats unknown volume as normal", () => {
    expect(measureInPlay("A", [...history, ...day(18, 101, 100_000)], "2024-01-18")?.score).toBeCloseTo(5);
    const thin = measureInPlay("A", [...day(17, 100, 1000), ...day(18, 101, 9000)], "2024-01-18"); // 1 earlier day only
    expect(thin?.relVol).toBeNaN();
    expect(thin?.score).toBeCloseTo(1);
  });
  it("ignores stale data and stocks with no previous day", () => {
    expect(measureInPlay("A", history, "2024-01-18")).toBeNull();
    expect(measureInPlay("A", day(18, 100, 1000), "2024-01-18")).toBeNull();
    expect(measureInPlay("A", [], "2024-01-18")).toBeNull();
  });
});

describe("rankInPlay / pickInPlay", () => {
  const data = {
    QUIET: [...history, ...day(18, 100.1, 1000)],
    MOVER: [...history, ...day(18, 103, 4000)],
    FALLER: [...history, ...day(18, 98, 2000)],
  };
  const ranked = rankInPlay(data, "2024-01-18");
  it("puts the stock with the biggest move on heavy volume first", () => {
    expect(ranked.map((r) => r.symbol)).toEqual(["MOVER", "FALLER", "QUIET"]);
  });
  it("takes the top N and keeps stocks you are already in", () => {
    const big = { top: 1, capital: 100_000, leverage: 1 };
    expect(pickInPlay(ranked, big).picks.map((r) => r.symbol)).toEqual(["MOVER"]);
    expect(pickInPlay(ranked, { ...big, keep: ["QUIET", "UNKNOWN"] }).picks.map((r) => r.symbol)).toEqual(["MOVER", "QUIET"]);
  });
});

describe("pickInPlay: what a small account can trade", () => {
  const s = (symbol: string, price: number, changePct: number, relVol = 1): InPlay => ({
    symbol,
    price,
    changePct,
    relVol,
    score: Math.abs(changePct) * Math.min(relVol, 5),
  });
  const byScore = (list: InPlay[]) => [...list].sort((a, b) => b.score - a.score);
  const names = (list: InPlay[]) => list.map((p) => p.symbol);
  const pool = byScore([
    s("DEAR", 3000, 4, 3), // most in play, but out of reach even with 5x
    s("MID", 1200, 3, 2), // only with margin
    s("A", 480, 2.5),
    s("B", 300, -2),
    s("C", 150, 1.5),
    s("D", 90, 1.2),
    s("E", 60, -1.1),
    s("VOL", 200, 0.2, 2.5), // small move, heavy volume
    s("QUIET", 100, 0.3),
    s("PENNY", 12, -5, 3),
  ]);

  it("needs two shares and a price that is not penny-like", () => {
    expect(MIN_SHARES).toBe(2);
    expect(isAffordable(500, 1000, 1)).toBe(true);
    expect(isAffordable(500.05, 1000, 1)).toBe(false);
    expect(isAffordable(2500, 1000, 5)).toBe(true);
    expect(isAffordable(MIN_PRICE - 0.05, 1000, 1)).toBe(false);
  });

  it("with Rs 1,000 and no margin only picks stocks up to Rs 500", () => {
    const r = pickInPlay(pool, { top: 12, capital: 1000, leverage: 1 });
    expect(r.maxPrice).toBe(500);
    expect(r.affordableCount).toBe(7); // A B C D E VOL QUIET
    expect(r.movementRelaxed).toBe(false);
    expect(names(r.picks)).toEqual(["A", "B", "C", "D", "E", "VOL"]); // QUIET fails the movement floor
    for (const p of r.picks) expect(Math.floor(1000 / p.price)).toBeGreaterThanOrEqual(MIN_SHARES);
  });

  it("with 5x margin reaches stocks up to Rs 2,500", () => {
    const r = pickInPlay(pool, { top: 12, capital: 1000, leverage: 5 });
    expect(r.maxPrice).toBe(2500);
    expect(r.affordableCount).toBe(8);
    expect(names(r.picks)).toEqual(["MID", "A", "B", "C", "D", "E", "VOL"]);
    expect(names(pickInPlay(pool, { top: 2, capital: 1000, leverage: 5 }).picks)).toEqual(["MID", "A"]);
  });

  it("lets quiet stocks in when fewer than five are moving, but never unaffordable ones", () => {
    const calm = byScore([s("DEAR", 3000, 4, 3), s("A", 480, 2.5), s("B", 300, 0.4), s("C", 150, 0.6), s("PENNY", 12, -5, 3)]);
    const r = pickInPlay(calm, { top: 12, capital: 1000, leverage: 1 });
    expect(r.movementRelaxed).toBe(true);
    expect(names(r.picks)).toEqual(["A", "C", "B"]);
    // Nothing quieter to let in: not reported as relaxed.
    expect(pickInPlay([s("A", 480, 2.5)], { top: 12, capital: 1000, leverage: 1 }).movementRelaxed).toBe(false);
  });

  it("keeps a signal stock only while affordable, and a stock you hold always", () => {
    const base = { top: 2, capital: 1000, leverage: 1 };
    expect(names(pickInPlay(pool, { ...base, keep: ["QUIET", "DEAR"] }).picks)).toEqual(["A", "B", "QUIET"]);
    expect(names(pickInPlay(pool, { ...base, keep: ["DEAR"], held: ["DEAR"] }).picks)).toEqual(["A", "B", "DEAR"]);
    expect(names(pickInPlay(pool, { ...base, held: ["A", "NOPE"] }).picks)).toEqual(["A", "B"]);
  });
});

describe("ranking from live quotes", () => {
  it("expects little volume early and all of it by the close", async () => {
    const { expectedVolumeFraction } = await import("./inplay");
    expect(expectedVolumeFraction(9 * 60)).toBe(0);
    expect(expectedVolumeFraction(9 * 60 + 30)).toBeCloseTo(0.1);
    expect(expectedVolumeFraction(10 * 60 + 30)).toBeCloseTo(0.275);
    expect(expectedVolumeFraction(16 * 60)).toBe(1);
  });
  it("measures move and volume against the usual volume by this time of day", async () => {
    const { measureFromQuote } = await import("./inplay");
    // 10:00 -> 20% of a normal day expected. 600k traded vs 200k expected = 3x.
    const m = measureFromQuote("A", { last: 102, prevClose: 100, volume: 600_000 }, 1_000_000, 10 * 60);
    expect(m?.changePct).toBeCloseTo(2);
    expect(m?.relVol).toBeCloseTo(3);
    expect(m?.score).toBeCloseTo(6);
  });
  it("ranks on the move alone while average volume is still unknown", async () => {
    const { measureFromQuote } = await import("./inplay");
    const m = measureFromQuote("A", { last: 97, prevClose: 100, volume: 5 }, undefined, 10 * 60);
    expect(m?.relVol).toBeNaN();
    expect(m?.score).toBeCloseTo(3);
    expect(measureFromQuote("A", { last: 0, prevClose: 100, volume: 5 }, 1, 600)).toBeNull();
  });
});
