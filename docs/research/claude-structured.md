# Claude Code as a structured conversation (stream-json, the control protocol, permissions, hooks)

> **What this is.** The research record behind smurg 0.5.0's agent sessions (`docs/ARCHITECTURE.md` §7.6, §7.7,
> §11 D-16 to D-23). It collects the verified facts of four rounds of experiments made on 2026-10-05 and 2026-10-06:
> the runtime task (how to run Claude Code without a terminal), the design task, the three reviews of the design, and
> the checks the agent runtime's own work package added. Like the other reports in this folder it is the authority
> for *verified facts*; where it and `ARCHITECTURE.md` disagree about what smurg does, `ARCHITECTURE.md` wins. Two
> things below were verified and then NOT used, by the owner's decision: mirroring the host's own allow rules as
> ask rules (§5.3), and a terminal-style agent as a fallback (§10).

Target: **Claude Code 2.1.288** (macOS arm64). Most experiments were also run on 2.1.220, some on 2.1.201; where
versions differ the text says so. smurg's floor for agent sessions is 2.1.288 (§5.4 says why).

**Method, and what was never done.** Every claim below was checked by running the REAL `claude` binary against a
FAKE Anthropic Messages API on 127.0.0.1 (a small HTTP server whose answers are scripted: text, tool calls,
thinking, errors, rate-limit headers; it records every request the binary sends, so we see exactly what the model
would receive). The binary got a dummy API key and an environment built from nothing: a temporary `HOME`,
`CLAUDE_CONFIG_DIR` and `TMPDIR`, never the developer's or the owner's configuration, keychain or account. The runs
that needed a claude.ai-style login used a fake OAuth token and were wrapped in `sandbox-exec` with outbound network
limited to localhost. Only process groups the scripts spawned were signalled, and nothing was left running.

**No real Claude account was used at any point, by anyone, and no request left the machine.** So this report says
how the BINARY behaves: flags, pipes, the control protocol, permission rules, hooks. It says nothing about how a
real MODEL behaves (§11).

Where the evidence is. The experiment scripts and their recorded outputs (every line on the pipes with millisecond
offsets, and every request the binary sent to the fake API) were kept with the release's working notes and are not
part of the repository. What the repository keeps is their durable form:

- `packages/daemon/test/sessions/fixtures/claude-2.1.288.stdout.jsonl`: stdout lines recorded from 2.1.288 (paths
  scrubbed), replayed by `test/sessions/agent-replay.test.ts`;
- `packages/daemon/test/sessions/agent-claude-real.test.ts` and `test/hooks/claude-e2e.test.ts`,
  `claude-bash.test.ts`, `claude-failmodes.test.ts`: the decisive experiments as tests, run whenever a verified
  binary is on the machine, with the same isolation (`test/hooks/claude-harness.ts`, `mock-anthropic.ts`);
- `packages/daemon/src/testing/fake-claude.mjs`: a stand-in that speaks the protocol described here, for every test
  that needs no real binary.

The experiment names in brackets below (`exp1` … `exp16` the runtime task, `D1` … `D6` the design task, `f1` … `f11`
the feasibility review, `R1` … `R3` the revision, `P1` the runtime package) identify those runs.

---

## 1. Recommendation

Spawn the host's own `claude` in bidirectional stream-json mode and speak the control protocol on the pipes
directly. Do not bundle the Agent SDK.

- The SDK is a wrapper that spawns exactly this command line (its `sdk.mjs` passes `--output-format stream-json
  --verbose --input-format stream-json … --permission-prompt-tool stdio`). Bundling it would add 0.9–1.2 MB of code
  under Anthropic's own terms ("All rights reserved") to an MIT executable (measured: esbuild CJS bundles of
  `@anthropic-ai/claude-agent-sdk@0.3.289` without its platform binaries).
- It would not protect against drift: the SDK would be pinned at build time while the host's `claude` updates itself.
  The SDK's shipped type definitions (`sdk.d.ts`, `sdk-tools.d.ts`) were used as the reference for the protocol.
- A parity run through the SDK showed the same messages on the pipes as the direct spawn [exp11].

