// SPEC R3 hard gate (handshake and admission). Every attack below runs against the real drivers over an in-memory
// relay that records every byte it forwards and can tamper with them.
import { describe, expect, it } from 'vitest';
import { concatBytes, equalBytes, randomBytes, toHex, utf8Decode, utf8Encode } from '../bytes.ts';
import { HANDSHAKE_MODE_BYTES, buildNoisePrologue, deriveInviteKeys, generateInviteSecret } from '../invite.ts';
import { resolveHandshakePattern } from '../noise/patterns.ts';
import { HandshakeState } from '../noise/state.ts';
import { nobleSuite, x25519KeyPair, type NoiseKeyPair } from '../noise/suite.ts';
import { nodeCryptoSuite } from '../node/aead.ts';
import { webCryptoX25519KeyPair } from '../browser/webcrypto-key.ts';
import { ChannelError } from './errors.ts';
import { CHANNEL_FRAME, genericAbortFrame, isGenericAbortFrame } from './frames.ts';
import { clientConnect, daemonAccept } from './handshake.ts';
import { createMemoryTransportPair } from './transport.ts';
import { FakeDaemon, WS, contains, delaySends, errorOf, nextMessage, runHandshake, valueOf, type Tap } from './testing/harness.ts';

const pinned = (d: FakeDaemon) => ({ kind: 'pinned' as const, daemonStaticKey: d.staticKey.publicKey });
const daemonFrames = (log: { direction: string; frame: Uint8Array }[] | readonly { direction: string; frame: Uint8Array }[]) =>
  log.filter((l) => l.direction === 'daemon->client').map((l) => l.frame);

