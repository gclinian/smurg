// The files a Claude Code session is launched with (ARCHITECTURE §7.6 "Launch", §11 D-1): the daemon-owned
// settings.json passed with `--settings` (hooks + kill-switch neutralizers + permissions), the mcp.json passed with
// `--mcp-config` (the coordination server), and — for guests — the pre-seeded `<guest>/cfg/.claude.json` (trust, and
// approval of the guest's own API key), without which the trust dialog withholds every hook.
//
// Why `--settings` and not the project's `.claude/`: flag settings rank above user, project and local settings, so a
// planted `disableAllHooks: true` or an `env.CLAUDE_CODE_SIMPLE` elsewhere cannot switch smurg's lock hooks off
// (claude-hooks.md §1.1, §1.2, experiments C, C3, exp-v-hook-kill), and the file lives outside the shared folder and
// outside every guest's writable sandbox. The builders are pure; the writers write 0600 files atomically.
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ensurePrivateDirectory } from '@smurg/protocol/node';
import type { SessionLaunchFiles } from '../core/interfaces.ts';
import { syncDirectory } from '../core/state-store.ts';
import {
  BASH_HOOK_TIMEOUT_SECONDS,
  BASH_TOOL_NAME,
  EDIT_TOOL_MATCHER,
  HOOK_CLI_BASH_ACTIVITY_ARG,
  HOOK_COMMAND_TIMEOUT_SECONDS,
  MCP_SERVER_NAME,
  isJsonObject,
  type JsonObject,
} from './wire.ts';

export type SessionVariant = 'host' | 'guest';

/** How a session runs `smurg` (config.sessions.selfCommand): `hook` / `mcp` are appended to `args`. */
export interface SelfCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface SessionSettingsInput {
  readonly variant: SessionVariant;
  readonly command: SelfCommand;
  /** realpath of the session root (the session's cwd): guests exclude the CLAUDE.md files of all its ancestors. */
  readonly rootRealPath: string;
  /** Server names of `<root>/.mcp.json`: guests list them in disabledMcpjsonServers (2.1.220's dialog, §7.6). */
  readonly projectMcpServers?: readonly string[];
  /** Literal file names in the session root that the FileChanged hook watches (activity feed only, D-6). */
  readonly fileChangedNames?: readonly string[];
  /**
   * config.activity.attributeBashEdits (§11 D-13): also register the Bash ACTIVITY hook for Bash PreToolUse /
   * PostToolUse / PostToolUseFailure. It is a separate handler (`hook bash-activity`) that fails open; the lock hook of
   * the edit tools is unchanged. Default false (the hooks module passes the configuration).
   */
  readonly bashActivity?: boolean;
}

/** The exec-form LOCK hook (no shell, no quoting): `<file> <...args> hook`. Fails closed (hook-cli.ts). */
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

/**
 * `claudeMdExcludes` for a guest: Claude Code loads CLAUDE.md files from every ancestor of its cwd (claude-hooks.md
 * §5.1, M3), so a share under the host's home would pull in the host's own `~/CLAUDE.md`; a worktree session would
 * pull in the main share's. The sandbox's read-deny is the second layer.
 */
