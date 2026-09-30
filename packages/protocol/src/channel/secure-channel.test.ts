// SPEC R3: on an established channel every tampered, replayed, reordered, reflected or injected record is fatal for
// the connection; plus close semantics and message delivery guarantees.
import { describe, expect, it } from 'vitest';
import { concatBytes, randomBytes, utf8Encode } from '../bytes.ts';
import { x25519KeyPair } from '../noise/suite.ts';
import { CHANNEL_FRAME, genericAbortFrame } from './frames.ts';
import type { ChannelCloseEvent, SecureChannel } from './secure-channel.ts';
import { clientConnect } from './handshake.ts';
import { createMemoryTransportPair, type MemoryDirection } from './transport.ts';
import { FakeDaemon, WS, nextMessage } from './testing/harness.ts';

type Mutator = (frame: Uint8Array, direction: MemoryDirection, dataIndex: number) => readonly Uint8Array[];

/** An established pair whose relay applies `mutate` to client->daemon DATA frames after the handshake. */
async function established(mutate?: Mutator) {
  const daemon = new FakeDaemon();
  let dataIndex = 0;
  let armed = false;
  const pair = createMemoryTransportPair({
    tap: (frame, direction) => {
      if (!armed || !mutate || frame[0] !== CHANNEL_FRAME.DATA || direction !== 'client->daemon') return [frame];
      return mutate(frame, direction, dataIndex++);
    },
  });
  const [client, d] = await Promise.all([
    clientConnect(pair.client, { workspaceId: WS, deviceKey: x25519KeyPair(), trust: daemon.addInvite().trust, hello: new Uint8Array() }),
    daemon.accept(pair.daemon),
  ]);
  armed = true;
  const closed = new Promise<ChannelCloseEvent>((res) => d.channel.onClose(res));
  const received: Uint8Array[] = [];
  d.channel.onMessage((m) => received.push(m));
  return { client: client.channel, daemon: d.channel, closed, received, pair };
}

const tick = () => new Promise((res) => setTimeout(res, 5));

describe('established channel: every record manipulation is fatal', () => {
  it('a replayed DATA frame', async () => {
    let first: Uint8Array | null = null;
    const ch = await established((frame, _d, i) => {
      if (i === 0) first = frame.slice();
      return i === 1 ? [first!] : [frame];
    });
    ch.client.send(utf8Encode('one'));
    ch.client.send(utf8Encode('two'));
    const event = await ch.closed;
    expect(event).toMatchObject({ initiator: 'error', error: { code: 'integrity' } });
    expect(ch.received).toEqual([utf8Encode('one')]);
    expect(ch.daemon.isClosed).toBe(true);
  });

  it('reordered DATA frames', async () => {
    let held: Uint8Array | null = null;
    const ch = await established((frame, _d, i) => {
      if (i === 0) {
        held = frame;
        return [];
      }
      return [frame, held!];
    });
    ch.client.send(utf8Encode('one'));
    ch.client.send(utf8Encode('two'));
    expect(await ch.closed).toMatchObject({ initiator: 'error', error: { code: 'integrity' } });
    expect(ch.received).toEqual([]);
  });

  it('a dropped DATA frame (the next one no longer decrypts)', async () => {
    const ch = await established((frame, _d, i) => (i === 0 ? [] : [frame]));
    ch.client.send(utf8Encode('one'));
    ch.client.send(utf8Encode('two'));
    expect(await ch.closed).toMatchObject({ error: { code: 'integrity' } });
  });

  it('a flipped bit anywhere in the ciphertext', async () => {
    const ch = await established((frame) => {
      const f = frame.slice();
      f[f.length - 3] = (f[f.length - 3] as number) ^ 0x10;
      return [f];
    });
    ch.client.send(utf8Encode('hello there'));
    expect(await ch.closed).toMatchObject({ error: { code: 'integrity' } });
    expect(ch.received).toEqual([]);
  });

  it('a frame reflected back to its sender', async () => {
    const ch = await established();
    const events: ChannelCloseEvent[] = [];
    ch.client.onClose((e) => events.push(e));
    // The relay sends the client's own frame back to it.
    const frame = new Promise<Uint8Array>((res) => {
      const off = ch.pair.daemon.onMessage((f) => (off(), res(f)));
    });
    ch.client.send(utf8Encode('reflect me'));
    ch.pair.daemon.send(await frame);
    await tick();
    expect(events[0]).toMatchObject({ initiator: 'error', error: { code: 'integrity' } });
  });

  it('a frame from another session', async () => {
    const a = await established();
    const b = await established();
    const frame = new Promise<Uint8Array>((res) => {
      const off = b.pair.daemon.onMessage((f) => (off(), res(f)));
    });
    b.client.send(utf8Encode('for b'));
    // Inject b's ciphertext into a's daemon side.
    a.pair.client.send(await frame);
    expect(await a.closed).toMatchObject({ error: { code: 'integrity' } });
  });

  it('a cleartext ABORT (or any non-DATA frame) after authentication', async () => {
    const ch = await established();
    ch.pair.client.send(genericAbortFrame());
    expect(await ch.closed).toMatchObject({ initiator: 'error', error: { code: 'protocol' } });
    const other = await established();
    other.pair.client.send(new Uint8Array([CHANNEL_FRAME.HELLO, 1, 2, ...randomBytes(32)]));
    expect(await other.closed).toMatchObject({ error: { code: 'protocol' } });
  });

  it('the failed side closes its transport, so the peer learns about it', async () => {
    const ch = await established((frame) => [concatBytes(frame, new Uint8Array([0, 0]))]);
    const clientClosed = new Promise<ChannelCloseEvent>((res) => ch.client.onClose(res));
    ch.client.send(utf8Encode('x'));
    expect(await ch.closed).toMatchObject({ initiator: 'error' });
    expect(await clientClosed).toMatchObject({ initiator: 'remote' });
    expect(() => ch.client.send(utf8Encode('y'))).toThrow(expect.objectContaining({ code: 'closed' }));
  });
});