The launch line (every flag verified on 2.1.220 and 2.1.288):

```
claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages
       --replay-user-messages --permission-prompt-tool stdio --permission-mode <default|acceptEdits>
       ( --session-id <uuid smurg chose> | --resume <uuid> )
       --settings <file> --mcp-config <file> --append-system-prompt-file <file> --tools <list>
       [ --strict-mcp-config ] [ --setting-sources user ]
```

`cwd` is the session's root. Never set `CLAUDE_CODE_ENTRYPOINT` or anything else that changes how the CLI identifies
itself (§8).

## 2. The protocol on the pipes

One JSON object per line, in both directions [exp1, exp2; the same on 2.1.201, 2.1.220 and 2.1.288].

**stdin**

```
{type:'control_request', request_id, request:{subtype:'initialize' [, hooks, appendSystemPrompt, agents …]}}
{type:'user', message:{role:'user', content:[{type:'text',text} | {type:'image',source}]}, parent_tool_use_id:null, uuid [, priority:'now']}
{type:'control_response', response:{subtype:'success', request_id:<the CLI's>, response:
     {behavior:'allow', updatedInput [, updatedPermissions]} | {behavior:'deny', message [, interrupt:true]}}}
{type:'control_request', request_id, request:{subtype:'interrupt' | 'set_permission_mode',mode | 'set_model',model
     | 'get_settings' | 'list_permission_rules' | 'get_context_usage' …}}
```

**stdout** (types seen): `control_response`; `system/init` (at EVERY turn: session id, tools, MCP servers, model,
permission mode, `apiKeySource`, `claude_code_version`, capabilities); `system/status`; `stream_event`
(`message_start`, `content_block_start` / `_delta` with `text_delta`, `thinking_delta` or `input_json_delta`,
`_stop`, `message_delta`, `message_stop`); `assistant` (ONE finished content block per line, the same `message.id`;
`aborted: true` when a stop cut it); `user` (a `tool_result`, with `tool_use_result` = the tool's structured result:
an Edit's `structuredPatch`, a Bash's stdout and stderr, a Read's file; `isReplay: true` = the echo of our own
message); `control_request` with subtype `can_use_tool` (a permission request AND `AskUserQuestion`);
`control_cancel_request`; `command_lifecycle` (`queued` / `started` / `completed` / `cancelled` per message uuid,
with `--replay-user-messages`); `system/api_retry`, `task_started` / `task_notification`, `permission_denied`,
`informational`, `compact_boundary`; `rate_limit_event` (subscription logins); and `result`, one per turn (subtype
`success`, `error_during_execution`, `error_max_turns` or `error_max_budget_usd`; `is_error`; `terminal_reason`
`completed`, `aborted_streaming`, `aborted_tools`, `max_turns`, `budget_exhausted` or `api_error`; the result text,
turn count, duration, cost, usage, `permission_denials`, `user_message_uuids`).

New line types appear between versions: a reader must ignore what it does not know. A control request of a subtype
the reader does not handle must be answered with an error at once, or the CLI waits.

Facts smurg's runtime relies on, each as observed:

| Fact | Evidence |
|---|---|
| `initialize` is answered within 250–430 ms, also with six sessions starting at once; its answer carries `account` (`tokenSource`, `apiKeySource`, `apiProvider`, and for a claude.ai-style login `subscriptionType`) | exp8, exp9, P1 |
| `list_permission_rules` answers `{ state: { rules: [{ behavior, source, rule }] } }` with `source` one of `userSettings`, `projectSettings`, `localSettings`, `policySettings`, `flagSettings`, …; `get_settings` shows the effective settings and each source | exp15, P1 |
| `set_permission_mode` works in the middle of a session; `--model` and `set_model` too (smurg uses neither) | exp6, exp7 |
| Thinking arrives as `thinking_delta` stream events and a thinking block; images in user messages pass through | exp14, exp8 |
| `--max-turns` ends a turn with `error_max_turns` and the process stays; `--max-budget-usd` with `error_max_budget_usd` | exp7 |
| A subagent's messages carry `parent_tool_use_id` (seen for a subagent's Read and its text, with `--forward-subagent-text`) | exp14 |

