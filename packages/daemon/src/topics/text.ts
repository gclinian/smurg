// PURE. Small text helpers of the topics module: what a file holds is free text, what the wire carries is bounded and
// free of the characters the wire schemas refuse (controls, bidi overrides, lone surrogates). These helpers turn the
// first into the second for what PEOPLE read (titles, summaries, report sections); nothing here is for a model.
import { createHash } from 'node:crypto';
import { truncateToUtf8Bytes } from '@smurg/protocol';

const CONTROL_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROL_MULTILINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Cuts at a code unit count without splitting a surrogate pair. */
function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** A single line the wire accepts (`lineTextSchema`): tabs become spaces, other controls and bidi overrides go. */
export function wireLine(text: string, max: number): string {
  return clipChars(text.replace(/\t/g, ' ').replace(CONTROL_SINGLE_LINE, '').replace(BIDI_CONTROLS, '').replace(LONE_SURROGATE, ''), max);
}

/** Multi-line text the wire accepts (`multilineTextSchema`): CRLF becomes LF, controls and bidi overrides go. */
export function wireMultiline(text: string, max: number): string {
  return clipChars(text.replace(/\r\n?/g, '\n').replace(CONTROL_MULTILINE, '').replace(BIDI_CONTROLS, '').replace(LONE_SURROGATE, ''), max);
}

/** Large text the wire accepts (`largeTextSchema`: anything but NUL), cut at `maxBytes` of UTF-8. */
export function wireLarge(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  const clean = text.replace(/\u0000/g, '').replace(LONE_SURROGATE, '');
  const cut = truncateToUtf8Bytes(clean, maxBytes);
  return { text: cut, truncated: cut.length < clean.length };
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** SHA-256 of a file's bytes as 64 lower-case hex characters: what a Start pins and what a report check records. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The hash of a file that does not exist (the same as an empty file: `PlanInfo` always carries two hashes). */
export const EMPTY_HASH = sha256Hex('');
