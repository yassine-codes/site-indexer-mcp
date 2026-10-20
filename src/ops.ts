import type { Auth } from "./auth/index.js";
import type { Config } from "./config.js";
import { cloudflareUpsert, type DnsRecordResult, netlifyUpsert } from "./dns/providers.js";
import * as sc from "./google/searchConsole.js";
import * as sv from "./google/verification.js";
import { type Http, HttpError, sleep as realSleep } from "./http.js";
import { type CnameResolver, type Placement, type PlacementCheck, type TxtResolver, checkPlacement, placementFor } from "./placement.js";
import { type SiteRef, defaultSitemapUrl, parseSite, urlBelongsTo } from "./site.js";
import { type SitemapProbe, probeSitemap } from "./sitemap.js";

export interface Ctx {
  config: Config;
  http: Http;
  auth: Auth;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  resolvers?: { txt?: TxtResolver; cname?: CnameResolver };
}

const nowOf = (ctx: Ctx) => (ctx.now ?? Date.now)();
const sleepOf = (ctx: Ctx) => ctx.sleep ?? realSleep;

export async function getVerificationToken(ctx: Ctx, site: string, method?: sv.VerificationMethod) {
  const ref = parseSite(site);
  const m = method ?? sv.defaultMethod(ref);
  const { token } = await sv.getToken(ctx.http, await ctx.auth.accessToken(), ref, m);
  return { site: ref.siteUrl, placement: placementFor(ref, m, token) };
}

export interface VerifyResult {
  site: string;
  method: sv.VerificationMethod;
  verified: boolean;
  alreadyVerified?: boolean;
  attempts: number;
  precheck?: PlacementCheck;
  lastError?: string;
  placement?: Placement;
  owners?: string[];
}

/** Google-side "token not found yet" (worth retrying) vs. hard failures (auth, quota, bad input). */
function isRetryableVerifyError(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 400 || e.status === 404 || e.status === 429 || e.status >= 500);
}

/**
 * Pre-flights the token locally, then asks Google to verify, backing off
 * (5s, 10s, 20s, 30s, 30s...) until it succeeds or `maxWaitSeconds` runs out.
 */
export async function verifySite(
  ctx: Ctx,
  site: string,
  opts: { method?: sv.VerificationMethod; maxWaitSeconds?: number; skipPrecheck?: boolean } = {},
): Promise<VerifyResult> {
  const ref = parseSite(site);
  const method = opts.method ?? sv.defaultMethod(ref);
  const bearer = await ctx.auth.accessToken();

  const existing = sv.findResource(await sv.list(ctx.http, bearer), ref);
  if (existing) {
    return { site: ref.siteUrl, method, verified: true, alreadyVerified: true, attempts: 0, owners: existing.owners };
  }

  const { token } = await sv.getToken(ctx.http, bearer, ref, method);
  const placement = placementFor(ref, method, token);
  const deadline = nowOf(ctx) + (opts.maxWaitSeconds ?? 60) * 1000;
  const delays = [5, 10, 20, 30];
  let attempts = 0;
  let precheck: PlacementCheck | undefined;
  let lastError: string | undefined;

  for (let i = 0; ; i++) {
    if (!opts.skipPrecheck) precheck = await checkPlacement(ctx.http, placement, ctx.resolvers);
    if (opts.skipPrecheck || precheck?.ok) {
      attempts++;
      try {
        const res = await sv.insert(ctx.http, bearer, ref, method, ctx.config.extraOwners);
        return { site: ref.siteUrl, method, verified: true, attempts, precheck, owners: res.owners };
      } catch (e) {
        if (!isRetryableVerifyError(e)) throw e;
        lastError = (e as Error).message;
      }
    } else {
      lastError = `Pre-flight: ${precheck?.detail}`;
    }
    const wait = (delays[Math.min(i, delays.length - 1)] ?? 30) * 1000;
    if (nowOf(ctx) + wait > deadline) break;
    await sleepOf(ctx)(wait);
  }
  return { site: ref.siteUrl, method, verified: false, attempts, precheck, lastError, placement };
}

export async function createDnsRecord(
  ctx: Ctx,
  site: string,
  provider: "netlify" | "cloudflare",
  method: "DNS_TXT" | "DNS_CNAME" = "DNS_TXT",
): Promise<{ placement: Placement; result: DnsRecordResult }> {
  const { placement } = await getVerificationToken(ctx, site, method);
  const rec =
    placement.method === "DNS_TXT"
      ? { host: placement.host, type: "TXT" as const, value: placement.value }
      : placement.method === "DNS_CNAME"
        ? { host: placement.host, type: "CNAME" as const, value: placement.target }
        : undefined;
  if (!rec) throw new Error("create_dns_record only handles DNS_TXT / DNS_CNAME.");
  const token = provider === "netlify" ? ctx.config.netlifyToken : ctx.config.cloudflareToken;
  if (!token && !ctx.http.dryRun) {
    throw new Error(provider === "netlify" ? "Set NETLIFY_AUTH_TOKEN." : "Set CLOUDFLARE_API_TOKEN (Zone:DNS:Edit).");
  }
  const upsert = provider === "netlify" ? netlifyUpsert : cloudflareUpsert;
  return { placement, result: await upsert(ctx.http, token ?? "dry-run", rec) };
}

