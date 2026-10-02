// `smurg uninstall [--keep-data] [--yes]` through the dispatcher with injected io and deps, in scratch directories only:
// a scratch file is the "installed executable" (deps.executable; the real process.execPath is the test's Node), a temp
// SMURG_HOME the state dir, a fake HOME holds the caches and a shared project folder. Covered: the listing, y / n / no
// terminal / --yes, --keep-data, a running `smurg host` stopped first and a stop that fails, the project's `.smurg/`
// listed and untouched, the dangerous-path guards, symlinks never followed, a source checkout.
//
// The guard tests point SMURG_HOME at directories that must never be removed (`/`, the home directory): they answer
// 「n」 and never pass --yes, so even a broken guard could not remove anything.
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CTL_FRAME_KIND,
  CtlFrameDecoder,
  DEFAULT_FEATURE_MODULES,
  createDaemon,
  encodeCtlControl,
  parseCtlRequest,
  silentLogger,
  type CtlResponse,
  type Daemon,
} from '@smurg/daemon';
import { runCli } from '../src/cli/run.ts';
import { UNINSTALL_USAGE, type UninstallDeps } from '../src/commands/uninstall.ts';
import { nativeCacheRoots } from '../src/sea/native.ts';
import { statePaths } from '../src/state/paths.ts';
import { rememberSharedFolder } from '../src/state/workspaces.ts';
import { fakeTerminal, makeDirs, testIo, type Dirs, type TestIo } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

const PROMPT = '確定要移除嗎？ [y/N] ';
const BUILD_A = 'native-0123456789abcdef';
const BUILD_B = 'native-fedcba9876543210';

interface Setup {
  readonly dirs: Dirs;
  readonly env: Record<string, string>;
  readonly deps: UninstallDeps;
  readonly executable: string;
  /** $SMURG_CACHE_DIR, and the platform's default cache root (linux: ~/.cache/smurg). */
  readonly cache: string;
  readonly defaultCache: string;
  /** <project>/.smurg: the shared folder's own smurg data. */
  readonly projectData: string;
}

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

async function setup(): Promise<Setup> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const executable = join(dirs.home, '.local', 'bin', 'smurg');
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, '#!/bin/sh\necho smurg\n', { mode: 0o755 });
  // Two builds' native dirs and an interrupted extraction in the cache in force; one more build in the default root.
  const cache = join(dirs.home, 'cache');
  const defaultCache = join(dirs.home, '.cache', 'smurg');
  for (const dir of [join(cache, BUILD_A, 'node-pty'), join(cache, BUILD_B), join(cache, `.${BUILD_B}-Ab12Cd`), join(defaultCache, BUILD_A)]) await mkdir(dir, { recursive: true });
  await writeFile(join(cache, BUILD_A, 'node-pty', 'pty.node'), 'x'.repeat(2048));
  const env = { HOME: dirs.home, SMURG_HOME: dirs.stateDir, SMURG_CACHE_DIR: cache };
  // The state a host leaves: a login, the record of the shared folder, a workspace's state, a log.
  const paths = statePaths(env);
  const project = await realpath(dirs.project);
  await rememberSharedFolder(paths, { folder: project, relay: 'http://localhost:8787', workspaceId: 'ws_uninstall_aaaaaaaa', createdAt: 1 });
  await writeFile(paths.credentials, '{"version":1,"defaultRelay":null,"relays":{}}\n', { mode: 0o600 });
  await mkdir(join(dirs.stateDir, 'workspaces', 'ws_uninstall_aaaaaaaa'), { recursive: true });
  await writeFile(join(dirs.stateDir, 'workspaces', 'ws_uninstall_aaaaaaaa', 'identity.key'), 'k'.repeat(64));
  await mkdir(paths.logsDir, { recursive: true });
  await writeFile(join(paths.logsDir, 'ws_uninstall_aaaaaaaa.log'), 'log\n');
  // The shared folder's own data: a worktree with work in it.
  const projectData = join(project, '.smurg');
  await mkdir(join(projectData, 'worktrees', 'wt1'), { recursive: true });
  await writeFile(join(projectData, 'worktrees', 'wt1', 'unmerged.txt'), 'work\n');
  return { dirs, env, deps: { executable, platform: 'linux' }, executable, cache, defaultCache, projectData };
}

