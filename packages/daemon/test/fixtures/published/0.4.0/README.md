# 0.4.0: what the published 0.4.0 executable wrote

Read `../README.md` first (what a fixture is, the copy step, files.json, coverage.json).

## How it was made

On 2026-10-07, on macOS (arm64), by the step "REAL" of the 0.5.1 work; nothing was typed into a state file.

1. The published executable `smurg-darwin-arm64` of 0.4.0 was downloaded from the project's release site
   (`https://downloads.smurg.ai/v0.4.0/`) and checked against its `SHA256SUMS` (11619f29…573b0). It says
   "smurg 0.4.0 (protocol v3, …)".
2. `git archive v0.4.0` into a scratch folder, dependencies from the repository's own package store (no network).
   The relay of that tree ran on this computer with its dev login (`pnpm run dev` in `apps/relay`, port 18740).
3. A stand-in `claude` (a small script that answers `--version` with 2.1.283 and `auth status`, prints, waits, and
   plays an agent's edit through the hooks smurg gives it) was the only `claude` on the PATH. No real Claude Code
   ran, nothing was billed, no real relay and nobody's own `~/.smurg` was touched.
4. A scratch git project "tidepool" was shared with the executable under a scratch `HOME` and `SMURG_HOME`:
   `smurg login --relay http://localhost:18740 --dev-user host`, then
   `smurg host <project> --relay http://localhost:18740 --role editor --no-keep-awake`.
5. It was used through the client library of the 0.4.0 tree (device keys and pins kept in files): the host's own
   console device, members of every role, invites, files, the editor, conflicts, uploads, terminal and agent
   sessions, suggestions, worktrees, merge requests, a member who leaves, two who are removed, two settings changes.
6. A member joined with the command itself: `smurg login --dev-user ivan`, `smurg attach --invite -`.
7. The disk was copied while the daemon was running (`running`), then `smurg stop` ("Stopped sharing."), then
   copied again (`stopped`).

## What was changed afterwards (and nothing else)

- `/__SMURG_FIXTURE__` stands for the scratch folder: `/__SMURG_FIXTURE__/project` was the shared folder
  (in `host/workspaces.json`, and four times in `state.json`: two worktree roots and their shared link `data`).
- `/__SMURG_FIXTURE__/bin/smurg` stands for the path of the executable (only in the launch files of `running`:
  `host/sessions/<workspace key>/<session>/settings.json` and `mcp.json`).
- The name of the computer in the device name of the member who joined with the command (`state.json`
  devices[].name, and the ledger's notes) reads `smurg CLI (fixture-host)`.
- The bytes of the interrupted upload's part (`host/workspaces/<id>/uploads/up_csBqrqqTK4yjRWoaJ2NtnA.part`,
  4,194,304 bytes, of which 3 MiB are random data the test client sent) are NOT in the fixture: 3 MiB that
  nothing reads back. The copy step makes a file of that size filled with zeros. The journal beside it
  (`.log`: the SHA-256 of chunks 0, 1 and 3) therefore describes bytes the copy does not hold; smurg does not
  hash a part again when it loads it (`UploadStore.loadArea`, the same file in 0.4.0 and 0.5.0), it only needs
  the file. files.json says so for that entry (`bytesNotKept`): its sha256 is the original's, not the copy's.
- Not copied: the shared folder (see `../README.md`), the scratch `HOME`, the cache of native modules.

Numbers of the computer it was made on that are still in it and mean nothing elsewhere: `targetDev` in the upload
manifest (the device number of the disk), the process ids in `running`'s `sessions.json` and `run/*.pid`
(a start ends a left-over process only when its pid, start time and command line all match: none will).

Every key here was made for this fixture: the daemon's `identity.key`, the device keys, the invite secrets in
`ledger.json`, and the two relay session tokens in `credentials.json` (signed by a key that existed only in that
scratch relay, for `http://localhost:18740`, expired on 2026-10-14).

## The instants

| variant | `at` (ms) | UTC | what |
|---|---|---|---|
| stopped | 1791378242000 | 2026-10-07T13:04:02Z | after `smurg stop`; the last audit entry is 1791378241108 |
| running | 1791378218000 | 2026-10-07T13:03:38Z | 24 s earlier, the daemon running; the last audit entry is 1791378217406 |

A test sets its clock to `at`. The unused invite links expire on 2026-10-14 (the viewer link on
2026-11-06); the host's relay login on 2026-10-14.

## What it holds

Workspace `ws_x0ero8pS70bWM5G4VbZ1NA`, daemon key fingerprint `5521 e1d4 5f4e da2c ff81`, host `dev:host`.

- **Members, 9:** host 1 (dev:host); Agent access 3 (dev:carol, dev:dave, dev:ivan); Editor 4 (dev:amy, dev:gina,
  dev:frank, dev:erin); Viewer 1 (dev:bob). Eight are active; **dev:erin is removed** (`status: "kicked"`). Dave left
  under 0.4.0 and is still an active member in the file. Gina was changed from Viewer to Editor.
- **Devices, 11:** 10 web, 1 cli (dev:ivan). **Two are revoked:** erin's (`oFew2Cg2JhIRVp0G3faezA`) and
  frank's first one (`7gk4PsKLNdVdh2_OdJ1T_Q`: 0.4.0 has no revoke of one device; he was removed and came back on a new
  device with a new link, so frank is an active member with one revoked and one working device). Amy has two.
