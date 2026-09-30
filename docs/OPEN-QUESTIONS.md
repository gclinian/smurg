# Open questions for the project owner

Decisions left open after the review round of 2026-09-29 and the round that followed it the same day. Each entry gives
the current behaviour, the options and a recommendation. **Q1 was decided on 2026-09-30 and Q2 partly** (the release
plan, `docs/RELEASING.md`); Q3–Q11 are not decided in code.

The two departures from SPEC.md's wording that the review round left **pending approval** were implemented on
2026-09-29 as the project lead recommended, each behind a switch that is on by default (`docs/ARCHITECTURE.md` §11):

- **D-12** (review SPEC-04): a guest logs in with their Claude subscription through a separate login process that the
  daemon runs in the guest's sandbox and that may listen on a local port while it runs (`smurg host
  --no-guest-subscription-login` turns it off: guests then log in with an API key only). The guest's agent sessions
  still cannot listen at all.
- **D-13** (review SPEC-01): agents' Bash commands are reported to the daemon (start and end, not their content), so an
  agent's shell edits in the main workspace appear as that agent in the activity feed instead of 「外部程式」
  (`smurg host --no-bash-attribution` turns it off).

What is still the owner's to decide about them is whether those defaults are right: **Q12**. The remaining entries do
not depart from SPEC.md's wording; they are listed in the order the owner may want to take them.

---

## Q1. Releases: hosting, build matrix, signing, an operated relay (review CLI-01, SPEC R1 「一行指令安裝」) — **decided 2026-09-30**

**Decision (project owner, 2026-09-30).** Runbook: `docs/RELEASING.md`.

- **Source**: GitHub `gclinian/smurg`, created private and switched to **public** once a release is verified;
  license Apache-2.0.
- **Downloads**: **GitHub Releases** (R2 and other object storage are not used). The one-line install is
  `curl -fsSL https://github.com/gclinian/smurg/releases/latest/download/install.sh | sh`; each release's
  `install.sh` has that release's download location filled in by `scripts/release-assets.sh`.
