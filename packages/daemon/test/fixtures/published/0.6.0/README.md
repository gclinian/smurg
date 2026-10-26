# 0.6.0: what the code of tag v0.6.0 wrote

Read `../README.md` first (what a fixture is, the copy step, files.json, coverage.json).

This one is made to hold **an instance of everything 0.6.0 can persist** (the stored shapes 2): every state document,
every other persisted file, and of their schemas every optional key, a filled array and record, and every branch of
every union that the code of 0.6.0 can write; what 0.6.0 added to the disk (a topic's agent settings, a session's
model and mode chosen by a person, the workspace's `permissionMode` and the host's notices, direct items and the
history of their pins, smurg's own history in `worktrees.json`, the records that say which repository they belong
to, a merge's recorded base, the stamp with `shapes: 2`); and, in more workspaces of the same host, what that code
makes of what 0.5.2 wrote (the kept copies of the step from 0.5.0), of a folder without `.git`, and of a host without
the git program. What is not in it is listed in coverage.json with the reason, each one.

## How it was made

On 2026-10-27, on macOS (arm64), by step S0 of smurg 0.7.0 (DESIGN 0.7.0 D1), the way the fixtures of 0.5.x were made
(0.5.2's README, "How it was made"), with one difference: the driver is kept in the repository this time. Nothing was
typed into a state file but one line per workspace of (b), said below.

1. `git archive v0.6.0` into a scratch folder; its own tools (`scripts/env.sh`: Node 22.22.1, pnpm 10.34.5) and
   dependencies from the repository's package store (`pnpm install --frozen-lockfile --offline`). Nothing was downloaded.
2. One test file in that scratch tree drives everything: `tests/e2e/test/fx-060.test.ts`, kept as
   `../../drivers/fixture-driver-0.6.0.ts.txt` (its header says where it is copied and the one command that runs it;
   about nine minutes). It uses the tree's own test support and nothing else:
   - the **relay** of that tree in a local workerd (`@smurg/relay/testing` startLocalRelay, dev login on), told about
     a GitHub that is the relay tests' own mock (`apps/relay/test/mock-idp.ts`);
   - the **stand-in for Claude Code** of that tree (`@smurg/daemon/testing` installFakeClaude: the same protocol on
     the pipes, a script instead of a model, no network), first on the PATH as `claude`. No real Claude Code ran,
     nothing was billed, the built-in relay was never named (every command got `--relay`), nobody's own `~/.smurg`
     was touched (`HOME`, `SMURG_HOME` and `SMURG_CACHE_DIR` were scratch folders), `SMURG_NO_UPDATE_CHECK=1`;
   - the **command** from source (`node packages/cli/src/main.ts`), as processes of their own;
   - **people**: clients of the client library (`@smurg/protocol/client`) with their device key and pin in files.
   The story's folder is a short one the tree's own `createTempRunDir` made (the sockets of `SMURG_HOME/run` must fit
   a Unix socket path), removed at the end by its `removeTempRunDir`.
3. One host home, four shared folders, in this order in its `workspaces.json`:
   - **(a) the Bookshop** (`project/`), the story of the 0.5.x fixtures step for step, with the same people, links and
     labels, played by the code of 0.6.0: `smurg login --relay <relay> --dev-user host`; `smurg host <project> --name
     Bookshop --role editor` (a git repository with two files); the tree's own story (`t.topic-flow.test.ts`: the
     topic "Checkout" from its first message to "complete", now with its model and mode chosen by Mei) against
     `smurg host`, its restart a `smurg stop` and `smurg host`; then two more runs (`--role viewer --expires 30d
     --max-uses 20`, then `--role agent --expires 2d --max-uses 3 --web-origin http://localhost:<port>`) with
     everything the 0.5.2 README lists (settings, invites of every state, members who join, leave, are removed, come
     back, change role; files, uploads, the editor, conflicts; terminals and worktrees with merge requests of every
     outcome; agent sessions with tools and permission cards of every kind; suggestions of every origin and outcome;
     "Gift cards" with seventeen work items that end differently; more topics, and "Wishlist" at work when the
     pictures are taken; 125 writes by an Editor in a minute; a member who uses the command). What 0.6.0 adds:
     the workspace's default mode is auto; a teammate's agent session in auto mode whose commands smurg's own gate
     asks the host about (`writes-host-only`, `writes-outside`, and the trusted project settings' scripts:
     `may-reach-settings-script`, in the main folder and in a worktree), three commands auto mode's check refuses,
     sessions whose model a person chose, one whose model the agent cannot use; what the host and the people do
     with sessions (a rule removed, an agent restarted, who is responsible, an entry removed by the host).
   - **(b) what 0.5.2 wrote** (`b052/`): the tree's own copy step (`packages/daemon/test/upgrade/fixture.ts`
     `copyPublishedFixture`) put the `stopped` picture of the 0.5.2 fixture (both its workspaces: its Bookshop, and
     the one 0.4.0 wrote) into `b052/`; the two workspace folders and logs were moved into the host's `SMURG_HOME`,
     and their entries added to the host's `workspaces.json` with this relay's address (the one line per workspace
     of a stored file the driver wrote). `smurg host` of each and `smurg stop`: the code of 0.6.0 ran the step from
     0.5.0 on each, kept what it changed, stamped the folders and set the host's notice `agents-auto`.
   - **(c) a folder without `.git`** (`nogit/`, "Notes"): `smurg host` makes smurg's own history (`.smurg/git`);
     a topic, a Start, a work item in its own checkout, a report, a review and a merge; Kate joins, and in auto mode
     a command of hers whose target smurg cannot read asks the host (`writes-unknown`); a checkout of smurg's
     history that Kate keeps.
   - **(d) no git program** (`direct/`, "Direct"): `smurg host` with a PATH without git; a Start that the host
     confirms, whose work item runs directly in the shared folder and is reported without a diff.
   - Then six and a half minutes of waiting for the Bookshop (a report is escalated after six times the host's one
     minute), a review by the host in place of the responsible member; the picture `running` (`smurg host` of the
     Bookshop running); `smurg stop`; the picture `stopped`.
