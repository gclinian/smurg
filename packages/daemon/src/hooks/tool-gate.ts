// THE TOOL GATE, PURE (ARCHITECTURE §7.7; DESIGN §2.10, AD-7): what smurg's own code says about one tool call of an
// agent session, from the facts of the session's registration. `smurg hook` is registered for PreToolUse with the
// matcher `*`: it runs before Claude Code's permission flow, for every tool, and its deny binds whatever allow rules
// the host or the project have. The daemon's part around this function (resolving the path, the lock, the audit) is
// the hook server's (hook-events.ts).
//
// | G2 | the tool is not in the session's tool list and is not `mcp__smurg__*`                      | deny |
// | G3 | an edit tool on Claude Code's configuration (`.claude/**`, `.mcp.json`, `.git/**`, any    | deny |
// |    | depth) or on a file the trust gate recorded                                               |      |
// | G4 | an edit tool on another host-only path, session with `pathRights: 'member'`               | deny |
// | G5 | discussion and notes: Read / Glob / Grep outside the session's root, or of a host-private  | deny |
// |    | path; for notes also anything in `.smurg/` (any depth, folded), or a Glob pattern or a     |      |
// |    | Grep `glob` naming it (a search naming neither: the profile's `Read(.smurg/**)` hides it)  |      |
// | G6 | discussion: an edit tool whose target is not its topic's SPEC.md or PLAN.md               | deny |
// | G7 | work item: an edit tool on its topic's SPEC.md or PLAN.md                                 | deny |
// | G13| notes (Claude for the sticky notes, whoever started it, the host too): an edit tool unless | deny |
// |    | the resolved target in the MAIN workspace is a note's file (`noteNameOf`), `notes` is a    |      |
// |    | real folder, nothing but a regular file of one link is at the target, and no other entry   |      |
// |    | of `notes/` has a name that folds equal to it (NoteEditFacts, read by hook-events.ts)      |      |
// | G8 | any other edit-tool call                                                                  | lock |
// | G10| Bash, in a root whose project settings are in use and run scripts: a command that writes  | ask  |
// |    | where one of those scripts is, or that the gate cannot follow (bash-guard.ts); not while  |      |
// |    | the process runs without asking (`bypassPermissions`: the host chose no check)             |      |
// | G11| Bash, main workspace, process in auto mode: a write of a file a person is typing in (or a | deny |
// |    | folder that holds one), any session (G11b)                                                |      |
// |    | ... a write PathGuard refuses to the session's principal (host-only, `.smurg`, a recorded | ask  |
// |    | script, a folder that holds one), session with `pathRights: 'member'` (G11a), the host's  |      |
// | G12| Bash, process in auto mode, `pathRights: 'member'`: a write outside the session's own      | ask  |
// |    | folder and outside the system's temporary folders (the host's to answer)                  |      |
// |    | ... (G11 and G12) a command whose writes smurg cannot follow, while GATE_ASKS_WHEN_UNSURE  | ask  |
// | G9 | everything else (Bash, WebFetch, AskUserQuestion, `mcp__smurg__*`, …)                     | pass |
//
// G1 (the daemon does not answer) is hook-cli's: it fails closed for every tool. The gate never says "allow":
// allowing stays with Claude Code's rules and with people. G10, G11 and G12 are decided in hook-events.ts (they look
// at the file system and at the session's Claude Code mode as it RUNS, HookSessionRegistration.claudeMode): they read
// which files a shell command names; what a program does that names none, they cannot see (DESIGN 0.6.0 D10). In the
// ask modes Claude Code itself asks before every shell write, so G11 and G12 do not run there, nor in "Asks for
// nothing", nor (G11) in a worktree, whose changes the merge review covers.
import {
  SMURG_TOOL_PREFIX,
  confinedPurpose,
  foldRelPath,
  isClaudeConfigPath,
  isEditTool,
  isHostOnlyPath,
  isHostPrivatePath,
  isRelPathWithin,
  isSmurgDirName,
  noteNameOf,
  relPathSegments,
  topicPlanPath,
  topicSpecPath,
} from '@smurg/protocol';
import type { GateRow, HookSessionRegistration } from '../core/interfaces.ts';

