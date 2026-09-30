// classifyText / encodeText (ARCHITECTURE §7.5, yjs-monaco.md Q6 + V6): what may become a document and how its bytes
// round-trip. The wire-level refusals and round trips are in doc-files.test.ts.
import { describe, expect, it } from 'vitest';
import { classifyText, encodeText } from '../../src/docs/text-codec.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const BOM = [0xef, 0xbb, 0xbf];
const withBom = (s: string): Uint8Array => Uint8Array.from([...BOM, ...enc(s)]);

function roundTrip(bytes: Uint8Array): Uint8Array {
  const c = classifyText(bytes);
  if (!c.ok) throw new Error(c.reason);
  return encodeText(c.text, c.meta);
}

describe('classifyText', () => {
  it('normalises CRLF, lone CR and mixed EOLs to LF in the text and remembers eol / mixedEol', () => {
    expect(classifyText(enc('a\r\nb\r\n'))).toEqual({ ok: true, text: 'a\nb\n', meta: { eol: 'CRLF', bom: false, mixedEol: false } });
    expect(classifyText(enc('a\rb\rc'))).toEqual({ ok: true, text: 'a\nb\nc', meta: { eol: 'CR', bom: false, mixedEol: false } });
    expect(classifyText(enc('a\nb\n'))).toEqual({ ok: true, text: 'a\nb\n', meta: { eol: 'LF', bom: false, mixedEol: false } });
    expect(classifyText(enc('a\r\nb\nc\r\nd'))).toEqual({ ok: true, text: 'a\nb\nc\nd', meta: { eol: 'CRLF', bom: false, mixedEol: true } });
    // One stray CR in an LF file: LF wins, the CR still becomes a line break in the Y.Text (V6).
    expect(classifyText(enc('a\nb\rc\nd\n'))).toEqual({ ok: true, text: 'a\nb\nc\nd\n', meta: { eol: 'LF', bom: false, mixedEol: true } });
    expect(classifyText(enc('no line break'))).toMatchObject({ ok: true, meta: { eol: 'LF', mixedEol: false } });
  });

  it('strips and remembers a UTF-8 BOM', () => {
    expect(classifyText(withBom('中文\r\n'))).toEqual({ ok: true, text: '中文\n', meta: { eol: 'CRLF', bom: true, mixedEol: false } });
  });

  it('refuses UTF-16 / UTF-32 BOMs, NUL bytes, invalid UTF-8 and oversized input', () => {
    expect(classifyText(Uint8Array.of(0xff, 0xfe, 0x61, 0x00))).toEqual({ ok: false, reason: 'utf16-or-utf32-bom' });
    expect(classifyText(Uint8Array.of(0xfe, 0xff, 0x00, 0x61))).toEqual({ ok: false, reason: 'utf16-or-utf32-bom' });
    expect(classifyText(Uint8Array.of(0x00, 0x00, 0xfe, 0xff))).toEqual({ ok: false, reason: 'utf16-or-utf32-bom' });
    expect(classifyText(Uint8Array.of(0x61, 0x00, 0x62))).toEqual({ ok: false, reason: 'binary' });
    // Big5 「中文」: valid Big5, invalid UTF-8 (Buffer.toString would silently turn it into U+FFFD).
    expect(classifyText(Uint8Array.of(0xa4, 0xa4, 0xa4, 0xe5))).toEqual({ ok: false, reason: 'invalid-utf8' });
    expect(classifyText(new Uint8Array(11), 10)).toEqual({ ok: false, reason: 'too-large' });
    expect(classifyText(enc('x'.repeat(10)), 10)).toMatchObject({ ok: true });
  });
});

describe('encodeText', () => {
  it('pure LF / CRLF / CR files, with or without a BOM, round-trip byte for byte', () => {
    for (const sample of [enc('a\nb\n'), enc('a\r\nb\r\n'), enc('a\rb\r'), withBom('x\ny'), withBom('x\r\ny\r\n'), enc(''), withBom('')]) {
      expect(roundTrip(sample)).toEqual(sample);
    }
  });

  it('re-applies eol and bom to edited text, and normalises a mixed file to its majority on save', () => {
    expect(new TextDecoder().decode(encodeText('a\nb\nnew\n', { eol: 'CRLF', bom: false }))).toBe('a\r\nb\r\nnew\r\n');
    expect(encodeText('a\nb', { eol: 'CR', bom: true })).toEqual(Uint8Array.from([...BOM, 0x61, 0x0d, 0x62]));
    expect(new TextDecoder().decode(roundTrip(enc('a\r\nb\nc\r\n')))).toBe('a\r\nb\r\nc\r\n');
  });
});
