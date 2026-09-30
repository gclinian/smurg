// Clickable file paths in terminal output (SPEC R7 「agent 輸出裡的檔案路徑可以點擊開啟」).
//
// A path is only ever a link when (1) it is relative — absolute paths, `~/…` and anything that climbs out of the
// session's root with `..` are refused, because the viewer must never be steered outside the shared tree (and the
// host's absolute layout is none of the viewer's business); (2) it resolves against the SESSION's root (the main
// workspace or its worktree: Claude Code prints paths relative to its cwd); and (3) it EXISTS in that tree — known from
// a loaded file-tree listing, else asked once with file.stat (cached). Everything uncertain is "not a link".
import { isValidRelPath, rootRefKey, type FileEntry, type FileRef, type RootRef } from '@smurg/protocol';
import type { IBufferRange, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

export interface PathCandidate {
  /** What was matched, including a `:line[:column]` suffix. */
  readonly text: string;
  /** The path part, as printed. */
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  /** UTF-16 index range in the line string (end exclusive). */
  readonly start: number;
  readonly end: number;
}

// One path segment: letters (any script), digits and the usual file-name punctuation; may start with one dot
// (`.env`, `.github`).
const SEGMENT = String.raw`\.?[\p{L}\p{N}_@+~\-][\p{L}\p{N}_.@+~\-]*`;
// Not glued to a word, a path or a URL on its left (`/etc/x` and `https://a/b.js` never yield a candidate).
const PATH_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.\/@+~:\\\-])((?:\.{1,2}\/)*(?:${SEGMENT}\/)*${SEGMENT})(?::(\d{1,7})(?::(\d{1,7}))?)?`,
  'gu',
);
/** A bare name (no slash) counts only with an extension that has a letter: `README.md`, not `2.1.283`. */
const NAME_WITH_EXTENSION = /(?:^|\/)[^/]*[^/.]\.\p{L}[\p{L}\p{N}]{0,15}$|(?:^|\/)\.[\p{L}][^/]*$/u;
/**
 * Bare names this short are prose far more often than files (`e.g`, `i.e`, `a.m`): not worth a file.stat per line.
 * A three-character file name printed without a folder (`a.c`) is the price.
 */
const MIN_BARE_NAME_CHARS = 4;
const HAS_LETTER = /\p{L}/u;

/** At most this many candidates per terminal line are looked up. */
export const MAX_LINKS_PER_LINE = 16;

/** Path-looking substrings of one line of terminal output. */
export function findPathCandidates(line: string): PathCandidate[] {
  const found: PathCandidate[] = [];
  for (const match of line.matchAll(PATH_PATTERN)) {
    let path = match[1] ?? '';
    const lineNo = match[2];
    const column = match[3];
    const start = match.index;
    let end = start + match[0].length;
    if (lineNo === undefined) {
      // Sentence punctuation after a path (「見 src/app.ts。」 is handled by the character class; "src/app.ts." here).
      const trimmed = path.replace(/\.+$/, '');
      end -= path.length - trimmed.length;
      path = trimmed;
    }
    if (path === '' || !HAS_LETTER.test(path)) continue;
    if (!path.includes('/') && (!NAME_WITH_EXTENSION.test(path) || path.length < MIN_BARE_NAME_CHARS)) continue;
    if (path.includes('/') && path.endsWith('/')) continue;
    found.push({
      text: line.slice(start, end),
      path,
      ...(lineNo !== undefined ? { line: Number(lineNo) } : {}),
      ...(column !== undefined ? { column: Number(column) } : {}),
      start,
      end,
    });
  }
  return found;
}

/**
 * The root-relative path `raw` names, or null when it must not become a link: absolute, home-relative, climbing out
 * of the root, the root itself, or not a valid protocol path.
 */
export function normalizeSessionPath(raw: string): string | null {
  if (raw === '' || raw.startsWith('/') || raw.startsWith('~') || raw.includes('\\')) return null;
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null; // outside the tree
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const path = segments.join('/');
  if (path === '' || !isValidRelPath(path)) return null;
  return path;
}

/** The file `candidate` names inside the session's root, or null (see normalizeSessionPath). */
export function resolveCandidate(root: RootRef, candidate: Pick<PathCandidate, 'path'>): FileRef | null {
  const path = normalizeSessionPath(candidate.path);
  return path === null ? null : { root, path };
}

export type LinkTargetKind = 'file' | 'dir';

export interface PathExistenceOptions {
  /** The entry from an already loaded listing: an entry, `null` = its folder is loaded and it is not there, `undefined` = unknown. */
  lookup(ref: FileRef): FileEntry | null | undefined;
  /** file.stat (rejects when it does not exist or may not be read). */
  stat(ref: FileRef): Promise<FileEntry>;
  now(): number;
  /** How long an answer is reused (ms). */
  ttlMs?: number;
}

export interface PathExistence {
  /** 'file' / 'dir' when `ref` exists and can be opened; null otherwise (never throws). */
  check(ref: FileRef): Promise<LinkTargetKind | null>;
  /** Forget cached answers (after file changes). */
  clear(): void;
}

function kindOf(entry: FileEntry | null | undefined): LinkTargetKind | null {
  if (!entry) return null;
  // A symlink (e.g. a shared read-only folder in a worktree) is not opened from terminal output: fail closed.
  return entry.kind === 'file' ? 'file' : entry.kind === 'dir' ? 'dir' : null;
}

export function createPathExistence(options: PathExistenceOptions): PathExistence {
  const ttl = options.ttlMs ?? 30_000;
  const cache = new Map<string, { kind: LinkTargetKind | null; at: number }>();
  const inflight = new Map<string, Promise<LinkTargetKind | null>>();
  const keyOf = (ref: FileRef): string => `${rootRefKey(ref.root)}\u0000${ref.path}`;
  return {
    check(ref) {
      const known = options.lookup(ref);
      if (known !== undefined) return Promise.resolve(kindOf(known));
      const key = keyOf(ref);
      const cached = cache.get(key);
      if (cached && options.now() - cached.at < ttl) return Promise.resolve(cached.kind);
      const running = inflight.get(key);
      if (running) return running;
      const promise = options
        .stat(ref)
        .then(
          (entry) => kindOf(entry),
          () => null,
        )
        .then((kind) => {
          cache.set(key, { kind, at: options.now() });
          inflight.delete(key);
          return kind;
        });
      inflight.set(key, promise);
      return promise;
    },
    clear() {
      cache.clear();
    },
  };
}

// ---- xterm.js

interface LineText {
  readonly text: string;
  /** Per UTF-16 unit of `text`: its cell (0-based) and that cell's width. */
  readonly cells: readonly number[];
  readonly widths: readonly number[];
}

/** The text of buffer line `y` (1-based) with the cell of every character (CJK characters take two cells). */
export function readBufferLine(term: Pick<Terminal, 'buffer'>, y: number): LineText | null {
  const line = term.buffer.active.getLine(y - 1);
  if (!line) return null;
  let text = '';
  const cells: number[] = [];
  const widths: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    const width = cell.getWidth();
    if (width === 0) continue; // the right half of a wide character
    const chars = cell.getChars() || ' ';
    for (let i = 0; i < chars.length; i++) {
      text += chars[i];
      cells.push(x);
      widths.push(width);
    }
  }
  return { text, cells, widths };
}

export interface PathLinkProviderOptions {
  /** The session's root at the time of the lookup. */
  root(): RootRef;
  exists(ref: FileRef): Promise<LinkTargetKind | null>;
  activate(target: { readonly ref: FileRef; readonly kind: LinkTargetKind; readonly line?: number; readonly column?: number }, event: MouseEvent): void;
}

export function createPathLinkProvider(term: Pick<Terminal, 'buffer'>, options: PathLinkProviderOptions): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = readBufferLine(term, y);
      if (!line) {
        callback(undefined);
        return;
      }
      const root = options.root();
      const candidates = findPathCandidates(line.text).slice(0, MAX_LINKS_PER_LINE);
      const lookups = candidates.map(async (candidate): Promise<ILink | null> => {
        const ref = resolveCandidate(root, candidate);
        if (!ref) return null;
        const kind = await options.exists(ref);
        if (!kind) return null;
        const first = line.cells[candidate.start];
        const last = line.cells[candidate.end - 1];
        const lastWidth = line.widths[candidate.end - 1] ?? 1;
        if (first === undefined || last === undefined) return null;
        const range: IBufferRange = { start: { x: first + 1, y }, end: { x: last + lastWidth, y } };
        return {
          range,
          text: candidate.text,
          decorations: { underline: true, pointerCursor: true },
          activate: (event) => {
            options.activate(
              {
                ref,
                kind,
                ...(candidate.line !== undefined ? { line: candidate.line } : {}),
                ...(candidate.column !== undefined ? { column: candidate.column } : {}),
              },
              event,
            );
          },
        };
      });
      void Promise.all(lookups).then(
        (links) => {
          const present = links.filter((link): link is ILink => link !== null);
          callback(present.length > 0 ? present : undefined);
        },
        () => callback(undefined),
      );
    },
  };
}
