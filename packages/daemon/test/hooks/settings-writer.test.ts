// The files an agent process is launched with (ARCHITECTURE §7.6 "Launch", §11 D-1; DESIGN §2.1): settings.json
// (--settings: the tool gate for every tool, the hardened settings, the profile's rules), mcp.json (--mcp-config) and
// role.md, and the profile flags the sessions module checks before the spawn.
import { buildLaunchProfile } from '../../src/core/fakes/build.ts';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonContext } from '../../src/core/context.ts';
import { HookServerImpl } from '../../src/hooks/hook-server.ts';
import { buildMcpConfig, buildSessionSettings, claudeArgsFor, fileChangedMatcher, removeSessionFiles, sessionFilesDir, sessionFilesRoot, writeSessionFiles } from '../../src/hooks/settings-writer.ts';
import { checkLaunchArgs } from '../../src/sessions/agent/profiles.ts';
import { TEST_HOST_USER } from '../../src/testing/index.ts';
import { registerAgent, startHookDaemon, type HookDaemon } from './helpers.ts';

const SELF = { file: '/opt/smurg/bin/node', args: ['/opt/smurg/cli/src/main.ts'] };
const HOOK = { type: 'command', command: '/opt/smurg/bin/node', args: ['/opt/smurg/cli/src/main.ts', 'hook'], timeout: 10 };
const EDITS = 'Edit|Write|MultiEdit|NotebookEdit';
const GATE = [{ matcher: '*', hooks: [HOOK] }];

