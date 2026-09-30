// The test-support module other packages use: random local ports, hermetic per-relay keys and vars, the tap only on
// request, and stop() that really stops the relay.
import { createConnection } from 'node:net';
import { RELAY_PATHS, relayHttpUrl } from '@smurg/protocol/relay';
import { describe, expect, it } from 'vitest';
import { startLocalRelay } from '../test-support/index.ts';

function portAccepts(origin: string): Promise<boolean> {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve) => {
    const socket = createConnection({ host: hostname, port: Number(port) });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

describe('startLocalRelay', () => {
  it('starts independent relays on random 127.0.0.1 ports with their own signing keys', async () => {
    const saved = { ...process.env };
    // wrangler merges process.env into declared vars/secrets when no .dev.vars exists; the harness overrides must win.
    process.env['DEV_LOGIN'] = '0';
    process.env['RELAY_ISSUER'] = 'https://leaked.example';
    process.env['RELAY_SIGNING_KEY'] = 'not-a-key';
    const [a, b] = await Promise.all([startLocalRelay(), startLocalRelay()]).finally(() => {
      for (const key of ['DEV_LOGIN', 'RELAY_ISSUER', 'RELAY_SIGNING_KEY']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
    try {
      for (const relay of [a, b]) {
        expect(relay.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(relay.wsOrigin).toBe(relay.origin.replace('http:', 'ws:'));
        expect(relay.issuer).toBe(relay.origin);
        expect(relay.tap).toBeUndefined();
        const session = await relay.devLogin('amy', { displayName: 'Amy' });
        expect(session).toMatchObject({ userId: 'dev:amy', displayName: 'Amy' });
        const me = await fetch(relayHttpUrl(relay.origin, RELAY_PATHS.me), { headers: { authorization: `Bearer ${session.token}` } });
        expect(me.status).toBe(200);
      }
      expect(a.origin).not.toBe(b.origin);
      expect(a.signingKey).not.toBe(b.signingKey);
      // A token of one relay means nothing to the other.
      const fromA = await a.devLogin('amy');
      const me = await fetch(relayHttpUrl(b.origin, RELAY_PATHS.me), { headers: { authorization: `Bearer ${fromA.token}` } });
      expect(me.status).toBe(401);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
    expect(await portAccepts(a.origin)).toBe(false);
    expect(await portAccepts(b.origin)).toBe(false);
    await a.stop(); // idempotent
  });

  it('starts a tap collector only when asked, and stops it with the relay', async () => {
    const relay = await startLocalRelay({ tap: true });
    const tap = relay.tap;
    try {
      expect(tap?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/tap$/);
      await fetch(relayHttpUrl(relay.origin, RELAY_PATHS.healthz));
      await tap?.waitFor((frames) => frames.some((f) => f.source === 'worker' && f.kind === 'request'));
    } finally {
      await relay.stop();
    }
    if (!tap) throw new Error('tap missing');
    expect(await portAccepts(new URL(tap.url).origin)).toBe(false);
  });
});
