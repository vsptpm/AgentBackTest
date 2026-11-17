import { describe, expect, it } from "vitest";
import { DEFAULT_COSTS, type Candle } from "@/lib/types";
import { computeTradeCosts } from "@/lib/backtest";
import {
  accountStatus,
  entryFill,
  inEntryWindow,
  marginFor,
  movedSinceSignal,
  rejectReason,
  settleTrade,
  stoppedOutMinutesAgo,
  summarise,
  tradeNumbers,
  type PaperRequest,
  type PaperTrade,
} from "./settle";

// IST wall-clock time on 2024-01-(day) as epoch ms. 15 Jan 2024 is a Monday.
const at = (hh: number, mm: number, day = 15) => Date.UTC(2024, 0, day, hh, mm) - 5.5 * 3600_000;
const bar = (time: number, o: number, h: number, l: number, c: number): Candle => ({ time, open: o, high: h, low: l, close: c, volume: 1 });

const trade = (over: Partial<PaperTrade> = {}): PaperTrade => ({
  id: "t1",
  placedAt: at(10, 0),
  symbol: "RELIANCE.NS",
  strategyName: "ORB",
  side: "long",
  qty: 10,
  entryPrice: 100,
  stop: 98,
  target: 104,
  status: "open",
  upstox: { connected: false },
  ...over,
});

/** A trade in another stock, already finished today. */
const done = (netPnl: number, exitTime: number, over: Partial<PaperTrade> = {}): PaperTrade =>
  trade({ id: `d${exitTime}`, symbol: "TCS.NS", placedAt: exitTime - 10 * 60_000, status: "closed", exitTime, exitPrice: 100, exitReason: "manual", netPnl, ...over });

const req = (over: Partial<PaperRequest> = {}): PaperRequest => ({
  symbol: "RELIANCE.NS",
  strategyName: "ORB",
  side: "long",
  qty: 10,
  entryPrice: 100,
  stop: 98,
  amount: 100_000,
  maxRisk: 0.01,
  ...over,
});

const now = at(11, 0);

