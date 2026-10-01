import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ClientEnvelope,
  type DaemonEnvelope,
  type EnvelopeCodecOptions,
  decodeClientHello,
  decodeEnvelope,
  decodeVerdict,
  decodeVerdictReason,
  decodeWelcome,
  encodeClientHello,
  encodeEnvelope,
  encodeVerdict,
} from './codec.ts';
import { MAX_APP_MESSAGE, MSGPACK_MAX_ARRAY_LENGTH, MSGPACK_MAX_BIN_LENGTH, MSGPACK_MAX_MAP_LENGTH, MSGPACK_MAX_STR_LENGTH, PROTOCOL_VERSION } from './constants.ts';
import { SmurgError } from './errors.ts';
import { CLIENT_HELLO_MAX_BYTES, DECODED_MAX_DEPTH } from './schema/limits.ts';
import { FILE, MESSAGE_SAMPLES, bytes, entry, hostSettings, member } from './schema/message-samples.fixture.ts';
import {
  MESSAGE_REGISTRY,
  MESSAGE_TYPES,
  type PayloadOf,
  type RequestFn,
  type RequestHandlerMap,
  type ResultOf,
} from './schema/registry.ts';

// vitest compares typed arrays element by element, which takes seconds for 4–8 MiB chunks.
expect.addEqualityTesters([
  (a: unknown, b: unknown) =>
    a instanceof Uint8Array && b instanceof Uint8Array ? a.byteLength === b.byteLength && Buffer.compare(a, b) === 0 : undefined,
]);

const FROM_CLIENT = { from: 'client', channel: 'interactive' } as const;
const FROM_DAEMON = { from: 'daemon', channel: 'interactive' } as const;
const MiB = 1024 * 1024;

function reasonOf(result: { ok: boolean; error?: SmurgError }): unknown {
  return result.error?.detail?.['reason'];
}

/** Hand-built msgpack for inputs our encoder refuses to produce. */
function rawEnvelope(fields: Record<string, unknown>): Uint8Array {
  return msgpackEncode(fields, { ignoreUndefined: true });
}

describe('round trip of every sample', () => {
  for (const type of MESSAGE_TYPES) {
    const spec = MESSAGE_REGISTRY[type];
    const samples = MESSAGE_SAMPLES[type];
    const channel = spec.channel === 'transfer' ? 'transfer' : 'interactive';
    const senders: ('client' | 'daemon')[] = spec.dir === 'both' ? ['client', 'daemon'] : [spec.dir === 'c2d' ? 'client' : 'daemon'];

    it(`${type}: payloads`, () => {
      for (const [index, sample] of samples.payload.valid.entries()) {
        for (const from of senders) {
          const options: EnvelopeCodecOptions = { from, channel };
          const bytesOut = encodeEnvelope({ type, id: `r${index}`, seq: index, payload: sample as never }, options);
          const decoded = decodeEnvelope(bytesOut, options);
          expect(decoded.ok, decoded.ok ? '' : JSON.stringify(decoded.error.detail)).toBe(true);
          if (!decoded.ok) continue;
          expect(decoded.envelope.type).toBe(type);
          expect(decoded.envelope.id).toBe(`r${index}`);
          expect(decoded.envelope.seq).toBe(index);
          expect(decoded.envelope.payload).toEqual(spec.payload.parse(sample));
        }
      }
    });

    if (spec.result !== null) {
      const resultSchema = spec.result;
      it(`${type}.ok: results`, () => {
        for (const sample of samples.result?.valid ?? []) {
          const options: EnvelopeCodecOptions = { from: 'daemon', channel };
          const decoded = decodeEnvelope(encodeEnvelope({ type: `${type}.ok` as never, id: 'q', seq: 1, payload: sample as never }, options), options);
          expect(decoded.ok, decoded.ok ? '' : JSON.stringify(decoded.error.detail)).toBe(true);
          if (decoded.ok) expect(decoded.envelope.payload).toEqual(resultSchema.parse(sample));
        }
      });
    }

    it(`${type}: invalid payloads are refused by encoder and decoder`, () => {
      const from = senders[0] as 'client' | 'daemon';
      let refusedOnTheWire = 0;
      for (const sample of samples.payload.invalid) {
        expect(() => encodeEnvelope({ type, id: 'x', seq: 0, payload: sample as never })).toThrow(SmurgError);
        const raw = rawEnvelope({ type, id: 'x', seq: 0, payload: sample });
        // Some samples are invalid only in memory (an Int8Array becomes a plain msgpack bin): judge the wire form.
        let wireValid = false;
        try {
          wireValid = spec.payload.safeParse((msgpackDecode(raw) as { payload: unknown }).payload).success;
        } catch {
          wireValid = false; // msgpack itself refuses it (e.g. a __proto__ key)
        }
        const decoded = decodeEnvelope(raw, { from, channel });
        expect(decoded.ok).toBe(wireValid);
        if (!decoded.ok) {
          refusedOnTheWire++;
          expect(decoded.error.code).toBe('bad_request');
          expect(decoded.id).toBe('x');
        }
      }
      expect(refusedOnTheWire).toBeGreaterThan(0);
    });
  }
});

