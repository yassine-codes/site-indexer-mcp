---
name: index-site
description: Take a freshly deployed site to "verified in Google Search Console, sitemap submitted, indexing monitored" using the site-indexer MCP server. Use when the user says "/index-site <url>", "get this site indexed", "add this site to Search Console", "verify my site with Google", or right after deploying a new static site.
argument-hint: <site-url> [sitemap-url]
---

# /index-site

Drive the full Search Console onboarding loop for **$ARGUMENTS** with the
`site-indexer` MCP tools (`mcp__site-indexer__*`). The repository you are in is
the site's source; you are the one who places the verification token and deploys.

If the site-indexer tools are missing, stop and tell the user to install it:
`claude mcp add site-indexer -e GOOGLE_OAUTH_CLIENT_FILE=/path/to/client.json -- npx -y github:yassine-codes/site-indexer`

## Loop

1. **Parse input.** First word of `$ARGUMENTS` is the site (`https://x.netlify.app/`,
   `example.com`, or `sc-domain:example.com`); an optional second is the sitemap URL.
2. **Call `setup_site`** with `site` (and `sitemapUrl` if given). Read `steps` and
   `nextAction`. Repeat from here after every action below. Stop when `complete: true`.
3. **Act on `nextAction`:**
   - `tool: "auth_login"` → call `auth_login`, show the user the `authUrl`, ask them to
     approve in their browser, poll `auth_status` until `ready: true`. One-time only.
   - `placement.method == "FILE"` → find the directory published at the site root:
     `netlify.toml` `[build] publish` (for Vite/Next/Astro/SvelteKit that is the build output,
     so put the file in the **source** static dir instead: `public/`, `static/`),
     otherwise `public/`, `static/`, or the repo root for plain HTML. Works the same on
     Vercel, Cloudflare Pages, GitHub Pages and self-hosted apps; see the repo's own deploy
     docs/scripts (README, `DEPLOY.md`, CI workflows) for how this project ships.
     Write `placement.fileName` with exactly `placement.fileContent` (no trailing newline
     needed), make sure it is not git-ignored, commit it
     (`chore(seo): add Google Search Console verification file`) and deploy the way this
     repo deploys (push to the deploy branch / `netlify deploy --prod` / documented
     command). Pushing to a production branch is outward-facing: confirm with the user
     first unless they already said to deploy. Then call `setup_site` again; its
     verification step retries while the deploy propagates.
   - `placement.method == "META"` → add `placement.metaTag` inside `<head>` of the home
     page template, commit, deploy, call `setup_site` again.
   - `placement.method == "DNS_TXT"/"DNS_CNAME"` → if the domain uses Netlify DNS or
     Cloudflare and `NETLIFY_AUTH_TOKEN` / `CLOUDFLARE_API_TOKEN` is configured, call
     `setup_site` again with `dnsProvider`. Otherwise give the owner the exact record
     (`host`, `recordType`, `value`) for their registrar. DNS can take minutes to hours;
     call `verify_site` with `maxWaitSeconds: 300` later.
   - sitemap `action_required` → the site has no reachable sitemap. Add one using the
     framework's plugin (e.g. `@astrojs/sitemap`, `next-sitemap`) or a static
     `sitemap.xml`, deploy, call `setup_site` again. If `check_sitemap` reports URLs on a
     different host, fix the site's canonical/base URL setting first.
   - `who: "owner"` with an error → relay it verbatim; do not retry blindly.
4. **Schedule monitoring.** When complete, schedule a follow-up in 3–7 days that calls
   `inspect_urls` with `{ site }` (it reads the sitemap) and reports indexed vs not
   indexed. Use whatever scheduler this session has (a routine / `send_later` /
   CronCreate / `/loop`); if none, tell the user the exact tool call to run later.
5. **Optional, non-Google:** offer IndexNow for Bing/Yandex: `indexnow_key` → commit the
   key file → deploy → `indexnow_ping`.

## Rules

- Never delete the verification file or DNS record afterwards: Google re-checks it,
  and removing it eventually unverifies the site.
- There is no API to "Request indexing". Never claim a page is indexed unless
  `inspect_url` returns `verdict: "PASS"`. New sites typically show
  "URL is unknown to Google" for days.
- Do not use the Google Indexing API; it is only for JobPosting/BroadcastEvent pages.
- Never print or commit OAuth client secrets, tokens or API keys.

## Report

Finish with a short table: verification (method, done?), property added, sitemap
(submitted, URL count), homepage inspection verdict, and the scheduled follow-up.
