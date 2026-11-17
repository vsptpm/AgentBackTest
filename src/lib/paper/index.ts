// Paper trading: server side. Keeps a local ledger under .cache/ and, when a sandbox token is
// configured, sends the entry order to the Upstox sandbox.
//
// The Upstox sandbox only accepts order requests (place / modify / cancel). It does not simulate
// fills, positions or P&L, so those are tracked here from live prices (Upstox when logged in, else Yahoo).
// Orders use ONLY the sandbox token and sandbox host below; the live Upstox login is never used to trade.
//
// Config (.env.local, never sent to the browser):
//   UPSTOX_SANDBOX_TOKEN   sandbox access token (Upstox developer console → Apps → Sandbox → Generate; valid 30 days)
//   UPSTOX_ORDER_BASE      optional, defaults to the sandbox host below

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "@/lib/types";
import { istDateKey } from "@/lib/data/yahoo";
import { fetchLiveCandles } from "@/lib/data/live";
import { upstoxInstrumentKey } from "@/lib/data/upstox";
import { closeManually, entryFill, rejectReason, settleTrade, summarise, type PaperRequest, type PaperState, type PaperTrade } from "./settle";

export * from "./settle";

const SANDBOX_BASE = "https://api-sandbox.upstox.com";

const dir = () => path.join(process.cwd(), ".cache");
const ledgerFile = () => path.join(dir(), "paper-trades.json");

async function readLedger(): Promise<PaperTrade[]> {
  try {
    const v: unknown = JSON.parse(await readFile(ledgerFile(), "utf8"));
    return Array.isArray(v) ? (v as PaperTrade[]) : [];
  } catch {
    return [];
  }
}

async function writeLedger(trades: PaperTrade[]): Promise<void> {
  await mkdir(dir(), { recursive: true });
  await writeFile(ledgerFile(), JSON.stringify(trades, null, 2), "utf8");
}

export function upstoxConnected(): boolean {
  return !!process.env.UPSTOX_SANDBOX_TOKEN?.trim();
}

// --- Upstox ---------------------------------------------------------------

/** Intraday equity market order to the Upstox sandbox. Returns the order id. */
async function placeUpstoxOrder(symbol: string, side: "BUY" | "SELL", qty: number, now: number): Promise<string> {
  const token = process.env.UPSTOX_SANDBOX_TOKEN?.trim();
  if (!token) throw new Error("not connected");
  const key = symbol.startsWith("^") ? null : await upstoxInstrumentKey(symbol, now);
  if (!key) throw new Error(`${symbol} not found in the Upstox NSE equity list`);

  const base = (process.env.UPSTOX_ORDER_BASE?.trim() || SANDBOX_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/v3/order/place`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      quantity: qty,
      product: "I", // intraday
      validity: "DAY",
      price: 0,
      tag: "paper",
      instrument_token: key,
      order_type: "MARKET",
      transaction_type: side,
      disclosed_quantity: 0,
      trigger_price: 0,
      is_amo: false,
      slice: false,
    }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as {
    status?: string;
    data?: { order_ids?: string[]; order_id?: string };
    errors?: { message?: string; errorCode?: string; error_code?: string }[];
  } | null;
  const id = body?.data?.order_ids?.[0] ?? body?.data?.order_id;
  if (!res.ok || body?.status !== "success" || !id) {
    const e = body?.errors?.[0];
    throw new Error(e?.message ? `${e.message}${e.errorCode ?? e.error_code ? ` (${e.errorCode ?? e.error_code})` : ""}` : `Upstox responded ${res.status}`);
  }
  return id;
}

// --- Ledger operations ------------------------------------------------------

/** Bring every open trade up to date with the latest prices, closing those that hit stop/target/square-off. */
async function settleAll(trades: PaperTrade[], now: number): Promise<{ trades: PaperTrade[]; changed: boolean }> {
  const openSymbols = [...new Set(trades.filter((t) => t.status === "open").map((t) => t.symbol))];
  if (openSymbols.length === 0) return { trades, changed: false };
  const candlesBy: Record<string, Candle[]> = {};
  await Promise.all(
    openSymbols.map(async (symbol) => {
      const oldest = Math.min(...trades.filter((t) => t.status === "open" && t.symbol === symbol).map((t) => t.placedAt));
      try {
        candlesBy[symbol] = (await fetchLiveCandles({ symbol, interval: "5m", from: istDateKey(oldest), to: istDateKey(now) }, now)).candles;
      } catch {
        /* price fetch failed: leave the trade as it is, try again next refresh */
      }
    }),
  );
  let changed = false;
  const next = trades.map((t) => {
    if (t.status !== "open" || !candlesBy[t.symbol]) return t;
    const s = settleTrade(t, candlesBy[t.symbol], now);
    if (s !== t) changed = true;
    return s;
  });
  return { trades: next, changed };
}

/** `amount` = money set aside for trading; needed to judge the daily limits. */
export async function getPaperState(amount?: number, now: number = Date.now()): Promise<PaperState> {
  const { trades, changed } = await settleAll(await readLedger(), now);
  if (changed) await writeLedger(trades);
  return summarise(trades, now, upstoxConnected(), amount);
}

/** Take a paper trade if it passes every rule in rejectReason. Throws a plain-language Error if not. */
export async function placePaperTrade(req: PaperRequest, now: number = Date.now()): Promise<PaperState> {
  const { trades } = await settleAll(await readLedger(), now);
  const why = rejectReason(req, trades, now);
  if (why) throw new Error(why);

  const upstox: PaperTrade["upstox"] = { connected: upstoxConnected() };
  if (upstox.connected) {
    try {
      upstox.orderId = await placeUpstoxOrder(req.symbol, req.side === "long" ? "BUY" : "SELL", req.qty, now);
    } catch (e) {
      upstox.error = (e as Error).message;
    }
  }

  // A market order: filled a little worse than the price on screen.
  const fill = entryFill(req.side, req.entryPrice);
  trades.push({
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    placedAt: now,
    symbol: req.symbol,
    strategyName: req.strategyName,
    side: req.side,
    qty: req.qty,
    entryPrice: fill,
    stop: req.stop as number, // rejectReason guarantees a stop
    target: req.target,
    leverage: req.leverage ?? 1,
    status: "open",
    lastPrice: req.entryPrice,
    unrealisedPnl: (req.entryPrice - fill) * req.qty * (req.side === "long" ? 1 : -1),
    upstox,
  });
  await writeLedger(trades);
  return summarise(trades, now, upstox.connected, req.amount);
}

/** Close one open trade at its latest known price. Sends the opposite order to the sandbox when connected. */
export async function closePaperTrade(id: string, amount?: number, now: number = Date.now()): Promise<PaperState> {
  const { trades } = await settleAll(await readLedger(), now);
  const next = await Promise.all(
    trades.map(async (t) => {
      if (t.id !== id || t.status !== "open") return t;
      if (upstoxConnected()) {
        try {
          await placeUpstoxOrder(t.symbol, t.side === "long" ? "SELL" : "BUY", t.qty, now);
        } catch {
          /* local ledger is the source of truth for paper results */
        }
      }
      return closeManually(t, t.lastPrice ?? t.entryPrice, now);
    }),
  );
  await writeLedger(next);
  return summarise(next, now, upstoxConnected(), amount);
}

/** Wipe the ledger. */
export async function resetPaper(amount?: number, now: number = Date.now()): Promise<PaperState> {
  await writeLedger([]);
  return summarise([], now, upstoxConnected(), amount);
}
