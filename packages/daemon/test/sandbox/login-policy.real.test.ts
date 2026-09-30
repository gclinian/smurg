// ARCHITECTURE §11 D-12 at the sandbox level, with the REAL srt (macOS Seatbelt): the policy of a guest's Claude
// LOGIN process (SandboxSpec + `loginProcess: true`, mode 'login') compared with an ordinary guest process. The test
// lets `/usr/bin/perl` into the login's exec allow-list so the network rules can be probed from inside (the sessions
// module never does: its list is claude, the no-op BROWSER and /usr/bin/security; test/sessions/login.real.test.ts).
//
// What the login process may do that a guest session cannot: bind + listen + accept (Seatbelt's `localhost`, which
// matches every local address, measured below), and nothing else: no connection to the host's localhost services, no
// read of the host home or the share, no write outside the guest dir, no program outside its allow-list.
import { createConnection, createServer, type Server } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SandboxSpec } from '../../src/core/interfaces.ts';
import { LOOPBACK_LISTEN_LINES } from '../../src/sandbox/harden.ts';
import { createSandboxFixture, guestEnv, isDarwin, printWarningsOnFailure, q, results, startWrapped, type SandboxFixture } from './helpers.ts';

const TIMEOUT = 90_000;

function perlProbe(name: string, code: string, ...args: string[]): string {
  return `if /usr/bin/perl -MIO::Socket::INET -e ${q(code)} ${args.join(' ')} >/dev/null 2>&1; then echo "@@${name}=ok@@"; else echo "@@${name}=denied@@"; fi`;
}

function shellProbe(name: string, cmd: string): string {
  return `if ( ${cmd} ) >/dev/null 2>&1; then echo "@@${name}=ok@@"; else echo "@@${name}=denied@@"; fi`;
}

const LISTEN = 'IO::Socket::INET->new(Listen => 1, LocalAddr => $ARGV[0], LocalPort => 0, Proto => "tcp") or exit 1';
const CONNECT = 'IO::Socket::INET->new(PeerAddr => "127.0.0.1", PeerPort => $ARGV[0], Proto => "tcp", Timeout => 3) or exit 1';
/** Listens on 127.0.0.1, prints the port, accepts one connection from the host side within 20 s. */
const LISTEN_ACCEPT =
  '$| = 1; my $s = IO::Socket::INET->new(Listen => 1, LocalAddr => "127.0.0.1", LocalPort => 0, Proto => "tcp") or do { print "\\@\\@listen-loopback=denied\\@\\@\\n"; exit 0 }; ' +
  'print "\\@\\@listen-loopback=ok\\@\\@\\n\\@\\@listen-port=" . $s->sockport . "\\@\\@\\n"; local $SIG{ALRM} = sub { print "\\@\\@accept=timeout\\@\\@\\n"; exit 0 }; alarm 20; ' +
  'my $c = $s->accept; print(($c ? "\\@\\@accept=ok\\@\\@" : "\\@\\@accept=denied\\@\\@") . "\\n");';

