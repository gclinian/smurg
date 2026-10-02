// `smurg update [--check]` through the dispatcher with injected io and deps: a local HTTP server stands in for
// https://downloads.smurg.ai (SMURG_INSTALL_BASE_URL), a scratch file for the installed executable (deps.executable; the
// real process.execPath is the test's Node and is never touched), tiny shell scripts for the released executables and a
// stub for macOS's xattr. Covered: a newer / the same / an older latest version, --check, a sha256 mismatch, a
// truncated and a stalled download, a missing platform file, a wrong build marker, an executable that does not start,
// a directory that cannot be written, a running `smurg host`, a source checkout, the download rule (https only),
// redirects, Ctrl-C, the quarantine attribute, and that no temp file is ever left behind.
import { chmod, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_MODULES, createDaemon, silentLogger, type Daemon } from '@smurg/daemon';
import { waitFor } from '@smurg/daemon/testing';
import { BUILD_MARKER_PREFIX, buildMarker } from '../../../scripts/release-markers.ts';
import { runCli } from '../src/cli/run.ts';
import { BuildMarkerScanner, UPDATE_USAGE, type UpdateDeps } from '../src/commands/update.ts';
import { DEFAULT_DOWNLOADS_URL, downloadsBase, sha256Of, targetName } from '../src/update/downloads.ts';
import { UPDATE_NOTICE_TIMEOUT_MS, updateCheckBlock, updateNotice, type UpdateNoticeDeps } from '../src/update/notice.ts';
import { compareVersions, parseVersion, type ReleaseVersion } from '../src/update/versions.ts';
import { HOST_TARGET, fakeExecutable, release, sha256, startDownloads, type DownloadsServer, type Route } from './downloads-server.ts';
import { fakeTerminal, makeDirs, testIo, type Dirs, type TestIo } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

const OLD = '#!/bin/sh\necho "smurg 0.2.0 (the installed one)"\n';
const CHANGELOG = '變更紀錄：https://smurg.ai/docs/changelog/';

interface Setup {
  readonly dirs: Dirs;
  readonly server: DownloadsServer;
  /** The scratch "installed executable": <home>/.local/bin/smurg. */
  readonly executable: string;
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly deps: UpdateDeps;
  /** The xattr stub's calls. */
  xattrCalls(): Promise<string[]>;
}

async function setup(routes: Record<string, Route> = {}, options: { readonly quarantine?: boolean } = {}): Promise<Setup> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const server = await startDownloads(routes);
  cleanups.push(() => server.close());
  const bin = join(dirs.home, '.local', 'bin');
  await mkdir(bin, { recursive: true });
  const executable = join(bin, 'smurg');
  await writeFile(executable, OLD, { mode: 0o755 });
  // Stands in for /usr/bin/xattr: logs every call; `-p` finds the attribute only when the test says so.
  const xattrLog = join(dirs.home, 'xattr.log');
  const xattr = join(dirs.home, 'xattr-stub');
  await writeFile(xattrLog, '');
  await writeFile(xattr, `#!/bin/sh\necho "$*" >>"${xattrLog}"\ncase "$1" in\n  -p) ${options.quarantine ? "echo '0081;00000000;Safari;'; exit 0" : 'exit 1'} ;;\n  -d) exit 0 ;;\nesac\nexit 2\n`, { mode: 0o755 });
  return {
    dirs,
    server,
    executable,
    bin,
    env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir, SMURG_INSTALL_BASE_URL: server.base },
    deps: { executable, version: '0.2.0', platform: 'linux', arch: process.arch, xattr },
    xattrCalls: async () => (await readFile(xattrLog, 'utf8')).split('\n').filter((line) => line !== ''),
  };
}

const TARGET = `smurg-linux-${process.arch}`;
const DARWIN = `smurg-darwin-${process.arch}`;

async function update(s: Setup, args: readonly string[] = [], more: { readonly io?: TestIo; readonly deps?: Partial<UpdateDeps> } = {}): Promise<{ code: number; io: TestIo }> {
  const io = more.io ?? testIo({ env: s.env, terminal: fakeTerminal({ isTTY: false }) });
  const code = await runCli(['update', ...args], io, { update: { ...s.deps, ...more.deps } });
  return { code, io };
}

