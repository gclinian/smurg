// The whole smurg system on this machine in one command (docs/DEVELOPMENT.md, "Local development"):
//
//   scripts/dev-stack.sh [--dir DIR] [--relay-port 8787] [--web-port 5173] [--host-user host] [--role editor]
//                        [--stand-in-claude | --real-claude]
//
//  1. the relay (`pnpm run dev` in apps/relay: wrangler dev --env dev, dev login on) on http://localhost:<relay-port>;
//  2. the web dev server (Vite) on http://localhost:<web-port>, proxying the relay routes;
//  3. `smurg login --dev-user <host-user>`, then `smurg host <DIR>/project` with the links pointing at the web server
//     (`--relay`, `--role`, and `--no-keep-awake`: a dev stack does not keep the machine awake);
//  4. prints the host's own link, the invite link and how a CLI guest joins (the invite carries the WEB origin, the
//     CLI talks to the relay: `--relay`), then waits;
//  5. Ctrl-C (or any of the three ending by itself) stops ALL of them: the host first (gracefully: SIGTERM), then the
//     web server and the relay.
//
// Safety (ARCHITECTURE §0): every child is spawned in its own process group, and only those recorded groups are ever
// signalled (never anything found by scanning the process table); `smurg` runs with a fake HOME and SMURG_HOME inside
// DIR, so nothing touches the developer's ~/.smurg, ~/.claude or shell setup, and with SMURG_NO_BROWSER=1, so it
// never opens the developer's browser. Invite links (they carry their secret)
// go to this terminal only; the relay's and Vite's output goes to DIR/logs/.
//
// Which `claude` an agent session of this stack runs is never left to chance (the daemon takes the first `claude` on
// the host's PATH, and Claude Code finds its login by itself: on macOS in the Keychain, whatever HOME is):
//   --stand-in-claude   the scripted stand-in of the tests (packages/daemon/src/testing/fake-claude.mjs) stands first
//                       on the host's PATH: no account, no network, nothing can be billed;
//   --real-claude       the Claude Code of this machine, with the login it finds: said plainly before anything starts;
//   neither             no `claude` on PATH: agent sessions answer "Claude Code was not found"; one on PATH: as
//                       --real-claude when a person is at the terminal, and REFUSED when nobody is (a script, a test,
//                       an agent: nobody would read what is about to be used; say it with one of the two switches).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, createWriteStream, existsSync } from 'node:fs';
import { access, chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
// TEST TOOL, loaded from its own file (no daemon, no native module): the stand-in `claude` of @smurg/daemon/testing.
import { installFakeClaude, type FakeClaudeScenario } from '../packages/daemon/src/testing/fake-claude.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_MAIN = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const SOCKET_PATH_MAX_BYTES = 103;
const run = promisify(execFile);

const USAGE = `Usage: scripts/dev-stack.sh [options]

  Starts the whole smurg development setup on this machine: the relay (with the development login), the web dev
  server, and smurg host (sharing a sample folder). Ctrl-C stops all of them.
  --dir DIR             the sample project, smurg's state and the logs go here (default: $TMPDIR/smurg-dev-stack)
  --relay-port PORT     the relay's port (default 8787)
  --web-port PORT       the web dev server's port (default 5173)
  --host-user NAME      the host's development account (default host; the identity is dev:host)
  --role ROLE           the role of the invite link: agent (Agent access), editor (the default), viewer
  --stand-in-claude     agent sessions run a scripted stand-in for Claude Code: no account, no network, nothing is
                        billed (its script is DIR/stand-in-claude/fake-claude-scenario.json, read again at every turn)
  --real-claude         agent sessions run the Claude Code installed on this computer, with the login it finds
                        (your own account: agent sessions may cost money)
  With neither: agent sessions run the Claude Code on PATH if there is one, and dev-stack says so before it starts;
  when it is not run from a terminal it asks for one of the two switches instead of choosing.
`;

type ClaudeChoice = 'stand-in' | 'real' | null;

interface Options {
  readonly dir: string;
  readonly relayPort: number;
  readonly webPort: number;
  readonly hostUser: string;
  readonly role: string;
  readonly claude: ClaudeChoice;
}

function fail(message: string): never {
  process.stderr.write(`dev-stack: ${message}\n`);
  process.exit(2);
}

function parseOptions(argv: readonly string[]): Options {
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (arg === '--stand-in-claude' || arg === '--real-claude') {
      switches.add(arg);
      continue;
    }
    const match = /^--(dir|relay-port|web-port|host-user|role)(?:=(.*))?$/.exec(arg);
    if (!match) fail(`unknown argument ${arg} (--help shows the usage)`);
    const value = match[2] ?? argv[++i];
    if (value === undefined) fail(`--${match[1]} needs a value`);
    values[match[1] as string] = value;
  }
  const port = (name: string, fallback: number): number => {
    const text = values[name];
    if (text === undefined) return fallback;
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) fail(`--${name} must be a whole number from 1024 to 65535`);
    return n;
  };
  const hostUser = values['host-user'] ?? 'host';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(hostUser)) fail('--host-user may contain only letters, digits, ".", "_" and "-"');
  const role = values['role'] ?? 'editor';
  if (!['agent', 'editor', 'viewer'].includes(role)) fail('--role must be agent, editor or viewer');
  const relayPort = port('relay-port', 8787);
  const webPort = port('web-port', 5173);
  if (relayPort === webPort) fail('--relay-port and --web-port must differ');
  if (switches.size > 1) fail('--stand-in-claude and --real-claude exclude each other');
  const claude: ClaudeChoice = switches.has('--stand-in-claude') ? 'stand-in' : switches.has('--real-claude') ? 'real' : null;
  return { dir: resolve(values['dir'] ?? join(tmpdir(), 'smurg-dev-stack')), relayPort, webPort, hostUser, role, claude };
}