- **Build matrix**: GitHub Actions on a tag `v*` (`.github/workflows/release.yml`), each target on its own runner:
  macOS Apple Silicon (`macos-15`), macOS Intel (`macos-15-intel`), Linux x64 (`ubuntu-24.04`), Linux arm64
  (`ubuntu-24.04-arm`). The plan named `macos-14` and `macos-13`; neither is usable: `macos-13` was retired on
  2025-12-04 (actions/runner-images #13046), and `macos-14` fails on purpose during brownouts from 2026-10-05 and is
  removed on 2026-11-02 (#13518). `macos-15-intel` is GitHub's last x86_64 image, available until August 2027 (#13045).
  The executables are copies of the official Node from `.nvmrc`, so the runner's macOS version does not limit where
  they run.
- **macOS signing**: **none from Apple** (no Developer ID, no notarization): the ad-hoc signature `build-sea.sh`
  already makes. The installer verifies the sha256 and then removes the quarantine attribute (verified end to end on
  macOS arm64, 2026-10-01).
  This departs from the recommendation below: its premise was that Gatekeeper quarantines a downloaded binary, but
  `curl` sets no quarantine attribute (`docs/research/pty-packaging.md`, verification), and the installer is the
  supported path.
- **Operated relay**: one relay on Cloudflare Workers, **free plan**, at the workers.dev subdomain
  `https://smurg-relay.gclin-ian.workers.dev` (known after the owner's first deploy). It becomes the CLI's
  built-in default relay (`DEFAULT_RELAY_URL`, set after the first deploy; the release workflow refuses a tag while it
  is unset), which ends "no default relay" (review CLI-12: the reason was that
  a guessed domain would receive logins; an operated one does not have that problem). **Login: Google only**, with an
  OAuth client the owner creates.
- **First version**: v0.1.0.

**Still open** (none blocks v0.1.0):

1. **Signed checksums**: `SHA256SUMS` comes from the same release as the executables, so a compromised GitHub account
   or workflow could publish matching ones. A minisign or Sigstore signature with a key pinned in `install.sh` would
   close that.
2. **Developer ID signing and notarization**, if Gatekeeper starts to stop curl-installed ad-hoc binaries or a
   browser-download path is wanted.
3. **Free → Paid plan** when usage says so (estimate in `docs/RELEASING.md` §8: a class working at the same time is
   likely to reach the daily limits, and then nobody can connect until 00:00 UTC).
4. **A custom domain** for the relay: it would change the default relay built into every release (RELEASING §3).
5. **Intel Macs after August 2027**: GitHub then has no x86_64 macOS runner. `darwin-x64` would have to be built on
   Apple silicon with an x64 Node under Rosetta (which `scripts/build-sea.ts` refuses today, on purpose) or dropped.

<details><summary>The question as it stood before the decision</summary>

**Behaviour before the decision.** `scripts/build-sea.sh --version X.Y.Z` builds the single executable for the machine
it runs on (only macOS arm64 was ever built). `scripts/release-assets.sh` writes `SHA256SUMS` and an `install.sh` with
the release URL filled in; `scripts/install.sh` installs only a sha256-verified binary into `~/.local/bin` and, on
Linux, installs bubblewrap / socat / ripgrep and an AppArmor profile for `/usr/bin/bwrap` with the host's consent.
Nothing was hosted, and there was no default relay (`--relay` was required).

**Options.**
1. GitHub Releases for the binaries, a GitHub Actions matrix that builds each target on its own runner
   (macos-14 arm64, macos-13 x64, ubuntu-24.04 x64 and arm64), Apple Developer ID signing and notarization for macOS,
   and a minisign (or Sigstore) signature on `SHA256SUMS` whose public key is pinned in `install.sh`.
2. Self-hosted downloads (object storage behind a CDN) with the same build matrix and signatures.
3. Stay source-only for the prototype and change R1.1 to a documented from-source path (would need a §11 row).

**Recommendation.** Option 1, plus one operated relay on Cloudflare whose origin becomes the documented `--relay`.
Without signing, macOS Gatekeeper quarantines a downloaded binary and the 3-minute target cannot be met.

</details>

## Q2. Linux verification (reviews SPEC-05, CLI-09; SPEC D8) — **partly decided 2026-09-30**

**Decision.** Option 1: GitHub Actions on ubuntu-24.04 is the Linux verification. CI (`.github/workflows/ci.yml`) runs
`pnpm check` there on every push to `main` and every pull request, after installing bubblewrap, socat, ripgrep and the
installer's AppArmor profile, and the release workflow builds the Linux x64 and arm64 executables on their own
runners and runs `build-sea.sh`'s smoke test on each (single executable, a real PTY, login, host, `smurg attach`,
stop). Neither has run yet: the first push to GitHub is the suite's first run on Linux. Which Linux tests actually run in CI and which skip (for example without `claude` or a
system Chrome) is known after the first run; `docs/ACCEPTANCE.md` is updated from that log, not before.

**What stays manual** (a person on a real Ubuntu 24.04 machine, `docs/RELEASING.md` §5):

- the installer's Linux branch: `apt-get` through `sudo` with consent and the AppArmor profile for `/usr/bin/bwrap`
  (a CI runner is not a fresh desktop Ubuntu, and its AppArmor settings may differ);
- whether srt's `apply-seccomp`, extracted into the cache dir, needs its own AppArmor profile;
- guest terminals under `bwrap --new-session` (no controlling terminal): resize and Ctrl-C typed by a person;
- the guest login process (D-12) and the in-sandbox hook self-test on Linux: their real-sandbox tests are macOS-only
  (`describe.runIf(isDarwin)`), and `claude` is not installed on the runners;
- keep-awake through `systemd-inhibit` (a runner has no login session) and the R1.1 timing on a fresh machine.

Until then ACCEPTANCE keeps R5 / R9 marked "macOS" and Linux `manual`.

**Before the decision.** Linux paths (bubblewrap sandbox, AppArmor user namespaces, inotify, `systemd-inhibit`, procps
parsing, the installer's Linux branch) were implemented and unit-tested with an injected platform only; R5.1–R5.5 and
R9.1 / R9.2 had never run on Linux. Options were: 1. a Linux CI runner; 2. an owner-approved VM with a removable state
directory; 3. declare hosts macOS-only for the prototype. A VM on the development machine was not started (it downloads
images and writes state outside the repository).

## Q3. `.git` and credentials in the main workspace (reviews WEB-17, SEC-D-03 residual)

**Current behaviour.** Guest people (every non-host role, viewers included) can no longer read or download anything
under any `.git`, nor `.envrc` or the host's personal Claude Code files: PathGuard refuses them (`host-private`), the
tree and zips leave them out. A guest AGENT in the main workspace can still read `<share>/.git` (including
`.git/config`, which may hold a token in a remote URL) through its sandbox, because git needs it. In worktree mode
only `.git/objects` is readable.

**Options.**
1. Keep it; `smurg host` warns at start when `.git/config` has credentials in a remote URL (not implemented).
2. Deny `.git/config` to guest agents in main mode (git commands that read the config then fail for them).
3. Deny all of `.git` to main-mode guest agents (no git in main mode; worktree mode keeps git).

**Recommendation.** Option 1 with the start-up warning: git in the main workspace is part of the normal workflow,
and a token in a remote URL is the actual problem.

## Q4. Should `.env` files join the host-private class? (review SEC-D-03, protocol-core question 2)

**Current behaviour.** `.env` / `.env.*` are ordinary project files: every member can read them, and guest agents can
read them in their sandbox. `docs/HOSTING.md` tells the host that every member sees every file, `.env` included.

**Options.** 1. Keep. 2. Host-private by default (projects that need `.env` to run break for guest agents). 3. A host
setting (off by default) that makes `.env*` host-private.

**Recommendation.** Option 3 for the launch phase; option 1 for the prototype.

## Q5. Guest symlinks that point outside the share (review SEC-D-04, part 2)

**Current behaviour.** A guest agent in the main workspace can create a symlink inside the share that points outside
it (npm and pnpm create links all the time). The daemon never follows such a link for anyone (PathGuard), and a
worktree merge refuses one (`unsafe-symlink`, now also through chains of links). The host's own unsandboxed tools and
agent could follow it.

**Options.** 1. Forbid symlink creation in guest sandboxes (breaks npm / pnpm installs). 2. Detect and remove (cannot
tell the host's own links from a guest's). 3. Flag only: the activity feed shows a new link that leaves the share as a
problem, attributed like any other change.

**Recommendation.** Option 3.

## Q6. Revocable relay sessions (review SEC-E-03 residual)

**Current behaviour.** Relay sessions (browser cookie and CLI bearer token) are stateless 7-day EdDSA tokens. The CLI
login can no longer be started by a link (a confirmation page with a code, then a same-origin POST), but a token that
leaks stays valid until it expires.

**Options.** 1. A per-account generation number in a Durable Object checked on every request, with a
"log out everywhere" endpoint (one lookup per request). 2. Shorter CLI sessions (e.g. 1 day) with a refresh token.
3. Keep, documented.

**Recommendation.** Option 3 for the prototype, option 1 at launch.

## Q7. Login on a headless host (review CLI-07, item 4)

**Current behaviour.** `smurg login` / `host` on a machine without a browser print the URL; over SSH they print the
`ssh -N -L <port>:127.0.0.1:<port>` command that makes the loopback callback work from the person's own computer.

**Options.** 1. An OAuth device-authorization style flow at the relay (the CLI shows a code, the person confirms it in
any browser). 2. Keep the port-forward.

**Recommendation.** Option 1 at launch; the port-forward is enough for the prototype.

## Q8. Default guest invite printed by `smurg host` (review SEC-E-05)

**Current behaviour.** The guest link has no use limit and expires after 7 days unless `--max-uses` / `--expires` say
otherwise. The full URL (secret included) stays in the browser's history of everyone who opened it; `replaceState`
cannot remove it. The console now shows each link's uses live and can revoke it.

**Options.** 1. Keep (a class shares one link). 2. Single-use by default (one link per member). 3. Shorter default
lifetime (24 h), unlimited uses.

**Recommendation.** Option 3.

## Q9. Audit order after a backward clock step (review REL-04, protocol-core question 3)

**Current behaviour.** Audit `at` stays strictly increasing (it is the paging cursor), so after the wall clock steps
back, new entries carry times up to the step size in the future until the clock catches up.

**Options.** 1. Keep. 2. Page the audit log by a sequence number and store the real wall time.

**Recommendation.** Option 2 together with the launch-phase audit filters (R11 完整版).

## Q10. A kick while the disk refuses writes (review REL-14, protocol-core question 4)

**Current behaviour.** The kick (role change, invite revocation, settings change) takes effect at once in memory, is
retried until the disk takes it, and is reported: the host console gets `state-not-saved`, the host's terminal a
warning, and `smurg stop` logs `STATE NOT SAVED`. If the daemon stops or crashes before the disk recovers, the change
is lost at the next start.

**Options.** 1. Keep (fail closed while running). 2. Persist before applying: while the disk refuses writes, a kick
fails and the member keeps access.

**Recommendation.** Option 1 (confirm).

## Q11. Bringing main's changes into a worktree (review SPEC-03)

**Current behaviour.** SPEC R9 says conflicts are listed and the host handles them; the UI now tells the host to merge
in their own terminal (`git merge refs/smurg/merge/<id>`) or reject. A requester cannot update their worktree from the
main workspace (guests cannot write any `.git`).

**Options.** 1. A `worktree.update` operation run by the daemon (a merge into a folder the guest can modify at the same
time: needs a careful design). 2. Keep.

**Recommendation.** Option 2 for the prototype.

## Q12. The defaults of the two switches of D-12 and D-13 (ARCHITECTURE §11)

**Current behaviour.** Both switches are on unless the host turns them off when starting `smurg host`; `smurg host`
explains each one in its start summary, and echoes it there when it is off.

- **Guest subscription login** (`config.sessions.guestSubscriptionLogin`, off with `--no-guest-subscription-login`). A
  guest may start their own login process (session kind `login`): the daemon runs the fixed `claude auth login
  --claudeai` in that guest's sandbox, with nothing of the share readable, for at most 10 minutes, one at a time, visible
  to that guest only. Its one extra right is to listen for Claude Code's login callback. On macOS that right cannot be
  narrowed to the loopback interface (Seatbelt's `localhost` admits every local address, the LAN address included;
  measured), so the process may start no program but bash, claude, a no-op `BROWSER` and `/usr/bin/security`; Claude
  Code's own callback server listens on 127.0.0.1 only. Off: guests are refused with a zh-TW message and log in with an
  API key only (the state before this round). A real account's login was never completed in a test. The web app starts the process
  from its login guide (「用 Claude 訂閱登入」); the daemon publishes the switch to every member
  (`PublicSettings.guestSubscriptionLogin`), so with the switch off the guide offers the API key only and says why.
- **Bash attribution** (`config.activity.attributeBashEdits`, off with `--no-bash-attribution`). Every agent session,
  the host's included, runs a second, fail-open hook for its Bash tool that tells the daemon when a command starts and
  ends (not the command or its output); a disk change inside the window of exactly one session that could have written
  it is attributed to that agent. Cost measured with the dev entry: ~52 ms per hook run, two per Bash command. Known
  limits: a change the host's own tools make in the same root during an agent's Bash window is attributed to that agent,
  and a session can forge windows to claim unannounced changes of its own root (never another agent's or a person's).
  Off: an agent's shell edits in the main workspace appear as 「外部程式」, and SPEC R8.5 is `partly` again.

**Options.**
1. Keep both on (what the project lead recommended and what is built).
2. Subscription login off by default, the host opts in per share with `--guest-subscription-login`: no guest process
   may listen unless the host chose it, at the cost of SPEC §9's 「有 Claude 訂閱的組員…跟平常一樣的 Claude Code 操作方式」
   out of the box.
3. Bash attribution off by default: no extra hook run per shell command, and R8.5 stays `partly`.

**Recommendation.** Option 1. The listen right is bounded (one fixed command, ≤ 10 minutes, no connection to the host's
local services, an exec allow-list on macOS), and without it a guest with a subscription cannot use it at all; the Bash
hook fails open and can only ever attribute changes within the reporting session's own root. Both can be turned off per
share without a new build.