describe('successful handshakes', () => {
  it('invite mode (XXpsk3): verdict, hello and app messages arrive; the relay sees no secret and no plaintext', async () => {
    const daemon = new FakeDaemon();
    const device = x25519KeyPair();
    const { trust, secret } = daemon.addInvite();
    const HELLO = 'Amy Chen <display-name marker 5eed-4a1b>';
    let pinnedKey: Uint8Array | undefined;
    const r = await runHandshake(daemon, {
      deviceKey: device,
      trust,
      hello: utf8Encode(HELLO),
      onDaemonVerified: (key, mode) => {
        expect(mode).toBe('invite');
        pinnedKey = key;
      },
    });
    const client = valueOf(r.client);
    const d = valueOf(r.daemon);
    expect(client.mode).toBe('invite');
    expect(utf8Decode(client.verdict)).toBe(`welcome invite ${HELLO}`);
    expect(client.daemonStaticKey).toEqual(daemon.staticKey.publicKey);
    expect(pinnedKey).toEqual(daemon.staticKey.publicKey);
    expect(d.mode).toBe('invite');
    expect(d.inviteId).toEqual(deriveInviteKeys(secret).inviteId);
    expect(d.clientStaticKey).toEqual(device.publicKey);
    expect(utf8Decode(d.helloPayload)).toBe(HELLO);
    expect(client.channel.handshakeHash).toEqual(d.channel.handshakeHash);
    expect(client.channel.remoteStaticKey).toEqual(daemon.staticKey.publicKey);
    expect(d.channel.remoteStaticKey).toEqual(device.publicKey);
    expect(daemon.usesLeft(secret)).toBe(0);

    // Application traffic both ways, including a 1 MiB "file" with a marker.
    const command = utf8Encode('TOP-SECRET terminal output: rm -rf / --no-preserve-root');
    const file = new Uint8Array(1 << 20).fill(0x41);
    file.set(utf8Encode('FILE-CONTENT-MARKER-7f3a9c'), 12_345);
    const atDaemon = nextMessage(d.channel);
    client.channel.send(command);
    expect(await atDaemon).toEqual(command);
    const atClient = nextMessage(client.channel);
    d.channel.send(file);
    expect(equalBytes(await atClient, file)).toBe(true);

    // Frame shapes: HELLO = type+ver+mode + e(32) + tag(16); the invite id is not on the wire.
    expect(r.log[0]!.frame).toHaveLength(3 + 32 + 16);
    expect(r.log[0]!.frame[2]).toBe(HANDSHAKE_MODE_BYTES.invite);
    const { inviteId, psk } = deriveInviteKeys(secret);
    const needles = {
      secret,
      psk,
      inviteId,
      deviceStaticKey: device.publicKey,
      hello: utf8Encode(HELLO),
      command,
      marker: utf8Encode('FILE-CONTENT-MARKER-7f3a9c'),
      fileRun: new Uint8Array(64).fill(0x41),
    };
    for (const [name, needle] of Object.entries(needles)) {
      expect(r.log.some((l) => contains(l.frame, needle)), `relay log contains ${name}`).toBe(false);
    }
    client.channel.close();
  });

  it('device mode (XX) reconnect with the pin persisted at msg2; mixed noble client / node:crypto daemon', async () => {
    const daemon = new FakeDaemon();
    const device = x25519KeyPair();
    let pin: Uint8Array | undefined;
    valueOf((await runHandshake(daemon, { deviceKey: device, trust: daemon.addInvite().trust, onDaemonVerified: (k) => void (pin = k) })).client);
    const r = await runHandshake(
      daemon,
      { deviceKey: device, trust: { kind: 'pinned', daemonStaticKey: pin! }, hello: utf8Encode('again') },
      { daemonOptions: { suite: nodeCryptoSuite } },
    );
    const client = valueOf(r.client);
    expect(client.mode).toBe('device');
    expect(utf8Decode(client.verdict)).toBe('welcome device again');
    expect(valueOf(r.daemon).inviteId).toBeUndefined();
    expect(r.log[0]!.frame).toHaveLength(3 + 32);
    expect(r.log[0]!.frame[2]).toBe(HANDSHAKE_MODE_BYTES.device);
    expect(r.log.map((l) => l.frame[0])).toEqual([CHANNEL_FRAME.HELLO, CHANNEL_FRAME.REPLY, CHANNEL_FRAME.FINISH, CHANNEL_FRAME.DATA]);
    const ping = nextMessage(valueOf(r.daemon).channel);
    client.channel.send(utf8Encode('ping'));
    expect(await ping).toEqual(utf8Encode('ping'));
  });

  it('works with a non-extractable WebCrypto device key (async DH)', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
    await expect(crypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow();
    const deviceKey = await webCryptoX25519KeyPair(pair);
    const daemon = new FakeDaemon();
    const r = await runHandshake(daemon, { deviceKey, trust: daemon.addInvite().trust });
    expect(valueOf(r.daemon).clientStaticKey).toEqual(deviceKey.publicKey);
    const again = await runHandshake(daemon, { deviceKey, trust: pinned(daemon) });
    expect(again.client.status).toBe('fulfilled');
  });

  it('8 MiB application messages round-trip in both directions', { timeout: 60_000 }, async () => {
    const daemon = new FakeDaemon();
    const r = await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust: daemon.addInvite().trust }, { daemonOptions: { suite: nodeCryptoSuite } });
    const client = valueOf(r.client).channel;
    const d = valueOf(r.daemon).channel;
    const up = randomBytes(8 * 1024 * 1024);
    const down = randomBytes(8 * 1024 * 1024);
    const gotUp = nextMessage(d);
    client.send(up);
    expect(equalBytes(await gotUp, up)).toBe(true);
    const gotDown = nextMessage(client);
    d.send(down);
    expect(equalBytes(await gotDown, down)).toBe(true);
  });

  it('messages the daemon sends right after the verdict (even merged into the verdict frame) reach the client', async () => {
    const daemon = new FakeDaemon();
    let held: Uint8Array | null = null;
    // The relay holds the verdict frame and delivers it merged with the next DATA frame.
    const tap: Tap = (frame, direction) => {
      if (direction !== 'daemon->client' || frame[0] !== CHANNEL_FRAME.DATA) return [frame];
      if (!held) {
        held = frame;
        return [];
      }
      return [concatBytes(held, frame.subarray(1))];
    };
    const pair = createMemoryTransportPair({ tap });
    const clientP = clientConnect(pair.client, { workspaceId: WS, deviceKey: x25519KeyPair(), trust: daemon.addInvite().trust, hello: utf8Encode('x') });
    const d = await daemon.accept(pair.daemon);
    d.channel.send(utf8Encode('presence.state'));
    const client = await clientP;
    expect(await nextMessage(client.channel)).toEqual(utf8Encode('presence.state'));
  });

  it('decrypted messages do not alias each other or any transport buffer', async () => {
    const daemon = new FakeDaemon();
    const r = await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust: daemon.addInvite().trust });
    const client = valueOf(r.client).channel;
    const d = valueOf(r.daemon).channel;
    const received: Uint8Array[] = [];
    d.onMessage((m) => received.push(m));
    client.send(utf8Encode('message one'));
    client.send(randomBytes(70_000));
    client.send(utf8Encode('message three'));
    await new Promise((res) => setTimeout(res, 10));
    expect(received).toHaveLength(3);
    const buffers = new Set(received.map((m) => m.buffer));
    expect(buffers.size).toBe(3);
    for (const m of received) {
      expect(m.byteOffset).toBe(0);
      expect(m.buffer.byteLength).toBe(m.byteLength);
    }
    const snapshot = received.map((m) => m.slice());
    received[0]!.fill(0);
    received[1]!.fill(0);
    expect(received[2]).toEqual(snapshot[2]);
  });
});

