// Display formatting helpers. All times are rendered in IST (Asia/Kolkata).

const MINUS = "−";
const IST = "Asia/Kolkata";

const inrInt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inrDec = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function isBad(n: number): boolean {
  return !Number.isFinite(n);
}

/**
 * Indian-grouped rupee amount: ₹12,34,567. Negatives use a real minus sign.
 * `compact` renders ₹1.2L / ₹3.4Cr / ₹12K.
 */
export function fmtINR(
  n: number,
  opts: { compact?: boolean; decimals?: boolean } = {},
): string {
  if (isBad(n)) return "—";
  const neg = n < 0;
  const abs = Math.abs(n);
  let body: string;
  if (opts.compact) {
    if (abs >= 1e7) body = trimZeros((abs / 1e7).toFixed(2)) + "Cr";
    else if (abs >= 1e5) body = trimZeros((abs / 1e5).toFixed(2)) + "L";
    else if (abs >= 1e3) body = trimZeros((abs / 1e3).toFixed(1)) + "K";
    else body = inrInt.format(Math.round(abs));
  } else {
    body = opts.decimals ? inrDec.format(abs) : inrInt.format(Math.round(abs));
  }
  return `${neg ? MINUS : ""}₹${body}`;
}

function trimZeros(s: string): string {
  return s.replace(/\.?0+$/, "");
}

/** Fraction (0.35) → "35.0%". Use for winRate/lossRate/mae/mfe. */
export function fmtPct(n: number, digits = 1): string {
  if (isBad(n)) return "—";
  return fmtPctRaw(n * 100, digits);
}

/** Already-percent value (35.2) → "35.2%". Use for *Pct metric fields. */
export function fmtPctRaw(n: number, digits = 1): string {
  if (isBad(n)) return "—";
  const neg = n < 0;
  return `${neg ? MINUS : ""}${Math.abs(n).toFixed(digits)}%`;
}

/** Plain number with Indian grouping and fixed decimals. */
export function fmtNum(n: number, digits = 2): string {
  if (isBad(n)) return "—";
  const neg = n < 0;
  const f = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${neg ? MINUS : ""}${f.format(Math.abs(n))}`;
}

/** R-multiple: "1.8R", "−0.5R", "—" for NaN. */
export function fmtR(n: number): string {
  if (isBad(n)) return "—";
  const neg = n < 0;
  return `${neg ? MINUS : ""}${Math.abs(n).toFixed(2)}R`;
}

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const dateTimeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const monthFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  month: "short",
  year: "2-digit",
});

/** "30 Oct 2026" in IST. */
export function fmtISTDate(ms: number): string {
  if (isBad(ms)) return "—";
  return dateFmt.format(new Date(ms));
}

/** "30 Oct 2026, 09:15" in IST. */
export function fmtISTDateTime(ms: number): string {
  if (isBad(ms)) return "—";
  return dateTimeFmt.format(new Date(ms)).replace(" at ", ", ");
}

/** "Oct 24" in IST, for chart axes. */
export function fmtISTMonth(ms: number): string {
  if (isBad(ms)) return "—";
  return monthFmt.format(new Date(ms));
}

/** YYYY-MM-DD of today's IST calendar date, optionally shifted by days/years. */
export function istToday(shift: { days?: number; years?: number } = {}): string {
  const d = new Date();
  // shift in UTC then format in IST; day-level accuracy is all we need here
  if (shift.years) d.setUTCFullYear(d.getUTCFullYear() + shift.years);
  if (shift.days) d.setUTCDate(d.getUTCDate() + shift.days);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return parts; // en-CA yields YYYY-MM-DD
}

/** Parse "12,34,567" / "₹1,00,000" / "100000" → number (NaN if invalid). */
export function parseINR(s: string): number {
  const cleaned = s.replace(/[₹,\s]/g, "");
  if (cleaned === "" || !/^\d+(\.\d+)?$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

/** Compact "k=v, k=v" rendering of a params object. */
export function fmtParams(p: Record<string, number | string>): string {
  return Object.entries(p)
    .map(([k, v]) => `${k}=${typeof v === "number" ? fmtNum(v, Number.isInteger(v) ? 0 : 2) : v}`)
    .join(", ");
}