// ---------------------------------------------------------------------------------------------------------------------
// Which `claude` the agent sessions of this stack run.

/** The first `claude` on `pathEnv`, as the daemon looks for it (sessions/claude.ts resolveClaude); null: none. */
async function claudeOnPath(pathEnv: string | undefined): Promise<string | null> {
  for (const entry of (pathEnv ?? '').split(':')) {
    if (!isAbsolute(entry)) continue;
    try {
      const real = await realpath(join(entry, 'claude'));
      if (!(await stat(real)).isFile()) continue;
      await access(real, fsConstants.X_OK);
      return real;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * What the stand-in does when nobody wrote it a script yet: it says what it is, and three words show an edit, a
 * command and a question (each with the cards a real agent would cause). A developer edits the file to try more.
 */
const STAND_IN_SCENARIO: FakeClaudeScenario = {
  turns: [
    { match: '\\btry write\\b', steps: [{ tool: 'Write', input: { file_path: 'notes/stand-in.md', content: 'Written by the stand-in for Claude Code.\n' } }, { text: 'I wrote notes/stand-in.md.' }] },
    { match: '\\btry run\\b', steps: [{ tool: 'Bash', input: { command: 'echo "hello from the stand-in"', description: 'Say hello' }, ask: true, run: true }, { text: 'The command ran.' }] },
    {
      match: '\\btry ask\\b',
      steps: [
        { tool: 'AskUserQuestion', input: { questions: [{ question: 'Which database should the sample use?', header: 'Database', multiSelect: false, options: [{ label: 'SQLite', description: 'One file' }, { label: 'Postgres', description: 'A server' }] }] } },
        { text: 'Thank you.' },
      ],
    },
    { steps: [{ text: 'This is the stand-in for Claude Code of scripts/dev-stack.sh --stand-in-claude: no model reads this. Send "try write", "try run" or "try ask" to see an edit, a command or a question.' }] },
  ],
};

interface ClaudeSetup {
  /** PATH of `smurg host` (and so of its sessions). */
  readonly path: string;
  /** What this stack's agent sessions will run, in plain words (printed before anything starts and in the summary). */
  readonly lines: readonly string[];
}

/**
 * Decides which `claude` this stack uses, BEFORE anything is created or started. Exits (2) when it would have to
 * choose for nobody. Returns the Claude Code found on PATH (null: none, or the stand-in was asked for).
 */
async function decideClaude(options: Options): Promise<string | null> {
  if (options.claude === 'stand-in') return null;
  const found = await claudeOnPath(process.env['PATH'] ?? '/usr/bin:/bin');
  if (found === null) {
    if (options.claude === 'real') fail('--real-claude: there is no `claude` on PATH');
    return null;
  }
  if (options.claude === null && process.stdout.isTTY !== true) {
    process.stderr.write(
      [
        `dev-stack: a Claude Code is installed on this computer (${found}) and nobody is at a terminal to read what this stack would use.`,
        '  Say which `claude` its agent sessions run:',
        '    --stand-in-claude   a scripted stand-in: no account, no network, nothing is billed',
        '    --real-claude       the Claude Code of this computer with the login it finds (your own account)',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }
  return found;
}

/** Prepares what was decided (the stand-in is installed into DIR) and says it in plain words. */
async function setUpClaude(options: Options, found: string | null, dir: string, home: string): Promise<ClaudeSetup> {
  const pathEnv = process.env['PATH'] ?? '/usr/bin:/bin';
  if (options.claude === 'stand-in') {
    const standInDir = join(dir, 'stand-in-claude');
    await mkdir(standInDir, { recursive: true });
    // A script the developer changed stays as it is.
    let scenario = STAND_IN_SCENARIO;
    try {
      scenario = JSON.parse(await readFile(join(standInDir, 'fake-claude-scenario.json'), 'utf8')) as FakeClaudeScenario;
    } catch {
      // none yet (or not JSON): the default
    }
    const standIn = await installFakeClaude(standInDir, scenario);
    return {
      path: `${standInDir}:${pathEnv}`,
      lines: [
        `agent sessions: the STAND-IN for Claude Code (${standIn.path}): scripted, no account, no network, nothing is billed.`,
        `  its script, read again at every turn: ${standIn.scenarioPath}`,
      ],
    };
  }
  if (found === null) {
    return { path: pathEnv, lines: ['agent sessions: there is no `claude` on PATH, so opening one answers "Claude Code was not found" (--stand-in-claude gives this stack a scripted one).'] };
  }
  return {
    path: pathEnv,
    lines: [
      `agent sessions: the REAL Claude Code of this computer (${found}), with the login it finds.`,
      `  It runs with HOME=${home}, but on macOS Claude Code keeps its login in the Keychain: it is YOUR account,`,
      '  and what an agent session does may be billed to it. --stand-in-claude runs a scripted stand-in instead (no account).',
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Children: one process group each, recorded; only those groups are ever signalled.

interface Recorded {
  readonly name: string;
  readonly child: ChildProcess;
  readonly pid: number;
  exited: boolean;
  readonly exit: Promise<number | null>;
}

const children: Recorded[] = [];
let ownProcessGroup = -1;

async function readOwnProcessGroup(): Promise<number> {
  const { stdout } = await run('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)]);
  const pgid = Number(stdout.trim());
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error('cannot read this process group');
  return pgid;
}

/** Signals the process group of a child THIS script spawned (its pid is the group id: spawned detached). */
function signalGroup(recorded: Recorded, signal: NodeJS.Signals): void {
  const pgid = recorded.pid;
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid || pgid === ownProcessGroup) {
    throw new Error(`refusing to signal process group ${pgid}`);
  }
  // Never signal a group whose leader already exited: its id may already belong to someone else's new group.
  if (recorded.exited) return;
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

function start(name: string, file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; log?: string }): Recorded {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true, // its own process group: Ctrl-C reaches only this script, which stops the groups in order
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!Number.isInteger(child.pid)) throw new Error(`${name} did not start`);
  if (options.log !== undefined) {
    const log = createWriteStream(options.log, { flags: 'a', mode: 0o600 });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
  }
  const recorded: Recorded = {
    name,
    child,
    pid: child.pid as number,
    exited: false,
    exit: new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code))),
  };
  void recorded.exit.then(() => {
    recorded.exited = true;
  });
  children.push(recorded);
  return recorded;
}

/**
 * Waits until no process of the child's group is left (the leader has exited; a grandchild, e.g. the relay's workerd
 * behind pnpm, may take a moment longer to end). Only LOOKS (signal 0): nothing is sent to a group whose leader is
 * gone. Returns false when something is still there after `waitMs`.
 */
async function groupEmpty(recorded: Recorded, waitMs: number): Promise<boolean> {
  const pgid = recorded.pid;
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid || pgid === ownProcessGroup) return true;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch (err) {
      // ESRCH: the group is empty. EPERM: an id that is somebody else's by now, so ours is gone too.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH' || (err as NodeJS.ErrnoException).code === 'EPERM') return true;
      throw err;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

async function stopChild(recorded: Recorded, graceMs: number): Promise<void> {
  // (A leader that ended by itself earlier: its group id may be somebody else's by now. Nothing to look at.)
  if (recorded.exited) return;
  signalGroup(recorded, 'SIGTERM');
  const timer = new Promise<'timeout'>((resolveTimer) => setTimeout(() => resolveTimer('timeout'), graceMs).unref());
  if ((await Promise.race([recorded.exit, timer])) === 'timeout') {
    process.stdout.write(`dev-stack: ${recorded.name} did not end within ${graceMs / 1000} s; killing it.\n`);
    signalGroup(recorded, 'SIGKILL');
    await recorded.exit;
  }
  // "Stopped" means its whole group, not only the process this script started.
  if (!(await groupEmpty(recorded, 5_000))) process.stdout.write(`dev-stack: a process started by ${recorded.name} is still ending (process group ${recorded.pid}).\n`);
}

let stopping: Promise<void> | null = null;

/** Host first (it must say goodbye to its members while the relay still runs), then the web server and the relay. */
function stopAll(): Promise<void> {
  stopping ??= (async () => {
    const byName = (name: string): Recorded[] => children.filter((c) => c.name === name);
    for (const c of byName('smurg host')) await stopChild(c, 20_000);
    await Promise.all([...byName('web'), ...byName('relay'), ...byName('smurg login')].map((c) => stopChild(c, 10_000)));
  })();
  return stopping;
}

// ---------------------------------------------------------------------------------------------------------------------

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.once('error', () => resolvePort(false));
  });
}

async function waitForHttp(url: string, what: string, timeoutMs: number, alive: Recorded): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (alive.exited) throw new Error(`${what} ended while starting (its log is in logs/)`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${what} did not start within ${timeoutMs / 1000} s (${url})`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
}

/** SMURG_HOME must be short: its run/<12 chars>.ctl socket path has to fit macOS's 104-byte limit. */
async function chooseStateDir(dir: string): Promise<string> {
  const inside = join(dir, 'state');
  if (Buffer.byteLength(join(inside, 'run', 'xxxxxxxxxxxx.hook')) <= SOCKET_PATH_MAX_BYTES) return inside;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `/tmp/smurg-dev-${uid}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
}

async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

/** A small sample project (a git repository when git is available, so worktrees can be tried too). */
async function sampleProject(project: string, home: string): Promise<void> {
  if (existsSync(project)) return;
  await mkdir(join(project, 'src'), { recursive: true });
  await mkdir(join(project, 'data'), { recursive: true });
  await writeFile(join(project, 'README.md'), '# smurg sample project\n\nscripts/dev-stack created this folder; change anything you like.\n');
  await writeFile(join(project, 'src', 'hello.ts'), "export function hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
  await writeFile(join(project, 'data', 'notes.txt'), 'A shared folder (not in git): use it to try the read-only links of a worktree.\n');
  await writeFile(join(project, '.gitignore'), 'data/\n');
  const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
  const git = (args: string[]): Promise<unknown> => run('git', ['-c', 'user.name=smurg dev', '-c', 'user.email=dev@smurg.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd: project, env });
  try {
    await git(['init', '-q']);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'sample project']);
  } catch {
    process.stdout.write('dev-stack: could not create a git repository (no git?); the sample project is not one.\n');
  }
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  if (!((major === 22 && minor >= 18) || major === 24) || process.env['SMURG_ROOT'] === undefined) {
    fail('run `source scripts/env.sh` in the repository root first (or use scripts/dev-stack.sh)');
  }
  // Which `claude`: decided (or refused) before a folder is made or a process started.
  const claudeFound = await decideClaude(options);
  for (const port of [options.relayPort, options.webPort]) {
    if (await portInUse(port)) fail(`port ${port} is in use (another dev-stack, or pnpm dev:relay / dev:web?); choose another with --relay-port / --web-port`);
  }
  ownProcessGroup = await readOwnProcessGroup();

  const dir = options.dir;
  await mkdir(dir, { recursive: true });
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  const logs = join(dir, 'logs');
  const stateDir = await chooseStateDir(dir);
  await privateDir(home);
  await privateDir(logs);
  await privateDir(stateDir);
  await sampleProject(project, home);
  if (!(await stat(project)).isDirectory()) fail(`${project} is not a folder`);

  const relayOrigin = `http://localhost:${options.relayPort}`;
  const webOrigin = `http://localhost:${options.webPort}`;
  // SMURG_NO_BROWSER: the dev stack logs in with the dev login; a CLI it starts never opens the developer's browser.
  const claude = await setUpClaude(options, claudeFound, dir, home);
  for (const line of claude.lines) process.stdout.write(`dev-stack: ${line}\n`);
  const smurgEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, SMURG_HOME: stateDir, SMURG_NO_BROWSER: '1', PATH: claude.path };
  delete smurgEnv['SMURG_RELAY_URL'];
  // The stand-in's wrapper names its own script; a variable of the developer's shell must not point it elsewhere.
  delete smurgEnv['FAKE_CLAUDE_SCENARIO'];
  delete smurgEnv['FAKE_CLAUDE_ECHO'];

  let unexpected: string | null = null;
  const watch = (recorded: Recorded): void => {
    void recorded.exit.then((code) => {
      if (stopping === null) {
        unexpected = `${recorded.name} ended (${code === null ? 'by a signal' : `exit code ${code}`})`;
        void stopAll();
      }
    });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping !== null) {
      // A second Ctrl-C: no more waiting.
      for (const c of children) signalGroup(c, 'SIGKILL');
      process.exit(130);
    }
    process.stdout.write(`\ndev-stack: received ${signal}; stopping smurg host, the web server and the relay...\n`);
    void stopAll();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, onSignal);

  try {
    process.stdout.write(`dev-stack: starting the relay (${relayOrigin}, log ${join(logs, 'relay.log')})...\n`);
    const relay = start(
      'relay',
      'pnpm',
      ['run', 'dev', '--var', `RELAY_ISSUER:${relayOrigin}`, '--var', `ALLOWED_ORIGINS:${webOrigin},${relayOrigin}`],
      { cwd: join(ROOT, 'apps', 'relay'), env: { ...process.env, SMURG_RELAY_DEV_PORT: String(options.relayPort) }, log: join(logs, 'relay.log') },
    );
    watch(relay);
    process.stdout.write(`dev-stack: starting the web dev server (${webOrigin}, log ${join(logs, 'web.log')})...\n`);
    const web = start('web', 'pnpm', ['exec', 'vite', '--port', String(options.webPort), '--strictPort'], {
      cwd: join(ROOT, 'apps', 'web'),
      env: { ...process.env, SMURG_RELAY_DEV_ORIGIN: `http://127.0.0.1:${options.relayPort}` },
      log: join(logs, 'web.log'),
    });
    watch(web);
    await waitForHttp(`http://127.0.0.1:${options.relayPort}/healthz`, 'relay', 120_000, relay);
    await waitForHttp(`${webOrigin}/`, 'the web dev server', 60_000, web);

    // The host's relay session: the relay's dev login (only allowed for a relay on a local hostname).
    const login = start('smurg login', process.execPath, [CLI_MAIN, 'login', '--relay', relayOrigin, '--dev-user', options.hostUser], { cwd: project, env: smurgEnv });
    let loginOut = '';
    login.child.stdout?.on('data', (chunk: Buffer) => (loginOut += chunk.toString('utf8')));
    login.child.stderr?.on('data', (chunk: Buffer) => (loginOut += chunk.toString('utf8')));
    if ((await login.exit) !== 0) throw new Error(`smurg login failed: ${loginOut.trim()}`);

    process.stdout.write('dev-stack: starting smurg host...\n');
    const host = start(
      'smurg host',
      process.execPath,
      [CLI_MAIN, 'host', project, '--relay', relayOrigin, '--web-origin', webOrigin, '--role', options.role, '--no-keep-awake'],
      { cwd: project, env: smurgEnv },
    );
    watch(host);
    let hostOut = '';
    // The host's own summary (links included) goes to this terminal only.
    host.child.stdout?.on('data', (chunk: Buffer) => {
      hostOut += chunk.toString('utf8');
      process.stdout.write(chunk);
    });
    host.child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    const deadline = Date.now() + 60_000;
    while ((hostOut.match(/\/join\//g) ?? []).length < 2) {
      if (stopping !== null || host.exited) throw new Error('smurg host did not start (see the messages above)');
      if (Date.now() > deadline) throw new Error('smurg host did not print the invite links within 60 s');
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    const links = hostOut.match(/https?:\/\/\S+\/join\/\S+/g) ?? [];
    const guestHome = join(dir, 'guest-amy', 'home');
    const guestState = join(dir, 'guest-amy', 'state');
    await privateDir(guestHome);
    await privateDir(guestState);
    const guestEnv = `HOME=${guestHome} SMURG_HOME=${guestState} SMURG_NO_BROWSER=1`;
    const realProject = await realpath(project);
    process.stdout.write(
      [
        '',
        '================ the smurg development stack is up ================',
        `relay: ${relayOrigin} (development login on)`,
        `web: ${webOrigin}   <- use localhost, nothing else (the relay's cookie and Origin checks are tied to localhost)`,
        `host: dev:${options.hostUser} (HOME=${home}, SMURG_HOME=${stateDir})`,
        `shared folder: ${realProject}`,
        ...claude.lines,
        `host link: ${links[0] ?? '(not found)'}`,
        `invite link (role ${options.role}): ${links[1] ?? '(not found)'}`,
        '',
        'Open the invite link in a browser (another profile or a private window) and join with the development login (amy, for example).',
        'A teammate joining from the CLI instead (another terminal; amy has a HOME and a SMURG_HOME of her own):',
        `  ${guestEnv} node ${CLI_MAIN} login --no-browser --dev-user amy --relay ${relayOrigin}`,
        `  ${guestEnv} node ${CLI_MAIN} attach --invite - --relay ${relayOrigin}     <- run it, then paste the invite link`,
        `  (The invite link points at the web server ${webOrigin}; the CLI goes straight to the relay with --relay ${relayOrigin}, because logins are kept per URL.)`,
        'The host attaching to a session on this machine:',
        `  HOME=${home} SMURG_HOME=${stateDir} node ${CLI_MAIN} attach`,
        'Ctrl-C stops everything (smurg host, the web server, the relay).',
        `(process groups: relay ${relay.pid}, web ${web.pid}, smurg host ${host.pid})`,
        '',
      ].join('\n'),
    );
    await new Promise<void>((resolveWait) => {
      const timer = setInterval(() => {
        if (stopping !== null) {
          clearInterval(timer);
          resolveWait();
        }
      }, 200);
    });
  } catch (err) {
    process.stderr.write(`dev-stack: ${err instanceof Error ? err.message : String(err)}\n`);
    unexpected ??= 'start-failed';
  }
  await stopAll();
  process.stdout.write('dev-stack: everything has stopped.\n');
  if (unexpected !== null) {
    if (unexpected !== 'start-failed') process.stderr.write(`dev-stack: ${unexpected}; the rest was stopped too (the logs are in ${logs}).\n`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  async (err: unknown) => {
    process.stderr.write(`dev-stack: failed (${err instanceof Error ? err.message : String(err)})\n`);
    await stopAll().catch(() => {});
    process.exit(1);
  },
);
