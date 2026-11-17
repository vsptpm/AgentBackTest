import { describe, expect, it } from "vitest";
import { judge, planTrade, isProven, type JudgeInput, type PlanInput, type StrategyRecord } from "./verdict";

const GOOD: StrategyRecord = { trades: 124, wins: 70, netPnl: 900, sumR: 30, nR: 124 };
const LOSING: StrategyRecord = { trades: 124, wins: 51, netPnl: -400, sumR: -12, nR: 124 };

// Rs 1,000, no margin, risk 1% = Rs 10. Buy at 200, stop 196 (2%), target 210.
const PLAN: PlanInput = { side: "long", fresh: true, signalPrice: 200, lastPrice: 200, stop: 196, target: 210, signalQty: 5, capital: 1000, riskPerTrade: 0.01, leverage: 1 };

function input(over: Partial<JudgeInput> = {}, plan: Partial<PlanInput> = {}): JudgeInput {
  const p = { ...PLAN, ...plan };
  return {
    symbol: "ABC.NS",
    side: p.side,
    fresh: p.fresh,
    signalAgeSec: 40,
    signalPrice: p.signalPrice,
    stop: p.stop,
    target: p.target,
    exitRule: p.target == null ? "signal" : "target",
    plan: planTrade(p),
    changePct: 2.4,
    relVol: 3.1,
    checkDirection: true,
    strategy: GOOD,
    stock: { trades: 9, wins: 5 },
    disagree: false,
    capital: p.capital,
    leverage: p.leverage,
    free: p.capital,
    interval: "5m",
    priceSource: "upstox",
    inEntryWindow: true,
    locked: false,
    tradesLeft: 3,
    stoppedOutMinAgo: null,
    ...over,
  };
}

const crosses = (i: JudgeInput) => judge(i).reasons.filter((r) => !r.ok).map((r) => r.text);

describe("planTrade", () => {
  it("sizes to the loss limit, the signal and what the account can hold", () => {
    expect(planTrade(PLAN)).toMatchObject({ entry: 200, qty: 2, margin: 400 }); // Rs 10 risk / Rs 4 stop
    expect(planTrade({ ...PLAN, signalQty: 1 }).qty).toBe(1);
    expect(planTrade({ ...PLAN, stop: 199.5 }).qty).toBe(5); // Rs 1,000 buys 5
    expect(planTrade({ ...PLAN, stop: 199.5, signalQty: 40, leverage: 5 })).toMatchObject({ qty: 20, margin: 800 });
  });
  it("enters an older signal at the price now and has no numbers past the stop", () => {
    expect(planTrade({ ...PLAN, fresh: false, lastPrice: 201 }).entry).toBe(201);
    expect(planTrade({ ...PLAN, fresh: false, lastPrice: 195 }).numbers).toBeNull();
  });
});

