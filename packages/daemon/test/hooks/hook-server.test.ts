// The hook socket (ARCHITECTURE §7.7) with plain socket clients: what the daemon decides for each Claude Code hook
// event, and how it treats forged events. The real Claude Code in front of it is exercised in claude-e2e.test.ts.
import { mkdir, lstat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAIN_ROOT, type FileRef } from '@smurg/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonEvents } from '../../src/core/interfaces.ts';
import { HookServerImpl } from '../../src/hooks/hook-server.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { HOOK_ENV, HOOK_REQUEST_MAX_BYTES } from '../../src/hooks/wire.ts';
import { HOOK_DENY_REASONS, humanHeldReason, pathDeniedReason } from '../../src/hooks/deny-text.ts';
import { createTestDaemon, TEST_HOST_USER, type TestDaemon } from '../../src/testing/index.ts';
import { denyReasonOf, hookRequest, lifecycle, post, pre, rawExchange, registerAgent, startHookDaemon, type HookDaemon } from './helpers.ts';

const HOST = { userId: TEST_HOST_USER, name: 'Host' };
const IAN = { userId: 'dev:ian', name: 'Ian' };

const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });

let current: HookDaemon | null = null;
let extra: TestDaemon | null = null;
afterEach(async () => {
  await current?.t.cleanup();
  await extra?.cleanup();
  current = null;
  extra = null;
});

async function setup(options: Parameters<typeof startHookDaemon>[0] = {}): Promise<HookDaemon> {
  current = await startHookDaemon({
    ...options,
    daemon: { project: { files: { 'locked.txt': 'hello from Amy\n', 'free.txt': 'free text\n', 'nb.ipynb': '{}\n', 'src/a.ts': 'a\n', '.claude/settings.json': '{}\n' } }, ...options.daemon },
  });
  return current;
}

function capture<K extends keyof DaemonEvents>(d: HookDaemon, name: K): DaemonEvents[K][] {
  const events: DaemonEvents[K][] = [];
  d.t.ctx.bus.on(name, (event) => events.push(event));
  return events;
}

/** A Agent access member: admitted through a real invite so the agent's owner is active. */
async function withAgentMember(d: HookDaemon): Promise<void> {
  await d.t.connect({ userId: IAN.userId, displayName: IAN.name, role: 'agent' });
}

describe('hook socket', () => {
  it('listens on config.runPaths.hook, mode 0600, within the socket path limit; sessions get SMURG_HOOK_SOCKET / SMURG_SESSION_TOKEN / SMURG_SESSION_ID', async () => {
    const d = await setup();
    expect(d.hooks.socketPath).toBe(d.t.ctx.config.runPaths.hook);
    expect(Buffer.byteLength(d.hooks.socketPath)).toBeLessThanOrEqual(103);
    const st = await lstat(d.hooks.socketPath);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    const a = registerAgent(d.hooks, HOST);
    const b = registerAgent(d.hooks, HOST);
    expect(a.env).toEqual({ [HOOK_ENV.socket]: d.hooks.socketPath, [HOOK_ENV.token]: a.token, [HOOK_ENV.sessionId]: a.sessionId });
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
  });

  it('refuses to start next to a live hook socket, and on a path taken by something that is not a socket', async () => {
    const d = await setup();
    await expect(new HookServerImpl(d.t.ctx).start()).rejects.toThrow(/another daemon/);
    extra = await createTestDaemon({ modules: [] });
    await writeFile(extra.ctx.config.runPaths.hook, 'not a socket');
    await expect(new HookServerImpl(extra.ctx).start()).rejects.toThrow(/not a socket/);
  });

  it('removes its socket file when the daemon stops', async () => {
    const d = await setup();
    const path = d.hooks.socketPath;
    await d.t.cleanup();
    current = null;
    await expect(lstat(path)).rejects.toThrow();
  });
});