describe('R3: no valid invite fragment / wrong PSK', () => {
  it('a client without a valid fragment (random s) is refused at msg1 with the generic ABORT; nothing is admitted', async () => {
    const daemon = new FakeDaemon();
    daemon.addInvite();
    const r = await runHandshake(daemon, {
      deviceKey: x25519KeyPair(),
      trust: { kind: 'invite', fingerprint: randomBytes(32), secret: generateInviteSecret() },
    });
    expect(errorOf(r.daemon)).toMatchObject({ code: 'invite-unknown', stage: 1 });
    expect(errorOf(r.client)).toMatchObject({ code: 'aborted', stage: 2 });
    expect(daemonFrames(r.log)).toEqual([genericAbortFrame()]);
    expect(daemon.admitCalls).toBe(0);
  });

  it('right invite id but wrong PSK: generic ABORT at msg3, invite not consumed, nothing registered', async () => {
    const daemon = new FakeDaemon();
    const { trust, secret } = daemon.addInvite();
    // The daemon holds a different PSK under the same invite id (equivalent to a client with a wrong PSK).
    const entry = daemon.invites.get(toHex(deriveInviteKeys(secret).inviteId))!;
    entry.psk = randomBytes(32);
    const r = await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust });
    expect(errorOf(r.daemon)).toMatchObject({ code: 'handshake-failed', stage: 3 });
    expect(errorOf(r.client)).toMatchObject({ code: 'aborted', stage: 3 });
    expect(daemonFrames(r.log).at(-1)).toEqual(genericAbortFrame());
    expect(daemon.admitCalls).toBe(0);
    expect(daemon.usesLeft(secret)).toBe(1);
    expect(daemon.devices.size).toBe(0);
  });

  it('a relay that flips one byte of HELLO makes every invite fail at msg1', async () => {
    const daemon = new FakeDaemon();
    const { trust } = daemon.addInvite();
    const tap: Tap = (f, dir) => {
      if (dir === 'client->daemon' && f[0] === CHANNEL_FRAME.HELLO) f[10] = (f[10] as number) ^ 0x80;
      return [f];
    };
    const r = await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust }, { tap });
    expect(errorOf(r.daemon)).toMatchObject({ code: 'invite-unknown', stage: 1 });
    expect(errorOf(r.client)).toMatchObject({ code: 'aborted' });
  });

  it('the prologue binds the workspace and the mode', async () => {
    const daemon = new FakeDaemon();
    const other = await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust: daemon.addInvite().trust, workspaceId: 'ws_other_0123456789' });
    expect(other.client.status).toBe('rejected');
    expect(errorOf(other.daemon)?.code).toBe('invite-unknown');
    const flip: Tap = (f, dir) => {
      if (dir === 'client->daemon' && f[0] === CHANNEL_FRAME.HELLO) f[2] = HANDSHAKE_MODE_BYTES.device;
      return [f];
    };
    const flipped = await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust: daemon.addInvite().trust }, { tap: flip });
    expect(flipped.client.status).toBe('rejected');
    expect(flipped.daemon.status).toBe('rejected');
    expect(daemon.admitCalls).toBe(0);
  });
});