describe("rejectReason", () => {
  it("accepts a trade that fits money and risk", () => {
    expect(rejectReason(req(), [], now)).toBeNull();
  });
  it("rejects when the free money is not enough", () => {
    const open = [trade({ symbol: "TCS.NS", qty: 995, entryPrice: 100 })]; // 99,500 in use
    expect(rejectReason(req(), open, now)).toMatch(/Not enough money/);
  });
  it("rejects when the loss at the stop exceeds the risk limit", () => {
    expect(rejectReason(req({ qty: 600 }), [], now)).toMatch(/Too risky/); // 1,200 > 1,000
  });
  it("rejects missing stop, indices and duplicates", () => {
    expect(rejectReason(req({ stop: undefined }), [], now)).toMatch(/no stop loss/);
    expect(rejectReason(req({ symbol: "^NSEI" }), [], now)).toMatch(/index/i);
    expect(rejectReason(req(), [trade()], now)).toMatch(/already/);
  });

  it("only takes new trades between 09:30 and 14:45 IST on weekdays", () => {
    const msg = "New trades are only taken between 09:30 and 14:45.";
    expect(rejectReason(req(), [], at(9, 29))).toBe(msg);
    expect(rejectReason(req(), [], at(9, 30))).toBeNull();
    expect(rejectReason(req(), [], at(14, 44))).toBeNull();
    expect(rejectReason(req(), [], at(14, 45))).toBe(msg);
    expect(rejectReason(req(), [], at(11, 0, 20))).toBe(msg); // Saturday
    expect(rejectReason(req(), [], at(11, 0, 21))).toBe(msg); // Sunday
    expect(inEntryWindow(at(11, 0))).toBe(true);
    expect(inEntryWindow(at(11, 0, 20))).toBe(false);
  });

  it("stops for the day at the daily loss limit, counting open trades too", () => {
    const msg = "Daily loss limit reached (₹2,000). No more trades today.";
    expect(rejectReason(req(), [done(-2000, at(10, 0))], now)).toBe(msg);
    expect(rejectReason(req(), [done(-1999, at(10, 0))], now)).toBeNull();
    // 1,500 lost and closed + 500 down on an open trade = the limit.
    const mixed = [done(-1500, at(10, 0)), trade({ symbol: "INFY.NS", qty: 1, unrealisedPnl: -500 })];
    expect(rejectReason(req(), mixed, now)).toBe(msg);
    // Yesterday's loss does not count (16 Jan).
    expect(rejectReason(req(), [done(-5000, at(10, 0))], at(11, 0, 16))).toBeNull();
  });

  it("allows at most three trades a day", () => {
    const three = [done(50, at(9, 40)), done(-50, at(9, 50)), done(50, at(10, 0))];
    expect(rejectReason(req(), three, now)).toBe("You have taken 3 trades today. The limit is 3 a day.");
    expect(rejectReason(req(), three.slice(1), now)).toBeNull();
    expect(rejectReason(req(), three, at(11, 0, 16))).toBeNull(); // new day
  });

  it("stops after two losses in a row", () => {
    const msg = "Two losses in a row — stop for today.";
    expect(rejectReason(req(), [done(-50, at(9, 40)), done(-50, at(9, 50))], now)).toBe(msg);
    // Order is by exit time, not ledger order.
    expect(rejectReason(req(), [done(-50, at(9, 50)), done(-50, at(9, 40))], now)).toBe(msg);
    expect(rejectReason(req(), [done(-50, at(9, 40)), done(50, at(9, 50))], now)).toBeNull();
    expect(rejectReason(req(), [done(50, at(9, 40)), done(-50, at(9, 50))], now)).toBeNull();
  });

  it("stays out of a stock for 30 minutes after it hit the stop", () => {
    const stopped = done(-50, at(10, 45), { symbol: "RELIANCE.NS", exitReason: "stop" });
    expect(rejectReason(req(), [stopped], now)).toBe("RELIANCE hit your stop 15 min ago. Wait 30 minutes before trading it again.");
    expect(rejectReason(req(), [stopped], at(11, 14))).toMatch(/29 min ago/);
    expect(rejectReason(req(), [stopped], at(11, 15))).toBeNull();
    expect(rejectReason(req({ symbol: "INFY.NS" }), [stopped], now)).toBeNull(); // another stock
    expect(rejectReason(req(), [{ ...stopped, exitReason: "target", netPnl: 50 }], now)).toBeNull(); // not a stop
    expect(stoppedOutMinutesAgo([stopped], "RELIANCE.NS", now)).toBe(15);
    expect(stoppedOutMinutesAgo([stopped], "RELIANCE.NS", at(11, 15))).toBeNull();
  });

  it("rejects a stop closer than 0.35% of the price", () => {
    expect(rejectReason(req({ stop: 99.79 }), [], now)).toBe("Stop is too close (0.21% away). Normal price noise and charges would take it out.");
    expect(rejectReason(req({ stop: 99.6 }), [], now)).toBeNull(); // 0.40%
    expect(rejectReason(req({ side: "short", stop: 100.21 }), [], now)).toMatch(/Stop is too close \(0\.21% away\)/);
  });

  it("does not chase a signal that has already run, or take one that has failed", () => {
    const missed = "Missed it — price has already moved. Do not chase.";
    const against = "Price has gone against the signal; wait for a new one.";
    // Signal at 100 with the stop at 98: one stop distance is 2.
    expect(rejectReason(req({ signalPrice: 100, entryPrice: 100.7 }), [], now)).toBe(missed); // 0.35
    expect(rejectReason(req({ signalPrice: 100, entryPrice: 100.5 }), [], now)).toBeNull(); // 0.25
    expect(rejectReason(req({ signalPrice: 100, entryPrice: 98.9 }), [], now)).toBe(against); // -0.55
    expect(rejectReason(req({ signalPrice: 100, entryPrice: 99.1 }), [], now)).toBeNull(); // -0.45
    expect(rejectReason(req({ signalPrice: 100, entryPrice: 100 }), [], now)).toBeNull();
    // Shorts mirror: stop at 102.
    const short = { side: "short" as const, stop: 102, signalPrice: 100 };
    expect(rejectReason(req({ ...short, entryPrice: 99.3 }), [], now)).toBe(missed);
    expect(rejectReason(req({ ...short, entryPrice: 101.1 }), [], now)).toBe(against);
    expect(rejectReason(req({ ...short, entryPrice: 99.5 }), [], now)).toBeNull();
    expect(movedSinceSignal("long", 100, 100.7, 98)).toBeCloseTo(0.35);
    expect(movedSinceSignal("short", 100, 101.1, 102)).toBeCloseTo(-0.55);
    // Price already through the stop is not a trade at all.
    expect(rejectReason(req({ entryPrice: 97.5 }), [], now)).toMatch(/past the stop/);
  });

  it("needs the reward to be 1.5× the risk after charges, when there is a real target", () => {
    const costs = (exitPrice: number) => computeTradeCosts({ side: "long", entryPrice: 100, exitPrice, qty: 10, model: DEFAULT_COSTS, intraday: true });
    const n = tradeNumbers({ side: "long", qty: 10, entryPrice: 100, stop: 98, target: 104 });
    expect(n.risk).toBeCloseTo(20 + costs(98), 9);
    expect(n.reward).toBeCloseTo(40 - costs(104), 9);
    expect(n.costs).toBeCloseTo(costs(104), 9);
    expect(n.stopPct).toBeCloseTo(2, 9);
    expect(tradeNumbers({ side: "long", qty: 10, entryPrice: 100, stop: 98 }).reward).toBeNull();

    expect(rejectReason(req({ target: 104 }), [], now)).toBeNull(); // about 2 : 1
    // 30 gross against 20 is exactly 1.5 before charges; charges push it under.
    const r = Math.round(20 + costs(98));
    const w = Math.round(30 - costs(103));
    expect(rejectReason(req({ target: 103 }), [], now)).toBe(`Not worth it: you risk ₹${r} to make ₹${w} after charges.`);
    expect(rejectReason(req({ target: 102 }), [], now)).toMatch(/Not worth it/);
    // No fixed target: the rule does not apply.
    expect(rejectReason(req({ target: undefined }), [], now)).toBeNull();
    // Shorts.
    expect(rejectReason(req({ side: "short", stop: 102, target: 96 }), [], now)).toBeNull();
    expect(rejectReason(req({ side: "short", stop: 102, target: 98 }), [], now)).toMatch(/Not worth it/);
  });

  it("checks cash against the margin, not the full position value", () => {
    // 400 shares at 100 = 40,000 of stock; stop 0.5% away risks 200.
    const big = { qty: 400, stop: 99.5 };
    const open = [trade({ symbol: "TCS.NS", qty: 700, entryPrice: 100 })]; // 70,000 in use → 30,000 free
    expect(rejectReason(req(big), open, now)).toBe("Not enough money left: this trade needs ₹40,000, you have ₹30,000 free.");
    expect(rejectReason(req({ ...big, leverage: 2 }), open, now)).toBeNull(); // needs 20,000
    expect(rejectReason(req({ ...big, leverage: 5 }), open, now)).toBeNull(); // needs 8,000
    // An open trade taken on 5× margin ties up a fifth of its value.
    const levered = [trade({ symbol: "TCS.NS", qty: 995, entryPrice: 100, leverage: 5 })]; // 19,900 in use
    expect(rejectReason(req(), levered, now)).toBeNull();
    expect(summarise(levered, now, false).inUse).toBeCloseTo(19_900);
    expect(summarise([trade({ qty: 995 })], now, false).inUse).toBeCloseTo(99_500); // old rows: no leverage
    expect(marginFor(400, 100, 5)).toBe(8000);
    expect(marginFor(400, 100)).toBe(40_000);
    // Margin does not loosen the risk limit.
    expect(rejectReason(req({ qty: 600, leverage: 5 }), [], now)).toMatch(/Too risky/);
  });
});