/**
 * What rows G11 and G12 do with a shell command they cannot follow (a variable, a substitution, a line handed to
 * another shell): `true`, a teammate's session asks the host. DESIGN 0.6.0 D10 left it to the real-Claude test R4
 * (test/sessions/modes-claude-real.test.ts), which found that Claude Code 2.1.288's fast path DOES take a command whose
 * target is a variable (`F=notes.md; rm "$F"`, `G=CLAUDE.md && echo x >> "$G"` ran with no check at all), while it
 * sends `$(…)`, `sh -c` and `xargs` to its classifier: so what smurg cannot read may run unchecked. The host's own
 * sessions are not asked (their reach is the host's to set, by the mode they choose).
 */
export const GATE_ASKS_WHEN_UNSURE = true;

/** In `HookSessionRegistration.tools`: any MCP tool is in the list (the host allowed their own servers, `agentMcp`). */
export const ANY_MCP_TOOL = 'mcp__*';

/**
 * Where the path the call names lies, as the hook server resolved it (realpath, PathGuard): inside the SESSION'S OWN
 * root (`path` relative to it), anywhere else (another root included), or the call names no path.
 */
export type GateTarget = { readonly kind: 'in'; readonly path: string } | { readonly kind: 'outside' } | { readonly kind: 'none' };

/** The rows this function decides that deny (G11 is decided in hook-events.ts). */
export type TableDenyRow = Exclude<GateRow, 'G11' | 'G12'>;

export type GateDecision = { readonly kind: 'pass' } | { readonly kind: 'lock' } | { readonly kind: 'deny'; readonly row: TableDenyRow; readonly path?: string };

/** `root` is read only for Claude for the sticky notes (G13: the main workspace, or nothing); absent counts as not main. */
export type GateFacts = Pick<HookSessionRegistration, 'purpose' | 'topic' | 'pathRights' | 'tools'> & Partial<Pick<HookSessionRegistration, 'root'>>;

/**
 * What the hook server read from the disk for an edit of Claude for the sticky notes (row G13, DESIGN 0.8.0 D3.3):
 * one lstat of `notes`, one of the target, one readdir of `notes/`. Absent: nothing could be read, and G13 refuses.
 */
export interface NoteEditFacts {
  /** `notes` at the top of the main workspace is a real folder (lstat: a directory, not a symbolic link). */
  readonly folderIsReal: boolean;
  /**
   * What lstat finds at the target: nothing yet (a new note), a regular file with one link, or anything else (a
   * directory, a symbolic link, a special file, a file with more than one hard link: an edit there would write
   * another file than a note).
   */
  readonly target: 'absent' | 'file' | 'other';
  /** Another entry of `notes/` has a name that folds equal to the target's (`foldRelPath`): `home.md` beside `Home.md`. */
  readonly twin: boolean;
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);

export function toolInList(tools: readonly string[], tool: string): boolean {
  if (tool.startsWith(SMURG_TOOL_PREFIX)) return true;
  if (tools.includes(tool)) return true;
  return tool.startsWith('mcp__') && tools.includes(ANY_MCP_TOOL);
}

/** A Glob pattern that can leave the working directory: absolute, home-relative, or with a `..` segment. */
export function patternLeavesRoot(pattern: string | undefined): boolean {
  if (pattern === undefined) return false;
  return pattern.startsWith('/') || pattern.startsWith('~') || /(^|\/)\.\.(\/|$)/.test(pattern);
}

const deny = (row: TableDenyRow, path?: string): GateDecision => ({ kind: 'deny', row, ...(path === undefined ? {} : { path }) });

