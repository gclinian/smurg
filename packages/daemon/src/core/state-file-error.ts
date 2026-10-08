// A refusal of something under ~/.smurg/workspaces/<workspaceId>/ (ARCHITECTURE §7.1): every refusal has a KIND, so
// `smurg host` can say what happened and what to do, instead of one text for a file that is older, newer, damaged,
// open to others or simply not ours.
//
//   newer            the folder (its stamp `written-by.json`) or a document was written by a later smurg
//   insecure         a symlink, not a regular file, another owner, or group/other permission bits
//   cannot-open      the file is there and the system refused to open or write it (EACCES, EIO, …)
//   other-workspace  state.json names another workspace id
//   unreadable       not JSON, no shape any published smurg wrote, a file that must be there and is not, or a value
//                    an earlier smurg accepted and this one refuses
//
// The text of `message` is for the log. It never carries a value from the file: paths in the document and zod's own
// messages only, with control characters escaped (a key of the file can be anything).

import { LOG_UNSAFE_CHARACTER } from './logger.ts';

export const STATE_FILE_KINDS = ['newer', 'insecure', 'cannot-open', 'other-workspace', 'unreadable'] as const;
export type StateFileKind = (typeof STATE_FILE_KINDS)[number];

export const STATE_FILE_INSECURE_CAUSES = ['symlink', 'not-a-file', 'owner', 'mode'] as const;
export type StateFileInsecureCause = (typeof STATE_FILE_INSECURE_CAUSES)[number];

export const STATE_FILE_UNREADABLE_REASONS = ['not-json', 'no-known-shape', 'missing', 'carried-value-refused'] as const;
export type StateFileUnreadableReason = (typeof STATE_FILE_UNREADABLE_REASONS)[number];

/** A copy of a document as it was before an upgrade step rewrote it (`<name>.json.before-upgrade-from-<step>`). */
export interface StateFileCopy {
  readonly path: string;
  /** The step's name: the published version whose shape the copy holds (`0.4.0`). */
  readonly from: string;
  /** When the copy was made (its modification time, ms). */
  readonly at: number;
}

/** At most this many problems are carried (and logged); `moreProblems` counts the rest. */
export const STATE_FILE_PROBLEMS_MAX = 8;

export interface StateFileErrorInit {
  readonly kind: StateFileKind;
  /** The file. For `newer` decided by the stamp: the workspace folder. */
  readonly path: string;
  /** What happened, without the path (it is appended) and without values from the file. */
  readonly message: string;
  /** Every refused path of this kind found in phase 1; default: `[path]`. */
  readonly paths?: readonly string[];
  /** `insecure` only. */
  readonly cause?: StateFileInsecureCause;
  /** `insecure` with cause `mode`: the permission bits found (e.g. 0o644). */
  readonly mode?: number;
  /** `cannot-open` only: the errno code. */
  readonly errno?: string;
  /** `unreadable` only. */
  readonly reason?: StateFileUnreadableReason;
  /** `unreadable`: what is wrong, already escaped; cut to STATE_FILE_PROBLEMS_MAX here. */
  readonly problems?: readonly string[];
  /** `unreadable`: how many more problems there are than `problems` holds (added to what the cut removes). */
  readonly moreProblems?: number;
  /** The stamp's smurg version, when it could be read. */
  readonly writtenBy?: string;
  /** Kept copies beside the file, newest first. */
  readonly copies?: readonly StateFileCopy[];
  /** The system's own error (never shown; for the log's errno and for debugging). */
  readonly source?: unknown;
}

/**
 * Makes a text safe for a terminal and a log line: every character the log itself treats as unsafe (the C0 and C1
 * controls, DEL, the bidirectional controls, the line and paragraph separators, the invisible formatting characters:
 * LOG_UNSAFE_CHARACTER) is written as `\u{…}`. zod names unknown keys of a file as they are.
 */
export function escapeForTerminal(text: string): string {
  return text.replace(UNSAFE_GLOBAL, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);
}

