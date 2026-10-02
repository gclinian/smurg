# smurg acceptance checklist (Prototype)

Every acceptance criterion of SPEC.md R1–R9 and R11, the automated tests that cover it, and its status. This file is
the checklist for the rest of the project: when a feature changes, its rows change in the same change as the tests.
R10 is a launch-phase requirement ([上線]) and is not listed.

**Hard gate (SPEC §0):** R3. Every one of its criteria is `covered` by a named automated test.

**R5 (the guest sandbox), SPEC's other hard gate, was withdrawn by the project owner on 2026-10-01**, together with the
sandbox parts of R9 and the guest-session parts of R4 (ARCHITECTURE §11 D-15): guests no longer have agents of their
own, there is no guest sandbox, no guest Claude login or API key. Instead the host can give a member the role
「可使用 agent」 (`agent`), whose sessions run AS THE HOST (the host's account and Claude Code login, on the host's
computer, no sandbox). SPEC.md is the owner's and is not edited; the withdrawn rows below say `withdrawn` and keep what
they covered as the record. The new role has rows of its own under R2 ("R2 (D-15)") and R9.

## Status legend

| Status | Meaning |
|---|---|
| `covered` | Automated tests run in `pnpm test` and pass. A criterion with several parts is split into rows (R1.2a, R1.2b, …), one status each. |
| `partly` | Automated tests cover part of the criterion; the row says what is left and why. |
| `manual` | Cannot be automated in this repository (the row gives the reason); checked by hand before a release. |
| `withdrawn` | Withdrawn by the project owner on 2026-10-01 (ARCHITECTURE §11 D-15); the row keeps what it covered. Its tests are removed with the code. |

## How to run the gate

```sh
source scripts/env.sh     # Node 22 LTS + the repo's pnpm; leave TMPDIR as it is
pnpm check                # type check of every package, then every vitest project; exit 0 = green
```

