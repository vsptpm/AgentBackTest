// News analyst: recent headlines per stock from Google News RSS, tagged with simple keyword rules.
// Server-side only. Outside requests carry nothing but the company name / symbol and a generic User-Agent.

import type { NewsItem } from "./types";

const MAX_SYMBOLS = 8;
const MAX_PER_SYMBOL = 4;
const WINDOW_MS = 48 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const CONCURRENCY = 3;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const NEGATIVE =
  /\b(falls?|fell|falling|slumps?|plunges?|plunged|tanks?|tanked|drops?|dropped|cuts?|downgrades?|downgraded|loss|losses|fraud|probe|penalty|defaults?|resigns?|resignation|weak|misses|fire|ban|banned|raids?|crash(?:es)?|slips?|sinks?|tumbles?|declines?|lawsuit|fined)\b/gi;
const POSITIVE =
  /\b(surges?|surged|jumps?|jumped|rallies|rally|soars?|soared|gains?|gained|upgrades?|upgraded|profit (?:rises|jumps|up|grows|surges)|beats?|wins? (?:\w+ )?orders?|order wins?|bags|record|approval|buyback|dividend|strong|rises|climbs?)\b/gi;
const HIGH =
  /\b(results?|earnings|q[1-4]|profit|merger|acquisition|acquires?|sebi|rbi|fraud|defaults?|order wins?|wins? (?:\w+ )?orders?|bags (?:\w+ )?orders?|stake sale|block deal)\b/i;
const MEDIUM = /\b(analysts?|target|upgrades?|upgraded|downgrades?|downgraded|ratings?|brokerages?)\b/i;

const OFFICIAL = /nseindia\.com|bseindia\.com|sebi\.gov\.in|rbi\.org\.in/i;
const OUTLETS =
  /\b(economic times|moneycontrol|mint|livemint|business standard|reuters|bloomberg|cnbc|businessline|financial express|ndtv profit|business today|pti|the hindu|times of india|zee business)\b/i;

export function classifyHeadline(headline: string): {
  sentiment: NewsItem["sentiment"];
  impact: NewsItem["impact"];
} {
  const neg = headline.match(NEGATIVE)?.length ?? 0;
  const pos = headline.match(POSITIVE)?.length ?? 0;
  const sentiment = pos > neg ? "positive" : neg > pos ? "negative" : "neutral";
  const impact = HIGH.test(headline) ? "high" : MEDIUM.test(headline) ? "medium" : "low";
  return { sentiment, impact };
}

export function verificationOf(source: string, url: string): NewsItem["verified"] {
  if (OFFICIAL.test(source) || OFFICIAL.test(url)) return "official";
  if (OUTLETS.test(source)) return "news-report";
  return "unverified";
}

function decode(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decode(m[1]) : "";
}

function parseRss(xml: string, symbol: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    let headline = tag(block, "title");
    if (!headline) continue;
    let source = tag(block, "source");
    const cut = headline.lastIndexOf(" - ");
    if (cut > 0) {
      const tail = headline.slice(cut + 3).trim();
      if (!source) source = tail;
      if (tail.toLowerCase() === source.toLowerCase()) headline = headline.slice(0, cut).trim();
    }
    const url = tag(block, "link");
    const sourceUrl = decode(/<source\b[^>]*\burl="([^"]*)"/i.exec(block)?.[1] ?? "");
    const t = Date.parse(tag(block, "pubDate"));
    out.push({
      headline,
      source,
      publishedAt: Number.isFinite(t) ? t : null,
      url,
      symbol,
      ...classifyHeadline(headline),
      verified: verificationOf(source, `${url} ${sourceUrl}`),
    });
  }
  return out;
}

async function fetchOne(
  symbol: string,
  name: string | undefined,
  now: number,
  fetchImpl: typeof fetch,
): Promise<NewsItem[]> {
  const term = (name?.trim() || symbol.replace(/\.(NS|BO)$/i, "")).replace(/"/g, "");
  const q = encodeURIComponent(`"${term}" stock when:2d`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const seen = new Set<string>();
    return parseRss(xml, symbol)
      .filter((it) => {
        if (it.publishedAt !== null && (it.publishedAt < now - WINDOW_MS || it.publishedAt > now + 3600_000)) {
          return false;
        }
        const key = it.headline.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
      .slice(0, MAX_PER_SYMBOL);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNews(
  symbols: string[],
  names: Record<string, string> = {},
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ items: NewsItem[]; warnings: string[] }> {
  const warnings: string[] = [];
  const unique = [...new Set(symbols)];
  const list = unique.slice(0, MAX_SYMBOLS);
  if (unique.length > MAX_SYMBOLS) {
    warnings.push(`News is checked for at most ${MAX_SYMBOLS} stocks; ${unique.length - MAX_SYMBOLS} ignored`);
  }
  const results: NewsItem[][] = list.map(() => []);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try {
        results[i] = await fetchOne(list[i], names[list[i]], now, fetchImpl);
      } catch {
        warnings.push(`News for ${list[i]} could not be fetched`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  return { items: results.flat(), warnings };
}
