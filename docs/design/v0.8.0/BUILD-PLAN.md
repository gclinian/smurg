# 0.8.0: build plan

Cuts `DESIGN.md` (D1 to D8, Security) into nine steps, S1 to S9, that builders do one after the other in ONE
worktree, `/home/gclin/Desktop/projects/smurg/.claude/worktrees/sticky-notes-ui`, on branch
`worktree-sticky-notes-ui` (from main c298391 = tag v0.7.0: protocol 6, workspace shapes 3). Each step owns the
files it names (a later step may change a file an earlier one owned; never two steps at once), ends with `pnpm
check` green on its own, makes ONE local commit and writes a HANDOVER. The package version stays 0.7.0 throughout;
the release commit (version 0.8.0 in the eight `package.json`, the changelogs' heading, RELEASING, ACCEPTANCE's
gate) is not part of this plan.

There is no step that pays 0.7.0's release debt (DESIGN D8.1): its fixture is a release chore of main. The design
folder is committed by S1. The paths and test names below were checked in the tree at c298391; where a step moves a
piece away from the order the design suggests, it says which test forces it.

## Rules for every step

- **Read first**: `OWNER-BRIEF.md`, `DESIGN.md` (the five minutes, the decisions your step names, Security, "What
  the owner should decide"), this plan, and EVERY earlier step's HANDOVER
  (`/home/gclin/.claude/jobs/659485ab/tmp/handover/S<n>.md`). The understanding reports of the code at c298391
  (`/home/gclin/.claude/jobs/659485ab/tmp/maps/*.md`) and the five reviews
  (`/home/gclin/.claude/jobs/659485ab/tmp/review/R-*.md`) guide; the code decides.
- **The shell**: from the worktree's root, `source scripts/env.sh` in the same shell as every `pnpm` command (it
  refuses to run when executed; it sets the repository's pnpm, node and `XDG_CONFIG_HOME`). Every command in the
  FOREGROUND, each under 10 minutes; never end a turn while a command you started still runs; one gate at a time.
- **Never** a real Claude account, a real Slack or Discord token, workspace or server (ARCHITECTURE §0 rule 2: fake
  servers on 127.0.0.1); never `~/.smurg`, `~/.claude`, `~/.local/bin` (tests use scratch HOME, SMURG_HOME,
  SMURG_CACHE_DIR); the `claude` on this machine's PATH is the owner's: the dev stack only with `--stand-in-claude`;
  no browser window (the smokes' Chrome is headless); signal only processes your own commands started; nothing
  deleted outside the repository and the lead's folder (`/home/gclin/.claude/jobs/659485ab/`).
- **A test is never weakened to pass.** A test that fails is either right (fix the code) or states what was true
  before this design and is now changed on purpose: then change exactly the expectation the design changes, say why
  in the test's own comment where the file has such comments, and list it in the HANDOVER under "Tests changed on
  purpose" with the decision number. Never `.skip`, `.todo`, a wider timeout or a looser matcher to get green.
- **A pin is re-taken only with its reason said.** The pins of this plan: `PROTOCOL_VERSION` and its copies,
  `WORKSPACE_SHAPES` / `PINNED_AT_SHAPES`, the hashes and shape texts of `packages/daemon/test/upgrade/pin.test.ts`,
  the counts of the three `text-cost` tests, the registry's lists in `registry.test.ts`, the module lists of the
  composition tests. Each one moves in the step that changes what it pins, with one sentence in the commit body and
  in the HANDOVER ("this changes no stored shape because …", or the shape and why no upgrade step is needed). The
  pin of stored shapes: answer its question, then `SMURG_PIN_WRITE=1 pnpm --filter @smurg/daemon exec vitest run
  test/upgrade/pin.test.ts` rewrites the shape texts under `test/upgrade/shapes/`, and the hashes (`DAEMON_SOURCES`,
  `PROTOCOL_SOURCES`) are edited by hand from the failure's "received" values.
- **The upgrade tests treat 0.7.0 as not published** (D8.1): `TAG` stays `'v0.6.0'` in
  `packages/daemon/test/upgrade/other-version.test.ts`, `packages/daemon/test/upgrade/wire.test.ts` and
  `packages/cli/test/ctl-other-version.test.ts`; `PUBLISHED_VERSIONS` stays the five of `test/upgrade/fixture.ts`;
  `NOT_PUBLISHED_YET` in `test/upgrade/fixtures.test.ts` keeps 0.7.0's points. What each step does to those lists is
  in its Tests.
- **The wire**: protocol 7 from S1 on. Every step that adds a message type adds, in the same step: its schema and
  registry entry (`packages/protocol/src/schema/registry.ts`), its row in `ARCH_CATALOG` of
  `packages/protocol/src/schema/registry.test.ts` and in ARCHITECTURE §5.12, `MESSAGE_SAMPLES`
  (`schema/message-samples.fixture.ts`), `WORST_CASES` (`schema/worst-case.fixture.ts`), `REQUEST_SAMPLES`
  (`packages/daemon/test/fixtures/request-samples.ts`), its `REAL_ANSWERS` line for the four roles
  (`packages/daemon/test/authorization.test.ts`), its handler, its rate / size-rule / sensitivity / owner-check pins
  in `registry.test.ts`, the wire texts it produces, and a line in `schema/protocol7.test.ts` for what a protocol-6
  peer meets. One prefix, `sticky` (D2.1): the prefix test of `registry.test.ts` gains it in S2.
- **Words, both languages in the same step.** Every user-visible text exists in English and zh-TW from the step that
  shows it: web `features/<f>/strings.ts` + `strings.zh-TW.ts` (or `src/strings/<area>.ts` + `.zh-TW.ts`), wire
  `packages/protocol/src/i18n/messages/*.ts` with its `'zh-TW':` form, CLI `packages/cli/src/i18n/{en,zh-TW}.ts`,
  guides in `docs/` and `docs/zh-TW/`. A key exists only with the code that uses it
  (`apps/web/src/strings/strings.test.ts`); a wire id is produced in its step
  (`packages/daemon/test/wire-texts.test.ts`; `packages/daemon/test/fixtures/wire-text-owners.ts` stays empty).
  Words are checked against `docs/GLOSSARY.md`; the glossary row of a new term comes with the first string that uses
  it. Everything an agent reads is fixed English. House style: plain, direct English, short sentences, "log in", no
  em dash as punctuation, Accept / 採用 and Reject / 不採用 for feedback (the suggestion's words, D4.3), "sticky note"
  written in full in labels.
- **The closed side**: where DESIGN leaves room, take the stricter, smaller, more honest choice and write it in the
  HANDOVER under "Choices I made"; where DESIGN is wrong or cannot be built as written, do the closed thing and
  write it under "For the lead".
- **The gate**, after the step's own files pass one package at a time (each step's "Gate" lists them), in four
  foreground parts:
  - P1 `pnpm typecheck`
  - P2 `pnpm exec vitest run --project @smurg/daemon`
  - P3 `pnpm exec vitest run --project @smurg/web --project @smurg/web-smoke --project @smurg/e2e`
  - P4 `pnpm exec vitest run --project @smurg/cli --project @smurg/protocol --project @smurg/relay --project
    @smurg/site --project @smurg/lint`
  The four green are `pnpm check` (`pnpm run typecheck && pnpm run test`). If P3 comes within a minute of ten on
  this machine, split it (P3a `--project @smurg/web`, P3b `--project @smurg/web-smoke --project @smurg/e2e`), say so
  in the HANDOVER, and every later step runs five parts.
- **The commit**: `git add <the paths you changed, by name>` (never `-A` or `.`), one commit. The subject in the
  repository's style (`git log --oneline -20`): lower case, what changed for a person and why, in one sentence or a
  few joined by commas and semicolons; a body only for the pins' answers and the numbers. Author as the repository
  is configured; attribution lines only as your own session's instructions require. Never push, tag, reset, rebase,
  stash, checkout, amend, or touch another branch. `git status --short` afterwards shows nothing of yours.
- **What a step hands over**: `/home/gclin/.claude/jobs/659485ab/tmp/handover/S<n>.md`, with: what was built (by
  decision number); the commit hash and subject; tests added (file and what each proves) and tests changed on
  purpose (with the reason); every pin re-taken and its answer; the gate's counts per part and wall times; EVERY
  catalog text added or changed, id by id, in both languages; choices made; what was not done and why; anything the
  next step must know (names of functions, seams, fakes, flaky places).

## S1. Protocol 7, shapes 4, and Claude for the sticky notes as a kind of session

**Design.** D1.1 (the folder and the name `Home`), D1.2 (note names, `noteNameOf`, `notePath`), D3.1 (the purpose),
D3.2 (`confinedPurpose`), D3.3 (G13 and G5 for notes, the allow rule), D3.5 (one per workspace: only the handover to
the host and the ending; nothing starts it yet), D3.6 (title, console label, the sidebar), D8.2 (protocol 7, the
Welcome's `protocol`), D8.3 (shapes 4, no step). The design folder is committed here.

**Owns.**
- Design folder: `docs/design/v0.8.0/{README.md (new), OWNER-BRIEF.md, DESIGN.md, BUILD-PLAN.md}` and `ANSWERS.md`
  when the lead has put it there. The README like `docs/design/v0.7.0/README.md`: a record, not the contract; what
  each file is; the sentence that the folder quotes zh-TW wording on purpose (`tests/lint/no-cjk.test.ts` exempts
  `docs/design/`).
- Protocol: `packages/protocol/src/constants.ts` (`PROTOCOL_VERSION = 7`) and `constants.test.ts:164`;
  `src/schema/handshake.ts` (`welcomeSchema` gains `protocol: z.literal(PROTOCOL_VERSION)`);
  `src/schema/entities.ts` (`AGENT_PURPOSES` + `'notes'`; the refine at `:492` becomes "a discussion and an item
  have `topicId`, a free and a notes session none"); `src/schema/paths.ts` (`NOTES_DIR = 'notes'`, `NOTES_HOME =
  'Home'`, next to `SPECS_DIR`); `src/schema/limits.ts` (`NOTE_NAME_MAX_CHARS = 80`); `src/notes.ts` (new:
  `noteNameSchema`, `noteNameOf(path)`, `notePath(name)`) and `src/notes.test.ts` (new); `src/tools.ts`
  (`confinedPurpose(purpose)`; `effectivePermissionMode` fixed for every confined purpose) and `tools.test.ts`;
  `src/names.ts` (`sessionTitleRef` for `notes`) and `names.test.ts`; `src/routing.ts` (`mayEndSession`'s purpose
  type) and `routing.test.ts`; `src/i18n/messages/sessions.ts` (`session.title.notes`); `src/index.ts` (exports);
  `src/schema/protocol6.test.ts` (the describe "protocol 6 › is the version a hello carries" removed, as 0.7.0
  removed protocol 5's; its Welcome literal gains `protocol`), `src/schema/protocol5.test.ts:63` and
  `src/codec.test.ts:432` (their Welcome literals gain `protocol`), `src/schema/protocol7.test.ts` (new),
  `src/schema/message-samples.fixture.ts`, `src/schema/worst-case.fixture.ts` (a notes `SessionInfo`),
  `src/client/testing/fake-daemon.ts:299` (its Welcome), `test/exports.test.ts:44`, `test/text-cost.test.ts`
  (EXPRESSIONS for `notes.ts`, and `noteNameSchema` in LOOKS).
- Daemon: `src/hooks/tool-gate.ts` (G13, and G5 for notes with `.smurg/`), `src/hooks/hook-events.ts` (`needsPath`
  for every confined purpose; the facts G13 needs), `src/hooks/deny-text.ts` (`GateDenyRow` + `G13` and its fixed
  English sentence), `src/hooks/mcp-tools.ts` (`sessionLabel` "Sticky notes"; `wait_for_lock` open to a notes
  session; the discussion-only tools stay discussion-only), `src/core/interfaces.ts` (`GateRow` + `'G13'`;
  `UserTeardown.handedOver` with `topicId` optional and the session's `purpose`),
  `src/conversation/permissions.ts` (the automatic deny with no card for every confined purpose),
  `src/sessions/agent/profiles.ts` (the discussion's tools, strict MCP, no remembered rules, mode `default`, no
  reach rules, the allow `fileRule('Edit', root, 'notes/*.md')`), `src/sessions/agent/agent-sessions.ts` (`start`
  takes `notes` with no topic and no item, main workspace only; `modeFixed`; `setMode`, `workspaceModeChanged`
  (`:1403`) and `restartAll` (`:1600`) skip it; ended ones follow a free session's retention, `:1645`, `:1661`),
  `src/sessions/session-manager.ts` (`:815`: only `purpose === 'free'` ends when its opener goes, a notes session
  passes to the host like a topic's; the audit detail takes `session.purpose`), `src/admin/teardown.ts` (the
  `session.handover` audit names the purpose; no `topicId` for a notes session), `src/core/state-store.ts`
  (`WORKSPACE_SHAPES = 4` and its comment), `src/core/fakes/{agents.ts, sessions.ts, build.ts}` (the same rules in
  the fakes).
- Daemon tests: `test/hooks/tool-gate.test.ts`, `test/conversation/permissions.test.ts`,
  `test/sessions/agent-pure.test.ts`, `test/sessions/agent-sessions.test.ts`, `test/teardown.test.ts`,
  `test/topics/plan-format.test.ts` (a plan whose item title is any valid note name parses),
  `test/version-refused.test.ts` (`:70`), `test/state-steps.test.ts:498`, `test/upgrade/pin.test.ts`,
  `test/upgrade/shapes/*.txt`.
- CLI: `packages/cli/test/main.test.ts:90,95`, `packages/cli/test/sea.test.ts:73`,
  `packages/cli/test/ctl-other-version.test.ts` (WELCOME_V7). E2E: `tests/e2e/test/workspace.test.ts:31`.
- Web: `apps/web/src/testing/fixtures.ts` (`makeWelcome` gives `protocol`),
  `apps/web/src/features/transfer/testing/fake-link.ts:701` (its Welcome),
  `apps/web/src/features/console/{SessionsSection.tsx (`purposeLabel`, `:58-65`; the end confirmation at `:236`),
  MembersSection.tsx (`:44`), strings.ts, strings.zh-TW.ts}` (`sessions.purpose.notes`),
  `apps/web/src/features/sidebar/tree-model.ts` (`:138`, `:181`: a notes session among the sessions without a
  topic), `apps/web/src/lib/columns/describe.ts`, `apps/web/src/features/conversation/{StatusBar.tsx, Composer.tsx}`
  only where their `'discussion'` branch means "confined", and the tests of each.
- Lint: `tests/lint/confined-purpose.test.ts` (new).
- Docs: `docs/GLOSSARY.md` ("Terms of 0.8.0": sticky note / 便利貼, with `session.title.notes`), ARCHITECTURE §7.7 (row
  G13, G5's notes clause) and §7.6 (the notes purpose in the sessions' table); `.github/ISSUE_TEMPLATE/bug.yml:31`
  is NOT changed (it names 0.7.0's banner; the release commit changes it with the version).

**Does.**
- `PROTOCOL_VERSION = 7`. `welcomeSchema` gains the required key `protocol` (the number); the daemon puts it in both
  Welcomes it builds (`packages/daemon/src/daemon.ts:665-672`, the control socket's; `src/net/admission.ts:187-195`,
  the relay's). A 0.7.0 command now refuses a 0.8.0 attach answer (unknown key) and the other way round (missing
  key), for this and every later protocol.
- `noteNameSchema` (D1.2, exactly): NFC; at most `NOTE_NAME_MAX_CHARS` UTF-16 units; none of `/ \ [ ] | # ^` and of
  `` ` * _ ~ < > & @ ``; no white space but U+0020; `agentText(name)` returns the name unchanged and not cleaned
  (this refuses controls, bidi, U+2028, U+2029 and invisibles); not `.` or `..`; no leading or trailing space or
  dot; `notes/<name>.md` passes `checkRelPath` and is not `isHostOnlyPath` (so `CLAUDE` is no name); the name passes
  `topicNameSchema`. `noteNameOf(path)` returns the name when `path` is `notes/` + one segment + the literal suffix
  `.md` and that segment's stem passes `noteNameSchema`, else null; `notePath(name)` is `notes/<name>.md`.
- `confinedPurpose(purpose)` is true for `discussion` and `notes`. Every test of the literal `'discussion'` that
  means "this session is confined" uses it: `hooks/hook-events.ts:368`, `hooks/tool-gate.ts:110` (G5),
  `conversation/permissions.ts:151`, `sessions/agent/profiles.ts:188,250,297,329`,
  `sessions/agent/agent-sessions.ts:409,410,1181,1182,1317,1403,1600`, `protocol/src/tools.ts:70`, the fakes
  (`core/fakes/agents.ts:172-212,344`). The places that really mean a topic's discussion keep the literal (G6,
  `topics/*`, the discussion-only MCP tools, `session-manager.ts:754`, the web's topic branches).
- Gate row G13 (D3.3): for a notes session, an edit tool is denied unless `noteNameOf` accepts the resolved path in
  the MAIN workspace, `notes` itself is a real folder (not a symlink), no directory is at that path, and no other
  file of `notes/` has the same `foldRelPath`. The pure `gateDecision` takes these as facts; `hook-events.ts`
  gathers them with one `lstat` of `notes`, one of the target and one `readdir` of `notes/` (async, as the caller's
  principal). G13 holds whoever started the session (the host's too). For a notes session G5 also refuses `.smurg/`.
  G13's sentence (fixed English): "Refused by smurg: Claude for the sticky notes writes only Markdown files directly
  in notes/ (a valid sticky note name, then .md)." Every permission request of a confined session is denied with no
  card (the existing `discussion` auto answer kind, renamed only if a test needs the name).
- Mode fixed: `session.mode.set` refuses (`mode-not-fixed`, `session.mode.fixed`); the wire says `ask-all`, Claude
  Code runs `default`. A notes session's profile: tools `Read, Glob, Grep, Edit, Write, AskUserQuestion`, strict
  MCP, no remembered rules, no worktree, `reachDenyRules` empty (the gate confines it), one allow rule
  `Edit(//<root>/notes/*.md)`.
- When the member who started it leaves, is kicked or loses agent access, the session passes to the host
  (`agents.setOwner`, the conversation line `conversation.owner.handover`); the host or the opener may end it
  (`mayEndSession` already says so for a session nobody is responsible for).
- Title: `session.title.notes` "Sticky notes" / 便利貼; console `sessions.purpose.notes` "Sticky notes" / 便利貼; the
  sidebar lists it among the sessions without a topic; `mcp-tools.ts` names it "Sticky notes" to other agents.
- `WORKSPACE_SHAPES = 4` with no step: the purpose widens a stored enum of `agent-sessions.json`; 0.7.0 refuses a
  folder this smurg wrote as newer. Nothing starts a notes session over the wire yet (tests use
  `ctx.services.agents.start({ purpose: 'notes', ... })` with a test role prompt).

**Tests.**
- New: `packages/protocol/src/notes.test.ts` (every rule of D1.2, one case each, with the reason as the case title;
  `notes/CLAUDE.md`, `notes/x.MD`, `notes/a/b.md`, `notes/.md`, `Ho<U+200B>me`, `X<U+2028>Y`, an 81-unit name, NFD
  input, a name that is a valid topic name); `src/schema/protocol7.test.ts` (version 7; a protocol-6 Welcome, with
  no `protocol`, is refused; the strict `agentSessionSchema` of tag `v0.7.0` (the code of protocol 6, by `git
  archive` as `protocol6.test.ts` does with v0.6.0; skipped without the tag, failing with `SMURG_RELEASE_GATE=1`)
  refuses a session of purpose `notes`); `tests/lint/confined-purpose.test.ts` (fails on a new `=== 'discussion'` or
  `!== 'discussion'` in `packages/*/src` and `apps/web/src` outside a named list of places that mean a topic's
  discussion, each with its reason).
- G13 rows in `test/hooks/tool-gate.test.ts`: `notes/Home.md` passes to the lock decision; refused:
  `notes/CLAUDE.md` and `notes/claude.md` (also for a session the host started), `notes/x.MD`, `notes/a/b.md`,
  `notes/x.txt`, `src/x.ts`, a directory `notes/x.md`, `notes/home.md` beside `notes/Home.md`, `notes` as a symlink
  to `src/`, a worktree root; G5 for notes: a read outside the root, of `.envrc`, of `.smurg/uploads/x`, a Glob with
  `..`.
- `test/conversation/permissions.test.ts`: a notes session's permission request is answered deny, no card.
- `test/sessions/agent-pure.test.ts` and `agent-sessions.test.ts`: the profile's argv and settings, the fixed mode,
  `workspaceModeChanged` and `restartAll` leave it, retention ends it like a free one; `test/teardown.test.ts`: the
  opener kicked, the session is the host's and not ended, the audit names purpose `notes`.
- Pins that change, each with its reason and the command that re-takes it:
  - the protocol number (`7`, "7 since 0.8.0: sticky notes"): `constants.test.ts:164`, `test/exports.test.ts:44`,
    `packages/cli/test/sea.test.ts:73`, `packages/cli/test/main.test.ts:90,95` (`protocol v7`),
    `tests/e2e/test/workspace.test.ts:31`, `packages/daemon/test/version-refused.test.ts:70-71` (a new case
    "protocol 7 (0.8.0): a page or a command of 0.7.0 speaks protocol 6, of 0.6.0 protocol 5 and of 0.5.x protocol
    4: each is answered `version`, as an older peer"; the old case removed).
    `apps/web/e2e/smoke/version.smoke.test.ts` (`PROTOCOL_VERSION + 1`) does not change.
  - the Welcome literals: `protocol5.test.ts:63`, `protocol6.test.ts:70`, `codec.test.ts:432` gain `protocol:
    PROTOCOL_VERSION` (today's Welcome is their baseline); re-taken with `pnpm --filter @smurg/protocol exec vitest
    run src`.
  - `packages/cli/test/ctl-other-version.test.ts`: `WELCOME_V7` (`WELCOME_V6` plus `protocol: 7`) beside
    `WELCOME_V6`, `WELCOMES` gains `7`; the expectation at `:677` becomes `[4, 5, 6]`; the labels at `:711` become
    `4: '0.4.0 to 0.5.2'`, `5: '0.6.0'`, `6: '0.7.0'`; `TAG` stays `'v0.6.0'`: the tag's strict schema still refuses
    this smurg's Welcome with `unrecognized_keys` (`merging` and `protocol`). Re-taken with `pnpm --filter
    @smurg/cli exec vitest run test/ctl-other-version.test.ts`.
  - `WORKSPACE_SHAPES`: `packages/daemon/test/state-steps.test.ts:498` `toBe(4)` ("4 since 0.8.0, DESIGN 0.8.0
    D8.3"); `test/upgrade/pin.test.ts` `PINNED_AT_SHAPES = 4` with the question answered in its comment ("YES: the
    purpose `notes` widens `agent-sessions.json`'s enum; no document changes otherwise; no step: 0.6.0 and 0.7.0
    widened enums the same way"); the hashes of `sessions/agent/store.ts` if it changed,
    `sessions/session-manager.ts`, `schema/entities.ts`, `schema/handshake.ts`, `schema/paths.ts`,
    `schema/limits.ts`, `constants.ts`, `routing.ts`, and of any protocol module the walk now finds (`tools.ts` when
    `session-manager.ts` imports `confinedPurpose`); the shape text `shapes/agent-sessions.json.txt`. Command:
    `SMURG_PIN_WRITE=1 pnpm --filter @smurg/daemon exec vitest run test/upgrade/pin.test.ts`, hashes by hand.
  - The upgrade lists, checked and NOT changed: `FIRST_OF_SHAPES` in `test/upgrade/persisted.ts:136` stays `{ 1:
    '0.5.1', 2: '0.6.0', 3: NOT_PUBLISHED }` (it is read only for the kept copies of steps,
    `firstOfShapes(step.sinceShapes)`, and shapes 4 has no step); `NOT_PUBLISHED_YET` gains nothing (an enum value
    is no coverage point of `test/upgrade/walker.ts`; `fixtures.test.ts` proves it); `other-version.test.ts` needs
    no edit: its tag v0.6.0 writes shapes 2, so the tag refuses this tree's folder as newer, and this tree still
    runs 0.7.0's step from 0.6.0 on the tag's folder (`upgraded.length > 0`, `beyondTheTag()` = `merging: 'auto'`);
    `wire.test.ts` says "raised" (7 against 5) and skips its three comparisons. Their comments ("The newest
    published smurg (0.6.0)", "Emptied by 0.7.0's own fixture after its release") stay: they name the tag the tests
    use, and main pays the debt.

**Gate.** `pnpm --filter @smurg/protocol exec vitest run src test`; `pnpm --filter @smurg/daemon exec vitest run
test/hooks test/sessions test/conversation test/teardown.test.ts test/topics/plan-format.test.ts test/upgrade
test/version-refused.test.ts test/state-steps.test.ts`; `pnpm --filter @smurg/web exec vitest run
src/features/console src/features/sidebar src/lib/columns src/features/conversation`; `pnpm --filter @smurg/cli exec
vitest run test/main.test.ts test/ctl-other-version.test.ts`; `pnpm exec vitest run --project @smurg/lint
tests/lint/confined-purpose.test.ts tests/lint/no-cjk.test.ts`; then P1 to P4.

**Commit.** "protocol 7 and workspace shapes 4, and Claude for the sticky notes as a kind of agent session: it reads
the project like a topic's discussion and writes only Markdown files directly in notes/, which smurg's own tool gate
enforces (G13), its mode is fixed and anything else it asks is refused without a card, and it passes to the host
when its starter goes; a command and a daemon of different protocols refuse each other's Welcome; nothing starts it
yet; the 0.8.0 design is kept in docs/design/v0.8.0". Body: the pin's answer.

## S2. The sticky module: the index, the list, a new note, starting Claude for the sticky notes

**Design.** D1.3 (folded names, `shadowed`), D1.4 (`wikiLinks`), D1.5 (`oversized`, `unreadable`, `invalid`), D1.6
(no rename or delete here), D2.1-D2.5 (the module, the index, `noteTree`, `sticky.list`, `sticky.changed`,
`sticky.create`), D3.4 (the role prompt), D3.5 (`sticky.assistant.start`), and the document `sticky.json` of D4.5
with its whole stored shape (so S5, S7 and S8 change no stored shape).

**Owns.**
- Protocol: `src/notes.ts` (`wikiLinks(text)`, `noteTree(notes)`) and `notes.test.ts`; `src/schema/limits.ts`
  (`NOTE_LINKS_MAX = 32`, `NOTE_MAX_BYTES = 64 KiB`, `NOTES_MAX = 500`, `FEEDBACK_TEXT_MAX_CHARS = 4000`,
  `FEEDBACK_MAX = 1000`, `FEEDBACK_STORED_MAX_CHARS = 2 Mi`, the waiting budgets of D4.5, `NOTE_BUILDS_MAX = 200`);
  `src/schema/sticky.ts` (new: `NoteInfo`, `SourceState`, and the entities `sticky.json` stores: the feedback entry
  of D4.3 with both author kinds, the cursors of D6.3, the build record of D5.2); `src/schema/messages/sticky.ts`
  (new) and `src/schema/registry.ts` (`sticky.list` [file.read, sizeRule `list`], `sticky.changed` [d2c, file.read,
  `recipients:all`], `sticky.create` [file.write], `sticky.assistant.start` [session.create]);
  `src/schema/index.ts`, `src/index.ts`; `src/schema/registry.test.ts` (prefix set + `sticky` and its title "... and
  protocol 7's sticky", ARCH_CATALOG rows and its header comment (§5.1 to §5.12), the size-rule pin + `sticky.list:
  'list'`); `src/schema/message-samples.fixture.ts`, `src/schema/worst-case.fixture.ts` (500 notes at the limits
  through the list rule; a `sticky.changed` at its largest), `src/schema/protocol7.test.ts`;
  `src/i18n/messages/sticky.ts` (new) and `src/i18n/index.ts` (MESSAGE_GROUPS, MESSAGES); `test/text-cost.test.ts`
  (EXPRESSIONS for `notes.ts`; `wikiLinks` in LOOKS at 1x and 16x).
- Daemon: `src/sticky/{module.ts, index.ts (the index), service.ts, store.ts (declareDocument name 'sticky'),
  handlers.ts, prompts.ts (notesRolePrompt)}` (new; no feature service slot, like `local/module.ts`: nothing else
  calls it); `src/daemon.ts` (`DEFAULT_FEATURE_MODULES`: `stickyModule` after `topicsModule`, before `inboxModule`;
  the module-order comment); `test/composition.test.ts:155-163` (the list and `before('sessions', 'sticky')`,
  `before('conversation', 'sticky')`, `before('topics', 'sticky')`), `test/fixtures/pending-v050.ts:12`
  (`RELEASE_MODULES`), `test/integration/release-composition.test.ts:123`; `test/fixtures/request-samples.ts`;
  `test/authorization.test.ts` (`REAL_ANSWERS`); `test/sticky/{index.test.ts, create.test.ts, assistant.test.ts,
  prompts.test.ts}` (new); `test/text-cost.test.ts` (the index's reading of one note, `wikiLinks` included, in
  LOOKS at 1x and 16x of `NOTE_MAX_BYTES`; EXPRESSIONS and ORDERINGS of `src/sticky/`, the fold twins' sort
  included).
- Upgrade tests: `test/upgrade/persisted.ts` (`DOCUMENT_SINCE` typed `Readonly<Record<string, PublishedVersion |
  typeof NOT_PUBLISHED>>`, entry `sticky: NOT_PUBLISHED`), `test/upgrade/set-aside.test.ts` (`CAN_BE_SET_ASIDE` +
  `sticky: false`, with its reason), `test/upgrade/pin.test.ts` (the roots list + `sticky/store.ts`,
  `DAEMON_SOURCES` + `sticky/store.ts`, the pinned kinds + `sticky.json`, `PROTOCOL_SOURCES` + the modules the store
  leads to, at least `notes.ts` and `schema/sticky.ts`), `test/upgrade/shapes/sticky.json.txt` (new).
- Docs: `docs/HOSTING.md` and `docs/zh-TW/HOSTING.md` §9.3 (`sticky.json` named as a file that cannot be set aside,
  with what it holds), ARCHITECTURE §5.12 `sticky.*` (the four rows) and §7.2 (one line: the module `sticky/`).

**Does.**
- `wikiLinks(text)`: one pass, no regular expression that can go quadratic, a link at most `NOTE_NAME_MAX_CHARS + 4`
  units, skips fenced code and code spans, returns the names in order, each once; a target that fails
  `noteNameSchema` is dropped. `noteTree(notes)`: breadth first from `Home` along the links; a note's parent is the
  first note that reaches it; the rest are "not linked"; names compared by `foldRelPath`; siblings in link order.
  The web sorts the "Not linked" rows with `compareText` of `apps/web/src/lib/format.ts`.
- The index (D2.2): built by listing `notes/` of the main workspace at the module's start (no `notes/`: empty, no
  read); kept from the bus `file.changed` (debounced, as `topics/core.ts` does), with a full listing again when
  `notes` itself appears or disappears and after a watcher error. Each note is read as a member without rights would
  read it: PathGuard with a Viewer principal, `finalSymlink: 'deny'`, a regular file with one hard link, the
  resolved path a note's file; else `unreadable` by name. `oversized` over `NOTE_MAX_BYTES` (no links), `unreadable`
  when not valid UTF-8, `invalid` counted, `shadowed` for a fold twin (the one that sorts first by code unit is the
  note), at most `NOTES_MAX` (`truncated`). Async reads only. Nothing of a note's content but its links is kept.
- `sticky.list` `{ after? }` → `{ notes: NoteInfo[], hasMore, truncated, sources }` through `takeListPage`
  (`sources` is `[]` until S8). `sticky.changed` `{ upserted, removed, truncated, sources? }` to every member who
  holds `file.read`, only when a note's links or flags change. `NoteInfo = { name, links, oversized?, unreadable?,
  shadowed?, builds? }` (`builds` empty until S7).
- `sticky.create` `{ name }` [file.write], as the caller, in one per-workspace serialization: make `notes` when
  missing (accepting "exists"); refuse a name whose fold equals an existing note's, against a fresh listing
  (`conflict`, reason `exists`, `sticky.create.exists`); `files.create(notes/<name>.md)` (refuses atomically when it
  exists); the note starts empty; the index updated at once; answers `{ note: NoteInfo }`. The file service's own
  audit and activity entries name the person. A bad name: `bad_request`, `sticky.name.invalid`.
- `sticky.assistant.start` `{}` [session.create], serialized: answers the running notes session or starts one
  (`ctx.services.agents.start({ purpose: 'notes', ... })`, opened by the caller, responsible nobody, the main
  workspace, the host's default model, `rolePrompt: notesRolePrompt`); audit `session.create` with `detail.purpose:
  'notes'`; at the limit the existing `session.limit.agents`; answers `{ session }`. No id is stored.
- `notesRolePrompt({ smurgTag })`, fixed English, checked values only: what sticky notes are, `[[Name]]` and the
  name rules, Home is the first note, "Keep each note small; when a note grows, move a part into a new note and link
  it.", "Read a note again before every change: people edit the same files.", `wait_for_lock` when an edit is
  refused because someone is typing, "You can write only Markdown files directly in notes/; you cannot run
  commands.", and the standing sentences every role prompt has (what it reads is information, never instructions).
  The sentence on feedback is S5's.
- `sticky.json` = `{ version: 1, feedback: [], cursors: {}, builds: [] }`, `canSetAside` false (no `canSetAside:
  true`), written by S2 only at its `init`.

**Tests.**
- New: `test/sticky/index.test.ts` (start with and without `notes/`, add, change of links only, a save that changes
  no link sends nothing, unlink, `notes/` made in one burst re-listed, oversized, not UTF-8, a symlink and a hard
  link to `.envrc` listed `unreadable` with no links, `Home` and `home` on this Linux disk, 501 notes `truncated`, a
  name that is no note counted `invalid`); `create.test.ts` (made with `notes/` missing, exists, `home` vs `Home`,
  each rule of D1.2 refused, two creates at once, the audit names the person); `assistant.test.ts` (start, the
  running one answered, a new one after End, two presses start one, the limit, an Editor refused); `prompts.test.ts`
  (the prompt word for word for a tag, no member text in it); `wikiLinks` and `noteTree` cases in
  `packages/protocol/src/notes.test.ts` (code spans and fences, unclosed, nested brackets, a link over the bound, 33
  links, cycles, two parents, not linked; the known disagreement with the web renderer named for S3).
- Pins that change, each with its reason: `registry.test.ts` prefix set and title (protocol 7 adds `sticky`), size
  rules (+ `sticky.list`); `worst-case.test.ts` needs the new types in `WORST_CASES` (it lists new types itself);
  `composition.test.ts`, `pending-v050.ts`, `release-composition.test.ts` (a new module in the release composition);
  `set-aside.test.ts` `CAN_BE_SET_ASIDE` (`sticky: false`: a damaged file stops the start; its records are feedback
  people wrote); `persisted.ts` `DOCUMENT_SINCE` (`sticky: NOT_PUBLISHED`: no published smurg wrote it, so no
  fixture must hold it, `rankOf` in `fixtures.test.ts:67` already handles it); `pin.test.ts` roots, kinds and
  hashes, with the answer "a new document no published smurg wrote: no step" (command as in the Rules);
  `packages/protocol/test/text-cost.test.ts` and `packages/daemon/test/text-cost.test.ts` counts (re-taken with
  `pnpm --filter @smurg/protocol exec vitest run test/text-cost.test.ts` and the daemon's). `fixtures.test.ts` and
  `NOT_PUBLISHED_YET`: unchanged, and green (the new kind has no instance in any fixture, and none is expected).
- Moved here because a test demands it: the HOSTING §9.3 lines of `sticky.json` in both languages
  (`tests/lint/guide-update.test.ts` "every other document, and the key, is named as a file that cannot be set
  aside" fails for a declared document §9.3 does not name).

**Gate.** `pnpm --filter @smurg/protocol exec vitest run src test`; `pnpm --filter @smurg/daemon exec vitest run
test/sticky test/authorization.test.ts test/composition.test.ts test/integration/release-composition.test.ts
test/upgrade test/wire-texts.test.ts test/wire-texts.zh-TW.test.ts test/text-cost.test.ts`; `pnpm exec vitest run
--project @smurg/lint tests/lint/guide-update.test.ts tests/lint/docs-parity.test.ts`; `pnpm --filter @smurg/site
exec vitest run`; then P1 to P4.

**Commit.** "the daemon keeps an index of the sticky notes in notes/ (each note's links and whether it can be read,
read as a member without rights would read it), lists it in pages and tells every member only what changed; a member
who may write makes a new empty note, and a member with agent access starts the one Claude for the sticky notes of
the workspace; sticky.json is declared, not published, and cannot be set aside". Body: the pin's answer.

## S3. The notes view, read half (D7.1-D7.4, D7.5's read view, D7.6)

**Design.** D7.1 (route, three modes), D7.2 (`NotesView`, panes, skip link, F6), D7.3 (feature folder, MOUNTS, the
store area), D7.4 (the tree, `ui/Tree`'s opt-in prop, the "Not linked" group), D7.5 (only listed notes are held; the
Read view with wiki links; the lock line), D7.6 (the pages without a note, with `sticky.create`).

**Owns.**
- Router and shell: `apps/web/src/lib/router.ts` and `router.test.ts` (one anchored pattern
  `/^\/w\/([^/]+)\/notes(?:\/([^/]+))?\/?$/`, `encodeURIComponent` out, decode inside `try` in),
  `src/lib/commands.ts` (`WorkspaceMode` + `'notes'`), `src/app/App.tsx` (`Routes`: `case 'notes'` renders the same
  `WorkspaceRoute` element with `view="notes"` and the `note`, so switching modes keeps one connection),
  `src/app/workspace/{WorkspaceShell.tsx (goTo over three modes, the view mounted on first show, hidden and inert
  otherwise), WorkspaceRoute.tsx (viewPath keeps the note), TopBar.tsx (the third link, its href the last note open
  in this page; no layout toggles in the notes view), NotesView.tsx (new, `lazyChunk` like `Workbench.tsx`),
  layout-limits.ts (`MIN_NOTE_PX`)}` and `WorkspaceShell.test.tsx`, `layout-limits.test.ts`;
  `src/strings/workbench.ts` and `workbench.zh-TW.ts` (`mode.notes`, `mode.notes.title`, the regions' names, the
  skip link).
- Store: `src/lib/stores/sticky.ts` (new: notes by folded name, `truncated`, `sources`; `selectNoteTree`;
  `sticky.list` through `collectPages` under `withGeneration`, `sticky.changed` bound, reload on resume; object
  identity kept for unchanged notes), `src/lib/stores/base.ts` (`AreaName` + `'sticky'`), `src/lib/stores/index.ts`
  (the notes index loaded when the notes view is first shown, NOT at channel open, D7.3: `src/testing/stores.ts`
  `EMPTY_LOADS` and `src/lib/stores/stores.test.ts` do not change here; S6 adds the feedback, which loads with the
  channel for a member with `session.drive`).
- Feature: `apps/web/src/features/sticky/{index.tsx, model.ts, NoteTree.tsx, NoteRead.tsx, NoPage.tsx (no Home; a
  name not written yet), strings.ts, strings.zh-TW.ts, sticky.css, sticky.test.tsx, sticky.zh-TW.test.tsx}` (new;
  the zh-TW suite is required by `tests/lint/pinned-locale.test.ts:40-45` for every feature folder).
- Markdown: `apps/web/src/features/markdown/{render.tsx, Markdown.tsx, index.ts, strings.ts, strings.zh-TW.ts,
  markdown.css, markdown.test.tsx}` (the option `wikiLinks?: { find, exists, href }`, synchronous; off in code spans
  and link words; merged in `textRun` before path marks; `<a class="md-wiki" href>` titled "Open the sticky note
  {name}"; a missing note `md-wiki--missing` with visually hidden "(not written yet)", never colour alone; included
  in `sameContext`).
- `apps/web/src/ui/Tree.tsx` and `Tree.test.tsx` (an opt-in `activatesGroups`: Enter, Space and a click open a row
  with children and unfold it; the twisty only folds; the default unchanged, so `SessionTree` and today's test
  stay).
- `apps/web/src/app/workspace/feature-slots.test.ts` (MOUNTS + `'sticky → markdown/index.ts'` and `'sticky →
  editor/standalone.tsx'`, each with its reason line).
- `apps/web/test/text-cost.test.tsx` (`'lib/router.ts': 5`; the new files' counts; the finder in LOOKS; a
  "`<Markdown>` with wiki links" entry in MOUNTS).
- `apps/web/e2e/smoke/helpers.ts` (`SmokeMode` + `'notes'`; `toMode`'s selectors `a[href$="/code"]`,
  `a[href*="/notes"]`, `a:not([href$="/code"]):not([href*="/notes"])`).
- Docs: `docs/GLOSSARY.md` ("Terms of 0.8.0": Sticky notes (the view), Home, wiki link, "Not linked", "not written
  yet").

**Does.** `NotesView` is tree | note | chat in split panes (`SplitPane` with the storage keys `notes-tree` and
`notes-chat`, so `smurg.pane.*`; no field is added to `smurg.layout`), with its own skip link and F6 stops; the open
note is in the address, the unfolded rows in memory only. The left pane is the tree from `noteTree` (Home first;
"Not linked" below; `truncated` said in one line). The middle is the open note: held as a shared document
(`useHeldDocument(listed ? file : null)`, `useDocumentText`) only when the index lists it or `sticky.create` just
answered for it, keyed by its folded name, with a spinner while its text is null; drawn with the Markdown renderer
and `wikiLinks`; one line from the locks store when an agent holds its lock ("Claude is writing this sticky note.").
A link is always an `<a href>` to the note's route. Pages without a note (D7.6): no `notes/Home.md` yet: "Write the
first sticky note" for `file.write` (calls `sticky.create { name: 'Home' }`), a sentence for a Viewer; a valid name
not written yet: "Write this sticky note" for `file.write`, a sentence for a Viewer; a name that fails
`noteNameSchema` or does not decode: the not-found page. The address takes the on-disk spelling of a folded name.
`Home` is the same in both languages (file names are not translated). No Edit, no chat, no feedback yet: the right
pane is empty and says nothing.

**Tests.**
- New: `src/features/sticky/sticky.test.tsx` (tree order, Home opens from the tree, "Not linked", a Viewer sees no
  write buttons, a missing link's page, a fast A→B→C switch opens and closes one document each, the lock line) and
  `sticky.zh-TW.test.tsx`; `src/lib/router.test.ts` new cases (spaces, `%`, CJK, `?`, `%E0` → not found, an invalid
  name → not found, `/w/<id>/notes` → no note); `markdown.test.tsx` (wiki links off in code spans and link words, a
  missing note drawn apart with words, the known difference with `wikiLinks` of the daemon named in one test);
  `Tree.test.tsx` one case for `activatesGroups`; `WorkspaceShell.test.tsx` (the notes view mounts once, three modes
  switch, a login from a note returns to it); `src/app/app.zh-TW.test.tsx` (the zh-TW mode link 便利貼).
- Kept on purpose: the title "parses the routes of ARCHITECTURE §9: landing, join, the two modes of a workspace, the
  console and its sections" of `router.test.ts` is referenced by `docs/ACCEPTANCE.md` T7.1
  (`tests/lint/acceptance-refs.test.ts`): the notes routes get their own test, the old title stays.
- Pins that change: MOUNTS (two lines: the read view holds the note as a shared document and renders it as
  Markdown); `text-cost.test.tsx` router count 4 → 5 (the new anchored route pattern) and the new files, re-taken
  with `pnpm --filter @smurg/web exec vitest run test/text-cost.test.tsx`.
- Moved here because a test demands it: the smoke helper `toMode` (`apps/web/e2e/smoke/helpers.ts`), because its
  selector `a:not([href$="/code"])` matches the third link and every smoke that calls `toMode`, `toCodeMode` or
  `toSessionsView` (for example `flow.smoke.test.ts` › "T7.1 the mode switch keeps both sides") would fail in S3.

**Gate.** `pnpm --filter @smurg/web exec vitest run src/lib src/app src/ui src/features/sticky src/features/markdown
src/strings test/text-cost.test.tsx`; `pnpm --filter @smurg/web run typecheck`; `pnpm --filter @smurg/web run build`
(its `check-chunks`: nothing of the notes view or Monaco in the workspace route's chunk); `pnpm exec vitest run
--project @smurg/web-smoke flow topics columns`; `pnpm exec vitest run --project @smurg/lint
tests/lint/pinned-locale.test.ts tests/lint/acceptance-refs.test.ts`; then P1 to P4.

**Commit.** "a third view, Sticky notes, beside the sessions view and code mode: the tree of notes grown from Home
by their wiki links, the open note read as Markdown with its links, a page that offers to write a note that does not
exist yet, and a first page that offers to write Home".

## S4. The notes view, edit half, with a real-browser smoke test (D7.5's edit half, D7.7)

**Design.** D7.5 ("Edit" with the shared editor, "Add a sticky note" in one local transaction), D7.7 (the chat, its
states, Start Claude, Ask Claude, a link to a note in the conversation).

**Owns.**
- `apps/web/src/features/sticky/{NoteEdit.tsx, AddNote.tsx, model.ts, strings.ts, strings.zh-TW.ts, sticky.css,
  sticky.test.tsx, sticky.zh-TW.test.tsx}`.
- `apps/web/src/features/editor/{standalone.tsx, standalone.test.tsx}` (a prop that hides "Send to agent"; the
  default unchanged).
- `apps/web/src/app/workspace/{NotesView.tsx (the chat pane: a `ColumnFrame` of `features/columns` on `{ kind:
  'session', sessionId }` of the notes session, keyed by its id; "Ask Claude about this sticky note" through
  `draftsOf` of `features/conversation/drafts.ts`), WorkspaceShell.tsx (the `openInCodeMode` handler: while the
  notes view is shown, a main-root `notes/<valid name>.md` opens that note in the notes view)}` and
  `WorkspaceShell.test.tsx`; `src/strings/workbench.ts` and `.zh-TW.ts` (the chat pane's words if they live there).
- `apps/web/e2e/smoke/notes.smoke.test.ts` (new, after `console.smoke.test.ts`: two pages in two browser contexts,
  `locale` named on each `newContext`, the stand-in `claude` from `installFakeClaude` (its turn a `Write` step to
  `notes/Ideas.md` and an `Edit` of `notes/Home.md`), given to `startSmoke({ stack: { sessions: { claudePath,
  selfCommand } } })` as `columns.smoke.test.ts:109-114` does).

**Does.** "Edit" (not for a Viewer) shows `StandaloneDocument` for the one note, without "Send to agent", in the
notes view's lazy chunk. "Add a sticky note" (only while the note is writable and the replica synced) asks a name,
calls `sticky.create`, then on success or `exists` appends `- [[Name]]` to the open note in one local transaction of
the shared document (`held.session.doc.transact(...)`); when the note became read-only in between it says so and the
new note is under "Not linked". The chat: a spinner until the session list is loaded; no notes session or an ended
one: "Start Claude" / "Start Claude again" (`sticky.assistant.start`) for `session.create`, a sentence for the
others; an Editor sees the composer's own line that messages are suggestions; a Viewer has no box. The notes session
is the one of purpose `notes` that has not ended, found in the sessions store. "Ask Claude about this sticky note"
(members with a composer) puts `[[Name]]` and a new line into the composer's draft and moves the focus there.

**Tests.**
- Unit: Edit absent for a Viewer; Add a sticky note writes the line and creates once when pressed twice; the
  read-only case; the chat's five states; the draft gets the link; a path `notes/Ideas.md` in Claude's text opens
  the note while the notes view is shown, code mode otherwise; `standalone.test.tsx` the new prop.
- New smoke `notes.smoke.test.ts`: the first page (Home written by the host), Home seen by a second page (an Editor)
  live while typed, a link followed to a page not written yet and written, "Start Claude", a stand-in turn that
  writes `notes/Ideas.md` and its link in Home shows the new note in both pages; no console error (CSP); both pages
  have a `locale`.
- Pins: none. Measure P3 with the new smoke and split it if the rule of the Rules says so.

**Gate.** `pnpm --filter @smurg/web exec vitest run src/features/sticky src/features/editor src/app`; `pnpm --filter
@smurg/web run build`; `pnpm exec vitest run --project @smurg/web-smoke notes`; `pnpm exec vitest run --project
@smurg/lint tests/lint/pinned-locale.test.ts`; then P1 to P4.

**Commit.** "people edit a sticky note together in place, add a note linked from the open one, and talk to Claude
for the sticky notes on the right of the view, which writes notes everyone sees at once; a link to a note in the
conversation stays in the notes view".

## S5. Feedback, daemon half (D4)

**Design.** D4.1 (`feedback.give` and its test; the ARCHITECTURE rows are S9's), D4.3 (the entity), D4.4 (the wire),
D4.5 (the bounds; a removed member's waiting feedback withdrawn), D4.6 (accept: one send), D4.7 (reject and withdraw
send nothing), D4.8 (the audit actions and their console labels).

**Owns.**
- Protocol: `src/roles.ts` (`feedback.give`, all four roles) and `roles.test.ts` (its own test "give feedback |
  every role", with the comment "It has no row in SPEC §8", like `discuss`; `ARCH_3` + its row);
  `src/schema/entities.ts` (`AUDIT_ACTIONS` + `sticky.feedback.create`, `sticky.feedback.accept`,
  `sticky.feedback.reject`, `sticky.feedback.withdraw`); `src/schema/messages/sticky.ts` and
  `src/schema/registry.ts` (`sticky.feedback.create` [feedback.give, rate `suggestion`], `sticky.feedback.withdraw`
  [owner-checked-in-handler, check `feedback-author-waiting`], `sticky.feedback.accept` [session.drive,
  `feedback-waiting`], `sticky.feedback.reject` [session.drive, `feedback-waiting`], `sticky.feedback.list`
  [file.read, sizeRule `list`], `sticky.feedback.updated` [d2c, file.read, `recipients:all`]; `HANDLER_CHECKS` + the
  two checks); `src/schema/registry.test.ts` (ARCH_CATALOG, the owner-checked set at `:266` +
  `feedback-author-waiting`, the rate pin + `sticky.feedback.create: 'suggestion'`, the size rules +
  `sticky.feedback.list: 'list'`, the resource rules); `src/agent-text.ts` (`composeFeedback({ note, author, text
  })` next to `composeRevise`, `outsideSafeName(source, name, externalId)`) and `agent-text.test.ts`; samples, worst
  cases (1000 entries through the list rule), `protocol7.test.ts` (a capability and four audit actions a protocol-6
  peer refuses); `src/i18n/messages/sticky.ts`; `test/text-cost.test.ts` (`agent-text.ts` count if it grows).
- Daemon: `src/sticky/{feedback.ts (new: the feedback service), accept.ts (new: the one send), service.ts,
  handlers.ts, store.ts, prompts.ts (the sentence on how accepted feedback arrives), module.ts (the bus events
  `member.kicked` and `member.left`: their author's waiting feedback withdrawn by the system)}`;
  `test/sticky/{feedback.test.ts, accept.test.ts}` (new); `test/fixtures/request-samples.ts`;
  `test/authorization.test.ts` (six types, four roles); `test/rates.test.ts` (the registry's buckets +
  `sticky.feedback.create: 'suggestion'`); `test/upgrade/pin.test.ts` (hashes of `roles.ts`, `schema/entities.ts`,
  `agent-text.ts`, `schema/registry.ts`, `schema/messages/sticky.ts`, the store if it changed;
  `shapes/audit.line.txt`).
- Web (required by the audit enum): `apps/web/src/features/console/{audit-labels.ts, strings.ts, strings.zh-TW.ts}`
  (four labels; and `demote.viewer`, `demote.viewerNone` at `strings.ts:114-117` and their zh-TW, which say "A
  viewer only watches": now a Viewer also gives feedback on sticky notes),
  `apps/web/src/features/console/console.test.tsx` and `console.zh-TW.test.tsx` (the demote sentences),
  `apps/web/src/lib/capabilities.test.tsx` if it lists capabilities.
- E2E: `tests/e2e/test/n.sticky-notes.test.ts` (new, after `t.topic-flow.test.ts`).
- Docs: ARCHITECTURE §5.12 (the six rows); `docs/GLOSSARY.md` (feedback and its zh-TW word, Accept / 採用 and Reject /
  不採用 for feedback, noting they are the suggestion's words).

**Does.**
- `sticky.feedback.create` `{ note, text }`: the note must be in the index, else `not_found`
  (`sticky.note.missing`); `text` cleaned with `agentText` (`cleaned` recorded), at most `FEEDBACK_TEXT_MAX_CHARS`;
  author `{ kind: 'member', user }`. Bounds of D4.5: a withdrawn entry is removed at once (the audit keeps it); at a
  bound the oldest rejected entries go first, then the oldest accepted; waiting ones are never dropped: a create is
  refused (`conflict`, reason `feedback-full`, `sticky.feedback.full`); at most 20 waiting per member, 300 from
  members together (the outside budgets are S8's). Audit `sticky.feedback.create` with the full text as suggestions
  do.
- `sticky.feedback.withdraw` `{ feedbackId }`: the author, while waiting; removed; audited. `sticky.feedback.reject`
  `{ feedbackId, reason? }`: status `rejected`, `decidedBy`, `decidedAt`, `rejectReason`; audited; nothing sent.
- `sticky.feedback.accept` `{ feedbackId }`: the caller holds `session.drive` (the registry), the entry is waiting,
  a second accept of the same id while one is under way is refused (an in-flight set), the notes session exists and
  has not ended (else `conflict`, reason `no-assistant`, `sticky.feedback.noAssistant`). Then ONE
  `ctx.services.conversation.send({ sessionId, text: composeFeedback(...), origin: 'composer' }, principal)` as the
  accepting member; the status becomes `accepted` only after the send succeeded; audited. `composeFeedback` writes
  the fixed English sentence: it names the note's path as a JSON string and the author (a member by `agentSafeName`
  and `AGENT_ROLE_NAMES`; an outsider as "a person outside the workspace" with `outsideSafeName`, whose fallback is
  "a Slack user" / "a Discord user", never "member"), then `quoteForAgent('feedback', text)`. The role prompt gains
  one sentence: accepted feedback arrives as a member's message that quotes it; work it into the note it names
  (change it, or write a new note and link it).
- `sticky.feedback.list` `{ after? }` → `{ feedback, hasMore }`. `sticky.feedback.updated` `{ feedback }` or `{
  removed: id }` to every member.

**Tests.**
- New: `test/sticky/accept.test.ts` (the message an accept sends, word for word, for a member and for an outside
  author written straight into the store; nothing reaches the agent from create, reject, withdraw, a full document
  or a refused accept: `FakeClaude` or the fake runtime records no message; a second accept at once sends once;
  `no-assistant`; the status only after the send; a pin like `test/suggest/suggestions.test.ts:376`: exactly one
  call of `conversation.send` in `src/sticky/`, inside accept, after the capability and status checks);
  `test/sticky/feedback.test.ts` (the budgets one by one, eviction order, the stored-characters bound, a kicked
  author's waiting feedback withdrawn with a system audit entry, a note not in the index refused, paging at the
  worst case); `packages/protocol/src/agent-text.test.ts` (`composeFeedback` and `outsideSafeName` with hostile
  names and texts, a fence inside the text, the fallbacks); `tests/e2e/test/n.sticky-notes.test.ts` (over the real
  relay: a Viewer's and an Editor's feedback, accepted by a member with Agent access; `told(claude, sessionId)` is
  exactly the accept's message, and `everythingAgentsReceived` held no feedback text before it).
- Pins that change: `roles.test.ts` `ARCH_3` and "capabilitiesOf lists the row" (every role gains `feedback.give`
  at its place in CAPABILITIES; SPEC §8's transcription stays as written); `registry.test.ts` (owner-checked set,
  rate pin, size rules, handler checks: a new check is used by its type) and the daemon's copy of the rate pin,
  `test/rates.test.ts` › "names a bucket for exactly these requests"; `invites-audit-settings.test.tsx:176-182` and
  `console.zh-TW.test.tsx:189-194` need a distinct label per audit action (they pass once `audit-labels.ts` has the
  four); `console.test.tsx:145,187,201,211` and `console.zh-TW.test.tsx:88`: the demote dialog's sentence no longer
  says a Viewer only watches (D4.1, D4.2); `pin.test.ts` hashes of `roles.ts`, `schema/entities.ts`,
  `agent-text.ts`, `schema/registry.ts`, `schema/messages/sticky.ts` and `sticky/store.ts` if it changed, and
  `shapes/audit.line.txt`, with the answer "the audit's action enum widens; no step, as 0.6.0 and 0.7.0 widened it",
  command as in the Rules.
- Moved here because a test demands it: the console's audit labels (the two console suites above). ARCHITECTURE §2,
  §3's row and §11 D-31 stay in S9 as the cut says (no test reads them); `ARCH_3` in `roles.test.ts`, which
  transcribes §3, changes here with the code, and S9 writes the row it transcribes.

**Gate.** `pnpm --filter @smurg/protocol exec vitest run src test`; `pnpm --filter @smurg/daemon exec vitest run
test/sticky test/suggest test/authorization.test.ts test/rates.test.ts test/upgrade test/wire-texts.test.ts
test/wire-texts.zh-TW.test.ts test/teardown.test.ts`; `pnpm --filter @smurg/web exec vitest run src/features/console
src/lib/capabilities.test.tsx`; `pnpm --filter @smurg/e2e exec vitest run test/n.sticky-notes.test.ts`; then P1 to
P4.

**Commit.** "every member, a Viewer too, can give feedback on a sticky note; it reaches no agent until a member with
agent access accepts it exactly as shown, and then goes once to Claude for the sticky notes as that member's message
that quotes it; rejecting or withdrawing sends nothing; a member who is removed takes their waiting feedback with
them". Body: the pin's answer.

## S6. Feedback in the notes view (D7.8)

**Design.** D7.8 (the box, the list, Accept and Reject, Withdraw, the waiting counts, "What Claude gets" before the
click, "Start Claude" from an accept with no assistant), D7.3 (for a member with `session.drive`, the feedback and
its event load with the channel), D7.4's group "Feedback on sticky notes that are gone", D7.6's "that name's
feedback".

**Owns.** `apps/web/src/lib/stores/sticky.ts` (feedback by id, `sticky.feedback.list` through `collectPages`,
`sticky.feedback.updated`; `selectFeedbackOf(note)`, `selectWaitingCount`; the unsent box text in a page-lifetime
map); `apps/web/src/features/sticky/{Feedback.tsx (Accept, Reject, "What Claude gets"), FeedbackBox.tsx,
NoteTree.tsx (counts in each row's label; the group of gone notes), NoPage.tsx, strings.ts, strings.zh-TW.ts,
sticky.css, sticky.test.tsx, sticky.zh-TW.test.tsx}`; `apps/web/src/app/workspace/TopBar.tsx` (the waiting count
on the mode link, for `session.drive` only) and `src/strings/workbench.ts` + `.zh-TW.ts`;
`apps/web/src/lib/stores/index.ts` (the feedback and its event loaded with the channel for `session.drive`, D7.3),
`apps/web/src/testing/stores.ts` (`EMPTY_LOADS` + `sticky.feedback.list`) and
`apps/web/src/lib/stores/stores.test.ts` (the initial loads); `apps/web/e2e/smoke/notes.smoke.test.ts` (one more
case); `docs/GLOSSARY.md` (Give feedback, Withdraw, "Show N earlier", "What Claude gets", each if new).

**Does.** Under the note, for everyone: "Give feedback" with the one-line hint that everyone sees it and that it
reaches Claude only when a member with agent access accepts it; their own waiting feedback with "Withdraw". The
list: waiting first; each entry with its author (a member's name; for an outside author the name and "Slack" or
"Discord", never an avatar), the time, the text as plain text (`PlainText`, never Markdown or a link); settled
entries folded behind "Show N earlier". "Accept" and "Reject" (with an optional reason) and every waiting count only
for `session.drive`. Before the click, Accept can show "What Claude gets" (folded until asked for): the exact
message `composeFeedback` of `packages/protocol` makes for this entry, as plain text (`PlainText`, never rendered;
D7.8). The web calls the same pure function as the daemon's accept, with the same inputs (the note, the author and a
member author's role as the members store holds it, the text), so that for the same inputs it shows what the accept
sends. Accept with no assistant (`no-assistant`) offers "Start Claude". A missing name's page lists that name's
feedback; the tree's group "Feedback on sticky notes that are gone" lists names with waiting feedback the index does
not hold, for members who can review.

For a member who holds `session.drive`, `sticky.feedback.list` and its event `sticky.feedback.updated` load with
the channel (D7.3), so that the waiting count on the mode link is right in every view, also before the notes view
was first shown in this page. For the other members the feedback loads when the notes view is first shown, with the
notes index (`sticky.list`, `sticky.changed`), which loads then for everyone (D7.3).

**Tests.** Per role what shows (Viewer: box and own Withdraw, no Accept, no counts; Editor: the same; Agent access
and host: Accept, Reject, counts, "What Claude gets"); the text never rendered as Markdown; "What Claude gets" is
`composeFeedback` of the entry character for character, as plain text, for a member and for an outside author with
a hostile name; the count on the mode link right in the sessions view before the notes view was shown; a renamed
note's waiting feedback can still be accepted from the gone group; the zh-TW suite; the smoke: a Viewer page gives
feedback, the host page accepts it, the stand-in's turn changes the note and both pages show the change. Pins that
change: `EMPTY_LOADS` in `src/testing/stores.ts` and the initial loads of `src/lib/stores/stores.test.ts` (a member
with `session.drive` now loads the feedback when the channel opens, D7.3), re-taken with `pnpm --filter @smurg/web
exec vitest run src/lib/stores`.

**Gate.** `pnpm --filter @smurg/web exec vitest run src/features/sticky src/app src/lib/stores`; `pnpm exec vitest
run --project @smurg/web-smoke notes`; then P1 to P4.

**Commit.** "feedback under each sticky note: everyone writes it, the author can withdraw it while it waits, a
member with agent access can read the exact message Claude would get and accepts or rejects it, and the view, the
tree and the mode link say how much waits to those who can decide".

## S7. Build this (D5)

**Design.** D5.1 (`sticky.spec`), D5.2 (`sticky.build`: checks first, the free slug, the topic, SPEC.md and PLAN.md
as the caller, the record, the audit; it starts nothing), D5.3 (the dialog shows plain text and says that Start
comes next; the page opens the topic's plan), D5.4 (a failed step leaves the topic and names the step), D5.5 (the
discussion kept), D2.4's `builds`, D4.8's `sticky.build`.

**Owns.**
- Protocol: `src/schema/limits.ts` (`SPEC_FROM_NOTES_MAX_BYTES = 256 KiB`), `src/schema/messages/sticky.ts` and
  `registry.ts` (`sticky.spec` [session.create] `{ note }` → `{ text, hash, notes }`; `sticky.build`
  [session.create] `{ note, hash }` → `{ topicId }`), `src/schema/entities.ts` (`AUDIT_ACTIONS` + `sticky.build`),
  `registry.test.ts` (ARCH_CATALOG; `sticky.spec`'s result sensitive, as `file.read`'s), samples, worst cases,
  `protocol7.test.ts`, `src/i18n/messages/sticky.ts` (`sticky.build.noteChanged`, `sticky.build.slugUnavailable`,
  `sticky.build.failedAt`).
- Daemon: `src/sticky/{build.ts (new), service.ts (`builds` in NoteInfo, the newest 8), store.ts (the records, at
  most 200)}`, `test/sticky/build.test.ts` (new), `test/fixtures/request-samples.ts`, `test/authorization.test.ts`
  (`REAL_ANSWERS['sticky.spec']`, `['sticky.build']`: a note that does not exist answers `not_found`, so the table
  makes no topic), `test/upgrade/pin.test.ts` (hashes of `schema/entities.ts`, `schema/limits.ts`,
  `schema/registry.ts`, `schema/messages/sticky.ts`, `sticky/store.ts`; `shapes/audit.line.txt`; answer: the
  audit's enum widens and no other stored shape changes, `sticky.json`'s shape was declared whole in S2).
- Web: `apps/web/src/features/sticky/{BuildDialog.tsx (new), NoteRead.tsx (the button, the note's builds as links to
  their topics), strings.ts, strings.zh-TW.ts, sticky.test.tsx, sticky.zh-TW.test.tsx}`,
  `apps/web/src/features/console/{audit-labels.ts, strings.ts, strings.zh-TW.ts}` (`sticky.build`),
  `apps/web/e2e/smoke/notes.smoke.test.ts` (Build this up to the Start dialog). Docs: ARCHITECTURE §5.12 (two rows).

**Does.**
- `sticky.spec`: reads as the caller (decoded as `doc.open` decodes: LF, no BOM) the note and each note it links to
  directly (at most `NOTE_LINKS_MAX`, each at most `NOTE_MAX_BYTES`, together at most `SPEC_FROM_NOTES_MAX_BYTES`;
  an oversized or unreadable one refused with its name); composes: "Built from the sticky note "notes/<name>.md"."
  (the path as a JSON string), the note's text, then each linked note under a fixed heading with its path as a JSON
  string, then the fixed last line that other sticky notes are not part of this spec; `hash` = SHA-256 of the UTF-8
  of `text`.
- `sticky.build`: composes again; another hash is refused (`conflict`, reason `note-changed`; the page shows the new
  text). Before anything is made: the topic limit; the agent-session limit (`topics.create` starts the discussion);
  a free slug chosen by the daemon (from `slugFromName(name, taken)` where `taken` holds the stored slugs and every
  `specs/*` folder; never one whose folder exists; `-2`, `-3` … up to 9, then `slug-unavailable`); that the one-item
  `PLAN.md` it will write parses (`parsePlan` of `src/topics/plan-format.ts`). Then, as the caller: `topics.create({
  name, slug })`; the record `{ note, topicId, by, at, hash }` as soon as the topic exists; `specs/<slug>/SPEC.md`
  (the composed text) and `PLAN.md` (item id `build`, title the note's name) through the file service; audit
  `sticky.build`. It starts nothing. A step that fails after the topic exists leaves the topic and its record; the
  error names the step.
- The dialog shows `text` as plain, visible text (never rendered), with the invisible-character warning the Start
  dialog gives (computed from `agentText`), and says that the next step is Start in the topic's plan. On confirm:
  `sticky.build`, then the `openColumn` command on `{ kind: 'plan', topicId }` (the sessions view opens; the member
  presses Start in the existing Start dialog, whose checks and pins apply unchanged). "Build this" only for
  `session.create`, and held while the note is agent-locked or has an unsaved change.

**Tests.** `test/sticky/build.test.ts`: the composed text word for word (a CRLF note, a BOM note, a linked note
missing, the 256 KiB bound); hash mismatch; a second build of the same note gets `-2`; a CJK name; a slug whose
`specs/` folder exists after a delete; the topic limit; an Editor refused; a step failing after the topic exists;
the record and `builds`; the discussion started by `topics.create` kept; nothing started (no work item session, no
`plan.start`). The smoke: Build this, the dialog's text, confirm, the plan column with Start. Pins:
`registry.test.ts` (the sensitive results list + `sticky.spec`: it carries the notes' text); the console label
suites (a new audit action); `pin.test.ts` (the five hashes the Owns names and `shapes/audit.line.txt`, answer "the
audit's enum widens; no step").

**Gate.** `pnpm --filter @smurg/protocol exec vitest run src`; `pnpm --filter @smurg/daemon exec vitest run
test/sticky test/topics test/authorization.test.ts test/upgrade test/wire-texts.test.ts`; `pnpm --filter @smurg/web
exec vitest run src/features/sticky src/features/console`; `pnpm exec vitest run --project @smurg/web-smoke notes`;
then P1 to P4.

**Commit.** "a sticky note can be built (Build this): the member reads the exact text of the note and the notes it
links to, smurg makes a topic whose spec is that text and whose plan is one work item, starts nothing, and opens the
plan, where the topic's own Start dialog confirms and starts it". Body: the pin's answer.

## S8. Slack and Discord (D6)

**Design.** D6.1 (outbound HTTPS only, the fixed hosts replaceable only through `DaemonOptions`), D6.2 (the secret
file, `smurg connect` / `smurg disconnect`, the masks, the guide's sentence, the channel id checked again when the
daemon reads the file, HOSTING §11 and the site's page bound), D6.3 (first read sets the cursor, the cleaning, the
note a message names, the outside budgets), D6.4 (the state in `sticky.list` and `sticky.changed`), D4.5's outside
budgets (200 together, 20 per outside person).

**Owns.**
- Daemon: `src/sticky/sources/{slack.ts, discord.ts, poll.ts (the channel id of each entry checked by pattern
  before anything is fetched)}` (new; `fetch` with `redirect: 'error'`, `AbortSignal.timeout`, a cap on the bytes
  read, 60 s per source), `src/sticky/{feedback.ts (the outside intake and budgets), service.ts (`sources`), store.ts
  (cursors per source and channel), module.ts}`, `src/daemon.ts` (`DaemonOptions`: the connectors entry callback and
  the two base URLs), `test/sticky/sources.test.ts` (new, with fake Slack and Discord servers on 127.0.0.1 written
  after `test/hooks/mock-anthropic.ts`), `test/text-cost.test.ts` (any expression over a message's text, and the
  two channel-id patterns), `test/upgrade/pin.test.ts` (the hash of `sticky/store.ts`, and of any protocol module it
  changed; answer: no stored shape changes) and `test/upgrade/shapes/sticky.json.txt` unchanged.
- Protocol: `src/mask.test.ts` (one case: a Slack bot token `xoxb-…` is masked by the existing rule at `mask.ts:63`;
  no rule for Discord, whose tokens have no literal prefix, D6.2), `src/i18n/messages/sticky.ts` (the source states'
  codes, one of them for a channel id that fails its pattern), `src/i18n/catalog.test.ts` (`ENUM_PARAMS` if a
  parameter is an enumeration).
- CLI: `src/cli/run.ts` (`connect`, `disconnect`), `src/commands/connect.ts` (new: `smurg connect slack|discord
  [folder] --channel <id>`, the channel id checked by pattern, the token read with `io.readSecret`; `smurg
  disconnect slack|discord [folder]`), `src/state/connectors.ts` (new: `~/.smurg/connectors.json`, mode 0600, the
  private-file helpers of `src/state/private-file.ts`), `src/state/paths.ts`, `src/commands/host.ts` (hands the
  workspace's entry to the daemon in the same process and reads the file again every few seconds),
  `src/commands/uninstall.ts` (`STATE_ENTRIES` + `connectors.json`), `src/i18n/{en.ts, zh-TW.ts}`; tests
  `test/connect.test.ts` (new, with `testIo()` and `SMURG_LANG`), `test/main.test.ts:108` (`connect`, `disconnect`
  in `--help`), `test/uninstall.test.ts`, `test/guide-anchors.test.ts` (the help's link to the host guide's §11),
  `test/text-cost.test.ts` (`EXPRESSIONS` + `commands/connect.ts`, and `state/connectors.ts` if it holds one: each
  anchored, bounded and run on a short argument), `test/args-state.test.ts` (the state paths + `connectors:
  '/tmp/x/connectors.json'`).
- Upgrade record: `packages/daemon/test/upgrade/persisted.ts` (a kind `connectors.json (the command: outside
  sources)`, homes `['host']`, `since: NOT_PUBLISHED`, a described schema like `credentials.json`).
- Web: `apps/web/src/features/sticky/{Sources.tsx (new: one line per connected source for the host: reading, waiting
  for room, failing with its reason), strings.ts, strings.zh-TW.ts, sticky.test.tsx}`.
- Docs: `docs/HOSTING.md` and `docs/zh-TW/HOSTING.md` a new last section `## 11. Slack and Discord` appended (D6.2;
  never renumbering: connect and disconnect, the token stays on this computer, the two fixed hosts, once a minute,
  the first read starts from now, what is stored where, the budgets, the smallest scopes of each bot, that agent
  sessions run as the host and can read `connectors.json` as they can read the relay login, that a channel id that
  fails its pattern shows as failing and is never read), with identical `sh` blocks in both languages
  (`apps/site/test/docs-parity.test.ts:130-136`); `apps/site/test/site.test.ts:177-179` (the page bound raised by
  what §11 adds, measured on the built page, with its sentence in the comment above it); ARCHITECTURE §7.1 (the
  state folder lists `connectors.json`).

**Does.** As D6 says. Each entry `smurg host` hands to the daemon (at start and at every read of `connectors.json`)
has its channel id checked by the same pattern as `smurg connect` (Slack `^[CG][A-Z0-9]{8,}$`, Discord
`^[0-9]{17,20}$`) before anything else: a source whose id fails is `failing` with its own code and is never fetched
(D6.2), so that a file edited by hand or by an agent cannot put another path into a URL that carries the token. The
first read of a channel only sets its cursor to the newest message; another channel, or a missing cursor, starts
from now. Each later message of a person (not a bot, not empty) becomes feedback through the feedback service,
author `{ kind: 'outside', source, name, externalId }`: the text through `agentText` (Slack's `&amp; &lt; &gt;`
decoded first), cut at `FEEDBACK_TEXT_MAX_CHARS` on a code-point boundary and marked cut; the name cleaned (nothing
unseen, white space collapsed, at most 256 characters, fallback "Slack user" / "Discord user"); the outside id
checked by pattern; the note is the first `[[Name]]` that names an indexed note, else Home; with no Home the message
is dropped and counted. Audited by the system with the source and the outside id. When an outside budget is full
the source stops reading (`waiting-for-room`) until there is room. A token is never on the wire, in `state.json`, in
the audit log, in a log line or in the environment. No control-socket operation. Nothing is fetched while no
channel is connected.

**Tests.** `test/sticky/sources.test.ts` (fake servers: history, bots and empty messages skipped, too long cut, the
first read imports nothing, a cursor survives a restart, a 429 with Retry-After honoured, a bad token's code, a
redirect refused, a body over the cap refused, nothing requested while disconnected, a channel id in the entry that
fails its pattern (`C0123/../x`, letters in a Discord id) is `failing` and the fake server gets no request, the
outside budgets, the note by `[[Name]]`, no Home); `test/connect.test.ts` (no echo, the patterns, file mode 0600,
disconnect, both languages); `test/uninstall.test.ts` (a SMURG_HOME with `connectors.json` uninstalls); the token in
no log line and no audit entry. Pins that change: `main.test.ts:108`'s list (two new commands); the CLI's text-cost
counts; the state paths of `test/args-state.test.ts` (+ `connectors: '/tmp/x/connectors.json'`); the daemon's
text-cost counts (the two channel-id patterns); `pin.test.ts`'s hash of `sticky/store.ts` (no stored shape
changes); `site.test.ts`'s bound (the guide grew by §11), re-taken with `pnpm --filter @smurg/site exec vitest run`;
`persisted.ts` gains the kind (no fixture holds it: `since: NOT_PUBLISHED`). Moved here because a test demands it:
HOSTING §11 in both languages (`packages/cli/test/guide-anchors.test.ts` and `apps/site/test/inbound.test.ts` need
every anchor the CLI help names to exist) and the site's page bound (`apps/site/test/site.test.ts:177`).

**Gate.** `pnpm --filter @smurg/daemon exec vitest run test/sticky test/composition.test.ts test/upgrade
test/text-cost.test.ts`; `pnpm --filter @smurg/protocol exec vitest run src/mask.test.ts src/i18n`; `pnpm --filter
@smurg/cli exec vitest run test/connect.test.ts test/main.test.ts test/uninstall.test.ts test/guide-anchors.test.ts
test/text-cost.test.ts test/args-state.test.ts test/i18n.test.ts test/zh-tw.test.ts`; `pnpm --filter @smurg/site
exec vitest run`; `pnpm exec vitest run --project @smurg/lint`; then P1 to P4.

**Commit.** "the host can connect one Slack channel and one Discord channel to a workspace (smurg connect, smurg
disconnect): the host's computer reads their new messages over HTTPS once a minute, the relay never sees them, and
each becomes feedback from a person who is not a member on the sticky note it names, waiting to be accepted like any
other; the token stays in ~/.smurg/connectors.json".

## S9. The documents (D4.1's and D4.2's ARCHITECTURE rows, D8, Security)

**Design.** The prose of every decision for the people who read the guides; Security (its last bullet: `SECURITY.md`,
`docs/SECURITY-MODEL.md` and the host guide follow ARCHITECTURE §2 in this step); D4.1 (ARCHITECTURE §3's row of
`feedback.give` and §11 D-31: every member, a Viewer too, may give feedback on a sticky note, and it reaches an
agent only when a member with agent access accepts it, exactly as shown); D4.2 (§2 rule 5: "a Viewer watches and
gives feedback"; rule 6 case (d) and the stated case of what Claude for the sticky notes reads, as D4.2 words them);
D8 in ARCHITECTURE. `SPEC.md` is not edited.

**Owns.** `docs/JOINING.md` and `docs/zh-TW/JOINING.md` (a new `## 11. Sticky notes` appended: the view, links,
Claude for the sticky notes, feedback, Build this; §2's roles table says what a Viewer may do now);
`docs/HOSTING.md` and `docs/zh-TW/HOSTING.md` (§10's sentence on topics made by Build this; the Security sentences,
which follow ARCHITECTURE §2: §3's "Viewer (`viewer`) can only look" (`HOSTING.md:200`) says that a Viewer looks and
gives feedback, what reaches an agent gains case (d), and a built note's work item merges by itself once one member
with agent access confirmed its spec at Start; the built page measured again: the bound of S8 holds or rises by
what the truth adds, with its sentence); `docs/SECURITY-MODEL.md` and `docs/zh-TW/SECURITY-MODEL.md` (they follow
ARCHITECTURE §2: "What encryption does not protect" says that a Viewer gives feedback on sticky notes, that feedback
reaches Claude only when a member with agent access accepts it, and that a built note's work item merges by itself
once one member with agent access confirmed its spec at Start; within the outline
`tests/lint/docs-parity.test.ts:116-129` pins: a title, five sections without numbers, as many list items in both
languages); `docs/HOW-IT-WORKS.md` and its zh-TW only if their sections stay as that test counts them;
`docs/QUICKSTART.md` and zh-TW only if it stays 8 to 12 steps;
`docs/GLOSSARY.md` (what is not part of 0.8.0: rename and delete from the notes view, `[[Name|label]]`, an inbox
item for feedback); `docs/ARCHITECTURE.md` (the release paragraph after 0.7.0's at `:28-32`, naming
`docs/design/v0.8.0/`; §1 the feature folder and the module; §4.3 "PROTOCOL_VERSION is 7 since 0.8.0", the Welcome's
`protocol` and the size-rule table; §7.1 `sticky.json`; §7.2 the module map; §9 the third view and its route; §0
rule 8's sentence that 0.8.0 has no step; §2, §3 and §11 as Design says); `SECURITY.md` (it follows ARCHITECTURE
§2: "What reaches an agent" gains case (d), feedback that a member with agent access accepted, in exactly the
characters shown, quoted in that member's own message to Claude for the sticky notes; the Roles bullet: a Viewer
giving feedback is the role, not a vulnerability, while a viewer editing or voting still is; S3: a built note's work
item merges by itself once one member with agent access confirmed its spec at Start; what leaves the host's
computer: Slack and Discord when connected; the S-points); `CHANGELOG.md` and
`docs/zh-TW/CHANGELOG.md` (`## [Unreleased]` first, the same subsections and entry counts:
`tests/lint/docs-parity.test.ts:132-168`, `apps/site/test/docs-parity.test.ts:146-160`); `README.md` and
`README.zh-TW.md` (connect and disconnect named inline in the folded command table's text, no new row, so
`tests/lint/readme.test.ts:351` and `apps/site/test/docs-parity.test.ts:241` keep their lists); `apps/web/README.md`
("The two views of a workspace" becomes three, with `data-mode="notes"`); `tests/lint/docs-quotes.test.ts` (QUOTES
for every label the guides quote); `docs/ACCEPTANCE.md` (a family "## K sticky notes (v0.8.0)" or another free
letter, whose `` `file` › "title" `` references resolve: `tests/lint/acceptance-refs.test.ts`);
`CONTRIBUTING.md:49-51` (the designs it names); `docs/design/v0.8.0/README.md` (what the build took where DESIGN
left room, from the HANDOVERs). Not the product page's picture nor the README's picture (`scripts/readme-picture.ts`
measures on macOS only).

**Does.** Every quoted label exactly as the catalogs render it, in both languages. The word lints hold
(`tests/lint/auto-merge-words.test.ts`, `auto-mode-words.test.ts`): Build this promises no result, and nothing says
smurg verifies. The guides say what the design says and nothing it does not: feedback reaches no model until a
member with agent access accepts it; a built note's work item merges by itself on the host's standing consent once
one member with agent access confirmed it at Start; the item's agent can still read other files of the main folder.
`SECURITY.md`, `docs/SECURITY-MODEL.md` and the host guide follow ARCHITECTURE §2 as DESIGN's last Security bullet
says: what reaches an agent gains case (d), a Viewer gives feedback, and a built note's item merges by itself once
one member with agent access confirmed its spec at Start.

**Tests.** No new test; the lints and the site tests are the gate. Pins: `site.test.ts`'s bound only if the guide
grew again, with its sentence.

**Gate.** `pnpm exec vitest run --project @smurg/lint`; `pnpm --filter @smurg/site exec vitest run`; then P1 to P4.

**Commit.** "the guides say what sticky notes are and how a team works in them: one first note that grows by wiki
links, Claude for the sticky notes on the right, feedback that anyone gives and a member with agent access accepts,
Build this, and Slack and Discord read by the host's computer; ARCHITECTURE describes protocol 7 and the sticky
module; the changelogs have the unreleased entries".

## Order and size

S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9. S1, S2, S5 and S8 carry the gate's lists; S3 and S4 split the view so
that neither is too large to review; S5 and S6 split feedback at the wire. The pieces moved by a test, in one place:
note names with G13 in S1 (the gate's tests); `sticky.json`'s HOSTING §9.3 lines in S2 (`guide-update.test.ts`; its
whole stored shape is declared there too, by choice, so that the pin of stored shapes moves once for it); the smoke
helper `toMode` in S3 (every smoke that switches mode); the console's audit labels with each audit action, S5 and S7
(the two console suites); HOSTING §11 and the page bound with the CLI that links them, S8 (`guide-anchors.test.ts`,
`inbound.test.ts`, `site.test.ts`). A step whose gate cannot be green alone is cut again, never committed red. After
S9 the lead runs the reviews, the fixes and the release commit (version 0.8.0 in the eight package.json, the heading
`## [0.8.0]` with its date in both changelogs, `.github/ISSUE_TEMPLATE/bug.yml`, RELEASING §4 step 3 (b) for a
raised protocol and its `protocol v7` line, the release gate with `SMURG_RELEASE_GATE=1`, which needs 0.7.0's
published executables and, once main has paid 0.7.0's debt and this branch is rebased on it, `TAG = 'v0.7.0'` in the
three tests, with `other-version.test.ts` restated over the declared steps as D8.1 says: the upgrades expected from
the tag are the steps above the tag's shapes, none for shapes 4).
