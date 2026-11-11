// One request of an outside source to its service (DESIGN 0.8.0 D6.1): outbound HTTPS from the host's computer, never
// through the relay. Every request: GET, `redirect: 'error'` (a token never follows a redirect anywhere), a timeout,
// and a cap on the bytes read (a body over it is cancelled and refused, never parsed). What goes wrong is one of the
// sources' kinds, each with a catalog text the host reads in the notes view; nothing of a request (its URL, a header,
// the body) is ever logged: an error's name and code at most.
import { wireText, type WireText } from '@smurg/protocol';
import { msg, type MessageRef } from '@smurg/protocol/i18n';

/** How long one request may take. */
export const SOURCE_TIMEOUT_MS = 15_000;
/** The most bytes of one answer that are read (a page of messages; Slack's long ones are why it is not smaller). */
export const SOURCE_BODY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Why a source is not read (SourceState `failing`): the form of what connectors.json holds (checked before anything is
 * fetched), the service's own refusal, or an answer that did not come or could not be read.
 */
export type SourceProblem = 'channel-invalid' | 'token-invalid' | 'token-refused' | 'no-access' | 'unreachable' | 'bad-answer';

/** The catalog text of a problem, as the wire carries it (`SourceState.problem`). */
export function problemText(problem: SourceProblem): WireText {
  return wireText(problemRef(problem));
}

function problemRef(problem: SourceProblem): MessageRef {
  switch (problem) {
    case 'channel-invalid':
      return msg('sticky.source.channelInvalid');
    case 'token-invalid':
      return msg('sticky.source.tokenInvalid');
    case 'token-refused':
      return msg('sticky.source.tokenRefused');
    case 'no-access':
      return msg('sticky.source.noAccess');
    case 'unreachable':
      return msg('sticky.source.unreachable');
    case 'bad-answer':
      return msg('sticky.source.badAnswer');
  }
}

/** A read that failed: the source is `failing` with this problem until the next read goes through. */
export class SourceFailed extends Error {
  readonly problem: SourceProblem;
  /** What happened, for the log (a status, a service's error code, an error's name): never a token or a text. */
  readonly why: string;
  /** The answer was over SOURCE_BODY_MAX_BYTES (the next read asks for fewer messages). */
  readonly tooLarge: boolean;

  constructor(problem: SourceProblem, why: string, tooLarge = false) {
    super(`outside source: ${problem}`);
    this.name = 'SourceFailed';
    this.problem = problem;
    this.why = why;
    this.tooLarge = tooLarge;
  }
}

/** The service asked to wait (HTTP 429): no request before `retryAfterMs` has passed. */
export class SourceLimited extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('outside source: rate limited');
    this.name = 'SourceLimited';
    this.retryAfterMs = retryAfterMs;
  }
}

export interface SourceAnswer {
  readonly status: number;
  /** The parsed JSON body; undefined when the body was empty or not JSON (only a 200 must be JSON). */
  readonly body: unknown;
  /** `Retry-After` in milliseconds, when the answer had a readable one. */
  readonly retryAfterMs: number | null;
}

