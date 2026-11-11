// TEST ONLY: fake Slack and Discord Web APIs on 127.0.0.1 (written after test/hooks/mock-anthropic.ts). The daemon's
// readers of the outside sources (src/sticky/sources/) talk to them through DaemonOptions.outsideBaseUrls with a fake
// token, so no test ever reaches slack.com or discord.com, or anyone's workspace or server (ARCHITECTURE §0 rule 2).
//
// They play the shapes of the public documentation (checked 2026-11-12):
//  - Slack: `GET /conversations.history?channel&oldest&inclusive&limit&cursor` with `Authorization: Bearer <token>`,
//    the newest messages of the range first, `has_more` and `response_metadata.next_cursor`; `GET /users.info?user`;
//    a refusal is HTTP 200 `{ ok: false, error }` (invalid_auth, channel_not_found, not_in_channel, …).
//  - Discord: `GET /channels/<id>/messages?after&limit` with `Authorization: Bot <token>`; the messages right after
//    `after` (or the newest without it), sent newest first here so the reader must put them in order; 401 for a bad
//    token, 404 for an unknown channel.
// A test can put answers ahead of the scripted ones (`answerNext`): a 429 with Retry-After, a redirect, a body over the
// cap, an error. Every request is recorded with the time it came and whether its credential matched, never the value.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedSourceRequest {
  /** Date.now() when it came. */
  readonly at: number;
  /** The path after the base: `conversations.history`, `users.info`, `channels/<id>/messages`. */
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  /** Whether the Authorization header held the fake token in the source's scheme (never the value itself). */
  readonly authorized: boolean;
  readonly userAgent: string | null;
  /** It got an answer a test put ahead (answerNext), not the scripted one. */
  readonly forced: boolean;
}

/** An answer a test puts ahead of the scripted ones. */
export type ForcedAnswer =
  | { readonly status: number; readonly headers?: Readonly<Record<string, string>>; readonly body?: unknown }
  | { readonly redirect: string }
  | { readonly bytes: number };

export interface FakeSource {
  readonly url: string;
  readonly requests: RecordedSourceRequest[];
  /** The next answers, in order, before the scripted ones. */
  answerNext(...answers: ForcedAnswer[]): void;
  close(): Promise<void>;
}

export interface SlackMessage {
  readonly ts: string;
  readonly text: string;
  readonly user?: string;
  readonly subtype?: string;
  readonly bot_id?: string;
}

export interface FakeSlack extends FakeSource {
  /** The channels and their messages (any order: the fake sorts them). */
  readonly channels: Map<string, SlackMessage[]>;
  /** users.info: user id → profile names. */
  readonly users: Map<string, { readonly name?: string; readonly real_name?: string; readonly display_name?: string }>;
  /** Writes a message now, and returns its ts. */
  post(channel: string, message: Omit<SlackMessage, 'ts'> & { readonly ts?: string }): string;
}

export interface DiscordMessage {
  readonly id: string;
  readonly content: string;
  readonly type?: number;
  readonly author: { readonly id: string; readonly username: string; readonly global_name?: string | null; readonly bot?: boolean };
  readonly webhook_id?: string;
}

export interface FakeDiscord extends FakeSource {
  readonly channels: Map<string, DiscordMessage[]>;
  /** Writes a message now, and returns its id. */
  post(channel: string, message: Omit<DiscordMessage, 'id'> & { readonly id?: string }): string;
}

type Json = Record<string, unknown>;

function compareDigits(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
}

function compareTs(a: string, b: string): number {
  const [as = '', af = ''] = a.split('.');
  const [bs = '', bf = ''] = b.split('.');
  return compareDigits(as, bs) || (af.padEnd(16, '0') < bf.padEnd(16, '0') ? -1 : af.padEnd(16, '0') > bf.padEnd(16, '0') ? 1 : 0);
}

