// `node packages/cli/src/main.ts` as a real Node process (no vitest transform): type stripping works for the CLI and
// for @smurg/protocol / @smurg/daemon reached through pnpm's symlinks; unknown commands are usage errors; and the two
// entry points Claude Code runs inside every session (`smurg hook` once per tool call, `smurg mcp` once per session)
// start fast because main.ts dispatches them before loading anything else.
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { versionBanner } from '../src/version.ts';
import { makeDirs, isolatedEnv, type Dirs } from './helpers.ts';

const run = promisify(execFile);
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
/** The release version every workspace package carries (scripts/release-assets.sh --publish-checks keeps them equal). */
const VERSION = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const RECORDER = fileURLToPath(new URL('./fixtures/record-modules.mjs', import.meta.url));

/**
 * The start-up bound of the task: `smurg hook` / `smurg mcp` must start in well under this. It bounds the CPU time
 * the process itself uses from spawn to exit (user + system), which is what "starts fast" says about the CODE: how
 * much it loads and does before it answers. The wall time from spawn to exit is that plus whatever else the machine
 * runs (this file is one of a hundred the gate runs at once; a wall-time bound was red while the Linux VM's suite
 * loaded the same machine, with nothing wrong in the hook), so it is printed for the record and not asserted.
 */
const STARTUP_BOUND_MS = 300;

let dirs: Dirs | null = null;
afterEach(async () => {
  await dirs?.cleanup();
  dirs = null;
});

interface Timed {
  readonly code: number | null;
  /** Wall time from spawn to exit. */
  readonly ms: number;
  /** CPU time the process used (user + system), as the shell that started it measured it. */
  readonly cpuMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What bash's `time` prints last on stderr with this format: the user and the system CPU seconds of the command. */
const TIME_FORMAT = 'smurg-cpu %3U %3S';
const TIME_LINE = /(?:^|\n)smurg-cpu ([0-9.]+) ([0-9.]+)\n?$/;

/**
 * Runs `node [nodeArgs] main.ts <args>` with `input` on stdin (then EOF), under bash's `time`: the wall time from
 * spawn to exit, and the CPU time of the node process alone.
 */
function timed(args: readonly string[], input: string, env: Record<string, string>, nodeArgs: readonly string[] = []): Promise<Timed> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn('/bin/bash', ['-c', 'time "$@"', 'time', process.execPath, ...nodeArgs, MAIN, ...args], { env: { ...env, TIMEFORMAT: TIME_FORMAT }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('exit', (code) => {
      const ms = performance.now() - started;
      const measured = TIME_LINE.exec(stderr);
      if (measured === null) {
        reject(new Error(`the shell did not report the CPU time: ${stderr.slice(-200)}`));
        return;
      }
      resolve({ code, ms, cpuMs: (Number(measured[1]) + Number(measured[2])) * 1000, stdout, stderr: stderr.slice(0, measured.index) });
    });
    child.stdin.end(input);
  });
}

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

/** What a real PreToolUse hook gets on stdin (no daemon behind it here, so the hook must deny: fail closed). */
const PRE_TOOL_USE = JSON.stringify({
  session_id: 'test',
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: '/tmp/x.txt', old_string: 'a', new_string: 'b' },
  cwd: '/tmp',
});

