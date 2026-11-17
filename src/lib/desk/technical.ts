// Desk agents 1 and 3: read the chart for one stock (analyse) and turn a directional view into a
// complete trade proposal (buildPlan). Pure functions over candles; no I/O.

import { computeTradeCosts } from "@/lib/backtest/costs";
import { atr, ema, rsi, vwap } from "@/lib/indicators";
import { ENTRY_END, ENTRY_START, MIN_STOP_PCT, PAPER_SQUARE_OFF } from "@/lib/paper/settle";
import { DEFAULT_COSTS, IST_OFFSET_MS, type Candle, type Side } from "@/lib/types";
import type { Bias, DeskAccount, TechnicalView, TradePlan } from "./types";

const DAY_MS = 86_400_000;
const BAR_MS = 5 * 60_000;
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;
const MIN_BARS = 60;
const MIN_ATR_PCT = 0.12;
const MAX_STOP_PCT = 1.5;

const istDay = (t: number): number => Math.floor((t + IST_OFFSET_MS) / DAY_MS);
const istMinute = (t: number): number => Math.floor((((t + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);

function inWeekdaySession(t: number): boolean {
  const dow = new Date(t + IST_OFFSET_MS).getUTCDay();
  const m = istMinute(t);
  return dow >= 1 && dow <= 5 && m >= SESSION_OPEN_MIN && m < SESSION_CLOSE_MIN;
}

const tickOf = (price: number): number => (price >= 250 ? 0.05 : 0.01);

/** Round to 2 decimals, or to the nearest 0.05 for prices of 250 and above. */
function roundPrice(price: number): number {
  const tick = tickOf(price);
  return Math.round((Math.round(price / tick) * tick) * 100) / 100;
}

const inr = (n: number): string => `₹${n.toFixed(2)}`;
const last = (xs: number[]): number => (xs.length ? xs[xs.length - 1] : NaN);

export function analyse(symbol: string, candles: Candle[], now: number): TechnicalView | null {
  if (candles.length === 0) return null;
  const latestDay = istDay(candles[candles.length - 1].time);
  const bars = candles.slice();
  while (bars.length && bars[bars.length - 1].time + BAR_MS > now) bars.pop();
  if (bars.length < MIN_BARS) return null;

  const lastBar = bars[bars.length - 1];
  if (istDay(lastBar.time) !== latestDay) return null;
  const today = bars.filter((c) => istDay(c.time) === latestDay);
  const earlier = bars.filter((c) => istDay(c.time) < latestDay);

  const closes = bars.map((c) => c.close);
  const price = lastBar.close;
  const vwapNow = last(vwap(today));
  const rsiNow = last(rsi(closes, 14));
  const ema9 = last(ema(closes, 9));
  const ema20 = last(ema(closes, 20));
  const ema50 = last(ema(closes, 50));
  const ema200 = last(ema(closes, 200));

  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const macdLine = closes.map((_, i) => fast[i] - slow[i]).filter((v) => !Number.isNaN(v));
  const macdNow = last(macdLine);
  const macdSignal = last(ema(macdLine, 9));

  const prevDayKey = earlier.length ? istDay(earlier[earlier.length - 1].time) : NaN;
  const prevDay = earlier.filter((c) => istDay(c.time) === prevDayKey);
  const prevDayHigh = prevDay.length ? Math.max(...prevDay.map((c) => c.high)) : NaN;
  const prevDayLow = prevDay.length ? Math.min(...prevDay.map((c) => c.low)) : NaN;
  const prevClose = prevDay.length ? prevDay[prevDay.length - 1].close : NaN;

  const orBars = today.filter((c) => {
    const m = istMinute(c.time);
    return m >= SESSION_OPEN_MIN && m < SESSION_OPEN_MIN + 15;
  });
  const orHigh = orBars.length ? Math.max(...orBars.map((c) => c.high)) : NaN;
  const orLow = orBars.length ? Math.min(...orBars.map((c) => c.low)) : NaN;

  const cutoff = istMinute(lastBar.time);
  const todayVol = today.reduce((s, c) => s + c.volume, 0);
  const byDay = new Map<number, number>();
  for (const c of earlier) {
    const d = istDay(c.time);
    byDay.set(d, (byDay.get(d) ?? 0) + (istMinute(c.time) <= cutoff ? c.volume : 0));
  }
  const usual = byDay.size ? [...byDay.values()].reduce((s, v) => s + v, 0) / byDay.size : NaN;
  const relVol = byDay.size >= 3 && usual > 0 ? todayVol / usual : NaN;

  const atrNow = last(atr(bars, 14));
  const atrPct = (atrNow / price) * 100;
  const dayChangePct = ((price - prevClose) / prevClose) * 100;

  // Each vote is +weight (bullish), −weight (bearish) or 0 (neutral / unknown).
  const cmp = (a: number, b: number, w: number): number =>
    Number.isNaN(a) || Number.isNaN(b) || a === b ? 0 : a > b ? w : -w;
  const band = (v: number, hi: number, lo: number, w: number): number =>
    Number.isNaN(v) || Number.isNaN(hi) || Number.isNaN(lo) ? 0 : v > hi ? w : v < lo ? -w : 0;
  const word = (v: number, up: string, down: string, flat: string): string => (v > 0 ? up : v < 0 ? down : flat);

  const votes: { vote: number; text: string }[] = [];
  const add = (vote: number, known: boolean, text: string) => {
    if (known) votes.push({ vote, text });
  };

  let v = cmp(price, vwapNow, 20);
  add(v, !Number.isNaN(vwapNow), `Price ${inr(price)} is ${word(v, "above", "below", "at")} the day's average price ${inr(vwapNow)}`);
  v = cmp(ema9, ema20, 15);
  add(v, !Number.isNaN(ema20), `Short-term trend is ${word(v, "up", "down", "flat")}: EMA 9 (average of recent prices) ${inr(ema9)} vs EMA 20 ${inr(ema20)}`);
  v = cmp(ema20, ema50, 10);
  add(v, !Number.isNaN(ema50), `Medium-term trend is ${word(v, "up", "down", "flat")}: EMA 20 ${inr(ema20)} vs EMA 50 (average over a few hours) ${inr(ema50)}`);
  v = cmp(price, ema200, 10);
  add(v, !Number.isNaN(ema200), `Price is ${word(v, "above", "below", "at")} EMA 200 (average over several days) ${inr(ema200)}`);
  v = cmp(macdNow, macdSignal, 15);
  add(v, !Number.isNaN(macdSignal), `MACD (trend strength gauge) ${macdNow.toFixed(2)} is ${word(v, "above", "below", "equal to")} its own average ${macdSignal.toFixed(2)}, so the move is ${word(v, "gaining pace", "losing pace", "steady")}`);
  v = band(rsiNow, 55, 45, 10);
  add(v, !Number.isNaN(rsiNow), `RSI (buying versus selling pressure) is ${rsiNow.toFixed(0)} out of 100: ${word(v, "buyers in control", "sellers in control", "neither side in control")}`);
  v = band(price, orHigh, orLow, 10);
  add(v, !Number.isNaN(orHigh), `Price is ${word(v, "above", "below", "inside")} the first 15 minutes' range ${inr(orLow)} to ${inr(orHigh)}`);
  v = band(price, prevDayHigh, prevDayLow, 10);
  add(v, !Number.isNaN(prevDayHigh), `Price is ${word(v, "above yesterday's high", "below yesterday's low", "inside yesterday's range")} (${inr(prevDayLow)} to ${inr(prevDayHigh)})`);

  const score = Math.max(-100, Math.min(100, votes.reduce((s, x) => s + x.vote, 0)));
  const tooQuiet = !(atrPct >= MIN_ATR_PCT);
  const offSession = !inWeekdaySession(lastBar.time);
  const bias: Bias = tooQuiet || offSession ? "no-trade" : score >= 35 ? "bullish" : score <= -35 ? "bearish" : "sideways";

  const dir = bias === "bullish" ? 1 : bias === "bearish" ? -1 : score >= 0 ? 1 : -1;
  const reasons: TechnicalView["reasons"] = [];
  if (tooQuiet) {
    reasons.push({ ok: false, text: `The stock is barely moving: a typical 5-minute swing is only ${atrPct.toFixed(2)}% of the price, too small to cover charges` });
  } else if (offSession) {
    reasons.push({ ok: false, text: "The latest price is from outside weekday market hours (09:15 to 15:30)" });
  }
  for (const x of votes) reasons.push({ ok: x.vote * dir > 0, text: x.text });

  return {
    symbol,
    price,
    time: lastBar.time,
    bias,
    score,
    indicators: {
      vwap: vwapNow,
      rsi: rsiNow,
      macd: macdNow,
      macdSignal,
      ema9,
      ema20,
      ema50,
      ema200,
      prevDayHigh,
      prevDayLow,
      orHigh,
      orLow,
      relVol,
      atr: atrNow,
      atrPct,
      dayChangePct,
    },
    reasons: reasons.slice(0, 8),
  };
}

export function buildPlan(view: TechnicalView, candles: Candle[], account: DeskAccount): TradePlan | null {
  if (view.bias !== "bullish" && view.bias !== "bearish") return null;
  const side: Side = view.bias === "bullish" ? "long" : "short";
  const sign = side === "long" ? 1 : -1;
  const entry = view.price;
  if (!(entry > 0) || !(account.capital > 0)) return null;

  const atrNow = Number.isFinite(view.indicators.atr) ? view.indicators.atr : 0;
  const recent = candles.filter((c) => c.time <= view.time).slice(-6);
  const anchors = [side === "long" ? recent.map((c) => c.low) : recent.map((c) => c.high), [view.indicators.vwap]]
    .flat()
    .filter((x) => Number.isFinite(x));
  const anchor = anchors.length ? (side === "long" ? Math.min(...anchors) : Math.max(...anchors)) : entry;

  // Stop sits beyond the anchor, but never closer than MIN_STOP_PCT% or further than MAX_STOP_PCT%.
  const minDist = (entry * MIN_STOP_PCT) / 100;
  const maxDist = (entry * MAX_STOP_PCT) / 100;
  const rawDist = sign * (entry - anchor) + 0.25 * atrNow;
  const dist = Math.max(minDist, Math.min(maxDist, rawDist));
  const tick = tickOf(entry);
  let stop = roundPrice(entry - sign * dist);
  if (Math.abs(entry - stop) < minDist) stop = Math.round((stop - sign * tick) * 100) / 100;
  if (Math.abs(entry - stop) > maxDist) stop = Math.round((stop + sign * tick) * 100) / 100;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;

  const multiples = Math.abs(view.score) >= 60 ? [1.5, 2.5, 4] : [1.5, 2.5];
  const targets = multiples.map((m) => roundPrice(entry + sign * m * risk));

  const costFor = (qty: number): number =>
    computeTradeCosts({ side, entryPrice: entry, exitPrice: targets[0], qty, model: DEFAULT_COSTS, intraday: true });

  const leverage = Math.max(1, account.leverage || 1);
  const budget = account.capital * account.riskPerTrade;
  const leverageCap = Math.floor((account.capital * leverage) / entry);
  const first = Math.min(Math.floor(budget / risk), leverageCap);
  if (first < 1) return null;
  const perShareCost = costFor(first) / first;
  let qty = Math.min(Math.floor(budget / (risk + perShareCost)), leverageCap);
  // Charges per share rise slightly as size falls; step down until the loss at the stop fits.
  while (qty >= 1 && risk * qty + costFor(qty) > budget) qty--;
  if (qty < 1) return null;

  const costs = costFor(qty);
  const maxLoss = risk * qty + costs;
  const rewardToRisk = (Math.abs(targets[0] - entry) * qty - costs) / maxLoss;
  const zone = 0.1 * atrNow;
  const vwapNow = view.indicators.vwap;
  const beyond = side === "long" ? "above" : "below";
  const against = side === "long" ? "below" : "above";

  return {
    symbol: view.symbol,
    side,
    entry,
    entryZone: [roundPrice(entry - zone), roundPrice(entry + zone)],
    trigger: `Enter only if the next 5-minute bar closes ${beyond} ${inr(entry)}, between ${ENTRY_START} and ${ENTRY_END}`,
    stop,
    targets,
    qty,
    capitalRequired: (qty * entry) / leverage,
    maxLoss,
    rewardToRisk,
    costs,
    holding: "Minutes to a few hours; never overnight",
    invalidation: Number.isFinite(vwapNow)
      ? `Idea is wrong if price closes ${against} the day's average price ${inr(vwapNow)}; get out at ${inr(stop)} at the latest`
      : `Idea is wrong if price trades ${against} ${inr(stop)}`,
    timeExit: `Exit by ${PAPER_SQUARE_OFF} whatever happens`,
  };
}
