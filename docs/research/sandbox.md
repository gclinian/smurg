# Research: Anthropic sandbox-runtime (srt) wrapping whole guest processes

Scope: SPEC R5 (whole section), R4 guest-session bullets, R9 (worktree scope and read-only shared-folder symlinks), and the SPEC section 13 rows about srt with Seatbelt/node-pty and `CLAUDE_CONFIG_DIR`.
Machine: macOS 26.5.1 (Darwin 25.5, arm64), Node v25.4.0 (also re-run on v22.22.1), Claude Code 2.1.220 (native binary).
Spike: `/private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/sandbox`. The final run had **134 automated checks, all passing** (8 suites, about 4 minutes).

> **Spike incident (read this first).** An early version of `src/verify-teardown.ts` identified a session's processes with a check that was too broad: "sandboxed, and able to read the session marker file". It then sent SIGKILL to every match. About 33 unrelated processes of the host user matched, because many macOS agents run under their own Seatbelt profiles with wide read access. They were killed at about 23:01:37. launchd restarted the system agents at once, including NotificationCenter, cfprefsd, tccd, trustd, secd, sharingd, cloudd, usernoted, WallpaperAgent, rapportd, nsurlsessiond and homed. Some of the killed pids may have been helpers of open apps that do not restart on their own. **Check that your open apps are still working.**
> The test now uses a marker+decoy check that only matches the target session (see Q4b). It also only ever signals command lines that the spike started itself. The same lesson applies to the daemon: never kill a pid based only on a sandbox check.

---

## Recommendation

1. **Use the srt library (`SandboxManager`) inside the daemon, not the `srt` CLI.**
   - Call `SandboxManager.initialize(base)` once per daemon. `base` holds the workspace-wide parts: the network allow-list, `strictAllowlist`, `deniedResolvedAddresses`, the single `allowUnixSockets` entry (the daemon socket) and `allowPty: true`.
   - For each guest process, call `wrapWithSandbox(cmd, '/bin/bash', perSession)`. `perSession` holds that guest's `filesystem`, `credentials` and `allowPty`.
   - Spawn the returned string with node-pty: `pty.spawn('/bin/bash', ['-c', wrapped], { env: cleanGuestEnv, cwd })`.
   - Why not the CLI:
     - It cannot be hardened (see point 3).
     - It costs one Node process per session.
     - It needs a Node runtime next to the SEA binary.
   - Both modes were verified to enforce the same policy.
2. **Use the guest policy from `buildGuestSandboxConfig()`** (verified code below). It expresses "deny home, re-allow sub-paths" with srt's read model:
   - `denyRead` lists broad regions: host home, `/Users`, `/Volumes`, `/private/tmp`, `/private/var/folders`.
   - `allowRead` re-opens only these: the project or worktree, the guest's own temp dir, the Claude binary, and the shared read-only dirs.
   - `allowRead` wins over `denyRead`.
   - Denies nested inside an allowed dir are emitted again after the allows. This hides `<project>/.smurg` and the host's personal `.claude/settings.local.json`.
   - Writes are allowed only to the project or worktree and the guest's temp dir. `denyWrite` protects the shared read-only dirs and every file that the host's **unsandboxed** tools run automatically (`.claude/settings*.json`, `.claude/{hooks,commands,agents,skills}`, `.mcp.json`, `.git/{hooks,config}`, `.envrc`, `.vscode`, `.idea`).
