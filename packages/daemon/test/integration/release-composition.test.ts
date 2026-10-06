// The release composition lives (DESIGN §9.3 P12; the module list of src/daemon.ts). createTestDaemon without
// `modules` composes DEFAULT_FEATURE_MODULES, exactly what `smurg host` runs, and NOTHING is faked: every service is
// its module's, the hook command and the MCP command of the session are the real `smurg hook` / `smurg mcp` (node +
// the CLI's sources), the clients are the real SDK over real Noise channels. The one stand-in is the `claude`
// executable itself (src/testing/fake-claude.mjs: the same control protocol, a script instead of a model, no network).
//
// One small story, end to end: the host opens a free agent session and sends a message; the agent wants to write a
// file; the permission card reaches the decider and is in their inbox; allowed, the agent writes it through the real
// tool gate and finishes its turn; the transcript reads back; the daemon stops and starts again and the session is
// still readable. The whole flow (questions, suggestions, topics, plans, reports, merges) is
// tests/e2e t.topic-flow and the daemon-level tests next to this one.
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type ConversationEvent } from '@smurg/protocol';
import { FEATURE_SERVICE_NAMES } from '../../src/core/interfaces.ts';
import { isStubService } from '../../src/core/stubs.ts';
import { DEFAULT_FEATURE_MODULES } from '../../src/daemon.ts';
import {
  createTempDir,
  createTempProject,
  createTempRunDir,
  createTestDaemon,
  installFakeClaude,
  removeTempDir,
  removeTempRunDir,
  waitFor,
  type FakeClaude,
  type TestDaemon,
} from '../../src/testing/index.ts';
import { CLI_MAIN, recorder } from './support.ts';

const execFileAsync = promisify(execFile);

const HOST = 'dev:host';
const AMY = 'dev:amy';
const NOTE = 'notes/agent.md';
const CONTENT = 'The tests pass.\n';
const MESSAGE = 'Please note the result of the tests.';

let t: TestDaemon | null = null;
const dirs: { temp: string[]; run: string[] } = { temp: [], run: [] };

afterEach(async () => {
  try {
    await t?.cleanup();
  } finally {
    t = null;
    for (const dir of dirs.temp.splice(0)) await removeTempDir(dir);
    for (const dir of dirs.run.splice(0)) await removeTempRunDir(dir);
  }
});

interface Stack {
  readonly claude: FakeClaude;
  readonly root: string;
  /** The daemon's state directory: the launch files of a session (and so its process's arguments) are under it. */
  readonly stateDir: string;
  /** Starts (or starts again) the daemon on the same folder, state and home: what a restart of `smurg host` is. */
  start(): Promise<TestDaemon>;
}

/** A shared folder, a state directory and a host home that outlive one daemon, and the stand-in `claude`. */
async function stack(): Promise<Stack> {
  const base = await createTempDir('release-composition');
  dirs.temp.push(base);
  const stateDir = await createTempRunDir();
  dirs.run.push(stateDir);
  const root = await createTempProject(base, 'project', { files: { 'README.md': '# Checkout\n' } });
  // The host's home: where the stand-in (like Claude Code) keeps its conversations. The same across the restart.
  const hostHome = join(base, 'home');
  await mkdir(hostHome, { recursive: true });
  const claude = await installFakeClaude(join(base));
  const workspaceId = `ws_test_release_${Math.random().toString(36).slice(2, 10)}`;
  return {
    claude,
    root,
    stateDir,
    start: async () => {
      t = await createTestDaemon({
        root,
        stateDir,
        workspaceId,
        // No `modules`: the default, i.e. the release composition.
        sessions: { claudePath: claude.path, hostHome, selfCommand: { file: process.execPath, args: [CLI_MAIN] } },
      });
      return t;
    },
  };
}

/** The command lines of the processes that were started with a file of this daemon's state directory (agent sessions). */
async function processesOf(stateDir: string): Promise<string[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'command='], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split('\n').filter((line) => line.includes(stateDir));
}

const kinds = (events: readonly ConversationEvent[]): string[] => events.map((event) => (event.kind === 'card' ? `card:${event.card}` : event.kind));

