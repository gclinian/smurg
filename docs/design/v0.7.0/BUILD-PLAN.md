# 0.7.0: build plan

Cuts DESIGN.md (D1 to D23) into ten steps that builders do one after the other in ONE checkout of
`/Users/gcman/Desktop/Project/Smurg` on branch `v0.7.0-work`. Each step owns the files it names (a later step may change
a file an earlier one owned; never two steps at once), ends green on its own, makes ONE local commit and writes a
HANDOVER. S0 pays 0.6.0's debt before anything else changes. Revised after the two reviews of 2026-10-27 (answers in
`W/D/ANSWERS.md`): the steps' Owns lists now name every file R-ENG E9 found missing, and each step's Do names the
review's changes it builds.

## Rules for every step (BRIEF.md's, restated where a builder acts on them)

- **Read first**: BRIEF.md, DESIGN.md (its five-minute summary, §1, the decisions your step names, §3, §5), this plan,
  and EVERY earlier step's HANDOVER (`W/build/S<n>/HANDOVER.md`). Reading them also keeps them: files under
  `/private/tmp` that nobody read for about four days are deleted (U4 §0). If the lead's answers to DESIGN §5 exist
  (`W/ANSWERS.md`), they override DESIGN where they differ. (`W/D/ANSWERS.md` is the designer's answers to the
  reviews: already folded into DESIGN; read it for the reasons, not as a contract.)
- **Never** a real Claude account: the real `claude` 2.1.288 only against the repository's fake API with an isolated
  HOME (`claude-harness.ts`); never `~/.smurg`, `~/.local/bin`, `~/.claude` (tests use scratch HOME, SMURG_HOME,
  SMURG_CACHE_DIR); no browser window (the smokes' Chrome is headless); no process left behind (check with `pgrep -fl`
  for what YOUR commands started, signal only those); nothing deleted outside the repository and W.
- **The gate**, from the repository's root after `source scripts/env.sh`, in four FOREGROUND parts (each under 10
  minutes; never end a turn while a command you started still runs):
  - P1 `pnpm typecheck`
  - P2 `pnpm exec vitest run --project @smurg/daemon`
  - P3 `pnpm exec vitest run --project @smurg/web --project @smurg/web-smoke --project @smurg/e2e`
  - P4 `pnpm exec vitest run --project @smurg/cli --project @smurg/protocol --project @smurg/relay --project @smurg/site --project @smurg/lint`
  "Full" = all four green. The counts of each part go into the HANDOVER.
- **The commit**: `git add <the paths you changed, by name>` (never `-A` or `.`), then
  `git -c user.name=gclinian -c user.email=<the author's address> commit -m "<subject in the repository's style: what
  changed and why, in one sentence or a few, as the recent log reads>"`, no attribution lines. Never push, tag, reset,
  rebase, stash, checkout, amend, or touch another branch. `git status --short` after the commit shows nothing of yours.
- **The closed side**: where DESIGN leaves room, take the stricter, smaller, more honest choice and write it in the
  HANDOVER under "Choices I made". Where DESIGN is wrong or impossible, do the closed thing, say so in the HANDOVER under
  "For the lead", and go on; stop only when going on would break a standing decision (BRIEF).
- **The pin** (`packages/daemon/test/upgrade/pin.test.ts`): a step that edits a hashed source answers the pin's
  question in its commit ("this changes no stored shape", or the shape and its step) and rewrites the hashes with
  `SMURG_PIN_WRITE=1`.
- **Words**: every user-facing text is a catalog id of DESIGN Appendix B in both languages, checked against
  `docs/GLOSSARY.md`; a text the design does not give is written in its house style and listed in the HANDOVER.
- **HANDOVER** (`W/build/S<n>/HANDOVER.md`): what was done (by decision); the commit hash and subject; tests added and
  changed on purpose (with why); the gate's counts per part; choices made; what the next step must know; for the lead.

## S0. 0.6.0's debt, and the design kept in the repository (D1, D23's first copy)

