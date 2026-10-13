# site-indexer

A **local MCP server** (stdio) that takes a newly deployed website from *just deployed* to
**verified in Google Search Console, sitemap submitted, indexing monitored**, with no
per-site clicking. The only manual step is a **one-time Google sign-in**, shared by all your sites.

```
deploy ─▶ setup_site ─▶ get token ─▶ agent commits file / DNS record ─▶ deploy
                ▲                                                         │
                └──────────── setup_site again (verify w/ backoff) ◀──────┘
                     ─▶ sites.add ─▶ sitemaps.submit ─▶ URL inspection ─▶ schedule re-check
```

- Uses the **Site Verification API** (to get and trigger verification) and the **Search Console API**
  (properties, sitemaps, URL Inspection). Existing GSC MCP servers have only the second.
- Properties land in **your own** Search Console account (OAuth installed-app flow).
- Ships a Claude Code skill, **`/index-site <url>`**, that drives the whole loop in a site's repo.
- **Generic:** one install and one sign-in serve every site you publish, on any host (Netlify, Vercel,
  Cloudflare Pages, GitHub Pages, self-hosted). Nothing is tied to one project. See
  [docs/hosting-recipes.md](docs/hosting-recipes.md).

## Tools

| Tool | What it does |
|---|---|
| `auth_status` | Signed in? Which mode? What to do if not. Never returns secrets. |
| `auth_login` / `auth_logout` | One-time loopback OAuth on `127.0.0.1` (PKCE). Returns the consent URL and tries to open your browser. |
| `get_verification_token` | Exact thing to place: **FILE** → `fileName` + `fileContent`; **META** → tag; **DNS_TXT / DNS_CNAME** → record. |
| `verify_site` | Checks locally that the token is live (file / meta / DNS), then calls `webResource.insert`, retrying with backoff (5s, 10s, 20s, 30s…) up to `maxWaitSeconds`. Idempotent. |
| `create_dns_record` | For `sc-domain:` properties: creates the TXT/CNAME via **Netlify DNS** or **Cloudflare**. Skips if it already exists. |
| `list_sites` / `add_site` | Search Console properties; `sites.add` (after verification). |
| `check_sitemap` | Fetches the live sitemap (no Google call): URL count, samples, wrong-host / HTML-fallback problems. |
| `submit_sitemap` / `list_sitemaps` | Probes, then `sitemaps.submit`; Google's status (pending, errors, last download). |
| `inspect_url` / `inspect_urls` | URL Inspection (read-only): verdict, coverage, last crawl, canonicals; batch from the sitemap. |
| **`setup_site`** | Orchestrator. Idempotent; stops at the first step needing action and returns `nextAction`. |
| `indexnow_key` / `indexnow_ping` | Optional. IndexNow for Bing/Yandex/Seznam/Naver. **Not Google.** |
| `delete_site`, `delete_sitemap`, `unverify_site`, `set_owners` | **Destructive. Not registered** unless `SITE_INDEXER_ENABLE_DESTRUCTIVE=1`; each needs `confirm` = the exact property id. |

`setup_site` output (abridged) for a site whose file is not deployed yet:

```json
{
  "site": "https://my-site.netlify.app/",
  "complete": false,
  "steps": [
    { "step": "auth", "status": "done" },
    { "step": "verification", "status": "action_required", "detail": "Token not in place yet: HTTP 404; the file is not deployed yet." }
  ],
  "nextAction": {
    "who": "agent",
    "do": "Create \"google1234abcd.html\" in the directory that is published at https://my-site.netlify.app/ ... commit, deploy, then call verify_site. Then call setup_site again.",
    "placement": { "method": "FILE", "fileName": "google1234abcd.html", "fileContent": "google-site-verification: google1234abcd.html", "url": "https://my-site.netlify.app/google1234abcd.html" }
  }
}
```

### Who does what with FILE verification

