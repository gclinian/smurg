// A connected Slack channel (DESIGN 0.8.0 D6.1): `conversations.history` of that one channel with a bot token in the
// Authorization header (`Bearer xoxb-…`), and the names of its writers through `users.info` (kept for a while). The
// bot needs `channels:history` (`groups:history` for a private channel) and `users:read`, and must be in the channel.
//
// Slack answers HTTP 200 with `{ ok: false, error }` for most refusals and HTTP 429 with `Retry-After` (seconds) when
// it wants a wait. `conversations.history` returns the newest messages of the asked range first, a page at a time
// (`has_more`, `response_metadata.next_cursor`): a read pages back from the newest to the cursor, at most
// SLACK_PAGES_MAX pages, and hands the messages on oldest first. A message of a person has no `subtype` and no
// `bot_id`; every other one (a bot's, an app's, a join, a topic change, a thread broadcast) is looked at and skipped.
import { SLACK_CHANNEL_PATTERN, SLACK_TS_PATTERN, SLACK_USER_PATTERN } from '@smurg/protocol';
import { SourceFailed, SourceLimited, compareDigits, getJson, recordOf, stringOf, type SourceMessage, type SourceReader } from './request.ts';

/** The one Slack host smurg talks to (a test's fake server replaces it only through DaemonOptions, D6.1). */
export const SLACK_API_BASE = 'https://slack.com/api';
/** Messages asked for per page (Slack recommends at most 200). */
export const SLACK_PAGE_LIMIT = 100;
/** Pages one read takes at most, from the newest back towards the cursor. */
export const SLACK_PAGES_MAX = 5;
/** How long a name from users.info is kept, and how many are. */
const NAME_KEPT_MS = 6 * 3600_000;
const NAMES_KEPT_MAX = 500;
/** When Slack asks for a wait without saying how long. */
const DEFAULT_WAIT_MS = 60_000;
/** The longest text of a message read (Slack's own limit is 40,000 characters). */
const MESSAGE_TEXT_MAX_CHARS = 100_000;

