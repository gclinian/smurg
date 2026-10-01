# Claude Code hooks, config dirs, MCP config and login detection

> **Note (2026-10-01).** The parts of this report about guest sessions in srt's sandbox (a guest's own config dir and
> login, hooks reachable from inside the sandbox, `CLAUDE_CONFIG_DIR` and the host's `~/.claude` for guests) are
> historical: the owner removed guests' own agents and the guest sandbox (`docs/ARCHITECTURE.md` §11 D-15). Every
> session now runs as the host, with the host's config dir and login. The findings about hooks, MCP config and login
> detection themselves still apply.

Research spike for smurg [Prototype] (spec R4, R5, R8, §11, §13).
Target: originally **Claude Code 2.1.220** (the CLI installed on the host dev machine), macOS arm64, 2026-09-27.
**Verified and re-run on 2.1.283** (the version smurg must pin, because the team develops on Opus 5.5; see §1.7).
Where the two versions differ, the text below says so. The verifier's evidence is in [## Verification](#verification).
Spike code: `/private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/claude-hooks`
Verifier re-run (both versions + extra experiments): `…/scratchpad/spikes/claude-hooks-verify` (`./run-verify.sh`)

Method: almost every claim below was checked by running the real `claude` binary against a local
mock of the Anthropic Messages API (`mock-anthropic.mjs`). The mock scripts the model's tool calls and
records every request body, so we can see exactly what the model receives (e.g. the tool_result a hook
deny produces) without spending anyone's quota. One short real-model run (Opus 5, $0.16) confirmed the
deny path end to end. Interactive behaviour (dialogs, login screens, permission prompts) was driven
through a real PTY (`tui.py`, Python stdlib `pty`), the same way the daemon will drive it with node-pty.
The verifier re-ran every experiment on 2.1.220 and 2.1.283, added six experiments, and made one
real Opus 5.5 run on 2.1.283 ($0.12).

---

## 1. Recommendation

### 1.1 Deliver smurg's hooks with `--settings`, for host and guest alike

Every session the daemon starts gets
`claude --settings ~/.smurg/sessions/<id>/settings.json --mcp-config ~/.smurg/sessions/<id>/mcp.json …`.
Do **not** write hooks into `<project>/.claude/settings.local.json` (host) or `$CLAUDE_CONFIG_DIR/settings.json` (guest).

Both of those locations work (verified, experiments B and A). The problem is that other people can
write to them, and one of them can switch the other off:

* Anyone with the editor role can create `<share>/.claude/settings.local.json` containing
  `{"disableAllHooks": true}`. That silently turns off hooks defined in user settings (the guest
  layout). Experiment C2: the locked file was overwritten and no hook ran.
* The same file passed with `--settings` and `"disableAllHooks": false` wins over it (C3), because
  flag settings rank above project, local and user settings. It also wins over a user-level
  `disableAllHooks:true` (C).
* The file lives in `~/.smurg`, which is outside the shared folder and outside the guest's writable
  sandbox. The guest's agent cannot edit it. Nothing lands in the user's repo, so nothing can be
  committed by accident. Guest sessions don't pick up the host's hooks from the shared folder, and
  vice versa.

This departs from the wording of R4. It meets R4's intent ("don't touch the host's global settings")
more strictly.

### 1.2 Hook handler: a single exec-form command hook that talks to the daemon over the Unix socket

```json
{ "type": "command", "command": "/abs/path/to/smurg", "args": ["hook"], "timeout": 10 }
```

* Use exec form (`args` present, no shell). Both exec and shell form work in 2.1.220 (E6), but exec
  form needs no quoting and no `sh`. In production the command is the smurg SEA binary itself, so the
  sandbox doesn't need `node` on PATH.
* Protocol: read all of stdin (the hook JSON). Send one Envelope line
  `{"type":"hook.event","id","seq":0,"payload":{"sessionToken","hookInput"}}` to `$SMURG_HOOK_SOCKET`.
  Read one line back, `{"type":"hook.result","id","seq":0,"payload":{"hookOutput":{…}|null}}`. Print
  `hookOutput` (or nothing) and exit 0.
* **Fail closed in the hook itself.** Claude Code lets the tool run when a PreToolUse command hook
  times out (E1), exits 1 (E2), can't start (E4), or prints JSON that doesn't parse. The hook therefore
  enforces its own 5 s deadline, shorter than the 10 s `timeout`. On any error during PreToolUse it
  prints an explicit deny and exits 0 (E5 shows this works when the daemon is down).
* The session identity comes from the environment: the daemon sets `SMURG_SESSION_TOKEN` and
  `SMURG_HOOK_SOCKET` on the PTY, and hooks inherit Claude Code's environment (verified). Never trust
  `session_id` / `cwd` from stdin as identity.
* The token is **not secret from the session itself**: the agent's own `Bash` sees `SMURG_SESSION_TOKEN`
  and `SMURG_HOOK_SOCKET` (verified, `exp-scrub.mjs` `bashSawSmurgVars`). A prompt-injected agent can
  therefore send forged `hook.event`s *for its own session*, for example PreToolUse for many files to
  make them read-only for everyone. The daemon must treat hook events as claims: cap the number of
  locks per session, lock only paths inside the session's scope, and keep the 60 s TTL.
* **Also put kill-switch neutralizers in the same `--settings` file:**
  `"env": {"CLAUDE_CODE_SAFE_MODE": "0", "CLAUDE_CODE_SIMPLE": "0"}`. Safe mode and bare mode turn off
  *every* hook, including `--settings` hooks. They can be switched on from the launch env or from the
  `env` block of `$CLAUDE_CONFIG_DIR/settings.json`, which the guest's own agent can write. On 2.1.220
  a project `.claude/settings.json` with `env.CLAUDE_CODE_SIMPLE` also works. The `--settings` `env`
  value wins over all of them (verified on 2.1.220 and 2.1.283, `extra/exp-v-hook-kill.mjs`). smurg
  controls the flags, so `--safe-mode` / `--bare` are simply never passed.

### 1.3 Events to register (verified payloads in §3.3)

