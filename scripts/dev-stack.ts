// The whole smurg system on this machine in one command (README 「本機開發」):
//
//   scripts/dev-stack.sh [--dir DIR] [--relay-port 8787] [--web-port 5173] [--host-user host] [--role editor]
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
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_MAIN = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const SOCKET_PATH_MAX_BYTES = 103;
const run = promisify(execFile);

const USAGE = `用法：scripts/dev-stack.sh [選項]

  在這台電腦上啟動整個 smurg 開發環境：relay（開發用登入）、網頁開發伺服器、smurg host（分享一個範例資料夾）。
  按 Ctrl-C 全部停止。
  --dir 資料夾          範例專案、smurg 狀態與紀錄檔放在這裡（預設：$TMPDIR/smurg-dev-stack）
  --relay-port 埠號     relay 的埠號（預設 8787）
  --web-port 埠號       網頁開發伺服器的埠號（預設 5173）
  --host-user 名稱      主人的開發用帳號（預設 host，身分是 dev:host）
  --role 角色           邀請連結的角色：agent（可使用 agent）、editor（預設）、viewer
`;

interface Options {
  readonly dir: string;
  readonly relayPort: number;
  readonly webPort: number;
  readonly hostUser: string;
  readonly role: string;
}

function fail(message: string): never {
  process.stderr.write(`dev-stack：${message}\n`);
  process.exit(2);
}

function parseOptions(argv: readonly string[]): Options {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const match = /^--(dir|relay-port|web-port|host-user|role)(?:=(.*))?$/.exec(arg);
    if (!match) fail(`不認得的參數 ${arg}（--help 查看用法）`);
    const value = match[2] ?? argv[++i];
    if (value === undefined) fail(`--${match[1]} 需要一個值`);
    values[match[1] as string] = value;
  }
  const port = (name: string, fallback: number): number => {
    const text = values[name];
    if (text === undefined) return fallback;
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) fail(`--${name} 必須是 1024 到 65535 的整數`);
    return n;
  };
  const hostUser = values['host-user'] ?? 'host';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(hostUser)) fail('--host-user 只能包含英數字、「.」「_」「-」');
  const role = values['role'] ?? 'editor';
  if (!['agent', 'editor', 'viewer'].includes(role)) fail('--role 只能是 agent、editor 或 viewer');
  const relayPort = port('relay-port', 8787);
  const webPort = port('web-port', 5173);
  if (relayPort === webPort) fail('--relay-port 和 --web-port 不能相同');
  return { dir: resolve(values['dir'] ?? join(tmpdir(), 'smurg-dev-stack')), relayPort, webPort, hostUser, role };
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

