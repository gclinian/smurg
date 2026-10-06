// The files an agent session's `claude` process is launched with (ARCHITECTURE §7.6 "Launch", §11 D-1; DESIGN §2.1):
// the daemon-owned settings.json passed with `--settings` (the tool gate, the other hooks, the kill-switch
// neutralizers, the profile's rules), the mcp.json passed with `--mcp-config` (smurg's own MCP server), and role.md
// (`--append-system-prompt-file`). They are derived data: rewritten at every process start, removed when it ends.
//
// Why `--settings` and not the project's `.claude/`: flag settings rank above user, project and local settings, so a
// planted `disableAllHooks: true` or an `env.CLAUDE_CODE_SIMPLE` elsewhere cannot switch smurg's gate off
// (claude-hooks.md §1.1, §1.2, experiments C, C3, exp-v-hook-kill), and the file lives outside the shared folder.
// Every rule is one string per array element (`--allowedTools` / `--disallowedTools` are never used), so no rule text
// is ever parsed as a list of rules. The builders are pure; the writers write 0600 files atomically.
import { constants as fsConstants } from 'node:fs';
import { open, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { ensurePrivateDirectory } from '@smurg/protocol/node';
import type { LaunchProfile, SessionLaunchFiles } from '../core/interfaces.ts';
import { syncDirectory } from '../core/state-store.ts';
import {
  BASH_HOOK_TIMEOUT_SECONDS,
  BASH_TOOL_NAME,
  EDIT_TOOL_MATCHER,
  GATE_MATCHER,
  HOOK_CLI_BASH_ACTIVITY_ARG,
  HOOK_COMMAND_TIMEOUT_SECONDS,
  MCP_SERVER_NAME,
  type JsonObject,
} from './wire.ts';

/** How a session runs `smurg` (config.sessions.selfCommand): `hook` / `mcp` are appended to `args`. */
export interface SelfCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface SessionSettingsInput {
  readonly command: SelfCommand;
  /** Literal file names in the session root that the FileChanged hook watches (activity feed only, D-6). */
  readonly fileChangedNames?: readonly string[];
  /**
   * config.activity.attributeBashEdits (§11 D-13): also register the Bash ACTIVITY hook for Bash PreToolUse /
   * PostToolUse / PostToolUseFailure. It is a separate handler (`hook bash-activity`) that fails open; the lock hook of
   * the edit tools is unchanged. Default false (the hooks module passes the configuration).
   */
  readonly bashActivity?: boolean;
  /** The session's launch profile (ARCHITECTURE §7.6 "Profiles"): Claude Code's mode and the rules of this start. */
  readonly profile?: Pick<LaunchProfile, 'mode' | 'allow' | 'ask' | 'deny'>;
}

/** The exec-form hook of THE TOOL GATE (no shell, no quoting): `<file> <...args> hook`. Fails closed for every tool (hook-cli.ts). */
export function hookHandler(command: SelfCommand): JsonObject {
  return { type: 'command', command: command.file, args: [...command.args, 'hook'], timeout: HOOK_COMMAND_TIMEOUT_SECONDS };
}

/** The exec-form Bash ACTIVITY hook: `<file> <...args> hook bash-activity`. Fails open, never decides (hook-cli.ts). */
export function bashActivityHandler(command: SelfCommand): JsonObject {
  return { type: 'command', command: command.file, args: [...command.args, 'hook', HOOK_CLI_BASH_ACTIVITY_ARG], timeout: BASH_HOOK_TIMEOUT_SECONDS };
}

/** Names FileChanged may watch: plain names only (the matcher is also read as a regex; `|` separates names). */
const WATCHABLE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
export const FILE_CHANGED_MAX_NAMES = 50;

/** The FileChanged matcher for `names`, or null when there is nothing to watch. */
export function fileChangedMatcher(names: readonly string[]): string | null {
  const usable = [...new Set(names.filter((name) => WATCHABLE_NAME.test(name) && name !== '.' && name !== '..'))].sort().slice(0, FILE_CHANGED_MAX_NAMES);
  return usable.length > 0 ? usable.join('|') : null;
}

/** The session settings file (ARCHITECTURE §7.6). */
export function buildSessionSettings(input: SessionSettingsInput): JsonObject {
  const handler = hookHandler(input.command);
  const all = [{ hooks: [handler] }];
  const edits = [{ matcher: EDIT_TOOL_MATCHER, hooks: [handler] }];
  // The Bash activity hook is its own matcher group with its own handler (it fails open and decides nothing).
  const bash = input.bashActivity === true ? [{ matcher: BASH_TOOL_NAME, hooks: [bashActivityHandler(input.command)] }] : [];
  const hooks: JsonObject = {
    // THE TOOL GATE: before every tool call, the MCP tools and AskUserQuestion included (DESIGN §2.10).
    PreToolUse: [{ matcher: GATE_MATCHER, hooks: [handler] }, ...bash],
    // After an edit the agent lock is released; a Bash result closes the command's window.
    PostToolUse: [...edits, ...bash],
    PostToolUseFailure: [...edits, ...bash],
    PermissionRequest: edits,
    UserPromptSubmit: all,
    Stop: all,
    SessionStart: all,
    SessionEnd: all,
  };
  const watch = fileChangedMatcher(input.fileChangedNames ?? []);
  if (watch !== null) hooks['FileChanged'] = [{ matcher: watch, hooks: [handler] }];
  const profile = input.profile ?? { mode: 'default' as const, allow: [], ask: [], deny: [] };
  // A `-p` session without a mode starts in `auto` on the verified version: the mode is always given (flag and file).
  const permissions: JsonObject = {
    allow: [`mcp__${MCP_SERVER_NAME}`, ...profile.allow],
    ask: [...profile.ask],
    // `ListAgents` lists the host's OTHER Claude Code sessions on the machine: no agent session may.
    deny: ['ListAgents', ...profile.deny],
    disableBypassPermissionsMode: 'disable',
    defaultMode: profile.mode,
  };
  const settings: JsonObject = {
    disableAllHooks: false,
    // Safe mode and bare mode switch off every hook, --settings ones included, from the launch env or a user- or
    // project-settings env block an agent can write; the --settings env wins over both (claude-hooks.md §1.2).
    env: { CLAUDE_CODE_SAFE_MODE: '0', CLAUDE_CODE_SIMPLE: '0' },
    disableDeepLinkRegistration: 'disable',
    // No other Claude Code session on the host's machine may message this one (cross-session messaging, S11).
    crossSessionInbound: 'refuse',
    permissions,
    hooks,
  };
  return settings;
}

/** The `--mcp-config` file: the coordination server only. It inherits the session's environment (token, socket). */
export function buildMcpConfig(command: SelfCommand): JsonObject {
  return { mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: command.file, args: [...command.args, 'mcp'], env: {} } } };
}

