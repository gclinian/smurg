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
| `www.smurg.ai/<path>` | 301 to `https://smurg.ai/<path>`, query kept |
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

The cost of that choice: on `www.smurg.ai`, every path except the redirect paths is answered by the static assets
before the Worker could redirect it, so the www → apex redirect is a **Cloudflare Redirect Rule** on the zone (it runs
before Workers and costs no Worker request; see "Deploying"). Until it exists, `www.smurg.ai` shows the same pages,
whose canonical link names `smurg.ai`.

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

The custom domains in `wrangler.jsonc` make Cloudflare create the DNS records and certificates for `smurg.ai` and
`www.smurg.ai` (existing DNS records for those names must be removed first). Then, once, in the dashboard of the
`smurg.ai` zone: **Rules → Redirect Rules → Create rule** (a single redirect): when the hostname equals
`www.smurg.ai`, a dynamic redirect to `concat("https://smurg.ai", http.request.uri.path)`, status 301, query string
preserved. The dashboard's "Redirect from WWW to root" template does the same.

Check afterwards:

```sh
curl -sI https://smurg.ai/                     # 200, the headers of public/_headers
curl -sI https://smurg.ai/install.sh           # 302 to the latest release's install.sh
curl -sI https://www.smurg.ai/                 # 301 to https://smurg.ai/
curl -sI https://smurg.ai/no-such-page         # 404
```

The install line works only once a GitHub release (the latest) has `install.sh` and `SHA256SUMS` assets. The page's
"Web app" link points at https://app.smurg.ai, and its invite-link example (`https://app.smurg.ai/join/<id>#…`) assumes
that the released CLI's default relay is https://app.smurg.ai (`packages/cli/src/relay/default-relay.ts`) and that
`README.md` and `docs/` say the same.