describe("judge", () => {
  it("says take only when every line is a tick", () => {
    const j = judge(input());
    expect(j.verdict).toBe("take");
    expect(j.headline).toBe("Worth taking — every check passes");
    expect(j.reasons.every((r) => r.ok)).toBe(true);
    expect(j.reasons.length).toBeGreaterThanOrEqual(5);
    expect(j.reasons.length).toBeLessThanOrEqual(7);
    const text = j.reasons.map((r) => r.text);
    expect(text[0]).toBe("You can buy 2 shares for ₹400 of your ₹1,000");
    expect(text[1]).toBe("Up 2.4% today on 3.1× usual volume — it is moving");
    expect(text[2]).toMatch(/^Risk ₹9\.\d\d to make ₹18\.\d\d after ₹1\.\d\d charges$/);
    expect(text[3]).toBe("Stop is 2.0% away — far enough");
    expect(text[4]).toBe("Signal fired 40 s ago");
    expect(text[5]).toBe("This strategy won 70 of 124 recent trades and made money overall (on this stock: 5 of 9)");
    expect(text[6]).toBe("Prices are live. You have 3 of 3 trades left today");
  });

  it("names the margin when it is used", () => {
    const j = judge(input({}, { leverage: 5, signalQty: 40, stop: 199, target: 203 }));
    expect(j.reasons[0].text).toBe("You can buy 10 shares worth ₹2,000, using ₹400 of your ₹1,000");
    expect(judge(input({ changePct: -2.4 }, { side: "short", stop: 204, target: 190 })).reasons[0].text).toBe("You can sell 2 shares for ₹400 of your ₹1,000");
  });

  it("never uses trader jargon", () => {
    const all = [input(), input({ strategy: LOSING }), input({ inEntryWindow: false }), input({}, { stop: 199.8, target: 200.4 })]
      .flatMap((i) => [judge(i).headline, ...judge(i).reasons.map((r) => r.text)])
      .join(" | ");
    expect(all).not.toMatch(/\bR\b|\bPF\b|expectancy|R:R/i);
  });

  describe("skip: a hard rule fails", () => {
    const skips: [string, JudgeInput, string][] = [
      ["outside the entry window", input({ inEntryWindow: false }), "Skip — outside trading hours"],
      ["the signal is too old", input({ signalAgeSec: 200 }), "Skip — the signal is 3 min old, wait for the next one"],
      ["missed: price has run", input({}, { fresh: false, lastPrice: 202 }), "Skip — you missed it, do not chase"],
      ["gone against", input({}, { fresh: false, lastPrice: 197.5 }), "Skip — price has gone against the signal"],
      ["past the stop", input({}, { fresh: false, lastPrice: 195 }), "Skip — price is already past the stop"],
      ["stop too close", input({}, { stop: 199.5, target: 203 }), "Skip — the stop is too close"],
      ["not worth it after charges", input({}, { target: 204 }), "Skip — the profit is too small for the risk after charges"],
      ["charges eat the profit", input({}, { target: 200.3 }), "Skip — charges would eat the profit"],
      ["account locked", input({ locked: true, lockedReason: "Two losses in a row — stop for today." }), "Skip — you are done trading for today"],
      ["strategies disagree", input({ disagree: true }), "Skip — strategies disagree on direction"],
      ["cannot afford two shares", input({}, { signalPrice: 600, lastPrice: 600, stop: 590, target: 630 }), "Skip — you cannot afford 2 shares"],
      ["money tied up elsewhere", input({ free: 300 }), "Skip — it needs ₹400 and only ₹300 is free"],
      ["cooling off after a stop", input({ stoppedOutMinAgo: 12 }), "Skip — this stock hit your stop 12 min ago"],
      ["no stop", input({}, { stop: undefined }), "Skip — no stop loss, so the loss cannot be limited"],
      ["an index", input({ symbol: "^NSEI" }), "Skip — an index cannot be bought as a share"],
    ];
    for (const [name, i, headline] of skips) {
      it(name, () => {
        const j = judge(i);
        expect(j.verdict).toBe("skip");
        expect(j.headline).toBe(headline);
        expect(j.reasons.some((r) => !r.ok)).toBe(true);
        expect(j.reasons.length).toBeGreaterThanOrEqual(5);
        expect(j.reasons.length).toBeLessThanOrEqual(7);
      });
    }

    it("puts the most important reason in the headline when several fail", () => {
      const j = judge(input({ inEntryWindow: false, strategy: LOSING, priceSource: "yahoo" }, { target: 204 }));
      expect(j.headline).toBe("Skip — outside trading hours");
      expect(j.reasons.filter((r) => !r.ok).length).toBe(4);
    });

    it("shows the numbers behind a cross", () => {
      expect(crosses(input({}, { target: 204 }))[0]).toMatch(/^Risk ₹9\.\d\d to make ₹6\.\d\d after ₹1\.\d\d charges — not worth it$/);
      expect(crosses(input({}, { stop: 199.5, target: 203 }))).toContain("Stop is only 0.25% away — normal price wiggles would hit it");
      expect(crosses(input({}, { signalPrice: 600, lastPrice: 600, stop: 590, target: 630 }))[0]).toBe("At ₹600.00 a share, ₹1,000 does not buy 2 shares");
      expect(crosses(input({ inEntryWindow: false }))).toEqual(["Outside trading hours — new trades are taken 09:30–14:45"]);
    });

    it("a stock out of reach at 1x is tradable with 5x margin", () => {
      const dear = { signalPrice: 600, lastPrice: 600, stop: 590, target: 630 };
      expect(judge(input({}, dear)).verdict).toBe("skip");
      expect(judge(input({}, { ...dear, leverage: 5 })).reasons[0]).toEqual({
        ok: true,
        text: "You can buy 1 share worth ₹600, using ₹120 of your ₹1,000",
      });
    });
  });

  describe("wait: nothing fails, but it is not proven", () => {
    it("a strategy that has been losing money", () => {
      const j = judge(input({ strategy: LOSING }));
      expect(j.verdict).toBe("wait");
      expect(j.headline).toBe("Wait — this strategy has not been making money lately");
      expect(crosses(input({ strategy: LOSING }))).toEqual(["This strategy won 51 of 124 recent trades and lost money overall (on this stock: 5 of 9)"]);
    });
    it("a strategy with too few trades", () => {
      const few: StrategyRecord = { trades: 12, wins: 9, netPnl: 500, sumR: 8, nR: 12 };
      expect(isProven(few)).toBe(false);
      expect(judge(input({ strategy: few, stock: { trades: 2, wins: 2 } })).headline).toBe("Wait — this strategy has too few recent trades to trust");
      expect(crosses(input({ strategy: few, stock: { trades: 2, wins: 2 } }))).toEqual(["This strategy has only 12 recent trades — too few to trust"]);
    });
    it("delayed prices", () => {
      const j = judge(input({ priceSource: "yahoo" }));
      expect(j.verdict).toBe("wait");
      expect(j.headline).toBe("Wait — prices are delayed, check the live price first");
      expect(judge(input({ priceSource: "mixed" })).verdict).toBe("wait");
    });
    it("a trade against the day's direction", () => {
      const j = judge(input({ changePct: -2.4 }));
      expect(j.verdict).toBe("wait");
      expect(j.headline).toBe("Wait — this goes against the stock's direction today");
      expect(crosses(input({ changePct: -2.4 }))).toEqual(["Down 2.4% today, but this is a buy — against the day's direction"]);
      // Not checked for a hand-picked watchlist.
      expect(judge(input({ changePct: -2.4, checkDirection: false })).verdict).toBe("take");
    });
    it("a stock that is barely moving", () => {
      const j = judge(input({ changePct: 0.3, relVol: 0.8 }));
      expect(j.verdict).toBe("wait");
      expect(crosses(input({ changePct: 0.3, relVol: 0.8 }))).toEqual(["Only up 0.3% today on 0.8× usual volume — barely moving"]);
      expect(judge(input({ changePct: 0.3, relVol: 2.5 })).verdict).toBe("take");
    });
    it("leaves the movement line out when today's move is unknown", () => {
      const j = judge(input({ changePct: undefined, relVol: undefined }));
      expect(j.verdict).toBe("take");
      expect(j.reasons).toHaveLength(6);
    });
  });

  it("accepts a strategy with no fixed target", () => {
    const j = judge(input({}, { target: undefined }));
    expect(j.verdict).toBe("take");
    expect(j.reasons[2].text).toMatch(/^Risk ₹9\.\d\d after ₹1\.\d\d charges\. No fixed target — you exit when the strategy says so$/);
  });
});
