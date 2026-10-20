// PURE (ARCHITECTURE §7.6 "Profiles"; DESIGN §2.1, §2.5, §2.9, §2.11; DESIGN 0.6.0 D8, D8a, D9): what one kind of
// agent session is launched with: Claude Code's own mode (smurg's four modes mapped, after a process's fallback), the
// `--tools` list, the rules of its settings file (the deny rules beyond the session's own folder included), whether
// only smurg's MCP server exists, whether the root's project settings are loaded. Also THE checks of the profile flags
// and of the settings file before a spawn (fail closed) and the functions that write a file rule.
//
// What a session may do is decided in this order: the tool gate (hooks/tool-gate.ts: smurg's code, runs first, binds
// always), then the tool list and the rules written here, then a permission request to the daemon. The host's own
// Claude Code allow rules APPLY (OWNER-DECISIONS Q7): nothing is mirrored into `ask`.
import {
  AGENT_EDIT_DENY_PATTERNS,
  AGENT_READ_DENY_PATTERNS,
  checkRememberableRule,
  modelIdSchema,
  ruleString,
  topicPlanPath,
  topicSpecPath,
  type AgentPurpose,
  type PermissionMode,
  type ProjectSettingsState,
  type RootRef,
} from '@smurg/protocol';
import type { ClaudeMode, LaunchProfile } from '../../core/interfaces.ts';

export type { ClaudeMode };

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
  return absoluteRule(tool, rootRealPath, relPattern);
}

/**
 * A rule for a place that is not the session's own folder (DESIGN 0.6.0 D8a): `//<absRealPath>/<relPattern>`, or the
 * place itself (`//<absRealPath>`: a file) without a pattern. The same escaping and the same refusals as fileRule.
 */
export function absoluteRule(tool: 'Read' | 'Edit', absRealPath: string, relPattern?: string): string {
  if (relPattern !== undefined && (PATTERN_UNSAFE.test(relPattern) || relPattern.startsWith('/') || relPattern.length === 0)) throw new TypeError('not a pattern a permission rule can hold');
  const trimmed = absRealPath.replace(/\/+$/, '');
  if (!absRealPath.startsWith('/') || trimmed.length === 0 || ROOT_UNSAFE.test(absRealPath)) throw new RulePathError();
  const place = `/${trimmed.replace(/[[\]]/g, '\\$&')}`;
  return `${tool}(${relPattern === undefined ? place : `${place}/${relPattern}`})`;
}

/**
 * The places beyond a session's own folder that its deny rules cover, in EVERY mode (`ask-nothing` included), for every
 * session that is not a discussion (DESIGN 0.6.0 D8a; a discussion has no shell, and its reads and writes are confined
 * by the gate's G5/G6). Measured with the real 2.1.288 against the fake API (R-SEC): without these, a work item in auto
 * wrote the main folder's `.git/hooks`, `.claude/settings.json`, a ref of smurg's own history and the host's
 * `~/.claude/*`; with them every one was refused, in auto and in bypass, spelled absolute or with `~`.
 *
 * | place                                        | rules                                             | why                                   |
 * |----------------------------------------------|---------------------------------------------------|---------------------------------------|
 * | the main root, for a session in a worktree   | AGENT_READ_DENY_PATTERNS (Read), AGENT_EDIT_DENY_  | the shared folder's own configuration |
 * |                                              | PATTERNS (Edit), written for the MAIN root        | and secrets, as for a main session    |
 * | the main root, every session                 | Read and Edit `.smurg/git/**`, Edit               | smurg's own history, and what keeps   |
 * |                                              | `.smurg/.gitignore` (a main session also has      | `.smurg` out of a later `git add -A`  |
 * |                                              | `Edit(.smurg/**)`, DESIGN D10)                    |                                       |
 * | the host's home                              | Edit `.claude/**`, `.claude.json`, `.ssh/**`      | Claude Code's user settings, hooks,   |
 * |                                              |                                                   | allow rules, memory; ssh keys, config |
 * | CLAUDE_CONFIG_DIR of the host's environment  | Edit `**`                                         | the same, where the host keeps them   |
 * | smurg's state folder (~/.smurg)              | Read and Edit `**`                                | the workspace's state (its mode: no   |
 * |                                              |                                                   | MAC), keys, logins, every launch file |
 * | smurg's own executable (and its realpath)    | Edit                                              | every hook of the gate runs that file |
 *
 * They refuse an agent's edit tools on those places, and a shell command that NAMES one of them (Claude Code applies
 * a path's deny rule to Bash commands that name the path, in every mode). A command that reaches a place without
 * naming it (a script, a program, a variable, a `cd` first) is not refused by them: they are not a sandbox. Another
 * work item's checkout gets no rule (it lies beside the session's own folder, and a deny rule beats an allow rule).
 */
