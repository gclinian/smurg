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

/** The start-up bound of the task: `smurg hook` / `smurg mcp` must start in well under this. */
const STARTUP_BOUND_MS = 300;

let dirs: Dirs | null = null;
afterEach(async () => {
  await dirs?.cleanup();
  dirs = null;
});

interface Timed {
  readonly code: number | null;
  readonly ms: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node [nodeArgs] main.ts <args>` with `input` on stdin (then EOF); wall time from spawn to exit. */
function timed(args: readonly string[], input: string, env: Record<string, string>, nodeArgs: readonly string[] = []): Promise<Timed> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [...nodeArgs, MAIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, ms: performance.now() - started, stdout, stderr }));
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
    expect(versionBanner()).toBe(`smurg ${VERSION} (protocol v2, daemon ${VERSION}, node ${process.versions.node})`);
  });

  it('runs from source with plain node', async () => {
    const { stdout, stderr } = await run(process.execPath, [MAIN, '--version'], { timeout: 20_000 });
    expect(stdout.trim()).toBe(`smurg ${VERSION} (protocol v2, daemon ${VERSION}, node ${process.versions.node})`);
    expect(stderr).toBe('');
  });

  it('an unknown command is a usage error: exit 2 with a zh-TW message', async () => {
    await expect(run(process.execPath, [MAIN, 'no-such-command'], { timeout: 20_000 })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('不認得的指令「no-such-command」'),
    });
  });

  it('--help lists every command in zh-TW', async () => {
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
      expect(help.stdout).toContain(`用法：smurg ${command}`);
      await expect(run(process.execPath, command === 'uninstall' ? [MAIN, command, '--yes'] : [MAIN, command], { env, timeout: 20_000 })).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining('從原始碼執行'),
      });
    }
  });
});

describe('smurg hook / smurg mcp start fast (they run inside every Claude Code session)', () => {
  it(`smurg hook and smurg mcp start in well under ${STARTUP_BOUND_MS} ms — measured from spawn to exit`, async () => {
    dirs = await makeDirs();
    const env = isolatedEnv(dirs);
    // One warm-up run each: the first start of a file after a change pays for Node's compile cache.
    await timed(['hook'], PRE_TOOL_USE, env);
    await timed(['mcp'], MCP_INITIALIZE, env);
    const hook: number[] = [];
    const mcp: number[] = [];
    for (let i = 0; i < 5; i++) {
      const h = await timed(['hook'], PRE_TOOL_USE, env);
      // No daemon: the hook fails closed with a JSON deny and still exits 0 (ARCHITECTURE §7.7).
      expect(h.code).toBe(0);
      expect(JSON.parse(h.stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
      hook.push(h.ms);
      const m = await timed(['mcp'], MCP_INITIALIZE, env);
      expect(m.code).toBe(0);
      expect(JSON.parse(m.stdout.split('\n')[0] as string)).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'smurg' } } });
      mcp.push(m.ms);
    }
    // Wall time includes starting Node itself (~40 ms here). The machine is shared with other builds, so the bound is
    // checked on the fastest run (a load spike cannot fake a fast start); the median is reported for the record.
    console.info(`smurg hook: min ${Math.round(Math.min(...hook))} ms, median ${Math.round(median(hook))} ms; smurg mcp: min ${Math.round(Math.min(...mcp))} ms, median ${Math.round(median(mcp))} ms`);
    expect(Math.min(...hook)).toBeLessThan(STARTUP_BOUND_MS);
    expect(Math.min(...mcp)).toBeLessThan(STARTUP_BOUND_MS);
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
