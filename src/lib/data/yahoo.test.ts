import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { IST_OFFSET_MS } from "@/lib/types";
import {
  buildYahooUrl,
  dropOffGridBars,
  filterSession,
  istDateKey,
  istTimeKey,
  normalizeCandles,
  parseYahooChart,
  resolveRange,
  sanitizeSymbol,
  toIST,
} from "./yahoo";

/** Epoch ms for a given IST wall-clock time. */
function ist(y: number, m: number, d: number, hh: number, mm: number): number {
  return Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MS;
}

function bar(time: number): Candle {
  return { time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
}

describe("toIST / istDateKey", () => {
  it("shifts the instant by +5:30 so UTC getters read IST", () => {
    const t = Date.UTC(2024, 0, 15, 3, 45); // 03:45 UTC = 09:15 IST
    const d = toIST(t);
    expect(d.getUTCHours()).toBe(9);
    expect(d.getUTCMinutes()).toBe(15);
    expect(istTimeKey(t)).toBe("09:15");
  });

  it("rolls the date forward across IST midnight", () => {
    // 2024-03-31 20:00 UTC = 2024-04-01 01:30 IST
    const t = Date.UTC(2024, 2, 31, 20, 0);
    expect(istDateKey(t)).toBe("2024-04-01");
    expect(istDateKey(Date.UTC(2024, 2, 31, 18, 29))).toBe("2024-03-31"); // 23:59 IST
    expect(istDateKey(Date.UTC(2024, 2, 31, 18, 30))).toBe("2024-04-01"); // 00:00 IST
  });
});

describe("filterSession", () => {
  const candles = [
    bar(ist(2024, 1, 15, 9, 0)), // pre-open, dropped
    bar(ist(2024, 1, 15, 9, 14)), // dropped
    bar(ist(2024, 1, 15, 9, 15)), // kept (open)
    bar(ist(2024, 1, 15, 12, 30)), // kept
    bar(ist(2024, 1, 15, 15, 15)), // kept (last 15m bar)
    bar(ist(2024, 1, 15, 15, 30)), // kept (closing print)
    bar(ist(2024, 1, 15, 15, 31)), // dropped
    bar(ist(2024, 1, 15, 16, 0)), // dropped
  ];

  it("keeps only 09:15-15:30 IST bars for intraday intervals", () => {
    const kept15 = filterSession(candles, "15m").map((c) => istTimeKey(c.time));
    expect(kept15).toEqual(["09:15", "12:30", "15:15", "15:30"]);
    expect(filterSession(candles, "5m")).toHaveLength(4);
  });

  it("leaves daily data untouched", () => {
    expect(filterSession(candles, "1d")).toBe(candles);
  });
});

describe("dropOffGridBars", () => {
  const candles = [
    bar(ist(2024, 1, 15, 9, 15)),
    bar(ist(2024, 1, 15, 9, 30)),
    bar(ist(2024, 1, 15, 13, 55)), // live partial bar stamped with clock time
    bar(ist(2024, 1, 15, 15, 15)),
  ];

  it("removes bars that are not on the interval grid from 09:15", () => {
    expect(dropOffGridBars(candles, "15m").map((c) => istTimeKey(c.time))).toEqual(["09:15", "09:30", "15:15"]);
    // 13:55 is on the 5-minute grid, so it survives a 5m filter.
    expect(dropOffGridBars(candles, "5m").map((c) => istTimeKey(c.time))).toEqual(["09:15", "09:30", "13:55", "15:15"]);
    expect(dropOffGridBars([bar(ist(2024, 1, 15, 9, 20))], "5m")).toHaveLength(1);
    expect(dropOffGridBars([bar(ist(2024, 1, 15, 9, 20))], "15m")).toHaveLength(0);
  });

  it("leaves daily data untouched", () => {
    expect(dropOffGridBars(candles, "1d")).toBe(candles);
  });
});

describe("normalizeCandles", () => {
  it("sorts ascending and de-dupes by time", () => {
    const out = normalizeCandles([bar(300), bar(100), bar(200), bar(100)]);
    expect(out.map((c) => c.time)).toEqual([100, 200, 300]);
  });
});

describe("resolveRange", () => {
  const now = Date.UTC(2024, 5, 30, 10, 0); // 2024-06-30

  it("does not clamp daily data and treats to as end of IST day", () => {
    const r = resolveRange({ symbol: "^NSEI", interval: "1d", from: "2020-01-01", to: "2024-06-28" }, now);
    expect(r.warnings).toEqual([]);
    expect(r.from).toBe("2020-01-01");
    expect(r.period1 * 1000).toBe(ist(2020, 1, 1, 0, 0));
    // end of 2024-06-28 IST = 2024-06-28 23:59:59 IST
    expect((r.period2 + 1) * 1000).toBe(ist(2024, 6, 29, 0, 0));
  });

  it("clamps intraday ranges to ~60 days with a warning", () => {
    const r = resolveRange({ symbol: "RELIANCE.NS", interval: "15m", from: "2024-01-01", to: "2024-06-28" }, now);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/15m data for ~60 days only; range clamped to \d{4}-\d{2}-\d{2}/);
    expect(r.from > "2024-04-20").toBe(true);
    expect(r.from < "2024-05-10").toBe(true);
  });

  it("does not clamp a recent intraday range", () => {
    const r = resolveRange({ symbol: "RELIANCE.NS", interval: "5m", from: "2024-06-20", to: "2024-06-28" }, now);
    expect(r.warnings).toEqual([]);
    expect(r.from).toBe("2024-06-20");
  });

  it("rejects bad dates and inverted ranges", () => {
    expect(() => resolveRange({ symbol: "X", interval: "1d", from: "2024/01/01", to: "2024-02-01" }, now)).toThrow(
      /Invalid from date/,
    );
    expect(() => resolveRange({ symbol: "X", interval: "1d", from: "2024-03-01", to: "2024-02-01" }, now)).toThrow(
      /after/,
    );
  });
});

describe("buildYahooUrl / sanitizeSymbol", () => {
  it("URL-encodes ^ and &", () => {
    const u = buildYahooUrl("M&M.NS", "1d", 1, 2);
    expect(u).toContain("/chart/M%26M.NS?");
    expect(u).toContain("interval=1d");
    expect(buildYahooUrl("^NSEI", "15m", 1, 2)).toContain("/chart/%5ENSEI?");
  });

  it("sanitizes symbols for cache file names", () => {
    expect(sanitizeSymbol("^NSEI")).toBe("_NSEI");
    expect(sanitizeSymbol("RELIANCE.NS")).toBe("RELIANCE_NS");
    expect(sanitizeSymbol("M&M.NS")).toBe("M_M_NS");
  });
});

describe("parseYahooChart", () => {
  it("converts to ms, skips null OHLC rows, and defaults volume to 0", () => {
    const json = {
      chart: {
        result: [
          {
            timestamp: [1700000000, 1700000060, 1700000120],
            indicators: {
              quote: [
                {
                  open: [1, null, 3],
                  high: [2, 2, 4],
                  low: [0.5, 0.5, 2.5],
                  close: [1.5, 1.5, 3.5],
                  volume: [10, 20, null],
                },
              ],
            },
          },
        ],
        error: null,
      },
    };
    const out = parseYahooChart(json, "TEST");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ time: 1700000000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
    expect(out[1].volume).toBe(0);
  });

  it("surfaces Yahoo errors with the symbol", () => {
    const json = { chart: { result: null, error: { code: "Not Found", description: "No data found" } } };
    expect(() => parseYahooChart(json, "BAD.NS")).toThrow(/BAD\.NS.*No data found/);
  });
});