- **Invites, 14:** used up 6, usable and used before 2, usable and never used 3, revoked 2, expired 1 (table below).
- **Settings**, changed twice in the console: `{"humanLockIdleMs": 45000, "agentLockTimeoutMs": 90000, "uploadChunkSize": 4194304, "sharedDirs": ["data"], "diskReserveBytes": 5368709120, "diskReservePercent": 3}`.
- **Worktree roots, 2**, each with one read-only shared link `data`.
- **Suggestions, 7** (no `origin`: 0.4.0 has none). stopped: accepted 1 (with a code selection), accepted-modified 1,
  rejected 3 (one by the host with a reason, two closed `session-ended` by `smurg stop`), withdrawn 2 (one by its
  author, one `author-kicked`). running: the two that `smurg stop` closed are still `pending`.
- **Worktrees, 2**, both kept in `stopped` (in `running` one still has its terminal session). **Merge requests, 4:**
  merged 1, rejected 1, pending 2.
- **Conflicts, 3:** open 1 (kept for dev:amy on `conflict.txt`), applied 1, dismissed 1; `conflicts/` has the three
  kept versions (44, 49 and 67 bytes).
- **Uploads:** one interrupted, `assets/big-video.bin`: 5,243,003 bytes in 6 chunks of 1 MiB, chunks 0, 1 and 3 arrived.
- **sessions.json:** stopped `{"live":[]}`; running: 3 live sessions with their processes.
- **audit.jsonl:** stopped 193 lines, running 190; 41 different actions; ok 180, denied 13; actors: user 165, system 20, agent 8 (stopped).
  By action: agent.edit 3, auth.connect 30, auth.disconnect 30, auth.join 11, auth.rejected 8, authz.denied 3, device.revoke 2, doc.conflict 3, doc.conflict-resolve 2, doc.edit 5, external.change 4, file.create 2, file.delete 1, file.download 2, file.rename 1, file.upload 1, file.write 5, invite.create 14, invite.revoke 2, lock.acquire 8, lock.denied 1, lock.force-release 1, lock.release 7, member.kick 2, member.leave 1, member.role 1, path.denied 1, session.create 10, session.end 3, session.terminate 2, settings.change 2, suggest.accept 2, suggest.create 7, suggest.edit 1, suggest.reject 3, suggest.withdraw 2, worktree.create 3, worktree.merge.approve 1, worktree.merge.reject 1, worktree.merge.request 4, worktree.remove 1.
- **activity.jsonl:** 32 lines, 10 kinds: agent.edit 3, conflict 3, external.change 4, file.create 2, file.delete 1, file.rename 1, file.upload 1, human.edit 10, lock.denied 1, merge 6.
- **The host's other files:** `credentials.json` (the dev login), `workspaces.json` (one shared folder),
  `logs/<workspace id>.log`, an empty `run/` and `sessions/<workspace key>/` (stopped); `running` also has
  `run/TjKF9sASqOmy.pid` and the launch files of the one agent session that ran.
