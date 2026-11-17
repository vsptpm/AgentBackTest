"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  MouseEventParams,
  SeriesMarker,
  TickMarkType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { Candle, Interval, Overlay, Trade } from "@/lib/types";
import { fmtINR, fmtISTDateTime, fmtNum, fmtR } from "@/lib/format";
import { pnlClass } from "@/components/ui";

type LC = typeof import("lightweight-charts");

export interface TradeChartProps {
  candles: Candle[];
  trades: Trade[];
  overlays?: Overlay[];
  interval: Interval;
  selectedTradeId: number | null;
  onSelectTrade(id: number | null): void;
}

const HEIGHT = 460;
const PAD_BARS = 30;
const IST = "Asia/Kolkata";

/** Fallbacks mirror globals.css; live values are read from CSS tokens at mount. */
const FALLBACK = {
  bg: "#0b0e13",
  surface: "#121720",
  border: "#242d3c",
  borderStrong: "#34405a",
  text: "#e6e9ef",
  muted: "#8b94a7",
  green: "#22c55e",
  red: "#ef4444",
  amber: "#f59e0b",
  accent: "#38bdf8",
};
type Theme = typeof FALLBACK;

/** TradingView-like chart palette (chart canvas only; toolbar/summary keep the app tokens). */
const TV = {
  bg: "#0f1420",
  grid: "#1a2130",
  axis: "#232b3b",
  up: "#26a69a",
  down: "#ef5350",
  entry: "#b2b5be",
  tick: "#ffffff",
};

const OVERLAY_PALETTE = ["#38bdf8", "#f59e0b", "#a78bfa", "#f472b6", "#2dd4bf", "#fb923c"];

const EXIT_SHORT: Record<Trade["exitReason"], string> = {
  stop: "SL",
  target: "TP",
  signal: "SIG",
  squareoff: "SQ",
  end: "END",
};

const EXIT_LABEL: Record<Trade["exitReason"], string> = {
  stop: "stop",
  target: "target",
  signal: "signal",
  squareoff: "square-off",
  end: "end of data",
};

function readTheme(): Theme {
  if (typeof window === "undefined") return FALLBACK;
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    bg: get("--bg", FALLBACK.bg),
    surface: get("--surface", FALLBACK.surface),
    border: get("--border", FALLBACK.border),
    borderStrong: get("--border-strong", FALLBACK.borderStrong),
    text: get("--text", FALLBACK.text),
    muted: get("--muted", FALLBACK.muted),
    green: get("--green", FALLBACK.green),
    red: get("--red", FALLBACK.red),
    amber: get("--amber", FALLBACK.amber),
    accent: get("--accent", FALLBACK.accent),
  };
}

/** #rrggbb → rgba(...) with the given alpha. Falls back to the input for non-hex colours. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function toTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

function timeToMs(t: Time): number {
  if (typeof t === "number") return t * 1000;
  if (typeof t === "string") return Date.parse(t);
  return Date.UTC(t.year, t.month - 1, t.day);
}

/** Index of the last candle with time <= ms (binary search). -1 if before the first candle. */
function indexAtOrBefore(candles: Candle[], ms: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= ms) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Snap an arbitrary ms timestamp onto the candle grid so markers/lines land on real bars. */
function snapTime(candles: Candle[], ms: number): UTCTimestamp | null {
  if (candles.length === 0) return null;
  const i = indexAtOrBefore(candles, ms);
  return toTime(candles[Math.max(0, i)].time);
}

const fmtTickYear = new Intl.DateTimeFormat("en-IN", { timeZone: IST, year: "numeric" });
const fmtTickMonth = new Intl.DateTimeFormat("en-IN", { timeZone: IST, month: "short", year: "2-digit" });
const fmtTickDay = new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "2-digit", month: "short" });
const fmtTickTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const fmtCrossDate = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function makeFormatters(lc: LC, interval: Interval) {
  const daily = interval === "1d";
  const timeFormatter = (t: Time): string => {
    const ms = timeToMs(t);
    if (!Number.isFinite(ms)) return "";
    return daily
      ? fmtCrossDate.format(new Date(ms))
      : fmtISTDateTime(ms);
  };
  const tickMarkFormatter = (t: Time, type: TickMarkType): string | null => {
    const ms = timeToMs(t);
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    switch (type) {
      case lc.TickMarkType.Year:
        return fmtTickYear.format(d);
      case lc.TickMarkType.Month:
        return fmtTickMonth.format(d);
      case lc.TickMarkType.DayOfMonth:
        return fmtTickDay.format(d);
      default:
        return daily ? fmtTickDay.format(d) : fmtTickTime.format(d);
    }
  };
  return { timeFormatter, tickMarkFormatter };
}

