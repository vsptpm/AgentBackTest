import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import {
  UpstoxRateLimitError,
  chunkFileName,
  chunkIsFresh,
  clampHistoryRange,
  fetchUpstoxHistory,
  monthChunks,
  type HistoryDeps,
} from "./history";

/** IST wall-clock time as epoch ms. */
const ist = (y: number, m: number, d: number, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm) - 5.5 * 3600_000;
const bar = (time: number, close = 100): Candle => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 1000 });

describe("monthChunks", () => {
  it("covers whole calendar months, oldest first, including a year change and a leap February", () => {
    expect(monthChunks("2023-12-15", "2024-02-10")).toEqual([
      { month: "2023-12", from: "2023-12-01", to: "2023-12-31" },
      { month: "2024-01", from: "2024-01-01", to: "2024-01-31" },
      { month: "2024-02", from: "2024-02-01", to: "2024-02-29" },
    ]);
  });
  it("a range inside one month is that one whole month", () => {
    expect(monthChunks("2025-04-10", "2025-04-12")).toEqual([{ month: "2025-04", from: "2025-04-01", to: "2025-04-30" }]);
  });
  it("a year is 13 chunks when it starts and ends mid-month", () => {
    expect(monthChunks("2025-11-13", "2026-11-13")).toHaveLength(13);
  });
  it("returns nothing for a reversed or malformed range", () => {
    expect(monthChunks("2025-05-01", "2025-04-01")).toEqual([]);
    expect(monthChunks("nope", "2025-04-01")).toEqual([]);
  });
});

describe("clampHistoryRange", () => {
  it("leaves a normal range alone", () => {
    expect(clampHistoryRange("2026-05-13", "2026-11-13", "2026-11-13")).toEqual({ from: "2026-05-13", to: "2026-11-13", warnings: [] });
  });
  it("starts no earlier than January 2022, with a warning", () => {
    const r = clampHistoryRange("2020-06-01", "2023-06-01", "2026-11-13");
    expect(r.from).toBe("2022-01-01");
    expect(r.warnings).toHaveLength(1);
  });
  it("serves at most three years, with a warning", () => {
    const r = clampHistoryRange("2022-03-01", "2026-11-13", "2026-11-13");
    expect(r.from).toBe("2023-11-13");
    expect(r.warnings).toHaveLength(1);
  });
  it("does not ask for the future", () => {
    expect(clampHistoryRange("2026-10-01", "2026-12-31", "2026-11-13").to).toBe("2026-11-13");
  });
  it("rejects a reversed range", () => {
    expect(() => clampHistoryRange("2026-11-10", "2026-11-01", "2026-11-13")).toThrow();
  });
});

describe("chunkIsFresh", () => {
  const oct = { month: "2026-10", from: "2026-10-01", to: "2026-10-31" };
  const nov = { month: "2026-11", from: "2026-11-01", to: "2026-11-30" };
  const now = ist(2026, 11, 13, 14);
  it("a month saved after it ended is kept for good", () => {
    expect(chunkIsFresh(oct, ist(2026, 11, 1, 0, 5), now)).toBe(true);
    expect(chunkIsFresh(oct, ist(2026, 11, 1, 0, 5), ist(2028, 1, 1))).toBe(true);
  });
  it("the current month saved earlier today is reused", () => {
    expect(chunkIsFresh(nov, ist(2026, 11, 13, 9), now)).toBe(true);
  });
  it("the current month saved on an earlier IST day is fetched again", () => {
    expect(chunkIsFresh(nov, ist(2026, 11, 12, 23, 59), now)).toBe(false);
  });
  it("a past month saved while it was still running is incomplete, so it is fetched again", () => {
    expect(chunkIsFresh(oct, ist(2026, 10, 31, 16), now)).toBe(false);
    expect(chunkIsFresh(oct, ist(2026, 10, 20, 16), now)).toBe(false);
  });
});

describe("chunkFileName", () => {
  it("makes the instrument key safe for a file name", () => {
    expect(chunkFileName("NSE_EQ|INE154A01025", 5, "2026-10")).toBe("NSE_EQ_INE154A01025_5_2026-10.json");
  });
});

/** In-memory stand-in for Upstox and the disk. One bar at 10:00 IST on the 5th of each month asked for. */
function fakes(opts: { blockAfter?: number } = {}) {
  const disk = new Map<string, { fetchedAt: number; candles: Candle[] }>();
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  let paced = 0;
  let blocked = 0;
  const deps: HistoryDeps = {
    instrumentKey: async (s) => (s === "ITC.NS" ? "NSE_EQ|INE154A01025" : null),
    fetchRange: async (_k, _m, from, to) => {
      calls.push(`${from}..${to}`);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      if (opts.blockAfter != null && calls.length > opts.blockAfter) {
        blocked = 300_000;
        throw new Error("Upstox is rate limiting this app; waiting it out");
      }
      const [y, m] = from.split("-").map(Number);
      // Newest first, like Upstox, plus a pre-open bar that must be dropped.
      return [bar(ist(y, m, 5, 10, 5)), bar(ist(y, m, 5, 10, 0)), bar(ist(y, m, 5, 8, 0))];
    },
    fetchToday: async () => {
      calls.push("today");
      return [bar(ist(2026, 11, 13, 9, 15)), bar(ist(2026, 11, 13, 9, 20)), bar(ist(2026, 11, 13, 9, 25))];
    },
    readChunk: async (name) => disk.get(name) ?? null,
    writeChunk: async (name, fetchedAt, candles) => void disk.set(name, { fetchedAt, candles }),
    pace: async () => void paced++,
    blockedMs: () => blocked,
    today: new Map(),
  };
  return { deps, disk, calls, paced: () => paced, maxActive: () => maxActive };
}