export function claudeMdExcludesFor(rootRealPath: string): string[] {
  if (!isAbsolute(rootRealPath)) throw new TypeError('rootRealPath must be absolute');
  const out: string[] = [];
  let dir = dirname(resolve(rootRealPath));
  for (;;) {
    out.push(join(dir, 'CLAUDE.md'), join(dir, 'CLAUDE.local.md'), join(dir, '.claude', 'CLAUDE.md'), join(dir, '.claude', 'rules', '**'));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

/** The session settings file (ARCHITECTURE §7.6), host or guest variant. */
export function buildSessionSettings(input: SessionSettingsInput): JsonObject {
  const handler = hookHandler(input.command);
  const all = [{ hooks: [handler] }];
  const edits = [{ matcher: EDIT_TOOL_MATCHER, hooks: [handler] }];
  // The Bash activity hook is its own matcher group with its own handler: the edit tools' groups stay exactly the lock hook.
  const toolEvents = input.bashActivity === true ? [...edits, { matcher: BASH_TOOL_NAME, hooks: [bashActivityHandler(input.command)] }] : edits;
  const hooks: JsonObject = {
    PreToolUse: toolEvents,
    PostToolUse: toolEvents,
    PostToolUseFailure: toolEvents,
    PermissionRequest: edits,
    UserPromptSubmit: all,
    Stop: all,
    SessionStart: all,
    SessionEnd: all,
  };
  const watch = fileChangedMatcher(input.fileChangedNames ?? []);
  if (watch !== null) hooks['FileChanged'] = [{ matcher: watch, hooks: [handler] }];
  const permissions: JsonObject = { allow: [`mcp__${MCP_SERVER_NAME}`], disableBypassPermissionsMode: 'disable' };
  // 2.1.283 starts interactive sessions in auto mode, without edit prompts; the host keeps their prompts (SPEC §11).
  if (input.variant === 'host') permissions['defaultMode'] = 'default';
  const settings: JsonObject = {
    disableAllHooks: false,
    // Safe mode and bare mode switch off every hook, --settings ones included, from the launch env or a user-settings
    // env block the guest's agent can write; the --settings env wins over both (claude-hooks.md §1.2).
    env: { CLAUDE_CODE_SAFE_MODE: '0', CLAUDE_CODE_SIMPLE: '0' },
    disableDeepLinkRegistration: 'disable',
    permissions,
    hooks,
  };
  if (input.variant === 'guest') {
    settings['claudeMdExcludes'] = claudeMdExcludesFor(input.rootRealPath);
    settings['disabledMcpjsonServers'] = [...new Set(input.projectMcpServers ?? [])];
  }
  return settings;
}

/** The `--mcp-config` file: the coordination server only. It inherits the session's environment (token, socket). */
export function buildMcpConfig(command: SelfCommand): JsonObject {
  return { mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: command.file, args: [...command.args, 'mcp'], env: {} } } };
}

/** The flags every session gets (never a permission-mode flag, never --dangerously-skip-permissions). */
export function claudeArgsFor(variant: SessionVariant, files: { readonly settingsPath: string; readonly mcpConfigPath: string }): string[] {
  const args = ['--settings', files.settingsPath, '--mcp-config', files.mcpConfigPath];
  // Guests get only smurg's MCP server; the host keeps their own.
  if (variant === 'guest') args.push('--strict-mcp-config');
  return args;
}

const MCP_SERVER_NAMES_MAX = 200;

/** Server names of a `.mcp.json` text (exact names: disabledMcpjsonServers has no wildcard). Invalid JSON ⇒ []. */
export function projectMcpServerNames(jsonText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!isJsonObject(parsed) || !isJsonObject(parsed['mcpServers'])) return [];
  return Object.keys(parsed['mcpServers'])
    .filter((name) => name.length > 0 && name.length <= 256)
    .slice(0, MCP_SERVER_NAMES_MAX);
}

// ---------------------------------------------------------------------------------------------------------------------
// Guest .claude.json
// ---------------------------------------------------------------------------------------------------------------------

/** How much of an existing `.claude.json` is read back (the guest's own Claude Code keeps state in it). */
const CLAUDE_JSON_MAX_BYTES = 4 * 1024 * 1024;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * `existing` with the session's cwd trusted (`projects[realpath(cwd)].hasTrustDialogAccepted`; without it the trust
 * dialog withholds every hook, and on 2.1.283 its default answer quits) and, when the guest supplied their own API
 * key, its last 20 characters approved (the "Detected a custom API key" dialog defaults to "No" on 2.1.283).
 * Onboarding is left alone so a guest who is not logged in sees Claude Code's own login screens.
 */
export function mergeGuestClaudeJson(existing: unknown, cwdRealPath: string, apiKey?: string | null): JsonObject {
  const base: JsonObject = isJsonObject(existing) ? { ...existing } : {};
  const projects: JsonObject = isJsonObject(base['projects']) ? { ...base['projects'] } : {};
  const current = projects[cwdRealPath];
  projects[cwdRealPath] = { ...(isJsonObject(current) ? current : {}), hasTrustDialogAccepted: true };
  base['projects'] = projects;
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    const suffix = apiKey.slice(-20);
    const responses: JsonObject = isJsonObject(base['customApiKeyResponses']) ? { ...base['customApiKeyResponses'] } : {};
    responses['approved'] = [...stringList(responses['approved']).filter((item) => item !== suffix), suffix];
    responses['rejected'] = stringList(responses['rejected']).filter((item) => item !== suffix);
    base['customApiKeyResponses'] = responses;
  }
  return base;
}