| Event | Matcher | Daemon action |
|---|---|---|
| `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | Acquire the agent lock on `realpath(tool_input.file_path ?? tool_input.notebook_path)`. If it can't, reply with a deny carrying the holder's name. On success, reply with **no decision**: never `"allow"`, which would skip the host's permission prompt. |
| `PostToolUse` | same | Release the lock and emit an activity-feed event (`tool_response.structuredPatch` holds the diff). |
| `PostToolUseFailure` | same | Release the lock. |
| `PermissionRequest` | same | No decision. Mark the lock "waiting for the host's approval" (the prompt is on screen). Fires in interactive sessions on both versions, and in `-p` only on 2.1.283 (verified). |
| `PermissionDenied` | same | Release the lock (auto-mode classifier denial; docs only, not exercised). |
| `UserPromptSubmit` | none | **Release every lock this session still holds**, then activity feed (`prompt`). This is the first event after the host *rejects* a permission prompt (verified, see below). |
| `Stop`, `SessionEnd` | none | Release every lock this session still holds. |
| `SessionStart` | none | Activity feed and liveness. |

A permission prompt the host rejects ("No" or Esc) fires **no** PostToolUse, PostToolUseFailure,
PermissionDenied **or Stop**. The next event is the `UserPromptSubmit` of the host's next prompt
(verified interactively on 2.1.220 and 2.1.283, `extra/exp-v-lifecycle-tui.py`; Stop does not run on a
user interrupt, as the hooks docs say). A `-p` auto-deny is different: the turn continues and `Stop`
fires (L-lifecycle). So a rejected edit keeps its lock until the next prompt, the session's next
PreToolUse, SessionEnd or the 60 s TTL. Keep the TTL from R8. Also release a session's previous lock
when the same session calls PreToolUse again. If the host takes longer than the TTL to approve, the
edit runs after the lock expired, and the R8 disk-diff fallback has to cover it.

Do **not** build on `FileChanged`. Its matcher registers *literal file names in the cwd*, not a
recursive watch: an Edit of `sub/deep.txt` with matcher `deep.txt` produced no event (verified). It
needs `watchPaths` from SessionStart/CwdChanged/FileChanged hooks to add paths, and it has no decision
control. *Correction:* it does fire for the Edit tool's own write (`change`), for Write creating a file
(`add`) and for an external process (verified on both versions once the session had been up for a
few seconds). The original experiment A missed the Edit because the Edit ran about 1 s after launch,
before the watcher was ready, so the first moments of a session are not covered. The daemon's own
recursive fs watcher is the source of truth for the R8 fallback.

Do **not** use `type: "mcp_tool"` hooks for locking. They work while the MCP server is up (H1), but
when the server isn't connected Claude Code lets the edit through (H2, fail-open).

### 1.4 Guest launch recipe (verified end to end by `exp-scrub.mjs` plus the TUI experiments)

1. Build the environment **from an allowlist** (`guest-env.mjs`). Then assert that none of the
   deny-pattern names is present (§4).
2. Directory layout: `HOME=<g>/home`, `CLAUDE_CONFIG_DIR=<g>/cfg`, `TMPDIR=<g>/tmp`. Set `BROWSER` to a
   no-op or a smurg relay; never leave it unset on macOS (§5). Also set `DISABLE_AUTOUPDATER=1` and
   `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`.
3. Pre-seed `<g>/cfg/.claude.json` with `projects[<realpath of cwd>].hasTrustDialogAccepted = true`.
   Otherwise the interactive session shows the trust dialog and withholds *all* hooks, including the
   `--settings` ones, until someone accepts it (T3a; re-verified with negative controls on both
   versions). The realpath of the cwd works when the cwd is a plain folder, a git repo root, a
   **subdirectory of a repo, or a git worktree (R9)**; the repo root key works too (verified,
   `extra/exp-v-trust-git.py`). On 2.1.283 the trust dialog's default choice is **"No, exit"**, so an
   un-seeded session that gets an Enter simply quits. If the guest is not logged in, don't pre-seed
   `hasCompletedOnboarding`, so Claude Code shows its own login-method screen.
4. Put these in the session settings file (§3.1): the hooks, `disableAllHooks:false`,
   `env:{CLAUDE_CODE_SAFE_MODE:"0",CLAUDE_CODE_SIMPLE:"0"}`,
   `disableDeepLinkRegistration:"disable"`, `permissions.allow:["mcp__smurg"]`,
   `permissions.disableBypassPermissionsMode:"disable"`, `claudeMdExcludes` for every ancestor
   directory of the share, and `disabledMcpjsonServers` listing every name in the share's `.mcp.json`
   (needed on 2.1.220 only: 2.1.283 no longer shows the "New MCP server found" dialog with
   `--strict-mcp-config`, verified; keeping it is harmless).
   The settings file must be readable but **not writable** inside the guest sandbox: keep it in a
   daemon-owned directory that srt allows to read, or pass it inline (`--settings '<json>'`, verified).
5. Flags: `--settings <file> --mcp-config <file> --strict-mcp-config`. No permission-mode flag: the
   guest's own permission mode (auto by default on 2.1.283) is their choice inside the sandbox.
6. When the guest leaves or is kicked: kill the PTY, run `claude auth logout` with the same env and a
   **1 s timeout**, then `rm -rf <g>`. The `rm -rf` is what actually removes the credential: inside the
   **hardened** srt profile the keychain write fails fast, so Claude Code falls back to
   `<g>/cfg/.credentials.json` (verified, §5.2). `claude auth logout` deletes that same file and took
   3.3 s inside srt on 2.1.283 (about 1 s outside), so don't let it block R4's "deleted within 5 s".
   Whether logout also revokes the token server-side is unverified. The host-side
   `security delete-generic-password` for the two derived names (§5.3) stays as belt and braces.

### 1.5 Host launch recipe

* Environment: the host's own, minus the variables a parent Claude Code session injects. The original
  list (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`) is
  **incomplete**. A session started from the Claude desktop app (like the verifier's) also carries
  `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_DESKTOP_APP_VERSION`, `CLAUDE_CODE_HOST_SESSION_ID`,
  `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`, `CLAUDE_CODE_OAUTH_SCOPES`,
  `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES`,
  `CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL`, `CLAUDE_CODE_DISABLE_CRON`,
  `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, `CLAUDE_CODE_TERMINAL_MCP_TOOLS`, `CLAUDE_CODE_EAGER_FLUSH`,
  `CLAUDE_CODE_REPORT_FINDINGS`, `CLAUDE_PREVIEW_CLASSIFIER_FLOOR` and `ANTHROPIC_BASE_URL`
  (observed names). Rule: when `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT` is present, drop `CLAUDECODE`,
  `AI_AGENT`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_*`, `CLAUDE_PREVIEW_*` and every
  `CLAUDE_CODE_*`, then re-add only user-intended provider variables (`CLAUDE_CODE_USE_*`,
  `CLAUDE_CODE_SKIP_*_AUTH`, `CLAUDE_CODE_CLIENT_*`, `CLAUDE_CODE_OAUTH_TOKEN`) if the host opts in.
  Always drop `CLAUDE_CODE_SAFE_MODE` and `CLAUDE_CODE_SIMPLE`; the `--settings` `env` neutralizers
  (§1.2) cover them too. Keep the host's own `ANTHROPIC_*` settings; that's their choice.
* Flags: `--settings <file>` (hooks, env neutralizers, `disableBypassPermissionsMode`,
  `disableDeepLinkRegistration`, **`permissions.defaultMode: "default"`**) and `--mcp-config <file>`
  **without** `--strict-mcp-config`, so the host keeps their own MCP servers. Nothing else: never
  `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` or `--permission-mode`.
* **Keeping the host's permission prompts (spec §11) needs `permissions.defaultMode`.** From 2.1.283,
  interactive sessions start in **auto mode**. Before that, Pro/Max/Team sessions that fetch feature
  flags did too (docs, permission-modes "Which mode a session starts in"). In auto mode a classifier
  approves edits and there is **no** "Do you want to make this edit?" prompt (verified: 2.1.283 T3c
  status line `⏵⏵ auto mode on`, the free.txt edit applied with no prompt). With
  `"permissions": {"defaultMode": "default"}` in the smurg `--settings` file, the session starts in
  Manual mode and the prompt comes back (verified, `extra/exp-v-lifecycle-tui.py`). The host can still
  Shift+Tab to another mode; make the default a host preference in smurg's console.
  `disableAutoMode:"disable"` is the stronger option: it removes auto mode from the cycle.
  The hook's deny works in every mode, including auto (verified in 2.1.283 T3c).
* **Protect the host from collaborator-written project configuration.** This is new and important.
  The host's session is unsandboxed and loads `<share>/.claude/settings.json`, `settings.local.json`,
  `.claude/skills`, `.claude/agents` and `.mcp.json`, and editors can write into the share. Verified:
  * A modified `.claude/settings.json` hook is hot-loaded mid-session and executed with no prompt
    (exp-plant `modify-existing`). On 2.1.283 a **newly created** `.claude/settings.json` is
    hot-loaded too (`default-sources`: planted hook ran; on 2.1.220 it did not).
  * A project `env.ANTHROPIC_BASE_URL` sends the session's API traffic, **including the credential
    header**, to another endpoint (exp-project-env, API key). Verified for a claude.ai
    **subscription OAuth token** as well: the `Authorization: Bearer` header of a fake OAuth login
    went to the planted URL (`extra/exp-v-oauth-baseurl.mjs`, both versions). So a planted project
    file steals the host's claude.ai access token.
  * A project `disableAllHooks` turns user-level hooks off (C2). On 2.1.220 a project
    `env.CLAUDE_CODE_SIMPLE:"1"` turns off every hook, `--settings` ones included (fixed in 2.1.283).

  Recommendation:
  * The daemon treats `<share>/.claude/**` and `<share>/.mcp.json` (and the same paths inside
    worktrees) as **host-only writable**. It rejects `file.write`, upload and delete from other
    principals, and the srt profile gets `denyWrite` for them.
  * Offer a "strict host" mode that adds `--setting-sources user`. That drops project and local
    settings, **and also project CLAUDE.md, skills and agents** (verified), so it can't be the default.

### 1.6 Login detection and the login guide

* Before launch and after a PTY exits, run `claude auth status --json` with the exact guest env:
  * exit 1 with `{"loggedIn":false,"authMethod":"none"}` means show the guide.
  * exit 0 with `loggedIn:true` means a credential is *present*. It is not validated: a fake token
    reports `true`.
* While the session runs, match TUI output with whitespace removed (the TUI positions text with cursor
  moves, so spaces disappear): `Selectloginmethod:`, `Pastecodehereifprompted>`,
  `OAutherror:Invalidcode`, `Loginsuccessful`, `Notloggedin·Run/login` (status bar),
  `Notloggedin·Pleaserun/login` (reply to a prompt), `DetectedacustomAPIkey`.
  **These strings are version-specific hints, not the detector.** On 2.1.283 the status-bar
  `Notloggedin·Run/login` no longer appears at startup (only the reply to a prompt does), and the
  Console option opens an extra screen ("Sign in with your Console account (recommended)" / "Create an
  API key (legacy)") before the URL. `claude auth status --json` behaves the same on both versions, so
  that is the detector; re-check the TUI strings whenever the pinned version changes.
* The remote-PTY login works as far as we can test without a real guest account. After a method is
  chosen, the TUI prints the **manual** URL (`redirect_uri=https://platform.claude.com/oauth/code/callback`)
  as an OSC 8 hyperlink, plus `Paste code here if prompted >`. A pasted code is exchanged: an invalid
  code gives `OAuth error: Invalid code… Press Enter to retry.`. In parallel Claude Code runs `$BROWSER`
  (default `open`) **on the host** with the *automatic* URL (`redirect_uri=http://localhost:<port>/callback`).
  → **Set `BROWSER`** to a no-op, or to a smurg helper that relays only the manual URL to the guest.
  Otherwise the host's browser opens a claude.ai consent page, and the host can accidentally authorize
  the guest session **with the host's own account**.
* API-key login: in the TUI this is option 2, "Anthropic Console account · API usage billing".
  On 2.1.220 it is an OAuth flow that mints a key. **On macOS a minted key is stored only in the
  Keychain (no file fallback; the binary throws "Failed to save API key to macOS Keychain")**, and
  with `HOME=<tmp>` or inside the hardened sandbox there is no usable keychain. So the minting path is
  expected to fail for guests on macOS hosts (unverified end to end). On 2.1.283 that path is the
  "(legacy) Create an API key" choice, still keychain-only (code read). The new default,
  "Sign in with your Console account (recommended)", is a token sign-in that probably uses the normal
  credential store with the `.credentials.json` fallback (not confirmed). The fallback that is known
  to work: the guest pastes a key into a smurg field, and the daemon passes it only as
  `ANTHROPIC_API_KEY` in that guest's PTY env. The TUI then asks "Detected a custom API key … Do you
  want to use this API key?" with **"No (recommended)" preselected on 2.1.283**. Pre-seeding
  `customApiKeyResponses.approved:[<last 20 chars of the key>]` in the guest `.claude.json` skips
  the question (verified, T3b/T3c). The key is visible to the guest's own Bash (their own key, inside
  their sandbox). The product owner must decide whether that conflicts with "smurg does not read or
  forward any token" (spec §11).

### 1.7 Version pin: exactly 2.1.283

> Superseded for the product by ARCHITECTURE §7.6: the minimum is 2.1.220, and both 2.1.220 and 2.1.283 are verified;
> the pin below reflected the development team's model.

The team develops on **Opus 5.5**, so the minimum is decided. 2.1.220 rejects it (`API Error: 400
Claude Code 2.1.220 does not support this model; version 2.1.280 or newer is required`, verified).
**Pin `@anthropic-ai/claude-code@2.1.283`**, the version this spike has now been re-run on end to end
(mock suite + extra experiments + one real Opus 5.5 run, $0.12). Do **not** follow the npm `stable`
dist-tag: on 2026-09-27 it pointed at 2.1.274, which is below 2.1.280. On 2.1.283 the default model
is `claude-opus-5-5` (mock requests carried it without `--model`).

What changed between 2.1.220 and 2.1.283 that matters here (all verified, details in
[## Verification](#verification)):
* Interactive sessions start in **auto mode**. The host needs `permissions.defaultMode:"default"`
  to keep prompts (§1.5).
* The deny reason reaches the model **with a prefix**: `PreToolUse:Edit hook error: <reason>` (§3.4).
* `--strict-mcp-config` no longer shows the "New MCP server found" dialog.
* A newly created project `.claude/settings.json` is hot-loaded mid-session.
* A project `env.CLAUDE_CODE_SIMPLE` no longer kills hooks.
* `PermissionRequest` fires for a `-p` auto-deny.
* The trust dialog defaults to "No, exit", and the API-key dialog to "No (recommended)".

The host machine's own CLI is 2.1.220 (`~/.local/bin/claude`). The daemon must check
`claude --version` at startup and refuse or warn below 2.1.283. It can also launch a pinned binary
of its own instead of whatever `claude` is on PATH.

---

## 2. Dependencies

Nothing was installed. The spike uses only:

| What | Version | Used by |
|---|---|---|
| Claude Code CLI (native build, pre-installed) | 2.1.220 | everything (`~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.220`) |
| Claude Code CLI (npm, local install in the verify dir, **the version to pin**) | 2.1.283 | verifier re-run (`claude-hooks-verify/cc/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, one 225 MB native binary) |
| `@anthropic-ai/sandbox-runtime` (reused from `spikes/sandbox-verify`, not reinstalled) | 0.0.77 | verifier's hardened-srt credential-store probe only |
| Node.js (nvm, pre-installed) | v25.4.0 | mock API, mock daemon, hook script, MCP server, runners (stdlib only) |
| Python (Homebrew, pre-installed) | 3.14 | PTY driver `tui.py` (stdlib `pty`) |

Production (daemon/cli) needs no npm package for this topic. The hook is a subcommand of the smurg
binary. The real coordination MCP server should use the official MCP SDK: the spike's hand-written
JSON-RPC server was enough to prove the config and permission behaviour, but it is not a product
recommendation.

---

## 3. Snippets to implement from

### 3.1 Session settings file (guest): base exercised by `exp-scrub.mjs`, `env`/`PermissionRequest` additions by the verifier's `extra/` runs (`PermissionDenied` docs only)

```json
{
  "disableAllHooks": false,
  "env": { "CLAUDE_CODE_SAFE_MODE": "0", "CLAUDE_CODE_SIMPLE": "0" },
  "disableDeepLinkRegistration": "disable",
  "hooks": {
    "SessionStart":       [{ "hooks": [H] }],
    "UserPromptSubmit":   [{ "hooks": [H] }],
    "PreToolUse":         [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [H] }],
    "PostToolUse":        [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [H] }],
    "PostToolUseFailure": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [H] }],
    "PermissionRequest":  [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [H] }],
    "PermissionDenied":   [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [H] }],
    "Stop":               [{ "hooks": [H] }],
    "SessionEnd":         [{ "hooks": [H] }]
  },
  "permissions": { "allow": ["mcp__smurg"], "disableBypassPermissionsMode": "disable" },
  "claudeMdExcludes": ["/Users/host/CLAUDE.md", "/Users/host/CLAUDE.local.md",
                       "/Users/host/.claude/CLAUDE.md", "/Users/host/.claude/rules/**", "… every ancestor up to /"],
  "disabledMcpjsonServers": ["<every server name in <share>/.mcp.json>"]
}
```
Here `H = { "type": "command", "command": "<abs smurg binary>", "args": ["hook"], "timeout": 10 }`. The
spike used `node <spike>/smurg-hook.mjs`.

The **host** file is the same minus `claudeMdExcludes` and `disabledMcpjsonServers`, **plus**
`"permissions": {"allow": ["mcp__smurg"], "disableBypassPermissionsMode": "disable", "defaultMode": "default"}`
(§1.5: without it, 2.1.283 starts in auto mode and the host gets no edit prompts).

`MultiEdit` does not exist in 2.1.220 or 2.1.283: the tool list sent to the API is `Agent, Bash, CronCreate,
CronDelete, CronList, Edit, EnterWorktree, ExitWorktree, NotebookEdit, Read, … WebFetch, WebSearch,
Workflow, Write`. The two versions differ only in agent/task tools: 2.1.283 adds `ListAgents` and
drops `TaskCreate/Get/List/Output/Update`. The file-editing tools are the same. The matcher `A|B|C` is
an exact-name list, so the extra name is harmless.

If the team insists on the spec's host location, the same `hooks` object in
`<project>/.claude/settings.local.json` works (verified, B). It needs the protections in §1.5.

### 3.2 MCP config (`--mcp-config <file> --strict-mcp-config` for guests)

```json
{ "mcpServers": { "smurg": { "type": "stdio", "command": "/abs/smurg", "args": ["mcp"], "env": {} } } }
```
The stdio server inherits Claude Code's environment (it saw `SMURG_SESSION_TOKEN`) and also gets
`CLAUDE_PROJECT_DIR`. Its tools show up as `mcp__smurg__<tool>`. They need an allow rule; without one,
a `-p` run denies them ("Claude requested permissions to use mcp__smurg__who_is_editing, but you
haven't granted it yet."). The server-level rule `"mcp__smurg"` allows them all (verified).

### 3.3 Hook stdin payloads (captured from 2.1.220, same fields on 2.1.283; paths shortened)

PreToolUse / Edit. This one comes from the real-model run; the mock runs produce identical shapes.
```json
{"session_id":"2e92a5cd-…","transcript_path":"<cfg>/projects/<key>/2e92a5cd-….jsonl","cwd":"<proj>",
 "prompt_id":"777053c2-…","permission_mode":"acceptEdits","effort":{"level":"high"},
 "hook_event_name":"PreToolUse","tool_name":"Edit",
 "tool_input":{"file_path":"<proj>/target.txt","old_string":"The quick brown fox jumps","new_string":"The quick brown cat jumps","replace_all":false},
 "tool_use_id":"toolu_013TMazGUPYZRmqj6qbGmTkL"}
