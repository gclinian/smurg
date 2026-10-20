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
// | G5 | discussion: Read / Glob / Grep outside the session's root, or of a host-private path      | deny |
// | G6 | discussion: an edit tool whose target is not its topic's SPEC.md or PLAN.md               | deny |
// | G7 | work item: an edit tool on its topic's SPEC.md or PLAN.md                                 | deny |
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
import { SMURG_TOOL_PREFIX, foldRelPath, isClaudeConfigPath, isEditTool, isHostOnlyPath, isHostPrivatePath, isRelPathWithin, topicPlanPath, topicSpecPath } from '@smurg/protocol';
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

export type GateFacts = Pick<HookSessionRegistration, 'purpose' | 'topic' | 'pathRights' | 'tools'>;

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

/**
 * The decision for one call. `extraProtected`: root-relative paths the trust gate recorded for the session's root
 * (ProjectTrust.protectedPaths). `pattern`: a Glob's pattern.
 */
export function gateDecision(session: GateFacts, extraProtected: ReadonlySet<string>, tool: string, target: GateTarget, pattern?: string): GateDecision {
  if (!toolInList(session.tools, tool)) return deny('G2');
  const path = target.kind === 'in' ? target.path : undefined;
  if (isEditTool(tool)) {
    if (path !== undefined && (isClaudeConfigPath(path) || isRecorded(extraProtected, path))) return deny('G3', path);
    if (path !== undefined && session.pathRights === 'member' && isHostOnlyPath(path)) return deny('G4', path);
    const slug = session.topic?.slug;
    if (session.purpose === 'discussion') {
      // Its topic's spec and plan and nothing else; a target that is no file of the root is never one of the two.
      if (slug === undefined || path === undefined || (path !== topicSpecPath(slug) && path !== topicPlanPath(slug))) return deny('G6', path);
    } else if (session.purpose === 'item' && slug !== undefined && path !== undefined && (path === topicSpecPath(slug) || path === topicPlanPath(slug))) {
      return deny('G7', path);
    }
    return { kind: 'lock' };
  }
  if (session.purpose === 'discussion' && READ_TOOLS.has(tool)) {
    if (target.kind === 'outside') return deny('G5');
    if (path !== undefined && isHostPrivatePath(path)) return deny('G5', path);
    if (tool === 'Glob' && patternLeavesRoot(pattern)) return deny('G5');
    // A Read that names no file cannot run; a search without a path searches the working directory.
  }
  return { kind: 'pass' };
}
