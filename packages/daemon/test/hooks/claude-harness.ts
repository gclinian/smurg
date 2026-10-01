// TEST ONLY: running the REAL `claude` binary safely (ARCHITECTURE §0): against the mock Anthropic API on 127.0.0.1
// with a dummy key, in an environment built from scratch (temporary HOME / CLAUDE_CONFIG_DIR / TMPDIR, never the
// developer's), and signalling nothing but the process group this harness spawned and recorded.
//
// The daemon is the real one (createDaemon, no relay) with the real hook server, configured the way the CLI does it:
// config.sessions.selfCommand = node + an entry script that runs `smurg hook` / `smurg mcp` from this package.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, constants, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CLAUDE_MIN_VERSION, CLAUDE_VERIFIED_VERSIONS, claudeVersionVerdict } from '../../src/core/config.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { createDaemon, type Daemon } from '../../src/daemon.ts';
import { HookServerImpl } from '../../src/hooks/hook-server.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { createTempDir, createTempProject, createTempRunDir, removeTempDir, removeTempRunDir, TEST_HOST_USER } from '../../src/testing/index.ts';
import { fakeServices, type FakeServices } from './fakes.ts';

const execFileAsync = promisify(execFile);

/** Anthropic API keys are never real in tests; this one only has to look like a key. */
export const MOCK_API_KEY = 'sk-ant-mock-000-dummy-key-for-tests-0001';

const HOOK_CLI = fileURLToPath(new URL('../../src/hooks/hook-cli.ts', import.meta.url));
const COORD_SERVER = fileURLToPath(new URL('../../src/mcp/coord-server.ts', import.meta.url));

export interface ClaudeBinary {
  readonly path: string;
  readonly version: string;
}

/** A verified `claude` (SMURG_TEST_CLAUDE_BIN, else `claude` on PATH), or the reason why the tests must skip. */
export async function findClaude(): Promise<{ readonly binary: ClaudeBinary | null; readonly reason: string }> {
  const configured = process.env['SMURG_TEST_CLAUDE_BIN'];
  let path: string | null = null;
  if (configured !== undefined && configured !== '') {
    if (!isAbsolute(configured)) return { binary: null, reason: `SMURG_TEST_CLAUDE_BIN must be absolute (${configured})` };
    path = configured;
  } else {
    for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
      if (!isAbsolute(dir)) continue;
      const candidate = join(dir, 'claude');
      if (await access(candidate, constants.X_OK).then(() => true, () => false)) {
        path = candidate;
        break;
      }
    }
  }
  if (path === null) return { binary: null, reason: 'no `claude` binary on PATH (set SMURG_TEST_CLAUDE_BIN to a verified Claude Code)' };
  const scratch = await createTempDir('claude-version');
  try {
    for (const sub of ['home', 'cfg', 'tmp']) await mkdir(join(scratch, sub), { mode: 0o700 });
    const { stdout } = await execFileAsync(path, ['--version'], { env: isolatedEnv(scratch, 'http://127.0.0.1:9'), cwd: scratch, timeout: 30_000 });
    const verdict = claudeVersionVerdict(stdout, { claudeMinVersion: CLAUDE_MIN_VERSION, claudeVerifiedVersions: CLAUDE_VERIFIED_VERSIONS });
    if (!verdict.ok) return { binary: null, reason: `${path} prints no usable version (${verdict.reason}): ${stdout.trim().slice(0, 80)}` };
    if (verdict.warning !== null) return { binary: null, reason: `${path} is Claude Code ${verdict.version}, not a verified version (${CLAUDE_VERIFIED_VERSIONS.join(', ')}; ARCHITECTURE §7.6)` };
    return { binary: { path, version: verdict.version }, reason: '' };
  } catch (err) {
    return { binary: null, reason: `${path} --version failed: ${err instanceof Error ? err.message.slice(0, 120) : 'error'}` };
  } finally {
    await removeTempDir(scratch);
  }
}

/**
 * An environment built from nothing (the scrub list of claude-hooks.md §4): temporary HOME, CLAUDE_CONFIG_DIR and
 * TMPDIR under `dir`, the mock API with a dummy key, no telemetry, no auto-update, no browser.
 */
export function isolatedEnv(dir: string, mockUrl: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: join(dir, 'home'),
    CLAUDE_CONFIG_DIR: join(dir, 'cfg'),
    TMPDIR: join(dir, 'tmp'),
    USER: process.env['USER'] ?? 'smurg-test',
    LOGNAME: process.env['USER'] ?? 'smurg-test',
    SHELL: '/bin/zsh',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    ANTHROPIC_BASE_URL: mockUrl,
    ANTHROPIC_API_KEY: MOCK_API_KEY,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    BROWSER: '/usr/bin/true',
    ...extra,
  };
}

/**
 * Trusts `cwd` in the isolated `<cfgDir>/.claude.json` (projects[realpath(cwd)].hasTrustDialogAccepted): without it the
 * trust dialog withholds every hook, and on 2.1.283 its default answer quits. With `apiKey`, also approves its last 20
 * characters (the "Detected a custom API key" dialog defaults to "No" on 2.1.283). Keeps whatever the file already
 * holds. The product does not write this file (every session uses the host's own Claude Code config); only these
 * tests, whose CLAUDE_CONFIG_DIR starts empty, need it. Returns the file's path.
 */
