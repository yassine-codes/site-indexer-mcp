#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Auth } from "./auth/index.js";
import { openBrowser } from "./browser.js";
import { loadConfig } from "./config.js";
import { Http } from "./http.js";
import { runStdio } from "./server.js";

const HELP = `site-indexer — MCP server for Google Search Console onboarding

Usage:
  site-indexer                 Run the MCP server on stdio (what Claude Code launches)
  site-indexer auth login      One-time Google sign-in in your browser
  site-indexer auth status     Show auth state (no secrets)
  site-indexer auth logout     Delete the stored refresh token
  site-indexer install-skill [--project]
                               Install the /index-site skill into ~/.claude/skills
                               (or ./.claude/skills with --project)
  site-indexer --help

Env: GOOGLE_OAUTH_CLIENT_FILE | GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET,
     GOOGLE_SERVICE_ACCOUNT_FILE, SITE_INDEXER_DRY_RUN, SITE_INDEXER_ENABLE_DESTRUCTIVE,
     NETLIFY_AUTH_TOKEN, CLOUDFLARE_API_TOKEN, INDEXNOW_KEY, SITE_INDEXER_CONFIG_DIR`;

async function main(argv: string[]) {
  const [cmd, sub] = argv;
  if (!cmd) return runStdio();
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return console.log(HELP);
  if (cmd === "--version") return console.log("0.1.0");
  if (cmd === "install-skill") return installSkill(sub === "--project");
  if (cmd !== "auth") {
    console.error(`Unknown command: ${cmd}\n\n${HELP}`);
    process.exit(2);
  }
  const config = loadConfig();
  const auth = new Auth(config, new Http({ dryRun: config.dryRun }));
  if (sub === "status") return console.log(JSON.stringify(await auth.status(), null, 2));
  if (sub === "logout") return console.log((await auth.logout()) ? "Token removed." : "No token stored.");
  if (sub === "login") {
    const { authUrl, done } = await auth.startLogin();
    console.log(`Opening your browser. If it does not open, visit:\n\n  ${authUrl}\n`);
    openBrowser(authUrl);
    await done;
    console.log(`Signed in. Refresh token saved to ${auth.store.file} (mode 0600).`);
    return;
  }
  console.error(HELP);
  process.exit(2);
}

async function installSkill(project: boolean) {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "index-site", "SKILL.md");
  const base = project ? path.join(process.cwd(), ".claude") : path.join(os.homedir(), ".claude");
  const dest = path.join(base, "skills", "index-site", "SKILL.md");
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  console.log(`Installed /index-site skill to ${dest}`);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`site-indexer: ${e?.message ?? e}`);
  process.exit(1);
});
