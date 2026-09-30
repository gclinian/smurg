// Guests never listen for connections from other machines (ARCHITECTURE §7.6 "Sandbox (guests)", §11 D-12), with the
// REAL srt on macOS (Seatbelt).
//
// srt 0.0.77 writes `(allow network-bind (local ip "localhost:<proxy port>"))` and the matching network-inbound rule
// into every profile, next to the outbound rule a process needs to reach its proxy. Seatbelt's "localhost" matches
// every local address (measured: 0.0.0.0 and the LAN address too), and srt's proxy listens on 127.0.0.1 only, so with
// those two rules a guest process could listen on <LAN address>:<proxy port> (or 0.0.0.0 with SO_REUSEADDR) and accept
// connections from the network (finish-gate, 2026-09-29). The hardening removes them (a sandboxed process only ever
// CONNECTS to the proxy) and this file proves, from inside the real sandbox, that:
//   * an ordinary guest process can listen nowhere: not on the proxy's port on any address, with or without
//     SO_REUSEADDR / SO_REUSEPORT, not on port 0, and nothing on the host side can connect to it;
//   * it still reaches an allow-listed server through the proxy (the outbound rule stays);
//   * the Claude login process has exactly one extra right, a TCP listener (its OAuth callback): no UDP socket, no
//     connection to a host service on 127.0.0.1, no Unix socket but the hook socket (it has no token for it).
import { networkInterfaces } from 'node:os';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SandboxSpec, WrappedCommand } from '../../src/core/interfaces.ts';
import { LOOPBACK_LISTEN_LINES } from '../../src/sandbox/harden.ts';
import { closeServer, countingHttpServer, createSandboxFixture, isDarwin, marker, printWarningsOnFailure, q, results, runWrapped, startWrapped, unixEchoServer, type SandboxFixture } from './helpers.ts';

const TIMEOUT = 120_000;

/** Every non-internal IPv4 address of this machine (the LAN side a listener could be reached from). */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

/** The proxy port srt put into the profile (its only localhost TCP port). */
function proxyPortOf(wrapped: WrappedCommand): number {
  const match = /\(allow network-outbound \(remote ip "localhost:([0-9]{1,5})"\)\)/.exec(wrapped.args[1] as string);
  if (!match) throw new Error('no proxy port in the profile');
  return Number(match[1]);
}

/** Tries to listen on addr:port (perl); prints @@name=ok@@ with the port, or @@name=denied@@. Waits `holdS` for a peer. */
function listenProbe(name: string, addr: string, port: number | string, option: 'plain' | 'reuseaddr' | 'reuseport', holdS = 0): string {
  const code = [
    '$| = 1; my ($addr, $port, $opt, $hold) = @ARGV;',
    'my %o = (Listen => 5, LocalAddr => $addr, LocalPort => $port, Proto => "tcp");',
    '$o{ReuseAddr} = 1 if $opt eq "reuseaddr"; $o{ReusePort} = 1 if $opt eq "reuseport";',
    `my $s = IO::Socket::INET->new(%o) or do { print "\\@\\@${name}=denied\\@\\@\\n"; exit 0 };`,
    `print "\\@\\@${name}=ok\\@\\@\\n"; if ($hold > 0) { local $SIG{ALRM} = sub { exit 0 }; alarm $hold; my $c = $s->accept; print "\\@\\@${name}-accepted=yes\\@\\@\\n" if $c; }`,
  ].join(' ');
  return `/usr/bin/perl -MIO::Socket::INET -e ${q(code)} ${q(addr)} ${port} ${option} ${holdS}`;
}

function udpProbe(name: string, addr: string): string {
  const code = `my $s = IO::Socket::INET->new(Proto => "udp", LocalAddr => $ARGV[0], LocalPort => 0) or do { print "\\@\\@${name}=denied\\@\\@\\n"; exit 0 }; print "\\@\\@${name}=ok\\@\\@\\n";`;
  return `/usr/bin/perl -MIO::Socket::INET -e ${q(code)} ${q(addr)}`;
}

function unixProbe(name: string, path: string): string {
  const code = `my $s = IO::Socket::UNIX->new(Peer => $ARGV[0], Type => SOCK_STREAM) or do { print "\\@\\@${name}=denied\\@\\@\\n"; exit 0 }; print $s "{}\\n"; my $l = <$s>; print "\\@\\@${name}=ok\\@\\@\\n";`;
  return `/usr/bin/perl -MIO::Socket::UNIX -MSocket -e ${q(code)} ${q(path)}`;
}