4. The driver then wrote files.json, coverage.json (with the reasons of what no file visits: `REASONS` and
   `ENUM_REASONS` in the driver) and ledger.json, and parsed every file of both variants with the schema of 0.6.0 it
   is an instance of. This README was written from what it left.

## What was changed afterwards (and nothing else)

`/__SMURG_FIXTURE__` stands for the scratch folder. In the stored files:

| in the files | was | files |
|---|---|---|
| `/__SMURG_FIXTURE__/project` | the Bookshop's shared folder (`workspaces.json`, worktree roots and shared links in `state.json`, paths in cards, conversations, audit, the ledger) | 17 |
| `/__SMURG_FIXTURE__/b052/project` | the shared folder of 0.5.2's Bookshop as the copy step made it (its entry in `workspaces.json`, its documents and kept copies) | 2 |
| `/__SMURG_FIXTURE__/b052/old` | the folder of the workspace 0.4.0 wrote, carried by the 0.5.2 fixture (`old/project`) | 2 |
| `/__SMURG_FIXTURE__/b052/outside` | what 0.5.2's fixture has as `/__SMURG_FIXTURE__/outside`, after the copy step | 1 |
| `/__SMURG_FIXTURE__/b052/host` | what 0.5.2's fixture has as `/__SMURG_FIXTURE__/host` (its host home), after the copy step | 1 |
| `/__SMURG_FIXTURE__/nogit` | the shared folder without `.git` (its entry in `workspaces.json`, its worktree roots) | 2 |
| `/__SMURG_FIXTURE__/direct` | the folder shared without the git program | 1 |
| `/__SMURG_FIXTURE__/host` | the host's `SMURG_HOME` (the hook sockets in the launch files of `running`, lines of the logs of (b)) | 8 |
| `/__SMURG_FIXTURE__/home` | the scratch `HOME` (the host's own rules about `~/.ssh` and `~/.claude*` in the launch files of `running`) | 6 |
| `/__SMURG_FIXTURE__/smurg-src` | the scratch tree (the hook and MCP commands in launch files) | 28 |
| `/__SMURG_FIXTURE__/node` | the Node executable (the same commands) | 28 |
| `fixture-host` | the name of the computer (the device name of the member who uses the command, in the Bookshop's `state.json`) | 2 |

5 more files have `fixture-host` from the 0.5.2 fixture they came from (the state of (b) and its kept copies).

(`files`: in how many stored files of both variants.) The copy step puts the copy's real path where
`/__SMURG_FIXTURE__` is, so `project` and `host` are right again; the others then name folders that do not exist,
which nothing reads at a start (the copy step makes no `b052/`, `nogit/` or `direct/`: a test that opens one of those
workspaces makes its folder first).

Not copied: the shared folders with their worktrees and smurg's own history (see `../README.md`), the scratch homes,
the stand-in, caches, the sockets of `running` (`run/*.lk`, `*.ctl`, `*.hook`: a socket is no file).

Numbers of the computer it was made on that are still in it: `targetDev` in the upload manifests, the process ids in
`running`'s `sessions.json`, `run/*.pid` and the ledger's `statusFirstRun`, the relay's port in its address (`http://127.0.0.1:65444`).

Every key here was made for this fixture: the daemon's `identity.key` of the Bookshop, (c) and (d), the device keys, the invite
secrets in `ledger.json`, and the relay session tokens in the two `credentials.json` (signed by a key that existed only
in that test relay). The "GitHub" account `github:12345` is the mock provider's test user. The workspaces of (b) have
the keys, people and links of the 0.5.2 fixture (its README).

## The instants

| variant | `at` (ms) | UTC | what |
|---|---|---|---|
| stopped | 1793046170531 | 2026-10-26T20:22:50Z | after the last `smurg stop` |
| running | 1793046168721 | 2026-10-26T20:22:48Z | 1.8 s earlier, `smurg host` of the Bookshop running |

A test sets its clock to `at`. Usable invite links expire from 2026-10-28 on.

## What it holds

Workspace `ws_F27C8c23tOki0srDo4u9aQ` ("Bookshop"), host `dev:host`. `running` unless said otherwise; `stopped` differs where a stop changes things.

- **The stamp** (`written-by.json`): `{"smurg":"0.6.0","shapes":2}`, `at` the last start (2026-10-26T20:16:10Z; the same in `stopped`: yes).
- **Members, 17:** host active 1, agent active 6, editor active 4, viewer active 3, agent kicked 2, editor kicked 1.
- **Devices, 19:** web in use 14, web revoked 4, cli in use 1.
- **Invites, 29:** revoked 5, usable, used before 4, used up 11, usable, used never 8, expired 1.
- **Settings:** `{"humanLockIdleMs":45000,"agentLockTimeoutMs":60000,"uploadChunkSize":1048576,"sharedDirs":["data"],"permissionMode":"auto","diskReserveBytes":5368709120,"diskReservePercent":3,"maxLiveAgents":2,"escalateAfterMs":60000,"agentMcp":true}`; `hostNotices`: `[]` (the workspace was made by 0.6.0: it has no notice to show).
- **Worktree roots, 22**, 17 of them of a work item, each with the shared link `data`.
- **Worktrees:** running: of a session, kept 3, of a work item, in use 17, of a session, in use 2; stopped: of a session, kept 4, of a work item, in use 17, of a session, in use 1. **Merge requests:** merged 7, rejected 1, pending 2, conflict 1, draft 3.
- **Terminal sessions** (`sessions.json`): running 16 live with their processes; stopped none.
- **Agent sessions, 48** (`agent-sessions.json`, purpose, state and why ended): discussion live 9, item ended / merged 4, free live 7, free ended / ended 3, free ended / terminated 1, free ended / left 1, free ended / kicked 1, free ended / role-changed 1, item live 15, item ended / ended 1, free failed 2, discussion ended / terminated 2, discussion ended / archived 1;
  3 of them with messages that wait for a turn (running; 0 in stopped);
  a mode a person chose (`modeChoice`): ask-commands 2, ask-all 11, auto 1; a model a person chose (`model`): sonnet 4, opus 1.
- **A topic's agent settings** (`topics[].agent`): Checkout `{"model":"sonnet","permissionMode":"ask-commands"}`, Gift cards `{"permissionMode":"ask-commands"}`, Wishlist `{"permissionMode":"ask-commands"}`, each with who chose.
- **Conversations** (`transcripts/`): 48 sessions, 48 segments. **Cards** (per-session `cards.json`): permission allowed 11, permission denied 7, permission open 2, permission withdrawn 5, question answered 3, question open 1, question withdrawn 4 (running); the same in stopped.
- **Suggestions, 20** (origin, status, why closed): revise accepted 1, composer pending 4, composer withdrawn 1, composer rejected 2, selection accepted 2, composer accepted-modified 2, composer accepted 1, composer withdrawn / author-kicked 1, composer withdrawn / author-demoted 1, composer rejected / session-ended 2, follow-up pending 2, composer rejected / topic-archived 1 (running).
- **Reports, 10:** v1 partial reviewed 1, v1 complete reviewed 2, v2 complete reviewed 2, v1 complete to-review 3, v2 blocked to-review 1, v1 complete invalid 1; escalated: 4 (stopped).
- **Inbox:** 10 members with a box; notes: mention 14, result 3 (running; mention 15, result 3 in stopped); read marks: 1.
- **Claude Code project settings** (`claude-trust.json`): decisions trust 1, ignore 2; loaded entries trusted 1, ignored 1.
  **The host's own rules** (`host-rules.json`): 4 of the main folder, 4 of worktrees, seen: false, notices: subscription.
- **Conflicts, 7:** open 5, applied 1, dismissed 1; 7 kept versions in `conflicts/`.
- **audit.jsonl:** running 1,008 lines, stopped 1,025; 82 different actions; outcomes: ok 1004, denied 18, error 3; actors: system 191, user 628, agent 206 (stopped).
  **audit-overflow.jsonl:** 4 lines (file.write 4). **audit-text.jsonl:** 103 texts.
- **activity.jsonl:** 320 lines (stopped): agent.edit 69, conflict 7, external.change 68, file.create 7, file.delete 2, file.rename 1, file.upload 1, human.edit 149, lock.denied 2, merge 14.
- **The host's other files:** `credentials.json`, `workspaces.json` (five shared folders), `logs/<workspace id>.log` of
  each; in `running` also `run/<12 characters>.pid` and the launch files of the sessions that have a process
  (`sessions/<workspace key>/<hex of the session id>/settings.json`, `mcp.json`, `role.md`).
- **cli-member/** (`github:12345`): `credentials.json`, `workspaces.json` (one joined workspace, with `web`),
  `device.key`, `pins/`; this member logged in with GitHub (the mock) and has an `avatarUrl` in `state.json`.
  **devices/**: device.key and pins/ of 21 devices of the people who joined with the client library
  (`mallory` is the one who was turned away every time).

### (b) What 0.5.2 wrote, opened by this code

Workspace `ws_ptaC3A8zmnSsKB_DA8tfXw` (its Bookshop), shared folder `/__SMURG_FIXTURE__/b052/project`: the 0.5.2 fixture's `stopped` picture of it (its own
members, 17, devices and links, ledger `../0.5.2/ledger.json`) after one start of the code of 0.6.0 and its stop. It holds
the kept copies `agent-sessions.json.before-upgrade-from-0.5.0`, `state.json.before-upgrade-from-0.5.0`; its stamp `{"smurg":"0.6.0","shapes":2}`;
`settings.permissionMode` `auto` and `hostNotices` `["agents-auto"]` (the step from 0.5.0: an existing workspace
switches to auto, and the host is told once); every document in today's shape, as that start left them. It dropped the
records of worktrees whose folders were not there (the copy step makes no shared folder): `worktrees.json` has 0 worktrees where 0.5.2's
has 22, `state.json` 0 worktree roots where 0.5.2's has 22; its 31 invites are the 29 of the 0.5.2 fixture and the
2 that start made (`ledger.json` `b052`, with the lines about auto mode that `smurg host` printed).

Workspace `ws_x0ero8pS70bWM5G4VbZ1NA` (the workspace 0.4.0 wrote), shared folder `/__SMURG_FIXTURE__/b052/old/project`: the 0.5.2 fixture's `stopped` picture of it (its own
members, 9, devices and links, ledger `../0.5.2/ledger.json`) after one start of the code of 0.6.0 and its stop. It holds
the kept copies `state.json.before-upgrade-from-0.4.0`, `state.json.before-upgrade-from-0.5.0`, `suggestions.json.before-upgrade-from-0.4.0`; its stamp `{"smurg":"0.6.0","shapes":2}`;
`settings.permissionMode` `auto` and `hostNotices` `["agents-auto"]` (the step from 0.5.0: an existing workspace
switches to auto, and the host is told once); every document in today's shape, as that start left them. It dropped the
records of worktrees whose folders were not there: none to drop here (0.5.2 had already dropped them); its 18 invites are the 16 of the 0.5.2 fixture and the
2 that start made (`ledger.json` `b052`, with the lines about auto mode that `smurg host` printed).

The kept copies of the step from 0.4.0 that the 0.5.2 fixture carries stay as they were.

### (c) A folder without .git

Workspace `ws_JQyGHiVuRmyk-52kXN9U-A` ("Notes", the folder `/__SMURG_FIXTURE__/nogit`), stamp `{"smurg":"0.6.0","shapes":2}`, members: `dev:host` (host), `dev:kate` (agent).
The topic "Shelf notes" (`shelf-notes`) with one work item `shelf-page`, reviewed; its pin `history: "smurg"`, `commit` a commit of smurg's own history.
`worktrees.json` has `hidden` (smurg's own history: `createdAt`, `configHash`, `headHash`), 1 worktree(s) with `repo: "smurg"` (kept: Kate's checkout), and 1 merge request(s): merged, `repo: "smurg"`, with `base`.
Reports: v1 reviewed 1.

### (d) No git program

Workspace `ws_gK1sGiStR2H2bmRipOrmUw` ("Direct", the folder `/__SMURG_FIXTURE__/direct`), stamp `{"smurg":"0.6.0","shapes":2}`, members: `dev:host` (host).
The topic "Price tags" (`price-tags`) with one work item `tag-print`, done, `direct: true`; its pin `history: "direct"`, `commit` `null`.
`worktrees.json` has no worktree and no merge request (no git program, no history).
Reports: v1 to-review (`noChanges: "no-history"`) 1.

### Topics (the Bookshop)

| name | slug | | discussion | plan | work items |
|---|---|---|---|---|---|
| Checkout | `checkout` | open | live | valid, assigned | reviewed 3 |
| Gift cards | `gift-cards` | open | live | valid, assigned, paused | reviewed 2, done 5, stalled by agent 2, stalled by restart 1, not-started 3, failed 1, stopped 1, stalled by error 2 |
| Late shipping | `late-shipping` | open | live | valid, assigned | not-started 1 |
| Tiny things | `tiny-things` | open | live | valid, assigned | stalled by stopped 1, not-started 1 |
| Bare shelves | `bare-shelves` | open | live | valid, assigned | not-started 1 |
| Exchange | `exchange` | open | live | does not parse | none |
| Vouchers | `vouchers` | open | live | does not parse | none |
| Wishlist | `wishlist` | open | live | valid, everyone | running 2, queued 1, waiting 1 |
| Returns | `returns` | open | lost | does not parse | none |
| Refunds and credit | `refunds` | open | live | none yet | none |
| Old idea | `old-idea` | archived | live | none yet | none |

### Members (the Bookshop)

| user | role and state |
|---|---|
| `dev:host` | host active |
| `dev:mei` | agent active |
| `dev:amy` | editor active |
| `dev:leo` | viewer active |
| `dev:noa` | agent active |
| `dev:bob` | viewer active |
| `dev:kate` | agent active |
| `dev:dave` | agent active |
| `dev:ruth` | agent active |
| `dev:pete` | agent kicked |
| `dev:quinn` | editor active |
| `dev:erin` | editor kicked |
| `dev:olga` | viewer active |
| `dev:gina` | editor active |
| `dev:frank` | editor active |
| `dev:sam` | agent kicked |
| `github:12345` | agent active |

Removed (`status: "kicked"`): `dev:erin`, `dev:pete`, `dev:sam` and frank's first device only (he came back).
Left by himself: `dev:dave` (still an active member in the file). Role changes: gina viewer -> editor, quinn agent -> editor, olga editor -> viewer.

Revoked devices:

| device | user | name | public key |
|---|---|---|---|
| `KkeJOZWbBQxFo7P1rY3PiQ` | `dev:pete` | pete browser | `84de9c27eac32ec0ec4d8b5f513ac3d0d3863cfc89d8c2e3aa964b54ce6fad11` |
| `8lKV1HKO4XSQsJBpQvvnXg` | `dev:erin` | erin browser | `ac6253948747755fa71e0b82e8187075aeae3bb53d4075c1ee9aee9175ebd71c` |
| `KkeLcwZAJdhagRBF3K4ETw` | `dev:frank` | frank browser | `2ea1079fda2b7f5d70179bdf93e80f4c8282fd99da03d2946664de859aad577c` |
| `7vPqdFwDNg3FT3b6nzjgsA` | `dev:sam` | sam browser | `46839f6c2ee8d70261f51d9cc16e503b7b2251bf787a804fe238a891cd9ae543` |

### Invites (the Bookshop)

State at the fixture's instant (`running`). The links (with their secrets, after `s=`) are in `ledger.json`;
`state.json` holds only what is derived from a secret.

| state | id | role | uses | expires | link in `ledger.json` |
|---|---|---|---|---|---|
| expired | `inv_WPU76nyby_9hBPQ5ZHArMw` | editor | 0 of 2 | 2026-10-26 | `invites["expired-editor-6s"].url` |
| revoked | `inv_2sPpZrcPCoqHzgolVUwlmw` | host (host) | 0 of 1 | 2026-11-02 | `firstRun.hostLink` |
| revoked | `inv_-fZjlI7PUrx1aNmk6MWSqA` | host (host) | 0 of 1 | 2026-11-02 | `starts[2].hostLink` |
| revoked | `inv_Mmn10eWOUu985k1KXbMYNw` | host (host) | 0 of 1 | 2026-11-02 | `starts[3].hostLink` |
| revoked | `inv_8KbBKVSReW-HjygRM09U4Q` | viewer | 1 of 2 | 2026-11-02 | `invites["gina-viewer-2uses-then-revoked"].url` |
| revoked | `inv_kJxYnF6YwoNGpAs4HdYJ3A` | editor | 0 of 4 | 2026-11-02 | `invites["revoked-unused-editor"].url` |
| usable, used before | `inv_ONjxcs-AdDumPlDyYZKmBA` | editor | 1, no limit | 2026-11-02 | `firstRun.teammatesLink` |
| usable, used before | `inv_xObP8_PVTY_JgGFr0uVagA` | agent | 2 of 3 | 2026-11-02 | `invites["agents-3uses"].url` |
| usable, used before | `inv_8Y9QYvQpejbRdypJakokrg` | editor | 3 of 5 | 2026-11-02 | `invites["multi-editor-5uses"].url` |
| usable, used before | `inv_19DS4JQxrFFm1gDrcM8MKQ` | agent | 1 of 3 | 2026-10-28 | `lastRun.teammatesLink` |
| usable, used never | `inv_hZcN1ZQayuRbDy-b_vhDFA` | editor | 0, no limit | 2026-11-02 | `starts[1].teammatesLink` |
| usable, used never | `inv_vQiZSEGfFhseVw1PTnrswQ` | editor | 0, no limit | 2026-11-02 | `starts[2].teammatesLink` |
| usable, used never | `inv_lv7QORl5sKKWvLfwJ6UGPQ` | viewer | 0 of 20 | 2026-11-25 | `starts[3].teammatesLink` |
| usable, used never | `inv_cl7g_f2IzuOVY66nGi567Q` | editor | 0 of 3 | 2026-11-02 | `invites["unused-editor-3uses"].url` |
| usable, used never | `inv_JyNtx8WfAi7i1rK7b0GG9A` | viewer | 0, no limit | 2026-11-25 | `invites["unused-viewer-nolimit-30d"].url` |
| usable, used never | `inv_vM4QpXcrp0wQTirqKUCq4Q` | agent | 0 of 1 | 2026-11-02 | `invites["unused-agent-1use"].url` |
| usable, used never | `inv_FrjQkvOm8liHwxNLK2ubvA` | agent | 0 of 1 | 2026-11-02 | `invites["cli-member-agent-1use"].url` |
| usable, used never | `inv_rFghD555KlVUVDQHeqpokQ` | host (host) | 0 of 1 | 2026-11-02 | `lastRun.hostLink` |
| used up | `inv_HJFp8Rju-ie88V01N4kjzw` | host (host) | 1 of 1 | 2026-11-02 | `story.hostLink` |
| used up | `inv_e8pz6es-a0nQbnFE6Oafxw` | agent | 1 of 1 | 2026-11-02 | `storyInvites[0].url` |
| used up | `inv_dvFS7q09532xWEwUwDoF5A` | editor | 1 of 1 | 2026-11-02 | `storyInvites[1].url` |
| used up | `inv_ZWTur8B9Pxa6q3zn_iiPHg` | viewer | 1 of 1 | 2026-11-02 | `storyInvites[2].url` |
| used up | `inv_rjvEI6k4KoYDIHixUpfHug` | agent | 1 of 1 | 2026-11-02 | `storyInvites[3].url` |
| used up | `inv_3Yb1L0_4MSuHdlcJxdJ5wg` | viewer | 1 of 1 | 2026-11-02 | `invites["bob-viewer-1use"].url` |
| used up | `inv_pIYJ39mM1Uc9i_fPMUiDPg` | agent | 1 of 1 | 2026-11-02 | `invites["kate-agent-1use"].url` |
| used up | `inv_7RfOr4pAaS2_B4brKIYOcA` | agent | 1 of 1 | 2026-11-02 | `invites["dave-agent-1use"].url` |
| used up | `inv_4PnXZb83TQsk2d2okLgcYw` | agent | 1 of 1 | 2026-11-02 | `invites["ruth-agent-1use"].url` |
| used up | `inv_tKb7S4Wx3UNeHUqNJC6U4g` | editor | 1 of 1 | 2026-11-02 | `invites["frank-editor-rejoin-1use"].url` |
| used up | `inv_7yCaadnXSlvDJflz1r0wZw` | agent | 1 of 1 | 2026-11-02 | `invites["sam-agent-1use"].url` |

Links `smurg host` printed: `firstRun.teammatesLink` (editor, 7 days, no use limit), `lastRun.teammatesLink`
(agent, 2 days, 3 uses, with the web address `http://localhost:65444`); `starts` has every start's two links, in order,
of all four folders (`starts[0]` the first run, `[1]` the start the tree's story began with, `[2]` its restart, `[3]`
run 4, `[4]` run 5, the last of the Bookshop; `[5]` and `[6]` the two folders of (b), `[7]` (c), `[8]` (d)). Every
start makes a new host link and revokes the unused one before it: `lastRun.hostLink` is the
one that is still good; the host's own device joined with the host link of the start the tree's story began with
(`story.hostLink`).

**For a new person:** every row "usable". **Must stay refused:** every row "used up", "revoked", "expired"; the
revoked devices above, with or without a link; the removed members.

### Interrupted uploads (the Bookshop)

| id | path | where | size | chunks | chunks that arrived | on conflict |
|---|---|---|---|---|---|---|
| `up_FEUdUm67xkOhfv9IYYHZeA` | `assets/in-worktree.bin` | a worktree | 1,048,606 | 2 | 1 | rename |
| `up_1FlXydi12uDGTcMz8YTY9w` | `assets/logo.txt` | main folder | 1,048,907 | 2 | 1 | overwrite |
| `up_z7yy7Zxr72wWS8ALaSirYQ` | `assets/clip.bin` | main folder | 1,022,710 | 1 | none | fail |

Where a chunk arrived it is the last one (a few hundred bytes at offset 1,048,576): such a part is stored as that
piece and rebuilt by the copy step (zeros before it). One upload was begun and no chunk of it arrived.

### Ids of the story (all in `ledger.json`)

- `checkout`: topic `tp_6kOPE8tJlwreGxRsjrMKgA`, its discussion session `ses_5cdea056055dcf8321c198bc95f370ad`
- `gift-cards`: topic `tp_t026TwEwZS9scck3_LsjwA`, its first discussion session `ses_29288a31cf973375b10d1aad7bc1cb0b`
- `late-shipping`: topic `tp_sLdkMlhyFS8ZUWG0Ujbbzg`, its first discussion session `ses_75c267ec21152b545ae9a6bd5e343dcf`
- `tiny-things`: topic `tp_uiGC4QKommgYTrLtH9lVtw`, its first discussion session `ses_9bdd7caa75168cd652ca5b32d8999a20`
- `bare-shelves`: topic `tp_sX6LlL6Pvrvt6C731bLgcQ`, its first discussion session `ses_cd93b93d6e20a9273e4d94e862811b3a`
- `exchange`: topic `tp_craAomRdK_jlSxYKtXggCA`, its first discussion session `ses_c7cc4992f63a2d132170705ef3a99360`
- `vouchers`: topic `tp_aOE_MM51ZU69pqld_VquxA`, its first discussion session `ses_644d79c21f07adca210f2b91a57e9c5c`
- `wishlist`: topic `tp_XbpYaoHl7-vgPF0_NFCSsg`, its first discussion session `ses_474e3318f1b0f0caaa3ad369285a557c`
- `returns`: topic `tp_gxjpvoVVHmYcTgGndkH72A`, its first discussion session `ses_99a761da600e7d33e07e1d175b9e7971`
- `refunds`: topic `tp_Sr8qInTQaYdKrZwitRXi6w`, its first discussion session `ses_a9f2b7e3910ef5fb9a3b53727f8136e2`
- `old-idea`: topic `tp_1KSssaX2vf7OuqptOyr7iQ`, its first discussion session `ses_046dcdc1258090ea4a0dfa7d7f387fbf`
- `nogit`: workspace `ws_JQyGHiVuRmyk-52kXN9U-A`, topic `tp_tG29_LJL3gBUPYCSuPKfMA`; `direct`: workspace `ws_gK1sGiStR2H2bmRipOrmUw`, topic `tp_eShefXnusWwtfEVFR1dXDA`

Sessions by what they are for:

- `T1-host-terminal-ended-by-the-restart`: `ses_b077ea962a930030dacfdb2bf9085052`
- `T2-kate-terminal-exited-by-itself`: `ses_95075b7fe219df7e2154d44780fd14ff`
- `T3-kate-terminal-ended-by-the-host`: `ses_ff0ad7cef165872b1a69faf7ea37f0dc`
- `W1-ruth-terminal-in-a-worktree-ended-by-the-restart`: `ses_226de2ef480f4c0af0087b5206027fc5`
- `W2-kate-terminal-in-a-worktree-kept`: `ses_290e7d42062ab090e699bc451d83f891`
- `W3-ruth-terminal-in-a-worktree-removed`: `ses_24a32576f50c3c43f6edc2d40e722766`
- `A1-host-agent-main`: `ses_d745be114b338bd13e770e518d55dbfb`
- `A2-kate-agent-ended-by-kate`: `ses_d735f2efb3b4c05f3b334eb4aeaf7898`
- `A3-host-agent-crashed`: `ses_c6f5bf39d4db44e13ca40c3dbdf1e2e7`
- `A5-kate-agent-ended-by-the-host`: `ses_7c22f3afe9da5ab8344036c5f5fe1ce0`
- `A11-kate-agent-one-very-long-answer`: `ses_ecf7bd11391031657b69e6430b1e6e1d`
- `A4-ruth-agent-in-a-worktree-ended-kept`: `ses_5b2e549846c27b5c038e94edde4f543d`
- `A6-dave-agent-ended-when-he-left`: `ses_3d770bf28514dec354f89f09bc1ba587`
- `T4-dave-terminal-ended-when-he-left`: `ses_151d2104f3fac4b87aba3ca797c5ae15`
- `A7-pete-agent-ended-when-he-was-removed`: `ses_f7981bf0fd2b1091e2b042647f0aaa7c`
- `A8-quinn-agent-ended-when-her-role-changed`: `ses_1ac76c675313b33505bc1394aace216a`
- `T5-host-terminal-running`: `ses_a9403340c9c9ba6fe068e3c83c934e5f`
- `W5-ruth-terminal-in-a-worktree-running`: `ses_92897e0da3a7828bd06547ee8da0a995`
- `wish-list`: `ses_d4384540a5e0fbe2cc82f7c73333f98d`
- `wish-share`: `ses_190b6a46a26585b58ff105f1bdf2f559`
- `A9-mei-agent-main-waiting-for-a-decision`: `ses_6f69b23f3d8382e681b7c33f37ac74cb`
- `A10-host-agent-failed`: `ses_1807624f0e67cedeaa5937d236c5c136`
- `A12-kate-agent-in-auto-mode`: `ses_c7b750567766123ec26e5e38fda35a87`
- `A14-kate-agent-in-auto-mode-in-a-worktree`: `ses_f7058cb9b291a0e8c2f4e753fca3b028`
- `A13-kate-agent-model-refused`: `ses_163a29f0892af9b155b726e673d24292`
- `A15-host-agent-dies-while-it-asks`: `ses_24b3050e7b309871ae9f6632d7999b80`

Also there: `statusFirstRun`, `settingsBefore`, `storyInvites`, `claudeConfigFirst`, `settingsAfter`, `refused`, `devicesRevoked`, `conflicts`, `worktrees`, `merges`, `suggestions`, `claudeConfig`, `left`, `kicked`, `roleChanged`, `cliMember`, `b052`; `starts` (the links every `smurg host` printed, in order), and `runningAt`, `stoppedAt`.

## Size

4,844,005 bytes in 457 files, this README not counted (546,926 bytes as a compressed archive).
It is large for the reasons the fixtures of 0.5.x are (0.5.0's README, "Size"): an instance of every key and branch
needs a long story, two keys exist only on large texts (`truncated` of a conflict's hunk over 64 KiB, of a block of
agent text over 256 KiB), and the 0.5.2 fixture's two workspaces are in it, opened. The largest files (of
`stopped`): `audit.jsonl` of the Bookshop (`ws_F27C8c23tOki0srDo4u9aQ`): 356,787; `audit.jsonl` of 0.5.2's Bookshop (`ws_ptaC3A8zmnSsKB_DA8tfXw`): 345,267; `events-000001.jsonl` of the Bookshop (`ws_F27C8c23tOki0srDo4u9aQ`): 311,750; `events-000001.jsonl` of 0.5.2's Bookshop (`ws_ptaC3A8zmnSsKB_DA8tfXw`): 311,750.

## Coverage

coverage.json, over both variants: optional keys 210 visited and 8 not, arrays 87 and 6,
records 13 and 0, union branches 114 and 28. Of the 42 that are not visited, 28 cannot be written by the
code of 0.6.0 (`why: "cannot"`, the reason names the code) and 14 can and are not in this fixture (`why: "not-made"`,
the reason says what it would take):

- topics.json: `topics[].items[].startError.text.params{}<1:number>`
- written-by.json (the stamp): `pending`
- agent-sessions.json.before-upgrade-from-0.5.0[-n] (a kept copy: agent-sessions.json as the step from 0.5.0 found it): `sessions[].pending`, `sessions[].pending[].turn.by`, `sessions[].pending[].turn.from`, `sessions[].pending[].turn.origin`, `sessions[].pending[].turn.purpose`, `sessions[].pending[].turn.suggestionId`, `sessions[].pending[].fromUserId<null>`, `sessions[].pending[].fromUserId<value>`
- state.json.before-upgrade-from-0.4.0[-n] (a kept copy: state.json as the step from 0.4.0 found it): `members[].avatarUrl`
- suggestions.json.before-upgrade-from-0.4.0[-n] (a kept copy: suggestions.json as the step from 0.4.0 found it): `suggestions[].source.file.root<kind=worktree>`

The values of enums and booleans are recorded per kind too (`enums`, `booleans`): 24 enums have values no file holds, each with its reason.
Its kinds (35) are the persisted kinds of the tree with the stamp `written-by.json` and one kind of kept
copy per step and document that occurs here.

## Checked

By the code of tag v0.6.0: the driver parsed every file of both variants with the schema of 0.6.0 it is an instance of,
810 files of 35 kinds, none refused (`gaps.txt` empty: every point of a schema is visited or has its
reason). `packages/daemon/test/upgrade/other-version.test.ts` (`TAG = 'v0.6.0'`) starts the tag's own daemon on a
copy of `stopped`: it opens every document with no step and nothing put back, the stamp says 0.6.0 and shapes 2.
By this tree, whose code is still the tag's when the fixture comes in (step S0 of 0.7.0 changes nothing in `src/`), so
that these are the tag's check too (DESIGN 0.7.0 D1): `fixtures.test.ts` (every file of a kind, files.json, and
coverage.json against today's schemas, exactly, since this is the newest fixture), `opens.test.ts`
(`STORIES['0.6.0']`, `UPGRADES['0.6.0']`: the daemon opens both variants with no step and no kept copy, the stamp
read) and `refusals.test.ts`.