class GuestConfigError extends Error {}

/** A directory the guest could have swapped for a symlink since the daemon created it is refused, not followed. */
async function assertPlainDirectory(dir: string): Promise<void> {
  const st = await lstat(dir);
  if (st.isSymbolicLink()) throw new GuestConfigError('guest config dir is a symlink');
  if (!st.isDirectory()) throw new GuestConfigError('guest config dir is not a directory');
  if ((await realpath(dir)) !== dir) throw new GuestConfigError('guest config dir is reached through a symlink');
}

/** Reads a regular file without following a symlink or blocking on a FIFO; null when absent or not a regular file. */
async function readRegularFile(path: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Pre-seeds `<cfgDir>/.claude.json` for a guest session (ARCHITECTURE §7.6). `cfgDir` is the guest's
 * CLAUDE_CONFIG_DIR, which the guest's sandbox can write: it must be a plain directory (no symlink anywhere on the
 * path) and the written file is checked after the rename, so a swapped directory cannot make the daemon write the
 * host's own `~/.claude.json`. Returns the file's path.
 */
export async function seedGuestClaudeConfig(input: { readonly cfgDir: string; readonly cwd: string; readonly apiKey?: string | null }): Promise<string> {
  if (!isAbsolute(input.cfgDir) || !isAbsolute(input.cwd)) throw new TypeError('cfgDir and cwd must be absolute');
  const cfgDir = resolve(input.cfgDir);
  await assertPlainDirectory(cfgDir);
  const cwdRealPath = await realpath(input.cwd);
  const target = join(cfgDir, '.claude.json');
  const existingText = await readRegularFile(target, CLAUDE_JSON_MAX_BYTES);
  let existing: unknown = null;
  if (existingText !== null) {
    try {
      existing = JSON.parse(existingText);
    } catch {
      existing = null;
    }
  }
  const merged = mergeGuestClaudeJson(existing, cwdRealPath, input.apiKey ?? null);
  const placed = await writePrivateJson(cfgDir, '.claude.json', merged);
  // Post-move check: the file must be where we meant it to be (the guest may have swapped the directory meanwhile).
  const landed = await realpath(target).catch(() => null);
  if (landed !== target) {
    if (landed !== null) {
      const st = await lstat(landed).catch(() => null);
      if (st !== null && st.ino === placed.ino && st.dev === placed.dev) await unlink(landed).catch(() => {});
    }
    throw new GuestConfigError('guest config dir changed while writing .claude.json');
  }
  return target;
}

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
  readonly settings: SessionSettingsInput;
}

/** Creates the session's private directory and writes settings.json + mcp.json into it (both 0600, atomic). */
export async function writeSessionFiles(input: WriteSessionFilesInput): Promise<SessionFiles> {
  const sessionsDir = join(input.stateDir, 'sessions');
  const root = sessionFilesRoot(input.stateDir, input.workspaceId);
  const dir = sessionFilesDir(input.stateDir, input.workspaceId, input.sessionId);
  // Each level separately: ensurePrivateDirectory refuses an existing directory that is a symlink or not 0700.
  await ensurePrivateDirectory(sessionsDir);
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(dir);
  const settingsPath = join(dir, 'settings.json');
  const mcpConfigPath = join(dir, 'mcp.json');
  await writePrivateJson(dir, 'settings.json', buildSessionSettings(input.settings));
  await writePrivateJson(dir, 'mcp.json', buildMcpConfig(input.settings.command));
  return Object.freeze({ dir, settingsPath, mcpConfigPath, claudeArgs: Object.freeze(claudeArgsFor(input.settings.variant, { settingsPath, mcpConfigPath })) });
}

/** Removes one session's directory (session ended). */
export async function removeSessionFiles(stateDir: string, workspaceId: string, sessionId: string): Promise<void> {
  await rm(sessionFilesDir(stateDir, workspaceId, sessionId), { recursive: true, force: true });
}

/** Removes every session dir of this workspace (daemon start: no session survives a restart). */
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
