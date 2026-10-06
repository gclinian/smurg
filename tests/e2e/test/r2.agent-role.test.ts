// SPEC R2 roles / ARCHITECTURE §11 D-15 (owner decision 2026-10-01): the role Agent access ('agent'), through the real
// relay, the real daemon with every production module and SDK clients. There is no guest sandbox any more:
//  - an agent member opens a terminal session: they own it, and it runs exactly like the host's own (the host's OS user,
//    the host's HOME: here the stack's fake home);
//  - `session.drive`: the host types into the agent member's session, the agent member types into the host's;
//  - an editor can neither type into a session nor open one: forbidden, audited authz.denied, nothing reaches the PTY;
//  - kicking the agent member ends the session they opened within R2's 3 s (endReason 'kicked'), audited
//    session.terminate by the system with the reason.
import { isStubService } from '@smurg/daemon';
import type { SessionInfo } from '@smurg/protocol';
import type { Connection } from '@smurg/protocol/client';
import { startLocalRelay, type LocalRelay } from '@smurg/relay/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startStack, waitUntil } from '../src/harness.ts';

/** SPEC R2: a kicked user loses all access within 3 s (their sessions included). */
const KICK_DEADLINE_MS = 3_000;

let relay: LocalRelay;
let savedShell: string | undefined;

beforeAll(async () => {
  relay = await startLocalRelay({ tap: false });
});

afterAll(async () => {
  await relay?.stop();
});

// Every session starts the host's $SHELL (§11 D-15): a plain POSIX shell whatever the developer uses.
beforeEach(() => {
  savedShell = process.env['SHELL'];
  process.env['SHELL'] = '/bin/sh';
});

afterEach(() => {
  if (savedShell === undefined) delete process.env['SHELL'];
  else process.env['SHELL'] = savedShell;
});

/** Everything a session printed to `conn` from its attach on (snapshot included). */
async function watchOutput(conn: Connection, sessionId: string): Promise<() => string> {
  const chunks: Buffer[] = [];
  conn.on('exec.output', (payload) => {
    if (payload.sessionId === sessionId) chunks.push(Buffer.from(payload.data));
  });
  const attached = await conn.request('session.attach', { sessionId });
  chunks.unshift(Buffer.from(attached.data));
  return () => Buffer.concat(chunks).toString('utf8');
}

function typeLine(conn: Connection, sessionId: string, line: string): void {
  expect(conn.notify('exec.input', { sessionId, data: new TextEncoder().encode(`${line}\r`) })).toBe(true);
}