```
PostToolUse / Edit (real model):
```json
{…common…,"hook_event_name":"PostToolUse","tool_name":"Edit",
 "tool_input":{"file_path":"<proj>/free.txt","old_string":"The dog sleeps.","new_string":"The wolf sleeps.","replace_all":false},
 "tool_response":{"filePath":"<proj>/free.txt","oldString":"The dog sleeps.","newString":"The wolf sleeps.",
   "originalFile":"The dog sleeps.\n","structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-The dog sleeps.","+The wolf sleeps."]}],
   "userModified":false,"replaceAll":false},
 "tool_use_id":"toolu_01Ghexp6VpMpCR3PVSJsAJNL","duration_ms":15}
```
Other shapes, all from the mock runs:
* `Write` (PreToolUse): `tool_input: {file_path, content}`.
* `Write` (PostToolUse): `tool_response: {type:"create"|"update", filePath, content, structuredPatch, originalFile:null|string, userModified}`.
* `NotebookEdit` (PreToolUse): `tool_input: {notebook_path, cell_id, new_source, edit_mode}`.
* `NotebookEdit` (PostToolUse): `tool_response: {new_source, old_source, cell_type, language, edit_mode, cell_id, error, notebook_path, original_file, updated_file}`.
* `SessionStart`: `{session_id, transcript_path, cwd, hook_event_name:"SessionStart", source:"startup"}`.
* `UserPromptSubmit`: `{…, permission_mode, hook_event_name, prompt}`.
* `Stop`: `{…, stop_hook_active:false, last_assistant_message, background_tasks:[], session_crons:[]}`.
* `SessionEnd`: `{…, reason:"other"}`.
* `FileChanged`: `{…, prompt_id, hook_event_name:"FileChanged", file_path:"<abs>", event:"change"}`.

Notes:
* `file_path` is always absolute but **not** symlink-resolved, so the daemon must `realpath` it.
  `/tmp` vs `/private/tmp` on macOS, and the R9 read-only symlinks, depend on this.
* An Edit whose `old_string` isn't found is rejected by input validation **before** hooks run: no
  PreToolUse, no PostToolUseFailure (A, `toolu_mock_9`).

### 3.4 Deny protocol and what the model sees

Print this on stdout and exit 0:
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"此檔案正由 Amy 編輯中，請先處理其他檔案或稍後再試"}}
```
* The model receives a `tool_result` with `is_error:true`. On 2.1.220 its text is **exactly** the
  reason (A). **On 2.1.283 it is prefixed**: `PreToolUse:Edit hook error: <reason>`
  (`PreToolUse:Write hook error: …` for Write). Verified in the mock request log and in a real Opus 5.5
  run, which quoted exactly that string. Write the reason so it still reads well after
  "hook error:", for example lead with "此檔案正由 Amy 編輯中…", and don't rely on the absence of a prefix.
