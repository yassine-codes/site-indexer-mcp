#!/usr/bin/env node
// Dry-run smoke test over real stdio against a live (or local) site:
//   node scripts/smoke.mjs <site> [sitemapUrl]
// Google/DNS/IndexNow calls are simulated; the public site is really fetched.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [site, sitemapUrl] = process.argv.slice(2);
if (!site) {
  console.error("usage: node scripts/smoke.mjs <site> [sitemapUrl]");
  process.exit(2);
}
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli],
  env: { ...process.env, SITE_INDEXER_DRY_RUN: "1" },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  console.log(`\n=== ${name} ${r.isError ? "(ERROR)" : ""}`);
  try {
    const j = JSON.parse(text);
    return j.result ?? j;
  } catch {
    console.log(text);
    return undefined;
  }
};

const feed = sitemapUrl ?? new URL("sitemap.xml", site.endsWith("/") ? site : site + "/").toString();
console.log(JSON.stringify(await call("check_sitemap", { sitemapUrl: feed, site }), null, 2));
console.log(JSON.stringify((await call("get_verification_token", { site }))?.placement, null, 2));
const setup = await call("setup_site", { site, sitemapUrl: feed });
console.log(JSON.stringify({ complete: setup?.complete, steps: setup?.steps?.map((s) => `${s.step}: ${s.status} — ${s.detail}`), next: setup?.nextAction }, null, 2));
const insp = await call("inspect_urls", { site, fromSitemap: feed, limit: 5 });
console.log(JSON.stringify({ inspected: insp?.inspected, skippedOutsideProperty: insp?.skippedOutsideProperty, urls: insp?.results?.map((r) => r.url) }, null, 2));
await client.close();