/** Connects from the host side; resolves true when something accepted. */
function hostConnects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 2_000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe.runIf(isDarwin)('guests never listen for the network: srt\'s proxy-port bind rules are removed (real srt, macOS)', () => {
  let f: SandboxFixture;
  const lan = lanAddresses();

  beforeAll(async () => {
    f = await createSandboxFixture({ files: { 'README.md': 'share\n' } });
    if (lan.length === 0) console.warn('[network-listen] no LAN address on this machine: the host-side connection checks use 0.0.0.0 only');
  }, TIMEOUT);

  afterEach((context) => printWarningsOnFailure(f, context));

  afterAll(async () => {
    await f?.cleanup();
  }, TIMEOUT);

  async function guestWrap(command: string, extra: Partial<SandboxSpec> = {}): Promise<WrappedCommand> {
    const guest = await f.guest('nina');
    return f.sandbox.wrap(f.spec({ command, guest, settingsDir: await f.settingsDir(`ses_listen_${Date.now()}`, '{}\n'), ...extra }));
  }

  it('the profile keeps only the outbound rule to the proxy: no bind / inbound rule on any TCP port', async () => {
    const wrapped = await guestWrap('true');
    const profile = wrapped.args[1] as string;
    expect(proxyPortOf(wrapped)).toBeGreaterThan(0);
    expect(profile).not.toMatch(/network-bind \(local ip/);
    expect(profile).not.toMatch(/network-inbound/);
  }, TIMEOUT);

  it('an ordinary guest process cannot listen on the proxy\'s port on any address (plain, SO_REUSEADDR, SO_REUSEPORT), nor on port 0; nothing accepts a connection', async () => {
    const probeWrap = await guestWrap('true');
    const port = proxyPortOf(probeWrap);
    const addresses = ['0.0.0.0', '127.0.0.1', ...lan];
    const lines: string[] = [];
    for (const [i, addr] of addresses.entries()) {
      for (const option of ['plain', 'reuseaddr', 'reuseport'] as const) lines.push(listenProbe(`proxyport-${i}-${option}`, addr, port, option, addr === '127.0.0.1' ? 0 : 4));
      lines.push(listenProbe(`anyport-${i}`, addr, 0, 'reuseaddr'));
    }
    const proc = startWrapped(await guestWrap([...lines, 'echo @@done=yes@@'].join('\n')), { timeoutMs: 90_000 });
    // While the probes hold their (would-be) listeners, the host side tries the LAN addresses at the proxy's port.
    const reached: string[] = [];
    for (let round = 0; round < 6 && !/@@done=yes@@/.test(proc.output()); round++) {
      for (const addr of lan) if (await hostConnects(addr, port)) reached.push(addr);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const { output } = await proc.exited;
    const r = results(output);
    expect(r['done']).toBe('yes');
    const opened = Object.entries(r).filter(([name, value]) => name !== 'done' && value !== 'denied');
    expect(opened, `listeners a guest could open: ${JSON.stringify(opened)}`).toEqual([]);
    expect(reached).toEqual([]);
  }, TIMEOUT);

  it('control: the guest still reaches an allow-listed server through the proxy (the outbound rule stays)', async () => {
    const allowed = await countingHttpServer('allowed-ok');
    try {
      await f.setAllowedDomains([`127.0.0.1:${allowed.port}`]);
      const run = await runWrapped(await guestWrap(`echo "@@allowed=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 10 --noproxy '' http://127.0.0.1:${allowed.port}/)@@"`));
      expect(results(run.output)['allowed']).toBe('200');
      expect(allowed.hits()).toBe(1);
    } finally {
      await f.setAllowedDomains([]);
      await allowed.close();
    }
  }, TIMEOUT);

  it('the Claude login process: a TCP listener (its callback) and nothing else — no UDP socket, no host service on 127.0.0.1, not the daemon\'s control socket (the hook socket, like every guest, without a token)', async () => {
    const service = await countingHttpServer('host-service');
    const hookReply = marker('HOOK-PONG');
    const ctlReply = marker('CTL-PONG');
    const otherPath = join(f.runDir, `o-${Date.now()}.sock`);
    const hook = await unixEchoServer(f.ctx.config.runPaths.hook, hookReply);
    const ctl = await unixEchoServer(f.ctx.config.runPaths.ctl, ctlReply);
    const other = await unixEchoServer(otherPath, marker('OTHER-PONG'));
    try {
      const guest = await f.guest('lara');
      const command = [
        listenProbe('tcp-loopback', '127.0.0.1', 0, 'plain'),
        udpProbe('udp-loopback', '127.0.0.1'),
        ...lan.map((addr, i) => udpProbe(`udp-lan-${i}`, addr)),
        `if /usr/bin/perl -MIO::Socket::INET -e 'IO::Socket::INET->new(PeerAddr => "127.0.0.1", PeerPort => $ARGV[0], Proto => "tcp", Timeout => 3) or exit 1' ${service.port}; then echo @@host-service=ok@@; else echo @@host-service=denied@@; fi`,
        unixProbe('hook-socket', f.ctx.config.runPaths.hook),
        unixProbe('control-socket', f.ctx.config.runPaths.ctl),
        unixProbe('other-socket', otherPath),
        'echo @@done=yes@@',
      ].join('\n');
      const spec = { ...f.spec({ command, guest, settingsDir: await f.settingsDir(`ses_login_${Date.now()}`, '{}\n'), rootPath: guest.home }), loginProcess: true as const, loginPrograms: ['/usr/bin/perl'] };
      const wrapped = await f.sandbox.wrap(spec);
      for (const line of LOOPBACK_LISTEN_LINES) expect(wrapped.args[1]).toContain(line);
      const r = results((await runWrapped(wrapped, 90_000)).output);
      expect(r['done']).toBe('yes');
      // The hook socket answers (positive control of the probe: the same rule every guest has; the login carries no
      // token for it), the control socket and any other socket do not.
      expect(r).toMatchObject({ 'tcp-loopback': 'ok', 'udp-loopback': 'denied', 'host-service': 'denied', 'hook-socket': 'ok', 'control-socket': 'denied', 'other-socket': 'denied' });
      for (const i of lan.keys()) expect(r[`udp-lan-${i}`]).toBe('denied');
      expect(service.hits()).toBe(0);
    } finally {
      await closeServer(hook);
      await closeServer(ctl);
      await closeServer(other);
      await service.close();
    }
  }, TIMEOUT);
});
