import type { Interval, ParamSpec, Params, Strategy } from "@/lib/types";
import { createEmaCross } from "./emaCross";
import { createRsiReversion } from "./rsiReversion";
import { createOrb } from "./orb";
import { createSupertrend } from "./supertrend";
import { createBollingerReversion } from "./bollingerReversion";
import { createVwapReclaim } from "./vwapReclaim";
import { createOrderBlock } from "./orderBlock";
import { createMtfTrend } from "./mtf";
import { createOrbRvol } from "./orbRvol";
import { createSwingFade } from "./swingFade";

/** Factories, not singletons: strategies hold per-run state, so every backtest gets a fresh instance. */
const FACTORIES: Record<string, () => Strategy> = {
  "ema-cross": createEmaCross,
  "rsi-reversion": createRsiReversion,
  orb: createOrb,
  "orb-rvol": createOrbRvol,
  supertrend: createSupertrend,
  "bb-reversion": createBollingerReversion,
  "vwap-reclaim": createVwapReclaim,
  "order-block": createOrderBlock,
  "mtf-trend": createMtfTrend,
  "swing-fade": createSwingFade,
};

export interface StrategyMeta {
  id: string;
  name: string;
  description: string;
  intervals: Interval[];
  params: ParamSpec[];
  warmup: number;
}

export function createStrategy(id: string): Strategy {
  const f = FACTORIES[id];
  if (!f) throw new Error(`Unknown strategy: ${id}`);
  return f();
}

export function listStrategies(): StrategyMeta[] {
  return Object.keys(FACTORIES).map((id) => {
    const s = FACTORIES[id]();
    return { id: s.id, name: s.name, description: s.description, intervals: s.intervals, params: s.params, warmup: s.warmup };
  });
}

export function defaultParams(meta: Pick<StrategyMeta, "params">): Params {
  const out: Params = {};
  for (const p of meta.params) out[p.key] = p.default;
  return out;
}

/** Fill in missing keys with defaults and coerce numeric strings. */
export function normaliseParams(meta: Pick<StrategyMeta, "params">, input: Params | undefined): Params {
  const out = defaultParams(meta);
  if (!input) return out;
  for (const p of meta.params) {
    const v = input[p.key];
    if (v === undefined || v === null || v === "") continue;
    if (p.type === "number") {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) out[p.key] = n;
    } else {
      const s = String(v);
      if (!p.options || p.options.includes(s)) out[p.key] = s;
    }
  }
  return out;
}
