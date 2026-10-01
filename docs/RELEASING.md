# Releasing smurg

The runbook for the project owner and the project lead: one-time setup, deploying the shared relay, cutting a
release (built by GitHub Actions in the private repository, published by a person to Cloudflare R2), deploying the
product page, checking it, rolling back, what Cloudflare's free plan allows and what GitHub Actions costs. Nothing in
the repository uploads, deploys or signs anything by itself; every step that touches a GitHub or Cloudflare account is
run by a person.

Steps marked **[owner]** need the owner's own accounts or secrets (nobody else ever sees the Google client secret or
the relay's signing key). Steps marked **[lead]** need the repository and, where it says so, the repository's wrangler
login (§1.2). **[owner or lead]** means either.

Where this stands (2026-10-01, after the decision below): the repository is on GitHub, **private**; the shared relay
is live on `https://app.smurg.ai` (§2); the product page `https://smurg.ai` is live, but **it is still the build of
`cb99aa0`, which tells everyone, in English and in Traditional Chinese, that "smurg is open source under the Apache
License 2.0"** (the eyebrow "Open source · macOS and Linux", an "Open source" section, the meta description), links
the private GitHub repository, and redirects `/install.sh`, `/github` and `/docs` there (404s for everyone else). That
is false since the decision, so **redeploying the site is urgent and does not wait for the release** (§4.1 "Now";
§10 item 10). The release workflow ran once on GitHub, as a dry run of the earlier layout (run 36846007788 on
`e66f46c`: all six jobs green, **the arm64 Linux runner included**, on the private repository). The R2 bucket does not
exist yet (§1.5), so nothing has been published. What was checked for the new layout, without any account:
`scripts/publish-downloads.sh` against a stub `wrangler` and a local stand-in of `downloads.smurg.ai`
(`packages/cli/test/publish-downloads.test.ts`: dry run, refusing to overwrite, `--resume`, upload order, a read-back
failure stopping before `latest/` and the way out of it, a `--resume` that must not undo a rollback, `--check`,
`--set-latest`, the build markers and the complete notices, a rehearsal through the real command); on macOS arm64 a
real `scripts/build-sea.sh --version 0.1.0` build plus stand-ins for the other three targets, assembled by
`scripts/release-assets.sh --require-all --check-arch`, "published" to that local stand-in (dry run, upload, read
back, `latest/`, `--check`, and the refusal to publish the same version again), and installed from it by the real
`install.sh` (sha256 verified, `--version` right). The workflow YAML was parsed and its shell steps checked with
`bash -n`; **actionlint and shellcheck were not available for this change**: run them before the next tag (§4
step 1).

## The plan (decided 2026-10-01, replacing the public-repository plan of 2026-09-30; `docs/OPEN-QUESTIONS.md` Q1)

