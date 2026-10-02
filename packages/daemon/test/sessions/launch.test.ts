// Who may do what with sessions (ARCHITECTURE §3, §5.5, §11 D-15), how sessions are launched (§7.6): every session
// runs like the host's own whoever opened it, the member who opened it is its owner (attribution), the Claude Code
// version only warns, login detection, the end of the sessions a removed member opened, and stop().
import { readFile, readdir, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isSmurgError, type AuditEntry, type Role } from '@smurg/protocol';
import { TEST_HOST_USER, type TestClient } from '../../src/testing/index.ts';
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
  return stat(path).then(
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

async function audit(s: SessionStack): Promise<AuditEntry[]> {
  return s.t.ctx.audit.query({ limit: 200 });
}

/** What `request` was answered with: 'ok', or the error code. */
async function outcomeOf(request: Promise<unknown>): Promise<string> {
  return request.then(
    () => 'ok',
    (err: unknown) => (isSmurgError(err) ? err.code : String(err)),
  );
}

const terminal = { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 } as const;
const agent = { kind: 'agent', workspace: { mode: 'main' }, cols: 80, rows: 24 } as const;

describe('who may create and drive sessions (ARCHITECTURE §11 D-15)', { timeout: 60_000 }, () => {
  it('a viewer cannot create sessions; an editor cannot either (refused and audited)', async () => {
    const s = await stack();
    const viewer = await s.t.connect({ userId: 'dev:vic', role: 'viewer' });
    const editor = await s.t.connect({ userId: 'dev:amy', role: 'editor' });
    await expect(viewer.conn.request('session.create', terminal)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(editor.conn.request('session.create', agent)).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.sessions.list()).toEqual([]);
    expect(s.fakes.hooks.registered.size).toBe(0);
    const denied = (await audit(s)).filter((e) => e.action === 'authz.denied' && e.target === 'session.create');
    expect(denied.map((e) => (e.actor.kind === 'user' ? e.actor.userId : '')).sort()).toEqual(['dev:amy', 'dev:vic']);
  });

  it('the permission matrix: viewer / editor / Agent access / host × open, type into, resize, end someone else\'s session, read its login state', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const carol = await s.t.connect({ userId: 'dev:carol', displayName: 'Carol', role: 'agent' });
    const amy = await s.t.connect({ userId: 'dev:amy', role: 'editor' });
    const vic = await s.t.connect({ userId: 'dev:vic', role: 'viewer' });
    const hostSession = (await host.conn.request('session.create', terminal)).session;
    const carolSession = (await carol.conn.request('session.create', terminal)).session;
    expect(hostSession.ownerUserId).toBe(TEST_HOST_USER);
    expect(carolSession).toMatchObject({ ownerUserId: 'dev:carol', ownerName: 'Carol' });
    const hostView = new TestViewer(host.conn, hostSession.id);
    const carolView = new TestViewer(carol.conn, carolSession.id);
    viewers.push(hostView, carolView);
    await hostView.attach({ cols: 80, rows: 24 });
    await carolView.attach({ cols: 80, rows: 24 });

    const clients: Readonly<Record<Role, TestClient>> = { host, agent: carol, editor: amy, viewer: vic };
    const expected: Readonly<Record<Role, { create: boolean; type: boolean; loginStatus: boolean }>> = {
      host: { create: true, type: true, loginStatus: true },
      agent: { create: true, type: true, loginStatus: true },
      editor: { create: false, type: false, loginStatus: false },
      viewer: { create: false, type: false, loginStatus: false },
    };
    const errors = new Map<Role, string[]>();
    for (const [role, client] of Object.entries(clients) as [Role, TestClient][]) {
      errors.set(role, []);
      client.conn.on('error', (payload) => errors.get(role)?.push(payload.code));
    }
    for (const [role, client] of Object.entries(clients) as [Role, TestClient][]) {
      // Typing into the HOST's session and into Carol's: session.drive, any session.
      typeInto(client.conn, hostSession.id, `echo TYPED-BY-${role.toUpperCase()}-IN-HOST\r`);
      typeInto(client.conn, carolSession.id, `echo TYPED-BY-${role.toUpperCase()}-IN-CAROL\r`);
      const other = role === 'host' ? carolSession : hostSession;
      expect(await outcomeOf(client.conn.request('session.loginStatus', { sessionId: other.id })), `${role} session.loginStatus`).toBe(expected[role].loginStatus ? 'ok' : 'forbidden');
      // Ending or resizing a session someone else opened: only its owner (the host terminates through the console).
      expect(await outcomeOf(client.conn.request('session.end', { sessionId: other.id })), `${role} session.end`).toBe('forbidden');
    }
    for (const role of ['host', 'agent'] as const) {
      await waitFor(() => hostView.received.includes(`TYPED-BY-${role.toUpperCase()}-IN-HOST`), `${role}'s input in the host's session`);
      await waitFor(() => carolView.received.includes(`TYPED-BY-${role.toUpperCase()}-IN-CAROL`), `${role}'s input in Carol's session`);
    }
    // The refused ones: forbidden, audited, and nothing of them ever reached a PTY.
    await waitFor(() => (errors.get('editor')?.length ?? 0) >= 2 && (errors.get('viewer')?.length ?? 0) >= 2, 'the refusals of the editor and the viewer');
    await sleep(100);
    for (const view of [hostView, carolView]) {
      expect(view.received).not.toContain('TYPED-BY-EDITOR');
      expect(view.received).not.toContain('TYPED-BY-VIEWER');
    }
    const entries = await audit(s);
    for (const userId of ['dev:amy', 'dev:vic']) {
      const denied = entries.filter((e) => e.action === 'authz.denied' && e.actor.kind === 'user' && e.actor.userId === userId && e.target === 'exec.input');
      expect(denied, userId).toHaveLength(2);
    }
    for (const [role, client] of Object.entries(clients) as [Role, TestClient][]) {
      expect(await outcomeOf(client.conn.request('session.create', terminal)), `${role} session.create`).toBe(expected[role].create ? 'ok' : 'forbidden');
    }
    // Resizing someone else's session is refused (the PTY follows its owner's viewport), for the host too.
    carol.conn.notify('exec.resize', { sessionId: hostSession.id, cols: 30, rows: 10 });
    host.conn.notify('exec.resize', { sessionId: carolSession.id, cols: 30, rows: 10 });
    await waitFor(() => (errors.get('agent')?.length ?? 0) >= 1 && (errors.get('host')?.length ?? 0) >= 1, 'the resize refusals');
    expect(s.sessions.get(hostSession.id)).toMatchObject({ cols: 80, rows: 24, status: 'running' });
    expect(s.sessions.get(carolSession.id)).toMatchObject({ cols: 80, rows: 24, status: 'running' });
    // The owner ends their own; the host ends anyone's through the console.
    await expect(carol.conn.request('session.end', { sessionId: carolSession.id })).resolves.toEqual({});
    expect(s.sessions.get(carolSession.id)).toMatchObject({ status: 'exited', endReason: 'ended', endedBy: { userId: 'dev:carol' } });
    const another = (await carol.conn.request('session.create', terminal)).session;
    await expect(carol.conn.request('admin.session.terminate', { sessionId: hostSession.id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(host.conn.request('admin.session.terminate', { sessionId: another.id })).resolves.toEqual({});
    expect(s.sessions.get(another.id)).toMatchObject({ status: 'exited', endReason: 'terminated', endedBy: { userId: TEST_HOST_USER } });
  });

  it('every session runs like the host\'s own, whoever opened it: the host\'s HOME and environment, no guest dir', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const carol = await s.t.connect({ userId: 'dev:carol', displayName: 'Carol', role: 'agent' });
    const out = join(s.hostHome, 'evidence');
    const sessions = [(await host.conn.request('session.create', terminal)).session, (await carol.conn.request('session.create', terminal)).session];
    for (const [index, session] of sessions.entries()) {
      expect(Object.keys(session)).not.toContain('sandboxed');
      expect(session.root).toEqual({ kind: 'main' });
      const file = `${out}-${index}`;
      typeInto(carol.conn, session.id, `{ printf '%s\\n' "$HOME" "$SMURG_SESSION_ID" "$(pwd -P)"; /usr/bin/id -un; } > '${file}'\r`);
      await waitFor(async () => (await readFile(file, 'utf8').catch(() => '')).split('\n').length >= 5, `the environment of session ${index}`);
      const [home, sessionId, cwd, user] = (await readFile(file, 'utf8')).split('\n');
      expect(home).toBe(s.hostHome);
      expect(sessionId).toBe(session.id);
      expect(cwd).toBe(s.t.ctx.roots.main.realPath);
      expect(user).toBe(userInfo().username);
    }
    expect(await exists(join(s.t.stateDir, 'guests'))).toBe(false);
    const created = (await audit(s)).filter((e) => e.action === 'session.create' && e.outcome === 'ok').reverse(); // oldest first
    expect(created.map((e) => (e.actor.kind === 'user' ? e.actor.userId : ''))).toEqual([TEST_HOST_USER, 'dev:carol']);
    expect(created[1]?.detail).toEqual({ sessionId: sessions[1]?.id, kind: 'terminal', root: 'main' });
  });
});

describe('agent sessions (ARCHITECTURE §7.6)', { timeout: 60_000 }, () => {
  it('the host\'s agent: claude --settings --mcp-config (no permission flags), hooks registered, the session settings', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const { session } = await host.conn.request('session.create', agent);
    expect(session).toMatchObject({ kind: 'agent', ownerName: 'Host' });
    // Nobody typed a title: none is sent (each client builds the default in the viewer's language).
    expect(session.title).toBeUndefined();
    // A title the opener typed is kept as it is (a person's words are never translated or replaced).
    const { session: named } = await host.conn.request('session.create', { ...terminal, title: 'release notes' });
    expect(named.title).toBe('release notes');
    expect(s.t.ctx.services.sessions.list().map((info) => info.title)).toEqual([undefined, 'release notes']);
    await waitFor(async () => (await argvOf(s.fakeClaude.logDir)).length === 1, 'claude to start');
    const [argv] = await argvOf(s.fakeClaude.logDir);
    expect(argv?.slice(0, 4)).toEqual(['--settings', expect.stringMatching(/sessions\/[0-9a-f]{24}\/[0-9a-f]+\/settings\.json$/), '--mcp-config', expect.stringMatching(/mcp\.json$/)]);
    expect(argv).toHaveLength(4);
    expect(argv?.join(' ')).not.toMatch(/dangerously|permission-mode|strict-mcp-config/);
    const settings = JSON.parse(await readFile(argv?.[1] as string, 'utf8'));
    expect(settings.permissions.defaultMode).toBe('default');
    expect(settings.hooks.PreToolUse[0].hooks[0]).toEqual({ type: 'command', command: '/usr/bin/true', args: ['hook'], timeout: 10 });
    expect((await stat(argv?.[1] as string)).mode & 0o777).toBe(0o600);
    expect(s.fakes.hooks.registered.get(session.id)).toEqual({ sessionId: session.id, ownerUserId: TEST_HOST_USER, agentName: 'Claude (Host)', root: { kind: 'main' } });
    const [envNames] = await envNamesOf(s.fakeClaude.logDir);
    expect(envNames).toEqual(expect.arrayContaining(['SMURG_SESSION_TOKEN', 'SMURG_HOOK_SOCKET', 'SMURG_SESSION_ID']));
    expect(s.fakes.presence.agents.has(session.id)).toBe(true);
    expect(s.sessions.agentActor(session.id)).toEqual({ kind: 'agent', sessionId: session.id, ownerUserId: TEST_HOST_USER, displayName: 'Claude (Host)' });

    await host.conn.request('session.end', { sessionId: session.id });
    expect(s.fakes.hooks.unregistered).toEqual([session.id]);
    expect(s.fakes.locks.released).toEqual([{ sessionId: session.id, reason: 'session-ended' }]);
    expect(s.fakes.presence.removed).toEqual([session.id]);
    expect(await exists(argv?.[1] as string)).toBe(false); // the daemon-owned settings dir went with the session
  });

  it('an agent an Agent access member opens is launched exactly like the host\'s, and is attributed to her: `Claude (Carol)`, its hook registration, presence and locks carry her user id', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const carol = await s.t.connect({ userId: 'dev:carol', displayName: 'Carol', role: 'agent' });
    const hostAgent = (await host.conn.request('session.create', agent)).session;
    await waitFor(async () => (await argvOf(s.fakeClaude.logDir)).length === 1, 'the host\'s claude to start');
    const { session } = await carol.conn.request('session.create', agent);
    expect(session).toMatchObject({ kind: 'agent', ownerUserId: 'dev:carol', ownerName: 'Carol', root: { kind: 'main' } });
    expect(session.title).toBeUndefined();
    await waitFor(async () => (await argvOf(s.fakeClaude.logDir)).length === 2, 'Carol\'s claude to start');
    const argvs = await argvOf(s.fakeClaude.logDir);
    const settingsOf = async (argv: string[] | undefined): Promise<unknown> => JSON.parse(await readFile(argv?.[1] as string, 'utf8'));
    // Same flags, same settings (only the per-session paths differ).
    for (const argv of argvs) expect(argv.filter((arg) => arg.startsWith('--'))).toEqual(['--settings', '--mcp-config']);
    expect(await settingsOf(argvs[0])).toEqual(await settingsOf(argvs[1]));
    const envNames = await envNamesOf(s.fakeClaude.logDir);
    expect(envNames[0]?.slice().sort()).toEqual(envNames[1]?.slice().sort());
    expect(envNames[1]).not.toContain('CLAUDE_CONFIG_DIR');
    expect(s.fakes.hooks.registered.get(session.id)).toEqual({ sessionId: session.id, ownerUserId: 'dev:carol', agentName: 'Claude (Carol)', root: { kind: 'main' } });
    expect(s.fakes.presence.agents.get(session.id)).toMatchObject({ ownerUserId: 'dev:carol', displayName: 'Claude (Carol)' });
    expect(s.sessions.agentActor(session.id)).toEqual({ kind: 'agent', sessionId: session.id, ownerUserId: 'dev:carol', displayName: 'Claude (Carol)' });
    expect(s.sessions.agentActor(hostAgent.id)).toMatchObject({ kind: 'agent', ownerUserId: TEST_HOST_USER });
  });

  it('login state: `claude auth status` in the session\'s environment (the host\'s Claude login); the TUI never decides it', async () => {
    const loggedOut = await stack();
    const carol = await loggedOut.t.connect({ userId: 'dev:carol', role: 'agent' });
    const { session } = await carol.conn.request('session.create', agent);
    await expect(carol.conn.request('session.loginStatus', { sessionId: session.id })).resolves.toEqual({ login: 'logged-out' });
    await waitFor(() => loggedOut.sessions.get(session.id)?.login === 'logged-out', 'the login state in SessionInfo');

    // The host's environment carries their own login (the stand-in claude reads ANTHROPIC_API_KEY): every session,
    // whoever opened it, is logged in with it.
    const loggedIn = await stack({ hostEnv: (home) => ({ PATH: '/usr/bin:/bin', HOME: home, USER: 'host', LANG: 'en_US.UTF-8', ANTHROPIC_API_KEY: 'sk-ant-api03-host-own-test-key' }) });
    const host = await loggedIn.t.connectHost();
    const dana = await loggedIn.t.connect({ userId: 'dev:dana', role: 'agent' });
    const danaAgent = (await dana.conn.request('session.create', agent)).session;
    await expect(dana.conn.request('session.loginStatus', { sessionId: danaAgent.id })).resolves.toEqual({ login: 'logged-in' });
    await expect(host.conn.request('session.loginStatus', { sessionId: danaAgent.id })).resolves.toEqual({ login: 'logged-in' });
  });
});

