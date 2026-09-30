// ARCHITECTURE §11 D-12: a guest's Claude subscription login runs as its own process (session kind 'login') in the
// REAL guest sandbox (srt, macOS Seatbelt) with exactly one extra right, listening on the loopback interface.
//
// Part 1 uses a stand-in `claude` (a shell script at config.sessions.claudePath) whose `auth login` branch probes the
// sandbox from inside the real login process, launched by the real sessions module: it may listen and accept on
// loopback; it may not listen on other interfaces, connect to a TCP server the test runs on 127.0.0.1 (a "host
// service"), read the fake host home or the share, or write outside the guest dir. An ordinary guest session still
// cannot listen at all.
// Part 2 runs the REAL `claude` (every verified version available: SMURG_TEST_CLAUDE_BIN, SMURG_TEST_CLAUDE_BINS
// (colon-separated) and `claude` on PATH) and checks that the login screen shows the login URL and the prompt for the
// pasted code. No code is ever pasted and no domain is allowed: nothing leaves the machine, no account is used
// (ARCHITECTURE §0 rule 2). Skips LOUDLY without a verified claude.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_VERIFIED_VERSIONS, claudeVersionVerdict } from '../../src/core/config.ts';
import type { Principal } from '../../src/core/interfaces.ts';
import { ClaudeVersionProbe, resolveClaude } from '../../src/sessions/claude.ts';
import { loginClaudeArgs } from '../../src/sessions/login.ts';
import { runProcess } from '../../src/sessions/process-run.ts';
import { createTempDir, removeTempDir } from '../../src/testing/index.ts';
import { TEST_CONN, startRealStack, until, type RealStack } from './real-stack.ts';

const sandboxPlatform = process.platform === 'darwin' || process.platform === 'linux';
const TIMEOUT = 120_000;

function results(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of output.replace(/\s+/g, '').matchAll(/@@([A-Za-z0-9_.-]+)=([^@]*)@@/g)) out[match[1] as string] = match[2] as string;
  return out;
}