| What | Decision |
|---|---|
| Source | GitHub `gclinian/smurg`, **private, for good**. It is never made public, and nothing is pushed to a public place. |
| License | **Proprietary** (`LICENSE`): "Copyright (c) 2026 <COPYRIGHT HOLDER>. All rights reserved." plus short terms for the free executables and web app. The placeholder stays until the owner names the holder; `scripts/release-assets.sh --publish-checks` refuses a tag while it is there (§4 step 2). Every `package.json` says `"license": "UNLICENSED"` and `"private": true`. **The terms are not legal advice: have them reviewed (§6.1).** |
| Third-party notices | Required whatever the license: `THIRD-PARTY-NOTICES.txt`, generated from the installed packages (`scripts/third-party-notices.ts`), embedded in each executable (`smurg licenses`), written by `scripts/build-sea.sh` next to the executable and published with every release; the web app serves its own (`/third-party-notices.txt` on app.smurg.ai), smurg.ai serves the executable's. |
| Downloads | **Public, on Cloudflare R2**: bucket `smurg-downloads` behind the custom domain **`https://downloads.smurg.ai`**. `v<X.Y.Z>/` holds `smurg-darwin-arm64`, `smurg-darwin-x64`, `smurg-linux-x64`, `smurg-linux-arm64`, `SHA256SUMS`, `install.sh` (its download location pinned to `https://downloads.smurg.ai/v<X.Y.Z>`) and `THIRD-PARTY-NOTICES.txt`, `Cache-Control: public, max-age=31536000, immutable`, **never overwritten, never deleted**. `latest/install.sh` (a copy of the newest version's `install.sh`) and `latest/VERSION` (`X.Y.Z`), `Cache-Control: public, max-age=300`. |
| Install line | Unchanged: `curl -fsSL https://smurg.ai/install.sh \| sh`. smurg.ai answers `/install.sh` with a **302 to `https://downloads.smurg.ai/latest/install.sh`**. There is **no GitHub fallback** any more (release downloads of a private repository need a login). One version: `curl -fsSL https://downloads.smurg.ai/v<X.Y.Z>/install.sh \| sh`. |
| Who uploads | **A person** (owner or lead) with `scripts/publish-downloads.sh` and the repository's wrangler login (`<repo>/.xdg`, §1.2). **Not CI: no Cloudflare credential is stored in GitHub.** |
| Builds | GitHub Actions on a tag `v*` (`.github/workflows/release.yml`), each target on its own runner: macOS Apple Silicon (`macos-15`), macOS Intel (`macos-15-intel`), Linux x64 (`ubuntu-24.04`), Linux arm64 (`ubuntu-24.04-arm`; available to this private repository: run 36846007788). The result is a GitHub release **in the private repository, the internal record**; the job summary prints the publish command. `macos-13` is retired (2025-12-04), `macos-14` is removed on 2026-11-02; `macos-15-intel` is GitHub's last x86_64 image, until August 2027 (actions/runner-images #13046, #13518, #13045). |
| Shared relay | One Worker (`smurg-relay`) on Cloudflare Workers, **free plan**, serving the relay and the web app at the Custom Domain **`https://app.smurg.ai`** (the zone `smurg.ai` is on the same account). Its workers.dev hostname is off. Invite links are `https://app.smurg.ai/join/<id>#…`. |
| Product page and user docs | `https://smurg.ai` (`apps/site`, a second Worker on the same account; apex only, `www.smurg.ai` redirected by a zone Redirect Rule). It also publishes the user docs at **`https://smurg.ai/docs/`** (docs/HOSTING.md, docs/JOINING.md and CHANGELOG.md rendered at build time, in Traditional Chinese), `/license/` and `/third-party-notices.txt`. The internal docs (ARCHITECTURE, this file, ACCEPTANCE, OPEN-QUESTIONS, research) are **not** published. |
| Login | Google only, with an OAuth client the owner creates. GitHub login stays in the code but is not configured on the shared relay. |
| Signing | None from Apple: ad-hoc signature only. The installer verifies the sha256, then removes the quarantine attribute. |
| First version | v0.1.0 |

### What a private repository changes (say it as it is)

- **Nobody else can run a relay of their own.** `apps/relay` is in the private repository, so the advice of
  ARCHITECTURE §11 D-5, "hosts who cannot accept what the shared relay sees deploy their own relay", has no path for
  anyone outside the project. `--relay` (and `SMURG_RELAY_URL`) stay, for relays the owner runs. The user docs and the
  product page say so (`docs/HOSTING.md` §2, the site's FAQ, ARCHITECTURE §12).
- **The code is not secret.** Each executable contains the whole JavaScript program (a Node SEA embeds it), and the
  web app's code is delivered to every browser. Keeping the repository private keeps the history, the tests and the
  relay's source to the project; what protects the code is the license.
- **GitHub Actions minutes are billed** on a private repository (§8.1).
- **GitHub release downloads need a login**: the GitHub release is the internal record only; people install from
  `downloads.smurg.ai`.

## 0. What is where

| Piece | Where | Verified so far |
|---|---|---|
| Single executable (Node SEA: CLI + daemon + native parts) for the platform it is built on | `scripts/build-sea.sh [--node <node>] --version X.Y.Z [--target <platform>-<arch>]` → `packages/cli/dist/smurg-<platform>-<arch>` and, next to it, `THIRD-PARTY-NOTICES.txt` (exactly the notices it embeds); checks that it runs (`--version`), that the program names no private repository, that the executable carries its build marker `smurg-build-version=X.Y.Z;` and the download URL of its Node.js release (`scripts/release-markers.ts`), prints its sha256, runs the smoke test `packages/cli/test/sea.test.ts`. `--target` refuses a runner or a Node of another platform/arch; the tag form `--version v0.1.0` is accepted | macOS arm64 locally (2026-10-01, with the notices and the markers); all four targets on GitHub in dry run 36846007788 (before the notices existed) |
| Third-party notices | `scripts/third-party-notices.ts` (from `pnpm-lock.yaml` and the installed packages' own LICENSE / NOTICE files) → `packages/cli/THIRD-PARTY-NOTICES.txt` (the executable's; its Node.js section is a placeholder that `scripts/build-sea.sh` fills with the LICENSE of the Node.js the executable is a copy of, the complete text going into the executable and next to it) and `apps/web/public/third-party-notices.txt` (the web app's, served at `https://app.smurg.ai/third-party-notices.txt`). **After any dependency change** run `node scripts/third-party-notices.ts` and commit both files: `pnpm check`, `scripts/build-sea.sh` and the web build refuse stale ones | `packages/cli/test/third-party-notices.test.ts`, `apps/web/test/third-party-notices.test.ts` |
| Release files | `scripts/release-assets.sh --version X.Y.Z [--dist DIR] [--out DIR] [--notices FILE] [--require-all] [--check-arch] [--notes FILE] [--changelog FILE] [--base-url URL]` → `<out>/{smurg-*, SHA256SUMS, install.sh, THIRD-PARTY-NOTICES.txt}` (default `packages/cli/dist/release/X.Y.Z`): copies the executables with mode 0755, checks with `file` that each is the Mach-O / ELF its name says, that **each** carries the build marker of X.Y.Z and the same Node.js release as the notices' `node@A.B.C (the Node.js runtime)` section (so an executable of another version or Node.js cannot be mixed in, §4.3), runs this machine's and requires exactly `smurg X.Y.Z (… node A.B.C)`, bakes `https://downloads.smurg.ai/vX.Y.Z` (or `--base-url`) into `install.sh`, refuses to assemble without the notices (default `<dist>/THIRD-PARTY-NOTICES.txt`), with notices that do not name node-pty, @parcel/watcher, @anthropic-ai/sandbox-runtime and Node.js, or with incomplete ones (the committed file with its placeholder, no filled-in Node.js section), writes the notes (the CHANGELOG section, the install line, the checksums). Check-only modes: `--check-changelog`, `--publish-checks` (§4) | `packages/cli/test/install-script.test.ts`; the real macOS arm64 build with stand-ins (2026-10-01) |
| Publishing | `scripts/publish-downloads.sh --version X.Y.Z (--from-release \| --dist DIR) [--dry-run] [--resume] [--no-latest]`, `--check [--version X.Y.Z]`, `--set-latest X.Y.Z` (§4 step 7, §7); a rehearsal against stand-ins on this machine with `SMURG_PUBLISH_TEST_ORIGIN` + `SMURG_PUBLISH_TEST_WRANGLER` (§4.4). Implementation and every rule: `scripts/publish-downloads.ts` | `packages/cli/test/publish-downloads.test.ts` (stub wrangler, local stand-in of the domain, stub gh, the real command in a rehearsal); the real arm64 build through a local stand-in (2026-10-01). **Never run against R2** |
| Installer | `scripts/install.sh`: picks darwin/linux × arm64/x64 (glibc; Rosetta shells get arm64), downloads `SHA256SUMS` and then the executable from its baked download location (`SMURG_INSTALL_BASE_URL` / `--base-url` override it), installs `~/.local/bin/smurg` only when the sha256 matches (https only; http only for 127.0.0.1 / localhost); macOS: removes `com.apple.quarantine` after the sha256 matched and before the first run; Linux: bubblewrap / socat / ripgrep and the Ubuntu 24.04+ AppArmor profile for `/usr/bin/bwrap`, only with consent; the summary names the license (`https://smurg.ai/license/`) and the version's `THIRD-PARTY-NOTICES.txt` | `packages/cli/test/install-script.test.ts` (39 tests: every OS/arch through a faked `uname`, under sh and dash; the R2 layout `v<X.Y.Z>/` + `latest/` behind a stand-in curl and from a local server). The Linux branch ran only against stand-ins |
| Release workflow | `.github/workflows/release.yml`, on a tag `v*`: `prepare` (tag format, `--check-changelog`, `--publish-checks`), four builds (`build-sea.sh --version X.Y.Z --target …`; setup-node `check-latest`, so all four use the same Node), then: the four builds' notices must be identical, `release-assets.sh --require-all --check-arch --notes`, a **draft** GitHub release in the private repository with the seven files, a check of the uploaded asset list, then published as the record, and a job summary with the publish command. Only the release job has `permissions: contents: write`; actions are pinned to commit SHAs. A manual run (Actions → Release → Run workflow) is a dry run that records nothing | the earlier layout: dry run 36846007788 green (2026-10-01). This layout: YAML parsed, shell steps `bash -n`, the notices and summary steps run locally; not run on GitHub; actionlint / shellcheck not run |
| CI | `.github/workflows/ci.yml`: `pnpm check` on `macos-15` and `ubuntu-24.04` for pushes to `main`, pull requests and manual runs | green on GitHub (e.g. 36843981108 on `e66f46c`) |
| Relay deploy | `scripts/deploy-relay.sh` (§2): production build of web + relay, then `wrangler deploy` of the top level of `apps/relay/wrangler.jsonc` (`https://app.smurg.ai` as a Cloudflare Custom Domain, workers.dev off, Google only, dev login off); `--dry-run`, `--check <url>` | `apps/relay/test/deploy-relay.test.ts`; against the account: the workers.dev shape (2026-10-01); the custom-domain path runs for the first time at the next deploy (§10) |
| CLI default relay | `DEFAULT_RELAY_URL` in `packages/cli/src/relay/default-relay.ts`: `'https://app.smurg.ai'` (§3) | unit tests; `apps/relay/test/config.test.ts` checks it equals `RELAY_ISSUER` |
| Product page and user docs | `apps/site` (`apps/site/README.md`): smurg.ai, its `/docs/`, `/license/`, `/third-party-notices.txt` (a deploy must name the release's notices file: `SMURG_SITE_THIRD_PARTY_NOTICES`, §4.1); `/install.sh` → 302 `https://downloads.smurg.ai/latest/install.sh` (§4.1) | `pnpm check`; the live site is still `cb99aa0`'s, which claims "open source under the Apache License 2.0": redeploy now (§4.1) |
| Release notes | `CHANGELOG.md`: one `## [X.Y.Z] - YYYY-MM-DD` section per version; it is published on `https://smurg.ai/docs/changelog/`, and the release workflow puts it into the private GitHub release's notes | locally |

---

## 1. One-time setup

### 1.1 GitHub repository [lead, then owner] — done 2026-10-01

1. **[lead]** `source scripts/env.sh && pnpm check` green; first commit reviewed (no `.dev.vars`, `.xdg/`,
   `node_modules`). Done (commit 0b99dc8).
2. **[owner]** `gh repo create gclinian/smurg --private --source=. --remote=origin --push`. Done. **It stays
   private** (§6).
3. **[owner]** Settings → Actions → General: Actions allowed; default workflow permissions read-only (the release job
   declares `contents: write` itself); no repository secret is needed (none must ever be added for Cloudflare).
   Two-factor authentication on the account: whoever controls it controls what the private record and CI build.
4. **[owner]** Settings → Billing and licensing: Actions minutes on a private repository count against the plan's
   allowance (§8.1). Keep the Actions budget at $0 (usage stops when the included minutes run out instead of being
   billed) unless you decide otherwise; check the usage page after the first releases.
5. **[lead]** First CI run green, Linux included. Done (run 36779794102).

`gh` and `scripts/env.sh`: env.sh sets `XDG_CONFIG_HOME=<repo>/.xdg` (for wrangler), and gh looks for its login in
`$XDG_CONFIG_HOME/gh`, so in a shell that sourced env.sh plain `gh` says it is not logged in. Run gh in another shell,
or with `GH_CONFIG_DIR=~/.config/gh gh …` (verified 2026-10-01). `scripts/publish-downloads.sh` does this by itself.

### 1.2 Cloudflare account and wrangler [owner] — done 2026-10-01

1. A Cloudflare account (free plan) with the zone **smurg.ai** (Cloudflare's nameservers, status Active). The shared
   relay is the Custom Domain `app.smurg.ai`, the product page `smurg.ai`, the downloads `downloads.smurg.ai` (§1.5).
2. wrangler's login lives in the repository (`scripts/env.sh` sets `XDG_CONFIG_HOME=<repo>/.xdg`, gitignored; relay.md
   gotcha 16). The relay, the site and the downloads use the same login:

   ```sh
   cd <repo> && source scripts/env.sh
   CI=false pnpm --filter @smurg/relay exec wrangler login     # opens your browser; CI=true (env.sh) makes wrangler non-interactive
   pnpm --filter @smurg/relay exec wrangler whoami             # shows the account
   ```

   `wrangler logout` (same prefix) removes the login. Never copy `.xdg/` anywhere. Whoever publishes releases (owner
   or lead) needs this login on their own checkout.

### 1.3 Google OAuth client [owner only] — done 2026-10-01

In the Google Cloud console (project "smurg"):

1. **OAuth consent screen** (**Google Auth Platform → Branding / Audience**): user type **External**; app name "smurg";
   support and developer contact e-mail; scopes `openid`, `email`, `profile`. **Publishing status: In production**
   (in "Testing" only listed test users can log in; confirm, §10). **Authorized domains**: `smurg.ai`.
2. **Credentials → OAuth client ID**, type **Web application**; **Authorized JavaScript origins**:
   `https://app.smurg.ai`; **Authorized redirect URIs**: `https://app.smurg.ai/auth/google/callback`, exactly
   (`scripts/deploy-relay.sh` prints both). The CLI's login goes through the same callback, so no loopback URI is
   registered. The workers.dev origin and redirect URI of the first deploy can be removed (that hostname answers 404).
3. The **client ID** is public (it goes into `apps/relay/wrangler.jsonc`); the **client secret** goes only into
   `wrangler secret put` below, never into the repository, CI, a chat or an issue.

### 1.4 Relay secrets [owner only] — done 2026-10-01

```sh
cd <repo> && source scripts/env.sh     # the same commands scripts/deploy-relay.sh prints
node apps/relay/scripts/signing-key.ts | pnpm --filter @smurg/relay exec wrangler secret put RELAY_SIGNING_KEY --env=""   # generated and piped: nobody sees it
CI=false pnpm --filter @smurg/relay exec wrangler secret put GOOGLE_CLIENT_SECRET --env=""                               # paste the client secret at the prompt
```

- `RELAY_SIGNING_KEY` must exist before a Worker's first deploy (wrangler refuses otherwise); it needs no backup: if
  it is lost, put a new one and everyone logs in again. To rotate without logging everyone out, put
  `{"keys":[<new private JWK>, <old public JWK>]}` (`apps/relay/README.md`, 設定).
- `CI=false` for the pasted secret: `scripts/env.sh` sets `CI=true`, under which wrangler cannot prompt.
- `GITHUB_CLIENT_SECRET` is not set: GitHub login is off (`/api/login-options` says `github: false`).

### 1.5 The downloads bucket and its domain [owner enables R2, then owner or lead] — to do

`scripts/publish-downloads.sh` stops with exit 3 and points here while the bucket does not exist. Commands from wrangler
4.142's own help and source; **none of this has run against the account yet**.

1. **[owner]** Cloudflare dashboard → **R2 Object Storage**: enable R2 for the account (the dashboard may ask to accept
   R2's terms and for a payment method even for the free allowance; R2 has no egress fees, §8).
2. **[owner or lead]** Create the bucket (the location is chosen automatically near whoever creates it):

   ```sh
   cd <repo> && source scripts/env.sh
   pnpm --filter @smurg/relay exec wrangler r2 bucket create smurg-downloads
   pnpm --filter @smurg/relay exec wrangler r2 bucket list                          # name: smurg-downloads
   ```

3. **[owner or lead]** Connect the custom domain (Cloudflare creates the DNS record and the certificate in the
   `smurg.ai` zone; the zone ID is on the zone's Overview page in the dashboard; the dashboard's R2 → smurg-downloads →
   Settings → Custom Domains → Connect Domain does the same):

   ```sh
   pnpm --filter @smurg/relay exec wrangler r2 bucket domain add smurg-downloads --domain downloads.smurg.ai --zone-id <zone id of smurg.ai> --min-tls 1.2
   pnpm --filter @smurg/relay exec wrangler r2 bucket domain list smurg-downloads   # downloads.smurg.ai, enabled
   pnpm --filter @smurg/relay exec wrangler r2 bucket dev-url get smurg-downloads   # the r2.dev URL stays disabled: the custom domain only
   ```

   Under `CI=true` wrangler answers its own "Are you sure … publicly available" question with yes; the bucket's
   contents are meant to be public.
4. **Zone settings** that matter for `downloads.smurg.ai` (zone-wide, §2): **Always Use HTTPS** is on (the installer
   refuses plain http anyway); keep **Bot Fight Mode off** and no challenge for this hostname (`curl` cannot pass one);
   **Caching → Browser Cache TTL: Respect Existing Headers**, so the objects' own Cache-Control is what clients see.
   No Cache Rule is needed. If one is ever added to cache the executables at the edge, it must respect the origin's
   Cache-Control: `latest/` must not be held longer than its `max-age=300`. (`publish-downloads.sh` reads files back
   past any edge cache and warns when the plain URL still serves an older `latest/`.)
5. Optional, **not tried**: enforce "never overwritten" in R2 itself with a bucket lock on the version prefixes
   (`wrangler r2 bucket lock add smurg-downloads --name versions --prefix v --retention-indefinite`; `latest/` must not
   be locked). Read Cloudflare's "Bucket locks" page first: a lock also stops the owner from deleting an object (§7).
6. Check: `curl -sI https://downloads.smurg.ai/latest/VERSION` answers 404 from R2 (the bucket is empty; a DNS or TLS
   error means the domain is not connected yet), and
   `scripts/publish-downloads.sh --version 0.1.0 --from-release --dry-run` (after §4 step 5) lists every file as
   "not there yet".

---

## 2. Deploying the relay [owner]

The shared relay is the Cloudflare Custom Domain **app.smurg.ai** of the Worker `smurg-relay`. The top level of
`apps/relay/wrangler.jsonc` says so, and it is exactly what runs in production:

```jsonc
"workers_dev": false,                                            // no smurg-relay.<subdomain>.workers.dev
"routes": [{ "pattern": "app.smurg.ai", "custom_domain": true }],
"preview_urls": false,
"vars": { "RELAY_ISSUER": "https://app.smurg.ai", "ALLOWED_ORIGINS": "https://app.smurg.ai", … }
```

On deploy, wrangler attaches the custom domain to the Worker (DNS record and certificate in the `smurg.ai` zone).
wrangler, as the script runs it (`CI=true`), does not ask before it takes a hostname over, so before deploying the
script checks who answers at the hostname and stops unless nothing does yet or it is already a smurg relay;
`--take-over-hostname` deploys anyway. `env.dev` sets `"routes": []`.

**Zone settings** (dashboard, zone `smurg.ai`, once; they apply to every hostname of the zone: the relay, the site
and the downloads):

- **SSL/TLS → Edge Certificates → Always Use HTTPS: on** (since 2026-10-01; checked live: `http://smurg.ai/`,
  `http://www.smurg.ai/zh-TW/x?q=1` and `http://app.smurg.ai/healthz` answer 301 to the same https URL). The static
  pages of both Workers also send `Strict-Transport-Security: max-age=31536000` (`apps/site/public/_headers`,
  `apps/web/public/_headers`); `--check` requires `http://app.smurg.ai/healthz` to redirect to https.
- **Rules → Redirect Rules: `www.smurg.ai` → `https://smurg.ai/<path>`**, 301, query kept (done 2026-10-01, §4.1).
- **Keep Bot Fight Mode off, Security Level below "I'm Under Attack", and add no WAF rule that challenges
  `app.smurg.ai` or `downloads.smurg.ai`.** The CLI, the daemon and `curl … | sh` are not browsers and cannot solve a
  challenge. `--check` fails with the reason when Cloudflare answers instead of the relay (a `cf-mitigated` header).

```sh
cd <repo> && source scripts/env.sh
scripts/deploy-relay.sh --dry-run                       # web build, config checks, wrangler deploy --dry-run; no account contact
scripts/deploy-relay.sh                                 # deploy (after §1.2 and RELAY_SIGNING_KEY from §1.4); ends with 「完成」
scripts/deploy-relay.sh --check https://app.smurg.ai    # any time later: the outside checks only
```

Deploy from a clean checkout of the commit you mean (`git status` clean): the web app is built from the working tree,
and the live one must be the build of a known commit (§4 step 3). The script builds the web app and the relay, checks
the production configuration, checks who answers at `app.smurg.ai`, runs `wrangler deploy --env ""`, and refuses to
call it done unless wrangler's deploy output names exactly `app.smurg.ai (custom domain)` and no workers.dev hostname
and every outside check passes. `--google-client-id <id>` writes `GOOGLE_CLIENT_ID` into `apps/relay/wrangler.jsonc`
(commit it). It never logs in and never puts or reads a secret: it prints the command and stops with exit 3 when the
owner has to act. Details: `apps/relay/README.md`, 「部署到 Cloudflare」 (maintainers only: the relay's source is
private, so no one else deploys one).

History: the shared relay started on 2026-10-01 at `https://smurg-relay.gclin-ian.workers.dev` (the script's first
run against the account) and moved the same day to `https://app.smurg.ai` with one plain `wrangler deploy` from a
copy whose top level equals the committed `apps/relay/wrangler.jsonc`; the old hostname answers 404. No release had
been published, so no `smurg` binary carries the old address. A CLI that logged in to the old origin keeps choosing
it: run `smurg login --relay https://app.smurg.ai` once.

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
curl -sS -o /dev/null -w '%{http_code}\n' https://smurg-relay.gclin-ian.workers.dev/healthz   # 404: workers.dev stays off
```

The first time on a new address: open `https://app.smurg.ai` (only 「使用 Google 登入」); `smurg login --relay
https://app.smurg.ai`; `smurg host` a throw-away folder; join with a second Google account in another browser profile
(§10 items 9 and 11: the web app live on 2026-10-01 is the build of 7a690c9, which refuses the `channel.welcome` of a daemon
from cb99aa0 or later, so redeploy first, §4 step 3).

Good to know: **every deploy disconnects every WebSocket** (relay.md gotcha 9; clients reconnect within seconds, a
class notices: deploy outside working hours); `wrangler.jsonc`'s `migrations` are only ever appended to; relay logs:
`pnpm --filter @smurg/relay exec wrangler tail` (never content); usage: Workers & Pages → smurg-relay → Metrics.

## 3. The shared relay's address in the repository [lead]

Done 2026-10-01 for `https://app.smurg.ai`. The address appears in these places, and they must agree:

- `DEFAULT_RELAY_URL` in `packages/cli/src/relay/default-relay.ts`, on one line of exactly the shape
  `export const DEFAULT_RELAY_URL: string | null = 'https://<host>';` (`packages/cli/test/default-relay.test.ts`;
  `apps/relay/test/config.test.ts` checks that it equals `RELAY_ISSUER`);
- `apps/relay/wrangler.jsonc` (`routes`, `RELAY_ISSUER`, `ALLOWED_ORIGINS`, §2);
- the user docs: README.md, docs/HOSTING.md, docs/JOINING.md, and `CHANGELOG.md`;
- the product page, both languages (`apps/site/public`).

The placeholder `<RELAY_URL>` must never come back into the user docs. The release workflow refuses a tag while
`DEFAULT_RELAY_URL` is not an https origin, while a user doc does not name it, while a placeholder is left, or while a
user doc or the version's CHANGELOG section names a concrete `*.workers.dev` address other than `DEFAULT_RELAY_URL`
(§4). **Tag a release only with the final address**: a release keeps its default relay forever. Changing it later is
expensive (every released `smurg`, every stored login and invite link, the Google client). Do not change it again.

## 4. Cutting a release

Who: the lead prepares and tags; the owner redeploys the relay (and later the site); the owner or the lead publishes
(they need the repository's wrangler login, §1.2, and a gh login with access to the private repository).

1. **[lead]** `main` is green in CI, `source scripts/env.sh && pnpm check` is green locally, and
   `actionlint .github/workflows/*.yml` (with shellcheck on PATH) is clean: not run for the 2026-10-01 changes.
2. **[lead]** `CHANGELOG.md`: the section `## [X.Y.Z] - YYYY-MM-DD` (for 0.1.0: replace `Unreleased` with the date),
   written for hosts and members. It is published at `https://smurg.ai/docs/changelog/` and becomes the private
   release's notes. For a later version also set `"version": "X.Y.Z"` in all eight `package.json` files. Commit, then
   check what the workflow's first job will check:

   ```sh
   scripts/release-assets.sh --version X.Y.Z --publish-checks
   ```

   It refuses (and a tag push fails before any build) while: the section is missing or not dated; `<RELAY_URL>` or
   `<account-subdomain>` is left in the section or in README.md / docs/HOSTING.md / docs/JOINING.md;
   `DEFAULT_RELAY_URL` is not an https origin or one of those three docs does not name it; one of them does not show
   `curl -fsSL https://smurg.ai/install.sh | sh`; one of them or the section names a concrete `*.workers.dev` address
   other than `DEFAULT_RELAY_URL`; **anything users read links to the private repository** (`github.com/gclinian/smurg`
   or `github.com:gclinian/smurg`, any case, in those three docs, the section, `apps/site/public/`, or the web app's
   `index.html`, `src/` and `public/`); **`LICENSE` still says `<COPYRIGHT HOLDER>`** (the owner names the holder:
   `docs/OPEN-QUESTIONS.md` Q14) or is still the Apache License; a `package.json` says another version, or not
   `"license": "UNLICENSED"`, or not `"private": true`. Optional: Actions → Release → Run workflow (version X.Y.Z) is a
   dry run of the whole pipeline (about 35 billed minutes, §8.1) that records nothing and keeps the notes,
   `SHA256SUMS`, `install.sh` and the notices as an artifact (there the `--publish-checks` step only warns).
3. **[owner]** Redeploy the shared relay from the commit you are about to tag (a clean checkout of it), §2:

   ```sh
   scripts/deploy-relay.sh                                 # ends with 「完成」: every outside check passed
   scripts/deploy-relay.sh --check https://app.smurg.ai    # later, from the same checkout: 「全部通過」
   ```

   Why: `app.smurg.ai` serves the one web app that every host's guests and console use, whatever version the host
   runs. It decodes each daemon's `channel.welcome` and settings with strict schemas (ARCHITECTURE §5), so a web app
   older than the daemon refuses it, while a newer one accepts older daemons. The web app must therefore be at least as
   new as the release before anyone can install the release. If the workflow fails and you tag a fixed commit
   instead, redeploy from that one.
4. **[lead]** Tag and push the tag:

   ```sh
   git tag -a vX.Y.Z -m "smurg X.Y.Z"
   git push origin vX.Y.Z
   ```

5. **[lead]** Watch the release workflow (`gh run list --limit 5`, then `gh run watch <run id>`, in a shell without
   `scripts/env.sh`, §1.1). Each build runs `scripts/build-sea.sh --version X.Y.Z --target <platform>-<arch>`
   (including the smoke test on that platform); the last job requires the four builds' notices to be identical, runs
   `scripts/release-assets.sh`, creates a draft release in the private repository with the seven files, checks the
   uploaded list and only then publishes it as the record. If that job fails after creating the draft, delete the draft
   on the Releases page and "Re-run failed jobs" (it refuses to continue while any release for the tag exists). If the
   notices differ (another Node.js release came out during the run), re-run all jobs. The job summary prints the
   commands of step 7.
6. `gh release view vX.Y.Z --repo gclinian/smurg`: seven files (`smurg-darwin-arm64`, `smurg-darwin-x64`,
   `smurg-linux-x64`, `smurg-linux-arm64`, `SHA256SUMS`, `install.sh`, `THIRD-PARTY-NOTICES.txt`). Nothing is public yet.
7. **[owner or lead] Publish.** From a checkout with the repository's wrangler login (§1.2), and once the bucket exists
   (§1.5):

   ```sh
   cd <repo> && source scripts/env.sh
   scripts/publish-downloads.sh --version X.Y.Z --from-release --dry-run   # checks the files and what is there; uploads nothing
   scripts/publish-downloads.sh --version X.Y.Z --from-release             # ends with "done: smurg X.Y.Z is on …"
   scripts/publish-downloads.sh --check --version X.Y.Z                    # as people get it; "all checks passed"
   ```

   What it does (every rule in `scripts/publish-downloads.ts`):
   1. takes the private release's seven files with your gh login (`gh release view` must say it is not a draft, then
      `gh release download`; or `--dist DIR`, a directory `scripts/release-assets.sh --out` wrote, §4.3);
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
   6. uploads `vX.Y.Z/` with `wrangler r2 object put smurg-downloads/<key> --file … --remote --content-type …
      --cache-control "public, max-age=31536000, immutable"`: the executables (`application/octet-stream`), then
      `THIRD-PARTY-NOTICES.txt`, `install.sh` and `SHA256SUMS` last (`text/plain; charset=utf-8`; the installer reads
      `SHA256SUMS` first, so a version cut short refuses to install instead of half-working);
   7. reads every file back through `https://downloads.smurg.ai` (past any edge cache) and compares its sha256; a
      wrong Content-Type or Cache-Control is a warning. **Any failure stops here, and `latest/` is not touched**;
   8. only then uploads `latest/install.sh` (the version's own `install.sh`) and `latest/VERSION`
      (`Cache-Control: public, max-age=300`), reads them back, says whether the plain URLs already serve them (the
      edge may hold the previous ones for up to five minutes), and checks that `https://smurg.ai/install.sh` answers
      302 to `https://downloads.smurg.ai/latest/install.sh` and that `https://smurg.ai/third-party-notices.txt` is
      this version's file (warnings until the site is redeployed with them, step 8).

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
     either **[owner]** deletes only the mismatching objects, which the error message lists,
     `pnpm --filter @smurg/relay exec wrangler r2 object delete smurg-downloads/vX.Y.Z/<file> --remote` (a bucket
     lock, §1.5, must be lifted first), and runs the same command again with `--resume`; or the number is used up:
     cut X.Y.(Z+1). (Until `latest/` names the version, only someone who knows its pinned
     `https://downloads.smurg.ai/vX.Y.Z/install.sh` can install from it.)
8. **[owner]** Redeploy the product page from the tagged commit **with the release's notices** (§4.1 "At every
   release"): its docs and changelog are the release's, and its `/third-party-notices.txt` must be the release's file
   byte for byte. `scripts/publish-downloads.sh --check` then reports no warning about smurg.ai.
9. Verify the install on clean machines (§5) before announcing.

If the workflow fails before anything is published, fix the cause, delete the tag
(`git push --delete origin vX.Y.Z && git tag -d vX.Y.Z`), delete the private draft or record if one was made, and tag
the fixed commit again. After step 7, never: cut X.Y.(Z+1).

### 4.1 Deploying the product page smurg.ai [owner]

`apps/site` (details and the full list of checks: `apps/site/README.md`) is the Worker `smurg-site` with the one custom
domain `smurg.ai`, on the same account and zone as the relay. Its build renders `docs/HOSTING.md`, `docs/JOINING.md`
and `CHANGELOG.md` to `/docs/`, `LICENSE` to `/license/` and the executables' notices to `/third-party-notices.txt`. A
deploy build refuses a `LICENSE` that still says `<COPYRIGHT HOLDER>`, and refuses to run unless
`SMURG_SITE_THIRD_PARTY_NOTICES` names the notices file to publish, with its Node.js section filled in: the executables
embed the LICENSE of the Node.js the release workflow used (setup-node `check-latest`: 22.23.x in the dry run), not of
the Node.js on the deploying machine (22.22.1 on the lead's Mac), so a default would publish other notices than
`https://downloads.smurg.ai/vX.Y.Z/THIRD-PARTY-NOTICES.txt`. Its Worker answers only `/install.sh`: 302 to
`https://downloads.smurg.ai/latest/install.sh`. It never serves the script itself. **Never deploy with
`SMURG_SITE_ALLOW_PLACEHOLDER=1`** unless the owner decided on the interim deploy below.

**Now, before the release (urgent).** The live site (deployed 2026-10-01 from `cb99aa0`, before this decision) says
smurg is "open source under the Apache License 2.0" (English and Traditional Chinese, eyebrow, section, meta
description), links the private repository, and redirects `/install.sh`, `/github` and `/docs` to GitHub. That claim
must not stay up until the release: redeploy as soon as the owner has named the copyright holder in `LICENSE` and
`NOTICE` (Q14; a commit by the lead), from that commit, **right after the relay redeploy of §10 item 9** (the site's
pages link `https://app.smurg.ai/third-party-notices.txt`, which only a relay deployed from this tree serves). There
is no release's notices file yet, so publish this machine's (named explicitly; it is replaced at the release):

```sh
cd <repo> && source scripts/env.sh                            # a clean checkout of the commit that names the holder
pnpm --filter @smurg/site exec wrangler whoami                # the account holding smurg.ai (CLOUDFLARE_ACCOUNT_ID=<id> with several)
node scripts/third-party-notices.ts --executable --out /tmp/smurg-notices.txt     # this machine's Node.js LICENSE filled in
SMURG_SITE_THIRD_PARTY_NOTICES=/tmp/smurg-notices.txt pnpm --filter @smurg/site run dry-run      # the build + wrangler deploy --dry-run
SMURG_SITE_THIRD_PARTY_NOTICES=/tmp/smurg-notices.txt WRANGLER_SEND_METRICS=false pnpm --filter @smurg/site exec wrangler deploy
```

Until a release is published, `/install.sh` then redirects to `https://downloads.smurg.ai/latest/install.sh`, which
fails (the name does not resolve before §1.5, then 404): no worse than today's redirect to the private repository.
If naming the holder takes long, the owner may decide on an **interim deploy** with the placeholder, adding
`SMURG_SITE_ALLOW_PLACEHOLDER=1` to both commands above: `/license/` then shows "Copyright (c) 2026 <COPYRIGHT
HOLDER>", which is still better than a false open-source claim; redeploy again once the holder is named.

**At every release** (§4 step 8), from the tagged commit, after the release's files are on downloads.smurg.ai, with
the release's own notices:

```sh
cd <repo> && source scripts/env.sh                            # a clean checkout of the tag vX.Y.Z
curl -fsSLo /tmp/smurg-vX.Y.Z-notices.txt https://downloads.smurg.ai/vX.Y.Z/THIRD-PARTY-NOTICES.txt
#   (before publishing, from the private record, in a shell WITHOUT scripts/env.sh, §1.1:
#    gh release download vX.Y.Z --repo gclinian/smurg --pattern THIRD-PARTY-NOTICES.txt --dir /tmp/smurg-vX.Y.Z)
SMURG_SITE_THIRD_PARTY_NOTICES=/tmp/smurg-vX.Y.Z-notices.txt pnpm --filter @smurg/site run dry-run
SMURG_SITE_THIRD_PARTY_NOTICES=/tmp/smurg-vX.Y.Z-notices.txt WRANGLER_SEND_METRICS=false pnpm --filter @smurg/site exec wrangler deploy
scripts/publish-downloads.sh --check --version X.Y.Z          # no warning about smurg.ai's install.sh or third-party-notices.txt
```

**Never add `www.smurg.ai` as a custom domain** (`apps/site/test/config.test.ts` asserts the apex-only route list):
`www.smurg.ai` is the owner's own proxied DNS record, which the zone's Redirect Rule needs, and wrangler run after
`source scripts/env.sh` replaces an existing record without asking (§2). After every deploy:

```sh
curl -s https://smurg.ai/ https://smurg.ai/zh-TW/ | grep -Eci 'open source|apache|開源|開放原始碼'   # 0
curl -s https://smurg.ai/ https://smurg.ai/zh-TW/ | grep -ci 'gclinian'                           # 0
curl -sI https://smurg.ai/github               # 404 (no link to the repository any more)
curl -sI https://smurg.ai/install.sh           # 302 to https://downloads.smurg.ai/latest/install.sh
curl -fsSIL https://smurg.ai/install.sh        # follows it: the LAST status line is 200 once a release is published
curl -sI https://smurg.ai/docs/hosting/        # 200
curl -sI https://smurg.ai/license/             # 200, the named holder
cmp <(curl -fsS https://smurg.ai/third-party-notices.txt) /tmp/smurg-vX.Y.Z-notices.txt   # at a release: identical
```

### 4.2 Checking a published release later [owner or lead]

`scripts/publish-downloads.sh --check` (no account needed) checks the version `latest/VERSION` names, or `--version
X.Y.Z` any published one, through the plain public URLs: `SHA256SUMS`, every executable's sha256 and `file` type, this
machine's `--version`, `install.sh`'s download location, the notices, the headers (warnings), `latest/` (when it is
that version: `latest/install.sh` identical to the version's), and the smurg.ai redirect. It downloads the four
executables (about 480 MB).

### 4.3 linux-arm64 without GitHub's arm64 runner (contingency) [lead]

Dry run 36846007788 (2026-10-01) showed that `ubuntu-24.04-arm` runs for this private repository (image
`ubuntu-24.04-arm 20260920.129.1`, picked up at once, the job took 28 s). Should a release's `smurg-linux-arm64` job
ever sit queued instead (GitHub can change which runners private repositories get; a queued job waits up to 24 hours
and its `timeout-minutes` does not start), build that one target on an arm64 Ubuntu 24.04 machine (the lead's Lima VM
`smurg-linux` is one) and publish from a local directory:

1. Cancel the run (`gh run cancel <run id>`) once the other three builds are green, and download what they built:
   `gh run download <run id> --repo gclinian/smurg --dir /tmp/smurg-vX.Y.Z --pattern 'smurg-*' --pattern 'notices-*'`.
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

3. On the Mac: put the four executables in one directory with the notices, check the notices are identical
   (`cmp`), assemble (`release-assets.sh` also refuses an executable that is not this version's build or not on the
   notices' Node.js) and record:

   ```sh
   D=/tmp/smurg-vX.Y.Z; mkdir -p $D/dist
   cp $D/smurg-*/smurg-* <the arm64 build> $D/dist/ && cp $D/notices-linux-x64/THIRD-PARTY-NOTICES.txt $D/dist/
   cmp $D/dist/THIRD-PARTY-NOTICES.txt <the arm64 build's THIRD-PARTY-NOTICES.txt>
   scripts/release-assets.sh --version X.Y.Z --dist $D/dist --out $D/release --require-all --check-arch --notes $D/notes.md
   gh release create vX.Y.Z --repo gclinian/smurg --verify-tag --title "smurg X.Y.Z" --notes-file $D/notes.md $D/release/*   # the private record (no env.sh in this shell, §1.1)
   scripts/publish-downloads.sh --version X.Y.Z --dist $D/release
   ```

The workflow itself has no switch for this (none was needed: the runner was there at once in 36846007788); if it is
ever needed twice, compute the build matrix in the `prepare` job and skip the target with a repository variable (the
release job and `--from-release` then need the externally built file, so this path, `--dist`, stays the one to use).

### 4.4 Rehearsing a publish without Cloudflare [owner or lead]

To try the runbook (or a release's files) before the bucket exists, run the real command against stand-ins on this
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

## 5. Checking the one-line install on a clean machine [owner or lead]

**Before publishing** (or to try a private release without publishing it), install from a local copy of the
release's files:

```sh
gh release download vX.Y.Z --repo gclinian/smurg --dir /tmp/smurg-vX.Y.Z            # a shell without scripts/env.sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory /tmp/smurg-vX.Y.Z &          # stop it afterwards
sh /tmp/smurg-vX.Y.Z/install.sh --base-url http://127.0.0.1:8000 --prefix /tmp/smurg-try
/tmp/smurg-try/bin/smurg --version                                                   # smurg X.Y.Z (…)
```

**After publishing**, time SPEC R1.1 on a fresh macOS and a fresh Ubuntu 24.04 (a new macOS user account is the
cheapest fresh Mac; a new VM or cloud instance for Ubuntu, with a desktop for the browser login or over SSH with the
port-forward line `smurg login` prints):

1. Start a timer. `curl -fsSL https://smurg.ai/install.sh | sh` (on a second machine also try the version's own line,
   `curl -fsSL https://downloads.smurg.ai/vX.Y.Z/install.sh | sh`).
2. Add `~/.local/bin` to `PATH` as the installer says; open a new terminal.
3. `smurg login` (Google), then `smurg host <a folder>`. Stop the timer when the invite link is printed (R1.1: under 3
   minutes).
4. Check: `smurg --version` is the tag; `smurg licenses` prints the license and the notices; macOS:
   `xattr -l ~/.local/bin/smurg` shows no `com.apple.quarantine`; Ubuntu: the installer offered bubblewrap / socat /
   ripgrep and the AppArmor profile, and `smurg host` printed 「客人沙盒：可用…」 afterwards.
5. Join from another machine's browser with another Google account; open a terminal session. On the Ubuntu host the
   guest gets 「我的 worktree」 only (ARCHITECTURE §11 D-14).
6. Record the times, machines and anything that went wrong in `docs/ACCEPTANCE.md` (R1.1, and R5 / R9 for Ubuntu).

## 6. Private source, public binaries [owner]

The repository stays private (decided 2026-10-01). Never change its visibility, never push it (or a fork, a mirror, a
gist of its files) anywhere public, and never attach source to the public downloads: `downloads.smurg.ai` carries
exactly the seven files of each version and `latest/`. What is public by design: the executables (they contain the
program), the web app's files on `app.smurg.ai`, the product page and the user docs on `smurg.ai`, `LICENSE` and the
third-party notices.

### 6.1 The license terms: not legal advice

`LICENSE` (proprietary: all rights reserved, free use of the executables and the web app during the prototype, no
redistribution, modification, decompiling or reverse engineering except where the law allows, "as is" without
warranty, third-party components under their own licenses) and the third-party notices were written by the project,
**not by a lawyer: this is not legal advice. Have `LICENSE` reviewed** by someone qualified for the owner's
jurisdiction before the first public release, in particular:

- the copyright holder: the placeholder `<COPYRIGHT HOLDER>` must be replaced (`LICENSE` and `NOTICE`);
  `scripts/release-assets.sh --publish-checks` and the site's deploy build refuse it;
- the "free of charge while smurg is a prototype" grant (what happens after the prototype; how long a version's grant
  lasts);
- the reverse-engineering clause (EU and Taiwanese law allow some reverse engineering, for example for
  interoperability) and the warranty disclaimer (consumer law may limit it);
- the third-party notices: every bundled package's LICENSE and NOTICE files are reproduced (generated,
  `scripts/third-party-notices.ts`; the Apache-2.0 `@anthropic-ai/sandbox-runtime` has no NOTICE file in 0.0.77), and
  the GNU C Library (LGPL-2.1+) statically linked into srt's `apply-seccomp` in the Linux executables: built on Ubuntu
  24.04, so glibc 2.39; whether LGPL's terms need more than the note in the notices (a written offer, the object code
  for relinking) is for the reviewer. The facts are collected in `docs/OPEN-QUESTIONS.md` Q14, which also holds the
  holder's name and the review.

## 7. Rolling back

**A bad release** (people should stop installing it): point `latest/` back at the previous good version. Nothing is
deleted or overwritten:

```sh
cd <repo> && source scripts/env.sh
scripts/publish-downloads.sh --set-latest X.Y.W --dry-run    # verifies vX.Y.W as published, says what latest/ would become
scripts/publish-downloads.sh --set-latest X.Y.W              # latest/install.sh = vX.Y.W/install.sh, latest/VERSION = X.Y.W
scripts/publish-downloads.sh --check                         # checks the version latest/ now names
```

`--set-latest` refuses a version that is not completely and correctly published, and a pre-release. Within five
minutes (`latest/`'s `max-age=300` at most) `https://smurg.ai/install.sh` installs the good version again; tell hosts
who installed the bad one to run the one-line command again (it replaces `~/.local/bin/smurg`). For the record, mark
the private GitHub release: `gh release edit vBAD --repo gclinian/smurg --prerelease`. **Never delete a published
version, and never reuse its number**: the next fix is X.Y.(Z+1), published normally (it becomes latest again because
it is newer).

The one case for removing files is a different emergency, the owner's decision: something that must not be public at
all ended up in a release file (a secret). Then `--set-latest` away from it first, delete only the affected objects
(`pnpm --filter @smurg/relay exec wrangler r2 object delete smurg-downloads/vX.Y.Z/<file> --remote`; a bucket lock,
§1.5, must be lifted first), rotate the secret, and keep the version number burned.

**A bad relay deploy**:

```sh
cd <repo> && source scripts/env.sh && cd apps/relay
pnpm exec wrangler versions list      # recent versions of the Worker
pnpm exec wrangler rollback <version-id> --message "why"
```

A rollback restores the Worker's code and configuration, not the Durable Objects' stored data, and like a deploy it
disconnects every socket. Its web app is rolled back too, and an older web app refuses the `channel.welcome` of a newer
daemon (§4 step 3): do not roll back past the version deployed for the latest release.

**Stopping the relay in an emergency** (a leaked signing key, abuse): Workers & Pages → smurg-relay → Settings →
Domains & Routes, remove the custom domain `app.smurg.ai`; put a new `RELAY_SIGNING_KEY`; then deploy again
(`scripts/deploy-relay.sh`), which attaches the custom domain again. `wrangler delete` also removes every Durable
Object's data; avoid it.

## 8. What the free plans allow

From Cloudflare's docs as fetched on 2026-09-27 (`docs/research/relay.md`; check the current pricing pages before
relying on the numbers). Daily limits reset at 00:00 UTC (08:00 in Taiwan). When one is used up, **operations of that
kind fail for everyone until the reset**: new connections and messages are refused (Error 1027), hosts see the relay
link drop, members see 「無法連上伺服器」.

| Limit (Workers Free) | Per day / total | What uses it in smurg |
|---|---|---|
| Worker requests | 100,000 / day | every login step, `/api/*` call, WebSocket upgrade. The web app's own files are static assets served without running the Worker. smurg.ai (§4.1) is on the same account: only its `/install.sh` redirect runs its Worker. `downloads.smurg.ai` is R2, not a Worker: it uses none. |
| Durable Object requests | 100,000 / day | each WebSocket connection, each **alarm run**, and incoming WebSocket messages counted **20 : 1**. The `ping` heartbeats are answered by Cloudflare itself and cost nothing. |
| Durable Object rows written | 100,000 / day | each **alarm scheduled** (`setAlarm` is one row), plus a few rows when a host connects or disconnects and one per member connection |
| Durable Object duration | 13,000 GB-s / day | nearly nothing: the relay only uses the Hibernation API |
| Durable Object storage | 5 GB total | a few keys per workspace |
| CPU time per request | 10 ms | the Worker's login routes sign and verify tokens. **Not measured on Cloudflare.** If logins fail with Error 1102, this is why, and the Paid plan is the fix. |

**R2** (the downloads; its own free allowance per month, separate from Workers; check the R2 pricing page): storage
(each version is about 480 MB: four executables of 113–126 MiB), Class A operations (writes: a release is nine
uploads) and Class B operations (reads: each install is two GETs, `SHA256SUMS` and one executable, plus `install.sh`
from `latest/`), and **no egress fees**. Every version is kept forever, so storage grows by about 0.5 GB per release.

**What the relay limits mean in practice** (an estimate from the code; nothing was measured on Cloudflare): while at
least one browser or CLI is connected to a workspace, its WorkspaceDO alarm runs about every 5 s, **about 720 requests
and 720 rows written per workspace-hour**; the daemon's presence heartbeat is about **60 requests per member-hour**;
terminal output is the big one (a busy agent at 30 updates a second watched by 3 people is about 16,000 requests an
hour). So the alarm alone allows roughly 130 workspace-hours a day across all users; a class of 30 working at the same
time will likely hit the limit. Watch the usage daily in the first week; the **Workers Paid plan** removes the daily
caps (no code or configuration change).

### 8.1 GitHub Actions minutes (the repository is private)

On a private repository every job's minutes count against the plan's allowance (the account is on GitHub **Pro**:
3,000 minutes a month and 2 GB of Actions storage, as of this writing; check Settings → Billing and the GitHub
pricing page). Each job is rounded up to whole minutes, and **macOS minutes count 10×** (Linux 1×; confirm on the
billing page how the arm64 Linux runner is counted). Measured on GitHub, 2026-10-01:

| Run | Jobs (wall time) | Billed minutes, about |
|---|---|---|
| CI (`ci.yml`), each push to `main` or pull request | ubuntu-24.04 11–16 min; macos-15 4 min | 11–16 + 40–50 = **51–66** |
| Release or its dry run (`release.yml`; 36846007788) | prepare 5 s; linux-x64 33 s; linux-arm64 28 s; darwin-x64 67 s; darwin-arm64 24 s; release 13 s | 1 + 1 + 1 + 20 + 10 + 1 = **34**, plus a few seconds for the new notices steps |

So 3,000 minutes are roughly 45–55 CI runs a month, fewer with releases (about 35 each, a dry run costs the same).
CI cancels a superseded run on the same branch (`concurrency`); batching small commits saves the most. The build
artifacts (four executables, about 0.5 GB per release run, kept 7 days) count against the Actions storage. With the
budget at $0 (§1.1), Actions stop when the allowance is used up, until the next month.

## 9. Security notes

- **macOS**: the executables are signed ad hoc, not with a Developer ID, and not notarized. `curl` sets no quarantine
  attribute, and the installer removes one after the sha256 check, so Gatekeeper does not stop it. A binary downloaded
  with a browser and started by hand is blocked by Gatekeeper; the installer is the supported path.
- **Checksums** come from the same place as the executables (`downloads.smurg.ai`): they catch a corrupted or
  truncated download, not a compromised Cloudflare account, a compromised publishing machine or a compromised GitHub
  account (CI builds what is published). Protect both accounts (2FA), publish only from your own machine, keep the
  workflows' actions pinned to commit SHAs (only `actions/*`), and do not give other people write access casually.
  `publish-downloads.sh` re-checks the GitHub release's files before uploading and never overwrites a published file;
  a bucket lock (§1.5) would make that hold in R2 itself. A signature on `SHA256SUMS` with a key pinned in
  `install.sh` would close the remaining gap (still open, `docs/OPEN-QUESTIONS.md` Q1).
- **Secrets** live only in Cloudflare's secret store (`RELAY_SIGNING_KEY`, `GOOGLE_CLIENT_SECRET`), the owner's
  Google console, and the wrangler login in `<repo>/.xdg` of whoever publishes. **No workflow has a Cloudflare or
  Google secret**: the relay, the site and the downloads are deployed by hand.
- **What the relay operator can see**: account identities and IP addresses of connections, workspace ids, frame sizes
  and timing (ARCHITECTURE §11 D-5); `docs/HOSTING.md` §2 tells hosts the same in plain words, and that they cannot
  run a relay of their own (the source is private).

## 10. First-time checklist (this week)

In this order; the v0.1.0 release under the decision of 2026-10-01.

1. [x] **[lead]** `pnpm check` green; first commit reviewed (2026-10-01, commit 0b99dc8).
2. [x] **[owner]** Private repository `gclinian/smurg` (2026-10-01). Two-factor authentication: confirm (§1.1).
   Actions budget at $0: confirm (§1.1 step 4, §8.1).
3. [x] **[lead]** First CI run green, Linux included (2026-10-01, run 36779794102).
4. [x] **[owner]** Cloudflare account, `wrangler login` (§1.2); the zone `smurg.ai` (2026-10-01).
5. [x] **[owner]** `RELAY_SIGNING_KEY` and the first relay deploy (2026-10-01; on `https://app.smurg.ai` the same day).
6. [ ] **[owner]** Google OAuth client (done 2026-10-01); consent screen **In production** (confirm);
   `GOOGLE_CLIENT_SECRET` (§1.4).
7. [x] **[owner]** Zone settings (§2): Always Use HTTPS on (2026-10-01); Bot Fight Mode off (confirm); the www → apex
   Redirect Rule (2026-10-01).
8. [x] **[owner]** Copyright holder named: Guan-Chen, Lin (2026-10-01, commit afc11bb). The legal review of the terms
   (§6.1) should follow before v0.1.0 is announced.
9. [x] **[lead]** `scripts/deploy-relay.sh` from the clean commit ac3335e (2026-10-01): its first custom-domain run,
   ended with 「完成」, `--check` 8 of 8 (web build, HSTS, `http://` → `https://`, `/third-party-notices.txt`).
10. [x] **[lead]** smurg.ai redeployed from afc11bb (2026-10-01): no "open source" / Apache / GitHub mention on the
    landing pages, `/github` 404, `/docs/…`, `/license/` and `/third-party-notices.txt` 200.
11. [ ] **[owner]** Real Google login from `smurg login` with the released executable; a second account joins a
    throw-away workspace.
12. [x] **[owner, lead]** R2 enabled by the owner; bucket `smurg-downloads` and custom domain `downloads.smurg.ai`
    (min TLS 1.2, r2.dev URL disabled) created by the lead (2026-10-01); a missing key answers 404, `http://` 301s.
13. [~] **[lead]** shellcheck 0.9.0 (Ubuntu package, in the Lima VM) on `scripts/*.sh`: no warning. actionlint not run
    (not packaged; nothing downloaded).
14. [x] **[lead]** `CHANGELOG.md` 0.1.0 dated 2026-10-01; `--publish-checks` passed; CI green on afc11bb (run
    36865310230); tag `v0.1.0` on afc11bb; release workflow 36867177426 green on all four runners; seven files on the
    private record.
15. [x] **[lead]** `scripts/publish-downloads.sh --version 0.1.0 --from-release`: dry run, then the upload; every file
    read back by sha256; `latest/` → 0.1.0; `--check` all passed (2026-10-01).
16. [x] **[lead]** `apps/site` redeployed from afc11bb with the release's notices (node 22.23.3); `--check` shows
    `https://smurg.ai/third-party-notices.txt = v0.1.0/THIRD-PARTY-NOTICES.txt`.
17. [ ] **[owner]** Timed one-line install on a clean Mac and a clean Ubuntu 24.04 (§5); **[lead]**
    `docs/ACCEPTANCE.md` R1.1 (and R5 / R9 if tested on Ubuntu) updated with the results.
18. [ ] **[owner]** Cloudflare usage (Workers, Durable Objects, R2) and GitHub Actions minutes checked daily for the
    first week (§8, §8.1).
