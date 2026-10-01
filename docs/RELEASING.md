# Releasing smurg

The runbook for the project owner and the project lead: one-time setup, deploying the shared relay, cutting a
release, deploying the product page, checking it, rolling back, and what Cloudflare's free plan allows. Nothing in the repository uploads, deploys
or signs anything by itself; every step that touches a GitHub or Cloudflare account is run by a person.

Steps marked **[owner]** need the owner's own accounts or secrets (nobody else ever sees the Google client secret or
the relay's signing key). Steps marked **[lead]** need the repository only.

Checked against the files on 2026-10-01 (release-verify): the workflows are linted (actionlint 1.7.12 with shellcheck
0.11.0); the release workflow has never run on GitHub (CI has: §1.1 step 5); the release files and the installer were
run end to end on macOS arm64 from a local server. Since then (2026-10-01) the repository is on GitHub (private) and
the shared relay is live: first deployed on workers.dev with `scripts/deploy-relay.sh`, then, the same day, moved to
the custom domain https://app.smurg.ai with a plain `wrangler deploy` (§2), where the owner logged in with Google. The
product page https://smurg.ai is live too (deployed 2026-10-01, before the first release, at the owner's request;
§4.1). The script's custom-domain path has not run against the account yet (§10). Everything else that touches a real GitHub,
Cloudflare or Google account happens for the first time when the owner follows this runbook.

## The plan (decided 2026-09-30, `docs/OPEN-QUESTIONS.md` Q1)

