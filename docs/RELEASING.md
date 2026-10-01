# Releasing smurg

The runbook for the project owner and the project lead: one-time setup, deploying the shared relay, cutting a
release, checking it, rolling back, and what Cloudflare's free plan allows. Nothing in the repository uploads, deploys
or signs anything by itself; every step that touches a GitHub or Cloudflare account is run by a person.

Steps marked **[owner]** need the owner's own accounts or secrets (nobody else ever sees the Google client secret or
the relay's signing key). Steps marked **[lead]** need the repository only.

Checked against the files on 2026-10-01 (release-verify): the workflows are linted (actionlint 1.7.12 with shellcheck
0.11.0) but have never run on GitHub; the release files and the installer were run end to end on macOS arm64 from a
local server; `scripts/deploy-relay.sh` has only run with `--dry-run` and against a fake wrangler. Everything that
touches a real GitHub, Cloudflare or Google account happens for the first time when the owner follows this runbook.

## The plan (decided 2026-09-30, `docs/OPEN-QUESTIONS.md` Q1)

| What | Decision |
|---|---|
| Source | GitHub `gclinian/smurg`, created **private**, switched to **public** once a release is verified. License Apache-2.0. |
| Shared relay | One Worker on Cloudflare Workers, **free plan**, at `https://smurg-relay.gclin-ian.workers.dev` (written `<RELAY_URL>` below and in the user docs until the first deploy tells the subdomain). |
| Login | Google only, with an OAuth client the owner creates. GitHub login stays in the code (self-hosted relays can use it) but is not configured on the shared relay. |
| Builds | GitHub Actions on a tag `v*`, each target on its own runner: macOS Apple Silicon (`macos-15`), macOS Intel (`macos-15-intel`), Linux x64 (`ubuntu-24.04`), Linux arm64 (`ubuntu-24.04-arm`). The plan's `macos-14` / `macos-13` are not used: `macos-13` was retired on 2025-12-04 and `macos-14` is removed on 2026-11-02 (brownouts from 2026-10-05); `macos-15-intel` is GitHub's last x86_64 image, available until August 2027 (actions/runner-images #13046, #13518, #13045). The executables are copies of the official Node from `.nvmrc`, so the runner's macOS version does not limit where they run. |
| Signing | None from Apple: ad-hoc signature only. The installer verifies the sha256, then removes the quarantine attribute. |
| Downloads | GitHub Releases (R2 is not used). One line: `curl -fsSL https://github.com/gclinian/smurg/releases/latest/download/install.sh \| sh` |
| First version | v0.1.0 |

## 0. What is where

| Piece | Where | Verified so far |
|---|---|---|
| Single executable (Node SEA: CLI + daemon + native parts) for the platform it is built on | `scripts/build-sea.sh [--node <node>] --version X.Y.Z [--target <platform>-<arch>]` → `packages/cli/dist/smurg-<platform>-<arch>`; checks that it runs (`--version`), prints its sha256, runs the smoke test `packages/cli/test/sea.test.ts`. `--target` refuses a runner or a Node of another platform/arch; the tag form `--version v0.1.0` is accepted | built and smoke-tested on macOS arm64 only (10.5 s, 3/3 on 2026-10-01) |
| Release files | `scripts/release-assets.sh --version X.Y.Z --base-url https://… [--dist DIR] [--out DIR] [--require-all] [--check-arch] [--notes FILE] [--changelog FILE]` → `<out>/{smurg-*, SHA256SUMS, install.sh}` (default `packages/cli/dist/release/X.Y.Z`): copies the executables with mode 0755, checks with `file` that each is the Mach-O / ELF its name says, runs this machine's and requires exactly `smurg X.Y.Z (…`, fills the base URL into `install.sh`, writes the release notes (the CHANGELOG section with relative links pointed at the tag, the install commands, the checksums). Two check-only modes run before any build: `--check-changelog` (a section exists) and `--publish-checks` (§4) | run end to end on macOS arm64 on 2026-10-01: the real arm64 executable plus header-only stand-ins for the other three, exactly as `release.yml` calls it |
| Installer | `scripts/install.sh`: picks darwin/linux × arm64/x64 (glibc; Rosetta shells get arm64), downloads `SHA256SUMS` and then the executable, installs `~/.local/bin/smurg` only when the sha256 matches (https only; http only for 127.0.0.1 / localhost); macOS: removes `com.apple.quarantine` after the sha256 matched and before the first run; Linux: bubblewrap / socat / ripgrep and the Ubuntu 24.04+ AppArmor profile for `/usr/bin/bwrap`, only with consent | `packages/cli/test/install-script.test.ts` (32 tests, every OS/arch through a faked `uname`, under sh and dash); on 2026-10-01 the assembled `install.sh` installed the real executable from 127.0.0.1 as `curl … \| sh` (sh and dash) with a downloader that quarantines what it saves: quarantine removed, ad-hoc signature intact, `--version` right; a wrong hash, a truncated file, a missing executable and a missing `SHA256SUMS` each refused, with the previous install left alone. The Linux branch ran only against stand-ins. |
| Release workflow | `.github/workflows/release.yml`, on a tag `v*`: a `prepare` job (tag format, `--check-changelog`, `--publish-checks`), four builds (`build-sea.sh --version X.Y.Z --target …` on `macos-15`, `macos-15-intel`, `ubuntu-24.04`, `ubuntu-24.04-arm`), then `release-assets.sh --require-all --check-arch --notes` with `--base-url https://github.com/gclinian/smurg/releases/download/vX.Y.Z`, a **draft** GitHub release with the six files, a check of the uploaded asset list, and only then publish (Latest; a version with a `-` part is a pre-release). Only the release job has `permissions: contents: write`; actions are pinned to commit SHAs. A manual run (Actions → Release → Run workflow) is a dry run that publishes nothing | cannot run locally; actionlint + shellcheck clean |
| CI | `.github/workflows/ci.yml`: `pnpm check` on `macos-15` and `ubuntu-24.04` for pushes to `main`, pull requests and manual runs; the Ubuntu job installs bubblewrap, socat, ripgrep and the same AppArmor profile as the installer (manual input `linux-userns = sysctl` lifts the restriction machine-wide instead); the log is uploaded as `pnpm-check-<os>` on failure | cannot run locally; actionlint + shellcheck clean |
| Relay deploy | `scripts/deploy-relay.sh` (production build of web + relay, then `wrangler deploy` of the top level of `apps/relay/wrangler.jsonc`: `<RELAY_URL>`, Google only, dev login off); `--dry-run` never contacts the account; `--check <url>` checks a deployed relay from outside | `--dry-run` run on 2026-10-01 inside a sandbox that denied all outbound network (so no account contact is possible): green; the stop for a missing login checked with the real wrangler 4.142 and an empty config; the account paths only against a fake wrangler (`apps/relay/test/deploy-relay.test.ts`); never deployed |
| CLI default relay | `DEFAULT_RELAY_URL` in `packages/cli/src/relay/default-relay.ts`: used when there is no `--relay`, no `SMURG_RELAY_URL` and no earlier login (`smurg attach` first takes the invite link's origin or the relay it joined through); `null` (no default: the CLI refuses and asks for `--relay`) until the lead sets it after the first deploy (§3) | unit tests (`packages/cli/test/default-relay.test.ts`) |
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
   account's **workers.dev subdomain**. The relay's address will be `https://smurg-relay.<that subdomain>.workers.dev`
   (`smurg-relay` is the Worker's `name` in `apps/relay/wrangler.jsonc`). Pick the subdomain with care: every released
   `smurg` carries this address as its default relay, and every invite link starts with it.
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

The redirect URI below contains the relay's address. If the workers.dev subdomain is not known yet, put the signing
key (§1.4) and deploy once (§2) first: the deploy tells the address. Then create the client and deploy again with its
ID.

In the Google Cloud console (a new project, e.g. "smurg"):

1. **OAuth consent screen** (called **Google Auth Platform → Branding / Audience** in newer consoles): user type
   **External**; app name "smurg"; support and developer contact e-mail; scopes `openid`, `email`, `profile` (the relay
   asks for nothing else). **Publishing status: In production.** In "Testing" only the test users you list can log
   in. With only these three scopes Google does not ask for an app review (Google's rule for non-sensitive scopes;
   the console says so if that changes).
2. **Credentials → Create credentials → OAuth client ID** (or **Clients → Create client**): application type **Web
   application**; **Authorized JavaScript origins**: `<RELAY_URL>`; **Authorized redirect URIs**:
   `<RELAY_URL>/auth/google/callback`, exactly, e.g. `https://smurg-relay.example.workers.dev/auth/google/callback`
   (`scripts/deploy-relay.sh` prints both). The CLI's login goes through the same callback (the relay then sends the
   browser on to `127.0.0.1`), so no loopback URI is registered (`apps/relay/README.md`).
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

```sh
cd <repo> && source scripts/env.sh
scripts/deploy-relay.sh --dry-run                       # web build, config checks, wrangler deploy --dry-run; no account contact
scripts/deploy-relay.sh                                 # first deploy (after §1.2 and RELAY_SIGNING_KEY from §1.4)
#   → Google client (§1.3) with the origin and redirect URI it printed, then GOOGLE_CLIENT_SECRET (§1.4)
scripts/deploy-relay.sh --google-client-id <id>.apps.googleusercontent.com   # Google on; ends with 「完成」
scripts/deploy-relay.sh --check <RELAY_URL>             # any time later: the outside checks only
```

`scripts/deploy-relay.sh` builds the web app and the relay and deploys the top level of `apps/relay/wrangler.jsonc`
(the production values below). The Worker's address is only known after its first deploy: the script deploys once
with the empty issuer (the relay is closed: every relay route but `/healthz` answers 500), reads the workers.dev URL
from wrangler's deploy output, writes it into `apps/relay/wrangler.jsonc` as `RELAY_ISSUER` and `ALLOWED_ORIGINS`, and
deploys again (with `--url https://smurg-relay.<subdomain>.workers.dev` it deploys only once). `--google-client-id`
writes `GOOGLE_CLIENT_ID` the same way. Commit the changed `apps/relay/wrangler.jsonc` (the address and the client ID
are public). The script never logs in, never puts or reads a secret: it prints the command and stops with exit 3
when the owner has to act (not logged in, several accounts without `CLOUDFLARE_ACCOUNT_ID`, no signing key). Its
account-touching steps ran only against a fake wrangler: its first real run is the owner's first deploy. Details:
`apps/relay/README.md`, 「部署到 Cloudflare」.

What the production configuration must say (whatever script sets it; `apps/relay/README.md` 設定):

| Name | Production value |
|---|---|
| `RELAY_ISSUER`, `ALLOWED_ORIGINS` | `<RELAY_URL>` (https, no path, no trailing slash) |
| `GOOGLE_CLIENT_ID` | the client ID from §1.3 |
| `GITHUB_CLIENT_ID` | empty |
| `DEV_LOGIN` | `"0"` (dev login is also refused on any non-local hostname in code) |
| `RELAY_TAP_URL` | empty |
| secrets | `RELAY_SIGNING_KEY`, `GOOGLE_CLIENT_SECRET` |

After every deploy, check (none of this needs a credential; `scripts/deploy-relay.sh --check <RELAY_URL>` does the
same and more: the JWKS has an Ed25519 key and no private part, `/` and an SPA deep link carry the `_headers` CSP,
`/auth/google/login` redirects to Google with this relay's callback, the configured client ID and a `__Host-` cookie):

```sh
curl -fsS <RELAY_URL>/healthz                  # ok
curl -fsS <RELAY_URL>/api/login-options        # {"providers":{"github":false,"google":true},"dev":false}
```

Then, the first time: open `<RELAY_URL>` in a browser (the landing page, with only 「使用 Google 登入」); run
`smurg login --relay <RELAY_URL>` and log in with your Google account; `smurg host` a throw-away folder; open the
invite link in another browser profile with a second Google account and join. This is the first time a real Google
login and a real Cloudflare deployment are exercised (`docs/ARCHITECTURE.md` §12).

Good to know:

- **Every deploy disconnects every WebSocket** (relay.md gotcha 9). Hosts, browsers and CLIs reconnect by themselves
  within seconds, but a class in the middle of an exercise notices. Deploy outside working hours.
- A redeploy uses the same command. `wrangler.jsonc`'s `migrations` must only ever be appended to (a Durable Object
  class is never renamed or removed in place).
- Relay logs: `pnpm --filter @smurg/relay exec wrangler tail` shows live requests and the relay's few `console` lines
  (never content: the relay has none). Cloudflare shows the account's usage under Workers & Pages → smurg-relay →
  Metrics.

## 3. Filling in `<RELAY_URL>` (once, after the first deploy) [lead]

The user docs say `<RELAY_URL>` where the shared relay's address goes. After the first deploy:

```sh
grep -rn '<RELAY_URL>' --exclude-dir=node_modules --exclude-dir=.tools --exclude-dir=dist .
```

Replace every occurrence in the user docs (README.md, docs/HOSTING.md, docs/JOINING.md) and in `CHANGELOG.md` with the
real address, e.g. `https://smurg-relay.example.workers.dev` (no trailing slash). In this file and in
`docs/ARCHITECTURE.md`, `<RELAY_URL>` stays the name of the address; write the real address once into the plan table
at the top. Set the CLI's built-in default, `DEFAULT_RELAY_URL` in `packages/cli/src/relay/default-relay.ts`, to
exactly the origin `scripts/deploy-relay.sh` printed (it prints the whole line; `packages/cli/test/default-relay.test.ts`
accepts only an https origin without a path or a placeholder), and fix anything else the grep finds outside the docs.
Commit, let CI pass. The release workflow refuses a tag while any of this is missing (§4).

**Tag v0.1.0 only after this**: a release built before the default was filled in has no usable default relay, and
that binary keeps it forever.

Changing the address later (a custom domain, another account) is expensive: every released `smurg` keeps the old
default, every stored login and invite link is tied to the old origin, and the Google redirect URI must change. Pick
the address once.

## 4. Cutting a release [lead]

1. `main` is green in CI, and `source scripts/env.sh && pnpm check` is green locally.
2. `CHANGELOG.md`: the section `## [X.Y.Z] - YYYY-MM-DD` (for 0.1.0: replace `Unreleased` with the date), written
   for hosts and members: what they notice (new, changed, fixed) and anything they must do (for example "hosts must
   upgrade before members can use …"). The release workflow publishes that section as the release notes. For a later
   version also set `"version": "X.Y.Z"` in all seven `package.json` files (`smurg --version` prints the daemon's).
   Commit, then check what the workflow's first job will check:

   ```sh
   scripts/release-assets.sh --version X.Y.Z --base-url https://github.com/gclinian/smurg/releases/download/vX.Y.Z --publish-checks
   ```

   It refuses (and a tag push fails before any build) while the section is missing or not dated, while `<RELAY_URL>` or
   `<account-subdomain>` is left in the section or in README.md / docs/HOSTING.md / docs/JOINING.md, while
   `DEFAULT_RELAY_URL` is not an https origin, or while a `package.json` says another version. Optional: Actions →
   Release → Run workflow (version X.Y.Z) is a dry run of the whole pipeline on all four runners that publishes
   nothing and keeps the notes, `SHA256SUMS` and `install.sh` as an artifact (there the `--publish-checks` step only
   warns).
3. Tag and push the tag:

   ```sh
   git tag -a vX.Y.Z -m "smurg X.Y.Z"
   git push origin vX.Y.Z
   ```

4. Watch the release workflow: `gh run list --limit 5`, then `gh run watch <run id>`. Each of the four builds runs
   `scripts/build-sea.sh --version X.Y.Z --target <platform>-<arch>`, which includes the smoke test on that platform;
   the last job runs `scripts/release-assets.sh`, creates a draft release with the six files, checks the uploaded list
   and only then publishes it. If that job fails after creating the draft, delete the draft on the Releases page and
   "Re-run failed jobs" (it refuses to continue while any release for the tag exists).
5. `gh release view vX.Y.Z`: six files (`smurg-darwin-arm64`, `smurg-darwin-x64`, `smurg-linux-x64`,
   `smurg-linux-arm64`, `SHA256SUMS`, `install.sh`), and the release is marked **Latest**.
6. Verify the install on clean machines (§5) before announcing.

If the workflow fails before a release is published, fix the cause, delete the tag
(`git push --delete origin vX.Y.Z && git tag -d vX.Y.Z`) and tag the fixed commit again. **Once a release has been
published, never reuse its version**: people's installs and the published `SHA256SUMS` refer to it. Cut X.Y.(Z+1).

## 5. Checking the one-line install on a clean machine [owner or lead]

**While the repository is private** the one-line install cannot work: release downloads of a private repository need
a GitHub login, and `curl` gets 404. Check the release files on a machine of yours instead (it tests the executables,
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

1. Start a timer. `curl -fsSL https://github.com/gclinian/smurg/releases/latest/download/install.sh | sh`
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
3. Run §5's timed check with the real one-line command.

## 7. Rolling back

**A bad release** (people should stop installing it):

```sh
gh release edit vGOOD --latest        # the previous good release becomes "Latest" again
gh release edit vBAD --prerelease     # a pre-release is never "Latest"
```

`releases/latest/download/install.sh` then serves vGOOD's `install.sh`, whose download location is pinned to vGOOD, so
a new install or an upgrade gets vGOOD. Tell hosts who installed vBAD to run the one-line command again (it replaces
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
released CLIs must still speak their relay protocol (`@smurg/protocol/relay`); within 0.1.x it does.

**Stopping the relay in an emergency** (a leaked signing key, abuse): in the Cloudflare dashboard, turn off the
Worker's workers.dev route; then put a new `RELAY_SIGNING_KEY` (every session and identity token signed with the old
one stops working) and turn the route back on. `wrangler delete` also removes every Durable Object's data; avoid it.

## 8. What the free plan allows

From Cloudflare's docs as fetched on 2026-09-27 (`docs/research/relay.md`; check the current pricing pages before
relying on the numbers). Daily limits reset at 00:00 UTC (08:00 in Taiwan). When one is used up, **operations of that
kind fail for everyone until the reset**: new connections and messages are refused (a request over the Workers limit
gets Cloudflare's Error 1027), hosts see the relay link drop, members see 「無法連上伺服器」.

| Limit (Workers Free) | Per day / total | What uses it in smurg |
|---|---|---|
| Worker requests | 100,000 / day | every login step, `/api/*` call, WebSocket upgrade. The web app's own files are static assets served without running the Worker (`run_worker_first` lists only relay paths). |
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

1. [ ] **[lead]** `pnpm check` green; first commit reviewed as in §1.1 (no `.dev.vars`, `.xdg/`, `node_modules`).
2. [ ] **[owner]** `gh repo create gclinian/smurg --private --source=. --remote=origin --push`; 2FA on.
3. [x] **[lead]** First CI run on GitHub green, Linux included; failures triaged (2026-10-01, run 36779794102).
4. [ ] **[owner]** Cloudflare account, workers.dev subdomain chosen, `wrangler login` (§1.2).
5. [ ] **[owner]** `RELAY_SIGNING_KEY` (§1.4), then the first `scripts/deploy-relay.sh` (§2): it prints `<RELAY_URL>`.
6. [ ] **[owner]** Google OAuth client with the origin `<RELAY_URL>` and the redirect URI
   `<RELAY_URL>/auth/google/callback`, consent screen **In production** (§1.3); `GOOGLE_CLIENT_SECRET` (§1.4);
   `scripts/deploy-relay.sh --google-client-id <id>` ends with 「完成」; commit `apps/relay/wrangler.jsonc`.
7. [ ] **[owner]** Real Google login from the browser and from `smurg login`; a second account joins a throw-away
   workspace.
8. [ ] **[lead]** `<RELAY_URL>` replaced in the user docs and `DEFAULT_RELAY_URL` set (§3); committed; CI green.
9. [ ] **[lead]** `CHANGELOG.md` 0.1.0 dated; `scripts/release-assets.sh … --publish-checks` passes; tag `v0.1.0`;
   release workflow green; six files on the release, marked Latest (§4).
10. [ ] **[owner]** Private check of the release files on your own Mac (§5, first block).
11. [ ] **[owner]** Repository public (§6); timed one-line install on a clean Mac and a clean Ubuntu 24.04 (§5).
12. [ ] **[lead]** `docs/ACCEPTANCE.md` R1.1 (and R5 / R9 if tested on Ubuntu) updated with the results.
13. [ ] **[owner]** Cloudflare usage checked daily for the first week (§8).
