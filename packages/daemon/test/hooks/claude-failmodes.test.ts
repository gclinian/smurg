// The fail-closed / fail-open split of the two hooks (ARCHITECTURE §7.7, §11 D-13), proven with the REAL `claude`
// against the mock Anthropic API (ARCHITECTURE §0 rule 2: dummy key, 127.0.0.1, isolated HOME / CLAUDE_CONFIG_DIR).
// For each way the daemon can be unavailable to a session —
//   * stopped: the session's own daemon was stopped after the session was registered (it removes its socket),
//   * crashed: a socket file is left with nothing listening (a daemon that died without cleaning up),
//   * missing: nothing at the socket path,
//   * garbage: a socket that answers something that is not the protocol,
//   * slow: a socket that accepts and never answers (the hooks' own deadlines decide) —
// one scripted Claude Code run tries every edit tool (Edit, Write, MultiEdit, NotebookEdit) and one Bash command:
// the LOCK hook must deny every edit (the files stay byte-identical, the model is told the daemon is unreachable),
// and the Bash ACTIVITY hook must let the shell command run (its file appears, its result is not an error) within
// its own 1 s deadline. Skipped LOUDLY without a verified `claude`; SMURG_TEST_CLAUDE_BIN selects another binary
// (both verified versions were run: see docs/ACCEPTANCE.md).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_HOST_USER } from '../../src/testing/index.ts';
import { findClaude, isolatedEnv, MOCK_API_KEY, runClaude, startClaudeDaemon, type ClaudeDaemon } from './claude-harness.ts';
import { registerAgent } from './helpers.ts';
import { startMockAnthropic, type MockAnthropic, type MockStep } from './mock-anthropic.ts';

const found = await findClaude();
const claude = found.binary;
if (claude === null) console.warn(`\n[claude-failmodes] SKIPPED — ${found.reason}\n`);
else console.log(`[claude-failmodes] running against Claude Code ${claude.version} (${claude.path})`);
const V = claude === null ? 'no claude' : `Claude Code ${claude.version}`;

const IAN = { userId: 'dev:ian', name: 'Ian' };
const HOST = { userId: TEST_HOST_USER, name: 'Host' };
const NOTEBOOK = `${JSON.stringify({ cells: [{ cell_type: 'code', id: 'c1', metadata: {}, source: ['print(1)'], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`;
const FILES: Readonly<Record<string, string>> = { 'edit.txt': 'edit me\n', 'write.txt': 'write me\n', 'multi.txt': 'multi me\n', 'nb.ipynb': NOTEBOOK };
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;

