# Research: Yjs document service, Monaco over a custom channel, disk <-> Yjs reconciliation

Scope: SPEC R7 (editor, presence, autosave), R8 (disk is the source of truth, debounce writes, disk diff -> Yjs, conflict panel), D5, D13, D14.
Machine: macOS 26 (Darwin 25.5) arm64, Node v25.4.0, pnpm 10.34.5 (via `npx -y pnpm@10`), Google Chrome (system install, driven headless by playwright-core).
Spike: `/private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/yjs-monaco` (called `$SPIKE` below).

Everything under "Verified facts" was observed by running code in `$SPIKE`. Final state: **86/86 vitest tests pass**, **18/18 end-to-end checks pass** (built web app, spike daemon, two headless Chrome users) and **`tsc --noEmit` (TypeScript 7.0.2) passes** on all spike code.

> **Independent verification (see §8).** Everything was re-run from a fresh `--frozen-lockfile` install in `$VERIFY` (`.../spikes/yjs-monaco-verify`). The architecture holds, but several claims were wrong or incomplete and are corrected inline, marked **[corrected]**. The most important: (1) the daemon can be tricked into reading or writing files **outside the share** through a symlink swap after `doc.open` (security, R1/R5); (2) echo detection that trusts `{size, mtime, ino}` **silently overwrites** external writes on coarse-mtime filesystems; (3) `smartDiffer` is **not** bounded at ~330 ms: a rewritten file of 12-16 K UTF-16 units takes 0.9-2.6 s; (4) with `base = last autosave`, a Bash write built from a stale copy **deletes already-saved human text without a conflict**.

---

## 1. Recommendation

### Q1. Custom Yjs provider over the Envelope channel (web + CLI)

- **One `Y.Doc` and one `Awareness` per open file, on both ends.** Awareness must be per document. Relative positions resolve against one doc, and a position at the end of a text is encoded by type name (`tname`), so it would also resolve in a different file.
- **Wire format.** Use two Envelope types that carry exactly the bytes y-protocols produces:
  - `doc.sync {docId, data}`: a y-protocols sync message (step 1, step 2 or update).
  - `doc.awareness {docId, data}`: an `encodeAwarenessUpdate` blob.
  - Control messages: `doc.open` -> `doc.opened {docId, epoch, readOnly, lock, meta}`, `doc.refused`, `doc.close`, `doc.reset`, `doc.conflict`, `lock.state`. The zod schemas are in `$SPIKE/src/protocol.ts`.
  - Bytes are `z.instanceof(Uint8Array)`. The spike's JSON stand-in codec uses base64 (+33 %). If the protocol package uses a binary codec (CBOR or msgpack), pass the bytes as they are.
- **Client: `EnvelopeYjsProvider`** (about 100 lines, `$SPIKE/src/client/EnvelopeYjsProvider.ts`).
  - `connect()` sends step 1 and our own awareness.
  - Incoming `doc.sync` goes through `readSyncMessage`, and any reply is sent back.
  - Local `update` events are sent as `writeUpdate`.
  - It only publishes awareness for its own `doc.clientID`.
  - `disconnect()` drops remote presences.
  - It does no DOM work, so the CLI can reuse it.
- **Daemon: `DocRoom`** (`$SPIKE/src/daemon/DocRoom.ts`). This is the only fan-out point, because every connection is point-to-point. It:
  - sends step 1 and an awareness snapshot on join;
  - applies and re-broadcasts updates to every other connection;
  - **drops content-carrying sync messages from viewers**, which is how forged `file.write`-style edits are refused (R2);
  - **accepts then reverts** a human update that arrives while an agent lock is held. That covers a lost race with `lock.state` or a client that ignores the read-only UI. Every replica, including the sender, converges back to the text before the edit;
  - **decodes, validates and re-encodes awareness**. A connection may only use client ids bound to it. `user` (name, colour, kind) is always replaced with the daemon's identity for that connection, so a peer cannot claim to be "Host" or "Claude（Ian）";
  - **[corrected] validates `selection` strictly.** The spike's `sanitizeSelection` only checks "object, JSON < 512 chars". Payloads such as `{item:{client:1,clock:-5}}`, `{item:{}}`, `{item:null,tname:null}` or a string clock pass it and make `Y.createAbsolutePositionFromRelativePosition` throw on every peer. y-monaco calls it without try/catch; in Chrome every later update then logs "Caught error while handling a Yjs update" (V5). Parse each position with a strict zod schema: `type` null, `tname` `'content'|null`, `item` `{client,clock}` of non-negative safe integers or null, `assoc` in {-1, 0}, and `item` or `tname` required. Then normalize it through `Y.createRelativePositionFromJSON`, because Yjs treats an absent field (`undefined`) as present;
  - calls `awareness.setLocalState(null)` so the daemon itself never appears as a participant.
- **Agents in presence.** An agent has no client, so for each (file, agent session) the daemon creates a real y-protocols `Awareness` on a throwaway `Y.Doc`, which gives it a unique clientID.
  - Its `update` events are forwarded into the room's awareness with `applyAwarenessUpdate(room.awareness, u, 'agent')`. That broadcasts them and puts them in the snapshot sent to late joiners.
  - The agent's caret is `Y.createRelativePositionFromTypeIndex(room.ytext, applyResult.lastChangeEnd)`, set as `selection: {anchor, head}`. That is exactly the state shape y-monaco renders. The user is `{name: 'Claude（Ian）', color, kind: 'agent'}`.
  - y-protocols renews the state every 15 s by itself. A hand-made one-shot entry is dropped by clients after 30 s; both behaviours were verified in real time.
- **Epoch.** Every daemon-side `Y.Doc` gets a random `epoch`, sent in `doc.opened`. When a client reconnects and the epoch has changed (daemon restart, or the doc was closed and reopened from disk), it **must drop its `Y.Doc` and start a new one**. Syncing two docs that were loaded separately from the same file duplicates the whole file (verified). Also keep a room alive for a grace period after the last client leaves, so short disconnects can merge offline edits with step 1 and step 2 (verified).
- **Client binding order.**
  1. Create the editor read-only.
  2. Wait for the first `synced` (step 2 from the daemon).
  3. Create the model from `ytext.toString()` and call `model.setEOL(LF)`.
  4. `new MonacoBinding(ytext, model, new Set([editor]), provider.awareness)`, then make the editor editable if no lock is held.

  Never insert the initial content on the client.

  **[corrected]** Do steps 3-4 on the **first** `synced` only. `disconnect()` resets `synced`, so `connect()` after a reconnect emits `synced` again. The sketch's handler then calls `createModel` a second time with the same URI and throws "ModelService: Cannot add model because it already exists!" (V6, reproduced in Chrome). On an epoch change, dispose the binding, the model and the Y.Doc, then start over.
- **Presence rendering.** y-monaco only adds the decoration classes `yRemoteSelection-<clientID>` and `yRemoteSelectionHead-<clientID>`. Generate one `<style>` from the awareness states, with a colour per client and a `::after{content:"Claude（Ian）"}` label, and escape names for CSS (`$SPIKE/web/src/presenceCss.ts`).

### Q2. Monaco under Vite

- Use **`monaco-editor@0.57.0` ESM, own thin React wrapper, `?worker` imports and `self.MonacoEnvironment.getWorker`**. Do **not** use `@monaco-editor/react` or `vite-plugin-monaco-editor`:
  - `@monaco-editor/loader@1.7.0` defaults to loading monaco-editor **0.55.1 AMD from `cdn.jsdelivr.net` at runtime**. That is third-party code inside an end-to-end-encrypted app, and a version mismatch. It can be pointed at the local package, but a 60-line wrapper is simpler.
  - `vite-plugin-monaco-editor@1.1.0`: **[corrected]** it is not true that "with Vite 8 its worker files are never emitted". The plugin writes them to `path.join(root, build.outDir, base, 'monacoeditorwork')`. The spike config used an **absolute** `outDir`, so the files landed in `web-plugin-test/private/tmp/.../dist/monacoeditorwork/`, and that caused the 404s. With a relative `outDir: 'dist'`, Vite 8.3.1 emits them and Chrome loads `editor.worker.bundle.js` and `ts.worker.bundle.js` with HTTP 200 (V8). Reject it anyway:
    - last published 2022-07-02;
    - it calls `require('esbuild')` without declaring it, and Vite 8 only lists esbuild as an optional peer;
    - it bundles unhashed classic workers into a fixed directory outside Vite's pipeline;
    - it saves nothing over two `?worker` lines.
- Use the **tree-shakeable entry points introduced in monaco 0.56** (the "slim" variant):

  ```ts
  import * as monaco from 'monaco-editor/editor'
  import 'monaco-editor/features/register.all'
  import 'monaco-editor/languages/definitions/register.all'   // Monarch highlighting, each language a lazy chunk
  import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
  ```

  This drops the TS/JSON/CSS/HTML language-service workers. The TS worker alone is 6.8 MB and IntelliSense is not a product goal. If IntelliSense is wanted later, add those workers; they load lazily per language.
- **You still need `getWorker` for the base editor worker.** Zero-config (no `MonacoEnvironment`) bundles the language workers but fails at runtime with "Failed to load worker script for label: editorWorkerService" (verified).
- **Vite config.** y-monaco 0.1.6 deep-imports `monaco-editor/esm/vs/editor/editor.api.js`. monaco 0.56+ ships an exports map (`"./*": "./esm/vs/*.js"`) that resolves that to `esm/vs/esm/vs/...`. Without an alias the build fails ("Rolldown failed to resolve import ...", verified). Add:

  ```ts
  resolve: {
    alias: [{ find: /^monaco-editor\/esm\/vs\/(.*)$/, replacement: 'monaco-editor/$1' }],
    dedupe: ['yjs', 'y-protocols', 'lib0'],
  }
  ```

