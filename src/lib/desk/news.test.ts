import { describe, expect, it } from "vitest";
import { classifyHeadline, fetchNews, verificationOf } from "./news";

const NOW = Date.UTC(2026, 10, 16, 6, 0, 0);
const HOUR = 3600_000;
const rfc = (ms: number) => new Date(ms).toUTCString();

function item(title: string, ageHours: number, source = "", link = "https://news.google.com/rss/articles/abc") {
  return `<item><title>${title}</title><link>${link}</link><pubDate>${rfc(NOW - ageHours * HOUR)}</pubDate>${source}</item>`;
}
const rss = (items: string[]) =>
  `<?xml version="1.0"?><rss><channel><title>feed</title>${items.join("")}</channel></rss>`;
const respond = (xml: string) => (async () => new Response(xml, { status: 200 })) as unknown as typeof fetch;

describe("fetchNews", () => {
  it("parses RSS with CDATA and entities", async () => {
    const xml = rss([
      item(
        "<![CDATA[Reliance Q2 profit rises 12% - Moneycontrol]]>",
        2,
        '<source url="https://www.moneycontrol.com">Moneycontrol</source>',
        "https://news.google.com/a?x=1&amp;y=2",
      ),
      item("L&amp;T &quot;wins&quot; order, says it&#39;s big - Some Blog", 5),
    ]);
    let calledUrl = "";
    const f = (async (u: string) => {
      calledUrl = u;
      return new Response(xml, { status: 200 });
    }) as unknown as typeof fetch;
    const { items, warnings } = await fetchNews(["RELIANCE.NS"], { "RELIANCE.NS": "Reliance Industries" }, NOW, f);
    expect(warnings).toEqual([]);
    expect(calledUrl).toContain(encodeURIComponent('"Reliance Industries" stock when:2d'));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      headline: "Reliance Q2 profit rises 12%",
      source: "Moneycontrol",
      url: "https://news.google.com/a?x=1&y=2",
      symbol: "RELIANCE.NS",
      publishedAt: NOW - 2 * HOUR,
      sentiment: "positive",
      impact: "high",
      verified: "news-report",
    });
    expect(items[1].headline).toBe(`L&T "wins" order, says it's big`);
    expect(items[1].source).toBe("Some Blog");
    expect(items[1].verified).toBe("unverified");
  });

  it("applies the 48-hour cut-off, newest first, max 4", async () => {
    const xml = rss([
      item("Old story - X", 60),
      item("C - X", 30),
      item("A - X", 1),
      item("E - X", 47),
      item("B - X", 10),
      item("D - X", 40),
      item("Too old - X", 49),
    ]);
    const { items } = await fetchNews(["TCS.NS"], {}, NOW, respond(xml));
    expect(items.map((i) => i.headline)).toEqual(["A", "B", "C", "D"]);
  });

  it("turns a failing fetch into a warning", async () => {
    const f = (async (u: string) => {
      if (u.includes("INFY")) throw new Error("boom");
      if (u.includes("WIPRO")) return new Response("nope", { status: 503 });
      return new Response(rss([item("Fine - X", 1)]), { status: 200 });
    }) as unknown as typeof fetch;
    const { items, warnings } = await fetchNews(["INFY.NS", "TCS.NS", "WIPRO.NS"], {}, NOW, f);
    expect(items.map((i) => i.symbol)).toEqual(["TCS.NS"]);
    expect(warnings).toEqual(
      expect.arrayContaining(["News for INFY.NS could not be fetched", "News for WIPRO.NS could not be fetched"]),
    );
  });

  it("ignores symbols beyond eight with a warning", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(rss([]), { status: 200 });
    }) as unknown as typeof fetch;
    const syms = Array.from({ length: 10 }, (_, i) => `S${i}.NS`);
    const { warnings } = await fetchNews(syms, {}, NOW, f);
    expect(calls).toBe(8);
    expect(warnings).toHaveLength(1);
  });
});

describe("classifyHeadline", () => {
  it("scores sentiment", () => {
    expect(classifyHeadline("Tata Motors shares surge 5% on strong sales").sentiment).toBe("positive");
    expect(classifyHeadline("Stock PLUNGES after auditor resigns").sentiment).toBe("negative");
    expect(classifyHeadline("Company to hold board meeting on Friday").sentiment).toBe("neutral");
    expect(classifyHeadline("Bank of Baroda opens new branch").sentiment).toBe("neutral");
  });

  it("grades impact", () => {
    expect(classifyHeadline("Infosys Q3 results due this week").impact).toBe("high");
    expect(classifyHeadline("SEBI issues notice to promoter").impact).toBe("high");
    expect(classifyHeadline("Promoter plans block deal").impact).toBe("high");
    expect(classifyHeadline("Brokerage raises target price on HDFC Bank").impact).toBe("medium");
    expect(classifyHeadline("CEO speaks at industry conference").impact).toBe("low");
  });
});

describe("verificationOf", () => {
  it("recognises exchanges, outlets and unknown sources", () => {
    expect(verificationOf("NSE", "https://www.nseindia.com/corporate/filing.pdf")).toBe("official");
    expect(verificationOf("The Economic Times", "https://news.google.com/x")).toBe("news-report");
    expect(verificationOf("Mint", "https://news.google.com/x")).toBe("news-report");
    expect(verificationOf("Random Stock Blog", "https://randomblog.example/post")).toBe("unverified");
  });
});