describe('R3: the relay substitutes the daemon key', () => {
  /** A relay-controlled responder with its own static key that answers msg1 in the daemon's place. */
  async function mitm(options: { knowsSecret: Uint8Array | null; mode: 'invite' | 'device' }) {
    const real = new FakeDaemon();
    const evil = x25519KeyPair();
    const device = x25519KeyPair();
    const trust = options.mode === 'invite' ? real.addInvite(options.knowsSecret ?? undefined).trust : pinned(real);
    let verified = 0;
    const pair = createMemoryTransportPair();
    const clientP = clientConnect(pair.client, {
      workspaceId: WS,
      deviceKey: device,
      trust,
      hello: utf8Encode('secret hello'),
      onDaemonVerified: () => void verified++,
    });
    const received: Uint8Array[] = [];
    pair.daemon.onMessage((f) => received.push(f));
    await new Promise((res) => setTimeout(res, 5));
    const hello = received[0]!;
    const inviteId = options.knowsSecret ? deriveInviteKeys(options.knowsSecret).inviteId : new Uint8Array(16);
    const psk = options.knowsSecret ? deriveInviteKeys(options.knowsSecret).psk : new Uint8Array(32);
    const resp = new HandshakeState({
      suite: nobleSuite,
      pattern: resolveHandshakePattern(options.mode === 'invite' ? 'XXpsk3' : 'XX'),
      initiator: false,
      prologue: buildNoisePrologue(WS, options.mode, options.mode === 'invite' ? inviteId : undefined),
      s: evil,
      psks: options.mode === 'invite' ? [psk] : [],
    });
    try {
      await resp.readMessage(hello.subarray(3));
    } catch {
      // Without the secret the relay cannot verify msg1; it answers anyway with a msg2 of its own.
      const forged = new HandshakeState({
        suite: nobleSuite,
        pattern: resolveHandshakePattern('XXpsk3'),
        initiator: true,
        prologue: buildNoisePrologue(WS, 'invite', inviteId),
        s: evil,
        e: { publicKey: hello.slice(3, 35), dh: () => new Uint8Array(32) } as NoiseKeyPair,
        psks: [psk],
      });
      const alt = new HandshakeState({
        suite: nobleSuite,
        pattern: resolveHandshakePattern('XXpsk3'),
        initiator: false,
        prologue: buildNoisePrologue(WS, 'invite', inviteId),
        s: evil,
        psks: [psk],
      });
      await alt.readMessage(await forged.writeMessage());
      pair.daemon.send(concatBytes(new Uint8Array([CHANNEL_FRAME.REPLY]), await alt.writeMessage()));
      return { client: await clientP.then(() => null, (e: ChannelError) => e), log: pair.log, verified };
    }
    pair.daemon.send(concatBytes(new Uint8Array([CHANNEL_FRAME.REPLY]), await resp.writeMessage()));
    return { client: await clientP.then(() => null, (e: ChannelError) => e), log: pair.log, verified };
  }

  const finishSent = (log: readonly { direction: string; frame: Uint8Array }[]) =>
    log.some((l) => l.direction === 'client->daemon' && l.frame[0] === CHANNEL_FRAME.FINISH);

  it('reconnect with a pinned key: distinct "daemon-key-mismatch" at msg2, msg3 never sent, pin callback never called', async () => {
    const r = await mitm({ knowsSecret: null, mode: 'device' });
    expect(r.client).toMatchObject({ code: 'daemon-key-mismatch', stage: 2 });
    expect(finishSent(r.log)).toBe(false);
    expect(r.verified).toBe(0);
  });

  it('first contact, worst case (the relay even knows s): only the fingerprint k stops it -> "daemon-key-mismatch" at msg2', async () => {
    const r = await mitm({ knowsSecret: generateInviteSecret(), mode: 'invite' });
    expect(r.client).toMatchObject({ code: 'daemon-key-mismatch', stage: 2 });
    expect(finishSent(r.log)).toBe(false);
    expect(r.verified).toBe(0);
  });

  it('first contact, relay without the invite secret: msg2 cannot authenticate -> "handshake-failed" at msg2, msg3 never sent', async () => {
    const r = await mitm({ knowsSecret: null, mode: 'invite' });
    expect(r.client).toMatchObject({ code: 'handshake-failed', stage: 2 });
    expect(finishSent(r.log)).toBe(false);
    expect(r.verified).toBe(0);
  });

  it('a flipped bit in the encrypted daemon key of msg2 fails AEAD at msg2', async () => {
    const daemon = new FakeDaemon();
    const tap: Tap = (f, dir) => {
      if (dir === 'daemon->client' && f[0] === CHANNEL_FRAME.REPLY) f[1 + 32 + 5] = (f[1 + 32 + 5] as number) ^ 1;
      return [f];
    };
    const r = await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust: daemon.addInvite().trust }, { tap });
    expect(errorOf(r.client)).toMatchObject({ code: 'handshake-failed', stage: 2 });
    expect(r.log.some((l) => l.frame[0] === CHANNEL_FRAME.FINISH)).toBe(false);
  });

  it('a pin callback that fails stops the handshake before msg3', async () => {
    const daemon = new FakeDaemon();
    const r = await runHandshake(
      daemon,
      {
        deviceKey: x25519KeyPair(),
        trust: daemon.addInvite().trust,
        onDaemonVerified: () => {
          throw new Error('disk full');
        },
      },
      { daemonOptions: { deadlineMs: 200 } },
    );
    expect(errorOf(r.client)).toMatchObject({ code: 'callback-failed', stage: 2 });
    expect(r.log.some((l) => l.frame[0] === CHANNEL_FRAME.FINISH)).toBe(false);
    expect(daemon.admitCalls).toBe(0);
  });
});

