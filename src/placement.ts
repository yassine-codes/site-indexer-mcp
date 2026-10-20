import dns from "node:dns/promises";
import type { VerificationMethod } from "./google/verification.js";
import type { Http } from "./http.js";
import type { SiteRef } from "./site.js";

/** What the calling agent (or a DNS helper) has to put where, for one token. */
export type Placement =
  | {
      method: "FILE";
      fileName: string;
      fileContent: string;
      /** Where Google will fetch it. */
      url: string;
      handoff: string;
    }
  | { method: "META"; metaTag: string; pageUrl: string; handoff: string }
  | { method: "DNS_TXT"; recordType: "TXT"; host: string; value: string; handoff: string }
  | { method: "DNS_CNAME"; recordType: "CNAME"; host: string; target: string; raw: string; handoff: string };

export function placementFor(ref: SiteRef, method: VerificationMethod, token: string): Placement {
  switch (method) {
    case "FILE": {
      if (ref.kind !== "url-prefix") throw new Error("FILE needs a URL-prefix property");
      const fileName = token.trim();
      if (!/^google[0-9a-z]+\.html$/i.test(fileName)) throw new Error(`Unexpected FILE token from Google: ${fileName}`);
      const url = new URL(fileName, ref.siteUrl).toString();
      return {
        method,
        fileName,
        // Exactly what Search Console's own download contains.
        fileContent: `google-site-verification: ${fileName}`,
        url,
        handoff:
          `Create "${fileName}" in the directory that is published at ${ref.siteUrl} ` +
          `(e.g. public/, static/ or the build output root), commit, deploy, then call verify_site. ` +
          `The file must be served with HTTP 200 at ${url} without redirects (beware "pretty URL" rewrites).`,
      };
    }
    case "META":
      if (ref.kind !== "url-prefix") throw new Error("META needs a URL-prefix property");
      return {
        method,
        metaTag: token.trim(),
        pageUrl: ref.siteUrl,
        handoff: `Add the meta tag inside <head> of the page served at ${ref.siteUrl}, deploy, then call verify_site.`,
      };
    case "DNS_TXT":
      if (ref.kind !== "domain") throw new Error("DNS_TXT needs a domain property");
      return {
        method,
        recordType: "TXT",
        host: ref.domain,
        value: token.trim(),
        handoff:
          `Add a TXT record on ${ref.domain} (the apex, "@") with this value; keep any existing TXT records. ` +
          `Use create_dns_record for Netlify DNS / Cloudflare, or your registrar's panel, then call verify_site.`,
      };
    case "DNS_CNAME": {
      if (ref.kind !== "domain") throw new Error("DNS_CNAME needs a domain property");
      // Google returns "<label> <target>"; the label is relative to the domain.
      const parts = token.trim().split(/\s+/);
      const label = parts[0] ?? "";
      const target = parts[parts.length - 1] ?? "";
      const host = label.endsWith(ref.domain) ? label : `${label}.${ref.domain}`;
      return {
        method,
        recordType: "CNAME",
        host,
        target,
        raw: token,
        handoff: `Add a CNAME record ${host} -> ${target}, then call verify_site.`,
      };
    }
  }
}

export interface PlacementCheck {
  ok: boolean;
  checked: string;
  detail: string;
}

export type TxtResolver = (host: string) => Promise<string[][]>;
export type CnameResolver = (host: string) => Promise<string[]>;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Local pre-flight: is the token visible from here? Cheap, and lets verify_site
 * explain *why* Google would fail instead of just relaying "token not found".
 */
export async function checkPlacement(
  h: Http,
  p: Placement,
  resolvers: { txt?: TxtResolver; cname?: CnameResolver } = {},
): Promise<PlacementCheck> {
  // Dry-run tokens are fake, so they can never be found on the real site.
  if (h.dryRun) return { ok: true, checked: "dry-run", detail: "Skipped in dry-run mode (token is a placeholder)." };
  try {
    switch (p.method) {
      case "FILE": {
        const r = await h.fetchText(p.url);
        if (r.status !== 200) return { ok: false, checked: p.url, detail: `HTTP ${r.status}; the file is not deployed yet.` };
        if (r.finalUrl.replace(/\/$/, "") !== p.url) {
          return { ok: false, checked: p.url, detail: `Redirected to ${r.finalUrl}; Google needs the file at the exact URL.` };
        }
        return r.text.includes(p.fileContent)
          ? { ok: true, checked: p.url, detail: "File is live with the expected content." }
          : { ok: false, checked: p.url, detail: "File is reachable but the content does not match (SPA fallback page?)." };
      }
      case "META": {
        const r = await h.fetchText(p.pageUrl);
        const content = p.metaTag.match(/content="([^"]+)"/)?.[1] ?? p.metaTag;
        const found = new RegExp(`google-site-verification["'][^>]*content=["']${escapeRe(content)}["']`, "i").test(r.text) ||
          new RegExp(`content=["']${escapeRe(content)}["'][^>]*google-site-verification`, "i").test(r.text);
        return found
          ? { ok: true, checked: p.pageUrl, detail: "Meta tag found." }
          : { ok: false, checked: p.pageUrl, detail: `Meta tag not found in HTML (HTTP ${r.status}).` };
      }
      case "DNS_TXT": {
        const records = await (resolvers.txt ?? dns.resolveTxt)(p.host);
        const flat = records.map((chunks) => chunks.join(""));
        return flat.includes(p.value)
          ? { ok: true, checked: `TXT ${p.host}`, detail: "TXT record visible from this machine's resolver." }
          : { ok: false, checked: `TXT ${p.host}`, detail: `Not visible yet (${flat.length} TXT records seen). DNS can take minutes to hours.` };
      }
      case "DNS_CNAME": {
        const targets = await (resolvers.cname ?? dns.resolveCname)(p.host);
        const norm = (s: string) => s.toLowerCase().replace(/\.$/, "");
        return targets.map(norm).includes(norm(p.target))
          ? { ok: true, checked: `CNAME ${p.host}`, detail: "CNAME visible." }
          : { ok: false, checked: `CNAME ${p.host}`, detail: "CNAME not visible yet." };
      }
    }
  } catch (e: any) {
    return { ok: false, checked: "lookup", detail: `Lookup failed: ${e?.code ?? e?.message ?? e}` };
  }
}
