/**
 * Normalises what a user types ("raqn-i9qr.netlify.app", "https://x.com", "sc-domain:x.com")
 * into the two Search Console property kinds.
 */
export type SiteRef =
  | {
      kind: "url-prefix";
      /** Search Console property id and Site Verification identifier, always with a trailing slash. */
      siteUrl: string;
      origin: string;
      host: string;
    }
  | {
      kind: "domain";
      domain: string;
      /** Search Console property id. */
      siteUrl: string;
      host: string;
    };

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/i;

export function parseSite(input: string): SiteRef {
  const raw = input.trim();
  if (!raw) throw new Error("site is required");

  const dom = raw.match(/^(?:sc-domain:|domain:)(.+)$/i);
  if (dom) {
    const domain = dom[1].trim().toLowerCase().replace(/\.$/, "");
    if (!DOMAIN_RE.test(domain)) throw new Error(`Not a valid domain: ${domain}`);
    return { kind: "domain", domain, siteUrl: `sc-domain:${domain}`, host: domain };
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid site URL: ${input}`);
  }
  if (!DOMAIN_RE.test(url.hostname) && url.hostname !== "localhost") {
    throw new Error(`Not a valid site host: ${url.hostname}`);
  }
  // URL-prefix properties keep the path (e.g. GitHub Pages project sites), minus query/hash.
  let path = url.pathname;
  if (!path.endsWith("/")) path = path.replace(/\/[^/]*\.[a-z0-9]+$/i, "/") || "/";
  if (!path.endsWith("/")) path += "/";
  const origin = url.origin;
  return { kind: "url-prefix", siteUrl: `${origin}${path}`, origin, host: url.hostname };
}

/** Site Verification API `site` object. */
export function verificationSite(ref: SiteRef): { type: "SITE" | "INET_DOMAIN"; identifier: string } {
  return ref.kind === "domain"
    ? { type: "INET_DOMAIN", identifier: ref.domain }
    : { type: "SITE", identifier: ref.siteUrl };
}

/** Is `url` inside the property? (URL Inspection rejects URLs outside it.) */
export function urlBelongsTo(ref: SiteRef, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (ref.kind === "domain") return u.hostname === ref.domain || u.hostname.endsWith(`.${ref.domain}`);
  return `${u.origin}${u.pathname}`.startsWith(ref.siteUrl) || `${u.origin}${u.pathname}/` === ref.siteUrl;
}

export function defaultSitemapUrl(ref: SiteRef): string {
  return ref.kind === "domain" ? `https://${ref.domain}/sitemap.xml` : new URL("sitemap.xml", ref.siteUrl).toString();
}
