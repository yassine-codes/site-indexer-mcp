import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Auth } from "./auth/index.js";
import { type Config, loadConfig } from "./config.js";
import { Http, type FetchLike } from "./http.js";
import type { Ctx } from "./ops.js";
import { registerTools } from "./tools.js";

export const VERSION = "0.1.0";

export function createServer(config: Config = loadConfig(), deps: { fetch?: FetchLike } = {}) {
  const http = new Http({ fetch: deps.fetch, dryRun: config.dryRun });
  const ctx: Ctx = { config, http, auth: new Auth(config, http) };
  const server = new McpServer(
    { name: "site-indexer", version: VERSION },
    {
      instructions:
        "site-indexer takes a deployed site to verified + sitemap submitted in Google Search Console. " +
        "Start with setup_site and follow its nextAction. For FILE verification you (the agent) must write the returned file " +
        "into the site's public directory, commit and deploy it, then call setup_site again. Never claim Google indexed a page " +
        "unless inspect_url says verdict PASS; there is no API to request indexing.",
    },
  );
  const tools = registerTools(server, ctx);
  return { server, ctx, tools };
}

export async function runStdio() {
  const { server, ctx, tools } = createServer();
  // stdout is the MCP channel: logs go to stderr only.
  console.error(
    `site-indexer ${VERSION} on stdio (${tools.length} tools${ctx.config.dryRun ? ", DRY RUN" : ""}${
      ctx.config.enableDestructive ? ", destructive tools ENABLED" : ""
    })`,
  );
  await server.connect(new StdioServerTransport());
}