export const REACH_DENY = Object.freeze({
  mainForWorktree: Object.freeze({ read: AGENT_READ_DENY_PATTERNS, edit: AGENT_EDIT_DENY_PATTERNS }),
  main: Object.freeze({ read: Object.freeze(['.smurg/git/**']), edit: Object.freeze(['.smurg/git/**', '.smurg/.gitignore']) }),
  hostHome: Object.freeze({ edit: Object.freeze(['.claude/**', '.claude.json', '.ssh/**']) }),
  claudeConfigDir: Object.freeze({ edit: Object.freeze(['**']) }),
  stateDir: Object.freeze({ read: Object.freeze(['**']), edit: Object.freeze(['**']) }),
});

/** The folders of REACH_DENY in the host's home that no shared folder and no session's folder may lie in. */
export const HOST_HOME_AGENT_CONFIG: readonly string[] = Object.freeze(['.claude', '.ssh']);

/** A session rooted in the main workspace: smurg's whole folder is out of its edit tools (DESIGN 0.6.0 D10). */
export const MAIN_SMURG_EDIT_DENY = '.smurg/**';

/** Where the places of REACH_DENY are on this host: realpaths, as the sessions module resolved them. */
export interface ReachPlaces {
  /** The shared folder (the main root). */
  readonly mainRealPath: string;
  /** The host's home folder (config.sessions.hostHome); null when not known. */
  readonly hostHome: string | null;
  /** CLAUDE_CONFIG_DIR of the host's environment, when it is set. */
  readonly claudeConfigDir: string | null;
  /** smurg's state folder (config.stateDir). */
  readonly stateDir: string;
  /** smurg's own executable (config.sessions.selfCommand.file), and its realpath when that differs. */
  readonly selfCommand: readonly string[];
}

/** A place of REACH_DENY has a path no rule can hold, or the session's own folder lies in one of them: no start. */
export class ReachRuleError extends TypeError {
  readonly place: string;

  constructor(place: string) {
    super(`the deny rules beyond the session's folder cannot be written (${place})`);
    this.name = 'ReachRuleError';
    this.place = place;
  }
}

/** A path without the slashes it ends with (no regular expression: text-cost.test.ts). */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

function within(path: string, folder: string): boolean {
  const base = withoutTrailingSlashes(folder);
  return path === base || path.startsWith(`${base}/`);
}

/**
 * The deny rules of DESIGN 0.6.0 D8a for one session (REACH_DENY), none for a discussion. Throws ReachRuleError when a
 * place cannot be written as a rule, or when the session's own folder lies in a place a rule refuses (the rule would
 * refuse the session its own folder).
 */
