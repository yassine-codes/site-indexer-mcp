import { describe, expect, it } from "vitest";
import { defaultSitemapUrl, parseSite, urlBelongsTo, verificationSite } from "../src/site.js";

describe("parseSite", () => {
  it("normalises bare hosts to https URL-prefix with trailing slash", () => {
    const r = parseSite("raqn-i9qr.netlify.app");
    expect(r).toMatchObject({ kind: "url-prefix", siteUrl: "https://raqn-i9qr.netlify.app/", host: "raqn-i9qr.netlify.app" });
    expect(verificationSite(r)).toEqual({ type: "SITE", identifier: "https://raqn-i9qr.netlify.app/" });
  });

  it("keeps sub-paths and strips file names, query and hash", () => {
    expect(parseSite("https://u.github.io/proj").siteUrl).toBe("https://u.github.io/proj/");
    expect(parseSite("https://x.com/index.html?a=1#b").siteUrl).toBe("https://x.com/");
    expect(parseSite("http://x.com").siteUrl).toBe("http://x.com/");
  });

  it("parses domain properties", () => {
    const r = parseSite("sc-domain:Example.COM");
    expect(r).toMatchObject({ kind: "domain", domain: "example.com", siteUrl: "sc-domain:example.com" });
    expect(verificationSite(r)).toEqual({ type: "INET_DOMAIN", identifier: "example.com" });
  });

  it("rejects junk", () => {
    expect(() => parseSite("")).toThrow();
    expect(() => parseSite("sc-domain:not a domain")).toThrow();
    expect(() => parseSite("https://-bad-.com")).toThrow();
  });
});

describe("urlBelongsTo / defaultSitemapUrl", () => {
  it("scopes URL-prefix properties by origin + path", () => {
    const r = parseSite("https://u.github.io/proj/");
    expect(urlBelongsTo(r, "https://u.github.io/proj/a")).toBe(true);
    expect(urlBelongsTo(r, "https://u.github.io/proj")).toBe(true);
    expect(urlBelongsTo(r, "https://u.github.io/other")).toBe(false);
    expect(urlBelongsTo(r, "http://u.github.io/proj/a")).toBe(false);
    expect(defaultSitemapUrl(r)).toBe("https://u.github.io/proj/sitemap.xml");
  });

  it("domain properties include subdomains and both schemes", () => {
    const r = parseSite("sc-domain:example.com");
    expect(urlBelongsTo(r, "http://www.example.com/x")).toBe(true);
    expect(urlBelongsTo(r, "https://evil-example.com/")).toBe(false);
    expect(defaultSitemapUrl(r)).toBe("https://example.com/sitemap.xml");
  });
});