- **cli-member/** (dev:ivan, written by the 0.4.0 executable): `credentials.json`, `device.key`,
  `pins/<hex of the workspace id>.pub`, `workspaces.json` (one joined workspace).
- **devices/**: device.key and pins/ of `host-console`, `amy`, `amy-phone`, `bob`, `carol`, `dave`, `erin`,
  `frank-laptop`, `frank-phone`, `gina`, and `mallory` (who never got in).

### The invites

State at the fixture's instant. The secret of each link is in `ledger.json` (the part after `s=`); `state.json`
holds only what is derived from it (`keyIdHex`, `pskHex`).

| state | id | role | uses | expires | link in `ledger.json` |
|---|---|---|---|---|---|
| expired | `inv_ZEUmmkm0NtF_gj-9a0B6lg` | editor | 0 of 2 | 2026-10-07T13:00:28Z | `invites["expired-editor-8s"].url` |
| revoked | `inv_rHX04I2_MT3H9zMMBJsegw` | viewer | 1 of 2 | 2026-10-14T13:00:20Z | `invites["gina-viewer-2uses-then-revoked"].url` |
| revoked | `inv_UC9wnGDhWPvFvOYAbebxDA` | editor | 0 of 4 | 2026-10-14T13:00:20Z | `invites["revoked-unused-editor"].url` |
| usable, used before | `inv_tZRl9LGC6HXcQr3NnW25fQ` | editor | 2, no limit | 2026-10-14T12:57:10Z | `links.teamLink` |
| usable, used before | `inv_2XxtGksLLXVvKBtWXtdEGw` | editor | 2 of 5 | 2026-10-14T13:00:20Z | `invites["multi-editor-5uses"].url` |
| usable, used never | `inv_6G1DLoKecHfdUIdGbOU3Xw` | editor | 0 of 3 | 2026-10-14T13:00:20Z | `invites["unused-editor-3uses"].url` |
| usable, used never | `inv_ogRLfZQevSvnqWEnZ70Sgw` | viewer | 0, no limit | 2026-11-06T13:00:20Z | `invites["unused-viewer-nolimit-30d"].url` |
| usable, used never | `inv_7a5zKMfKxrGcnrYNiZ-4fg` | agent | 0 of 1 | 2026-10-14T13:00:20Z | `invites["unused-agent-1use"].url` |
| used up | `inv_McvUF-3Ohjm-F9RcNBBIkg` | host (the host own link) | 1 of 1 | 2026-10-14T12:57:10Z | `links.hostLink` |
| used up | `inv_PAdk5OvbXSgSHqgBQdqQPQ` | viewer | 1 of 1 | 2026-10-14T13:00:20Z | `invites["bob-viewer-1use"].url` |
| used up | `inv_839ulTv6vVL7LrRz6Dyd_Q` | agent | 1 of 1 | 2026-10-14T13:00:20Z | `invites["carol-agent-1use"].url` |
| used up | `inv_mJfMVjP0yEaEgJg3ElzkiA` | agent | 1 of 1 | 2026-10-14T13:00:20Z | `invites["dave-agent-1use"].url` |
| used up | `inv_bIYSQGyWGc5r3wZFYiGH3Q` | agent | 1 of 1 | 2026-10-14T13:00:20Z | `invites["ivan-agent-cli-1use"].url` |
| used up | `inv_zMZKBJL5K8qjp-X3GydGiQ` | editor | 1 of 1 | 2026-10-14T13:00:31Z | `invites["frank-editor-rejoin-1use"].url` |

**For a new person:** `unused-editor-3uses`, `unused-viewer-nolimit-30d`, `unused-agent-1use` (never used), and the
two that were used before and still have room. **Must stay refused:** the six used-up ones, the two revoked ones,
the expired one; and the devices of dev:erin and frank's first one, with or without a link.

### Other ids (all in `ledger.json`)

- conflicts: open `conflict_4TAtEtDhPERt-gzyWq8cLA`, applied `conflict_wpgqYNMI2IdsZbCbFsdc7g`, dismissed `conflict_3ttKDIHBTVlZSckwgCNPXA`
- kept worktrees: `wt_1a6446cb2f94b9ce8fadd272` (carol's), `wt_efcb449900c9593bcdf13b6b` (the host's)
- merge requests: merged `mr_5af9acb2f4fe6eaf64f84491`, rejected `mr_4a6503df8edff6caa18d3920`, pending
  `mr_3ef5388b8d2467de233905c8` and `mr_a8132d293bf7d3d1164e8d2f`
- the interrupted upload: `up_csBqrqqTK4yjRWoaJ2NtnA`

## What 0.5.0 did with it

It refused it at two files (`state.json`: three settings missing; `suggestions.json`: no `origin`) and read
everything else. That is the reason 0.5.1 exists.

## Coverage

This state was made once and is kept as it is; it was not driven to hold everything 0.4.0 can persist (the 0.5.0
fixture is). coverage.json, over both variants: optional keys 24 visited and 4 not, arrays 18 and 1, records 4 and 0,
union branches 21 and 6; each one that is not visited has its reason there.

## Checked

By the code of tag v0.4.0, through the copy step: its daemon (every module, an in-memory relay, the clock at `at`)
starts on a copy of `stopped`, and every file of both variants is accepted by the schema of 0.4.0 it is an
instance of (coverage.json names them): 63 files of 18 kinds, none refused.
