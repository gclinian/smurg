// `smurg hook` (runHookCli): the process Claude Code runs for every hook event. It must fail CLOSED by itself: Claude
// Code lets the tool run when a hook times out, crashes, exits 1 or prints garbage (claude-hooks.md §1.2), so every
// failure during PreToolUse must become a printed JSON deny with exit 0.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_ROOT } from '@smurg/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHookCli, type HookCliIo } from '../../src/hooks/hook-cli.ts';
import { HOOK_ENV } from '../../src/hooks/wire.ts';
import { createTempDir, createTempRunDir, removeTempDir, removeTempRunDir, TEST_HOST_USER } from '../../src/testing/index.ts';
import { registerAgent, startHookDaemon, type HookDaemon } from './helpers.ts';

const HOOK_CLI = fileURLToPath(new URL('../../src/hooks/hook-cli.ts', import.meta.url));

interface Captured {
  readonly io: HookCliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function io(stdin: AsyncIterable<string | Uint8Array> | string, env: Record<string, string | undefined>): Captured {
  let out = '';
  let err = '';
  const input: AsyncIterable<string | Uint8Array> = typeof stdin === 'string' ? (async function* () { yield stdin; })() : stdin;
  return {
    io: {
      stdin: input,
      stdout: {
        write(chunk: string | Uint8Array, callback?: () => void): boolean {
          out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          callback?.();
          return true;
        },
      },
      stderr: { write: (chunk: string | Uint8Array) => (err += String(chunk)) },
      env,
    },
    stdout: () => out,
    stderr: () => err,
  };
}

/** What Claude Code writes for an Edit (2.1.220 / 2.1.283 field set, claude-hooks.md §3.3), content included. */
function claudePreToolUse(filePath: string, event = 'PreToolUse'): string {
  return JSON.stringify({
    session_id: '2e92a5cd-0000-4000-8000-000000000000',
    transcript_path: '/tmp/cfg/projects/x/2e92a5cd.jsonl',
    cwd: '/tmp/proj',
    prompt_id: '777053c2-0000-4000-8000-000000000000',
    permission_mode: 'default',
    effort: { level: 'high' },
    hook_event_name: event,
    tool_name: 'Edit',
    tool_input: { file_path: filePath, old_string: 'SECRET-OLD-CONTENT', new_string: 'SECRET-NEW-CONTENT', replace_all: false },
    tool_use_id: 'toolu_013TMazGUPYZRmqj6qbGmTkL',
  });
}

function parsedDeny(stdout: string): string | null {
  if (stdout.length === 0) return null;
  const output = JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string } };
  expect(output.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
  expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
  return output.hookSpecificOutput?.permissionDecisionReason ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fake daemons that misbehave (the real one is used where it matters)
// ---------------------------------------------------------------------------------------------------------------------

let runDir: string;
let tempDir: string;
const servers: Server[] = [];

beforeEach(async () => {
  runDir = await createTempRunDir();
  tempDir = await createTempDir('hookcli');
});

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeTempRunDir(runDir);
  await removeTempDir(tempDir);
});

async function fakeDaemon(onLine: (line: string, socket: Socket) => void): Promise<string> {
  const path = join(runDir, `fake-${servers.length}.sock`);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline !== -1) onLine(buffer.slice(0, newline), socket);
    });
  });
  const originalClose = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    for (const socket of sockets) socket.destroy();
    return originalClose(callback);
  }) as Server['close'];
  await new Promise<void>((resolve) => server.listen(path, resolve));
  servers.push(server);
  return path;
}

describe('runHookCli with the real hook server', () => {
  let d: HookDaemon;
  afterEach(async () => {
    await d.t.cleanup();
  });

  it('prints the daemon deny for a held file and exits 0; prints nothing when the lock is granted (never "allow")', async () => {
    d = await startHookDaemon({ daemon: { project: { files: { 'locked.txt': 'x', 'free.txt': 'y' } } } });
    d.fakes.locks.holdHuman({ root: MAIN_ROOT, path: 'locked.txt' }, 'Amy');
    const s = registerAgent(d.hooks, { userId: TEST_HOST_USER, name: 'Host' });
    const denied = io(claudePreToolUse(join(d.t.root, 'locked.txt')), { ...s.env });
    expect(await runHookCli(denied.io)).toBe(0);
    expect(parsedDeny(denied.stdout())).toBe('此檔案正由 Amy 編輯中，請先處理其他檔案或稍後再試');
    const granted = io(claudePreToolUse(join(d.t.root, 'free.txt')), { ...s.env });
    expect(await runHookCli(granted.io)).toBe(0);
    expect(granted.stdout()).toBe('');
    expect(d.fakes.locks.get({ root: MAIN_ROOT, path: 'free.txt' })?.kind).toBe('agent');
  });
});