describe('binary fields', () => {
  it('travel as msgpack bin and decode to Uint8Array with the same bytes', () => {
    const data = new Uint8Array(4 * MiB);
    for (let i = 0; i < data.length; i += 4099) data[i] = i & 0xff;
    const hash = bytes(32, 0xab);
    const encoded = encodeEnvelope({ type: 'file.upload.chunk', id: 'c1', seq: 9, payload: { uploadId: 'up_1', index: 0, hash, data } }, { from: 'client', channel: 'transfer' });
    // Envelope overhead stays tiny: msgpack bin, never base64 (transfer.md §1.1).
    expect(encoded.byteLength - data.byteLength).toBeLessThan(200);
    const decoded = decodeEnvelope(encoded, { from: 'client', channel: 'transfer' });
    if (!decoded.ok || decoded.envelope.type !== 'file.upload.chunk') throw new Error('decode failed');
    expect(decoded.envelope.payload.data).toBeInstanceOf(Uint8Array);
    expect(decoded.envelope.payload.data).toEqual(data);
    expect(decoded.envelope.payload.hash).toEqual(hash);
  });

  it('decoded bytes alias the input buffer (the channel must decode from a fresh buffer per message)', () => {
    const encoded = encodeEnvelope({ type: 'exec.output', id: 'o', seq: 1, payload: { sessionId: 's', offset: 0, data: new Uint8Array([1, 2, 3]) } });
    const decoded = decodeEnvelope(encoded, FROM_DAEMON);
    if (!decoded.ok || decoded.envelope.type !== 'exec.output') throw new Error('decode failed');
    encoded.fill(0);
    expect(Array.from(decoded.envelope.payload.data)).toEqual([0, 0, 0]);
  });

  it('accepts a Node Buffer as bytes', () => {
    const payload = { docId: 'd', data: Buffer.from([0, 1, 2]) };
    const decoded = decodeEnvelope(encodeEnvelope({ type: 'doc.sync', id: 's', seq: 1, payload }), FROM_CLIENT);
    expect(decoded.ok).toBe(true);
  });

  it('rejects bytes sent as an array of numbers or as base64', () => {
    for (const data of [[0, 1, 2], 'AAEC']) {
      const decoded = decodeEnvelope(rawEnvelope({ type: 'doc.sync', id: 's', seq: 1, payload: { docId: 'd', data } }), FROM_CLIENT);
      expect(decoded.ok).toBe(false);
      expect(reasonOf(decoded)).toBe('payload');
    }
  });
});

describe('undefined handling', () => {
  it('drops undefined optional fields instead of sending nil', () => {
    const encoded = encodeEnvelope({ type: 'file.read', id: 'u', seq: 1, payload: { file: FILE, maxBytes: undefined } });
    const raw = msgpackDecode(encoded) as { payload: Record<string, unknown> };
    expect(Object.keys(raw.payload)).toEqual(['file']);
    expect(decodeEnvelope(encoded, FROM_CLIENT).ok).toBe(true);
  });

  it('refuses nil where a field is optional (nil is not "absent")', () => {
    const decoded = decodeEnvelope(rawEnvelope({ type: 'file.read', id: 'u', seq: 1, payload: { file: FILE, maxBytes: null } }), FROM_CLIENT);
    expect(decoded.ok).toBe(false);
    expect(reasonOf(decoded)).toBe('payload');
  });

  it('writes exactly { type, id, seq, payload }', () => {
    const raw = msgpackDecode(encodeEnvelope({ type: 'lock.list', id: 'l', seq: 2, payload: {} })) as object;
    expect(Object.keys(raw)).toEqual(['type', 'id', 'seq', 'payload']);
  });
});

