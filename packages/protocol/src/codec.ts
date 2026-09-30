import { Decoder, Encoder, type ExtensionCodecType } from '@msgpack/msgpack';
import type { z } from 'zod';
import { MAX_APP_MESSAGE, MSGPACK_DECODER_LIMITS, PROTOCOL_VERSION } from './constants.ts';
import { type ErrorDetail, FORBIDDEN_RECORD_KEYS, SmurgError } from './errors.ts';
import {
  type ChannelPurpose,
  type ClientHello,
  type ClientMessageType,
  clientHelloSchema,
  type DaemonMessageType,
  envelopeIdSchema,
  parseWireType,
  seqSchema,
  type Verdict,
  verdictRejectReasonSchema,
  verdictSchema,
  type WireType,
  type WirePayloadInputOf,
  type WirePayloadOf,
  welcomeSchema,
} from './schema/index.ts';
import { CLIENT_HELLO_MAX_BYTES, DECODED_MAX_DEPTH, MESSAGE_TYPE_MAX_CHARS } from './schema/limits.ts';

// MessagePack codec for Envelopes (ARCHITECTURE §4.3) and for the two handshake structures (§4.2).
//
//  - One msgpack map per Envelope: `{ type, id, seq, payload }`, nothing else.
//  - Encoder `ignoreUndefined: true`: an `undefined` optional field is dropped, not sent as nil (which zod's
//    `.optional()` would reject on the other side).
//  - Decoder with the limits of constants.ts (9 MiB bin, 1 MiB str, 1e6 array, 1e4 map). msgpack extension types are
//    not part of the protocol: both directions refuse them (the default codec would turn ext -1 into a Date).
//  - decode never throws: it returns a typed Envelope whose payload passed the registry schema, or a SmurgError
//    `bad_request` with `detail.reason` ∈ DECODE_FAILURE_REASONS and, when it could be read, the Envelope id so the
//    daemon can answer `error` with the same id.
//  - Zero-copy: decoded byte fields are views into the input buffer. The channel must decode from a fresh buffer per
//    message (noise.md / transfer.md gotcha 25) or copy what it keeps.

// ---------------------------------------------------------------------------------------------------------------
// msgpack instances
// ---------------------------------------------------------------------------------------------------------------

const noExtensions: ExtensionCodecType<undefined> = {
  tryToEncode: () => null,
  decode: (_data, extensionType) => {
    throw new RangeError(`msgpack extension type ${extensionType} is not part of the protocol`);
  },
};

const encoder = new Encoder({ ignoreUndefined: true, extensionCodec: noExtensions });
const decoder = new Decoder({ ...MSGPACK_DECODER_LIMITS, extensionCodec: noExtensions });

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/** Which side produced the bytes: the daemon decodes with `from: 'client'`, clients with `from: 'daemon'`. */
export type Sender = 'client' | 'daemon';

export interface EnvelopeOf<T extends WireType> {
  readonly type: T;
  readonly id: string;
  readonly seq: number;
  readonly payload: WirePayloadOf<T>;
}

/** What a sender passes to encodeEnvelope (payload before normalisation). */
export interface EnvelopeInput<T extends WireType> {
  readonly type: T;
  readonly id: string;
  readonly seq: number;
  readonly payload: WirePayloadInputOf<T>;
}

type DistributeEnvelope<T extends WireType> = T extends WireType ? EnvelopeOf<T> : never;

/** Any Envelope (discriminated by `type`). */
export type AnyEnvelope = DistributeEnvelope<WireType>;
/** An Envelope a client sent (what the daemon's router receives). */
export type ClientEnvelope = DistributeEnvelope<ClientMessageType>;
/** An Envelope the daemon sent (what a client receives): events, both-way messages, `X.ok`, `error`. */
export type DaemonEnvelope = DistributeEnvelope<DaemonMessageType>;

export interface EnvelopeCodecOptions {
  /** Who produced the Envelope; types that may not flow that way are refused. */
  readonly from: Sender;
  /** The socket the Envelope travels on; types registered for the other channel are refused. */
  readonly channel: ChannelPurpose;
}

