import { describe, expect, it } from "vitest";
import * as sc from "../src/google/searchConsole.js";
import * as sv from "../src/google/verification.js";
import { Http, HttpError } from "../src/http.js";
import { parseSite } from "../src/site.js";
import { mockFetch } from "./helpers.js";

const raqn = parseSite("https://raqn-i9qr.netlify.app/");

describe("Site Verification API client", () => {
  it("getToken posts the documented body", async () => {
    const m = mockFetch();
    m.on("POST", "https://www.googleapis.com/siteVerification/v1/token", { method: "FILE", token: "google1.html" });
    const r = await sv.getToken(new Http({ fetch: m.fetch }), "AT", raqn, "FILE");
    expect(r.token).toBe("google1.html");
    expect(m.calls[0].body).toEqual({ site: { type: "SITE", identifier: "https://raqn-i9qr.netlify.app/" }, verificationMethod: "FILE" });
    expect(m.calls[0].headers.authorization).toBe("Bearer AT");
  });

  it("insert passes verificationMethod as a query param and owners in the body", async () => {
    const m = mockFetch();
    m.on("POST", /webResource\?verificationMethod=DNS_TXT$/, (c) => ({ json: { id: "dns%3A%2F%2Fexample.com", ...c.body } }));
    const r = await sv.insert(new Http({ fetch: m.fetch }), "AT", parseSite("sc-domain:example.com"), "DNS_TXT", ["me@x.com"]);
    expect(m.calls[0].body).toEqual({ site: { type: "INET_DOMAIN", identifier: "example.com" }, owners: ["me@x.com"] });
    expect(r.owners).toEqual(["me@x.com"]);
  });

  it("findResource matches by type + identifier, ignoring trailing slash/case", () => {
    const items = [
      { id: "a", site: { type: "SITE", identifier: "https://RAQN-i9qr.netlify.app" } },
      { id: "b", site: { type: "INET_DOMAIN", identifier: "raqn-i9qr.netlify.app" } },
    ];
    expect(sv.findResource(items, raqn)?.id).toBe("a");
  });
});

describe("Search Console API client", () => {
  it("URL-encodes property and feed path", async () => {
    const m = mockFetch();
    m.on("PUT", /.*/, {});
    const h = new Http({ fetch: m.fetch });
    await sc.addSite(h, "AT", "sc-domain:example.com");
    await sc.submitSitemap(h, "AT", "https://raqn-i9qr.netlify.app/", "https://raqn-i9qr.netlify.app/sitemap.xml");
    expect(m.calls[0].url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com");
    expect(m.calls[1].url).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fraqn-i9qr.netlify.app%2F/sitemaps/https%3A%2F%2Fraqn-i9qr.netlify.app%2Fsitemap.xml",
    );
  });

  it("inspectUrl hits searchconsole.googleapis.com and summarises", async () => {
    const m = mockFetch();
    m.on("POST", "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      inspectionResult: {
        inspectionResultLink: "https://search.google.com/...",
        indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-10-01T00:00:00Z" },
      },
    });
    const r = await sc.inspectUrl(new Http({ fetch: m.fetch }), "AT", raqn.siteUrl, "https://raqn-i9qr.netlify.app/");
    expect(m.calls[0].body).toEqual({ inspectionUrl: "https://raqn-i9qr.netlify.app/", siteUrl: raqn.siteUrl, languageCode: "en-US" });
    expect(sc.summarizeInspection("u", r)).toMatchObject({ indexed: true, coverageState: "Submitted and indexed" });
  });
});

describe("Http", () => {
  it("retries 5xx/429 then succeeds", async () => {
    const m = mockFetch();
    m.once("GET", /x/, { status: 503, json: { error: { message: "busy" } } });
    m.once("GET", /x/, { status: 429, json: {} });
    m.once("GET", /x/, { json: { ok: 1 } });
    const h = new Http({ fetch: m.fetch, sleep: async () => {} });
    expect(await h.json({ method: "GET", url: "https://x" })).toEqual({ ok: 1 });
    expect(m.calls).toHaveLength(3);
  });

  it("surfaces Google's error message and does not retry 4xx", async () => {
    const m = mockFetch();
    m.on("POST", /x/, { status: 403, json: { error: { code: 403, message: "User does not have sufficient permission" } } });
    const h = new Http({ fetch: m.fetch, sleep: async () => {} });
    const e: any = await h.json({ method: "POST", url: "https://x", bearer: "SECRET" }).catch((err) => err);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.message).toMatch(/sufficient permission/);
    expect(e.message).not.toMatch(/SECRET/);
    expect(m.calls).toHaveLength(1);
  });

  it("dry-run records requests without credentials and never calls fetch", async () => {
    const h = new Http({ dryRun: true, fetch: () => { throw new Error("network!"); } });
    const r = await h.json({ method: "PUT", url: "https://x/y", bearer: "SECRET", body: { a: 1 } }, () => "fake");
    expect(r).toBe("fake");
    expect(h.dryRunLog).toEqual([{ method: "PUT", url: "https://x/y", body: { a: 1 } }]);
    expect(JSON.stringify(h.dryRunLog)).not.toMatch(/SECRET/);
  });
});
