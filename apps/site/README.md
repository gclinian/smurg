# @smurg/site: smurg.ai

The product page at https://smurg.ai (English) and https://smurg.ai/zh-TW/ (Traditional Chinese), and the user docs
at https://smurg.ai/docs/ (Traditional Chinese). A Cloudflare Worker with static assets serves them; the Worker script
(`src/`) only answers the install redirect. The workspace app (relay and web app) is a different Worker, on
https://app.smurg.ai.

The source repository is private: nothing on the site links to it. The landing pages are hand-written HTML and CSS in
`public/`; the docs pages are generated from the repository's Markdown at build time (`scripts/`), into `dist/`
(gitignored), which is what wrangler serves and uploads.

| Path | Answer |
|---|---|
| `/`, `/zh-TW/` | the landing pages (`public/index.html`, `public/zh-TW/index.html`); `/zh-TW` and `/index.html` redirect there |
| `/docs/` | the docs index (zh-TW, with an English note), generated |
| `/docs/hosting/` | `docs/HOSTING.md`, rendered |
| `/docs/joining/` | `docs/JOINING.md`, rendered |
| `/docs/changelog/` | `CHANGELOG.md`, rendered |
| `/license/` | `LICENSE`, as text in a page |
| `/third-party-notices.txt` | the executable's complete third-party notices (see "The build") |
| `/install.sh` | 302 to `https://downloads.smurg.ai/latest/install.sh` (the Worker) |
| `www.smurg.ai/<path>` | 301 to `https://smurg.ai/<path>`, query kept: the zone's Redirect Rule, before any Worker (not a route of this Worker) |
| anything else | the 404 page of the path's language (`404.html`; `zh-TW/404.html` under `/zh-TW/` and, as `docs/404.html`, under `/docs/`), status 404; `/github` and the old `/docs/<file>` redirects to GitHub are gone |

`curl -fsSL https://smurg.ai/install.sh | sh` therefore runs the newest release's `install.sh` from R2
(`https://downloads.smurg.ai/latest/install.sh`, whose base URL is pinned to that release's
`https://downloads.smurg.ai/v<X.Y.Z>/`); it downloads the executable from there and checks it against that release's
`SHA256SUMS` (`docs/RELEASING.md`). This Worker never serves or proxies the script.