describe.skipIf(claude === null)(`the lock hook fails closed and the Bash activity hook fails open when the daemon is unavailable (${V}, mock API)`, () => {
  let env: ClaudeDaemon;
  let stopped: ClaudeDaemon | undefined;
  const servers: Server[] = [];

  beforeAll(async () => {
    env = await startClaudeDaemon(FILES);
    env.daemon.ctx.members.admitMember({ userId: IAN.userId, displayName: IAN.name, role: 'runner', at: Date.now() });
  }, 60_000);

  afterAll(async () => {
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopped?.cleanup().catch(() => {});
    await env?.cleanup();
  }, 60_000);

  const path = (rel: string): string => join(env.root, rel);

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
    servers.push(server);
    return socketPath;
  }

  const steps = (marker: string): MockStep[] => [
    { tools: ['edit.txt', 'write.txt', 'multi.txt', 'nb.ipynb'].map((file) => ({ name: 'Read', input: { file_path: path(file) } })) },
    { tools: [{ name: 'Edit', input: { file_path: path('edit.txt'), old_string: 'edit me', new_string: 'EDITED' } }] },
    { tools: [{ name: 'Write', input: { file_path: path('write.txt'), content: 'WRITTEN\n' } }] },
    { tools: [{ name: 'MultiEdit', input: { file_path: path('multi.txt'), edits: [{ old_string: 'multi me', new_string: 'MULTI-EDITED' }] } }] },
    { tools: [{ name: 'NotebookEdit', input: { notebook_path: path('nb.ipynb'), cell_id: 'c1', new_source: 'print("NOTEBOOK-EDITED")', edit_mode: 'replace' } }] },
    { tools: [{ name: 'Bash', input: { command: `printf 'the shell command ran\\n' > ${marker}`, description: 'write a marker file' } }] },
    { text: 'DONE' },
  ];

  /**
   * One run with the session's hook environment pointing at `socket` (and `token`). Returns the tool results by name,
   * the tools the model was offered, and how long the Bash tool call took between its two neighbouring requests.
   */
  async function runWith(label: string, socket: string, token?: string): Promise<{ results: Map<string, { isError: boolean; text: string }>; offered: readonly string[]; mock: MockAnthropic }> {
    for (const [rel, content] of Object.entries(FILES)) await writeFile(path(rel), content);
    const marker = path(`bash-ran-${label}.txt`);
    const session = registerAgent(env.hooks, IAN, { sandboxed: true });
    const files = await env.hooks.writeSessionFiles(session.sessionId);
    const settings = JSON.parse(await readFile(files.settingsPath, 'utf8')) as { hooks: Record<string, { matcher?: string; hooks: { args?: string[] }[] }[]> };
    // Both hooks are registered: the lock hook for the edit tools, the Bash activity hook for Bash.
    expect(settings.hooks['PreToolUse']?.map((group) => group.matcher)).toEqual(['Edit|Write|MultiEdit|NotebookEdit', 'Bash']);
    expect(settings.hooks['PreToolUse']?.[0]?.hooks[0]?.args?.at(-1)).toBe('hook');
    expect(settings.hooks['PreToolUse']?.[1]?.hooks[0]?.args?.slice(-2)).toEqual(['hook', 'bash-activity']);
    const guest = await env.guestDir(label);
    await env.hooks.seedGuestClaudeConfig({ cfgDir: join(guest, 'cfg'), cwd: env.root, apiKey: MOCK_API_KEY });
    const mock = await startMockAnthropic(steps(marker));
    try {
      const result = await runClaude(claude as NonNullable<typeof claude>, {
        cwd: env.root,
        env: isolatedEnv(guest, mock.url, { ...session.env, SMURG_HOOK_SOCKET: socket, ...(token !== undefined ? { SMURG_SESSION_TOKEN: token } : {}) }),
        args: ['-p', 'run the scripted tools', '--output-format', 'json', '--no-session-persistence', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', ...files.claudeArgs],
        timeoutMs: 150_000,
      });
      expect(result.timedOut).toBe(false);
      const results = new Map<string, { isError: boolean; text: string }>();
      const names = ['Read', 'Read', 'Read', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];
      for (const [i, name] of names.entries()) {
        const r = mock.toolResults().find((x) => x.toolUseId === mock.toolUseId(i + 1));
        if (r) results.set(name === 'Read' ? `Read${i}` : name, r);
      }
      const offered = mock.requests.find((r) => r.kind === 'messages' && r.isMain)?.toolNames ?? [];
      console.log(`[claude-failmodes ${claude?.version}] ${label}: exit ${result.code} in ${result.ms} ms; ${[...results].map(([n, r]) => `${n}:${r.isError ? 'error' : 'ok'}`).join(' ')}`);
      // The files: every edit tool was stopped; the shell command ran.
      for (const [rel, content] of Object.entries(FILES)) expect(await readFile(path(rel), 'utf8'), `${label}: ${rel}`).toBe(content);
      expect(existsSync(marker), `${label}: the Bash command ran`).toBe(true);
      expect(await readFile(marker, 'utf8')).toBe('the shell command ran\n');
      return { results, offered, mock };
    } finally {
      await mock.close();
      env.hooks.unregisterSession(session.sessionId);
    }
  }

  function expectSplit(label: string, run: Awaited<ReturnType<typeof runWith>>, detail: RegExp): void {
    for (const tool of EDIT_TOOLS) {
      const r = run.results.get(tool);
      expect(r, `${label}: a result for ${tool}`).toBeDefined();
      expect(r?.isError, `${label}: ${tool} refused`).toBe(true);
      if (run.offered.includes(tool)) {
        expect(r?.text, `${label}: ${tool} was denied by the lock hook`).toContain('smurg daemon unreachable');
        expect(r?.text).toMatch(detail);
      } else {
        // A tool this Claude Code version does not have cannot be run at all (MultiEdit is gone from newer versions).
        console.log(`[claude-failmodes ${claude?.version}] ${label}: ${tool} is not a tool of this version (${r?.text.slice(0, 80)})`);
      }
    }
    const bash = run.results.get('Bash');
    expect(bash?.isError, `${label}: Bash ran (${bash?.text.slice(0, 120)})`).toBe(false);
    expect(bash?.text ?? '').not.toContain('smurg');
  }

  it(`stopped: the session's daemon was stopped — every edit tool denied, the Bash command runs (${V})`, async () => {
    stopped = await startClaudeDaemon({});
    stopped.daemon.ctx.members.admitMember({ userId: HOST.userId, displayName: HOST.name, role: 'host', at: Date.now() });
    const orphan = registerAgent(stopped.hooks, IAN, { sandboxed: true });
    const socket = orphan.env['SMURG_HOOK_SOCKET'] as string;
    await stopped.daemon.stop();
    console.log(`[claude-failmodes] the stopped daemon's socket path ${existsSync(socket) ? 'still exists' : 'is gone'}`);
    expectSplit('stopped', await runWith('stopped', socket, orphan.token), /connect|ENOENT|ECONNREFUSED/);
  }, 240_000);

  it(`crashed: a stale socket file with nothing listening — every edit tool denied, the Bash command runs (${V})`, async () => {
    const socket = join(env.runDir, 'stale.sock');
    // perl creates a listening socket and exits without removing it: what a daemon killed with SIGKILL leaves behind.
    await new Promise<void>((resolve, reject) =>
      execFile('/usr/bin/perl', ['-MIO::Socket::UNIX', '-MSocket', '-e', 'IO::Socket::UNIX->new(Type => SOCK_STREAM, Local => $ARGV[0], Listen => 1) or die "$!"', socket], (err) => (err ? reject(err) : resolve())),
    );
    expect(existsSync(socket)).toBe(true);
    expectSplit('crashed', await runWith('crashed', socket), /ECONNREFUSED|connect/);
  }, 240_000);

  it(`missing: nothing at the socket path — every edit tool denied, the Bash command runs (${V})`, async () => {
    expectSplit('missing', await runWith('missing', join(env.runDir, 'nothing-here.sock')), /connect|ENOENT/);
  }, 240_000);

  it(`garbage: the socket answers nonsense — every edit tool denied, the Bash command runs (${V})`, async () => {
    const socket = await fakeSocket('garbage.sock', (s) => s.end('{"surprise": true\n'));
    expectSplit('garbage', await runWith('garbage', socket), /malformed|not JSON/);
  }, 240_000);

  it(`slow: the socket never answers — every edit tool denied at the lock hook's 5 s deadline (before Claude Code's own hook timeout lets it through), the Bash command runs after at most the Bash hook's 1 s deadline (${V})`, async () => {
    const socket = await fakeSocket('slow.sock', () => {
      // never answers
    });
    const started = Date.now();
    const run = await runWith('slow', socket);
    expectSplit('slow', run, /timeout/);
    console.log(`[claude-failmodes ${claude?.version}] slow: the whole run took ${Date.now() - started} ms`);
  }, 300_000);
});
