import type { MonthlyPnl } from "@/lib/types";
import { fmtINR } from "@/lib/format";
import { pnlClass } from "@/components/ui";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function cellStyle(pnl: number, maxAbs: number): React.CSSProperties {
  if (!pnl || maxAbs === 0) return {};
  const alpha = 0.12 + 0.6 * Math.min(1, Math.abs(pnl) / maxAbs);
  const base = pnl > 0 ? "34,197,94" : "239,68,68";
  return { backgroundColor: `rgba(${base},${alpha.toFixed(2)})` };
}

export function MonthlyHeatmap({ monthly }: { monthly: MonthlyPnl[] }) {
  if (monthly.length === 0) {
    return <div className="card px-3 py-6 text-center text-sm text-muted">No monthly data</div>;
  }
  const byKey = new Map(monthly.map((m) => [m.month, m]));
  const years = [...new Set(monthly.map((m) => Number(m.month.slice(0, 4))))].sort((a, b) => a - b);
  const maxAbs = Math.max(...monthly.map((m) => Math.abs(m.pnl)), 0);

  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-xs">
        <thead>
          <tr className="text-muted">
            <th className="px-2 py-1.5 text-left font-medium">Year</th>
            {MONTHS.map((m) => (
              <th key={m} className="px-1 py-1.5 text-right font-medium">
                {m}
              </th>
            ))}
            <th className="px-2 py-1.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            let total = 0;
            let trades = 0;
            const cells = MONTHS.map((_, i) => {
              const key = `${y}-${String(i + 1).padStart(2, "0")}`;
              const row = byKey.get(key);
              if (row) {
                total += row.pnl;
                trades += row.trades;
              }
              return (
                <td
                  key={key}
                  className="border-t border-border px-1 py-1.5 text-right"
                  style={row ? cellStyle(row.pnl, maxAbs) : undefined}
                  title={row ? `${MONTHS[i]} ${y} · ${fmtINR(row.pnl)} · ${row.trades} trades` : `${MONTHS[i]} ${y} · no trades`}
                >
                  {row ? (
                    <span className={row.pnl === 0 ? "text-muted" : "text-text"}>{fmtINR(row.pnl, { compact: true })}</span>
                  ) : (
                    <span className="text-border-strong">·</span>
                  )}
                </td>
              );
            });
            return (
              <tr key={y}>
                <td className="border-t border-border px-2 py-1.5 font-medium text-muted">{y}</td>
                {cells}
                <td
                  className={`border-t border-border px-2 py-1.5 text-right font-semibold ${pnlClass(total)}`}
                  title={`${y} · ${fmtINR(total)} · ${trades} trades`}
                >
                  {fmtINR(total, { compact: true })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
