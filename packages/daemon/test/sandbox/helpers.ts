// TEST ONLY. Fixtures for the guest-sandbox tests. Everything a sandboxed process could ever read lives under one
// temp directory that mirrors a real host:
//
//   <base>/home/                      FAKE host home = config.sessions.hostHome (never the developer's real home)
//     .ssh/id_ed25519                 fake key (a marker string)
//     .claude/CLAUDE.md, settings.json   the host's global Claude files (markers)
//     CLAUDE.md                       an ancestor memory file of the share
//     .smurg/                         the daemon state dir (keys, audit, guests/, sessions/)
//     projects/CLAUDE.md              another ancestor memory file
//     projects/app/                   the shared folder
//
// so a broken sandbox could only ever read these fixtures. The daemon is the real one (createDaemon, no relay) with
// the sandbox module; processes are spawned exactly like a session: node-pty running the WrappedCommand.
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { constants as fsConstants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import type { HostSettings } from '@smurg/protocol';
import { createDaemon, type Daemon } from '../../src/daemon.ts';
import type { DaemonContext, FeatureModule } from '../../src/core/context.ts';
import type { SandboxService, SandboxSpec, WrappedCommand } from '../../src/core/interfaces.ts';
import { createLineLogger, type Logger } from '../../src/core/logger.ts';
import { SYSTEM_PRINCIPAL } from '../../src/core/permissions.ts';
import { createTempDir, createTempRunDir, isolatedGitEnv, removeTempDir, removeTempRunDir } from '../../src/testing/index.ts';
import { sandboxModule } from '../../src/sandbox/module.ts';

const execFileAsync = promisify(execFile);

export const isDarwin = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
/** Real-srt tests run where srt runs: macOS (Seatbelt) and Linux (bubblewrap; needs the smurg-bwrap AppArmor profile on Ubuntu 24.04+). */
export const sandboxPlatform = isDarwin || isLinux;

export function marker(label: string): string {
  return `SMURG-${label}-${randomBytes(6).toString('hex')}`;
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export interface Markers {
  readonly sshKey: string;
  readonly hostClaudeMd: string;
  readonly hostClaudeSettings: string;
  readonly homeAncestorMd: string;
  readonly projectsAncestorMd: string;
}

export interface GuestDirs {
  readonly dir: string;
  readonly home: string;
  readonly cfg: string;
  readonly tmp: string;
}

export interface SandboxFixture {
  readonly daemon: Daemon;
  readonly ctx: DaemonContext;
  readonly sandbox: SandboxService;
  readonly base: string;
  readonly home: string;
  readonly share: string;
  readonly stateDir: string;
  readonly runDir: string;
  readonly markers: Markers;
  /** `<stateDir>/guests/<workspaceId>/<userKey>/{home,cfg,tmp}` (ARCHITECTURE §7.1). */
  guest(userKey: string): Promise<GuestDirs>;
  /** `<stateDir>/sessions/<sessionId>/` with a settings.json holding `content`. */
  settingsDir(sessionId: string, content: string): Promise<string>;
  spec(input: { readonly sessionId?: string; readonly command: string; readonly guest: GuestDirs; readonly settingsDir: string } & Partial<SandboxSpec>): SandboxSpec;
  setAllowedDomains(domains: readonly string[]): Promise<HostSettings>;
  gitEnv(): NodeJS.ProcessEnv;
  /** The daemon's warning / error log lines so far (host-side reasons of refusals). */
  warnings(): string[];
  cleanup(): Promise<void>;
}

/** afterEach hook body: prints the daemon's warnings when the test that just ran failed. */
export function printWarningsOnFailure(fixture: SandboxFixture | undefined, context: { readonly task: { readonly result?: { readonly state?: string } } }): void {
  if (fixture !== undefined && context.task.result?.state === 'fail') {
    process.stderr.write(`daemon warnings:\n${fixture.warnings().join('\n') || '(none)'}\n`);
  }
}

export interface SandboxFixtureOptions {
  /** Files inside the share. */
  readonly files?: Readonly<Record<string, string>>;
  readonly git?: boolean;
  readonly module?: FeatureModule;
  /** More modules after the sandbox module (e.g. the real hooks module for the in-sandbox hook self-test). */
  readonly extraModules?: readonly FeatureModule[];
  readonly allowedDomains?: readonly string[];
  /** Default: warnings kept in memory (warnings()). */
  readonly log?: Logger;
  /** config.sessions.claudePath (absolute). */
  readonly claudePath?: string;
  /** config.sessions.selfCommand (how sessions run `smurg hook`); relative paths are taken inside the fake home. */
  readonly selfCommand?: { readonly file: string; readonly args: readonly string[] };
}

export async function createSandboxFixture(options: SandboxFixtureOptions = {}): Promise<SandboxFixture> {
  // Short by construction (Unix socket paths): the hook socket, the test's own sockets and, when TMPDIR is too deep,
  // srt's proxy sockets live here (SandboxServiceImpl → SrtRuntime.acquire socketDir).
  const runDir = await createTempRunDir();
  const warnings: string[] = [];
  let base: string | null = null;
  let daemon: Daemon | null = null;
  try {
    base = await createTempDir('sandbox');
    const home = join(base, 'home');
    const share = join(home, 'projects', 'app');
    const stateDir = join(home, '.smurg');
    const markers: Markers = {
      sshKey: marker('FAKE-SSH-KEY'),
      hostClaudeMd: marker('HOST-CLAUDE-MD'),
      hostClaudeSettings: marker('HOST-CLAUDE-SETTINGS'),
      homeAncestorMd: marker('HOME-ANCESTOR-MD'),
      projectsAncestorMd: marker('PROJECTS-ANCESTOR-MD'),
    };
    await put(join(home, '.ssh', 'id_ed25519'), `${markers.sshKey}\n`);
    await put(join(home, '.ssh', 'id_ed25519.pub'), `${markers.sshKey}-pub\n`);
    await put(join(home, '.claude', 'CLAUDE.md'), `${markers.hostClaudeMd}\n`);
    await put(join(home, '.claude', 'settings.json'), `{"note":"${markers.hostClaudeSettings}"}\n`);
    await put(join(home, 'CLAUDE.md'), `${markers.homeAncestorMd}\n`);
    await put(join(home, 'projects', 'CLAUDE.md'), `${markers.projectsAncestorMd}\n`);
    await mkdir(share, { recursive: true });
    for (const [rel, content] of Object.entries(options.files ?? {})) await put(join(share, rel), content);
    const gitHome = join(base, 'git-home');
    await mkdir(gitHome, { recursive: true });
    const gitEnv = (): NodeJS.ProcessEnv => isolatedGitEnv(gitHome);
    if (options.git) {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: share, env: gitEnv() });
      await execFileAsync('git', ['add', '-A'], { cwd: share, env: gitEnv() });
      await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'initial'], { cwd: share, env: gitEnv() });
    }
    const workspaceId = `ws_test_${randomBytes(9).toString('base64url')}`;
    daemon = await createDaemon({
      config: {
        stateDir,
        runDir,
        shareDir: share,
        workspaceId,
        hostUserId: 'dev:host',
        hostName: 'Host',
        relayUrl: null,
        keepAwake: false,
        defaultSettings: { allowedDomains: [...(options.allowedDomains ?? [])] },
        sessions: {
          hostHome: home,
          ...(options.claudePath === undefined ? {} : { claudePath: options.claudePath }),
          ...(options.selfCommand === undefined ? {} : { selfCommand: { file: resolve(home, options.selfCommand.file), args: options.selfCommand.args.map((arg) => (arg.startsWith('./') ? resolve(home, arg) : arg)) } }),
        },
      },
      modules: [options.module ?? sandboxModule, ...(options.extraModules ?? [])],
      homeDir: home,
      // The daemon's warnings (why a wrap was refused) are kept, so a failing test can print them (warnings()).
      log: options.log ?? createLineLogger({ level: 'warn', write: (line) => warnings.push(line) }),
    });
    await daemon.start();
    const realState = await realpath(stateDir);
    const ctx = daemon.ctx;
    const service = ctx.services.sandbox;
    // Like the sessions module: every process started from one of this fixture's WrappedCommands releases it when it
    // exits (startWrapped), so srt removes bubblewrap's mount points from the fake share between tests (Linux).
    const sandbox: SandboxService = {
      preflight: () => service.preflight(),
      wrap: async (spec) => {
        const wrapped = await service.wrap(spec);
        issuedBy.set(wrapped, service);
        return wrapped;
      },
      setAllowedDomains: (domains) => service.setAllowedDomains(domains),
      release: (wrapped) => service.release?.(wrapped),
      onRevoked: (wrapped, listener) => service.onRevoked?.(wrapped, listener) ?? (() => {}),
    };
    const fixture: SandboxFixture = {
      daemon,
      ctx,
      sandbox,
      base,
      home: await realpath(home),
      share: await realpath(share),
      stateDir: realState,
      runDir,
      markers,
      async guest(userKey) {
        const dir = join(realState, 'guests', workspaceId, userKey);
        const dirs = { dir, home: join(dir, 'home'), cfg: join(dir, 'cfg'), tmp: join(dir, 'tmp') };
        for (const d of [dirs.home, dirs.cfg, dirs.tmp]) await mkdir(d, { recursive: true, mode: 0o700 });
        return dirs;
      },
      async settingsDir(sessionId, content) {
        const dir = join(realState, 'sessions', sessionId);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, 'settings.json'), content, { mode: 0o600 });
        return dir;
      },
      spec(input) {
        const { guest, command, settingsDir, sessionId, ...rest } = input;
        return {
          sessionId: sessionId ?? `ses_${randomBytes(8).toString('hex')}`,
          command,
          rootPath: fixture.share,
          guestDir: guest.dir,
          settingsDir,
          readOnlyPaths: [],
          extraReadPaths: [],
          denyWritePaths: [],
          denyReadPaths: [],
          hookSocketPath: ctx.config.runPaths.hook,
          env: guestEnv(guest),
          ...rest,
        };
      },
      setAllowedDomains: (domains) => ctx.settings.update({ allowedDomains: [...domains] }, SYSTEM_PRINCIPAL),
      gitEnv,
      warnings: () => [...warnings],
      async cleanup() {
        await daemon?.stop();
        await removeTempDir(base as string);
        await removeTempRunDir(runDir);
      },
    };
    return fixture;
  } catch (err) {
    await daemon?.stop().catch(() => {});
    if (base !== null) await removeTempDir(base).catch(() => {});
    await removeTempRunDir(runDir).catch(() => {});
    throw err;
  }
}