describe('R3: unknown and revoked devices (device mode)', () => {
  it('an unknown device key is refused after authentication, with an encrypted reason and no cleartext ABORT', async () => {
    const daemon = new FakeDaemon();
    const r = await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust: pinned(daemon) });
    const err = errorOf(r.client)!;
    expect(err).toMatchObject({ code: 'rejected', stage: 3 });
    expect(utf8Decode(err.verdict!)).toBe('device-unknown');
    expect(errorOf(r.daemon)).toMatchObject({ code: 'rejected' });
    expect(r.log.some((l) => l.frame[0] === CHANNEL_FRAME.ABORT)).toBe(false);
  });

  it('a revoked device key can neither reconnect nor come back through a fresh invite', async () => {
    const daemon = new FakeDaemon();
    const device = x25519KeyPair();
    valueOf((await runHandshake(daemon, { deviceKey: device, trust: daemon.addInvite().trust })).client).channel.close();
    daemon.revoke(device.publicKey);
    const reconnect = await runHandshake(daemon, { deviceKey: device, trust: pinned(daemon) });
    expect(utf8Decode(errorOf(reconnect.client)!.verdict!)).toBe('device-revoked');
    expect(reconnect.log.some((l) => l.frame[0] === CHANNEL_FRAME.ABORT)).toBe(false);
    const { trust, secret } = daemon.addInvite();
    const viaInvite = await runHandshake(daemon, { deviceKey: device, trust });
    expect(utf8Decode(errorOf(viaInvite.client)!.verdict!)).toBe('device-revoked');
    expect(daemon.usesLeft(secret)).toBe(1);
  });

  it('no device-status oracle: probes with only a public key look identical for unknown, registered and revoked keys', async () => {
    const daemon = new FakeDaemon();
    const registered = x25519KeyPair();
    const revoked = x25519KeyPair();
    for (const device of [registered, revoked]) valueOf((await runHandshake(daemon, { deviceKey: device, trust: daemon.addInvite().trust })).client);
    daemon.revoke(revoked.publicKey);
    const callsBefore = daemon.admitCalls;
    const probe = async (publicKey: Uint8Array) => {
      // The prober knows the public key only; its DH output is garbage, so it cannot complete msg3.
      const fake: NoiseKeyPair = { publicKey, dh: () => randomBytes(32) };
      const r = await runHandshake(daemon, { deviceKey: fake, trust: pinned(daemon) });
      return {
        code: errorOf(r.client)?.code,
        shape: r.log.map((l) => `${l.direction}:${l.frame[0]}:${l.frame.length}`).join(' '),
        abort: toHex(daemonFrames(r.log).at(-1)!),
      };
    };
    const unknown = await probe(x25519KeyPair().publicKey);
    const reg = await probe(registered.publicKey);
    const rev = await probe(revoked.publicKey);
    expect(unknown.code).toBe('aborted');
    expect(reg).toEqual(unknown);
    expect(rev).toEqual(unknown);
    expect(unknown.abort).toBe('7f00');
    expect(daemon.admitCalls).toBe(callsBefore);
  });
});