/** The installed executable is untouched and nothing else is in its directory (no temp file). */
async function expectUnchanged(s: Setup): Promise<void> {
  expect(await readFile(s.executable, 'utf8')).toBe(OLD);
  expect(await readdir(s.bin)).toEqual(['smurg']);
}

async function hostDaemon(dirs: Dirs, workspaceId: string): Promise<Daemon> {
  const daemon = await createDaemon({
    config: { stateDir: dirs.stateDir, shareDir: dirs.project, workspaceId, hostUserId: 'dev:host', hostName: 'Host', relayUrl: null, keepAwake: false },
    modules: DEFAULT_FEATURE_MODULES.filter((m) => m.name === 'local'),
    log: silentLogger,
    homeDir: dirs.home,
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  return daemon;
}

describe('smurg update', () => {
  it('a newer version: downloads it next to the executable, verifies it and renames it over the old one (0755); says old → new and where the changelog is', async () => {
    const s = await setup(release('0.3.0', TARGET));
    const { code, io } = await update(s);
    expect(io.err()).toBe('');
    expect(code).toBe(0);
    expect(io.out()).toBe(
      [`下載 smurg 0.3.0（${TARGET}，${s.server.base}/v0.3.0）…`, `已更新 smurg：0.2.0 → 0.3.0（${s.executable}）`, CHANGELOG, ''].join('\n'),
    );
    expect(await readFile(s.executable, 'utf8')).toBe(fakeExecutable('0.3.0'));
    expect((await stat(s.executable)).mode & 0o777).toBe(0o755);
    // Nothing else is left in the directory, and nothing else was asked of the server.
    expect(await readdir(s.bin)).toEqual(['smurg']);
    expect(s.server.requests).toEqual(['latest/VERSION', 'v0.3.0/SHA256SUMS', `v0.3.0/${TARGET}`]);
    // Linux: no xattr at all.
    expect(await s.xattrCalls()).toEqual([]);
  });

  it('reads a compressed SHA256SUMS (the site serves it with brotli) and asks for the executable as it is stored (identity)', async () => {
    const routes = release('0.3.0', TARGET);
    const sums = routes[`v0.3.0/SHA256SUMS`] as string;
    const executable = routes[`v0.3.0/${TARGET}`] as string;
    let asked: string | undefined;
    const s = await setup({
      ...routes,
      'v0.3.0/SHA256SUMS': (_req, res) => {
        const body = brotliCompressSync(sums);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'br', 'content-length': String(body.length) }).end(body);
      },
      [`v0.3.0/${TARGET}`]: (req, res) => {
        asked = req.headers['accept-encoding'] as string | undefined;
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(Buffer.byteLength(executable)) }).end(executable);
      },
    });
    const { code, io } = await update(s);
    expect(io.err()).toBe('');
    expect(code).toBe(0);
    expect(asked).toBe('identity');
    expect(await readFile(s.executable, 'utf8')).toBe(executable);
    // A site that compresses the executable anyway: the announced (compressed) size is not held against the decoded body.
    const squeezed = await setup({
      ...routes,
      [`v0.3.0/${TARGET}`]: (_req, res) => {
        const body = gzipSync(executable);
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(body.length) }).end(body);
      },
    });
    expect((await update(squeezed)).code).toBe(0);
    expect(await readFile(squeezed.executable, 'utf8')).toBe(executable);
  });

  it('the same version: says it is the newest and downloads nothing; an older latest is never installed (no downgrade)', async () => {
    const same = await setup(release('0.2.0', TARGET));
    const a = await update(same);
    expect(a.code).toBe(0);
    expect(a.io.out()).toBe('smurg 0.2.0 已經是最新版本。\n');
    expect(same.server.requests).toEqual(['latest/VERSION']);
    await expectUnchanged(same);

    const older = await setup(release('0.1.9', TARGET));
    const b = await update(older);
    expect(b.code).toBe(0);
    expect(b.io.out()).toBe('這個 smurg（0.2.0）比目前發佈的最新版本（0.1.9）還新，不會換成較舊的版本。\n');
    expect(older.server.requests).toEqual(['latest/VERSION']);
    await expectUnchanged(older);

    // A build from the repository (`-dev`) is older than the release of that version; a pre-release is older than its release.
    const dev = await setup(release('0.2.0', TARGET));
    const c = await update(dev, [], { deps: { version: '0.2.0-dev' } });
    expect(c.code).toBe(0);
    expect(c.io.out()).toContain('已更新 smurg：0.2.0-dev → 0.2.0');
    const pre = await setup(release('0.3.0-rc.1', TARGET));
    const d = await update(pre, [], { deps: { version: '0.3.0' } });
    expect(d.io.out()).toContain('不會換成較舊的版本');
    await expectUnchanged(pre);
  });

  it('--check only reports (exit 0): whether there is a newer version, nothing downloaded, nothing replaced, even while a host runs', async () => {
    const s = await setup(release('0.3.0', TARGET));
    await hostDaemon(s.dirs, 'ws_update_check_aaaa');
    const newer = await update(s, ['--check']);
    expect(newer.code).toBe(0);
    expect(newer.io.out()).toBe(`有新版本 0.3.0（目前 0.2.0）。執行 smurg update 更新。\n${CHANGELOG}\n`);
    expect(s.server.requests).toEqual(['latest/VERSION']);
    await expectUnchanged(s);
    const same = await update(s, ['--check'], { deps: { version: '0.3.0' } });
    expect(same.code).toBe(0);
    expect(same.io.out()).toBe('smurg 0.3.0 已經是最新版本。\n');
    // --check cannot be told from the network either: a failure is an error, not "no update".
    await s.server.close();
    const down = await update(s, ['--check']);
    expect(down.code).toBe(1);
    expect(down.io.err()).toContain('無法連線到下載位置');
  });

  it('a sha256 that does not match: nothing is replaced and the temp file is removed', async () => {
    const tampered = `${fakeExecutable('0.3.0')}# tampered\n`;
    const s = await setup({ ...release('0.3.0', TARGET), [`v0.3.0/${TARGET}`]: tampered });
    const { code, io } = await update(s);
    expect(code).toBe(1);
    expect(io.err()).toContain(`${TARGET} 的 sha256 不符（預期 ${sha256(fakeExecutable('0.3.0'))}，實際 ${sha256(tampered)}）`);
    expect(io.err()).toContain('smurg 沒有被更動');
    expect(io.out()).not.toContain('已更新');
    await expectUnchanged(s);
  });

  it('a truncated download (the connection drops, or fewer bytes than SHA256SUMS describes): nothing is replaced', async () => {
    const body = Buffer.from(fakeExecutable('0.3.0'));
    const dropped = await setup({
      ...release('0.3.0', TARGET),
      [`v0.3.0/${TARGET}`]: (_req, res) => {
        res.writeHead(200, { 'content-length': String(body.length) });
        res.write(body.subarray(0, 20));
        setTimeout(() => res.destroy(), 50);
      },
    });
    const a = await update(dropped);
    expect(a.code).toBe(1);
    expect(a.io.err()).toContain('下載不完整');
    await expectUnchanged(dropped);

    // No length announced and the body simply ends early: the sha256 catches it.
    const short = await setup({
      ...release('0.3.0', TARGET),
      [`v0.3.0/${TARGET}`]: (_req, res) => {
        res.writeHead(200);
        res.end(body.subarray(0, 20));
      },
    });
    const b = await update(short);
    expect(b.code).toBe(1);
    expect(b.io.err()).toContain('sha256 不符');
    await expectUnchanged(short);
  });

  it('a download that stalls, or a site that does not answer, ends with a timeout and leaves nothing behind', async () => {
    const body = Buffer.from(fakeExecutable('0.3.0'));
    const stalled = await setup({
      ...release('0.3.0', TARGET),
      [`v0.3.0/${TARGET}`]: (_req, res) => {
        res.writeHead(200, { 'content-length': String(body.length) });
        res.write(body.subarray(0, 20)); // … and then nothing
      },
    });
    const a = await update(stalled, [], { deps: { stallTimeoutMs: 300 } });
    expect(a.code).toBe(1);
    expect(a.io.err()).toContain('下載位置太久沒有回應');
    await expectUnchanged(stalled);

    const silent = await setup({ 'latest/VERSION': () => {} });
    const b = await update(silent, [], { deps: { metaTimeoutMs: 300 } });
    expect(b.code).toBe(1);
    expect(b.io.err()).toContain(`下載位置太久沒有回應：${silent.server.base}/latest/VERSION`);
    await expectUnchanged(silent);
  });

  it('no executable for this platform in the release (not in SHA256SUMS, or not on the site): nothing is replaced', async () => {
    const unlisted = await setup(release('0.3.0', 'smurg-linux-riscv64'));
    const a = await update(unlisted);
    expect(a.code).toBe(1);
    expect(a.io.err()).toContain(`smurg 0.3.0 的 SHA256SUMS 裡沒有 ${TARGET}（這個版本沒有提供這個平台的執行檔）`);
    expect(unlisted.server.requests).toEqual(['latest/VERSION', 'v0.3.0/SHA256SUMS']);
    await expectUnchanged(unlisted);

    const routes = release('0.3.0', TARGET);
    delete routes[`v0.3.0/${TARGET}`];
    const missing = await setup(routes);
    const b = await update(missing);
    expect(b.code).toBe(1);
    expect(b.io.err()).toContain(`下載位置沒有提供這個檔案（HTTP 404）：${missing.server.base}/v0.3.0/${TARGET}`);
    await expectUnchanged(missing);

    // A platform no release is built for.
    const c = await update(missing, [], { deps: { platform: 'win32' } });
    expect(c.code).toBe(1);
    expect(c.io.err()).toContain('smurg 沒有提供這個平台的執行檔（win32-');
    // No SHA256SUMS at all, and a latest/VERSION that is not a version.
    const noSums = await setup({ 'latest/VERSION': '0.3.0\n' });
    expect((await update(noSums)).io.err()).toContain(`（HTTP 404）：${noSums.server.base}/v0.3.0/SHA256SUMS`);
    const garbage = await setup({ 'latest/VERSION': '<html>hello</html>' });
    const d = await update(garbage);
    expect(d.code).toBe(1);
    expect(d.io.err()).toContain('下載位置回應的內容不是預期的格式');
  });

  it('an executable of another version behind the right sha256 (its build marker, or what it says when started) is refused', async () => {
    // SHA256SUMS of 0.3.0 lists a file that was built as 0.2.9.
    const wrongMarker = fakeExecutable('0.2.9', '0.3.0');
    const a = await setup(release('0.3.0', TARGET, wrongMarker));
    const first = await update(a);
    expect(first.code).toBe(1);
    expect(first.io.err()).toContain(`下載的 ${TARGET} 不是 smurg 0.3.0 的執行檔（版本標記是 0.2.9）`);
    await expectUnchanged(a);
    // No marker at all: not an executable of scripts/build-sea.ts.
    const b = await setup(release('0.3.0', TARGET, '#!/bin/sh\necho "smurg 0.3.0 (x)"\n'));
    expect((await update(b)).io.err()).toContain('裡面沒有版本標記');
    await expectUnchanged(b);
    // The marker is right but the file reports another version, or does not start at all.
    const c = await setup(release('0.3.0', TARGET, fakeExecutable('0.3.0', '0.2.9')));
    expect((await update(c)).io.err()).toContain('下載的執行檔回報的版本不是 0.3.0');
    await expectUnchanged(c);
    const d = await setup(release('0.3.0', TARGET, '#!/bin/sh\n# smurg-build-version=0.3.0;\necho "cannot execute binary file" >&2\nexit 126\n'));
    const broken = await update(d);
    expect(broken.code).toBe(1);
    expect(broken.io.err()).toContain('下載的 smurg 0.3.0 無法在這台電腦上執行');
    expect(broken.io.err()).toContain('cannot execute binary file');
    await expectUnchanged(d);
  });

  it.skipIf(process.getuid?.() === 0)('a directory that cannot be written: says which one and to run the installer again; nothing is downloaded', async () => {
    const s = await setup(release('0.3.0', TARGET));
    await chmod(s.bin, 0o555);
    cleanups.push(() => chmod(s.bin, 0o755));
    const { code, io } = await update(s);
    expect(code).toBe(1);
    expect(io.err()).toContain(`無法寫入 smurg 所在的資料夾：${s.bin}`);
    expect(io.err()).toContain('curl -fsSL https://smurg.ai/install.sh | sh');
    expect(s.server.requests).toEqual(['latest/VERSION']);
    await expectUnchanged(s);
  });

  it('a running smurg host: refuses and asks for smurg stop first; the host is not stopped and nothing is downloaded', async () => {
    const s = await setup(release('0.3.0', TARGET));
    const daemon = await hostDaemon(s.dirs, 'ws_update_host_aaaaaa');
    const { code, io } = await update(s);
    expect(code).toBe(1);
    expect(io.err()).toContain('smurg：這台電腦正在分享工作區（ws_update_host_aaaaaa），沒有更新');
    expect(io.err()).toContain('有新版本 0.3.0（目前 0.2.0）。請先執行 smurg stop 停止分享，再執行 smurg update。');
    expect(daemon.status().stopped).toBe(false);
    expect(s.server.requests).toEqual(['latest/VERSION']);
    await expectUnchanged(s);
    // After `smurg stop` the same command updates.
    expect(await runCli(['stop'], testIo({ env: s.env }))).toBe(0);
    expect((await update(s)).code).toBe(0);
    expect(await readFile(s.executable, 'utf8')).toBe(fakeExecutable('0.3.0'));
  });

  it('not the single executable (a source checkout): refuses before any request and says to use git and pnpm', async () => {
    const s = await setup(release('0.3.0', TARGET));
    const { code, io } = await update(s, [], { deps: { executable: null } });
    expect(code).toBe(2);
    expect(io.err()).toContain('這個 smurg 是從原始碼執行的，不是安裝好的單一執行檔，smurg update 無法更新它');
    expect(io.err()).toContain('請用 git 取得新版的原始碼，再執行 pnpm install');
    expect((await update(s, ['--check'], { deps: { executable: null } })).code).toBe(2);
    // The tests themselves run from source: without a seam the command says the same (and the test's Node stays as it is).
    const real = testIo({ env: s.env });
    expect(await runCli(['update'], real)).toBe(2);
    expect(real.err()).toContain('從原始碼執行');
    expect(s.server.requests).toEqual([]);
    await expectUnchanged(s);
  });

  it('the downloads site must be https (http only on this machine): the rule of scripts/install.sh, checked before any request', async () => {
    const s = await setup(release('0.3.0', TARGET));
    for (const bad of ['http://downloads.example.com', 'ftp://127.0.0.1/x', 'http://127.0.0.1.example.com', 'https://user:pw@downloads.example.com']) {
      const io = testIo({ env: { ...s.env, SMURG_INSTALL_BASE_URL: bad } });
      expect(await runCli(['update'], io, { update: s.deps }), bad).toBe(2);
      expect(io.err(), bad).toContain('下載位置必須是 https 網址');
    }
    const odd = testIo({ env: { ...s.env, SMURG_INSTALL_BASE_URL: 'https://downloads.example.com/a b' } });
    expect(await runCli(['update'], odd, { update: s.deps })).toBe(2);
    expect(odd.err()).toContain('下載位置含有不允許的字元');
    expect(s.server.requests).toEqual([]);
    await expectUnchanged(s);

    expect(downloadsBase({})).toEqual({ url: DEFAULT_DOWNLOADS_URL, scheme: 'https' });
    expect(DEFAULT_DOWNLOADS_URL).toBe('https://downloads.smurg.ai');
    expect(downloadsBase({ SMURG_INSTALL_BASE_URL: '' }).url).toBe(DEFAULT_DOWNLOADS_URL);
    expect(downloadsBase({ SMURG_INSTALL_BASE_URL: 'https://mirror.example.com/smurg/' })).toEqual({ url: 'https://mirror.example.com/smurg', scheme: 'https' });
    expect(downloadsBase({ SMURG_INSTALL_BASE_URL: 'http://localhost:8080' })).toEqual({ url: 'http://localhost:8080', scheme: 'http' });
    // The installer's value names one version's folder; the site is the folder above it.
    expect(downloadsBase({ SMURG_INSTALL_BASE_URL: 'https://downloads.smurg.ai/v0.2.0' }).url).toBe('https://downloads.smurg.ai');
    expect(downloadsBase({ SMURG_INSTALL_BASE_URL: 'https://downloads.smurg.ai/latest/' }).url).toBe('https://downloads.smurg.ai');
  });

  it('redirects stay on the scheme of the site: one on the same server is followed, one to another scheme or host is refused', async () => {
    const followed = await setup(release('0.3.0', TARGET));
    followed.server.routes['moved/VERSION'] = followed.server.routes['latest/VERSION'] as Route;
    followed.server.routes['latest/VERSION'] = (_req, res) => {
      res.writeHead(302, { location: '/moved/VERSION' }).end();
    };
    expect((await update(followed, ['--check'])).io.out()).toContain('有新版本 0.3.0');
    expect(followed.server.requests).toEqual(['latest/VERSION', 'moved/VERSION']);

    for (const location of ['https://downloads.example.com/latest/VERSION', 'http://downloads.example.com/latest/VERSION']) {
      const s = await setup({ 'latest/VERSION': (_req, res) => void res.writeHead(302, { location }).end() });
      const { code, io } = await update(s, ['--check']);
      expect(code, location).toBe(1);
      expect(io.err(), location).toContain('下載位置把請求轉到不允許的網址');
    }
  });

  it('Ctrl-C during the download: exit 130, the old executable stays and the temp file is gone', async () => {
    const body = Buffer.from(fakeExecutable('0.3.0'));
    const s = await setup({
      ...release('0.3.0', TARGET),
      [`v0.3.0/${TARGET}`]: (_req, res) => {
        res.writeHead(200, { 'content-length': String(body.length) });
        res.write(body.subarray(0, 20));
      },
    });
    const io = testIo({ env: s.env });
    const done = runCli(['update'], io, { update: s.deps });
    // The temp file is in the executable's own directory while the download runs.
    await waitFor(async () => (await readdir(s.bin)).some((name) => /^\.smurg-update-[0-9a-f]{12}$/.test(name)), { what: 'the temp file' });
    io.signal('SIGINT');
    expect(await done).toBe(130);
    expect(io.out()).toContain('已取消，smurg 沒有被更動。');
    await expectUnchanged(s);
    // A process that ends before the command can clean up (process.exit) still removes it: the exit handler is gone
    // once the command returned.
    io.runExitHandlers();
    await expectUnchanged(s);
  });

  it('macOS: removes com.apple.quarantine from the verified download when it carries one, and says so; nothing is changed when it does not', async () => {
    const quarantined = await setup(release('0.3.0', DARWIN), { quarantine: true });
    const a = await update(quarantined, [], { deps: { platform: 'darwin' } });
    expect(a.io.err()).toBe('');
    expect(a.code).toBe(0);
    const calls = await quarantined.xattrCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(new RegExp(`^-p com\\.apple\\.quarantine ${quarantined.bin}/\\.smurg-update-[0-9a-f]{12}$`));
    expect(calls[1]).toBe(calls[0]?.replace('-p', '-d'));
    expect(a.io.out()).toContain('已移除下載檔案的 com.apple.quarantine 屬性（sha256 驗證相符之後）');
    expect(await readFile(quarantined.executable, 'utf8')).toBe(fakeExecutable('0.3.0'));

    const clean = await setup(release('0.3.0', DARWIN));
    const b = await update(clean, [], { deps: { platform: 'darwin' } });
    expect(b.code).toBe(0);
    expect((await clean.xattrCalls()).map((call) => call.slice(0, 2))).toEqual(['-p']);
    expect(b.io.out()).not.toContain('quarantine');

    // The attribute is only looked at after the sha256 matched.
    const tampered = await setup({ ...release('0.3.0', DARWIN), [`v0.3.0/${DARWIN}`]: 'not the file' }, { quarantine: true });
    expect((await update(tampered, [], { deps: { platform: 'darwin' } })).code).toBe(1);
    expect(await tampered.xattrCalls()).toEqual([]);
  });

  it('shows a progress line on a terminal only; a stale temp file of a killed update is removed, a fresh one is not', async () => {
    const s = await setup(release('0.3.0', TARGET));
    const stale = join(s.bin, '.smurg-update-0123456789ab');
    const fresh = join(s.bin, '.smurg-update-ba9876543210');
    await writeFile(stale, 'x');
    await writeFile(fresh, 'y');
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    await utimes(stale, twoDaysAgo, twoDaysAgo);
    const tty = testIo({ env: s.env });
    expect(await runCli(['update'], tty, { update: s.deps })).toBe(0);
    expect(tty.err()).toMatch(/100%（0\.0 \/ 0\.0 MB）/);
    expect(tty.err().endsWith('\r\u001b[K')).toBe(true);
    expect((await readdir(s.bin)).sort()).toEqual(['.smurg-update-ba9876543210', 'smurg']);

    const quiet = await setup(release('0.3.0', TARGET));
    const piped = await update(quiet);
    expect(piped.code).toBe(0);
    expect(piped.io.err()).toBe('');
  });

  it('--help, and unknown options are usage errors', async () => {
    const s = await setup();
    const help = await update(s, ['--help']);
    expect(help.code).toBe(0);
    expect(help.io.out()).toBe(UPDATE_USAGE);
    expect(UPDATE_USAGE).toContain('--check');
    expect(UPDATE_USAGE).toContain('smurg stop');
    const bad = await update(s, ['--force']);
    expect(bad.code).toBe(2);
    expect(bad.io.err()).toContain('不認得的選項 --force');
    expect((await update(s, ['0.3.0'])).code).toBe(2);
    expect(s.server.requests).toEqual([]);
  });
});

