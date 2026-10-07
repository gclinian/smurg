# smurg Architecture (Prototype)

> Companion to `SPEC.md`. SPEC.md says **what**; this document says **how**, and is the contract that
> lets `protocol`, `daemon`, `relay`, `cli` and `web` be built in parallel.
> Verified technical findings live in `docs/research/*.md` — read the one for your area before coding.

**Precedence:** `SPEC.md` > this document > `docs/research/*.md`. The research reports were written before the
decisions below were taken; where a report disagrees with this document, this document wins. The reports remain the
authority for *verified facts*, exact API usage and gotchas. Deliberate departures from the wording of SPEC.md are
listed in §11 with their reason.

**0.5.0** (protocol 4) follows the owner's brief of 2026-10-05 (`docs/design/v0.5.0/OWNER-BRIEF.md` with
`OWNER-DECISIONS.md`): agent sessions are conversations, work is organised in topics, the main screen is the sessions
view. The brief supersedes SPEC.md's wording of R4 and R6; §11 D-16 to D-23 record how. The design as it was written
is kept beside the brief (`DESIGN.md`, `UX.md`, the mock); where it differs from this document (for example its
default for the host's own Claude Code rules, which the owner decided the other way), this document says what was
built.

---

## 0. Rules for everyone who writes or runs code in this repo

These exist because of real incidents during the research phase (two spikes killed unrelated processes by scanning
the process table).

1. **Process signals.** Only ever signal a pid or process group that *your own code spawned and recorded*.
   Never `pkill`, `killall`, `kill -1`, or "every process that matches predicate X". Before `process.kill(-pgid)`
   assert `Number.isInteger(pgid) && pgid > 1 && pgid !== process.pid && pgid !== <own pgid>`.
   Tests may only kill processes started by that test.
2. **No credentials.** Never read, print, copy or enter real credentials. Automated tests use the mock Anthropic API
   (`ANTHROPIC_BASE_URL` on 127.0.0.1, dummy key, isolated `HOME` / `CLAUDE_CONFIG_DIR`) and the relay's dev-only login.
   No automated test uses a real account. The tests that start the real `claude` binary run it against the mock API
   only, when a verified version is on the machine (`SMURG_TEST_CLAUDE_BIN` selects another binary), and say loudly
   that they were skipped otherwise (§10).
3. **No browser cookie import**, no use of logged-in browser sessions. Browsers are for localhost pages and public docs.
4. **Nothing global.** No global npm installs, no edits to `~/.claude`, `~/.ssh`, shell rc files, system settings.
   Tools that write global state get redirected (`XDG_CONFIG_HOME=<repo>/.xdg`, `WRANGLER_SEND_METRICS=false`,
   `npm_config_cache=<repo>/.tools/npm-cache`; all set by `scripts/env.sh`). Run tests through pnpm, never `npm exec` /
   `npx`. Run gstack browse from a scratch directory (it writes `.gstack/` into its cwd). Tests remove what they create:
   the relay and e2e vitest projects give their forks a private `TMPDIR` that the project's global teardown deletes
   (miniflare would otherwise leave its state behind). The daemon's socket directory is the one test directory that may
   not live below a long `TMPDIR` (Unix socket paths are limited, §7.1): tests use `createTempRunDir()` from
   `@smurg/daemon/testing` (the OS temp dir when short enough, else `/tmp`). A test worker can die hard (a native
   crash) before its cleanup: every temp dir the test helpers create and every long-lived process a test starts (a
   `nohup` job, a local relay's `workerd`, a daemon fixture) is registered with the run
   (`packages/daemon/src/testing/run-registry.ts`, a vitest globalSetup of the root and of every project), and after the
   run the registry removes what is still there AND still the same thing (directory dev/ino, a marker in the process's
   command line) — never anything selected by a name pattern — and says so on stderr. Test browsers are launched with
   `chromeLaunchOptions()` (`apps/web/e2e/chrome.ts`): no name resolves except loopback (Chrome otherwise downloads
   components from Google even with a fresh profile) and Chrome's temp files go to the test's `TMPDIR`
   (`MAC_CHROMIUM_TMPDIR`; on macOS Chrome ignores `TMPDIR`).
5. **Never block the daemon's event loop** (`spawnSync`, `execSync`, long synchronous diffs): the hook socket lives in
   it.
6. **Fail closed.** Hooks, path checks and permission checks deny when anything is uncertain.
7. **What smurg promises about an agent's limits, smurg's own code enforces.** Whatever this document says an agent
   session cannot do (a discussion agent writes only its topic's two files and runs no command; no agent writes
   Claude Code's configuration; no tool call runs while the daemon is gone) is decided by the tool gate (§7.7), a
   hook of smurg's own that runs before Claude Code's permission flow, and by the daemon's own checks. Claude Code's
   tool list, permission rules and permission requests are the second layer, never the only one: the host's own
   Claude Code settings can answer a permission request before smurg sees it (§7.6 "The host's own Claude Code").

---

## 1. Repository layout

```
smurg/
├── apps/
│   ├── web/            React + Vite SPA: the sessions view (inbox, topics, conversations in columns) and code mode
│   │                   (Monaco, Yjs, xterm.js). Since 0.5.0 `src/features/` also has columns/, sidebar/,
│   │                   conversation/, markdown/ and topics/ (§9)
│   ├── relay/          Cloudflare Worker + Durable Objects (WorkspaceDO, TransferDO, DeviceLoginDO); also serves the web SPA
│   └── site/           smurg.ai product page in both languages (static files + a Worker for a few redirects; www is a
│                       zone rule)
├── packages/
│   ├── protocol/       zod schemas, roles/capabilities, Noise channel, framing, invite links, client SDK,
│   │                   locale detection (`/locale`) and the wire message catalog (`/i18n`)
│   ├── daemon/         host-side daemon (library + hook/MCP entry points). Modules: §7.2; since 0.5.0 among them
│   │                   sessions/agent/ (the agent runtime), conversation/, topics/ and inbox/
│   └── cli/            `smurg` binary: host / attach / stop / status / login / logout / update / uninstall / licenses
│                       (+ internal: hook, mcp)
├── tests/
│   ├── e2e/            cross-package acceptance tests (relay + daemon + headless clients)
│   └── lint/           repository-wide checks of the language rules (§10)
├── docs/               ARCHITECTURE.md, GLOSSARY.md, HOSTING.md / JOINING.md (+ zh-TW/), RELEASING.md, research/, ACCEPTANCE.md,
│                       design/v0.5.0/ (the owner's brief and the design of 0.5.0 as written)
└── scripts/            dev + packaging scripts
```

Also at the root: `README.md` / `README.zh-TW.md`, `CHANGELOG.md`, `LICENSE` (MIT), `NOTICE`, `SECURITY.md`,
`CONTRIBUTING.md`; `packages/protocol/test-vectors/README.md` names the origin and licenses of the vendored Noise test
vectors (`cacophony.txt`: Unlicense; `snow.txt`: Apache-2.0 OR MIT).

- pnpm workspaces, TypeScript (strict, ESM, `"type": "module"`), vitest for all tests.
- **Node:** `engines.node ^22.18.0 || ^24.0.0`; develop and test on **Node 22 LTS** (`.nvmrc`). Node 23 and 25 are
  outside vitest 5's supported range. `source scripts/env.sh` puts the right Node and a repo-local pnpm on `PATH`.
- **Source-first packages:** workspace packages export their TypeScript sources; `erasableSyntaxOnly` +
  `allowImportingTsExtensions` so Node runs `.ts` directly. `tsc` is type-check only. Release bundles are made with
  esbuild (CLI/daemon → CJS for Node SEA), Vite (web) and wrangler (relay).
- Package names: `@smurg/protocol`, `@smurg/daemon`, `@smurg/cli`, `@smurg/web`, `@smurg/relay`, `@smurg/e2e`.

### Pinned dependencies (verified in research)

| Area | Packages |
|---|---|
| protocol | `zod@4.6.5`, `@msgpack/msgpack@3.1.3`, `@noble/curves@2.4.0`, `@noble/ciphers@2.4.0`, `@noble/hashes@2.4.0`, `yjs@13.6.33`, `y-protocols@1.0.7`, `lib0@0.2.118` |
| daemon | `node-pty@1.2.0-beta.15` (not 1.1.0), `@xterm/headless@6.0.0`, `@xterm/addon-serialize@0.14.0`, `@parcel/watcher@2.6.0`, `fast-diff@1.3.0`, `diff@9.0.0`, `yazl@3.3.1`, `jose@6.2.12`, `ws@8.22.0` |
| relay | `wrangler@4.142.0`, `jose@6.2.12` |
| web | `react@19.3.0`, `react-dom@19.3.0`, `vite@8.3.1`, `@vitejs/plugin-react@6.1.1`, `monaco-editor@0.57.0`, `y-monaco@0.1.6`, `@xterm/xterm@6.0.0`, `marked@14.0.0` (0.5.0: only its lexer; the tokens are rendered by smurg's own renderer, §9) |
| dev | `typescript@7.0.2`, `vitest@5.0.2`, `esbuild@0.28.2`, `playwright-core@1.63.0` (drives system Chrome, no browser download) |

Rejected with evidence (do not reintroduce): `noise-handshake`, `noise-protocol`, `noise-c.wasm`, `@libp2p/noise`,
`diff-match-patch`, `node-diff3`, `chokidar`, `archiver`, `zip-stream`, `fflate` (as zip writer),
`@monaco-editor/react`, `vite-plugin-monaco-editor`, `@cloudflare/vitest-pool-workers`, bun as daemon runtime.
- Identifiers, message types and file names are English. Languages: see "Languages" below.
- `tests/e2e` is an addition to the layout in SPEC §6: acceptance tests need a home that can depend on every package.

### Languages (English and Traditional Chinese)

Two locales, `en` (the default, and the source of truth for keys) and `zh-TW`. `docs/GLOSSARY.md` binds the terms.

1. **The language is the viewer's.** A process chooses a language only for text it shows to its own user: the browser
   for the web app, a CLI process for its own output, the relay Worker per request for its HTML pages, `sh` for the
   installer, the URL for smurg.ai. One detection rule, in `@smurg/protocol/locale` (`matchLanguageTag`,
   `localeFromLanguages`, `localeFromAcceptLanguage`, `localeFromEnv`; shared test table `/locale/test-table`); the
   installer's `pick_lang` is the same rule in POSIX sh. A choice a person made wins over detection: `SMURG_LANG`
   (`en` / `zh-TW`) for the CLI and the installer (§8), the web app's language menu (§9), the `?lang=` links of the
   relay's pages (§6); both of the latter write the cookie `smurg_lang`. smurg.ai never chooses: English pages at
   `/`, `/docs/…`, `/license/`, their Traditional Chinese counterparts under `/zh-TW/`, each page linking to its
   counterpart (a visible link and `<link rel="alternate" hreflang>`), and a generated `/sitemap.xml` that lists
   every page with its alternates (`apps/site/scripts/site.ts`). `/github` and `/source` there are 302s to the
   source repository, next to `/install.sh` (`apps/site/src/routes.ts`).
2. **The daemon and the relay's JSON API never choose a display language.** Everything they write for people travels
   as a `code` / `reason` + a message reference `{ id, params }` (`MessageRef`) + an English rendering as the
   fallback (§4.3, §5.4). There is no locale in `ClientHello`. A client renders
   `render(locale, ref) ?? <the English fallback>`.
3. **Text with one shared audience or a machine reader is fixed English**: PTY bytes, everything a model reads (the
   role prompts, the header line of a message, what smurg itself tells an agent, the tool gate's deny reasons, the
   daemon's own refusals of a request, MCP tool texts and answers: §7.7, §7.8), the marker lines and headings of
   `PLAN.md` and of a result report (§7.8; the web shows a report's sections under translated headings), git commit
   messages smurg writes (`smurg: worktree changes by {name}`, `smurg: spec and plan of {slug}`, `smurg: work item
   {n} ({id})`, `Merge {branch} ({name})`), logs, audit action and reason codes, maintainer and developer scripts.
4. **Text written by a person or an agent is never translated**: a message, a suggestion, a question with its options,
   a comment, the spec, the plan, a result report, a merge message, a reject reason, a session title or a topic name
   someone typed, `notify_member` text, display names, file names.
5. **Names that are stored and shown to everyone have one language-neutral spelling**: the agent of a session is
   `Claude (<label>)`, the label following the session (§11 D-20): the topic's name for a discussion (`Claude
   (Checkout)`), the item's title for a work item's session (`Claude (Cart API)`), the opener's name for a free
   session (`Claude (Ian)`); `agentDisplayName(label)` in `@smurg/protocol` is the only function that spells it.
   Device names are `Chrome (macOS)` / `smurg CLI (<hostname>)`; the relay's fallback user name is `Google user`.
6. **No source file outside a zh-TW catalog or a zh-TW document contains CJK** (`tests/lint/no-cjk.test.ts`).

Catalogs (who owns which text):

| Catalog | Where | Holds |
|---|---|---|
| Wire catalog | `packages/protocol/src/i18n/` (`@smurg/protocol/i18n`) | every text the daemon or the client SDK originates and a client shows: error sentences, activity sentences, daemon-written notifications, client-side request failures, the default text per error code, role labels, the default session titles (`sessionTitleRef`), and since 0.5.0 the lines and notices of a conversation, the refusals about cards, the findings about a plan or a report, the Start dialog's warnings (`messages/conversation.ts`, `topics.ts`, `inbox.ts`). Functions of typed parameters, both locales side by side; ids are `area.thing[.variant]` |
| Web catalog | `apps/web/src/strings/*.ts`, `apps/web/src/features/*/strings.ts` (+ `*.zh-TW.ts`) | everything the web app itself says |
| CLI catalog | `packages/cli/src/i18n/{en,zh-TW}.ts` | everything the CLI itself says |
| Relay pages | `apps/relay/src/lib/strings.ts` | the Worker's HTML pages |
| Installer | `scripts/install.sh` (`msg 'english' 'zh-TW'`) | the installer's messages |

Wire catalog API: `message(params, { en, 'zh-TW' })` defines a message; `msg(id, params)` makes a typed reference
(the daemon); `render(locale, ref)` returns the text or `undefined` (unknown id, a parameter of the wrong type: the
reference is untrusted wire input, so the caller shows the English fallback); `renderEnglish(ref)` is what the daemon
writes into `message` / `summary` / `fallback`. Parameters are strings, numbers, booleans and lists of at most 10
strings; the sender clips them (a path to 200 characters, at most 3 sample paths, at most 5 holder names). Byte
sizes are numbers (`formatBytes` formats them the same way in both locales). No sentence is built from fragments:
git steps are a `step` parameter with a table of names per locale inside the catalog (`GIT_STEPS`), file change
kinds a `change` parameter (`FILE_CHANGES`).

### Dependency rules

```
protocol  ← daemon ← cli
protocol  ← web
protocol  ← cli
relay     (no dependency on protocol's crypto; may import `@smurg/protocol/relay` and `@smurg/protocol/locale` only)
```

`protocol` must run unchanged in Node ≥ 22, browsers, and must not import Node built-ins from its
browser-reachable entry points (`@smurg/protocol`, `@smurg/protocol/client`, `/browser`, `/relay`, `/locale`,
`/i18n`). Node-only helpers go in `@smurg/protocol/node`. `/locale` imports nothing at all; `/i18n` imports only its
own files and `/locale` (no zod, no crypto); the barrel reaches `/i18n` because `SmurgError` renders its English
message from a reference. `packages/protocol/test/entry-boundaries.test.ts` checks all of this.

---

## 2. Trust model in one page

| Party | Trusted for | Not trusted for |
|---|---|---|
| Daemon (host machine) | everything; sole authority for permissions | — |
| Relay | availability, asserting *who logged in* (signed identity token) | confidentiality, integrity of content, the daemon's identity |
| Client (web/cli) | nothing | every request is validated + authorised by the daemon |
| Sessions (agent / terminal), whoever opened them | what the host's own OS account may do: they run as the host, unsandboxed (§11 D-15) | everything that arrives on the hook / MCP socket and on an agent's pipes is a claim, not a fact (§7.6, §7.7); a member who may open or drive sessions (`agent` role, "Agent access") is trusted by the host like the host's own account (§12) |
| The model in an agent session | nothing | it reads what several people wrote and whatever is in the files: every tool call passes smurg's tool gate, what it asks to run becomes a card a person answers, what it prints is masked and clipped before anyone sees it (§5.9, §7.7) |
| Editors and Viewers | what their capabilities give them through smurg (§3) | steering an agent: rule 6 |

Rules that follow (and that reviewers check):

1. **Every** inbound envelope goes through `Router`: zod-validate payload → capability check by role →
   handler-level resource checks (ownership, path guard). No handler is reachable without (1) and (2).
2. **Every** filesystem path from a client, a hook, or the MCP socket goes through `PathGuard` before any `fs` call.
3. Daemon secrets/state live in `~/.smurg/` (outside the shared folder). No client request reaches it (PathGuard);
   sessions run as the host and can (§12: the `agent` role is for people the host fully trusts).
4. Denied requests (authz or path) are written to the audit log.
5. **Who may do what to an agent session** (§3; the Router checks the capability, the handler the rest):
   - start one (a topic with its discussion, work items, a free session): `session.create` (Host, Agent access);
   - message an agent, stop its turn, allow or deny what it asks to run, accept or reject a suggestion, answer a
     question in one's own words or add a note for the agent: `session.drive` (Host, Agent access); a request that
     reaches beyond the project is host-only: the host;
   - vote, comment, be the responsible person, submit one of the agent's own options as the decider, review a result
     report: `discuss` (Host, Agent access, Editor);
   - an Editor's message is a suggestion; a Viewer watches.
6. **Nothing a person without agent access writes reaches an agent unseen.** An Editor's text reaches an agent only
   (a) as a suggestion a member with agent access accepted, in exactly the characters the card showed (§5.6);
   (b) inside `SPEC.md` / `PLAN.md`, in exactly the content a member with agent access confirmed in the Start dialog
   (the pin, §7.8); or (c) as words the decider, a member with agent access, put into the note of an answer on
   purpose. Vote comments and other people's "Other" answers are never sent by the daemon. One case is unavoidable
   and stated: the discussion agent reads its topic's files on every turn, whoever edited them; what it can do with
   that is bounded by the tool gate (rule 8, §12).
7. **Every text for an agent is framed and cleaned by the daemon** (§5.9 "Text for agents"): a person's message under
   a header line that names who wrote it, smurg's own messages under a tag drawn at random per session, invisible
   characters removed before a text is stored, shown and sent. Claude Code delivers a message as written: it expands
   no `@path` in it and runs none as a slash command (`client_composed`, §7.6 "Launch"). A role prompt and a message
   of smurg hold only fixed sentences and values the daemon checked by pattern (§7.8).
8. **The tool gate** (§0 rule 7, §7.7) decides every tool call of every agent session by the kind of session, before
   Claude Code's permission flow and whatever allow rules the host or the project have. When the daemon does not
   answer, it refuses every tool.
9. **The trust gate.** Structured mode never shows Claude Code's own trust dialog, so smurg has one: an agent session
   loads a folder's project-level Claude Code settings (`.claude/settings.json`, `.claude/settings.local.json`,
   `.mcp.json`, and everything else Claude Code loads from `.claude/`: agents, skills, commands, rules) only after
   the host confirmed exactly that content, having seen everything it runs, allows and sets (§7.6 "Trust gate", §11
   D-18). `CLAUDE.md` files are instructions for agents that run as the host: through smurg only the host writes
   them (§5.2).
10. **The host's own Claude Code rules apply.** Every agent session runs as the host with the host's `~/.claude`, so
    what the host's own allow rules already allow runs without a permission card; smurg does not ask again. The host
    is told about each of their rules that applies, once (information, no decision; §5.8). The tool gate binds
    regardless: its refusals hold, and a shell command that may change a script of project settings in use asks a
    person whatever rule would have let it run (§7.7 G10). The host's own MCP servers are not offered to agents
    unless the host switches that on (never to a discussion agent; §7.6 "The host's own Claude Code").

---

## 3. Identity, roles, capabilities

```ts
type Role = 'host' | 'agent' | 'editor' | 'viewer';
//            Host     Agent access  Editor      Viewer    (labels: `roleLabel(locale, role)` of @smurg/protocol/i18n)

type UserId = string;        // relay-issued: "github:<id>" | "google:<sub>" | "dev:<name>"

type Capability =
  | 'file.read'              // browse tree, open docs, view sessions
  | 'file.download'
  | 'file.write'             // edit, create, rename, delete, upload
  | 'session.view'
  | 'session.create'         // open agent / terminal sessions; they run AS THE HOST, unsandboxed (§11 D-15). Also:
                             // create a topic, restart its discussion, start work items, archive a topic
  | 'session.drive'          // type into ANY terminal; send a message to ANY agent, stop its turn, answer its
                             // permission requests, accept / reject suggestions, change who is responsible, the
                             // permission mode, the always-allowed kinds, ask for the plan
  | 'suggest.create'
  | 'discuss'                // vote, comment, mention, be responsible, review a result report
  | 'worktree.merge.request'
  | 'worktree.merge.decide'
  | 'lock.force-release'
  | 'admin';                 // invites, roles, kick, audit, terminate any session, settings, the trust gate, redaction
```

| Capability | host | agent | editor | viewer |
|---|:-:|:-:|:-:|:-:|
| file.read, file.download, session.view | ✅ | ✅ | ✅ | ✅ |
| file.write, suggest.create, discuss | ✅ | ✅ | ✅ | ❌ |
| session.create, session.drive | ✅ | ✅ | ❌ | ❌ |
| worktree.merge.request | ✅ | ✅ | ❌ | ❌ |
| worktree.merge.decide, lock.force-release, admin | ✅ | ❌ | ❌ | ❌ |

The role `agent` ("Agent access") replaced `runner` on 2026-10-01 (§11 D-15): there are no sandboxed guest sessions.
A session an `agent` member opens runs exactly like the host's own (the host's OS user, environment, HOME, `~/.claude`
and Claude Code login). `discuss` (protocol 4) is what an Editor has and a Viewer has not: taking part in what the
agents ask and produce, without being able to drive them.

This table is implemented once, in `@smurg/protocol` (`roles.ts`), and used by the daemon for enforcement and by the
web app only for hiding UI. A registry entry may also say `none` (every member), `owner-checked-in-handler` or
`host-only-in-handler`; then the handler decides.

Resource-level rules (daemon handlers):

- `exec.input`: `session.drive`, ANY terminal. `exec.resize` (and `session.attach`'s cols / rows): the member who
  opened the terminal.
- `session.end`: a terminal: the member who opened it. An agent session: the host, or a member with agent access who
  opened it or is responsible for it. A topic's discussion is never ended this way (archive the topic or restart the
  discussion). The host may `admin.session.terminate` any session. `keepWorktree: false` removes the worktree of a
  terminal or a free agent session with it; the worktree of a work item is never released by a session's end (§5.10).
- `suggest.create`: an agent session, the author's own included (what matters is who may drive, not whose session it
  is); never a terminal. `suggest.accept` / `suggest.reject`: `session.drive`, any agent session; the suggestion must
  be pending.
- `worktree.merge.request`: any member with the capability, for any worktree; a session in a kept worktree: its owner
  only; `worktree.remove`: the host, or the worktree's owner WHILE they hold `session.create` (an owner record alone
  gives nothing). The diffs of a request: `file.read` (host-private files withheld).
- `lock.release`: caller must be one of the human holders.

```ts
type Actor =
  | { kind: 'user'; userId: UserId; displayName: string }
  | { kind: 'agent'; sessionId: string; ownerUserId: UserId; displayName: string }  // "Claude (Ian)"
  | { kind: 'system' };
```

**An agent's rights on host-only paths are its session's, not its owner's.** Every agent session has `pathRights`,
`host` when the host opened it and `member` otherwise, fixed when it is created. The principal an agent acts as
(`MemberDirectory.agentPrincipal(sessionId, ownerUserId, { agentName?, pathRights })`) has the role `host` only with
`pathRights: 'host'`; with `'member'` it is never `host`, whoever owns the session. A session that passes to the host
when its opener goes (below) therefore gains nothing: PathGuard, the hook socket's lock path, the conversation
module's host-only check and the file and document attribution all read this one principal.

### Who decides

An agent session has a **responsible person** (`AgentSession.responsible`, any member holding `discuss`, or nobody)
and a stored **fallback decider** (the member who opened the session or pressed Start, until cleared for good). Being
responsible is routing: it adds no capability. The rules are pure functions of `@smurg/protocol` (`routing.ts`) over
those facts and the ACTIVE members with their current roles; the conversation, topics and inbox modules use these and
nothing else, so a card, a refusal and an inbox can never disagree.

| What | Who |
|---|---|
| The **decider** of a session's questions (`deciderOf`) | the responsible person, while still a member holding `discuss`; else the fallback decider, under the same condition; else the host |
| Submitting the answer (`maySubmit`) | the decider; the host at any time; once the question escalated, every member with `session.drive` (recorded as `onBehalfOf`) |
| Voting and commenting | every member holding `discuss`, for a vote on an option and for an "Other" vote in their own words alike (an Other vote is shown to people and never sent to the agent by the daemon). SUBMITTING `other` or `note` as the answer needs `session.drive` |
| Answering a permission request (`mayDecidePermission`) | members with `session.drive`; a host-only request: the host |
| Whose inbox holds a permission request or a suggestion (`permissionRecipients`) | host-only: the host. Else the responsible person, when they hold `session.drive` and it has not escalated; else the host and every member with agent access |
| Reviewing a result report (`reviewersOf`, `mayReview`) | the responsible person, while a member holding `discuss`; else every member holding `discuss` (one review counts for all); once escalated, also every member with `session.drive` |
| "Always allow this kind" | members with `session.drive`; only the two checked forms of `rules.ts`; never for a host-only request |

A question or a permission request **escalates** after the host setting `escalateAfterMs` (default 5 minutes; a
report after six times that), or at once when the person it waits for has been offline for a minute: it then also
reaches the others who may settle it. Clients read the results from the entities (`Question.decider`,
`ReportSummary.reviewers`, their inbox) and may call the `may*` functions to hide what a member cannot do.

### When a member goes

A kick, a leave, and a role change that took `session.create`, `session.drive` or `discuss` away end in the same
state from any path (the admin handlers, the control socket). The core does it in ONE place (`admin/teardown.ts`),
driven by `member.kicked`, `member.left` and `member.role-changed`, in this order, each step with a time budget so a
kick answers within R2's 3 s:

1. `ConversationService.memberRemoved`: their votes, the always-allowed kinds they added to sessions, a permission
   mode they loosened, their queued messages (a kicked member's undelivered message stops its turn).
2. `TopicService.memberRemoved`: the kinds they allowed for whole topics, items they armed that have not started.
3. `SessionManager.teardownUser`: per session, end it (terminals, free sessions) or hand it to the host (a topic's
   sessions, with a work item's worktree; stopped first after a kick; `pathRights` is never raised), and clear them
   as responsible person and as fallback decider (kicked, left, or now a Viewer). After a KICK and after a role
   change below "Agent access", every worktree the member still owns passes to the host as well: the ones their
   ended sessions kept just now and the ones they had kept before. Not after a leave: a member who leaves keeps
   their role and comes back to the worktrees they kept.
4. `UploadService.abortAllForUser` (not for a role change).

One `session.handover` audit entry per handed-over session says from whom, why, whether it was stopped, and what was
removed. Feature modules do not duplicate any of this.

---

## 4. Connection lifecycle

```
client                          relay (WorkspaceDO)                        daemon
  │  OAuth login ─────────────────►│                                         │
  │◄── session cookie / bearer ────│                                         │
  │  POST /api/identity-token ────►│  EdDSA JWT, 5 min, aud = smurg-daemon:<ws>, sub = userId, cnf = blinded commitment
  │  WS /ws/<ws>/client ──────────►│── text: peer.open{conn} ───────────────►│
  │◄── text: hello{conn, host} ────│                                         │
  │══ HELLO  [0x01][ver][mode][noise msg1] ═════════════════════════════════►│
  │◄═ REPLY  [0x02][noise msg2] ═════════════════════════════════════════════│  client verifies daemon key (k / pin)
  │══ FINISH [0x03][noise msg3 ⟨ClientHello⟩] ══════════════════════════════►│  daemon authenticates, then admit()
  │◄═ DATA   first record = verdict: [0x00]⟨Welcome⟩ | [0x01]⟨reason⟩ ═══════│
  │══ DATA   msgpack Envelopes … ═══════════════════════════════════════════►│
```

- **First contact** (`mode = invite`): `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s`. The client aborts at msg2 unless the
  daemon static key matches fragment `k`, and **persists that pin before sending msg3**. The daemon finds the invite by
  trial-verifying msg1 against the invites on file (the invite id is never sent; it is in the prologue).
- **Later** (`mode = device`): `Noise_XX_25519_ChaChaPoly_BLAKE2s` with mutual pinning.
- **`admit()`** runs once, synchronously, *after* msg3 authenticates: re-check invite expiry and remaining uses and
  consume one use atomically (invite mode), or check the device is registered and not revoked (device mode); verify the
  identity token (issuer, audience, age, `cnf` commitment against the authenticated static key); check the token's
  `sub` equals the user the device is bound to (or the user the invite is bound to, for the host invite).
  No decision is ever taken on the unauthenticated msg3 key.
  - Identity tokens are verified synchronously (admit() may not await, and jose's `jwtVerify` is async): jose only
    decodes; `node:crypto.verify` checks the Ed25519 signature against the relay's JWKS fetched beforehand; `typ`, `alg`,
    `iss`, `aud`, `exp`/`iat`/`nbf` (60 s skew), age ≤ 5 min and the `cnf` member are checked by hand. An unknown `kid`
    answers `busy` (the client retries) and triggers a rate-limited JWKS refresh.
  - The times are checked against the **relay's** clock, not the host's: the daemon estimates it from
    the `Date` header of each JWKS response (the relay sets it explicitly; local workerd adds none by itself), with the
    offset capped at ±24 h (fail closed beyond that). A host clock that differs from the relay's is logged as a warning;
    a time failure is logged with the token's offset and triggers a rate-limited key refresh.
  - **Invites never raise a role and never add a host device.** The host's user id is admitted in invite mode only
    through the host invite (role `host`, bound to the host); an ACTIVE member is refused (`invite-invalid`) through an
    invite of another role. So a relay that lies about who logged in (or a hijacked OAuth account of the host), plus any
    leaked guest link, gets at most that link's role for a new user and nothing for an existing one.
  - A kicked member comes back only through an invite created after the kick, with a new device key: an older multi-use
    link answers `kicked`; a revoked key answers `device-revoked`, even through a fresh invite. An unknown device key in
    device mode also answers `device-revoked` (there is no device-unknown reason on the wire).
- Every pre-authentication failure is answered with the same cleartext `ABORT [0x7f, 0x00]`. Reasons are only sent
  encrypted, in the verdict record. The ABORT is unauthenticated (the relay can forge it) and, for a device the daemon
  knows, only ever means "over budget": the client therefore retries it forever in device mode (capped backoff, state
  `connecting{cause: 'aborted'}`); in invite mode three in a row end in `rejected('aborted')` (an unknown invite).
- **Handshake budget** (daemon, before any crypto): per relay user (`peer.open.userId`, the relay's claim, good enough
  for fairness) a token bucket (`handshakesPerUserPerMinute`, 30) and at most 4 handshakes in flight; then the global
  bucket (`handshakesPerMinute`, 120), and for members with a registered, unrevoked device a separate reserve
  (`memberHandshakesPerMinute`, 120) once the global one is empty; at most 32 in flight per class (members / everyone
  else). One account flooding junk HELLOs cannot lock members out. After 5 failed handshakes on one connection id the
  relay is told `peer.kick`. A connection that is not admitted within `handshakeDeadlineMs + idleConnGraceMs` (10 + 5 s)
  after `peer.open` (or after its last failed handshake, or after its channel ended without a kick) is dropped with
  `peer.kick` (reason `idle`, `PEER_KICK_REASON_IDLE`), so sockets that never handshake cannot hold the relay's
  per-account / per-workspace socket slots. A client that gets `bye 4003 idle` without an authenticated
  `channel.closed` before it reconnects instead of treating it as a kick.
- **Resume**: `ClientHello.resume = { channelId, lastSeq }`. The daemon keeps a bounded outbox per logical channel
  and replays envelopes with `seq > lastSeq`; if the gap is no longer available it answers `Welcome.resumed = false`
  and the client performs a full resync (re-open docs, re-attach terminals, watch conversations again). The client
  likewise re-sends its unacknowledged requests; the daemon de-duplicates by `(channelId, seq)`. A conversation is
  watched again after a RESUMED Welcome too: the text of a streaming block is volatile (§4.3) and is never replayed.
  Precisely (executable reference:
  `packages/protocol/src/client/outbox.ts` and the client SDK's `testing/fake-daemon.ts`):
  1. every Envelope except `channel.ack` takes the next `seq` of its direction, starting at 1 per logical channel;
     seqs are strictly increasing but may have gaps (e.g. a request cancelled before it was sent);
  2. `channel.ack {upTo}` is unsequenced (`seq: 0`): never stored, replayed, acknowledged or de-duplicated;
  3. a receiver drops `seq ≤ last processed` and never treats a gap as an error;
  4. after `resumed: true` everything unacknowledged is re-sent in order with its original seq, before anything new;
  5. after `resumed: false`, requests that had reached the old channel fail with `connection-lost`, queued requests
     are renumbered from 1 and queued one-way messages are dropped (except before the very first channel);
  6. a persisted client position is `ResumeState { channelId, lastSeq, nextSeq }`; a restored client skips 1e6 seqs;
  7. a request that failed LOCALLY (timeout, cancelled) leaves the outbox even when it was already sent, so a resumed
     channel never replays it; `ClientRequestError.detail.sent` says whether it had been sent, and its
     message then says the outcome is unknown. There are no idempotency keys: a person who retries such a request may
     repeat an action the daemon did carry out.
  A logical channel continues only for the device (and user) it belongs to; a non-resumed admission of a device
  discards that device's other disconnected channels; fan-out keeps queueing to disconnected channels that can still
  resume (retention 15 min). A connection closed for too many refused requests loses its logical channel (§5.8).
- **Kick**: the daemon revokes every device key of the member, sends `channel.closed{kicked}` (authenticated) and then
  `peer.kick` on the same host socket, and the core runs the member teardown of §3 "When a member goes" (for
  `member.kicked`, whoever kicked): their terminals and free agent sessions end, the sessions of their topics pass to
  the host, stopped, what they had put in place (votes, always-allowed kinds, armed items, queued messages) goes, and
  their uploads are aborted. **Role change** (§11 D-8): the router reads the role per message, so it
  applies to the very next one; the member's channels get `channel.closed{role-changed}` + `peer.kick` (a client reads
  that pair as "reconnect", not as a kick) and come back with a fresh Welcome; device keys are NOT revoked; losing the
  right to open sessions (set to `editor` / `viewer`) ends their terminals and free agent sessions (`endReason:
  'role-changed'`) and hands the sessions of their topics to the host, which keep running (§3, §11 D-17). A relay
  `bye 4003` without an authenticated reason before it
  is a kick for the client (terminal).
- **Liveness** (all three are required):
  - host → relay text `"ping"` every 2 s, answered by the DO auto-response without waking it; a DO alarm declares the
    host offline 6 s after the last ping and broadcasts `host.offline`;
  - daemon, CLI and web each run a **pong watchdog**: 6 s without `"pong"` ⇒ terminate the socket and reconnect with jitter;
  - daemon sends encrypted `presence.heartbeat` every 3 s; the client shows "Host offline" after 8 s of silence from the
    daemon even if the relay says nothing. Relay unreachable ("Server unreachable" in the web app) is a *different* UI state from "Host offline".
- **Client states** (`ConnectionState` of `@smurg/protocol/client`): `idle`, `connecting{cause}`, `handshaking`,
  `online{resumed}`, `host-offline{reason: 'relay' | 'silence' | 'stopped'}` (relay said so / 8 s daemon silence, a
  fresh socket after 20 s / `channel.closed{stopped}`), `relay-unreachable`, and the terminal `key-mismatch{detail:
  'fingerprint' | 'unauthenticated'}`, `rejected(reason)`, `closed(reason)`. A stage-2 `handshake-failed` is a key
  mismatch (exactly what a relay without the invite secret produces: the SPEC R3 warning). The invite is used when
  nothing is pinned, with `preferInvite` (the person accepted a fresh link after a key-mismatch warning: it re-pins), and
  once as a fallback when device mode is refused before the device was ever admitted, only if the invite's
  fingerprint equals the pinned key's. A different daemon key is never pinned silently.
- **Local connections**: the host's own `smurg attach` goes through the control socket (§7.1, §8) instead of the
  relay: no Noise (the 0600 socket inside the 0700 run dir authenticates the host's OS account), otherwise the same hub,
  logical channel, resume, router and fan-out. Host only, and only for the attach: every session
  runs as the host's OS account (§11 D-15), so the router accepts on a local channel nothing but what `smurg attach`
  sends (§8 "Control socket"), and every audit entry a local channel causes (`auth.connect` / `auth.disconnect` with
  mode `local` included) carries `detail.via: 'control-socket'`.

### 4.1 Invite link

```
https://<web-origin>/join/<workspaceId>#k=<daemon key fingerprint>&s=<one-time secret>
```

In production `<web-origin>` is the relay's own origin (the relay Worker serves the web app, §6): for the shared relay
`https://app.smurg.ai/join/<workspaceId>#…`. SPEC's example origin `https://smurg.app` is only an example (the project
does not own that domain); the tests' fixtures use it as an arbitrary origin.

The web app copies the fragment into `sessionStorage` and immediately removes it from the address bar
(`history.replaceState`) before any navigation (including the OAuth redirect). That only rewrites the tab's own entry:
the full URL, secret included, is already in the browser's global (and synced) history before any script runs (a
residual risk; the console shows each link's uses live so a leaked link can be revoked).

`/join/<id>` never connects on page load: after the login it shows the workspace id and the identity
the person is logged in as, and connects only when they click "Join" ("Do not join" forgets the invite). A page that
sends a logged-in visitor to an invite link therefore cannot make them join, or tell the inviting daemon who they are.

The host gets their own single-use invite (role `host`, bound to the host's `userId`) printed by `smurg host`. It is
valid 7 days, and making a new one revokes the previous unused one. Guest invites without `expiresInSec` expire after
7 days (a never-expiring link would be a standing credential). `InviteInfo.id` is a random id (`inv_…`) unrelated to
the Noise invite id: whoever knows the Noise invite id can forge a msg1 that passes the daemon's pre-DH filter, so it
never reaches a UI, a log or the audit. Invite mode is refused on the transfer socket (two sockets must not race for
one single-use invite).

Fragment encoding (all base64url without padding):

| Value | Definition |
|---|---|
| `k` | `BLAKE2s-256("smurg/v1 daemon static key fingerprint" ‖ daemonStaticPublicKey)` — 43 chars |
| `s` | 32 random bytes — 43 chars |
| invite id | `BLAKE2s(key = s, "smurg/v1 invite id", 16 bytes)` |
| PSK | `BLAKE2s(key = s, "smurg/v1 invite psk", 32 bytes)` |

The daemon stores `{ inviteId, psk, role, boundUserId?, expiresAt?, usesLeft? }` — never `s` itself.

### 4.2 Encrypted channel (see `docs/research/noise.md`)

- **Engine:** our own Noise rev-34 *state machine* (CipherState / SymmetricState / HandshakeState) on audited
  primitives from `@noble/*`. We implement no primitive. It passes all 1352 cacophony + snow vectors; those vectors
  are part of the protocol package's test suite. No npm Noise library supports `XXpsk3` + BLAKE2s + an async DH hook
  without native addons (evidence in the report §1.7).
- **Drivers:** port `channel-v2.ts` from the report (§V-C), not the original `channel.ts`.
- **Prologue:** `"smurg-noise/1" ‖ 0x00 ‖ u8 len(workspaceId) ‖ workspaceId ‖ u8 mode ‖ inviteId(16, invite mode only)`.
- **AEAD suite:** noble in browsers; `node:crypto` ChaCha20-Poly1305 on the daemon and CLI through the `Suite`
  interface (byte-identical, ~6× faster).
- **Framing:** one application message = one WebSocket binary message = `DATA [0x10]{u16be len, noise record}+`.
  Record plaintext is `[flags][body ≤ 65518 bytes]`; the FIN bit is inside the ciphertext. An 8 MiB payload is 129
  records (+2452 bytes). The receiver caps reassembly at `MAX_APP_MESSAGE` and treats any AEAD failure as fatal for
  that connection. Decrypt into a **fresh buffer per message** (msgpack bin fields alias the input).
- **Every WebSocket gets its own handshake** — the interactive socket and the transfer socket are separate sessions.
- **Deadlines and limits:** handshake must complete within 10 s; at most 5 failed handshakes per connection id and a
  global budget per minute on the daemon.
- **Device keys**
  - Browser: `device-key-v2` from the report. A `structuredClone` probe picks `webcrypto` (non-extractable X25519
    `CryptoKeyPair` in IndexedDB; Chromium, Firefox), `wrapped` (WebKit cannot clone X25519 keys: AES-GCM-wrapped
    PKCS#8) or `raw`. Every record read back is re-validated. "Non-extractable" only blocks `exportKey`; it is **not**
    encryption at rest and must never be described as such.
  - CLI / daemon: raw 32-byte files under `~/.smurg`, created with `open(tmp, 'wx', 0o600)` + `rename`; loading
    refuses files with any group/other permission bit.
  - CLI pins of verified daemon keys: `~/.smurg/pins/<hex(utf8(workspaceId))>.pub`. Hex, because workspace ids are
    case-sensitive (anyone can claim `victim_…` next to `Victim_…`) and APFS is not: raw ids as file names would let
    one workspace's invite overwrite another's pin. A different pin is only replaced with `{ replace: true }` (after
    an invite verified the new key).
- **Identity binding:** `cnf = SHA-256("smurg-cnf" ‖ n ‖ deviceStaticPublicKey)`, n = 32 random bytes; the client sends
  `cnf` (43-character base64url, no padding: `identityCnf()`) to the relay when asking for the identity token and `n`
  inside the encrypted `ClientHello`. The relay never sees a stable device id. The token: header `typ:
  smurg-identity+jwt`, EdDSA, `kid`; claims `iss` (relay origin), `aud: smurg-daemon:<workspaceId>`, `sub`, `name`,
  `provider`, `picture?`, `iat`, `exp` (+300 s), `jti`, `cnf: { "smurg-noise-static": <cnf> }`. The strings are
  `IDENTITY_TOKEN_TYP`, `IDENTITY_TOKEN_AUDIENCE_PREFIX`, `IDENTITY_CNF_MEMBER` and `IDENTITY_TOKEN_TTL_SECONDS` in
  `@smurg/protocol/relay` (one definition for relay and daemon).

```ts
type ClientHello = {                     // msgpack, carried as the payload of noise msg3
  protocolVersion: number;
  purpose: 'interactive' | 'transfer';
  identityToken: string;                 // relay-signed JWT
  cnfNonce: Uint8Array;                  // n
  clientKind: 'web' | 'cli';
  deviceName: string;
  resume?: { channelId: string; lastSeq: number };   // interactive only
};
type Verdict =                            // first DATA message from the daemon
  | { ok: true; welcome: Welcome }
  | { ok: false; reason: 'invite-invalid' | 'device-revoked' | 'device-other-account' | 'identity-invalid' | 'kicked' | 'version' | 'busy' };
```

`channel.hello` / `channel.welcome` in §5.1 are these two structures; they are not Envelopes. The channel driver owns
the verdict's tag byte (`[0x00]` accept / `[0x01]` reject); the codec encodes only the body (`encodeVerdict()` returns
`{ accept, payload }`, which is exactly `admit()`'s return value).

### 4.3 Envelope

Codec: **MessagePack** (`@msgpack/msgpack`), one map per Envelope, `Encoder({ ignoreUndefined: true })`, `Decoder`
with `maxBinLength = 9 MiB`, `maxStrLength = 1 MiB`, `maxArrayLength = 1e6`, `maxMapLength = 1e4`.
Byte fields are msgpack `bin` ⇄ `Uint8Array` (`z.instanceof(Uint8Array)`); nothing is ever base64-in-JSON.

```ts
type Envelope = {
  type: string;       // e.g. "file.write"
  id: string;         // request id; responses echo it
  seq: number;        // per channel, per direction, strictly increasing; 0 = unsequenced (channel.ack, volatile messages)
  payload: unknown;   // validated by the zod schema registered for `type`
};
```

Conventions:

- Request `X` → response `X.ok` (same `id`) or `error` (same `id`, `payload: { code, message, detail?, text? }`).
  `message` is English (logs, the audit log, agents, a client that does not know the id). `text` is a message
  reference (`{ id, params? }`, `messageRefSchema`): the client shows `render(locale, text) ?? render(locale,
  defaultErrorRef(code)) ?? message`. Every error the daemon makes carries `text` (`error.default.<code>` when nothing
  more specific was said); the field is optional in the schema because an error made from a plain string has none.
  `new SmurgError(code, msg('worktree.inUse'), detail)`: `.text` is the reference, `.message` its English rendering.
- Unsolicited daemon → client events use a fresh `id`.
- `file.*` and `exec.*` never share message types or handlers (future two-way sync mode).
- Binary fields are real bytes (`Uint8Array`), never base64.

`PROTOCOL_VERSION` is 4 since 0.5.0 (`SessionInfo` is a terminal or an agent session; conversations as event logs;
questions, permission requests, topics, plans, reports and the inbox; the capability `discuss`). Nobody had installed
an earlier version: there is no compatibility code for protocol 3 anywhere.

Error codes: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `locked`, `path_denied`,
`insufficient_disk`, `too_large`, `host_only`, `rate_limited`, `internal`. Finer distinctions travel in
`detail.reason` and never become new codes (e.g. `bad_request` + `reason: 'not-an-agent'`, `conflict` + `reason:
'settled'`, `path_denied` + `reason: 'outside-root'`). Local client-side failures (timeout, connection lost) are
`ClientRequestError`, a `SmurgError` with code `internal`, `detail.reason` = the failure and `text` = its `client.*`
message.

A client reacts to a refusal by its `text.id` (one catalog id per sentence) or by one of the reasons protocol 4 fixes
(`ERROR_REASONS` in `schema/error-details.ts`: `not-a-terminal`, `not-an-agent`, `ended`, `archived`, `settled`,
`plan-changed`, `report-changed`, `unfinished`, `unmerged`, `not-failed`, `host-only`, `discussion`, `rate-limited`);
it never parses `message`. Details with a shape have a builder and a reader there: `lockedError` / `lockOfError`,
`insufficientDiskError` / `diskReportOfError`, `settledError` / `settledOfError` (a card that was answered, decided or
withdrawn first: `{ card: { kind, id }, sessionId, status, by? }`; the card itself is never in an error: a detail
holds no text people or agents wrote), `unmergedError` / `unmergedWorktreesOfError` (`topic.archive`).

Every Envelope is decoded with `decodeEnvelope(bytes, { from, channel })`, which refuses (as `bad_request`, with
`detail.reason`) a type that may not flow that way or on that socket, prototype keys at any depth, extension types and
nesting deeper than 32. The daemon audits the refusals that mean "not allowed" (§7.4): an invalid path is
`path.denied`, a forged direction / channel / unknown type is `authz.denied`.

**Volatile messages.** A registry entry may be `volatile` (only `session.delta`, the text of a block that is
streaming). The hub sends it unsequenced (`seq 0`) and only to a connected channel whose host socket has at most
`VOLATILE_SKIP_BUFFERED_BYTES` (1 MiB) buffered: it is never stored for a channel that is away, never replayed after a
resume, never acknowledged. That measure is the daemon's one link to the relay: it protects the host's link when the
relay is slow, and it skips a delta for every watcher at once. The runner therefore keeps a delta the hub sent to no
channel and sends its text again with the next one, from the same `offset`; a client that still sees a gap stops
appending to that block and waits for the block's `text` event in `session.events` (it may watch again, at most once
per session in `DELTA_REWATCH_MIN_MS`, so the recovery never adds load to the link it reacts to).

**Size rules.** An application message is at most `MAX_APP_MESSAGE` (8 MiB + 32 KiB). Every field has a bound
(`schema/limits.ts`), and a reply that carries a list of large things follows one of three rules, named in the
registry (`sizeRule`) and implemented with one measuring function and one taker (`encodedSize`, `takeWithinBytes`
in `codec.ts`):

| Rule | For | What it does |
|---|---|---|
| `page` | `session.watch`, `session.history`, `session.cards.get` | at most `EVENTS_PAGE_MAX` (500) events and `EVENTS_PAGE_MAX_BYTES` (2 MiB) of events, never fewer than one; the cards the events point to fill what is left, the rest is named in `moreCards` |
| `batch` | `session.events` | at most `EVENTS_BATCH_MAX` (64) events, `EVENTS_BATCH_MAX_BYTES` (512 KiB) and `EVENTS_BATCH_MS` (100 ms) per message |
| `list` | `session.list`, `suggest.list`, `topic.list`, `inbox.list`, `inbox.changed`, `admin.claudeConfig.get` | the reply is closed at `LIST_REPLY_MAX_BYTES` (4 MiB; at most `LIST_MAX_ITEMS` entries, at least one) with `hasMore: true`; the next request passes `after`, the last id it got (`takeListPage` on the daemon, `collectPages` on a client) |

`schema/worst-case.test.ts` builds the largest valid instance of every entity and reply and fails when one could
exceed an Envelope.

**Rates.** Counts cap what is stored; rates cap what one member can make everyone else's browser and the relay carry.
A registry entry may name a bucket (`rate`): the Router takes one token of the member's bucket before the handler
runs. Per minute: `vote` 30 (`question.vote`), `comment` 10 (`question.comment`), `suggestion` 10 (`suggest.create`,
`suggest.edit`, `topic.revise`, `report.followUp`, shared: an edit is sent whole to everyone a new suggestion is sent
to, and written whole to the audit text store); handlers take `mention` (20, one per kept mention) and the MCP answers
`agent-notify` (10 per session). A refusal is `rate_limited` (`detail: { reason: 'rate-limited', bucket }`), audited
as `authz.denied` and counted against the connection's refusal budget like every refusal (§5.8).

---

## 5. Message catalog

`c→d` request, `d→c` event. Rows marked **(addition)** were added after the first version of this catalog, each for
the reason given; the registry (`packages/protocol/src/schema/registry.ts`, `MESSAGE_REGISTRY`) is the executable form
of this section and `registry.test.ts` transcribes these tables to keep both in step. Every object is strict (an
unknown key is a protocol error); byte fields are `Uint8Array`; times are epoch-ms integers. Besides the capability,
a registry entry names the checks its handler owes (`checks`), what never reaches a log (`sensitive`, `redact`), and,
since protocol 4, `volatile`, `rate` and `sizeRule` (§4.3). §5.1 to §5.8 are the areas of protocol 3 as protocol 4
has them; §5.9 to §5.11 are new. All file references use:

```ts
type RootRef = { kind: 'main' } | { kind: 'worktree'; worktreeId: string };
type FileRef = { root: RootRef; path: string };   // POSIX, relative, normalised, no leading "/", "" = root
```

### 5.1 `channel.*`

| Type | Dir | Payload | Notes |
|---|---|---|---|
| `channel.hello` | c→d | `ClientHello` (§4.2) | payload of noise msg3, not an Envelope |
| `channel.welcome` | d→c | `Welcome = { channelId, resumed, member: Member, workspace: WorkspaceInfo, settings: PublicSettings, serverTime }` | inside the verdict record, not an Envelope |
| `channel.memberUpdated` | d→c | `{ member: Member }` | own record changed without a channel close (e.g. a new display name) |
| `channel.settingsUpdated` (addition) | d→c | `{ settings: PublicSettings }` | to everyone after each `admin.settings.set`: the settings otherwise reach clients only in the Welcome |
| `channel.closed` | d→c | `{ reason: 'kicked'\|'revoked'\|'stopped'\|'role-changed'\|'protocol-error' }` (only the reason: each client words it) | then the socket is dropped; also on the transfer socket |
| `channel.ack` | both | `{ upTo: seq }` | lets the peer trim its outbox; always `seq: 0` (unsequenced, §4 Resume) |
| `channel.leave` (addition) [none] | c→d | `{}` → `{}` | SPEC R4 (a guest leaves): ends the sessions the caller opened within 5 s (`endReason: 'left'`, each audited `session.terminate` by the system), audits `member.leave`; membership and device key stay. A mere disconnect does none of this (§11 D-9). The host's own leave is a no-op. |
| `error` | d→c | `{ code, message, detail?, text? }` (§4.3) | on both sockets; answers a request (same id) or a refused one-way message |

```ts
type Member = { userId; displayName; avatarUrl?; role: Role; color: string; online: boolean; joinedAt: number };
type WorkspaceInfo = { id; name; hostUserId; hostName; platform: 'darwin'|'linux'; isGitRepo: boolean };
type PublicSettings = { humanLockIdleMs; agentLockTimeoutMs; uploadChunkSize; sharedDirs: string[] };
// (Protocol 1's guestSubscriptionLogin / guestMainWorkspace are gone with the guest sandbox, §11 D-15.)
```

### 5.2 `file.*` (capability in brackets)

| Type | Dir | Payload → result |
|---|---|---|
| `file.tree` [file.read] | c→d | `{ root, path, depth? (1–32) }` → `{ entries: FileEntry[] /* ≤ 10,000 */, truncated: boolean }` |
| `file.stat` [file.read] | c→d | `FileRef` → `{ entry: FileEntry }` — a place the reader may not look at answers `not_found` (below) |
| `file.create` [file.write] | c→d | `{ file: FileRef, kind: 'file'\|'dir' }` → `{ entry }` |
| `file.rename` [file.write] | c→d | `{ root, from, to }` → `{ entry }` |
| `file.delete` [file.write] | c→d | `{ file: FileRef }` → `{}` |
| `file.read` [file.read] | c→d | `{ file: FileRef, maxBytes? /* ≤ 5 MiB */ }` → `{ content: bytes, hash /* SHA-256 hex of content */, truncated }` |
| `file.write` [file.write] | c→d | `{ file: FileRef, content: bytes, ifMatchHash?: string }` → `{ entry, hash }` |
| `file.changed` | d→c | `{ root, changes: { path, change: 'add'\|'change'\|'unlink'\|'addDir'\|'unlinkDir', by?: Actor }[] /* ≤ 10,000 */ }` |

`file.tree.ok.truncated` (addition): a directory with more than 10,000 entries is listed partially (encoding 10,000
entries already costs ~13 ms); the client asks for subdirectories one by one. `file.read.ok.hash` covers the returned
bytes; it is the whole file's hash (usable as `file.write.ifMatchHash`) only when `truncated` is false.

`file.write` is **not** how text is edited (that is `doc.*`); it exists for small non-collaborative writes and is
what the R2 forged-request test sends as a viewer. It is refused with `locked` while the file has any lock.

`file.stat` is a lookup, asked many at a time for the names a text happens to hold (§9 "Markdown"). A lookup of a
place the reader may not look at (a host-private file, the daemon's own folder, a file with a second hard link, a
path that leads through a file) answers `not_found`, like a name that is not there: it tells the reader nothing a
refusal would not, so it writes no `path.denied` audit entry and does not count towards the 60 refusals a minute
that close a connection (§5.8). A lookup that tries to leave the folder (a path or a link that points out), and
every refused read and write, is refused, recorded and counted as before.

`file.rename` and `file.delete` of a FOLDER are a write of everything below it: both ends of a rename and a delete
are refused when the folder holds a path the caller may not write (an item worktree's `specs/<slug>`; a path the
trust gate records; a host-only name at any depth), with the refusals of a write of that path (§7.4 "A folder is
everything below it").

Host-only paths: `<share>/.claude/**`, `<share>/.mcp.json`, `<share>/.git/**`, `<share>/.smurg/**`, `.envrc`,
`.vscode/**`, `.idea/**` are writable through `file.*` / `doc.*` / upload **by the host only**. Project-level Claude
settings are hot-loaded by the host's unsandboxed agent: a collaborator who can write them can run code on the host
and redirect the host's API credentials (§11 D-15: a "Agent access" member's own sessions run as the host and are not
held to this; the rule protects the host from editors and from what any member writes through `file.*`). `isHostOnlyPath()`
matches these names at ANY depth (nested `.claude/` directories are loaded too) and after `foldPathName()`: NFKC plus
a full case fold and HFS+ ignorable code points removed, because a case-insensitive file system treats more spellings
as the same entry than `toLowerCase()` does (on APFS `.vſcode`, with U+017F, IS `.vscode`). A false "host-only" costs
a guest one refused write; a false "not host-only" can run code on the host. PathGuard also decides on the on-disk
spelling of existing entries (§7.4). `<share>/.smurg` is not even readable for non-hosts (it holds other guests'
partial uploads and the worktrees, which are reachable as their own roots).

Host-private paths (`isHostPrivatePath()` in `@smurg/protocol`): any `.git` directory, any `.envrc`,
and the host's personal Claude Code files `.claude/settings.local.json` and `CLAUDE.local.md`, at any depth and under
every folded spelling. PathGuard refuses them to every non-host for **reads as well** (`path_denied`, reason
`host-private`, audited), so guests (viewers included) cannot read `.git/config`, a deploy key in `.envrc` or the
host's personal settings through `file.read`, `doc.open` or a download. `file.tree` does not list them for non-hosts
(like `.smurg`), a guest's zip leaves them out (skipped as `host-private`), and conflict records about them are shown
to the host only (one definition in `@smurg/protocol`). This binds what members read through smurg; a session a "Agent access"
 member opens runs as the host and can read them like the host's own (§11 D-15).

The daemon's own directories are refused for mutation through `file.*` even for the host (`forbidden`,
`detail.reason: 'daemon-owned'`): `.smurg`, `.smurg/worktrees`, `.smurg/worktrees/<id>`, `.smurg/uploads/**` and
`.smurg/trash/**` (moving them away under the daemon would break resume, worktrees and the delete safety). Members
other than the host meet PathGuard's audited `hidden` denial first. A write is refused with `locked` when a lock holds the file under ANY
spelling that reaches it: the request's, the shared-link `mainRef`, and the canonical FileRef of the resolved object
(`toFileRef(realPath)`), so a link inside the share (`alias/app.ts` → `src/app.ts`) cannot write around a lock.

The file tree and activity feed hide editor/agent temp files (`NAME.tmp.<pid>.<hex>`, `.<name>.smurg-<hex>.tmp`).

#### Transfer channel (`purpose: 'transfer'`, separate socket through `TransferDO`, own Noise session)

No `seq` outbox/replay on this channel: uploads resume from the daemon's bitmap, file downloads by offset, zip
downloads restart. `begin`, `chunk`, `commit` and acks all travel on this socket (there is no ordering across sockets).
Chunks are 4 MiB by default (1–8 MiB accepted). Flow control: end-to-end ack window of 4 chunks **and**
`ws.bufferedAmount ≤ 8 MiB` polled every 5 ms in the browser. The browser side runs in a Web Worker.

| Type | Dir | Payload → result |
|---|---|---|
| `file.upload.plan` [file.write] | c→d | `{ root, entries: { path, kind: 'file'\|'dir', size? }[] /* ≤ 10,000; files have size, dirs not */, onConflict: 'fail'\|'overwrite'\|'rename' }` → `{ disk: DiskReport, renamed: { from, to }[] }` — folder drops; one disk check for the whole batch; creates directories (also empty ones), at most 10,000 of them, the ones its files lie in included (`too_large`, reason `too-many-folders`); clients split bigger drops, and the daemon reserves planned bytes until their uploads begin or abort |
| `file.upload.begin` [file.write] | c→d | `{ root, path, size, chunkSize, lastModified, uploadId?, onConflict? }` → `{ uploadId, chunkCount, have: bytes /*bitmap*/, received, resumed, disk: DiskReport }` |
| `file.upload.hashes` [file.write] | c→d | `{ uploadId, from, count }` → `{ hashes: bytes }` — paged, 32 bytes per chunk |
| `file.upload.chunk` [file.write] | c→d | `{ uploadId, index, hash: bytes /*SHA-256*/, data: bytes }` → `{ index }` — rejected unless this connection began/resumed the upload |
| `file.upload.commit` [file.write] | c→d | `{ uploadId, rootHash: bytes }` → `{ entry: FileEntry }` — `rootHash = SHA-256(u64be size ‖ u32be chunkSize ‖ h0 … hn-1)` |
| `file.upload.abort` [file.write] | c→d | `{ uploadId }` → `{}` |
| `file.download.begin` [file.download] | c→d | `{ file: FileRef, zip?: boolean, offset?: number, ifMatch?: string }` → `{ downloadId, name, size?: number, etag?: string, zip: boolean }` |
| `file.download.chunk` | d→c | `{ downloadId, index, offset, data: bytes }` |
| `file.download.ack` [file.download] | c→d | `{ downloadId, index }` — grants credit |
| `file.download.end` | d→c | `{ downloadId, totalBytes, skipped: { path, reason }[], zip64: boolean, error?: { code, message, detail?, text? } }` — `error` (addition): a download that failed after `begin.ok` (disk error, file gone) ends typed |
| `file.download.cancel` [file.download] | c→d | `{ downloadId }` |

The capabilities of the upload follow-ups (`file.write`) and of ack / cancel (`file.download`) are those of the
request they belong to: a member demoted to viewer mid-upload is refused (fail closed). Upload / transfer sub-errors are
ARCH codes with `detail.reason` (`hash-mismatch`, `incomplete`, `bad-path`, …).

Upload rules the clients rely on (files module): after a new transfer socket or a daemon restart a client sends
`file.upload.begin` with the `uploadId` before any chunk (a chunk on a socket the upload is not bound to answers
`conflict` / `not-bound`); a resume may carry a new `onConflict`. The daemon remembers the ids of uploads a member
committed for 10 minutes: a `begin` with such an id from the same member (its commit answer was lost to a disconnect)
answers `conflict` / reason `committed` with `detail.entry` (the placed file), which the client treats as done. At most
1,000 unfinished uploads per member (`conflict` / `too-many-uploads`). `file.write` / `file.create` need an existing
parent (`not_found` / `parent-missing`); `plan` and commit create missing parents, each level resolved through
PathGuard. One plan may have at most 10,000 FOLDERS (`UPLOAD_PLAN_MAX_ENTRIES`), counting the folders its entries
lie in even when the plan does not list them: an entry can lie two thousand folders deep, so 10,000 entries could
ask for millions of folders. A larger plan is refused before anything is created (`too_large`, reason
`too-many-folders`; the text `upload.tooManyFolders` says to upload it in parts). Deletes are renamed into
`<share>/.smurg/trash/<id>` (same volume, checked before and after) and removed there, so a directory swapped for
a symlink mid-delete can never take files outside the share with it.

```ts
type DiskReport = { totalBytes; availableBytes; reserveBytes; pendingBytes; requestedBytes; freeAfterBytes; ok: boolean };
```

Disk rule (R7): `reserve = max(diskReserveBytes /*5 GiB*/, diskReservePercent /*5%*/ × total)`;
accept iff `available − pendingOther − remaining ≥ reserve`, where `pendingOther` excludes the upload being checked.
Refusals return `insufficient_disk` with the `DiskReport` so the UI can show the numbers.

```ts
type FileEntry = {
  name; path; kind: 'file'|'dir'|'symlink'; size; mtime;
  readOnly?: boolean;            // e.g. inside a shared read-only dir of a worktree
  lock?: LockInfo;
  lastModifiedBy?: Actor;        // drives the tree badge ("recently changed by Claude (Ian)")
};
```

### 5.3 `doc.*` (Yjs)

| Type | Dir | Payload |
|---|---|---|
| `doc.open` [file.read] | c→d | `{ file: FileRef }` → `{ docId, epoch: string, canEdit: boolean, lock?: LockInfo, meta: { eol: 'LF'\|'CRLF'\|'CR', bom: boolean, mixedEol: boolean } }`; the daemon then sends sync step 1 + an awareness snapshot as `doc.sync` / `doc.awareness`. Refused with `too_large` (> 5 MiB) or `bad_request` (binary / not UTF-8). |
| `doc.reset` | d→c | `{ docId, epoch }` — the daemon re-created the Y.Doc; the client must drop its replica and re-sync |
| `doc.sync` | both | `{ docId, data: bytes }` — y-protocols sync messages. Updates from clients without `file.write` are dropped + audited. |
| `doc.awareness` | both | `{ docId, data: bytes }` — y-protocols awareness update |
| `doc.close` | c→d | `{ docId }` |
| `doc.saved` | d→c | `{ docId, file, hash, at }` |
| `doc.rejected` | d→c | `{ docId, reason: 'agent-locked'\|'read-only'\|'forbidden'\|'file-unavailable', lock? }` — client must resync and drop local change. `file-unavailable` (addition): the file was moved, deleted or became unusable (binary, too large, a link out of the share) on disk; the text not yet saved is NOT lost (see below), so clients must not say it was discarded |
| `doc.conflict` | d→c | `{ conflict: ConflictRecord }` |
| `doc.conflict.list` [file.read] | c→d | `{}` → `{ conflicts: ConflictRecord[] }` |
| `doc.conflict.resolve` [file.write] | c→d | `{ conflictId, action: 'dismiss'\|'apply-agent-version' }` → `{ conflict }` — `apply-agent-version` writes the file: audited `doc.conflict-resolve` |
| `doc.conflict.get` (addition) [file.read] | c→d | `{ conflictId }` → `{ conflict, agentVersion: bytes /* ≤ 5 MiB */ }` — the agent's full version as bytes: a whole document exceeds msgpack's 1 MiB string limit, so it is not inline in ConflictRecord |

```ts
type ConflictRecord = {
  id; file: FileRef; createdAt; source: Actor;            // the agent (or 'system' if unknown process)
  humans: { userId; displayName }[];
  hunks: { humanText: string; agentText: string; baseText: string; startLine: number /* 1-based */; truncated?: boolean }[];
                                                          // ≤ 64 hunks; each text ≤ 64 KiB UTF-8 (truncated: cut)
  hunksOmitted?: number;                                  // hunks beyond the 64 listed
  agentVersionBytes: number;                              // UTF-8 size of the full agent version (doc.conflict.get)
  status: 'open'|'dismissed'|'applied';
};
```

An open document whose file stays missing, binary or huge, or leads out of the share for more than 1.5 s (a pause
that does not clear by itself, unlike a `git checkout`) is settled: every subscriber gets
`doc.rejected{file-unavailable}`, later human updates are reverted and refused the same way, and the text that was not
on disk yet becomes a ConflictRecord (one hunk `{ humanText: <the unsaved text>, agentText: '', baseText: '' }`, its
stored version is that text), announced with `doc.conflict` and audited `doc.conflict` (detail.kind `unsaved-text`):
`apply-agent-version` writes it back at the old path. A room that is dropped (grace expiry, stop) is settled first.
The document does not follow a rename; the web client moves its tab from the `file.rename` activity event.

### 5.4 `lock.*`, `presence.*`, `activity.*`

```ts
type LockInfo =
  | { kind: 'human'; file: FileRef; holders: { userId; displayName; lastActivityAt }[]; acquiredAt }
  | { kind: 'agent'; file: FileRef; sessionId; ownerUserId; agentName; acquiredAt; expiresAt };
```

| Type | Dir | Payload |
|---|---|---|
| `lock.state` | d→c | `{ file: FileRef, lock: LockInfo \| null }` — broadcast on every change |
| `lock.list` [file.read] | c→d | `{}` → `{ locks: LockInfo[] }` |
| `lock.release` [file.write] | c→d | `{ file }` → `{}` — "Let the agent go first": caller leaves the human lock |
| `lock.forceRelease` [lock.force-release] | c→d | `{ file }` → `{}` |
| `presence.heartbeat` | d→c | `{ at }` every 3 s |
| `presence.state` | d→c | `{ members: PresenceMember[], agents: PresenceAgent[] }` |
| `presence.update` | c→d | `{ activeFile?: FileRef \| null }` |
| `activity.event` | d→c | `{ event: ActivityEvent }` |
| `activity.list` [file.read] | c→d | `{ limit? /* ≤ 500 */, before? /* epoch ms, exclusive */ }` → `{ events: ActivityEvent[] }` — `at` is strictly increasing per log, so `before` is an exact cursor |
| `activity.notify` (addition) | d→c | `{ notification: { id, at, from: Actor, text? /* ≤ 2,000 */, msg?: MessageRef, fallback?: string, file?: FileRef } }` — only to the notified member's channels. Exactly one of `text` (an agent's own words through the coordination MCP tool `notify_member`, SPEC R8; never translated) or `msg` + `fallback` (a notification the daemon wrote, `notify.*`: the two Claude Code version warnings, `from: { kind: 'system' }`; the client shows `render(locale, msg) ?? fallback`) |

```ts
type PresenceMember = Member & { connections: number; activeFile?: FileRef };
type PresenceAgent  = { sessionId; ownerUserId; displayName; color; activeFile?: FileRef; status: AgentSession['status'] };
type ActivityEvent  = { id; at; actor: Actor; kind: 'agent.edit'|'human.edit'|'file.create'|'file.delete'|'file.rename'
                        |'file.upload'|'external.change'|'conflict'|'lock.denied'|'merge'; file?: FileRef;
                        text: MessageRef;      // the sentence (`activity.*`): rendered by each client in the viewer's language
                        summary: string;       // the English rendering of `text` (≤ 500 characters): fallback and logs
                        via?: 'bash';          // addition, §11 D-13: an agent.edit attributed through the shell-command window
                        renamedFrom?: string;  // on `file.rename`: the path before (`file.path` is the new one)
                      };
```

An agent in `presence.state` is named by `agentSessionName(session)` of `@smurg/protocol`: `Claude (<item title>)`,
else `Claude (<topic name>)`, else `Claude (<who opened it>)`, the one name its caret has in a document and its
lock has, so a client can match them. Its `activeFile` is present only while it is at work (`isAgentAtWork`:
`starting`, `running`, `waiting-answer`, `waiting-permission`); between turns the session lives on and works on
nothing, and its caret leaves the document when its turn ends.

A client shows `render(locale, event.text) ?? event.summary` and never parses `summary`. The daemon clips the
parameters (a path to 200 characters, at most 3 sample paths, at most 5 holder names plus `holderCount`). Lines of
`activity.jsonl` written before protocol 3 have no `text`: they fail the schema and the reader drops them.

`merge` (addition): a worktree merge request (actor: the requester), and the host's approval, rejection or conflict
(actor: the host), in everyone's feed. A `file.rename` event carries the old path in `renamedFrom`: the web client
follows a renamed file's tab from it (§9).

The human lock has no `lock.acquire` request: it is taken by the daemon when it applies the first Yjs update
from a human to a doc, and refreshed on every later update. `lock.acquire` exists only on the hook socket (§8).

### 5.5 `session.*` and `exec.*`: sessions of both kinds, and terminals

A session is a **terminal** (a PTY: attach, type, resize) or an **agent session** (a conversation with Claude Code:
§5.9). Both run like the host's own (§11 D-15): the host's OS user, unsandboxed, the host's environment / HOME /
Claude Code login, whoever opened them.

```ts
type SessionInfo = TerminalSession | AgentSession;

type SessionBase = {
  id;
  openedBy: { userId; displayName };   // who created it: attribution; never changes
  title?;                              // ONLY what a person gave: the title typed in `session.create`, the first 40
                                       // characters of a FREE agent session's first message, or `session.rename`.
                                       // Without it every client shows `sessionTitleRef(session)` in the viewer's
                                       // language (`session.title.terminal` / `.agent` / `.discussion` / `.item`)
  root: RootRef; createdAt; endedAt?;
  endReason?: 'exit' | 'ended' | 'terminated' | 'kicked' | 'left' | 'role-changed' | 'stopped'
            | 'worktree-removed' | 'archived' | 'replaced' | 'merged';
  endedBy?: { userId; displayName };   // the person who ended it, when one did
};

type TerminalSession = SessionBase & {
  kind: 'terminal';
  status: 'starting' | 'running' | 'exited'; exitCode?: number;
  cols: number; rows: number; attached: number;
};

type AgentSession = SessionBase & {
  kind: 'agent';
  purpose: 'discussion' | 'item' | 'free';   // a topic's discussion, a work item's execution, or no topic at all
  topicId?; itemId?; attempt?: number;       // discussion: topicId; item: topicId, itemId, attempt; free: none
  topicName?: string;                        // with topicId: the topic's name, kept current by the daemon
  item?: { number: number; title: string };  // with itemId: the item as PLAN.md has it now (number 0: it left the plan)
  responsible: { userId; displayName } | null;   // §3 "Who decides"
  branch?: string;                           // the worktree's branch, when it runs in one
  status: 'starting' | 'running' | 'waiting-answer' | 'waiting-permission' | 'idle' | 'stalled' | 'done' | 'failed' | 'ended';
  waitingSince?: number; doing?: 'compacting'; retryHostOnly?: true;
  runningSince?: number;                     // when the turn that runs now started; absent between turns
  permissionMode: 'ask-all' | 'ask-commands'; modeFixed: boolean;   // a discussion's mode is fixed
  ruleCount: number;                         // always-allowed kinds in force (session + topic)
  login: 'unknown' | 'logged-out' | 'logged-in';   // the host's Claude login, as this session sees it
  claudeVersion?: string;
  projectSettings: 'used' | 'ignored' | 'none';    // the root's Claude Code project settings (§5.8, the trust gate)
  noteworthyAt: number; lastSeq: number; lastActivityAt: number;
};
```

`isSessionOver(session)`: an exited terminal or an ended agent session. An agent session has no PTY: it is not
attached to, it is watched (§5.9). With `topicName` and `item` a client (the CLI's list among them) names a topic's
session without loading the topic or its plan. `defaultPermissionMode(purpose, root)` is the mode a session starts
with: `ask-commands`, except a free session in the main workspace (`ask-all`).

```ts
type HostState = {                           // `session.host.get`, `session.host`
  account: { state: 'ok' | 'logged-out' | 'usage-limit'; resetsAt?: number; sessions: number };
  mainProjectSettings: 'used' | 'ignored' | 'none';
};
```

| Type | Dir | Payload | Notes |
|---|---|---|---|
| `session.create` [session.create] | c→d | `{ kind: 'terminal', workspace: { mode: 'main' } \| { mode: 'worktree', worktreeId?: string }, cols: number, rows: number, title?: string } \| { kind: 'agent', workspace: { mode: 'main' } \| { mode: 'worktree', worktreeId?: string }, title?: string, firstMessage?: string }` → `{ session: SessionInfo }` | the session runs like the host's own, whoever opens it (§11 D-15); the caller is `openedBy`. `kind: 'agent'` makes a FREE agent session (no topic): nobody is responsible, `firstMessage` is the caller's first message. A topic's sessions are made by `topic.create` and `plan.start` |
| `session.list` [session.view] | c→d | `{ topicId?: string, after?: string }` → `{ sessions: SessionInfo[], hasMore: boolean }` | without `topicId`: terminals; agent sessions of topics that are not archived (ended ones included); free sessions. With `topicId`: every agent session of that topic, archived or not (earlier attempts, earlier discussions). Oldest first; `after` is the last session's id. Size rule: list |
| `session.state` | d→c | `{ session: SessionInfo }` | to everyone, on every change of a `SessionInfo`. When a topic's always-allowed kinds change, every session of that topic is sent: `ruleCount` of each of them counts the topic's rules |
| `session.host.get` [session.view] | c→d | `{}` → `{ account: { state: 'ok' \| 'logged-out' \| 'usage-limit', resetsAt?: number, sessions: number }, mainProjectSettings: 'used' \| 'ignored' \| 'none' }` | what every member may know of the host's side before a session exists: `account` (ONE state per workspace: `ok`, `logged-out`, `usage-limit` with `resetsAt` when Claude Code reported it; `sessions`: how many it stops) and whether the MAIN folder's Claude Code project settings are used (the New topic dialog of a member who is not the host) |
| `session.host` | d→c | `{ account: { state: 'ok' \| 'logged-out' \| 'usage-limit', resetsAt?: number, sessions: number }, mainProjectSettings: 'used' \| 'ignored' \| 'none' }` | to everyone, whenever the account state or the main folder's trust state changes |
| `session.end` (who may end it) | c→d | `{ sessionId: string, keepWorktree?: boolean }` → `{}` | a terminal: the member who opened it. An agent session: the host, or a member with agent access who opened it or is responsible for it. Never a topic's discussion (`forbidden`, `session.end.discussion`: archive the topic or restart the discussion). `keepWorktree` answers R9 for a terminal and a FREE agent session; a work item's worktree is never released by its session's end (§5.10) |
| `session.rename` [session.drive] | c→d | `{ sessionId: string, title: string }` → `{ session: SessionInfo }` | agent sessions and terminals; the title a person typed (an untitled session is named by each client: `sessionTitleRef`, §1 Languages) |
| `session.attach` [session.view] | c→d | `{ sessionId: string, haveOffset?: number, cols?: number, rows?: number }` → `{ session: TerminalSession, mode: 'snapshot' \| 'delta', data: bytes, cols: number, rows: number, nextOffset: number }` | terminals only (an agent session: `bad_request`, reason `not-a-terminal`). `haveOffset`: the client holds the output up to there; `cols` / `rows`: the opener's viewport drives the PTY size |
| `session.detach` | c→d | `{ sessionId: string }` |  |
| `exec.output` | d→c | `{ sessionId: string, offset: number, data: bytes }` | to attached viewers: PTY output from absolute byte `offset` |
| `exec.input` [session.drive] | c→d | `{ sessionId: string, data: bytes }` | keystrokes / paste into ANY terminal (an agent session: `not-a-terminal`) |
| `exec.resize` (opener) | both | `{ sessionId: string, cols: number, rows: number }` | c→d from the member who opened the terminal; d→c to viewers, in stream order with `exec.output` |

`session.create` needs `session.create` (host, "Agent access"); typing into a terminal needs `session.drive`, for ANY
terminal. Resizing stays with the member who opened it.

`exec.request.*` (R10, run-on-behalf) is reserved for the launch phase and not implemented.

### 5.6 `suggest.*`

A suggestion is text a member proposes for an AGENT session (never a terminal), the author's own included. Before a
member who may drive accepts it, not one character of it reaches the agent. An accepted suggestion is sent as a
message OF ITS AUTHOR, under a header that names who accepted it (§5.9 "Text for agents").

```ts
type Suggestion = {
  id; sessionId; author: { userId; displayName };
  text: string;                        // as the daemon stores, shows and sends it: `agentText(text).text`
  cleaned?: true;                      // something a reader cannot see was removed
  origin: 'composer' | 'follow-up' | 'revise' | 'selection';
  topicId?; itemId?; mentions?: UserId[];
  source?: { file: FileRef; startLine: number; endLine: number };
  status: 'pending' | 'accepted' | 'accepted-modified' | 'rejected' | 'withdrawn';
  createdAt; resolvedAt?; finalText?; decidedBy?: { userId; displayName };
  rejectReason?;                       // a person's words only
  closedReason?: 'session-ended' | 'author-kicked' | 'author-demoted' | 'topic-archived';  // the daemon closed it; clients word it
};
```

| Type | Dir | Payload | Notes |
|---|---|---|---|
| `suggest.create` [suggest.create] | c→d | `{ sessionId: string, text: string, source?: { file: {…}, startLine: number, endLine: number }, mentions?: string[] }` → `{ suggestion: Suggestion }` | an AGENT session (a terminal: `bad_request`, reason `not-an-agent`, `suggest.terminal`), the author's own included; at most `SUGGESTIONS_PENDING_PER_AUTHOR_MAX` pending per author and session. With `source` the origin is `selection`. Rate bucket: `suggestion` |
| `suggest.edit` (author, pending) | c→d | `{ suggestionId: string, text: string }` → `{ suggestion: Suggestion }` | Rate bucket: `suggestion` |
| `suggest.withdraw` (author, pending) | c→d | `{ suggestionId: string }` → `{ suggestion: Suggestion }` |  |
| `suggest.accept` [session.drive] | c→d | `{ suggestionId: string, text?: string }` → `{ suggestion: Suggestion }` | the text goes to the agent as a MESSAGE of its author, under a header naming who accepted it (`AgentSessions.send`); `text` present ⇒ `accepted-modified` |
| `suggest.reject` [session.drive] | c→d | `{ suggestionId: string, reason?: string }` → `{ suggestion: Suggestion }` |  |
| `suggest.list` [session.view] | c→d | `{ sessionId?: string, after?: string }` → `{ suggestions: Suggestion[], hasMore: boolean }` | without `sessionId`: every suggestion the caller may see. Newest first; `after` is the last suggestion's id. Size rule: list |
| `suggest.updated` | d→c | `{ suggestion: Suggestion }` | to the watchers of the session, the author, and the members whose inbox holds it |

`topic.revise` and `report.followUp` (§5.10) create suggestions too, for a member who may not drive
(`ConversationService.sendAs`). There is no auto-accept code path: the suggest module holds exactly one call that
sends suggestion text to an agent, in the `suggest.accept` handler's service method, after the `session.drive` and
pending checks.

### 5.7 `worktree.*`

| Type | Dir | Payload |
|---|---|---|
| `worktree.list` [file.read] | c→d | `{}` → `{ worktrees: WorktreeInfo[] }` |
| `worktree.remove` (owner or host) | c→d | `{ worktreeId }` → `{}` — the host; an owner only while they hold `session.create` (`forbidden`, `detail.reason: 'capability'` otherwise) |
| `worktree.merge.request` [worktree.merge.request] | c→d | `{ worktreeId, message? }` → `{ request: MergeRequest }` — any worktree (§11 D-15) |
| `worktree.merge.list` [file.read] | c→d | `{}` → `{ requests }` |
| `worktree.merge.diff` [file.read] | c→d | `{ requestId }` → `{ diff: string /* ≤ 1 MiB UTF-8 */, truncated: boolean, files: { path, status: 'added'\|'modified'\|'deleted'\|'renamed'\|'copied'\|'type-changed'\|'unmerged'\|'unknown', additions, deletions, oldPath?, binary? }[] /* complete, ≤ 10,000 */ }` |
| `worktree.merge.fileDiff` (addition) [file.read] | c→d | `{ requestId, path }` → `{ path, diff: string /* ≤ 1 MiB */, truncated: boolean, binary: boolean }` — one file of `files` (any other path is refused), so the whole change can be reviewed when `merge.diff` was truncated (R9: the host sees the complete diff); the UI does not offer "Merge" until every truncated file was opened |
| `worktree.merge.approve` [worktree.merge.decide] | c→d | `{ requestId }` → `{ request }` (status `merged` or `conflict` + `conflictFiles`) |
| `worktree.merge.reject` [worktree.merge.decide] | c→d | `{ requestId, reason? }` → `{ request }` |
| `worktree.updated` / `worktree.merge.updated` | d→c | `{ worktree }` / `{ request }` |
| `worktree.removed` (addition) | d→c | `{ worktreeId }` — file trees showing it switch back to the main root (`worktree.updated` cannot express removal) |

```ts
type WorktreeInfo = { id; ownerUserId; ownerName; branch; sessionId?: string; kept: boolean; createdAt; sharedDirs: string[];
                      topicId?; itemId? };                    // an item worktree (§5.10)
type MergeRequest = { id; worktreeId; requestedBy?: { userId; displayName }; message?; commit: string /* git object id */;
                      topicId?; itemId?; reviewed: boolean;   // a work item's changes; its report was reviewed
                      status: 'draft'|'pending'|'merged'|'rejected'|'conflict';
                      conflictFiles?: string[]; createdAt; decidedAt?; rejectReason? };
```

**Protocol 4.** A work item's changes are a merge request too: when its agent finishes, the daemon snapshots the item
worktree into a request in the state `draft` (nobody requested it: no `requestedBy`), which the result report shows
(§5.10); `reviewed` follows the report's review. Because every member reads a report, the two diff requests need only
`file.read`: the diff is made from git objects, past PathGuard, so for anyone but the host a file on a host-private
path is listed as hidden and its diff withheld (in the whole-diff text as well), and the text passes `mask()`.
In an item worktree no person writes the topic's folder (`specs/<slug>/**`) through smurg (§7.4).

**What a merge request contains** (addition). Agents normally edit without committing, so
`worktree.merge.request` (by any holder of `worktree.merge.request`: the host, "Agent access") first commits the
worktree's working tree onto `smurg/<owner>/<id>` as the requester, with `message` (nothing to commit is fine), then fetches that commit into the main repository as
`refs/smurg/merge/<requestId>` and records its id in `MergeRequest.commit`. `merge.diff`, `merge.fileDiff` and
`merge.approve` all work on exactly that commit, whatever happens in the worktree afterwards; a later change needs a
new request.

As built (worktree module): the commit is staged in a daemon-private object store and index (state dir; the index
copy keeps the clone index's mtime so git's racy-clean rule still re-hashes files changed in the same second as the
checkout). For a request not made by the host every new blob is verified against a careful re-read of the worktree
(no symlink on the way, O_NOFOLLOW, same identity, a single hard link, same bytes) before the objects are copied into
the clone; nested repositories are refused. Approval refuses (status `conflict`, audit reason
`local-changes`) local changes and untracked or ignored host files the merge would overwrite, and runs
`git merge --no-overwrite-ignore`. A request in `conflict` may be approved again. Worktree mode needs git ≥ 2.42
(`merge-tree --write-tree`, `--attr-source`: attributes come from the host's HEAD, so a worktree's `.gitattributes`
cannot select the host's filter or merge drivers); otherwise it is unavailable (`conflict` / `git-too-old`). A request
not made by the host, and the snapshot of a work item's change, is refused when it carries host-only paths or
changes a path the trust gate records, at the path or below it (`host_only`, `host-only-paths`, the text
`merge.containsHostOnly` names the files: a merge must not do what `file.*` refuses); anyone's request is refused
when it carries the daemon's directory. Removal renames `<id>` to `<id>.removing-<hex>` first (a name no session
works in) and deletes it there; the next start finishes leftovers. At its start the daemon also deletes every ref
below `refs/smurg/merge/` of the host's repository that no stored merge request names (a daemon that died between
fetching a request's commit and storing the request left one); when the refs cannot be listed none is removed, and
nothing else of the repository is listed or touched.

`worktree.*` and `activity.*` extend the prefix table of SPEC §7.2; nothing in them overlaps `file.*`/`exec.*`.

**Implementation of a "worktree" (see §11, deviation D-2).** Each worktree is an isolated working copy at
`<share>/.smurg/worktrees/<id>` on its own branch `smurg/<owner>/<id>`, created with
`git clone --shared --no-checkout <share> <dir>` followed by a checkout of the main workspace's `HEAD`.
Objects are shared read-only through alternates, so a session in the worktree writes nothing into the main
repository through git. Merging: the daemon (as the host) runs
`git fetch <dir> <branch>:refs/smurg/merge/<id>` in the main repository, produces the diff for review, and on approval
merges that ref; on conflict it aborts the merge and reports `conflictFiles`. Rejecting leaves the worktree untouched.
Shared directories (D12) are linked into the worktree as symlinks that PathGuard treats as read-only (a session,
running as the host, is not held to that, §11 D-15).
All git commands run with `execFile` (argument arrays, never a shell string), asynchronously.

### 5.8 `admin.*` (all require `admin`)

| Type | Payload |
|---|---|
| `admin.invite.create` | `{ role: Exclude<Role,'host'>, expiresInSec?: number, maxUses?: number }` → `{ invite: InviteInfo, url: string }` |
| `admin.invite.list` / `admin.invite.revoke` | `{}` → `{ invites }` / `{ inviteId }` → `{}` |
| `admin.member.list` | `{}` → `{ members: (Member & { devices: DeviceInfo[] })[] }` |
| `admin.member.setRole` | `{ userId, role: Exclude<Role,'host'> }` → `{ member }` |
| `admin.member.kick` | `{ userId }` → `{}` |
| `admin.session.terminate` | `{ sessionId }` → `{}` |
| `admin.audit.query` | `{ limit? /* ≤ 500 */, before? /* epoch ms, exclusive: `at` is strictly increasing */ }` → `{ entries: AuditEntry[] }` — newest first, across the rotated files |
| `admin.audit.entry` (d→c, host only) | `{ entry }` |
| `admin.settings.get` / `admin.settings.set` | `{}` → `{ settings: HostSettings }` / `Partial<HostSettings>` → `{ settings }` |

```ts
type InviteInfo = { id; role; createdAt; expiresAt?: number; maxUses?: number; uses: number; revoked: boolean };
type DeviceInfo = { deviceId; name; kind: 'web'|'cli'; addedAt; lastSeenAt; revoked: boolean };
type AuditEntry = { id; at; actor: Actor; action: string; target?: string; outcome: 'ok'|'denied'|'error'; detail?: Record<string, unknown> };
type HostSettings = PublicSettings & { diskReserveBytes: number; diskReservePercent: number;   // (allowedDomains: gone, §11 D-15)
  maxLiveAgents: number;      // 2–32; default min(8, max(2, floor(RAM / 3 GiB))): processes of work items kept alive at once
  escalateAfterMs: number;    // 1 min – 1 h, default 5 min: when a waiting card also reaches the others who may settle it (§3)
  agentMcp: boolean };        // default false: execution and free sessions get only smurg's own MCP server
```

**Claude Code on the host** (protocol 4):

| Type | Dir | Payload | Notes |
|---|---|---|---|
| `admin.claudeConfig.get` [admin] | c→d | `{ after?: string }` → `{ roots: ClaudeConfigRoot[], hasMore: boolean }` | per root, up to four entries (`CLAUDE_CONFIG_FILES_MAX`): the three project-level Claude Code files that exist, and the entry `.claude` (`PROJECT_LOADED_ENTRY`) for everything else Claude Code loads from `.claude/`; each with everything it does (commands, permission rules, environment, scripts) and the state of the host's decision. Size rule: list |
| `admin.claudeConfig.decide` [admin] | c→d | `{ root: RootRef, files: { path: string, hash: string }[], decision: 'trust' \| 'ignore', acknowledged: ('credentials' \| 'allows-tools' \| 'incomplete')[] }` → `{}` | `files`: one to four entries, each named by its hash. Refused when a hash is no longer the entry's (`claudeConfig.changed`), when a needed tick is missing (`claudeConfig.ackNeeded`, `detail.needs`), and, for `trust`, when the content is one nobody can confirm (`conflict`, `claudeConfig.cannotConfirm`, `detail.reason: 'unverifiable'`) |
| `admin.hostRules.get` [admin] | c→d | `{}` → `{ rules: { rule: string, source: 'user' \| 'project' \| 'local' \| 'managed' }[], seen: boolean }` | the host's own Claude Code allow rules as agent sessions last reported them. They APPLY to agent sessions; `seen`: the host was shown this list |
| `admin.hostRules.seen` [admin] | c→d | `{}` → `{}` | the host has the list on screen: the `host-rules` inbox item leaves. No decision is taken |
| `admin.transcript.redact` [admin] | c→d | `{ sessionId: string, seq: number }` → `{}` | replaces one conversation event by "The host removed this entry." under the same `seq`; audited `transcript.redact` |

```ts
type ClaudeConfigRoot = { root: RootRef; state: 'used' | 'ignored' | 'none'; files: ClaudeConfigFile[] };   // ≤ 4 entries
type ClaudeConfigFile = {
  path;                         // `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, or `.claude`:
                                // the entry for every other file below `.claude/` (not a file itself)
  hash; decision: 'trust' | 'ignore' | null; changed: boolean;   // changed: another content of it was decided before
  text;                         // the raw file; for `.claude` the list of its files, each with its SHA-256
  runs: string[];               // each command line, whole; also `env NAME: value` and `MCP server X env NAME: value`
                                // for a variable that changes which programs run, a hook of a shape smurg does not
                                // know as its JSON, and under a command smurg cannot follow the line that says so
  permissions: string[];        // each rule
  env: { name; flagged: boolean; programs?: boolean }[];   // flagged: it can send the host's login to another server;
                                                           // programs: it changes which programs run
  otherKeys: string[];          // the names of every other key; for `.claude` the path of each file
  scripts: { path; hash; absent?: true }[];   // ≤ 20 files inside the root the commands name: host-only for writes
                                // while trusted (§7.4). absent: named, and no file is there yet
  needsAck: ('credentials' | 'allows-tools' | 'incomplete')[];   // the ticks "Use them" needs
  cut?: { omitted: number; shortened: number };   // entries the lists above leave out, and entries they cut short
  unfollowed?: number;          // commands that reach their files in a way smurg cannot follow
};
```

Every text of `runs`, `permissions`, `env` and `otherKeys` has the characters nobody can see written out as
`<U+XXXX>` (`visibleText`, §5.9). A list holds at most `CLAUDE_CONFIG_LIST_MAX` (100) entries of at most
`CLAUDE_CONFIG_ENTRY_MAX_CHARS` (2,000) characters; what does not fit is counted in `cut`, and then, as with
`unfollowed`, `needsAck` holds `incomplete`: the host is told that the lists do not show everything and ticks that
they read the files themselves.

The trust gate: an agent session uses a root's project-level Claude Code settings only after the host confirmed
exactly that content (`admin.claudeConfig.decide`, by hash); an entry, or a script it names, that changes afterwards
parks the sessions of that root until the host looks again (§7.6 "Trust gate"). The host's OWN Claude Code allow
rules (user settings) are different: every agent session runs as the host, so they apply. smurg does not ask for
what they already allow; it tells the host about each of them once (`admin.hostRules.get`, the `host-rules` inbox
item, `admin.hostRules.seen`). The discussion agent's own limits (the tool gate, §7.7) are enforced regardless.

Audit `action` vocabulary: `auth.join`, `auth.connect`, `auth.disconnect`, `auth.rejected`, `authz.denied`, `path.denied`,
`file.write`, `file.create`, `file.rename`, `file.delete`, `file.upload`, `file.download`, `doc.edit`, `agent.edit`,
`external.change`, `doc.conflict`, `doc.conflict-resolve` (addition), `lock.acquire`, `lock.release`, `lock.denied`,
`lock.force-release`, `session.create`, `session.end`, `session.terminate` (also by the system, with `detail.reason`
`kicked` / `left` / `role-changed`, when the member who opened a session goes, §11 D-15), `suggest.create`, `suggest.edit`, `suggest.accept`, `suggest.reject`, `suggest.withdraw`,
`worktree.create`, `worktree.remove`, `worktree.merge.request`, `worktree.merge.approve`, `worktree.merge.reject`,
`member.role`, `member.kick`, `member.leave` (addition, `channel.leave`), `invite.create`, `invite.revoke`,
`device.revoke`, `settings.change`.

Protocol 4 added: `session.message`, `smurg.message`, `session.interrupt`, `session.retry`, `session.restart`, `session.responsible`,
`session.mode`, `session.rule.remove`, `session.handover` (§3 "When a member goes"), `responsible.fallback`,
`question.submit`, `question.remind`, `permission.decide`, `permission.auto` (smurg answered by a rule or the mode),
`permission.auto-deny` (the tool gate refused), `agent.command`, `topic.create`, `topic.rename`, `topic.archive`,
`topic.delete`, `topic.discussion.restart`, `topic.spec.request`, `topic.rule.add`, `topic.rule.remove`,
`plan.generate`, `plan.start`, `plan.resume`, `plan.assign`, `plan.mode`, `plan.item.retry`, `plan.item.continue`,
`plan.item.resolve`, `scheduler.start`, `scheduler.disarm`, `report.register`, `report.review`, `spec.commit`,
`claude-config.decide`, `transcript.redact`.

- `auth.connect` / `auth.disconnect` (R11 logins and logouts) are written by the core for every connection (relay or local):
  target = deviceId, detail `{ mode, purpose, resumed }` / `{ mode, purpose, reason, durationMs }`.
- `detail` is sanitised by key (bytes → sizes; `content`, `data`, `token`, `url`, `hash`, `apiKey`, `diff`, … replaced)
  and strings are cut at 2,000 characters. Never put a sensitive payload in `detail`.
- **Full texts** (R6.3). A top-level key the caller lists in `fullText` (a message, a suggestion's `text` and
  `finalText`, a command, a note) keeps its first 1,024 characters in the entry, next to `<key>Sha256` and
  `<key>Chars`; the whole text goes to the full-text store, `audit-text.jsonl` beside the log (rotated at 32 MiB into
  `.1` and `.2`, 0600), keyed by that hash and read back with `AuditLog.fullText(sha256)`. So volume from a member who
  loops suggestions rotates the text files, never the core log with its role changes and decisions.
- The log is bounded (§11 D-10): `denied` entries beyond 120 per actor and origin per minute are
  counted, not written (one entry marks the start, one summary entry gives the count). The origin is the control socket
  (`detail.via: 'control-socket'`, §8) or the relay channels: a flood through the socket, whose actor is the host, has
  its own budget and its summary says `via: 'control-socket'`; a connection with more than 60 refused
  requests in a minute is closed with `protocol-error` and loses its logical channel (no replay of the flood);
  `audit.jsonl` is rotated at 32 MiB into `audit.1.jsonl` and `audit.2.jsonl` (0600) and queries page across them.
- **Accepted entries have a budget too.** A member's own accepted (`ok`) entries of ONE action, per origin, are
  recorded up to 120 a minute. The first one beyond is recorded with `detail.rateLimited` (and `limitPerMinute`);
  the rest of that minute are written whole to `audit-overflow.jsonl` beside the log (0600, rotated like the log:
  32 MiB, two older files; no query and no console page reads it) and counted by one summary entry (`target:
  'audit-rate-limit'`, `outcome: 'ok'`, `detail: { reason: 'audit-rate-limit', notRecorded, keptIn:
  'audit-overflow.jsonl', windowStart, windowMs }`). No request is refused for it and no entry is dropped. One member
  repeating one action therefore adds at most 122 entries a minute to the log, and cannot push the role changes and
  decisions of weeks out of its three files (measured without the budget: one Editor writing files in a loop made 130
  to 270 accepted `file.write` entries a second and filled the three files in 30 to 60 minutes). Never budgeted:
  entries of agents and of smurg itself; the HOST's own entries on the relay channels (entries under the host's name
  that arrive on the control socket keep the budget: every agent session reaches that socket); and the actions
  `member.role`, `member.kick`, `claude-config.decide` and `transcript.redact`, whoever the actor is
  (`UNBUDGETED_AUDIT_ACTIONS`). A host who investigates a flood opens the overflow file by hand: JSON lines of the
  same shape.

### 5.9 Agent sessions: the conversation, questions, permission requests

**The event log.** A conversation is the ordered list of events of one agent session. `seq` starts at 1 and has no
gaps; `at` is the daemon's time. Nothing changes afterwards except by redaction (`admin.transcript.redact` replaces
one event by a notice under the same `seq`).

```ts
type ConversationEvent = { seq: number; at: number } & (
  | { kind: 'message'; messageId; from: { userId; displayName; role: Role }; text: string; cleaned?: true;
      origin: 'composer' | 'follow-up' | 'revise' | 'selection';
      suggestion?: { id; acceptedBy: UserRef; modified: boolean }; mentions?: UserId[] }     // what a person sent
  | { kind: 'smurg'; messageId; purpose: SmurgPurpose; by?: UserRef; text: string }           // what smurg sent itself
  | { kind: 'delivery'; messageId; state: 'queued' | 'started' | 'completed' | 'cancelled' }
  | { kind: 'turn.started'; turnId }
  | { kind: 'turn.finished'; turnId; outcome: 'completed' | 'interrupted' | 'error' | 'max-turns' | 'budget';
      durationMs: number; stoppedBy?: UserRef }
  | { kind: 'text'; turnId; blockId; text: string; aborted?: true; truncated?: true; parentToolUseId? }
  | { kind: 'tool.started'; turnId; toolUseId; tool: ToolView; parentToolUseId? }
  | { kind: 'tool.finished'; turnId; toolUseId; ok: boolean; result: ToolResultView }
  | { kind: 'card'; card: 'question' | 'permission' | 'suggestion'; id }                      // a card appeared here
  | { kind: 'pointer'; target: 'spec' | 'plan' | 'report'; topicId; itemId?; version? }      // "the spec changed here"
  | { kind: 'line'; text: WireRef; fallback: string }                                         // a system line
  | { kind: 'notice'; level: 'info' | 'warning' | 'error'; text: WireRef; fallback: string; action?: 'restart-agent' | 'retry' }
);
type SmurgPurpose = 'write-spec' | 'generate-plan' | 'update-plan' | 'start-item' | 'continue-item' | 'retry-item'
                  | 'fix-plan' | 'fix-report' | 'nudge-report' | 'resolve-conflict' | 'conversation-lost' | 'restart-discussion';
type ToolView = { name: string; verb: 'read' | 'edit' | 'create' | 'run' | 'search' | 'fetch' | 'task' | 'smurg' | 'todo' | 'other';
                  target?: string; file?: FileRef; outside?: true };
type ToolResultView = { additions?; deletions?; exitCode?; matches?; durationMs?;
                        body?: { kind: 'diff' | 'output' | 'list' | 'text'; text: string; truncated: boolean } };   // masked, clipped
type WireRef = { id: string; params?: Record<string, string | number> };   // a wire catalog reference, JSON ≤ 2,000 characters
type StreamingBlock = { turnId; blockId; text: string; parentToolUseId? };   // a block that streams now; never one the agent only thinks in
```

Claude Code's tools are classified in ONE place (`tools.ts` of `@smurg/protocol`): `EDIT_TOOL_NAMES`, `toolVerb(name)`
(the verb of a tool card) and `permissionWhat(view)` (what a permission card is about), so the tool card and the
permission card of the same call cannot disagree.

Questions, permission requests and suggestions are **cards**: entities with their own requests and update events. The
log holds a `card` event where one appeared; the entity travels in `session.watch` / `history` / `cards.get` and in
`question.updated` / `permission.updated` / `suggest.updated`.

| Type | Dir | Payload | Notes |
|---|---|---|---|
| `session.watch` [session.view] | c→d | `{ sessionId: string, haveSeq?: number, live?: boolean }` → `{ session: AgentSession, events: ConversationEvent[], firstSeq: number, nextSeq: number, hasEarlier: boolean, hasMore: boolean, streaming: StreamingBlock[], questions: Question[], permissions: PermissionRequest[], suggestions: Suggestion[], moreCards: CardRef[] }` | agent sessions only (a terminal: `bad_request`, reason `not-an-agent`), also those of archived topics. ONE page: the events after `haveSeq`, or the newest page without it or when it is more than `EVENTS_CATCH_UP_MAX` behind; the cards the page points to and every open card (the rest in `moreCards`); the blocks streaming now. A reply to a watch with `haveSeq` CONTINUES the caller's window when it is empty or `firstSeq === haveSeq + 1`, else it replaces it; `hasEarlier` of an empty page says events exist at or before `haveSeq`. Then the channel gets `session.events` and the card updates until `session.unwatch`, and `session.delta` only when `live` (default true). A watcher is its logical channel. Size rule: page |
| `session.unwatch` | c→d | `{ sessionId: string }` |  |
| `session.history` [session.view] | c→d | `{ sessionId: string, beforeSeq?: number, afterSeq?: number, limit: number }` → `{ events: ConversationEvent[], hasEarlier: boolean, hasMore: boolean, questions: Question[], permissions: PermissionRequest[], suggestions: Suggestion[], moreCards: CardRef[] }` | exactly one of `beforeSeq` (older) and `afterSeq` (catching up). Size rule: page |
| `session.cards.get` [session.view] | c→d | `{ sessionId: string, cards: CardRef[] }` → `{ questions: Question[], permissions: PermissionRequest[], suggestions: Suggestion[], moreCards: CardRef[] }` | at most `CARDS_GET_MAX` cards; what does not fit comes back in `moreCards`. Size rule: page |
| `session.events` | d→c | `{ sessionId: string, events: ConversationEvent[] }` | to watchers. An event whose `seq` the client already has REPLACES it (redaction). Size rule: batch |
| `session.delta` | d→c | `{ sessionId: string, turnId: string, blockId: string, offset: number, text: string, thinking?: true, parentToolUseId?: string }` | to live watchers: text of a block that is streaming; `offset` = UTF-16 units of the block before `text`; `parentToolUseId`: the subagent it belongs to. A delta the hub could not send is sent again with the next one, from the same offset; a client that still sees a gap stops appending to that block and waits for its `text` event (it may watch again, at most once per session in `DELTA_REWATCH_MIN_MS`). `thinking`: the agent thinks; such a delta has `text` '' and `offset` 0 and makes no block; it is repeated once per `DELTA_COALESCE_MS` while the agent thinks and ends with the next delta or event of that turn. **Volatile** |
| `session.message.send` [session.drive] | c→d | `{ sessionId: string, text: string, mentions?: string[], origin?: 'composer' \| 'selection' }` → `{ messageId: string }` | a message to the agent (stored and sent as `agentText(text).text`). The session is not ended and its topic not archived; a `failed` or parked session is started by it |
| `session.interrupt` [session.drive] | c→d | `{ sessionId: string }` → `{}` | "Stop": ends the running turn; open cards are withdrawn (`stopped`) |
| `session.retry` [session.drive] | c→d | `{ sessionId: string }` → `{ session: AgentSession }` | starts a `failed` session again; after three failed starts in a row the host only (`retryHostOnly`). For the session of a work item that the plan holds as failed it does what `plan.item.retry` does, whatever the session's own status (after a restart of the host's smurg it is idle): the same session resumes and smurg tells the agent to go on (started again alone, the agent would sit idle with its item shown as running) |
| `session.restart` [session.drive] | c→d | `{ sessionId: string }` → `{ session: AgentSession }` | "Restart this session's agent now" (the action `restart-agent` of a notice): the session gives up its process now when idle, else at its next idle moment; the next message starts it again with fresh launch files. The session is not ended and its topic not archived. Audited `session.restart`. Refused with `conflict` (text `claudeConfig.confirmNeeded`, `detail.reason: 'confirm-needed'`) while the session runs without its folder's project settings and the host has not confirmed them: the agent would only start again as it was, so the member is told what has to happen first |
| `session.responsible.set` [session.drive] | c→d | `{ sessionId: string, userId: string \| null }` → `{ session: AgentSession }` | the person must hold `discuss` (`responsible.notEligible`); null: nobody is assigned |
| `session.mode.set` [session.drive] | c→d | `{ sessionId: string, mode: 'ask-all' \| 'ask-commands' }` → `{ session: AgentSession }` | refused for a discussion session (`session.mode.fixed`) |
| `session.rules.get` [session.view] | c→d | `{ sessionId: string }` → `{ rules: RememberedRule[], host: { state: 'none' \| 'applied', rules?: string[] } }` | the session's and its topic's always-allowed kinds; `host.state` says whether the host's own Claude Code allow rules were found (they APPLY: every session runs as the host), `host.rules` (masked) only for the host and members with `session.drive` |
| `session.rule.remove` [session.drive] | c→d | `{ sessionId: string, ruleId: string }` → `{ session: AgentSession }` |  |
| `session.loginStatus` [session.drive] | c→d | `{ sessionId: string }` → `{ login: LoginState }` | agent sessions: runs `claude auth status --json` in the session's environment |

```ts
type Question = {
  id; sessionId; askedAt; status: 'open' | 'answered' | 'withdrawn';
  parts: { header; text; multi: boolean; options: { label; description }[] }[];        // ≤ 4 parts of ≤ 4 options
  votes: { userId; displayName; part: number; options?: number[]; other?: string; at }[];
  comments: { id; from: UserRef; text; at; mentions?: UserId[] }[];
  eligible: number;                    // members holding `discuss` who are online or have voted on any part
  decider: UserRef | null; deciderSeenAt?; escalatedAt?;
  previous?: { askedAt; tally: number[][] };                                           // the same question asked again
  answer?: { parts: { options?: number[]; other?: string; otherBy?: UserRef }[]; note?; by: UserRef; onBehalfOf?: UserRef; at; tally: number[][] };
                                       // onBehalfOf: the decider, whenever someone else submitted
  withdrawn?: { reason: 'stopped' | 'ended' | 'failed' | 'restarted'; by?: UserRef; at };   // by: who stopped the turn or ended the session
};

type PermissionRequest = {
  id; sessionId; askedAt; status: 'open' | 'allowed' | 'denied' | 'withdrawn';
  tool: string; what: 'command' | 'edit' | 'fetch' | 'outside' | 'other';
  command?; file?: FileRef; change?: { text }; url?; input?;                           // what it wants to do, WHOLE: never shortened, never masked, nothing removed (a request too large to show is denied)
  outside?: true; path?: string;                                                       // `path`: the host's copy only
  root: RootRef; reason?: string;                                                      // Claude Code's own English reason; with `gate`, the gate's English sentence
  gate?: 'writes-settings-script' | 'may-reach-settings-script';                       // smurg's own tool gate asked for this card (§7.7 G10), and why; `reason` then holds the gate's English sentence
  hostOnly: boolean;
  alwaysRule?: { tool: 'Bash' | 'WebFetch'; pattern };                                 // what "always allow" would add
  noAlways?: 'interpreter' | 'fetches-code' | 'one-word' | 'host-only' | 'no-suggestion';
  escalatedAt?;
  decision?: { by: UserRef; at; always?: 'session' | 'topic'; message? };
  withdrawn?: { reason: 'stopped' | 'ended' | 'failed' | 'restarted'; at };
};
type RememberedRule = { id; tool: 'Bash' | 'WebFetch'; pattern; scope: 'session' | 'topic'; addedBy: UserRef; addedAt };
```

| Type | Dir | Payload | Notes |
|---|---|---|---|
| `question.vote` [discuss] | c→d | `{ questionId: string, part: number, options?: number[], other?: string }` → `{}` | one of `options` / `other`, or neither to take the vote back; `options` index that part's options (exactly one unless the part is `multi`). `other`: the voter's own words, for every member holding `discuss`; shown to people only, never sent to the agent by the daemon. Rate bucket: `vote` |
| `question.comment` [discuss] | c→d | `{ questionId: string, text: string, mentions?: string[] }` → `{ commentId: string }` | Rate bucket: `comment` |
| `question.submit` [discuss] | c→d | `{ questionId: string, answers: ({ options: number[] } \| { other: string, otherBy?: string })[], note?: string }` → `{ question: Question }` | one answer per part. The decider; the host at any time; once the question escalated, every member with `session.drive`; whenever the submitter is not the decider the answer records `onBehalfOf`. SUBMITTING `other` or `note` needs `session.drive`. The first submit wins (afterwards `conflict`, reason `settled`: `settledError`) |
| `question.remind` [discuss] | c→d | `{ questionId: string }` → `{}` | the decider or the host: a mention for every eligible member who has not voted; once a minute per question |
| `question.seen` [discuss] | c→d | `{ questionId: string }` | the decider's client, once the card is on screen (`deciderSeenAt`) |
| `question.changed` | d→c | `{ sessionId: string, questionId: string, vote?: { userId: string, displayName: string, part: number, options?: number[], other?: string, at: number }, voteRemoved?: { userId: string, part: number }, comment?: { id: string, from: UserRef, text: string, at: number, mentions?: string[] }, eligible?: number, deciderSeenAt?: number }` | to watchers: one small change of an OPEN question (a vote, a comment), never the whole question; `sessionId` names its session |
| `question.updated` | d→c | `{ question: Question }` | to watchers: the whole entity, when it is answered or withdrawn, when the decider changes, when it escalates |
| `permission.decide` [session.drive] | c→d | `{ requestId: string, decision: 'allow' \| 'allow-always' \| 'deny', scope?: 'session' \| 'topic', message?: string }` → `{ request: PermissionRequest }` | members with `session.drive`; a host-only request: the host. The first answer wins (afterwards `conflict`, reason `settled`, with `detail.card`, `detail.status`, `detail.by`: `settledError`; the card itself is not in the error). `allow-always` only when the request offers `alwaysRule` (the client never sends a rule); `scope: 'topic'` only for a topic's session. `message`: with `deny`, what the agent should do instead |
| `permission.updated` | d→c | `{ request: PermissionRequest }` | to watchers: the whole entity. The host's copy carries `path` for an `outside` request; nobody else's does |

**Host-only requests.** `hostOnly` is a label on requests smurg recognises as reaching beyond the shared project:
only the host may allow them, and "always allow" is not offered. It is not a boundary (§11 D-15). A request is
host-only when Claude Code's own safety check raised it; when it is a command of several parts (Claude Code reports
`subcommandResults` instead of `safetyCheck`) whose text names `.claude`, `.git` or `.mcp.json`, because the daemon
cannot tell a read from a write there; when it reaches outside every root; when a file it names is host-only or
host-private, or lies at or below a path the trust gate records; when a path it names lies under the host's
`~/.smurg`, `~/.claude` or `~/.ssh` or under the daemon's state directory; and when smurg's own tool gate asked for
it because the command writes where a script of the project settings is (`gate: 'writes-settings-script'`, §7.7
G10). A request to WRITE Claude Code's configuration or a recorded path (an edit of one, a command for which Claude
Code names one, a single command its safety check raised that names `.claude`, `.git` or `.mcp.json`) never becomes a
card: the daemon denies it at once with a fixed English sentence (audited `permission.auto`).

**Votes.** A member has at most one vote per part and HAS VOTED once they voted on every part. Who has voted, the
tally and the leading answer are pure functions of `@smurg/protocol` (`votes.ts`), used by the conversation module
(the note for the agent, `answer.tally`), the inbox (`voted`, `allVoted`, `leading`) and the clients alike:
`votersOf(question)` (`byPart`, `any`, `complete`), `questionTally(question)` (per part: one count per option, then
"Other"), `allVoted(question)` (everyone eligible voted on every part), `leadingAnswer(question)` (per part the answer
the votes lead to, or null: for a single-select part the option with strictly the most votes, more than "Other" too;
for a multi-select part the options more than half of that part's voters chose) and `leadingLabel(question)` (the
first part's, when exactly one option leads). The texts of a question's parts are distinct (`questionPartsSchema`:
Claude Code keys the answer by them); the runner refuses a question that is not valid on the wire before a card exists
and never clips one. The line `conversation.submittedFor` is written only when a question had escalated.

**Text for agents.** Everything that goes to a model passes one of three functions of `@smurg/protocol`
(`agent-text.ts`), so what a member with agent access sees on a card is exactly the characters the agent gets:

- `agentText(raw)` for every string a PERSON wrote (messages, suggestions, notes, "Other" answers, comments, a
  denial's line), in this order: CRLF, a lone CR and Unicode's line and paragraph separators (U+2028, U+2029)
  become LF; what nobody sees is removed (lone surrogates, control characters except tab and newline, the invisible
  code points; the emoji joiner stays only between visible characters, the presentation selector only after one);
  a run of more than `MARK_RUN_MAX` (30) combining marks on one letter is cut to its first 30; NFC, and a run that
  is longer than 30 only then is cut again; and a line that looks like a header is quoted with `> `. A line looks
  like a header when it is `[…]` alone on its line, whatever blank characters stand around it (every Unicode white
  space, and the braille blank U+2800), or when it starts with `[smurg`, whatever follows on the line. A line that
  merely starts with a bracket (a task list, a link, pasted JSON) stays as written. A payload ARRIVES as any text
  but NUL (`personTextSchema`); what is stored, shown and sent is `agentText(text).text`, with `cleaned: true` when
  something was removed: a character a reader cannot see, or the marks beyond the thirtieth of a run (the card
  then says that hidden characters were removed). The function is idempotent, `agentText(agentText(x).text)`
  changes nothing, and what it costs is in proportion to the text. The cut exists because putting a run of marks
  in order costs the square of its length (a second of the daemon's one thread for one message of 64 KiB); no
  word of any language has more than 30 marks on one letter, and decorative "Zalgo" text loses the marks beyond
  the thirtieth. `normalize.ts` (`withFewMarks`, `hasLongMarkRun`, `normalized(text, form)`) is the only place of
  `packages/protocol`, `packages/daemon` and `packages/cli` that calls `String.prototype.normalize`, apart from
  the relay entry's one call on a device code of at most 64 characters (§10 "What a text costs").
- `agentSafeName(displayName, userId)` for a display name as a model reads it (at most 40 letters, marks, digits,
  space, `.`, `_`, `-`).
- `frameMessage(header, body)`: the header line in front of a body: `[Ian · Host]` for a person, `[Amy · Editor,
  suggestion accepted by Ian]` for an accepted suggestion, `[smurg <tag>]` for smurg itself (the tag is drawn at
  random per session and announced in the role prompt). Because of the header no message starts with `/`.

"Ask the agent to revise" (`topic.revise`) is composed by `composeRevise` BEFORE a message is sent or a suggestion is
created, so a card shows exactly what an accept sends: a fixed English first line naming the file (`About SPEC.md,
section "Cart rules":`), the quoted section as a fenced quotation (`quoteForAgent`), then the member's own text;
`too_large` when the result exceeds `MESSAGE_TEXT_MAX_CHARS`.

**What a conversation never holds.** `mask()` (`mask.ts`) is the one function that runs over every text that came
from an agent or a tool before it is stored or sent: agent text blocks, diffs, command output, search file lists,
fetch and other tool results, report sections, follow-up answers, merge diffs, the host's own rules. It hides what
looks like a credential. Best effort: whatever an agent reads it may repeat to everyone. Bodies are clipped to their
limits (`truncated`), never stored whole.

**Characters nobody can see.** An agent's text block is stored and shown without them (`shownAgentText`, then
`mask()`): control characters except tab and newline, every bidirectional control and the invisible code points are
removed (an emoji's joiner and presentation selector stay), so a line reads in the order it is copied. What a person
DECIDES by is never changed that way. The target of a tool card and of a permission card (a command, a URL, a search
pattern, a file's name), the file names a search lists and the whole `input` of a permission card arrive with every
such character written out as `<U+XXXX>` (`visibleText`; a tab and a line break stay, in a listed file name they are
written out too): nothing is removed, and nothing in it reads another way than it runs. The call itself runs with
the input as the agent wrote it. Tool output and diffs are sent as they are.

**Remembered rules.** "Always allow this kind" adds a rule to the session (`scope: 'session'`) or to every session of
its topic (`scope: 'topic'`). Which rules may be remembered at all is decided by `rules.ts` alone, a POSITIVE check
with exactly two forms: `Bash(<two or three literal words> *)` and `WebFetch(domain:<hostname>)`. Never an
interpreter or a shell, never something that fetches and runs code (a package manager's `add`, `install`, `exec`,
`dlx`, `run`, `create`, `init`, `x`, or an option in front of its subcommand), never a one-word pattern, never for a
host-only request. The check runs when a permission card is built (`alwaysRule` / `noAlways`), when a member types a
rule for a topic, and again on every rule read back from disk. A client never sends a rule with a decision: it sends
`allow-always`, and the daemon adds the rule the card offered.

A rule names ONE kind of command. A card offers a rule only when Claude Code suggests exactly one with the request
(`suggestedRuleOf`): a compound command (`pnpm test && git push`) carries one suggestion per part, none of them is
the kind of the whole request, and its card has `noAlways: 'no-suggestion'`. A rule of the TOPIC that a running
process does not have yet answers a waiting request of another session only when the daemon reads the request itself
as that kind (`ruleCoversRequest`): one plain command that is the rule's words or starts with them and a space, with
no `;`, `&`, `|`, redirect, `$`, backtick, parenthesis, brace, backslash, line break or control character anywhere
in it; or an http(s) URL of the rule's host without a user name or password and of at most `URL_MAX_CHARS` (2,048)
characters (a longer one is no URL a card carries, and reading a host name normalises it). Anything else is a
card. A change of a topic's rules announces every session of the topic again (`session.state`, §5.5: `ruleCount`).

**Rates.** The token buckets of §4.3: `vote`, `comment` and `suggestion` are taken by the Router for the requests
that name them; `mention` by the handlers that accept `mentions` (one token per kept mention); `agent-notify` per
session by the agent-facing `notify_member` tool.

### 5.10 `topic.*`, `plan.*`, `report.*`

A **topic** is one piece of work the team discusses and then has agents carry out. Its files are in the project:
`specs/<slug>/SPEC.md`, `specs/<slug>/PLAN.md`, `specs/<slug>/reports/<item id>.md` (`topicSpecPath` and friends in
`schema/paths.ts`); the daemon's own records are in its state directory.

```ts
type Topic = {
  id; name; slug;                      // the folder is specs/<slug>; [a-z0-9][a-z0-9-]{0,47}
  phase: 'discussing' | 'spec' | 'plan' | 'executing' | 'complete';
  archived: boolean; versioned: boolean; createdBy: UserRef; createdAt;
  discussionSessionId?; discussion: 'live' | 'lost';
  spec: { exists: boolean; changedAt?; changedBy?: Actor; lastAgentChange?: { sessionId; seq; at; askedBy?: UserRef } };
  handEdits: { spec: HandEdit[]; plan: HandEdit[] };          // HandEdit = { by: UserRef | 'outside'; at }
  plan: { exists; valid; error?: FileError; generating; stale; mode: 'assigned' | 'everyone'; paused;
          changedAt?; changedBy?: Actor;                      // the last change of PLAN.md, whoever made it
          items: number; started: number; reviewed: number; merged: number };
  rules: RememberedRule[];             // kinds always allowed for every session of the topic
};

type PlanInfo = {
  topicId; revision: number; specHash; planHash;             // the pins `plan.start` must repeat
  mode: 'assigned' | 'everyone'; paused: boolean;
  items: WorkItem[];                                          // ≤ 40 in the plan (+ items that left it but have a session)
  split?: { source: 'agent' | 'smurg'; reason? };
  warnings: WireText[];
  waitingFor: { user: UserRef; questions; permissions; reports; since }[];
  slots: { inUse: number; max: number; waitingForPeople: number };
};
type WorkItem = {
  id; number; title; summary; dependsOn: string[]; size: 's' | 'm' | 'l'; touches: string[]; inPlan: boolean;
  state: 'not-started' | 'waiting' | 'queued' | 'running' | 'stalled' | 'done' | 'reviewed' | 'failed' | 'stopped';
  stalledBy?: 'agent' | 'restart' | 'stopped' | 'error';      // why a stalled item has no report: it stopped in prose,
                                                              // smurg restarted, a person stopped the turn, the turn failed
  armed: boolean; disarmed?: 'plan-changed' | 'starter-removed' | 'start-failed';
  waitsFor?: string[];
  responsible: { userId; displayName; source: 'agent' | 'smurg' | 'chosen' } | null;
  startedBy?: UserRef; sessionId?; worktreeId?; attempt: number; startError?: WireText;
  changesAsked?: { by: UserRef; at };
  report?: ReportSummary;
  merge?: { requestId; status: MergeRequest['status']; ready: boolean };
};

type ReportSummary = {
  version: number; writtenAt; outcome: 'complete' | 'partial' | 'blocked';
  state: 'to-review' | 'reviewed' | 'changed-after-review' | 'invalid';
  reviewers: UserRef[]; escalatedAt?;
  review?: { by: UserRef; at; version; insteadOf?: UserRef };
  checks: { passed: number; notVerified: number }; error?: FileError;
};
type ReportInfo = ReportSummary & {
  topicId; itemId; file: FileRef;
  sections: { done; why; verified: { text; passed: boolean; note? }[]; watchOut; followUps? };
  changes?: { requestId; files; additions; deletions; byHand: { path; by: UserRef[] }[] };
  noChanges?: 'host-only-paths' | 'spec-files' | 'conflict-markers';
  questions: { id; from: UserRef; at; text; truncated?: true; answer?: { text; truncated?: true; at } }[];
};
type WireText = { text: WireRef; fallback: string };          // FileError = WireText & { line?: number }
```

| Type | Dir | Payload | Notes |
|---|---|---|---|
| `topic.create` [session.create] | c→d | `{ name: string, slug?: string, firstMessage?: string }` → `{ topic: Topic, session: AgentSession }` | the slug defaults from the name (`slugFromName`); refused when a topic uses it or `specs/<slug>` exists. Creates the folder and the discussion session |
| `topic.list` [session.view] | c→d | `{ archived?: boolean, after?: string }` → `{ topics: Topic[], hasMore: boolean }` | `archived` (default false): the archived topics instead of the others. Size rule: list |
| `topic.updated` | d→c | `{ topic: Topic }` | to everyone |
| `topic.removed` | d→c | `{ topicId: string }` | to everyone: the topic was deleted |
| `topic.rename` [session.drive] | c→d | `{ topicId: string, name: string }` → `{ topic: Topic }` | the folder keeps its slug |
| `topic.archive` [session.create] | c→d | `{ topicId: string, archived: boolean, deleteUnmerged?: boolean }` → `{ topic: Topic }` | archiving ends the topic's sessions (`archived`) and removes their worktrees. Worktrees with changes that were never merged need a decision: without `deleteUnmerged` the request is refused (`conflict`, reason `unmerged`, `detail.worktrees: { itemId, worktreeId, branch }[]`: `unmergedError`) and the dialog repeats it with `false` (keep them) or `true` (delete them) |
| `topic.delete` [admin] | c→d | `{ topicId: string }` → `{}` | archived topics only; removes the daemon's records and transcripts, never files of the project |
| `topic.discussion.restart` [session.create] | c→d | `{ topicId: string }` → `{ topic: Topic, session: AgentSession }` | a NEW discussion session; the old one ends (`replaced`) and stays readable |
| `topic.revise` [suggest.create] | c→d | `{ topicId: string, target: 'spec' \| 'plan', text: string, quote?: { heading?: string, text: string }, mentions?: string[] }` → `{ messageId: string } \| { suggestion: Suggestion }` | "Ask the agent to revise": a member with `session.drive` sends a message to the discussion (origin `revise`); anyone else creates a suggestion with that origin. Exactly one of the two results. The text that is stored, shown and sent is `composeRevise`: a first line naming the file, the quoted section, then the member's text (`too_large` beyond `MESSAGE_TEXT_MAX_CHARS`). Rate bucket: `suggestion` |
| `topic.spec.request` [session.drive] | c→d | `{ topicId: string }` → `{}` | "Write the spec now" |
| `topic.rule.add` [session.drive] | c→d | `{ topicId: string, tool: 'Bash' \| 'WebFetch', pattern: string }` → `{ topic: Topic }` | the checked forms only (`rules.ts`); applies to every session of the topic |
| `topic.rule.remove` [session.drive] | c→d | `{ topicId: string, ruleId: string }` → `{ topic: Topic }` |  |

| Type | Dir | Payload | Notes |
|---|---|---|---|
| `plan.generate` [session.drive] | c→d | `{ topicId: string }` → `{}` | generates or updates the plan; `Topic.plan.generating` until the turn ends |
| `plan.get` [session.view] | c→d | `{ topicId: string }` → `{ plan: PlanInfo \| null }` |  |
| `plan.updated` | d→c | `{ plan: PlanInfo }` | to everyone |
| `plan.mode.set` [session.drive] | c→d | `{ topicId: string, mode: 'assigned' \| 'everyone' }` → `{ plan: PlanInfo }` |  |
| `plan.assign` [session.drive] | c→d | `{ topicId: string, itemId: string, userId: string \| null }` → `{ plan: PlanInfo }` | before the item has a session the plan holds who is responsible; afterwards this writes through the session |
| `plan.suggest` [session.drive] | c→d | `{ topicId: string }` → `{ plan: PlanInfo }` | "Suggest again": smurg's even split, for items that are not started and not `chosen` |
| `plan.preflight` [session.create] | c→d | `{ topicId: string, itemIds?: string[] }` → `{ preflight: StartPreflight }` | what the Start dialog shows; its three pins go back in `plan.start` |
| `plan.start` [session.create] | c→d | `{ topicId: string, itemIds?: string[], planRevision: number, specHash: string, planHash: string }` → `{ plan: PlanInfo }` | without ids: every item of that revision that is not started. Refused with `conflict`, reason `plan-changed`, when a pin differs from the files now |
| `plan.changes` [session.view] | c→d | `{ topicId: string }` → `{ files: { target: 'spec' \| 'plan', diff: string, truncated: boolean }[] }` | "Show the changes": unified diffs of SPEC.md and PLAN.md as they are now against what the last Start pinned (against the last commit before the first Start), each cut at `PLAN_CHANGES_DIFF_MAX_BYTES` (`truncated`), through `mask()`; one entry per file that differs |
| `plan.resume` [session.drive] | c→d | `{ topicId: string }` → `{ plan: PlanInfo }` | "Continue all" after a restart of the host's smurg |
| `plan.item.retry` [session.create] | c→d | `{ topicId: string, itemId: string }` → `{ plan: PlanInfo }` | a failed item resumes its session (also one whose process had failed before smurg was restarted); a stopped item gets a new session in the same worktree |
| `plan.item.continue` [session.drive] | c→d | `{ topicId: string, itemId: string }` → `{}` | tells a stalled execution session to go on |
| `plan.item.resolve` [session.drive] | c→d | `{ topicId: string, itemId: string }` → `{}` | after a merge conflict: smurg merges the main workspace into the item's worktree and asks the agent to resolve |
| `report.get` [session.view] | c→d | `{ topicId: string, itemId: string }` → `{ report: ReportInfo }` |  |
| `report.updated` | d→c | `{ topicId: string, itemId: string, report: ReportSummary }` | to everyone: the summary |
| `report.followUp` [suggest.create] | c→d | `{ topicId: string, itemId: string, text: string, mentions?: string[] }` → `{ messageId: string } \| { suggestion: Suggestion }` | like `topic.revise`, to the item's session (origin `follow-up`). Rate bucket: `suggestion` |
| `report.review` [discuss] | c→d | `{ topicId: string, itemId: string, version: number, acknowledgeUnfinished?: boolean }` → `{ report: ReportSummary }` | "I've reviewed this": one of the reviewers; once escalated, every member with `session.drive`. `version` must be the current one; an outcome other than `complete` needs `acknowledgeUnfinished` |

**A work item's worktree** is the item's, not its session's: created when the item starts, reused by a retry, and
removed only when the item is merged and reviewed with nothing unmerged left in the worktree (§7.8 "After the
merge"), or when its topic is archived (`WorktreeManager.releaseItem`); the end of a session, `keepWorktree` or not,
never removes it. When the member who started an item goes, the worktree passes to the host with the session. `PlanInfo.slots` is the scheduler's own count: item sessions that hold a process (`inUse`)
of the host setting `maxLiveAgents` (`max`); the agent runtime knows only its own limits.

`StartPreflight` (the Start dialog): the pins (`planRevision`, `specHash`, `planHash`), what starts now and what
waits for which items, who is responsible for each item and whether they are online, the commit of the two files that
Start would make (`commit`), hand edits since the agent last wrote, invisible characters in the files, whether the
plan is stale against the spec, open questions, who is editing right now, the trust state of the project settings,
the topic's rules, the shared directories, and `blockers` (why Start is refused).

**Who edited by hand.** `Topic.handEdits` (and with it the Start dialog and the checkpoint's `Edited-by:`) names a
member under BOTH files when they renamed or deleted a folder that holds them (`specs/<slug>`, `specs`); what a
program outside smurg did to such a folder is read again but named under neither (§7.8 "The spec").
`ReportInfo.changes.byHand` lists the files of an item's change that people also edited by hand in its worktree: a
hand edit names what the person's request named, a file or a FOLDER they renamed, moved into place or deleted, and a
folder counts for every changed file below it, also one the agent wrote there later.

### 5.11 `inbox.*`

A member's inbox is DERIVED: everything that waits for that member (by the routing rules of §3 "Who decides") plus
two kinds of stored notes (mentions and results). It is recomputed from the other services' state and events; only
notes and seen marks are stored.

```ts
type InboxItem = {
  key: string;                         // `<kind>:<id>`; `attention:<subject>:<id>`
  kind: 'question' | 'vote' | 'permission' | 'attention' | 'suggestion' | 'report' | 'merge' | 'mention' | 'result';
  subject?: 'item-stalled' | 'item-failed' | 'item-stopped' | 'item-not-started' | 'plan-paused' | 'discussion-lost'
          | 'account' | 'project-settings' | 'host-rules' | 'storage';                 // of an `attention` item
  at; unread: boolean; waiting: boolean;                                               // `waiting`: work stands still for it
  topicId?; sessionId?; itemId?;
  item?: { number: number; title: string };                                            // wherever itemId is: "1 · Cart API"
  target: ColumnTarget; anchor?: { cardId?; seq? };                                    // what opening it shows
  from?: Actor; excerpt: string; count?;
  voted?; eligible?; allVoted?; leading?;                                              // a question
  waitsFor?: UserRef; waitsForOffline?; escalated?; alsoFor?: UserRef[]; alsoForMore?;
  outcome?; checks?;                                                                   // a report
  result?: 'rejected' | 'accepted-edited';                                             // what became of my suggestion
  ready?; unblocks?: number[]; conflict?;                                              // a merge
};
type ColumnTarget = { kind: 'session'; sessionId } | { kind: 'spec'; topicId } | { kind: 'plan'; topicId }
                  | { kind: 'report'; topicId; itemId } | { kind: 'changes'; requestId }
                  | { kind: 'console'; section: 'members' | 'sessions' | 'suggestions' | 'merges' | 'invites' | 'audit'
                                               | 'settings' | 'claude-config' | 'host-rules' };   // CONSOLE_SECTIONS
```

One shape, and a table that says which fields each kind carries (`INBOX_KIND_FIELDS`; the schema enforces it: a
required field is there, a field the kind does not carry is refused). Every item has `key`, `kind`, `at`, `unread`,
`waiting`, `target` and `excerpt`; `waiting` is `inboxKindWaits(kind, subject)`; `item` goes with `itemId`.

| Kind | Always | May have | `excerpt` |
|---|---|---|---|
| `question` (I decide) | `sessionId`, `anchor.cardId`, `voted`, `eligible`, `allVoted` | `topicId`, `itemId`, `item`, `leading`, `waitsFor`, `waitsForOffline`, `escalated`, `alsoFor`, `alsoForMore` | the text of part 1 |
| `vote` | `sessionId`, `anchor.cardId`, `voted`, `eligible` | `topicId`, `itemId`, `item`, `waitsFor` (who decides), `waitsForOffline` | the text of part 1 |
| `permission` | `sessionId`, `anchor.cardId` | `topicId`, `itemId`, `item`, `waitsFor`, `waitsForOffline`, `escalated`, `alsoFor`, `alsoForMore` | the command, the URL or the path relative to the root; never the absolute `path` |
| `suggestion` (one per author and session) | `sessionId`, `anchor.cardId` (the oldest pending one), `from`, `count` | `topicId`, `itemId`, `item`, `alsoFor`, `alsoForMore` | the text of the oldest pending one |
| `report` | `topicId`, `itemId`, `item`, `outcome`, `checks` | `sessionId`, `waitsFor`, `waitsForOffline`, `escalated`, `alsoFor`, `alsoForMore` | empty |
| `merge` | `ready`, `conflict` | `topicId`, `itemId`, `item`, `from` (who asked; none for a reviewed draft), `unblocks` | the request's message, or empty |
| `mention` | `from` | `topicId`, `sessionId`, `itemId`, `item`, `anchor` | the text around the mention |
| `result` | `sessionId`, `anchor.cardId` (the suggestion), `from` (who decided), `result` | `topicId`, `itemId`, `item` | the suggestion's text |
| `attention` | `subject` | `topicId`, `sessionId`, `itemId`, `item`, `count` | the topic's name for `plan-paused` and `discussion-lost`, else empty |

`voted` counts the members who voted on every part; `leading` is `leadingLabel(question)` (§5.9 "Votes"): the leading
option of the first part, absent on a tie. A row names a work item from `item`, never from `excerpt`. The host's
attention subjects open a section of the console: `account` and `storage` → `sessions`, `project-settings` →
`claude-config`, `host-rules` → `host-rules`.

**Mentions.** A request may carry `mentions` (`session.message.send`, `question.comment`, `suggest.create`,
`topic.revise`, `report.followUp`). An id is kept only when that member is active and the text contains `@<their
display name>`; any other id is dropped without an error. When the mentioned member already has
`INBOX_NOTES_PER_MEMBER_MAX` unopened notes the mention is not stored and the request still succeeds: its handler
tells the sender with a notification (`mention.inboxFull`). "Ask them to submit" on a question card is a
`question.comment` with `mentions`, whose text the client writes.

| Type | Dir | Payload | Notes |
|---|---|---|---|
| `inbox.list` | c→d | `{ after?: string }` → `{ items: InboxItem[], hasMore: boolean }` | the caller's own items. Size rule: list |
| `inbox.changed` | d→c | `{ upsert: InboxItem[], remove: string[] }` | to the member's own channels (never the control socket). Size rule: list |
| `inbox.seen` | c→d | `{ keys: string[] }` | clears `unread`; opening a mention or a result this way also removes it |
| `inbox.dismiss` | c→d | `{ key: string }` → `{}` | mentions and results only (`inbox.notDismissable` otherwise) |

An item that waits (a question to decide, a permission request, a report to review, a merge) leaves when it is
settled, never by dismissal. `inbox.changed` goes to the member's own interactive channels only; the control socket
gets none of it (§8).

---

## 6. Relay

Routes (Worker):

See `docs/research/relay.md` for the verified spike this is built from.

One Worker, three SQLite-backed Durable Object classes: two keyed by workspace id (`getByName`), sharing a `RelayRoom`
base class: `WorkspaceDO` (interactive traffic + host liveness) and `TransferDO` (file chunks); and, since 2026-10-01,
`DeviceLoginDO` (the CLI's device-code login: pending logins keyed by user code, and its rate limits; wrangler migration
`v2`; see "As built").
Hibernation API only (`ctx.acceptWebSocket(ws, tags)`); all routing state lives in tags (`host`, `client`, `c:<conn>`),
socket attachments and `ctx.storage.kv` — never in memory, because local workerd really hibernates after ~10 s.
The Worker also serves the web SPA (assets + `run_worker_first`), so web app and relay share one origin. For the
shared relay that origin is `https://app.smurg.ai`, a Cloudflare Custom Domain with the Worker's workers.dev hostname
off; any other relay (a test relay, a relay someone hosts for themselves) defaults to its account's workers.dev or
uses its own domain. `scripts/deploy-relay.sh` deploys exactly one of these two shapes (`docs/RELEASING.md` §2;
self-hosting: `apps/relay/README.md`). The relay's HTML pages (`/device`, the login error pages) exist in both languages
(text: `apps/relay/src/lib/strings.ts`) and choose per request: cookie `smurg_lang` → the first supported entry of
`Accept-Language` → `en` (§1 Languages; `lib/locale.ts`). A GET page carries two plain links `<path>?lang=en|zh-TW`:
that request sets `smurg_lang=<locale>; Path=/; Max-Age=31536000; SameSite=Lax; Secure` (not HttpOnly: the web app,
same origin, reads and writes the same cookie, §9; no `Secure` on a plain-http local relay) and answers 303 to the
same path without `lang` (never to a URL from the request); `lang` on a POST or with any other value is ignored.
Pages carry `Vary: Accept-Language, Cookie`, `<html lang>` (`en` / `zh-Hant-TW`) and `<body data-state>` (which
page it is, whatever the language: tests select by it); their CSP is unchanged (no script). The JSON API never
chooses a language: errors are `{ error: <code>, message? }` with English messages. A Google account without a
name and without a verified e-mail address is called `Google user`.

| Route | Purpose |
|---|---|
| `GET /auth/:provider/login`, `GET /auth/:provider/callback` | `github` (OAuth App, state + PKCE), `google` (OIDC, state + nonce + PKCE) |
| `GET /auth/dev/start`, `POST /auth/dev/token` | dev-only provider: requires `DEV_LOGIN=1` **and** a local hostname |
| `POST /auth/device/start`, `POST /auth/device/token` | the CLI's device-code login (RFC 8628 style): a device code and a user code → polled until allowed → bearer token, once; see "As built" |
| `GET /device`, `POST /device` (same-origin form) | where a person logged in to the relay enters the CLI's user code and allows or denies the login (relay-rendered page, no script) |
| `POST /auth/logout`, `GET /api/me` | session (`/api/me` answers 401 when logged out; see "As built") |
| `GET /api/login-options` | no session: `{ providers: { github, google }, dev }`, booleans only (`relayLoginOptionsSchema`, `loginOptionsUrl()`): which login buttons to show; `dev` = the dev-login gate for this request's hostname |
| `POST /api/workspaces` | host claims a workspace id (owner = caller); only the owner may open host sockets |
| `POST /api/identity-token` | `{ workspaceId, cnf }` → EdDSA JWT (`typ: smurg-identity+jwt`, 5 min) |
| `GET /.well-known/jwks.json` | relay public keys (`kid` = RFC 7638 thumbprint), with an explicit `Date` header (the daemon's estimate of the relay clock, §4) |
| `GET /ws/:workspaceId/host`, `GET /ws/:workspaceId/client` | → `WorkspaceDO` |
| `GET /xfer/:workspaceId/host`, `GET /xfer/:workspaceId/client` | → `TransferDO` (owner check through `WorkspaceDO` RPC) |

Sessions: EdDSA JWT. Browser = `HttpOnly; Secure; SameSite=Lax` cookie **plus a mandatory Origin allow-list** on
cookie-authenticated WebSocket upgrades (Chromium sends the Lax cookie from sibling origins). CLI/daemon = bearer token.

Frames. Tunnelled traffic is **binary**; the relay reads nothing in it except the connection-id prefix on host sockets:
client → relay `ciphertext`; relay → host `<u32be conn><ciphertext>`; host → relay `<u32be conn><ciphertext>`.
Frame cap `MAX_RELAY_FRAME = 8 MiB + 64 KiB`, derived from protocol constants. Control is JSON **text**:

```ts
// relay → client
{ t: 'hello', conn: number, host: boolean }        // host = host currently online
{ t: 'host.online' } | { t: 'host.offline', reason: 'closed' | 'timeout' }
// relay → host
{ t: 'peer.open', conn: number, userId, displayName, avatarUrl? } | { t: 'peer.close', conn: number }
// host → relay
{ t: 'peer.kick', conn: number, reason: string }
// relay → anyone, always sent before a relay-initiated close
{ t: 'bye', code: 4000 /*heartbeat timeout*/ | 4001 /*host replaced*/ | 4003 /*kicked*/ | 1009 /*too big*/, reason }
// heartbeat: the literal text frames "ping" → "pong" (DO auto-response; exact strings)
```

These schemas and the route builders live in `@smurg/protocol/relay` so relay, daemon, CLI and web agree.

Rules: a new host connection replaces older host sockets (epoch) and close events from stale epochs are ignored;
the alarm also sweeps clients whose last ping is older than 30 s (→ `peer.close`); always call `ws.close()` inside
`webSocketClose`; Node clients must act on `bye` instead of waiting for the close event (FIN lags 10–16 s locally);
per-workspace and per-account socket caps.

What the relay can observe (R3): workspace id, connection id, frame sizes and timing — and, because it performs the
login, the account identity and IP address of each connection. It never sees keys, invite secrets, device ids or content.

Tests start the relay with wrangler's `createTestHarness()` on a random port (no Cloudflare account). The R3 byte
tap is a test-only hook (`RELAY_TAP_URL`, gated to local hostnames) that POSTs every frame to a local collector.

As built (relay report; details in `apps/relay/README.md`):
- `POST /api/workspaces` takes an optional `{ workspaceId }` (a daemon may choose its id); the owner may repeat the
  claim (200), anyone else gets 409. Sockets (host and client, `/ws` and `/xfer`) to an unclaimed id get 404.
- Cookie sessions need an allow-listed `Origin` on WebSocket upgrades AND on POSTs; JSON bodies must be
  `application/json`; with an https issuer the cookie is `__Host-`. An Authorization header that is present but invalid
  is 401 even when a valid cookie is present.
- The identity token requires `cnf`. `RELAY_SIGNING_KEY` may hold several keys (rotation); all are in the JWKS.
- The TransferDO also sweeps silent clients (`bye 4000`). A frame from a client while no host is connected is answered
  with `host.offline`. Caps: 64 client sockets per workspace, 8 per account (per Durable Object). A client frame may be
  `MAX_RELAY_FRAME − 4` bytes (the prefixed host frame must still fit).
- The CLI's device-code login (every CLI login, RFC 8628 style; `apps/relay/src/auth/device.ts`,
  `device-store.ts`; the shared constants and schema in `@smurg/protocol/relay` `device-login.ts`). `POST
  /auth/device/start` (no session; JSON) answers `{ deviceCode, userCode, verificationUri, expiresIn: 600, interval: 5 }`:
  the user code is 8 characters of RFC 8628 §6.1's alphabet `BCDFGHJKLMNPQRSTVWXZ` (shown `XXXX-XXXX`; typed in any
  case, with or without spaces and dashes, full-width too: NFKC), the device code `<user code>.<32 random bytes,
  base64url>`. The login is stored in the `DeviceLoginDO` instance `code:<user code>` (so /device finds it from what was
  typed, the token endpoint from the device code) with SHA-256 of the secret (compared in constant time), the creation
  time, and the client's `CF-Connecting-IP` with Cloudflare's country and city (`request.cf`); its alarm deletes it at
  expiry. `POST /auth/device/token { deviceCode }` answers 400 `authorization_pending`, `slow_down` (a poll sooner than
  the interval minus 1 s; the interval then grows by 5 s, RFC 8628 §3.5; the time of the last poll is kept in memory,
  so a poll costs one read and no write), `access_denied`, `expired_token` (also for an unknown, collected, or forged
  code: they cannot be told apart) or `invalid_request`, and once allowed the bearer session `{ token, tokenType,
  expiresIn, user }` (the shape `POST /auth/dev/token` returns too), handed out once (the record is deleted with it). `GET /device` (Worker-first, in
  `RELAY_WORKER_FIRST_PATTERNS`) shows the relay's login (Google / GitHub when configured, the dev login when
  `devLoginEnabled`), which returns to /device, or for a logged-in browser (the cookie; a bearer token is not a browser)
  the code form; it never takes a code from its URL (a prefilled link would be the phisher's). Each `POST /device` must be
  a same-origin form (`isSameOriginFormPost`: `Origin` = the relay or an allow-listed origin, `Sec-Fetch-Site:
  same-origin` when present; 403 otherwise, a non-form body 415): `code` → the confirmation screen
  (the account, the code, the IP address and approximate place and the age of the request, and the warning to press "Allow" only if you
  just ran `smurg login` in your terminal yourself); `code` + `account` + `decision=allow|deny`
  → the decision, bound to the browser session's identity, refused (409) when the account is no longer the one the
  screen named. A code that is not pending (unknown, expired, decided, also by another account) is a wrong code; wrong
  codes are limited to 10 per account and 30 per IP address per 10 minutes (checked before the lookup; 429 with
  "Too many wrong codes. Try again in N minutes."), starts to 30 per IP address per 10 minutes (429 `too_many_requests` with
  `Retry-After`); the counters are `DeviceLoginDO` instances `limit:<kind>:<SHA-256 of the address or account>` with one
  alarm at the window's end. Every /device page: the relay HTML CSP (`frame-ancestors 'none'`, `form-action 'self'`),
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `no-store`. Tests: `apps/relay/test/device.test.ts` (workerd),
  `apps/relay/test/cli-login.browser.test.ts` (Chrome, the real CLI), `tests/e2e/test/device-login.test.ts`, `web/e2e/smoke/login.smoke.test.ts`;
  the dev-only `/api/debug/device-login` (like `/api/debug/room`) lets the tests expire a login.
- The CLI loopback login of smurg 0.1.0 (`GET`/`POST /auth/cli/start`, `POST /auth/cli/token`) was removed on
  2026-10-01 (no installed CLI used it); those paths answer 404 (`apps/relay/test/auth.test.ts`). What it taught
  still holds for /device: a link alone never changes a login, and /device reaches GitHub / Google
  through links, not forms, because Chromium applies the submitting page's CSP `form-action` to every redirect of a
  form submission.
- Dev-only routes (`/auth/dev/*`, `/api/debug/room`, `/api/debug/device-login`) need `DEV_LOGIN=1` AND a local hostname.
- `GET /api/login-options` (2026-09-29) answers `{ providers: { github: boolean, google: boolean }, dev: boolean }`
  without a session: a provider is `true` when its configuration is complete (its login route would not answer 503),
  `dev` when `DEV_LOGIN=1` AND the request's hostname is local (`devLoginEnabled`, the same gate as the dev routes).
  Nothing else (no client id, no endpoint); `Cache-Control: no-store`; no CORS headers, like `/healthz`, the JWKS and
  `/api/me`; GET only. It is there so that the web app stops probing `/auth/<p>/login` and `/auth/dev/start`
  (§9), which puts a 400 / 404 / 503 into the browser console on every page load. `/api/me` keeps its 401 for a
  logged-out caller: the client SDK's login diagnosis (`probeLogin` in `client/engine.ts`), `RelayApi.me()`, the CLI's
  stored-session check and the relay tests rely on it.
- The relay's `build` refuses to bundle a missing web build, the stand-in page that `pnpm dev:relay` and the tests put
  into `apps/web/dist`, a build without `_headers` carrying a `/*` Content-Security-Policy with `frame-ancestors 'none'`
  or without a `/*` `Strict-Transport-Security` of at least a year (lines under another rule do not count), and a build that would serve `.vite/manifest.json` (`.assetsignore` must list `.vite`) (`scripts/check-web-dist.ts`).
- The SPA's own security headers come from `apps/web/public/_headers`, which Workers static assets
  apply to every asset and SPA route (relay routes keep their own headers): `Content-Security-Policy: default-src
  'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; img-src
  'self' data: https:; font-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'; form-action 'self'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Strict-Transport-Security:
  max-age=31536000` (since 2026-10-01: the relay is a custom domain of `smurg.ai`, which is not HSTS-preloaded like
  `*.workers.dev`; no `includeSubDomains`, no `preload`, as on smurg.ai; `scripts/deploy-relay.sh --check` requires it
  on an https relay). The built-app smoke test runs the whole app under it with zero violations. The Vite dev server does not apply `_headers`.

---

## 7. Daemon

### 7.1 State on disk (`~/.smurg/`, mode 0700; files 0600)

```
~/.smurg/
├── credentials.json                 relay session token for the CLI
├── device.key                       CLI device static key
├── workspaces.json                  folder path → workspaceId; for a workspace the CLI joined, its web origin when it
│                                    is not the relay's (§8)
├── run/<short>.ctl                  control socket (the host's OS account): stop, status, local attach (§8)
├── run/<short>.hook                 hook + MCP socket of the agent sessions (§7.7)
├── run/<short>.pid
├── run/<short>.<hex4>.lk            share-lock socket of a running daemon (per instance; named in the folder's marker)
├── pins/<hex(utf8(workspaceId))>.pub   CLI pins of verified daemon keys (§4.2)
├── logs/<workspaceId>.log           daemon log of `smurg host` (0600; never invite links or secrets)
├── sessions/<wsKey>/<hex(sessionId)>/  daemon-owned launch files of an agent session's PROCESS: settings.json (the
│                                    tool gate, the other hooks, the rules), mcp.json, role.md (§7.6 "Launch").
│                                    Derived data: written at every process start, removed when the process ends, and
│                                    all of them at a daemon start (wsKey: 24 hex of the workspace id;
│                                    hex(sessionId): case-fold safe)
└── workspaces/<workspaceId>/
    ├── identity.key                 daemon static key
    ├── state.json                   members, devices, invites (PSK-derived keys), settings, roots
    ├── worktrees.json               worktrees and merge requests, drafts included (worktree module)
    ├── audit.jsonl                  append-only; rotated at 32 MiB to audit.1.jsonl, audit.2.jsonl (§5.8)
    ├── audit-overflow.jsonl         a member's accepted entries of one action beyond 120 a minute, whole (the log
    │                                counts them in one summary entry); rotated like the log; exists once one was
    │                                written; never read by a query (§5.8)
    ├── audit-text.jsonl             the audit log's full-text store: whole messages, suggestions, commands and notes,
    │                                keyed by their SHA-256; rotated at 32 MiB to audit-text.1.jsonl, audit-text.2.jsonl
    │                                (§5.8). Volume rotates these files, never the core log
    ├── activity.jsonl               rotated at 8 MiB into activity.1.jsonl
    ├── conflicts.json + conflicts/  conflict records and the agents' full versions (docs module)
    ├── suggestions.json
    ├── sessions.json                the live list: the ids of running sessions of both kinds with the identities of
    │                                their processes (what a daemon that died hard left behind; below)
    ├── agent-sessions.json          the RECORD of every agent session: what a later process start needs (§7.6 "The
    │                                record"); never on the wire
    ├── transcripts/<hex(sessionId)>/   one agent session's private directory (0700)
    │   ├── events-000001.jsonl, …   the conversation: one event per line, in segments of 8 MiB (§7.6 "Transcript")
    │   ├── cards.json               the session's questions (votes, comments, the answer) and permission requests (the
    │   │                            host's copy), written whole on every change; every open card and the 500 newest
    │   │                            settled ones are kept (conversation module)
    │   └── role.md                  the session's role prompt, written once, sent byte for byte at every start
    ├── cards.json                   an index only: the ids of the sessions that have a cards.json
    ├── topics.json                  topics, the last plan that parsed, and per work item id who is responsible, what
    │                                was armed with which pin, its session, worktree and report bookkeeping (§7.8)
    ├── reports.json                 the registered result reports (their sections; the files stay in the project)
    ├── inbox.json                   per member: stored notes (mentions, what became of their own suggestions; at most
    │                                200, all unopened) and the "seen" marks of derived items. Everything else in an
    │                                inbox is derived and never stored (§7.9)
    ├── claude-trust.json            the host's decisions about project-level Claude Code settings, per file content
    │                                (path + SHA-256, with the scripts its commands name), and per file below
    │                                `.claude/` for everything else Claude Code loads from there (§7.6 "Trust gate")
    ├── host-rules.json              the host's own Claude Code allow rules as agent sessions last reported them (one
    │                                set for the main folder, one for the worktrees), the rules the host was told
    │                                about, whether the host was shown the list, and the notices the host gets once
    │                                per workspace (§7.6 "The host's own Claude Code", "Login and the account")
    ├── git-home/, git-template/, git-staging/   private dirs of the worktree module's git runs
    └── uploads/                     partial uploads: <id>.json manifest, <id>.log journal, <id>.part
```

`<short>` is a 12-character id (`shortRunId(workspaceId)`, from SHA-256): macOS limits Unix socket paths to 104 bytes
including the NUL, and Node does NOT fail on a longer path — it binds the socket at a silently truncated path in
another directory, outside the private run dir. The run dir is `config.runDir`
(default `<stateDir>/run`, created 0700); `resolveConfig` computes `config.runPaths` and refuses (fail closed) any
socket path over 103 bytes (`assertSocketPath`, `src/core/sockets.ts`). Tests whose state dir is deep pass a short
`runDir` (`createTempRunDir()` of `@smurg/daemon/testing`).

Every per-id path must use a case-fold-safe name (like `pins/`, `sessions/` and `transcripts/`): ids are
case-sensitive, APFS is not. `workspaces/<workspaceId>/` is safe because the daemon refuses a `state.json` of another
workspace id.

Every `*.json` directly in `workspaces/<workspaceId>/` is a state document (`StateStore.document(name, schema,
initial)`): a strict schema, validated when it is loaded and on every update, written atomically. A document that was
edited by hand and no longer fits stops the daemon at its start instead of reaching a client or starting an agent
from it (a session's own `cards.json` is read with its own strict schema). Nobody has installed an earlier version:
no file of 0.4.0 is read or migrated.

Inside the shared folder the daemon only creates `.smurg/` (`worktrees/` with transient `<id>.removing-<hex>` during a
removal, `trash/` for deletes in progress (emptied at start), `uploads/` when the state dir is on a different volume,
and `daemon-lock.json`), and adds `.smurg/` to `.git/info/exclude`. It writes nothing into `.claude/` (§11, D-1).
A topic's files (`specs/<slug>/SPEC.md`, `PLAN.md`, `reports/<item id>.md`) are files of the PROJECT, written by
agents and people and versioned with the project's git (§5.10, §7.8); the daemon creates the folder and, at a Start,
commits the two files (§7.8 "Start").

**One daemon per folder**: `createDaemon` takes `<share>/.smurg/daemon-lock.json` (O_EXCL), which names
a Unix socket the daemon holds while it runs (`<runDir>/<short>.<hex4>.lk`). A live marker in the folder refuses the
share (`ShareLockError` reason `shared`), and so does a live marker in an ancestor folder (`ancestor-shared`), whatever
the state dir or relay; a marker whose socket answers nothing (a crashed daemon) is taken over. Not detected: a
descendant folder already hosted by a daemon of ANOTHER state dir (the CLI checks descendants of its own state dir).
`prepareShare` also refuses a folder that contains the host's home directory or `/Users`, `/home`, `/root`, `/var/root`: every member would see `~/.ssh` and the rest.

`workspaces/<id>/state.json` writes that fail (disk full, permissions) are kept and retried with backoff up to every
10 s, and every `flush()` tries again: a kick, role change, invite revocation or settings change is in
force at once in memory (fail closed) and on disk as soon as the disk takes it; admin requests meanwhile answer
`internal {reason: 'state-not-saved', applied: true}` (`invite.create`: `applied: false`, the unseen link is revoked).
`smurg stop` while a document is unsaved logs `STATE NOT SAVED`. Failed audit appends are kept (≤ 4 MiB) and written
with the next one; a torn last line of `audit.jsonl` / `activity.jsonl` / a transcript segment (a crash mid-write) is
terminated when the file opens.

**The live list** (`sessions.json`; the code calls it the live document) names every session that holds a process
with that process and its descendants (`procs: { [sessionId]: { pid, id: sha256(start ‖ command) }[] }`, refreshed
by the 2 s scan): the PTY child of a terminal, the `claude` child of an agent session. A daemon that starts after a
hard death ends those leftovers through killTree (env marker, or a recorded identity that still matches). A graceful
stop leaves the list empty. It says nothing about which sessions EXIST: a terminal is gone with its process, an agent
session is its record in `agent-sessions.json` and comes back idle (§7.6 "Restart").

**What transcripts hold, and for how long.** A transcript holds what the conversation showed, after masking and
clipping (§5.9 "What a conversation never holds"): never text deltas, thinking, the contents of files an agent read,
the matched lines of a search, or a raw line of Claude Code. The directories are 0700, outside the shared folder,
and no file request reaches them (PathGuard); every member reads conversations through `session.watch` /
`session.history`, also those of archived topics and also a member who joined later. A topic's transcripts live as
long as the topic and go with `topic.delete`; a free session's transcript goes 30 days after the session ended; one
session's log is trimmed (whole oldest segments, never one that holds the event of an open card) beyond 256 MiB; the
workspace budget is 2 GiB, beyond which the oldest ended free sessions go and then nothing is removed silently (the
host gets the attention item `storage`). `admin.transcript.redact` rewrites one segment with one event replaced.
`smurg uninstall` removes them with the state dir. Claude Code keeps its OWN transcript of every conversation in the
host's `~/.claude/projects/…` under its own retention (30 days by default): that is the model's memory, smurg never
reads or deletes it, and a session, running as the host, can read both (§11 D-15).

The single executable (`scripts/build-sea.sh`) extracts its native modules (node-pty, @parcel/watcher) and the docs
compute worker on first use to `~/Library/Caches/smurg/native-<id>` / `$XDG_CACHE_HOME/smurg/native-<id>`
(`SMURG_CACHE_DIR`), checked by sha256 on every start.

### 7.2 Module map

```
packages/daemon/src/
├── core/          context.ts interfaces.ts router.ts permissions.ts hub.ts state-store.ts audit.ts audit-text.ts
│                  rates.ts bus.ts config.ts stubs.ts sockets.ts (socket path limits, run paths) shell-scan.ts (a
│                  shell line as words and commands, for the trust gate's scripts and the tool gate's G10)
│   └── fakes/     TEST ONLY: an in-memory fake of every service protocol 4 added or changed, their mechanical handlers,
│                  and builders (the pure ones are `@smurg/protocol/testing`)
├── net/           relay-connection.ts channel-server.ts (handshake responder, resume, outbox) identity.ts (JWT verify)
├── admin/         invites.ts members.ts handlers.ts teardown.ts (what happens when a member goes, §3)
├── workspace/     path-guard.ts roots.ts power.ts (caffeinate / systemd-inhibit)
├── files/         file-service.ts watcher.ts handlers.ts upload.ts download.ts disk.ts
├── docs/          doc-service.ts reconcile.ts (diff + 3-way) conflicts.ts handlers.ts
├── locks/         lock-manager.ts presence.ts activity.ts handlers.ts
├── sessions/      the registry of both kinds; the terminal runner (pty-session.ts term-mirror.ts raw-tail.ts);
│                  the agent runtime (the runner, the transcript, profiles, the trust gate, the host's rules)
├── hooks/         hook-server.ts (Unix socket) tool-gate.ts bash-guard.ts (what a shell command names: row G10)
│                  hook-cli.ts (entry used by Claude Code) settings-writer.ts mcp-tools.ts (the answers of the
│                  agent-facing tools)
├── mcp/           coord-server.ts (stdio MCP entry, proxies to hook socket) tools.ts
├── conversation/  messages to agents, questions, votes, comments, permission decisions, cards
├── suggest/       suggestion-service.ts handlers.ts
├── topics/        topics, the plan (format, preflight, pins, the scheduler), reports, prompts
├── inbox/         the derived inbox, mentions, results
├── worktree/      worktree-manager.ts merge.ts handlers.ts
├── local/         protocol.ts (ctl frames + schemas, shared with the CLI) local-channel.ts (the hub's channel for a
│                  local client) control-server.ts (ctl socket: stop / status / local attach) module.ts
├── testing/       test harness (`@smurg/daemon/testing`): in-memory relay, test identity issuer, temp dirs, clients
└── daemon.ts      composition root: builds DaemonContext, registers handlers, starts/stops everything
```

Every feature module exports a `FeatureModule` (`core/context.ts`): `create(ctx)` fills the service slots it
implements (one provider per slot), `register(router, ctx)` adds its handlers and bus listeners and returns the
`Disposable` that undoes them, `start` / `stop` are optional. Modules talk to each other **only** through the
interfaces in `core/interfaces.ts` and events on `ctx.bus`; what several of them must compute the same way (who
decides, text for agents, what may be always allowed, masking, sizes, normalisation at a cost in proportion to the
text: `normalize.ts`) is a pure function of `@smurg/protocol`.
`ctx.lifecycle` (`stop()`, `status()`, `attachLocal()`) is what only the composition root can do; the control-server
module uses it. `ctx.config.sessions`, `ctx.config.agents` and `ctx.config.runPaths` carry the launch inputs (§7.6);
`ctx.rates` is the per-member rate limiter (§4.3).

**Service slots** (`ctx.services`, `FeatureServices`). A slot no module fills holds a stub whose every method answers
`internal` "not implemented: <Service>" (`core/stubs.ts`), so the daemon composes with any subset of modules.

| Slot | Interface | Module | What it is |
|---|---|---|---|
| `files`, `uploads`, `downloads` | `FileService`, `UploadService`, `DownloadService` | files | the tree, guarded reads and writes, transfers |
| `docs` | `DocService` | docs | Yjs documents, reconciliation, conflicts |
| `locks`, `presence`, `activity` | `LockManager`, `PresenceService`, `ActivityFeed` | locks | file locks, who is where, the activity feed |
| `sessions` | `SessionManager` | sessions | the registry of terminals and agent sessions; `teardownUser` |
| `agents` | `AgentSessions` | sessions | the agent runtime: start, send, the event log, watch / history, rules, mode, responsible person, labels, park and restart, the account state. Its own limits are `maxAgentSessions` and `maxAgentProcesses`; the host setting `maxLiveAgents` is the scheduler's |
| `projectTrust` | `ProjectTrust` | sessions | the trust gate for a root's Claude Code project settings; `protectedPaths(root)` |
| `hostRules` | `HostRules` | sessions | the host's own Claude Code allow rules: they apply; the host is told about each of them once. Also what the host was told once per workspace (`wasTold`, `markTold`) |
| `hooks` | `HookServer` | hooks | the hook and MCP socket; per-session credentials and launch files |
| `conversation` | `ConversationService` | conversation | `session.message.send`, questions, permission decisions, `cards`, `sendAs` (which composes the text of a revise), `memberRemoved` |
| `suggestions` | `SuggestionService` | suggest | suggestions to agent sessions |
| `topics`, `plans`, `reports` | `TopicService`, `PlanService`, `ReportService` | topics | topics, the plan and its scheduler (it alone enforces `maxLiveAgents` and releases item worktrees), result reports; the checks the agent-facing tools answer with |
| `inbox` | `InboxService` | inbox | the derived inbox; `addMention`, `addResult` |
| `worktrees` | `WorktreeManager` | worktree | worktrees, snapshots of work items, merge requests, the diff of the spec and plan since a Start |

**Who writes which system line and audit entry** is part of each method's contract in `core/interfaces.ts` (never a
convention between two modules): the agent runtime writes the lines about a stop, a retry, a changed or reset mode,
a removed rule, who is responsible, an end and a restart of its process, and every `notice.*` (the login notices
among them); the caller of `AgentSessions.start` gives the line that opens a conversation; the conversation module
writes `conversation.submittedFor` and `conversation.rule.added*`; the teardown of the session registry writes the
handover and fallback lines; the topics module writes the lines about what it asked the agent.

`core/fakes/` holds an in-memory implementation of each of the slots `agents`, `projectTrust`, `hostRules`,
`sessions`, `hooks`, `conversation`, `suggestions`, `topics`, `plans`, `reports`, `inbox`, `worktrees`
(`createFakes(env)`, `fakesModule({ except, handlers })`, `fakesOf(ctx)`): the same contracts, the same bus events,
the same system lines, no rules of another module. A package's tests compose its real module with fakes for the rest
in a test daemon; with `handlers: true` the fakes also answer the wire for their slots. Nothing the host runs may
import them (a composition test follows the import graph of `daemon.ts`, `index.ts` and the session entry points).

**The core's own work** beyond routing and fan-out: the member teardown (§3), the rate buckets (§4.3), volatile
delivery and per-channel fan-out with a separate copy for the host (`hub.sendToChannels`, `hostPayload`), the audit
log with its full-text store (§5.8), PathGuard (§7.4), and the admin handlers, which delegate the trust gate, the
host's rules and redaction to the services above.

### 7.3 Internal events (`ctx.bus`)

Payloads: `core/interfaces.ts` (`DaemonEvents`).

| Event | Emitted by | Meaning |
|---|---|---|
| `member.joined`, `member.left`, `member.kicked`, `member.role-changed` | core | membership; the last three drive the teardown of §3 |
| `device.added`, `device.revoked`, `conn.opened`, `conn.closed` | core | devices and socket-level connections |
| `channel.discarded` | core | a logical channel is gone for good: drop all per-channel state keyed by its `channelId` |
| `settings.changed` | core | the host's settings (`maxLiveAgents`, `escalateAfterMs`, `agentMcp` among them) |
| `file.changed` | files (watcher) | "re-check this path", with best-effort attribution |
| `doc.human-edit`, `doc.saved` | docs | a person's edit was applied; a document was written |
| `agent.tool.pre`, `agent.tool.post`, `agent.file-changed` | hooks | Claude Code's hook events for a modifying tool |
| `agent.tool.gate` | hooks | the tool gate refused a tool call (which row, which path) |
| `agent.ready` | sessions | an agent's process answered: version, login, tools. The runner itself writes what follows from it (the login notices, the account state) |
| `agent.process` | sessions | `{ sessionId, purpose, topicId?, hasProcess, reason: 'started' \| 'parked' \| 'failed' \| 'ended' }`: every change of whether a session holds a process (parking changes nothing on the wire). The scheduler runs on it |
| `agent.request`, `agent.request.withdrawn` | sessions | the agent asks a question or wants permission (the runner guarantees a question passes the wire's schema; a permission request carries the `ToolView` of its call); Claude Code withdrew it (`reason`, and `by`: who stopped the turn or ended the session). Not emitted for a restart of the daemon: the conversation module withdraws the open cards of its own store when it starts. The conversation module makes a card or answers by itself |
| `agent.turn.started`, `agent.turn.finished` | sessions | a turn; the end carries the outcome, `stoppedBy`, the final text (masked), the messages it took (`messages`: for each, whether a person or smurg wrote it, who, its origin and the suggestion it was) and the files its edit tools changed |
| `account.changed` | sessions | `{ account }`: the workspace's account state changed (the sessions module sends `session.host`) |
| `lock.changed` | locks | every change of a file lock |
| `session.created`, `session.updated`, `session.exited` | sessions | a session of either kind |
| `question.changed`, `permission.changed` | conversation | every change of a card, with the entity before (`previous: null`: it just appeared) |
| `suggestion.changed` | suggest | every change of a suggestion |
| `topic.changed`, `topic.removed`, `plan.changed`, `report.changed` | topics | the entities of §5.10. `topic.removed { topicId, sessionIds }` is emitted BEFORE the topics module makes the agent runtime forget those sessions, so listeners can still map them |
| `worktree.changed`, `merge.changed` | worktree | worktrees and merge requests (drafts included) |
| `attention.changed` | topics, sessions, the trust gate, the host's rules | that source's attention facts changed: the inbox asks its `attention()` again |
| `activity.recorded` | locks (activity) | every entry the activity module records (hand edits of topic files, `changes.byHand`); a rename carries `renamedFrom` |
| `trust.changed` | sessions (the trust gate) | the host's decision about a root's project settings changed, or the files did |
| `daemon.stopping` | core | stop() began |
| `state.write` | core | `{ document, ok }`: a state document the disk refused, or wrote again |
| `relay.link` | core | `{ purpose, state, reason?, status? }`: every state change of a relay link, `auth-rejected` included |

`smurg host` prints `state.write` and `relay.link` on the host's terminal (§8).

Per-client state that must survive a resume (doc subscriptions, attached terminals, watched conversations) is keyed
by the logical channel (`conn.channelId`), never by the socket (`conn.id`); service methods say `channelId` where they
mean it. The core runs the per-member teardown of §3 for `member.kicked`, `member.left` and a role change that took
`session.create`, `session.drive` or `discuss` away; feature modules do not duplicate it. The activity module alone
turns bus events into activity entries and their audit entries (mapping in `ActivityFeed`, `core/interfaces.ts`);
exceptions that call `ActivityFeed.record` directly: the conflict panel (`conflict`) and the worktree module
(`merge`).

**Relay link** (`net/relay-connection.ts`): a refused WebSocket upgrade reports its HTTP status. 401/403 (the host's
7-day relay session expired or was revoked) moves the link to `auth-rejected`: one error log that names `smurg login`,
and a retry of the same token only every `timing.relayAuthRetryMs` (5 min) instead of hammering the relay.
`Daemon.updateRelayToken(token)` (`RelayLink.setToken`) reconnects at once with a new token; `smurg host` calls it when
`credentials.json` has a renewed login for the same account. A link that drops is logged at warn with its reason, and
its recovery with the time it was offline. Heartbeat, pong watchdog and open deadline use `monotonicNow(clock)` (a
wall clock stepped back does not freeze them), and so do the lock manager's idle timeout and TTL
(§7.5).

### 7.4 PathGuard

```ts
interface PathGuard {                       // full contract: packages/daemon/src/core/interfaces.ts
  lexical(path: unknown, options?: { allowRoot?: boolean }): string;
  /** Resolve a client-supplied FileRef, or throw PathDeniedError (audited as path.denied, exactly once). */
  resolve(ref: FileRef, opts: { principal: Principal; forWrite?: boolean; mustExist?: boolean; allowRoot?: boolean;
                               finalSymlink?: 'follow' | 'self' | 'deny'; audit?: boolean }): Promise<ResolvedPath>;
  /** Convert an absolute path (from a hook / watcher) back to a FileRef, or null when outside every root. */
  toFileRef(absPath: string): Promise<FileRef | null>;
  revalidate(resolved, opts): Promise<ResolvedPath>;            // same object (dev, ino, kind) as before, or denied
  openRead(resolved, opts): Promise<GuardedFile>;               // O_NOFOLLOW + fstat check
  readFile(ref, opts & { maxBytes? }): Promise<{ bytes; identity; truncated }>;
  writeFileAtomic(ref, data, opts & { noClobber?; expect?; mode? }): Promise<FileIdentity>;
  checkPlaced(resolved, placed, opts): Promise<void>;           // post-move containment check
}
```

Every call names its `principal` (the member, an agent session's principal, or the system): host-only, hidden and
hard-link rules depend on it. An agent's principal is its session's (`MemberDirectory.agentPrincipal`, §3): it has
the host's rights on host-only paths only when the session was created with `pathRights: 'host'`, whoever owns the
session now.

Algorithm: lexical layer first (`checkRelPath` of `@smurg/protocol`) — reject NUL and control characters, bidi
overrides, backslashes, drive letters, absolute paths, empty / `.` / `..` segments, lone surrogates and a run of
more than `MARK_RUN_MAX` (30) combining marks (problem `mark-run`); normalise to NFC; enforce per-platform segment
length → join with the root → `realpath` the deepest existing ancestor → require it to be inside `realpath(root)`
→ for the remaining non-existing tail, require plain names. A symlink whose target leaves the root is denied unless
the link itself is one of the daemon-created shared-dir links recorded in `state.json` (then: read-only).

A name with a run of more than 30 combining marks is no path, and it is refused, never cut: a cut name would be
the name of another file, and normalising a longer run costs the square of its length (§5.9 "Text for agents").
The run is counted before and after NFC and with the code points a file system ignores left out (a zero width
joiner between two marks does not end it). So a file or folder with such a name cannot be reached through smurg:
it is not listed, and it cannot be opened, created, renamed to or uploaded; a request that names it is refused
like a name with a control character. Agents and terminals, which run as the host, see it like any other file.

**The check is repeated before every disk read and every disk write**, not only when a document or upload is opened:
a session can swap a parent directory for a symlink at any time, and the daemon acts for every member. Files are opened with
`O_NOFOLLOW` and verified with `fstat` against the `lstat` taken during resolution. After a write that moves a file
into place (autosave rename, upload commit) PathGuard performs one post-move containment check and removes the file
if it landed outside. Every denial is audited as `path.denied`, including a request the decoder refuses because its
path is lexically invalid (the hub audits it: `detail.reason: 'lexical'`, `problem`). The one exception is a lookup:
`file.stat` of a place the reader may not look at (`host-private`, `hidden`, `hard-link`, `not-directory`) answers
`not_found`, unaudited and uncounted (§5.2).

Additional rules (daemon-core):
- For non-hosts the host-private paths (§5.2: `.git`, `.envrc`, `.claude/settings.local.json`, `CLAUDE.local.md`, at
  any depth) are refused for reads and writes with reason `host-private` (host-only keeps precedence
  for writes).
- Four write rules since 0.5.0 (`test/path-guard-rules.test.ts`):
  - **`CLAUDE.md` and `CLAUDE.local.md` at any depth are host-only for writes**, in the lexical list of §5.2
    (`isHostOnlyPath`): Claude Code loads them as instructions for agents that run as the host.
  - **What the trust gate records is host-only for writes.** While the host's confirmation of a root's project-level
    Claude Code settings stands, the scripts those settings run inside the root are part of the confirmed content
    (§7.6 "Trust gate"), and so is a path their commands name where no file is yet. PathGuard asks
    `ProjectTrust.protectedPaths(root)` at every write and compares after `foldPathName()`: a write AT a recorded
    path or BELOW it is refused to everyone but the host (so nobody else creates a named file that is not there yet,
    a folder in its place, or anything below that folder); a provider that fails protects nothing more, the lexical
    list still holds.
  - **A folder is everything below it.** A request that moves, removes or puts in place a WHOLE entry (both ends of
    a `file.rename`, a `file.delete`: `ResolveOptions.subtree`) is refused like a write of what the entry holds, or,
    at the destination of a rename, would hold: with the reason `read-only` for a person when the folder holds
    `specs/<slug>` of an item worktree (so `specs` itself cannot be moved or replaced there); with `host_only` for
    anyone but the host when a path the trust gate records lies at or below it, and when anything below it, at any
    depth, has a host-only NAME (`.claude`, `.git`, `.smurg`, `.vscode`, `.idea`, `.mcp.json`, `.envrc`, `CLAUDE.md`,
    `CLAUDE.local.md`). For the names the folder is looked through as it is on disk, at most
    `SUBTREE_SCAN_MAX_ENTRIES` (100,000) entries; a larger folder, or one that cannot be listed, is refused too (the
    host moves it). So an Editor cannot rename or delete a `node_modules` in which a package ships a `CLAUDE.md` or a
    `.vscode` folder. Without this rule a rename of the parent folder replaces what a write of the file itself
    cannot.
  - **In a work item's worktree no person writes the topic's folder.** A root registered with its item
    (`roots.registerWorktree({ …, item: { topicId, topicSlug, itemId } })`, which `acquireForItem` passes) refuses
    every write below `specs/<slug>/` from a member, the host included, with reason `read-only`: that copy of the
    spec and the plan is what the agent was started from, and the report file there is the agent's (§7.8). The
    daemon itself may write there (it removes a stale report before a start); what the item's own agent may edit
    there is the tool gate's decision (§7.7), not this rule's.
- For non-hosts `<share>/.smurg` is hidden (not readable, however it is spelled or reached); regular files with more
  than one hard link are refused (one could alias a file outside the share); FIFOs, sockets and devices are refused.
- Host-only and hidden are decided on the request's spelling, on the symlink-resolved path, AND on the on-disk
  spelling of what exists (native `realpath` returns the canonical case: `.VScode` and `.vſcode` resolve to
  `.vscode`), each compared after `foldPathName()` (§5.2).
- `ResolvedPath.ref` keeps the request's (NFC) spelling. On a case-insensitive file system two spellings can name one
  file (`README.md` / `readme.md`): per-file state (locks, docs) must key by the resolved object (realPath from a
  native `realpath`, or dev + ino), not by the raw request path.
- `ResolvedPath.realPath`, `parentRealPath` and `name` are spelled as the file system stores them (native `realpath`;
  missing names as requested; a followed final link keeps its target), and every read, write, rename and post-move
  check works on that spelling. APFS keeps an entry's stored spelling when a file is renamed over it, so a
  request-spelled path (NFC `café` onto a stored NFD `cafe` + U+0301, `readme.md` onto `README.md`) failed the
  post-move check, which removed the file (fixed 2026-10-01). A case-only or normalisation-only move is renamed to the
  requested spelling (`files/fs-ops.ts` moveResolved). A name the caller makes up next to an existing one is built from
  the REQUEST's spelling: the upload plan numbers `readme.md` next to `README.md` as `readme (1).md`, as a single
  upload does, and counts a candidate as taken under either spelling.
- Linux (2026-10-01): ext4, btrfs, xfs and tmpfs compare names byte by byte while every request is NFC, so an entry
  stored in another normalisation (NFD) would be listed but never reachable. A segment that is not found is mapped onto
  the ONE entry of its directory whose NFC form equals it (an exact NFC twin wins; two or more other spellings count as
  not found), and it then goes through every check like any other entry. Directory listings and the zip walker leave out
  names no request can reach (an NFD twin next to its NFC name); the zip reports them as `duplicate-name`
  (`workspace/fs-util.ts` otherSpellings / unaddressableNames). Looking for the other spelling lists the directory: a
  zip download, a watcher batch, an upload plan and a `file.tree` (a folder of n Mac-made sub-directories
  cost 2n listings of it at depth 2) each keep one listing per directory for the whole operation, up to 1024
  directories at a time (an older one is listed again if needed; it never fails) (`ResolveOptions.spellings`, fs-util
  SpellingIndex; without it a folder of n Mac-made names cost n listings of n entries: a 20,000-file zip
  took 374 s instead of 26 s on ext4). A single request that misses still lists its directory once.

### 7.5 Documents, locks and reconciliation (see `docs/research/yjs-monaco.md`)

- One `Y.Doc` **and one `Awareness`** per open `(root, path)`; `DocRoom` is the only fan-out point. Each Y.Doc has a
  random `epoch`; a client whose epoch differs drops its replica (otherwise the file content is duplicated).
  Rooms stay alive for a grace period after the last subscriber leaves so short disconnects merge normally.
- Text is normalised in the Y.Text: CRLF and lone CR → LF, UTF-8 BOM stripped; `eol` and `bom` are kept in `meta`
  and re-applied on save. Files that are > 5 MiB, contain NUL, carry a UTF-16/32 BOM or are not valid UTF-8 are
  refused (`TextDecoder` with `fatal: true`; never `Buffer.toString`).
- Sync messages that carry content from a connection without `file.write` are dropped and audited.
  Awareness updates are decoded, validated (strict `RelativePosition` schema, normalised through
  `Y.createRelativePositionFromJSON`) and re-encoded; client ids are bound per connection and the `user` field is
  overwritten with the daemon's view of the member. The daemon's own awareness state is `null`.
- **Agent presence:** per `(file, agent session)` a real `Awareness` on a throwaway `Y.Doc`, forwarded into the room;
  state `{ user: { name: 'Claude (Checkout)', color, kind: 'agent' }, selection }` (the session's agent name, §1
  Languages rule 5) with the caret at the end of the last applied change.
- **Human edit → disk:** human-origin update → `locks.touchHuman` → debounce 300 ms (max wait 2 s) → per-file
  serialized flush: re-check containment; read + SHA-256 the file (never trust equal `size/mtime/ino`); if it differs
  from the last known content, reconcile first; then atomic write (`.<name>.smurg-<hex>.tmp`, `wx`, original mode,
  fsync, rename) → `doc.saved`.
- **Disk → Yjs:** every watcher event means "re-check this path". Own echo is detected by content hash.
  - no human lock: `applyDiskChange` with `smartDiffer3` (bounded: `fast-diff` only for ≤ 4K-unit middles, otherwise
    line diff with timeout + pairwise refinement), one transaction with the agent's origin.
  - human lock held: `threeWayReconcile(base = lockBase, ours = Y.Text, theirs = disk)`, where **`lockBase` is the disk
    text at the moment the human lock was taken** (not the last autosave). Clean hunks are applied; overlapping hunks
    keep the human text and become a `ConflictRecord`; both sides are notified; the merged text is written back.
  - Diff and merge can take up to ~1 s on large files; run them off the main thread (`worker_threads`).
- **Agent lock:** requested by `PreToolUse` of an edit tool on the hook socket (the tool gate's row G8, §7.7), TTL
  60 s. While held, docs on that file are
  `canEdit = false` for everyone; a human update that still arrives is applied-then-reverted so every replica
  converges, and the sender gets `doc.rejected`.
  Released by `PostToolUse`, `PostToolUseFailure`, **and** by that session's next `UserPromptSubmit`, next
  `PreToolUse`, `Stop`, `SessionEnd`, or the TTL — a permission request that a person denies fires no Post event.
  Locks are capped per session and only granted for paths inside the session's root.
  **An edit that waited for a person** (0.5.0): the gate granted the lock before Claude Code asked for permission, and
  the lock's 60 s can pass while people decide. Before the daemon answers "allow" to a permission request of an edit
  tool (a member's click, or its own allow in a main-workspace session, §7.6 "Profiles") it asks for the agent lock
  again. When a person holds the file by then, a member's decision is refused with `locked` (`permission.fileBusy`),
  the card stays open and the agent keeps waiting; an allow of the daemon's own becomes a denial that says so. A lock
  denial in a discussion session on a file of its topic is shown to people as the notice `conversation.locked.spec`;
  "Let the agent go first" releases the human lock. The spec and plan files are ordinary documents of the main root:
  people and the discussion agent take turns on them by these rules and nothing else (a discussion agent has no
  shell, so the three-way path below is not reached by an agent's write to them).
- **Human lock:** shared between humans, idle timeout 30 s (setting); released when the last holder closes the file
  or chooses "Let the agent go first".
- **Lock time**: idle timeouts and TTLs are durations measured on the monotonic clock (lock time = the
  wall time at start + monotonic time since, whole milliseconds), so a wall clock stepped back an hour neither keeps a
  lock alive for that hour nor expires every lock when it is stepped forward. Reported timestamps are epoch ms, off by
  at most the steps.
- Watcher: `@parcel/watcher`, one subscription per root, ignoring `.git`, `node_modules`, `.smurg` and temp files.
  **Native calls** (2026-09-29: a gate worker died with SIGTRAP, "memory corruption of free block" inside
  `FSEventStreamCreate`; evidence in `yjs-monaco.md` Q7 "Watcher crash"): @parcel/watcher 2.6.0 changes process-global
  state on its libuv pool and FSEvents threads without the JS thread's locks. So every native subscribe / unsubscribe of
  every daemon in the process goes through ONE queue (`nativeWatcherQueue()`, one call at a time); a root is stat'ed as
  the same directory right before its subscribe (a failing native subscribe releases JS references off the JS thread);
  a subscription whose root was seen gone is released only after FSEvents reported the root deleted plus 500 ms (it
  stops that stream itself, on its own thread, unlocked) or after 5 s (the native module reports nothing when the root
  is back before FSEvents delivered its move: live updates of a folder moved away and back then resume ~5 s after its
  return instead of ~0.5 s; seen once in a full gate run, gate-stability 2026-09-29); `unregisterWorktree` resolves only once the
  watcher released the root (listeners of a removal may return a promise), so the worktree manager renames the
  directory away afterwards; `stop()` releases the roots one by one and waits for every native call (a process that
  exits with live subscriptions can abort); the callback of a released subscription or a removed root does nothing.
  `WatcherOptions.native` is the seam the tests instrument (`test/files/watcher-native.test.ts`). Residual native
  races: §12.

### 7.6 Sessions (see `docs/research/claude-structured.md`, `pty-packaging.md`, `claude-hooks.md`)

**Who runs what (§11 D-15).** Every session runs like the host's own, whoever opened it: as the host's OS user,
unsandboxed, with the host's environment (below), `HOME` = `config.sessions.hostHome`, the host's `claude` with its
login and `~/.claude`, in the main workspace or a worktree (R9). Opening one needs `session.create` (the host and
"Agent access", the member's CURRENT role, checked by the Router and again in `SessionManager.create`). Who may
message, answer and end what: §3.

**The two runners (§11 D-16).** `sessions/session-manager.ts` is the registry of both kinds (ids, limits, the live
list, ending, what happens when a member goes); what a session IS depends on its kind:

| | Terminal session | Agent session |
|---|---|---|
| What runs | the host's shell in a PTY (`pty-session.ts`, "PTY" below) | the host's `claude` as a child with three pipes, in bidirectional stream-json mode (`sessions/agent/`); no PTY, no terminal UI of Claude Code |
| What members get | bytes: `session.attach`, `exec.*` (§5.5); `smurg attach` | a conversation: events, cards, streaming text (§5.9); the browser only |
| Lifetime | its process: when the shell exits the session is over | its RECORD (`agent-sessions.json`): a session lives without a process ("parked") and survives a restart of the daemon |
| Driven by | keystrokes of every holder of `session.drive` | messages of holders of `session.drive`; accepted suggestions; smurg's own messages (§7.8) |

Structured mode has consequences that are part of the contract: Claude Code reports itself to the API as `sdk-cli`,
not as the interactive `cli` (§12); none of Claude Code's own dialogs exist (no trust dialog: "Trust gate" below; no
`/login`: the host logs in in their own terminal); slash commands are not available to members (every message goes
out under a header line, so none starts with `/`, §5.9). The Agent SDK is not bundled: the daemon speaks the same
control protocol on the pipes itself (`claude-structured.md` §1 says why).

**Launch.** One `claude` process per LIVE agent session, spawned with `detached: true` (killTree protects the
daemon's own process group, so a child inside it could never be killed) and `stdio: pipe × 3`; its stderr is read
continuously into a 16 KiB tail for the log, so a full pipe never blocks the agent. The command line is the runner's
fixed stream flags, the conversation flag, and the profile flags:

```
claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages
       --replay-user-messages --permission-prompt-tool stdio                      (STREAM_ARGS, a constant)
       ( --session-id <claudeSessionId> | --resume <claudeSessionId> )            ("Runner" below)
       --permission-mode <default | acceptEdits>
       --settings <launch dir>/settings.json  --mcp-config <launch dir>/mcp.json
       --tools <the profile's list>
       --append-system-prompt-file <launch dir>/role.md
       [ --strict-mcp-config ]                 (only smurg's own MCP server; "The host's own Claude Code")
       [ --setting-sources user ]              (the root's project settings are not trusted; "Trust gate")
```

`cwd` is the session's root. Never `--model` (which model a session uses is between the host's CLI and account),
never a bypass flag, never `--dangerously-skip-permissions`, never `--allowedTools` / `--disallowedTools` (every rule
is one string in the settings file, so no rule text is ever parsed as a list of rules), and
`CLAUDE_CODE_ENTRYPOINT` is never set. The launch dir is `~/.smurg/sessions/<wsKey>/<hex(id)>/` (§7.1); the hooks
module is the ONE writer of its three files (`HookServer.writeSessionFiles(sessionId, LaunchProfile)`, contract in
`core/interfaces.ts`). The sessions module checks the returned profile flags against an allow-list before the spawn
and fails closed (`checkLaunchArgs`): `--settings`, `--mcp-config`, `--tools` and `--permission-mode` (`default` or
`acceptEdits`) must be present; besides them only `--append-system-prompt-file`, `--setting-sources user` and
`--strict-mcp-config` may appear; a launch file path must be absolute.

The first line on stdin is the control request `initialize` (30 s, else the session is `failed` with
`session.claude.initTimeout`); then `list_permission_rules` ("The host's own Claude Code"). A control request a
version does not know is treated as "not available", never as an error.

Every message smurg writes to stdin is a `user` line marked `client_composed: true`: smurg composed it (a header
line, then text that may be another member's), so Claude Code delivers it as written. An `@path` in a message is
plain text for the agent, which reads the file with its `Read` tool and asks when that needs permission. Without the
field Claude Code treats the text as typed at its own prompt and expands the mention: the file's content goes to the
model with no tool call, so the gate never sees it and no permission request and no card exist, also for a file
outside the project (verified with 2.1.288, `claude-structured.md` §3). A message is never run as a slash command
either, whatever its first character. The known side effect, from Claude Code's own description of the field: the
context it attaches at the start of a turn (nested `CLAUDE.md` and rules files, skill and tool listings, reminders)
arrives after the turn's first tool call instead of with the prompt.

Session settings (daemon-owned file; the profile fills the parts in angle brackets):

```jsonc
{
  "disableAllHooks": false,
  "env": { "CLAUDE_CODE_SAFE_MODE": "0", "CLAUDE_CODE_SIMPLE": "0" },   // otherwise hooks can be switched off
  "disableDeepLinkRegistration": "disable",
  "crossSessionInbound": "refuse",                 // no other Claude Code session on the machine may message this one
  "permissions": {
    "allow": ["mcp__smurg", /* <the profile's allow rules; the session's and its topic's remembered rules> */],
    "ask":   [],                                   // nothing: the host's own allow rules apply and are not mirrored
    "deny":  ["ListAgents", /* <read rules for the host-private names, edit rules for Claude Code's configuration,
                               the profile's deny rules> */],
    "disableBypassPermissionsMode": "disable",
    "defaultMode": "<the same mode as the flag>"
  },
  "hooks": {
    "PreToolUse": [ { "matcher": "*", "hooks": [ /* THE TOOL GATE: { "type": "command", "command": "<smurg>", "args": ["hook"], "timeout": 10 } */ ] },
                    { "matcher": "Bash", "hooks": [ /* the Bash activity hook: args ["hook", "bash-activity"], timeout 5 */ ] } ]
    /* PostToolUse, PostToolUseFailure (matcher Edit|Write|MultiEdit|NotebookEdit, and the Bash group),
       PermissionRequest (the edit tools), UserPromptSubmit, Stop, SessionStart, SessionEnd, FileChanged */
  }
}
```

The `--settings` file ranks above user, project and local settings, so a `disableAllHooks` or an
`env.CLAUDE_CODE_SIMPLE` planted elsewhere cannot switch the gate off (§11 D-1). `FileChanged` is registered for the
activity feed only (its matcher: at most 50 plain top-level file names of the session root); correctness never
depends on it. The Bash group exists only with `config.activity.attributeBashEdits` (default true; §11 D-13). What
the hooks do: §7.7. `mcp.json` names one server, `smurg` (`<smurg> mcp`, stdio).

**How a file rule is written.** The settings file is not in the project. In such a file a rule written
`Edit(/specs/x/SPEC.md)` matches nothing of the project: an allow does not approve and a deny does not deny
(verified, `claude-structured.md` §5.3). Every file rule is therefore written in the absolute form
`<Tool>(//<realpath of the session's root>/<pattern>)`, built by ONE function, `fileRule(tool, rootRealPath,
relPattern)` (`profiles.ts`). The root is a folder name of the host's and is written so that Claude Code reads it as
that folder (each case run against 2.1.288): `(` and `)` need nothing; `[` and `]` are escaped (unescaped they open
a character class and every rule of the folder matches nothing); `*`, `?`, `{`, `}`, `!` and a space stand for
themselves. A root with a backslash or a control character in its path cannot be named by a rule (`RulePathError`):
an agent session is refused there before anything of it exists, with `session.folderNotNameable` (`conflict`,
reason `folder-name`); files and terminals of such a folder work. The pattern is smurg's own: one with `(`, `)`, a
backslash or a control character is a programming error, so no rule text can end a rule early. Written this way a
deny rule stops the edit tools, hides the file from Grep, and refuses shell commands that name the file
(`cat .envrc`, `echo x >> PLAN.md`).

**Profiles** (`profiles.ts`, pure: purpose, mode, root, topic, rules, trust, the MCP switch → `LaunchProfile`). What
a session may do is decided in this order: the **tool gate** (§7.7: smurg's own code, runs first, binds always), then
Claude Code's **tool list and rules** written here, then a **permission request** that reaches the daemon and
becomes a card or an answer of the daemon's own (§5.9).

| Session | `permissionMode` on the wire | Claude Code's mode | `--tools` | Rules besides the common ones | A request that reaches the daemon |
|---|---|---|---|---|---|
| Discussion (fixed: `modeFixed`) | reads `ask-all` | `default` | `Read, Glob, Grep, Edit, Write, AskUserQuestion` | allow `Edit` of its topic's `SPEC.md` and `PLAN.md` | `AskUserQuestion` → a question card; anything else → denied by the daemon at once with a fixed English sentence, no card (the gate has refused it before: this is the second layer) |
| Work item (always in its own worktree) | `ask-commands` | `acceptEdits` | `EXECUTION_TOOLS` | deny `Edit` of its topic's `SPEC.md` and `PLAN.md`; allow the remembered rules of the session and of its topic | a question card, or a permission card |
| Any session but a discussion, stricter | `ask-all` | `default` | `EXECUTION_TOOLS` | as its row | cards |
| Free session in a worktree | `ask-commands` (its default) | `acceptEdits` | `EXECUTION_TOOLS` | the session's remembered rules | cards |
| Free session in the main workspace | `ask-all` (its default) | `default` | `EXECUTION_TOOLS` | the session's remembered rules | cards |
| Free session in the main workspace, set to `ask-commands` | `ask-commands` | **`default`** | `EXECUTION_TOOLS` | the session's remembered rules | a request of an edit tool is allowed by the daemon itself, after the host-only check and the lock (§7.5); everything else → cards |

- `EXECUTION_TOOLS` is one constant for the verified Claude Code version: `Read, Glob, Grep, Edit, Write,
  NotebookEdit, Bash, TaskStop, WebFetch, WebSearch, AskUserQuestion` (2.1.288 has no `MultiEdit`, `BashOutput`,
  `KillShell` or `TodoWrite`; `TaskStop` is its name for stopping a background command; a test with the real binary
  pins the list). A tool of a future Claude Code does nothing in smurg until a release lists it: the gate refuses
  what is not listed.
- **No subagents.** `Task` is in no tool list, so Claude Code does not offer it, and the gate refuses it under both
  of its names (Claude Code offers the tool as `Task` and names it `Agent` to its hooks). A subagent runs with what
  its DEFINITION says (the project's `.claude/agents/*.md`, the host's `~/.claude/agents`), not with what smurg set
  for the session: a definition with `permissionMode: acceptEdits` made edits and file commands run without a
  request in a session started in `default` (seen with 2.1.288), and a definition can carry hooks and MCP servers of
  its own. A permission mode Claude Code reports that smurg did not set is set back (`checkMode`). The wire keeps
  the verb `task` and `parentToolUseId`; nothing produces them (§12).
- **A session rooted in the main workspace never runs in `acceptEdits`.** In that mode the shell writes inside the
  working directory unasked (`rm`, `mv`, a redirect), and such writes pass neither smurg's lock nor its host-only
  check; in a worktree the merge review catches them, in the main workspace nothing would. There `ask-commands`
  means: the edit tools are allowed by the daemon without a card, every shell write asks.
- Common deny rules of every profile, generated from `schema/paths.ts` so the lists cannot drift
  (`AGENT_READ_DENY_PATTERNS`, `AGENT_EDIT_DENY_PATTERNS`): `Read` of the host-private names (`.envrc`, `.git/**`,
  `.claude/settings.local.json`, `CLAUDE.local.md`, at the root and at any depth) and `Edit` of Claude Code's own
  configuration (`.claude/**`, `.git/**`, `.mcp.json`, at the root and at any depth). Deny rules bind in every mode.
  The read rule for `.git` leaves an agent's own `git status` / `git diff` / `git log` alone and refuses `cat
  .git/HEAD` (verified). No agent session writes Claude Code's configuration: the host edits those files in their
  own editor.
- What `acceptEdits` means in practice (verified): Edit / Write inside the worktree run; so do read-only commands and
  simple file commands inside it (`ls`, `cat`, `mkdir`, `touch`, `mv`, `cp`, a redirect into the worktree).
  Everything else asks: other commands, network tools, any write outside the worktree, any write to `.claude/**` or
  `.git/**`.
- `session.mode.set` (not for a discussion): the control request `set_permission_mode` for the running process, the
  record for the next start. There is no "asks for nothing" mode.
- **Always allow this kind** (§5.9 "Remembered rules"). Session scope: the rule is stored in the session's record,
  given to the running process with the decision (`updatedPermissions`, destination `session`), and written into
  `permissions.allow` at every later start. Topic scope: stored on the topic; sessions of the topic started later
  get it in their settings file; a session that already runs gets it the first time one of its own requests carries
  exactly that rule as Claude Code's ONLY suggestion and is itself one plain command of that kind, or a URL of that
  host of at most 2,048 characters (`ruleCoversRequest`, §5.9): the daemon then answers that request itself with
  allow and the rule; for anything else a person is asked. The
  suggestion says which rule a click would add, not that the rule covers everything the request runs, so a compound
  command is never answered this way. Claude Code's own suggestion targets `localSettings`, which
  would write `.claude/settings.local.json` into the shared project: the daemon never echoes it. Removing a rule
  restarts the affected processes without it at their next idle moment and says so in a line.

**The record** (`sessions/agent/store.ts`, `agent-sessions.json`; never on the wire) keeps what a later process start
needs: purpose, topic and item, `openedBy`, the daemon-internal owner (whose identity the agent's file locks use;
passes to the host at a handover), `pathRights` (fixed at creation, §3), the responsible person and the fallback
decider, root and worktree, the mode and who loosened it, the remembered rules, `claudeSessionId` (Claude Code's own
conversation id, NOT smurg's session id), `hasConversation`, the turn counter, the tag of smurg's own header (§5.9),
consecutive start failures, `lastTurnOpen` (a turn started and no end was recorded), `pending` (the messages no turn
has taken yet, oldest first, each as it is written to the process; at most `PENDING_MESSAGES_MAX`, 200, per
session), and the state `live` / `failed` / `ended`. The role prompt is `role.md` beside the transcript: stored
once, sent byte for byte at every start, so a smurg upgrade or a renamed topic cannot give a running session a
different prompt.

**Runner** (`agent-runner.ts`: one session's process side; the wire's `AgentSession.status` is derived from it):

```
            start                          turn starts                      result
 (record) ────────▶ starting ──ready──▶ idle ───────────▶ running ─────────────────▶ idle
                        │                 │ ▲                │  ▲                        │
                        │ fails           │ │ next message   │  │ answered / decided     │ idle for parkAfterMs, no open request;
                        ▼                 ▼ │ (--resume)     ▼  │                        ▼ over the memory mark; the slot is needed
                     failed            parked            waiting-answer /              parked   (no process; status stays `idle`)
                        ▲ │                              waiting-permission
   process dies ────────┘ └──next message / "Try again"──▶ starting (--resume or --session-id)
 any state ──end / terminate / archived / worktree removed / merged──▶ ended      (the only state nothing leaves)
```

- **Start and resume.** `--session-id <claudeSessionId>` while `hasConversation` is false, `--resume` once it is
  true (set at the first `result`). Claude Code refuses both wrong combinations ("No conversation found" / "already
  in use"), so the flag comes from the record, never from a guess, and the two refusals are handled: a resume that
  finds no conversation (Claude Code removed its own transcript) gets a new `claudeSessionId`, the line
  `session.resume.lost` and the fixed message `conversation-lost` (§7.8); a first start that is told "already in
  use" (the process died in its first turn) is resumed, once.
- **A message while a turn runs** is written to stdin at once; Claude Code folds it into the running turn at its next
  tool boundary. The log gets `delivery` events (`queued`, `started`, `completed`, `cancelled`). A message for a
  session without a process (parked, failed) is queued in the runner, starts the process, and is written after
  `initialize`; a message the process had not started when it went away is queued again. What waits is kept in the
  record (`pending`), so it still waits after a stop or a death of the daemon: nothing starts by itself then, and
  the message is delivered, in order, when the session next starts (the next message, "Try again").
- **Stop** (`session.interrupt`): the control request `interrupt`; the turn ends at once with outcome `interrupted`,
  the process stays; Claude Code withdraws its open requests and their cards are withdrawn (`stopped`).
- **End**: interrupt, close stdin, wait up to 5 s for the exit, then killTree ("Ending a session"), ALWAYS: also
  when Claude Code went by itself (it does, as soon as its input closes) and when the session has no process any
  more (parked). What the agent's commands started and left running (a dev server, a watcher) ends with the
  session, as a terminal's does. Status `ended`; the transcript stays readable; a message is refused from then on.
- **Parking**: only when idle with no open request: close stdin, expect the exit; nothing else is ended (what the
  agent's commands left running goes on, and its processes stay remembered for the End). After `parkAfterMs` (10
  min) idle;
  at the next idle moment when the process's resident memory is above `parkAboveRssBytes` (400 MiB, measured after
  every turn with `ps -o rss=`); when a start needs room (below); when a rule, the project settings' trust or a
  member asks for a restart of the process (`restartProcess`: `rules`, `project-settings`, `host`, `asked`, `slot`).
  Parking changes nothing on the wire (`idle` stays `idle`); the bus says `agent.process`. A resume costs about
  200 ms and keeps the request prefix, so the prompt cache is not lost.
- **Exit classification.** The runner records why it expects an exit (park, restart, end, stop). Any other exit is a
  failure: status `failed`, the notice `notice.processExited` with the exit code and the action `retry`, open
  requests withdrawn (`failed`), the turn closed with outcome `error`.
- **Failed is not final.** The next message, or "Try again" (`session.retry`), starts the session again as in "Start
  and resume"; the conversation continues. After three consecutive failed starts only the host may retry
  (`retryHostOnly`): the cause is then on the host's computer.
- **Refusals before a spawn** (the start is refused with its own sentence; a session that already exists becomes
  `failed` with it): no `claude` on the host (`session.claudeNotFound`), a Claude Code older than the floor
  (`session.claude.tooOld`), the host logged out (`session.claude.notLoggedIn`), a limit ("Limits"), a folder whose
  path no permission rule can name (`session.folderNotNameable`, "How a file rule is written"), a worktree that is
  gone (`ended`, `worktree-removed`). A worktree that was MADE for a session whose start is then refused is removed
  again (it holds nothing); a kept worktree the member wanted to continue in stays kept.

**Normalised events** (`normalise.ts`, `tool-view.ts`, both pure). The wire never carries Claude Code's own shapes:
every line it prints becomes a `RunnerEvent`, and the runner turns those into smurg's own closed set of conversation
events, cards and bus events (§5.9, §7.3). A line of a kind smurg does not know is ignored; a line that is not JSON
is logged once per session with its first 200 characters. A test replays the lines recorded from 2.1.288 through the
normaliser and the real runner and validates every resulting event against the registry.

| Claude Code line | Result |
|---|---|
| `system/init` (every turn) | the first: bus `agent.ready` (version, login, tools); each one while no turn is open: `turn.started` (smurg numbers turns itself) |
| `stream_event` text delta | `session.delta` (coalesced at `DELTA_COALESCE_MS`, volatile, never stored, only to live watchers); a thinking delta: a delta without text |
| `assistant` text block | a `text` event (clipped at `EVENT_TEXT_MAX_BYTES`; `aborted` when a stop cut it). A synthetic block that says the host is not logged in: the notice `notice.notLoggedIn` |
| `assistant` thinking block | nothing |
| `assistant` tool_use | `tool.started` with a `ToolView`; for the verbs `run`, `fetch` and `other` also the audit entry `agent.command` |
| `user` tool_result | `tool.finished` with a `ToolResultView` |
| `user` with `isReplay`, `command_lifecycle` | `delivery` for our message |
| `control_request` `can_use_tool`, tool `AskUserQuestion` | bus `agent.request` (a question; one the wire cannot carry is refused towards the agent, never clipped) |
| `control_request` `can_use_tool`, any other tool | bus `agent.request` (a permission request, with the `ToolView` of the same call) |
| `control_request` of another subtype | answered with an error at once (the CLI must not wait) |
| `control_cancel_request` | bus `agent.request.withdrawn` |
| `system/api_retry` | the notice `notice.apiRetry`, or `notice.authRejected` for a rejected login |
| `rate_limit_event` that is not `allowed` | the workspace's account state `usage-limit`; at most one notice per session |
| `system/status` `compacting` … `compact_boundary` | `AgentSession.doing = 'compacting'`, then the notice `notice.compacted` |
| `result` | `turn.finished` (outcome from its subtype and `terminal_reason`); sets `hasConversation` |

`ToolView` (what a tool card shows; the permission card of the same call shows the same view, §5.9): a read has its
path and NO body (file contents are never stored or sent); an edit its path and a unified diff; a command the
command whole (never shortened on a card) and the first 64 KiB and last 16 KiB of its output with the exit code; a
search its pattern, the number of matches and at most 200 file names, never matched lines and never a host-private
name; a fetch its URL and the first 16 KiB; a tool of smurg's MCP server its text answer. The verb `task` (a
subagent's call, its description as the target) and `parentToolUseId` (the events of a subagent) are carried through
when Claude Code sends them; no session has the tool ("Profiles" above), so none does. `mask()` runs over every text
that came from an agent or a tool before it is stored or sent; what a view NAMES (`target`, a search's file names)
has every character nobody can see written out as `<U+XXXX>` instead (§5.9 "Characters nobody can see"). The view
of a permission request is built from the input the REQUEST carries, which is what would run: a `PreToolUse` hook of
the host's own settings may have rewritten the model's input (`updatedInput`). A `file` and a body are attached only
when the path resolves inside a root (`PathGuard.toFileRef`) and is not host-private; a path outside every root is
`outside: true` with no path and no body (the host reads the real path on the permission card and in the audit log).

**Transcript** (`transcript.ts`; files: §7.1). Append-only segments of `{ v: 1, seq, at, kind, … }` lines, a new
file at 8 MiB, written through one serialized writer per session (buffered up to 50 ms or 64 KiB; `fsync` at every
`turn.finished` and every card event). `seq` starts at 1 and never repeats. Reading is THE page rule of §4.3
(`session.watch`, `session.history`: at most `EVENTS_PAGE_MAX` events and `EVENTS_PAGE_MAX_BYTES`, the newest page
for a watcher more than `EVENTS_CATCH_UP_MAX` behind). Live events go to watchers in batches (the batch rule).
Redaction rewrites the one segment atomically with the event replaced under its `seq`; trimming unlinks whole
segments (§7.1). Watchers are keyed by the logical channel.

**Trust gate** (`project-settings.ts`, service `projectTrust`; §2 rule 9, §11 D-18). What is trusted is a CONTENT.
A root has up to four entries: the three files `.claude/settings.json`, `.claude/settings.local.json` and
`.mcp.json`, each with its own SHA-256, and the entry `.claude` (`PROJECT_LOADED_ENTRY`) for everything else Claude
Code loads from the folder's `.claude/`: agents, skills, commands, rules, every file below it except the two settings
files and Claude Code's own `worktrees/`. Such a file can declare hooks, allowed tools and a permission mode in its
own header. An entry is trusted together with the scripts its commands name inside the root (each recorded with its
own hash). A root is `used` when every entry that exists has a trusted content and every recorded script still has
its recorded content; `none` when no entry exists; otherwise `ignored`, so a folder that has only an agent or a
skill below `.claude/` and no settings file is `ignored` until the host confirms it. A decision is keyed by path and
content hash, not by root (for the `.claude` entry per file: its path, its hash and the scripts its header's hooks
run): a work item's worktree is a clone, its committed files hash like the main workspace's and the host's
uncommitted `settings.local.json` is simply absent there, so a worktree needs no confirmation of its own.

- **What the host sees before confirming** (`admin.claudeConfig.get`, §5.8): everything the entries do, read from
  the files: every command they run (hooks, MCP servers, `apiKeyHelper`, the status line), every permission rule,
  every environment variable, the names of every other key, the scripts, and the raw file. A variable that can send
  the host's login to another server is flagged; one that changes which programs run (`PATH`, `NODE_OPTIONS`,
  `BASH_ENV`, `GIT_*`, `LD_*`, `DYLD_*`, `PYTHONPATH`, `NPM_CONFIG_*` and their kind: `isProgramEnvName`) is marked
  so, its value stands among the commands (`env NODE_OPTIONS: …`), and a file of the folder that value names is
  recorded as a script. For the `.claude` entry: every file by name, the list of all of them with their hashes, and
  what their headers declare (hooks, allowed tools, a permission mode). A header (the block between the two `---`
  lines) is read line by line, not as YAML (`headerEffectsOf`), and it is cut into lines at every character that
  ends a line for some reader: LF, CRLF, a lone CR, U+2028 and U+2029, so no key stands unseen behind one of them
  and a line costs its length to read. Characters nobody can see are written out (`<U+202E>`). The lists show
  everything or say what is missing: entries left out or cut short are counted (`cut`), and "Use them" then needs
  the tick `incomplete` ("The lists above do not show everything. I have read the files themselves."). A content
  that redirects credentials or allows tools needs its own tick (`acknowledged`); a decision names the entries by
  hash and is refused when a hash is no longer the entry's.
- **The scripts.** Every existing file of the root that a word of a command names is a script of the entry, whatever
  the program does with it (`tsc -p tsconfig.json` records `tsconfig.json`). A file is found however the command
  spells the folder: `$CLAUDE_PROJECT_DIR/x.sh`, `"${CLAUDE_PROJECT_DIR}"/x.sh`, `${CLAUDE_PROJECT_DIR:-.}/…`,
  `"$PWD"/…`, `~/…`, `$HOME/…`, quoted words and arguments with spaces, after `cd x && ./y` and `(cd x; sh y)`, and
  behind a substitution or a variable in front of a path (`$(git rev-parse --show-toplevel)/scripts/x.sh`). It is
  recorded under the name the FILE SYSTEM gives it (the stored case and normalisation; through a link, the link's
  path and the file it leads to), so the watch, PathGuard and the tool gate all name the file that runs. A path a
  command names where NO FILE IS YET (`[ -x scripts/optional.sh ] && …`, `node dist/hooks/check.js` before a build)
  is recorded as "named, not there yet" (`scripts[].absent`): guarded and watched like a script, and the file
  appearing there is a change of the confirmed content, so a hook that runs a build output asks the host again after
  each build that creates it (the web's review marks such a script with those words and says under the list that a
  file that appears there asks the host again: `claudeConfig.script.absent`, `claudeConfig.scripts.absentNote`). A
  word names a path when it is written with an anchor (`./x`, `../x`, an absolute path, after
  `$CLAUDE_PROJECT_DIR/`), is a relative path of plain names (`scripts/optional.sh`), or is a bare file name with a
  script's extension (`later.sh`, `tool.py`); a quoted pattern handed to a tool (`prettier --check
  "$CLAUDE_PROJECT_DIR/src/**/*.ts"`) names no file. A script's name may hold `( ) [ ] { } * ?` and blanks.
- **What smurg cannot follow** (`cannotFollow`). A command whose program, or the script an interpreter is given, is
  a variable, a substitution or a wildcard (`sh "$SCRIPT"`, `"$TOOL" --check`), an `eval` of such a text, a `cd` to
  such a place, or a line the reader cannot take apart, runs a file smurg cannot name and so cannot guard. So does
  a command that takes more reading than its length is worth: following has a budget per command
  (`FOLLOW_STEPS_MIN`, 20,000 steps, plus `FOLLOW_STEPS_PER_CHAR`, 8, per character; every look at a list of words
  costs the list's length and one more step for each 64 characters of a word, every text handed to another shell
  or an `eval` its length), because a wrapper in front of a wrapper (`env`, `sudo`, `nice`, `timeout`, `command`,
  `exec`, `nohup`, `xargs` …) is looked at twice and an `eval` reads everything behind it again. Sixteen wrappers
  in a row are followed, a seventeenth is not, fewer in front of a very long word (twelve in front of a word of
  64,000 letters), and neither is an `eval` or a `sh -c` more than three inside each other. No command people
  write is built that way, and without the budget one such line holds the daemon for minutes. The review says
  under a command it cannot follow that only the listed scripts are guarded (`UNFOLLOWED_NOTE`: "^ smurg cannot
  follow which files the command above runs …: only the scripts listed for this entry are guarded"), the entry
  carries `unfollowed` (the web's review counts these commands in the warning above the lists,
  `claudeConfig.unfollowed`), and "Use them" needs the tick `incomplete`. Arguments that are data (`prettier
  --write "$file"`) need no tick.
- **Never trusted.** An entry smurg cannot vouch for is one nobody can confirm: its first line under "Other
  settings" (`otherKeys`) says why, and a decision to use it is refused with `claudeConfig.cannotConfirm`. That is:
  a settings file that is a link, larger than 256 KiB, unreadable or not text; a link or a special file below
  `.claude/`, or more than 2,000 files or 64 MiB there; more than `CLAUDE_CONFIG_SCRIPTS_MAX` (20) scripts; a script
  larger than 64 MiB or unreadable; more than `SCRIPT_CANDIDATES_MAX` (2,000) distinct words in the entry's commands;
  a named path smurg cannot look at (a link that loops, no permission); and a script, or a path that is not there
  and is written with an anchor, whose name has a backslash or a control character.
- **What a session does.** `used`: it starts normally. `ignored`: it starts with `--setting-sources user`, which
  drops the project's settings and, as Claude Code works, the project's `CLAUDE.md` and skills; the conversation
  gets the notice `session.projectSettings.untrusted` with the action `restart-agent`. smurg's own `--settings`
  hooks and its MCP server keep working with that flag (verified). A decision applies at a session's next process
  start: when the host decides, the sessions of that root give up their process at their next idle moment (at once
  when idle) and the next message starts them with the new decision; a member with agent access can ask for the
  same per session (`session.restart`). While the folder's settings are still not confirmed that request is refused
  (`conflict`, `claudeConfig.confirmNeeded`): a restart would change nothing. The sessions of a root in use start
  again the same way when the set of its recorded scripts changes.
- **While sessions run.** Claude Code loads a changed project settings file into running sessions at once. The
  daemon therefore watches the entries and the recorded paths of its roots (bus `file.changed`; a changed FOLDER
  that holds one of them counts, because a renamed or replaced folder is reported as the folder alone) and looks at
  the main folder right after a merge into it. Whenever a look at the files finds a content that is not confirmed,
  whoever looked (the watcher, a session start, the host opening the review, a merge), it interrupts and parks the
  sessions of that root that loaded the settings (`parkRoot`, line `session.projectSettings.changed`), and they
  continue without the settings at their next message until the host looks again (the attention item
  `project-settings`, §7.9).
- **Who can change a confirmed content.** Through `file.*`, `doc.*` and uploads only the host: the entries are
  host-only paths, and so is every recorded path, what lies below it and a folder above it (§7.4). No agent's edit
  tool writes them (the tool gate's G3, at a recorded path and below it), and the deny rules of every profile refuse
  a shell command that names `.claude/**` or `.mcp.json`. No rule names a script: an agent's shell command that
  writes where a recorded script is, or that the gate cannot follow, asks a PERSON first, whatever mode and allow
  rules would have let it run (G10, §7.7). A merge request that is not the host's, and a work item's change, are
  refused when they change a recorded path, like one that carries host-only paths (§5.7). What a program does that
  names none of this is not seen before it runs (§12).
- **When it is asked.** Before the first session, not after it: the New topic dialog holds the confirmation when the
  host creates a topic in an undecided folder; another member's dialog says that agents will run without the
  project's `CLAUDE.md` until the host confirms (`session.host.get`, §5.5).

**The host's own Claude Code** (`host-rules.ts`, service `hostRules`; §2 rule 10, OWNER-DECISIONS Q7).

- **Allow rules apply.** Every agent session runs as the host with the host's `~/.claude/settings.json`: what those
  rules allow, Claude Code runs without sending a permission request, and smurg does not ask for it either. Nothing
  is mirrored into `permissions.ask`. At every process start the runner asks `list_permission_rules` and reports the
  allow rules whose source is the host's (user, project, local or managed settings; not smurg's own settings file).
  Which rules a process sees depends on where it runs: a worktree is a clone without the host's
  `.claude/settings.local.json`, and a root whose project settings are not confirmed starts with the user's
  settings only. So the document `host-rules` (`host-rules.json`) keeps the last report of each kind of root (`main`,
  `worktree`), and the workspace's rules are their union. The host is told about each RULE once (`told`): only a rule
  the host was never told about puts the attention item `host-rules` back and sends one notification, whichever root
  reports it and however often sessions of different roots take turns. It is information, no decision
  (`admin.hostRules.get` shows the list, `admin.hostRules.seen` clears the item). The rules themselves, masked, are
  readable by the host and members with `session.drive` (`session.rules.get`); other members learn only that some
  apply. A Claude Code without that control request reports nothing. Every command that ran without a card is in
  the audit log with why (`agent.command`).
- **What still binds.** The tool gate and the deny rules of the profile outrank the host's allow rules (verified
  with a host settings file that allows everything, `claude-structured.md` §5): a discussion agent still has no
  shell and writes only its two files, no agent writes Claude Code's configuration, and an orphaned agent runs no
  tool.
- **MCP servers, connectors, plugins.** The host's user-level MCP servers and the project's `.mcp.json` servers
  would be offered to every agent session (`--tools` does not remove MCP tools). Sessions therefore start with
  `--strict-mcp-config`: only smurg's own server exists. A discussion session always does. For work items and free
  sessions the host setting `agentMcp` ("Agents may use my own and this project's MCP servers", default off) removes
  the flag: those tools then pass the gate (`mcp__*` in the registration's tool list), are shown as `other`, and
  their requests are cards with the whole input; the project's servers additionally need the trust gate. Changing
  the setting restarts the processes of those sessions at their next idle moment.
- `crossSessionInbound: "refuse"` and the deny rule for `ListAgents` keep a session from the host's OTHER Claude
  Code sessions on the machine; `SendMessage` is in no tool list, so the gate refuses it.

**Login and the account.** `claude auth status --json` in the exact session environment decides `login` before a
start (at most once a minute per daemon; logged out: the start is refused) and for "Check login again"
(`session.loginStatus`). It is run in the daemon's own state directory until the main folder's project settings are
`used`, and in the main folder afterwards: Claude Code answers from the settings of the folder it is asked in and
counts a project's `apiKeyHelper` as a login (it does not run it; measured on 2.1.288), so a folder nobody confirmed
must not make a logged-out host look logged in. In a session, `initialize` reporting no key, no token and no
subscription on Anthropic's own API, the synthetic "Not logged in" message, or an API retry for a rejected login set
`login: 'logged-out'`. There is ONE account state per workspace (`ok`, `logged-out`, `usage-limit` with the reset
time when Claude Code reports one): members read it with `session.host.get` / `session.host`, and while it is not
`ok` the host has one attention item (`account`). When `initialize` reports a personal subscription
(`account.subscriptionType` names Pro or Max and neither Team nor Enterprise: Claude Code reports `Claude Pro`,
`Claude Max`) while the workspace has members besides the host, the host alone is told
(`notice.personalSubscription`), ONCE PER WORKSPACE: that it reached the host is remembered in the `host-rules`
document (`notices`), so a restart of the daemon does not repeat it, and a host who has no window open gets it at
their next connection. Whose account pays, and what its terms say about sharing it, is the host's to decide (§12).
There is no per-member login (§11 D-15).

**Limits.**

| Limit | Default | Meaning |
|---|---|---|
| `maxLiveAgents` (host setting, §5.8) | `min(8, max(2, floor(RAM / 3 GiB)))`, range 2–32 | processes of WORK ITEMS the scheduler may keep alive at once (§7.8 "Execution"). Enforced by the scheduler and nowhere else: a person's message always gets a process |
| `maxAgentProcesses` | 32 | every `claude` child of this daemon; beyond it the longest-idle session is parked first, and a start that still finds no room is refused (`session.limit.processes`) |
| `maxAgentSessions` | 200 | agent session records that are not ended, per workspace (`session.limit.agents`) |
| `parkAfterMs` / `parkAboveRssBytes` | 10 min / 400 MiB | when an idle session gives up its process |
| terminals | 8 running per member, 64 in total | `SessionLimits`; they do not count agent sessions |

Measured on 2.1.288 (`claude-structured.md` §9): a fresh idle agent is about 210 MB plus 53 MB for its `smurg mcp`
process; after 300 turns the `claude` process alone is 420–600 MB; after park and resume 243–288 MB.

**Restart** (§11 D-16; AD-10 of the design). A stop of the daemon (`smurg stop`, Ctrl-C) ends every agent's process
as in "End", but the records stay: a turn that was running gets `turn.finished{interrupted}` and the line
`conversation.interrupted.restart`, and a message that waited for a turn still waits (`pending`, "The record"). At
the next start every record that was not `ended` is an idle session without a process; the conversation module
withdraws the cards that were still open (`restarted`); nothing is restarted by itself and every plan with armed or
interrupted items is paused until a member with agent access continues it (§7.8). The next message starts a process
with `--resume`, and what waited is delivered first, in order.

When the daemon DIES, its children are orphans. Their next tool call, whatever the tool, is refused by the tool
gate, which fails closed when the daemon does not answer (§7.7 G1), so no command runs unattended; an orphan can at
most receive more model text until its turn ends, then it exits. The next start ends what is left through the live
list (identity-checked, "Ending a session"), and a record with `lastTurnOpen` gets the notice `notice.unattended`
("the agent may have gone on for a moment after smurg stopped; check its changes"); a work item's session is then
`stalled` (`restart`).

**Claude Code version (§11 D-23).** Every session runs the host's own `claude`, and smurg never passes `--model`.
What smurg relies on is the structured mode, its hook setup and the behaviour of permission rules, and that is
verified end to end on ONE version: `claudeMinVersion` is **2.1.288** and `claudeVerifiedVersions` is `[2.1.288]`
(`core/config.ts`). Before an agent session starts, the daemon runs `--version` of the `claude` it will launch
(`claudeVersionVerdict()`):

- older than 2.1.288 → the agent session is **refused** before the spawn (`session.claude.tooOld`; the host is
  notified once). One security property holds only from there: a read deny rule hides a file from Grep on 2.1.288
  and not on 2.1.220 (`claude-structured.md` §5).
- newer than the newest verified version, or output that does not start with a plain `MAJOR.MINOR.PATCH` → the
  session starts, and the host is told once (`notify.claudeVersionUnverified`): Claude Code updates itself, and an
  update must not lock anyone out. What protects a session on such a version is the explicit tool list, the
  tolerant normaliser and the fail-closed fallbacks above.
- Terminals are not affected (they do not start `claude`).

Adding a version to the verified list means running the real-Claude suites on it (mock Anthropic API only, §0, §10).

**Session environment** (`sessions/host-env.ts`) — the host's own, minus variables injected by a parent Claude
session (scrubbed by prefix: `CLAUDECODE`, `AI_AGENT`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_*`,
`CLAUDE_PREVIEW_*`, `CLAUDE_CODE_*` except the host's provider variables; always drop `CLAUDE_CODE_SAFE_MODE` and
`CLAUDE_CODE_SIMPLE`) and minus every `SMURG_*` (a daemon started inside another session must not pass its identity
on); then `HOME`, `TERM`, `COLORTERM`, `SMURG_SESSION_ID` and, for agent sessions, the hook's `SMURG_HOOK_SOCKET` /
`SMURG_SESSION_TOKEN`. The host's own login and provider settings (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_*`, …)
stay: every session uses them.

**PTY** (terminal sessions only). One `PtySession` per PTY, `encoding: null`, output coalesced (5 ms / 64 KiB) and
addressed by absolute byte offset; fan-out to a daemon-side `@xterm/headless` mirror (5000 lines), a 2 MiB raw tail
and every attached viewer. Re-attach = mirror snapshot (full scrollback) taken inside `term.write('', cb)`, then the
raw gap, then live. The snapshot keeps as much scrollback as fits the attach payload: two small trial serializations
estimate it, then at most 3 bounded passes, and an unchanged terminal reuses the last snapshot (~360 ms for the first
attach of a 31 MB colourful history, ~60 ms after). Flow control: the PTY is paused while any ready viewer's
connection has more than 1 MiB queued (`bufferedAmount`, which is the shared host uplink for relay clients) and
resumes below 256 KiB, next to the mirror's own 1 MiB lag limit, so one chatty terminal can no longer hold every
member's traffic behind tens of megabytes. Local attach reports 0. Input from every holder of `session.drive` (the
host, "Agent access"), into any terminal; resize only from the member who opened it: the PTY size follows the
opener's most recently active client; everyone else, the other members who type included, renders at the PTY size.
The daemon mirror is the only responder to terminal queries: web viewers register the full set of swallow-handlers
and `smurg attach` strips queries and OSC 52 from the output stream.

**Ending a session.** Who may: §3 (`session.end`, `admin.session.terminate`). `killTree`, for a terminal's PTY
child and for an agent's `claude` child alike: the child's process group + descendants found by walking `ppid` +
same-uid processes whose environment carries this session's exact `SMURG_SESSION_ID`; `SIGSTOP`, re-scan, `SIGKILL`,
in rounds (measured < 1 s). The §0 rule applies: nothing is signalled that is not positively tied to the session.
There is **no** system-wide sweep (§11, D-3). As built, because macOS hands out freed pids again within
milliseconds: every target is identified by pid + start time + full command line (the env-marker scan is bound to
the same identity); the root counts only while it is still the daemon's own child and not another session's child
or a helper; one scan only ever sends `SIGSTOP`, `SIGKILL` goes only to the frozen tree a second scan confirms, and
a pid whose identity changed gets `SIGCONT` at once. Every session's descendants are remembered every 2 s (and
recorded in the live list, §7.1). For an agent session the kill reaches what its commands started and left running
(a dev server, a watcher): each shell command of an agent runs in a shell of its own, so a `&` job is orphaned at
once and has no parent link; it is found by the session's id in its environment, or among the descendants the scan
remembered (kept while the session is parked), each checked against its recorded identity before it is signalled.
That happens when the session ENDS (End, a kick or a role change of its opener, an archive) and at `smurg stop` for
every session that had a process in this run; parking and a failed process end nothing. What it does not find:
§11 D-3. When a terminal ANOTHER member opened exits by itself (`exit`), its leftovers (a
`nohup … &`) are killed too, so that removing that member later ends everything they started; the host's own
background jobs are theirs to keep, as in any terminal. A member who is kicked, leaves (`channel.leave`, §11 D-9) or
loses "Agent access": `SessionManager.teardownUser` (§3 "When a member goes") ends their terminals and free agent
sessions, each audited `session.terminate` by the system with `detail.reason` `kicked` / `left` / `role-changed`
(`endReason` the same), and hands the sessions of their topics to the host (`AgentSessions.setOwner`,
`HookServer.reassignSession`, a work item's worktree with it; stopped first after a kick; `pathRights` never
raised; §11 D-17); R2's 3 s and R4's 5 s bound the whole teardown. `smurg stop` ends every terminal and every
agent's process ("Restart").

**After the end.** An ended TERMINAL (`status: 'exited'`, with `endReason` / `endedBy`) stays in `session.list`,
with its mirror for late viewers (≈17 MiB each), for 15 minutes (`SessionLimits.exitedRetentionMs`) and at most 32
ended terminals at a time (the one that ended first goes first); then the daemon forgets it, without a message (a
client learns it from its next `session.list`). An ended AGENT session keeps its record and its transcript: a
topic's sessions for as long as the topic exists (earlier discussions and earlier attempts stay readable through
`session.list { topicId }`), a free session's for 30 days (§7.1).

**Launch inputs are configuration, never ambient** (`config.sessions`, `config.agents`, `core/config.ts`):
- `hostHome`: the host's home, every session's `HOME`. `createDaemon` fills it from its `homeDir` option (default
  `os.homedir()`); tests pass a temporary fake home, so a session never reads the developer's rc files or `~/.ssh` in
  a test.
- `claudePath` (default: looked up on PATH at session start), `claudeMinVersion` and `claudeVerifiedVersions`
  ("Claude Code version" above).
- `selfCommand: { file, args }`: how a session runs `smurg hook` / `smurg mcp` (the daemon cannot import the CLI):
  the CLI passes `process.execPath` + `[<cli>/src/main.ts]` in dev and the SEA binary in production. Without it the
  hooks module refuses to write launch files and no agent session starts.
- `config.agents` (`AgentsConfig`): the limits and timers above, the transcript sizes of §7.1, and
  `escalationSweepMs` (§7.9).
- The sessions module's test seams (`SessionsModuleOptions`: `hostEnv`, `hostShell`, `launch`, …) replace the host's
  environment in tests: the stand-in `claude` (§10), or the real binary with a mock Anthropic API through
  `ANTHROPIC_BASE_URL` and an isolated `CLAUDE_CONFIG_DIR`.
- `config.activity.attributeBashEdits` (default true, `ActivityConfig` in `core/config.ts`): the Bash activity hook
  and the attribution of Bash windows (§11 D-13); false ⇒ the Bash hook is not registered and Bash events are
  ignored.
- The hook socket path is `config.runPaths.hook` (§7.1).

### 7.7 Hook socket protocol

Newline-delimited JSON over `run/<short>.hook` (`config.runPaths.hook`; 0600 in the 0700 run dir). Every request
carries the per-session token that the daemon put in the session's environment (`SMURG_SESSION_TOKEN`); the daemon
derives the session and everything it knows about it from the token, never from the payload.

```ts
{ id, token, op: 'hook', hookInput: <a projection of the JSON Claude Code wrote to the hook's stdin>, via?: 'bash-activity' }
   → { id, hookOutput: <JSON to print on stdout> | null }        // null ⇒ print nothing, exit 0
{ id, token, op: 'mcp', tool: 'who_is_editing'|'lock_status'|'wait_for_lock'|'list_sessions'|'notify_member'
                              |'check_plan'|'propose_split'|'check_report', args }
   → { id, ok: true, result } | { id, ok: false, error }
```

`smurg hook` (hook-cli) and `smurg mcp` (coord-server, a stdio MCP server named `smurg`) are thin clients of this
socket. A malformed request is answered `{ id | null, error: { code, message } }` and the socket is closed. The hook
forwards a PROJECTION of Claude Code's input (`projectHookInput`: event and tool names, ids, cwd, the permission
mode, the paths a call names — an edit's or a Read's `file_path` / `notebook_path`, a search's `path`, a Glob's
`pattern` — and the lifecycle fields). The GATE hook also forwards the command of a `Bash` `PreToolUse`, whole,
because row G10 reads which files it names; a command whose JSON form is longer than
`HOOK_COMMAND_FORWARD_MAX_BYTES` (32 KiB) is not cut (a cut command is another command) but left out and marked
`command_omitted`, and the gate then asks a person where it would have read it. The Bash activity hook never
forwards a command. URLs, questions, file contents, prompts, transcripts and tool output never leave the hook
process, and a request line is at most 64 KiB. `smurg mcp` is a hand-written JSON-RPC 2.0 stdio server (the MCP SDK and zod
would slow every start); neither entry may load the daemon, zod or `@smurg/protocol` (a composition test enforces
the import graph).

**What the daemon knows about a session** (`HookSessionRegistration`, given by the agent runtime at every process
start): the session id, its daemon-internal owner (whose locks the agent's are), the agent's display name, the root,
and since 0.5.0 the facts the gate decides by: `purpose` (`discussion`, `item`, `free`), `topic { id, slug }`,
`itemId`, `pathRights` (`member` or `host`, fixed when the session was created) and `tools` (the profile's `--tools`
list, plus `mcp__*` when the host switched their own MCP servers on). `HookServer.reassignSession(sessionId,
ownerUserId)` is the handover of §3: it changes whose locks the agent's are and never touches `pathRights`.
`unregisterSession` revokes the token, aborts the session's waits, releases its locks and removes its launch files.

**The tool gate** (§0 rule 7, §11 D-21). `smurg hook` is registered for `PreToolUse` with the matcher `*`: Claude
Code runs it before every tool call, the MCP tools and `AskUserQuestion` included, and BEFORE its own permission
flow, so its deny binds whatever allow rules the host or the project have (verified on a host whose own settings
allow everything: `claude-structured.md` §5). The decision is a pure function of the registration's facts,
`gateDecision(session, protectedPaths, tool, target, pattern)` (`hooks/tool-gate.ts`); resolving the path, the lock
and the audit around it are the hook server's (`hook-events.ts`), and so is row G10, which looks at the file system
(`bashVerdict`, on the pure reader `hooks/bash-guard.ts`).

| # | When | Decision |
|---|---|---|
| G1 | the daemon does not answer, answers late or answers nonsense | **deny**, decided by `smurg hook` itself for EVERY tool: "smurg is not reachable on the host (…). Nothing can run until it is back." |
| G2 | the tool is not in the session's tool list and is not `mcp__smurg__*` | deny; logged once per session and tool |
| G3 | an edit tool whose target is Claude Code's configuration (`.claude/**`, `.mcp.json`, `.git/**`, at any depth), or a path the trust gate recorded (`ProjectTrust.protectedPaths`) or anything below one, under any spelling a file system folds onto it | deny, for every session, the host's own included |
| G4 | an edit tool on another host-only path (§5.2), session with `pathRights: 'member'` | deny |
| G5 | discussion session: `Read` / `Glob` / `Grep` whose path lies outside the session's root or names a host-private path, or a Glob pattern that can leave the root (absolute, `~`, a `..` segment) | deny |
| G6 | discussion session: an edit tool whose target is not `specs/<slug>/SPEC.md` or `specs/<slug>/PLAN.md` of its topic | deny |
| G7 | work item's session: an edit tool on its topic's `SPEC.md` or `PLAN.md` | deny |
| G8 | any other edit-tool call (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) | the **lock decision**: the path must lie in the session's own root and pass PathGuard as the agent's principal; then the agent lock is granted (no output), or the call is denied with who holds the file (§7.5) |
| G9 | everything else (`Bash`, `WebFetch`, `AskUserQuestion`, `mcp__smurg__*`, …) | **no decision**: the hook prints nothing, and Claude Code's own rules and permission requests go on (§7.6 "Profiles") |
| G10 | `Bash`, in a root whose project settings in use name scripts (`protectedPaths` is not empty): a command that writes where one of those scripts is, or that the gate cannot follow (below) | **ask**: the hook answers `permissionDecision: 'ask'` with smurg's reason, and Claude Code sends a permission request whatever its mode and its allow rules would have done. A person answers on a card; every other `Bash` call is row G9 |

- G1 and G9 together are the liveness check: a command of an orphaned agent, or of an agent whose daemon hangs, does
  not run, even when a remembered rule, a host rule or `acceptEdits` would have let it.
- The gate never says "allow" (`wire.ts` has no builder for it): allowing stays with Claude Code's rules and with
  people. A passed call and a granted lock return no output at all.
- **G10: what a shell command does to the scripts of the project settings.** While a root's project settings are in
  use, the scripts their commands name run as the host at the next hook event (§7.6 "Trust gate"). An edit tool never
  writes them (G3), but a shell command can, and it need not SPELL the script to replace it (`cp x/lint.sh scripts/`,
  `mv scripts scripts.old` then `mv other scripts`); in `acceptEdits` Claude Code runs `mkdir`, `touch`, `rm`,
  `rmdir`, `mv`, `cp` and `sed` inside the worktree by itself, and an "always allow" rule lets more run. So in such a
  root the gate reads every `Bash` command before it runs (`bashPlaces`: the places a command names, from the
  directory Claude Code says it starts in, following a `cd` to a written path; each place is then resolved as the
  file system has it, links included, so another spelling, a `..`, a link and a path from outside lead to the same
  answer) and judges them against the recorded paths (`judgePlaces`):
  - **`writes`**: a file the shell writes (`> f`, `>> f`, `&> f`) or an operand of a command that changes files
    (`FILE_COMMANDS`: `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`, `ln`, `tee`, `dd`, `install`, `rsync`,
    `chmod`, `patch`, `tar` and their kind, also behind `env`, `sudo` or `git`; the value glued to one of its
    options counts, `--target-directory=scripts`, `-tscripts`, `of=scripts/lint.sh`) is a recorded script, lies
    below one, or is a folder above one, a wildcard that can match one included; `find <folders> … -delete / -exec`
    counts as writing everything below those folders. The card is the HOST's to answer (`hostOnly`, `gate:
    'writes-settings-script'`).
  - **`unsure`**: the gate cannot say that the command leaves the scripts alone. Anyone who may allow commands
    answers (`gate: 'may-reach-settings-script'`). That is:
    - a place that is written is a variable, a substitution or a placeholder, comes from somewhere else (`… |
      xargs rm`), or is written by a relative name after a change of directory smurg could not follow (a `cd` to a
      variable, with a wildcard or without a place, `cd -`, `pushd`, `popd`, a line that may be in more than 8
      directories, a directory longer than 4,096 characters);
    - the program itself is a variable or a wildcard; the line cannot be read, was too long to forward, or names a
      place that cannot be looked up;
    - a program that neither only reads nor is a file command NAMES a recorded script, something below one or a
      folder above one (the root itself does not count; a wildcard that can match one does), as a word of its own
      or as the value glued to an option (`--output=x`, `-ox`, `NAME=x`): `sh scripts/lint.sh`, `curl -o
      scripts/lint.sh …`, `git diff --output=scripts/lint.sh`, `sort -oscripts/lint.sh`, `git add scripts`; an
      interpreter also inside its quoted argument (`node -e "…"`);
    - a command line handed to another shell (`sh -c "…"`, `eval`, `bash`, `su`, `watch` …) is read like the line
      itself, once, from every directory the outer line may be in and as lost as the outer line is, so `cd "$X";
      sh -c "rm lint.sh"` asks; one that is a variable is unknown;
    - git's commands that take files of the working tree from elsewhere without naming them (`checkout`, `switch`,
      `restore`, `reset`, `stash`, `merge`, `rebase`, `pull`, `cherry-pick`, `revert`, `apply`, `am`, `clean` and
      their kind);
    - a bound of the reading was reached, each of which ends it with `unsure` and never with `clear`, so that what
      reading costs is in proportion to the command: more than `BASH_PLACES_MAX` (256) places, counting those of
      the lines it hands to other shells; more than 16 changes of directory in one line; a shell inside a shell
      more than four deep (`SCAN_DEPTH_MAX`). A wildcard that is not matched against a script's name within the
      steps the two are worth counts as one that can match.
  - **`clear`** (no decision, G9): everything else. Programs that only read (`READ_COMMANDS`: `cat`, `grep`,
    `diff`, `ls`, …) may name anything, a file beside a script is written as before (`echo x >
    scripts/other.txt`), and git's `status`, `diff`, `log`, `add` and `commit` are not asked about while no word of
    theirs, and no value glued to one of their options, is such a script or a folder above it (`git add .` and
    `git commit -m "fix scripts/lint.sh"` pass; `git add scripts` and `git diff --output=scripts/lint.sh` ask).

  The bounds have a price: a write to a recorded script that stands five shells deep, or in a line that names
  more than 256 places across its nested shells, reads `unsure`, which anyone who may allow commands answers, where
  a reading to the end would say `writes`, which only the host answers.

  The reason the hook gives is one of two fixed English sentences (`BASH_ASK_REASONS` in `deny-text.ts`), which the
  conversation module knows again when the request comes back (`decision_reason` of type `hook`) and turns into
  `PermissionRequest.gate`, so a client can tell the two without reading `reason`: the web's card prints its own
  sentence for the gate, in the reader's language (§9 "Cards"). Measured on 2.1.288: a hook's "ask" is put above
  `acceptEdits` and above a matching allow rule of the session, the topic or the host's own settings; a deny rule
  still refuses first. So "always allow" does not cover a command that names such a script or its folder, nor the
  git commands above: they ask each time. What G10 does not see is in §12.
- A request Claude Code sends for a command of several parts (`decision_reason` of type `subcommandResults`) that
  names `.claude`, `.git` or `.mcp.json` is a host-only card as well: the daemon cannot tell a read from a write
  there (§5.9 "Host-only requests").
- A deny reaches the model as `PreToolUse:<Tool> hook error: <reason>`. The reasons are fixed English, one sentence
  per row, saying what the session may do instead (`hooks/deny-text.ts`, §1 Languages), e.g. "A discussion session
  writes only SPEC.md and PLAN.md in specs/checkout/. Put what you want to record into one of them." They name people
  through `agentSafeName` only (a display name is free text from an identity provider) and hold a slug or a tool name
  only when it is plain.
- A refusal of rows G2–G7 is announced on the bus (`agent.tool.gate`: session, tool, row, path) and audited by the
  conversation module as `permission.auto-deny`, ONE entry per session, row and minute with a count, so an agent
  that keeps trying cannot fill the log.
- What the gate cannot see is what a shell command DOES. G10 reads only which files a command names, and only where
  project settings in use name scripts. The rest is what permission requests, the deny rules of the profile (which
  also refuse shell commands that name Claude Code's configuration or a host-private file) and the merge review are
  for (§12).
- A `PreToolUse` of an edit for a path outside the session's root is denied, for host sessions too (no lock can be
  granted there, and an unlocked edit of another root's file would bypass its locks): a host's agent cannot Edit /
  Write files outside the share through smurg (Bash still can). §11 D-11 (approved).

**Everything that arrives on this socket is a claim, not a fact.** The agent can read its own token from its
environment and forge events for its own session. The daemon therefore: `realpath`s the path a call names and runs
it through PathGuard; grants locks only inside the session's root; caps locks per session; rate-limits requests per
token; caps connections and requests in flight; bounds line length; and answers every `PreToolUse` within 4 s
(`HOOK_SERVER_DECISION_MS`), with a deny when anything is uncertain. Events of one session are handled in arrival
order.

**Claude Code lets the tool run when a hook times out, crashes, exits 1 or is missing.** The hook must therefore fail
closed by itself: an internal deadline of 5 s (shorter than the configured `timeout` of 10 s), and on *any* error
during `PreToolUse` — socket unreachable, malformed reply, deadline, unreadable input — it prints a JSON deny and
exits 0, whatever the tool (G1). Other events fail quietly (stdout of `UserPromptSubmit` / `SessionStart` would
become model context).

**The other events** never return a decision; they release locks and feed the bus: `PostToolUse` /
`PostToolUseFailure` of an edit tool release its lock (`agent.tool.post`); `PermissionRequest` of an edit tool marks
the lock as awaiting approval; `UserPromptSubmit`, `Stop` and `SessionEnd` release everything the session holds and
close its Bash windows; `FileChanged` feeds the activity feed (`agent.file-changed`).

**Two hooks, two code paths** (§11 D-13). `hook-cli.ts` chooses by the argument the DAEMON wrote after `hook` in the
session settings (never by anything a session sends), and any argument other than exactly `bash-activity` selects
the gate, so a typo can only make a hook stricter:
- `smurg hook` — the tool gate above: fails CLOSED;
- `smurg hook bash-activity` — the Bash ACTIVITY hook, registered for `Bash` PreToolUse / PostToolUse /
  PostToolUseFailure only when `config.activity.attributeBashEdits` is on. It only tells the daemon "this session
  started / finished a shell command" (the same projection: never the command or its output, marked `via:
  'bash-activity'` so the daemon never answers it with a decision), never takes a lock, never prints anything for a
  Bash event (it does not even read the daemon's reply), and FAILS OPEN: daemon unreachable, slow (its own deadline:
  1 s) or answering nonsense ⇒ exit 0, no output, nothing attributed. It decides nothing: whether the command runs
  is the gate's G1 and Claude Code's permission flow. The one thing it refuses is to let an EDIT tool's PreToolUse
  through (routed to it by a misconfiguration, it would otherwise run without its lock): that gets the gate's deny.
  Cost: the packaged executable's `smurg hook` takes 20–30 ms per invocation (31–32 ms without a daemon in
  `packages/cli/test/sea.test.ts`; ~52 ms with the dev entry, node + TypeScript sources). Every tool call costs one
  gate invocation, a Bash call two more for its window.
On the socket a Bash event is `{ op: 'hook', via: 'bash-activity', hookInput: { hook_event_name, tool_name: 'Bash',
tool_use_id, … } }`, answered `hookOutput: null` whatever happens. The daemon pairs Pre and Post by `tool_use_id` (a
forged Post cannot close another command's window), keeps at most 8 open per session (10 minutes at most each),
closes them on `UserPromptSubmit`, `Stop`, `SessionEnd` and when the session ends, rate-limits them per session (240
per minute, burst 60; beyond that they are ignored, on top of the per-token budget) and ignores them when the switch
is off. The windows reach the activity module as `agent.tool.pre` / `agent.tool.post` with `tool: 'Bash'` and `file:
null` (`outcome: 'granted'` means "the command runs": no lock exists), which every other listener ignores (they act
on a file). Attribution: §11 D-13.

**The MCP tools** (`mcp/tools.ts` definitions, `hooks/mcp-tools.ts` answers). Every agent session lists all eight;
`permissions.allow` holds `mcp__smurg`, so they run without a permission request (they still pass the gate, G9). WHO
calls is known from the token: the session, its purpose, topic and item make the `McpToolContext` of every call,
never an argument. A tool called from the wrong kind of session answers with one sentence saying so. Answers are
structured JSON with a one-line English `summary`, fixed English for the model; people's names go through
`agentSafeName`.

| Tool | For | Answer |
|---|---|---|
| `who_is_editing`, `lock_status`, `wait_for_lock` (at most 120 s) | every agent session | who holds a file, the locks, and whether a file became free. Paths absolute or relative to the session's root, and only inside it (PathGuard as the agent's principal) |
| `list_sessions` | every agent session | the sessions of the workspace with owner, status, root, and for a topic's session its topic and item |
| `notify_member { member, message, file_path? }` | every agent session | delivered as `activity.notify` to that member only (SPEC R8) AND, since 0.5.0, stored as a mention from the agent in that member's inbox (§7.9); at most 10 a minute per session (`agent-notify`); the tool tells the agent when the member's inbox is full |
| `check_plan {}` | a discussion session | `{ ok: true, items, warnings }` or `{ ok: false, errors: [{ line, message }] }` for `specs/<slug>/PLAN.md` of the caller's topic, as the daemon reads it (§7.8 "The plan") |
| `propose_split { items: [{ id, person }], reason? }` | a discussion session, after `check_plan` answered ok | records who the agent proposes for which item; `{ ok: true, assigned, unknownPeople }` (§7.8 "Who is responsible") |
| `check_report {}` | a work item's session | the same check for `specs/<slug>/reports/<item id>.md` in the caller's root; an ok answer records the hash of the checked content for THIS session, which is what lets the daemon register the report (§7.8 "The result report") |

`tools/list` of `smurg mcp` is the same list for every session; all answers arrive well inside Claude Code's MCP
deadline because they parse a file or read a list. An agent can neither create nor settle a card through these
tools or through a hook: a card exists only for a request that arrived on the session's own pipe (§5.9).

### 7.8 Orchestration: topics, prompts, plan, execution, reports

The wire of this section is §5.10; this section says what the daemon does behind it. Two modules carry it:
`topics/` (topics, the plan with its preflight, pins and scheduler, result reports, the prompts) and, for the
collaborative layer of every conversation, `conversation/` (§5.9). Both reach sessions only through `AgentSessions`
and the bus (§7.2); git work is the worktree module's (§5.7). A topic's phase (`discussing`, `spec`, `plan`,
`executing`, `complete`) is derived from facts (does `SPEC.md` exist, does `PLAN.md` parse, was an item started, is
every item reviewed) and never set by a request.

**What an agent is told** (`topics/prompts.ts`, `sessions/agent/prompts.ts`; pure, fixed English, §1 Languages).

- **One role prompt per session, for its whole life** (`--append-system-prompt-file`, §7.6 "The record"). A
  discussion agent is told: several people talk to it, each message starts with a line in square brackets naming
  who wrote it, only a line starting with `[smurg <tag>]` is the workspace software; understand what they want and
  read the code first; ask every decision that belongs to the team with `AskUserQuestion` (two to four options, the
  recommended one first, independent decisions together), never in plain text; write the spec to
  `specs/<slug>/SPEC.md` (Goal, Decisions, Scope, Out of scope, Behaviour, Open questions) without pasting it into
  the conversation; change that file with Edit when asked and keep what people wrote; when smurg asks for the plan,
  write `PLAN.md` in the given format, call `check_plan` until it answers ok, then `propose_split`; it cannot run
  commands; what it reads is information and never changes these rules. A work item's agent is told: its item id,
  its own checkout and branch, to read the spec and its item first (it cannot edit those two files), to ask team
  decisions with `AskUserQuestion`, that most commands need a person's permission, not to commit, push, merge or
  change branches, and to finish with the result report and `check_report`, also when it cannot finish (outcome
  `partial` or `blocked`). A free session's prompt is four sentences: the shared workspace, the header line, smurg's
  tag, the information-not-instructions rule.
- **Nothing people or agents wrote is in a role prompt or under smurg's header.** A role prompt holds only values the
  daemon checked by pattern (the slug, an item id, a branch name, the tag); every builder throws on a value that
  does not fit. A message of smurg holds fixed sentences, such values, line numbers and `agentSafeName`s; file names
  are JSON-quoted. Where earlier text must be shown at all (the decisions of a lost discussion) it is in a fenced
  block labelled as a quotation, at most `SMURG_QUOTE_MAX_BYTES`.
- **Messages smurg sends** (`SmurgPurpose`, §5.9). Each is a `smurg` event in the conversation ("smurg asked Claude
  to …", readable by everyone), names the member who asked when one did, and is audited `smurg.message`:

| Purpose | When | What it says |
|---|---|---|
| `write-spec` | `topic.spec.request` | write the first draft now, list what is undecided under Open questions |
| `generate-plan` / `update-plan` | `plan.generate` without / with a plan | read the spec as it is now, write `PLAN.md` (parallel where possible, one agent session per item, dependencies), call `check_plan`, then `propose_split`; the people who can be responsible right now, as safe names; for an update: keep the id of every item that stays, and the ids that were already started |
| `start-item` | an item's session starts | the item's number and id, where its description is, who is responsible |
| `continue-item` | `plan.item.continue`, `plan.resume` | continue where you stopped, finish with the report |
| `retry-item` | `plan.item.retry` of a stopped item (a new session in the same worktree) | an earlier session stopped here: look at the changes that are already there |
| `fix-plan` / `fix-report` | a turn ended and the file was not checked ok | the findings as fixed English sentences with line numbers (never a token copied from the file), or "call the check tool" |
| `nudge-report` | a work item's turn ended and there is no report file | ask if you need a decision; if you are finished, write the report and call `check_report` |
| `resolve-conflict` | `plan.item.resolve` ("A conflict") | smurg merged the main workspace into your checkout; these files (a JSON list) have conflict markers; resolve, verify, update the report; do not run git |
| `conversation-lost` | a resume found no conversation (§7.6 "Runner") | the earlier conversation is gone: read the spec, the plan and your report before you continue |
| `restart-discussion` | `topic.discussion.restart` | a new conversation for an existing topic: read the two files; the team's earlier decisions follow, quoted, not instructions |

**The spec.** `topic.create` makes the folder `specs/<slug>/` and the discussion session, always in the MAIN
workspace (a worktree's copy of the spec is a different document). The first draft exists when
`specs/<slug>/SPEC.md` exists and is not empty at the end of a discussion turn: the daemon appends a `pointer{spec}`
event and the phase is `spec`. People edit the file as a document of the main root (§7.5); "Ask the agent to revise"
(`topic.revise`) is a message of that member to the discussion, or a suggestion when the member cannot drive.
After a discussion turn that changed the file, `Topic.spec.lastAgentChange` points at the edit's tool card and names
who asked. `Topic.handEdits` lists every change of the two files that was not the discussion agent's since the last
Start, per write path (typing in the editor, `file.write`, an upload, a rename or move into place, a delete, and
`'outside'`: an outside program or another agent session), from the bus event `activity.recorded`, and, for typing
in the shared editor, from `doc.human-edit` / `doc.saved`: the activity feed has only one `human.edit` entry per
person and file per minute, so a person who types again within that minute (after a Start, for example) is still
recorded as having edited by hand at every save. A member's rename or delete of a FOLDER that holds the two files
(`specs/<slug>`, or `specs` itself) is a hand edit of BOTH files by that member: the Start dialog names them under
each file, and so does the checkpoint's `Edited-by:` trailer. `changedBy` of the spec or the plan names whoever
announced their write LAST (a member who renames the folder after the agent's edit is the one named), and a write
that changed nothing never names its writer for somebody else's later change. A folder that a program OUTSIDE smurg
swapped is read again at once (the hashes and the pins follow, an armed item is disarmed) but is not listed as
`'outside'`: the watcher reports only the folder, and it reports folders for harmless reasons too (one that was
just made; on Linux a file appearing in it, the agent's own as often as anyone's). A change of `SPEC.md` or
`PLAN.md` itself from outside is listed.

**The plan** (`plan-format.ts`, pure; `plan-service.ts`). `specs/<slug>/PLAN.md` is free Markdown with ONE block
between two marker lines; the block is what the daemon reads and also what people read and edit:

```markdown
<!-- smurg:plan v1 -->

### 1. Cart API
- id: cart-api
- depends on: none
- size: m
- touches: src/cart/**, test/cart/**

Add the cart endpoints of SPEC "Behaviour" 1–3. Done when the cart tests pass.

<!-- smurg:plan end -->
```

- The two marker lines, each exactly once, in this order. Inside the block an item starts at `### <digits>.
  <title>` (a title of 1–120 characters; the item's number is its position); any other heading level there is an
  error; text before the first item is ignored. A heading or a field-like line inside a fenced code block is
  description. The file is read in lines cut at LF, CRLF and a lone CR. Unicode's line and paragraph separators
  (U+2028, U+2029) stay inside a line, and a line that holds one is neither an item heading (it is the error of
  any other heading) nor a field line (it is description): an editor shows two lines there, and the parser reads
  every line at the cost of its length.
- Directly after the heading, field lines of the shape `- <name>: <value>` (a name of letters, digits, spaces, `_`
  and `-`, then a colon and a space): `id` (required; `[a-z0-9][a-z0-9-]{0,39}`, unique), `depends on` (ids
  separated by commas, or `none`; existing ids, not itself, no cycle), `size` (`s`, `m`, `l`; default `m`),
  `touches` (up to 16 globs). An unknown field name is an error (a typo must not silently drop a dependency), and a
  misspelt field is one finding, not also "no id". Everything after the field lines is the item's description; its
  first paragraph is `WorkItem.summary`.
- 1 to 40 items (`PLAN_ITEMS_MAX`). Warnings (the plan is valid): two items without a dependency path between them
  whose `touches` globs overlap; an item without a summary. Findings are listed in file order. Every finding exists
  twice on purpose: a wire catalog reference for people (the plan column, the Start dialog) and one fixed English
  sentence per kind for the agent (`check_plan`, `fix-plan`); neither holds a token copied from the file, except an
  item id that passed the pattern.
- The daemon parses the file on three occasions: the agent's `check_plan`, a change of the file on disk (debounced),
  and at start. A parse that differs from the last one bumps `PlanInfo.revision`. `Topic.plan.stale` is true when
  `SPEC.md` changed after `PLAN.md` last changed.
- A discussion turn that ends with a plan that does not pass gets `fix-plan`, once per file content and at most twice
  in a row; then the plan column shows the error and people ask. When PEOPLE break the file while editing, no
  message is sent to the agent: `Topic.plan.valid` is false with the error and its line, the last plan that parsed
  stays on screen, and Start is refused until the file parses again.
- **Ids are the identity of an item.** Who is responsible, what is armed, what runs and what is reviewed is daemon
  state keyed by item id (`topics.json`), never in the file, so people edit the file freely and a name never goes
  stale in a versioned file. An item that was started and then leaves the file stays (`inPlan: false`) with its
  session and report and does not count for "topic complete". An item that appears after a Start is never armed by
  that Start.

**Who is responsible** (`split.ts`, pure; §3 "Who decides" says what being responsible means). The agent knows the
items, the daemon knows the people: `generate-plan` names the members with agent access who are online, the agent
proposes through `propose_split`, and the daemon keeps the pairs whose id is an item that is not started and not
chosen by a person and whose person matches exactly one of those names, and fills the rest with an even split
(weights `s` 1, `m` 2, `l` 3; the connected components of the dependency graph, heaviest first, each to the person
with the smallest load; a group heavier than 1.5 times the average is split item by item). `responsible.source`
says which it was (`agent`, `smurg`, or `chosen` after `plan.assign`, which nothing recomputes). Only members with
agent access are ever suggested (a responsible Editor could not allow their agent's commands); an Editor can be
chosen by hand. A suggestion does not move by itself: it is computed when the plan's items change and on "Suggest
again" (`plan.suggest`, which re-splits everything nobody chose by hand, the agent's proposal included). With
`plan.mode = 'everyone'` every item's `responsible` is null. At its start an item's responsible person becomes its
session's.

**Start** (`plan.preflight` → `plan.start`; §11 D-22). Start is the one click with large effects, so the Start
dialog lists them (`StartPreflight`, §5.10) and the request must repeat what the dialog showed:

1. `plan.start` carries `planRevision`, `specHash` and `planHash`. When the files differ by then it is refused
   (`conflict`, reason `plan-changed`) and the dialog reloads.
2. **The checkpoint commit** (`checkpoint.ts`, through `WorktreeManager.commitMainPaths`). An item's worktree is a
   clone checked out at the main workspace's HEAD, so the spec and the plan must be committed before an item
   starts. It happens ONLY inside a `plan.start` request, never later by itself, and only when one of the two files
   differs from HEAD: exactly `specs/<slug>/SPEC.md` and `PLAN.md`, by name (regular files only; whatever else lies
   in the folder or is staged stays as it is), on the branch the host has checked out, as the member who pressed
   Start, with the message `smurg: spec and plan of <slug>` and one `Edited-by:` trailer per person of `handEdits`;
   with the hardened git runner (no hook of the host's repository runs, no host configuration), serialized with
   merges, audited `spec.commit`. Refused, with the Start, in the middle of a merge or rebase
   (`plan.start.commit.busy`), when git ignores the folder (`plan.start.commit.ignored`), or on any git failure
   (`plan.start.commit.failed`).
3. **The pin.** For every item it arms the daemon stores `{ by, at, planRevision, specHash, planHash, commit,
   specBlob, planBlob }`; `Topic.handEdits` is cleared. Arming is per item id.

Execution needs git: a repository with at least one commit and git 2.42 or newer (§5.7). Without it topics,
discussion, spec and plan work (`Topic.versioned: false`) and the preflight's blocker says why Start is refused.

**Execution** (`scheduler.ts`). The scheduler runs on every relevant event (a Start, a merge decided, a session's
status, the plan parsed again, a change of the two files, `plan.resume`, a member removed, an agent process started
or gone) and does, for each armed item in plan order:

```
PIN CHECK   SPEC.md and PLAN.md hash as pinned, in the working tree AND at the main workspace's HEAD
            → otherwise the item is disarmed (`plan-changed`); the member who started it and the host get the
              attention item `item-not-started` ("Show the changes", "Start again")
waiting → queued     when everything it depends on is MERGED          (the only step a paused plan still takes)
queued  → running    when a slot is free (`maxLiveAgents` counts item sessions that hold a process):
                       1. WorktreeManager.acquireForItem: the item's own worktree at the main workspace's HEAD, on
                          the branch smurg/<slug>/<item id> (a report file that is already there is removed)
                       2. AgentSessions.start { purpose: 'item', mode: 'ask-commands', the role prompt, `start-item` }
                       3. audit `scheduler.start`
a failure on the way: the item is disarmed (`start-failed`) with what went wrong; attention `item-not-started`
```

The scheduler never commits and never reads a newer plan than the pinned one: an item that starts by itself hours
later starts from exactly the two files a member with agent access confirmed (§2 rule 6). Any change to either file
in between costs one "Start again", whose dialog shows the change (`plan.changes`). `maxLiveAgents` is enforced here
and nowhere else; the scheduler may ask the runtime to park the longest-idle item session
(`restartProcess(…, 'slot')`), and `PlanInfo.slots` says how many are in use and how many wait for a person. An item
whose starter is removed before it started is disarmed (`starter-removed`, §3 "When a member goes"). While an item
runs, its session is a conversation like any other.

**The result report** (`report-format.ts`, pure; `report-service.ts`). A report is a file the agent writes in its
worktree, `specs/<slug>/reports/<item id>.md`, so it is part of the item's change and reaches the main workspace
with the merge. Fixed English headings in a fixed order (the web shows them under translated headings):

```markdown
# Result report: Cart API

<!-- smurg:report v1 item=cart-api -->
- outcome: complete

## What was done
## Why it was done this way
## How it was verified
- [x] `pnpm test cart`: 14 tests passed
- [ ] Manual check in the browser: not verified: no browser in this session
## What to watch out for
## Follow-ups
```

The title line; the marker line, which must name the item's own id; directly after it `- outcome: complete | partial
| blocked`; the four sections present, in this order, each non-empty; "Follow-ups" optional; any other `##` heading
is an error. Under "How it was verified" at least one check line: `- [x] <text>` passed, `- [ ] <text>: not
verified: <why>` did not and must say why; prose between the checks is allowed. Each section at most 64 KiB and
through `mask()`. Lines are cut as in `PLAN.md` (LF, CRLF, a lone CR), and a line that holds U+2028 or U+2029 is
no section heading, no outcome line and no check line.

A report COUNTS only when the agent's own `check_report` answered ok for exactly that content in this session:
nobody can plant one (people cannot write that folder in an item's worktree, §7.4; a file that is there before the
start is removed). At the end of every completed turn of a work item's session the daemon looks:

| The file | What happens |
|---|---|
| checked ok in this session, new or changed since the last version | a new report **version**: the worktree is snapshotted into a draft merge request (`WorktreeManager.snapshot`, §5.7), `ReportInfo` is stored, a `pointer{report}` event, `report.updated`; the item is `done` (or stays `reviewed` with the report `changed-after-review`); the reviewers' inbox gets it; audit `report.register` |
| checked ok, unchanged | nothing, except that a new version is also made when the agent's edit tools changed files in that turn, and after a turn that took `resolve-conflict`: the diff is part of what is reviewed |
| exists, but this content was not checked ok | `fix-report`, once per content, at most twice in a row |
| missing | `nudge-report`, once |
| still nothing registered after those | the session and the item are `stalled` (`stalledBy: 'agent'`); attention `item-stalled` |

A turn a person stopped, or that ended with an error, stalls at once (`stopped`, `error`), without a nudge. A report
whose outcome is `partial` or `blocked` is a report: the item is `done`, and reviewing it needs
`acknowledgeUnfinished`.

**When the worktree cannot be snapshotted** (a file that keeps changing while the tree is read, a repository inside
the worktree, git running out of time; a snapshot refused as `worktree-changed` is repeated once first) NO version
is registered: a report without its changes would read "changed no files" and offer nothing to merge. The session
gets the warning notice `report.changes.failed`, the audit log an entry `report.register` with the outcome `error`,
an item that has no report yet is `stalled` (`stalledBy: 'error'`, "Continue"), and `snapshotOwed` on the stored
item makes the next completed turn, and the check after a restart, take the snapshot again whatever the report file
says by then. None of this happens while smurg itself is stopping.

- **The snapshot** is smurg's commit, not the agent's (the agent does not commit): as the member who started the
  item, with the message `smurg: work item <n> (<id>)`, onto the item's branch in its own clone, every new blob
  verified (§5.7). A change that contains host-only paths (a `CLAUDE.md` among them; a path the trust gate records
  counts as one), the topic's own `SPEC.md` / `PLAN.md`, a link out of the project, or conflict markers in a file the
  daemon merged, is not offered from the report: the report is registered all the same, without `changes` and with
  `noChanges` saying why; the host can still ask for the merge themselves and review it.
- **Follow-ups** (`report.followUp`) go to the item's session (a parked, idle or failed session resumes); the final
  text of the turn that took the message becomes the follow-up's answer; the item is marked `changesAsked` until the
  next version.
- **Review** (`report.review`, by one of the reviewers of §3): marks the version; the item is `reviewed`; when every
  item of the plan is reviewed the phase is `complete`. Reviewing is not merging: a reviewed draft is in the host's
  inbox by itself as ready to merge, with the items it unblocks (§7.9); "Request merge" stays for work nobody
  reviewed; the host merges as before (the merge commit reads `Merge smurg/<slug>/<item> (<who started it>)`).
- **After the merge** an item that is merged and reviewed is finished ONCE NOTHING UNMERGED IS LEFT IN ITS
  WORKTREE: its session ends with the reason `merged`, its worktree is released (`releaseItem`), its conversation
  and report stay readable. Releasing the worktree deletes what it holds, so `finishIfDone` finishes an item only
  when its CURRENT request is the merged one and `WorktreeManager.unmerged` does not list its worktree (a question
  that cannot be answered counts as "it holds something"). Two cases keep an item open: a follow-up after a merge
  made a new draft (the item reads "reviewed, waits for the host to merge" again and is finished by merging that
  draft), and the worktree holds changes no merge carried (a version whose snapshot the merge policy refused, edits
  made after the last report): the item stays reviewed and merged WITH its session and worktree until those changes
  are merged ("Request merge" on the worktree, or a new report version) or the worktree is removed by hand.
  `finishPending` asks again on the reports' sweep and at the module's start. A merge moves the items that waited
  for it from `waiting` to `queued`.
- **Failure and retry.** An item whose session's process failed is `failed`; "Try again" (`plan.item.retry`) resumes
  the same session and conversation, and smurg tells the agent to go on. The item stays `failed` across a restart of
  the host's smurg ("Continue all" does not touch it), and "Try again" works then too: the session is idle by then,
  so the request goes by the ITEM's state, not the session's status. A failed item becomes `running` again only while
  its session is inside a turn. An item whose session was ended on purpose is `stopped`; "Try again" gives it a new
  session in the same worktree (`retry-item`); `attempt` counts.

**A conflict: smurg merges, the agent resolves, nobody's agent runs git.** When the host's merge of an item reports
a conflict, `plan.item.resolve` calls `WorktreeManager.updateFromMain(worktreeId)`: (1) snapshot, so the worktree's
work is a commit S on its branch; (2) `git merge --no-commit --no-ff <main HEAD>` in the clone with the hardened
runner (no hooks, no host configuration; the clone reads the main repository's objects through its alternates, so
nothing is fetched; a merge that would overwrite an untracked or ignored file of the worktree is refused); (3) the
conflicted files are listed, `git merge --quit` leaves the files with their markers and ends git's own merge state,
and the worktree's record keeps the merge parent and the list; (4) smurg sends `resolve-conflict` with the file
list; (5) the next snapshot is a commit with TWO parents (S and the merge parent), refused while a listed file still
has a marker line. After it the host's trial merge is clean unless the main workspace moved again. (An agent's own
`git merge` could not do this: git refuses it over uncommitted work, and without a two-parent commit the host's
trial merge reports the same conflict for ever.)

**After a restart** of the host's smurg nothing runs by itself (§7.6 "Restart"). `armed` and the pins are persisted.
Every topic that has armed or interrupted items is **paused** (`Topic.plan.paused`): the scheduler checks no pins and
starts nothing, a merge only moves `waiting → queued`, sessions that were mid-turn are `stalled` (`restart`), and the
host and every member with agent access have one attention item per topic (`plan-paused`). `plan.resume` ("Continue
all") clears the pause, runs the pin check, and sends `continue-item` to the interrupted sessions.

**When a member goes** (§3): the kinds they allowed for whole topics are removed, the items they armed that have not
started are disarmed (`TopicService.memberRemoved`), and the sessions and item worktrees of their topics pass to the
host (§7.6 "Ending a session"). After a kick or a role change below "Agent access" every other worktree they still
own passes to the host too; after a leave it does not (§3).

### 7.9 Inbox: derivation, notes, escalation

The wire is §5.11; who gets what is §3 "Who decides". This section says how the daemon keeps a member's inbox true.

**Derived, never stored.** A member's inbox is a VIEW of what is open right now. `inbox/derive.ts` is a pure
function of an `InboxWorld` that `inbox-service.ts` collects from the other services' in-memory state: the open
questions and permission requests (`ConversationService`), the pending suggestions, the reports to review, the
merge requests, the attention facts, who is responsible for which session, the plans, who is a member and who is
online. Who gets a thing is `routing.ts` of `@smurg/protocol` and nothing else, so a card, a refusal and an inbox
can never disagree:

| Kind | In the inbox of | Leaves when |
|---|---|---|
| `question` | the decider; once escalated, also the host and every member with agent access | answered or withdrawn; the decider changes (it moves) |
| `vote` | in a session nobody is responsible for: every member holding `discuss` who has not voted on every part and does not hold the question item already | they vote; the question settles |
| `permission` | a host-only request: the host. Else the responsible person, while they hold `session.drive` and it has not escalated; else the host and every member with agent access | decided by anyone who may; withdrawn |
| `suggestion` | as a permission request that is not host-only; ONE item per author and session (`count`), opening at the oldest | every pending suggestion of that author in that session is settled |
| `report` | the reviewers; once escalated, also the host and every member with agent access | reviewed; a change after the review brings it back |
| `merge` | the host: a `pending` or `conflict` request, and a `draft` whose report is reviewed (`ready`) | merged or rejected |
| `attention` | the recipients its fact names | the fact ends |
| `mention`, `result` | the mentioned member (whatever their role); the author of a suggestion that was rejected or accepted after an edit | opened (`inbox.seen`) or dismissed |

An item leaves because its thing left the world, for every inbox that held it, at the same moment: nothing is
"cleared" by hand, and `inbox.dismiss` exists for mentions and results only.

**Recomputing.** The other services say on the bus that something changed (`question.changed`,
`permission.changed`, `suggestion.changed`, `report.changed`, `plan.changed`, `merge.changed`, `attention.changed`,
`session.updated`, membership and presence); the inbox marks itself stale and recomputes once for several events of
one synchronous run. Per member the result is diffed against what their clients hold and sent as `inbox.changed {
upsert, remove }` to that member's own interactive channels (`hub.sendToUser`; never the control socket, §8).
`inbox.list`, `inbox.seen` and `inbox.dismiss` recompute first when something is pending, so they never answer from
a stale view. A sweep on a real timer (`config.agents.escalationSweepMs`, 5 s) recomputes as well, so a missed
event cannot leave an item in the wrong inbox for longer than that.

**Unread.** Every derived item has a stamp; the member's "seen" mark (`inbox.json`) remembers the stamp the item had
when they looked at it. An item is unread without a mark, and again when its stamp moved on to a non-empty value: a
question whose eligible members have all voted, a new version of a report, one more suggestion of the same author,
a merge request that changed state. A permission request, a vote and an attention item are unread once.

**Stored notes.** Only two kinds of things in an inbox are stored (`inbox.json`): mentions and results. A request
may carry `mentions` (§5.11); an agent's `notify_member` stores a mention from the agent (§7.7). At most 200 notes
per member, all unopened: opening or dismissing a note removes it. When a member's notes are full, a new mention is
not stored and the request still succeeds; the sender is told (`mention.inboxFull`; `notify_member` tells the
agent).

**Attention: work that stopped and has no card** (`AttentionFact`). The service that owns a fact decides who
receives it and announces `attention.changed`; the inbox copies the facts into items as they are, with a stable key
(`attention:<subject>:<id>`):

| Subject | The fact | Owner | In the inbox of |
|---|---|---|---|
| `item-stalled`, `item-failed`, `item-stopped` | a work item's session stopped without a report, failed, or was ended on purpose | topics | the item's responsible person; nobody assigned: the member who started it; else the host |
| `item-not-started` | an armed item could not start, or was disarmed | topics | the member who started it and the host |
| `plan-paused` | smurg restarted and the topic has armed or interrupted items (one per topic) | topics | the host and every member with agent access |
| `discussion-lost` | the topic's discussion ended or failed to start three times in a row | topics | the host and the topic's creator |
| `account` | the workspace's account state is not `ok` (one item, `count` sessions) | sessions | the host |
| `project-settings` | a root has project settings the host has not decided, or that changed | the trust gate | the host |
| `host-rules` | the host's own allow rules were found, or changed, and the host has not looked | the host's rules | the host |
| `storage` | the transcripts exceed their budget (§7.1) | sessions | the host |

`waiting` (the amber count) is true for a question, a vote, a permission request, and every attention subject but
`host-rules` and `storage` (`inboxKindWaits`).

**Escalation: what waits too long reaches the others who may settle it** (`conversation/escalation.ts`,
`report-service.ts`). A question or a permission request gets `escalatedAt` after the host setting `escalateAfterMs`
(default 5 min, 1 min – 1 h), or at once when the ONE person it waits for has been offline for a minute
(`escalateOfflineMs`); a report after six times `escalateAfterMs`. From then on it is ALSO in the inboxes of the
host and every member with agent access, and stays in the first person's; they may submit for the decider
(`onBehalfOf`, the line `conversation.submittedFor`) or review instead of the reviewer, without becoming
responsible. There is no timer per card: stored times are compared with `ctx.clock.now()` on the sweep of
`escalationSweepMs` and on the events that can change the answer (a test sets the sweep to a few milliseconds and
moves the clock, §10). The same sweep keeps `Question.decider` and `Question.eligible` current where no event says
they changed. `question.remind` (the decider or the host, once a minute per question) stores a mention for every
eligible member who has not voted.

---

## 8. CLI

Language (§1 Languages): `SMURG_LANG` (`en` / `zh-TW`; anything else is ignored) → the first non-empty of `LC_ALL`,
`LC_MESSAGES`, `LANG` (zh-TW when it is Traditional Chinese with a UTF-8 or no codeset) → on macOS, when all three are
unset, the system language (`defaults read -g AppleLanguages`, cached; a failure is English) → `en`. Resolved once in
`runCli` (`resolveLang(io.env, io.systemLanguages)`, over `localeFromEnv`) and carried in the command context
(`CommandContext.lang`); messages are lazy `Text` values (`m(id, params)`, `packages/cli/src/i18n/`) rendered only
where they are printed, so no throw site needs the language: `CliError.text` is what the person reads,
`CliError.message` its English rendering (logs). The installer follows the same order (`pick_lang` in
`scripts/install.sh`). English output is ASCII only. What the daemon refuses is rendered from the wire:
`render(lang, error.text) ?? render(lang, defaultErrorRef(error.code)) ?? error.message` (the control socket's error
replies are full error payloads, `{ ok: false, error: { code, message, detail?, text? } }`). What the daemon reports
in process is a code the CLI words itself: `ShareError.reason` (`SHARE_ERROR_REASONS`: why a folder cannot be shared),
`ShareLockError.reason`, `ControlSocketError.code`, and keep-awake's `PowerStatus.reason` (`POWER_REASONS`). The quoted
outputs below are the English ones; the zh-TW catalog has the same messages.

| Command | Behaviour |
|---|---|
| `smurg host <folder> [--relay URL] [--role R] [--expires D] [--max-uses N] [--name N] [--web-origin URL] [--no-keep-awake] [--no-browser] [--no-bash-attribution]` | refuse a folder that is already shared, that overlaps a folder a running host of this state dir shares (inside or around it, whatever the relay) or that contains a home directory, all before any login; login if needed (a stored login with less than 24 h left counts as missing); start daemon in the foreground, keep machine awake. `--role` is `agent` (Agent access, §11 D-15), `editor` (default) or `viewer`; anything else (`host`, the removed `runner`) is a usage error. **The start prints only the two links**: `smurg is sharing "<name>"`, the host link, the invite link (on `--web-origin`, e.g. the Vite dev server) under a line that names its expiry, and its use limit and role only when the host chose them, and `Press Ctrl-C to stop sharing.` Nothing else is printed at the start unless the host must act on it: keep-awake refused at the start (not when `--no-keep-awake` switched it off; a later loss is printed too). The explanations (SPEC §11's warnings, what "Agent access" means, the switch, the fingerprint, keep-awake, the log file, the relay) are in `docs/HOSTING.md` (named in `--help`) and the state of this machine in `smurg status`. `--no-bash-attribution` sets `config.activity.attributeBashEdits` to false (§11 D-13; default true). Starting the daemon no longer forgets sessions: the agent sessions of the previous run come back idle and every plan is paused (§7.6 "Restart"); there is no new option (the agent limit is a host setting in the console). A stop (Ctrl-C, `smurg stop`) ends terminals and the agents' processes, the agent sessions stay: after `Stopped sharing.` it prints `3 agent sessions are paused. They continue when you share this folder again.` (`host.agentsPaused`; `1 agent session is paused. It continues when …`) when there were any. (Removed with the guest sandbox, §11 D-15: `--no-guest-subscription-login`, `--allow-main-workspace-guests`, `--no-main-workspace-guests`: unknown options now; and the daemon no longer runs from `~/.smurg/cwd`.) |
| `smurg attach [session] [--workspace W] [--invite -\|URL] [--relay URL] [--no-browser] [--accept-new-key]` | **Terminal sessions only** (§11 D-16: an agent session is a conversation and has no terminal; no terminal client for conversations is built). Local daemon running → attach through the control socket as host; otherwise join through the relay with the CLI device key. Without a session it lists every session: the terminals, numbered as before (`attach.list.header`; none: `This workspace has no terminal sessions.`), then `Agent sessions (conversations):` with the columns Session ID / Status / Topic / Title (a topic's sessions together, free sessions last under `No topic`; titles through `sessionTitleRef`; never numbered: a NUMBER only ever picks a terminal), then `Attach with smurg attach <number or session ID>.` (only when there is a terminal) and `Agent conversations open in the browser: <web origin>/w/<workspace id>` (without an address: `Agent conversations open in the browser, in this workspace's web app.`). `smurg attach <an agent session>` (its id or a unique prefix) prints `smurg: Session "<title>" is an agent conversation, not a terminal` with that sentence as the hint and exits 2. Columns are padded by display width (`cli/columns.ts`), so the zh-TW list lines up. The workspace's address: for a local attach the control socket's `status` answer carries `webOrigin` (absent for a daemon without a relay); for a relay attach the invite link's origin, else the `web` origin remembered for that join in `workspaces.json` (stored only when it differs from the relay), else the relay's origin. A member whose role cannot type gets `Read-only: Amy opened this terminal session, and your role cannot type into terminal sessions. Press Ctrl-] to leave.` The invite (its `#` part is the secret) comes from a no-echo prompt (`--invite -`) or `SMURG_INVITE`; a link in argv still works, with a warning (it is visible in `ps` and lands in shell history). An invite whose `k` differs from the key pinned for the workspace (the host started over with new workspace keys, `docs/HOSTING.md` §5.1 / §8, or someone poses as the host) is never used silently: the CLI prints the same explanation as the web (the host's computer key differs from before) with the pinned and the invite's fingerprints (`formatFingerprintForDisplay`, the form `smurg status` shows) and continues only on an explicit `y` at a terminal (`CliIo.readLine`; never from a pipe) or with `--accept-new-key`; then it connects with `preferInvite` (the invite verifies the new key, which replaces the pin). Otherwise nothing is sent and the pin stays |
| `smurg stop [--workspace W]` | ask the daemon (control socket) to stop: closes all channels, ends every terminal session and every agent's process; the agent sessions stay (their conversations are kept, and they continue when the folder is shared again: §7.6 "Restart"); returns when the daemon is fully stopped. After `Stopped sharing.` it prints the same `N agent sessions are paused. …` line as `smurg host` when there were any |
| `smurg status [--workspace W]` | every running daemon of this state dir: folder, relay (marked when it is the built-in one) and link states, connections, the daemon key fingerprint, keep-awake (the same wording as `host`'s notices), the switch of §11 D-13 as the daemon runs with it, then since 0.5.0 `Claude Code:` (the version; `verified with this smurg`, `not verified with this smurg yet; agent sessions run with a warning` or `too old for agent sessions; update Claude Code`; and the login, all from the daemon's last check; `not checked yet (smurg checks it when the first agent session starts)` before one), `Agent sessions:` (`N running, N waiting for a person, N stopped without a report or failed, N idle`, or `none`), `Topics:` (`N (N paused)` / `none`), `Claude Code project settings:` (`confirmed (agents use them)` / `not confirmed (agents run without them; confirm them in the web app)` / `none in this folder`; §7.6 "Trust gate") and `Your own Claude Code allow rules:` (`N apply to agent sessions (agents run what they allow without asking)` / `none apply to agent sessions`; §7.6 "The host's own Claude Code"), each of the last four only when the daemon reports it; then the log file. Fields a daemon does not send are left out |
| `smurg login [--relay URL] [--dev-user NAME] [--no-browser]` / `smurg logout [--relay URL] [--all]` | relay session for the CLI through the device-code login (§6; `packages/cli/src/relay/login.ts`): prints `On any device (a computer or a phone), open:`, `<relay>/device` and `Enter the code: XXXX-XXXX   (valid for 10 minutes)`, opens the page (never the code) when the browser rule below allows, then polls every `interval` s (+5 s after each `slow_down`; network and 5xx errors are retried until the code expires) until allowed (the session is saved), denied or expiry (exit 4); Ctrl-C ends it (exit 130). `smurg host` and `smurg attach` log in the same way when they need to. `--dev-user` only for a relay on a local hostname. (`--provider` is gone: the login method is chosen in the browser.) |
| `smurg update [--check]` | (`commands/update.ts`, `update/*.ts`) replaces THIS single executable with the newest published one. Reads `<downloads>/latest/VERSION` and compares it with the executable's version as semver: the same → says so; older than this one → says so (never a downgrade; a `-dev` build is older than its release); `--check` only reports (exit 0). A newer one: refuses while a `smurg host` of this state dir runs (it says to run `smurg stop` first; nothing is stopped from here: a share that keeps running would mix the old daemon with the new `smurg hook` / `smurg attach`), then streams `v<X.Y.Z>/smurg-<platform>-<arch>` into a temp file in the executable's own directory and installs it only when the announced size, the sha256 of that version's `SHA256SUMS`, the build marker (exactly one, naming that version) and the file's own `--version` all agree; macOS: `com.apple.quarantine` is removed after the sha256 matched (`/usr/bin/xattr`, as the installer); then one `rename` over `process.execPath` (0755; the bytes are never touched, so the ad-hoc signature stays valid). Prints `Updated smurg: old -> new` and the changelog's URL. Nothing is replaced on any failure and the temp file goes on every way out (error, Ctrl-C → exit 130, `process.exit`); a progress line only on a terminal; timeouts (15 s for the two small files, 30 s without a byte for the download). Refused: not the single executable (a source checkout: exit 2, it says to use git and pnpm), a directory that cannot be written (names it and the installer), a downloads site that is not https. `<downloads>` is `https://downloads.smurg.ai`, or `SMURG_INSTALL_BASE_URL` (tests, mirrors; the installer's variable and rule: https, or http only for 127.0.0.1 / localhost; a trailing `/v<X.Y.Z>` or `/latest` is dropped, so the installer's value works); redirects never leave that scheme |
| `smurg uninstall [--keep-data] [--yes]` | (`commands/uninstall.ts`) removes the executable itself (`process.execPath`), the cache (every `native-<id>` dir of every build in the cache root in force and in the platform's default one; an emptied root too) and the state dir, which since 0.5.0 also holds the conversations of agent sessions (§7.1; `--keep-data` keeps it). Everything is looked at and every refusal happens before anything changes; then it prints each path with its size and what stays, and asks `Remove these? [y/N]` through `CliIo.readLine` (`--yes` skips it; without a terminal and without `--yes` it refuses, exit 2; any answer but y / yes cancels, exit 1). Every running `smurg host` of this state dir is then stopped as `smurg stop` does and waited for; one that refuses or does not end aborts with nothing removed. Removal order: cache, state dir, the executable last. Never touched, only listed: the `.smurg/` of shared project folders (the folders of `workspaces.json` that still have one, and one around the current directory that holds the daemon's own entries), and shell profiles (it names the `PATH` line the installer suggested). Guards (fail closed): only the single executable uninstalls itself (a source checkout is told what to delete by hand); the state dir is removed only when its real path is not `/`, a top-level directory, the home directory or a folder around it or around `/Users`, `/home`; a `SMURG_HOME` other than `~/.smurg` must hold nothing but smurg's own entries (§7.1); a state dir that is a symlink is unlinked, not followed; a cache root or cache entry that is a symlink is skipped; `rm` never follows a symlink out of what it removes, and each path is removed only while it is still the file or directory that was listed (device and inode) |
| `smurg hook`, `smurg mcp` | internal entry points used by Claude Code inside agent sessions (the hook event is in the stdin JSON); dispatched before anything else is loaded. `smurg hook` is the command of the tool gate, run before EVERY tool call, and fails closed for every tool; `smurg hook bash-activity` fails open and decides nothing (§7.7). `smurg mcp` is the same hand-written stdio proxy to the hook socket; its `tools/list` gained `check_plan`, `propose_split` and `check_report`. Both start fast and import neither zod nor the daemon, and nothing under `packages/daemon/src/testing` (the stand-in `claude`) is reachable from `packages/cli/src/main.ts` (composition tests) |

**Arguments** (`cli/args.ts`): unknown options, a string option given twice, a boolean together with its `--no-` form
(`--bash-attribution --no-bash-attribution`) and surplus positionals are usage errors (exit 2), before anything else runs.

**Relay choice.** `--relay`, else `SMURG_RELAY_URL`, else the relay of the last login, else the built-in default: the
shared relay the project operates on Cloudflare Workers, `https://app.smurg.ai`
(`packages/cli/src/relay/default-relay.ts`, `docs/RELEASING.md` §3; it was the workers.dev URL of the first deploy
until 2026-10-01, before any release); `smurg attach` first takes the invite link's origin, or the relay a remembered
join used. Before
the release plan of 2026-09-30 there was no default (a guessed domain would have received the host's
login and every invite printed for it); an operated relay does not have that problem. Logins are stored per origin:
an invite link carries the WEB origin, which is the relay in production but not in development (Vite on :5173 in front
of the relay on :8787), so a CLI guest in the dev stack uses `--relay http://localhost:8787` (the CLI says so when it
finds a login for another origin).

**While `smurg host` runs** the host's terminal is told: the relay link
dropping (after 3 s without recovery, so blips stay quiet) and coming back; the relay refusing the host's login
(`auth-rejected`: members cannot connect) with the command to run; a stored login that expires within 24 h; and a state
file the disk refuses (the change is in force but would not survive a restart) and its recovery. `credentials.json` is
re-read every 5 s: a newer login of the SAME account for that relay (`smurg login` in another terminal) is handed to the
daemon (`Daemon.updateRelayToken`) without a restart; another account's login is refused with a notice (the workspace
belongs to the account that claimed it). A second Ctrl-C within 2 s of the first is ignored while the stop runs (it is
usually one impatient key press, and leaving mid-teardown can leave session processes stopped); a later one leaves at
once (exit 130). `smurg status` shows the link state `auth-rejected` as "the relay refused the host's login (run smurg login to log in again)".

**Update notice** (`update/notice.ts`). After `smurg host` printed its two links it asks
`<downloads>/latest/VERSION` once, in the background (never awaited; ended by a stop), with a 2 s timeout, and prints
ONE more line only when that version is newer than the executable: `Version 0.4.1 is available (this is 0.4.0): stop sharing, then run smurg update`. Nothing is printed when it is the newest, on any failure or timeout; no request is made with
`SMURG_NO_UPDATE_CHECK` set, in an automated run (`CI`, or stdin / stdout not a terminal: the rule of `browserBlock`) or
from source (where `smurg update` could not do what the line says). The request carries nothing about the machine. The
CLI's vitest setup and `isolatedEnv()` set `SMURG_NO_UPDATE_CHECK=1`; the tests of the notice use a local server.

**Browser.** A login opens the person's browser only through `CliIo.openUrl`, and the real implementation
(`cli/io.ts` `browserBlock`) never opens one when `SMURG_NO_BROWSER` or `CI` is set, over SSH (`SSH_CONNECTION` /
`SSH_CLIENT` / `SSH_TTY`), when stdin or stdout is not a terminal, or on a Linux without a display; the URL is printed
instead, with the code: the person opens it on any device (the device-code login needs nothing from this machine, so
SSH needs no port-forward). `--no-browser` does the same per command. The page is opened without the code; the person
types it. `scripts/env.sh`, `scripts/dev-stack.ts`, the CLI's vitest setup and every test helper that spawns the CLI
set `SMURG_NO_BROWSER=1`.

**`smurg attach` output.** Session output passes an allow-list filter (`attach/output-filter.ts`) before it reaches
the person's terminal: a VT parser state machine over the decoded UTF-8 (C1 controls U+0080–U+009F treated as their
7-bit ESC forms; ESC, CAN, SUB end a string as terminals do), which emits text, harmless C0 controls and only COMPLETE
allow-listed sequences, re-encoded (SGR, cursor movement, erase, scroll region, DEC private modes, kitty keyboard
push/pop, title stack, OSC 0/1/2 titles, OSC 8 http(s) links, colour sets). Queries, OSC 52, every DCS / APC / PM /
SOS, window operations and anything unknown are dropped whole; nothing is ever emitted half-way, and memory is bounded.
With a non-UTF-8 locale only ASCII text passes (UTF-8 continuation bytes would be C1 controls there).

**Control socket** (`run/<short>.ctl`, 0600 in the 0700 run dir; protocol in `packages/daemon/src/local/protocol.ts`,
exported by `@smurg/daemon` for the CLI). Frames on the stream: `[u32be length][u8 kind][body]`, kind `0x01` CONTROL
(UTF-8 JSON, ≤ 64 KiB) or `0x02` ENVELOPE (one msgpack Envelope). The client's first frame is one CONTROL request
`{ v: 1, op: 'status' }` | `{ v: 1, op: 'stop' }` | `{ v: 1, op: 'attach', deviceName, resume? }`; the daemon
answers one CONTROL response `{ ok: true, op, status | welcome }` or `{ ok: false, error }`; the `status` response is
`{ ok, op: 'status', status, webOrigin? }` (`webOrigin`: the workspace's web origin, absent for a daemon without a
relay; `smurg attach` builds the address of the conversations from it). `status` is the
`DaemonStatus`; its `fingerprint`, `relayUrl`, `switches` (`{ attributeBashEdits }`), `isGitRepo` and, since 0.5.0,
`claude`, `agents` (`{ running, waiting, stalled, idle }`), `topics` (`{ total, paused }`), `projectSettings` and
`hostRules` (`{ count }`) are optional in the wire schema: a module that is not composed contributes nothing.
status / stop: the daemon then closes the socket (stop: and stops). attach: ENVELOPE frames both ways afterwards, on a logical channel of the
host admitted through `ctx.lifecycle.attachLocal()` (§4 Local connections). No Noise: the file mode authenticates —
the host's OS ACCOUNT, not the host: every session runs as that account (§11 D-15), so whoever drives a session can
connect here. On a local channel the router therefore accepts only what `smurg attach` sends: `session.list`,
`session.attach`, `session.detach`, `exec.input`, `exec.resize` and `channel.ack` (`LOCAL_CHANNEL_TYPES`,
`packages/daemon/src/local/local-channel.ts`; checked before the capability). Everything else — `admin.*` (invites,
roles, kicks, terminations, settings, the audit log), merge decisions, `lock.forceRelease`, `session.create` /
`session.end`, suggestions, files, documents, `channel.leave` — is refused `forbidden` {reason: `control-socket`} and
audited; every audit entry a local channel causes carries `detail.via: 'control-socket'`. What
it RECEIVES unasked is limited the same way, in the hub (`send` / `broadcast`, per logical channel, so nothing else is
queued for a resume either): only what `smurg attach` consumes, `exec.output`, `exec.resize`, `session.state`,
`channel.closed`, `channel.ack`, `presence.heartbeat` and `error` (`LOCAL_CHANNEL_RECEIVES`) — no live audit log
(`admin.audit.entry`), no host notices, presence, members, settings, suggestions, merges, documents or files
(verification F-1, 2026-10-02); answers to its own requests are not affected. **Protocol 4 added nothing to either
list.** None of the new requests is reachable through the socket (messages to agents, votes, comments, answers,
permission decisions, suggestions, topics, plans, starts, reviews, the inbox, the trust decision, the host's rules,
redaction), and none of the new events is sent to it (no `session.events` or `session.delta`, no card, topic, plan,
report or inbox message, no `session.host`); `session.state` is the one message that may now describe an agent
session, as `session.list` does. So whoever holds the host's OS account through a session cannot answer the host's
permission cards, or anyone's, in the host's name through smurg. The core's `local-control.test.ts` runs every client
message of the registry over a local channel, so a new type is covered by construction;
`test/local/control-server.test.ts` › "the control socket and protocol 4: none of the new requests is reachable"
names them. The host decides on the host's relay
channels (the web console); `status` and `stop` are control requests, not channel messages, and are not affected. A
`stop` names no reason (a request with one is refused `bad_request`): the daemon's stop reason is always `smurg stop`
(`CTL_STOP_REASON`), and `smurg host` tells its own stops (a failed start, a failed summary) apart by what it did
itself, never by that text, so every other stop is told on the host's terminal.
The socket stays open until every other module stopped (it answers status with `stopped: true` and refuses attach
meanwhile), so `smurg stop` sees it go only when the daemon is done.

**Distribution.** `scripts/build-sea.sh --version X.Y.Z` builds the single executable for the current platform (the
version is injected at build time; other builds say `<package version>-dev`); `scripts/release-assets.sh` writes a
release's `SHA256SUMS` and an `install.sh` with the release URL filled in; `scripts/install.sh` installs only a
sha256-verified executable into `~/.local/bin` (macOS: it removes the quarantine attribute after the check); there is
no sandbox to set up on Linux any more (§11 D-15). The executable's extracted
native dir of an older build is removed after 30 days unused. Releases: `.github/workflows/release.yml` builds the four
executables on a tag `v*` (`macos-15`, `macos-15-intel`, `ubuntu-24.04`, `ubuntu-24.04-arm`; macOS signed ad hoc only);
from 0.4.0 the GitHub release carries the notes, `SHA256SUMS` and the notices only (no executables): the executables, the
installer and those two files are the workflow artifact `release-X.Y.Z` (kept 30 days). A person then runs
`scripts/publish-downloads.sh --version X.Y.Z --from-release`, which takes the files from that artifact of the tag's
successful run (`gh run download`), requires the release's `SHA256SUMS` and notices to be byte-identical to the
artifact's, verifies the files and uploads
them to Cloudflare R2 behind `https://downloads.smurg.ai` (`v<X.Y.Z>/`, immutable, then `latest/`); the one-line install
`curl -fsSL https://smurg.ai/install.sh | sh` is a 302 from the product page `apps/site` to
`https://downloads.smurg.ai/latest/install.sh`, with no GitHub fallback. An installed executable updates itself from the same
place (`smurg update`: `latest/VERSION`, then the version's `SHA256SUMS` and executable) and removes itself with
`smurg uninstall` (the table above). Every executable carries a build marker
(`smurg-build-version=X.Y.Z;`, a comment build-sea puts at the top of the bundle) and, as any Node.js release build, the
download URL of its Node.js release; `scripts/release-assets.sh` and `scripts/publish-downloads.sh` read both from all
four executables (`scripts/release-markers.ts`), so a release cannot mix in an executable of another version or another
Node.js than the one whose LICENSE its notices carry. Runbook: `docs/RELEASING.md`.

**Licenses.** smurg is MIT-licensed since 0.4.0 (`LICENSE`, Copyright (c) 2026 Guan-Chen, Lin; every `package.json`
says `"license": "MIT"` and stays `"private": true`: nothing is published to npm); 0.1.0 to 0.3.0 were released
before the license. The third-party notices are generated, never written by hand: `scripts/third-party-notices.ts` walks
`pnpm-lock.yaml`'s production closure of `@smurg/cli` (with the daemon and protocol, for the four release targets) and of
`@smurg/web`, and reproduces every package's license and notice files from `node_modules` into
`packages/cli/THIRD-PARTY-NOTICES.txt` and `apps/web/public/third-party-notices.txt` (a package without one fails the
generation; `pnpm check` fails while a committed file is stale). `scripts/build-sea.ts` refuses a stale file or a bundled
package it does not list (esbuild's metafile and the native assets), fills in the Node.js section from the LICENSE of the
Node distribution the executable is copied from, and embeds the result with `LICENSE` as SEA assets: `smurg licenses
[--third-party]` prints them, and the same notices are written next to the executable for the release. The web build
(`apps/web/vite.config.ts`) refuses the same way and serves the file as `/third-party-notices.txt`.

---

## 9. Web

**Routes** (`lib/router.ts`, a closed union; an invalid workspace id or an unknown console section is not-found):

| Route | View |
|---|---|
| `/` | landing + login |
| `/join/:workspaceId` | invite acceptance (§4.1) |
| `/w/:workspaceId` | the workspace: the **sessions view**, the main screen since 0.5.0 |
| `/w/:workspaceId/code` | the workspace: **code mode** (the workbench of 0.4.0: files, editor, terminal) |
| `/w/:workspaceId/console[/:section]` | the host console, optionally at one of `CONSOLE_SECTIONS` (what an inbox item of the host opens) |

**The mode is a route, and both views stay mounted.** `WorkspaceRoute` renders ONE `WorkspaceShell` for the two
workspace routes; it mounts the sessions view and code mode and shows one (`hidden` + `inert` on the other), so
composer drafts, open columns, editor tabs and scroll positions survive the switch and nothing reconnects; a reload
and the back button keep the mode. Code mode's chunk (Monaco, xterm.js) is loaded when code mode is first shown, and
the sessions view imports neither statically (`scripts/check-chunks.ts` guards the first-load chunk). The shell owns
what belongs to neither view: the top bar with the two-segment switch "Sessions | Code mode" (links with
`aria-current`; the inbox counts on "Sessions" while in code mode), the connection banners, the commands that move
between the views, the overlays the features registered, the notices, and the tab title with the waiting count.

```
apps/web/src/
├── boot/        capture-invite, locale (resolves the language before anything renders)
├── strings/     the catalog (`defineStrings(ns, en, zhTW)`) and the app-wide namespaces (+ `*.zh-TW.ts`)
├── app/         routes, providers; workspace/: WorkspaceRoute, WorkspaceShell, SessionsView, Workbench (code mode),
│                TopBar, feature-slots (the slot registry)
├── lib/         connection (client SDK wrapper, reconnect, offline detection), device-key store (IndexedDB), router,
│                commands, slots, columns/ (targets, the column context, titles), stores/, locale
├── features/
│   ├── auth/          login, join flow, key-mismatch warning
│   ├── columns/       the strip of up to four columns: frame, header, pin, dividers, focus; code mode's side column
│   ├── sidebar/       the left column: the inbox list, the topic tree with its sessions, filter, rail, notices
│   ├── conversation/  an agent session's column: header strip, event list, tool cards, question / permission /
│   │                  suggestion cards, next-step cards, the status bar, the composer
│   ├── markdown/      the Markdown renderer (below)
│   ├── topics/        the New topic dialog, the spec, plan, report and Changes columns, the Start dialog
│   ├── agents/        plain terminals: the terminal column and panel, terminal feed and fit, path links, the
│   │                  new-session and end-session dialogs
│   ├── editor/        Monaco + Yjs provider, presence cursors, lock banner, "Send to agent"; `DocumentPane` is also
│   │                  mounted by the spec and plan columns
│   ├── files/ activity/ transfer/   code mode: file tree and root switcher, activity feed and conflicts, transfers
│   ├── worktree/      the worktree switcher, merge review and diffs (also mounted by the report column)
│   └── console/       members, sessions, suggestions, merges, invites, audit log, settings; the Claude Code project
│                      settings and the host's own rules; redaction of one event
└── ui/          shared components + design tokens (Segmented, Collapsible, Card, StatusGlyph, KindIcon, Chip,
                 AvatarStack, Tree, Columns, ContextMenu, SplitPane, …)
```

**Features plug into the shell through slots.** A feature never imports another feature, and the shell never imports
a feature's column: each feature has one small file `features/<feature>/slots.tsx` that exports `defineSlots({
feature, columns, overlays, menus, inboxRows })` (`lib/slots.ts`), found by the shell through an eager glob
(`app/workspace/feature-slots.ts`). Components go in with `React.lazy`. Two features that claim one column kind or
one inbox kind are an error when the registry is built; a kind nobody registered shows a placeholder. A column's
FRAME is the shell's (`features/columns`: the region, the header with the title as `h2`, the pin, "More actions",
close, focus, visibility); its BODY is the feature's component and reads `useColumn()` (`id`, `target`, `place`
`strip` or `code`, `focused`, `visible`, `anchor`).

**Commands** (`lib/commands.ts`): `openColumn { target, side?, from?, anchor? }` (a `console` target navigates to
the console's section; it switches to the sessions view), `setMode { mode }`, `openInCodeMode { root, file?, line?,
sessionId? }` (sets the file tree's root and the session beside the editor, switches the route, then opens the
file), `newTopic`, `newSession { kind }`, `showPanel` (code mode's panels), and the editor's and the transfer's
commands as before. A command without a handler rejects, and its caller says that this cannot be opened.

**Stores.** State lives in small stores fed by the single `Connection` object (`bind / reset / load /
onRoleChange`, and `onResumed` for a resumed Welcome). Role-based hiding in the UI is cosmetic; the daemon enforces.

| Store | Fed by | Holds |
|---|---|---|
| `sessions` | `session.list` (every page), `session.state` | every `SessionInfo`; for terminals also the stream / attach plumbing; the requests of an agent session (`interrupt`, `retry`, `restart`, `setResponsible`, `setMode`, `rules`) |
| `topics` | `topic.list`, `topic.updated` / `removed`, `plan.get` (per expanded or open topic), `plan.updated`, `report.updated`, `report.get` (per open report, and once per work item whose merge row is in the inbox) | topics, plans, report summaries and loaded reports; every `topic.*`, `plan.*`, `report.*` request; the toasts of a phase change |
| `inbox` | `inbox.list`, `inbox.changed` | the member's items; the two counts (waiting, the rest) for the header, the rail, the mode switch and the tab title |
| `host` | `session.host.get`, `session.host` | the account state and the main folder's trust state, for every member |
| `conversations` | `session.watch` / `history` / `cards.get`, `session.events`, `session.delta`, `question.changed` / `updated`, `permission.updated`, `suggest.updated` | per watched session: a WINDOW of the log folded into render items, the cards by id, the streaming text buffers, `firstSeq` / `nextSeq` |
| `columns` | nothing from the daemon | open columns, their order, widths (weights) and pins, the focused one, what this browser showed last (what makes a row bold), the session list's folding and filter, the session beside the editor in code mode; per browser and workspace (`localStorage['smurg.columns.<id>']`). Columns are a personal view: nothing about them is sent |
| `suggestions`, `worktrees`, and the stores of code mode (`files`, `docs`, `locks`, `presence`, `activity`, `conflicts`, `transfers`, `admin`, `workspace`) | their message families | as in 0.4.0; a new `draft` merge request replaces the worktree's earlier one |

**Columns** (`ColumnTarget` of §5.11 plus a terminal session; `MAX_COLUMNS` = 4). A thing is open at most once:
opening it again gives its column the focus. A click on a row replaces what the focused column shows; "open to the
side" adds a column to its right; a pinned column is never replaced; an inbox item opens to the side while there is
room and replaces only when the strip is full; a fifth column is refused with a notice. Dividers are separators
with arrow keys; widths are weights on the arithmetic of `ui/split-resize.ts` (`ui/Columns`, not nested
`SplitPane`s). Every scrolling part of a column is `position: relative`; container queries at 620 px and 430 px.
An inbox item opens its `target` and scrolls to its `anchor`; when the anchor's event is older than the loaded page,
the conversation loads history until it has it, focuses the CARD (never one of its buttons) and outlines it.

| Column | Built from | Notes |
|---|---|---|
| Session (agent) | `features/conversation` | below. Header strip: the responsible person (`session.responsible.set`), the worktree chip (opens code mode on that root), the permission menu (`session.mode.set`; the always-allowed kinds from `session.rules.get`, each removable; the sentence about the host's own rules), Stop (`session.interrupt`). "End session" is in "More actions", absent for a discussion |
| Session (terminal) | `features/agents` | the terminal of 0.4.0 with its fit rules ("Terminals" below) |
| Spec | `features/topics` + `DocumentPane` | Read: the Markdown renderer on the document's text, with who last changed it (`spec.lastAgentChange`, "Show in the discussion"). Edit: `DocumentPane` on `specs/<slug>/SPEC.md` (cursors, the lock banner, the deleted-file state). The revise box → `topic.revise`; "Generate plan" → `plan.generate`; "Restart discussion" when the discussion is lost |
| Plan | `features/topics` | Items from `PlanInfo` (state badges, sizes, dependencies, who is responsible and the split's source, "Allowed in this topic", who is waited for, the slots, warnings, the error state, the paused banner). Start opens the Start dialog (`plan.preflight` → `plan.start`). File: `DocumentPane` on `PLAN.md` |
| Report | `features/topics` + merge review parts | the outcome, the sections under headings from the web catalog (the file's own headings are fixed English), checks, Changes from `worktree.merge.diff` / `fileDiff` of the report's draft with the files people edited by hand, follow-ups (`report.followUp`), "I've reviewed this" (`report.review` with the version on screen), then for the host "Merge", for a member with agent access "Request merge" while nobody reviewed. The follow-up box at the foot gives way to "This item is merged and its session has ended. Ask in the discussion." only when the item is merged, reviewed AND its session has ended; while smurg keeps the session (the worktree holds changes no merge carried, §7.8 "After the merge") the box stays |
| Changes | merge review | a merge request without a report (a free session's worktree) |

**The conversation column** (`features/conversation`, store `conversations`).

- **A window, not the whole log.** `session.watch` gives the newest page (§4.3 page rule); scrolling to the top
  loads earlier pages with `session.history`; `hasMore` after a reconnect is followed with `afterSeq` until the
  column is current. The window is contiguous: an event beyond a gap waits until the missing ones were fetched; an
  event that arrives again under a `seq` the window has replaces the old one (redaction).
- **Watching.** A session is watched while it is in a column: with `live: true` while the column is on screen,
  `live: false` while its view is hidden (the other mode, or scrolled out of the strip), so hidden columns stay
  current and cost the relay no delta frames; closing the column unwatches. The store watches its sessions again
  after EVERY Welcome, resumed ones too, because deltas are volatile (§4.3); a delta beyond what a block holds
  stops that block until its `text` event (at most one new watch per session in `DELTA_REWATCH_MIN_MS`).
- **Folding.** Events are folded into render items as they arrive, so React renders a short list: a person's
  message (with its delivery state, "suggestion, accepted by …", "hidden characters were removed"); a message of
  smurg (folded to one line: "smurg asked Claude to …"); agent text (consecutive `text` blocks of a turn); a tool
  (`tool.started` + `tool.finished`; consecutive reads as one row; a subagent's events would nest under its `task`,
  and no session starts one, §12); a card (`card` → the entity from the store; `pointer` → a next-step card); a line
  or a notice. Items keep their identity between folds while nothing in them changed. Every row has its own error
  boundary: a row that cannot be drawn is the line `row.failed` ("This entry cannot be shown.") with the host's
  "Remove this entry", and the rest of the column (the other entries, the waiting cards, the composer) stays.
- **Streaming without re-rendering.** `session.delta` text is appended to a DOM text node outside React state;
  state changes only when the finished `text` event arrives. The list follows the end only while the view is at
  the end; otherwise a "New activity" button.
- **Cards.** A question card: everyone holding `discuss` votes and comments and sees the others' choices live
  (`question.changed`); the decider submits, prefilled with the leading answer; the note and a free-text answer
  only for members with agent access; the sentence that comments are for the team and the agent does not read them.
  A permission card renders the command whole, an edit as its diff, any other tool's whole input, each part in a
  box of its own that scrolls when the part is long; nothing scrolls sideways (the command wraps, and in this card
  the diff wraps too). While a box does not show all of its part, a line under it says how many lines the part has
  (`perm.more`), and "Allow once" and "Always allow this kind" stay disabled until every such box was scrolled to its
  end (`perm.readFirst`); "Deny" is never held back. "Always allow" sends `allow-always` with a scope, never a rule;
  a host-only request says that only the host can allow it. Under what is asked the card prints Claude Code's own
  reason ("Claude Code's reason: …", English as it came); for a request smurg's own gate asked for
  (`PermissionRequest.gate`, §7.7 G10) it prints the web's sentence for that gate instead, in the reader's language
  (`perm.gate.writes-settings-script`, `perm.gate.may-reach-settings-script`; in English word for word the
  daemon's `BASH_ASK_REASONS`). A suggestion card shows the stored text character for character (`PlainText`, never
  as Markdown): what is on the card IS what an accept sends. Controls a role cannot use are absent, with the
  sentence that says who can; focus lands on a card, never on Allow.
- **Next-step cards** (the `pointer` event): the text and buttons are the web's, composed from facts, never the
  model's prose ("The spec draft is ready …" [Generate plan]; "The plan is ready …" [Open plan]; [Open report]).
- **The status bar** above the composer (`StatusBar.tsx`) never cuts a sentence. The state and its age are one
  piece; the second sentence (the host's account, a refused action) stands beside them when both fit and on a line
  of its own, wrapping like text, when they do not; in a column too narrow for the state its words wrap. One
  button (the action the state calls for) stands beside the sentences in any column. With two buttons (a member
  with agent access while Claude Code is logged out on the host: "Show it" or "Try again", and "Check login
  again"; an idle long discussion: "Write the spec now" and "Start a fresh conversation") the line of sentences
  asks for 24 em whatever its words are, so where two buttons do not fit beside that they go to a line of their
  own below the sentences, at the end, and the sentences have the bar's whole width (also when the one sentence is
  as short as "Claude is idle."); three buttons wrap on that line. Only the two sentences are live regions: the
  age changes every second and is outside both.
- **Composer.** `session.message.send` for members with agent access; `suggest.create` for an Editor (the same box,
  a line saying where the suggestion goes); no box for a Viewer. Enter sends, never while `event.isComposing`; `@`
  opens the member picker and fills `mentions`. Unsent text is kept per session in this browser
  (`localStorage['smurg.drafts.<workspace id>']`). A draft can quote project code, so it is deleted when this
  person's access ends: when the daemon removed the member, revoked the device or finds the browser logged in as
  another account (whatever page shows the workspace), on "Leave", on "Log out" once the logout has succeeded
  (every workspace of the browser; a failed logout keeps them) and when a workspace is taken off the list of recent
  ones (`lib/workspace/drafts-storage.ts`). Deleted stays deleted: a deletion also changes a mark in localStorage
  (`smurg.drafts-forgotten.<workspace id>` for one workspace, `smurg.drafts-forgotten` for a logout; a random
  value that holds no time), and another tab that still shows the workspace looks at both marks, and at whether
  its own entry is still there, before it writes: it writes nothing back.
- **Markdown** (`features/markdown`): the tokens of `marked`'s lexer rendered to React elements by smurg's own
  renderer. No HTML string is ever injected (raw HTML in the text shows as text); links are `http`, `https` and
  `mailto` only, open in a new tab with `rel="noopener noreferrer"` and show their address on hover and focus;
  **images are never loaded** (an image is a link with its alt text: a remote image in agent text would make every
  viewer's browser contact a third party, and the CSP allows `https:` images); code blocks are plain monospace; a
  path that resolves in the session's root opens the file. The same renderer shows the spec's Read view and a
  report's sections. The CSP is unchanged (§6).
  - **The lexer runs inside bounds** (`lex.ts`): a text is rendered in every member's browser and must neither
    throw out of the render nor hold the page's one thread. A text over `MARKDOWN_MAX_CHARS` (1 MiB), a paragraph,
    cell or heading over `MARKDOWN_MAX_INLINE_CHARS` (16 KiB), nesting deeper than `MARKDOWN_MAX_DEPTH` (32), more
    than `MARKDOWN_MAX_STEPS` (50,000) steps of the lexer, or a parse over its time budget (`parseBudgetMs`: 40 ms
    plus 1 ms per 4 KiB of text; every step is timed, from the first, and the longest single step is not counted,
    up to `PAUSE_MAX_MS`, 200 ms: one step that stood still is a pause of the machine) is NOT formatted: it is shown
    as it was written, with the note `plain.note`. Whatever the lexer throws is caught. The lexer's expressions are
    compiled by a text of smurg's own before the first parse, so no text is shown as written because it came first.
  - **One budget per text, two at most.** The budget of time and steps is the budget of ONE TEXT, also when the
    text is shown in pieces: a message is one piece; the spec column cuts `SPEC.md` at its `##` headings and renders
    it with `<MarkdownPieces>` (`lexMarkdownPieces`), and all its sections share the one budget of the whole text.
    What is remembered when a budget runs out is the PIECE it ran out on, by a hash of its characters (the newest
    `REMEMBERED_MAX`, 1,024): every text that holds that piece shows it as written, at the cost of the hash, and
    formats the rest, and a text that no longer holds it is formatted whole. The pieces behind the one it ran out
    on wait and get the budget once more; a text in pieces that runs out a second time is over as a whole: shown
    as written under one note, remembered as a whole, and from then on it costs its hash. So a text costs two
    budgets at most, and every budget that is spent leaves one more piece remembered. A piece that is too deep or
    holds too long a paragraph is shown as written by itself.
  - **The page's share, and what waits.** The parses a mount waits for take at most `URGENT_PARSE_MS` (200 ms) AND
    `URGENT_PARSE_STEPS` (50,000 steps: texts that are parsed in no time and are tens of thousands of elements to
    build wait like the slow ones) in any `URGENT_WINDOW_MS` (1 s). A text that comes after the share is spent is
    shown as written for the moment, without a note, and formatted when the browser has nothing more urgent to do
    (`idle.ts`, `formatWhenIdle`): one slice of `SLICE_MS` (30 ms) at a time, at least one text a slice, what is on
    screen first and the newest first, each slice a background-priority task of its own (`scheduler.postTask`; a
    timer where a browser has none). Not a React transition: React renders everything that is left in one piece
    once a transition is five seconds old. One text is never cut, so the longest task is one slice or one text,
    whichever is longer (the limit this leaves for a long `SPEC.md`: §12).
  - **Nothing of a text is hidden.** What Markdown keeps out of sight is put on the page: a reference definition is
    printed as its line, a destination that is not a link stays in the text as it was written, a link's or an
    image's title is printed after it, the whole line after a code fence stands above the code, a link without text
    shows its address, and a link or an image whose words name another place than it leads to is drawn as its words
    followed by the destination as the link. Words are read as a place (`links.ts`, `namesAnotherPlace`) when they
    are an address (`https://…`, `www.…`, a mail address, a number address), a host with a path under any ending,
    or a bare host under one of about fifty well-known endings (`HOST_ENDINGS`). Characters that only look like
    ASCII are read as what they look like (NFKC, one character at a time: full-width letters, the dots U+FF0E,
    U+2024 and U+FE52; a Chinese full stop, U+3002 or U+FF61, between two letters of scripts written with spaces is
    the dot). Characters a reader cannot see (Unicode's default ignorable code points: zero width joiners and
    spaces, the word joiner, a soft hyphen, variation selectors, the tag block, a byte order mark) are not read,
    and words that had one beside the dot of a name (`github<U+200D>.com`) are written out with the destination
    wherever the link leads. A dotted name with ANY letter from outside ASCII is never taken at its word: its
    destination is always written out, also when the link leads to that very name. The one exception is words that
    are the NAME OF THE FILE the link leads to (the last part of its path, decoded, character for character, no
    slash in it): an ordinary link whatever letters they have, unless a dot of the name is followed by what a host
    ends in or by letters from outside ASCII. Chinese, Japanese and Korean characters around a Latin name are the
    sentence it stands in, not part of the name. Words longer than `LABEL_MAX_CHARS` (1,024 UTF-16 units) are
    written out with the destination, unread, and an address whose host part is longer than a host name with a
    port (253 + 6 characters, `lib/web-address.ts`) is not a link. Any other link keeps its destination behind
    hover and keyboard focus; which look-alikes that leaves as ordinary links is in §12. A numeric character
    reference never becomes a character nobody can see (`&#x202E;` stays as typed).
  - **A render has no time budget**, so every look at a text while rendering is a single pass over its characters:
    no regular expression that is tried again from every character of a long run, and no call of `normalize`, of a
    collator (`localeCompare`, `Intl.Collator`) or of the address parser (`new URL`) on a text whose length someone
    else chose, because each of them puts a run of combining marks in order at the cost of the square of the run.
    A link's words are normalised one character at a time, names in lists are ordered through the protocol's
    `withFewMarks` (`compareText`), ids by their UTF-16 units (`compareIds`), and `new URL` is handed only an
    address whose host part has a host's length. `apps/web/test/text-cost.test.tsx` walks hostile texts through
    every function that looks at text someone else wrote and keeps the lists of every regular expression and of
    every such call, by file (§10).
  - **Path lookups are bounded.** At most `MAX_PATH_LOOKUPS` (32) different paths of one text are asked about, each
    once, and only when its element comes on screen. Every lookup of a conversation or a terminal goes through ONE
    gate per connection (`features/agents/path-links.ts`, `createPathGate`): a name the reader's role can never
    open is not asked about (`mayAskAbout`); one request is out until the host has answered one without refusing,
    and again after every refusal, else at most `MAX_LOOKUPS_IN_FLIGHT` (4); a refused path is never asked about
    again; and a page collects at most `REFUSALS_PER_MINUTE` (8) refusals in any `REFUSAL_WINDOW_MS` (60 s), after
    which what waits is answered without a request. Reading a text can cost its reader a handful of refused
    requests, never one per name (the daemon counts refusals per connection, §5.8; a lookup of a place the reader
    may not look at is no refusal, §5.2).

**The left column** (`features/sidebar`): the inbox above the session list, both collapsible. The inbox has two
groups, "Agents are waiting" (the items with `waiting`: the ones only I can settle first, then oldest first) and
"For you to look at" (the rest, newest first), and two counts. Rows are composed in the web catalog from the item's
structured fields (§5.11); nothing parses an excerpt for meaning. A merge row of a work item leads to the item's
result report when that report is about the row's request, else to the request's Changes column (`inboxTarget`).
The inbox asks about the report when the row appears (`report.get`, once per item; "there is no report" is
remembered), so a click opens the right column at once; a click that comes before the answer opens the report's
column, which shows that it is loading, and the Changes column takes its place in the same column when the answer
says so. The session list is a real `tree` grouped by
topic (a topic's fixed rows for its spec, plan and discussion, then its items' sessions; free sessions under "No
topic"; terminals), with a filter (All / Mine / Waiting); a row is bold when the session's `noteworthyAt`, or a
topic's spec or plan change, is newer than what this browser showed.

**Code mode** is the workbench of 0.4.0 with three changes: the right pane is ONE session column (the same component
as in the sessions view, with a selector for which session); the drawer's tabs are Activity, Conflicts, Transfers
and Terminal (plain terminals), without merge requests; the suggestions panel is gone. `openInCodeMode` opens a file
of a session's root with that session beside the editor and "Back to the session" above it. "Send to agent" from a
selection fills the side column's composer (a message or a suggestion by role), headed by the fixed `path:12-20`
(one line: `path:12`). In an item's worktree the folder `specs/<slug>/` is read-only for everyone (§7.4); the
editor's read-only banner says why. A new "agents are waiting" item whose session is in no visible column shows a
toast with "Open".

**Terminals** (`features/agents`). The panel of the member who opened a terminal drives the PTY size: columns and
rows are fitted to the visible area (`terminal-fit.ts`, sent with `session.attach` and then as `exec.resize`), with
a floor of 20 × 5; everyone else, other drivers included, renders at the PTY size with visible scrollbars and
"Scale to fit the width" (a CSS scale; the daemon refuses another member's resize). A terminal that ended says why
(`endReason` / `endedBy`); "Attach from your own terminal" shows the `smurg attach` commands, for terminal sessions
only. Suggestions are not offered on a terminal (§11 D-19). An ended terminal leaves the list when the daemon
forgets it (§7.6 "After the end"); closing a column is each member's own view and nothing is sent.

**What 0.5.0 removed from the interface**: the agents panel's session tabs (the left list and the columns replace
them) and the per-browser closing of an ended session's tab; the suggestions panel and queue (suggestions are cards
in the conversation and inbox items); suggestions on a plain terminal; the drawer's merge-requests tab (an inbox
item and the report or Changes column: a merge row of the host's inbox opens the item's result report when that
report is about the row's request, else the Changes column of that request); the terminal UI of Claude Code inside
an agent session (§11 D-16).

Language (§1 Languages): `localStorage['smurg.lang']` → cookie `smurg_lang` → the first entry of
`navigator.languages` that is English or Traditional Chinese → `en`; `<html lang>` is `en` / `zh-Hant-TW`.
`src/boot/locale.ts` is the second import of `main.tsx` (after `capture-invite`, before the catalog and every
component), so the first render is already in the right language. `src/lib/locale.ts` is the one controller: the
catalog and the `Intl` formatters read the language at call time (`t('key')` takes no locale). The switch
(`LanguageMenu`, a globe button on the landing page, the join / login / connection screens, the not-found page and
the workspace's top bar; each language named in itself) records the choice in localStorage, mirrors it into the
cookie `smurg_lang` (the relay's attributes, §6), so the relay's `/device` page follows, and re-mounts the route tree,
which `app/App.tsx` keys by the locale: no reload; the stores, the services and the connection are kept, component
state is lost, and a toast on screen or an error sentence already in a store keeps the old language. Monaco and
xterm.js are not localised.

Strings: `defineStrings(namespace, en, zhTW)` (`src/strings/catalog.ts`); the English table (`strings.ts`) defines
the keys and its sibling `strings.zh-TW.ts` must have exactly them (a missing key is a compile error, an extra one
an error at load). A value is a template with `{placeholders}`, or in English the plural pair `{ one, other }`
chosen by `count`; a key that counts two things is two keys. `src/strings/strings.test.ts` checks the parity of the
two tables (keys, placeholders, plural forms), that English text holds no CJK and zh-TW text is Traditional Chinese,
and that no key is unused; it finds every `features/<f>/strings.ts` by convention (the namespace is the folder's
name), so a deleted panel takes its strings along.

Wire texts: What the daemon says is rendered here: errors as
`render(locale, error.text) ?? render(locale, defaultErrorRef(error.code)) ?? error.message`, activity lines as
`render(locale, event.text) ?? event.summary`, a conversation's lines and notices and a plan's or a report's
findings as `render(locale, ref) ?? fallback`, daemon-written notifications as `render(locale, n.msg) ??
n.fallback`, role labels with `roleLabel(locale, role)`, a session nobody named with `sessionTitleRef(session)`. A
fallback or a `summary` is never parsed. Inbox rows, card sentences, next-step cards and plan badges are composed in
the web catalog from structured fields. The web's own code-based wordings (connection states, session end reasons,
reason hints, transfer failures, audit labels) stay in the web catalog. Text written by people or agents (messages,
questions and their options, the spec, reports) is never translated.

Accessibility: regions and F6 between them; the session list is a `tree` with roving focus (row actions through the
context menu and the keys, no buttons nested in a row); a column is a `region` whose accessible name is its title,
with the topic's name for a discussion, a spec, a plan or a result report ("Plan · Checkout redesign": two of them
side by side have different names; the header's buttons and the divider carry the same name); every card is a
`section` with an `h3`; the conversation is a log with `aria-live="off"` and the status bar above the composer is
the `status` that speaks (streaming text is not announced delta by delta); a new "agents are waiting" item is
announced politely; every status glyph and kind icon has a name, and nothing is conveyed by colour alone.

As built before 0.5.0 and still true (details in `apps/web/README.md`):
- `/join/:id` waits for an explicit "Join" before any connection (§4.1).
- Documents: a tab whose file is deleted turns read-only with who did it and "Create again from this content"; a renamed file's tab
  follows it (the renamer's) or offers "Open the new location" (everyone else), read from the `file.rename` activity event's `renamedFrom`
  (§5.4). Text typed while the host was unreachable is kept across a new epoch: re-applied when the
  host's text did not change meanwhile, otherwise offered back in a recovery notice (replace with my version / copy / discard);
  there is no automatic 3-way merge. `doc.rejected{file-unavailable}` says the unsaved text is in the
  conflict panel.
- Roles (§11 D-15; `lib/capabilities.ts`): the console shows the risk in an alert dialog (`RoleRiskDialog`) before an
  `agent` invite is created or a member is set to `agent`, and asks before taking the role from a member; its kick /
  demote / leave texts name what ends, what passes to the host and what is removed (§3 "When a member goes"), and
  the invite dialog says that a new member can read every earlier conversation of the workspace. A logged-out agent
  (the host's Claude login) shows one sentence in the status bar (members with agent access also get "Check login
  again"). There is no login guide, login process, API key field or settings import.
- The activity feed shows an agent's shell edit (§11 D-13) as that agent's, with a small "via a command" marker taken from
  `ActivityEvent.via === 'bash'` (never from the wording); "an outside program" appears only for the daemon's `system`
  actor. Every line is `render(locale, event.text) ?? event.summary` (§5.4).
- The host can force-release a lock from the editor banner and the tree's context menu; the console's invite
  list refreshes on joins; the audit log shows each entry's details; merge decisions reach the requester as a notice and everyone's activity feed.
- Workbench layout (`app/workspace/layout-limits.ts`, `ui/SplitPane.tsx`): the file tree's separator leaves
  `minRightOfFiles()` to its right: the editor's minimum alone, or, while the session column is shown beside it, that
  plus the column's own minimum and its separator, so a wide remembered file tree in a narrow window cannot squeeze
  the side column below its minimum and freeze its separator. `SplitPane` shows the remembered size clamped to the
  container it observes (`ResizeObserver`) and reports the size shown (`aria-valuenow`); a drag starts from the size
  on screen and moves only while the primary button is held.
- Login buttons ("Log in with Google" / GitHub) come from one `GET /api/login-options` (§6; strict schema, `redirect: 'error'`; on any failure GitHub
  and Google are offered and the dev login never is). `/api/me` is asked only while the host-scoped cookie
  `smurg_hint=1` says a relay session may exist (set when a login starts, on a 200 and when a workspace connects;
  cleared on 401 or logout), so a logged-out page load has a clean console (the relay keeps `/api/me`'s 401: the SDK,
  the CLI and its tests rely on it). The cookie carries no identity and grants nothing.

---

## 10. Testing

| Layer | Where | What |
|---|---|---|
| Unit | each package `src/**/*.test.ts` | schemas, path guard, lock manager, reconcile, invites, permissions matrix, framing; in `packages/protocol` also the pure functions every package shares: who decides (`routing.test.ts`), what may be always allowed (`rules.test.ts`), text for agents (`agent-text.test.ts`), masking (`mask.test.ts`), votes, tools; `schema/registry.test.ts` (the registry against §5) and `schema/worst-case.test.ts` (no message can exceed an Envelope) |
| Crypto vectors | `packages/protocol` | Noise test vectors, tamper/replay/wrong-PSK/wrong-key |
| What a text costs | `test/text-cost.test.ts` in `packages/protocol`, `packages/daemon` and `packages/cli`; `apps/web/test/text-cost.test.tsx` | every function that is handed text a member or an agent wrote (a message, a suggestion, a name, a path, `SPEC.md`, `PLAN.md`, a report, a shell command, the output of a tool; in the web app everything that looks at such a text while a page renders) is walked with one list of hostile texts, runs of one character and of two in turn (blanks, punctuation, combining marks), at one size and at sixteen times that size, measured in processor time: sixteen times the text may cost about sixteen times as much, never the square of it. The walk is `packages/protocol/src/testing/text-cost.ts` (`@smurg/protocol/testing`). Each file also pins, per source file, how many regular expressions, sorts and normalisations its package holds (the web's: every regular expression and every call of `normalize`, of a collator and of `new URL`), so a new one changes a number there and is looked at first. `packages/protocol/src/normalize.ts` is the only place of the three packages that calls `normalize` (§5.9 "Text for agents") |
| Integration | `packages/daemon/test` | daemon + in-memory transport + headless client. The core's own suites (`test/*.test.ts`: authorization over every request × every role, the control socket, composition, wire texts, audit, rates, hub fan-out, the member teardown, PathGuard's rules, the fakes) and one folder per module, each composing its REAL module with in-memory fakes of the others (`core/fakes`, §7.2) |
| Agent runtime with the stand-in | `packages/daemon/test/sessions`, `test/hooks`, `test/conversation`, `test/topics`, `test/inbox`, `test/mcp`, `test/worktree` | the real modules against the **stand-in `claude`** (below): a session that asks, edits, waits, stops, parks, fails and resumes on cue; questions, votes and permission decisions by role; the plan format, the split, the scheduler with its pins, reports, real git; the inbox per kind × role × who is responsible; the tool gate's table; `agent-replay.test.ts` (the lines recorded from Claude Code 2.1.288 through the normaliser and the real runner, every resulting event validated against the registry) |
| Real Claude Code, fake API | `packages/daemon/test/sessions/agent-claude-real.test.ts`, `test/sessions/trust-claude-real.test.ts`, `test/hooks/claude-e2e.test.ts`, `claude-bash.test.ts`, `claude-failmodes.test.ts` | the **real-Claude suite** (below): the real `claude` binary of the verified version against the mock Anthropic API. Skipped, loudly, on a machine without it |
| Module integration | `packages/daemon/test/integration` | the REAL modules together (`createTestDaemon` without `modules` = DEFAULT_FEATURE_MODULES): docs + locks + hooks through the real `smurg hook` entry; people and the agent on the spec in turns (`spec-coedit`); suggestions into a conversation (`suggest-conversation`); work items in worktrees (`worktree-items`); files + locks + docs; the real CLI's status / attach / stop on the control socket. And the release composition with nothing faked but the model (the stand-in `claude` through the real runner, the real `smurg hook` and `smurg mcp`, real git), four people as SDK clients: `release-composition` (a free agent session end to end, also after a restart) and `release-flow.session` / `.topic` / `.restart` / `.members` (a free session; one topic from the discussion to the archive; a restart of the daemon and a killed agent process; a member removed, a lost discussion, a free session in a worktree) |
| Acceptance (E2E) | `tests/e2e` | real relay (local workerd) + daemon + headless clients: `r1.*` … `r11.*`, `workspace.test.ts`, `device-login.test.ts`, with `r2.agent-role.test.ts` for the `agent` role |
| Browser | `apps/web/e2e` (playwright-core + system Chrome) | join flow, "Host offline", key-mismatch warning (Vite dev server) |
| Built app | `apps/web/e2e/smoke` (own vitest project; at most 2 files at once, in the full gate after every other project) | `vite build` once, served by the real relay's Worker assets (`startLocalRelay({ webDist })`), a daemon with every module, system Chrome through `chromeLaunchOptions()` (§0 rule 4; never anyone's own browser), agents played by the stand-in `claude`. Per feature: the columns and their dividers under a real mouse, the left column, a conversation (and its rendering budget: a transcript of 5,000 events opens within 300 ms of scripting, a 60 s stream keeps every frame under 16 ms), topics, the console. Across features: the whole flow with four browser contexts (topic → question and votes → spec → plan → Start → permission → report → review → merge → a conflict → the mode switch → a restart of the host's smurg → a killed agent process), the short path in Traditional Chinese with a Chinese topic name, one short pass with the REAL `claude` against the fake API (`flow.claude.smoke`, only when `SMURG_TEST_CLAUDE_BIN` names the binary), and what 0.4.0 had: join → type → disk, two-browser co-editing, the agent-lock banner, a terminal running as the host, the console's one-click terminate / kick (R11.1c), a worktree merge (R9), a real conflict (R8.4), an upload resumed after a dropped transfer socket (R7.3), a logged-out page load with a clean console, the terminal size, the two languages, the dividers of code mode. `SMURG_TEST_CHROME=/absolute/path` names the browser on a machine whose Chrome is somewhere else (the Linux arm64 VM: a Chrome for Testing that is already there); nothing is ever downloaded |

**The stand-in `claude`** (`packages/daemon/src/testing/fake-claude.mjs`, `installFakeClaude(dir, scenario)` of
`@smurg/daemon/testing`). A stand-in for the executable that speaks the same bidirectional stream-json control
protocol the agent runtime speaks with Claude Code (`--version`, `auth status --json`, `initialize`,
`list_permission_rules`, `can_use_tool`, `interrupt`, `--session-id` / `--resume` with their refusals), with no
model and no network: what the "agent" does is a SCRIPT (a scenario file, read again at every turn): text with
deltas, thinking, tool calls that run the PreToolUse hooks of the session's real settings file first, ask for
permission when the session's rules say so, then really write, edit or read files and call smurg's real MCP
command; a question; a sleep, a wait for an interrupt, an exit, an API retry, a rate limit, a compaction. Where
the runtime's safety rests on how Claude Code behaves, the stand-in behaves as 2.1.288 was measured to: it answers
`initialize` and `list_permission_rules` in the recorded shapes (`fixtures/claude-2.1.288.control.jsonl`, replayed by
`agent-replay.test.ts`), reads the host's own settings files and runs their hooks, takes a `PreToolUse` hook's `ask`
and its rewritten input, reads a rule's path like the real CLI, names the subagent tool `Agent` to hooks, and
expands an `@path` when a message lacks `client_composed`. It can record everything it was told (argv, the role
prompt, the settings, every stdin line), for the tests that check what an agent was told. So every package tests against an agent that behaves on cue, and CI needs no Claude Code.
It is test-only: a composition test of the CLI follows the import graph of `packages/cli/src/main.ts` and fails
when anything under `packages/daemon/src/testing`, the fakes or the protocol's builders is reachable.

**The real-Claude suite.** The tests that start the real `claude` binary run it against
`test/hooks/mock-anthropic.ts` (a fake Anthropic Messages API on 127.0.0.1 whose answers are scripted) with a dummy
key and an environment built from nothing (temporary `HOME` / `CLAUDE_CONFIG_DIR` / `TMPDIR`), and signal nothing
but the process group they spawned (§0). They need a verified version on the machine (`claude` on PATH, or
`SMURG_TEST_CLAUDE_BIN`) and print why they were skipped otherwise. What they prove on the real binary: the
discussion profile holds on a host whose OWN settings allow everything and who has a user-scope MCP server; a
command asks, "always allow" reaches the running process and the next process's settings file, and the host's own
allow rule applies without asking; the read rules hide the host's private files from Grep and refuse `cat` of them
and leave `git status` alone; the tool list of an execution session is the pinned one; stop, park and resume; both
refusals of Claude Code about a conversation id; the trust gate (unconfirmed project settings are not loaded); a
restart and an orphan; every tool is refused when the daemon is unreachable; an `@path` in a message, in the note of
an answer and in a denial is text, and no file reaches the model without a tool call; a command a hook of the
host's own settings rewrote is the one the card shows, allows and records; no subagent starts; a shared folder with
parentheses and brackets in its name; in a worktree, with allow rules of the host's own, every route onto a script
of confirmed project settings asks a person and ordinary commands beside it run unasked; and `claude auth status`
counts a project's `apiKeyHelper` as a login only when it is asked inside that folder. Running these suites on a new Claude
Code version is what adding it to `claudeVerifiedVersions` means (§7.6), and it is a step of a release
(`docs/RELEASING.md`).

**What this verification is, and what it is not.** The whole flow of 0.5.0 is verified against a scripted stand-in
model and against the real Claude Code binary talking to a fake Anthropic API. **No test, and nobody on the team,
used a real Claude account** (§0 rule 2; the owner's decision). So every MECHANISM is exercised (the control
protocol, the tool gate, permission rules, cards, the plan and report formats, the scheduler, restarts), but the
behaviour of a real MODEL is not: whether it asks its decisions through `AskUserQuestion` as its role prompt says,
calls `check_plan`, `propose_split` and `check_report`, keeps item ids when it updates a plan, writes the report in
the fixed format, and resolves conflict markers well. The in-band checks, the automatic `fix-*` and `nudge-report`
messages and the attention items bound what a deviation costs, and the prompts (`topics/prompts.ts`) may need
tuning after the owner has tried the release with a real account (§12).

**Time in tests.** The test clock fires no timers, and the host setting `escalateAfterMs` cannot go below a minute.
Every rule that waits (the escalation of a question, a permission request or a report; "offline for a minute";
parking) therefore stores WHEN it began, compares with `ctx.clock.now()`, and looks again on a real interval of
`config.agents.escalationSweepMs`: a test sets the sweep to a few milliseconds (`createTestDaemon({ agents })`),
calls `advanceClock`, and waits for the effect (`test/harness.test.ts`). Never one timer per waiting thing.

Languages in tests: every package asserts English by default and has a small zh-TW suite; every test names its
language and nothing under test reads `LANG`, the system language or `navigator.languages` implicitly (a spawned CLI
or installer gets `SMURG_LANG=en`, the web setup pins `en`, browser contexts set `locale`, fetches of the relay's
pages send an explicit `accept-language`). The daemon and the protocol have nothing
to pin: their tests assert codes, reasons and message references (`toMatchObject({ code, detail: { reason }, text:
{ id, params } })`, activity `{ kind, text: { id, params } }`), the gate's denies against `hooks/deny-text.ts`, and
`packages/daemon/test/wire-texts.test.ts` checks statically that no wire error in the daemon is made from a string
literal, that the daemon's source has no CJK and that every catalog id is used. Catalog parity (both locales render
for every id and sample, every parameter is used, every enumerated value has its own wording) is
`packages/protocol/src/i18n/catalog.test.ts`. Enforcement across the repository is the root vitest project
`tests/lint` (a folder with a vitest config and no package of its own; the root `tsc` checks it), one file per rule:
`no-cjk.test.ts` (§1 Languages, rule 6: the zh-TW files and the mixed files with the rule their Chinese lines follow
are listed there; `docs/research/` and `docs/design/` are exempt; test files may hold Chinese data but no Chinese
title), `catalog-parity.test.ts` (across packages:
every catalog has the two locales key for key; words two packages show for one thing are the same words, such as the
language names, the role labels, "Host offline" and the key-change title the CLI quotes from the web app, the login
button of the relay page and the web app; English says "log in", never "sign in"), `docs-parity.test.ts` (every user
document has its zh-TW counterpart with the same numbered sections; both changelogs carry the same sections with as
many entries each, `[Unreleased]` included), `docs-quotes.test.ts` (a list of catalog messages the guides and the
product page must quote as rendered, and the reverse: every quoted text of a guide is catalog text or a listed
exception), `pinned-locale.test.ts` (a test that starts the CLI or the installer, opens a browser context or fetches
a relay page names its language; only `*.zh-TW.test.tsx` pins zh-TW in the web unit tests, and the app shell and
every folder of `apps/web/src/features` has such a suite),
`acceptance-refs.test.ts` (every `file` › "title" reference of `docs/ACCEPTANCE.md` is a test that exists) and
`pending.test.ts` (the list of what was still open while the packages of 0.5.0 were built in parallel,
`pending-v050.ts`, and its callers stay in step; with `SMURG_RELEASE_GATE=1` that list, and the daemon's two lists of
stubbed modules and unproduced catalog ids, must be empty).

R3's acceptance criteria are the hard gate: each criterion has a named automated test, listed in `docs/ACCEPTANCE.md`.
(R5, the guest sandbox, was the other one until it was withdrawn on 2026-10-01, §11 D-15.) 0.5.0 adds the family T
(the topics flow: T1 discussion and questions, T2 the spec, T3 the plan, T4 execution, T5 reports and review, T6 the
inbox, T7 the two views, T8 restart and the second language) beside R1–R11, each row with its tests.

Harnesses: `@smurg/daemon/testing` (`createTestDaemon`: in-memory relay with a byte tap, test identity issuer, temp
project optionally a git repo, real SDK clients; `installFakeClaude`; `createTempRunDir`, `isolatedGitEnv`, …),
`@smurg/daemon/fakes` (`fakesModule`, `createFakes`: the modules a test does not build, §7.2),
`@smurg/protocol/testing` (builders of every entity, shared with the web's tests; the walk of hostile texts of
"What a text costs") and `tests/e2e/src/harness.ts`
(`startStack`: real relay + daemon + clients; `git: true` shares a git repository; the host gets a fake home and a short
socket dir). `tests/e2e` also depends on yjs / y-protocols / lib0 and `@xterm/headless` + `@xterm/addon-serialize` for
the R7.1 (two Y.Docs) and R4.1 (terminal state) acceptance tests. Roles in both harnesses are `agent`, `editor` and
`viewer` (`createInvite(role)`, `join({ role })`).

---

## 11. Deliberate departures from the wording of SPEC.md

Each of these keeps the intent of the requirement and is backed by a verified finding.

**Status: D-1 to D-11 were reviewed and approved by the maintainers on 2026-09-28.** A departure added after that
is marked in its row until it is confirmed. D-15 (2026-10-01) removed the guest sandbox and with it D-12 and D-14
(both withdrawn) and the guests' half of D-4 and D-9. D-16 to D-23 (2026-10-05) record 0.5.0: the owner's brief
(`docs/design/v0.5.0/OWNER-BRIEF.md`, `OWNER-DECISIONS.md`) supersedes SPEC.md's wording of R4 (agent sessions) and R6
(suggestions), and SPEC.md itself is not edited. Rows written before 0.5.0 keep their wording where it still holds;
where 0.5.0 changed what a row says, the row says so ("0.5.0:").

| # | SPEC says | We do | Why (evidence) |
|---|---|---|---|
| D-1 | R4: guest hooks are written to `settings.json` in the temp dir; host hooks to `<project>/.claude/settings.local.json` | Hooks are passed to every agent session with `claude --settings <daemon-owned file>`. Nothing is written into the project's `.claude/`. 0.5.0: the same file carries the tool gate for every tool and the session's permission rules (§7.6 "Launch"; D-21). | Both SPEC locations work but are writable by other people: a guest's own agent can edit its config dir, and collaborators can write project files. A project-level `disableAllHooks: true` silently turns off hooks from the other locations, which would bypass file locks. The host's global settings are still never touched. (`claude-hooks.md`) |
| D-2 | D6 / R9: agents work in a **git worktree** | The user-facing concept and the location `.smurg/worktrees/<id>` are unchanged, but each one is created with `git clone --shared --no-checkout` instead of `git worktree add`. | A real `git worktree` forces the sandbox to grant the guest write access inside the main repository's `.git` (objects, `worktrees/<name>`, refs), which contradicts R9's "cannot read or write the main workspace". A shared clone needs read access only. (`sandbox.md`, verification section) Kept after D-15 (no sandbox any more): a session in a worktree still writes nothing into the main repository through git, and every merge goes through the host's review. |
| D-3 | R2: a kicked user's session processes are terminated | Terminated: the PTY's process group (0.5.0: for an agent session the process group of its `claude` child), all descendants, and every process carrying the session's id in its environment. **Not** covered: a process that deliberately detaches (`setsid`) *and* scrubs its environment, on macOS and (since D-15: no sandbox, no PID namespace) on Linux. Such a process keeps running as the host's user. | The only way to find such a process on macOS is to scan every process on the machine with a private API and kill what matches. Two research spikes that tried this killed unrelated processes of the host user. The risk of harming the host outweighs the benefit for a prototype. Measured since: macOS reuses freed pids within milliseconds (so kills are identity-checked, §7.6), and `ps -E` hides the environment of Apple platform binaries (`/bin/sleep`, `/bin/sh`, `/usr/bin/python3`), so a platform-binary job orphaned before the first 2 s descendant scan also escapes a natural exit. 0.5.0: the same holds for what an agent's commands leave running. Each command of an agent runs in a shell of its own, so a `&` job is orphaned at once and is found only by the session's id in its environment: on macOS a job of an Apple platform binary is found only when the 2 s scan saw it while its shell still ran; a `node`, a `pnpm`, a `python` from Homebrew, a `cargo` is found. |
| D-4 **(withdrawn 2026-10-01, D-15)** | R5: "read: deny the host's home by default" | Was: srt's read model (everything readable, then broad `denyRead` regions, then `allowRead` carve-outs). There is no guest sandbox any more (D-15). | — |
| D-5 | R3: the relay can only see workspace id, connection id, message size and timing | Also true for content, keys and device ids. But the relay performs the login, so it additionally knows the **account identity and IP address** of each connection. | Inherent to R2 (login at the relay). Stated openly rather than hidden. (`relay.md`) |
| D-6 | R8: `FileChanged` hook as the basis of the fallback | The fallback is driven by the daemon's own file watcher; `FileChanged` only feeds the activity feed. | `FileChanged` watches literal file names in the cwd only and misses the first moments of a session. (`claude-hooks.md`) |
| D-7 | §6: packages `web`, `relay`, `daemon`, `cli`, `protocol` | Adds `tests/e2e`. | Acceptance tests must depend on every package. |
| D-8 | R3: on a kick or a role change the daemon revokes the member's device keys | A **kick** revokes every device key of the member. A **role change** does not revoke keys: it closes the member's channels (`channel.closed{role-changed}`), the router applies the new role to the very next message, and the client reconnects with the same key and a fresh Welcome. Losing the right to open sessions (a role below "Agent access", D-15) ends the terminals and free agent sessions the member opened; 0.5.0: the sessions of their topics pass to the host and keep running (D-17). | Revoking the keys on a role change would lock the member out: they could only come back through a new invite, which makes "change a role" the same as "kick". What the requirement protects against — the old role still being usable — is achieved by the per-message role check and the channel close. |
| D-9 | R4: guests are logged out and their temp dir deleted when the guest leaves | "Leaving" is the explicit "Leave" (`channel.leave`): the terminals and free agent sessions the member opened end within 5 s; 0.5.0: the sessions of their topics pass to the host and keep running (D-17). A disconnect (closed tab, sleeping laptop) keeps them, because R4 also requires sessions to survive disconnects. (Until D-15 leaving also deleted the guest dir with the guest's Claude login, and guest dirs of members not connected for 7 days were removed; there are no guest dirs any more.) | A disconnect is indistinguishable from a network blip; ending sessions on every blip would break R4's rule that a session keeps running on the host when its client disconnects. |
| D-10 | R1: every refused request is refused and recorded | Every refusal is recorded, but a flood is recorded in bounded form: beyond 120 refused requests per actor and origin (the relay channels; the control socket, §8) per minute the audit log writes one "rate limited" entry and one summary with the count instead of one line per request, and a connection with more than 60 refusals in a minute is closed. | Without a bound, the lowest role (a viewer) could grow `audit.jsonl` on the host's disk without limit and push real entries out of every page. The fact of every refusal and its count stay in the log. |
| D-11 | D3: the host's session is not sandboxed | The host's agent is still refused (PreToolUse deny) an Edit / Write / NotebookEdit of a file outside the shared folder; Bash is unaffected. | The lock decision (since 0.5.0 row G8 of the tool gate, §7.7) can grant locks only inside the session's root; allowing unlocked edits elsewhere would also let a main-root agent edit a worktree's files around their locks. The maintainers chose to keep this fail-closed behaviour (the alternative considered: outside every root → no decision, host sessions only). The deny reason tells the agent's owner that the file is outside the shared folder. |
| D-12 **(withdrawn 2026-10-01, D-15)** | R4 login guide; §13 (the Claude Code login flow in a remote PTY) | Was: a guest's own Claude subscription login as a dedicated, sandboxed login process (session kind `login`). Gone with the guest sandbox: every session uses the host's Claude login (D-15). | — |
| D-13 **(implemented 2026-09-29; switchable, on by default)** | R8 acceptance: every agent edit appears in the activity feed, saying which agent and whose it is; R11: the audit log covers agent edits | Edit / Write / MultiEdit / NotebookEdit changes (PostToolUse) and FileChanged-hook reports are attributed to the agent as before. NEW: **non-blocking Bash attribution.** A separate Bash ACTIVITY hook (`smurg hook bash-activity`, PreToolUse / PostToolUse / PostToolUseFailure of `Bash`, §7.7) only tells the daemon when a session starts and finishes a shell command; it never takes a lock, never decides, and fails OPEN by itself (daemon unreachable ⇒ it prints nothing and nothing is attributed). 0.5.0: whether the command RUNS is no longer this hook's alone: the tool gate (D-21) is asked before every tool, Bash included, and fails closed, so while the daemon is unreachable no command runs; with the daemon up the gate gives a shell command no decision and Claude Code's permission flow goes on. A disk change that nobody claimed (no agent lock, no Post echo, no announced writer) and that falls inside the Bash window of EXACTLY ONE session (every session runs unsandboxed since D-15, so any of them could have written anywhere), with 3 s of grace after the command ended (watcher latency), and whose root contains the file, is that agent's: `agent.edit`, `activity.agentBashChange` ("Claude (Cart API) changed ... with a shell command": the session's agent name, D-20), marked `via: 'bash'` in the feed entry (§5.4) and the audit entry; two or more such windows, none, or a writer of another root: "an outside program" as before — and then not even the worktree rule below names anyone. In a worktree without a Bash window an unannounced change is still attributed to the one agent session running there, else to the worktree's owner. The decision is announced as `agent.tool.post` (tool `Bash`, the file), so the file tree badge and the R8 fallback's conflict record (whose source) follow the same rule; the fallback itself (human text kept, conflict record) is unchanged. Switch: `config.activity.attributeBashEdits` (default true; false ⇒ the Bash hooks are not registered and Bash events are ignored). Explained in `docs/HOSTING.md` §5, not on the host's terminal; `smurg status` shows whether it is on. | A session can forge Bash windows with its own token: they only ever attribute changes inside that session's own root, and only to that session (an agent can claim unannounced changes of its own root, never frame another agent or a person; while its window is open, an unclaimed change elsewhere is "an outside program" instead of anyone's); forged windows are paired by `tool_use_id`, capped (8 open, 10 min each) and rate-limited (240 / min, burst 60). Known limits: a change the host's own tools (an editor outside smurg, a terminal) make during an agent's Bash window in the same root is attributed to that agent; for 5 s after a person's autosave the file module attributes any change of that file to that person (not part of this rule). Cost: ~52 ms per hook invocation with the dev entry (two per Bash call). Tests: `daemon/hooks/hook-cli.test.ts` (Bash hook exits 0 with no output within its deadline in every error case while the Edit hook denies), `hook-server.test.ts`, `settings-writer.test.ts`, `claude-bash.test.ts` (real claude: a scripted Bash edit in the activity feed as the agent), `daemon/locks/activity.test.ts`, `bash-attribution.real-modules.test.ts` (the conflict record's source). |
| D-14 **(withdrawn 2026-10-01, D-15)** | R9: opening an agent session offers the shared main workspace or a worktree of one's own | Was: guests' sandboxed sessions kept out of the main workspace by default on a Linux host (`--allow-main-workspace-guests`, `PublicSettings.guestMainWorkspace`). Gone with the guest sandbox: R9's choice is open to everyone who may open sessions. | — |
| D-15 **(decided 2026-10-01; replaces SPEC R5, the guests' half of R4, D-4, D-12 and D-14)** | D3: the host's sessions are not sandboxed, and what guests cannot do they ask the host to run; R4 guest sessions (own temp `HOME`, credentials stripped, sandbox, logout on leave, imported config); R5 the guest sandbox; §8: the role that could run agents opened its own agent sessions and terminals inside the sandbox, and unsandboxed sessions were the host's only | **No guest sandbox and no guest agents.** The role "Agent access" (wire id `agent`; it replaces `runner`, which no longer exists anywhere) opens agent and terminal sessions (`session.create`) that run exactly like the host's own: the host's OS user, unsandboxed, the host's environment / `HOME` / `~/.claude` and Claude Code login, in the main workspace or a new / own kept worktree (R9 unchanged). Every holder of `session.drive` (the host, "Agent access") types into ANY terminal and, since 0.5.0, messages ANY agent session, the host's included, answers what agents ask to run (a host-only request: the host) and accepts / rejects suggestions on any agent session; editors keep R6 suggestions (for agent sessions, D-19) and can neither type nor message, viewers watch. The member who opens a session is recorded as its opener (`SessionInfo.openedBy`, which never changes). 0.5.0: an AGENT session is a conversation, not a PTY (D-16); "owner" is three things for it (who opened it, who is responsible, whose locks the agent's are: D-17), its agent is named after the session (D-20), and who may end it is §3. A TERMINAL is as before: only the member who opened it ends it (`session.end`; the host terminates any session), and its PTY follows their viewport. A kick, a leave (`channel.leave`) or a role below "Agent access" ends that member's terminals and free agent sessions, each audited `session.terminate` by the system with `detail.reason` `kicked` / `left` / `role-changed` (R2's 3 s), and hands the sessions of their topics to the host (D-17); a terminal another member opened loses its background jobs when it exits by itself. Merge requests: any holder of `worktree.merge.request` (the host, "Agent access"), for any worktree, and the same members review its diff; the host approves or rejects (unchanged); a request not made by the host is still verified blob by blob and refused when it carries host-only paths. Protocol version 2, 3 since 0.4.0, 4 since 0.5.0 (§4.3) (the role id, `SessionInfo`, `session.create`, `PublicSettings` / `HostSettings` changed shape and every object is strict); a peer of another version is refused with the verdict `version`; no compatibility with protocol 1 or with 0.1.0 state files (nobody had installed 0.1.0). Removed: session kind `login`, `session.importConfig`, `session.create.apiKey`, guest dirs (`~/.smurg/guests`) and their 7-day retention, `PublicSettings.guestSubscriptionLogin` / `guestMainWorkspace`, `HostSettings.allowedDomains`, the error code `sandbox_unavailable`, the audit actions `sandbox.refused` / `session.import-config`, the `sandbox` module and `@anthropic-ai/sandbox-runtime`, the in-sandbox hook self-test (`SmurgProbe`), the guest variant of the session settings (`--strict-mcp-config`, `claudeMdExcludes`, `disabledMcpjsonServers`, the seeded `.claude.json`), the watcher's hand-off to the sandbox guard, `smurg host --no-guest-subscription-login` / `--allow-main-workspace-guests` / `--no-main-workspace-guests` (unknown options now) and the daemon's working directory `~/.smurg/cwd`. Kept: hooks / locks (R8) for every agent session, Bash attribution (D-13), worktrees and merge requests (R9), PathGuard and the host-only / host-private rules for what members do through smurg. | The maintainers chose usability over confinement (2026-10-01): one guest sandbox for macOS and Linux cost far more than a class group needs (§12 of earlier revisions: Linux mount residuals, the guard, placeholders, the login process) and still left members without their own Claude account outside. **Consequence, stated to the host in plain words** (`docs/HOSTING.md`, the console's confirmation): a "Agent access" member has the host's OS account in practice — through any session they can read and write everything the host can (`~/.ssh`, other projects, `~/.smurg` with the daemon key and `state.json`, so they could even change their own role), use and bill the host's Claude account, message the host's agents and allow what they ask to run; the role is for people the host trusts completely. The control socket, which authenticates that OS account, accepts only what `smurg attach` sends (§8 "Control socket"), so such a member cannot make the host's decisions in the host's name through smurg (roles, kicks, terminations, merges, invites, settings, the audit log); what a local channel does is audited `via: 'control-socket'`. Revoking the role ends their sessions, not what they did as the host's OS user: `docs/HOSTING.md` §5.1 (after taking the role back) is the host's checklist (new workspace keys and invites, a new relay login, other credentials, persistence points). smurg's own checks still bind what members do through smurg (`file.*`, `doc.*`, uploads, PathGuard; an agent whose session a member opened is refused Edit / Write of host-only paths by the tool gate: its session's `pathRights` are `member`, also after a handover to the host, D-17 / D-21), and editors / viewers keep the old boundaries (no PTY input, no message to an agent, no sessions). Tests: protocol `roles.test.ts`, `schema/registry.test.ts`, `schema/session-info.test.ts`; daemon `authorization.test.ts` (every request × every role), `sessions/launch.test.ts` › the permission matrix, › every session runs like the host's own, › the sessions a member opened end when the member goes; `sessions/real-modules.test.ts`, `sessions/r4.test.ts`, `sessions/agent-claude-real.test.ts` (0.5.0, with the stand-in in `sessions/agent-sessions.test.ts`), `suggest/suggestions.test.ts` › who accepts, `conversation/suggestions.test.ts` › suggest.updated goes to the watchers, the author and the members whose inbox holds it (0.5.0), `teardown.test.ts` (0.5.0: what passes to the host), `worktree/merge.test.ts` › anyone with worktree.merge.request…, `settings.test.ts` › no guest switches, `local-control.test.ts` (› the local channel sends only what smurg attach sends: every client message of the registry over a local channel and over the host's relay channel; › what the local channel receives (verification F-1): every other daemon message of the registry neither sent nor queued, no `admin.audit.entry`; › a refusal flood through the socket leaves the host's own refusals on the web their audit budget (F-3)), `local/control-server.test.ts` › a stop request names no reason (F-2), `audit.test.ts` › the control socket has a budget of its own (F-3); cli `host-relay.test.ts` (`--role agent`, removed flags, attach typing; › a stop request names no reason … whatever its reason (F-2); › a start that fails is reported as the failure it is), `attach-args.test.ts` › the control socket carries only what smurg attach sends, › --help says who may type, `host-state-file.test.ts` › a CLI member after the host started over with new workspace keys (M1), `stop-status.test.ts`; e2e `r2.agent-role.test.ts`, `r11.console.test.ts`. |
| D-16 **(0.5.0, the owner's brief of 2026-10-05, decision 1)** | R4: an agent session is Claude Code in a terminal on the host: the same screen from the web and from `smurg attach`, and whoever may drive types into it. R6: an accepted suggestion is pasted into that terminal | **Structured mode replaces the PTY for agent sessions.** An agent session is a CONVERSATION: the daemon spawns the host's own `claude` in bidirectional stream-json mode, speaks the control protocol on the pipes itself and turns every line into its own closed set of events and cards (§5.9, §7.6). No PTY, no terminal UI of Claude Code, and no `smurg attach` for an agent session (R4.1 "the same screen from web and CLI" stays for terminal sessions; R4.2 gains "an agent conversation is complete for a late joiner"). A session is its record, not its process: it gives up its process when idle, survives a restart of the daemon as an idle session and continues with the next message; after a restart nothing runs by itself. Consequences: Claude Code identifies itself to the API as `sdk-cli`, not as the interactive `cli` (§12); slash commands are not available to members (every message goes out under a header line); none of Claude Code's own dialogs exist (trust: D-18; login: the host's own terminal; permission prompts: cards). The Agent SDK is not bundled. A plain terminal session keeps its PTY and everything it had; there is no terminal-style agent as a fallback (OWNER-DECISIONS Q8) | The brief: messages, tool actions, multiple-choice questions and permission requests are structured cards that several people vote on and answer, which a terminal screen cannot carry. Every flag and message this rests on was verified with the real binary against a fake API (`docs/research/claude-structured.md`). Tests: daemon `sessions/agent-sessions.test.ts`, `agent-wire.test.ts`, `agent-replay.test.ts`, `agent-claude-real.test.ts`, `sessions/transcript.test.ts`; cli `attach-agents.test.ts` |
| D-17 **(0.5.0)** | R4 as D-15 had it: the member who opens a session is its owner; only the owner ends it; the agent acts as its owner; a member's sessions end when the member goes | **The owner is split in three, path rights are fixed, and a topic's sessions are handed over.** For an agent session: `openedBy` (who created it or pressed Start: attribution, never changes); `responsible` (whose inbox its questions and reports go to and who decides them: routing only, no extra right; may be nobody), with a stored fallback decider; and the daemon-internal owner (whose identity the agent's file locks use). `pathRights` (`member` or `host`: may the agent's edit tools touch host-only paths) is recorded when the session is created and never raised. When the member who opened sessions leaves or loses agent access, their terminals and free agent sessions end as before, and the sessions of their topics PASS TO THE HOST and keep running; after a kick they pass stopped. What that member had put in place goes with them: the kinds they always-allowed, the items they armed, a mode they loosened, their queued messages, their votes; a member who is kicked and joins again is not the decider of the old sessions again (§3 "Who decides", "When a member goes") | A topic is the team's work: it must not die with one member's departure, and nothing a removed member started may keep running unseen. A handover must not give a member's agent the host's rights (the security review's S17). Tests: daemon `teardown.test.ts`, `path-guard-rules.test.ts` › a handover does not raise path rights…, `hooks/hook-server.test.ts`, `conversation/membership.test.ts`; protocol `routing.test.ts` |
| D-18 **(0.5.0)** | R4 / §13 as built until 0.4.0: Claude Code asks whether to trust a folder, and the host answers that dialog in the session's terminal | **smurg's own trust gate replaces Claude Code's trust dialog**, which structured mode never shows. An agent session loads a folder's project-level Claude Code settings (`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, and everything else Claude Code loads from `.claude/`: agents, skills, commands, rules) only when the host has confirmed exactly that content, per file, after seeing every command it runs, every permission rule and every environment variable it sets; a content that redirects credentials or allows tools, and one whose lists do not show everything, needs its own tick. Unconfirmed, a session starts without them (`--setting-sources user`, which also drops the project's `CLAUDE.md`); a change while sessions run parks them; the scripts those settings run are host-only for writes while the confirmation stands, and an agent's shell command that may change one asks a person first (§7.7 G10); `CLAUDE.md` and `CLAUDE.local.md` are host-only for writes through smurg (§7.6 "Trust gate", §5.2, §7.4) | Verified: without a trust dialog, a project hook of a never-trusted folder ran and its `.mcp.json` server connected as soon as a session started there (`claude-structured.md` §7). Whoever can write those files could otherwise run code as the host. Tests: daemon `sessions/agent-claude-real.test.ts` › the trust gate…, `admin-agents.test.ts`, `path-guard-rules.test.ts` |
| D-19 **(0.5.0, the brief's decision 3)** | R6: a member who may not type proposes text for a session that is not their own; when a member who may drive confirms, it is pasted into that session, a terminal included | **Suggestions are for agent sessions.** Never a terminal (`suggest.terminal`); the author's own agent session included (what matters is who may drive, not whose session it is). An accepted suggestion is a MESSAGE of its author to the agent, under a header that names who accepted it, in exactly the characters the card showed; it is a card in the conversation and one item per author and session in the inbox of whoever may decide it; at most 20 pending per author and session (§5.6). `topic.revise` and `report.followUp` make suggestions the same way for a member who may not drive | The brief: an Editor's message is a suggestion that reaches the agent only when a member with agent access accepts it. A line for a shell is not something a card lets a reviewer judge, and nobody asked for it (the design's Q15). Tests: daemon `conversation/suggestions.test.ts` › T1.4 a suggestion reaches the agent only when accepted, `integration/suggest-conversation.test.ts`, `suggest/suggestions.test.ts` |
| D-20 **(0.5.0)** | R8 / D-15: an agent is shown as `Claude (<owner>)`: which agent, and whose | **The agent's name follows the session**: `Claude (<topic name>)` for a discussion, `Claude (<item title>)` for a work item's session, `Claude (<opener>)` for a free session, in presence, a caret in a document, locks, the activity feed, the audit log and what other agents are told (`agentSessionName(session)` is the one function that chooses the label, `agentDisplayName(label)` the only one that spells it; the label passes `agentSafeName` first). Who opened a session and who is responsible for it are fields of the session, shown beside the name | A topic's sessions belong to the topic, pass to the host when their opener goes (D-17), and several of them run for one person at once: three agents called `Claude (Ian)` say nothing. Display names are free text from an identity provider and do not reach a model unchecked. Tests: protocol `names.test.ts`, `agent-text.test.ts` |
| D-21 **(0.5.0)** | D3 / R4: what an agent may do is Claude Code's own permission system, answered in the session | **The tool gate.** Every tool call of every agent session passes smurg's own code first: ONE PreToolUse hook registered for every tool, which decides by the kind of session (§7.7, rows G1–G10) BEFORE Claude Code's permission flow and whatever allow rules the host or the project have, and refuses every tool when the daemon does not answer. A discussion agent reads only inside the project, writes only its topic's `SPEC.md` and `PLAN.md` and has no other tool; a work item's agent may not edit those two files; no agent writes Claude Code's configuration; a shell command that may change a script of project settings in use asks a person, whatever rule would have let it run (G10). Claude Code's tool list, deny rules and permission requests (which become cards) are the second layer (§0 rule 7). What the gate lets through is subject to the host's own Claude Code allow rules, which apply (OWNER-DECISIONS Q7) | Verified: the host's own `permissions.allow` answers before any request reaches smurg; with `["Read","Edit","Write"]` there, a discussion profile built from rules alone wrote a source file and read a file in the host's home. A deny of smurg's own hook holds under settings that allow everything, and with the hook answering as an unreachable daemon nothing ran (`claude-structured.md` §5). Tests: daemon `hooks/tool-gate.test.ts`, `hooks/hook-cli.test.ts`, `hooks/claude-failmodes.test.ts`, `sessions/agent-claude-real.test.ts` › R1…, `conversation/gate-audit.test.ts` |
| D-22 **(0.5.0, the brief's decisions 5 and 10)** | (the brief) the spec and the plan are files in the project that people edit together; executing the plan opens one agent session per work item | **A Start pins the spec and the plan.** `plan.start` must repeat the plan revision and the hashes of both files that the Start dialog showed; inside the request the daemon commits exactly those two files and stores the pin; the scheduler starts an armed item only while both files, in the working tree and at HEAD, still hash as pinned, never commits, and disarms the item otherwise; an item that appears in the plan later is never armed by an earlier Start (§7.8 "Start", "Execution"). Any change after a Start costs a "Start again", whose dialog shows the change | An Editor can edit those files, and an item may start hours after the click, when what it depends on is merged: without the pin an Editor's later sentence would reach an agent that no member with agent access had seen (§2 rule 6; the security review's SEC-02). Tests: daemon `topics/scheduler.test.ts` › T4.1 a changed spec or plan starts nothing, › S3 an Editor's edit of an armed item's summary or dependency starts nothing and reaches no agent, › S3 the checkpoint commits two files |
| D-23 **(0.5.0)** | R4: the host's own Claude Code runs the agents (no version is named; until 0.4.0 any version started, with a warning below the oldest verified one) | **Claude Code 2.1.288 is the floor** for agent sessions, and the one verified version: an older Claude Code is refused before the spawn with its own sentence (`session.claude.tooOld`); a newer one, or one whose version cannot be read, runs, and the host is told once (§7.6 "Claude Code version"). Terminals are not affected | The release is verified on one version. One security property holds only from there (a read deny rule hides a file from Grep on 2.1.288 and not on 2.1.220), and the structured protocol is defined by what the binary does, not by a documented contract. A newer version must not lock anyone out, because Claude Code updates itself: the explicit tool list (a new tool does nothing until a smurg release lists it), the tolerant normaliser and the replay test bound what an update can change. Tests: daemon `sessions/agent-sessions.test.ts` (refusals; an unverified version), `workspace.test.ts` (the policy) |

## 12. Known limits of the prototype

- **Sessions opened by members run unsandboxed, as the host** (§11 D-15, 2026-10-01). A member with the
  role `agent` ("Agent access") opens agent and terminal sessions that run as the host's OS user, with the host's
  environment, HOME, `~/.claude` and Claude Code login, on the host's computer, types into any terminal, messages
  any agent and allows what agents ask to run, the host's sessions included. Nothing confines such a session: through it the member can run any command the host could, read
  and write everything the host's account can (the home folder, `~/.ssh`, other projects, the state dir `~/.smurg`,
  `.git` and `.envrc` of the share, which `file.*` hides from people), reach any network address, use and bill the
  host's Claude account, and answer the permission requests of the host's agents. Worktree mode keeps work apart from
  the main workspace; it does not confine it (R9.1 / R9.2 are withdrawn for agents). There is no resource limit beyond
  the host's own (memory, disk, processes). What smurg does: the role is the host's explicit choice (an invite of that
  role, or a role change in the console after a confirmation that states the risk), editors and viewers cannot open,
  type into or message a session, every member sees every session live, the audit log records who opened which
  session, every message to an agent and every decision about what it may run, and when the member is kicked, leaves
  or is set to editor / viewer their terminals and free agent sessions end and the sessions of their topics pass to
  the host (§11 D-17). What 0.5.0 adds on top is about AGENTS, not about this member: the tool gate ties a discussion
  agent's hands whoever talks to it (§11 D-21). The user docs say it in
  plain words (`docs/HOSTING.md` §4 / §5.1, `docs/JOINING.md` §2 / §5.1, the product page): only for people the host
  fully trusts. Until D-15 (from the start to 2026-10-01) guests' own agents ran in a sandbox (srt: Seatbelt /
  bubblewrap) with their own Claude login; that design, its residuals and its tests are gone (`docs/research/sandbox.md`,
  historical).
- **Linux** was developed on macOS arm64. Since 2026-10-01 the whole gate runs on Linux and is green: in an Ubuntu
  24.04 arm64 VM and on CI's ubuntu-24.04 x64 (`.github/workflows/ci.yml`; counts in `docs/ACCEPTANCE.md` "Linux
  verification"; to be re-run after D-15). Not run on Linux: a real `claude`, keep-awake through `systemd-inhibit`
  from a local desktop session (from an SSH session polkit refuses it on Ubuntu: verified, and `smurg host` says so),
  the installer on a fresh machine. A single request that misses its NFC name on Linux
  (a create, an upload's commit) still lists its directory once, so an upload of n new non-ASCII names into a folder of
  m entries costs n listings of m entries.
- **Real accounts are not exercised by the tests.** No test uses a real Claude account (0.5.0: below). Real Google /
  GitHub OAuth and a real Cloudflare deployment need credentials. They were first exercised by hand on 2026-10-01: the shared relay deployed to Cloudflare
  (`docs/RELEASING.md` §2, now at `https://app.smurg.ai`) and a maintainer's Google login in the browser there; the CLI
  login and a second account joining are still to do. GitHub login is not configured on the shared relay and stays
  untested against the real provider.
- **Browser device keys are not encrypted at rest** (see §4.2).
- Zip downloads are not resumable; archives that need ZIP64 for sizes/offsets cannot be opened by Apple's `ditto`
  (files ≥ 4 GiB are placed last and flagged).

Known limits of 0.5.0 (agent conversations, topics, the inbox). They are the risks the design named
(`docs/design/v0.5.0/DESIGN.md` §11), as the owner's decisions left them:

- **No real model was used to verify 0.5.0.** Nobody on the team used a real Claude account, by the owner's
  decision; every experiment and every test ran the stand-in `claude` or the real Claude Code binary against a fake
  Anthropic API (§10). The mechanisms are exercised; a real model's behaviour is not: whether it asks its decisions
  through `AskUserQuestion` as told, calls `check_plan`, `propose_split` and `check_report`, keeps item ids when it
  updates a plan, writes the report in the fixed format, and resolves conflict markers well. What bounds a
  deviation: the in-band checks, the automatic `fix-*` and `nudge-report` messages, and that a stall reaches
  someone's inbox. The role prompts and messages (`topics/prompts.ts`) may need tuning after the owner has tried the
  release with a real account.
- **Whose Claude account does the work.** When other members drive a session, the host's Claude account does the
  work and pays for it (D-15). Anthropic's consumer terms do not allow making a personal account available to
  others: a personal Pro / Max subscription is for the host's own use, and an API key or a Team / Enterprise plan is
  the route for a group. smurg says so (the host guide, the host's New topic dialog, and one notice to the host, once
  per workspace, when a personal subscription login is used while other members are present) and blocks nothing: it
  is the host's decision and the host's exposure.
- **Billing class.** A structured session identifies itself to the API as `sdk-cli`, where 0.4.0's terminal agent was
  `cli`. Anthropic announced, and on 2026-06-15 paused, a change that would meter `claude -p` and Agent SDK usage of
  subscription plans separately from interactive use; if it comes back, a subscription host would pay for smurg
  sessions from that separate allowance. There is no terminal-style agent to fall back to (D-16).
- **The structured protocol is not a documented contract.** It is defined by the types the Agent SDK ships and by
  what the binary does; `--permission-prompt-tool stdio` is not a documented value. It was identical on 2.1.201,
  2.1.220 and 2.1.288, but the host's CLI updates itself. What stands against that: the tolerant normaliser, feature
  detection with fail-closed fallbacks, the explicit tool list, the replay test, one verified version with a notice
  above it (D-23). A breaking change in Claude Code can still stop every agent session until a smurg release.
- **The host's own Claude Code rules apply** (§2 rule 10; the owner's decision). What the host's own allow rules
  already allow runs in every agent session without a permission card, whoever messaged the agent: a host whose
  settings allow `Bash` has, in effect, no command prompts in work items and free sessions. The host is shown the
  list once, each such command is in the audit log with why it ran (`agent.command`), and the tool gate still
  binds (a discussion agent has no shell whatever the host allows). With "always allow `pnpm test *`", or a host
  rule of that kind, an agent that edits the test files in its worktree can run what it wrote; the card says so.
- **The limits of a discussion agent rest on one hook.** The tool gate is smurg's own code and was verified on
  2.1.288 against a host whose settings allow everything. If a future Claude Code stopped running PreToolUse hooks
  for some tool, that tool would fall back to the second layer (the tool list, the deny rules, the daemon's denial of
  requests), which the host's allow rules can weaken. The real-Claude suite is the alarm; it runs on the verified
  version only. And the gate cannot see what a shell command DOES: it reads which files a command names, and only in
  a folder whose project settings in use name scripts (§7.7 G10). The rest is what permission requests, the deny
  rules and the merge review are for.
- **Injection through the spec, the plan and the repository.** An Editor's sentence in `SPEC.md`, or text in any file
  or web page an agent reads, can ask the agent to do things. What stands in the way is the gate, a person reading
  each command, the pin (D-22) and the reviewed merge. The discussion agent reads its topic's files on every turn,
  whoever edited them (§2 rule 6).
- **What an agent reads, everyone may see.** The read rules keep the host-private names from the agent's tools and
  `mask()` catches well-known key shapes; anything else an agent reads it can repeat in its text, in the spec or in a
  report, to every member, including one who joins next month and reads every earlier conversation. Masking is best
  effort. The host can remove one event (`admin.transcript.redact`) or a whole archived topic's conversations
  (`topic.delete`). Removing an entry replaces ONE conversation event (a message, a message of smurg, agent text, a
  tool call or its result). A question, a permission request and a suggestion are not events: the conversation holds
  a pointer, and the content (the command or diff a person was asked to allow, the question with its votes and
  comments, the suggestion's text) lives in the session's `cards.json` and in the suggestion store and stays there.
  So do the excerpts of inbox notes, a report's follow-up questions and the audit log's full texts. Deleting the
  TOPIC removes all of these but the audit log; a free session has no such way. The host's confirmation before an
  entry is removed says so in a line of its own, in one wording for a topic's session and one for a session
  without a topic (`redact.copies.topic`, `redact.copies.free`), beside the line that Claude Code keeps its own
  record of the conversation (`redact.memory`). Do not share a folder whose files or commands hold secrets.
- **The trust gate can cost context**: until the host confirms a folder's project settings, sessions there run
  without them and without the project's `CLAUDE.md`. `CLAUDE.md` and `CLAUDE.local.md` themselves are not part of
  what the host confirms: they are loaded as soon as the folder's state is `used` or it has no entries at all (only
  the host writes them through smurg, §7.4), so with a repository that came from elsewhere the host does not see
  them in the review.
- **What guards the scripts of confirmed project settings, and what does not.** What a confirmed hook's own script
  calls in turn is not tracked: only the files the settings' commands name are part of the confirmed content, and a
  command smurg cannot follow is confirmed with a tick, not guarded (§7.6 "Trust gate"). The tool gate reads what an
  agent's shell command NAMES (§7.7 G10). A program that names nothing of it (`npm run build`, a script of the
  project that rewrites another) is not seen before it runs: it asks through Claude Code unless a person allowed its
  kind, and the trust gate's watch notices the changed script afterwards, parks the folder's sessions and asks the
  host again; a hook that fires in between runs the changed script as the host. The same holds for anyone who can
  edit files and changes what a script calls. So a confirmed hook should run scripts from `.claude/hooks/`, where no
  agent and no member but the host writes, not from a folder agents work in. The cost of the guard: ANY existing file
  a hook command names counts as such a script (`tsc -p tsconfig.json` records `tsconfig.json`), the folder that
  holds it is a guarded place for an agent's file commands (`mv x.ts src/` asks the host when a hook names
  `src/index.ts`), and "always allow" covers neither a command that names such a script or its folder nor git's
  `checkout`, `restore`, `reset`, `stash`, `merge`, `pull` and their kind there: they ask each time. The gate's
  reading is bounded, and each bound asks a person instead of letting the command pass; but a write to a recorded
  script that stands five shells deep (`sh -c "sh -c \"…\""`), or in a line that names more than 256 places
  with the lines it hands to other shells, is then a card anyone who may allow commands can answer, where a
  reading to the end would have asked the host alone (§7.7 G10).
- **A folder swapped from outside smurg.** A topic's folder (`specs/<slug>`, `specs`) that a program outside smurg
  renamed or replaced is read again at once (the Start dialog pins what is there, an armed item is disarmed), but the
  Start dialog does not list "changed outside smurg" for it; a change of `SPEC.md` or `PLAN.md` itself from outside
  is listed. In a report, "edited by hand" names a person also for a file the agent wrote later below a folder that
  person moved in (§5.10).
- **A link whose words only look like another place's address.** The web writes a link's destination out beside
  its words when the words name another place, and nothing more is read as a place than §9 "Nothing of a text is
  hidden" lists. A link is drawn as an ordinary link, with its real destination behind hover and keyboard focus
  only, when
  - the "dot" of the name is a character that looks like one and that Unicode's compatibility form does not turn
    into one: U+0660 (the Arabic-Indic digit zero, `github<U+0660>com`), U+A4F8, U+06D4, U+0702 and the raised
    dots U+00B7, U+2219, U+22C5, U+30FB and U+2027;
  - a character that a browser draws with almost no width, and that is not one of Unicode's default ignorable
    code points, stands between a name and its dot: U+FFFC and the hair space U+200A in any text
    (`github<U+FFFC>.com`; measured in the app's fonts in headless Chrome: 0.06 px and 0.97 px), and U+007F
    (0.13 px) in a `SPEC.md`, the daemon having taken it out of a message and of an agent's text. Such a character
    is not taken out before the words are read, so the words are two words that name nothing;
  - the name is written backwards behind a right-to-left override (`<U+202E>moc.buhtig`): the daemon removes the
    override from a message and from an agent's text (§5.9), so this can stand only in a `SPEC.md` or another
    document the daemon does not clean;
  - the words are a bare ASCII word under an ending that is not on the list of about fifty (`amazon.in`, `bbc.it`,
    `github.lol`): no spelling tells such a host from `README.md` or `event.target`. The same word with a
    look-alike letter in it IS written out, unless it is also the name of the file the link leads to:
    `[<U+0430>mazon.in](https://evil.example/<U+0430>mazon.in)`, with the Cyrillic letter that looks like a Latin
    "a", is an ordinary link, because whoever owns a destination writes its path.

  The rule errs to the safe side as well: a sentence without a space after its full stop that has a letter from
  outside ASCII beside that stop ("le café.Ensuite") is written out with the destination although it names no
  place. What bounds the exposure: such a link has to be written by a member or by an agent steered by what it
  read, the destination is one hover or one Tab away, and a link opens in a new tab.
- **A long `SPEC.md` that is slow to format.** A text costs the Markdown renderer two budgets at most (§9), but a
  text that changed is a new text. Typing in a `SPEC.md` that is over its time budget can therefore cost up to two
  budgets a keystroke until every slow section is remembered (the Read view stays mounted behind the Edit view and
  parses what is typed); and what waits behind the piece a text ran out on is parsed in ONE task of up to the
  text's whole budget, not in slices of 30 ms. Measured on a 990 KiB spec of 62 hostile sections: two tasks of
  0.42 s for each of the first 26 keystrokes. A spec of ordinary sections does not come near its budget, which is
  about ten times what the lexer needs for ordinary text. One such text can also read two ways for a while: a
  column keeps the sections it formatted for an earlier version of the text and does not parse them again, while
  a column opened afresh parses the whole text inside its budget and may show all of it as written.
- **Bounds on text, in plain words.** A run of more than 30 combining marks on one letter is cut to 30 in every
  text a person sends towards an agent (the card says that hidden characters were removed), and a file or folder
  whose name holds such a run cannot be reached through smurg at all (§7.4); agents and terminals see it like any
  other file. One upload may have at most 10,000 folders (§5.2). The daemon's own answer from a topic's "always
  allow" rule, for a session whose process does not have the rule yet, is never given for a URL longer than 2,048
  characters: a person is asked (§5.9; a rule a process already holds is matched by Claude Code itself).
- **No subagents.** Agents in smurg do not start subagents: Claude Code's `Task` tool is in no session's tool list,
  and agent definitions in `.claude/agents` are not used as subagents. A subagent runs with the permission mode, the
  hooks and the MCP servers of its definition, not with what smurg set for the session (§7.6 "Profiles"). The wire's
  `task` verb and `parentToolUseId`, and the web's nested steps for them, stay unused.
- **A folder whose path has a backslash or a control character** takes no agent session (`session.folderNotNameable`):
  no permission rule of Claude Code can name it. Files and terminals work there; `smurg host` does not warn about it.
- **The host is the bottleneck of a dependent plan**: an item waits until what it depends on is MERGED, and only the
  host merges. A reviewed change is in the host's inbox with what it unblocks; the wait itself stays.
- **Merge conflicts between parallel items.** Items start from the same commit. The plan prompt, the `touches`
  warning and dependencies reduce them; the daemon-side merge with the agent resolving the markers (§7.8 "A
  conflict") is proven with plain git, not with a real model's resolving. A terminal's or a free session's worktree
  still has no operation that brings the main workspace's changes into it.
- **Execution needs git**: a repository with at least one commit and git 2.42 or newer; without it a topic has its
  discussion, spec and plan, and Start is refused. The checkpoint commit of a Start lands on whatever branch the
  host has checked out (the dialog names it), and is refused in the middle of a merge or when git ignores `specs/`.
- **Memory and slots.** Measured on 2.1.288: about 263 MB per fresh live agent including its `smurg mcp` process,
  420–600 MB for the `claude` process after 300 turns, 243–288 MB after park and resume. Eight live items are about
  2.1 GB fresh and can reach 5 GB; the default limit follows the computer's memory and an idle process above 400 MiB
  is parked. A session that waits for a person cannot give up its process; the plan says how many slots wait for
  people.
- **When the daemon dies** its agents do not die with it. The gate refuses their next tool call, so nothing runs
  unattended, but an orphan can still receive model text until its turn ends (measured: three more API requests in a
  scripted run): API use on the host's account that smurg's own log does not show (Claude Code's transcript has it).
  A hard kill within about 100 ms of a message can lose the newest entries of Claude Code's own transcript, and
  leaves a socket file in `/tmp/cc-socks`. After any restart nothing continues by itself: every plan is paused until
  a member with agent access presses "Continue all".
- **Claude Code's own retention.** It removes its transcripts after its own period (30 days by default). A session
  resumed later starts a new conversation from the files (spec, plan, report), not from what was said; smurg's own
  log still shows what was said.
- **The role prompt is fixed for a session's life**: a release that changes a role prompt affects new sessions only.
  A long discussion compacts inside a turn (a visible pause) and, when the prompt cache has lapsed while people
  deliberated, reads the whole conversation again at the host's cost; "Restart discussion" starts a fresh one.
- **The shared relay and streaming.** The stream is sized for the shared relay's free plan (text deltas every
  200 ms, event batches every 100 ms, deltas only to columns on screen: about 15 frames per second for a member with
  three streaming sessions on screen). Measured on a local relay (2026-10-07, the web-smoke project's flow smoke,
  the stand-in `claude`): the owner's whole flow with four browsers took 114 s and the relay received 4,527 and
  4,558 WebSocket frames in two runs, about 2,400 a minute for the four, about 600 per person and minute
  (`docs/RELEASING.md` §8 has what was counted and what it means against the plan's allowance). Not measured: the
  usage as Cloudflare counts it on the deployed relay, and a real model, which writes more text per turn than the
  stand-in; one busy workspace can use a large part of the day's allowance. Protocol 4 makes the release order
  matter again: the shared relay's web build refuses a
  daemon it does not know, so it is redeployed from the release commit before 0.5.0 is published (below).
- **Agent conversations are in the browser only.** `smurg attach` attaches to terminal sessions; a member who works
  from the CLI can list agent sessions and cannot read or message one (§8). Slash commands of Claude Code are not
  available in an agent session, and smurg never chooses the model.
- **An Editor as the responsible person** cannot allow commands or write a note for the agent: those go to members
  with agent access, and a plan where people choose Editors for every item waits on whoever has agent access.
- **Not exercised**: MCP elicitation; a real `claude` on Linux; the packaged executable's hook under a real model's
  tool rate; Enter-to-send with a Chinese input method (the guard is `event.isComposing`); a 320 px column with a
  permission card that holds a diff.
- **Unmerged work after a restart**: whether an item's worktree holds changes that were never merged (the Archive
  confirmation) is known from what smurg saw written plus a `git status` shortly after; right after a restart of the
  host's smurg every item worktree is listed until it was looked at (a few seconds).

Left after the review round of 2026-09-29, and the decisions that stand until changed:

- **Releases and downloads**: built by GitHub Actions on a tag `v*` for macOS arm64 / x64 and Linux x64 / arm64, each
  on its own runner (`macos-15`, `macos-15-intel`, `ubuntu-24.04`, `ubuntu-24.04-arm`), uploaded by a person to
  Cloudflare R2 behind `https://downloads.smurg.ai` (`v<X.Y.Z>/` never overwritten, then `latest/`); no Cloudflare
  credential lives in GitHub. The install line is `curl -fsSL https://smurg.ai/install.sh | sh` (a 302 to
  `latest/install.sh`). From 0.4.0 the GitHub release carries the notes, `SHA256SUMS` and the notices only. The
  workflows cannot run locally, and R1.1 (fresh machine to invite link in 3 minutes) is measured by hand. macOS
  executables carry an ad-hoc signature only (no Developer ID, not notarized); the installer relies on `curl` setting
  no quarantine attribute and removes one after the sha256 check. `SHA256SUMS` is not signed (open: minisign /
  Sigstore with a key pinned in `install.sh`), so it does not protect against a compromised GitHub account or
  workflow, or a compromised Cloudflare account that holds the bucket. `smurg update` (§8) has exactly the installer's
  trust: https, `downloads.smurg.ai` and the same unsigned `SHA256SUMS` (its checks of the build marker and of
  `--version` catch a mixed-up or broken file, not a forged one). It is all-or-nothing per file but not per machine: a
  `smurg host` of ANOTHER state dir (`SMURG_HOME`) that runs from the same executable is not seen and keeps its old
  daemon; and the update notice of `smurg host` tells `downloads.smurg.ai` (Cloudflare) the host's IP address at each
  start (`SMURG_NO_UPDATE_CHECK=1` switches it off). `smurg uninstall` removes what smurg wrote on this machine only:
  the relay keeps the account's sessions until they expire, and `.smurg/` in shared folders stays (listed). Intel
  Macs after August 2027 (GitHub's last x86_64 macOS runner image) are open. Runbook: `docs/RELEASING.md`.
- **License**: MIT since 0.4.0 (Copyright (c) 2026 Guan-Chen, Lin); the source is public at
  `github.com/gclinian/smurg`; 0.1.0 to 0.3.0 were released before the license. The third-party components keep their own
  licenses: their notices travel with every copy (§8 "Licenses").
- **The shared relay** (one relay at `https://app.smurg.ai`, the CLI's built-in default `DEFAULT_RELAY_URL`, Google
  login only; a release keeps its default relay forever; Cloudflare Workers free plan): the plan's daily limits are
  shared by everyone who uses it; when one is used up, connections and messages of that kind fail for every workspace
  until 00:00 UTC. An estimate from the code (not measured on Cloudflare): the WorkspaceDO alarm alone costs ~720
  requests and ~720 rows written per workspace-hour while anyone is connected, and a busy terminal watched by several
  members costs far more. The free plan's 10 ms CPU limit per request was not measured against the login routes.
  Every deploy disconnects every socket (clients reconnect). The operator of the shared relay (and Cloudflare) can
  see what D-5 says a relay sees, for every workspace on it. Hosts who cannot accept that deploy a relay of their
  own (`apps/relay/README.md`) and pass `--relay`; `docs/HOSTING.md` §2.1 / §2.2 say what the shared relay sees. Its
  web app is one build for every host's daemon, and it decodes the daemon's messages with strict objects (§5), so it
  refuses a daemon newer than itself (a field the daemon added is an unknown key to it; the reverse works, additions
  are optional): the shared relay is redeployed from each release's commit before the release is published
  (`docs/RELEASING.md` §4), and a host running a build ahead of it (for example from `main`) cannot be joined through
  it until the next deploy.
- **Linux verification**: GitHub Actions on ubuntu-24.04 runs the whole gate; still manual on a real Ubuntu machine:
  a real `claude`, keep-awake through `systemd-inhibit` from a desktop session, the R1.1 timing.
- **Decisions that stand until changed**: `.env` files are ordinary project files that every member reads; the
  default invite has no use limit and expires after 7 days; a kick takes effect in memory at once and is retried
  until the disk takes it; no operation updates a terminal's or a free session's worktree from main (the host merges
  in a terminal; a work item's worktree: §7.8 "A conflict").
- **Bash edits** (D-13): implemented 2026-09-29, switchable, on by default (§11). (D-12, the guests' subscription
  login, is gone with D-15.)
- **Attribution after an autosave** (files module): for 5 s after a person's autosave, any change of that file is
  attributed to that person (`EXPECT_CHANGE_TTL_MS`), so an agent's shell write in that window is shown as the
  person's and a conflict then names the person as the other side. Recognising the autosave's own echo by content hash
  (the docs module knows it) would remove this; not done (a change to the files and docs modules' event flow).
- **Relay sessions** are stateless 7-day tokens and cannot be revoked before they expire.
  The CLI's device-code login (2026-10-01) has the flow's known residual: a person can be talked into
  entering someone else's code (phishing); the confirmation screen names the account, where the request came from and
  when, and warns, but cannot prevent it.
- **The invite URL stays in the browser's history**; guest links from `smurg host` are multi-use for
  7 days unless `--max-uses` / `--expires` say otherwise.
- **Backpressure**: the hub has no priority queue in front of `ws.send` (a reply or heartbeat
  can wait behind up to 1 MiB of one viewer's terminal output, ≈ 0.9 s at 1 MiB/s); the relay's Durable Objects apply no
  backpressure toward a slow browser; exec.output queued for a disconnected channel is bounded only by the channel's
  outbox limits. The first attach of a very large colourful scrollback still blocks the daemon for ~360 ms (no
  worker thread).
- **Requests with an unknown outcome**: a request that timed out is never replayed, but there are no
  idempotency keys, so the person's own retry can repeat an action the daemon did carry out.
- **Clocks**: the relay link and the lock manager use the monotonic clock; the hub, the channel server
  and the rate limits still use the wall clock, and after a backward step audit `at` stays strictly increasing (entries
  can look up to the step size in the future).
- **State written late**: a change made while the disk refuses writes is in force and retried, but lost
  if the daemon stops or crashes before the disk takes it (`STATE NOT SAVED` in the log, a warning on the host terminal).
- **Documents**: an open document does not follow a rename on disk (the web tab does, from the
  `file.rename` activity event's `renamedFrom`); text typed while the host was down is merged back only when the host's text did not change
  meanwhile (otherwise it is offered back); this was tested with the web's in-test document room, not a real daemon
  restart.
- **Share lock**: a descendant folder already hosted by a daemon of another state dir is not detected.
- **Worktrees**: for a terminal's or a free session's worktree there is no operation to bring the main workspace's
  changes into it; a conflicting merge is resolved by the host in their own terminal (`git merge
  refs/smurg/merge/<id>`) or rejected. A work item's conflict is merged by the daemon and resolved by the item's
  agent (§7.8 "A conflict").
- **Hook reachability**: sessions run as the host, and an agent runs no self-test of the hook
  before it starts (until D-15 a guest's sandboxed agent did). When `smurg hook` cannot reach the daemon, the tool gate
  denies every tool call, shell commands included (fail closed, §7.7 G1); the Bash activity hook by itself fails open
  and decides nothing (§11 D-13).
- **Keep-awake** is reported active once the inhibitor has run for 250 ms; one that ends at once is reported with its
  reason code (`PowerStatus.reason`, `POWER_REASONS`; `refused` when its stderr says it was refused: `systemd-inhibit` from an SSH session, where
  polkit's `org.freedesktop.login1.inhibit-block-sleep` is `allow_any=no` on Ubuntu, verified there only; any other
  polkit refusal, a site rule for a local session included, gets the same code, which the CLI words as a polkit refusal with SSH on
  Ubuntu as the example; its first stderr line goes to the log). A later loss is printed within 2 s.
- **Native file watcher** (macOS, @parcel/watcher 2.6.0; 2026-09-29, §7.5): the daemon no longer makes overlapping or
  failing native calls, but three races are inside the native module and cannot be closed from JS: FSEvents stops the
  stream of a root that is deleted or moved away on its own thread while an unsubscribe of that root may be running
  (reachable now only by an outside deletion in the same millisecond as the daemon's own unsubscribe: worktree removal,
  `smurg stop`); an event that arrives while a subscribe is still starting dereferences a null tree (`startStream` sets
  it after `FSEventStreamStart`); an unsubscribe while the FSEvents thread is inside the callback. Measured with stress
  children under load: every flow the daemon performs itself (worktree removal, a root moved away and back, roots that
  vanish, stop and exit) 0 crashes in 271 runs; an outside rename issued in the same tick as the unsubscribe 9 crashes
  in 63 runs; subscribe / unsubscribe churn during continuous writes 2 in 120 runs (≈ 1 per 250k–500k native calls).
  Such a crash still ends the whole daemon and every session. Follow-up: a supervised child process that owns the
  native watcher (a crash then costs a watcher restart and a re-list), or a patched @parcel/watcher.
- **Native file watcher on Linux** (@parcel/watcher 2.6.0, inotify, 2026-10-01): a new directory gets a
  watch only when the backend handles that directory's own creation, so the subdirectories made in the same burst
  (`mkdir -p`, a `git checkout`, an unpack) or moved in with their parent are never watched (measured: of a `mkdir -p
  one/two/three` and three files only `one` and its own file were reported; FSEvents reports all), and an inotify
  queue overflow is dropped without an error (319,496 of 320,001 creates reported, no error). Changes there reach
  neither the file tree's live updates nor the activity feed; a client sees them at its next listing. Follow-up: a
  patched @parcel/watcher that scans a
  newly watched directory (adding watches and reporting what it holds) and reports IN_Q_OVERFLOW as an error, or a
  periodic re-subscribe of a root that reported a new directory.
- **`smurg attach` output** assumes a UTF-8 terminal unless the locale says otherwise.