/**
 * The PROFILE flags of one process start (the stream flags are the runner's constant). The sessions module checks them
 * against its allow-list before the spawn. Never a bypass flag, never `--model`, never `--allowedTools`.
 */
export function claudeArgsFor(files: { readonly settingsPath: string; readonly mcpConfigPath: string; readonly rolePromptPath?: string }, profile?: Pick<LaunchProfile, 'mode' | 'tools' | 'strictMcp' | 'settingSources'>): string[] {
  const args = ['--permission-mode', profile?.mode ?? 'default', '--settings', files.settingsPath, '--mcp-config', files.mcpConfigPath];
  if (profile !== undefined) args.push('--tools', profile.tools.join(','));
  if (files.rolePromptPath !== undefined) args.push('--append-system-prompt-file', files.rolePromptPath);
  if (profile?.strictMcp === true) args.push('--strict-mcp-config');
  if (profile?.settingSources === 'user') args.push('--setting-sources', 'user');
  return args;
}

const TOOL_NAME = /^[A-Za-z0-9_]{1,64}$/;

// ---------------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------------

/** Writes `value` as `<dir>/<name>` (0600): tmp (O_EXCL, O_NOFOLLOW) → fsync → rename → dir fsync. */
export async function writePrivateJson(dir: string, name: string, value: unknown): Promise<{ readonly dev: number; readonly ino: number }> {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = join(dir, `.${name}.smurg-${randomBytes(6).toString('hex')}.tmp`);
  let placed = false;
  try {
    const handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    let identity: { dev: number; ino: number };
    try {
      await handle.chmod(0o600);
      await handle.writeFile(data);
      await handle.sync();
      const st = await handle.stat();
      identity = { dev: st.dev, ino: st.ino };
    } finally {
      await handle.close();
    }
    await rename(tmp, join(dir, name));
    placed = true;
    await syncDirectory(dir);
    return identity;
  } finally {
    if (!placed) await unlink(tmp).catch(() => {});
  }
}