describe('R2 the role Agent access (§11 D-15)', () => {
  it('an agent member\'s session runs as the host; the host and the agent member drive each other\'s sessions; an editor may not; a kick ends it', async () => {
    const stack = await startStack({ relay });
    try {
      // A composition without the real sessions module fails here instead of skipping.
      expect(isStubService(stack.daemon.ctx.services.sessions), 'the default composition provides SessionManager').toBe(false);
      const host = stack.hostClient.conn;
      const ada = await stack.join({ name: 'ada', role: 'agent' });
      const amy = await stack.join({ name: 'amy', role: 'editor' });
      expect(ada.welcome?.member.role).toBe('agent');

      // 1. Ada opens a terminal: she owns it, and nothing marks it as anything but the host's own kind of session.
      const { session } = await ada.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 200, rows: 30 });
      expect(session).toMatchObject({ kind: 'terminal', openedBy: { userId: ada.userId, displayName: 'Ada' }, root: { kind: 'main' }, status: 'running' });
      // Nobody typed a title: none travels (each client builds the default from the kind and the opener, in its own language).
      expect(session).not.toHaveProperty('title');
      expect(session).not.toHaveProperty('sandboxed');
      const atHost = await watchOutput(host, session.id);
      const atAda = await watchOutput(ada.conn, session.id);

      // 2. It runs as the host: the host's OS user, the host's HOME (the stack's fake home, config.sessions.hostHome).
      const uid = process.getuid?.() ?? -1;
      typeLine(ada.conn, session.id, `printf 'ada-runs-as:%s:%s\\n' "$HOME" "$(id -u)"`);
      await waitUntil(() => atAda().includes(`ada-runs-as:${stack.homeDir}:${uid}\r\n`), 15_000, 'Ada\'s command to print the host\'s HOME and uid');

      // 3. An editor's keys are refused by the daemon (the SDK sends them; hiding the input is the UI's job).
      const amyErrors: string[] = [];
      amy.conn.on('error', (payload) => amyErrors.push(payload.code));
      typeLine(amy.conn, session.id, `printf 'amy-typed:%s\\n' "$((2+3))"`);
      await waitUntil(() => amyErrors.length > 0, 10_000, 'the daemon to refuse Amy\'s keys');
      expect(amyErrors).toEqual(['forbidden']);
      // …and she cannot open a session of her own either.
      await expect(amy.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'forbidden' });

      // 4. session.drive: the host types into Ada's session (after Amy's refused keys: they never ran).
      typeLine(host, session.id, `printf 'host-typed:%s\\n' "$((6*7))"`);
      await waitUntil(() => atHost().includes('host-typed:42\r\n') && atAda().includes('host-typed:42\r\n'), 15_000, 'the host\'s command in Ada\'s session');
      expect(atHost()).not.toContain('amy-typed:5');

      // …and Ada types into a session the host opened.
      const { session: hostTerminal } = await host.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 200, rows: 30 });
      const hostOwn = await watchOutput(host, hostTerminal.id);
      typeLine(ada.conn, hostTerminal.id, `printf 'ada-in-host-session:%s\\n' "$((3*3))"`);
      await waitUntil(() => hostOwn().includes('ada-in-host-session:9\r\n'), 15_000, 'Ada\'s command in the host\'s session');

      // 5. The host kicks Ada: the session she opened ends within 3 s, the host's session runs on.
      const t0 = Date.now();
      await host.request('admin.member.kick', { userId: ada.userId });
      let ended: SessionInfo | undefined;
      await waitUntil(
        async () => {
          ended = (await host.request('session.list', {})).sessions.find((s) => s.id === session.id);
          return ended?.status === 'exited';
        },
        KICK_DEADLINE_MS,
        'the kicked agent member\'s session to end',
      );
      console.info(`[R2] kick: the agent member's session ended after ${Date.now() - t0} ms`);
      expect(ended).toMatchObject({ status: 'exited', endReason: 'kicked', openedBy: { userId: ada.userId } });
      expect(ended).not.toHaveProperty('endedBy');
      expect((await host.request('session.list', {})).sessions.find((s) => s.id === hostTerminal.id)?.status).toBe('running');

      // 6. The audit log: who opened it, the editor's refusals, and the system ending it for the kick.
      await stack.daemon.ctx.audit.flush();
      const entries = await stack.audit();
      expect(entries.find((e) => e.action === 'session.create' && e.target === session.id)).toMatchObject({
        actor: { kind: 'user', userId: ada.userId },
        outcome: 'ok',
        detail: { sessionId: session.id, kind: 'terminal', root: 'main' },
      });
      const denied = (target: string) =>
        entries.find((e) => e.action === 'authz.denied' && e.outcome === 'denied' && e.actor.kind === 'user' && e.actor.userId === amy.userId && e.target === target);
      expect(denied('exec.input')).toMatchObject({ detail: { type: 'exec.input', reason: 'capability', role: 'editor' } });
      expect(denied('session.create')).toMatchObject({ detail: { type: 'session.create', reason: 'capability', role: 'editor' } });
      const terminated = entries.filter((e) => e.action === 'session.terminate' && e.target === session.id);
      expect(terminated).toHaveLength(1);
      expect(terminated[0]).toMatchObject({ actor: { kind: 'system' }, outcome: 'ok', detail: { sessionId: session.id, openedBy: ada.userId, kind: 'terminal', reason: 'kicked' } });
      expect(entries.some((e) => e.action === 'session.terminate' && e.target === hostTerminal.id)).toBe(false);
    } finally {
      await stack.stop();
    }
  });
});
