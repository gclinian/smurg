// The files a session is launched with (ARCHITECTURE §7.6 "Launch", §11 D-1): settings.json (--settings) and
// mcp.json (--mcp-config). Every session gets the same files: they all run like the host's own (§11 D-15).
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonContext } from '../../src/core/context.ts';
import { HookServerImpl } from '../../src/hooks/hook-server.ts';
import { buildMcpConfig, buildSessionSettings, claudeArgsFor, fileChangedMatcher, sessionFilesDir, sessionFilesRoot } from '../../src/hooks/settings-writer.ts';
import { TEST_HOST_USER } from '../../src/testing/index.ts';
import { registerAgent, startHookDaemon, type HookDaemon } from './helpers.ts';

const SELF = { file: '/opt/smurg/bin/node', args: ['/opt/smurg/cli/src/main.ts'] };
const HOOK = { type: 'command', command: '/opt/smurg/bin/node', args: ['/opt/smurg/cli/src/main.ts', 'hook'], timeout: 10 };
const EDITS = 'Edit|Write|MultiEdit|NotebookEdit';

describe('session settings (ARCHITECTURE §7.6)', () => {
  it("hooks off-switches neutralized, deep links off, mcp__smurg allowed, bypass mode disabled, permissions.defaultMode 'default' (2.1.283 would start in auto mode without edit prompts), every hook event", () => {
    const settings = buildSessionSettings({ command: SELF, fileChangedNames: ['README.md', 'package.json'] });
    expect(settings).toEqual({
      disableAllHooks: false,
      env: { CLAUDE_CODE_SAFE_MODE: '0', CLAUDE_CODE_SIMPLE: '0' },
      disableDeepLinkRegistration: 'disable',
      permissions: { allow: ['mcp__smurg'], disableBypassPermissionsMode: 'disable', defaultMode: 'default' },
      hooks: {
        PreToolUse: [{ matcher: EDITS, hooks: [HOOK] }],
        PostToolUse: [{ matcher: EDITS, hooks: [HOOK] }],
        PostToolUseFailure: [{ matcher: EDITS, hooks: [HOOK] }],
        PermissionRequest: [{ matcher: EDITS, hooks: [HOOK] }],
        UserPromptSubmit: [{ hooks: [HOOK] }],
        Stop: [{ hooks: [HOOK] }],
        SessionStart: [{ hooks: [HOOK] }],
        SessionEnd: [{ hooks: [HOOK] }],
        FileChanged: [{ matcher: 'README.md|package.json', hooks: [HOOK] }],
      },
    });
    expect(JSON.stringify(settings)).not.toMatch(/"allow"\s*:\s*"|bypassPermissions|dangerously/);
  });

  it('without watchable file names: no FileChanged hook; the rest unchanged, and none of the former guest-only keys (what the host variant was, now for every session)', () => {
    const settings = buildSessionSettings({ command: SELF });
    expect(settings['permissions']).toEqual({ allow: ['mcp__smurg'], disableBypassPermissionsMode: 'disable', defaultMode: 'default' });
    expect(settings).not.toHaveProperty('claudeMdExcludes');
    expect(settings).not.toHaveProperty('disabledMcpjsonServers');
    expect(settings).not.toHaveProperty(['hooks', 'FileChanged']);
    expect(settings['disableAllHooks']).toBe(false);
    expect(settings['env']).toEqual({ CLAUDE_CODE_SAFE_MODE: '0', CLAUDE_CODE_SIMPLE: '0' });
  });

  it('D-13: with bashActivity the Bash ACTIVITY hook is its own matcher group (`hook bash-activity`, 5 s); the edit groups stay exactly the lock hook', () => {
    const on = buildSessionSettings({ command: SELF, bashActivity: true });
    const off = buildSessionSettings({ command: SELF, bashActivity: false });
    const BASH = { type: 'command', command: '/opt/smurg/bin/node', args: ['/opt/smurg/cli/src/main.ts', 'hook', 'bash-activity'], timeout: 5 };
    const hooks = on['hooks'] as Record<string, unknown>;
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      expect(hooks[event], event).toEqual([{ matcher: EDITS, hooks: [HOOK] }, { matcher: 'Bash', hooks: [BASH] }]);
      expect((off['hooks'] as Record<string, unknown>)[event], event).toEqual([{ matcher: EDITS, hooks: [HOOK] }]);
    }
    // Only the three tool events carry it; no other event runs the Bash hook, and the lock hook never gets Bash.
    expect(hooks['PermissionRequest']).toEqual([{ matcher: EDITS, hooks: [HOOK] }]);
    expect(JSON.stringify({ ...hooks, PreToolUse: null, PostToolUse: null, PostToolUseFailure: null })).not.toContain('bash-activity');
    expect(buildSessionSettings({ command: SELF })).toEqual(off);
  });

  it('D-13: the hook server writes the Bash hook exactly when config.activity.attributeBashEdits is on', async () => {
    const d = await startHookDaemon({ daemon: { project: { files: { 'a.txt': 'a' } } } });
    try {
      for (const attributeBashEdits of [true, false]) {
        const server = new HookServerImpl({ ...d.t.ctx, config: { ...d.t.ctx.config, sessions: { ...d.t.ctx.config.sessions, selfCommand: SELF }, activity: { attributeBashEdits } } });
        const s = registerAgent(server, { userId: TEST_HOST_USER, name: 'Host' });
        const files = await server.writeSessionFiles(s.sessionId);
        const settings = JSON.parse(await readFile(files.settingsPath, 'utf8')) as { hooks: Record<string, { matcher?: string }[]> };
        expect(settings.hooks['PreToolUse']?.map((group) => group.matcher), String(attributeBashEdits)).toEqual(attributeBashEdits ? [EDITS, 'Bash'] : [EDITS]);
        await server.removeSessionFiles(s.sessionId);
        server.unregisterSession(s.sessionId);
      }
    } finally {
      await d.t.cleanup();
    }
  });

  it('the hook is the exec-form command of config.sessions.selfCommand (no shell), the MCP server the same binary with `mcp`', () => {
    const production = { file: '/usr/local/bin/smurg', args: [] };
    const settings = buildSessionSettings({ command: production });
    expect((settings['hooks'] as Record<string, { hooks: unknown[] }[]>)['PreToolUse']?.[0]?.hooks).toEqual([{ type: 'command', command: '/usr/local/bin/smurg', args: ['hook'], timeout: 10 }]);
    expect(buildMcpConfig(production)).toEqual({ mcpServers: { smurg: { type: 'stdio', command: '/usr/local/bin/smurg', args: ['mcp'], env: {} } } });
    expect(buildMcpConfig(SELF)).toEqual({ mcpServers: { smurg: { type: 'stdio', command: SELF.file, args: [...SELF.args, 'mcp'], env: {} } } });
  });

  it("claude flags: --settings and --mcp-config for every session, no --strict-mcp-config (every session keeps the host's own MCP servers, as the host's did), never a permission-mode or skip-permissions flag", () => {
    const files = { settingsPath: '/s/settings.json', mcpConfigPath: '/s/mcp.json' };
    expect(claudeArgsFor(files)).toEqual(['--settings', '/s/settings.json', '--mcp-config', '/s/mcp.json']);
  });

  it('FileChanged watches only plain file names (the matcher is also read as a regex)', () => {
    expect(fileChangedMatcher(['a.txt', 'b|c', '(x)', 'README.md', 'a.txt', ''])).toBe('README.md|a.txt');
    expect(fileChangedMatcher([])).toBeNull();
  });
});