**Owns.** `packages/daemon/test/fixtures/published/0.6.0/**` (new), `packages/daemon/test/fixtures/published/README.md`,
`packages/daemon/test/fixtures/drivers/fixture-driver-0.6.0.ts.txt` (new),
`packages/daemon/test/upgrade/{fixture.ts, persisted.ts, fixtures.test.ts, opens.test.ts, refusals.test.ts,
other-version.test.ts, wire.test.ts}`, `packages/cli/test/ctl-other-version.test.ts`, `docs/RELEASING.md` (§4.5's
"After 0.6.0 is published" sentence only), `docs/design/v0.7.0/{README.md, DESIGN.md, BUILD-PLAN.md}` (new: copies of
W's, with a README like 0.6.0's that says they are the record and not the contract).

**Do.**
1. In `W/build/S0/tag/`: `git archive v0.6.0 | tar -x`, its own `scripts/env.sh`, `pnpm install --frozen-lockfile
   --offline`. Write the driver there (as a test file of that tree, e.g. `tests/e2e/test/fx-060.test.ts`), following
   D1 "How it is made": the four workspaces (a)–(d) in one host home, the tag's relay in a local workerd with dev login,
   the tag's stand-in `claude`, scratch HOME/SMURG_HOME/SMURG_CACHE_DIR, `SMURG_NO_UPDATE_CHECK=1`, no network.
2. Take the two pictures, replace the placeholders as the 0.5.0 README says, write files.json, coverage.json,
   ledger.json and README.md (how it was made, the driver's path in the repository, what is `cannot`/`not-made` and
   why). Copy the fixture into the repository.
3. `PUBLISHED_VERSIONS` + '0.6.0'; `FIRST_OF_SHAPES = { 1: '0.5.1', 2: '0.6.0' }`; `NOT_PUBLISHED_YET = {}`;
   `STORIES['0.6.0']`, `UPGRADES['0.6.0']` (no step, no kept copy, the stamp read, `writerOf` gives '0.6.0');
   `LATER_DOCUMENT['0.6.0']`; `TAG = 'v0.6.0'` in wire.test and other-version.test (header comments too); the
   `it.for` lists gain '0.6.0'; ctl-other-version reads v0.6.0's protocol package.
4. Restate other-version.test and ctl-other-version.test over each side's numbers (D1 "The two tests stated over each
   side's numbers"): at this step this tree and the tag have the same `WORKSPACE_SHAPES` and `PROTOCOL_VERSION`.