* The TUI shows `⎿ Error: <reason>` (T3c; `⎿ Error: PreToolUse:Edit hook error: <reason>` on 2.1.283).
* `claude -p --output-format json` lists the call in `permission_denials`.
* Exit 2 also blocks, but the model then sees
  `PreToolUse:Edit hook error: [<command>]: <stderr>` (E3). Use JSON.
* A deny still blocks under `--permission-mode acceptEdits` and `bypassPermissions` (D).
* Real model (Opus 5, `exp-real.mjs`): `target.txt` was unchanged, and the final answer quoted the
  reason verbatim. Re-run on **2.1.283 with `--model claude-opus-5-5`** ($0.12): `target.txt`
  unchanged, `permission_denials: ["Edit target.txt"]`, and the answer quoted
  `PreToolUse:Edit hook error: 此檔案正由 Amy 編輯中…` verbatim. `free.txt` was edited, and the
  PostToolUse payload has the same shape as on 2.1.220.
* `"allow"` really skips the permission flow: in `-p` default mode an Edit that would be auto-denied
  ran when the hook returned `allow`, and was denied when the hook returned nothing (verified on both
  versions, `extra/exp-v-filechanged.mjs` part 2).

Timeouts: the default is 600 s for command hooks. Use `timeout: 10` and an internal 5 s deadline;
a timed-out hook lets the tool run (E1).

---

## 4. Environment scrub list

**Mechanism: allowlist, then denylist assertion.** Start from an empty env and add only:
`PATH` (claude bin dir + `/usr/bin:/bin:/usr/sbin:/sbin`), `HOME`, `CLAUDE_CONFIG_DIR`, `TMPDIR`,
`USER`, `LOGNAME`, `SHELL`, `TERM`, `COLORTERM`, `LANG`, optionally `LC_ALL` and `TZ`, `BROWSER`,
`DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`,
`SMURG_HOOK_SOCKET`, `SMURG_SESSION_TOKEN`. srt then adds its own proxy variables.

**Deny patterns** (assert that none of these is present, apart from the smurg-owned names above):
```
^ANTHROPIC_  ^CLAUDE (incl. CLAUDECODE)  ^AWS_  ^AZURE_  ^GOOGLE_  ^GCLOUD_  ^CLOUDSDK_  ^CLOUD_ML_  ^VERTEX_
^MCP_  ^OTEL_  ENABLE_BETA_TRACING_DETAILED  BETA_TRACING_ENDPOINT
(HTTP|HTTPS|ALL|NO)_PROXY (any case)  NODE_OPTIONS  NODE_EXTRA_CA_CERTS  NODE_TLS_REJECT_UNAUTHORIZED  SSL_CERT_FILE/DIR
^BUN_  ^DYLD_  LD_PRELOAD  LD_LIBRARY_PATH  SSH_AUTH_SOCK  GPG_AGENT_INFO  GIT_ASKPASS  GIT_SSH(_COMMAND)  GIT_CONFIG_*
*_TOKEN *_SECRET *_PASSWORD *_API_KEY *_ACCESS_KEY  ^XDG_  ZDOTDIR BASH_ENV ENV PROMPT_COMMAND  KUBECONFIG DOCKER_HOST/CONFIG/CERT_PATH
```

**Variables that override or redirect login in 2.1.220.** Sources: the binary's env-name table
(`strings`) plus the official env-var docs. All of them are covered by the prefixes above.

