// Intraday analytics derived purely from the trade list. No node imports: runs client-side.
import type { Side, Trade } from "@/lib/types";
import { IST_OFFSET_MS } from "@/lib/types";

export interface DayPnl {
  /** IST calendar day of the trade EXIT, YYYY-MM-DD */
  day: string;
  pnl: number;
  trades: number;
}

export interface DayExtreme {
  day: string;
  pnl: number;
}

export interface HourBucket {
  /** IST hour of the trade ENTRY, 9..15 */
  hour: number;
  label: string;
  trades: number;
  wins: number;
  winRate: number;
  pnl: number;
  /** Mean of finite rMultiple. NaN when no trade in the bucket had a stop. */
  avgR: number;
}

export interface GroupStat {
  trades: number;
  winRate: number;
  pnl: number;
}

export interface WeekdayStat extends GroupStat {
  weekday: string;
}

export interface ExitReasonStat extends GroupStat {
  reason: Trade["exitReason"];
}

export interface IntradayStats {
  days: DayPnl[];
  tradingDays: number;
  winDays: number;
  lossDays: number;
  /** winDays / tradingDays, 0..1 */
  winDayRate: number;
  avgDayPnl: number;
  bestDay: DayExtreme | null;
  worstDay: DayExtreme | null;
  maxConsecutiveLossDays: number;
  avgTradesPerDay: number;
  maxTradesInDay: number;
  /** Worst day's P&L as a percent of starting capital (already-percent, e.g. -1.8). 0 if no days. */
  worstDayPctOfCapital: number;
  byHour: HourBucket[];
  byWeekday: WeekdayStat[];
  byExitReason: ExitReasonStat[];
  bySide: Record<Side, GroupStat>;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SESSION_HOURS = [9, 10, 11, 12, 13, 14, 15];

/** Shift to IST and read with UTC getters, so the result is independent of the machine timezone. */
function ist(ms: number): Date {
  return new Date(ms + IST_OFFSET_MS);
}

export function istDayKey(ms: number): string {
  return ist(ms).toISOString().slice(0, 10);
}

export function hourLabel(hour: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  if (hour === 9) return "09:15–10:00";
  if (hour === 15) return "15:00–15:30";
  return `${p(hour)}:00–${p(hour + 1)}:00`;
}

interface Acc {
  trades: number;
  wins: number;
  pnl: number;
}

const newAcc = (): Acc => ({ trades: 0, wins: 0, pnl: 0 });

function add(a: Acc, t: Trade): void {
  a.trades += 1;
  if (t.netPnl > 0) a.wins += 1;
  a.pnl += t.netPnl;
}

function stat(a: Acc): GroupStat {
  return { trades: a.trades, winRate: a.trades ? a.wins / a.trades : 0, pnl: a.pnl };
}

export function computeIntradayStats(trades: Trade[], capital: number): IntradayStats {
  const dayMap = new Map<string, DayPnl>();
  const hourMap = new Map<number, Acc & { rSum: number; rN: number }>();
  const weekdayMap = new Map<number, Acc>();
  const reasonMap = new Map<Trade["exitReason"], Acc>();
  const side: Record<Side, Acc> = { long: newAcc(), short: newAcc() };

  for (const h of SESSION_HOURS) hourMap.set(h, { ...newAcc(), rSum: 0, rN: 0 });
  for (let d = 1; d <= 5; d++) weekdayMap.set(d, newAcc());

  for (const t of trades) {
    const key = istDayKey(t.exitTime);
    const day = dayMap.get(key) ?? { day: key, pnl: 0, trades: 0 };
    day.pnl += t.netPnl;
    day.trades += 1;
    dayMap.set(key, day);

    const hour = ist(t.entryTime).getUTCHours();
    let hb = hourMap.get(hour);
    if (!hb) {
      hb = { ...newAcc(), rSum: 0, rN: 0 };
      hourMap.set(hour, hb);
    }
    add(hb, t);
    if (Number.isFinite(t.rMultiple)) {
      hb.rSum += t.rMultiple;
      hb.rN += 1;
    }

    const wd = ist(t.exitTime).getUTCDay();
    let wa = weekdayMap.get(wd);
    if (!wa) {
      wa = newAcc();
      weekdayMap.set(wd, wa);
    }
    add(wa, t);

    let ra = reasonMap.get(t.exitReason);
    if (!ra) {
      ra = newAcc();
      reasonMap.set(t.exitReason, ra);
    }
    add(ra, t);

    add(side[t.side], t);
  }

  const days = [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const tradingDays = days.length;

  let winDays = 0;
  let lossDays = 0;
  let total = 0;
  let streak = 0;
  let maxConsecutiveLossDays = 0;
  let maxTradesInDay = 0;
  let bestDay: DayExtreme | null = null;
  let worstDay: DayExtreme | null = null;
  for (const d of days) {
    total += d.pnl;
    if (d.pnl > 0) winDays += 1;
    if (d.pnl < 0) {
      lossDays += 1;
      streak += 1;
      if (streak > maxConsecutiveLossDays) maxConsecutiveLossDays = streak;
    } else {
      streak = 0;
    }
    if (d.trades > maxTradesInDay) maxTradesInDay = d.trades;
    if (!bestDay || d.pnl > bestDay.pnl) bestDay = { day: d.day, pnl: d.pnl };
    if (!worstDay || d.pnl < worstDay.pnl) worstDay = { day: d.day, pnl: d.pnl };
  }

  const byHour: HourBucket[] = [...hourMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, a]) => ({
      hour,
      label: hourLabel(hour),
      trades: a.trades,
      wins: a.wins,
      winRate: a.trades ? a.wins / a.trades : 0,
      pnl: a.pnl,
      avgR: a.rN ? a.rSum / a.rN : NaN,
    }));

  // Mon..Fri first; a weekend session (rare special trading days) sorts after.
  const byWeekday: WeekdayStat[] = [...weekdayMap.entries()]
    .sort((a, b) => ((a[0] + 6) % 7) - ((b[0] + 6) % 7))
    .map(([wd, a]) => ({ weekday: WEEKDAYS[wd], ...stat(a) }));

  const byExitReason: ExitReasonStat[] = [...reasonMap.entries()]
    .map(([reason, a]) => ({ reason, ...stat(a) }))
    .sort((a, b) => b.trades - a.trades);

  return {
    days,
    tradingDays,
    winDays,
    lossDays,
    winDayRate: tradingDays ? winDays / tradingDays : 0,
    avgDayPnl: tradingDays ? total / tradingDays : 0,
    bestDay,
    worstDay,
    maxConsecutiveLossDays,
    avgTradesPerDay: tradingDays ? trades.length / tradingDays : 0,
    maxTradesInDay,
    worstDayPctOfCapital: worstDay && capital > 0 ? (worstDay.pnl / capital) * 100 : 0,
    byHour,
    byWeekday,
    byExitReason,
    bySide: { long: stat(side.long), short: stat(side.short) },
  };
}
