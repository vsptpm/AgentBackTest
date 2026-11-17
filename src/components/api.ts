// Client-side API helpers with deterministic mock fallbacks.
// Set NEXT_PUBLIC_USE_MOCK=1 to force mocks without hitting the routes.

import type { BacktestConfig, BacktestResult, FinderConfig, FinderRow } from "@/lib/types";
import {
  MOCK_STRATEGIES,
  MOCK_SYMBOLS,
  mockBacktestResult,
  mockFinderRows,
  type StrategyInfo,
  type SymbolInfo,
} from "@/lib/mock";

export type { StrategyInfo, SymbolInfo };

export interface FinderResponse {
  rows: FinderRow[];
  warnings: string[];
  elapsedMs: number;
  /** Symbol x strategy x setting combinations actually backtested. Absent on mock data. */
  candidatesTested?: number;
  /** Distinct trading days in each slice (first symbol). Absent on mock data. */
  sessions?: { tune: number; select: number; holdout: number };
}

const FORCE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "1";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Thrown when the route is unreachable (network error / 404 / non-JSON). Callers fall back to mock. */
class RouteUnavailable extends Error {}

function warnMock(what: string, reason: unknown): void {
  const why = reason instanceof Error ? reason.message : String(reason);
  console.warn(`[AgentBackTest] using mock ${what} (${why})`);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  if (FORCE_MOCK) throw new RouteUnavailable("NEXT_PUBLIC_USE_MOCK=1");
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new RouteUnavailable(e instanceof Error ? e.message : "network error");
  }
  if (res.status === 404 || res.status === 405) {
    throw new RouteUnavailable(`${res.status} ${url}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new RouteUnavailable(`non-JSON response from ${url}`);
  }
  const body: unknown = await res.json();
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

export async function fetchStrategies(): Promise<StrategyInfo[]> {
  try {
    const data = await request<{ strategies: StrategyInfo[] }>("/api/strategies");
    return data.strategies;
  } catch (e) {
    if (e instanceof RouteUnavailable) {
      warnMock("strategies", e);
      return MOCK_STRATEGIES;
    }
    throw e;
  }
}

export async function fetchSymbols(): Promise<SymbolInfo[]> {
  try {
    const data = await request<{ symbols: SymbolInfo[] }>("/api/symbols");
    return data.symbols;
  } catch (e) {
    if (e instanceof RouteUnavailable) {
      warnMock("symbols", e);
      return MOCK_SYMBOLS;
    }
    throw e;
  }
}

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  try {
    return await request<BacktestResult>("/api/backtest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
  } catch (e) {
    if (e instanceof RouteUnavailable) {
      warnMock("backtest result", e);
      await new Promise((r) => setTimeout(r, 600));
      return mockBacktestResult(config);
    }
    throw e;
  }
}

export async function runFinder(config: FinderConfig): Promise<FinderResponse> {
  try {
    return await request<FinderResponse>("/api/finder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
  } catch (e) {
    if (e instanceof RouteUnavailable) {
      warnMock("finder rows", e);
      await new Promise((r) => setTimeout(r, 1200));
      return {
        rows: mockFinderRows(),
        warnings: ["MOCK DATA — /api/finder unavailable, showing a deterministic sample."],
        elapsedMs: 1200,
      };
    }
    throw e;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