export function reachDenyRules(input: { readonly purpose: AgentPurpose; readonly root: RootRef; readonly rootRealPath: string; readonly reach: ReachPlaces }): string[] {
  if (input.purpose === 'discussion') return [];
  const { reach, rootRealPath } = input;
  const rules: string[] = [];
  const add = (place: string, tool: 'Read' | 'Edit', abs: string, rel?: string): void => {
    try {
      rules.push(absoluteRule(tool, abs, rel));
    } catch (err) {
      if (err instanceof RulePathError) throw new ReachRuleError(place);
      throw err;
    }
  };
  const refusesOwnFolder = (place: string, folder: string): void => {
    if (within(rootRealPath, folder)) throw new ReachRuleError(place);
  };
  if (input.root.kind === 'worktree') {
    for (const pattern of REACH_DENY.mainForWorktree.read) add('main', 'Read', reach.mainRealPath, pattern);
    for (const pattern of REACH_DENY.mainForWorktree.edit) add('main', 'Edit', reach.mainRealPath, pattern);
  }
  refusesOwnFolder('main', `${withoutTrailingSlashes(reach.mainRealPath)}/.smurg/git`);
  for (const pattern of REACH_DENY.main.read) add('main', 'Read', reach.mainRealPath, pattern);
  for (const pattern of REACH_DENY.main.edit) add('main', 'Edit', reach.mainRealPath, pattern);
  if (reach.hostHome !== null) {
    for (const dir of HOST_HOME_AGENT_CONFIG) refusesOwnFolder('host-home', `${withoutTrailingSlashes(reach.hostHome)}/${dir}`);
    for (const pattern of REACH_DENY.hostHome.edit) add('host-home', 'Edit', reach.hostHome, pattern);
  }
  if (reach.claudeConfigDir !== null) {
    refusesOwnFolder('claude-config-dir', reach.claudeConfigDir);
    for (const pattern of REACH_DENY.claudeConfigDir.edit) add('claude-config-dir', 'Edit', reach.claudeConfigDir, pattern);
  }
  refusesOwnFolder('state-dir', reach.stateDir);
  for (const pattern of REACH_DENY.stateDir.read) add('state-dir', 'Read', reach.stateDir, pattern);
  for (const pattern of REACH_DENY.stateDir.edit) add('state-dir', 'Edit', reach.stateDir, pattern);
  for (const file of new Set(reach.selfCommand)) add('self-command', 'Edit', file);
  return [...new Set(rules)];
}

/**
 * What one PROCESS runs instead of what its session asks for, because Claude Code cannot run that (DESIGN 0.6.0 D9):
 * `ask-commands` when auto mode (or running without asking) cannot run, `auto` when running without asking cannot.
 * Set by the runner before a start (a model without auto mode) and when Claude Code reports another mode; reset at
 * every start.
 */
export type ProcessFallback = 'none' | 'ask-commands' | 'auto';

/**
 * The smurg mode a process runs with: the session's effective mode, after this process's fallback. A fallback only
 * ever makes the mode stricter, and only a mode it stands in for: `ask-commands` replaces `auto` and `ask-nothing`,
 * `auto` replaces `ask-nothing`. A session that asks before edits keeps asking whatever the fallback says.
 */
export function modeWithFallback(mode: PermissionMode, fallback: ProcessFallback): PermissionMode {
  if (fallback === 'ask-commands' && (mode === 'auto' || mode === 'ask-nothing')) return 'ask-commands';
  if (fallback === 'auto' && mode === 'ask-nothing') return 'auto';
  return mode;
}

/**
 * smurg's mode → Claude Code's (DESIGN 0.6.0 D8). A discussion always runs in `default` (its tools are fixed). In the
 * main workspace `ask-commands` runs in `default`, where the DAEMON allows the edit tools (daemonAllowsEdits): Claude
 * Code's acceptEdits would also let simple file commands through. `auto` → `auto`; `ask-nothing` → `bypassPermissions`,
 * which is launched only behind the four checks of the sessions module (and refused by checkLaunchArgs otherwise).
 */
export function claudeModeFor(purpose: AgentPurpose, mode: PermissionMode, root: RootRef, fallback: ProcessFallback): ClaudeMode {
  if (purpose === 'discussion') return 'default';
  switch (modeWithFallback(mode, fallback)) {
    case 'ask-all':
      return 'default';
    case 'ask-commands':
      return root.kind === 'worktree' ? 'acceptEdits' : 'default';
    case 'auto':
      return 'auto';
    case 'ask-nothing':
      return 'bypassPermissions';
  }
}

/** Strict to loose, as Claude Code's modes let a call through (DESIGN 0.6.0 D9). */
const CLAUDE_MODE_ORDER: readonly ClaudeMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions'];

