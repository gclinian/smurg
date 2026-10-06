import { encode } from '@msgpack/msgpack';
import { describe, expect, it } from 'vitest';
import * as c from './constants.ts';

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

describe('Noise framing sizes', () => {
  it('a record carries 65518 body bytes and costs 19 bytes of overhead', () => {
    expect(c.MAX_RECORD_BODY).toBe(65_518);
    expect(c.RECORD_OVERHEAD_BYTES).toBe(19);
  });

  it('reproduces the sizes measured in the research spikes', () => {
    // noise.md §1.5: 8 MiB -> 129 records, one WebSocket message of 8,391,060 bytes
    expect(c.noiseRecordCount(8 * MiB)).toBe(129);
    expect(c.noiseDataFrameBytes(8 * MiB)).toBe(8_391_060);
    // transfer.md §1.1: a 4 MiB chunk costs 65 records x 19 B + 1 = 1,236 bytes of framing
    expect(c.noiseDataFrameBytes(4 * MiB) - 4 * MiB).toBe(1_236);
    // noise.md §1.5: "a small message costs 20 bytes of overhead"
    expect(c.noiseDataFrameBytes(0)).toBe(20);
  });

  it('splits exactly at the record boundary', () => {
    expect(c.noiseRecordCount(c.MAX_RECORD_BODY)).toBe(1);
    expect(c.noiseRecordCount(c.MAX_RECORD_BODY + 1)).toBe(2);
  });

  it('rejects impossible sizes', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => c.noiseDataFrameBytes(bad)).toThrow(RangeError);
    }
  });
});

describe('message and frame limits', () => {
  it('MAX_RELAY_FRAME is 8 MiB + 64 KiB and far below the platform limit', () => {
    expect(c.MAX_RELAY_FRAME).toBe(8 * MiB + 64 * KiB);
    expect(c.MAX_RELAY_FRAME).toBe(8_454_144);
    expect(c.MAX_RELAY_FRAME).toBeLessThan(c.RELAY_PLATFORM_MAX_MESSAGE);
  });

  it('the largest application message, framed by Noise and prefixed with a connection id, fits in one relay frame', () => {
    expect(c.noiseDataFrameBytes(c.MAX_APP_MESSAGE) + c.RELAY_CONN_PREFIX_BYTES).toBeLessThanOrEqual(c.MAX_RELAY_FRAME);
  });

  it('an 8 MiB chunk framed by Noise fits in MAX_RELAY_FRAME', () => {
    expect(c.noiseDataFrameBytes(c.MAX_CHUNK_SIZE) + c.RELAY_CONN_PREFIX_BYTES).toBeLessThanOrEqual(c.MAX_RELAY_FRAME);
  });

  it('a worst-case file.upload.chunk Envelope of MAX_CHUNK_SIZE fits in MAX_APP_MESSAGE and in one relay frame', () => {
    const envelope = {
      type: 'file.upload.chunk',
      id: 'i'.repeat(64),
      seq: Number.MAX_SAFE_INTEGER,
      payload: {
        uploadId: 'u'.repeat(64),
        index: Number.MAX_SAFE_INTEGER,
        hash: new Uint8Array(c.CHUNK_HASH_BYTES),
        data: new Uint8Array(c.MAX_CHUNK_SIZE),
      },
    };
    const bytes = encode(envelope, { ignoreUndefined: true });
    expect(bytes.byteLength).toBeGreaterThan(c.MAX_CHUNK_SIZE);
    expect(bytes.byteLength).toBeLessThanOrEqual(c.MAX_APP_MESSAGE);
    expect(c.noiseDataFrameBytes(bytes.byteLength) + c.RELAY_CONN_PREFIX_BYTES).toBeLessThanOrEqual(c.MAX_RELAY_FRAME);
  });

  it('msgpack limits admit every legitimate binary field', () => {
    expect(c.MSGPACK_MAX_BIN_LENGTH).toBe(9 * MiB);
    expect(c.MSGPACK_MAX_BIN_LENGTH).toBeGreaterThanOrEqual(c.MAX_CHUNK_SIZE);
    expect(c.MSGPACK_MAX_BIN_LENGTH).toBeGreaterThanOrEqual(c.MAX_DOC_BYTES);
    expect(c.UPLOAD_HASHES_PAGE_MAX * c.CHUNK_HASH_BYTES).toBe(4 * MiB);
    expect(c.UPLOAD_HASHES_PAGE_MAX * c.CHUNK_HASH_BYTES).toBeLessThanOrEqual(c.MSGPACK_MAX_BIN_LENGTH);
    expect(c.MSGPACK_DECODER_LIMITS).toEqual({
      maxBinLength: 9 * MiB,
      maxStrLength: 1 * MiB,
      maxArrayLength: 1_000_000,
      maxMapLength: 10_000,
    });
  });

  it('a whole collaborative document fits in one application message', () => {
    expect(c.MAX_DOC_BYTES).toBe(5 * MiB);
    expect(c.MAX_DOC_BYTES).toBeLessThan(c.MAX_APP_MESSAGE);
  });

  it('close reasons follow RFC 6455 (125 bytes of control payload minus the 2-byte code)', () => {
    expect(c.CLOSE_REASON_MAX_BYTES).toBe(123);
  });
});

