import type { ReactNode } from "react";

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="label">{label}</label>
      {children}
      {error ? (
        <p className="mt-1 text-[11px] text-red">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[11px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted">
      <span className="spinner" />
      {label}
    </span>
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: "amber" | "red" | "muted";
  children: ReactNode;
}) {
  const cls =
    tone === "amber"
      ? "border-amber/40 bg-amber/10 text-amber"
      : tone === "red"
        ? "border-red/40 bg-red/10 text-red"
        : "border-border bg-surface text-muted";
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${cls}`} role={tone === "red" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{children}</h3>
      {right}
    </div>
  );
}

/** Tailwind colour class for a signed P&L value. */
export function pnlClass(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "text-muted";
  return n > 0 ? "text-green" : "text-red";
}

/** Capital validation shared by both forms. */
export const MIN_CAPITAL = 1_000;

export function capitalError(value: number, raw: string): string | undefined {
  if (raw.trim() === "") return "Capital is required for every run.";
  if (!Number.isFinite(value)) return "Enter a number in rupees.";
  if (value < MIN_CAPITAL) return "Minimum capital is ₹1,000.";
  return undefined;
}
