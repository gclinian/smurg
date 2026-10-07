# Releasing smurg

The maintainers' runbook: one-time setup, deploying the shared relay, cutting a release (built by GitHub Actions,
published by a person to Cloudflare R2), deploying the product page, checking it and rolling back. Nothing in the
repository uploads, deploys or signs anything by itself: every step that touches a GitHub or Cloudflare account is run
by a person, and **no workflow holds a Cloudflare or Google credential**.

This describes the official deployment (`app.smurg.ai`, `smurg.ai`, `downloads.smurg.ai`). To run a relay of your own
you need none of it: see `apps/relay/README.md` ("Self-hosting on workers.dev", "Self-hosting on your own domain").

## 0. What is where

| What | Where |
|---|---|
| Source | <https://github.com/gclinian/smurg>, MIT (`LICENSE`). Every `package.json` says `"license": "MIT"` and `"private": true` (nothing is published to npm). |
| Third-party notices | `THIRD-PARTY-NOTICES.txt`, generated from the installed packages (`scripts/third-party-notices.ts`), embedded in each executable (`smurg licenses`), written by `scripts/build-sea.sh` next to the executable and published with every release; the web app serves its own (`/third-party-notices.txt` on app.smurg.ai), smurg.ai serves the executable's. **After any dependency change** run `node scripts/third-party-notices.ts` and commit both files: `pnpm check`, `scripts/build-sea.sh` and the web build refuse stale ones. |
| Downloads | Cloudflare R2 bucket `smurg-downloads` behind **`https://downloads.smurg.ai`**. `v<X.Y.Z>/` holds `smurg-darwin-arm64`, `smurg-darwin-x64`, `smurg-linux-x64`, `smurg-linux-arm64`, `SHA256SUMS`, `install.sh` (its download location pinned to `https://downloads.smurg.ai/v<X.Y.Z>`) and `THIRD-PARTY-NOTICES.txt`, `Cache-Control: public, max-age=31536000, immutable`, **never overwritten**. `latest/install.sh` (a copy of the newest version's `install.sh`) and `latest/VERSION` (`X.Y.Z`), `Cache-Control: public, max-age=300`. Old versions may be removed (§7); the proprietary builds 0.1.0 to 0.3.0 were. |
| Install line | `curl -fsSL https://smurg.ai/install.sh \| sh`. smurg.ai answers `/install.sh` with a **302 to `https://downloads.smurg.ai/latest/install.sh`**. One version: `curl -fsSL https://downloads.smurg.ai/v<X.Y.Z>/install.sh \| sh`. |
| GitHub release | Made by the release workflow for every tag: the notes (the changelog section, the install line, the checksums), `SHA256SUMS` and `THIRD-PARTY-NOTICES.txt`. **No executable and no installer**: the one download place is `downloads.smurg.ai`. |
| Who uploads | **A person** (a maintainer) with `scripts/publish-downloads.sh` and wrangler logged in to the Cloudflare account (§1.2). Not CI. |
| Builds | GitHub Actions on a tag `v*` (`.github/workflows/release.yml`), each target on its own runner: macOS Apple silicon (`macos-15`), macOS Intel (`macos-15-intel`), Linux x64 (`ubuntu-24.04`), Linux arm64 (`ubuntu-24.04-arm`). `macos-15-intel` is GitHub's last x86_64 image, until August 2027 (actions/runner-images #13045). |
| Shared relay | One Worker (`smurg-relay`) on Cloudflare Workers, serving the relay and the web app at the Custom Domain **`https://app.smurg.ai`**. Its workers.dev hostname is off. Invite links are `https://app.smurg.ai/join/<id>#…`. Login: Google only. |
| Product page and user docs | `https://smurg.ai` (`apps/site`, a second Worker; apex only, `www.smurg.ai` redirected by a zone Redirect Rule). It publishes the user docs at `/docs/` and `/zh-TW/docs/` (the guides and the changelog, rendered at build time), `/license/` and `/third-party-notices.txt`. |
| Signing | None from Apple: ad-hoc signature only. The installer verifies the sha256, then removes the quarantine attribute. `SHA256SUMS` is not signed (§9). |

The tools:

| Piece | Command | Tests |
|---|---|---|
| Single executable (Node SEA: CLI + daemon + native parts) for the platform it is built on | `scripts/build-sea.sh [--node <node>] --version X.Y.Z [--target <platform>-<arch>]` → `packages/cli/dist/smurg-<platform>-<arch>` and, next to it, `THIRD-PARTY-NOTICES.txt` (exactly the notices it embeds). It checks that the executable runs (`--version`), that it carries its build marker `smurg-build-version=X.Y.Z;` and the download URL of its Node.js release (`scripts/release-markers.ts`), prints its sha256 and runs the smoke tests. `--target` refuses a runner or a Node of another platform or architecture. | `packages/cli/test/sea.test.ts`, `packages/cli/test/sea-update.test.ts` (opt-in, run by the build) |
| Third-party notices | `node scripts/third-party-notices.ts` (`--check`, `--executable`) | `packages/cli/test/third-party-notices.test.ts`, `apps/web/test/third-party-notices.test.ts` |
| Release files | `scripts/release-assets.sh --version X.Y.Z [--dist DIR] [--out DIR] [--notices FILE] [--require-all] [--check-arch] [--notes FILE] [--changelog FILE] [--base-url URL]` → `<out>/{smurg-*, SHA256SUMS, install.sh, THIRD-PARTY-NOTICES.txt}`. It refuses an executable that is not the file type its name says, is not this version's build or is built on another Node.js than the notices' (§4.3), and incomplete notices. Check-only modes: `--check-changelog`, `--publish-checks` (§4 step 2). | `packages/cli/test/install-script.test.ts`, `packages/cli/test/release-checks.test.ts` |
| Publishing | `scripts/publish-downloads.sh --version X.Y.Z (--from-release \| --dist DIR) [--dry-run] [--resume] [--no-latest]`, `--check [--version X.Y.Z]`, `--set-latest X.Y.Z` (§4 step 7, §7). Every rule: `scripts/publish-downloads.ts`. | `packages/cli/test/publish-downloads.test.ts` (stand-ins for wrangler, the domain and gh; §4.4) |
| Installer | `scripts/install.sh`: picks darwin/linux × arm64/x64 (glibc), downloads `SHA256SUMS` and then the executable from its baked download location, installs `~/.local/bin/smurg` only when the sha256 matches (https only); on macOS it removes `com.apple.quarantine` after the sha256 matched. No sudo, no system package. | `packages/cli/test/install-script.test.ts` |
| Release workflow | `.github/workflows/release.yml` (§4 step 5). Only the release job has `permissions: contents: write`; actions are pinned to commit SHAs. A manual run is a dry run that releases nothing. | |
| CI | `.github/workflows/ci.yml`: `pnpm check` on `macos-15` and `ubuntu-24.04` for pushes to `main`, pull requests and manual runs. Pull requests from forks get a read-only token and no secret. The runners have no `claude`: every agent in CI is the scripted stand-in (`packages/daemon/src/testing/fake-claude.mjs`). | |
| Release gate | `SMURG_RELEASE_GATE=1 pnpm check` (§4 step 1): the same gate, which then also fails while anything is still on a pending list of the release being built. | `tests/lint/pending.test.ts`, `tests/lint/acceptance-refs.test.ts`, `packages/daemon/test/composition.test.ts`, `packages/daemon/test/wire-texts.test.ts` |
| Real Claude Code | The suite and the dry run of §4.5: the host's own kind of `claude`, version 2.1.288, against the repository's fake Anthropic API with a dummy key and its own temporary `HOME` and config directory. Never a real account. | `packages/daemon/test/hooks/claude-harness.ts` (how it is isolated), `docs/ACCEPTANCE.md` "How to run the gate" |
| Relay deploy | `scripts/deploy-relay.sh` (§2): production build of web + relay, then `wrangler deploy` of the top level of `apps/relay/wrangler.jsonc`; `--dry-run`, `--check <url>`. | `apps/relay/test/deploy-relay.test.ts` |
| CLI default relay | `DEFAULT_RELAY_URL` in `packages/cli/src/relay/default-relay.ts` (§3) | `packages/cli/test/default-relay.test.ts`, `apps/relay/test/config.test.ts` |
| Release notes | `CHANGELOG.md` and `docs/zh-TW/CHANGELOG.md`: one `## [X.Y.Z] - YYYY-MM-DD` section per version, the same heading in both. Published on smurg.ai; the English section becomes the GitHub release's notes. | `apps/site/test/docs-parity.test.ts` |

---

## 1. One-time setup

### 1.1 GitHub repository

- Actions: default workflow permissions read-only (the release job declares `contents: write` itself); **require
  approval for workflow runs of first-time contributors**; no repository secret is needed, and none must ever be
  added for Cloudflare or Google.
- Branch protection on `main`; private vulnerability reporting on (`SECURITY.md`); two-factor authentication on every
  account with write access: whoever can push a tag decides what the release workflow builds.

`gh` and `scripts/env.sh`: env.sh sets `XDG_CONFIG_HOME` to a directory inside the checkout (for wrangler), and gh
looks for its login in `$XDG_CONFIG_HOME/gh`, so in a shell that sourced env.sh plain `gh` says it is not logged in.
Run gh in another shell, or with `GH_CONFIG_DIR=~/.config/gh gh …`. `scripts/publish-downloads.sh` does this by itself.

### 1.2 Cloudflare account and wrangler

1. A Cloudflare account with the zone of the domain (Cloudflare's nameservers, status Active). The shared relay is the
   Custom Domain `app.smurg.ai`, the product page `smurg.ai`, the downloads `downloads.smurg.ai` (§1.5).
2. wrangler's login is kept inside the checkout (`scripts/env.sh`; gitignored). The relay, the site and the downloads
   use the same login:

   ```sh
   cd <repo> && source scripts/env.sh
   CI=false pnpm --filter @smurg/relay exec wrangler login     # opens your browser; CI=true (env.sh) makes wrangler non-interactive
   pnpm --filter @smurg/relay exec wrangler whoami             # shows the account
   ```

   `wrangler logout` (same prefix) removes the login. Never copy it anywhere. Whoever publishes releases needs this
   login on their own checkout.

### 1.3 Google OAuth client

1. **OAuth consent screen**: user type External; scopes `openid`, `email`, `profile`; publishing status **In
   production** (in "Testing" only listed test users can log in); authorized domain: the relay's domain.
2. **OAuth client ID**, type Web application; authorized JavaScript origin `https://app.smurg.ai`; authorized redirect
   URI `https://app.smurg.ai/auth/google/callback`, exactly (`scripts/deploy-relay.sh` prints both). The CLI's login
   goes through the same callback (the device-code login's /device page uses the relay's own Google login), so no
   loopback URI is registered.
3. The **client ID** is public (it is in `apps/relay/wrangler.jsonc`); the **client secret** goes only into
   `wrangler secret put` (§1.4), never into the repository, CI, a chat or an issue.

### 1.4 Relay secrets

The relay needs two secrets, `RELAY_SIGNING_KEY` and `GOOGLE_CLIENT_SECRET`, set with `wrangler secret put`;
`scripts/deploy-relay.sh` prints the exact commands and stops while one is missing, and `apps/relay/README.md` explains
them (generating the signing key; rotating both: "Afterwards"). `RELAY_SIGNING_KEY` must exist before a
Worker's first deploy; it needs no backup: if it is lost, put a new one and everyone logs in again.

### 1.5 The downloads bucket and its domain

`scripts/publish-downloads.sh` stops with exit 3 and points here while the bucket does not exist.

1. Enable R2 for the account (dashboard → R2 Object Storage).
2. Create the bucket:

   ```sh
   cd <repo> && source scripts/env.sh
   pnpm --filter @smurg/relay exec wrangler r2 bucket create smurg-downloads
   pnpm --filter @smurg/relay exec wrangler r2 bucket list                          # name: smurg-downloads
   ```

3. Connect the custom domain (Cloudflare creates the DNS record and the certificate in the zone; the dashboard's
   R2 → smurg-downloads → Settings → Custom Domains → Connect Domain does the same):

   ```sh
   pnpm --filter @smurg/relay exec wrangler r2 bucket domain add smurg-downloads --domain downloads.smurg.ai --zone-id <zone id> --min-tls 1.2
   pnpm --filter @smurg/relay exec wrangler r2 bucket domain list smurg-downloads   # downloads.smurg.ai, enabled
   pnpm --filter @smurg/relay exec wrangler r2 bucket dev-url get smurg-downloads   # the r2.dev URL stays disabled: the custom domain only
   ```

4. **Zone settings** that matter for `downloads.smurg.ai` (zone-wide, §2): Always Use HTTPS on; **Bot Fight Mode off**
   and no challenge for this hostname (`curl` cannot pass one); Caching → Browser Cache TTL: Respect Existing Headers,
   so the objects' own Cache-Control is what clients see. If a Cache Rule is ever added, it must respect the origin's
   Cache-Control: `latest/` must not be held longer than its `max-age=300`.
5. Check: `curl -sI https://downloads.smurg.ai/latest/VERSION` answers 404 from R2 while the bucket is empty (a DNS or
   TLS error means the domain is not connected yet).

---

## 2. Deploying the relay

The shared relay is the Cloudflare Custom Domain **app.smurg.ai** of the Worker `smurg-relay`. The top level of
`apps/relay/wrangler.jsonc` says so, and it is exactly what runs in production:

```jsonc
"workers_dev": false,                                            // no workers.dev hostname
"routes": [{ "pattern": "app.smurg.ai", "custom_domain": true }],
"preview_urls": false,
"vars": { "RELAY_ISSUER": "https://app.smurg.ai", "ALLOWED_ORIGINS": "https://app.smurg.ai", … }
```

On deploy, wrangler attaches the custom domain to the Worker (DNS record and certificate in the zone). wrangler, as
the script runs it (`CI=true`), does not ask before it takes a hostname over, so before deploying the script checks
who answers at the hostname and stops unless nothing does yet or it is already a smurg relay; `--take-over-hostname`
deploys anyway. `env.dev` sets `"routes": []`.

**Zone settings** (dashboard, once; they apply to every hostname of the zone: the relay, the site and the downloads):

- **SSL/TLS → Edge Certificates → Always Use HTTPS: on.** The static pages of both Workers also send
  `Strict-Transport-Security: max-age=31536000` (`apps/site/public/_headers`, `apps/web/public/_headers`); `--check`
  requires `http://app.smurg.ai/healthz` to redirect to https.
- **Rules → Redirect Rules: `www.smurg.ai` → `https://smurg.ai/<path>`**, 301, query kept (§4.1).
- **Keep Bot Fight Mode off, Security Level below "I'm Under Attack", and add no WAF rule that challenges
  `app.smurg.ai` or `downloads.smurg.ai`.** The CLI, the daemon and `curl … | sh` are not browsers and cannot solve a
  challenge. `--check` fails with the reason when Cloudflare answers instead of the relay (a `cf-mitigated` header).

```sh
cd <repo> && source scripts/env.sh
scripts/deploy-relay.sh --dry-run                       # web build, config checks, wrangler deploy --dry-run; no account contact
scripts/deploy-relay.sh                                 # deploy (after §1.2 and RELAY_SIGNING_KEY from §1.4); ends with "Done: …"
scripts/deploy-relay.sh --check https://app.smurg.ai    # any time later: the outside checks only; "All checks passed."
```

Deploy from a clean checkout of the commit you mean (`git status` clean): the web app is built from the working tree,
and the live one must be the build of a known commit (§4 step 3). The script builds the web app and the relay, checks
the production configuration, checks who answers at `app.smurg.ai`, runs `wrangler deploy --env ""`, and refuses to
call it done unless wrangler's deploy output names exactly `app.smurg.ai (custom domain)` and no workers.dev hostname
and every outside check passes. It never logs in and never puts or reads a secret: it prints the command and stops
with exit 3 when a person has to act. Details: `apps/relay/README.md` ("The shared relay (app.smurg.ai,
maintainers)", "What scripts/deploy-relay.sh does").

What the production configuration must say:

| Name | Production value |
|---|---|
| `workers_dev`, `routes` | `false`; exactly `[{ "pattern": "app.smurg.ai", "custom_domain": true }]` |
| `RELAY_ISSUER`, `ALLOWED_ORIGINS` | `https://app.smurg.ai` (https, no path, no trailing slash) |
| `GOOGLE_CLIENT_ID` | the client ID from §1.3 |
| `GITHUB_CLIENT_ID` | empty |
| `DEV_LOGIN` | `"0"` (dev login is also refused on any non-local hostname in code) |
| `RELAY_TAP_URL` | empty |
| secrets | `RELAY_SIGNING_KEY`, `GOOGLE_CLIENT_SECRET` |

After every deploy, `scripts/deploy-relay.sh --check https://app.smurg.ai` (the JWKS has an Ed25519 key and no private
part, `/` and an SPA deep link carry the `_headers` CSP and HSTS, `/auth/google/login` redirects to Google with this
relay's callback and client ID and a `__Host-` cookie, the live web app is this checkout's `apps/web/dist` build,
`http://` redirects to `https://`; no response is a Cloudflare challenge), or by hand:

```sh
curl -fsS https://app.smurg.ai/healthz                  # ok
curl -fsS https://app.smurg.ai/api/login-options        # {"providers":{"github":false,"google":true},"dev":false}
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://app.smurg.ai/healthz          # 301 https://app.smurg.ai/healthz
```

Good to know: **every deploy disconnects every WebSocket** (clients reconnect within seconds; deploy outside working
hours); `wrangler.jsonc`'s `migrations` are only ever appended to; relay logs:
`pnpm --filter @smurg/relay exec wrangler tail` (never content).

## 3. The shared relay's address in the repository

The address appears in these places, and they must agree:

- `DEFAULT_RELAY_URL` in `packages/cli/src/relay/default-relay.ts`, on one line of exactly the shape
  `export const DEFAULT_RELAY_URL: string | null = 'https://<host>';` (`packages/cli/test/default-relay.test.ts`;
  `apps/relay/test/config.test.ts` checks that it equals `RELAY_ISSUER`);
- `apps/relay/wrangler.jsonc` (`routes`, `RELAY_ISSUER`, `ALLOWED_ORIGINS`, §2);
- the user docs, in both languages: `README.md`, `README.zh-TW.md`, `docs/HOSTING.md`, `docs/JOINING.md`,
  `docs/zh-TW/HOSTING.md`, `docs/zh-TW/JOINING.md`, and the changelogs;
- the product page, both languages (`apps/site/public`).

The release workflow refuses a tag while `DEFAULT_RELAY_URL` is not an https origin, while a user doc does not name
it, while a placeholder (`<RELAY_URL>`) is left, or while a user doc or the version's changelog section names a
concrete `*.workers.dev` address other than `DEFAULT_RELAY_URL` (§4). **A release keeps its default relay forever.**
Changing it is expensive (every released `smurg`, every stored login and invite link, the Google client).

## 4. Cutting a release

Needed: push access (the tag), wrangler logged in to the Cloudflare account (§1.2) and a gh login.

1. `main` is green in CI, `source scripts/env.sh && SMURG_RELEASE_GATE=1 pnpm check` is green locally,
   `shellcheck -S warning scripts/*.sh` and `actionlint .github/workflows/*.yml` are clean (neither tool comes with
   `scripts/bootstrap-tools.sh` and no workflow runs them: use your own install, or the Ubuntu VM's `shellcheck`;
   for 0.5.0 `shellcheck` was run there and `actionlint` was not run, and the workflows did not change). With
   `SMURG_RELEASE_GATE=1` the gate also refuses anything left on a pending list (`docs/ACCEPTANCE.md` "How to run the
   gate"): a release has none. Since 0.5.0 two more things are done before the tag, by a person on their own machine,
   because CI has no Claude Code: the real-Claude suite and the release dry run, both in §4.5.
2. The changelogs: the section `## [X.Y.Z] - YYYY-MM-DD` in `CHANGELOG.md` and, with the same heading, in
   `docs/zh-TW/CHANGELOG.md`, written for hosts and members. Set `"version": "X.Y.Z"` in all eight `package.json`
   files. Commit, then check what the workflow's first job will check:

   ```sh
   scripts/release-assets.sh --version X.Y.Z --publish-checks
   ```

   It refuses (and a tag push fails before any build) while: the section is missing or not dated in either changelog,
   or the two headings differ; `<RELAY_URL>` or `<account-subdomain>` is left in the section or in a user doc (§3);
   `DEFAULT_RELAY_URL` is not an https origin, or one of the six user docs is missing, does not name it or does not
   show `curl -fsSL https://smurg.ai/install.sh | sh`; one of them or the section names a concrete `*.workers.dev`
   address other than `DEFAULT_RELAY_URL`; `LICENSE` is not the MIT License naming its copyright holder; `LICENSE`,
   `NOTICE`, a user doc or `scripts/install.sh` still carries wording of the proprietary releases; a `package.json`
   says another version, or not `"license": "MIT"`, or not `"private": true`. Optional: Actions → Release → Run
   workflow (version X.Y.Z) is a dry run of the whole pipeline that releases nothing and keeps the notes,
   `SHA256SUMS`, `install.sh` and the notices as an artifact (there the `--publish-checks` step only warns).
3. Redeploy the shared relay from the commit you are about to tag (a clean checkout of it), §2:

   ```sh
   scripts/deploy-relay.sh                                 # ends with "Done: …": every outside check passed
   scripts/deploy-relay.sh --check https://app.smurg.ai    # later, from the same checkout: "All checks passed."
   ```

   Why: `app.smurg.ai` serves the one web app that every host's members and console use, whatever version the host
   runs. It decodes each daemon's `channel.welcome` and settings with strict schemas (ARCHITECTURE §5), so a web app
   older than the daemon refuses it, while a newer one accepts older daemons of the same protocol version (a daemon
   of another protocol version is refused at the handshake). The web app must therefore be at least as new as the
   release before anyone can install the release. If the workflow fails and you tag a fixed commit instead, redeploy
   from that one.

   **For 0.5.0 the order "redeploy first, then publish" decides whether the release works at all.** 0.5.0 speaks
   protocol 4, and nothing of protocol 3 is kept: there is no compatibility code on either side (ARCHITECTURE
   §4.3). Until `app.smurg.ai` serves the build of the release commit, a browser that opens the invite
   link of a 0.5.0 host is refused at the handshake (the page says "Incompatible versions"); from the moment it
   does, a host that still runs an older smurg is refused the same way until it updates. So: deploy from the release
   commit, wait for "Done: …", run `--check` (it compares the live web app with this checkout's build), and only
   then tag, build and publish (steps 4 to 7), without a pause in between. Never publish while `--check` still
   reports another web build. Say in the release notes that hosts update before they share again
   (`smurg update`).
4. Tag and push the tag:

   ```sh
   git tag -a vX.Y.Z -m "smurg X.Y.Z"
   git push origin vX.Y.Z
   ```

5. Watch the release workflow (`gh run list --limit 5`, then `gh run watch <run id>`, in a shell without
   `scripts/env.sh`, §1.1). Each build runs `scripts/build-sea.sh --version X.Y.Z --target <platform>-<arch>`
   (including the smoke test on that platform); the last job requires the four builds' notices to be identical, runs
   `scripts/release-assets.sh`, keeps the seven files as the artifact `release-X.Y.Z` (30 days), and creates the
   GitHub release with the notes, `SHA256SUMS` and `THIRD-PARTY-NOTICES.txt` (a draft, its asset list checked, then
   published). If that job fails after creating the draft, delete the draft on the Releases page and "Re-run failed
   jobs" (it refuses to continue while any release for the tag exists). If the notices differ (another Node.js
   release came out during the run), re-run all jobs. The job summary prints the commands of step 7.
6. `gh release view vX.Y.Z --repo gclinian/smurg`: the notes and two files. The executables are not on
   `downloads.smurg.ai` yet; do step 7 right away.
7. **Publish.** From a checkout with the wrangler login (§1.2):

   ```sh
   cd <repo> && source scripts/env.sh
   scripts/publish-downloads.sh --version X.Y.Z --from-release --dry-run   # checks the files and what is there; uploads nothing
   scripts/publish-downloads.sh --version X.Y.Z --from-release             # ends with "done: smurg X.Y.Z is on …"
   scripts/publish-downloads.sh --check --version X.Y.Z                    # as people get it; "all checks passed"
   ```

   What it does (every rule in `scripts/publish-downloads.ts`):
   1. takes the workflow's files with your gh login: the GitHub release must exist and not be a draft; the seven
      files are the artifact `release-X.Y.Z` of the workflow's successful run for the tag; their `SHA256SUMS` and
      notices must be byte-identical to the GitHub release's (or `--dist DIR`, a directory
      `scripts/release-assets.sh --out` wrote, §4.3);
   2. checks them before contacting Cloudflare: `SHA256SUMS` lists exactly the four executables and each sha256
      matches; `file` says each is the Mach-O / ELF of its name; each carries the build marker of X.Y.Z and the
      download URL of one Node.js release, the same for all four and the same as the notices' Node.js section
      (`scripts/release-markers.ts`); this machine's executable reports exactly `smurg X.Y.Z (… node A.B.C)`;
      `install.sh` downloads from `https://downloads.smurg.ai/vX.Y.Z` and nowhere else; the notices name what every
      executable bundles and are complete (not the committed file with its placeholder);
   3. `wrangler whoami` (several accounts: `CLOUDFLARE_ACCOUNT_ID=<id>`) and `wrangler r2 bucket list` (it must name
      `smurg-downloads`);
   4. **never overwrites**: every file of `vX.Y.Z/` is looked up through `https://downloads.smurg.ai` (and the small
      ones in the bucket itself with `wrangler r2 object get`); anything there stops the run;
   5. decides `latest/`: a pre-release (`X.Y.Z-rc.1`) never becomes latest, nor does a version with `--no-latest`; a
      version older than the current `latest/VERSION` stops the run (rolling back is §7);
   6. uploads `vX.Y.Z/`: the executables (`application/octet-stream`), then `THIRD-PARTY-NOTICES.txt`, `install.sh`
      and `SHA256SUMS` last (`text/plain; charset=utf-8`; the installer reads `SHA256SUMS` first, so a version cut
      short refuses to install instead of half-working);
   7. reads every file back through `https://downloads.smurg.ai` (past any edge cache) and compares its sha256; a
      wrong Content-Type or Cache-Control is a warning. **Any failure stops here, and `latest/` is not touched**;
   8. only then uploads `latest/install.sh` (the version's own `install.sh`) and `latest/VERSION`, reads them back,
      says whether the plain URLs already serve them (the edge may hold the previous ones for up to five minutes),
      and checks that `https://smurg.ai/install.sh` answers 302 to `https://downloads.smurg.ai/latest/install.sh` and
      that `https://smurg.ai/third-party-notices.txt` is this version's file (warnings until the site is redeployed
      with them, step 8).

   Exit codes: 0 done, 1 failed or refused, 2 usage, 3 you must act first (log in, choose an account, create the
   bucket, log gh in). **Once a version is published, never reuse its number**: people's installs and the published
   `SHA256SUMS` refer to it; cut X.Y.(Z+1).

   **When a run stops before `latest/`** (it always says why; `latest/` is then untouched):
   - **An upload failed, or the read-back got an HTTP error or timed out** (the files may not have reached the custom
     domain yet): run the same command again with `--resume` (and a longer `--wait`). It skips the files that are
     already there **and byte-identical**, uploads the missing ones, and refuses any that differ.
   - **`--resume` finds every file already there**: it uploads nothing, reads them back, and leaves `latest/` where it
     is when it names another version, because someone may have rolled `latest/` back on purpose since (§7); it says
     so. If the earlier run only stopped before switching `latest/`, finish with
     `scripts/publish-downloads.sh --set-latest X.Y.Z` (it verifies the version as published first). The first
     version ever (no `latest/` yet) is switched by the resumed run itself.
   - **The read-back got other bytes than were uploaded** (a sha256 mismatch): those objects are public under
     `vX.Y.Z/`, but the version never became `latest/`, and `--resume` refuses them (a published file is never
     overwritten automatically). Find out why first (download the file and compare it with the local one). Then
     either delete only the mismatching objects, which the error message lists
     (`pnpm --filter @smurg/relay exec wrangler r2 object delete smurg-downloads/vX.Y.Z/<file> --remote`), and run
     the same command again with `--resume`; or the number is used up: cut X.Y.(Z+1).
8. Redeploy the product page from the tagged commit **with the release's notices** (§4.1): its docs and changelog are
   the release's, and its `/third-party-notices.txt` must be the release's file byte for byte.
   `scripts/publish-downloads.sh --check` then reports no warning about smurg.ai.
9. Verify the install on clean machines (§5) before announcing.

If the workflow fails before the GitHub release is made, fix the cause, delete the tag
(`git push --delete origin vX.Y.Z && git tag -d vX.Y.Z`) and tag the fixed commit again. If the GitHub release exists
but nothing was uploaded to `downloads.smurg.ai` (step 7 never ran), delete the release and the tag, and do the same.
After step 7, never: cut X.Y.(Z+1).

### 4.1 Deploying the product page smurg.ai

`apps/site` (details and the full list of checks: `apps/site/README.md`) is the Worker `smurg-site` with the one custom
domain `smurg.ai`, on the same account and zone as the relay. Its build renders the guides and changelogs of both
languages to `/docs/` and `/zh-TW/docs/`, `LICENSE` to `/license/` and the executables' notices to
`/third-party-notices.txt`. A deploy build refuses to run unless `SMURG_SITE_THIRD_PARTY_NOTICES` names the notices
file to publish, with its Node.js section filled in: the executables embed the LICENSE of the Node.js the release
workflow used, not of the Node.js on the deploying machine, so a default would publish other notices than
`https://downloads.smurg.ai/vX.Y.Z/THIRD-PARTY-NOTICES.txt`. Its Worker answers only a few redirects: `/install.sh`
(302 to `https://downloads.smurg.ai/latest/install.sh`; it never serves the script itself) and `/github`.

From the tagged commit, after the release's files are on downloads.smurg.ai, with the release's own notices:

```sh
cd <repo> && source scripts/env.sh                            # a clean checkout of the tag vX.Y.Z
N="$(mktemp -d)/THIRD-PARTY-NOTICES.txt"
curl -fsSLo "$N" https://downloads.smurg.ai/vX.Y.Z/THIRD-PARTY-NOTICES.txt
pnpm --filter @smurg/site exec wrangler whoami                # the account holding the zone
SMURG_SITE_THIRD_PARTY_NOTICES="$N" pnpm --filter @smurg/site run dry-run      # the build + wrangler deploy --dry-run
SMURG_SITE_THIRD_PARTY_NOTICES="$N" WRANGLER_SEND_METRICS=false pnpm --filter @smurg/site exec wrangler deploy
scripts/publish-downloads.sh --check --version X.Y.Z          # no warning about smurg.ai's install.sh or third-party-notices.txt
```

**Never add `www.smurg.ai` as a custom domain** (`apps/site/test/config.test.ts` asserts the apex-only route list):
`www.smurg.ai` is a proxied DNS record of its own, which the zone's Redirect Rule needs, and wrangler run after
`source scripts/env.sh` replaces an existing record without asking (§2). After every deploy:

```sh
curl -sI https://smurg.ai/install.sh           # 302 to https://downloads.smurg.ai/latest/install.sh
curl -fsSIL https://smurg.ai/install.sh        # follows it: the LAST status line is 200
curl -sI https://smurg.ai/github               # 302 to https://github.com/gclinian/smurg
curl -sI https://smurg.ai/docs/hosting/        # 200
curl -sI https://smurg.ai/zh-TW/docs/hosting/  # 200
curl -sI https://smurg.ai/license/             # 200, the MIT License
cmp <(curl -fsS https://smurg.ai/third-party-notices.txt) "$N"   # identical
```

### 4.2 Checking a published release later

`scripts/publish-downloads.sh --check` (no account needed) checks the version `latest/VERSION` names, or `--version
X.Y.Z` any published one, through the plain public URLs: `SHA256SUMS`, every executable's sha256 and `file` type, this
machine's `--version`, `install.sh`'s download location, the notices, the headers (warnings), `latest/` (when it is
that version: `latest/install.sh` identical to the version's), and the smurg.ai redirect. It downloads the four
executables (about 480 MB).

### 4.3 Assembling a release by hand (a target built elsewhere, or an expired artifact)

Should a release's `smurg-linux-arm64` job sit queued (a queued job waits up to 24 hours and its `timeout-minutes`
does not start), build that one target on an arm64 Ubuntu 24.04 machine and publish from a local directory. `D` below
is a scratch directory of yours.

1. Cancel the run (`gh run cancel <run id>`) once the other three builds are green, and download what they built:
   `gh run download <run id> --repo gclinian/smurg --dir "$D" --pattern 'smurg-*' --pattern 'notices-*'`.
   Note the Node version the builds used (the build log's `built … Node 22.x.y` line, or the `node@22.x.y (the
   Node.js runtime)` line of their notices).
2. On the arm64 machine, in a clean checkout of the tag, build with **that** Node: the official linux-arm64 build of
   exactly that version (for example `https://nodejs.org/dist/v22.x.y/node-v22.x.y-linux-arm64.tar.xz`, unpacked
   somewhere outside the repository, or `nvm install 22.x.y`). `scripts/env.sh` picks the newest Node 22 installed on
   the machine, which need not be that one, so name it with `--node` (the notices embed the Node.js LICENSE of the Node
   that becomes the executable, and `release-assets.sh` refuses executables of different Node.js releases):

   ```sh
   git fetch origin && git checkout vX.Y.Z && git status --short     # prints nothing
   scripts/bootstrap-tools.sh && source scripts/env.sh && pnpm install --frozen-lockfile
   scripts/build-sea.sh --node <that node>/bin/node --version X.Y.Z --target linux-arm64   # packages/cli/dist/smurg-linux-arm64 + THIRD-PARTY-NOTICES.txt
   ```

3. Put the four executables in one directory with the notices, check the notices are identical (`cmp`), assemble
   (`release-assets.sh` also refuses an executable that is not this version's build or not on the notices' Node.js),
   make the GitHub release and publish:

   ```sh
   mkdir -p "$D/dist"
   cp "$D"/smurg-*/smurg-* <the arm64 build> "$D/dist/" && cp "$D/notices-linux-x64/THIRD-PARTY-NOTICES.txt" "$D/dist/"
   cmp "$D/dist/THIRD-PARTY-NOTICES.txt" <the arm64 build's THIRD-PARTY-NOTICES.txt>
   scripts/release-assets.sh --version X.Y.Z --dist "$D/dist" --out "$D/release" --require-all --check-arch --notes "$D/notes.md"
   gh release create vX.Y.Z --repo gclinian/smurg --verify-tag --title "smurg X.Y.Z" --notes-file "$D/notes.md" \
     "$D/release/SHA256SUMS" "$D/release/THIRD-PARTY-NOTICES.txt"         # no env.sh in this shell, §1.1
   scripts/publish-downloads.sh --version X.Y.Z --dist "$D/release"
   ```

The same path serves when the artifact `release-X.Y.Z` has expired before step 7 of §4 ran: the builds are not
byte-reproducible, so delete the GitHub release (its `SHA256SUMS` would no longer match), build all four targets
again (a manual run of the workflow keeps each as an artifact), and assemble as above.

### 4.4 Rehearsing a publish without Cloudflare

To try the runbook (or a release's files) without touching the bucket, run the real command against stand-ins on your
machine: a stand-in `wrangler` that keeps the "bucket" in a local directory, and a local HTTP server that serves that
directory the way `downloads.smurg.ai` does (`packages/cli/test/publish-downloads.test.ts` has both, `stubWrangler`
and `serveDownloads`):

```sh
SMURG_PUBLISH_TEST_ORIGIN=http://127.0.0.1:<port>/<prefix> \
SMURG_PUBLISH_TEST_WRANGLER=/abs/path/stub-wrangler \
SMURG_PUBLISH_TEST_SITE_INSTALL_URL=http://127.0.0.1:<port>/site/install.sh \
  scripts/publish-downloads.sh --version X.Y.Z --dist <dir>        # or --from-release (your real gh, read-only), --check, --set-latest
```

Only `127.0.0.1`, `[::1]` and `localhost` are accepted, and any `SMURG_PUBLISH_TEST_*` without both the stand-in origin
and the stand-in wrangler is refused (exit 2): a rehearsal never runs the real wrangler. The first and the last line of
the output say `REHEARSAL`. `SMURG_PUBLISH_TEST_GH` replaces gh the same way.

### 4.5 Before the tag: real Claude Code and the release dry run (since 0.5.0)

The gate and CI run every agent on a scripted stand-in, so two things are done by a person, on their own machine,
before a release is tagged (§4 step 1). Neither uses a Claude account. Real Claude Code talks only to the
repository's fake Anthropic API on 127.0.0.1 (`packages/daemon/test/hooks/mock-anthropic.ts`), with a dummy key and
a temporary `HOME` and `CLAUDE_CONFIG_DIR` that the harness creates and removes
(`packages/daemon/test/hooks/claude-harness.ts`). Never log a test in, never point one at the real API, never run
one with your own `~/.claude`: nothing here may be billed or leave the machine.

**The real-Claude suite.** smurg runs agent sessions on Claude Code 2.1.288 or newer and is verified on exactly
2.1.288 (`CLAUDE_MIN_VERSION` and `CLAUDE_VERIFIED_VERSIONS` in `packages/daemon/src/core/config.ts`; ARCHITECTURE
§11 D-23). The suite skips, loudly, on every other version, and Claude Code updates itself: a green gate on a
machine whose `claude` has moved on has not run it. So name the binary:

```sh
cd <repo> && source scripts/env.sh
SMURG_TEST_CLAUDE_BIN=/absolute/path/to/claude-2.1.288 \
  pnpm --filter @smurg/daemon exec vitest run test/hooks/claude-e2e.test.ts test/hooks/claude-bash.test.ts \
  test/hooks/claude-failmodes.test.ts test/sessions/agent-claude-real.test.ts test/sessions/trust-claude-real.test.ts
```

No file may print `SKIPPED` (five files, 35 tests). What it proves that the stand-in cannot: that real Claude Code
runs smurg's hook before every tool and obeys its refusal, on a host whose own settings allow everything; that a
discussion agent writes only its topic's two files; that commands ask and "always allow" holds; that the host's
private files stay out of reach of the search and read tools; that project settings nobody confirmed are not
loaded; that the hook's question about a shell command near a confirmed hook script stands above the edit mode and
above the host's own allow rules; that no subagent starts; that an `@path` in a message stays text; that a
conversation is resumed after its process ended (`docs/ACCEPTANCE.md`: T2.1, T4.2, S4, S5, S6, S8, S10, S12, S15,
S16, S22, R8.1). The built app's one
pass with real Claude Code in system Chrome belongs to this step too and takes its binary from the same variable
(`flow.claude.smoke` of the web-smoke project: a session without a topic, its first message, a tool, a command that
a member with agent access allows and that really runs, a question and its answer). It runs only when the variable
is set; unlike the daemon's suite it never looks for a `claude` on `PATH`:

```sh
SMURG_TEST_CLAUDE_BIN=/absolute/path/to/claude-2.1.288 pnpm exec vitest run --project @smurg/web-smoke flow.claude
```

Both were run on macOS only: the Linux VM and CI's runners have no Claude Code, so real Claude Code is not tested on
Linux (`docs/ACCEPTANCE.md`, "Linux verification").

Making a newer Claude Code the verified one is a code change with a release of its own, not a release step: run
this suite against it, then change the two constants in the same commit as whatever the suite made necessary.

**The release dry run.** Nothing in it tags, pushes, publishes or deploys; those stay steps 3 to 8 of §4.

1. The version: `"version": "X.Y.Z"` in all eight `package.json` files (§4 step 2), then the full gate with
   `SMURG_RELEASE_GATE=1` on macOS and in the Ubuntu 24.04 VM. The counts go into `docs/ACCEPTANCE.md` ("How to run
   the gate", "Linux verification").
2. The executable for this machine: `scripts/build-sea.sh --version X.Y.Z` (it runs the smoke tests). Then, by hand,
   with the built executable, a scratch `HOME` and a scratch `SMURG_HOME` whose path is SHORT (the control socket
   lies in it, and a Unix socket's path has a small limit): `--version` (it says `protocol v4`), `licenses`,
   `login --relay http://localhost:8787 --dev-user host` against a local relay (`apps/relay/README.md`, "Local
   development"), then `host` on a scratch folder that is a git repository, with the stand-in `claude` in place of
   Claude Code. smurg runs the first `claude` on the host's `PATH`: for that shell only, put the wrapper that
   `installFakeClaude` writes in front (`scripts/dev-stack.sh --stand-in-claude --dir D` leaves one in
   `D/stand-in-claude/`); it does what the scenario file named by `FAKE_CLAUDE_SCENARIO` says. The bare
   `packages/daemon/src/testing/fake-claude.mjs` is not enough: smurg asks a `claude` for its version with a short,
   fixed `PATH`, on which the Node of a version manager is not found, and `status` then says "version unknown". Then
   `status` (the lines about Claude Code, agent sessions, topics, the project settings and the host's own rules; the
   Claude Code line says "not checked yet" until the first agent session has started) and `stop` (the line about
   paused agent sessions when there were any).
3. One pass of real Claude Code 2.1.288 through the BUILT executable, against the fake API with the isolated
   configuration described above. Since 0.5.0 Claude Code calls the executable's own `smurg hook` before every tool
   and its own `smurg mcp` for the agent's tools, and both reach the daemon inside the same executable: this pass is
   the only place where that chain runs as packaged. Record the hook's time per tool call in `docs/ACCEPTANCE.md`
   ("Measured values"). There is no script for this pass yet; for 0.5.0 a driver written for the occasion did it,
   and it cannot be done by typing commands. What such a driver has to do: start the fake API and build the isolated
   environment the way `claude-harness.ts` does (the folder trusted and the dummy key approved, as its
   `seedClaudeTrust` does); start `smurg host` ITSELF from the built executable inside that environment, with a
   `PATH` whose first `claude` is the 2.1.288 binary; open a session with an SDK client and let the fake API answer
   with tool calls (one that passes the gate, one that asks a person); and time every `smurg hook` process from the
   moment it appears as a child of `claude` to its exit, watching only (it signals nothing). Check afterwards that
   the agent's own environment named the fake API and the scratch folders. Making this an opt-in test of the
   repository is the next step.
4. The release files, the install and the update, from a local file server laid out like the downloads site (the
   updater reads `<base>/latest/VERSION` and `<base>/vX.Y.Z/…`; the installer's base is ONE version's folder, so
   the flat folder of §5 serves the installer only). With `T` a scratch directory:
   `scripts/release-assets.sh --version X.Y.Z --dist packages/cli/dist --out "$T/site/vX.Y.Z"`, then
   `mkdir "$T/site/latest" && printf 'X.Y.Z\n' > "$T/site/latest/VERSION"`, and a file server on `$T/site`
   (`python3 -m http.server <port> --bind 127.0.0.1 --directory "$T/site"`; stop it afterwards). Install with
   `sh "$T/site/vX.Y.Z/install.sh" --base-url http://127.0.0.1:<port>/vX.Y.Z --prefix "$T/try"`; then, with a
   scratch `HOME` and `SMURG_HOME`, `SMURG_INSTALL_BASE_URL=http://127.0.0.1:<port> "$T/try/bin/smurg" update
   --check` says `smurg X.Y.Z is the latest version.` To see an update happen, build an executable with an older
   number (`scripts/build-sea.sh --version 0.0.1 --out "$T/old/smurg" --no-smoke`) and run its `update` with the
   same variable: it refuses while that executable is sharing, leaves the executable alone when the download does
   not match its checksum (change one byte of the served file to see it), and otherwise ends with `Updated smurg:
   0.0.1 -> X.Y.Z`. Never run a release's `install.sh` without `--base-url` or `SMURG_INSTALL_BASE_URL`: its
   built-in location is the real downloads site.
5. The third-party notices are fresh: `node scripts/third-party-notices.ts --check` (0.5.0 added one dependency to
   the web app, the Markdown lexer `marked`, and its notices must list it).
6. The frames per minute of the whole flow through the local relay (the flow of the web-smoke project's flow smoke:
   four browsers, the stand-in `claude`; the relay's test tap sees every frame). `pnpm exec vitest run --project
   @smurg/web-smoke flow.smoke` prints it in its last test as `[flow] {…}` and, with `SMURG_SMOKE_SHOTS=<folder>`,
   writes `<folder>/flow-measure.json`. §8 has the number of the integration run; record a new one there when it
   differs much.
7. Afterwards nothing is left: no `claude`, `workerd`, Chrome or daemon that the run started is alive, and
   `git status` shows only the intended changes.

When all of it is green, go on with §4: the changelog checks of step 2, then the relay (step 3), then the tag.

## 5. Checking the one-line install on a clean machine

**Before publishing**, install from a local copy of the release's files (the artifact `release-X.Y.Z`, or the
directory `release-assets.sh` wrote; `T` is a scratch directory of yours):

```sh
gh run download <run id> --repo gclinian/smurg --name release-X.Y.Z --dir "$T/files"   # a shell without scripts/env.sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory "$T/files" &                  # stop it afterwards
sh "$T/files/install.sh" --base-url http://127.0.0.1:8000 --prefix "$T/try"
"$T/try/bin/smurg" --version                                                           # smurg X.Y.Z (…)
```

**After publishing**, time SPEC R1.1 on a fresh macOS and a fresh Ubuntu 24.04 (a new macOS user account is the
cheapest fresh Mac; a new VM or cloud instance for Ubuntu, with a desktop or over SSH: `smurg login` prints a page and a
code to enter in any browser):

1. Start a timer. `curl -fsSL https://smurg.ai/install.sh | sh` (on a second machine also try the version's own line,
   `curl -fsSL https://downloads.smurg.ai/vX.Y.Z/install.sh | sh`).
2. Add `~/.local/bin` to `PATH` as the installer says; open a new terminal.
3. `smurg login` (Google), then `smurg host <a folder>`. Stop the timer when the invite link is printed (R1.1: under 3
   minutes).
4. Check: `smurg --version` is the tag; `smurg licenses` prints the MIT license and the notices; macOS:
   `xattr -l ~/.local/bin/smurg` shows no `com.apple.quarantine`; Ubuntu: the installer asked for nothing (no sudo,
   no package) and `smurg host` printed only the two links. Do it once with the system language set to English and
   once to Traditional Chinese: the installer and the CLI answer in that language.
5. Join from another machine's browser with another Google account: as an Editor, vote on a question of the host's
   agent and send it a suggestion (it reaches the agent only when the host accepts it); then, with Agent access
   (`smurg host --role agent`, or the console), send a message to the host's agent session, open a terminal session
   and type into a terminal the host opened. A member's sessions run as the host (`whoami` in a terminal session the
   member opens says the host's user). The agent half needs a host whose own Claude Code is logged in: the
   maintainer's own account on the maintainer's own machine. A check without one covers the terminal half only, and
   the record says so.
6. Record the times, machines and anything that went wrong in `docs/ACCEPTANCE.md` (R1.1, and R9 for Ubuntu).

## 6. What is public

Everything in the repository, its history, issues and pull requests; the workflow logs and artifacts of every run
(artifacts can be downloaded by anyone logged in to GitHub until they expire: the builds for 7 days, `release-X.Y.Z`
for 30); the GitHub releases; the files on `downloads.smurg.ai`, `app.smurg.ai` and `smurg.ai`.

So nothing private goes into a commit, an issue, a workflow log or a release file: no secret, no token, no account or
zone identifier, no personal path. Operational notes that are not for the public (who holds which account, usage and
cost figures) are kept outside the repository.

## 7. Rolling back

**A bad release** (people should stop installing it): point `latest/` back at the previous good version. Nothing is
overwritten:

```sh
cd <repo> && source scripts/env.sh
scripts/publish-downloads.sh --set-latest X.Y.W --dry-run    # verifies vX.Y.W as published, says what latest/ would become
scripts/publish-downloads.sh --set-latest X.Y.W              # latest/install.sh = vX.Y.W/install.sh, latest/VERSION = X.Y.W
scripts/publish-downloads.sh --check                         # checks the version latest/ now names
```

`--set-latest` refuses a version that is not completely and correctly published, and a pre-release. Within five
minutes (`latest/`'s `max-age=300` at most) `https://smurg.ai/install.sh` installs the good version again; tell hosts
who installed the bad one to run the one-line command again (it replaces `~/.local/bin/smurg`): `smurg update` does
not help them, it never installs a version older than the one that runs (it says so), and `smurg host`'s update notice
stays silent. Publishing `latest/` is also what makes every installed copy offer the new version (`smurg update`, and
one line under the links of `smurg host`, both read `latest/VERSION`). Mark the GitHub release:
`gh release edit vBAD --repo gclinian/smurg --prerelease`, and say so in its notes. **Never reuse a published
version's number**: the next fix is X.Y.(Z+1), published normally (it becomes latest again because it is newer).

**Removing a version.** A version's files are never overwritten, and they stay as long as the version may be the
rollback target (at least the one before `latest/`). Older versions may be removed by a maintainer's decision
(`pnpm --filter @smurg/relay exec wrangler r2 object delete smurg-downloads/vX.Y.Z/<file> --remote`, each file); the
changelog keeps describing them. Something that must not be public at all in a release file (a secret) is removed at
once: `--set-latest` away from it first, delete the affected objects, rotate the secret, and keep the number burned.

**A bad relay deploy**:

```sh
cd <repo> && source scripts/env.sh && cd apps/relay
pnpm exec wrangler versions list      # recent versions of the Worker
pnpm exec wrangler rollback <version-id> --message "why"
```

A rollback restores the Worker's code and configuration, not the Durable Objects' stored data, and like a deploy it
disconnects every socket. Cloudflare does not roll a Worker back across a Durable Object migration (fix forward
instead). Its web app is rolled back too, and an older web app refuses the `channel.welcome` of a newer daemon (§4
step 3): do not roll back past the version deployed for the latest release. Across 0.5.0 that is absolute: the web
app deployed before it speaks protocol 3 and refuses every 0.5.0 host at the handshake.

**Stopping the relay in an emergency** (a leaked signing key, abuse): remove the custom domain from the Worker
(dashboard → Workers & Pages → smurg-relay → Settings → Domains & Routes); put a new `RELAY_SIGNING_KEY`; then deploy
again (`scripts/deploy-relay.sh`), which attaches the custom domain again. `wrangler delete` also removes every
Durable Object's data; avoid it.

## 8. Limits of the hosting plans

The relay runs within Cloudflare's daily limits for Workers and Durable Objects (requests, Durable Object requests and
rows written, CPU time per request), and the downloads within R2's. When a daily limit is used up, **operations of
that kind fail for everyone until the reset at 00:00 UTC**: new connections and messages are refused, hosts see the
relay link drop, members see that the server cannot be reached. What uses them in smurg: every login step, `/api/*`
call and WebSocket upgrade (a Worker request); each WebSocket connection, each alarm run and incoming WebSocket
messages (Durable Object requests; the `ping` heartbeats are answered by Cloudflare itself and cost nothing); each
alarm scheduled (a row written). The web app's files and the product page are static assets served without running a
Worker; `downloads.smurg.ai` is R2, not a Worker. Terminal output is the largest consumer, and since 0.5.0 so is an
agent's streaming text: every frame the relay forwards arrived as an incoming WebSocket message.

0.5.0 sizes that stream for the free plan (ARCHITECTURE §12): an agent's streaming text travels at most once per
200 ms and its finished events in batches at most once per 100 ms, per watching browser, and streaming text goes
only to conversations that are on screen (a hidden column gets the finished events and no streaming frames). What
that comes to for a whole working session is measured, not estimated: the flow smoke counts the frames of the whole
flow through a local relay (§4.5 step 6).

- **0.5.0, measured** (2026-10-07, macOS arm64, Node 22.22.1, a local relay with its test tap;
  `apps/web/e2e/smoke/flow.smoke.test.ts`, two runs): the owner's whole flow with four browsers (Host, Agent access,
  Editor, Viewer) took 114 s each time. The relay received 4,527 and 4,558 WebSocket frames (3,391 / 3,418 from the
  host, 1,136 / 1,140 from the four browsers; 2.60 / 2.61 MB), sent 4,547 / 4,578 on, and answered 40 HTTP requests.
  That is **about 2,400 incoming frames per minute for four browsers** (2,388 and 2,409), about 600 per person and
  minute.
- **What was counted**: everything from the start of the relay to the end of the last step: four joins (login,
  invite, Noise handshake, first sync), then one topic with 4 work items, 7 agent sessions, about 10 cards, two
  people editing a document together and one restart of the host's smurg with four reconnects. Streaming text was on
  screen in at most three columns per browser.
- **What it means.** The stand-in agents answer at once, so this is the flow at a pace no real team has: real work
  spreads the same events over much more time (and about one minute of the 114 s is a question nobody answers,
  during which almost nothing travels, so the busy part is busier than the average says). Against the free plan's allowance as `apps/relay/README.md` records it
  (100,000 Durable Object requests a day, 20 incoming WebSocket messages counting as 1): one whole flow is about
  4,500 incoming frames, so about 230 requests, and by this item alone the day's allowance carries a little over 400
  such flows across ALL workspaces of the shared relay. The alarms of connected workspaces (about 14,000 to 22,000
  requests per workspace and day, same README) use the allowance much faster than the messages do. Not measured: a
  real model (it writes more text per turn than the stand-in's scripted sentences), and the usage as Cloudflare
  counts it on a deployed relay.

Whether that leaves enough room on the free plan for the shared relay, or the paid plan is taken, is the owner's
decision; it changes no code and no configuration (below).

The current numbers are on Cloudflare's pricing pages; `docs/research/relay.md` has what was measured about the
relay's own behaviour. Watch the usage in the dashboard (Workers & Pages → smurg-relay → Metrics) after a release; a
paid Workers plan removes the daily caps without a code or configuration change.

## 9. Security notes

- **macOS**: the executables are signed ad hoc, not with a Developer ID, and not notarized. `curl` sets no quarantine
  attribute, and the installer removes one after the sha256 check, so Gatekeeper does not stop it. A binary downloaded
  with a browser and started by hand is blocked by Gatekeeper; the installer is the supported path.
- **Checksums** are published in two places, `downloads.smurg.ai` and the GitHub release, and
  `publish-downloads.sh --from-release` refuses files whose `SHA256SUMS` is not the GitHub release's. They catch a
  corrupted or truncated download and a bucket whose files were replaced; they do not protect against a compromised
  GitHub account or workflow (CI builds what is published). `SHA256SUMS` is not signed: a signature with a key pinned
  in `install.sh` would close that gap. Protect the accounts (2FA), publish only from your own machine, keep the
  workflows' actions pinned to commit SHAs (only `actions/*`), and give write access sparingly.
- **Pull requests** run CI with a read-only token and no secret; the release workflow runs only for a pushed tag or a
  manual run, both of which need write access.
- **No workflow has a Cloudflare or Google secret**: the relay, the site and the downloads are deployed by hand, and
  the relay's secrets exist only in Cloudflare's secret store.
- **What the relay operator can see**: account identities and IP addresses of connections, workspace ids, frame sizes
  and timing, never content (ARCHITECTURE §11 D-5); `docs/HOSTING.md` §2 tells hosts the same in plain words, and
  that they can run a relay of their own (`apps/relay/README.md`).
