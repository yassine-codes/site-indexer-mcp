import type { Http } from "../http.js";

export const WM_BASE = "https://www.googleapis.com/webmasters/v3";
export const SC_BASE = "https://searchconsole.googleapis.com/v1";

const enc = encodeURIComponent;

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: "siteOwner" | "siteFullUser" | "siteRestrictedUser" | "siteUnverifiedUser" | string;
}

export interface Sitemap {
  path: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  warnings?: string;
  errors?: string;
  contents?: { type: string; submitted?: string; indexed?: string }[];
}

export interface IndexStatus {
  verdict?: "VERDICT_UNSPECIFIED" | "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL";
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  pageFetchState?: string;
  googleCanonical?: string;
  userCanonical?: string;
  sitemap?: string[];
  referringUrls?: string[];
  crawledAs?: string;
}

export interface InspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: IndexStatus;
  mobileUsabilityResult?: unknown;
  richResultsResult?: unknown;
}

export async function listSites(h: Http, bearer: string): Promise<SiteEntry[]> {
  const res = await h.json<{ siteEntry?: SiteEntry[] }>(
    { method: "GET", url: `${WM_BASE}/sites`, bearer },
    () => ({ siteEntry: [] }),
  );
  return res.siteEntry ?? [];
}

/** PUT /sites/{siteUrl}. Call after verification; otherwise the property shows as unverified. */
export async function addSite(h: Http, bearer: string, siteUrl: string): Promise<void> {
  await h.json({ method: "PUT", url: `${WM_BASE}/sites/${enc(siteUrl)}`, bearer });
}

export async function deleteSite(h: Http, bearer: string, siteUrl: string): Promise<void> {
  await h.json({ method: "DELETE", url: `${WM_BASE}/sites/${enc(siteUrl)}`, bearer });
}

export async function submitSitemap(h: Http, bearer: string, siteUrl: string, feedpath: string): Promise<void> {
  await h.json({ method: "PUT", url: `${WM_BASE}/sites/${enc(siteUrl)}/sitemaps/${enc(feedpath)}`, bearer });
}

export async function getSitemap(h: Http, bearer: string, siteUrl: string, feedpath: string): Promise<Sitemap> {
  return h.json(
    { method: "GET", url: `${WM_BASE}/sites/${enc(siteUrl)}/sitemaps/${enc(feedpath)}`, bearer },
    () => ({ path: feedpath, isPending: true }),
  );
}

export async function listSitemaps(h: Http, bearer: string, siteUrl: string): Promise<Sitemap[]> {
  const res = await h.json<{ sitemap?: Sitemap[] }>(
    { method: "GET", url: `${WM_BASE}/sites/${enc(siteUrl)}/sitemaps`, bearer },
    () => ({ sitemap: [] }),
  );
  return res.sitemap ?? [];
}

export async function deleteSitemap(h: Http, bearer: string, siteUrl: string, feedpath: string): Promise<void> {
  await h.json({ method: "DELETE", url: `${WM_BASE}/sites/${enc(siteUrl)}/sitemaps/${enc(feedpath)}`, bearer });
}

/** POST urlInspection/index:inspect — read-only; does NOT request indexing. */
export async function inspectUrl(
  h: Http,
  bearer: string,
  siteUrl: string,
  inspectionUrl: string,
  languageCode = "en-US",
): Promise<InspectionResult> {
  const res = await h.json<{ inspectionResult?: InspectionResult }>(
    {
      method: "POST",
      url: `${SC_BASE}/urlInspection/index:inspect`,
      bearer,
      body: { inspectionUrl, siteUrl, languageCode },
    },
    () => ({ inspectionResult: { indexStatusResult: { verdict: "VERDICT_UNSPECIFIED", coverageState: "DRY RUN" } } }),
  );
  return res.inspectionResult ?? {};
}

/** Flattens an inspection into the handful of fields an agent actually reasons about. */
export function summarizeInspection(url: string, r: InspectionResult) {
  const s = r.indexStatusResult ?? {};
  return {
    url,
    verdict: s.verdict ?? "UNKNOWN",
    indexed: s.verdict === "PASS",
    coverageState: s.coverageState,
    lastCrawlTime: s.lastCrawlTime,
    pageFetchState: s.pageFetchState,
    robotsTxtState: s.robotsTxtState,
    indexingState: s.indexingState,
    googleCanonical: s.googleCanonical,
    userCanonical: s.userCanonical,
    sitemaps: s.sitemap,
    link: r.inspectionResultLink,
  };
}
