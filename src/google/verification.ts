import type { Http } from "../http.js";
import { type SiteRef, verificationSite } from "../site.js";

export const SV_BASE = "https://www.googleapis.com/siteVerification/v1";

export type VerificationMethod = "FILE" | "META" | "DNS_TXT" | "DNS_CNAME";

export interface WebResource {
  id: string;
  site: { type: string; identifier: string };
  owners?: string[];
}

export function defaultMethod(ref: SiteRef): VerificationMethod {
  return ref.kind === "domain" ? "DNS_TXT" : "FILE";
}

export function assertMethodFits(ref: SiteRef, method: VerificationMethod): void {
  const dns = method === "DNS_TXT" || method === "DNS_CNAME";
  if (ref.kind === "domain" && !dns) {
    throw new Error(`Domain properties (${ref.siteUrl}) can only be verified with DNS_TXT or DNS_CNAME, not ${method}.`);
  }
  if (ref.kind === "url-prefix" && dns) {
    throw new Error(
      `${method} only verifies domain properties. Use FILE or META for ${ref.siteUrl}, or pass sc-domain:${ref.host}.`,
    );
  }
}

/** Dry-run tokens look real enough to exercise the placement logic but are obviously fake. */
const DRY_TOKENS: Record<VerificationMethod, string> = {
  FILE: "google0000dryrun0000.html",
  META: '<meta name="google-site-verification" content="DRY-RUN-TOKEN" />',
  DNS_TXT: "google-site-verification=DRY-RUN-TOKEN",
  DNS_CNAME: "dryrun0000 dryrun0000.dv.googlehosted.com",
};

/** POST /token — webResource.getToken */
export async function getToken(
  h: Http,
  bearer: string,
  ref: SiteRef,
  method: VerificationMethod,
): Promise<{ method: VerificationMethod; token: string }> {
  assertMethodFits(ref, method);
  return h.json(
    {
      method: "POST",
      url: `${SV_BASE}/token`,
      bearer,
      body: { site: verificationSite(ref), verificationMethod: method },
    },
    () => ({ method, token: DRY_TOKENS[method] }),
  );
}

/** POST /webResource?verificationMethod= — webResource.insert (performs the actual check). */
export async function insert(
  h: Http,
  bearer: string,
  ref: SiteRef,
  method: VerificationMethod,
  owners: string[] = [],
): Promise<WebResource> {
  assertMethodFits(ref, method);
  const body: Record<string, unknown> = { site: verificationSite(ref) };
  if (owners.length) body.owners = owners;
  return h.json(
    {
      method: "POST",
      url: `${SV_BASE}/webResource?verificationMethod=${encodeURIComponent(method)}`,
      bearer,
      body,
    },
    () => ({ id: encodeURIComponent(verificationSite(ref).identifier), site: verificationSite(ref), owners }),
  );
}

/** GET /webResource — webResource.list */
export async function list(h: Http, bearer: string): Promise<WebResource[]> {
  const res = await h.json<{ items?: WebResource[] }>(
    { method: "GET", url: `${SV_BASE}/webResource`, bearer },
    () => ({ items: [] }),
  );
  return res.items ?? [];
}

export function findResource(items: WebResource[], ref: SiteRef): WebResource | undefined {
  const want = verificationSite(ref);
  const norm = (s: string) => s.toLowerCase().replace(/\/+$/, "");
  return items.find((r) => r.site?.type === want.type && norm(r.site.identifier) === norm(want.identifier));
}

/** DELETE /webResource/{id} — unverify (destructive). */
export async function remove(h: Http, bearer: string, id: string): Promise<void> {
  await h.json({ method: "DELETE", url: `${SV_BASE}/webResource/${encodeURIComponent(id)}`, bearer });
}

/** PUT /webResource/{id} — replace owners (destructive). */
export async function setOwners(h: Http, bearer: string, res: WebResource, owners: string[]): Promise<WebResource> {
  return h.json(
    {
      method: "PUT",
      url: `${SV_BASE}/webResource/${encodeURIComponent(res.id)}`,
      bearer,
      body: { site: res.site, owners },
    },
    () => ({ ...res, owners }),
  );
}