const OWNED = new Set(["siteOwner", "siteFullUser"]);

export async function addSite(ctx: Ctx, site: string) {
  const ref = parseSite(site);
  const bearer = await ctx.auth.accessToken();
  const before = (await sc.listSites(ctx.http, bearer)).find((s) => s.siteUrl === ref.siteUrl);
  if (before && OWNED.has(before.permissionLevel)) {
    return { site: ref.siteUrl, added: false, permissionLevel: before.permissionLevel };
  }
  await sc.addSite(ctx.http, bearer, ref.siteUrl);
  const after = (await sc.listSites(ctx.http, bearer)).find((s) => s.siteUrl === ref.siteUrl);
  return { site: ref.siteUrl, added: true, permissionLevel: after?.permissionLevel ?? (ctx.http.dryRun ? "dry-run" : "unknown") };
}

export async function submitSitemap(ctx: Ctx, site: string, sitemapUrl?: string, opts: { skipProbe?: boolean } = {}) {
  const ref = parseSite(site);
  const feed = sitemapUrl ?? defaultSitemapUrl(ref);
  if (!urlBelongsTo(ref, feed)) throw new Error(`Sitemap ${feed} is outside the property ${ref.siteUrl}.`);
  const probe = opts.skipProbe ? undefined : await probeSitemap(ctx.http, feed, ref.kind === "domain" ? undefined : ref.host);
  // Unreachable or non-200 sitemaps are not submitted (Google would just report "Couldn't fetch").
  // In dry-run an unreachable site is tolerated so the rest of the plan can be shown.
  if (probe && probe.status !== 200 && !(ctx.http.dryRun && probe.status === undefined)) {
    return { site: ref.siteUrl, sitemap: feed, submitted: false, probe: stripLocs(probe) };
  }
  const bearer = await ctx.auth.accessToken();
  await sc.submitSitemap(ctx.http, bearer, ref.siteUrl, feed);
  const status = await sc.getSitemap(ctx.http, bearer, ref.siteUrl, feed).catch(() => undefined);
  return { site: ref.siteUrl, sitemap: feed, submitted: true, status, probe: probe && stripLocs(probe) };
}

const stripLocs = ({ locs: _l, ...rest }: SitemapProbe) => rest;

