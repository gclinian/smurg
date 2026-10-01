# @smurg/site: smurg.ai

The product page at https://smurg.ai (English) and https://smurg.ai/zh-TW/ (Traditional Chinese). Hand-written HTML
and CSS in `public/`, no framework and no build step. A Cloudflare Worker with static assets serves it; the Worker
script (`src/`) only answers a few redirects. The workspace app (relay and web app) is a different Worker, on
https://app.smurg.ai.

| Path | Answer |
|---|---|
| `/`, `/zh-TW/` | the page (`public/index.html`, `public/zh-TW/index.html`); `/zh-TW` and `/index.html` redirect there |
| `/install.sh` | 302 to `https://github.com/gclinian/smurg/releases/latest/download/install.sh` |
| `/github` | 302 to the repository |
| `/docs` | 302 to the repository's `docs/` folder |
| `/docs/<file>` | 302 to that file in `docs/` on GitHub (plain names only; anything else gets the 404 page) |
| `www.smurg.ai/<path>` | 301 to `https://smurg.ai/<path>`, query kept: the zone's Redirect Rule, before any Worker (not a route of this Worker) |
| anything else | `public/404.html` (or `public/zh-TW/404.html` under `/zh-TW/`), status 404 |

`curl -fsSL https://smurg.ai/install.sh | sh` therefore runs the release's own `install.sh`, which downloads the
executable from GitHub and checks it against the release's `SHA256SUMS`; this Worker never serves or proxies the
script.

`public/_headers` sets the security headers for every file: a strict CSP (only this site's own files, no inline code,
Trusted Types), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a deny-by-default `Permissions-Policy`, HSTS.
A page loads `/style.css`, `/copy.js` (the copy button; the page works without it) and `/favicon.svg`, nothing else:
no third-party requests, no analytics, no web fonts.

## The Worker-request quota

Workers Free counts 100,000 Worker requests a day for the whole Cloudflare account, and the shared relay is on the
same account (`docs/RELEASING.md` §8). Requests for static files that do not run the Worker are free. So
`wrangler.jsonc` lists only the redirect paths in `assets.run_worker_first` (`src/routes.ts` `WORKER_PATHS`;
`test/config.test.ts` keeps the two equal): a page view runs no Worker at all, and neither does a 404 (the static
assets serve `404.html` themselves).

The www → apex redirect therefore cannot be this Worker's job (it would not run for a page view), and it is not: it
is a **Cloudflare Redirect Rule** on the zone, which runs before any Worker and costs no Worker request (see
"Deploying"). `www.smurg.ai` is **not** a route of this Worker; `wrangler.jsonc` lists the apex only, and
`test/config.test.ts` asserts exactly that. The Worker still 301s a `www.smurg.ai` request that reaches it (defence in
depth, tested), and the pages name `https://smurg.ai/` as their canonical URL.

## Editing

- Both languages have the same sections and ids in the same order (`test/site.test.ts` checks). Change the English
  page first, then the Traditional Chinese one, with the terms the app and the docs use (主人, 組員, 邀請連結,
  「旁觀」「可編輯」「可執行 agent」, worktree, agent, session, 沙盒, 網頁版).
