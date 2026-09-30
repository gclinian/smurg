// A folder as a streamed zip (SPEC R7 「由 daemon 以串流方式把資料夾打包成 zip」; transfer.md §1.6 with the
// verifier's corrections): yazl 3.3.1 fed by our own walker, never by yazl's addFile (which follows symlinks and
// crashes the process when a file changes size while it is read).
//
// Walker rules:
//  * lstat semantics, sorted depth-first; every directory is resolved through PathGuard right before it is read and
//    re-validated after, so a directory swapped for a symlink is skipped, not followed;
//  * regular files are opened lazily (when yazl reaches them) through PathGuard.openRead (O_NOFOLLOW | O_NONBLOCK +
//    fstat, same inode as listed) and streamed; their size is not declared, so a file that grows meanwhile is
//    stored as read; a file that vanished before its turn stays as a 0-byte entry and is reported (`open:…`);
//  * a file, link or directory that vanishes between readdir and lstat is reported, never fatal;
//  * symlinks are stored as links only when their text is relative and stays inside the zipped folder;
//  * FIFOs, sockets, devices, and (for non-hosts) hard-linked files are skipped and reported;
//  * empty directories get explicit entries; `.smurg` at the workspace root and temp files are left out;
//  * files of 4 GiB or more go last: Apple's extractor stops at yazl's first ZIP64 size/offset descriptor.
// Nothing is buffered whole: yazl pulls each file as the consumer pulls the zip.
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import yazl from 'yazl';
import { DOWNLOAD_SKIPPED_MAX, SmurgError, checkRelPath, isHiddenTempName, isHostPrivatePath, isSmurgDirName, type FileRef } from '@smurg/protocol';
import { isPathDeniedError } from '../core/errors.ts';
import type { PathGuard, Principal, ResolvedPath } from '../core/interfaces.ts';
import { errnoCode, isInside } from '../workspace/fs-util.ts';
import { joinRel } from './util.ts';

/** Already-compressed formats are stored, not deflated again (transfer.md §1.6). */
const STORE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.7z', '.rar', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.mp4',
  '.mov', '.mkv', '.webm', '.mp3', '.m4a', '.ogg', '.pdf', '.docx', '.xlsx', '.pptx', '.jar', '.whl', '.pt', '.pth',
  '.safetensors', '.ckpt', '.npz', '.parquet',
]);
/** Entries at or above this size need ZIP64 sizes; they are placed last. */
export const ZIP64_ENTRY_BYTES = 0xffff_ffff;
const READ_HIGH_WATER_MARK = 1024 * 1024;

export interface SkippedEntry {
  readonly path: string;
  readonly reason: string;
}

export interface ZipSourceOptions {
  readonly paths: PathGuard;
  readonly principal: Principal;
  /** The directory to zip (already resolved through PathGuard). */
  readonly base: ResolvedPath;
  /** Leave out `.smurg` at the top (zipping the main root). */
  readonly excludeTopSmurg: boolean;
  /** Host / system: hard-linked files are included. */
  readonly privileged: boolean;
  readonly compressionLevel?: number;
  /** Entries at least this big go last and set `zip64` (default ZIP64_ENTRY_BYTES; tests lower it). */
  readonly largeEntryBytes?: number;
}

export interface ZipSource {
  /** The zip bytes, pulled chunk by chunk. */
  readonly output: AsyncIterable<Buffer>;
  readonly skipped: readonly SkippedEntry[];
  /** Set once an entry needing ZIP64 sizes was added. */
  readonly zip64: boolean;
  /** Stops walking, closes every open file, ends `output` with an error. */
  cancel(): void;
}

interface WalkFile {
  readonly kind: 'file';
  readonly name: string;
  readonly refPath: string;
  readonly mtime: Date;
  readonly mode: number;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
}

