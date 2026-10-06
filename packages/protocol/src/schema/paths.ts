import { z } from 'zod';
import { PATH_SEGMENT_MAX_UNITS, REL_PATH_MAX_CHARS } from './limits.ts';
import { opaqueIdSchema } from './primitives.ts';

// Relative paths and file references (ARCHITECTURE §5 "All file references use", §7.4 lexical layer).
//
// This is the *lexical* layer only, shared by every sender and receiver. The daemon's PathGuard still resolves the
// joined path with realpath, enforces containment and symlink rules, applies the per-platform byte limit (Linux) and
// repeats the check before every disk access. Passing these checks never means "safe to open".

export type RelPathProblem =
  | 'not-string'
  | 'too-long'
  | 'control-character'
  | 'bidi-character'
  | 'lone-surrogate'
  | 'backslash'
  | 'drive-letter'
  | 'absolute'
  | 'empty-segment'
  | 'dot-segment'
  | 'segment-too-long'
  | 'root-not-allowed';

export type RelPathCheck = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly problem: RelPathProblem };

// C0, DEL and C1 controls (NUL included).
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Bidi overrides, embeddings, isolates and marks: any of them lets a name display as a different name.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * Validates and normalises a client-supplied relative POSIX path. Rules (ARCHITECTURE §7.4): a string of at most
 * REL_PATH_MAX_CHARS; no control characters, bidi characters, lone surrogates or backslashes; no drive letter; not
 * absolute; no empty, `.` or `..` segments (so no leading, trailing or doubled `/`); each segment at most
 * PATH_SEGMENT_MAX_UNITS UTF-16 units after NFC. The result is NFC-normalised. `""` is the root and is accepted only
 * with `allowRoot`.
 */
export function checkRelPath(input: unknown, options: { readonly allowRoot?: boolean } = {}): RelPathCheck {
  if (typeof input !== 'string') return { ok: false, problem: 'not-string' };
  // Bound the work before normalising: NFC of a huge string is not free.
  if (input.length > REL_PATH_MAX_CHARS * 4) return { ok: false, problem: 'too-long' };
  if (CONTROL.test(input)) return { ok: false, problem: 'control-character' };
  if (BIDI.test(input)) return { ok: false, problem: 'bidi-character' };
  if (LONE_SURROGATE.test(input)) return { ok: false, problem: 'lone-surrogate' };
  const path = input.normalize('NFC');
  if (path.length > REL_PATH_MAX_CHARS) return { ok: false, problem: 'too-long' };
  if (path === '') return options.allowRoot === true ? { ok: true, path } : { ok: false, problem: 'root-not-allowed' };
  if (path.includes('\\')) return { ok: false, problem: 'backslash' };
  if (DRIVE_LETTER.test(path)) return { ok: false, problem: 'drive-letter' };
  if (path.startsWith('/')) return { ok: false, problem: 'absolute' };
  for (const segment of path.split('/')) {
    if (segment === '') return { ok: false, problem: 'empty-segment' };
    if (segment === '.' || segment === '..') return { ok: false, problem: 'dot-segment' };
    if (segment.length > PATH_SEGMENT_MAX_UNITS) return { ok: false, problem: 'segment-too-long' };
  }
  return { ok: true, path };
}

export function isValidRelPath(input: unknown, options: { readonly allowRoot?: boolean } = {}): input is string {
  return checkRelPath(input, options).ok;
}

function relPathTransform(allowRoot: boolean) {
  return z
    .string()
    .max(REL_PATH_MAX_CHARS * 4)
    .transform((input, ctx) => {
      const result = checkRelPath(input, { allowRoot });
      if (!result.ok) {
        ctx.addIssue({ code: 'custom', message: `invalid relative path: ${result.problem}` });
        return z.NEVER;
      }
      return result.path;
    });
}

