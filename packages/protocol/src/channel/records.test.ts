// DATA framing: sizes, boundaries under re-splitting, and fail-closed behaviour for every kind of record tampering.
import { describe, expect, it } from 'vitest';
import { MAX_APP_MESSAGE, MAX_RECORD_BODY, MAX_RELAY_FRAME, RELAY_CONN_PREFIX_BYTES, noiseDataFrameBytes } from '../constants.ts';
import { EMPTY_BYTES, equalBytes, randomBytes, utf8Encode } from '../bytes.ts';
import { CipherState } from '../noise/state.ts';
import { nobleSuite } from '../noise/suite.ts';
import { nodeCryptoSuite } from '../node/aead.ts';
import { CHANNEL_FRAME } from './frames.ts';
import { RecordOpener, RecordSealer } from './records.ts';

function pair(maxMessageBytes?: number, suites = { send: nobleSuite, recv: nobleSuite }) {
  const key = randomBytes(32);
  return {
    sealer: new RecordSealer(new CipherState(suites.send, key), maxMessageBytes),
    opener: new RecordOpener(new CipherState(suites.recv, key.slice()), maxMessageBytes),
  };
}

/** The raw records ([u16 len][ciphertext]) of a DATA frame, for relay-style tampering. */
function records(frame: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 1; off < frame.length; ) {
    const len = ((frame[off] as number) << 8) | (frame[off + 1] as number);
    out.push(frame.slice(off, off + 2 + len));
    off += 2 + len;
  }
  return out;
}

function dataFrame(...recs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(1 + recs.reduce((n, r) => n + r.length, 0));
  out[0] = CHANNEL_FRAME.DATA;
  let off = 1;
  for (const r of recs) {
    out.set(r, off);
    off += r.length;
  }
  return out;
}

const MiB = 1024 * 1024;

