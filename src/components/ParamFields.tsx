"use client";

import type { ParamSpec, Params } from "@/lib/types";
import { Field } from "@/components/ui";

export function defaultParams(specs: ParamSpec[]): Params {
  const out: Params = {};
  for (const s of specs) out[s.key] = s.default;
  return out;
}

export function ParamFields({
  specs,
  values,
  onChange,
}: {
  specs: ParamSpec[];
  values: Params;
  onChange: (next: Params) => void;
}) {
  if (specs.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {specs.map((s) => {
        const v = values[s.key] ?? s.default;
        if (s.type === "select") {
          return (
            <Field key={s.key} label={s.label}>
              <select
                className="input"
                value={String(v)}
                onChange={(e) => onChange({ ...values, [s.key]: e.target.value })}
              >
                {(s.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
          );
        }
        const hint = [
          s.min !== undefined ? `min ${s.min}` : null,
          s.max !== undefined ? `max ${s.max}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <Field key={s.key} label={s.label} hint={hint || undefined}>
            <input
              className="input"
              type="number"
              value={typeof v === "number" ? v : Number(v)}
              min={s.min}
              max={s.max}
              step={s.step ?? "any"}
              onChange={(e) => {
                const n = e.target.valueAsNumber;
                onChange({ ...values, [s.key]: Number.isFinite(n) ? n : Number(s.default) });
              }}
            />
          </Field>
        );
      })}
    </div>
  );
}