/**
 * `<stateDir>/sessions/<workspace key>/<session key>` (ARCHITECTURE §7.1 `sessions/<sessionId>/`). Both keys are
 * lowercase hex: ids are case-sensitive and APFS is not (§7.1), and the workspace level lets a daemon remove its own
 * stale session dirs at start without touching those of another workspace's daemon sharing the state dir.
 */
export function sessionFilesRoot(stateDir: string, workspaceId: string): string {
  return join(stateDir, 'sessions', createHash('sha256').update(`smurg-sessions:${workspaceId}`).digest('hex').slice(0, 24));
}

export function sessionFilesDir(stateDir: string, workspaceId: string, sessionId: string): string {
  return join(sessionFilesRoot(stateDir, workspaceId), Buffer.from(sessionId, 'utf8').toString('hex'));
}

/** The contract's SessionLaunchFiles (core/interfaces.ts): what HookServer.writeSessionFiles returns. */
export type SessionFiles = SessionLaunchFiles;

export interface WriteSessionFilesInput {
  readonly stateDir: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly settings: SessionSettingsInput & { readonly profile: LaunchProfile };
  /** The exact bytes of role.md (the session's role prompt; `--append-system-prompt-file`). */
  readonly rolePrompt: string;
}

/**
 * Work on one session's launch directory runs one after the other, in the order it was asked for. The files are
 * removed when a process ends (not awaited by the caller) and written again when the session's next process starts,
 * which can be at once (a retry, a resume, a message that arrives while the process goes away): a removal that was
 * still running would take the next start's files, and that agent would start without smurg's settings or not at all.
 */
const directoryWork = new Map<string, Promise<void>>();

function inOrder<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const run = (directoryWork.get(dir) ?? Promise.resolve()).then(work);
  const settled = run.then(
    () => {},
    () => {},
  );
  directoryWork.set(dir, settled);
  void settled.then(() => {
    if (directoryWork.get(dir) === settled) directoryWork.delete(dir);
  });
  return run;
}

/** Creates the session's private directory and writes settings.json, mcp.json and role.md into it (0600). */
export async function writeSessionFiles(input: WriteSessionFilesInput): Promise<SessionFiles> {
  const profile = input.settings.profile;
  // `--tools` is a comma-separated list: a name that is not a plain tool name would change the list.
  if (profile.tools.length === 0 || profile.tools.some((tool) => !TOOL_NAME.test(tool))) throw new TypeError('not a tool list');
  const sessionsDir = join(input.stateDir, 'sessions');
  const root = sessionFilesRoot(input.stateDir, input.workspaceId);
  const dir = sessionFilesDir(input.stateDir, input.workspaceId, input.sessionId);
  return inOrder(dir, async () => {
    // Each level separately: ensurePrivateDirectory refuses an existing directory that is a symlink or not 0700.
    await ensurePrivateDirectory(sessionsDir);
    await ensurePrivateDirectory(root);
    await ensurePrivateDirectory(dir);
    const settingsPath = join(dir, 'settings.json');
    const mcpConfigPath = join(dir, 'mcp.json');
    await writePrivateJson(dir, 'settings.json', buildSessionSettings(input.settings));
    await writePrivateJson(dir, 'mcp.json', buildMcpConfig(input.settings.command));
    const rolePromptPath = join(dir, 'role.md');
    await writeFile(rolePromptPath, input.rolePrompt, { mode: 0o600, flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW });
    return Object.freeze({ dir, settingsPath, mcpConfigPath, rolePromptPath, claudeArgs: Object.freeze(claudeArgsFor({ settingsPath, mcpConfigPath, rolePromptPath }, profile)) });
  });
}

/** Removes one session's directory (its process ended), after whatever was asked for that directory before. */
export function removeSessionFiles(stateDir: string, workspaceId: string, sessionId: string): Promise<void> {
  const dir = sessionFilesDir(stateDir, workspaceId, sessionId);
  return inOrder(dir, () => rm(dir, { recursive: true, force: true }));
}

/** Removes every session dir of this workspace (daemon start: launch files are derived data; no process survives a restart). */
export async function removeAllSessionFiles(stateDir: string, workspaceId: string): Promise<void> {
  await rm(sessionFilesRoot(stateDir, workspaceId), { recursive: true, force: true });
}

/** Top-level regular file names of `dir` that FileChanged can watch (bounded; errors ⇒ none). */
export async function watchableTopLevelNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && WATCHABLE_NAME.test(entry.name)).map((entry) => entry.name).sort().slice(0, FILE_CHANGED_MAX_NAMES);
  } catch {
    return [];
  }
}
