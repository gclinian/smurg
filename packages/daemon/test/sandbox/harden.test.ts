// The rewrites of srt's generated text (src/sandbox/harden.ts) are pinned: against srt 0.0.77's REAL output on macOS
// (the text they are verified on), and on synthetic variants that must all fail closed.
import { describe, expect, it } from 'vitest';
import {
  DARWIN_SECURITYD_LINES,
  DARWIN_TTY_PRELUDE,
  HardeningError,
  LOOPBACK_LISTEN_LINES,
  SRT_NETWORK_HEADER,
  checkDarwinNetwork,
  execAllowLines,
  SMURG_OWN_TTY_SECTION,
  SRT_DARWIN_PTY_SECTION,
  SRT_PINNED_VERSION,
  checkDarwinEnvWords,
  hardenDarwinCommand,
  hardenLinuxCommand,
  parseDarwinWrapped,
  shellQuote,
} from '../../src/sandbox/harden.ts';
import { SRT_OWN_WRITE_PATHS, buildBaseConfig, buildSessionPolicy } from '../../src/sandbox/policy.ts';
import { SrtRuntime, loadSrt } from '../../src/sandbox/runtime.ts';
import { syntheticDarwinCommand, syntheticDarwinProfile, syntheticLinuxCommand } from './synthetic-srt.ts';

const ROOTS = ['/w/proj', '/w/state/guests/ws/alice'];
const opts = { shell: '/bin/bash', writeRoots: ROOTS, srtOwnWritePaths: SRT_OWN_WRITE_PATHS };

