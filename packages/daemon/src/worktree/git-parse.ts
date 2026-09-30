// Parsers of git's NUL-separated (-z) machine output. Pure functions (unit-tested without git). Paths come back as
// the bytes git printed, decoded strictly as UTF-8: a name that is not valid UTF-8 cannot be shown to the host, and a
// merge the host cannot review completely is refused (fail closed), never shown with a replacement character.
import { MERGE_FILE_STATUSES, SmurgError, checkRelPath } from '@smurg/protocol';

export type MergeFileStatus = (typeof MERGE_FILE_STATUSES)[number];

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Splits -z output into fields (a trailing empty field is dropped). */
export function splitNul(output: Uint8Array): Buffer[] {
  const buffer = Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  const fields: Buffer[] = [];
  let start = 0;
  for (;;) {
    const end = buffer.indexOf(0, start);
    if (end === -1) {
      if (start < buffer.length) fields.push(buffer.subarray(start));
      break;
    }
    fields.push(buffer.subarray(start, end));
    start = end + 1;
  }
  return fields;
}

export class UnsupportedPathError extends SmurgError {
  constructor(problem: string) {
    super('conflict', '變更中有無法顯示的檔名，無法審核這個合併請求', { reason: 'unsupported-path', problem });
    this.name = 'UnsupportedPathError';
  }
}

/**
 * A path as git printed it: `raw` is what goes back to git (after `--`), `path` its protocol spelling (NFC, checked
 * with the protocol's relative-path rules, which is what clients send back in worktree.merge.fileDiff).
 */
export interface GitPath {
  readonly raw: string;
  readonly path: string;
}

export function decodeGitPath(bytes: Uint8Array): GitPath {
  let raw: string;
  try {
    raw = STRICT_UTF8.decode(bytes);
  } catch {
    throw new UnsupportedPathError('not-utf8');
  }
  const checked = checkRelPath(raw);
  if (!checked.ok) throw new UnsupportedPathError(checked.problem);
  return { raw, path: checked.path };
}

export interface RawDiffEntry {
  readonly srcMode: string;
  readonly dstMode: string;
  readonly srcOid: string;
  readonly dstOid: string;
  /** A, C, D, M, R, T, U, X, … (the score is dropped). */
  readonly letter: string;
  readonly status: MergeFileStatus;
  readonly path: GitPath;
  /** Renames and copies. */
  readonly oldPath?: GitPath;
}

export function statusOfLetter(letter: string): MergeFileStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type-changed';
    case 'U':
      return 'unmerged';
    default:
      return 'unknown';
  }
}

const RAW_HEADER = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([A-Z])(\d{0,3})$/;

/** `git diff --raw -z --no-abbrev`: `:<m1> <m2> <o1> <o2> <S>[score]\0<path>\0[<path2>\0]`. */
export function parseRawDiff(output: Uint8Array): RawDiffEntry[] {
  const fields = splitNul(output);
  const entries: RawDiffEntry[] = [];
  for (let i = 0; i < fields.length; ) {
    const header = RAW_HEADER.exec((fields[i] as Buffer).toString('latin1'));
    if (!header) throw new SmurgError('internal', '無法解析 git 的輸出', { reason: 'git-output-unparsable' });
    const letter = header[5] as string;
    const twoPaths = letter === 'R' || letter === 'C';
    const first = fields[i + 1];
    const second = twoPaths ? fields[i + 2] : undefined;
    if (first === undefined || (twoPaths && second === undefined)) throw new SmurgError('internal', '無法解析 git 的輸出', { reason: 'git-output-unparsable' });
    const base = {
      srcMode: header[1] as string,
      dstMode: header[2] as string,
      srcOid: header[3] as string,
      dstOid: header[4] as string,
      letter,
      status: statusOfLetter(letter),
    };
    entries.push(twoPaths ? { ...base, oldPath: decodeGitPath(first), path: decodeGitPath(second as Buffer) } : { ...base, path: decodeGitPath(first) });
    i += twoPaths ? 3 : 2;
  }
  return entries;
}

export interface NumstatEntry {
  /** null for binary files (git prints `-`). */
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly path: GitPath;
  readonly oldPath?: GitPath;
}

/** `git diff --numstat -z`: `<a>\t<d>\t<path>\0`, renames `<a>\t<d>\t\0<old>\0<new>\0`. */
export function parseNumstat(output: Uint8Array): NumstatEntry[] {
  const fields = splitNul(output);
  const entries: NumstatEntry[] = [];
  const count = (text: string): number | null => (text === '-' ? null : /^\d{1,12}$/.test(text) ? Number(text) : Number.NaN);
  for (let i = 0; i < fields.length; ) {
    const field = fields[i] as Buffer;
    const firstTab = field.indexOf(9);
    const secondTab = firstTab === -1 ? -1 : field.indexOf(9, firstTab + 1);
    if (secondTab === -1) throw new SmurgError('internal', '無法解析 git 的輸出', { reason: 'git-output-unparsable' });
    const additions = count(field.subarray(0, firstTab).toString('latin1'));
    const deletions = count(field.subarray(firstTab + 1, secondTab).toString('latin1'));
    if (Number.isNaN(additions) || Number.isNaN(deletions)) throw new SmurgError('internal', '無法解析 git 的輸出', { reason: 'git-output-unparsable' });
    const rest = field.subarray(secondTab + 1);
    if (rest.length > 0) {
      entries.push({ additions, deletions, path: decodeGitPath(rest) });
      i += 1;
    } else {
      const old = fields[i + 1];
      const next = fields[i + 2];
      if (old === undefined || next === undefined) throw new SmurgError('internal', '無法解析 git 的輸出', { reason: 'git-output-unparsable' });
      entries.push({ additions, deletions, oldPath: decodeGitPath(old), path: decodeGitPath(next) });
      i += 3;
    }
  }
  return entries;
}

