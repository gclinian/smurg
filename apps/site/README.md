# @smurg/site: smurg.ai

The product page at https://smurg.ai (English) and https://smurg.ai/zh-TW/ (Traditional Chinese), and the user docs
at https://smurg.ai/docs/ (English) and https://smurg.ai/zh-TW/docs/ (Traditional Chinese). A Cloudflare Worker with
static assets serves them; the Worker script (`src/`) only answers the redirects. The workspace app (relay and web
app) is a different Worker, on https://app.smurg.ai.

smurg is open source (MIT): the pages link the repository, https://github.com/gclinian/smurg. The landing pages are
hand-written HTML and CSS in `public/`; the docs pages are generated from the repository's Markdown at build time
(`scripts/`), into `dist/` (gitignored), which is what wrangler serves and uploads.

| Path | Answer |
|---|---|
| `/`, `/zh-TW/` | the landing pages (`public/index.html`, `public/zh-TW/index.html`); `/zh-TW` and `/index.html` redirect there |
| `/docs/`, `/zh-TW/docs/` | the docs index of each language, generated |
| `/docs/hosting/`, `/zh-TW/docs/hosting/` | `docs/HOSTING.md`, `docs/zh-TW/HOSTING.md`, rendered |
| `/docs/joining/`, `/zh-TW/docs/joining/` | `docs/JOINING.md`, `docs/zh-TW/JOINING.md`, rendered |
| `/docs/changelog/`, `/zh-TW/docs/changelog/` | `CHANGELOG.md`, `docs/zh-TW/CHANGELOG.md`, rendered |
| `/license/`, `/zh-TW/license/` | `LICENSE` (MIT), as text in a page; the Chinese page introduces the English text |
| `/third-party-notices.txt` | the executable's complete third-party notices (see "The build") |
| `/sitemap.xml` | generated: every page above in both languages, each with its alternates |
| `/install.sh` | 302 to `https://downloads.smurg.ai/latest/install.sh` (the Worker) |
| `/github`, `/source` | 302 to `https://github.com/gclinian/smurg` (the Worker): short addresses for the installer's and the CLI's output; the pages link GitHub directly |
| `www.smurg.ai/<path>` | 301 to `https://smurg.ai/<path>`, query kept: the zone's Redirect Rule, before any Worker (not a route of this Worker) |
| anything else | the nearest 404 page (`zh-TW/404.html` under `/zh-TW/`, `404.html` everywhere else, `/docs/` included), status 404 |

`curl -fsSL https://smurg.ai/install.sh | sh` therefore runs the newest release's `install.sh` from R2
(`https://downloads.smurg.ai/latest/install.sh`, whose base URL is pinned to that release's
`https://downloads.smurg.ai/v<X.Y.Z>/`); it downloads the executable from there and checks it against that release's
`SHA256SUMS` (`docs/RELEASING.md`). This Worker never serves or proxies the script.

The `public/_headers` file (copied into `dist/`) sets the security headers for every file: a strict CSP (only this
site's own files, no inline code, Trusted Types), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a
deny-by-default `Permissions-Policy`, HSTS. A page loads `/style.css`, `/copy.js` (the copy button of the landing pages;
the page works without it) and `/favicon.svg`, nothing else: no third-party requests, no analytics, no web fonts.

## Languages

Every page exists in English and in Traditional Chinese, at the same path with and without the `/zh-TW` prefix. The
language is the URL's: nothing redirects by itself (a redirect would run the Worker on every page view, and the CSP
forbids inline script), and every page has a visible language link.

- `<html lang>` is `en` or `zh-Hant-TW`. Every page carries `<link rel="alternate" hreflang="en|zh-Hant-TW|x-default">`
  (x-default is the English page), and `sitemap.xml` lists both pages with the same alternates.
- The language link in the header and the footer goes to **the same page** in the other language; its text is that
  language's own name (`English`, `繁體中文`). A 404 page links the other language's home page.
- A page links only pages of its own language. A guide's link to another guide stays in its language because each
  language's guides link their own files (`docs/zh-TW/HOSTING.md` links `JOINING.md` next to it).