## 3. Input, stop, and the life of a process

| Fact | Evidence |
|---|---|
| A message sent while a turn runs is queued and FOLDED INTO the running turn at the next tool boundary: one `result` lists both message uuids | exp4, exp4b |
| `priority: 'now'` ends the turn at the next tool boundary and runs the message as its own turn; it does not kill a running tool | exp4b |
| A real stop is the control request `interrupt`: a `result` within about 20 ms (`error_during_execution`, `aborted_streaming` or `aborted_tools`); the process stays and takes the next message; a pending permission request is withdrawn with `control_cancel_request` | exp4 |
| End of stdin: the CLI finishes the current turn, then exits 0 (a pending permission fails with "Tool permission stream closed" and the model gets one more request). `SIGINT`: the turn is aborted, exit 0. `SIGTERM`: exit 143, no `result` | exp4, exp5 |
| **A message that starts with `/` is run as a slash command locally**: `/context` alone made 0 API requests. ANY prefix stops that: a header line, a leading space, a leading newline each made 1 API request and the model saw the text | exp4, D2 |
| `--session-id <uuid>` works; Claude Code's own transcript is at `$CLAUDE_CONFIG_DIR/projects/<cwd with every non-alphanumeric character as ->/<id>.jsonl` (for a host: `~/.claude/projects/…`), flushed about 100 ms after each entry | exp5, exp5b |
| `--resume <uuid>` in a new process restores the conversation (an unfinished tool call gets a synthetic "interrupted" result on 2.1.288); nothing happens until a message is sent; resuming from another working directory works on 2.1.288 | exp5 |
| `--resume` of an id that never had a turn, or that Claude Code no longer keeps: exit 1, stderr "No conversation found with session ID: …". `--session-id` of an id that HAS a conversation: exit 1, "Session ID … is already in use". So the flag must follow what is known about the conversation, and both refusals must be handled | f2 (F2), P1 |
| A process killed during its FIRST turn has left a conversation behind although no `result` was seen: the next `--session-id` start is told "already in use", and `--resume` then works | P1 (`agent-claude-real.test.ts`) |
| The appended system prompt is SNAPSHOTTED at the first request on 2.1.288: a resume with a different text keeps the old one. On 2.1.220 a resume uses the new text. `initialize.appendSystemPrompt` replaces `--append-system-prompt` when both are given | exp8 |
| After a resume the request prefix (system blocks, tools, earlier messages) is identical to the last request before it, so the prompt cache is not lost; `initialize` takes about 190 ms and the first API request leaves 80 ms after the message | f8, f10 |
| A nearly full context window compacts INSIDE the next turn: `system/status` `compacting`, one extra model request, `compact_boundary`, then the answer | f8 (F9) |

## 4. Questions (`AskUserQuestion`)

| Fact | Evidence |
|---|---|
| The tool is offered only when a permission host exists (`--permission-prompt-tool stdio`). It arrives as `can_use_tool` with `tool_name: 'AskUserQuestion'` and `requires_user_interaction: true` | exp2 |
| Its input is `questions[1..4]` of `{ question, header (at most 12 characters), multiSelect, options[2..4] of { label, description, preview? } }`; the CLI itself rejects five questions or five options before asking | exp2, exp13 |
| The answer is `allow` with `updatedInput { questions, answers: { <question text>: <label> or "a, b" or free text }, annotations?: { <question text>: { notes } }, response? }`. The model then reads `Your questions have been answered: "Q"="A" …`; with notes `… notes: <text>`; with `response` `The user responded: …`. A `deny` with a message reaches the model as an error result. Answers are keyed by the question's TEXT, so two parts of one question may not have the same text | exp13 |
| There is no timeout: a question left open for 660 s and a Bash permission left open for 90 s were answered successfully, with nothing emitted meanwhile | exp10 |
| Under `bypassPermissions` the question still asks; `dontAsk` and `--permission-prompts none` deny it | exp6 |

## 5. Permissions, rules, and the order of hooks and the permission flow

### 5.1 Modes and requests