describe('PreToolUse → agent lock', () => {
  it('a granted lock returns NO decision (never "allow"): the hook prints nothing and the normal permission prompt still applies', async () => {
    const d = await setup();
    const pres = capture(d, 'agent.tool.pre');
    const s = registerAgent(d.hooks, HOST);
    const reply = await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'free.txt')));
    expect(reply).toEqual({ id: expect.any(String), hookOutput: null });
    expect(JSON.stringify(reply)).not.toContain('allow');
    const lock = d.fakes.locks.get(main('free.txt'));
    expect(lock).toMatchObject({ kind: 'agent', sessionId: s.sessionId, ownerUserId: HOST.userId, agentName: 'Claude (Host)' });
    expect(pres).toEqual([{ sessionId: s.sessionId, ownerUserId: HOST.userId, tool: 'Edit', file: main('free.txt'), outcome: 'granted' }]);
  });

  it('R8: an agent\'s Edit of a file someone is typing in is blocked and names the holder — the hook socket decision in isolation', async () => {
    const d = await setup();
    const pres = capture(d, 'agent.tool.pre');
    d.fakes.locks.holdHuman(main('locked.txt'), 'Amy');
    const s = registerAgent(d.hooks, HOST);
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      const reply = await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'locked.txt'), tool));
      expect(reply['hookOutput']).toEqual({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: humanHeldReason(['Amy']) },
      });
    }
    expect(d.fakes.locks.get(main('locked.txt'))?.kind).toBe('human');
    expect(pres[0]).toMatchObject({ outcome: 'denied', file: main('locked.txt'), holder: { kind: 'human' } });
  });

  it('R8: when two agents change the same file at once the later one is blocked — the hook socket decision in isolation', async () => {
    const d = await setup();
    await withAgentMember(d);
    const first = registerAgent(d.hooks, HOST);
    const second = registerAgent(d.hooks, IAN);
    const path = join(d.t.root, 'src', 'a.ts');
    const [a, b] = await Promise.all([hookRequest(d.hooks.socketPath, first.token, pre(path)), hookRequest(d.hooks.socketPath, second.token, pre(path))]);
    const denied = [a, b].filter((reply) => denyReasonOf(reply) !== null);
    expect(denied).toHaveLength(1);
    const winner = d.fakes.locks.get(main('src/a.ts'));
    expect(winner?.kind).toBe('agent');
    const loserName = winner?.kind === 'agent' && winner.sessionId === first.sessionId ? 'Claude (Host)' : 'Claude (Ian)';
    expect(denyReasonOf(denied[0] as (typeof denied)[number])).toContain(loserName);
  });

  it('realpaths the claimed path (symlinked parent, NotebookEdit notebook_path, a new file of Write)', async () => {
    const d = await setup();
    const s = registerAgent(d.hooks, HOST);
    await symlink(join(d.t.root, 'src'), join(d.t.root, 'src-link'));
    await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'src-link', 'a.ts')));
    expect(d.fakes.locks.get(main('src/a.ts'))?.kind).toBe('agent');
    await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'nb.ipynb'), 'NotebookEdit'));
    expect(d.fakes.locks.get(main('nb.ipynb'))?.kind).toBe('agent');
    await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'new', 'dir', 'file.txt'), 'Write'));
    expect(d.fakes.locks.get(main('new/dir/file.txt'))?.kind).toBe('agent');
  });

  it('tools that do not edit take no lock and get no decision', async () => {
    const d = await setup();
    const s = registerAgent(d.hooks, HOST);
    const reply = await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'free.txt'), 'Read'));
    expect(reply['hookOutput']).toBeNull();
    expect(d.fakes.locks.list()).toEqual([]);
  });
});