describe('runHookCli fails closed', () => {
  it('forwards only what the daemon needs: file contents and prompts never leave the hook process', async () => {
    let seen = '';
    const socket = await fakeDaemon((line, s) => {
      seen = line;
      const id = (JSON.parse(line) as { id: string }).id;
      s.end(`${JSON.stringify({ id, hookOutput: null })}\n`);
    });
    const c = io(claudePreToolUse('/tmp/proj/a.txt'), { [HOOK_ENV.socket]: socket, [HOOK_ENV.token]: 'tok' });
    expect(await runHookCli(c.io)).toBe(0);
    expect(c.stdout()).toBe('');
    const request = JSON.parse(seen) as { op: string; token: string; hookInput: Record<string, unknown> };
    expect(request.op).toBe('hook');
    expect(request.token).toBe('tok');
    expect(request.hookInput).toEqual({
      hook_event_name: 'PreToolUse',
      session_id: '2e92a5cd-0000-4000-8000-000000000000',
      cwd: '/tmp/proj',
      tool_name: 'Edit',
      tool_use_id: 'toolu_013TMazGUPYZRmqj6qbGmTkL',
      permission_mode: 'default',
      tool_input: { file_path: '/tmp/proj/a.txt' },
    });
    expect(seen).not.toContain('SECRET');
  });

  it('the hook fails closed when the daemon is down: no socket file, no SMURG_HOOK_SOCKET, a path that is not a socket', async () => {
    const notSocket = join(tempDir, 'plain-file');
    await writeFile(notSocket, 'x');
    for (const env of [{ [HOOK_ENV.socket]: join(runDir, 'missing.sock'), [HOOK_ENV.token]: 't' }, { [HOOK_ENV.token]: 't' }, { [HOOK_ENV.socket]: notSocket, [HOOK_ENV.token]: 't' }]) {
      const c = io(claudePreToolUse('/tmp/proj/a.txt'), env);
      expect(await runHookCli(c.io)).toBe(0);
      expect(parsedDeny(c.stdout())).toMatch(/smurg 工作區的 daemon 無法連線（smurg daemon unreachable: .+），為避免覆蓋組員的修改，已擋下這次修改/);
    }
  });

  it('the hook fails closed when the daemon answers garbage: not JSON, another id, no hookOutput, a non-object hookOutput, a closed connection', async () => {
    const replies: ((id: string) => string | null)[] = [
      () => 'this is not json',
      () => JSON.stringify({ id: 'someone-else', hookOutput: null }),
      (id) => JSON.stringify({ id, ok: true }),
      (id) => JSON.stringify({ id, hookOutput: 'allow' }),
      () => null,
    ];
    for (const reply of replies) {
      const socket = await fakeDaemon((line, s) => {
        const text = reply((JSON.parse(line) as { id: string }).id);
        if (text === null) s.destroy();
        else s.end(`${text}\n`);
      });
      const c = io(claudePreToolUse('/tmp/proj/a.txt'), { [HOOK_ENV.socket]: socket, [HOOK_ENV.token]: 't' });
      expect(await runHookCli(c.io)).toBe(0);
      expect(parsedDeny(c.stdout())).toMatch(/daemon unreachable/);
    }
  });

  it('the hook fails closed when the daemon is slow: a deny well before the 10 s hook timeout (default 5 s deadline; SMURG_HOOK_DEADLINE_MS only lowers it)', async () => {
    const socket = await fakeDaemon(() => {
      // never answers
    });
    const quick = io(claudePreToolUse('/tmp/proj/a.txt'), { [HOOK_ENV.socket]: socket, [HOOK_ENV.token]: 't', SMURG_HOOK_DEADLINE_MS: '300' });
    let started = Date.now();
    expect(await runHookCli(quick.io)).toBe(0);
    expect(parsedDeny(quick.stdout())).toMatch(/daemon unreachable: timeout/);
    expect(Date.now() - started).toBeLessThan(3_000);
    // A larger value is ignored: the default 5 s deadline applies.
    const slow = io(claudePreToolUse('/tmp/proj/a.txt'), { [HOOK_ENV.socket]: socket, [HOOK_ENV.token]: 't', SMURG_HOOK_DEADLINE_MS: '60000' });
    started = Date.now();
    expect(await runHookCli(slow.io)).toBe(0);
    const elapsed = Date.now() - started;
    expect(parsedDeny(slow.stdout())).toMatch(/daemon unreachable: timeout/);
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(9_000);
  }, 20_000);

  it('unreadable hook input is denied (unknown event counts as PreToolUse); a stdin that never ends is denied at the deadline', async () => {
    const garbage = io('{"hook_event_name":"PreToolUse","tool_input":', { [HOOK_ENV.socket]: join(runDir, 'x.sock') });
    expect(await runHookCli(garbage.io)).toBe(0);
    expect(parsedDeny(garbage.stdout())).toMatch(/daemon unreachable/);
    const notJson = io('%%%', {});
    expect(await runHookCli(notJson.io)).toBe(0);
    expect(parsedDeny(notJson.stdout())).not.toBeNull();
    const endless = io(
      (async function* () {
        yield '{"hook_event_name":"PreToolUse"';
        await new Promise(() => {});
      })(),
      { SMURG_HOOK_DEADLINE_MS: '300' },
    );
    expect(await runHookCli(endless.io)).toBe(0);
    expect(parsedDeny(endless.stdout())).toMatch(/not received in time/);
  });

  it('other events fail quietly: nothing on stdout (UserPromptSubmit / SessionStart stdout would become model context), exit 0', async () => {
    for (const event of ['PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'PermissionRequest']) {
      const c = io(claudePreToolUse('/tmp/proj/a.txt', event), { [HOOK_ENV.socket]: join(runDir, 'missing.sock') });
      expect(await runHookCli(c.io)).toBe(0);
      expect(c.stdout()).toBe('');
      expect(c.stderr()).toContain('smurg hook:');
    }
    // A cut PostToolUse input is recognised as such (not answered with a PreToolUse deny).
    const cut = io('{"hook_event_name":"PostToolUse","tool_response":{"content":"', {});
    expect(await runHookCli(cut.io)).toBe(0);
    expect(cut.stdout()).toBe('');
  });
});

describe('startup time', () => {
  let d: HookDaemon;
  afterEach(async () => {
    await d.t.cleanup();
  });

  it('a real `node` process runs the hook against the daemon and exits by itself — measured (target: well under 300 ms)', async () => {
    d = await startHookDaemon({ daemon: { project: { files: { 'free.txt': 'y' } } } });
    const s = registerAgent(d.hooks, { userId: TEST_HOST_USER, name: 'Host' });
    const entry = join(tempDir, 'hook-entry.mjs');
    await writeFile(entry, `import { runHookCli } from ${JSON.stringify(HOOK_CLI)};\nprocess.exitCode = await runHookCli();\n`);
    const input = claudePreToolUse(join(d.t.root, 'free.txt'));
    const run = (): Promise<{ ms: number; code: number | null; stdout: string }> =>
      new Promise((resolve, reject) => {
        const started = process.hrtime.bigint();
        const child = spawn(process.execPath, [entry], { env: { PATH: '/usr/bin:/bin', ...s.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        const timer = setTimeout(() => {
          child.kill('SIGKILL'); // our own child only
          reject(new Error('the hook process did not exit within 10 s (a lingering handle would let Claude Code time out → fail open)'));
        }, 10_000);
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ ms: Number(process.hrtime.bigint() - started) / 1e6, code, stdout });
        });
        child.stdin.end(input);
      });
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await run();
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      times.push(result.ms);
      d.fakes.locks.releaseAllForSession(s.sessionId, 'stop');
    }
    times.sort((a, b) => a - b);
    const median = times[2] as number;
    console.log(`[hook-cli startup] node ${process.version}: full hook round trip (spawn → stdin → daemon → exit) ms: ${times.map((t) => t.toFixed(0)).join(', ')}; median ${median.toFixed(0)} ms`);
    // The machine is shared with other builds: the bound is generous; the measured value is in the log above.
    expect(median).toBeLessThan(2_000);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// ARCHITECTURE §11 D-13: the Bash ACTIVITY hook (`smurg hook bash-activity`) next to the LOCK hook (`smurg hook`). The
// same failures, opposite answers: the lock hook denies the edit, the Bash hook never blocks the command.
// ---------------------------------------------------------------------------------------------------------------------

function claudeBash(event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' = 'PreToolUse', command = "sed -i '' s/a/b/ SECRET-FILE.txt"): string {
  return JSON.stringify({
    session_id: '2e92a5cd-0000-4000-8000-000000000000',
    transcript_path: '/tmp/cfg/projects/x/2e92a5cd.jsonl',
    cwd: '/tmp/proj',
    permission_mode: 'default',
    hook_event_name: event,
    tool_name: 'Bash',
    tool_input: { command, description: 'edit a file' },
    tool_use_id: 'toolu_bash_0001',
    ...(event === 'PreToolUse' ? {} : { tool_response: { stdout: 'SECRET-OUTPUT', stderr: '', interrupted: false } }),
  });
}

describe('two hooks, two behaviours (D-13): the lock hook fails closed, the Bash activity hook fails open', () => {
  const failures: [string, () => Promise<Record<string, string | undefined>>][] = [
    ['no socket file', async () => ({ [HOOK_ENV.socket]: join(runDir, 'missing.sock'), [HOOK_ENV.token]: 't' })],
    ['no SMURG_HOOK_SOCKET', async () => ({ [HOOK_ENV.token]: 't' })],
    ['a daemon that never answers', async () => ({ [HOOK_ENV.socket]: await fakeDaemon(() => {}), [HOOK_ENV.token]: 't', SMURG_HOOK_DEADLINE_MS: '600' })],
    ['a daemon that answers garbage', async () => ({ [HOOK_ENV.socket]: await fakeDaemon((_line, s) => s.end('garbage\n')), [HOOK_ENV.token]: 't' })],
    ['a daemon that closes the connection', async () => ({ [HOOK_ENV.socket]: await fakeDaemon((_line, s) => s.destroy()), [HOOK_ENV.token]: 't' })],
    [
      'a daemon that answers a deny (it must never turn into a Bash decision)',
      async () => ({
        [HOOK_ENV.socket]: await fakeDaemon((line, s) => s.end(`${JSON.stringify({ id: (JSON.parse(line) as { id: string }).id, hookOutput: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } } })}\n`)),
        [HOOK_ENV.token]: 't',
      }),
    ],
  ];

  it.each(failures)('%s: the Edit (lock) hook prints a deny; the Bash hook exits 0 with no output, well inside its deadline', async (_label, envOf) => {
    const env = await envOf();
    const edit = io(claudePreToolUse('/tmp/proj/a.txt'), env);
    expect(await runHookCli({ ...edit.io, args: [] })).toBe(0);
    expect(parsedDeny(edit.stdout())).not.toBeNull();
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const) {
      const bash = io(claudeBash(event), env);
      const started = Date.now();
      expect(await runHookCli({ ...bash.io, args: ['bash-activity'] })).toBe(0);
      expect(Date.now() - started).toBeLessThan(2_500); // its own deadline is 1 s; Claude's limit for it is 5 s (slack for a loaded machine)
      expect(bash.stdout()).toBe('');
      expect(bash.stderr()).toBe('');
    }
  }, 30_000);

  it('the Bash hook on unreadable, endless or non-JSON input: exit 0, nothing printed', async () => {
    for (const stdin of ['%%%', '{"hook_event_name":"PreToolUse","tool_name":"Bash"', '[1,2]']) {
      const c = io(stdin, { [HOOK_ENV.socket]: join(runDir, 'x.sock') });
      expect(await runHookCli({ ...c.io, args: ['bash-activity'] })).toBe(0);
      expect(c.stdout()).toBe('');
    }
    const endless = io(
      (async function* () {
        yield '{"hook_event_name":"PreToolUse","tool_name":"Bash"';
        await new Promise(() => {});
      })(),
      {},
    );
    const started = Date.now();
    expect(await runHookCli({ ...endless.io, args: ['bash-activity'] })).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(endless.stdout()).toBe('');
  });

  it('an edit routed to the Bash hook by a misconfiguration is still denied (never let an edit through without its lock); another tool gets nothing', async () => {
    const env = { [HOOK_ENV.socket]: join(runDir, 'missing.sock'), [HOOK_ENV.token]: 't' };
    const edit = io(claudePreToolUse('/tmp/proj/a.txt'), env);
    expect(await runHookCli({ ...edit.io, args: ['bash-activity'] })).toBe(0);
    expect(parsedDeny(edit.stdout())).toMatch(/bash-activity hook received an edit tool/);
    const other = io(claudeBash().replace('"tool_name":"Bash"', '"tool_name":"BashOutput"'), env);
    expect(await runHookCli({ ...other.io, args: ['bash-activity'] })).toBe(0);
    expect(other.stdout()).toBe('');
  });

  it('forwards only the projection: the shell command and its output never leave the hook process', async () => {
    let seen = '';
    const socket = await fakeDaemon((line, s) => {
      seen = line;
      s.end(`${JSON.stringify({ id: (JSON.parse(line) as { id: string }).id, hookOutput: null })}\n`);
    });
    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      const c = io(claudeBash(event), { [HOOK_ENV.socket]: socket, [HOOK_ENV.token]: 'tok' });
      expect(await runHookCli({ ...c.io, args: ['bash-activity'] })).toBe(0);
      const request = JSON.parse(seen) as { hookInput: Record<string, unknown> };
      expect(request.hookInput).toMatchObject({ hook_event_name: event, tool_name: 'Bash', tool_use_id: 'toolu_bash_0001' });
      expect(seen).not.toContain('SECRET');
    }
  });

  it('only exactly `bash-activity` selects the Bash hook: anything else is the fail-closed lock hook', async () => {
    const { hookCliMode } = await import('../../src/hooks/hook-cli.ts');
    expect(hookCliMode(['bash-activity'])).toBe('bash-activity');
    for (const args of [undefined, [], ['Bash-Activity'], ['bash-activity2'], ['--bash-activity'], ['x', 'bash-activity']]) expect(hookCliMode(args), JSON.stringify(args)).toBe('lock');
  });

  it('through the real CLI entry (`node packages/cli/src/main.ts hook …`): the argument reaches the hook — measured', async () => {
    const cliMain = fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url));
    const run = (args: string[], input: string, env: Record<string, string>): Promise<{ ms: number; code: number | null; stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        const started = process.hrtime.bigint();
        const child = spawn(process.execPath, [cliMain, ...args], { env: { PATH: '/usr/bin:/bin', SMURG_NO_BROWSER: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        const timer = setTimeout(() => {
          child.kill('SIGKILL'); // our own child only
          reject(new Error('the hook did not exit within 10 s'));
        }, 10_000);
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ ms: Number(process.hrtime.bigint() - started) / 1e6, code, stdout, stderr });
        });
        child.stdin.end(input);
      });
    const down = { [HOOK_ENV.socket]: join(runDir, 'missing.sock'), [HOOK_ENV.token]: 't' };
    const bash = await run(['hook', 'bash-activity'], claudeBash(), down);
    expect(bash).toMatchObject({ code: 0, stdout: '', stderr: '' });
    const lock = await run(['hook'], claudePreToolUse('/tmp/proj/a.txt'), down);
    expect(lock.code).toBe(0);
    expect(parsedDeny(lock.stdout)).toMatch(/daemon unreachable/);
    // Cost of one Bash hook invocation against a live daemon (each Bash tool call runs it twice: Pre and Post).
    const socket = await fakeDaemon((line, s) => s.end(`${JSON.stringify({ id: (JSON.parse(line) as { id: string }).id, hookOutput: null })}\n`));
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await run(['hook', 'bash-activity'], claudeBash(), { [HOOK_ENV.socket]: socket, [HOOK_ENV.token]: 't' });
      expect(r).toMatchObject({ code: 0, stdout: '' });
      times.push(r.ms);
    }
    times.sort((a, b) => a - b);
    console.log(`[bash-activity hook] node ${process.version}, dev entry (node + TypeScript sources): per invocation ms ${times.map((t) => t.toFixed(0)).join(', ')}; median ${(times[2] as number).toFixed(0)} ms`);
    expect(times[2]).toBeLessThan(2_000);
  }, 60_000);
});