async function uninstall(s: Setup, args: readonly string[], options: { readonly answer?: string | null; readonly tty?: boolean; readonly deps?: Partial<UninstallDeps>; readonly env?: Record<string, string>; readonly cwd?: string } = {}) {
  const prompts: string[] = [];
  const io: TestIo = testIo({
    env: options.env ?? s.env,
    cwd: options.cwd ?? s.dirs.home,
    terminal: fakeTerminal({ isTTY: options.tty ?? true }),
    readLine: async (prompt) => {
      prompts.push(prompt);
      return options.answer ?? null;
    },
  });
  const code = await runCli(['uninstall', ...args], io, { uninstall: { ...s.deps, ...options.deps } });
  return { code, io, prompts };
}

/** Everything smurg installed or wrote is still there. */
async function expectNothingRemoved(s: Setup): Promise<void> {
  expect(await exists(s.executable)).toBe(true);
  expect(await exists(join(s.dirs.stateDir, 'credentials.json'))).toBe(true);
  expect(await exists(join(s.dirs.stateDir, 'workspaces', 'ws_uninstall_aaaaaaaa', 'identity.key'))).toBe(true);
  expect(await exists(join(s.cache, BUILD_A, 'node-pty', 'pty.node'))).toBe(true);
  expect(await exists(join(s.cache, BUILD_B))).toBe(true);
  expect(await exists(join(s.defaultCache, BUILD_A))).toBe(true);
  expect(await readFile(join(s.projectData, 'worktrees', 'wt1', 'unmerged.txt'), 'utf8')).toBe('work\n');
}

