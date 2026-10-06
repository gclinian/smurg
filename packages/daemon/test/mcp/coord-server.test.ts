// `smurg mcp` (runMcpServer): smurg's own MCP server Claude Code starts in every agent session (SPEC R8: the
// coordination tools let agents ask who is editing a file, query and wait for locks, list all sessions and notify a
// teammate; a topic's sessions also check their plan and report through it). Driven here over its stdio JSON-RPC with
// the real hook socket behind it; claude-e2e.test.ts calls a tool through the real Claude Code. What each topic tool
// answers is in topic-tools.test.ts.
import { join } from 'node:path';
import { MAIN_ROOT, type MemberNotification } from '@smurg/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { runMcpServer } from '../../src/mcp/coord-server.ts';
import { MCP_TOOLS, TOPIC_TOOL_NAMES, isAgentToolName } from '../../src/mcp/tools.ts';
import { HOOK_ENV, MCP_TOOL_NAMES, isMcpToolName } from '../../src/hooks/wire.ts';
import { TEST_HOST_USER } from '../../src/testing/index.ts';
import { sessionInfo } from '../hooks/fakes.ts';
import { registerAgent, startHookDaemon, type HookDaemon } from '../hooks/helpers.ts';

const HOST = { userId: TEST_HOST_USER, name: 'Host' };
const main = (path: string) => ({ root: MAIN_ROOT, path });

type Json = Record<string, unknown>;

/** An in-process MCP client: lines in through an async queue, JSON-RPC messages out. */
class McpClient {
  readonly done: Promise<number>;
  readonly stderr: string[] = [];
  private readonly lines: string[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private readonly messages: Json[] = [];
  private readonly waiters: { match: (m: Json) => boolean; resolve: (m: Json) => void }[] = [];
  private nextId = 1;

  constructor(env: Record<string, string | undefined>) {
    const self = this;
    const stdin: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (self.lines.length > 0) yield self.lines.shift() as string;
          if (self.ended) return;
          await new Promise<void>((resolve) => (self.wake = resolve));
        }
      },
    };
    this.done = runMcpServer({
      stdin,
      stdout: { write: (chunk: string | Uint8Array) => this.onOutput(String(chunk)) },
      stderr: { write: (chunk: string | Uint8Array) => this.stderr.push(String(chunk)) },
      env,
    });
  }

  private onOutput(text: string): boolean {
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const message = JSON.parse(line) as Json;
      const waiter = this.waiters.findIndex((w) => w.match(message));
      if (waiter === -1) this.messages.push(message);
      else this.waiters.splice(waiter, 1)[0]?.resolve(message);
    }
    return true;
  }

  sendRaw(line: string): void {
    this.lines.push(line.endsWith('\n') ? line : `${line}\n`);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  response(match: (m: Json) => boolean, timeoutMs = 20_000): Promise<Json> {
    const found = this.messages.findIndex(match);
    if (found !== -1) return Promise.resolve(this.messages.splice(found, 1)[0] as Json);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no MCP response')), timeoutMs);
      this.waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  async request(method: string, params: Json = {}): Promise<Json> {
    const id = this.nextId++;
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return this.response((m) => m['id'] === id);
  }

  /** tools/call; returns the parsed JSON of a successful result, or the error text. */
  async call(name: string, args: Json = {}): Promise<{ readonly isError: boolean; readonly text: string; readonly json: Json | null }> {
    const reply = await this.request('tools/call', { name, arguments: args });
    const result = reply['result'] as { content: { type: string; text: string }[]; isError?: boolean };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    const text = result.content[0]?.text ?? '';
    let json: Json | null = null;
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = null;
    }
    return { isError: result.isError === true, text, json };
  }
}

let d: HookDaemon | null = null;
const clients: McpClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.end();
    await client.done;
  }
  await d?.t.cleanup();
  d = null;
});

async function setup(options: Parameters<typeof startHookDaemon>[0] = {}): Promise<{ d: HookDaemon; mcp: McpClient; sessionId: string }> {
  d = await startHookDaemon({ fakes: { sessions: true, ...options.fakes }, daemon: { project: { files: { 'locked.txt': 'x', 'free.txt': 'y', 'src/a.ts': 'z' } } } });
  const s = registerAgent(d.hooks, HOST);
  const mcp = new McpClient({ ...s.env });
  clients.push(mcp);
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  mcp.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  return { d, mcp, sessionId: s.sessionId };
}

