# Hosting recipes

site-indexer is host-agnostic: it only needs the token to be reachable on the live site (FILE/META)
or in DNS (DNS_TXT/CNAME). The `/index-site` skill picks the recipe from the repo it runs in.

| Host / stack | Recommended method | Where the FILE goes | Deploy | DNS automation |
|---|---|---|---|---|
| Netlify, plain HTML | FILE | `[build] publish` dir from `netlify.toml` (often the repo root) | push to the deploy branch, or `netlify deploy --prod` | `create_dns_record provider=netlify` if the domain uses Netlify DNS |
| Netlify / Vercel / Cloudflare Pages + Vite, Astro, Next, SvelteKit, Nuxt | FILE | the **source** static dir: `public/` (Vite, Astro, Next, Nuxt), `static/` (SvelteKit, Hugo) | push (git-integrated builds) | Netlify DNS or Cloudflare |
| GitHub Pages | FILE | the published root (`docs/` or the Pages branch); for project pages the property is `https://user.github.io/repo/` | push | n/a |
| Self-hosted (Node/nginx, Docker) | FILE, or DNS_TXT for the whole domain | the app's static dir copied into the build output | the project's deploy script | Cloudflare if the zone is there |
| Custom domain, many subdomains | `sc-domain:example.com` + DNS_TXT | n/a | n/a | Netlify DNS / Cloudflare, else registrar (manual record) |

Checks that apply everywhere:

- The file must return **HTTP 200 at the exact URL, with no redirect**. Watch for pretty-URL rewrites
  and SPA fallbacks that answer every path with `index.html`. `verify_site` reports both.
- The sitemap's `<loc>` URLs must be on the property's host. Frameworks build them from a base-URL
  setting (`site` in Astro, `SITE_URL` / `PUBLIC_URL` env vars, `baseURL` in Hugo). `check_sitemap` flags
  a mismatch.
- Keep the verification file or record forever.