async function stopChild(recorded: Recorded, graceMs: number): Promise<void> {
  if (recorded.exited) return;
  signalGroup(recorded, 'SIGTERM');
  const timer = new Promise<'timeout'>((resolveTimer) => setTimeout(() => resolveTimer('timeout'), graceMs).unref());
  if ((await Promise.race([recorded.exit, timer])) === 'timeout') {
    process.stdout.write(`dev-stack：${recorded.name} 沒有在 ${graceMs / 1000} 秒內結束，強制結束。\n`);
    signalGroup(recorded, 'SIGKILL');
    await recorded.exit;
  }
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
    if (alive.exited) throw new Error(`${what} 在啟動時結束了（紀錄檔在 logs/ 裡）`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${what} 沒有在 ${timeoutMs / 1000} 秒內啟動（${url}）`);
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
  await writeFile(join(project, 'README.md'), '# smurg 範例專案\n\n這個資料夾是 scripts/dev-stack 建立的，可以隨意修改。\n');
  await writeFile(join(project, 'src', 'hello.ts'), "export function hello(name: string): string {\n  return `哈囉，${name}！`;\n}\n");
  await writeFile(join(project, 'data', 'notes.txt'), '共享資料夾（不在 git 裡）可以用來試 worktree 的唯讀連結。\n');
  await writeFile(join(project, '.gitignore'), 'data/\n');
  const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
  const git = (args: string[]): Promise<unknown> => run('git', ['-c', 'user.name=smurg dev', '-c', 'user.email=dev@smurg.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd: project, env });
  try {
    await git(['init', '-q']);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'sample project']);
  } catch {
    process.stdout.write('dev-stack：無法建立 git repository（沒有 git？），範例專案不是 git repository。\n');
  }
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  if (!((major === 22 && minor >= 18) || major === 24) || process.env['SMURG_ROOT'] === undefined) {
    fail('請先在 repo 根目錄執行 source scripts/env.sh（或直接用 scripts/dev-stack.sh）');
  }
  for (const port of [options.relayPort, options.webPort]) {
    if (await portInUse(port)) fail(`埠號 ${port} 已經有程式在使用（另一個 dev-stack 或 pnpm dev:relay / dev:web？），可以用 --relay-port / --web-port 換一個`);
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
  if (!(await stat(project)).isDirectory()) fail(`${project} 不是資料夾`);

  const relayOrigin = `http://localhost:${options.relayPort}`;
  const webOrigin = `http://localhost:${options.webPort}`;
  // SMURG_NO_BROWSER: the dev stack logs in with the dev login; a CLI it starts never opens the developer's browser.
  const smurgEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, SMURG_HOME: stateDir, SMURG_NO_BROWSER: '1' };
  delete smurgEnv['SMURG_RELAY_URL'];

  let unexpected: string | null = null;
  const watch = (recorded: Recorded): void => {
    void recorded.exit.then((code) => {
      if (stopping === null) {
        unexpected = `${recorded.name} 結束了（結束代碼 ${code ?? '訊號'}）`;
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
    process.stdout.write(`\ndev-stack：收到 ${signal}，正在停止 smurg host、網頁與 relay…\n`);
    void stopAll();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, onSignal);

  try {
    process.stdout.write(`dev-stack：啟動 relay（${relayOrigin}，紀錄檔 ${join(logs, 'relay.log')}）…\n`);
    const relay = start(
      'relay',
      'pnpm',
      ['run', 'dev', '--var', `RELAY_ISSUER:${relayOrigin}`, '--var', `ALLOWED_ORIGINS:${webOrigin},${relayOrigin}`],
      { cwd: join(ROOT, 'apps', 'relay'), env: { ...process.env, SMURG_RELAY_DEV_PORT: String(options.relayPort) }, log: join(logs, 'relay.log') },
    );
    watch(relay);
    process.stdout.write(`dev-stack：啟動網頁開發伺服器（${webOrigin}，紀錄檔 ${join(logs, 'web.log')}）…\n`);
    const web = start('web', 'pnpm', ['exec', 'vite', '--port', String(options.webPort), '--strictPort'], {
      cwd: join(ROOT, 'apps', 'web'),
      env: { ...process.env, SMURG_RELAY_DEV_ORIGIN: `http://127.0.0.1:${options.relayPort}` },
      log: join(logs, 'web.log'),
    });
    watch(web);
    await waitForHttp(`http://127.0.0.1:${options.relayPort}/healthz`, 'relay', 120_000, relay);
    await waitForHttp(`${webOrigin}/`, '網頁開發伺服器', 60_000, web);

    // The host's relay session: the relay's dev login (only allowed for a relay on a local hostname).
    const login = start('smurg login', process.execPath, [CLI_MAIN, 'login', '--relay', relayOrigin, '--dev-user', options.hostUser], { cwd: project, env: smurgEnv });
    let loginOut = '';
    login.child.stdout?.on('data', (chunk: Buffer) => (loginOut += chunk.toString('utf8')));
    login.child.stderr?.on('data', (chunk: Buffer) => (loginOut += chunk.toString('utf8')));
    if ((await login.exit) !== 0) throw new Error(`smurg login 失敗：${loginOut.trim()}`);

    process.stdout.write('dev-stack：啟動 smurg host…\n');
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
      if (stopping !== null || host.exited) throw new Error('smurg host 沒有啟動成功（見上方訊息）');
      if (Date.now() > deadline) throw new Error('smurg host 沒有在 60 秒內印出邀請連結');
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
        '================ smurg 本機開發環境已啟動 ================',
        `relay：${relayOrigin}（開發用登入已開啟）`,
        `網頁：${webOrigin}   ← 一定要用 localhost（relay 的 cookie 與 Origin 檢查都以 localhost 為準）`,
        `主人：dev:${options.hostUser}（HOME=${home}，SMURG_HOME=${stateDir}）`,
        `分享的資料夾：${realProject}`,
        `主人自己的連結：${links[0] ?? '（沒有找到）'}`,
        `邀請組員的連結（角色 ${options.role}）：${links[1] ?? '（沒有找到）'}`,
        '',
        '在瀏覽器（例如另一個設定檔或無痕視窗）打開邀請連結，用開發用登入（例如 amy）加入。',
        '組員改用 CLI 加入（另一個終端機；組員 amy 有自己的假 HOME 和 SMURG_HOME）：',
        `  ${guestEnv} node ${CLI_MAIN} login --no-browser --dev-user amy --relay ${relayOrigin}`,
        `  ${guestEnv} node ${CLI_MAIN} attach --invite - --relay ${relayOrigin}     ← 執行後貼上邀請連結`,
        `  （邀請連結指向網頁 ${webOrigin}；CLI 用 --relay ${relayOrigin} 直接連 relay，因為登入是依網址分開記錄的。）`,
        '主人自己在這台電腦上接上 session：',
        `  HOME=${home} SMURG_HOME=${stateDir} node ${CLI_MAIN} attach`,
        '按 Ctrl-C 停止全部（smurg host、網頁、relay）。',
        `（process groups：relay ${relay.pid}、網頁 ${web.pid}、smurg host ${host.pid}）`,
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
    process.stderr.write(`dev-stack：${err instanceof Error ? err.message : String(err)}\n`);
    unexpected ??= 'start-failed';
  }
  await stopAll();
  process.stdout.write('dev-stack：全部已停止。\n');
  if (unexpected !== null) {
    if (unexpected !== 'start-failed') process.stderr.write(`dev-stack：${unexpected}，其他部分也已停止（紀錄檔在 ${logs}）。\n`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  async (err: unknown) => {
    process.stderr.write(`dev-stack：發生錯誤（${err instanceof Error ? err.message : String(err)}）\n`);
    await stopAll().catch(() => {});
    process.exit(1);
  },
);