describe('MCP protocol', () => {
  it('initialize: a stdio server named "smurg" with tools only; the protocol version is negotiated', async () => {
    const { mcp } = await setup();
    const known = await mcp.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect(known['result']).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'smurg' } });
    const unknown = await mcp.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect((unknown['result'] as Json)['protocolVersion']).toBe('2025-11-25');
    expect(await mcp.request('ping')).toMatchObject({ result: {} });
  });

  it('tools/list: the five coordination tools and the three tools of a topic\'s sessions, described in English for the agent', async () => {
    const { mcp } = await setup();
    const tools = ((await mcp.request('tools/list'))['result'] as { tools: { name: string; description: string; inputSchema: Json }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(['who_is_editing', 'lock_status', 'wait_for_lock', 'list_sessions', 'notify_member', 'check_plan', 'propose_split', 'check_report']);
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    // The socket's list (hooks/wire.ts) and the MCP server's definitions (mcp/tools.ts) name the same eight tools.
    expect([...MCP_TOOL_NAMES]).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(MCP_TOOL_NAMES.slice(-TOPIC_TOOL_NAMES.length)).toEqual([...TOPIC_TOOL_NAMES]);
    expect(tools.every((t) => isAgentToolName(t.name))).toBe(true);
    expect(isAgentToolName('rm_rf')).toBe(false);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(tool.description).toMatch(/^[\x20-\x7e]+$/); // English, printable ASCII
      expect(tool.inputSchema['type']).toBe('object');
    }
  });

  it('protocol errors are JSON-RPC errors, tool failures are isError results; nothing else reaches stdout', async () => {
    const { mcp } = await setup();
    mcp.sendRaw('this is not json');
    expect(await mcp.response((m) => m['id'] === null)).toMatchObject({ error: { code: -32700 } });
    expect(await mcp.request('tools/call', { name: 'rm_rf', arguments: {} })).toMatchObject({ error: { code: -32602 } });
    expect(await mcp.request('resources/list')).toMatchObject({ error: { code: -32601 } });
    const bad = await mcp.call('who_is_editing', { file: 'x' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Invalid arguments/);
  });

  it('a wrong token or a daemon that is down is a tool error, not a crash', async () => {
    d = await startHookDaemon();
    const forged = new McpClient({ [HOOK_ENV.socket]: d.hooks.socketPath, [HOOK_ENV.token]: 'forged' });
    const down = new McpClient({ [HOOK_ENV.socket]: join(d.t.runDir, 'nothing.sock'), [HOOK_ENV.token]: 'x' });
    clients.push(forged, down);
    const refused = await forged.call('list_sessions');
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toMatch(/unauthorized/);
    const unreachable = await down.call('lock_status');
    expect(unreachable.isError).toBe(true);
    expect(unreachable.text).toMatch(/daemon is unreachable/);
  });

  it('stdin EOF ends the server with exit code 0 and cancels a pending wait', async () => {
    const { d: daemon, mcp } = await setup();
    daemon.fakes.locks.holdHuman(main('locked.txt'), 'Amy');
    const pending = mcp.call('wait_for_lock', { file_path: 'locked.txt', timeout_seconds: 60 }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    mcp.end();
    expect(await mcp.done).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    void pending;
  });
});

describe('R8: the coordination MCP server\'s tools: who is editing a file, query and wait for locks, list all sessions, notify a teammate', () => {
  it('who_is_editing names the person typing in the file, the agent modifying it, or nobody', async () => {
    const { d: daemon, mcp } = await setup();
    daemon.fakes.locks.holdHuman(main('locked.txt'), 'Amy');
    const human = await mcp.call('who_is_editing', { file_path: join(daemon.t.root, 'locked.txt') });
    expect(human.isError).toBe(false);
    expect(human.json).toMatchObject({ file: 'locked.txt', editing: true, humans: [{ name: 'Amy', userId: 'dev:amy' }], agent: null });
    expect(String(human.json?.['summary'])).toContain('Amy');
    const other = registerAgent(daemon.hooks, { userId: TEST_HOST_USER, name: 'Host' });
    daemon.fakes.locks.requestAgent({ file: main('src/a.ts'), sessionId: other.sessionId, ownerUserId: TEST_HOST_USER, agentName: 'Claude (Host)', sessionRoot: MAIN_ROOT });
    const agent = await mcp.call('who_is_editing', { file_path: 'src/a.ts' });
    expect(agent.json).toMatchObject({ editing: true, humans: [], agent: { kind: 'agent', agent: 'Claude (Host)', sessionId: other.sessionId, isYou: false } });
    const free = await mcp.call('who_is_editing', { file_path: 'free.txt' });
    expect(free.json).toMatchObject({ editing: false, humans: [], agent: null, summary: 'free.txt is free: nobody is editing it.' });
  });

  it('lock_status: one file, or every lock of the session root', async () => {
    const { d: daemon, mcp } = await setup();
    daemon.fakes.locks.holdHuman(main('locked.txt'), 'Amy', 'Bob');
    expect((await mcp.call('lock_status', { file_path: 'locked.txt' })).json).toMatchObject({ locked: true, lock: { kind: 'human', holders: [{ name: 'Amy' }, { name: 'Bob' }] } });
    expect((await mcp.call('lock_status', { file_path: 'free.txt' })).json).toMatchObject({ locked: false, lock: null });
    const all = (await mcp.call('lock_status')).json;
    expect(all?.['locks']).toEqual([expect.objectContaining({ kind: 'human', file: 'locked.txt', root: 'main' })]);
  });

  it('wait_for_lock returns as soon as the lock is released', async () => {
    const { d: daemon, mcp } = await setup();
    daemon.fakes.locks.holdHuman(main('locked.txt'), 'Amy');
    const started = Date.now();
    const waiting = mcp.call('wait_for_lock', { file_path: 'locked.txt', timeout_seconds: 60 });
    setTimeout(() => daemon.fakes.locks.releaseHuman(main('locked.txt')), 500);
    const result = await waiting;
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ file: 'locked.txt', released: true, lock: null });
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('wait_for_lock returns on timeout with the lock still held; a free file or your own lock answers at once', async () => {
    const { d: daemon, mcp, sessionId } = await setup();
    daemon.fakes.locks.holdHuman(main('locked.txt'), 'Amy');
    const started = Date.now();
    const timedOut = await mcp.call('wait_for_lock', { file_path: 'locked.txt', timeout_seconds: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(timedOut.json).toMatchObject({ released: false, lock: { kind: 'human', holders: [{ name: 'Amy' }] } });
    expect((await mcp.call('wait_for_lock', { file_path: 'free.txt' })).json).toMatchObject({ released: true, waitedSeconds: 0 });
    daemon.fakes.locks.requestAgent({ file: main('src/a.ts'), sessionId, ownerUserId: TEST_HOST_USER, agentName: 'Claude (Host)', sessionRoot: MAIN_ROOT });
    expect((await mcp.call('wait_for_lock', { file_path: 'src/a.ts', timeout_seconds: 60 })).json).toMatchObject({ released: false, heldByYou: true });
  });

  it('list_sessions: every session with its owner, root and the files each agent is modifying', async () => {
    const { d: daemon, mcp, sessionId } = await setup();
    daemon.fakes.sessions.push(sessionInfo(sessionId, HOST), sessionInfo('ses_amy', { userId: 'dev:amy', name: 'Amy' }, { root: { kind: 'worktree', worktreeId: 'wt_amy' }, kind: 'agent' }));
    daemon.fakes.locks.requestAgent({ file: main('free.txt'), sessionId, ownerUserId: TEST_HOST_USER, agentName: 'Claude (Host)', sessionRoot: MAIN_ROOT });
    const listed = (await mcp.call('list_sessions')).json;
    expect(listed?.['sessions']).toEqual([
      expect.objectContaining({ id: sessionId, owner: 'Host', root: 'main', isYou: true, editing: ['main:free.txt'] }),
      expect.objectContaining({ id: 'ses_amy', owner: 'Amy', ownerUserId: 'dev:amy', root: 'worktree:wt_amy', isYou: false, editing: [] }),
    ]);
    // Sessions nobody named get the English default title (what an agent reads is fixed English); a typed one is kept.
    daemon.fakes.sessions.push(sessionInfo('ses_term', { userId: 'dev:amy', name: 'Amy' }, { kind: 'terminal' }), sessionInfo('ses_named', HOST, { title: 'release notes' }));
    const titles = ((await mcp.call('list_sessions')).json?.['sessions'] as { title: string }[]).map((session) => session.title);
    expect(titles).toEqual(['Claude (Host)', 'Claude (Amy)', 'Terminal (Amy)', 'release notes']);
  });

  it("notify_member delivers activity.notify to that member's clients only (from `Claude (owner)`)", async () => {
    const { d: daemon, mcp, sessionId } = await setup();
    const amy = await daemon.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const bob = await daemon.t.connect({ userId: 'dev:bob', displayName: 'Bob', role: 'editor' });
    const amyGot: MemberNotification[] = [];
    const bobGot: MemberNotification[] = [];
    amy.conn.on('activity.notify', (payload) => amyGot.push(payload.notification));
    bob.conn.on('activity.notify', (payload) => bobGot.push(payload.notification));
    const result = await mcp.call('notify_member', { member: 'amy', message: 'Could you release locked.txt when you are done?', file_path: 'locked.txt' });
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ delivered: true, member: { userId: 'dev:amy', name: 'Amy' }, online: true });
    await expect.poll(() => amyGot.length).toBe(1);
    expect(amyGot[0]).toMatchObject({
      from: { kind: 'agent', sessionId, ownerUserId: TEST_HOST_USER, displayName: 'Claude (Host)' },
      text: 'Could you release locked.txt when you are done?',
      file: main('locked.txt'),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bobGot).toEqual([]);
  });

  it('notify_member through the activity feed when it is there; unknown members, control characters and floods are refused', async () => {
    const { d: daemon, mcp } = await setup({ fakes: { activity: true, sessions: true } });
    await daemon.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'viewer' });
    expect((await mcp.call('notify_member', { member: 'dev:amy', message: 'done' })).isError).toBe(false);
    expect(daemon.fakes.activity?.notified).toEqual([{ userId: 'dev:amy', notification: { from: expect.objectContaining({ kind: 'agent' }), text: 'done' } }]);
    const unknown = await mcp.call('notify_member', { member: 'Zed', message: 'hi' });
    expect(unknown.isError).toBe(true);
    // The answer never repeats what the agent typed; it lists the members by the names an agent may use.
    expect(unknown.text).toMatch(/No member has that name\. Members: .*Amy/);
    expect(unknown.text).not.toContain('Zed');
    expect((await mcp.call('notify_member', { member: 'Amy', message: 'bell\u0007' })).isError).toBe(true);
    // 10 a minute per session (`ctx.rates`, bucket `agent-notify`): one is used, nine more pass, the rest are refused.
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await mcp.call('notify_member', { member: 'Amy', message: `n${i}` }));
    expect(results.filter((r) => !r.isError)).toHaveLength(9);
    expect(results.filter((r) => r.isError && /Too many notifications/.test(r.text))).toHaveLength(3);
  });

  // The daemon's socket schema takes its tool names from hooks/wire.ts (MCP_TOOL_NAMES): a tool that is not listed
  // there is refused by the socket before any handler, so the three topic tools must be on it.
  it('a topic tool travels the same road: check_plan from a session that is no discussion answers with one sentence', async () => {
    for (const name of TOPIC_TOOL_NAMES) expect(isMcpToolName(name), name).toBe(true);
    const { mcp } = await setup();
    const answer = await mcp.call('check_plan');
    expect(answer.isError).toBe(false);
    expect(answer.json).toMatchObject({ ok: false, errors: [{ message: 'This tool is for the discussion session of a topic. This session is not one.' }] });
  });

  it("paths outside the session's root are refused; relative paths are relative to the root", async () => {
    const { d: daemon, mcp } = await setup();
    for (const file_path of ['/etc/hosts', '../outside.txt', join(daemon.t.root, '..', 'x')]) {
      const refused = await mcp.call('who_is_editing', { file_path });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/Only files inside this session's workspace/);
    }
    expect((await mcp.call('who_is_editing', { file_path: 'src/../free.txt' })).json).toMatchObject({ file: 'free.txt' });
  });
});
