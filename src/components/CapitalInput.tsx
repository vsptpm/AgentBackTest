"use client";

import { fmtINR, parseINR } from "@/lib/format";
import { Field, capitalError } from "@/components/ui";

/**
 * Required INR capital input. Starts empty, never persisted.
 * Parent owns the raw string so each page load/reset starts blank.
 */
export function CapitalInput({
  raw,
  onRaw,
  touched,
  onTouched,
}: {
  raw: string;
  onRaw: (s: string) => void;
  touched: boolean;
  onTouched: () => void;
}) {
  const value = parseINR(raw);
  const err = capitalError(value, raw);
  const showErr = touched && err;
  return (
    <Field
      label="Capital (₹) — required"
      error={showErr ? err : undefined}
      hint={!showErr && Number.isFinite(value) ? `Trading ${fmtINR(value)}` : "Confirm capital before every run · min ₹1,000"}
    >
      <input
        className="input text-base font-medium"
        inputMode="numeric"
        autoComplete="off"
        placeholder="e.g. 10,000"
        value={raw}
        aria-invalid={showErr ? "true" : undefined}
        aria-required="true"
        onChange={(e) => onRaw(e.target.value)}
        onBlur={() => {
          onTouched();
          if (Number.isFinite(value)) onRaw(fmtINR(value).replace("₹", ""));
        }}
      />
    </Field>
  );
}