describe('RecordSealer / RecordOpener', () => {
  it('8 MiB round-trips as one frame of 129 records (+19 bytes each), under the relay frame cap', { timeout: 60_000 }, () => {
    const { sealer, opener } = pair();
    const message = randomBytes(8 * MiB);
    const frame = sealer.seal(message);
    expect(Math.ceil(message.length / MAX_RECORD_BODY)).toBe(129);
    expect(frame.length).toBe(noiseDataFrameBytes(message.length));
    expect(frame.length).toBe(1 + 129 * 19 + 8 * MiB);
    expect(frame.length + RELAY_CONN_PREFIX_BYTES).toBeLessThanOrEqual(MAX_RELAY_FRAME);
    const out = opener.open(frame);
    expect(out).toHaveLength(1);
    expect(equalBytes(out[0]!, message)).toBe(true);
  });

  it('the largest allowed message (MAX_APP_MESSAGE) fits the relay frame cap; one byte more is refused by the sender', { timeout: 60_000 }, () => {
    const { sealer, opener } = pair();
    const frame = sealer.seal(new Uint8Array(MAX_APP_MESSAGE));
    expect(frame.length + RELAY_CONN_PREFIX_BYTES).toBeLessThanOrEqual(MAX_RELAY_FRAME);
    expect(opener.open(frame)[0]).toHaveLength(MAX_APP_MESSAGE);
    expect(() => sealer.seal(new Uint8Array(MAX_APP_MESSAGE + 1))).toThrow(expect.objectContaining({ code: 'too-large' }));
    // The refusal did not consume a nonce: the next message still decrypts.
    expect(opener.open(sealer.seal(utf8Encode('after')))).toEqual([utf8Encode('after')]);
  });

  it('empty, small and exact-multiple messages', () => {
    const { sealer, opener } = pair();
    expect(opener.open(sealer.seal(EMPTY_BYTES))).toEqual([EMPTY_BYTES]);
    const small = sealer.seal(utf8Encode('hi'));
    expect(small.length).toBe(1 + 2 + 1 + 16 + 2);
    expect(opener.open(small)).toEqual([utf8Encode('hi')]);
    const exact = randomBytes(2 * MAX_RECORD_BODY);
    const frame = sealer.seal(exact);
    expect(records(frame)).toHaveLength(2);
    expect(opener.open(frame)).toEqual([exact]);
  });

  it('node:crypto and noble interoperate on the same channel (byte-identical AEAD)', () => {
    const key = randomBytes(32);
    const noble = new RecordSealer(new CipherState(nobleSuite, key));
    const native = new RecordSealer(new CipherState(nodeCryptoSuite, key.slice()));
    const message = randomBytes(300_000);
    const a = noble.seal(message);
    expect(native.seal(message)).toEqual(a);
    expect(new RecordOpener(new CipherState(nodeCryptoSuite, key.slice())).open(a)).toEqual([message]);
  });

  it('a relay re-splitting or merging WebSocket messages cannot change message boundaries', () => {
    const { sealer, opener } = pair();
    const big = new Uint8Array(200_000).fill(7);
    const small = utf8Encode('next');
    const r = [...records(sealer.seal(big)), ...records(sealer.seal(small))];
    expect(r).toHaveLength(5);
    expect(opener.open(dataFrame(r[0]!, r[1]!))).toEqual([]);
    const got = opener.open(dataFrame(r[2]!, r[3]!, r[4]!));
    expect(got).toEqual([big, small]);
  });

  it('decrypted messages are fresh buffers that alias nothing (not each other, not the frame)', () => {
    const { sealer, opener } = pair();
    const frame = dataFrame(...records(sealer.seal(utf8Encode('first message'))), ...records(sealer.seal(randomBytes(100_000))));
    const [a, b] = opener.open(frame) as [Uint8Array, Uint8Array];
    for (const m of [a, b]) {
      expect(m.byteOffset).toBe(0);
      expect(m.buffer.byteLength).toBe(m.byteLength);
      expect(m.buffer).not.toBe(frame.buffer);
    }
    expect(a.buffer).not.toBe(b.buffer);
    const before = b.slice();
    a.fill(0xee);
    frame.fill(0);
    expect(b).toEqual(before);
  });

  describe('fatal and permanent failures', () => {
    it('dropped record', () => {
      const { sealer, opener } = pair();
      const r = records(sealer.seal(new Uint8Array(150_000)));
      expect(() => opener.open(dataFrame(r[0]!, r[2]!))).toThrow(expect.objectContaining({ code: 'integrity' }));
      expect(() => opener.open(dataFrame(r[1]!))).toThrow(expect.objectContaining({ code: 'closed' }));
    });

    it('reordered records', () => {
      const { sealer, opener } = pair();
      const one = sealer.seal(utf8Encode('one'));
      const two = sealer.seal(utf8Encode('two'));
      expect(() => opener.open(two)).toThrow(expect.objectContaining({ code: 'integrity' }));
      expect(() => opener.open(one)).toThrow(expect.objectContaining({ code: 'closed' }));
    });

    it('replayed record', () => {
      const { sealer, opener } = pair();
      const one = sealer.seal(utf8Encode('one'));
      expect(opener.open(one)).toEqual([utf8Encode('one')]);
      expect(() => opener.open(one)).toThrow(expect.objectContaining({ code: 'integrity' }));
    });

    it('any flipped bit (length, ciphertext, tag)', () => {
      for (const position of ['ciphertext', 'tag']) {
        const { sealer, opener } = pair();
        const f = sealer.seal(utf8Encode('hello'));
        const at = position === 'tag' ? f.length - 1 : 4;
        f[at] = (f[at] as number) ^ 1;
        expect(() => opener.open(f)).toThrow(expect.objectContaining({ code: 'integrity' }));
      }
      const { sealer, opener } = pair();
      const f = sealer.seal(utf8Encode('hello'));
      f[2] = (f[2] as number) ^ 1; // record length
      expect(() => opener.open(f)).toThrow(expect.objectContaining({ code: 'protocol' }));
    });

    it('wrong frame type, empty DATA frame, truncated header', () => {
      for (const bad of [new Uint8Array([CHANNEL_FRAME.ABORT, 0]), new Uint8Array([CHANNEL_FRAME.DATA]), new Uint8Array([CHANNEL_FRAME.DATA, 0])]) {
        const { opener } = pair();
        expect(() => opener.open(bad)).toThrow(expect.objectContaining({ code: 'protocol' }));
      }
    });

    it('reassembly cap (memory-DoS guard)', () => {
      const { sealer } = pair();
      const key = randomBytes(32);
      const bigSealer = new RecordSealer(new CipherState(nobleSuite, key), 1 * MiB);
      const smallOpener = new RecordOpener(new CipherState(nobleSuite, key.slice()), 100_000);
      expect(() => smallOpener.open(bigSealer.seal(new Uint8Array(200_000)))).toThrow(expect.objectContaining({ code: 'too-large' }));
      expect(sealer).toBeDefined();
    });

    it('authenticated but non-canonical records: reserved flag bits, short non-final record, empty final record', () => {
      const cases: Uint8Array[][] = [
        [new Uint8Array([0x02, 1, 2, 3])], // reserved bit
        [new Uint8Array([0x00, 1, 2, 3]), new Uint8Array([0x01, 4])], // non-final record shorter than MAX_RECORD_BODY
        [new Uint8Array(1 + MAX_RECORD_BODY), new Uint8Array([0x01])], // empty final record after a full one
      ];
      for (const plaintexts of cases) {
        const key = randomBytes(32);
        const send = new CipherState(nobleSuite, key);
        const opener = new RecordOpener(new CipherState(nobleSuite, key.slice()));
        const recs = plaintexts.map((pt) => {
          const ct = send.encryptWithAd(EMPTY_BYTES, pt);
          const rec = new Uint8Array(2 + ct.length);
          rec[0] = ct.length >> 8;
          rec[1] = ct.length & 0xff;
          rec.set(ct, 2);
          return rec;
        });
        expect(() => opener.open(dataFrame(...recs))).toThrow(expect.objectContaining({ code: 'protocol' }));
        expect(opener.isDead).toBe(true);
      }
    });
  });
});