export interface RequestOptions {
  readonly headers: Readonly<Record<string, string>>;
  /** Aborted when the daemon stops or the source's entry changes: the request is given up, nothing is said. */
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** Whether `err` is the abort of `signal` (the daemon stopping, the entry replaced), not a timeout. */
export function abortedBy(signal: AbortSignal, err: unknown): boolean {
  return signal.aborted && (err === signal.reason || (err instanceof Error && err.name === 'AbortError'));
}

/** `Retry-After` as Slack and Discord send it: seconds, perhaps with decimals. */
export function retryAfterOf(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

/**
 * GET `url` with `headers`. Resolves with the status and the JSON body; throws SourceFailed (`unreachable`: no answer,
 * a timeout, a network error; `bad-answer`: a redirect, a body over the cap, a 200 that is not JSON) or the abort.
 */
export async function getJson(url: URL, options: RequestOptions): Promise<SourceAnswer> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? SOURCE_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, timeout]);
  const maxBytes = options.maxBytes ?? SOURCE_BODY_MAX_BYTES;
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers: { ...options.headers, accept: 'application/json' }, redirect: 'error', signal });
  } catch (err) {
    if (abortedBy(options.signal, err)) throw err;
    // undici refuses a redirect with `fetch failed` caused by `unexpected redirect`: the answer was not the service's.
    const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    if (cause instanceof Error && cause.message === 'unexpected redirect') throw new SourceFailed('bad-answer', 'redirect');
    throw new SourceFailed('unreachable', timeout.aborted ? 'timeout' : errorCode(cause ?? err));
  }
  const declared = Number(response.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new SourceFailed('bad-answer', 'too-large', true);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readCapped(response, maxBytes);
  } catch (err) {
    if (abortedBy(options.signal, err)) throw err;
    if (err instanceof SourceFailed) throw err;
    throw new SourceFailed('unreachable', timeout.aborted ? 'timeout' : errorCode(err));
  }
  let body: unknown;
  try {
    body = bytes.length === 0 ? undefined : (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
  } catch {
    if (response.status === 200) throw new SourceFailed('bad-answer', 'not-json');
    body = undefined;
  }
  return { status: response.status, body, retryAfterMs: retryAfterOf(response.headers.get('retry-after')) };
}

/** The body, read up to `maxBytes`: one byte more cancels the stream and refuses the answer. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SourceFailed('bad-answer', 'too-large', true);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** An error's code for the log (ECONNREFUSED, UND_ERR_SOCKET), else its name: never its message. */
function errorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string') return (err as { code: string }).code.slice(0, 64);
  return err instanceof Error ? err.name.slice(0, 64) : 'unknown';
}

/** One message of a connected channel, as a reader hands it to the poller (poll.ts). */
export interface SourceMessage {
  /** Where it is in its channel: Slack's `ts`, Discord's message id (both checked by their pattern). */
  readonly position: string;
  /** When it was written (epoch ms), read from its position. */
  readonly at: number;
  /** The outside id of the PERSON who wrote it; null: a bot, an app, a webhook, an event of the channel. */
  readonly author: string | null;
  /** The name it came with (Discord); null: the reader asks for it (Slack's users.info). */
  readonly name: string | null;
  /** Its text as the service sends it (Slack's `&amp; &lt; &gt;` not decoded yet). */
  readonly text: string;
}

/** What the poller asks of one connected channel (slack.ts, discord.ts). */
export interface SourceReader {
  /** The position of the newest message, or one made from `now` when there is none: what a first read keeps. */
  newest(signal: AbortSignal, now: number): Promise<string>;
  /**
   * The messages after `after`, oldest first. `skipped`: more came since `after` than one read takes, and the oldest
   * of them were not read (the poller logs it).
   */
  after(after: string, signal: AbortSignal): Promise<{ readonly messages: readonly SourceMessage[]; readonly skipped: boolean }>;
  /** The name of the person `author` (null: not known; the fallback name is used). */
  nameOf(author: string, signal: AbortSignal): Promise<string | null>;
  /** Two positions in the channel's order. */
  compare(a: string, b: string): number;
  /** After an answer over the byte cap: the next read asks for fewer messages. */
  fewer(): void;
}

/** Two strings of digits compared as numbers: without leading zeros, the longer is the larger. */
export function compareDigits(a: string, b: string): number {
  const x = withoutLeadingZeros(a);
  const y = withoutLeadingZeros(b);
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

function withoutLeadingZeros(digits: string): string {
  let start = 0;
  while (start < digits.length - 1 && digits[start] === '0') start += 1;
  return digits.slice(start);
}

/** A plain object (a JSON object), else null. */
export function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A string field of a JSON object, at most `max` characters; else null. */
export function stringOf(record: Record<string, unknown> | null, key: string, max = 256): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.length <= max ? value : null;
}