| What | Decision |
|---|---|
| Source | GitHub `gclinian/smurg`, created **private**, switched to **public** once a release is verified. License Apache-2.0. |
| Shared relay | One Worker (`smurg-relay`) on Cloudflare Workers, **free plan**, serving the relay and the web app at the Cloudflare Custom Domain **`https://app.smurg.ai`** (decided 2026-10-01; the zone `smurg.ai` is on the same Cloudflare account). Its workers.dev hostname is off: it was `https://smurg-relay.gclin-ian.workers.dev` until 2026-10-01 and answers 404 now. Invite links are `https://app.smurg.ai/join/<id>#…`. |
| Product page | `https://smurg.ai`: `apps/site`, a second Worker on the same account with static pages, the custom domain `smurg.ai` only; `www.smurg.ai` is redirected to it by a zone Redirect Rule, before any Worker. `/install.sh` is a 302 to the latest release's `install.sh` on GitHub. **Deployed 2026-10-01**, before the first release and while the repository is private, at the owner's request (§4.1): until the first release is published **and the repository is public** (§6), its install line and its links to the repository end in a 404. |
| Login | Google only, with an OAuth client the owner creates. GitHub login stays in the code (self-hosted relays can use it) but is not configured on the shared relay. |
| Builds | GitHub Actions on a tag `v*`, each target on its own runner: macOS Apple Silicon (`macos-15`), macOS Intel (`macos-15-intel`), Linux x64 (`ubuntu-24.04`), Linux arm64 (`ubuntu-24.04-arm`). The plan's `macos-14` / `macos-13` are not used: `macos-13` was retired on 2025-12-04 and `macos-14` is removed on 2026-11-02 (brownouts from 2026-10-05); `macos-15-intel` is GitHub's last x86_64 image, available until August 2027 (actions/runner-images #13046, #13518, #13045). The executables are copies of the official Node from `.nvmrc`, so the runner's macOS version does not limit where they run. |
| Signing | None from Apple: ad-hoc signature only. The installer verifies the sha256, then removes the quarantine attribute. |
| Downloads | GitHub Releases (R2 is not used). One line: `curl -fsSL https://smurg.ai/install.sh \| sh` (smurg.ai only redirects to the same file on GitHub; when smurg.ai is unreachable: `curl -fsSL https://github.com/gclinian/smurg/releases/latest/download/install.sh \| sh`). The installer itself downloads only from GitHub Releases and checks `SHA256SUMS`. |
| First version | v0.1.0 |

## 0. What is where

| Piece | Where | Verified so far |
|---|---|---|
| Single executable (Node SEA: CLI + daemon + native parts) for the platform it is built on | `scripts/build-sea.sh [--node <node>] --version X.Y.Z [--target <platform>-<arch>]` → `packages/cli/dist/smurg-<platform>-<arch>`; checks that it runs (`--version`), prints its sha256, runs the smoke test `packages/cli/test/sea.test.ts`. `--target` refuses a runner or a Node of another platform/arch; the tag form `--version v0.1.0` is accepted | built and smoke-tested on macOS arm64 only (10.5 s, 3/3 on 2026-10-01) |
| Release files | `scripts/release-assets.sh --version X.Y.Z --base-url https://… [--dist DIR] [--out DIR] [--require-all] [--check-arch] [--notes FILE] [--changelog FILE]` → `<out>/{smurg-*, SHA256SUMS, install.sh}` (default `packages/cli/dist/release/X.Y.Z`): copies the executables with mode 0755, checks with `file` that each is the Mach-O / ELF its name says, runs this machine's and requires exactly `smurg X.Y.Z (…`, fills the base URL into `install.sh`, writes the release notes (the CHANGELOG section with relative links pointed at the tag, the install commands, the checksums). Two check-only modes run before any build: `--check-changelog` (a section exists) and `--publish-checks` (§4) | run end to end on macOS arm64 on 2026-10-01: the real arm64 executable plus header-only stand-ins for the other three, exactly as `release.yml` calls it |
| Installer | `scripts/install.sh`: picks darwin/linux × arm64/x64 (glibc; Rosetta shells get arm64), downloads `SHA256SUMS` and then the executable, installs `~/.local/bin/smurg` only when the sha256 matches (https only; http only for 127.0.0.1 / localhost); macOS: removes `com.apple.quarantine` after the sha256 matched and before the first run; Linux: bubblewrap / socat / ripgrep and the Ubuntu 24.04+ AppArmor profile for `/usr/bin/bwrap`, only with consent | `packages/cli/test/install-script.test.ts` (36 tests, every OS/arch through a faked `uname`, under sh and dash); on 2026-10-01 the assembled `install.sh` installed the real executable from 127.0.0.1 as `curl … \| sh` (sh and dash) with a downloader that quarantines what it saves: quarantine removed, ad-hoc signature intact, `--version` right; a wrong hash, a truncated file, a missing executable and a missing `SHA256SUMS` each refused, with the previous install left alone. The Linux branch ran only against stand-ins. |
| Release workflow | `.github/workflows/release.yml`, on a tag `v*`: a `prepare` job (tag format, `--check-changelog`, `--publish-checks`), four builds (`build-sea.sh --version X.Y.Z --target …` on `macos-15`, `macos-15-intel`, `ubuntu-24.04`, `ubuntu-24.04-arm`), then `release-assets.sh --require-all --check-arch --notes` with `--base-url https://github.com/gclinian/smurg/releases/download/vX.Y.Z`, a **draft** GitHub release with the six files, a check of the uploaded asset list, and only then publish (Latest; a version with a `-` part is a pre-release). Only the release job has `permissions: contents: write`; actions are pinned to commit SHAs. A manual run (Actions → Release → Run workflow) is a dry run that publishes nothing | not run on GitHub yet (it cannot run locally); actionlint + shellcheck clean |
| CI | `.github/workflows/ci.yml`: `pnpm check` on `macos-15` and `ubuntu-24.04` for pushes to `main`, pull requests and manual runs; the Ubuntu job installs bubblewrap, socat, ripgrep and the same AppArmor profile as the installer (manual input `linux-userns = sysctl` lifts the restriction machine-wide instead); the log is uploaded as `pnpm-check-<os>` on failure | green on GitHub, both jobs (run 36779794102, 2026-10-01, §1.1 step 5); actionlint + shellcheck clean |
| Relay deploy | `scripts/deploy-relay.sh` (production build of web + relay, then `wrangler deploy` of the top level of `apps/relay/wrangler.jsonc`: `https://app.smurg.ai` as a Cloudflare Custom Domain with workers.dev off, Google only, dev login off). It deploys exactly one of two shapes and refuses anything else: one custom domain (`"workers_dev": false`, one route `{ "pattern": "<host>", "custom_domain": true }`, `RELAY_ISSUER` = `ALLOWED_ORIGINS` = `https://<host>`: the shared relay) or workers.dev (`"workers_dev": true`, no routes: a self-hosted relay's default). Before deploying to a custom domain it stops when the hostname already answers as something other than a smurg relay (wrangler, as the script runs it, would take the hostname over without asking; `--take-over-hostname`). `--dry-run` never contacts the account; `--check <url>` checks a deployed relay from outside, including that the live web app is this checkout's build and, on a custom domain, that `http://` redirects to `https://` | Both shapes against a fake wrangler (`apps/relay/test/deploy-relay.test.ts`; wrangler 4.142's output formats and its custom-domain takeover checked against its source); `--dry-run` green on 2026-10-01 inside a sandbox that denied all outbound network (before the custom-domain shape existed). Against the real account, 2026-10-01: the workers.dev shape (the first deploy of the shared relay). `https://app.smurg.ai` was deployed by the lead the same day with `wrangler deploy` from a copy whose top level equals the committed `apps/relay/wrangler.jsonc` (the script of that day accepted only workers.dev), so the script's custom-domain path runs against the account for the first time at the next shared-relay deploy (§10). Outside checks of the live relay: §10 item 8 |
| CLI default relay | `DEFAULT_RELAY_URL` in `packages/cli/src/relay/default-relay.ts`: `'https://app.smurg.ai'`, used when there is no `--relay`, no `SMURG_RELAY_URL` and no earlier login (`smurg attach` first takes the invite link's origin or the relay it joined through). `null` would mean no default (the CLI refuses and asks for `--relay`). Invite links are built on the relay's origin, so they are `https://app.smurg.ai/join/…` (§3) | unit tests (`packages/cli/test/default-relay.test.ts`); `apps/relay/test/config.test.ts` checks that it equals the `RELAY_ISSUER` of `apps/relay/wrangler.jsonc` |
| Product page | `apps/site` (`apps/site/README.md`): smurg.ai as the one custom domain of the Worker `smurg-site` (never www: that is the zone Redirect Rule); deployed by hand (§4.1) | `pnpm check` (redirects, config, the site in a local workerd, links, a `wrangler deploy --dry-run`). Deployed 2026-10-01 from `cb99aa0` with the apex-only routes now committed; checked live the same day (§4.1) |
| Release notes | `CHANGELOG.md`: one `## [X.Y.Z] - YYYY-MM-DD` section per version; the release workflow puts that section into the GitHub release (`scripts/release-assets.sh --notes`) and refuses a tag without one | run locally on 2026-10-01 (notes of a `0.1.0-test` build) |

---

## 1. One-time setup

### 1.1 GitHub repository [lead, then owner]

The project folder is not under git yet. The lead makes the first commit; the owner creates the private repository
with their own `gh`.

1. **[lead]** From the repository root: `source scripts/env.sh && pnpm check` is green.
2. **[lead]** `git init -b main && git add -A`, then check what would be committed:
   - `git status --short | grep -E '\.dev\.vars$|(^|/)\.xdg/|(^|/)\.tools/|node_modules/|credentials\.json|\.pem$'` prints nothing
     (`apps/relay/.dev.vars` holds a local signing key; `.xdg/` holds wrangler's login once the owner has run §1.2);
   - `git status --short | wc -l` is under a thousand (about 840 files on 2026-09-30), not tens of thousands (no
     `node_modules`, `dist`, `.tools`).
   Then `git commit -m "smurg 0.1.0 prototype"`.
3. **[owner]** `gh repo create gclinian/smurg --private --source=. --remote=origin --push`
4. **[owner]** On GitHub: Settings → Actions → General: Actions allowed (the default for a new repository). The release
   workflow needs to create releases; its release job declares `permissions: contents: write` itself, so the default
   workflow permissions can stay read-only, and no repository secret is needed. Turn on two-factor authentication for
   the account if it is not on: whoever controls the account controls what the one-line install downloads.
5. **[lead]** Watch the first CI run (`gh run list`, `gh run watch`). It is the first time anything runs on Linux:
   expect failures there and triage them before tagging (see `docs/OPEN-QUESTIONS.md` Q2 for what CI covers). Done
   2026-10-01: the first Linux run failed 27 tests; after the fixes both jobs are green (run 36779794102,
   `docs/ACCEPTANCE.md` "Linux verification").

### 1.2 Cloudflare account and wrangler [owner]

1. Create a Cloudflare account (free plan). In the dashboard, open **Workers & Pages**; the first visit asks for the
   account's **workers.dev subdomain** (any; the shared relay does not use it any more). Add the domain **smurg.ai** to
   the same account as a zone (Cloudflare's nameservers at the registrar, status Active): the shared relay is the
   Custom Domain `app.smurg.ai` of that zone and the product page is the Custom Domain `smurg.ai`, with
   `www.smurg.ai` redirected to it by a zone Redirect Rule (§2, §4.1). Done 2026-10-01. Every released `smurg`
   carries `https://app.smurg.ai` as its default relay, and every invite link starts with it, so the address must not
   change again (§3).
2. Log wrangler in, from the repository (wrangler is a dependency of `apps/relay`, not a global install;
   `scripts/env.sh` sets `XDG_CONFIG_HOME=<repo>/.xdg`, so wrangler keeps its login in `<repo>/.xdg/`, which is
   gitignored; relay.md gotcha 16):

   ```sh
   cd <repo> && source scripts/env.sh
   CI=false pnpm --filter @smurg/relay exec wrangler login     # opens your browser; CI=true (env.sh) makes wrangler non-interactive
   pnpm --filter @smurg/relay exec wrangler whoami             # shows the account
   ```

   `wrangler logout` (same prefix) removes the login. Never copy `.xdg/` anywhere.

### 1.3 Google OAuth client [owner only]

The redirect URI below contains the relay's address, `https://app.smurg.ai` (known up front for a custom domain; a
self-hosted relay on workers.dev learns it from its first deploy, `apps/relay/README.md`). Done 2026-10-01 for
`https://app.smurg.ai`.

In the Google Cloud console (a new project, e.g. "smurg"):

1. **OAuth consent screen** (called **Google Auth Platform → Branding / Audience** in newer consoles): user type
   **External**; app name "smurg"; support and developer contact e-mail; scopes `openid`, `email`, `profile` (the relay
   asks for nothing else). **Publishing status: In production.** In "Testing" only the test users you list can log
   in. With only these three scopes Google does not ask for an app review (Google's rule for non-sensitive scopes;
   the console says so if that changes).
   **Authorized domains** (Branding): `smurg.ai`, the registrable domain of the relay's host (Google accepts redirect
   URIs and JavaScript origins of a production app only under an authorized domain).
2. **Credentials → Create credentials → OAuth client ID** (or **Clients → Create client**): application type **Web
   application**; **Authorized JavaScript origins**: `https://app.smurg.ai`; **Authorized redirect URIs**:
   `https://app.smurg.ai/auth/google/callback`, exactly (`scripts/deploy-relay.sh` prints both). The CLI's login goes
   through the same callback (the relay then sends the browser on to `127.0.0.1`), so no loopback URI is registered
   (`apps/relay/README.md`). If the client still lists the workers.dev origin and redirect URI of the first deploy
   (2026-10-01), they can be removed: that hostname answers 404.
3. Note the **client ID** (public: it goes into the relay's production configuration) and the **client secret**
   (secret: only into `wrangler secret put` below; never into the repository, CI, a chat or an issue).

### 1.4 Relay secrets [owner only]

```sh
cd <repo> && source scripts/env.sh     # the same commands scripts/deploy-relay.sh prints
node apps/relay/scripts/signing-key.ts | pnpm --filter @smurg/relay exec wrangler secret put RELAY_SIGNING_KEY --env=""   # generated and piped: nobody sees it
CI=false pnpm --filter @smurg/relay exec wrangler secret put GOOGLE_CLIENT_SECRET --env=""                               # paste the client secret at the prompt
```

- Put `RELAY_SIGNING_KEY` **before the first deploy**: wrangler refuses to deploy a new Worker whose required secret
  is missing ("The following required secrets have not been set"), and `wrangler secret put` on a Worker that does not
  exist yet first creates an empty one of that name (`createDraftWorker`, which says yes by itself when it cannot ask).
  Both read in wrangler 4.142's source; not run against an account. `scripts/deploy-relay.sh` checks for the key and
  prints this command when it is missing.
- `CI=false` for the pasted secret: `scripts/env.sh` sets `CI=true`, under which wrangler cannot prompt. The piped
  signing key needs no prompt.
- `RELAY_SIGNING_KEY` signs relay sessions and identity tokens. It does not need a backup: if it is lost, put a new
  one and everyone logs in again. To rotate without logging everyone out, put `{"keys":[<new private JWK>, <old public
  JWK>]}` (`apps/relay/README.md`, 設定).
- `GITHUB_CLIENT_SECRET` is not set: GitHub login is then off (`/api/login-options` says `github: false`).

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

On deploy, wrangler attaches the custom domain to the Worker: Cloudflare creates the DNS record and the certificate for
`app.smurg.ai` in the `smurg.ai` zone (the zone must be on the same account). wrangler, as the script runs it
(`CI=true` from `scripts/env.sh`), does not ask before it takes a hostname over: an existing DNS record for
`app.smurg.ai`, or another Worker's custom domain there, would be replaced (wrangler 4.142, `publishCustomDomains`).
So before deploying, the script checks who answers at the hostname and stops unless nothing does yet or it is already
a smurg relay; `--take-over-hostname` deploys anyway. `env.dev` sets `"routes": []` so that `wrangler dev --env dev`
never takes over that hostname.

**Zone settings** (Cloudflare dashboard, zone `smurg.ai`, once; they apply to every hostname of the zone, the relay
included, which they did not on workers.dev):

- **SSL/TLS → Edge Certificates → Always Use HTTPS: on.** `*.workers.dev` was HTTPS-only in every browser (`.dev` is
  on the HSTS preload list); `app.smurg.ai` is not, so without this a browser that is given `app.smurg.ai` without a
  scheme may load the page over plain http, where anyone on the network can replace it (and the invite fragment a
  user then pastes into it). Logins over http fail closed (the `__Host-` Secure cookie, the https redirect URI, the
  Origin allow-list), the page itself does not. `--check` requires `http://app.smurg.ai/healthz` to answer 301 or 308
  to the same https URL. The same switch covers `smurg.ai` and `www.smurg.ai` (§4.1). **On since 2026-10-01**: it
  was off that morning (`http://app.smurg.ai/` and `http://smurg.ai/` answered 200 with the page) and the owner
  turned it on the same day; checked live: `http://smurg.ai/`, `http://www.smurg.ai/zh-TW/x?q=1` and
  `http://app.smurg.ai/healthz` answer 301 to the same https URL (query kept; www straight to the apex). The static
  pages of both Workers (`apps/site/public/_headers`, `apps/web/public/_headers`; the latter from the next relay
  deploy on, and the build check and `--check` require it on an https relay) send
  `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, no `preload`: a convention; the build check
  enforces only a `max-age` of at least a year). The Workers' own responses (the site's redirects, the relay's
  `/healthz`, `/api/*`, `/auth/*`) do not, and do not need to: one https visit to the host is enough. A browser only
  obeys it after one visit over https, so it complements this switch rather than replacing it; the zone-wide HSTS
  setting (same page) is optional on top (if Cloudflare then sends a second header next to `_headers`' one, `--check`
  judges the first, as browsers do; run it again after turning the setting on).
- **Rules → Redirect Rules: `www.smurg.ai` → `https://smurg.ai/<path>`**, 301, query string kept, with a proxied DNS
  record for `www.smurg.ai`. **Done 2026-10-01** (by the owner; §4.1).
- **Keep Bot Fight Mode off, Security Level below "I'm Under Attack", and add no WAF rule that challenges
  `app.smurg.ai`.** The CLI and the daemon are not browsers and cannot solve a challenge; the daemon's WebSocket
  upgrade sends no User-Agent at all. On 2026-10-01 none interfered (the WebSocket upgrade, a curl without a
  User-Agent and the script's checks all reached the relay). `--check` fails with the reason when Cloudflare answers
  instead of the relay (a `cf-mitigated` header).

```sh
cd <repo> && source scripts/env.sh
scripts/deploy-relay.sh --dry-run                       # web build, config checks, wrangler deploy --dry-run; no account contact
scripts/deploy-relay.sh                                 # deploy (after §1.2 and RELAY_SIGNING_KEY from §1.4); ends with 「完成」
scripts/deploy-relay.sh --check https://app.smurg.ai    # any time later: the outside checks only
```

Deploy from a clean checkout of the commit you mean (`git status` clean): the web app is built from the working tree,
and the live one must be the build of a known commit (§4 step 3).

`scripts/deploy-relay.sh` builds the web app and the relay, checks the production configuration (one custom domain,
workers.dev off, `RELAY_ISSUER` = `ALLOWED_ORIGINS` = `https://app.smurg.ai`, no preview URLs, Google only, dev login
off), checks who answers at `app.smurg.ai` (above), runs `wrangler deploy --env ""`, and refuses to call it done
unless wrangler's deploy output names exactly the custom domain (`app.smurg.ai (custom domain)`) and no workers.dev
hostname and every outside check passes. `--url https://app.smurg.ai` is accepted
and must be exactly that origin. `--google-client-id <id>` writes `GOOGLE_CLIENT_ID` into
`apps/relay/wrangler.jsonc` (commit it: the client ID is public). The script never logs in, never puts or reads a
secret: it prints the command and stops with exit 3 when the owner has to act (not logged in, several accounts
without `CLOUDFLARE_ACCOUNT_ID`, no signing key, `app.smurg.ai` answering as something other than a smurg relay).
Details: `apps/relay/README.md`, 「部署到 Cloudflare」.

The same script deploys a self-hosted relay on its own account's workers.dev (`"workers_dev": true`, no `routes`, the
origin learned from the first deploy and written into `wrangler.jsonc`): `apps/relay/README.md`
「自己架設：workers.dev（預設）」. That is how the shared relay started on 2026-10-01
(`https://smurg-relay.gclin-ian.workers.dev`, the script's first run against the account); the move to the custom
domain the same day was: `smurg.ai` added to the account (§1.2); `apps/relay/wrangler.jsonc` changed as above; the
Google client given the new origin, redirect URI and authorized domain (§1.3); one `wrangler deploy` from a copy of
the repository with that configuration (not this script: the script of that day accepted only workers.dev; its
custom-domain path was added afterwards and runs against the account for the first time at the next deploy, §10).
The old hostname answers 404 since. No release had been published, so no `smurg` binary carries the old address.
A CLI that logged in to the old origin keeps choosing it, though (the relay of the last login comes before the
built-in default): run `smurg login --relay https://app.smurg.ai` once, or
`smurg logout --relay https://smurg-relay.gclin-ian.workers.dev` and then `smurg login`.

What the production configuration must say (whatever script sets it; `apps/relay/README.md` 設定):

| Name | Production value |
|---|---|
| `workers_dev`, `routes` | `false`; exactly `[{ "pattern": "app.smurg.ai", "custom_domain": true }]` |
| `RELAY_ISSUER`, `ALLOWED_ORIGINS` | `https://app.smurg.ai` (https, no path, no trailing slash) |
| `GOOGLE_CLIENT_ID` | the client ID from §1.3 |
| `GITHUB_CLIENT_ID` | empty |
| `DEV_LOGIN` | `"0"` (dev login is also refused on any non-local hostname in code) |
| `RELAY_TAP_URL` | empty |
| secrets | `RELAY_SIGNING_KEY`, `GOOGLE_CLIENT_SECRET` |

After every deploy, check (none of this needs a credential; `scripts/deploy-relay.sh --check https://app.smurg.ai`
does the same and more: the JWKS has an Ed25519 key and no private part, `/` and an SPA deep link carry the
`_headers` CSP and `Strict-Transport-Security: max-age=31536000` (the latter from the first deploy after 2026-10-01:
the build live that day predates it), `/auth/google/login` redirects to Google with this relay's callback, the configured client ID and a
`__Host-` cookie, the live web app loads the same content-hashed `/assets/…` files as this checkout's
`apps/web/dist`, and `http://` redirects to `https://`; no response is a Cloudflare challenge):

```sh
curl -fsS https://app.smurg.ai/healthz                  # ok
curl -fsS https://app.smurg.ai/api/login-options        # {"providers":{"github":false,"google":true},"dev":false}
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://app.smurg.ai/healthz          # 301 https://app.smurg.ai/healthz
curl -sI https://app.smurg.ai/ | grep -i '^strict-transport-security'                         # max-age=31536000
curl -sS -o /dev/null -w '%{http_code}\n' https://smurg-relay.gclin-ian.workers.dev/healthz   # 404: workers.dev stays off
```

Then, the first time on a new address: open `https://app.smurg.ai` in a browser (the landing page, with only
「使用 Google 登入」); run `smurg login --relay https://app.smurg.ai` and log in with your Google account; `smurg host`
a throw-away folder; open the invite link in another browser profile with a second Google account and join. The
owner's browser login on `https://app.smurg.ai` was done on 2026-10-01; the CLI login and a second account joining
are still to do (§10), the joining only after the relay is redeployed from the current `main`: the web app live on
2026-10-01 is the build of 7a690c9, which refuses the `channel.welcome` of a daemon from cb99aa0 or later (the
decoder's `invalid Welcome`: `publicSettings.guestMainWorkspace` is an unknown key to it), so every browser, guest or
host console, fails to connect to such a daemon (§4 step 3).

Good to know:

- **Every deploy disconnects every WebSocket** (relay.md gotcha 9). Hosts, browsers and CLIs reconnect by themselves
  within seconds, but a class in the middle of an exercise notices. Deploy outside working hours.
- A redeploy uses the same command. `wrangler.jsonc`'s `migrations` must only ever be appended to (a Durable Object
  class is never renamed or removed in place).
- Relay logs: `pnpm --filter @smurg/relay exec wrangler tail` shows live requests and the relay's few `console` lines
  (never content: the relay has none). Cloudflare shows the account's usage under Workers & Pages → smurg-relay →
  Metrics.

## 3. The shared relay's address in the repository [lead]

Done 2026-10-01 for `https://app.smurg.ai`. Besides the maintainer docs, the address appears in these places, and they
must agree:

- `DEFAULT_RELAY_URL` in `packages/cli/src/relay/default-relay.ts`: the deployed relay's origin (`RELAY_ISSUER`),
  checked with `scripts/deploy-relay.sh --check <origin>`, on one line of exactly the shape
  `export const DEFAULT_RELAY_URL: string | null = 'https://<host>';`
  (`packages/cli/test/default-relay.test.ts` accepts only an https origin without a path or a placeholder;
  `apps/relay/test/config.test.ts` checks that it equals `RELAY_ISSUER`);
- `apps/relay/wrangler.jsonc` (`routes`, `RELAY_ISSUER`, `ALLOWED_ORIGINS`, §2);
- the user docs: README.md, docs/HOSTING.md, docs/JOINING.md, and `CHANGELOG.md`;
- the product page, both languages (`apps/site/public`: the web-app link, the invite-link example, the URL bar of the
  workspace picture, and both 404 pages).

Before the first deploy the user docs said `<RELAY_URL>`; that placeholder must never come back into them
(`grep -rn '<RELAY_URL>' --exclude-dir=node_modules --exclude-dir=.tools --exclude-dir=dist .` finds it only in this
file and in the release scripts and tests that refuse it). The release workflow refuses a tag while
`DEFAULT_RELAY_URL` is not an https origin, while a user doc does not name it, while a placeholder is left, or (for
this repository) while a user doc or the version's CHANGELOG section still names a concrete `*.workers.dev` address
other than `DEFAULT_RELAY_URL` (§4).

**Tag a release only with the final address**: a release built with another default keeps it forever.

Changing the address later (another domain, another account) is expensive: every released `smurg` keeps the old
default, every stored login and invite link is tied to the old origin, and the Google client must change. It changed
once, from `https://smurg-relay.gclin-ian.workers.dev` to `https://app.smurg.ai` on 2026-10-01, before any release
existed. Do not change it again.

## 4. Cutting a release [lead]

1. `main` is green in CI, and `source scripts/env.sh && pnpm check` is green locally.
2. `CHANGELOG.md`: the section `## [X.Y.Z] - YYYY-MM-DD` (for 0.1.0: replace `Unreleased` with the date), written
   for hosts and members: what they notice (new, changed, fixed) and anything they must do (for example "hosts must
   upgrade before members can use …"). The release workflow publishes that section as the release notes. For a later
   version also set `"version": "X.Y.Z"` in all eight `package.json` files (`smurg --version` prints the daemon's).
   Commit, then check what the workflow's first job will check:

   ```sh
   scripts/release-assets.sh --version X.Y.Z --base-url https://github.com/gclinian/smurg/releases/download/vX.Y.Z --publish-checks
   ```

   It refuses (and a tag push fails before any build) while the section is missing or not dated, while `<RELAY_URL>` or
   `<account-subdomain>` is left in the section or in README.md / docs/HOSTING.md / docs/JOINING.md, while
   `DEFAULT_RELAY_URL` is not an https origin or one of those three docs does not name it, while one of those three
   docs does not show the install line `curl -fsSL https://smurg.ai/install.sh | sh`, while one of them or the section
   names a concrete `*.workers.dev` address other than `DEFAULT_RELAY_URL` (a self-hosted relay's address is written
   `https://smurg-relay.<你的子網域>.workers.dev`), or while a `package.json` says another version. Optional: Actions →
   Release → Run workflow (version X.Y.Z) is a dry run of the whole pipeline on all four runners that publishes
   nothing and keeps the notes, `SHA256SUMS` and `install.sh` as an artifact (there the `--publish-checks` step only
   warns).
3. **[owner]** Redeploy the shared relay from the commit you are about to tag (a clean checkout of it: `git status`
   prints nothing), §2:

   ```sh
   scripts/deploy-relay.sh                                 # ends with 「完成」: every outside check passed
   scripts/deploy-relay.sh --check https://app.smurg.ai    # later, from the same checkout: 「全部通過」
   ```

   Both include the check 「GET /（網頁是這個 checkout 的建置）」.

   Why: `app.smurg.ai` serves the one web app that every host's guests and console use, whatever version the host
   runs. It decodes each daemon's `channel.welcome` and settings with strict schemas (ARCHITECTURE §5: an unknown key
   is a protocol error), so a web app older than the daemon refuses it, while a newer web app accepts older daemons (a
   field a release adds is optional). The web app must therefore be at least as new as the release before anyone can
   install the release. The check compares the content-hashed `/assets/…` files the live `index.html` loads with
   those of the `apps/web/dist` the script just built (Vite names them by content: the same commit gives the same
   names). If the workflow fails and you tag a fixed commit instead, redeploy from that one.

   From the same checkout, then redeploy the product page when its pages changed since its last deploy (§4.1). For
   0.1.0 they have: smurg.ai serves `cb99aa0`'s pages (`git diff cb99aa0 -- apps/site` shows what changed).
4. Tag and push the tag:

   ```sh
   git tag -a vX.Y.Z -m "smurg X.Y.Z"
   git push origin vX.Y.Z
   ```

5. Watch the release workflow: `gh run list --limit 5`, then `gh run watch <run id>`. Each of the four builds runs
   `scripts/build-sea.sh --version X.Y.Z --target <platform>-<arch>`, which includes the smoke test on that platform;
   the last job runs `scripts/release-assets.sh`, creates a draft release with the six files, checks the uploaded list
   and only then publishes it. If that job fails after creating the draft, delete the draft on the Releases page and
   "Re-run failed jobs" (it refuses to continue while any release for the tag exists).
6. `gh release view vX.Y.Z`: six files (`smurg-darwin-arm64`, `smurg-darwin-x64`, `smurg-linux-x64`,
   `smurg-linux-arm64`, `SHA256SUMS`, `install.sh`), and the release is marked **Latest**. The notes give
   `curl -fsSL https://smurg.ai/install.sh | sh` first and the GitHub URL as the fallback.
7. Verify the install on clean machines (§5) before announcing. The product page smurg.ai is already deployed
   (2026-10-01, §4.1); while the repository is private, its install line and every link of the page to the
   repository still end in a 404, and they start working by themselves once the release is Latest and the repository
   is public (§6). Releases need nothing there: `/install.sh` always redirects to the latest release (the page
   itself is redeployed in step 3 when it changed).

If the workflow fails before a release is published, fix the cause, delete the tag
(`git push --delete origin vX.Y.Z && git tag -d vX.Y.Z`) and tag the fixed commit again. **Once a release has been
published, never reuse its version**: people's installs and the published `SHA256SUMS` refer to it. Cut X.Y.(Z+1).

### 4.1 Deploying the product page smurg.ai [owner]

`apps/site` (details: `apps/site/README.md`) is the Worker `smurg-site` with the one custom domain `smurg.ai`, on the
same account and zone as the relay. **Deployed 2026-10-01**, before the first release and while the repository is
private, at the owner's explicit request, from `cb99aa0`'s `apps/site` with one change, now committed: the routes in
`wrangler.jsonc` are the apex only. Its `/install.sh` is a 302 to
`https://github.com/gclinian/smurg/releases/latest/download/install.sh`, which answers 404 until the first release is
published (marked Latest) **and** the repository is public (release downloads of a private repository need a GitHub
login), and the page's links into the repository (`/github`, `/docs`, source, Releases, docs, changelog, license, the
self-hosting guide) end in a GitHub 404 for visitors while it is private. Those start working by themselves; nothing
here needs redeploying for them. It never serves the script itself; the script downloads only from GitHub Releases
and checks `SHA256SUMS`, whichever URL started it.

Redeploy when the site itself changed, from the clean checkout of the commit to be tagged, right after the relay
(§4 step 3). The pages in the release commit already differ from the deployed ones (the "What does the relay see?"
wording changed after `cb99aa0`; `git diff cb99aa0 -- apps/site/public`), so 0.1.0 includes one site redeploy.

```sh
cd <repo> && source scripts/env.sh
pnpm --filter @smurg/site exec wrangler whoami                # the account holding smurg.ai (CLOUDFLARE_ACCOUNT_ID=<id> with several)
pnpm --filter @smurg/site run build                           # wrangler deploy --dry-run into apps/site/dist; nothing is deployed
WRANGLER_SEND_METRICS=false pnpm --filter @smurg/site exec wrangler deploy
```

The custom domain makes Cloudflare create the DNS record and certificate for `smurg.ai` (it has them since
2026-10-01). **Never add `www.smurg.ai` as a custom domain** (`apps/site/test/config.test.ts` asserts the apex-only
route list): `www.smurg.ai` is the owner's own proxied DNS record, which the zone's Redirect Rule needs, and wrangler
run after `source scripts/env.sh` (`CI=true`) replaces an existing record, or another Worker's custom domain, without
asking (§2). The Redirect Rule (dashboard of the `smurg.ai` zone, **Rules → Redirect Rules**: when the hostname equals
`www.smurg.ai`, a dynamic redirect to `concat("https://smurg.ai", http.request.uri.path)`, status **301**, query string
preserved) exists since 2026-10-01. It runs before any Worker, so the site's Worker never sees www traffic and www
costs no Worker request (§8). The zone's **Always Use HTTPS** (§2, zone settings) covers `smurg.ai` and
`www.smurg.ai`; on since 2026-10-01.

Check after every deploy (the same checks as `apps/site/README.md`). Live on 2026-10-01: `https://www.smurg.ai/`,
`/zh-TW/` and `/install.sh` answer 301 to the same path on `https://smurg.ai`; `https://smurg.ai/` and `/zh-TW/` 200
with every `_headers` header; `/zh-TW` 307 to `/zh-TW/`; `/install.sh` 302 to the GitHub URL above (which 404s until
the release and the visibility change); `/github`, `/docs` and `/docs/HOSTING.md` 302 to the repository; unknown paths
the 404 page of their language; after Always Use HTTPS was turned on the same day, `http://` answers 301 to the
same https URL on both hosts (`http://www.smurg.ai/…` straight to `https://smurg.ai/…`).

```sh
curl -sI https://smurg.ai/                     # 200, the headers of apps/site/public/_headers
curl -sI https://smurg.ai/install.sh           # 302 to https://github.com/gclinian/smurg/releases/latest/download/install.sh
curl -sI https://www.smurg.ai/zh-TW/           # 301 to https://smurg.ai/zh-TW/ (the zone Redirect Rule)
curl -sI http://smurg.ai/                      # 301 to https://smurg.ai/ (Always Use HTTPS)
curl -sI https://smurg.ai/no-such-page         # 404
curl -fsSIL https://smurg.ai/install.sh        # follows the redirects; the LAST status line is 200 (the release's install.sh)
```

The last one ends in a 404 while the repository is private or before a release is Latest. **After the release and
the visibility change**, re-check that `curl -fsSIL https://smurg.ai/install.sh` ends in `200` (§6 step 3).

## 5. Checking the one-line install on a clean machine [owner or lead]

**While the repository is private** the one-line install cannot work: release downloads of a private repository need
a GitHub login, and `curl` gets 404 (so does `https://smurg.ai/install.sh`, which is live but only redirects there,
§4.1). Check the
release files on a machine of yours instead (it tests the executables,
the checksums and the installer, not the GitHub URLs):

```sh
gh release download vX.Y.Z --dir /tmp/smurg-vX.Y.Z
python3 -m http.server 8000 --bind 127.0.0.1 --directory /tmp/smurg-vX.Y.Z &    # stop it afterwards
sh /tmp/smurg-vX.Y.Z/install.sh --base-url http://127.0.0.1:8000 --prefix /tmp/smurg-try
/tmp/smurg-try/bin/smurg --version                                               # smurg X.Y.Z (…)
```

**Once the repository is public** (§6), time SPEC R1.1 on a fresh macOS and a fresh Ubuntu 24.04 (a new macOS user
account is the cheapest fresh Mac; a new VM or cloud instance for Ubuntu, with a desktop for the browser login or over
SSH with the port-forward line `smurg login` prints):

1. Start a timer. `curl -fsSL https://smurg.ai/install.sh | sh` (smurg.ai is live, §4.1; on a second machine also
   try the fallback `curl -fsSL https://github.com/gclinian/smurg/releases/latest/download/install.sh | sh`).
2. Add `~/.local/bin` to `PATH` as the installer says; open a new terminal.
3. `smurg login` (Google), then `smurg host <a folder>`. Stop the timer when the invite link is printed (R1.1: under 3
   minutes).
4. Check: `smurg --version` is the tag; macOS: `xattr -l ~/.local/bin/smurg` shows no `com.apple.quarantine`;
   Ubuntu: the installer offered bubblewrap / socat / ripgrep and the AppArmor profile, and `smurg host` printed
   「客人沙盒：可用…」 afterwards.
5. Join from another machine's browser with another Google account; open a terminal session. On the Ubuntu host the
   guest gets 「我的 worktree」 only (ARCHITECTURE §11 D-14: share a git repository, or start `smurg host
   --allow-main-workspace-guests` and check that the summary lists the Linux limits).
6. Record the times, machines and anything that went wrong in `docs/ACCEPTANCE.md` (R1.1, and the Linux rows R5 / R9
   if the Ubuntu host was used for them).

## 6. Going public [owner]

After v0.1.0 passed §5's private check and CI is green:

1. Look for secrets in the history one last time; these print file names only, never contents:

   ```sh
   git grep -l -E 'GOCSPX[-]|"d" *: *"[A-Za-z0-9_-]{40,}"|BEGIN [A-Z ]*PRIVATE KEY' $(git rev-list --all)   # Google client secrets, private JWKs and PEM keys
   git ls-files | grep -E '\.dev\.vars$|(^|/)\.xdg/|credentials\.json'
   ```

   Both must print nothing.
2. `gh repo edit gclinian/smurg --visibility public --accept-visibility-change-consequences`
3. The product page smurg.ai is already deployed (2026-10-01, §4.1). Re-check that
   `curl -fsSIL https://smurg.ai/install.sh` now ends in `200` and that `https://smurg.ai/github` reaches the
   repository (the page itself was redeployed with the release, §4 step 3).
4. Run §5's timed check with the real one-line command.

## 7. Rolling back

**A bad release** (people should stop installing it):

```sh
gh release edit vGOOD --latest        # the previous good release becomes "Latest" again
gh release edit vBAD --prerelease     # a pre-release is never "Latest"
```

`releases/latest/download/install.sh` (and so `https://smurg.ai/install.sh`, which redirects there) then serves vGOOD's
`install.sh`, whose download location is pinned to vGOOD, so a new install or an upgrade gets vGOOD. Tell hosts who installed vBAD to run the one-line command again (it replaces
`~/.local/bin/smurg`). Delete a release (`gh release delete vBAD --cleanup-tag`) only when its files must not be
downloadable at all (for example, something secret ended up in an asset); keep the version number burned either way.
Check each flag with `gh release edit --help` before the first use.

**A bad relay deploy**:

```sh
cd <repo> && source scripts/env.sh && cd apps/relay
pnpm exec wrangler versions list      # recent versions of the Worker
pnpm exec wrangler rollback <version-id> --message "why"
```

A rollback restores the Worker's code and configuration, not the Durable Objects' stored data (which is only workspace
ids, their owners and connection counters), and like a deploy it disconnects every socket. A relay older than the
released CLIs must still speak their relay protocol (`@smurg/protocol/relay`); within 0.1.x it does. Its web app is
rolled back too, and an older web app refuses the `channel.welcome` of a newer daemon (§4 step 3): do not roll back
past the version deployed for the latest release.

**Stopping the relay in an emergency** (a leaked signing key, abuse): in the Cloudflare dashboard, Workers & Pages →
smurg-relay → Settings → Domains & Routes, remove the custom domain `app.smurg.ai` (workers.dev is already off, so the
relay then has no public hostname); put a new `RELAY_SIGNING_KEY` (every session and identity token signed with the
old one stops working); then deploy again (`scripts/deploy-relay.sh`), which attaches the custom domain again.
`wrangler delete` also removes every Durable Object's data; avoid it.

## 8. What the free plan allows

From Cloudflare's docs as fetched on 2026-09-27 (`docs/research/relay.md`; check the current pricing pages before
relying on the numbers). Daily limits reset at 00:00 UTC (08:00 in Taiwan). When one is used up, **operations of that
kind fail for everyone until the reset**: new connections and messages are refused (a request over the Workers limit
gets Cloudflare's Error 1027), hosts see the relay link drop, members see 「無法連上伺服器」.

| Limit (Workers Free) | Per day / total | What uses it in smurg |
|---|---|---|
| Worker requests | 100,000 / day | every login step, `/api/*` call, WebSocket upgrade. The web app's own files are static assets served without running the Worker (`run_worker_first` lists only relay paths). The product page smurg.ai (§4.1) is on the same account: only its redirects (`/install.sh`, `/github`, `/docs…`) run its Worker. |
| Durable Object requests | 100,000 / day | each WebSocket connection, each **alarm run**, and incoming WebSocket messages counted **20 : 1**. The `ping` heartbeats are answered by Cloudflare itself and cost nothing. |
| Durable Object rows written | 100,000 / day | each **alarm scheduled** (`setAlarm` is one row), plus a few rows when a host connects or disconnects and one per member connection |
| Durable Object duration | 13,000 GB-s / day | nearly nothing: the relay only uses the Hibernation API, so idle sockets are not billed |
| Durable Object storage | 5 GB total | a few keys per workspace |
| CPU time per request | 10 ms | the Worker's login routes sign and verify tokens (EdDSA, Google's RS256). **Not measured on Cloudflare.** If logins fail with Error 1102, this is why, and the Paid plan is the fix. |

Only SQLite-backed Durable Objects exist on the free plan; the relay uses them (`new_sqlite_classes` in
`wrangler.jsonc`), so no change is needed to move between plans.

**What that means in practice** (an estimate from the code; nothing was measured on Cloudflare):

- While at least one browser or CLI (the host's own browser tab counts) is connected to a workspace, its
  WorkspaceDO alarm runs about every 5 s (host timeout 6 s, host pings every 2 s): about **720 requests and 720 rows
  written per workspace-hour**. With nobody connected there is no alarm.
- The daemon sends every connected member an encrypted presence heartbeat every 3 s: 1,200 incoming messages, about
  **60 requests per member-hour**.
- Terminal output is the big one: the daemon sends a session's output every 5 ms while it is busy, one message per
  member watching it. A busy agent at 30 updates a second watched by 3 people is about 16,000 requests an hour.
  Typing in a shared file sends a message per edit to each member with the file open.
- So the alarm alone allows roughly 130 workspace-hours a day across all users (for example 15 groups sharing for 8
  hours), less whatever busy terminals take. A class of 30 working at the same time will likely hit the limit.

Watch the usage (Workers & Pages → smurg-relay → Metrics, and the Durable Objects metrics) daily in the first week. If
the limits are reached, the **Workers Paid plan** removes the daily caps (monthly allowances, then per-use prices; no
code or configuration change). Research (`relay.md` §1.2) recommended Paid from the start; Free was chosen to begin
with.

## 9. Security notes

- **macOS**: the executables are signed ad hoc, not with a Developer ID, and not notarized. `curl` sets no quarantine
  attribute, and the installer removes one after the sha256 check, so Gatekeeper does not stop it. A binary downloaded
  with a browser and started by hand is blocked by Gatekeeper; the installer is the supported path.
- **Checksums** come from the same release as the executables: they catch a corrupted or truncated download, not a
  compromised GitHub account or workflow. Protect the account (2FA), keep the workflows' actions pinned to commit
  SHAs (they are: only `actions/*`), and do not give other people write access casually. A signature on `SHA256SUMS`
  with a key pinned in `install.sh` would close this gap (still open, `docs/OPEN-QUESTIONS.md` Q1).
- **Secrets** live only in Cloudflare's secret store (`RELAY_SIGNING_KEY`, `GOOGLE_CLIENT_SECRET`) and in the
  owner's Google console. The workflows need no Cloudflare or Google secret: the relay is deployed by hand.
- **What the relay operator can see**: account identities and IP addresses of connections, workspace ids, frame sizes
  and timing (ARCHITECTURE §11 D-5); `docs/HOSTING.md` §2 tells hosts the same in plain words.

## 10. First-time checklist (this week)

1. [x] **[lead]** `pnpm check` green; first commit reviewed as in §1.1 (no `.dev.vars`, `.xdg/`, `node_modules`)
   (2026-10-01, commit 0b99dc8).
2. [x] **[owner]** `gh repo create gclinian/smurg --private --source=. --remote=origin --push` (2026-10-01; `origin`
   is `git@github.com:gclinian/smurg.git`). Two-factor authentication on the account: confirm (§1.1 step 4).
3. [x] **[lead]** First CI run on GitHub green, Linux included; failures triaged (2026-10-01, run 36779794102).
4. [x] **[owner]** Cloudflare account, `wrangler login` (§1.2); the zone `smurg.ai` on the same account (2026-10-01).
5. [x] **[owner]** `RELAY_SIGNING_KEY` (§1.4), then the first `scripts/deploy-relay.sh` (§2) (2026-10-01, on
   workers.dev; the same day moved to the custom domain `https://app.smurg.ai` with `wrangler deploy`, workers.dev off).
6. [ ] **[owner]** Google OAuth client with the origin `https://app.smurg.ai`, the redirect URI
   `https://app.smurg.ai/auth/google/callback` and the authorized domain `smurg.ai` (done 2026-10-01), consent screen
   **In production** (§1.3: in "Testing" only listed test users can log in; confirm); `GOOGLE_CLIENT_SECRET` (§1.4);
   the top level of `apps/relay/wrangler.jsonc` committed exactly as deployed (done in the tree 2026-10-01).
7. [x] **[owner]** Zone settings of `smurg.ai` (§2): **Always Use HTTPS on** (SSL/TLS → Edge Certificates; covers
   `app.smurg.ai`, `smurg.ai` and `www.smurg.ai`; off in the morning of 2026-10-01, turned on by the owner that day;
   checked live 2026-10-01: `http://` answers 301 to the same https URL on all three); Bot Fight Mode off, no "I'm
   Under Attack", no WAF challenge for `app.smurg.ai` (none interfered on 2026-10-01, §2; Bot Fight Mode: confirm in
   the dashboard). The www → apex Redirect Rule exists (done 2026-10-01, §4.1).
8. [ ] **[lead, then owner]** The script's custom-domain path against the real relay. Lead (no credential needed):
   `scripts/deploy-relay.sh --dry-run` and `scripts/deploy-relay.sh --check https://app.smurg.ai`, results recorded
   here. 2026-10-01, working tree of cb99aa0 + the domain-migration changes: `--dry-run` exit 0 (web build
   `index-C7PBCsAu.js`). `--check`, re-run the same day after the site sync and after Always Use HTTPS was turned on
   (item 7), with `apps/web/dist` rebuilt first (`pnpm --filter @smurg/web build`, so that the build comparison runs):
   exit 1, 5 of 8 checks pass. `http://` → `https://` passes. The three that fail are all fixed by the redeploy below:
   `GET /` and `GET /join/…` have no `Strict-Transport-Security` (the live web app predates that `_headers` line),
   and the live web app loads `index-B6XB8O73.js` (the build of 7a690c9), not this checkout's `index-C7PBCsAu.js`. Owner:
   `scripts/deploy-relay.sh` from a clean checkout of the current `main` (its first custom-domain run against the
   account; it must end with 「完成」), so that the live web app accepts a daemon from cb99aa0 or later (§4 step 3).
9. [ ] **[owner]** Real Google login from the browser (done on `https://app.smurg.ai`, 2026-10-01) and from
   `smurg login`; a second account joins a throw-away workspace (after item 8: until then the live web app refuses
   the current daemon).
10. [ ] **[lead]** `DEFAULT_RELAY_URL` = `https://app.smurg.ai`, the user docs name it and show
    `curl -fsSL https://smurg.ai/install.sh | sh` (§3; done in the tree 2026-10-01); committed; CI green.
11. [ ] **[lead, owner]** `CHANGELOG.md` 0.1.0 dated; `scripts/release-assets.sh … --publish-checks` passes; the
    shared relay redeployed from the commit to be tagged, and `apps/site` redeployed from the same commit (its pages
    changed since `cb99aa0`, §4.1) (owner, §4 step 3); tag `v0.1.0`; release workflow green; six files on the
    release, marked Latest (§4).
12. [ ] **[owner]** Private check of the release files on your own Mac (§5, first block).
13. [ ] **[owner]** Repository public (§6 steps 1–2).
14. [ ] **[owner]** Product page. Done: `apps/site` deployed to `smurg.ai` (apex only) and the www → apex Redirect
    Rule created, 2026-10-01, before the release at the owner's request; curl checks passed live (§4.1); the
    redeploy from the release commit is part of item 11. Left: after the release and the visibility change,
    re-check that `curl -fsSIL https://smurg.ai/install.sh` ends in `200` (§6 step 3).
15. [ ] **[owner]** Timed one-line install (`curl -fsSL https://smurg.ai/install.sh | sh`) on a clean Mac and a clean
    Ubuntu 24.04 (§5).
16. [ ] **[lead]** `docs/ACCEPTANCE.md` R1.1 (and R5 / R9 if tested on Ubuntu) updated with the results.
17. [ ] **[owner]** Cloudflare usage checked daily for the first week (§8).
