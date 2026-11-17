import { describe, expect, it } from "vitest";
import { parseUpstoxCandles, tokenExpiry } from "./upstox";

// IST wall-clock time on 2024-01-(day) as epoch ms.
const ist = (day: number, hh: number, mm = 0) => Date.UTC(2024, 0, day, hh, mm) - 5.5 * 3600_000;

describe("tokenExpiry", () => {
  it("a token from the evening expires at 03:30 IST the next morning", () => {
    expect(tokenExpiry(ist(16, 20))).toBe(ist(17, 3, 30));
  });
  it("a token from the trading day expires at 03:30 IST the next morning", () => {
    expect(tokenExpiry(ist(16, 9, 15))).toBe(ist(17, 3, 30));
  });
  it("a token made after midnight but before 03:30 expires the same morning", () => {
    expect(tokenExpiry(ist(16, 1))).toBe(ist(16, 3, 30));
  });
});

describe("parseUpstoxCandles", () => {
  it("reads [time, o, h, l, c, volume, oi] rows and converts IST timestamps to epoch ms", () => {
    const out = parseUpstoxCandles([
      ["2024-01-16T09:20:00+05:30", 101, 102, 100, 101.5, 5000, 0],
      ["2024-01-16T09:15:00+05:30", 100, 101, 99, 101, 9000, 0],
    ]);
    expect(out).toEqual([
      { time: ist(16, 9, 20), open: 101, high: 102, low: 100, close: 101.5, volume: 5000 },
      { time: ist(16, 9, 15), open: 100, high: 101, low: 99, close: 101, volume: 9000 },
    ]);
  });
  it("skips malformed rows and tolerates a missing volume", () => {
    const out = parseUpstoxCandles([["bad-date", 1, 2, 0, 1, 10], ["2024-01-16T09:15:00+05:30", 1, null, 0, 1, 10], ["2024-01-16T09:15:00+05:30", 1, 2, 0, 1], "x"]);
    expect(out).toHaveLength(1);
    expect(out[0].volume).toBe(0);
  });
  it("returns nothing for a non-array", () => {
    expect(parseUpstoxCandles(undefined)).toEqual([]);
  });
});