The server **does not touch your repo or your host**. It returns the file name and content.
The **calling agent** (Claude Code in the site's repo, driven by `/index-site`) writes the file into
the directory that ends up at the site root (`public/` for Vite/Next/Astro, `static/` for Hugo/SvelteKit,
the repo root for plain HTML), commits it, and deploys. `setup_site` / `verify_site` then poll the live
URL until the deploy is out before asking Google. Keep the file forever: Google re-checks it.

For domain properties (`sc-domain:example.com`), `create_dns_record` (or `setup_site` with
`dnsProvider`) writes the TXT record with your Netlify or Cloudflare token. Otherwise the agent gives
you the exact record for your registrar.

---

## One-time Google Cloud setup (≈10 minutes, once for all sites)

1. **Create a project**: <https://console.cloud.google.com/projectcreate> (e.g. `site-indexer`).
2. **Enable both APIs** in that project:
   - Google Site Verification API: <https://console.cloud.google.com/apis/library/siteverification.googleapis.com>
   - Google Search Console API: <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com>
3. **OAuth consent screen** (Google Auth Platform → Branding / Audience):
   user type **External**, app name `site-indexer`, your email as support and developer contact.
   Under **Data access**, add the scopes `https://www.googleapis.com/auth/siteverification` and
   `https://www.googleapis.com/auth/webmasters`.
4. **Publish the app: Audience → "Publish app" → In production.** In *Testing* mode, Google expires
   refresh tokens after **7 days**, so you would have to sign in again every week. An unverified app in
   production is fine for personal use: you click through the "Google hasn't verified this app" screen
   once (Advanced → Go to site-indexer).
5. **Create credentials → OAuth client ID → Application type: Desktop app.** Download the JSON
   (e.g. `~/.config/site-indexer/client_secret.json`; keep it out of git).

## Install

Requires Node ≥ 20.

```bash
# From GitHub (private repo: needs your normal git credentials). Builds on install.
claude mcp add site-indexer --scope user \
  -e GOOGLE_OAUTH_CLIENT_FILE=$HOME/.config/site-indexer/client_secret.json \
  -- npx -y github:yassine-codes/site-indexer

# Or from a local clone
git clone git@github.com:yassine-codes/site-indexer.git && cd site-indexer && npm ci && npm run build
claude mcp add site-indexer --scope user \
  -e GOOGLE_OAUTH_CLIENT_FILE=$HOME/.config/site-indexer/client_secret.json \
  -- node "$PWD/dist/cli.js"
```

Claude Desktop / other MCP clients use the same command in their config:

```json
{
  "mcpServers": {
    "site-indexer": {
      "command": "node",
      "args": ["/abs/path/site-indexer/dist/cli.js"],
      "env": { "GOOGLE_OAUTH_CLIENT_FILE": "/abs/path/client_secret.json" }
    }
  }
}
```

**Sign in once**, from a terminal (`npx site-indexer auth login`, or `node dist/cli.js auth login`)
or by asking Claude to run `auth_login`. The browser opens, you approve, and the token is stored. Check with
`auth status`.

**Install the skill** (adds `/index-site` to Claude Code):

```bash
node dist/cli.js install-skill            # ~/.claude/skills/index-site
node dist/cli.js install-skill --project  # ./.claude/skills/index-site (commit it to a site repo)
```

Then, in any site's repo: **`/index-site https://my-site.netlify.app/`**

### Environment variables

| Variable | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_FILE` | Path to the Desktop OAuth client JSON. *Or:* |
| `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` | Same, inline. |
| `SITE_INDEXER_CONFIG_DIR` | Override token location. Default: `~/.config/site-indexer` (Linux, `$XDG_CONFIG_HOME`), `~/Library/Application Support/site-indexer` (macOS), `%APPDATA%\site-indexer` (Windows). |
| `SITE_INDEXER_DRY_RUN=1` | No Google, DNS-provider or IndexNow requests; tools return `wouldCall`. The public site **is** still fetched (read-only). |
| `SITE_INDEXER_ENABLE_DESTRUCTIVE=1` | Registers delete/unverify/owner tools (still need `confirm`). |
| `NETLIFY_AUTH_TOKEN` | Netlify personal access token, for `create_dns_record` with Netlify DNS. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare token with *Zone → DNS → Edit* on the zone. |
| `INDEXNOW_KEY` | Your IndexNow key (after publishing `<key>.txt`). |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | Optional service-account mode (see caveat). |
| `SITE_INDEXER_EXTRA_OWNERS` | Comma-separated emails added as owners on verification (service-account mode). |

### Service-account mode (optional, read the caveat)

Set `GOOGLE_SERVICE_ACCOUNT_FILE` to a key JSON. Sources disagree on whether a service account can
complete Site Verification. Where it can, the property belongs to the **service account**: it does not
appear in *your* Search Console unless you are also an owner. Set `SITE_INDEXER_EXTRA_OWNERS=you@gmail.com`,
or add the service account as a user of an existing property instead. OAuth mode is the supported path.

## Security

- **Scopes:** only `siteverification` and `webmasters`. No Gmail/Drive/etc.
- **Refresh token** in `token.json` in the config dir, written atomically with mode **0600** in a
  **0700** directory. Access tokens live only in memory. No tool returns a secret; `auth_status`
  shows mode, scopes and file path only. Errors never include the bearer token.
- **Loopback OAuth** listens on `127.0.0.1` on a random port for one request, with **PKCE** and a random
  `state`. The listener closes after the redirect or after 5 minutes.
- **No repo writes and no shell.** The server returns file contents; the agent writes them. FILE tokens are
  validated against `^google[0-9a-z]+\.html$`, so a hostile response cannot steer a path.
- **Destructive tools are off by default** and need the exact property id as `confirm`.
- **Revoke** any time: <https://myaccount.google.com/permissions>, plus `site-indexer auth logout`.
- Netlify/Cloudflare tokens come from env only and are sent only to their own APIs.

## Honest limits

- **There is no public API to "Request indexing."** URL Inspection is read-only. Google discovers
  pages through the submitted sitemap and links. The Indexing API is only for `JobPosting` /
  `BroadcastEvent` pages, and this server deliberately does not use it. The sitemap "ping" endpoint was
  retired in 2023.
- **Time:** verification succeeds as soon as the deploy is live (FILE/META) or DNS propagates (minutes
  to hours; `verify_site` retries up to `maxWaitSeconds`, so call it again later). A new site typically
  shows *"URL is unknown to Google"* for days, and first indexing often takes **days to weeks**.
- **Quotas** (per Google docs, subject to change): URL Inspection ≈ **2,000/day and 600/min per
  property**. `inspect_urls` caps at 100 per call and stops on the first 429/403. Search Console and
  Site Verification have per-project QPS limits, which normal use won't hit.
- **IndexNow** reaches Bing, Yandex, Seznam, Naver and Yep. **Not Google.**
- `DNS_CNAME` token parsing assumes Google's `"<label> <target>"` format. `DNS_TXT` is the recommended
  method for domain properties.
- Removing the verification file or record later can unverify the site.

## Development

```bash
npm ci
npm test            # vitest: unit + MCP in-memory tests, all Google HTTP mocked
npm run typecheck
npm run build
node scripts/smoke.mjs https://my-site.netlify.app/   # dry-run over real stdio against the live site
```

The tests never touch the network: `mockFetch` fails on any unmocked request.

### Owner-run live verification (needs your real credentials)

These have **not** been run by the author (no Google credentials in the build environment):

```bash
export GOOGLE_OAUTH_CLIENT_FILE=~/.config/site-indexer/client_secret.json
node dist/cli.js auth login
node dist/cli.js auth status                                     # ready: true
node scripts/smoke.mjs https://raqn-i9qr.netlify.app/            # still dry-run: shows the plan
# real run, read-mostly on an already-verified site (raqn: no writes expected except sitemap if missing):
# then, in Claude Code (interactive), from the raqn repo:
#   /index-site https://raqn-i9qr.netlify.app/
```

Validation runs: [docs/validation/raqn.md](docs/validation/raqn.md) (Netlify static site, what each step
should return) and [docs/validation/code2025.md](docs/validation/code2025.md) (self-hosted Node app, local
integration run).

## License

MIT