describe("accountStatus", () => {
  it("counts today's trades and result", () => {
    // One closed loss today, one open trade in profit, and a loss from an earlier day that does not count.
    const ledger = [done(-300, at(9, 50)), trade({ unrealisedPnl: 40 }), done(-900, at(10, 0, 12))];
    expect(accountStatus(ledger, 100_000, now)).toEqual({ locked: false, tradesToday: 2, lossToday: -260, tradesLeft: 1 });
  });
  it("is open with no trades, and never locked when the amount is unknown", () => {
    expect(accountStatus([], 100_000, now)).toEqual({ locked: false, tradesToday: 0, lossToday: 0, tradesLeft: 3 });
    const bad = [done(-3000, at(9, 40)), done(-3000, at(9, 50))];
    expect(accountStatus(bad, undefined, now)).toEqual({ locked: false, tradesToday: 2, lossToday: -6000, tradesLeft: 1 });
    expect(summarise(bad, now, false).status.locked).toBe(false);
  });
  it("locks with the reason for each daily rule", () => {
    expect(accountStatus([done(-2500, at(9, 40))], 100_000, now)).toMatchObject({ locked: true, reason: "Daily loss limit reached (₹2,000). No more trades today." });
    // The limit scales with the amount.
    expect(accountStatus([done(-2500, at(9, 40))], 200_000, now).locked).toBe(false);
    expect(accountStatus([done(-10, at(9, 40)), done(-10, at(9, 50))], 100_000, now)).toMatchObject({ locked: true, reason: "Two losses in a row — stop for today.", tradesLeft: 1 });
    const three = [done(50, at(9, 40)), done(50, at(9, 50)), trade({ unrealisedPnl: 0 })];
    expect(accountStatus(three, 100_000, now)).toMatchObject({ locked: true, tradesToday: 3, tradesLeft: 0 });
    expect(summarise(three, now, false, 100_000).status.locked).toBe(true);
    // A new day starts clean.
    expect(accountStatus(three.slice(0, 2), 100_000, at(10, 0, 16))).toEqual({ locked: false, tradesToday: 0, lossToday: 0, tradesLeft: 3 });
  });
});