- **Expected result** (with `smurg update` / `smurg uninstall`, 2026-10-02, macOS 26 arm64, Node 22.22.1):
  `Test Files  233 passed | 3 skipped (236)` and `Tests  3613 passed | 14 skipped (3627)`, vitest's own duration
  214 s, exit 0, nothing printed by `[smurg test run]` (below). The three skipped files are the opt-in `cli/sea`,
  `cli/sea-update` and `cli/dev-stack`. Before those two commands (after D-15 and the control-socket fixes of
  2026-10-02): `231 passed | 2 skipped (233)`, `3571 passed | 12 skipped (3583)`, 218 s. The same tree before those fixes (regression verification, 2026-10-02): `231 passed | 2 skipped`,
  `3560 passed | 12 skipped (3572)`, 213 s and 219 s in two runs; `web-smoke` alone 5 files / 17 tests. The first
  full gate after D-15 had one failure, `daemon/files/upload-load.test.ts`'s latency comparison under the full gate's
  load (it passes alone; if it fails on a busy machine, run it alone and record both). Before D-15, on macOS (2026-10-01, cb99aa0 plus the smurg.ai domain migration, its review fixes
  and the site sync with the web app's HSTS): `Test Files  242 passed | 3 skipped (245)` and
  `Tests  3713 passed | 27 skipped (3740)`, about 190–290 s from start to exit depending on what else the machine is
  doing (4:05 on that run, vitest's own duration 238 s; the web-smoke
  project runs last, ~30 s of it), nothing printed by `[smurg test run]` (below). On Linux: "Linux verification"
  below.
- **Third-party notices** (not a SPEC criterion; `LICENSE`, ARCHITECTURE §8 "Licenses") are part of the gate:
  `packages/cli/test/third-party-notices.test.ts` (the committed notices are what `pnpm-lock.yaml` and `node_modules` give,
  generation is deterministic and independent of the platform packages installed, a package without a license file
  fails, every license and NOTICE file is reproduced, every package esbuild bundles into the executable is listed,
  nothing of the guest sandbox is left since D-15: no `@anthropic-ai/sandbox-runtime`, no `apply-seccomp` note),
  `packages/cli/test/licenses.test.ts` (`smurg licenses` from source), `apps/web/test/third-party-notices.test.ts` (the
  file is in a real web build's dist; the build refuses an unlisted package). After a dependency change they fail
  until `node scripts/third-party-notices.ts` is run and both files are committed.
- **On GitHub Actions** (`.github/workflows/ci.yml`, every push to `main`): the same gate on `macos-15` and
  `ubuntu-24.04` (x64). The runners have no `claude` (those tests skip) and Linux skips the macOS-only tests and runs
  the Linux-only ones, so the counts differ from the owner's machine: see "Linux verification" below.
- **Verified in** the owner's environment: macOS 26.5.1 (Darwin 25.5) on arm64 with 8 cores, `TMPDIR` left at macOS's
  default (`/var/folders/…/T/`), Node 22.22.1 through `scripts/env.sh`, Google Chrome in `/Applications`, `claude`
  2.1.220 on `PATH`. Five consecutive runs (finish-gate, 2026-09-29) were green with no unhandled error, no new crash
  report in `~/Library/Logs/DiagnosticReports`, nothing new in the user temp dir or `/tmp`, and no process left
  running. The real-`claude` tests were also run against 2.1.283 (`SMURG_TEST_CLAUDE_BIN`, below).
- **Re-run by the project lead afterwards**, same environment: two of five runs failed, each on one load-dependent
  test, both fixed at the cause - `daemon/files/upload-load.test.ts` (fixed millisecond bounds measured the machine,
  not the upload: now relative to a control run under the same load) and `daemon/suggest/r6.pty.test.ts` (its
  readiness probe was satisfied by the terminal's own echo before the shell had run; the paste itself now also waits
  for the daemon's terminal mirror to have parsed the program's output, `PtySession.paste`). Three further runs were
  green, the last one at a load average above 40.
- **Skipped by default**: `packages/cli/test/sea.test.ts` and `packages/cli/test/sea-update.test.ts` (`smurg update` /
  `smurg uninstall` with a copy of the real executable in a scratch HOME; both need a built single executable,
  `SMURG_SEA_BINARY=<path>`, and `scripts/build-sea.sh` runs both) and `packages/cli/test/dev-stack.test.ts` (1 test; `SMURG_TEST_DEV_STACK=1`: it
  starts the whole dev stack on fixed ports). On macOS some tests skip inside files that run because they are
  Linux-only (the NFD-twin tests of `daemon/path-guard.test.ts` and `daemon/files/download.test.ts`, the Linux describe
  of `daemon/files/nfd-listings.test.ts`, the NFD case of the upload plan in `daemon/files/upload.test.ts`). Other skips
  depend on the machine, and change the counts: the real-browser tests skip without system Chrome, the real-`claude`
  tests (R8.1 with `claude`, SPEC §13 item 1) skip loudly without a `claude` of a verified version, the macOS-only
  tests (keychain, `caffeinate`) do not run on Linux. (Until D-15 the guest sandbox's Linux-only files and describes
  skipped on macOS too; they are gone.)
- **One gate at a time.** Two runs at once compete for the machine and the file-system event service; the timings
  above are for one run.
- **What a run leaves behind: nothing.** Every temp dir the test helpers create and every long-lived process a test
  starts is registered with the run; after the last test, whatever a test did not remove (because it leaks, or because
  its worker died) is removed and listed on stderr as `[smurg test run] removed N leftover(s) …`. A green run prints
  no such line: when it appears, find the test (ARCHITECTURE §0 rule 4). Test browsers resolve no name but loopback
  (a fresh Chrome profile otherwise downloads components from Google) and keep their temp files in the test's TMPDIR.
  (On the owner's machine other software creates `/tmp/zeb_def_ipc_<pid>` sockets at any time, ~20 a day since July;
  they are not smurg's: nothing in the repository or its dependencies names them.)
- **Slow on purpose** (> 15 s): `daemon/hooks/claude-e2e.test.ts` › the hook fails closed when the daemon is slow
  (~26 s) and `daemon/hooks/claude-failmodes.test.ts` › slow (~38 s): every hook event waits the hook's real deadline
  (5 s for the lock hook, including SessionStart, UserPromptSubmit and Stop); `web/src/features/transfer/e2e/transfer.browser.test.ts`
  › R7.2b (~17 s: 512 MiB through real Chrome). `apps/relay/test/liveness.test.ts` waits the relay's real 10 s
  liveness timeouts.

## Linux verification

The first run of the suite on Linux (GitHub Actions `ubuntu-24.04` x64, 2026-10-01) failed 27 tests. Every failure
was reproduced in an Ubuntu 24.04 VM and fixed at its cause (most of them in the guest sandbox, which D-15 removed
later that day; the rest: guest terminals' signals, NFC names on ext4, inode reuse, a bash-only test probe, a wrapped
prompt line in the web smoke test).

- **VM** (Lima on the development Mac): Ubuntu 24.04.2 LTS arm64, kernel 6.8, 4 CPUs, 8 GiB, Node 22.22.1. Last full
  `pnpm check` before D-15 (after the second review round, 2026-10-01): `Test Files  221 passed | 16 skipped (237)`,
  `Tests  3503 passed | 80 skipped (3583)`, 199 s, nothing left behind. Skipped there: no Google Chrome exists for
  Linux arm64 (the web-smoke and other browser files), no `claude` (the `daemon/hooks/claude-*` files), the opt-in
  `cli/sea` and `cli/dev-stack`. After D-15 (2026-10-02; the VM no longer needs bubblewrap, socat, ripgrep or the
  AppArmor profile), kernel 6.8.0-55: `Test Files  219 passed | 14 skipped (233)`, `Tests  3523 passed | 60 skipped
  (3583)`, 182 s, exit 0, nothing left behind (with the control-socket fixes of 2026-10-02; the tree before them:
  `219 passed | 14 skipped`, `3512 passed | 60 skipped (3572)`, 188 s). Skipped for the same reasons as above.
- **GitHub Actions** `ubuntu-24.04` x64 (Google Chrome 153, Node 22.23.2; no `claude`), run 36779794102 of commit
  4706b9f, green before D-15: `Test Files  224 passed | 8 skipped (232)`, `Tests  3480 passed | 51 skipped (3531)`,
  ~820 s of tests (the runner is about 5x slower than the VM). Since D-15 `ci.yml` installs no system package on the
  runner. The same run on `macos-15`: `226 passed | 6 skipped (232)`, `3494 passed | 37 skipped (3531)`.
- **What runs on Linux and not on macOS**: the NFD-twin tests of `daemon/path-guard.test.ts` and
  `daemon/files/download.test.ts`, the Linux describe of `daemon/files/nfd-listings.test.ts` (one directory listing
  per operation for Mac-made names) and the NFD case of the upload plan's numbering in `daemon/files/upload.test.ts`.
- **Still not run on Linux**: a real `claude` (the hooks, R8.1), keep-awake through `systemd-inhibit` from a local
  desktop session (from an SSH session polkit refuses it: checked in the VM, and `smurg host` reports it as refused),
  the installer on a fresh machine and R1.1's timing (`docs/OPEN-QUESTIONS.md` Q2).
- **History**: until D-15 this section also recorded the Linux guest sandbox's verification and its fixes after the
  reviews of 2026-10-01 (bubblewrap under Ubuntu's AppArmor user-namespace restriction, the protected-entry guard,
  the placeholders in the host's project, the residuals of a mount-based sandbox). That code and its tests are gone;
  the record is in git history and `docs/research/sandbox.md` (historical).

## Other ways to run

```sh
source scripts/env.sh
pnpm test                                        # everything (all vitest projects), ~2.5 min
pnpm --filter @smurg/e2e test                    # acceptance tests: real relay + real daemon + SDK clients, ~35 s
pnpm --filter @smurg/daemon exec vitest run test/integration   # the real modules together, ~10 s
pnpm exec vitest run --project @smurg/web-smoke  # the BUILT web app in system Chrome, 5 files, ~30 s (skips without Chrome)
pnpm --filter @smurg/e2e exec vitest run test/r3.e2ee.test.ts --silent=false   # one file, with the measured timings
# every real-claude test against the other verified version (2.1.220 is the one on PATH on the owner's machine):
SMURG_TEST_CLAUDE_BIN=/path/to/claude-2.1.283 SMURG_TEST_CLAUDE_PATH=/path/to/claude-2.1.283 SMURG_TEST_CLAUDE_BINS=/path/to/claude-2.1.283 \
  pnpm --filter @smurg/daemon exec vitest run test/hooks/claude-e2e.test.ts test/hooks/claude-bash.test.ts \
  test/hooks/claude-tui.test.ts test/hooks/claude-failmodes.test.ts test/sessions/claude-real.test.ts
```

The web-smoke project runs at most 2 files at once and, in the full gate, as a group of its own after every other
project (vitest refuses to start a root run in which projects with their own `maxWorkers` share a group).

Test layers (ARCHITECTURE §10):

- `tests/e2e` (`startStack`): the real relay (local workerd through `@smurg/relay/testing`, with the R3 byte tap), the
  real daemon composing `DEFAULT_FEATURE_MODULES` (production host sockets, JWKS verification of the relay's identity
  tokens) and headless clients (the client SDK's `Connection` over Node's WebSocket, dev login). Temp directories go to
  the fork's `TMPDIR` (removed by the project's global teardown); the daemon gets a fake home.
- `packages/daemon/test/integration`: the REAL modules together (`createTestDaemon` without `modules`), real SDK clients
  over the in-memory relay, the real `smurg hook` entry, real PTYs and the real CLI.
- `packages/daemon/test/<module>`: each module's acceptance tests with real clients (some with fakes of the other
  modules; the integration tests above remove those seams).
- `apps/web/e2e` (Vite dev server + system Chrome) and `apps/web/e2e/smoke` (the production build served by the real
  relay's Worker + system Chrome): real browsers, fresh contexts, dev login, no cookies imported.

Test names quote the criterion, so `vitest run -t '<criterion text>'` finds the tests. File references are relative to
`tests/e2e/test/` unless a package path is given; `daemon/…` means `packages/daemon/test/…`, `web/…` means `apps/web/…`.

---

## R1 daemon 安裝與工作區

| # | 驗收標準 | Automated test (file › test) | Status |
|---|---|---|---|
| R1.1 | 在全新的 macOS 和 Ubuntu 24.04 上，從執行安裝指令到產生邀請連結不超過 3 分鐘 | `packages/cli/test/install-script.test.ts` (the one-line installer `scripts/install.sh` against a release served on 127.0.0.1: installs only a sha256-verified executable, refuses a tampered or unlisted one and a non-https location); the single executable: `scripts/build-sea.sh --version`, smoke test `packages/cli/test/sea.test.ts` (opt-in with `SMURG_SEA_BINARY`); release files: `scripts/release-assets.sh` | `partly`: the release path is decided and built (2026-09-30; source and downloads replaced 2026-10-01, `docs/OPEN-QUESTIONS.md` Q1, runbook `docs/RELEASING.md`): `.github/workflows/release.yml` builds the four targets on a tag `v*` in the private repository (each on its own runner; ad-hoc signature, no Developer ID), a person publishes them to `https://downloads.smurg.ai` (Cloudflare R2), the one-line install `curl -fsSL https://smurg.ai/install.sh \| sh` is a 302 to `https://downloads.smurg.ai/latest/install.sh` (no GitHub fallback), and a shared relay on Cloudflare Workers is the CLI's default: `https://app.smurg.ai`. Checked locally on 2026-10-01 (release-verify): a real macOS arm64 build assembled exactly as the workflow does and installed with `curl … \| sh` from 127.0.0.1 (sha256 verified, quarantine removed, `--version` right; a wrong hash, a truncated file, a missing executable or `SHA256SUMS` refused). **v0.1.0 is released** (2026-10-01): tag on afc11bb, release workflow 36867177426 green on all four runners (`ubuntu-24.04-arm` included), published to `https://downloads.smurg.ai/v0.1.0/` with every file read back by sha256, `latest/` → 0.1.0, smurg.ai redeployed with the release's notices. The public one-line install was run the same day: macOS 26 arm64 (the development Mac, into a scratch `--prefix`): 25 s, sha256 verified, no quarantine attribute, `smurg 0.1.0 (… node 22.23.3)`, `smurg licenses` prints the terms and the notices; Ubuntu 24.04 arm64 (the Lima VM, default `~/.local/bin`): 12 s. Since D-15 the installer installs only the executable on every platform (no sudo, no system package: `install-script.test.ts`). Neither machine was fresh and the timing stops at the installed executable, not at an invite link: the 3-minute criterion on fresh machines stays `manual` (owner, `docs/RELEASING.md` §10 item 17). **v0.2.0 released 2026-10-02**: tag on 408594e (CI 36909368955 green on both OSes), release workflow 36911121981 green on all four runners, published to `https://downloads.smurg.ai/v0.2.0/` (every file read back by sha256, `latest/` → 0.2.0, `--check` all passed), smurg.ai redeployed with its notices; public one-line install the same day: macOS arm64 7 s, Ubuntu 24.04 arm64 (VM) 10 s without sudo; `smurg 0.2.0 (protocol v2, daemon 0.2.0, node 22.23.3)`. v0.1.0 was deleted from downloads.smurg.ai on 2026-10-02 (owner's decision). The fresh-machine 3-minute timing stays `manual`. **v0.3.0 released 2026-10-02** (`smurg update`, `smurg uninstall`): tag on 31a8f66 (CI 36963739827 green on both OSes), release workflow 36964944736 green on all four runners (its smoke run includes update and uninstall with the real executable), published to `https://downloads.smurg.ai/v0.3.0/` (`latest/` → 0.3.0, `--check` all passed), smurg.ai redeployed; public install on macOS arm64 and the Ubuntu 24.04 arm64 VM gives `smurg 0.3.0`, and `smurg update --check` there says it is the newest. Before the tag, a scratch build numbered 0.1.9 updated itself to the published 0.2.0 from downloads.smurg.ai (sha256 equal to SHA256SUMS). |
| R1.2a | 對分享資料夾以外路徑的請求（包括 symlink、`..`）一律被拒絕並記錄 — at the daemon's PathGuard | `r1.workspace.test.ts` › R1 分享資料夾以外的路徑 › …一律被拒絕並記錄 — PathGuard, for a guest and for the host | `covered` |
| R1.2b | …一律被拒絕 — over the wire, from a forged client | `r1.workspace.test.ts` › … — a forged `..` file.read over the encrypted channel | `covered` |
| R1.2c | …並記錄 — the forged request of R1.2b is audited | `r1.workspace.test.ts` › … — the forged `..` request is audited | `covered` |
| R1.2d | …一律被拒絕並記錄 — through the file.* / upload / download handlers | `r1.workspace.test.ts` › … — file.read through a symlink out of the share; `daemon/files/path-safety.test.ts` › R1.2 … (every file.* handler × 4 escaping links, for a guest and the host; uploads and downloads; forged payloads straight to the router) | `covered`: each refusal is `path_denied`, audited exactly once as `path.denied`; outside files unchanged. |
| R1.3a | 主人斷線後 10 秒內，所有客人的…顯示離線 — the client state every UI renders | `r1.workspace.test.ts` › R1 主人離線 › …— the host laptop sleeps; … — the host stops sharing | `covered`: ~5.5 s (client silence detector), ~5.9 s (relay heartbeat timeout); clean stop < 10 ms. |
| R1.3b | …所有客人的介面顯示離線 — the web UI shows 「主人已離線」 | `web/e2e/browser.e2e.test.ts` › 主人斷線後 10 秒內，所有客人的介面顯示離線 — the web UI shows 「主人已離線」 (real browser, after joining through a real invite) | `covered`: system Chrome, measured 4.3 s; skips without system Chrome. |

Supporting: `daemon/path-guard.test.ts` (52-case adversarial PathGuard suite incl. TOCTOU), `daemon/files/path-safety.test.ts`
› path safety table, `apps/relay/test/liveness.test.ts`.

## R2 身分、邀請與角色

| # | 驗收標準 | Automated test (file › test) | Status |
|---|---|---|---|
| R2.1 | 過期或用完次數的邀請連結無法使用 | `r2.identity.test.ts` › R2 邀請連結 › …— an expired invite; … — a used-up invite, also under concurrent joins | `covered` |
| R2.2a | 被踢的使用者 3 秒內失去所有存取權 | `r2.identity.test.ts` › R2 踢人 › …— measured on both sockets, at the relay and in the daemon; … — and cannot come back with the old device or an old link | `covered`: 3–20 ms. |
| R2.2b | …他的 session 程序被終止 (since D-15: the sessions the kicked member opened, which run as the host) | `r2.identity.test.ts` › R2 踢人 › 被踢的使用者…他的 session 程序被終止 (real relay; the process is looked for with `ps`); `daemon/sessions/kill.test.ts` › 被踢的使用者 3 秒內失去所有存取權，他的 session 程序被終止 — a background job, a nohup job, a job ignoring SIGHUP/SIGTERM and a detached daemon; `daemon/sessions/real-modules.test.ts` › a terminal it opens runs as the host (the host user, HOME, no sandbox); removing the member ends it and everything it started within 3 s, audited; `tests/e2e/test/r2.agent-role.test.ts` (a kick ends the agent member's session) | `covered` (D-15 rework, core engineer, 2026-10-02). Before D-15: 248–260 ms with sandboxed sessions; not re-measured yet. The limit of §11 D-3 (on macOS a process that detaches with `setsid` and scrubs its environment escapes) is shown by `kill.test.ts` › D-3 limit; since D-15 such a process keeps running as the host, not in a sandbox. |
| R2.3 | 偽造的客戶端請求（例如旁觀者送出 `file.write`）被 daemon 拒絕 | `r2.identity.test.ts` › R2 偽造的客戶端請求 › … | `covered` |
| R2 (D-15) a | The role 「可使用 agent」 (`agent`, replacing `runner`): `session.create` and `session.drive` for host and agent only; editors and viewers cannot open a session, type into one (`exec.input`) or accept / reject a suggestion; `runner` is no role (owner decision 2026-10-01, ARCHITECTURE §3, §11 D-15) | `packages/protocol/src/roles.test.ts` › capability matrix vs SPEC §8 (cell by cell) and › the agent role is everything but the host's administration; `daemon/authorization.test.ts` › allows exactly what ARCHITECTURE §3 allows and denies (forbidden, audited, no handler) the rest; `daemon/sessions/launch.test.ts` › the permission matrix: viewer / editor / 可使用 agent / host × open, type into, resize, end someone else's session, read its login state; `cli/test/host-relay.test.ts` (`--role agent`; `--role runner` and the removed flags refused); `web/src/lib/capabilities.test.tsx` › matches the protocol roles matrix cell by cell, › the host and 「可使用 agent」 open sessions and type into any session; editors and viewers do neither | `covered` |
| R2 (D-15) b | A session an agent member opens runs as the host: the host's OS user, environment, HOME and Claude Code login, no sandbox; in the main workspace or a new / their own kept worktree | `daemon/sessions/launch.test.ts` › every session runs like the host's own, whoever opened it: the host's HOME and environment, no guest dir, and › an agent a 可使用 agent member opens is launched exactly like the host's, and is attributed to her: 「Claude（Carol）」, …; `daemon/sessions/real-modules.test.ts` › a terminal it opens runs as the host (the host user, HOME, no sandbox) …; `daemon/sessions/r4.test.ts` › every session gets the host's own environment (its login included), never what a parent Claude Code session injected …; `tests/e2e/test/r2.agent-role.test.ts` › an agent member's session runs as the host; …; `web/src/features/agents/NewSessionDialog.test.tsx` › a 可使用 agent member opens the same kind of session: on the HOST's computer, with the host's Claude account …; `web/e2e/smoke/built-app.smoke.test.ts` › a 可使用 agent member opens a terminal from the agents panel and runs a command in it — on the host's computer, as the host's user, no sandbox … | `covered` |
| R2 (D-15) c | An agent member types into ANY session (the host's too) and accepts or rejects suggestions on any session; resizing stays with the session's owner | `daemon/sessions/launch.test.ts` › the permission matrix … (above); `daemon/suggest/suggestions.test.ts` › who accepts (§11 D-15): any member who may drive sessions … and › suggest.updated reaches the author and every member who may decide it …; `tests/e2e/test/r2.agent-role.test.ts` (the host and the agent member drive each other's sessions; an editor may not); `web/src/features/agents/AgentsPanel.test.tsx` › a 可使用 agent member types straight into the HOST's session (exec.input), but proposes no size and cannot end it; `web/src/features/suggest/SuggestionsPanel.test.tsx` › a 可使用 agent member decides on suggestions to the HOST's session too …; `web/e2e/smoke/acceptance.smoke.test.ts` › 「可使用 agent」 — a member with the role opens a session of their own … and types straight into the HOST's session; an editor's suggestion to that session is accepted by the member …; `cli/test/host-relay.test.ts` (`smurg attach` as an agent member types) | `covered` |
| R2 (D-15) d | When a member is kicked, leaves (`channel.leave`) or is set to editor / viewer, the sessions they opened end (`endReason` `kicked` / `left` / `role-changed`, audited `session.terminate`) | `daemon/sessions/launch.test.ts` › the sessions a member opened end when the member goes › a kick ends hers within 3 s …, › set to editor or viewer: hers end (role-changed) …, › channel.leave ends the leaver's sessions (left), audited; membership stays; `daemon/sessions/r4.test.ts` › a member who leaves loses the sessions they opened within 5 s (R4.4's bound) …; `tests/e2e/test/r2.agent-role.test.ts` (a kick ends it within 3 s, audited); `web/src/features/console/console.test.tsx` › taking 「可使用 agent」 from a member who opened sessions asks first, because those sessions end | `covered` |
| R2 (D-15) e | The host is told what the role means before giving it: `docs/HOSTING.md` §5.1 (risk), the console's confirmation before an agent invite or role change, the product page | `apps/site/test/site.test.ts` › … claims no sandbox for teammates, and says what the 「可使用 agent」 role means … and › the guides explain the 「可使用 agent」 role and its risk …; `cli/test/host-relay.test.ts` › what the start no longer prints is in the host guide … (HOSTING §4 / §5 phrases); `web/src/features/console/console.test.tsx` › choosing 「可使用 agent」 for a member shows the risk first; nothing is sent until the host confirms; `web/src/features/console/invites-audit-settings.test.tsx` › an 「可使用 agent」 invite cancelled at the risk step is never created …; `web/e2e/smoke/acceptance.smoke.test.ts` › the console names the roles 可使用 agent / 可編輯 / 旁觀 and shows the risk … | `covered` |
| R2 (D-15) f | A member with the host's OS account (every session of a 「可使用 agent」 member runs as it) cannot make the host's decisions in the host's name through the control socket (`~/.smurg/run/<short>.ctl`): a local channel sends only what `smurg attach` sends and receives unasked only what it consumes; what it does is audited `via: control-socket` with a refusal budget of its own; a `stop` names no reason, so `smurg host` tells the host about every stop it did not make (review F1 and its verification F-1 to F-3, 2026-10-02; ARCHITECTURE §8 "Control socket") | `daemon/local-control.test.ts` › the local channel sends only what smurg attach sends (review F1) (every client message of the registry over a local channel and over the host's relay channel; the host decisions refused there change nothing), › what the local channel receives (verification F-1) (every other daemon message neither sent nor queued for its resume; no `admin.audit.entry`), › a refusal flood through the socket leaves the host's own refusals on the web their audit budget (F-3); `daemon/audit.test.ts` › the control socket has a budget of its own …; `daemon/local/control-server.test.ts` › a stop request names no reason … (F-2); `cli/test/attach-args.test.ts` › the control socket carries only what smurg attach sends (review F1); `cli/test/host-relay.test.ts` › a stop request names no reason …; a daemon stop this command did not make is told and ends it, whatever its reason (verification F-2) | `covered`. Not covered, by design (§11 D-15): that OS account can read `~/.smurg` (keys, `state.json`, the relay login) and type into any session through the socket; `docs/HOSTING.md` §5.1 「收回之後」 is the host's checklist. |

Supporting: `daemon/authorization.test.ts` (every request type × every role), `daemon/invites.test.ts`,
`daemon/members.test.ts` (also: a kick while `state.json` cannot be written stays in force and survives a restart once
the disk recovers, review REL-14), `packages/protocol/src/channel/handshake.test.ts`.

Login (R2 「以 GitHub 或 Google 登入 relay」, not an acceptance criterion of its own). The CLI's device-code login
(2026-10-01, ARCHITECTURE §6): `apps/relay/test/device.test.ts` (real workerd: start; /device needs the relay's login and
comes back; wrong and right codes as people type them; the confirmation screen; allow / deny bound to the browser's
account; the session issued once; expiry and the alarm that deletes it; the rate limits per account, per address and for
starts; CSRF; framing headers; slow_down; a forged device code); `apps/relay/test/cli-login.browser.test.ts` (system
Chrome, headless, fresh profile: **the real `smurg login --no-browser`** signed in through /device with the dev login,
the code and 「允許」; a form on another site can neither enter a code nor allow); `tests/e2e/test/device-login.test.ts`
(the real CLI against the real relay, the browser played over HTTP: allowed, 「拒絕」, Ctrl-C);
`web/e2e/smoke/login.smoke.test.ts` › smurg login by device code … (the built app's relay, Chrome in a phone-sized
window, zero console errors and failed requests); `cli/test/login.test.ts` (what the CLI prints, the page it opens and
when, the polling, slow_down, Ctrl-C, expiry, 「拒絕」, `smurg host` logging in first, the token saved 0600) and
`cli/test/browser-policy.test.ts` (no browser over SSH or in automated runs). The removed loopback routes answer 404:
`apps/relay/test/auth.test.ts` › the removed CLI loopback login (smurg 0.1.0).
`web/src/app/pages/JoinPage.test.tsx` › SEC-E-02 (an invite link joins nothing until 「加入」).
Which login buttons a page shows comes from the relay's `GET /api/login-options` (`apps/relay/test/login-options.test.ts`,
real workerd; `apps/relay/test/lib.test.ts`); a logged-out page load of `/` and `/join/<id>` has zero console errors and
zero failed requests (`web/e2e/smoke/login.smoke.test.ts`). Real GitHub / Google accounts are not exercised (opt-in)
(by hand: the owner's Google login in the browser on https://app.smurg.ai, 2026-10-01; the CLI login and a second
account joining are still to do, `docs/RELEASING.md` §10).

## R3 端對端加密 — HARD GATE

| # | 驗收標準 | Automated test (file › test) | Status |
|---|---|---|---|
| R3.1 | 在 relay 端記錄所有經過的位元組，找不到任何明文的檔案內容、終端機輸出或指令 | `r3.e2ee.test.ts` › R3 (a) relay byte tap › … | `covered`: markers as file content (also via the real `file.read` of the files module), file names, an upload chunk (the transfer socket reaches the real upload handler), terminal input, a shell command, a suggestion, terminal output, a document update and a changed path; no marker in any encoding anywhere the relay recorded; completeness of the tap proven both ways; positive control on the same relay. |
| R3.2a | relay 把 daemon 公鑰替換成自己的公鑰時，客戶端拒絕連線… | `r3.e2ee.test.ts` › R3 (b) key substitution by the relay › (first contact; worst case with the invite secret; reconnect of a pinned device) + the control | `covered` |
| R3.2b | …並顯示警告 | `web/e2e/browser.e2e.test.ts` › relay 把 daemon 公鑰替換成自己的公鑰時，客戶端拒絕連線並顯示警告 — the web warning screen (real browser, first contact); … (real browser, reconnect of a browser that pinned the real key); `web/src/app/workspace/connection-states.test.tsx`, `web/src/app/pages/JoinPage.test.tsx`; the CLI: `cli/test/host-state-file.test.ts` › a CLI member after the host started over with new workspace keys (verification M1): a new invite whose key differs from the pin is explained (「主人的電腦金鑰和之前不同」, both fingerprints), nothing is sent and the pin stays without an explicit `y` or `--accept-new-key`; the pinned key alone gets the warning with the new-invite route | `covered`: the real MITM relay (`tests/e2e/src/mitm-relay.ts`) in front of the real relay and daemon; a focused alertdialog, no workspace UI behind it, no FINISH sent, nothing pinned, the invite unused. Skips without system Chrome. |
| R3.3 | 沒有有效邀請片段的客戶端無法完成第一次握手 | `r3.e2ee.test.ts` › R3 (c) … | `covered` |
| R3.4 | 被撤銷的裝置金鑰無法再建立連線 | `r3.e2ee.test.ts` › R3 (d) … | `covered` |

Supporting: `packages/protocol/src/channel/handshake.test.ts`, `secure-channel.test.ts`, the Noise vectors
(`vectors.cacophony.test.ts`, `vectors.snow.test.ts`, `production-suites.test.ts`), `apps/relay/test/tap.test.ts`.

## R4 agent session

| # | 驗收標準 | Automated test | Status |
|---|---|---|---|
| R4.1 | 同一個 session 同時被網頁和 CLI 接上時，畫面保持一致 | `daemon/sessions/r4.test.ts` › 同一個 session 同時被網頁和 CLI 接上時，畫面保持一致 — two clients' rendered buffers after output that repaints, scrolls and resizes; `packages/cli/test/attach-pty.test.ts` › R4.1 … — the CLI renders what a second (web-like) viewer renders (the real CLI in a real PTY); `daemon/integration/local-cli.test.ts` (the real CLI attached next to a web client, every module composed) | `covered` |
| R4.2 | 客戶端斷線時 session 繼續在主人端執行；重新接上後看得到完整的捲動紀錄 | `daemon/sessions/r4.test.ts` › 客戶端斷線時 session 繼續在主人端執行；重新接上後看得到完整的捲動紀錄 | `covered`: 300 lines, each exactly once after the re-attach. |
| R4.3 | 就算主人的 shell 環境設定了 `ANTHROPIC_API_KEY`，客人 session 裡也讀不到 | — | `withdrawn` (D-15): there are no guest sessions; a session a 「可使用 agent」 member opens runs as the host, with the host's environment and Claude Code login, on purpose. Covered before by `daemon/sessions/r4.test.ts` (nine planted variables absent, `ps -E`). |
| R4.4 | 客人離開後 5 秒內，他的臨時目錄被刪除 | — | `withdrawn` (D-15): there is no guest temp dir (no guest Claude login, no imported config). What leaving does now (the sessions the member opened end) is the D-15 row under R2. Covered before by `daemon/sessions/r4.test.ts` (126–224 ms). |

Login guide (R4 「登入引導」, not an acceptance criterion of its own): **withdrawn with D-15**. Guests no longer log in
to Claude (no API key, no subscription login process, ARCHITECTURE §11 D-12 superseded); every agent uses the host's
own Claude Code login, and a session that is not logged in says so (the web app's banner).

## R5 客人沙盒 — WITHDRAWN (owner, 2026-10-01)

**Withdrawn by the project owner on 2026-10-01** (ARCHITECTURE §11 D-15): guests no longer run agents of their own,
and the guest sandbox (srt 0.0.77: Seatbelt on macOS, bubblewrap under Ubuntu's AppArmor restriction on Linux), its
dependency checks and the protected-entry guard are removed with their tests. Until then every row below was
`covered` on macOS and Linux with real srt against canary files in a fake home (R5.3 / R5.5 with a real `claude` on
macOS). A member's sessions now run as the host by design; the honest limit is in ARCHITECTURE §12 and
`docs/HOSTING.md` §5.1.

| # | 驗收標準 | Automated test | Status |
|---|---|---|---|
| R5.1 | 客人 session 裡執行 `cat ~/.ssh/id_*`、讀取主人的 `~/.claude`、讀取其他客人的臨時目錄，全部失敗 | — (was `daemon/sandbox/r5.sandbox.test.ts` › R5.1 …) | `withdrawn` |
| R5.2 | 客人 session 無法連到白名單以外的網域 | — (was `daemon/sandbox/r5.sandbox.test.ts` › R5.2 …, `network-listen.real.test.ts`) | `withdrawn` |
| R5.3 | agent 的 Edit、Write 工具同樣受到限制（不只 Bash） | — (was `daemon/sandbox/r5.claude.test.ts` › R5.3 …) | `withdrawn` |
| R5.4 | 讓沙盒相依套件缺失時，session 拒絕啟動並顯示明確的錯誤 | — (was `daemon/sandbox/r5.sandbox.test.ts` › R5.4 …, the installer's Linux branch) | `withdrawn` |
| R5.5 | 主人的 `~/.claude/CLAUDE.md` 不會被載入客人 session | — (was `daemon/sandbox/r5.claude.test.ts` › R5.5 …) | `withdrawn`: a member's agent session runs as the host and loads the host's `~/.claude`, on purpose |

## R6 建議流程

| # | 驗收標準 | Automated test | Status |
|---|---|---|---|
| R6.1 | 擁有者確認之前，建議內容完全不會進入 agent session | `daemon/suggest/suggestions.test.ts` › R6.1 … (spy on the only paste function); `daemon/suggest/r6.pty.test.ts` › R6.1 … (real PTY, `cat -v`); `daemon/integration/suggest-sessions.test.ts` › 擁有者確認之前… (the real modules composed; the owner's PTY); `daemon/suggest/suggestions.test.ts` › SEC-D-01 (an edit between the owner's review and the accept never reaches the session unseen); `web/src/features/suggest/SuggestionsPanel.test.tsx` (no `exec.input` for a suggestion, no auto-accept anywhere; accept sends the text on screen); `web/e2e/smoke/acceptance.smoke.test.ts` › R6 建議流程 — … (two real browsers on the built app: the suggestion is in the owner's queue and not in the terminal; a rejected one never arrives, also not after later input) | `covered` (the browser test drives a terminal session: the paste path is the same for agents) |
| R6.2 | 擁有者可以在採用前修改內容 | `daemon/suggest/suggestions.test.ts` › R6.2 …; `daemon/suggest/r6.pty.test.ts` › R6.2 …; `daemon/integration/suggest-sessions.test.ts`; `web/e2e/smoke/acceptance.smoke.test.ts` › R6 建議流程 — … (「修改後採用」 in a real browser: only the edited text reaches the owner's terminal, the author sees the outcome) | `covered` |
| R6.3 | 操作紀錄記錄提出者、內容、處理方式、時間 | `daemon/suggest/suggestions.test.ts` › R6.3 … (full text past 2,000 characters); `daemon/integration/suggest-sessions.test.ts` | `covered` |

## R7 編輯器與檔案

| # | 驗收標準 | Automated test | Status |
|---|---|---|---|
| R7.1a | 兩個人同時編輯同一個檔案，雙方 1 秒內看到對方的修改，不遺失任何字元 — the daemon and two SDK clients | `daemon/docs/r7-coediting.test.ts` › 兩個人同時編輯同一個檔案… | `covered`: 5–7 ms; 80 concurrent inserts each (CJK, emoji, astral), no character lost. |
| R7.1b | … — two browsers | `web/e2e/smoke/built-app.smoke.test.ts` › 兩個人同時編輯同一個檔案，雙方 1 秒內看到對方的修改，不遺失任何字元 — two browsers on the built app | `covered`: the production build served by the real relay, two Chrome contexts typing at once; the other browser showed the text ~120 ms after typing started (typing included); both editors and the disk end identical. |
| R7.2a | 上傳 10 GB 檔案時…其他人打字和終端機沒有明顯延遲 — daemon side | `daemon/files/upload-load.test.ts` › R7.2 … (daemon side) | `partly`: a 200 MiB upload; interactive p95 3–44 ms; daemon memory back to +6 MiB after GC. |
| R7.2b | 上傳 10 GB 檔案時，瀏覽器記憶體用量保持穩定 — browser side | `web/src/features/transfer/e2e/transfer.browser.test.ts` › 上傳 10 GB 檔案時… — scaled down (512 MiB by default) from a synthetic source in real Chrome | `partly`: 1 GiB measured (Chrome RSS flat, other client's p95 7–13 ms, 39 MiB/s). The full 10 GB is `manual` (`SMURG_R72_MIB=10240` or `dev/measure.html`; needs > 10 GiB free above the host's reserve). |
| R7.3 | 上傳中途斷線，重新連線後從中斷處繼續 | `web/e2e/smoke/transfer-resume.smoke.test.ts` › 上傳中途斷線，重新連線後從中斷處繼續 — … (the built app in real Chrome, the real relay's TransferDO, a TCP proxy that cuts the transfer socket after 24 of 40 MiB); `daemon/files/upload.test.ts` › R7.3 … (socket dropped half-way; across a daemon restart; the commit's answer lost); `web/src/features/transfer/engine/upload-file.test.ts` › 上傳中途斷線… (bitmap resume; page reload; lost commit answer); `upload-job.test.ts` | `covered`: the upload resumes on one new transfer socket and sends only what the host had not acknowledged (20 MiB after the cut at 24 of 40 MiB, in 3 of 3 runs; a restart would send all 40); the file is identical by sha256. |
| R7.4 | 磁碟空間不足時，上傳在開始前就被拒絕，而不是傳到一半失敗 | `daemon/files/upload.test.ts` › R7.4 … (4 tests); `web/src/features/transfer/engine/upload-job.test.ts` and `TransfersPanel.test.tsx` › 磁碟空間不足時… | `covered` (simulated disk through the injected statfs). |
| R7.5 | 下載 1,000 個檔案的資料夾，zip 內容與原始資料夾完全一致 | `daemon/files/download.test.ts` › R7.5 … | `covered`: over the transfer channel with the credit window; extracted with the system `unzip`, compared by type, sha256, mode and link target. |

Supporting: `daemon/integration/files-locks-docs.test.ts` (file.write / rename / delete / upload commit refused on a
locked file under every spelling, then accepted and seen by the open editors), `web/e2e/smoke/built-app.smoke.test.ts`
› join … → type → the file on disk changes.

## R8 一致性與檔案鎖

| # | 驗收標準 | Automated test | Status |
|---|---|---|---|
| R8.1 | 有人正在打字的檔案，agent 的 Edit 被擋下，並收到持有者的名字 | `daemon/hooks/claude-e2e.test.ts` › SPEC §13 / R8.1: PreToolUse 回傳 deny 能確實擋下 Edit 工具 — … (the REAL `claude` 2.1.220 / 2.1.283 with the mock API: the file stays byte-identical, the tool result names Amy); `daemon/hooks/claude-failmodes.test.ts` (the real `claude`, both versions: with the daemon stopped, crashed (stale socket), missing, answering garbage or never answering, the lock hook denies Edit, Write and NotebookEdit — MultiEdit is not a tool of either version — while the Bash activity hook lets the shell command run: §11 D-13's fail-closed / fail-open split); `daemon/integration/docs-locks-hooks.test.ts` (a person typing in a real Yjs client, the real `smurg hook` entry, the real lock manager); `daemon/locks/r8.locks.test.ts` › R8.1 …; `daemon/locks/hook-socket.test.ts`; `daemon/hooks/hook-server.test.ts`; `daemon/hooks/hook-cli.test.ts` | `covered` (the real-claude runs need a verified `claude`, skip loudly otherwise; the integration test always runs). |
| R8.2a | agent 正在修改的檔案，所有人的編輯器暫時唯讀並顯示提示；完成後自動恢復可編輯 — daemon | `daemon/integration/docs-locks-hooks.test.ts` (lock.state to every client, canEdit false on open, a late update reverted with doc.rejected, editable after PostToolUse); `daemon/locks/r8.locks.test.ts` › R8.2 … (both); `daemon/docs/r8-reconcile.test.ts` › agent 正在修改的檔案 — … | `covered` |
| R8.2b | … — the web editors | `web/e2e/smoke/built-app.smoke.test.ts` › agent 正在修改的檔案…— the banner in two browsers on the built app; `web/src/features/editor/EditorArea.test.tsx` › agent 正在修改的檔案… (2 tests) | `covered`: both browsers show 「Claude（Host）」, typing is ignored, the banner goes and typing works after the release. The lock in the browser test is taken through the lock manager (as the hook socket does), not by a real `claude`. |
| R8.3 | 兩個 agent 同時修改同一個檔案時，後到者被擋下 | `daemon/locks/r8.locks.test.ts` › R8.3 …; `daemon/hooks/claude-e2e.test.ts` › R8: 兩個 agent 同時修改同一個檔案時，後到者被擋下 — the second agent's real Edit is refused and names the first; `daemon/hooks/hook-server.test.ts` | `covered` |
| R8.4 | agent 透過 Bash 修改有人正在編輯的檔案時，人打的內容不會遺失；重疊部分出現在衝突面板 | `daemon/docs/r8-reconcile.test.ts` › … (and the V4 stale-copy case); `daemon/docs/r8-real-modules.test.ts` › … — real lock manager and file watcher; `daemon/locks/bash-attribution.real-modules.test.ts` (an agent's Bash write: the conflict record names the agent); `web/src/features/activity/ConflictsPanel.test.tsx` › … — the web panel names the file, who was involved, and shows both texts side by side; `web/e2e/smoke/acceptance.smoke.test.ts` › R8.4 … (a real browser types, the disk is rewritten meanwhile: the person's text is kept and written back, both texts in the conflict panel) | `covered`. Limit: within 5 s of a person's autosave the files module attributes any change of that file to that person, so the conflict then names the person as the other side (ARCHITECTURE §12). The browser test writes the disk directly (what an agent's `sed` does); the agent's own Bash call is covered by the daemon tests. |
| R8.5 | 每一次 agent 的修改都出現在活動動態中，標示是哪個 agent、屬於誰 | `daemon/locks/r8.locks.test.ts` › R8.5 …; `daemon/integration/docs-locks-hooks.test.ts` (activity.event and activity.list: agent.edit by 「Claude（Ian）」 after the real hook's PostToolUse and a real disk write); `daemon/locks/activity.test.ts` › who changed a file nobody announced (review SPEC-01) and › Bash windows (D-13); `daemon/hooks/claude-bash.test.ts` (the REAL `claude`, 2.1.220 and 2.1.283: a scripted Bash `printf >` / `sed -i` in the main workspace is in the feed as 「Claude（Ian）」, `via: 'bash'`); `daemon/locks/bash-attribution.real-modules.test.ts`; `r11.console.test.ts` › 所有 R4–R9 … (the audit entry's actor is the agent and its owner); `web/src/features/activity/ActivityPanel.test.tsx` › 每一次 agent 的修改都出現在活動動態中… and › an agent's change by a shell command … (the 「透過指令」 marker) | `partly`: proven for Edit / Write / NotebookEdit (PostToolUse), FileChanged reports, every change in a worktree and (§11 D-13, switchable, on by default) an agent's Bash edits in the main workspace. By design never guessed, so shown as 「外部程式」: a change while the shell commands of two sessions that could both have written it overlap, and one the host's own session (unsandboxed) could have made during the window. |

## R9 git worktree

| # | 驗收標準 | Automated test | Status |
|---|---|---|---|
| R9 (choice) | 開 agent session 時可以選擇「共享主工作區」或「我的 worktree」 (the requirement's text, not a numbered criterion) | `web/src/features/agents/new-session.test.ts` › builds session.create: main, a new worktree, or a kept one — the same for the host and 可使用 agent; `web/src/features/agents/NewSessionDialog.test.tsx`; `daemon/worktree/r9.sessions.test.ts` (sessions in a worktree, kept and continued); `web/e2e/smoke/acceptance.smoke.test.ts` › R9 合併 — a 可使用 agent member works in a worktree … | `covered` (D-15): both choices for the host and for 「可使用 agent」 members on every platform. Until D-15 this row was "R9 (D-14)": on a Linux host guests got worktree mode only unless `--allow-main-workspace-guests` (owner decision 2026-10-01, superseded the same day by D-15; the switch, its flags and its tests are removed). |
| R9.1 | worktree 裡的 agent 無法讀寫主工作區或其他 worktree | — (was `daemon/worktree/r9.real-sandbox.test.ts` › R9.1 …, `daemon/sandbox/r5.sandbox.test.ts` › R9.1 …: the guest sandbox) | `withdrawn` (D-15, the sandbox part of R9): an agent in a worktree runs as the host and can read and write anything the host can; the worktree keeps its work apart from the main workspace, it does not confine it. |
| R9.2 | worktree 裡的 agent 可以讀取共享資料夾，但無法寫入 | `daemon/worktree/worktrees.test.ts` › D12 … (the shared folders are linked into the worktree; people's `file.*` writes there are refused) | `withdrawn` for agents (D-15, the sandbox part of R9: an agent runs as the host and could write the shared folder); the links themselves and the refusal of people's writes stay. |
| R9.3 | 主人拒絕合併時，worktree 保持原狀 | `daemon/worktree/merge.test.ts` › R9.3 主人拒絕合併時，worktree 保持原狀 …; `web/src/features/worktree/merge-requests.test.tsx` (the reject flow in the UI); `web/e2e/smoke/acceptance.smoke.test.ts` › R9 合併 — … (real browsers on the built app: the host reviews the complete diff and merges, the file reaches everyone's tree; a rejected request leaves the worktree's files as they were) | `covered` |
| R9.4 | session 結束時詢問是否保留 worktree；保留的 worktree 之後可以重新開 session 繼續 | `daemon/worktree/r9.sessions.test.ts` › R9.4 … (real sessions module, real PTY); `web/src/features/agents/NewSessionDialog.test.tsx` › ending a session (R9.4 …) › asks whether to keep the worktree, and sends the answer explicitly | `covered` (the dialog in jsdom). |
| R9 (D-15) | Any 「可使用 agent」 member (not only the worktree's owner) requests a merge of any worktree and sees its diff; only the host decides | `daemon/worktree/merge.test.ts` › anyone with worktree.merge.request (the host, 可使用 agent) may request a merge of any worktree (§11 D-15); an editor may not (audited); `web/src/features/worktree/merge-requests.test.tsx` › another 可使用 agent member may read the diff too (read-only); an editor may not open it; `web/e2e/smoke/acceptance.smoke.test.ts` › R9 合併 — a 可使用 agent member works in a worktree and requests a merge; the host reviews the complete diff and approves … | `covered` |

## R11 主人控制台與操作紀錄（Prototype 基本版）

| # | 驗收標準 | Automated test (file › test) | Status |
|---|---|---|---|
| R11.1a | 主人能從控制台…踢掉任何成員 — the request the console sends | `r11.console.test.ts` › 主人能從控制台一鍵終止任何 session 或踢掉任何成員 — any member, one request each, visible in the audit log | `covered` |
| R11.1b | 主人能從控制台一鍵終止任何 session | `r11.console.test.ts` › 主人能從控制台一鍵終止任何 session; `daemon/sessions/kill.test.ts` › 主人能從控制台一鍵終止任何 session — …processes included | `covered` |
| R11.1c | 主人能從控制台一鍵… — the console's one-click buttons | `web/e2e/smoke/acceptance.smoke.test.ts` › 主人能從控制台一鍵終止任何 session 或踢掉任何成員 — … (real browsers on the built app: one click terminates a member's session, whose browser then shows 「已被主人（…）終止」; one click and the confirmation kick the member, whose browser shows the kicked screen; until D-15 the member was a runner); `web/src/features/console/console.test.tsx` (request, success, error in jsdom) | `covered` |
| R11.2a | 操作紀錄涵蓋…登入登出 | `r11.console.test.ts` › 操作紀錄涵蓋登入登出 — … | `covered` |
| R11.2 | 所有 R4–R9 定義的事件都出現在操作紀錄裡 | `r11.console.test.ts` › 所有 R4–R9 定義的事件都出現在操作紀錄裡 | `covered` (the list follows D-15: `session.import-config` and `sandbox.refused` are gone): every action below is present AND carries the right actor (member, the host, the agent with its owner, or 「外部程式」) and target, and the suggestion entries carry the author, the text, the decision and the time (R6.3); checked since the review round (SPEC-10). One scenario over the real relay produces, and the console reads back, every R4–R9 action of ARCHITECTURE §5.8: `session.create/end/terminate`, `member.leave`, `suggest.create/edit/accept/reject/withdraw`, `file.write/create/rename/delete/upload/download`, `doc.edit`, `agent.edit`, `external.change`, `doc.conflict`, `doc.conflict-resolve`, `lock.acquire/release/denied/force-release`, `worktree.create/remove/merge.request/merge.approve/merge.reject`. |

---

## Known gaps

- **D-15 (2026-10-01): a member with 「可使用 agent」 runs sessions as the host**, with the host's account and Claude
  Code login and no sandbox: by design nothing confines what such a session does (ARCHITECTURE §12, `docs/HOSTING.md`
  §5.1). R5, R4.3, R4.4, R9.1, R9.2 (for agents) and SPEC §13 items 2–5 are `withdrawn`; the role's own rows are
  "R2 (D-15)" and "R9 (D-15)".
- Linux: the whole gate runs on Ubuntu 24.04 (VM and CI, "Linux verification" above); terminals get SIGWINCH on resize
  and Ctrl-C interrupts the foreground program, not the session. Not run on Linux: a real `claude` (the hooks),
  keep-awake from a local desktop session, the installer on a fresh machine (`docs/OPEN-QUESTIONS.md` Q2).
- Browsers other than Chrome (Safari/WebKit's wrapped device keys, Firefox) were not run.
- R7.2 at the full 10 GB is manual. R1.1: an installer exists, but no release is hosted, built for every platform or
  signed yet, so the fresh-machine timing cannot be done (`docs/RELEASING.md`).
- A real `claude` driving the web editor's lock banner is not automated (the banner is driven through the lock manager,
  as the hook socket does; the real `claude`'s lock requests are proven at the daemon level).
- R8.5: an agent's Bash edits are attributed (§11 D-13, on by default, the owner's confirmation pending) except when two
  sessions' shell commands that could both have written the file overlap (then 「外部程式」, by design). Within 5 s of a
  person's autosave the files module attributes any change of that file to that person (also the side a conflict names).
- REL-07 (text typed while the host was down, merged back after a daemon restart) against a real daemon restart is not
  automated: it is proven one layer down.
- The hook matrix of `daemon/hooks/claude-failmodes.test.ts` has no MultiEdit case that runs: neither verified Claude
  Code version has that tool any more (the lock hook's matcher keeps it for older ones).

## SPEC §13 items to verify

| # | Item (SPEC §13) | Where it is verified | Status |
|---|---|---|---|
| 1 | `PreToolUse` deny really blocks the Edit tool on the target Claude Code version | `daemon/hooks/claude-e2e.test.ts` › SPEC §13 / R8.1 … (the real `claude` 2.1.220 / 2.1.283, mock API); `daemon/hooks/claude-failmodes.test.ts` (Edit, Write, NotebookEdit denied whenever the daemon is unavailable, both versions) | `covered` with a verified `claude`; skips loudly without one |
| 2 | With `CLAUDE_CONFIG_DIR` set, Claude Code may still read `~/.claude/CLAUDE.md`: the sandbox must block it | — (was `daemon/sandbox/r5.claude.test.ts` › R5.5 …) | `withdrawn` (D-15): every session runs as the host and reads the host's `~/.claude` on purpose |
| 3 | srt under macOS Seatbelt works with node-pty | — (was the sandbox tests with real srt + real PTY) | `withdrawn` (D-15: no srt). node-pty itself, with resize (SIGWINCH) and Ctrl-C, stays covered (`daemon/sessions/real-modules.test.ts`, `daemon/sessions/r4.test.ts`) |
| 4 | Automatic AppArmor setup on Ubuntu 24.04+ | — (was the installer's Linux branch and `smurg host`'s sandbox report) | `withdrawn` (D-15: no bubblewrap, nothing to set up; the installer installs only the executable, `install-script.test.ts`) |
| 5 | Claude Code's login flow in a remote PTY (URL shown, code pasted) | — (was the guest's login process, `daemon/sessions/login.real.test.ts`, `web/e2e/smoke/login.smoke.test.ts` › D-12 …) | `withdrawn` (D-15): no member logs in to Claude; the host logs in to their own `claude` on their own machine |
| 6 | node-pty inside the single executable | `packages/cli/test/sea.test.ts` (opt-in with `SMURG_SEA_BINARY`; last run on darwin-arm64 with the license round's build, 2026-10-01: `scripts/build-sea.sh` 112.8 MiB, 4 of 4 tests — `smurg licenses` prints the embedded `LICENSE` and third-party notices, an Apache-2.0 text and the Node.js LICENSE included, and `--third-party` equals the `THIRD-PARTY-NOTICES.txt` the build writes next to the executable — `smurg hook` starts in 32–33 ms. Since D-15 the test also checks that nothing of srt is packed (no `vendor/`, no `node_modules/` in the extracted native dir) and that `--version` says `protocol v2`; run on a D-15 build on darwin-arm64, 2026-10-02: 111.3 MiB, 18 native assets, 4 of 4 tests, `smurg hook` 31–32 ms; again on `scripts/build-sea.sh --version 0.2.0-rc.0` with the control-socket fixes (2026-10-02): 111.3 MiB, 18 native assets, 4 of 4 tests (`smurg stop` included), `smurg hook` 30–31 ms, `--version` `smurg 0.2.0-rc.0 (protocol v2, …)`. The release dry run of 2026-10-01 (run 36846007788) ran the smoke test on all four targets) | `partly`: not part of `pnpm test` |
| 7 | 上線前: Anthropic's consumer terms and Claude Code usage policy for the suggestion flow | — | launch phase, not in the Prototype |

## Measured values (local runs, macOS arm64, Node 22.22.1, shared machine)

| Criterion | Measured |
|---|---|
| R1.3a host laptop asleep → 「主人已離線」 | 5.5–5.7 s (client silence detector); the relay's own `host.offline` 5.87–5.89 s |
| R1.3b the web UI | 4.3 s |
| R2.2a kick → access lost | 3–20 ms |
| R2.2b kick → the member's session processes gone | 248–260 ms (before D-15, sandboxed sessions; not re-measured since) |
| R4.4 channel.leave → guest dir gone | 126–224 ms (withdrawn with D-15: no guest dir) |
| R7.1 co-editing | 5–7 ms (daemon, SDK clients); ~120 ms between two browsers, typing included |
| R7.2 | daemon: 200 MiB at ~100 MiB/s, interactive p95 ≤ 44 ms; browser: 1 GiB at 39 MiB/s, Chrome RSS flat |
| R7.3 web | transfer socket cut after 24.0 of 40 MiB; 20.0 MiB sent after the drop on 1 new socket (3 of 3 runs) |
| R3.1 tap completeness | every frame sent was recorded by the relay and nothing else; 0 marker hits; positive controls hit |