describe('agent lock release', () => {
  it('lock released after PostToolUse, which also reports the edit (agent.tool.post with the file) for the activity feed', async () => {
    const d = await setup();
    const posts = capture(d, 'agent.tool.post');
    const s = registerAgent(d.hooks, HOST);
    const file = join(d.t.root, 'free.txt');
    await hookRequest(d.hooks.socketPath, s.token, pre(file));
    expect(d.fakes.locks.get(main('free.txt'))).not.toBeNull();
    expect((await hookRequest(d.hooks.socketPath, s.token, post(file)))['hookOutput']).toBeNull();
    expect(d.fakes.locks.get(main('free.txt'))).toBeNull();
    expect(posts).toEqual([{ sessionId: s.sessionId, ownerUserId: HOST.userId, tool: 'Edit', file: main('free.txt'), ok: true }]);
  });

  it('lock released after a failed tool (PostToolUseFailure, reported with ok: false)', async () => {
    const d = await setup();
    const posts = capture(d, 'agent.tool.post');
    const s = registerAgent(d.hooks, HOST);
    const file = join(d.t.root, 'free.txt');
    await hookRequest(d.hooks.socketPath, s.token, pre(file, 'Write'));
    await hookRequest(d.hooks.socketPath, s.token, post(file, 'PostToolUseFailure', 'Write'));
    expect(d.fakes.locks.get(main('free.txt'))).toBeNull();
    expect(posts[0]).toMatchObject({ tool: 'Write', ok: false, file: main('free.txt') });
  });

  it('lock released after a rejected permission prompt (next prompt): PermissionRequest marks it waiting, no Post event comes, UserPromptSubmit releases it', async () => {
    const d = await setup();
    const s = registerAgent(d.hooks, HOST);
    const file = join(d.t.root, 'free.txt');
    await hookRequest(d.hooks.socketPath, s.token, pre(file));
    expect((await hookRequest(d.hooks.socketPath, s.token, post(file, 'PermissionRequest')))['hookOutput']).toBeNull();
    expect(d.fakes.locks.awaitingApproval.has(`${s.sessionId}|main:free.txt`)).toBe(true);
    // The owner answers "No": Claude Code sends nothing. The lock is still held…
    expect(d.fakes.locks.get(main('free.txt'))?.kind).toBe('agent');
    // …until the owner's next prompt.
    await hookRequest(d.hooks.socketPath, s.token, lifecycle('UserPromptSubmit'));
    expect(d.fakes.locks.get(main('free.txt'))).toBeNull();
    expect(d.fakes.locks.calls).toContainEqual({ op: 'releaseAllForSession', sessionId: s.sessionId, reason: 'prompt' });
  });

  it("Stop and SessionEnd release every lock of the session; the session's next PreToolUse releases what it still held", async () => {
    const d = await setup();
    const s = registerAgent(d.hooks, HOST);
    await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'free.txt')));
    await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'src', 'a.ts')));
    expect(d.fakes.locks.get(main('free.txt'))).toBeNull();
    expect(d.fakes.locks.get(main('src/a.ts'))?.kind).toBe('agent');
    await hookRequest(d.hooks.socketPath, s.token, lifecycle('Stop'));
    expect(d.fakes.locks.list()).toEqual([]);
    await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'free.txt')));
    await hookRequest(d.hooks.socketPath, s.token, lifecycle('SessionEnd'));
    expect(d.fakes.locks.list()).toEqual([]);
    expect(d.fakes.locks.calls.filter((c) => c.op === 'releaseAllForSession').map((c) => c.reason)).toEqual(['stop', 'session-ended']);
  });

  it('FileChanged feeds agent.file-changed (activity only); SessionStart gets no output', async () => {
    const d = await setup();
    const changes = capture(d, 'agent.file-changed');
    const s = registerAgent(d.hooks, HOST);
    const reply = await hookRequest(d.hooks.socketPath, s.token, { hook_event_name: 'FileChanged', file_path: join(d.t.root, 'free.txt'), event: 'change' });
    expect(reply['hookOutput']).toBeNull();
    expect(changes).toEqual([{ sessionId: s.sessionId, ownerUserId: HOST.userId, file: main('free.txt'), change: 'change' }]);
    expect((await hookRequest(d.hooks.socketPath, s.token, lifecycle('SessionStart')))['hookOutput']).toBeNull();
  });
});