- Heading ids are GitHub's slugs of each language's headings, so the anchors differ by language:
  `/docs/hosting/#4-before-you-share` and, under `/zh-TW/docs/hosting/`, `#4-` followed by the Chinese heading. Code that prints a docs address has one
  per language in its catalog; `test/inbound.test.ts` checks each against the built site.
- The words the build itself writes (navigation, the docs index, the license pages, table labels) are the `CHROME`
  table in `scripts/site.ts`, one entry per language with the same keys.

## The build

`scripts/build.ts` (with `scripts/site.ts` and `scripts/markdown.ts`) makes `dist/` = `public/` plus, for each
language:

- `docs/hosting/`, `docs/joining/`, `docs/changelog/`: the Markdown files rendered with marked (GFM), in the landing
  pages' look (`style.css`, the same header and footer), each with the docs navigation and, on wide screens, its own
  table of contents. Headings get GitHub's ids, so the docs' own `#…` links keep working.
- `docs/index.html` and `license/index.html` (LICENSE verbatim);

and once: `third-party-notices.txt` and `sitemap.xml`.

What it does to the Markdown, and refuses:

- Raw HTML is shown as text, never passed through; images are refused. A soft line break between two Chinese
  characters is dropped (a browser would show a space in the middle of a sentence).
- Links between the published files go to their URLs (`HOSTING.md#x` → `/docs/hosting/#x` or
  `/zh-TW/docs/hosting/#x`, `LICENSE` → the license page of the linking file's language,
  `packages/cli/THIRD-PARTY-NOTICES.txt` → `/third-party-notices.txt`). A link to any other file of the repository
  (ARCHITECTURE, the relay's README, SPEC, source paths) goes to that file on GitHub
  (`https://github.com/gclinian/smurg/blob/main/<path>`; `tree/main` for a directory). A link that is not https
  becomes its plain text. The build prints each rewritten and each removed link.
- It fails, listing every problem, when: a link of any page, landing pages included, points at a page or a `#heading`
  that does not exist; a guide links a repository file that does not exist; a doc has no single `#` heading first or
  skips a heading level; a file of `public/` would be overwritten; no notices file is named
  (`SMURG_SITE_THIRD_PARTY_NOTICES`), or the notices are missing, empty, not UTF-8, still the committed placeholder,
  or without a filled-in Node.js section (`node@X.Y.Z (the Node.js runtime)` and the Node.js LICENSE).

The notices: a deploy publishes the file `SMURG_SITE_THIRD_PARTY_NOTICES` names, at a release the release's own
(`https://downloads.smurg.ai/v<X.Y.Z>/THIRD-PARTY-NOTICES.txt`, byte for byte what `scripts/build-sea.ts` wrote next to
the executables), and refuses to build without one: the executables embed the LICENSE of the Node.js the release
workflow used, which is not the Node.js running the build. Only previews and tests (`SMURG_SITE_ALLOW_PLACEHOLDER=1`)
may leave it out; the build then runs `node scripts/third-party-notices.ts --executable` (the committed
`packages/cli/THIRD-PARTY-NOTICES.txt` with the LICENSE of the running Node.js filled in).

Environment of the build: `SMURG_SITE_THIRD_PARTY_NOTICES=<file>` (above; required for a deploy);
`SMURG_SITE_ALLOW_PLACEHOLDER=1` builds although no notices file is named or the notices are the unfilled committed
file (`pnpm dev` and the tests set it; never deploy with it); `SMURG_SITE_SOURCE_ROOT=<dir>` reads the Markdown and
`LICENSE` from another directory (tests and previews only).

`wrangler.jsonc` runs the build as its custom build (`build.command`) before `wrangler deploy`, `wrangler deploy
--dry-run`, `wrangler dev` and the tests' local workerd, so what is deployed is always built from the checkout at hand.
wrangler starts the command from its own working directory, so the command finds the script through `SMURG_ROOT` (set
by `source scripts/env.sh`; without it the shell stops with "run source scripts/env.sh first"), and the build refuses to
run for a wrangler started outside this checkout. The build is deterministic and writes only the files that changed
(each through a temporary file in `.wrangler/tmp/` and a rename), so builds running at the same time never see half a
file.

## The Worker-request quota

Workers Free counts 100,000 Worker requests a day for the whole Cloudflare account, and the shared relay is on the
same account (`docs/RELEASING.md`). Requests for static files that do not run the Worker are free. So
`wrangler.jsonc` lists only the redirects (`/install.sh`, `/github`, `/source`) in `assets.run_worker_first`
(`src/routes.ts` `WORKER_PATHS`; `test/config.test.ts` keeps the two equal): a page view, a docs page, the notices
and a 404 run no Worker at all (the static assets serve `404.html` themselves). The pages link GitHub directly, so
following a link to the repository costs no Worker request either.

The www → apex redirect therefore cannot be this Worker's job (it would not run for a page view), and it is not: it
is a **Cloudflare Redirect Rule** on the zone, which runs before any Worker and costs no Worker request (see
"Deploying"). `www.smurg.ai` is **not** a route of this Worker; `wrangler.jsonc` lists the apex only, and
`test/config.test.ts` asserts exactly that. The Worker still 301s a `www.smurg.ai` request that reaches it (defence in
depth, tested), and the pages name `https://smurg.ai/` (or their own URL) as their canonical URL.

## Editing

- Landing pages: both languages have the same sections, ids and links in the same order (`test/site.test.ts`
  checks). Change the English page first, then the Traditional Chinese one, with the terms of `docs/GLOSSARY.md`
  (Host / Agent access / Editor / Viewer, and their zh-TW names in the same table). There is no sandbox
  (ARCHITECTURE §11 D-15): say so plainly where it matters, never describe one.
- Only state what `README.md`, `CHANGELOG.md` and `docs/` back. When in doubt, cut the sentence. The pages show no
  version number: what changed in a version is the changelog's job.
- The docs pages: edit `docs/HOSTING.md`, `docs/JOINING.md` or `CHANGELOG.md` and their counterparts in
  `docs/zh-TW/` together: `test/docs-parity.test.ts` compares their headings and section numbers, code blocks,
  commands, tables and link targets. The page chrome (header, docs navigation, footer, the docs index, the license
  page) is `CHROME` in `scripts/site.ts`. The landing pages' footers are written by hand and must stay equal to the
  generated pages' (a test compares them).
- Text the guides and the landing pages quote from the app or the CLI (button labels, messages, the sample output of
  `smurg host`) must be the real strings of that language: the web catalogs (`apps/web/src/**/strings*.ts`), the CLI
  catalog (`packages/cli/src/i18n/`) and the shared catalog (`packages/protocol/src/i18n/`).
- No inline `<script>`, `<style>`, `style="…"` or `on…=` handlers: the CSP blocks them. Colours and type live in
  `public/style.css` (the page's tokens follow `apps/web/src/ui/tokens.css`; the workspace picture in the hero has
  its own, the app's). Rules for Chinese typography use `html:lang(zh-Hant)`.
- The workspace picture under the install line (`.mock`) is drawn after the web app's sessions view
  (`apps/web/src/app/workspace/SessionsView.tsx`: the inbox and the session list on the left, a discussion with a
  question card, the plan and a result report as columns), with the app's own labels in the page's language. Text that
  a person or an agent would have written (a topic's name, a question, a message, a report's sentences) is in an
  element with the class `m-said`, and a command in a `pre.m-term`; everything else in it is a label of a catalog, and
  the quote lint (`tests/lint/docs-quotes.test.ts`) holds it to that. It is hidden below 720 px and shows one, two or
  three columns as the window widens. Keep its labels equal to the app's strings when the app changes them.
- A new file in `public/` is served without running the Worker; `test/site.test.ts` lists the expected files (update
  it on purpose). Only SVG images; `public/` stays under 160 KB, and every page with what it loads under 164 KB
  (150 KB until 0.5.1: the host guide, the longest page, grew by its part on updating).
- A new redirect goes into `src/routes.ts`, and its path into `run_worker_first` in `wrangler.jsonc` (the test fails
  otherwise), and into the table above.

## Checks

```sh
source scripts/env.sh
pnpm --filter @smurg/site test         # renderer, build, redirects, wrangler.jsonc, every page, both languages' parity, links in from the CLI/web/docs, local workerd, dry run
pnpm --filter @smurg/site typecheck
pnpm --filter @smurg/site run build    # dist/ only (the docs pages, the license pages, the notices, the sitemap); nothing is deployed
pnpm --filter @smurg/site run dry-run  # the build, then wrangler deploy --dry-run into .wrangler/dry-run; nothing is deployed
pnpm --filter @smurg/site dev          # http://127.0.0.1:8790 (SMURG_SITE_DEV_PORT to change); local only
```

The tests publish a fixture as the notices (`test/fixtures/third-party-notices.txt`) and set
`SMURG_SITE_ALLOW_PLACEHOLDER=1` (`vitest.config.ts`); one test builds with the default notices. `pnpm check` at the
repository root runs the same type check and tests.

## Deploying (maintainers)

On the Cloudflare account that holds the `smurg.ai` zone (the same account as the shared relay), from the repository
root. wrangler keeps its login in the repo's `.xdg/` (`scripts/env.sh`), the same login the relay deploy uses
(`docs/RELEASING.md`). `wrangler deploy` runs the build first (above), and the build refuses a deploy while
`SMURG_SITE_THIRD_PARTY_NOTICES` does not name the notices to publish: **a deploy always names them**, because the
executables embed the LICENSE of the Node.js the release workflow used, not of the Node.js on the deploying machine.
At a release that is the release's own `THIRD-PARTY-NOTICES.txt`:

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

When: the site's pages are part of the release (the docs and the changelog are rendered from the commit), so a
maintainer redeploys the site from the tagged commit, after the relay and after the release's files are on
downloads.smurg.ai (`docs/RELEASING.md`). The site also links files of the repository on GitHub (`blob/main/…`): they
must be on the `main` branch of the public repository when the site is deployed.

The one custom domain in `wrangler.jsonc` makes Cloudflare create the DNS record and certificate for `smurg.ai`.
Never add `www.smurg.ai` as a custom domain: wrangler run after
`source scripts/env.sh` (`CI=true`) replaces an existing record, or another Worker's custom domain, without asking,
and `www.smurg.ai` is a proxied DNS record of its own that the Redirect Rule below needs.

Zone settings for `smurg.ai`, in the Cloudflare dashboard:

- **Rules → Redirect Rules**: when the hostname equals `www.smurg.ai`, a dynamic redirect to
  `concat("https://smurg.ai", http.request.uri.path)`, status 301, query string preserved (the dashboard's "Redirect
  from WWW to root" template does the same), plus a proxied DNS record for `www.smurg.ai` so the rule sees the
  requests.
- **SSL/TLS → Edge Certificates → Always Use HTTPS**: **on** (it covers `smurg.ai`, `www.smurg.ai` and
  `app.smurg.ai`). The HSTS header in `public/_headers` comes
  with the static files only (not with the Worker's redirect, which does not need it) and only works once a browser
  has reached the site over https; this switch covers the first visit.

Check after every deploy:

```sh
curl -sI https://smurg.ai/                          # 200, the headers of public/_headers
curl -sI https://smurg.ai/zh-TW                     # 307 to /zh-TW/
curl -sI https://smurg.ai/docs/hosting/             # 200 (English)
curl -sI https://smurg.ai/zh-TW/docs/hosting/       # 200 (Traditional Chinese)
curl -sI https://smurg.ai/license/                  # 200
curl -sI https://smurg.ai/third-party-notices.txt   # 200, text/plain; charset=utf-8 (at a release: cmp with the release's file)
curl -sI https://smurg.ai/install.sh                # 302 to https://downloads.smurg.ai/latest/install.sh
curl -sI https://smurg.ai/github                    # 302 to https://github.com/gclinian/smurg
curl -sI https://www.smurg.ai/zh-TW/                # 301 to https://smurg.ai/zh-TW/ (the zone Redirect Rule)
curl -sI https://smurg.ai/no-such-page              # 404, the 404 page
curl -sI http://smurg.ai/                           # 301 to https://smurg.ai/ (Always Use HTTPS)
curl -fsSIL https://smurg.ai/install.sh             # the last status line is 200 once a release is published to R2
```

The page's "Web app" link points at https://app.smurg.ai, and its invite-link example
(`https://app.smurg.ai/join/<id>#…`) assumes that the released CLI's default relay is https://app.smurg.ai
(`packages/cli/src/relay/default-relay.ts`) and that `README.md` and `docs/` say the same.