describe('transfers', () => {
  it('chunk sizes are ordered 1 MiB <= 4 MiB <= 8 MiB', () => {
    expect(c.MIN_CHUNK_SIZE).toBe(1 * MiB);
    expect(c.DEFAULT_CHUNK_SIZE).toBe(4 * MiB);
    expect(c.MAX_CHUNK_SIZE).toBe(8 * MiB);
    expect(c.MIN_CHUNK_SIZE).toBeLessThanOrEqual(c.DEFAULT_CHUNK_SIZE);
    expect(c.DEFAULT_CHUNK_SIZE).toBeLessThanOrEqual(c.MAX_CHUNK_SIZE);
  });

  it('the ack window keeps at most 16 MiB in flight at the default chunk size', () => {
    expect(c.TRANSFER_WINDOW_CHUNKS).toBe(4);
    expect(c.TRANSFER_WINDOW_CHUNKS * c.DEFAULT_CHUNK_SIZE).toBe(16 * MiB);
  });

  it('the bufferedAmount guard is 8 MiB, polled every 5 ms', () => {
    expect(c.TRANSFER_BUFFERED_AMOUNT_MAX).toBe(8 * MiB);
    expect(c.TRANSFER_BUFFERED_POLL_MS).toBe(5);
  });
});

describe('liveness timings (R1: every guest sees "host offline" within 10 s)', () => {
  it('uses the verified heartbeat values', () => {
    expect(c.RELAY_PING_INTERVAL_MS).toBe(2_000);
    expect(c.PONG_WATCHDOG_MS).toBe(6_000);
    expect(c.RELAY_HOST_TIMEOUT_MS).toBe(6_000);
    expect(c.RELAY_CLIENT_SWEEP_MS).toBe(30_000);
    expect(c.PRESENCE_HEARTBEAT_INTERVAL_MS).toBe(3_000);
    expect(c.CLIENT_OFFLINE_THRESHOLD_MS).toBe(8_000);
    expect(c.HOST_OFFLINE_DEADLINE_MS).toBe(10_000);
  });

  it('tolerates one lost ping or heartbeat before declaring anything dead', () => {
    expect(c.PONG_WATCHDOG_MS).toBeGreaterThanOrEqual(2 * c.RELAY_PING_INTERVAL_MS);
    expect(c.RELAY_HOST_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * c.RELAY_PING_INTERVAL_MS);
    expect(c.CLIENT_OFFLINE_THRESHOLD_MS).toBeGreaterThanOrEqual(2 * c.PRESENCE_HEARTBEAT_INTERVAL_MS);
    expect(c.RELAY_CLIENT_SWEEP_MS).toBeGreaterThan(c.PONG_WATCHDOG_MS);
  });

  it('both offline detectors fire inside the R1 deadline', () => {
    expect(c.RELAY_HOST_TIMEOUT_MS).toBeLessThan(c.HOST_OFFLINE_DEADLINE_MS);
    expect(c.CLIENT_OFFLINE_THRESHOLD_MS).toBeLessThan(c.HOST_OFFLINE_DEADLINE_MS);
  });

  it('handshakes have a 10 s deadline and identity tokens live 5 minutes', () => {
    expect(c.HANDSHAKE_DEADLINE_MS).toBe(10_000);
    expect(c.MAX_FAILED_HANDSHAKES_PER_CONN).toBe(5);
    expect(c.IDENTITY_TOKEN_TTL_SECONDS).toBe(300);
  });
});

describe('locks, documents and disk defaults', () => {
  it('uses the SPEC defaults', () => {
    expect(c.HUMAN_LOCK_IDLE_MS).toBe(30_000);
    expect(c.AGENT_LOCK_TTL_MS).toBe(60_000);
    expect(c.DISK_RESERVE_BYTES_DEFAULT).toBe(5 * GiB);
    expect(c.DISK_RESERVE_PERCENT_DEFAULT).toBe(5);
  });

  it('autosave debounces within its maximum wait', () => {
    expect(c.AUTOSAVE_DEBOUNCE_MS).toBe(300);
    expect(c.AUTOSAVE_MAX_WAIT_MS).toBe(2_000);
    expect(c.AUTOSAVE_DEBOUNCE_MS).toBeLessThan(c.AUTOSAVE_MAX_WAIT_MS);
  });
});

describe('identifiers and tags', () => {
  it('fits a workspace id into the u8 length field of the Noise prologue', () => {
    expect(c.WORKSPACE_ID_MIN_LENGTH).toBeGreaterThanOrEqual(16);
    expect(c.WORKSPACE_ID_MAX_LENGTH).toBeLessThanOrEqual(255);
    expect(c.NOISE_PROLOGUE_TAG).toBe('smurg-noise/1');
    expect(c.PROTOCOL_VERSION).toBe(4);
  });
});