describe('forged events (everything on the socket is a claim)', () => {
  it('a wrong token: PreToolUse denied, nothing locked, audited as authz.denied, the connection closed', async () => {
    const d = await setup();
    registerAgent(d.hooks, HOST);
    const reply = await hookRequest(d.hooks.socketPath, 'forged-token', pre(join(d.t.root, 'free.txt')));
    expect(denyReasonOf(reply)).toBe(HOOK_DENY_REASONS.unknownSession);
    expect(d.fakes.locks.list()).toEqual([]);
    const other = await hookRequest(d.hooks.socketPath, 'forged-token', lifecycle('Stop'));
    expect(other['hookOutput']).toBeNull();
    const entries = await d.t.ctx.audit.query({ limit: 20 });
    expect(entries.filter((e) => e.action === 'authz.denied' && e.target === 'hook-socket')).toHaveLength(2);
    expect(entries.find((e) => e.target === 'hook-socket')?.detail).toMatchObject({ reason: 'unknown-token', op: 'hook' });
  });

  it('the token of an unregistered session stops working at once', async () => {
    const d = await setup();
    const s = registerAgent(d.hooks, HOST);
    d.hooks.unregisterSession(s.sessionId);
    expect(denyReasonOf(await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'free.txt'))))).not.toBeNull();
    expect(d.fakes.locks.list()).toEqual([]);
    // A session.exited event unregisters too (belt and braces).
    const t = registerAgent(d.hooks, HOST);
    d.t.ctx.bus.emit('session.exited', { session: { id: t.sessionId } as DaemonEvents['session.exited']['session'], reason: 'exit' });
    expect(denyReasonOf(await hookRequest(d.hooks.socketPath, t.token, pre(join(d.t.root, 'free.txt'))))).not.toBeNull();
  });

  it('a path outside the session root is denied and audited: absolute, ../ from the claimed cwd, a symlink inside the share that points out', async () => {
    const d = await setup();
    const s = registerAgent(d.hooks, HOST);
    const outside = join(d.t.stateDir, '..', 'outside.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(d.t.root, 'escape.txt'));
    const attempts = [pre(outside), pre('../outside.txt', 'Edit', { cwd: d.t.root }), pre(join(d.t.root, 'escape.txt')), pre('/etc/hosts', 'Write')];
    for (const attempt of attempts) {
      expect(denyReasonOf(await hookRequest(d.hooks.socketPath, s.token, attempt))).toBe(HOOK_DENY_REASONS.outsideRoot);
    }
    expect(denyReasonOf(await hookRequest(d.hooks.socketPath, s.token, pre('relative.txt')))).toBe(HOOK_DENY_REASONS.noTarget);
    expect(d.fakes.locks.list()).toEqual([]);
    const denials = (await d.t.ctx.audit.query({ limit: 50 })).filter((e) => e.action === 'path.denied');
    expect(denials.length).toBeGreaterThanOrEqual(4);
    for (const entry of denials) {
      expect(entry.actor).toMatchObject({ kind: 'agent', sessionId: s.sessionId, displayName: 'Claude (Host)' });
      // Never an absolute host path in the audit target.
      expect(entry.target ?? '').not.toContain(d.t.stateDir);
    }
  });

  it('a path in another root is denied: a main-workspace session cannot lock a worktree file and a worktree session cannot lock a main file', async () => {
    const d = await setup();
    const wtDir = join(d.t.root, '.smurg', 'worktrees', 'wt_one');
    await mkdir(wtDir, { recursive: true });
    await writeFile(join(wtDir, 'a.txt'), 'wt');
    await d.t.ctx.roots.registerWorktree({ worktreeId: 'wt_one', dir: wtDir, ownerUserId: HOST.userId, sharedLinks: [] });
    const inMain = registerAgent(d.hooks, HOST);
    const inWorktree = registerAgent(d.hooks, HOST, { root: { kind: 'worktree', worktreeId: 'wt_one' } });
    expect(denyReasonOf(await hookRequest(d.hooks.socketPath, inMain.token, pre(join(wtDir, 'a.txt'))))).toBe(HOOK_DENY_REASONS.otherRoot);
    expect(denyReasonOf(await hookRequest(d.hooks.socketPath, inWorktree.token, pre(join(d.t.root, 'free.txt'))))).toBe(HOOK_DENY_REASONS.otherRoot);
    expect((await hookRequest(d.hooks.socketPath, inWorktree.token, pre(join(wtDir, 'a.txt'))))['hookOutput']).toBeNull();
    expect(d.fakes.locks.list().map((l) => l.file)).toEqual([{ root: { kind: 'worktree', worktreeId: 'wt_one' }, path: 'a.txt' }]);
  });

  it("host-only paths (.claude/**) are denied for a member's agent (it is the member who opened it) and allowed for the host's agent", async () => {
    const d = await setup();
    await withAgentMember(d);
    const ians = registerAgent(d.hooks, IAN);
    const host = registerAgent(d.hooks, HOST);
    const settings = join(d.t.root, '.claude', 'settings.json');
    expect(denyReasonOf(await hookRequest(d.hooks.socketPath, ians.token, pre(settings)))).toBe(pathDeniedReason('host-only'));
    expect((await hookRequest(d.hooks.socketPath, host.token, pre(settings)))['hookOutput']).toBeNull();
    const audit = await d.t.ctx.audit.query({ limit: 20 });
    expect(audit.find((e) => e.action === 'path.denied')?.detail).toMatchObject({ reason: 'host-only' });
    // A handover does not raise path rights (they are the session's, fixed when it was opened): Ian's session, now
    // owned by the host, is refused exactly as before.
    d.hooks.reassignSession(ians.sessionId, HOST.userId);
    expect(denyReasonOf(await hookRequest(d.hooks.socketPath, ians.token, pre(settings)))).toBe(pathDeniedReason('host-only'));
  });

  it('a flood beyond the lock cap: the session never holds more than the cap and requests beyond the per-token budget are denied', async () => {
    const d = await setup();
    const s = registerAgent(d.hooks, HOST);
    for (let i = 0; i < 40; i++) await writeFile(join(d.t.root, `flood-${i}.txt`), 'x');
    const replies = [];
    for (let batch = 0; batch < 8; batch++) {
      replies.push(...(await Promise.all(Array.from({ length: 20 }, (_, i) => hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, `flood-${(batch * 20 + i) % 40}.txt`)))))));
      expect(d.fakes.locks.agentLocksOf(s.sessionId).length).toBeLessThanOrEqual(1);
    }
    const reasons = replies.map(denyReasonOf);
    expect(reasons.filter((r) => r === HOOK_DENY_REASONS.rateLimited).length).toBeGreaterThan(0);
    expect(d.fakes.locks.agentLocksOf(s.sessionId).length).toBeLessThanOrEqual(1);
  });

  it('an oversized line is answered with too_large and the connection closed; the daemon keeps serving', async () => {
    const d = await setup();
    const s = registerAgent(d.hooks, HOST);
    const answer = await rawExchange(d.hooks.socketPath, `{"id":"big","token":"${s.token}","op":"hook","hookInput":{"x":"${'a'.repeat(HOOK_REQUEST_MAX_BYTES)}`);
    expect(JSON.parse(answer.text.trim())).toEqual({ id: null, error: { code: 'too_large', message: expect.any(String) } });
    expect(answer.closedByDaemon).toBe(true);
    expect((await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'free.txt'))))['hookOutput']).toBeNull();
  });

  it('garbage and invalid requests are refused and the connection closed', async () => {
    const d = await setup();
    const s = registerAgent(d.hooks, HOST);
    for (const line of ['not json', '[1,2]', '{"id":"x1","op":"hook"}', `{"id":"x2","token":"${s.token}","op":"shell","cmd":"id"}`, `{"id":"x3","token":"${s.token}","op":"hook","hookInput":{"hook_event_name":"PreToolUse","tool_input":{"file_path":7}}}`]) {
      const answer = await rawExchange(d.hooks.socketPath, `${line}\n`);
      const reply = JSON.parse(answer.text.trim()) as { id: string | null; error: { code: string } };
      expect(reply.error.code).toBe('bad_request');
      expect('hookOutput' in reply).toBe(false);
      expect(answer.closedByDaemon).toBe(true);
    }
    expect(d.fakes.locks.list()).toEqual([]);
  });

  it("the owner is no longer a member (kicked): the session's PreToolUse is denied", async () => {
    const d = await setup();
    await withAgentMember(d);
    const s = registerAgent(d.hooks, IAN);
    const hostPrincipal = d.t.ctx.members.principalOf(HOST.userId);
    if (!hostPrincipal) throw new Error('no host principal');
    d.t.ctx.members.kick(IAN.userId, hostPrincipal);
    expect(denyReasonOf(await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'free.txt'))))).toBe(HOOK_DENY_REASONS.ownerGone);
    expect(d.fakes.locks.list()).toEqual([]);
  });

  it('fails closed when the lock service is unavailable (stub): every PreToolUse is denied', async () => {
    extra = await createTestDaemon({ modules: [hooksModule], project: { files: { 'free.txt': 'x' } } });
    const hooks = extra.ctx.services.hooks as HookServerImpl;
    const s = registerAgent(hooks, HOST);
    const reply = await hookRequest(hooks.socketPath, s.token, pre(join(extra.root, 'free.txt')));
    expect(denyReasonOf(reply)).toBe(HOOK_DENY_REASONS.locksUnavailable);
    // Release events still answer (nothing to decide).
    expect((await hookRequest(hooks.socketPath, s.token, lifecycle('Stop')))['hookOutput']).toBeNull();
  });

  it('a session unregistered while its PreToolUse is being decided gets a deny, and the lock granted meanwhile is released', async () => {
    const d = await setup();
    const s = registerAgent(d.hooks, HOST);
    const paths = d.t.ctx.paths;
    const original = paths.toFileRef.bind(paths);
    paths.toFileRef = async (abs: string) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return original(abs);
    };
    try {
      const pending = hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'free.txt')));
      await new Promise((resolve) => setTimeout(resolve, 150));
      d.hooks.unregisterSession(s.sessionId);
      expect(denyReasonOf(await pending)).toBe(HOOK_DENY_REASONS.unknownSession);
      expect(d.fakes.locks.list()).toEqual([]);
    } finally {
      paths.toFileRef = original;
    }
  });

  it('a PreToolUse the daemon cannot decide in time is denied, and a lock granted afterwards is released', async () => {
    const d = await setup();
    const s = registerAgent(d.hooks, HOST);
    const paths = d.t.ctx.paths;
    const original = paths.toFileRef.bind(paths);
    paths.toFileRef = async (abs: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return original(abs);
    };
    try {
      const started = Date.now();
      const reply = await hookRequest(d.hooks.socketPath, s.token, pre(join(d.t.root, 'free.txt')));
      expect(denyReasonOf(reply)).toBe(HOOK_DENY_REASONS.timeout);
      expect(Date.now() - started).toBeLessThan(4_900);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(d.fakes.locks.list()).toEqual([]);
    } finally {
      paths.toFileRef = original;
    }
  }, 15_000);
});