describe('decoder limits', () => {
  // A crafted header claims a huge length; the decoder must refuse before reading or allocating.
  const header = (prefix: number, length: number): Uint8Array => {
    const out = new Uint8Array(5);
    out[0] = prefix;
    new DataView(out.buffer).setUint32(1, length);
    return out;
  };
  const envelopeWithRawPayload = (payloadBytes: Uint8Array): Uint8Array => {
    const head = msgpackEncode({ type: 'doc.sync', id: 'L', seq: 0 });
    // Turn the 3-entry fixmap into a 4-entry one and append `payload: <raw>`.
    const out = new Uint8Array(head.length + 8 + payloadBytes.length);
    out.set(head);
    out[0] = 0x84;
    const key = msgpackEncode('payload');
    out.set(key, head.length);
    out.set(payloadBytes, head.length + key.length);
    return out.subarray(0, head.length + key.length + payloadBytes.length);
  };

  it('maxBinLength (9 MiB)', () => {
    const decoded = decodeEnvelope(envelopeWithRawPayload(header(0xc6, MSGPACK_MAX_BIN_LENGTH + 1)), FROM_CLIENT);
    expect(reasonOf(decoded)).toBe('msgpack');
  });

  it('maxStrLength (1 MiB), counted in bytes', () => {
    expect(reasonOf(decodeEnvelope(envelopeWithRawPayload(header(0xdb, MSGPACK_MAX_STR_LENGTH + 1)), FROM_CLIENT))).toBe('msgpack');
    const longText = { code: 'internal', message: 'x', detail: { note: 'é'.repeat(MSGPACK_MAX_STR_LENGTH / 2 + 1) } };
    expect(reasonOf(decodeEnvelope(rawEnvelope({ type: 'error', id: 'e', seq: 0, payload: longText }), FROM_DAEMON))).toBe('msgpack');
  });

  it('maxArrayLength (1e6) and maxMapLength (1e4)', () => {
    expect(reasonOf(decodeEnvelope(envelopeWithRawPayload(header(0xdd, MSGPACK_MAX_ARRAY_LENGTH + 1)), FROM_CLIENT))).toBe('msgpack');
    expect(reasonOf(decodeEnvelope(envelopeWithRawPayload(header(0xdf, MSGPACK_MAX_MAP_LENGTH + 1)), FROM_CLIENT))).toBe('msgpack');
    const bigMap = Object.fromEntries(Array.from({ length: MSGPACK_MAX_MAP_LENGTH + 1 }, (_, i) => [`k${i}`, 0]));
    expect(reasonOf(decodeEnvelope(rawEnvelope({ type: 'error', id: 'e', seq: 0, payload: { code: 'internal', message: 'x', detail: bigMap } }), FROM_DAEMON))).toBe('msgpack');
  });

  it('messages above MAX_APP_MESSAGE are refused before parsing', () => {
    const decoded = decodeEnvelope(new Uint8Array(MAX_APP_MESSAGE + 1), FROM_CLIENT);
    expect(decoded.ok).toBe(false);
    expect(reasonOf(decoded)).toBe('too-large');
  });

  it('nesting deeper than DECODED_MAX_DEPTH is refused (unknown-typed fields are not walked by zod)', () => {
    let deep: unknown = 1;
    for (let i = 0; i < DECODED_MAX_DEPTH + 2; i++) deep = { d: deep };
    const decoded = decodeEnvelope(rawEnvelope({ type: 'error', id: 'e', seq: 0, payload: { code: 'internal', message: 'x', detail: { deep } } }), FROM_DAEMON);
    expect(reasonOf(decoded)).toBe('too-deep');
    // Our encoder refuses such depth; build the bytes by hand: 100k nested fixarray(1) headers.
    const nested = new Uint8Array(100_001).fill(0x91);
    nested[100_000] = 0x90;
    expect(decodeEnvelope(envelopeWithRawPayload(nested), FROM_CLIENT).ok).toBe(false);
  });

  it('trailing bytes, truncated input and non-bytes are refused', () => {
    const good = encodeEnvelope({ type: 'lock.list', id: 'l', seq: 0, payload: {} });
    const trailing = new Uint8Array(good.length + 1);
    trailing.set(good);
    expect(reasonOf(decodeEnvelope(trailing, FROM_CLIENT))).toBe('msgpack');
    expect(reasonOf(decodeEnvelope(good.subarray(0, good.length - 2), FROM_CLIENT))).toBe('msgpack');
    expect(reasonOf(decodeEnvelope(new Uint8Array(0), FROM_CLIENT))).toBe('msgpack');
    expect(reasonOf(decodeEnvelope([1, 2, 3] as unknown as Uint8Array, FROM_CLIENT))).toBe('not-bytes');
  });

  it('msgpack extension types (e.g. the timestamp ext → Date) are not part of the protocol', () => {
    const withDate = msgpackEncode({ type: 'presence.heartbeat', id: 'h', seq: 0, payload: { at: new Date(0) } });
    expect(reasonOf(decodeEnvelope(withDate, FROM_DAEMON))).toBe('msgpack');
  });
});

