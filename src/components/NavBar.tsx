"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/desk", label: "Trading desk" },
  { href: "/scan", label: "Today's signals" },
  { href: "/", label: "Test a strategy" },
  { href: "/finder", label: "Find what works" },
] as const;

export function NavBar() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/90 backdrop-blur">
      <div className="flex h-11 items-center gap-3 px-4 md:gap-6 md:px-6">
        <Link href="/scan" className="flex shrink-0 items-baseline gap-1.5 text-sm font-semibold tracking-tight">
          <span className="inline-block h-2 w-2 translate-y-[-1px] rounded-sm bg-accent" />
          <span className="hidden sm:inline">AgentBackTest</span>
          <span className="hidden font-normal text-muted sm:inline">· NSE</span>
        </Link>
        <nav className="flex items-center gap-1 overflow-x-auto whitespace-nowrap text-sm">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded px-2.5 py-1 transition-colors ${
                  active ? "bg-surface-2 text-text" : "text-muted hover:text-text"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto hidden text-[11px] text-muted sm:block">
          Times in IST · costs incl. brokerage, STT, GST
        </div>
      </div>
    </header>
  );
}
