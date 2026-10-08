# 0.5.0: what the code of tag v0.5.0 wrote

Read `../README.md` first (what a fixture is, the copy step, files.json, coverage.json).

This one is made to hold **an instance of everything 0.5.0 can persist**: every state document, every other
persisted file, and of their schemas every optional key, a filled array and record, and every branch of every union
that the code of 0.5.0 can write. What is not in it is listed in coverage.json with the reason, each one.

## How it was made

On 2026-10-07, on macOS (arm64). Nothing was typed into a state file.

1. `git archive v0.5.0` into a scratch folder; its own tools (`scripts/env.sh`: Node 22.22.1, pnpm 10.34.5) and
   dependencies from the repository's package store (`pnpm install --frozen-lockfile --offline`).
2. One test file in that scratch tree drives everything (`tests/e2e/test/`, run with the tree's own vitest):
   the tree's own end-to-end story `t.topic-flow.test.ts` with its expectations, and after it the steps this
   fixture needs. It uses the tree's own test support and nothing else:
   - the **relay** of that tree in a local workerd (`@smurg/relay/testing` startLocalRelay, dev login on), told about
     a GitHub that is the relay tests' own mock (`apps/relay/test/mock-idp.ts`);
   - the **stand-in for Claude Code** of that tree (`@smurg/daemon/testing` installFakeClaude: the same protocol on
     the pipes, a script instead of a model, no network), first on the PATH as `claude`. No real Claude Code ran,
     nothing was billed, the built-in relay was never named (every command got `--relay`), nobody's own `~/.smurg`
     was touched (`HOME`, `SMURG_HOME` and `SMURG_CACHE_DIR` were scratch folders), `SMURG_NO_UPDATE_CHECK=1`;
   - the **command** from source (`node packages/cli/src/main.ts`), as a process of its own;
   - **people**: clients of the client library (`@smurg/protocol/client`) with their device key and pin in files.
3. The story, in order:
   - `smurg login --relay <relay> --dev-user host`; `smurg host <project> --name Bookshop --role editor`
     (a git repository with two files); `smurg stop`. This made the workspace, `credentials.json`,
     `workspaces.json` and the host log.
   - The tree's story (one topic, "Checkout", from its first message to "complete": a question with votes and a
     comment, spec, a revision an Editor asked for, plan, three work items in worktrees, permission cards, a
     restart of the host's smurg in the middle, reports, reviews, merges, a conflict the agent resolves), with the
     daemon running inside the test (the same `createDaemon` the command calls) on the state the command made.
   - From then on the host's smurg is the command again (`smurg host`, three runs in all). Against it: the host
     confirms and ignores the project's Claude Code settings; a settings change; invites of every state; members
     who join, are removed, come back on a new device, change role, leave; files, uploads (one whole, three
     interrupted), the editor, conflicts; terminals and worktrees with merge requests of every outcome; agent
     sessions with tools and permission cards of every kind, turns that end badly, one answer of more than
     256 KiB (stored cut, `truncated`), a file an agent wrote that changes on disk under a person's typing with
     a line of more than 64 KiB (a conflict whose source is the agent, its text cut, `truncated`), suggestions
     of every origin and outcome; a second topic "Gift cards" with seventeen work items that end differently, follow-ups, a report
     that stops parsing, two changes that conflict; `smurg stop` and `smurg host` in its middle; then more topics
     (a start that fails, a starter who is removed, plans that do not parse, a discussion the host ended, one that
     was started again, an archived topic, a deleted one) and "Wishlist", which is being worked on when the
     pictures are taken: an open question with votes and comments, an open permission card, messages that wait,
     an item that waits for a free agent; 125 writes of small files by an Editor in a minute (120 in
     audit.jsonl, a summary entry, the rest in audit-overflow.jsonl: only a member's own requests have that budget).
   - A member who uses the command: `smurg login` by device code with GitHub (the mock), `smurg attach --invite -`
     with a link whose web address is not the relay's; a second login at another name of the relay, logged out again.
   - Six and a half minutes of waiting (a report is escalated after six times the host's one minute), a review by
     the host in place of the responsible member; the picture `running`; `smurg stop`; the picture `stopped`.

## What was changed afterwards (and nothing else)

`/__SMURG_FIXTURE__` stands for the scratch folder. In the stored files:

| in the files | was |
|---|---|
| `/__SMURG_FIXTURE__/project` | the shared folder (`workspaces.json`, worktree roots and shared links in `state.json`, the ledger) |
| `/__SMURG_FIXTURE__/host` | the host's `SMURG_HOME` (launch files of `running`) |
| `/__SMURG_FIXTURE__/cli-member` | the member's `SMURG_HOME` |
| `/__SMURG_FIXTURE__/outside` | a folder beside the shared one (a permission card about a path outside it) |
| `/__SMURG_FIXTURE__/smurg-src`, `/__SMURG_FIXTURE__/node` | the scratch tree and the Node executable (the hook and MCP commands in launch files) |
| `/__SMURG_FIXTURE__/claude` | the folder of the stand-in |
| `fixture-host` | the name of the computer (the device name of the member who uses the command) |

The copy step puts the copy's real path where `/__SMURG_FIXTURE__` is, so `project`, `host` and `cli-member` are right again; the
others then name folders that do not exist, which nothing reads at a start.

Not copied: the shared folder with its worktrees (see `../README.md`), the scratch homes, the stand-in, caches.

Numbers of the computer it was made on that are still in it: `targetDev` in the upload manifests, the process ids in
`running`'s `sessions.json` and `run/*.pid`, the relay's port in its address (`http://127.0.0.1:62452`).

Every key here was made for this fixture: the daemon's `identity.key`, the device keys, the invite secrets in
`ledger.json`, and the relay session tokens in the two `credentials.json` (signed by a key that existed only in
that test relay). The "GitHub" account `github:12345` is the mock provider's test user.

## The instants

| variant | `at` (ms) | UTC | what |
|---|---|---|---|
| stopped | 1791389873318 | 2026-10-07T16:17:53Z | after the last `smurg stop` |
| running | 1791389871306 | 2026-10-07T16:17:51Z | 2 s earlier, `smurg host` running |

A test sets its clock to `at`. Unused invite links expire from 2026-10-09 on.

## What it holds

Workspace `ws_n8MKlviIItx2COhFvmlwCw`, host `dev:host`. `running` unless said otherwise; `stopped` differs where a stop changes things.

- **Members, 17:** host active 1, agent active 6, editor active 4, viewer active 3, agent kicked 2, editor kicked 1.
- **Devices, 19:** web in use 14, web revoked 4, cli in use 1.
- **Invites, 27:** revoked 5, usable, used before 4, used up 11, usable, used never 6, expired 1.
- **Settings:** `{"humanLockIdleMs": 45000, "agentLockTimeoutMs": 60000, "uploadChunkSize": 1048576, "sharedDirs": ["data"], "diskReserveBytes": 5368709120, "diskReservePercent": 3, "maxLiveAgents": 2, "escalateAfterMs": 60000, "agentMcp": true}`.
- **Worktree roots, 22**, 18 of them of a work item (`item`), each with the shared link `data`.
- **Worktrees:** running: of a session, kept 3, of a work item, in use 18, of a session, in use 1; stopped: of a session, kept 4, of a work item, in use 18. **Merge requests:** merged 7, rejected 1, pending 1, conflict 2, draft 3.
- **Terminal sessions** (`sessions.json`): running 14 live with their processes; stopped none.
- **Agent sessions, 44** (`agent-sessions.json`, purpose, state and why ended): discussion live 9, item ended / merged 3, free live 4, free ended / ended 3, free ended / terminated 1, free ended / left 1, free ended / kicked 1, free ended / role-changed 1, item live 16, item ended / ended 1, free failed 1, discussion ended / terminated 2, discussion ended / archived 1;
  4 of them with messages that wait for a turn (running; 0 in stopped).
- **Conversations** (`transcripts/`): 44 sessions, 44 segments. **Cards** (per-session `cards.json`): question withdrawn 3, question answered 3, permission allowed 10, permission open 2, permission withdrawn 4, permission denied 4, question open 1 (running); question withdrawn 3, question answered 3, permission allowed 10, permission open 2, permission withdrawn 4, permission denied 4, question open 1 (stopped).
- **Suggestions, 20** (origin, status, why closed): revise accepted 1, composer pending 4, composer withdrawn 1, composer rejected 2, selection accepted 1, composer accepted-modified 2, composer accepted 2, composer withdrawn / author-kicked 1, composer withdrawn / author-demoted 1, composer rejected / session-ended 1, selection rejected / session-ended 1, follow-up pending 2, composer rejected / topic-archived 1 (running).
- **Reports, 10:** v1 partial reviewed 1, v1 complete reviewed 1, v2 complete reviewed 2, v1 complete to-review 2, v1 partial to-review 1, v2 complete to-review 1, v1 blocked to-review 1, v1 complete invalid 1.
- **Inbox:** 10 members with a box; notes: mention 16, result 3; read marks: 1.
- **Claude Code project settings** (`claude-trust.json`): decisions trust 1, ignore 2; loaded entries trusted 1, ignored 1.
  **The host's own rules** (`host-rules.json`): 4 of the main folder, 4 of worktrees, seen: false, notices: subscription.
- **Conflicts, 7:** open 5, applied 1, dismissed 1; 7 kept versions in `conflicts/`.
- **audit.jsonl:** running 982 lines, stopped 997; 74 different actions; outcomes: ok 971, denied 22, error 4; actors: system 194, user 599, agent 204.
  **audit-overflow.jsonl:** 4 lines (file.write 4). **audit-text.jsonl:** 94 texts.
- **activity.jsonl:** 318 lines: agent.edit 69, conflict 7, external.change 64, file.create 5, file.delete 2, file.rename 1, file.upload 1, human.edit 152, lock.denied 2, merge 15.
- **The host's other files:** `credentials.json`, `workspaces.json`, `logs/<workspace id>.log`; in `running` also
  `run/<12 characters>.pid` and the launch files of the sessions that have a process
  (`sessions/<workspace key>/<hex of the session id>/settings.json`, `mcp.json`, `role.md`).
- **cli-member/** (`github:12345`): `credentials.json`, `workspaces.json` (one joined workspace, with `web`),
  `device.key`, `pins/`; this member logged in with GitHub (the mock) and has an `avatarUrl` in `state.json`.
  **devices/**: device.key and pins/ of 21 devices of the people who joined with the client library
  (`mallory` is the one who was turned away every time).

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

Removed (`status: "kicked"`): `dev:erin`, `dev:pete`, `dev:sam` and frank's first device only (he came back).
Left by himself: `dev:dave` (still an active member in the file). Role changes: gina viewer -> editor, quinn agent -> editor, olga editor -> viewer.

Revoked devices:

| device | user | name | public key |
|---|---|---|---|
| `kUorkwqD0PQJcS_LzYCHDQ` | `dev:pete` | pete browser | `a8a97a1e459fff53673ccaf98cbc1682e78c07d4c6dda13b7bd0beb119cbc637` |
| `EYoCkn4_sujT49JKBDO2ow` | `dev:erin` | erin browser | `c82381010e9300f7c27a02ae59dd5a253fc378a92ecfbee7beeecfb0c3d96529` |
| `euMxNycdTQqMr86DTc917g` | `dev:frank` | frank browser | `fa39f5119fe4b5729efd67cb17316904a217a55887cff03a6c6fd1b0ce3b9c7d` |
| `MW-qoOYjx44GovKndh-Dfw` | `dev:sam` | sam browser | `c9188f11d8f097a321c813e3296e9de3e493c20570fbc2a74cd91b4625004242` |

### Invites

State at the fixture's instant. The links (with their secrets, after `s=`) are in `ledger.json`; `state.json`
holds only what is derived from a secret.

| state | id | role | uses | expires | link in `ledger.json` |
|---|---|---|---|---|---|
| expired | `inv_WINYNIU5EbIqiWY_O52cdA` | editor | 0 of 2 | 2026-10-07 | `invites["expired-editor-6s"].url` |
| revoked | `inv_7cMEDYyviFACTfmqw6S2HQ` | host (host) | 0 of 1 | 2026-10-14 | a host link of an earlier start (not kept) |
| revoked | `inv_lBC_JONLBa2NfkZRJapWyA` | host (host) | 0 of 1 | 2026-10-14 | a host link of an earlier start (not kept) |
| revoked | `inv_4cEa3D8Ef9Kff-2luP_xlg` | host (host) | 0 of 1 | 2026-10-14 | a host link of an earlier start (not kept) |
| revoked | `inv_MFA2WehPcWPsJhqyZV7rQw` | viewer | 1 of 2 | 2026-10-14 | `invites["gina-viewer-2uses-then-revoked"].url` |
| revoked | `inv_Onu3P5mnh-Iqx535h3XPfg` | editor | 0 of 4 | 2026-10-14 | `invites["revoked-unused-editor"].url` |
| usable, used before | `inv__2D1nNWG3KlnVypUiSsxtQ` | editor | 1, no limit | 2026-10-14 | `firstRun.teammatesLink` (printed by the first `smurg host`) |
| usable, used before | `inv_d65_B0KF6H_vFexSR6fNoA` | agent | 2 of 3 | 2026-10-14 | `invites["agents-3uses"].url` |
| usable, used before | `inv_QNWIRnm8ioF_kOuIGCQRSg` | editor | 3 of 5 | 2026-10-14 | `invites["multi-editor-5uses"].url` |
| usable, used before | `inv_QBYNd8LRlqyNmH4eFLRAnQ` | agent | 1 of 3 | 2026-10-09 | `lastRun.teammatesLink` (printed by the last `smurg host`) |
| usable, used never | `inv_daFtEpf3T-7t3gyba5NAFQ` | viewer | 0 of 20 | 2026-11-06 | printed by the second `smurg host` (viewer, 30 days, 20 uses); not kept |
| usable, used never | `inv_RIr-aGq98CzTZ2c0dhQlCw` | editor | 0 of 3 | 2026-10-14 | `invites["unused-editor-3uses"].url` |
| usable, used never | `inv_k43AjOSgC8oWHogxDZ8iAA` | viewer | 0, no limit | 2026-11-06 | `invites["unused-viewer-nolimit-30d"].url` |
| usable, used never | `inv_2nAGV8yyfMgNvJZKyHWEvg` | agent | 0 of 1 | 2026-10-14 | `invites["unused-agent-1use"].url` |
| usable, used never | `inv_uFE_467DsNXhVhTlOpdRiQ` | agent | 0 of 1 | 2026-10-14 | `invites["cli-member-agent-1use"].url` |
| usable, used never | `inv_lMdeWvCGYJKW9jERWhliZg` | host (host) | 0 of 1 | 2026-10-14 | `lastRun.hostLink` |
| used up | `inv_6wcLlhd7Svjhv_L8aDOHhQ` | host (host) | 1 of 1 | 2026-10-14 | `story.hostLink` |
| used up | `inv_UT1TrfcbrTUAwaNjAEFbPQ` | agent | 1 of 1 | 2026-10-14 | made for one person of the tree's story; not kept |
| used up | `inv_JxblG6Iv-h5XDLGPlS0gYw` | editor | 1 of 1 | 2026-10-14 | made for one person of the tree's story; not kept |
| used up | `inv_kWaRRKwbWRzdSBYDFVT2Kw` | viewer | 1 of 1 | 2026-10-14 | made for one person of the tree's story; not kept |
| used up | `inv_4eo9Eqd4t5ngSbqUImC07w` | agent | 1 of 1 | 2026-10-14 | made for one person of the tree's story; not kept |
| used up | `inv_ZtiHbOwTj4VI1zlumMi-bA` | viewer | 1 of 1 | 2026-10-14 | `invites["bob-viewer-1use"].url` |
| used up | `inv_agCq0y94_xSXRkSpQbm6mA` | agent | 1 of 1 | 2026-10-14 | `invites["kate-agent-1use"].url` |
| used up | `inv_JLHKJCJBT8Ir2Rnr6rdIiA` | agent | 1 of 1 | 2026-10-14 | `invites["dave-agent-1use"].url` |
| used up | `inv_L1W4FIZMNEPjb1VRq8YO5g` | agent | 1 of 1 | 2026-10-14 | `invites["ruth-agent-1use"].url` |
| used up | `inv_T8s2msyRPRHIYVXgVZZ0Nw` | editor | 1 of 1 | 2026-10-14 | `invites["frank-editor-rejoin-1use"].url` |
| used up | `inv_FlPXq03myURZR-IamJwGtA` | agent | 1 of 1 | 2026-10-14 | `invites["sam-agent-1use"].url` |

Links `smurg host` printed: `firstRun.teammatesLink` (editor, 7 days, no use limit), `lastRun.teammatesLink`
(agent, 2 days, 3 uses, with the web address `http://localhost:62452`). Every start makes a new host
link and revokes the unused one before it: `lastRun.hostLink` is the one that is still good; the host's own
device joined with the host link of the story's daemon.

**For a new person:** every row "usable". **Must stay refused:** every row "used up", "revoked", "expired"; the
revoked devices above, with or without a link; the removed members.

### Interrupted uploads

| id | path | where | size | chunks | chunks that arrived | bytes of the part | on conflict |
|---|---|---|---|---|---|---|---|
| `up_R775n2eYjeHfJrzP5LEj4Q` | `assets/logo.txt` | main folder | 1,048,907 | 2 | 1 | 1,048,907 | overwrite |
| `up__CCU3uPIULMtAYaaC33NWQ` | `assets/clip.bin` | main folder | 1,022,710 | 1 | none | 0 | fail |
| `up_v83zkG9jCNeHC5dfJw6h8g` | `assets/in-worktree.bin` | a worktree | 1,048,606 | 2 | 1 | 1,048,606 | rename |

Where a chunk arrived it is the last one (a few hundred bytes at offset 1,048,576): such a part is stored as that
piece and rebuilt by the copy step (zeros before it). One upload was begun and no chunk of it arrived.

### Ids of the story (all in `ledger.json`)

- `gift-cards`: topic `tp_l-V_bHpkEwNfFIX9wnHCBA`, its first discussion session `ses_197621d069274a5ed812e5304aa47c68`
- `late-shipping`: topic `tp_ce8Hpn5xVg7x_Qz88qNtsQ`, its first discussion session `ses_80cbcbd661e503b339777cae2bcbfb60`
- `tiny-things`: topic `tp_63lPMRfbtVXUHyV-PA6NyA`, its first discussion session `ses_ea90a0a9b43fe289c1057572606b35aa`
- `bare-shelves`: topic `tp_wrUmiN19TdFyqcyY3l3DNw`, its first discussion session `ses_a8f5af8fdb6deca25e00c718970ae2c1`
- `exchange`: topic `tp_ts9H84EPzAZDjWSG4ltB_A`, its first discussion session `ses_75fe14dc5524e2060dbd8c2cc0135498`
- `vouchers`: topic `tp_EBptno8n9wVBaquqJszsBA`, its first discussion session `ses_32f39a1c0f829ea5d9a2286f8d8f654e`
- `wishlist`: topic `tp_TbvQkMxH8g1Gd4e-GlPuAg`, its first discussion session `ses_cfa26c055e779736333790418b3ec33e`
- `returns`: topic `tp_f68K5vbuLhYhRHoBDzAx_Q`, its first discussion session `ses_1c6baa9aa72b250dcbf345cad36fe5d2`
- `refunds`: topic `tp_C59ht2UKRhfPtTfaeS80ig`, its first discussion session `ses_ee6f15ccf1a5329aa6de80aa032b3723`
- `old-idea`: topic `tp_A_VAFkqP1R1TMyKSvisO8A`, its first discussion session `ses_74ba1e9f0dbb81af92ffa5459b5e989a`

Sessions by what they are for:

- `T1-host-terminal-running`: `ses_6eaef70ebda25eda7c5e0335081f182c`
- `T2-kate-terminal-exited-by-itself`: `ses_6c332ff2b4bf22f621a842bb447b13cb`
- `T3-kate-terminal-ended-by-the-host`: `ses_8aa14ceb91d9cf8a5f607d179f58d42c`
- `W1-ruth-terminal-in-a-worktree-running`: `ses_e69af3149bc58e6e94cf4a4b405ae7af`
- `W2-kate-terminal-in-a-worktree-kept`: `ses_53754b638e34919893bfb63c008cbb9b`
- `W3-ruth-terminal-in-a-worktree-removed`: `ses_8fc9fe0b9fc47c6127ea9622eaaee06d`
- `A1-host-agent-main`: `ses_d7789ee40d953fa406bd278b4b078f3e`
- `A2-kate-agent-ended-by-kate`: `ses_987411e24f9d9f664102e228c5bc0043`
- `A3-host-agent-failed`: `ses_f1ada460ace4585e4ceef832da033a60`
- `A5-kate-agent-ended-by-the-host`: `ses_12c42a864d0bb493b472b8624a82961f`
- `A11-kate-agent-one-very-long-answer`: `ses_850b1e046ddd450be25b99cf3e7ae818`
- `A4-ruth-agent-in-a-worktree-ended-kept`: `ses_bbd6b2ca03b8cd29c154dae3c664afc3`
- `A6-dave-agent-ended-when-he-left`: `ses_147c50f4ab09de1c6b7c47c70a514956`
- `T4-dave-terminal-ended-when-he-left`: `ses_a7e6cb6a096340667b31b337a5f3db70`
- `A7-pete-agent-ended-when-he-was-removed`: `ses_c9fe33e46104cb0b62015f0e1633a8f0`
- `A8-quinn-agent-ended-when-her-role-changed`: `ses_45f7153ffc1eb3511e8265548dda3d01`
- `T5-host-terminal-running`: `ses_227dc006c7d41f7cc9e138faa1736a6c`
- `W5-ruth-terminal-in-a-worktree-running`: `ses_65ce56179687570c40cb400717d7732e`
- `A9-mei-agent-main-waiting-for-a-decision`: `ses_bb9948139dcea27fb014d172a6ac2350`
- `A10-host-agent-failed`: `ses_5695448fc43ec83f6fa6041ca70044b4`

Also there: `suggestions` (by what became of each), `conflicts`, `worktrees`, `merges`, `uploads`, `settings`
(before and after), `refused` (what the turned-away connections ended as), `claudeConfig`, `rules`.

Of `conflicts`: `openByTheAgentWithALongHunk` (`docs/late.md`) is the one whose `source` is an agent session and whose
hunk is cut at 64 KiB (`truncated`); `openByAgent` (`docs/gina.md`) followed a shell command of an agent and is
stored with the source `system` (smurg could not tell whose the write was); `openWithManyHunks` has more hunks than
are kept (`hunksOmitted`); `openInWorktree` is in a worktree. The answer of more than 256 KiB is in the conversation
of the session `A11-kate-agent-one-very-long-answer`.

## Size

2,050,645 bytes in 227 files, this README not counted (279,384 bytes as a compressed archive
with it, which is about what git keeps). It is larger than a few hundred KiB for two reasons. An instance of every
key and branch of twelve state documents, of the per-session files and of the logs needs a long story
(44 conversations, 997 audit entries, 11 topics). And two keys exist only on large texts: `truncated` of a
conflict's hunk (a text over 64 KiB) and `truncated` of a block of agent text (over 256 KiB); the fixture holds one
of each, 411,117 bytes of one repeated sentence in three files (they compress to almost nothing). The
largest files: `audit.jsonl` 343,698, `events-000001.jsonl` 263,588, `activity.jsonl` 114,865, `coverage.json` 106,474. Kept small on purpose: the long
conversation of the tree's story is two blocks here, the interrupted uploads hold one small chunk each, a log that
only grew between the two pictures is stored once.

## Coverage

coverage.json, over both variants: optional keys 165 visited and 0 not, arrays 71 and 4, records 13 and 0,
union branches 90 and 30. Of the 34 that are not visited, 33 cannot be written by the code of 0.5.0
(`why: "cannot"`, the reason names the code) and 1 can and is not in this fixture (`why: "not-made"`, the reason
says what it would take).

## Checked

By the code of tag v0.5.0, through the copy step: its daemon (every module of the release, an in-memory relay, the
clock at `at`) starts on a copy of `stopped` and opens all 12 state documents (agent-sessions, cards, claude-trust, conflicts, host-rules, inbox, reports, sessions, state, suggestions, topics, worktrees); and every file of both variants is accepted by the schema
of 0.5.0 it is an instance of: 355 files of 30 kinds, none refused.
