import { describe, expect, it } from "vitest";
import { setupSite, verifySite, inspectUrls } from "../src/ops.js";
import { signedInCtx } from "./helpers.js";

const SV = "https://www.googleapis.com/siteVerification/v1";
const WM = "https://www.googleapis.com/webmasters/v3";
const SITE = "https://raqn-i9qr.netlify.app/";
const FILE = "googlecc49033fa264f376.html";
const SITEMAP = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://raqn-i9qr.netlify.app/</loc></url><url><loc>https://raqn-i9qr.netlify.app/about/</loc></url></urlset>`;

function google(m: Awaited<ReturnType<typeof signedInCtx>>["m"], opts: { verified?: boolean } = {}) {
  m.on("GET", `${SV}/webResource`, { items: opts.verified ? [{ id: "x", site: { type: "SITE", identifier: SITE }, owners: ["me@x.com"] }] : [] });
  m.on("POST", `${SV}/token`, { method: "FILE", token: FILE });
}

describe("verifySite", () => {
  it("short-circuits when already verified", async () => {
    const { ctx, m } = await signedInCtx();
    google(m, { verified: true });
    const r = await verifySite(ctx, "raqn-i9qr.netlify.app");
    expect(r).toMatchObject({ verified: true, alreadyVerified: true, attempts: 0 });
    expect(m.calls.some((c) => c.url.includes("verificationMethod"))).toBe(false);
  });

  it("waits for the deploy, then retries Google's 400 until it verifies", async () => {
    const { ctx, m } = await signedInCtx();
    google(m);
    m.once("GET", SITE + FILE, { status: 404, text: "" }); // deploy not live yet
    m.on("GET", SITE + FILE, { text: `google-site-verification: ${FILE}` });
    m.once("POST", /webResource\?verificationMethod=FILE/, { status: 400, json: { error: { message: "The necessary verification token could not be found on your site." } } });
    m.once("POST", /webResource\?verificationMethod=FILE/, { json: { id: "x", site: { type: "SITE", identifier: SITE }, owners: ["me@x.com"] } });
    const r = await verifySite(ctx, SITE, { maxWaitSeconds: 120 });
    expect(r).toMatchObject({ verified: true, attempts: 2, owners: ["me@x.com"] });
  });

  it("gives up after maxWaitSeconds and returns the placement to fix", async () => {
    const { ctx, m } = await signedInCtx();
    google(m);
    m.on("GET", SITE + FILE, { status: 404, text: "" });
    const r = await verifySite(ctx, SITE, { maxWaitSeconds: 20 });
    expect(r.verified).toBe(false);
    expect(r.attempts).toBe(0);
    expect(r.lastError).toMatch(/404/);
    expect(r.placement).toMatchObject({ method: "FILE", fileName: FILE });
  });

  it("does not retry hard failures (403)", async () => {
    const { ctx, m } = await signedInCtx();
    google(m);
    m.on("GET", SITE + FILE, { text: `google-site-verification: ${FILE}` });
    m.on("POST", /verificationMethod/, { status: 403, json: { error: { message: "Insufficient Permission" } } });
    await expect(verifySite(ctx, SITE, { maxWaitSeconds: 120 })).rejects.toThrow(/Insufficient Permission/);
  });
});

