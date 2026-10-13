# Design check: raqn-i9qr.netlify.app

First real target: <https://raqn-i9qr.netlify.app/>, already verified **manually** with the FILE
method (`googlecc49033fa264f376.html`), with `/sitemap.xml` deployed.

## Observed from the public site (2026-10-13, read-only, no Google calls)

| Check | Result |
|---|---|
| `GET /googlecc49033fa264f376.html` | **200**, no redirect, body `google-site-verification: googlecc49033fa264f376.html`. `checkPlacement` → `ok: true`. Netlify's pretty-URL rewrite does not interfere. |
| `check_sitemap` | `urlset`, **1 URL** (`https://raqn-i9qr.netlify.app/`), no problems. |
| `parseSite("raqn-i9qr.netlify.app")` | `https://raqn-i9qr.netlify.app/` (URL-prefix, `SITE` / `FILE`). |

## Expected `setup_site` run with real credentials (owner-run)

Because the site was verified in the Search Console UI by the same Google account you sign in with,
the run should be **read-only up to the sitemap step**:

1. `auth`: `done` (after the one-time `auth login`).
2. `verification`: `GET siteVerification/v1/webResource` should list
   `{type: SITE, identifier: https://raqn-i9qr.netlify.app/}` → `done — Already verified.`
   No token request and no `insert`.
   *If it is not listed* (e.g. you verified with a different Google account), `setup_site` calls
   `getToken` (FILE). Google returns the **same** token for the same account+site+method, the file is
   already live, so `insert` succeeds on the first attempt. Nothing needs to be committed.
3. `property`: `GET webmasters/v3/sites` should show `siteOwner` → `Already present`. No `PUT`.
4. `sitemap`: if `https://raqn-i9qr.netlify.app/sitemap.xml` is already listed → `done`; otherwise
   one `PUT .../sitemaps/https%3A%2F%2Fraqn-i9qr.netlify.app%2Fsitemap.xml`.
5. `inspection`: homepage verdict (`PASS` once indexed, `NEUTRAL` / "URL is unknown to Google" before).

`nextAction`: schedule `inspect_urls` in 3–7 days.

## What a new site would do differently

For a fresh Netlify site, step 2 returns `action_required` with `placement.fileName` /
`fileContent`. `/index-site` writes it to `public/` (or the publish dir for plain HTML), commits,
pushes (Netlify deploys on push), then calls `setup_site` again. That call polls the URL until the deploy
is live, then verifies.