| Group | Names |
|---|---|
| Direct credentials | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` (+`CLAUDE_CODE_OAUTH_SCOPES`), `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN`, `CLAUDE_CODE_HOST_CREDS_FILE`, `CLAUDE_CODE_HOST_AUTH_ENV_VAR`, `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`, `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH`, `CLAUDE_BRIDGE_OAUTH_TOKEN`, `CLAUDE_TRUSTED_DEVICE_TOKEN`, `CLAUDE_SESSION_INGRESS_TOKEN_FILE`, `CLAUDE_API_KEY` |
| Where credentials are looked up | **`CLAUDE_SECURESTORAGE_CONFIG_DIR`**. Set to empty, it makes a session with a custom `CLAUDE_CONFIG_DIR` read the **default** keychain entry (the host's login). Verified: `loggedIn:false` → `true` with only this variable changed. Also `CLAUDE_CONFIG_DIR` (smurg sets it), `ANTHROPIC_CONFIG_DIR` (Anthropic profiles), `XDG_CONFIG_HOME`, `HOME`. |
| Provider switches | `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`, `CLAUDE_CODE_USE_GATEWAY`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_CODE_SKIP_{BEDROCK,VERTEX,FOUNDRY,MANTLE,ANTHROPIC_AWS,ANTHROPIC_GOOGLE_CLOUD}_AUTH` |
| Profiles / federation | `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_WORKSPACE_ID`, `ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_IDENTITY_TOKEN_FILE` |
| Endpoints / headers / TLS | `ANTHROPIC_BASE_URL`, `ANTHROPIC_{BEDROCK,BEDROCK_MANTLE,VERTEX,FOUNDRY,AWS,GOOGLE_CLOUD}_BASE_URL`, `CLAUDE_CODE_API_BASE_URL`, `CLAUDE_CODE_CUSTOM_OAUTH_URL`, `CLAUDE_CODE_OAUTH_CLIENT_ID`, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_BETAS`, `CLAUDE_CODE_CLIENT_CERT/KEY/KEY_PASSPHRASE`, `HTTP(S)_PROXY`, `NODE_EXTRA_CA_CERTS` |
| Cloud credentials | `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_AUTH_TOKEN`, `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_AWS_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_*`, `ANTHROPIC_VERTEX_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUD_ML_REGION`, `AZURE_*` |
| Parent Claude session (scrub for host too) | `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`, and (observed from the desktop app, verifier) `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_DESKTOP_APP_VERSION`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`, `CLAUDE_CODE_OAUTH_SCOPES`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES`, `CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL`, `CLAUDE_CODE_DISABLE_CRON`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, `CLAUDE_CODE_TERMINAL_MCP_TOOLS`, `CLAUDE_CODE_EAGER_FLUSH`, `CLAUDE_CODE_REPORT_FINDINGS`, `CLAUDE_PREVIEW_CLASSIFIER_FLOOR`, `ANTHROPIC_BASE_URL`. Use the prefix rule in §1.5, not a fixed list |
| Hook kill switches (drop for host and guest; neutralize in `--settings` `env`) | `CLAUDE_CODE_SAFE_MODE`, `CLAUDE_CODE_SIMPLE` (verified: either one in the launch env or in `$CLAUDE_CONFIG_DIR/settings.json` `env` turns off all hooks, `--settings` hooks included, unless the `--settings` `env` sets them to `"0"`) |

Verification (`exp-scrub.mjs`):
* The host env was polluted with fake `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK/VERTEX`, `CLAUDE_SECURESTORAGE_CONFIG_DIR=`,
  `AWS_*`, `GITHUB_TOKEN`, `NODE_OPTIONS`, `HTTPS_PROXY`, `SSH_AUTH_SOCK` and `CLAUDECODE`.
* In the resulting guest env, `claude auth status --json` returned exit 1, `loggedIn:false`.
* Inside the session, `Bash: env` showed none of those values.
* Claude Code itself adds `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`,
  `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`,
  `GIT_EDITOR` and `COREPACK_ENABLE_AUTO_PIN` to its subprocesses. 2.1.283 also adds
  `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_CODE_SESSION_ATTENDED`.
  That is expected. Re-verified on 2.1.283: `authStatus` exit 1 `loggedIn:false`, `bashEnvLeaks []`,
  locked file unchanged, ancestor CLAUDE.md not loaded.

Project `.claude/settings.json` `env` blocks are a second injection path: they may set
`ANTHROPIC_BASE_URL` (verified redirect). Only a few variables are ignored there (`CLAUDE_CONFIG_DIR`,
`HOME`, `TMPDIR`, `XDG_*`, OTEL exporters…). This path is covered by §1.5, not by env scrubbing.

---

## 5. CLAUDE_CONFIG_DIR, HOME, credentials

### 5.1 What lives where (observed with `HOME=<g>/home`, `CLAUDE_CONFIG_DIR=<g>/cfg`)

* `$CLAUDE_CONFIG_DIR/` contains:
  * `.claude.json`: onboarding, theme, per-project `hasTrustDialogAccepted`, MCP approval choices,
    `customApiKeyResponses`, userID and cached feature flags.
  * `settings.json`, `CLAUDE.md`, `skills/`.
  * `projects/<key>/*.jsonl` (transcripts and `memory/`), `sessions/`, `session-env/`,
    `history.jsonl`, `plugins/`, `backups/`, `.last-cleanup`.
  * `.credentials.json` (0600) when the Keychain can't be used.
* `$HOME/` contains `Library/Caches/claude-cli-nodejs/<key>/mcp-logs-*`, and, unless
  `disableDeepLinkRegistration` is set, `Applications/Claude Code URL Handler.app`, which is
  **registered with LaunchServices via `lsregister -R`**.
* Nothing under the real `~/.claude` or `~/.claude.json` was modified by any spike run (mtimes checked).
* **The real `~/.claude/CLAUDE.md` is not loaded** once `CLAUDE_CONFIG_DIR` is set, even with
  `HOME` left real (M1, M2). `$CLAUDE_CONFIG_DIR/CLAUDE.md` and `$CLAUDE_CONFIG_DIR/skills/*` *are*
  loaded, which is how guests import personal settings.
* **CLAUDE.md files in ancestor directories of the cwd are loaded** (M3). A share under
  `/Users/host/projects/x` therefore pulls in `/Users/host/CLAUDE.md` if it exists. `claudeMdExcludes`
  (settable through `--settings`, including inline JSON) removes it (verified). srt read-deny is the
  second layer.

### 5.2 Keychain behaviour on macOS

Derived from the binary, function `oG` / `_q`:

| Item | Keychain service | Account |
|---|---|---|
| OAuth credentials | `Claude Code-credentials` when `CLAUDE_CONFIG_DIR` is unset; otherwise `Claude Code-credentials-<first 8 hex of sha256(NFC(CLAUDE_CONFIG_DIR))>` | `$USER` |
| Console-minted API key | `Claude Code-<same hash>` | `$USER` |

Verified behaviour:
* With `HOME` real and `CLAUDE_CONFIG_DIR=<tmp>`, the host's login is not visible (`loggedIn:false`).
* With **`HOME=<tmp>`, `security` has no default keychain.** `security default-keychain` fails with
  "A default keychain could not be found" and the search list is `System.keychain` only. Claude Code's
  keychain read misses (exit 44) even for the default service name.
* Consequence for guests: their OAuth login can't land in the host's login keychain. The binary's
  storage layer falls back to `$CLAUDE_CONFIG_DIR/.credentials.json`. The fallback **read** was
  verified with a fake credential file (`auth status` → `loggedIn:true, authMethod:"claude.ai"`).

Caveat, now resolved for the sandboxed case (verifier):
* A probe `security add-generic-password` with `HOME=<tmp>` **outside** any sandbox **hung for more
  than 120 s** (killed; nothing was written; most likely waiting on a SecurityAgent "keychain not
  found" UI). Not repeated, to avoid dialogs on the host's desktop.
* Claude Code gives the keychain write 2 s (`et=2000`; the same constants are in 2.1.220 and
  2.1.283). A timed-out write counts as *transient* and **skips** the plaintext fallback
  (`primary_transient_skip_fallback`). A write that exits non-zero without timing out (and not with
  36 = keychain locked) uses the fallback (`plaintext_fallback_used`). Code read in 2.1.283.
* **Inside the hardened srt profile** (securityd Mach lookups stripped, `docs/research/sandbox.md`),
  the exact `security -i` `add-generic-password` form Claude uses **fails in about 30 ms with exit
  152, no timeout**, on both versions (`extra/exp-v-srt-credstore.mjs`, dummy item, nothing written to
  the real keychain: `find-generic-password` → 44). So a sandboxed guest's login takes the
  `.credentials.json` fallback inside `<g>/cfg` and disappears with `rm -rf <g>`. Also in the hardened
  sandbox: a fake `.credentials.json` gives `auth status` `true/claude.ai`, and `auth logout`
  deletes it.
* Consequence: the hardening is required for guest logins too, not only to hide the host keychain.
  With srt's default profile securityd is reachable. The write is then *expected* to behave like the
  unsandboxed temp-HOME probe: it hangs, may open a dialog on the host's desktop, and the login is not
  persisted. This was not tested, to avoid dialogs. A real-account login is still not verified end
  to end.

### 5.3 Complete removal of guest credentials (R4 "logout + delete temp dir")

1. `claude auth logout` with the guest env (same `CLAUDE_CONFIG_DIR`/`HOME`/`USER`) and a 1 s timeout.
   Verified: it deleted `$CLAUDE_CONFIG_DIR/.credentials.json` and `auth status` became
   `loggedIn:false`, also inside the hardened srt profile. It takes about 1 s outside srt and 3.3 s
   inside srt on 2.1.283, so it must not hold up step 3. Server-side revocation is unverified.
2. Belt and braces, run by the daemon with the real HOME:
   `security delete-generic-password -a "$USER" -s "Claude Code-credentials-<h8>"` and `-s "Claude Code-<h8>"`.
   Ignore exit 44 (not found).
3. `rm -rf <g>`. This also removes transcripts, `history.jsonl` and caches.
4. If deep-link registration was not disabled: `lsregister -u "<g>/home/Applications/Claude Code URL Handler.app"`.
   Better: always set `disableDeepLinkRegistration:"disable"` (verified: no app, no registration).

---

## 6. Verified facts

| # | Claim | Evidence |
|---|---|---|
| 1 | PreToolUse JSON deny blocks `Edit`, `Write` (existing file) and lets unlocked `Edit`/`Write(new)`/`NotebookEdit` through; the locked file stays byte-identical. Issue #37210 does not reproduce on 2.1.220 **or 2.1.283**. | `node exp-hooks.mjs A-guest`: `locked.txt` unchanged, 2 `permission_denials` (re-run by the verifier on both versions) |
| 2 | The deny reason reaches the model as `tool_result.is_error=true`: verbatim on 2.1.220, **prefixed with `PreToolUse:<Tool> hook error: ` on 2.1.283**. | mock request log (A); real runs: Opus 5 on 2.1.220 ($0.16) and Opus 5.5 on 2.1.283 ($0.12), `target.txt` unchanged both times |
| 3 | Hooks in `$CLAUDE_CONFIG_DIR/settings.json` are honoured. | A: SessionStart, Pre/Post events logged |
| 4 | Hooks in `<project>/.claude/settings.local.json` are honoured. | `exp-hooks.mjs B-host-local` |
| 5 | `--settings <file or inline JSON>` hooks are honoured; `disableAllHooks:false` there beats user `true` and project-local `true`. | C, C3; inline JSON used in exp-mcp and exp-claudemd-parent |
| 6 | A project-local `disableAllHooks:true` disables hooks from user settings. | C2: locked file overwritten, 0 hook events |
| 7 | A modified project `.claude/settings.json` hook is hot-loaded mid-session and run; a newly created file was not picked up within 3 s on 2.1.220 but **was on 2.1.283**; `--setting-sources user` prevents it. | `exp-plant.mjs` (both versions) |
| 8 | Project `settings.json` `env.ANTHROPIC_BASE_URL` redirects API calls, credential header included (API key **and claude.ai OAuth bearer**); `--setting-sources user` prevents it. | `exp-project-env.mjs`: all requests (with `x-api-key`) hit the "attacker" mock; `extra/exp-v-oauth-baseurl.mjs`: `authorization=<present>` at the planted URL |
| 9 | `--setting-sources user` also drops project skills, agents and CLAUDE.md. | `exp-project-skills.mjs` |
| 10 | Deny holds under `bypassPermissions`. | D |
| 11 | Fail-open cases: hook timeout, exit 1, missing script, `mcp_tool` hook with server down. Fail-closed: exit 2, JSON deny, smurg-hook with daemon down. | E1–E5, H2 |
| 12 | Exec form (`args`) and shell form both work. | A–D (exec), E6 (shell) |
| 13 | `MultiEdit` is not a tool in 2.1.220 or 2.1.283; `NotebookEdit` uses `tool_input.notebook_path`. | tool list in `requests.jsonl`; A payloads |
| 14 | Edits rejected by validation fire no hooks. A user-rejected permission prompt and a `-p` permission denial fire PreToolUse (and PermissionRequest) but no Post* event. **Corrected:** after a `-p` auto-deny `Stop` fires; after an **interactive** rejection (No or Esc) **no** Stop fires, and the next event is `UserPromptSubmit`. `SessionEnd` fires at exit. | A (`toolu_mock_9`), L-lifecycle; `extra/exp-v-lifecycle-tui.py` (both versions) |
| 15 | `FileChanged` exists and delivers `{file_path, event}`. **Corrected:** it fires for the Edit tool's own write (`change`), Write of a new file (`add`), Bash and external writers, once the watcher is up (A's Edit came ~1 s after launch and was missed). It does not fire for a file in a subdirectory. | A; `extra/exp-v-filechanged.mjs` (both versions) |
| 16 | Hook processes inherit the PTY env (`SMURG_SESSION_TOKEN`); MCP stdio servers inherit it too and get `CLAUDE_PROJECT_DIR`. | daemon attributed events to "Ian"; `mcp.jsonl` env probe |
| 17 | Interactive start with an empty config shows theme → "Detected a custom API key" (if env key) → Security notes → trust dialog → "New MCP server found" (even with `--strict-mcp-config`; **2.1.220 only**, gone on 2.1.283). No hook (not even SessionStart from `--settings`) runs before trust is accepted (re-verified with controls on both versions). On 2.1.283 the trust dialog preselects "No, exit". | `python3 exp-tui-session.py T3a`; `extra/exp-v-trust-git.py` CONTROL cases |
| 18 | Pre-seeded `.claude.json` (trust, optional onboarding and key approval) plus `disabledMcpjsonServers` gives zero dialogs; hooks active from the first turn. The seed key can be the cwd realpath also when cwd is a repo subdirectory or a git worktree. | T3c; `extra/exp-v-trust-git.py` |
| 19 | With a hook returning no decision, the normal permission prompt still appears **in Manual (`default`) mode** ("Do you want to make this edit to free.txt? 1. Yes 2. Yes, allow all edits during this session 3. No"); the TUI shows a hook deny as `⎿ Error: <reason>`. **On 2.1.283 the built-in start mode is auto, and no prompt appears unless `permissions.defaultMode:"default"` is set.** | T3c screen capture (2.1.220); 2.1.283 T3c (`auto mode on`, edit applied with no prompt); `extra/exp-v-lifecycle-tui.py` (prompt back with `defaultMode`) |
| 20 | `--mcp-config` + `--strict-mcp-config`: stdio server connected and listed from the first request in `-p`; `.mcp.json` servers ignored; tools need an allow rule; `"mcp__smurg"` works. | `exp-mcp.mjs` G1–G5 |
| 21 | Project `.mcp.json` servers are loaded without approval in `-p` mode. | G3 |
| 22 | `claude auth status --json`: exit 1 `{loggedIn:false,authMethod:"none"}` without credentials. With fake values it exits 0 and reports: `api_key` for `ANTHROPIC_API_KEY`; `oauth_token` for `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`; `third_party` plus `apiProvider` `bedrock`/`vertex`/`foundry` for `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`. Tokens are not validated. | `./exp-creds.sh` |
| 23 | Not logged in: `-p` exits 1 with `"Not logged in · Please run /login"` (both versions); the TUI status bar reads `Not logged in · Run /login` on 2.1.220 only (2.1.283 shows it only as the reply to a prompt). | `exp-notloggedin.py` (both versions) |
| 24 | Login screens: `Select login method:` with 1 subscription, 2 Console (API usage billing), 3 third-party. The manual URL is shown with an OSC 8 link and `Paste code here if prompted >`; the automatic localhost URL goes to `$BROWSER`; an invalid code gives `OAuth error: Invalid code…`. | `exp-tui-login.py`, `helpers/browser-logger.sh` |
| 25 | With `CLAUDE_CONFIG_DIR` set, the real `~/.claude/CLAUDE.md` is not loaded (HOME temp or real); ancestor-dir CLAUDE.md is loaded; `claudeMdExcludes` removes it. | `exp-claudemd.mjs`, `exp-claudemd-parent.mjs [exclude]` |
| 26 | `HOME=<tmp>` means no default keychain (`security default-keychain` exits 1 vs 0). `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` plus real HOME exposes the host login to a custom-config session (`loggedIn` false → true). | `./exp-creds.sh`, `REAL=1 ./exp-creds.sh` |
| 27 | `claude auth logout` removes `$CLAUDE_CONFIG_DIR/.credentials.json`. | `exp-creds.sh` (fake credential) |
| 28 | Interactive sessions create and `lsregister` `$HOME/Applications/Claude Code URL Handler.app`; `disableDeepLinkRegistration:"disable"` prevents it. | binary (`v2S`), `lsregister -dump` before and after |
| 29 | `permissions.disableBypassPermissionsMode:"disable"` in `--settings` stops `--dangerously-skip-permissions` / `--permission-mode bypassPermissions` from bypassing: the Bash call was blocked, and ran without it. | `exp-nobypass.mjs` |
| 30 | A nested launch with `CLAUDECODE=1` is not refused in `-p`. | `exp-nested.mjs` |
| 31 | 2.1.220 rejects `--model claude-opus-5-5` (needs ≥ 2.1.280); its default model is `claude-opus-5[1m]`. 2.1.283 runs Opus 5.5 (real run) and uses `claude-opus-5-5` by default. | `node exp-real.mjs claude-opus-5-5` on both versions |
| 32 | The Unix socket path limit on macOS is 104 bytes; the spike's socket path (137 bytes) had to be reached relative to its directory. | `smurg-hook.mjs` / `mock-daemon.mjs` chdir trick |
| 33 | `CLAUDE_CODE_SAFE_MODE=1` / `CLAUDE_CODE_SIMPLE=1` (launch env, or `$CLAUDE_CONFIG_DIR/settings.json` `env`) and `--safe-mode` turn off all hooks, `--settings` ones included. An `env` block in `--settings` setting both to `"0"` wins over the env and user-settings values. Project `env` can't flip safe mode; on 2.1.220 it can flip `CLAUDE_CODE_SIMPLE`. | `extra/exp-v-hook-kill.mjs` (both versions) |
| 34 | Inside the hardened srt profile, `security -i add-generic-password` fails in ~30 ms (exit 152, not a timeout), so Claude Code's secure storage takes the `.credentials.json` fallback. | `extra/exp-v-srt-credstore.mjs` + code read (`et=2000`, `Fs=36`, `primary_transient_skip_fallback`) |

---

## 7. Unverified / could not test here

* **Guest login persisted inside srt on macOS, end to end:** the deciding step is now verified: in
  the hardened profile the keychain write fails fast, so the `.credentials.json` fallback is taken
  (§5.2). A full successful OAuth login with a real guest account was still not performed. Needs a
  real account inside the real sandbox.
* **Console login for guests on macOS:** the 2.1.220 flow and the 2.1.283 "(legacy) Create an API
  key" choice store the key keychain-only (code read), so they are expected to fail. The 2.1.283
  "Sign in with your Console account (recommended)" token flow: storage not confirmed. Not exercised.
* **Keychain reachability from inside srt:** answered by the sandbox researcher (`sandbox.md`): srt's
  default profile exposes the host keychain (71 items); `hardenMacosProfile()` closes it (0 items).
  The hardening is also what makes guest logins persist (§5.2).
* Whether `claude auth logout` revokes the token server-side (only local deletion was observed).
* Whether `lsregister` or `open` succeed inside srt. They are irrelevant once `BROWSER` and
  `disableDeepLinkRegistration` are set.
* Linux hosts: file-based credentials are expected in `$CLAUDE_CONFIG_DIR/.credentials.json` (per the
  docs). Not tested.
* `disableAutoMode` (docs only). `PermissionDenied` (auto-mode classifier denial) was not exercised;
  releasing locks there is docs-based.
* Auto mode's starting behaviour on 2.1.220 with a real Pro/Max/Team login (docs say auto when
  feature flags are fetched; the spike only ran 2.1.220 TUI sessions with an API key and
  nonessential traffic disabled, which start in Manual).
* Whether a guest editing `$CLAUDE_CONFIG_DIR/settings.json` **mid-session** changes hooks for the
  running session (only startup was tested; the `--settings` `env` neutralizer covered startup).

---

## 8. Gotchas

1. **Hooks fail open.** Timeout, exit 1, crash, missing binary and unparseable JSON all let the tool
   run. Only exit 2 or a JSON deny blocks, so the hook must turn its own failures into a deny (§1.2).
2. **A permission prompt the user rejects fires no Post* event and no Stop** (interactive; verified on
   both versions). Release locks on the next `UserPromptSubmit` or PreToolUse from that session,
   `Stop`, `SessionEnd` and the TTL. While a host prompt is open (`PermissionRequest` fired), the lock
   is held and humans see the file read-only.
3. Never return `permissionDecision:"allow"`. It skips the host's permission prompt, which spec §11
   wants kept (verified: `allow` let a `-p` default-mode edit through). "No output" means "continue
   with normal permissions".
4. The workspace trust dialog holds back **all** settings hooks, `--settings` included, in
   interactive sessions. Pre-seed `hasTrustDialogAccepted` for guests, using the **realpath** as the
   key; this works for repo subdirectories and worktrees too. On 2.1.283 an un-seeded dialog
   preselects "No, exit".
5. 2.1.220 shows "New MCP server found in this project" even with `--strict-mcp-config`. Typed input
   goes into that dialog (T3b lost the prompt that way). `disabledMcpjsonServers` needs exact names;
   there is no wildcard. 2.1.283 no longer shows it (verified).
5a. **2.1.283 starts interactive sessions in auto mode.** No edit prompts unless
   `permissions.defaultMode:"default"` is set (§1.5). Pro/Max/Team hosts on older versions may already
   be in auto mode (docs).
5b. **Safe/bare mode kill every hook.** `CLAUDE_CODE_SAFE_MODE` / `CLAUDE_CODE_SIMPLE` from the env or
   from a user-settings `env` block (which a guest's agent can write) switch off even `--settings`
   hooks. Neutralize both in the `--settings` `env` (§1.2).
5c. **The deny text is prefixed on 2.1.283** (`PreToolUse:Edit hook error: …`). Tests that compare
   the model-visible text must allow for it.
6. `$BROWSER` / `open` is invoked **on the host** with the localhost-redirect OAuth URL. Always set it.
7. `HOME=<tmp>` changes more than config: it hides the macOS login keychain, moves caches, and makes
   Claude create and register `~/Applications/Claude Code URL Handler.app` unless
   `disableDeepLinkRegistration` is set.
8. `CLAUDE_SECURESTORAGE_CONFIG_DIR` (undocumented in the env reference) sends a relocated session
   back to the default keychain entry. Scrub it.
9. Project settings (`hooks`, `env`, `permissions`, `apiKeyHelper`, `disableAllHooks`) are code
   execution or credential exfiltration on the unsandboxed host. Make `.claude/**` and `.mcp.json`
   host-only writable.
10. Hook `file_path` is not realpath-resolved; macOS `/tmp` is `/private/tmp`.
11. Unix socket paths on macOS max out at 104 bytes. Keep them short (`~/.smurg/run/d.sock`); for
    guests with a long temp HOME, use a relative connect or a short path.
12. The TUI renders text through cursor moves, so match output with whitespace removed. The spike's
    own `exp-tui-login.py` booleans `theme_screen_seen` / `paste_prompt_seen` use regexes *with*
    spaces and therefore report `false` even though both screens appear (checked in `tui.raw`). Don't
    copy that pattern into smurg.
13. `claude auth status` checks presence, not validity. A revoked or expired token still reports
    `loggedIn:true`; catch `Login expired · Please run /login` / `OAuth token revoked` in the TUI.
14. `claude -p` in 2.1.220 applies project settings without a trust prompt and loads `.mcp.json`
    servers without approval. Irrelevant for the PTY product, relevant for any automation smurg runs
    with `-p`.
15. An Edit that fails validation ("String to replace not found") never reaches PreToolUse, so no
    lock is taken and none needs releasing.
16. Starting `smurg host` from inside a Claude Code session leaks `CLAUDECODE`,
    `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*` and similar into the children. The desktop
    app adds about 15 more `CLAUDE_CODE_*` names (§4). Scrub them by prefix for host sessions too.
16a. The agent can read its own `SMURG_SESSION_TOKEN` (it is in its Bash env). Treat hook events as
    claims and bound them (§1.2).
16b. The npm `stable` dist-tag (2.1.274 on 2026-09-27) is too old for Opus 5.5. Pin an exact version.
17. Side effects of this spike on this machine:
    * Two throwaway URL-handler apps were registered with LaunchServices by early TUI runs. They were
      unregistered (`lsregister -u`, verified 0 left), and the runner now disables registration.
    * The single `security add-generic-password` probe with a temp HOME may have shown a macOS
      keychain dialog on the desktop. It wrote nothing (verified) and can be dismissed with Cancel.

---

## 9. Verified code (trimmed; full files in the spike dir)

Hook: stdin → socket → stdout, fail-closed (`smurg-hook.mjs`):
```js
let hookInput = null;
try {
  hookInput = JSON.parse(await readStdin());
  const id = randomUUID();
  const reply = await ask(process.env.SMURG_HOOK_SOCKET, {            // 5 s internal deadline
    type: 'hook.event', id, seq: 0,
    payload: { sessionToken: process.env.SMURG_SESSION_TOKEN || '', hookInput },
  });
  if (reply?.type !== 'hook.result' || reply.id !== id) throw new Error('bad daemon reply');
  if (reply.payload?.hookOutput) process.stdout.write(JSON.stringify(reply.payload.hookOutput));
  process.exit(0);
} catch (err) {
  if (hookInput?.hook_event_name === 'PreToolUse' || hookInput === null) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
      permissionDecision: 'deny', permissionDecisionReason: `smurg: workspace daemon unreachable (${err.message}); edit blocked…` } }));
  }
  process.exit(0);
}
```

Daemon side lock decision (`mock-daemon.mjs`):
```js
if (ev === 'PreToolUse' && EDIT_TOOLS.has(hookInput.tool_name)) {
  const file = fs.realpathSync(hookInput.tool_input.file_path || hookInput.tool_input.notebook_path);
  const holder = humanLocks[file];
  if (holder) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `此檔案正由 ${holder} 編輯中，請先處理其他檔案或稍後再試` } };
  agentLocks.set(file, { token: sessionToken, toolUseId: hookInput.tool_use_id, at: Date.now() });
  return null;                       // no decision => normal permission flow (host keeps prompts)
}
```

Launch (from `exp-scrub.mjs`, which runs end to end):
```js
const env = buildGuestEnv({ guestDir, claudeBinDir, hookSocket, sessionToken: 'tok-ian', browser: '/usr/bin/true', hostEnv });
assertScrubbed(env);                                     // throws on any denied name
writeJson(`${guestDir}/session-settings.json`, sessionSettings({ hookCommand, hookArgs, role: 'guest',
  disabledMcpjsonServers: projectMcpServerNames(proj), ancestorsClaudeMd: ancestorClaudeMdPaths(proj) }));
writeJson(`${guestDir}/mcp.json`, mcpConfig({ command: smurgBin, args: ['mcp'] }));
seedGuestClaudeJson(`${guestDir}/cfg`, proj);            // projects[realpath].hasTrustDialogAccepted = true
spawn(claude, ['--settings', `${guestDir}/session-settings.json`, '--mcp-config', `${guestDir}/mcp.json`, '--strict-mcp-config'], { cwd: proj, env });
```

Login check:
```js
try { execFileSync(claude, ['auth', 'status', '--json'], { env, cwd }); /* exit 0: credential present */ }
catch (e) { if (e.status === 1 && JSON.parse(e.stdout).loggedIn === false) showLoginGuide(); }
```

---

## 10. How to re-run the spike

```bash
cd /private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/claude-hooks
./run-all.sh              # all mock-model experiments (free, a few minutes, needs node + python3 + claude)
REAL=1 ./run-all.sh       # + one real-model run with the host's own login (~$0.2)
REAL=1 ./exp-creds.sh     # + the CLAUDE_SECURESTORAGE_CONFIG_DIR check (reads the host login, prints booleans only)
CLAUDE_BIN=/path/to/other/claude ./run-all.sh   # e.g. to re-check on >= 2.1.280

