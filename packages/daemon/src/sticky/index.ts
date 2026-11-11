// The index of the sticky notes (DESIGN 0.8.0 D2.2): every file `notes/<Name>.md` of the main workspace, in memory,
// with the names it links to and its flags, and nothing else of its content. Members who may read files see it
// through `sticky.list` and are told what changed through `sticky.changed` (service.ts).
//
// It is built by listing `notes/` when the module starts (no `notes/`, or one that is not a real folder: an empty
// index, nothing read), and kept up to date from the watcher's `file.changed` (and the editor's `doc.saved`), after a
// short quiet period like the topics' files: every update lists the folder again (one `readdir`) and reads again only
// the notes that changed or are new; it reads every note again when `notes` itself appeared or went, and after the
// watcher reported an error (it may have missed changes). `sticky.create` asks for its new note at once.
//
// Each note is read as a member without rights would read it, never as the daemon itself: PathGuard with a Viewer's
// principal, no symlink at the end, a regular file with one link (PathGuard refuses a hard link to anyone but the host
// and the daemon), resolved to the file of that name directly in the real `notes/`. A file that fails is listed by its
// name, `unreadable`, with no links; so is one that is not UTF-8. A file over NOTE_MAX_BYTES is `oversized`, not read.
// Of two names that fold equal (possible on Linux) the one that sorts first, code unit by code unit, is the note and
// the other is `shadowed`, not read. A name that is no note's (`noteNameOf`) is counted, `invalid`. At most NOTES_MAX
// notes, the first by name; more are counted, `truncated`. Every read is asynchronous.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAIN_ROOT,
  NOTES_DIR,
  NOTES_MAX,
  NOTE_MAX_BYTES,
  foldNoteName,
  isHiddenTempName,
  noteNameOf,
  notePath,
  wikiLinks,
  type NoteInfo,
} from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { Principal } from '../core/interfaces.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';

/**
 * Who the index reads as: a member without rights (a Viewer). PathGuard hides `.smurg` from it and refuses it a hard
 * link, as for every member but the host. It is nobody: no audit entry is written for what it is refused.
 */
export const INDEX_READER: Principal = Object.freeze({ kind: 'user', actor: SYSTEM_ACTOR, userId: null, role: 'viewer' });

/** Reads of notes at the same time (a listing of NOTES_MAX notes reads them in turns of this many). */
const READS_AT_ONCE = 8;

/** What reading one note gave. */
type ReadResult = { readonly links: readonly string[] } | 'oversized' | 'unreadable';

/** One change of the index as `sticky.changed` carries it. */
export interface IndexChange {
  readonly upserted: readonly NoteInfo[];
  readonly removed: readonly string[];
  readonly truncated: boolean;
}

export interface NoteIndexOptions {
  /** The quiet period after a change on disk before the index lists and reads again. */
  readonly debounceMs: number;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * The links of a note's bytes (`wikiLinks` of its text, a leading byte order mark dropped), or null when the bytes are
 * not UTF-8. What the index does with every note it reads; in proportion to the text (text-cost.test.ts).
 */
export function linksOfNote(bytes: Uint8Array): string[] | null {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return null;
  }
  return wikiLinks(text);
}

export class NoteIndex {
  private readonly ctx: DaemonContext;
  private readonly options: NoteIndexOptions;
  private readonly announce: (change: IndexChange) => void;
  /** What members see: by the name on disk, in order. */
  private notes = new Map<string, NoteInfo>();
  /** By folded name, the name on disk of the note (never of a shadowed file). */
  private byKey = new Map<string, string>();
  private truncatedNow = false;
  private invalidNow = 0;
  /** What reading each note gave, until it changes. */
  private readonly read = new Map<string, ReadResult>();
  /** Names that changed on disk since the last update; `everything`: read every note again. */
  private changed = new Set<string>();
  private everything = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private updates = 0;