describe('prototype pollution', () => {
  const polluted = (): boolean => (Object.prototype as { polluted?: unknown }).polluted !== undefined;

  it('refuses __proto__, constructor and prototype keys at any depth', () => {
    const cases: Record<string, unknown>[] = [
      JSON.parse('{"type":"error","id":"p","seq":0,"payload":{"code":"internal","message":"x","detail":{"__proto__":{"polluted":1}}}}'),
      JSON.parse('{"type":"error","id":"p","seq":0,"payload":{"code":"internal","message":"x","detail":{"constructor":{"prototype":{"polluted":1}}}}}'),
      JSON.parse('{"type":"error","id":"p","seq":0,"payload":{"code":"internal","message":"x","detail":{"a":[{"prototype":1}]}}}'),
      JSON.parse('{"type":"error","id":"p","seq":0,"payload":{"code":"internal","message":"x"},"__proto__":{"polluted":1}}'),
    ];
    for (const fields of cases) {
      const decoded = decodeEnvelope(rawEnvelope(fields), FROM_DAEMON);
      expect(decoded.ok).toBe(false);
      expect(['msgpack', 'forbidden-key']).toContain(reasonOf(decoded));
    }
    expect(polluted()).toBe(false);
  });

  it('record schemas refuse them even without the codec', () => {
    const detail = JSON.parse('{"constructor":1}');
    expect(MESSAGE_REGISTRY.error.payload.safeParse({ code: 'internal', message: 'x', detail }).success).toBe(false);
  });
});

