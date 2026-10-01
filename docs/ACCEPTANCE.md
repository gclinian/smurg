# smurg acceptance checklist (Prototype)

Every acceptance criterion of SPEC.md R1–R9 and R11, the automated tests that cover it, and its status. This file is
the checklist for the rest of the project: when a feature changes, its rows change in the same change as the tests.
R10 is a launch-phase requirement ([上線]) and is not listed.

**Hard gates (SPEC §0):** R3 and R5. Every one of their criteria is `covered` by a named automated test (see the note
on R5.3 / R5.5: they need a `claude` of a verified version on the machine, and skip loudly without one). R5 is covered
on **macOS and Linux** (SPEC D8): the whole gate runs on Linux since 2026-10-01 (Ubuntu 24.04 in a VM and on GitHub
Actions, "Linux verification" below); R5.3 / R5.5 have run with a real `claude` on macOS only.

## Status legend

| Status | Meaning |
|---|---|
| `covered` | Automated tests run in `pnpm test` and pass. A criterion with several parts is split into rows (R1.2a, R1.2b, …), one status each. |
| `partly` | Automated tests cover part of the criterion; the row says what is left and why. |
| `manual` | Cannot be automated in this repository (the row gives the reason); checked by hand before a release. |

## How to run the gate

```sh
source scripts/env.sh     # Node 22 LTS + the repo's pnpm; leave TMPDIR as it is
pnpm check                # type check of every package, then every vitest project; exit 0 = green
```