/** The rank of a mode Claude Code reports; one smurg never launches (`plan`, `dontAsk`, anything unknown) counts as the loosest. */
export function claudeModeRank(mode: string): number {
  const at = CLAUDE_MODE_ORDER.indexOf(mode as ClaudeMode);
  return at === -1 ? CLAUDE_MODE_ORDER.length : at;
}

/** A Claude Code mode as one of the four smurg launches with, or null (`plan`, `dontAsk`, anything unknown). */
export function asClaudeMode(mode: string): ClaudeMode | null {
  return (CLAUDE_MODE_ORDER as readonly string[]).includes(mode) ? (mode as ClaudeMode) : null;
}

/** The smurg mode a Claude Code mode stands for (what a session that RUNS in it may do without asking). */
export function smurgModeOf(mode: ClaudeMode): PermissionMode {
  switch (mode) {
    case 'default':
      return 'ask-all';
    case 'acceptEdits':
      return 'ask-commands';
    case 'auto':
      return 'auto';
    case 'bypassPermissions':
      return 'ask-nothing';
  }
}

/**
 * The daemon allows edit requests without a card (after the host-only check and the lock): a main-workspace session
 * that RUNS as "Asks before commands" (chosen, or auto's fallback): `modeInUse` (DESIGN 0.6.0 D8), not the mode the
 * session asked for. Claude Code's mode stays `default` there, so every shell write still asks.
 */
export function daemonAllowsEdits(purpose: AgentPurpose, modeInUse: PermissionMode, root: RootRef): boolean {
  return purpose !== 'discussion' && modeInUse === 'ask-commands' && root.kind === 'main';
}

export interface ProfileInput {
  readonly purpose: AgentPurpose;
  /** The session's effective mode (effectivePermissionMode). */
  readonly mode: PermissionMode;
  /** What this process runs instead, when Claude Code cannot run the mode (DESIGN 0.6.0 D9). */
  readonly fallback: ProcessFallback;
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
  /** The session's model (`--model`, DESIGN 0.6.0 D7); null: none is passed and the host's own default applies. */
  readonly model: string | null;
  /** The places beyond the session's own folder that its deny rules cover (DESIGN 0.6.0 D8a, REACH_DENY). */
  readonly reach: ReachPlaces;
}

/**
 * The launch profile of one process start. Rules read back from disk are checked again: only a rememberable form is
 * written. Throws RulePathError for a root no rule can name, ReachRuleError for a place of REACH_DENY.
 */
export function buildProfile(input: ProfileInput): LaunchProfile {
  const { purpose, rootRealPath } = input;
  const discussion = purpose === 'discussion';
  const allow: string[] = [];
  const deny: string[] = [
    ...AGENT_READ_DENY_PATTERNS.map((pattern) => fileRule('Read', rootRealPath, pattern)),
    ...AGENT_EDIT_DENY_PATTERNS.map((pattern) => fileRule('Edit', rootRealPath, pattern)),
  ];
  // smurg's own folder in the shared folder (its history, worktrees, uploads, the share lock), as `.git` is (D10).
  if (input.root.kind === 'main') deny.push(fileRule('Edit', rootRealPath, MAIN_SMURG_EDIT_DENY));
  // Beyond the session's own folder, in every mode (D8a).
  deny.push(...reachDenyRules({ purpose, root: input.root, rootRealPath, reach: input.reach }));
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
    mode: claudeModeFor(purpose, input.mode, input.root, input.fallback),
    tools: discussion ? DISCUSSION_TOOLS : EXECUTION_TOOLS,
    allow,
    ask: [],
    deny,
    // A discussion always has only smurg's own server; the others unless the host allowed theirs.
    strictMcp: discussion || !input.agentMcp,
    settingSources: input.trust === 'ignored' ? 'user' : 'all',
    rolePrompt: input.rolePrompt,
    model: input.model,
  };
}