describe('envelope shape, type, direction and channel', () => {
  it('refuses extra or missing keys and bad id / seq', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'lock.list', id: 'a', seq: 0, payload: {}, extra: 1 }, 'envelope'],
      [{ type: 'lock.list', id: 'a', seq: 0 }, 'envelope'],
      [{ type: 'lock.list', id: 'has space', seq: 0, payload: {} }, 'envelope'],
      [{ type: 'lock.list', id: '', seq: 0, payload: {} }, 'envelope'],
      [{ type: 'lock.list', id: 'x'.repeat(65), seq: 0, payload: {} }, 'envelope'],
      [{ type: 'lock.list', id: 'a', seq: -1, payload: {} }, 'envelope'],
      [{ type: 'lock.list', id: 'a', seq: 1.5, payload: {} }, 'envelope'],
      [{ type: 'lock.list', id: 'a', seq: 2 ** 53, payload: {} }, 'envelope'],
      [{ type: 7, id: 'a', seq: 0, payload: {} }, 'envelope'],
    ];
    for (const [fields, reason] of cases) expect(reasonOf(decodeEnvelope(rawEnvelope(fields), FROM_CLIENT)), JSON.stringify(fields)).toBe(reason);
    expect(reasonOf(decodeEnvelope(msgpackEncode([1, 2]), FROM_CLIENT))).toBe('envelope');
  });

  it('refuses unknown types, including .ok of one-way messages and events, and echoes the id', () => {
    for (const type of ['file.hack', 'exec.input.ok', 'file.changed.ok', 'toString', '__defineGetter__', 'error.ok', 'file.tree.ok.ok']) {
      const decoded = decodeEnvelope(rawEnvelope({ type, id: 'q-1', seq: 0, payload: {} }), FROM_DAEMON);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) {
        expect(reasonOf(decoded)).toBe('unknown-type');
        expect(decoded.id).toBe('q-1');
        expect(decoded.type).toBeNull();
      }
    }
  });

  it('refuses messages flowing the wrong way (a client cannot forge daemon events or responses)', () => {
    const forged: [string, unknown][] = [
      ['exec.output', { sessionId: 's', offset: 0, data: bytes(1) }],
      ['file.tree.ok', { entries: [], truncated: false }],
      ['error', { code: 'internal', message: 'x' }],
      ['channel.memberUpdated', { member: { ...member, role: 'host' } }],
    ];
    for (const [type, payload] of forged) {
      const decoded = decodeEnvelope(rawEnvelope({ type, id: 'f', seq: 0, payload }), FROM_CLIENT);
      expect(reasonOf(decoded), type).toBe('direction');
    }
    const request = decodeEnvelope(rawEnvelope({ type: 'file.write', id: 'f', seq: 0, payload: { file: FILE, content: bytes(1) } }), FROM_DAEMON);
    expect(reasonOf(request)).toBe('direction');
    expect(() => encodeEnvelope({ type: 'exec.output', id: 'o', seq: 0, payload: { sessionId: 's', offset: 0, data: bytes(1) } }, { from: 'client' })).toThrow(
      SmurgError,
    );
  });

  it('refuses messages on the wrong socket', () => {
    const chunk = { uploadId: 'u', index: 0, hash: bytes(32), data: bytes(1) };
    expect(reasonOf(decodeEnvelope(rawEnvelope({ type: 'file.upload.chunk', id: 'c', seq: 0, payload: chunk }), FROM_CLIENT))).toBe('channel');
    expect(reasonOf(decodeEnvelope(rawEnvelope({ type: 'file.write', id: 'w', seq: 0, payload: { file: FILE, content: bytes(1) } }), { from: 'client', channel: 'transfer' }))).toBe(
      'channel',
    );
    // error and channel.closed may travel on both sockets.
    expect(decodeEnvelope(encodeEnvelope({ type: 'error', id: 'e', seq: 0, payload: { code: 'forbidden', message: 'x' } }), { from: 'daemon', channel: 'transfer' }).ok).toBe(true);
  });

  it('reports payload issues by path without echoing values', () => {
    const decoded = decodeEnvelope(
      rawEnvelope({ type: 'session.create', id: 's', seq: 0, payload: { kind: 'agent', workspace: { mode: 'main' }, cols: 80, rows: 24, title: 'SECRET\u001b[31m' } }),
      FROM_CLIENT,
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.type).toBe('session.create');
    expect(JSON.stringify(decoded.error.detail)).not.toContain('SECRET');
    expect(JSON.stringify(decoded.error.detail)).toContain('title');
  });

  it('normalises paths (NFC) on both ends', () => {
    const decoded = decodeEnvelope(rawEnvelope({ type: 'doc.open', id: 'd', seq: 0, payload: { file: { root: { kind: 'main' }, path: 'café.md' } } }), FROM_CLIENT);
    if (!decoded.ok || decoded.envelope.type !== 'doc.open') throw new Error('decode failed');
    expect(decoded.envelope.payload.file.path).toBe('café.md');
  });
});

