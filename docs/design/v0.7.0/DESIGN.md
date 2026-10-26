# smurg 0.7.0: design

Branch `v0.7.0-work` (from main 88ecb8a = released 0.6.0, protocol 5, workspace shapes 2). Version 0.7.0, protocol 6,
workspace shapes 3. Written 2026-10-27 by the designer from BRIEF.md (the owner's words, the lead's reading, the
standing decisions, the lead's frame and the rules) and the four understanding reports: U1 (every place a topic stops,
measured with the stand-in through the release composition: `U1/exp/measure.test.ts`, 12 cases), U2 (merging by
itself and undo, measured with real git 2.49: `U2/exp/scripts/exp1..7`, `U2/exp/vt/staged.test.ts`), U3 (what people
see and what the words say, with the inventory of every sentence that changes) and U4 (what 0.7.0 must keep and
0.6.0's release debt: `U4/newpoints.json`, `U4/out-tag060-*.txt`). The U*/NOTES.md files were never written; their
results reached the designer in the task, and the evidence folders above are what remains. This document follows the
form of `docs/design/v0.6.0/DESIGN.md` (numbered decisions, files, behaviour, shapes, words, tests). Reviewed twice on
2026-10-27 (R-SAFE: security and honesty, with real-git experiments in `R-SAFE/exp/`; R-ENG: engineering and upgrade);
every finding is answered in `D/ANSWERS.md` (S1–S22, E1–E15), and the changes are in this text.

## The design in five minutes

**What the owner asked.** "I don't want progress to stop because of a review report; let it merge automatically. Give
users the experience of: discuss, then leave it running, come back when it's done to check the results, unless a
decision is really needed." Measured today (U1 M1): a team that leaves after Start finds its plan stopped 1.2 s later
and still stopped 8 hours later; a clean three-item plan needs six clicks after Start (three "I've reviewed this",
three host merges), and the host is the one person everyone waits for. When every formality is answered at once, the
same plan takes 2.25 s (M8). Everything that held it was a formality.

**Merging by itself.** A new workspace setting, "Merging work items" (`merging`: `auto` or `host`), the host's alone,
`auto` for new workspaces and for existing ones at the update (the lead's frame; told to the host three ways, as 0.6.0
told auto mode). `host` gives back 0.6.0's flow exactly. A Start records the policy in each item's pin, with the
branch it started from; a member may choose "The host merges each item" at Start (stricter), never the other way; a
Start on a detached HEAD is the host's. Items started under 0.6.0 keep the host's merge. Turning the setting off
applies at once (a merge already under way finishes) and gives every started item to the host for good; turning it on
applies to later Starts only. smurg merges an item when it is **in order**: its turn ended normally and no later turn
was stopped, nobody wrote to its agent since its report, its report is the current version, was checked by the agent
in the turn that produced it and says `complete`, at least one check passed and none failed, no file of it was edited
by hand by someone without agent access, nothing of the item waits for a person, smurg's merge policy allows its
files, nobody asked for its merge (a requested merge stays the host's), the main workspace is on the Start's branch
with nothing staged, and the trial merge is clean. All of it is looked at again inside the merge queue, the last time
just before `git merge` runs. The merge is the host's standing consent applied by smurg: author the host, committer
smurg, a trailer `Merged-by: smurg (automatic merging, the host's setting)`, an audit entry `worktree.merge.auto` that
says whether the host chose the setting or the update set it. One merge at a time, in the order the reports were
registered; what waits or is held is skipped, everything else goes on, and dependents start from the merged state as
today (121–125 ms after a merge, M1).

**When the trial merge is not clean**, smurg looks at who changed the other side. Other work items only: it brings the
item's checkout up to date with the main workspace (0.6.0's `updateFromMain`) and asks the item's own agent to resolve
and verify again, at most three times; then it is a decision. A person's change (or anything outside this plan's work
items): it is a decision at once, for the item's carers, naming the file and who changed it; smurg never lets an agent
resolve over a person's lines by itself (R-SAFE showed it would drop them unread). Files someone is typing in make the
merge wait; files the host must commit or unstage, a branch the host switched, or git busy in the host's terminal for
ten minutes hold it for the host and clear by themselves once the host has done it (looked at again when those files
or git change, at the latest every minute, never on every 5-second sweep).

**What stops, and who decides.** A real decision stops only its item and what depends on it, and is a waiting
("amber") inbox item routed like a permission request: an agent's question; a request the mode still asks (G10–G12,
three refusals of Claude Code's check); a report that is not complete and verified (partial, blocked, a check that
failed, no check that passed, a report smurg cannot read); a report the agent did not check again after its last
change (smurg asks it once first); a later turn a person stopped, or a message a person wrote to the agent after its
report; a merge that stays unclean after the automatic tries, or that conflicts with a person's change; files only the
host may merge (today a silent dead end, M11); a hand edit by a member without agent access (the host reads it); a
merge the host rejected. Everything else becomes an
automatic, bounded, audited step: the review gate is gone ("I've reviewed this" stays as a mark), a usage limit
continues when the account is back, a broken turn continues twice, a crashed agent is resumed once, a failed snapshot
is retried once, and **a restart of `smurg host` lets plans go on by themselves** (0.5.0's AD-10 "nothing runs by
itself after a restart" ends here; the host gets a "Pause" that survives restarts, a line when smurg host stops that
says what will go on, and a line at every start printed before anything goes on). Sessions
that wait for a person no longer keep unrelated items from starting. A report gains a failed check, `- [!] …: failed:
…`, and a report with one cannot say `complete`.

**The end.** When every item of the plan is settled (merged with nothing of it still in progress, or left out, or
undone), the topic is **Ready to check** /
「待驗收」 (a new phase): every member's inbox, viewers included, says so, open pages get a toast, and `smurg host`
prints one line. The new "Result" column shows the summary, what was not verified first, every file the items changed
with each item's diff as smurg merged it, what to watch out for, and each item with its report and the host's
"Undo…". One press of "I've checked the result" / 「我已驗收」 by anyone who may discuss makes the topic complete and
ends its item sessions; until then a follow-up from a report still reaches the agent that did the work, and a change it
makes merges like the first one (and the topic is executing again until that is settled).

**Undo** is the host's, where history exists: one revert commit for an item or for the whole topic, the reports kept,
tried first without touching the folder, and in smurg's own history only after the folder's current state is recorded,
so nobody's saved edit is taken back; what was built on it goes with it and is listed before anything changes;
people's later changes to the same lines block it, named. It says what it cannot take back (what the agents' commands
did outside the folder, a branch already pushed). Direct mode has none and says so.

**Upgrade and protocol.** S0 pays 0.6.0's debt first: its fixture made from the tag (the driver is gone and is written
again), `TAG` = v0.6.0 in the three tests that read a tag. Then protocol 6 (exact; the existing cut-off words) and
workspace shapes 3: one step, for `state.json` (the setting `merging: 'auto'` and the notice `auto-merge`, audited once
at the first start), every other change an optional key. The published 0.4.0 to 0.6.0 executables are run against the
result.

**The words** say what smurg can know: "smurg merges what its report says is complete and verified", never that the work
is complete and verified (smurg runs none of the checks); a lint refuses the bare phrase.

**Left for the lead** (§5): the restart decision (the one place this design reverses a documented promise), the
per-Start choice instead of a per-topic setting, what was cut (merging around a person's uncommitted edits, "Bring it
back", undo by an agent in a checkout, a merge lock on the wire, notifications outside the browser), the slot rule's
memory cost, the bounds of the automatic steps, where the fixture driver and this design are kept, the phase of a
host's topic whose items are reviewed but not merged, four closed sides the reviews led to (an Editor's hand edits
wait for the host, a conflict with a person's change is a decision, one `verify-again` and then a decision for a report
not checked in its turn, "Merge it as it is" for the carers) and the restart's words and timing. Nothing is left for
the owner: every choice here follows the owner's words or takes the closed side.

How to read the rest: §1 is the decision table. §2 holds the decisions D1 to D23, each with its files, behaviour,
stored and wire shapes, words (catalog ids; both languages in Appendix B) and tests. §3 is the security review, §4 the
risks, §5 what is left for the lead. Appendix A is the wire diff of protocol 6, Appendix B the words, Appendix C the
evidence. BUILD-PLAN.md cuts this into steps.

Facts about Claude Code are those of the installed and verified 2.1.288; nothing in 0.7.0 depends on a new one. The
agent's behaviour that matters here (what it writes in its report, how it resolves a conflict) was measured with the
stand-in only; the real model was never run (no account, ARCHITECTURE §0 rule 2).

---

## 1. The design in one page