/** A TCP server on 127.0.0.1 standing for one of the host's own localhost services; counts connections. */
async function hostService(): Promise<{ readonly server: Server; readonly port: number; connections(): number; close(): Promise<void> }> {
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.end('host-service\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    server,
    port: (server.address() as { port: number }).port,
    connections: () => connections,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A TCP port nothing on this host listens on right now (bound and released). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Whether THIS host process reaches a listener on 127.0.0.1:`port` (the test side of a network-namespace check). */
async function hostReaches(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Linux: a perl listener on 0.0.0.0:`port` for `seconds`, counting who connects (it prints @@<name>-accepts=N@@ when
 * it stops). A guest process on Linux runs in its own network namespace (srt's --unshare-net), so it may listen: only
 * processes of that namespace can connect, never the host or the network.
 */
function nsListener(name: string, port: number, seconds: number): string {
  // perl sees \@ and \n (JS: '\\@', '\\n'): no "@@" in the text a terminal echoes, one line to type
  const say = (what: string): string => `print "\\@\\@${name}-${what}\\@\\@\\n"`;
  return `/usr/bin/perl -MIO::Socket::INET -e '$s=IO::Socket::INET->new(Listen=>5,LocalAddr=>"0.0.0.0",LocalPort=>${port},Proto=>"tcp",ReuseAddr=>1) or do { ${say('listen=denied')}; exit 3 }; ${say('listen=ok')}; $n=0; $SIG{ALRM}=sub { ${say('accepts=$n')}; exit 0 }; alarm ${seconds}; while (my $c=$s->accept) { $n++; print $c "token\\n"; close $c }'`;
}

/**
 * The stand-in `claude` (bash, which the login's exec allow-list admits as the sandbox's shell): `--version` says a
 * verified version; `auth login` probes the sandbox from inside the real login process with shell BUILTINS only
 * (anything else it starts must be refused on macOS) and prints @@name=…@@. On Linux (no exec allow-list: the
 * process has its own network namespace) it also starts a listener on `listenPort` and connects to it from inside.
 */
function probingClaude(paths: { readonly servicePort: number; readonly home: string; readonly share: string; readonly stateDir: string; readonly listenPort: number }): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`;
  const probe = (name: string, cmd: string): string => `if ( ${cmd} ) >/dev/null 2>&1; then echo "@@${name}=ok@@"; else echo "@@${name}=denied@@"; fi`;
  return [
    '#!/bin/bash',
    'case "$1" in --version) echo "2.1.283 (Claude Code)"; exit 0 ;; esac',
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  if [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0; fi',
    '  echo \'{"loggedIn":false,"authMethod":"none"}\'; exit 1',
    'fi',
    'printf "@@argc=%s@@\\n" "$#"',
    'i=0; for a in "$@"; do i=$((i+1)); printf "@@arg%s=%s@@\\n" "$i" "$a"; done',
    'printf "@@cwd=%s@@\\n" "$(pwd -P)"',
    'names=$(compgen -e); printf "@@envnames=%s@@\\n" "${names//$\'\\n\'/,}"',
    probe('connect-host-service', `exec 3<>/dev/tcp/127.0.0.1/${paths.servicePort}`),
    probe('read-host-home', `read -r line < ${q(join(paths.home, '.ssh', 'id_ed25519'))}`),
    probe('read-share', `read -r line < ${q(join(paths.share, 'README.md'))}`),
    probe('write-share', `echo x > ${q(join(paths.share, 'login-leak.txt'))}`),
    probe('write-state-dir', `echo x > ${q(join(paths.stateDir, 'login-leak.txt'))}`),
    probe('write-guest-home', 'echo x > "$HOME/login-was-here.txt"'),
    probe('write-guest-cfg', 'echo \'{"claudeAiOauth":{"accessToken":"fake"}}\' > "$CLAUDE_CONFIG_DIR/.credentials.json"'),
    // The exec allow-list: nothing but the listed programs starts (a listener, a shell of another kind, a network tool).
    probe('exec-perl', '/usr/bin/perl -e 1'),
    probe('exec-sh', '/bin/sh -c :'),
    probe('exec-nc', '/usr/bin/nc -h'),
    probe('exec-cat', '/bin/cat /dev/null'),
    probe('exec-true', '/usr/bin/true'),
    ...(process.platform === 'linux'
      ? [
          `${nsListener('login', paths.listenPort, 6)} & listener=$!`,
          // one connection from inside (bash's /dev/tcp: no other program), retried until the listener is up
          `ok=denied; for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.2; if (exec 3<>/dev/tcp/127.0.0.1/${paths.listenPort} && read -r line <&3 && [ "$line" = token ]) 2>/dev/null; then ok=ok; break; fi; done`,
          'echo "@@login-inner-connect=$ok@@"',
          'echo "@@login-ready=yes@@"',
          'wait $listener',
        ]
      : []),
    'echo "@@done=yes@@"',
    'exit 7',
    '',
  ].join('\n');
}

describe.runIf(sandboxPlatform)('D-12 the guest login process in the real sandbox (stand-in claude)', () => {
  let stack: RealStack | undefined;
  let service: Awaited<ReturnType<typeof hostService>> | undefined;
  let scratch: string | undefined;
  let carol: Principal;
  let listenPort = 0;

  beforeAll(async () => {
    service = await hostService();
    scratch = await createTempDir('login-real-claude');
    const claudePath = join(scratch, 'bin', 'claude');
    await mkdir(join(scratch, 'bin'), { recursive: true });
    // The script needs the stack's paths: write a placeholder first, then the real script once they are known.
    await writeFile(claudePath, '#!/bin/sh\nexit 1\n');
    await chmod(claudePath, 0o755);
    stack = await startRealStack({ claudePath });
    listenPort = await freePort();
    await writeFile(claudePath, probingClaude({ servicePort: service.port, home: stack.home, share: stack.share, stateDir: stack.stateDir, listenPort }));
    carol = stack.member('dev:carol', 'Carol', 'runner');
  }, TIMEOUT);

  afterEach((context) => {
    if (context.task.result?.state === 'fail' && stack) process.stderr.write(`daemon warnings:\n${stack.warnings.join('\n')}\n`);
  });

  afterAll(async () => {
    await stack?.cleanup();
    await service?.close();
    if (scratch) await removeTempDir(scratch);
  }, TIMEOUT);

  it('reaches nothing but the guest dir: no host localhost service, no host home, no share, no write outside the guest dir, no other program; fixed command; audited exit code', async () => {
    const s = stack as RealStack;
    const svc = service as NonNullable<typeof service>;
    const session = await s.sessions.create({ kind: 'login', workspace: { mode: 'main' }, cols: 200, rows: 60, title: '$(touch /tmp/x)' }, TEST_CONN, carol);
    expect(session).toMatchObject({ kind: 'login', sandboxed: true, ownerUserId: 'dev:carol', status: 'running', title: 'Claude 訂閱登入（Carol）' });
    let hostReachedLoginListener: boolean | null = null;
    if (process.platform === 'linux') {
      // While the login process listens (inside its own network namespace), the host tries its loopback port.
      await until(async () => results(await s.screen(session.id, carol))['login-ready'] === 'yes', 'the login process to listen', 60_000);
      hostReachedLoginListener = await hostReaches(listenPort);
    }
    await until(() => s.sessions.listFor('dev:carol').find((x) => x.id === session.id)?.status === 'exited', 'the login process to exit', 60_000);
    const seen = results(await s.screen(session.id, carol));
    expect(seen['done']).toBe('yes');
    expect(seen).toMatchObject({
      'connect-host-service': 'denied',
      'read-host-home': 'denied',
      'read-share': 'denied',
      'write-share': 'denied',
      'write-state-dir': 'denied',
      'write-guest-home': 'ok',
      'write-guest-cfg': 'ok',
      'exec-true': 'ok',
    });
    if (process.platform === 'darwin') {
      // Seatbelt's "localhost" admits every local address, so on macOS only the listed programs may start in it.
      expect(seen).toMatchObject({ 'exec-perl': 'denied', 'exec-sh': 'denied', 'exec-nc': 'denied', 'exec-cat': 'denied' });
    } else {
      // Linux (ARCHITECTURE §7.6, §11 D-12): the login process has its own network namespace like every guest process
      // (the hardening requires --unshare-net), so there is no exec list to need: whatever listens in it, on any
      // address, is reachable from that namespace only. Measured here: a listener on 0.0.0.0 works from inside and
      // the host cannot connect to it (nor, above, can it reach the host's own loopback service).
      expect(seen).toMatchObject({ 'login-listen': 'ok', 'login-inner-connect': 'ok', 'login-accepts': '1' });
      expect(hostReachedLoginListener).toBe(false);
    }
    expect(svc.connections()).toBe(0);
    expect(existsSync(join(s.share, 'login-leak.txt'))).toBe(false);
    expect(existsSync(join(s.stateDir, 'login-leak.txt'))).toBe(false);
    // The command is the daemon's: exactly `<claude> <fixed login args>`, run from a daemon-owned directory.
    const argc = Number(seen['argc']);
    const args = Array.from({ length: argc }, (_, i) => seen[`arg${i + 1}`] ?? '');
    expect(args).toEqual(loginClaudeArgs('/usr/bin/true'));
    expect(seen['cwd']?.startsWith(join(s.stateDir, 'sessions'))).toBe(true);
    // The guest allow-list environment: no hook token or socket, no credentials; the guest's own HOME / config dir.
    const envNames = (seen['envnames'] ?? '').split(',').filter(Boolean);
    expect(envNames).toEqual(expect.arrayContaining(['HOME', 'CLAUDE_CONFIG_DIR', 'BROWSER', 'SMURG_SESSION_ID']));
    expect(envNames.filter((name) => /^(SMURG_SESSION_TOKEN|SMURG_HOOK_SOCKET|ANTHROPIC_API_KEY|AWS_|SSH_AUTH_SOCK)/.test(name))).toEqual([]);
    // Its outcome: exit code 7, audited with the exit code only; the credential is in the guest's config dir.
    expect(s.sessions.listFor('dev:carol').find((x) => x.id === session.id)).toMatchObject({ status: 'exited', exitCode: 7, endReason: 'exit' });
    const audit = await s.daemon.ctx.audit.query({ limit: 50 });
    expect(audit.find((entry) => entry.action === 'session.create' && entry.target === session.id)?.detail).toEqual({ sessionId: session.id, kind: 'login', sandboxed: true });
    expect(audit.find((entry) => entry.action === 'session.end' && entry.target === session.id)?.detail).toEqual({ sessionId: session.id, kind: 'login', reason: 'exit', exitCode: 7 });
    expect(JSON.stringify(audit)).not.toContain('@@');
    expect(await readFile(join(s.sessions.guestPaths('dev:carol').cfg, '.credentials.json'), 'utf8')).toContain('claudeAiOauth');
  }, TIMEOUT);

  it('an ordinary guest session still cannot listen for the network (the relaxation is the login process only)', async () => {
    const s = stack as RealStack;
    const session = await s.sessions.create({ kind: 'terminal', workspace: { mode: 'main' }, cols: 160, rows: 50 }, TEST_CONN, carol);
    try {
      if (process.platform === 'darwin') {
        const listen = `/usr/bin/perl -MIO::Socket::INET -e 'IO::Socket::INET->new(Listen => 1, LocalAddr => "127.0.0.1", LocalPort => 0, Proto => "tcp") or exit 1' && echo @@term-listen=ok@@ || echo @@term-listen=denied@@\r`;
        s.sessions.input({ sessionId: session.id, data: new TextEncoder().encode(listen) }, TEST_CONN, carol);
        let seen: Record<string, string> = {};
        await until(async () => {
          seen = results(await s.screen(session.id, carol));
          return seen['term-listen'] !== undefined && seen['term-listen'] !== '';
        }, 'the listen probe in a guest terminal', 30_000);
        expect(seen['term-listen']).toBe('denied');
        return;
      }
      // Linux: every guest process has its own network namespace, the login process no more than an agent's terminal
      // (there is no relaxation to confine). A listener in the terminal, even on 0.0.0.0, is unreachable from the host.
      const port = await freePort();
      s.sessions.input({ sessionId: session.id, data: new TextEncoder().encode(`${nsListener('term', port, 4)}\r`) }, TEST_CONN, carol);
      await until(async () => results(await s.screen(session.id, carol))['term-listen'] !== undefined, 'the listener in a guest terminal', 30_000);
      expect(results(await s.screen(session.id, carol))['term-listen']).toBe('ok');
      expect(await hostReaches(port)).toBe(false);
      await until(async () => results(await s.screen(session.id, carol))['term-accepts'] !== undefined, 'the listener to stop', 30_000);
      expect(results(await s.screen(session.id, carol))['term-accepts']).toBe('0');
    } finally {
      await s.sessions.end({ sessionId: session.id }, carol);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------------------------------------------------
// Part 2: the real claude
// ---------------------------------------------------------------------------------------------------------------------

async function verifiedClaudes(scratch: string): Promise<{ readonly path: string; readonly version: string }[]> {
  const candidates = [
    process.env['SMURG_TEST_CLAUDE_BIN'],
    ...(process.env['SMURG_TEST_CLAUDE_BINS'] ?? '').split(':'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const found: { path: string; version: string }[] = [];
  const probe = new ClaudeVersionProbe({ scratchParent: scratch, run: runProcess });
  const binaries = [...(await Promise.all(candidates.map((c) => resolveClaude(c, undefined)))), await resolveClaude(null, process.env['PATH'])];
  for (const binary of binaries) {
    if (!binary || found.some((f) => f.path === binary.realPath)) continue;
    const verdict = claudeVersionVerdict(await probe.output(binary), { claudeMinVersion: CLAUDE_VERIFIED_VERSIONS[0] as string, claudeVerifiedVersions: CLAUDE_VERIFIED_VERSIONS });
    if (verdict.ok && verdict.warning === null && !found.some((f) => f.version === verdict.version)) found.push({ path: binary.realPath, version: verdict.version });
  }
  return found;
}

describe.runIf(sandboxPlatform)('SPEC §13 item 5 / D-12 — the real claude login in a remote PTY, inside the guest sandbox', () => {
  let claudes: { readonly path: string; readonly version: string }[] = [];
  let scratch: string | undefined;

  beforeAll(async () => {
    scratch = await createTempDir('login-real-versions');
    claudes = await verifiedClaudes(scratch);
    if (claudes.length === 0) process.stderr.write('\n*** login.real.test.ts (real claude) SKIPPED: no verified Claude Code binary (SMURG_TEST_CLAUDE_BIN / SMURG_TEST_CLAUDE_BINS / PATH) ***\n\n');
    else process.stderr.write(`login.real.test.ts: real claude versions under test: ${claudes.map((c) => c.version).join(', ')}\n`);
  }, TIMEOUT);

  afterAll(async () => {
    if (scratch) await removeTempDir(scratch);
  });

  it('the login process reaches the login URL and the prompt for the pasted code (never completed); the guest\'s own settings cannot run a program in it', async (ctx) => {
    if (claudes.length === 0) {
      console.warn('[sessions] SKIPPED real-claude login test: no verified claude');
      return ctx.skip('no verified Claude Code binary');
    }
    for (const claude of claudes) {
      const stack = await startRealStack({ claudePath: claude.path, sessions: { testGuestEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } } });
      try {
        const dora = stack.member('dev:dora', 'Dora', 'runner');
        // The guest's own config (the guest controls it): a settings env BROWSER that would run their program. Before
        // any session of hers, the host writes it for the test.
        const paths = stack.sessions.guestPaths('dev:dora');
        const marker = join(paths.home, `browser-ran-${randomBytes(4).toString('hex')}`);
        await mkdir(paths.cfg, { recursive: true });
        await mkdir(paths.home, { recursive: true });
        const evil = join(paths.home, 'evil-browser.sh');
        await writeFile(evil, `#!/bin/sh\necho "$@" > '${marker}'\n`);
        await chmod(evil, 0o755);
        // Every other place of the guest's own config that names a program (finish-gate): a hook, an apiKeyHelper and a
        // user-scope MCP server. Each writes a marker with bash builtins only (bash is on the exec allow-list, as the
        // sandbox's shell). Measured without the protections (user settings loaded, network denied, both versions):
        // `claude auth login` runs the settings' BROWSER and none of these; they are kept here as a regression guard.
        const ran = (what: string): string => join(paths.home, `ran-${what}-${randomBytes(4).toString('hex')}`);
        const markers = { hook: ran('hook'), helper: ran('apikeyhelper'), mcp: ran('mcp') };
        const bashWrites = (file: string): string => `/bin/bash -c 'echo ran > ${file}'`;
        await writeFile(
          join(paths.cfg, 'settings.json'),
          JSON.stringify({
            env: { BROWSER: await realpath(evil) },
            apiKeyHelper: bashWrites(markers.helper),
            hooks: { SessionStart: [{ hooks: [{ type: 'command', command: bashWrites(markers.hook) }] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: bashWrites(markers.hook) }] }] },
          }),
        );
        await writeFile(
          join(paths.cfg, '.claude.json'),
          JSON.stringify({
            hasCompletedOnboarding: true,
            mcpServers: { planted: { type: 'stdio', command: '/bin/bash', args: ['-c', `echo ran > ${markers.mcp}`] } },
          }),
        );
        const session = await stack.sessions.create({ kind: 'login', workspace: { mode: 'main' }, cols: 200, rows: 50 }, TEST_CONN, dora);
        let flat = '';
        try {
          await until(async () => {
            flat = (await stack.screen(session.id, dora)).replace(/\s+/g, '');
            return flat.includes('Pastecodehereifprompted') || flat.includes('OAutherror');
          }, `the login screen of claude ${claude.version}`, 60_000);
          await new Promise((resolve) => setTimeout(resolve, 1_500)); // BROWSER would have run by now
          console.info(`[login.real] claude ${claude.version}: ${flat.slice(0, 160)}…`);
          expect(flat, `claude ${claude.version}`).not.toContain('FailedtostartOAuthcallbackserver');
          expect(flat).toContain('Pastecodehereifprompted');
          expect(flat).toContain('oauth/authorize');
          expect(flat).toContain('platform.claude.com%2Foauth%2Fcode%2Fcallback'); // the manual (pasted code) URL
          expect(existsSync(marker), 'the guest settings env BROWSER must not run').toBe(false);
          for (const [what, file] of Object.entries(markers)) expect(existsSync(file), `the guest's ${what} must not run in the login process`).toBe(false);
          expect(stack.sessions.listFor('dev:dora').find((x) => x.id === session.id)?.status).toBe('running');
          // The callback server listens, and only on loopback (Seatbelt cannot narrow the address itself; this is
          // Claude Code's own choice, and nothing else may start in the login process).
          const pid = stack.sessions.ptyPid(session.id);
          expect(pid).not.toBeNull();
          const lsof = await runProcess('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { env: { PATH: '/usr/bin:/bin:/usr/sbin' }, cwd: '/', timeoutMs: 15_000, maxStdoutBytes: 64 * 1024 });
          const listening = lsof.stdout.split('\n').filter((line) => line.includes('(LISTEN)')).map((line) => /TCP (\S+):\d+ \(LISTEN\)/.exec(line)?.[1] ?? line);
          console.info(`[login.real] claude ${claude.version} listens on: ${listening.join(', ')}`);
          expect(listening.length).toBeGreaterThan(0);
          for (const address of listening) expect(['127.0.0.1', 'localhost', '[::1]']).toContain(address);
        } finally {
          await stack.sessions.end({ sessionId: session.id }, dora);
        }
        // Never completed: no credential.
        expect(existsSync(join(paths.cfg, '.credentials.json'))).toBe(false);
      } finally {
        await stack.cleanup();
      }
    }
  }, TIMEOUT * 2);
});
