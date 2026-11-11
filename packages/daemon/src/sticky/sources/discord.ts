// A connected Discord channel (DESIGN 0.8.0 D6.1): `GET /channels/<id>/messages?after=<last id>` with a bot token
// (`Authorization: Bot <token>`, and the User-Agent Discord asks of a bot). The bot needs View Channel and Read
// Message History in that channel, and the Message Content Intent (without it Discord sends every text empty; such a
// message is skipped like any empty one).
//
// Every id is a snowflake (17 to 20 digits, sent as a string); the time it was made is in its bits from 22 up, after
// Discord's epoch. Discord answers 401 for a token it refuses, 403 or 404 when the bot may not see the channel, and
// 429 with `retry_after` (seconds) when it wants a wait. The order of the messages it returns is not relied on: they
// are put in the order of their ids. A person's message is of type DEFAULT (0) or REPLY (19), by an author who is no
// bot and no system user, and not a webhook's; every other one is looked at and skipped.
import { DISCORD_ID_PATTERN } from '@smurg/protocol';
import daemonPackage from '../../../package.json' with { type: 'json' };
import { SourceFailed, SourceLimited, compareDigits, getJson, recordOf, stringOf, type SourceMessage, type SourceReader } from './request.ts';

/** The one Discord host smurg talks to, API version 10 (a test's fake server replaces it only through DaemonOptions, D6.1). */
export const DISCORD_API_BASE = 'https://discord.com/api/v10';
/** Messages asked for per read (Discord's most). */
export const DISCORD_PAGE_LIMIT = 100;
/** Discord's epoch: the first second of 2015, in epoch ms. */
const DISCORD_EPOCH = 1_420_070_400_000n;
/** When Discord asks for a wait without saying how long. */
const DEFAULT_WAIT_MS = 60_000;
/** The longest text of a message read (Discord's own limit is 4,000 characters). */
const MESSAGE_TEXT_MAX_CHARS = 16_000;
/** The message types of what a person wrote: DEFAULT, REPLY. */
const PERSON_TYPES: ReadonlySet<unknown> = new Set([0, 19]);
/** What Discord asks a bot to send (https://discord.com/developers/docs/reference: "DiscordBot ($url, $versionNumber)"). */
const USER_AGENT = `DiscordBot (https://smurg.ai, ${daemonPackage.version})`;

/** The time a snowflake was made, in epoch ms. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** The smallest snowflake of an epoch time (a first read of an empty channel keeps it). */
export function snowflakeOf(ms: number): string {
  const since = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH;
  return String((since > 0n ? since : 0n) << 22n).padStart(17, '0');
}

export interface DiscordReaderOptions {
  readonly base: string;
  readonly token: string;
  readonly channel: string;
}

export class DiscordReader implements SourceReader {
  private readonly base: string;
  private readonly token: string;
  private readonly channel: string;
  private pageLimit = DISCORD_PAGE_LIMIT;

  constructor(options: DiscordReaderOptions) {
    // The channel and the token were checked by their form before a reader is made (poll.ts).
    if (!DISCORD_ID_PATTERN.test(options.channel)) throw new TypeError('not a Discord channel id');
    this.base = options.base;
    this.token = options.token;
    this.channel = options.channel;
  }

  async newest(signal: AbortSignal, now: number): Promise<string> {
    const first = (await this.messages({ limit: '1' }, signal)).reduce<SourceMessage | null>((newest, message) => (newest === null || compareDigits(message.position, newest.position) > 0 ? message : newest), null);
    return first?.position ?? snowflakeOf(now);
  }

  async after(after: string, signal: AbortSignal): Promise<{ readonly messages: readonly SourceMessage[]; readonly skipped: boolean }> {
    const messages = (await this.messages({ after, limit: String(this.pageLimit) }, signal)).filter((message) => compareDigits(message.position, after) > 0);
    // With `after`, Discord gives the messages right after the id: what it did not give comes in the next read.
    return { messages: messages.sort((a, b) => compareDigits(a.position, b.position)), skipped: false };
  }

  /** Discord sends the name with the message. */
  async nameOf(): Promise<string | null> {
    return null;
  }

  compare(a: string, b: string): number {
    return compareDigits(a, b);
  }

  fewer(): void {
    this.pageLimit = Math.max(1, Math.floor(this.pageLimit / 2));
  }

  private async messages(params: Readonly<Record<string, string>>, signal: AbortSignal): Promise<SourceMessage[]> {
    const url = new URL(`${this.base}/channels/${this.channel}/messages`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const answer = await getJson(url, { headers: { authorization: `Bot ${this.token}`, 'user-agent': USER_AGENT }, signal });
    if (answer.status === 429) {
      const seconds = recordOf(answer.body)?.['retry_after'];
      throw new SourceLimited(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : (answer.retryAfterMs ?? DEFAULT_WAIT_MS));
    }
    if (answer.status === 401) throw new SourceFailed('token-refused', 'http-401');
    if (answer.status === 403 || answer.status === 404) throw new SourceFailed('no-access', `http-${answer.status}`);
    if (answer.status >= 500) throw new SourceFailed('unreachable', `http-${answer.status}`);
    if (answer.status !== 200) throw new SourceFailed('bad-answer', `http-${answer.status}`);
    if (!Array.isArray(answer.body)) throw new SourceFailed('bad-answer', 'not-a-list');
    const out: SourceMessage[] = [];
    for (const item of answer.body.slice(0, DISCORD_PAGE_LIMIT)) {
      const message = recordOf(item);
      const id = stringOf(message, 'id', 20);
      if (message === null || id === null || !DISCORD_ID_PATTERN.test(id)) continue;
      const author = recordOf(message['author']);
      const authorId = stringOf(author, 'id', 20);
      const person = PERSON_TYPES.has(message['type']) && message['webhook_id'] === undefined && author !== null && author['bot'] !== true && author['system'] !== true && authorId !== null && DISCORD_ID_PATTERN.test(authorId);
      const name = [stringOf(author, 'global_name'), stringOf(author, 'username')].find((candidate) => candidate !== null && candidate.trim() !== '') ?? null;
      out.push({ position: id, at: snowflakeTime(id), author: person ? authorId : null, name, text: stringOf(message, 'content', MESSAGE_TEXT_MAX_CHARS) ?? '' });
    }
    return out;
  }
}
