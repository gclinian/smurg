# 0.5.2: what the code of tag v0.5.2 wrote

Read `../README.md` first (what a fixture is, the copy step, files.json, coverage.json).

This one is made to hold **an instance of everything 0.5.2 can persist**: every state document, every other
persisted file, and of their schemas every optional key, a filled array and record, and every branch of every union
that the code of 0.5.2 can write; and what 0.5.1 added to the disk: the stamp `written-by.json` of every
workspace folder, and, in a second workspace of the same host that 0.4.0 wrote and this code then opened, the kept
copies a step leaves (`state.json.before-upgrade-from-0.4.0`, `suggestions.json.before-upgrade-from-0.4.0`). What is
not in it is listed in coverage.json with the reason, each one.

## How it was made

On 2026-10-20, on macOS (arm64), by step S0 of smurg 0.6.0, the way the fixture of 0.5.0 was made (its README, "How it
was made"). Nothing was typed into a state file but one line, said below.

1. `git archive v0.5.2` into a scratch folder; its own tools (`scripts/env.sh`: Node 22.22.1, pnpm 10.34.5) and
   dependencies from the repository's package store (`pnpm install --frozen-lockfile --offline`). Nothing was downloaded.
2. One test file in that scratch tree drives everything (`tests/e2e/test/fixture-driver.test.ts` with its parts
   `fx-*.ts`, run with the tree's own vitest; kept with the scratch work of S0, `W/build/S0/driver/`, not in the
   repository). It uses the tree's own test support and nothing else:
   - the **relay** of that tree in a local workerd (`@smurg/relay/testing` startLocalRelay, dev login on), told about
     a GitHub that is the relay tests' own mock (`apps/relay/test/mock-idp.ts`);
   - the **stand-in for Claude Code** of that tree (`@smurg/daemon/testing` installFakeClaude: the same protocol on
     the pipes, a script instead of a model, no network), first on the PATH as `claude`. No real Claude Code ran,
     nothing was billed, the built-in relay was never named (every command got `--relay`), nobody's own `~/.smurg`
     was touched (`HOME`, `SMURG_HOME` and `SMURG_CACHE_DIR` were scratch folders), `SMURG_NO_UPDATE_CHECK=1`;
   - the **command** from source (`node packages/cli/src/main.ts`), as a process of its own;
   - **people**: clients of the client library (`@smurg/protocol/client`) with their device key and pin in files.
3. The story, in order (the story of the fixture of 0.5.0, step for step, with the same people, links and labels;
   some texts differ):
   - `smurg login --relay <relay> --dev-user host`; `smurg host <project> --name Bookshop --role editor`
     (a git repository with two files); `smurg stop`. This made the workspace, `credentials.json`,
     `workspaces.json` and the host log.
   - **The second workspace.** The tree's own copy step (`packages/daemon/test/upgrade/fixture.ts`
     `copyPublishedFixture`) put the `stopped` picture of the 0.4.0 fixture (what the published 0.4.0 executable wrote)
     into `old/` beside the project; its workspace folder and host log were moved into the host's `SMURG_HOME`, and
     its entry was added to the host's `workspaces.json` with this relay's address: the one line of a stored file
     the driver wrote. `smurg host old/project` then opened it: the tree's daemon upgraded `state.json` and
     `suggestions.json` from 0.4.0, kept both as they were, and stamped the folder; `smurg stop`.
   - The tree's own story (`t.topic-flow.test.ts` of the tag, with its expectations: one topic, "Checkout", from its
     first message to "complete": a question with votes and a comment, spec, a revision an Editor asked for, plan,
     three work items in worktrees, permission cards, a restart of the host's smurg in the middle, reports, reviews,
     merges, a conflict the agent resolves), told against the host's `smurg host` (the 0.5.0 fixture ran it with a
     daemon inside the test on the state the command made; here the daemon is the command's from the start, two
     runs, and the restart is `smurg stop` and `smurg host`). The host is `dev:host`; the step of the tree's file
     that measures frames at the relay is left out (no relay tap), and its long conversation is two blocks.
   - From then on, as for 0.5.0, against `smurg host` (two more runs: `--role viewer --expires 30d --max-uses 20`,
     then `--role agent --expires 2d --max-uses 3 --web-origin http://localhost:<port>`): the host confirms and ignores the
     project's Claude Code settings; a settings change; invites of every state; members who join, are removed, come
     back on a new device, change role, leave; files, uploads (one whole, three interrupted), the editor,
     conflicts; terminals and worktrees with merge requests of every outcome; agent sessions with tools and
     permission cards of every kind, turns that end badly, one answer of more than 256 KiB (stored cut,
     `truncated`), a file an agent wrote that changes on disk under a person's typing with a line of more than
     64 KiB (a conflict whose source is the agent, its text cut, `truncated`), suggestions of every origin and
     outcome; a second topic "Gift cards" with seventeen work items that end differently, follow-ups, a report that
     stops parsing, two changes that conflict; `smurg stop` and `smurg host` in its middle; then more topics (a start
     that fails, a starter who is removed, plans that do not parse, a discussion the host ended, one that was
     started again, an archived topic, a deleted one) and "Wishlist", which is being worked on when the pictures are
     taken: an open question with votes and comments, an open permission card, messages that wait, an item that
     waits for a free agent; 125 writes of small files by an Editor in a minute (120 in audit.jsonl, a summary
     entry, the rest in audit-overflow.jsonl: only a member's own requests have that budget).
   - A member who uses the command: `smurg login` by device code with GitHub (the mock), `smurg attach --invite -`
     with a link whose web address is not the relay's; a second login at another name of the relay, logged out again.
   - Six and a half minutes of waiting (a report is escalated after six times the host's one minute), a review by
     the host in place of the responsible member; the picture `running`; `smurg stop`; the picture `stopped`.

## What was changed afterwards (and nothing else)

`/__SMURG_FIXTURE__` stands for the scratch folder. In the stored files:

| in the files | was | files |
|---|---|---|
| `/__SMURG_FIXTURE__/project` | the shared folder (`workspaces.json`, worktree roots and shared links in `state.json`, the ledger) | 15 |
| `/__SMURG_FIXTURE__/old/project` | the shared folder of the second workspace, the one 0.4.0 wrote (its entry in `workspaces.json`, the worktree roots in the kept copy of its `state.json`) | 2 |
| `/__SMURG_FIXTURE__/host` | the host's `SMURG_HOME` (the log of the second workspace) | 1 |
| `/__SMURG_FIXTURE__/outside` | a folder beside the shared one (a permission card about a path outside it) | 1 |
| `/__SMURG_FIXTURE__/smurg-src` | the scratch tree (the hook and MCP commands in launch files) | 24 |
| `/__SMURG_FIXTURE__/node` | the Node executable (the same commands) | 24 |
| `fixture-host` | the name of the computer (the device name of the member who uses the command; the 0.4.0 files of the second workspace have it from their own fixture) | 4 |

(`files`: in how many stored files of both variants.) The copy step puts the copy's real path where
`/__SMURG_FIXTURE__` is, so `project` and `host` are right again; the others then name folders that do not exist,
which nothing reads at a start (the copy step makes no `old/project`: a test that opens the second workspace makes
that folder first).

Not copied: the shared folders with their worktrees (see `../README.md`), the scratch homes, the stand-in, caches,
the sockets of `running` (`run/*.lk`, `*.ctl`, `*.hook`: a socket is no file).

Numbers of the computer it was made on that are still in it: `targetDev` in the upload manifests, the process ids in
`running`'s `sessions.json` and `run/*.pid`, the relay's port in its address (`http://127.0.0.1:63672`).

Every key here was made for this fixture: the daemon's `identity.key`, the device keys, the invite secrets in
`ledger.json`, and the relay session tokens in the two `credentials.json` (signed by a key that existed only in
that test relay). The "GitHub" account `github:12345` is the mock provider's test user. The second workspace's key,
people and links are those of the 0.4.0 fixture (its README).

## The instants

| variant | `at` (ms) | UTC | what |
|---|---|---|---|
| stopped | 1792486215011 | 2026-10-20T08:50:15Z | after the last `smurg stop` |
| running | 1792486213508 | 2026-10-20T08:50:13Z | 1.5 s earlier, `smurg host` running |

A test sets its clock to `at`. Unused invite links expire from 2026-10-27 on.

## What it holds

Workspace `ws_ptaC3A8zmnSsKB_DA8tfXw` ("Bookshop"), host `dev:host`. `running` unless said otherwise; `stopped` differs where a stop changes things.

- **The stamp** (`written-by.json`): `{"smurg":"0.5.2","shapes":1}`, `at` the last start (2026-10-20T08:43:08Z; the same in `running`: yes).
- **Members, 17:** host active 1, agent active 6, editor active 4, viewer active 3, agent kicked 2, editor kicked 1.
- **Devices, 19:** web in use 14, web revoked 4, cli in use 1.
- **Invites, 29:** revoked 5, usable, used before 4, used up 11, usable, used never 8, expired 1.
- **Settings:** `{"humanLockIdleMs":45000,"agentLockTimeoutMs":60000,"uploadChunkSize":1048576,"sharedDirs":["data"],"diskReserveBytes":5368709120,"diskReservePercent":3,"maxLiveAgents":2,"escalateAfterMs":60000,"agentMcp":true}`.
- **Worktree roots, 22**, 18 of them of a work item, each with the shared link `data`.
- **Worktrees:** running: of a session, kept 3, of a work item, in use 18, of a session, in use 1; stopped: of a session, kept 4, of a work item, in use 18. **Merge requests:** merged 7, rejected 1, pending 1, conflict 2, draft 3.
- **Terminal sessions** (`sessions.json`): running 14 live with their processes; stopped none.
- **Agent sessions, 44** (`agent-sessions.json`, purpose, state and why ended): discussion live 9, item ended / merged 3, free live 4, free ended / ended 3, free ended / terminated 1, free ended / left 1, free ended / kicked 1, free ended / role-changed 1, item live 16, item ended / ended 1, free failed 1, discussion ended / terminated 2, discussion ended / archived 1;
  4 of them with messages that wait for a turn (running; 0 in stopped).
- **Conversations** (`transcripts/`): 44 sessions, 44 segments. **Cards** (per-session `cards.json`): permission withdrawn 4, permission open 2, question withdrawn 3, permission allowed 10, permission denied 4, question answered 3, question open 1 (running); permission withdrawn 4, permission open 2, question withdrawn 3, permission allowed 10, permission denied 4, question answered 3, question open 1 (stopped).
- **Suggestions, 20** (origin, status, why closed): revise accepted 1, composer pending 4, composer withdrawn 1, composer rejected 2, selection accepted 1, composer accepted-modified 2, composer accepted 2, composer withdrawn / author-kicked 1, composer withdrawn / author-demoted 1, composer rejected / session-ended 1, selection rejected / session-ended 1, follow-up pending 2, composer rejected / topic-archived 1 (running).
- **Reports, 10:** v1 partial reviewed 1, v1 complete reviewed 1, v2 complete reviewed 2, v1 complete to-review 2, v1 partial to-review 1, v2 complete to-review 1, v1 complete invalid 1, v1 blocked to-review 1.
- **Inbox:** 10 members with a box; notes: mention 15, result 3; read marks: 1.
- **Claude Code project settings** (`claude-trust.json`): decisions trust 1, ignore 2; loaded entries trusted 1, ignored 1.
  **The host's own rules** (`host-rules.json`): 4 of the main folder, 4 of worktrees, seen: false, notices: subscription.
- **Conflicts, 7:** open 5, applied 1, dismissed 1; 7 kept versions in `conflicts/`.
- **audit.jsonl:** running 986 lines, stopped 1,002; 74 different actions; outcomes: ok 978, denied 20, error 4; actors: system 188, user 611, agent 203.
  **audit-overflow.jsonl:** 4 lines (file.write 4). **audit-text.jsonl:** 93 texts.
- **activity.jsonl:** 317 lines: agent.edit 68, conflict 7, external.change 64, file.create 5, file.delete 2, file.rename 1, file.upload 1, human.edit 152, lock.denied 2, merge 15.
- **The host's other files:** `credentials.json`, `workspaces.json` (two shared folders), `logs/<workspace id>.log` of
  each; in `running` also `run/<12 characters>.pid` and the launch files of the sessions that have a process
  (`sessions/<workspace key>/<hex of the session id>/settings.json`, `mcp.json`, `role.md`).
- **cli-member/** (`github:12345`): `credentials.json`, `workspaces.json` (one joined workspace, with `web`),
  `device.key`, `pins/`; this member logged in with GitHub (the mock) and has an `avatarUrl` in `state.json`.
  **devices/**: device.key and pins/ of 21 devices of the people who joined with the client library
  (`mallory` is the one who was turned away every time).

### The second workspace: what 0.4.0 wrote, opened by this code

Workspace `ws_x0ero8pS70bWM5G4VbZ1NA`, shared folder `/__SMURG_FIXTURE__/old/project`: the 0.4.0 fixture's `stopped` picture (its own
members, 9, devices and links, ledger `../0.4.0/ledger.json`) after one start of the code of 0.5.2 and its stop.
It holds the kept copies `state.json.before-upgrade-from-0.4.0` and `suggestions.json.before-upgrade-from-0.4.0` (byte for byte the 0.4.0
files, as the copy step wrote them, with `/__SMURG_FIXTURE__/old` where 0.4.0's fixture has its placeholder), its stamp
`{"smurg":"0.5.2","shapes":1}` and every document in today's shape, as that start left them. It dropped the records
of worktrees whose folders were not there (the copy step makes no shared folder): `state.json` has 0 worktree roots where
its kept copy has 2; its 16 invites are the 14 of the 0.4.0 fixture and the 2 that start made. `ledger.json`
`oldWorkspace` has the links that start printed.

### Topics

| name | slug | | discussion | plan | work items |
|---|---|---|---|---|---|
| Checkout | `checkout` | open | live | valid, assigned | reviewed 3 |
| Gift cards | `gift-cards` | open | live | valid, assigned, paused | reviewed 1, done 6, stalled by agent 2, stalled by restart 1, not-started 3, failed 1, stopped 1, stalled by error 2 |
| Late shipping | `late-shipping` | open | live | valid, assigned | not-started 1 |
| Tiny things | `tiny-things` | open | live | valid, assigned | stalled by stopped 1, not-started 1 |
| Bare shelves | `bare-shelves` | open | live | valid, assigned | not-started 1 |
| Exchange | `exchange` | open | live | does not parse | none |
| Vouchers | `vouchers` | open | live | does not parse | none |
| Wishlist | `wishlist` | open | live | valid, everyone | running 2, queued 1, waiting 1 |
| Returns | `returns` | open | lost | does not parse | none |
| Refunds and credit | `refunds` | open | live | none yet | none |
| Old idea | `old-idea` | archived | live | none yet | none |

### Members

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

Removed (`status: "kicked"`): `dev:pete`, `dev:erin`, `dev:sam` and frank's first device only (he came back).
Left by himself: `dev:dave` (still an active member in the file). Role changes: gina viewer -> editor, quinn agent -> editor, olga editor -> viewer.

Revoked devices:

| device | user | name | public key |
|---|---|---|---|
| `JD0sZv1TRgyX1Exs4KfXag` | `dev:pete` | pete browser | `efd12563ed8078e24945c370891621551ffea6629141febcf1f906284e2f794d` |
| `IhUPWSpAV3yA6e5ZM_mU0w` | `dev:erin` | erin browser | `49701f4d9f7c0c1b2d89529426cd6e3728a02401f9adf72097a91b2ba36de565` |
| `Ri-ifalIvpIjiqnGIdO81w` | `dev:frank` | frank browser | `ae2994b0947c8f3f3d43ef7ddc1e82070c8e9b3e5653d33fa7c3b2c8ff6e033b` |
| `QV5H_N_jFkmLrQ_16DZ8OA` | `dev:sam` | sam browser | `4f2a8b27f85038ab1a5bb094db5c839b127a45764217e8563b8e91a590d88f13` |

### Invites

State at the fixture's instant (`running`). The links (with their secrets, after `s=`) are in `ledger.json`;
`state.json` holds only what is derived from a secret.

| state | id | role | uses | expires | link in `ledger.json` |
|---|---|---|---|---|---|
| expired | `inv_OMUMvq-dMcK81pK-oPSPUw` | editor | 0 of 2 | 2026-10-20 | `invites["expired-editor-6s"].url` |
| revoked | `inv_vzAzUg1HrCy5IKN-UIV7mA` | host (host) | 0 of 1 | 2026-10-27 | `firstRun.hostLink` |
| revoked | `inv_-oU4By4HA-5YqP9SCXMRRw` | host (host) | 0 of 1 | 2026-10-27 | `starts[1].hostLink` |
| revoked | `inv_XG1dTnQBkitzNfNxvvoUsg` | host (host) | 0 of 1 | 2026-10-27 | `starts[2].hostLink` |
| revoked | `inv_a0UicBreZt_BMW9Exr0Q7A` | viewer | 1 of 2 | 2026-10-27 | `invites["gina-viewer-2uses-then-revoked"].url` |
| revoked | `inv_dFpOqfW_379uIlntGJkMLw` | editor | 0 of 4 | 2026-10-27 | `invites["revoked-unused-editor"].url` |
| usable, used before | `inv_7CR7fsqo9EcWZV8fOg9ErQ` | editor | 1, no limit | 2026-10-27 | `firstRun.teammatesLink` |
| usable, used before | `inv_lxVQtuJmnMnWTZPuogbVlw` | agent | 2 of 3 | 2026-10-27 | `invites["agents-3uses"].url` |
| usable, used before | `inv_2qqOBpkJASN3vP6G-TjxaQ` | editor | 3 of 5 | 2026-10-27 | `invites["multi-editor-5uses"].url` |
| usable, used before | `inv_zEcHbnQmMQc21Azo0c86MA` | agent | 1 of 3 | 2026-10-22 | `lastRun.teammatesLink` |
| usable, used never | `inv_xcD4kzjtbrEGUR_mIFLr_Q` | editor | 0, no limit | 2026-10-27 | `starts[0].teammatesLink` |
| usable, used never | `inv_iZCMBLvGYIuGTLlnecSnPQ` | editor | 0, no limit | 2026-10-27 | `starts[1].teammatesLink` |
| usable, used never | `inv_jzirbCoHe5bEvaL4UoLr6w` | viewer | 0 of 20 | 2026-11-19 | `starts[2].teammatesLink` |
| usable, used never | `inv_16p41bFRELTERLhF7A84dw` | editor | 0 of 3 | 2026-10-27 | `invites["unused-editor-3uses"].url` |
| usable, used never | `inv_cY0_JEhaz4IIUBmm6N0efw` | viewer | 0, no limit | 2026-11-19 | `invites["unused-viewer-nolimit-30d"].url` |
| usable, used never | `inv_03OnMmjJyYtGKYre3f2t2g` | agent | 0 of 1 | 2026-10-27 | `invites["unused-agent-1use"].url` |
| usable, used never | `inv_MLFGvmHJ74iYqEuJYC3B3A` | agent | 0 of 1 | 2026-10-27 | `invites["cli-member-agent-1use"].url` |
| usable, used never | `inv_3e7l3f7iK-0NPFXefzSMyw` | host (host) | 0 of 1 | 2026-10-27 | `lastRun.hostLink` |
| used up | `inv_TyN4V4J0VKYD5sfTIUqShw` | host (host) | 1 of 1 | 2026-10-27 | `story.hostLink` |
| used up | `inv_X7_n4KDeQkTwdMtIKy_-eg` | agent | 1 of 1 | 2026-10-27 | `storyInvites[0].url` |
| used up | `inv_fNnOLwlAzv-N9Vd6IN-Flg` | editor | 1 of 1 | 2026-10-27 | `storyInvites[1].url` |
| used up | `inv_TPatoP127WACXlTX5N3kxA` | viewer | 1 of 1 | 2026-10-27 | `storyInvites[2].url` |
| used up | `inv_5M1EB-VfbkvBmy3ZkU0fag` | agent | 1 of 1 | 2026-10-27 | `storyInvites[3].url` |
| used up | `inv_GzBNwdPVi3uVom1Od628Bw` | viewer | 1 of 1 | 2026-10-27 | `invites["bob-viewer-1use"].url` |
| used up | `inv_uXzHWILTJL1hqbuqmEmvDw` | agent | 1 of 1 | 2026-10-27 | `invites["kate-agent-1use"].url` |
| used up | `inv_15ytZ3UIFjXiF4wqdcqtvA` | agent | 1 of 1 | 2026-10-27 | `invites["dave-agent-1use"].url` |
| used up | `inv_y4W8QAjtPbbg23W9tTcT1g` | agent | 1 of 1 | 2026-10-27 | `invites["ruth-agent-1use"].url` |
| used up | `inv_szMaTCFHwo4m6ELPKZKsUQ` | editor | 1 of 1 | 2026-10-27 | `invites["frank-editor-rejoin-1use"].url` |
| used up | `inv_9TjXHo_wZ7QHDybfwVwMpw` | agent | 1 of 1 | 2026-10-27 | `invites["sam-agent-1use"].url` |

Links `smurg host` printed: `firstRun.teammatesLink` (editor, 7 days, no use limit), `lastRun.teammatesLink`
(agent, 2 days, 3 uses, with the web address `http://localhost:63672`). Every start makes a new host
link and revokes the unused one before it: `lastRun.hostLink` is the one that is still good; the host's own
device joined with the host link of the start the tree's story began with (`story.hostLink`).

**For a new person:** every row "usable". **Must stay refused:** every row "used up", "revoked", "expired"; the
revoked devices above, with or without a link; the removed members.

### Interrupted uploads

| id | path | where | size | chunks | chunks that arrived | on conflict |
|---|---|---|---|---|---|---|
| `up_yMJOjw_uQenC4zulcDM4TA` | `assets/logo.txt` | main folder | 1,048,907 | 2 | 1 | overwrite |
| `up_Db2Ng6i7fvcsRNt10p_0JQ` | `assets/clip.bin` | main folder | 1,022,710 | 1 | none | fail |
| `up_c4u2kjdV0Q2eDNGYBnVtAQ` | `assets/in-worktree.bin` | a worktree | 1,048,606 | 2 | 1 | rename |

Where a chunk arrived it is the last one (a few hundred bytes at offset 1,048,576): such a part is stored as that
piece and rebuilt by the copy step (zeros before it). One upload was begun and no chunk of it arrived.

### Ids of the story (all in `ledger.json`)

- `gift-cards`: topic `tp_Zpo4DJrg28mpUId0fLSExQ`, its first discussion session `ses_ad2246260b7afa868f6b6f2fa3ab086b`
- `late-shipping`: topic `tp_tVBd_On5-FCRnWIs-eoreQ`, its first discussion session `ses_8ef79d6da6f027e40e0e55fe31c68dfd`
- `tiny-things`: topic `tp_nSB_40qiv3tr_Ndm0bRKkQ`, its first discussion session `ses_6d638ca6a3250bb915779dd6db37356d`
- `bare-shelves`: topic `tp_fApl6HSTz67S7Atd5v3i1g`, its first discussion session `ses_2c31cacd579e33fd7df83359e2a4d307`
- `exchange`: topic `tp_WHYzUQyN40VCgi8hbaXzhA`, its first discussion session `ses_e6c380879f27e1fc003b620630d1e2ff`
- `vouchers`: topic `tp_3CqYxNwwE2biSC59WEnmsA`, its first discussion session `ses_bfdccdce229694d8bda76801ce5428a9`
- `wishlist`: topic `tp_m_xWwJkrmusdUtBW4VtoLQ`, its first discussion session `ses_966f9e7c508712ee4babe288378b02bd`
- `returns`: topic `tp_dxvSav3GpKeClTDC624sCA`, its first discussion session `ses_bee31127cb3e61d0b5c2e8698ea4ef49`
- `refunds`: topic `tp__Os7WK_wi0RiwpXBrqBbCg`
- `old-idea`: topic `tp_vzd4mnM12L39TSzClIH_ow`, its first discussion session `ses_dd6ef8e9389f692033f6c525b3a8839d`

Sessions by what they are for:

- `T1-host-terminal-ended-by-the-restart`: `ses_7043bffd247bae48d6bcc7fcb99870da`
- `T2-kate-terminal-exited-by-itself`: `ses_bbd1df10aa8848e793645cfc80ffb264`
- `T3-kate-terminal-ended-by-the-host`: `ses_79020e7b594647cd06542d34eda34fd6`
- `W1-ruth-terminal-in-a-worktree-ended-by-the-restart`: `ses_a1cf724ab690ad209ece0f562dd93071`
- `W2-kate-terminal-in-a-worktree-kept`: `ses_efa6a28bb3ae7fcbc92661ef5095a5a4`
- `W3-ruth-terminal-in-a-worktree-removed`: `ses_a16656ea0fd6303f3c77558366940d3c`
- `A1-host-agent-main`: `ses_1676a939dd0b4f946e895717304c8852`
- `A2-kate-agent-ended-by-kate`: `ses_11f03c518faa2c8ff602e72704eefba2`
- `A3-host-agent-crashed`: `ses_8285d3dc7fb7a6f794564511cf66545a`
- `A5-kate-agent-ended-by-the-host`: `ses_517c56d84b57d7240ceb6d1ceb8d6e45`
- `A11-kate-agent-one-very-long-answer`: `ses_c023981eb80399600b92989ffeea3f07`
- `A4-ruth-agent-in-a-worktree-ended-kept`: `ses_d4e920d2e146d9cd2e1eff9b530d5de0`
- `A6-dave-agent-ended-when-he-left`: `ses_52bdd593e3493d5da44afd1196aa4704`
- `T4-dave-terminal-ended-when-he-left`: `ses_9141446d658f35dbfe0bcbd814ffb532`
- `A7-pete-agent-ended-when-he-was-removed`: `ses_350b7934b956b907b0cecc6aa21be71b`
- `A8-quinn-agent-ended-when-her-role-changed`: `ses_e60ef8acc602cd222be471505552cbc2`
- `T5-host-terminal-running`: `ses_90a5799d07935c02dc9a84dad649f90e`
- `W5-ruth-terminal-in-a-worktree-running`: `ses_38a9c310aa9fa5a9f6d2f55cc245140d`
- `wish-list`: `ses_09ee8ba7d7c3b1a6952d6fcc2265eab0`
- `wish-share`: `ses_cda9e1ff87a7fcfb0f91e924665770a7`
- `A9-mei-agent-main-waiting-for-a-decision`: `ses_fdc2fed71d268993b8b3d68ee041de75`
- `A10-host-agent-failed`: `ses_04a99ffb84138c4726c9efd4d417895f`

Also there: `starts` (the links every `smurg host` printed, in order), `storyInvites` (the links of the people of
the tree's story), `checkout` (its topic and sessions), `suggestions` (by what became of each), `conflicts`,
`worktrees`, `merges`, `uploads`, `settingsBefore`, `settingsAfter`, `settingsLive`, `refused` (what the turned-away
connections ended as), `claudeConfigFirst`, `claudeConfig`, `oldWorkspace`.

## Size

2,523,473 bytes in 253 files, this README not counted (310,637 bytes as a compressed archive).
It is large for the reasons the fixture of 0.5.0 is (its README, "Size"): an instance of every key and branch needs a
long story, and two keys exist only on large texts (`truncated` of a conflict's hunk over 64 KiB, of a block of agent
text over 256 KiB). The largest files (of `stopped`): `audit.jsonl` 344,807, `events-000001.jsonl` 311,750, `events-000001.jsonl` 263,698, `activity.jsonl` 114,372. Kept small on purpose: the long conversation of the
tree's story is two blocks, the interrupted uploads hold one small chunk each, a log that only grew between the two
pictures is stored once.

## Coverage

coverage.json, over both variants: optional keys 177 visited and 2 not, arrays 78 and 5,
records 13 and 0, union branches 93 and 31. Of the 38 that are not visited, 33 cannot be written by the
code of 0.5.2 (`why: "cannot"`, the reason names the code) and 5 can and are not in this fixture (`why: "not-made"`,
the reason says what it would take). Its kinds are the persisted kinds of the tree with the two that 0.5.1 added to
the disk and the harness of 0.6.0 names (`written-by.json (the stamp)`, and one kind of kept copy per step).

## Checked

By the code of tag v0.5.2, through the copy step: its daemon (every module of the release, an in-memory relay, the
clock at `at`) starts on a copy of `stopped` and of `running` and opens all 12 state documents of the shared
workspace (agent-sessions, cards, claude-trust, conflicts, host-rules, inbox, reports, sessions, state, suggestions, topics, worktrees) with no step and nothing put back, the stamp read
(0.5.2, shapes 1); on `stopped` it opens the second workspace too (12 documents, no step: the
upgrade was done when the fixture was made; the stamp says 0.5.2). Every file of both variants is accepted by the
schema of 0.5.2 it is an instance of: 409 files of 33 kinds, none refused.
