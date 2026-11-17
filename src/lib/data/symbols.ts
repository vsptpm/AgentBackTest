// Curated universe of NSE indices and liquid F&O stocks (Yahoo Finance symbols).

export interface SymbolInfo {
  symbol: string;
  name: string;
  kind: "index" | "stock";
  sector?: string;
}

export const SYMBOLS: SymbolInfo[] = [
  // Indices
  { symbol: "^NSEI", name: "NIFTY 50", kind: "index" },
  { symbol: "^NSEBANK", name: "NIFTY BANK", kind: "index" },
  { symbol: "^CNXIT", name: "NIFTY IT", kind: "index" },

  // Energy / Oil & Gas
  { symbol: "RELIANCE.NS", name: "Reliance Industries", kind: "stock", sector: "Energy" },
  { symbol: "ONGC.NS", name: "Oil & Natural Gas Corp", kind: "stock", sector: "Energy" },
  { symbol: "BPCL.NS", name: "Bharat Petroleum", kind: "stock", sector: "Energy" },
  { symbol: "COALINDIA.NS", name: "Coal India", kind: "stock", sector: "Energy" },

  // IT
  { symbol: "TCS.NS", name: "Tata Consultancy Services", kind: "stock", sector: "IT" },
  { symbol: "INFY.NS", name: "Infosys", kind: "stock", sector: "IT" },
  { symbol: "WIPRO.NS", name: "Wipro", kind: "stock", sector: "IT" },
  { symbol: "HCLTECH.NS", name: "HCL Technologies", kind: "stock", sector: "IT" },
  { symbol: "TECHM.NS", name: "Tech Mahindra", kind: "stock", sector: "IT" },

  // Banks
  { symbol: "HDFCBANK.NS", name: "HDFC Bank", kind: "stock", sector: "Banking" },
  { symbol: "ICICIBANK.NS", name: "ICICI Bank", kind: "stock", sector: "Banking" },
  { symbol: "SBIN.NS", name: "State Bank of India", kind: "stock", sector: "Banking" },
  { symbol: "AXISBANK.NS", name: "Axis Bank", kind: "stock", sector: "Banking" },
  { symbol: "KOTAKBANK.NS", name: "Kotak Mahindra Bank", kind: "stock", sector: "Banking" },
  { symbol: "INDUSINDBK.NS", name: "IndusInd Bank", kind: "stock", sector: "Banking" },

  // Financial services
  { symbol: "BAJFINANCE.NS", name: "Bajaj Finance", kind: "stock", sector: "Financial Services" },
  { symbol: "BAJAJFINSV.NS", name: "Bajaj Finserv", kind: "stock", sector: "Financial Services" },

  // Infrastructure / Capital goods
  { symbol: "LT.NS", name: "Larsen & Toubro", kind: "stock", sector: "Infrastructure" },
  { symbol: "ADANIENT.NS", name: "Adani Enterprises", kind: "stock", sector: "Infrastructure" },
  { symbol: "ADANIPORTS.NS", name: "Adani Ports & SEZ", kind: "stock", sector: "Infrastructure" },

  // FMCG
  { symbol: "ITC.NS", name: "ITC", kind: "stock", sector: "FMCG" },
  { symbol: "HINDUNILVR.NS", name: "Hindustan Unilever", kind: "stock", sector: "FMCG" },
  { symbol: "TATACONSUM.NS", name: "Tata Consumer Products", kind: "stock", sector: "FMCG" },
  { symbol: "NESTLEIND.NS", name: "Nestle India", kind: "stock", sector: "FMCG" },
  { symbol: "BRITANNIA.NS", name: "Britannia Industries", kind: "stock", sector: "FMCG" },

  // Telecom
  { symbol: "BHARTIARTL.NS", name: "Bharti Airtel", kind: "stock", sector: "Telecom" },

  // Auto
  { symbol: "MARUTI.NS", name: "Maruti Suzuki", kind: "stock", sector: "Auto" },
  { symbol: "M&M.NS", name: "Mahindra & Mahindra", kind: "stock", sector: "Auto" },
  { symbol: "HEROMOTOCO.NS", name: "Hero MotoCorp", kind: "stock", sector: "Auto" },
  { symbol: "EICHERMOT.NS", name: "Eicher Motors", kind: "stock", sector: "Auto" },

  // Metals
  { symbol: "TATASTEEL.NS", name: "Tata Steel", kind: "stock", sector: "Metals" },
  { symbol: "JSWSTEEL.NS", name: "JSW Steel", kind: "stock", sector: "Metals" },
  { symbol: "HINDALCO.NS", name: "Hindalco Industries", kind: "stock", sector: "Metals" },

  // Power
  { symbol: "NTPC.NS", name: "NTPC", kind: "stock", sector: "Power" },
  { symbol: "POWERGRID.NS", name: "Power Grid Corp", kind: "stock", sector: "Power" },

  // Pharma / Healthcare
  { symbol: "SUNPHARMA.NS", name: "Sun Pharmaceutical", kind: "stock", sector: "Pharma" },
  { symbol: "DRREDDY.NS", name: "Dr. Reddy's Laboratories", kind: "stock", sector: "Pharma" },
  { symbol: "CIPLA.NS", name: "Cipla", kind: "stock", sector: "Pharma" },
  { symbol: "DIVISLAB.NS", name: "Divi's Laboratories", kind: "stock", sector: "Pharma" },
  { symbol: "APOLLOHOSP.NS", name: "Apollo Hospitals", kind: "stock", sector: "Healthcare" },

  // Consumer durables / Paints / Cement
  { symbol: "TITAN.NS", name: "Titan Company", kind: "stock", sector: "Consumer Durables" },
  { symbol: "ASIANPAINT.NS", name: "Asian Paints", kind: "stock", sector: "Paints" },
  { symbol: "ULTRACEMCO.NS", name: "UltraTech Cement", kind: "stock", sector: "Cement" },
  { symbol: "GRASIM.NS", name: "Grasim Industries", kind: "stock", sector: "Cement" },
];

const BY_SYMBOL = new Map(SYMBOLS.map((s) => [s.symbol.toUpperCase(), s]));

/**
 * Look up a symbol. Case-insensitive; also accepts a bare NSE ticker
 * (e.g. "RELIANCE" resolves to "RELIANCE.NS").
 */
export function findSymbol(s: string): SymbolInfo | undefined {
  const key = s.trim().toUpperCase();
  return BY_SYMBOL.get(key) ?? BY_SYMBOL.get(`${key}.NS`);
}

export const INDEX_SYMBOLS = SYMBOLS.filter((s) => s.kind === "index");
export const STOCK_SYMBOLS = SYMBOLS.filter((s) => s.kind === "stock");