| Fact | Evidence |
|---|---|
| A `-p` session without `--permission-mode` starts in `auto` on 2.1.288: the mode must always be passed | exp6 |
| `default`: Edit / Write and commands that are not read-only ask; reads inside the working directory and read-only commands (`ls`, `cat`, `grep`, `git status`) do not | exp6 |
| `acceptEdits`: Edit / Write and `mkdir` / `touch` / `rm` / `mv` / `cp` / a redirect inside the working directory run; a write outside it asks (reason `workingDir`); other commands ask (`npm run lint`, `curl`); `printf one` and `echo hi > src/out.txt` do not | exp6, D4 |
| In `acceptEdits` the shell cannot write Claude Code's project configuration unasked: `mkdir -p .claude`, a redirect, `cp`, `mv`, `tee` into `.claude/**`, a redirect or `cp` onto `.mcp.json`, a write into `.git/hooks` and a write outside the worktree all raised a request (reason type `safetyCheck` or `subcommandResults`). **`echo x > CLAUDE.md` ran without one** | D5 |
| `bypassPermissions` is refused by `disableBypassPermissionsMode` (it falls back to `default`); `plan`: edits ask even with allow rules | exp6 |
| A request carries `permission_suggestions` (`addRules` `Bash(<prefix> *)` with destination `localSettings`, `addDirectories`, `setMode acceptEdits`), `blocked_path`, and `decision_reason` with its type | exp6 |
| "Always allow": answering with `updatedPermissions` at destination `session` makes the rule hold for the running process (`Bash(npm test *)` verified; after `Bash(npm run *)`, `npm run lint -- --fix` ran without a request). Destination `localSettings` WRITES `<project>/.claude/settings.local.json`: never echo Claude Code's own suggestion | exp6c, D4 |
| `--tools Read,Glob,Grep,Edit,Write,AskUserQuestion` gives exactly those tools (Bash: "No such tool available"); **the tools of the `--mcp-config` server are still offered** (`init.tools` lists `mcp__smurg__…`) and run without a request when `permissions.allow` holds `mcp__smurg` | exp6, D1 |
| Under `--tools` with the fifteen names of the design, `init.tools` of 2.1.288 is `Task, AskUserQuestion, Bash, Edit, Glob, Grep, NotebookEdit, Read, TaskStop, WebFetch, WebSearch, Write`: that version has no `MultiEdit`, `BashOutput`, `KillShell` or `TodoWrite`; `TaskStop` is its name for stopping a background command | P1 |
| Deny rules bind in every mode. An `Edit(…)` deny rule also refuses SHELL writes onto the named file (`echo >`, `cp`, `sed -i`, `rm`, `mv`); a refused edit says "File is in a directory that is denied by your permission settings." | D4, f2 (F3) |
| `Read` deny rules for `.git/**` leave an agent's own `git status`, `git diff` and `git log` alone (no request in `acceptEdits`), and refuse `cat .git/HEAD` and `cat .envrc` | P1 |

### 5.2 The host's own settings answer first; a hook answers before them

This is the finding the tool gate (`ARCHITECTURE.md` §7.7, §11 D-21) exists for.

