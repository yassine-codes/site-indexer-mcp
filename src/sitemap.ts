import type { Http } from "./http.js";

export interface SitemapProbe {
  url: string;
  ok: boolean;
  status?: number;
  kind?: "urlset" | "sitemapindex" | "unknown";
  urlCount?: number;
  sampleUrls?: string[];
  /** All <loc> values (capped), used by inspect/indexnow. */
  locs: string[];
  problems: string[];
}

/** Regex extraction is enough for sitemaps (flat, well-known schema) and avoids an XML dependency. */
export function parseSitemap(xml: string): { kind: SitemapProbe["kind"]; locs: string[] } {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? "sitemapindex" : /<urlset[\s>]/i.test(xml) ? "urlset" : "unknown";
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) =>
    m[1].replace(/&amp;/g, "&"),
  );
  return { kind, locs };
}

/** Fetches a sitemap from the live site and sanity-checks it before handing it to Google. */
export async function probeSitemap(h: Http, url: string, expectedHost?: string, cap = 50_000): Promise<SitemapProbe> {
  let r: { status: number; text: string };
  try {
    r = await h.fetchText(url);
  } catch (e: any) {
    return { url, ok: false, locs: [], problems: [`Fetch failed: ${e?.cause?.code ?? e?.message ?? e}`] };
  }
  const problems: string[] = [];
  if (r.status !== 200) return { url, ok: false, status: r.status, locs: [], problems: [`HTTP ${r.status}`] };
  const { kind, locs } = parseSitemap(r.text);
  if (kind === "unknown") problems.push("Not a <urlset> or <sitemapindex> document (SPA fallback HTML?).");
  if (locs.length === 0) problems.push("No <loc> entries.");
  if (expectedHost) {
    const foreign = locs.filter((l) => {
      try {
        return new URL(l).hostname !== expectedHost;
      } catch {
        return true;
      }
    });
    if (foreign.length) {
      problems.push(
        `${foreign.length} <loc> URL(s) are not on ${expectedHost} (e.g. ${foreign[0]}); Google ignores URLs outside the property. ` +
          "Check the site's canonical/base URL setting.",
      );
    }
  }
  return {
    url,
    ok: kind !== "unknown" && locs.length > 0 && problems.length === 0,
    status: r.status,
    kind,
    urlCount: locs.length,
    sampleUrls: locs.slice(0, 5),
    locs: locs.slice(0, cap),
    problems,
  };
}
