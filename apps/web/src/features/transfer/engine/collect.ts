// Turns what a drop or a file picker handed over into the list of files and folders to upload (SPEC R7: drag files
// or folders onto the file tree, the folder structure is kept; transfer.md §1.9). Runs on the MAIN thread:
// FileSystemEntry objects cannot be posted to a Worker, File objects can (structured clone, transfer.md F20), so the
// Worker only ever receives Files.
//
// Rules (all from the research, verified in Chrome / WebKit / Firefox):
// - entries are walked with createReader().readEntries() CALLED AGAIN UNTIL IT RETURNS AN EMPTY BATCH (Chromium
//   returns at most 100 per call);
// - empty folders are kept (a drop keeps them; `<input webkitdirectory>` cannot, gotcha 6);
// - names are passed through by browsers as stored, NFD on macOS: every path is normalised to NFC (gotcha 7);
// - every path is checked with the protocol's lexical rules before it is sent; names the host would refuse anyway
//   (a backslash or a control character is legal in a Linux file name) are reported instead of failing the batch.
import { checkRelPath, type RelPathProblem } from '@smurg/protocol';
import type { UploadSource } from '../../../lib/commands.ts';

export interface CollectedFile {
  readonly kind: 'file';
  /** Relative to the drop target, NFC, `/`-separated. */
  readonly path: string;
  readonly file: File;
}

export interface CollectedDir {
  readonly kind: 'dir';
  readonly path: string;
}

export type CollectedItem = CollectedFile | CollectedDir;

export interface RejectedItem {
  readonly path: string;
  readonly problem: RelPathProblem | 'duplicate' | 'unreadable';
}

export interface Collection {
  /** Folders before their contents (depth-first, in the order the browser listed them). */
  readonly items: readonly CollectedItem[];
  readonly rejected: readonly RejectedItem[];
  /** Names of what was dropped or picked at the top level (the job's display name). */
  readonly topNames: readonly string[];
  readonly fileCount: number;
  readonly totalBytes: number;
  /**
   * Top-level FileSystemHandles by NFC name (Chromium drops only): kept in the upload journal so a reload can resume
   * without picking the files again (after the person grants read permission).
   */
  readonly handles: ReadonlyMap<string, FileSystemHandle>;
}

/** The minimal shape of the entry API (lib.dom types), so tests can build trees without a browser. */
interface EntryLike {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}
interface FileEntryLike extends EntryLike {
  file(success: (file: File) => void, failure?: (error: unknown) => void): void;
}
interface DirectoryEntryLike extends EntryLike {
  createReader(): { readEntries(success: (entries: EntryLike[]) => void, failure?: (error: unknown) => void): void };
}

class Collector {
  readonly items: CollectedItem[] = [];
  readonly rejected: RejectedItem[] = [];
  private readonly seen = new Set<string>();

  /** Adds `path` (raw, from the browser) as `kind`; returns the accepted NFC path or null. */
  accept(rawPath: string, kind: 'file' | 'dir', file?: File): string | null {
    const check = checkRelPath(rawPath);
    if (!check.ok) {
      this.rejected.push({ path: rawPath.normalize('NFC'), problem: check.problem });
      return null;
    }
    // NFC twins (possible on Linux, where NFC and NFD names are different files) would collide on the host.
    if (this.seen.has(check.path)) {
      if (kind === 'dir' && this.items.some((item) => item.kind === 'dir' && item.path === check.path)) return check.path;
      this.rejected.push({ path: check.path, problem: 'duplicate' });
      return null;
    }
    this.seen.add(check.path);
    this.items.push(kind === 'dir' ? { kind, path: check.path } : { kind, path: check.path, file: file as File });
    return check.path;
  }

  result(topNames: string[], handles: Map<string, FileSystemHandle>): Collection {
    let fileCount = 0;
    let totalBytes = 0;
    for (const item of this.items) {
      if (item.kind !== 'file') continue;
      fileCount++;
      totalBytes += item.file.size;
    }
    return { items: this.items, rejected: this.rejected, topNames, fileCount, totalBytes, handles };
  }
}

function readBatch(reader: ReturnType<DirectoryEntryLike['createReader']>): Promise<EntryLike[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileOf(entry: FileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walkEntry(entry: EntryLike, parent: string, collector: Collector): Promise<void> {
  const raw = parent === '' ? entry.name : `${parent}/${entry.name}`;
  if (entry.isFile) {
    let file: File;
    try {
      file = await fileOf(entry as FileEntryLike);
    } catch {
      // Permission lost, the file vanished after the drop: report it, upload the rest.
      collector.rejected.push({ path: raw.normalize('NFC'), problem: 'unreadable' });
      return;
    }
    collector.accept(raw, 'file', file);
    return;
  }
  if (!entry.isDirectory) return;
  const accepted = collector.accept(raw, 'dir');
  if (accepted === null) return; // an invalid folder name: nothing below it can be placed either
  const reader = (entry as DirectoryEntryLike).createReader();
  for (;;) {
    let batch: EntryLike[];
    try {
      batch = await readBatch(reader);
    } catch {
      collector.rejected.push({ path: accepted, problem: 'unreadable' });
      return;
    }
    if (batch.length === 0) break; // readEntries returns partial batches: only an empty one means "done"
    for (const child of batch) await walkEntry(child, accepted, collector);
  }
}

/** `<input type=file multiple [webkitdirectory]>`: paths from webkitRelativePath (empty folders are not listed). */
function collectFiles(files: readonly File[], collector: Collector): string[] {
  const top = new Set<string>();
  for (const file of files) {
    const raw = file.webkitRelativePath !== undefined && file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name;
    const path = collector.accept(raw, 'file', file);
    if (path !== null) top.add(path.split('/')[0] as string);
  }
  return [...top];
}

/**
 * Collects an UploadSource. Await it right away: the entries of a drop stay valid after the drop handler returned
 * (lib/drop.ts took them synchronously), but only for this page.
 */
export async function collectUploadSource(source: UploadSource): Promise<Collection> {
  const collector = new Collector();
  const handles = new Map<string, FileSystemHandle>();
  if (source.kind === 'files') return collector.result(collectFiles(source.files, collector), handles);
  const topNames: string[] = [];
  for (const entry of source.entries as readonly EntryLike[]) {
    await walkEntry(entry, '', collector);
    topNames.push(entry.name.normalize('NFC'));
  }
  const resolved = await Promise.all(source.handles.map((pending) => pending.catch(() => null)));
  for (const handle of resolved) if (handle) handles.set(handle.name.normalize('NFC'), handle);
  return collector.result(topNames, handles);
}