async function hostDaemon(dirs: Dirs, workspaceId: string, folder = dirs.project): Promise<Daemon> {
  const daemon = await createDaemon({
    config: { stateDir: dirs.stateDir, shareDir: folder, workspaceId, hostUserId: 'dev:host', hostName: 'Host', relayUrl: null, keepAwake: false },
    modules: DEFAULT_FEATURE_MODULES.filter((m) => m.name === 'local'),
    log: silentLogger,
    homeDir: dirs.home,
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  return daemon;
}

/**
 * A control socket in the run dir that answers `status` like a running daemon and `stop` as the test says: a refusal,
 * or an acceptance after which it keeps running (a daemon that does not end).
 */
async function stubbornDaemon(dirs: Dirs, workspaceId: string, onStop: 'refuse' | 'ignore'): Promise<{ stops: () => number }> {
  const run = join(dirs.stateDir, 'run');
  await mkdir(run, { recursive: true, mode: 0o700 });
  let stops = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const decoder = new CtlFrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        if (frame.kind !== CTL_FRAME_KIND.control) continue;
        const request = parseCtlRequest(frame.body);
        let response: CtlResponse;
        if (request.op === 'status') {
          response = {
            ok: true,
            op: 'status',
            status: {
              workspaceId,
              started: true,
              stopped: false,
              relay: { interactive: 'none', transfer: 'none' },
              connections: 0,
              onlineMembers: 0,
              power: { active: false, mechanism: 'none', pid: null, reason: 'disabled' },
              handshakes: { handshakes: 0, accepted: 0, failed: 0, refusedByRateLimit: 0, kickedForFailures: 0, kickedIdle: 0 },
            },
          };
        } else {
          stops += 1;
          response = onStop === 'refuse' ? { ok: false, error: { code: 'internal', message: 'not now' } } : { ok: true, op: 'stop' };
        }
        socket.end(encodeCtlControl(response));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(join(run, 'stubbornstub.ctl'), resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { stops: () => stops };
}

describe('smurg uninstall', () => {
  it('lists exactly what it will remove (paths and sizes) and what it leaves, asks, and on 「y」 removes the executable, the caches of every build and the state dir', async () => {
    const s = await setup();
    await writeFile(join(s.cache, 'not-smurgs.txt'), 'keep me');
    const { code, io, prompts } = await uninstall(s, [], { answer: 'y' });
    expect(io.err()).toBe('');
    expect(code).toBe(0);
    expect(prompts).toEqual([PROMPT]);
    const what = '狀態目錄：登入、裝置金鑰、每個工作區的金鑰／成員／邀請連結、紀錄檔';
    const plan = io.out().slice(0, io.out().indexOf('\n\n已移除：'));
    expect(plan.split('\n')).toEqual([
      'smurg uninstall 會移除：',
      `  ${s.executable}（21 B）  執行檔`,
      expect.stringMatching(new RegExp(`^  ${s.dirs.stateDir}（\\d+ (?:B|KB)）  ${what}$`)),
      `  ${join(s.cache, `.${BUILD_B}-Ab12Cd`)}（0 B）  快取：執行檔解壓縮出來的原生模組`,
      `  ${join(s.cache, BUILD_A)}（2 KB）  快取：執行檔解壓縮出來的原生模組`,
      `  ${join(s.cache, BUILD_B)}（0 B）  快取：執行檔解壓縮出來的原生模組`,
      `  ${join(s.defaultCache, BUILD_A)}（0 B）  快取：執行檔解壓縮出來的原生模組`,
      '  移除狀態目錄之後，分享過的工作區的成員與邀請連結都不再有效，這台電腦加入過的工作區也要重新用邀請連結加入。',
      '',
      '不會動：',
      `  ${s.projectData}  專案資料夾裡的 smurg 資料（worktree 和還沒合併的修改在這裡）`,
    ]);

    // Gone: the executable, the state dir, every build's native dir; the default cache root was empty afterwards.
    expect(await exists(s.executable)).toBe(false);
    expect(await exists(s.dirs.stateDir)).toBe(false);
    expect(await exists(s.defaultCache)).toBe(false);
    // Left: what is not smurg's in the cache dir, the directory the executable was in, the project's own data.
    expect(await readdir(s.cache)).toEqual(['not-smurgs.txt']);
    expect(await readdir(dirname(s.executable))).toEqual([]);
    expect(await readFile(join(s.projectData, 'worktrees', 'wt1', 'unmerged.txt'), 'utf8')).toBe('work\n');

    const summary = io.out().slice(io.out().indexOf('\n\n已移除：') + 2);
    expect(summary.split('\n')).toEqual([
      '已移除：',
      `  ${join(s.cache, `.${BUILD_B}-Ab12Cd`)}`,
      `  ${join(s.cache, BUILD_A)}`,
      `  ${join(s.cache, BUILD_B)}`,
      `  ${join(s.defaultCache, BUILD_A)}`,
      `  ${s.dirs.stateDir}`,
      `  ${s.executable}`,
      `  ${s.defaultCache}`,
      '',
      '還留著：',
      `  ${s.projectData}  專案資料夾裡的 smurg 資料（worktree 和還沒合併的修改在這裡）`,
      `  shell 設定檔裡的 PATH：安裝程式只提示過要加 export PATH="${dirname(s.executable)}:$PATH"，smurg 沒有改過你的設定檔；你加過的話，請自己刪掉那一行`,
      '',
      'smurg 已從這台電腦移除。要再安裝：curl -fsSL https://smurg.ai/install.sh | sh',
      '',
    ]);
  });

  it('anything but y / yes cancels: nothing is removed (exit 1)', async () => {
    const s = await setup();
    for (const answer of ['n', '', 'no', 'yes please', null]) {
      const { code, io, prompts } = await uninstall(s, [], { answer });
      expect(code, String(answer)).toBe(1);
      expect(prompts).toEqual([PROMPT]);
      expect(io.err()).toBe('smurg：已取消，沒有移除任何東西。\n');
      expect(io.out()).toContain('smurg uninstall 會移除：');
      expect(io.out()).not.toContain('已移除');
      await expectNothingRemoved(s);
    }
    const yes = await uninstall(s, [], { answer: 'YES' });
    expect(yes.code).toBe(0);
    expect(await exists(s.executable)).toBe(false);
  });

  it('without a terminal it refuses unless --yes is given (and never asks); --yes removes without a question', async () => {
    const s = await setup();
    const refused = await uninstall(s, [], { tty: false, answer: 'y' });
    expect(refused.code).toBe(2);
    expect(refused.prompts).toEqual([]);
    expect(refused.io.out()).toContain('smurg uninstall 會移除：');
    expect(refused.io.err()).toBe('smurg：不在終端機裡執行，無法詢問，沒有移除任何東西\n  確定要移除的話，加上 --yes 再執行一次。\n');
    await expectNothingRemoved(s);

    const forced = await uninstall(s, ['--yes'], { tty: false });
    expect(forced.code).toBe(0);
    expect(forced.prompts).toEqual([]);
    expect(forced.io.out()).toContain('smurg 已從這台電腦移除');
    expect(await exists(s.executable)).toBe(false);
    expect(await exists(s.dirs.stateDir)).toBe(false);
    expect(await exists(join(s.cache, BUILD_A))).toBe(false);
    // --yes at a terminal asks nothing either.
    const again = await setup();
    const atTerminal = await uninstall(again, ['--yes'], { answer: 'n' });
    expect(atTerminal.code).toBe(0);
    expect(atTerminal.prompts).toEqual([]);
  });

  it('--keep-data removes only the executable and the cache; the state dir stays and is listed as kept', async () => {
    const s = await setup();
    const { code, io } = await uninstall(s, ['--keep-data'], { answer: 'y' });
    expect(code).toBe(0);
    expect(io.out()).not.toContain('狀態目錄：登入');
    expect(io.out()).not.toContain('移除狀態目錄之後');
    expect(io.out().split(`  ${s.dirs.stateDir}  狀態目錄（--keep-data）\n`)).toHaveLength(3); // under 「不會動」 and 「還留著」
    expect(await exists(s.executable)).toBe(false);
    expect(await exists(join(s.cache, BUILD_A))).toBe(false);
    expect(await exists(join(s.defaultCache, BUILD_A))).toBe(false);
    expect(await exists(join(s.dirs.stateDir, 'credentials.json'))).toBe(true);
    expect(await exists(join(s.dirs.stateDir, 'workspaces', 'ws_uninstall_aaaaaaaa', 'identity.key'))).toBe(true);
    expect(await readFile(join(s.projectData, 'worktrees', 'wt1', 'unmerged.txt'), 'utf8')).toBe('work\n');
  });

  it('a running smurg host is stopped first (every workspace, as smurg stop does), then everything is removed', async () => {
    const s = await setup();
    const other = join(s.dirs.home, 'other');
    await mkdir(other);
    const a = await hostDaemon(s.dirs, 'ws_uninstall_runninga');
    const b = await hostDaemon(s.dirs, 'ws_uninstall_runningb', other);
    // Not stopped by a cancelled run.
    const cancelled = await uninstall(s, [], { answer: 'n' });
    expect(cancelled.code).toBe(1);
    expect(cancelled.io.out()).toMatch(/會先停止正在分享的工作區（和 smurg stop 一樣：中斷所有連線、結束所有 session）：ws_uninstall_running[ab]、ws_uninstall_running[ab]\n/);
    expect(a.status().stopped).toBe(false);
    expect(b.status().stopped).toBe(false);

    const { code, io } = await uninstall(s, [], { answer: 'y' });
    expect(io.err()).toBe('');
    expect(code).toBe(0);
    expect(a.status().stopped).toBe(true);
    expect(b.status().stopped).toBe(true);
    const out = io.out();
    expect(out).toContain('正在停止分享工作區 ws_uninstall_runninga…\n');
    expect(out).toContain('正在停止分享工作區 ws_uninstall_runningb…\n');
    expect(out.indexOf('已停止分享。')).toBeGreaterThan(out.indexOf('正在停止分享工作區'));
    expect(out.indexOf('已移除：')).toBeGreaterThan(out.indexOf('已停止分享。'));
    expect(await exists(s.executable)).toBe(false);
    expect(await exists(s.dirs.stateDir)).toBe(false);
    // The daemon's own data in both shared folders stays (the lock marker of a stopped daemon is its own business).
    expect(await readFile(join(s.projectData, 'worktrees', 'wt1', 'unmerged.txt'), 'utf8')).toBe('work\n');
    expect(await exists(join(other, '.smurg'))).toBe(true);
  });

  it('a smurg host that refuses to stop, or does not end, aborts the uninstall: nothing is removed', async () => {
    const refusing = await setup();
    const stub = await stubbornDaemon(refusing.dirs, 'ws_uninstall_stubborn', 'refuse');
    const a = await uninstall(refusing, ['--yes']);
    expect(a.code).toBe(1);
    expect(stub.stops()).toBe(1);
    expect(a.io.err()).toContain('smurg：無法停止正在分享的工作區 ws_uninstall_stubborn（smurg host 拒絕停止：not now），沒有移除任何東西');
    expect(a.io.err()).toContain('請到執行 smurg host 的終端機按 Ctrl-C 停止分享，再執行一次 smurg uninstall。');
    expect(a.io.out()).not.toContain('已移除');
    await expectNothingRemoved(refusing);

    const hanging = await setup();
    await stubbornDaemon(hanging.dirs, 'ws_uninstall_hanging0', 'ignore');
    const b = await uninstall(hanging, ['--yes', '--keep-data'], { deps: { stopWaitMs: 1_000 } });
    expect(b.code).toBe(1);
    expect(b.io.err()).toContain('無法停止正在分享的工作區 ws_uninstall_hanging0（smurg host 在 1 秒內沒有停止），沒有移除任何東西');
    await expectNothingRemoved(hanging);
  });

  it('never touches a project folder\'s .smurg/: lists the recorded ones that are still on disk, and one around the current directory', async () => {
    const s = await setup();
    const paths = statePaths(s.env);
    // Recorded, but its .smurg is gone; recorded twice (two relays); not recorded, but the person stands inside it.
    const gone = join(s.dirs.home, 'gone');
    await mkdir(gone);
    await rememberSharedFolder(paths, { folder: gone, relay: 'http://localhost:8787', workspaceId: 'ws_uninstall_gone0000', createdAt: 2 });
    await rememberSharedFolder(paths, { folder: await realpath(s.dirs.project), relay: 'https://relay.example.com', workspaceId: 'ws_uninstall_other000', createdAt: 3 });
    const unrecorded = join(await realpath(s.dirs.home), 'unrecorded');
    await mkdir(join(unrecorded, '.smurg', 'worktrees'), { recursive: true });
    await mkdir(join(unrecorded, 'src', 'deep'), { recursive: true });
    // A `.smurg` that is not a daemon's (no entry of its own) is not claimed.
    await mkdir(join(unrecorded, 'src', '.smurg'));
    const { code, io } = await uninstall(s, ['--yes'], { cwd: join(unrecorded, 'src', 'deep') });
    expect(code).toBe(0);
    const kept = io.out().slice(io.out().indexOf('還留著：'));
    expect(kept.split('\n').filter((line) => line.includes('專案資料夾裡的 smurg 資料')).map((line) => line.trim().split('  ')[0])).toEqual([s.projectData, join(unrecorded, '.smurg')].sort());
    expect(io.out()).not.toContain(join(gone, '.smurg'));
    expect(await readFile(join(s.projectData, 'worktrees', 'wt1', 'unmerged.txt'), 'utf8')).toBe('work\n');
    expect(await exists(join(unrecorded, '.smurg', 'worktrees'))).toBe(true);
    expect(await exists(join(unrecorded, 'src', '.smurg'))).toBe(true);
  });

  it('refuses a state dir that is not smurg\'s to remove: /, a top-level directory, the home directory, a folder around it, or one with other things in it', async () => {
    const s = await setup();
    const home = await realpath(s.dirs.home);
    await mkdir(join(home, 'documents', 'taxes'), { recursive: true });
    await writeFile(join(home, 'documents', 'credentials.json'), '{}');
    const cases: [string, string][] = [
      ['/', '不會移除 /：它不是 smurg 的狀態目錄（SMURG_HOME 指向系統的頂層目錄）'],
      ['/usr', '不會移除 /usr：它不是 smurg 的狀態目錄（SMURG_HOME 指向系統的頂層目錄）'],
      [home, `不會移除 ${home}：它是你的家目錄`],
      [dirname(home), `不會移除 ${dirname(home)}：你的家目錄在它裡面`],
      [join(home, 'documents'), `不會移除 ${join(home, 'documents')}：裡面有不是 smurg 建立的東西（taxes）`],
    ];
    for (const [stateDir, message] of cases) {
      // 「n」 and no --yes: even a broken guard could not remove these.
      const { code, io, prompts } = await uninstall(s, [], { answer: 'n', env: { ...s.env, SMURG_HOME: stateDir } });
      expect(io.err(), stateDir).toContain(`smurg：${message}`);
      expect(io.err(), stateDir).toContain('沒有移除任何東西。要只移除執行檔和快取：smurg uninstall --keep-data');
      expect(code, stateDir).toBe(2);
      expect(prompts, stateDir).toEqual([]);
      expect(io.out(), stateDir).toBe('');
      await expectNothingRemoved(s);
      expect(await exists(join(home, 'documents', 'taxes'))).toBe(true);
    }
    // A relative SMURG_HOME is refused as everywhere else.
    const relative = await uninstall(s, [], { answer: 'n', env: { ...s.env, SMURG_HOME: 'state' } });
    expect(relative.code).toBe(2);
    expect(relative.io.err()).toContain('SMURG_HOME 必須是絕對路徑');
    // --keep-data does not look at the state dir at all: the executable and the cache go, the folder stays.
    const kept = await uninstall(s, ['--keep-data'], { answer: 'y', env: { ...s.env, SMURG_HOME: join(home, 'documents') } });
    expect(kept.code).toBe(0);
    expect(await exists(s.executable)).toBe(false);
    expect(await exists(join(home, 'documents', 'taxes'))).toBe(true);
    expect(await exists(join(home, 'documents', 'credentials.json'))).toBe(true);
  });

  it('the default ~/.smurg is removed as a whole, whatever is in it; no state dir at all is fine', async () => {
    const s = await setup();
    const home = await realpath(s.dirs.home);
    const env = { HOME: home, SMURG_CACHE_DIR: s.cache };
    await mkdir(join(home, '.smurg', 'workspaces'), { recursive: true });
    await mkdir(join(home, '.smurg', 'uploads'));
    await writeFile(join(home, '.smurg', 'notes-of-mine.txt'), 'x');
    const { code, io } = await uninstall(s, ['--yes'], { env, cwd: s.dirs.home });
    expect(code).toBe(0);
    expect(io.out()).toContain(`  ${join(home, '.smurg')}（`);
    expect(await exists(join(home, '.smurg'))).toBe(false);
    expect(await exists(home)).toBe(true);
    // Standing in the home directory, ~/.smurg (the state dir) is never listed as a project's data.
    expect(io.out()).not.toContain('專案資料夾裡的 smurg 資料');

    const bare = await setup();
    await rm(bare.dirs.stateDir, { recursive: true });
    const none = await uninstall(bare, ['--yes']);
    expect(none.code).toBe(0);
    expect(none.io.out()).not.toContain('狀態目錄');
    expect(await exists(bare.executable)).toBe(false);
  });

  it('never follows a symlink out of what it removes: inside the state dir, in the cache, or the state dir itself', async () => {
    const s = await setup();
    const outside = join(s.dirs.home, 'outside');
    await mkdir(join(outside, 'deep'), { recursive: true });
    await writeFile(join(outside, 'deep', 'precious.txt'), 'precious');
    await symlink(outside, join(s.dirs.stateDir, 'workspaces', 'ws_uninstall_aaaaaaaa', 'link-out'));
    await symlink(join(outside, 'deep', 'precious.txt'), join(s.dirs.stateDir, 'logs', 'file-link'));
    // A cache entry with a build's name that is a symlink is not a build's dir: left alone, with what it points at.
    await symlink(outside, join(s.cache, 'native-aaaaaaaaaaaaaaaa'));
    const { code, io } = await uninstall(s, ['--yes']);
    expect(code).toBe(0);
    expect(await exists(s.dirs.stateDir)).toBe(false);
    expect(await readFile(join(outside, 'deep', 'precious.txt'), 'utf8')).toBe('precious');
    expect(io.out()).not.toContain('native-aaaaaaaaaaaaaaaa');
    expect((await lstat(join(s.cache, 'native-aaaaaaaaaaaaaaaa'))).isSymbolicLink()).toBe(true);

    // The state dir is itself a symlink: the link goes, the folder it points at stays and is named.
    const linked = await setup();
    const real = join(await realpath(linked.dirs.home), 'state-elsewhere');
    await mkdir(join(real, 'workspaces'), { recursive: true });
    await writeFile(join(real, 'credentials.json'), '{}');
    const link = join(linked.dirs.home, 'state-link');
    await symlink(real, link);
    const viaLink = await uninstall(linked, ['--yes'], { env: { ...linked.env, SMURG_HOME: link } });
    expect(viaLink.code).toBe(0);
    expect(viaLink.io.out()).toContain(`  ${link}  狀態目錄：登入、裝置金鑰、每個工作區的金鑰／成員／邀請連結、紀錄檔（這是一個 symlink：只移除連結本身）`);
    expect(viaLink.io.out()).toContain(`  ${real}  狀態目錄的 symlink 指向的資料夾`);
    expect(await exists(link)).toBe(false);
    expect(await readFile(join(real, 'credentials.json'), 'utf8')).toBe('{}');
    // A cache root that is a symlink is not entered.
    const rooted = await setup();
    await mkdir(join(outside, BUILD_A));
    await rm(rooted.defaultCache, { recursive: true });
    await symlink(outside, rooted.defaultCache);
    expect((await uninstall(rooted, ['--yes'])).code).toBe(0);
    expect(await exists(join(outside, BUILD_A))).toBe(true);
  });

  it('removes a path only while it is still what the person confirmed; a failure names what is left', async () => {
    const s = await setup();
    const prompts: string[] = [];
    const io = testIo({
      env: s.env,
      readLine: async (prompt) => {
        prompts.push(prompt);
        // Between the listing and the removal the executable is replaced by another file.
        await writeFile(`${s.executable}.other`, 'something else');
        await rename(`${s.executable}.other`, s.executable);
        return 'y';
      },
    });
    expect(await runCli(['uninstall'], io, { uninstall: s.deps })).toBe(1);
    expect(io.err()).toContain(`smurg：${s.executable} 在確認之後被換成別的東西，沒有移除它`);
    expect(io.err()).toContain(`還沒移除：${s.executable}。`);
    expect(io.err()).toContain(`已移除：`);
    expect(await readFile(s.executable, 'utf8')).toBe('something else');
    // The executable goes last: the cache and the state were removed before it.
    expect(await exists(s.dirs.stateDir)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('an executable in a directory that cannot be written: refuses before anything is removed', async () => {
    const s = await setup();
    await chmod(dirname(s.executable), 0o555);
    cleanups.push(() => chmod(dirname(s.executable), 0o755));
    const { code, io } = await uninstall(s, ['--yes']);
    expect(code).toBe(1);
    expect(io.err()).toContain(`無法移除 ${s.executable}：沒有寫入 ${dirname(s.executable)} 的權限`);
    await expectNothingRemoved(s);
  });

  it('not the single executable (a source checkout): refuses and says what to delete by hand', async () => {
    const s = await setup();
    const { code, io } = await uninstall(s, ['--yes'], { deps: { executable: null } });
    expect(code).toBe(2);
    expect(io.err()).toContain('smurg：這個 smurg 是從原始碼執行的，沒有安裝好的執行檔可以移除');
    expect(io.err()).toContain(`狀態目錄 ${s.dirs.stateDir}（登入、金鑰、工作區狀態、紀錄檔）和快取 ${s.cache}、${s.defaultCache}`);
    expect(io.err()).toContain('.smurg/（worktree 在裡面）');
    // The tests themselves run from source: without a seam the command refuses the same way (the test's Node stays).
    const real = testIo({ env: s.env });
    expect(await runCli(['uninstall', '--yes'], real)).toBe(2);
    expect(real.err()).toContain('從原始碼執行');
    await expectNothingRemoved(s);
  });

  it('--help, unknown options, and where the caches are on each platform', async () => {
    const s = await setup();
    const help = await uninstall(s, ['--help']);
    expect(help.code).toBe(0);
    expect(help.io.out()).toBe(UNINSTALL_USAGE);
    for (const option of ['--keep-data', '--yes']) expect(UNINSTALL_USAGE).toContain(option);
    const bad = await uninstall(s, ['--force']);
    expect(bad.code).toBe(2);
    expect(bad.io.err()).toContain('不認得的選項 --force');
    await expectNothingRemoved(s);
    // The rule of the executable's banner (scripts/build-sea.ts).
    expect(nativeCacheRoots({}, 'darwin', '/Users/amy')).toEqual(['/Users/amy/Library/Caches/smurg']);
    expect(nativeCacheRoots({}, 'linux', '/home/amy')).toEqual(['/home/amy/.cache/smurg']);
    expect(nativeCacheRoots({ XDG_CACHE_HOME: '/var/cache/amy' }, 'linux', '/home/amy')).toEqual(['/var/cache/amy/smurg']);
    expect(nativeCacheRoots({ XDG_CACHE_HOME: 'relative' }, 'linux', '/home/amy')).toEqual(['/home/amy/.cache/smurg']);
    expect(nativeCacheRoots({ SMURG_CACHE_DIR: '/tmp/c/' }, 'darwin', '/Users/amy')).toEqual(['/tmp/c', '/Users/amy/Library/Caches/smurg']);
    expect(nativeCacheRoots({ SMURG_CACHE_DIR: 'relative' }, 'darwin', '/Users/amy')).toEqual(['/Users/amy/Library/Caches/smurg']);
  });
});

