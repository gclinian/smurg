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
// | G9 | everything else (Bash, WebFetch, AskUserQuestion, `mcp__smurg__*`, …)                     | pass |
//
// G1 (the daemon does not answer) is hook-cli's: it fails closed for every tool. The gate never says "allow":
// allowing stays with Claude Code's rules and with people. What it cannot see is what a shell command does.
import { SMURG_TOOL_PREFIX, foldRelPath, isClaudeConfigPath, isEditTool, isHostOnlyPath, isHostPrivatePath, topicPlanPath, topicSpecPath } from '@smurg/protocol';
import type { GateRow, HookSessionRegistration } from '../core/interfaces.ts';

/** In `HookSessionRegistration.tools`: any MCP tool is in the list (the host allowed their own servers, `agentMcp`). */
export const ANY_MCP_TOOL = 'mcp__*';

/**
 * Where the path the call names lies, as the hook server resolved it (realpath, PathGuard): inside the SESSION'S OWN
 * root (`path` relative to it), anywhere else (another root included), or the call names no path.
 */
export type GateTarget = { readonly kind: 'in'; readonly path: string } | { readonly kind: 'outside' } | { readonly kind: 'none' };

export type GateDecision = { readonly kind: 'pass' } | { readonly kind: 'lock' } | { readonly kind: 'deny'; readonly row: GateRow; readonly path?: string };

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

const deny = (row: GateRow, path?: string): GateDecision => ({ kind: 'deny', row, ...(path === undefined ? {} : { path }) });

/** Whether `path` is one of the recorded files, under any spelling a case-insensitive file system folds onto it. */
function isRecorded(recorded: ReadonlySet<string>, path: string): boolean {
  if (recorded.size === 0) return false;
  if (recorded.has(path)) return true;
  const folded = foldRelPath(path);
  for (const entry of recorded) if (foldRelPath(entry) === folded) return true;
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