export async function inspectUrls(
  ctx: Ctx,
  site: string,
  opts: { urls?: string[]; fromSitemap?: string; limit?: number; languageCode?: string },
) {
  const ref = parseSite(site);
  const limit = Math.min(opts.limit ?? 20, 100);
  let urls = opts.urls ?? [];
  if (!urls.length) {
    const probe = await probeSitemap(ctx.http, opts.fromSitemap ?? defaultSitemapUrl(ref));
    urls = probe.locs.length ? probe.locs : [ref.kind === "domain" ? `https://${ref.domain}/` : ref.siteUrl];
  }
  const outside = urls.filter((u) => !urlBelongsTo(ref, u));
  urls = urls.filter((u) => urlBelongsTo(ref, u)).slice(0, limit);
  const bearer = await ctx.auth.accessToken();
  const results = [];
  for (const u of urls) {
    try {
      results.push(sc.summarizeInspection(u, await sc.inspectUrl(ctx.http, bearer, ref.siteUrl, u, opts.languageCode)));
    } catch (e: any) {
      results.push({ url: u, error: e.message });
      if (e instanceof HttpError && (e.status === 429 || e.status === 403)) break; // quota: stop early
    }
  }
  const indexed = results.filter((r) => "indexed" in r && r.indexed).length;
  return {
    site: ref.siteUrl,
    inspected: results.length,
    indexed,
    notIndexed: results.length - indexed,
    skippedOutsideProperty: outside.length,
    results,
    note: "URL Inspection is read-only. There is no public API to 'Request indexing'; Google discovers URLs via the submitted sitemap and links.",
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export type StepStatus = "done" | "skipped" | "action_required" | "failed" | "pending";

export interface Step {
  step: "auth" | "verification" | "property" | "sitemap" | "inspection";
  status: StepStatus;
  detail: string;
  data?: unknown;
}

export interface SetupReport {
  site: string;
  complete: boolean;
  steps: Step[];
  /** The single thing the caller should do next (empty when complete). */
  nextAction?: { who: "agent" | "owner"; do: string; tool?: string; placement?: Placement };
  dryRun: boolean;
}

/**
 * Idempotent: call it after every deploy. It reports what is done and stops at
 * the first step that needs the agent (place a file / DNS record) or the owner.
 */
export async function setupSite(
  ctx: Ctx,
  input: {
    site: string;
    sitemapUrl?: string;
    method?: sv.VerificationMethod;
    dnsProvider?: "netlify" | "cloudflare";
    maxWaitSeconds?: number;
  },
): Promise<SetupReport> {
  const ref: SiteRef = parseSite(input.site);
  const report: SetupReport = { site: ref.siteUrl, complete: false, steps: [], dryRun: ctx.http.dryRun };
  const push = (s: Step) => report.steps.push(s);
  const stop = (next: SetupReport["nextAction"]) => {
    report.nextAction = next;
    return report;
  };

  // 1. auth
  const st = await ctx.auth.status();
  if (!st.ready) {
    push({ step: "auth", status: "action_required", detail: st.hint ?? "Not authenticated." });
    return stop({ who: "owner", do: "One-time Google sign-in.", tool: "auth_login" });
  }
  push({ step: "auth", status: "done", detail: `mode=${st.mode}` });

  // 2. verification
  const method = input.method ?? sv.defaultMethod(ref);
  try {
    const bearer = await ctx.auth.accessToken();
    const existing = sv.findResource(await sv.list(ctx.http, bearer), ref);
    if (existing) {
      push({ step: "verification", status: "done", detail: "Already verified.", data: { owners: existing.owners } });
    } else {
      let dns: DnsRecordResult | undefined;
      if (input.dnsProvider && (method === "DNS_TXT" || method === "DNS_CNAME")) {
        dns = (await createDnsRecord(ctx, input.site, input.dnsProvider, method)).result;
      }
      const v = await verifySite(ctx, input.site, { method, maxWaitSeconds: input.maxWaitSeconds ?? 30 });
      if (!v.verified) {
        const placement = v.placement!;
        const placed = v.precheck?.ok;
        push({
          step: "verification",
          status: "action_required",
          detail: placed
            ? `Token is in place but Google has not confirmed yet: ${v.lastError}`
            : `Token not in place yet: ${v.precheck?.detail ?? v.lastError}`,
          data: { placement, precheck: v.precheck, dns },
        });
        return stop({
          who: "agent",
          do: placed || dns
            ? "Wait for propagation, then call setup_site again (or verify_site with a larger maxWaitSeconds)."
            : placement.handoff + " Then call setup_site again.",
          tool: placed || dns ? "setup_site" : undefined,
          placement,
        });
      }
      push({ step: "verification", status: "done", detail: `Verified with ${method} after ${v.attempts} attempt(s).`, data: { dns } });
    }
  } catch (e: any) {
    push({ step: "verification", status: "failed", detail: e.message });
    return stop({ who: "owner", do: `Fix the verification error: ${e.message}` });
  }

  // 3. Search Console property
  try {
    const r = await addSite(ctx, input.site);
    push({ step: "property", status: "done", detail: r.added ? "Added to Search Console." : `Already present (${r.permissionLevel}).` });
  } catch (e: any) {
    push({ step: "property", status: "failed", detail: e.message });
    return stop({ who: "owner", do: `sites.add failed: ${e.message}` });
  }

  // 4. sitemap
  try {
    const feed = input.sitemapUrl ?? defaultSitemapUrl(ref);
    const bearer = await ctx.auth.accessToken();
    const already = (await sc.listSitemaps(ctx.http, bearer, ref.siteUrl)).find((s) => s.path === feed);
    if (already) {
      push({ step: "sitemap", status: "done", detail: `Already submitted ${already.lastSubmitted ?? ""}`.trim(), data: already });
    } else {
      const r = await submitSitemap(ctx, input.site, feed);
      if (!r.submitted) {
        push({ step: "sitemap", status: "action_required", detail: `Sitemap not reachable: ${r.probe?.problems.join("; ")}`, data: r.probe });
        return stop({ who: "agent", do: `Publish a sitemap at ${feed} (or pass sitemapUrl), deploy, then call setup_site again.` });
      }
      const warn = r.probe?.problems.length ? ` Warnings: ${r.probe.problems.join("; ")}` : "";
      push({ step: "sitemap", status: "done", detail: `Submitted ${feed}.${warn}`, data: r.status });
    }
  } catch (e: any) {
    push({ step: "sitemap", status: "failed", detail: e.message });
    return stop({ who: "owner", do: `Sitemap submission failed: ${e.message}` });
  }

  // 5. first inspection (informational; new sites are usually "unknown to Google" for days)
  try {
    const home = ref.kind === "domain" ? `https://${ref.domain}/` : ref.siteUrl;
    const r = await inspectUrls(ctx, input.site, { urls: [home] });
    const first = r.results[0] as any;
    push({
      step: "inspection",
      status: "done",
      detail: first?.error ? `Inspection error: ${first.error}` : `Homepage: ${first?.verdict} / ${first?.coverageState ?? "n/a"}`,
      data: first,
    });
  } catch (e: any) {
    push({ step: "inspection", status: "skipped", detail: e.message });
  }

  report.complete = true;
  report.nextAction = {
    who: "agent",
    do: "Schedule inspect_urls (fromSitemap) in ~3-7 days to monitor indexing; nothing else is required.",
    tool: "inspect_urls",
  };
  return report;
}
