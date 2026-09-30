// R3 byte tap: the relay records every frame its code receives and sends. This file proves the tap is complete (every
// frame, every byte, both directions, both Durable Objects) and able to see plaintext when there is some (positive
// control), and that end-to-end encrypted traffic shows no marker in any encoding. The daemon/client acceptance test
// (tests/e2e, real Noise channel) reuses this tap through @smurg/relay/testing.
import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPlaintext, startLocalRelay, type LocalRelay, type TapFrame } from '../test-support/index.ts';
import { closeAll, frameFor, open, openClient, tunnelUrl, type Kind } from './helpers.ts';

const MARKER = 'SMURG-R3-MARKER-7f3c1e9a42d8';

let relay: LocalRelay;

beforeAll(async () => {
  relay = await startLocalRelay({ tap: true });
});

afterAll(async () => {
  await relay?.stop();
});

/** Stand-in for the Noise channel: AES-256-GCM with a key the relay never sees. */
function sealer(encrypt: boolean): (plaintext: Buffer) => Buffer {
  const key = randomBytes(32);
  return (plaintext) => {
    if (!encrypt) return plaintext;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  };
}

type Run = { kind: Kind; workspaceId: string; up: Buffer[]; down: Buffer[]; conn: number };

/** Host + client exchange messages carrying the marker as file content, terminal output and a command. */
async function exchange(kind: Kind, encrypt: boolean): Promise<Run> {
  const owner = await relay.devLogin('owner');
  const guest = await relay.devLogin('guest');
  const workspaceId = await relay.createWorkspace(owner.token);
  const host = await open(tunnelUrl(relay, kind, 'host', workspaceId), { token: owner.token });
  const { socket: client, conn } = await openClient(relay, kind, workspaceId, { token: guest.token });
  const seal = sealer(encrypt);
  const up: Buffer[] = [];
  const down: Buffer[] = [];
  try {
    await host.nextControl('peer.open');
    for (let i = 0; i < 10; i++) {
      const upPlain = Buffer.from(
        JSON.stringify(
          i % 2 === 0
            ? { type: 'file.write', id: `r${i}`, seq: i, payload: { file: 'src/a.ts', content: `const s = "${MARKER}";` } }
            : { type: 'exec.input', id: `r${i}`, seq: i, payload: { data: `echo ${MARKER} && rm -rf build\n` } },
        ),
      );
      const upFrame = seal(upPlain);
      client.send(upFrame);
      up.push(upFrame);
      await host.nextBinary();
      const downFrame = seal(Buffer.from(JSON.stringify({ type: 'exec.output', seq: i, payload: { data: `$ ${MARKER}\r\n` } })));
      host.send(frameFor(conn, downFrame));
      down.push(downFrame);
      await client.nextBinary();
    }
  } finally {
    closeAll(host, client);
  }
  return { kind, workspaceId, up, down, conn };
}

/** Binary frames of one workspace and direction, in the order the relay handled them (posts may arrive out of order). */
function binaryFrames(frames: TapFrame[], workspaceId: string, direction: 'in' | 'out'): TapFrame[] {
  return frames
    .filter((f) => f.workspaceId === workspaceId && f.kind === 'binary' && f.direction === direction)
    .sort((a, b) => a.seq - b.seq);
}

async function collect(run: Run): Promise<TapFrame[]> {
  const tap = relay.tap;
  if (!tap) throw new Error('tap missing');
  const expected = run.up.length + run.down.length;
  await tap.waitFor(
    (frames) =>
      binaryFrames(frames, run.workspaceId, 'in').length >= expected && binaryFrames(frames, run.workspaceId, 'out').length >= expected,
  );
  await tap.waitForQuiet();
  return tap.frames();
}

