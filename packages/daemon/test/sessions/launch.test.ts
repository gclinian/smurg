// Who may do what with TERMINAL sessions (ARCHITECTURE §3, §5.5, §11 D-15) and how they are launched (§7.6): every
// session runs like the host's own whoever opened it, the member who opened it is named in `openedBy`, the end of the
// terminals a removed member opened, and stop(). An agent session is a Claude Code conversation (AgentSessions): its
// launch, version floor and login state are tested with the agent runtime.
import { readFile, stat } from 'node:fs/promises';
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
const agent = { kind: 'agent', workspace: { mode: 'main' } } as const;

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
    expect(hostSession.openedBy.userId).toBe(TEST_HOST_USER);
    expect(carolSession).toMatchObject({ kind: 'terminal', openedBy: { userId: 'dev:carol', displayName: 'Carol' } });
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
      // A terminal has no Claude login to check: a member who may drive sessions is told so, the others are refused.
      expect(await outcomeOf(client.conn.request('session.loginStatus', { sessionId: other.id })), `${role} session.loginStatus`).toBe(expected[role].loginStatus ? 'bad_request' : 'forbidden');
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

describe('worktree sessions', { timeout: 60_000 }, () => {
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
});

describe('the sessions a member opened end when the member goes', { timeout: 60_000 }, () => {
  async function opened(s: SessionStack): Promise<{ host: TestClient; carol: TestClient; dave: TestClient; ids: { host: string; carol: string[]; dave: string } }> {
    const host = await s.t.connectHost();
    const carol = await s.t.connect({ userId: 'dev:carol', displayName: 'Carol', role: 'agent' });
    const dave = await s.t.connect({ userId: 'dev:dave', displayName: 'Dave', role: 'agent' });
    const ids = {
      host: (await host.conn.request('session.create', terminal)).session.id,
      carol: [(await carol.conn.request('session.create', terminal)).session.id, (await carol.conn.request('session.create', terminal)).session.id],
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
    for (const entry of ended) expect(entry).toMatchObject({ actor: { kind: 'system' }, outcome: 'ok', detail: { openedBy: 'dev:carol', kind: 'terminal', reason: 'kicked' } });
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