describe('R2/R3: invite uses and expiry are decided atomically in admit()', () => {
  it('two concurrent joins on a 1-use invite: exactly one admitted, the other gets an authenticated "exhausted"', async () => {
    const daemon = new FakeDaemon();
    const { trust, secret } = daemon.addInvite(undefined, 1);
    const results = await Promise.all([
      runHandshake(daemon, { deviceKey: x25519KeyPair(), trust }),
      runHandshake(daemon, { deviceKey: x25519KeyPair(), trust }),
    ]);
    const outcomes = results.map((r) => (r.client.status === 'fulfilled' ? 'ok' : utf8Decode(errorOf(r.client)!.verdict ?? new Uint8Array())));
    expect(outcomes.sort()).toEqual(['invite-exhausted', 'ok']);
    expect(daemon.usesLeft(secret)).toBe(0);
    expect(daemon.devices.size).toBe(1);
  });

  it('eight concurrent joins on a 3-use invite: exactly three admitted', { timeout: 30_000 }, async () => {
    const daemon = new FakeDaemon();
    const { trust, secret } = daemon.addInvite(undefined, 3);
    const results = await Promise.all(Array.from({ length: 8 }, () => runHandshake(daemon, { deviceKey: x25519KeyPair(), trust })));
    expect(results.filter((r) => r.client.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => utf8Decode(errorOf(r.client)?.verdict ?? new Uint8Array()) === 'invite-exhausted')).toHaveLength(5);
    expect(daemon.usesLeft(secret)).toBe(0);
    expect(daemon.devices.size).toBe(3);
  });

  it('an invite that expires between msg1 and msg3 is refused at admission', async () => {
    const daemon = new FakeDaemon();
    const { trust, secret } = daemon.addInvite(undefined, 1, 100);
    const r = await runHandshake(
      daemon,
      { deviceKey: x25519KeyPair(), trust },
      { wrapClient: (t) => delaySends(t, (f) => f[0] === CHANNEL_FRAME.FINISH, 200) },
    );
    expect(utf8Decode(errorOf(r.client)!.verdict!)).toBe('invite-expired');
    expect(daemon.usesLeft(secret)).toBe(1);
    expect(daemon.devices.size).toBe(0);
  });

  it('a used-up invite is refused with its authenticated reason', async () => {
    const daemon = new FakeDaemon();
    const { trust } = daemon.addInvite(undefined, 1);
    valueOf((await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust })).client);
    const second = await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust });
    expect(utf8Decode(errorOf(second.client)!.verdict!)).toBe('invite-exhausted');
  });

  it('admit() that returns a promise, throws or returns garbage fails closed (rejection with an empty payload)', async () => {
    const bad: ((ctx: unknown) => unknown)[] = [
      async () => ({ accept: true, payload: new Uint8Array() }),
      () => {
        throw new Error('db down');
      },
      () => ({ accept: 'yes', payload: new Uint8Array() }),
      () => ({ accept: true }),
      () => null,
    ];
    for (const admit of bad) {
      const daemon = new FakeDaemon();
      const r = await runHandshake(
        daemon,
        { deviceKey: x25519KeyPair(), trust: daemon.addInvite().trust },
        { daemonOptions: { admit: admit as never } },
      );
      expect(errorOf(r.client)).toMatchObject({ code: 'rejected', stage: 3 });
      expect(errorOf(r.client)!.verdict).toEqual(new Uint8Array());
      expect(errorOf(r.daemon)).toMatchObject({ code: 'admit-failed' });
    }
  });

  it('a lost verdict does not strand the joiner: the pin from msg2 allows a device-mode reconnect', async () => {
    const daemon = new FakeDaemon();
    const device = x25519KeyPair();
    const { trust, secret } = daemon.addInvite(undefined, 1);
    let pin: Uint8Array | undefined;
    const drop: Tap = (f, dir) => (dir === 'daemon->client' && f[0] === CHANNEL_FRAME.DATA ? [] : [f]);
    const r = await runHandshake(
      daemon,
      { deviceKey: device, trust, onDaemonVerified: (k) => void (pin = k), deadlineMs: 100 },
      { tap: drop },
    );
    expect(r.daemon.status).toBe('fulfilled');
    expect(errorOf(r.client)).toMatchObject({ code: 'timeout', stage: 3 });
    expect(daemon.usesLeft(secret)).toBe(0);
    const again = await runHandshake(daemon, { deviceKey: device, trust: { kind: 'pinned', daemonStaticKey: pin! } });
    expect(again.client.status).toBe('fulfilled');
  });
});

