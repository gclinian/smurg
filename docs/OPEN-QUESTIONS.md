# Open questions for the project owner

Decisions left open after the review round of 2026-09-29 and the round that followed it the same day. Each entry gives
the current behaviour, the options and a recommendation. **Q1 was decided on 2026-09-30 and Q2 decided and run** (the release
plan, `docs/RELEASING.md`; Q2's owner question about the Linux sandbox's residuals was decided on 2026-10-01:
main-workspace guest sessions are off by default on Linux, `docs/ARCHITECTURE.md` §11 D-14); Q3–Q11 and Q13 are not
decided in code.

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

## Q2. Linux verification (reviews SPEC-05, CLI-09; SPEC D8) — **decided 2026-09-30, run 2026-10-01; its owner question decided 2026-10-01**

**Decision.** Option 1: GitHub Actions on ubuntu-24.04 is the Linux verification. CI (`.github/workflows/ci.yml`) runs
`pnpm check` there on every push to `main` and every pull request, after installing bubblewrap, socat, ripgrep and the
installer's AppArmor profile, and the release workflow builds the Linux x64 and arm64 executables on their own
runners and runs `build-sea.sh`'s smoke test on each (single executable, a real PTY, login, host, `smurg attach`,
stop).

**What happened.** The first CI run on Linux (2026-10-01, ubuntu-24.04 x64) failed 27 tests. Every failure was
reproduced in an Ubuntu 24.04 arm64 VM on the development Mac and fixed at its cause: the guest sandbox (the host home
was listable inside bubblewrap, guests had no network, `--new-session` took guest terminals' signals, bubblewrap's
mount points were left in the host's project, write-deny globs were dropped), NFC names on ext4, inode reuse in the
test run registry, a bash-only probe under dash, a wrapped prompt line in the web smoke test. The whole gate is now
green in the VM (two consecutive runs) and on CI: `docs/ACCEPTANCE.md` "Linux verification" has the counts and what
skips. R5 and R9 are `covered` on Linux; `docs/research/sandbox.md` "Linux, verified 2026-10-01" has the measurements.
srt's `apply-seccomp` never runs (no seccomp filter with `allowAllUnixSockets`), so it needs no AppArmor profile.
bubblewrap 0.8 or later is required (Ubuntu 24.04 ships 0.9.0, Debian 12 0.8.0; Ubuntu 22.04's 0.6.1 is refused with
an upgrade hint).

**What stays manual** (a person on a real Ubuntu 24.04 machine, `docs/RELEASING.md` §5):

- the installer's Linux branch: `apt-get` through `sudo` with consent and the AppArmor profile for `/usr/bin/bwrap`
  (the profile itself is the one the VM and CI run with; the installer's steps ran only against stand-ins);
- a real `claude` in the Linux sandbox (R5.3, R5.5, the hooks, the guest login process with the real `claude`): neither
  the VM nor the runners have one;
- keep-awake through `systemd-inhibit` (a runner has no login session) and the R1.1 timing on a fresh machine.

**Before the decision.** Linux paths (bubblewrap sandbox, AppArmor user namespaces, inotify, `systemd-inhibit`, procps
parsing, the installer's Linux branch) were implemented and unit-tested with an injected platform only; R5.1–R5.5 and
R9.1 / R9.2 had never run on Linux. Options were: 1. a Linux CI runner; 2. an owner-approved VM with a removable state
directory; 3. declare hosts macOS-only for the prototype. (The failures of the first CI run were then reproduced in a
Lima VM on the development Mac, 2026-10-01.)

**Owner decision (2026-10-01) on the Linux sandbox's residuals: option 2.** On a Linux host, guests' (sandboxed) agent
and terminal sessions in the MAIN workspace are **off by default**; guests get worktree mode only, which needs the share
to be a git repository. The host opens the main workspace explicitly with `smurg host --allow-main-workspace-guests`,
and the start summary then lists the Linux residual limits (below; ARCHITECTURE §12). macOS is unchanged (open by
default; `--no-main-workspace-guests` closes it on either platform). Reason: bubblewrap cannot deny by pattern, so in
main mode a guest can create new nested `.claude/settings.json`, `.mcp.json` or `.git`, and the host's edits of
protected files during a guest session are visible to it; in worktree mode the guest never sees the main workspace.
Built the same day (ARCHITECTURE §11 D-14): `config.sessions.guestMainWorkspace` (default `platform !== 'linux'`),
published as `PublicSettings.guestMainWorkspace`; the daemon refuses a guest's main-mode `session.create`
(`forbidden` / `main-workspace-off`, audited); the web's new-session dialog does not offer 「共享主工作區」 to guests
while it is off and preselects 「我的 worktree」, and on a share that is not git says that guest sessions are not
available on this host and how the host opens them. The cost the recommendation named stays: on Linux a share that is
not git has no guest sessions by default. Option 3's guard (a new name ends the guest's processes and is named to the
host) stays in place for a host who opens the main workspace. The guard-review round the same day (GR-1) found that
the file watcher never reports names in directories made in one burst with their parent (`mkdir -p`, a checkout, an
unpack: @parcel/watcher's inotify backend does not watch them) and drops an inotify overflow silently, so the coverage
described below was overstated; since then the guard also walks the root every few seconds and once more after the
guest's last process ended (ARCHITECTURE §7.6, §12), and the start summary of `--allow-main-workspace-guests` says that
such names are found within seconds rather than at once.

<details><summary>The question as it stood before the decision</summary>

**Owner question: the Linux sandbox's residuals** (ARCHITECTURE §12 "Linux, in more detail"). bubblewrap builds the
guest's file system from mounts of concrete paths, so three things macOS Seatbelt denies by pattern are open on Linux:

- In a guest session in the MAIN workspace, a guest can create a NEW host-only name below the top of the share
  (`sub/.claude/settings.json`, `sub/.mcp.json`, `sub/.git/…`, `sub/.vscode/…`). Existing ones at any depth and every
  name at the top are protected while the host does not remove, rename or replace them (fourth item), `file.*` refuses
  these paths to guests and a worktree merge refuses them; since 2026-10-01 such a new name (except `.git`) ends that
  root's guest processes and is named on the host's terminal (the daemon cannot tell who made it). Such a file
  can run code in the host's UNSANDBOXED tools once the host opens that subfolder (a Claude Code started there, git's
  `core.fsmonitor` or hooks of a nested repository, a VS Code task). An existing one whose path holds a glob character
  (`*`, `?`, `[`, `]`, e.g. below `app/[slug]/`) or is not UTF-8 is not protected either; the daemon names each such
  path in its log (review attack F1: such a directory, made by a guest, used to refuse every guest session).
- A guest can remove or re-point the read-only shared link in its own worktree (R9.2): the shared folder stays
  read-only, and the daemon refuses the tampered link.
- A Unix socket in a directory the guest can read (the share, its guest dir) can be connected to.
- While a guest process runs, a host-only or host-private entry the HOST replaces, removes or creates in that root
  (an atomic save of `.envrc` or `.mcp.json`, the host's own Claude Code writing `.claude/settings.local.json`,
  `git switch` / `git clean` of `.claude/`) is no longer covered by the guest's sandbox (reviews RV-1, RV-2). The daemon
  notices it and ends every guest process of that root (measured 10–110 ms; `.git` within its 2 s check) and names
  the paths on the host's terminal; until then the guest can read the new content or write the name. The host is
  told (HOSTING §4) to stop guest sessions before editing these files.

Options for the first (the second and third need no change; the fourth is a window the owner should know of, with
nothing better to build on bubblewrap than what is built):
1. Accept and document it (what is built): the host is told in ARCHITECTURE §12 and ACCEPTANCE.
2. On Linux, run guest agents in worktree mode only when the share is a git repository, and allow main-workspace guest
   sessions only with an explicit host switch; non-git shares would need that switch for any guest agent.
3. A host-side check: the daemon already lists the share's existing host-only names when it wraps a guest command; it
   would report every new one that appears below the top while a guest session runs (file watcher) to the host's
   terminal, the console and the audit log, and offer to remove it. Partly built since 2026-10-01 (the guard of the
   fourth item): a new name (`.git` excepted) ends that root's guest processes, is named on the host's terminal and in
   the log, and the ended sessions are audited; not in the console, and nothing offers to remove it.

**Recommendation.** Option 3, and option 1 until it is built: it keeps main-workspace guest sessions on Linux and
tells the host before they open such a folder. Option 2 costs every non-git share its guest agents.

</details>

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

## Q13. Resource limits of guest sandboxes (review attack F2)

**Current behaviour** (ARCHITECTURE §12 "Resource limits"). Neither sandbox limits memory, disk space, CPU time or
file size, and no guest gets a cgroup of its own. A guest can slow the host's machine down, use up its memory (the
kernel or macOS then ends processes, possibly the daemon) or fill the disk that holds the share and the daemon's
state. Processes:
- Linux: at most 4096 processes and threads per sandbox (built 2026-10-01), counted inside the sandbox's own user
  namespace, so it does not depend on what the host runs and a guest cannot raise it. Before, one guest's fork bomb
  could take every process slot of the host user, the daemon's included. A guest with 8 sessions can still hold
  8 × 4096.
- macOS: none. Seatbelt has no resource control, and macOS counts processes per user (2666 on the development Mac,
  shared by every process of the host user), so a fork bomb in a guest session leaves the daemon and the host's own
  apps without a process slot until the session ends.

**Options.**
1. Keep (documented). Guests are people the host invited, and the host can end any session or kick the guest.
2. Linux: a cgroup per guest, all of its sessions together (`systemd-run --user --scope -p MemoryMax=…
   -p TasksMax=… -p CPUWeight=…` around bubblewrap). Needs the host user's systemd instance with the memory and pids
   controllers delegated (Ubuntu 24.04's `user@.service` delegates pids, memory and cpu: seen in the test VM, where
   the user's instance runs; no such scope was tried, and a host without a user instance has none); where it is
   missing, guest sessions would be refused or run without it (a host setting).
3. Both platforms: a daemon-side watchdog. Below a free-memory or free-disk threshold it ends the guest session that is
   growing and tells the host. On macOS also a per-user process limit for guest sessions below the host's own limit
   (e.g. 2666 − 256), which keeps a reserve of process slots for the daemon; how many a guest then gets depends on
   what else the host runs.
4. An address-space or file-size limit in the session prelude: cheap, but Node / V8, the JVM and sanitizer builds
   reserve far more address space than they use, so a limit they survive does not stop an out-of-memory machine, and a
   file-size limit caps one file, not the disk.

**Recommendation.** Option 1 for the prototype, option 2 and the disk part of option 3 at launch; not option 4.
