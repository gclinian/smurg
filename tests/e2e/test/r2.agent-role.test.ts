// SPEC R2 roles / ARCHITECTURE §11 D-15 (owner decision 2026-10-01): the role Agent access ('agent'), through the real
// relay, the real daemon with every production module and SDK clients. There is no guest sandbox any more.
//
// Terminals (the first test):
//  - an agent member opens a terminal session: they own it, and it runs exactly like the host's own (the host's OS user,
//    the host's HOME: here the stack's fake home);
//  - `session.drive`: the host types into the agent member's session, the agent member types into the host's;
//  - an editor can neither type into a session nor open one: forbidden, audited authz.denied, nothing reaches the PTY;
//  - kicking the agent member ends the session they opened within R2's 3 s (endReason 'kicked'), audited
//    session.terminate by the system with the reason.
//
// Agent sessions, protocol 4 (the second test; ARCHITECTURE §5.9): the same role over a conversation instead of a PTY.
// The `claude` every session of this file starts is the scripted stand-in (`startStack({ claude })`), never a Claude
// Code of this computer:
//  - an agent member opens an agent session: the host's `claude`, as the host's user and HOME, named after her;
//  - `session.drive`: she and the host send messages to each other's sessions and answer their permission requests;
//  - an Editor's message is a SUGGESTION: a card for everyone, and a message to the agent only when a member with
//    agent access accepts it, under the Editor's name; her own `session.message.send` is forbidden and audited;
//  - a Viewer watches: the same conversation as the host, and nothing that would change it;
//  - kicking the agent member ends her free agent session within 3 s, its process included.
import { isStubService } from '@smurg/daemon';
import type { AgentSession, ConversationEvent, SessionInfo } from '@smurg/protocol';
import type { Connection } from '@smurg/protocol/client';
import { startLocalRelay, type LocalRelay } from '@smurg/relay/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audited, eventOf, everythingAgentsReceived, inboxItem, kinds, launches, member, permissionAt, refusal, sessionReady, statusIs, suggestionAt, told, turnsFinished } from '../src/flow.ts';
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
  it('an agent member opens an agent session of the host\'s claude and messages it; she and the host act on each other\'s sessions; an editor\'s message is a suggestion; a viewer watches; a kick ends it', async () => {
    // (Not a read-only command: like Claude Code, the stand-in asks before it runs one in a session that asks for everything.)
    const RUNS_AS = `test -n "$HOME" && printf 'runs-as:%s:%s\\n' "$HOME" "$(id -u)"`;
    const stack = await startStack({
      relay,
      claude: {
        turns: [
          { match: 'who you run as', steps: [{ text: 'I will look.' }, { tool: 'Bash', input: { command: RUNS_AS }, run: true }, { text: 'That is who I run as.' }] },
          { match: 'clean up', steps: [{ tool: 'Bash', input: { command: 'rm -rf build' } }, { text: 'never said' }] },
          { steps: [{ text: 'ok' }] },
        ],
      },
    });
    try {
      const claude = stack.claude!;
      const host = member(stack.hostClient, 'Host', 'host');
      const ada = member(await stack.join({ name: 'ada', role: 'agent' }), 'Ada', 'agent');
      const amy = member(await stack.join({ name: 'amy', role: 'editor' }), 'Amy', 'editor');
      const vic = member(await stack.join({ name: 'vic', role: 'viewer' }), 'Vic', 'viewer');
      const everyone = [host, ada, amy, vic];
      // The `claude` of this stack is the stand-in, by its path: nothing is looked up on PATH.
      expect(stack.daemon.config.sessions.claudePath).toBe(claude.path);

      // 1. Ada opens an agent session: hers by `openedBy`, a session without a topic like the host's own would be.
      //    An Editor and a Viewer cannot open one.
      const { session } = await ada.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, title: 'Tests' });
      expect(session).toMatchObject({ kind: 'agent', purpose: 'free', title: 'Tests', openedBy: { userId: ada.userId, displayName: 'Ada' }, root: { kind: 'main' }, responsible: null, permissionMode: 'ask-all' });
      for (const other of [amy, vic]) expect(await refusal(other.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' } }))).toMatchObject({ code: 'forbidden' });
      await sessionReady(host, session.id);
      for (const one of everyone) await one.watch(session.id);

      // 2. She messages it. Its command asks first: the card is at every watcher, the request in the inbox of who may
      //    allow (nobody is responsible: Ada and the host). An Editor and a Viewer cannot answer it.
      await ada.conn.request('session.message.send', { sessionId: session.id, text: 'Please say who you run as.' });
      const asked = await permissionAt(vic, (request) => request.sessionId === session.id && request.status === 'open', 'the permission card');
      expect(asked).toMatchObject({ tool: 'Bash', what: 'command', command: RUNS_AS });
      for (const one of everyone) await permissionAt(one, (request) => request.id === asked.id, 'the permission card');
      expect(await inboxItem(ada, (item) => item.key === `permission:${asked.id}`, 'the request')).toMatchObject({ kind: 'permission', sessionId: session.id, alsoFor: [{ userId: host.userId }] });
      expect(await inboxItem(host, (item) => item.key === `permission:${asked.id}`, 'the request')).toMatchObject({ alsoFor: [{ userId: ada.userId }] });
      expect(await amy.inbox()).toEqual([]);
      for (const other of [amy, vic]) expect(await refusal(other.conn.request('permission.decide', { requestId: asked.id, decision: 'allow' }))).toMatchObject({ code: 'forbidden' });
      expect((await ada.conn.request('permission.decide', { requestId: asked.id, decision: 'allow' })).request).toMatchObject({ status: 'allowed', decision: { by: { userId: ada.userId } } });
      await turnsFinished(vic, session.id, 1);
      await statusIs(vic, session.id, 'idle');

      // 3. It runs as the host: the host's OS user and the host's HOME (the stack's fake home), whoever opened it; the
      //    agent is named after the member who opened the session, and the agent was told who wrote.
      const uid = process.getuid?.() ?? -1;
      const ran = await eventOf<Extract<ConversationEvent, { kind: 'tool.finished' }>>(vic, session.id, (event) => event.kind === 'tool.finished', 'the result of the command');
      expect(ran.ok).toBe(true);
      expect(JSON.stringify(ran.result)).toContain(`runs-as:${stack.homeDir}:${uid}`);
      expect(await told(claude, session.id)).toEqual(['[Ada · Agent access]\nPlease say who you run as.']);
      const command = (await audited(host.conn, 'agent.command')).find((entry) => entry.target === session.id);
      expect(command).toMatchObject({ actor: { kind: 'agent', sessionId: session.id, ownerUserId: ada.userId, displayName: 'Claude (Ada)' }, detail: { verb: 'run', command: RUNS_AS } });
      // Every process an agent session of this stack runs is the stand-in.
      const processes = await stack.agentProcesses();
      expect(processes.length).toBeGreaterThan(0);
      for (const line of processes) expect(line).toContain('fake-claude.mjs');

      // 4. session.drive goes both ways: the host messages Ada's session, Ada messages a session the host opened.
      await host.conn.request('session.message.send', { sessionId: session.id, text: 'Thank you.' });
      await turnsFinished(vic, session.id, 2);
      const { session: hostSession } = await host.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, title: 'Notes' });
      await sessionReady(host, hostSession.id);
      for (const one of everyone) await one.watch(hostSession.id);
      await ada.conn.request('session.message.send', { sessionId: hostSession.id, text: 'Hello from Ada.' });
      await turnsFinished(vic, hostSession.id, 1);
      expect(await told(claude, session.id)).toEqual(['[Ada · Agent access]\nPlease say who you run as.', '[Host · Host]\nThank you.']);
      expect(await told(claude, hostSession.id)).toEqual(['[Ada · Agent access]\nHello from Ada.']);
      expect(vic.events(hostSession.id).find((event) => event.kind === 'message')).toMatchObject({ from: { userId: ada.userId, displayName: 'Ada', role: 'agent' }, text: 'Hello from Ada.' });

      // 5. An Editor's message is a suggestion. Her own send is forbidden; what she suggests is a card for everyone and
      //    reaches the agent only when a member with agent access accepts it: then under HER name.
      expect(await refusal(amy.conn.request('session.message.send', { sessionId: session.id, text: 'Run the linter too.' }))).toMatchObject({ code: 'forbidden' });
      const { suggestion } = await amy.conn.request('suggest.create', { sessionId: session.id, text: 'Please run the linter too.' });
      expect(suggestion).toMatchObject({ sessionId: session.id, status: 'pending', author: { userId: amy.userId, displayName: 'Amy' } });
      for (const one of everyone) await suggestionAt(one, (held) => held.id === suggestion.id && held.status === 'pending', 'the suggestion card');
      expect(await everythingAgentsReceived(claude)).not.toContain('linter');
      for (const other of [amy, vic]) expect(await refusal(other.conn.request('suggest.accept', { suggestionId: suggestion.id }))).toMatchObject({ code: 'forbidden' });
      expect((await ada.conn.request('suggest.accept', { suggestionId: suggestion.id })).suggestion).toMatchObject({ status: 'accepted', decidedBy: { userId: ada.userId } });
      await turnsFinished(vic, session.id, 3);
      await statusIs(vic, session.id, 'idle');
      expect((await told(claude, session.id)).at(-1)).toBe('[Amy · Editor, suggestion accepted by Ada]\nPlease run the linter too.');
      expect(vic.events(session.id).findLast((event) => event.kind === 'message')).toMatchObject({ from: { userId: amy.userId, role: 'editor' }, text: 'Please run the linter too.', suggestion: { id: suggestion.id, acceptedBy: { userId: ada.userId } } });

      // 6. The Viewer watched all of it: the conversation the host holds, event for event; and he can change nothing.
      await waitUntil(() => JSON.stringify(vic.events(session.id)) === JSON.stringify(host.events(session.id)), 10_000, 'the Viewer to hold the conversation the host holds');
      expect(kinds(vic.events(session.id)).filter((kind) => kind === 'message' || kind.startsWith('card:'))).toEqual(['message', 'card:permission', 'message', 'card:suggestion', 'message']);
      for (const attempt of [
        vic.conn.request('session.message.send', { sessionId: session.id, text: 'me too' }),
        vic.conn.request('suggest.create', { sessionId: session.id, text: 'me too' }),
        vic.conn.request('session.interrupt', { sessionId: session.id }),
        vic.conn.request('session.rename', { sessionId: session.id, title: 'Mine' }),
        vic.conn.request('session.end', { sessionId: session.id }),
      ]) {
        expect(await refusal(attempt)).toMatchObject({ code: 'forbidden' });
      }

      // 7. The host kicks Ada while her session waits for a person: the session she opened ends within 3 s, its
      //    process too; the host's own session stays.
      await ada.conn.request('session.message.send', { sessionId: session.id, text: 'Please clean up.' });
      const waiting = await permissionAt(vic, (request) => request.sessionId === session.id && request.status === 'open', 'the request of the turn that the kick ends');
      const hex = Buffer.from(session.id, 'utf8').toString('hex');
      expect((await stack.agentProcesses()).some((line) => line.includes(hex))).toBe(true);
      const launched = await launches(claude);
      const t0 = Date.now();
      await host.conn.request('admin.member.kick', { userId: ada.userId });
      await waitUntil(() => (vic.session(session.id) as AgentSession | undefined)?.status === 'ended', KICK_DEADLINE_MS, 'the kicked agent member\'s agent session to end');
      console.info(`[R2] kick: the agent member's agent session ended after ${Date.now() - t0} ms`);
      expect(vic.session(session.id)).toMatchObject({ status: 'ended', endReason: 'kicked', openedBy: { userId: ada.userId } });
      await waitUntil(async () => !(await stack.agentProcesses()).some((line) => line.includes(hex)), KICK_DEADLINE_MS, 'its process to be gone');
      expect((await host.conn.request('session.list', {})).sessions.find((s) => s.id === hostSession.id)).toMatchObject({ status: 'idle' });
      expect(await launches(claude)).toBe(launched);
      // The command it waited for never ran: its card is withdrawn at every watcher, the call ended refused, the turn ended.
      for (const one of [host, amy, vic]) expect(await permissionAt(one, (request) => request.id === waiting.id && request.status === 'withdrawn', 'the withdrawn card')).toMatchObject({ withdrawn: { reason: 'ended' } });
      await waitUntil(() => vic.events(session.id).findLast((event) => event.kind === 'turn.finished')?.turnId === vic.events(session.id).findLast((event) => event.kind === 'turn.started')?.turnId, 10_000, 'the end of the last turn');
      expect(vic.events(session.id).findLast((event) => event.kind === 'tool.finished')).toMatchObject({ ok: false });
      expect(vic.events(session.id).findLast((event) => event.kind === 'turn.finished')).toMatchObject({ outcome: 'interrupted' });
      expect(await refusal(host.conn.request('session.message.send', { sessionId: session.id, text: 'Are you there?' }))).toMatchObject({ code: 'conflict' });

      // 8. The audit log: who opened it, whose messages reached the agent, the Editor's refusal, the end by the kick.
      const entries = await audited(host.conn);
      expect(entries.find((e) => e.action === 'session.create' && e.target === session.id)).toMatchObject({ actor: { kind: 'user', userId: ada.userId }, outcome: 'ok', detail: { sessionId: session.id, kind: 'agent' } });
      expect(entries.filter((e) => e.action === 'session.message' && e.target === session.id).map((e) => (e.actor.kind === 'user' ? e.actor.userId : e.actor.kind))).toEqual([ada.userId, host.userId, amy.userId, ada.userId]);
      expect(entries.find((e) => e.action === 'authz.denied' && e.target === 'session.message.send' && e.actor.kind === 'user' && e.actor.userId === amy.userId)).toMatchObject({ outcome: 'denied', detail: { type: 'session.message.send', reason: 'capability', role: 'editor' } });
      expect(entries.find((e) => e.action === 'suggest.accept' && e.target === suggestion.id)).toMatchObject({ actor: { kind: 'user', userId: ada.userId }, detail: { authorUserId: amy.userId } });
      const terminated = entries.filter((e) => e.action === 'session.terminate' && e.target === session.id);
      expect(terminated).toHaveLength(1);
      expect(terminated[0]).toMatchObject({ actor: { kind: 'system' }, outcome: 'ok', detail: { sessionId: session.id, openedBy: ada.userId, kind: 'agent', reason: 'kicked' } });
      expect(entries.some((e) => e.action === 'session.terminate' && e.target === hostSession.id)).toBe(false);
    } finally {
      await stack.stop();
    }
  });
});
