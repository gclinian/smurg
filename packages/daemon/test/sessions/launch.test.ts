// Who may do what with sessions (ARCHITECTURE §3, §5.5), how agent sessions are launched (§7.6), the sandbox and
// Claude Code version refusals, login detection, session.importConfig path safety, guest-dir retention and stop().
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultGuestMainWorkspace } from '../../src/core/config.ts';
import { MAIN_WORKSPACE_OFF_MESSAGES } from '../../src/sessions/session-manager.ts';
import { TEST_HOST_USER } from '../../src/testing/index.ts';
import { TestViewer, sleep, typeInto, waitFor } from './helpers.ts';
import { startSessionStack, type SessionStack } from './setup.ts';

const stacks: SessionStack[] = [];
const viewers: TestViewer[] = [];

afterEach(async () => {
  for (const viewer of viewers.splice(0)) viewer.dispose();
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function stack(options: Parameters<typeof startSessionStack>[0] = {}): Promise<SessionStack> {
  const s = await startSessionStack(options);
  stacks.push(s);
  return s;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function argvOf(logDir: string): Promise<string[][]> {
  const names = (await readdir(logDir)).filter((name) => name.startsWith('argv.'));
  return Promise.all(names.map(async (name) => (await readFile(join(logDir, name), 'utf8')).split('\n').filter(Boolean)));
}

async function envNamesOf(logDir: string): Promise<string[][]> {
  const names = (await readdir(logDir)).filter((name) => name.startsWith('envnames.'));
  return Promise.all(names.map(async (name) => (await readFile(join(logDir, name), 'utf8')).split('\n').filter(Boolean)));
}

const terminal = { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 } as const;
const agent = { kind: 'agent', workspace: { mode: 'main' }, cols: 80, rows: 24 } as const;

describe('who may create and drive sessions', { timeout: 60_000 }, () => {
  it('a viewer cannot create sessions; an editor cannot either (refused and audited)', async () => {
    const s = await stack();
    const viewer = await s.t.connect({ userId: 'dev:vic', role: 'viewer' });
    const editor = await s.t.connect({ userId: 'dev:amy', role: 'editor' });
    await expect(viewer.conn.request('session.create', terminal)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(editor.conn.request('session.create', agent)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(editor.conn.request('session.importConfig', { files: [{ relPath: 'CLAUDE.md', content: new Uint8Array([1]) }] })).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.sessions.list()).toEqual([]);
    expect(s.fakes.sandbox.wraps).toEqual([]);
    const denied = (await s.t.ctx.audit.query({ limit: 50 })).filter((e) => e.action === 'authz.denied' && e.target === 'session.create');
    expect(denied.map((e) => (e.actor.kind === 'user' ? e.actor.userId : '')).sort()).toEqual(['dev:amy', 'dev:vic']);
  });

  it('input from anyone but the owner is refused and audited, and never reaches the PTY', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const amy = await s.t.connect({ userId: 'dev:amy', role: 'editor' });
    const { session } = await host.conn.request('session.create', terminal);
    const hostView = new TestViewer(host.conn, session.id);
    const amyView = new TestViewer(amy.conn, session.id);
    viewers.push(hostView, amyView);
    await hostView.attach({ cols: 80, rows: 24 });
    await amyView.attach({ cols: 200, rows: 60 }); // not the owner: her viewport does not resize the PTY
    expect(s.sessions.get(session.id)).toMatchObject({ cols: 80, rows: 24 });
    const errors: string[] = [];
    amy.conn.on('error', (payload) => errors.push(payload.code));
    typeInto(amy.conn, session.id, 'echo INJECTED-BY-AMY\r');
    amy.conn.notify('exec.resize', { sessionId: session.id, cols: 30, rows: 10 });
    await waitFor(() => errors.length === 2, 'both refusals');
    expect(errors).toEqual(['forbidden', 'forbidden']);
    typeInto(host.conn, session.id, 'echo OWNER-$((1+1))\r');
    await waitFor(() => hostView.received.includes('OWNER-2'), 'the owner\'s own input');
    expect(hostView.received).not.toContain('INJECTED-BY-AMY');
    expect(amyView.received).not.toContain('INJECTED-BY-AMY');
    expect(s.sessions.get(session.id)).toMatchObject({ cols: 80, rows: 24 });
    const denied = (await s.t.ctx.audit.query({ limit: 50 })).filter((e) => e.action === 'authz.denied' && e.actor.kind === 'user' && e.actor.userId === 'dev:amy');
    expect(denied.map((e) => e.target).sort()).toEqual(['exec.input', 'exec.resize']);
    // Nor may she end, or read the login state of, someone else's session.
    await expect(amy.conn.request('session.end', { sessionId: session.id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(amy.conn.request('session.loginStatus', { sessionId: session.id })).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.sessions.get(session.id)?.status).toBe('running');
  });

  it('the host session is not sandboxed and a guest (runner) session is; the client cannot choose', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const runner = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    const hostSession = (await host.conn.request('session.create', terminal)).session;
    expect(hostSession).toMatchObject({ sandboxed: false, ownerUserId: TEST_HOST_USER, status: 'running', root: { kind: 'main' } });
    expect(s.fakes.sandbox.wraps).toHaveLength(0);
    const guestSession = (await runner.conn.request('session.create', terminal)).session;
    expect(guestSession).toMatchObject({ sandboxed: true, ownerUserId: 'dev:carol' });
    expect(s.fakes.sandbox.wraps).toHaveLength(1);
    const spec = s.fakes.sandbox.wraps[0];
    const guest = s.sessions.guestPaths('dev:carol');
    expect(spec).toMatchObject({ sessionId: guestSession.id, rootPath: s.t.ctx.roots.main.realPath, guestDir: guest.root });
    expect(spec?.env).toMatchObject({ HOME: guest.home, CLAUDE_CONFIG_DIR: guest.cfg, TMPDIR: guest.tmp, SMURG_SESSION_ID: guestSession.id });
    expect(spec?.command).toContain(`export TMPDIR='${guest.tmp}'`);
    expect(spec?.denyReadPaths).toContain(join(s.t.ctx.roots.main.realPath, '.smurg'));
    // A host's API key is refused: keys are for sandboxed sessions only.
    await expect(host.conn.request('session.create', { ...terminal, apiKey: 'sk-ant-api03-x' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('a failed sandbox preflight refuses the guest session: sandbox_unavailable, audited as sandbox.refused, nothing spawned', async () => {
    const s = await stack();
    s.fakes.sandbox.preflightResult = { ok: false, reason: 'missing-dependency', detail: 'sandbox-exec' };
    const runner = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    const err = await runner.conn.request('session.create', agent).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'sandbox_unavailable', detail: { reason: 'missing-dependency' } });
    expect(s.sessions.list()).toEqual([]);
    expect(s.fakes.sandbox.wraps).toEqual([]);
    expect(s.fakes.hooks.registered.size).toBe(0);
    expect(await exists(s.sessions.guestPaths('dev:carol').root)).toBe(false);
    expect(await argvOf(s.fakeClaude.logDir)).toEqual([]);
    const refused = (await s.t.ctx.audit.query({ limit: 50 })).filter((e) => e.action === 'sandbox.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ outcome: 'denied', detail: { reason: 'missing-dependency' } });
  });

  // Linux: srt removes bubblewrap's mount points in the host's share only once every wrap is released.
  it('a guest\'s wrapped command is released once its process exits, and when the session is refused after the wrap', async () => {
    const s = await stack();
    const runner = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    const { session } = await runner.conn.request('session.create', terminal);
    expect(s.fakes.sandbox.wraps).toHaveLength(1);
    expect(s.fakes.sandbox.released).toEqual([]);
    await runner.conn.request('session.end', { sessionId: session.id });
    await waitFor(() => s.fakes.sandbox.released.length === 1, 'the wrap to be released');

    // What wrap() handed out carries a credential: refused, nothing spawned, and the wrap is released all the same.
    s.fakes.sandbox.wrapExtraEnv = { ANTHROPIC_AUTH_TOKEN: 'not-a-real-token' };
    const err = await runner.conn.request('session.create', agent).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'sandbox_unavailable', detail: { reason: 'wrap-env' } });
    expect(s.fakes.sandbox.wraps).toHaveLength(2);
    expect(s.fakes.sandbox.released).toHaveLength(2);
    expect(s.sessions.list().filter((m) => m.status !== 'exited')).toEqual([]);
  });

  // Linux (reviews RV-1, RV-2): bubblewrap's mounts cannot follow the host's change of a protected entry (an atomic save
  // of .envrc, `git switch`); the sandbox revokes what runs in that root and the session ends, fail closed.
  it('a guest session whose sandbox is revoked ends (terminated, audited by the system, its owner told); the host\'s session and another root\'s go on; one revoked before it could be watched is refused', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const runner = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    const hostSession = (await host.conn.request('session.create', terminal)).session;
    const guestSession = (await runner.conn.request('session.create', terminal)).session;
    const share = s.t.ctx.roots.main.realPath;
    expect(s.fakes.sandbox.watched).toHaveLength(1);
    expect(s.fakes.sandbox.revoke(join(share, 'elsewhere'), { root: join(share, 'elsewhere'), paths: [] })).toBe(0);
    expect(s.fakes.sandbox.revoke(share, { root: share, paths: [join(share, '.envrc'), join(share, 'sub', 'CLAUDE.local.md')] })).toBe(1);
    await waitFor(() => s.sessions.get(guestSession.id)?.status === 'exited', 'the guest session to end');
    expect(s.sessions.get(guestSession.id)).toMatchObject({ status: 'exited', endReason: 'terminated' });
    expect(s.sessions.get(guestSession.id)?.endedBy).toBeUndefined();
    expect(s.sessions.get(hostSession.id)?.status).toBe('running');
    await waitFor(() => s.fakes.sandbox.released.length === 1, 'the wrap to be released');
    expect(s.fakes.sandbox.listening()).toBe(0);
    const terminated = (await s.t.ctx.audit.query({ limit: 50 })).filter((e) => e.action === 'session.terminate');
    expect(terminated).toHaveLength(1);
    expect(terminated[0]).toMatchObject({ actor: { kind: 'system' }, target: guestSession.id, detail: { reason: 'sandbox-protected-changed', paths: ['.envrc', 'sub/CLAUDE.local.md'], ownerUserId: 'dev:carol' } });
    expect(s.fakes.activity.notifications).toHaveLength(1);
    expect(s.fakes.activity.notifications[0]?.userId).toBe('dev:carol');
    expect(s.fakes.activity.notifications[0]?.text).toContain('.envrc、sub/CLAUDE.local.md');
    expect(s.fakes.activity.notifications[0]?.text).toContain('已被結束');
    // Review GR-13: the daemon cannot tell who made the change (a guest's new name ends the session too): no blame.
    expect(s.fakes.activity.notifications[0]?.text).toContain('這個資料夾裡只有主人能使用的檔案有變動');
    expect(s.fakes.activity.notifications[0]?.text).not.toContain('主人在這個資料夾裡變更了');

    // Revoked between the wrap and the start (a change while it was being prepared): not started, refused.
    s.fakes.sandbox.revokeOnWrap = { root: share, paths: [join(share, '.mcp.json')] };
    const err = await runner.conn.request('session.create', terminal).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'sandbox_unavailable', detail: { reason: 'protected-changed' } });
    expect(s.sessions.list().filter((m) => m.ownerUserId === 'dev:carol' && m.status !== 'exited')).toEqual([]);
    await waitFor(() => s.fakes.sandbox.released.length === 2, 'the refused wrap to be released');
    const refused = (await s.t.ctx.audit.query({ limit: 50 })).filter((e) => e.action === 'sandbox.refused');
    expect(refused.at(-1)).toMatchObject({ detail: { reason: 'protected-changed' } });
  });
});

describe('agent sessions (ARCHITECTURE §7.6)', { timeout: 60_000 }, () => {
  it('the host\'s agent: claude --settings --mcp-config (no strict mode, no permission flags), hooks registered, host settings', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const { session } = await host.conn.request('session.create', agent);
    expect(session).toMatchObject({ kind: 'agent', sandboxed: false, title: 'Claude（Host）' });
    await waitFor(async () => (await argvOf(s.fakeClaude.logDir)).length === 1, 'claude to start');
    const [argv] = await argvOf(s.fakeClaude.logDir);
    expect(argv?.slice(0, 4)).toEqual(['--settings', expect.stringMatching(/sessions\/[0-9a-f]{24}\/[0-9a-f]+\/settings\.json$/), '--mcp-config', expect.stringMatching(/mcp\.json$/)]);
    expect(argv).toHaveLength(4);
    expect(argv?.join(' ')).not.toMatch(/dangerously|permission-mode|strict-mcp-config/);
    const settings = JSON.parse(await readFile(argv?.[1] as string, 'utf8'));
    expect(settings.permissions.defaultMode).toBe('default');
    expect(settings.hooks.PreToolUse[0].hooks[0]).toEqual({ type: 'command', command: '/usr/bin/true', args: ['hook'], timeout: 10 });
    expect((await stat(argv?.[1] as string)).mode & 0o777).toBe(0o600);
    expect(s.fakes.hooks.registered.get(session.id)).toMatchObject({ ownerUserId: TEST_HOST_USER, agentName: 'Claude（Host）', sandboxed: false, root: { kind: 'main' } });
    const [envNames] = await envNamesOf(s.fakeClaude.logDir);
    expect(envNames).toEqual(expect.arrayContaining(['SMURG_SESSION_TOKEN', 'SMURG_HOOK_SOCKET', 'SMURG_SESSION_ID']));
    expect(s.fakes.presence.agents.has(session.id)).toBe(true);
    expect(s.sessions.agentActor(session.id)).toEqual({ kind: 'agent', sessionId: session.id, ownerUserId: TEST_HOST_USER, displayName: 'Claude（Host）' });

    await host.conn.request('session.end', { sessionId: session.id });
    expect(s.fakes.hooks.unregistered).toEqual([session.id]);
    expect(s.fakes.locks.released).toEqual([{ sessionId: session.id, reason: 'session-ended' }]);
    expect(s.fakes.presence.removed).toEqual([session.id]);
    expect(await exists(argv?.[1] as string)).toBe(false); // the daemon-owned settings dir went with the session
  });

  it('a guest\'s agent: --strict-mcp-config, excludes, trust seed, the guest\'s own key only in that PTY, never persisted', async () => {
    const apiKey = 'sk-ant-api03-SMURG-GUEST-OWN-KEY-0123456789abcdef';
    const s = await stack({ project: { '.mcp.json': JSON.stringify({ mcpServers: { planted: { command: 'x' }, other: { command: 'y' } } }) } });
    const runner = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    const { session } = await runner.conn.request('session.create', { ...agent, apiKey });
    expect(session.sandboxed).toBe(true);
    // The session itself (later wraps are `claude auth status` helpers in the same sandbox).
    const spec = s.fakes.sandbox.wraps.find((w) => w.command.includes('--settings'));
    expect(spec?.command).toMatch(/--strict-mcp-config'$/);
    expect(spec?.env['ANTHROPIC_API_KEY']).toBe(apiKey);
    expect(spec?.extraReadPaths).toEqual(expect.arrayContaining([await realpath(s.fakeClaude.path)]));
    expect(spec?.hookSocketPath).toBe(s.t.ctx.config.runPaths.hook);
    await waitFor(async () => (await argvOf(s.fakeClaude.logDir)).length === 1, 'claude to start');
    const [argv] = await argvOf(s.fakeClaude.logDir);
    const settings = JSON.parse(await readFile(argv?.[1] as string, 'utf8'));
    expect(settings.permissions.defaultMode).toBeUndefined();
    expect(settings.disabledMcpjsonServers.sort()).toEqual(['other', 'planted']);
    expect(settings.claudeMdExcludes).toContain(join(dirname(s.t.ctx.roots.main.realPath), 'CLAUDE.md'));
    expect(settings.claudeMdExcludes).not.toContain(join(s.t.ctx.roots.main.realPath, 'CLAUDE.md'));
    const guest = s.sessions.guestPaths('dev:carol');
    const seeded = JSON.parse(await readFile(join(guest.cfg, '.claude.json'), 'utf8'));
    expect(seeded.projects[s.t.ctx.roots.main.realPath].hasTrustDialogAccepted).toBe(true);
    expect(seeded.customApiKeyResponses.approved).toEqual([apiKey.slice(-20)]);
    // loginStatus runs `claude auth status --json` in the session's environment (which holds the key).
    await expect(runner.conn.request('session.loginStatus', { sessionId: session.id })).resolves.toEqual({ login: 'logged-in' });
    await runner.conn.request('session.end', { sessionId: session.id });
    await s.t.ctx.audit.flush();
    await s.t.ctx.state.flush();
    // Never persisted, logged or audited: nothing under the daemon's state dir contains the key.
    const files = await listFiles(s.t.stateDir);
    for (const file of files) {
      if (file.includes(`${join('guests')}`) && file.endsWith('.claude.json')) continue; // the approval suffix only
      expect((await readFile(file)).includes(Buffer.from(apiKey)), file).toBe(false);
    }
    expect(files.some((file) => file.endsWith('audit.jsonl'))).toBe(true);
  });

  it('a guest without a key is logged out; the TUI never decides the login state', async () => {
    const s = await stack();
    const runner = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    const { session } = await runner.conn.request('session.create', agent);
    await expect(runner.conn.request('session.loginStatus', { sessionId: session.id })).resolves.toEqual({ login: 'logged-out' });
    await waitFor(() => s.sessions.get(session.id)?.login === 'logged-out', 'the login state in SessionInfo');
  });
});

describe('worktree sessions and accepted suggestions', { timeout: 60_000 }, () => {
  it('worktree mode: the session\'s root is the worktree, the main share is denied, and only session.end {keepWorktree: false} removes it', async () => {
    const s = await stack();
    const runner = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    const first = (await runner.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree' }, cols: 80, rows: 24 })).session;
    const worktreeId = s.fakes.worktrees.acquired[0]?.worktreeId as string;
    expect(first.root).toEqual({ kind: 'worktree', worktreeId });
    const spec = s.fakes.sandbox.wraps.at(-1);
    const wtDir = s.t.ctx.roots.get({ kind: 'worktree', worktreeId })?.realPath as string;
    expect(spec?.rootPath).toBe(wtDir);
    expect(spec?.denyReadPaths).toEqual(expect.arrayContaining([s.t.ctx.roots.main.realPath, s.t.ctx.roots.worktreesDir]));
    expect(spec?.denyWritePaths).toEqual(expect.arrayContaining([s.t.ctx.roots.main.realPath, join(wtDir, '.git')]));
    await runner.conn.request('session.end', { sessionId: first.id });
    expect(s.fakes.worktrees.released).toEqual([{ worktreeId, sessionId: first.id, keep: true }]);
    // A kept worktree can host the next session; this time the owner asks to delete it with the session.
    const second = (await runner.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree', worktreeId }, cols: 80, rows: 24 })).session;
    expect(second.root).toEqual({ kind: 'worktree', worktreeId });
    await runner.conn.request('session.end', { sessionId: second.id, keepWorktree: false });
    expect(s.fakes.worktrees.released.at(-1)).toEqual({ worktreeId, sessionId: second.id, keep: false });
    // A terminate (or a kick) keeps it.
    const third = (await runner.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree', worktreeId }, cols: 80, rows: 24 })).session;
    const host = await s.t.connectHost();
    await host.conn.request('admin.session.terminate', { sessionId: third.id });
    expect(s.fakes.worktrees.released.at(-1)).toEqual({ worktreeId, sessionId: third.id, keep: true });
  });

  it('pasteSuggestion (the only path of suggestion text into a PTY) needs the owner and pastes like a terminal', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const amy = await s.t.connect({ userId: 'dev:amy', role: 'editor' });
    const { session } = await host.conn.request('session.create', terminal);
    const view = new TestViewer(host.conn, session.id);
    viewers.push(view);
    await view.attach({ cols: 80, rows: 24 });
    const amyPrincipal = s.t.ctx.members.principalOf('dev:amy');
    expect(() => s.sessions.pasteSuggestion(session.id, 'echo NOPE', amyPrincipal as never)).toThrow();
    const hostPrincipal = s.t.ctx.members.principalOf(TEST_HOST_USER);
    s.sessions.pasteSuggestion(session.id, 'echo PASTED-$((2+3))', hostPrincipal as never);
    await waitFor(() => view.received.includes('PASTED-5'), 'the pasted command to run');
    expect(view.received).not.toContain('NOPE');
    // A program that enabled bracketed paste gets the paste wrapped (cat -v shows the markers).
    typeInto(host.conn, session.id, "printf '\\033[?2004h'; cat -v\r");
    await waitFor(() => s.sessions.get(session.id) !== null && view.received.includes('2004h'), 'bracketed paste on');
    // No pause here: the paste itself waits until the daemon's mirror has parsed the mode switch (PtySession.paste).
    s.sessions.pasteSuggestion(session.id, 'line one\nline two', hostPrincipal as never);
    await waitFor(() => view.received.includes('^[[200~line one'), 'the bracketed paste');
    expect(amy.userId).toBe('dev:amy');
  });
});

// ARCHITECTURE §11 D-14 (owner decision 2026-10-01): guests' sandboxed sessions in the main workspace are off by
// default on a Linux host (config.sessions.guestMainWorkspace; `smurg host --allow-main-workspace-guests` opens them).
describe('guests in the main workspace (ARCHITECTURE §11 D-14)', { timeout: 60_000 }, () => {
  const mainOffAudit = async (s: SessionStack): Promise<unknown[]> =>
    (await s.t.ctx.audit.query({ limit: 50 })).filter((e) => e.action === 'session.create' && e.outcome === 'denied' && e.detail?.['reason'] === 'main-workspace-off');

  it('switched off: a guest\'s terminal and agent in the main workspace are refused (forbidden, main-workspace-off, zh-TW), audited, nothing prepared; their worktree works; the host is not affected', async () => {
    const s = await stack({ git: true, guestMainWorkspace: false });
    expect(s.t.ctx.workspace.info.isGitRepo).toBe(true);
    const host = await s.t.connectHost();
    const carol = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    expect(carol.welcome?.settings.guestMainWorkspace).toBe(false);
    for (const request of [terminal, agent, { ...agent, apiKey: 'sk-ant-api03-test-key-0000000000' }, { ...terminal, title: 'main please' }]) {
      const err = await carol.conn.request('session.create', request).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ code: 'forbidden', message: MAIN_WORKSPACE_OFF_MESSAGES.useWorktree, detail: { reason: 'main-workspace-off' } });
    }
    expect(MAIN_WORKSPACE_OFF_MESSAGES.useWorktree).toContain('worktree');
    expect(MAIN_WORKSPACE_OFF_MESSAGES.useWorktree).toContain('--allow-main-workspace-guests');
    // Refused before anything was prepared: no sandbox, no hook registration, no guest dir, no session.
    expect(s.fakes.sandbox.wraps).toEqual([]);
    expect(s.fakes.hooks.registered.size).toBe(0);
    expect(await exists(s.sessions.guestPaths('dev:carol').root)).toBe(false);
    expect(s.sessions.list()).toEqual([]);
    const denied = await mainOffAudit(s);
    expect(denied).toHaveLength(4);
    expect(denied[denied.length - 1]).toMatchObject({ actor: { kind: 'user', userId: 'dev:carol' }, target: 'main', detail: { kind: 'terminal', sandboxed: true, root: 'main', reason: 'main-workspace-off' } });
    expect(denied.map((e) => (e as { detail: { kind: string } }).detail.kind).sort()).toEqual(['agent', 'agent', 'terminal', 'terminal']);
    // The guest's own worktree is what they get.
    const inWorktree = (await carol.conn.request('session.create', { ...terminal, workspace: { mode: 'worktree' } })).session;
    expect(inWorktree).toMatchObject({ sandboxed: true, ownerUserId: 'dev:carol', root: { kind: 'worktree' } });
    expect(s.fakes.sandbox.wraps).toHaveLength(1);
    expect(s.fakes.sandbox.wraps[0]?.rootPath).not.toBe(s.t.ctx.roots.main.realPath);
    // The host's own (unsandboxed) sessions keep the main workspace.
    const hostSession = (await host.conn.request('session.create', terminal)).session;
    expect(hostSession).toMatchObject({ sandboxed: false, root: { kind: 'main' }, status: 'running' });
    const hostAgent = (await host.conn.request('session.create', agent)).session;
    expect(hostAgent).toMatchObject({ sandboxed: false, root: { kind: 'main' } });
    expect(await mainOffAudit(s)).toHaveLength(4);
  });

  it('switched off on a share that is not a git repository: the refusal says that there is no worktree either and how the host opens it', async () => {
    const s = await stack({ guestMainWorkspace: false });
    expect(s.t.ctx.workspace.info.isGitRepo).toBe(false);
    const carol = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    await expect(carol.conn.request('session.create', agent)).rejects.toMatchObject({ code: 'forbidden', message: MAIN_WORKSPACE_OFF_MESSAGES.noWorktree, detail: { reason: 'main-workspace-off' } });
    expect(MAIN_WORKSPACE_OFF_MESSAGES.noWorktree).toContain('不是 git 儲存庫'); // the web's word for it (review WEB-D14-1)
    expect(MAIN_WORKSPACE_OFF_MESSAGES.noWorktree).toContain('--allow-main-workspace-guests');
    expect(s.fakes.sandbox.wraps).toEqual([]);
    expect(await mainOffAudit(s)).toHaveLength(1);
  });

  it('a member who may not own sessions is refused for that, not for the main workspace', async () => {
    const s = await stack({ git: true, guestMainWorkspace: false });
    const amy = await s.t.connect({ userId: 'dev:amy', role: 'editor' });
    const err = await amy.conn.request('session.create', terminal).then(() => null, (e: { code: string; detail?: { reason?: string } }) => e);
    expect(err?.code).toBe('forbidden');
    expect(err?.detail?.reason).not.toBe('main-workspace-off');
    expect(await mainOffAudit(s)).toHaveLength(0);
  });

  it('switched on (smurg host --allow-main-workspace-guests): a guest\'s session runs in the main workspace, sandboxed', async () => {
    const s = await stack({ guestMainWorkspace: true });
    const carol = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    expect(carol.welcome?.settings.guestMainWorkspace).toBe(true);
    const session = (await carol.conn.request('session.create', terminal)).session;
    expect(session).toMatchObject({ sandboxed: true, root: { kind: 'main' } });
    expect(s.fakes.sandbox.wraps[0]?.rootPath).toBe(s.t.ctx.roots.main.realPath);
  });

  it('the platform\'s default decides when the host said nothing: refused on a Linux host, allowed on macOS', async () => {
    const s = await stack({ guestMainWorkspace: 'platform' });
    const open = defaultGuestMainWorkspace(process.platform);
    expect(open).toBe(process.platform !== 'linux');
    expect(s.t.ctx.config.sessions.guestMainWorkspace).toBe(open);
    const carol = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    expect(carol.welcome?.settings.guestMainWorkspace).toBe(open);
    const result = await carol.conn.request('session.create', terminal).then(({ session }) => session, (e: unknown) => e);
    if (open) expect(result).toMatchObject({ sandboxed: true, root: { kind: 'main' } });
    else expect(result).toMatchObject({ code: 'forbidden', detail: { reason: 'main-workspace-off' } });
  });
});

describe('Claude Code version policy (ARCHITECTURE §7.6)', { timeout: 60_000 }, () => {
  it('refuses guest agent sessions below the minimum (fail closed), audited as sandbox.refused; the host is only warned', async () => {
    const s = await stack({ claudeVersion: '2.1.100' });
    const runner = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    const err = await runner.conn.request('session.create', agent).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'sandbox_unavailable', detail: { reason: 'claude-version', version: '2.1.100' } });
    expect(s.fakes.sandbox.wraps).toEqual([]);
    expect(s.fakes.hooks.registered.size).toBe(0);
    expect((await s.t.ctx.audit.query({ limit: 20 })).some((e) => e.action === 'sandbox.refused' && e.detail?.['reason'] === 'claude-version')).toBe(true);
    // A guest TERMINAL does not depend on Claude Code's hooks: it starts.
    await expect(runner.conn.request('session.create', terminal)).resolves.toMatchObject({ session: { sandboxed: true } });
    const host = await s.t.connectHost();
    await expect(host.conn.request('session.create', agent)).resolves.toMatchObject({ session: { sandboxed: false } });
    expect(s.fakes.activity.notifications).toEqual([{ userId: TEST_HOST_USER, text: expect.stringContaining('2.1.100') }]);
  });

  it('warns — never refuses — above the verified range', async () => {
    const s = await stack({ claudeVersion: '2.1.999' });
    const runner = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    await expect(runner.conn.request('session.create', agent)).resolves.toMatchObject({ session: { sandboxed: true, status: 'running' } });
    expect(s.fakes.activity.notifications).toEqual([{ userId: 'dev:carol', text: expect.stringContaining('尚未經過 smurg 驗證') }]);
  });
});

describe('session.importConfig', { timeout: 60_000 }, () => {
  it('writes CLAUDE.md, commands/** and skills/** into the caller\'s own config dir, never through a planted symlink; audited with names only', async () => {
    const s = await stack();
    const runner = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    // First a session (creates the guest dir), whose "guest" then plants symlinks into its own config dir.
    const { session } = await runner.conn.request('session.create', terminal);
    await runner.conn.request('session.end', { sessionId: session.id });
    const guest = s.sessions.guestPaths('dev:carol');
    const outside = join(s.hostHome, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'keep.txt'), 'host file');
    await symlink(outside, join(guest.cfg, 'skills'));
    await symlink(join(outside, 'keep.txt'), join(guest.cfg, 'CLAUDE.md'));
    const secret = 'PERSONAL-CONFIG-CONTENT-7f3a';
    const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
    const result = await runner.conn.request('session.importConfig', {
      files: [
        { relPath: 'CLAUDE.md', content: enc(`# mine ${secret}`) },
        { relPath: 'commands/review.md', content: enc('review') },
        { relPath: 'skills/deploy/SKILL.md', content: enc('skill') },
        { relPath: 'skills/keep.txt', content: enc('would overwrite the host file through the link') },
      ],
    });
    expect(result.written).toEqual(['CLAUDE.md', 'commands/review.md', 'skills/deploy/SKILL.md', 'skills/keep.txt']);
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('host file');
    expect((await readdir(outside)).sort()).toEqual(['keep.txt']);
    expect((await lstat(join(guest.cfg, 'skills'))).isDirectory()).toBe(true);
    expect((await lstat(join(guest.cfg, 'CLAUDE.md'))).isFile()).toBe(true);
    expect(await readFile(join(guest.cfg, 'CLAUDE.md'), 'utf8')).toContain(secret);
    expect(await readFile(join(guest.cfg, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toBe('skill');
    await s.t.ctx.audit.flush();
    const entry = (await s.t.ctx.audit.query({ limit: 20 })).find((e) => e.action === 'session.import-config');
    expect(entry?.detail).toMatchObject({ count: 4, names: ['CLAUDE.md', 'commands/review.md', 'skills/deploy/SKILL.md', 'skills/keep.txt'] });
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(await readFile(join(s.t.stateDir, 'workspaces', s.t.workspaceId, 'audit.jsonl'), 'utf8')).not.toContain(secret);
  });

  it('refuses unsafe paths and names, and imports while a session runs', async () => {
    const s = await stack();
    const runner = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    const file = (relPath: string) => ({ files: [{ relPath, content: new Uint8Array([0x61]) }] });
    for (const relPath of ['../CLAUDE.md', '/etc/passwd', 'settings.json', '.credentials.json', 'commands/../../x.md', 'agents/a.md']) {
      await expect(runner.conn.request('session.importConfig', file(relPath)), relPath).rejects.toMatchObject({ code: 'bad_request' });
    }
    await expect(runner.conn.request('session.importConfig', { files: [{ relPath: 'commands/A.md', content: new Uint8Array(1) }, { relPath: 'commands/a.md', content: new Uint8Array(1) }] })).rejects.toMatchObject({ code: 'bad_request', detail: { reason: 'import-duplicate' } });
    const { session } = await runner.conn.request('session.create', terminal);
    await expect(runner.conn.request('session.importConfig', file('CLAUDE.md'))).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'sessions-running' } });
    await runner.conn.request('session.end', { sessionId: session.id });
    await expect(runner.conn.request('session.importConfig', file('CLAUDE.md'))).resolves.toEqual({ written: ['CLAUDE.md'] });
  });
});

