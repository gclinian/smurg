# Research: node-pty on this toolchain, scrollback / multi-attach, single-executable packaging

> **Note (2026-10-01).** Where this report mentions srt (sandboxed guest PTYs, srt's assets in the single executable,
> `apply-seccomp`), it is historical: the guest sandbox was removed (`docs/ARCHITECTURE.md` §11 D-15), and the
> executable carries no srt files any more (`scripts/build-sea.ts`). The node-pty, scrollback and packaging findings
> still apply.

Scope: SPEC R4 (PTY sessions, multi-attach, full scrollback on re-attach, `smurg attach`), R2 (kicked user's processes gone within 3 s), R1 (prevent sleep while hosting), section 6 (single executable, node-pty native module) and the section 13 row "node-pty 原生模組在單一執行檔發佈下能正常運作".

Host used: macOS 26.5.1 (Darwin 25.5) arm64, Node v25.4.0 and v22.22.1 (nvm), plus official Node v24.21.0 and v26.10.0 tarballs downloaded (checksums verified) into the spike dir only. bun 1.3.11, Xcode CLT, pnpm 10.34.5 via `npx`.

Spike dir (re-runnable): `/private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/pty-packaging`

---

## 1. Recommendation

| Question | Decision |
|---|---|
| **PTY package** | **`node-pty@1.2.0-beta.15`**, pinned exactly (Microsoft upstream, `beta` dist-tag). It ships N-API prebuilds for darwin-x64/arm64, **linux-x64/arm64** and win32, and its macOS `spawn-helper` is executable in the tarball. Do **not** use `node-pty@1.1.0` (the `latest` tag): it has no Linux prebuilds (node-gyp build needed on every Ubuntu host) and its macOS `spawn-helper` has mode 0644 in the tarball, so every spawn fails with `posix_spawnp failed` until you chmod it. Fallback if upstream beta ever breaks: `@lydell/node-pty@1.2.0-beta.15`, which repackages the same code as per-platform optional deps with no install scripts. |
| **Node engines** | Monorepo `"engines": { "node": ">=22.18.0" }` (native TS type stripping without flags, `process.getBuiltinModule`, SEA assets). The verifier confirmed 22.18.0 is the exact lower bound: 22.17.1 rejects `.ts` files, 22.18.0 runs them without a warning. Dev on Node 22 or 24. Node 25 works, but its end-of-life date was 2026-06-01, so don't ship it. **The release binary is built on Node 24 LTS** (postject path, verified). The build script switches to `node --build-sea` automatically once the build Node is 26 (26 becomes LTS on 2026-10-28; verified working here). Pin `"packageManager": "pnpm@10.x"` and add `onlyBuiltDependencies: [node-pty, esbuild]` to `pnpm-workspace.yaml`. |
| **Session manager** | One `PtySession` per PTY (spawned with `encoding: null`). All output flows through a **5 ms / 64 KiB coalescer**, then goes to (1) a headless terminal mirror, (2) a raw byte tail, and (3) every attached viewer. Output is addressed by an **absolute byte offset**. **Only clients of the owner may write input**; everyone else is refused and logged, and must use suggestions (R6). **Use the corrected `attach()` from section 6.1** (verifier fix V1/V2): the original sent only 1000 history lines on re-attach, and a resize during a snapshot left a new viewer permanently at the wrong size. |
| **Resize policy** | **`owner`**: the PTY size follows the size of the owner's most recently active client (the last one to attach, type or resize). Guests never resize the PTY. They receive `exec.resize` and render at exactly the PTY's cols×rows. Web xterm.js can do that; a real terminal under `smurg attach` cannot (see the attach row). If the owner has no client attached, the PTY keeps its last size. The tmux-style `smallest` policy was implemented for comparison and rejected, because a small guest window shrinks the owner's Claude Code. |
| **Kill / kick** | Use `killTree()`, not `pty.kill()`. It collects descendants by ppid, their process-group members, and same-uid processes carrying an injected `SMURG_SESSION_ID=<id>` env marker, then does SIGSTOP → re-scan → SIGKILL, and repeats until no processes are left. A kick measured **163–811 ms**, well inside the 3 s budget. **The env marker is not a security boundary** (verifier V3): a guest process can drop it with `env -u` and `setsid()`, and it then survives the kick on any OS. On **Linux** guest containment comes from srt itself: srt 0.0.77 runs bwrap with `--unshare-pid --die-with-parent`, so orphans re-parent to the namespace's init, which the ppid walk already covers (read from the source, not run). On **macOS** a kicked guest can leave a daemon that keeps its Seatbelt rights, including write access to the project folder. Close this with the `sandbox_check()` sweep (V4, private API) or accept it as a documented residual risk. |
| **Scrollback for re-attach** | **Hybrid.** (a) The daemon keeps `@xterm/headless@6.0.0` plus `@xterm/addon-serialize@0.14.0` per session (5000-line scrollback) as the source of truth for snapshots. (b) A 2 MiB raw tail serves exact resume when the client's offset is still held and no resize happened since then. Reconnect uses the raw delta if possible, otherwise sends a snapshot of the **whole** mirror scrollback and then the live stream, with no gap and no duplicates. Replaying a raw ring alone is **not** correct (see facts F16–F17). The snapshot still does not carry charset designations, the DECSC saved cursor or custom tab stops (V7). That doesn't matter for Claude Code, which doesn't depend on them, but classic TUIs in guest terminals can differ after a re-attach. |
| **Terminal queries** | The **daemon mirror answers** DA1/DA2/CPR/DSR/DECRQM exactly once, whether 0 or N viewers are attached. Viewers must never answer. In web xterm.js, swallow queries with the **full** handler set in section 6.2. Handling only `c` and `n` still leaks DA2, DECXCPR, DECRQM and DECRQSS, and the browser build also answers OSC 4/10/11/12 colour queries (verifier V5). The CLI should **strip queries (and OSC 52) from the output** before they reach the local terminal (`vq/query-strip.ts`, V6), instead of filtering replies out of stdin. The stdin regex misses several reply types and eats Ctrl/Shift+F3. |
| **`smurg attach`** | Raw mode, SIGWINCH → `exec.resize`, **Ctrl-]** detaches (also matches the CSI-u form). On every exit path it runs `setRawMode(false)` and writes a mode-reset string (alt screen, mouse, bracketed paste, focus, keypad, scroll region, SGR, cursor). When the remote session ends, `attach` exits with the remote exit code. A real terminal cannot render at a size it doesn't have. A **non-owner** CLI smaller than the PTY sees wrapped, garbled output (V8), so for the prototype warn and ask the user to enlarge the window. |
| **Packaging** | **Node SEA.** Bundle the JS with esbuild (CJS, `node-pty` external). Embed the whole node-pty package (lib/*.js, `prebuilds/<plat>-<arch>/pty.node` and `spawn-helper`) as SEA assets with a sha256 manifest. On first run, extract it atomically to `~/Library/Caches/smurg/node-pty-<id>` or `$XDG_CACHE_HOME/smurg/...`, chmod `spawn-helper` to 755, verify the hashes on every start, and load it with `createRequire(dir)('./lib/index.js')`. **On macOS an ad-hoc `codesign --sign -` is mandatory.** Build script: `q5/build-sea.mjs` (section 6), **plus two verifier additions**: esbuild `define` for `import.meta.url` (otherwise `@anthropic-ai/sandbox-runtime` crashes at startup inside the SEA), and `execArgvExtension: "none"` (otherwise the host's `NODE_OPTIONS` is applied to the daemon). With both, srt and node-pty ran together inside one Node 24 SEA (V10). Reject bun (node-pty hangs under bun) and don't bother with pkg. |
| **srt + node-pty (macOS)** | *Added by the verifier (V9).* With srt 0.0.77's default profile, a TUI in the PTY **cannot enter raw mode** (`setRawMode` fails with EPERM). Claude Code draws its screen but gets no keystrokes until Enter, so `/` never opens the command menu. `allowPty: true` fixes that, but it grants read and write on **every** `/dev/ttys*` of the host user: a guest read what the host typed into another terminal, and wrote into it. Use `allowPty: true` **and** replace srt's pty rule so the guest can reach only its own tty (`-D SMURG_TTY=$(tty)` plus deny `^/dev/ttys` / allow `(param "SMURG_TTY")`). Verified: raw mode works, the Claude slash menu opens, and the other tty is denied for both read and write. This belongs to the sandbox (R5) owners. |
| **Keep awake** | macOS: `caffeinate -i -w <daemonPid>` spawned by the daemon. Linux: `systemd-inhibit --what=sleep:idle --who=smurg --why=… --mode=block cat`, with cat's stdin a pipe from the daemon. Either way the inhibitor is released automatically when the daemon dies, even on SIGKILL. The macOS side was verified twice. On Linux only the stdin-EOF mechanism was verified (with `cat` on macOS); `systemd-inhibit` and its polkit rules are not. |

---

## 2. Dependencies (exact versions installed and exercised)

| Package | Version | Used by | Note |
|---|---|---|---|
| `node-pty` | **1.2.0-beta.15** | daemon, cli (attach runs no PTY itself; only the daemon does) | N-API (`napi_register_module_v1`), prebuilds darwin/linux/win. Pulls `node-addon-api@7.1.1` (build-time headers only) |
| `@xterm/headless` | 6.0.0 | daemon | Mirror terminal. Its `module` field points to a non-existent `lib/xterm.mjs`, so import the CJS default (`import x from '@xterm/headless'`) |
| `@xterm/addon-serialize` | 0.14.0 | daemon | Its typings import `@xterm/xterm`: use `skipLibCheck` or add `@xterm/xterm` as a devDependency for types |
| `esbuild` | 0.28.2 | build (daemon/cli packaging) | `--platform=node --format=cjs --external:node-pty` |
| `postject` | 1.0.0-alpha.6 | build | Only for Node < 25.5 (no `--build-sea`) |
| `typescript` / `@types/node` | 5.9.3 / 24.19.0 | spike type-check only | `erasableSyntaxOnly: true`: no parameter properties/enums, so files run with plain `node file.ts` |
| pnpm | 10.34.5 (`npx -y pnpm@10`) | workspace | Blocks dependency build scripts by default (see gotchas) |
| Node (runtime used for SEA base) | 22.22.1, 24.21.0, 25.4.0 (postject), 26.10.0 (`--build-sea`) | release | All four produced working SEA binaries here |
| Tested and rejected | `node-pty@1.1.0`, `@homebridge/node-pty-prebuilt-multiarch@0.14.1`, bun 1.3.11 | – | See facts |
| Exercised by the verifier | `@anthropic-ai/sandbox-runtime@0.0.77` | daemon | Ships executable vendor binaries (`vendor/seccomp/{x64,arm64}/apply-seccomp`), so on Linux it needs the same extract-from-SEA treatment as node-pty, plus `seccomp.applyPath`. On macOS it ran inside the Node 24 SEA with node-pty (V10). Needs `allowPty: true` plus the own-tty patch for interactive sessions (V9). |

---

## 3. Verified facts

**Installing node-pty (Q1)**

- **F1.** `npm install node-pty@1.1.0` on Node 25.4 installs in <1 s from prebuilds (`scripts/prebuild.js` finds `prebuilds/darwin-arm64`), but `pty.spawn` then throws `Error: posix_spawnp failed.` Evidence: `q1-npm-node25/smoke.cjs`. After `chmod +x prebuilds/darwin-*/spawn-helper` it works on Node 25.4.0 and 22.22.1. Root cause: `tar tvzf node-pty-1.1.0.tgz` shows `-rw-r--r-- package/prebuilds/darwin-arm64/spawn-helper`.
- **F2.** node-pty 1.1.0 ships prebuilds for darwin-x64/arm64 and win32 only (tarball listing). On Linux, `install` falls back to `node-gyp rebuild`, which needs python3, make and g++.
- **F3.** `node-pty@1.2.0-beta.15` ships `prebuilds/{darwin-x64,darwin-arm64,linux-x64,linux-arm64,win32-*}` with `spawn-helper` at mode 0755. Its smoke test passes on Node 25.4.0 and 22.22.1. With pnpm 10 it also works although pnpm printed "Ignored build scripts: node-pty" (the prebuilds need no script). `@lydell/node-pty@1.2.0-beta.15` behaves the same (no install scripts at all).
- **F4.** The Linux prebuilds are N-API ELF objects whose highest required symbol version is `GLIBC_2.28` (x64: 2.14/2.28, arm64: 2.17/2.28; checked with `strings | grep GLIBC_`). Ubuntu 24.04 ships glibc 2.39. They were not executed on Linux here (see Unverified).
- **F5.** Building from source works on this machine: `npm_config_build_from_source=true npm_config_devdir=<spike>/q1-gyp/.node-gyp npm install node-pty@1.2.0-beta.15` compiles `pty.node` and `spawn-helper` in about 4 s, and the smoke test passes.
- **F6.** `@homebridge/node-pty-prebuilt-multiarch@0.14.1` works on Node 25 but downloads an ABI-specific (`node-v141`) prebuild from GitHub at install time via prebuild-install and adds 37 packages. Its engines field is `>=20 <27`.
- **F7.** Node release schedule (`nodejs/Release/schedule.json`): v22 end-of-life 2027-04-30, v24 LTS until 2028-04-30, **v25 end-of-life 2026-06-01**, v26 LTS from 2026-10-28. Latest releases as of 2026-09: 24.21.0, 26.10.0.
- **F8.** Plain `node file.ts` (type stripping) works without flags on 22.22.1 and 25.4.0. Parameter properties throw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.

**Session manager (Q2)**: `node --test --test-concurrency=1 test/q2-session.test.ts` passes 8/8 on Node 25.4.0 and 22.22.1.

- **F9.** Fan-out: three viewers (owner web 120×40, owner CLI 100×30, guest 200×60) render screens identical to the mirror. Guest input `echo INJECTED-BY-BOB` is refused and recorded in `droppedInputs`.
- **F10.** Resize policy `owner`: guest attach/resize never changes the PTY. Owner CLI attach makes it 100×30. Owner typing in the web client switches it back to 120×40 (`stty size` in the PTY prints `40 120`). When the driving client detaches, the next most recent owner client drives. With no owner attached, the size is kept. Policy `smallest` shrinks the PTY to 60×20 when a small guest joins.
- **F11.** Exit: `exit 3` delivers `{exitCode: 3}` to viewers. A viewer attaching after exit gets a snapshot identical to the mirror plus the exit event. Input after exit is refused.
- **F12.** Kill (`kickUser`), across runs: 178, 179, 163, 180 and 604 ms (the 604 ms run was under machine load). Killed: background job, `nohup` job, HUP/TERM-ignoring subshell, and a Node `detached:true` (setsid) daemon re-parented to launchd, which only the env-marker scan catches. **Survived on macOS:** a `perl` double-fork+setsid daemon. Apple platform binaries hide their environment from `ps -E` (non-root), so the marker can't be seen. Baseline `pty.kill()` alone (SIGHUP to the shell) left 4/5 planted processes alive. *Verifier correction:* the env-marker catch only works when the process cooperates. A Node `detached:true` daemon started through `env -u SMURG_SESSION_ID` survived the kick (V3). Planted processes should be treated as non-adversarial evidence only.
- **F13.** Terminal queries: with 0 viewers attached and again with 3 viewers attached, a program sending DA1 gets exactly one reply (`\x1b[?1;2c`, from the mirror) and no second reply within 1 s. Probe for what `@xterm/headless` 6.0.0 answers itself: DA1, DA2 (`\x1b[>0;276;0c`), CPR, DSR, DECRQM. It does not answer XTVERSION, OSC 11 or the kitty-flags query. It does answer DECRQSS. *Verifier caveat:* in this test the viewers' `onData` is not wired back to the PTY, so it proves that the mirror answers once. It does **not** prove that viewers stay silent. With the viewer handlers from 6.2 as originally written (only `c` and `n`), a viewer still answers DA2, DECXCPR, DECRQM and DECRQSS. The browser `@xterm/xterm` also answers OSC 4/10/11/12 (V5).
- **F14.** node-pty on macOS delivers tiny reads: `seq 1 2000000` produced 20.8 MB in about 850k `onData` chunks (average 25 B), at 13.7 MiB/s raw (`q3/pty-throughput.mjs`). Through the full session pipeline: 2.7 MiB/s without coalescing, 7.9–9.2 MiB/s with the 5 ms/64 KiB coalescer (about 750–825k raw chunks → 430–483 flushed chunks). Mirror parse lag peaked at 0.06 MiB, so the 1 MiB high-water pause never triggered on this machine.
- **F15.** node-pty + Seatbelt: `pty.spawn('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny file-read* (literal …))', '/bin/sh', …])` gets a real controlling tty (`/dev/ttys001`) and the right size (`20 90`), and the denied read fails. This exercises Seatbelt directly, not srt itself. *Verifier correction:* with **srt's real profile**, raw mode fails with EPERM unless `allowPty: true` is set. `allowPty` in turn opens every `/dev/ttys*` of the user to the guest, for reading and writing (V9).

**Scrollback (Q3)**: `node q3/compare.ts`. "Truth" is a terminal that received every byte, with resizes applied at the right stream positions. Reconstructions are fresh terminals.

- **F16.** Real Claude Code 2.1.220 first-run TUI (captured with an isolated `HOME`/`CLAUDE_CONFIG_DIR` in the spike dir and a minimal env; the real `~/.claude` was untouched) uses **no alternate screen**. It renders inline (Ink style) with `CUU` plus `EL` (`\x1b[nA`, `\x1b[2K`), `\x1b[nG`, truecolor SGR, `?25l/h`, `?2004h`, `?1004h`, `?2031h`, and **queries the terminal** with `\x1b[c` (DA1) and `\x1b[>0q` (XTVERSION). Repaints and resizes leave stale copies of the header in scrollback, as they would in a real terminal. *Verifier addition:* the **main REPL** of 2.1.220 was also captured (`vq/capture-claude-repl.mjs`: isolated config, fake key, closed base URL, `PATH=/bin`, so the keychain `security` lookup cannot run). It uses the same modes: `?25`, `?2004h`, `?1004h`, `?2031h`, DA1, XTVERSION and OSC 0 titles. It uses no alternate screen, no kitty keyboard, no modifyOtherKeys and no OSC 11. It rendered normally with **no** responder to its queries.
- **F17.** Results (final size 80×24 after a mid-run resize from 100×30):

  | Method | Inline TUI (2.3 MB, 3.6k lines) | Fullscreen TUI (alt screen + DECSTBM) | Real Claude capture |
  |---|---|---|---|
  | (a) raw ring, truncated (16–256 KiB) | viewport text sometimes same (one run had a DIFF and the cursor at the wrong row). **Cells/attributes DIFF, modes DIFF**, history 1–391 of about 3.6k lines | **normal buffer instead of alternate**, modes DIFF | 2 KiB ring: cells and modes DIFF |
  | (a) raw ring holding **all** bytes, replayed at the current size | viewport same, **history 3275–3491 / ~3.6k** (old lines re-wrapped at the wrong width) | same | viewport same, **history 24/33** |
  | (b) mirror snapshot (5000 lines) | **all same, history complete (3545/3545, 3602/3602, 3608/3608)** | **all same** | **all same, 33/33** |

  The snapshot took 13–28 ms and was 227–275 KiB for 3.6k lines; for a full screen of TUI state it was 1.3 ms and 2 KiB.
  *Verifier notes:* (1) `compare.ts` calls `mirror.snapshot(5000)`, but `PtySession.attach()` called `snapshot()` with its default of **1000** lines, so a real re-attach lost everything older (3008 → 1024 lines, V1). Fixed in 6.1. (2) On the main-REPL capture after a 100→80 resize, viewport and cursor matched, but 2 of 42 scrollback lines were shifted by 2 cells. Ink moves between words with cursor jumps and leaves null cells; after reflow, SerializeAddon mis-serializes a wrapped row whose first cell is null. This is cosmetic and limited to stale reflowed history.
- **F18.** Resize ordering bug found and fixed: xterm's `write()` is queued but `resize()` is immediate. A bare `term.resize()` while output is still queued made the mirror diverge (history 3215/3608 before the fix, 3608/3608 after). Resizes must be applied with `term.write('', () => term.resize(c, r))`, both in the daemon mirror and in every xterm.js client.
- **F19.** Mirror memory (one config per process, `node --expose-gc q3/memory.ts <lines> <cols>`, fully painted lines): 1000×120 → 4.5 MiB, **5000×120 → 17.4 MiB**, 10000×120 → 33.5 MiB, 10000×200 → 52.4 MiB per session (≈3.5 KiB per 120-col line). Parse throughput was 27–95 MiB/s. Snapshot size is about 0.14 KiB per line.
- **F20.** `SerializeAddon` 0.14 restores the normal and alternate buffers plus modes 1, 66, 2004, 4 (IRM), 6, 45, 1004, 7 and mouse 9/1000/1002/1003. It does **not** restore cursor visibility (`?25`), mouse encoding (`?1006` etc.), DECSTBM scroll regions or cursor style. `TermMirror` tracks those via `term.parser.registerCsiHandler(…) → false` and appends them. The re-attach test confirms that cursor-hidden is re-applied. *Verifier addition (V7):* the snapshot also loses the G0/G1 charset designations and SO/SI (DEC line drawing turns back into `qqq`), the DECSC saved cursor, and custom tab stops. With origin mode on, TermMirror's appended `DECSTBM + CUP` puts the cursor in the wrong place (row 11 instead of 7), because the CUP is absolute but emitted after `?6h`. Fix: emit it before the modes, or make it relative to the top margin. Pen SGR, IRM, DECAWM and pending-wrap survive.

**`smurg attach` (Q4)**: `node --test q4/attach.test.ts` passes 2/2 on Node 25.4.0 and 22.22.1. `attach.ts` runs inside an outer PTY that stands in for the user's terminal.

- **F21.** While attached, the local tty is `-icanon -echo -isig` (checked from outside with `stty -f /dev/ttysNNN -a`). ^C reaches the remote (`sleep 30` interrupted; attach stays alive). Resizing the outer PTY (SIGWINCH) resizes the remote PTY (`stty size` prints `40 120`).
- **F22.** After the remote enables alt screen, bracketed paste, focus, mouse 1002/1006 and hidden cursor, pressing Ctrl-] exits attach with code 0. The local terminal is then back in the normal buffer with every one of those modes off and the cursor visible, and `stty -a` shows `icanon echo isig`. The session keeps running.
- **F23.** Re-attach from a **new** terminal window re-enters the alt screen with its content, bracketed paste and hidden cursor restored. After leaving the alt screen, the scrollback from before the detach (`hello-42`) is present. `exit 7` in the session makes `attach` exit 7.
- **F24.** Without the stdin reply filter, the local terminal's own DA1 answer reaches the remote as a **duplicate reply** (test fails with `SMURG_ATTACH_NO_REPLY_FILTER=1`). With the filter the app gets exactly one reply. *Verifier:* the regex covers DA1 but misses DECXCPR (`CSI ? r;c R`), ANSI DECRQM, DECRQSS/XTGETTCAP DCS replies, OSC 4 and XTWINOPS replies, and it swallows real keys (Ctrl/Shift+F3 are `CSI 1;5R` / `CSI 1;2R`). The verified replacement strips queries from the **output** stream instead (`vq/query-strip.ts`). It passed every split point in a fuzz test and the same Q4 tests with **no** stdin filter. On the real Claude REPL capture it removed 8 bytes (DA1 and XTVERSION), rendering stayed identical, and the local terminal gave 0 replies (V6). It also drops OSC 52, so a session cannot read or set the attaching user's clipboard.
- **F25.** macOS Unix socket paths are limited: `listen()` on a 165-byte path fails with `EINVAL`, because `sun_path` is 104 bytes on macOS.

**Packaging (Q5)**

- **F26.** Node SEA with node-pty works. Base binaries **22.22.1, 24.21.0, 25.4.0** (`--experimental-sea-config` + postject + codesign) and **26.10.0** (`--build-sea` + codesign) all produced working binaries. Each was run from an empty cwd with `env -i HOME=… PATH=/usr/bin:/bin` and printed `{"isSea":true, "lines":["hello from /dev/ttys00N","20 90"], "snapshotHasColor":true}`, which proves node-pty and the bundled xterm headless plus serialize all work. The first run takes 1.47 s (extraction plus macOS first-launch scan of a new 120 MB binary); later runs take 0.06 s.
- **F27.** `spawn-helper` **is required on macOS**. `src/unix/pty.cc` passes `helper_path` as argv[0] to `posix_spawn` under `__APPLE__`, while Linux uses `forkpty()`. With the helper removed: `posix_spawn failed: No such file or directory`. With the helper present but not executable (node-pty 1.1.0): `posix_spawnp failed`.
- **F28.** `--build-sea` exists in Node 26.10.0 and is documented as added in **v25.5.0**. Node 25.4.0 and 24.21.0 don't have it (`node --help`). The v26 docs say native addons still have to be written to the real file system (and so does an executable helper); the new `useVfs` option (v26.9, "early development") can't `dlopen` from the VFS. The docs also say **macOS x64 SEA is not tested on Node CI**.
- **F29.** Output of `--build-sea` is unsigned (`code object is not signed at all`) and gets **SIGKILLed (exit 137) on macOS arm64** until you run `codesign --sign -`.
- **F30.** SEA `process.argv` is `[execPath, execPath, …args]`, so `process.argv.slice(2)` is identical in dev and in the SEA. `execFileSync(process.execPath, ['hook', 'pre-tool-use'])` re-invokes the same binary as a subcommand, suitable for hook/MCP entry points.
- **F31.** Sizes: SEA binary is 107 MiB (Node 22), 116 MiB (24), 122 MiB (25), 139 MiB (26). Compressed: Node 24 build 36 MiB gzip / 23 MiB xz; Node 22 build 34 / 22 MiB.
- **F32.** bun 1.3.11: `node-pty@1.2.0-beta.15` and `@lydell/node-pty` **hang** (all 6 runs hit the timeout; children stuck in `spawn-helper`, orphans had to be killed by hand). `node-pty@1.1.0` under bun lost output and reported `signal: 1`. `bun build --compile` fails at node-pty's dynamic `require(dir + '/pty.node')`. Bun's own `Bun.spawn(cmd, { terminal: {cols, rows, data} })` PTY API worked (`/dev/ttys001`, `20 90`).

**Keep awake (Q6)**: `q6/verify.sh`

- **F33.** `caffeinate -i -w <pid>` shows in `pmset -g assertions` as `pid N(caffeinate): PreventUserIdleSystemSleep named: "caffeinate command-line tool"`. After `kill -9` of the daemon, caffeinate exits in about 10 ms and the assertion is gone. The Linux mechanism (a child whose stdin is a pipe from the daemon) was verified with `cat` on macOS: it exits on EOF when the daemon is SIGKILLed.

---

## 4. Unverified / could not test here

- **Linux runtime**: the node-pty 1.2.0-beta.15 linux prebuilds loading on Ubuntu 24.04, the SEA build on Linux, `/proc/<pid>/environ` marker scanning, and `systemd-inhibit` (polkit rules for `sleep` and `handle-lid-switch`) were all **not run**. No Linux VM was used, to keep all experiments inside the spike dir. Evidence is limited to static ELF inspection (F4) and source reading.
- ~~Whether srt on Linux (bubblewrap) uses `--unshare-pid` / `--die-with-parent`~~ *Verifier: statically confirmed.* srt 0.0.77 `linux-sandbox-utils.js` always pushes `--new-session --die-with-parent` and `--unshare-pid` (plus `--proc /proc` unless the weaker nested mode is on). Runtime on Linux is still unverified.
- ~~macOS containment of processes that deliberately `setsid()`~~ *Verifier: a working option exists (V4).* `sandbox_check()` (a private libsystem_sandbox API) identifies an escaped guest daemon among 433 same-uid processes in about 150 ms. It relies on per-guest canary **files** and a host canary, and it matched no foreign process. An earlier variant that used a directory canary under `/private/tmp` produced a false positive (see V4). Productizing it needs a small native helper and CI coverage.
- ~~The exact minimum Node 22 minor for unflagged type stripping~~ *Verifier: 22.18.0 confirmed* (22.17.1 fails with `ERR_UNKNOWN_FILE_EXTENSION`).
- Gatekeeper behaviour for a **downloaded** (quarantined) ad-hoc-signed binary. Only local and curl-style (no quarantine xattr) runs were tested. Public distribution will need Developer ID signing and notarization.
- `@yao-pkg/pkg` (6.22.0, engines node >=22) was not tried; SEA already works first-party.
- Claude Code's main REPL after login (it could not be exercised without using the host's credentials). The kitty keyboard protocol or other modes it may enable later are handled generically (kitty pop on detach, CSI-u Ctrl-]) but those code paths were not triggered. *Verifier:* the main REPL was captured with a fake key and no credentials (see F16). It enables none of these modes, but a real model turn (streaming, tool output, permission dialogs) was still not captured.
- ~~srt inside a SEA~~ *Verifier: verified on macOS (V10)*, once the esbuild `import.meta.url` define is added. On Linux the SEA must also extract `vendor/seccomp/<arch>/apply-seccomp` and pass `seccomp.applyPath`. That part is unverified.

---

## 5. Gotchas

1. **node-pty 1.1.0 is broken on macOS as published**: `spawn-helper` has mode 0644, which gives `posix_spawnp failed` (F1). If you must use it, add a postinstall `chmod +x`.
2. **pnpm 10 ignores dependency build scripts** by default. It's harmless for node-pty 1.2.0-beta.15 on platforms with prebuilds, but on a platform without one (musl, other arches) nothing gets built. Add `onlyBuiltDependencies: [node-pty, esbuild]` to `pnpm-workspace.yaml` so node-gyp can run as a fallback.
3. **Always spawn with `encoding: null`** (Buffers) and use byte offsets. Coalesce output (5 ms / 64 KiB): raw macOS reads average about 25 bytes, and 850k tiny encrypted relay messages per 20 MB would be disastrous (F14).
4. **Resize must be ordered with the byte stream**, in the mirror *and* in every xterm.js client: `term.write('', () => term.resize(c, r))`. Also flush the coalescer before resizing the PTY (F18).
5. **Snapshot handover**: take the snapshot inside a `term.write('', cb)` callback. xterm runs write callbacks synchronously right after that chunk is parsed, so the state then corresponds exactly to the enqueued offset. Send `tail.since(offset)` next, then mark the client live. A raw delta is only valid if no resize happened after the client's offset.
6. **Viewers must not answer terminal queries.** Claude Code sends DA1 and XTVERSION at startup (F16). The daemon mirror answers. In xterm.js, register the **full** handler set from 6.2. xterm.js handler identifiers include the prefix and intermediates, so `{final:'c'}` does **not** catch DA2 (`CSI > c`), and `{final:'n'}` does not catch `CSI ? 6 n`. The browser build also answers OSC 4/10/11/12 colour queries, which headless does not (V5). In the CLI, strip queries from the output (V6) rather than filtering replies from stdin: CPR replies (`ESC[1;5R`) are indistinguishable from Ctrl+F3.
7. **`SerializeAddon` misses** cursor visibility, mouse encoding, DECSTBM and cursor style (F20). Track them yourself with parser hooks and re-emit them. DECSTBM homes the cursor, so re-emit CUP after it.
8. **`pty.kill()` is not a tree kill** (F12). Interactive bash also needs `set +H` if you type `!` in scripted input (history expansion broke the first test run).
9. **`ps -E` hides the environment of Apple platform binaries** (`/bin/sleep`, `/bin/sh`, `/usr/bin/perl`) on macOS 26 even for same-uid processes. The env marker only catches third-party binaries such as node, claude and homebrew python. `ps -o sess` is always 0 on macOS, so it's useless.
10. **macOS `sun_path` is 104 bytes** (F25). Keep the daemon/hook socket short, e.g. `~/.smurg/run/<8-char-id>.sock`, and check its length at startup.
11. **SEA main is CommonJS**, and inside a SEA plain `require` only loads built-ins. Load extracted files through `createRequire(<absolute path>)`. esbuild warns about `import.meta` in CJS output; use a `__filename` fallback (see `native-loader.ts`).
12. **macOS signing**: remove the signature before postject, then ad-hoc re-sign afterwards. Unsigned arm64 binaries get SIGKILLed (F29). Node's hardened-runtime signature is replaced by an ad-hoc one without the runtime flag, so pty.node (ad-hoc signed) loads without library-validation trouble.
13. **The blob must be built by the same Node binary it is injected into.** `useCodeCache: true` works for same-platform builds but must be `false` for cross-platform builds, so build each OS/arch natively in CI (and not in a Linux arm64 Docker container with postject, per the Node docs caveat).
14. **Extraction cache**: extract atomically (temp dir then rename), verify sha256 on every start (cheap: about 140 KB), and use a directory name keyed by the manifest hash so versions never mix. `SMURG_CACHE_DIR` overrides the location (used by the spike to stay out of `$HOME`).
15. **CUU with parameter 0 moves up by 1** (VT semantics). This bit the TUI fixture and will bite anyone writing repaint code.
16. **Lid close still sleeps a MacBook** even with `caffeinate -i` (a user-space assertion cannot override it). R1's "host offline within 10 s" UI is the real mitigation. On Linux, `--what=handle-lid-switch` may need polkit approval (unverified).
17. `@xterm/headless`'s `module` field points to a file it doesn't ship, and the serialize addon's typings reference `@xterm/xterm`. Use CJS default imports and `skipLibCheck`.
18. *(verifier)* **Only ready clients may receive `sink.resize()`.** A client that is still waiting for its snapshot must get the size inside the snapshot. Retry the snapshot if a resize happened while the parser caught up (V2).
19. *(verifier)* **The env marker (`SMURG_SESSION_ID`) is advisory.** Anything that runs arbitrary code in the session can remove it. Don't sell the kick as airtight on macOS without the V4 sweep.
20. *(verifier)* **srt `allowPty`**: required for any interactive TUI, and dangerous as shipped, because it opens every `/dev/ttys*` of the user. Restrict it to the session's own tty (V9). Also note that the wrapped command from srt 0.0.77 set `TMPDIR=/tmp/claude` in our runs. If every guest gets that same default, the sandbox owners should check it (not investigated further).
21. *(verifier)* **SEA + ESM dependencies**: esbuild's CJS output empties `import.meta`, and srt evaluates `import.meta.url` at module top level, so the SEA crashes at startup (`ERR_INVALID_ARG_TYPE` in `fileURLToPath`). Add `define: {'import.meta.url': '__smurgImportMetaUrl'}` and a banner that sets it from `__filename` (V10).
22. *(verifier)* **`NODE_OPTIONS` leaks into the SEA.** With the default config, `NODE_OPTIONS=--require=/nonexistent` crashed both the Node 24 and the Node 26 binaries. Set `"execArgvExtension": "none"` in the SEA config; verified to ignore `NODE_OPTIONS` on 22.22.1, 24.21.0 and 26.10.0.
23. *(verifier)* **A `smurg attach` terminal smaller than the PTY** (a non-owner, who therefore doesn't drive the size) renders wrapped, garbage rows: all 20 rows differed from the mirror in V8. Warn, or later render through a local headless terminal with cropping, as tmux does.
24. *(verifier)* The Linux prebuilds also need `libstdc++.so.6` (`GLIBCXX_3.4.22`), besides glibc ≥ 2.28 and `libutil`. Both are present on stock Ubuntu 24.04; musl/Alpine is not supported.

---

## 6. Verified code (trimmed from files that ran; full files are in the spike dir)

### 6.1 PTY session core: fan-out, owner input, coalescing, re-attach (`src/pty-session.ts`)

```ts
this.pty = pty.spawn(o.file, o.args ?? [], {
  name: 'xterm-256color', cols, rows, cwd: o.cwd,
  env: { ...o.env, SMURG_SESSION_ID: this.id }, // marker for kill-tree
  encoding: null,                                // raw Buffers, exact byte offsets
} as any);
this.mirror = new TermMirror(cols, rows, o.scrollbackLines ?? 5000, (reply) => this.pty.write(reply));
this.tail = new RawTail(o.rawTailBytes ?? (2 << 20));
this.pty.onData((d: any) => this.coalesce(Buffer.isBuffer(d) ? d : Buffer.from(d))); // 5 ms / 64 KiB

private onOutput(chunk: Buffer): void {
  const end = this.tail.append(chunk);
  this.mirror.write(chunk);
  for (const c of this.clients.values()) if (c.ready) c.sink.output(chunk, end);
  if (!this.paused && this.mirror.pendingBytes > HIGH_WATER) { this.paused = true; this.pty.pause(); /* resume < LOW_WATER */ }
}

// VERIFIED FIX (src/pty-session-fixed.ts in the -verify spike). The original version (a) called
// mirror.snapshot() with its 1000-line default, and (b) let applyResizePolicy() send sink.resize()
// to clients that were still waiting for their snapshot, which left them at the old size forever.
async attach(clientId, userId, sink, cols, rows, haveOffset?): Promise<'delta' | 'snapshot'> {
  const a = { clientId, userId, sink, cols, rows, lastActive: 0, ready: false };
  this.clients.set(clientId, a);
  if (userId === this.ownerId) this.touch(a);
  this.applyResizePolicy();                 // size change caused by this attach happens BEFORE sync
  const delta = haveOffset !== undefined && haveOffset >= this.lastResizeOffset ? this.tail.since(haveOffset) : null;
  let mode: 'delta' | 'snapshot';
  if (delta) { mode = 'delta'; sink.resize(this.pty.cols, this.pty.rows); if (delta.length) sink.output(delta, this.tail.end); }
  else {
    mode = 'snapshot';
    for (let attempt = 0; ; attempt++) {
      const gen = this.resizeGen;             // bumped by every applyResizePolicy() resize
      const snap = await this.mirror.snapshot(this.scrollbackLines);   // FULL mirror history (R4)
      const gap = this.tail.since(snap.offset);                         // bytes that arrived meanwhile
      if ((gen !== this.resizeGen || gap === null) && attempt < 5) continue; // resized while waiting: retry
      sink.snapshot(snap);
      if (gap?.length) sink.output(gap, this.tail.end);
      break;
    }
  }
  a.ready = true;                           // synchronous with the gap send: no loss, no duplicate
  if (this.state === 'exited') sink.exit(this.exitInfo!);
  return mode;
}

input(clientId: string, data: string | Buffer): boolean {
  const c = this.clients.get(clientId);
  if (!c || c.userId !== this.ownerId || this.state !== 'running') { this.droppedInputs.push(/*…*/); return false; }
  if (this.touch(c)) this.applyResizePolicy(); // typing makes this client the size driver
  this.pty.write(data as any);
  return true;
}
// applyResizePolicy('owner'): target = most recently active owner client (monotonic counter);
// clamp 20..500 x 5..200; flushOutput(); pty.resize(); mirror.resize(); lastResizeOffset = tail.end;
// resizeGen++; sink.resize(cols, rows) for READY clients only (verifier fix)
```

### 6.2 Mirror snapshot with exact offset and ordered resize (`src/term-mirror.ts`)

```ts
write(chunk: Buffer): number {
  this.enqueued += chunk.length; this.pendingBytes += chunk.length;
  this.term.write(chunk, () => { this.pendingBytes -= chunk.length; });
  return this.enqueued;
}
resize(cols: number, rows: number): void {           // IN STREAM ORDER
  this.term.write('', () => { this.term.resize(cols, rows); this.scrollRegion = null; });
}
snapshot(scrollbackLines = 1000): Promise<Snapshot> {
  const offset = this.enqueued;
  return new Promise((resolve) => this.term.write('', () =>
    resolve({ data: this.serializeNow(scrollbackLines), offset, cols: this.term.cols, rows: this.term.rows })));
}
private serializeNow(n: number): string {
  let s = this.ser.serialize({ scrollback: n });
  const buf = this.term.buffer.active;
  if (this.scrollRegion) s += `\x1b[${this.scrollRegion[0]};${this.scrollRegion[1]}r\x1b[${buf.cursorY + 1};${buf.cursorX + 1}H`;
  for (const m of this.mouseEncoding) s += `\x1b[?${m}h`;
  if (this.cursorStyle !== null) s += `\x1b[${this.cursorStyle} q`;
  if (this.cursorHidden) s += '\x1b[?25l';
  return s;
}
// constructor: this.term.onData(reply)  -> daemon answers DA1/DA2/CPR/DSR/DECRQM into the PTY
// parser hooks (return false = let xterm handle too): CSI ? h/l (25, 1005/1006/1015/1016), CSI r, CSI SP q
```

Client side (web xterm.js or CLI), as used by the test viewer:

```ts
// VERIFIED full set (vq/viewer-query-leak.mjs: nothing leaks; state-changing sequences unaffected).
// The original two handlers ({final:'c'}, {final:'n'}) still leaked DA2, DECXCPR, DECRQM, DECRQSS.
const p = term.parser, swallow = () => true;
for (const prefix of [undefined, '>', '=']) p.registerCsiHandler({ prefix, final: 'c' }, swallow);   // DA1/DA2/DA3
for (const prefix of [undefined, '?']) p.registerCsiHandler({ prefix, final: 'n' }, swallow);        // DSR/CPR/DECXCPR
for (const prefix of [undefined, '?']) p.registerCsiHandler({ prefix, intermediates: '$', final: 'p' }, swallow); // DECRQM
p.registerCsiHandler({ final: 't' }, (params) => [11, 13, 14, 15, 16, 18, 19, 20, 21].includes(params[0] as number)); // XTWINOPS reports
p.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow);                                   // DECRQSS
for (const id of [4, 10, 11, 12]) p.registerOscHandler(id, (data) => data.split(';').includes('?')); // colour QUERIES only (browser answers them)
onResize = (c, r) => term.write('', () => term.resize(c, r));          // ordered
onSnapshot = (s) => { term.write('', () => { term.reset(); term.resize(s.cols, s.rows); }); term.write(s.data); lastOffset = s.offset; };
onOutput = (chunk, end) => { term.write(chunk); lastOffset = end; };  // send lastOffset on reconnect
```

### 6.3 Tree kill (`src/kill-tree.ts`, measured 163–811 ms; not adversary-proof, see V3/V4)

```ts
// targets = descendants(rootPid by ppid) ∪ pidsWithEnvMarker('SMURG_SESSION_ID', id) ∪ members of their pgids
//           minus {0, 1, self, parent, own pgid}, minus zombies
for (let round = 0; round < 5 && Date.now() < deadline; round++) {
  const targets = await collectTargets(rootPid, opts.marker);
  if (targets.size === 0) break;
  signalAll(targets, 'SIGSTOP');                                   // freeze: no new forks
  for (const p of await collectTargets(rootPid, opts.marker)) targets.add(p);
  targets.forEach((p) => all.add(p));
  signalAll(targets, 'SIGKILL');
  while (Date.now() < deadline && (await stillAlive(targets)).length) await sleep(25);
}
// env marker: linux -> /proc/<pid>/environ split('\0').includes(`KEY=value`);
//             darwin -> `ps -E -A -ww -o pid=,command=` token match (third-party binaries only)
```

Verifier addition, the macOS sweep for escaped guest processes (V4; `pty-packaging-verify/sbx/sbxcheck.c` and `find-sandboxed2.mjs`). Each guest's srt profile can read its own random canary **file**; no guest can read the host canary **file**. Both files live under the host's `~/.smurg`, never in a shared temp dir:

```c
// private libsystem_sandbox SPI (also used by WebKit/Chromium); link: nothing extra
extern const enum sandbox_filter_type SANDBOX_CHECK_NO_REPORT;
int sandbox_check(pid_t pid, const char *operation, enum sandbox_filter_type type, ...);
// target(pid) := sandbox_check(pid, NULL, 0) == 1                                   // sandboxed at all
//             && sandbox_check(pid, "file-read-data", 1 | NO_REPORT, ownCanary) == 0   // may read THIS guest's canary
//             && sandbox_check(pid, "file-read-data", 1 | NO_REPORT, hostCanary) != 0  // may not read the host canary
//             && (for every other guest g) sandbox_check(..., canary[g]) != 0
// scan all `ps -U $UID` pids (~150 ms for 433 pids), SIGSTOP targets, re-check, SIGKILL.
```

### 6.4 `smurg attach` core (`q4/attach.ts`)

```ts
const RESTORE = '\x1b[?1049l' + '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l' + '\x1b[?2004l' +
  '\x1b[?1004l' + '\x1b[?2031l' + '\x1b[?1l\x1b>' + '\x1b[?7h' + '\x1b7\x1b[r\x1b8' + '\x1b[0m' + '\x1b[ q' + '\x1b[?25h';
function restore(msg?: string) {
  if (restored) return; restored = true;
  try { stdin.setRawMode(false); } catch {}
  stdin.pause();
  stdout.write(RESTORE + '\x1b[<u'.repeat(kittyPushes) + (msg ? `\r\n${msg}\r\n` : ''));
}
process.on('exit', () => restore());
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(sig, () => { restore(`[smurg: ${sig}]`); process.exit(129); });
sock.on('connect', () => { stdin.setRawMode(true); stdin.resume();
  send('session.attach', { cols: stdout.columns, rows: stdout.rows }); });
const TERMINAL_REPLY = /\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c|\x1b\[\d+;\d+R|\x1b\[0n|\x1b\[\?[\d;]*\$y|\x1bP>\|[^\x1b]*\x1b\\|\x1b\](?:10|11|12);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)|\x1b\[\?\d+u/g;
stdin.on('data', (raw: Buffer) => {
  const d = Buffer.from(raw.toString('latin1').replace(TERMINAL_REPLY, ''), 'latin1');
  if (!d.length) return;
  const cut = d.indexOf(0x1d) >= 0 ? d.indexOf(0x1d) : d.indexOf('\x1b[93;5u');      // Ctrl-]
  if (cut >= 0) { if (cut > 0) send('exec.input', { data: d.subarray(0, cut).toString('base64') });
    send('session.detach', {}); sock.end(); restore('[detached — session is still running]'); process.exit(0); }
  send('exec.input', { data: d.toString('base64') });
});
stdout.on('resize', () => send('exec.resize', { cols: stdout.columns, rows: stdout.rows }));   // SIGWINCH
// exec.snapshot -> stdout.write('\x1bc' + data); session.exit -> restore(); process.exit(exitCode)
```

**Verifier replacement for `TERMINAL_REPLY` (recommended):** strip queries from what is written to the local terminal, so it never answers anything. Then no stdin filter is needed, and no real keys can be eaten. The streaming, chunk-split-safe implementation is in `pty-packaging-verify/vq/query-strip.ts`. It passed a fuzz test over every split point, and `vq/attach-strip.test.ts` (the Q4 tests with no stdin filter at all).

```ts
const strip = new QueryStripper();          // drops CSI c / n / $p / >q / ?u / report-t, DCS $q / +q, OSC 4/10-19 '?' queries, all OSC 52
const out = (b: Buffer) => { stdout.write(strip.push(b)); clearTimeout(idle); idle = setTimeout(() => stdout.write(strip.flush()), 50); };
// exec.output -> out(chunk); exec.snapshot -> out(Buffer.from('\x1bc' + data)); stdin: only the Ctrl-] check
```

### 6.5 Loading node-pty inside a SEA (`q5/native-loader.ts`)

```ts
export function loadNodePty(): typeof NodePty {
  let sea: typeof import('node:sea') | undefined;
  try { sea = (process as any).getBuiltinModule?.('node:sea'); } catch {}
  if (!sea?.isSea()) return createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)('node-pty');
  const manifest = JSON.parse(sea.getAsset('node-pty/manifest.json', 'utf8'));
  const dir = path.join(cacheRoot(), `node-pty-${manifest.id}`);   // SMURG_CACHE_DIR | ~/Library/Caches/smurg | $XDG_CACHE_HOME/smurg
  const verify = () => Object.entries(manifest.files).every(([rel, sha]) => {
    try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex') === sha; } catch { return false; } });
  if (!verify()) {
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    for (const rel of Object.keys(manifest.files)) {
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, new Uint8Array(sea.getRawAsset(`node-pty/${rel}`) as ArrayBuffer));
      if (path.basename(rel) === 'spawn-helper') fs.chmodSync(dest, 0o755);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    try { fs.renameSync(tmp, dir); } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); if (!verify()) throw e; }
    if (!verify()) throw new Error(`node-pty extraction to ${dir} failed verification`);
  }
  return createRequire(path.join(dir, 'package.json'))('./lib/index.js');
}
```

### 6.6 Packaging build script (`q5/build-sea.mjs`, verified with Node 22.22.1 / 24.21.0 / 25.4.0 / 26.10.0)

```js
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['node-pty'], outfile: `${work}/app.cjs`,
  // verifier: ESM deps such as @anthropic-ai/sandbox-runtime read import.meta.url at load time
  define: { 'import.meta.url': '__smurgImportMetaUrl' },
  banner: { js: 'var __smurgImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' } });
// assets: node-pty/package.json, node-pty/lib/**/*.js, node-pty/prebuilds/<plat>-<arch>/{pty.node,spawn-helper}
//         + node-pty/manifest.json { id: sha256(files).slice(0,16), files: { rel: sha256 } }
const hasBuildSea = execFileSync(nodeBin, ['--help']).toString().includes('--build-sea'); // Node >= 25.5
const seaConfig = { main: `${work}/app.cjs`, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: true, assets,
  execArgvExtension: 'none' };   // verifier: ignore the host's NODE_OPTIONS (verified on 22.22.1 / 24.21.0 / 26.10.0)
if (hasBuildSea) {
  Object.assign(seaConfig, { executable: nodeBin, output: out });
  run(nodeBin, ['--build-sea', seaConfigPath]);
} else {
  Object.assign(seaConfig, { output: `${work}/sea-prep.blob` });
  run(nodeBin, ['--experimental-sea-config', seaConfigPath]);
  fs.copyFileSync(nodeBin, out); fs.chmodSync(out, 0o755);
  if (darwin) run('codesign', ['--remove-signature', out]);
  run('node_modules/.bin/postject', [out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(darwin ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
}
if (darwin) run('codesign', ['--sign', '-', '--force', out]);   // mandatory on arm64
```

Usage: `node q5/build-sea.mjs --node $(command -v node) --entry <daemon+cli entry> --out dist/smurg-darwin-arm64`. For the release, pass a Node 24 LTS binary as `--node`; the script auto-switches to `--build-sea` for Node ≥25.5.

### 6.7 Keep awake tied to the daemon's lifetime (`q6/keep-awake.ts`)

```ts
if (process.platform === 'darwin') {
  child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
} else if (process.platform === 'linux' && systemdInhibit) {
  child = spawn(systemdInhibit, ['--what=sleep:idle', '--who=smurg', `--why=${why}`, '--mode=block', 'cat'],
                { stdio: ['pipe', 'ignore', 'ignore'] });   // daemon death -> stdin EOF -> cat exits -> lock released
  (child.stdin as any)?.unref?.();
}
child?.on('error', () => {}); child?.unref();
```

---

## 7. How to re-run the spike

```sh
cd /private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/pty-packaging
./run-all.sh                    # deps, tsc, Q2 tests, Q3 compare/flood/memory, Q4 tests, Q5 SEA build+run, Q6 verify (~30 s)
NODE=~/.nvm/versions/node/v22.22.1/bin/node ./run-all.sh    # same on Node 22
# individual pieces
node --test --test-concurrency=1 test/q2-session.test.ts
node q3/compare.ts              # raw ring vs snapshot table
node q3/flood.ts                # coalescing / flow control
node --expose-gc q3/memory.ts 5000 120
node --test q4/attach.test.ts   # SMURG_ATTACH_NO_REPLY_FILTER=1 shows the duplicate-reply failure
q5/fetch-node.sh v24.21.0 v26.10.0                          # official tarballs, sha256-checked, into q5/nodes
node q5/build-sea.mjs --node q5/nodes/node-v26.10.0-darwin-arm64/bin/node --out dist/smurg-26   # --build-sea path
./q6/verify.sh
node q3/capture-claude.mjs      # optional: real Claude Code TUI bytes, isolated HOME, no credentials
```

Verifier spike (a fresh install, independent of the directory above, ~50 s): `/private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/pty-packaging-verify`. Run `./run-all.sh` (the original pipeline, still green with the verifier's build-script changes), then `./vq/run-verify.sh` (every V-check below). Run `q5/fetch-node.sh v24.21.0 v26.10.0 v22.18.0 v22.17.1` first to get the extra Node binaries.

Layout: `src/` (pty-session, term-mirror, raw-tail, kill-tree), `test/` (viewer stand-in + Q2 tests), `q1-*` (per-package install experiments), `q3/` (TUI fixture, Claude capture, comparisons), `q4/` (attach CLI + daemon stub + tests), `q5/` (native loader, build script, Node tarballs, SEA docs copy), `q6/` (keep-awake). All background processes started by the spike were killed at the end. `dist/` and the extraction cache are recreated by `run-all.sh`.

---

## Verification

Independent verifier, 2026-09-27, same machine (macOS 26.5.1 arm64). Everything was re-run from a fresh `pnpm install` in `pty-packaging-verify` (see section 7), on Node 25.4.0 and 22.22.1. The official Node tarballs 22.17.1, 22.18.0, 24.21.0 and 26.10.0 were downloaded into the spike and sha256-checked against `SHASUMS256.txt`. No real credentials were read. Every Claude Code run used an isolated `HOME`/`CLAUDE_CONFIG_DIR`, `PATH=/bin` (so its `security find-generic-password` lookup cannot run), a fake API key and `ANTHROPIC_BASE_URL=http://127.0.0.1:9`.

**Verdict: the recommendation holds** (node-pty 1.2.0-beta.15, engines `>=22.18.0`, Node 24 SEA with postject + ad-hoc codesign, hybrid headless-mirror scrollback, `owner` resize policy, caffeinate). The session-manager code, the client query handling and the build script needed the corrections below, and srt + node-pty needs one extra profile change. The inline edits above mark each correction with *Verifier*.

### Confirmed (re-run, same result)

- Q1: tarball modes (`spawn-helper` is 0644 in 1.1.0 and 0755 in 1.2.0-beta.15); 1.1.0 → `posix_spawnp failed.`; Linux prebuilds exist only in 1.2.0-beta.15. Their glibc symbols go up to 2.28 (checked statically), and they also need `libstdc++.so.6` / `GLIBCXX_3.4.22`. `@lydell/node-pty@1.2.0-beta.15` works. pnpm 10.34.5 prints "Ignored build scripts: node-pty" without `onlyBuiltDependencies`, and still spawns thanks to the prebuild. With it, the `install`/`postinstall` scripts run. The registry dist-tags are still `latest: 1.1.0`, `beta: 1.2.0-beta.15` (published 2026-08-03).
- Node: `schedule.json` confirms v25 end-of-life 2026-06-01, v24 LTS until 2028-04-30 (maintenance from 2026-10-20), and v26 LTS from 2026-10-28. `--build-sea` is present only in 26.10.0 (absent in 22.17.1, 22.18.0, 22.22.1, 24.21.0 and 25.4.0). Unflagged `.ts` works on 22.18.0 and fails on 22.17.1.
- Q2: the original suite passes 8/8 on Node 25.4.0 and 22.22.1. Kick timings were 161–187 ms (up to 811 ms under load). The perl double-fork daemon survives, `pty.kill()` leaves 4/5 survivors, and `ps -E` hides the environment of `/bin/sleep` but shows it for `node`.
- Q3: the `compare.ts` table reproduces (raw ring: DIFF / `normal instead of alternate` / 3455–3536 of 3536 history lines; snapshot: all same). Memory is 4.5 MiB (1000×120), 17.4 MiB (5000×120) and 33.5 MiB (10000×120). Coalescing ran at 7.0–8.5 MiB/s (630–811k raw chunks → 444–561 flushed), with pending bytes peaking at 0.06 MiB. The fixed `attach()` passes the original Q2 suite unchanged.
- The flow-control primitive works: `IPty.pause()` delivered 0 bytes over 500 ms, and after `resume()` all 300 000 lines arrived in order (this was not exercised by the original, which never paused).
- Q4: 2/2 on Node 25.4.0 and 22.22.1. With `SMURG_ATTACH_NO_REPLY_FILTER=1` the test fails with the duplicate `\x1B[?1;2` reply, as claimed. A 104-byte Unix socket path is accepted and 105 bytes gives EINVAL (so the "104-byte sun_path" statement is right).
- Q5: SEA binaries built on 24.21.0 (postject), 25.4.0 (postject) and 26.10.0 (`--build-sea`) print `isSea:true`, the tty and `20 90`. One run had `node_modules` renamed away and `HOME=/nonexistent`. First run takes 1.37–1.56 s, cached runs 0.06 s. The unsigned `--build-sea` output exits 137 and runs after `codesign --sign -`. `process.argv` is `[exe, exe, …args]` and self-re-invocation works (24 and 26). Sizes are 116 MiB / 36.9 MiB gzip / 23.6 MiB xz (Node 24). A curl download gets only `com.apple.provenance` and no `com.apple.quarantine`, like the locally built binaries that run.
- bun 1.3.11: over 3 runs, one lost its output (`signal: 1`) and two hung until the timeout, each leaving an orphaned `spawn-helper` (killed afterwards).
- Q6: the `caffeinate -i -w` assertion appears, and it exits about 10–13 ms after the daemon is SIGKILLed. The stdin-EOF child exits.

### Corrected / found (with evidence; scripts in `pty-packaging-verify/vq/`)

- **V1: re-attach lost history (R4).** `PtySession.attach()` called `mirror.snapshot()` with its 1000-line default. After 3000 lines, the mirror held 3008 lines and a re-attached viewer 1024, with `hist-1` missing (`session-refute.test.ts`). The fix is to pass the mirror's scrollback size; after it: 3008/3008.
- **V2: resize race.** `applyResizePolicy()` sent `sink.resize()` to a client still awaiting its snapshot; the snapshot (old size) then reset it. Result: guest stuck at 80×24 while PTY and mirror were 120×40, with no later resize to fix it. The fix is ready-only `sink.resize` plus a snapshot retry on `resizeGen` change. After it: `guest 120x40, viewportEqual:true`, and the whole buffer is equal.
- **V3: the env marker is not a boundary.** `env -u SMURG_SESSION_ID node -e '…spawn(…,{detached:true})…'` → `evaderSurvived:true` after `kickUser`. The same trick works on Linux (it's just an environment variable). Linux guests are still contained, because srt's bwrap always runs with `--unshare-pid --die-with-parent` (read from `linux-sandbox-utils.js` in 0.0.77), so orphans re-parent inside the namespace. Not run on Linux.
- **V4: macOS containment is possible.** `sbx/sbxcheck.c` uses `sandbox_check()`. With two deny-default Seatbelt "guests" each planting an `env -i` double-fork setsid daemon, the sweep over 433 same-uid processes (258 of them sandboxed) matched exactly guest A's daemon, no foreign process, in 150 ms. Guest B's daemon and an unsandboxed host process were untouched. **Incident to be aware of:** the first variant used a *directory* canary under `/private/tmp` and SIGKILLed its matches. That set included one unrelated same-uid process (pid 1350, started at boot; it was gone before it could be identified, and it hadn't been restarted by launchd a few minutes later). That variant was deleted. Use file canaries in `~/.smurg`, and SIGSTOP + re-check before SIGKILL.
- **V5: viewer query handling was incomplete.** With `{final:'c'}` + `{final:'n'}`, a viewer still answered DA2, DECXCPR, DECRQM (DEC and ANSI) and DECRQSS (`viewer-query-leak.mjs`). Browser `@xterm/xterm` 6.0.0 in jsdom additionally answered OSC 11/10/4 (`web-check/browser-osc.mjs`). The Q2 "exactly once with 3 viewers" test never wired viewer `onData` to the PTY, so it could not catch this. The full handler set in 6.2 leaks nothing and still applies state changes.
- **V6: better CLI approach.** Output-side `QueryStripper`: fuzzed at every split point, Q4 tests pass with **no** stdin filter, and on the real Claude REPL capture it removed 8 bytes with identical rendering and 0 local replies. It also removes OSC 52 (clipboard read/write by a remote session).
- **V7: more snapshot gaps than listed.** Lost: DEC line-drawing charset (ESC ( 0), G1 + SO, DECSC saved cursor, custom tab stops. There's an origin-mode bug in TermMirror's re-emitted CUP (row 11 instead of 7). Kept: SGR pen, IRM, DECAWM, pending wrap, DECSTBM across an alt-screen switch. None of these affects Claude Code 2.1.220 (its only DECSC use is the startup `ESC7 ESC[r ESC8`).
- **V8: CLI size.** An owner CLI attaching at a different size converges with the mirror (0 differing rows): reflow on shrink matches autowrap of the old-size snapshot, so the original order is fine there. A **non-owner** CLI at 60×20 on a 120×40 PTY differs in all 20 rows (`attach-guest-small.test.ts`).
- **V9: srt + node-pty (section 13 row).** This used srt 0.0.77's real profile. Without `allowPty`: `setRawMode` → `EPERM`, `stty` → `TIOCGETD: Operation not permitted`, and real `claude` renders but `/` does not open the command menu (no raw input). With `allowPty: true`: raw mode works, **and** the guest wrote into a separate same-uid pty and read `host-typed-password` typed into it (`pty-srt3.ts`). With the own-tty patch (`-D SMURG_TTY=$(tty)`; deny `^/dev/ttys`; allow `(param "SMURG_TTY")` and `/dev/ptmx`): `stty size` → `20 90`, raw mode ok, other tty write denied, read `EPERM`, and real `claude`'s slash menu opens (`claude-under-srt-slash.ts`). Caveat: the patch rewrites srt's generated command string. Pin the srt version and keep this test in CI.
- **V10: packaging additions.** (a) Bundling srt into the CJS SEA crashed at startup (`fileURLToPath(undefined)` from a top-level `import.meta.url` in `windows-sandbox-utils.js`). With the esbuild `define`/`banner`, the Node 24 SEA ran srt + node-pty: secret denied, work-dir write ok, outside write denied, network blocked. (b) `NODE_OPTIONS=--require=/nonexistent` crashed the default SEA on 24 and 26. `execArgvExtension: "none"` makes 22.22.1, 24.21.0 and 26.10.0 ignore it.
- **Minor:** the kick upper bound is 811 ms (under load), not 604 ms. Section 1 cited "F12–F14" for the raw-ring facts; they are F16–F17. The main-REPL capture (fake key) shows the same inline, no-alt-screen rendering as onboarding. After a width change, 2 of 42 history lines differ by a 2-cell shift (a SerializeAddon null-cell/wrap edge case): cosmetic.

### Still unverified

- Everything Linux at runtime: the prebuild load on Ubuntu 24.04, the SEA on Linux (including extracting `apply-seccomp` and setting `seccomp.applyPath` for srt), `/proc` marker scanning, bwrap PID-namespace teardown on kick, and `systemd-inhibit` polkit behaviour. No container runtime was running (colima was stopped with no instance), and starting one would have left the spike directory.
- Gatekeeper on a quarantined download: not tested, to avoid system dialogs. The install should use curl, which sets no quarantine attribute.
- A real model turn of Claude Code (streaming output, tool calls, permission dialogs) through the mirror. Only startup, typing, the slash menu and an error retry were captured.
- Whether the own-tty srt patch is complete for tools that allocate new PTYs inside the guest sandbox (they will fail: new `/dev/ttys*` slaves are denied). Also whether upstream srt will offer a per-tty option.
- The productized `sandbox_check` sweep (native helper packaging, behaviour on future macOS releases; it is private SPI).