describe.runIf(isDarwin)('D-12 the login process policy (real srt, macOS)', () => {
  let f: SandboxFixture | undefined;
  let service: Server | undefined;
  let servicePort = 0;
  let serviceConnections = 0;

  beforeAll(async () => {
    f = await createSandboxFixture({ files: { 'README.md': 'share readme\n' } });
    service = createServer((socket) => {
      serviceConnections++;
      socket.end('host service\n');
    });
    await new Promise<void>((resolve) => (service as Server).listen(0, '127.0.0.1', () => resolve()));
    servicePort = ((service as Server).address() as { port: number }).port;
  }, TIMEOUT);

  afterEach((context) => printWarningsOnFailure(f, context));

  afterAll(async () => {
    await new Promise<void>((resolve) => (service ? service.close(() => resolve()) : resolve()));
    await f?.cleanup();
  }, TIMEOUT);

  async function loginSpec(command: string, programs: readonly string[]): Promise<SandboxSpec & { loginProcess: true; loginPrograms: readonly string[] }> {
    const fx = f as SandboxFixture;
    const guest = await fx.guest('lara');
    const settingsDir = await fx.settingsDir(`ses_login_${Date.now()}`, '{}\n');
    return { ...fx.spec({ command, guest, settingsDir, rootPath: guest.home, env: guestEnv(guest) }), loginProcess: true, loginPrograms: programs };
  }

  it('may listen and accept, and nothing else: no host localhost service, no host home or share, no write outside the guest dir, no program outside its list', async () => {
    const fx = f as SandboxFixture;
    const guest = await fx.guest('lara');
    const command = [
      perlProbe('connect-host-service', CONNECT, String(servicePort)),
      shellProbe('connect-host-service-bash', `exec 3<>/dev/tcp/127.0.0.1/${servicePort}`),
      shellProbe('read-host-home', `read -r line < ${q(join(fx.home, '.ssh', 'id_ed25519'))}`),
      shellProbe('read-share', `read -r line < ${q(join(fx.share, 'README.md'))}`),
      shellProbe('write-share', `echo x > ${q(join(fx.share, 'login-leak.txt'))}`),
      shellProbe('write-state-dir', `echo x > ${q(join(fx.stateDir, 'login-leak.txt'))}`),
      shellProbe('write-guest', `echo x > ${q(join(guest.home, 'ok.txt'))}`),
      shellProbe('exec-unlisted', '/bin/ls /'),
      `/usr/bin/perl -MIO::Socket::INET -e ${q(LISTEN_ACCEPT)}`,
      'echo @@done=yes@@',
    ].join('; ');
    const spec = await loginSpec(command, ['/usr/bin/perl']);
    const wrapped = await fx.sandbox.wrap(spec);
    // The generated profile: the listen rules and the exec allow-list, nothing outbound.
    expect(wrapped.args[1]).toContain(LOOPBACK_LISTEN_LINES[1] as string);
    expect(wrapped.args[1]).toContain(LOOPBACK_LISTEN_LINES[2] as string);
    expect(wrapped.args[1]).toContain('(deny process-exec)');
    expect(wrapped.args[1]).toContain('(allow process-exec (literal "/bin/bash") (literal "/usr/bin/perl"))');
    expect(wrapped.args[1]).not.toMatch(/network-outbound \(remote ip "localhost:\*"\)|local ip "\*:\*"/);
    expect(wrapped.cwd).toBe(guest.home);
    const proc = startWrapped(wrapped, { timeoutMs: 60_000 });
    await proc.waitForOutput(/@@listen-port=\d+@@|@@listen-loopback=denied@@/, 30_000);
    const port = Number(results(proc.output())['listen-port']);
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', reject);
    });
    const { output } = await proc.exited;
    expect(results(output)).toMatchObject({
      'connect-host-service': 'denied',
      'connect-host-service-bash': 'denied',
      'read-host-home': 'denied',
      'read-share': 'denied',
      'write-share': 'denied',
      'write-state-dir': 'denied',
      'write-guest': 'ok',
      'exec-unlisted': 'denied',
      'listen-loopback': 'ok',
      accept: 'ok',
      done: 'yes',
    });
    expect(serviceConnections).toBe(0);
    expect(existsSync(join(fx.share, 'login-leak.txt'))).toBe(false);
    expect(output).not.toContain('SMURG-FAKE');
  }, TIMEOUT);

  it('known limit (measured): Seatbelt cannot narrow a listen to the loopback interface — "localhost" also admits 0.0.0.0; the exec allow-list is what keeps other programs out', async () => {
    const fx = f as SandboxFixture;
    const command = [perlProbe('listen-any', LISTEN, '0.0.0.0'), perlProbe('listen-loopback', LISTEN, '127.0.0.1')].join('; ');
    const { output } = await startWrapped(await fx.sandbox.wrap(await loginSpec(command, ['/usr/bin/perl'])), { timeoutMs: 60_000 }).exited;
    // If this ever reads `denied`, Seatbelt learned to tell loopback apart: update ARCHITECTURE §11 D-12.
    expect(results(output)).toMatchObject({ 'listen-loopback': 'ok', 'listen-any': 'ok' });
    // …and without perl in the list, nothing can even try.
    const { output: locked } = await startWrapped(await fx.sandbox.wrap(await loginSpec(perlProbe('listen-loopback', LISTEN, '127.0.0.1'), ['/usr/bin/true'])), { timeoutMs: 60_000 }).exited;
    expect(results(locked)['listen-loopback']).toBe('denied');
  }, TIMEOUT);

  it('an ordinary guest process (main-workspace policy) cannot listen at all, on any address', async () => {
    const fx = f as SandboxFixture;
    const guest = await fx.guest('otto');
    const command = [perlProbe('listen-loopback', LISTEN, '127.0.0.1'), perlProbe('listen-any', LISTEN, '0.0.0.0')].join('; ');
    const wrapped = await fx.sandbox.wrap(fx.spec({ command, guest, settingsDir: await fx.settingsDir(`ses_plain_${Date.now()}`, '{}\n') }));
    expect(wrapped.args[1]).not.toContain(LOOPBACK_LISTEN_LINES[1] as string);
    expect(wrapped.args[1]).not.toContain('(deny process-exec)');
    const { output } = await startWrapped(wrapped, { timeoutMs: 60_000 }).exited;
    expect(results(output)).toMatchObject({ 'listen-loopback': 'denied', 'listen-any': 'denied' });
  }, TIMEOUT);

  it('refuses a login spec that names the share, a shared dir, a hook token, or no program list (fail closed)', async () => {
    const fx = f as SandboxFixture;
    const base = await loginSpec('true', ['/usr/bin/true']);
    const refused = async (spec: SandboxSpec): Promise<unknown> => fx.sandbox.wrap(spec).then(() => null, (e: unknown) => (e as { detail?: unknown }).detail);
    expect(await refused({ ...base, rootPath: fx.share })).toEqual({ reason: 'root-unknown' });
    expect(await refused({ ...base, readOnlyPaths: [fx.share] })).toEqual({ reason: 'policy-invalid' });
    expect(await refused({ ...base, env: { ...base.env, SMURG_SESSION_TOKEN: 'tok', SMURG_HOOK_SOCKET: fx.ctx.config.runPaths.hook } })).toEqual({ reason: 'policy-invalid' });
    expect(await refused({ ...base, loginPrograms: [] } as SandboxSpec)).toEqual({ reason: 'policy-invalid' });
    expect(await refused({ ...base, loginPrograms: [join(fx.stateDir, 'x')] } as SandboxSpec)).toEqual({ reason: 'policy-invalid' });
    expect(await refused({ ...base, extraReadPaths: [join(fx.share, 'README.md')] })).toEqual({ reason: 'policy-invalid' });
  }, TIMEOUT);
});
