import { describe, expect, it } from "vitest";
import { Http } from "../src/http.js";
import { checkPlacement, placementFor } from "../src/placement.js";
import { parseSite } from "../src/site.js";
import { mockFetch } from "./helpers.js";

const raqn = parseSite("https://raqn-i9qr.netlify.app/");

describe("placementFor", () => {
  it("FILE: file name is the token, content matches Search Console's download", () => {
    const p = placementFor(raqn, "FILE", "googlecc49033fa264f376.html");
    expect(p).toMatchObject({
      fileName: "googlecc49033fa264f376.html",
      fileContent: "google-site-verification: googlecc49033fa264f376.html",
      url: "https://raqn-i9qr.netlify.app/googlecc49033fa264f376.html",
    });
  });

  it("FILE rejects unexpected tokens (no path traversal into the repo)", () => {
    expect(() => placementFor(raqn, "FILE", "../../etc/passwd")).toThrow();
  });

  it("DNS_TXT targets the apex", () => {
    const p = placementFor(parseSite("sc-domain:example.com"), "DNS_TXT", "google-site-verification=abc");
    expect(p).toMatchObject({ recordType: "TXT", host: "example.com", value: "google-site-verification=abc" });
  });

  it("DNS_CNAME splits label and target", () => {
    const p = placementFor(parseSite("sc-domain:example.com"), "DNS_CNAME", "abc123 gv-xyz.dv.googlehosted.com");
    expect(p).toMatchObject({ host: "abc123.example.com", target: "gv-xyz.dv.googlehosted.com" });
  });

  it("refuses method/property mismatches", () => {
    expect(() => placementFor(raqn, "DNS_TXT", "x")).toThrow();
    expect(() => placementFor(parseSite("sc-domain:example.com"), "FILE", "google1.html")).toThrow();
  });
});

describe("checkPlacement", () => {
  const file = placementFor(raqn, "FILE", "googlecc49033fa264f376.html");

  it("passes when the file is live with the right content", async () => {
    const m = mockFetch();
    m.on("GET", file.method === "FILE" ? file.url : "", { text: "google-site-verification: googlecc49033fa264f376.html" });
    const r = await checkPlacement(new Http({ fetch: m.fetch }), file);
    expect(r.ok).toBe(true);
  });

  it("explains a 404 (not deployed yet)", async () => {
    const m = mockFetch();
    m.on("GET", /google/, { status: 404, text: "nope" });
    const r = await checkPlacement(new Http({ fetch: m.fetch }), file);
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toMatch(/404/);
  });

  it("detects SPA fallback pages served with 200", async () => {
    const m = mockFetch();
    m.on("GET", /google/, { text: "<!doctype html><div id=root></div>" });
    const r = await checkPlacement(new Http({ fetch: m.fetch }), file);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/SPA/);
  });

  it("detects pretty-URL redirects", async () => {
    const m = mockFetch();
    m.on("GET", /google/, () => ({ text: "google-site-verification: googlecc49033fa264f376.html", url: "https://raqn-i9qr.netlify.app/googlecc49033fa264f376" }));
    const r = await checkPlacement(new Http({ fetch: m.fetch }), file);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Redirected/);
  });

  it("finds META tags regardless of attribute order", async () => {
    const meta = placementFor(raqn, "META", '<meta name="google-site-verification" content="TOK_1" />');
    const m = mockFetch();
    m.on("GET", "https://raqn-i9qr.netlify.app/", { text: '<head><meta content="TOK_1" name="google-site-verification"></head>' });
    expect((await checkPlacement(new Http({ fetch: m.fetch }), meta)).ok).toBe(true);
  });

  it("joins chunked TXT records", async () => {
    const p = placementFor(parseSite("sc-domain:example.com"), "DNS_TXT", "google-site-verification=abcdef");
    const txt = async () => [["v=spf1 -all"], ["google-site-verification=", "abcdef"]];
    expect((await checkPlacement(new Http(), p, { txt })).ok).toBe(true);
    const none = async () => [["v=spf1 -all"]];
    expect((await checkPlacement(new Http(), p, { txt: none })).ok).toBe(false);
  });

  it("is skipped in dry-run", async () => {
    expect((await checkPlacement(new Http({ dryRun: true }), file)).checked).toBe("dry-run");
  });
});