/** The clean allow-list environment a guest process gets (ARCHITECTURE §7.6; the sessions module builds the real one). */
export function guestEnv(guest: GuestDirs, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: guest.home,
    CLAUDE_CONFIG_DIR: guest.cfg,
    TMPDIR: guest.tmp,
    USER: 'guest',
    LOGNAME: 'guest',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    DISABLE_AUTOUPDATER: '1',
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Running wrapped commands on a pty, like a session
// ---------------------------------------------------------------------------------------------------------------------

export interface RunningProcess {
  readonly pid: number;
  output(): string;
  waitForOutput(pattern: RegExp, timeoutMs: number): Promise<void>;
  readonly exited: Promise<{ readonly exitCode: number; readonly output: string }>;
  /** Kills this process only (the pty child this helper spawned). */
  kill(): void;
}

/** Which service handed out a WrappedCommand (fixtures record it): the process releases it on exit. */
const issuedBy = new WeakMap<WrappedCommand, SandboxService>();

/** SandboxService.release for a command a fixture wrapped (tests that spawn it their own way call this). */
export function releaseWrapped(wrapped: WrappedCommand): void {
  issuedBy.get(wrapped)?.release?.(wrapped);
}

export function startWrapped(wrapped: WrappedCommand, options: { readonly timeoutMs?: number } = {}): RunningProcess {
  const child = pty.spawn(wrapped.file, [...wrapped.args], { name: 'xterm-256color', cols: 160, rows: 48, cwd: wrapped.cwd, env: { ...wrapped.env } });
  let output = '';
  child.onData((data) => {
    output += data;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
  const exited = new Promise<{ exitCode: number; output: string }>((resolve) => {
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      releaseWrapped(wrapped);
      setTimeout(() => resolve({ exitCode, output: output.replace(/\r/g, '') }), 80);
    });
  });
  return {
    pid: child.pid,
    output: () => output.replace(/\r/g, ''),
    async waitForOutput(pattern, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (!pattern.test(output.replace(/\r/g, ''))) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern} in sandboxed output`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    exited,
    kill: () => child.kill('SIGKILL'),
  };
}

export async function runWrapped(wrapped: WrappedCommand, timeoutMs = 60_000): Promise<{ exitCode: number; output: string }> {
  return startWrapped(wrapped, { timeoutMs }).exited;
}

/**
 * A probe line: runs `cmd` with stdout and stderr discarded (so no file content can reach the test output) and
 * prints `@@name=ok@@` or `@@name=denied@@`.
 */
export function probe(name: string, cmd: string): string {
  return `if ( ${cmd} ) >/dev/null 2>&1; then echo "@@${name}=ok@@"; else echo "@@${name}=denied@@"; fi`;
}

export function results(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of output.matchAll(/@@([A-Za-z0-9_.-]+)=([^@\n]*)@@/g)) out[match[1] as string] = match[2] as string;
  return out;
}

export function q(word: string): string {
  return `'${word.replace(/'/g, `'"'"'`)}'`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sockets and servers on 127.0.0.1 (all closed by the tests that open them)
// ---------------------------------------------------------------------------------------------------------------------

export async function unixEchoServer(path: string, reply: string): Promise<NetServer> {
  const server = createNetServer((socket) => {
    socket.on('data', () => socket.end(`${reply}\n`));
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  await chmod(path, 0o600);
  return server;
}

export interface CountingHttpServer {
  readonly server: HttpServer;
  readonly port: number;
  hits(): number;
  close(): Promise<void>;
}

export async function countingHttpServer(body: string): Promise<CountingHttpServer> {
  let hits = 0;
  const server = createHttpServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function closeServer(server: NetServer | HttpServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------------------------------------------------
// The real `claude` binary (only ever run against the mock Messages API, docs/research/claude-hooks.md)
// ---------------------------------------------------------------------------------------------------------------------

/** config.sessions.claudePath when set, else the first executable `claude` on PATH; realpath (the native binary). */
export async function findClaude(configured: string | null): Promise<string | null> {
  const candidates = configured !== null ? [configured] : (process.env['PATH'] ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'claude'));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // next
    }
  }
  return null;
}

/** `claude --version` with an isolated HOME / CLAUDE_CONFIG_DIR (fixtures only) and no network use. */
export async function claudeVersionOutput(claude: string, scratch: string): Promise<string | null> {
  const home = join(scratch, 'version-home');
  await mkdir(join(home, 'cfg'), { recursive: true });
  try {
    const { stdout } = await execFileAsync(claude, ['--version'], {
      env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: join(home, 'cfg'), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      timeout: 60_000,
    });
    return stdout;
  } catch {
    return null;
  }
}