/** What the hook registration lists as the session's tools: the profile's list, plus any MCP tool when the host allowed theirs. */
export function gateToolsOf(profile: Pick<LaunchProfile, 'tools' | 'strictMcp'>): readonly string[] {
  return profile.strictMcp ? profile.tools : [...profile.tools, ANY_MCP_TOOL];
}

const VALUE_FLAGS = new Set(['--settings', '--mcp-config', '--tools', '--permission-mode', '--append-system-prompt-file', '--setting-sources', '--model']);
const BARE_FLAGS = new Set(['--strict-mcp-config']);

/**
 * THE launch check (DESIGN §2.1), failing closed: `--settings`, `--mcp-config` and `--tools` must be present;
 * `--permission-mode` must be present with `default`, `acceptEdits` or `auto`, and `bypassPermissions` only with
 * `bypass` (DESIGN 0.6.0 D8: the sessions module's four checks passed); besides these only
 * `--append-system-prompt-file`, `--setting-sources user`, `--strict-mcp-config` and `--model <a model id>` (DESIGN
 * 0.6.0 D7: an id of `modelIdSchema`, never one that reads as a flag) may appear, each at most once.
 * `--dangerously-skip-permissions` and `--allow-dangerously-skip-permissions` are unknown flags: smurg never passes
 * them (a `-p` run starts in `bypassPermissions` from the mode flag alone). Returns null when the flags pass, else why
 * not.
 */
export function checkLaunchArgs(args: readonly string[], options: { readonly bypass: boolean } = { bypass: false }): string | null {
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
    if (flag === '--model' && (value.startsWith('-') || !modelIdSchema.safeParse(value).success)) return 'not a model id';
    seen.set(flag, value);
    i += 1;
  }
  for (const required of ['--settings', '--mcp-config', '--tools', '--permission-mode']) if (!seen.has(required)) return `missing ${required}`;
  const mode = seen.get('--permission-mode');
  if (mode !== 'default' && mode !== 'acceptEdits' && mode !== 'auto' && !(mode === 'bypassPermissions' && options.bypass)) return 'permission mode not allowed';
  const sources = seen.get('--setting-sources');
  if (sources !== undefined && sources !== 'user') return 'setting sources not allowed';
  for (const path of [seen.get('--settings'), seen.get('--mcp-config'), seen.get('--append-system-prompt-file')]) {
    if (path !== undefined && !path.startsWith('/')) return 'a launch file path is not absolute';
  }
  return null;
}

/**
 * THE check of the settings file a session is started with (DESIGN 0.6.0 D8), run on the object the writer wrote,
 * before the spawn, failing closed: running without asking stays disabled (`disableBypassPermissionsMode: 'disable'`)
 * unless `bypass`; with `bypass` the key is absent and Claude Code's fallback (`defaultMode`) is `auto`; `defaultMode`
 * is never `bypassPermissions`; and every rule of `reach` (DESIGN D8a for this session) is in `permissions.deny`.
 * Returns null when the file passes, else why not.
 */
export function checkSessionSettings(settings: unknown, options: { readonly bypass: boolean; readonly reach: readonly string[] }): string | null {
  const permissions = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)['permissions'] : undefined;
  if (typeof permissions !== 'object' || permissions === null) return 'no permissions';
  const entries = permissions as Record<string, unknown>;
  const disable = entries['disableBypassPermissionsMode'];
  const defaultMode = entries['defaultMode'];
  if (options.bypass) {
    if (disable !== undefined) return 'bypass is disabled by the file';
    if (defaultMode !== 'auto') return 'the fallback of bypass is not auto';
  } else if (disable !== 'disable') return 'bypass is not disabled';
  if (defaultMode === 'bypassPermissions') return 'default mode is bypass';
  if (typeof defaultMode !== 'string' || !['default', 'acceptEdits', 'auto'].includes(defaultMode)) return 'default mode not allowed';
  const deny = Array.isArray(entries['deny']) ? (entries['deny'] as unknown[]) : [];
  for (const rule of options.reach) if (!deny.includes(rule)) return 'a deny rule beyond the folder is missing';
  return null;
}