5. Keep the driver as `packages/daemon/test/fixtures/drivers/fixture-driver-0.6.0.ts.txt` with a header (where it is
   copied in a tag's tree, the one command). RELEASING §4.5: the sentence about 0.6.0's debt becomes what was made, and
   names the kept driver.
6. Copy W/DESIGN.md and W/BUILD-PLAN.md into `docs/design/v0.7.0/` (`tests/lint/no-cjk.test.ts:24` exempts all of
   `docs/design/`).

**Gate.** P1, P2, P4 (nothing in `src/`, no web change). Expected: U4's baseline plus the new 0.6.0 cases; wire.test's
three comparisons RUN against v0.6.0 and pass.

**Commit.** "pay 0.6.0's release debt: its upgrade fixture, made by the tag's own code with a driver kept in the
repository this time; TAG moves to v0.6.0 in the wire, other-version and ctl-other-version tests, which now state their
cases over each side's shapes and protocol; the 0.7.0 design is kept in docs/design/v0.7.0".

**Estimate.** 4 builder-days (the driver is the risk, DESIGN R-5).

## S1. The contract: protocol 6, the setting, shapes 3 (D2, D3's wire and stored keys, D4, D5's wire, the enums of D9 and D13, Appendix A's shapes, B.1's catalog)

**Owns.** `packages/protocol/src/constants.ts` (+ test), `packages/protocol/src/schema/{entities.ts, topics.ts,
inbox.ts, conversation.ts, limits.ts, message-samples.fixture.ts, worst-case.fixture.ts, protocol6.test.ts (new)}`,
`packages/protocol/src/i18n/messages/{conversation,topics,worktrees,activity,inbox}.ts` (B.1),
`packages/protocol/src/routing.ts` (`decisionRecipients`) and its test; `packages/daemon/src/core/{state-store.ts,
workspace-state.ts, config.ts}` (the default `merging: 'auto'`), `packages/daemon/src/frozen/v0.6.0.ts` (new),
`packages/daemon/src/topics/store.ts`, `packages/daemon/src/worktree/store.ts` (the optional keys of D4),
`packages/daemon/src/admin/settings.ts` (the patch accepts `merging`; nothing reads it yet), `packages/daemon/src/
inbox/store.ts` (`storedColumnTargetSchema`, the six kinds of 0.6.0, so inbox.json does not change: DESIGN D4, R-ENG
E4), `packages/daemon/test/fixtures/wire-text-owners.ts` (every B.1 id nothing produces yet, with the step that will),
`packages/daemon/test/upgrade/{persisted.ts, pin.test.ts, fixtures.test.ts (NOT_PUBLISHED_YET of D4), opens.test.ts,
state-steps.test.ts, unfinished.test.ts, refusals.test.ts, set-aside.test.ts, other-version.test.ts, owner.test.ts}`,
`packages/daemon/test/version-refused.test.ts`, the protocol-5 pins (`packages/cli/test/main.test.ts`,
`packages/cli/test/sea.test.ts`, `packages/protocol/test/exports.test.ts`, `tests/e2e/test/workspace.test.ts`,
`packages/protocol/src/schema/protocol5.test.ts` (:120, its `HOST_NOTICES` pin)), `packages/cli/test/ctl-other-version.
test.ts` (`WELCOME_V6`), `.github/ISSUE_TEMPLATE/bug.yml`, every full `HostSettings` literal that the required `merging`
breaks (`packages/daemon/test/{settings,two-phase-start}.test.ts`, `packages/daemon/test/sessions/agent-pure.test.ts`,
`packages/protocol/src/schema/session-info.test.ts`, `apps/web/src/features/console/{settings-form.test.ts,
invites-audit-settings.test.tsx, test-support.tsx}`, `apps/web/src/testing/stores.ts`,
`apps/web/src/lib/stores/stores.test.ts`), the web's Welcome fixtures and the exhaustive switches that a new enum value
breaks (`apps/web/src/strings/stores.ts` `phase.ready`, kinds `decision` and `ready` with their row titles' ids as plain
fallbacks until S7), the in-memory fakes of the daemon where a type demands it.

**Do.** Every wire shape of Appendix A that the WELCOME, a Topic, a WorkItem, a PlanInfo, a preflight, a report or an
inbox item carries, all optional where Appendix A says so, so that today's derivation stays valid (the reasons of D9
with `asked`, `stopped`, `stale-report`, `by-hand`, `undo-interrupted`; `autoMerge.people` and `.asked`; the
preflight's `detached`; `SMURG_PURPOSES` + `remove-paths`, `verify-again`; the `AUDIT_ACTIONS` of D4); every stored
optional key of D4 (`turns`, `checked[].turn`, `lastTurn`, `autoMerge.people`, the report's `checkedInTurn` and
`changes.byHandTruncated`, the undo record with `target`) and its NOT_PUBLISHED_YET point; NOT the new message types
(each comes with its handler, its `MESSAGE_SAMPLES` and `REQUEST_SAMPLES` entries and its authorization row in a later
step: `registry.test.ts:577` and the mapped `REQUEST_SAMPLES` type demand exactly the registered types). The state step
from 0.6.0 with the frozen shape; `WORKSPACE_SHAPES = 3`, `STATE_VERSION = 3`,
`HOST_NOTICES` + `auto-merge`, `TODAY_SINCE.state = '0.7.0'`, the kept-copy kind, `FIRST_OF_SHAPES[3] =
NOT_PUBLISHED`. ARCHITECTURE §0 rule 8's sentence is S8's. Behaviour: none changes (the setting exists, defaults to
`auto`, nothing reads it).

**Gate.** Full. Expected: other-version.test now refuses this tree's folder with v0.6.0 ("Run smurg update. Nothing was
changed."); wire.test says "raised" for v0.6.0 and skips its comparisons.

**Commit.** "protocol 6 and workspace shapes 3, the contract of 0.7.0: the workspace setting merging (auto by default,
and for workspaces of 0.6.0 and earlier at the update, the owner's words of 2026-10-26), the pin's merging and branch,
the report's failed check, the phase ready, the inbox kinds decision and ready and what a work item says about its
merge; one step for state.json, every other change an optional key; nothing reads the setting yet".

**Estimate.** 4 builder-days.

## S2. The report says what failed; the worktree module merges by itself (D5, D7)

**Owns.** `packages/daemon/src/topics/report-format.ts` (+ test), `packages/daemon/src/topics/prompts.ts` (the
format's failed line and sentence only) (+ test), `packages/daemon/src/worktree/{worktree-manager.ts, git.ts, names.ts,
main-repo.ts, review.ts, people-changes.ts (new)}` (+ tests under `packages/daemon/test/worktree/`),
`packages/daemon/src/core/interfaces.ts` (`WorktreeService.autoMerge` with `stillInOrder` and `consent`,
`pendingMergeParent`, `AutoMergeOutcome` with `people`), `packages/daemon/src/core/fakes/worktrees.ts` (a fake whose
`main` queue a test can hold, for S3's race tests),
`packages/daemon/test/worktree/merge.test.ts` (the staged case on purpose), the web report column's failed check
(`apps/web/src/features/topics/ReportColumn.tsx`, its strings `report.check.failed`, `report.checks.line`, + tests).

**Do.** D5 whole (parser, model sentences, format text, wire counts already in S1). D7 whole: `decide(found, decider,
how)` shared by `approve` and `autoMerge`, with the audit action and actor from `how` (an automatic try never writes a
`worktree.merge.approve` entry); `stillInOrder()` at entry and at step 9b with no `await` before the spawn; the branch
guard, again at 9b with `mainHead === pre`; the staged check (and `approve` now refuses with `merge.staged`); the cheap
lock look on the request's own paths before any snapshot (4b); `requesterIsHost` false for every automatic merge, and
only drafts and unrequested conflicts; who changed the other side of a conflict (`people-changes.ts`, both histories);
`overlap` from the Start's commit; smurg's own `MERGE_HEAD` in the folder's `.git` recognised and named; the
`undo-interrupted` hold when an unsettled undo record is there; waits and holds as outcomes, author/committer split and
the trailer, `auto: true`, `consent`, the audit and activity entries; `pendingMergeParent`; the abort of smurg's own
history's leftovers at the module's start. The merged request's diff is NOT changed (`review()` already uses
`mergeCommit^1`, R-ENG E11). Nothing calls `autoMerge` yet.

**Gate.** Full.

**Commit.** "the result report can say that a check failed (- [!] …: failed: …), and a report with one cannot say
complete; the worktree module can merge a work item by itself on the host's standing consent (author the host,
committer smurg, a trailer, its own audit entry), only into the branch the Start used and never over a staged index,
which also names 0.6.0's 'merge failed' when something is staged; whether it is still in order is asked again inside
the merge queue and just before git merge, and a conflict says who changed the other side".

**Estimate.** 4 builder-days.

## S3. The merge queue: Start's policy, "in order", update and resolve, the finish rule (D3's behaviour, D6, D8, D12, D17)

**Owns.** `packages/daemon/src/topics/{auto-merge-verdict.ts (new), auto-merge.ts (new), core.ts (mergingOf,
toWorkItem's merging and autoMerge, the reports' rows of auto items), plan-service.ts (Start: pin merging and branch,
preflight merging, the `merging: 'host'` payload), scheduler.ts (onMerge's mergedAs, the finish rule), report-service.ts
(register wakes the queue, the sweep, the escalation of reports only for host items, a new version clears a hold),
module.ts, prompts.ts (D17: the merge sentence, mergedBefore, peopleChanged, removePathsMessage,
verifyAgainMessage)}`, `packages/protocol/src/schema/messages/topics.ts` (plan.start's `merging`),
`packages/daemon/src/inbox/derive.ts` (no report row, and no merge row for drafts and unrequested conflicts of auto
items), tests: `packages/daemon/test/topics/{auto-merge-verdict.test.ts, auto-merge.test.ts}` (new), `reports.test.ts`,
`scheduler.test.ts`, `plan.test.ts`, `prompts.test.ts`, derive tests; every test that follows 0.6.0's review-then-approve
and would meet `merge.notPending` once smurg has merged (R-ENG E9 (a)), each either setting `merging: 'host'` or
expecting the automatic merge (say which, per file, in the HANDOVER): `release-flow.items/topic/members.test.ts`,
`release-flow.restart.test.ts` (:308-310), `worktree-items.test.ts`, `packages/daemon/test/topics/real-git.test.ts`
(:106-109), `tests/e2e/test/t.topic-flow.test.ts`, `tests/e2e/test/r11.console.test.ts` (:193, :229), and the web
smokes that press review and merge (`apps/web/e2e/smoke/{flow,flow.zh-TW,topics}.smoke.test.ts`: their workspace setup
only); `packages/daemon/test/integration/release-flow.unattended.test.ts` (new, from `U1/exp/measure.test.ts`: M1, M8,
M2, M9, M13, M14, M16 as DESIGN D22 says).

**Do.** D6 as a pure function with its table test, all sixteen rows (the person's message and the stopped turn, the
hand edits, the report checked in its turn, requested merges the host's) and `stillInOrder` over it; the report
service's new facts (`turns`, `checked[].turn`, `checkedInTurn`, `lastTurn`, `changesAsked` at a turn's end); D8's queue
inside `core.serialize` with the stop check, its triggers and re-checks (no trial per sweep), outcomes (a conflict with
a person's change held at once), verify again, update and resolve in its recorded order (three tries), the forced
snapshot while resolving, the restart of a resolving item, `behind`, clearing, audit, conversation lines; `onMerge` the
one writer of `mergedAs`; D3's Start (the detached pin), preflight (`detached`) and `mergingOf`, and the setting's turn
to `host` rewriting the pins with its `plan.merging.host` entry (also at a start); D12 (review a mark under auto, the
rows, the finish rule); D17's prompt sentences. The decisions are stored (`held`) but have no inbox row yet (S4).

**Gate.** Full. The flow smokes may need `merging: 'host'` in their workspace setup to keep testing the 0.6.0 flow
until S7 writes both: do exactly that (one line per smoke), and say so.

**Commit.** "work items merge by themselves when they are in order: a Start records the policy and the branch in each
item's pin (a member may choose that the host merges; a detached HEAD is the host's), one queue merges the oldest report
first and checks again at the moment of the merge, a report must be checked in the turn that made it, a later stop or a
person's message holds the item, a merge that is not clean against other work items is brought up to date and resolved
by the item's own agent up to three times while one against a person's change is a decision, turning the setting off
gives every started item to the host, and an item's session and worktree stay until it is reviewed or its topic is
checked; review is a mark for these items".

**Estimate.** 7.5 builder-days.

## S4. Decisions, the end, leave out, direct mode's fix (D9, D10, D11, D13)

**Owns.** `packages/daemon/src/topics/{core.ts (phaseOf with ready, toTopic's checked/leftOut/undone, waitingFor's
decisions, WorkItem.waiting, the escalation of holds), plan-service.ts (leaveOut, accept, removePaths), topic-service.ts
(topic.check), report-service.ts (direct items in order or held), attention.ts (`unblocks`), handlers.ts}`,
`packages/protocol/src/schema/messages/topics.ts` + `registry.ts` (`topic.check`, `plan.item.leaveOut`,
`plan.item.accept`, `plan.item.release`, `plan.item.removePaths`), `packages/protocol/src/schema/
message-samples.fixture.ts` (`MESSAGE_SAMPLES` for those five), `packages/daemon/src/inbox/{derive.ts (decision and
ready rows), inbox-service.ts}`, `packages/daemon/test/fixtures/request-samples.ts`, `packages/daemon/test/
authorization.test.ts` (their rows), `wire-text-owners.ts` (the ids now produced leave it), tests (topics, inbox,
no-git.test.ts on purpose for D10), and `release-flow.unattended.test.ts` (M3, M6's partial report, M7, M11, M12,
M15).

**Do.** D9 (routing already in S1; the rows, escalation, `unblocks`, `waiting`, `waitingFor.decisions`, "Merge it as
it is" = `plan.item.release`), D10 (with `stale-report` for direct items), D11 (with the wait for a merge in flight),
D13's daemon half (settled with nothing in progress; `complete` only when checked or every item settled and reviewed;
`checked` cleared by a later version; the request; the ready row; the Result column is S7's).

**Gate.** Full.

**Commit.** "what needs a person is a decision in that person's inbox and stops only its item and what depends on it:
a report that is not complete and verified, a merge that stays unclean, files only the host may merge (no longer a
silent dead end); 'Leave it out' drops an item and its dependents without editing the plan; an unfinished direct item
no longer lets its dependents start; a topic whose items are all merged is ready to check, and 'I've checked the
result' completes it".

**Estimate.** 5.5 builder-days.

## S5. Undo (D14)

**Owns.** `packages/daemon/src/worktree/{undo.ts (new), worktree-manager.ts (undoPreview, undo, the crash record at
start)}`, `packages/daemon/src/topics/plan-service.ts` (undo's topic half, the claim), `packages/daemon/src/topics/
core.ts` (the claim D6 row 2 reads), `packages/protocol/src/schema/messages/topics.ts` + `registry.ts`
(`topic.undo.preview`, `topic.undo`), `packages/protocol/src/schema/message-samples.fixture.ts`,
`packages/daemon/src/core/interfaces.ts`, the fakes, tests (`packages/daemon/test/worktree/undo.test.ts` new, with the
real git; topics undo; `packages/daemon/test/authorization.test.ts`; `packages/daemon/test/fixtures/request-samples.ts`).

**Do.** D14 whole, U2's scripts as the model for the tests (`U2/exp/scripts/exp1..7`) and R-SAFE's
`R-SAFE/exp/undo-order.sh` as the model of the test that a person's unsnapshotted saved edit survives: in smurg's own
history the snapshot is the first step of the preview and of the apply; the token over what the undo does, not the
head; `peopleChanges` (from S2) for `changedSince`; `leftOut` with done and held dependents; the claim before the
worktree's apply; the record with `target` and the start's four cases (a)–(d), with a kill between `read-tree -m -u`
and the commit in both histories; the words of what undo cannot take back (their catalog ids come in S7; the daemon
side has none).

**Gate.** Full.

**Commit.** "the host can undo a merged work item or a whole topic where smurg keeps history: one revert commit after a
trial that touches nothing, the reports kept, what was built on it and later merges of the same lines named and undone
with it, people's later changes, uncommitted edits and typing named and never overwritten, and a crash between the
commit and its record recovered from the commit's own words".

**Estimate.** 4.5 builder-days.

## S6. Keeping it running, and telling the host (D15, D16, D18)

**Owns.** `packages/daemon/src/topics/{scheduler.ts (afterRestart, the automatic continues, the slot rule),
plan-service.ts (pause, resume), report-service.ts (stall causes), core.ts (slots)}`, `packages/daemon/src/daemon.ts`
(`continued()`), `packages/daemon/src/admin/settings.ts` (the attention fact `auto-merge`, `admin.notice.seen`),
`packages/protocol/src/schema/messages/{topics.ts, admin.ts}` + `registry.ts` (`plan.pause`; the notice),
`packages/protocol/src/schema/message-samples.fixture.ts`, `packages/daemon/test/fixtures/request-samples.ts` and
`packages/daemon/test/authorization.test.ts` (`plan.pause`), `packages/daemon/src/local/protocol.ts` (status topics, the
stop answer's `goOn`), `packages/cli/src/commands/{host.ts (watchTopics, the start lines, `goOn()` after them, the stop
line at Ctrl-C), host-state.ts (mergesAutoNotice, plansContinue, plansPaused), stop.ts (the status lines, the stop
line)}`, `packages/cli/src/i18n/{en.ts, zh-TW.ts}` (B.3), `packages/cli/test/{host-state-words.test.ts,
guide-anchors.test.ts, host-state-file.test.ts (:365-373, `PAUSED_050`), …}`, the upgrade tests that start a daemon on
a published fixture and now meet D15's start (`packages/daemon/test/upgrade/{opens,refusals,unfinished}.test.ts`, R-ENG
E9 (c)), `packages/daemon/test/integration/release-flow.restart.test.ts` (changed on purpose),
`release-flow.unattended.test.ts` (M4, M5, M6's crash, M10).

**Do.** D15 (with `goOn()` deferred until `smurg host` printed its start lines; a continue that cannot be sent leaves
`stalled(restart)`; the automatic continues for turns after a version and `held: stopped` when they are spent;
`retry(sessionId, SYSTEM_PRINCIPAL)`; the fixtures' start as D15 states it), D16, D18 (the stop line at Ctrl-C and in
`smurg stop`; the start line before `goOn`), D4's one audit entry of the state step at the first start (in
`admin/settings.ts`) (the console's banner is S7's).

**Gate.** Full.

**Commit.** "plans go on by themselves after a restart of smurg host (a person's Pause stays, and so does a topic with
an interrupted direct item), after a usage limit, after a broken turn (twice) and after a crash (once); sessions that
wait for a person no longer keep unrelated items from starting; smurg host says at the update that work items merge by
themselves, at a start what went on, and while it runs which topic is ready to check or waits for the host".

**Estimate.** 4.5 builder-days.

## S7. The web app (D19) and the smokes (D22)

**Owns.** `apps/web/src/features/topics/**` (StartDialog, start-model, PlanColumn, PlanItems, model, ReportColumn,
ResultColumn (new), TopicDialogs, dialogs, strings), `apps/web/src/features/sidebar/**` (inbox rows, tree model,
strings), `apps/web/src/features/console/**` (settings, banner, audit labels), `apps/web/src/features/worktree/
strings*.ts` and the merged-by-smurg mark, `apps/web/src/features/conversation/strings*.ts` (`next.report.*`),
`apps/web/src/features/columns/**` (the `result` target), `apps/web/src/lib/stores/topics.ts`,
`apps/web/src/app/workspace/WorkspaceShell.tsx`, `apps/web/src/strings/**`, their unit tests in both languages, the
smokes `apps/web/e2e/smoke/{flow.smoke.test.ts, flow.zh-TW.smoke.test.ts, topics.smoke.test.ts}`, `apps/web/README.md`
(:888, :942, :1281, :1416).

**Do.** D19 whole (with the review's words: "what its report says is complete and verified", `start.merge.detached`,
the decision actions `decision.asIs` and the person-conflict lines, the new `decision.inTheWay.*` words, `badge.waitsMerge`
only for a host dependency, `complete.body.unmerged` gone, the undo dialog's limits and items of other topics named
with their topic); the smokes of D22 (both flows covered: automatic merging, and "I merge each item myself" with
0.6.0's steps).

**Gate.** Full. P3 is the long part (about seven minutes in 0.6.0) and grows with both flows and the Undo smoke
(R-ENG E14): S7 measures it; when it comes within a minute of the 10-minute rule, it is split into two foreground parts
(P3a `--project @smurg/web`, P3b `--project @smurg/web-smoke --project @smurg/e2e`), and the HANDOVER and ACCEPTANCE "How
to run the gate" record the five parts from then on.

**Commit.** "the web app for topics that run by themselves: the Start dialog says how items merge and what stops the
run, the plan shows merges, waits and decisions, a decision's foot offers what each person may do, the new Result
column, the inbox rows for decisions and topics ready to check, Leave it out, Undo and Pause, and the host's setting
with its banner".

**Estimate.** 7 builder-days.

## S8. Docs, site, picture, words lint, ARCHITECTURE, ACCEPTANCE (D20, D21)

**Owns.** `docs/{QUICKSTART, HOW-IT-WORKS, SECURITY-MODEL, HOSTING, JOINING, GLOSSARY, ARCHITECTURE, ACCEPTANCE}.md` and
their zh-TW twins where they exist, `README.md`, `README.zh-TW.md`, `apps/site/public/index.html`,
`apps/site/public/zh-TW/index.html`, `apps/site/scripts/site.ts`, `apps/site/README.md`, `apps/site/test/site.test.ts`,
`scripts/readme-picture.ts`, `scripts/readme-picture/words.zh-TW.ts`, `.github/assets/readme-picture-*.svg` and the
width files (regenerated), `tests/lint/{docs-quotes.test.ts, auto-merge-words.test.ts (new), docs-parity.test.ts,
readme.test.ts}` and what else holds a changed sentence.

**Do.** D21's table word for word, every place of U3's inventory, ARCHITECTURE's sections (§2 and D-25 with DESIGN §3
point 1's sentence on what a teammate can add through a worktree) and the new D-29 and D-30, §0 rule 8's sentence (D4),
ACCEPTANCE's rows (D22, M13–M16 included), GLOSSARY's table (D20), the lint with both rules of D20 (the "smurg verifies"
family, and "complete and verified" in a sentence without "report"), HOSTING :453-455's new sentence on another item's
checkout, §10.3's "Undo and its limits" and the sentence on unattended agent turns, §10.5's stop line. Measure the short pages on the
built page; raise a bound only by the sentence the truth adds, and say so. Render the home page's changed card and the
picture's two scenes to still images in W (headless) for the owner to look at before the site is deployed; never deploy.

**Gate.** Full.

**Commit.** "the guides, the README and the site say what 0.7.0 does: work items that are complete and verified merge by
themselves without anyone reading them first unless the host turns it off, the run stops only for a decision, the team
checks the result at the end and the host can undo; the home page's fourth card and the picture's Build and Review
scenes change only as far as that requires".

**Estimate.** 4 builder-days.

## S9. The release files and the release gate (D23)

**Owns.** the eight `package.json` (0.7.0), `CHANGELOG.md`, `docs/zh-TW/CHANGELOG.md` (B.6, `YYYY-MM-DD`),
`docs/RELEASING.md` (§4 step 3 (b) for 0.7.0, §4.5's lists, "What a release owes"), `docs/ACCEPTANCE.md` ("How to run the
gate" with this build's counts), `docs/design/v0.7.0/` (the final DESIGN and BUILD-PLAN, the lead's answers if any, the
README), `packages/cli/test/sea-upgrade.test.ts` expectations for five executables if S1 did not finish them.

**Do.**
1. The published executables 0.4.0, 0.5.0, 0.5.1, 0.5.2 and 0.6.0 for this machine from
   `https://downloads.smurg.ai/v<version>/`, each checked against that version's `SHA256SUMS`, into `W/build/bin/`
   (W lost 0.6.0's copies: U4); nothing else from the network.
2. `scripts/build-sea.sh --version 0.7.0` (its smoke tests).
3. The release gate in four parts with `SMURG_RELEASE_GATE=1`, `SMURG_PREVIOUS_BINARIES` (the five),
   `SMURG_SEA_BINARY`, and `SMURG_TEST_CLAUDE_BIN=/Users/gcman/.local/share/claude/versions/2.1.288` (the real-Claude
   suite of eight files runs, against the fake API only); nothing pending (`wire-text-owners.ts` empty, the pending
   lists empty).
4. The release dry run's manual steps of RELEASING §4.5 that need no account (`--version` says `protocol v6`, status,
   stop). The Ubuntu VM's gate (`W/../v060/vm/gate.sh` survives) is the lead's to run or to hand to a builder with the
   VM; say in the HANDOVER whether it ran.

**Gate.** The release gate above, in four foreground parts.

**Commit.** "smurg 0.7.0, the release files: version 0.7.0 in the eight package.json and both changelogs, dated
YYYY-MM-DD until the owner releases; RELEASING names 0.7.0's protocol order and the five published executables the gate
runs; the design is kept in docs/design/v0.7.0; ACCEPTANCE records this build's gate".

**Estimate.** 2 builder-days.

## Order and size

S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9, about 47 builder-days (DESIGN R-9; 43 before the reviews: S2 +1, S3
+1.5, S4, S5 and S6 +0.5 each). S3 and S7 carry the most;
S0's driver is the largest unknown. After S9 the lead runs the reviews (security and honesty, engineering and upgrade),
the fixes, the VM gate and the release (RELEASING §4 step 3 (b)), and shows the owner the home page's pictures before
the site is deployed.