describe('session files on disk', () => {
  let d: HookDaemon | null = null;
  afterEach(async () => {
    await d?.t.cleanup();
    d = null;
  });

  /** The daemon's hook server as the CLI would configure it (createTestDaemon passes no selfCommand). */
  function withSelfCommand(ctx: DaemonContext): HookServerImpl {
    return new HookServerImpl({ ...ctx, config: { ...ctx.config, sessions: { ...ctx.config.sessions, selfCommand: SELF } } });
  }

  it("writes settings.json and mcp.json 0600 into a private 0700 dir under <stateDir>/sessions, atomically; nothing into the project's .claude/", async () => {
    d = await startHookDaemon({ daemon: { project: { files: { '.mcp.json': JSON.stringify({ mcpServers: { planted: { command: 'x' } } }), 'README.md': '#' } } } });
    const hooks = withSelfCommand(d.t.ctx);
    const s = registerAgent(hooks, { userId: 'dev:ian', name: 'Ian' });
    const files = await hooks.writeSessionFiles(s.sessionId);
    expect(files.dir).toBe(sessionFilesDir(d.t.stateDir, d.t.workspaceId, s.sessionId));
    expect(files.dir.startsWith(join(d.t.stateDir, 'sessions') + '/')).toBe(true);
    expect(files.claudeArgs).toEqual(['--settings', files.settingsPath, '--mcp-config', files.mcpConfigPath]);
    for (const dir of [join(d.t.stateDir, 'sessions'), dirname(files.dir), files.dir]) expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    for (const file of [files.settingsPath, files.mcpConfigPath]) expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(files.dir)).sort()).toEqual(['mcp.json', 'settings.json']);
    const settings = JSON.parse(await readFile(files.settingsPath, 'utf8')) as Record<string, unknown>;
    // The project's .mcp.json servers are not switched off any more: the session runs like the host's own.
    expect(settings).not.toHaveProperty('disabledMcpjsonServers');
    expect(settings).not.toHaveProperty('claudeMdExcludes');
    expect(settings['hooks']).toHaveProperty('FileChanged');
    expect(JSON.parse(await readFile(files.mcpConfigPath, 'utf8'))).toEqual(buildMcpConfig(SELF));
    // ARCHITECTURE §11 D-1: nothing goes into the project's .claude/ (collaborators can write there).
    await expect(lstat(join(d.t.root, '.claude'))).rejects.toThrow();
  });

  it("a member's session gets exactly the host's settings (the former host variant: permissions.defaultMode 'default', no --strict-mcp-config)", async () => {
    d = await startHookDaemon();
    const hooks = withSelfCommand(d.t.ctx);
    const host = registerAgent(hooks, { userId: TEST_HOST_USER, name: 'Host' });
    const ian = registerAgent(hooks, { userId: 'dev:ian', name: 'Ian' });
    const hostFiles = await hooks.writeSessionFiles(host.sessionId);
    const ianFiles = await hooks.writeSessionFiles(ian.sessionId);
    const hostSettings = JSON.parse(await readFile(hostFiles.settingsPath, 'utf8')) as { permissions: Record<string, unknown> };
    expect(hostSettings.permissions['defaultMode']).toBe('default');
    expect(JSON.parse(await readFile(ianFiles.settingsPath, 'utf8'))).toEqual(hostSettings);
    expect(JSON.parse(await readFile(ianFiles.mcpConfigPath, 'utf8'))).toEqual(JSON.parse(await readFile(hostFiles.mcpConfigPath, 'utf8')));
    for (const files of [hostFiles, ianFiles]) expect(files.claudeArgs).toEqual(['--settings', files.settingsPath, '--mcp-config', files.mcpConfigPath]);
  });

  it('refuses to write session files without config.sessions.selfCommand, or for a session that is not registered (fail closed)', async () => {
    d = await startHookDaemon();
    const s = registerAgent(d.hooks, { userId: TEST_HOST_USER, name: 'Host' });
    await expect(d.hooks.writeSessionFiles(s.sessionId)).rejects.toMatchObject({ code: 'internal', detail: { reason: 'no-self-command' } });
    await expect(withSelfCommand(d.t.ctx).writeSessionFiles('ses_unknown')).rejects.toMatchObject({ detail: { reason: 'hook-session-not-registered' } });
  });

  it("unregistering a session removes its files; a daemon start removes this workspace's stale session dirs", async () => {
    d = await startHookDaemon();
    const hooks = withSelfCommand(d.t.ctx);
    const s = registerAgent(hooks, { userId: TEST_HOST_USER, name: 'Host' });
    const files = await hooks.writeSessionFiles(s.sessionId);
    hooks.unregisterSession(s.sessionId);
    await expect.poll(() => lstat(files.dir).then(() => 'exists', () => 'gone')).toBe('gone');
    const stale = join(sessionFilesRoot(d.t.stateDir, d.t.workspaceId), 'deadbeef');
    await mkdir(stale, { recursive: true });
    await d.hooks.stop();
    const fresh = new HookServerImpl(d.t.ctx);
    await fresh.start();
    await expect(lstat(stale)).rejects.toThrow();
    await fresh.stop();
  });
});