describe.each<Kind>(['ws', 'xfer'])('R3 byte tap on %s', (kind) => {
  it('is complete: every binary frame and byte, in and out, with the connection-id prefix only on host frames', async () => {
    relay.tap?.reset();
    const run = await exchange(kind, true);
    const frames = await collect(run);
    const source = kind === 'ws' ? 'WorkspaceDO' : 'TransferDO';
    const incoming = binaryFrames(frames, run.workspaceId, 'in');
    const outgoing = binaryFrames(frames, run.workspaceId, 'out');
    expect(incoming.every((f) => f.source === source)).toBe(true);

    // In: client frames verbatim; host frames = prefix + ciphertext.
    const clientIn = incoming.filter((f) => f.role === 'client').map((f) => f.data);
    const hostIn = incoming.filter((f) => f.role === 'host').map((f) => f.data);
    expect(clientIn).toEqual(run.up);
    expect(hostIn).toEqual(run.down.map((d) => Buffer.from(frameFor(run.conn, d))));
    // Out: relay -> host adds the prefix; relay -> client strips it.
    const toHost = outgoing.filter((f) => f.role === 'host').map((f) => f.data);
    const toClient = outgoing.filter((f) => f.role === 'client').map((f) => f.data);
    expect(toHost).toEqual(run.up.map((u) => Buffer.from(frameFor(run.conn, u))));
    expect(toClient).toEqual(run.down);
    const sent = [...run.up, ...run.down].reduce((n, b) => n + b.length, 0);
    expect(incoming.reduce((n, f) => n + f.data.length, 0)).toBe(sent + 4 * run.down.length);

    // The Worker's view of the requests (line + headers) is recorded too.
    expect(frames.some((f) => f.source === 'worker' && f.kind === 'request' && f.workspaceId === run.workspaceId)).toBe(true);
    // Control frames are text and carry no content: hello, peer.open, ... and nothing with the marker.
    const text = frames.filter((f) => f.workspaceId === run.workspaceId && f.kind === 'text');
    expect(text.length).toBeGreaterThan(0);

    // Encrypted run: the marker appears nowhere the relay could see, in any encoding.
    expect(findPlaintext(frames, MARKER)).toEqual([]);
  });

  it('detects plaintext when it is there (positive control)', async () => {
    relay.tap?.reset();
    const run = await exchange(kind, false);
    const frames = await collect(run);
    const hits = findPlaintext(binaryFrames(frames, run.workspaceId, 'in'), MARKER);
    expect(hits).toContain('utf8');
    expect(findPlaintext(binaryFrames(frames, run.workspaceId, 'out'), MARKER)).toContain('utf8');
  });
});

describe('plaintext finder', () => {
  it('finds the marker in every encoding at every alignment, and refuses short markers', () => {
    const blob = (inner: Buffer) => Buffer.concat([randomBytes(5), inner, randomBytes(7)]);
    expect(findPlaintext(blob(Buffer.from(MARKER)), MARKER)).toEqual(['utf8']);
    expect(findPlaintext(blob(Buffer.from(MARKER, 'utf16le')), MARKER)).toEqual(['utf16le']);
    expect(findPlaintext(blob(Buffer.from(Buffer.from(MARKER).toString('hex').toUpperCase())), MARKER)).toEqual(['hex']);
    for (let pad = 0; pad < 3; pad++) {
      const encoded = Buffer.concat([randomBytes(pad), Buffer.from(MARKER), randomBytes(4)]).toString('base64');
      expect(findPlaintext(Buffer.from(`x${encoded}y`), MARKER), `pad ${pad}`).toContain('base64');
      const urlSafe = Buffer.concat([Buffer.from([0xfb, 0xff]), randomBytes(pad), Buffer.from(MARKER)]).toString('base64url');
      expect(findPlaintext(Buffer.from(urlSafe), MARKER), `url pad ${pad}`).toContain('base64url');
    }
    expect(findPlaintext(randomBytes(4096), MARKER)).toEqual([]);
    expect(() => findPlaintext(Buffer.alloc(1), 'short')).toThrow(RangeError);
  });
});