async function startFake(handle: (path: string, params: Record<string, string>, authorization: string | null) => { status: number; headers?: Record<string, string>; body: unknown }, tokenHeader: () => string): Promise<{
  url: string;
  requests: RecordedSourceRequest[];
  forced: ForcedAnswer[];
  close: () => Promise<void>;
}> {
  const requests: RecordedSourceRequest[] = [];
  const forced: ForcedAnswer[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/^\/+/, '');
    const params = Object.fromEntries(url.searchParams.entries());
    const authorization = req.headers['authorization'] ?? null;
    req.resume();
    const next = forced.shift();
    requests.push({ at: Date.now(), path, params, authorized: authorization === tokenHeader(), userAgent: req.headers['user-agent'] ?? null, forced: next !== undefined });
    if (next !== undefined) {
      if ('redirect' in next) {
        res.writeHead(302, { location: next.redirect });
        res.end();
        return;
      }
      if ('bytes' in next) {
        res.writeHead(200, { 'content-type': 'application/json' });
        // No Content-Length: the reader must count the bytes as they come.
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        let left = next.bytes;
        const write = (): void => {
          while (left > 0) {
            const part = left >= chunk.length ? chunk : chunk.subarray(0, left);
            left -= part.length;
            if (!res.write(part)) {
              res.once('drain', write);
              return;
            }
          }
          res.end();
        };
        res.on('error', () => {});
        write();
        return;
      }
      res.writeHead(next.status, { 'content-type': 'application/json', ...next.headers });
      res.end(next.body === undefined ? '' : JSON.stringify(next.body));
      return;
    }
    const answer = handle(path, params, typeof authorization === 'string' ? authorization : null);
    res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    forced,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A fake Slack Web API (`token`: the bot token it takes). */
export async function startFakeSlack(token: string): Promise<FakeSlack> {
  const channels = new Map<string, SlackMessage[]>();
  const users = new Map<string, { readonly name?: string; readonly real_name?: string; readonly display_name?: string }>();
  let clock = Math.floor(Date.now() / 1000) * 1_000_000;
  const fake = await startFake(
    (path, params, authorization) => {
      if (authorization !== `Bearer ${token}`) return { status: 200, body: { ok: false, error: authorization === null ? 'not_authed' : 'invalid_auth' } };
      if (path === 'users.info') {
        const user = users.get(params['user'] ?? '');
        if (user === undefined) return { status: 200, body: { ok: false, error: 'user_not_found' } };
        return { status: 200, body: { ok: true, user: { id: params['user'], name: user.name ?? '', real_name: user.real_name ?? '', profile: { display_name: user.display_name ?? '', real_name: user.real_name ?? '' } } } };
      }
      if (path !== 'conversations.history') return { status: 200, body: { ok: false, error: 'unknown_method' } };
      const all = channels.get(params['channel'] ?? '');
      if (all === undefined) return { status: 200, body: { ok: false, error: 'channel_not_found' } };
      const oldest = params['oldest'] ?? '0';
      const inRange = all.filter((message) => compareTs(message.ts, oldest) > 0).sort((a, b) => compareTs(b.ts, a.ts));
      const limit = Number(params['limit'] ?? '100');
      const offset = Number(params['cursor'] ?? '0');
      const page = inRange.slice(offset, offset + limit);
      const more = offset + limit < inRange.length;
      return { status: 200, body: { ok: true, messages: page.map((message) => ({ type: 'message', ...message })), has_more: more, response_metadata: { next_cursor: more ? String(offset + limit) : '' } } };
    },
    () => `Bearer ${token}`,
  );
  return {
    url: fake.url,
    requests: fake.requests,
    channels,
    users,
    answerNext: (...answers) => fake.forced.push(...answers),
    post: (channel, message) => {
      // A new message is of now (as Slack stamps it), and after every earlier one.
      clock = Math.max(clock + 1_000, Date.now() * 1_000);
      const ts = message.ts ?? `${Math.floor(clock / 1_000_000)}.${String(clock % 1_000_000).padStart(6, '0')}`;
      const list = channels.get(channel) ?? [];
      list.push({ ...message, ts });
      channels.set(channel, list);
      return ts;
    },
    close: fake.close,
  };
}

/** A fake Discord API (`token`: the bot token it takes). */
export async function startFakeDiscord(token: string): Promise<FakeDiscord> {
  const channels = new Map<string, DiscordMessage[]>();
  // Snowflakes of now, one apart.
  let next = (BigInt(Date.now()) - 1_420_070_400_000n) << 22n;
  const fake = await startFake(
    (path, params, authorization) => {
      if (authorization !== `Bot ${token}`) return { status: 401, body: { message: '401: Unauthorized', code: 0 } };
      const match = /^channels\/([0-9]+)\/messages$/.exec(path);
      const all = match === null ? undefined : channels.get(match[1] as string);
      if (all === undefined) return { status: 404, body: { message: 'Unknown Channel', code: 10003 } };
      const limit = Math.min(100, Number(params['limit'] ?? '50'));
      const sorted = [...all].sort((a, b) => compareDigits(a.id, b.id));
      const after = params['after'];
      const page = after === undefined ? sorted.slice(-limit) : sorted.filter((message) => compareDigits(message.id, after) > 0).slice(0, limit);
      // Newest first, as Discord's documentation says the endpoint answers.
      return { status: 200, body: page.reverse().map((message) => ({ type: 0, channel_id: match?.[1], ...message })) as Json[] };
    },
    () => `Bot ${token}`,
  );
  return {
    url: fake.url,
    requests: fake.requests,
    channels,
    answerNext: (...answers) => fake.forced.push(...answers),
    post: (channel, message) => {
      // A new message is of now (as Discord makes its id), and after every earlier one.
      const now = (BigInt(Date.now()) - 1_420_070_400_000n) << 22n;
      next = next + 1n > now ? next + 1n : now;
      const id = message.id ?? String(next);
      const list = channels.get(channel) ?? [];
      list.push({ ...message, id });
      channels.set(channel, list);
      return id;
    },
    close: fake.close,
  };
}
