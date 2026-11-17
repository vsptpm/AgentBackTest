"use client";

import { useEffect, useState } from "react";
import { errorMessage, fetchStrategies, fetchSymbols, type StrategyInfo, type SymbolInfo } from "@/components/api";

export interface Catalog {
  strategies: StrategyInfo[];
  symbols: SymbolInfo[];
  loading: boolean;
  error: string | null;
}

/** Loads strategies + symbols once; falls back to mocks when routes are missing. */
export function useCatalog(): Catalog {
  const [state, setState] = useState<Catalog>({ strategies: [], symbols: [], loading: true, error: null });

  useEffect(() => {
    let alive = true;
    Promise.all([fetchStrategies(), fetchSymbols()])
      .then(([strategies, symbols]) => {
        if (alive) setState({ strategies, symbols, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (alive) setState((s) => ({ ...s, loading: false, error: errorMessage(e) }));
      });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