describe('session settings (ARCHITECTURE §7.6)', () => {
  it('the tool gate runs before EVERY tool (matcher `*`); hooks off-switches neutralized, deep links and cross-session messages off, ListAgents denied, mcp__smurg allowed, bypass mode disabled, the mode always given', () => {
    const settings = buildSessionSettings({ command: SELF, fileChangedNames: ['README.md', 'package.json'] });
    expect(settings).toEqual({
      disableAllHooks: false,
      env: { CLAUDE_CODE_SAFE_MODE: '0', CLAUDE_CODE_SIMPLE: '0' },
      disableDeepLinkRegistration: 'disable',
      crossSessionInbound: 'refuse',
      permissions: { allow: ['mcp__smurg'], ask: [], deny: ['ListAgents'], disableBypassPermissionsMode: 'disable', defaultMode: 'default' },
      hooks: {
        PreToolUse: GATE,
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

  it("the profile's rules are written one string per element (never parsed as a list), with Claude Code's mode of the profile", () => {
    const deny = ['Read(//p/.envrc)', 'Edit(//p/**/.claude/**)'];
    const settings = buildSessionSettings({ command: SELF, profile: { mode: 'acceptEdits', allow: ['Bash(pnpm test *)', 'WebFetch(domain:example.com)'], ask: [], deny } });
    expect(settings['permissions']).toEqual({ allow: ['mcp__smurg', 'Bash(pnpm test *)', 'WebFetch(domain:example.com)'], ask: [], deny: ['ListAgents', ...deny], disableBypassPermissionsMode: 'disable', defaultMode: 'acceptEdits' });
    // A rule with a comma or a space stays one rule.
    expect((buildSessionSettings({ command: SELF, profile: { mode: 'default', allow: ['Bash(a, b *)'], ask: [], deny: [] } })['permissions'] as { allow: string[] }).allow).toEqual(['mcp__smurg', 'Bash(a, b *)']);
  });

  it('without watchable file names: no FileChanged hook; none of the former guest-only keys', () => {
    const settings = buildSessionSettings({ command: SELF });
    expect(settings).not.toHaveProperty('claudeMdExcludes');
    expect(settings).not.toHaveProperty('disabledMcpjsonServers');
    expect(settings).not.toHaveProperty(['hooks', 'FileChanged']);
    expect(settings['disableAllHooks']).toBe(false);
    expect(settings['env']).toEqual({ CLAUDE_CODE_SAFE_MODE: '0', CLAUDE_CODE_SIMPLE: '0' });
  });

  it('D-13: with bashActivity the Bash ACTIVITY hook is its own matcher group (`hook bash-activity`, 5 s) beside the gate; it fails open and never decides', () => {
    const on = buildSessionSettings({ command: SELF, bashActivity: true });
    const off = buildSessionSettings({ command: SELF, bashActivity: false });
    const BASH = { type: 'command', command: '/opt/smurg/bin/node', args: ['/opt/smurg/cli/src/main.ts', 'hook', 'bash-activity'], timeout: 5 };
    const hooks = on['hooks'] as Record<string, unknown>;
    expect(hooks['PreToolUse']).toEqual([...GATE, { matcher: 'Bash', hooks: [BASH] }]);
    expect((off['hooks'] as Record<string, unknown>)['PreToolUse']).toEqual(GATE);
    for (const event of ['PostToolUse', 'PostToolUseFailure']) {
      expect(hooks[event], event).toEqual([{ matcher: EDITS, hooks: [HOOK] }, { matcher: 'Bash', hooks: [BASH] }]);
      expect((off['hooks'] as Record<string, unknown>)[event], event).toEqual([{ matcher: EDITS, hooks: [HOOK] }]);
    }
    // Only the three tool events carry it; no other event runs the Bash hook.
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
        const files = await server.writeSessionFiles(s.sessionId, buildLaunchProfile());
        const settings = JSON.parse(await readFile(files.settingsPath, 'utf8')) as { hooks: Record<string, { matcher?: string }[]> };
        expect(settings.hooks['PreToolUse']?.map((group) => group.matcher), String(attributeBashEdits)).toEqual(attributeBashEdits ? ['*', 'Bash'] : ['*']);
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

  it('the profile flags: the mode, the two files, the tool list, the role prompt; --strict-mcp-config and --setting-sources user only when the profile says so; never a bypass flag or a rule list', () => {
    const files = { settingsPath: '/s/settings.json', mcpConfigPath: '/s/mcp.json', rolePromptPath: '/s/role.md' };
    expect(claudeArgsFor(files, buildLaunchProfile({ mode: 'acceptEdits', tools: ['Read', 'Bash'], strictMcp: false }))).toEqual(['--permission-mode', 'acceptEdits', '--settings', '/s/settings.json', '--mcp-config', '/s/mcp.json', '--tools', 'Read,Bash', '--append-system-prompt-file', '/s/role.md']);
    const strict = claudeArgsFor(files, buildLaunchProfile({ strictMcp: true, settingSources: 'user' }));
    expect(strict.slice(-3)).toEqual(['--strict-mcp-config', '--setting-sources', 'user']);
    expect(strict.join(' ')).not.toMatch(/dangerously|bypass|--allowedTools|--disallowedTools|--model/);
    // Every set of flags the writer makes passes the launch check of the sessions module (fail closed).
    for (const profile of [buildLaunchProfile(), buildLaunchProfile({ mode: 'acceptEdits', strictMcp: false, settingSources: 'user' })]) expect(checkLaunchArgs(claudeArgsFor(files, profile))).toBeNull();
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
    const files = await hooks.writeSessionFiles(s.sessionId, buildLaunchProfile());
    expect(files.dir).toBe(sessionFilesDir(d.t.stateDir, d.t.workspaceId, s.sessionId));
    expect(files.dir.startsWith(join(d.t.stateDir, 'sessions') + '/')).toBe(true);
    expect(files.claudeArgs).toEqual(['--permission-mode', 'default', '--settings', files.settingsPath, '--mcp-config', files.mcpConfigPath, '--tools', buildLaunchProfile().tools.join(','), '--append-system-prompt-file', files.rolePromptPath, '--strict-mcp-config']);
    for (const dir of [join(d.t.stateDir, 'sessions'), dirname(files.dir), files.dir]) expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    // The launch profile carries the session's role prompt: it is written beside the two files, as private as they are.
    expect(files.rolePromptPath).toBe(join(files.dir, 'role.md'));
    for (const file of [files.settingsPath, files.mcpConfigPath, files.rolePromptPath]) expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(files.dir)).sort()).toEqual(['mcp.json', 'role.md', 'settings.json']);
    const settings = JSON.parse(await readFile(files.settingsPath, 'utf8')) as Record<string, unknown>;
    // The project's .mcp.json servers are not switched off any more: the session runs like the host's own.
    expect(settings).not.toHaveProperty('disabledMcpjsonServers');
    expect(settings).not.toHaveProperty('claudeMdExcludes');
    expect(settings['hooks']).toHaveProperty('FileChanged');
    expect(JSON.parse(await readFile(files.mcpConfigPath, 'utf8'))).toEqual(buildMcpConfig(SELF));
    // ARCHITECTURE §11 D-1: nothing goes into the project's .claude/ (collaborators can write there).
    await expect(lstat(join(d.t.root, '.claude'))).rejects.toThrow();
  });

  it("the same profile gives a member's session exactly the host's files (what differs between sessions is the profile and the registration, not who opened them)", async () => {
    d = await startHookDaemon();
    const hooks = withSelfCommand(d.t.ctx);
    const host = registerAgent(hooks, { userId: TEST_HOST_USER, name: 'Host' });
    const ian = registerAgent(hooks, { userId: 'dev:ian', name: 'Ian' });
    const hostFiles = await hooks.writeSessionFiles(host.sessionId, buildLaunchProfile());
    const ianFiles = await hooks.writeSessionFiles(ian.sessionId, buildLaunchProfile());
    const hostSettings = JSON.parse(await readFile(hostFiles.settingsPath, 'utf8')) as { permissions: Record<string, unknown> };
    expect(hostSettings.permissions['defaultMode']).toBe('default');
    expect(JSON.parse(await readFile(ianFiles.settingsPath, 'utf8'))).toEqual(hostSettings);
    expect(JSON.parse(await readFile(ianFiles.mcpConfigPath, 'utf8'))).toEqual(JSON.parse(await readFile(hostFiles.mcpConfigPath, 'utf8')));
    for (const files of [hostFiles, ianFiles]) expect(checkLaunchArgs(files.claudeArgs)).toBeNull();
    // A tool list that is not a list of plain names would change `--tools`: refused.
    await expect(hooks.writeSessionFiles(ian.sessionId, buildLaunchProfile({ tools: ['Read,Bash --dangerously-skip-permissions'] }))).rejects.toThrow();
  });

  it('refuses to write session files without config.sessions.selfCommand, or for a session that is not registered (fail closed)', async () => {
    d = await startHookDaemon();
    const s = registerAgent(d.hooks, { userId: TEST_HOST_USER, name: 'Host' });
    await expect(d.hooks.writeSessionFiles(s.sessionId, buildLaunchProfile())).rejects.toMatchObject({ code: 'internal', detail: { reason: 'no-self-command' } });
    await expect(withSelfCommand(d.t.ctx).writeSessionFiles('ses_unknown', buildLaunchProfile())).rejects.toMatchObject({ detail: { reason: 'hook-session-not-registered' } });
  });

  it("a session that starts again at once keeps its files: the removal for the process before it runs first, never over the next start's files", async () => {
    d = await startHookDaemon();
    const hooks = withSelfCommand(d.t.ctx);
    const sessionId = 'ses_restarts';
    // A retry, a resume, a message that arrives while the process goes away: unregister (the removal is not awaited),
    // then register and write, with no pause between them.
    for (let round = 0; round < 25; round++) {
      registerAgent(hooks, { userId: TEST_HOST_USER, name: 'Host' }, { sessionId });
      const files = await hooks.writeSessionFiles(sessionId, buildLaunchProfile({ rolePrompt: `round ${round}` }));
      expect((await readdir(files.dir)).sort(), `round ${round}`).toEqual(['mcp.json', 'role.md', 'settings.json']);
      expect(await readFile(files.rolePromptPath, 'utf8')).toBe(`round ${round}`);
      hooks.unregisterSession(sessionId);
    }
    registerAgent(hooks, { userId: TEST_HOST_USER, name: 'Host' }, { sessionId });
    const last = await hooks.writeSessionFiles(sessionId, buildLaunchProfile({ rolePrompt: 'the last start' }));
    // Whatever removal was still under way is over now: the files of the last start are all there and stay.
    await hooks.removeSessionFiles('ses_another');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await readdir(last.dir)).sort()).toEqual(['mcp.json', 'role.md', 'settings.json']);
    expect(await readFile(last.rolePromptPath, 'utf8')).toBe('the last start');
    expect(JSON.parse(await readFile(last.settingsPath, 'utf8'))).toHaveProperty('hooks.PreToolUse');
    // The writer itself keeps the order it was asked in, whichever way round: a removal asked for while a write runs
    // waits for it and then removes everything; a write asked for while a removal runs finds an empty place.
    const input = { stateDir: d.t.stateDir, workspaceId: d.t.workspaceId, sessionId, settings: { command: SELF, profile: buildLaunchProfile() }, rolePrompt: 'x' };
    await Promise.all([writeSessionFiles(input), removeSessionFiles(d.t.stateDir, d.t.workspaceId, sessionId)]);
    await expect(lstat(last.dir)).rejects.toThrow();
    await Promise.all([removeSessionFiles(d.t.stateDir, d.t.workspaceId, sessionId), writeSessionFiles(input), removeSessionFiles(d.t.stateDir, d.t.workspaceId, sessionId), writeSessionFiles(input)]);
    expect((await readdir(last.dir)).sort()).toEqual(['mcp.json', 'role.md', 'settings.json']);
    // A start that was unregistered while its files were being prepared writes nothing.
    const late = hooks.writeSessionFiles(sessionId, buildLaunchProfile());
    hooks.unregisterSession(sessionId);
    await expect(late).rejects.toMatchObject({ detail: { reason: 'hook-session-not-registered' } });
    await expect.poll(() => lstat(last.dir).then(() => 'exists', () => 'gone')).toBe('gone');
  });

  it("unregistering a session removes its files; a daemon start removes this workspace's stale session dirs", async () => {
    d = await startHookDaemon();
    const hooks = withSelfCommand(d.t.ctx);
    const s = registerAgent(hooks, { userId: TEST_HOST_USER, name: 'Host' });
    const files = await hooks.writeSessionFiles(s.sessionId, buildLaunchProfile());
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
