// Searches captured relay bytes for a plaintext marker in the encodings a leak could take (R3 acceptance).
import type { TapFrame } from './tap-collector.ts';

export type PlaintextEncoding = 'utf8' | 'utf16le' | 'base64' | 'base64url' | 'hex';

/** Shorter markers can occur in ciphertext by chance (noise.md gotcha 18). */
export const MIN_MARKER_BYTES = 16;

/**
 * Returns the encodings in which `marker` occurs in any of `haystack`'s buffers (each searched on its own).
 * Base64 is checked at all three byte alignments, so a marker embedded at any offset of an encoded blob is found.
 */
export function findPlaintext(haystack: Buffer | readonly Buffer[] | readonly TapFrame[], marker: string): PlaintextEncoding[] {
  const bytes = Buffer.from(marker, 'utf8');
  if (bytes.length < MIN_MARKER_BYTES) throw new RangeError(`marker must be at least ${MIN_MARKER_BYTES} bytes`);
  const buffers: Buffer[] = Buffer.isBuffer(haystack)
    ? [haystack]
    : (haystack as readonly (Buffer | TapFrame)[]).map((item) => (Buffer.isBuffer(item) ? item : item.data));

  const forms = new Map<PlaintextEncoding, Buffer[]>([
    ['utf8', [bytes]],
    ['utf16le', [Buffer.from(marker, 'utf16le')]],
    ['hex', [Buffer.from(bytes.toString('hex')), Buffer.from(bytes.toString('hex').toUpperCase())]],
    ['base64', base64Cores(bytes).map((core) => Buffer.from(core))],
    ['base64url', base64Cores(bytes).map((core) => Buffer.from(core.replace(/\+/g, '-').replace(/\//g, '_')))],
  ]);
  const hits: PlaintextEncoding[] = [];
  for (const [encoding, needles] of forms) {
    if (buffers.some((buffer) => needles.some((needle) => buffer.includes(needle)))) hits.push(encoding);
  }
  return hits;
}

/** The part of base64(marker) that does not depend on neighbouring bytes, for each of the 3 alignments. */
function base64Cores(bytes: Buffer): string[] {
  const cores: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64').replace(/=+$/, '');
    cores.push(encoded.slice(offset === 0 ? 0 : 4, encoded.length - 4));
  }
  return cores;
}
