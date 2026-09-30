import { z } from 'zod';
import { relayAvatarUrlSchema, relayDisplayNameSchema, relayUserIdSchema } from '../relay/frames.ts';
import { WORKSPACE_ID_PATTERN } from '../relay/routes.ts';
import {
  API_KEY_MAX_CHARS,
  ENVELOPE_ID_MAX_CHARS,
  ETAG_MAX_CHARS,
  IDENTITY_TOKEN_MAX_CHARS,
  OPAQUE_ID_MAX_CHARS,
  SHORT_TEXT_MAX_CHARS,
} from './limits.ts';

// Field-level building blocks shared by every message schema. Conventions (documented once, used everywhere):
//  - ids are strings; daemon-issued ids match OPAQUE_ID_PATTERN so they are safe in file names, logs and map keys;
//  - timestamps are epoch milliseconds as safe integers (file times may be negative; protocol times may not);
//  - sizes, offsets, counts and indexes are non-negative safe integers;
//  - bytes are Uint8Array (msgpack bin), never base64;
//  - free text is length-limited and may not contain control characters, bidi overrides/isolates or lone surrogates.

// ---------------------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------------------

/** Epoch milliseconds produced by smurg itself (never before 1970). */
export const epochMsSchema = z.int().min(0);
/** File modification times as reported by a file system (epoch ms, floored; may predate 1970). */
export const fileTimeMsSchema = z.int();
/** Sizes, byte offsets and byte counts. */
export const byteCountSchema = z.int().min(0);
/** Indexes and counters. */
export const indexSchema = z.int().min(0);
/** Envelope sequence numbers (per channel and direction, strictly increasing). */
export const seqSchema = z.int().min(0);

// ---------------------------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------------------------

export const OPAQUE_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${OPAQUE_ID_MAX_CHARS}}$`);
/** Ids issued by the daemon (sessionId, docId, uploadId, worktreeId, …) or by a client for its own objects. */
export const opaqueIdSchema = z.string().regex(OPAQUE_ID_PATTERN, 'not an id ([A-Za-z0-9_-]{1,64})');

export const ENVELOPE_ID_PATTERN = new RegExp(`^[\\x21-\\x7e]{1,${ENVELOPE_ID_MAX_CHARS}}$`);
/** Envelope `id`: printable ASCII without spaces, so it can be logged verbatim. */
export const envelopeIdSchema = z.string().regex(ENVELOPE_ID_PATTERN, 'not an envelope id');

/** Relay-issued user ids: "github:<id>" | "google:<sub>" | "dev:<name>" (same rule as the relay control frames). */
export const userIdSchema = relayUserIdSchema;
/** Display names: 1–256 characters, no control or bidi characters (same rule as the relay control frames). */
export const displayNameSchema = relayDisplayNameSchema;
/** https only, no credentials. */
export const avatarUrlSchema = relayAvatarUrlSchema;
/** Workspace ids: URL-safe, 16–64 characters. */
export const workspaceIdSchema = z.string().regex(WORKSPACE_ID_PATTERN, 'not a workspace id');

// ---------------------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------------------

// Tab and LF are the only control characters allowed, and only in multi-line text. CR is refused (clients normalise
// CRLF to LF): suggestion text ends up in a PTY, where ESC or C1 CSI (U+009B) inside a bracketed paste could end the
// paste early and turn the rest into keystrokes.
const CONTROL_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_MULTILINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
// Bidi embeddings, overrides and isolates ("Trojan Source"); marks (LRM/RLM/ALM) are legitimate in RTL prose.
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/;
// Without the `u` flag so each half of a pair is matched as a code unit.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** True when `text` has no lone surrogate (String.prototype.isWellFormed is ES2024, outside our lib target). */
export function isWellFormedText(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

function textProblem(text: string, multiline: boolean): string | null {
  if ((multiline ? CONTROL_MULTILINE : CONTROL_SINGLE_LINE).test(text)) return 'control character';
  if (BIDI_CONTROLS.test(text)) return 'bidi control character';
  if (!isWellFormedText(text)) return 'lone surrogate';
  return null;
}

/** Single-line free text (titles, reasons, names shown in the UI). */
export function lineTextSchema(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .superRefine((text, ctx) => {
      const problem = textProblem(text, false);
      if (problem !== null) ctx.addIssue({ code: 'custom', message: `text contains a ${problem}` });
    });
}

/** Multi-line free text: like lineTextSchema, but tab and LF are allowed. */
export function multilineTextSchema(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .superRefine((text, ctx) => {
      const problem = textProblem(text, true);
      if (problem !== null) ctx.addIssue({ code: 'custom', message: `text contains a ${problem}` });
    });
}

/**
 * UTF-8 length of `text` without allocating (msgpack's maxStrLength and our large-text limits count bytes).
 * A lone surrogate counts as 3 bytes, like TextEncoder's U+FFFD replacement.
 */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Cuts `text` to at most `maxBytes` of UTF-8 without splitting a code point. The daemon uses it before putting large
 * text (diffs, conflict hunks) into a message; the schemas then accept the result.
 */
export function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    const size = utf8Length(codePoint);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += codePoint.length;
  }
  return text.slice(0, end);
}

/** Large multi-line text limited in UTF-8 bytes (diffs, conflict hunks). Any character is allowed except NUL. */
export function largeTextSchema(maxBytes: number) {
  return z
    .string()
    .refine((text) => !text.includes('\u0000'), 'text contains NUL')
    .refine((text) => utf8Length(text) <= maxBytes, `text exceeds ${maxBytes} bytes of UTF-8`);
}

/** A short single-line label (session titles, device names, branch names). */
export const shortTextSchema = lineTextSchema(SHORT_TEXT_MAX_CHARS);

/** `#rrggbb` presence colour. */
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'not a #rrggbb colour');