describe('R3: one identical cleartext ABORT for every pre-authentication failure', () => {
  it('collects the daemon frames of every pre-auth failure: all equal [0x7f, 0x00]', { timeout: 30_000 }, async () => {
    const daemon = new FakeDaemon();
    const { trust, secret } = daemon.addInvite();
    const aborts: { name: string; code: string | undefined; frames: Uint8Array[] }[] = [];
    const record = (name: string, r: { daemon: PromiseSettledResult<unknown>; log: readonly { direction: string; frame: Uint8Array }[] }) =>
      aborts.push({ name, code: errorOf(r.daemon)?.code, frames: daemonFrames(r.log).filter((f) => f[0] === CHANNEL_FRAME.ABORT) });

    // 1. unknown invite
    record('invite-unknown', await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust: { ...trust, secret: generateInviteSecret() } as typeof trust }));
    // 2. wrong psk at msg3
    const wrongPskDaemon = new FakeDaemon();
    const wrong = wrongPskDaemon.addInvite(secret);
    wrongPskDaemon.invites.get(toHex(deriveInviteKeys(secret).inviteId))!.psk = randomBytes(32);
    record('wrong-psk', await runHandshake(wrongPskDaemon, { deviceKey: x25519KeyPair(), trust: wrong.trust }));
    // 3. device key the prober does not own
    record('probe', await runHandshake(daemon, { deviceKey: { publicKey: x25519KeyPair().publicKey, dh: () => randomBytes(32) }, trust: pinned(daemon) }));
    // 4. rate-limit gate
    record('refused', await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust: pinned(daemon) }, { daemonOptions: { allowHandshake: () => false } }));
    // 5-9. malformed HELLOs and wrong frame types, sent raw
    const raw = async (name: string, frame: Uint8Array) => {
      const pair = createMemoryTransportPair();
      const p = daemon.accept(pair.daemon, { deadlineMs: 200 });
      pair.client.send(frame);
      const settled = await Promise.allSettled([p]);
      record(name, { daemon: settled[0]!, log: pair.log });
    };
    await raw('bad-version', new Uint8Array([CHANNEL_FRAME.HELLO, 9, 2, ...randomBytes(32)]));
    await raw('bad-mode', new Uint8Array([CHANNEL_FRAME.HELLO, 1, 7, ...randomBytes(32)]));
    await raw('bad-size', new Uint8Array([CHANNEL_FRAME.HELLO, 1, 2, ...randomBytes(33)]));
    await raw('short', new Uint8Array([CHANNEL_FRAME.HELLO]));
    await raw('data-first', new Uint8Array([CHANNEL_FRAME.DATA, 0, 17, ...randomBytes(17)]));
    // 10. a garbage msg3 after a valid device-mode HELLO
    {
      const pair = createMemoryTransportPair();
      const p = daemon.accept(pair.daemon);
      const hs = new HandshakeState({ suite: nobleSuite, pattern: resolveHandshakePattern('XX'), initiator: true, prologue: buildNoisePrologue(WS, 'device'), s: x25519KeyPair() });
      pair.client.send(concatBytes(new Uint8Array([CHANNEL_FRAME.HELLO, 1, 2]), await hs.writeMessage()));
      await new Promise((res) => setTimeout(res, 5));
      pair.client.send(concatBytes(new Uint8Array([CHANNEL_FRAME.FINISH]), randomBytes(64 + 20)));
      record('garbage-msg3', { daemon: (await Promise.allSettled([p]))[0]!, log: pair.log });
    }
    // 11. handshake deadline
    {
      const pair = createMemoryTransportPair();
      const p = daemon.accept(pair.daemon, { deadlineMs: 30 });
      const hs = new HandshakeState({ suite: nobleSuite, pattern: resolveHandshakePattern('XX'), initiator: true, prologue: buildNoisePrologue(WS, 'device'), s: x25519KeyPair() });
      pair.client.send(concatBytes(new Uint8Array([CHANNEL_FRAME.HELLO, 1, 2]), await hs.writeMessage()));
      record('timeout', { daemon: (await Promise.allSettled([p]))[0]!, log: pair.log });
    }

    expect(aborts.map((a) => [a.name, a.code])).toEqual([
      ['invite-unknown', 'invite-unknown'],
      ['wrong-psk', 'handshake-failed'],
      ['probe', 'handshake-failed'],
      ['refused', 'refused'],
      ['bad-version', 'bad-hello'],
      ['bad-mode', 'bad-hello'],
      ['bad-size', 'bad-hello'],
      ['short', 'bad-hello'],
      ['data-first', 'protocol'],
      ['garbage-msg3', 'handshake-failed'],
      ['timeout', 'timeout'],
    ]);
    for (const a of aborts) {
      expect(a.frames, a.name).toHaveLength(1);
      expect(isGenericAbortFrame(a.frames[0]!), a.name).toBe(true);
      expect(a.frames[0]).toEqual(new Uint8Array([0x7f, 0x00]));
    }
    expect(daemon.admitCalls).toBe(0);
  });
});