describe("entryFill", () => {
  it("fills a little worse than the price asked for", () => {
    expect(entryFill("long", 100)).toBeCloseTo(100.05, 9);
    expect(entryFill("short", 100)).toBeCloseTo(99.95, 9);
  });
});

describe("settleTrade", () => {
  it("ignores bars that started before the trade was placed", () => {
    const out = settleTrade(trade(), [bar(at(9, 55), 100, 100, 90, 100), bar(at(10, 0), 100, 101, 99.5, 100.5)], now);
    expect(out.status).toBe("open");
    expect(out.unrealisedPnl).toBeCloseTo(5);
  });
  it("closes at the stop less slippage, and checks the stop before the target", () => {
    const out = settleTrade(trade(), [bar(at(10, 0), 100, 105, 97, 100)], now);
    expect(out).toMatchObject({ status: "closed", exitReason: "stop" });
    expect(out.exitPrice).toBeCloseTo(98 * 0.999, 9); // 97.902: stops slip twice as much, as in the backtest
    const costs = computeTradeCosts({ side: "long", entryPrice: 100, exitPrice: 98 * 0.999, qty: 10, model: DEFAULT_COSTS, intraday: true });
    expect(out.netPnl).toBeCloseTo((98 * 0.999 - 100) * 10 - costs, 9); // -20.98 gross, minus costs
    expect(out.netPnl).toBeLessThan(-20.98);
  });
  it("fills a gap through the stop at the open, less slippage", () => {
    const out = settleTrade(trade(), [bar(at(10, 0), 97, 97.5, 96, 97)], now);
    expect(out.exitReason).toBe("stop");
    expect(out.exitPrice).toBeCloseTo(97 * 0.999, 9); // 96.903
  });
  it("closes at the target with no slippage (limit order)", () => {
    expect(settleTrade(trade(), [bar(at(10, 0), 100, 104.5, 99, 104)], now)).toMatchObject({ exitReason: "target", exitPrice: 104 });
  });
  it("handles shorts", () => {
    const t = trade({ side: "short", stop: 102, target: 96 });
    expect(settleTrade(t, [bar(at(10, 0), 100, 101, 95, 96)], now)).toMatchObject({ exitReason: "target", exitPrice: 96 });
    // A short's stop is a buy: slippage makes it dearer.
    const stopped = settleTrade(t, [bar(at(10, 0), 100, 102.5, 99, 101)], now);
    expect(stopped.exitReason).toBe("stop");
    expect(stopped.exitPrice).toBeCloseTo(102 * 1.001, 9); // 102.102
  });
  it("squares off at 15:05, before the broker's forced close, less slippage", () => {
    const out = settleTrade(trade(), [bar(at(15, 0), 100, 101, 99, 100.5), bar(at(15, 5), 101, 110, 90, 100)], at(15, 10));
    expect(out.exitReason).toBe("squareoff");
    expect(out.exitPrice).toBeCloseTo(101 * 0.9995, 9); // 100.9495
  });
  it("never carries a trade overnight", () => {
    const out = settleTrade(trade(), [bar(at(10, 0), 100, 101, 99, 100.5), bar(at(9, 15, 16), 90, 91, 89, 90)], at(9, 30, 16));
    expect(out).toMatchObject({ status: "closed", exitReason: "squareoff" });
    expect(out.exitPrice).toBeCloseTo(100.5 * 0.9995, 9); // 100.44975
  });
});