/** `git merge-tree --write-tree --name-only -z --no-messages`: `<tree>\0[<conflicted path>\0…]`. */
export function parseMergeTree(output: Uint8Array): { readonly tree: string; readonly conflicted: GitPath[] } {
  const fields = splitNul(output);
  const tree = fields[0]?.toString('latin1') ?? '';
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tree)) throw new SmurgError('internal', '無法解析 git 的輸出', { reason: 'git-output-unparsable' });
  const seen = new Set<string>();
  const conflicted: GitPath[] = [];
  for (const field of fields.slice(1)) {
    if (field.length === 0) continue;
    const path = decodeGitPath(field);
    if (seen.has(path.path)) continue;
    seen.add(path.path);
    conflicted.push(path);
  }
  return { tree, conflicted };
}

export interface NameStatusEntry {
  /** A, C, D, M, R, T, U, X, … (the score is dropped). */
  readonly letter: string;
  readonly path: GitPath;
  /** Renames and copies. */
  readonly oldPath?: GitPath;
}

/** `git diff --name-status -z`: `<S>[score]\0<path>\0`, renames and copies `<S><score>\0<old>\0<new>\0`. */
export function parseNameStatus(output: Uint8Array): NameStatusEntry[] {
  const fields = splitNul(output);
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = /^([A-Z])(\d{0,3})$/.exec((fields[i] as Buffer).toString('latin1'));
    if (!status) throw new SmurgError('internal', '無法解析 git 的輸出', { reason: 'git-output-unparsable' });
    const letter = status[1] as string;
    const twoPaths = letter === 'R' || letter === 'C';
    const first = fields[i + 1];
    const second = twoPaths ? fields[i + 2] : undefined;
    if (first === undefined || (twoPaths && second === undefined)) throw new SmurgError('internal', '無法解析 git 的輸出', { reason: 'git-output-unparsable' });
    entries.push(twoPaths ? { letter, oldPath: decodeGitPath(first), path: decodeGitPath(second as Buffer) } : { letter, path: decodeGitPath(first) });
    i += twoPaths ? 3 : 2;
  }
  return entries;
}

/** `git diff --name-only -z`: paths. */
export function parseNameOnly(output: Uint8Array): GitPath[] {
  return splitNul(output)
    .filter((field) => field.length > 0)
    .map(decodeGitPath);
}

/**
 * `git status --porcelain=v1 -z`: `XY <path>\0`, renames and copies `XY <to>\0<from>\0`. Returns every path that
 * differs from HEAD in the index or the working tree, untracked ones included. Undecodable names are kept as a
 * placeholder so a caller comparing sets still sees "something is dirty" (fail closed).
 */
export function parseStatusPaths(output: Uint8Array): string[] {
  const fields = splitNul(output);
  const paths: string[] = [];
  const decode = (bytes: Uint8Array): string => {
    try {
      return decodeGitPath(bytes).path;
    } catch {
      return '\u0000undecodable';
    }
  };
  for (let i = 0; i < fields.length; ) {
    const field = fields[i] as Buffer;
    if (field.length < 4 || field[2] !== 0x20) throw new SmurgError('internal', '無法解析 git 的輸出', { reason: 'git-output-unparsable' });
    const x = String.fromCharCode(field[0] as number);
    paths.push(decode(field.subarray(3)));
    if (x === 'R' || x === 'C') {
      const from = fields[i + 1];
      if (from !== undefined) paths.push(decode(from));
      i += 2;
    } else i += 1;
  }
  return paths;
}

/**
 * Where the unified diff can be cut without splitting a file's section: the start of the last `diff --git` header
 * that begins at or before `limit`. Returns `limit` when the first section alone is longer (a raw cut).
 */
export function cutAtFileBoundary(diff: Buffer, limit: number): number {
  if (diff.length <= limit) return diff.length;
  const marker = Buffer.from('\ndiff --git ');
  // A section starting at p + 1 fits when p + 1 <= limit (the marker itself may run past the limit).
  const at = diff.lastIndexOf(marker, limit - 1);
  return at > 0 ? at + 1 : limit;
}

/** Diff bytes → message text: invalid UTF-8 becomes U+FFFD, NUL (refused by the schema) becomes U+FFFD. */
export function diffText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replaceAll('\u0000', '�');
}
