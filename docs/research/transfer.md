# Research: streaming resumable upload, download and zip over the encrypted channel

Scope: SPEC R7 (upload/download bullets and acceptance criteria), D15, 7.1 (separate transfer Durable Object),
7.2 (Envelope), and ARCHITECTURE §4.3 ("binary encoding decided in transfer.md") and §5.2 (`file.upload.*`, `file.download.*`).

Spike (runnable): `/private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/transfer`
(`SPIKE` below). Date: 2026-09-27. Machine: macOS 26.5.1 arm64 (APFS, case-insensitive), Node v25.4.0 and v22.22.1,
headless Chromium 145.0.7632.6 driven through gstack `browse`, Apple `unzip` 6.00 (ZIP64_SUPPORT, SYMLINKS).

The encrypted channel itself (Noise, framing, 9 MiB reassembly cap) is `docs/research/noise.md`. This spike runs the
transfer protocol over a plain WebSocket: the Noise layer is orthogonal (one app message = one Noise DATA frame).

> **Independently verified on 2026-09-28.** The spike was re-run from a fresh `npm ci` in `…/scratchpad/spikes/transfer-verify`,
> and new checks were added under `transfer-verify/verify/` (re-run: `sh verify/run-verify.sh`). The new checks ran in
> Chrome 153, WebKit 26.6 and Firefox 155 with persistent profiles, on case-sensitive APFS and ExFAT disk images, and
> with the Java, Python, bsdtar and ditto zip readers. The core recommendation holds: msgpack envelopes, the
> bitmap-resumable upload with per-chunk hashes, yazl through our own walker, and OPFS as the Firefox/Safari fallback.
> Several statements were wrong or incomplete. Each is marked **[Corrected]** inline, and the evidence is in
> **## Verification** at the end. Short version:
> - The spike's disk check double-counts a resumed upload.
> - Concurrent first chunks after a daemon restart lose bitmap bits.
> - The no-clobber `link()` commit fails on ExFAT.
> - The walker aborts the whole zip if a file disappears mid-walk.
> - `ditto` (Apple's zip extractor) fails on yazl ZIP64 archives.
> - The OPFS silent-write failure is triggered by the quota, not by a fixed 256 MiB cap.

---

## 1. Recommendation

### 1.1 Envelope encoding for the whole protocol: MessagePack (`@msgpack/msgpack`)

Every decrypted app message is one MessagePack map `{type, id, seq, payload}`. Every binary field anywhere in a
payload (`data`, `hash`, `syncStep1`, `exec.output.data`, `doc.sync.data`, ...) is a msgpack `bin` and decodes to a
`Uint8Array`. zod validates it with `z.instanceof(Uint8Array)`. No base64 anywhere, no second framing layer.

```ts
const encoder = new Encoder({ ignoreUndefined: true });           // undefined fields dropped, not turned into null
const decoder = new Decoder({ maxBinLength: 9 << 20, maxStrLength: 1 << 20, maxArrayLength: 1_000_000, maxMapLength: 10_000 });
```

Why (measured, `src/codec-bench.mjs`, 4 MiB chunk envelope):

| Codec | Overhead on a 4 MiB chunk | Encode / decode 4 MiB | exec.output (200 B) size | small enc+dec | Decoded bytes type | `__proto__` key |
|---|---|---|---|---|---|---|
| JSON + base64 | **+1,398,321 B (33.3 %)** | 5.46 / 2.98 ms | 387 B | 4.2 µs | copy | n/a |
| JSON header + raw attachments (custom) | +223 B | 0.28 / 0.01 ms | 328 B | 4.2 µs | zero-copy view | n/a |
| **@msgpack/msgpack 3.1.3** | **+156 B (0.004 %)** | 0.30 / 0.01 ms | **281 B** | **1.3 µs** | **zero-copy `Uint8Array`** | **throws** |
| msgpackr 2.1.0 | +160 B | 0.32 / 0.02 ms | 285 B | 1.2 µs | `Buffer` in Node | renamed to `__proto_` |
| cbor-x 1.6.6 | +160 B | 0.19 / 0.00 ms | 285 B | 1.4 µs | `Buffer` in Node | renamed |

- The three binary codecs are equivalent on size and speed. `@msgpack/msgpack` wins on the things that matter for a
  security-sensitive shared protocol package: it is the reference implementation, it decodes to plain `Uint8Array` in
  both Node and the browser (msgpackr/cbor-x give `Buffer` in Node, so types differ between daemon and web), it
  **rejects** a `__proto__` key instead of silently renaming it, it has per-type length limits, and it is the smallest
  in the browser (**5.9 KiB gzip** vs 10.5 / 10.8 KiB, esbuild minified).
- The custom "JSON header + attachments" frame is as cheap for one big blob, but it is a second framing format to
  specify and fuzz, it is 3x slower for the many small messages (typing, awareness, terminal), and it still needs
  a rule for messages with several byte fields. MessagePack gives all of that for free.
- Total on-wire overhead for a 4 MiB upload chunk = 156 B envelope + Noise framing (65 records x 19 B + 1 = 1,236 B,
  from the noise.md formula) = **~0.03 %**.
- **[Added] Zero-copy has a contract.** A decoded `bin` is a view on the buffer passed to `decode()`. If the Noise
  `Opener` decrypts into a reused scratch buffer, every earlier message's `data` silently changes: `[1,2,3]` became
  `[0,0,0]` after reuse in `verify/codec-edge.mjs`. The channel must hand `decode()` a fresh buffer per message, or
  the receiver must copy anything it keeps.
- zod 4's `.int()` already rejects integers beyond ±(2^53−1) (verified: `2**53` fails), so the explicit
  `.max(Number.MAX_SAFE_INTEGER)` is redundant but harmless.

### 1.2 Transfer connection

- Uploads and downloads use their own WebSocket to the **TransferDO** (SPEC 7.1), with **their own Noise session**
  (noise.md gotcha 6). In the browser that connection lives in a **dedicated Worker** (File objects are structured-
  cloneable into a Worker, verified), so hashing and encryption never touch the UI thread (main-thread timer drift
  stayed <= 12 ms during a 10 GiB upload).
- The generic `seq` resume/outbox (ARCHITECTURE §4) must be **disabled for the transfer channel**: re-sending 4 MiB
  chunks from an outbox would pin memory. Uploads resume from the daemon's chunk bitmap; downloads restart
  (zip) or resume by offset (single file). `seq` still increments.
- Chunk size: **4 MiB default** (`PublicSettings.uploadChunkSize`), accepted range 1–8 MiB (SPEC: <= 32 MiB relay
  limit, 4–8 MiB suggested). Fits the 9 MiB Noise reassembly cap with room for the envelope.
- **Flow control: an ack window of 4 chunks per transfer (<= 16 MiB in flight) plus a `ws.bufferedAmount <= 8 MiB`
  guard, polled every 5 ms** (WebSocket has no drain event). The window is what protects the relay DO and the
  daemon; `bufferedAmount` only sees the local socket. Measured in Chromium with a ~45 MiB/s link:
  with both guards the whole browser peaked at 375 MiB RSS and `bufferedAmount` <= 11.5 MB; with neither,
  `bufferedAmount` reached **824 MB** and the renderer **740 MiB**, at the same throughput (§3 F18–F19).

### 1.3 Upload message sequence (transfer channel)

```
c→d file.upload.plan    { root, entries:[{path, kind:'file'|'dir', size?}], onConflict:'fail'|'overwrite'|'rename' }   (folder drop only)
d→c   .ok               { accepted:[{path, targetPath}], errors:[{path, code, message}], totalBytes, disk:{availBytes, reserve, maxUploadNow} }
                         daemon validates every path (§1.8), detects collisions, runs ONE disk check for the batch, creates all dirs (incl. empty ones)
c→d file.upload.begin   { root, path, size, chunkSize, lastModified, uploadId?, wantHashes?, onConflict? }
d→c   .ok               { uploadId, chunkSize, chunkCount, have: bytes(bitmap), received, resumed, hashes?: bytes(32*chunkCount) }
      or error          insufficient_disk | bad_path | path_denied | conflict | locked | forbidden
c→d file.upload.chunk   { uploadId, index, hash: bytes32 (SHA-256 of data), data: bytes }      ≤ 4 unacked per upload
d→c   .ok               { index, duplicate? }         or error hash_mismatch | insufficient_disk | bad_request
c→d file.upload.commit  { uploadId, rootHash: bytes32 }
d→c   .ok               { entry: FileEntry, root }    or error incomplete | hash_mismatch | conflict | locked
c→d file.upload.abort   { uploadId }                  (cancel button; also done by the daemon on kick / TTL)
```

- `rootHash = SHA-256( u64be(size) || u32be(chunkSize) || h0 || h1 || … || h(n-1) )` (hash list). The browser cannot
  compute a streaming whole-file SHA-256 with WebCrypto (`digest()` is one-shot), and the list root is free because
  every chunk is hashed anyway. The daemon checks each chunk hash on arrival and the root at commit.
- **Resume after reconnect** (same page): `begin` with the same `uploadId` → bitmap → send only missing chunks.
  Hashes of already-sent chunks are in memory (80 KiB for 10 GiB).
- **Resume after page reload / new client process**: the user re-selects the file (Chromium: or a stored
  `FileSystemFileHandle`); `begin` matches by identity `(userId, root, path, size, lastModified, chunkSize)` or by the
  saved `uploadId`; the client asks `wantHashes`, re-hashes the already-received chunks **locally** (no upload) and
  compares; any mismatch → `abort` + fresh upload. A changed `lastModified` never matches (new upload).
- **Resume after daemon restart**: state is on disk (§1.4); verified by SIGKILLing the daemon mid-upload.
- **[Added] `hashes` has a size limit.** It is 32 B × chunkCount. At 4 MiB chunks that is 8 MiB for 1 TiB and
  16 MiB for 2 TiB, which exceeds the 9 MiB `maxBinLength`, so `begin.ok` cannot be decoded (verified: "Max length
  exceeded"). D15 sets no upload limit, so page it: `wantHashes: { from, count }` with at most 131,072 hashes
  (4 MiB) per reply.
- Small files in a folder drop: pipeline several `begin/chunk/commit` sequences concurrently (e.g. 4 files, <= 16 MiB
  in flight overall) so 1,000 small files are not 3,000 sequential round trips through the relay.

### 1.4 Daemon receiver (`UploadStore`, `src/upload-store.mjs`)

```
~/.smurg/workspaces/<ws>/uploads/            0700
  <uploadId>.json   manifest, written once (write tmp + fsync + rename), 0600
  <uploadId>.log    journal: one line "<index> <sha256hex>\n" per durable chunk, append-only, 0600
  <uploadId>.part   data, positional writes, 0600
```

- Per chunk: validate length (last chunk shorter) → `sha256(data) == hash` → `pwrite(offset = index*chunkSize)` →
  **`fdatasync`** → append journal line → ack. A journal line therefore always implies durable data; a lost line only
  causes a re-send. `fdatasync` per 4 MiB still gives 400 MiB/s here, far above any relay throughput.
  A torn last journal line (crash mid-append) fails the line regex and is ignored.
- Duplicate chunk (retransmit after reconnect) is idempotent; the same index with a different hash is `conflict`.
  (Two copies of the same index arriving *concurrently* are both written and journaled. That is harmless but not
  deduplicated, verified.)
- **[Corrected] Memoize the load.** `#load(id)` must cache the in-flight promise, not only the finished state. In
  the spike, two chunks for an upload that is not loaded yet (after a daemon restart, if the client pipelines
  without waiting for `begin.ok`) each open their own fd pair and bitmap. One bitmap is then discarded, and commit
  answers `incomplete` (verified: `verify/store-edge.test.mjs`). With a `#loading` promise map, commit succeeds
  (`verify/upload-store-fixed.mjs`). The daemon should also reject `chunk` for an upload this connection has not
  `begin`-ed.
- Commit: all bits set, `stat(part).size == size`, hash-list root equal → `fsync` → `chmod(0666 & ~umask)` (never
  leave the 0600 staging mode on a shared file) → PathGuard again (the tree may have changed) → mkdir parents →
  **`link(part, dest)` + `unlink(part)`** for no-clobber (atomic `EEXIST` if something appeared since `begin`) or
  **`rename(part, dest)`** for overwrite → fsync the directory → delete manifest + journal → audit `file.upload`.
  No full re-read at commit: chunk hashes were verified against the in-memory data that was written, and the
  fsync-before-journal order covers crashes.
  *(Verifier note, not tested)* The PathGuard re-resolve and the later `link()`/`rename()` are separate lookups by
  path, so a parent directory that a guest process can modify may change between them. This is the TOCTOU window
  that ARCHITECTURE §7.4 describes for reads, here on the write side. Whoever owns PathGuard should pick one
  post-move check for all writes, e.g. confirming the final parent is still inside the root and the inode is the
  one staged. Upload should use that check, not a special case.
- Staging location: `~/.smurg/...` as ARCHITECTURE §7.1 says, **when `stat(stateDir).dev == stat(targetDir).dev`**
  (true here: home, `/private/tmp` and the project are one APFS volume). If not (project on an external disk),
  `rename`/`link` fail with `EXDEV`: stage in `<workspace>/.smurg/uploads/` instead (same volume, already
  excluded from git, hidden from the tree/watcher). **[Corrected]** This is now verified with mounted disk images.
  `st.dev` differs from home, and `link`/`rename` from home-volume staging give `EXDEV` on both case-sensitive APFS
  and ExFAT. Workspace-local staging commits fine on APFS. That staging dir holds other users' in-progress uploads,
  so add it to the guests' srt **deny-read and deny-write** lists. On Linux, also keep `EXDEV` as a runtime fallback:
  bind mounts share `st.dev`, but `rename()` across mount points still fails (from the man page; not run here).
- **[Corrected] No-clobber commit on filesystems without hard links.** On ExFAT (typical USB/external disks),
  `link()` fails with `ENOTSUP`, so the spike's no-clobber commit fails there (verified: `verify/volumes.mjs`).
  Fallback when `link()` gives `ENOTSUP`/`EPERM`: `open(dest, 'wx')` as a placeholder, then `rename(part, dest)`.
  This was verified on ExFAT and APFS. It is not atomic against a writer that opens the placeholder in between, but
  it still refuses an existing file. ExFAT also ignores `chmod`: staging files show 0700, not 0600.
- Overwriting a file that has a human edit lock or an agent lock (R8) → `locked`. Otherwise the watcher sees the
  rename; the upload module records `(path, ino)` before renaming so the change is attributed to the uploader and
  an open Y.Doc reconciles it like any external change.
- Cleanup: `sweep()` at daemon start and hourly removes uploads whose journal/manifest mtime is older than a TTL
  (**48 h** default, setting) plus orphan `.part/.log` files; `abort` on client cancel; abort all of a member's
  uploads on kick. Keep partials across `smurg stop` (that is what makes resume-after-restart work).
- `ENOSPC` during a write → `insufficient_disk` error, partial kept, the client pauses.

### 1.5 Disk-space check (R7, D15)

```
total     = blocks × bsize                      (fs.statfs(path, {bigint:true}); bsize is the unit of blocks/bavail)
avail     = bavail × bsize                      (what an unprivileged process may use; excludes root-reserved blocks)
reserve   = max(diskReserveBytes, diskReservePercent% × total)          defaults 5 GiB, 5 %  (HostSettings)
freeAfter = avail − pendingBytes(other active uploads on the same volume) − remainingBytes(this upload)
accept   ⇔ freeAfter ≥ reserve
```

- Run at `plan` (whole batch) and at every `begin`, **including resumes** (with only the missing bytes). statfs the
  deepest existing ancestor of the target (the file does not exist yet). If staging is on another volume, check both.
- **[Corrected] Exclude the upload being checked from `pendingBytes`.** In the spike, `begin` loads the resumed upload
  into `open` *before* calling `diskCheck`, and daemon-sim adds `store.pendingBytes()`, which already contains this
  upload's remaining bytes. A resume is charged twice: 6 MiB instead of 3 MiB in `verify/store-edge.test.mjs`, so a
  resume that fits can be refused. The fix is `pendingBytes(excludeUploadId)` (verified). Filter it to uploads on the
  same volume too; the spike sums all of them.
- SPEC says "5 GB"; the default here is 5 GiB (5.37 GB), which is slightly stricter. Either is fine; state the unit
  in the setting.
- On this machine right now: `blocks=120699413 bsize=4096` → total 460.43 GiB; 5 % = **23.02 GiB > 5 GiB**, so the
  reserve is 23.02 GiB; `bavail=7607202` → avail 29.02 GiB → **largest acceptable upload 6.00 GiB**. A 10 GiB upload
  is rejected before the first byte on this very laptop. The percent rule dominates on any disk > 100 GiB, so
  the rejection message must show the numbers and point the host to the setting.
- Also check again cheaply per chunk? Not needed: `ENOSPC` is handled, and the reservation (`pendingBytes`) stops
  two concurrent uploads from both passing the same check.

### 1.6 Download

- **Single file:** `file.download.begin { file, offset?, ifMatch? }` → `meta { downloadId, size, etag }` → `chunk { index,
  offset, data }` with the same 4-chunk credit window (`file.download.ack { downloadId, index }`) → `end { bytes }`.
  Resume by `offset` + `ifMatch` (etag = size + mtimeNs + ino); a changed file answers `conflict`.
- **Folder:** `file.download.begin { dir, format:'zip' }` → daemon streams a zip built by **yazl 3.3.1** through our own
  walker (`src/zip-folder.mjs`), pulled chunk by chunk as credits arrive (natural stream backpressure). Not
  resumable in the prototype (restart). `end` carries `skipped: [{path, reason}]` for the UI.
- Walker rules (all verified): lstat semantics, sorted DFS; regular files opened lazily with
  `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and re-checked with `fstat` (same inode, still a regular file); size **not** declared
  to yazl (a file that grows while zipped is stored as read instead of aborting the whole zip); explicit entries for
  empty dirs; symlinks stored as symlink entries (`mode 0120777`, data = link text) **only** if the link text is
  relative and resolves inside the zipped folder, otherwise skipped and reported; FIFOs/sockets/devices skipped;
  `.smurg` excluded at the workspace root; deflate level 6 except already-compressed extensions (stored).
- **[Corrected] Walker robustness** (verified, `verify/walker-vanish.mjs`):
  - A file deleted between `readdir()` and the walker's `lstat()` makes the generator throw `ENOENT`, which aborts
    the **whole** zip. Agents create and delete temp files constantly. Catch `ENOENT`/`ENOTDIR` per entry and report
    it in `skipped[]`.
  - A file that fails the lazy open is **not omitted**. It stays in the zip as a **0-byte entry** (the name is
    already committed to yazl) and is listed in `skipped[]` as `open:ENOENT`. The UI must say so: the extracted file
    will be empty.
- **[Corrected] ZIP64 vs Apple's extractor** (verified, `verify/ditto-zip64.mjs`, `verify/zip-readers.mjs`). yazl never
  writes a ZIP64 extra field in *local* headers; sizes live only in the 24-byte data descriptor and the central
  directory.
  - **`ditto -x -k`** (Apple's CLI extractor; Archive Utility itself was not driven) **exits 1 with "Couldn't
    read pkzip signature"** on any archive that needs ZIP64 for sizes or offsets. Entries *before* and including a
    > 4 GiB entry are extracted correctly; **entries after it are lost**. Offsets > 4 GiB with every entry < 4 GiB
    extract completely but still exit 1.
  - A ZIP64 EOCD needed only for 70,000 entries extracts cleanly (exit 0).
  - Info-ZIP `unzip`, Python `zipfile`, and `bsdtar` (seekable and streaming from a pipe) extract all of these
    correctly.
  - Java `ZipInputStream` rejects any *stored* entry that uses a data descriptor ("only DEFLATED entries can have
    EXT descriptor"), and yazl lazy streams always use one.

  Prototype rule: the walker **defers regular files ≥ 4 GiB − 1 to the end of the zip**. `end` flags
  `zip64: true` so the UI can tell macOS users that the Finder may report an error after extracting everything,
  and it offers single-file downloads for those files. Switching libraries does not help: compress-commons, used by
  archiver and zip-stream, also omits the local ZIP64 extra field (source read). fflate has no ZIP64 at all.
- Why yazl and not the others (all run on the same 1,000-file fixture, §3 F24–F31):
  - **archiver 8.0.0** `directory()` **hangs forever on a FIFO**, stores escaping and absolute symlinks as-is
    (`link-escape → ../../outside-secret.txt`, `link-absolute → /etc/hosts`), and writes UTC into the DOS time fields
    (every mtime **8 h off** after extraction here, UTC+8; its `forceLocalTime` option exists but is off).
  - **zip-stream 7.0.5** (archiver's engine), driven by our walker: correct content, same 8 h mtime shift.
  - **fflate 0.8.3**: **no ZIP64 writer**. 70,000 entries → EOCD says 4,464 (strict readers like yauzl list 4,464);
    a 4.5 GiB entry is written with size 512 MiB (mod 2^32) and no error. It also throws for pre-1980 mtimes.
  - **yazl**: ZIP64 automatic (verified > 65,535 entries and a 4.5 GiB entry at offsets > 4 GiB), streams with flat
    memory. Limitations: timestamp precision (below), and **[Corrected]** Apple's `ditto` cannot fully read its
    ZIP64 size/offset layout (see "ZIP64 vs Apple's extractor" above).

### 1.7 Saving a large download in the browser

Pragmatic prototype, in this order:

1. **Chromium-family (Chrome/Edge, desktop):** `showSaveFilePicker()` (must be called in the click handler, before any
   await) → `createWritable()` → write each chunk at its offset → `close()`. Streams straight to the user's file,
   no double disk use. Present in headless Chromium 145; the picker itself cannot be driven headless (unverified).
2. **Firefox / Safari (no `showSaveFilePicker`):** stage into **OPFS from the transfer Worker** with
   `createSyncAccessHandle()` (Worker-only; `false` on the main thread, verified), then `getFile()` →
   `URL.createObjectURL(file)` → `<a download>`. The OPFS file is disk-backed in a normal profile, so the blob is not
   in RAM. Limits: needs 2x the size on disk while the browser copies it to Downloads; bounded by the origin quota
   (`navigator.storage.estimate()`, check it before starting and fail with a clear message); delete the OPFS copy on
   the next app start (we cannot observe when the browser's copy finished). **Check every `write()` return value
   and the final `getSize()`**: when the quota runs out, headless Chromium 145 did not throw. `write()` returned
   4294967288 and the file stopped growing (§3 F37).
   **[Corrected / verified]** The whole path works with persistent (normal, non-incognito) profiles in Chrome 153,
   WebKit 26.6 and Firefox 155 (Playwright builds, not the shipping Safari).
   - `createSyncAccessHandle` exists in a Worker (not on the main thread) in all three.
   - 1 GiB was written with 0 short writes.
   - `<a download>` of the blob URL saved the correct 1 GiB file (content spot-checked).
   - The browser trees' RSS stayed flat: Chrome 654–681 MiB, WebKit content process ≤ 416 MiB, Firefox ≤ 1.2 GiB.

   Quotas reported on this machine (about 22 GiB free): Chrome 10 GiB, Firefox 10 GiB, WebKit 20.6 GB. That is the
   real ceiling for this fallback. The silent short write was reproduced **only at quota exhaustion**: with an
   875 MB quota the file stopped at 512 MiB. It is not a fixed 256 MiB off-the-record cap. A re-run of the original
   harness wrote 512 MiB cleanly with a 973 MB quota.
3. **Neither available, or quota too small:** for files < 512 MiB assemble a `Blob` from the chunks; above that, tell the
   user to use Chrome or `smurg` CLI.

Not recommended for the prototype: the StreamSaver pattern (page transfers a `ReadableStream` to a service worker,
which answers a navigation with `Content-Disposition: attachment`). The mechanism works in Chromium (1 GiB through it
in 0.69 s, §3 F38), but it needs SW lifecycle handling and keep-alive, and Safari/Firefox behaviour of downloads fed
by SW streams was not verifiable here. Revisit if OPFS limits bite.

### 1.8 Path safety for uploads (`src/path-safety.mjs`)

Lexical layer that runs before `PathGuard` (which still does realpath/symlink checks on the joined path):

- Reject: non-string, empty, > 4096 chars, C0 controls/NUL/DEL, Unicode bidi overrides (U+202A–202E, U+2066–2069),
  backslash, drive letters, absolute paths (a single leading `/` is stripped only for `FileSystemEntry.fullPath`), empty
  segments (`//`, trailing `/`), `.` and `..`, lone surrogates, first segment exactly `.git` or `.smurg`.
- Normalise to **NFC**. Browsers pass names through as stored: `<input webkitdirectory>` returned
  `proj/café.txt` (NFD) for an NFD file on APFS (verified).
- Segment length: Linux counts **255 bytes**, APFS counts **255 UTF-16 units** (255 × `中` = 765 bytes is accepted,
  verified). Check against the host platform, or long CJK names break on macOS hosts for no reason.
- Collisions are computed on a key = NFC (+ case fold when the target volume is case-insensitive). Detect the volume's
  case sensitivity without writing: `lstat` the root with the case of its last alphabetic component swapped and
  compare `(dev, ino)`. (Probe verified correct on case-insensitive APFS, case-sensitive APFS and ExFAT images.)
- **[Corrected] The key is an approximation, not the filesystem's rule** (verified, `verify/casefold.mjs`).
  - On case-insensitive APFS, `ß`/`ẞ` are the same file but get different keys, so the collision is missed. Dotless
    `ı` vs `I`/`i` are different files but get the same key, so a false conflict is raised.
  - ExFAT (a simple upcase table) disagrees with the key on 8 of 16 pairs: `ß`/`ss`, `ﬁ`/`fi`, Å/Ångström sign,
    and others.
  - Case-sensitive APFS agrees on all pairs.

  Consequence: the planner's key only catches the common cases (ASCII case, NFC/NFD). The commit must stay the
  final arbiter: no-clobber `link()`, or the `wx` fallback, gets `EEXIST` from the filesystem itself. Resolve
  existing names by asking the filesystem (lstat the candidate, match the inode in `readdir`) rather than trusting
  the key.
- Case-sensitive APFS is still **normalisation-insensitive**: an NFC twin of an NFD name gives `EEXIST` (verified).
  So NFC/NFD twins can only happen on Linux filesystems.
- Resolve each component against the existing directory listing by that key and **reuse the on-disk spelling**
  (an existing NFD `café/` receives `café/menu.txt`; on Linux, where NFC and NFD are different names, this avoids
  creating a visually identical twin).
- Batch conflicts: two entries with the same key (`README.md` + `readme.md` on a case-insensitive host), a path that is
  both a file and a parent dir, a file over an existing dir or symlink. Existing file: `onConflict` `fail` (default,
  UI asks) / `overwrite` / `rename` (`name (1).ext`).

### 1.9 Reading dropped files and folders in the browser

- Drop: in the `drop` handler, **synchronously** collect `item.getAsFileSystemHandle()` (Chromium; handles can be
  stored in IndexedDB for resume) and `item.webkitGetAsEntry()` (all browsers) before any `await`; walk entries with
  `createReader().readEntries()` **in a loop until it returns an empty batch**; walk handles with `entries()`.
  Record empty directories explicitly (both walkers do). The handle walker was verified on OPFS handles (same type).
  A real OS drag cannot be synthesised headless (`new DataTransfer()` items give `webkitGetAsEntry() === null`).
- Button fallback: `<input type=file webkitdirectory>` works (paths `proj/sub/b.txt`, first segment = picked folder),
  but **drops empty directories** (verified). **[Verified in all three engines]** Chrome 153, WebKit 26.6 and
  Firefox 155 all omit the empty dir and pass the NFD name through unnormalised. A synthetic
  `DataTransfer` item gives `webkitGetAsEntry() === null` **only in Chromium**; WebKit and Firefox return a
  `FileSystemFileEntry`, so tests cannot assume null. `getAsFileSystemHandle` and `showSaveFilePicker` exist only
  in Chromium.
- Reading: `file.slice(a, b).arrayBuffer()` per 4 MiB chunk, never `file.arrayBuffer()` / `text()`. Random access is
  what makes resume cheap. `crypto.subtle.digest('SHA-256', chunk)` per chunk.
- Verified: 10 GiB uploaded from a Worker in 82 s (125 MiB/s, no encryption in this spike), all 2,560 chunk hashes and
  the root verified by the receiver, whole-browser RSS peak 396 MiB and falling to ~190–250 MiB, renderer peak
  189 MiB (§3 F16).
- **[Verified in the other engines]** The same Worker code with persistent profiles uploaded 4 GiB (plaintext,
  localhost; the source is a sparse file, so all chunks are zeros):

  | Engine | Throughput | Max `bufferedAmount` | Memory |
  |---|---|---|---|
  | Chrome 153 | 202 MiB/s | 12 MiB | renderers ≤ 477 MiB, tree 958 → 611 MiB, falling |
  | WebKit 26.6 | 338 MiB/s | 8 MiB | WebContent ≤ 433 MiB, Networking ≤ 60 MiB |
  | Firefox 155 | 258 MiB/s | 8 MiB | tree 1.49 → 0.72 GiB (idle 0.99 GiB) |

  - On a ~45 MiB/s throttled link without the guards, `bufferedAmount` reached 427 / 456 / 464 MiB (the WebKit
    Networking process grew to 481 MiB). With the guards it stayed ≤ 8–11 MiB at the same throughput. The
    backpressure design therefore holds in all three engines.
  - The WebKit UI process (Playwright.app) grew to 1.9 GiB during WebSocket sends only. It stayed at about 100 MiB
    after `setInputFiles` and after reading 2 GiB. This is attributed to Playwright's inspector instrumentation of
    WebSocket frames, but that attribution is unverified; shipping Safari was not measured.
  - SHA-256 of a 4 MiB chunk took 2–3.8 ms in these engines, so F17's 13.6 ms is specific to headless
    Chromium 145.

---

## 2. Dependencies (exact versions installed and run)

| Package | Version | Used by | Note |
|---|---|---|---|
| `@msgpack/msgpack` | 3.1.3 | protocol (web, cli, daemon) | Envelope codec. `Encoder({ignoreUndefined:true})`, `Decoder({max*Length})`. 5.9 KiB gzip. |
| `yazl` | 3.3.1 | daemon | Streaming zip writer, ZIP64 automatic. Only dep: `buffer-crc32` 1.0.0. |
| `zod` | 4.6.5 | protocol | `z.instanceof(Uint8Array)` for bytes, `.int().max(Number.MAX_SAFE_INTEGER)` for offsets. |
| `ws` | 8.22.0 | spike only | Stand-in for relay/daemon sockets (daemon may use Node's global WebSocket client). |
| `esbuild` | 0.28.2 | spike only | Bundle the Worker and measure codec bundle sizes (the app uses Vite). |
| Evaluated, not recommended | archiver 8.0.0 (zip-stream 7.0.5, compress-commons 7.0.1), fflate 0.8.3, msgpackr 2.1.0, cbor-x 1.6.6, yauzl 3.4.0 (reader, used only to verify) | — | See §1.1, §1.6. |

No dependency is needed for the disk check (`fs.statfs`, Node ≥ 18.15), hashing (`node:crypto` / WebCrypto) or the
browser file APIs.

---

## 3. Verified facts

All commands from `SPIKE`. "Chromium" = headless Chromium 145.0.7632.6 launched by gstack browse (off-the-record context).

| # | Claim | Evidence |
|---|---|---|
| F1 | MessagePack adds 156 B to a 4 MiB chunk envelope; JSON+base64 adds 1,398,321 B (33.3 %). Encode 0.30 ms, decode 0.01 ms. | `node src/codec-bench.mjs` table |
| F2 | `@msgpack/msgpack` decodes `bin` as a zero-copy `Uint8Array` view (Node too); msgpackr and cbor-x return `Buffer` in Node. | same run: `zeroCopyDecode true`, `decoded bin type (@msgpack/msgpack): Uint8Array \| msgpackr: Buffer \| cbor-x: Buffer`; source `Decoder.mjs:652` `this.bytes.subarray(...)` |
| F3 | `@msgpack/msgpack` rejects a `__proto__` map key (`DecodeError`); msgpackr renames it to `__proto_`. No prototype pollution in either. | same run |
| F4 | Default `@msgpack/msgpack` turns `undefined` into `null` (breaks `z.optional()`); `ignoreUndefined:true` drops the key. | same run |
| F5 | `maxBinLength` is enforced (10 MiB bin with a 9 MiB limit → `DecodeError`). A 64-bit int above 2^53 decodes to an unsafe number silently, so zod must bound offsets with `.max(Number.MAX_SAFE_INTEGER)`. | same run: `uint64 2^53+1 -> 9007199254740992 false` |
| F6 | Browser bundle (esbuild, minified): @msgpack/msgpack 5,924 B gzip, msgpackr 10,478 B, cbor-x 10,815 B. | `bundle/` + esbuild output printed |
| F7 | Upload survives a daemon SIGKILL at 33 % and a client SIGKILL at 67 %: resumed with 33 then 68 chunks already on file, the new client re-hashed 68 chunks locally and sent only 28; sha256(result) == sha256(source); staging dir empty afterwards; result mode 644. Same on Node 22.22.1. | `node test/upload-e2e.mjs` SUMMARY (`resumes`, `sha256Match:true`, `sentChunks:28`, `stagingLeft:[]`) |
| F8 | An upload that does not fit is rejected at `begin`, before any chunk: `insufficient_disk`. Path traversal at `begin`: `bad_path`. Wrong chunk hash: `hash_mismatch`. Wrong chunk length: `bad_request`. Commit with a missing chunk: `incomplete`. A 10 MiB bin in a chunk: daemon closes with 1002. | same SUMMARY `negative` block |
| F9 | TTL sweep removes an abandoned partial (manifest + journal + part). Staging dir is 0700, its files 0600, committed file `0666 & ~umask`. | SUMMARY `ttlSweep`, `stateDirMode:"700"`; `node --test test/upload-store.test.mjs` (4/4) |
| F10 | Out-of-order concurrent chunk writes produce the exact file; a duplicate chunk is idempotent; another user's chunk is `forbidden`; `link()+unlink()` commit refuses an existing target (`conflict`, old content intact) while `rename()` overwrites; zero-byte files work; a fresh store (daemon restart) resumes by identity with bitmap + hashes; a changed `lastModified` starts a new upload; wrong root → `hash_mismatch`. | `test/upload-store.test.mjs` 4/4 on Node 25 and 22 |
| F11 | SHA-256 4 MiB: node:crypto 2,735 MiB/s, WebCrypto-in-Node 2,495 MiB/s. pwrite 4 MiB: 2,112 MiB/s without sync, **400 MiB/s with fdatasync per chunk**, 542 MiB/s with fsync. Re-read + hash 1,846 MiB/s. **[Verifier]** Re-run: 2,722 / 2,466; 1,295 unsynced, **475 fdatasync, 507 fsync**. The fdatasync/fsync difference is noise, not a reason to prefer either. | `node src/io-bench.mjs` |
| F12 | Hashing a 4 MiB chunk on the daemon's event loop blocks it ~1.5 ms (p99 1.6 ms, max 1.8 ms); `subtle.digest` is similar. Not a typing-latency concern. | `node src/loop-lag.mjs` |
| F13 | `fs.statfs` matches `df -k` exactly: `blocks×bsize = 494384795648 = df total×1024`, `bavail×bsize = df avail×1024` (sampled at the same moment: diff 0 B). bfree == bavail on APFS here. Works on Node 22.22.1 and 25.4.0. | `node test/disk-check.mjs` |
| F14 | With defaults (5 GiB, 5 %) this 460 GiB disk reserves 23.02 GiB and accepts at most ~6 GiB now; "exactly max" accepted, "max + 1 byte" rejected, 10 GiB rejected. | same run |
| F15 | APFS here is case-insensitive and normalisation-insensitive but **preserving**: an NFD-created name is found by its NFC spelling and `readdir` returns the NFD form. NAME_MAX = 255 UTF-16 units (255 × `中` OK = 765 B; 256 × `é` → `ENAMETOOLONG`; 128 emoji = 256 units → `ENAMETOOLONG`). `getconf NAME_MAX` 255, `PATH_MAX` 1024. | `node --test test/path-safety.test.mjs` diagnostics; ad-hoc probe |
| F16 | Chromium: **10 GiB** file uploaded from a Worker with `slice().arrayBuffer()` 4 MiB chunks, WebCrypto per-chunk SHA-256, ack window 4, `bufferedAmount` ≤ 8 MiB: 81.9 s (125 MiB/s), 2,560/2,560 chunk hashes and the root verified by the receiver, **peak RSS of all Chromium processes 396 MiB** (renderer 189, browser 100, GPU 66, network 44), trending down to 190–250 MiB; max `bufferedAmount` 12.6 MB; main-thread timer drift ≤ 12 ms. | `node browser/run.mjs folder upload10g` → `work/browser/results-upload10g.json` |
| F17 | Per chunk in that run: read 5.4 ms, SHA-256 13.6 ms (WebCrypto in Chromium is ~5x slower than Node here). **[Corrected]** That is headless Chromium 145 only. Chrome 153 / WebKit 26.6 / Firefox 155 hashed a 4 MiB chunk in 2.0 / 2.2 / 3.2 ms (`verify/pw-run.mjs`). | same |
| F18 | Same code, **no** ack window and **no** `bufferedAmount` limit, receiver throttled to ~45 MiB/s, 1 GiB: `bufferedAmount` peaked at **823,956,586 B**, renderer **740 MiB**, all Chromium 944 MiB. | `node browser/run.mjs naive` → `results-rest.json` |
| F19 | With the guards on the same throttled link: max `bufferedAmount` 11.5 MB, renderer 200 MiB, total ≤ 375 MiB, flat; throughput 45.1 vs 40.8 MiB/s (no loss). | same |
| F20 | A `File` from `<input>` can be `postMessage`d to a Worker and sliced there. | the upload phases above run entirely in the Worker |
| F21 | `<input webkitdirectory>` gives `webkitRelativePath` = `proj/a.txt`, `proj/sub/deeper/c.txt`, `proj/中文/檔案.md`…, **omits the empty directory**, and passes the NFD name through unnormalised (`… 65 301 2e 74 78 74`). | `browser/run.mjs folder` → `webkitdirectory` |
| F22 | Walking a `FileSystemDirectoryHandle` with `entries()` finds nested files, a CJK name and the empty directory. | `opfsWalkTest()` result |
| F23 | Present in Chromium 145: `webkitGetAsEntry`, `getAsFileSystemHandle`, `showSaveFilePicker`, `showDirectoryPicker`, OPFS, `createWritable`, transferable `ReadableStream`. `createSyncAccessHandle` is not on the main thread. A synthetic `DataTransfer` item returns `webkitGetAsEntry() === null`. **[Corrected]** The null entry is Chromium-only; WebKit 26.6 and Firefox 155 return a `FileSystemFileEntry`. Worker-side `createSyncAccessHandle` is present in all three engines. | `apiPresence()`, `syntheticEntry()`; `verify/pw-run.mjs` |
| F24 | **R7 acceptance:** the clean 1,000-file fixture (nested dirs, 3 empty dirs, CJK/NFD/emoji/space/`#%` names, a 20 MiB blob, 0755 script, empty file, `.git/`) zipped by yazl through the walker and extracted by Apple unzip: `diff -r --no-dereference` exit 0, 1,000 files, 3 empty dirs; content, type, permission bits and symlink targets identical. | `node test/zip-compare.mjs` → `acceptance_clean` |
| F25 | Same over the envelope protocol with the credit window (daemon-sim → client → zip file): 39 chunks, 163 MB, unzip + `diff -r` exit 0 against the source minus the reported skips; skipped = `a-fifo:special-file`, `link-absolute`, `link-escape`, `link-escape-folder` (`symlink-outside-folder`); 3 in-folder symlinks kept. | `node test/download-e2e.mjs` |
| F26 | Timestamps: yazl writes the exact "UT" time only in the central directory, not in the local header; Info-ZIP unzip, bsdtar and ditto restore from the local header, so extracted mtimes have 2 s DOS precision and a 1975 mtime becomes 1980-01-01. Info-ZIP's own `zip` (UT in both headers) round-trips 1975 exactly. | `zipinfo -v`, local-header dump (`extra_len=0`), `stat -f %m` on extractions |
| F27 | archiver 8 `directory()` on a folder containing a FIFO: warning `ENTRYNOTSUPPORTED`, then never finishes (killed after 10 s). | `zip-compare.json` → `archiver_directory_with_fifo.outcome:"HUNG"` |
| F28 | archiver 8 `directory()` stores `link-escape`, `link-escape-folder`, `link-absolute` as symlink entries; archiver and zip-stream mtimes are −8 h after extraction (UTC written as DOS local time). | `listing_links`, `sampleDiffs` in `zip-compare.json` |
| F29 | fflate throws `date not in range 1980-2099` for the 1975 file (entry missing). | `zip-compare.json` → `fflate.errors` |
| F30 | ZIP64 entry count: yazl with 70,000 entries writes a ZIP64 EOCD; unzip, yauzl and Python all see 70,000. fflate writes 4,464 (70,000 mod 65,536) and no ZIP64 EOCD; unzip/Python still list 70,000 (they scan), yauzl sees 4,464. | `node test/zip64.mjs`; EOCD dump + yauzl + python run |
| F31 | ZIP64 size and offset: yazl, one 4.5 GiB stored entry followed by a small file: `unzip -t` OK, `unzip -p` sha256 equals the source, second local header at offset 4,831,838,269 with a ZIP64 extra field. fflate for the same entry writes 536,870,912 (mod 2^32) with no ZIP64 extra and no error. | `test/zip64.mjs` (sparse source and sparse output, ~1 MiB of real disk); `node test/fflate-4g.mjs` |
| F32 | yazl streaming 4.5 GiB into a null sink: peak RSS 138 MiB (store) / 141 MiB (deflate 1), the same as a bare `fs.createReadStream` (142–144 MiB); ~395 MiB/s, bound by JS CRC-32. | `node test/zip-mem.mjs {baseline,store,deflate}` |
| F33 | A file that grows while being zipped: yazl `addFile` (size from stat) emits `file data stream has unexpected number of bytes` on the ZipFile (unhandled → **process crash** without a listener) and the zip is broken; our `addReadStreamLazy` without size stores the 33 MiB actually read and the zip tests OK. | `node test/zip-live-change.mjs` |
| F34 | 1,000-file / 163 MB folder: yazl ~3.0 s, archiver 2.8–3.0 s, zip-stream 2.9 s, fflate 2.6 s (deflate level 6, mostly random data). | `zip-compare.json` `ms` |
| F35 | APFS keeps a truncate-only file sparse (10 GiB = 0 B on disk), but a file written with one byte every 4 MiB became **fully allocated** (1 GiB → 1,048,576 KiB). Skipping all-zero writes and ending with `ftruncate` keeps a 4.5 GiB zip at ~1 MiB. | `du -k` checks in the spike |
| F36 | OPFS download from the Worker via `createSyncAccessHandle`: works; `getFile()` returns a `File`, `URL.createObjectURL` works; `navigator.storage.estimate()` quota in this headless context ~0.86–1.1 GB. | `browser/run.mjs opfs` |
| F37 | In this off-the-record context, OPFS writes past 256 MiB **did not throw**: `write()` returned 4294967288 (2^32 − 8) for each of the 64 remaining 4 MiB chunks and the file stayed 268,435,456 B. Browser-process RSS rose to 340 MiB (OPFS is memory-backed off the record). **[Corrected]** The 256 MiB threshold is not reproducible; the trigger is quota exhaustion. The same command wrote 512 MiB cleanly (quota 973 MB). With `DL_MIB=1536` (quota 875 MB), 256 writes returned the bogus count and the file stopped at 536,870,912 B, again with no exception. Persistent profiles in Chrome 153, WebKit and Firefox wrote 1 GiB with 0 short writes; their exhaustion behaviour was not tested (it would need more than 10 GB of disk). | `DL_MIB=512` / `DL_MIB=1536 node browser/run.mjs opfs` in `transfer-verify` |
| F38 | StreamSaver mechanism: a `ReadableStream` transferred to a service worker and returned as `new Response(stream, {Content-Disposition: attachment})` delivered 1 GiB to a `fetch()` in 0.69 s; renderer peak 266 MiB. | `swStreamTest(1024)` |
| F39 | Home, `/private/tmp` and the project folder are on the same device here (`stat().dev` equal), so `~/.smurg` staging + `rename/link` works. | `upload-store.test.mjs` last assertion; e2e runs |

---

## 4. Unverified / could not test here

- **Encryption in the loop.** Uploads ran over plain WebSocket. With noble ChaCha20-Poly1305 in the Worker
  (~200 MiB/s, noise.md F25) adding ~20 ms per 4 MiB chunk on top of the measured 19 ms read+hash, the browser-side
  ceiling should be roughly 70–100 MiB/s. Estimate only. Overlapping read/hash/encrypt of the next chunk would raise it.
- **Cloudflare TransferDO** was not run here. `docs/research/relay.md` (written in parallel) verified locally that a
  DO-side WebSocket has no `bufferedAmount` and that the relay buffers everything an uploader pushes (its V12), that
  its frame cap is 8 MiB + 64 KiB (our largest message, an 8 MiB chunk + 156 B envelope + Noise framing, fits), and that
  the 128 MB memory limit is per isolate and shared by co-located DOs. That makes the end-to-end ack window of
  §1.2 mandatory, and argues for the 4 MiB default plus a cap on concurrent transfers per workspace. It also notes the
  two sockets are unordered, which is why every `file.upload.*` / `file.download.*` message, including begin, commit
  and acks, stays on the transfer channel in §1.3.
- **Real OS drag and drop of folders** (webkitGetAsEntry / getAsFileSystemHandle on a real drop, `readEntries`
  batching of 100 in Chromium, handles persisted in IndexedDB and `requestPermission` after reload). Only the handle
  walker (on OPFS) and API presence were verified.
- ~~**Firefox and Safari**~~ **Partly verified by the verifier** with Playwright's WebKit 26.6 and Firefox 155 (not
  the shipping Safari app). Verified: Worker upload with the guards, `webkitdirectory`, Worker-only
  `createSyncAccessHandle`, a 1 GiB OPFS stage, blob-URL `<a download>`, and quotas (§1.7, §1.9). Still untested:
  SW-stream downloads there, real Safari quota prompts and eviction, and Safari's Private mode.
- **`showSaveFilePicker` + `createWritable` for a real multi-GiB download** (needs a user gesture and the native
  dialog). Only API presence.
- ~~**OPFS in a normal (non-incognito) profile**~~ **Verified by the verifier** in Chrome 153 / WebKit / Firefox
  persistent profiles: 1 GiB with no short writes, flat memory, quotas 10 GiB / 20.6 GB / 10 GiB. Behaviour at
  quota exhaustion in these profiles is still untested (see F37).
- **Linux host**: `fs.statfs` field semantics on ext4/btrfs (bsize vs frsize), byte-based NAME_MAX, case-sensitive
  NFC/NFD twins, `link()` on the target filesystems. Only macOS was available; the verifier did not start the stopped
  colima VM either.
- ~~**Cross-volume staging** (`EXDEV`)~~ **Verified by the verifier** with mounted case-sensitive APFS and ExFAT
  disk images (§1.4). New finding: `link()` gives `ENOTSUP` on ExFAT.
- **Download of a single file with offset resume** and `file.upload.plan`: designed, not implemented in the spike.
- Info-ZIP unzip on Windows/Linux and Windows Explorer with yazl ZIP64 output. ~~macOS Archive Utility~~ The verifier
  ran `ditto -x -k`: ZIP64 by entry count works, ZIP64 by size or offset exits 1 (§1.6). The Archive Utility GUI app
  itself was not driven.

---

## 5. Gotchas

1. **Never trust `bufferedAmount` alone.** It only measures the browser's local send buffer. An end-to-end ack window
   is what bounds memory in the relay DO and the daemon. And never skip both: F18 shows 824 MB queued.
2. **`bufferedAmount` has no event.** Poll it (5 ms) together with the window; it can overshoot the limit by one chunk.
3. **WebCrypto has no streaming SHA-256.** Hence the hash-list root. Do not try `digest()` on the whole file.
4. **Never `file.arrayBuffer()` / `file.text()` / `new Response(file).arrayBuffer()`** on user files; always `slice()`.
5. **Grab `DataTransfer` items synchronously in the `drop` handler**; `readEntries()` must be called until it returns `[]`.
6. **`<input webkitdirectory>` loses empty directories**; drag-and-drop with entries/handles keeps them.
7. **Browsers hand you NFD names from macOS**; normalise to NFC, but reuse the existing on-disk spelling on conflict.
8. **APFS NAME_MAX counts UTF-16 units, Linux counts bytes.** A byte-based check rejects valid long CJK names on macOS.
9. **Disable the seq outbox on the transfer channel**; resume uploads by bitmap, not by replaying envelopes.
10. **`fdatasync` before journaling**, otherwise after a power loss the journal can claim chunks whose data is zeros.
11. **Staging mode leaks**: a `.part` created 0600 and renamed keeps 0600 in the shared folder. `chmod` before rename.
12. **Use `link()+unlink()` for no-clobber commit**; `rename()` silently replaces a file an agent created meanwhile.
    **[Corrected]** `link()` is `ENOTSUP` on ExFAT. Fall back to an `open(dest,'wx')` placeholder plus `rename()`.
13. **The 5 % rule dominates on big disks**: 23 GiB reserve on a 460 GiB laptop. Show the numbers, make it a setting.
14. **Count other in-progress uploads** (`pendingBytes`) in the disk check, and re-check on resume.
    **[Corrected]** "Other" means *excluding the upload being checked*; the spike counts a resumed upload twice.
15. **yazl `addFile()` stats the file (follows symlinks) and asserts the size.** A file edited during the zip crashes
    the process if the ZipFile has no `'error'` listener (F33). Use `addReadStreamLazy` with an `O_NOFOLLOW` fd, no `size`,
    and always attach `zip.on('error')`.
16. **Opening a FIFO blocks forever** (archiver hangs, F27). Skip non-regular files and open with `O_NONBLOCK`.
17. **archiver/zip-stream write UTC into DOS time fields** (8 h off here) unless `forceLocalTime: true`; fflate throws
    before 1980 and has no ZIP64. yazl's times are 2 s precision after extraction (UT only in the central directory).
18. **Symlinks in a zip are an attack surface for whoever extracts it.** Store only relative links that stay inside the
    folder; report the rest. Never descend into symlinked directories.
19. **APFS sparse files are fragile**: scattered writes make them fully allocated (F35). Do not rely on sparse `.part`
    files for disk accounting; reserve the full remaining size.
20. **OPFS `write()` can fail silently** (returns a bogus count, F37). Compare every return value with the chunk length
    and `getSize()` with the expected size; check `estimate()` first. **[Corrected]** The trigger is quota
    exhaustion, not a fixed 256 MiB cap.
21. **`window.status` is a reserved global** (legacy status bar string): a test harness that stores an object there
    gets `"[object Object]"`. (Cost us one run.)
22. **gstack browse instances are per project directory.** Several agents on this repo share one Chromium unless
    `BROWSE_STATE_FILE` points elsewhere; the spike uses its own. Headless contexts are off-the-record (F37).
23. **Undefined vs null**: default msgpack encodes `undefined` as `nil` → `null`, which `z.string().optional()` rejects.
    Use `ignoreUndefined: true` in the shared encoder.
24. **Node's libuv threadpool (4 threads) serves fs, WebCrypto and fdatasync.** Many concurrent uploads can queue editor
    file reads behind them; set `UV_THREADPOOL_SIZE` (e.g. 16) in the daemon launcher. (Reasoned, not measured.)
25. *(verifier)* **msgpack decode is zero-copy.** Never decrypt into a reused buffer before `decode()`, or earlier
    messages' bytes change under you.
26. *(verifier)* **Memoize `#load()`**, or concurrent first chunks after a restart lose bitmap bits (commit then says
    `incomplete`).
27. *(verifier)* **Catch `ENOENT` per entry in the zip walker.** One file vanishing mid-walk otherwise aborts the
    whole download. A file that vanishes before its lazy open becomes a 0-byte entry.
28. *(verifier)* **Apple's `ditto` stops at yazl's first ZIP64 size/offset data descriptor.** Put files ≥ 4 GiB
    last and warn; a ZIP64 EOCD for more than 65,535 entries alone is fine.
29. *(verifier)* **Java `ZipInputStream` rejects stored entries with a data descriptor**, which yazl lazy streams
    always write. This matters only if a Java tool must stream our zips.
30. *(verifier)* **The case-fold key is not APFS's or ExFAT's rule** (ß/ẞ, ı, ligatures). Let the filesystem's
    `EEXIST` at commit be the final arbiter.
31. *(verifier)* **Page `wantHashes`.** 32 B × chunkCount passes 9 MiB above ~1.1 TiB at 4 MiB chunks.
32. *(verifier)* **`fs.rmSync(dir, {recursive:true})` fails with `ENOTEMPTY` on macOS ExFAT** (AppleDouble `._*`
    files). Workspace-local staging cleanup there should remove files one by one and tolerate `._*` leftovers.

---

## 6. Verified code (key snippets that ran)

Envelope codec (`src/envelope.mjs`):

```js
import { Encoder, Decoder } from '@msgpack/msgpack';
const encoder = new Encoder({ ignoreUndefined: true });
const decoder = new Decoder({ maxBinLength: 9 * MiB, maxStrLength: 1 * MiB, maxArrayLength: 1_000_000, maxMapLength: 10_000 });
export const Envelope = z.object({ type: z.string().min(1).max(64), id: z.string().max(64), seq: z.number().int().nonnegative(), payload: z.unknown() });
export const encodeEnvelope = (env) => encoder.encode(env);
export const decodeEnvelope = (bytes) => Envelope.parse(decoder.decode(bytes));
export const Bytes = z.instanceof(Uint8Array);
'file.upload.chunk': z.object({ uploadId: z.string().max(64), index: z.number().int().nonnegative(),
  hash: Bytes.refine((b) => b.length === 32), data: Bytes.refine((b) => b.length <= 8 * MiB) }),
```

Chunk receiver (`src/upload-store.mjs`, excerpt):

```js
async chunk({ uploadId, userId, index, hash, data }) {
  const st = await this.#load(uploadId);                       // manifest + journal replay -> bitmap + hashes
  const { m } = st;
  if (m.userId !== userId) throw new UploadError('forbidden', 'not your upload');
  const expectLen = index === m.chunkCount - 1 ? m.size - index * m.chunkSize : m.chunkSize;
  if (data.length !== expectLen) throw new UploadError('bad_request', `chunk ${index} length ${data.length} != ${expectLen}`);
  const digest = sha256(data);
  if (!digest.equals(Buffer.from(hash))) throw new UploadError('hash_mismatch', `chunk ${index} hash mismatch`);
  if (isSet(st.have, index)) { if (!st.hashes[index].equals(digest)) throw new UploadError('conflict', '...'); return { index, duplicate: true }; }
  const run = async () => {
    await st.fh.write(data, 0, data.length, index * m.chunkSize);    // pwrite
    await st.fh.datasync();                                          // durable BEFORE it is journaled
    await st.journal.appendFile(`${index} ${digest.toString('hex')}\n`);
    st.have[index >> 3] |= 1 << (index & 7); st.hashes[index] = digest;
  };
  const p = st.tail.then(run); st.tail = p.catch(() => {}); await p;
  return { index };
}
// commit (excerpt)
const root = hashListRoot(m.size, m.chunkSize, st.hashes);            // sha256(u64 size || u32 chunkSize || h0..hn)
if (!root.equals(Buffer.from(rootHash))) throw new UploadError('hash_mismatch', 'whole-file hash-list root mismatch');
await st.fh.sync(); await st.fh.chmod(0o666 & ~process.umask());
const dest = await this.resolveTarget(m.root, m.path);                 // PathGuard again
if (onConflict === 'overwrite') await fs.rename(f.part, dest);         // atomic replace
else { await fs.link(f.part, dest); await fs.unlink(f.part); }         // atomic no-clobber (EEXIST -> conflict)
```

Disk check (`src/disk.mjs`):

```js
const s = await fs.statfs(dir, { bigint: true });                      // deepest existing ancestor of the target
const bsize = BigInt(s.bsize), totalBytes = BigInt(s.blocks) * bsize, availBytes = BigInt(s.bavail) * bsize;
const percentReserve = (totalBytes * BigInt(Math.round(reservePercent * 100))) / 10000n;
const reserve = BigInt(reserveBytes) > percentReserve ? BigInt(reserveBytes) : percentReserve;
const freeAfter = availBytes - BigInt(pendingOnSameVolume) - BigInt(incoming);
return { ok: freeAfter >= reserve, reserve, freeAfter, maxUploadNow: availBytes - BigInt(pendingOnSameVolume) - reserve };
```

Streaming zip (`src/zip-folder.mjs`, excerpt):

```js
const zip = new yazl.ZipFile();
zip.on('error', (e) => zip.outputStream.destroy(e));                  // mandatory (F33)
for await (const e of walkFolder(rootAbs, skipped, { excludeTop })) {  // lstat walk; escaping symlinks/FIFOs -> skipped
  if (e.kind === 'emptyDir') zip.addEmptyDirectory(e.rel, { mtime: e.st.mtime, mode: (e.st.mode & 0o7777) | 0o040000 });
  else if (e.kind === 'symlink') zip.addBuffer(Buffer.from(e.target), e.rel, { mtime: e.st.mtime, mode: 0o120777, compress: false });
  else zip.addReadStreamLazy(e.rel, { mtime: e.st.mtime, mode: (e.st.mode & 0o7777) | 0o100000, compress: !store, compressionLevel: store ? 0 : 6 },
    (cb) => fs.open(e.abs, O_RDONLY | O_NOFOLLOW | O_NONBLOCK, (err, fd) => /* fstat: same ino + isFile, else skip */
      cb(null, fs.createReadStream(null, { fd, highWaterMark: 1 << 20 }))));
}
zip.end();
// daemon: for await (const part of rechunk(zip.outputStream, 4 << 20)) { await credit(); send('file.download.chunk', id, { index: i++, data: part }); }
```

Browser Worker upload loop (`browser/upload-worker.js`, excerpt):

```js
const until = (pred) => new Promise((res) => { const tick = () => (pred() ? res() : setTimeout(tick, 5)); tick(); });
for (let i = 0; i < n; i++) {
  await until(() => inflight < W && ws.bufferedAmount <= bufferedLimit);          // W = 4, 8 MiB
  const data = new Uint8Array(await file.slice(i * chunkSize, Math.min(size, (i + 1) * chunkSize)).arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  hashes[i] = hash; inflight++;
  send('file.upload.chunk', { uploadId, index: i, hash, data }).then(() => { inflight--; acked++; });
}
await until(() => acked === n);
const root = new Uint8Array(12 + 32 * n); const dv = new DataView(root.buffer);
dv.setBigUint64(0, BigInt(size)); dv.setUint32(8, chunkSize); hashes.forEach((h, i) => root.set(h, 12 + 32 * i));
await send('file.upload.commit', { uploadId, rootHash: new Uint8Array(await crypto.subtle.digest('SHA-256', root)) });
```

Path normalisation (`src/path-safety.mjs`, excerpt):

```js
if (FORBIDDEN_CHARS.test(raw)) throw …;            // /[\u0000-\u001f\u007f‪-‮⁦-⁩]/u
if (raw.includes('\\') || /^[A-Za-z]:/.test(raw)) throw …;
p = p.normalize('NFC');
for (const s of p.split('/')) { if (s === '' || s === '.' || s === '..') throw …; if (segmentTooLong(s)) throw …; }
if (RESERVED_TOP.has(segs[0])) throw new UploadPathError('path_denied', …);   // '.git', '.smurg'
// darwin: s.length > 255 (UTF-16 units); linux: utf8 bytes > 255
```

---

## 7. How to re-run the spike

```sh
cd /private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/transfer
npm ci                          # exact versions in package-lock.json
sh run-all.sh                   # everything, in order (about 5 minutes; needs ~2 GB free disk)
```

Individual pieces:

| Command | What |
|---|---|
| `node src/codec-bench.mjs` | envelope codec comparison (F1–F5) |
| `node --test test/path-safety.test.mjs` | path rules + APFS facts (F15) |
| `node test/disk-check.mjs [path]` | statfs vs df, reserve computation (F13–F14) |
| `node src/io-bench.mjs`, `node src/loop-lag.mjs` | hashing / fdatasync / loop lag (F11–F12) |
| `node --test --test-concurrency=1 test/upload-store.test.mjs` | receiver unit tests (F9–F10) |
| `node test/upload-e2e.mjs` | 384 MiB upload with daemon and client SIGKILL + negative cases (F7–F8) |
| `node test/make-fixture.mjs && node test/zip-compare.mjs` | 1,000-file fixture, 4 zip libraries, `diff -r` (F24, F26–F29, F34) |
| `node test/download-e2e.mjs` | zip over the envelope protocol (F25) |
| `node test/zip64.mjs`, `node test/fflate-4g.mjs`, `node test/zip-mem.mjs store` | ZIP64 and memory (F30–F32) |
| `node test/zip-live-change.mjs` | file growing during zip (F33) |
| `node browser/run.mjs [api folder upload10g naive opfs sw]` | headless Chromium via gstack browse (own instance in `.gstack/`), results in `work/browser/results*.json` (F16–F23, F36–F38) |

All children (daemon-sim, client-sim, browse/Chromium) are killed or stopped by the scripts; `browser/run.mjs` ends with
`browse stop`. The 10 GiB / 1 GiB browser sources and the 4.5 GiB zip source are sparse files (0 B on disk).

---

## Verification

Independent verifier, 2026-09-28. The spike was copied without `node_modules`/`work` to
`/private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/transfer-verify`
and reinstalled with `npm ci`, which resolved to the exact versions in §2. The verifier's own checks are in
`transfer-verify/verify/`; `sh verify/run-verify.sh` re-runs everything. Machine: macOS 26.5.1 arm64, Node 25.4.0,
about 22–25 GiB free. Browsers: system Chrome 153.0.8010.53 through Playwright 1.63 (`channel: 'chrome'`), plus
Playwright's WebKit 26.6 and Firefox 155 builds reused read-only from `spikes/noise-verify/pw`. All with fresh
**persistent** profiles, deleted afterwards. The original gstack harness ran headless Chromium 145.

### Confirmed (re-run, same result)

| Claim | Re-run evidence |
|---|---|
| F1–F5 codec table and semantics | `node src/codec-bench.mjs`: 156 B overhead, enc 0.29 / dec 0.01 ms, zero-copy `Uint8Array`, `__proto__` throws, `ignoreUndefined` drops the key, `maxBinLength` enforced, 2^53+1 decodes to an unsafe value. `Decoder.mjs:543` (`__proto__`) and `:652` (`subarray`) read in source. |
| F6 bundle sizes | esbuild + `gzip -9`: 5,922 / 10,476 / 10,813 B |
| F7–F8 upload e2e | `node test/upload-e2e.mjs`: resumes `received` 0 → 32 → 68 (the original saw 33, which is timing), re-hashed 68, sent 28, `sha256Match:true`, mode 644, staging empty; every negative case gives the same codes; closed with 1002 on a 10 MiB bin |
| F9–F10 store unit tests | 4/4 pass |
| F12 loop lag | createHash p50 1.49 / max 2.61 ms per 4 MiB |
| F13–F14 statfs | `blocks×bsize` equals `df` total exactly; `bavail×bsize` is within 32 KiB of `df` (sampled at a different instant). Reserve 23.02 GiB [percent]; the largest upload accepted is now **1.93 GiB** (the disk filled up since, and the rule is the same). max accepted, max+1 rejected. |
| F15 APFS | case- and normalisation-insensitive, preserving, NAME_MAX 255 |
| F24 R7 acceptance | yazl 1,000 files → Apple unzip → `diff -r --no-dereference` exit 0, 1,000 files, 3 empty dirs. The fixture's `café-nfd.txt` really is NFD on disk (`cafe\xcc\x81`). Also confirmed with **`ditto -x -k`**: exit 0, `diff` exit 0. |
| F25 zip over the envelope protocol | 39 chunks, 163,093,384 B, unzip 0, diff 0, the same 4 skips |
| F26–F29 | archiver `HUNG` on the FIFO, keeps escaping and absolute links, −8 h; zip-stream −8 h; fflate drops the 1975 file |
| F30–F32 ZIP64 + memory | yazl 70,000 entries plus ZIP64 EOCD; 4.5 GiB stored entry, next header at 4,831,838,269, sha OK; fflate 536,870,912 with no ZIP64 extra; zip-mem 133 / 136 / 138 MiB |
| F33 | re-run as written, plus the unguarded case: **without** `zip.on('error')` the process exits with code 1 on `file data stream has unexpected number of bytes` (`verify/yazl-nolistener.mjs`) |
| F38 SW stream | 1 GiB in 0.68 s (headless Chromium 145) |
| F39 same device | confirmed |
| Guard vs naive backpressure (F18–F19) | holds in **all three** engines (§1.9 table): naive 427–464 MiB `bufferedAmount`, guarded ≤ 8–12 MiB |
| `webkitdirectory` drops empty dirs and passes NFD through (F21) | holds in Chrome 153, WebKit 26.6, Firefox 155 |

### Corrected (with evidence)

1. **Resume disk check double-counts** (§1.5). `verify/store-edge.test.mjs`: `incoming 3,145,728 + pendingBytes
   3,145,728 = 6,291,456` charged for a 3 MiB resume. The fixed copy `verify/upload-store-fixed.mjs`
   (`pendingBytes(excludeId)`) charges 3,145,728.
2. **`#load()` race** (§1.4). Four concurrent first chunks after a restart lead to commit `incomplete`. With a memoized
   load promise, commit `ok`.
3. **No-clobber commit on ExFAT** (§1.4). `link()` → `ENOTSUP`; UploadStore commit fails. The `wx` placeholder plus
   `rename()` works. Cross-volume `EXDEV` for both `link` and `rename` is confirmed on disk images. This was
   previously "not testable".
4. **Zip walker** (§1.6). A file deleted between `readdir` and `lstat` makes the walker throw `ENOENT` and aborts the
   zip. A file deleted before its lazy open becomes a **0-byte entry**, listed in `skipped` as `open:ENOENT`
   (`verify/walker-vanish.mjs`).
5. **ZIP64 compatibility** (§1.6). The local header of a 4.5 GiB entry has flags `0x808`, sizes 0 and **no extra
   fields**, followed by a 24-byte descriptor. `ditto -x -k`:
   - 4.5 GiB entry first, then a small file: the big file is correct, the small file is **missing**, exit 1
     `Couldn't read pkzip signature`.
   - 2 × 2.5 GiB entries (offsets > 4 GiB): all three entries correct, exit 1.
   - Big entry last: all entries correct, exit 1.
   - 70,000 small entries: exit 0.

   bsdtar (seekable and streaming), Python `zipfile` and Info-ZIP `unzip` read every case correctly (sha matches).
   Java `ZipInputStream` fails on stored entries with a descriptor. Recommendation added: large files last, plus a
   warning.
6. **F37 OPFS** (§1.7). Not a fixed 256 MiB cap. The original command wrote 512 MiB cleanly (quota 973 MB).
   Exceeding the quota (1,536 MiB into 875 MB) reproduced the silent bogus `write()` return, with the file stuck at
   512 MiB.
7. **F17 WebCrypto speed** applies only to headless Chromium 145. It is 2–3.8 ms per 4 MiB in Chrome 153, WebKit
   and Firefox.
8. **F23 synthetic `DataTransfer`**: `null` only in Chromium; WebKit and Firefox return an entry.
9. **Case-fold key** (§1.8). It disagrees with APFS on ß/ẞ and ı, and with ExFAT on 8 of 16 pairs.
   Case-sensitive APFS is still normalisation-insensitive (NFC twin → `EEXIST`).
10. **F11**: fdatasync and fsync are within noise of each other (475 vs 507 MiB/s).
11. **zod**: `.int()` already rejects unsafe integers in zod 4.6.5, so `.max(MAX_SAFE_INTEGER)` is redundant.

### Newly verified (was "unverified")

- Firefox and WebKit engines: Worker upload of 4 GiB with guards, OPFS 1 GiB stage plus blob-URL download (correct
  bytes), quotas, API presence (§1.7, §1.9).
- OPFS in normal persistent profiles: no short writes, flat memory.
- Cross-volume staging (`EXDEV`) and a second filesystem type (ExFAT).
- Apple's zip extractor (`ditto`) on yazl output, including ZIP64 (stored entries). A *deflated* > 4 GiB entry was
  not tested; it uses the same local-header and descriptor layout.

### New gotchas

Added to §5 as items 25–32: zero-copy aliasing, `#load` memoization, walker `ENOENT`, ditto vs ZIP64, Java stored
entries, case-fold key vs filesystem, `wantHashes` paging (> ~1.1 TiB exceeds `maxBinLength`, verified), and
ExFAT `rmSync` `ENOTEMPTY`. The write-side TOCTOU note is in §1.4; it was not tested.

### Still unverified

- Noise encryption in the loop, and the real Cloudflare TransferDO (unchanged).
- Real OS folder drag-and-drop (`webkitGetAsEntry` / `getAsFileSystemHandle` on a genuine drop, `readEntries`
  batching, handle persistence and `requestPermission`).
- `showSaveFilePicker` with the native dialog for a multi-GiB download.
- The shipping Safari app, including Private mode, quota prompts and eviction. The WebKit numbers come from
  Playwright's WebKit 26.6 build. Its UI-process growth during WebSocket sends is attributed to inspector
  instrumentation, but that is not proven.
- OPFS quota-exhaustion behaviour in persistent profiles of Chrome, WebKit and Firefox.
- The macOS Archive Utility GUI (only `ditto` was run) and Windows Explorer with yazl ZIP64.
- Linux hosts (statfs `frsize`, byte NAME_MAX, NFC/NFD twins, `link()`; also `EXDEV` across bind mounts).
- The write-side TOCTOU between PathGuard re-resolve and `link`/`rename`.
- `UV_THREADPOOL_SIZE` contention.
- Single-file download resume by offset + etag, and the `file.upload.plan` end-to-end flow.
- F35 (APFS sparse allocation) was not re-run.

### Cleanup

All daemon-sim, client-sim, Playwright, Chromium and gstack browse processes exited; `pgrep` found none. Both disk
images were detached and deleted. Sparse sources, fixtures and extraction outputs were removed from
`transfer-verify/work` (35 MB left). Neither the original spike directory nor `noise-verify` was modified.