| Fact | Evidence |
|---|---|
| **The host's OWN allow rules apply to a session smurg starts.** With `permissions.allow: ["Bash","Edit"]` in the host's `~/.claude/settings.json` the permission host was asked 0 times: an Edit of a file outside the topic's folder ran. With `["Read","Edit","Write"]` a discussion profile built from the tool list and rules alone wrote `src/cart.ts` and read a file in the host's home | exp14, f2 (F4), f11 |
| **Hooks run before the permission flow, and a hook's deny binds whatever the allow rules say.** A deny of smurg's `PreToolUse` hook reaches the model as `PreToolUse:<Tool> hook error: <reason>` WITHOUT a permission request, also under host settings that allow Read, Edit and Write | exp7, f11 |
| **ONE `PreToolUse` hook with the matcher `*` (and with no matcher) runs for EVERY tool**: Read, Grep, Glob, Write, Bash, `mcp__smurg__*`, AskUserQuestion. On a host whose own settings allow Read, Edit, Write, Bash, Grep, Glob, WebFetch and an MCP server, with a user-scope MCP server planted, a hook deciding by the kind of session held the discussion profile: refused, with nothing reaching the permission flow, were a Write to `src/`, a Write of `specs/<slug>/CLAUDE.md`, a Read and a Glob in the host's home and a Read of `.envrc`; allowed were a Write of `specs/<slug>/SPEC.md`, the smurg MCP tool and AskUserQuestion (which reached the permission host and was answered). Both versions | R1 |
| **With the hook answering as when the daemon is unreachable (a deny for everything), nothing ran in `acceptEdits`**: `echo x > f`, `ls` and Write were all refused. That is the liveness check: a remembered rule, a host rule or `acceptEdits` does not let an orphaned agent run a tool | R1 |
| Claude Code lets a tool run when a hook times out, crashes, exits 1 or is missing: a hook that must hold has to fail closed by itself (print a deny, exit 0) | `claude-hooks.md` §1.2; `claude-failmodes.test.ts` |
| The session settings smurg writes (`disableAllHooks: false`, the `env` neutralizers, `crossSessionInbound: "refuse"`, a deny for `ListAgents`, `disableBypassPermissionsMode`) start normally on both versions; SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop and SessionEnd all fire in structured mode as they did in the terminal UI | exp7, D6 |
| Hook CALLBACKS registered in `initialize` (`{ hooks: { PreToolUse: [{ matcher, hookCallbackIds }] } }`) arrive as `control_request` / `hook_callback` and are answered on the pipe, with no process per tool call. smurg does not use them: a callback dies with the daemon, and the gate must refuse when the daemon is gone | exp7, exp15 |

### 5.3 Rules in the session's own settings file

