# Live run: uktob.app

First real target. The site was first published at `raqn-i9qr.netlify.app` (verified **manually** in
the Search Console UI with the FILE method, `googlecc49033fa264f376.html`) and then moved to the
custom domain <https://uktob.app/>. The old `*.netlify.app` URL now returns 404; `www.uktob.app`
301-redirects to the apex.

## Observed from the public site (2026-10-20, read-only)

| Check | Result |
|---|---|
| `GET https://uktob.app/googlecc49033fa264f376.html` | **200**, no redirect. The file deployed for the old URL is served on the custom domain too. |
| `GET https://uktob.app/sitemap.xml` | **200**, `urlset`, **1 URL** (`https://uktob.app/`), on the right host. |
| `GET https://www.uktob.app/` | **301** → `https://uktob.app/`. One URL-prefix property (apex) is enough. |
| `parseSite("https://uktob.app/")` | `https://uktob.app/` (URL-prefix, `SITE` / `FILE`). |

## Live `setup_site` run (2026-10-20, OAuth, not dry-run)

`/index-site https://uktob.app/` from Claude Code. One call, `complete: true`, no commit or deploy needed.

| Step | Result |
|---|---|
| `auth` | `done`, `mode=oauth`. |
| `verification` | `done — Verified with FILE after 1 attempt(s).` `uktob.app` was a new URL for Google, so it was not in `webResource.list`; `getToken` returned the same `googlecc49033fa264f376.html` token (same account + method), the file was already live, and `insert` succeeded first try. |
| `property` | `done — Added to Search Console.` (`sites.add`) |
| `sitemap` | `done — Submitted https://uktob.app/sitemap.xml.` `sitemaps.get` right after: `isPending: true`, `errors: "0"`, `warnings: "0"` (int64 counts come back as strings, as typed). |
| `inspection` | `PASS / Submitted and indexed`, `pageFetchState: SUCCESSFUL`, `robotsTxtState: ALLOWED`, Google canonical = user canonical = `https://uktob.app/`. |

`nextAction`: schedule `inspect_urls` in 3–7 days (little value here: the sitemap has 1 URL and it is
already indexed).

**Real-API mismatches found:** none. Every response matched the shapes the mocked tests assume.

**Not yet exercised live:** the `Already verified` short-circuit (a second `setup_site` on the same
site covers it), META and DNS methods, and `action_required` for a site whose file is not deployed.

## What a new site would do differently

For a fresh site, step 2 returns `action_required` with `placement.fileName` /
`fileContent`. `/index-site` writes it to `public/` (or the publish dir for plain HTML), commits,
pushes (Netlify deploys on push), then calls `setup_site` again. That call polls the URL until the deploy
is live, then verifies.

When a site moves to a custom domain, keep the verification file deployed and run `/index-site` on the
new URL: it is a new property for Google, verified with the same file.