describe('established channel: delivery and close semantics', () => {
  it('buffers messages until the first onMessage handler, then delivers them in order', async () => {
    const daemon = new FakeDaemon();
    const pair = createMemoryTransportPair();
    const [client, d] = await Promise.all([
      clientConnect(pair.client, { workspaceId: WS, deviceKey: x25519KeyPair(), trust: daemon.addInvite().trust, hello: new Uint8Array() }),
      daemon.accept(pair.daemon),
    ]);
    for (let i = 0; i < 5; i++) client.channel.send(utf8Encode(`m${i}`));
    await tick();
    const got: string[] = [];
    d.channel.onMessage((m) => got.push(new TextDecoder().decode(m)));
    expect(got).toEqual([]); // never re-entrantly inside onMessage()
    await Promise.resolve();
    expect(got).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('a buffered message can be taken by a handler that unsubscribes itself (no re-entrant delivery)', async () => {
    const ch = await established();
    const clientSide = await new Promise<Uint8Array>((resolve) => {
      ch.daemon.send(utf8Encode('buffered'));
      setTimeout(() => {
        const off = ch.client.onMessage((m) => {
          off();
          resolve(m);
        });
      }, 5);
    });
    expect(clientSide).toEqual(utf8Encode('buffered'));
    expect(ch.client.isClosed).toBe(false);
  });

  it('messages received before a remote close are delivered before the close event', async () => {
    const ch = await established();
    const order: string[] = [];
    ch.client.onClose((e) => order.push(`close:${e.initiator}`));
    ch.daemon.send(utf8Encode('channel.closed kicked'));
    ch.daemon.close();
    await tick();
    const late: string[] = [];
    ch.client.onMessage((m) => late.push(new TextDecoder().decode(m)));
    await tick();
    expect(late).toEqual(['channel.closed kicked']);
    expect(order).toEqual(['close:remote']);
  });

  it('close() is idempotent, closes the transport, and late onClose handlers still fire', async () => {
    const ch = await established();
    ch.client.close(1000, 'bye');
    ch.client.close();
    expect(ch.client.isClosed).toBe(true);
    expect(await ch.closed).toMatchObject({ initiator: 'remote' });
    const late = await new Promise<ChannelCloseEvent>((res) => ch.client.onClose(res));
    expect(late).toMatchObject({ initiator: 'local', code: 1000, reason: 'bye' });
  });

  it('an oversized send throws without killing the channel', async () => {
    const ch = await established();
    expect(() => ch.client.send(new Uint8Array(ch.client.maxMessageBytes + 1))).toThrow(expect.objectContaining({ code: 'too-large' }));
    const got = nextMessage(ch.daemon as SecureChannel);
    ch.client.send(utf8Encode('still fine'));
    expect(await got).toEqual(utf8Encode('still fine'));
    expect(ch.client.isClosed).toBe(false);
    expect(ch.daemon.isClosed).toBe(false);
  });

  it('a throwing onMessage handler closes the channel (fail closed) instead of being ignored', async () => {
    const daemon = new FakeDaemon();
    const pair = createMemoryTransportPair();
    const [client, d] = await Promise.all([
      clientConnect(pair.client, { workspaceId: WS, deviceKey: x25519KeyPair(), trust: daemon.addInvite().trust, hello: new Uint8Array() }),
      daemon.accept(pair.daemon),
    ]);
    const closed = new Promise<ChannelCloseEvent>((res) => d.channel.onClose(res));
    d.channel.onMessage(() => {
      throw new Error('router bug');
    });
    client.channel.send(utf8Encode('boom'));
    expect(await closed).toMatchObject({ initiator: 'error', error: { code: 'handler-error' } });
  });
});