describe("setupSite", () => {
  it("stops at verification with the exact file hand-off when nothing is deployed", async () => {
    const { ctx, m } = await signedInCtx();
    google(m);
    m.on("GET", SITE + FILE, { status: 404, text: "" });
    const r = await setupSite(ctx, { site: SITE, maxWaitSeconds: 0 });
    expect(r.complete).toBe(false);
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([["auth", "done"], ["verification", "action_required"]]);
    expect(r.nextAction).toMatchObject({ who: "agent", placement: { fileName: FILE, fileContent: `google-site-verification: ${FILE}` } });
    expect(r.nextAction?.do).toMatch(/commit, deploy/);
  });

  it("runs the full loop once the token is live", async () => {
    const { ctx, m } = await signedInCtx();
    google(m);
    m.on("GET", SITE + FILE, { text: `google-site-verification: ${FILE}` });
    m.on("POST", /verificationMethod=FILE/, { id: "x", site: { type: "SITE", identifier: SITE } });
    m.once("GET", `${WM}/sites`, { siteEntry: [] });
    m.on("PUT", `${WM}/sites/${encodeURIComponent(SITE)}`, {});
    m.on("GET", `${WM}/sites`, { siteEntry: [{ siteUrl: SITE, permissionLevel: "siteOwner" }] });
    m.on("GET", `${WM}/sites/${encodeURIComponent(SITE)}/sitemaps`, { sitemap: [] });
    m.on("GET", SITE + "sitemap.xml", { text: SITEMAP });
    m.on("PUT", /\/sitemaps\/https%3A/, {});
    m.on("GET", /\/sitemaps\/https%3A/, { json: { path: SITE + "sitemap.xml", isPending: true } });
    m.on("POST", /urlInspection/, { inspectionResult: { indexStatusResult: { verdict: "NEUTRAL", coverageState: "URL is unknown to Google" } } });

    const r = await setupSite(ctx, { site: SITE });
    expect(r.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done", "done"]);
    expect(r.complete).toBe(true);
    expect(r.nextAction?.tool).toBe("inspect_urls");
    // Order matters: sites.add only after verification.
    const i = (re: RegExp) => m.calls.findIndex((c) => re.test(c.method + " " + c.url));
    expect(i(/^POST .*verificationMethod/)).toBeLessThan(i(/^PUT .*webmasters\/v3\/sites\/[^/]+$/));
    expect(i(/^PUT .*webmasters\/v3\/sites\/[^/]+$/)).toBeLessThan(i(/^PUT .*sitemaps/));
  });

  it("is idempotent on a site that is already fully set up (raqn)", async () => {
    const { ctx, m } = await signedInCtx();
    google(m, { verified: true });
    m.on("GET", `${WM}/sites`, { siteEntry: [{ siteUrl: SITE, permissionLevel: "siteOwner" }] });
    m.on("GET", `${WM}/sites/${encodeURIComponent(SITE)}/sitemaps`, { sitemap: [{ path: SITE + "sitemap.xml", lastSubmitted: "2026-10-01" }] });
    m.on("POST", /urlInspection/, { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } });
    const r = await setupSite(ctx, { site: "raqn-i9qr.netlify.app" });
    expect(r.complete).toBe(true);
    expect(m.calls.filter((c) => c.method === "PUT" || c.url.includes("verificationMethod"))).toHaveLength(0);
  });

  it("asks for sign-in when there is no token", async () => {
    const { ctx } = await signedInCtx();
    await ctx.auth.logout();
    const r = await setupSite(ctx, { site: SITE });
    expect(r.nextAction).toMatchObject({ who: "owner", tool: "auth_login" });
  });

  it("dry-run walks every step with zero network", async () => {
    const { ctx, m } = await signedInCtx({ dryRun: true });
    const { Http } = await import("../src/http.js");
    ctx.http = new Http({ dryRun: true, fetch: () => { throw new Error("network!"); } });
    const r = await setupSite(ctx, { site: SITE });
    expect(r.dryRun).toBe(true);
    expect(r.complete).toBe(true);
    expect(m.calls).toHaveLength(0);
    expect(ctx.http.dryRunLog.map((c) => c.method + " " + c.url.split("?")[0])).toContain(
      `PUT ${WM}/sites/${encodeURIComponent(SITE)}`,
    );
  });
});

describe("inspectUrls", () => {
  it("reads URLs from the sitemap, skips foreign URLs and counts indexed", async () => {
    const { ctx, m } = await signedInCtx();
    m.on("GET", SITE + "sitemap.xml", { text: SITEMAP.replace("</urlset>", "<url><loc>https://other.com/x</loc></url></urlset>") });
    m.once("POST", /urlInspection/, { inspectionResult: { indexStatusResult: { verdict: "PASS" } } });
    m.once("POST", /urlInspection/, { inspectionResult: { indexStatusResult: { verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed" } } });
    const r = await inspectUrls(ctx, SITE, {});
    expect(r).toMatchObject({ inspected: 2, indexed: 1, notIndexed: 1, skippedOutsideProperty: 1 });
  });

  it("stops early on quota errors", async () => {
    const { ctx, m } = await signedInCtx();
    m.on("POST", /urlInspection/, { status: 429, json: { error: { message: "Quota exceeded" } } });
    const r = await inspectUrls(ctx, SITE, { urls: [SITE, SITE + "a", SITE + "b"] });
    expect(r.inspected).toBe(1);
    expect((r.results[0] as any).error).toMatch(/Quota/);
  });
});