// ARCHITECTURE §11 D-13: the Bash activity hook's events on the socket. A Bash window is a claim like everything else:
// it is always the token's own session, never a decision, paired by tool_use_id, bounded, rate-limited, and off with
// config.activity.attributeBashEdits.
describe('Bash activity events (D-13)', () => {
  const bashEvent = (event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure', toolUseId: string): Record<string, unknown> => ({ hook_event_name: event, tool_name: 'Bash', tool_use_id: toolUseId, cwd: '/tmp' });

  function bashWindows(d: HookDaemon): { readonly events: string[] } {
    const events: string[] = [];
    d.t.ctx.bus.on('agent.tool.pre', (e) => {
      if (e.tool === 'Bash') events.push(`start:${e.sessionId}:${e.file === null ? 'nofile' : 'file'}:${e.outcome}`);
    });
    d.t.ctx.bus.on('agent.tool.post', (e) => {
      if (e.tool === 'Bash') events.push(`end:${e.sessionId}:${e.file === null ? 'nofile' : 'file'}:${e.ok}`);
    });
    return { events };
  }

  it('a Bash Pre / Post opens and closes the TOKEN\'s session window; never a decision, even when the session is unknown or over budget', async () => {
    const d = await setup();
    await withAgentMember(d);
    const ian = registerAgent(d.hooks, IAN);
    const other = registerAgent(d.hooks, IAN);
    const w = bashWindows(d);
    expect((await hookRequest(d.hooks.socketPath, ian.token, bashEvent('PreToolUse', 'tu_1')))['hookOutput']).toBeNull();
    expect((await hookRequest(d.hooks.socketPath, ian.token, bashEvent('PostToolUse', 'tu_1')))['hookOutput']).toBeNull();
    // Another session's tool_use_id cannot close this one's window, and a Post without its Pre does nothing.
    await hookRequest(d.hooks.socketPath, ian.token, bashEvent('PreToolUse', 'tu_2'));
    await hookRequest(d.hooks.socketPath, other.token, bashEvent('PostToolUse', 'tu_2'));
    await hookRequest(d.hooks.socketPath, ian.token, bashEvent('PostToolUseFailure', 'tu_2'));
    await hookRequest(d.hooks.socketPath, ian.token, bashEvent('PostToolUse', 'never-opened'));
    expect(w.events).toEqual([`start:${ian.sessionId}:nofile:granted`, `end:${ian.sessionId}:nofile:true`, `start:${ian.sessionId}:nofile:granted`, `end:${ian.sessionId}:nofile:false`]);
    // No lock is ever taken for a Bash window.
    expect(d.fakes.locks.list()).toEqual([]);
    // An unknown token gets no window and no decision the Bash hook could print (it ignores replies anyway).
    const before = w.events.length;
    await hookRequest(d.hooks.socketPath, 'x'.repeat(43), bashEvent('PreToolUse', 'tu_3')).catch(() => ({}));
    expect(w.events.length).toBe(before);
  });

  it('Stop, UserPromptSubmit, SessionEnd and the end of the session close every open window of that session only', async () => {
    const d = await setup();
    await withAgentMember(d);
    const ian = registerAgent(d.hooks, IAN);
    const other = registerAgent(d.hooks, IAN);
    const w = bashWindows(d);
    for (const [event, count] of [[lifecycle('Stop'), 2], [lifecycle('UserPromptSubmit'), 1], [lifecycle('SessionEnd'), 1]] as const) {
      w.events.length = 0;
      for (let i = 0; i < count; i++) await hookRequest(d.hooks.socketPath, ian.token, bashEvent('PreToolUse', `tu_${event['hook_event_name']}_${i}`));
      await hookRequest(d.hooks.socketPath, other.token, bashEvent('PreToolUse', `tu_other_${event['hook_event_name']}`));
      await hookRequest(d.hooks.socketPath, ian.token, event);
      expect(w.events.filter((e) => e.startsWith('end:'))).toEqual(Array.from({ length: count }, () => `end:${ian.sessionId}:nofile:false`));
    }
    w.events.length = 0;
    d.hooks.unregisterSession(other.sessionId);
    expect(w.events).toEqual([`end:${other.sessionId}:nofile:false`, `end:${other.sessionId}:nofile:false`, `end:${other.sessionId}:nofile:false`]);
  });

  it('a flood of forged Bash events is bounded: at most 8 open windows per session, and the per-session budget (burst 60) — the rest are ignored', async () => {
    const d = await setup();
    await withAgentMember(d);
    const ian = registerAgent(d.hooks, IAN);
    const w = bashWindows(d);
    for (let i = 0; i < 20; i++) await hookRequest(d.hooks.socketPath, ian.token, bashEvent('PreToolUse', `open_${i}`));
    expect(w.events.filter((e) => e.startsWith('start:'))).toHaveLength(8);
    w.events.length = 0;
    // Pairs that open and close: beyond the burst nothing more is recorded.
    for (let i = 0; i < 60; i++) {
      await hookRequest(d.hooks.socketPath, ian.token, bashEvent('PostToolUse', `open_${i % 8}`));
      await hookRequest(d.hooks.socketPath, ian.token, bashEvent('PreToolUse', `open_${i % 8}`));
    }
    expect(w.events.length).toBeLessThan(60);
    expect(w.events.length).toBeGreaterThan(0);
  });

  it('config.activity.attributeBashEdits false: Bash events are ignored (and the Bash hook is not even registered, settings-writer.test.ts)', async () => {
    const d = await setup();
    const off = new HookServerImpl({ ...d.t.ctx, config: { ...d.t.ctx.config, runPaths: { ...d.t.ctx.config.runPaths, hook: `${d.t.ctx.config.runPaths.hook}2` }, activity: { attributeBashEdits: false } } });
    await off.start();
    try {
      await withAgentMember(d);
      const ian = registerAgent(off, IAN);
      const w = bashWindows(d);
      expect((await hookRequest(off.socketPath, ian.token, bashEvent('PreToolUse', 'tu_off')))['hookOutput']).toBeNull();
      expect(w.events).toEqual([]);
    } finally {
      await off.stop();
    }
  });
});