export const DECODE_FAILURE_REASONS = [
  'not-bytes',
  'too-large',
  'msgpack',
  'forbidden-key',
  'too-deep',
  'envelope',
  'unknown-type',
  'direction',
  'channel',
  'payload',
  'version',
] as const;
export type DecodeFailureReason = (typeof DECODE_FAILURE_REASONS)[number];

export type EnvelopeDecodeResult<E> =
  | { readonly ok: true; readonly envelope: E }
  | {
      readonly ok: false;
      readonly error: SmurgError;
      /** The Envelope id when it could be read (answer `error` with it), else null. */
      readonly id: string | null;
      /** The Envelope type when it could be read and is a known type, else null. */
      readonly type: WireType | null;
    };

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

const MAX_REPORTED_ISSUES = 10;

function failure(reason: DecodeFailureReason, message: string, extra: ErrorDetail = {}): SmurgError {
  return new SmurgError('bad_request', message, { reason, ...extra });
}

/** Issue paths and messages only: never the offending values (they can be file contents or keys). */
function issuesOf(error: z.ZodError): { path: string; code: string; message: string }[] {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isByteArray(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array ||
    (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]')
  );
}

/**
 * Walks a decoded msgpack value without recursion. Rejects prototype-pollution keys at any depth (msgpack itself only
 * rejects `__proto__`), nesting deeper than DECODED_MAX_DEPTH (payload schemas never look inside `unknown` fields such
 * as audit detail, so depth is bounded here) and value types that msgpack should never produce.
 */
function inspectDecoded(root: unknown): 'forbidden-key' | 'too-deep' | 'msgpack' | null {
  const stack: [unknown, number][] = [[root, 0]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop() as [unknown, number];
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') continue;
    if (isByteArray(value)) continue;
    if (depth >= DECODED_MAX_DEPTH) return 'too-deep';
    if (Array.isArray(value)) {
      for (const item of value) stack.push([item, depth + 1]);
      continue;
    }
    if (!isPlainObject(value)) return 'msgpack';
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_RECORD_KEYS.has(key)) return 'forbidden-key';
      stack.push([value[key], depth + 1]);
    }
  }
  return null;
}

/** On a rejected value, `value` is still returned when msgpack itself succeeded, so the caller can echo the id. */
type MsgpackResult = { ok: true; value: unknown } | { ok: false; error: SmurgError; value?: unknown };

function decodeMsgpack(bytes: unknown, maxBytes: number): MsgpackResult {
  if (!isByteArray(bytes)) return { ok: false, error: failure('not-bytes', 'expected a Uint8Array') };
  if (bytes.byteLength > maxBytes) {
    return { ok: false, error: failure('too-large', `message exceeds ${maxBytes} bytes`) };
  }
  let value: unknown;
  try {
    value = decoder.decode(bytes);
  } catch (err) {
    // DecodeError / RangeError messages describe the structure (lengths, positions), never content.
    const message = err instanceof Error ? err.message.slice(0, 200) : 'invalid msgpack';
    return { ok: false, error: failure('msgpack', `invalid msgpack: ${message}`) };
  }
  const problem = inspectDecoded(value);
  if (problem !== null) return { ok: false, error: failure(problem, `rejected decoded value: ${problem}`), value };
  return { ok: true, value };
}

function encodeMsgpack(value: unknown, maxBytes: number, what: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = encoder.encode(value);
  } catch (err) {
    throw new SmurgError('bad_request', `cannot encode ${what}`, { reason: 'msgpack' }, { cause: err });
  }
  if (bytes.byteLength > maxBytes) {
    throw new SmurgError('too_large', `${what} is ${bytes.byteLength} bytes, more than ${maxBytes}`, {
      reason: 'too-large',
    });
  }
  return bytes;
}

function directionAllows(from: Sender, parsed: NonNullable<ReturnType<typeof parseWireType>>): boolean {
  if (parsed.kind === 'response') return from === 'daemon';
  const dir = parsed.spec.dir;
  return dir === 'both' || (from === 'client' ? dir === 'c2d' : dir === 'd2c');
}