describe('encodeEnvelope', () => {
  it('refuses unknown types, bad ids and invalid payloads with bad_request', () => {
    const attempts: (() => unknown)[] = [
      () => encodeEnvelope({ type: 'nope' as 'lock.list', id: 'a', seq: 0, payload: {} }),
      () => encodeEnvelope({ type: 'lock.list', id: 'a b', seq: 0, payload: {} }),
      () => encodeEnvelope({ type: 'lock.list', id: 'a', seq: -1, payload: {} }),
      () => encodeEnvelope({ type: 'lock.release', id: 'a', seq: 0, payload: { file: { root: { kind: 'main' }, path: '../x' } } }),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(SmurgError);
        expect((err as SmurgError).code).toBe('bad_request');
      }
    }
  });

  it('refuses an Envelope bigger than MAX_APP_MESSAGE with too_large', () => {
    const longPath = Array.from({ length: 16 }, () => 'd'.repeat(250)).join('/');
    const entries = Array.from({ length: 2_100 }, () => ({ ...entry, name: 'd'.repeat(250), path: longPath }));
    expect(() => encodeEnvelope({ type: 'file.tree.ok', id: 't', seq: 0, payload: { entries: entries as never, truncated: false } })).toThrow(
      expect.objectContaining({ code: 'too_large' }),
    );
  });

  it('an 8 MiB upload chunk (the largest message) still fits', () => {
    const encoded = encodeEnvelope({ type: 'file.upload.chunk', id: 'x'.repeat(64), seq: Number.MAX_SAFE_INTEGER, payload: { uploadId: 'u'.repeat(64), index: Number.MAX_SAFE_INTEGER, hash: bytes(32), data: bytes(8 * MiB) } });
    expect(encoded.byteLength).toBeLessThanOrEqual(MAX_APP_MESSAGE);
  });
});

