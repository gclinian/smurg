// Claude Code behaviour, proven with the REAL `claude` binary against the mock Anthropic API (ARCHITECTURE §0 rule 2:
// dummy key, 127.0.0.1, isolated HOME / CLAUDE_CONFIG_DIR). The daemon is the real one with the real hook server,
// session settings written by the real settings writer, and `smurg hook` / `smurg mcp` run from this package's
// sources through config.sessions.selfCommand. Only the lock manager is a stand-in (test/hooks/fakes.ts): here it
// says "Amy is typing in locked.txt".
//
// The runs pass `--permission-mode acceptEdits` so that the non-interactive run APPLIES the edits nobody holds
// (free.txt is the positive control of every deny). The product never passes a permission-mode flag (§7.6).
//
// Skipped LOUDLY (see the log line) when no verified `claude` is available. SMURG_TEST_CLAUDE_BIN selects another
// binary, e.g. the other verified version.
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { MAIN_ROOT, type FileRef } from '@smurg/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonEvents } from '../../src/core/interfaces.ts';
import { buildSessionSettings, writePrivateJson } from '../../src/hooks/settings-writer.ts';
import { TEST_HOST_USER } from '../../src/testing/index.ts';
import { findClaude, isolatedEnv, MOCK_API_KEY, runClaude, seedClaudeTrust, startClaudeDaemon, type ClaudeDaemon, type ClaudeRun } from './claude-harness.ts';
import { registerAgent } from './helpers.ts';
import { startMockAnthropic, type MockAnthropic, type MockStep } from './mock-anthropic.ts';

const found = await findClaude();
const claude = found.binary;
if (claude === null) console.warn(`\n[claude-e2e] SKIPPED — ${found.reason}\n`);
else console.log(`[claude-e2e] running against Claude Code ${claude.version} (${claude.path})`);
const V = claude === null ? 'no claude' : `Claude Code ${claude.version}`;

const HOST = { userId: TEST_HOST_USER, name: 'Host' };
const IAN = { userId: 'dev:ian', name: 'Ian' };
const LOCKED = 'hello from Amy\n';
const FREE = 'free text\n';
const HOLDER_REASON = '此檔案正由 Amy 編輯中，請先處理其他檔案或稍後再試';
const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });

describe.skipIf(claude === null)(`Claude Code hooks end to end (${V}, mock Anthropic API)`, () => {
  let env: ClaudeDaemon;
  const extraServers: Server[] = [];

  beforeAll(async () => {
    env = await startClaudeDaemon({ 'locked.txt': LOCKED, 'free.txt': FREE, 'notes/readme.md': '# notes\n' });
    // Ian (a 「可使用 agent」 member) opens the sessions; the lock manager says Amy is typing in locked.txt.
    env.daemon.ctx.members.admitMember({ userId: IAN.userId, displayName: IAN.name, role: 'agent', at: Date.now() });
    env.fakes.locks.holdHuman(main('locked.txt'), 'Amy');
  });

  afterAll(async () => {
    for (const server of extraServers) await new Promise<void>((resolve) => server.close(() => resolve()));
    await env?.cleanup();
  });

  const path = (rel: string): string => join(env.root, rel);
  const read = (rel: string): Promise<string> => readFile(path(rel), 'utf8');

  async function resetFiles(): Promise<void> {
    await writeFile(path('locked.txt'), LOCKED);
    await writeFile(path('free.txt'), FREE);
  }

  function capture<K extends keyof DaemonEvents>(name: K): { readonly events: DaemonEvents[K][]; stop(): void } {
    const events: DaemonEvents[K][] = [];
    const subscription = env.daemon.ctx.bus.on(name, (event) => events.push(event));
    return { events, stop: () => subscription.dispose() };
  }

  /**
   * Registers Ian's session with the hook server, writes its launch files, trusts the project in the run's isolated
   * Claude Code config, runs claude -p.
   */
  async function run(
    label: string,
    steps: readonly MockStep[],
    options: { readonly extraEnv?: Readonly<Record<string, string>>; readonly permissionMode?: string | null; readonly settingsOverride?: Record<string, unknown>; readonly prepareConfig?: (isolatedDir: string) => Promise<void> } = {},
  ): Promise<{ readonly run: ClaudeRun; readonly mock: MockAnthropic; readonly sessionId: string; readonly agentLocksAtExit: readonly string[] }> {
    const session = registerAgent(env.hooks, IAN);
    const files = await env.hooks.writeSessionFiles(session.sessionId);
    const isolated = await env.isolatedDir(label);
    await seedClaudeTrust({ cfgDir: join(isolated, 'cfg'), cwd: env.root, apiKey: MOCK_API_KEY });
    await options.prepareConfig?.(isolated);
    let args = [...files.claudeArgs];
    if (options.settingsOverride) {
      await writePrivateJson(files.dir, 'override.json', options.settingsOverride);
      args = args.map((arg) => (arg === files.settingsPath ? join(files.dir, 'override.json') : arg));
    }
    const mock = await startMockAnthropic(steps);
    try {
      const permission = options.permissionMode === undefined ? ['--permission-mode', 'acceptEdits'] : options.permissionMode === null ? [] : ['--permission-mode', options.permissionMode];
      const result = await runClaude(claude as NonNullable<typeof claude>, {
        cwd: env.root,
        env: isolatedEnv(isolated, mock.url, { ...session.env, ...options.extraEnv }),
        args: ['-p', 'do the scripted edits', '--output-format', 'json', '--no-session-persistence', ...permission, ...args],
        timeoutMs: 120_000,
      });
      // What the session still holds when claude has exited, BEFORE unregistering (which releases everything).
      const agentLocksAtExit = env.fakes.locks.agentLocksOf(session.sessionId).map((lock) => lock.file.path);
      console.log(`[claude-e2e ${claude?.version}] ${label}: exit ${result.code} in ${result.ms} ms${result.timedOut ? ' (TIMED OUT)' : ''}; tool results: ${JSON.stringify(mock.toolResults().map((r) => `${r.toolUseId}:${r.isError ? 'error' : 'ok'}`))}`);
      expect(result.timedOut).toBe(false);
      // The model API calls went to the mock, with the dummy credential.
      const messages = mock.requests.filter((r) => r.kind === 'messages');
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((r) => r.credential)).toBe(true);
      const others = mock.requests.filter((r) => r.kind === 'other');
      if (others.length > 0) console.log(`[claude-e2e ${claude?.version}] ${label}: other requests to the mock: ${JSON.stringify(others.map((r) => `${r.method} ${r.url.split('?')[0]}`))}`);
      return { run: result, mock, sessionId: session.sessionId, agentLocksAtExit };
    } finally {
      await mock.close();
      env.hooks.unregisterSession(session.sessionId);
    }
  }

  function toolResult(mock: MockAnthropic, n: number): { readonly isError: boolean; readonly text: string } {
    const result = mock.toolResults().find((r) => r.toolUseId === mock.toolUseId(n));
    if (!result) throw new Error(`the model never received a result for tool call ${n}: ${JSON.stringify(mock.toolResults())}`);
    return result;
  }

  const readBoth = (): MockStep => ({ tools: [{ name: 'Read', input: { file_path: path('locked.txt') } }, { name: 'Read', input: { file_path: path('free.txt') } }] });
  const editLocked = (): MockStep => ({ tools: [{ name: 'Edit', input: { file_path: path('locked.txt'), old_string: 'hello', new_string: 'HACKED' } }] });

  it(`SPEC §13 / R8.1: PreToolUse 回傳 deny 能確實擋下 Edit 工具 — 有人正在打字的檔案，agent 的 Edit 被擋下，並收到持有者的名字 (${V})`, async () => {
    await resetFiles();
    const pres = capture('agent.tool.pre');
    const posts = capture('agent.tool.post');
    const { run: result, mock, agentLocksAtExit } = await run('r8.1', [
      readBoth(),
      {
        tools: [
          { name: 'Edit', input: { file_path: path('locked.txt'), old_string: 'hello', new_string: 'HACKED' } },
          { name: 'Edit', input: { file_path: path('free.txt'), old_string: 'free', new_string: 'FREE-EDITED' } },
        ],
      },
      { tools: [{ name: 'Write', input: { file_path: path('locked.txt'), content: 'OVERWRITTEN\n' } }] },
      { text: 'DONE' },
    ]);
    pres.stop();
    posts.stop();
    // The held file is byte-identical; the free one was edited (the denies are not a side effect of anything else).
    expect(await read('locked.txt')).toBe(LOCKED);
    expect(await read('free.txt')).toBe('FREE-EDITED text\n');
    // What the model was told: an error tool_result that names the holder (2.1.283 prefixes "PreToolUse:Edit hook error:").
    for (const n of [3, 5]) {
      const denied = toolResult(mock, n);
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain(HOLDER_REASON);
    }
    expect(toolResult(mock, 4).isError).toBe(false);
    const denials = (result.final?.['permission_denials'] as { tool_name: string }[] | undefined)?.map((d) => d.tool_name) ?? [];
    expect(denials).toEqual(['Edit', 'Write']);
    // The daemon saw exactly that: two refusals for locked.txt, one grant for free.txt, released after its PostToolUse.
    expect(pres.events.map((e) => `${e.tool}:${e.file?.path}:${e.outcome}`)).toEqual(['Edit:locked.txt:denied', 'Edit:free.txt:granted', 'Write:locked.txt:denied']);
    expect(posts.events.map((e) => `${e.tool}:${e.file?.path}:${e.ok}`)).toEqual(['Edit:free.txt:true']);
    expect(agentLocksAtExit).toEqual([]);
  }, 180_000);

  it(`R8: 兩個 agent 同時修改同一個檔案時，後到者被擋下 — the second agent's real Edit is refused and names the first (${V})`, async () => {
    await resetFiles();
    const first = registerAgent(env.hooks, HOST);
    expect(env.fakes.locks.requestAgent({ file: main('free.txt'), sessionId: first.sessionId, ownerUserId: HOST.userId, agentName: 'Claude（Host）', sessionRoot: MAIN_ROOT }).granted).toBe(true);
    try {
      const { mock } = await run('two-agents', [readBoth(), { tools: [{ name: 'Edit', input: { file_path: path('free.txt'), old_string: 'free', new_string: 'SECOND' } }] }, { text: 'DONE' }]);
      expect(await read('free.txt')).toBe(FREE);
      const denied = toolResult(mock, 3);
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('此檔案正由 Claude（Host）修改中');
    } finally {
      env.fakes.locks.releaseAllForSession(first.sessionId, 'stop');
      env.hooks.unregisterSession(first.sessionId);
    }
  }, 180_000);

  describe('the hook fails closed (file unchanged)', () => {
    async function fakeSocket(name: string, onLine: (socket: Socket, line: string) => void): Promise<string> {
      const socketPath = join(env.runDir, name);
      const server = createServer((socket) => {
        socket.on('error', () => {});
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (buffer.includes('\n')) onLine(socket, buffer.slice(0, buffer.indexOf('\n')));
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      extraServers.push(server);
      return socketPath;
    }

    async function expectFailClosed(label: string, socketPath: string, detail: RegExp): Promise<ClaudeRun> {
      await resetFiles();
      const { run: result, mock } = await run(label, [readBoth(), editLocked(), { text: 'DONE' }], { extraEnv: { SMURG_HOOK_SOCKET: socketPath } });
      expect(await read('locked.txt')).toBe(LOCKED);
      const denied = toolResult(mock, 3);
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('smurg daemon unreachable');
      expect(denied.text).toMatch(detail);
      return result;
    }

    it(`the hook fails closed when the daemon is down (no socket) (${V})`, async () => {
      await expectFailClosed('daemon-down', join(env.runDir, 'down.sock'), /connect/);
    }, 180_000);

    it(`the hook fails closed when the daemon is slow: it denies at its own 5 s deadline, before Claude Code's 10 s hook timeout lets the edit through (${V})`, async () => {
      const socketPath = await fakeSocket('slow.sock', () => {
        // never answers
      });
      await expectFailClosed('daemon-slow', socketPath, /timeout/);
    }, 240_000);

    it(`the hook fails closed when the daemon answers garbage (${V})`, async () => {
      const socketPath = await fakeSocket('garbage.sock', (socket) => socket.end('{"surprise": true\n'));
      await expectFailClosed('daemon-garbage', socketPath, /malformed|not JSON/);
    }, 180_000);
  });

  describe('hooks cannot be switched off', () => {
    async function expectLockHookRan(label: string, options: Parameters<typeof run>[2]): Promise<void> {
      await resetFiles();
      const { mock } = await run(label, [readBoth(), editLocked(), { text: 'DONE' }], options);
      expect(await read('locked.txt')).toBe(LOCKED);
      const denied = toolResult(mock, 3);
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain(HOLDER_REASON);
    }

    it(`hooks still run when the project contains .claude/settings.json with disableAllHooks true (plus settings.local.json, and a project env CLAUDE_CODE_SIMPLE) (${V})`, async () => {
      await mkdir(path('.claude'), { recursive: true });
      await writeFile(path('.claude/settings.json'), JSON.stringify({ disableAllHooks: true, env: { CLAUDE_CODE_SIMPLE: '1' } }));
      await writeFile(path('.claude/settings.local.json'), JSON.stringify({ disableAllHooks: true }));
      try {
        await expectLockHookRan('project-disable', {});
      } finally {
        await rm(path('.claude'), { recursive: true, force: true });
      }
    }, 240_000);

    it(`hooks still run when the environment sets CLAUDE_CODE_SAFE_MODE (${V})`, async () => {
      await expectLockHookRan('env-safe-mode', { extraEnv: { CLAUDE_CODE_SAFE_MODE: '1' } });
    }, 180_000);

    it(`hooks still run when the environment sets CLAUDE_CODE_SIMPLE (${V})`, async () => {
      await expectLockHookRan('env-simple', { extraEnv: { CLAUDE_CODE_SIMPLE: '1' } });
    }, 180_000);

    it(`hooks still run when the user settings ($CLAUDE_CONFIG_DIR/settings.json, which an agent running as the host can write) try disableAllHooks, CLAUDE_CODE_SIMPLE and CLAUDE_CODE_SAFE_MODE (${V})`, async () => {
      await expectLockHookRan('user-settings', {
        prepareConfig: (isolated) => writeFile(join(isolated, 'cfg', 'settings.json'), JSON.stringify({ disableAllHooks: true, env: { CLAUDE_CODE_SAFE_MODE: '1', CLAUDE_CODE_SIMPLE: '1' } })),
      });
    }, 180_000);

    it(`control: without smurg's env neutralizers, CLAUDE_CODE_SAFE_MODE=1 really switches every hook off and the held file is overwritten (${V})`, async () => {
      await resetFiles();
      const settings = buildSessionSettings({ command: env.daemon.config.sessions.selfCommand as NonNullable<typeof env.daemon.config.sessions.selfCommand> });
      delete settings['env'];
      await run('control-safe-mode', [readBoth(), editLocked(), { text: 'DONE' }], { extraEnv: { CLAUDE_CODE_SAFE_MODE: '1' }, settingsOverride: settings });
      expect(await read('locked.txt')).toBe('HACKED from Amy\n');
      await resetFiles();
    }, 180_000);
  });

  describe('lock release', () => {
    it(`lock released after PostToolUse (${V})`, async () => {
      await resetFiles();
      const posts = capture('agent.tool.post');
      const pres = capture('agent.tool.pre');
      const { agentLocksAtExit } = await run('post', [readBoth(), { tools: [{ name: 'Edit', input: { file_path: path('free.txt'), old_string: 'free', new_string: 'EDITED' } }] }, { text: 'DONE' }]);
      posts.stop();
      pres.stop();
      expect(await read('free.txt')).toBe('EDITED text\n');
      expect(pres.events.map((e) => e.outcome)).toEqual(['granted']);
      expect(posts.events).toEqual([expect.objectContaining({ tool: 'Edit', file: main('free.txt'), ok: true })]);
      expect(agentLocksAtExit).toEqual([]);
      expect(env.fakes.locks.calls.filter((c) => c.op === 'releaseAgent' && c.file === 'main:free.txt').length).toBeGreaterThan(0);
    }, 180_000);

    it(`lock released after a failed tool (PostToolUseFailure: a Write into a read-only directory fails after the hook granted the lock) (${V})`, async () => {
      await resetFiles();
      await mkdir(path('readonly'), { recursive: true });
      await chmod(path('readonly'), 0o555);
      const posts = capture('agent.tool.post');
      const pres = capture('agent.tool.pre');
      let locksAtExit: readonly string[] = ['(not run)'];
      try {
        const { mock, agentLocksAtExit } = await run('failure', [{ tools: [{ name: 'Write', input: { file_path: path('readonly/new.txt'), content: 'x\n' } }] }, { text: 'DONE' }]);
        locksAtExit = agentLocksAtExit;
        expect(toolResult(mock, 1).isError).toBe(true);
      } finally {
        posts.stop();
        pres.stop();
        await chmod(path('readonly'), 0o755);
        await rm(path('readonly'), { recursive: true, force: true });
      }
      expect(pres.events.map((e) => `${e.file?.path}:${e.outcome}`)).toEqual(['readonly/new.txt:granted']);
      expect(posts.events).toEqual([expect.objectContaining({ tool: 'Write', file: main('readonly/new.txt'), ok: false })]);
      expect(locksAtExit).toEqual([]);
    }, 180_000);

    it(`lock released when the permission to edit is refused without a Post event (-p auto-deny: released by Stop) (${V})`, async () => {
      await resetFiles();
      const pres = capture('agent.tool.pre');
      const posts = capture('agent.tool.post');
      const { agentLocksAtExit, sessionId } = await run('auto-deny', [readBoth(), { tools: [{ name: 'Edit', input: { file_path: path('free.txt'), old_string: 'free', new_string: 'EDITED' } }] }, { text: 'DONE' }], { permissionMode: null });
      pres.stop();
      posts.stop();
      expect(await read('free.txt')).toBe(FREE);
      expect(pres.events.map((e) => e.outcome)).toEqual(['granted']);
      expect(posts.events).toEqual([]);
      expect(env.fakes.locks.calls.some((c) => c.op === 'releaseAllForSession' && c.sessionId === sessionId && c.reason === 'stop')).toBe(true);
      expect(agentLocksAtExit).toEqual([]);
    }, 180_000);
  });

  it(`the coordination MCP tools answer inside Claude Code: mcp__smurg__who_is_editing names Amy, lock_status lists the lock, without a permission prompt (${V})`, async () => {
    await resetFiles();
    const { mock } = await run('mcp', [
      { tools: [{ name: 'mcp__smurg__who_is_editing', input: { file_path: path('locked.txt') } }] },
      { tools: [{ name: 'mcp__smurg__lock_status', input: {} }] },
      { text: 'DONE' },
    ]);
    const first = mock.requests.find((r) => r.kind === 'messages' && r.isMain);
    expect(first?.toolNames).toEqual(expect.arrayContaining(['mcp__smurg__who_is_editing', 'mcp__smurg__lock_status', 'mcp__smurg__wait_for_lock', 'mcp__smurg__list_sessions', 'mcp__smurg__notify_member']));
    const who = toolResult(mock, 1);
    expect(who.isError).toBe(false);
    expect(JSON.parse(who.text)).toMatchObject({ file: 'locked.txt', editing: true, humans: [{ name: 'Amy' }] });
    const status = toolResult(mock, 2);
    expect(status.isError).toBe(false);
    expect(JSON.parse(status.text)).toMatchObject({ locks: [expect.objectContaining({ kind: 'human', file: 'locked.txt' })] });
  }, 180_000);
});