- **Expected result** on macOS (2026-10-01, after the second review round of the Linux fixes): `Test Files  234 passed
  | 3 skipped (237)` and `Tests  3561 passed | 22 skipped (3583)`, about 190–290 s from start to exit depending on what
  else the machine is doing (3:43 on that run; the web-smoke project runs last, ~30 s of it), nothing printed by
  `[smurg test run]` (below). On Linux: "Linux verification" below.
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
- **Skipped by default** (the 2 files / 4 tests): `packages/cli/test/sea.test.ts` (3 tests; needs a built single
  executable, `SMURG_SEA_BINARY=<path>`, which `scripts/build-sea.sh` runs) and `packages/cli/test/dev-stack.test.ts`
  (1 test; `SMURG_TEST_DEV_STACK=1`: it starts the whole dev stack on fixed ports). On macOS one more file skips
  whole, `daemon/sandbox/placeholders.real.test.ts` (6 tests, bubblewrap's mount points and what the host changes
  while a guest runs: Linux-only), and 12 more tests skip inside files that run: they are Linux-only too (the
  network-namespace describe of `daemon/sandbox/network-listen.real.test.ts`, the task-limit describe of
  `daemon/sandbox/odd-names.real.test.ts`, the NFD-twin tests of `daemon/path-guard.test.ts` and
  `daemon/files/download.test.ts`, the Linux describe of `daemon/files/nfd-listings.test.ts`, the NFD case of the
  upload plan in `daemon/files/upload.test.ts`). Other skips depend on the machine,
  and change the counts: the real-browser tests skip without system Chrome, the real-`claude` tests (R5.3, R5.5, R8.1
  with `claude`, SPEC §13 items 1, 2, 5) skip loudly without a `claude` of a verified version, the macOS-only tests
  (keychain, `caffeinate`, the sandbox's Seatbelt profile) do not run on Linux.
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
was reproduced in an Ubuntu 24.04 VM and fixed at its cause (the guest sandbox's bubblewrap policy, guest terminals,
bubblewrap's mount points in the host's project, NFC names on ext4, inode reuse, a bash-only test probe, a wrapped
prompt line in the web smoke test; `docs/research/sandbox.md` "Linux, verified 2026-10-01", ARCHITECTURE §7.4 / §7.6).

- **VM** (Lima on the development Mac): Ubuntu 24.04.2 LTS arm64, kernel 6.8, 4 CPUs, 8 GiB, bubblewrap 0.9.0, socat,
  ripgrep, Node 22.22.1, `kernel.apparmor_restrict_unprivileged_userns=1` (stock) with the `smurg-bwrap` profile that
  `scripts/install.sh` and CI install. Two consecutive full `pnpm check` runs green (linux-gate, 2026-10-01):
  `Test Files  216 passed | 16 skipped (232)`, `Tests  3452 passed | 79 skipped (3531)`, ~165 s each, nothing left
  behind. After the fixes of the reviews (fix-confirmed, same day, two runs): `Test Files  219 passed | 16 skipped
  (235)`, `Tests  3474 passed | 80 skipped (3554)`, ~170 s each (the one more skipped test: the upload plan's
  case-only collision, which needs a case-insensitive file system). After the second review round (attack-f1-docs and
  follow-up, same day): `Test Files  221 passed | 16 skipped (237)`, `Tests  3503 passed | 80 skipped (3583)`, 199 s,
  nothing left behind. The 16 skipped files: no Google Chrome exists for Linux arm64 (the 5 web-smoke files, `web/e2e/browser.e2e`,
  `web/…/transfer.browser`, `relay/cli-login.browser`); no `claude` (the 4 `daemon/hooks/claude-*` files; inside other
  files r5.claude, claude-real, claude-login-pickup and the real-claude part of login.real skip too); Seatbelt only
  (`daemon/sandbox/login-policy.real`, `daemon/sessions/login-profile.real`); opt-in as on macOS (`cli/sea`,
  `cli/dev-stack`).
- **GitHub Actions** `ubuntu-24.04` x64 (kernel 6.17 azure, bubblewrap 0.9.0, Google Chrome 153, Node 22.23.2; no
  `claude`), run 36779794102 of commit 4706b9f, green: `Test Files  224 passed | 8 skipped (232)`, `Tests  3480 passed
  | 51 skipped (3531)`, ~820 s of tests (the runner is about 5x slower than the VM). Chrome is there, so every browser
  test file runs, the web-smoke acceptance tests included (the D-12 login smoke test skips: it needs `claude`). The
  8 skipped files: the 4 `daemon/hooks/claude-*` files (no
  `claude`), the 2 Seatbelt-only files, `cli/sea` and `cli/dev-stack` (opt-in). The run before it (36777739330) failed
  one test: `r11.console.test.ts` assumed an agent's PostToolUse hook always reaches the daemon before the file watcher
  reports the same edit; on the slower runner the watcher came first (fixed in the test; the daemon records the edit
  once either way). The same run on `macos-15`: `226 passed | 6 skipped (232)`, `3494 passed | 37 skipped (3531)`.
- **What runs on Linux and not on macOS**: the Linux describe of `daemon/sandbox/network-listen.real.test.ts` (a guest's
  listener is unreachable from the host, host services only through the proxy), the abstract-socket probe of R5, the
  hardened bubblewrap command checked in R5's first test, the NFD-twin tests of `daemon/path-guard.test.ts` and
  `daemon/files/download.test.ts`, `daemon/sandbox/placeholders.real.test.ts` (bubblewrap's mount points in the host's
  project while guests come and go, across roots, and the daemon's working directory; protected entries the host
  changes while a guest runs, with the real file watcher), the Linux describe of
  `daemon/files/nfd-listings.test.ts` (one directory listing per operation for Mac-made names) and the NFD case of the
  upload plan's numbering in `daemon/files/upload.test.ts`.
- **Fixed after the reviews of the Linux commit** (2026-10-01, fix-confirmed): the daemon's working directory
  (`smurg host .` typed inside the project broke concurrent guests and left srt's dotfiles in the project), a race
  that turned the host-only directory placeholders into 0444 files, the placeholder record after a clean stop, the
  O(n²) NFC mapping in zips and watcher batches, the upload plan's numbered names, a symlinked `.git/HEAD`, the
  keep-awake report over SSH and the installer's AppArmor check (ARCHITECTURE §7.6, §12). After the review of that
  fix (2026-10-01, follow-up): a host-only or host-private entry the host replaces, removes or creates while a guest
  runs (an atomic save of `.envrc`, `git switch` of `.claude/`, a `settings.local.json` written after the start) now
  ends that root's guest processes and is named on the host's terminal (it used to stay readable or writable for the
  guest; also on b97cdee), the host's own directory made in place of a placeholder is kept, the daemon-cwd text for a
  working directory that is gone, the installer's AppArmor check run as root, the keep-awake text, and `file.tree`'s
  NFC mapping (ARCHITECTURE §7.4, §7.6, §12).
- **Still not run on Linux**: a real `claude` in the Linux sandbox (R5.3, R5.5, the hooks, the login process with the
  real `claude`), the installer's Linux branch on a fresh machine, keep-awake through `systemd-inhibit` from a local
  desktop session (from an SSH session polkit refuses it: checked in the VM, and `smurg host` reports it as refused),
  R1.1's timing (`docs/OPEN-QUESTIONS.md` Q2).
- **Linux-only residuals** (bubblewrap mounts concrete paths; ARCHITECTURE §12 "Linux, in more detail"): in a guest
  session in the MAIN workspace a guest can create a NEW host-only name below the top of the share
  (`sub/.claude/settings.json`, `sub/.mcp.json`, `sub/.git/…`; except for `.git` this now ends that root's guest
  processes and is named to the host); a guest can remove or re-point a read-only shared link in its own worktree (the
  target stays read-only, the daemon refuses the tampered link); a Unix socket in a directory the guest can read is
  connectable; a protected entry the HOST replaces, removes or creates while a guest runs (an atomic save of `.envrc`,
  the host's own Claude Code writing `.claude/settings.local.json`, `git switch` of `.claude/`) is seen by the guest
  until the daemon notices it and ends that root's guest processes (measured 10–110 ms in the VM; `.git` within the
  daemon's 2 s check), so the host is told to stop guest sessions before editing such files. The R5 / R9 tests and
  `daemon/sandbox/placeholders.real.test.ts` assert each platform's own behaviour there.

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
  test/hooks/claude-tui.test.ts test/hooks/claude-failmodes.test.ts test/sandbox/r5.claude.test.ts \
  test/sessions/claude-real.test.ts test/sessions/claude-login-pickup.test.ts test/sessions/login.real.test.ts
```

The web-smoke project runs at most 2 files at once and, in the full gate, as a group of its own after every other
project (vitest refuses to start a root run in which projects with their own `maxWorkers` share a group).

Test layers (ARCHITECTURE §10):

- `tests/e2e` (`startStack`): the real relay (local workerd through `@smurg/relay/testing`, with the R3 byte tap), the
  real daemon composing `DEFAULT_FEATURE_MODULES` (production host sockets, JWKS verification of the relay's identity
  tokens) and headless clients (the client SDK's `Connection` over Node's WebSocket, dev login). Temp directories go to
  the fork's `TMPDIR` (removed by the project's global teardown); the daemon gets a fake home.
- `packages/daemon/test/integration`: the REAL modules together (`createTestDaemon` without `modules`), real SDK clients
  over the in-memory relay, the real `smurg hook` entry, real srt, real PTYs and the real CLI.
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
| R1.1 | 在全新的 macOS 和 Ubuntu 24.04 上，從執行安裝指令到產生邀請連結不超過 3 分鐘 | `packages/cli/test/install-script.test.ts` (the one-line installer `scripts/install.sh` against a release served on 127.0.0.1: installs only a sha256-verified executable, refuses a tampered or unlisted one and a non-https location); the single executable: `scripts/build-sea.sh --version`, smoke test `packages/cli/test/sea.test.ts` (opt-in with `SMURG_SEA_BINARY`); release files: `scripts/release-assets.sh` | `partly`: the release path is decided and built (2026-09-30, `docs/OPEN-QUESTIONS.md` Q1, runbook `docs/RELEASING.md`): GitHub Releases of `gclinian/smurg` built by `.github/workflows/release.yml` on a tag `v*` (four targets, each on its own runner; ad-hoc signature, no Developer ID), the one-line install `curl -fsSL https://github.com/gclinian/smurg/releases/latest/download/install.sh \| sh`, and a shared relay on Cloudflare Workers that becomes the CLI's default. Checked locally on 2026-10-01 (release-verify): a real macOS arm64 build assembled exactly as the workflow does and installed with `curl … \| sh` from 127.0.0.1 (sha256 verified, quarantine removed, `--version` right; a wrong hash, a truncated file, a missing executable or `SHA256SUMS` refused). **No release exists yet**: the workflows have never run on GitHub, only macOS arm64 was ever built, and the relay has not been deployed. The 3-minute timing on fresh machines is `manual`, after the first release (`docs/RELEASING.md` §5). |
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
| R2.2b | …他的 session 程序被終止 | `r2.identity.test.ts` › R2 踢人 › 被踢的使用者…他的 session 程序被終止 (real relay, real sandbox; the process is looked for with `ps`); `daemon/integration/sessions-sandbox-worktree.test.ts` (sandboxed terminal in a worktree, background job, guest dir); `daemon/sessions/kill.test.ts` › 被踢的使用者 3 秒內失去所有存取權，他的 session 程序被終止 — a background job, a nohup job, a job ignoring SIGHUP/SIGTERM and a detached daemon | `covered`: measured 248–260 ms (real srt). The documented limit of §11 D-3 (setsid + scrubbed environment on macOS) is shown by `kill.test.ts` › D-3 limit and stays sandboxed. |
| R2.3 | 偽造的客戶端請求（例如旁觀者送出 `file.write`）被 daemon 拒絕 | `r2.identity.test.ts` › R2 偽造的客戶端請求 › … | `covered` |

Supporting: `daemon/authorization.test.ts` (every request type × every role), `daemon/invites.test.ts`,
`daemon/members.test.ts` (also: a kick while `state.json` cannot be written stays in force and survives a restart once
the disk recovers, review REL-14), `packages/protocol/src/channel/handshake.test.ts`.

Login (R2 「以 GitHub 或 Google 登入 relay」, not an acceptance criterion of its own): `apps/relay/test/cli-login.browser.test.ts`
(system Chrome, headless, fresh profile: the CLI loopback login through the dev login and through GitHub / Google
provider pages that submit a form, reaching the CLI's listener (review OWNER-01); **the real `smurg login --no-browser`**
signed in from the relay's page, with the terminal's confirmation code equal to the page's; a link with a provider and a
form on another site stop at the confirmation page (review SEC-E-03)); `apps/relay/test/auth.test.ts` › CLI login
confirmation (SEC-E-03); `web/src/app/pages/JoinPage.test.tsx` › SEC-E-02 (an invite link joins nothing until 「加入」).
Which login buttons a page shows comes from the relay's `GET /api/login-options` (`apps/relay/test/login-options.test.ts`,
real workerd; `apps/relay/test/lib.test.ts`); a logged-out page load of `/` and `/join/<id>` has zero console errors and
zero failed requests (`web/e2e/smoke/login.smoke.test.ts`). Real GitHub / Google accounts are not exercised (opt-in).

## R3 端對端加密 — HARD GATE

| # | 驗收標準 | Automated test (file › test) | Status |
|---|---|---|---|
| R3.1 | 在 relay 端記錄所有經過的位元組，找不到任何明文的檔案內容、終端機輸出或指令 | `r3.e2ee.test.ts` › R3 (a) relay byte tap › … | `covered`: markers as file content (also via the real `file.read` of the files module), file names, an upload chunk (the transfer socket reaches the real upload handler), terminal input, a shell command, a suggestion, terminal output, a document update and a changed path; no marker in any encoding anywhere the relay recorded; completeness of the tap proven both ways; positive control on the same relay. |
| R3.2a | relay 把 daemon 公鑰替換成自己的公鑰時，客戶端拒絕連線… | `r3.e2ee.test.ts` › R3 (b) key substitution by the relay › (first contact; worst case with the invite secret; reconnect of a pinned device) + the control | `covered` |
| R3.2b | …並顯示警告 | `web/e2e/browser.e2e.test.ts` › relay 把 daemon 公鑰替換成自己的公鑰時，客戶端拒絕連線並顯示警告 — the web warning screen (real browser, first contact); … (real browser, reconnect of a browser that pinned the real key); `web/src/app/workspace/connection-states.test.tsx`, `web/src/app/pages/JoinPage.test.tsx` | `covered`: the real MITM relay (`tests/e2e/src/mitm-relay.ts`) in front of the real relay and daemon; a focused alertdialog, no workspace UI behind it, no FINISH sent, nothing pinned, the invite unused. Skips without system Chrome. |
| R3.3 | 沒有有效邀請片段的客戶端無法完成第一次握手 | `r3.e2ee.test.ts` › R3 (c) … | `covered` |
| R3.4 | 被撤銷的裝置金鑰無法再建立連線 | `r3.e2ee.test.ts` › R3 (d) … | `covered` |

Supporting: `packages/protocol/src/channel/handshake.test.ts`, `secure-channel.test.ts`, the Noise vectors
(`vectors.cacophony.test.ts`, `vectors.snow.test.ts`, `production-suites.test.ts`), `apps/relay/test/tap.test.ts`.

## R4 agent session

| # | 驗收標準 | Automated test | Status |
|---|---|---|---|
| R4.1 | 同一個 session 同時被網頁和 CLI 接上時，畫面保持一致 | `daemon/sessions/r4.test.ts` › 同一個 session 同時被網頁和 CLI 接上時，畫面保持一致 — two clients' rendered buffers after output that repaints, scrolls and resizes; `packages/cli/test/attach-pty.test.ts` › R4.1 … — the CLI renders what a second (web-like) viewer renders (the real CLI in a real PTY); `daemon/integration/local-cli.test.ts` (the real CLI attached next to a web client, every module composed) | `covered` |
| R4.2 | 客戶端斷線時 session 繼續在主人端執行；重新接上後看得到完整的捲動紀錄 | `daemon/sessions/r4.test.ts` › 客戶端斷線時 session 繼續在主人端執行；重新接上後看得到完整的捲動紀錄 | `covered`: 300 lines, each exactly once after the re-attach. |
| R4.3 | 就算主人的 shell 環境設定了 `ANTHROPIC_API_KEY`，客人 session 裡也讀不到 | `daemon/sessions/r4.test.ts` › 就算主人的 shell 環境設定了 `ANTHROPIC_API_KEY`，客人 session 裡也讀不到 — the real environment of processes in the session; `daemon/sessions/units.test.ts` › guest environment | `covered`: nine planted variables absent from the session's real process environment (`ps -E`). |
| R4.4 | 客人離開後 5 秒內，他的臨時目錄被刪除 | `daemon/sessions/r4.test.ts` › 客人離開後 5 秒內，他的臨時目錄被刪除 — measured from channel.leave; a disconnect alone keeps it; `daemon/integration/sessions-sandbox-worktree.test.ts` (kick: guest dir gone with the session) | `covered`: 126–224 ms. The planned `r4.sessions.test.ts` over the real relay was not written: the daemon-level tests use real SDK clients and the in-memory relay, and `r11.console.test.ts` › 所有 R4–R9 … covers `channel.leave` over the real relay. |

Login guide (R4 「登入引導」, not an acceptance criterion of its own): the API-key path — `daemon/sessions/claude-real.test.ts`,
`web/src/features/agents/LoginGuide.test.tsx`; a guest's **subscription** login through the login process (ARCHITECTURE
§11 D-12) up to the login URL and the prompt for the pasted code, with the real `claude` (2.1.220 and 2.1.283) in the real
guest sandbox — `daemon/sessions/login.real.test.ts`, in a real browser — `web/e2e/smoke/login.smoke.test.ts` › D-12 …;
who may start it, who sees it, what it runs, the attacks on it — `daemon/sessions/login.test.ts`; that its sandbox differs
from an agent session's only by the TCP listen — `daemon/sessions/login-profile.real.test.ts`,
`daemon/sandbox/login-policy.real.test.ts`, `network-listen.real.test.ts`, `policy.test.ts`; a running Claude Code uses the
new credential from its next prompt — `daemon/sessions/claude-login-pickup.test.ts`. Completing a login with a real
account (pasting a code) is `manual` (§0 rule 2).

## R5 客人沙盒 — HARD GATE

All R5 tests run real srt (0.0.77) on the current OS against canary files in a temporary fake home, never the real
`~/.ssh` or `~/.claude`. R5.3 and R5.5 start the real `claude` against the mock Anthropic API
(`daemon/sandbox/mock-anthropic.ts`); they run when a `claude` of a verified version (2.1.220 or 2.1.283, ARCHITECTURE
§7.6) is on PATH or named by `SMURG_TEST_CLAUDE_PATH`, and skip loudly with the reason otherwise. Linux (bubblewrap
under Ubuntu 24.04's AppArmor user-namespace restriction, with the `smurg-bwrap` profile) runs the same real-srt tests
since 2026-10-01 ("Linux verification" above); where bubblewrap cannot do what Seatbelt does, the test asserts each
platform's own behaviour and ARCHITECTURE §12 lists the residual.

| # | 驗收標準 | Automated test | Status |
|---|---|---|---|
| R5.1 | 客人 session 裡執行 `cat ~/.ssh/id_*`、讀取主人的 `~/.claude`、讀取其他客人的臨時目錄，全部失敗 | `daemon/sandbox/r5.sandbox.test.ts` › R5.1 …; `daemon/sessions/real-modules.test.ts` (host-home canary through the sessions module) | `covered` (macOS and Linux, where it runs is in "Linux verification" above). On Linux the host home, the state dir, other guests' dirs, `/tmp` and `/home` can be neither listed nor written from a guest (the hardened bubblewrap command, `sandbox/harden.ts`). |
| R5.2 | 客人 session 無法連到白名單以外的網域 | `daemon/sandbox/r5.sandbox.test.ts` › R5.2 …; `daemon/sandbox/network-listen.real.test.ts` (nothing a guest runs can listen for connections: srt's own bind / inbound rules on its proxy port let any guest process listen on the LAN address at that port until the finish-gate round of 2026-09-29, now removed from every guest profile) | `covered` (macOS and Linux): two local servers; not-listed → 403, proxy bypass blocked at the OS level, live allow-list update; no listener on any address (Linux: every guest process has its own network namespace; its listeners are unreachable from the host's loopback and LAN address). Real public domains were not used. |
| R5.3 | agent 的 Edit、Write 工具同樣受到限制（不只 Bash） | `daemon/sandbox/r5.claude.test.ts` › R5.3 … | `covered` (macOS) with a verified `claude` (run on 2.1.220 and 2.1.283); skips loudly without one. Not run on Linux (no `claude` in the VM or on the runners); the sandbox it relies on is the one R5.1 covers there. |
| R5.4 | 讓沙盒相依套件缺失時，session 拒絕啟動並顯示明確的錯誤 | `daemon/sandbox/r5.sandbox.test.ts` › R5.4 … and › R5.4 (exec level) …; `daemon/sandbox/service.test.ts` (Linux / macOS injected); `daemon/sessions/launch.test.ts` › a failed sandbox preflight refuses the guest session; `r11.console.test.ts` › 所有 R4–R9 … (an agent session on a `claude` below the minimum refused as `sandbox_unavailable`, audited `sandbox.refused`, over the real relay) | `covered` (macOS and Linux). The AppArmor refusal was also checked by hand in the VM: with the `smurg-bwrap` profile unloaded, the preflight refuses with `apparmor-userns` and the fix commands; reloaded, it passes. A bubblewrap older than 0.8 (Ubuntu 22.04's 0.6.1) is refused as `dependency-missing` (unit test). |
| R5.5 | 主人的 `~/.claude/CLAUDE.md` 不會被載入客人 session | `daemon/sandbox/r5.claude.test.ts` › R5.5 … | `covered` (macOS) with a verified `claude`; skips loudly without one. Not run on Linux (no `claude`); on Linux the host home, `CLAUDE.md` included, is unreadable from a guest (R5.1). |

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
| R9.1 | worktree 裡的 agent 無法讀寫主工作區或其他 worktree | `daemon/worktree/r9.real-sandbox.test.ts` › R9.1 …; R9.2 … (the real worktree, sessions and sandbox modules, real srt); `daemon/integration/sessions-sandbox-worktree.test.ts` (through the real `session.create` handler, every module composed); `daemon/sandbox/r5.sandbox.test.ts` › R9.1 … | `covered` (macOS and Linux). |
| R9.2 | worktree 裡的 agent 可以讀取共享資料夾，但無法寫入 | `daemon/worktree/r9.real-sandbox.test.ts`; `daemon/sandbox/r5.sandbox.test.ts` › R9.2 …; `daemon/worktree/worktrees.test.ts` › D12 … | `covered` (macOS and Linux). Linux: the shared folder itself stays read-only, but the guest can remove or re-point the link to it in its own worktree (bubblewrap cannot mount on a symlink); the daemon then refuses the tampered link (`shared-link-tampered`) and never follows it (ARCHITECTURE §12). |
| R9.3 | 主人拒絕合併時，worktree 保持原狀 | `daemon/worktree/merge.test.ts` › R9.3 主人拒絕合併時，worktree 保持原狀 …; `web/src/features/worktree/merge-requests.test.tsx` (the reject flow in the UI); `web/e2e/smoke/acceptance.smoke.test.ts` › R9 合併 — … (real browsers on the built app: the host reviews the complete diff and merges, the file reaches everyone's tree; a rejected request leaves the worktree's files as they were) | `covered` |
| R9.4 | session 結束時詢問是否保留 worktree；保留的 worktree 之後可以重新開 session 繼續 | `daemon/worktree/r9.sessions.test.ts` › R9.4 … (real sessions module, real PTY); `web/src/features/agents/NewSessionDialog.test.tsx` › ending a session (R9.4 …) › asks whether to keep the worktree, and sends the answer explicitly | `covered` (the dialog in jsdom). |

## R11 主人控制台與操作紀錄（Prototype 基本版）

| # | 驗收標準 | Automated test (file › test) | Status |
|---|---|---|---|
| R11.1a | 主人能從控制台…踢掉任何成員 — the request the console sends | `r11.console.test.ts` › 主人能從控制台一鍵終止任何 session 或踢掉任何成員 — any member, one request each, visible in the audit log | `covered` |
| R11.1b | 主人能從控制台一鍵終止任何 session | `r11.console.test.ts` › 主人能從控制台一鍵終止任何 session; `daemon/sessions/kill.test.ts` › 主人能從控制台一鍵終止任何 session — …processes included | `covered` |
| R11.1c | 主人能從控制台一鍵… — the console's one-click buttons | `web/e2e/smoke/acceptance.smoke.test.ts` › 主人能從控制台一鍵終止任何 session 或踢掉任何成員 — … (real browsers on the built app: one click terminates a runner's session, whose browser then shows 「已被主人（…）終止」; one click and the confirmation kick the runner, whose browser shows the kicked screen); `web/src/features/console/console.test.tsx` (request, success, error in jsdom) | `covered` |
| R11.2a | 操作紀錄涵蓋…登入登出 | `r11.console.test.ts` › 操作紀錄涵蓋登入登出 — … | `covered` |
| R11.2 | 所有 R4–R9 定義的事件都出現在操作紀錄裡 | `r11.console.test.ts` › 所有 R4–R9 定義的事件都出現在操作紀錄裡 | `covered`: every action below is present AND carries the right actor (member, the host, the agent with its owner, or 「外部程式」) and target, and the suggestion entries carry the author, the text, the decision and the time (R6.3); checked since the review round (SPEC-10). One scenario over the real relay produces, and the console reads back, every R4–R9 action of ARCHITECTURE §5.8: `session.create/end/terminate/import-config`, `member.leave`, `sandbox.refused`, `suggest.create/edit/accept/reject/withdraw`, `file.write/create/rename/delete/upload/download`, `doc.edit`, `agent.edit`, `external.change`, `doc.conflict`, `doc.conflict-resolve`, `lock.acquire/release/denied/force-release`, `worktree.create/remove/merge.request/merge.approve/merge.reject`. |

---

## Known gaps

- Linux: the whole gate runs on Ubuntu 24.04 (VM and CI, "Linux verification" above), R5 and R9 included; guest
  terminals get SIGWINCH on resize and Ctrl-C interrupts the foreground program, not the session
  (`daemon/sessions/real-modules.test.ts`). Not run on Linux: a real `claude` (R5.3, R5.5, the hooks, the login
  process), keep-awake from a local desktop session, the installer on a fresh machine (`docs/OPEN-QUESTIONS.md` Q2).
  The Linux sandbox's residuals (a NEW host-only name below the top of the share in main-workspace guest sessions, a
  worktree's shared link, sockets in readable directories, the window before a protected entry the host changes while
  a guest runs ends that guest's processes) are listed in ARCHITECTURE §12 and need the owner's confirmation.
- Browsers other than Chrome (Safari/WebKit's wrapped device keys, Firefox) were not run.
- R7.2 at the full 10 GB is manual. R1.1: an installer exists, but no release is hosted, built for every platform or
  signed yet, so the fresh-machine timing cannot be done (`docs/RELEASING.md`).
- R5 「Linux 安裝程式自動處理 Ubuntu 24.04 以上版本的 AppArmor 限制」: `scripts/install.sh` installs bubblewrap / socat /
  ripgrep and an AppArmor profile for `/usr/bin/bwrap` with the host's consent, and `smurg host` reports at start
  whether guest sessions can run (with the fix commands). The profile it writes is the one the VM and CI run with
  (verified: with it the sandbox works under the stock restriction, without it `smurg host` reports `apparmor-userns`
  and the fix); srt's `apply-seccomp` never runs (no seccomp filter with `allowAllUnixSockets`), so it needs no
  profile. The installer's Linux branch itself (apt-get through sudo with consent) ran only against stand-ins; its
  AppArmor step decides by a bare bubblewrap run, and was run once against the VM's real system with the profile
  unloaded (it offered to write and load it again; before, a profile file that was not loaded was reported as done).
  Run as root it runs that check as the user sudo came from (else `nobody`): root's own bubblewrap passes without the
  profile (checked in the VM with a copy of bwrap the profile does not cover: refused as the user and through
  `runuser`, exit 0 as root), so `sudo sh install.sh` reported 「已生效」 for a host that stayed blocked (review RV-5).
- A real `claude` driving the web editor's lock banner is not automated (the banner is driven through the lock manager,
  as the hook socket does; the real `claude`'s lock requests are proven at the daemon level).
- R4 「登入引導」: a guest's subscription login (§11 D-12, on by default, owner's confirmation of the default pending,
  `docs/OPEN-QUESTIONS.md` Q12) is proven up to the login URL and the prompt for the pasted code, with the real `claude`
  2.1.220 and 2.1.283; completing it (pasting a code from a real account) is `manual`.
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
| 2 | With `CLAUDE_CONFIG_DIR` set, Claude Code may still read `~/.claude/CLAUDE.md`: the sandbox must block it | `daemon/sandbox/r5.claude.test.ts` › R5.5 … | `covered` (macOS) with a verified `claude` |
| 3 | srt under macOS Seatbelt works with node-pty | `daemon/sandbox/r5.sandbox.test.ts`, `daemon/worktree/r9.real-sandbox.test.ts`, `daemon/integration/sessions-sandbox-worktree.test.ts`, the built-app smoke test's sandboxed terminal (real srt + real PTY) | `covered` (macOS). The same tests run bubblewrap with node-pty on Linux, plus resize (SIGWINCH) and Ctrl-C in a guest terminal (`daemon/sessions/real-modules.test.ts`) |
| 4 | Automatic AppArmor setup on Ubuntu 24.04+ | `scripts/install.sh` (Linux branch), `smurg host`'s sandbox report with fix commands | `partly`: the profile it installs is verified on Ubuntu 24.04 (VM and CI run the sandbox with it; unloaded, the preflight names AppArmor and the fix); the installer's Linux branch on a fresh machine is `manual` (Q2) |
| 5 | Claude Code's login flow in a remote PTY (URL shown, code pasted) | `daemon/sessions/login.real.test.ts` › SPEC §13 item 5 / D-12 … (the real `claude` 2.1.220 and 2.1.283 in the guest's login process, real sandbox, mock API: the login URL and 「Paste code here if prompted」, the callback server on 127.0.0.1 only, the guest's own settings run nothing); `web/e2e/smoke/login.smoke.test.ts` › D-12 … (the same in a real browser); `daemon/sessions/claude-real.test.ts` › SPEC §13 item 5 … (inside an AGENT session it still fails: no listen right there); host sessions are not sandboxed | `partly`: shown up to the prompt for the code; pasting a code needs a real account (`manual`, §0 rule 2). The API-key path is covered by `claude-real.test.ts` and `LoginGuide.test.tsx` |
| 6 | node-pty inside the single executable | `packages/cli/test/sea.test.ts` (opt-in with `SMURG_SEA_BINARY`; last run on darwin-arm64 with this tree's build, finish-gate 2026-09-29: `scripts/build-sea.sh` 112 MiB, 3 of 3 tests, `smurg hook` starts in 31–32 ms) | `partly`: macOS arm64 only; not part of `pnpm test` |
| 7 | 上線前: Anthropic's consumer terms and Claude Code usage policy for the suggestion flow | — | launch phase, not in the Prototype |

## Measured values (local runs, macOS arm64, Node 22.22.1, shared machine)

| Criterion | Measured |
|---|---|
| R1.3a host laptop asleep → 「主人已離線」 | 5.5–5.7 s (client silence detector); the relay's own `host.offline` 5.87–5.89 s |
| R1.3b the web UI | 4.3 s |
| R2.2a kick → access lost | 3–20 ms |
| R2.2b kick → session processes and guest dir gone | 248–260 ms (real srt) |
| R4.4 channel.leave → guest dir gone | 126–224 ms |
| R7.1 co-editing | 5–7 ms (daemon, SDK clients); ~120 ms between two browsers, typing included |
| R7.2 | daemon: 200 MiB at ~100 MiB/s, interactive p95 ≤ 44 ms; browser: 1 GiB at 39 MiB/s, Chrome RSS flat |
| R7.3 web | transfer socket cut after 24.0 of 40 MiB; 20.0 MiB sent after the drop on 1 new socket (3 of 3 runs) |
| R3.1 tap completeness | every frame sent was recorded by the relay and nothing else; 0 marker hits; positive controls hit |