describe('srt 0.0.77 real output (macOS)', () => {
  it('the installed srt is the pinned, verified version', async () => {
    const api = await loadSrt();
    expect(api.version).toBe(SRT_PINNED_VERSION);
  });

  it.runIf(process.platform === 'darwin')('the real wrapped command contains exactly the text the rewrites expect, and hardens', async () => {
    const api = await loadSrt();
    const runtime = new SrtRuntime();
    const owner = {};
    const base = buildBaseConfig({ platform: 'darwin', hostHome: '/Users/smurg-test-host', stateDir: '/Users/smurg-test-host/.smurg', hookSocketPath: '/private/tmp/smurg-run-test/abc.hook', allowedDomains: ['example.com'] });
    const policy = buildSessionPolicy({
      platform: 'darwin',
      hostHome: '/Users/smurg-test-host',
      stateDir: '/Users/smurg-test-host/.smurg',
      shareDir: "/Users/smurg-test-host/it's a project",
      worktreesDir: "/Users/smurg-test-host/it's a project/.smurg/worktrees",
      mode: 'main',
      rootPath: "/Users/smurg-test-host/it's a project",
      guestDir: '/Users/smurg-test-host/.smurg/guests/ws/alice',
      settingsDir: '/Users/smurg-test-host/.smurg/sessions/s1',
      readOnlyPaths: [],
      extraReadPaths: [],
      selfCommandPaths: [],
      shareGitObjectsDir: null,
      extraDenyRead: [],
      extraDenyWrite: [],
      hookSocketPath: '/private/tmp/smurg-run-test/abc.hook',
      envNames: [],
    });
    await runtime.acquire(owner, api, base);
    try {
      // A command that itself contains the markers the parser keys on must not confuse it.
      const command = `echo "it's" '/usr/bin/sandbox-exec -p ' "${SRT_DARWIN_PTY_SECTION.replace(/"/g, '\\"')}"`;
      const raw = await runtime.wrap(owner, command, '/bin/bash', policy.perSession);
      const parsed = parseDarwinWrapped(raw, '/bin/bash');
      expect(parsed.command).toBe(command);
      for (const line of DARWIN_SECURITYD_LINES) expect(parsed.profile.split('\n').filter((l) => l === line)).toHaveLength(1);
      expect(parsed.profile.endsWith(`\n${SRT_DARWIN_PTY_SECTION}`)).toBe(true);
      const hardened = hardenDarwinCommand(raw, { shell: '/bin/bash', writeRoots: policy.writeRoots, srtOwnWritePaths: SRT_OWN_WRITE_PATHS });
      expect(hardened.startsWith(`${DARWIN_TTY_PRELUDE}exec /usr/bin/env `)).toBe(true);
      expect(hardened.split(' /usr/bin/sandbox-exec -D SMURG_TTY="$SMURG_TTY" -p ')).toHaveLength(2);
      const again = parseDarwinWrapped(`env ${hardened.slice(hardened.indexOf('/usr/bin/env ') + '/usr/bin/env '.length).replace(' -D SMURG_TTY="$SMURG_TTY"', '')}`, '/bin/bash');
      expect(again.command).toBe(command);
      expect(again.profile).not.toMatch(/com\.apple\.securityd\.xpc|com\.apple\.SecurityServer/);
      expect(again.profile.endsWith(SMURG_OWN_TTY_SECTION)).toBe(true);
      expect(again.profile).not.toContain(SRT_DARWIN_PTY_SECTION);
      // the write surface: the policy's roots and srt's own stdio / /tmp/claude, nothing of any home
      expect(again.profile).not.toContain('.npm/_logs');
      expect(again.profile).not.toContain('.claude/debug');
      // srt's network section passes the whitelist as generated; an ordinary guest gets no listen rule and no exec list
      expect(again.profile).not.toContain(LOOPBACK_LISTEN_LINES[1] as string);
      // srt writes bind + inbound on its proxy port; the hardened profile keeps only the outbound rule (a guest could
      // otherwise listen on <LAN address>:<proxy port>: test/sandbox/network-listen.real.test.ts).
      expect(parsed.profile).toMatch(/\(allow network-bind \(local ip "localhost:\d+"\)\)/);
      expect(parsed.profile).toMatch(/\(allow network-inbound \(local ip "localhost:\d+"\)\)/);
      expect(again.profile).not.toMatch(/network-bind \(local ip|network-inbound/);
      expect(again.profile).toMatch(/\(allow network-outbound \(remote ip "localhost:\d+"\)\)/);
      expect(again.profile).not.toContain('(deny process-exec)');
      // The login process (D-12): the listen rules right after the network header, the exec allow-list last.
      const login = hardenDarwinCommand(raw, { shell: '/bin/bash', writeRoots: policy.writeRoots, srtOwnWritePaths: SRT_OWN_WRITE_PATHS, loopbackListen: true, execAllow: ['/bin/bash', '/opt/claude'] });
      const loginProfile = parseDarwinWrapped(`env ${login.slice(login.indexOf('/usr/bin/env ') + '/usr/bin/env '.length).replace(' -D SMURG_TTY="$SMURG_TTY"', '')}`, '/bin/bash').profile.split('\n');
      const header = loginProfile.indexOf(SRT_NETWORK_HEADER);
      expect(loginProfile.slice(header + 1, header + 1 + LOOPBACK_LISTEN_LINES.length)).toEqual([...LOOPBACK_LISTEN_LINES]);
      expect(loginProfile.slice(-3)).toEqual(execAllowLines(['/bin/bash', '/opt/claude']));
      expect(loginProfile.filter((line) => /network-outbound/.test(line)).every((line) => /remote unix-socket|remote ip "localhost:\d+"/.test(line))).toBe(true);
    } finally {
      await runtime.release(owner);
    }
  });
});

describe('hardenDarwinCommand (synthetic srt output)', () => {
  const good = syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS));

  it('hardens well-formed output: no Security daemons, own tty only, absolute outer programs', () => {
    const out = hardenDarwinCommand(good, opts);
    expect(out.startsWith(`${DARWIN_TTY_PRELUDE}exec /usr/bin/env -u ANTHROPIC_API_KEY `)).toBe(true);
    expect(out).toContain(' /usr/bin/sandbox-exec -D SMURG_TTY="$SMURG_TTY" -p ');
    expect(out).not.toMatch(/securityd|SecurityServer/);
    expect(out).toContain('(deny file-read* file-write* file-ioctl (regex #"^/dev/ttys"))');
    expect(out).toContain('(allow file-read* file-write* file-ioctl (literal (param "SMURG_TTY")) (literal "/dev/ptmx"))');
    expect(out.endsWith(` /bin/bash -c ${shellQuote('echo hi')}`)).toBe(true);
  });

  it('round-trips quotes in the profile and the command exactly', () => {
    const command = `printf '%s' "it's" && echo 'a'"'"'b'`;
    const profile = syntheticDarwinProfile([...ROOTS, "/w/it's"]);
    const out = hardenDarwinCommand(syntheticDarwinCommand(command, profile), { ...opts, writeRoots: [...ROOTS, "/w/it's"] });
    const parsed = parseDarwinWrapped(`env ${out.slice(out.indexOf('/usr/bin/env ') + 13).replace(' -D SMURG_TTY="$SMURG_TTY"', '')}`, '/bin/bash');
    expect(parsed.command).toBe(command);
    expect(parsed.profile).toContain(`(subpath ${JSON.stringify("/w/it's")})`);
  });

  const failures: [string, string][] = [
    ['a Security-daemon line is missing', good.replace('  (global-name "com.apple.securityd.xpc")\n', '')],
    ['the SecurityServer line is missing', good.replace('(allow mach-lookup (global-name "com.apple.SecurityServer"))\n', '')],
    ['a Security-daemon line appears twice', syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS, { extraLines: ['(allow mach-lookup (global-name "com.apple.SecurityServer"))'] }))],
    ['the pty section changed', good.replace('(allow pseudo-tty)', '(allow pseudo-tty) ')],
    ['the pty section is missing', syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS).replace(SRT_DARWIN_PTY_SECTION, ''))],
    ['the pty section is not last', syntheticDarwinCommand('echo hi', `${syntheticDarwinProfile(ROOTS)}\n(allow file-read*)`)],
    ['another tty rule is present', syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS, { extraLines: ['(allow file-write* (regex #"^/dev/ttys"))'] }))],
    ['srt grants writes into a home (convenience dirs)', syntheticDarwinCommand('echo hi', syntheticDarwinProfile([...ROOTS, '/Users/someone/.npm/_logs']))],
    ['an unknown write-allow rule', syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS, { extraLines: ['(allow file-write-data (subpath "/w/proj"))'] }))],
    ['a glob write-allow filter', syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS).replace('(subpath "/w/proj")', '(regex "^/w/.*")'))],
    ['network is unrestricted (srt not initialized)', syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS, { extraLines: ['(allow network*)'] }))],
    ['no deny default', syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS).replace('(deny default', '(allow default'))],
    ['not an env prefix', good.replace(/^env /, 'exec ')],
    ['another shell', syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS), '/bin/zsh')],
    ['text after the command', `${good} ; rm -rf /tmp/x`],
    ['an unterminated quote', good.slice(0, -1)],
    ['a non-assignment word in the env prefix', good.replace('SANDBOX_RUNTIME=1', "SANDBOX_RUNTIME=1 ';' touch")],
  ];
  it.each(failures)('fails closed when %s', (_label, wrapped) => {
    expect(() => hardenDarwinCommand(wrapped, opts)).toThrow(HardeningError);
  });

  // srt's allowLocalBinding (bind / accept on every address, connect to every localhost port) or anything else it may
  // add to the network section is refused for every guest process: only the proxy port and the hook socket pass.
  const networkFailures: [string, string][] = [
    ['srt allowLocalBinding: bind on every address', '(allow network-bind (local ip "*:*"))'],
    ['srt allowLocalBinding: accept on every address', '(allow network-inbound (local ip "*:*"))'],
    ['srt allowLocalBinding: connect to every localhost port', '(allow network-outbound (remote ip "localhost:*"))'],
    ['a listen rule on localhost', '(allow network-bind (local ip "localhost:*"))'],
    ['every Unix socket', '(allow network-outbound (remote unix-socket (path-regex #"^/")))'],
    ['an unknown network rule', '(allow network-outbound (remote tcp "*:443"))'],
  ];
  it.each(networkFailures)('fails closed when the network section has %s', (_label, line) => {
    const profile = syntheticDarwinProfile(ROOTS).replace('; Network\n', `; Network\n${line}\n`);
    expect(() => hardenDarwinCommand(syntheticDarwinCommand('echo hi', profile), opts)).toThrow(HardeningError);
    expect(() => hardenDarwinCommand(syntheticDarwinCommand('echo hi', profile), { ...opts, loopbackListen: true, execAllow: ['/bin/bash'] })).toThrow(HardeningError);
  });

  it('fails closed on a network rule outside the network section, or no / two network sections', () => {
    const outside = syntheticDarwinProfile(ROOTS, { extraLines: ['(allow network-bind (local ip "localhost:9"))'] });
    expect(() => hardenDarwinCommand(syntheticDarwinCommand('echo hi', outside), opts)).toThrow(/outside the network section/);
    expect(() => hardenDarwinCommand(syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS).replace('; Network\n', '')), opts)).toThrow(/network section/);
    expect(() => hardenDarwinCommand(syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS, { extraLines: ['; Network'] })), opts)).toThrow(/network section/);
  });

  it('the login process (D-12): listen rules after the network header, the exec allow-list last; no outbound added', () => {
    const out = hardenDarwinCommand(good, { ...opts, loopbackListen: true, execAllow: ['/bin/bash', '/opt/claude/claude', '/usr/bin/true'] });
    const profile = parseDarwinWrapped(`env ${out.slice(out.indexOf('/usr/bin/env ') + 13).replace(' -D SMURG_TTY="$SMURG_TTY"', '')}`, '/bin/bash').profile;
    expect(profile).toContain(`${SRT_NETWORK_HEADER}\n${LOOPBACK_LISTEN_LINES.join('\n')}\n(allow network-outbound (remote ip "localhost:1234"))`);
    expect(profile.endsWith('(deny process-exec)\n(allow process-exec (literal "/bin/bash") (literal "/opt/claude/claude") (literal "/usr/bin/true"))')).toBe(true);
    expect(profile.match(/network-outbound/g)).toHaveLength(1);
    // Each part is independent: listen without an exec list, an exec list without listen.
    expect(hardenDarwinCommand(good, { ...opts, loopbackListen: true })).not.toContain('(deny process-exec)');
    expect(hardenDarwinCommand(good, { ...opts, execAllow: ['/bin/bash'] })).not.toContain(LOOPBACK_LISTEN_LINES[1] as string);
  });

  it('the exec allow-list fails closed on srt process rules it does not know, and on paths it cannot express', () => {
    const noExec = syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS).replace('(allow process-exec)\n', ''));
    expect(() => hardenDarwinCommand(noExec, { ...opts, execAllow: ['/bin/bash'] })).toThrow(/process rules/);
    const extra = syntheticDarwinCommand('echo hi', syntheticDarwinProfile(ROOTS, { extraLines: ['(allow process-exec (subpath "/"))'] }));
    expect(() => hardenDarwinCommand(extra, { ...opts, execAllow: ['/bin/bash'] })).toThrow(/process rules/);
    for (const bad of [[], ['relative/claude'], ['/a"b'], ['/a\\b'], ['/a\nb']]) expect(() => execAllowLines(bad), JSON.stringify(bad)).toThrow(HardeningError);
    expect(checkDarwinNetwork(['(version 1)', SRT_NETWORK_HEADER, '(allow network-outbound (remote ip "localhost:1"))', ''], true)).toEqual(['(version 1)', SRT_NETWORK_HEADER, ...LOOPBACK_LISTEN_LINES, '(allow network-outbound (remote ip "localhost:1"))', '']);
  });

  it('removes srt\'s bind / inbound rules on the proxy port (a guest only connects to it), keeps its outbound rule, and refuses a section without one', () => {
    const srtSection = [
      '(version 1)',
      SRT_NETWORK_HEADER,
      '(allow system-socket (socket-domain AF_UNIX))',
      '(allow network-bind (local unix-socket (subpath "/run/x.hook")))',
      '(allow network-outbound (remote unix-socket (subpath "/run/x.hook")))',
      '(allow network-bind (local ip "localhost:4321"))',
      '(allow network-inbound (local ip "localhost:4321"))',
      '(allow network-outbound (remote ip "localhost:4321"))',
      '',
      '; File read',
    ];
    const kept = ['(allow system-socket (socket-domain AF_UNIX))', '(allow network-bind (local unix-socket (subpath "/run/x.hook")))', '(allow network-outbound (remote unix-socket (subpath "/run/x.hook")))', '(allow network-outbound (remote ip "localhost:4321"))'];
    expect(checkDarwinNetwork(srtSection, false)).toEqual(['(version 1)', SRT_NETWORK_HEADER, ...kept, '', '; File read']);
    expect(checkDarwinNetwork(srtSection, true)).toEqual(['(version 1)', SRT_NETWORK_HEADER, ...LOOPBACK_LISTEN_LINES, ...kept, '', '; File read']);
    // The login process's own listen rules are TCP only (no UDP socket may be bound), and never outbound.
    expect(LOOPBACK_LISTEN_LINES.filter((line) => line.startsWith('('))).toEqual(['(allow network-bind (local tcp "localhost:*"))', '(allow network-inbound (local tcp "localhost:*"))']);
    const noProxy = srtSection.filter((line) => !line.includes('remote ip'));
    expect(() => checkDarwinNetwork(noProxy, false)).toThrow(/no rule for the proxy/);
  });

  it('checks srt env words: -u NAME pairs and NAME=value assignments only', () => {
    // srt's quoting of GIT_CONFIG_PARAMETERS='http.proxyAuthMethod=basic' included
    expect(() => checkDarwinEnvWords(`-u A B=1 'C=x y' 'GIT_CONFIG_PARAMETERS='"'"'http.proxyAuthMethod=basic'"'"''`)).not.toThrow();
    for (const bad of ['-u', '-u 1A', 'X', '-i', 'A=1 --', "'rm -rf x'"]) expect(() => checkDarwinEnvWords(bad), bad).toThrow(HardeningError);
  });
});