The `public/_headers` file (copied into `dist/`) sets the security headers for every file: a strict CSP (only this
site's own files, no inline code, Trusted Types), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a
deny-by-default `Permissions-Policy`, HSTS. A page loads `/style.css`, `/copy.js` (the copy button of the landing pages;
the page works without it) and `/favicon.svg`, nothing else: no third-party requests, no analytics, no web fonts.

## The build

`scripts/build.ts` (with `scripts/site.ts` and `scripts/markdown.ts`) makes `dist/` = `public/` plus:

- `docs/hosting/`, `docs/joining/`, `docs/changelog/`: the three Markdown files rendered with marked (GFM), in the
  landing pages' look (`style.css`, the same header and footer), each with the docs navigation and, on wide screens,
  its own table of contents. Headings get GitHub's ids, so the docs' own `#…` links keep working.
- `docs/index.html`, `license/index.html` (LICENSE verbatim), `docs/404.html` (the zh-TW 404 page) and
  `third-party-notices.txt`.

What it does to the Markdown, and refuses:

- Raw HTML is shown as text, never passed through; images are refused. A soft line break between two Chinese
  characters is dropped (a browser would show a space in the middle of a sentence).
- Links between the published files go to their new URLs (`HOSTING.md#x` → `/docs/hosting/#x`, `LICENSE` →
  `/license/`, `packages/cli/THIRD-PARTY-NOTICES.txt` → `/third-party-notices.txt`). Links to anything else in the
  repository (ARCHITECTURE, RELEASING, SPEC, READMEs, source paths) and every link that is not https become their plain
  text. The build prints each rewritten and each removed link.
- It fails, listing every problem, when: a page or a Markdown file mentions `github.com` (the notices may: they name
  third-party projects' sources; no file may mention the private repository); a link of any page, landing pages
  included, points at a file or a `#heading` that does not exist; a doc has no single `#` heading first or skips a
  heading level; a file of `public/` would be overwritten; `LICENSE` still says `<COPYRIGHT HOLDER>`; no notices file
  is named (`SMURG_SITE_THIRD_PARTY_NOTICES`), or the notices are missing, empty, not UTF-8, still the committed
  placeholder, or without a filled-in Node.js section (`node@X.Y.Z (the Node.js runtime)` and the Node.js LICENSE).

The notices: a deploy publishes the file `SMURG_SITE_THIRD_PARTY_NOTICES` names, at a release the release's own
(`https://downloads.smurg.ai/v<X.Y.Z>/THIRD-PARTY-NOTICES.txt`, byte for byte what `scripts/build-sea.ts` wrote next to
the executables), and refuses to build without one: the executables embed the LICENSE of the Node.js the release
workflow used, which is not the Node.js running the build. Only previews and tests (`SMURG_SITE_ALLOW_PLACEHOLDER=1`)
may leave it out; the build then runs `node scripts/third-party-notices.ts --executable` (the committed
`packages/cli/THIRD-PARTY-NOTICES.txt` with the LICENSE of the running Node.js filled in).

Environment of the build: `SMURG_SITE_THIRD_PARTY_NOTICES=<file>` (above; required for a deploy);
`SMURG_SITE_ALLOW_PLACEHOLDER=1` builds although `LICENSE` still says `<COPYRIGHT HOLDER>`, no notices file is named or
the notices are the unfilled committed file (`pnpm dev` and the tests set it; never deploy with it, except the interim
deploy the owner may decide on, below); `SMURG_SITE_SOURCE_ROOT=<dir>` reads the Markdown and `LICENSE` from another
directory (tests and previews only).

`wrangler.jsonc` runs the build as its custom build (`build.command`) before `wrangler deploy`, `wrangler deploy
--dry-run`, `wrangler dev` and the tests' local workerd, so what is deployed is always built from the checkout at hand.
wrangler starts the command from its own working directory, so the command finds the script through `SMURG_ROOT` (set
by `source scripts/env.sh`; without it the shell stops with "run source scripts/env.sh first"), and the build refuses to
run for a wrangler started outside this checkout. The build is deterministic and writes only the files that changed
(each through a temporary file in `.wrangler/tmp/` and a rename), so builds running at the same time never see half a
file.

## The Worker-request quota

Workers Free counts 100,000 Worker requests a day for the whole Cloudflare account, and the shared relay is on the
same account (`docs/RELEASING.md` §8). Requests for static files that do not run the Worker are free. So
`wrangler.jsonc` lists only `/install.sh` in `assets.run_worker_first` (`src/routes.ts` `WORKER_PATHS`;
`test/config.test.ts` keeps the two equal): a page view, a docs page, the notices and a 404 run no Worker at all (the
static assets serve `404.html` themselves).

The www → apex redirect therefore cannot be this Worker's job (it would not run for a page view), and it is not: it
is a **Cloudflare Redirect Rule** on the zone, which runs before any Worker and costs no Worker request (see
"Deploying"). `www.smurg.ai` is **not** a route of this Worker; `wrangler.jsonc` lists the apex only, and
`test/config.test.ts` asserts exactly that. The Worker still 301s a `www.smurg.ai` request that reaches it (defence in
depth, tested), and the pages name `https://smurg.ai/` (or their own URL) as their canonical URL.

## Editing

- Landing pages: both languages have the same sections and ids in the same order (`test/site.test.ts` checks). Change
  the English page first, then the Traditional Chinese one, with the terms the app and the docs use (主人, 組員,
  邀請連結, 「旁觀」「可編輯」「可使用 agent」, worktree, agent, session, 網頁版). There is no sandbox any more
  (ARCHITECTURE §11 D-15): say so plainly (「沒有沙盒」) where it matters, never describe one.
- Only state what `README.md`, `CHANGELOG.md`, `SPEC.md` and `docs/` back. When in doubt, cut the sentence. Never call
  smurg open source or name its former license: the source is private, LICENSE is proprietary.
- The docs pages: edit `docs/HOSTING.md`, `docs/JOINING.md` or `CHANGELOG.md` themselves; the page chrome (header,
  docs navigation, footer, the docs index, the license page) is in `scripts/site.ts`. The landing pages' footers are
  written by hand and must stay equal to the generated pages' (`CHROME` in `scripts/site.ts`; a test compares them).
- No inline `<script>`, `<style>`, `style="…"` or `on…=` handlers: the CSP blocks them. Colours and type live in
  `public/style.css` (the page's tokens follow `apps/web/src/ui/tokens.css`; the workspace picture in the hero has
  its own, the app's).
- The workspace picture under the install line (`.mock`) is drawn after `apps/web/src/app/workspace/Workbench.tsx`
  with the app's own Traditional Chinese labels (`lang="zh-TW"` on it in both pages). It is hidden below 720 px.
  Keep its labels equal to the app's strings when the app changes them.
- A new file in `public/` is served without running the Worker; `test/site.test.ts` lists the expected files (update
  it on purpose). Only SVG images; `public/` stays under 160 KB, and every page with what it loads under 150 KB.
- A new redirect goes into `src/routes.ts`, and its path into `run_worker_first` in `wrangler.jsonc` (the test fails
  otherwise), and into the table above.

## Checks

```sh
source scripts/env.sh
pnpm --filter @smurg/site test         # renderer, build, redirects, wrangler.jsonc, every page, links in from the CLI/web/docs, local workerd, dry run
pnpm --filter @smurg/site typecheck
pnpm --filter @smurg/site run build    # dist/ only (the docs pages, the license page, the notices); nothing is deployed
pnpm --filter @smurg/site run dry-run  # the build, then wrangler deploy --dry-run into .wrangler/dry-run; nothing is deployed
pnpm --filter @smurg/site dev          # http://127.0.0.1:8790 (SMURG_SITE_DEV_PORT to change); local only
```

The tests publish a fixture as the notices (`test/fixtures/third-party-notices.txt`) and set
`SMURG_SITE_ALLOW_PLACEHOLDER=1` (`vitest.config.ts`); one test builds with the default notices. `pnpm check` at the
repository root runs the same type check and tests.

## Deploying (maintainers)

On the Cloudflare account that holds the `smurg.ai` zone (the same account as the shared relay), from the repository
root. wrangler keeps its login in the repo's `.xdg/` (`scripts/env.sh`), the same login the relay deploy uses
(`docs/RELEASING.md` §1.2). `wrangler deploy` runs the build first (above), and the build refuses a deploy while
`LICENSE` still says `<COPYRIGHT HOLDER>` (the owner names the holder) or while `SMURG_SITE_THIRD_PARTY_NOTICES` does not
name the notices to publish: **a deploy always names them**, because the executables embed the LICENSE of the Node.js
the release workflow used, not of the Node.js on the deploying machine (on the lead's Mac 22.22.1, in the release
dry run 22.23.x). At a release that is the release's own `THIRD-PARTY-NOTICES.txt`:

```sh
source scripts/env.sh
CI=false pnpm --filter @smurg/site exec wrangler login      # once, only if `wrangler whoami` shows no login
pnpm --filter @smurg/site exec wrangler whoami              # the account; with several, prefix CLOUDFLARE_ACCOUNT_ID=<id>
curl -fsSLo /tmp/smurg-notices.txt https://downloads.smurg.ai/v<X.Y.Z>/THIRD-PARTY-NOTICES.txt
#   before it is published (a shell WITHOUT scripts/env.sh, whose XDG_CONFIG_HOME hides gh's login):
#   gh release download v<X.Y.Z> --repo gclinian/smurg --pattern THIRD-PARTY-NOTICES.txt --dir /tmp/smurg-v<X.Y.Z>
export SMURG_SITE_THIRD_PARTY_NOTICES=/tmp/smurg-notices.txt
pnpm --filter @smurg/site run dry-run                       # the build + a dry run; read the links it reports
WRANGLER_SEND_METRICS=false pnpm --filter @smurg/site exec wrangler deploy
```

When: the site's pages are part of the release (the docs and the changelog are rendered from the commit), so the
owner redeploys the site from the tagged commit, after the relay and after the release's files are on
downloads.smurg.ai (`docs/RELEASING.md` §4 step 8, §4.1 "At every release"). Until
`https://downloads.smurg.ai/latest/install.sh` exists, `/install.sh` redirects to a missing file; nothing has to be
redeployed when it appears.

**Now, before the first release (urgent).** The deployed site (2026-10-01, from `cb99aa0`) is the earlier one: it
says smurg is "open source under the Apache License 2.0", links the private GitHub repository, and redirects
`/install.sh`, `/github` and `/docs` there. Deploy this version as soon as the owner has named the copyright holder,
right after the relay redeploy (the pages link `https://app.smurg.ai/third-party-notices.txt`), with this machine's
notices, since no release's file exists yet (`docs/RELEASING.md` §4.1 "Now", §10 item 10):

```sh
node scripts/third-party-notices.ts --executable --out /tmp/smurg-notices.txt   # replaced by the release's at v0.1.0
export SMURG_SITE_THIRD_PARTY_NOTICES=/tmp/smurg-notices.txt
pnpm --filter @smurg/site run dry-run && WRANGLER_SEND_METRICS=false pnpm --filter @smurg/site exec wrangler deploy
curl -s https://smurg.ai/ https://smurg.ai/zh-TW/ | grep -Eci 'open source|apache|開源|開放原始碼'   # 0
```

Only if the owner decides so explicitly, an interim deploy before the holder is named adds
`SMURG_SITE_ALLOW_PLACEHOLDER=1` (the license page then shows `<COPYRIGHT HOLDER>`); never otherwise.

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
- **SSL/TLS → Edge Certificates → Always Use HTTPS**: **on** (turned on by the owner on 2026-10-01; it covers
  `smurg.ai`, `www.smurg.ai` and `app.smurg.ai`, `docs/RELEASING.md` §2). The HSTS header in `public/_headers` comes
  with the static files only (not with the Worker's redirect, which does not need it) and only works once a browser
  has reached the site over https; this switch covers the first visit.

Check after every deploy:

```sh
curl -sI https://smurg.ai/                          # 200, the headers of public/_headers
curl -sI https://smurg.ai/zh-TW                     # 307 to /zh-TW/
curl -sI https://smurg.ai/docs/hosting/             # 200
curl -sI https://smurg.ai/license/                  # 200
curl -sI https://smurg.ai/third-party-notices.txt   # 200, text/plain; charset=utf-8 (at a release: cmp with the release's file)
curl -sI https://smurg.ai/install.sh                # 302 to https://downloads.smurg.ai/latest/install.sh
curl -sI https://smurg.ai/github                    # 404 (no GitHub link any more)
curl -sI https://www.smurg.ai/zh-TW/                # 301 to https://smurg.ai/zh-TW/ (the zone Redirect Rule)
curl -sI https://smurg.ai/no-such-page              # 404, the 404 page
curl -sI http://smurg.ai/                           # 301 to https://smurg.ai/ (Always Use HTTPS)
curl -fsSIL https://smurg.ai/install.sh             # the last status line is 200 once a release is published to R2
```

The page's "Web app" link points at https://app.smurg.ai, and its invite-link example
(`https://app.smurg.ai/join/<id>#…`) assumes that the released CLI's default relay is https://app.smurg.ai
(`packages/cli/src/relay/default-relay.ts`) and that `README.md` and `docs/` say the same.
