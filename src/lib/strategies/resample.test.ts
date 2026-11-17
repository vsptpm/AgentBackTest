import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { resample } from "./resample";
import { istMinutes, SESSION_OPEN_MIN } from "./helpers";

const IST = 5.5 * 60 * 60 * 1000;

/** Build 5m candles for N sessions starting on an IST date, 09:15..15:25 (75 bars/day). */
function session5m(dateIso: string, base: number): Candle[] {
  const dayStartUtc = Date.parse(`${dateIso}T00:00:00Z`) - IST; // IST midnight in UTC ms
  const out: Candle[] = [];
  for (let k = 0; k < 75; k++) {
    const time = dayStartUtc + (SESSION_OPEN_MIN + k * 5) * 60_000;
    const o = base + k;
    out.push({ time, open: o, high: o + 2, low: o - 1, close: o + 1, volume: 10 });
  }
  return out;
}

describe("resample", () => {
  const ltf = [...session5m("2026-10-27", 100), ...session5m("2026-10-28", 200)];

  it("builds 1h buckets anchored at 09:15 with a 15:15 stub, per day", () => {
    const { htf } = resample(ltf, "1h");
    // 09:15,10:15,11:15,12:15,13:15,14:15,15:15 = 7 per day
    expect(htf.length).toBe(14);
    expect(istMinutes(htf[0].time)).toBe(SESSION_OPEN_MIN);
    expect(istMinutes(htf[1].time)).toBe(SESSION_OPEN_MIN + 60);
    expect(istMinutes(htf[6].time)).toBe(SESSION_OPEN_MIN + 360);
    // First 1h bar aggregates 12 five-minute bars: open of first, close of 12th, high/low across.
    expect(htf[0].open).toBe(100);
    expect(htf[0].close).toBe(100 + 11 + 1);
    expect(htf[0].high).toBe(100 + 11 + 2);
    expect(htf[0].low).toBe(99);
    expect(htf[0].volume).toBe(120);
    // Stub bar holds 3 bars (15:15, 15:20, 15:25).
    expect(htf[6].volume).toBe(30);
  });

  it("4h gives two buckets per day: 09:15 and 13:15", () => {
    const { htf } = resample(ltf, "4h");
    expect(htf.length).toBe(4);
    expect(istMinutes(htf[1].time)).toBe(SESSION_OPEN_MIN + 240);
    expect(htf[0].volume).toBe(48 * 10);
    expect(htf[1].volume).toBe(27 * 10);
  });

  it("1d gives one bucket per IST day", () => {
    const { htf } = resample(ltf, "1d");
    expect(htf.length).toBe(2);
    expect(htf[0].volume).toBe(750);
  });

  it("completedAt never points at the bucket still in progress (no lookahead)", () => {
    const { htf, htfEnd, completedAt } = resample(ltf, "1h");
    for (let i = 0; i < ltf.length; i++) {
      const j = completedAt[i];
      if (j >= 0) {
        // The referenced HTF bar ended at or before this LTF bar opened...
        expect(htfEnd[j]).toBeLessThanOrEqual(ltf[i].time);
        // ...and the next HTF bar (if any) had not ended yet.
        if (j + 1 < htf.length) expect(htfEnd[j + 1]).toBeGreaterThan(ltf[i].time);
      }
    }
    // Bars inside the first hour have no completed HTF bar.
    expect(completedAt[0]).toBe(-1);
    expect(completedAt[11]).toBe(-1);
    // 10:15 bar is the first to see the 09:15 hour as closed.
    expect(completedAt[12]).toBe(0);
    // First bar of day 2 sees all 7 of day 1's bars closed.
    expect(completedAt[75]).toBe(6);
  });
});