describe('worktree sessions and accepted suggestions', { timeout: 60_000 }, () => {
  it('worktree mode: the session\'s root and cwd are the worktree, and only session.end {keepWorktree: false} removes it', async () => {
    const s = await stack();
    const carol = await s.t.connect({ userId: 'dev:carol', role: 'agent' });
    const first = (await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree' }, cols: 80, rows: 24 })).session;
    const worktreeId = s.fakes.worktrees.acquired[0]?.worktreeId as string;
    expect(first.root).toEqual({ kind: 'worktree', worktreeId });
    const wtDir = s.t.ctx.roots.get({ kind: 'worktree', worktreeId })?.realPath as string;
    const cwdFile = join(s.hostHome, 'wt-cwd');
    typeInto(carol.conn, first.id, `pwd -P > '${cwdFile}'\r`);
    await waitFor(async () => (await readFile(cwdFile, 'utf8').catch(() => '')).endsWith('\n'), 'the cwd');
    expect((await readFile(cwdFile, 'utf8')).trim()).toBe(wtDir);
    await carol.conn.request('session.end', { sessionId: first.id });
    expect(s.fakes.worktrees.released).toEqual([{ worktreeId, sessionId: first.id, keep: true }]);
    // A kept worktree can host the next session; this time the owner asks to delete it with the session.
    const second = (await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree', worktreeId }, cols: 80, rows: 24 })).session;
    expect(second.root).toEqual({ kind: 'worktree', worktreeId });
    await carol.conn.request('session.end', { sessionId: second.id, keepWorktree: false });
    expect(s.fakes.worktrees.released.at(-1)).toEqual({ worktreeId, sessionId: second.id, keep: false });
    // A terminate (or a kick) keeps it.
    const third = (await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree', worktreeId }, cols: 80, rows: 24 })).session;
    const host = await s.t.connectHost();
    await host.conn.request('admin.session.terminate', { sessionId: third.id });
    expect(s.fakes.worktrees.released.at(-1)).toEqual({ worktreeId, sessionId: third.id, keep: true });
  });

  it('pasteSuggestion (the only path of suggestion text into a PTY) needs session.drive (the host, Agent access: any session) and pastes like a terminal', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    await s.t.connect({ userId: 'dev:amy', role: 'editor' });
    await s.t.connect({ userId: 'dev:carol', role: 'agent' });
    const { session } = await host.conn.request('session.create', terminal);
    const view = new TestViewer(host.conn, session.id);
    viewers.push(view);
    await view.attach({ cols: 80, rows: 24 });
    const amyPrincipal = s.t.ctx.members.principalOf('dev:amy');
    expect(() => s.sessions.pasteSuggestion(session.id, 'echo NOPE', amyPrincipal as never)).toThrow();
    // Carol may decide suggestions on the host's session.
    s.sessions.pasteSuggestion(session.id, 'echo CAROL-$((1+2))', s.t.ctx.members.principalOf('dev:carol') as never);
    await waitFor(() => view.received.includes('CAROL-3'), 'the paste of an Agent access member');
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
  });
});

describe('Claude Code version policy (ARCHITECTURE §7.6)', { timeout: 60_000 }, () => {
  it('below the minimum: every agent starts (it is the host\'s own CLI) and its opener is warned', async () => {
    const s = await stack({ claudeVersion: '2.1.100' });
    const carol = await s.t.connect({ userId: 'dev:carol', role: 'agent' });
    await expect(carol.conn.request('session.create', agent)).resolves.toMatchObject({ session: { status: 'running' } });
    const host = await s.t.connectHost();
    await expect(host.conn.request('session.create', agent)).resolves.toMatchObject({ session: { status: 'running' } });
    expect(s.fakes.activity.notifications).toEqual([
      { userId: 'dev:carol', msg: { id: 'notify.claudeVersionTooOld', params: { version: '2.1.100', minVersion: expect.any(String) } }, fallback: expect.stringMatching(/^Note: Claude Code 2\.1\.100 is older than /) },
      { userId: TEST_HOST_USER, msg: { id: 'notify.claudeVersionTooOld', params: { version: '2.1.100', minVersion: expect.any(String) } }, fallback: expect.stringMatching(/^Note: Claude Code 2\.1\.100 is older than /) },
    ]);
  });

  it('warns — never refuses — above the verified range', async () => {
    const s = await stack({ claudeVersion: '2.1.999' });
    const carol = await s.t.connect({ userId: 'dev:carol', role: 'agent' });
    await expect(carol.conn.request('session.create', agent)).resolves.toMatchObject({ session: { status: 'running' } });
    // A daemon-written notification: a message reference plus its English rendering, never a finished sentence in one language.
    expect(s.fakes.activity.notifications).toEqual([
      {
        userId: 'dev:carol',
        msg: { id: 'notify.claudeVersionUnverified', params: { version: '2.1.999', verified: expect.any(Array) } },
        fallback: expect.stringMatching(/^Note: Claude Code 2\.1\.999 has not been verified with smurg yet \(verified: /),
      },
    ]);
  });
});

// ARCHITECTURE §11 D-15: a member who is removed, leaves or is set below Agent access loses the sessions they opened
// (they run as the host's OS user), each audited as session.terminate by the system with the reason.
describe('the sessions a member opened end when the member goes', { timeout: 60_000 }, () => {
  async function opened(s: SessionStack): Promise<{ host: TestClient; carol: TestClient; dave: TestClient; ids: { host: string; carol: string[]; dave: string } }> {
    const host = await s.t.connectHost();
    const carol = await s.t.connect({ userId: 'dev:carol', displayName: 'Carol', role: 'agent' });
    const dave = await s.t.connect({ userId: 'dev:dave', displayName: 'Dave', role: 'agent' });
    const ids = {
      host: (await host.conn.request('session.create', terminal)).session.id,
      carol: [(await carol.conn.request('session.create', terminal)).session.id, (await carol.conn.request('session.create', agent)).session.id],
      dave: (await dave.conn.request('session.create', terminal)).session.id,
    };
    return { host, carol, dave, ids };
  }

  function terminations(entries: readonly AuditEntry[]): AuditEntry[] {
    return entries.filter((e) => e.action === 'session.terminate');
  }

  it('a kick ends hers within 3 s (kicked), audited by the system; the host\'s and another member\'s go on', async () => {
    const s = await stack();
    const { host, ids } = await opened(s);
    const pids = ids.carol.map((id) => s.sessions.ptyPid(id) as number);
    const t0 = Date.now();
    await host.conn.request('admin.member.kick', { userId: 'dev:carol' });
    for (const id of ids.carol) expect(s.sessions.get(id)).toMatchObject({ status: 'exited', endReason: 'kicked' });
    expect(Date.now() - t0).toBeLessThan(3_000);
    await sleep(100);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(); // our own children are gone
    expect(s.sessions.get(ids.host)?.status).toBe('running');
    expect(s.sessions.get(ids.dave)?.status).toBe('running');
    const ended = terminations(await audit(s));
    expect(ended.map((e) => e.target).sort()).toEqual([...ids.carol].sort());
    for (const entry of ended) expect(entry).toMatchObject({ actor: { kind: 'system' }, outcome: 'ok', detail: { ownerUserId: 'dev:carol', reason: 'kicked' } });
  });

  it('set to editor or viewer: hers end (role-changed), audited; a change that keeps Agent access, or editor → viewer, ends nothing', async () => {
    const s = await stack();
    const { host, dave, ids } = await opened(s);
    await host.conn.request('admin.member.setRole', { userId: 'dev:carol', role: 'editor' });
    for (const id of ids.carol) expect(s.sessions.get(id)).toMatchObject({ status: 'exited', endReason: 'role-changed' });
    expect(terminations(await audit(s)).map((e) => e.detail?.['reason'])).toEqual(['role-changed', 'role-changed']);
    // editor → viewer: she has no session to lose; Dave keeps his role and his session.
    await host.conn.request('admin.member.setRole', { userId: 'dev:carol', role: 'viewer' });
    await host.conn.request('admin.member.setRole', { userId: 'dev:dave', role: 'agent' });
    expect(s.sessions.get(ids.dave)?.status).toBe('running');
    await host.conn.request('admin.member.setRole', { userId: 'dev:dave', role: 'viewer' });
    expect(s.sessions.get(ids.dave)).toMatchObject({ status: 'exited', endReason: 'role-changed' });
    expect(terminations(await audit(s))).toHaveLength(3);
    expect(dave.userId).toBe('dev:dave');
    expect(s.sessions.get(ids.host)?.status).toBe('running');
  });

  it('channel.leave ends the leaver\'s sessions (left), audited; membership stays', async () => {
    const s = await stack();
    const { carol, ids } = await opened(s);
    await expect(carol.conn.request('channel.leave', {})).resolves.toEqual({});
    for (const id of ids.carol) expect(s.sessions.get(id)).toMatchObject({ status: 'exited', endReason: 'left' });
    expect(s.sessions.get(ids.dave)?.status).toBe('running');
    expect(s.t.ctx.members.roleOf('dev:carol')).toBe('agent');
    const entries = await audit(s);
    expect(entries.some((e) => e.action === 'member.leave' && e.target === 'dev:carol')).toBe(true);
    expect(terminations(entries).map((e) => e.detail?.['reason'])).toEqual(['left', 'left']);
  });

  it('a stop ends every session', async () => {
    const s = await stack();
    const { ids } = await opened(s);
    const pids = [ids.host, ...ids.carol, ids.dave].map((id) => s.sessions.ptyPid(id) as number);
    await s.t.daemon.stop();
    await sleep(100);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(); // our own children are gone
  });
});