const MCP_INITIALIZE = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })}\n`;

describe('smurg CLI', () => {
  it('builds a version banner from all workspace packages', () => {
    expect(versionBanner()).toBe(`smurg ${VERSION} (protocol v4, daemon ${VERSION}, node ${process.versions.node})`);
  });

  it('runs from source with plain node', async () => {
    const { stdout, stderr } = await run(process.execPath, [MAIN, '--version'], { timeout: 20_000 });
    expect(stdout.trim()).toBe(`smurg ${VERSION} (protocol v4, daemon ${VERSION}, node ${process.versions.node})`);
    expect(stderr).toBe('');
  });

  it('an unknown command is a usage error: exit 2 with a message', async () => {
    await expect(run(process.execPath, [MAIN, 'no-such-command'], { timeout: 20_000 })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('smurg: Unknown command "no-such-command"'),
    });
  });

  it('--help lists every command', async () => {
    const { stdout } = await run(process.execPath, [MAIN, '--help'], { timeout: 20_000 });
    for (const command of ['host', 'attach', 'stop', 'status', 'login', 'logout', 'update', 'uninstall', 'licenses']) expect(stdout).toContain(`  ${command}`);
    expect(stdout).toContain('SMURG_HOME');
    expect(stdout).toContain('https://smurg.ai/docs/');
  });

  it('smurg update / smurg uninstall: --help works from source, and both refuse to act on a source checkout (exit 2, nothing asked of the network)', async () => {
    dirs = await makeDirs();
    // A base no request could reach: the refusal comes first.
    const env = isolatedEnv(dirs, { SMURG_INSTALL_BASE_URL: 'http://127.0.0.1:9' });
    for (const command of ['update', 'uninstall']) {
      const help = await run(process.execPath, [MAIN, command, '--help'], { env, timeout: 20_000 });
      expect(help.stdout).toContain(`Usage: smurg ${command}`);
      await expect(run(process.execPath, command === 'uninstall' ? [MAIN, command, '--yes'] : [MAIN, command], { env, timeout: 20_000 })).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining('runs from source'),
      });
    }
  });
});

describe('smurg hook / smurg mcp start fast (they run inside every Claude Code session)', () => {
  it(`smurg hook and smurg mcp start in well under ${STARTUP_BOUND_MS} ms of their own CPU time, from spawn to exit`, async () => {
    dirs = await makeDirs();
    const env = isolatedEnv(dirs);
    // One warm-up run each: the first start of a file after a change pays for Node's compile cache.
    await timed(['hook'], PRE_TOOL_USE, env);
    await timed(['mcp'], MCP_INITIALIZE, env);
    const hook: Timed[] = [];
    const mcp: Timed[] = [];
    for (let i = 0; i < 5; i++) {
      const h = await timed(['hook'], PRE_TOOL_USE, env);
      // No daemon: the hook fails closed with a JSON deny and still exits 0 (ARCHITECTURE §7.7).
      expect(h.code).toBe(0);
      expect(JSON.parse(h.stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
      hook.push(h);
      const m = await timed(['mcp'], MCP_INITIALIZE, env);
      expect(m.code).toBe(0);
      expect(JSON.parse(m.stdout.split('\n')[0] as string)).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'smurg' } } });
      mcp.push(m);
    }
    // The CPU time includes starting Node itself (~40 ms here). The bound is checked on the run that used least (a
    // run can be charged for a cold cache, never credited with work it did not do); wall times are for the record.
    const least = (runs: readonly Timed[], pick: (run: Timed) => number): number => Math.min(...runs.map(pick));
    console.info(
      `smurg hook: CPU min ${Math.round(least(hook, (run) => run.cpuMs))} ms, wall min ${Math.round(least(hook, (run) => run.ms))} ms, wall median ${Math.round(median(hook.map((run) => run.ms)))} ms; ` +
        `smurg mcp: CPU min ${Math.round(least(mcp, (run) => run.cpuMs))} ms, wall min ${Math.round(least(mcp, (run) => run.ms))} ms, wall median ${Math.round(median(mcp.map((run) => run.ms)))} ms`,
    );
    expect(least(hook, (run) => run.cpuMs)).toBeLessThan(STARTUP_BOUND_MS);
    expect(least(mcp, (run) => run.cpuMs)).toBeLessThan(STARTUP_BOUND_MS);
    expect(least(hook, (run) => run.cpuMs)).toBeGreaterThan(0);
  });

  // DESIGN v0.5.0 §2.10 (G1), §6: `smurg hook` is Claude Code's PreToolUse hook for EVERY tool (the tool gate), and
  // a daemon that cannot be reached refuses each of them, so nothing of an orphaned agent runs unattended.
  it('smurg hook fails closed for every tool when the daemon is not reachable: a shell command, a read, a fetch, a subagent, a question, an MCP tool, a tool nobody knows yet', async () => {
    dirs = await makeDirs();
    const env = isolatedEnv(dirs);
    for (const tool of ['Bash', 'Read', 'Grep', 'Write', 'WebFetch', 'Task', 'AskUserQuestion', 'mcp__smurg__check_plan', 'ToolOfTomorrow']) {
      const input = JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: 'ls', file_path: '/tmp/x.txt', url: 'https://example.com' }, cwd: '/tmp' });
      const result = await timed(['hook'], input, env);
      expect(result.code, tool).toBe(0);
      expect(JSON.parse(result.stdout), tool).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    }
  });

  it.each([
    ['hook', PRE_TOOL_USE, /\/daemon\/src\/hooks\/hook-cli\.ts$/],
    ['mcp', MCP_INITIALIZE, /\/daemon\/src\/mcp\/coord-server\.ts$/],
  ])('smurg %s loads only its own entry point at run time: not the dispatcher, not the daemon, nothing heavy', async (command, input, entry) => {
    dirs = await makeDirs();
    const out = join(dirs.stateDir, `modules-${command}.json`);
    const result = await timed([command], input, isolatedEnv(dirs, { SMURG_RECORD_MODULES_OUT: out }), ['--import', RECORDER]);
    expect(result.code).toBe(0);
    const loaded = (JSON.parse(await readFile(out, 'utf8')) as string[]).filter((url) => url.startsWith('file:'));
    expect(loaded.some((url) => entry.test(url))).toBe(true);
    const forbidden = [
      /\/cli\/src\/(cli|commands|channel|attach|relay|state)\//, // the dispatcher and every other command
      /\/cli\/src\/version\.ts$/,
      /\/daemon\/src\/(daemon|index)\.ts$/,
      /\/daemon\/src\/(core|sessions|files|docs|locks|worktree|suggest|local|net)\//,
      /\/protocol\/src\//,
      /node_modules\/(\.pnpm\/)?(node-pty|@parcel|yjs|y-protocols|@xterm|zod|@msgpack|@noble|ws)[@/]/,
    ];
    const offending = loaded.filter((url) => forbidden.some((pattern) => pattern.test(url)));
    expect(offending).toEqual([]);
  });
});