  constructor(ctx: DaemonContext, options: NoteIndexOptions, announce: (change: IndexChange) => void) {
    this.ctx = ctx;
    this.options = options;
    this.announce = announce;
  }

  /** The index in its order (by name, code unit by code unit). */
  list(): NoteInfo[] {
    return [...this.notes.values()];
  }

  /** The note `name` folds to (D1.3), or null. */
  find(name: string): NoteInfo | null {
    const onDisk = this.byKey.get(foldNoteName(name));
    return onDisk === undefined ? null : (this.notes.get(onDisk) ?? null);
  }

  /** `notes/` holds more notes than NOTES_MAX: the rest are not listed. */
  truncated(): boolean {
    return this.truncatedNow;
  }

  /** Entries of `notes/` that are no sticky note (D1.5), at the last listing. */
  invalid(): number {
    return this.invalidNow;
  }

  /** How many listings the index has made (tests wait for the one after a change). */
  listings(): number {
    return this.updates;
  }

  /** The first listing (the module's start): nothing is announced. */
  load(): Promise<void> {
    return this.enqueue(false);
  }

  /** Paths of the main workspace that changed on disk (the watcher, a save of the editor). */
  onChanged(paths: Iterable<string>): void {
    let relevant = false;
    for (const path of paths) {
      if (path === NOTES_DIR) {
        this.everything = true;
        relevant = true;
        continue;
      }
      if (!path.startsWith(`${NOTES_DIR}/`)) continue;
      const rest = path.slice(NOTES_DIR.length + 1);
      // Only the folder's own entries can be notes; a change below a folder in notes/ changes no note.
      if (rest.includes('/')) continue;
      this.changed.add(rest);
      relevant = true;
    }
    if (relevant) this.schedule();
  }

  /** The watcher may have missed changes: everything is read again. */
  onWatcherError(): void {
    this.everything = true;
    this.schedule();
  }

