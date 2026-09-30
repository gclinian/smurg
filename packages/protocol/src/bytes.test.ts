import { describe, expect, it } from 'vitest';
import { concatBytes, equalBytes, fromBase64Url, fromHex, randomBytes, toBase64Url, toHex, utf8Decode, utf8Encode } from './bytes.ts';

describe('base64url', () => {
  it('round-trips every length and matches Node Buffer base64url', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = randomBytes(n);
      const text = toBase64Url(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64url'));
      expect(fromBase64Url(text)).toEqual(bytes);
    }
  });

  it.each([
    ['padding', 'AAAA='],
    ['standard alphabet +', 'ab+c'],
    ['standard alphabet /', 'ab/c'],
    ['whitespace', 'AAAA AAAA'],
    ['percent-encoding', 'AA%41'],
    ['impossible length', 'AAAAA'],
  ])('rejects %s', (_name, text) => {
    expect(() => fromBase64Url(text)).toThrow(TypeError);
  });

  it('rejects non-canonical trailing bits (two encodings of the same bytes)', () => {
    expect(fromBase64Url('AA')).toEqual(new Uint8Array([0]));
    expect(() => fromBase64Url('AB')).toThrow(/non-canonical/);
    expect(fromBase64Url('AAA')).toEqual(new Uint8Array([0, 0]));
    expect(() => fromBase64Url('AAB')).toThrow(/non-canonical/);
  });
});

describe('hex', () => {
  it('round-trips and rejects anything but pairs of hex digits', () => {
    const bytes = randomBytes(33);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(fromHex('ABcd')).toEqual(new Uint8Array([0xab, 0xcd]));
    for (const bad of ['a', '+1', '0x00', 'zz', ' 00', '00 ']) expect(() => fromHex(bad)).toThrow(TypeError);
  });
});

describe('misc', () => {
  it('equalBytes compares content and length', () => {
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(equalBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
  });

  it('concatBytes returns a fresh buffer', () => {
    const a = new Uint8Array([1]);
    const out = concatBytes(a, new Uint8Array([2, 3]));
    expect(out).toEqual(new Uint8Array([1, 2, 3]));
    a[0] = 9;
    expect(out[0]).toBe(1);
    expect(concatBytes(a).buffer).not.toBe(a.buffer);
  });

  it('utf8Decode is strict', () => {
    expect(utf8Decode(utf8Encode('主人已離線'))).toBe('主人已離線');
    expect(() => utf8Decode(new Uint8Array([0xff]))).toThrow();
  });

  it('randomBytes fills more than one getRandomValues quota', () => {
    const big = randomBytes(200_000);
    expect(big.length).toBe(200_000);
    expect(big.subarray(150_000).some((b) => b !== 0)).toBe(true);
  });
});