describe('hardenLinuxCommand (implemented from srt source; not run on Linux here)', () => {
  it('accepts bwrap by absolute path, dying with its parent, and execs it', () => {
    const wrapped = syntheticLinuxCommand('echo hi');
    expect(hardenLinuxCommand(wrapped, '/usr/bin/bwrap')).toBe(`exec ${wrapped}`);
    const viaFile = `/bin/sh -c 'exec 3<"$1" && shift && exec "$@"' srt-args /proc/self/fd/9 /usr/bin/bwrap --new-session --die-with-parent --args 3 -- /bin/bash -c 'echo hi'`;
    expect(hardenLinuxCommand(viaFile, '/usr/bin/bwrap')).toBe(`exec ${viaFile}`);
  });

  it('the login process (D-12) needs its own network namespace: --unshare-net among bwrap\'s own arguments, the direct form only', () => {
    const wrapped = syntheticLinuxCommand('echo hi');
    expect(hardenLinuxCommand(wrapped, '/usr/bin/bwrap', { loopbackListen: true })).toBe(`exec ${wrapped}`);
    expect(() => hardenLinuxCommand(wrapped.replace(' --unshare-net', ''), '/usr/bin/bwrap', { loopbackListen: true })).toThrow(/network namespace/);
    // after the `--` it is the sandboxed command's text, not a bwrap argument
    const inCommand = syntheticLinuxCommand('echo --unshare-net').replace(' --unshare-net --unshare-pid', ' --unshare-pid');
    expect(() => hardenLinuxCommand(inCommand, '/usr/bin/bwrap', { loopbackListen: true })).toThrow(/network namespace/);
    const viaFile = `/bin/sh -c 'exec 3<"$1" && shift && exec "$@"' srt-args /proc/self/fd/9 /usr/bin/bwrap --new-session --die-with-parent --unshare-net --args 3 -- /bin/bash -c 'echo hi'`;
    expect(() => hardenLinuxCommand(viaFile, '/usr/bin/bwrap', { loopbackListen: true })).toThrow(/arguments file/);
    expect(hardenLinuxCommand(viaFile, '/usr/bin/bwrap')).toBe(`exec ${viaFile}`);
  });

  it.each([
    ['bwrap looked up on PATH', syntheticLinuxCommand('echo hi', 'bwrap'), '/usr/bin/bwrap'],
    ['another bwrap', syntheticLinuxCommand('echo hi', '/opt/bwrap'), '/usr/bin/bwrap'],
    ['no --die-with-parent', syntheticLinuxCommand('echo hi').replace(' --die-with-parent', ''), '/usr/bin/bwrap'],
    ['no --new-session', syntheticLinuxCommand('echo hi').replace(' --new-session', ''), '/usr/bin/bwrap'],
    ['a relative bwrap path', syntheticLinuxCommand('echo hi', 'usr/bin/bwrap'), 'usr/bin/bwrap'],
    ['the command unwrapped', 'echo hi', '/usr/bin/bwrap'],
  ])('fails closed with %s', (_label, wrapped, bwrap) => {
    expect(() => hardenLinuxCommand(wrapped, bwrap)).toThrow(HardeningError);
  });
});
