"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SymbolInfo } from "@/lib/mock";

export function SymbolCombobox({
  symbols,
  value,
  onChange,
}: {
  symbols: SymbolInfo[];
  value: string;
  onChange: (symbol: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = symbols.find((s) => s.symbol === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? symbols.filter((s) => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      : symbols;
    return {
      index: list.filter((s) => s.kind === "index"),
      stock: list.filter((s) => s.kind === "stock"),
    };
  }, [symbols, query]);
  const flat = [...filtered.index, ...filtered.stock];

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(s: SymbolInfo) {
    onChange(s.symbol);
    setQuery("");
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(flat.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[hi]) pick(flat[hi]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const display = open ? query : selected ? `${selected.symbol}` : "";

  // Plain render helper (not a component) so list items keep identity across renders.
  function renderGroup(title: string, items: SymbolInfo[], offset: number) {
    if (items.length === 0) return null;
    return (
      <div key={title}>
        <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">{title}</div>
        {items.map((s, i) => {
          const idx = offset + i;
          return (
            <button
              type="button"
              key={s.symbol}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
              onMouseEnter={() => setHi(idx)}
              className={`flex w-full items-center justify-between px-2 py-1 text-left text-sm ${
                idx === hi ? "bg-surface-2" : ""
              } ${s.symbol === value ? "text-accent" : ""}`}
            >
              <span className="font-medium">{s.symbol}</span>
              <span className="ml-2 truncate text-xs text-muted">
                {s.name}
                {s.sector ? ` · ${s.sector}` : ""}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        className="input"
        role="combobox"
        aria-expanded={open}
        aria-controls="symbol-listbox"
        placeholder="Search symbol or name…"
        value={display}
        onFocus={() => {
          setOpen(true);
          setHi(0);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHi(0);
        }}
        onKeyDown={onKey}
      />
      {selected && !open ? (
        <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 truncate text-xs text-muted" style={{ maxWidth: "55%" }}>
          {selected.name}
        </div>
      ) : null}
      {open ? (
        <div
          id="symbol-listbox"
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-surface py-1 shadow-xl"
        >
          {flat.length === 0 ? (
            <div className="px-2 py-2 text-sm text-muted">No matches</div>
          ) : (
            <>
              {renderGroup("Indices", filtered.index, 0)}
              {renderGroup("Stocks", filtered.stock, filtered.index.length)}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