  /** Lists and reads again now, after whatever is under way (sticky.create, for the note it just made). */
  refreshNow(): Promise<void> {
    return this.enqueue(true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.queue;
  }

  private schedule(): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue(true);
    }, this.options.debounceMs);
    this.timer.unref?.();
  }

  /** One update at a time, in order. */
  private enqueue(announce: boolean): Promise<void> {
    const next = this.queue.then(async () => {
      if (this.stopped) return;
      try {
        await this.update(announce);
      } catch (err) {
        // Kept as it was; the next change reads everything again.
        this.everything = true;
        this.ctx.log.error('sticky notes not listed', { module: 'sticky', error: err instanceof Error ? err.name : 'unknown' });
      }
    });
    this.queue = next;
    return next;
  }

  private async update(announce: boolean): Promise<void> {
    const everything = this.everything;
    const changed = this.changed;
    this.everything = false;
    this.changed = new Set();
    const folder = await this.folder();
    const entries = folder === null ? [] : await readdir(folder).catch(() => [] as string[]);
    let invalid = 0;
    const names: string[] = [];
    for (const entry of entries) {
      // smurg's and Claude Code's own temporary files while a note is written: no entry of anyone's.
      if (isHiddenTempName(entry)) continue;
      const name = noteNameOf(`${NOTES_DIR}/${entry}`);
      if (name === null) invalid += 1;
      else names.push(name);
    }
    // Code unit by code unit: the first of two fold twins is the note (D1.3), and the first NOTES_MAX are listed.
    names.sort();
    const kept = names.slice(0, NOTES_MAX);
    const byKey = new Map<string, string>();
    const toRead: string[] = [];
    for (const name of kept) {
      const key = foldNoteName(name);
      if (byKey.has(key)) continue;
      byKey.set(key, name);
      if (everything || changed.has(`${name}.md`) || !this.read.has(name)) toRead.push(name);
    }
    for (const name of [...this.read.keys()]) if (byKey.get(foldNoteName(name)) !== name) this.read.delete(name);
    for (let at = 0; at < toRead.length; at += READS_AT_ONCE) {
      const turn = toRead.slice(at, at + READS_AT_ONCE);
      const results = await Promise.all(turn.map((name) => this.readNote(folder as string, name)));
      turn.forEach((name, index) => this.read.set(name, results[index] as ReadResult));
    }
    const next = new Map<string, NoteInfo>();
    for (const name of kept) {
      if (byKey.get(foldNoteName(name)) !== name) {
        next.set(name, { name, links: [], shadowed: true });
        continue;
      }
      const result = this.read.get(name) ?? 'unreadable';
      if (result === 'oversized') next.set(name, { name, links: [], oversized: true });
      else if (result === 'unreadable') next.set(name, { name, links: [], unreadable: true });
      else next.set(name, { name, links: [...result.links] });
    }
    const truncated = names.length > NOTES_MAX;
    const upserted: NoteInfo[] = [];
    for (const [name, note] of next) {
      const before = this.notes.get(name);
      if (before === undefined || !sameNote(before, note)) upserted.push(note);
    }
    const removed = [...this.notes.keys()].filter((name) => !next.has(name));
    const truncatedChanged = truncated !== this.truncatedNow;
    this.notes = next;
    this.byKey = byKey;
    this.truncatedNow = truncated;
    this.invalidNow = invalid;
    this.updates += 1;
    if (announce && (upserted.length > 0 || removed.length > 0 || truncatedChanged)) this.announce({ upserted, removed, truncated });
  }

  /**
   * The real path of `notes` when it is a real folder of that very name at the top of the main workspace (not a
   * symlink, not `Notes` on a disk that ignores case), else null: then there are no notes.
   */
  private async folder(): Promise<string | null> {
    try {
      const resolved = await this.ctx.paths.resolve({ root: MAIN_ROOT, path: NOTES_DIR }, { principal: INDEX_READER, finalSymlink: 'self', audit: false });
      if (!resolved.exists || resolved.identity?.kind !== 'dir' || resolved.name !== NOTES_DIR) return null;
      return resolved.realPath;
    } catch {
      return null;
    }
  }

  /** One note, as a member without rights reads it. */
  private async readNote(folder: string, name: string): Promise<ReadResult> {
    const options = { principal: INDEX_READER, finalSymlink: 'deny' as const, audit: false, mustExist: true };
    try {
      const resolved = await this.ctx.paths.resolve({ root: MAIN_ROOT, path: notePath(name) }, options);
      const identity = resolved.identity;
      if (identity === null || identity.kind !== 'file' || identity.nlink !== 1) return 'unreadable';
      // The file of that name directly in the real notes/, nothing a link leads to.
      if (resolved.parentRealPath !== folder || resolved.realPath !== join(folder, `${name}.md`)) return 'unreadable';
      if (identity.size > NOTE_MAX_BYTES) return 'oversized';
      const file = await this.ctx.paths.openRead(resolved, options);
      try {
        if (file.identity.nlink !== 1) return 'unreadable';
        const buffer = Buffer.alloc(NOTE_MAX_BYTES + 1);
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await file.handle.read(buffer, filled, buffer.length - filled, filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        if (filled > NOTE_MAX_BYTES) return 'oversized';
        const links = linksOfNote(new Uint8Array(buffer.buffer, buffer.byteOffset, filled));
        return links === null ? 'unreadable' : { links };
      } finally {
        await file.close();
      }
    } catch {
      return 'unreadable';
    }
  }
}

function sameNote(a: NoteInfo, b: NoteInfo): boolean {
  return (
    a.oversized === b.oversized &&
    a.unreadable === b.unreadable &&
    a.shadowed === b.shadowed &&
    a.links.length === b.links.length &&
    a.links.every((link, index) => link === b.links[index]) &&
    (a.builds ?? []).join('\n') === (b.builds ?? []).join('\n')
  );
}