function channelAllows(channel: ChannelPurpose, parsed: NonNullable<ReturnType<typeof parseWireType>>): boolean {
  return parsed.spec.channel === 'both' || parsed.spec.channel === channel;
}

function schemaFor(parsed: NonNullable<ReturnType<typeof parseWireType>>): z.ZodType {
  return parsed.kind === 'response' ? (parsed.spec.result as z.ZodType) : parsed.spec.payload;
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['type', 'id', 'seq', 'payload']);

/** The Envelope id of a (possibly rejected) decoded value, if it has a valid one as an own property. */
function readEnvelopeId(value: unknown): string | null {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'id')) return null;
  const id = envelopeIdSchema.safeParse(value['id']);
  return id.success ? id.data : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------------------------------

/**
 * Validates and encodes one Envelope. The payload is validated against the registry (and normalised, e.g. paths to
 * NFC) so a peer never puts on the wire what the other side would reject; `options` additionally refuses types that
 * may not flow in that direction or on that channel. Throws SmurgError `bad_request` (invalid) or `too_large`
 * (encoded size above MAX_APP_MESSAGE).
 */
export function encodeEnvelope<T extends WireType>(
  envelope: EnvelopeInput<T>,
  options?: Partial<EnvelopeCodecOptions>,
): Uint8Array {
  const parsed = typeof envelope.type === 'string' ? parseWireType(envelope.type) : null;
  if (parsed === null) throw failure('unknown-type', 'unknown message type');
  if (options?.from !== undefined && !directionAllows(options.from, parsed)) {
    throw failure('direction', `${envelope.type} may not be sent by the ${options.from}`);
  }
  if (options?.channel !== undefined && !channelAllows(options.channel, parsed)) {
    throw failure('channel', `${envelope.type} does not travel on the ${options.channel} channel`);
  }
  if (!envelopeIdSchema.safeParse(envelope.id).success) throw failure('envelope', 'invalid envelope id');
  if (!seqSchema.safeParse(envelope.seq).success) throw failure('envelope', 'invalid envelope seq');
  const payload = schemaFor(parsed).safeParse(envelope.payload);
  if (!payload.success) {
    throw failure('payload', `invalid ${envelope.type} payload`, { type: envelope.type, issues: issuesOf(payload.error) });
  }
  return encodeMsgpack(
    { type: envelope.type, id: envelope.id, seq: envelope.seq, payload: payload.data },
    MAX_APP_MESSAGE,
    'envelope',
  );
}

/**
 * Decodes and validates one Envelope received from `options.from` on `options.channel`. Order: size ≤
 * MAX_APP_MESSAGE → msgpack with limits → no forbidden keys / excessive depth → exactly `{ type, id, seq, payload }`
 * → known type → allowed direction and channel → payload (or `.ok` result) schema.
 */
export function decodeEnvelope(
  bytes: Uint8Array,
  options: EnvelopeCodecOptions & { readonly from: 'client' },
): EnvelopeDecodeResult<ClientEnvelope>;
export function decodeEnvelope(
  bytes: Uint8Array,
  options: EnvelopeCodecOptions & { readonly from: 'daemon' },
): EnvelopeDecodeResult<DaemonEnvelope>;
export function decodeEnvelope(bytes: Uint8Array, options: EnvelopeCodecOptions): EnvelopeDecodeResult<AnyEnvelope>;
export function decodeEnvelope(bytes: Uint8Array, options: EnvelopeCodecOptions): EnvelopeDecodeResult<AnyEnvelope> {
  try {
    return decodeEnvelopeUnsafe(bytes, options);
  } catch (err) {
    // Defensive: nothing above should throw, but a decoder must never take the connection down with an exception.
    return {
      ok: false,
      error: new SmurgError('bad_request', 'undecodable message', { reason: 'msgpack' }, { cause: err }),
      id: null,
      type: null,
    };
  }
}