- Only state what `README.md`, `CHANGELOG.md`, `SPEC.md` and `docs/` back. When in doubt, cut the sentence.
- No inline `<script>`, `<style>`, `style="…"` or `on…=` handlers: the CSP blocks them. Colours and type live in
  `public/style.css` (the page's tokens follow `apps/web/src/ui/tokens.css`; the workspace picture in the hero has
  its own, the app's).
- The workspace picture under the install line (`.mock`) is drawn after `apps/web/src/app/workspace/Workbench.tsx`
  with the app's own Traditional Chinese labels (`lang="zh-TW"` on it in both pages). It is hidden below 720 px.
  Keep its labels equal to the app's strings when the app changes them.
- A new file in `public/` is served without running the Worker; `test/site.test.ts` lists the expected files (update
  it on purpose). Only SVG images, and the whole of `public/` stays under 150 KB.
- A new redirect goes into `src/routes.ts`, and its path into `run_worker_first` in `wrangler.jsonc` (the test fails
  otherwise), and into the table above.
- Links to the repository use `https://github.com/gclinian/smurg/blob/main/<path>` (or `tree/main/<dir>`); the test
  checks that `<path>` exists in this repository.

## Checks

```sh
source scripts/env.sh
pnpm --filter @smurg/site test         # redirects, wrangler.jsonc, the site in a local workerd, HTML, links, size, dry run
pnpm --filter @smurg/site typecheck
pnpm --filter @smurg/site dev          # http://127.0.0.1:8790 (SMURG_SITE_DEV_PORT to change); local only
pnpm --filter @smurg/site build        # wrangler deploy --dry-run --outdir dist (nothing is deployed)
```

`pnpm check` at the repository root runs the same type check and tests.

## Deploying (maintainers)

**Deployed**: on 2026-10-01, before the first release and while the repository is still private, at the owner's
request, from `cb99aa0` with the apex-only routes now in `wrangler.jsonc`. Until the first release is published
(marked Latest) **and** the repository is public (`docs/RELEASING.md` §6 step 3, §4.1), `/install.sh` ends in a 404
(release downloads of a private repository need a GitHub login), and so do `/github`, `/docs` and the page's links
into the repository. Nothing has to be redeployed for them to start working: they redirect to GitHub. Redeploy only
when the site itself changed. It has: the pages' "What does the relay see?" wording changed after `cb99aa0`, so the
release commit's `public/` is newer than the deployed one (`git diff cb99aa0 -- apps/site/public` shows what); the
owner redeploys the site from the commit to be tagged, right after the relay (`docs/RELEASING.md` §4 step 3). After
the release and the visibility change, re-check `/install.sh` (see below).

On the Cloudflare account that holds the `smurg.ai` zone (the same account as the shared relay), from the repository
root. wrangler keeps its login in the repo's `.xdg/` (`scripts/env.sh`), the same login the relay deploy uses
(`docs/RELEASING.md` §1.2).

```sh
source scripts/env.sh
CI=false pnpm --filter @smurg/site exec wrangler login      # once, only if `wrangler whoami` shows no login
pnpm --filter @smurg/site exec wrangler whoami              # the account; with several, prefix CLOUDFLARE_ACCOUNT_ID=<id>
pnpm --filter @smurg/site run build                         # dry run into apps/site/dist; nothing is deployed
WRANGLER_SEND_METRICS=false pnpm --filter @smurg/site exec wrangler deploy
```

The one custom domain in `wrangler.jsonc` makes Cloudflare create the DNS record and certificate for `smurg.ai`
(it has them since 2026-10-01). Never add `www.smurg.ai` as a custom domain: wrangler run after
`source scripts/env.sh` (`CI=true`) replaces an existing record, or another Worker's custom domain, without asking,
and `www.smurg.ai` is the owner's own proxied DNS record that the Redirect Rule below needs.

Zone settings for `smurg.ai`, in the Cloudflare dashboard (owner):

- **Rules → Redirect Rules**: when the hostname equals `www.smurg.ai`, a dynamic redirect to
  `concat("https://smurg.ai", http.request.uri.path)`, status 301, query string preserved (the dashboard's "Redirect
  from WWW to root" template does the same), plus a proxied DNS record for `www.smurg.ai` so the rule sees the
  requests. **Done 2026-10-01** (both exist; checked live: `www.smurg.ai/`, `/zh-TW/`, `/install.sh` → 301 to the
  same path on `smurg.ai`).
- **SSL/TLS → Edge Certificates → Always Use HTTPS**: **on** (off in the morning of 2026-10-01, turned on by the
  owner the same day; it covers `smurg.ai`, `www.smurg.ai` and `app.smurg.ai`, `docs/RELEASING.md` §2). Checked live
  on 2026-10-01: `http://smurg.ai/` → 301 `https://smurg.ai/`, `http://www.smurg.ai/zh-TW/x?q=1` → 301
  `https://smurg.ai/zh-TW/x?q=1`, `http://app.smurg.ai/healthz` → 301 `https://app.smurg.ai/healthz`. The HSTS
  header in `public/_headers` comes with the static pages only (not with the Worker's redirects, which do not need
  it) and only works once a browser has reached the site over https; this switch covers the first visit.

Check after every deploy (all but the last checked live on 2026-10-01):

```sh
curl -sI https://smurg.ai/                     # 200, the headers of public/_headers
curl -sI https://smurg.ai/zh-TW                # 307 to /zh-TW/
curl -sI https://smurg.ai/install.sh           # 302 to the latest release's install.sh
curl -sI https://www.smurg.ai/zh-TW/           # 301 to https://smurg.ai/zh-TW/ (the zone Redirect Rule)
curl -sI https://smurg.ai/no-such-page         # 404, the 404 page
curl -sI http://smurg.ai/                      # 301 to https://smurg.ai/ (Always Use HTTPS)
curl -fsSIL https://smurg.ai/install.sh        # the last status line is 200: only after the release + public repo
```

The install line works only once a GitHub release (the latest) has `install.sh` and `SHA256SUMS` assets and the
repository is public; until then the last command ends in 404, and `/github`, `/docs` and `/docs/<file>` lead to a
GitHub 404 for visitors. After the release and the visibility change, re-check that `curl -fsSIL
https://smurg.ai/install.sh` ends in 200 (the site itself is redeployed with the release, see above).

The page's "Web app" link points at https://app.smurg.ai, and its invite-link example
(`https://app.smurg.ai/join/<id>#…`) assumes that the released CLI's default relay is https://app.smurg.ai
(`packages/cli/src/relay/default-relay.ts`) and that `README.md` and `docs/` say the same.