# verifier: both versions (2.1.220 + local npm 2.1.283) + the extra experiments, ~15 min, mock only
/private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/claude-hooks-verify/run-verify.sh
REAL=1 …/claude-hooks-verify/run-verify.sh      # + one Opus 5.5 run on 2.1.283 (~$0.12)
```
Each experiment writes `run/<name>/` (`result.json`, `requests.jsonl` = what the model saw,
`events.jsonl` = hook stdin payloads, `tui.raw` = PTY transcript). Single experiments:
`node exp-hooks.mjs <A-guest|B-host-local|C-flag-settings|C2-project-disables|C3-flag-beats-project|D-bypass|E1-timeout|…|L-lifecycle>`,
`node exp-mcp.mjs <G1…|H2…>`, `python3 exp-tui-session.py <T3a|T3b|T3c>`.

Files:
* `mock-anthropic.mjs`: scripted fake Messages API (SSE).
* `mock-daemon.mjs`: Unix-socket lock server.
* `smurg-hook.mjs`: the reference hook.
* `smurg-mcp.mjs`: minimal stdio MCP server.
* `guest-env.mjs`: env allowlist and denylist.
* `session-settings.mjs`: settings, MCP config and `.claude.json` seed generators.
* `tui.py`: PTY driver.
* `helpers/*.sh`: failure-mode hooks and the `$BROWSER` logger.

---

## Verification

Independent re-run and review by a second engineer, 2026-09-27/28, on the same machine (macOS arm64,
Darwin 25.5, Node v25.4.0). The corrections are already folded into the sections above. This section
lists the evidence.

### Method

* The spike scripts were copied unchanged into `…/scratchpad/spikes/claude-hooks-verify/{v220,v283}`
  and `run-all.sh` was re-run in full against two CLIs:
  * the host's **2.1.220** (`~/.local/share/claude/versions/2.1.220`);
  * a fresh local npm install of **2.1.283** (`claude-hooks-verify/cc`, `npm install
    @anthropic-ai/claude-code@2.1.283`; nothing global).

  2.1.283 matters because the team develops on Opus 5.5 and 2.1.220 cannot run it.
* Six extra experiments in `claude-hooks-verify/extra/` target claims that were asserted but not
  really exercised. All run on both versions:
  * `exp-v-lifecycle-tui.py`: interactive Yes/No/Esc on the permission prompt with every lifecycle
    hook registered.
  * `exp-v-filechanged.mjs`: FileChanged with a delayed first edit and a subdirectory; `allow` versus
    no decision.
  * `exp-v-trust-git.py`: trust seeding for a git root, a subdirectory and a worktree, with negative
    controls.
  * `exp-v-oauth-baseurl.mjs`: OAuth bearer versus a planted `ANTHROPIC_BASE_URL`.
  * `exp-v-hook-kill.mjs`: safe/bare-mode kill switches and the `--settings` `env` neutralizer.
  * `exp-v-srt-credstore.mjs`: keychain write and plaintext fallback inside the hardened srt profile,
    reusing `spikes/sandbox-verify`'s srt 0.0.77 and `harden.ts`.
* One real-model run: `exp-real.mjs claude-opus-5-5` on 2.1.283 (host login, **$0.12**).
  `REAL=1 exp-creds.sh` on 2.1.283 printed booleans only.
* Static reading of the 2.1.283 binary (`strings`) for the secure-storage fallback logic, the OAuth
  endpoint selection and the Console login flow.
* Re-run everything: `claude-hooks-verify/run-verify.sh` (add `REAL=1` for the Opus 5.5 run).

### Confirmed (re-run reproduced the claim; on both versions unless noted)

* JSON deny blocks Edit and Write; the file stays byte-identical. Also holds under `acceptEdits`,
  `bypassPermissions` and (2.1.283 TUI) auto mode. Issue #37210 does not reproduce. Real Opus 5.5
  run: `target.txt` unchanged, `permission_denials: ["Edit target.txt"]`.
* Fail-open on timeout, exit 1, missing script and an `mcp_tool` hook whose server is down.
  Fail-closed on exit 2, JSON deny, and smurg-hook with the daemon down (E1–E5, H2).
* Hooks are honoured from `$CLAUDE_CONFIG_DIR/settings.json`, `<project>/.claude/settings.local.json`
  and `--settings` (file and inline). A `--settings` `disableAllHooks:false` beats project-local and
  user `true`. A project-local `true` kills user-level hooks (C2).
* A planted/modified project `.claude/settings.json` hook is hot-loaded, and a project
  `env.ANTHROPIC_BASE_URL` redirects the credential. `--setting-sources user` blocks both but also
  drops project CLAUDE.md, skills and agents.
* `--mcp-config` + `--strict-mcp-config`: the server is up from the first request; `.mcp.json` is
  ignored; tools need `mcp__smurg`; `-p` loads `.mcp.json` without approval.
* `disableBypassPermissionsMode` stops both bypass flags. A nested launch with `CLAUDECODE=1` works.
* `CLAUDE_CONFIG_DIR` hides the real `~/.claude/CLAUDE.md` (HOME temp and HOME real; the host file
  really contains the marker), and loads the guest's own CLAUDE.md and skills. Ancestor CLAUDE.md is
  loaded, and `claudeMdExcludes` removes it. `realHomeEntriesTouched: []`.
* `auth status --json` semantics, including exit codes and the fake env credentials (2.1.283 adds
  `configDirectory`/`projectsDirectory` fields). `auth logout` deletes `.credentials.json`.
  `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` exposes the host login (`false` → `true`) on 2.1.283 too.
* Guest env allowlist: `auth status` gives not-logged-in, no leaked values in Bash `env`, the lock
  holds, and ancestor CLAUDE.md stays excluded.
* Hook payload fields are identical on 2.1.220 and 2.1.283 (real runs): `session_id, transcript_path,
  cwd, prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, tool_use_id`; Post
  adds `tool_response`, `duration_ms`. `MultiEdit` does not exist in either version.
* Login screens: theme → `Select login method:` → OSC 8 manual URL + `Paste code here if prompted >`.
  `$BROWSER` gets the localhost-redirect URL. Invalid code → `OAuth error: Invalid code`. The spike's
  own booleans say `false` for two of these screens only because its regexes contain spaces; the raw
  transcripts contain them.
* `permissionDecision:"allow"` skips the permission flow; no decision keeps it.

### Corrected

| Original claim | Correction | Evidence |
|---|---|---|
| "Stop and SessionEnd still fire" after a rejected permission prompt, so release locks on Stop/SessionEnd | True only for a `-p` auto-deny. After an **interactive** rejection (No or Esc) no PostToolUse, PostToolUseFailure, PermissionDenied **or Stop** fires; the next event is `UserPromptSubmit`. Release locks on UserPromptSubmit / next PreToolUse / Stop / SessionEnd / TTL | `extra/exp-v-lifecycle-tui.py`: `no` and `esc` variants, events after answer = `[SessionStart, UserPromptSubmit, PreToolUse:Edit, PermissionRequest:Edit]`, both versions. The original T3 never registered Stop, so it could not show this |
| Host keeps permission prompts with "no permission-mode flag" | On 2.1.283 interactive sessions start in **auto mode** (docs: "With Claude Code v2.1.283 or later, auto mode is the built-in starting permission mode"; earlier versions on Pro/Max/Team with feature flags). No edit prompt appears. Add `permissions.defaultMode:"default"` to the host's `--settings` | 2.1.283 T3c: `⏵⏵automodeon`, free.txt edited, `permission_prompt_seen:false`; with `defaultMode:"default"` the prompt is back (`prompt_seen:true`) |
| The deny reason reaches the model "exactly … with no prefix" | Version-specific. 2.1.283 sends `PreToolUse:Edit hook error: <reason>` | `v283/run/hooks-A-guest/requests.jsonl`; the real Opus 5.5 answer quoted the prefixed string |
| FileChanged "did not fire for the Edit tool's own write" | It does, once the watcher is up. A's Edit ran ~1 s after launch. It still ignores subdirectory files, so the conclusion (don't build on it) stands | `extra/exp-v-filechanged.mjs`: `FileChanged:free.txt:change` after the Edit, `added.txt:add`, `ext.txt:change`, nothing for `sub/deep.txt` |
| "A newly created [project settings] file was not picked up within 3–6 s" | 2.1.220 only. 2.1.283 hot-loads a newly created `.claude/settings.json` | `v283` exp-plant `default-sources`: `plantedHookRan:"planted-hook-ran"` |
| "PermissionRequest did not fire for a `-p` auto-deny" | 2.1.220 only; it fires on 2.1.283, and interactively on both | `v283` L-lifecycle; `exp-v-lifecycle-tui.py` |
| "`New MCP server found` even with `--strict-mcp-config`" (needs `disabledMcpjsonServers`) | 2.1.220 only; gone on 2.1.283 | `v283` T3a/T3b: no MCP dialog, T3b processed the prompt |
| TUI status bar `Notloggedin·Run/login` as a detection pattern | Not shown at startup on 2.1.283 | `v283/run/notloggedin/tui.raw`: count 0; the prompt reply still says `Not logged in · Please run /login` |
| Host scrub list of parent-session variables | Incomplete; about 15 more names observed from the desktop app. Use a prefix rule (§1.5) | `env` names in the verifier's own session |
| Guest login "might not persist" (keychain timeout skips fallback) | Resolved for the sandboxed case: in the hardened profile the write fails fast (exit 152, ~30 ms), so the plaintext fallback is used. Still needs a real-account test | `extra/exp-v-srt-credstore.mjs` + code (`et=2000`, `Fs=36`) |
| "Pin ≥ 2.1.280 if Opus 5.5 is required" | Required (the team develops on Opus 5.5). Pin exactly **2.1.283**, the version now verified. npm `stable` = 2.1.274 is too old | `npm view @anthropic-ai/claude-code dist-tags`; real run |

### New findings (not in the original report)

* **Hook kill switches.** `CLAUDE_CODE_SAFE_MODE=1` or `CLAUDE_CODE_SIMPLE=1` in the launch env, in
  `$CLAUDE_CONFIG_DIR/settings.json` `env`, or `--safe-mode` disables all hooks including `--settings`
  ones (locked file overwritten, 0 hook events). On 2.1.220 a project `env.CLAUDE_CODE_SIMPLE` does
  too. Fix: `"env":{"CLAUDE_CODE_SAFE_MODE":"0","CLAUDE_CODE_SIMPLE":"0"}` in the smurg `--settings`
  restores the hooks in every one of those cases (verified), and the host env scrub drops both.
* **OAuth tokens follow `ANTHROPIC_BASE_URL`.** A (fake) claude.ai OAuth login sends
  `Authorization: Bearer` to a non-Anthropic base URL, from the launch env and from a planted project
  `env`. This makes §1.5's "host-only writable `.claude/**`" mandatory for subscription hosts, not
  just API-key hosts.
* **Trust seeding works for repo subdirectories and git worktrees (R9)** when keyed on the cwd
  realpath (Claude then also records the repo root). Without a seed the dialog appears and no hook
  runs (controls). On 2.1.283 the dialog preselects "No, exit".
* **`SMURG_SESSION_TOKEN` is visible to the agent's Bash** (both versions), so hook events are
  forgeable by the session itself; the daemon must bound them.
* 2.1.283 Console login adds "Sign in with your Console account (recommended)" (token sign-in) next
  to "(legacy) Create an API key" (still keychain-only). The API-key env dialog preselects
  "No (recommended)"; `customApiKeyResponses.approved` pre-seeding skips it.
* `claude auth logout` takes 3.3 s inside srt on 2.1.283 (1 s outside). It must not block the
  R4 "temp dir deleted within 5 s".
* Note for implementers: the original spike's reference generators (`session-settings.mjs`,
  `guest-env.mjs`, `smurg-hook.mjs`) do **not** contain these corrections (`defaultMode`, env
  neutralizers, PermissionRequest/PermissionDenied/UserPromptSubmit lock release, prefix rule for
  parent-session variables). The snippets in §1 and §3 of this report are the authoritative version.

### Still unverified

* A complete real-account OAuth login inside the hardened sandbox (paste of a valid code) and where
  the credential lands.
* The 2.1.283 "Sign in with your Console account" storage path; server-side revocation by
  `claude auth logout`.
* `PermissionDenied` (auto-mode classifier denial) and `disableAutoMode` (docs only).
* Auto mode as the start mode for Pro/Max/Team hosts on versions before 2.1.283 (docs only).
* Mid-session edits of the guest's `settings.json` (startup only was tested).
* Linux hosts.

### Side effects and cleanup

* No global installs. The npm install is local to `claude-hooks-verify/cc`.
* No URL-handler registrations: every TUI run passed `disableDeepLinkRegistration`, and
  `lsregister -dump | grep claude-hooks-verify` gives 0.
* The dummy keychain probe wrote nothing: `security find-generic-password -s smurg-verify-probe` →
  44.
* `~/.claude` and `~/.claude.json` were not touched by the spike runs; `~/.claude.json` changes on
  its own while the desktop sessions run (checked by watching its mtime with no spike running).
* No background processes left; no mock listeners on 18xxx.
