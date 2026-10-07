// Clickable file paths in terminal output (SPEC R7 "file paths in agent output can be clicked to open").
//
// A path is only ever a link when (1) it is relative — absolute paths, `~/…` and anything that climbs out of the
// session's root with `..` are refused, because the viewer must never be steered outside the shared tree (and the
// host's absolute layout is none of the viewer's business); (2) it resolves against the SESSION's root (the main
// workspace or its worktree: Claude Code prints paths relative to its cwd); and (3) it EXISTS in that tree — known from
// a loaded file-tree listing, else asked once with file.stat (cached). Everything uncertain is "not a link".
//
// The same logic finds the paths in a conversation's text (features/conversation/env.tsx). Every lookup of either
// goes through the connection's gate (see "the gate" below): reading must not turn into a stream of refused requests.
import { isHostPrivatePath, isSmurgDirName, isSmurgError, isValidRelPath, rootRefKey, type FileEntry, type FileRef, type RootRef } from '@smurg/protocol';
import { isClientRequestError } from '@smurg/protocol/client';
import type { IBufferRange, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { trimEndOf } from '../../lib/trim.ts';

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
      // Sentence punctuation after a path (a path followed by a CJK full stop is handled by the character class; "src/app.ts." here).
      const trimmed = trimEndOf(path, '.');
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

/**
 * Whether asking the host about `path` (a path normalizeSessionPath returned) can be anything but a refusal for this
 * viewer. The daemon hands the host-private names (everything inside a `.git`, any `.envrc`, the host's personal
 * Claude Code files) and its own `.smurg` folder to nobody but the host: it does not even say whether they exist,
 * writes the request into the audit log under the asker's name and counts it against the asker's connection. Text
 * that merely names such a file must not make the people who read it ask.
 */
export function mayAskAbout(path: string, viewer: { readonly isHost: boolean }): boolean {
  if (viewer.isHost) return true;
  return !isHostPrivatePath(path) && !isSmurgDirName(path.split('/', 1)[0] ?? '');
}

// ---- the gate
//
// A path in text someone else wrote (an agent's answer, a member's message, terminal output) is on the screen of
// everyone who reads it, and looking it up is a request of THAT reader to the host. The daemon answers a name the
// reader may not look at (the host's private files, a hard-linked file, a path through a file) like a name that is
// not there, and counts nothing. What it still REFUSES (a name through a link that leads out of the workspace, too
// many requests) it writes into the audit log under the asker's name, and it closes a connection that collects 60
// refusals in a minute. So every such lookup of a page goes through ONE gate per connection, and a text can cost its
// reader a handful of refused requests, never one per name:
//   - a name the reader's role can never open (mayAskAbout) is not asked about;
//   - at most MAX_LOOKUPS_IN_FLIGHT requests are out at a time, and only ONE until the host has answered one without
//     refusing, and again after every refusal;
//   - a refused path is never asked about again. The names that wait are still asked: one refused name turns no
//     other link of the page off;
//   - at most REFUSALS_PER_MINUTE refusals in any REFUSAL_WINDOW_MS. When that many have come back, everything that
//     waits is answered without a request, and nothing is asked until the oldest of them is that old. (With the
//     requests that were out when the last one came back: at most REFUSALS_PER_MINUTE + MAX_LOOKUPS_IN_FLIGHT - 1.)

/** Lookups that may be on their way to the host at one time, once the host has answered one without refusing. */
export const MAX_LOOKUPS_IN_FLIGHT = 4;
/** Refused lookups a page may collect … */
export const REFUSALS_PER_MINUTE = 8;
/** … in any stretch of this length: far below what closes a connection, with room for other refusals of the same reader. */
export const REFUSAL_WINDOW_MS = 60_000;
/** The error codes the daemon counts as a refusal (and audits under the asker's name): not "there is no such file". */
const REFUSALS: ReadonlySet<string> = new Set(['path_denied', 'forbidden', 'host_only', 'unauthorized', 'rate_limited']);
/** How many refused paths are remembered (the oldest are forgotten first). */
const REFUSED_PATHS_MAX = 4_096;

/** A lookup the gate did not send: the path stays text. */
export class PathNotAskedError extends Error {
  constructor() {
    super('This path is not asked about.');
    this.name = 'PathNotAskedError';
  }
}

export interface PathGate {
  /** `file.stat` for a path that some text names. Rejects without a request when the rules above say not to ask. */
  stat(ref: FileRef, viewer: { readonly isHost: boolean }): Promise<FileEntry>;
}

export interface PathGateOptions {
  /** file.stat (rejects when it does not exist or may not be read). */
  stat(ref: FileRef): Promise<FileEntry>;
  now(): number;
}

export function createPathGate(options: PathGateOptions): PathGate {
  interface Waiting {
    readonly ref: FileRef;
    resolve(entry: FileEntry): void;
    reject(error: unknown): void;
  }
  const keyOf = (ref: FileRef): string => `${rootRefKey(ref.root)}\u0000${ref.path}`;
  const refused = new Set<string>();
  const line: Waiting[] = [];
  let inFlight = 0;
  /** How many requests may be out: one until an answer that is not a refusal, one again after every refusal. */
  let width = 1;
  /** When each refusal of the last REFUSAL_WINDOW_MS came back, oldest first. */
  const refusals: number[] = [];

  /** Whether the refusals of the last minute leave room for another request. */
  const mayAsk = (): boolean => {
    const now = options.now();
    while (refusals.length > 0 && now - (refusals[0] as number) >= REFUSAL_WINDOW_MS) refusals.shift();
    return refusals.length < REFUSALS_PER_MINUTE;
  };

  const send = (): void => {
    if (line.length > 0 && !mayAsk()) {
      for (const waiting of line.splice(0)) waiting.reject(new PathNotAskedError());
      return;
    }
    while (inFlight < width && line.length > 0) {
      const next = line.shift() as Waiting;
      inFlight += 1;
      options.stat(next.ref).then(
        (entry) => {
          inFlight -= 1;
          width = MAX_LOOKUPS_IN_FLIGHT;
          next.resolve(entry);
          send();
        },
        (error: unknown) => {
          inFlight -= 1;
          if (isSmurgError(error) && REFUSALS.has(error.code)) {
            if (refused.size >= REFUSED_PATHS_MAX) refused.delete(refused.values().next().value as string);
            refused.add(keyOf(next.ref));
            refusals.push(options.now());
            width = 1;
          } else if (isSmurgError(error) && !isClientRequestError(error)) {
            // The host answered ("there is no such file"): the names that wait may be asked. A request that this
            // side gave up on (no answer in time, the connection went away) is no answer of the host.
            width = MAX_LOOKUPS_IN_FLIGHT;
          }
          next.reject(error);
          send();
        },
      );
    }
  };

  return {
    stat(ref, viewer) {
      if (!mayAskAbout(ref.path, viewer) || refused.has(keyOf(ref)) || !mayAsk()) return Promise.reject(new PathNotAskedError());
      return new Promise<FileEntry>((resolve, reject) => {
        line.push({ ref, resolve, reject });
        send();
      });
    },
  };
}

const gates = new WeakMap<object, PathGate>();

/** The gate of a connection: one per files store, shared by every conversation and terminal of the page. */
export function pathGateOf(files: { stat(ref: FileRef): Promise<FileEntry> }): PathGate {
  let gate = gates.get(files);
  if (gate === undefined) {
    gate = createPathGate({ stat: (ref) => files.stat(ref), now: () => Date.now() });
    gates.set(files, gate);
  }
  return gate;
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
      const promise = options.stat(ref).then(
        (entry) => {
          const kind = kindOf(entry);
          cache.set(key, { kind, at: options.now() });
          inflight.delete(key);
          return kind;
        },
        (error: unknown) => {
          // A lookup the gate did not send says nothing about the path: it is asked again the next time.
          if (!(error instanceof PathNotAskedError)) cache.set(key, { kind: null, at: options.now() });
          inflight.delete(key);
          return null;
        },
      );
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