function decodeEnvelopeUnsafe(bytes: Uint8Array, options: EnvelopeCodecOptions): EnvelopeDecodeResult<AnyEnvelope> {
  const decoded = decodeMsgpack(bytes, MAX_APP_MESSAGE);
  if (!decoded.ok) return { ok: false, error: decoded.error, id: readEnvelopeId(decoded.value), type: null };
  const value = decoded.value;
  if (!isPlainObject(value)) return { ok: false, error: failure('envelope', 'envelope is not a map'), id: null, type: null };

  const id = envelopeIdSchema.safeParse(value['id']);
  const readableId = readEnvelopeId(value);
  const fail = (error: SmurgError, type: WireType | null = null): EnvelopeDecodeResult<AnyEnvelope> => ({
    ok: false,
    error,
    id: readableId,
    type,
  });

  const keys = Object.keys(value);
  if (keys.length !== ENVELOPE_KEYS.size || !keys.every((key) => ENVELOPE_KEYS.has(key))) {
    return fail(failure('envelope', 'envelope must have exactly type, id, seq and payload'));
  }
  if (!id.success) return fail(failure('envelope', 'invalid envelope id'));
  if (!seqSchema.safeParse(value['seq']).success) return fail(failure('envelope', 'invalid envelope seq'));
  const rawType = value['type'];
  if (typeof rawType !== 'string' || rawType.length === 0 || rawType.length > MESSAGE_TYPE_MAX_CHARS) {
    return fail(failure('envelope', 'invalid envelope type'));
  }
  const parsed = parseWireType(rawType);
  if (parsed === null) return fail(failure('unknown-type', 'unknown message type'));
  if (!directionAllows(options.from, parsed)) {
    return fail(failure('direction', `${parsed.type} may not be sent by the ${options.from}`), parsed.type);
  }
  if (!channelAllows(options.channel, parsed)) {
    return fail(failure('channel', `${parsed.type} does not travel on the ${options.channel} channel`), parsed.type);
  }
  const payload = schemaFor(parsed).safeParse(value['payload']);
  if (!payload.success) {
    return fail(
      failure('payload', `invalid ${parsed.type} payload`, { type: parsed.type, issues: issuesOf(payload.error) }),
      parsed.type,
    );
  }
  const envelope = { type: parsed.type, id: id.data, seq: value['seq'] as number, payload: payload.data };
  return { ok: true, envelope: envelope as AnyEnvelope };
}

// ---------------------------------------------------------------------------------------------------------------
// ClientHello (payload of Noise msg3)
// ---------------------------------------------------------------------------------------------------------------

export type ClientHelloInput = z.input<typeof clientHelloSchema>;

export type ClientHelloDecodeResult =
  | { readonly ok: true; readonly hello: ClientHello }
  /** `version`: answer the verdict `version`; anything else: the verdict the daemon's policy picks for bad input. */
  | { readonly ok: false; readonly reason: 'version' | 'malformed'; readonly error: SmurgError };

/** Validates and encodes a ClientHello. Never log the input: it contains the identity token. */
export function encodeClientHello(hello: ClientHelloInput): Uint8Array {
  const parsed = clientHelloSchema.safeParse(hello);
  if (!parsed.success) {
    throw failure('payload', 'invalid ClientHello', { issues: issuesOf(parsed.error) });
  }
  return encodeMsgpack(parsed.data, CLIENT_HELLO_MAX_BYTES, 'ClientHello');
}

/**
 * Decodes the ClientHello from the msg3 payload. A different `protocolVersion` is reported as `version` before the
 * strict schema runs, because a peer of another version may legitimately send fields this version does not know.
 */