| Fact | Evidence |
|---|---|
| A rule in the `--settings` file's `permissions.allow` (`Bash(echo remembered *)`) runs without a request, like a flag rule: a remembered rule can be written there at the next start | R2 |
| The host allows `Bash(touch *)`; the SAME string in the session's `permissions.ask` makes it ask, while `ls` and `cat` still do not ask and `curl` asks. So "mirror the host's allow rules as ask rules" works. **Not used**: the owner decided that the host's own rules apply (`OWNER-DECISIONS.md` Q7) | R2, exp15 |
| Other ways to force a prompt that were verified and are not used: a `PreToolUse` hook answering `ask` (it also asks for `ls`); `--setting-sources project,local` (drops the host's user settings and the user `CLAUDE.md`) | exp15 |
| **How a file rule must be written in a settings file that is not in the project.** Written `/specs/x/SPEC.md` it matches NOTHING of the project: the allow did not approve (a request reached the permission host), the deny rules denied nothing, and Grep showed `.envrc`. Written relative to the working directory (`specs/x/SPEC.md`, `./…`) or absolute (`//<root>/…`) it works: the allow approved the write, the read rules refused Read, hid both `.envrc` files from Grep and refused `cat .envrc`, and the edit rule refused `echo x >> specs/x/PLAN.md` | R3 |
| As FLAGS, `--allowedTools "Edit(/specs/<slug>/**)"` is anchored at the working directory and approved writes there, and `--disallowedTools "Edit(/specs/<slug>/SPEC.md)"` refused them. smurg uses neither flag: every rule is one string in the settings file, in the absolute form | D3, D4 |

### 5.4 The version difference that makes 2.1.288 the floor

Grep reads hidden files: without deny rules it printed the line of `.envrc`. With read deny rules for `.envrc`,
2.1.288 hides the file from Grep ("No matches found"); **2.1.220 does not** (Grep still prints it) [R1]. Hiding the
host-private files from an agent's search is a property smurg promises (`ARCHITECTURE.md` §7.6 "Profiles"), so an
agent session is refused on a Claude Code older than 2.1.288 (§11 D-23). Two smaller differences: on 2.1.220 a Write
of an existing file needs a Read first ("File has not been read yet"); on 2.1.288 `ListAgents` is gone from the tool
list once it is denied (`SendMessage` stays, the messaging socket still exists) [R1, D6].

## 6. Summary of how smurg writes rules

From §5: the mode is always passed; the tool list is always passed and is explicit; every file rule has the form
`<Tool>(//<realpath of the session's root>/<pattern>)`; Claude Code's own `localSettings` suggestion is never
echoed; a hook, not a rule, carries whatever must hold on every host.

## 7. Project settings, trust, and the host's other things

| Fact | Evidence |
|---|---|
| **There is no workspace trust dialog in `-p` mode.** In a never-trusted folder a hook of the project's `.claude/settings.json` ran and a server of the project's `.mcp.json` connected as soon as the session started | exp16 |
| `--setting-sources user` stops both (and drops the project's `CLAUDE.md`). With that flag the hooks of the `--settings` file still fire and the `--mcp-config` server still connects | exp16, f2 (F5) |
| Claude Code loads a CHANGED project settings file into running sessions at once | `claude-hooks.md` finding 7 |
| The host's user-scope MCP servers are offered to a session and run; `--tools` does not remove MCP tools; `--strict-mcp-config` removes the host's servers and keeps the `--mcp-config` one | f2 (F4), R1 |
| From 2.1.224 every session binds `/tmp/cc-socks/<pid>.sock` and has `ListAgents` / `SendMessage`: it can list and message the host's OTHER Claude Code sessions on the machine. `crossSessionInbound: "refuse"` and a deny for `ListAgents` are the answer (denying `SendMessage` would also remove messaging between an agent and its subagents). A hard kill leaves the socket file | D6, Claude Code's documentation of cross-session messaging |

## 8. Login, the account, and how the API sees a session

| Fact | Evidence |
|---|---|
| A structured session uses whatever the host's Claude Code uses, with the same precedence: an API key goes out as `x-api-key`; a (fake) claude.ai login as `Authorization` with the OAuth beta header, `initialize.account.subscriptionType` and `rate_limit_event` lines. No extra setup | exp9 |
| Not logged in: `claude auth status --json` exits 1 with `{ loggedIn: false }`; in a session `init.apiKeySource` is `none`, a synthetic assistant message says "Not logged in · Please run /login", the `result` has `is_error` and `terminal_reason: api_error`, and no API request is made | exp9 |
| A rejected key: `system/api_retry` with `error_status: 401` and `error: 'authentication_failed'`, up to 10 retries with back-off | exp9 |
| **The API sees structured mode as `claude-cli/<version> (external, sdk-cli)` with `cc_entrypoint=sdk-cli`; the interactive terminal UI (0.4.0's agent sessions) as `(external, cli)` / `cc_entrypoint=cli`** | exp12 |

What the published terms said on 2026-10-05 (fetched pages; quoted here because they bear on whose account a group
session may use, which is the host's decision and not a technical finding):

- Agent SDK overview: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai
  login or rate limits for their products, including agents built on the Claude Agent SDK."
- Claude Code legal and compliance: "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro,
  Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other
  native Anthropic applications."; "Advertised usage limits for Pro and Max plans assume ordinary, individual usage
  of Claude Code and the Agent SDK."; for products that run Claude Code: "The Claude Code binary must not be
  modified." and "Each end user must authenticate with their own Anthropic API key, Claude subscription plan
  credentials, or 3P inference provider credential".
- Consumer terms: "You may not share your Account login information, Anthropic API key, or Account credentials with
  anyone else. You also may not make your Account available to anyone else."
- A support article of June 2026 announced, and on June 15 paused, a change under which `claude -p` and Agent SDK
  usage would leave the plan limits and draw from a separate monthly credit, with interactive Claude Code unaffected:
  "For now, nothing has changed: Claude Agent SDK, claude -p, and third-party app usage still draw from your
  subscription's usage limits."

smurg does not modify the binary, does not collect or pass on credentials (every session is the host's own Claude
Code with the host's own login), tells the host that a personal subscription is for the host's own use, and blocks
nothing (`ARCHITECTURE.md` §12).

## 9. What was measured

| Measurement (2.1.288 unless said) | Result | Evidence |
|---|---|---|
| A fresh idle agent process, resident memory | about 210 MB (323 MB on 2.1.220), plus 53 MB for its `smurg mcp` process | exp8, the feasibility review |
| After 300 turns | 420 MB with small tool results, 599 MB with 20 KB results (Claude Code's own transcript: 13.4 MiB) | f8 |
| After a park and `--resume` | 243–288 MB; `initialize` 190 ms; first API request 80 ms after the message | f8, f10 |
| `initialize`, six sessions at once | 250–430 ms each, independent | exp8 |
| `interrupt` to `result` | about 20 ms | exp4 |
| The packaged executable (an older build, 117 MB): `smurg hook bash-activity` | 20–30 ms, 56 MB; `--version` 50 ms; `mcp` idle 53 MB | the feasibility review |
| A pending question / permission | no timeout in 660 s / 90 s | exp10 |

## 10. When the parent dies, and merges inside a clone

| Fact | Evidence |
|---|---|
| **A child does not die with its parent.** After `SIGKILL` of the parent while a turn ran, the orphaned `claude` made 3 more API requests, ran a Write and a rule-allowed Bash command, then exited when its turn ended (4–7 s in the scripted run). An idle orphan exits in about 50 ms. A pending permission fails and the turn goes on. This is why the gate must fail closed for every tool (§5.2): with the gate, the orphan's tool calls are refused and only model text can still arrive | f1; `agent-claude-real.test.ts` (the orphan) |
| A hard kill within about 100 ms of a message can lose the newest entries of Claude Code's own transcript | exp5b |
| `git merge <main HEAD>` inside a `git clone --shared` clone is refused over uncommitted work it touches; a conflict that is resolved but not committed as a merge gives a one-parent snapshot, and the host's trial merge reports the same conflict again; only a commit with TWO parents clears it. Hence the daemon-side merge of `ARCHITECTURE.md` §7.8 "A conflict" | f7 |

A terminal-style agent session (the PTY of 0.4.0, which the API sees as `cli`) was considered as a fallback in case
`claude -p` usage is metered separately one day. Not built: the owner decided against it (`OWNER-DECISIONS.md` Q8).

## 11. What was NOT verified

- **Anything that needs a real model.** Whether a model asks its decisions through `AskUserQuestion` as its role
  prompt tells it, calls `check_plan`, `propose_split` and `check_report`, keeps item ids when it updates a plan,
  writes the report in the fixed format, stops after refused tools, and resolves conflict markers well. Every
  "model" in these experiments was a script.
- A permission request raised INSIDE a subagent (the SDK's types give `can_use_tool` an optional `agent_id` for it;
  `AskUserQuestion` is documented as unavailable in subagents).
- MCP elicitation.
- A real `claude` on Linux: every run was on macOS arm64.
- The packaged executable's hook under a real model's tool rate (the 20–30 ms were measured one call at a time, on
  an older build).
- Versions other than 2.1.201, 2.1.220 and 2.1.288; in particular nothing newer than 2.1.288. The protocol is
  defined by the SDK's shipped types and by what the binary does, and `--permission-prompt-tool stdio` is not a
  documented value.
- Cloudflare's accounting of the relay traffic a streaming conversation causes (an estimate only, `ARCHITECTURE.md`
  §12).
- Two runs of the runtime task on 2.1.220 (`exp5`, part A of `exp8`) ended in a stack trace of the harness; the
  facts they were for are covered by `exp5b` and by the feasibility review's runs.

## 12. How to repeat this

With a verified `claude` on PATH (or `SMURG_TEST_CLAUDE_BIN=/absolute/path/to/claude`):

```
cd <repo> && source scripts/env.sh
cd packages/daemon && pnpm exec vitest run test/sessions/agent-claude-real.test.ts test/hooks/claude-e2e.test.ts \
    test/hooks/claude-bash.test.ts test/hooks/claude-failmodes.test.ts
```

The suites start the real binary against `test/hooks/mock-anthropic.ts` with a dummy key and a temporary `HOME` /
`CLAUDE_CONFIG_DIR` / `TMPDIR`, print the version they run against, and say loudly when they were skipped. They
never use an account. Adding a Claude Code version to smurg's verified list means running them on it
(`ARCHITECTURE.md` §7.6 "Claude Code version").