describe('guest dirs over time (ARCHITECTURE §11 D-9)', { timeout: 60_000 }, () => {
  it('a guest\'s own symlink planted as its config dir is never followed when the next session seeds it', async () => {
    const s = await stack();
    const runner = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    const first = (await runner.conn.request('session.create', agent)).session;
    await runner.conn.request('session.end', { sessionId: first.id });
    const guest = s.sessions.guestPaths('dev:carol');
    // Replace cfg with a link to a "host" directory holding a .claude.json of the host.
    const hostDir = join(s.hostHome, 'host-claude');
    await mkdir(hostDir, { recursive: true });
    await writeFile(join(hostDir, '.claude.json'), '{"host":true}');
    await rm(guest.cfg, { recursive: true, force: true });
    await symlink(hostDir, guest.cfg);
    const second = (await runner.conn.request('session.create', agent)).session;
    expect(second.status).toBe('running');
    expect(await readFile(join(hostDir, '.claude.json'), 'utf8')).toBe('{"host":true}');
    expect((await lstat(guest.cfg)).isDirectory()).toBe(true); // replaced by a real directory
    expect(await readlink(guest.cfg).catch(() => null)).toBeNull();
  });

  it('"not connected for 7 days" counts from the END of the last connection: a member who stayed connected for 8 days and just dropped keeps the dir (a reconnect during the sweep must not delete it)', async () => {
    const s = await stack();
    const erin = await s.t.connect({ userId: 'dev:erin', role: 'runner' });
    const { session } = await erin.conn.request('session.create', terminal);
    await erin.conn.request('session.end', { sessionId: session.id });
    // Connected all along, for 8 days (the member record's lastSeenAt is still the connect time)…
    s.t.advanceClock(8 * 24 * 60 * 60_000);
    // …then the connection drops (a relay blip, a laptop lid) right before the daily sweep.
    erin.close();
    await waitFor(() => !s.t.ctx.hub.isOnline('dev:erin'), 'erin offline');
    expect(await s.sessions.sweepGuestDirs()).toBe(0);
    expect(await exists(s.sessions.guestPaths('dev:erin').root)).toBe(true);
    // 7 days after that disconnect the dir goes.
    s.t.advanceClock(8 * 24 * 60 * 60_000);
    expect(await s.sessions.sweepGuestDirs()).toBe(1);
    expect(await exists(s.sessions.guestPaths('dev:erin').root)).toBe(false);
  });

  it('a member connected for 8 days whose connection drops WHILE the sweep runs keeps the dir (the sweep reads each member as they are then)', async () => {
    const s = await stack();
    const fay = await s.t.connect({ userId: 'dev:fay', role: 'runner' });
    const { session } = await fay.conn.request('session.create', terminal);
    await fay.conn.request('session.end', { sessionId: session.id });
    s.t.advanceClock(8 * 24 * 60 * 60_000);
    // The sweep lists the guest dirs, and exactly then fay's connection drops (as a relay-link blip would).
    const store = (s.sessions as unknown as { store: { keys(): Promise<string[]> } }).store;
    const keys = store.keys.bind(store);
    store.keys = async () => {
      const found = await keys();
      fay.close();
      await waitFor(() => !s.t.ctx.hub.isOnline('dev:fay'), 'fay offline');
      return found;
    };
    expect(await s.sessions.sweepGuestDirs()).toBe(0);
    expect(await exists(s.sessions.guestPaths('dev:fay').root)).toBe(true);
  });

  it('removes the dirs of members not connected for 7 days at the retention sweep; a stop removes every guest dir', async () => {
    const s = await stack();
    const carol = await s.t.connect({ userId: 'dev:carol', role: 'runner' });
    const dave = await s.t.connect({ userId: 'dev:dave', role: 'runner' });
    for (const client of [carol, dave]) {
      const { session } = await client.conn.request('session.create', terminal);
      await client.conn.request('session.end', { sessionId: session.id });
    }
    carol.close();
    await waitFor(() => !s.t.ctx.hub.isOnline('dev:carol'), 'carol offline');
    s.t.advanceClock(8 * 24 * 60 * 60_000);
    expect(await s.sessions.sweepGuestDirs()).toBe(1);
    expect(await exists(s.sessions.guestPaths('dev:carol').root)).toBe(false);
    expect(await exists(s.sessions.guestPaths('dev:dave').root)).toBe(true); // online: kept
    const daveDir = s.sessions.guestPaths('dev:dave').root;
    const { session } = await dave.conn.request('session.create', terminal);
    const pid = s.sessions.ptyPid(session.id) as number;
    await s.t.daemon.stop();
    expect(await exists(daveDir)).toBe(false);
    await sleep(100);
    expect(() => process.kill(pid, 0)).toThrow(); // our own child is gone
  });
});

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