export function decodeClientHello(bytes: Uint8Array): ClientHelloDecodeResult {
  try {
    const decoded = decodeMsgpack(bytes, CLIENT_HELLO_MAX_BYTES);
    if (!decoded.ok) return { ok: false, reason: 'malformed', error: decoded.error };
    const value = decoded.value;
    if (!isPlainObject(value)) return { ok: false, reason: 'malformed', error: failure('envelope', 'not a map') };
    const version = value['protocolVersion'];
    if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
      return { ok: false, reason: 'malformed', error: failure('payload', 'missing protocolVersion') };
    }
    if (version !== PROTOCOL_VERSION) {
      return {
        ok: false,
        reason: 'version',
        error: failure('version', `protocol version ${version} is not supported (this peer speaks ${PROTOCOL_VERSION})`),
      };
    }
    const parsed = clientHelloSchema.safeParse(value);
    if (!parsed.success) {
      return { ok: false, reason: 'malformed', error: failure('payload', 'invalid ClientHello', { issues: issuesOf(parsed.error) }) };
    }
    return { ok: true, hello: parsed.data };
  } catch (err) {
    return { ok: false, reason: 'malformed', error: new SmurgError('bad_request', 'undecodable ClientHello', { reason: 'msgpack' }, { cause: err }) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Verdict (first DATA record from the daemon). The channel driver owns the tag byte (VERDICT.ACCEPT / REJECT in
// channel/frames.ts) and carries an opaque body: msgpack(Welcome) on accept, msgpack(reason) on reject. These
// functions produce and read exactly those bodies.
// ---------------------------------------------------------------------------------------------------------------

export type VerdictInput = z.input<typeof verdictSchema>;

/** The shape `daemonAccept({ admit })` returns (channel/handshake.ts AdmitDecision). */
export interface EncodedVerdict {
  readonly accept: boolean;
  readonly payload: Uint8Array;
}

export type VerdictDecodeResult = { readonly ok: true; readonly verdict: Verdict } | { readonly ok: false; readonly error: SmurgError };

/** Validates a Verdict and encodes its body for the channel's admit() decision. */
export function encodeVerdict(verdict: VerdictInput): EncodedVerdict {
  const parsed = verdictSchema.safeParse(verdict);
  if (!parsed.success) throw failure('payload', 'invalid Verdict', { issues: issuesOf(parsed.error) });
  return parsed.data.ok
    ? { accept: true, payload: encodeMsgpack(parsed.data.welcome, MAX_APP_MESSAGE, 'Welcome') }
    : { accept: false, payload: encodeMsgpack(parsed.data.reason, MAX_APP_MESSAGE, 'Verdict reason') };
}

/** Client side, accept: the body the channel returned (`ClientConnectResult.verdict`) → Welcome. */
export function decodeWelcome(payload: Uint8Array): VerdictDecodeResult {
  try {
    const decoded = decodeMsgpack(payload, MAX_APP_MESSAGE);
    if (!decoded.ok) return { ok: false, error: decoded.error };
    const welcome = welcomeSchema.safeParse(decoded.value);
    if (!welcome.success) return { ok: false, error: failure('payload', 'invalid Welcome', { issues: issuesOf(welcome.error) }) };
    return { ok: true, verdict: { ok: true, welcome: welcome.data } };
  } catch (err) {
    return { ok: false, error: new SmurgError('bad_request', 'undecodable Welcome', { reason: 'msgpack' }, { cause: err }) };
  }
}

/**
 * Client side, reject: the body of a `rejected` ChannelError (`error.verdict`) → reason. An empty body (the daemon's
 * admit() itself failed) or an unknown reason is a failure; show a generic refusal then.
 */
export function decodeVerdictReason(payload: Uint8Array): VerdictDecodeResult {
  try {
    const decoded = decodeMsgpack(payload, MAX_APP_MESSAGE);
    if (!decoded.ok) return { ok: false, error: decoded.error };
    const reason = verdictRejectReasonSchema.safeParse(decoded.value);
    if (!reason.success) return { ok: false, error: failure('payload', 'invalid verdict reason') };
    return { ok: true, verdict: { ok: false, reason: reason.data } };
  } catch (err) {
    return { ok: false, error: new SmurgError('bad_request', 'undecodable verdict reason', { reason: 'msgpack' }, { cause: err }) };
  }
}

/** Both cases in one call: `accept` is the channel's tag, `payload` its body. */
export function decodeVerdict(accept: boolean, payload: Uint8Array): VerdictDecodeResult {
  return accept ? decodeWelcome(payload) : decodeVerdictReason(payload);
}