describe("fetchUpstoxHistory", () => {
  const now = ist(2026, 11, 13, 9, 27);
  const req = { symbol: "ITC.NS", interval: "5m" as const, from: "2026-09-20", to: "2026-11-13" };

  it("downloads each whole month once, then serves the same range from disk", async () => {
    const f = fakes();
    const cold = await fetchUpstoxHistory(req, "t", now, f.deps);
    // Whole months are asked for; the current month stops at yesterday; today is the intraday call.
    expect(f.calls).toEqual(["2026-09-01..2026-09-30", "2026-10-01..2026-10-31", "2026-11-01..2026-11-12", "today"]);
    expect(cold.requests).toBe(4);
    expect(cold.cachedChunks).toBe(0);
    expect(f.paced()).toBe(4);

    const warm = await fetchUpstoxHistory(req, "t", now + 1000, f.deps);
    expect(warm.requests).toBe(0);
    expect(warm.cachedChunks).toBe(3);
    expect(f.calls).toHaveLength(4);
    expect(warm.candles).toEqual(cold.candles);
  });

  it("returns session bars inside the range, oldest first, without the bar still forming", async () => {
    const f = fakes();
    const { candles } = await fetchUpstoxHistory(req, "t", now, f.deps);
    expect(candles.map((c) => c.time)).toEqual([
      // 5 September is before `from`, so only October, November and today's two finished bars remain.
      ist(2026, 10, 5, 10, 0),
      ist(2026, 10, 5, 10, 5),
      ist(2026, 11, 5, 10, 0),
      ist(2026, 11, 5, 10, 5),
      ist(2026, 11, 13, 9, 15),
      ist(2026, 11, 13, 9, 20),
    ]);
  });

  it("a later, wider request reuses the months already saved", async () => {
    const f = fakes();
    await fetchUpstoxHistory({ ...req, from: "2026-10-10", to: "2026-10-12" }, "t", now, f.deps);
    expect(f.calls).toEqual(["2026-10-01..2026-10-31"]);
    const wider = await fetchUpstoxHistory({ ...req, from: "2026-09-01", to: "2026-10-31" }, "t", now, f.deps);
    expect(wider.requests).toBe(1);
    expect(wider.cachedChunks).toBe(1);
  });

  it("fetches the current month again on the next IST day, but not finished months", async () => {
    const f = fakes();
    await fetchUpstoxHistory(req, "t", now, f.deps);
    const next = await fetchUpstoxHistory({ ...req, to: "2026-11-14" }, "t", now + 24 * 3600_000, f.deps);
    expect(f.calls.slice(4)).toEqual(["2026-11-01..2026-11-13", "today"]);
    expect(next.cachedChunks).toBe(2);
  });

  it("never runs two downloads at once, even for simultaneous callers", async () => {
    const f = fakes();
    await Promise.all([
      fetchUpstoxHistory({ ...req, to: "2026-11-12" }, "t", now, f.deps),
      fetchUpstoxHistory({ ...req, to: "2026-11-12" }, "t", now, f.deps),
    ]);
    expect(f.maxActive()).toBe(1);
    // The second caller finds each month saved by the first.
    expect(f.calls).toHaveLength(3);
  });

  it("stops at the first lock-out with a clear message and keeps what it already saved", async () => {
    const f = fakes({ blockAfter: 1 });
    const err = await fetchUpstoxHistory(req, "t", now, f.deps).catch((e) => e);
    expect(err).toBeInstanceOf(UpstoxRateLimitError);
    expect((err as Error).message).toBe("Upstox is rate limiting; try again in 5 minutes");
    expect(f.calls).toHaveLength(2);
    expect(f.disk.size).toBe(1);
    // While locked out nothing more is sent.
    await expect(fetchUpstoxHistory(req, "t", now, f.deps)).rejects.toBeInstanceOf(UpstoxRateLimitError);
    expect(f.calls).toHaveLength(2);
  });

  it("rejects a symbol Upstox does not list", async () => {
    await expect(fetchUpstoxHistory({ ...req, symbol: "NOPE.NS" }, "t", now, fakes().deps)).rejects.toThrow(/not in the Upstox/);
  });
});