const UNSAFE_GLOBAL = new RegExp(LOG_UNSAFE_CHARACTER.source, 'g');

export class StateFileError extends Error {
  readonly kind: StateFileKind;
  /** The file (for `newer` decided by the stamp: the workspace folder). */
  readonly path: string;
  /** Every refused path of this kind found in phase 1 (at least `path`). */
  readonly paths: readonly string[];
  /** `insecure`: what is wrong with the file. (Not the system's error: that is `source`.) */
  declare readonly cause?: StateFileInsecureCause;
  /** `insecure` with cause `mode`: the permission bits found. */
  readonly mode?: number;
  /** `cannot-open`: the errno code (EACCES, EIO, …). */
  readonly errno?: string;
  /** `unreadable`: why. */
  readonly reason?: StateFileUnreadableReason;
  /** `unreadable`: at most STATE_FILE_PROBLEMS_MAX problems, control characters escaped. */
  readonly problems: readonly string[];
  /** How many more problems there are. */
  readonly moreProblems: number;
  /** The stamp's smurg version, when it could be read. */
  readonly writtenBy?: string;
  /** Kept copies beside the file, newest first. */
  readonly copies: readonly StateFileCopy[];
  /** The system's own error behind this refusal, if any. */
  readonly source?: unknown;

  constructor(init: StateFileErrorInit) {
    super(`${init.message}: ${escapeForTerminal(init.path)}`);
    this.name = 'StateFileError';
    this.kind = init.kind;
    this.path = init.path;
    this.paths = Object.freeze(init.paths === undefined || init.paths.length === 0 ? [init.path] : [...init.paths]);
    if (init.cause !== undefined) this.cause = init.cause;
    if (init.mode !== undefined) this.mode = init.mode;
    if (init.errno !== undefined) this.errno = init.errno;
    if (init.reason !== undefined) this.reason = init.reason;
    const problems = init.problems ?? [];
    this.problems = Object.freeze(problems.slice(0, STATE_FILE_PROBLEMS_MAX));
    this.moreProblems = Math.max(0, init.moreProblems ?? 0) + Math.max(0, problems.length - STATE_FILE_PROBLEMS_MAX);
    if (init.writtenBy !== undefined) this.writtenBy = init.writtenBy;
    this.copies = Object.freeze([...(init.copies ?? [])]);
    if (init.source !== undefined) this.source = init.source;
  }

  /** The same refusal with what only the folder's reader knows (the stamp's writer, the kept copies, all paths). */
  with(more: Pick<StateFileErrorInit, 'paths' | 'writtenBy' | 'copies'>): StateFileError {
    const next = new StateFileError({
      kind: this.kind,
      path: this.path,
      message: this.bareMessage,
      paths: more.paths ?? this.paths,
      ...(this.cause === undefined ? {} : { cause: this.cause }),
      ...(this.mode === undefined ? {} : { mode: this.mode }),
      ...(this.errno === undefined ? {} : { errno: this.errno }),
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      problems: this.problems,
      moreProblems: this.moreProblems,
      ...((more.writtenBy ?? this.writtenBy) === undefined ? {} : { writtenBy: more.writtenBy ?? this.writtenBy }),
      copies: more.copies ?? this.copies,
      ...(this.source === undefined ? {} : { source: this.source }),
    });
    if (this.stack !== undefined) next.stack = this.stack;
    return next;
  }

  /** `message` without the path this class appends. */
  private get bareMessage(): string {
    const suffix = `: ${escapeForTerminal(this.path)}`;
    return this.message.endsWith(suffix) ? this.message.slice(0, -suffix.length) : this.message;
  }
}

export function errnoCodeOf(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

/** `(problem; problem; …; and N more)` for a log line and an error message. */
export function describeProblems(problems: readonly string[], more: number): string {
  const shown = problems.slice(0, STATE_FILE_PROBLEMS_MAX);
  const rest = more + (problems.length - shown.length);
  return rest > 0 ? `${shown.join('; ')}; and ${rest} more` : shown.join('; ');
}
