// The files a session is launched with (ARCHITECTURE §7.6 "Launch", §11 D-1): settings.json (--settings),
// mcp.json (--mcp-config) and the guest's pre-seeded .claude.json.
import { lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonContext } from '../../src/core/context.ts';
import { HookServerImpl } from '../../src/hooks/hook-server.ts';
import {
  buildMcpConfig,
  buildSessionSettings,
  claudeArgsFor,
  claudeMdExcludesFor,
  fileChangedMatcher,
  mergeGuestClaudeJson,
  projectMcpServerNames,
  seedGuestClaudeConfig,
  sessionFilesDir,
  sessionFilesRoot,
} from '../../src/hooks/settings-writer.ts';
import { createTempDir, removeTempDir, TEST_HOST_USER } from '../../src/testing/index.ts';
import { registerAgent, startHookDaemon, type HookDaemon } from './helpers.ts';

const SELF = { file: '/opt/smurg/bin/node', args: ['/opt/smurg/cli/src/main.ts'] };
const HOOK = { type: 'command', command: '/opt/smurg/bin/node', args: ['/opt/smurg/cli/src/main.ts', 'hook'], timeout: 10 };
const EDITS = 'Edit|Write|MultiEdit|NotebookEdit';

describe('session settings (ARCHITECTURE §7.6)', () => {
  it('guest variant: hooks off-switches neutralized, deep links off, mcp__smurg allowed, bypass mode disabled, every hook event, claudeMdExcludes, disabledMcpjsonServers', () => {
    const settings = buildSessionSettings({ variant: 'guest', command: SELF, rootRealPath: '/srv/share/proj', projectMcpServers: ['planted', 'db'], fileChangedNames: ['README.md', 'package.json'] });
    expect(settings).toEqual({
      disableAllHooks: false,
      env: { CLAUDE_CODE_SAFE_MODE: '0', CLAUDE_CODE_SIMPLE: '0' },
      disableDeepLinkRegistration: 'disable',
      permissions: { allow: ['mcp__smurg'], disableBypassPermissionsMode: 'disable' },
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
      claudeMdExcludes: [
        '/srv/share/CLAUDE.md',
        '/srv/share/CLAUDE.local.md',
        '/srv/share/.claude/CLAUDE.md',
        '/srv/share/.claude/rules/**',
        '/srv/CLAUDE.md',
        '/srv/CLAUDE.local.md',
        '/srv/.claude/CLAUDE.md',
        '/srv/.claude/rules/**',
        '/CLAUDE.md',
        '/CLAUDE.local.md',
        '/.claude/CLAUDE.md',
        '/.claude/rules/**',
      ],
      disabledMcpjsonServers: ['planted', 'db'],
    });
    expect(JSON.stringify(settings)).not.toMatch(/"allow"\s*:\s*"|bypassPermissions|dangerously/);
  });

  it("host variant: the same, plus permissions.defaultMode 'default' (2.1.283 would start in auto mode without edit prompts), no guest-only keys", () => {
    const settings = buildSessionSettings({ variant: 'host', command: SELF, rootRealPath: '/Users/host/proj' });
    expect(settings['permissions']).toEqual({ allow: ['mcp__smurg'], disableBypassPermissionsMode: 'disable', defaultMode: 'default' });
    expect(settings).not.toHaveProperty('claudeMdExcludes');
    expect(settings).not.toHaveProperty('disabledMcpjsonServers');
    expect(settings).not.toHaveProperty(['hooks', 'FileChanged']);
    expect(settings['disableAllHooks']).toBe(false);
    expect(settings['env']).toEqual({ CLAUDE_CODE_SAFE_MODE: '0', CLAUDE_CODE_SIMPLE: '0' });
  });

  it('D-13: with bashActivity the Bash ACTIVITY hook is its own matcher group (`hook bash-activity`, 5 s); the edit groups stay exactly the lock hook', () => {
    const on = buildSessionSettings({ variant: 'guest', command: SELF, rootRealPath: '/srv/share/proj', bashActivity: true });
    const off = buildSessionSettings({ variant: 'guest', command: SELF, rootRealPath: '/srv/share/proj', bashActivity: false });
    const BASH = { type: 'command', command: '/opt/smurg/bin/node', args: ['/opt/smurg/cli/src/main.ts', 'hook', 'bash-activity'], timeout: 5 };
    const hooks = on['hooks'] as Record<string, unknown>;
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      expect(hooks[event], event).toEqual([{ matcher: EDITS, hooks: [HOOK] }, { matcher: 'Bash', hooks: [BASH] }]);
      expect((off['hooks'] as Record<string, unknown>)[event], event).toEqual([{ matcher: EDITS, hooks: [HOOK] }]);
    }
    // Only the three tool events carry it; no other event runs the Bash hook, and the lock hook never gets Bash.
    expect(hooks['PermissionRequest']).toEqual([{ matcher: EDITS, hooks: [HOOK] }]);
    expect(JSON.stringify({ ...hooks, PreToolUse: null, PostToolUse: null, PostToolUseFailure: null })).not.toContain('bash-activity');
    expect(buildSessionSettings({ variant: 'guest', command: SELF, rootRealPath: '/srv/share/proj' })).toEqual(off);
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
    const settings = buildSessionSettings({ variant: 'guest', command: production, rootRealPath: '/a/b' });
    expect((settings['hooks'] as Record<string, { hooks: unknown[] }[]>)['PreToolUse']?.[0]?.hooks).toEqual([{ type: 'command', command: '/usr/local/bin/smurg', args: ['hook'], timeout: 10 }]);
    expect(buildMcpConfig(production)).toEqual({ mcpServers: { smurg: { type: 'stdio', command: '/usr/local/bin/smurg', args: ['mcp'], env: {} } } });
    expect(buildMcpConfig(SELF)).toEqual({ mcpServers: { smurg: { type: 'stdio', command: SELF.file, args: [...SELF.args, 'mcp'], env: {} } } });
  });

  it('claude flags: --settings and --mcp-config for everyone, --strict-mcp-config for guests only, never a permission-mode or skip-permissions flag', () => {
    const files = { settingsPath: '/s/settings.json', mcpConfigPath: '/s/mcp.json' };
    expect(claudeArgsFor('guest', files)).toEqual(['--settings', '/s/settings.json', '--mcp-config', '/s/mcp.json', '--strict-mcp-config']);
    expect(claudeArgsFor('host', files)).toEqual(['--settings', '/s/settings.json', '--mcp-config', '/s/mcp.json']);
  });

  it('claudeMdExcludes covers every ancestor of the session root, including the main share of a worktree session', () => {
    const excludes = claudeMdExcludesFor('/Users/host/proj/.smurg/worktrees/wt_1');
    for (const dir of ['/Users/host/proj/.smurg/worktrees', '/Users/host/proj/.smurg', '/Users/host/proj', '/Users/host', '/Users', '/']) {
      expect(excludes).toContain(join(dir, 'CLAUDE.md'));
      expect(excludes).toContain(join(dir, '.claude', 'CLAUDE.md'));
    }
    expect(excludes).not.toContain('/Users/host/proj/.smurg/worktrees/wt_1/CLAUDE.md');
  });

  it('FileChanged watches only plain file names (the matcher is also read as a regex); .mcp.json names are read exactly', () => {
    expect(fileChangedMatcher(['a.txt', 'b|c', '(x)', 'README.md', 'a.txt', ''])).toBe('README.md|a.txt');
    expect(fileChangedMatcher([])).toBeNull();
    expect(projectMcpServerNames('{"mcpServers":{"one":{},"two words":{}}}')).toEqual(['one', 'two words']);
    expect(projectMcpServerNames('not json')).toEqual([]);
    expect(projectMcpServerNames('{"mcpServers":[1]}')).toEqual([]);
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

  it('writes settings.json and mcp.json 0600 into a private 0700 dir under <stateDir>/sessions, atomically; guests get the project .mcp.json server names (read through PathGuard)', async () => {
    d = await startHookDaemon({ daemon: { project: { files: { '.mcp.json': JSON.stringify({ mcpServers: { planted: { command: 'x' } } }), 'README.md': '#' } } } });
    const hooks = withSelfCommand(d.t.ctx);
    const s = registerAgent(hooks, { userId: 'dev:ian', name: 'Ian' }, { sandboxed: true });
    const files = await hooks.writeSessionFiles(s.sessionId);
    expect(files.dir).toBe(sessionFilesDir(d.t.stateDir, d.t.workspaceId, s.sessionId));
    expect(files.dir.startsWith(join(d.t.stateDir, 'sessions') + '/')).toBe(true);
    expect(files.claudeArgs).toEqual(['--settings', files.settingsPath, '--mcp-config', files.mcpConfigPath, '--strict-mcp-config']);
    for (const dir of [join(d.t.stateDir, 'sessions'), dirname(files.dir), files.dir]) expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    for (const file of [files.settingsPath, files.mcpConfigPath]) expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(files.dir)).sort()).toEqual(['mcp.json', 'settings.json']);
    const settings = JSON.parse(await readFile(files.settingsPath, 'utf8')) as Record<string, unknown>;
    expect(settings['disabledMcpjsonServers']).toEqual(['planted']);
    expect(settings['claudeMdExcludes']).toContain(join(dirname(d.t.root), 'CLAUDE.md'));
    expect(settings['hooks']).toHaveProperty('FileChanged');
    expect(JSON.parse(await readFile(files.mcpConfigPath, 'utf8'))).toEqual(buildMcpConfig(SELF));
    // ARCHITECTURE §11 D-1: nothing goes into the project's .claude/ (collaborators can write there).
    await expect(lstat(join(d.t.root, '.claude'))).rejects.toThrow();
  });

  it('a host session gets the host variant (unsandboxed registration)', async () => {
    d = await startHookDaemon();
    const hooks = withSelfCommand(d.t.ctx);
    const s = registerAgent(hooks, { userId: TEST_HOST_USER, name: 'Host' }, { sandboxed: false });
    const files = await hooks.writeSessionFiles(s.sessionId);
    const settings = JSON.parse(await readFile(files.settingsPath, 'utf8')) as { permissions: Record<string, unknown> };
    expect(settings.permissions['defaultMode']).toBe('default');
    expect(files.claudeArgs).not.toContain('--strict-mcp-config');
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

describe("guest's pre-seeded .claude.json", () => {
  let dir: string;
  afterEach(async () => {
    await removeTempDir(dir);
  });

  it('trusts the realpath of the cwd, approves the last 20 characters of the guest API key, keeps what the guest had, 0600', async () => {
    dir = await createTempDir('seed');
    const cfg = join(dir, 'cfg');
    const project = join(dir, 'project');
    await mkdir(cfg);
    await mkdir(project);
    await symlink(project, join(dir, 'project-link'));
    await writeFile(join(cfg, '.claude.json'), JSON.stringify({ theme: 'dark', projects: { '/elsewhere': { hasTrustDialogAccepted: false } }, customApiKeyResponses: { approved: ['old'], rejected: ['01234567890123456789'] } }));
    const apiKey = 'sk-ant-api03-guest-key-AAAA-01234567890123456789';
    const path = await seedGuestClaudeConfig({ cfgDir: cfg, cwd: join(dir, 'project-link'), apiKey });
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(written).toEqual({
      theme: 'dark',
      projects: { '/elsewhere': { hasTrustDialogAccepted: false }, [await realpath(project)]: { hasTrustDialogAccepted: true } },
      customApiKeyResponses: { approved: ['old', '01234567890123456789'], rejected: [] },
    });
    expect(JSON.stringify(written)).not.toContain('sk-ant-api03');
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(cfg)).sort()).toEqual(['.claude.json']);
    // Without a key: trust only, onboarding untouched (a guest who is not logged in sees Claude's login screens).
    expect(mergeGuestClaudeJson(null, '/p')).toEqual({ projects: { '/p': { hasTrustDialogAccepted: true } } });
  });

  it("refuses a config dir reached through a symlink (the guest could point it at the host's home), and replaces a .claude.json symlink instead of following it", async () => {
    dir = await createTempDir('seed');
    const hostHome = join(dir, 'host-home');
    const guest = join(dir, 'guest');
    await mkdir(hostHome);
    await mkdir(guest);
    await writeFile(join(hostHome, '.claude.json'), '{"host":"config"}');
    await symlink(hostHome, join(guest, 'cfg'));
    await expect(seedGuestClaudeConfig({ cfgDir: join(guest, 'cfg'), cwd: dir })).rejects.toThrow(/symlink/);
    expect(await readFile(join(hostHome, '.claude.json'), 'utf8')).toBe('{"host":"config"}');
    const cfg = join(dir, 'cfg2');
    await mkdir(cfg);
    await symlink(join(hostHome, '.claude.json'), join(cfg, '.claude.json'));
    await seedGuestClaudeConfig({ cfgDir: cfg, cwd: dir });
    expect((await lstat(join(cfg, '.claude.json'))).isFile()).toBe(true);
    expect(await readFile(join(hostHome, '.claude.json'), 'utf8')).toBe('{"host":"config"}');
    expect(JSON.parse(await readFile(join(cfg, '.claude.json'), 'utf8'))).toEqual({ projects: { [await realpath(dir)]: { hasTrustDialogAccepted: true } } });
  });
});
