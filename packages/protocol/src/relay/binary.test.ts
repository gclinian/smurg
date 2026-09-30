import { describe, expect, it } from 'vitest';
import { MAX_RELAY_FRAME } from '../constants.ts';
import {
  MAX_CONN_ID,
  allocPrefixedFrame,
  exceedsRelayFrameLimit,
  isConnId,
  prefixFrame,
  splitFrame,
  writeConnPrefix,
} from './binary.ts';

const payload = new Uint8Array([0x10, 0xaa, 0xbb, 0xcc]);

describe('prefixFrame / splitFrame', () => {
  it('writes the connection id as u32 big-endian in front of the payload', () => {
    const frame = prefixFrame(0x01020304, payload);
    expect([...frame]).toEqual([0x01, 0x02, 0x03, 0x04, 0x10, 0xaa, 0xbb, 0xcc]);
  });

  it('round-trips every boundary connection id', () => {
    for (const conn of [1, 255, 256, 0xffff, 0x1_0000, MAX_CONN_ID]) {
      const split = splitFrame(prefixFrame(conn, payload));
      expect(split?.conn).toBe(conn);
      expect([...(split?.payload ?? [])]).toEqual([...payload]);
    }
  });

  it('splits without copying (payload is a view on the input)', () => {
    const frame = prefixFrame(7, payload);
    const split = splitFrame(frame);
    expect(split?.payload.buffer).toBe(frame.buffer);
    expect(split?.payload.byteOffset).toBe(frame.byteOffset + 4);
  });

  it('honours the byteOffset of a subarray input (e.g. a Node Buffer from a pool)', () => {
    const backing = new Uint8Array(32).fill(0xee);
    backing.set(prefixFrame(42, payload), 10);
    const split = splitFrame(backing.subarray(10, 18));
    expect(split?.conn).toBe(42);
    expect([...(split?.payload ?? [])]).toEqual([...payload]);
  });

  it('accepts an ArrayBuffer, as delivered to a Durable Object', () => {
    const frame = prefixFrame(9, payload);
    const split = splitFrame(frame.buffer);
    expect(split?.conn).toBe(9);
    expect(split?.payload.byteLength).toBe(payload.byteLength);
  });

  it('rejects frames without a payload and the reserved connection id 0', () => {
    expect(splitFrame(new Uint8Array(0))).toBeNull();
    expect(splitFrame(new Uint8Array([0, 0, 0]))).toBeNull();
    expect(splitFrame(new Uint8Array([0, 0, 0, 1]))).toBeNull();
    expect(splitFrame(new Uint8Array([0, 0, 0, 0, 0x10]))).toBeNull();
  });

  it('refuses to build frames for invalid connection ids', () => {
    for (const conn of [0, -1, 1.5, MAX_CONN_ID + 1, Number.NaN]) {
      expect(() => prefixFrame(conn, payload)).toThrow(RangeError);
    }
  });
});

describe('allocPrefixedFrame / writeConnPrefix', () => {
  it('returns a frame with the prefix written and a writable view of its payload area', () => {
    const { frame, payload: body } = allocPrefixedFrame(0xdeadbeef, 3);
    body.set([1, 2, 3]);
    expect(frame.byteLength).toBe(7);
    expect(body.buffer).toBe(frame.buffer);
    expect([...frame]).toEqual([0xde, 0xad, 0xbe, 0xef, 1, 2, 3]);
  });

  it('rewrites the prefix in place', () => {
    const frame = prefixFrame(1, payload);
    writeConnPrefix(frame, 2);
    expect(splitFrame(frame)?.conn).toBe(2);
    expect(() => writeConnPrefix(new Uint8Array(3), 1)).toThrow(RangeError);
    expect(() => allocPrefixedFrame(1, -1)).toThrow(RangeError);
  });
});

describe('isConnId / exceedsRelayFrameLimit', () => {
  it('accepts exactly the u32 range without 0', () => {
    expect(isConnId(1)).toBe(true);
    expect(isConnId(MAX_CONN_ID)).toBe(true);
    expect(isConnId(0)).toBe(false);
    expect(isConnId(MAX_CONN_ID + 1)).toBe(false);
    expect(isConnId('1')).toBe(false);
  });

  it('flags frames above MAX_RELAY_FRAME', () => {
    expect(exceedsRelayFrameLimit(MAX_RELAY_FRAME)).toBe(false);
    expect(exceedsRelayFrameLimit(MAX_RELAY_FRAME + 1)).toBe(true);
    expect(exceedsRelayFrameLimit(Number.NaN)).toBe(true);
  });
});