describe('ClientHello', () => {
  const hello = {
    protocolVersion: PROTOCOL_VERSION,
    purpose: 'interactive' as const,
    identityToken: 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJnaXRodWI6MSJ9.c2ln',
    cnfNonce: bytes(32, 9),
    clientKind: 'web' as const,
    deviceName: 'Chrome on macOS',
    resume: { channelId: 'ch_1', lastSeq: 41 },
  };

  it('round-trips', () => {
    const decoded = decodeClientHello(encodeClientHello(hello));
    expect(decoded).toEqual({ ok: true, hello });
  });

  it('reports another protocol version as `version`, before strict parsing', () => {
    const future = msgpackEncode({ ...hello, protocolVersion: PROTOCOL_VERSION + 1, newField: true });
    expect(decodeClientHello(future)).toMatchObject({ ok: false, reason: 'version' });
    // An older peer (protocol 1): its hello is otherwise valid; the version decides before anything else.
    expect(decodeClientHello(msgpackEncode({ ...hello, protocolVersion: PROTOCOL_VERSION - 1 }))).toMatchObject({ ok: false, reason: 'version' });
  });

  it('refuses malformed hellos', () => {
    const cases: unknown[] = [
      { ...hello, purpose: 'transfer' }, // resume is interactive-only
      { ...hello, cnfNonce: bytes(31) },
      { ...hello, identityToken: 'not a jwt' },
      { ...hello, deviceName: '' },
      { ...hello, clientKind: 'bot' },
      { ...hello, extra: 1 },
    ];
    for (const value of cases) {
      expect(() => encodeClientHello(value as never)).toThrow(SmurgError);
      const decoded = decodeClientHello(msgpackEncode(value));
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.reason).toBe('malformed');
    }
    const { protocolVersion: _omit, ...withoutVersion } = hello;
    expect(decodeClientHello(msgpackEncode(withoutVersion))).toMatchObject({ ok: false, reason: 'malformed' });
    expect(decodeClientHello(new Uint8Array(CLIENT_HELLO_MAX_BYTES + 1))).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('Verdict', () => {
  const welcome = {
    channelId: 'ch_1',
    resumed: false,
    member: { ...member, role: 'host' },
    workspace: { id: 'AbCdEfGh_-012345', name: 'Smurg', hostUserId: member.userId, hostName: 'Ian', platform: 'darwin', isGitRepo: true },
    settings: { humanLockIdleMs: hostSettings.humanLockIdleMs, agentLockTimeoutMs: hostSettings.agentLockTimeoutMs, uploadChunkSize: hostSettings.uploadChunkSize, sharedDirs: hostSettings.sharedDirs },
    serverTime: 1_727_000_000_000,
  } as const;

  it('accept: encodes the body for the channel admit() and decodes the Welcome', () => {
    const encoded = encodeVerdict({ ok: true, welcome });
    expect(encoded.accept).toBe(true);
    expect(decodeWelcome(encoded.payload)).toEqual({ ok: true, verdict: { ok: true, welcome } });
    expect(decodeVerdict(true, encoded.payload)).toEqual({ ok: true, verdict: { ok: true, welcome } });
  });

  it('reject: carries only the reason', () => {
    for (const reason of ['invite-invalid', 'device-revoked', 'device-other-account', 'identity-invalid', 'kicked', 'version', 'busy'] as const) {
      const encoded = encodeVerdict({ ok: false, reason });
      expect(encoded.accept).toBe(false);
      expect(decodeVerdict(false, encoded.payload)).toEqual({ ok: true, verdict: { ok: false, reason } });
    }
  });

  it('refuses invalid verdicts and bodies', () => {
    expect(() => encodeVerdict({ ok: false, reason: 'because' as 'busy' })).toThrow(SmurgError);
    expect(() => encodeVerdict({ ok: true, welcome: { ...welcome, serverTime: -1 } })).toThrow(SmurgError);
    expect(decodeVerdictReason(new Uint8Array(0)).ok).toBe(false); // the daemon's admit() itself failed
    expect(decodeVerdictReason(msgpackEncode('because')).ok).toBe(false);
    expect(decodeWelcome(msgpackEncode({ ...welcome, extra: 1 })).ok).toBe(false);
    expect(decodeWelcome(msgpackEncode('kicked')).ok).toBe(false);
  });
});

describe('compile-time contract (checked by tsc)', () => {
  it('narrows decoded envelopes by type', () => {
    const decoded = decodeEnvelope(encodeEnvelope({ type: 'file.write', id: 'w', seq: 0, payload: { file: FILE, content: bytes(1) } }), FROM_CLIENT);
    expectTypeOf(decoded).toExtend<{ ok: boolean }>();
    if (decoded.ok && decoded.envelope.type === 'file.write') {
      expectTypeOf(decoded.envelope.payload.content).toEqualTypeOf<Uint8Array>();
      expectTypeOf(decoded.envelope.payload.ifMatchHash).toEqualTypeOf<string | undefined>();
    }
    // What a client can send never includes daemon events or responses, and vice versa.
    expectTypeOf<Extract<ClientEnvelope, { type: 'exec.output' }>>().toBeNever();
    expectTypeOf<Extract<ClientEnvelope, { type: 'file.tree.ok' }>>().toBeNever();
    expectTypeOf<Extract<DaemonEnvelope, { type: 'file.write' }>>().toBeNever();
    expectTypeOf<Extract<DaemonEnvelope, { type: 'doc.sync' }>['payload']['data']>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<Extract<DaemonEnvelope, { type: 'file.tree.ok' }>['payload']>().toEqualTypeOf<ResultOf<'file.tree'>>();
  });

  it('types request() calls and handlers from the registry', async () => {
    const request: RequestFn = async (type) => {
      if (type === 'file.stat') return { entry } as never;
      throw new SmurgError('not_found');
    };
    const stat = await request('file.stat', { root: { kind: 'main' }, path: 'src/app.ts' });
    expectTypeOf(stat).toEqualTypeOf<ResultOf<'file.stat'>>();
    expectTypeOf(stat.entry.kind).toEqualTypeOf<'file' | 'dir' | 'symlink'>();
    // @ts-expect-error: file.write needs `content`
    await request('file.write', { file: FILE }).catch(() => undefined);
    // @ts-expect-error: exec.input is one-way, not a request
    await request('exec.input', { sessionId: 's', data: bytes(1) }).catch(() => undefined);
    expect(() =>
      // @ts-expect-error: payloads are checked against the right type
      encodeEnvelope({ type: 'doc.close', id: 'x', seq: 0, payload: { docId: 1 } }),
    ).toThrow(SmurgError);

    type Handlers = RequestHandlerMap<{ userId: string }>;
    expectTypeOf<Parameters<Handlers['file.tree']>[0]>().toEqualTypeOf<PayloadOf<'file.tree'>>();
    expectTypeOf<Awaited<ReturnType<Handlers['lock.release']>>>().toEqualTypeOf<Record<string, never>>();
  });
});