/** A relative path where `""` (the root itself) is allowed, e.g. `file.tree`, `file.stat`, a folder download. */
export const relPathSchema = relPathTransform(true);
/** A relative path that names an entry below the root (never `""`). */
export const entryPathSchema = relPathTransform(false);

/** A single file or directory name (one segment). */
export const pathSegmentSchema = z
  .string()
  .max(PATH_SEGMENT_MAX_UNITS * 4)
  .transform((input, ctx) => {
    const result = checkRelPath(input);
    if (!result.ok || result.path.includes('/')) {
      ctx.addIssue({ code: 'custom', message: `invalid name: ${result.ok ? 'contains /' : result.problem}` });
      return z.NEVER;
    }
    return result.path;
  });

/** The segments of a valid path (`""` → `[]`). */
export function relPathSegments(path: string): string[] {
  return path === '' ? [] : path.split('/');
}

/** Parent of a valid path (`"a/b"` → `"a"`, `"a"` → `""`, `""` → `null`). */
export function parentRelPath(path: string): string | null {
  if (path === '') return null;
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** Last segment of a valid path (`""` → `""`). */
export function baseNameOfRelPath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Joins a valid parent path and a name, then validates the result; returns null when the result is invalid. */
export function joinRelPath(parent: string, name: string): string | null {
  const joined = parent === '' ? name : `${parent}/${name}`;
  const result = checkRelPath(joined);
  return result.ok ? result.path : null;
}

/** Whether `path` is `ancestor` itself or lies below it (both valid, normalised). `""` is everyone's ancestor. */
export function isRelPathWithin(path: string, ancestor: string): boolean {
  return ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`);
}

// ---------------------------------------------------------------------------------------------------------------
// Host-only paths (ARCHITECTURE §5.2) and hidden temp files
// ---------------------------------------------------------------------------------------------------------------

// Directories whose contents the host's tools load automatically (and every agent session's, all of which run as the
// host: ARCHITECTURE §11 D-15). Matched at ANY depth and after foldPathName (APFS is case-insensitive by default:
// `.Claude/settings.json` is `.claude/settings.json`).
const HOST_ONLY_DIRS: ReadonlySet<string> = new Set(['.claude', '.git', '.smurg', '.vscode', '.idea']);
// `CLAUDE.md` / `CLAUDE.local.md` at any depth: Claude Code loads them as instructions for agents that run as the host.
const HOST_ONLY_FILES: ReadonlySet<string> = new Set(['.mcp.json', '.envrc', 'claude.md', 'claude.local.md']);

// Code points HFS+ ignores when it compares names (git's is_hfs_dotgit list): `.g‌it` is `.git` there.
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * The key under which a case-insensitive file system may treat two names as the same entry, for security decisions
 * about names (host-only, hidden). `toLowerCase()` alone is not enough: on APFS `ſ` (U+017F) names the same entry as
 * `s`, so `.vſcode` IS `.vscode`, and toLowerCase leaves `ſ` alone. NFKC maps `ſ`→`s`, `K` (Kelvin)→`K` and ligatures
 * such as `ﬅ`→`st`; the upper-then-lower round trip catches `ı`→`I`→`i` (exFAT/NTFS upcase tables); HFS+ ignorable
 * code points are dropped. Folding more names together than a file system does only makes a name MORE protected.
 */
export function foldPathName(name: string): string {
  return name.replace(HFS_IGNORABLE, '').normalize('NFKC').toUpperCase().toLowerCase();
}

/**
 * Whether only the host may write `path` through `file.*`, `doc.*` or uploads (ARCHITECTURE §5.2): anything inside
 * `.claude/`, `.git/`, `.smurg/`, `.vscode/`, `.idea/`, and any `.mcp.json`, `.envrc`, `CLAUDE.md` or
 * `CLAUDE.local.md`. This matches more than the
 * architecture's root-anchored list on purpose (nested `.claude/` directories, every spelling a case-insensitive file
 * system folds together, see foldPathName): a false "host-only" costs a member one refused write, a false "not
 * host-only" can run code on the host. The daemon checks the resolved on-disk path as well; this lexical test is not
 * a substitute for that.
 */
export function isHostOnlyPath(path: string): boolean {
  const segments = relPathSegments(path).map(foldPathName);
  if (segments.some((segment) => HOST_ONLY_DIRS.has(segment))) return true;
  const last = segments.at(-1);
  return last !== undefined && HOST_ONLY_FILES.has(last);
}

/**
 * The host's personal Claude Code files inside the share (any depth): `settings.local.json` can hold `env` secrets and
 * hook commands, `CLAUDE.local.md` is the host's private memory. The daemon's PathGuard refuses them to every non-host
 * member through smurg (file.*, doc.*, downloads, uploads: isHostPrivatePath). Agent sessions run as
 * the host (ARCHITECTURE §11 D-15) and can read them like any other file of the host's.
 */
export const HOST_PERSONAL_FILES: readonly string[] = Object.freeze(['.claude/settings.local.json', 'CLAUDE.local.md']);
/** Directories whose contents are the host's private data (any depth): `.git` (remote URLs, reflogs, extraheader tokens). */
export const HOST_PRIVATE_DIR_NAMES: readonly string[] = Object.freeze(['.git']);
/** Files that are the host's private data (any depth): direnv's `.envrc` (deploy keys, API tokens). */
export const HOST_PRIVATE_FILE_NAMES: readonly string[] = Object.freeze(['.envrc']);

const HOST_PRIVATE_DIRS_FOLDED: ReadonlySet<string> = new Set(HOST_PRIVATE_DIR_NAMES.map(foldPathName));
const HOST_PRIVATE_FILES_FOLDED: ReadonlySet<string> = new Set(HOST_PRIVATE_FILE_NAMES.map(foldPathName));
const HOST_PERSONAL_SUFFIXES: readonly (readonly string[])[] = HOST_PERSONAL_FILES.map((rel) => rel.split('/').map(foldPathName));

/**
 * Whether `path` is the host's private data that no other member may read (or write) through `file.*`, `doc.*`,
 * downloads or uploads: inside any `.git`, any `.envrc`, and the HOST_PERSONAL_FILES at any depth, under every spelling
 * a case-insensitive file system folds onto them (foldPathName). This binds what members do through
 * smurg; it is not a boundary for agent or terminal sessions, which run as the host (ARCHITECTURE §11 D-15). Lexical
 * only: the daemon also checks the resolved and on-disk spellings.
 */
export function isHostPrivatePath(path: string): boolean {
  const segments = relPathSegments(path).map(foldPathName);
  if (segments.some((segment) => HOST_PRIVATE_DIRS_FOLDED.has(segment))) return true;
  const last = segments.at(-1);
  if (last === undefined) return false;
  if (HOST_PRIVATE_FILES_FOLDED.has(last)) return true;
  return HOST_PERSONAL_SUFFIXES.some(
    (suffix) => suffix.length <= segments.length && suffix.every((name, i) => segments[segments.length - suffix.length + i] === name),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code's own configuration, and the rules an agent session starts with (ARCHITECTURE §7.6 "Profiles")
// ---------------------------------------------------------------------------------------------------------------

/** Directories and files Claude Code (and git) load configuration from, at any depth. No agent session writes them. */
export const CLAUDE_CONFIG_DIR_NAMES: readonly string[] = Object.freeze(['.claude', '.git']);
export const CLAUDE_CONFIG_FILE_NAMES: readonly string[] = Object.freeze(['.mcp.json']);
/** The three project-level Claude Code files of a root whose content the host confirms (the trust gate). */
export const PROJECT_SETTINGS_FILES: readonly string[] = Object.freeze(['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']);

const CLAUDE_CONFIG_DIRS_FOLDED: ReadonlySet<string> = new Set(CLAUDE_CONFIG_DIR_NAMES.map(foldPathName));
const CLAUDE_CONFIG_FILES_FOLDED: ReadonlySet<string> = new Set(CLAUDE_CONFIG_FILE_NAMES.map(foldPathName));

/**
 * Whether `path` is Claude Code's own configuration (`.claude/**`, `.mcp.json`, `.git/**`, at any depth, under every
 * spelling a case-insensitive file system folds onto them): the tool gate refuses every agent's edit of it.
 */
export function isClaudeConfigPath(path: string): boolean {
  const segments = relPathSegments(path).map(foldPathName);
  if (segments.some((segment) => CLAUDE_CONFIG_DIRS_FOLDED.has(segment))) return true;
  const last = segments.at(-1);
  return last !== undefined && CLAUDE_CONFIG_FILES_FOLDED.has(last);
}

function atRootAndBelow(pattern: string): string[] {
  return [pattern, `**/${pattern}`];
}

/**
 * Patterns, relative to a session's root, that every agent session is denied to READ: the host-private names. Generated
 * from the lists above so they cannot drift from isHostPrivatePath. The daemon turns each into a rule with the root's
 * absolute form (`Read(//<realpath>/<pattern>)`); such a rule also hides the file from Grep and refuses shell commands
 * that name it.
 */
export const AGENT_READ_DENY_PATTERNS: readonly string[] = Object.freeze([
  ...HOST_PRIVATE_FILE_NAMES.flatMap(atRootAndBelow),
  ...HOST_PRIVATE_DIR_NAMES.flatMap((dir) => atRootAndBelow(`${dir}/**`)),
  ...HOST_PERSONAL_FILES.flatMap(atRootAndBelow),
]);

/** Patterns, relative to a session's root, that every agent session is denied to EDIT: Claude Code's configuration. */
export const AGENT_EDIT_DENY_PATTERNS: readonly string[] = Object.freeze([
  ...CLAUDE_CONFIG_DIR_NAMES.flatMap((dir) => atRootAndBelow(`${dir}/**`)),
  ...CLAUDE_CONFIG_FILE_NAMES.flatMap(atRootAndBelow),
]);

// ---------------------------------------------------------------------------------------------------------------
// A topic's files (ARCHITECTURE §5.10): specs/<slug>/SPEC.md, PLAN.md, reports/<item id>.md
// ---------------------------------------------------------------------------------------------------------------

export const SPECS_DIR = 'specs';
export const SPEC_FILE_NAME = 'SPEC.md';
export const PLAN_FILE_NAME = 'PLAN.md';
export const REPORTS_DIR_NAME = 'reports';

/** `specs/<slug>`. The slug and item id are patterns the schemas check (topicSlugSchema, itemIdSchema). */
export function topicDirPath(slug: string): string {
  return `${SPECS_DIR}/${slug}`;
}
export function topicSpecPath(slug: string): string {
  return `${SPECS_DIR}/${slug}/${SPEC_FILE_NAME}`;
}
export function topicPlanPath(slug: string): string {
  return `${SPECS_DIR}/${slug}/${PLAN_FILE_NAME}`;
}
export function topicReportPath(slug: string, itemId: string): string {
  return `${SPECS_DIR}/${slug}/${REPORTS_DIR_NAME}/${itemId}.md`;
}

/** Which of a topic's two shared files `path` is, comparing names as a case-insensitive file system would. */
export function topicFileKind(path: string, slug: string): 'spec' | 'plan' | null {
  const folded = relPathSegments(path).map(foldPathName).join('/');
  if (folded === relPathSegments(topicSpecPath(slug)).map(foldPathName).join('/')) return 'spec';
  if (folded === relPathSegments(topicPlanPath(slug)).map(foldPathName).join('/')) return 'plan';
  return null;
}

/** Whether `path` is `specs/<slug>` itself or lies below it (folded like topicFileKind). */
export function isInTopicDir(path: string, slug: string): boolean {
  const folded = relPathSegments(path).map(foldPathName);
  const dir = relPathSegments(topicDirPath(slug)).map(foldPathName);
  return dir.every((segment, index) => folded[index] === segment);
}

/** Whether a path segment names the daemon's `.smurg` directory under any spelling (see foldPathName). */
export function isSmurgDirName(segment: string): boolean {
  return foldPathName(segment) === '.smurg';
}

/** Claude Code's atomic-write temp files: `<name>.tmp.<pid>.<12 hex>` (yjs-monaco.md V9). */
export const CLAUDE_TEMP_NAME_PATTERN = /\.tmp\.\d+\.[0-9a-f]{12}$/;
/** smurg's own atomic-write temp files: `.<name>.smurg-<12 hex>.tmp` (ARCHITECTURE §7.5). */
export const SMURG_TEMP_NAME_PATTERN = /^\..+\.smurg-[0-9a-f]{12}\.tmp$/;

/** Whether a file name is an editor/agent temp file that the tree and the activity feed hide (ARCHITECTURE §5.2). */
export function isHiddenTempName(name: string): boolean {
  return CLAUDE_TEMP_NAME_PATTERN.test(name) || SMURG_TEMP_NAME_PATTERN.test(name);
}

// ---------------------------------------------------------------------------------------------------------------
// RootRef / FileRef
// ---------------------------------------------------------------------------------------------------------------

export const mainRootRefSchema = z.strictObject({ kind: z.literal('main') });
export const worktreeRootRefSchema = z.strictObject({ kind: z.literal('worktree'), worktreeId: opaqueIdSchema });
/** The main workspace, or one worktree. */
export const rootRefSchema = z.discriminatedUnion('kind', [mainRootRefSchema, worktreeRootRefSchema]);
export type RootRef = z.infer<typeof rootRefSchema>;

/** A file or directory in a root. `path` is relative, normalised, `""` = the root itself. */
export const fileRefSchema = z.strictObject({ root: rootRefSchema, path: relPathSchema });
export type FileRef = z.infer<typeof fileRefSchema>;

/** A file reference that must name an entry below the root (not the root itself). */
export const entryRefSchema = z.strictObject({ root: rootRefSchema, path: entryPathSchema });

export const MAIN_ROOT: RootRef = Object.freeze({ kind: 'main' });

export function worktreeRoot(worktreeId: string): RootRef {
  return { kind: 'worktree', worktreeId };
}

/** Stable string key of a root: `main` or `wt:<worktreeId>` (worktree ids contain no `:`). */
export function rootRefKey(root: RootRef): string {
  return root.kind === 'main' ? 'main' : `wt:${root.worktreeId}`;
}

export function rootRefEquals(a: RootRef, b: RootRef): boolean {
  return rootRefKey(a) === rootRefKey(b);
}

/**
 * Stable string key of a file reference, for maps and sets: `main:<path>` or `wt:<worktreeId>:<path>`. The path is
 * NFC-normalised again, so two spellings of the same name share a key even if one of them skipped the schema.
 */
export function fileRefKey(ref: FileRef): string {
  return `${rootRefKey(ref.root)}:${ref.path.normalize('NFC')}`;
}

export function fileRefEquals(a: FileRef, b: FileRef): boolean {
  return fileRefKey(a) === fileRefKey(b);
}

/** Inverse of fileRefKey; returns null for anything that is not a valid key. */
export function parseFileRefKey(key: string): FileRef | null {
  let root: RootRef;
  let rest: string;
  if (key.startsWith('main:')) {
    root = MAIN_ROOT;
    rest = key.slice('main:'.length);
  } else if (key.startsWith('wt:')) {
    const colon = key.indexOf(':', 3);
    if (colon === -1) return null;
    const worktreeId = key.slice(3, colon);
    if (!opaqueIdSchema.safeParse(worktreeId).success) return null;
    root = { kind: 'worktree', worktreeId };
    rest = key.slice(colon + 1);
  } else return null;
  const checked = checkRelPath(rest, { allowRoot: true });
  return checked.ok ? { root, path: checked.path } : null;
}
