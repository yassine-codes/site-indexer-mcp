import { describe, expect, it } from "vitest";
import { candidateZones, cloudflareUpsert, netlifyUpsert } from "../src/dns/providers.js";
import { Http } from "../src/http.js";
import { generateKey, isValidKey, keyFile, ping } from "../src/indexnow.js";
import { parseSitemap, probeSitemap } from "../src/sitemap.js";
import { mockFetch } from "./helpers.js";

const rec = { host: "example.com", type: "TXT" as const, value: "google-site-verification=abc" };

describe("Netlify DNS", () => {
  it("finds the zone and POSTs the documented record body", async () => {
    const m = mockFetch();
    m.on("GET", "https://api.netlify.com/api/v1/dns_zones", [{ id: "z1", name: "example.com" }]);
    m.on("GET", "https://api.netlify.com/api/v1/dns_zones/z1/dns_records", []);
    m.on("POST", "https://api.netlify.com/api/v1/dns_zones/z1/dns_records", { id: "r1" });
    const r = await netlifyUpsert(new Http({ fetch: m.fetch }), "NTOKEN", rec);
    expect(r.created).toBe(true);
    expect(m.calls[2].body).toEqual({ type: "TXT", hostname: "example.com", value: "google-site-verification=abc", ttl: 3600 });
    expect(m.calls[2].headers.authorization).toBe("Bearer NTOKEN");
  });

  it("is idempotent", async () => {
    const m = mockFetch();
    m.on("GET", /dns_zones$/, [{ id: "z1", name: "example.com" }]);
    m.on("GET", /dns_records$/, [{ id: "r", hostname: "example.com", type: "TXT", value: "google-site-verification=abc" }]);
    const r = await netlifyUpsert(new Http({ fetch: m.fetch }), "t", rec);
    expect(r.created).toBe(false);
    expect(m.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("explains a missing zone", async () => {
    const m = mockFetch();
    m.on("GET", /dns_zones$/, []);
    await expect(netlifyUpsert(new Http({ fetch: m.fetch }), "t", rec)).rejects.toThrow(/Netlify DNS/);
  });
});

describe("Cloudflare DNS", () => {
  it("walks up to the zone apex and creates the record", async () => {
    const m = mockFetch();
    m.on("GET", /zones\?name=sub\.example\.com/, { success: true, result: [] });
    m.on("GET", /zones\?name=example\.com/, { success: true, result: [{ id: "cf1", name: "example.com" }] });
    m.on("GET", /zones\/cf1\/dns_records\?/, { success: true, result: [] });
    m.on("POST", "https://api.cloudflare.com/client/v4/zones/cf1/dns_records", { success: true, result: {} });
    const r = await cloudflareUpsert(new Http({ fetch: m.fetch }), "t", { ...rec, host: "sub.example.com" });
    expect(r).toMatchObject({ created: true, zone: "example.com" });
    expect(m.calls.at(-1)!.body).toMatchObject({ type: "TXT", name: "sub.example.com", content: rec.value, ttl: 1 });
  });

  it("candidateZones", () => {
    expect(candidateZones("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com"]);
  });
});

describe("IndexNow", () => {
  it("keys and key file", () => {
    const k = generateKey();
    expect(isValidKey(k)).toBe(true);
    expect(isValidKey("short")).toBe(false);
    expect(keyFile("https://x.com", k)).toEqual({ fileName: `${k}.txt`, fileContent: k, url: `https://x.com/${k}.txt` });
  });

  it("posts the protocol body and refuses foreign hosts", async () => {
    const m = mockFetch();
    m.on("POST", "https://api.indexnow.org/indexnow", { status: 202, text: "" });
    const h = new Http({ fetch: m.fetch });
    const key = "0123456789abcdef";
    await ping(h, { host: "x.com", key, keyLocation: `https://x.com/${key}.txt`, urls: ["https://x.com/a"] });
    expect(m.calls[0].body).toEqual({ host: "x.com", key, keyLocation: `https://x.com/${key}.txt`, urlList: ["https://x.com/a"] });
    await expect(ping(h, { host: "x.com", key, urls: ["https://y.com/a"] })).rejects.toThrow(/x\.com/);
  });
});

describe("sitemap probe", () => {
  it("parses urlset, sitemapindex, CDATA and entities", () => {
    expect(parseSitemap("<urlset><url><loc> https://x.com/?a=1&amp;b=2 </loc></url></urlset>")).toEqual({ kind: "urlset", locs: ["https://x.com/?a=1&b=2"] });
    expect(parseSitemap("<sitemapindex><sitemap><loc><![CDATA[https://x.com/s1.xml]]></loc></sitemap></sitemapindex>").locs).toEqual(["https://x.com/s1.xml"]);
  });

  it("flags HTML fallbacks and wrong hosts (e.g. placeholder canonical domain)", async () => {
    const m = mockFetch();
    m.on("GET", "https://a.netlify.app/sitemap.xml", { text: "<urlset><url><loc>https://placeholder.ma/</loc></url></urlset>" });
    m.on("GET", "https://a.netlify.app/s2.xml", { text: "<!doctype html><html></html>" });
    const h = new Http({ fetch: m.fetch });
    const p1 = await probeSitemap(h, "https://a.netlify.app/sitemap.xml", "a.netlify.app");
    expect(p1.ok).toBe(false);
    expect(p1.problems[0]).toMatch(/not on a\.netlify\.app/);
    const p2 = await probeSitemap(h, "https://a.netlify.app/s2.xml");
    expect(p2.problems.join()).toMatch(/SPA fallback/);
  });
});