/** SHA-256 as 64 lowercase hex characters (file content hashes, `ifMatchHash`). */
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'not a lowercase SHA-256 hex digest');

/** Download ETag (opaque to the client). */
export const etagSchema = z.string().regex(new RegExp(`^[\\x21-\\x7e]{1,${ETAG_MAX_CHARS}}$`), 'not an etag');

/** Relay identity token: a compact JWS (header.payload.signature, base64url). Verified by the daemon, not here. */
export const identityTokenSchema = z
  .string()
  .max(IDENTITY_TOKEN_MAX_CHARS)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'not a compact JWS');

/** A guest's own Anthropic API key: printable ASCII, no whitespace. The format beyond that is Anthropic's business. */
export const apiKeySchema = z.string().regex(new RegExp(`^[\\x21-\\x7e]{1,${API_KEY_MAX_CHARS}}$`), 'not an API key');

const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_PATTERN = new RegExp(`^(?:\\*\\.)?(?:${DOMAIN_LABEL}\\.)+${DOMAIN_LABEL}(?::([0-9]{1,5}))?$`);
/**
 * Network allow-list entry for guest sandboxes (srt syntax): `example.com`, `*.example.com`, optional `:port`.
 * Lowercase only, at least two labels, at most 253 characters for the host part.
 */
export const allowedDomainSchema = z
  .string()
  .max(253 + 6)
  .regex(DOMAIN_PATTERN, 'not a domain (example.com, *.example.com, optional :port)')
  .refine((entry) => {
    const port = DOMAIN_PATTERN.exec(entry)?.[1];
    const host = port === undefined ? entry : entry.slice(0, -(port.length + 1));
    return host.length <= 253 && (port === undefined || (Number(port) >= 1 && Number(port) <= 65_535));
  }, 'domain too long or port out of range');

// ---------------------------------------------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------------------------------------------

/**
 * A real Uint8Array (Node's Buffer included). The toStringTag check accepts arrays from another realm (a Worker,
 * jsdom) that fail `instanceof`, while still rejecting other views (Int8Array, DataView) and plain arrays.
 */
function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array ||
    (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]')
  );
}

export type BytesLimits = { readonly max: number; readonly min?: number } | { readonly exact: number };

/** Bytes (msgpack bin ⇄ Uint8Array) with a length rule. Decoded arrays alias the received buffer (see codec.ts). */
export function bytesSchema(limits: BytesLimits) {
  const min = 'exact' in limits ? limits.exact : (limits.min ?? 0);
  const max = 'exact' in limits ? limits.exact : limits.max;
  const rule = min === max ? `exactly ${max} bytes` : `${min}–${max} bytes`;
  return z
    .custom<Uint8Array>(isUint8Array, { message: 'expected bytes (Uint8Array)' })
    .refine((bytes) => bytes.byteLength >= min && bytes.byteLength <= max, `expected ${rule}`);
}