- **Agent lock UI.** Call `editor.updateOptions({ readOnly: true, readOnlyMessage: { value: 'Claude（Ian）正在修改…' } })` and show a React banner. Remote Yjs changes (the agent's edit) still apply to a read-only editor (verified). The daemon also enforces the lock (accept-then-revert), so the UI flag is only a convenience.
- **Traditional Chinese UX.** Set `unicodeHighlight: { allowedLocales: { 'zh-hant': true, 'zh-hans': true } }`. By default Monaco draws "ambiguous character" boxes around full-width punctuation such as `！` (verified: 1 box, then 0).
- **[added] Set `unusualLineTerminators: 'off'`.** Monaco 0.57's default is `'prompt'`. For a file containing U+2028 or U+2029, every editable client gets a blocking `window.confirm("Detected unusual line terminators…")`, and each client is asked separately (V7, Chrome). Accepting it edits the model, which is a Yjs edit that autosaves a rewrite of the user's file. `'auto'` does the same silently.
- **[corrected] Worker format.** In the production build, `?worker` produces a **classic IIFE worker** (`new Worker('/assets/editor.worker-….js', {name})`), not a module worker. So Safari and Firefox module-worker support only matters for the dev server. The URL is absolute (`/assets/…`), so set Vite's `base` if the app is served from a sub-path.
- **Size (production build, slim).** 5.3 MB total. The main chunk is 4.16 MB (1.07 MB gzip), `editor.worker` 296 KB, CSS 181 KB, `codicon.ttf` 149 KB, and 70+ lazy tokenizer chunks of 1-16 KB each. The full variant is 14.5 MB, mostly lazy language workers. Load the editor route lazily with `import()` so the workspace shell and terminal don't wait for 1 MB of gzip.

### Q3. Daemon: Y.Doc per open file, disk as the persistence layer

Use `DiskSyncedDoc` (`$SPIKE/src/daemon/DiskSyncedDoc.ts`) together with `DocRoom` on the same `Y.Doc`.

- **Load.** Call `classifyBytes` (Q6), then insert the normalized text with origin `'disk-load'`, record `base` (the last text known to be on disk) and a fingerprint `{sha256, size, mtimeMs, ino}`.
- **Human edits.** Detect them with `doc.on('update', (_, origin) => isHumanOrigin(origin))`, where the origin is the `Conn` object. Debounce (300 ms, with a 2 s max-wait) into `flush()`. `flush()`:
  1. **stats first.** If the file no longer matches the fingerprint, it reconciles the pending external change before writing. It never overwrites that change.
  2. encodes with the file's BOM and EOL;
  3. writes atomically (below);
  4. records the new fingerprint and `base`.

  All per-file operations run through a promise queue.
- **Atomic write.**
  1. `realpath` the target, so a symlink stays a symlink.
  2. Open `.<name>.smurg-<12hex>.tmp` in the same directory with `'wx'` and the original mode, write it, `fsync`, and `chmod` it to the original mode (umask filters `open`'s mode).
  3. `rename` it over the target.

  The watcher ignores the `**/*.smurg-*.tmp` pattern. Verified: a concurrent reader thread did 4,560 reads of a 1 MB file during 200 rewrites and saw **0 torn reads**. A plain `writeFile` gave 597 torn reads out of 980.
- **Telling our own writes from external ones.** On any watcher event for an open path:
  1. ~~`stat`. If `{size, mtimeMs, ino}` equal the last fingerprint, it is our own echo; stop.~~ **[corrected]** Never conclude "unchanged" from `stat` alone. With coarse mtimes, a same-size in-place write right after our own write keeps `{size, mtimeMs, ino}` identical. On real HFS+ (1 s) and FAT32 (2 s) images, the researcher's `DiskSyncedDoc` treated that write as its own echo. The **next autosave then silently overwrote it** (V3). Linux ext4 timestamps come from the jiffy-granular coarse clock, so this can also happen on Ubuntu (not run here). APFS has ns timestamps and was not affected (0 collisions in 2,000 back-to-back writes).
  2. Always read the file and `sha256` it; this takes about 3 ms for 5 MiB. If the hash is our last hash, it is our echo. Do the same in `flush()`'s pre-write check.
  3. Otherwise decode it. If the decoded text equals `base`, only the EOL or BOM changed: update `meta`.
  4. Otherwise it is an external change.

  Verified with the real watcher: 20 debounced writes gave 21 echoes recognised and 0 false "external" changes, and a later `writeFile` gave exactly 1 external change.
- **[added] Re-check containment before every read and every write (security, R1/R5).** The spike validates the path once, at `doc.open` (`resolveInShare`). `DiskSyncedDoc` then keeps reading and writing `this.path` and follows symlinks, and `atomicWriteFile` realpaths on purpose. A guest's sandboxed shell or agent may write the project folder, so after the doc is open it can run `rm -r k && ln -s ~/.ssh k`. Verified with fake files (V2):
  - **read:** the next watcher event loads the outside file into the shared Y.Doc for every collaborator. This leaks host files and defeats R5's `~/.ssh` test, because the daemon is not sandboxed.
  - **write:** the next autosave creates or overwrites a file outside the share with guest-typed content.

  Before each read and each write, `realpath` the file, or its parent directory when the file does not exist yet, and require it to be inside `realpath(share)`. Allow only the R9 read-only shared folders as an exception. If the check fails, pause the doc (`unsupportedOnDisk = 'outside-share'`) and audit-log it. For reads, open the file, `fstat` it, and compare `dev`/`ino` with the checked path. A TOCTOU window remains, because Node has no `openat`/`O_NOFOLLOW` per path component. Consider refusing paths that contain any symlink component (Claude Code 2.1.220 itself refuses "to write through symlink", V9).
- **File deleted, or became binary/huge on disk.** Pause autosave (`deletedOnDisk` / `unsupportedOnDisk`) and let the UI choose restore or close. Never recreate or overwrite it (verified: a binary replacement stays byte-identical).

### Q4. Disk change -> Yjs: `applyDiskChange(ytext, oldText, newText, origin)`

- It requires `ytext.toString() === oldText`; if the Y.Text has diverged, run the Q5 path. It computes a diff and applies it as `insert`/`delete` inside **one `doc.transact(fn, origin)`**. The origin is `{kind:'agent', sessionId, owner}`; the daemon uses it for attribution and to avoid scheduling a write-back.
- It returns `lastChangeEnd`, which becomes the agent's presence caret.
- Characters the diff leaves alone keep their Yjs item ids, so every remote cursor (a RelativePosition) stays put. Verified in unit tests and in real Chrome: Bob's caret stayed on `界` after the agent inserted two lines above it.
- **Differ: `smartDiffer`** (fast-diff plus jsdiff):
  1. Strip the common prefix and suffix without cutting a surrogate pair.
  2. If the changed middle is ≤ 32 K UTF-16 units, run **fast-diff 1.3.0** (minimal, surrogate-safe).
  3. Otherwise run a line-level Myers diff with **jsdiff 9.0.0 `diffArrays` and a 300 ms timeout**. Refine changed blocks of ≤ 4 KB with fast-diff, within a 150 ms budget, and fall back to replacing a whole block. If the line diff times out, replace the whole middle.

  The output is always exact. The worst case on a 5 MB file was about 330 ms (a full rewrite); a typical edit takes 3-20 ms.

  **[corrected] That is not the worst case, and cursors are not always kept.** V1 has the details.
  - Step 2 calls fast-diff **with no bound** whenever the changed middle is ≤ 32 K units. The original benchmark never measured that band, because its "64 KB" files are about 46 K units. A total rewrite of a code file took 865 ms at 12 K units and **1.37 s** at 15.5 K units, and random text took 2.6 s. All of that blocks the daemon's event loop.
  - Above the band, a formatter-style rewrite (every line changed) forms one changed block larger than 4 KB. It is replaced coarsely, so **every remote cursor jumps to the block start**. On an 18 K-unit file the cursor moved from `測試 250` to the file start.
  - Use **`smartDiffer3`** instead (`$VERIFY/verify/smartDiffer3.ts`, same dependencies):
    1. Run fast-diff directly only when the middle is ≤ 4 K units.
    2. Otherwise run the same line-level `diffArrays` with a 300 ms timeout.
    3. Refine each changed block with fast-diff if it is ≤ 4 K. If the block has equal numbers of removed and added lines, run fast-diff on each **line pair** (formatter, re-indent, rename) instead.
    4. Stop refining after a 150 ms budget.
  - Measured with `smartDiffer3`:
    - a 15.5 K-unit code rewrite takes 42 ms;
    - the worst case at any size is about 0.5 s (5 MB of random characters); code rewrites and re-indents take about 310 ms;
    - the formatter rewrite keeps the cursor on `測試 250`;
    - a 5,000-case emoji-dense fuzz (many code points share the D83D high surrogate) is exact on a peer and never splits a pair.
- **Rejected alternatives:**
  - **diff-match-patch 1.0.5** splits surrogate pairs. Yjs then turns both halves into U+FFFD, which corrupted emoji in 5 of 7 Unicode cases, locally and on the peer.
  - **fast-diff alone** has no time bound: 9.3 s for a 64 KB rewrite, and over 30 s at 256 KB.
  - **jsdiff `diffChars`** is correct but slow, and timed out after 30 s inserting 2,000 lines into a 256 KB file.

### Q5. Backup path: disk changed while humans have unsaved text

- Use `threeWayReconcile(base, ours, theirs) -> {merged, conflicts[]}` with:
  - `base` = the last synced version;
  - `ours` = the current Y.Text;
  - `theirs` = the new disk text (normalized).

  It is a line-based diff3 with the node-diff3 region algorithm, **re-implemented on jsdiff `diffArrays`** (`$SPIKE/src/diff3.ts`).
- **node-diff3 3.2.1 is unusable.** Its LCS blows up on repetitive lines (`}` and blank lines): 4,000 lines took 10.2 s, and 10,000 lines took 154 s. Our version handles 50,000 lines in 5-22 ms. In a differential test on 3,000 random cases, the merged output matched node-diff3 in 2,970. The other 30 are ambiguous alignments of repeated lines, where ours reports a conflict and therefore keeps the human text.
- **Rules:**
  - Split on `'\n'` only, keeping everything (`s.split('\n').join('\n') === s`), so CRLF and "no trailing newline" round-trip exactly.
  - Hunks that overlap **or touch** (adjacent lines) are conflicts, as in git.
  - Non-overlapping hunks from both sides are merged.
  - On a conflict, **keep `ours`** and record `{mergedStartLine, mergedEndLine, theirsStartLine, base, ours, theirs}`.
  - If the diff times out, treat the whole middle as one conflict.
- **Integration steps:**
  1. `applyDiskChange(ytext, ours, merged, agentOrigin)`, which keeps cursors.
  2. `base = theirs`.
  3. Send `doc.conflict` for the conflict panel.
  4. If `merged !== theirs`, schedule a write so the disk converges to `merged` and the human text is not lost.

  The E2E test in Chrome covered all of it: Amy's unsaved line was kept, the agent's non-overlapping `greet("smurg")` was applied, the overlapping agent line reached the conflict panel, and the disk and Bob converged.
- **[corrected] Choice of `base`.** With `base` = the last autosave, the backup path only protects text typed within the last debounce window (300 ms). The E2E only passed because it used a 1.5 s debounce and triggered the agent 100 ms after typing. V4 reproduces the gap:
  1. Amy's line is autosaved.
  2. A Bash write built from a stale copy lands (`git checkout -- f`, a code generator, `cat > f <<EOF`, a formatter holding an old buffer).
  3. `ours === base`, so the 2-way path removes Amy's line from every editor and from disk, with **0 conflicts**.

  This breaks R8's acceptance test ("人打的內容不會遺失").

  **Recommended:** while a human edit lock is held, keep `lockBase`, the disk text at the moment the lock was taken. Reconcile every external change as `threeWayReconcile(lockBase, ytext, disk)`. Reset `lockBase` to the disk text when the lock is released. Verified results for the same inputs:
  - a non-overlapping agent change keeps both changes;
  - an overlapping change keeps the human text and creates a conflict;
  - `git checkout -- f` (theirs === lockBase) keeps the human text. The daemon should still report that revert in the activity feed.

### Q6. Binary, huge and encoding

Use `classifyBytes(buf, maxBytes = 5 MiB)` (`$SPIKE/src/fileText.ts`). It checks, in this order:

1. **Size.** Default 5 MiB, host-configurable. The initial sync of a 20 MB doc is a single ~21 MB message, 27 MB as base64, which is close to the relay's 32 MiB limit. At 5 MB a Y.Doc is cheap: 5.17 MB sync payload, 9 ms to encode, 11 ms to apply.
2. **UTF-16/32 BOM.** Refuse with a specific reason.
3. **A NUL byte anywhere in the bounded buffer.** Treat as binary (git uses the first 8,000 bytes; we already hold the whole buffer).
4. **`new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`.** Refuse invalid UTF-8, for example a Big5 file. Never use `Buffer.toString`, which silently inserts U+FFFD and would corrupt the file on save.
5. **UTF-8 BOM.** Strip it from the Y.Text and restore it on save.
6. **Line endings.** **Normalize CRLF to LF in the Y.Text** and store `eol` (the majority style) and `mixedEol`. Re-apply the EOL on save; this is byte-exact for pure-CRLF files. Mixed-EOL files are normalized to the majority on the first save, so show a one-time notice.

This is required, not cosmetic. In a real Monaco, y-monaco diverges or corrupts when the Y.Text contains CRLF with LF inserts, or mixed EOLs. With LF-only it stays consistent, including a CRLF paste (verified in Chrome).

**[corrected] Normalize lone CR too.** `classifyBytes` only rewrites `\r\n`, so a bare `\r` stays in the Y.Text. Monaco treats `\r` as a line break and re-normalizes the model when it is created and in y-monaco's `setValue` (V6, Chrome):
- A single stray CR in an LF file only makes the model show `\n` where the Y.Text has `\r`. The lengths stay aligned, so this is benign.
- A **classic-Mac CR-only file** gets a CRLF model: 21 units vs 18 in the Y.Text. Edits then land at the wrong offsets; the model showed `!#REND` while the Y.Text had `!END#R`.

Normalize `/\r\n?/g` to `\n`, record `eol` ∈ {`\n`, `\r\n`, `\r`} by majority, and set `mixedEol` when more than one kind occurs.

### Q7. File watcher

Use **`@parcel/watcher` 2.6.0**, one `subscribe(root, cb, { ignore: ['.git', 'node_modules', '.smurg', '**/*.smurg-*.tmp'] })` per root (the main tree and each worktree).

- Treat every event, whatever its `type`, as "this path may have changed, re-check it (stat, hash, diff)". An atomic rename-over is reported as `create`, not `update`.
- Measured on this Mac with 22 k watched files, 10 k ignored files, and a `git checkout` that touched 1,220 paths:

| | @parcel/watcher 2.6.0 | chokidar 5.0.0 | fs.watch recursive (Node 25) |
|---|---|---|---|
| startup | 3-6 ms | 1,031-1,035 ms (crawls the whole tree) | 0 ms |
| open fds | 13 | **22,013** (one per file) | 15 |
| RSS delta | +0.7-0.9 MB | **+294-322 MB** | +0.1-0.3 MB |
| `child_process.spawn` while watching | ok | **EBADF** | ok |
| git checkout, paths missed | 0/1220 | 0/1220 and 40/1220 (two runs) | 0/1220 |
| ignored events that reached JS (node_modules burst / .git during checkout) | 0 / 0 | 0 / 0 | 3,001 / 12 |
| atomic save (tmp + rename) | `create:<target>` | `change:<target>` | `rename` x2 |

- **chokidar 5 is disqualified.** On macOS, v4 and later have no fsevents and keep one fd per watched file. Holding more than about 10,240 fds makes every `spawn()` fail with EBADF (reproduced without chokidar, using plain `openSync`). The daemon spawns PTYs, git and srt.
- **`fs.watch` recursive** is usable but gives weak events and no native ignore.
- **@parcel/watcher** uses FSEvents on macOS and inotify on Linux, which is what VS Code uses. It also has `writeSnapshot`/`getEventsSince` for daemon restarts. **[verified on macOS, V10]** Changes made while nothing was subscribed come back in 22-43 ms:
  - an in-place edit as `update`;
  - an atomic replace as `create`, plus a `delete` for the temp name;
  - `delete` and `create` for deleted and new files;
  - nothing for paths under an ignored dir.

  It also returns an `update` for the root directory itself. Keep the snapshot file outside the watched root, or it reports itself.
- **[added] How Claude Code writes files (V9, real `claude` 2.1.220 against a local mock API).** `Edit` and `Write` write a temp file named `<name>.tmp.<pid>.<12hex>` in the same directory, then rename it over the target. The inode changes and hard links break (nlink 2 -> 1). Mode 0755, CRLF and the UTF-8 BOM are preserved. @parcel/watcher reports `create <file>` plus `delete <file>.tmp.<pid>.<hex>`. Hide `/\.tmp\.\d+\.[0-9a-f]{12}$/` from the file tree and activity feed, in addition to smurg's own `*.smurg-*.tmp`. An `Edit` through a symlinked path fails with "Refusing to write through symlink".
- **Packaging.** The native `.node` ships in per-platform optional packages (`@parcel/watcher-darwin-arm64`, `-linux-x64-glibc`, ...). Bundle and extract it the same way `pty-packaging.md` does for node-pty. This matches `claude-hooks.md`: the daemon's own recursive watcher, not the `FileChanged` hook, is the source of truth.
- **[added 2026-09-29] Watcher crash: native races in @parcel/watcher 2.6.0 (macOS).** A gate worker running `watcher.test.ts` died with SIGTRAP: libmalloc "memory corruption of free block" in `FSEventStreamCreate` <- `FSEventsBackend::startStream` <- `Backend::watch`, on a libuv worker. What its `src/` does off the JS thread, without the JS thread's locks:
  1. the last unsubscribe erases the global backend map (`Backend.cc` `removeShared`, `rehash(0)`) on a pool thread while the JS thread reads it for the next call (`Backend::getShared`);
  2. a subscribe that fails (directory missing) runs `Watcher::destroy()` on the pool thread: `napi_reference_unref` / `napi_delete_reference` off the JS thread and an unlocked erase of the global watcher set;
  3. when FSEvents reports the watched root deleted, `FSEventsCallback` stops and releases the stream itself on the run-loop thread; an unsubscribe running at the same time releases it again;
  4. `startStream` sets `state->tree` only after `FSEventStreamStart`: an event arriving in between dereferences null;
  5. a re-subscribe of a directory whose unsubscribe is still running shares the old native `Watcher` and never reports;
  6. a process exiting with live subscriptions aborts ("mutex lock failed": static mutexes destroyed under the FSEvents thread).

  Stress, each run a child process for 3 s, 2 CPU burners: failing subscribes crashed 16 of 40 runs (V8 `GlobalHandles` checks) even with nothing overlapping; overlapping same-directory calls 1/40 (SIGSEGV in `Backend::getShared`); an unsubscribe with the root renamed away in the same tick 3/40, and 38/40 through the old `FileWatcher`, with exactly the gate's signature; REL-10 moves through the old `FileWatcher` 31/40; roots that vanish right after registration 40/40; exit with live subscriptions 2/80; re-subscribes of the same directory dead 30 of 45. With `files/watcher.ts` fixed (one process-wide queue of native calls, stat before subscribe, a vanished root released only after FSEvents reported it + 500 ms, `unregisterWorktree` waiting for the release, `stop()` waiting for everything): the daemon's own flows 0 crashes in 271 runs; left are race 3 for an outside rename in the same tick as an unsubscribe (9/63) and race 4 under subscribe churn during continuous writes (2/120, about 1 per 250k-500k native calls). node-pty 1.2.0-beta.15 (every call synchronous on the JS thread, one exit-waiter thread per PTY using a thread-safe function): 0 crashes in 40 runs, 251k spawn / resize / write / kill calls. Not yet reported upstream.

---

## 2. Dependencies (exact versions installed and exercised)

**Needed by smurg:**

| Package | Version | Used by | Note |
|---|---|---|---|
| yjs | 13.6.33 | web, cli, daemon | |
| y-protocols | 1.0.7 | web, cli, daemon | `sync`, `awareness` |
| lib0 | 0.2.118 | web, cli, daemon | encoding/decoding, base64 |
| y-monaco | 0.1.6 | web | needs the Vite alias (see Q2) |
| monaco-editor | 0.57.0 | web | ESM; the 0.56+ entry points are used |
| fast-diff | 1.3.0 | daemon (protocol if shared) | char-level diff |
| diff (jsdiff) | 9.0.0 | daemon | `diffArrays` with `timeout` for line diff and diff3 |
| @parcel/watcher | 2.6.0 | daemon | prebuilt `@parcel/watcher-darwin-arm64@2.6.0` was installed. pnpm 10 skipped its `install` script, which is fine because it is only a build-from-source fallback |
| zod | 4.6.5 | protocol | `z.instanceof(Uint8Array)` for bytes |

**Spike or test only:**

| Package | Version | Note |
|---|---|---|
| react / react-dom | 19.3.0 | |
| vite | 8.3.1 | builds with Rolldown |
| @vitejs/plugin-react | 6.1.1 | |
| vitest | 5.0.2 | |
| tsx | 4.23.15 | |
| typescript | 7.0.2 | |
| playwright-core | 1.63.0 | drove system Chrome; no browser download |
| ws | 8.22.0 | stand-in transport |
| @types/* | | |

**Evaluated and rejected:**

| Package | Version | Reason |
|---|---|---|
| diff-match-patch | 1.0.5 | splits surrogate pairs |
| node-diff3 | 3.2.1 | quadratic LCS; `engines` says `bun >=1.3.10` only, although `dist/diff3.mjs` loads in Node |
| chokidar | 5.0.0 | fd per file, spawn EBADF |
| vite-plugin-monaco-editor | 1.1.0 | workers 404 on Vite 8 |
| @monaco-editor/react | 4.7.0 (loader 1.7.0) | loads from CDN by default |

---

## 3. Verified facts

| # | Claim | Evidence |
|---|---|---|
| F1 | fast-diff 1.3.0, jsdiff `diffChars` and our `smartDiffer` (default path and forced line-level path) apply CJK, emoji, ZWJ, skin-tone and CJK Ext-B edits exactly on the local and the peer Y.Doc. **diff-match-patch 1.0.5 fails 5 of 7 cases** (split surrogates become U+FFFD). | `pnpm vitest run test/applyDiskChange.test.ts --silent=false` prints the matrix |
| F2 | Yjs replaces a split surrogate pair with U+FFFD on both sides. | Test "splitting a surrogate pair…". Source: `ContentString.splice` in `yjs.mjs` (issue #248 comment) |
| F3 | 2 x 2,000 random CJK/emoji/CRLF edits through `smartDiffer` converge exactly on a peer and never split a pair. | Fuzz tests in `applyDiskChange.test.ts` |
| F4 | A minimal diff keeps remote RelativePositions on the same character, and positions still resolve after a JSON round-trip (the awareness wire format). Replace-all moves them. A cursor inside a deleted region collapses to the deletion point. | Cursor tests in `applyDiskChange.test.ts` |
| F5 | A delete-only transaction does not change the state vector but does fire `update`. | Test "a delete-only transaction…" |
| F6 | Two Y.Docs loaded separately from the same text duplicate it when synced. | Tests "…DUPLICATE content…" and the provider "epoch" test |
| F7 | Diff timings. **fast-diff:** 64 KB rewrite 9.3 s; 256 KB rewrite over 30 s; 1 MB reindent over 30 s. **smartDiffer:** 64 KB rewrite 66 ms; 1 MB and 5 MB rewrite or reindent 302-309 ms (coarse); 5 MB with 100 scattered edits 21 ms (3 KB update); one-line edit on 5 MB 13 ms. **dmp:** capped at about 1 s by `Diff_Timeout`. **jsdiff `diffChars`:** timed out on insert-2000-lines at 256 KB. **[corrected]** The numbers reproduce (fast-diff 64 KB rewrite 9.39 s), but "64 KB" in this bench is about 46 K UTF-16 units, so smartDiffer's unbounded fast-diff band (≤ 32 K units) was never measured. There it takes 1.37 s (15.5 K-unit code rewrite) to 2.6 s (random text). `bench/fastdiff-worst.ts` flat-lines at about 330 ms above 8 KB only because its LCG repeats, so a and b share long runs (V1). | `SIZES=64,256,1024,5120 pnpm bench:diff` (children killed after 30 s); `$VERIFY: npx tsx verify/smart-worst.ts` |
| F8 | node-diff3 `diff3Merge` on repetitive lines: 1k 153 ms, 2k 1.85 s, 4k 10.2 s, and 10k 154 s (earlier run, before the rewrite). Our `threeWayReconcile` handles 50k lines in 5-22 ms. | `pnpm bench:diff3` |
| F9 | `threeWayReconcile` cases (disjoint, overlapping, agent deletes the region being typed in, adjacent lines conflict, identical change, raw CRLF, no trailing newline, both insert at the same place) behave as specified. It agrees with node-diff3 in 2,970/3,000 random cases. | `test/threeWayReconcile.test.ts` (13 tests) |
| F10 | Provider and DocRoom: a late joiner receives the file once; edits fan out; keystroke updates are 3, 4 and 36 bytes (**[corrected]** 3 and 4 bytes are the step 1 / step 2 handshake and 36 bytes is a 13-character insert. One keystroke is a 29-32 byte sync message and a backspace is 13 bytes; `verify/keystroke-size.ts`); offline edits merge on reconnect; viewer updates are never applied; a spoofed awareness clientId is dropped and the displayed name is forced to the daemon identity; an agent-lock race is reverted everywhere (insert and delete-only). | `test/provider.test.ts` |
| F11 | Agent presence built on a real `Awareness` is still present on clients after 40 s of real time. A hand-crafted one-shot entry expires. `vi.useFakeTimers` cannot test this because `lib0/time` binds `getUnixTime = Date.now` at import. | Real-time test in `provider.test.ts` (40 s); `node_modules/lib0/time.js:22` |
| F12 | Atomic write (tmp + fsync + rename): 0 torn reads in 4,560 concurrent reads. Plain `writeFile`: 597 torn reads in 980. | `test/diskSync.test.ts` (worker-thread reader) |
| F13 | With the real @parcel/watcher: 21 own-write echoes recognised, 0 false external changes, 1 real external change applied with the agent origin. **[corrected]** This holds on APFS only. On HFS+ and FAT32 the stat short-circuit misses a same-size in-place external write, and the next autosave overwrites it (V3). | `diskSync.test.ts` "own writes are recognised…"; `$VERIFY/test-verify/coarse-mtime.test.ts` |
| F14 | The pre-write stat check merges an external change whose watcher event has not been processed yet, instead of overwriting it. A symlink stays a symlink. Mode 0755 is preserved. Deleted or binary-replaced files are never overwritten. | `diskSync.test.ts` |
| F15 | `classifyBytes`: BOM and CRLF round-trip byte-exactly; mixed EOL is flagged; NUL means binary; Big5 means invalid-utf8 (while `Buffer.toString` inserts U+FFFD); UTF-16 BOM is refused; the size limit works. The default `TextDecoder` strips the BOM, `Buffer.toString` keeps it. | `test/fileText.test.ts` |
| F16 | The Vite 8.3.1 build succeeds for both slim and full. Without the `monaco-editor/esm/vs/*` alias it fails with "Rolldown failed to resolve import 'monaco-editor/esm/vs/editor/editor.api.js' from … y-monaco.js". | `pnpm build:web`; `NO_YMONACO_ALIAS=1 npx vite build --config web/vite.config.ts` |
| F17 | Bundle sizes as listed in Q2. | `du` and `gzip -c | wc -c` on `web/dist-slim` and `web/dist-full` |
| F18 | Zero-config Monaco (no `MonacoEnvironment`) fails for `editorWorkerService` (404). vite-plugin-monaco-editor produces 404s for `/monacoeditorwork/*.bundle.js` and falls back to the main thread. **[corrected]** The zero-config failure is confirmed. The plugin's 404s are caused by the spike's absolute `outDir`; with `outDir: 'dist'` the workers load (V8). | `npx vite build --config web-plugin-test/vite{,.zero}.config.ts && npx tsx web-plugin-test/check.ts` |
| F19 | `@monaco-editor/loader` 1.7.0 default config is `vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs'`. | `node_modules/.pnpm/@monaco-editor+loader@1.7.0/.../lib/es/config/index.js` |
| F20 | **E2E in headless Chrome, 18/18 checks:** <ul><li>sync from disk</li><li>keystroke latency Amy -> Bob of 0-2 ms on localhost</li><li>autosave at debounce + 23 ms</li><li>agent-lock banner on both pages</li><li>editor read-only (typing ignored)</li><li>daemon reverts a UI-bypassing `ytext.insert` in 4 ms</li><li>agent disk edit applied to both editors</li><li>Bob's caret stays on `界`</li><li>agent shows as "Claude（Ian）" with a rendered caret decoration and label</li><li>editable again after release</li><li>3-way merge with the human line kept and the non-overlap applied</li><li>conflict panel</li><li>disk and Bob converge</li><li>`editor.worker` loaded from the build (**[corrected]** as a classic IIFE worker, not a module worker as the check's label says)</li><li>no console errors</li><li>`unicodeHighlight` zh fix</li></ul> | `pnpm build:web && pnpm e2e`; screenshots in `$SPIKE/e2e/screenshots/` |
| F21 | y-monaco with a CRLF Y.Text plus an LF insert diverges (`X\nY` in the Y.Text, `X\r\nY` in the model). A mixed-EOL Y.Text corrupts: a later edit lands at the wrong offset (`e!f` in the Y.Text vs `ef!` in the model). An LF-only Y.Text stays consistent through Enter, remote inserts, local edits and a CRLF paste, which is normalized to LF. | E2E "CRLF probe" (`web/src/crlfProbe.ts`), output in `$SPIKE/.tmp/e2e-last.log` |
| F22 | The watcher table in Q7, and spawn EBADF at 10,230 or more held fds without any watcher. | `pnpm watch:compare`, `pnpm watch:spawn-fd-limit` |
| F23 | Y.Doc cost: 1 / 5 / 20 MB text gives initial payloads of 1.03 / 5.17 / 20.67 MB, encode times of 2 / 9 / 36 ms, and apply times of 3 / 11 / 43 ms. 20k random edits take about 450 ms and add about 0.5 MB of state. | `pnpm bench:ydoc` |
| F24 | All spike code type-checks with TypeScript 7.0.2 (`moduleResolution: Bundler`, `allowImportingTsExtensions`). | `pnpm typecheck` exits 0 |

---

## 4. Unverified / could not test here

- **Linux.** Nothing ran on Linux, because Docker (colima) was not running and I did not start a VM. Untested: @parcel/watcher's inotify backend, `fs.watch` recursive on Linux, inotify `max_user_watches` limits on large trees, and Ubuntu 24.04. **Test the watcher and a git checkout on Linux before relying on it.**
- **The real encrypted channel and relay.** Tested only over a localhost WebSocket with JSON and base64. Not measured: latency through Cloudflare, ordering, and replay with `seq` after reconnect.
- **Browsers other than Chrome.** Safari and Firefox were not run. ~~Monaco module workers need `{type:'module'}` worker support.~~ **[corrected]** The production build uses a classic IIFE worker; only the dev server uses module workers.
- ~~**Browser performance with a 5 MB file** in Monaco plus y-monaco.~~ **[now verified, V11]** Headless Chrome, localhost, JSON/base64 stand-in channel:
  - a 5 MB file opens and binds in 0.41-0.46 s, with an 86 MB JS heap;
  - a keystroke reaches the peer in 12-29 ms, including Playwright polling;
  - an agent disk edit reaches the peer's editor in 99 ms;
  - 1 MB: 0.3 s to open, 31 MB heap, 61 ms for the agent edit.
- ~~**`@parcel/watcher` `writeSnapshot`/`getEventsSince`**~~ **[now verified on macOS, V10]**; still untested on Linux.
- **Node SEA packaging of the @parcel/watcher `.node` binary.** It should work like the node-pty approach in `pty-packaging.md`, but that was not tried.
- ~~**How Claude Code's Edit and Write tools write files**~~ **[now verified, V9]**: tmp file (`<name>.tmp.<pid>.<12hex>`) + rename, for both Edit and Write in 2.1.220.
- **Long-running Y.Doc memory** (hours of editing, GC of tombstones). Only 20k edits were measured.
- ~~**mtime precision on filesystems other than APFS**. The hash fallback covers coarse mtimes, but that was not run.~~ **[now verified, V3, and the claim was wrong]**: on HFS+ and FAT32 the stat short-circuit hides same-size writes, and the hash fallback is never reached. ext4 and network filesystems were still not run.
- **The residual TOCTOU window** between the pre-write `stat` and `rename`. An external write landing in that window of about 1 ms would be overwritten silently. That was not reproduced. Closing it would need `renameat2(RENAME_EXCHANGE)` / `renamex_np(RENAME_SWAP)`, which Node does not expose. The same kind of window exists for the symlink-swap containment check (V2).
- **The `lockBase` variant (Q5, corrected)** was verified only at the `threeWayReconcile` level, not wired into `DiskSyncedDoc` or run end to end.

---

## 5. Gotchas

1. **y-monaco 0.1.6 vs monaco ≥ 0.56 exports map.** A Vite alias is required (F16). Also, `MonacoBinding.destroy()` does not dispose its `editor.onDidChangeCursorSelection` listeners (source: `node_modules/y-monaco/src/y-monaco.js`). Keep one binding per model and dispose the model and binding together; reusing an editor across files is fine because the listener checks `editor.getModel() === monacoModel`.
2. **y-monaco renders no names or colours.** Generate CSS per clientID and escape user names, which end up inside a CSS string.
3. **Bind Monaco only after the first sync, and keep it read-only until then.** Never insert file content on the client.
4. **Check the epoch on every (re)open.** A new daemon Y.Doc plus an old client Y.Doc means duplicated text (F6).
5. **Messages can arrive before the provider subscribes.** The daemon sends step 1 right after `doc.opened`, so the client channel must buffer `doc.*` messages per docId until `subscribe()` (see `wsChannel.ts`).
6. **Delete-only updates don't advance the state vector.** Detect "did this message change the doc" with an `update` listener, not by comparing state vectors (F5). The first version of DocRoom compared state vectors, which would have missed delete-only edits during an agent lock.
7. **Normalize to LF in the daemon.** CRLF or mixed EOL in the Y.Text breaks y-monaco (F21). Keep `eol` and `bom` in `meta`, update them from disk on every external change so a formatter's EOL switch sticks, and warn about mixed-EOL files.
8. **Surrogate pairs.** Any char-level diff that can split a pair corrupts emoji through Yjs's U+FFFD replacement. Don't use diff-match-patch; there are surrogate-safe forks, but they are unnecessary.
9. **fast-diff has no timeout.** Always bound it (smartDiffer). A reformat of a big file otherwise freezes the daemon. Even bounded, the worst case is about 330 ms on the main thread for 5 MB; move files over about 1 MB to a `worker_thread` if typing latency matters.
10. **node-diff3 pitfalls.** It is quadratic on repetitive lines (F8). When given strings, it splits on `/\s+/` (whitespace), not lines. Pass arrays.
11. **Adjacent edits conflict.** The merge is conservative: a human editing line 3 and an agent editing line 4 produces a conflict, which keeps the human text. Ambiguous alignments of repeated lines can also produce conflicts that node-diff3 would not.
12. **The agent-lock race.** `lock.state` can reach a client after it typed. The daemon applies and then reverts, so every replica converges. The reverted characters flash for a few ms, and re-inserted deleted text gets new item ids, so neighbouring carets may shift by the size of the reverted range.
13. **The daemon's own `Awareness` starts with local state `{}`.** Set it to `null`, or the daemon shows up as a user.
14. **Awareness timing.** Clients drop states that have not been renewed for 30 s, so synthetic agent entries must be renewed; a real `Awareness` does this every 15 s. `vi.useFakeTimers()` can't drive it because `lib0/time` captured `Date.now` at import. Test in real time.
15. **Atomic rename side effects.** It creates a new inode, which breaks hard links, and tools holding the old fd keep reading old content. Resolve symlinks first and preserve the mode (F14). Temp files appear briefly in the shared folder; ignore them in the watcher and file tree.
16. **@parcel/watcher reports atomic replacement as `create`.** Don't branch on the event type.
17. **chokidar ≥ 4 on macOS keeps one fd per file.** More than about 10,240 fds breaks `child_process.spawn` (EBADF), including node-pty and git (F22).
18. **Monaco needs the base editor worker even though language workers auto-bundle** (F18). With the slim build, `getWorker` can return the editor worker for every label.
19. **Monaco boxes CJK full-width punctuation** unless `unicodeHighlight.allowedLocales` includes `zh-hant` (F20).
20. **`a?.(b())` does not evaluate `b()` when `a` is undefined.** This bit `DiskSyncedDoc` (the disk change was silently not applied) until the call was hoisted.
21. **playwright `page.evaluate(closure)` under tsx.** esbuild's `keepNames` injects `__name(...)`, which is undefined in the page. Pass a string for non-trivial closures.
22. **Viewers' step-2 replies are also dropped.** That is harmless, because a viewer cannot hold unique content.
23. **[added] Symlink swap after `doc.open`.** Validate the real path before every read and write, not once (Q3, V2).
24. **[added] `stat` equality is not "unchanged".** Always hash on watcher events and before writing (Q3, V3).
25. **[added] `smartDiffer`'s unbounded fast-diff band and coarse block replace.** Use `smartDiffer3` (Q4, V1).
26. **[added] Autosaved human text is not protected by `base = last autosave`.** Use `lockBase` while the human edit lock is held (Q5, V4).
27. **[added] Validate awareness `selection` with a strict schema and normalize it through Yjs** (Q1, V5).
28. **[added] `synced` fires again after every reconnect.** Guard the bind (Q1, V6).
29. **[added] Lone `\r` and CR-only files break y-monaco** like mixed EOL (Q6, V6).
30. **[added] `unusualLineTerminators: 'off'`** (Q2, V7).
31. **[added] Claude Code's temp files `<name>.tmp.<pid>.<12hex>`** appear in watcher events. Claude Code also refuses to edit through a symlink (Q7, V9).
32. **[added] `threeWayReconcile` blocks for up to 2 x 500 ms** (two `diffArrays` timeouts) before it falls back to "whole middle = one conflict". Run it and `applyDiskChange` in a `worker_thread` if the daemon's event loop must stay responsive for terminals.

---

## 6. Verified code (key snippets that ran; full files are in `$SPIKE/src`)

### (a) Custom provider: client (`src/client/EnvelopeYjsProvider.ts`)

```ts
export interface DocChannel {
  send(type: 'doc.sync' | 'doc.awareness', payload: { docId: string; data: Uint8Array }): void
  subscribe(docId: string, handler: (type: 'doc.sync' | 'doc.awareness', data: Uint8Array) => void): () => void
}

export class EnvelopeYjsProvider extends Observable<'synced' | 'status'> {
  readonly awareness: awarenessProtocol.Awareness
  synced = false
  connected = false
  constructor(readonly docId: string, readonly doc: Y.Doc, private readonly channel: DocChannel, opts: { awareness?: awarenessProtocol.Awareness } = {}) {
    super()
    this.awareness = opts.awareness ?? new awarenessProtocol.Awareness(doc)
    doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
    this.unsubscribe = channel.subscribe(docId, this.onMessage)
  }
  connect() {                                    // on every (re)connect
    this.connected = true
    const enc = encoding.createEncoder()
    syncProtocol.writeSyncStep1(enc, this.doc)
    this.channel.send('doc.sync', { docId: this.docId, data: encoding.toUint8Array(enc) })
    if (this.awareness.getLocalState() !== null) this.sendAwareness([this.doc.clientID])
  }
  disconnect() {
    this.connected = false; this.synced = false
    const others = [...this.awareness.getStates().keys()].filter((c) => c !== this.doc.clientID)
    awarenessProtocol.removeAwarenessStates(this.awareness, others, this)
  }
  private onMessage = (type: DocWireType, data: Uint8Array) => {
    if (type === 'doc.sync') {
      const encoder = encoding.createEncoder()
      const msgType = syncProtocol.readSyncMessage(decoding.createDecoder(data), encoder, this.doc, this)
      if (encoding.length(encoder) > 0) this.channel.send('doc.sync', { docId: this.docId, data: encoding.toUint8Array(encoder) })
      if (msgType === syncProtocol.messageYjsSyncStep2 && !this.synced) { this.synced = true; this.emit('synced', [true]) }
    } else awarenessProtocol.applyAwarenessUpdate(this.awareness, data, this)
  }
  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || !this.connected) return      // offline edits go out via step1/step2 on connect()
    const enc = encoding.createEncoder(); syncProtocol.writeUpdate(enc, update)
    this.channel.send('doc.sync', { docId: this.docId, data: encoding.toUint8Array(enc) })
  }
  private onAwarenessUpdate = ({ added, updated, removed }: any, origin: unknown) => {
    if (origin === this || !this.connected) return
    const mine = [...added, ...updated, ...removed].filter((c: number) => c === this.doc.clientID)
    if (mine.length) this.sendAwareness(mine)
  }
  private sendAwareness(clients: number[]) {
    this.channel.send('doc.awareness', { docId: this.docId, data: awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients) })
  }
}
```

### (a') Daemon room: enforcement and agent presence (`src/daemon/DocRoom.ts`, abridged)

```ts
handleSync(connId: string, data: Uint8Array) {
  const { conn } = this.conns.get(connId)!
  const msgType = decoding.readVarUint(decoding.createDecoder(data))
  const carriesContent = msgType === syncProtocol.messageYjsSyncStep2 || msgType === syncProtocol.messageYjsUpdate
  if (carriesContent && conn.role === 'viewer') { this.onEvent({ type: 'rejected', connId, reason: 'viewer' }); return }
  const before = carriesContent && this.agentLock ? this.ytext.toString() : null
  let changed = false                                   // NOT state-vector based (delete-only edits)
  const spy = (_u: Uint8Array, origin: unknown) => { if (origin === conn) changed = true }
  this.doc.on('update', spy)
  const encoder = encoding.createEncoder()
  try { syncProtocol.readSyncMessage(decoding.createDecoder(data), encoder, this.doc, conn) } finally { this.doc.off('update', spy) }
  if (encoding.length(encoder) > 0) conn.send('doc.sync', { docId: this.docId, data: encoding.toUint8Array(encoder) })
  if (!carriesContent || !changed) return
  if (before !== null) {                                // agent lock held: accept-then-revert
    const after = this.ytext.toString()
    if (after !== before) applyDiskChange(this.ytext, after, before, 'lock-revert')
    this.onEvent({ type: 'rejected', connId, reason: 'agent-lock' }); return
  }
  this.onEvent({ type: 'human-edit', connId, userId: conn.user.userId })   // -> human edit lock + debounce
}
// constructor: doc 'update' -> writeUpdate to every conn !== origin; awareness 'update' -> encodeAwarenessUpdate to every conn !== origin
// handleAwareness: decode entries, drop clientIds not bound to this conn (or bound elsewhere / to an agent),
//   replace state with { selection: sanitize(state.selection), user: conn.user }, re-encode, applyAwarenessUpdate(hub, u, conn)

export class AgentPresence {                           // one per (file, agent session)
  private readonly dummy = new Y.Doc()                  // only for a unique clientID
  private readonly aw = new awarenessProtocol.Awareness(this.dummy)
  constructor(private readonly room: DocRoom, user: PresenceUser) {
    this.aw.on('update', ({ added, updated, removed }: any) => {
      const upd = awarenessProtocol.encodeAwarenessUpdate(this.aw, [...added, ...updated, ...removed])
      awarenessProtocol.applyAwarenessUpdate(this.room.awareness, upd, 'agent')   // hub broadcasts + snapshots it
    })
    this.aw.setLocalState({ user, selection: null })   // user = { name: 'Claude（Ian）', color: '#f59e0b', kind: 'agent', ... }
  }
  get clientId() { return this.dummy.clientID }
  setCursor(index: number | null) {
    if (index === null) { this.aw.setLocalStateField('selection', null); return }
    const rel = Y.createRelativePositionFromTypeIndex(this.room.ytext, index)
    this.aw.setLocalStateField('selection', { anchor: rel, head: rel })             // y-monaco's state shape
  }
  destroy() { this.aw.destroy(); this.dummy.destroy() } // destroy() publishes the removal
}
```

### Web binding (`web/src/CollabEditor.tsx`, abridged) and Vite config

```ts
const opened = await channel.request('doc.open', { path }, 'doc.opened')
const doc = new Y.Doc()
const provider = new EnvelopeYjsProvider(opened.docId, doc, channel)
provider.awareness.on('change', () => { style.textContent = presenceCss(provider.awareness.getStates(), doc.clientID) })
provider.on('synced', () => {
  const ytext = doc.getText('content')
  const model = monaco.editor.createModel(ytext.toString(), languageFor(path), monaco.Uri.parse('file:///' + path))
  model.setEOL(monaco.editor.EndOfLineSequence.LF)
  editor.setModel(model)
  binding = new MonacoBinding(ytext, model, new Set([editor]), provider.awareness)
  editor.updateOptions({ readOnly: roleReadOnly || !!agentLock,
    readOnlyMessage: { value: agentLock ? `${agentLock.holder} 正在修改，暫時無法編輯` : '唯讀' } })
})
provider.connect()
```

**[corrected]** Guard this handler so it binds only once per Y.Doc/epoch; a reconnect emits `synced` again (V6). Also pass `unusualLineTerminators: 'off'` and `unicodeHighlight.allowedLocales` to `monaco.editor.create`.

```ts
// web/vite.config.ts
resolve: {
  alias: [
    { find: /^monaco-editor\/esm\/vs\/(.*)$/, replacement: 'monaco-editor/$1' }, // y-monaco 0.1.6 vs monaco>=0.56 exports
    { find: '@monaco-setup', replacement: here(`./src/monaco-${variant}.ts`) },
  ],
  dedupe: ['yjs', 'y-protocols', 'lib0'],
}
```

### (b) `applyDiskChange` and `smartDiffer` (`src/applyDiskChange.ts`)

```ts
export function applyDiskChange(ytext: Y.Text, oldText: string, newText: string, origin: unknown, differ: Differ = smartDiffer): ApplyResult {
  const res: ApplyResult = { ops: 0, inserted: 0, deleted: 0, lastChangeEnd: null }
  if (oldText === newText) return res
  const doc = ytext.doc!
  if (ytext.toString() !== oldText) throw new Error('applyDiskChange: ytext diverged from oldText (use threeWayReconcile)')
  const diffs = differ(oldText, newText)
  doc.transact(() => {
    let index = 0
    for (const [op, str] of diffs) {
      if (!str.length) continue
      if (op === 0) index += str.length
      else if (op === -1) { ytext.delete(index, str.length); res.ops++; res.deleted += str.length; res.lastChangeEnd = index }
      else { ytext.insert(index, str); index += str.length; res.ops++; res.inserted += str.length; res.lastChangeEnd = index }
    }
  }, origin)
  return res
}

// smartDiffer = makeSmartDiffer({ charDiffLimit: 32K, lineTimeoutMs: 300, refineBlockLimit: 4K, refineBudgetMs: 150 })
//  1. common prefix/suffix; back off one unit if the cut would split a surrogate pair
//  2. middle <= 32K units  -> fastDiff(am, bm)
//  3. else diffArrays(splitKeepNewline(am), splitKeepNewline(bm), { timeout: 300 })
//       undefined (timeout)   -> [[-1, am], [1, bm]]
//       each changed block    -> fastDiff(del, ins) if <= 4K and within 150 ms budget, else [-1,del],[1,ins]
```

**[corrected] Use this differ instead** (`$VERIFY/verify/smartDiffer3.ts`; `applyDiskChange` is unchanged, pass it as `differ`):

```ts
export function makeSmartDiffer3({ charDiffLimit = 4096, lineTimeoutMs = 300, refineBudgetMs = 150 } = {}): Differ {
  return (a, b) => {
    // 1. surrogate-safe common prefix/suffix trim -> pre, suf, am, bm (same code as smartDiffer)
    // 2. am.length + bm.length <= charDiffLimit -> fastDiff(am, bm)   (worst case ~75 ms)
    // 3. else lineLevel(am, bm)
  }
  function lineLevel(a: string, b: string): DiffOp[] {
    const changes = diffArrays(splitKeepNewline(a), splitKeepNewline(b), { timeout: lineTimeoutMs })
    if (!changes) return [[-1, a], [1, b]]
    // for each changed block (dl = removed lines, il = added lines):
    //   out of budget / pure insert / pure delete     -> coarse [-1, del], [1, ins]
    //   del.length + ins.length <= charDiffLimit      -> fastDiff(del, ins)
    //   dl.length === il.length (formatter, reindent) -> fastDiff(dl[k], il[k]) per pair (each <= charDiffLimit), else coarse pair
    //   otherwise                                     -> coarse
  }
}
```

### (c) `threeWayReconcile` (`src/threeWayReconcile.ts` and `src/diff3.ts`)

```ts
export function threeWayReconcile(base: string, ours: string, theirs: string, timeoutMs = 500): ReconcileResult {
  if (theirs === base || theirs === ours) return { merged: ours, conflicts: [] }
  if (ours === base) return { merged: theirs, conflicts: [] }
  const b = base.split('\n'), o = ours.split('\n'), t = theirs.split('\n')     // exact round-trip (CRLF keeps '\r')
  // trim lines common to all three at both ends -> pre / suf
  const out: string[] = o.slice(0, pre)
  const conflicts: Conflict[] = []
  const regions = diff3Regions(oMid, bMid, tMid, timeoutMs)                 // (a=ours, o=base, b=theirs)
  if (regions === null) pushConflict(oMid, bMid, tMid, 0)                   // timeout: keep all human text
  else for (const r of regions) {
    if (r.stable) out.push(...r.lines)
    else if (r.a.length === r.b.length && r.a.every((l, k) => l === r.b[k])) out.push(...r.a) // same change
    else pushConflict(r.a, r.o, r.b, r.bStart)                              // keep ours; theirs -> panel
  }
  out.push(...o.slice(o.length - suf))
  return { merged: out.join('\n'), conflicts }
}
// diff3Regions: hunks = jsdiff diffArrays(o, a) + diffArrays(o, b) (each with timeout), sorted by oStart;
// hunks overlapping OR touching (start <= regionEnd) form one region; one-sided region -> that side's lines;
// two-sided -> unstable region with a/o/b slices mapped exactly like node-diff3's diff3MergeRegions.
```

Integration (`src/daemon/DiskSyncedDoc.ts`, abridged):

```ts
const ours = this.ytext.toString()
if (ours === this.base) { onApplied(applyDiskChange(this.ytext, ours, theirs, origin)); this.base = theirs; return }
const { merged, conflicts } = threeWayReconcile(this.base, ours, theirs)
onApplied(applyDiskChange(this.ytext, ours, merged, origin))
this.base = theirs
if (conflicts.length) onConflicts(conflicts)          // -> doc.conflict to clients
if (merged !== theirs) this.scheduleWrite()           // disk converges to merged
```

**[corrected]** While a human edit lock is held, use `lockBase` (the disk text when the lock was taken) in place of `this.base`, and take the 3-way path even when `ours === this.base` (V4).

### Atomic write (`src/daemon/atomicWrite.ts`)

```ts
export async function atomicWriteFile(target: string, data: Uint8Array): Promise<string> {
  let real = target; try { real = await realpath(target) } catch {}
  let mode = 0o644;  try { mode = (await stat(real)).mode & 0o7777 } catch {}
  const tmp = join(dirname(real), `.${basename(real)}.smurg-${randomBytes(6).toString('hex')}.tmp`)
  const fh = await open(tmp, 'wx', mode)
  try { await fh.writeFile(data); await fh.sync() } catch (e) { await fh.close().catch(() => {}); await unlink(tmp).catch(() => {}); throw e }
  await fh.close()
  await chmod(tmp, mode)
  await rename(tmp, real)
  return real
}
```

**[corrected]** Check `real` against the share right here, and before every read in `reconcileFromDiskLocked`, because a directory can be swapped for a symlink after `doc.open` (V2):

```ts
async function insideShare(p: string, realShare: string) {        // verified: no false positives for in-share
  let real: string                                                 // symlinks or not-yet-existing files
  try { real = await realpath(p) } catch { try { real = join(await realpath(dirname(p)), basename(p)) } catch { return false } }
  return real === realShare || real.startsWith(realShare + sep)
}
// reconcileFromDiskLocked / flush: if (!(await insideShare(this.path, realShare))) { this.unsupportedOnDisk = 'outside-share'; audit(); return }
// and never short-circuit on stat: always read + sha256 (about 3 ms for 5 MiB), see V3
```

### Watcher wiring (`server/dev-daemon.ts`)

```ts
const sub = await watcher.subscribe(realShare, (err, events) => {
  for (const e of events) open.get(relative(realShare, e.path))?.disk.onFsEvent()   // any type => re-check
}, { ignore: ['.git', 'node_modules', '.smurg', '**/*.smurg-*.tmp'] })
```

---

## 7. How to re-run the spike

```sh
cd /private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/yjs-monaco
npx -y pnpm@10 install            # if node_modules is missing (no global installs)
npx -y pnpm@10 test               # 86 vitest tests, about 40 s (one real-time awareness test)
npx -y pnpm@10 typecheck          # tsc --noEmit (TypeScript 7.0.2)
npx -y pnpm@10 build:web          # Vite 8 build, slim Monaco -> web/dist-slim
npx -y pnpm@10 build:web:full     # full Monaco (all language workers) -> web/dist-full
npx -y pnpm@10 e2e                # needs build:web first; system Google Chrome, headless; 18 checks; screenshots in e2e/screenshots
SIZES=64,256,1024,5120 npx -y pnpm@10 bench:diff   # diff libraries x scenarios (children killed after 30 s)
npx -y pnpm@10 bench:diff3        # node-diff3 vs threeWayReconcile (NODE_DIFF3_MAX=4000 by default)
npx -y pnpm@10 bench:ydoc         # Y.Doc cost for 1/5/20 MB texts
npx -y pnpm@10 watch:compare      # @parcel/watcher vs chokidar 5 vs fs.watch (creates and deletes .tmp/watchrepo)
npx -y pnpm@10 watch:spawn-fd-limit
NO_YMONACO_ALIAS=1 npx vite build --config web/vite.config.ts        # shows the y-monaco resolve failure
npx vite build --config web-plugin-test/vite.config.ts && npx tsx web-plugin-test/check.ts       # vite-plugin-monaco-editor 404s
npx vite build --config web-plugin-test/vite.zero.config.ts && npx tsx web-plugin-test/check.ts  # zero-config editor worker failure
# Manual try-out: build:web, then `PORT=8787 npx -y pnpm@10 dev:daemon` and open
# http://localhost:8787/?user=Amy and http://localhost:8787/?user=Bob. Simulate an agent with:
# curl -XPOST localhost:8787/__agent/edit -d '{"path":"hello.ts","find":"return","replace":"return /*agent*/","holdMs":3000}'
```

Layout:

- `src/` holds the modules: `applyDiskChange`, `threeWayReconcile`, `diff3`, `fileText`, `protocol`, `client/EnvelopeYjsProvider`, `daemon/{DocRoom,DiskSyncedDoc,atomicWrite}`.
- `test/` holds the vitest suites, plus `harness.ts`, an in-memory "network" with zod validation.
- `web/` is the Vite, React and Monaco app.
- `server/dev-daemon.ts` is the spike daemon (WebSocket JSON Envelopes, @parcel/watcher, and `/__agent/edit`).
- `e2e/`, `bench/` and `watch/` hold the scripts above.
- `web-plugin-test/` holds the rejected-integration checks.

---

## 8. Verification

The verifier worked independently and tried to refute every claim. `$VERIFY` = `/private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/yjs-monaco-verify`. It holds a copy of the spike sources (no `node_modules`, no build output) installed with `npx -y pnpm@10 install --frozen-lockfile`, plus the verifier's own files in `verify/` and `test-verify/`. Every version in §2 was installed exactly as listed.

### What was re-run and confirmed

| Claim | Result |
|---|---|
| 86 vitest tests | **86/86 pass** (40 s, including the 40 s real-time awareness test) |
| `tsc --noEmit` (TS 7.0.2) | exit 0; a planted type error is caught, so the check is not vacuous. It still passes with the verifier's files included. |
| Vite 8.3.1 slim/full builds, alias requirement (F16) | slim main chunk 4,258,900 B (1.09 MB gzip), `editor.worker` 304 KB, dist 5.2 MB; full 14 MB; without the alias: "Rolldown failed to resolve import `monaco-editor/esm/vs/editor/editor.api.js`". `monaco-editor/editor` re-exports `editor/editor.api.js`, the module y-monaco imports through the alias, so only one Monaco instance is bundled. |
| E2E, 18 checks (F20, F21) | **18/18 pass**; keystroke 0 ms, autosave debounce + 25 ms, revert of the bypass edit in 27 ms, CRLF probe A-D identical to the original |
| Zero-config Monaco fails for `editorWorkerService` (F18) | confirmed: language workers are emitted, `editor.worker` is not |
| `@monaco-editor/loader` 1.7.0 CDN default (F19) | confirmed in `lib/es/config/index.js` |
| Unicode matrix (F1-F3), cursor tests (F4), delete-only state vector (F5), duplication (F6) | confirmed. The emoji-dense fuzz (5,000 cases per differ, 5 differs) found no split surrogate pair and exact peer convergence for fast-diff, smartDiffer (both paths) and smartDiffer3 |
| node-diff3 vs threeWayReconcile (F8) | node-diff3 repetitive lines: 1k 151 ms, 2k 1.81 s, 4k 9.96 s; ours with 50k lines: 5-21 ms. `engines: {bun: ">=1.3.10"}` and `stringSeparator: /\s+/` confirmed in the source |
| threeWayReconcile semantics (F9) | 13 tests pass. **New property fuzz, 6,000 cases with CRLF and missing trailing newlines:** every human-added line survives in order; every agent-added line is in `merged` or in a conflict; `mergedStartLine/EndLine` slice exactly the kept text; `theirsStartLine` points at the agent's text. **Differential vs `git merge-file` (1,500 cases):** 632/633 identical when both are clean; 30 cases where git is clean but ours conflicts (conservative); 3 where ours is clean but git conflicts (ambiguous repeated-line alignments, no line lost) |
| Provider/DocRoom behaviours (F10, F11) | confirmed; `lib0/time.js` `getUnixTime = Date.now`, y-protocols 30 s timeout with 15 s renewal, and `Awareness` constructor `setLocalState({})` confirmed in the source |
| Atomic write (F12) | 0 torn reads in 5,240; plain `writeFile` 1,013 torn in 1,420 |
| Own-write echo with the real watcher (F13) | 21 echoes, 1 external change, on **APFS** (see V3 for other filesystems) |
| `classifyBytes` (F15) | 9 tests pass |
| Watchers (F22) | re-run: parcel +1.0 MB, 0/1220 missed, atomic save = `create`; chokidar 1,039 ms startup, **22,013 fds, EBADF, +320 MB**; fs.watch 3,001 node_modules events reached JS. Spawn gives EBADF at 10,230 held fds and is ok at 10,000 |
| Y.Doc cost (F23) | 1/5/20 MB: 1.03/5.17/20.67 MB payload, encode 2/9/34 ms, apply 2/11/42 ms |
| y-monaco `destroy()` leak, no name rendering | confirmed in `y-monaco/src/y-monaco.js`: `onDidChangeCursorSelection` is never disposed |

### Corrected (with evidence)

| # | Claim in the original | Finding | Evidence (`$VERIFY`) |
|---|---|---|---|
| V1 | smartDiffer is exact and bounded, worst case ~330 ms; cursors stay put | Exact: yes. Bounded: **no**. The ≤ 32 K-unit middle goes to unbounded fast-diff: 865 ms at 12 K units, **1,366 ms** for a 15.5 K code rewrite, 2.6 s for random text. A formatter rewrite of an 18 K-unit file is replaced coarsely, so the **cursor jumps to the file start**. `smartDiffer3` bounds all of these (42 ms, ~0.5 s worst case at 5 MB) and keeps the cursor. | `npx tsx verify/smart-worst.ts` (`V3=1` for smartDiffer3); `test-verify/differ-fuzz.test.ts` |
| V2 | Paths are checked at `doc.open`; `atomicWriteFile` realpaths "so a symlink stays a symlink" | **Security hole.** After a parent directory is swapped for a symlink, the next watcher event loads an outside file (a fake key) into the shared Y.Doc, and the next autosave writes outside the share. A per-operation containment check detects both, with no false positives on in-share symlinks or new files. | `test-verify/symlink-escape.test.ts` (3 tests; fake files only) |
| V3 | Stat-equal means own echo; "the hash fallback covers coarse mtimes" | **Wrong.** On real HFS+ (1 s) and FAT32 (2 s) images, a same-size in-place write right after our own write is ignored, and the next autosave **silently overwrites it**. Always hashing fixes it; read + sha256 of 5 MiB takes 2.6-3.1 ms. APFS: 0/2,000 mtime collisions. | `sh verify/coarse-fs.sh up && npx vitest run --config vitest.verify.config.ts test-verify/coarse-mtime.test.ts; sh verify/coarse-fs.sh down`; `npx tsx verify/mtime-granularity.ts` |
| V4 | 3-way with `base` = last synced version protects the human's text (R8) | Only for text newer than the debounce. Autosaved human text is removed with **0 conflicts** by a Bash write built from a stale copy. A `lockBase` held for the duration of the human edit lock fixes the scenarios tested. | `test-verify/saved-human-text.test.ts` |
| V5 | Awareness is decoded, validated and re-encoded | `selection` is not really validated. 6 of 10 hand-made payloads that pass `sanitizeSelection` make Yjs throw. In Chrome, Bob gets "Caught error while handling a Yjs update" on every later update; text still converges. A strict zod schema plus `Y.createRelativePositionFromJSON` normalization rejects all of them; 1,972 fuzz payloads it accepts never throw. | `npx tsx verify/relpos-probe.ts`; `test-verify/awareness-sanitize.test.ts`; `npx tsx verify/browser-probes.ts` (P1) |
| V6 | Binding sketch; LF normalization covers EOL problems | Reconnect then second `synced` gives "ModelService: Cannot add model because it already exists!". A CR-only file gets a CRLF model (18 vs 21 units) and an edit lands at the wrong offset (`!#REND` vs `!END#R`). A single stray CR is benign. | `verify/browser-probes.ts` (P2, P3) |
| V7 | (not covered) | Monaco default `unusualLineTerminators: 'prompt'` gives a `window.confirm` on **every** client for a file with U+2028; accepting it rewrites the file. | `verify/browser-probes.ts` (P4); `editorOptions.js` default `'prompt'` |
| V8 | vite-plugin-monaco-editor workers are never emitted with Vite 8 | They are emitted; the spike's **absolute `outDir`** plus the plugin's `path.join(root, outDir, …)` put them under `web-plugin-test/private/tmp/...`. With `outDir: 'dist'`: HTTP 200 for both worker bundles. Still rejected, for other reasons (Q2). | `npx vite build --config web-plugin-test/vite.rel.config.ts && npx tsx web-plugin-test/check2.ts` |
| V9 | Claude Code's write method unverified | Verified with the real `claude` 2.1.220 and a mock Messages API (no quota, temp HOME/CLAUDE_CONFIG_DIR). Edit and Write use tmp `<name>.tmp.<pid>.<12hex>` + rename: new inode, hard link broken, mode/CRLF/BOM kept. Watcher: `create f` + `delete f.tmp.…`. Edit through a symlink returns "Refusing to write through symlink". | `node verify/claude-write-mode.mjs` |
| V10 | `getEventsSince` unverified | Works on macOS (22-43 ms). Returns update/create/delete as expected, excludes ignored dirs, and adds an `update` for the root dir. | `node verify/parcel-snapshot.mjs` |
| V11 | Browser performance with multi-MB files unverified | 5 MB: open + bind 0.41-0.46 s, 86 MB heap, keystroke to peer 12-29 ms, agent edit to peer 99 ms (headless Chrome, localhost) | `npx tsx verify/browser-bigfile.ts` |
| V12 | Keystroke updates are 3-36 bytes | A keystroke is 29-32 bytes and a backspace 13; 3 and 4 bytes are the handshake | `npx tsx verify/keystroke-size.ts` |
| V13 | E2E "editor.worker loaded as a module worker" | The built worker is a classic IIFE worker (`new Worker(url, {name})`) | `grep -o 'new Worker(…' web/dist-slim/assets/index-*.js` |

All verifier tests: `npx vitest run --config vitest.verify.config.ts` gives **17 passed, 2 skipped**. The 2 skipped are the HFS+/FAT cases, which run once `verify/coarse-fs.sh up` has mounted the images; all 3 cases passed when mounted. No background processes, mounts or listeners were left running.

### Recommendation after verification

The architecture and library choices hold:
- a y-protocols provider over `doc.sync`/`doc.awareness`;
- the DocRoom as the only fan-out point, with viewer drop, accept-then-revert and agent presence on its own `Awareness`;
- the epoch check;
- LF-normalized Y.Text;
- Monaco 0.57 ESM slim with `?worker` and the y-monaco alias;
- a jsdiff-based line diff3;
- tmp+fsync+rename writes;
- @parcel/watcher.

Build them with these changes, each verified above:
1. Re-check share containment before every disk read and write (V2).
2. Always hash on watcher events and before writing (V3).
3. Use `smartDiffer3` (V1).
4. Merge against `lockBase` while a human edit lock is held (V4).
5. Validate awareness selections with a strict schema (V5).
6. Bind once per epoch (V6).
7. Normalize `\r\n?` (V6).
8. Set `unusualLineTerminators: 'off'` (V7).
9. Filter Claude Code's `*.tmp.<pid>.<hex>` files from the tree and feed (V9).

### Still unverified

- Linux: inotify backend, ext4 coarse timestamps, Ubuntu 24.04. Colima/Docker were installed but not running; starting a VM would write under `~/.colima`, so it was not done.
- Safari and Firefox. Playwright has no other browsers installed, and `safaridriver --enable` changes system settings.
- The real Noise channel and relay.
- Node SEA packaging of the watcher binary.
- Long editing sessions.
- The `lockBase` lifecycle wired end to end.
- The residual TOCTOU windows (pre-write stat vs rename; containment check vs open).
