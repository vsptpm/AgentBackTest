import { describe, expect, it } from "vitest";
import type { Trade } from "@/lib/types";
import { IST_OFFSET_MS } from "@/lib/types";
import { computeIntradayStats } from "./intraday";

/** Epoch ms for an IST wall-clock time. */
function istMs(y: number, m: number, d: number, hh = 0, mm = 0): number {
  return Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MS;
}

let nextId = 1;
function trade(entry: number, exit: number, netPnl: number, over: Partial<Trade> = {}): Trade {
  return {
    id: nextId++,
    side: "long",
    entryTime: entry,
    entryPrice: 100,
    exitTime: exit,
    exitPrice: 101,
    qty: 1,
    grossPnl: netPnl,
    costs: 0,
    netPnl,
    rMultiple: NaN,
    exitReason: "signal",
    barsHeld: 1,
    mae: 0,
    mfe: 0,
    ...over,
  };
}

describe("computeIntradayStats", () => {
  it("returns zeros and empty arrays for no trades", () => {
    const s = computeIntradayStats([], 100000);
    expect(s.days).toEqual([]);
    expect(s.tradingDays).toBe(0);
    expect(s.winDayRate).toBe(0);
    expect(s.avgDayPnl).toBe(0);
    expect(s.bestDay).toBeNull();
    expect(s.worstDay).toBeNull();
    expect(s.maxConsecutiveLossDays).toBe(0);
    expect(s.avgTradesPerDay).toBe(0);
    expect(s.maxTradesInDay).toBe(0);
    expect(s.worstDayPctOfCapital).toBe(0);
    expect(s.byExitReason).toEqual([]);
    expect(s.byHour.map((h) => h.hour)).toEqual([9, 10, 11, 12, 13, 14, 15]);
    expect(s.byHour.every((h) => h.trades === 0 && h.pnl === 0 && h.winRate === 0)).toBe(true);
    expect(s.byWeekday.map((w) => w.weekday)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
    expect(s.bySide.long).toEqual({ trades: 0, winRate: 0, pnl: 0 });
    expect(s.bySide.short).toEqual({ trades: 0, winRate: 0, pnl: 0 });
  });

  it("groups days by IST date of the exit, across the IST midnight boundary", () => {
    // 2024-01-02 00:10 IST is still 2024-01-01 in UTC; 2024-01-01 23:50 IST is the previous IST day.
    const beforeMidnight = istMs(2024, 1, 1, 23, 50);
    const afterMidnight = istMs(2024, 1, 2, 0, 10);
    expect(new Date(afterMidnight).toISOString().slice(0, 10)).toBe("2024-01-01");

    const s = computeIntradayStats(
      [
        trade(afterMidnight, afterMidnight, -50),
        trade(beforeMidnight, beforeMidnight, 100),
        // entered on the 1st, exited on the 2nd: counts for the exit day
        trade(istMs(2024, 1, 1, 15, 0), istMs(2024, 1, 2, 9, 20), -25),
      ],
      100000,
    );
    expect(s.days).toEqual([
      { day: "2024-01-01", pnl: 100, trades: 1 },
      { day: "2024-01-02", pnl: -75, trades: 2 },
    ]);
    expect(s.tradingDays).toBe(2);
    expect(s.winDays).toBe(1);
    expect(s.lossDays).toBe(1);
    expect(s.winDayRate).toBe(0.5);
    expect(s.avgDayPnl).toBe(12.5);
    expect(s.bestDay).toEqual({ day: "2024-01-01", pnl: 100 });
    expect(s.worstDay).toEqual({ day: "2024-01-02", pnl: -75 });
    expect(s.worstDayPctOfCapital).toBeCloseTo(-0.075);
    expect(s.avgTradesPerDay).toBe(1.5);
    expect(s.maxTradesInDay).toBe(2);
  });

  it("buckets by IST hour of entry with win rate, pnl and avgR over finite R only", () => {
    const d = (hh: number, mm: number) => istMs(2024, 1, 3, hh, mm); // a Wednesday
    const s = computeIntradayStats(
      [
        trade(d(9, 15), d(9, 45), 200, { rMultiple: 2 }),
        trade(d(9, 55), d(10, 30), -100, { rMultiple: -1 }),
        trade(d(9, 59), d(10, 5), 50), // no stop: NaN R is ignored
        trade(d(10, 0), d(11, 0), -40, { rMultiple: -0.5, side: "short", exitReason: "stop" }),
        trade(d(15, 10), d(15, 20), 0, { exitReason: "squareoff" }),
      ],
      100000,
    );
    const h = (hour: number) => s.byHour.find((b) => b.hour === hour)!;
    expect(h(9)).toMatchObject({ label: "09:15–10:00", trades: 3, wins: 2, pnl: 150, avgR: 0.5 });
    expect(h(9).winRate).toBeCloseTo(2 / 3);
    expect(h(10)).toMatchObject({ trades: 1, wins: 0, winRate: 0, pnl: -40, avgR: -0.5 });
    expect(h(11).trades).toBe(0);
    expect(h(15)).toMatchObject({ label: "15:00–15:30", trades: 1, wins: 0, pnl: 0 });
    expect(Number.isNaN(h(15).avgR)).toBe(true);

    expect(s.byWeekday.find((w) => w.weekday === "Wed")).toMatchObject({ trades: 5, pnl: 110 });
    expect(s.byWeekday.find((w) => w.weekday === "Mon")!.trades).toBe(0);
    expect(s.byExitReason[0]).toMatchObject({ reason: "signal", trades: 3, pnl: 150 });
    expect(s.byExitReason.find((r) => r.reason === "stop")).toMatchObject({ trades: 1, winRate: 0, pnl: -40 });
    expect(s.bySide.long).toMatchObject({ trades: 4, winRate: 0.5, pnl: 150 });
    expect(s.bySide.short).toMatchObject({ trades: 1, winRate: 0, pnl: -40 });
  });

  it("counts the longest run of consecutive losing days", () => {
    const day = (dd: number, pnl: number) => trade(istMs(2024, 1, dd, 10, 0), istMs(2024, 1, dd, 11, 0), pnl);
    const s = computeIntradayStats([day(1, -10), day(2, 20), day(3, -5), day(4, -5), day(5, -1), day(8, 30)], 100000);
    expect(s.maxConsecutiveLossDays).toBe(3);
    expect(s.lossDays).toBe(4);
  });
});