/** Percent-encodes what a path may not contain, so even an unusable name can be reported in `skipped`. */
function reportableName(name: string): string | null {
  const encoded = [...name]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || ch === '\\' || ch === '/' || ch === '%' || (code >= 0xd800 && code <= 0xdfff)) {
        return `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
      }
      return ch;
    })
    .join('');
  const checked = checkRelPath(encoded);
  return checked.ok ? checked.path : null;
}

export function createZipSource(options: ZipSourceOptions): ZipSource {
  const zip = new yazl.ZipFile();
  const output = zip.outputStream as PassThrough;
  const skipped: SkippedEntry[] = [];
  const openStreams = new Set<Readable>();
  const baseReal = options.base.realPath;
  const root = options.base.ref.root;
  const level = options.compressionLevel ?? 6;
  const largeEntryBytes = options.largeEntryBytes ?? ZIP64_ENTRY_BYTES;
  let cancelled = false;
  let zip64 = false;

  const skip = (path: string, reason: string): void => {
    if (skipped.length < DOWNLOAD_SKIPPED_MAX) skipped.push({ path, reason: reason.slice(0, 200) });
  };
  const fail = (err: unknown): void => {
    if (!output.destroyed) output.destroy(err instanceof Error ? err : new Error('zip failed'));
  };
  // Mandatory: yazl emits 'error' on the ZipFile, and an unhandled one kills the process (transfer.md F33). The
  // output's own 'error' reaches the consumer through its async iterator; this listener only keeps a failure that
  // happens while nobody iterates (cancel after the end) from becoming an uncaught exception.
  zip.on('error', fail);
  output.on('error', () => {});

  const openLazily = async (item: WalkFile): Promise<Readable> => {
    if (cancelled) return Readable.from([]);
    const ref: FileRef = { root, path: item.refPath };
    const guardOptions = { principal: options.principal, mustExist: true, finalSymlink: 'deny' as const };
    try {
      const resolved = await options.paths.resolve(ref, guardOptions);
      const file = await options.paths.openRead(resolved, guardOptions);
      if (file.identity.dev !== item.dev || file.identity.ino !== item.ino || cancelled) {
        await file.close();
        if (!cancelled) skip(item.name, 'open:changed');
        return Readable.from([]);
      }
      const stream = file.handle.createReadStream({ highWaterMark: READ_HIGH_WATER_MARK });
      openStreams.add(stream);
      stream.once('close', () => openStreams.delete(stream));
      // yazl pipes without error forwarding: a read error must fail the zip, not hang it (or crash the process).
      stream.on('error', (err) => zip.emit('error', err));
      return stream;
    } catch (err) {
      const reason = isPathDeniedError(err) ? err.reason : err instanceof SmurgError ? (err.code === 'not_found' ? 'ENOENT' : err.code) : (errnoCode(err) ?? 'error');
      // The name is already committed to the archive: it stays as an empty entry, and the UI says so.
      skip(item.name, `open:${reason}`);
      return Readable.from([]);
    }
  };

  const addFile = (item: WalkFile): void => {
    if (item.size >= largeEntryBytes) zip64 = true;
    const store = level === 0 || STORE_EXTENSIONS.has(extname(item.name).toLowerCase());
    zip.addReadStreamLazy(item.name, { mtime: item.mtime, mode: (item.mode & 0o7777) | 0o100000, compressionLevel: store ? 0 : level }, (cb) => {
      void openLazily(item).then((stream) => cb(null, stream));
    });
  };

  const walk = async (): Promise<void> => {
    const deferred: WalkFile[] = [];
    interface StackItem {
      readonly name: string;
      readonly refPath: string;
      /** The base directory, already resolved (it may be reached through an in-root link). */
      readonly resolved: ResolvedPath | null;
      /** lstat of the sub-directory when it was listed: what PathGuard must resolve to now. */
      readonly dev: number;
      readonly ino: number;
    }
    const baseIdentity = options.base.identity;
    const stack: StackItem[] = [{ name: '', refPath: options.base.ref.path, resolved: options.base, dev: baseIdentity?.dev ?? -1, ino: baseIdentity?.ino ?? -1 }];
    const baseOptions = { principal: options.principal, mustExist: true, allowRoot: true };
    const dirOptions = { ...baseOptions, finalSymlink: 'deny' as const };
    while (stack.length > 0 && !cancelled) {
      const dir = stack.pop() as StackItem;
      const guardOptions = dir.resolved ? baseOptions : dirOptions;
      let resolved: ResolvedPath;
      try {
        resolved = dir.resolved ?? (await options.paths.resolve({ root, path: dir.refPath }, guardOptions));
      } catch (err) {
        skip(dir.name, `unreadable-dir:${isPathDeniedError(err) ? err.reason : 'vanished'}`);
        continue;
      }
      // The same object as listed (compared by inode: the request spelling is NFC, the disk's may be NFD).
      if (resolved.identity?.kind !== 'dir' || resolved.identity.dev !== dir.dev || resolved.identity.ino !== dir.ino) {
        if (dir.name !== '') skip(dir.name, 'unreadable-dir:changed');
        continue;
      }
      let names: string[];
      try {
        names = await readdir(resolved.realPath);
        await options.paths.revalidate(resolved, guardOptions);
      } catch (err) {
        if (dir.name !== '') skip(dir.name, `unreadable-dir:${isPathDeniedError(err) ? err.reason : (errnoCode(err) ?? 'error')}`);
        else throw err;
        continue;
      }
      names.sort();
      let added = 0;
      const subdirs: StackItem[] = [];
      for (const name of names) {
        if (cancelled) return;
        if (isHiddenTempName(name)) continue;
        if (dir.name === '' && options.excludeTopSmurg && isSmurgDirName(name)) continue;
        const zipName = joinRel(dir.name, name);
        const checked = checkRelPath(name);
        if (!checked.ok || checked.path.includes('/') || name.includes('\\')) {
          const shown = reportableName(name);
          if (shown !== null) skip(joinRel(dir.name, shown), 'invalid-name');
          continue;
        }
        const abs = join(resolved.realPath, name);
        let st;
        try {
          st = await lstat(abs);
        } catch (err) {
          skip(zipName, `vanished:${errnoCode(err) ?? 'error'}`);
          continue;
        }
        const refPath = joinRel(dir.refPath, checked.path);
        // SEC-D-03: the host's private data (.git, .envrc, personal Claude Code files) is not packed for a non-host.
        if (!options.privileged && isHostPrivatePath(refPath)) {
          skip(zipName, 'host-private');
          continue;
        }
        if (st.isDirectory()) {
          subdirs.push({ name: zipName, refPath, resolved: null, dev: st.dev, ino: st.ino });
        } else if (st.isFile()) {
          if (!options.privileged && st.nlink > 1) {
            skip(zipName, 'hard-link');
            continue;
          }
          const item: WalkFile = { kind: 'file', name: zipName, refPath, mtime: st.mtime, mode: st.mode, size: st.size, dev: st.dev, ino: st.ino };
          if (st.size >= largeEntryBytes) deferred.push(item);
          else addFile(item);
          added++;
        } else if (st.isSymbolicLink()) {
          let target: string;
          try {
            target = await readlink(abs);
          } catch (err) {
            skip(zipName, `vanished:${errnoCode(err) ?? 'error'}`);
            continue;
          }
          if (!(await linkStaysInside(abs, target, baseReal))) {
            skip(zipName, 'symlink-outside-folder');
            continue;
          }
          zip.addBuffer(Buffer.from(target), zipName, { mtime: st.mtime, mode: 0o120777, compress: false });
          added++;
        } else {
          skip(zipName, 'special-file');
        }
      }
      if (added === 0 && subdirs.length === 0 && dir.name !== '') {
        const st = resolved.identity;
        zip.addEmptyDirectory(dir.name, { mtime: new Date(st.mtimeMs), mode: (st.mode & 0o7777) | 0o040000 });
      }
      for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i] as StackItem);
    }
    for (const item of deferred) if (!cancelled) addFile(item);
    if (!cancelled) zip.end({ forceZip64Format: false, comment: '' });
  };

  walk().catch(fail);

  return {
    output,
    skipped,
    get zip64() {
      return zip64;
    },
    cancel(): void {
      cancelled = true;
      for (const stream of openStreams) stream.destroy();
      openStreams.clear();
      fail(new SmurgError('internal', undefined, { reason: 'cancelled' }));
    },
  };
}

/** A relative link whose target (lexically, and after resolving what exists) stays inside the zipped folder. */
async function linkStaysInside(linkAbs: string, target: string, baseReal: string): Promise<boolean> {
  if (target === '' || isAbsolute(target)) return false;
  const lexical = resolvePath(dirname(linkAbs), target);
  if (!isInside(lexical, baseReal) || lexical === baseReal) return false;
  try {
    return isInside(await realpath(lexical), baseReal);
  } catch {
    return true; // dangling but lexically inside: harmless to store
  }
}
