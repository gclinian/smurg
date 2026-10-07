// PURE (ARCHITECTURE §7.6 "Profiles"; DESIGN §2.1, §2.5, §2.9, §2.11): what one kind of agent session is launched
// with: Claude Code's own mode, the `--tools` list, the rules of its settings file, whether only smurg's MCP server
// exists, whether the root's project settings are loaded. Also THE check of the profile flags before a spawn (fail
// closed) and the one function that writes a file rule.
//
// What a session may do is decided in this order: the tool gate (hooks/tool-gate.ts: smurg's code, runs first, binds
// always), then the tool list and the rules written here, then a permission request to the daemon. The host's own
// Claude Code allow rules APPLY (OWNER-DECISIONS Q7): nothing is mirrored into `ask`.
import {
  AGENT_EDIT_DENY_PATTERNS,
  AGENT_READ_DENY_PATTERNS,
  checkRememberableRule,
  ruleString,
  topicPlanPath,
  topicSpecPath,
  type AgentPurpose,
  type PermissionMode,
  type ProjectSettingsState,
  type RootRef,
} from '@smurg/protocol';
import type { LaunchProfile } from '../../core/interfaces.ts';

/** The tools of a discussion session (fixed, OB-9): it reads the project and writes its topic's spec and plan. */
export const DISCUSSION_TOOLS: readonly string[] = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'AskUserQuestion']);

/**
 * The tools of an execution or free session, for the verified Claude Code version (2.1.288). The design's list also
 * names `MultiEdit`, `BashOutput`, `KillShell` and `TodoWrite`: that version has none of them. Its `init.tools` under
 * `--tools` with all fifteen names lists the ones that remain plus `TaskStop`, its own name for stopping a
 * background command the agent started (what `KillShell` was), which is therefore listed here in their place
 * (test/sessions/agent-claude-real.test.ts pins the list). A tool of a future Claude Code does nothing in smurg until
 * a release lists it here: the gate refuses what is not listed.
 *
 * NO SUBAGENTS in 0.5.0: `Task` is not listed. A subagent runs with what its DEFINITION says (the project's
 * `.claude/agents/*.md`, the host's `~/.claude/agents`): with `permissionMode: acceptEdits` its edits and file
 * commands run without a request in a session smurg started in `default` (seen with 2.1.288), and a definition can
 * carry its own hooks and MCP servers, none of which the trust gate for project settings shows the host. With the
 * verified version the gate refused every subagent anyway (its hook names the tool `Agent`, never `Task`), so the
 * tool was only ever offered, never usable: it is not offered until those definitions are part of what the host
 * confirms.
 */
export const EXECUTION_TOOLS: readonly string[] = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'TaskStop', 'WebFetch', 'WebSearch', 'AskUserQuestion']);

/** In `HookSessionRegistration.tools`: the session may also call the host's and the project's MCP servers (`agentMcp`). */
export const ANY_MCP_TOOL = 'mcp__*';

/** The stream flags of every agent process (DESIGN §2.1): a constant of the runner. */
export const STREAM_ARGS: readonly string[] = Object.freeze([
  '-p',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--replay-user-messages',
  '--permission-prompt-tool',
  'stdio',
]);

