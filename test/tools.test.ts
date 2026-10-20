import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { testConfig } from "./helpers.js";

async function connect(over = {}) {
  const { server } = createServer(testConfig(over), {
    fetch: () => {
      throw new Error("network!");
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: any) => r.content[0].text as string;

describe("MCP surface", () => {
  it("exposes the safe tools only by default", async () => {
    const c = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "add_site", "auth_login", "auth_logout", "auth_status", "check_sitemap", "create_dns_record", "get_verification_token",
        "indexnow_key", "indexnow_ping", "inspect_url", "inspect_urls", "list_sitemaps", "list_sites", "setup_site",
        "submit_sitemap", "verify_site",
      ].sort(),
    );
  });

  it("registers destructive tools only behind the flag, and they demand confirm", async () => {
    const c = await connect({ enableDestructive: true, dryRun: true });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["delete_site", "delete_sitemap", "unverify_site", "set_owners"]));
    const bad = await c.callTool({ name: "delete_site", arguments: { site: "x.com", confirm: "yes" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/confirm must be exactly "https:\/\/x\.com\/"/);
    const good = await c.callTool({ name: "delete_site", arguments: { site: "x.com", confirm: "https://x.com/" } });
    expect(JSON.parse(text(good))).toMatchObject({ dryRun: true, result: { deleted: "https://x.com/" } });
  });

  it("setup_site in dry-run reports every call it would make", async () => {
    const c = await connect({ dryRun: true });
    const r = await c.callTool({ name: "setup_site", arguments: { site: "raqn-i9qr.netlify.app" } });
    const out = JSON.parse(text(r));
    expect(out.result.complete).toBe(true);
    expect(out.wouldCall.map((x: any) => x.method)).toEqual(expect.arrayContaining(["POST", "PUT", "GET"]));
  });

  it("get_verification_token returns the file hand-off (dry-run)", async () => {
    const c = await connect({ dryRun: true });
    const out = JSON.parse(text(await c.callTool({ name: "get_verification_token", arguments: { site: "raqn-i9qr.netlify.app" } })));
    expect(out.result.placement).toMatchObject({ method: "FILE", fileName: "google0000dryrun0000.html" });
  });

  it("errors are returned as tool errors, not crashes", async () => {
    const c = await connect();
    const r = await c.callTool({ name: "list_sites", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Not authenticated/);
  });
});