describe('the release composition (DEFAULT_FEATURE_MODULES with the stand-in claude, nothing faked)', { timeout: 120_000 }, () => {
  it('a free agent session end to end: message, permission card at the decider and in the inbox, allowed, the turn finishes, the transcript reads back, also after a restart', async () => {
    const s = await stack();
    await s.claude.setScenario({
      turns: [
        {
          steps: [
            { text: 'I will write down what I found.' },
            // An edit in a main-workspace session asks first (ask-all): the stand-in raises the permission request
            // and waits. Allowed, it runs the real PreToolUse / PostToolUse hook commands (the tool gate, the agent
            // lock) around a real write.
            { tool: 'Write', input: { file_path: NOTE, content: CONTENT } },
            { text: 'Done: see notes/agent.md.' },
          ],
        },
      ],
    });
    let d = await s.start();

    // ---- the daemon runs what production composes: every module, every service slot real
    expect(DEFAULT_FEATURE_MODULES.map((module) => module.name)).toEqual(['locks', 'hooks', 'files', 'docs', 'worktree', 'sessions', 'conversation', 'suggest', 'topics', 'inbox', 'local']);
    expect(FEATURE_SERVICE_NAMES.filter((name) => isStubService(d.ctx.services[name]))).toEqual([]);
    expect(d.ctx.lifecycle.status()).toMatchObject({ started: true, stopped: false, agents: { running: 0, waiting: 0, stalled: 0, idle: 0 }, topics: { total: 0, paused: 0 } });
    expect(d.ctx.lifecycle.status().claude).toBeUndefined();

    // ---- the host opens a free agent session; Amy (an Editor) watches it too
    const host = await d.connectHost();
    const amy = await d.connect({ userId: AMY, displayName: 'Amy', role: 'editor' });
    const hostEvents = recorder(host.conn, 'session.events');
    const amyEvents = recorder(amy.conn, 'session.events');
    const hostCards = recorder(host.conn, 'permission.updated');
    const amyCards = recorder(amy.conn, 'permission.updated');
    const hostInbox = recorder(host.conn, 'inbox.changed');
    const amyInbox = recorder(amy.conn, 'inbox.changed');
    const { session } = await host.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, title: 'Tests' });
    expect(session).toMatchObject({ kind: 'agent', purpose: 'free', title: 'Tests', openedBy: { userId: HOST }, permissionMode: 'ask-all' });
    const sessionId = session.id;
    await waitFor(() => d.ctx.services.agents.get(sessionId)?.status === 'idle', { timeoutMs: 20_000, what: 'the agent session to be ready' });
    // Claude Code as the runtime found it at this first start: `smurg status` has its line now.
    expect(d.ctx.lifecycle.status()).toMatchObject({ claude: { version: '2.1.288', verdict: 'verified', login: 'logged-in' }, agents: { idle: 1 } });
    await host.conn.request('session.watch', { sessionId });
    await amy.conn.request('session.watch', { sessionId });

    // ---- a message; the agent's edit needs permission
    const { messageId } = await host.conn.request('session.message.send', { sessionId, text: MESSAGE });
    await waitFor(() => hostCards.some((update) => update.request.status === 'open'), { timeoutMs: 20_000, what: 'the permission card at the decider' });
    const card = hostCards.find((update) => update.request.status === 'open')?.request;
    expect(card).toMatchObject({ sessionId, status: 'open', tool: 'Write', what: 'edit', file: { root: MAIN_ROOT, path: NOTE } });
    const requestId = card?.id as string;
    // Everyone who watches sees the card; it waits in the inbox of who may decide it (nobody is responsible: the
    // members with agent access, here the host alone), not in a watcher's.
    await waitFor(() => amyCards.some((update) => update.request.id === requestId), { what: 'the card at the other watcher' });
    const key = `permission:${requestId}`;
    await waitFor(() => hostInbox.some((change) => change.upsert.some((item) => item.key === key)), { what: 'the permission request in the host\'s inbox' });
    expect((await host.conn.request('inbox.list', {})).items).toMatchObject([{ key, kind: 'permission', sessionId, unread: true }]);
    expect((await amy.conn.request('inbox.list', {})).items).toEqual([]);
    expect(amyInbox.flatMap((change) => change.upsert)).toEqual([]);
    expect(d.ctx.services.agents.get(sessionId)?.status).toBe('waiting-permission');
    expect(d.ctx.lifecycle.status()).toMatchObject({ agents: { waiting: 1 } });
    // Nothing ran yet: the file is not there.
    await expect(readFile(join(s.root, NOTE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // ---- allowed: the turn goes on and finishes
    const decided = await host.conn.request('permission.decide', { requestId, decision: 'allow' });
    expect(decided.request).toMatchObject({ id: requestId, status: 'allowed', decision: { by: { userId: HOST } } });
    await waitFor(() => hostEvents.flatMap((batch) => batch.events).some((event) => event.kind === 'turn.finished'), { timeoutMs: 30_000, what: 'the end of the turn' });
    await waitFor(() => d.ctx.services.agents.get(sessionId)?.status === 'idle', { what: 'the session idle again' });
    await waitFor(() => hostInbox.some((change) => change.remove.includes(key)), { what: 'the request leaving the inbox' });
    expect((await host.conn.request('inbox.list', {})).items).toEqual([]);
    // The agent's edit is on disk, made through the real hook command (tool gate, agent lock, activity).
    expect(await readFile(join(s.root, NOTE), 'utf8')).toBe(CONTENT);
    const activity = (await host.conn.request('activity.list', {})).events;
    expect(activity.find((event) => event.file?.path === NOTE)).toMatchObject({ actor: { kind: 'agent', sessionId, ownerUserId: HOST }, file: { root: MAIN_ROOT, path: NOTE } });

    // What it left in the audit log, by whom (oldest first). The edit is recorded when the file watcher has seen it,
    // which may be before or after the end of the turn released the lock.
    const audited = (await host.conn.request('admin.audit.query', { limit: 200 })).entries.reverse();
    const mine = audited.filter((entry) => ['session.create', 'session.message', 'lock.acquire', 'permission.decide', 'agent.edit', 'lock.release'].includes(entry.action));
    const told = mine.map((entry) => `${entry.action} ${entry.outcome} ${entry.actor.kind}`);
    expect(told.slice(0, 4)).toEqual(['session.create ok user', 'session.message ok user', 'lock.acquire ok agent', 'permission.decide ok user']);
    expect(told.slice(4).sort()).toEqual(['agent.edit ok agent', 'lock.release ok agent']);
    // The turn is over: the agent's lock is gone (its Stop hook reached the daemon).
    expect((await host.conn.request('lock.list', {})).locks).toEqual([]);

    // ---- the transcript reads back: the live stream and a fresh page say the same
    const live = hostEvents.flatMap((batch) => batch.events);
    expect(kinds(live)).toEqual(['message', 'delivery', 'turn.started', 'text', 'tool.started', 'card:permission', 'tool.finished', 'text', 'turn.finished', 'delivery']);
    expect(amyEvents.flatMap((batch) => batch.events)).toEqual(live);
    const page = await amy.conn.request('session.watch', { sessionId });
    expect(page).toMatchObject({ firstSeq: 1, nextSeq: 12, hasEarlier: false, hasMore: false, questions: [], suggestions: [] });
    // (the opening line was written before anyone watched)
    expect(kinds(page.events)).toEqual(['line', ...kinds(live)]);
    expect(page.events.slice(1)).toEqual(live);
    expect(page.events).toMatchObject([
      { seq: 1, kind: 'line', text: { id: 'conversation.started.free', params: { name: 'Host' } } },
      { seq: 2, kind: 'message', messageId, from: { userId: HOST, displayName: 'Host', role: 'host' }, text: MESSAGE },
      { seq: 3, kind: 'delivery', messageId, state: 'started' },
      { seq: 4, kind: 'turn.started' },
      { seq: 5, kind: 'text', text: 'I will write down what I found.' },
      { seq: 6, kind: 'tool.started', tool: { name: 'Write', verb: 'create', file: { root: MAIN_ROOT, path: NOTE } } },
      { seq: 7, kind: 'card', card: 'permission', id: requestId },
      { seq: 8, kind: 'tool.finished', ok: true, result: { additions: 1, deletions: 0 } },
      { seq: 9, kind: 'text', text: 'Done: see notes/agent.md.' },
      { seq: 10, kind: 'turn.finished', outcome: 'completed' },
      { seq: 11, kind: 'delivery', messageId, state: 'completed' },
    ]);
    // The card travels with the page, settled, with the change that was allowed.
    expect(page.permissions).toMatchObject([{ id: requestId, status: 'allowed', tool: 'Write', what: 'edit', file: { root: MAIN_ROOT, path: NOTE }, change: { text: expect.stringContaining(`+${CONTENT}`) } }]);
    // What the stand-in was started with: the session's own settings, MCP config and role prompt (the real launch).
    const launches = (await s.claude.echoed()).filter((entry) => entry.kind === 'argv');
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ session: sessionId, value: expect.arrayContaining(['--settings', '--mcp-config', '--strict-mcp-config', '--permission-mode', 'default']) });

    // ---- the daemon stops: no process of the session survives it
    expect(await processesOf(s.stateDir)).not.toEqual([]);
    await d.cleanup();
    await waitFor(async () => (await processesOf(s.stateDir)).length === 0, { timeoutMs: 10_000, what: 'the agent process to be gone after the stop' });

    // ---- ... and starts again: the session is there, idle, and reads back exactly as before
    d = await s.start();
    expect(FEATURE_SERVICE_NAMES.filter((name) => isStubService(d.ctx.services[name]))).toEqual([]);
    expect(d.ctx.lifecycle.status()).toMatchObject({ agents: { running: 0, waiting: 0, stalled: 0, idle: 1 } });
    const again = await d.connectHost();
    expect((await again.conn.request('session.list', {})).sessions).toMatchObject([{ id: sessionId, kind: 'agent', purpose: 'free', title: 'Tests', status: 'idle', openedBy: { userId: HOST }, lastSeq: 11 }]);
    const reread = await again.conn.request('session.watch', { sessionId });
    expect(reread.events).toEqual(page.events);
    expect(reread.permissions).toEqual(page.permissions);
    expect(reread).toMatchObject({ firstSeq: 1, nextSeq: 12, hasEarlier: false, hasMore: false });
    expect((await again.conn.request('inbox.list', {})).items).toEqual([]);
    expect(await readFile(join(s.root, NOTE), 'utf8')).toBe(CONTENT);
    // Nothing was started by the restart itself: an idle session gets its process back with its next message.
    expect(await processesOf(s.stateDir)).toEqual([]);
    expect((await s.claude.echoed()).filter((entry) => entry.kind === 'argv')).toHaveLength(1);
  });
});