/** Slack's `error` codes that refuse the token itself, and those that refuse this bot this channel or this method. */
const TOKEN_REFUSED: ReadonlySet<string> = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'not_allowed_token_type', 'two_factor_setup_required', 'org_login_required']);
const NO_ACCESS: ReadonlySet<string> = new Set([
  'channel_not_found',
  'not_in_channel',
  'missing_scope',
  'access_denied',
  'no_permission',
  'team_access_not_granted',
  'channel_is_limited_access',
  'ekm_access_denied',
  'enterprise_is_restricted',
  'restricted_action',
  'accesslimited',
]);
const PASSING: ReadonlySet<string> = new Set(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout']);
/** users.info refusals that only mean "no name": the fallback name is used, the read goes on. */
const NO_NAME: ReadonlySet<string> = new Set(['user_not_found', 'user_not_visible', 'missing_scope', 'access_denied', 'no_permission']);

/** A Slack `ts` for an epoch time (a first read of an empty channel keeps it). */
export function slackTsOf(ms: number): string {
  return `${Math.floor(ms / 1000)}.000000`;
}

/** The order of two `ts` (seconds, then the fraction as written). */
export function compareSlackTs(a: string, b: string): number {
  const [aSeconds = '', aFraction = ''] = a.split('.');
  const [bSeconds = '', bFraction = ''] = b.split('.');
  const seconds = compareDigits(aSeconds, bSeconds);
  if (seconds !== 0) return seconds;
  const x = aFraction.padEnd(16, '0');
  const y = bFraction.padEnd(16, '0');
  return x < y ? -1 : x > y ? 1 : 0;
}

export interface SlackReaderOptions {
  readonly base: string;
  readonly token: string;
  readonly channel: string;
  /** The daemon's clock (how long a name is kept). */
  readonly now: () => number;
}

export class SlackReader implements SourceReader {
  private readonly base: string;
  private readonly token: string;
  private readonly channel: string;
  private readonly now: () => number;
  private pageLimit = SLACK_PAGE_LIMIT;
  private readonly names = new Map<string, { readonly name: string | null; readonly at: number }>();

  constructor(options: SlackReaderOptions) {
    // The channel and the token were checked by their form before a reader is made (poll.ts).
    if (!SLACK_CHANNEL_PATTERN.test(options.channel)) throw new TypeError('not a Slack channel id');
    this.base = options.base;
    this.token = options.token;
    this.channel = options.channel;
    this.now = options.now;
  }

  async newest(signal: AbortSignal, now: number): Promise<string> {
    const body = await this.call('conversations.history', { channel: this.channel, limit: '1' }, signal);
    const first = messagesOf(body)[0];
    return first?.position ?? slackTsOf(now);
  }

  async after(after: string, signal: AbortSignal): Promise<{ readonly messages: readonly SourceMessage[]; readonly skipped: boolean }> {
    const found = new Map<string, SourceMessage>();
    let cursor: string | null = null;
    let more = false;
    for (let page = 0; page < SLACK_PAGES_MAX; page++) {
      const params: Record<string, string> = { channel: this.channel, oldest: after, inclusive: 'false', limit: String(this.pageLimit) };
      if (cursor !== null) params['cursor'] = cursor;
      const body = await this.call('conversations.history', params, signal);
      for (const message of messagesOf(body)) if (compareSlackTs(message.position, after) > 0) found.set(message.position, message);
      more = body['has_more'] === true;
      cursor = stringOf(recordOf(body['response_metadata']), 'next_cursor', 4096);
      if (!more || cursor === null || cursor === '') {
        more = false;
        break;
      }
    }
    return { messages: [...found.values()].sort((a, b) => compareSlackTs(a.position, b.position)), skipped: more };
  }

  async nameOf(author: string, signal: AbortSignal): Promise<string | null> {
    const kept = this.names.get(author);
    const now = this.now();
    if (kept !== undefined && now - kept.at < NAME_KEPT_MS) return kept.name;
    let name: string | null;
    try {
      const user = recordOf((await this.call('users.info', { user: author }, signal))['user']);
      const profile = recordOf(user?.['profile']);
      name = [stringOf(profile, 'display_name'), stringOf(profile, 'real_name'), stringOf(user, 'real_name'), stringOf(user, 'name')].find((candidate) => candidate !== null && candidate.trim() !== '') ?? null;
    } catch (err) {
      if (!(err instanceof SourceFailed && err.problem === 'no-access' && NO_NAME.has(err.why))) throw err;
      name = null;
    }
    if (this.names.size >= NAMES_KEPT_MAX) this.names.delete(this.names.keys().next().value as string);
    this.names.set(author, { name, at: now });
    return name;
  }

  compare(a: string, b: string): number {
    return compareSlackTs(a, b);
  }

  fewer(): void {
    this.pageLimit = Math.max(1, Math.floor(this.pageLimit / 2));
  }

  /** One Web API call: its body when `ok`, else the refusal as a SourceFailed or SourceLimited. */
  private async call(method: string, params: Readonly<Record<string, string>>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const url = new URL(`${this.base}/${method}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const answer = await getJson(url, { headers: { authorization: `Bearer ${this.token}` }, signal });
    if (answer.status === 429) throw new SourceLimited(answer.retryAfterMs ?? DEFAULT_WAIT_MS);
    if (answer.status === 401) throw new SourceFailed('token-refused', 'http-401');
    if (answer.status === 403) throw new SourceFailed('no-access', 'http-403');
    if (answer.status >= 500) throw new SourceFailed('unreachable', `http-${answer.status}`);
    if (answer.status !== 200) throw new SourceFailed('bad-answer', `http-${answer.status}`);
    const body = recordOf(answer.body);
    if (body === null || typeof body['ok'] !== 'boolean') throw new SourceFailed('bad-answer', 'not-slack');
    if (body['ok'] === true) return body;
    const error = stringOf(body, 'error', 64) ?? 'unknown';
    if (error === 'ratelimited') throw new SourceLimited(answer.retryAfterMs ?? DEFAULT_WAIT_MS);
    if (TOKEN_REFUSED.has(error)) throw new SourceFailed('token-refused', error);
    if (NO_ACCESS.has(error)) throw new SourceFailed('no-access', error);
    if (PASSING.has(error)) throw new SourceFailed('unreachable', error);
    throw new SourceFailed('bad-answer', error);
  }
}

/** The messages of an answer of `conversations.history`, each as the poller takes it (one whose `ts` is not a ts is left out). */
function messagesOf(body: Record<string, unknown>): SourceMessage[] {
  const list = body['messages'];
  if (!Array.isArray(list)) throw new SourceFailed('bad-answer', 'no-messages');
  const out: SourceMessage[] = [];
  for (const item of list.slice(0, 1000)) {
    const message = recordOf(item);
    const ts = stringOf(message, 'ts', 40);
    if (message === null || ts === null || !SLACK_TS_PATTERN.test(ts)) continue;
    const user = stringOf(message, 'user', 40);
    // A person's message: no subtype (bot_message, channel_join, thread_broadcast, file_share, …), no bot or app.
    const person = message['type'] === 'message' && message['subtype'] === undefined && message['bot_id'] === undefined && message['app_id'] === undefined && user !== null && SLACK_USER_PATTERN.test(user);
    out.push({
      position: ts,
      at: Math.floor(Number(ts) * 1000),
      author: person ? user : null,
      name: null,
      text: stringOf(message, 'text', MESSAGE_TEXT_MAX_CHARS) ?? '',
    });
  }
  return out;
}
