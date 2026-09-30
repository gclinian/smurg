// SPEC R5 (客人沙盒, a HARD GATE) and R9.1 / R9.2 at the sandbox level, against the REAL srt on this machine: the
// SandboxService's WrappedCommand is spawned through node-pty exactly as a guest session is. The host home is a FAKE
// one (test/sandbox/helpers.ts), so a broken sandbox could only ever read test fixtures, and probes print markers or
// exit codes only, never file contents.
//
// R5.3 and R5.5 (the real claude binary) are in r5.claude.test.ts. macOS is verified; on Linux the same tests run
// against bubblewrap (implemented from srt's source, not run by this project, ARCHITECTURE §12).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import { SmurgError } from '@smurg/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DARWIN_TTY_PRELUDE } from '../../src/sandbox/harden.ts';
import { createSandboxModule } from '../../src/sandbox/module.ts';
import {
  closeServer,
  countingHttpServer,
  createSandboxFixture,
  isDarwin,
  marker,
  printWarningsOnFailure,
  probe,
  q,
  results,
  runWrapped,
  sandboxPlatform,
  startWrapped,
  unixEchoServer,
  type SandboxFixture,
} from './helpers.ts';

const execFileAsync = promisify(execFile);
const TIMEOUT = 120_000;

describe.runIf(sandboxPlatform)('R5 客人沙盒 (real srt)', () => {
  let f: SandboxFixture;

  beforeAll(async () => {
    f = await createSandboxFixture({
      files: {
        'README.md': 'project readme\n',
        'src/app.ts': 'export const x = 1;\n',
      },
    });
  }, TIMEOUT);

  afterEach((context) => printWarningsOnFailure(f, context));

  afterAll(async () => {
    await f?.cleanup();
  }, TIMEOUT);

  it('preflight passes on this machine: platform, dependencies, hardening and the canary self-test', async () => {
    const result = await f.sandbox.preflight();
    expect(result).toEqual({ ok: true, platform: process.platform });
  }, TIMEOUT);

  it('the wrapped command runs through the launcher with the hardened profile, every outer program by absolute path', async () => {
    const guest = await f.guest('shape');
    const wrapped = await f.sandbox.wrap(f.spec({ command: 'true', guest, settingsDir: await f.settingsDir('ses_shape', '{}\n') }));
    expect(wrapped.file).toBe('/bin/bash');
    expect(wrapped.args[0]).toBe('-c');
    const command = wrapped.args[1] as string;
    expect(wrapped.cwd).toBe(f.share);
    if (process.platform === 'darwin') {
      expect(command.startsWith(`${DARWIN_TTY_PRELUDE}exec /usr/bin/env `)).toBe(true);
      expect(command).toContain(' /usr/bin/sandbox-exec -D SMURG_TTY="$SMURG_TTY" -p ');
      expect(command).not.toMatch(/com\.apple\.securityd\.xpc|com\.apple\.SecurityServer/);
      expect(command).toContain('(allow file-read* file-write* file-ioctl (literal (param "SMURG_TTY")) (literal "/dev/ptmx"))');
      expect(command).not.toContain('(allow network*)');
    } else {
      expect(command.startsWith('exec ')).toBe(true);
      expect(command).toContain('--die-with-parent');
    }
    const run = await runWrapped(wrapped);
    expect(run.exitCode).toBe(0);
  }, TIMEOUT);

  it('R5.1 客人 session 裡執行 `cat ~/.ssh/id_*`、讀取主人的 `~/.claude`、讀取其他客人的臨時目錄，全部失敗', async () => {
    const alice = await f.guest('alice');
    const bob = await f.guest('bob');
    const bobSecret = join(bob.home, 'secret.txt');
    const bobMarker = `SMURG-OTHER-GUEST-${Date.now()}`;
    await import('node:fs/promises').then((fs) => fs.writeFile(bobSecret, `${bobMarker}\n`));
    const ownFile = join(alice.home, 'own.txt');
    await import('node:fs/promises').then((fs) => fs.writeFile(ownFile, 'mine\n'));
    // Controls outside the sandbox: every target exists and is readable by the host's own processes, so a failure
    // inside can only be the sandbox's doing.
    for (const path of [join(f.home, '.ssh', 'id_ed25519'), join(f.home, '.claude', 'CLAUDE.md'), join(f.home, '.claude', 'settings.json'), bobSecret]) {
      expect((await readFile(path, 'utf8')).length).toBeGreaterThan(0);
    }
    const settingsDir = await f.settingsDir('ses_r51', '{}\n');
    const hostHome = f.home;
    const script = [
      // the literal command of the criterion, in the guest's own HOME …
      probe('cat-own-home-ssh', 'cat ~/.ssh/id_*'),
      // … and aimed at the host's home, also with HOME pointing there
      probe('cat-host-ssh', `cat ${q(hostHome)}/.ssh/id_*`),
      probe('cat-host-ssh-via-HOME', `HOME=${q(hostHome)} /bin/bash -c 'cat ~/.ssh/id_*'`),
      probe('ls-host-ssh', `ls ${q(join(hostHome, '.ssh'))}`),
      probe('cat-host-claude-md', `cat ${q(join(hostHome, '.claude', 'CLAUDE.md'))}`),
      probe('cat-host-claude-settings', `cat ${q(join(hostHome, '.claude', 'settings.json'))}`),
      probe('ls-host-claude', `ls ${q(join(hostHome, '.claude'))}`),
      probe('ls-host-home', `ls ${q(hostHome)}`),
      probe('cat-other-guest', `cat ${q(bobSecret)}`),
      probe('ls-other-guest', `ls ${q(bob.dir)}`),
      probe('ls-guests-root', `ls ${q(join(f.stateDir, 'guests'))}`),
      probe('ls-state-dir', `ls ${q(f.stateDir)}`),
      probe('write-other-guest', `echo x > ${q(join(bob.home, 'planted.txt'))}`),
      // srt's shared default TMPDIR is closed too (guests could otherwise meet there)
      ...(isDarwin ? [probe('write-srt-shared-tmp', 'mkdir -p /tmp/claude/smurg-r51-probe')] : []),
      // positive controls: the guest's own dir and the project are usable
      probe('cat-own-guest-file', `cat ${q(ownFile)}`),
      probe('write-own-tmp', `echo x > "$TMPDIR/own-tmp.txt"`),
      probe('cat-project', `cat ${q(join(f.share, 'README.md'))}`),
    ].join('\n');
    const wrapped = await f.sandbox.wrap(f.spec({ command: script, guest: alice, settingsDir }));
    const run = await runWrapped(wrapped);
    const r = results(run.output);
    expect(r).toMatchObject({
      'cat-own-home-ssh': 'denied',
      'cat-host-ssh': 'denied',
      'cat-host-ssh-via-HOME': 'denied',
      'ls-host-ssh': 'denied',
      'cat-host-claude-md': 'denied',
      'cat-host-claude-settings': 'denied',
      'ls-host-claude': 'denied',
      'ls-host-home': 'denied',
      'cat-other-guest': 'denied',
      'ls-other-guest': 'denied',
      'ls-guests-root': 'denied',
      'ls-state-dir': 'denied',
      'write-other-guest': 'denied',
      'cat-own-guest-file': 'ok',
      'write-own-tmp': 'ok',
      'cat-project': 'ok',
    });
    for (const secret of [f.markers.sshKey, f.markers.hostClaudeMd, f.markers.hostClaudeSettings, bobMarker]) expect(run.output).not.toContain(secret);
    expect(existsSync(join(bob.home, 'planted.txt'))).toBe(false);
    if (isDarwin) {
      expect(r['write-srt-shared-tmp']).toBe('denied');
      expect(existsSync('/private/tmp/claude/smurg-r51-probe')).toBe(false);
    }
    expect((await stat(join(alice.tmp, 'own-tmp.txt'))).isFile()).toBe(true);
  }, TIMEOUT);

  // What this proves without the internet: the proxy refuses by NAME (a host that is not on the list gets 403 before
  // any DNS lookup), IP-literal allow-list entries work both ways, a process that ignores the proxy cannot connect at
  // all (the OS refuses the socket: the forbidden server counts zero requests), and live changes reach a process that
  // is already running. What it does not prove: that allow-listed public domains (api.anthropic.com, registries) are
  // reachable, and srt's resolved-address checks for hostnames (they need a controlled DNS name).
  it('R5.2 客人 session 無法連到白名單以外的網域', async () => {
    const allowed = await countingHttpServer('allowed-ok');
    const forbidden = await countingHttpServer('forbidden-reached');
    try {
      await f.setAllowedDomains([`127.0.0.1:${allowed.port}`]);
      const guest = await f.guest('net');
      const settingsDir = await f.settingsDir('ses_net', '{}\n');
      const code = (url: string): string => `$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 10 --noproxy '' ${url})`;
      const script = [
        `echo "@@allowed=${code(`http://127.0.0.1:${allowed.port}/`)}@@"`,
        `echo "@@forbidden-via-proxy=${code(`http://127.0.0.1:${forbidden.port}/`)}@@"`,
        `echo "@@unknown-name=${code('http://not-on-the-allow-list.invalid/')}@@"`,
        `/usr/bin/curl -s -o /dev/null --max-time 5 --noproxy '*' http://127.0.0.1:${forbidden.port}/; echo "@@forbidden-direct-exit=$?@@"`,
        probe('direct-ip-egress', '/usr/bin/nc -z -w 3 1.1.1.1 443'),
      ].join('\n');
      const run = await runWrapped(await f.sandbox.wrap(f.spec({ command: script, guest, settingsDir })));
      const r = results(run.output);
      expect(r['allowed']).toBe('200');
      expect(r['forbidden-via-proxy']).toBe('403');
      expect(r['unknown-name']).toBe('403');
      expect(r['forbidden-direct-exit']).not.toBe('0');
      expect(r['direct-ip-egress']).toBe('denied');
      expect(allowed.hits()).toBe(1);
      expect(forbidden.hits()).toBe(0);

      // Live change (host edits the allow-list): a process that is ALREADY running gets through once the host adds the
      // server, through srt's updateConfig with the whole configuration.
      const poll = [
        'for i in $(seq 1 200); do',
        `  c=${code(`http://127.0.0.1:${forbidden.port}/`)}`,
        '  echo "@@poll=$c@@"',
        '  if [ "$c" = 200 ]; then exit 0; fi',
        '  sleep 0.2',
        'done',
        'exit 3',
      ].join('\n');
      const poller = startWrapped(await f.sandbox.wrap(f.spec({ command: poll, guest, settingsDir })), { timeoutMs: 90_000 });
      await poller.waitForOutput(/@@poll=403@@/, 30_000);
      expect(forbidden.hits()).toBe(0);
      await f.setAllowedDomains([`127.0.0.1:${allowed.port}`, `127.0.0.1:${forbidden.port}`]);
      await poller.waitForOutput(/@@poll=200@@/, 30_000);
      expect((await poller.exited).exitCode).toBe(0);
      expect(forbidden.hits()).toBeGreaterThanOrEqual(1);

      // … and taken away again: refused for new processes, while the rest of the config (the hook socket rule) stayed.
      await f.setAllowedDomains([`127.0.0.1:${allowed.port}`]);
      const hits = forbidden.hits();
      const again = await runWrapped(await f.sandbox.wrap(f.spec({ command: `echo "@@after-removal=${code(`http://127.0.0.1:${forbidden.port}/`)}@@"`, guest, settingsDir })));
      expect(results(again.output)['after-removal']).toBe('403');
      expect(forbidden.hits()).toBe(hits);
    } finally {
      await f.setAllowedDomains([]);
      await allowed.close();
      await forbidden.close();
    }
  }, TIMEOUT);

  it('the hook socket is reachable from inside, the host control socket and any other Unix socket are not', async () => {
    const hookReply = marker('HOOK-PONG');
    const ctlReply = marker('CTL-PONG');
    const otherReply = marker('OTHER-PONG');
    const otherPath = join(f.runDir, 'o.sock');
    const hook = await unixEchoServer(f.ctx.config.runPaths.hook, hookReply);
    const ctl = await unixEchoServer(f.ctx.config.runPaths.ctl, ctlReply);
    const other = await unixEchoServer(otherPath, otherReply);
    try {
      const guest = await f.guest('sock');
      const say = (path: string): string => `printf 'ping\\n' | /usr/bin/nc -U -w 3 ${q(path)}`;
      const script = [say(f.ctx.config.runPaths.hook), say(f.ctx.config.runPaths.ctl), say(otherPath), 'echo "@@done=1@@"'].join('; ');
      const run = await runWrapped(await f.sandbox.wrap(f.spec({ command: script, guest, settingsDir: await f.settingsDir('ses_sock', '{}\n') })));
      expect(results(run.output)['done']).toBe('1');
      expect(run.output).toContain(hookReply);
      expect(run.output).not.toContain(ctlReply);
      expect(run.output).not.toContain(otherReply);
    } finally {
      await closeServer(hook);
      await closeServer(ctl);
      await closeServer(other);
    }
  }, TIMEOUT);

  // The probe enumerates the PUBLIC root-certificate store, so no credential of the developer is involved. Through srt's
  // default profile the Security daemons answer (158 items on the verification machine); the hardened profile strips
  // their mach-lookups, and the login keychain becomes unreachable the same way (docs/research/sandbox.md: 71 → 0).
  it.runIf(isDarwin)('keychain enumeration is blocked inside the guest sandbox', async () => {
    const enumerate = "/usr/bin/security find-certificate -a /System/Library/Keychains/SystemRootCertificates.keychain 2>/dev/null | /usr/bin/grep -c labl";
    const outside = await execFileAsync('/bin/sh', ['-c', enumerate], { env: { PATH: '/usr/bin:/bin' } }).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? '0' }));
    expect(Number(outside.stdout.trim())).toBeGreaterThan(0);
    const guest = await f.guest('keychain');
    const script = [`echo "@@root-certs=$(${enumerate})@@"`, probe('list-keychains', '/usr/bin/security list-keychains')].join('\n');
    const run = await runWrapped(await f.sandbox.wrap(f.spec({ command: script, guest, settingsDir: await f.settingsDir('ses_kc', '{}\n') })));
    const r = results(run.output);
    expect(r['root-certs']).toBe('0');
    expect(r['list-keychains']).toBe('denied');
  }, TIMEOUT);

  it("other ttys of the host are not accessible, the session's own tty is (raw mode works)", async () => {
    const injected = marker('INJECTED');
    // A terminal of the "host", started and killed by this test only.
    const victim = pty.spawn('/bin/sh', ['-c', 'tty; exec /bin/sleep 60'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/', env: { PATH: '/usr/bin:/bin' } });
    let victimOut = '';
    victim.onData((data) => {
      victimOut += data;
    });
    try {
      const deadline = Date.now() + 10_000;
      while (!/\/dev\/[a-z/]*\d+/.test(victimOut) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const victimTty = (/\/dev\/[a-z/]*\d+/.exec(victimOut) as RegExpExecArray)[0];
      const guest = await f.guest('tty');
      const script = [
        probe('own-stty', '/bin/stty size'),
        probe('own-raw-mode', '/bin/stty raw -echo && /bin/stty -raw echo'),
        probe('own-open-rw', 'exec 3<>"$(/usr/bin/tty)"'),
        probe('other-open-read', `exec 3<${q(victimTty)}`),
        probe('other-open-write', `exec 3>${q(victimTty)}`),
        probe('other-write', `echo ${injected} > ${q(victimTty)}`),
      ].join('\n');
      const run = await runWrapped(await f.sandbox.wrap(f.spec({ command: script, guest, settingsDir: await f.settingsDir('ses_tty', '{}\n') })));
      expect(results(run.output)).toMatchObject({
        'own-stty': 'ok',
        'own-raw-mode': 'ok',
        'own-open-rw': 'ok',
        'other-open-read': 'denied',
        'other-open-write': 'denied',
        'other-write': 'denied',
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(victimOut).not.toContain(injected);
    } finally {
      victim.kill('SIGKILL');
    }
  }, TIMEOUT);

  it('the daemon-owned session settings file is readable and not writable; other sessions’ settings are hidden', async () => {
    const own = marker('OWN-SETTINGS');
    const otherMarker = marker('OTHER-SETTINGS');
    const settingsDir = await f.settingsDir('ses_settings', `{"note":"${own}"}\n`);
    const otherDir = await f.settingsDir('ses_someone_else', `{"note":"${otherMarker}"}\n`);
    const file = join(settingsDir, 'settings.json');
    const guest = await f.guest('settings');
    const script = [
      `grep -q ${own} ${q(file)} && echo "@@read-own=ok@@" || echo "@@read-own=denied@@"`,
      probe('append', `echo '{}' >> ${q(file)}`),
      probe('truncate', `: > ${q(file)}`),
      probe('rm', `rm -f ${q(file)}`),
      probe('mv', `mv ${q(file)} ${q(`${file}.moved`)}`),
      probe('create-next-to-it', `echo x > ${q(join(settingsDir, 'mcp.json'))}`),
      probe('read-other-session', `cat ${q(join(otherDir, 'settings.json'))}`),
    ].join('\n');
    const run = await runWrapped(await f.sandbox.wrap(f.spec({ command: script, guest, settingsDir })));
    expect(results(run.output)).toMatchObject({ 'read-own': 'ok', append: 'denied', truncate: 'denied', rm: 'denied', mv: 'denied', 'create-next-to-it': 'denied', 'read-other-session': 'denied' });
    expect(run.output).not.toContain(otherMarker);
    expect(await readFile(file, 'utf8')).toBe(`{"note":"${own}"}\n`);
    expect(await readdir(settingsDir)).toEqual(['settings.json']);
  }, TIMEOUT);

  it('host-only paths inside the share are not writable, at any depth and under every spelling the file system folds', async () => {
    const hostSettings = marker('SHARE-CLAUDE-SETTINGS');
    const personal = marker('HOST-PERSONAL');
    await mkdir(join(f.share, '.claude'), { recursive: true });
    await writeFile(join(f.share, '.claude', 'settings.json'), `{"note":"${hostSettings}"}\n`);
    await writeFile(join(f.share, '.claude', 'settings.local.json'), `{"env":{"TOKEN":"${personal}"}}\n`);
    await writeFile(join(f.share, 'CLAUDE.local.md'), `${personal}\n`);
    await writeFile(join(f.share, '.mcp.json'), '{"mcpServers":{}}\n');
    await mkdir(join(f.share, '.git', 'hooks'), { recursive: true });
    await writeFile(join(f.share, '.git', 'config'), '[core]\n');
    await mkdir(join(f.share, 'sub', 'deeper'), { recursive: true });
    await writeFile(join(f.share, 'sub', 'deeper', '.envrc'), `export TOKEN=${personal}\n`);
    // Does this file system fold case (APFS default)? Then the folded spellings name the protected entries.
    await mkdir(join(f.share, 'CaseProbe'), { recursive: true });
    const folds = existsSync(join(f.share, 'caseprobe'));
    const S = 'ſ'; // LATIN SMALL LETTER LONG S: `.vſcode` IS `.vscode` on APFS
    const p = (rel: string): string => q(join(f.share, rel));
    const writes: [string, string][] = [
      ['claude-settings', `echo x >> ${p('.claude/settings.json')}`],
      ['claude-new-file', `echo x > ${p('.claude/commands.md')}`],
      ['claude-hooks-dir', `mkdir -p ${p('.claude/hooks')}`],
      ['mcp-json', `echo x >> ${p('.mcp.json')}`],
      ['git-hook', `echo x > ${p('.git/hooks/pre-commit')}`],
      ['git-config', `echo x >> ${p('.git/config')}`],
      ['envrc', `echo x > ${p('.envrc')}`],
      ['vscode', `mkdir -p ${p('.vscode')} && echo x > ${p('.vscode/settings.json')}`],
      ['idea', `mkdir -p ${p('.idea')}`],
      ['smurg-dir', `echo x > ${p('.smurg/planted')}`],
      ['nested-claude', `mkdir -p ${p('sub/.claude')} && echo x > ${p('sub/.claude/settings.json')}`],
      ['nested-mcp', `echo x > ${p('sub/deeper/.mcp.json')}`],
      ['rename-claude-away', `mv ${p('.claude')} ${p('claude-moved')}`],
      ...(folds
        ? ([
            ['folded-claude', `echo x >> ${p('.CLAUDE/settings.json')}`],
            ['folded-mcp', `echo x >> ${p('.MCP.JSON')}`],
            ['folded-envrc', `echo x > ${p('.Envrc')}`],
            ['folded-vscode-long-s', `mkdir -p ${p(`.v${S}code`)}`],
            ['folded-git', `echo x > ${p('.GIT/hooks/post-checkout')}`],
          ] as [string, string][])
        : []),
    ];
    const script = [
      ...writes.map(([name, cmd]) => probe(`w-${name}`, cmd)),
      probe('read-claude-settings', `cat ${p('.claude/settings.json')}`),
      probe('read-settings-local', `cat ${p('.claude/settings.local.json')}`),
      probe('read-claude-local-md', `cat ${p('CLAUDE.local.md')}`),
      probe('read-nested-envrc', `cat ${p('sub/deeper/.envrc')}`),
      probe('read-smurg-dir', `ls ${p('.smurg')}`),
      probe('write-ordinary-file', `echo ok > ${p('src/written-by-guest.txt')}`),
      probe('rm-ordinary-file', `rm ${p('src/written-by-guest.txt')}`),
    ].join('\n');
    const guest = await f.guest('hostonly');
    const run = await runWrapped(await f.sandbox.wrap(f.spec({ command: script, guest, settingsDir: await f.settingsDir('ses_hostonly', '{}\n') })));
    const r = results(run.output);
    for (const [name] of writes) expect(r[`w-${name}`], name).toBe('denied');
    expect(r).toMatchObject({ 'read-claude-settings': 'ok', 'read-settings-local': 'denied', 'read-claude-local-md': 'denied', 'read-nested-envrc': 'denied', 'read-smurg-dir': 'denied', 'write-ordinary-file': 'ok', 'rm-ordinary-file': 'ok' });
    expect(run.output).not.toContain(personal);
    expect(await readFile(join(f.share, '.claude', 'settings.json'), 'utf8')).toBe(`{"note":"${hostSettings}"}\n`);
    expect(await readFile(join(f.share, '.mcp.json'), 'utf8')).toBe('{"mcpServers":{}}\n');
    for (const rel of ['.envrc', '.vscode', '.idea', '.git/hooks/pre-commit', 'sub/.claude', 'sub/deeper/.mcp.json', 'claude-moved', '.smurg/planted', `.v${S}code`]) {
      expect(existsSync(join(f.share, rel)), rel).toBe(false);
    }
  }, TIMEOUT);

  it('without a pty (stdin not a terminal, like the sessions module’s status checks) the command runs sandboxed and reaches no tty', async () => {
    const victim = pty.spawn('/bin/sh', ['-c', 'tty; exec /bin/sleep 60'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/', env: { PATH: '/usr/bin:/bin' } });
    let victimOut = '';
    victim.onData((data) => {
      victimOut += data;
    });
    try {
      const deadline = Date.now() + 10_000;
      while (!/\/dev\/[a-z/]*\d+/.test(victimOut) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const victimTty = (/\/dev\/[a-z/]*\d+/.exec(victimOut) as RegExpExecArray)[0];
      const guest = await f.guest('nopty');
      const script = [
        'echo "@@sandbox=$SANDBOX_RUNTIME@@"',
        probe('stdin-is-tty', 'test -t 0'),
        probe('open-other-tty', `exec 3<${q(victimTty)}`),
        probe('read-project', `cat ${q(join(f.share, 'README.md'))}`),
        probe('read-host-key', `cat ${q(join(f.home, '.ssh', 'id_ed25519'))}`),
      ].join('\n');
      const wrapped = await f.sandbox.wrap(f.spec({ command: script, guest, settingsDir: await f.settingsDir('ses_nopty', '{}\n') }));
      const { spawn } = await import('node:child_process');
      const output = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(wrapped.file, [...wrapped.args], { cwd: wrapped.cwd, env: { ...wrapped.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, out });
        });
      });
      expect(output.code).toBe(0);
      expect(results(output.out)).toMatchObject({ sandbox: '1', 'stdin-is-tty': 'denied', 'open-other-tty': 'denied', 'read-project': 'ok', 'read-host-key': 'denied' });
      expect(output.out).not.toContain(f.markers.sshKey);
    } finally {
      victim.kill('SIGKILL');
    }
  }, TIMEOUT);

  it('R5.4 (exec level) without its launcher the wrapped command fails closed: it never runs unsandboxed', async () => {
    const guest = await f.guest('nolauncher');
    const flag = join(guest.tmp, 'ran-without-sandbox');
    const wrapped = await f.sandbox.wrap(f.spec({ command: `echo x > ${q(flag)}`, guest, settingsDir: await f.settingsDir('ses_nolauncher', '{}\n') }));
    const launcher = isDarwin ? '/usr/bin/sandbox-exec' : (/'?(\/[^' ]*bwrap)'? /.exec(wrapped.args[1] as string)?.[1] as string);
    const broken = { ...wrapped, args: ['-c', (wrapped.args[1] as string).split(launcher).join(join(f.base, 'missing', 'launcher'))] };
    const run = await runWrapped(broken);
    expect(run.exitCode).toBe(127);
    expect(existsSync(flag)).toBe(false);
  }, TIMEOUT);
});

describe.runIf(sandboxPlatform)('R5.4 missing sandbox dependency (real daemon)', () => {
  let f: SandboxFixture;

  beforeAll(async () => {
    f = await createSandboxFixture({
      // The launcher the preflight must find is somewhere that does not exist (macOS); Linux looks for its tools in an
      // empty directory list.
      module: createSandboxModule(isDarwin ? { sandboxExecPath: '/nonexistent/smurg-test/sandbox-exec' } : { linuxToolDirs: ['/nonexistent/smurg-test'] }),
    });
  }, TIMEOUT);

  afterEach((context) => printWarningsOnFailure(f, context));

  afterAll(async () => {
    await f?.cleanup();
  }, TIMEOUT);

  it('R5.4 讓沙盒相依套件缺失時，session 拒絕啟動並顯示明確的錯誤', async () => {
    const missing = isDarwin ? 'sandbox-exec' : 'bubblewrap';
    const pre = await f.sandbox.preflight();
    expect(pre.ok).toBe(false);
    if (pre.ok) return;
    expect(pre.reason).toBe('dependency-missing');
    expect(pre.detail).toContain(missing);

    const guest = await f.guest('refused');
    const flag = join(guest.tmp, 'started');
    const spec = f.spec({ sessionId: 'ses_refused', command: `echo x > ${q(flag)}`, guest, settingsDir: await f.settingsDir('ses_refused', '{}\n') });
    const err = (await f.sandbox.wrap(spec).then(
      () => null,
      (e: unknown) => e,
    )) as SmurgError | null;
    expect(err).toBeInstanceOf(SmurgError);
    expect(err?.code).toBe('sandbox_unavailable');
    expect(err?.detail).toEqual({ reason: 'dependency-missing' });
    expect(err?.message).toContain(missing);
    expect(err?.message).toContain('拒絕開啟客人 session');
    expect(existsSync(flag)).toBe(false);
    const entries = await f.ctx.audit.query({ limit: 50 });
    const refused = entries.filter((entry) => entry.action === 'sandbox.refused' && entry.target === 'ses_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ outcome: 'denied', detail: { reason: 'dependency-missing' } });
  }, TIMEOUT);
});

describe.runIf(sandboxPlatform)('R9 worktree scope (real srt)', () => {
  let f: SandboxFixture;
  let wt1: string;
  let wt2: string;
  const mainMarker = marker('MAIN-README');
  const siblingMarker = marker('SIBLING-SECRET');

  beforeAll(async () => {
    f = await createSandboxFixture({
      git: true,
      files: { 'README.md': `${mainMarker}\n`, 'src/main.ts': 'export {};\n', '.gitignore': 'data/\n', 'data/dataset.csv': 'id,v\n1,42\n' },
    });
    const worktrees = join(f.share, '.smurg', 'worktrees');
    await mkdir(worktrees, { recursive: true });
    const make = async (id: string): Promise<string> => {
      const dir = join(worktrees, id);
      // ARCHITECTURE §5.7 / D-2: a shared clone (objects through alternates), its own branch, the shared dir linked in.
      await execFileAsync('git', ['clone', '--shared', '-q', f.share, dir], { env: f.gitEnv() });
      await execFileAsync('git', ['-C', dir, 'checkout', '-q', '-b', `smurg/rita/${id}`], { env: f.gitEnv() });
      await symlink('../../../data', join(dir, 'data'));
      await f.ctx.roots.registerWorktree({ worktreeId: id, dir, ownerUserId: 'dev:rita', sharedLinks: [{ path: 'data', mainPath: 'data' }] });
      return dir;
    };
    wt1 = await make('wt1');
    wt2 = await make('wt2');
    await writeFile(join(wt2, 'secret.txt'), `${siblingMarker}\n`);
  }, TIMEOUT);

  afterEach((context) => printWarningsOnFailure(f, context));

  afterAll(async () => {
    await f?.cleanup();
  }, TIMEOUT);

  async function runInWorktree(label: string, script: string): Promise<{ exitCode: number; output: string }> {
    const guest = await f.guest(`wt-${label}`);
    const spec = f.spec({
      command: script,
      guest,
      settingsDir: await f.settingsDir(`ses_${label}`, '{}\n'),
      rootPath: wt1,
      // Exactly what the sessions module passes in worktree mode (src/sessions/sandbox-spec.ts, interfaces.ts): the
      // shared dirs' targets, <share>/.git, the main share and the worktrees, the host-only names and the links.
      readOnlyPaths: [join(f.share, 'data')],
      extraReadPaths: [join(f.share, '.git')],
      denyReadPaths: [f.share, join(f.share, '.smurg', 'worktrees')],
      denyWritePaths: [f.share, join(f.share, '.smurg', 'worktrees'), join(wt1, '.claude'), join(wt1, '.git'), join(wt1, 'data')],
    });
    const wrapped = await f.sandbox.wrap(spec);
    expect(wrapped.cwd).toBe(wt1);
    return runWrapped(wrapped);
  }

  it('R9.1 worktree 裡的 agent 無法讀寫主工作區或其他 worktree', async () => {
    const w = (rel: string): string => q(join(wt1, rel));
    const run = await runInWorktree(
      'r91',
      [
        probe('read-main-file', `cat ${q(join(f.share, 'README.md'))}`),
        probe('list-main', `ls ${q(f.share)}`),
        probe('write-main', `echo x > ${q(join(f.share, 'from-worktree.txt'))}`),
        probe('write-main-src', `echo x >> ${q(join(f.share, 'src', 'main.ts'))}`),
        probe('read-sibling', `cat ${q(join(wt2, 'secret.txt'))}`),
        probe('list-sibling', `ls ${q(wt2)}`),
        probe('write-sibling', `echo x > ${q(join(wt2, 'planted.txt'))}`),
        probe('read-main-git-config', `cat ${q(join(f.share, '.git', 'config'))}`),
        probe('write-main-git-objects', `echo x > ${q(join(f.share, '.git', 'objects', 'planted'))}`),
        probe('write-own-git-config', `echo x >> ${w('.git/config')}`),
        probe('write-own-git-hook', `echo x > ${w('.git/hooks/pre-commit')}`),
        probe('write-own-alternates', `echo x >> ${w('.git/objects/info/alternates')}`),
        // the worktree itself is the guest's to work in, and git history is readable through the shared objects
        probe('read-own', `cat ${w('src/main.ts')}`),
        probe('write-own', `echo x > ${w('src/new.ts')}`),
        `echo "@@git-log=$(/usr/bin/git -C ${q(wt1)} log -1 --format=%s 2>/dev/null)@@"`,
      ].join('\n'),
    );
    const r = results(run.output);
    expect(r).toMatchObject({
      'read-main-file': 'denied',
      'list-main': 'denied',
      'write-main': 'denied',
      'write-main-src': 'denied',
      'read-sibling': 'denied',
      'list-sibling': 'denied',
      'write-sibling': 'denied',
      'read-main-git-config': 'denied',
      'write-main-git-objects': 'denied',
      'write-own-git-config': 'denied',
      'write-own-git-hook': 'denied',
      'write-own-alternates': 'denied',
      'read-own': 'ok',
      'write-own': 'ok',
      'git-log': 'initial',
    });
    expect(run.output).not.toContain(mainMarker);
    expect(run.output).not.toContain(siblingMarker);
    for (const path of [join(f.share, 'from-worktree.txt'), join(wt2, 'planted.txt'), join(f.share, '.git', 'objects', 'planted')]) expect(existsSync(path)).toBe(false);
    expect(await readFile(join(f.share, 'src', 'main.ts'), 'utf8')).toBe('export {};\n');
  }, TIMEOUT);

  it('R9.2 worktree 裡的 agent 可以讀取共享資料夾，但無法寫入', async () => {
    const link = join(wt1, 'data');
    const run = await runInWorktree(
      'r92',
      [
        `grep -q '1,42' ${q(join(link, 'dataset.csv'))} && echo "@@read-via-link=ok@@" || echo "@@read-via-link=denied@@"`,
        `grep -q '1,42' ${q(join(f.share, 'data', 'dataset.csv'))} && echo "@@read-direct=ok@@" || echo "@@read-direct=denied@@"`,
        probe('list-via-link', `ls ${q(link)}`),
        probe('append-via-link', `echo 2,43 >> ${q(join(link, 'dataset.csv'))}`),
        probe('create-via-link', `echo x > ${q(join(link, 'new.csv'))}`),
        probe('rm-via-link', `rm -f ${q(join(link, 'dataset.csv'))}`),
        probe('mv-via-link', `mv ${q(join(link, 'dataset.csv'))} ${q(join(link, 'moved.csv'))}`),
        probe('append-direct', `echo 2,43 >> ${q(join(f.share, 'data', 'dataset.csv'))}`),
        // the read-only link itself cannot be removed or pointed elsewhere
        probe('rm-link', `rm ${q(link)}`),
        probe('replace-link', `ln -sfn /etc ${q(link)}`),
      ].join('\n'),
    );
    expect(results(run.output)).toMatchObject({
      'read-via-link': 'ok',
      'read-direct': 'ok',
      'list-via-link': 'ok',
      'append-via-link': 'denied',
      'create-via-link': 'denied',
      'rm-via-link': 'denied',
      'mv-via-link': 'denied',
      'append-direct': 'denied',
      'rm-link': 'denied',
      'replace-link': 'denied',
    });
    expect((await import('node:fs/promises').then((fs) => fs.readlink(link)))).toBe('../../../data');
    expect(await readFile(join(f.share, 'data', 'dataset.csv'), 'utf8')).toBe('id,v\n1,42\n');
    expect(await readdir(join(f.share, 'data'))).toEqual(['dataset.csv']);
  }, TIMEOUT);
});
