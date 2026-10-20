# 0.5.1: what the code of tag v0.5.1 wrote

Read `../README.md` first (what a fixture is, the copy step, files.json, coverage.json).

This one is made to hold **an instance of everything 0.5.1 can persist**: every state document, every other
persisted file, and of their schemas every optional key, a filled array and record, and every branch of every union
that the code of 0.5.1 can write; and what 0.5.1 added to the disk: the stamp `written-by.json` of every
workspace folder, and, in a second workspace of the same host that 0.4.0 wrote and this code then opened, the kept
copies a step leaves (`state.json.before-upgrade-from-0.4.0`, `suggestions.json.before-upgrade-from-0.4.0`). What is
not in it is listed in coverage.json with the reason, each one.

## How it was made

On 2026-10-20, on macOS (arm64), by step S0 of smurg 0.6.0, the way the fixture of 0.5.0 was made (its README, "How it
was made"). Nothing was typed into a state file but one line, said below.

1. `git archive v0.5.1` into a scratch folder; its own tools (`scripts/env.sh`: Node 22.22.1, pnpm 10.34.5) and
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
`running`'s `sessions.json` and `run/*.pid`, the relay's port in its address (`http://127.0.0.1:59739`).

Every key here was made for this fixture: the daemon's `identity.key`, the device keys, the invite secrets in
`ledger.json`, and the relay session tokens in the two `credentials.json` (signed by a key that existed only in
that test relay). The "GitHub" account `github:12345` is the mock provider's test user. The second workspace's key,
people and links are those of the 0.4.0 fixture (its README).

## The instants

| variant | `at` (ms) | UTC | what |
|---|---|---|---|
| stopped | 1792485720916 | 2026-10-20T08:42:00Z | after the last `smurg stop` |
| running | 1792485718954 | 2026-10-20T08:41:58Z | 2 s earlier, `smurg host` running |

A test sets its clock to `at`. Unused invite links expire from 2026-10-27 on.

## What it holds

Workspace `ws_EbX4eKYK9jC34cCafBez2A` ("Bookshop"), host `dev:host`. `running` unless said otherwise; `stopped` differs where a stop changes things.

- **The stamp** (`written-by.json`): `{"smurg":"0.5.1","shapes":1}`, `at` the last start (2026-10-20T08:34:44Z; the same in `running`: yes).
- **Members, 17:** host active 1, agent active 6, editor active 4, viewer active 3, agent kicked 2, editor kicked 1.
- **Devices, 19:** web in use 14, web revoked 4, cli in use 1.
- **Invites, 29:** revoked 5, usable, used before 4, used up 11, usable, used never 8, expired 1.
- **Settings:** `{"humanLockIdleMs":45000,"agentLockTimeoutMs":60000,"uploadChunkSize":1048576,"sharedDirs":["data"],"diskReserveBytes":5368709120,"diskReservePercent":3,"maxLiveAgents":2,"escalateAfterMs":60000,"agentMcp":true}`.
- **Worktree roots, 22**, 18 of them of a work item, each with the shared link `data`.
- **Worktrees:** running: of a session, kept 3, of a work item, in use 18, of a session, in use 1; stopped: of a session, kept 4, of a work item, in use 18. **Merge requests:** merged 7, rejected 1, pending 1, conflict 2, draft 3.
- **Terminal sessions** (`sessions.json`): running 14 live with their processes; stopped none.
- **Agent sessions, 44** (`agent-sessions.json`, purpose, state and why ended): discussion live 9, item ended / merged 3, free live 4, free ended / ended 3, free ended / terminated 1, free ended / left 1, free ended / kicked 1, free ended / role-changed 1, item live 16, item ended / ended 1, free failed 1, discussion ended / terminated 2, discussion ended / archived 1;
  4 of them with messages that wait for a turn (running; 0 in stopped).
- **Conversations** (`transcripts/`): 44 sessions, 44 segments. **Cards** (per-session `cards.json`): question open 1, permission open 2, question answered 3, permission allowed 10, question withdrawn 3, permission denied 4, permission withdrawn 4 (running); question open 1, permission open 2, question answered 3, permission allowed 10, question withdrawn 3, permission denied 4, permission withdrawn 4 (stopped).
- **Suggestions, 20** (origin, status, why closed): revise accepted 1, composer pending 4, composer withdrawn 1, composer rejected 2, selection accepted 1, composer accepted-modified 2, composer accepted 2, composer withdrawn / author-kicked 1, composer withdrawn / author-demoted 1, composer rejected / session-ended 1, selection rejected / session-ended 1, follow-up pending 2, composer rejected / topic-archived 1 (running).
- **Reports, 10:** v1 partial reviewed 1, v1 complete reviewed 1, v2 complete reviewed 2, v1 complete to-review 2, v1 partial to-review 1, v2 complete to-review 1, v1 complete invalid 1, v1 blocked to-review 1.
- **Inbox:** 10 members with a box; notes: mention 15, result 3; read marks: 1.
- **Claude Code project settings** (`claude-trust.json`): decisions trust 1, ignore 2; loaded entries trusted 1, ignored 1.
  **The host's own rules** (`host-rules.json`): 4 of the main folder, 4 of worktrees, seen: false, notices: subscription.
- **Conflicts, 7:** open 5, applied 1, dismissed 1; 7 kept versions in `conflicts/`.
- **audit.jsonl:** running 986 lines, stopped 1,002; 74 different actions; outcomes: ok 978, denied 20, error 4; actors: system 187, user 610, agent 205.
  **audit-overflow.jsonl:** 4 lines (file.write 4). **audit-text.jsonl:** 93 texts.
- **activity.jsonl:** 317 lines: agent.edit 70, conflict 7, external.change 62, file.create 5, file.delete 2, file.rename 1, file.upload 1, human.edit 152, lock.denied 2, merge 15.
- **The host's other files:** `credentials.json`, `workspaces.json` (two shared folders), `logs/<workspace id>.log` of
  each; in `running` also `run/<12 characters>.pid` and the launch files of the sessions that have a process
  (`sessions/<workspace key>/<hex of the session id>/settings.json`, `mcp.json`, `role.md`).
- **cli-member/** (`github:12345`): `credentials.json`, `workspaces.json` (one joined workspace, with `web`),
  `device.key`, `pins/`; this member logged in with GitHub (the mock) and has an `avatarUrl` in `state.json`.
  **devices/**: device.key and pins/ of 21 devices of the people who joined with the client library
  (`mallory` is the one who was turned away every time).

### The second workspace: what 0.4.0 wrote, opened by this code

Workspace `ws_x0ero8pS70bWM5G4VbZ1NA`, shared folder `/__SMURG_FIXTURE__/old/project`: the 0.4.0 fixture's `stopped` picture (its own
members, 9, devices and links, ledger `../0.4.0/ledger.json`) after one start of the code of 0.5.1 and its stop.
It holds the kept copies `state.json.before-upgrade-from-0.4.0` and `suggestions.json.before-upgrade-from-0.4.0` (byte for byte the 0.4.0
files, as the copy step wrote them, with `/__SMURG_FIXTURE__/old` where 0.4.0's fixture has its placeholder), its stamp
`{"smurg":"0.5.1","shapes":1}` and every document in today's shape, as that start left them. It dropped the records
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
| `BzIFD8XFXWxeFl41bUiB2w` | `dev:pete` | pete browser | `753894e36ce9c976378b92752aad0c3fe10de8d741e80fd79862001ed222e174` |
| `3lgD55vcNRsO7WiQ1WDQDw` | `dev:erin` | erin browser | `a96532140bef493748b8189e225445dad18d90a9fcd3c8e2dff89da8d5f1483a` |
| `zfb6q-_yG6NuyHnCgRcelA` | `dev:frank` | frank browser | `6696d884fa758c888db0c69fdd43158f4c59ac2a728e299ac06684ba49f13740` |
| `W-eK8KSOslno-PH46yo2DA` | `dev:sam` | sam browser | `a3159c8fde6b839c608613f4c11c4630e9ac4cabf43ac488d330d5dd093e3159` |

### Invites

State at the fixture's instant (`running`). The links (with their secrets, after `s=`) are in `ledger.json`;
`state.json` holds only what is derived from a secret.

| state | id | role | uses | expires | link in `ledger.json` |
|---|---|---|---|---|---|
| expired | `inv_3VkoUgBoiscFvok11x1WKg` | editor | 0 of 2 | 2026-10-20 | `invites["expired-editor-6s"].url` |
| revoked | `inv_CyD51trQnaZqHoN-6E9uBQ` | host (host) | 0 of 1 | 2026-10-27 | `firstRun.hostLink` |
| revoked | `inv__1zWXdAlj4KkVFFRWQv5vQ` | host (host) | 0 of 1 | 2026-10-27 | `starts[1].hostLink` |
| revoked | `inv_bS3dK5TQ1NHKdFR0drxOsQ` | host (host) | 0 of 1 | 2026-10-27 | `starts[2].hostLink` |
| revoked | `inv_1BzliwbcRo8eJPd4570FdA` | viewer | 1 of 2 | 2026-10-27 | `invites["gina-viewer-2uses-then-revoked"].url` |
| revoked | `inv_MUsT3avj_9dZLJXEOE-QGw` | editor | 0 of 4 | 2026-10-27 | `invites["revoked-unused-editor"].url` |
| usable, used before | `inv_Dw6nmr-D9NzqEXpAXvq8GQ` | editor | 1, no limit | 2026-10-27 | `firstRun.teammatesLink` |
| usable, used before | `inv_zRO-aHGWoFIbC5_Z6bb_Qw` | agent | 2 of 3 | 2026-10-27 | `invites["agents-3uses"].url` |
| usable, used before | `inv_9M3rCq4KnprD9OMX7J5iOA` | editor | 3 of 5 | 2026-10-27 | `invites["multi-editor-5uses"].url` |
| usable, used before | `inv_ZGdsuTXYr_0HEgH6qZyEkw` | agent | 1 of 3 | 2026-10-22 | `lastRun.teammatesLink` |
| usable, used never | `inv_kEfEZ0d349Ez4UUEaLRS3A` | editor | 0, no limit | 2026-10-27 | `starts[0].teammatesLink` |
| usable, used never | `inv_O_JK-oGQWZ7l8WcjL4R1ng` | editor | 0, no limit | 2026-10-27 | `starts[1].teammatesLink` |
| usable, used never | `inv_fXJlQjDwhbZu2zDtpOGwNA` | viewer | 0 of 20 | 2026-11-19 | `starts[2].teammatesLink` |
| usable, used never | `inv_VV9W8qpEyDAZlyRpX-WzTQ` | editor | 0 of 3 | 2026-10-27 | `invites["unused-editor-3uses"].url` |
| usable, used never | `inv_m7QV8WskMYuzc158fEL6IA` | viewer | 0, no limit | 2026-11-19 | `invites["unused-viewer-nolimit-30d"].url` |
| usable, used never | `inv_Rynhb_61e_Hmjr0AIwhdmw` | agent | 0 of 1 | 2026-10-27 | `invites["unused-agent-1use"].url` |
| usable, used never | `inv_t46FvTzXMbXGICOmKdhmvQ` | agent | 0 of 1 | 2026-10-27 | `invites["cli-member-agent-1use"].url` |
| usable, used never | `inv_TCvg3fvThj7gD5GifgO9jA` | host (host) | 0 of 1 | 2026-10-27 | `lastRun.hostLink` |
| used up | `inv_RmCVt0oBZDil56dc5b38nQ` | host (host) | 1 of 1 | 2026-10-27 | `story.hostLink` |
| used up | `inv_22RqQsUFam1BgDT4WkG7lQ` | agent | 1 of 1 | 2026-10-27 | `storyInvites[0].url` |
| used up | `inv_KDr893yG4EZbUbpBoMcooA` | editor | 1 of 1 | 2026-10-27 | `storyInvites[1].url` |
| used up | `inv_Dp0a7w-E5ST-TKiWF96P6A` | viewer | 1 of 1 | 2026-10-27 | `storyInvites[2].url` |
| used up | `inv_279xFlkXsQ1TPq7522AXMQ` | agent | 1 of 1 | 2026-10-27 | `storyInvites[3].url` |
| used up | `inv_9pC0Vtn0F3BDxGLKWGomww` | viewer | 1 of 1 | 2026-10-27 | `invites["bob-viewer-1use"].url` |
| used up | `inv_U4PUejdemm9b71oQbYiWhg` | agent | 1 of 1 | 2026-10-27 | `invites["kate-agent-1use"].url` |
| used up | `inv_qBKWecLH8WMdR3UbsVT5lA` | agent | 1 of 1 | 2026-10-27 | `invites["dave-agent-1use"].url` |
| used up | `inv_tmqOdlSm5B45U-9k6JQPIw` | agent | 1 of 1 | 2026-10-27 | `invites["ruth-agent-1use"].url` |
| used up | `inv_BUnzBm06mLQuNFGcnUWOTg` | editor | 1 of 1 | 2026-10-27 | `invites["frank-editor-rejoin-1use"].url` |
| used up | `inv_TgqxqQYOkdfJL9y5kn8epQ` | agent | 1 of 1 | 2026-10-27 | `invites["sam-agent-1use"].url` |

Links `smurg host` printed: `firstRun.teammatesLink` (editor, 7 days, no use limit), `lastRun.teammatesLink`
(agent, 2 days, 3 uses, with the web address `http://localhost:59739`). Every start makes a new host
link and revokes the unused one before it: `lastRun.hostLink` is the one that is still good; the host's own
device joined with the host link of the start the tree's story began with (`story.hostLink`).

**For a new person:** every row "usable". **Must stay refused:** every row "used up", "revoked", "expired"; the
revoked devices above, with or without a link; the removed members.

### Interrupted uploads

| id | path | where | size | chunks | chunks that arrived | on conflict |
|---|---|---|---|---|---|---|
| `up_vETKab3e0k5eQvQZGcBVTA` | `assets/logo.txt` | main folder | 1,048,907 | 2 | 1 | overwrite |
| `up_K7aXkR8wucZhmhmEHth2wA` | `assets/clip.bin` | main folder | 1,022,710 | 1 | none | fail |
| `up_6WazegHGmyVff63WgxigOg` | `assets/in-worktree.bin` | a worktree | 1,048,606 | 2 | 1 | rename |

Where a chunk arrived it is the last one (a few hundred bytes at offset 1,048,576): such a part is stored as that
piece and rebuilt by the copy step (zeros before it). One upload was begun and no chunk of it arrived.

### Ids of the story (all in `ledger.json`)

- `gift-cards`: topic `tp_l-4tu88y7yaXmxfb9EfXEQ`, its first discussion session `ses_152f1cc289968c3320088d7eac920fb3`
- `late-shipping`: topic `tp_QI8W4GScqfsGCXkFmyM_bg`, its first discussion session `ses_e3156cc09342aaad0fba98c5704edc0f`
- `tiny-things`: topic `tp_eLNRk_HnfeCr9v2tzrfYOQ`, its first discussion session `ses_0ad3e631ed2181fa0a31652ac34d02fe`
- `bare-shelves`: topic `tp_Efhb95V5fVWkVOBxBRPXrQ`, its first discussion session `ses_4da3e39b715f80e91d91658662f4c18a`
- `exchange`: topic `tp_nJTmmFKcCGftKwEXktWXug`, its first discussion session `ses_26d02c9784d2df026bf5677394b05758`
- `vouchers`: topic `tp_r8nRvLlmZDMIHNId1XyydQ`, its first discussion session `ses_de4294d8d3a18deb0ceaec463aa6ca99`
- `wishlist`: topic `tp_46KO-jaU2JoCe4xHY9kOOQ`, its first discussion session `ses_02a4bc42dca3f2cb9a2e9ccc42f12563`
- `returns`: topic `tp_S6-6NFQYya6MkEqo7miIgQ`, its first discussion session `ses_adf4d939ed3e10ca803e47263ddfa957`
- `refunds`: topic `tp_cVYhHSPQCaCbEwSSHxo7sQ`
- `old-idea`: topic `tp_a5UAsl-shXOoEr1htZIS8Q`, its first discussion session `ses_e398a0e1c3caea2a6707710a2ae3f7ca`

Sessions by what they are for:

- `T1-host-terminal-ended-by-the-restart`: `ses_68b82ca59a7c07bae505a7ca43bb87aa`
- `T2-kate-terminal-exited-by-itself`: `ses_2ea3c6f9cd55e364a39646444fd72266`
- `T3-kate-terminal-ended-by-the-host`: `ses_25df68cfe1455be3c324d35b7a22caa9`
- `W1-ruth-terminal-in-a-worktree-ended-by-the-restart`: `ses_1feb861eac0b3f07952b9331e657434a`
- `W2-kate-terminal-in-a-worktree-kept`: `ses_4154d5aa00e6aa89be2671ca85c8dee7`
- `W3-ruth-terminal-in-a-worktree-removed`: `ses_3127ed8f510038bd8dcea34e0984c020`
- `A1-host-agent-main`: `ses_1d6e5bd1a62105fc5aef217687391183`
- `A2-kate-agent-ended-by-kate`: `ses_91ef65b5fa074e26f77fe74ff969a947`
- `A3-host-agent-crashed`: `ses_5a72574bda17169abe87163c61e96e1d`
- `A5-kate-agent-ended-by-the-host`: `ses_8573bb0bf2bb283d920172c4e2bb8157`
- `A11-kate-agent-one-very-long-answer`: `ses_62cb44a2d7ecfc9d2f151d1f26cc5441`
- `A4-ruth-agent-in-a-worktree-ended-kept`: `ses_13c469e74b812313d842d92adc2fd8b8`
- `A6-dave-agent-ended-when-he-left`: `ses_de05e3e5f650b89ff3347eb842f1efe7`
- `T4-dave-terminal-ended-when-he-left`: `ses_2106bd0d301815daeb71466576af79d3`
- `A7-pete-agent-ended-when-he-was-removed`: `ses_5714f717e64ececfd631715e6b23927c`
- `A8-quinn-agent-ended-when-her-role-changed`: `ses_d0605fcb391c65efa8066d4e4b01312b`
- `T5-host-terminal-running`: `ses_db1b5b32cf4f7626e6da6cd548eb9b6e`
- `W5-ruth-terminal-in-a-worktree-running`: `ses_c3b5d249e030d352a932fc2296f4d8b1`
- `wish-list`: `ses_1268355246e24d3caef48af021c7e9ac`
- `wish-share`: `ses_5640aa50b2ff09fc3ced07e15cc2a587`
- `A9-mei-agent-main-waiting-for-a-decision`: `ses_5504118ce921d12ac21b71934eafa5ac`
- `A10-host-agent-failed`: `ses_f6361528e726c475b9d993c8ff4b8945`

Also there: `starts` (the links every `smurg host` printed, in order), `storyInvites` (the links of the people of
the tree's story), `checkout` (its topic and sessions), `suggestions` (by what became of each), `conflicts`,
`worktrees`, `merges`, `uploads`, `settingsBefore`, `settingsAfter`, `settingsLive`, `refused` (what the turned-away
connections ended as), `claudeConfigFirst`, `claudeConfig`, `oldWorkspace`.

## Size

2,524,006 bytes in 253 files, this README not counted (324,377 bytes as a compressed archive).
It is large for the reasons the fixture of 0.5.0 is (its README, "Size"): an instance of every key and branch needs a
long story, and two keys exist only on large texts (`truncated` of a conflict's hunk over 64 KiB, of a block of agent
text over 256 KiB). The largest files (of `stopped`): `audit.jsonl` 345,176, `events-000001.jsonl` 311,750, `events-000001.jsonl` 263,698, `activity.jsonl` 114,677. Kept small on purpose: the long conversation of the
tree's story is two blocks, the interrupted uploads hold one small chunk each, a log that only grew between the two
pictures is stored once.

## Coverage

coverage.json, over both variants: optional keys 177 visited and 2 not, arrays 78 and 5,
records 13 and 0, union branches 93 and 31. Of the 38 that are not visited, 33 cannot be written by the
code of 0.5.1 (`why: "cannot"`, the reason names the code) and 5 can and are not in this fixture (`why: "not-made"`,
the reason says what it would take). Its kinds are the persisted kinds of the tree with the two that 0.5.1 added to
the disk and the harness of 0.6.0 names (`written-by.json (the stamp)`, and one kind of kept copy per step).

## Checked

By the code of tag v0.5.1, through the copy step: its daemon (every module of the release, an in-memory relay, the
clock at `at`) starts on a copy of `stopped` and of `running` and opens all 12 state documents of the shared
workspace (agent-sessions, cards, claude-trust, conflicts, host-rules, inbox, reports, sessions, state, suggestions, topics, worktrees) with no step and nothing put back, the stamp read
(0.5.1, shapes 1); on `stopped` it opens the second workspace too (12 documents, no step: the
upgrade was done when the fixture was made; the stamp says 0.5.1). Every file of both variants is accepted by the
schema of 0.5.1 it is an instance of: 409 files of 33 kinds, none refused.