describe('deadlines, cancellation and rate-limit hooks', () => {
  it('a client that never sends msg3 is dropped at the deadline; onHandshakeFailed sees every failure', async () => {
    const daemon = new FakeDaemon();
    const failures: string[] = [];
    const pair = createMemoryTransportPair();
    let closed = false;
    const fromDaemon: number[] = [];
    pair.client.onMessage((f) => fromDaemon.push(f[0]!));
    pair.client.onClose(() => void (closed = true));
    const p = daemon.accept(pair.daemon, { deadlineMs: 50, onHandshakeFailed: (e) => failures.push(`${e.code}@${e.stage}`) });
    const hs = new HandshakeState({ suite: nobleSuite, pattern: resolveHandshakePattern('XX'), initiator: true, prologue: buildNoisePrologue(WS, 'device'), s: x25519KeyPair() });
    pair.client.send(concatBytes(new Uint8Array([CHANNEL_FRAME.HELLO, 1, 2]), await hs.writeMessage()));
    await expect(p).rejects.toMatchObject({ code: 'timeout', stage: 3 });
    await new Promise((res) => setTimeout(res, 0));
    expect(closed).toBe(true);
    expect(fromDaemon).toEqual([CHANNEL_FRAME.REPLY, CHANNEL_FRAME.ABORT]);
    expect(failures).toEqual(['timeout@3']);
  });

  it('allowHandshake sees the mode before any cryptographic work', async () => {
    const daemon = new FakeDaemon();
    const seen: string[] = [];
    const r = await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust: daemon.addInvite().trust }, {
      daemonOptions: { allowHandshake: ({ mode }) => (seen.push(mode), true) },
    });
    expect(r.client.status).toBe('fulfilled');
    expect(seen).toEqual(['invite']);
    const throwing = await runHandshake(daemon, { deviceKey: x25519KeyPair(), trust: pinned(daemon) }, {
      daemonOptions: {
        allowHandshake: () => {
          throw new Error('bucket broken');
        },
      },
    });
    expect(errorOf(throwing.daemon)?.code).toBe('refused');
  });

  it('an AbortSignal cancels a pending handshake on either side', async () => {
    const daemon = new FakeDaemon();
    const controller = new AbortController();
    const pair = createMemoryTransportPair();
    const p = daemon.accept(pair.daemon, { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    const pre = new AbortController();
    pre.abort();
    await expect(
      clientConnect(createMemoryTransportPair().client, { workspaceId: WS, deviceKey: x25519KeyPair(), trust: pinned(daemon), hello: new Uint8Array(), signal: pre.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('the client times out if the daemon never answers, and a closed transport fails the handshake', async () => {
    const daemon = new FakeDaemon();
    const silent = createMemoryTransportPair();
    await expect(
      clientConnect(silent.client, { workspaceId: WS, deviceKey: x25519KeyPair(), trust: pinned(daemon), hello: new Uint8Array(), deadlineMs: 30 }),
    ).rejects.toMatchObject({ code: 'timeout', stage: 2 });
    const closing = createMemoryTransportPair();
    const p = clientConnect(closing.client, { workspaceId: WS, deviceKey: x25519KeyPair(), trust: pinned(daemon), hello: new Uint8Array() });
    closing.daemon.close();
    await expect(p).rejects.toMatchObject({ code: 'closed' });
  });

  it('robustness: 300 random / truncated HELLOs never crash the daemon; each is rejected or times out', { timeout: 60_000 }, async () => {
    const daemon = new FakeDaemon();
    daemon.addInvite();
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 300; i++) {
      if (i % 4 === 1) {
        // Well-formed device HELLO with a random "ephemeral": plain XX msg1 is unauthenticated, so this parks the
        // daemon at msg3 until the deadline (noise.md F23).
        frames.push(concatBytes(new Uint8Array([CHANNEL_FRAME.HELLO, 1, HANDSHAKE_MODE_BYTES.device]), randomBytes(32)));
      } else if (i % 4 === 2) {
        // Well-formed invite HELLO with a random msg1: no invite verifies it.
        frames.push(concatBytes(new Uint8Array([CHANNEL_FRAME.HELLO, 1, HANDSHAKE_MODE_BYTES.invite]), randomBytes(48)));
      } else {
        const frame = randomBytes(Math.floor(Math.random() * 120));
        if (frame.length > 0 && i % 2 === 0) frame[0] = CHANNEL_FRAME.HELLO;
        frames.push(frame);
      }
    }
    const settled = await Promise.allSettled(
      frames.map((frame) => {
        const pair = createMemoryTransportPair();
        const p = daemon.accept(pair.daemon, { deadlineMs: 100 });
        pair.client.send(frame);
        return p;
      }),
    );
    const outcomes = { rejected: 0, timeout: 0, other: 0 };
    for (const s of settled) {
      const err = errorOf(s);
      if (!(err instanceof ChannelError)) outcomes.other++;
      else if (err.code === 'timeout') outcomes.timeout++;
      else outcomes.rejected++;
    }
    expect(outcomes.other).toBe(0);
    expect(outcomes.timeout).toBeGreaterThanOrEqual(75); // every parked device HELLO was dropped at the deadline
    expect(outcomes.rejected + outcomes.timeout).toBe(300);
    expect(daemon.admitCalls).toBe(0);
  });

  it('rejects invalid options before touching the transport', async () => {
    const daemon = new FakeDaemon();
    const pair = createMemoryTransportPair();
    await expect(clientConnect(pair.client, { workspaceId: 'bad', deviceKey: x25519KeyPair(), trust: pinned(daemon), hello: new Uint8Array() })).rejects.toThrow(TypeError);
    await expect(
      clientConnect(pair.client, { workspaceId: WS, deviceKey: x25519KeyPair(), trust: { kind: 'pinned', daemonStaticKey: new Uint8Array(31) }, hello: new Uint8Array() }),
    ).rejects.toThrow(TypeError);
    await expect(clientConnect(pair.client, { workspaceId: WS, deviceKey: x25519KeyPair(), trust: pinned(daemon), hello: new Uint8Array(70_000) })).rejects.toThrow(RangeError);
    await expect(daemonAccept(pair.daemon, { workspaceId: WS, staticKey: daemon.staticKey, invites: () => [], admit: undefined as never })).rejects.toThrow(TypeError);
    expect(pair.log).toHaveLength(0);
  });
});