export async function seedClaudeTrust(input: { readonly cfgDir: string; readonly cwd: string; readonly apiKey?: string }): Promise<string> {
  const path = join(input.cfgDir, '.claude.json');
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  let existing: unknown = null;
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    existing = null;
  }
  const config: Record<string, unknown> = isObject(existing) ? { ...existing } : {};
  const projects: Record<string, unknown> = isObject(config['projects']) ? { ...config['projects'] } : {};
  const cwd = await realpath(input.cwd);
  const current = projects[cwd];
  projects[cwd] = { ...(isObject(current) ? current : {}), hasTrustDialogAccepted: true };
  config['projects'] = projects;
  if (input.apiKey !== undefined && input.apiKey.length > 0) {
    const suffix = input.apiKey.slice(-20);
    const responses: Record<string, unknown> = isObject(config['customApiKeyResponses']) ? { ...config['customApiKeyResponses'] } : {};
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    responses['approved'] = [...list(responses['approved']).filter((item) => item !== suffix), suffix];
    responses['rejected'] = list(responses['rejected']).filter((item) => item !== suffix);
    config['customApiKeyResponses'] = responses;
  }
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

let ownGroup: number | null = null;

/** This process's group, so it can never be the target of a kill (ARCHITECTURE §0 rule 1). */
export async function ownProcessGroup(): Promise<number> {
  if (ownGroup !== null) return ownGroup;
  const { stdout } = await execFileAsync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)]);
  const value = Number(stdout.trim());
  if (!Number.isInteger(value) || value <= 1) throw new Error('cannot read our own process group');
  ownGroup = value;
  return value;
}

/** SIGKILL the process group of a child THIS harness spawned (detached, so it leads its own group). */
export function killSpawnedGroup(pgid: number | undefined, own: number): void {
  if (pgid === undefined || !Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid || pgid === own) {
    throw new Error(`refusing to signal process group ${String(pgid)}`);
  }
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // already gone
  }
}

export interface ClaudeRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly ms: number;
  /** `--output-format json` result (permission_denials, …). */
  readonly final: Record<string, unknown> | null;
}

/** Runs `claude` non-interactively; kills its process group (and only that) if it does not finish in time. */
export async function runClaude(binary: ClaudeBinary, options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly args: readonly string[]; readonly timeoutMs?: number }): Promise<ClaudeRun> {
  const own = await ownProcessGroup();
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(binary.path, [...options.args], { cwd: options.cwd, env: { ...options.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const pgid = child.pid;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      killSpawnedGroup(pgid, own);
    }, options.timeoutMs ?? 90_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let final: Record<string, unknown> | null = null;
      try {
        final = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        final = null;
      }
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started, final });
    });
  });
}

export interface ClaudeDaemon {
  readonly daemon: Daemon;
  readonly hooks: HookServerImpl;
  readonly fakes: FakeServices;
  readonly root: string;
  readonly base: string;
  readonly runDir: string;
  /** A fresh isolated dir (home, cfg, tmp; see isolatedEnv) for one claude run. */
  isolatedDir(label: string): Promise<string>;
  cleanup(): Promise<void>;
}

/** The real daemon (no relay) with the real hook server and a `smurg` stand-in for selfCommand. */
export async function startClaudeDaemon(files: Readonly<Record<string, string>>): Promise<ClaudeDaemon> {
  const base = await createTempDir('claude-e2e');
  const runDir = await createTempRunDir();
  try {
    const root = await createTempProject(base, 'proj', { files });
    const entry = join(base, 'smurg-entry.mjs');
    // What `smurg hook` / `smurg mcp` do (the CLI dispatches the same way before loading anything else).
    await writeFile(
      entry,
      [
        `const command = process.argv[2];`,
        `if (command === 'hook') { const { runHookCli } = await import(${JSON.stringify(HOOK_CLI)}); process.exitCode = await runHookCli(); }`,
        `else if (command === 'mcp') { const { runMcpServer } = await import(${JSON.stringify(COORD_SERVER)}); process.exitCode = await runMcpServer(); }`,
        `else { process.stderr.write('usage: smurg-entry hook|mcp\\n'); process.exitCode = 2; }`,
        '',
      ].join('\n'),
    );
    const fakes = fakeServices({ sessions: true });
    const daemon = await createDaemon({
      config: {
        stateDir: join(base, 'state'),
        runDir,
        shareDir: root,
        workspaceId: `ws_claude_${randomBytes(9).toString('hex')}`,
        hostUserId: TEST_HOST_USER,
        hostName: 'Host',
        relayUrl: null,
        keepAwake: false,
        sessions: { selfCommand: { file: process.execPath, args: [entry] } },
      },
      modules: [fakes.module, hooksModule],
      log: silentLogger,
      homeDir: join(base, 'home'),
    });
    await daemon.start();
    const hooks = daemon.ctx.services.hooks;
    if (!(hooks instanceof HookServerImpl)) throw new Error('the hooks slot is not the HookServerImpl');
    let runs = 0;
    return {
      daemon,
      hooks,
      fakes,
      root,
      base,
      runDir,
      isolatedDir: async (label: string) => {
        runs += 1;
        const dir = join(base, `run-${runs}-${label.replace(/[^a-z0-9-]/gi, '')}`);
        for (const sub of ['home', 'cfg', 'tmp']) await mkdir(join(dir, sub), { recursive: true, mode: 0o700 });
        return dir;
      },
      cleanup: async () => {
        await daemon.stop();
        await removeTempDir(base);
        await removeTempRunDir(runDir);
      },
    };
  } catch (err) {
    await removeTempDir(base).catch(() => {});
    await removeTempRunDir(runDir).catch(() => {});
    throw err;
  }
}