export function TradeChart({ candles, trades, overlays, interval, selectedTradeId, onSelectTrade }: TradeChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lcRef = useRef<LC | null>(null);
  const themeRef = useRef<Theme>(FALLBACK);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const overlaySeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const zoneSeriesRef = useRef<ISeriesApi<"Baseline">[]>([]);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const [ready, setReady] = useState(false);

  const [hiddenOverlays, setHiddenOverlays] = useState<Set<string>>(() => new Set());
  const [showAllLevels, setShowAllLevels] = useState(false);

  // Sorted, de-duplicated candles: lightweight-charts requires strictly ascending unique times.
  const cleanCandles = useMemo(() => {
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const out: Candle[] = [];
    for (const c of sorted) {
      const prev = out[out.length - 1];
      if (prev && toTime(prev.time) === toTime(c.time)) out[out.length - 1] = c;
      else out.push(c);
    }
    return out;
  }, [candles]);

  const ordered = useMemo(() => [...trades].sort((a, b) => a.entryTime - b.entryTime || a.id - b.id), [trades]);
  const selectedIdx = selectedTradeId == null ? -1 : ordered.findIndex((t) => t.id === selectedTradeId);
  const selected = selectedIdx >= 0 ? ordered[selectedIdx] : null;

  // ---- create chart once -------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    let ro: ResizeObserver | null = null;
    let chart: IChartApi | null = null;

    void import("lightweight-charts").then((lc) => {
      if (disposed || !containerRef.current) return;
      lcRef.current = lc;
      const theme = readTheme();
      themeRef.current = theme;
      const { timeFormatter, tickMarkFormatter } = makeFormatters(lc, interval);

      chart = lc.createChart(el, {
        width: el.clientWidth || 600,
        height: HEIGHT,
        layout: {
          background: { type: lc.ColorType.Solid, color: TV.bg },
          textColor: theme.muted,
          fontSize: 11,
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: TV.grid },
          horzLines: { color: TV.grid },
        },
        crosshair: {
          mode: lc.CrosshairMode.Normal,
          vertLine: { color: theme.borderStrong, labelBackgroundColor: theme.borderStrong },
          horzLine: { color: theme.borderStrong, labelBackgroundColor: theme.borderStrong },
        },
        rightPriceScale: { borderColor: TV.axis },
        timeScale: {
          borderColor: TV.axis,
          timeVisible: interval !== "1d",
          secondsVisible: false,
          rightOffset: 4,
          tickMarkFormatter,
        },
        localization: { locale: "en-IN", timeFormatter },
        handleScroll: true,
        handleScale: true,
      });

      const candleSeries = chart.addSeries(lc.CandlestickSeries, {
        upColor: TV.up,
        downColor: TV.down,
        borderVisible: false,
        wickUpColor: TV.up,
        wickDownColor: TV.down,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      candleSeriesRef.current = candleSeries;
      markersRef.current = lc.createSeriesMarkers(candleSeries, []);

      ro = new ResizeObserver((entries) => {
        const w = Math.floor(entries[0]?.contentRect.width ?? el.clientWidth);
        if (w > 0 && chart) chart.applyOptions({ width: w, height: HEIGHT });
      });
      ro.observe(el);

      chartRef.current = chart;
      setReady(true);
    });

    return () => {
      disposed = true;
      ro?.disconnect();
      chart?.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      markersRef.current = null;
      overlaySeriesRef.current = new Map();
      zoneSeriesRef.current = [];
      priceLinesRef.current = [];
      setReady(false);
    };
    // Chart is created once; interval changes are applied via applyOptions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- click → trade -----------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart) return;
    const handler = (p: MouseEventParams<Time>) => {
      const objectId = p.hoveredInfo?.objectId;
      if (typeof objectId === "string" && objectId.startsWith("trade:")) {
        const id = Number(objectId.split(":")[1]);
        if (Number.isFinite(id)) {
          onSelectTrade(id);
          return;
        }
      }
      if (p.time === undefined) return;
      const ms = timeToMs(p.time);
      // A bar's span is [time, nextTime), so a click anywhere on the bar matches trades covering it.
      const i = indexAtOrBefore(cleanCandles, ms);
      const barEnd = i >= 0 && i + 1 < cleanCandles.length ? cleanCandles[i + 1].time : Infinity;
      const barStart = i >= 0 ? cleanCandles[i].time : ms;
      let best: Trade | null = null;
      for (const t of ordered) {
        if (t.entryTime < barEnd && t.exitTime >= barStart) {
          if (!best || t.exitTime - t.entryTime < best.exitTime - best.entryTime) best = t;
        }
      }
      if (best) onSelectTrade(best.id);
    };
    chart.subscribeClick(handler);
    return () => chart.unsubscribeClick(handler);
  }, [ready, ordered, cleanCandles, onSelectTrade]);

  // ---- interval → axis formatting ----------------------------------------
  useEffect(() => {
    const chart = chartRef.current;
    const lc = lcRef.current;
    if (!ready || !chart || !lc) return;
    const { timeFormatter, tickMarkFormatter } = makeFormatters(lc, interval);
    chart.applyOptions({
      timeScale: { timeVisible: interval !== "1d", tickMarkFormatter },
      localization: { timeFormatter },
    });
  }, [ready, interval]);

  // ---- candles -----------------------------------------------------------
  useEffect(() => {
    const s = candleSeriesRef.current;
    if (!ready || !s) return;
    s.setData(
      cleanCandles.map((c) => ({
        time: toTime(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
  }, [ready, cleanCandles]);

  // ---- overlays ----------------------------------------------------------
  const overlayList = useMemo(() => overlays ?? [], [overlays]);
  useEffect(() => {
    const chart = chartRef.current;
    const lc = lcRef.current;
    if (!ready || !chart || !lc) return;
    for (const s of overlaySeriesRef.current.values()) chart.removeSeries(s);
    const map = new Map<string, ISeriesApi<"Line">>();
    overlayList.forEach((o, i) => {
      const color = o.color ?? OVERLAY_PALETTE[i % OVERLAY_PALETTE.length];
      const step = o.style === "step";
      const series = chart.addSeries(lc.LineSeries, {
        color,
        lineWidth: 1,
        lineType: step ? lc.LineType.WithSteps : lc.LineType.Simple,
        lineStyle: step ? lc.LineStyle.Dotted : lc.LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: !hiddenOverlays.has(o.name),
      });
      const pts = [...o.points]
        .filter((p) => Number.isFinite(p.value))
        .sort((a, b) => a.time - b.time);
      const data: { time: UTCTimestamp; value: number }[] = [];
      for (const p of pts) {
        const t = toTime(p.time);
        const prev = data[data.length - 1];
        if (prev && prev.time === t) prev.value = p.value;
        else data.push({ time: t, value: p.value });
      }
      series.setData(data);
      map.set(o.name, series);
    });
    overlaySeriesRef.current = map;
    // hiddenOverlays is applied in its own effect to avoid rebuilding series on toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, overlayList]);

  useEffect(() => {
    for (const [name, s] of overlaySeriesRef.current) {
      s.applyOptions({ visible: !hiddenOverlays.has(name) });
    }
  }, [hiddenOverlays, ready]);

  // ---- trade markers -----------------------------------------------------
  useEffect(() => {
    const plugin = markersRef.current;
    if (!ready || !plugin) return;
    const theme = themeRef.current;
    const markers: SeriesMarker<Time>[] = [];
    for (const t of ordered) {
      const et = snapTime(cleanCandles, t.entryTime);
      const xt = snapTime(cleanCandles, t.exitTime);
      if (et == null || xt == null) continue;
      const long = t.side === "long";
      const sel = t.id === selectedTradeId;
      markers.push({
        id: `trade:${t.id}:entry`,
        time: et,
        position: long ? "belowBar" : "aboveBar",
        shape: long ? "arrowUp" : "arrowDown",
        color: long ? TV.up : TV.down,
        text: long ? "L" : "S",
        size: sel ? 2 : 1,
      });
      if (sel) {
        // White tick at the exact fill price of the selected trade's entry.
        markers.push({
          id: `trade:${t.id}:fill`,
          time: et,
          position: "atPriceMiddle",
          price: t.entryPrice,
          shape: "square",
          color: TV.tick,
          size: 0.4,
        });
      }
      const win = t.netPnl > 0;
      markers.push({
        id: `trade:${t.id}:exit`,
        time: xt,
        position: long ? "aboveBar" : "belowBar",
        shape: "circle",
        color: win ? TV.up : t.netPnl < 0 ? TV.down : theme.muted,
        text: `${win ? "✓ " : t.netPnl < 0 ? "✕ " : ""}${EXIT_SHORT[t.exitReason]}`,
        size: sel ? 1.5 : 0.8,
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    plugin.setMarkers(markers);
  }, [ready, ordered, cleanCandles, selectedTradeId]);

  // ---- position boxes (risk / reward zones) + labelled price lines ---------
  useEffect(() => {
    const chart = chartRef.current;
    const lc = lcRef.current;
    const candleSeries = candleSeriesRef.current;
    if (!ready || !chart || !lc || !candleSeries) return;
    for (const s of zoneSeriesRef.current) chart.removeSeries(s);
    zoneSeriesRef.current = [];
    for (const pl of priceLinesRef.current) candleSeries.removePriceLine(pl);
    priceLinesRef.current = [];

    /**
     * One translucent box between the entry price and `level`, spanning entry→exit.
     * A BaselineSeries fills between its base (entry) and the data line (level); because the
     * level can sit above (long target / short stop) or below entry, both fill directions get
     * the same colour so reward is always green and risk always red regardless of side.
     */
    const addZone = (t: Trade, level: number | undefined, color: string, faint: boolean) => {
      if (level == null || !Number.isFinite(level)) return;
      const et = snapTime(cleanCandles, t.entryTime);
      const xt = snapTime(cleanCandles, t.exitTime);
      if (et == null || xt == null) return;
      const fill1 = withAlpha(color, faint ? 0.1 : 0.35);
      const fill2 = withAlpha(color, faint ? 0.06 : 0.15);
      const series = chart.addSeries(lc.BaselineSeries, {
        baseValue: { type: "price", price: t.entryPrice },
        relativeGradient: false,
        topFillColor1: fill1,
        topFillColor2: fill2,
        topLineColor: faint ? withAlpha(color, 0.25) : color,
        bottomFillColor1: fill2,
        bottomFillColor2: fill1,
        bottomLineColor: faint ? withAlpha(color, 0.25) : color,
        lineWidth: 1,
        lineVisible: !faint,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: faint ? () => null : undefined,
      });
      series.setData(et === xt ? [{ time: et, value: level }] : [{ time: et, value: level }, { time: xt, value: level }]);
      zoneSeriesRef.current.push(series);
    };

    if (showAllLevels) {
      for (const t of ordered) {
        if (t.id === selectedTradeId) continue;
        addZone(t, t.stop, TV.down, true);
        addZone(t, t.target, TV.up, true);
      }
    }
    if (selected) {
      addZone(selected, selected.stop, TV.down, false);
      addZone(selected, selected.target, TV.up, false);

      const e = selected.entryPrice;
      const pct = (p: number) => `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}%`;
      const addPriceLine = (price: number | undefined, color: string, title: string, dashed: boolean) => {
        if (price == null || !Number.isFinite(price)) return;
        priceLinesRef.current.push(
          candleSeries.createPriceLine({
            price,
            color,
            lineWidth: 1,
            lineStyle: dashed ? lc.LineStyle.Dashed : lc.LineStyle.Solid,
            axisLabelVisible: true,
            title,
          }),
        );
      };
      // Percentages are in P&L direction: risk is always negative, reward always positive.
      if (selected.stop != null) {
        addPriceLine(selected.stop, TV.down, `SL ${fmtNum(selected.stop, 2)} (${pct((-Math.abs(selected.stop - e) / e) * 100)})`, false);
      }
      if (selected.target != null) {
        addPriceLine(selected.target, TV.up, `TP ${fmtNum(selected.target, 2)} (${pct((Math.abs(selected.target - e) / e) * 100)})`, false);
      }
      addPriceLine(e, TV.entry, `ENTRY ${fmtNum(e, 2)}`, true);
    }
  }, [ready, ordered, cleanCandles, selected, selectedTradeId, showAllLevels]);

  // ---- viewport follows selection ----------------------------------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart || cleanCandles.length === 0) return;
    const ts = chart.timeScale();
    if (!selected) {
      ts.fitContent();
      return;
    }
    const n = cleanCandles.length;
    const i0 = Math.max(0, indexAtOrBefore(cleanCandles, selected.entryTime));
    const i1 = Math.max(i0, indexAtOrBefore(cleanCandles, selected.exitTime));
    const from = Math.max(0, i0 - PAD_BARS);
    const to = Math.min(n - 1, i1 + PAD_BARS);
    ts.setVisibleRange({ from: toTime(cleanCandles[from].time), to: toTime(cleanCandles[to].time) });
  }, [ready, selected, cleanCandles]);

  // ---- toolbar actions ---------------------------------------------------
  const step = useCallback(
    (delta: 1 | -1) => {
      if (ordered.length === 0) return;
      const next = selectedIdx < 0 ? (delta === 1 ? 0 : ordered.length - 1) : selectedIdx + delta;
      if (next < 0 || next >= ordered.length) return;
      onSelectTrade(ordered[next].id);
    },
    [ordered, selectedIdx, onSelectTrade],
  );

  function toggleOverlay(name: string) {
    setHiddenOverlays((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const hasData = cleanCandles.length > 0;

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2 text-xs">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn px-2 py-1 text-xs"
            onClick={() => step(-1)}
            disabled={ordered.length === 0 || selectedIdx === 0}
            aria-label="Previous trade"
          >
            ◀ Prev trade
          </button>
          <button
            type="button"
            className="btn px-2 py-1 text-xs"
            onClick={() => step(1)}
            disabled={ordered.length === 0 || selectedIdx === ordered.length - 1}
            aria-label="Next trade"
          >
            Next trade ▶
          </button>
          <button
            type="button"
            className="btn px-2 py-1 text-xs"
            onClick={() => onSelectTrade(null)}
            disabled={!hasData}
            title="Clear selection and show the whole period"
          >
            Fit all
          </button>
        </div>
        <span className="font-mono text-muted" aria-live="polite">
          Trade {selectedIdx >= 0 ? selectedIdx + 1 : "—"} / {ordered.length}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          {overlayList.map((o, i) => {
            const color = o.color ?? OVERLAY_PALETTE[i % OVERLAY_PALETTE.length];
            const on = !hiddenOverlays.has(o.name);
            return (
              <label key={o.name} className="inline-flex cursor-pointer select-none items-center gap-1.5">
                <input type="checkbox" checked={on} onChange={() => toggleOverlay(o.name)} />
                <span
                  className="inline-block h-0.5 w-4 rounded"
                  style={{
                    background: color,
                    opacity: on ? 1 : 0.35,
                    borderTop: o.style === "step" ? `2px dotted ${color}` : undefined,
                  }}
                  aria-hidden
                />
                <span className={on ? "" : "text-muted line-through"}>{o.name}</span>
              </label>
            );
          })}
          <label className="inline-flex cursor-pointer select-none items-center gap-1.5">
            <input type="checkbox" checked={showAllLevels} onChange={(e) => setShowAllLevels(e.target.checked)} />
            <span>Show all trades&apos; zones</span>
          </label>
        </div>
      </div>

      <div className="relative" style={{ height: HEIGHT }}>
        <div ref={containerRef} className="absolute inset-0" />
        {!hasData ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
            No candles in this result
          </div>
        ) : !ready ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
            <span className="spinner" />
          </div>
        ) : null}
      </div>

      <div className="border-t border-border px-3 py-2 text-xs">
        {selected ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-muted">#{selected.id}</span>
            <span className={`font-semibold uppercase ${selected.side === "long" ? "text-green" : "text-red"}`}>
              {selected.side}
            </span>
            <span>
              <span className="text-muted">in </span>
              {fmtISTDateTime(selected.entryTime)} @ {fmtNum(selected.entryPrice, 2)}
            </span>
            <span>
              <span className="text-muted">out </span>
              {fmtISTDateTime(selected.exitTime)} @ {fmtNum(selected.exitPrice, 2)}
            </span>
            <span>
              <span className="text-muted">stop </span>
              <span className="text-red">{selected.stop != null ? fmtNum(selected.stop, 2) : "—"}</span>
            </span>
            <span>
              <span className="text-muted">target </span>
              <span className="text-green">{selected.target != null ? fmtNum(selected.target, 2) : "—"}</span>
            </span>
            <span>
              <span className="text-muted">qty </span>
              {fmtNum(selected.qty, 0)}
            </span>
            <span className={`font-medium ${pnlClass(selected.netPnl)}`}>{fmtINR(selected.netPnl)} net</span>
            <span className={pnlClass(selected.rMultiple)}>{fmtR(selected.rMultiple)}</span>
            <span>
              <span className="text-muted">exit </span>
              {EXIT_LABEL[selected.exitReason]}
            </span>
            {selected.entryReason ? (
              <span className="text-muted">
                entry <span className="text-text">{selected.entryReason}</span>
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-muted">
            {ordered.length > 0
              ? "Click a marker or a bar inside a trade, or pick a row in the trade table, to inspect a trade."
              : "No trades to show."}
          </span>
        )}
      </div>
    </div>
  );
}