| # | Decision | Where |
|---|---|---|
| D1 | Pay 0.6.0's debt first: the 0.6.0 fixture from the tag with a new driver, `PUBLISHED_VERSIONS` + 0.6.0, `FIRST_OF_SHAPES[2] = '0.6.0'`, `NOT_PUBLISHED_YET = {}`, `TAG = 'v0.6.0'` in wire, other-version and ctl-other-version, the latter two stated over the shapes and protocol of each side | daemon, cli tests |
| D2 | Protocol 6: exact version, the existing cut-off words on both sides, the published executables refuse a 0.7.0 folder without changing it | protocol, cli tests |
| D3 | The consent: the workspace setting `merging` (`auto`, `host`), the host's; the per-Start choice "The host merges each item"; the pin records `merging` and `branch`; a detached HEAD pins `host`; turning the setting off rewrites the pins; the effective policy of an item | protocol, daemon topics |
| D4 | Stored state: WORKSPACE_SHAPES 3, frozen v0.6.0 `state.json` shape, the step (`merging: 'auto'`, notice `auto-merge`); every other change an optional key | daemon |
| D5 | The report's failed check `- [!] <what>: failed: <what happened>`; a failed check makes `complete` an error; `checks.failed`; "complete and verified" | daemon topics, protocol |
| D6 | "In order": one pure function, `autoMergeVerdict`, giving merge, wait (nobody needed), verify or resolve (the agent once more) or hold (a person decides); the report checked in the turn that made it; a later stop or a person's message; hand edits; requested merges stay the host's | daemon topics |
| D7 | The merge itself: `WorktreeManager.autoMerge`, the same body as `approve`, with the branch guard, the staged check (0.6.0's `merge.failed` named), "still in order" asked again inside the queue and just before `git merge`, who changed the other side of a conflict, author host and committer smurg, the trailer, the audit | daemon worktree |
| D8 | The merge queue (`AutoMerger`): one per workspace, oldest report first, one merge at a time; its triggers and its slow re-checks; update-and-resolve by the item's own agent (three tries) only against other work items, recorded before it starts and taken up again after a restart; waits and holds stored on the item | daemon topics |
| D9 | Decisions: the reasons, who decides (`decisionRecipients` = permission routing), escalation, the inbox kind `decision` (waiting), what each offers, what keeps running | protocol, daemon, web |
| D10 | Direct mode: a report that is not complete and verified no longer lets dependents start; "Accept as it is" (the host) | daemon topics |
| D11 | "Leave it out": an item and what depends on it are left out without editing PLAN.md | daemon topics |
| D12 | Review is a mark under automatic merging; an item's session and worktree stay until it is reviewed, the topic is checked or archived; per-item report rows and their escalation only for items the host merges | daemon topics, inbox |
| D13 | The end: settled items, phase `ready`, `complete` only when checked or every item is settled and reviewed, `topic.check` ("I've checked the result"), the inbox kind `ready` for every member, the Result column, notices | protocol, daemon, web |
| D14 | Undo (the host's): preview and apply (in smurg's own history after a snapshot, both), one revert commit, reports kept, what goes with it, what blocks it, what it cannot take back, a crash before or after the commit; direct mode says it has none | daemon worktree, topics |
| D15 | Keeping it running: plans go on by themselves after a restart (not a person's pause, not a topic with an interrupted direct item), once `smurg host` has said so; `plan.pause`; automatic continues after a usage limit, a broken turn, a crash, a failed snapshot, all bounded | daemon topics |
| D16 | Slots: sessions that wait for a person do not keep unrelated items from starting (up to twice `maxLiveAgents` processes) | daemon topics |
| D17 | Role prompts and smurg's messages (fixed English): the merge sentence, the failed check, the merged items in the resolve message, `remove-paths` | daemon topics |
| D18 | Telling the host: `smurg host`'s update line, the lines at a stop, at a start and while it runs, `smurg status`, the console's banner | cli, daemon, web |
| D19 | The web app: Start dialog, plan, report column and its decision foot, Result column, inbox rows, session list, notices, console, dialogs | web |
| D20 | The words: GLOSSARY "Terms of 0.7.0"; "what its report says is complete and verified"; never "smurg verifies" | catalogs, docs |
| D21 | Docs and site: every sentence of U3's inventory, both languages, the held ones word for word; the home page's fourth card and the picture's Build and Review scenes as far as the truth requires | docs, site, README |
| D22 | Tests: what proves each decision; the 0.7.0 acceptance test built from U1's twelve cases; existing tests that change on purpose | all |
| D23 | Release: 0.7.0, changelogs, RELEASING (protocol 6 order, `SMURG_PREVIOUS_BINARIES` + 0.6.0), ACCEPTANCE, `docs/design/v0.7.0/` | release |

Agent-neutral rule (standing decision): the wire and the stored state say `merging`, `autoMerge`, `checks.failed` and
the reasons below; nothing names Claude Code. Conversation lines keep naming "Claude" where today's lines do (the
agent's name in the app, `Claude (<owner>)`).

---

## 2. Decisions

### D1. 0.6.0's debt is paid before anything changes

**Why** (U4, RELEASING §4.5 "What a release owes the tests"): 0.6.0 is published (tag v0.6.0 = 88ecb8a = this branch's
base) and owes its fixture and the move of `TAG`. The fixture of the newest published version is the one whose coverage
must match TODAY's schemas exactly, so it must be made while today's schemas are still 0.6.0's: before S1.

**State of what 0.6.0 left** (U4 §0): W of 0.6.0 lost BRIEF, DECISIONS, DESIGN, the HANDOVERs, `build/S0/driver/` and
the published executables; files under `/private/tmp` that nobody read for about four days are deleted, the folders
stay. The driver that made the 0.5.1 and 0.5.2 fixtures is gone, so S0 writes one again. The VM still has the
published 0.4.0 to 0.5.2 Linux executables in `~/smurg-pub` (no 0.6.0).

**Files.** `packages/daemon/test/fixtures/published/0.6.0/` (new: README.md, files.json, coverage.json, ledger.json,
`stopped/`, `running/`); `packages/daemon/test/fixtures/published/README.md` (lists 0.6.0);
`packages/daemon/test/upgrade/fixture.ts` (`PUBLISHED_VERSIONS = ['0.4.0', '0.5.0', '0.5.1', '0.5.2', '0.6.0']`);
`persisted.ts` (`FIRST_OF_SHAPES = { 1: '0.5.1', 2: '0.6.0' }`, the `NOT_PUBLISHED` comment names 0.7.0's shapes 3);
`fixtures.test.ts` (`NOT_PUBLISHED_YET = {}`); `opens.test.ts` (`STORIES['0.6.0']`, `UPGRADES['0.6.0']`: no step,
no kept copy, the stamp is read, `writerOf('0.6.0') = '0.6.0'`); `refusals.test.ts` (`LATER_DOCUMENT['0.6.0']`);
`other-version.test.ts` and `wire.test.ts` (`TAG = 'v0.6.0'`; header comments; `it.for([...])` lists gain
`'0.6.0'`; `CHANGED_WITHOUT_A_WIRE_CHANGE` stays `{}`); `packages/cli/test/ctl-other-version.test.ts` (reads v0.6.0's
protocol package; the hard-coded v0.5.2 at :617-638 goes); `docs/RELEASING.md` §4.5 (the "After 0.6.0 is published"
sentence becomes past: what was made, and what 0.7.0 will owe); the driver, kept (below).

**The two tests stated over each side's numbers** (U4 experiment 2: with `TAG = 'v0.6.0'` and nothing else changed,
other-version.test has 9 failures and ctl-other-version.test 1, all of them expectations that the two sides differ):
- `other-version.test.ts` reads the tag's `WORKSPACE_SHAPES` from its tree (the constant in
  `packages/daemon/src/core/state-store.ts` of the archive) and states each case over the two numbers: "the tag's
  daemon really is the other side" expects the tag's own `shapes` in its stamp (2), not 1; "what this smurg wrote … is
  refused by the tag" becomes, while this tree's `WORKSPACE_SHAPES` equals the tag's, "… opens there with no step and
  opens here again" and, once it is greater (S1), "… is refused as newer with 'Nothing was changed.' and the state
  folder is byte for byte as before"; "what the tag wrote … opens here" expects the steps this tree has beyond the tag
  (none at S0; the 0.6.0 state step from S1 on).
- `ctl-other-version.test.ts` keeps one WELCOME sample per protocol (`WELCOME_V5` exists; S1 adds `WELCOME_V6`) and
  states "the other way round" over the tag's `PROTOCOL_VERSION`: equal, the tag's strict `welcomeSchema` accepts
  this tree's sample (S0); greater, it refuses it with `unrecognized_keys` and the command ends at once with the B2
  words (S1).
- `wire.test.ts` needs no restatement: with v0.6.0 its three comparisons run and pass at S0 (measured, U4), and from
  S1 on they say "raised" and skip, as they did for 0.6.0 with v0.5.2.

**What the 0.6.0 fixture must hold** (U4 experiment 1, `U4/tree/packages/daemon/test/upgrade/u4-newpoints.test.ts`,
output `U4/newpoints.json`: today's schema of each kind against 0.5.2's coverage.json). Points 0.5.2's fixture does not
know: `agent-sessions.json` `sessions[].modelChangedBy`, `modeChoice<null>`, `modeChoice<value>`, `model<null>`,
`model<value>`; `state.json` `hostNotices` (filled); the twelve `topics.json` points of today's `NOT_PUBLISHED_YET`
(`agent`, `agent.model`, `agent.permissionMode`, `agent.modeChangedBy`, `agent.modelChangedBy`, `items[].direct`,
`items[].pin.history`, `items[].pin.commit<null|value>`, `plan.lastPin.history`, `plan.lastPin.commit<null|value>`);
`worktrees.json` `hidden`, `worktrees[].repo`, `merges[].repo`, `merges[].base`. And two kept-copy kinds that the newest
fixture holds for the first time because `FIRST_OF_SHAPES[2]` becomes '0.6.0': `state.json.before-upgrade-from-0.5.0`
(its frozen shape has 16 points) and `agent-sessions.json.before-upgrade-from-0.5.0` (29 points: `pending`, root
main/worktree, responsible null/value among them); the kept copies of 0.4.0's step need an instance too.

**How it is made** (the procedure of the 0.5.x READMEs, by the tag's own code, no network):
- `git archive v0.6.0` into `W/build/S0/tag/`, its own tools (`scripts/env.sh` of that tree), `pnpm install
  --frozen-lockfile --offline`; the tag's relay in a local workerd with its dev login; the tag's stand-in `claude`
  (it also answers the model probe); scratch `HOME`, `SMURG_HOME`, `SMURG_CACHE_DIR`; `SMURG_NO_UPDATE_CHECK=1`; never a
  real `claude`, never the built-in relay, never anyone's `~/.smurg`.
- ONE host home with four workspaces: (a) the Bookshop story of the 0.5.x READMEs played by 0.6.0's code (the tag's
  `tests/e2e/test/t.topic-flow.test.ts` as its spine), with the sessions that must show cards of every kind opened
  "Asks before commands" or "Asks before edits and commands" (auto is 0.6.0's default), a topic whose model and mode a
  person chose and a session whose model a person chose, a teammate's command in auto mode for each new gate reason
  (`writes-host-only`, `writes-outside`, `writes-unknown`), a classifier block (`agent.command.blocked`) and a model
  change (`choose-model`); (b) a copy of the 0.5.2 fixture's `stopped` picture (both its workspaces) made with the
  tree's own copy step (`copyPublishedFixture('0.5.2', 'stopped')`) and opened by the tag's daemon: this gives the
  four kept-copy kinds and a filled `hostNotices: ['agents-auto']` (the host never presses "Got it" there); (c) a
  shared folder without `.git` (smurg's own history) with a Start and a merge: `hidden`, `repo`, `base`,
  `pin.history: 'smurg'`; (d) `smurg host` run with no git program on `PATH`, with a direct Start: `items[].direct`,
  `pin.history: 'direct'`, `commit` null, `noChanges: no-history`.
- The two pictures (`running`, `stopped`), the placeholders replaced as the 0.5.0 README says, `files.json`,
  `coverage.json` (a point the story cannot reach is listed `cannot` or `not-made` with what it would take; "0.5.2's
  fixture holds an instance and the shape is the same" only for a point that needs more than the story above),
  `ledger.json`, README "How it was made". Because the tag's tree is this branch's tree, this repository's own
  fixtures.test and opens.test with '0.6.0' added are the tag's check.

**The driver is kept this time**, as `packages/daemon/test/fixtures/drivers/fixture-driver-0.6.0.ts.txt` (outside
`published/`, so no fixture rule reads it; `.txt`, so no project compiles or lints it as code), with a header that
says where it is copied in the tag's tree and the one command that runs it. Reason: the last two drivers are lost (U4
§0), and RELEASING says a release owes its fixture; the next release's S0 starts from this file. (The lead may prefer W
only: §5.)

**Tests.** fixtures.test (no file of no kind; coverage of today's schemas exact), opens.test (0.6.0 opens with no step),
other-version.test and ctl-other-version.test stated as above against v0.6.0, wire.test against v0.6.0 (three
comparisons run and pass), pin.test unchanged. Nothing in `src/` changes. Expected: U4's baseline counts plus the new
0.6.0 cases (daemon `test/upgrade` 3 files green, cli `ctl-other-version` green).

### D2. Protocol 6 and what an older peer meets

**Why.** A host setting forces it (ARCHITECTURE §7.1: `PublicSettings` is in the strict Welcome), and so do the new
phase, inbox kinds and messages (Appendix A).

**Files.** `packages/protocol/src/constants.ts` (`PROTOCOL_VERSION = 6`, comment "6 since 0.7.0: automatic merging,
decisions, ready to check, undo"); `constants.test.ts`; `packages/daemon/test/version-refused.test.ts` (a protocol-5
hello is answered `version`); `.github/ISSUE_TEMPLATE/bug.yml` (protocol v6); `docs/RELEASING.md` §4.5 step 2
(`--version` says `protocol v6`); the protocol-5 pins (`packages/cli/test/main.test.ts`, `packages/protocol/test/
exports.test.ts`, `tests/e2e/test/workspace.test.ts`, `packages/cli/test/sea.test.ts`: each place 0.6.0 changed from 4
to 5, U4); `packages/protocol/src/schema/protocol6.test.ts` (new, beside `protocol5.test.ts`), stated per shape
(R-ENG E10): a protocol-5 Welcome (no `publicSettings.merging`), Topic (no `plan.leftOut`, `plan.undone`) and
preflight (no `merging`) are refused by today's schemas; a protocol-5 WorkItem and InboxItem are ACCEPTED (every
addition to them is optional, the new inbox kinds only widen an enum), so for those two the test takes the meaningful
direction: a protocol-6 WorkItem with `autoMerge` and an InboxItem of kind `decision` are refused by v0.6.0's strict
schemas, read from the tag's protocol package as ctl-other-version.test reads its Welcome.

**Behaviour.** Exact equality stays (codec.ts `decodeClientHello`); no compatibility code. What each side meets is what
0.5.1 built and 0.6.0 used:

| peer | meets | words (exist, unchanged) |
|---|---|---|
| page of 0.7.0, host of 0.6.0 or 0.5.1/0.5.2 | verdict `version` | page `rejected.version.hostOlder.*`; host `host.peer.newer` once per run |
| page of 0.7.0, host of 0.5.0 or 0.4.0 | verdict `version` | page `rejected.version.hostOlder.*`; the host prints nothing |
| tab of 0.6.0 open across the deploy, host of 0.7.0 | verdict `version` | page `rejected.version.stale.*`; host `host.peer.older` |
| `smurg attach` across versions (either way) | the attach answer's strict Welcome (`publicSettings` gains `merging`) | the B2 words at once ("A smurg host of another version is sharing on this computer") |
| 0.6.0, 0.5.2 or 0.5.1 executable on a folder 0.7.0 wrote | stamp `shapes: 3` > 2 or 1 | "Run smurg update. Nothing was changed." |
| 0.5.0 or 0.4.0 executable on a folder 0.7.0 wrote | `state.json` version 3, refused by their strict schema | their own refusal (recorded by the test); the workspace state folder byte for byte as before |

The relay parses no frame: no relay code changes; it is redeployed from the tag with the v0.6.0 web build kept (D23).
The control socket's `status` answer gains optional fields (D18); its command-side schema ignores unknown keys since
0.5.1, so a 0.6.0 `smurg status` beside a 0.7.0 host prints what it knows.

**Tests.** constants.test (6), version-refused.test (5 → `version`), protocol6.test, ctl-other-version.test
(`WELCOME_V6`; a 0.7.0 command meeting a protocol-5 answer and a 0.6.0 command meeting a protocol-6 answer both end at
once with the B2 words), wire.test says "raised" for v0.6.0, sea-upgrade.test (D4).

### D3. The consent: the workspace setting, the Start's choice, the pin

**Wire** (`packages/protocol/src/schema/entities.ts`):

```ts
/** How a work item's change reaches the main workspace (protocol 6): smurg merges it when it is in order, or the host does. */
export const MERGE_POLICIES = ['auto', 'host'] as const;
export const mergePolicySchema = z.enum(MERGE_POLICIES);
export type MergePolicy = z.infer<typeof mergePolicySchema>;

publicSettingsSchema = z.strictObject({ …as today, merging: mergePolicySchema });   // so HostSettings and the patch have it
```

Every member receives it in the Welcome and `channel.settingsUpdated` (the Start dialog and the plan say which flow
runs). Only the host sets it: `admin.settings.set` is `admin` already; no new capability.

**The pin** (`packages/daemon/src/topics/store.ts` `pinSchema`, optional keys):

```ts
merging: z.enum(MERGE_POLICIES).optional(),  // what this Start said; absent: a 0.6.0 Start (the host merges)
branch: shortBranchSchema.optional(),         // folder git: the branch the checkpoint was committed on (checkpoint.ts returns it today)
// refines: merging 'auto' ⇒ history !== 'direct'; branch ⇒ history absent (the folder's own git) and commit !== null;
//          merging 'auto' with history absent ⇒ branch present (a detached Start pins 'host')
```

`plan.lastPin` gets the same two keys (the Start dialog's default reads it).

**Start** (`packages/daemon/src/topics/plan-service.ts start`). `plan.start` gains `merging?: z.literal('host')`: "the
host merges each item of this Start". The pin's `merging` is `auto` when the workspace's setting is `auto`, the Start
did not send `merging: 'host'`, the history is not `direct` and the checkpoint is on a branch; `host` otherwise, except
that a direct pin has none. `branch` is the checkpoint's `branch` (folder git only). **A detached HEAD** (R-SAFE S19,
R-ENG E5): the checkpoint returns the literal `'HEAD'` then (`main-repo.ts:180`, `worktree-manager.ts:1953`), which
`shortBranchSchema` accepts and the branch guard could never match; such a Start pins `merging: 'host'` and no
`branch` (the closed side: no branch to guard means nothing merges by itself), and the dialog says why
(`start.merge.detached`). The audit entry `plan.start` gains `merging` and `branch`. Nothing else in Start changes.

**The preflight** (`startPreflightSchema`) gains:

```ts
/** null with history direct. `proposed`: what the dialog selects first: `host` when the workspace says so, the main
 *  workspace is on no branch, or the topic's last Start chose it (`lastPin.merging === 'host'`), else `auto`.
 *  `detached`: folder git, HEAD on no branch: only `host` is possible. */
merging: z.strictObject({ workspace: mergePolicySchema, proposed: mergePolicySchema, detached: z.boolean() }).nullable(),
```

**The dialog's choice** (D19): shown when `merging !== null && merging.workspace === 'auto' && !merging.detached`: "How
its items are merged" with "smurg merges what its report says is complete and verified (workspace setting)" and "The
host merges each item". With `workspace === 'host'` there is no choice and the dialog says the host merges
(`start.merge.host`); with `detached` it says `start.merge.detached`. A member may always choose the stricter option;
nobody can choose `auto` while the workspace says `host` (the host turns the setting on).

**The effective policy** (`packages/daemon/src/topics/core.ts`, one function, used by the verdict, the phase, the
inbox and the wire):

```ts
/** How this started item's change reaches the main workspace now: smurg's merge needs BOTH the Start's and the host's. */
export function mergingOf(item: StoredItem, settings: Pick<HostSettings, 'merging'>): MergePolicy | null {
  if (item.pin === undefined) return null;                    // never started
  if (item.pin.history === 'direct') return null;             // nothing to merge (D10)
  return item.pin.merging === 'auto' && settings.merging === 'auto' ? 'auto' : 'host';
}
```

**Turning it off is for good** (R-SAFE S5, R-ENG E6). mergingOf alone would re-arm, at the next "on", every item whose
Start pinned `auto`, also those the host had taken back to read and merge by hand, against the words "turning it on
applies to work items started from then on". So when the setting turns to `host`, the topics module writes `merging:
'host'` into the pin of every item of every open topic whose pin says `auto`, merged items included (a follow-up's later
version is then the host's too), one topic update per topic, audited once as `plan.merging.host` (actor
`SYSTEM_ACTOR`, detail `{ topics, items, cause: 'setting' }`); `plan.lastPin` is not rewritten (it records what the
last Start chose, and only proposes). The same rewrite runs at every start while the setting says `host` (two
documents, `state.json` and `topics.json`: a crash between them is repaired there). mergingOf keeps both conditions,
so between the setting's change and the rewrite every item already reads `host`.

So turning the setting to `host` applies at once (every item waits for the host, exactly 0.6.0's flow: "Report to
review", then "Reviewed, ready to merge"; a merge already inside `git merge` finishes, D7), and turning it to `auto`
applies to later Starts only. Items armed by a 0.6.0 Start have no `merging` in their pin: they keep the host's merge
after the update (`smurg host`'s update line says so, D18). A change of the setting publishes every plan (the wire's
`WorkItem.merging` follows) and wakes the merge queue.

**Tests.** protocol: `publicSettingsSchema` refuses a Welcome without `merging`; preflight refine (`merging` null ⇔
history direct; `detached` ⇒ `proposed === 'host'`); plan-service: a Start under `auto` pins `merging: 'auto'` and the
branch; with `merging: 'host'` it pins `host`; under `host` it pins `host` whatever it sent; a direct Start pins no
`merging`; a Start on a detached HEAD (folder git, `git checkout --detach`) pins `host` and no branch, and its
preflight says `detached`; `proposed` is `host` after a Start that chose it; `mergingOf` table (pin × setting ×
history); the toggle: Start under `auto`, setting to `host` (the pins now say `host`, one `plan.merging.host` entry),
back to `auto`: the item waits for the host; a kill between the setting and the rewrite: the next start rewrites; the
audit names the policy and the branch.

### D4. Stored state: shapes 3, one step, optional keys

**Files.** `packages/daemon/src/core/state-store.ts` (`WORKSPACE_SHAPES = 3`); `packages/daemon/src/frozen/v0.6.0.ts`
(new, literal, imports zod only: `stateShapeV060`, a strict copy of what 0.6.0 accepts, from
`test/upgrade/shapes/state.json.txt` plus the rules the pinned sources write as code); `packages/daemon/src/core/
workspace-state.ts` (`STATE_VERSION = 3`, the step); `packages/daemon/src/topics/store.ts`; `packages/daemon/src/
worktree/store.ts`; `packages/protocol/src/schema/topics.ts` (reports, through `storedReportSchema`);
`test/upgrade/persisted.ts` (`TODAY_SINCE.state = '0.7.0'`; `FIRST_OF_SHAPES[3] = NOT_PUBLISHED`; a kept-copy kind for
`state.json.before-upgrade-from-0.6.0`, schema `stateShapeV060`); `pin.test.ts` (`PINNED_AT_SHAPES = 3`, `FROZEN`
gains `v0.6.0.ts`, shapes rewritten with `SMURG_PIN_WRITE=1` after the question is answered); `fixtures.test.ts`
(`NOT_PUBLISHED_YET`, below); `opens.test.ts` (`UPGRADES`: every published version's `state` now also runs the 0.6.0
step; 0.6.0 itself: `state` upgraded, kept copy `.before-upgrade-from-0.6.0`); `state-steps.test.ts`.

**state.json** (version 3):

```ts
workspaceStateSchema = z.strictObject({
  version: z.literal(3),
  …as 0.6.0 (settings: hostSettingsSchema, which now has `merging`),
  hostNotices: z.array(hostNoticeSchema).max(HOST_NOTICES.length),   // HOST_NOTICES = ['agents-auto', 'auto-merge']
});

/** state.json of smurg 0.6.0 → 0.7.0. The owner's words of 2026-10-26 and the lead's frame (BRIEF): existing workspaces
 *  merge work items by themselves after the update, and the host is told. The second step that sets a security-relevant
 *  value to the OPEN side (after 0.6.0's auto mode); the constant is the step's own and never today's default. */
export const stateStepFromV060 = defineStep({ from: '0.6.0', sinceShapes: 3, shape: stateShapeV060,
  upgrade: (old) => ({ ...old, version: 3, settings: { ...old.settings, merging: 'auto' },
                       hostNotices: [...new Set([...old.hostNotices, 'auto-merge'])] }) });
```

Steps, oldest first: `stateStepFromV040` (unchanged; output checked against `stateShapeV050`), `stateStepFromV050`
(unchanged; its output is now checked against `stateShapeV060`, which is what it produces), `stateStepFromV060`. A
0.5.x file therefore ends with `hostNotices: ['agents-auto', 'auto-merge']`: both notices are true for it. A new
workspace: `merging: 'auto'`, `hostNotices: []` (`initialWorkspaceState`, `DEFAULT_SETTINGS`).

**The step is audited** (R-SAFE S14): neither 0.6.0's agents-auto step nor `admin/settings.ts` (which audits only the
host's own changes) writes an entry, so the audit could not tell who chose automatic merging. The first start after
the step (an `upgraded` entry for `state` whose `from` is 0.6.0 or older, as D18 reads it) writes ONE entry
`admin.settings.set`, actor `SYSTEM_ACTOR`, detail `{ merging: 'auto', reason: 'update-0.7.0', from }`; and every
`worktree.merge.auto` records `consent: 'update-default'` while `auto-merge` is still in `hostNotices` (the host has not
pressed "Got it" nor set `merging`), else `consent: 'host-setting'` (D7).

ARCHITECTURE §0 rule 8 gains the second exception, worded like the first: "and, by the owner's words of 2026-10-26
(0.7.0), workspaces of 0.6.0 and earlier merge work items by themselves after the update; the host is told by `smurg
host` and in the console. Items armed before the update keep the host's merge (their pins)."

**Documents that only gain optional keys** (a 0.6.0 file passes today's schema as it is; no step):
- `topics.json`, item (`storedItemSchema`):
  - `autoMerge?: { state: 'waiting' | 'resolving' | 'held', reason: AutoMergeReason, since: epochMs, hostOnly: boolean,
    paths?: entryPath[] (≤ 20), branch?: { expected, current }, escalatedAt?: epochMs, requestId?: opaqueId }` (D8,
    D9: what the item waits for now; it goes when that is over);
  - `autoMerge.people?: { path: entryPath, by: UserRef[] (≤ 5), outside: boolean }[] (≤ 20)` (a `conflict` hold whose
    other side is a person's change, D7; the same shape as D14's `changedSince`);
  - `mergeTries?: index` (resolve turns smurg asked for since the item's Start; kept when a new version clears a hold,
    reset by Start again and Try again: D8);
  - `turns?: index` (finished turns of the item's sessions, counted when the turn's end arrives; absent: 0) and
    `checked[].turn?: index` (the turn `check_report` answered ok in: `turns + 1` at that moment; absent on 0.6.0
    entries): what makes "checked in the turn that produced it" a stored fact that survives a restart (D6, R-SAFE S4);
  - `lastTurn?: { outcome: 'interrupted' | 'error', at: epochMs }` (the newest turn after the current version did not
    complete; cleared by a completed turn, a new version, Continue and Try again: D6 row 6, R-SAFE S7);
  - `mergedAs?: { requestId?: opaqueId, commit?: gitCommit, at: epochMs, by: 'smurg' | UserRef }` (who merged it and
    the merge commit: worktrees.json keeps only 300 decided merges, U2 A3.9; direct and accepted items have no request);
  - `leftOut?: { by: UserRef, at: epochMs }` (D11); `undone?: { by: UserRef, at: epochMs, commit: gitCommit }` (D14);
  - `autoContinue?: { cause: 'usage-limit' | 'error' | 'crash' | 'snapshot', count: index, at: epochMs }` (D15);
  - pin (and `plan.lastPin`): `merging?: 'auto' | 'host'`, `branch?: string` (D3);
  - topic: `checked?: { by: UserRef, at: epochMs }` (D13); plan: `pausedBy?: UserRef` (D15: a person's pause; absent
    with `paused: true`: a restart's pause of 0.6.0 or of a topic with an interrupted direct item).
- `reports.json` (through `reportInfoSchema`): `sections.verified[].failed?: true`, `checks.failed?: index` (absent: 0;
  a 0.6.0 report has no failed check because the format had none) (D5); `checkedInTurn?: true` (stored only, in `storedReportSchema`'s own extension, not on
  the wire's report: `check_report` answered ok for this content in the turn that produced this version, or a later
  turn that changed nothing confirmed it, D6) and `changes.byHandTruncated?: true` (on the wire's report too, optional; the snapshot's hand-edit list was
  longer than `REPORT_BY_HAND_MAX`, or a file's `by` list longer than the 20 kept, `report-service.ts:365`: D6 row 9
  then holds, the closed side).
- `worktrees.json`: merge `auto?: true` (smurg merged it), merge `undone?: { commit: gitCommit, at: epochMs, by:
  UserRef }`, top level `undo?: { requestIds: opaqueId[] (≤ 64), pre: gitCommit, target: gitTree, repo?: 'smurg', at:
  epochMs }` (the record written before an undo touches the folder; `target` is the tree the folder becomes, so a crash
  before the commit can be told from one after it, D14).
- `audit*.jsonl`: `AUDIT_ACTIONS` gains `worktree.merge.auto`, `worktree.merge.held`, `worktree.merge.undo`,
  `topic.check`, `plan.pause`, `plan.item.leaveOut`, `plan.item.accept`, `plan.item.release`, `plan.item.removePaths`,
  `plan.item.autoContinue`, `plan.merging.host` (a wider enum: old lines pass).
- transcripts: `SMURG_PURPOSES` gains `remove-paths` and `verify-again` (wider enum); new line and notice ids are
  free-form.
- `inbox.json`: unchanged, on purpose (R-ENG E4). Its stored mention notes used the wire's `columnTargetSchema`
  (`inbox/store.ts:40`), which gains the `result` kind (D13); a mention is never written in the Result column (it has no
  text of people), so the stored note gets a target schema of its own, `storedColumnTargetSchema` in
  `inbox/store.ts`, with exactly the six kinds of 0.6.0, and the stored shape does not change (the pin's hash of
  `inbox/store.ts` changes with the answer "this changes no stored shape").
- `agent-sessions.json`, `cards.json`, `host-rules.json`, `claude-trust.json`, uploads, conflicts, activity:
  unchanged (the new inbox kinds are derived, not stored).

`NOT_PUBLISHED_YET` (fixtures.test) lists every new optional point under its kind until the 0.7.0 fixture exists:
`'topics.json': ['topics[].checked', 'topics[].plan.pausedBy', 'topics[].items[].autoMerge', 'topics[].items[].
autoMerge.paths', 'topics[].items[].autoMerge.escalatedAt', 'topics[].items[].autoMerge.requestId', 'topics[].items[].
mergedAs', 'topics[].items[].mergedAs.requestId', 'topics[].items[].mergedAs.commit', 'topics[].items[].mergedAs.by<…>'
(both branches), 'topics[].items[].leftOut', 'topics[].items[].undone', 'topics[].items[].autoContinue',
'topics[].items[].autoMerge.branch', 'topics[].items[].mergeTries', 'topics[].items[].pin.merging',
'topics[].items[].pin.branch', 'topics[].plan.lastPin.merging',
'topics[].plan.lastPin.branch', 'topics[].items[].autoMerge.people', 'topics[].items[].turns',
'topics[].items[].checked[].turn', 'topics[].items[].lastTurn']`, `'reports.json':
['reports[].sections.verified[].failed', 'reports[].checks.failed', 'reports[].checkedInTurn',
'reports[].changes.byHandTruncated']`, `'worktrees.json': ['merges[].auto', 'merges[].undone', 'undo', 'undo.repo']`
(the walker's exact names are the builder's to copy from its output; `inbox.json` has none, by the stored target
schema above). `state.json`'s new points are not listed: its 0.6.0 files are checked against the
frozen shape the step reads.

**Daemon.upgraded**: unchanged shape; D18's line reads it.

**Tests.** state-steps.test: a 0.6.0 state.json → version 3, `merging: 'auto'`, `hostNotices` gains `auto-merge` once
(also when it already had `agents-auto`), every member, device and invite carried; 0.5.x → two steps (v2 then v3); 0.4.0
→ three; the kept copy `.before-upgrade-from-0.6.0`; a put-back of a 0.6.0 file in a shapes-3 folder is reported as
put back; the step's one audit entry at the first start, none at the second; inbox store: a mention note with a
`result` target is refused (the stored target schema is 0.6.0's); opens.test UPGRADES for all five versions;
fixtures.test with `NOT_PUBLISHED_YET` and `shapeWrittenBy` (0.6.0
→ `stateShapeV060`); pin.test (shapes 3, frozen v0.6.0 hash); unfinished.test parametrized over the 0.6.0 fixture too
(a kill between `state.json` and the next document); other-version.test: v0.6.0's daemon refuses this tree's folder
with "Run smurg update. Nothing was changed.", this tree opens v0.6.0's and upgrades it; sea-upgrade.test (opt-in, the
release gate) with five published executables: each one's folder upgraded by 0.7.0 (the two lines of D18 printed, kept
copies, stamp shapes 3), then each refuses what 0.7.0 wrote without changing the workspace state folder.

### D5. The report says what failed; "complete and verified"

**Why.** Report format v1 knows `- [x]` (passed) and `- [ ] <what>: not verified: <why>` only
(`packages/daemon/src/topics/report-format.ts:116, 250-275`): a test that failed can only be written as "not verified",
so neither smurg nor a person can tell "failed" from "not run" (U2, U3 A7(b)). The lead's frame asks that "the
verification it ran did not fail" before a merge.

**The format** (still `<!-- smurg:report v1 … -->`: every 0.6.0 report parses the same): a third check line,

```
- [!] <what>: failed: <what happened>
```

`CHECK_LINE` becomes `/^[-*][ \t]+\[([ xX!])\][ \t]+(.*)$/`; `FAILED = /^(.*?):[ \t]*failed[ \t]*:[ \t]*(.*)$/i` (both parts
required, else the new error kind `verified-failed-why`). A report whose outcome is `complete` and that has a failed
check is refused with the new kind `outcome-failed` at the outcome line, so `check_report` answers "not ok" and the
agent fixes it (`fix-report`, at most twice, then the item is stalled as today). Model sentences (fixed English,
`REPORT_ERROR_SENTENCES`):
- `verified-failed-why`: 'A check that failed is written "- [!] <what>: failed: <what happened>" and must say what happened.'
- `outcome-failed`: 'A report with a failed check is not complete: set the outcome line to partial, or make the check pass and mark it "- [x]".'
- `verified-none` gains the third form in its list.

`ParsedReport.checks` = `{ passed, notVerified, failed }`; a verified entry is `{ text, passed: false, failed: true,
note }` for a failed one. People's words for the two errors are `report.error.format` / `report.error.outcome` (exist).

**Wire** (`packages/protocol/src/schema/topics.ts`): `reportChecksSchema = z.strictObject({ passed, notVerified,
failed: indexSchema.optional() })` (absent: 0); `sections.verified[]` gains `failed: z.literal(true).optional()` with the
refine `failed ⇒ !passed && note !== undefined`. The inbox item's `checks` carries `failed` too.

**"Complete and verified"** / 「完成且驗證過」, defined once (GLOSSARY, HOSTING §10.3): the report's outcome line says
`complete`, at least one check passed, and none failed. A "not verified" line does not stop the merge (it is listed
first in the Result column, D13). The checks are what the agent reports: smurg runs none of them (ARCHITECTURE §12);
the words never say "smurg verifies" or "smurg tests" (D20's lint).

**The REPORT_FORMAT text** (`packages/daemon/src/topics/prompts.ts`) gains the line `- [!] <a check that failed>:
failed: <what happened>` and the sentence 'A check you ran that did not pass is a failed check, not "not verified";
when a check failed, the outcome is partial.' (both role prompts use the format).

**Web**: the report column's check list shows a failed check with the label `report.check.failed` ("Failed" /
「失敗」) before its text and its note; the counts line reads "2 passed · 1 failed · 1 not verified".

**Tests.** report-format.test (the three forms; `[!]` without "failed:" → `verified-failed-why`; complete + a failed
check → `outcome-failed` at the outcome line; a 0.6.0 report fixture parses to the same result as before); protocol
topics schema tests (`failed` optional, the refine); prompts.test (the format's new line and sentence); web
ReportColumn.test (the failed row, both languages); stand-in: a scripted report with a failed check and `complete` gets
`fix-report`, the fixed one (`partial`) is registered.

### D6. "In order": one pure function

**File.** `packages/daemon/src/topics/auto-merge-verdict.ts` (new, pure, no service), with
`auto-merge-verdict.test.ts` (a table: one row per branch below, in order).

```ts
export type AutoMergeVerdict =
  | { readonly kind: 'none' }                                  // not smurg's to merge (the host merges, nothing to merge, not done, merged)
  | { readonly kind: 'merge'; readonly requestId: string }
  | { readonly kind: 'wait'; readonly reason: 'paused' | 'busy' | 'asked' }
  | { readonly kind: 'verify' }                                // ask the agent once to check its report again (row 13)
  | { readonly kind: 'resolve'; readonly reason: 'markers'; readonly paths: readonly string[] }
  | { readonly kind: 'hold'; readonly reason: HoldReason; readonly paths?: readonly string[] };

export function autoMergeVerdict(input: {
  readonly policy: MergePolicy | null;                         // mergingOf(item, settings), D3
  readonly topic: { readonly archived: boolean; readonly paused: boolean };
  /** An undo of this topic claims the item while it runs (D14): nothing of it merges meanwhile. */
  readonly claimed: boolean;
  readonly item: Pick<StoredItem, 'state' | 'merged' | 'leftOut' | 'changesAsked' | 'merge' | 'autoMerge' | 'lastTurn' | 'autoContinue'>;
  /** The item's current request as the worktree module has it: `requested` when someone asked for its merge. */
  readonly request: { readonly id: string; readonly status: MergeRequestStatus; readonly requested: boolean } | null;
  readonly report: { readonly version: number; readonly state: ReportState; readonly outcome: ReportOutcome;
                     readonly checks: { passed: number; notVerified: number; failed?: number };
                     readonly checkedInTurn: boolean; readonly pendingFollowUps: number;
                     readonly noChanges?: NoChangesReason; readonly paths?: readonly string[] } | null;
  /** Some file of the version was edited by hand by someone who holds no agent access now, or the list was cut (D4). */
  readonly byHandOutside: readonly string[] | 'truncated' | null;
  readonly session: { readonly turnOpen: boolean; readonly openCards: number } | null;
  readonly tries: number;                                      // the item's mergeTries
  readonly maxTries: number;                                   // AUTO_MERGE_TRIES = 3
}): AutoMergeVerdict
```

The rows, in order (the first that applies decides):
1. `policy !== 'auto'`, the topic archived, the item left out, or the item not `done` / `reviewed` → `none`.
2. The item's current request is `merged` → `none`. The item is `claimed` by an undo that runs (D14) → `none`.
3. The plan is paused → `wait: paused`.
4. The session is in a turn, has an open question or permission card, or an automatic continue of D15 is still to
   come (`autoContinue` set and its bound not spent) → `wait: busy`. (A card's own inbox item is the decision; this only keeps the merge out of the
   way.)
5. **Somebody wrote to the agent since this version** (R-SAFE S7): `changesAsked` (set by a follow-up from the report,
   as in 0.6.0, and now also at the end of any turn of the item's session that carried a person's message and
   registered no new version, `report-service.ts itemTurn`) or a follow-up whose answer is still to come
   (`pendingFollowUps > 0`). While that answer is to come → `wait: asked`. Once the session is idle and no new version
   came → `hold: asked` for the carers (who wrote is named): a new version, "Merge it as it is" (`plan.item.release`,
   D9) or "Leave it out" clears it. (0.6.0 deleted `changesAsked` only in `register()`, so a follow-up answered without
   a change would have kept the item waiting for ever, silently.)
6. **A later turn did not finish** (R-SAFE S7): `lastTurn` set, i.e. the newest turn after the current version ended
   `interrupted` (a person pressed Stop) or `error` with D15's automatic continues spent → `hold: stopped` for the
   carers ("Continue", a follow-up, "Merge it as it is", "Leave it out"). 0.6.0's `itemTurn`
   (`report-service.ts:191-198`) stalls a turn that did not complete only while no version is registered, and a new turn
   on a `done` item never makes it `running` (`scheduler.ts:471-478`), so without this row a version merged after its
   agent had been stopped.
7. No report → `none`. Report `invalid` (after the fixes, D5) → `hold: report-invalid`.
8. `noChanges`: `host-only-paths` or `spec-files` → `hold: policy` with the paths; `conflict-markers` → `resolve:
   markers` while `tries < maxTries`, else `hold: conflict`; `no-history` → `none` (direct items: D10).
9. **A hand edit by someone without agent access** (R-SAFE S8): `byHandOutside` not null (a file the snapshot lists as
   edited by hand by a member who holds no `session.drive` now, or by someone no longer a member; or the list was cut
   at `REPORT_BY_HAND_MAX`) → `hold: by-hand` for the host, with the paths. In 0.6.0 an Editor's edit in a worktree
   reached the main workspace only after the host read the diff (JOINING :500-503 says such edits are allowed and listed
   in the report); merged unread it would become, in the folder's own git, a commit on the host's branch with nobody in
   between, which an Editor's direct write to the main folder never is (it stays uncommitted until the host commits).
   A member with agent access could have had the agent make the same edit, so theirs merge as the agent's do.
10. Outcome `partial` → `hold: partial`; `blocked` → `hold: blocked`.
11. `checks.failed > 0` → `hold: check-failed` (the parser makes it impossible with `complete`; kept so a hand-edited
    store cannot pass).
12. `checks.passed === 0` → `hold: not-verified`.
13. **The report was not checked in the turn that produced this version** (R-SAFE S4): `checkedInTurn` false. 0.6.0
    registers a new version whenever a turn edited files or was a resolve turn, also when the report file is the same
    as before (`report-service.ts:216-217`), and counts the content as checked when that hash was checked once in the
    session (`:211`): such a version would merge on checks the agent ran before its change (a resolution never verified
    again, a follow-up's change, a continued turn). No `autoMerge` record yet → `verify` (the queue sends
    `verify-again` once, D8, and records `resolving: stale-report`; a new version ends any record, so it is once per
    version); `resolving: stale-report` → `none` (the agent is at work); `held: stale-report` (stored by the end of
    that turn when it neither confirmed nor made a version, D8) → `hold: stale-report` for the carers. A turn that
    checks this same content and changes nothing sets `checkedInTurn` on the version (no new version) and the item is
    in order again.
14. The item holds a decision already (`autoMerge.state === 'held'` with a reason the verdict does not compute: a
    merge-time hold of D7, `conflict` after the tries or with a person's change, `rejected`) → keep it (`hold`, same
    reason) until what clears it happens (D8 "Clearing"); `autoMerge.state === 'resolving'` → `none` (the item's agent
    is at work: its next version, or its next turn for `stale-report`, decides). A `waiting` record of the worktree
    (`typing`, `git-busy`, `behind`, `retry`) falls through: the queue tries again when its re-check is due (D8).
15. The current request is a `draft` or a `conflict` that nobody requested (`request.requested` false) → `merge`. A
    request somebody asked for (`pending`, or a `conflict` that keeps its `requestedBy`, `worktree-manager.ts:1849-1853`)
    is the host's row, as in 0.6.0 (R-SAFE S12): `none`.
16. Anything else → `none`.

**How the new facts are recorded** (`report-service.ts`; stored keys of D4). `onItemTurn` adds 1 to the item's `turns`
when a turn's end arrives, synchronously, before its handling is queued (`core.serialize`, `:172`), and hands that
number to `itemTurn`; `checkReport` stamps its entry `turn: turns + 1` (the turn in progress). So in `itemTurn` "this
content was checked in this turn" is an entry for this session and hash with that turn's number, and after a restart
an entry with `turns + 1` is a check of the turn the restart cut. `register()` stores `checkedInTurn` from it; a
completed turn that edited nothing and checked the current version's content sets `checkedInTurn` on that version. The
same `itemTurn` sets `lastTurn` for a turn that did not complete while a version is registered (and clears it for one
that completed), and sets `changesAsked = { by, at }` for a turn that carried a person's message (`kind: 'person'`) and
registered no new version.

Rows 1–14 read what the topics module holds (its store, the session's state, the report, the request's status), so the
same verdict is shown on the wire (`WorkItem.autoMerge`, D9) and used by the queue (the wire's `tries` is the item's
`mergeTries`). The checks of the main workspace (branch, staged, busy, typing, local changes, the trial, who changed the
other side) are the worktree module's (D7): only it reads the main workspace.

**At the moment of the merge** (R-SAFE S3, R-ENG E1): the verdict is computed when a pass collects its candidates, and
the merge itself waits for the worktree module's `main` queue, behind earlier candidates, report snapshots, Start
checkpoints, `updateFromMain`'s snapshot and undo (`worktree-manager.ts:1409, :1506, :1583, :1942, :1957`); a hidden
snapshot of a large folder takes seconds. A Pause, the setting turned to `host`, an archive, "Leave it out", a
follow-up, a new turn or an open card in that gap must win. So the AutoMerger hands `autoMerge` a synchronous
`stillInOrder(): boolean` that computes rows 1–15 again from the stores and the settings and answers whether the
verdict is still `merge` for this same request; D7 calls it inside the `main` queue at entry and again just before it
spawns `git merge`, with no `await` in between. False → `gone` (nothing is marked; the next pass looks again).

### D7. The merge itself: `WorktreeManager.autoMerge`

**Files.** `packages/daemon/src/worktree/worktree-manager.ts`, `git.ts` (`GitRunOptions.committer`), `names.ts`
(`SMURG_COMMITTER = { name: 'smurg', email: 'daemon@smurg.invalid' }`), `main-repo.ts` (two reads: the branch and the
index), `people-changes.ts` (new: who changed a path on the main workspace's side, used here and by D14), `store.ts`
(merge `auto`), `core/interfaces.ts` (`WorktreeService.autoMerge`, `pendingMergeParent`, the outcome type);
`packages/daemon/src/core/fakes/worktrees.ts` (the fake implements them for the topics tests).

**Shape.**

```ts
autoMerge(input: {
  readonly requestId: string;
  /** The host whose standing consent this is (the commit's author, the audit's `onBehalfOf`). */
  readonly host: UserRef;
  /** What the item's Start pinned: the branch and the checkpoint commit (folder git; absent for smurg's own history). */
  readonly pin: { readonly branch?: string; readonly commit: string };
  /** `host-setting`, or `update-default` while the host has not seen the 0.7.0 notice (D4). */
  readonly consent: 'host-setting' | 'update-default';
  /** D6: still `merge` for this request? Synchronous; asked inside the queue at entry and just before `git merge`. */
  readonly stillInOrder: () => boolean;
}): Promise<AutoMergeOutcome>;

/** The merge parent `updateFromMain` recorded in this worktree and no snapshot has committed yet (D8), else null. */
pendingMergeParent(worktreeId: string): string | null;

type AutoMergeOutcome =
  | { kind: 'merged'; request: MergeRequest; mergeCommit?: string; files: number; overlap: readonly string[] }
  | { kind: 'conflict'; request: MergeRequest; paths: readonly string[]; people: readonly PeopleChange[] }
  | { kind: 'wait'; reason: 'typing' | 'git-busy' | 'retry'; paths?: readonly string[]; lock?: LockInfo }
  | { kind: 'hold'; reason: 'policy' | 'local-changes' | 'in-the-way' | 'staged' | 'branch' | 'history-changed' | 'merge-failed' | 'undo-interrupted';
      paths?: readonly string[]; expected?: string; current?: string }
  | { kind: 'gone' };                                          // no longer a draft or an unrequested conflict, or no longer in order (stillInOrder)

/** A path the main workspace's side changed outside this plan's work items (people-changes.ts). */
type PeopleChange = { path: string; by: readonly UserRef[]; outside: boolean };
```

**Body.** `approve` and `autoMerge` share one private `decide(found, decider, how)` on the `main` queue (one merge at a
time for the whole workspace), so every check of 0.6.0's approval runs in both. `how` carries what differs: the
audit action and actor (automatic: `worktree.merge.auto`, actor `SYSTEM_ACTOR`, `onBehalfOf` the host; the host's own:
`worktree.merge.approve` as today), so `markConflict`, `recoverFailedMerge` and `assertNotLocked`, which audit through
`auditDecision` (`worktree-manager.ts:1844-1856`), write `worktree.merge.auto` entries with outcome `error` / `denied`
for an automatic try and never an `approve` entry (R-ENG E12). In this order:
1. The request is `draft`, or `conflict` with no `requestedBy` (automatic; `approve` keeps 0.6.0's statuses); else
   `gone`. `stillInOrder()` (D6); false → `gone`. Its commit exists (else `hold: merge-failed`).
2. **The branch guard, folder git only (new; U1 M12, U2 exp3).** `git symbolic-ref -q HEAD` must be
   `refs/heads/<pin.branch>` and `git merge-base --is-ancestor <pin.commit> HEAD` must succeed; else `hold: branch` with
   `expected` and `current` (a detached HEAD: `current` = the short commit). A pin without `branch` in folder git
   (detached at Start, D3) never reaches here: its policy is `host`. The host's own `approve` keeps 0.6.0's behaviour
   (the host merges where the host is), but its dialog names the branch (D19).
3. Busy markers (`main-repo.ts BUSY_MARKERS`): `wait: git-busy` (approve: today's `merge.mainBusy`). In the folder's own
   `.git` a `MERGE_HEAD` that equals the commit of a request smurg was merging and whose `MERGE_MSG` carries the
   `Merged-by: smurg` trailer is smurg's own leftover of a crash (R-SAFE S22, R-ENG E13): the wait and the hold it
   becomes say so (`decision.inTheWay.git-busy.smurg` {item}: "smurg was merging work item {item} when it stopped:
   finish it with git commit, or run git merge --abort"); smurg never touches the host's `.git` state itself. An `undo`
   record still in worktrees.json that the start could not settle (D14 step 7, case d) → `hold: undo-interrupted`.
4. **Nothing staged, folder git (new for both; U2 A8, `vt/staged.test.ts`).** `git diff --cached --quiet HEAD` exit 1
   → `hold: staged` (approve: refused with the new `merge.staged` instead of 0.6.0's "merge failed": git's `ort` refuses
   any staged change, even in a file the merge does not touch).
4b. **The cheap look first** (R-ENG E8): the request's own changed paths (`git diff --name-only <its review base>
   <commit>`, objects only) against the locks of the MAIN root: a lock on one of them → `wait: typing` with the first
   lock, before any snapshot, trial or `git status` (so a person typing makes no hidden commit and no trial per retry).
5. smurg's own history: `docs.flushAll`, the snapshot `pre` as the host, the recorded base, a stale `index.lock`
   removed (as `approve`); a changed history → `hold: history-changed`.
6. The policy again, always with `requesterIsHost` false for an automatic merge (R-SAFE S12: `approve` takes it from
   `requestedBy`, `worktree-manager.ts:1612`, and a host's own request was made with the host-only policy waived; smurg
   never merges under that waiver): a violation → `hold: policy` with the paths.
7. The trial (`merge-tree --write-tree`, with `--merge-base` for smurg's history). Not clean → the request is marked
   `conflict` (0.6.0's `markConflict`, so the plan and the merge list say so), and **who changed the other side** is
   looked at (R-SAFE S2): `peopleChanges({ repo, from: <the trial's merge base>, to: pre, paths: <the conflicted
   paths> })`; the outcome is `conflict` with the paths and `people` (the queue decides what follows, D8).
8. Locks on touched files of the MAIN root (`assertNotLocked`'s list, now of the trial's whole change): `wait: typing`
   with the first lock (names come from it); no `denied` audit entry per attempt (the queue audits once, D8).
9. Dirty touched files (folder git) → `hold: local-changes` (paths); untracked or ignored entries where the merge adds
   one → `hold: in-the-way` (paths). Nothing is overwritten, as in 0.6.0. (Merging around a person's uncommitted edit on
   other lines, U2 C3, is cut from 0.7.0: §5.)
9b. **Just before the merge** (R-SAFE S3, R-ENG E1): the branch guard of step 2 again and `mainHead === pre` (folder
   git; smurg's own history: the hidden HEAD is still `pre`), else `wait: retry`; then, synchronously, `stillInOrder()`
   again, false → `gone`; then step 10 is spawned with no `await` in between. (What is left is the time `git merge`
   itself runs: a Pause, a setting or a "Leave it out" that lands then finds the merge done, which the words say, D11,
   D15, B.2.)
10. The merge: `git merge --quiet --no-ff --no-edit --no-verify --no-stat --no-overwrite-ignore -m <message>
    <commit>` with the author the host (`gitIdentity(host)`), the committer `SMURG_COMMITTER` (new
    `GitRunOptions.committer`: `GIT_COMMITTER_NAME`/`_EMAIL` from it, the author from `identity`), and the message
    `mergeCommitMessage(branch, whose, message)` + `\n\nMerged-by: smurg (automatic merging, the host's setting)`. A
    failed `git merge`: `recoverFailedMerge` as today (with MERGE_HEAD: `merge --abort`, then `conflict`); without
    MERGE_HEAD → `wait: retry` (the queue makes the second one in a row `hold: merge-failed`).
11. Recorded: status `merged`, `auto: true`, `decidedAt`, `mergeCommit`; `requestedBy` stays absent (nobody asked); the
    review ref deleted; `publishMerge` (the bus `merge.changed` reaches the scheduler's `onMerge` as for the host's
    merge, which writes the item's `mergedAs`, D8); the audit entry `worktree.merge.auto` (actor `SYSTEM_ACTOR`, outcome
    `ok`, detail `{ requestId, worktreeId, commit, mergeCommit, topicId, itemId, files, consent, onBehalfOf:
    host.userId, overlap: [≤ 20 paths], history? }`); the activity line `activity.mergeAuto { item, starter }`
    attributed to smurg. `overlap` (U2 exp1 #3) is the paths the item changed that the main workspace changed too since
    the item's START (`pin.commit`, not the updated base: R-SAFE's resolve-over-person run shows the updated base
    gives `[]` where the Start's gives `[config.txt]`), with `git diff --name-only`; it is recorded, never a reason to
    wait (U2 C6: re-verifying per overlap is quadratic and fights "let it run"; the Result column and the "ready to
    check" design carry cross-item checks).

**Who changed the other side** (`worktree/people-changes.ts`, R-SAFE S2; also D14's `changedSince`). The main
workspace's first-parent history from `from` to `to` (`git rev-list --first-parent --reverse from..to`) is the list of
changes that landed on it. A first-parent commit that is a recorded merge of a work item (some request's `mergeCommit`
in worktrees.json) carries an agent's work; every other first-parent commit that touches one of the paths (`git diff
--name-only C^1 C -- <paths>`) is a change outside this plan's work items: the folder's own git, by its author (a
member when the author's email is smurg's form `<slug>@users.smurg.invalid`, `names.ts:72-76`, else `outside`: a
commit the host or a tool made outside smurg, often the host committing teammates' edits); smurg's own history, where
every such commit is a snapshot of the folder, by the activity log's writers of that path between the commit's first
parent and the commit (an agent session's write is named by its responsible person; none named → `outside`). This
fixes D14's earlier wording too: "the authors of the non-merge commits" would have named the agents' own worktree
commits, which are authored as their session's owner.

**A merged request's diff** (for the Result column, D13): nothing changes (R-ENG E11). `review(repo, merge)` already
shows a merged request against `mergeCommit^1` (`worktree-manager.ts:1781-1782`), so `worktree.merge.diff` and
`.fileDiff` work for merged requests today; the tip stays the request's commit, so the hidden-history base check
(`:1786`) is untouched. For an item that went through update-and-resolve the diff is its change against the main
workspace it was brought up to date with: a line its resolution replaced shows as removed, also when a person had
written it (D13's note says so). A merged request without `mergeCommit` ("already up to date") has an empty file list.
Same capability as today (`file.read`): every member, viewers included, may read it.

**smurg's own history after a crash** (U4 (3): "Finish it, then merge" for an operation the host cannot see). At the
worktree module's start, before the first command on `.smurg/git`: a `MERGE_HEAD` or `REVERT_HEAD` there can only be
smurg's own (no person and no agent runs git there: D8a deny rules of 0.6.0), so smurg aborts it (`merge --abort` /
`revert --abort` with the hidden-history runner), logs it, and audits `worktree.merge.auto` (or `.approve` when the
interrupted merge was the host's) outcome `error` with `reason: 'recovered-after-crash'`. In the folder's own `.git` a
busy marker is the host's and is never touched (step 3 names smurg's own leftover).

**Tests** (worktree, the real git on PATH, ≥ 2.42, skipped loudly otherwise; U2's scripts as the model): a clean
automatic merge (author the host, committer smurg, the trailer, `auto: true`, the audit entry with `consent`, the
activity line); a conflict marks the request and returns `conflict` with the paths, and its audit entry is
`worktree.merge.auto` outcome `error`, not `approve`; staged index → `hold: staged`, and `approve` now refuses with
`merge.staged` (was `merge.failed`); a busy marker → `wait: git-busy`; smurg's own leftover `MERGE_HEAD` in `.git` is
named as smurg's; a human lock on one of the request's own files → `wait: typing` with NO hidden snapshot and no trial
taken (the hidden HEAD unchanged), merged after the lock goes; a dirty touched file → `hold: local-changes`, the folder
untouched; an untracked file in the way → `hold: in-the-way`; the branch switched (`git checkout -b experiment` after
Start) → `hold: branch` with both names, nothing merged (U1 M12's case); a detached HEAD → `hold: branch`; `git
checkout -b x` after the trial and before the merge (a hook in the fake runner) → `wait: retry`, nothing on `x`;
`stillInOrder` false at entry, and false at step 9b (a fake that flips after the trial) → `gone`, nothing merged, the
request not marked; a policy violation → `hold: policy`; a `pending` request and a `conflict` that keeps `requestedBy`
→ `gone`; the policy is checked with `requesterIsHost` false also when the request was the host's; who changed the other
side: folder git, a conflict with a host's commit names the host (smurg's email form) and one with a commit from
outside names nobody (`outside`), one with an earlier item merged by the queue or by the host names nobody and is not
a person's change; smurg's own history, R-SAFE's resolve-over-person setup: Bo's saved edit is named from the activity
log; `overlap` from the Start's commit; smurg's own history: a person's edit since the base is kept (U2 exp2), the
recorded base checked; `MERGE_HEAD` left in `.smurg/git` is aborted at the start; a merged request's diff unchanged
from 0.6.0.

### D8. The merge queue: `AutoMerger`

**Files.** `packages/daemon/src/topics/auto-merge.ts` (new: `AutoMerger`), `topics/module.ts` (composition, bus
listeners), `scheduler.ts` (`onMerge` the one writer of `mergedAs`; `afterRestart` also for items that resolve; the
finish rule, D12), `report-service.ts` (the turn count and `checked[].turn`, `checkedInTurn`, `lastTurn`,
`changesAsked` at a turn's end, the forced snapshot while an item resolves; the sweep calls `autoMerger.sweep()`;
`register()` wakes it; a new version clears a hold), `core.ts` (`toWorkItem`), `store.ts`, `prompts.ts` (D17),
`plan-service.ts` (`resolveItem` resets nothing: a person's resolve is not counted; `leaveOut` waits for a merge in
flight, D11; `release`, D9).

**One queue per workspace.** `AutoMerger.request()` asks for a pass (several requests while one runs become one more
pass, like the scheduler's `drain`). A pass runs inside `core.serialize('auto-merge', …)`, so the module's stop
(`core.idle()`, `module.ts:168-178`) waits for it and nothing is written after the module stopped; it looks at
`ctx.stopping.aborted` before each `autoMerge` and ends there when set (R-ENG E3). A pass:
1. collects every item of every open topic whose verdict (D6) is `merge` or `verify`, or that is `waiting` or `held`
   with a reason that clears by itself (`typing`, `git-busy`, `retry`, `behind`, `local-changes`, `in-the-way`,
   `staged`, `branch`, `undo-interrupted`) AND whose re-check is due (below);
2. orders them by the time their current report version was registered (first in, first out), then the topic's
   creation, then the item's number;
3. for each, in order: a `verify` is sent without the worktree module (below); a merge calls `worktrees.autoMerge`
   with `stillInOrder` (D6) and the `consent` (D4), one at a time (the `main` queue), and applies the outcome (below);
   after a `merged` outcome the next one is tried against the new main, and the scheduler's `onMerge` (through the
   bus) moves what waited for it to `queued` and starts it.

**Triggers** (each only `request()`s): `report.changed` (a new version); `session.updated` of an item session (a turn
ended, a card closed); `question.changed`, `permission.changed` (closed); `lock.changed`; `file.changed` of the main
root; `merge.changed` (a merge or a rejection anywhere); a settings change of `merging`; `topic.changed` (paused,
resumed, archived); `workspace.git`; and the reports' sweep (`escalationSweepMs`, 5 s), which is also where holds are
escalated and long waits become holds. Nothing has a timer of its own.

**Re-checks, not every sweep** (R-ENG E8: each try of a waiting item costs a `docs.flushAll`, a hidden snapshot as the
host, a trial and `git status --untracked-files=all` on the one `main` queue, so a 5-second retry would commit a
person's typing into smurg's own history every 5 s and block the host's own merges and Starts on a large folder). Each
waiting or self-clearing item has a re-check time, kept in memory (after a restart every one is due once):
- `typing`: when `lock.changed` releases a lock on one of its paths (D7 step 4b knows them before any snapshot);
- `local-changes`, `in-the-way`: when `file.changed` names one of its paths in the main root, or `workspace.git`;
- `staged`, `branch`, `git-busy`, `undo-interrupted`: when `workspace.git` says HEAD, the index or a busy marker moved;
- and each of them at the latest `AUTO_MERGE_RECHECK_MS` (60 s) after its last try (git operations in the host's
  terminal do not all reach the watchers);
- `retry`: the next sweep (5 s), once; `behind`: when the item it waits behind is merged or held.
The sweep itself only escalates, turns long waits into holds and runs what is due.

**What each outcome does** (the item's `autoMerge` record, D4; `since` is set when the state or the reason changes):
- `merged` → `autoMerge` removed; the conversation line `conversation.merged.auto`. `mergedAs` is written by ONE place,
  the scheduler's `onMerge` (R-ENG E3): `{ requestId, commit: mergeCommit, at, by: request.auto ? 'smurg' : <the
  host> }`, so `reconcile` (`scheduler.ts:669-698`, which repairs an item through `onMerge` after a kill between
  worktrees.json and topics.json) writes the right one for both kinds.
- `conflict` with `people` not empty → `held: conflict` with the paths and the people, for the item's carers, at once:
  no automatic try (R-SAFE S2). Whose lines stay is a person's decision; R-SAFE's `resolve-over-person.sh` shows the
  agent keeping its own `price: 12` over Bo's saved `price: 15 (Bo: agreed with the client)`, the resolved version
  merging cleanly and unread, and nobody told. The carers may still choose "Ask the agent to resolve" (`plan.item.
  resolve`), and its message then says which files hold a person's change and that it stays (D17).
- `conflict` with `people` empty (the other side is only other work items) → while `mergeTries < AUTO_MERGE_TRIES` (3):
  if another item is `resolving` with conflicted files that overlap these paths, `waiting: behind` (it is tried again
  after that one's next version is merged: one resolution at a time per file set); else **update and resolve**
  (below). When the tries are spent: `held: conflict` with the paths. (`mergeTries` is its own stored key, D4: a new
  version ends the `resolving` record but not the count, so a conflict that keeps coming back ends as a decision, never
  as a loop.)
- `wait` → `waiting` with the reason (`typing` with the lock's paths; `retry` once; a second `retry` in a row →
  `held: merge-failed`). `git-busy` that has lasted 10 minutes (`AUTO_MERGE_BUSY_HOLD_MS`) → `held: git-busy`, host only
  (the host's terminal is mid-merge or rebase; it clears by itself).
- `hold` → `held` with the reason, `hostOnly` from the reason (D9), the paths.
- `gone` → nothing (a newer version is its own candidate; an item no longer in order is looked at by the next pass).

**Verify again** (D6 row 13, R-SAFE S4): the queue records `resolving: stale-report` for the current version (persisted
first), writes the line `conversation.verifyAgain` and sends `verify-again` without `by` (D17: "You changed files
after your report was last checked: verify again, update the report and call check_report"). It is not a merge try
and is sent once per version: at the end of that turn, a `check_report` of this same content in the turn with no file
edited sets `checkedInTurn` on the version (no new version) and the record goes; a new version is decided as any; a
turn that does neither → `held: stale-report` for the carers.

**Update and resolve** (U2 C4; 0.6.0's `resolveItem` without a person), in this order, so that a crash at any point is
taken up at the next start (below; R-ENG E2):
1. record `resolving: conflict`, `mergeTries + 1` and persist (`core.flush()`);
2. `worktrees.updateFromMain(worktreeId)` (smurg commits the work, merges main into the checkout with `--no-commit`,
   lists the conflicted files, `merge --quit`, records the merge parent in worktrees.json);
3. the line `conversation.update.auto { count }` and the message `resolve-conflict` WITHOUT `by`, whose text names the
   items merged since this one's base: `resolveConflictMessage({ conflicted, mergedBefore: [{ number, id }] })` (fixed
   English, ids pattern-checked, titles never quoted; D17).
The next registered version is snapshotted with its second parent and goes back into the queue as a new draft. The
snapshot is taken again at a turn's end whenever the turn carried `resolve-conflict` (0.6.0, `report-service.ts:
216-217`), OR the item is `resolving: conflict | markers`, OR its worktree has a merge parent not committed yet
(`pendingMergeParent`), at a turn's end and in `checkAfterRestart` alike. It gives up at once, `held: conflict`, when
`updateFromMain` is refused for an untracked file in the checkout or the item has no live session (ended, failed: the
failure has its own path, D15). Markers left in the checkout WITH a recorded merge parent are smurg's own update not
finished: the resolve message is sent again with the files that still have markers, not counted as a try. A resolve
turn that ends without a new version follows the existing path (nudge, then `stalled(agent)`, an attention item for
the item's carers), and the `resolving` record goes with the stall.

`resolve: markers` (D6 row 8) sends the same message with the files that still have markers, `resolving: markers`,
`mergeTries + 1`.

**After a restart** (R-ENG E2; `scheduler.ts afterRestart` looked only at `running` items, `:734`, and a `done` item that
resolves is not one): every item whose `autoMerge.state` is `resolving` is looked at too, in the same pass as D15's:
- its report file was checked in the turn the restart cut (`checked[]` holds its current hash for its session with
  `turn === turns + 1`) → `checkAfterRestart` registers it with the forced snapshot, `checkedInTurn` set;
- else a merge parent is recorded (`pendingMergeParent`) → the resolve message again, after the line
  `conversation.continued.restart`, no new try;
- else (the kill came between step 1 and step 2's record) → steps 2 and 3 again, no new try;
- `resolving: stale-report` → the `verify-again` message again.
A kill between an automatic `git merge` and its worktrees.json record: the next pass merges the same request, `git
merge` answers "Already up to date" (its commit is an ancestor of HEAD), and it is recorded `merged`, `auto: true`; the
merge commit is found by its second parent (D14 step 1's search) and recorded.

**Clearing a hold** (the `autoMerge` record goes, and the item is a candidate again; `mergeTries` stays): a new report
version; Start again or Try again (these also reset `mergeTries`); "Leave it out" (D11); "Merge it as it is" for
`asked`, `stopped` and `stale-report` (D9); the host's merge or rejection of its request (a rejection becomes `held:
rejected`, for the carers: follow up or leave it out); the workspace's setting turned to `host` (every record goes and
the pins are rewritten, D3; 0.6.0's flow shows); the topic archived; for the reasons that clear by themselves, a due
re-check that finds the main workspace no longer in the way.

**Audit.** `worktree.merge.held` (actor `SYSTEM_ACTOR`) once for each change INTO `held` (detail `{ topicId, itemId,
requestId, reason, paths ≤ 20, people ≤ 20, tries }`); `worktree.merge.auto` for each merge (D7), for each automatic
try that ended in a conflict, a denial or an error (D7's `how`), and for an error of the queue itself (outcome
`error`). Waits are not audited (they would be one entry per lock and per re-check).

**Words in the item's conversation** (Appendix B.1): `conversation.merged.auto` ("smurg merged this work item into the
main workspace (automatic merging, the host's setting)"), `conversation.update.auto { count }` ("smurg brought the main
workspace's changes into this checkout: {count} files have conflicts. It asked Claude to resolve them and verify
again"), `conversation.verifyAgain`, `conversation.held { reason }` (one line when the item is held, the reason's short
words).

**Tests.** auto-merge.test (topics, with the in-memory fakes): FIFO order across two topics; a wait does not block the
next candidate; `behind` (two items conflicting on one file: one resolution, then the other is tried after the first
is merged); tries counted, `held: conflict` after three; a conflict whose `people` is not empty is held for the carers
at once, zero tries; a second `retry` → `merge-failed`; `git-busy` → hold after 10 minutes of the daemon's clock;
clearing by a new version, by Leave it out, by "Merge it as it is", by the setting; nothing merges while the plan is
paused; **the races** (R-SAFE S3, R-ENG E1): the fake `main` queue held (a slow fake checkpoint) with an `autoMerge`
queued behind it, then a Pause, the setting to `host`, Leave it out, an Undo of the topic, an archive, a follow-up and a
new turn of the item, each in its own case, then the queue released: nothing is merged, the request is not marked;
**re-checks**: an item that waits 60 s of the daemon's clock on a person's lock, with the 5-second sweep running, makes
no hidden commit and no trial until the lock goes, then merges; `local-changes` re-checked on `file.changed` of its
path and at 60 s, not before; **verify again**: a resolve turn that only rewrites the report gets `verify-again`, a turn
that checks and changes nothing then merges it, one that does not ends `held: stale-report`; **after a restart**: kills
during the resolve turn before and after `check_report`, after `updateFromMain`, and after the record each converge to
merged with no person; a kill between `git merge` and its record is recorded at the next pass with `auto: true`; a stop
during a pass, then a start: `mergedAs.by` is `'smurg'` and the commit recorded; the audit entries. Stand-in integration
(`integration/release-flow.unattended.test.ts`, D22): a conflict between two items resolved by the item's agent and
merged with no person; a conflict with a member's saved edit (smurg's own history, R-SAFE's setup) held for the
carers with the member's name and nothing merged; the plan of U1 converges with zero clicks.


### D9. Decisions: what stops, who decides, what goes on

**The reasons** (`packages/protocol/src/schema/topics.ts`, one enum for the wire's `WorkItem.autoMerge.reason` and the
inbox item's `reason`):

```ts
export const AUTO_MERGE_REASONS = [
  // waiting: nobody is needed, smurg tries again by itself
  'queued', 'paused', 'busy', 'asked', 'typing', 'git-busy', 'behind', 'retry',
  // resolving: the item's own agent brings its work up to date, or checks its report again
  'conflict', 'markers', 'stale-report',
  // held: a person decides (the host alone for the second line)
  'partial', 'blocked', 'check-failed', 'not-verified', 'report-invalid', 'rejected', 'stopped',
  'policy', 'local-changes', 'in-the-way', 'staged', 'branch', 'history-changed', 'merge-failed', 'by-hand', 'undo-interrupted',
] as const;   // `conflict`, `stale-report`, `asked` and `git-busy` appear in two states: still resolving / waiting, then held
export const AUTO_MERGE_STATES = ['waiting', 'resolving', 'held'] as const;
/** The holds only the host can settle; the others go to the item's carers (D9 routing). */
export const HOST_HOLDS = ['policy', 'local-changes', 'in-the-way', 'staged', 'branch', 'git-busy', 'history-changed', 'merge-failed', 'by-hand', 'undo-interrupted'] as const;
/** Holds that end by themselves once the host's main workspace is no longer in the way (the queue looks again, D8). */
export const SELF_CLEARING_HOLDS = ['local-changes', 'in-the-way', 'staged', 'branch', 'git-busy', 'undo-interrupted'] as const;
/** Holds the carers may end with "Merge it as it is" (`plan.item.release`): the version stands as it is. */
export const RELEASABLE_HOLDS = ['asked', 'stopped', 'stale-report'] as const;
```

The waits `queued`, `paused`, `busy`, `asked` are not stored: `toWorkItem` computes them from the verdict (D6). Every
hold, whether the verdict computes it (D6 rows 5–13) or the worktree module reports it (D7), is stored by the queue as
the item's `autoMerge` record (D4) the first time a pass or the sweep sees it, with `since` and later `escalatedAt`
(so escalation and the one `worktree.merge.held` entry work alike for all), and goes when the verdict no longer gives
it (D8 "Clearing"). A `conflict` hold with a person's change carries `people` (D7) on the wire.

**Who decides** (`packages/protocol/src/routing.ts`, so a row, a refusal and the plan agree):

```ts
/** Whose inbox holds a work item's decision: as a permission request (the host for HOST_HOLDS; the responsible person
 *  while they hold `session.drive` and it has not escalated; else the host and every member with agent access). */
export function decisionRecipients(decision: { readonly hostOnly: boolean; readonly escalated: boolean }, session: Pick<SessionRouting, 'responsible'>, members: RoutingMembers): string[] {
  return permissionRecipients(decision, session, members);
}
```

The item's responsible person is the session's (`AgentSession.responsible`), else the plan's record, as for reports.
A hold that is not the host's escalates after the host setting `escalateAfterMs` (5 minutes by default; the reports'
sweep compares stored times with the clock, as for questions): `autoMerge.escalatedAt`, and the host and every member
with agent access have it too. A host-only hold never escalates (nobody else could settle it).

**What each offers** (the report column's foot of the held item, D19; every action exists today unless marked new):

| reason (short words, B.2 `hold.*`) | the carers (responsible, or after escalation agent access) | the host |
|---|---|---|
| `partial`, `blocked` ("not complete"), `check-failed` ("a check failed"), `not-verified` ("no check passed"), `report-invalid` ("the report cannot be read"), `rejected` ("the host did not merge it") | write a follow-up from the report ("Ask the agent to fix it", `report.followUp`); "Request merge" (agent access); "Leave it out…" (new, D11) | the same, and "Merge…" (0.6.0's changes column: the full diff, "Merge into the main workspace") |
| `conflict` ("it does not merge cleanly"; with a person's change: "it conflicts with {names}'s change of {path}" or "…with a change made outside smurg") | "Ask the agent to resolve" (`plan.item.resolve`, not counted as a try; with a person's change its message says which files hold it and that it stays, D17); "Leave it out…" | the same, and "Merge…" (to read the conflict) |
| `asked` ("{name} wrote to the agent after its report"), `stopped` ("its last turn did not finish"), `stale-report` ("its report was not checked again after its last change") | write a follow-up ("Ask the agent…"); "Continue" (for `stopped`); "Merge it as it is" (new `plan.item.release`); "Leave it out…" | the same, and "Merge…" |
| `policy` ("files only the host may merge", with the paths) | (not theirs) | "Ask the agent to take them out" (new `plan.item.removePaths`: the message `remove-paths` with the paths, D17); "Request merge" on the item's worktree (the host's own request passes the policy, as in 0.6.0), then "Merge…"; "Leave it out…" |
| `local-changes`, `in-the-way`, `staged`, `branch`, `git-busy` (the main workspace is in the way) | (not theirs) | what to do in the folder (commit or undo the named edits, move the named files, unstage, switch back to the branch, finish the merge or rebase); "smurg merges it by itself once that is done" |
| `history-changed`, `merge-failed` ("smurg cannot merge it") | (not theirs) | "Merge…" (the error in words), "Leave it out…" |
| `by-hand` ("{names} edited files of it by hand", with the paths) | (not theirs) | "Merge…" (the full diff: read the hand edits, then merge), "Leave it out…" |
| `undo-interrupted` ("an undo was interrupted in the main workspace") | (not theirs) | what to do in the folder (`decision.inTheWay.undo-interrupted`); "smurg merges it by itself once that is done" |

**"Merge it as it is"** (new; R-SAFE S7, S4). `plan.item.release { topicId, itemId, version }` → `{ plan }`, capability
`session.drive`, checks `topic-open`: a carer says that the current version stands although somebody wrote to the
agent since, a later turn was stopped, or the report was not checked again. Refused when the item is not held for one
of `RELEASABLE_HOLDS` (`plan.item.release.notHeld`) or the version is not the current one (`report.changed`). It clears
`changesAsked` and `lastTurn` and sets `checkedInTurn` on the version, audits `plan.item.release` (the reason and the
version), and the queue merges the item if it is otherwise in order. An Editor (no `session.drive`) cannot: a person who
may stop the agent decides that its work stands.

**The inbox kind `decision`** (`packages/protocol/src/schema/inbox.ts`; derived in `packages/daemon/src/inbox/
derive.ts` from the plans: no new world fact):
- `INBOX_KINDS` + `decision`; `inboxKindWaits('decision') === true` (amber, a toast, the tab title's count);
- fields: required `topicId`, `itemId`, `item`, `reason`; optional `sessionId`, `unblocks`, `outcome`, `checks`,
  `waitsFor`, `waitsForOffline`, `escalated`, `alsoFor`, `alsoForMore`; `INBOX_KIND_FIELD_NAMES` + `reason`;
- key `decision:<topicId>.<itemId>`; stamp `<reason>:<since>` (a new reason makes it unread again); target the item's
  report column (`{ kind: 'report', topicId, itemId }`); excerpt `''`;
- `unblocks`: the numbers of the plan's items that wait for it, transitively (today `unblocks` exists for merges only);
- it leaves when the hold goes (D8 "Clearing").

**What goes on.** The scheduler's per-dependency gate (`unmergedDependencies`, scheduler.ts:180-184) already holds only
the item's dependents: a held item is not merged, so what depends on it waits and everything else runs (U1 M3, M7).
The plan says it: dependents read "Waits for a decision on {items}" (`badge.waitsDecision`), the plan's banner names
the first decision, `PlanInfo.waitingFor[]` gains `decisions: index` per person (the decisions in their inbox), and
`WorkItem` gains `waiting?: 'question' | 'permission'` while its session waits for a person (U1: the plan read
`running` for an item whose session waited, M3, M7).

**Already decisions in 0.6.0, kept as they are**: an agent's question (the decider, escalating after 5 minutes or 1 when
they are offline); a permission request (G10, G11a, G12 host only; three refusals of Claude Code's check in a row, to
the responsible person; every command in the ask modes); a disarmed item (`plan-changed`, `starter-removed`,
`start-failed`: Start again); an item stopped by a person or stopped in prose after the nudge (`stalled(agent)`,
`stalled(stopped)`, `stopped`); a repeated crash (D15); the account logged out (the host's terminal); a refused model.
Their attention items stay; only their rows gain `unblocks` (the attention kind's optional fields gain `unblocks`, and
`question` and `permission` too).

**Tests.** routing.test (`decisionRecipients` = `permissionRecipients` for both kinds of hold, escalated or not);
inbox schema tests (the kind's fields; `waiting` true); derive.test (a held item's row for the responsible person; after
escalation also the host and agent access; a host hold for the host only, `by-hand` among them; `unblocks` transitive;
the row goes when the hold does); core: `toWorkItem` computes `queued`/`paused`/`busy`/`asked` and the computed holds
and copies the stored record; `waiting` from the session; `waitingFor.decisions`; the sweep escalates after
`escalateAfterMs` and never a host hold; plan-service: `plan.item.release` clears `asked`, `stopped`, `stale-report`,
refused for another hold, for an old version and for an Editor; stand-in (R-SAFE S7's case): pause the plan, a member
writes to a done item's agent and presses Stop on that turn, then "Continue all": nothing merges, and the responsible
person has a decision `stopped`; an Editor's hand edit in an item's worktree holds it for the host (`by-hand`), an
agent-access member's does not; U1's M3 and M7 still stop only their item and its dependents, now with `unblocks` on the
rows.

### D10. Direct mode: an unfinished report no longer lets dependents start

**Why.** `report-service.ts:422`: an item that ran directly in the folder counts as merged when its report registers,
whatever the report says (`partial`, `blocked`), so its dependents start on unfinished work (U1 #18, U3 A7(e)). This is
a bug in both merging settings, and is fixed in both.

**Behaviour** (`report-service.ts register`, direct branch): the item counts as merged at registration only when the
report is complete and verified (D5) and was checked in the turn that produced it (D6 row 13; else the report service
sends `verify-again` once, as the queue does); otherwise it is `held` with the reason of D6 rows 10–13 (`partial`,
`blocked`, `check-failed`, `not-verified`, `stale-report`) for the item's carers, and its dependents wait. The carers write a follow-up or press
Continue (the agent finishes the work: a new version decides again), or "Leave it out…"; the host may press "Accept as
it is" (new, `plan.item.accept { topicId, itemId, version }`, capability `worktree.merge.decide`: the host only): the
item counts as merged, `mergedAs = { at, by: host }`, the hold goes, the audit entry `plan.item.accept` names the
version and the outcome, the scheduler runs. Refused when the item is not a held direct item
(`plan.item.accept.notHeld`) or the version is not the current one (`report.changed`, exists).

**Tests.** stand-in (no-git.test with `gitPath` missing): a direct item with `partial` is held, its dependent waits, the
host's Accept starts it; Continue → a complete version → merged by itself; a member's `plan.item.accept` is refused.

### D11. "Leave it out"

**Why.** Today the only way to drop one item is to edit PLAN.md, which changes the plan's hash and disarms EVERY armed
item of the topic (U1 #22). A team that left a plan running needs to say "not this one" without stopping the rest.

**Request.** `plan.item.leaveOut { topicId, itemId }` → `{ plan }`, capability `session.drive` (members with agent
access; the host), checks `topic-open`. Refused for an item that is merged (`plan.item.leaveOut.merged`: undo is the
way back for that, D14) or not in the plan. **A merge in flight** (R-SAFE S3): when the item, or one of the dependents it
would leave out, is the AutoMerger's merge in flight ("Merging…", already past D7's last `stillInOrder`), `leaveOut`
waits for that merge's outcome (`AutoMerger.whenSettled(topicId, itemId)`) and then decides on what is true: merged →
`plan.item.leaveOut.merged` for the asked item, and a dependent that merged is not left out (the dialog's list is
computed again and the answer's plan shows it). Any other moment: D6's `stillInOrder` sees `leftOut` and nothing
merges.

**Behaviour** (`plan-service.ts leaveOut`, in one topic update): the item and every item of the plan that depends on it,
transitively, and is not merged: `leftOut = { by, at }`; `armed = false`, `retry = false`; `autoMerge` removed; a live
session is ended (`agents.end(…, { reason: 'ended', keepWorktree: true })` after the line `conversation.ended.leftOut
{ name }`); `state` = `stopped` when it had a session, else `not-started`. Its draft stays in the worktree list (as any
ended item's: the worktree is kept with its changes). The audit entry `plan.item.leaveOut` names the item and the
others. A left-out item counts as settled for the end (D13). "Try again" (a stopped one) and Start (a not-started one)
clear `leftOut`. The dialog (D19) says what goes with it before anything changes: "Leave out {item}? Its change is not
merged. {items} depend on it and are left out too."

**Tests.** plan-service: transitive dependents left out, a running one ended, the others untouched and still running; a
merged item refused; a leaveOut sent while the fake `main` queue holds the item's merge after its last `stillInOrder`
waits and answers `plan.item.leaveOut.merged`; one sent before that ends with nothing merged; Start and Try again clear
it; the topic becomes ready when the rest is settled; the audit entry.

### D12. Review becomes a mark; when an item is finished

**Under automatic merging** (`mergingOf(item) === 'auto'`):
- "I've reviewed this" stays (same label, same rules: `mayReview`, `acknowledgeUnfinished` for an unfinished report)
  and marks the version; it is no longer a condition of the merge, of the phase or of the host's inbox. The draft's
  `reviewed` flag is still set (0.6.0's `setReviewed`), and is harmless.
- The per-item report rows (`deriveReports`) are left out for these items, and so is their escalation (the reports'
  sweep skips them): a held item has its decision row instead, and the end has the ready row (D13). The host's merge
  rows (`deriveMerges`) leave out their `draft` requests and the `conflict` requests nobody requested (the decision
  row covers a conflict); a `pending` request (somebody pressed "Request merge"), and a `conflict` that keeps its
  `requestedBy` (`approve` marks a pending request `conflict` too, `worktree-manager.ts:1638, :1653`), stay the host's
  row as today, and smurg never merges them (D6 row 15, R-SAFE S12).
- The report column's lead and state say what happened (B.2 `review.lead.auto`: "smurg merged this change into the main
  workspace at {time}: its report says complete, at least one check passed and none failed. Mark it reviewed when you
  have read it; that changes nothing in the folder.").

**Under the host's merge** (`'host'`, and every 0.6.0 item): everything as in 0.6.0.

**When an item is finished** (`scheduler.ts finish`, replacing the condition at :586): it is merged, its CURRENT
request is the merged one (as today), its worktree holds nothing unmerged (as today), and it is reviewed **or its topic
is checked** (D13). Until then its session (parked, no slot) and its clean worktree stay, so that a follow-up from the
report still reaches the agent that did the work, and a change it makes is snapshotted, goes into the queue and merges
like the first one (U2 C7, U3 B6). Archiving ends them as today. `report.closed` gets new words (B.1: "This work item
is finished: its change is in the main workspace and its session has ended. Ask in the topic's discussion: the plan
can get a new item.").

**Direct items** finish as in 0.6.0 (reviewed) or when the topic is checked; the end line stays
`conversation.ended.reviewed`, and a check gives `conversation.ended.checked`.

**Tests.** scheduler: an automatically merged item keeps its session and worktree until reviewed or checked; a
follow-up after the merge makes a new draft that merges by itself; the host's flow unchanged (merged and reviewed);
derive: no report row for an auto item, the host's row for a host item; the sweep escalates host items only.

### D13. The end: "Ready to check", the Result, "I've checked the result"

**Phase** (`TOPIC_PHASES` gains `ready`, between `executing` and `complete`; `core.ts phaseOf`):
- an item is **settled** when it is left out or undone, or when it is merged with its current request merged (an
  accepted or in-order direct item: merged at registration) AND nothing of it is still in progress (R-SAFE S10): no
  decision of it is open, its session has no open turn and no open card, it has no `changesAsked` and no follow-up
  waiting for its answer, and its worktree holds nothing unmerged (`worktrees.unmerged`, D12's finish rule). A
  follow-up turn still running on a merged item is therefore not settled, and neither is the change it left;
- `complete` ⇔ the topic is checked (`topic.checked`), or every item of the plan is settled AND reviewed (R-SAFE S9,
  R-ENG E7). 0.6.0's rule (every item reviewed, `core.ts:387-391`) is not kept: under automatic merging "I've reviewed
  this" is a mark anyone who may discuss can set, also on an unfinished report (`acknowledgeUnfinished`), so a team
  that marks every report would make the topic `complete` while an item is held: the ready row would never come,
  `topic.check` would be refused, the decision row would stay, and a hold that clears later would merge into a
  complete topic unannounced;
- `ready` ⇔ not complete, started, and every item of the plan is settled;
- `executing` otherwise once anything was started; the earlier phases as today.
(U1: today `complete` with 1 of 3 merged, M1. Two changes to the host's flow, both truthful: a host's topic whose every
item was merged but not reviewed reads `ready`, and one whose every item was reviewed but not all merged reads
`executing` (it waits for the host's merges) instead of `complete`. 0.6.0's words for the latter,
`complete.body.unmerged` "(in the host's inbox)", can no longer be shown and go.)

**Topic wire** (`topicSchema`): `checked?: { by: UserRef, at: epochMs }`; `plan` gains `leftOut: index`, `undone:
index` beside `merged`, and `pausedBy?: UserRef` (D15).

**Request.** `topic.check { topicId }` → `{ topic }`, capability `discuss` (not Viewers), checks `topic-open`. Refused
unless the phase is `ready` (`topic.check.notReady`). It sets `checked`, audits `topic.check`, publishes, and runs
`finishPending` (every merged item's session ends with `merged`, its worktree is released; a direct item's ends with
`conversation.ended.checked`). A later Start of more items clears `checked` (the plan has new work: `executing`), and so
does a report version registered after the check (an item whose finish could not run yet, D12: its new change is not
settled, so the topic is executing again and its ready row comes back once it is).

**The inbox kind `ready`** ("Ready to check: {topic}" / 「待驗收：{topic}」):
- for EVERY active member, Viewers included (they read files; the brief: "the team is told");
- `inboxKindWaits('ready') === false` (nothing stands still), unread once;
- fields: required `topicId`, `tally`, `checks`; `tally = { items, merged, leftOut, undone }` (new field), `checks` the
  sum over the merged items' reports (`passed`, `notVerified`, `failed`);
- key `ready:<topicId>`, stamp `ready`, target `{ kind: 'result', topicId }` (a new `ColumnTarget` kind), excerpt the
  topic's name; it leaves when the topic is checked or archived, or is not `ready` any more.

**Open pages** get a toast from the phase change (web `topicNoticeKind`): `notice.ready` ("{name}: every item is
merged. Ready to check.") and, after the press, `notice.checked`. With nothing open the inbox row is what a person who
comes back sees first, and `smurg host` prints `host.topicReady` (D18). No browser or OS notification exists (U3): out
of scope (§5).

**The Result column** (web, new `apps/web/src/features/topics/ResultColumn.tsx`; the session list's fixed rows gain
"Result" after "Plan" for topics `ready` or `complete`). Built from what the page can already ask: the plan, each
item's report (`report.get`), each merged request's diff (`worktree.merge.diff` / `.fileDiff`, which already work for
merged requests, D7). Top to bottom:
1. the summary line: "{merged} of {total} merged · {passed} passed · {failed} failed · {notVerified} not verified
   [· {leftOut} left out · {undone} undone]";
2. "Not verified" checks first, with their reasons, item by item; then the passed ones;
3. "What the items changed": the files with + / −, which item changed each, and each item's diff of each file, with the
   note `result.changes.note`: "Each item's change against the main workspace it was merged into. A line an item
   replaced shows as removed, also when a person had written it." (R-SAFE S2: the earlier note said people's edits are
   not part of it, which is false for an item whose resolution replaced a person's line);
4. "What to watch out for", item by item, in the agents' own words;
5. "Work items": each with its badge, a link to its report, its review mark, and the host's "Undo…";
6. "Left out and undone";
7. the foot: "I've checked the result" (holders of `discuss`), its lead, "To change something, ask in the discussion:
   the plan can get a new item, which runs the same way.", and for the host "Undo the whole topic…".
For a topic of direct items the diff part says `result.direct` ("These items ran directly in the shared folder: smurg
keeps no history of them and cannot show or undo their changes. Their reports say what they changed.").

**Tests.** core phase table (settled per kind; host topic merged and reviewed → complete; host topic all reviewed, one
not merged → executing; auto topic merged → ready; every item reviewed, one held → executing; a merged item whose
follow-up turn runs → not settled; left out and undone count; a Start clears `checked`; a version after the check
clears it); topic.check (refused before ready, by a Viewer; ends the sessions); derive (the
ready row for every member including a Viewer, leaves at the check); protocol (the phase, `tally`, the target);
web ResultColumn.test en + zh-TW (order of the parts, the direct note, the check button absent for a Viewer); smoke (D22).


### D14. Undo, where history exists

**Who.** The host (`worktree.merge.decide`): merging is the host's authority, and so is taking a merge back. Members
read "Ask the host to undo" (`undo.askHost`). It exists for items merged into the folder's own `.git` or smurg's own
history, whoever merged them (smurg or the host); direct items have none (D13's note; the Start dialog of 0.6.0 says so
already: `start.direct.body`).

**Requests** (`packages/protocol/src/schema/messages/topics.ts`; both long-running, the page waits 5 minutes as for
`worktree.merge.request`):

```ts
topicUndoPreviewPayloadSchema = z.strictObject({ topicId, itemIds: z.array(itemIdSchema).min(1).max(PLAN_ITEMS_MAX).nullable() });  // null: the whole topic
topicUndoPayloadSchema       = topicUndoPreviewPayloadSchema.extend({ token: sha256HexSchema });
/** `topicName`: the item's topic, so an item of ANOTHER topic taken back with it is named with its topic (R-SAFE S13). */
const itemRef = z.strictObject({ topicId: opaqueIdSchema, topicName: topicNameSchema, itemId: itemIdSchema, number: indexSchema, title: itemTitleSchema });
undoPreviewSchema = z.strictObject({
  token: sha256HexSchema,                       // what the apply must echo: what the undo does (step 5)
  history: z.enum(['folder', 'smurg']),
  undone: z.array(itemRef.extend({ why: z.enum(['asked', 'built-on', 'same-lines']) })).max(UNDO_ITEMS_MAX),   // 64
  leftOut: z.array(itemRef).max(UNDO_ITEMS_MAX),           // items not merged that wait for one of them or stand on it
  blockers: z.strictObject({
    running: z.array(itemRef).max(UNDO_ITEMS_MAX),         // a dependent in a turn: wait for it or stop it
    changedSince: z.array(z.strictObject({ path: entryPathSchema, by: z.array(userRefSchema).max(5), outside: z.boolean() })).max(20),
    typing: z.array(z.strictObject({ path: entryPathSchema, names: z.array(userRefSchema).max(5) })).max(20),
    uncommitted: z.array(entryPathSchema).max(20),
    staged: z.boolean(),
    busy: z.boolean(),
    branch: z.strictObject({ expected: shortBranchSchema, current: shortTextSchema }).nullable(),
    unavailable: wireTextSchema.nullable(),                // direct items; smurg's history gone; a merge commit not found
  }),
  ok: z.boolean(),                                         // no blocker at all
});
// 'topic.undo.preview' (c2d, worktree.merge.decide, checks topic-open) → undoPreviewSchema
// 'topic.undo'         (c2d, worktree.merge.decide, checks topic-open) → planResultSchema
```

**Mechanism** (U2 D1, measured in `U2/exp/scripts/exp1..7`; `packages/daemon/src/worktree/undo.ts`, new, used by
`WorktreeManager.undoPreview` / `undo` on the `main` queue):
0. **smurg's own history: the snapshot comes first, in the preview and in the apply** (R-SAFE S1). `docs.flushAll`,
   then `snapshotHidden` as the host, then everything below against the head that snapshot leaves. R-SAFE's
   `undo-order.sh` (real git 2.49, U2 exp2's setup) shows why the order is not a detail: computing the trial against
   the last snapshot and taking the snapshot afterwards (the order the earlier text allowed) made the undo commit take
   back Bo's two saved edits, in `b.txt` (a file the item never touched) and on line 9 of `a.txt`, with no error from
   `read-tree` (the snapshot had just made the index match the folder); snapshot first, both edits stayed and the undo
   commit changed only `a.txt`. In the folder's own git people's uncommitted edits are not in HEAD, so `read-tree -m -u`
   keeps an untouched dirty file and refuses a touched one (step 4).
1. The merge commits: each request's `mergeCommit` (worktrees.json), else the item's stored `mergedAs.commit` (D4:
   worktrees.json keeps only 300 decided merges), else the merge whose second parent is the request's commit
   (`rev-list --merges --parents <base>..HEAD`, U2 exp3); none → `unavailable`.
2. What goes with them (stated before anything changes, U2 D2): (a) the merged plan dependents of the asked items,
   transitively (`built-on`, always included: their work stands on it); (b) later merges of ANY topic whose revert
   must come first: the trial below conflicts, then smurg adds later merges newest first that touch a conflicted file
   until the trial is clean, then removes again each one whose removal keeps it clean (`same-lines`; U2 exp5: a
   file-level rule gives false positives, the trial does not); each is named with its topic; (c) what still conflicts
   after that is a change outside the work items: `changedSince`, from `peopleChanges` (D7: the first-parent changes
   that are not recorded merges, by their author or the activity log's writers; `outside` when no member made it); (d)
   `leftOut`: the items of the plan that are not merged and wait for, or stand on, an undone item, whatever their state
   (armed, not started, done, held: a done or held dependent started from the merged state, so its work stands on what
   is taken back; R-SAFE's queue race made this visible); a dependent in a turn is a blocker (`running`) instead.
3. **Trial, objects only** (nothing in the folder is touched): newest first, `git merge-tree --write-tree --merge-base
   <M> <current> <M^1>`, chained through `commit-tree` (0.03 s per merge on a 5,000-file repository; 20 chained in
   0.33 s: U2 exp7). The tree it ends with, with the undone items' report files (`specs/<slug>/reports/<item>.md`)
   overlaid from the current head, is what the folder becomes: the reports stay (U2 exp1 #9).
4. Checks of the main workspace, as for a merge, but reported, not waited on (undo is a person's act): a lock on a
   touched file → `typing`; uncommitted edits in a touched file (folder git) → `uncommitted`; staged → `staged`; a busy
   marker → `busy`; a merge commit that is not an ancestor of HEAD, or HEAD not on the item's Start branch → `branch`;
   smurg's own history changed or gone → `unavailable` (its words of 0.6.0). Dependents in a turn → `running`.
5. The preview's `token` = sha256 of what the undo DOES: the merge commits it reverts in order, the sorted request ids
   of `undone`, the ids of `leftOut`, and whether the trial is clean. Not the head: in smurg's own history every saved
   edit moves the snapshot head, and a token over it would answer "Look again" in any folder people work in; an edit
   that matters (the same lines) changes `changedSince` and `ok` instead.
6. **Apply**, inside the `main` queue: step 0 (smurg's own history), then steps 1–4 again against the head the apply
   now has; refused with `undo.changed` ("Something changed since you looked. Look again.") when the token differs and
   with `undo.notOk` when `ok` is false; then the record `worktrees.json.undo = { requestIds, pre, target, repo?, at }`
   (`pre` the head, `target` the tree of step 3) is persisted; then `read-tree -m -u HEAD <target>` (it refuses a dirty
   touched file again: "not uptodate", U2 exp3) and ONE commit as the host (author and committer: the host's own act),
   subject `smurg: undo work item <n> (<id>) of <slug>` or `smurg: undo topic <slug>`, body one line per merge, newest
   first: `This reverts commit <M>, reversing changes made to <M^1>.` (the standard words; the crash check reads them).
   Then each request gets `undone = { commit, at, by }`, the record goes.
7. **A crash during the apply** (R-SAFE S11: a kill after `read-tree -m -u` and before the commit leaves the folder
   changed and the undo staged, which "none → the record goes" would have left as staged changes the host never made,
   or in smurg's own history as an anonymous change while the plan still says merged). At the worktree module's start,
   a remaining `undo` record is settled before any merge:
   (a) a first-parent commit since `pre` whose body names every M → that is the undo: recorded now;
   (b) HEAD is still `pre` and the index's tree (`git write-tree`, objects only) is `target` → the commit was not made:
       smurg makes it now, as the host who asked, with the same words, and records it;
   (c) HEAD is `pre`, the index's tree is `pre`'s, and every path that differs between `pre` and `target` is in the
       folder as in `pre` → nothing was changed: the record goes;
   (d) anything else (the index or the folder between the two). In smurg's own history, where nobody but smurg runs
       git: smurg sets the index to `target` (`read-tree <target>`, no `-u`), writes `target`'s version of every
       touched file that still holds `pre`'s version (`checkout-index` of those paths only; a file that holds neither
       is a person's edit since and stays as it is, to be recorded by the next snapshot), and makes the commit as in
       (b). In the folder's own git: the record stays and every automatic merge and every undo of the workspace is
       `held: undo-interrupted` for the host (D7 step 3), with what to do (`decision.inTheWay.undo-interrupted`:
       commit the staged undo, or put the named files back with `git restore --staged --worktree -- <paths>`); the
       queue's re-check settles it by (a), (b) or (c) once the folder is one of those, and the hold clears by itself.

**Topics** (`plan-service.ts undo`). Before the worktree's apply, the undo **claims** its items in the topics module (a
transient in-memory mark over the undone items of every topic and the `leftOut` ones; D6 row 2), so no merge of one of
them starts between the worktree's commit and the topics' record (R-ENG E1); the claim goes after the topics half, or
when the apply fails. After the apply: every undone item: `undone = { by, at, commit }`, `merged = false`, `mergedAs`
removed, `autoMerge` removed, `state = 'not-started'`, `armed = false`; a live session is ended after the line
`conversation.ended.undone { name }` and its worktree released (re-merging reverted commits does nothing: "Already up to
date", U2 exp1 #7, so a new start needs a FRESH worktree from the current main); the `leftOut` items are left out as in
D11 (by the host). A Start (the dialog) starts an undone item again, from the main workspace as it is now. The topic
stays `complete` when it was checked; else its phase follows D13. Audit `worktree.merge.undo` (actor the host; detail
`{ topicId, requestIds, goesWith, leftOut, commit, files, history }`); activity line `activity.undo`.

**What undo cannot take back** (R-SAFE S13), said in the dialog (`undo.body` and `undo.body.smurg` gain it) and in
HOSTING §10.3 "Undo and its limits": it takes back the files the merges changed in this folder, and nothing else; what
the agents' commands did elsewhere (other folders, installed tools, services or databases they called) is not undone;
in the folder's own git, a branch already pushed keeps the merge in the remote until the undo commit is pushed too;
items of other topics taken back with it are named with their topic, and their sessions end too.

**Not in 0.7.0** (§5): "Bring it back" (revert the undo commit; in the folder's own git the host can `git revert <the
undo commit>` and HOSTING §10.3 says so), unticking a dependent in the dialog, and taking an item back by an agent in a
checkout (U2 D2's "Undo in a checkout": a new item of the plan does the same through the normal path).

**Tests** (worktree, real git, U2's scripts as the model): one item undone in one commit, its report kept; the whole
topic in one commit newest first after a host commit elsewhere; a plan dependent goes with it (`built-on`); a later
merge of another topic on the same lines goes with it (`same-lines`, named with its topic) and one on other lines of
the same file does not; a person's later commit on those lines blocks it, named by its author, and an earlier item's
merge on them is not a person's; **R-SAFE's undo-order case in smurg's own history**: a person's saved edit made after
the last snapshot, in an untouched file and on an untouched line of a touched file, survives the undo, and the undo
commit changes only the item's file (preview and apply both); smurg's own history: names from the activity log; a
dirty touched file, a lock, staged, busy, another branch: each reported and nothing changed; the token refuses a stale
apply and does NOT refuse an apply after an unrelated saved edit; a kill after the commit and before the record is
recorded at the next start; **a kill between `read-tree -m -u` and the commit**: smurg's own history finishes it at the
next start (case b, and case d with a file a person edited meanwhile, which stays); the folder's own git: case b
commits, case d holds the merges as `undo-interrupted` and clears once the files are restored; a merge with no recorded
commit is found by its second parent; topics: undone items not started, sessions ended, worktrees released, dependents
left out (a done-but-unmerged dependent too), Start again makes a fresh worktree; an automatic merge of a dependent
queued behind the undo's apply does not merge (the claim); a Viewer's and an Editor's `topic.undo.preview` refused.

### D15. Keeping it running

**After a restart of `smurg host`, plans go on by themselves** (0.5.0's AD-10 and HOSTING §10.5 said "nothing runs by
itself"; this is the one documented promise 0.7.0 reverses, §5). Reasons: a restart is not a decision about the work;
the person who restarts `smurg host` is at the terminal (no service restarts it), and its update needs a restart (`smurg
update` refuses while a host runs), so every update stopped every plan; the start's checks still run before anything
starts (the pin check, the history check, 0.6.0 D15). What changes (`scheduler.ts afterRestart`, `plan-service.ts`):
- sessions that were mid-turn are `stalled` (`restart`) as today; the plan is NOT paused, except (1) a topic a person
  paused (`plan.pausedBy`), which stays paused, and (2) a topic that has an interrupted item running directly in the
  shared folder (D15 of 0.6.0: its half-done change is in the folder, which has no history): that topic is paused as in
  0.6.0, for the host;
- once restored, the scheduler knows which interrupted items of topics that are not paused go on, and which items that
  were resolving (D8) are taken up; the pin and history checks run in the same pass, before anything starts. **The
  continues are sent only after `smurg host` has said so** (R-SAFE S16: Ctrl-C was the documented brake, AD-10 and
  HOSTING §10.5, and a host who stopped smurg host because an agent misbehaved must read what goes on before it does):
  the daemon sends them in `Daemon.goOn()`, which `smurg host` calls right after it printed its start lines
  (`host.plansContinue`, D18); a daemon started without the CLI (`createTestDaemon`, the e2e harness) goes on at the end
  of its start. Each gets `continue-item` (without `by`) after the line `conversation.continued.restart`. A continue
  that cannot be sent (the session cannot be resumed: no `claude`, a test daemon without `selfCommand`,
  `testing/harness.ts:62`) leaves the item `stalled(restart)` with its attention item and is not counted as an
  automatic continue;
- the rule at every start is one: a topic is paused when a person paused it (`pausedBy`) or when it has an interrupted
  direct item that nobody continued yet; any other pause (`paused` without `pausedBy`: a 0.6.0 restart's, or a direct
  topic's whose host has continued that item since) is lifted. So a topic a 0.6.0 restart left paused goes on at the
  first 0.7.0 start;
- the daemon keeps what goes on (`Daemon.continued(): { topics: { name, items }[] }`, known before `goOn()`) for
  `smurg host`'s line at the start (D18), and the topics a person paused (`host.plansPaused`);
- **on the published fixtures** (R-ENG E9: S6 changes what every test daemon started on a fixture copy does, through
  `daemon-on.ts startOn`): 0.6.0 paused every topic with armed or interrupted items (`attention.ts:19-21`,
  `scheduler.ts:747-750`). At the first 0.7.0 start that pause has no `pausedBy` and is lifted; the armed items go
  through the pin check against the copy's project folder, which holds no `SPEC.md` or `PLAN.md`, and are disarmed
  (`plan-changed`); the interrupted ones get their continue, which cannot be sent there (no `selfCommand`), so they stay
  `stalled(restart)`. The opens, refusals and unfinished tests and the CLI's `host-state-file.test.ts` (its exact start
  output on the 0.5.0 fixture, `PAUSED_050`) expect exactly that from S6 on.

**Pause** (new; the brake that survives a restart). `plan.pause { topicId }` → `{ plan }`, capability `session.drive`,
checks `topic-open`: `paused = true`, `pausedBy`, `pausedAt`; nothing new starts, nothing merges, nothing continues by
itself; turns that run finish, and so does a merge already inside `git merge` (D7 step 9b; the words say so); a person
who wants the turns to stop stops the sessions. `plan.resume` ("Continue all", as
today) clears it and sends `continue-item` to interrupted items. The attention item `plan-paused` stays (the host and
agent access), now with who paused (`excerpt`: the topic; the row's words name the person from the plan). Audit
`plan.pause`.

**Automatic continues, each bounded and audited** (`plan.item.autoContinue`, actor `SYSTEM_ACTOR`, detail `{ cause,
count }`; the item's `autoContinue` record, D4; a line in the conversation names why; every count is reset by a
person's message, Continue or Try again, and by a new report version). They apply to a turn after a registered version
too (a follow-up turn, a resolve turn), which 0.6.0 left as it was: while the continue is due the item waits (`busy`,
D6 row 4), and once the bound is spent `lastTurn` stays and the item is `held: stopped` (D6 row 6). These turns run
with nobody watching, in the item's own permission mode (§3 point 6):
- **usage limit** (U1 M5): an item whose turn ended `error` while the account says `usage-limit`
  (`agents.account().state`) is stalled with `autoContinue = { cause: 'usage-limit' }`; when `account.changed` says `ok`
  again (at `resetsAt`, or with the next turn of any session that goes through), each such item gets `continue-item`,
  line `conversation.continued.usageLimit`. No count limit (it never runs while the account is limited).
- **a broken turn** (ended `error`, not usage limit, not logged out, not a process failure, not a refused model): at
  most twice per item, 1 minute and then 5 minutes after the stall (`AUTO_CONTINUE_DELAYS_MS = [60_000, 300_000]`,
  compared on the reports' sweep), line `conversation.continued.error`; after that it stays `stalled(error)` with its
  attention item (U1 #7; a laptop's sleep or a network change).
- **a crash** (the session's process failed, item `failed`; U1 M6): once per item, 1 minute later,
  `agents.retry(sessionId, SYSTEM_PRINCIPAL)` and `continue-item`, line `conversation.continued.crash`. `retry` takes a
  system principal already (it names "smurg" in its line and audits that actor, `agent-sessions.ts:1283-1291`), and
  `SYSTEM_PRINCIPAL`'s null role keeps 0.6.0's host-only rule after three failed starts (`permissions.ts:9`), so the
  step adds only the scheduler's bounded call and its audit detail `{ cause: 'crash', count }` (R-ENG E15); a second
  failure stays `failed` (the host, or agent access, decides with "Try again").
- **a failed snapshot** (`snapshotOwed`, report-service.ts:302-332): once, 1 minute later, `continue-item` (the next
  completed turn retakes it), line `conversation.continued.snapshot`.
- Never by itself: an item stopped by a person (`stalled(stopped)`, `stopped`, and a turn after a version that ended
  `interrupted`: `held: stopped`), stopped in prose after the nudge (`stalled(agent)`: the agent could not finish, U1
  #19), a logged-out account, a paused plan.

**Tests.** stand-in (release-flow.restart.test changes on purpose): after a restart interrupted items continue and
finish with no click; with `goOn` deferred nothing is sent before it is called; a paused plan stays paused across a
restart; a topic with an interrupted direct item is paused; a 0.6.0 folder whose plan was paused goes on at the first
start; `plan.pause` stops starts, merges and continues and survives a restart; usage limit → continued at `resetsAt`
(daemon clock); a broken turn continued twice then stalled, and the same for a follow-up turn of a done item, which then
is `held: stopped`; a crash resumed once with `SYSTEM_PRINCIPAL` then failed; a snapshot retried once; a continue that
cannot be sent leaves `stalled(restart)`; the audit entries; `Daemon.continued()`; upgrade tests: the fixtures' armed
items disarmed, their interrupted items `stalled(restart)`, no topic paused.

### D16. Sessions that wait for a person do not stop unrelated items

**Why** (U1 M10): with `maxLiveAgents` 2 and two sessions waiting for an answer, an unrelated queued item waited four
hours. Waiting sessions keep their process (a card holds a tool call open) and are never parked.

**Rule** (`scheduler.ts pass`, `core.ts slots`): a queued item may start while `inUse − waitingForPeople < max` and
`inUse < min(2 × max, maxAgentProcesses)` (`maxAgentProcesses` 32, config.ts). So at most `max` item processes WORK at
once, as today, and up to `max` more may be held by sessions that wait for a person. `slots` on the wire is unchanged
(`inUse`, `max`, `waitingForPeople`); the queued badge's words already say "{n} wait for a person".

**Cost** (HOSTING §10.4 says it): a waiting process stays at its size (210 MB fresh, up to 600 MB after many turns on
the development machine, ARCHITECTURE §7.6), so the worst case doubles the item processes' memory; a host who cannot
afford it lowers "Agents at once" (`maxLiveAgents`).

**Tests.** scheduler: two waiting of two → a third starts; four of two (two working, two waiting) → no fifth; the cap at
`maxAgentProcesses`; U1 M10 converges.

### D17. Role prompts and smurg's messages (fixed English, not catalogs)

`packages/daemon/src/topics/prompts.ts`:
- `executionRolePrompt` gains `merging: 'auto' | 'host'` (the session's item's policy when it starts; a later change of
  the setting does not rewrite a running prompt, and the sentence is true either way because it says "may"). With
  `auto`, after "Do not commit, push, merge or change branches. smurg records your changes when you are done.":
  "When your report says complete and no check failed, smurg may merge your work into the shared folder without a
  person reading it first, and other work items then start from it: write complete only when the item is done as
  described, and write a check you ran that did not pass as failed. After any change you make, also after resolving a
  conflict or answering a follow-up, verify again and call check_report in that same turn: smurg merges a version only
  when its report was checked in the turn that made it."
- `REPORT_FORMAT` (both role prompts): the failed line and its sentence (D5).
- `resolveConflictMessage({ conflicted, mergedBefore, peopleChanged })`: when `mergedBefore` is not empty, it adds
  "Other work items were merged before yours: <n> (id <id>), …. Keep their changes." (numbers and ids only: ids are
  pattern-checked, titles never quoted). When a person asked to resolve a conflict whose other side is a person's
  change (D8, `peopleChanged` = those paths, a JSON list of at most 50), it adds "In these files the other side is a
  change a person made in the main workspace, not another work item's: <JSON list>. Keep that change and fit yours to
  it, unless the person who asked you to resolve says otherwise." (paths only: names are people's text and never
  reach the model through smurg's messages).
- `verifyAgainMessage()` (new; purpose `verify-again`, `SMURG_PURPOSES` + it; D6 row 13): "You changed files after your
  report was last checked. Verify again, update the report so that it says what you verified now, and call
  check_report. Do not run git." 
- `removePathsMessage({ paths })` (new; purpose `remove-paths`, `SMURG_PURPOSES` + it): "smurg does not merge changes
  to these files, which only the host may change: <JSON list, at most 50>. Undo your changes to them, keep the rest of
  your work, verify again, update the report and call check_report. Do not run git."
- `continueItemMessage()` is reused by every automatic continue (D15); the line in the conversation, not the message,
  says why.
- `directExecutionRolePrompt`: the failed line only (no merge there).

**Tests.** prompts.test (the sentences; ids only in `mergedBefore`; paths only and at most 50 in `peopleChanged` and
`removePathsMessage`; `verifyAgainMessage`; the direct prompt without the merge sentence).

### D18. Telling the host and the team

**The update** (as 0.6.0 D13 did for auto mode):
- `smurg host`, one line (`packages/cli/src/commands/host-state.ts mergesAutoNotice(daemon)`, printed after
  `host.upgraded` and `host.agentsAuto`): when this start ran the state step from 0.6.0 (an `upgraded` entry for `state`
  whose `from` is 0.6.0 or older), message `host.mergesAuto` (B.3; it names HOST guide §10.3, whose heading
  "Merging, and what waits for it" then can never be renamed: its anchor joins `packages/cli/test/guide-anchors.test.ts`).
- The inbox and the console: `state.json.hostNotices` holds `auto-merge`; the settings service derives the attention
  fact `{ subject: 'auto-merge', id: 'workspace', recipients: [host], target: { kind: 'console', section: 'settings' } }`
  (`ATTENTION_SUBJECTS` + `auto-merge`, `inboxKindWaits` false); the console's Settings shows the banner
  `settings.mergesAuto.banner` with "Got it" (`admin.notice.seen { notice: 'auto-merge' }`); an `admin.settings.set`
  that names `merging` removes it too.
- HOSTING §9.2 gets the 0.7.0 paragraph.

**At every start** (after the update lines): `host.plansContinue { topics }` when D15 has anything to continue ("2
topics go on where they stopped: Checkout (2 work items), Search (1). To pause one, press Pause in its plan."), printed
BEFORE anything goes on: `smurg host` prints it and only then calls `Daemon.goOn()` (D15, R-SAFE S16); and
`host.plansPaused { topics }` for topics a person paused ("Paused by a person, and still paused: Checkout. Continue it
in its plan."). Nothing else is added to the start summary (the owner's rule of 2026-10-01: links, and what needs an
action).

**When it stops** (R-SAFE S16: where the brake is pulled). Ctrl-C of `smurg host` (`host.ts`, after its own stop lines)
and `smurg stop` (`stop.ts`; the control socket's `stop` answer gains an optional `goOn: index`, ignored by a 0.6.0
command) print `host.stopping.goOn { n }` when n > 0, n being the topics that would go on at the next start (started,
not paused, with an item that is not settled): "When smurg host starts again, 2 topics go on by themselves; to keep one
stopped, press Pause in its plan first." Nothing is printed for n = 0.

**While it runs** (`packages/cli/src/commands/host.ts watchTopics`, on the in-process bus, like `watchRelay`): one line
per change, never at the start:
- `host.topicReady { name, merged, total }` when a topic's phase becomes `ready` (`topic.changed`);
- `host.topicWaits { name, number, title, reason }` when an item gets a HOST hold (`plan.changed`, compared with what it
  printed: once per item and reason).

**`smurg status`**: the control socket's `status` answer's `topics` (`{ total, paused }` since 0.5.0,
`packages/daemon/src/local/protocol.ts:100`) gains optional `running`, `decisions`, `ready` (the command side's schema
at :240 is a plain `z.object`, so a 0.6.0 command ignores them); `status.topics` (printed by
`packages/cli/src/commands/stop.ts:140`) reads "Topics: 3 (1 running, 1 waiting for a decision, 1 ready to check)",
the parts that are zero left out.

**Tests.** cli unit (host-state-words.test): `mergesAutoNotice` for a state upgraded from 0.6.0 and from 0.4.0, not
otherwise; the two start lines, `host.plansContinue` printed before `goOn` is called (a fake daemon records the order);
`host.stopping.goOn` at Ctrl-C and in `smurg stop`, absent for 0; `watchTopics` prints each line once; status line;
guide-anchors.test (the anchor);
daemon: the attention fact for the host only, gone after `admin.notice.seen` or a `merging` setting; SEA:
sea-upgrade.test sees the line.


### D19. The web app

Every text is a catalog id of Appendix B.2 in both languages (`strings.ts` / `strings.zh-TW.ts` of each feature).

**Start dialog** (`apps/web/src/features/topics/start-model.ts startLines`, `StartDialog.tsx`; U3 B1). After the
"waits" lines, when `preflight.merging` is not null:
- with the choice `auto`: `start.merge.auto` {host} (smurg merges each item whose report says complete and verified,
  for the host, and what waits for it starts from the merged workspace), `start.merge.stops` (what stops the run, and that the rest
  goes on), `start.merge.end` (every member's inbox says when the topic is ready to check), `start.leave` {host} or
  `start.leave.host` ("You can close this page…");
- with the choice `host` (or the workspace's `host`): `start.merge.host` {host} and `start.leave`; on a detached HEAD
  `start.merge.detached` before them;
- `start.commit` (folder git) adds the branch: "…and merges each item into that branch" (`start.commit.branch`);
- the choice itself, beside model and mode (`start.agent.merge`: "How its items are merged"), shown when
  `merging.workspace === 'auto'` and not `detached`: `start.merge.option.auto` ("smurg merges what its report says is
  complete and verified (workspace setting)"), `start.merge.option.host` ("The host merges each item"); selected first:
  `merging.proposed`; `plan.start`
  sends `merging: 'host'` for the second.
- The direct block (0.6.0's `start.direct.*`) is unchanged: no merge, no undo.

**Plan** (`PlanColumn.tsx`, `PlanItems.tsx`, `model.ts`; U3 B2):
- headline `summary.merged` "{merged} of {total} merged" when any item of the plan merges automatically; else 0.6.0's;
- progress line: `progress.decisions` "{count} wait for a decision" replaces "reports to review" for those items;
- banners: `plan.auto.running` (info, while executing with automatic merging); `plan.decision` (warning: "{item} was
  not merged: {reason} {who} decides. The items that do not depend on it go on.", with "Open"); `plan.paused.by`
  ("{name} paused this plan. Nothing starts or merges until someone continues it." with "Continue all"); the ready
  banner `ready.title` / `ready.body` with "Open the result"; after the check `complete.checked` {name, time};
- the foot: `foot.autoMerge`; "Pause" (`plan.pause.action`, agent access) while executing; `foot.nextMerge` only for
  items that wait for the host;
- badges (`model.ts itemBadge`; the 0.6.0 set stays for items the host merges): `badge.merging` "Merging…",
  `badge.resolving` "Bringing its work up to date", `badge.mergedAuto` "Merged", `badge.mergedReviewed` "Merged ·
  reviewed", `badge.waitsToMerge` {name} "Waits to merge: {name} is editing", `badge.held` {reason} "Not merged:
  {reason}", `badge.waitsDecision` {items}, `badge.undone` "Undone", `badge.leftOut` "Left out", `badge.question` /
  `badge.permission` (exist) now from `WorkItem.waiting`;
- `badge.waitsMerge` ("Waits for the host to merge {items}", 0.6.0) only when every item it waits for is reviewed AND
  that item's `merging` is `host` (R-SAFE S17: `model.ts:203-208` computes it from `reviewStands` alone, which under
  automatic merging names the host for an item that is waiting, held or resolving); otherwise `badge.waits` or
  `badge.waitsDecision`;
- the item's actions gain "Leave it out…" (agent access) and, merged, the host's "Undo…".
- `complete.body.unmerged` goes (D13: a complete topic has no unmerged item any more).

**Report column** (`ReportColumn.tsx`; U3 B4, B6): failed checks (D5); under automatic merging the lead
`review.lead.auto` and the state `report.state.mergedAuto` {time}; a held item's foot `decision.foot` {reason, who,
items} with the actions of D9's table for the viewer's role (`decision.fix`, `decision.removePaths`,
`decision.accept`, `decision.asIs`, `decision.leaveOut`, existing `review.merge`, `review.request`, `item.resolve`,
`item.continue`), for a `conflict` with a person's change the line `decision.people` {path, names} per path (or
`decision.people.outside` {path}), and for a self-clearing hold the sentence of what to do
(`decision.inTheWay.<reason>`).

**Result column** (new `ResultColumn.tsx`, registered with the column slots for the target `result`; D13); the session
list's fixed row "Result" (`apps/web/src/features/sidebar/tree-model.ts`).

**Dialogs** (`TopicDialogs.tsx`, `dialogs.ts`): "Leave it out" (`leaveOut.title`, `leaveOut.body` {item, items},
"Leave out"); "Undo" (`undo.title` {item} / `undo.title.topic` {topic}, then the preview: `undo.body`,
`undo.builtOn` {items}, `undo.sameLines` {items}, `undo.leftOut` {items}, a blocker list `undo.blocked.*`, the button
"Undo" disabled unless `ok`); no confirmation for Pause.

**Inbox and session list** (`apps/web/src/features/sidebar/inbox-rows.ts`, `InboxList.tsx`, `strings.ts`): the row
kinds `decision` (amber: `title.decision` {item, reason}, facts `fact.unblocks`, `fact.decides`, `fact.notDecided`) and
`ready` (`title.ready` {topic}, facts `fact.tally`); the attention subject `auto-merge` (`inbox.attention.mergesAuto`);
`inbox.empty.viewer` (Viewers get mentions and topics ready to check); the group label `group.phase.ready`.

**Notices and stores** (`apps/web/src/lib/stores/topics.ts topicNoticeKind`, `app/workspace/WorkspaceShell.tsx`):
`notice.ready`, `notice.checked`; `strings/stores.ts` `phase.ready`, `kind.decision`, `kind.ready`;
`strings/workbench.ts` `empty.first.execute` (U3: "Run and check").

**Console** (`apps/web/src/features/console/SettingsSection.tsx`, `settings-form.ts`, `audit-labels.ts`): the setting
"Merging work items" (`settings.merging`, options `settings.merging.auto` / `settings.merging.host`, hint
`settings.mergingHint`), the banner `settings.mergesAuto.banner` with `settings.agentsAuto.dismiss` ("Got it"); the
changed hint `settings.escalateAfterHint`; audit labels of the new actions.

**Worktree and conversation**: `list.draftsTitle` "Work items not merged yet"; a merged request shows `merge.byAuto`
("Merged by smurg for {host}"); `next.report.*` variants (`next.report.mergedAuto`, `next.report.held`).

**Tests.** Unit, en and zh-TW: start-model.test (the lines per policy and history), StartDialog.test (the choice, the
payload), model.test (the itemBadge table with the new rows), PlanColumn.test (headline, banners, Pause),
ReportColumn.test (failed checks, the decision foot per reason and role), ResultColumn.test, TopicOverlays/dialogs
(leave out, undo preview with blockers and items of another topic named with it), model.test's `badge.waitsMerge`
only for a host dependency, inbox-rows.test, sidebar.test (+ zh-TW), tree-model.test, topics store test
(the two notices), console tests (setting, banner, audit labels), topics.zh-TW.test. Smokes: D22.

### D20. The words

Checked against `docs/GLOSSARY.md` (sentence case, no "please", second person, zh-TW full-width punctuation with a space
between Latin and Chinese, one message per sentence). GLOSSARY gains a table "Terms of 0.7.0" (U3 B0):

| English | 繁體中文 | wire / where |
|---|---|---|
| automatic merging (prose) | 自動合併 | `merging: 'auto'` |
| Merging work items (the setting) | 合併工作項目 | console |
| smurg merges what its report says is complete and verified | 報告寫著完成且驗證過的，由 smurg 合併 | `auto` |
| I merge each item myself / The host merges each item | 每個項目都由我自己合併 / 每個項目都由主人合併 | `host` |
| complete and verified: the report says complete, at least one check passed, none failed | 完成且驗證過 | D5 |
| Failed (a check) | 失敗 | `- [!]` |
| Ready to check (phase) | 待驗收 | `ready` |
| I've checked the result / Checked | 我已驗收 / 已驗收 | `topic.check` |
| Result (the column) | 成果 | target `result` |
| decision / Waiting for a decision | 決定 / 在等一個決定 | kind `decision` |
| Not merged: … | 沒有合併：… | `badge.held` |
| Leave it out / Left out | 略過這個項目 / 已略過 | `plan.item.leaveOut` |
| Undo / Undone | 復原 / 已復原 | `topic.undo` |
| Pause (a plan) | 暫停 | `plan.pause` |
| Bringing its work up to date | 正在跟上主工作區 | resolving |

Fixed sentences for every writer: the checks are what the agent reports, smurg runs none of them: never "smurg
verifies", "smurg tests", "smurg runs the checks" (「smurg 驗證」「smurg 測試」「smurg 執行檢查」); outside the
passages about "The host merges each item", never "the host merges each/every item" as what happens. Kept on purpose:
"I've reviewed this" / 我已看過 (now a mark), "main workspace" / 主工作區, and the anchored headings HOSTING §10.3
"Merging, and what waits for it", JOINING §6 "Topics: from discussion to reviewed result", HOW-IT-WORKS "From
discussion to merged work" (the result is still reviewed at the end; their anchors are held by `apps/site/test/
site.test.ts:1204-1205, :1412` and printed by the CLI).

**The work is never said to be complete and verified, only its report** (R-SAFE S6). smurg checks none of it (§3
point 4: "a model that writes complete over unfinished work is merged"), so every sentence that tells people what smurg
merges says it is the report's claim: "what its report says is complete and verified", "whose report says complete and
verified", "when its report says it is complete and verified" / 「報告寫著完成且驗證過的」. The GLOSSARY row that
defines "complete and verified" is the one place the bare term stands, and it defines it as what the report says.

A lint (`tests/lint/auto-merge-words.test.ts`, modelled on `auto-mode-words.test.ts`) reads the catalogs, the six
guides, the README and the site and refuses, in both languages: the "smurg verifies" family; in English "is complete
and verified", "are complete and verified" and "complete and verified, is merged" in a sentence without "report"; in
zh-TW 「完成且驗證過」 in a sentence without 「報告」; GLOSSARY's definition row is the only exception.

### D21. Docs and site

Every place of U3's inventory (C) changes in both languages in the same step, replacing text, not adding it: the quick
start is at its 12-step maximum (`tests/lint/docs-parity.test.ts:106-108`) and the short pages near their bounds (500
words, 1,250 characters on the built page, `apps/site/test/site.test.ts:1362-1363`; U3 counted HOW-IT-WORKS at about
472 words and 1,264 characters, SECURITY-MODEL at about 490 words: the docs step measures on the built page and raises
a bound only by the sentence that the truth adds, as 0.6.0 did).

**Held sentences** (test-held, word for word):

| place | today (en) | 0.7.0 en | 0.7.0 zh-TW |
|---|---|---|---|
| home page fourth card (`apps/site/public/index.html:214-215`, zh :214-215) and README "What it does" (:70, zh :63) | "Review, then merge" / "Each finished item comes with a result report; a person reads it, and the host merges." | "Merged by itself, then checked" / "Each finished item comes with a result report; smurg merges what its report says is complete and verified, and you check the result." | 「自動合併，最後驗收」/「完成的項目附有一份結果報告；報告寫著完成且驗證過的，由 smurg 自動合併，最後再由你們驗收成果。」 |
| HOW-IT-WORKS step 4 (:40-41) | "Review. … A person reads it and marks it reviewed." | "**Merge.** Each item ends with a result report: what was done, how it was verified, every diff. smurg merges it into your folder, without anyone reading the diff first, when its report says it is complete and verified; anything else waits for a person ([merging](HOSTING.md#103-merging-and-what-waits-for-it))." | 「**合併**：做完的項目附有一份結果報告，寫明做了什麼、怎麼驗證的，以及每一個改過的檔案的 diff。報告寫著完成且驗證過的，smurg 會直接把它合併到你的資料夾，不會先有人讀過 diff；其他的會等人決定（[合併](HOSTING.md#103-合併以及什麼在等它)）。」 |
| HOW-IT-WORKS step 5 (:42-43; held by site.test.ts:1225, :1234) | "Merge. Reviewing does not merge: only you (the host) can merge, after reading the diff" | "**Check.** When every item is merged, everyone is told that the topic is ready to check: the reports, the combined change, what the agents say they verified. You (the host) can undo an item, or turn automatic merging off." | 「**驗收**：所有項目都合併之後，每個人都會知道這個主題待驗收：報告、合起來的變更、agent 說它們驗證了什麼。你（主人）可以復原某個項目，也可以關掉自動合併。」 |
| site.test.ts honest lines (:1225, :1234) | 'Reviewing does not merge: only you (the host) can merge, after reading the diff' | 'smurg merges it into your folder, without anyone reading the diff first, when its report says it is complete and verified' | '報告寫著完成且驗證過的，smurg會直接把它合併到你的資料夾，不會先有人讀過diff' |
| QUICKSTART step 11 (:72-73, zh :67) | "Review. … press "I've reviewed this"" | "**Let it run.** Work items whose report says complete and verified merge into your folder by themselves, and what waits for them starts. A question or a decision comes to your inbox; everything else goes on." | 「**讓它跑**：報告寫著完成且驗證過的工作項目會自己合併到你的資料夾，等著它們的項目接著開始。選擇題或需要你決定的事會送到你的收件夾；其他的會繼續。」 |
| QUICKSTART step 12 (:74-76, zh :68-70) | "Merge. … "Reviewed, ready to merge" … "Merge…" … "Confirm merge" … "Reviewed · merged"…" | "**Check the result.** When every item is merged, your inbox says "Ready to check: <topic>". Open it: every report, every changed file and what the agents say they verified; then press "I've checked the result". There the host can undo an item ("Undo…"). Without git there is nothing to merge or undo: the changes are in your folder already." | 「**驗收成果**：所有項目都合併之後，收件夾會顯示「待驗收：<主題>」。打開它：每一份報告、每個改過的檔案，以及 agent 說它們驗證了什麼；看完再按「我已驗收」。主人可以在那裡復原某個項目（「復原…」）。沒有 git 時沒有東西要合併或復原：變更本來就已經在你的資料夾裡了。」 |
| picture aria-label (`index.html:92`, zh :92) = README alt (:26, `tests/lint/readme.test.ts:221-236`) | "…Review: Amy reads the result report of the first item and marks it as reviewed, and Ian, the host, merges the change into the main workspace." | "…Build: …; one runs the project's tests, and the first item, its report complete and verified, is merged by itself. Review: Amy reads the result report of the first item, already in the main workspace, and marks it as reviewed." | 「…實作：…其中一個執行了專案的測試，第一個項目的報告寫著完成且驗證過，自動合併了。檢視：Amy 讀完第一個項目的結果報告（它已經在主工作區裡），標成已看過。」 |

**The picture** (the owner's rule: the fourth card and the Review scene change only as far as the truth requires; U3's
option (a), the fewest elements): in the Build scene (index.html :146) item 1 goes "Running" → "Merged"; in the Review
scene (:168-189) the merged line stands from the scene's start without Ian's avatar, Amy presses "I've reviewed this"
("Marked as reviewed."), and the badge reads "Merged · reviewed"; the chip keyframes move with it.
`scripts/readme-picture.ts` (:160-180, :744, :765-789, :895, :911-923) and `scripts/readme-picture/words.zh-TW.ts` (:31,
:43-47) follow, then `node scripts/readme-picture.ts` writes the four `.github/assets` SVGs and the width files;
`apps/site/README.md:383` follows. The tab names (Decide, Plan, Build, Review / 檢視) stay (`site.test.ts:670 PARTS`).
Shown to the owner before the site is deployed (as 0.6.0's Build scene was).

**Every other place** (U3 C, with its file:line; the docs step writes each in both languages, reviewed against this
design): QUICKSTART :4; HOSTING :10, :45, :276 (+ "The risk" :287-295: a teammate's work item reaches your folder unread
unless automatic merging is off), :426-429 and :453-455 (0.6.0's auto-mode argument counted the merge review: it no
longer holds by default; U3 A7(a), U4 (3); and :453-455's "what your own item writes there shows in that other item's
diff before any merge" becomes "what your own item writes into another item's checkout becomes part of that item's
change and merges with it, under automatic merging without anyone reading it first", R-SAFE S8), :653-654, :825/:834/:836 (§8 rows, plus one row per hold reason), §9.2 (the
0.7.0 paragraph quoting `host.mergesAuto`), §10.1, §10.3 (rewritten, heading kept: automatic merging, its rule, update
and resolve, the merge commit and the audit; what stops it and who decides, D9's table; what waits; ready to check and
"I've checked the result"; Undo and its limits (D14 "What undo cannot take back": the agents' commands elsewhere, a
pushed branch until the undo commit is pushed, items of other topics named with their topic), and `git revert` of an
undo commit in the folder's own git; a teammate's hand edit in a work item's checkout, which waits for the host (D6
row 9); a conflict with a person's change, which is a decision (D8); "I merge each
item myself" with today's bullets; files smurg never merges; conflicts; who reads diffs; when an item is finished), §10.4
(the slot rule's memory, D16), §10.5 (heading becomes "After a restart: what goes on by itself" unless a test or the CLI
holds it, which the docs step checks: plans go on, a person's Pause stays, a topic with an interrupted direct item is
paused, the line when it stops and the start line printed before anything goes on), §10.6 (:1351 decisions escalate; a report only for items the host merges), §10.8 (what was
verified: the stand-in and real git only); JOINING :18, :109, :139-142, :153-157, :178, :435, :447-448, :455-463,
:493-494, :510-519; GLOSSARY :37 (phases), :78-84 (marked as the host's flow and a mark), "Terms of 0.7.0"; SECURITY-
MODEL one clause under "No agent is sandboxed" ("a work item's change reaches your folder without you reading it first,
unless you turn automatic merging off; a teammate's hand edit in a work item still waits for you"); README :55, :88; `apps/site/scripts/site.ts` :172, :174, :194 (+ zh :181,
:183, :203), held by `site.test.ts:1592-1595`; `docs/ARCHITECTURE.md` §0 rule 8 (D4), §2 (the trust model's merge
review; §3 point 1's sentence on what a teammate can and cannot add through a worktree, word for word), §5.7, §5.10, §5.11 (Appendix A), §7.1 (shapes 3, the step, the new stored keys), §7.6 "Restart" (D15), §7.8
(automatic merging, decisions, the end, undo, the restart, D10's fix), §7.9 (the two kinds, escalation), §11: D-25's
"and the merge review in worktrees" qualified ("…for items the host merges"), a new **D-29 (0.7.0, the owner's words of
2026-10-26)** (R9: "the owner requests the merge, the host sees the full diff, then confirms" (SPEC.md:366) → work items
merge by themselves when in order, the host's standing consent, off in the console), a new **D-30** (AD-10: after a
restart nothing runs by itself → plans go on, Pause), §12 (the checks are the agent's claims; cross-item breakage that
merges cleanly is found at the check, not before); `docs/ACCEPTANCE.md` rows T4.1, T5.2, T5.3, T6.1, T8.2 rewritten and
new rows (D22); `apps/web/README.md` :888, :942, :1281, :1416; CHANGELOG 0.7.0 in both languages (B.6; 0.6.0 and older
stay as history).

### D22. Tests

"Unit" = pure functions; "stand-in" = daemon integration with the stand-in `claude`; "smoke" = the web smokes in
Chrome with the stand-in; "SEA" = the opt-in suites of the built executable. The real `claude` suite gains nothing:
every new behaviour is the daemon's (the agent's own turns are the same kinds of turns); it is run unchanged for the
release (eight files).

| decision | proof |
|---|---|
| D1 | fixtures.test, opens.test (0.6.0), other-version.test and ctl-other-version.test stated over each side's numbers, wire.test on v0.6.0 with the three comparisons run, pin unchanged |
| D2 | constants.test (6), version-refused.test, protocol6.test, ctl-other-version.test (WELCOME_V6, both directions end at once with B2), wire.test "raised", the protocol pins (main.test, exports.test, workspace.test, sea.test) |
| D3 | entities and topics schema tests; plan-service (pins under each setting, the choice, direct, detached, `proposed`); core `mergingOf` table; the off/on toggle and its pin rewrite (also after a kill); setting change publishes and wakes the queue |
| D4 | state-steps.test (0.6.0 → 3, 0.5.x → two steps, 0.4.0 → three, notices, kept copy, put-back, the step's one audit entry); inbox store (a `result` mention target refused); opens.test UPGRADES for five versions; fixtures.test (NOT_PUBLISHED_YET, `shapeWrittenBy` 0.6.0); pin.test (shapes 3, frozen v0.6.0); unfinished.test over 0.6.0; other-version.test (v0.6.0 refuses with "Nothing was changed."); SEA sea-upgrade.test with five executables |
| D5 | report-format.test, topics schema tests, prompts.test, ReportColumn.test, stand-in fix-report of a complete report with a failed check |
| D6 | auto-merge-verdict.test (one row per branch, the new rows 5, 6, 9, 13, 15 included); report-service: `turns`, `checked[].turn`, `checkedInTurn` set at registration and by a confirming turn, `lastTurn`, `changesAsked` at a turn's end with a person's message |
| D7 | worktree tests with real git (D7's list: `stillInOrder` at both places, the checkout between trial and merge, who changed the other side in both histories, the lock pre-check without a snapshot, requested requests `gone`, smurg's own `MERGE_HEAD` named, audit entries of automatic tries); 0.6.0's staged case now `merge.staged` for `approve` |
| D8 | auto-merge.test (fakes: the races, re-checks, verify again, kills during a resolve, a stop during a pass); stand-in: a conflict between items resolved and merged with no person, a conflict with a member's saved edit held for the carers |
| D9 | routing.test, inbox schema test, derive.test (decision rows, escalation, unblocks), core (`toWorkItem`, `waiting`, `waitingFor.decisions`); `plan.item.release`; stand-in: stop after a version, an Editor's hand edit |
| D10 | no-git.test (held direct item, Accept by the host, refused to a member) |
| D11 | plan-service leaveOut (transitive, running ended, a merge in flight waited for, Start and Try again clear it) |
| D12 | scheduler finish rule; derive (no report row for auto items); a follow-up after the merge merges again |
| D13 | core phase table (settled, complete only when checked or settled and reviewed); topic.check; derive ready rows (Viewers included); ResultColumn.test |
| D14 | worktree undo tests with real git (D14's list: R-SAFE's undo-order case, kills before and after the commit in both histories); topics undo (claims, a done dependent left out); capability refusals |
| D15 | release-flow.restart.test (changed on purpose); `goOn` deferred; pause; the four automatic continues and their bounds, also after a version; the fixtures' start |
| D16 | scheduler slot rule; U1 M10 |
| D17 | prompts.test |
| D18 | cli host-state-words.test (the start line before `goOn`, the stop line), watchTopics, status, guide-anchors.test; daemon attention `auto-merge`; SEA |
| D19 | the web unit tests of D19, both languages |
| D20 | auto-merge-words.test (new lint: "smurg verifies", and "complete and verified" without "report" in both languages); catalog parity; no-cjk |
| D21 | docs-quotes.test (QUOTES and PICTURE_QUOTES changed on purpose: below), site.test (card, held lines, bounds, anchors), readme.test, readme-picture.test (regenerated), docs-parity.test (12 steps, outline), guide-update.test (§9.2), inbound.test (the printed anchor) |
| D23 | release-checks.test (0.7.0 sections, eight package.json at 0.7.0); the gate with `SMURG_RELEASE_GATE=1`, `SMURG_PREVIOUS_BINARIES` (five), `SMURG_SEA_BINARY` |

**The 0.7.0 acceptance test**: `packages/daemon/test/integration/release-flow.unattended.test.ts`, built from U1's
`U1/exp/measure.test.ts` (the same `startFlow` of `release-flow.support.ts`, the same plan: 1 cart-api, 2 receipt-email,
3 checkout-page after 1; Mei, Ian, Amy; auto mode; the daemon's clock moved with `flow.advance`). The same twelve cases
must show: M1 and M8 converge with zero clicks after Start (ready to check about 2 s later with the stand-in); M2
(conflict) resolved by the item's agent and merged; M4 (restart), M5 (usage limit) and M6's crash part go on with no
person; M3 (question), M7 (cards), M11 (host-only paths: now a host decision with the paths) and M12 (branch moved: held
for the host, nothing merged onto `experiment`) stop only their item and its dependents, each with a waiting item for
the right person; M6's partial report is a decision for the responsible person; M9 (host away) merges everything that
is in order; M10's unrelated item starts. Four cases the reviews added: M13 a conflict with a member's saved edit
(smurg's own history, R-SAFE's `resolve-over-person` setup) is a decision for the carers that names the member, and
nothing merges; M14 a resolve turn that only rewrites the report gets `verify-again` once and merges after a turn that
checks it (and is held when that turn does not); M15 a member writes to a done item's agent while the plan is paused
and stops that turn, then "Continue all": nothing merges, the responsible person has `stopped`; M16 a restart in the
middle of a resolve turn converges with no person. ACCEPTANCE gets one row per case.

**Smokes** (`apps/web/e2e/smoke/`): `flow.smoke.test.ts` and its zh-TW twin run the workspace in automatic merging: the
plan runs to "Ready to check" with no review and no merge pressed; one item scripted `partial` is a decision that its
responsible member leaves out; the ready row in a Viewer's inbox; the Result column; "I've checked the result". The
0.6.0 flow (:1194-1427, :1514, :1625; zh :264-297) moves into the same file under the setting "I merge each item
myself", so both flows stay covered. `topics.smoke.test.ts` (:232-247) gains the host's Undo of an item and the topic's
"Undo the whole topic…" preview. `acceptance.smoke.test.ts` R9 (a free worktree) is unchanged.

**Existing tests that change on purpose** (U3 D, U1, U2; each says why in its step's commit, and each is in the Do list
of the step that changes it, BUILD-PLAN):
- docs-quotes.test QUOTES: :275 `topics.review.action` (QUICKSTART no longer quotes it; JOINING still does), :315
  `topics.badge.reviewedWaitsMerge` (HOSTING, the host's flow), :316 `topics.review.merge`, :486-491
  `sidebar.title.merge.ready`, :493-495 (`worktree.review.approve`, `.confirm`, `topics.badge.merged`): QUICKSTART's
  quotes go, HOSTING's stay in the "I merge each item myself" passage; new quotes `sidebar.title.ready`,
  `topics.result.check`, `topics.undo.action`, `topics.badge.held`, `console.settings.merging.*`; PICTURE_QUOTES: :542
  `topics.badge.report` goes, `topics.badge.mergedAuto`, `topics.badge.mergedReviewed` come, :545-549 keep
  `review.action`, `review.done`, `badge.reviewed`, lose `badge.merged` and `review.merged`;
- site.test.ts :951-959 (the picture's labels), :1225/:1234 (the honest lines), :1592-1595 (how it works);
- topics: `packages/daemon/test/topics/reports.test.ts` (T5.2, T5.3: escalation only for host items), `scheduler.test.ts`
  (finish rule, phase), `no-git.test.ts` (D10), `real-git.test.ts` (:106-109 approves after review: sets `merging:
  'host'`); worktree `item.test.ts`, `merge.test.ts` (the staged case, the shared body); integration
  `release-flow.items/topic/members/restart.test.ts` (restart :308-310 approves after review), `worktree-items.test.ts`
  (each either sets `merging: 'host'` to keep testing the 0.6.0 flow, or expects the automatic merge: once smurg has
  merged, `approve` answers `merge.notPending`, R-ENG E9); the inbox T6.1 tests; `tests/e2e/test/t.topic-flow.test.ts`,
  `r11.console.test.ts` (:193 and :229 approve; and the audit events);
- the request-type tables: every new request type needs its sample in the protocol's `MESSAGE_SAMPLES`
  (`registry.test.ts:577`, "samples for exactly the registered types"), in the daemon's `REQUEST_SAMPLES`
  (`test/fixtures/request-samples.ts`, a mapped type over `RequestType`: a compile error otherwise) and a row in
  `authorization.test.ts` (:259), in the step that adds the type (R-ENG E9);
- protocol and settings literals that a required `merging` breaks: `protocol5.test.ts:120` (its `HOST_NOTICES` pin),
  and every full `HostSettings` literal (`packages/daemon/test/{settings,two-phase-start}.test.ts`,
  `sessions/agent-pure.test.ts`, `upgrade/owner.test.ts`, `packages/protocol/src/schema/session-info.test.ts`,
  `apps/web/src/features/console/{settings-form.test.ts,invites-audit-settings.test.tsx,test-support.tsx}`,
  `apps/web/src/testing/stores.ts`, `apps/web/src/lib/stores/stores.test.ts`), in S1;
- the upgrade and CLI tests that start a daemon on a published fixture (`opens`, `refusals`, `unfinished` through
  `daemon-on.ts startOn`) and `packages/cli/test/host-state-file.test.ts:365-373` (`PAUSED_050`, the exact start
  output): from S6 on they expect D15's "on the published fixtures";
- web: PlanColumn.test, ReportColumn.test, model.test, topics.zh-TW.test, StartDialog.test, start-model.test,
  inbox-rows.test, sidebar.test (+ zh-TW), tree-model.test, merge-requests.test, worktree.zh-TW.test,
  WorkspaceShell.test (`notice.complete`), stores/topics.test, the console tests, ConversationColumn.test;
- the pin's source hashes (`pin.test.ts`): every step that edits a hashed file answers the pin's question and rewrites
  the hashes with `SMURG_PIN_WRITE=1`.

### D23. Release

- **Version** 0.7.0 in all eight `package.json`; `smurg --version` → `smurg 0.7.0 (protocol v6, …)`.
- **CHANGELOG** (`CHANGELOG.md`, `docs/zh-TW/CHANGELOG.md`): `## [0.7.0] - YYYY-MM-DD` until the owner releases (the
  publish checks refuse a tag until then), the texts of B.6.
- **RELEASING.md**: §4 step 3 (b) names 0.7.0 (protocol 5 → 6): tag first, upload with `--no-latest`, deploy the relay
  with `--keep-assets <the v0.6.0 web build, made from its tag>`, switch `latest/` at once; §4.5: `SMURG_PREVIOUS_BINARIES`
  lists 0.4.0, 0.5.0, 0.5.1, 0.5.2, 0.6.0 (the 0.6.0 Linux executables are not in the VM's `~/smurg-pub` yet: U4); step 2
  `protocol v6`; "What a release owes": after 0.7.0 is published, its fixture (every point of `NOT_PUBLISHED_YET`, D4)
  and `TAG` = v0.7.0, made with the driver kept by D1.
- **ACCEPTANCE.md**: the rows of D22; "How to run the gate" counts after the gate runs.
- **docs/design/v0.7.0/**: this DESIGN.md (and BUILD-PLAN.md as the record of the steps), with a README like 0.6.0's;
  the folder is exempt from the CJK lint. D1's S0 puts the first copy there (W loses files: §5).
- The Claude Code version: verified stays 2.1.288; nothing to re-check for 0.7.0 beyond 0.6.0's list.

---

## 3. Security review

What changes in the trust model (ARCHITECTURE §2), said as it is:
1. **A work item's change reaches the shared folder without anyone reading it first, by default, also in existing
   workspaces after the update.** In 0.6.0 a person read the report, and the host read the diff and pressed merge; that
   merge review was one of the layers 0.6.0's auto-mode argument counted for worktrees (ARCHITECTURE D-25; HOSTING
   §5.2: "what the fast path lets through stays in the worktree, and the result report's diff shows it before you
   merge"). Under automatic merging that layer is gone for items that are in order. What still never merges by itself:
   host-only paths and the scripts the trust gate records, the topic's own spec and plan, links out of the project,
   smurg's directory (the merge policy, unchanged; now a host decision with the paths named instead of a silent dead
   end), a merge that does not apply cleanly after the item's agent tried, a conflict with a person's change, a
   report that is not complete and verified, a report not checked in the turn that made it, an item whose later turn a
   person stopped or whose agent a person wrote to, a merge someone requested, and a hand edit by a member without
   agent access (D6). What does: everything else, build scripts and dependency lists included. That does not widen
   what a teammate can do: a member with `file.write` already writes any file that is not host-only in the main folder
   directly (U2 C9), where it stays an uncommitted change until the host commits it; an Editor's hand edit in a work
   item's checkout, which would otherwise reach the host's branch as a commit with nobody in between, waits for the host
   (`by-hand`, R-SAFE S8); a member with agent access could have had the agent make the same edit. What the host's own
   item's agent writes into another item's checkout (HOSTING :453-455: no rule keeps it out, it lies beside the
   session's own folder) merges with that other item, unread under automatic merging; the guides say so (D21). But a
   prompt injection that reached a work item's agent now reaches the host's folder without a person in between, and in
   the folder's own git as a commit on the host's branch. The guides, SECURITY-MODEL and D-25 say so in both languages
   (D21); the host turns it off in one place, a member can make a Start stricter, the audit records every automatic
   merge with whose consent (the host's setting, or the update's default until the host has seen the notice), the
   Result column shows every change, and undo takes it back.
2. **The consent is explicit and the record honest.** The setting is the host's; the step that turns it on at the
   update is the second recorded open-side step (rule 8, D4), told three ways (D18). The merge commit's author is the
   host (the host's standing consent, as for the host's merge), its committer is smurg, and its trailer says who
   merged; the audit actor is the system with `onBehalfOf` the host.
3. **Never onto another branch.** An item merges by itself only into the branch its Start committed on, and only while
   that branch still contains the Start's checkpoint (U1 M12: today the host's click merges onto whatever is checked
   out). A detached HEAD holds it, and a Start made on one is the host's to merge (D3). The guard is looked at again
   just before `git merge`, with the main workspace's HEAD unchanged since the trial (D7 step 9b).
3b. **Nothing merges out of order** (R-SAFE S3, R-ENG E1). "In order" is computed again inside the merge queue and a
   last time just before `git merge`, synchronously, so a Pause, the setting turned off, "Leave it out", an archive, an
   undo, a follow-up or a new turn that lands while the merge waits for the queue wins; only a merge already inside
   `git merge` finishes, and the words say so. A merge someone requested is never smurg's, and smurg never merges under
   the host-only waiver of the host's own request (D6 row 15, D7 step 6).
4. **The checks are claims.** "Complete and verified" is what the agent's report says; smurg runs none of the checks
   (ARCHITECTURE §12). The parser makes a failed check and `complete` incompatible, and the role prompt says what
   `complete` now does (D17), but a model that writes `complete` over unfinished work is merged. A version merges only
   when the agent checked its report in the turn that made it (D6 row 13), so a resolution or a follow-up's change is
   not merged on claims made before it. The words say "what its report says is complete and verified", never that the
   work is, and a lint holds that (D20). Cross-item breakage that merges cleanly is not caught before the end (no
   combined verification; U2 C6): the Result column and undo are the answer, and the guides say it.
5. **Restarts go on by themselves.** The pin and history checks still run before anything starts; a topic with an
   interrupted direct item stays paused for the host (its half-done change is in the folder, which has no history); a
   person's Pause survives restarts; `smurg host` says when it stops what will go on (so the host can Pause first), and
   at every start what goes on, before it does (D15, D18). After a crash the gate still failed
   closed for orphans (0.5.0, unchanged), and `notice.unattended` still tells the item's conversation.
6. **Automatic steps are bounded.** Three resolve turns per item (only against other work items' changes, never over a
   person's), one `verify-again` per version, two continues after a broken turn, one after a crash, one after a failed
   snapshot, the usage limit only when the account is back; counts reset only by a person or a new version; each is
   audited. None of them is ever taken for an item a person stopped. They are agent turns nobody watches (R-SAFE S21):
   each runs in the item's own permission mode, its file edits stay in the checkout through the lock hook, and its shell
   commands reach as far as any turn's (HOSTING §5.2); HOSTING §10.3 and §10.5 say so in one sentence each.
7. **Undo is the host's and never overwrites people's work**: in smurg's own history it records the folder first and
   computes everything against that record, so a saved edit nobody had snapshotted yet stays (R-SAFE S1, proved with
   real git); it is refused, with names, when a later change of a person touches the same lines, when a file someone
   types in or an uncommitted edit is in its way, or when the branch moved; it is tried first without touching the
   folder; the reports stay; one commit records it; a crash before the commit is finished or held for the host by what
   the folder holds, and one after it is recovered from the commit's own words (D14 step 7). It says what it cannot take
   back: what the agents' commands did outside the folder, a branch already pushed.
8. **More agent processes** may be alive at once (D16: up to twice `maxLiveAgents` while sessions wait for a person):
   memory, not a new right.
9. **Viewers see the Result column** (the diffs of merged items): they hold `file.read` and read those files anyway;
   host-private files stay withheld from everyone but the host (0.6.0's rule in `worktree.merge.diff`).

## 4. Risks

- R-1 The real model's honesty in its report (writing `complete`, writing a failed check as failed) decides what is
  merged unread; it was never measured (no account). Mitigation: the prompt's sentence, the parser's refusal, the
  guides' words, undo; the owner tries it after the release (as for 0.5.0 and 0.6.0).
- R-2 Items that merge cleanly can still break each other; nothing re-verifies the combination before the end.
  Mitigation: the Result column lists every change and every unverified check; a follow-up item runs the same way.
- R-3 Keeping item sessions and clean worktrees until the check costs disk (a full copy per item in smurg's own
  history, 676 MB measured for one folder in 0.6.0); no early release under low disk is designed beyond 0.6.0's disk
  check before a new worktree.
- R-4 The slot rule may double the item processes' memory (D16).
- R-5 S0's driver has to be written again from the READMEs (as 0.6.0's R-4): the biggest single piece of S0.
- R-6 The restart decision reverses a documented promise (AD-10, HOSTING §10.5); a host who used Ctrl-C as a brake now
  needs Pause. Mitigation: the start line names what went on and how to pause; Pause survives restarts.
- R-7 W loses files nobody read for about four days (U4 §0): a build that runs longer than that can lose its
  HANDOVERs. Mitigation: D23's copy of the design into the repository at S0, each builder reads every earlier HANDOVER
  first.
- R-8 How a real Claude Code turn behaves across a laptop's sleep (does it end `error`, how often it retries) was only
  read from code (U1 unknowns): D15's two continues are a guess at the right bound.
- R-9 Size: about 40–50 builder-days (BUILD-PLAN, 47 after the reviews); S3 (the merge queue) and S7 (the web) carry
  the most.
- R-10 The closed sides the reviews led to may stop a run more often than the owner hopes: a conflict with a person's
  change is always a decision, a version whose report the agent did not check in its turn costs one more agent turn
  (and a decision when the agent still does not check it), and a message a person writes to a done item's agent holds
  it until a carer says "Merge it as it is" or the agent makes a new version. Mitigation: the role prompt asks the agent
  to check its report in every turn that changes something (D17); each hold names the person and offers one press; the
  stand-in acceptance cases M13–M15 show each stops only its item.

## 5. Left for the lead

The design took a side in each; each can be changed without touching the rest:
1. **Restarts** (D15): plans go on by themselves, with Pause; a topic with an interrupted direct item and a topic a
   person paused stay paused. U1 recommended this, U3 recommended keeping 0.6.0's pause; both called it the owner's.
   The design decides it within the owner's words ("unless a decision is really needed": a restart is not one, and every
   update needs one), and it is the one place 0.7.0 reverses a promise of an earlier guide. Keeping the pause instead
   costs only D15's first part and its words (`start.leave` then says "If smurg host stops, the work pauses until
   someone continues it").
2. **A per-Start choice instead of a per-topic setting** (D3): "The host merges each item" at Start, remembered as the
   next Start's default through the topic's last pin; no new topic request.
3. **Items started under 0.6.0 keep the host's merge** after the update (their pins), rather than switching.
4. **Cut from 0.7.0** (each a later addition): merging around a person's uncommitted edit on other lines in the folder's
   own git (U2 C3; 0.7.0 holds the item until the host commits or undoes the edit, then merges by itself); "Bring it
   back" after an undo (the host's `git revert` in the folder's own git); undo by an agent in a checkout; a merge lock
   kind on the wire (U2 C3's write hold: a keystroke between the trial and the merge makes git refuse, which is a
   `retry`, never a lost edit); browser or OS notifications.
5. **The slot rule** (D16): twice `maxLiveAgents` at most while sessions wait for a person, with its memory cost.
6. **Three resolve tries, two continues after a broken turn, one after a crash** (D8, D15).
7. **The merge commit's author is the host**, its committer smurg (D7), rather than smurg as the author.
8. **The fixture driver is kept in the repository** as a `.txt` file (D1), and the design is copied into
   `docs/design/v0.7.0/` at S0 (D23), because W loses files.
9. **The phase of a host's topic** (D13): one whose items were all merged but not all reviewed now reads "Ready to
   check", and one whose items were all reviewed but not all merged reads "executing" instead of "complete" (both
   reviewers asked for the second: under automatic merging a review mark can no longer complete a topic). With D10's fix
   these are the changes to the host's flow.
10. **Four closed sides the reviews led to** (R-SAFE): an Editor's hand edit in a work item's checkout waits for the host
   (`by-hand`) rather than merging with words that say so (D6 row 9; the other way is one row less and the words of §3
   point 1); a conflict whose other side is a person's change is a decision for the carers at once rather than an
   automatic resolve (D8); a version whose report the agent did not check in its own turn gets one `verify-again` and
   then is a decision (D6 row 13); and a message a person writes to a done item's agent, or a later turn a person
   stopped, holds the item until a carer presses the new "Merge it as it is" (`plan.item.release`, agent access) or the
   agent makes a new version (D6 rows 5–6, D9).
11. **The restart's words and timing** (D15, D18): `smurg host` and `smurg stop` say when they stop how many topics will
   go on at the next start, and the start line is printed before anything goes on. The lead's §5.1 choice is unchanged.
12. **The home page's fourth card and the picture** (D21, U3's option (a)): shown to the owner before the site is
    deployed, as 0.6.0's Build scene was; this is a look at the result, not a question the build waits for.

For the owner: nothing. Every choice above follows the owner's words of 2026-10-26 or the closed side, and the lead may
still ask about item 1. The reviews changed none of the standing decisions nor the lead's frame: they made "in order"
stricter, its check later, and the words truer.

---

## Appendix A. The wire diff (protocol 6), in one place

`constants.ts`: `PROTOCOL_VERSION = 6`.

`limits.ts`: `UNDO_ITEMS_MAX = 64`, `AUTO_MERGE_PATHS_MAX = 20`.

`entities.ts`:
- `MERGE_POLICIES = ['auto', 'host']`, `mergePolicySchema`; `publicSettingsSchema` + `merging` (so `hostSettingsSchema`
  and `hostSettingsPatchSchema` have it);
- `HOST_NOTICES = ['agents-auto', 'auto-merge']`;
- `AUDIT_ACTIONS` + `worktree.merge.auto`, `worktree.merge.held`, `worktree.merge.undo`, `topic.check`, `plan.pause`,
  `plan.item.leaveOut`, `plan.item.accept`, `plan.item.release`, `plan.item.removePaths`, `plan.item.autoContinue`,
  `plan.merging.host`;
- `mergeRequestSchema` + `auto: z.literal(true).optional()` (smurg merged it), `undone: z.strictObject({ commit:
  gitCommitSchema, at: epochMsSchema, by: userRefSchema }).optional()`.

`topics.ts`:
- `TOPIC_PHASES = ['discussing', 'spec', 'plan', 'executing', 'ready', 'complete']`;
- `topicSchema` + `checked: z.strictObject({ by: userRefSchema, at: epochMsSchema }).optional()`; `plan` + `leftOut:
  indexSchema`, `undone: indexSchema`, `pausedBy: userRefSchema.optional()`;
- `reportChecksSchema` + `failed: indexSchema.optional()`; `sections.verified[]` + `failed: z.literal(true).optional()`
  (refine: `failed` ⇒ `passed === false` and a `note`); the report's `changes` + `byHandTruncated:
  z.literal(true).optional()`;
- `AUTO_MERGE_REASONS`, `AUTO_MERGE_STATES`, `HOST_HOLDS`, `SELF_CLEARING_HOLDS`, `RELEASABLE_HOLDS` (D9);
- `workItemSchema` + `merging: mergePolicySchema.optional()` (the effective policy of a started item that is not
  direct), `autoMerge: z.strictObject({ state: z.enum(AUTO_MERGE_STATES), reason: z.enum(AUTO_MERGE_REASONS), since:
  epochMsSchema, tries: indexSchema, hostOnly: z.boolean(), escalated: z.boolean(), paths:
  z.array(entryPathSchema).max(AUTO_MERGE_PATHS_MAX).optional(), branch: z.strictObject({ expected: shortBranchSchema,
  current: shortTextSchema }).optional(), people: z.array(z.strictObject({ path: entryPathSchema, by:
  z.array(userRefSchema).max(5), outside: z.boolean() })).max(AUTO_MERGE_PATHS_MAX).optional(), asked:
  userRefSchema.optional() }).optional()` (`people` for a `conflict` with a person's change, `asked` who wrote for
  `asked`), `merged: z.strictObject({ at: epochMsSchema, by:
  z.union([z.literal('smurg'), userRefSchema]) }).optional()`, `leftOut: z.strictObject({ by: userRefSchema, at:
  epochMsSchema }).optional()`, `undone: z.strictObject({ by: userRefSchema, at: epochMsSchema }).optional()`,
  `waiting: z.enum(['question', 'permission']).optional()`;
- `planInfoSchema.waitingFor[]` + `decisions: indexSchema`;
- `startPreflightSchema` + `merging: z.strictObject({ workspace: mergePolicySchema, proposed: mergePolicySchema,
  detached: z.boolean() }).nullable()` (refines: null ⇔ history `direct`; `detached` ⇒ `proposed === 'host'`);
- `undoPreviewSchema` (D14; `itemRef` carries `topicName`).

`conversation.ts`: `SMURG_PURPOSES` + `remove-paths`, `verify-again`.

`inbox.ts`:
- `INBOX_KINDS` + `decision`, `ready`; `inboxKindWaits('decision') === true`, `('ready') === false`, attention
  `auto-merge` false;
- `ATTENTION_SUBJECTS` + `auto-merge`;
- `columnTargetSchema` + `{ kind: 'result', topicId }`;
- `INBOX_KIND_FIELD_NAMES` + `reason`, `tally`; `inboxItemSchema` + `reason: z.enum(AUTO_MERGE_REASONS).optional()`,
  `tally: z.strictObject({ items: indexSchema, merged: indexSchema, leftOut: indexSchema, undone: indexSchema
  }).optional()`;
- `INBOX_KIND_FIELDS.decision = { required: ['topicId', 'itemId', 'item', 'reason'], optional: ['sessionId', 'unblocks',
  'outcome', 'checks', 'waitsFor', 'waitsForOffline', 'escalated', 'alsoFor', 'alsoForMore'] }`;
  `INBOX_KIND_FIELDS.ready = { required: ['topicId', 'tally', 'checks'], optional: [] }`; `question`, `permission` and
  `attention` gain the optional `unblocks`.

`messages/topics.ts`:
```ts
planStartPayloadSchema       = { …as today, merging?: z.literal('host') }
topicCheckPayloadSchema      = z.strictObject({ topicId })                                     // result topicResultSchema
planPausePayloadSchema       = z.strictObject({ topicId })                                     // result planResultSchema
planItemLeaveOutPayloadSchema = z.strictObject({ topicId, itemId })                            // result planResultSchema
planItemAcceptPayloadSchema  = z.strictObject({ topicId, itemId, version: z.int().min(1) })    // result planResultSchema
planItemReleasePayloadSchema = z.strictObject({ topicId, itemId, version: z.int().min(1) })    // result planResultSchema
planItemRemovePathsPayloadSchema = z.strictObject({ topicId, itemId })                         // result planItemActionResultSchema
topicUndoPreviewPayloadSchema, topicUndoPayloadSchema                                           // D14
```

`registry.ts`:

| type | dir | capability | checks |
|---|---|---|---|
| `topic.check` | c2d | `discuss` | topic-open |
| `plan.pause` | c2d | `session.drive` | topic-open |
| `plan.item.leaveOut` | c2d | `session.drive` | topic-open |
| `plan.item.accept` | c2d | `worktree.merge.decide` | topic-open |
| `plan.item.release` | c2d | `session.drive` | topic-open |
| `plan.item.removePaths` | c2d | `worktree.merge.decide` | topic-open |
| `topic.undo.preview` | c2d | `worktree.merge.decide` | topic-open |
| `topic.undo` | c2d | `worktree.merge.decide` | topic-open |

`routing.ts`: `decisionRecipients` (D9).

Not on the wire (stored only, D4): the item's `autoMerge.requestId`, `mergedAs.requestId` and `.commit`,
`autoContinue`, `turns`, `checked[].turn`, `lastTurn`; the report's `checkedInTurn`; the
pin's `merging` and `branch`; worktrees.json's `undo` record.

The control socket (`packages/daemon/src/local/protocol.ts`): the attach answer embeds the Welcome (changed through
`publicSettings`); the `status` answer's `topics` gains optional `running`, `decisions`, `ready`; the `stop` answer
gains an optional `goOn` (D18).

## Appendix B. The words (English / Traditional Chinese)

B.1 Wire catalog (`packages/protocol/src/i18n/messages/`), file in brackets. Conversation lines end without a full
stop, like today's; sentences that are errors end with one.

| id | en | zh-TW |
|---|---|---|
| `conversation.merged.auto` [conversation] | smurg merged this work item into the main workspace (automatic merging, the host's setting) | smurg 已把這個工作項目合併到主工作區（自動合併，主人的設定） |
| `conversation.update.auto` {count} | smurg brought the main workspace's changes into this checkout: {count} files have conflicts. It asked Claude to resolve them and verify again (count 0: "…into this checkout without conflicts and asked Claude to verify again") | smurg 把主工作區的變更帶進這個 checkout：{count} 個檔案有衝突。它請 Claude 解決衝突，再驗證一次（0 個時：「smurg 把主工作區的變更帶進這個 checkout，沒有衝突，並請 Claude 再驗證一次」） |
| `conversation.held` {reason} | smurg did not merge this work item: {reason} (the reason's short words of B.2 `hold.*`, mapped inside the message) | smurg 沒有合併這個工作項目：{reason} |
| `conversation.verifyAgain` | smurg asked Claude to verify again: files changed after its report was last checked | smurg 請 Claude 再驗證一次：上次檢查報告之後有檔案改了 |
| `conversation.released` {name} | {name} let this work item merge as it is | {name} 讓這個工作項目就這樣合併 |
| `conversation.removePathsRequested` {name} | {name} asked Claude to take out the changes only the host may merge | {name} 請 Claude 拿掉只有主人能合併的變更 |
| `conversation.ended.leftOut` {name} | {name} left this work item out: its change is not merged | {name} 略過了這個工作項目：它的變更不會合併 |
| `conversation.ended.undone` {name} | {name} undid this work item: its change was taken back out of the main workspace | {name} 復原了這個工作項目：它的變更已經從主工作區拿掉了 |
| `conversation.ended.checked` | The topic's result was checked. This work item is complete | 主題的成果已經驗收，這個工作項目完成了 |
| `conversation.continued.restart` | smurg was restarted on the host's computer and asked Claude to continue | 主人電腦上的 smurg 重新啟動過，它請 Claude 繼續 |
| `conversation.continued.usageLimit` | The host's usage limit has reset: smurg asked Claude to continue | 主人的用量限制已經重置：smurg 請 Claude 繼續 |
| `conversation.continued.error` {count} | The last turn ended with an error: smurg asked Claude to continue ({count} of 2) | 上一輪因錯誤結束：smurg 請 Claude 繼續（第 {count} 次，最多 2 次） |
| `conversation.continued.crash` | Claude's process stopped: smurg started it again once and asked it to continue | Claude 的程序停止了：smurg 重新啟動它一次，並請它繼續 |
| `conversation.continued.snapshot` | smurg could not record this work item's changes: it asked Claude to continue and records them after that turn | smurg 沒能記下這個工作項目的變更：它請 Claude 繼續，那一輪結束後再記一次 |
| `report.closed` [topics] (changed) | This work item is finished: its change is in the main workspace and its session has ended. Ask in the topic's discussion: the plan can get a new item. | 這個工作項目已經結束：它的變更在主工作區裡，它的 session 也結束了。請到主題的討論裡提：計畫可以加新的項目。 |
| `topic.check.notReady` [topics] | This topic is not ready to check yet: not every work item is merged. | 這個主題還不能驗收：還有工作項目沒有合併。 |
| `plan.item.leaveOut.merged` [topics] | This work item is merged already. To take its change back out, the host undoes it. | 這個工作項目已經合併了。要把它的變更拿掉，請主人復原。 |
| `plan.item.accept.notHeld` [topics] | This work item does not wait for a decision. | 這個工作項目沒有在等決定。 |
| `plan.item.release.notHeld` [topics] | This work item does not wait for a decision that "Merge it as it is" can settle. | 這個工作項目沒有在等「就這樣合併」能處理的決定。 |
| `plan.item.removePaths.notHeld` [topics] | This work item has no change that only the host may merge. | 這個工作項目沒有只有主人能合併的變更。 |
| `undo.changed` [topics] | Something changed since you looked. Look at what the undo does again. | 從你看過到現在，有東西變了。請再看一次復原會做什麼。 |
| `undo.notOk` [topics] | smurg cannot take this back cleanly now. Nothing was changed. | smurg 現在沒辦法順利拿掉它。沒有任何東西被改動。 |
| `undo.unavailable.direct` [topics] | Without git there is nothing to undo: smurg kept no history of the shared folder. | 沒有 git 時沒有東西可以復原：smurg 沒有保存分享的資料夾的版本紀錄。 |
| `undo.unavailable.notFound` [topics] | smurg cannot find this item's merge in the main workspace's history any more. | smurg 在主工作區的版本紀錄裡找不到這個項目的合併了。 |
| `merge.staged` [worktrees] | Changes are staged in the main workspace (git add), and git does not merge over them. Commit or unstage them, then merge. | 主工作區有已暫存的變更（git add），git 不會在它們上面合併。請先提交或取消暫存，再合併。 |
| `activity.mergeAuto` {item, starter} [activity] | smurg merged {starter}'s work item {item} into the main workspace (automatic merging) | smurg 把{starter}的工作項目 {item} 合併到主工作區（自動合併） |
| `activity.undo` {items} [activity] | Took {items} back out of the main workspace | 把 {items} 從主工作區拿掉了 |

`report.error.format`, `report.error.outcome`, `merge.mainBusy`, `merge.lockedFiles`, `merge.failed`,
`conversation.resolveRequested`, `conversation.conflict.merged`, `conversation.ended.reviewed` keep their words.

B.2 Web catalogs (`apps/web/src/features/*/strings.ts` and `strings.zh-TW.ts`, `apps/web/src/strings/*`).

| id (feature) | en | zh-TW |
|---|---|---|
| `start.merge.auto` {host} (topics) | smurg merges each item into the main workspace for {host} when its report says complete, at least one check passed and none failed (the host's setting). What waits for it then starts from the merged workspace. | 項目的報告寫著完成、至少一項驗證通過、沒有驗證失敗時，smurg 會替 {host} 把它合併到主工作區（主人的設定），等著它的項目接著從合併後的主工作區開始。 |
| `start.merge.stops` | The run stops where a person must decide: a question, a request its mode asks, a report that is not complete and verified, work a person stopped or wrote to the agent about, files only the host may merge, the host's folder in the way, or a merge smurg cannot make cleanly by itself. Everything that does not depend on it goes on. | 需要人決定的地方才會停下：選擇題、它的模式要先問的請求、不是完成且驗證過的報告、有人停下或對 agent 說了話的工作、只有主人能合併的檔案、主人的資料夾擋住了，或是 smurg 沒辦法自己順利完成的合併。不依賴它的項目會繼續。 |
| `start.merge.end` | When every item is merged, every member's inbox says the topic is ready to check: each report, the combined change and what the agents say they verified, with a way to undo an item. | 所有項目都合併之後，每位成員的收件夾都會顯示主題待驗收：可以看每一份報告、合起來的變更和 agent 說它們驗證了什麼，也可以復原某個項目。 |
| `start.merge.detached` | The main workspace is not on a branch (a detached HEAD), so the host merges each item of this Start. | 主工作區不在任何分支上（detached HEAD），所以這次開始的每個項目都由主人合併。 |
| `start.merge.host` {host} | Each item's change waits for {host} to read its diff and merge it. The items that depend on it start after that merge. | 每個項目的變更都要等 {host} 讀過 diff 再合併；依賴它的項目在合併之後才會開始。 |
| `start.leave` {host} | You can close this page: the work goes on while smurg host runs on {host}'s computer, also after it was restarted. | 你可以關掉這個頁面：只要 {host} 的電腦上 smurg host 在執行，工作就會繼續，重新啟動之後也一樣。 |
| `start.leave.host` | You can close this page: the work goes on while smurg host runs on your computer, also after it was restarted. | 你可以關掉這個頁面：只要你電腦上的 smurg host 在執行，工作就會繼續，重新啟動之後也一樣。 |
| `start.commit.branch` {branch} | smurg merges each item into {branch}; while the main workspace is on another branch, the merges wait for the host. | smurg 會把每個項目合併到 {branch}；主工作區在別的分支上的時候，合併會等主人處理。 |
| `start.agent.merge` | How its items are merged | 項目怎麼合併 |
| `start.merge.option.auto` | smurg merges what its report says is complete and verified (workspace setting) | 報告寫著完成且驗證過的，由 smurg 合併（工作區設定） |
| `start.merge.option.host` | The host merges each item | 每個項目都由主人合併 |
| `summary.merged` {merged, total} | {merged} of {total} merged | {total} 項中 {merged} 項已合併 |
| `progress.decisions` {count} | one: {count} waits for a decision; other: {count} wait for a decision | {count} 項在等決定 |
| `waiting.decisions` {count} | one: {count} decision; other: {count} decisions | {count} 個決定 |
| `plan.auto.running` | Running by itself: smurg merges each item whose report says complete and verified, and starts what waits for it. | 自動執行中：報告寫著完成且驗證過的項目由 smurg 合併，等著它的項目接著開始。 |
| `plan.decision` {item, reason, who} | {item} was not merged: {reason}. {who} decides. The items that do not depend on it go on. | {item} 沒有合併：{reason}。由 {who} 決定。不依賴它的項目會繼續。 |
| `plan.decision.open` | Open | 打開 |
| `plan.paused.by` {name} | {name} paused this plan: nothing starts, merges or continues by itself until someone continues it (a merge already under way finishes). | {name} 暫停了這個計畫：在有人按繼續之前，不會有項目自己開始、合併或繼續（已經在進行的合併會做完）。 |
| `plan.pause.action` | Pause | 暫停 |
| `foot.autoMerge` | Each item whose report says complete and verified is merged by smurg; the work stops only for a decision. | 報告寫著完成且驗證過的項目由 smurg 合併；只有需要決定時才會停下。 |
| `badge.merging` | Merging… | 合併中… |
| `badge.resolving` | Bringing its work up to date | 正在跟上主工作區 |
| `badge.mergedAuto` | Merged | 已合併 |
| `badge.mergedReviewed` | Merged · reviewed | 已合併 · 已看過 |
| `badge.waitsToMerge` {name} | Waits to merge: {name} is editing | 等著合併：{name} 正在編輯 |
| `badge.waitsToMerge.busy` | Waits to merge: git is busy in the main workspace | 等著合併：主工作區的 git 正在忙 |
| `badge.held` {reason} | Not merged: {reason} | 沒有合併：{reason} |
| `badge.waitsDecision` {items} | Waits for a decision on {items} | 在等 {items} 的決定 |
| `badge.undone` | Undone | 已復原 |
| `badge.leftOut` | Left out | 已略過 |
| `hold.partial` | not complete (partial) | 沒有完成（部分完成） |
| `hold.blocked` | not complete (blocked) | 沒有完成（受阻） |
| `hold.check-failed` | a check failed | 有驗證失敗 |
| `hold.not-verified` | no check passed | 沒有通過的驗證 |
| `hold.report-invalid` | the report cannot be read | 報告無法讀取 |
| `hold.rejected` | the host did not merge it | 主人沒有合併它 |
| `hold.conflict` | it does not merge cleanly | 沒辦法順利合併 |
| `hold.conflict.people` {path, names} | it conflicts with {names}'s change of {path} | 和 {names} 對 {path} 的修改衝突 |
| `hold.conflict.outside` {path} | it conflicts with a change of {path} made outside smurg | 和在 smurg 以外對 {path} 的修改衝突 |
| `hold.asked` {name} | {name} wrote to the agent after its report | {name} 在報告之後對 agent 說了話 |
| `hold.stopped` | its last turn did not finish | 它的上一輪沒有做完 |
| `hold.stale-report` | its report was not checked again after its last change | 最後一次修改之後沒有再檢查報告 |
| `hold.by-hand` {names} | {names} edited files of it by hand | {names} 手動改了它的檔案 |
| `hold.undo-interrupted` | an undo was interrupted in the main workspace | 主工作區有一次復原被中斷了 |
| `hold.policy` | it changes files only the host may merge | 改到只有主人能合併的檔案 |
| `hold.local-changes` | uncommitted changes in the main workspace are in the way | 主工作區有還沒提交的修改擋住了 |
| `hold.in-the-way` | files in the main workspace are in the way | 主工作區有檔案擋住了 |
| `hold.staged` | changes are staged in the main workspace | 主工作區有已暫存的變更 |
| `hold.branch` | the main workspace is on another branch | 主工作區換了分支 |
| `hold.git-busy` | git has been busy in the main workspace for a while | 主工作區的 git 已經忙了一段時間 |
| `hold.history-changed` | smurg's own history of the folder changed | smurg 為資料夾保存的版本紀錄變了 |
| `hold.merge-failed` | smurg cannot merge it | smurg 沒辦法合併它 |
| `decision.foot` {reason, who, items} | Not merged: {reason}. {who} decides. Items {items} wait for it. | 沒有合併：{reason}。由 {who} 決定。項目 {items} 在等它。 |
| `decision.foot.alone` {reason, who} | Not merged: {reason}. {who} decides. | 沒有合併：{reason}。由 {who} 決定。 |
| `decision.fix` | Ask the agent to fix it | 請 agent 修正 |
| `decision.removePaths` | Ask the agent to take them out | 請 agent 拿掉它們 |
| `decision.accept` | Accept as it is | 就這樣接受 |
| `decision.asIs` | Merge it as it is | 就這樣合併 |
| `decision.people` {path, names} | {path}: the other side is {names}'s change. Whose lines stay is a person's decision. | {path}：另一邊是 {names} 的修改。要留下誰的內容，由人決定。 |
| `decision.people.outside` {path} | {path}: the other side was changed outside smurg. Whose lines stay is a person's decision. | {path}：另一邊是在 smurg 以外改的。要留下誰的內容，由人決定。 |
| `decision.leaveOut` | Leave it out… | 略過這個項目… |
| `decision.inTheWay.local-changes` {paths} | Commit these edits in the main workspace (they may be a teammate's): {paths}. smurg merges the item by itself once that is done. | 請在主工作區提交這些修改（可能是組員的）：{paths}。完成之後 smurg 會自己合併這個項目。 |
| `decision.inTheWay.in-the-way` {paths} | These files in the main workspace are where the item adds its own: {paths}. Move them away (smurg never overwrites them), or leave the item out; smurg merges the item by itself once they are moved. | 主工作區裡的這些檔案，正好在這個項目要新增檔案的位置：{paths}。請把它們移走（smurg 絕不會覆蓋它們），或略過這個項目；移走之後 smurg 會自己合併這個項目。 |
| `decision.inTheWay.staged` | Commit or unstage what is staged in the main workspace. smurg merges the item by itself once that is done. | 請提交或取消暫存主工作區裡已暫存的變更。完成之後 smurg 會自己合併這個項目。 |
| `decision.inTheWay.branch` {expected, current} | The main workspace is on {current}. Switch back to {expected}, where this topic started; smurg merges the item by itself then. | 主工作區現在在 {current}。請切回這個主題開始時的 {expected}；之後 smurg 會自己合併這個項目。 |
| `decision.inTheWay.git-busy` | A merge, a rebase or a similar git operation is in progress in the main workspace. Finish it; smurg merges the item by itself then. | 主工作區正在進行合併、rebase 或類似的 git 操作。請把它做完；之後 smurg 會自己合併這個項目。 |
| `decision.inTheWay.git-busy.smurg` {item} | smurg was merging work item {item} when it stopped: finish it with git commit, or run git merge --abort. smurg merges by itself again then. | smurg 停下來的時候正在合併工作項目 {item}：請用 git commit 完成它，或執行 git merge --abort。之後 smurg 會再自己合併。 |
| `decision.inTheWay.undo-interrupted` {items, paths} | smurg was undoing {items} when it stopped, and the main workspace is between the two: commit what is staged as the undo, or put the files back with git restore --staged --worktree -- {paths}. smurg goes on by itself then. | smurg 停下來的時候正在復原 {items}，主工作區停在中間：請把已暫存的變更提交為這次復原，或用 git restore --staged --worktree -- {paths} 把檔案還原。之後 smurg 會自己繼續。 |
| `review.lead.auto` {time} | smurg merged this change into the main workspace at {time}: its report says complete, at least one check passed and none failed. Mark it reviewed when you have read it; that changes nothing in the folder. | smurg 在 {time} 把這份變更合併到主工作區了：報告寫著完成、至少一項驗證通過，也沒有驗證失敗。讀過之後可以標成已看過；這不會改動資料夾裡的任何東西。 |
| `report.state.mergedAuto` {time} | Merged by smurg at {time} | smurg 在 {time} 合併了 |
| `report.check.failed` | Failed | 失敗 |
| `report.checks.line` {passed, failed, notVerified} | {passed} passed · {failed} failed · {notVerified} not verified | {passed} 項通過 · {failed} 項失敗 · {notVerified} 項沒有驗證 |
| `ready.title` | Ready to check | 待驗收 |
| `ready.body` | Every item is merged into the main workspace. Look at the result: the reports, the combined change and what the agents say they verified. | 所有項目都已合併到主工作區。來看看成果：報告、合起來的變更和 agent 說它們驗證了什麼。 |
| `ready.open` | Open the result | 打開成果 |
| `complete.checked` {name, time} | Checked by {name} at {time}. | {name} 在 {time} 驗收了。 |
| `result.title` {topic} | Result: {topic} | 成果：{topic} |
| `result.summary` {merged, total, passed, failed, notVerified} | {merged} of {total} merged · {passed} passed · {failed} failed · {notVerified} not verified | {total} 項中 {merged} 項已合併 · {passed} 項通過 · {failed} 項失敗 · {notVerified} 項沒有驗證 |
| `result.summary.leftOut` {count}, `result.summary.undone` {count} | {count} left out · {count} undone | {count} 項已略過 · {count} 項已復原 |
| `result.notVerified` | Not verified | 沒有驗證 |
| `result.passed` | Passed | 通過 |
| `result.changes` | What the items changed | 各項目合起來的變更 |
| `result.changes.note` | Each item's change against the main workspace it was merged into. A line an item replaced shows as removed, also when a person had written it. | 每個項目的變更，是和它被合併進去時的主工作區相比。項目取代掉的內容會顯示為刪除，即使那是某個人寫的。 |
| `result.items` | Work items | 工作項目 |
| `result.leftOutUndone` | Left out and undone | 已略過和已復原的項目 |
| `result.check` | I've checked the result | 我已驗收 |
| `result.check.lead` | Press it when you have looked at the result. The topic is then complete, its work items' sessions end, and it leaves everyone's inbox; reviewing each report is up to you. | 看過成果之後再按。主題就算完成，工作項目的 session 會結束，也會從每個人的收件夾離開；要不要逐份看報告，由你們決定。 |
| `result.change` | To change something, ask in the discussion: the plan can get a new item, which runs the same way. | 要改什麼，請到討論裡提：計畫可以加新的項目，它也會照同樣的方式執行。 |
| `result.direct` | These items ran directly in the shared folder: smurg keeps no history of them and cannot show or undo their changes. Their reports say what they changed. | 這些項目是直接在分享的資料夾裡執行的：smurg 沒有保存它們的版本紀錄，沒辦法顯示或復原它們的變更。它們做了什麼改動，可以看它們的報告。 |
| `result.undoTopic` | Undo the whole topic… | 復原整個主題… |
| `undo.action` | Undo… | 復原… |
| `undo.title` {item} | Undo {item}? | 要復原 {item} 嗎？ |
| `undo.title.topic` {topic} | Undo every item of {topic}? | 要復原 {topic} 的所有項目嗎？ |
| `undo.body` | smurg takes the change back out of the main workspace with one new commit. The reports and conversations stay. It takes back only the files the merge changed in this folder: what the agents' commands did elsewhere is not undone, and a branch you pushed keeps the merge until you push the undo too. | smurg 會用一個新的提交，把變更從主工作區拿掉。報告和對話都會留著。它只拿掉合併改到這個資料夾裡的檔案：agent 的指令在別處做的事不會復原，已經推送的分支也要等你推送這次復原之後才會拿掉。 |
| `undo.body.smurg` | smurg takes the change back out of the shared folder with one new change in its own history. The reports and conversations stay. It takes back only the files the merge changed in this folder: what the agents' commands did elsewhere is not undone. | smurg 會在它自己的版本紀錄裡用一次新的變更，把它從分享的資料夾拿掉。報告和對話都會留著。它只拿掉合併改到這個資料夾裡的檔案：agent 的指令在別處做的事不會復原。 |
| `undo.itemOfTopic` {item, topic} | {item} of {topic} | {topic} 的 {item} |
| `undo.builtOn` {items} | Undone with it, because they were built on it: {items}. | 這些項目是在它之上做的，會一起復原：{items}。 |
| `undo.sameLines` {items} | Undone with it, because they changed the same lines later: {items}. (An item of another topic is named with `undo.itemOfTopic`, and its session ends too.) | 這些項目之後改了同樣的幾行，會一起復原：{items}。 |
| `undo.leftOut` {items} | Left out, because they wait for it: {items}. | 這些項目在等它，會一起略過：{items}。 |
| `undo.blocked.title` | smurg cannot undo it now: | smurg 現在沒辦法復原： |
| `undo.blocked.running` {items} | {items} depend on it and are running: wait for them, or stop them. | 依賴它的 {items} 正在執行：等它們做完，或停止它們。 |
| `undo.blocked.changedSince` {path, names} | {path} was changed on the same lines later by {names}. | {path} 之後被 {names} 改了同樣的幾行。 |
| `undo.blocked.outside` {path} | {path} was changed on the same lines later, outside smurg. | {path} 之後在 smurg 以外被改了同樣的幾行。 |
| `undo.blocked.typing` {path, names} | {names} is typing in {path}. | {names} 正在 {path} 裡輸入。 |
| `undo.blocked.uncommitted` {paths} | Uncommitted edits in the main workspace are in the way: {paths}. | 主工作區有還沒提交的修改擋住了：{paths}。 |
| `undo.blocked.staged` | Changes are staged in the main workspace. | 主工作區有已暫存的變更。 |
| `undo.blocked.busy` | A git operation is in progress in the main workspace. | 主工作區有 git 操作正在進行。 |
| `undo.blocked.branch` {expected, current} | The main workspace is on {current}, not on {expected}. | 主工作區在 {current}，不是 {expected}。 |
| `undo.go` | Undo | 復原 |
| `undo.askHost` | Only the host can undo a merge: ask the host. | 只有主人能復原合併：請找主人。 |
| `undo.done` {name, time} | Undone by {name} at {time}: its change was taken back out of the main workspace. | {name} 在 {time} 復原了：它的變更已經從主工作區拿掉了。 |
| `leaveOut.title` {item} | Leave out {item}? | 要略過 {item} 嗎？ |
| `leaveOut.body` {items} | Its change is not merged. {items} depend on it and are left out too. | 它的變更不會合併。依賴它的 {items} 也會一起略過。 |
| `leaveOut.body.alone` | Its change is not merged. Its session ends; its worktree is kept. | 它的變更不會合併。它的 session 會結束，worktree 會保留。 |
| `leaveOut.go` | Leave out | 略過 |
| `title.decision` {item, reason} (sidebar) | {item} was not merged: {reason} | {item} 沒有合併：{reason} |
| `title.ready` {topic} | Ready to check: {topic} | 待驗收：{topic} |
| `fact.unblocks` {items} | items {items} wait for it | 項目 {items} 在等它 |
| `fact.decides` {name} | {name} decides | 由 {name} 決定 |
| `fact.notDecided` {name, time} | {name} has not decided for {time} | {name} 已經 {time} 沒有決定 |
| `fact.tally` {merged, total} | {merged} of {total} merged | {total} 項中 {merged} 項已合併 |
| `inbox.attention.mergesAuto` | Work items now merge by themselves | 工作項目現在會自動合併 |
| `inbox.empty.viewer` (changed) | Nothing is waiting for you. As a viewer you get mentions and topics ready to check here. | 目前沒有等你處理的事。「旁觀」的成員在這裡只會收到提及和待驗收的主題。 |
| `group.phase.ready` | {name}, ready to check | {name}，待驗收 |
| `row.result` | Result | 成果 |
| `phase.ready` (stores) | Ready to check | 待驗收 |
| `kind.decision`, `kind.ready` (stores) | Decision · Ready to check | 決定 · 待驗收 |
| `notice.ready` {name} (workbench) | {name}: every item is merged. Ready to check. | {name}：所有項目都合併了，待驗收。 |
| `notice.checked` {name} | {name}: the result was checked. The topic is complete. | {name}：成果已驗收，主題完成。 |
| `empty.first.execute` (workbench, changed) | Run and check / One session per item; smurg merges what its report says is complete and verified. Check the result at the end. | 執行與驗收 / 每個項目一個 session；報告寫著完成且驗證過的由 smurg 合併。最後再驗收成果。 |
| `settings.merging` (console) | Merging work items | 合併工作項目 |
| `settings.merging.auto` | smurg merges what its report says is complete and verified | 報告寫著完成且驗證過的，由 smurg 合併 |
| `settings.merging.host` | I merge each item myself | 每個項目都由我自己合併 |
| `settings.mergingHint` | smurg merges a work item for you, without anyone reading its diff first, when its report says complete, at least one check passed and none failed, and it merges cleanly into the branch its Start used; anything else waits for a decision. The checks are what the agent reports: smurg does not run them. You can undo a merged item. Turning this off applies at once (a merge already under way finishes) and gives every started work item to you; turning it on applies to work items started from then on. | 工作項目的報告寫著完成、至少一項驗證通過、沒有驗證失敗，而且能順利合併到它開始時的分支時，smurg 會替你合併，不會先有人讀過 diff；其他的會等人決定。驗證是 agent 自己報告的：smurg 不會執行它們。合併過的項目可以復原。關掉會立刻生效（已經在進行的合併會做完），所有已經開始的工作項目都改由你合併；打開則從之後開始的工作項目起生效。 |
| `settings.mergesAuto.banner` | Since smurg 0.7.0, work items merge by themselves: when a work item's report says complete, at least one check passed and none failed, and it merges cleanly, smurg merges it into the shared folder for you, and everyone's inbox says when a topic is ready to check. Work items started before the update still wait for you. To merge each item yourself, choose "I merge each item myself" below. | 從 smurg 0.7.0 起，工作項目會自動合併：報告寫著完成、至少一項驗證通過、沒有驗證失敗，而且能順利合併時，smurg 會替你把它合併到分享的資料夾，主題待驗收時每個人的收件夾都會顯示。更新之前就開始的工作項目仍然會等你。想要每個項目都自己合併，請在下面選「每個項目都由我自己合併」。 |
| `settings.escalateAfterHint` (changed) | A question, a permission request or a decision on a work item that has waited this long also reaches you and the members with agent access. A result report of a work item you merge yourself does after {factor} times as long. | 等了這麼久的選擇題、權限請求或工作項目的決定，也會送到你和可使用 agent 的成員那裡。你自己合併的工作項目的結果報告，要等 {factor} 倍這麼久。 |
| audit labels (console) | smurg merged a work item for you · smurg held a work item for a decision · Undid a merge · Checked a topic's result · Paused a plan · Left a work item out · Accepted a work item as it is · Let a work item merge as it is · Asked the agent to take out host-only changes · smurg continued a work item · smurg gave every started work item to the host | smurg 替你合併了一個工作項目 · smurg 讓一個工作項目等決定 · 復原了一次合併 · 驗收了主題的成果 · 暫停了計畫 · 略過了一個工作項目 · 接受了一個工作項目的現狀 · 讓一個工作項目就這樣合併 · 請 agent 拿掉只有主人能做的變更 · smurg 讓一個工作項目繼續 · smurg 把所有已開始的工作項目改由主人合併 |
| `list.draftsTitle` (worktree, changed) | Work items not merged yet | 還沒合併的工作項目 |
| `merge.byAuto` {host} (worktree) | Merged by smurg for {host} | smurg 替 {host} 合併了 |
| `next.report.mergedAuto` (conversation) | The result report is written. smurg merged the change into the main workspace. | 結果報告寫好了。smurg 已把變更合併到主工作區。 |
| `next.report.held` {reason, names} | The result report is written. It was not merged: {reason}. {names} decides. | 結果報告寫好了。它沒有合併：{reason}。由 {names} 決定。 |

B.3 CLI catalog (`packages/cli/src/i18n/en.ts`, `zh-TW.ts`; ASCII in English; `GUIDE_MERGING` =
`https://smurg.ai/docs/hosting/#103-merging-and-what-waits-for-it`, zh `https://smurg.ai/zh-TW/docs/hosting/#103-合併以及什麼在等它`,
checked by guide-anchors.test against the site's slugs).

| id | en | zh-TW |
|---|---|---|
| `host.mergesAuto` | `\nWork items now merge by themselves: when a work item's report says complete, at least one check passed and none failed, smurg merges it into the shared folder for you, and everyone's inbox says when a topic is ready to check. Work items started before this update still wait for you. To merge each item yourself, choose "I merge each item myself" in the host console's settings. Guide: ${GUIDE_MERGING}` | `\n工作項目現在會自動合併：報告寫著完成、至少一項驗證通過、沒有驗證失敗時，smurg 會替你把它合併到分享的資料夾，主題待驗收時每個人的收件夾都會顯示。這次更新之前就開始的工作項目仍然會等你。想要每個項目都自己合併，請在主人主控台的設定裡選「每個項目都由我自己合併」。說明：${GUIDE_MERGING}` |
| `host.plansContinue` {topics} | `\n{n} topic(s) go on where they stopped: Checkout (2 work items), Search (1). To pause one, press Pause in its plan.` | `\n{n} 個主題從停下的地方繼續：Checkout（2 個工作項目）、Search（1 個）。要暫停其中一個，請在它的計畫裡按「暫停」。` |
| `host.stopping.goOn` {n} | `\nWhen smurg host starts again, {n} topic(s) go on by themselves; to keep one stopped, press Pause in its plan first.` | `\n下次 smurg host 啟動時，{n} 個主題會自己繼續；要讓其中一個保持停下，請先在它的計畫裡按「暫停」。` |
| `host.plansPaused` {names} | `\nPaused by a person, and still paused: {names}. Continue it in its plan.` | `\n有人暫停、仍在暫停中的主題：{names}。要繼續，請在它的計畫裡按。` |
| `host.topicReady` {name, merged, total} | `Topic "{name}" is ready to check: {merged} of {total} work items are merged into the shared folder. Look at the result in the workspace.` | `主題「{name}」待驗收：{total} 個工作項目中有 {merged} 個已合併到分享的資料夾。請到工作區查看成果。` |
| `host.topicWaits` {name, number, title, reason} | `Topic "{name}" waits for you: work item {number} ({title}) was not merged ({reason}). It is in your inbox; the work items that do not depend on it go on.` | `主題「{name}」在等你：工作項目 {number}（{title}）沒有合併（{reason}）。它在你的收件夾裡；不依賴它的工作項目會繼續。` |
| `status.topics` {total, running, decisions, ready, paused} | `3 (1 running, 1 waiting for a decision, 1 ready to check)`, parts that are zero left out; `none` | `3 個（1 個執行中、1 個在等決定、1 個待驗收）`，為 0 的部分省略；`沒有` |

(Topic names and titles are printed through the CLI's `shown()`, as folder names are: escape sequences cannot reach the
terminal.)

B.4 Fixed English for agents (not catalogs; `topics/prompts.ts`): the sentences of D5 and D17.

B.5 Docs: the held sentences are in D21's table; every other paragraph is written in both languages by the docs step
following the GLOSSARY, reviewed against this design.

B.6 CHANGELOG 0.7.0.

English (`CHANGELOG.md`):

```
## [0.7.0] - YYYY-MM-DD

- **Topics run to the end by themselves.** After Start, smurg merges each work item into the shared folder when its
  result report says complete, at least one of its checks passed and none failed, and the merge is clean; what waits
  for it then starts from the merged folder. Nobody has to review a report or press merge first. "I've reviewed this"
  stays, as a mark ([host guide](docs/HOSTING.md) §10.3).
- **It stops for a decision**: a question, a request the permission mode still asks, a report that is not complete
  and verified, work a person stopped or wrote to the agent about, files only the host may merge, the host's folder in
  the way, a merge that stays unclean after the item's agent brought its work up to date, or a conflict with a person's
  change. Each goes to the right person's inbox, and everything that does not depend on it goes on.
  "Leave it out" drops one work item and what depends on it without editing the plan.
- **Ready to check.** When every item is merged, every member's inbox says so, and the new Result column shows every
  report, every changed file and what was not verified; "I've checked the result" completes the topic. Where smurg
  keeps history, the host can undo an item or the whole topic: one new commit, the reports kept, and what was built on
  it named first ([host guide](docs/HOSTING.md) §10.3).
- **A result report says what failed**: a check that failed is written `- [!] …: failed: …`, and a report with one
  cannot say complete.
- **Workspaces shared with an earlier smurg merge by themselves after the update**: `smurg host` says so in one line,
  and "Merging work items" in the host console's settings turns it off, which gives back the host's merge of every
  item. Work items started before the update still wait for the host. Whoever starts a topic can choose "The host
  merges each item".
- **Plans go on** after a restart of `smurg host`, when a usage limit ends, after a turn that ended on an error (twice)
  and after an agent's process stopped (once); work items that wait for a person no longer keep the others from
  starting. "Pause" stops a plan until someone continues it, also across restarts ([host guide](docs/HOSTING.md)
  §10.5).
- **The protocol changed (version 6).** Update before you share again (`smurg update`): until then, teammates' pages
  say "The host's smurg is older than this page". A tab from before the update says "This tab is from before an
  update" and needs a reload. If you run your own relay, deploy it again.
```

Traditional Chinese (`docs/zh-TW/CHANGELOG.md`, same heading):

```
## [0.7.0] - YYYY-MM-DD

- **主題會自己跑到最後。** 按下開始之後，工作項目的結果報告寫著完成、至少一項驗證通過、沒有驗證失敗，而且能順利合併時，
  smurg 會把它合併到分享的資料夾，等著它的項目接著從合併後的資料夾開始。不必先有人看報告或按合併。「我已看過」仍然
  保留，作為標記（[主人指南](HOSTING.md) §10.3）。
- **需要決定的地方才會停下**：選擇題、權限模式仍要先問的請求、不是完成且驗證過的報告、有人停下或對 agent 說了話的工作、
  只有主人能合併的檔案、主人的資料夾擋住了、項目的 agent 跟上主工作區之後仍然沒辦法順利完成的合併，或和某個人的修改
  衝突。每一件都會送到該處理的人的收件夾，不依賴它的項目會繼續。「略過
  這個項目」可以不改計畫，就把一個工作項目和依賴它的項目略過。
- **待驗收。** 所有項目都合併之後，每位成員的收件夾都會顯示，新的「成果」欄會列出每一份報告、每個改過的檔案和沒有
  驗證的地方；按「我已驗收」主題就完成了。smurg 有保存版本紀錄時，主人可以復原一個項目或整個主題：用一個新的提交，
  報告都會留著，在它之上做的項目會先列出來（[主人指南](HOSTING.md) §10.3）。
- **結果報告會寫出什麼失敗了**：失敗的驗證寫成 `- [!] …: failed: …`，有失敗的報告不能寫完成。
- **用較早版本的 smurg 分享過的工作區，更新之後會自動合併**：`smurg host` 會用一行說明，主人主控台設定裡的「合併工作
  項目」可以關掉，關掉之後每個項目都由主人合併。更新之前就開始的工作項目仍然會等主人。開始主題的人可以選「每個項目
  都由主人合併」。
- **計畫會繼續**：`smurg host` 重新啟動之後、用量限制結束時、某一輪因錯誤結束之後（最多兩次），以及 agent 的程序停止
  之後（一次）；在等人的工作項目不會再擋住其他項目開始。「暫停」會讓計畫停下，直到有人按繼續，重新啟動之後也一樣
  （[主人指南](HOSTING.md) §10.5）。
- **通訊協定改變了（第 6 版）。** 再分享之前請先更新（`smurg update`）：在那之前，組員的網頁會顯示「主人的 smurg 比這個
  網頁舊」。更新前就開著的分頁會顯示「這個分頁是更新前開的」，需要重新整理。如果你用自己架的 relay，請重新部署。
```

(The zh-TW quotes of the two page sentences are the catalogs' `rejected.version.hostOlder.title` and
`rejected.version.stale.title` as 0.6.0's changelog quoted them; the docs step checks them against
`apps/web/src/strings/connection.zh-TW.ts`.)

## Appendix C. Evidence

| claim | source |
|---|---|
| a team that leaves after Start: stopped 1.2 s later, unchanged at +8 h; six person actions for a clean plan; 2.25 s when a robot takes every formality | U1 M1, M8 (`U1/exp/out/M1-walk-away.json`, `M8-*.json`; `python3 -I U1/exp/show.py`) |
| the host away: nothing merges for 24 h; Mei may never merge | U1 M9 |
| conflict reaches only the host's non-waiting row; Resolve, v2, review, merge | U1 M2 |
| a question and the cards stop only their item and its dependents | U1 M3, M7 |
| restart, usage limit, crash: stopped for ever without a person | U1 M4, M5, M6 |
| waiting sessions hold slots and stall unrelated items | U1 M10 |
| a policy-refused report is a silent dead end | U1 M11 |
| the merge lands on whatever branch is checked out; the dependent starts from it | U1 M12; `topics/store.ts:73-86` (no branch in the pin); `checkpoint.ts` returns `branch` |
| direct mode counts an unfinished item as merged | `report-service.ts:422` (`if (direct) draft.merged = true`); U1 #18 |
| `approve` refuses every system principal | `worktree-manager.ts:1579` |
| finish needs merged AND reviewed; phase `complete` = all reviewed | `scheduler.ts:586`; `core.ts:387-394` (`phaseOf`) |
| a staged change fails every merge with "merge failed" | U2 A8, `U2/exp/vt/staged.test.ts`, `vt/out.txt` |
| automatic merges with author host / committer smurg / trailer; conflict → update in the clone → two-parent commit → clean | U2 exp1 (`runs-folder.txt`) |
| smurg's own history keeps people's edits with the pre-merge snapshot and the recorded base | U2 exp2, exp6 (`runs-hidden.txt`, `runs-hidden-apply.txt`) |
| undo by revert: trial with objects only, one commit, report overlay, redo by reverting the revert, re-merge is "Already up to date", `read-tree -m -u` refuses a dirty file, a merge found by its second parent | U2 exp1 #4-#9, exp3 (`runs-undo.txt`) |
| what goes with an undo: add newest first, then prune; a person's commit named | U2 exp5 (`runs-blockers.txt`) |
| merging around a person's edit: clean on other lines, markers on the same lines, staging dropped | U2 exp4 (`runs-dirty.txt`) |
| the cost of trials: 0.032 s one, 0.33 s twenty, 5,000 files | U2 exp7 (`runs-cost.txt`) |
| keeping 300 decided merges only | `worktree-manager.ts:187-188, :1900` |
| reports and merges are not waiting items; toasts only for waiting ones; topic notices only for open pages; no OS notification | U3 A1, A4; `packages/protocol/src/schema/inbox.ts:65-68`; `apps/web/src/lib/stores/inbox.ts:135-141` |
| 0.6.0's auto-mode argument counted the merge review | U3 A7(a); ARCHITECTURE.md:4447 (D-25); HOSTING.md:426-429, :453-455 |
| report v1 has no failed check | U3 A7(b); `report-format.ts:116, 250-275` |
| the quick start is at its 12-step maximum; the short pages near their bounds | U3 A7(g); `tests/lint/docs-parity.test.ts:106-108`; `apps/site/test/site.test.ts:1362-1363` |
| every sentence that says a person reviews before merging or that the host merges | U3 C (`U3/scan-*.txt`) |
| the 0.6.0 fixture must hold 22 new points and two kept-copy kinds | U4 experiment 1 (`U4/newpoints.json`) |
| `TAG = 'v0.6.0'`: wire.test passes, other-version.test 9 and ctl-other-version.test 1 failures, all expectations of different shapes or protocols | U4 experiment 2 (`U4/out-tag060-daemon.txt`, `out-tag060-cli.txt`, `run-upgrade-tests.sh`) |
| W of 0.6.0 lost its documents and the driver; files unread for ~4 days are deleted | U4 §0 |
| a stale `MERGE_HEAD` in `.smurg/git` blocks every merge with words the host cannot act on | U4 (3); `worktree-manager.ts:1791-1794` (`assertMainIdle`) |
| the restart pause is AD-10 of 0.5.0 and a guide promise | `docs/design/v0.5.0/DESIGN.md:83-87`; ARCHITECTURE.md:2975, :3645; HOSTING.md:1332-1345 |
| `smurg update` refuses while a host runs | `packages/cli/src/commands/update.ts:6` |
| the scheduler's per-dependency gate stops only dependents | `scheduler.ts:180-184` (`unmergedDependencies` in `pass`), `core.ts:468` |
| the merge policy keeps host-only paths, recorded scripts, the spec and plan, links out, `.smurg` | `worktree/review.ts:313-342` (`checkMergePolicy`) |
| the host may request the merge of a policy-refused change and review it | ARCHITECTURE.md:3602-3607 |
| undo in smurg's own history computed before its snapshot takes back people's saved edits in any file; snapshot first keeps them | R-SAFE `exp/undo-order.sh`, `exp/runs-undo-order.txt` (real git 2.49) |
| an automatic resolve over a person's saved edit drops it, the next version merges cleanly and unread, `overlap` from the updated base is `[]` | R-SAFE `exp/resolve-over-person.sh`, `exp/runs-resolve-over-person.txt`; `worktree-manager.ts:1504-1511` (updateFromMain snapshots the folder) |
| a turn after a registered version that did not complete does not stall the item; a new turn of a done item does not make it running | `report-service.ts:191-198`; `scheduler.ts:471-478` |
| a new version is registered after any edit or resolve, also with an unchanged report; "checked" is per session and hash only | `report-service.ts:211, :216-217`; `topics/store.ts:125`; `checkReport` `:143-161` |
| `changesAsked` is set only by a follow-up and its accepted suggestion, and deleted only by `register()` | `report-service.ts:503, :523, :418` |
| `approve` takes `requesterIsHost` from `requestedBy`, marks any status `conflict` and keeps `requestedBy`; its conflict and failure paths audit as `approve` | `worktree-manager.ts:1612, :1638, :1653, :1844-1856` |
| a merged request's diff already uses `mergeCommit^1` | `worktree-manager.ts:1781-1782, :1786` |
| a Start on a detached HEAD gives the branch the literal `HEAD` | `main-repo.ts:180`; `worktree-manager.ts:1953` |
| `afterRestart` looks only at running items; 0.6.0 pauses every topic with armed or interrupted items | `scheduler.ts:734, :747-750`; `attention.ts:19-21` |
| the topics module's stop waits only `core.idle()`; `reconcile` repairs through `onMerge` | `topics/module.ts:168-178`; `scheduler.ts:669-698` |
| stored mention notes use the wire's column target | `inbox/store.ts:40`; `protocol/src/schema/inbox.ts:22-29` |
| `retry` already accepts a system principal | `sessions/agent/agent-sessions.ts:1283-1291`; `core/permissions.ts:9` |
| Editors have `file.write` but not `session.drive`; their worktree edits are listed as by hand | `protocol/src/roles.ts:52-65`; JOINING.md:500-503; `report-service.ts:365` |
