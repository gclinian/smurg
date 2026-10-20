# smurg 0.6.0: design

Branch `v0.6.0-work` (from main 2faa34e = released 0.5.2, protocol 4). Version 0.6.0, protocol 5, workspace shapes 2.
Written 2026-10-20 by the designer from BRIEF.md, DECISIONS.md (binding) and the five understanding reports
(U1 models, U2 permissions, U3 no git, U4 Claude Code facts, U5 what must be kept); **revised the same day after two
reviews** (R-SEC: security and honesty, 6 must-fix; R-ENG: engineering, upgrade and tests, 2 must-fix). Every
finding is answered in `D/ANSWERS.md`. This document follows the form of `docs/design/v0.5.0/DESIGN.md`
(numbered decisions, files, behaviour, shapes, words, tests).

## The design in five minutes

**What the users asked, what the owner decided.** Choose the model; let agents run without confirmations (auto mode
by default, and "asks for nothing" for the host who wants it); work without `.git`. The owner's four decisions are in
DECISIONS.md and are not reopened here.

**Permissions.** smurg has four modes of its own: `auto` (the default), `ask-commands`, `ask-all` (the two 0.5.2
modes), and `ask-nothing` (the host's, for the whole workspace, behind a warning). The daemon maps them to Claude
Code's `auto`, `acceptEdits`/`default` and `bypassPermissions`. A topic and a session may choose a stricter or looser
mode among the first three, or follow. Existing 0.5.x workspaces switch to auto at the update (the owner's decision);
`smurg host`, the inbox and the console say so and say how to go back.

**What auto lets through, and what smurg adds.** In auto, Claude Code runs file edits and simple file commands inside
the agent's own folder without any check (its fast path), and sends every other command to its classifier, a
model's judgement. What smurg adds:
- **Deny rules that reach beyond the agent's folder**, in every mode, `ask-nothing` included (D8a). They cover the
  main folder's `.git`, `.claude`, `.mcp.json` and smurg's hidden history, the host's `~/.claude`, `~/.claude.json`
  and `~/.ssh`, smurg's state folder, and smurg's own executable (the gate's hook). They refuse an edit tool, and a
  command that names one of those places. Nothing stops a command that reaches them another way.
- **Gate rows that still ask in auto**: G11 in the main workspace (a teammate's session writing a file only the host
  may change asks the host; writing a file someone is typing in is refused), and G12 for every teammate's session (a
  shell write outside its own folder, the temporary folders excepted, asks the host). Both act only on what smurg can
  read in the command.
- **The merge review** for work items in worktrees.
The guides list what auto does not check, in both languages.

**Asks for nothing** launches only when four checks pass: the session's mode, the workspace setting read again, the
daemon is not running as root, and the settings file's own check. It never uses `--allow-dangerously-skip-permissions`,
so loosening a session into it waits for a fresh start, while tightening applies at once. While it is on, every
member sees a badge and `smurg host` prints a line at every start.

**Detect what really runs.** Claude Code may silently run another mode than the one asked for: Haiku has no auto mode,
`disableAutoMode` turns auto off, and the bypass guard. smurg reads the mode and the model from every `init` and
`status`, sets its own fallback, shows the real ones on the session strip, and tells the host.

**Models.** Any model on the host's Claude Code list (`initialize`, read once by a probe without hooks), chosen at the
start of a session or a topic, at Start, and live (`set_model`). Null means the host's default. A refused or
substituted model is said in the conversation. Where a model may bill usage credits, the dialog says so and the host
guide does too. The audit names the model.

**No git.** Without `.git`, smurg keeps its own history in `<share>/.smurg/git` (never a `.git` in the folder) and
topics work as with a repository: a worktree per item, a diff, merge or reject. The hidden repository is created
crash-safely, protected by deny rules and an integrity check, and merges against the base recorded at review. Its
excludes are generated from the host-private lists, and the clones get them too. There is a size bound, a disk check
and repacking. Nested repositories and cloud-synced folders are named in the Start dialog.
Without the git **program**, only the host can start work items, and they run one at a time directly in the folder.
One agent at a time holds the folder, later turns included. There is no diff and no undo, and the Start dialog makes
the host tick that they understand this.

**Upgrade and protocol.** Protocol 5, exact (a 0.5.x peer gets the existing cut-off words; a local `smurg attach`
across versions too). Workspace shapes 2: steps for `state.json` and `agent-sessions.json` from 0.5.0–0.5.2; the
0.5.1 and 0.5.2 fixtures are made first (S0). The published 0.4.0–0.5.2 executables are tested both ways: each
one's folder is upgraded by 0.6.0, and each one then refuses the folder 0.6.0 wrote without changing its state.

**Changed after the reviews.** The deny rules beyond the folder and G12 are new. The "Asks for nothing" warning and
every "checks each command" sentence now say what is true. Direct mode is the host's and holds the folder for every
turn. A retried item never switches history. The hidden repository's integrity, base and excludes are stronger. Big
folders, nested repositories and cloud-synced folders are handled with words. The upgrade test harness, the test
lists and the step ownership are corrected, and S1 really changes no behaviour.

**Left for the lead or the owner**: listed at the end of this document (§5).

How to read the rest: §1 is the decision table. §2 holds the decisions D1 to D22, each with its files, behaviour,
stored and wire shapes, words (catalog ids, both languages, house style of `docs/GLOSSARY.md`) and tests. §3 is the
security review, §4 the risks, §5 what is left for the lead or the owner. Appendix A is the wire diff, Appendix B
every catalog text, Appendix C the evidence each decision rests on. BUILD-PLAN.md cuts this into steps.

Facts about Claude Code are those of the installed and verified 2.1.288, measured against the fake API with an
isolated HOME (U1, U2, U4, R-SEC). Where a behaviour was NOT measured, the decision says so and names the test that
settles it.

---

## 1. The design in one page

The owner's four decisions (DECISIONS.md, not re-opened): O1 auto mode is the default, the host alone may switch a
workspace to "asks for nothing", the ask modes stay; O2 existing workspaces switch to auto at the update, told to
the host; O3 no git: smurg's own hidden history in `<share>/.smurg/git`, and without the git program items run
directly in the folder, never silently; O4 any model Claude Code offers, chosen by the host and members with Agent
access, at start and live, null = the host's default.

| # | Decision | Where |
|---|---|---|
| D1 | Pay the fixture debt first: fixtures of 0.5.1 and 0.5.2 from their tags (with the stamp and a kept copy as persisted kinds), `TAG` = v0.5.2 in the two upgrade tests | daemon tests |
| D2 | Protocol 5: exact version, the existing cut-off words on both sides (a local `smurg attach` across versions included), the published executables run against an upgraded folder | protocol, cli tests |
| D3 | Permission modes are smurg's own four values: `auto`, `ask-commands`, `ask-all`, `ask-nothing`; a topic and a session choose among the first three or follow (null) | protocol, everywhere |
| D4 | The model is an opaque id from the agent's own list; null = the host's default; the list, the host's default model and what can run are host state every page receives | protocol |
| D5 | No-git state on the wire: `HostState.work.history` = `folder` / `smurg` / `direct` / `unchecked`; the Start dialog's `history`; the report's `no-history` | protocol |
| D6 | Stored state: WORKSPACE_SHAPES 2, frozen v0.5.0 shapes, steps for `state.json` (version 2: `permissionMode: 'auto'`, `hostNotices`) and `agent-sessions.json` (mode choice and model); every other change is an optional key | daemon |
| D7 | Models in the daemon: a probe of Claude Code's `initialize`, `--model` on every start and resume, `set_model` live, the real model from each turn's `init`, a refused or substituted model said in the conversation | daemon |
| D8 | The Claude profile: smurg's mode → Claude Code's mode; `bypassPermissions` only for `ask-nothing`, `disableBypassPermissionsMode` lifted only then; the launch checks; live changes; Claude Code's error codes carried | daemon |
| D8a | Deny rules beyond the session's own folder, every mode: the main folder's config and `.smurg/git`, the host's `~/.claude`, `~/.claude.json`, `~/.ssh`, smurg's state folder, smurg's executable | daemon |
| D9 | Detect what really runs: the mode Claude Code reports at every `init` and status, smurg's own fallback when auto cannot run, `modeInUse` on the wire, the host told | daemon, web |
| D10 | The gate in auto: G10 unchanged, G11 for shell writes in the main workspace (host-only paths ask, a file someone types in is refused), G12 for a teammate's shell writes outside its own folder (asks the host); what auto does not check is said in the guides | daemon |
| D11 | Auto mode's refusals are lines of the conversation; every command that ran without a request is audited, failed ones included, with the mode | daemon |
| D12 | Who may change what; a member's choice goes back only when it was looser than what it would follow | daemon |
| D13 | The update: `smurg host`'s one line, an inbox item and a banner in the console's settings, until the host has seen it; the upgrade line names the version that really wrote the folder; while "Asks for nothing" is on, a line at every start and a badge for every member | cli, daemon, web |
| D14 | smurg's own history (`.smurg/git`) when the folder has no `.git`: lazy and crash-safe, generated excludes (in the clones too), nested repositories named, a size bound, deadlines, a disk check, integrity and a recorded merge base, records that say which repository they belong to | daemon worktree |
| D15 | Without the git program: only the host starts work items; they run one at a time directly in the shared folder (one agent holds the folder, later turns too), confirmed in the Start dialog, reported without a diff, nothing waits for a merge; an item runs directly only when its own Start said so | daemon topics |
| D16 | Role prompts (fixed English) say what may ask, and the direct mode | daemon |
| D17 | The stand-in `claude` and the fake API learn models, `set_model`, auto mode with a classifier, bypass, `get_settings` | testing |
| D18 | The web app: model and mode pickers, the strip, the console, the Start dialog, the plan, the report, the inbox | web |
| D19 | The words: every new or changed sentence in both languages (Appendix B) | catalogs |
| D20 | Docs and site: every sentence that says smurg asks, that topics need git, or that the model is the host's | docs, site |
| D21 | Tests: what proves each decision; which existing tests change on purpose | all |
| D22 | Release: 0.6.0, changelogs, RELEASING (the release order of protocol changes), the verified Claude Code stays 2.1.288 | release |

Agent-neutral rule (lead's frame): the wire and the stored state say `model` and `permissionMode` with smurg's
values; Claude Code's names (`acceptEdits`, `bypassPermissions`, `--model`, `set_model`, `supportsAutoMode`,
`resolvedModel`) appear only in the daemon's Claude profile (`packages/daemon/src/sessions/agent/`), the stand-in
and the tests. `auto` is used as smurg's own word because it is the general name of "the agent decides with a
safety check" (other agents' CLIs use it too); the Claude profile maps it.

---

## 2. Decisions

### D1. The fixture debt is paid before any shape changes

**Why.** U5: `PUBLISHED_VERSIONS` is `['0.4.0', '0.5.0']`; 0.5.1 and 0.5.2 have no fixture (RELEASING §4.5 says each
release adds its own); `TAG` is `v0.5.0` in `test/upgrade/wire.test.ts` and `test/upgrade/other-version.test.ts`.
The fixture of the newest published version is the one whose coverage must match TODAY's schemas exactly, so it
must be made while today's schemas are still 0.5.2's (stored shapes of 0.5.1 = 0.5.2 = 0.5.0: `git diff v0.5.0
v0.5.2 -- packages/daemon/src/frozen packages/daemon/test/upgrade/shapes` is empty, U5).

**Files.** `packages/daemon/test/fixtures/published/0.5.1/`, `.../0.5.2/` (new, each: README.md, files.json,
coverage.json, ledger.json, stopped/, running/); `packages/daemon/test/upgrade/fixture.ts` (`PUBLISHED_VERSIONS =
['0.4.0', '0.5.0', '0.5.1', '0.5.2']`); `opens.test.ts` (`STORIES`, `UPGRADES` for both: a 0.5.1/0.5.2 folder
opens with no step and no kept copy, the stamp is read); `fixtures.test.ts` (`NOT_PUBLISHED_YET` stays `{}`);
`wire.test.ts` and `other-version.test.ts` (`TAG = 'v0.5.2'`; `CHANGED_WITHOUT_A_WIRE_CHANGE` emptied: the
protocol source of main equals v0.5.2's but for `testing/text-cost.ts`, which is not compared; header comments
name 0.5.2; `other-version.test`'s `it.for(['0.4.0', '0.5.0'])` gains `'0.5.1'` and `'0.5.2'`);
`packages/daemon/test/fixtures/published/README.md` (the two new folders listed); `packages/daemon/test/upgrade/
persisted.ts` and `pin.test.ts` (R-ENG: today's harness knows no kind for two files these fixtures hold, and
`fixtures.test.ts:149` expects `ofNoKind` to be empty):
- a kind `written-by.json (the stamp)`, pattern `^workspaces/[^/]+/written-by\.json$`, since `'0.5.1'`, `pin:
  'written-by.json'`, schema today's `workspaceStampSchema`; its optional `pending` is listed in each new
  fixture's `coverage.json` as `not-made` ("only between an upgrade's first and last write: a kill there is
  unfinished.test's case"); `pin.test.ts` drops its special `pinned.set('written-by.json', …)` and the comment that
  "no fixture holds one" (the pinned shape file is the same, so no pin changes);
- a kind `<name>.json.before-upgrade-from-<X.Y.Z>[-n] (a kept copy)`, since `'0.5.1'`, schema: the frozen shape of
  the step of that document whose `from` is `X.Y.Z` (today only the 0.4.0 step of `state.json`, whose shape lives in
  `src/frozen/v0.4.0.ts`); no pin of its own.

**How each is made** (the procedure of the 0.5.0 README, by its own code): `git archive v0.5.1` (then `v0.5.2`)
into a scratch folder under W, its own tools (`scripts/env.sh` of that tree) and `pnpm install --frozen-lockfile
--offline`; one driver test file in that scratch tree (kept in W, not committed, as for 0.5.0; its path and a
summary go into the fixture's README) runs the tree's own `t.topic-flow.test.ts` story and then the steps that give
an instance of every persisted kind; the stand-in `claude` of that tree only; the relay of that tree in a local
workerd with its dev login; scratch HOME, SMURG_HOME, SMURG_CACHE_DIR; `SMURG_NO_UPDATE_CHECK=1`; never a real
`claude`, never the built-in relay, never anyone's `~/.smurg`. Two pictures (`running`, `stopped`), the
placeholder replacement of the 0.5.0 README, the daemon of that tree started on a copy, every file parsed with its
own schema. What 0.5.1/0.5.2 add on disk beyond 0.5.0 must be in it: the stamp `written-by.json` (with its
`smurg` and `shapes: 1`), and, in a second workspace of the same host home, a workspace that 0.4.0 wrote and the tree
then opened (so `state.json.before-upgrade-from-0.4.0` and its stamp are in the fixture). That second workspace is
NOT made by downloading the 0.4.0 executable: the tree's own `copyPublishedFixture('0.4.0', 'stopped')` (its
`test/upgrade/fixture.ts`; the 0.4.0 fixture IS what the published 0.4.0 executable wrote) copies it into the
scratch home, and the tree's daemon opens it. No network is used in S0. A point the story does not reach is listed
in `coverage.json` as `not-made` with what it would take;
"0.5.0's fixture holds an instance and the shape is the same" is an acceptable reason only for a point that needs
more than the story above (a 256 KiB answer, 125 writes in a minute).

**Tests.** `fixtures.test.ts`, `opens.test.ts`, `other-version.test.ts` (four fixtures), `wire.test.ts`,
`pin.test.ts` green with the new versions (pin hashes and shapes unchanged: no schema moved; the stamp's shape is now
reached through its kind). Nothing in `src/` changes in this decision.

### D2. Protocol 5 and what an older peer meets

**Files.** `packages/protocol/src/constants.ts` (`PROTOCOL_VERSION = 5`, its comment: "5 since 0.6.0: permission
modes, models, the host's agent and history state"); `packages/protocol/src/constants.test.ts`;
`packages/daemon/test/version-refused.test.ts` (a protocol-4 hello is answered `version`);
`.github/ISSUE_TEMPLATE/bug.yml` (protocol v5); `docs/RELEASING.md` §4.5 step 2 (`--version` says `protocol v5`).

**Behaviour.** Exact equality stays (codec.ts `decodeClientHello`); no compatibility code. What each side meets is
what 0.5.1 already built (U5):

| peer | meets | words (exist since 0.5.1, unchanged) |
|---|---|---|
| page of 0.6.0, host of 0.5.1/0.5.2 | verdict `version` | page: `rejected.version.hostOlder.*` ("The host's smurg is older than this page"); host: `host.peer.newer` once per run |
| page of 0.6.0, host of 0.5.0 or 0.4.0 | verdict `version` | page: `rejected.version.hostOlder.*`; the host prints nothing (it has no such line) |
| tab of 0.5.x open across the deploy, host of 0.6.0 | verdict `version` | page: `rejected.version.stale.*` ("This tab is from before an update"); host: `host.peer.older` |
| `smurg attach` of 0.6.0, host of 0.5.x | verdict `version` | the CLI's `versionRefused` words |
| `smurg attach` of 0.5.1/0.5.2, host of 0.6.0 | verdict `version` | its own words; host: `host.peer.older` |
| 0.5.1/0.5.2 executable on a folder 0.6.0 wrote | stamp `shapes: 2` > 1 | "Run smurg update. Nothing was changed." (`host.*` newer refusal, en.ts:209-210) |
| 0.5.0 executable on a folder 0.6.0 wrote | `state.json` that its strict schema refuses | 0.5.0's one refusal text, which advises moving the folder away (0.5.0 has no stamp reader and no steps; a published version cannot be fixed). It refuses at `state.json`, AFTER `prepareShare` and the share lock (R-ENG: `git show v0.5.0:packages/daemon/src/daemon.ts:198-206`), so it may touch the share's `.smurg/` and its lock, never the workspace state folder; sea-upgrade.test records exactly what (below). The host guide §9.3 says: do not move it, run `smurg update` |
| 0.4.0 executable on a folder 0.6.0 wrote | `state.json` version 2, which its strict schema refuses | 0.4.0's own refusal words (recorded by the test, not promised here); the same rule: the workspace state folder byte for byte as before |
| local `smurg attach` of 0.5.1/0.5.2, host daemon of 0.6.0 (and 0.6.0's attach, daemon of 0.5.x) | the control socket's attach answer carries the protocol's strict `Welcome` (`local/protocol.ts:130-134`, and `commandCtlResponseSchema` `:246-249`, strict for `welcome`), whose `publicSettings` gains a required `permissionMode` | the command cannot read the answer and ends AT ONCE with 0.5.1's other-version words (B2: "A smurg host of another version is sharing on this computer"), never a 30 s wait |

The relay parses no frame (U5): no relay code changes; it is redeployed with the web build of the release
(D22). **The local control socket changes in exactly one place** (R-ENG): its attach answer embeds the Welcome, so a
local attach across versions ends with the B2 words (row above). Its `status` and `stop` answers do not change
(their command-side schemas ignore unknown keys since 0.5.1): `smurg status` gets no new line in 0.6.0; what it would
say is in the host console (D18). `packages/cli/test/ctl-other-version.test.ts` changes on purpose: its `WELCOME`
sample (":586-610", "a welcome every published version accepts") becomes one sample per protocol (`WELCOME_V4`
without `permissionMode`, `WELCOME_V5` with it), and two cases are added: a 0.6.0 command meeting a protocol-4
attach answer ends at once with the B2 words; and the protocol-5 sample is refused by the strict `welcomeSchema` of
v0.5.2 (read from the v0.5.2 tree that `test/upgrade/other-version.test.ts` already archives, or, if the cli test
cannot reach it, by a frozen copy of that schema in the test with a comment naming its source).

**The published executables against an upgraded folder** (R-ENG; `packages/cli/test/sea-upgrade.test.ts`, opt-in,
the release gate runs it): after the new executable has shared and stopped a folder each old one wrote, every OLD
executable runs `smurg host` once more on it (no relay needed: each refuses before connecting). Expected: 0.5.1 and
0.5.2 print "Run smurg update. Nothing was changed." and exit non-zero; 0.4.0 and 0.5.0 exit non-zero with their own
refusal (their text is recorded in the test, by version); in every case the workspace state folder
(`~/.smurg/workspaces/<id>`) is byte for byte what it was, and what the share's `.smurg` holds afterwards is listed
in the test (what each one's `prepareShare` touches before it refuses: `.smurg/`, the share lock, `.git/info/exclude`).

### D3. Permission modes: smurg's four values

**Wire** (`packages/protocol/src/schema/entities.ts`):

```ts
/** What an agent session may do without asking (smurg's own values; the daemon's agent profile maps them). */
export const PERMISSION_MODES = ['auto', 'ask-commands', 'ask-all', 'ask-nothing'] as const;
export const permissionModeSchema = z.enum(PERMISSION_MODES);
/** What a person may choose for a topic's work items or for a session: never `ask-nothing` (the host's, workspace-wide). */
export const SESSION_MODE_CHOICES = ['auto', 'ask-commands', 'ask-all'] as const;
export const sessionModeChoiceSchema = z.enum(SESSION_MODE_CHOICES);
/** Why the mode that runs differs from the one smurg asked for (D9). */
export const MODE_FALLBACKS = ['model-no-auto', 'auto-off', 'ask-nothing-off'] as const;
```

Meaning, in prose (the host guide §5.2 says the same):

| value | label (`permissionMode.*`) | what it means |
|---|---|---|
| `auto` | "Auto: runs what a check allows" | the agent's own auto mode decides (Claude Code: file edits and simple file commands in the agent's own folder at once, every other command after its check); what it refuses is not run and is shown; smurg's gate still asks or refuses where §7.7 says (G10, G11, G12) |
| `ask-commands` | "Asks before commands" | as 0.5.2: edits run, commands ask |
| `ask-all` | "Asks before edits and commands" | as 0.5.2 |
| `ask-nothing` | "Asks for nothing" | the host's workspace-wide choice: everything runs, no check by the agent's tool or by smurg's ask rows (G10, G11, G12); smurg's deny rows and the deny rules (the session's folder and D8a) still hold, for edit tools and for commands that name those places |

Levels and the effective mode (`packages/protocol/src/tools.ts`, replacing `defaultPermissionMode`):

```ts
/** The mode one session runs with: its own choice, else (a work item) its topic's, else the workspace's. */
export function effectivePermissionMode(input: {
  readonly purpose: AgentPurpose;
  readonly session: SessionModeChoice | null;
  readonly topic: SessionModeChoice | null;      // only read for purpose 'item'
  readonly workspace: PermissionMode;             // HostSettings.permissionMode
}): PermissionMode   // discussion: 'ask-all' (fixed, modeFixed); else session ?? (item ? topic : null) ?? workspace

/** Strict to loose: ask-all < ask-commands < auto < ask-nothing. */
export function isLooserMode(a: PermissionMode, than: PermissionMode): boolean
```

A free session in the main workspace no longer starts stricter than one in a worktree: the workspace's mode applies
everywhere (the owner: auto everywhere, main workspace included; D10 says what smurg adds there).

**Workspace mode** is a host setting, in `publicSettingsSchema` (every member learns it in the Welcome and in
`channel.settingsUpdated`, so dialogs can say "Workspace default (Auto: runs what a check allows)"):

```ts
publicSettingsSchema = z.strictObject({ ...as today, permissionMode: permissionModeSchema });
```

`admin.settings.set { permissionMode }` is the only way to `ask-nothing`, host only (capability `admin`), refused
while the daemon's uid is 0 (`settings.asksNothing.root`, D8). New workspaces get `auto`. (`admin/settings.ts`
`publicSettingsOf` copies the key; the web's `settings-form.ts` gains the field.)

**Session** (`agentSessionSchema`, protocol 5):

```ts
permissionMode: permissionModeSchema,                  // the effective mode (what smurg asks the agent to run with)
modeChoice: sessionModeChoiceSchema.nullable(),        // the session's own choice; null: it follows (topic, workspace)
modeInUse: permissionModeSchema.optional(),            // what the agent reported for its running process (D9)
modeFallback: z.enum(MODE_FALLBACKS).optional(),       // with modeInUse ≠ permissionMode: why
modeFixed: z.boolean(),                                // unchanged: a discussion
```

Refines: `modeFixed ⇒ modeChoice === null && permissionMode === 'ask-all'`; `modeFallback ⇒ modeInUse !== undefined`.

**Topic** (`topicSchema`): `agent: z.strictObject({ model: modelIdSchema.nullable(), permissionMode:
sessionModeChoiceSchema.nullable() })` — the model of the topic's new sessions and the mode its work items
follow (null: the workspace's).

**Messages** (Appendix A has every shape):
- `session.create` (agent): `permissionMode?: SessionModeChoice` (absent: follow).
- `session.mode.set { sessionId, mode: SessionModeChoice | null }` (null: follow again). Unchanged capability
  `session.drive`, checks `agent-session`, `mode-not-fixed`.
- `topic.agent.set { topicId, model?: ModelId | null, permissionMode?: SessionModeChoice | null }` (new; at least one
  key; `session.drive`; checks `topic-open`; result `{ topic }`).
- `plan.start` gains `agent?: { model?: ModelId | null, permissionMode?: SessionModeChoice | null }`: checked
  (`model-offered`) with the other checks, and applied to the topic in the SAME `core.update` that arms the items,
  after the checkpoint commit succeeded (R-ENG: `plan-service.ts start()` runs blockers, then `checkpointCommit`,
  which can throw, then one `core.update`). A Start refused anywhere, the checkpoint included, leaves the topic's
  agent settings as they were (test: a Start refused at the checkpoint, git busy, changes neither).

**Glossary** (D19): "permission mode" stays; the four labels replace "The two permission modes"; new rows
"Workspace default", "This topic's setting".

### D4. Models on the wire

**Primitives** (`packages/protocol/src/schema/primitives.ts`, limits in `limits.ts`):

```ts
export const MODEL_ID_MAX_CHARS = 256;
/** An opaque model id as the agent lists it: an alias (`sonnet`, `sonnet[1m]`), a full id, a cloud ARN or `name@version`. */
export const modelIdSchema = z.string().min(1).max(MODEL_ID_MAX_CHARS).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]*$/, 'not a model id');
export const AGENT_MODELS_MAX = 32;
export const MODEL_DESCRIPTION_MAX_CHARS = 512;
```

**The list** (`entities.ts`):

```ts
/** One model the host's agent offers (Claude Code: an entry of `initialize.models` other than `default`). */
export const agentModelSchema = z.strictObject({
  value: modelIdSchema,                                   // what is passed to the agent (`--model`)
  name: shortTextSchema.pipe(z.string().min(1)),           // the agent's display name ("Opus")
  description: lineTextSchema(MODEL_DESCRIPTION_MAX_CHARS),// the agent's line, prices included, or ''
  resolved: modelIdSchema.optional(),                      // the id it runs as (`claude-opus-5-5`)
  auto: z.boolean(),                                       // auto mode can run with it
  billing: z.enum(['usage-credits']).optional(),           // the agent may bill it to usage credits without asking
});
```

`billing` is set by the daemon's Claude profile (D7) whenever the entry may be a Fable model by ANY of its names
(R-SEC: a host-configured full id or ARN has no `claude-fable` prefix): `/fable/i` in `value`, `resolved` or
`name`. A false "may bill" only adds a line under the picker; a missed one hides a cost.

`HostState` (sent by `session.host.get` and broadcast as `session.host`, to every member) gains `agent`:

```ts
export const agentHostStateSchema = z.strictObject({
  models: z.array(agentModelSchema).max(AGENT_MODELS_MAX),
  /** false: the host's agent was not asked yet, or could not be (then `models` is empty). */
  modelsKnown: z.boolean(),
  /** The model the host's own settings choose when a session names none (resolved id); null: not known. */
  hostDefault: modelIdSchema.nullable(),
  /** `off`: the agent refused auto mode for a model that supports it (the host's or the organization's settings). */
  autoMode: z.enum(['ok', 'off']),
  /** `off`: the agent refused to run without asking (its settings); `root`: smurg runs as the root user. */
  asksNothing: z.enum(['ok', 'off', 'root']),
});
```

**Session** (`agentSessionSchema`): `model: modelIdSchema.nullable()` (what was chosen; null: the host's default)
and `modelInUse: modelIdSchema.optional()` (the id the agent reported for its latest turn).

**Messages**: `session.create` (agent) `model?: ModelId` (absent: the host's default); `topic.create` `model?:
ModelId` (the discussion's and the topic's); `session.model.set { sessionId, model: ModelId | null }` (new,
`session.drive`, checks `agent-session`, `session-open`, new check `model-offered`; result `{ session }`; also for a
discussion); `topic.agent.set` and `plan.start.agent` as in D3.

`model-offered` (a new `HANDLER_CHECKS` entry): a non-null model must be the `value` of an entry of the current
list; while the list is not known the request is refused (`session.model.notKnown`); a value not in the list is
refused (`session.model.notOffered`). No host allowlist (O4).

### D5. The no-git state on the wire

```ts
export const WORK_HISTORIES = ['folder', 'smurg', 'direct', 'unchecked'] as const;
/** How work items run here (HostState.work, live). */
export const workStateSchema = z.strictObject({
  /** folder: the shared folder's own git repository; smurg: smurg's own history in .smurg/git (the folder has no
   * .git); direct: the git program cannot be used, items run in the folder itself; unchecked: no .git, and git was
   * not looked for yet (the first Start dialog or the host's worktree request looks). */
  history: z.enum(WORK_HISTORIES),
  /** With `direct`: why git cannot be used (the worktree.unavailable.git* sentence). */
  reason: wireTextSchema.optional(),
});
hostStateSchema = z.strictObject({ account, mainProjectSettings, agent: agentHostStateSchema, work: workStateSchema });
```

`WorkspaceInfo.isGitRepo` and `Topic.versioned` stay on the wire with a corrected comment ("the shared folder has a
git repository of its own"); the web app stops deciding anything from them (D18 uses `HostState.work`).
`startPreflightSchema` gains:

```ts
history: z.enum(['folder', 'smurg', 'direct']),                 // how the items started now run
direct: z.strictObject({ reason: wireTextSchema, hostOnly: z.boolean() }).nullable(),  // with history 'direct'; hostOnly: the caller is not the host (D15)
agent: z.strictObject({ model: modelIdSchema.nullable(), permissionMode: sessionModeChoiceSchema.nullable(), effective: permissionModeSchema }),
/** With history 'smurg': folders that are git repositories of their own and are not copied into work items (D14). */
nestedRepos: z.array(entryPathSchema).max(PREFLIGHT_NESTED_REPOS_MAX),   // 20; [] otherwise
/** With history 'smurg': the folder lies in a folder a cloud service syncs (D14). */
cloudSynced: z.boolean(),
// commit: as today, only with history 'folder' (null with 'smurg' and 'direct')
```

`plan.start` gains `direct?: z.literal(true)`: required when the preflight said `direct`, refused with
`plan.start.directUnconfirmed` (reason `direct-unconfirmed`) otherwise; and refused with `plan.start.directHostOnly`
(reason `direct-host-only`) when the caller is not the host (D15). `plan.item.retry` of an item whose pin says
`history: 'direct'` is refused to anyone but the host with the same words. `NO_CHANGES_REASONS` gains `'no-history'`.
`SESSION_END_REASONS` gains `'reviewed'` (a direct item's session ends when its report was reviewed: nothing was
merged). The worst case of `HostState` (32 models with 512-character descriptions) goes into
`worst-case.fixture.ts`.

### D6. Stored state: the shapes, the steps, the defaults

**Files.** `packages/daemon/src/core/state-store.ts` (`WORKSPACE_SHAPES = 2`); `packages/daemon/src/frozen/v0.5.0.ts`
(new, literal, imports zod only: `stateShapeV050`, `agentSessionsShapeV050`, each a strict copy of what 0.5.0, 0.5.1
and 0.5.2 accept, built from `test/upgrade/shapes/state.json.txt` and `agent-sessions.json.txt` plus the rules
written as code in the pinned sources: the path rules of `paths.ts` with `mark-run`, the refines);
`packages/daemon/src/core/workspace-state.ts`; `packages/daemon/src/sessions/agent/store.ts`;
`packages/daemon/src/topics/store.ts`; `packages/daemon/src/worktree/store.ts`; `test/upgrade/pin.test.ts`
(`PINNED_AT_SHAPES = 2`, `FROZEN` gains `v0.5.0.ts`, shapes rewritten with `SMURG_PIN_WRITE=1` after the question
is answered); `test/upgrade/fixtures.test.ts` (`NOT_PUBLISHED_YET` names every new point, below).

**state.json** (`STATE_VERSION = 2`; the comment's rule "from the next change on, a new number" applies now):

```ts
workspaceStateSchema = z.strictObject({
  version: z.literal(2),
  ...as today (settings: hostSettingsSchema, which now has permissionMode),
  /** Notices the host has not seen yet (D13). */
  hostNotices: z.array(z.enum(HOST_NOTICES)).max(HOST_NOTICES.length),
});
// HOST_NOTICES = ['agents-auto'] (protocol, entities.ts: admin.notice.seen names one)
```

Steps, oldest first: `stateStepFromV040` (unchanged; its output is now checked against `stateShapeV050`, which is
what it produces) and

```ts
/** state.json of smurg 0.5.0, 0.5.1, 0.5.2 → 0.6.0. THE OWNER'S DECISION (2026-10-20, DECISIONS.md 2): the workspace
 * switches to auto at the update, and the host is told. This is the one step that sets a security-relevant value to
 * the OPEN side; the constant is the step's own and never today's default. */
export const stateStepFromV050 = defineStep({ from: '0.5.0', sinceShapes: 2, shape: stateShapeV050,
  upgrade: (old) => ({ ...old, version: 2, settings: { ...old.settings, permissionMode: 'auto' }, hostNotices: ['agents-auto'] }) });
```

A new workspace: `permissionMode: 'auto'`, `hostNotices: []` (`initialWorkspaceState`, `DEFAULT_SETTINGS`).

**agent-sessions.json** (no `version` key). The record changes:

```ts
// was: mode: z.enum(['ask-all','ask-commands'])   (renamed so that no 0.5.x record passes today's schema unchanged)
modeChoice: z.enum(SESSION_MODE_CHOICES).nullable(),         // the session's own choice; null: it follows (= the wire's modeChoice)
modeChangedBy: z.strictObject({ userId, displayName }).optional(),  // who chose it (absent with null)
model: modelIdSchema.nullable(),                             // null: the host's default
modelChangedBy: z.strictObject({ userId, displayName }).optional(), // who chose the model (absent with null; D12)
endReason: z.enum(SESSION_END_REASONS).optional(),           // + 'reviewed' (wider enum)
```

```ts
/** agent-sessions.json of 0.5.0 to 0.5.2 → 0.6.0 (with the state step: the owner's decision). A session follows the
 * workspace (auto) unless a PERSON made it stricter than 0.5.2's default for it (`ask-all` in a worktree or a work
 * item, with modeChangedBy): that choice stays. Every model is the host's default, as it was. */
export const agentSessionsStepFromV050 = defineStep({ from: '0.5.0', sinceShapes: 2, shape: agentSessionsShapeV050,
  upgrade: (old) => ({ sessions: old.sessions.map(({ mode, modeChangedBy, ...rest }) => {
    const tightened = rest.purpose !== 'discussion' && mode === 'ask-all' && modeChangedBy !== undefined && rest.root.kind === 'worktree';
    return { ...rest, modeChoice: tightened ? 'ask-all' : null, ...(tightened ? { modeChangedBy } : {}), model: null };
  }) }) });
```

(0.5.2's defaults were `ask-all` for a free session in the main workspace and `ask-commands` for work items and
worktree sessions; a main-workspace session that a person loosened to `ask-commands` follows auto, which is what
its person wanted more of. Every record is carried; nothing is dropped.)

**Documents that only gain optional keys** (a 0.5.x file passes today's schema as it is; no step):
- `topics.json`: topic `agent?: { model?: ModelId, permissionMode?: SessionModeChoice, modeChangedBy?: { userId,
  displayName }, modelChangedBy?: { userId, displayName } }`; item `direct?: true` (it ran in the folder itself,
  D15); pin `history?: 'smurg' | 'direct'` (absent: the folder's own git, as 0.5.x wrote) and `commit:
  gitIdSchema.nullable()` with the refine `commit === null ⇔ history === 'direct'` (blobs null too).
- `worktrees.json`: top-level `hidden?: { createdAt: epochMs, configHash: sha256, headHash: sha256 }` (D14);
  worktree `repo?: 'smurg'`; merge `repo?: 'smurg'` (absent: the folder's own `.git`) and, with `repo: 'smurg'`,
  `base?: gitCommit` (the merge base the review showed, D14).
- `reports.json`: `noChanges` gains `no-history` (wider enum of the wire schema it extends).
- per-session `cards.json`: `gate` gains `writes-host-only` (also `writes-outside`, G12; and, added after the build's
  review, `writes-unknown`: a teammate's command whose target smurg cannot read, `GATE_ASKS_WHEN_UNSURE`).
- transcripts: notice `action` gains `choose-model`; new line and notice ids are free-form (`wireRefSchema`).
- `audit*.jsonl`: `AUDIT_ACTIONS` gains `session.model`, `topic.agent`, `agent.command.blocked`.
- `host-rules.json`, `inbox.json`, `claude-trust.json`, uploads, conflicts, activity: unchanged.

`WORKSPACE_SHAPES` 2 is written by the first 0.6.0 start (stamp); every one of these optional points goes into
`NOT_PUBLISHED_YET` under its kind (coverage.json naming, e.g. `'topics.json': ['topics[].agent', …]`) until the
0.6.0 fixture exists (made after the release, D22). `NOT_PUBLISHED_YET` lists ONLY the points of documents WITHOUT a
new step (topics, worktrees, reports, cards, transcripts, audit): for `state.json` and `agent-sessions.json` the
newest fixture (0.5.2) is checked against the frozen v0.5.0 shape, so their new points (`hostNotices`,
`modeChoice`, `model`, `modelChangedBy`) are not listed there (R-ENG).

**The test harness's shape rule** (R-ENG; `packages/daemon/test/upgrade/persisted.ts` `shapeWrittenBy`). Today it
returns the shape of the FIRST step whose `from` is at or after the version, else today's schema: with the steps
[0.4.0, 0.5.0], 0.5.1 and 0.5.2 would get today's version-2 schema and their fixtures would be refused right after S1.
New rule: a step's shape covers the versions from its `from` up to (not including) the next step's `from`; the last
step's shape covers versions up to (not including) the first version that writes today's shape, which persisted.ts
records per document with a step in `TODAY_SINCE` (`state: '0.6.0'`, `agent-sessions: '0.6.0'`, `suggestions:
'0.5.0'`: the three documents that have steps in 0.6.0); a version at or after it gets today's schema. The rule is in S1 (it has to
change with the first new step).

**Launch files** (`~/.smurg/sessions/…`) are derived and rewritten at every start: `--model` and the new modes need
no step (U5). The probe's files (D7) use the same pattern (`sessions/<workspace key>/<hex of "probe">/settings.json,
mcp.json`), so the persisted-kinds list of the fixtures knows them.

**`~/.smurg/workspaces.json` and `credentials.json`**: unchanged (their `version` can never change in a minor).

**Daemon.upgraded** (`packages/daemon/src/daemon.ts`): each entry gains `writer?: string`, the `smurg` of the stamp
phase 1 read (0.5.1 and 0.5.2 wrote it), for D13's line.

### D7. Models in the daemon

**Files.** `packages/daemon/src/sessions/agent/models.ts` (new: the list, the probe, the host's default),
`profiles.ts`, `agent-runner.ts`, `normalise.ts`, `claude-process.ts` (error codes, below), `agent-sessions.ts`,
`store.ts`; `hooks/settings-writer.ts`
(`claudeArgsFor`); `sessions/handlers.ts` (`session.model.set`, host state); `topics/topic-service.ts`
(`topic.create` model), `topics/plan-service.ts` (`plan.start.agent`), `topics/scheduler.ts` (items get the topic's
model), `sessions/session-manager.ts` (`session.create` model); `core/interfaces.ts` (`AgentStartInput`:
`mode` → `modeChoice: SessionModeChoice | null`, + `model: string | null`; `AgentSessions.setModel`,
`AgentSessions.hostAgentState()`).

**The list and the host's default** (`models.ts`, class `AgentModels`):
- Source: Claude Code's `initialize` answer (U1 E3: `models[]` of `{value, resolvedModel, displayName, description,
  supportsAutoMode?, …}`). Mapping to `agentModelSchema`: drop the entry `value: 'default'` (smurg's null is "the
  host's default"); `name` ← `displayName`; `description` ← `description` (cut at 512, control characters out);
  `resolved` ← `resolvedModel` when it passes `modelIdSchema`; `auto` ← `supportsAutoMode === true`; `billing:
  'usage-credits'` when `value`, `resolvedModel` or `displayName` names Fable (`/fable/i`, D4) (U4: "In non-interactive mode … Claude Code never
  asks for consent. When a Fable request there would bill to usage credits, Claude Code bills it without asking");
  entries that fail the schema are dropped and logged once; at most 32.
- Refresh: the probe below, and every agent process's own `initialize` (the runner hands the raw `models` to
  `AgentModels.fromInitialize`; the newest answer wins). A change of the list or of `hostDefault` broadcasts
  `session.host`.
- The probe (`AgentModels.probe()`): runs when `session.host.get` arrives and the list is not known, at most once at
  a time, and after a failure not again for 60 s. It spawns the binary the sessions use (`preflight()` of
  agent-sessions.ts: found, version ≥ 2.1.288) with EXACTLY the flag set U1 E7 measured (R-ENG: the first draft had
  a different set): the runner's `STREAM_ARGS`, `--session-id <a fresh uuid>`, then the profile flags
  `--permission-mode default --settings <probe>/settings.json --mcp-config <probe>/mcp.json --tools Read
  --strict-mcp-config --setting-sources user`. These are the ordinary launch flags, so the ordinary
  `checkLaunchArgs` checks them (no separate probe check). cwd: a private empty folder
  `<sessionFilesRoot>/<hex("probe")>/cwd` (0700); env `buildHostEnv` without hook variables.
  Its settings file: `{ disableAllHooks: true, permissions: { allow: [], ask: [], deny: ['Bash', 'Edit', 'Write',
  'WebFetch'], disableBypassPermissionsMode: 'disable', defaultMode: 'default' } }`; its mcp.json `{ mcpServers: {} }`.
  It sends `initialize`, then `get_settings` (U1 E8: `applied.model` is the effective model of a process started
  without `--model` = the host's default), closes stdin, waits 5 s for the exit, then kills its own process group
  (recorded pid only, §0 rule 1), and removes its folder. Measured cost: 141–188 ms, no `/v1/messages`, only
  `HEAD /api/hello`, no transcript (U1 E7). Never `--model`.
  NOT measured, and settled by the real test R7 before the probe ships (D21): that `disableAllHooks: true` in the
  `--settings` file keeps the host's own USER hooks from running (R7 puts a SessionStart hook into the isolated user
  settings and asserts it did not run), that no transcript and no project entry is written under the isolated
  HOME, and that nothing of the probe's process group is left (U1's E7 run listed `ioreg` children in its groups). If
  R7 shows a user hook ran, the probe is NOT shipped: `modelsKnown` then becomes true only from a session's own
  `initialize`, and `model.unavailable` says so until one has started.
- The daemon's stop (`AgentSessions.stop`) kills a running probe's process group and awaits its exit, like a
  session's (test: a stop during a probe that never answers leaves no process).
- `hostDefault`: `get_settings.applied.model` of the probe (null when absent or not a model id).

**Passing the model** (U1 E6: only `--model` on EVERY start is deterministic):
- `claudeArgsFor(files, profile)`: `--model <record.model>` when the record's model is not null; nothing otherwise
  (the host's own default applies, exactly as every 0.5.2 session; a resumed conversation without a model is left
  to Claude Code, and the strip shows what it runs).
- `checkLaunchArgs`: `--model` joins `VALUE_FLAGS`; its value must pass `modelIdSchema` and not start with `-`; at
  most once. `settings-writer.ts`'s comment "never `--model`" goes; "never a bypass flag" becomes D8's rule.
- A session's model is set at its start: `session.create.model`; a topic's discussion and every later session of the
  topic: `topic.agent.model`; a work item: the topic's model when its session starts (the Start dialog edits the
  topic's, `plan.start.agent`); a retry of an item: the item's previous session's model.

**Claude Code's error codes reach the daemon** (R-ENG: today `normalise.ts:108-113` keeps only a control response's
`error` text and `claude-process.ts:160-168` throws `new ControlError('refused', error)` without a code): the
normaliser keeps `error_code` (a short ASCII token, ≤ 64 characters, else dropped) and `ControlError` gains `code?:
string`. D7 (`restricted_by_org`) and D8 (`auto_mode_model`, `bypass_not_launched`) branch on `code`; an unknown or
absent code takes the generic branch (the request refused, nothing changed, logged). Stand-in tests for each of the
three codes and for none (D17 makes the stand-in send them).

**Changing it live** (`AgentSessions.setModel(sessionId, model | null, by)`): checks `model-offered`; when the
session has a ready process, control `{ subtype: 'set_model', model }` (null: `{ subtype: 'set_model' }`, U1 E3:
back to the default) and waits for the answer (10 s); an error answer (2.1.268+ may refuse an id the provider does
not offer; `restricted_by_org`, U4 N) refuses the request with `session.model.refused` and changes nothing.
Then: `record.model = model`, `record.modelChangedBy = by` (cleared with null), saved; line
`conversation.model.changed` {by, model} or `conversation.model.default` {by}; audit `session.model` {sessionId,
model|null}; the next turn's `init` shows what runs. The model is also in the audit entries that choose one
(R-SEC): `session.create` (detail `model`, null for the host's default), `topic.create`, `topic.agent` and
`plan.start` (detail `agent.model` when the Start set one). A parked session
only stores it (its next start passes `--model`). Afterwards D9's auto check runs against the new model (a model
without auto mode moves an auto session to its fallback at once; the reverse returns it to auto).

**What is shown** (`modelInUse`): `normalise.ts` reads `init.model` (U1 E3: the resolved id; U4 H: an `init` line
starts every turn, also after `set_model`). The runner sets `modelInUse` from each `init` and publishes the session.

**A refused model** (U1 E4: a 404 comes back as an assistant message with `model: '<synthetic>'` and `error:
'model_not_found'`, text "There's an issue with the selected model …", then a `result` with `is_error`):
- `normalise.ts`: an assistant line's `error` string is carried on its text event (`apiError`).
- runner: a synthetic text with `apiError === 'model_not_found'` is not shown as the agent's words; it appends notice
  `notice.modelRefused` {model: the record's model, else `modelInUse`, else "the host's default"} (level error,
  action `choose-model`) once per turn, and that turn's generic `notice.turnError` is not added. The process stays
  (U1 E5: after a 404, `set_model` to another model works). `authentication_failed` keeps today's login path.
- No `--fallback-model` is ever passed: a person chose the model, and a silent switch would hide what runs (U1 E9).

**A substituted model** (U4 N: an organization's restriction replaces it with an informational line): at an `init`
of a session whose model is not null, the expected id is the list entry's `resolved` for that value (else the value
itself when it starts with `claude-`); when it differs from `init.model` (both without a trailing `[1m]`), notice
`notice.modelSubstituted` {model: entry name or value, inUse: init.model} (warning) once per process and model.
With no way to know the expected id (an alias the list does not hold), nothing is said.

**Tests** (D21 has the list): profiles/settings-writer pure tests; stand-in session tests for start/resume/live/
parked/refused/substituted/probe; the opt-in real-Claude test R1 and R7.

### D8. The Claude profile: modes, the settings file, the launch checks, live changes

**Files.** `sessions/agent/profiles.ts`, `hooks/settings-writer.ts`, `sessions/agent/agent-runner.ts`,
`sessions/agent/agent-sessions.ts`, `admin/settings.ts`, `conversation/permissions.ts`, `core/interfaces.ts`
(`LaunchProfile.mode: ClaudeMode`, + `model`).

```ts
export type ClaudeMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions';
/** smurg's mode → Claude Code's (DESIGN 0.6.0 D8). `fallback`: what this process runs instead (D9). */
export function claudeModeFor(purpose: AgentPurpose, mode: PermissionMode, root: RootRef, fallback: 'none' | 'ask-commands' | 'auto'): ClaudeMode {
  if (purpose === 'discussion') return 'default';
  const asked = fallback === 'ask-commands' ? 'ask-commands' : fallback === 'auto' && mode === 'ask-nothing' ? 'auto' : mode;
  switch (asked) {
    case 'ask-all': return 'default';
    case 'ask-commands': return root.kind === 'worktree' ? 'acceptEdits' : 'default';
    case 'auto': return 'auto';
    case 'ask-nothing': return 'bypassPermissions';
  }
}
/** The daemon allows edit requests without a card (after the host-only check and the lock): a main-workspace session
 * that RUNS as "Asks before commands" (chosen, or auto's fallback). */
export function daemonAllowsEdits(purpose: AgentPurpose, modeInUse: PermissionMode, root: RootRef): boolean
```

`conversation/permissions.ts:353` uses `modeInUse ?? permissionMode` instead of `session.permissionMode`.

**The settings file** (`buildSessionSettings`, U2/U4 D, K3, K5):
- `permissions.disableBypassPermissionsMode: 'disable'` in every session file EXCEPT a session whose launch mode is
  `bypassPermissions`; there the key is absent.
- `permissions.defaultMode`: the launch mode, except `bypassPermissions`, whose file says `auto` (a refused bypass
  then lands in auto, not in Claude Code's own default; U4 D: the fallback is the file's `defaultMode`).
- Everything else as 0.5.2 (the gate's hooks, the deny rules, `crossSessionInbound: 'refuse'`, …), plus the deny
  rules of D8a and, for a session rooted in the main workspace, `Edit(//<main realpath>/.smurg/**)` (D10).

**Launch checks (fail closed)**:
- `checkLaunchArgs(args, { bypass })`: `--permission-mode` ∈ {`default`, `acceptEdits`, `auto`}, and
  `bypassPermissions` only with `bypass: true`; `--model` as D7; `--dangerously-skip-permissions` and
  `--allow-dangerously-skip-permissions` stay unknown flags (refused: smurg never passes them; U4 E1: a `-p` run
  starts in `bypassPermissions` from the mode flag alone, with no dialog).
- `checkSessionSettings(settings, { bypass, reach })` (new, run on the object `writeSessionFiles` wrote, before the
  spawn): `disableBypassPermissionsMode === 'disable'` unless `bypass`; with `bypass` the key is absent and
  `defaultMode` is `auto`; `defaultMode` is never `bypassPermissions`; and every rule of D8a for this session is in
  `permissions.deny` (fail closed: a missing one refuses the start).
- `bypass` is true only when ALL of: the session's effective mode is `ask-nothing`; `ctx.settings.get().permissionMode
  === 'ask-nothing'` (read again in prepareLaunch: a second read, not a second source; it comes from `state.json`,
  which has no MAC, so D8a refuses agents' commands that name `~/.smurg` and D13's start line shows the mode to the
  host; R-SEC); `process.getuid?.() !== 0`; the
  runner's fallback for this start is `none`. A refusal is `session.hooks.settingsInvalid` (existing words) and a
  log error naming the check.

**Live changes** (`AgentSessions.setMode`, a workspace change, a topic change): the runner's `setClaudeMode(mode:
ClaudeMode)` sends control `set_permission_mode`. Answers (U4 H, K): success → the next `status`/`init` confirms
(D9); `error_code: 'auto_mode_model'` → the fallback of D9 at once; `error_code: 'bypass_not_launched'` → the
process restarts at its next idle moment (`restartPending`, line `conversation.agent.restarting`). Loosening INTO
`ask-nothing` therefore always waits for a fresh start (smurg never launches with `--allow-dangerously-skip-
permissions`); tightening OUT of it is immediate.
- `admin.settings.set { permissionMode }` (`admin/settings.ts`): refused with `settings.asksNothing.root` when the
  value is `ask-nothing` and the uid is 0; on success the bus `settings.changed` reaches AgentSessions, which
  re-evaluates every live session that follows the workspace (choice null, and for items a topic choice null):
  tighter → live; looser into `ask-nothing` → restart when idle; each such session gets line
  `conversation.mode.workspace` {mode}. Audit `settings.change` (existing) names the key.
- `topic.agent.set { permissionMode }`: the same for the topic's item sessions that follow the topic (line
  `conversation.mode.topic` {by, mode}); audit `topic.agent`.
- `session.mode.set`: line `conversation.mode.changed` {by, mode} for a choice, `conversation.mode.followed` {by,
  mode: the effective one} for null; audit `session.mode` {sessionId, mode: choice|null}.

**Honest costs** (O1 frame): wherever auto is chosen or is the default (the New session dialog, the Start dialog,
the console's setting), the line `cost.auto` (Appendix B): auto's checks are extra requests that may count toward the
host's usage (U4: "On Enterprise plans and on accounts that use the Claude API, … classifier calls count toward your
token usage", while "wherever server-side checks are on, the server performs those checks … at no charge": which one
applies depends on the account and the connection; against the fake API on 127.0.0.1 every run got the billed local
classifier, so this was never seen free here). smurg's host env
drops every `CLAUDE_CODE_*` variable but the provider ones (U1), so `CLAUDE_CODE_AUTO_MODE_SERVER` and
`CLAUDE_CODE_AUTO_MODE_MODEL` do not reach sessions; the host guide says so (§5.3).

### D8a. Deny rules beyond the session's own folder (every mode, `ask-nothing` included)

**Why** (R-SEC, measured with the real 2.1.288 against the fake API, `R-SEC/exp/runs/*/summary.json`). smurg's deny
rules today are written relative to the session's OWN root (`buildProfile` → `fileRule(…, rootRealPath, …)`). A work
item runs in `<share>/.smurg/worktrees/<id>`, so the main folder's `.git`, `.claude`, `.mcp.json` and the new
`.smurg/git`, and the host's `~/.claude`, `~/.claude.json`, `~/.smurg` and `~/.ssh`, are outside every rule. In 0.5.2
that did not matter: a worktree session ran in acceptEdits, so a write outside its folder made a card (and
`permissions.ts assess()` refused writes to Claude Code's configuration automatically, and made requests naming the
host's home or reaching outside the project host-only). In auto and in bypass those requests never reach smurg. In
run `wt--auto--smurg` (a work item's profile, auto, the classifier allowing) all of these RAN without a card: the
main folder's `.git/hooks/post-checkout`, `.claude/settings.json`, `CLAUDE.md`, a ref in `.smurg/git`, the host's
`~/.claude/settings.json`, `~/.claude/CLAUDE.md` and `~/.claude/settings.local.json`, and another item's checkout.
In run `main--bypassPermissions--smurg` (the design's ask-nothing file) the host's `~/.claude/*` was written. With
absolute deny rules added (`*--plus` runs) every protected write was REFUSED, in auto and in bypass, for the
absolute and the `~` spelling.

**Decision.** `buildProfile` gains an input `reach` and adds these rules for every NON-discussion session, whatever
its mode (a discussion has no shell and its reads and writes are confined by G5/G6):

| place | rules | why |
|---|---|---|
| the main root, for a session rooted in a worktree | `AGENT_READ_DENY_PATTERNS` as Read rules and `AGENT_EDIT_DENY_PATTERNS` as Edit rules, written for the MAIN root's realpath (what a main-workspace session already has: host-private files; `.git/**`, `**/.git/**`, `.claude/**`, `**/.claude/**`, `.mcp.json`, `**/.mcp.json`) | the shared folder's own configuration and secrets, out of an item's reach as they are out of a main session's |
| the main root, every session | Read and Edit of `.smurg/git/**`; Edit of `.smurg/.gitignore` (a main session keeps its wider `Edit(.smurg/**)`, D10) | smurg's own history (D14) and what keeps `.smurg` out of the user's later `git add -A` |
| the host's home (`config.sessions.hostHome`) | Edit of `.claude/**`, `.claude.json`, `.ssh/**`; when the host's environment sets `CLAUDE_CONFIG_DIR`: Edit of `<that dir>/**` | Claude Code's user settings, hooks, allow rules and memory; ssh keys, `authorized_keys` and config (0.5.2's `HOST_HOME_DIRS`: `.claude`, `.ssh`) |
| smurg's state folder (`config.stateDir`, `~/.smurg`) | Read and Edit of `**` | the workspace state (`state.json` holds the workspace's mode and has no MAC), the daemon's identity keys, the relay logins, the launch files of every session (0.5.2's `HOST_HOME_DIRS`: `.smurg`) |
| smurg's own executable (`config.sessions.selfCommand.file`, and its realpath when that differs) | Edit | every hook of the gate runs that file: replacing it would switch the gate off for every later tool call |

The rules are written with a new `absoluteRule(tool, absRealPath, relPattern?)` beside `fileRule` (the same escaping
and the same refusal of a path no rule can hold: the start is refused with the existing words). The host's home
and the state folder are realpaths. No session's own folder may lie inside one of these places, or a rule would refuse
the session its own folder. Sharing a folder that contains the state folder or lies in it is refused today
(`packages/cli/src/commands/host.ts:151-152`, `workspace/share.ts:92-95`), and so is sharing the home folder or a
folder that contains it (`share.ts:82-86`). NEW in 0.6.0: `prepareShare` also refuses a share inside the host's
`~/.claude`, `~/.ssh` or `CLAUDE_CONFIG_DIR` (`ShareError('inside-agent-config')`, CLI words `host.folder.insideConfig`,
B.3). Sharing those folders would hand every guest the host's Claude Code settings or keys, as sharing the home folder
would. A unit test in `share.test.ts` covers it. The constant list of places lives in `profiles.ts` (`REACH_DENY`), with this
table as its comment.

**What these rules do and do not do** (said in §3, in HOSTING §5.2 and in the "Asks for nothing" warning, both
languages): they refuse an agent's edit tools on those places, and a shell command that NAMES one of them (U2,
R-SEC: Claude Code applies a path's deny rule to Bash commands that name the path, in every mode). A command that
reaches a place without naming it (a script, a program, a variable, a `cd` first) is not refused by them: in auto
Claude Code's check decides it, in ask modes it asks (as 0.5.2), in `ask-nothing` it runs. They are not a sandbox.

Not covered, on purpose: another work item's checkout (`.smurg/worktrees/<other>`) cannot get a rule without
refusing the session's own folder, which lies beside it (a deny rule always beats an allow rule). A write there by
a teammate's item asks the host (G12, D10). One by the host's own item runs when Claude Code's check allows it, and
shows in that other item's diff before any merge (§3, §12 of ARCHITECTURE). The shell's startup files and
`~/.gitconfig` get no rule: Claude Code treats them as protected paths, which never take its fast path (U4), and G12
asks for a teammate's write to them.

**Tests.** Unit (profiles / settings-writer): every rule of the table for each purpose × root, none for a
discussion, `CLAUDE_CONFIG_DIR` honoured, a home path with `[` escaped, `checkSessionSettings` refusing a file with
one rule missing. Real (D21 R2 and R5): the nine writes of R-SEC's `reach.mjs` from a work item in auto and from a
main session in bypass: every protected one refused, in the absolute and the `~` spelling. The session still runs
normally (its own folder's edits and commands pass).

### D9. Detect what really runs, and say it

**Facts** (U2, U4): Claude Code falls back silently: `--permission-mode auto` with a model without auto mode (2.1.288:
Haiku 4.5) or with `disableAutoMode` in any settings starts in `default`; `bypassPermissions` with
`disableBypassPermissionsMode` starts in the file's `defaultMode` (else `auto`); as root it refuses to start. After
`set_model` to a model without auto mode, 2.1.288 STAYS in auto (fixed in 2.1.299 to move to default). Every `init`
(each turn) and every `status` line carries `permissionMode`; `initialize` carries `current_permission_mode`.

**Rule** (`agent-runner.ts`, `checkMode` rewritten; state `fallback: 'none' | 'ask-commands' | 'auto'` per process,
reset at each start):
1. Before a start: when the effective mode is `auto` and the list's entry for the session's model has `auto: false`,
   the start uses `fallback: 'ask-commands'` and `modeFallback: 'model-no-auto'` (smurg does not rely on Claude Code's
   own fallback, which differs between versions). The entry: the one whose `value` is the record's model; for a null
   model the one whose `resolved` is `HostState.agent.hostDefault`; none found (list unknown, an id it does not
   hold): no fallback before the start, and rule 2 catches what Claude Code does. After `set_model` and at every
   `init` (whose `model` names the entry by `resolved`) the same test runs live.
2. At every reported mode, `expected = claudeModeFor(…, fallback)`:
   - reported = expected: `modeInUse` = the smurg mode that the expected Claude mode stands for;
   - expected `auto`, reported `default`: auto was refused → `fallback = 'ask-commands'`; in a worktree
     `setClaudeMode('acceptEdits')`; `modeFallback = 'model-no-auto'` when the model's entry has `auto: false`, else
     `'auto-off'` and `HostState.agent.autoMode = 'off'` (kept until a session runs in auto again);
     notice `notice.autoUnavailable.model` {model} or `notice.autoUnavailable.settings`, once per process;
   - expected `bypassPermissions`, reported `auto`: `fallback = 'auto'`, `modeFallback = 'ask-nothing-off'`,
     `HostState.agent.asksNothing = 'off'`, notice `notice.asksNothingRefused`; reported `default`: as the auto case
     with `modeFallback: 'ask-nothing-off'`;
   - reported LOOSER than expected (order `default < acceptEdits < auto < bypassPermissions`; `plan`, `dontAsk` and
     anything unknown count as looser): set back with `setClaudeMode(expected)`, log warn (0.5.2's rule);
   - reported stricter (expected `acceptEdits`, reported `default`): accepted, `modeInUse = 'ask-all'`.
3. `modeInUse`, `modeFallback` are on the wire (the strip shows them, D18); the hook registration learns the Claude
   mode in use (`HookServer.updateSession(sessionId, { claudeMode })`) for G10/G11 (D10).
4. Root: `HostState.agent.asksNothing = 'root'` whenever the uid is 0 (the console shows it; D8 refuses the setting).

### D10. The gate in auto mode, and the main workspace

**Facts** (U2): in auto, edit tools and simple file commands inside the working folder (`echo >`, `>> CLAUDE.md`,
`rm`, `mv`) run on Claude Code's fast path without the classifier; everything else goes to the classifier, which
reads the user's messages and the commands, not their output; a PreToolUse hook's "ask" produces a `can_use_tool`
also in auto (U4 C1, 0 classifier calls); the hook's deny binds in every mode. In a worktree the result report's
diff and the host's merge cover what the fast path lets through. In the main workspace nothing does: an agent's edit
TOOL is still held by the gate (G4: host-only paths for a member's session; G8: the lock, refused while a person
types), but its SHELL is not.

**Decision: a new gate row G11** (`hooks/tool-gate.ts` table and comment, `hooks/hook-events.ts`, `hooks/deny-text.ts`,
`hooks/hook-server.ts` (`updateSession`), `hooks/bash-guard.ts` reused; `core/interfaces.ts`: `GateRow` gains `'G11'` and `'G12'`,
`HookSessionRegistration` gains a mutable `claudeMode: ClaudeMode`), evaluated after G10 for `Bash` when the
session's root is the main workspace AND its Claude mode in use is `auto`:
- the command's places (`bashPlaces`, resolved with `onDisk` like G10) of kind `write` that lie in the root:
  - (G11a) in a session whose `pathRights` is `member`: a place that PathGuard refuses to the session's principal as
    a write (`ctx.paths.resolve({ root: MAIN_ROOT, path }, { principal, forWrite: true, subtree: <the place is a
    folder> })` throws `PathDeniedError` `host-only` or `hidden`): a host-only path, a script the trust gate recorded,
    smurg's `.smurg`, or a folder that holds one (PathGuard's own `findNameBelow` scan with its bound; a tree too big
    to look through is refused there, so it asks here) → **ask** with the reason `BASH_ASK_REASONS.writesHostOnly`;
    the conversation module labels the card `gate: 'writes-host-only'` and makes it host-only (`hostOnly: true`,
    "Only the host can allow this"). It is the same rule a teammate meets when they write or rename through smurg;
  - (G11b) a file a person is typing in (`locks.whoIsEditing({ root: MAIN_ROOT, path }).humans` not empty), or a
    folder that holds such a file (the lock service's human locks whose path lies within the place) → **deny** with
    `HOOK_DENY_REASONS.bashWhileTyping(names, path)` (B.4), bus `agent.tool.gate` row `G11` (audited and coalesced
    as today);
- a reading that is `unsure` → pass, while `GATE_ASKS_WHEN_UNSURE = false`. Reason: a command smurg cannot follow is
  one that Claude Code's fast path does not take either (U2: `/bin/sh -c 'echo 1 > f'` went to the classifier), so
  auto's own check reviews it; asking for every unsure line would make auto ask for most compound commands. This is
  NOT measured for every shape: the real-Claude test R4 (D21) runs `F=notes.md; rm "$F"` and `rm $(cat list)` in
  auto in the main workspace and asserts the classifier was asked; if 2.1.288 fast-paths them, the constant is
  flipped to `true` in the same change (and the host guide says so). Whatever R4 shows, the guides say that a command
  smurg cannot read can change a file only the host may change, and that Claude Code's check decides it (below).
- G11 does not run in a worktree (merge review), in the ask modes (Claude Code asks for every shell write in
  `default`), nor in `ask-nothing` (the host chose no check). G10 does not run in `ask-nothing` either (every command
  already runs as the host; asking would contradict the host's choice); it runs as 0.5.2 in every other mode.

**A second new row, G12: a teammate's shell writes outside its own folder** (R-SEC: in 0.5.2 every such write of a
teammate's session made a card, host-only when it reached outside the project; HOSTING §5.2 promises "Only the host
can allow this"; in auto those commands run whenever Claude Code's check allows them). Evaluated after G11 for `Bash`
when the session's `pathRights` is `member` (a session a teammate opened, or a work item a teammate started) AND its
Claude mode in use is `auto`, whatever its root:
- the command's write places (`bashPlaces` with `onDisk`, as G10/G11) that lie OUTSIDE the session's own root (for a
  worktree session: also the main folder and other checkouts; for a main session: outside the shared folder), and
  outside the system's temporary folders (`os.tmpdir()`'s realpath, `/tmp`, `/private/tmp`: agents write scratch
  files there all the time, and nothing loads code from them) → **ask** with `BASH_ASK_REASONS.writesOutside`; the
  conversation module labels the card `gate: 'writes-outside'` and makes it host-only (as 0.5.2 made a request
  outside every root host-only);
- an `unsure` reading → pass, by the same constant as G11 (`GATE_ASKS_WHEN_UNSURE`, renamed from
  `G11_ASKS_WHEN_UNSURE`; R4 decides it for both rows);
- not in the host's own sessions (their reach outside the folder is the host's to set, by the mode they choose),
  not in the ask modes (Claude Code asks already), not in `ask-nothing`.
G12 is the design's answer to "something better" in the lead's frame for teammates' sessions; §5 lists it for the
lead, who may drop it (the guides then say that a teammate's commands outside the folder are Claude Code's check's).

Edit tools of a main-workspace session keep G3/G4/G8. The new Edit deny rule `Edit(//<main realpath>/.smurg/**)`
(and its `**/` twin is not needed: worktrees are below it) joins the deny rules of every session rooted in the main
workspace (`AGENT_EDIT_DENY_PATTERNS` stays; the main-root rule is added in `buildProfile`): smurg's own history
(D14) is protected like `.git`. U2 measured that an Edit deny rule also refuses a shell command that names the path.
Every non-discussion session, in a worktree or not, also gets D8a's rules.

**What auto does not check** (said in host guide §5.1, §5.2 and SECURITY-MODEL, both languages; R-SEC):
- the fast path: file edits and simple file commands (`echo >`, `>>`, `rm`, `rm -rf <dir>`, `mv`) inside the folder an
  agent works in run with no check at all; in the main workspace they change the shared folder at once, except G11's
  two cases;
- commands outside the shared folder: a command of ANY session (a teammate's included) that writes outside the shared
  folder (your home, other projects) runs when Claude Code's check allows it; smurg asks first only for a teammate's
  session and only when it can read where the command writes (G12), and refuses only the places of D8a, and only
  commands that name them;
- commands smurg cannot read (a script, an interpreter, `sh -c`, a variable): G11 and G12 do not see where they
  write, so a command of that kind can change a file only the host may change; Claude Code's check decides it
  (R-SEC; the auto-mode defaults even allow "CLAUDE.md Content" edits, U4 `automode-defaults-2.1.288.json`);
- reads (an agent reads every file of the folder, and in auto what Claude Code's check lets it read elsewhere,
  except the host-private files and smurg's state folder, which deny rules refuse to commands that name them);
- a command's output (the classifier does not see it);
- anything a check allowed (it is a model's judgement, not a sandbox).
"Only the host can allow this" (HOSTING §5.2's paragraph on requests only the host can allow) is said only of what
still asks: G11a and G12 cards, and the cards of the ask modes.

### D11. Auto mode's refusals in the conversation; the audit of commands that ran unasked

**Files.** `sessions/agent/normalise.ts`, `agent-runner.ts`, `hooks/hook-events.ts` (`agent.tool.gate` gains
`toolUseId`), `core/interfaces.ts` (bus event), protocol `AUDIT_ACTIONS`.

- `normalise.ts`: `system/permission_denied` (U4 B3: `{tool_name, tool_use_id, decision_reason_type:
  'classifier', decision_reason, message}`) → RunnerEvent `auto.denied {toolUseId, tool, reason}` (reason ≤ 200
  characters, through `mask()`); `system/informational` → logged (first 200 characters), not shown.
- runner on `auto.denied`: the tool call is marked refused; line `conversation.autoMode.blocked` {reason}; audit
  `agent.command.blocked` (outcome `denied`, detail {sessionId, toolUseId, tool, reason, command (fullText)}).
- The audit of a command that ran without a request (U2: today only when its result is ok, agent-runner.ts:1072):
  at `tool.finished` of a call with verb `run`/`fetch`/`other`, no decision, and not marked refused (by
  `auto.denied` or by a gate denial for its `toolUseId`): `agent.command` with `why: 'unasked'`, outcome `ok` when the
  result is ok and `error` when it ran and failed, and `detail.mode` = the session's `modeInUse` (else
  `permissionMode`). Known limit (ARCHITECTURE §12): a command that one of Claude Code's own deny rules refused
  reaches smurg only as a failed result and is audited as "ran, failed"; its result text names the refusal.
- After three consecutive refusals Claude Code asks a person (`can_use_tool`, `decision_reason_type: 'classifier'`,
  U2/U4 L): an ordinary card, with Claude Code's reason as today.

### D12. Who may change what; a member who goes

| what | who | values | message |
|---|---|---|---|
| the workspace's mode | the host (admin) | the four; `ask-nothing` behind the warning dialog, not as root | `admin.settings.set` |
| a topic's model and its items' mode | host, Agent access (`session.drive`) | listed models or null; the three choices or null | `topic.agent.set`, `plan.start.agent` |
| a session's mode | `session.drive` | the three choices or null; never a discussion | `session.mode.set` |
| a session's model | `session.drive` | listed models or null; a discussion too | `session.model.set` |
| a new session / topic with model and mode | `session.create` | as above | `session.create`, `topic.create` |
| start work items, try a stopped or failed item again | `session.create` (as 0.5.2); **when the items run directly in the folder (D15): the host only** | — | `plan.start`, `plan.item.retry` |

`modeChangedBy` is recorded for any non-null choice of a person (session record and topic `agent.modeChangedBy`) and
cleared with null; `modelChangedBy` likewise for a model (session record, topic `agent.modelChangedBy`). **When that
member loses `session.drive`** (`conversation/membership.ts`): their mode choice goes back to null ONLY when it is
looser than what the session (or topic) would follow without it (`isLooserMode`); a stricter choice stays (0.5.2 put
back WHATEVER they set, U2). Their model choice goes back to null (the host's default) when the list entry of that
model has `billing: 'usage-credits'` (R-SEC: the host keeps paying for a choice made by someone who no longer has
access); any other model they chose stays. The line `conversation.mode.reset` {name} (existing words) is written in
each session whose mode changed, `conversation.model.reset` {name} (new, B.1) in each whose model changed. The
member's always-allowed kinds go as in 0.5.2.

### D13. Telling the host about the update

- **`smurg host`, one line** (`packages/cli/src/commands/host-state.ts` `agentsAutoNotice(daemon)`, printed by
  `host.ts` after `host.upgraded`): when this start ran the state step from 0.5.0 (an `upgraded` entry for `state`
  whose `from` is 0.5.0 or older, `compareVersionNames(from, '0.5.0') <= 0`, so a later release's own state step
  does not print it again), message `host.agentsAuto` (Appendix B; ASCII; the guide address of host guide §5.2, which from then on can
  never be renamed: add `#52-what-agents-do-by-themselves-and-what-they-ask-first` to the list of CLI-printed
  anchors in `packages/cli/test/guide-anchors.test.ts`).
- **The upgrade line** `host.upgraded` names `writer` (D6) when the stamp had one, else the step's `from`: a 0.5.2
  workspace reads "last shared with smurg 0.5.2", not "0.5.0".
- **The inbox and the console**: `state.json.hostNotices` holds `agents-auto`; the settings service
  (`admin/settings.ts`, which owns `state.json`'s settings) derives the attention fact `{ subject: 'agents-auto', id:
  'workspace', recipients: [host], target: { kind: 'console', section: 'settings' } }` (AttentionSource `'settings'`,
  new in `core/interfaces.ts`; `inboxKindWaits` false; `attention.changed` emitted when it goes); the console's Settings section shows
  the banner `settings.agentsAuto.banner` with "Got it". `admin.notice.seen { notice: 'agents-auto' }` (new, admin,
  result `{}`) removes it from `hostNotices`; so does any `admin.settings.set` that names `permissionMode` (the host
  decided).
- The host guide §9.2 ("After an update: what your workspace keeps") gets the 0.6.0 paragraph.
- **While "Asks for nothing" is on** (R-SEC: today only the strip chip, the mode dialog and a line in sessions that
  were live when it changed say it, and the host is not reminded at later starts):
  - `smurg host` prints `host.asksNothing` at EVERY start whose loaded workspace mode is `ask-nothing`, after the
    upgrade lines (`agentsAutoNotice`'s neighbour in `host-state.ts`: `asksNothingNotice(daemon)`, from a new
    `Daemon.settings().permissionMode` read once the state is loaded). It also checks the state file: if something
    other than the host set the mode, the host sees it at the next start (and D8a refuses agents' commands that name
    `~/.smurg`).
  - Every member, of every role, sees a badge in the workspace's top bar (`apps/web/src/app/workspace/TopBar.tsx`,
    beside the workspace name; it is shown in both modes and in the console) for as long as
    `publicSettings.permissionMode === 'ask-nothing'`: `workspace.asksNothing.badge`, with its title
    `workspace.asksNothing.title` (B.2, in `strings/workbench.ts`). Editors and Viewers see it too: their files and
    suggestions are what the warning names. It needs no new wire field (the Welcome and `channel.settingsUpdated`
    carry the setting).

### D14. smurg's own history when the folder has no `.git`

**Measured** (U3 B1/B2, git 2.49): `git --git-dir=<share>/.smurg/git --work-tree=<share> init` works (it writes an
absolute `core.worktree`: unset it, the runner passes `--work-tree` anyway); a plain `git rev-parse` in the folder
still says "not a git repository"; `info/exclude` with `/.smurg/` and `node_modules/` keeps those out; a shared
clone of the hidden git dir, an item commit fetched back, a snapshot of the folder with a person's uncommitted
edit, `merge-tree` then `merge`: the item's changes land and the person's edit stays; a conflict is named and the
folder untouched; a write between snapshot and merge is refused by git (the existing `recoverFailedMerge`); the
user's later `git init && git add -A` adds nothing of `.smurg` (0.5.2's `.smurg/.gitignore`). A 676 MB tree:
first snapshot 10.9 s + 0.8 s, 185 MiB of objects; each checkout 3.9 s and the full size on disk. R-SEC (git 2.49,
smurg's git environment): an exclude line with a slash in it is anchored to the top (`sub/.claude/settings.local.json`
was snapshotted), and a file `info/grafts` or `shallow` in the git dir changes the log and empties `merge-base`
(the environment does not neutralise them).

**Files.** `packages/daemon/src/worktree/hidden-repo.ts` (new), `worktree-manager.ts`, `git.ts` (clone of a git dir),
`main-repo.ts`, `review.ts` (`MainRepo` gains `kind: 'folder' | 'smurg'`), `integrity.ts` (the hidden repository's
check), `store.ts`, `fs-ops.ts` (`writeExclude` for both kinds of record), `stage-commit.ts` (the exclude before every
commit of a worktree); `files/disk.ts` reused; `topics/checkpoint.ts`, `plan-service.ts`, `scheduler.ts`;
`core/interfaces.ts` (`MainState.history`, `WorktreeManager.workState()`); web `lib/stores/topics.ts` and
`lib/stores/sessions.ts` (request timeouts, below).

**When it is used.** NOTHING is at `<share>/.git` (`observeGit(...).exists === false`; R-ENG: `observeGit` reports
kind `none` also for an empty or HEAD-less `.git` directory, which keeps 0.5.2's `notAGitRepo`; a test pins that an
empty `.git` directory never gets a hidden repository beside it), and the git executable is usable (found, runs,
≥ 2.42.0; the minimum does not change: the hidden repository uses the same commands, `merge-tree --write-tree`,
`--attr-source`, and `--merge-base`, which is 2.40). A `.git` that exists in any form keeps 0.5.2's answers
(`notAGitRepo` for a directory git does not take, `gitDirNotDirectory`, `noCommit`, `gitDirGone` while records of
the folder's own repository wait). History is `unchecked` until git is looked for. The looking stays lazy and keeps
0.5.2's rule about teammates (`worktree-manager.ts:1808-1819 requireAvailableForWork`: "a teammate's request runs
no git in a folder that is no repository", because on a Mac without the Command Line Tools running `/usr/bin/git`
puts a system prompt on the host's screen; R-ENG): never at the start of sharing, never on a timer; at the first
Start dialog (as 0.5.2's preflight already does), the host's own worktree request, or a merge view. A teammate's
worktree request while history is `unchecked` is refused with `worktree.unavailable.unchecked` (B.1: "smurg has not
checked git on the host's computer yet…"); once history is `smurg`, a teammate's request may create and use the
hidden repository (git is known to run then, so no prompt can appear).

**Creation, crash-safe** (`ensureHiddenRepo`; R-ENG: the first draft left "a `.smurg/git` without a record" undecided).
At the first thing that needs it (the Start dialog's warm-up, a Start's checkpoint, a new worktree, below), in the
worktree module's `main` queue:
1. remove leftovers `.smurg/git.new-*` (smurg's own, from a crash: never followed through a link);
2. `mkdir .smurg/git.new-<16 hex>` (0700, never through a link); `git --git-dir N --work-tree S init --quiet`;
   `git --git-dir N config --unset core.worktree`; write `N/info/exclude` (below);
3. record `worktrees.json.hidden = { createdAt, configHash: sha256 of N/config, headHash: sha256 of N/HEAD }` and
   save it;
4. `rename(N, .smurg/git)` with no replace (it fails when `.smurg/git` exists; then the next rule applies);
5. log info "smurg's own history of the shared folder was created".
No audit entry of its own: what uses it is audited as today (`spec.commit` for the checkpoint, `worktree.create`, the
merge entries), each with `detail.history: 'smurg'`.

What smurg does with what it finds:
- `.smurg/git` exists and the record matches → used.
- `.smurg/git` exists and there is NO record (`worktrees.json` was set aside, which `canSetAside: true` allows; the
  host shared the same folder as a new workspace; a hand-made copy) → refused with `worktree.hidden.unknown` (B.1),
  never adopted: its config could make the DAEMON run code, and nothing says what it holds. The host moves
  `.smurg/git` out of the shared folder, and the next Start makes a new one. `test/upgrade/set-aside.test.ts`
  proves it for a set-aside `worktrees.json` (R-ENG: what setting it aside loses must be proven there), and HOSTING
  §9.3 says that setting `worktrees.json` aside also means moving `.smurg/git` away.
- A record and no `.smurg/git` (a crash between steps 3 and 4, or the host removed it): when no worktree or merge
  record with `repo: 'smurg'` remains open, smurg starts anew (steps 1–5, the record replaced). Otherwise those
  records are refused with `worktree.hidden.gone` (B.1: they can only be rejected), as 0.5.2 does for `gitDirGone`.
- A record whose hashes differ → `worktree.hidden.changed` (below).

**Integrity** (`verifyHiddenRepo`, before every command on G; `integrity.ts`, like a worktree's
`verifyWorktreeRepo`; R-SEC):
- G is a real directory at exactly that path (no link); `G/config` and `G/HEAD` are plain files whose hashes equal the
  recorded ones (HEAD is the symbolic ref `ref: refs/heads/<branch>`, which smurg never changes);
- none of these exists: `commondir`, `gitdir`, `config.worktree`, `info/attributes`, `info/grafts`, `shallow`,
  `objects/info/alternates`, `objects/info/http-alternates`, and no entry below `refs/replace/`;
- otherwise refused with `worktree.hidden.changed` (reason `hidden-repo-changed`).
**The merge base is recorded** (R-SEC: the review diff and the merge both derive their base from history, so a change
to G between review and merge could make the merge differ from what the host reviewed). For a merge record with
`repo: 'smurg'`, smurg stores `base` when it registers each version of the request (the `reviewBase` of G's HEAD
and the request's commit at that moment). Every diff view and the approval compute `merge-base` again and refuse with
`worktree.hidden.changed` when it differs from `base`; the approval's trial merge passes `--merge-base <base>`
explicitly (`merge-tree --write-tree --merge-base`, git 2.40). A branch tip that something else moved therefore
changes nothing smurg merges: each snapshot records the whole folder, and the only thing a moved tip could change,
the merge base, is checked. (The folder's own repository keeps 0.5.2's behaviour: its history is the host's.)

What keeps others away from G: people cannot write `.smurg` through smurg (PathGuard: host-only, and the hidden
folder); an agent's edit tools in a member's session are refused by G4 (`.smurg` is a host-only path); EVERY
non-discussion session, in a worktree or not, gets `Read` and `Edit` deny rules for `.smurg/git/**` (D8a), which
Claude Code also applies to a shell command that names the path; the hooks of G never run (`core.hooksPath=/dev/null`,
GIT_HARDENING); and the integrity check and the recorded base refuse what got through anyway (a program that names
nothing, an `ask-nothing` session). Agents in worktrees READ G's history through their own clone (the clone shares
its objects): that is said in HOSTING §10.2 (below).

**What it holds** (`G/info/exclude`, rewritten before every snapshot by `hiddenExcludeLines(settings)`, a pure
function with a unit test):
- `/.smurg/`; the dependency and cache folders `node_modules/`, `.venv/`, `__pycache__/`; `.DS_Store`;
- the host-private names, GENERATED from `HOST_PRIVATE_FILE_NAMES`, `HOST_PRIVATE_DIR_NAMES` and
  `HOST_PERSONAL_FILES` (R-SEC: written by hand they can drift, and `.claude/settings.local.json` with its slash is
  anchored to the top): a name without a slash as it is (`.envrc`, `CLAUDE.local.md`, `.git/`), a path with a slash
  in the unanchored form (`**/.claude/settings.local.json`). The unit test checks that every host-private sample of
  `paths.test.ts` is ignored at the top AND nested (`a/b/.claude/settings.local.json`, `x/.envrc`), with git's
  `check-ignore` against a scratch repository;
- `/<dir>/` for each shared directory of the host settings (linked read-only into each worktree, as with a
  repository);
- `/<path>/` for each nested repository (below).
The folder's own `.gitignore` files apply as in any repository.

**Nested repositories** (R-ENG: "known limit, nobody told" is a silent failure). A folder inside the share that has
a `.git` of its own (`frontend/.git`) would be recorded as a gitlink, an empty folder in every checkout. At each
snapshot, smurg reads them from the listing of the size bound (an untracked folder that is a repository is listed
with a trailing `/`: git does not look into it) and from G's index (entries of mode `160000`, from an earlier
snapshot: removed with `git rm --cached -q`), writes each as `/<path>/` into the exclude, and never adds them. The
Start dialog's preflight lists them (`nestedRepos`, at most 20, then "and N more") with `start.nestedRepos` {paths}:
"Work items do not see these folders: each is a git repository of its own. To work in one, share that folder."
Test: a share holding `frontend/.git` with a commit: no gitlink in G, the checkout has no `frontend/`, the preflight
names it, a merge of an item that did not touch it succeeds.

**The size bound** (before every snapshot, `snapshotFolder`): `git ls-files -z --cached --others --exclude-standard`
in G/S with `maxStdoutBytes: 64 MiB` (R-ENG: the runner's 4 MiB default would cut 50,000 paths; a truncated listing
counts as too large), then `lstat` of each path in the daemon (bounded: it stops at the first file beyond the
bound): more than `HIDDEN_MAX_FILES = 50_000` files or `HIDDEN_MAX_BYTES = 1 GiB` in all → refused with
`worktree.hidden.tooLarge` {size, files, maxSize: '1 GB', maxFiles: '50,000', largest: the three largest top-level
entries with their size}. Nothing is written then (the check is before `git add -A`). The bound's total (`bytes`) is
kept for the disk check.

**Deadlines and timeouts** (R-ENG: the first snapshot runs inside the Start request; the page gives up after 30 s,
git commands are killed after 60/120 s, and a killed `git add` leaves `G/index.lock`, which 0.5.2 reads as "git busy").
- The commands of a snapshot (`ls-files`, `add -A`, `commit`, `repack`) get `HIDDEN_SNAPSHOT_TIMEOUT_MS = 240_000`.
- The web app passes `timeoutMs: 300_000` (longer than the daemon's deadline) to `plan.start`, to `session.create`
  with a new worktree, and to `worktree.merge.approve` (`lib/stores/topics.ts`, `sessions.ts`, the merge store), so
  the page never reports a failure while the daemon goes on.
- **Warm-up**: when a Start dialog's preflight finds history `smurg`, the worktree module, after answering it and in
  the `main` queue, creates G if needed and runs the bound and `git add -A` with no commit. The expensive part
  (hashing every file into objects) is then done while the person reads the dialog, and Start's own snapshot only
  adds what changed since (U3: 0.06 s when nothing changed). A Start that comes first waits for the warm-up in the
  queue.
- `G/index.lock` at the start of a command in the `main` queue is stale: only smurg runs git in G (D8a refuses
  agents' commands that name it), and the queue runs one command at a time. smurg removes it, with a log warn. For G,
  `busyMarker` ignores `index.lock`; for the folder's own repository, 0.5.2's rule stays.
- Test: a snapshot killed by its deadline (the runner's timeout injected), then a Start that succeeds.

**Disk space and object count** (R-ENG):
- Before each clone of G, smurg checks free space with the upload rule of `files/disk.ts` (statfs `bavail`; the host's
  reserve, `diskReserveBytes` / `diskReservePercent`) against the bound's `bytes` of the last snapshot: not enough
  space → refused with `worktree.hidden.noSpace` {needed, free} (B.1). Clones of the folder's own repository keep
  0.5.2's behaviour.
- After a snapshot, when `git count-objects -v` reports more than 10,000 loose objects, smurg runs `git repack -A -d
  -q` on G in the same queue (`-A`: unreachable objects become loose rather than being dropped; smurg never runs
  `prune` or `gc`, and the clones' objects stay readable).
- **A cloud-synced folder**: when the share's realpath lies below `~/Library/Mobile Documents/`,
  `~/Library/CloudStorage/` or `~/Dropbox/`, the preflight says `cloudSynced: true` and the dialog shows
  `start.cloudSynced`: `.smurg/git` and every checkout are synced too, and a file kept only online can make the
  snapshot fail.

**Snapshots** (`snapshotFolder({ message, identity })`): verify, write the exclude file (nested repositories
included), the bound, `git add -A`, `git diff --cached --quiet` → no change: HEAD as it is; else `git commit -q
--no-verify -m <message>` as `identity`; then the repack rule. Messages (fixed English, one shared history): `smurg:
spec and plan of <slug>` + `Edited-by:` trailers (the checkpoint at Start, as the member who pressed Start), `smurg:
the shared folder for a new worktree` (as the member the worktree is for), `smurg: the shared folder before merging
<branch>` (as the host). Taken:
1. at Start (the checkpoint: it records the WHOLE folder, which the Start dialog says, `start.smurgHistory`);
2. before a new worktree (its base);
3. before the host approves a merge (then `pre` is that commit: `merge-tree --merge-base <base> pre item`; a person's
   edit since the item's base is a change on the main side, so a conflict is named and the folder is untouched;
   dirtyPaths is empty but for a race, which git refuses and `recoverFailedMerge` handles);
4. before `updateFromMain` of a worktree.
"Show the changes" (`diffMainPaths`) compares the working tree with blobs and needs no snapshot.

**Records say which repository.** `worktrees.json` worktree and merge `repo: 'smurg'` (absent: the folder's own `.git`,
which is what every 0.5.x record means); a pin's `history: 'smurg'`. Every operation on a record uses its
repository's `MainRepo` (`repoOf(record)`), whatever the folder is now. When the user's `.git` appears later: new
work uses it (and needs its first commit: `noCommit`, existing words); hidden records keep working with G until they
are released; G stays on disk (smurg never deletes it; the host guide says it can be removed once no work item or
merge request of it waits). An armed item, retried or not, whose pin's history cannot be used now is disarmed
`start-failed` with `plan.start.historyChanged` (D15 states the rule for every history).

**Clones.** `git clone --shared --no-checkout -- <G> <dir>` (the source is the git dir, not the share), after the disk
check; then as today (remote removed, branch at the base, shared links, pinned hashes). **The clone's exclude**
(R-ENG must-fix: `fs-ops.ts:115-127 writeExclude` writes only the shared-directory lines; the folder usually has no
`.gitignore`; the role prompt tells the agent to install dependencies, `prompts.ts:136`; `stage-commit.ts:308` runs
`add --all`; so `node_modules/` would be committed: more than `MERGE_FILES_MAX` files and no report registered, or a
merge refused by `untrackedInTheWay`): for a record with `repo: 'smurg'`, `writeExclude` writes the SAME lines as
`hiddenExcludeLines` (without `/.smurg/`, which is meaningless there), and it is rewritten before every stage-commit.
Test (D21): an item in a folder without `.git` runs `npm install` (the stand-in creates `node_modules/` with a few
files) and edits one file; the report's diff names only that file, and the merge succeeds while `node_modules/`
stays in the folder untouched.

**What the host sees**: `HostState.work.history = 'smurg'`; the Start dialog's lines `start.smurgHistory`,
`start.nestedRepos`, `start.cloudSynced`; the plan, the report, the diff and Merge as with a repository.
`smurgTracked` (0.5.2) applies to the folder's own repository only. **HOSTING §10.2 says** (both languages; R-SEC,
R-ENG): the history keeps every version of every file it recorded, secrets included, also after a file is deleted
from the folder; agents in worktrees can read that history through their own checkout; it only grows (smurg packs
it, never prunes it); `.smurg/git` can be removed by the host when no work item or merge request of it waits, and
the next Start makes a new one.

### D15. Without the git program: work items run directly in the shared folder

**When**: the git executable is not found, does not run, or is older than 2.42.0 (`binaryUnavailable`), whatever the
folder is. `HostState.work = { history: 'direct', reason: <worktree.unavailable.gitNotFound | gitCannotRun |
gitTooOld> }`. Worktree sessions are refused with the same sentence (as 0.5.2); topics, spec, plan work as in 0.5.2.

**Only the host starts them** (R-SEC must-fix: members with Agent access hold `session.create`, which starts work
items, `roles.ts`; without this rule, items could change the shared folder with no review and no undo and the host
would learn nothing before). `plan.start` with `direct: true` and `plan.item.retry` of an item whose pin says
`history: 'direct'` are refused to anyone but the host (`plan.start.directHostOnly`, reason `direct-host-only`). A
member's Start dialog shows the direct block with `start.direct.hostOnly` instead of the tick ("Without git, only the
host can start work items: they run directly in the shared folder.") and no Start button. Messages to a running
direct item's session (a follow-up, Continue) stay open to `session.drive` holders, like messages to any agent
session of the main workspace: the host started that item, and the hold below keeps one agent in the folder. (A
teammate's free agent session in the main workspace already changes the shared folder directly, with G11 and G12; what
is the host's here is starting a plan's items to run unattended.)

**Start** (`plan-service.ts`): not a blocker any more; the preflight says `history: 'direct'` and `direct.reason`,
`direct.hostOnly`; the host's dialog shows `start.direct.title` / `start.direct.body` {reason} and the tick
`start.direct.confirm`, and sends `direct: true`; without it `plan.start` is refused (`plan.start.directUnconfirmed`).
No checkpoint commit; the pin is `{ …hashes, history: 'direct', commit: null, specBlob: null, planBlob: null }`; the
scheduler's pin check compares the working tree's two files only.

**An item runs directly only because its own confirmed Start said so** (R-SEC must-fix: the pin check skips retried
items, `scheduler.ts pass()` `!item.retry`, and a retry re-arms the item with `startedBy` = whoever pressed "Try
again", `plan-service.ts retryItem`). The rule, in `scheduler.startItem` and tested:
- the direct branch runs only when `item.pin.history === 'direct'`; only a `plan.start` that carried `direct: true`
  writes that;
- an item whose pin history is `folder` (absent) or `smurg` starts only in a worktree of that repository; when that
  history cannot be used now (git missing or unusable, the folder's `.git` gone or changed, G refused), the item is
  disarmed `start-failed` with `plan.start.historyChanged`, on a first start, on Retry and on "Continue all" alike;
- this history check runs for EVERY armed item, retried ones included, before and outside the hash part of the pin
  check (which still skips retried items);
- stand-in tests: a retry of a worktree item after `gitPath` goes missing is refused with those words and nothing runs
  in the folder; a Start of a `smurg` item after `.smurg/git` was tampered is refused the same way.

**One agent holds the folder** (`topics/direct-folder.ts`, new: `DirectFolder`, used by the scheduler and by
AgentSessions; R-ENG: the first draft released the folder when the report was registered, but a follow-up from the
report, Continue or Retry runs later turns of that item's agent in the shared folder while the next item may run).
At most ONE direct item session of the workspace runs a turn at a time:
- the scheduler starts a direct item only when the folder is free and no session waits for it; that session holds the
  folder from the start of its first turn until the end of the turn after which its report is registered, or until it
  is stopped, fails or ends;
- every LATER turn of a direct item's session (a person's message, a report follow-up, Continue, the message of a
  Retry) needs the folder: `AgentRunner.send` asks its host `mayRunTurn(this)` before it writes a message to the
  process; while that is false the message stays in the runner's existing queue (delivery `queued`, as for a process
  that is starting), the session joins the folder's waiters, and its conversation gets the line
  `conversation.direct.waits` once ("This message waits: another work item is working in the shared folder. It is
  sent when that one is done."). When the folder is released, waiting sessions take it first, oldest first, before a
  queued item starts; the session holds it until that turn ends;
- free agent sessions of people are not held (as today); `maxLiveAgents` is not consulted for direct items (their
  limit is 1);
- the plan says `plan.item.queuedDirect` ("Waits its turn: without git, items run one at a time") for queued items.
Reasons: the agents of one folder would see each other's half-done work, a shell change is attributed to an agent
only while exactly one session has a command running (U3: locks/activity.ts:19-26), and edit locks last one tool call
(U3). Test: a follow-up to item 1 while item 2 runs is queued with the line, and is answered after item 2's turn ends
and before item 3 starts.

**The session** (`scheduler.startItem` direct branch): no worktree; `workspace: { mode: 'main' }`; root MAIN; the
stored item `direct: true`; role prompt `directExecutionRolePrompt` (D16); opening line
`conversation.started.itemDirect` {number}. The gate applies as to any main-workspace session (G7 keeps the spec and
plan away from its edit tools; G8 locks; G11 in auto). G11a and G12 do not ask here: only the host starts or retries a
direct item, so its session's `pathRights` is `host`.

**The report** (`report-service.ts`): the agent writes it where every item does, `specs/<slug>/reports/<item>.md`
(`topicReportPath`), but in the shared folder itself, where it is at once what a merged report is in the other modes
(R-ENG). It counts only when the agent's own `check_report` answered ok for exactly that content in this session
(the existing rule S21), so a person who edits the file before it is registered makes it not count (the agent is
asked to fix it, as today). It is registered without a snapshot; `noChanges: 'no-history'`; the item counts as merged
at registration (its changes are in the folder): what depends on it may start once the folder is free, the plan's
`waitsFor` and `plan.item.waitsDirect` say "Waits for … to finish"; when the report is reviewed the item is complete
and its session ends with `reason: 'reviewed'` (line `conversation.ended.reviewed`). Stop works as for worktree items;
Retry (the host's) and Continue go through the hold.

**What the guides say** (D20): no diff, no review before a change lands, no undo; only the host starts these items;
one agent in the folder at a time, later turns included; install git 2.42+ and share again to get worktrees.

### D16. Role prompts (fixed English, not catalogs)

Files: `packages/daemon/src/topics/prompts.ts`, `packages/daemon/src/sessions/agent/prompts.ts`. A role prompt is
written once per session (existing sessions keep theirs).
- Execution (worktree), replace the line "Editing files in your checkout needs no permission. Most commands need a
  person's permission and that person may be busy: run few, purposeful commands, and never one that only prints
  what you already know." by: "Editing files in your checkout needs no permission. A command may need a person's
  permission, or a safety check may refuse it: run few, purposeful commands, never one that only prints what you
  already know, and when one is refused, say in your answer why you need it instead of looking for another way
  around."
- The free session's prompt: the same sentence for its own wording of commands.
- `directExecutionRolePrompt` (new): as the execution prompt with these paragraphs instead of the checkout ones:
  "Your working directory is the shared folder itself: people and other agents work in it too, and smurg keeps no
  history of it. What you change is changed for everyone at once, and smurg cannot undo it. Work items run one at a
  time here. Do your item and nothing else." — "Do not use git in this folder." — "Nobody can see a diff of your
  work: under "What was done" in the report, name every file you created, changed or deleted." The line "This
  checkout is fresh: dependencies may be missing…" is left out.

### D17. The stand-in `claude` and the fake Anthropic API

**Stand-in** (`packages/daemon/src/testing/fake-claude.mjs`, its header documents every key; `fake-claude.ts` helpers):
- `--model <v>`: the current model. Scenario `models` (default: the five entries 2.1.288 answered, U1 E3, `default`
  → `claude-opus-5-5` … `haiku` → `claude-haiku-4-5-20251001` without `supportsAutoMode`); without `--model` the
  scenario's `defaultModel` (default `'claude-fake'`, as 0.5.2 tests expect). `init.model` = the resolved id; an
  `init` line at the start of EVERY turn (as 2.1.288 does, U4 H). `initialize.models` = the scenario's list.
- `set_model {model}` → success (or the scenario's `refuseSwitch: ['fable']` → error `restricted_by_org`); the next
  turn's `init` shows it. `get_settings` → `{ effective: {}, sources: [], applied: { model: <current resolved> } }`.
- `refuseModels: [...]`: a turn on such a model answers a synthetic assistant message (`model: '<synthetic>'`, `error:
  'model_not_found'`, the text of U1 E4) and a `result` with `is_error`.
- `--permission-mode auto`: unless the model has no `supportsAutoMode` or any settings say
  `permissions.disableAutoMode: 'disable'` (then `default`, silently). In auto: edit tools, read-only commands and
  `mkdir|touch|rm|rmdir|mv|cp|echo …>` with operands inside cwd run without a request; any other Bash goes to the
  stand-in's classifier: scenario `classifier: { block: ['<regex>', …] }` or a step's `"auto": "block"`: a block
  prints `system/permission_denied` (U4 B3 shape) and an error tool_result; the third block in a row becomes a
  `can_use_tool` with `decision_reason_type: 'classifier'` and the reason "3 consecutive actions were blocked. …".
  A PreToolUse hook's "ask" makes a `can_use_tool` in every mode (as today).
- `bypassPermissions`: when any settings file (flag, user) has `disableBypassPermissionsMode: 'disable'`, it runs in
  the flag settings' `defaultMode` (else `auto`), silently; `FAKE_CLAUDE_AS_ROOT=1` with bypass: stderr
  "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons", exit 1. In bypass
  nothing asks but AskUserQuestion and a hook's "ask".
- `set_permission_mode auto` on a model without auto → error `error_code: 'auto_mode_model'`; `bypassPermissions` when
  not launched in it → `error_code: 'bypass_not_launched'`; otherwise the `status` line as today.
- An initialize-only process (stdin closed after control requests) exits 0 without a turn (the probe).

**Fake API** (`packages/daemon/test/hooks/mock-anthropic.ts`, used by the real `claude` only):
- option `classifier(request) → { severity: number, category?: string } | 'garbage'` (default severity 5): a side
  request whose `system` starts with "You are a security monitor for autonomous AI coding agents." is answered as
  stage 1 (`max_tokens` 64, `stop_sequences ['</severity>']`: text `<severity>N`, `stop_reason: 'stop_sequence'`) or
  stage 2 (`<thinking>…</thinking><severity>N</severity><category>C</category>`) (U2 B);
- option `refuseModels: string[]`: a main request for such a model gets HTTP 404 `not_found_error` (U1 E4);
- records the `model` of every request (U1: it records none today).

### D18. The web app

Files under `apps/web/src/`: `lib/stores/host.ts` (HostState.agent, .work), `lib/stores/sessions.ts` (`setModel`,
`setMode(null)`), `lib/stores/topics.ts` (`setAgent`, `start` with agent/direct), `lib/stores/workspace.ts`
(publicSettings.permissionMode; `noteGitRepo` stays for isGitRepo), `features/agents/new-session.ts`,
`NewSessionDialog.tsx`, `features/conversation/HeaderStrip.tsx`, `cards.ts` (`modeLabel` for four values),
`PermissionCard.tsx` (gate `writes-host-only`), `rows.tsx` (notice action `choose-model`), `features/topics/
NewTopicDialog.tsx`, `StartDialog.tsx`, `start-model.ts`, `PlanColumn.tsx`, `PlanItems.tsx`, `ReportColumn.tsx`,
`TopicRules.tsx`, `features/console/SettingsSection.tsx`, `settings-form.ts`, `features/sidebar` (inbox row for
`agents-auto`), `app/workspace/TopBar.tsx` and `strings/workbench.ts`/`workbench.zh-TW.ts` (the "Asks for
nothing" badge), the merge store (its approve timeout), `ui/` (a select, if none fits); each feature's `strings.ts`
and `strings.zh-TW.ts`.

- **A model picker** (shared component `features/agents/ModelPicker.tsx`): "The host's default ({name})" (null; name =
  the entry whose `resolved` is `hostDefault`, else just "The host's default") and every listed model as
  "{name} · {description}"; while `modelsKnown` is false: `model.loading`, only the default. A chosen model with
  `billing: 'usage-credits'` shows `model.credits` under the picker.
- **A mode picker** (`features/agents/ModePicker.tsx`): "Workspace default ({mode})" (or "This topic's setting
  ({mode})" for a topic's item session) and the three choices with their labels; never "Asks for nothing". Under it,
  when the resulting mode is `auto`: `cost.auto`.
- **New session**: the two pickers under "Where to work"; the payload gets `model` and `permissionMode` when chosen.
  Worktree choices: offered unless `work.history === 'direct'`, or the viewer is a member while history is
  `unchecked` (D14: a teammate's request never makes smurg look for git); then the reason as the note
  (`worktree.unavailable.unchecked` for the second). For the host, `unchecked` offers them and the answer settles it,
  as 0.5.2's `noteGitRepo` hint did.
- **New topic**: the model picker ("Model of the discussion and the topic's work items").
- **Start dialog**: `history` decides the block: `folder` → today's commit lines; `smurg` → `start.smurgHistory`, and
  `start.nestedRepos` {paths} when `nestedRepos` is not empty, `start.cloudSynced` when `cloudSynced`; `direct` →
  `start.direct.title` + body + the required tick (Start stays disabled until ticked); for a member (`direct.hostOnly`)
  the title, the body and `start.direct.hostOnly` instead of the tick, and no Start button. The topic's settings:
  `start.agent.model` (picker), `start.agent.mode` (picker), `start.agent.note`; sent as `plan.start.agent` when
  changed. `start.rules.note` is shown for the ask modes; `start.rules.note.auto` when the items run in auto.
- **The strip** (`HeaderStrip.tsx`): the mode chip shows `modeInUse ?? permissionMode`; when `modeInUse` differs, a
  warning chip `mode.inUse` {mode} with the title of the fallback (`mode.fallback.*`); the model chip (new):
  `modelInUse`'s list name, else the chosen value, else "The host's default"; title `model.title` {name, id};
  click → the model dialog (`model.dialog`, the picker, `model.change.note`) for `session.drive` holders, read-only
  for others. The mode dialog: the mode picker with "Workspace default (…)" as the first choice; `mode.onlyDrive` as
  today; for the workspace's `ask-nothing`: the line `mode.workspaceAsksNothing`.
- **Notice action** `choose-model`: opens the model dialog of the session.
- **Console → Settings → Agents**: the select `settings.permissionMode` (four labels; `settings.permissionModeHint`;
  `cost.auto` under it); choosing "Asks for nothing" opens the confirmation dialog (`settings.askNothing.confirm.*`)
  and saves only after its button; disabled with `settings.askNothingRoot` when `asksNothing === 'root'`; the lines
  `settings.autoOff` / `settings.askNothingOff` when HostState says so; the banner `settings.agentsAuto.banner` with
  `settings.agentsAuto.dismiss` ("Got it", sends `admin.notice.seen`) while the host's inbox holds the attention item
  `agents-auto` (the page needs no other source: the item exists exactly while `hostNotices` holds the notice).
- **Plan column**: the foot note from `HostState.work` (`plan.direct.foot`); queued direct items `plan.item.queuedDirect`;
  `waitsFor` in direct `plan.item.waitsDirect`; the topic's agent settings in `TopicRules.tsx`
  ("Model and permission mode of this topic's work items", the two pickers, `topic.agent.set`).
- **Report column**: `noChanges: 'no-history'` → `report.noChanges.noHistory`.
- **Inbox**: attention `agents-auto` → `inbox.attention.agentsAuto`, opens console Settings.
- **"Asks for nothing" badge** (D13; every role): in `app/workspace/TopBar.tsx` beside the workspace name, while
  `publicSettings.permissionMode === 'ask-nothing'`: `workspace.asksNothing.badge`, title `workspace.asksNothing.title`.
- **Usage credits in the console** (R-SEC; no protocol change: the console has the session list and the model list):
  under the Agents settings, when one or more live agent sessions run on a model whose entry has `billing:
  'usage-credits'`, the line `settings.creditsSessions` {count, names} (the session titles, at most five, then "and N
  more").
- **Request timeouts** (D14): `plan.start`, `session.create` with a new worktree and `worktree.merge.approve` are sent
  with `timeoutMs: 300_000`.
- **A queued message of a direct item** (D15) shows the existing "queued" delivery state; the line
  `conversation.direct.waits` comes from the daemon.

### D19. The words

Every new or changed user-facing sentence is in Appendix B with its catalog id and both languages, checked against
`docs/GLOSSARY.md` (sentence case, no "please", second person, zh-TW full-width punctuation with a space between
Latin and Chinese, one message per sentence). The GLOSSARY changes:
- the row "The two permission modes" becomes "The permission modes": Auto: runs what a check allows / Asks before
  commands / Asks before edits and commands / Asks for nothing — 自動：檢查通過就執行 / 執行指令前先問 / 編輯和執行指令前都先問 /
  什麼都不問 — `auto` / `ask-commands` / `ask-all` / `ask-nothing`;
- the label "Auto: runs what a check allows" is defined there with what it covers (R-SEC: no sentence may say that
  every command is checked): "Claude Code decides: file edits and simple file commands inside the agent's folder run
  at once; every other command goes to Claude Code's check, a model's judgement, and runs when it allows it";
- new rows (a "Terms of 0.6.0" table): model / 模型; The host's default (a model) / 主人的預設; Workspace default (a
  mode) / 工作區預設; This topic's setting / 主題的設定; auto mode (prose) / 自動模式; Claude Code's check (its classifier,
  never "checks each command") / Claude Code 的檢查;
  smurg's own history (in .smurg) / smurg 自己的版本紀錄（在 .smurg 裡）; directly in the shared folder / 直接在分享的資料夾裡;
- the sentence "Not part of 0.5.0, so no word for them: … a permission mode that asks for nothing …" loses that item.

### D20. Docs and site

Every place of U2 §C and U5's list changes in both languages in the same change; the tests that hold them change on
purpose (D21). The new texts of the HELD sentences (test-held, quoted word for word):

| file | today (en) | 0.6.0 en | 0.6.0 zh-TW |
|---|---|---|---|
| `apps/site/public/index.html` third card; README.md "What it does" | "Every work item gets its own Claude Code session and git worktree; its agent asks before commands." | "Every work item gets its own Claude Code session and git worktree; Claude Code's auto mode decides which of its commands run." | 「每個工作項目有自己的 Claude Code session 和 git worktree；由 Claude Code 的自動模式決定它的哪些指令可以執行。」 |
| `docs/SECURITY-MODEL.md` (held by site.test.ts:1260) | "smurg asks before almost every command (§5.2), except where your own allow rules apply (§5.3)" | "Agents run in Claude Code's auto mode unless you choose to be asked: Claude Code decides which commands run (simple file commands in the agent's own folder at once, the others after its check), and smurg itself still asks before a few (§5.2); your own allow rules apply (§5.3)" | 「除非你選擇要被問，agent 都以 Claude Code 的自動模式執行：由 Claude Code 決定哪些指令可以執行（agent 自己資料夾裡的簡單檔案指令直接執行，其他的先經過它的檢查），smurg 自己仍會在少數幾種指令前先問（§5.2）；你自己的允許規則也適用（§5.3）」 |
| `docs/HOW-IT-WORKS.md` step 3 | "…It edits files there without asking and asks before almost every command" | "Work. Each work item gets its own agent, in its own git worktree (smurg's own history when the folder has none). In auto mode, the default, it edits files there and runs commands without asking: simple file commands at once, the others when Claude Code's check allows them (what it asks first)." | 「工作：每個工作項目有自己的 agent，在自己的 git worktree 裡工作（資料夾沒有 git 時，用 smurg 自己的版本紀錄）。預設的自動模式下，它在裡面改檔案、執行指令都不用先問：簡單的檔案指令直接執行，其他的在 Claude Code 的檢查允許後執行（什麼要先問）。」 |
| `docs/QUICKSTART.md` prerequisite | "…a project folder that is a git repository with at least one commit" | "…and a project folder (with git installed, work items get worktrees and diffs; which versions: host guide §1)" | 「……以及一個專案資料夾（裝了 git，工作項目才有 worktree 和 diff；需要哪些版本：主人指南 §1）」 |
| `docs/QUICKSTART.md` step 10 | "Before almost every command, an agent asks…" | "Start the work. Press "Start 3 items" …, read the dialog, then press "Start". Agents run in auto mode: Claude Code's check decides which commands run; file edits and simple file commands in an agent's own folder run without it. When an agent asks (a card "Claude asks for permission to run a command" in your inbox), read the command, then press "Allow once" or "Deny"." | 「開始工作：按「開始 3 個項目」……，讀過對話框的說明，再按「開始」。agent 以自動模式執行：由 Claude Code 的檢查決定哪些指令可以執行；agent 在自己資料夾裡改檔案和簡單的檔案指令，不經過這道檢查。agent 來問你時（收件夾裡叫「Claude 請求許可執行指令」的卡片），先讀指令，再按「允許一次」或「拒絕」。」 |
| `README.md` quick start 2 | "Share a project folder that is a git repository with at least one commit:" | "Share a project folder:" | 「分享一個專案資料夾：」 |
| `docs/JOINING.md` §5.4 lead | "Outside its own worktree, and for almost every command, an agent must ask first." | "Agents run in auto mode unless someone chose a mode that asks: Claude Code decides which commands run (simple file commands in the agent's own folder at once, the others after its check). An agent asks first when its mode says so, when smurg's own check asks (§5.4 below), and after its check refused three commands in a row." | 「除非有人選了會先問的模式，agent 都以自動模式執行：由 Claude Code 決定哪些指令可以執行（agent 自己資料夾裡的簡單檔案指令直接執行，其他的先經過它的檢查）。agent 會在這些時候先問：它的模式要它問、smurg 自己的檢查要它問（見下文），以及它的檢查連續擋下三個指令之後。」 |
| `docs/HOSTING.md` §1 bullet | "To let agents carry out work items, the folder you share must be a git repository …" | "Work items run in worktrees, with a diff you review and merge, when this computer has git 2.42 or later. A folder without `.git` works too: smurg keeps its own history of it in `.smurg` (§10.2). Without git, work items run one at a time directly in the folder, with no diff and no undo (§10.2)." | 「這台電腦有 git 2.42 以上的版本時，工作項目會在 worktree 裡執行，產生你可以檢視、合併的 diff。沒有 `.git` 的資料夾也可以：smurg 會在 `.smurg` 裡保存它自己的版本紀錄（§10.2）。沒有 git 時，工作項目會一次一個直接在資料夾裡執行，沒有 diff，也無法復原（§10.2）。」 |
| `docs/HOSTING.md` §5.2 | "There is no mode that asks for nothing." | (gone; the four modes are listed, below) | (同) |

**HOSTING §5.1** (the risks of sharing agents; both languages; R-SEC) gains two sentences: members with agent access
can choose a model that bills usage credits on some plans, and Claude Code does not ask before it bills one in an
agent session (the console lists the sessions that run on such a model); in auto mode, a command of any agent
session, a teammate's included, that reaches outside the shared folder runs when Claude Code's check allows it
(§5.2 says where smurg still asks).

**HOSTING §5.2** is rewritten around the four modes (the heading stays; it is linked): its bullets become — the
discussion agent (unchanged); **the permission modes** (the table of D3 in prose; who chooses which, D12; the default
auto; what auto does not check, D10's list word for word in substance; the cost line); **in a worktree** (fast path
covered by the diff and the merge; what reaches outside the worktree is not); **in the main workspace** (G11's two
cases; what lands at once); **a teammate's session outside its folder** (G12; only what smurg can read in the
command); **what holds in every mode** (D8a: the places, and that the rules refuse edit tools and commands that NAME
those places, not a command that reaches them another way); **"Asks for nothing"** (the warning's words, host only,
not as root, the badge and the start line, what still holds: D8a, smurg's deny rows, a discussion writes only its
spec and plan, no subagents, no `@path`); **when the mode that runs differs** (the strip's warning, the fallbacks, the
console line); then the existing bullets, with "No agent changes Claude Code's own settings … or anything in `.git`"
qualified to what holds: "smurg refuses an agent's edits of Claude Code's settings (yours and the project's), of
`.git` and of smurg's own files, and commands that name them; a command that reaches them another way is decided by
Claude Code's check in auto mode, and runs in Asks for nothing". The paragraph "Requests only you can allow" says it
applies to what still asks (G11a, G12, and the cards of the ask modes). The paragraph "Permission requests" keeps its
words, opened by "When an agent asks (its mode asks, smurg's check asks, or Claude Code's check refused three commands
in a row)". The audit bullet: "…every command that ran without a request, also one that failed (the entry names the
mode)".

**HOSTING §5.3**: a sentence on `autoMode` rules in `~/.claude/settings.json` (they apply), on `disableAutoMode` /
`disableBypassPermissionsMode` (they turn the modes off; the console says so), and that smurg passes no
`CLAUDE_CODE_*` variables to agents. **§8** (troubleshooting): the rows "Start is refused: …not a git repository…",
"git was not found…", "…version 2.39.5…", "git does not run…" are rewritten: without `.git` Start works with smurg's
own history; without git Start says items run directly (what to do to get worktrees: unchanged commands); new rows for
`worktree.hidden.tooLarge`, `worktree.hidden.changed`, `notice.modelRefused`, `notice.autoUnavailable.*`, the auto
check refusing everything ("Auto mode could not evaluate this action…": choose "Asks before commands" for the
session). **§9.2**: the 0.6.0 paragraph (D13). **§9.3** (setting a document aside): setting `worktrees.json` aside also means
moving `.smurg/git` out of the shared folder before the next Start (D14). **§10.1**: the host settings list gains the workspace's mode. **§10.2**
keeps its heading "Start: git, and the commit smurg makes" (docs and the site link it); its first bullet ("Work
items need git") becomes three: with a repository (as today), without `.git` (D14: smurg's own history, the size
bound and its words, what is excluded, nested repositories, cloud-synced folders, that the history keeps every version
of every file, secrets included, and agents in worktrees can read it, `.smurg/git` stays and when it can be removed),
without git (D15: only the host starts items, one agent in the folder at a time). **§10.3**: the direct items' "nothing waits for a
merge". **§10.8** (what was verified): models and modes against the stand-in and the fake API; the classifier only
with the fake API's answers; no real account.

**JOINING**: §5.4 (lead above; the bullets gain smurg's G11 sentence), §6 steps 6-7 (Start: the three histories in one
sentence each; Execution: "edits files and runs the commands its check allows without asking (§5.4)"), §7 (worktrees
from smurg's own history), the strip paragraph ("what it may do without asking (for example "Auto: runs what a check
allows"; …)"). **README.md** (en/zh): quick start 2, "What it does" third item, the picture's alt text (below),
"How it is built" ("the agents and their worktrees"). **QUICKSTART**, **HOW-IT-WORKS**, **SECURITY-MODEL**: the
rows above; SECURITY-MODEL's "No agent is sandboxed" bullet as in the table. **GLOSSARY**: D19. **ARCHITECTURE**: §0
rule 8 (the owner's exception, below), §3 "Who decides" (D12), §4.3 (protocol 5), §5.5, §5.8, §5.9, §5.10, §5.11
(new messages and fields: Appendix A), §7.1 (state shapes 2, the two steps, the hidden repository's files, the probe's
folder), §7.6 ("Never `--model`" lines 2371, 2776 and 4334 go; launch flags; the settings rule; the probe; D9),
§7.6 also D8a (the deny rules beyond the folder and why), §7.7 (G11 and G12 in the table; G10 not in `ask-nothing`),
§7.8 (D14, D15), §11 (new D-25 auto default and the owner's
upgrade exception; D-26 smurg's own history; D-27 direct mode; D-28 models chosen per session), §12 (known limits:
the hidden history grows and keeps deleted files; a Claude Code deny-rule refusal audited as a failed command; the
model list is the latest `initialize`; auto's checks are a model's judgement; the deny rules refuse only commands
that name a place; another item's checkout has no rule (G12 asks for a teammate's item); G11 and G12 see only
commands smurg can read). **ACCEPTANCE**: rows T4.1, T4.2, S3, S4, S5, R9 rewritten; new
rows for D7, D8–D11, D14, D15 with their tests. **apps/web/README.md:1297**, **docs/DEVELOPMENT.md:119**: four modes.
**CHANGELOG** 0.5.0's "Agents ask before they run commands" stays (history).

ARCHITECTURE §0 rule 8 gains: "One step sets a value on the open side, by the owner's decision of 2026-10-20 (0.6.0):
workspaces and agent sessions of 0.5.x follow the new default, auto mode, at the update; the host is told by
`smurg host` and in the console (DECISIONS 2). Every other step gives a new security-relevant value its closed side."
CONTRIBUTING's step rule names the same exception.

**The site and the README picture** (DECISIONS: no new line on the home page; the third card and the Build scene
change only as far as the truth requires): the third card as in the table. The picture's Build scene (index.html of
both languages, the `in2` scene): the permission card of item 2 (`m-perm`: "Claude asks for permission to run a
command", `pnpm add stripe`, "Allow once" pressed by Ben, "Allowed once by Ben") and its badge swap ("Waiting for
permission", "Claude is waiting for permission") are replaced by one tool row `Ran` `pnpm test` (`a-rise t03`); the
three cards stay "Running". Reason: under auto, asking before `pnpm add stripe` is not what a work item's agent does
(the auto-mode defaults do not cover "installing agent-chosen package names", U4 defaults file, so it may run or be
refused, never "asked"); a test run in the item's own worktree is what auto runs. The aria-label (both pages, and the
README's alt): en "…Build: three agents work side by side, one per work item, each in its own worktree; one runs the
project's tests. …"; zh-TW "…實作：三個 agent 並排工作，每個工作項目一個，各自在自己的 worktree；其中一個執行了專案的測試。…".
`apps/site/README.md` ("What the agents are seen doing needs no request … the one command in the picture is asked
for first. Keep it so") becomes: "What the agents are seen doing is what auto mode runs without a request in a work
item's own worktree (host guide §5.2): reading, editing and creating files, and running the project's tests. A scene
that shows a request must show a session whose mode asks." `PICTURE_QUOTES` (tests/lint/docs-quotes.test.ts) loses
the permission card's labels and gains `conversation.tool.run` ("Ran"). Then `node scripts/readme-picture.ts` writes
the four files (`scripts/readme-picture.ts` scene words, `words.zh-TW.ts`).

### D21. Tests

"Unit" = pure functions; "stand-in" = daemon integration with the stand-in `claude`; "smoke" = the web smokes in
Chrome with the stand-in; "SEA" = the opt-in suites of the built executable; "real" = the opt-in suite with the real
`claude` 2.1.288 against the fake API (ARCHITECTURE §0 rule 2: isolated HOME and CLAUDE_CONFIG_DIR from
`claude-harness.ts`, dummy key, never a real account).

| decision | proof |
|---|---|
| D1 | fixtures.test (no file of no kind: the stamp and the kept copy have kinds), opens.test (0.5.1, 0.5.2 open with no step), other-version.test over the four fixtures and wire.test on v0.5.2, pin unchanged |
| D2 | constants.test (5), version-refused.test (protocol 4 → `version`), wire.test says "raised", web `status.ts` tests for the two cut-off views stay green, `smurg --version` says v5 (sea.test); ctl-other-version.test: one WELCOME sample per protocol, a 0.6.0 attach meeting a protocol-4 answer and a 0.5.2 command meeting a protocol-5 answer both end at once with the B2 words; SEA: sea-upgrade.test runs every OLD executable once more on the upgraded folder (0.5.1/0.5.2: "Run smurg update. Nothing was changed."; 0.4.0/0.5.0: their own refusal; the workspace state folder byte for byte) |
| D3/D4/D5 | protocol: entities/topics/handshake/inbox schema tests for every new field and refine (the preflight's `nestedRepos`, `cloudSynced`, `direct.hostOnly`); registry.test (new messages: capability, checks, dir); message-samples.fixture (a sample of every new message); worst-case.test (HostState with 32 long models fits the limits); tools.test (`effectivePermissionMode` table, `isLooserMode`); i18n catalog.test (every new id in both languages, parameters alike); plan-service: a Start refused at the checkpoint leaves the topic's agent settings unchanged |
| D6 | state-steps.test: a 0.5.0/0.5.1/0.5.2 state.json → version 2, `permissionMode: 'auto'`, `hostNotices: ['agents-auto']`, every member/device/invite carried; 0.4.0 → chain (two steps ran); the kept copies `.before-upgrade-from-0.5.0`; a put-back of a 0.5.0 file in a shapes-2 folder is reported as put back; agent-sessions step table (discussion, main free ask-all default, main free loosened, worktree tightened ask-all kept with modeChangedBy, item default) and `model: null`; opens.test UPGRADES (0.5.x: state and agent-sessions upgraded); fixtures.test with NOT_PUBLISHED_YET (points of documents without a step only) and the new `shapeWrittenBy` (0.5.1, 0.5.2 → the frozen v0.5.0 shape); pin.test (shapes 2, frozen v0.5.0 hash); set-aside.test (unchanged cases, plus: a set-aside `worktrees.json` with a `.smurg/git` → `worktree.hidden.unknown`); unfinished.test parametrized over the 0.4.0 AND the 0.5.2 fixture (a kill between `state.json` and `agent-sessions.json`); refusals.test and set-aside.test cases that expected "a 0.5.0 folder upgrades nothing" now expect the 0.5.0 step; other-version.test: v0.5.2's daemon refuses this tree's folder with "Run smurg update. Nothing was changed.", this tree opens v0.5.2's and upgrades it |
| D7 | unit: claudeArgsFor/checkLaunchArgs with `--model` (valid, invalid, duplicate, `--model` without value); the probe's flags pass `checkLaunchArgs`; `AgentModels` mapping (drops `default`, `auto`, `billing` for every Fable spelling, bad entries); normalise: `error_code` kept, bad ones dropped; stand-in: model on start and on resume (echo argv), none when null, `session.model.set` live (control in echo, next `init` → `modelInUse`), parked session's next start, `model-offered` refusals (unknown list, not offered), `restricted_by_org` → `session.model.refused`, refused model → `notice.modelRefused` with action and no agent text and no turnError, substituted → `notice.modelSubstituted`, probe (private cwd, list and `hostDefault` in HostState, one probe at a time, 60 s after a failure, a daemon stop during a probe that never answers leaves no process), topic model → discussion and items, retry keeps the model, the model in the audit of session.create, topic.create, topic.agent, plan.start; real R1: `--model sonnet` start and `--resume`, init model, `set_model haiku` → next turn's init, a model the fake API refuses → the notice; real R7: the probe's exact flags with a SessionStart hook in the isolated user settings: no `/v1/messages`, the hook did not run, no transcript or project entry under the isolated HOME, nothing of its process group left |
| D8 | unit: `claudeModeFor` table (4 modes × 2 roots × 3 purposes × 3 fallbacks), `buildSessionSettings` (disable key present unless bypass, `defaultMode` auto for bypass), `checkLaunchArgs` (auto ok; bypass only with option; the dangerous flags refused), `checkSessionSettings` (also a file with one D8a rule missing → refused); stand-in: workspace switch to ask-nothing restarts following sessions at idle with bypass and no disable key, back to auto applies live; `auto_mode_model` and `bypass_not_launched` take their branches by `code`; `admin.settings.set ask-nothing` refused as root (uid injected); topic mode applies to following items only; `session.mode.set null` → follows, line |
| D8a | unit (profiles, settings-writer): every rule of D8a's table for each purpose × root, none for a discussion, `CLAUDE_CONFIG_DIR` honoured, a home with `[` escaped; share.test: a share inside `~/.claude`, `~/.ssh` or `CLAUDE_CONFIG_DIR` refused with `inside-agent-config`; real R2 (a work item in auto) and R5 (a main session in bypass): R-SEC's nine writes (`exp/reach.mjs`): main `.git/hooks`, main `.claude/settings.json`, `.smurg/git` ref, host `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, `~/.claude/settings.local.json` by `~`, a file in `~/.smurg`, smurg's executable stand-in: refused; the session's own edits and commands pass |
| D9 | stand-in: auto + haiku → started with acceptEdits in a worktree (default + daemon edits in main), `modeInUse: 'ask-commands'`, `modeFallback: 'model-no-auto'`, notice once; auto + `disableAutoMode` in the fake home's settings → `auto-off`, HostState `autoMode: 'off'`; bypass + disable → `ask-nothing-off`; a looser reported mode is set back; set_model to haiku in auto → fallback at once, back to sonnet → auto; real R5 (bypass starts in bypassPermissions with smurg's settings; with the host's own `disableBypassPermissionsMode` it runs in auto and smurg says so) and R6 (haiku + auto → smurg's fallback) |
| D10 | unit (tool-gate.test, bash-gate.test): G11a ask for a member session writing `CLAUDE.md` / a folder holding one, pass for the host's session; G11b deny while a person types, the sentence names them; G12 ask (host-only) for a member's item writing `~/x`, the main folder's `README.md` or another checkout, pass for `/tmp/x` and `$TMPDIR/x`, pass for the host's sessions; unsure per `GATE_ASKS_WHEN_UNSURE`; no G11 in a worktree, no G11/G12 in ask modes or in ask-nothing; G10 skipped in ask-nothing; deny rule `.smurg/**` in main-root profiles; stand-in: G11 and G12 cards are host-only; real R3 (`echo x >> CLAUDE.md` in a member's main-workspace session in auto → a card; `rm notes.md` while a person holds the lock → refused; `echo x >> ~/notes.txt` from a member's work item → a card) and R4 (the unsure evidence) |
| D11 | stand-in: a failed unasked command → `agent.command` outcome `error` with `mode`; a classifier block → line + `agent.command.blocked` and no `agent.command`; three blocks → a card; a gate denial → no `agent.command`; real R2 (worktree item in auto: `echo > f` runs with no classifier call, `python3 -c …` runs after severity 5, severity 90 → refused, line, audit; three in a row → card) |
| D12 | membership.test: a member's looser choice goes back with `conversation.mode.reset`, a stricter one stays, topic level too; a member's credits-billed model goes back to the host's default with `conversation.model.reset`, another model stays; plan-service: `plan.start` direct and `plan.item.retry` of a direct item refused to a member with Agent access |
| D13 | cli unit (host-state-words.test): `agentsAutoNotice` for upgraded state from 0.4.0 and 0.5.0, not otherwise; `asksNothingNotice` at a start whose workspace mode is `ask-nothing`, not otherwise; `host.upgraded` names the stamp's writer; daemon: attention `agents-auto` for the host only, gone after `admin.notice.seen` or a `permissionMode` setting; SEA: sea-upgrade.test with 0.4.0, 0.5.0, 0.5.1, 0.5.2 → the two lines, kept copies, stamp shapes 2 |
| D14 | worktree unit with the real git on PATH (≥ 2.42; skipped loudly otherwise): lazy creation (nothing before the first Start dialog), crash-safe creation (a kill between record and rename: the next ensure starts anew; leftovers `git.new-*` removed), `.smurg/git` with no record → `worktree.hidden.unknown`, a record and no G with open records → `worktree.hidden.gone`, an empty `.git` directory keeps `notAGitRepo` and gets no G, `core.worktree` unset, plain `git rev-parse` in the folder fails, `hiddenExcludeLines` (every host-private sample ignored at the top and nested, node_modules, a shared dir), snapshot+clone+commit+merge with a person's edit kept, conflict named and folder untouched, a write between snapshot and merge recovered, the size bound refusal (files and bytes) before anything is written, a listing over 4 MiB read whole, tamper refused (config, HEAD, a link, alternates, `info/grafts`, `shallow`, `refs/replace/x`), a moved branch tip → the recorded base differs → refused, a stale `index.lock` removed, a snapshot killed by its deadline then a Start that succeeds, the disk check refusal (statfs injected), repack after many loose objects (unreachable objects kept), a nested repository excluded and named, the user's `git init && git add -A` adds nothing of `.smurg`, records with `repo: 'smurg'` keep merging after `.git` appears while new work uses `.git` (and needs its commit); topics stand-in: plan.test's no-git case now starts (was the `notAGitRepo` blocker), the preflight's `history: 'smurg'`, `nestedRepos`, `cloudSynced` (a share path under a fake `~/Library/CloudStorage`), an item that runs `npm install` (stand-in creates `node_modules/`) and edits one file: the diff names only that file and the merge succeeds with `node_modules/` untouched, a teammate's worktree request while `unchecked` → `worktree.unavailable.unchecked` and no git run; SEA: sea-git-while-sharing.test updated (a folder without `.git` Starts with smurg's history; `git init` + commit while sharing switches new work to it) |
| D15 | topics stand-in with `gitPath` pointing to a missing and to an old git: preflight `direct` + reason, `hostOnly` for a member, `plan.start` without `direct` refused with the words, a member's `plan.start` direct refused, the host's with it: item session in MAIN, no worktree, direct prompt, one at a time (the second queued until the first is done), report `no-history`, dependents start after `done`, review ends the session with `reviewed`; the pin check ignores HEAD; a follow-up to item 1 while item 2 runs is queued with `conversation.direct.waits` and answered before item 3 starts; a retry of a WORKTREE item after `gitPath` goes missing is disarmed with `plan.start.historyChanged` and nothing runs in the folder |
| D16 | prompts.test: the new sentences, the direct prompt |
| D17 | fakes.test: every new stand-in behaviour (models, set_model, refuse, `error_code` on control errors, auto fast path and classifier and three blocks, bypass with and without the disable key, root, get_settings, set_permission_mode errors, initialize-only exit); mock-anthropic tests for the classifier answers and the 404 |
| D18 | web unit en and zh-TW: pickers (loading, default name, credits line, cost line), New session payload, New topic, Start dialog (three histories, the tick gates Start, the member's host-only block, nested repositories, cloud-synced line, agent settings), strip (model chip, mode chip, the warning chip and its title), mode dialog (follow first, no ask-nothing), console (select, confirm dialog with the new words, root disabled, off lines, banner and Got it, the credits sessions line), plan foot and queued direct, report no-history, inbox row, the "Asks for nothing" badge for every role, the long timeouts of the three requests; smoke (stand-in): flow.smoke and its zh-TW twin: the workspace starts in auto, a work item runs `pnpm test` with no card, a classifier block shows its line, one session switched to "Asks before commands" shows a card that a member with agent access allows, a model chosen in New session reaches the stand-in (`--model` in its echo) and the strip shows it; console.smoke: the host switches to "Asks for nothing" through the warning, a member's page shows the badge, and back; topics.smoke: a folder without `.git` starts items (smurg's history) and the report shows a diff |
| D19 | i18n tests (catalog parity), tests/lint (no CJK outside zh-TW files, docs in step, docs-quotes) |
| D20 | docs-quotes.test (new quotes of the four labels in HOSTING and JOINING; worktree.unavailable rows of §8 rewritten), site.test (the third card's words, SECURITY-MODEL's held sentence, `git 2.42 or later` still in the guide), readme.test, readme-picture.test (regenerated), guide-anchors.test (the new CLI-printed anchor); a lint check that no catalog text, doc or changelog line of 0.6.0 says "checks each command" / "檢查每一個指令" |
| D22 | release-checks.test (0.6.0 sections in both changelogs, eight package.json at 0.6.0); the gate with `SMURG_RELEASE_GATE=1`, `SMURG_PREVIOUS_BINARIES` (four), `SMURG_SEA_BINARY`; real R8: the agent overwrites its own `--settings` file mid-turn and, seconds later, the gate's deny and a deny rule still hold in the same process (R-SEC's `exp/reload.mjs`) |

**Existing tests that change on purpose** (U2 §C, U5 counts, R-ENG; each change says why in its commit, and each is
in the Do list of the step that changes it, BUILD-PLAN):
- protocol 4 pinned: `packages/cli/test/main.test.ts:90, 95`; `packages/protocol/test/exports.test.ts:44`;
  `packages/protocol/src/constants.test.ts:164`; `tests/e2e/test/workspace.test.ts:31`; `packages/cli/test/sea.test.ts:73`
  (S1);
- the control socket: `packages/cli/test/ctl-other-version.test.ts:586-610` (one WELCOME per protocol, D2) (S1);
- the upgrade harness: `test/upgrade/persisted.ts` (kinds in S0, `shapeWrittenBy` in S1); `refusals.test.ts:179,
  208` and `set-aside.test.ts:266` (they expect that a 0.5.0 folder upgrades nothing); `state-steps.test.ts:66` (ran
  `['0.4.0']`); `unfinished.test.ts` (parametrized over 0.5.2 too) (S1);
- the in-memory fakes `packages/daemon/src/core/fakes/` (`sessions.ts:66`, `topics.ts:239`, `agents.ts:308` call
  `defaultPermissionMode`; they implement `AgentStartInput.mode`, `setMode`, and later `setModel`, `MainState`,
  `workState`): S1 for the contract, then the step that changes each interface;
- the pin's source hashes (`pin.test.ts:73-160` hash `sessions/session-manager.ts`, `core/config.ts`, `tools.ts`,
  `schema/**`): every step that edits a hashed file answers the pin's question ("this changes no stored shape", or
  the shape and its step) and rewrites the hashes with `SMURG_PIN_WRITE=1` (S1, S3, S4, S5);
- the modes: `packages/protocol/src/tools.test.ts:36` (defaultPermissionMode → effectivePermissionMode);
  `message-samples.fixture.ts:1171`; daemon `agent-pure.test.ts:248, 260, 286, 296` (modes; `--model` now allowed);
  `settings-writer.test.ts:21, 44, 103, 108`; `agent-wire.test.ts:169, 474`; `agent-more.test.ts:393`;
  `agent-sessions.test.ts:106`; `conversation/permissions.test.ts:20, 433` (main-edit rule reads `modeInUse`);
  `membership.test.ts:46, 106` (D12); `fakes.test.ts:305`; `agent-claude-real.test.ts:290, 584` (the session under test
  sets `ask-commands` where it tests cards); `claude-e2e.test.ts` (passes `acceptEdits`: keeps it, plus the new auto
  cases); `integration/release-flow.members.test.ts:46, 315`; `topics/scheduler.test.ts` (items' mode); web
  `ConversationColumn.test.tsx:680`, `PlanColumn.test.tsx:148`; smokes `flow.smoke.test.ts:1041, 1491, 1549` (+
  zh-TW, `flow.claude.smoke`): S4 changes them minimally when its flip to auto makes them fail (the sessions they test
  are set to ask), S6 builds on that; `tests/e2e t.topic-flow.test.ts:374-644` and `r2.agent-role.test.ts` (the cards
  they wait for come from sessions set to ask, or from G10/G11/G12);
- no git: every test that expects `worktree.unavailable.notAGitRepo` for a folder WITHOUT `.git` (U5: 11 files;
  `packages/daemon/test/topics/plan.test.ts:373-388` first) now expects smurg's history; `versioned: false`
  (6 files) keeps its value but no longer decides Start; the `gitNotFound`/`gitTooOld`/`gitCannotRun` Start
  refusals become the direct-mode preflight;
- the docs tests named in D20.

### D22. Release

- **Version**: 0.6.0 in all eight `package.json`; `smurg --version` → `smurg 0.6.0 (protocol v5, …)`.
- **CHANGELOG** (`CHANGELOG.md`, `docs/zh-TW/CHANGELOG.md`, the heading `## [0.6.0] - <date of the release>`):
  Appendix B.6 has both texts.
- **RELEASING.md**:
  - §4 step 3 is split: (a) a release that keeps `PROTOCOL_VERSION`: as today (deploy first, then tag);
    (b) a release that raises it (0.6.0): **tag first** (step 4), let the workflow build and make the GitHub
    release (steps 5, 6), then deploy the relay from the tagged commit with `--keep-assets <the v0.5.2 web build>`
    and `--check`, and publish (step 7) right after, without a pause: hosts of 0.5.x are cut off from browsers from
    the deploy until they update, and 0.6.0 is installable a few minutes later, at the end of the upload (U5 option
    b). Never deploy before the release's executables have passed step 6. The release notes say "update before you
    share again (`smurg update`)".
  - §4.5: `SMURG_PREVIOUS_BINARIES` lists 0.4.0, 0.5.0, 0.5.1, 0.5.2 (step 1 and 5; "Every later release adds the
    executable of the version before it"); step 2: `protocol v5`; the real-Claude suite lists the new files (D21:
    R1–R8 in `test/sessions/models-claude-real.test.ts` and `test/sessions/modes-claude-real.test.ts`) and its new
    count; the fake API's classifier is named; "What a release owes the tests": after 0.6.0 is published its fixture
    is made (it must hold every point of NOT_PUBLISHED_YET), TAG moves to v0.6.0.
  - The Claude Code version: verified stays **2.1.288** (`CLAUDE_VERIFIED_VERSIONS`, `CLAUDE_MIN_VERSION` unchanged; no
    newer binary is downloaded). ARCHITECTURE §11 D-23 lists what to run again when a newer one is verified (U4
    changelog): 2.1.293 (the `haiku` alias becomes Haiku 5.5: its `supportsAutoMode`, D9's fallback, the list),
    2.1.296 ("Not run" rows: new stream shapes for a call auto could not check: normalise.ts), 2.1.299 (after
    `set_model` to a model without auto, Claude Code moves the session to `default`: D9 must agree, a `status` line
    arrives), 2.1.301 (the `fable` alias may retry on the previous Fable model: D7's substituted notice),
    2.1.302 (`-p` without a mode starts in Manual: smurg always passes the mode; `CLAUDE_CODE_AUTO_MODE_MODEL`;
    server-side classifier compaction), 2.1.304 (`/auto-mode-setup`). And, for EVERY newer version, whatever its
    changelog says (R-SEC): that the `--settings` file is not reloaded mid-session (an agent can read and overwrite its
    own launch file: D8a's state-folder rule refuses a command that names it, R8 proves the process keeps the rules it
    started with); that absolute deny rules still refuse Bash commands naming the path, in auto and in bypass (D8a);
    that the fast path still covers only the agent's own folder (D10). The suite of §4.5 (with R1–R8) is the check.
- **ACCEPTANCE.md**: the rows of D20; "How to run the gate" counts updated after the gate runs.
- **docs/design/v0.6.0/** (optional, the lead decides): DECISIONS.md and this DESIGN.md as the record, with a README
  like v0.5.0's (the folder is exempt from the CJK lint).

---

## 3. Security review

What changes in the trust model (ARCHITECTURE §2), said as it is (R-SEC asked for no stronger words than measurement
supports):
1. **Commands run without a person by default.** In 0.5.2 a person read almost every command. In 0.6.0 auto, Claude
   Code decides: its fast path runs file edits and simple file commands inside the agent's folder with NO check, and
   its classifier (a model's judgement on the messages and the commands, not their output) decides the rest.
   Prompt injection through a teammate's file is more likely to run. What holds in every mode, `ask-nothing`
   included: the deny rules of D8a and of the session's own folder (they refuse edit tools on those places and
   commands that NAME them; a command that reaches them another way is not refused by them); smurg's deny rows
   (G2–G9); a discussion writes only its spec and plan. What holds in auto: G10 near confirmed scripts; G11 in the
   main workspace; G12 for a teammate's writes outside its folder (G11 and G12 see only what smurg can read in a
   command); the merge review for what an item changes in its own worktree. Outside the shared folder, a command of
   the host's own sessions, and an unreadable one of a teammate's, runs when Claude Code's check allows it. The guides
   say all of this in both languages (D10, D20), and the owner's decision is recorded (ARCHITECTURE §0 rule 8, §11
   D-25).
2. **Work items reach beyond their folder.** In 0.5.2 a worktree session's write outside its folder asked a person; in
   auto it does not. D8a's rules close the places that keep smurg's and Claude Code's own guarantees (the main folder's
   config and smurg's history, the host's Claude Code settings and ssh folder, smurg's state and executable). G12 asks
   the host for a teammate's item. Another item's checkout has no rule (it lies beside the session's own folder): a
   write there by the host's own item shows in that item's diff before any merge.
3. **The update opens existing workspaces.** The step sets auto on 0.5.x workspaces (the owner's decision); the host
   is told three ways (D13); a person's stricter session choice stays (D6).
4. **"Asks for nothing"** is the host's, workspace-wide, behind a warning that says what still holds and no more. It
   launches only after four checks: the session's mode, the workspace setting read again, not root, and the settings
   file's own check, which also requires D8a's rules. It never uses `--allow-dangerously-skip-permissions`, so a session
   can only become bypass at a fresh start; tightening is immediate. While it is on, every member sees a badge and the
   host gets a line at every start. The workspace's mode lives in `state.json`, which has no MAC: D8a refuses agents'
   commands that name `~/.smurg`, and the start line shows a mode the host did not set.
5. **The model** is a member's choice (Agent access), from the host's own list. A model that may bill usage credits
   says so where it is chosen. The console lists the sessions that run on one, the audit records every choice, and a
   departing member's such choice goes back to the host's default. The host restricts models only through their own
   Claude Code settings (`availableModels`), which smurg reflects in the list (U1 E5).
6. **smurg's own history** adds `.smurg/git`. It is created crash-safely and refused when it has no record, which
   rules out a planted repository. D8a's rules protect it from every session. The integrity check pins config and
   HEAD and refuses redirection, grafts, `shallow` and replace refs. The merge uses the base the review recorded, and
   its hooks are off. It excludes host-private files at any depth (generated from the lists), so a checkout never holds
   `.envrc` or the host's personal Claude Code files. It keeps every past version of what it recorded, and agents in
   worktrees can read that history: HOSTING §10.2 says so.
7. **Direct mode** removes review before a change lands. Only the host starts it, after the dialog's required tick.
   An item runs directly only if its own Start said so. One agent holds the folder at a time, later turns included.
   The report and the guides say all of this.
8. **The probe** runs Claude Code with hooks disabled (R7 proves the host's own user hooks do not run, or the probe is
   not shipped), no MCP servers, user settings only, a private empty folder, no `--model`, and never sends a model
   request; the daemon's stop awaits it.
9. **The audit** records every command that ran without a request, failed ones included, with the mode; auto's
   refusals have their own entry; every model choice names the model.
10. **What 2.1.288 is relied on for** (re-checked with every newer version, D22): the `--settings` file is read once
    (R8); absolute deny rules refuse Bash commands naming the path in auto and bypass; the fast path stays inside the
    agent's own folder.

## 4. Risks

- R-1 The classifier's behaviour against the REAL API is not tested (no account, ARCHITECTURE §0 rule 2): the
  server-side classifier path (U2 "arbiter") never ran here. Mitigation: the guides say it is a model's judgement;
  the owner tries it after the release (as for 0.5.0).
- R-2 G11's and G12's `unsure` rule depends on R4's evidence; the constant is ready for either answer, and the guides
  say what an unreadable command can do either way.
- R-3 2.1.288 keeps auto after `set_model` to a model without auto mode; smurg sets the fallback itself (D9). A newer
  Claude Code changes this (2.1.299): D22's re-check list.
- R-4 The fixtures of 0.5.1/0.5.2 need a driver nobody kept for 0.5.0; it is the biggest single piece of S0.
- R-5 The hidden history's first snapshot of a big folder is slow (U3: 10.9 s for 676 MB). The warm-up at the Start
  dialog, the 4-minute deadline and the page's 5-minute timeout keep it inside one Start; a folder over the bound is
  refused with words; each checkout costs its full size on disk, which the disk check guards.
- R-6 Direct mode's one-agent hold can make a plan slow, and later turns of an item wait for the folder; it is the
  honest default (attribution, no half-done work), and the lead may want a host setting later.
- R-7 `smurg status` cannot say the mode or the history in 0.6.0 (its answer did not change): the console does, and
  `smurg host` prints the "Asks for nothing" line.
- R-8 The model list is visible to every member (prices included); harmless, but new.
- R-9 The probe depends on R7: if the host's own user hooks run under `disableAllHooks`, the probe is dropped and the
  model list appears only after a session has started.
- R-10 Deny rules are not a boundary (they refuse only commands that name a place); that is said, but a host who reads
  only "Asks for nothing"'s warning may still overestimate them.
- R-11 The size of the change: R-ENG estimated 27–38 builder-days before the review's additions; with them, about
  31–43 (BUILD-PLAN). S4 and S5 carry the risk.

## 5. Left for the lead or the owner

For the lead (the design took a side in each; each can be changed without touching the rest):
1. **G12** (a teammate's shell writes outside its own folder ask the host, in auto). The design keeps it, because it
   keeps a promise 0.5.2's guide made ("Only the host can allow this"). Without it, the guides say that a teammate's
   commands outside the folder are decided by Claude Code's check.
2. **Direct mode is the host's** (only the host starts or retries direct items), rather than a host notice that then
   lets members start them.
3. **Direct mode's hold** covers every turn (later turns of an item wait for the folder), rather than holding the
   folder until the report is reviewed.
4. **G11's and G12's unsure rule** (`GATE_ASKS_WHEN_UNSURE = false` unless R4 shows the fast path takes such commands).
5. **The size bound and the default excludes** (1 GB, 50,000 files; `node_modules/`, `.venv/`, `__pycache__/`,
   `.DS_Store`, plus the generated host-private names).
6. **The places of D8a**: the design adds the host's `~/.ssh` (0.5.2's host-only home folders were `.smurg`, `.claude`,
   `.ssh`) and not the shell's startup files or `~/.gitconfig` (Claude Code treats those as protected paths; G12 asks
   for a teammate's).
7. Whether the host may choose "Asks for nothing" for one session only (the design: workspace-wide only, as decided).
8. Keeping a person's stricter mode at the update (the design keeps it).
9. The picture's Build scene (a test run instead of a permission card).
10. Whether DESIGN.md and DECISIONS.md go into `docs/design/v0.6.0/`.

For the owner (decided already, named here only so that nothing surprises them at the release):
- The update switches every 0.5.x workspace to auto (their decision 2); the start line and the console say so.
- With these deny rules, an agent cannot write to the host's `~/.claude` or `~/.ssh` by naming them, also when the
  host chose "Asks for nothing". A host who wants an agent to change their own Claude Code settings does it
  themselves.
- The real classifier and the server-side check were never run (no account): R-1.

---

## Appendix A. The wire diff (protocol 5), in one place

`packages/protocol/src/schema/primitives.ts`, `limits.ts`: `modelIdSchema`, `MODEL_ID_MAX_CHARS 256`,
`AGENT_MODELS_MAX 32`, `MODEL_DESCRIPTION_MAX_CHARS 512`, `PREFLIGHT_NESTED_REPOS_MAX 20`.

`entities.ts`:
- `PERMISSION_MODES` (4), `SESSION_MODE_CHOICES` (3), `MODE_FALLBACKS`, `HOST_NOTICES = ['agents-auto']`,
  `WORK_HISTORIES`, `agentModelSchema`, `agentHostStateSchema`, `workStateSchema`;
- `publicSettingsSchema` + `permissionMode` (so `hostSettingsSchema`, `hostSettingsPatchSchema` have it);
- `agentSessionSchema`: `permissionMode` (4 values), + `modeChoice`, `modeInUse?`, `modeFallback?`, `model`,
  `modelInUse?`; refines of D3;
- `hostStateSchema` + `agent`, `work`;
- `SESSION_END_REASONS` + `reviewed`; `AUDIT_ACTIONS` + `session.model`, `topic.agent`, `agent.command.blocked`;
- comments of `workspaceInfoSchema.isGitRepo`.

`topics.ts`: `topicSchema` + `agent { model, permissionMode }` (and `versioned`'s comment); `NO_CHANGES_REASONS` +
`no-history`; `startPreflightSchema` + `history`, `direct` (with `reason`, `hostOnly`), `agent`, `nestedRepos`,
`cloudSynced`.

`conversation.ts`: `NOTICE_ACTIONS` + `choose-model`; `PERMISSION_GATE_REASONS` + `writes-host-only`, `writes-outside`
(and, added after the build's review, `writes-unknown`).

`inbox.ts`: `ATTENTION_SUBJECTS` + `agents-auto`; `inboxKindWaits` false for it; `CONSOLE_SECTIONS` unchanged
(`settings` exists).

`messages/sessions.ts`:
```ts
sessionCreatePayloadSchema (agent) = { kind: 'agent', workspace, title?, firstMessage?, model?: modelIdSchema, permissionMode?: sessionModeChoiceSchema }
sessionModeSetPayloadSchema = { sessionId, mode: sessionModeChoiceSchema.nullable() }
sessionModelSetPayloadSchema = { sessionId, model: modelIdSchema.nullable() }   // result agentSessionResultSchema
```
`messages/topics.ts`:
```ts
topicCreatePayloadSchema = { name, slug?, firstMessage?, model?: modelIdSchema }
topicAgentSetPayloadSchema = z.strictObject({ topicId, model: modelIdSchema.nullable().optional(), permissionMode: sessionModeChoiceSchema.nullable().optional() })
  .refine((p) => p.model !== undefined || p.permissionMode !== undefined, 'nothing to set')   // result topicResultSchema
planStartPayloadSchema = { …as today, agent?: z.strictObject({ model?: modelId|null, permissionMode?: choice|null }), direct?: z.literal(true) }
```
`messages/admin.ts`: `adminNoticeSeenPayloadSchema = { notice: z.enum(HOST_NOTICES) }`, result `{}`.

`registry.ts`: `'session.model.set'` (c2d, session.drive, checks agent-session, session-open, model-offered),
`'topic.agent.set'` (c2d, session.drive, checks topic-open, model-offered), `'admin.notice.seen'` (admin);
`HANDLER_CHECKS` + `model-offered`; `topic.create`, `session.create`, `plan.start` get `model-offered` in their checks.
No capability changes: `plan.start` with `direct: true` and `plan.item.retry` of a direct item check "the caller is the
host" in the handler (reason `direct-host-only`), as the D15 rule is about the folder's state, not a role.

Not on the wire (stored only, D6): `worktrees.json` `hidden`, merge `base`, `repo`; agent record `modelChangedBy`.

`tools.ts`: `effectivePermissionMode`, `isLooserMode`; `defaultPermissionMode` removed.

`constants.ts`: `PROTOCOL_VERSION = 5`.

## Appendix B. The words (English / Traditional Chinese)

B.1 Wire catalog (`packages/protocol/src/i18n/messages/`), file in brackets.

| id | en | zh-TW |
|---|---|---|
| `permissionMode.auto` [conversation] | Auto: runs what a check allows | 自動：檢查通過就執行 |
| `permissionMode.askNothing` [conversation] | Asks for nothing | 什麼都不問 |
| `permissionMode.askCommands`, `.askAll` | unchanged | unchanged |
| MODE_PHRASES `auto` | runs what a check allows | 檢查通過就執行 |
| MODE_PHRASES `ask-nothing` | asks for nothing | 什麼都不問 |
| `conversation.mode.followed` {by, mode} | {by} set the permission mode back to the default: {mode} | {by} 把權限模式改回預設：{mode} |
| `conversation.mode.workspace` {mode} | The host changed the workspace's permission mode: {mode} | 主人變更了工作區的權限模式：{mode} |
| `conversation.mode.topic` {by, mode} | {by} changed the permission mode of this topic's work items: {mode} | {by} 變更了這個主題的工作項目的權限模式：{mode} |
| `conversation.model.changed` {by, model} | {by} changed the model: {model} | {by} 變更了模型：{model} |
| `conversation.model.default` {by} | {by} set the model back to the host's default | {by} 把模型改回主人的預設 |
| `conversation.autoMode.blocked` {reason} | Claude Code's check stopped a command: {reason} | Claude Code 的檢查擋下了一個指令：{reason} |
| `conversation.started.itemDirect` {number} | Work item {number} started directly in the shared folder, without git | 工作項目 {number} 已經直接在分享的資料夾裡開始，沒有 git |
| `conversation.ended.reviewed` | The result was reviewed. This work item is complete | 結果已經看過，這個工作項目完成了 |
| `conversation.model.reset` {name} | The model is back to the host's default: {name}, who chose it, was removed or lost agent access | 模型已恢復為主人的預設：選擇它的 {name} 已被移出或失去 agent 使用權 |
| `conversation.direct.waits` | This message waits: another work item is working in the shared folder. It is sent when that one is done | 這則訊息在等待：另一個工作項目正在分享的資料夾裡工作，等它完成後才會送出 |
| `notice.modelRefused` {model} | Claude Code could not use the model {model} on the host's account: it may not exist, or the account may not have access to it. Choose another model for this session. | Claude Code 無法在主人的帳號上使用模型 {model}：它可能不存在，或這個帳號不能使用它。請為這個 session 選擇其他模型。 |
| `notice.modelSubstituted` {model, inUse} | Claude Code runs this session on {inUse}, not on {model}: the host's Claude Code settings decide which models may be used. | Claude Code 用 {inUse} 執行這個 session，而不是 {model}：可以用哪些模型，由主人的 Claude Code 設定決定。 |
| `notice.autoUnavailable.model` {model} | Auto mode is not available for {model}. This session asks before commands until it runs on another model. | {model} 不能使用自動模式。在換成其他模型之前，這個 session 執行指令前會先問。 |
| `notice.autoUnavailable.settings` | Claude Code did not start this session in auto mode: the host's Claude Code settings turn it off. This session asks before commands. | Claude Code 沒有用自動模式啟動這個 session：主人的 Claude Code 設定把它關掉了。這個 session 執行指令前會先問。 |
| `notice.asksNothingRefused` | Claude Code did not let this session run without asking: the host's Claude Code settings do not allow it. The session runs in auto mode. | Claude Code 沒有讓這個 session 什麼都不問就執行：主人的 Claude Code 設定不允許。這個 session 改用自動模式。 |
| `session.model.notKnown` [sessions] | smurg does not know yet which models the host's Claude Code offers. Try again in a moment. | smurg 還不知道主人的 Claude Code 提供哪些模型。請稍後再試。 |
| `session.model.notOffered` {model} | The host's Claude Code does not offer the model {model}. | 主人的 Claude Code 沒有提供模型 {model}。 |
| `session.model.refused` {model} | Claude Code refused to switch to {model}: the host's Claude Code settings or account do not allow it. | Claude Code 拒絕換成 {model}：主人的 Claude Code 設定或帳號不允許。 |
| `settings.asksNothing.root` [errors] | Claude Code does not run agents without asking while smurg runs as the root user. Share the folder as your own user. | smurg 以 root 身分執行時，Claude Code 不會讓 agent 什麼都不問就執行。請用你自己的使用者帳號分享資料夾。 |
| `plan.start.directUnconfirmed` [topics] | Without git, work items change the shared folder directly. Confirm that in the Start dialog first. | 沒有 git 時，工作項目會直接改動分享的資料夾。請先在開始對話框裡確認這一點。 |
| `plan.start.directHostOnly` [topics] | Without git, only the host can start work items: they run directly in the shared folder. | 沒有 git 時，只有主人能讓工作項目開始：它們會直接在分享的資料夾裡執行。 |
| `plan.start.historyChanged` [topics] | How smurg keeps this folder's history changed since Start. Look at the plan and start the item again. | 從按下開始到現在，smurg 保存這個資料夾版本紀錄的方式變了。請看過計畫，再重新開始這個項目。 |
| `worktree.hidden.tooLarge` {size, files, maxSize, maxFiles, largest} [worktrees] | The shared folder holds {size} in {files} files, more than smurg copies into a checkout for each work item ({maxSize} and {maxFiles} files at most). The largest: {largest}. List large folders in a .gitignore or as shared directories in the host console, or make the folder a git repository yourself. | 分享的資料夾有 {files} 個檔案、共 {size}，超過 smurg 會為每個工作項目複製一份的上限（最多 {maxSize}、{maxFiles} 個檔案）。最大的是：{largest}。請把大的資料夾寫進 .gitignore，或在主人主控台設成共用目錄，或自己把資料夾變成 git 儲存庫。 |
| `worktree.hidden.changed` [worktrees] | smurg's own history of this folder (.smurg/git) was changed by something other than smurg, so worktrees cannot be used. The host moves .smurg/git out of the shared folder: smurg starts a new history at the next Start, and the merge requests that wait cannot be merged any more. | smurg 為這個資料夾保存的版本紀錄（.smurg/git）被 smurg 以外的程式改動了，所以無法使用 worktree。請主人把 .smurg/git 移出分享的資料夾：下次按開始時 smurg 會重新建立版本紀錄，還在等的合併請求就不能再合併了。 |
| `worktree.hidden.unknown` [worktrees] | The shared folder holds a .smurg/git that this workspace has no record of (its record was set aside, or another workspace of this folder made it), so worktrees cannot be used. The host moves .smurg/git out of the shared folder: smurg makes a new history at the next Start. | 分享的資料夾裡有一個這個工作區沒有紀錄的 .smurg/git（它的紀錄被移到旁邊了，或是這個資料夾的另一個工作區建立的），所以無法使用 worktree。請主人把 .smurg/git 移出分享的資料夾：下次按開始時，smurg 會重新建立版本紀錄。 |
| `worktree.hidden.gone` [worktrees] | smurg's own history of this folder (.smurg/git) is gone, so the work items and merge requests made from it cannot go on: reject them. The next Start makes a new history. | smurg 為這個資料夾保存的版本紀錄（.smurg/git）不見了，所以從它建立的工作項目和合併請求無法繼續：請拒絕它們。下次按開始時會建立新的版本紀錄。 |
| `worktree.hidden.noSpace` {needed, free} [worktrees] | There is not enough free disk space for another work item's worktree: it needs about {needed}, and {free} is free beyond the disk reserve. Free some space, or list large folders in a .gitignore. | 磁碟空間不夠再建立一個工作項目的 worktree：大約需要 {needed}，扣掉保留的空間後只剩 {free}。請空出一些空間，或把大的資料夾寫進 .gitignore。 |
| `worktree.unavailable.unchecked` [worktrees] | smurg has not checked git on the host's computer yet. Once the host has opened a topic's Start dialog or created a worktree, you can create one. | smurg 還沒在主人的電腦上檢查 git。等主人打開過一個主題的開始對話框，或自己建立過一個 worktree，你就可以建立了。 |

`worktree.unavailable.gitNotFound`, `gitTooOld`, `gitCannotRun` keep their words (they are `HostState.work.reason` now);
`worktree.unavailable.notAGitRepo` keeps its words (it is said only for a `.git` that git does not take).

B.2 Web catalogs (`apps/web/src/features/*/strings.ts` and `strings.zh-TW.ts`).

| id (feature) | en | zh-TW |
|---|---|---|
| `model.label` (agents) | Model | 模型 |
| `model.hostDefault` {name} | The host's default ({name}) | 主人的預設（{name}） |
| `model.hostDefault.unknown` | The host's default | 主人的預設 |
| `model.option` {name, description} | {name} · {description} | {name} · {description} |
| `model.loading` | Asking the host's Claude Code which models it offers… | 正在詢問主人的 Claude Code 提供哪些模型… |
| `model.unavailable` | The host's Claude Code could not be asked which models it offers. Sessions use the host's default. | 無法詢問主人的 Claude Code 提供哪些模型。session 會使用主人的預設。 |
| `model.credits` | On some plans this model is billed to usage credits, and Claude Code does not ask first here. | 在某些方案上，這個模型會從用量額度扣款，而且 Claude Code 在這裡不會先問。 |
| `cost.auto` | Auto mode checks commands with extra requests to Claude, which may count toward the host's usage. | 自動模式會多送請求給 Claude 來檢查指令，可能算進主人的用量。 |
| `mode.follow.workspace` {mode} (agents) | Workspace default ({mode}) | 工作區預設（{mode}） |
| `mode.follow.topic` {mode} | This topic's setting ({mode}) | 主題的設定（{mode}） |
| `new.model` (agents) | Model | 模型 |
| `new.mode` | What it may do without asking | 不用問就能做的事 |
| `newTopic.model` (topics `new.model`) | Model of the discussion and the topic's work items | 討論和這個主題的工作項目使用的模型 |
| `start.smurgHistory` (topics) | The folder has no git repository of its own. smurg records the folder as it is now in its own history (in .smurg, not a .git of yours), and each item starts from that. | 這個資料夾沒有自己的 git 儲存庫。smurg 會把資料夾現在的樣子記在它自己的版本紀錄裡（在 .smurg 裡，不是你的 .git），每個項目都從這裡開始。 |
| `start.direct.title` | Without git: work items change the folder directly | 沒有 git：工作項目會直接改動資料夾 |
| `start.direct.body` {reason} | {reason} Work items run one at a time in the shared folder itself, where people work too. There is no diff to review before a change lands, nothing waits for a merge, and smurg cannot undo a change. To work in worktrees, install git 2.42 or later and share again. | {reason}工作項目會一次一個，直接在分享的資料夾裡執行，大家也在這個資料夾裡工作。改動生效之前沒有 diff 可以看，沒有東西會等合併，smurg 也無法復原任何改動。要在 worktree 裡工作，請安裝 git 2.42 以上的版本，再重新分享。 |
| `start.direct.confirm` | I understand that these changes land in the shared folder directly | 我了解這些改動會直接寫進分享的資料夾 |
| `start.direct.hostOnly` | Without git, only the host can start work items: they run directly in the shared folder. | 沒有 git 時，只有主人能讓工作項目開始：它們會直接在分享的資料夾裡執行。 |
| `start.nestedRepos` {paths} | These folders are git repositories of their own, and work items do not see them: {paths}. To work in one, share that folder. | 這些資料夾各自是一個 git 儲存庫，工作項目看不到它們：{paths}。要在其中一個裡工作，請分享那個資料夾。 |
| `start.cloudSynced` | This folder is synced by a cloud service: smurg's history in .smurg and every work item's worktree are synced too, and a file kept only online can make Start fail. | 這個資料夾由雲端服務同步：smurg 在 .smurg 裡的版本紀錄和每個工作項目的 worktree 也會被同步，只存在雲端的檔案可能讓開始失敗。 |
| `start.agent.model` | Model for these items | 這些項目使用的模型 |
| `start.agent.mode` | What their agents may do without asking | 它們的 agent 不用問就能做的事 |
| `start.agent.note` | Both are the topic's settings: its later items use them too. | 這兩項是主題的設定：這個主題之後的項目也會用。 |
| `start.rules.note.auto` | Everything else goes through Claude Code's check. | 其他的都要經過 Claude Code 的檢查。 |
| `plan.direct.foot` | Without git, work items run one at a time directly in the shared folder; nothing waits for a merge. | 沒有 git 時，工作項目會一次一個直接在分享的資料夾裡執行；沒有東西要等合併。 |
| `plan.item.queuedDirect` | Waits its turn: without git, items run one at a time | 等輪到它：沒有 git 時，項目一次只跑一個 |
| `plan.item.waitsDirect` {items} | Waits for {items} to finish | 等 {items} 完成 |
| `topic.agent.title` | Model and permission mode of this topic's work items | 這個主題的工作項目的模型和權限模式 |
| `report.noChanges.noHistory` | Without git, smurg keeps no history: this item changed the shared folder directly, and there is no diff to show. Its conversation and the activity feed show what its agent did. | 沒有 git 時，smurg 不保存版本紀錄：這個項目直接改動了分享的資料夾，沒有 diff 可以顯示。它的 agent 做了什麼，可以看它的對話和動態。 |
| `model.title` {name, id} (conversation) | Model: {name} ({id}) | 模型：{name}（{id}） |
| `model.dialog` | Model of this session | 這個 session 的模型 |
| `model.change.note` | A change applies from the agent's next turn. | 變更會從 agent 的下一輪開始生效。 |
| `mode.inUse` {mode} | Claude Code runs it as: {mode} | Claude Code 實際用的是：{mode} |
| `mode.fallback.model-no-auto` | The model of this session cannot use auto mode. | 這個 session 的模型不能使用自動模式。 |
| `mode.fallback.auto-off` | The host's Claude Code settings turn auto mode off. | 主人的 Claude Code 設定把自動模式關掉了。 |
| `mode.fallback.ask-nothing-off` | The host's Claude Code settings do not allow running without asking. | 主人的 Claude Code 設定不允許什麼都不問就執行。 |
| `mode.workspaceAsksNothing` | The host lets this workspace's agents ask for nothing. You can choose a stricter mode for this session. | 主人讓這個工作區的 agent 什麼都不問。你可以為這個 session 選擇更嚴格的模式。 |
| `card.gate.writes-host-only` (conversation) | smurg asks because this command changes a file only the host may change, and in auto mode nothing else would ask before it runs. | smurg 會先問，是因為這個指令會改到只有主人能改的檔案，而在自動模式下，沒有其他檢查會在它執行前先問。 |
| `card.gate.writes-outside` (conversation) | smurg asks because this command of a teammate's session writes outside its own folder, and in auto mode nothing else would ask before it runs. | smurg 會先問，是因為組員的 session 的這個指令會寫到它自己資料夾以外的地方，而在自動模式下，沒有其他檢查會在它執行前先問。 |
| `card.gate.writes-unknown` (conversation; added after the build's review) | smurg asks because it cannot tell where this command of a teammate's session writes, and in auto mode it could run with no check at all. | smurg 會先問，是因為它看不出組員的 session 的這個指令會寫到哪裡，而在自動模式下，這個指令可能完全不經過檢查就執行。 |
| `notice.action.choose-model` | Choose a model | 選擇模型 |
| `settings.permissionMode` (console) | What agents may do without asking | agent 不用問就能做的事 |
| `settings.permissionModeHint` | The default of every agent session and work item of this workspace. You and members with agent access can choose another mode for a topic or a session, except Asks for nothing. A topic's discussion only reads code and writes its spec and plan. | 這個工作區每個 agent session 和工作項目的預設。你和可使用 agent 的成員可以為一個主題或一個 session 選擇其他模式，但不能選「什麼都不問」。主題的討論只會讀程式碼、寫自己的 spec 和計畫。 |
| `settings.askNothing.confirm.title` | Let agents ask for nothing? | 要讓 agent 什麼都不問嗎？ |
| `settings.askNothing.confirm.body` | Every agent session of this workspace will run every command as you, on your computer, with no sandbox and no check by Claude Code or smurg, whoever's message or file led to it: a teammate's message, a file someone changed, a web page the agent read. What still holds: a discussion agent writes only its spec and plan, and smurg refuses an agent's edits of Claude Code's settings (yours and the project's), of .git, of your .ssh folder and of smurg's own files, and commands that name those places. A command that reaches them another way runs as you. Choose this only for a folder and a team you trust completely. | 這個工作區的每個 agent session 都會以你的身分、在你的電腦上執行每一個指令，沒有沙盒，Claude Code 和 smurg 都不檢查，不論是誰的訊息或哪個檔案讓它這麼做：組員的訊息、有人改過的檔案、agent 讀到的網頁都一樣。仍然有效的只有：討論用的 agent 只寫自己的 spec 和計畫；smurg 會拒絕 agent 編輯 Claude Code 的設定（你的和專案的）、.git、你的 .ssh 資料夾和 smurg 自己的檔案，也會拒絕指名這些地方的指令。用其他方式碰到它們的指令，會以你的身分執行。只有對這個資料夾和團隊完全信任時才選這個。 |
| `settings.askNothing.confirm.go` | Ask for nothing | 什麼都不問 |
| `settings.askNothingRoot` | smurg runs as the root user: Claude Code does not run agents without asking then. | smurg 正以 root 身分執行：這時 Claude Code 不會讓 agent 什麼都不問就執行。 |
| `settings.autoOff` | Claude Code on your computer turns auto mode off (your Claude Code settings or your organization's): agents ask before commands instead. | 你電腦上的 Claude Code 把自動模式關掉了（你的 Claude Code 設定或組織的設定）：agent 改成執行指令前先問。 |
| `settings.askNothingOff` | Claude Code on your computer does not allow running without asking (your Claude Code settings or your organization's): agents run in auto mode instead. | 你電腦上的 Claude Code 不允許什麼都不問就執行（你的 Claude Code 設定或組織的設定）：agent 改用自動模式。 |
| `settings.agentsAuto.banner` | Since smurg 0.6.0, agents run in auto mode: Claude Code's check decides which commands run without asking you, and file edits and simple file commands inside an agent's own folder run without that check. To be asked before commands again, choose "Asks before commands" below. | 從 smurg 0.6.0 起，agent 以自動模式執行：由 Claude Code 的檢查決定哪些指令不用問你就執行，agent 在自己資料夾裡改檔案和簡單的檔案指令則不經過這道檢查。想要執行指令前再先問，請在下面選「執行指令前先問」。 |
| `settings.agentsAuto.dismiss` | Got it | 知道了 |
| `inbox.attention.agentsAuto` (sidebar) | Agents now run in auto mode | agent 現在以自動模式執行 |
| `workspace.asksNothing.badge` (workbench) | Agents ask for nothing | agent 什麼都不問 |
| `workspace.asksNothing.title` (workbench) | The host lets this workspace's agents run commands as the host with no check by Claude Code and no question from smurg; only smurg's fixed limits stay. | 主人讓這個工作區的 agent 以主人的身分執行指令，Claude Code 不檢查，smurg 也不會先問；只剩 smurg 固定的限制。 |
| `settings.creditsSessions` {count, names} (console) | Agent sessions on a model that may be billed to usage credits ({count}): {names} | 使用可能從用量額度扣款的模型的 agent session（{count} 個）：{names} |

B.3 CLI catalog (`packages/cli/src/i18n/en.ts`, `zh-TW.ts`; ASCII in English).

| id | en | zh-TW |
|---|---|---|
| `host.agentsAuto` | `\nAgents now run in auto mode: Claude Code's check decides which commands run without asking; file edits and simple file commands in an agent's own folder run without it. To be asked before commands again, choose "Asks before commands" in the host console's settings. Guide: https://smurg.ai/docs/hosting/#52-what-agents-do-by-themselves-and-what-they-ask-first` | `\nagent 現在以自動模式執行：由 Claude Code 的檢查決定哪些指令不用先問就執行；agent 在自己資料夾裡改檔案和簡單的檔案指令，不經過這道檢查。想要執行指令前再先問，請在主人主控台的設定裡選「執行指令前先問」。說明：https://smurg.ai/zh-TW/docs/hosting/#52-agent-自己能做什麼什麼要先問` |
| `host.asksNothing` (new; every start while the workspace asks for nothing, D13) | `\nAgents here ask for nothing: every command runs as you, with no check by Claude Code and no question from smurg (only smurg's fixed limits stay). To change it, choose another mode in the host console's settings. Guide: https://smurg.ai/docs/hosting/#52-what-agents-do-by-themselves-and-what-they-ask-first` | `\n這個工作區的 agent 什麼都不問：每一個指令都以你的身分執行，Claude Code 不檢查，smurg 也不會先問（只剩 smurg 固定的限制）。要改，請在主人主控台的設定裡選其他模式。說明：https://smurg.ai/zh-TW/docs/hosting/#52-agent-自己能做什麼什麼要先問` |
| `host.upgraded` | unchanged words; `from` = the stamp's writer when known | 同 |
| `host.folder.insideConfig` {folder} (new; D8a) | `smurg host does not share {folder}: it lies in your Claude Code settings or your .ssh folder, and every member would get them. Share a project folder instead.` | `smurg host 不分享 {folder}：它在你的 Claude Code 設定或 .ssh 資料夾裡，每個成員都會拿到它們。請改為分享一個專案資料夾。` |

B.4 Fixed English for agents (not catalogs; `hooks/deny-text.ts`): `BASH_ASK_REASONS.writesHostOnly` = "smurg asks:
this command writes a file only the host may change, and nothing else asks before it runs in auto mode.";
`HOOK_DENY_REASONS.bashWhileTyping(names, path)` = "Refused by smurg: <names> is typing in <path>. Wait for the lock
with mcp__smurg__wait_for_lock, then try again, or leave that file alone." (names joined with ", ", "are" for several);
`BASH_ASK_REASONS.writesOutside` (G12) = "smurg asks: this command writes outside your own folder, and in auto mode
only the host may allow that for a session a teammate opened or started." (The conversation module recognises the
G11 and G12 cards by these exact texts, as it does G10's.)

B.5 Docs: the held sentences are in D20's table; every other paragraph is written in both languages by the docs step
following the GLOSSARY, reviewed against this design.

B.6 CHANGELOG 0.6.0.

English:

```
## [0.6.0] - YYYY-MM-DD

- **Choose the model.** The host and members with agent access choose an agent session's model from the list the
  host's Claude Code offers, Fable included: when they open a session or a topic, at Start for a topic's work items,
  and later in the session's strip, where a change applies from the agent's next turn. The strip shows the model
  Claude Code really runs. A session nobody chose a model for runs on the host's own Claude Code default, as before.
  On some plans Fable is billed to usage credits, and Claude Code does not ask first in an agent session; the
  dialogs say so ([host guide](docs/HOSTING.md) §5.2).
- **Agents run in auto mode.** The new permission mode "Auto: runs what a check allows" is the default of every
  agent session and work item: Claude Code's check decides which commands run without asking anyone (file edits and
  simple file commands inside the agent's own folder run without it), and what it stops is shown in the
  conversation. Its checks can count toward the host's usage.
  Workspaces shared with an earlier smurg switch to auto at the update: `smurg host` says so in one line, and the
  host console's settings say how to be asked again. "Asks before commands" and "Asks before edits and commands"
  stay, for the workspace, a topic or a session ([host guide](docs/HOSTING.md) §5.2).
- **In the main workspace, two shell commands still wait for a person in auto mode**: one that changes a file only
  the host may change, in a session a teammate opened (only the host can allow it), and one that writes a file
  someone is typing in (refused until they stop) ([host guide](docs/HOSTING.md) §5.2).
- **A teammate's session asks before it writes outside its own folder** in auto mode, when smurg can read where the
  command writes: only the host can allow it ([host guide](docs/HOSTING.md) §5.2).
- **In every mode, smurg refuses what no agent should change**: an agent's edits of Claude Code's settings (yours and
  the project's), of `.git`, of your `.ssh` folder and of smurg's own files, and commands that name those places, also
  from a work item's worktree ([host guide](docs/HOSTING.md) §5.2).
- **The host can let agents ask for nothing**, for the whole workspace, in the host console's settings and behind a
  warning: every command then runs as the host with no sandbox and no check, and only the refusals above stay. Every
  member sees that the workspace asks for nothing, and `smurg host` says so at every start ([host
  guide](docs/HOSTING.md) §5.2).
- **Work items without a git repository.** A shared folder without `.git` no longer stops Start: smurg keeps its own
  history of the folder in `.smurg` (never a `.git` in your folder), and work items run in worktrees with a result
  report, a diff and your merge; smurg's history keeps every version of what it recorded. Without the git program,
  only the host can start work items, and they run one at a time directly in the shared folder, with no diff, no
  review before a change lands and no undo; the Start dialog says so and asks you to confirm ([host
  guide](docs/HOSTING.md) §10.2).
- **The protocol changed (version 5).** Update before you share again (`smurg update`): until then, teammates' pages
  say "The host's smurg is older than this page". A tab from before the update says "This tab is from before an
  update" and needs a reload. If you run your own relay, deploy it again.
```

Traditional Chinese (`docs/zh-TW/CHANGELOG.md`, same heading):

```
## [0.6.0] - YYYY-MM-DD

- **可以選模型了。** 主人和可使用 agent 的成員可以從主人的 Claude Code 提供的清單（包括 Fable）選擇 agent session 的模型：
  開啟 session 或主題時、按開始讓主題的工作項目開始時，以及之後在 session 上方的資訊列，變更會從 agent 的下一輪開始生效。
  資訊列會顯示 Claude Code 實際使用的模型。沒有人選模型的 session，和以前一樣用主人自己的 Claude Code 預設。在某些方案上，
  Fable 會從用量額度扣款，而且在 agent session 裡 Claude Code 不會先問；對話框會說明（[主人指南](HOSTING.md) §5.2）。
- **agent 以自動模式執行。** 新的權限模式「自動：檢查通過就執行」是每個 agent session 和工作項目的預設：由 Claude Code
  的檢查決定哪些指令不用問任何人就執行（agent 在自己資料夾裡改檔案和簡單的檔案指令，不經過這道檢查），被它擋下的會顯示在
  對話裡。這些檢查可能算進主人的用量。
  用較早版本的 smurg 分享過的工作區，更新時會改成自動模式：`smurg host` 會用一行說明，主人主控台的設定也會說明怎麼改回
  先問。「執行指令前先問」和「編輯和執行指令前都先問」仍然可以選，可以用在整個工作區、一個主題或一個 session
  （[主人指南](HOSTING.md) §5.2）。
- **在主工作區裡，自動模式下仍有兩種 shell 指令要等人決定**：在組員開的 session 裡改到只有主人能改的檔案（只有主人能
  允許），以及寫入有人正在輸入的檔案（在對方停下之前都會被拒絕）（[主人指南](HOSTING.md) §5.2）。
- **組員的 session 要寫到它自己資料夾以外的地方之前會先問**：在自動模式下，smurg 看得出指令寫到哪裡時，只有主人能允許
  （[主人指南](HOSTING.md) §5.2）。
- **不論哪種模式，smurg 都會拒絕任何 agent 都不該改的東西**：agent 編輯 Claude Code 的設定（你的和專案的）、`.git`、你的
  `.ssh` 資料夾和 smurg 自己的檔案，以及指名這些地方的指令，從工作項目的 worktree 也一樣（[主人指南](HOSTING.md) §5.2）。
- **主人可以讓 agent 什麼都不問**：在主人主控台的設定裡為整個工作區設定，會先看到警告：之後每個指令都以主人的身分執行，
  沒有沙盒，也沒有任何檢查，只剩上面那些拒絕。每個成員都看得到這個工作區什麼都不問，`smurg host` 每次啟動也會說明
  （[主人指南](HOSTING.md) §5.2）。
- **沒有 git 儲存庫也能執行工作項目。** 分享的資料夾沒有 `.git` 時，開始不會再被擋下：smurg 會在 `.smurg` 裡保存它自己的
  版本紀錄（絕不會在你的資料夾裡放 `.git`），工作項目在 worktree 裡執行，有結果報告、diff，再由你合併；smurg 的版本紀錄
  會保留它記下的每一個版本。電腦上沒有 git 程式時，只有主人能讓工作項目開始，它們會一次一個直接在分享的資料夾裡執行，
  沒有 diff，改動生效前沒有人看過，也無法復原；開始對話框會說明，並請你確認（[主人指南](HOSTING.md) §10.2）。
- **通訊協定改變了（第 5 版）。** 再分享之前請先更新（`smurg update`）：在那之前，組員的網頁會顯示「主人的 smurg 比這個網頁舊」。
  更新前就開著的分頁會顯示「這個分頁是更新前開的」，需要重新整理。如果你用自己架的 relay，請重新部署。
```

(The zh-TW quotes of the two page sentences are the catalogs' `rejected.version.hostOlder.title` and
`rejected.version.stale.title` as they render; the docs step checks them against `apps/web/src/strings/connection.zh-TW.ts`.)

## Appendix C. Evidence

| claim | source |
|---|---|
| `--model` precedence, aliases, unknown ids accepted, only `--model` on every start is deterministic | U1 E1, E2, E6 |
| `initialize.models` shape; `init.model` per turn; `set_model` success, no stdout line | U1 E3, U4 H |
| 404 → synthetic `model_not_found`; process survives; `--fallback-model` behaviour | U1 E4, E5, E9 |
| initialize-only probe cost; `get_settings.applied.model` | U1 E7, E8 |
| modes' measured behaviour (cards per mode, fast path, classifier stages, three blocks, HTTP 500) | U2 §B |
| bypass silently auto with the disable key; root refusal; `set_permission_mode` error codes; haiku silent default | U4 D, K, K3, K4, H, I; docs quotes in U4 |
| hook "ask" in auto → `can_use_tool`, no classifier call | U4 C1, C3 |
| `system/permission_denied` and `informational` shapes | U4 runs B3, D, L (stdout.jsonl) |
| hidden repository mechanics and costs | U3 §4 B1, B2 |
| where git is required today; Start refusal words | U3 §1, §2 |
| protocol strictness: every new key refused by protocol 4 | U5 strict.out |
| fixture and TAG debt; release order option (b); CLI-printed anchors | U5 |
| auto-mode default rules on package installs | U4 automode-defaults-2.1.288.json ("Declared Dependencies … Does NOT cover installing agent-chosen package names") |
| work items reach the main folder's config, `.smurg/git` and the host's `~/.claude` in auto; the host's `~/.claude` in bypass; absolute deny rules refuse them (absolute and `~` spellings) | R-SEC `exp/runs/wt--auto--smurg--classify-allow`, `wt--auto--plus--*`, `main--bypassPermissions--smurg--*`, `*--plus--*` (summary.json) |
| 2.1.288 keeps a process's deny rules after its `--settings` file was overwritten | R-SEC `exp/runs/reload--wt--auto--smurg--classify-allow` |
| an exclude line with a slash is anchored; `info/grafts` and `shallow` change history under smurg's git environment | R-SEC `exp/git/t1` (git 2.49) |
| 0.5.2's automatic refusals and host-only cards for config, outside and host-home paths | `conversation/permissions.ts assess()`, `permission-card.ts` `HOST_HOME_DIRS = ['.smurg', '.claude', '.ssh']` |
| the gate's hooks run `selfCommand.file`, the smurg executable (`process.execPath`) | `hooks/settings-writer.ts hookHandler`, `packages/cli/src/commands/host.ts selfCommand()` |
| item sessions are opened as the member who pressed Start (pathRights member); members hold `session.create` | `topics/scheduler.ts startItem` (`openedBy: starter`), `agent-sessions.ts:925`, `packages/protocol/src/roles.ts` |
| a retry skips the pin check and re-arms with the retrier as `startedBy` | `scheduler.ts pass()` (`!item.retry`), `plan-service.ts retryItem` |
| the clone's exclude holds only shared dirs; `add --all` in the worktree; the prompt says to install dependencies | `worktree/fs-ops.ts:115-127`, `stage-commit.ts:308`, `topics/prompts.ts:136`, `limits.ts:95` (R-ENG) |
| `shapeWrittenBy` picks today's schema for 0.5.1/0.5.2 once a 0.5.0 step exists | `test/upgrade/persisted.ts:30-33` (R-ENG) |
| the attach answer embeds the strict Welcome | `packages/daemon/src/local/protocol.ts:130-134, 246-249` (R-ENG) |
| request timeout 30 s; git timeouts 60/120 s; `index.lock` is a busy marker; 4 MiB stdout default | `client/engine.ts:118`, `worktree/git.ts:207`, `worktree-manager.ts:142`, `main-repo.ts:23` (R-ENG) |
| control errors lose `error_code` | `sessions/agent/normalise.ts:108-113`, `claude-process.ts:160-168`, `U4/exp/runs/H-setmodel/stdout.jsonl` (R-ENG) |
| a teammate's request runs no git in a folder that is no repository | `worktree-manager.ts:1808-1819 requireAvailableForWork` (R-ENG) |
| `observeGit` kind `none` covers an empty `.git` directory | `workspace/share.ts:165-174` (R-ENG) |
| the runner already queues messages until a process can take them (delivery `queued`) | `sessions/agent/agent-runner.ts send()`, `:405-420` |