/**
 * Whether `path` is one of the recorded files, or lies below one (a recorded path may be one where no file is yet:
 * a folder there, with a file in it, is what some programs would run), under any spelling a case-insensitive file
 * system folds onto it.
 */
function isRecorded(recorded: ReadonlySet<string>, path: string): boolean {
  if (recorded.size === 0) return false;
  if (recorded.has(path)) return true;
  const folded = foldRelPath(path);
  for (const entry of recorded) if (isRelPathWithin(folded, foldRelPath(entry))) return true;
  return false;
}

/** Whether a root-relative path names smurg's own folder `.smurg` at any depth under any spelling (foldPathName). */
function namesSmurgDir(path: string): boolean {
  return relPathSegments(path).some(isSmurgDirName);
}

/** Row G13: whether an edit of Claude for the sticky notes may go on to the lock (`path`: the resolved target). */
function isNoteEdit(session: GateFacts, path: string | undefined, note: NoteEditFacts | undefined): boolean {
  if (session.root?.kind !== 'main' || path === undefined || noteNameOf(path) === null || note === undefined) return false;
  return note.folderIsReal && note.target !== 'other' && !note.twin;
}

/**
 * The decision for one call. `extraProtected`: root-relative paths the trust gate recorded for the session's root
 * (ProjectTrust.protectedPaths). `pattern`: the call's file pattern, a Glob's `pattern` or a Grep's `glob` (never a
 * Grep's `pattern`, which is what it searches for). `note`: for an edit of Claude for the sticky notes, what the disk
 * says about its target (G13; absent, the edit is refused).
 */
export function gateDecision(session: GateFacts, extraProtected: ReadonlySet<string>, tool: string, target: GateTarget, pattern?: string, note?: NoteEditFacts): GateDecision {
  if (!toolInList(session.tools, tool)) return deny('G2');
  const path = target.kind === 'in' ? target.path : undefined;
  if (isEditTool(tool)) {
    if (path !== undefined && (isClaudeConfigPath(path) || isRecorded(extraProtected, path))) return deny('G3', path);
    if (path !== undefined && session.pathRights === 'member' && isHostOnlyPath(path)) return deny('G4', path);
    const slug = session.topic?.slug;
    if (session.purpose === 'discussion') {
      // Its topic's spec and plan and nothing else; a target that is no file of the root is never one of the two.
      if (slug === undefined || path === undefined || (path !== topicSpecPath(slug) && path !== topicPlanPath(slug))) return deny('G6', path);
    } else if (session.purpose === 'notes') {
      // Notes and nothing else, whoever started the session (CLAUDE.md is no note's name: host-only for everyone).
      if (!isNoteEdit(session, path, note)) return deny('G13', path);
    } else if (session.purpose === 'item' && slug !== undefined && path !== undefined && (path === topicSpecPath(slug) || path === topicPlanPath(slug))) {
      return deny('G7', path);
    }
    return { kind: 'lock' };
  }
  if (confinedPurpose(session.purpose) && READ_TOOLS.has(tool)) {
    const notes = session.purpose === 'notes';
    if (target.kind === 'outside') return deny('G5');
    if (path !== undefined && (isHostPrivatePath(path) || (notes && namesSmurgDir(path)))) return deny('G5', path);
    if (tool === 'Glob' && patternLeavesRoot(pattern)) return deny('G5');
    // A file pattern that names smurg's own folder is refused too: a Glob's, and a Grep's `glob`, which would print the
    // contents of the files it matches. A wildcard or a brace can still match the folder: the notes profile's read rule
    // `Read(.smurg/**)` hides it from Claude Code's own searches (profiles.ts smurgFolderDenyRules), and a Read of a file
    // in it is refused above.
    if (notes && (tool === 'Glob' || tool === 'Grep') && pattern !== undefined && pattern.split('/').some(isSmurgDirName)) return deny('G5');
    // A Read that names no file cannot run; a search without a path searches the working directory (for the sticky
    // notes without smurg's own folder: the read rule above).
  }
  return { kind: 'pass' };
}