describe("the update notice of smurg host (update/notice.ts)", () => {
  const released = (version = '0.2.0'): UpdateNoticeDeps => ({ executable: '/nonexistent/bin/smurg', version });
  const never = new AbortController().signal;

  async function site(routes: Record<string, Route>): Promise<DownloadsServer> {
    const server = await startDownloads(routes);
    cleanups.push(() => server.close());
    return server;
  }

  it('is one line, only when the published version is newer than this executable', async () => {
    const server = await site({ 'latest/VERSION': '0.3.0\n' });
    const io = testIo({ env: { HOME: '/nonexistent', SMURG_INSTALL_BASE_URL: server.base } });
    expect(await updateNotice(io, never, released())).toBe('有新版本 0.3.0（目前 0.2.0）：停止分享後執行 smurg update');
    expect(await updateNotice(io, never, released('0.3.0'))).toBeNull();
    expect(await updateNotice(io, never, released('0.4.0'))).toBeNull();
    expect(await updateNotice(io, never, released('0.3.0-dev'))).toBe('有新版本 0.3.0（目前 0.3.0-dev）：停止分享後執行 smurg update');
    expect(server.requests).toEqual(['latest/VERSION', 'latest/VERSION', 'latest/VERSION', 'latest/VERSION']);
    expect(io.out()).toBe('');
    expect(io.err()).toBe('');
  });

  it('is never looked up with SMURG_NO_UPDATE_CHECK=1, in CI, without a terminal, or from source', async () => {
    const server = await site({ 'latest/VERSION': '9.9.9\n' });
    const env = { HOME: '/nonexistent', SMURG_INSTALL_BASE_URL: server.base };
    const cases: [string, TestIo, UpdateNoticeDeps][] = [
      ['disabled', testIo({ env: { ...env, SMURG_NO_UPDATE_CHECK: '1' } }), released()],
      ['ci', testIo({ env: { ...env, CI: 'true' } }), released()],
      ['not-a-terminal', testIo({ env, terminal: fakeTerminal({ isTTY: false }) }), released()],
      ['from-source', testIo({ env }), { executable: null, version: '0.2.0' }],
      ['from-source', testIo({ env }), {}], // the tests run from source
    ];
    for (const [why, io, deps] of cases) {
      expect(updateCheckBlock(io, deps), why).toBe(why);
      expect(await updateNotice(io, never, deps), why).toBeNull();
    }
    expect(server.requests).toEqual([]);
    expect(updateCheckBlock(testIo({ env: { ...env, SMURG_NO_UPDATE_CHECK: '0', CI: 'false' } }), released())).toBeNull();
  });

  it('says nothing, and never throws, when the site fails, answers nonsense, is not https, or does not answer in time', async () => {
    const env = { HOME: '/nonexistent' };
    const broken = await site({ 'latest/VERSION': (_req, res) => void res.writeHead(503).end() });
    expect(await updateNotice(testIo({ env: { ...env, SMURG_INSTALL_BASE_URL: broken.base } }), never, released())).toBeNull();
    const nonsense = await site({ 'latest/VERSION': '<html>9.9.9</html>' });
    expect(await updateNotice(testIo({ env: { ...env, SMURG_INSTALL_BASE_URL: nonsense.base } }), never, released())).toBeNull();
    const huge = await site({ 'latest/VERSION': '9'.repeat(100_000) });
    expect(await updateNotice(testIo({ env: { ...env, SMURG_INSTALL_BASE_URL: huge.base } }), never, released())).toBeNull();
    expect(await updateNotice(testIo({ env: { ...env, SMURG_INSTALL_BASE_URL: 'http://downloads.example.com' } }), never, released())).toBeNull();
    const gone = await site({});
    await gone.close();
    expect(await updateNotice(testIo({ env: { ...env, SMURG_INSTALL_BASE_URL: gone.base } }), never, released())).toBeNull();

    const silent = await site({ 'latest/VERSION': () => {} });
    const io = testIo({ env: { ...env, SMURG_INSTALL_BASE_URL: silent.base } });
    const started = Date.now();
    expect(await updateNotice(io, never, { ...released(), timeoutMs: 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    // The host stopping ends the lookup at once.
    const stop = new AbortController();
    const pending = updateNotice(io, stop.signal, { ...released(), timeoutMs: 60_000 });
    await waitFor(() => silent.requests.length === 2, { what: 'the second request' });
    stop.abort();
    expect(await pending).toBeNull();
    // `smurg host` waits at most 2 s.
    expect(UPDATE_NOTICE_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });
});

describe('versions, SHA256SUMS and the build marker', () => {
  const v = (text: string): ReleaseVersion => parseVersion(text) as ReleaseVersion;

  it('compares versions as semver does', () => {
    const ordered = ['0.1.0', '0.2.0-dev', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0-rc.10', '0.2.0', '0.2.1', '0.10.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0'];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        expect(Math.sign(compareVersions(v(ordered[i] as string), v(ordered[j] as string))), `${ordered[i]} vs ${ordered[j]}`).toBe(Math.sign(i - j));
      }
    }
    for (const bad of ['', 'v0.2.0', '0.2', '0.2.0.1', '0.2.0+build', '0.2.0-', '0.2.0-a..b', 'latest', '0.2.x', ' 0.2.0']) expect(parseVersion(bad), bad).toBeNull();
  });

  it('reads SHA256SUMS like the installer and names the release assets like it', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const sums = `${a}  smurg-darwin-arm64\n${b} *smurg-linux-x64\nnot a line\n${'c'.repeat(63)}  smurg-linux-arm64\n`;
    expect(sha256Of(sums, 'smurg-darwin-arm64')).toBe(a);
    expect(sha256Of(sums, 'smurg-linux-x64')).toBe(b);
    expect(sha256Of(sums, 'smurg-linux-arm64')).toBeNull();
    expect(sha256Of(sums, 'smurg-darwin')).toBeNull();
    expect(targetName('darwin', 'arm64')).toBe('smurg-darwin-arm64');
    expect(targetName('linux', 'x64')).toBe('smurg-linux-x64');
    expect(targetName('win32', 'x64')).toBeNull();
    expect(targetName('linux', 'riscv64')).toBeNull();
    expect(HOST_TARGET).toBe(targetName(process.platform, process.arch));
  });

  it('finds the build marker of scripts/release-markers.ts in a stream, also when a chunk cuts it; the command itself carries none', async () => {
    const text = Buffer.from(`${'x'.repeat(5000)}${buildMarker('1.2.3')}${'y'.repeat(5000)}`);
    for (const cut of [1, 4990, 5001, 5010, 5025, 5030, 9999]) {
      const scanner = new BuildMarkerScanner();
      scanner.push(text.subarray(0, cut));
      scanner.push(text.subarray(cut));
      expect([...scanner.versions], `cut at ${cut}`).toEqual(['1.2.3']);
    }
    const byByte = new BuildMarkerScanner();
    for (const byte of Buffer.from(`${buildMarker('0.3.0')} ${buildMarker('0.3.1-rc.1')}`)) byByte.push(Uint8Array.of(byte));
    expect([...byByte.versions].sort()).toEqual(['0.3.0', '0.3.1-rc.1']);
    // The CLI's sources become part of every executable, which must carry exactly ONE marker (its own): none of them
    // may contain a complete one, and update.ts looks for the prefix scripts/release-markers.ts defines.
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const own = new BuildMarkerScanner();
    for (const file of ['commands/update.ts', 'commands/uninstall.ts', 'update/downloads.ts', 'update/notice.ts', 'update/versions.ts']) own.push(await readFile(join(src, file)));
    expect([...own.versions]).toEqual([]);
    expect(await readFile(join(src, 'commands/update.ts'), 'utf8')).toContain(`Buffer.from('${BUILD_MARKER_PREFIX}', 'latin1')`);
  });
});