// eslint-disable-next-line no-control-regex
const ROOT_UNSAFE = /[\\\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const PATTERN_UNSAFE = /[()\\\u0000-\u001f\u007f]/;

/** The session's folder has a path no permission rule can name (a backslash or a control character in it). */
export class RulePathError extends TypeError {
  constructor() {
    super('not a folder a permission rule can name');
    this.name = 'RulePathError';
  }
}

/**
 * A file rule for a settings file that does NOT live in the project: written with the absolute form
 * `//<realpath of the root>/<pattern>` (DESIGN Appendix C R3: a rule written `/specs/x/SPEC.md` matches nothing there).
 *
 * The root is a folder name of the host's and is written so that Claude Code reads it as that folder (each case run
 * against 2.1.288, test/sessions/agent-claude-real.test.ts): `(` and `)` need nothing, balanced or not; `[` and `]`
 * are escaped (unescaped they open a character class and the rule matches NOTHING: the deny rules would be gone
 * silently); `*`, `?`, `{`, `}` and `!` match themselves as they are (an escaped `?` matches nothing). A root with a
 * backslash or a control character is refused (RulePathError: the start says so in its own sentence). The pattern is
 * smurg's own: one with `(`, `)`, a backslash or a control character is a programming error.
 */
export function fileRule(tool: 'Read' | 'Edit', rootRealPath: string, relPattern: string): string {
  if (PATTERN_UNSAFE.test(relPattern) || relPattern.startsWith('/') || relPattern.length === 0) throw new TypeError('not a pattern a permission rule can hold');
  if (!rootRealPath.startsWith('/') || ROOT_UNSAFE.test(rootRealPath)) throw new RulePathError();
  return `${tool}(/${rootRealPath.replace(/\/+$/, '').replace(/[[\]]/g, '\\$&')}/${relPattern})`;
}

/** Claude Code's own mode for a session (DESIGN §2.5 table): a session rooted in the main workspace never runs in `acceptEdits`. */
export function claudeModeFor(purpose: AgentPurpose, mode: PermissionMode, root: RootRef): 'default' | 'acceptEdits' {
  if (purpose === 'discussion' || mode === 'ask-all') return 'default';
  return root.kind === 'worktree' ? 'acceptEdits' : 'default';
}

/**
 * In a main-workspace session with `ask-commands` the edit tools are allowed BY THE DAEMON without a card (after the
 * host-only check and the lock), every shell write asks: Claude Code's mode stays `default` there.
 */
export function daemonAllowsEdits(purpose: AgentPurpose, mode: PermissionMode, root: RootRef): boolean {
  return purpose !== 'discussion' && mode === 'ask-commands' && root.kind === 'main';
}

export interface ProfileInput {
  readonly purpose: AgentPurpose;
  readonly mode: PermissionMode;
  readonly root: RootRef;
  /** realpath of the session's root. */
  readonly rootRealPath: string;
  /** The topic's slug (a discussion and a work item's session). */
  readonly topicSlug?: string;
  /** The session's own remembered rules and its topic's. */
  readonly rules: readonly { readonly tool: string; readonly pattern: string }[];
  readonly trust: ProjectSettingsState;
  /** The host setting "Agents may use my own and this project's MCP servers". */
  readonly agentMcp: boolean;
  readonly rolePrompt: string;
}

/** The launch profile of one process start. Rules read back from disk are checked again: only a rememberable form is written. */
export function buildProfile(input: ProfileInput): LaunchProfile {
  const { purpose, rootRealPath } = input;
  const discussion = purpose === 'discussion';
  const allow: string[] = [];
  const deny: string[] = [
    ...AGENT_READ_DENY_PATTERNS.map((pattern) => fileRule('Read', rootRealPath, pattern)),
    ...AGENT_EDIT_DENY_PATTERNS.map((pattern) => fileRule('Edit', rootRealPath, pattern)),
  ];
  if (input.topicSlug !== undefined) {
    const files = [topicSpecPath(input.topicSlug), topicPlanPath(input.topicSlug)].map((path) => fileRule('Edit', rootRealPath, path));
    if (discussion) allow.push(...files);
    else if (purpose === 'item') deny.push(...files);
  }
  // The scripts a trusted project hook runs carry no rule here: a deny rule refuses only a command that SPELLS the
  // file (`cp x/lint.sh scripts/` and a renamed folder pass it) and refuses reading it into a copy as well. The tool
  // gate guards them instead, for every spelling: an edit tool is refused (G3), a shell command that may change one
  // asks a person (G10, hooks/bash-guard.ts), whatever this profile's mode and rules allow.
  if (!discussion) {
    const seen = new Set<string>();
    for (const rule of input.rules) {
      const check = checkRememberableRule(rule.tool, rule.pattern);
      if (!check.ok) continue;
      const text = ruleString(check.rule);
      if (!seen.has(text)) {
        seen.add(text);
        allow.push(text);
      }
    }
  }
  return {
    mode: claudeModeFor(purpose, input.mode, input.root),
    tools: discussion ? DISCUSSION_TOOLS : EXECUTION_TOOLS,
    allow,
    ask: [],
    deny,
    // A discussion always has only smurg's own server; the others unless the host allowed theirs.
    strictMcp: discussion || !input.agentMcp,
    settingSources: input.trust === 'ignored' ? 'user' : 'all',
    rolePrompt: input.rolePrompt,
  };
}

/** What the hook registration lists as the session's tools: the profile's list, plus any MCP tool when the host allowed theirs. */
export function gateToolsOf(profile: Pick<LaunchProfile, 'tools' | 'strictMcp'>): readonly string[] {
  return profile.strictMcp ? profile.tools : [...profile.tools, ANY_MCP_TOOL];
}

const VALUE_FLAGS = new Set(['--settings', '--mcp-config', '--tools', '--permission-mode', '--append-system-prompt-file', '--setting-sources']);
const BARE_FLAGS = new Set(['--strict-mcp-config']);

/**
 * THE launch check (DESIGN §2.1), failing closed: `--settings`, `--mcp-config` and `--tools` must be present;
 * `--permission-mode` must be present with `default` or `acceptEdits`; besides these only
 * `--append-system-prompt-file`, `--setting-sources user` and `--strict-mcp-config` may appear. Returns null when the
 * flags pass, else why not.
 */
export function checkLaunchArgs(args: readonly string[]): string | null {
  const seen = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as string;
    if (BARE_FLAGS.has(flag)) {
      if (seen.has(flag)) return `duplicate ${flag}`;
      seen.set(flag, '');
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) return `unexpected argument ${flag.slice(0, 40)}`;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--') || value.length === 0) return `no value for ${flag}`;
    if (seen.has(flag)) return `duplicate ${flag}`;
    seen.set(flag, value);
    i += 1;
  }
  for (const required of ['--settings', '--mcp-config', '--tools', '--permission-mode']) if (!seen.has(required)) return `missing ${required}`;
  const mode = seen.get('--permission-mode');
  if (mode !== 'default' && mode !== 'acceptEdits') return 'permission mode not allowed';
  const sources = seen.get('--setting-sources');
  if (sources !== undefined && sources !== 'user') return 'setting sources not allowed';
  for (const path of [seen.get('--settings'), seen.get('--mcp-config'), seen.get('--append-system-prompt-file')]) {
    if (path !== undefined && !path.startsWith('/')) return 'a launch file path is not absolute';
  }
  return null;
}
