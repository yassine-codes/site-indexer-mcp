import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { openBrowser } from "./browser.js";
import * as sc from "./google/searchConsole.js";
import * as sv from "./google/verification.js";
import { generateKey, isValidKey, keyFile, ping } from "./indexnow.js";
import * as ops from "./ops.js";
import { defaultSitemapUrl, parseSite } from "./site.js";
import { probeSitemap } from "./sitemap.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown, ctx: ops.Ctx): Result => {
  const payload =
    ctx.http.dryRun && ctx.http.dryRunLog.length
      ? { dryRun: true, wouldCall: ctx.http.dryRunLog.splice(0), result: data }
      : data;
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
};

const fail = (e: unknown): Result => ({
  content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

function wrap<A>(ctx: ops.Ctx, fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<Result> => {
    try {
      return ok(await fn(args), ctx);
    } catch (e) {
      ctx.http.dryRunLog.length = 0;
      return fail(e);
    }
  };
}

const site = z
  .string()
  .describe('Property: "https://example.netlify.app/", "example.com" (URL-prefix, https assumed) or "sc-domain:example.com" (domain property).');
const method = z
  .enum(["FILE", "META", "DNS_TXT", "DNS_CNAME"])
  .optional()
  .describe("Default: FILE for URL-prefix sites, DNS_TXT for sc-domain: properties.");

const RO = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

export function registerTools(server: McpServer, ctx: ops.Ctx): string[] {
  const names: string[] = [];
  const reg: typeof server.registerTool = ((name: string, cfg: any, cb: any) => {
    names.push(name);
    return server.registerTool(name, cfg, cb);
  }) as any;

  // ---- auth ---------------------------------------------------------------
  reg(
    "auth_status",
    { description: "Is site-indexer signed in to Google, in which mode, and what to do if not. Never returns secrets.", inputSchema: {}, annotations: RO },
    wrap(ctx, async () => ctx.auth.status()),
  );

  reg(
    "auth_login",
    {
      description:
        "One-time Google OAuth (loopback on 127.0.0.1). Returns a consent URL immediately; the owner opens it in a browser on THIS machine. " +
        "Poll auth_status until ready. The refresh token is stored in the OS config dir with 0600 permissions.",
      inputSchema: { timeoutSeconds: z.number().int().min(30).max(900).optional() },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    wrap(ctx, async ({ timeoutSeconds }: { timeoutSeconds?: number }) => {
      const { authUrl } = await ctx.auth.startLogin({ timeoutMs: (timeoutSeconds ?? 300) * 1000 });
      return {
        authUrl,
        browserOpened: openBrowser(authUrl),
        instructions: "Open authUrl in a browser on this computer and approve. Then call auth_status (ready: true).",
      };
    }),
  );

  reg(
    "auth_logout",
    { description: "Deletes the stored refresh token from this machine.", inputSchema: {}, annotations: { readOnlyHint: false } },
    wrap(ctx, async () => ({ removed: await ctx.auth.logout() })),
  );

  // ---- verification -------------------------------------------------------
  reg(
    "get_verification_token",
    {
      description:
        "Gets the Google Site Verification token and returns exactly what to place: FILE -> fileName + fileContent to publish at the site root; " +
        "META -> <meta> tag for <head>; DNS_TXT/DNS_CNAME -> the DNS record. Does not verify.",
      inputSchema: { site, method },
      annotations: RO,
    },
    wrap(ctx, ({ site, method }: { site: string; method?: sv.VerificationMethod }) => ops.getVerificationToken(ctx, site, method)),
  );

  reg(
    "verify_site",
    {
      description:
        "Checks locally that the token is live (file / meta / DNS), then asks Google to verify ownership, retrying with backoff for deploy/DNS propagation. " +
        "Idempotent: returns alreadyVerified if the site is already yours.",
      inputSchema: {
        site,
        method,
        maxWaitSeconds: z.number().int().min(0).max(600).optional().describe("Retry budget, default 60."),
        skipPrecheck: z.boolean().optional().describe("Ask Google even if the local check fails (e.g. split-horizon DNS)."),
      },
      annotations: WRITE,
    },
    wrap(ctx, ({ site, ...o }: { site: string; method?: sv.VerificationMethod; maxWaitSeconds?: number; skipPrecheck?: boolean }) =>
      ops.verifySite(ctx, site, o),
    ),
  );

  reg(
    "create_dns_record",
    {
      description:
        "For sc-domain: properties: fetches the DNS token and creates the TXT (or CNAME) record via Netlify DNS (NETLIFY_AUTH_TOKEN) or Cloudflare (CLOUDFLARE_API_TOKEN). Skips if it already exists.",
      inputSchema: {
        site,
        provider: z.enum(["netlify", "cloudflare"]),
        method: z.enum(["DNS_TXT", "DNS_CNAME"]).optional(),
      },
      annotations: WRITE,
    },
    wrap(ctx, ({ site, provider, method }: { site: string; provider: "netlify" | "cloudflare"; method?: "DNS_TXT" | "DNS_CNAME" }) =>
      ops.createDnsRecord(ctx, site, provider, method),
    ),
  );

  // ---- Search Console -----------------------------------------------------
  reg(
    "list_sites",
    { description: "Search Console properties for the signed-in account, with permission level.", inputSchema: {}, annotations: RO },
    wrap(ctx, async () => sc.listSites(ctx.http, await ctx.auth.accessToken())),
  );

  reg(
    "add_site",
    { description: "Adds a VERIFIED site to Search Console (sites.add). Run verify_site first.", inputSchema: { site }, annotations: WRITE },
    wrap(ctx, ({ site }: { site: string }) => ops.addSite(ctx, site)),
  );

  reg(
    "check_sitemap",
    {
      description: "Fetches a sitemap from the live site (no Google call) and reports URL count, sample URLs and problems such as wrong host or HTML fallback.",
      inputSchema: { sitemapUrl: z.string().url(), site: site.optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(ctx, async ({ sitemapUrl, site }: { sitemapUrl: string; site?: string }) => {
      const host = site ? parseSite(site).host : undefined;
      const { locs: _, ...probe } = await probeSitemap(ctx.http, sitemapUrl, host);
      return probe;
    }),
  );

  reg(
    "submit_sitemap",
    {
      description: "Probes then submits a sitemap to Search Console (default <site>/sitemap.xml) and returns Google's sitemap status.",
      inputSchema: { site, sitemapUrl: z.string().url().optional() },
      annotations: WRITE,
    },
    wrap(ctx, ({ site, sitemapUrl }: { site: string; sitemapUrl?: string }) => ops.submitSitemap(ctx, site, sitemapUrl)),
  );

  reg(
    "list_sitemaps",
    { description: "Sitemaps known to Search Console for a property, with last download, errors, warnings and submitted counts.", inputSchema: { site }, annotations: RO },
    wrap(ctx, async ({ site }: { site: string }) => sc.listSitemaps(ctx.http, await ctx.auth.accessToken(), parseSite(site).siteUrl)),
  );

  reg(
    "inspect_url",
    {
      description: "URL Inspection (read-only): verdict, coverage state, last crawl, canonical. Does NOT request indexing (no public API exists for that).",
      inputSchema: { site, url: z.string().url(), languageCode: z.string().optional() },
      annotations: RO,
    },
    wrap(ctx, async ({ site, url, languageCode }: { site: string; url: string; languageCode?: string }) =>
      (await ops.inspectUrls(ctx, site, { urls: [url], languageCode })).results[0],
    ),
  );

  reg(
    "inspect_urls",
    {
      description:
        "Inspects many URLs (given, or read from the live sitemap) and summarises how many are indexed. Quota: ~2,000 inspections/day and 600/min per property.",
      inputSchema: {
        site,
        urls: z.array(z.string().url()).max(100).optional(),
        fromSitemap: z.string().url().optional().describe("Default: <site>/sitemap.xml when urls is empty."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
      annotations: RO,
    },
    wrap(ctx, ({ site, ...o }: { site: string; urls?: string[]; fromSitemap?: string; limit?: number }) => ops.inspectUrls(ctx, site, o)),
  );

  // ---- orchestrator -------------------------------------------------------
  reg(
    "setup_site",
    {
      description:
        "Runs the whole loop idempotently: auth -> verification -> add to Search Console -> submit sitemap -> first inspection. " +
        "Stops at the first step that needs action and returns `nextAction` (e.g. the exact file to commit and deploy). Call again after each deploy.",
      inputSchema: {
        site,
        sitemapUrl: z.string().url().optional(),
        method,
        dnsProvider: z.enum(["netlify", "cloudflare"]).optional().describe("Auto-create the DNS record for sc-domain: properties."),
        maxWaitSeconds: z.number().int().min(0).max(600).optional().describe("Verification retry budget, default 30."),
      },
      annotations: WRITE,
    },
    wrap(ctx, (input: Parameters<typeof ops.setupSite>[1]) => ops.setupSite(ctx, input)),
  );

  // ---- IndexNow (optional, non-Google) --------------------------------------
  reg(
    "indexnow_key",
    {
      description: "Generates (or echoes INDEXNOW_KEY) an IndexNow key and the key file to publish at the site root. Bing/Yandex/etc only, not Google.",
      inputSchema: { site },
      annotations: { readOnlyHint: true },
    },
    wrap(ctx, async ({ site }: { site: string }) => {
      const ref = parseSite(site);
      const key = ctx.config.indexNowKey ?? generateKey();
      const origin = ref.kind === "domain" ? `https://${ref.domain}` : ref.origin;
      return {
        ...keyFile(origin, key),
        fromEnv: !!ctx.config.indexNowKey,
        handoff: "Commit the file to the site's public root, deploy, and set INDEXNOW_KEY to the same value for indexnow_ping.",
      };
    }),
  );

  reg(
    "indexnow_ping",
    {
      description: "Submits URLs (given or from the sitemap) to IndexNow (Bing, Yandex, Seznam, Naver...). Google ignores IndexNow.",
      inputSchema: {
        site,
        urls: z.array(z.string().url()).max(10000).optional(),
        sitemapUrl: z.string().url().optional(),
        key: z.string().optional().describe("Default: INDEXNOW_KEY env."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    wrap(ctx, async ({ site, urls, sitemapUrl, key }: { site: string; urls?: string[]; sitemapUrl?: string; key?: string }) => {
      const ref = parseSite(site);
      const k = key ?? ctx.config.indexNowKey;
      if (!k || !isValidKey(k)) throw new Error("No valid IndexNow key. Run indexnow_key, publish the file, set INDEXNOW_KEY.");
      const list = urls?.length ? urls : (await probeSitemap(ctx.http, sitemapUrl ?? defaultSitemapUrl(ref))).locs;
      const origin = ref.kind === "domain" ? `https://${ref.domain}` : ref.origin;
      return ping(ctx.http, { host: ref.host, key: k, keyLocation: keyFile(origin, k).url, urls: list });
    }),
  );

  // ---- destructive (opt-in) ----------------------------------------------------
  if (ctx.config.enableDestructive) {
    const confirm = z.string().describe("Must equal the normalised property id exactly (e.g. https://x.netlify.app/ or sc-domain:x.com).");
    const guard = (s: string, c: string) => {
      const id = parseSite(s).siteUrl;
      if (c !== id) throw new Error(`Refusing: confirm must be exactly "${id}".`);
      return id;
    };

    reg(
      "delete_site",
      { description: "DESTRUCTIVE: removes the property from Search Console (does not unverify).", inputSchema: { site, confirm }, annotations: DESTRUCTIVE },
      wrap(ctx, async ({ site, confirm }: { site: string; confirm: string }) => {
        const id = guard(site, confirm);
        await sc.deleteSite(ctx.http, await ctx.auth.accessToken(), id);
        return { deleted: id };
      }),
    );

    reg(
      "delete_sitemap",
      {
        description: "DESTRUCTIVE: removes a sitemap from Search Console.",
        inputSchema: { site, sitemapUrl: z.string().url(), confirm },
        annotations: DESTRUCTIVE,
      },
      wrap(ctx, async ({ site, sitemapUrl, confirm }: { site: string; sitemapUrl: string; confirm: string }) => {
        const id = guard(site, confirm);
        await sc.deleteSitemap(ctx.http, await ctx.auth.accessToken(), id, sitemapUrl);
        return { deleted: sitemapUrl, site: id };
      }),
    );

    reg(
      "unverify_site",
      {
        description: "DESTRUCTIVE: removes YOUR verified ownership (Site Verification webResource.delete). Remove the token afterwards or Google may re-verify.",
        inputSchema: { site, confirm },
        annotations: DESTRUCTIVE,
      },
      wrap(ctx, async ({ site, confirm }: { site: string; confirm: string }) => {
        guard(site, confirm);
        const bearer = await ctx.auth.accessToken();
        const res = sv.findResource(await sv.list(ctx.http, bearer), parseSite(site));
        if (!res) throw new Error("Not verified by this account.");
        await sv.remove(ctx.http, bearer, res.id);
        return { unverified: res.site.identifier };
      }),
    );

    reg(
      "set_owners",
      {
        description: "DESTRUCTIVE: replaces the verified owners list (emails). Owners you drop lose access.",
        inputSchema: { site, owners: z.array(z.string().email()).min(1), confirm },
        annotations: DESTRUCTIVE,
      },
      wrap(ctx, async ({ site, owners, confirm }: { site: string; owners: string[]; confirm: string }) => {
        guard(site, confirm);
        const bearer = await ctx.auth.accessToken();
        const res = sv.findResource(await sv.list(ctx.http, bearer), parseSite(site));
        if (!res) throw new Error("Not verified by this account.");
        return sv.setOwners(ctx.http, bearer, res, owners);
      }),
    );
  }

  return names;
}