3. **Always harden the macOS profile** with `hardenMacosProfile()`. srt 0.0.77 always allows `mach-lookup` of `com.apple.SecurityServer` and `com.apple.securityd.xpc`. With those allowed, a guest can list the **host's login keychain**: 71 items were visible inside the sandbox, the same as outside. There is no config switch for this, so strip both lines from the generated profile and fail closed if they are not found. After stripping, 0 items are visible, and claude, curl, git and codesign still work.
4. **Give the guest a clean, whitelisted environment.** Never inherit the host's environment.
   - Set `HOME=<guest>/home`, `CLAUDE_CONFIG_DIR=<guest>/home/.claude`, `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, plus a session token.
   - Also add the login-override variables to `credentials.envVars` with mode `deny`, so srt runs `env -u` on them.
   - Re-set `TMPDIR` **inside** the wrapped command (`export TMPDIR=<guest>/tmp; exec claude`). srt forces `TMPDIR=/tmp/claude`.
5. **Run a functional self-test before opening every guest session, and refuse the session if it fails** (R5: no fallback).
   - Check `isSupportedPlatform()`, `isSandboxingEnabled()` and `checkDependenciesAsync().errors`, and on macOS that `/usr/bin/sandbox-exec` is executable.
   - Check that the wrapped string really contains `sandbox-exec` or `bwrap`.
   - Run a canary: the guest must fail to read a file in the denied home, fail to write there, and see `SANDBOX_RUNTIME=1`.
   - srt's own dependency API is not enough. On macOS it checks nothing. On Linux it does not detect the AppArmor user-namespace restriction.
6. **Never block the daemon's event loop.** Do not call `spawnSync` or `execSync` while guests run. srt's proxy and the daemon socket run inside the daemon process, and a blocked loop causes timeouts.
7. **Teardown (R2 kick).**
   - First call `pty.kill()`.
   - Then, on macOS, scan the user's pids with `sandbox_check()` using a per-session marker file plus a sibling decoy file (a tiny native helper) and SIGKILL the matches. `setsid()`-detached guest processes otherwise survive the kick and keep write access to the project (verified).
   - On Linux, srt already runs bwrap with `--new-session --die-with-parent --unshare-pid`: killing bwrap ends the guest's whole PID namespace (verified 2026-10-01; `--new-session` is dropped for a guest terminal's own fresh pty, see "Linux, verified 2026-10-01").
8. **Linux** (written before any Linux run; the measured behaviour and the hardening it needed are in "Linux, verified 2026-10-01").
   - The installer must ensure `bwrap`, `socat` and `rg` are installed, and must fix the Ubuntu 24.04+ AppArmor user-namespace restriction. The preferred fix is an AppArmor profile that grants `userns` to `/usr/bin/bwrap` and to srt's `apply-seccomp`. The fallback is the sysctl.
   - `allowUnixSockets` is **ignored on Linux**. Keeping the daemon Unix socket reachable needs `allowAllUnixSockets: true`, plus hiding `/run` and the other socket dirs with `denyRead`. The alternative verified on macOS is a loopback HTTP endpoint reached through srt's proxy (allow-list entry `127.0.0.1:<port>`).
9. **Pin srt to the exact version (`0.0.77`).** It is a "research preview": re-run this spike before any upgrade. The hardening step fails closed if the profile text changes.

---

## Dependencies (installed in the spike)

| package | version | used by | note |
|---|---|---|---|
| `@anthropic-ai/sandbox-runtime` | **0.0.77** (latest on 2026-09-27) | packages/daemon | pulls in `zod@3.25.76`, `commander@12.1.0`, `@pondwader/socks5-server@1.0.10`, `node-forge@1.4.0`. Ships `vendor/seccomp/{x64,arm64}/apply-seccomp`, `vendor/java-proxy-agent/srt-proxy-agent.jar` and `vendor/srt-win`. Engines: node >= 20.11 |
| `node-pty` | **1.1.0** | packages/daemon (and cli if attach runs locally) | prebuilt `prebuilds/darwin-arm64/pty.node` (N-API). Works on Node 25.4.0 **and** 22.22.1. The `spawn-helper` needs `chmod +x` after install (see Gotchas). |
| system: `/usr/bin/sandbox-exec` | macOS built-in | daemon (macOS) | not checked by srt's `checkDependencies()` |
| system: `bubblewrap`, `socat`, `ripgrep` | distro packages | daemon (Linux) | required by srt on Linux; not tested here |
| Xcode CLT `cc` | system | only for the spike's `native/sbcheck.c` | production would ship a prebuilt helper or N-API addon |

No global installs were made. `pnpm` was not needed; the spike uses `npm install` locally.

---

## Verified facts

All evidence below comes from `npm run verify:all` in the spike. Result JSON files are in `work/results/*.json`.

### Q1: srt config schema (installed 0.0.77)

Source: `dist/sandbox/sandbox-config.js` and `dist/sandbox/sandbox-manager.d.ts`.

- **`SandboxRuntimeConfig`**:
  - `network`, required:
    - `allowedDomains` (string[]; `example.com`, `*.example.com` or an optional `:port`)
    - `deniedDomains` (string[]; `*` is allowed here)
    - optional: `deniedDomainReasons`, `strictAllowlist`, `deniedResolvedAddresses` (CIDR list), `allowUnixSockets` (macOS only, matched by `subpath`), `allowAllUnixSockets`, `allowLocalBinding`, `allowMachLookup` (macOS only; adds lookups, cannot remove them), `httpProxyPort`, `socksProxyPort`, `mitmProxy`, `filterRequest` (function), `tlsTerminate`, `parentProxy`
  - `filesystem`, required:
    - `denyRead`, `allowWrite` and `denyWrite` (string[])
    - optional: `allowRead`, `allowGitConfig`, `disabled`
  - `credentials?`: `{ files?: [{ path, mode: 'deny'|'mask', ... }], envVars?: [{ name, mode }], allowPlaintextInject?, awsPairs?, sigv4? }`. On macOS, file `mask` degrades to `deny`.
  - Other optional fields: `ignoreViolations`, `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `ripgrep`, `mandatoryDenySearchDepth`, **`allowPty`** (macOS), `seccomp { applyPath, argv0 }`, `bwrapPath`, `socatPath`, `javaAgentJarPath`, `windows`, `git { safeDirectories }`.
- **Library API**:
  - `SandboxManager.initialize(cfg, askCb?, enableLogMonitor?)`
  - `wrapWithSandbox(cmd, binShell?, customConfig?, abortSignal?, { commandId, commandText }?) -> string`
  - `wrapWithSandboxArgv(...) -> { argv, env }`
  - `updateConfig(cfg)`: replaces the **entire** stored config (verified in `sandbox-manager.js`: `config = structuredClone(newConfig)`), but only the network parts reach **already-running** processes (their filesystem policy is baked into the Seatbelt profile at spawn). New wraps after the call use the whole new config. Always pass the full object.
  - `checkDependencies()`, `checkDependenciesAsync()`, `isSupportedPlatform()`, `isSandboxingEnabled()`
  - `getSandboxViolationStore()`, `annotateStderrWithSandboxFailures()`, `cleanupAfterCommand()`, `reset()`
  - `SandboxRuntimeConfigSchema` (zod) is exported; our policies validate against it (test "schema: ...").
- **`customConfig` merge rule**: it is merged **per field**, e.g. `customConfig.filesystem.allowWrite ?? config.filesystem.allowWrite`.
  - Per-session fields: `filesystem`, `credentials` and `allowPty`.
  - Workspace-wide, taken from the `initialize()` config: `network.*`, `allowUnixSockets`, `allowLocalBinding`, `allowMachLookup` and `ignoreViolations`. They are read from the global config (source: `sandbox-manager.js`, `wrapWithSandbox`).
- **CLI**: `srt --settings <file.json> -c '<cmd>'` or `srt --settings f -- cmd args`.
  - A missing or invalid `--settings` file makes it refuse to run (verified: exit 1 with "... does not exist.").
  - `--control-fd <n>` streams JSON-lines config updates; only the network lists take effect live.
  - The same guest policy through the CLI: reading the fake ssh key fails, `curl example.com` returns 200, and `nc -U daemon.sock` gets a reply.

### Q2 and Q3: guest policy on macOS Seatbelt (`src/verify-fs-net.ts`, 81/81)

The fixture puts the project **inside** a simulated host home (`work/fakehome/proj`), because in practice the project usually lives under the home. The **real** `/Users/gcman` is also in `denyRead`, so the real `~/.ssh` and `~/.claude` are covered too. Secret probes report exit codes only.

The read section of the generated profile (paths shortened; Seatbelt applies the last matching rule):

```
(allow file-read*)
(deny file-read* (subpath "<HOME>") (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders")
                 (subpath "<HOME>/proj/.claude/settings.local.json") (subpath "<HOME>/proj/CLAUDE.local.md") (subpath "<HOME>/proj/.smurg"))
(allow file-read* (subpath "<HOME>/proj") (subpath "<HOME>/.smurg/guests/alice") (subpath "<HOME>/proj/data") ...)
(deny file-read* (subpath "<HOME>/proj/.claude/settings.local.json") (subpath "<HOME>/proj/CLAUDE.local.md") (subpath "<HOME>/proj/.smurg"))  ; nested denies re-emitted
(allow file-read-metadata (vnode-type DIRECTORY))
```

| # | check | result |
|---|---|---|
| a | `ls ~/.ssh`, `cat ~/.ssh/id_*`, `ls ~/.claude`, `cat ~/.claude/CLAUDE.md`, `cat ~/.claude.json` (real home) | exit 1 (control outside the sandbox: exit 0) |
| a | fake-home `~/.ssh/id_ed25519` and `~/.claude/CLAUDE.md`, with the project inside that home | exit 1 |
| a | host Claude Code tmp dir `/private/tmp/claude-501` | exit 1 |
| a | **keychain** `security dump-keychain` item count | **srt default profile: 71 items (same as outside)**; hardened profile: 0 |
| b | read or list another guest's temp dir (bob) | exit 1 (control: exit 0); own temp dir readable |
| c | write into the home, the real home, the spike dir, the other guest's dir, `/usr/local` | exit 1 |
| c | `/private/tmp/claude` (srt default write path) | create allowed, `rm` refused, not readable under our `/private/tmp` deny |
| d | write, rm inside the project; write `$TMPDIR` (guest tmp) | exit 0 |
| d | write `<project>/.claude/settings.json`, `.git/hooks/pre-commit`, `.mcp.json`, `.envrc` | exit 1 |
| d | `<project>/.claude/settings.local.json` hidden from the guest; `.claude/settings.json` readable | ok |
| d | symlink planted in the project pointing at `~/.ssh`, then `cat` through it | exit 1 (Seatbelt checks the resolved path) |
| e | `curl https://example.com` (allow-listed) -> 200; `https://api.anthropic.com` -> 404 (reachable) | ok |
| e | `curl https://example.org` (not listed) | exit 56, "CONNECT tunnel failed, response 403" |
| e | `curl http://neverssl.com` (plain HTTP, not listed) | proxy answers **403** |
| e | `curl --noproxy '*' https://example.com` (bypassing the proxy) | exit 6, cannot resolve (no DNS or direct egress) |
| e | `nc -z 1.1.1.1 443` | exit 1 |
| e | daemon loopback HTTP port through the proxy with allow-list entry `127.0.0.1:<port>` | ok; a direct connection is blocked (exit 7) |
| f | `nc -U daemon.sock` (in `allowUnixSockets`) | reply received |
| f | `nc -U other.sock` (not listed) | exit 1 (control: ok); `/var/run/syslog` exit 1 |
| g | shared mode: `<project>/data` read ok; append, create, rm, `mv data data2` all exit 1 | ok |
| g | worktree mode: `worktrees/s1/data -> ../../../data` (RO symlink): read ok, append and create exit 1 | ok |
| R9 | shared mode: other sessions' worktrees `<project>/.smurg/...` not readable or writable | ok |
| R9 | worktree mode: main workspace and worktree s2 not readable or writable; own worktree writable | ok |
| R9 | worktree mode: `git status`, `git add`, `git commit` on its own branch succeed; `git update-ref refs/heads/main` fails; `git config --local` fails | ok |
| R9 | worktree mode: guest **can** write arbitrary loose files into the shared `<project>/.git/objects` (by design — `allowWrite` includes `objects/`); cannot overwrite `.git/packed-refs`, `.git/refs/heads/main`, or `.git/config` | verified (see Verification §, and the cleaner `git clone --shared` alternative) |
| R4 | `ANTHROPIC_API_KEY` set in the spawning environment is not visible inside | ok |
| info | `stat` of a denied **directory** succeeds (`file-read-metadata` on dirs is allowed); `stat` of a denied file fails | existence of dirs leaks, contents do not |
| info | `/bin/ps` (setuid) cannot run inside (`Operation not permitted`) | |

Other suites:

- Concurrent guests on one `SandboxManager` (`src/verify-multi.ts`, 7/7). Alice and Bob run overlapping 2-second commands with different `customConfig`. Each reads only their own temp dir.
- Live allow-list change (same suite). `updateConfig()` adding `example.org` applies to a process that was **already running** (its curl after 3 seconds returns 200). Removing it blocks it again.

### Q4: srt under node-pty (`src/verify-pty.ts`, 12/12, on Node 25.4.0 and 22.22.1)

- `pty.spawn('/bin/bash', ['-c', wrapped], {cols: 80, rows: 24})` produces a prompt.
- `stty size` reports `24 80`.
- Input produces output.
- `p.resize(132, 40)` gives `stty size` = `40 132`, and the sandboxed shell's `trap ... WINCH` fires.
- Raw mode works (`stty raw -echo; stty -raw echo` returns 0).
- Ctrl-C (`\x03`) interrupts `sleep 100`.
- `exit 7` gives node-pty `onExit` `{exitCode: 7}`.
- The sandbox still applies inside the PTY.
- **`allowPty` is required.** Without it, every termios ioctl fails with `stty: TIOCGETD: Operation not permitted`, so a TUI cannot enter raw mode.
- Teardown:
  - `pty.kill('SIGHUP')` ends the session and its background job.
  - **But a guest process that runs `fork()`+`setsid()` survives and still wrote into the project 4 seconds later.**

### Q4b: finding every process of a session (`src/verify-teardown.ts`, 9/9; `native/sbcheck.c`)

- `sandbox_check(pid, "file-read-data", SANDBOX_FILTER_PATH|NO_REPORT, path)` (libsystem_sandbox) answers "can pid X read path P under its sandbox".
- Each session gets `allowRead: [~/.smurg/markers/<sessionId>]`. The marker file **must exist**; a missing path is reported as denied.
- A sibling `~/.smurg/markers/decoy` is in no policy.
- The rule `sandboxed && marker readable && !decoy readable` found exactly Alice's shell, background job and detached process.
  - It did not match Bob's sandboxed process or unsandboxed host processes.
  - After the kill, nothing wrote to the project.
- The naive rule `sandboxed && marker readable` matched **29** pids, most of them unrelated macOS agents. This is how the incident above happened.

### Q5: the real `claude` binary under the sandbox (`src/verify-claude.ts` 8/8, `src/verify-write-tool.ts` 5/5)

- `claude --version` under the hardened guest sandbox prints `2.1.220 (Claude Code)`.
  - The only Claude path needed is the resolved binary file `~/.local/share/claude/versions/2.1.220`: one Mach-O arm64 file, `allowRead` of that single file.
- `claude auth status --json` returns `loggedIn=false` in all three cases:
  - the hardened profile
  - the srt default profile
  - no sandbox, with only guest `HOME`/`CLAUDE_CONFIG_DIR`
- `claude -p` with a **fake** key reaches the API through the proxy: "Failed to authenticate. API Error: 401 API key is invalid." This means settings, CLAUDE.md discovery and the API client all work inside the sandbox.
- The interactive TUI in a PTY renders the first-run screen ("Welcome to Claude Code v2.1.220 ... Choose the text style") and survives a resize.
- The violation log (macOS log monitor) while claude ran shows **no access attempt to the host `~/.claude`** when both `HOME` and `CLAUDE_CONFIG_DIR` are redirected. Even if one happened, it would be denied. This addresses the SPEC section 13 row about `CLAUDE_CONFIG_DIR`.
- Denials that were harmless:
  - CoreFoundation reading the real `~/Library/Preferences/.GlobalPreferences*.plist` and `~/.CFUserTextEncoding`
  - the git xcrun shim reading Xcode prefs and caches in `/private/var/folders`
  - listing `~/.local/share/claude/versions`
  - mach lookups (`configd`, `FSEvents`, `coreservicesd`, `SecurityServer` and `securityd.xpc`, the last two blocked by us)
  - `/var/run/syslog`
  - network requests to `http-intake.logs.us5.datadoghq.com:443` and `raw.githubusercontent.com:443`
- **R5 acceptance "Edit and Write tools are restricted too", verified with the real binary.**
  - Setup: a local mock of the Messages API (`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, reached through srt's proxy) makes the sandboxed claude call its tools. Claude's own permission layer is off (`--dangerously-skip-permissions`), so only the OS sandbox is being tested.
  - `Read ~/.ssh/id_ed25519` fails with `EPERM: operation not permitted, stat ...`.
  - `Write` outside the project fails with `EPERM ... open '<file>.tmp.<pid>.<rand>'`, and no file is created.
  - `Write` inside the project succeeds.
  - `Edit` on the read-only shared folder fails with `EPERM`.
  - The same harness can serve as the automated R5 test in CI.

### Q6: detecting "sandbox cannot start" (`src/check-deps.ts`, 12/12)

- On this Mac, `isSupportedPlatform()` returns true and `checkDependencies()` returns `{errors: [], warnings: []}`.
- `checkDependenciesAsync({command: 'definitely-not-ripgrep'})` also returns no errors on macOS; ripgrep is checked only on Linux. `/usr/bin/sandbox-exec` is **not** checked, so the daemon must check it itself.
- `initialize()` throws `Sandbox dependencies not available: <errors>` when `checkDependencies` has errors (source).
- **Fail-open footguns** (verified):
  - `wrapWithSandbox()` **before `initialize()`** still wraps the command, but with `(allow network*)` and no read denies.
  - A `customConfig` with no `network` block before initialize also gets `(allow network*)`.
  - So the daemon must gate on `isSandboxingEnabled()` and on the self-test.
- If `sandbox-exec` is missing (simulated by rewriting the path), `env` exits 127 and the command never runs. The wrapper fails closed; there is no silent unsandboxed fallback.
- The self-test refuses in both simulated failures: a missing sandbox-exec, and a policy that forgot to hide the home (the canary read succeeds, exit 21).

---

## Linux, verified 2026-10-01

Machine: a Lima VM with Ubuntu 24.04.2 LTS, arm64, kernel 6.8.0-55, bubblewrap 0.9.0, socat 1.8.0.0, ripgrep 14.1.0,
Node 22.22.1, srt 0.0.77. `kernel.apparmor_restrict_unprivileged_userns=1` (the stock value), with the
`smurg-bwrap` AppArmor profile loaded. It is the profile that `scripts/install.sh`, CI and `smurg host` print:
`profile smurg-bwrap /usr/bin/bwrap flags=(unconfined) { userns, }`. No `claude` is installed on this machine, so the
real-claude tests skip. The first CI run (GitHub Actions ubuntu-24.04, x64) failed 27 tests. Every failure in the
sandbox, sessions and worktree tests was reproduced in this VM and fixed. The code is in `packages/daemon/src/sandbox/`
(`harden.ts` "Linux", `policy.ts`, `service.ts`, `checks.ts`).

### What srt generates on Linux

For a guest process, srt 0.0.77 writes one `bwrap` command. The options appear in this order:
`--new-session --die-with-parent`, then `--unsetenv` / `--setenv` pairs and `--unshare-net`. Next comes a writable bind
of its bridge socket, then `--ro-bind / /` and a writable bind of each write root. Then there is one `--tmpfs` for every
read-denied directory that exists (`/home`, `/root`, `/tmp`, `/run`, `/mnt`, `/media`, `/var/tmp`, `/var/snap`,
`<share>/.smurg`, …; `/var/run` is a link to `/run`, and absent entries are skipped). The `allowRead` / `allowWrite`
carve-outs are bound back on top of those. The write denies follow as read-only binds, and after them
`--dev /dev --unshare-pid --unshare-user --cap-drop ALL --proc /proc -- /bin/bash -c '<command>'`. When the mounts do
not fit on one command line, srt puts them in an arguments file (`/bin/sh -c 'exec 9<"$1" …' srt-args
/proc/<pid>/fd/<n> bwrap … --args 9`).

Inside the sandbox, measured:

- The uid is the host user's.
- `CapEff` is 0 and `NoNewPrivs` is 1.
- pid 1 is bwrap.
- `Seccomp` is 0: with `allowAllUnixSockets: true`, srt applies no seccomp filter at all ("Skipping seccomp filter").
  So srt's `apply-seccomp` helper never runs and needs no AppArmor profile of its own.
- The network namespace has only `lo`. `socat` inside forwards TCP 3128 and 1080 to srt's bridge socket, which leads
  to the proxy in the daemon.

### What was wrong, and the fixes

1. **The host home was listable** (self-test exit 23, "the host home could be listed").
   - Cause 1: bubblewrap creates the directories that lead to a carve-out on the read-deny tmpfs. The host home, the
     state dir and `<stateDir>/guests` then exist as a skeleton that anyone can list. In worktree mode the share does
     too. A listing shows the names on the way to the carve-outs, such as other guests' ids.
   - Cause 2: every such tmpfs was writable, so a guest could create files in `/tmp`, in the host home, or in
     `<share>/.smurg`. They were private to the sandbox, but "writes only to the roots" did not hold.
   - Cause 3: the sandboxed process runs under the unconfined `smurg-bwrap` profile, which allows user namespaces. In
     a nested one (`unshare -Ur ls`) it holds `CAP_DAC_READ_SEARCH` over its own files and could list the skeleton
     anyway.
   - Fix: `hardenLinuxCommand` appends `--disable-userns` before bwrap's `--`. It adds `--chmod 0111` on every directory
     that lives on a read-deny tmpfs: the tmpfs roots, and the directories bubblewrap creates on them for a later mount.
     Lookup by path still works, but listing does not. It also adds `--remount-ro` on every such tmpfs, so nothing can
     be created there and the modes cannot be changed back.
   - These options need bubblewrap 0.8 or later (`--disable-userns` is the newest of them). `checks.ts`
     `checkBwrapFeatures` reads `bwrap --help`, and an older bubblewrap is refused up front (`dependency-missing`).
     Ubuntu 22.04 ships 0.6.1, so it is refused; Debian 12 ships 0.8.0 and Ubuntu 24.04 0.9.0.
   - Every bwrap argument, including those in the arguments file, is checked against the options srt 0.0.77 writes.
     The check fails closed: `--dev-bind`, a writable `/`, a missing `--unshare-net` / `--unshare-user` /
     `--unshare-pid` / `--cap-drop ALL` / fresh `/proc` and `/dev` are all refused.
   - Measured after the fix: the host home, the state dir, another guest's dir, `/tmp`, `/home` and `/run` cannot be
     listed, and `/tmp` and the host home cannot be written. `chmod 755 /tmp` and `unshare -Ur` fail. The canary
     self-test passes.
2. **The refusal blamed AppArmor for any failed self-test while the sysctl was 1.** Now AppArmor is named only when a
   bare `bwrap --unshare-user --unshare-net --ro-bind / / -- /bin/true` fails with "Permission denied" or "Operation not
   permitted" (`bwrapUsernsBlocked`).
   - Verified by unloading the profile (`apparmor_parser -R /etc/apparmor.d/smurg-bwrap`). The bare bwrap then fails
     with `loopback: Failed RTM_NEWADDR: Operation not permitted`. The preflight returns `apparmor-userns` with the
     host's fix in the detail, and `smurg host` prints the profile commands.
   - With the profile reloaded the preflight is ok again.
   - A copy of bwrap that no profile covers fails earlier, with `setting up uid map: Permission denied`.
3. **Every guest was offline.** srt binds its bridge socket (`/tmp/claude-http-<id>.sock`) BEFORE the file-system
   mounts, so the `/tmp` tmpfs hid it and every request failed, allow-listed ones included.
   - Fix: the service asks srt for its bridge sockets (`getLinuxHttpSocketPath` / `getLinuxSocksSocketPath`) and adds
     them to every guest policy as read-only file carve-outs (`proxySocketPaths`).
   - The preflight refuses (`init-failed`) when srt reports no bridge socket.
4. **`--new-session` broke guest terminals.** Measured with node-pty: resizing sent no SIGWINCH, so a TUI never
   redrew. There was no job control, and Ctrl-C reached bubblewrap itself, whose process group was the foreground one.
   That ended the whole session.
   - Fix (`LINUX_SESSION_PRELUDE`): the outer shell drops `--new-session` only when it is a session leader with a
     controlling terminal and stdin is a terminal. That is exactly node-pty's fresh pty, which no other session holds,
     so TIOCSTI can only reach the guest's own input.
   - Spawned any other way (child_process, stdin not a terminal), bwrap keeps `--new-session`.
   - Test: `test/sessions/real-modules.test.ts`. A resize reaches the program as SIGWINCH with the new size. Ctrl-C
     interrupts a trapping program and a plain `sleep` (exit 130), and the session goes on. With `--new-session` forced
     back, the same test fails (no SIGWINCH).
5. **bubblewrap's mount points were left in the host's project.**
   - For an absent write-denied name, srt mounts `/dev/null` on it, and bubblewrap creates the mount point on the HOST
     as an empty 0444 file: `<share>/.claude`, `.git`, `.vscode`, `.idea`, `.mcp.json`, `.envrc`.
   - The host's own tools broke on them: `mkdir .claude` gave EEXIST, and git failed with "invalid gitfile format".
     `git add --all` in a worktree staged them.
   - srt removes the mount points only through `cleanupAfterCommand()`, once its count of running wraps is back to
     zero, and the daemon never called it after a session process.
   - Fixes:
     - For each absent DIRECTORY name the service makes an empty directory of its own before it wraps
       (`service.ts holdPlaceholderDirs`), and bubblewrap binds it read-only. The host sees an ordinary empty
       directory; git ignores an empty `.git/` and never stages an empty directory. (The first fix, a denied child
       that never exists so that srt chose its empty-directory form, raced: srt decides the form on each wrap and
       removes its mount points when its count reaches zero, so another guest's process ending during a `wrap()`
       brought the 0444 files back for a whole session, and a start in one root while a guest ran in another aborted
       in bubblewrap. Review RCR-1, 2026-10-01; `test/sandbox/placeholders.real.test.ts`.)
     - The service keeps its directories while any `wrap()` is in flight or any WrappedCommand it handed out is
       unreleased, and removes them (still empty, same inode) synchronously once none is.
     - `SandboxService.release()` is called by the sessions module whenever a guest process exits or never started.
       The self-tests release their own wraps.
     - The service records the directories, and the absent file names srt will hold, before either can exist (state
       document `sandbox-placeholders`) and empties the record once nothing runs. The next daemon removes the recorded
       directories that are still empty and the recorded files that still look like srt's leftovers (empty, no write
       bit, one link) before its first sandbox, which covers a daemon that died without cleaning up.
     - The file names `.mcp.json` and `.envrc` keep srt's file form while a guest process runs.
       `worktree/stage-commit.ts` keeps them out of a merge. Since review RV-2 the service makes that empty 0444 file
       itself when it hands a command out (item 11).
     - Review RV-3: ext4 hands a freed inode number straight back (a probe: `rmdir` + `mkdir` gave the same number 20
       times of 20), so a host's own empty directory made in place of a placeholder while a guest ran had the same
       dev / ino and was removed with it. The service holds an `O_PATH` descriptor on each placeholder until it removes
       it: 0 times of 20.
     - srt resolves its own mandatory denies against the daemon's working directory; `smurg host` runs its daemon
       from `<stateDir>/cwd`, and a daemon whose cwd is in a write root is refused (`daemon-cwd`, review F1).
6. **srt drops write-deny globs on Linux**: bubblewrap mounts concrete paths only, so `<root>/**/.claude` protected
   nothing.
   - The service now walks the root and adds every EXISTING host-only entry below the top as a literal deny (a
     read-only bind; it follows no symlink and skips `node_modules`). More than 1000 such entries refuse the session.
   - A NEW host-only name below the top (`sub/.claude/settings.json`, `sub/.mcp.json`) cannot be blocked with mounts:
     a residual (ARCHITECTURE §12).
   - srt drops a Linux write deny when its PATH holds `*`, `?`, `[` or `]` anywhere (`sandbox-manager.js`
     `stripWriteGlobs` / `getFsWriteConfig`, a debug line only), so an existing entry such as `ev*il/.git` or
     `app/[slug]/.claude` cannot be denied through srt. Appending our own `--ro-bind` for it in the hardening was
     rejected: a read-only bind of the host's directory would bring back the read masks srt put below it
     (`settings.local.json`, `.envrc`, `CLAUDE.local.md`), which srt re-applies only for its own binds. Such entries are
     left out and logged; before (review attack F1, 2026-10-01) the policy refused the path, and with it every later
     guest session in that root (`dos.ts`: `ev*il`, `brack[et]`, `nl\nline`, `ctl\x01x` → refused; `plain`, `sp ace`,
     `;`, backtick, `$` → started, nothing injected).
   - Control characters are fine on Linux: srt single-quotes a word with a newline on bubblewrap's command line and
     NUL-separates its arguments file, and the hardening parses both byte for byte (`harden.test.ts` runs the hardened
     command through bash into a stand-in bwrap). A name that is not UTF-8 cannot be given at all (no string spells
     it); srt's read-deny globs do not reach below it either: `.envrc` and `CLAUDE.local.md` there were readable
     (`test/sandbox/odd-names.real.test.ts`).
   - macOS is not affected: the walk is Linux-only, and Seatbelt's `<root>/**/<name>` patterns denied every planted
     entry below `ev*il`, `brack[et]`, `q?m`, `nl\nline`, `cr\rx`, `tab\tx`, `ctl\x01x`, `del\x7fx` (measured).
7. **R9.2 read-only shared links**: bubblewrap can only mount on what a symlink points at, never on the link. The
   target stays read-only, but a guest can remove or re-point the link, which is an entry of its own writable worktree.
   The daemon's path guard refuses a re-pointed shared link (`shared-link-tampered`), so the host never follows it.
8. **Unix sockets**: `allowUnixSockets` is ignored on Linux, so srt uses `allowAllUnixSockets: true`. Sockets are
   kept away by hiding the directories that hold them. `/var/snap` (snap LXD's `unix.socket`; Ubuntu puts its first
   user in the `lxd` group), `/var/lib/lxd` and `/var/lib/incus` were added to `/run`, `/tmp` and the others.
   - Abstract sockets belong to the network namespace. Measured: a host abstract socket answers the host and not a
     guest (`socat ABSTRACT-CONNECT`).
   - The hook socket (a read-only file carve-out) answers, while the daemon's control socket and another socket in the
     run dir do not.
   - A socket in a directory the guest can read (the share, the guest dir) stays connectable: a residual.
9. **Other things srt does**:
   - srt binds its own `/tmp/claude` WRITABLE whenever that directory exists on the host (not configurable). It would
     be a scratch dir shared by every guest and by the host's own sandboxed Claude Code. The hardening puts a tmpfs of
     its own over any writable bind that is neither a write root nor a bridge socket (then hidden and read-only).
   - srt's `java-proxy-agent.jar` read carve-out creates a skeleton under the daemon's `node_modules`. It is hidden like
     every other skeleton.
10. **Resources, the kernel surface and the mount table** (review attack F2–F4, 2026-10-01):
    - `ulimit -a` inside a guest sandbox was the host user's own: max user processes 31414, memory, virtual memory,
      file size and CPU time unlimited; `/proc/self/cgroup` the daemon's own
      (`/user.slice/user-501.slice/session-2.scope`). bubblewrap and srt set no resource limit. Fix (partial): the
      sandboxed shell runs `ulimit -u 4096` first. Since Linux 5.14 RLIMIT_NPROC is counted per user namespace
      (ucounts), and bubblewrap has made the guest's by then: with the host user at 141 tasks, a sandbox limited to 32
      still started 27 processes; soft and hard read 32 inside and `ulimit -u 100000` failed. The daemon leaves it out
      on an older kernel (it would count the host user's tasks). No fork bomb was run.
    - macOS, inside a guest sandbox: `ulimit -u` 2666 (= `kern.maxprocperuid`, the host user's), the rest unlimited,
      as outside. Seatbelt sets nothing.
    - `Seccomp: 0` (above): every system call an unprivileged user may make reaches the kernel.
    - `/proc/self/mountinfo` lists the host-side path of every mount: the share, the guest dir
      (`<stateDir>/guests/<workspace id>/<key>`), the settings dir, the `smurg` command's paths, srt's bridge socket
      and install path (`/home/<host user>/…/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar`), and the
      host's own mounts through the recursive `--ro-bind / /`. A guest cannot mount over it (`mount: must be
      superuser`).

11. **The host changes a protected entry while a guest runs** (reviews RV-1, RV-2, diff-review E1–E7, 2026-10-01).
    Every protection above is a mount on a directory entry as it was when bubblewrap started. Measured on the reviewed
    tree and on b97cdee: the host's atomic save (temp file renamed over) of `.envrc` and `.claude/settings.local.json`
    let the running guest read the new content; files the host created after the start (`.claude/settings.local.json`,
    `sub/.envrc`, `CLAUDE.local.md`) were readable at once (srt expands its read-deny globs at the start and mounts
    nothing on an absent path); the host's `rmdir` of the empty `.claude` placeholder, or a rename of its own `.claude`
    (`git switch`), let the guest plant `.claude/settings.json`; an atomic save of `.mcp.json` let it rewrite the file.
    Nothing a mount does can follow the entry.
    - The fix is a detection (`sandbox/guard.ts`, ARCHITECTURE §7.6 "Linux, protected entries while a guest runs"):
      the service records every protected entry of a root with guest processes (top-level names, the walk's nested
      entries, `settings.local.json` in each `.claude`, nested `CLAUDE.local.md`), holding an `O_PATH` descriptor on
      each existing one (item 5), and compares on every file-watcher batch (a protected name at any depth, the subtree
      of a directory that appeared: @parcel/watcher on inotify reports a directory moved in, or made and filled at
      once, as one `create` of the directory), every 2 s (`.git`, which the watcher ignores), on the next wrap and at
      the last release. A difference revokes every command handed out for the root (`SandboxService.onRevoked`; the
      sessions module ends them) and refuses a wrap in flight there.
    - What @parcel/watcher 2.6.0 reports (probe in the VM): an in-place write → `update`; a rename over → `create`;
      `rmdir` + `mkdir`, or `unlink` + create, in one batch → `update`; a file made and removed in one batch →
      nothing; a directory renamed → `delete` of the old name, `create` of the new one, nothing for what it holds;
      `.git` at any depth → nothing (the daemon's ignore list).
    - srt's own 0444 mount point for an absent `.mcp.json` / `.envrc` appears when bubblewrap starts and goes when
      srt's count of running wraps is zero. The host removing it while the guest runs lifts the deny (the guest could
      then create the name); to tell that from srt's cleanup the guard must have seen the file, and a removal within
      the ~50 ms before the first watcher batch left no event at all. So the service makes the file itself when it
      hands a command out (as bubblewrap would; srt then tracks and removes it with its other mount points).
    - Measured with real bubblewrap and the real watcher (`test/sandbox/placeholders.real.test.ts`): the guest process
      was revoked 10–110 ms after the host's change (E1, E2, E3, E5, E6, E7, srt's file removed); `.git` replaced:
      within the poll (300 ms in the test, 2 s in the daemon). An in-place edit revoked nothing, other guests coming
      and going beside a running one revoked nothing, and a wrap held at its self-test while the host saved `.envrc`
      was refused (`protected-changed`).

### Network and the login process (D-12)

Every guest process has its own network namespace. It can bind and listen there, on its own loopback, because the
namespace has no LAN address. Measured (`test/sandbox/network-listen.real.test.ts`, Linux describe):

- A listener on 0.0.0.0 inside the namespace is reachable neither from the host's 127.0.0.1 nor from its LAN address.
- Binding the host's LAN address inside fails.
- A service on the host's loopback cannot be reached directly. An allow-listed one is reached through the proxy (200),
  and a forbidden one gets 403.

The Claude login process gets exactly the same rules. On Linux it needs no exec allow-list, unlike macOS, where
Seatbelt's `localhost` admits every address. The hardening refuses any guest command without `--unshare-net`.
`test/sessions/login.real.test.ts` covers it: the stand-in login listens on 0.0.0.0 and connects to it from inside,
while the host cannot connect.

### Timings (this VM)

| what | time |
|---|---|
| agent wrap, including the canary and the hook self-test | ~250 ms |
| a kicked guest's processes gone | 78 ms |

### Residuals on Linux (ARCHITECTURE §12)

- A new host-only name below the top of the root cannot be blocked (item 6), nor an existing one whose path holds a
  glob character or is not UTF-8 (logged).
- No memory, disk or CPU limit; 4096 tasks per sandbox (item 10). No seccomp filter. The mount table shows host paths.
- A guest can remove or re-point a shared link in its own worktree (item 7).
- A socket in a readable directory is connectable (item 8).
- While a guest process runs, the host's project shows bubblewrap's placeholders: empty directories for absent
  `.claude` / `.git` / `.vscode` / `.idea`, and empty read-only files for absent `.mcp.json` / `.envrc`.
- A protected entry the host replaces, removes or creates while a guest runs is seen by the guest until the daemon
  notices and ends its processes (item 11: 10–110 ms measured; `.git` within 2 s); not noticed in `node_modules`,
  for a new nested `.git`, or without the file watcher.
- The real-sandbox tests ran on arm64 only. x64 is CI's.

### Tests that run on Linux

- `test/sandbox/r5.sandbox.test.ts` (R5, R9 at the sandbox level)
- `odd-names.real.test.ts` (guest-made odd names, the task limit; its odd-name half runs on macOS too)
- `placeholders.real.test.ts` (bubblewrap's mount points, the daemon's working directory, and item 11 with the real
  file watcher); `guard.test.ts` runs on both platforms (no sandbox)
- `hook-selftest.real.test.ts`
- `network-listen.real.test.ts` (Linux describe)
- `service.test.ts`
- `harden.test.ts`
- `test/sessions/real-modules.test.ts`
- `login.real.test.ts`
- `test/worktree/r9.real-sandbox.test.ts`
- `test/integration/sessions-sandbox-worktree.test.ts`

The profile-text tests of the login process (`login-policy.real`, `login-profile.real`) are about Seatbelt and stay
macOS-only.

---

## Unverified / could not test here

- **Everything on Linux** (Q7). The notes below come from the srt 0.0.77 README and `dist/sandbox/linux-sandbox-utils.js`, not from runs. **Superseded by "Linux, verified 2026-10-01" above**: the `--new-session` risk was real and is fixed, `apply-seccomp` never runs with `allowAllUnixSockets`, and the AppArmor profile is verified.
  - **Dependencies:** `bubblewrap`, `socat`, `ripgrep`, and optionally the prebuilt `apply-seccomp` for x64/arm64. `checkLinuxDependencies()` reports missing `bwrap`/`socat`. `rg` is checked in `checkDependenciesCommon`. A missing seccomp helper is only a *warning* ("unix socket access not restricted").
  - **Ubuntu 24.04+ AppArmor:**
    - `kernel.apparmor_restrict_unprivileged_userns=1` lets `unshare(CLONE_NEWUSER)` succeed but strips capabilities, so bwrap and the seccomp helper's nested namespace fail.
    - srt does **not** detect this in `checkDependencies()` (grep finds no `apparmor` probe). It is only a README note, so it surfaces at runtime.
    - Installer:
      1. `apt-get install bubblewrap socat ripgrep`.
      2. Detect the restriction with `sysctl -n kernel.apparmor_restrict_unprivileged_userns` (1 means restricted).
      3. Preferred: install `/etc/apparmor.d/smurg-bwrap` containing `abi <abi/4.0>, include <tunables/global>  profile smurg-bwrap /usr/bin/bwrap flags=(unconfined) { userns, }`, add a similar profile for the shipped `apply-seccomp` path, then run `apparmor_parser -r`.
      4. Fallback: `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` persisted in `/etc/sysctl.d/`. This is weaker system-wide; tell the host.
      5. Always run the functional self-test afterwards.
      6. Check whether the distro already ships a bwrap profile.
  - **Root:** running as root needs `CAP_SETFCAP`. Run the daemon as the normal user.
  - **`allowUnixSockets` is ignored on Linux:** seccomp blocks every `socket(AF_UNIX)`. To keep the daemon socket, set `allowAllUnixSockets: true` **and** `denyRead` `/run`, `/var/run`, `/tmp/.X11-unix`, `/run/user/<uid>` (dbus, systemd --user, ssh-agent, gpg) and `docker.sock`. Abstract sockets are isolated by `--unshare-net`. The alternative, verified on macOS only, is a loopback HTTP endpoint through the proxy.
  - **bwrap is always started with `--new-session --die-with-parent --unshare-pid`:**
    - Good: killing bwrap kills the whole guest PID namespace, which fixes the macOS "setsid survivor" problem.
    - Unverified risk: with `--new-session` the guest has no controlling TTY, so **SIGWINCH on resize may not reach the TUI**, and job control and ISIG Ctrl-C behave differently. Test this on Linux. A possible fix is for the daemon to send SIGWINCH to bwrap's children after `pty.resize()`.
  - Glob semantics, the "mandatory deny" scan (ripgrep, depth 3, existing files only) and write-deny mount points are different on Linux (README).
- **Claude Code login inside the sandbox** (OAuth URL shown, code pasted). Not tested; it needs a real account. With the keychain blocked, credentials are **expected** to fall back to `$CLAUDE_CONFIG_DIR/.credentials.json` inside the guest dir, which R4 deletes on leave. Verify this with a real login.
- Whether a sandboxed guest using the **srt default** profile can read *secret data* of keychain items whose ACL trusts `/usr/bin/security`. Only metadata enumeration was tested; secrets were deliberately not requested. The hardening removes the whole channel either way.
- npm-installed Claude Code (node plus `cli.js`): `allowRead` would need the package dir and the whole Node install dir. Only the native installer was tested.
- Real Claude Code hooks or an MCP server inside the sandbox talking to the daemon socket. Only `nc -U` was tested.
- SEA packaging:
  - node-pty's `spawn-helper` must keep +x.
  - srt looks up `vendor/seccomp/*/apply-seccomp` and the Java agent jar relative to its own install. With SEA, set `seccomp.applyPath` and `javaAgentJarPath` explicitly.
- Long-running git operations in a worktree (fetch, rebase, gc, packed refs).
- `sandbox_check` is a private (but long-stable) libsystem_sandbox API. How fast the full pid scan is on busy machines was not measured.

---

## Gotchas

1. **The keychain is reachable through the srt default macOS profile** (`com.apple.SecurityServer`, `com.apple.securityd.xpc`). Always apply `hardenMacosProfile()`. Nested `sandbox-exec` inside srt is not possible (`sandbox_apply: Operation not permitted`), so patching the profile text is the only fix. With the CLI you cannot patch it.
2. **`allowPty: true` is required for any PTY or TUI.** Without it, `TIOCGETD` and other termios ioctls fail with EPERM.
3. **node-pty 1.1.0**: the prebuilt `prebuilds/darwin-*/spawn-helper` is installed **without the execute bit**, so `pty.spawn` throws `posix_spawnp failed.` Fix it with `chmod +x` in postinstall and in the SEA packaging step.
4. **Never use `spawnSync`/`execSync` in the daemon while guests run.** srt's HTTP/SOCKS proxy (and our Unix socket server) run in the daemon's event loop. Blocking it made every guest `curl` and `nc -U` time out in the first test run.
5. srt injects `TMPDIR=/tmp/claude` (or the **daemon's** `CLAUDE_CODE_TMPDIR`) through `env`, and always makes `/tmp/claude` writable. That dir is shared by all guests: create is allowed, rm is refused. Override `TMPDIR` inside the wrapped command, and `denyRead` `/private/tmp` so guests cannot read what others drop there.
6. srt's built-in "mandatory write denies" (`.git/hooks`, `.git/config`, `.mcp.json`, shell rc files, `.vscode`, `.idea`, `.claude/commands`, `.claude/agents`) are **anchored at the daemon's `process.cwd()`**. They also do **not** include `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks`, `.claude/skills` or `.envrc`. Any of these, written by a guest, would run in the host's **unsandboxed** session or shell. List them explicitly per scope (`autoExecDenies()`).
7. The host's personal `<project>/.claude/settings.local.json` and `CLAUDE.local.md` are in the shared folder. They can hold `env` secrets or hook commands, so hide them from guests. Never put session tokens in project-level files.
8. **Unix socket paths are limited to 104 bytes on macOS.** This applies to the daemon socket (`~/.smurg/run/daemon.sock` is about 35 bytes) **and** to srt's own mux socket at `os.tmpdir()/srt-mux-<pid>-N.sock` of the process that hosts srt. Keep the daemon's `TMPDIR` short. The deep spike dir forced relative-path binds.
9. `allowUnixSockets` entries compile to `subpath`: listing a directory allows every socket under it. List the exact socket file.
10. **Fail-open API**: calling `wrapWithSandbox()` before `initialize()`, or with a `customConfig` that has no `network`, gives `(allow network*)`. Gate on `isSandboxingEnabled()` and the self-test.
11. The network allow-list is **per `SandboxManager` (a singleton)**, not per guest. `updateConfig(fullConfig)` changes it live, including for running processes. It takes the **whole** config, so always pass `{...base, network: {...}}`.
12. Directory metadata stays readable everywhere (`(allow file-read-metadata (vnode-type DIRECTORY))`). A guest can learn that `~/.ssh` exists, but cannot list it or read files in it.
13. **Detached (setsid) guest processes survive `pty.kill()` and keep the sandbox's write rights.**
    - macOS: use the marker+decoy `sandbox_check` scan.
    - **Do not** match on "sandboxed and can read X" alone. It matches unrelated system agents, and killing them caused the incident above.
    - Kill only pids that match marker && !decoy. Consider also requiring the uid and a start time after the session began.
14. Claude Code's Write and Edit tools write `<file>.tmp.<pid>.<rand>` and then rename it. This matters for the R8 disk watcher (ignore or coalesce `.tmp.*`) and shows that a `denyWrite` on a directory also blocks the temp file.
15. Git worktree guests need read access to the **main** `.git`, and write access to `objects/`, `worktrees/<name>/`, `refs/heads/<ns>/` and `logs/refs/heads/<ns>/`. Consequences:
    - The guest can read all history and blobs of the main repo, including objects of staged files.
    - `git commit` prints a harmless `Unable to create '.git/packed-refs.lock'` but succeeds.
    - Deny `.git/hooks` and `.git/config` explicitly.
16. On macOS `/usr/bin/git` is an xcrun shim. With `/private/var/folders` read-denied it prints `couldn't create cache file .../xcrun_db` but works.
17. Claude Code 2.1.220 contacts `http-intake.logs.us5.datadoghq.com` and `raw.githubusercontent.com` at startup. Both are denied (403) without breaking anything. Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` to cut the noise. `claude` also lists `~/.local/share/claude/versions` (denied, harmless).
18. `/bin/ps` is setuid and cannot run in the sandbox. Tools that shell out to `ps` fail for guests.
19. srt bundles zod 3.25. If `packages/protocol` uses zod 4, srt's exported schemas are a separate zod instance; do not mix them.
20. srt adds its own Java-agent jar path to `allowRead` automatically. In an SEA bundle that file will not exist; set `javaAgentJarPath` or accept the skip.
21. srt is 0.0.x (research preview). Pin the exact version and re-run this spike on upgrade. `hardenMacosProfile()` throws if the expected profile lines disappear.

---

## Verified code (excerpts of what actually ran)

Full files are in the spike's `src/`.

**Policy builder** (`src/guest-sandbox-config.ts`):

```ts
export function buildGuestSandboxConfig(input: GuestSandboxInput): GuestSandboxPolicy {
  const platform = input.platform ?? process.platform;
  const hostHome = real(input.hostHome ?? homedir());
  const projectDir = real(input.projectDir);
  const scope = real(input.worktreeDir ?? input.projectDir);
  const guestTempDir = real(input.guestTempDir);
  const shared = input.sharedReadOnlyDirs.map(real);

  const denyRead = [
    ...broadDenyRegions(platform, hostHome), // darwin: [home, '/Users', '/Volumes', '/private/tmp', '/private/var/folders']
    join(scope, '.claude', 'settings.local.json'),
    join(scope, 'CLAUDE.local.md'),
  ];
  const allowRead = [scope, guestTempDir, ...input.claudeInstallPaths.map(real), ...shared];
  if (input.sessionMarkerPath) allowRead.push(input.sessionMarkerPath);
  const allowWrite = [scope, guestTempDir];
  const denyWrite = [...shared, ...autoExecDenies(scope)]; // .claude/settings*.json, .claude/{hooks,commands,agents,skills}, .mcp.json, .git/{hooks,config}, .envrc, .vscode, .idea

  if (!input.worktreeDir) {
    const dotSmurg = join(projectDir, '.smurg');       // other sessions' worktrees
    denyRead.push(dotSmurg); denyWrite.push(dotSmurg);
  } else if (input.worktreeGit) {
    const g = real(input.worktreeGit.commonGitDir);
    allowRead.push(g);
    allowWrite.push(join(g, 'objects'), join(g, 'worktrees', input.worktreeGit.worktreeName),
      join(g, 'refs', 'heads', ...input.worktreeGit.branch.split('/').slice(0, -1)),
      join(g, 'logs', 'refs', 'heads', ...input.worktreeGit.branch.split('/').slice(0, -1)));
    denyWrite.push(join(g, 'hooks'), join(g, 'config'));
  }
  const network = {
    allowedDomains: [...new Set([...BASE_ALLOWED_DOMAINS, ...input.extraAllowedDomains])],
    deniedDomains: [], strictAllowlist: true,
    deniedResolvedAddresses: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7'],
    allowUnixSockets: [input.daemonSocketPath], allowLocalBinding: false,
  };
  const filesystem = { denyRead, allowRead, allowWrite, denyWrite };
  const credentials = { envVars: LOGIN_OVERRIDE_ENV_VARS.map((name) => ({ name, mode: 'deny' as const })) };
  const base = { network, filesystem: { denyRead: broadDenyRegions(platform, hostHome), allowRead: [], allowWrite: [], denyWrite: [] }, credentials, allowPty: true };
  const perSession = { filesystem, credentials, allowPty: true };
  return { base, perSession, asSettingsFile: { ...base, ...perSession }, cwd: scope };
}
// BASE_ALLOWED_DOMAINS = api.anthropic.com, claude.ai, *.claude.ai, platform.claude.com, console.anthropic.com, statsig.anthropic.com
```

**Hardening** (`src/harden.ts`):

```ts
const LINES = ['  (global-name "com.apple.securityd.xpc")\n', '(allow mach-lookup (global-name "com.apple.SecurityServer"))\n'];
export function hardenMacosProfile(wrapped: string): string {
  if (process.platform !== 'darwin') return wrapped;
  let out = wrapped;
  for (const line of LINES) {
    if (!out.includes(line)) throw new Error(`sandbox hardening failed: expected profile line not found: ${JSON.stringify(line)}`);
    out = out.split(line).join('');
  }
  if (/com\.apple\.securityd\.xpc|com\.apple\.SecurityServer/.test(out)) throw new Error('sandbox hardening failed');
  return out;
}
```

**Guest session in a PTY** (`src/verify-claude.ts` and `src/verify-pty.ts`):

```ts
SandboxRuntimeConfigSchema.parse(policy.asSettingsFile);
await SandboxManager.initialize(policy.base /*, undefined, enableLogMonitor */);
const env = buildGuestEnv({ guestTempDir, claudeBinDir, sessionToken, daemonSocketPath }); // clean whitelist
const inner = `export TMPDIR=${JSON.stringify(env.TMPDIR)}; exec "${claudeReal}"`;
const wrapped = hardenMacosProfile(await SandboxManager.wrapWithSandbox(inner, '/bin/bash', policy.perSession));
const p = pty.spawn('/bin/bash', ['-c', wrapped], { name: 'xterm-256color', cols: 100, rows: 30, cwd: policy.cwd, env });
p.onData(forwardToClients); p.resize(120, 40); p.kill('SIGHUP');
// live allow-list change (host edits it):
SandboxManager.updateConfig({ ...policy.base, network: { ...policy.base.network, allowedDomains: [...policy.base.network.allowedDomains, 'example.org'] } });
await SandboxManager.reset(); // on daemon shutdown
```

**Self-test before each session** (`src/check-deps.ts`):

```ts
async function sandboxSelfTest(perSession, canaryDir) {
  if (!SandboxManager.isSupportedPlatform()) throw new Error('This OS is not supported by the guest sandbox.');
  if (!SandboxManager.isSandboxingEnabled()) throw new Error('Guest sandbox is not initialized.');
  const deps = await SandboxManager.checkDependenciesAsync();
  if (deps.errors.length) throw new Error(`Guest sandbox dependencies missing: ${deps.errors.join(', ')}`);
  if (process.platform === 'darwin') accessSync('/usr/bin/sandbox-exec', constants.X_OK);
  // canary file lives in the denied home region
  const cmd = `test "$SANDBOX_RUNTIME" = 1 || exit 20; cat "${secret}" >/dev/null 2>&1 && exit 21; (echo x > "${probe}") 2>/dev/null && exit 22; echo SELFTEST-$((20+22))`;
  const wrapped = hardenMacosProfile(await SandboxManager.wrapWithSandbox(cmd, '/bin/bash', perSession));
  if (wrapped === cmd || !wrapped.includes(process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'bwrap')) throw new Error('Guest sandbox wrapper did not produce a sandboxed command.');
  const r = await runAsync(wrapped); // never spawnSync
  if (r.code !== 0 || !r.out.includes('SELFTEST-42') || existsSync(probe)) throw new Error(`Guest sandbox self-test failed (exit ${r.code})`);
}
```

**Session process attribution** (`native/sbcheck.c` and `src/verify-teardown.ts`):

```c
extern int sandbox_check(pid_t pid, const char *operation, int type, ...);
// sandboxed = sandbox_check(pid, NULL, 0) != 0
// readable  = sandbox_check(pid, "file-read-data", 1 /*PATH*/ | 0x40000000 /*NO_REPORT*/, path) == 0
```

```ts
// marker (in this session's allowRead) and decoy (in nobody's) are sibling FILES that exist before wrapping
const sessionPids = (id) => scan(id).filter((x) => x.sandboxed && x.marker && !x.decoy).map((x) => x.pid);
p.kill('SIGHUP'); for (const pid of sessionPids(id)) process.kill(pid, 'SIGKILL');
```

---

## How to re-run the spike

```bash
cd /private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/sandbox
npm install            # postinstall: chmod +x node-pty spawn-helper, build native/sbcheck (needs Xcode CLT)
npm run verify:all     # ~4 min; setup, deps(12), fs-net(81), multi(7), pty(12), teardown(9), claude(8), write-tool(5)
npm run probe:keychain # optional: shows 71 -> 0 keychain items with/without hardening (counts only)
node src/show-profile.ts   # prints the generated Seatbelt network + read rules
```

- Node 25.4 runs the `.ts` files directly (type stripping). Node 22.22 also works: `~/.nvm/versions/node/v22.22.1/bin/node src/verify-pty.ts`.
- Needs network access: example.com, example.org, api.anthropic.com and neverssl.com.
- `verify-claude` and `verify-write-tool` use `~/.local/bin/claude` and a **fake** API key only; no account is used.
- The fixtures live in `work/` (recreated by `npm run setup`). Results are in `work/results/`.
- Secret locations are only probed by exit code.
- The teardown test only signals command lines it started (`SAFE_TO_KILL`).

---

## Verification

Independent re-run and source audit by a second engineer on 2026-09-27, same machine (macOS 26.5.1 / Darwin 25.5 arm64, Node v25.4.0 and v22.22.1, Claude Code 2.1.220 native + 2.1.283 npm). The spike was **reinstalled from scratch** in a sibling directory `spikes/sandbox-verify` (`npm install` → `added 7 packages`, node-pty prebuild + `native/sbcheck` built cleanly) and `npm run verify:all` re-run end to end.

**The recommendation holds.** srt 0.0.77 used as a library, one `SandboxManager` per daemon, per-guest `wrapWithSandbox(customConfig)` spawned through node-pty, `hardenMacosProfile()` on macOS, the clean guest env, the functional self-test as an R5 gate, and the marker+decoy teardown are all confirmed. Two statements were tightened and several previously-unverified items are now verified (below).

### Confirmed (re-run or audited in source)

- **Full suite reproduces on a clean install:** 134/134 (`deps 12`, `fs-net 81`, `multi 7`, `pty 12`, `teardown 9`, `claude 8`, `write-tool 5`), ~4 min. No stray processes, no `/private/tmp/claude` leftover, no leak-check files.
- **No vacuous deny-passes.** The controls run every "fail" probe *outside* the sandbox and get exit 0, and the secret targets actually exist on this machine (`~/.ssh/id_*` ×2, `~/.claude/CLAUDE.md`, `~/.claude.json` all present; `cat` outside the sandbox → 0). So the exit-1 results inside the sandbox are the sandbox's doing.
- **Keychain hole and the fix are real.** srt's base macOS profile hardcodes `(allow mach-lookup (global-name "com.apple.securityd.xpc"))` (in the base mach-lookup block) and `(allow mach-lookup (global-name "com.apple.SecurityServer"))` (`macos-sandbox-utils.js` lines ~706 and ~828); `allowMachLookup` only *adds* services, there is no removal switch. Measured: default profile enumerates **71** keychain items (== outside), hardened profile **0**. claude/curl/git/commit still work after stripping.
- **API surface exists.** All 12 `SandboxManager` methods the report lists are present in the installed dist; `SandboxRuntimeConfigSchema` is exported and validates the full guest-shaped config (network `strictAllowlist`/`deniedResolvedAddresses`/`allowUnixSockets`/`allowLocalBinding`, filesystem, `credentials.envVars` mode `deny`, `allowPty`). Per-field `customConfig` merge (`?? config…`) confirmed in `wrapWithSandbox`.
- **Fail-open footguns** (`wrapWithSandbox` before `initialize()` → `(allow network*)` + no read denies; a `customConfig` with no `network` → `(allow network*)`) reproduce; `initialize()` throws `Sandbox dependencies not available` on dep errors; a missing `sandbox-exec` makes the wrapped command exit 127 (fail-closed). The self-test refuses a missing `sandbox-exec` and a policy that fails to hide the home.
- **PTY + `allowPty`** re-confirmed 12/12 on **both** Node v25.4.0 and v22.22.1; without `allowPty`, `stty: TIOCGETD: Operation not permitted`. Detached `setsid()` child survives `pty.kill()` and writes into the project 4 s later.
- **Teardown attribution:** naive "sandboxed && marker-readable" over-matches (hundreds of unrelated pids on this box); `sandboxed && marker && !decoy` matches exactly the session's shell + bg job + detached child, and nothing of Bob's or the host's. One `sbcheck` scan over **418** live user pids costs **~19 ms** (incl. process spawn) — cheap enough for kick.
- **Real claude:** `--version` = `2.1.220 (Claude Code)`; TUI first-run screen renders in a PTY and survives resize; `-p` with a fake key reaches the API (401) through the proxy; `auth status` `loggedIn=false` in hardened / default / no-sandbox-with-guest-env. The violation log (28 distinct denials this run) shows **no** attempt on the host `~/.claude`. Edit/Write/Read tool EPERM re-confirmed 5/5 via the mock Messages API.
- **`git update-ref refs/heads/main` genuinely fails** from a worktree guest (focused test, both loose and packed main): exit 128, main SHA unchanged. Overwriting `.git/refs/heads/main`, `.git/packed-refs`, or `.git/config` directly → `Operation not permitted`.
- **Linux static facts** (from `linux-sandbox-utils.js` / `generate-seccomp-filter.js`, still runtime-unverified): `checkLinuxDependencies()` checks `bwrap` + `socat` (errors) and the seccomp helper (warning only) and a uid-0/`CAP_SETFCAP` error — and has **no AppArmor probe**; the seccomp filter blocks `socket(AF_UNIX)` on 64-bit (32-bit x86 unsupported), so `allowUnixSockets` is inert on Linux; bwrap is always launched with `--new-session --die-with-parent` + `--unshare-pid`.
- node-pty 1.1.0 tarball ships `prebuilds/darwin-*/spawn-helper` at mode **0644** (confirmed via `npm pack`); the spike's `postinstall` `chmod +x` fixes it. macOS-only prebuilds present are darwin-arm64/x64 + win32; **no linux prebuild in the tarball**, so a Linux daemon build compiles node-pty from source (node-gyp) — plan for that in packaging.

### Corrected / tightened (with evidence)

1. **`updateConfig()` is not "network lists only."** Source (`updateConfig`) replaces the entire stored `config` via `structuredClone(newConfig)` and rebuilds the resolved-address guard + parent proxy. Only network reaches already-running processes (filesystem is compiled into the spawn-time profile); new wraps use the whole new config. Report line corrected in place. Practical impact: none for the current design (always pass `{...base, network:{…}}`), but do not rely on `updateConfig` to retighten filesystem for a running guest — re-wrap instead.
2. **R9 "a worktree guest cannot write the main workspace" is too strong.** A `git worktree` guest **can** write arbitrary loose files into the shared `<project>/.git/objects/` (verified: `echo pwned > <project>/.git/objects/deadbeef` → exit 0), because the policy lists `objects/` in `allowWrite`. It also writes `.git/worktrees/<name>/`, `.git/refs/heads/<ns>/*` and `.git/logs/refs/heads/<ns>/*`. It **cannot** move refs outside its namespace, overwrite `packed-refs`/`config`, or touch the main working tree. Loose objects are content-addressed (a bogus `deadbeef` is inert to git), but this is still (a) a write into the shared main `.git` and (b) an un-quota'd disk-fill vector against the host repo, and every guest ref update prints `Unable to create '.git/packed-refs.lock'` noise. Report row annotated in place. **Recommended refinement (verified, strictly cleaner): make the per-session "worktree" a `git clone --shared --no-checkout <project> .smurg/worktrees/<s>` instead of a `git worktree`.** The clone is its own repo whose `objects/info/alternates` points read-only at `<project>/.git/objects`; the guest policy then needs only `allowRead` of `<project>/.git` (no write into the main `.git` at all). In the side-by-side probe the clone guest ran commit / rebase / merge / stash / branch-delete / tag / gc **all exit 0 with no lock errors and no leftover sequencer state**, could not write `<project>/.git/objects` (exit 1) or read the main working tree, and the (unsandboxed) daemon merges back with a plain `git fetch .smurg/worktrees/<s> <branch>` (verified: host fetched the guest's commit). The `git worktree` design still *passes* R9's acceptance tests, so this is a recommended improvement, not a blocker.

### Newly verified (were "unverified" in the report)

- **npm-installed Claude Code is now a single native binary, not `node` + `cli.js`.** `@anthropic-ai/claude-code@2.1.283` installs `bin/claude.exe` = one **225 MB signed arm64 Mach-O** (via the `@anthropic-ai/claude-code-darwin-arm64` optional dep). It runs under the guest sandbox with `allowRead` of just that file — same shape as the native installer. The old "would need the package dir and the whole Node install dir" concern does not apply to current claude-code.
- **A code-signed claude binary execs even without an `allowRead` entry for it.** With `claudeInstallPaths: []` and the binary under a `denyRead` home, `claude --version` still returns 0 (the profile's global `(allow process-exec)` plus signature validation covers page-in), while `cat` of the same binary is denied. A **copied** unsigned executable in a denied dir is `Killed: 9` on exec, and a shell **script** there fails 126 (the interpreter must `open()` it). Keep the `allowRead` of the binary anyway: harmless, future-proof, and required for any interpreted or unsigned helper a guest might exec.
- **More git in a worktree guest** (informational, `git 2.49`): `commit`, `checkout -b` inside its own `smurg/*` namespace, `rebase main`, `fetch <src> main` (FETCH_HEAD) all succeed; `checkout -b feature` (outside namespace), `tag`, `pack-refs`, `remote add`/`config`, `gc`, `stash`, `branch -D`, and `fetch` into `refs/remotes/*` all fail on the ref/config/lock write. `rebase` leaves `CHERRY_PICK_HEAD` behind so a following `merge` errors. This is exactly why the `git clone --shared` refinement above is worth taking.
- **`TMPDIR` injection reads the daemon's env, not the child's.** `sandbox-utils.js` builds `TMPDIR=${process.env.CLAUDE_CODE_TMPDIR||process.env.CLAUDE_TMPDIR||'/tmp/claude'}` in the daemon process, so setting `CLAUDE_CODE_TMPDIR` in the *guest* env (as `buildGuestEnv` does) does not steer it — the inner `export TMPDIR=…; exec` is what actually wins (verified: guest `$TMPDIR` = the guest tmp dir). The `CLAUDE_CODE_TMPDIR` entry in `buildGuestEnv` is therefore inert for this purpose; keep the inner re-export.

### Still unverified (unchanged — cannot be tested on this macOS host)

- ~~Everything on **Linux** at runtime~~: verified on Ubuntu 24.04 arm64 on 2026-10-01 (section "Linux, verified 2026-10-01"). node-pty is compiled from source on Linux (no prebuild in the tarball), which worked with build-essential.
- Claude Code **interactive OAuth login** inside the sandbox and where credentials land when the keychain is blocked (expected `$CLAUDE_CONFIG_DIR/.credentials.json`).
- Whether the srt **default** profile exposes keychain item *secrets* (only enumeration was measured; hardening closes the channel regardless).
- Real Claude Code **hooks** / a coordination **MCP server** inside the sandbox talking to the daemon socket (only `nc -U` tested).
- **Node SEA packaging** of srt (`apply-seccomp`, java agent jar) and of node-pty's `spawn-helper`.
- `sandbox_check` is a private (long-stable) API; the ~19 ms/scan figure is for 418 pids on an idle machine.
