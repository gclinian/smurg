// Bytes on disk ⇄ the normalised text held in a document's Y.Text (ARCHITECTURE §7.5, yjs-monaco.md Q6 + V6).
//
// The Y.Text is always UTF-8-decoded, BOM-less and LF-only: y-monaco diverges or corrupts with CRLF, mixed EOLs or a
// lone CR in the Y.Text (yjs-monaco.md F21, V6). What the file looked like (`eol`, `bom`) is kept in DocMeta and
// re-applied on save, which is byte-exact for pure LF / CRLF / CR files; a mixed-EOL file is normalised to its
// majority style on the first save (`mixedEol` lets the UI say so once).
//
// Refused (never opened, never overwritten): larger than the limit, a UTF-16/32 BOM, any NUL byte, invalid UTF-8.
// Decoding uses TextDecoder with `fatal: true`: Buffer.toString would silently insert U+FFFD and corrupt the file on
// the next save.
import { MAX_DOC_BYTES } from '@smurg/protocol';

export type DocEol = 'LF' | 'CRLF' | 'CR';

/** How the file looks on disk (the `meta` of doc.open). */
export interface DocMeta {
  readonly eol: DocEol;
  readonly bom: boolean;
  readonly mixedEol: boolean;
}

export type UnsupportedReason = 'too-large' | 'utf16-or-utf32-bom' | 'binary' | 'invalid-utf8';

export type ClassifiedText =
  | { readonly ok: true; readonly text: string; readonly meta: DocMeta }
  | { readonly ok: false; readonly reason: UnsupportedReason };

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function hasUtf16Or32Bom(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return true; // UTF-16 LE (and UTF-32 LE)
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return true; // UTF-16 BE
  return bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff; // UTF-32 BE
}

/**
 * Decides whether `bytes` can be a collaborative document and, if so, returns the normalised text and its meta.
 * The checks run in the order that gives the most useful reason (a UTF-16 file also contains NULs).
 */
export function classifyText(bytes: Uint8Array, maxBytes: number = MAX_DOC_BYTES): ClassifiedText {
  if (bytes.byteLength > maxBytes) return { ok: false, reason: 'too-large' };
  if (hasUtf16Or32Bom(bytes)) return { ok: false, reason: 'utf16-or-utf32-bom' };
  if (bytes.indexOf(0) !== -1) return { ok: false, reason: 'binary' };
  let raw: string;
  try {
    raw = decoder.decode(bytes);
  } catch {
    return { ok: false, reason: 'invalid-utf8' };
  }
  const bom = bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2];
  if (bom) raw = raw.slice(1);
  let crlf = 0;
  let cr = 0;
  let lf = 0;
  let index = raw.indexOf('\r');
  const hasCr = index !== -1;
  // Count line breaks with indexOf (native scans) instead of a per-character loop over up to 5 MiB.
  while (index !== -1) {
    if (raw.charCodeAt(index + 1) === 0x0a) crlf += 1;
    else cr += 1;
    index = raw.indexOf('\r', index + 1);
  }
  index = raw.indexOf('\n');
  while (index !== -1) {
    lf += 1;
    index = raw.indexOf('\n', index + 1);
  }
  lf -= crlf; // every CRLF also counted one LF
  const kinds = (lf > 0 ? 1 : 0) + (crlf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);
  // Majority wins; ties prefer LF, then CRLF (what Monaco and git default to).
  const eol: DocEol = lf >= crlf && lf >= cr ? 'LF' : crlf >= cr ? 'CRLF' : 'CR';
  const text = hasCr ? raw.replace(/\r\n?/g, '\n') : raw;
  return { ok: true, text, meta: { eol, bom, mixedEol: kinds > 1 } };
}

/** The bytes to write for `text` (LF-only in the Y.Text) with the file's EOL style and BOM re-applied. */
export function encodeText(text: string, meta: Pick<DocMeta, 'eol' | 'bom'>): Uint8Array {
  const withEol = meta.eol === 'CRLF' ? text.replace(/\n/g, '\r\n') : meta.eol === 'CR' ? text.replace(/\n/g, '\r') : text;
  const body = encoder.encode(withEol);
  if (!meta.bom) return body;
  const out = new Uint8Array(body.length + UTF8_BOM.length);
  out.set(UTF8_BOM, 0);
  out.set(body, UTF8_BOM.length);
  return out;
}

/** zh-TW message and wire error for a refused file (doc.open answers too_large / bad_request). */
export function unsupportedMessage(reason: UnsupportedReason): { readonly code: 'too_large' | 'bad_request'; readonly message: string } {
  switch (reason) {
    case 'too-large':
      return { code: 'too_large', message: '檔案超過 5 MiB，無法在編輯器中開啟' };
    case 'utf16-or-utf32-bom':
      return { code: 'bad_request', message: '不支援 UTF-16 或 UTF-32 編碼的檔案' };
    case 'binary':
      return { code: 'bad_request', message: '這是二進位檔案，無法在編輯器中開啟' };
    case 'invalid-utf8':
      return { code: 'bad_request', message: '檔案不是有效的 UTF-8 文字，無法在編輯器中開啟' };
  }
}
