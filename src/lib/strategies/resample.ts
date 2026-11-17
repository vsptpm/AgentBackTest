import type { Candle } from "@/lib/types";
import { istDay, istMinutes, SESSION_OPEN_MIN } from "./helpers";

export type HtfInterval = "1h" | "4h" | "1d";

const SESSION_CLOSE_MIN = 15 * 60 + 30;

export interface Resampled {
  /** Higher-timeframe candles, time = bucket start (ms). */
  htf: Candle[];
  /** Bucket end (ms) per HTF candle; the bar is "closed" once an LTF bar starts at or after this. */
  htfEnd: number[];
  /**
   * For each LTF index i: index of the last HTF bar that had fully CLOSED before LTF bar i opened,
   * or -1 if none. Using this (and never the in-progress bucket) is what keeps the HTF filter lookahead-free.
   */
  completedAt: number[];
}

/** Minutes from session open to the start of the bucket this bar belongs to. */
function bucketStartMin(minsFromOpen: number, htf: HtfInterval): number {
  if (htf === "1d") return 0;
  const size = htf === "1h" ? 60 : 240;
  return Math.floor(minsFromOpen / size) * size;
}

function bucketEndMin(startMin: number, htf: HtfInterval): number {
  if (htf === "1d") return SESSION_CLOSE_MIN - SESSION_OPEN_MIN;
  const size = htf === "1h" ? 60 : 240;
  // Last bucket of the day is a stub that ends at 15:30.
  return Math.min(startMin + size, SESSION_CLOSE_MIN - SESSION_OPEN_MIN);
}

/**
 * Aggregate intraday LTF candles into HTF buckets anchored at 09:15 IST.
 * 1h → 09:15, 10:15, …, 15:15 (15-minute stub). 4h → 09:15, 13:15 (2h15m stub). 1d → one per IST day.
 */
export function resample(ltf: Candle[], htf: HtfInterval): Resampled {
  const out: Candle[] = [];
  const htfEnd: number[] = [];
  const completedAt: number[] = new Array(ltf.length).fill(-1);

  let curDay = "";
  let curStart = -1;

  for (let i = 0; i < ltf.length; i++) {
    const c = ltf[i];
    const day = istDay(c.time);
    const mins = istMinutes(c.time) - SESSION_OPEN_MIN;
    const start = bucketStartMin(Math.max(0, mins), htf);

    // Before placing this LTF bar, record which HTF bars are complete as of its open.
    let done = out.length - 1;
    while (done >= 0 && htfEnd[done] > c.time) done--;
    completedAt[i] = done;

    if (day !== curDay || start !== curStart) {
      curDay = day;
      curStart = start;
      // Bucket start timestamp: session open + start minutes, on this IST day.
      const dayOpenMs = c.time - (istMinutes(c.time) - SESSION_OPEN_MIN) * 60_000;
      const bucketStartMs = dayOpenMs + start * 60_000;
      out.push({ time: bucketStartMs, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
      htfEnd.push(dayOpenMs + bucketEndMin(start, htf) * 60_000);
    } else {
      const b = out[out.length - 1];
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return { htf: out, htfEnd, completedAt };
}
