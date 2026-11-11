// The outside sources of the sticky notes (DESIGN 0.8.0 D6, D4.5's outside budgets): the Slack and Discord channels
// `smurg host` hands over are read from the host's computer, once a minute (a short minute here), and each message of
// a person becomes waiting feedback on the note it names. Against FAKE servers on 127.0.0.1 (fake-sources.ts) with
// fake tokens: no test reaches slack.com or discord.com (ARCHITECTURE §0 rule 2). The real sticky, files and locks
// modules in front of the fake agent runtime; nothing here reaches an agent (an accept is S5's, D4.6).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEEDBACK_TEXT_MAX_CHARS, agentText, type AuditEntry, type Feedback, type PayloadOf, type SourceState } from '@smurg/protocol';
import type { ConnectorsEntry } from '../../src/core/interfaces.ts';
import { EMPTY_CHANNEL_MARGIN_MS } from '../../src/sticky/sources/poll.ts';
import { SOURCE_BODY_MAX_BYTES } from '../../src/sticky/sources/request.ts';
import { createTempRunDir, createTestDaemon, removeTempRunDir, waitFor } from '../../src/testing/index.ts';
import { startFakeDiscord, startFakeSlack, type FakeDiscord, type FakeSlack } from './fake-sources.ts';
import { startNotes, type NotesOptions, type NotesStack } from './support.ts';

/** Fake tokens of each source's form (never a real one). */
const SLACK_TOKEN = 'xoxb-' + '1111111111111-2222222222222-FakeTokenForTestsOnly';
const DISCORD_TOKEN = 'FAKE0discord0token.for-tests_only.0123456789abcdef';
const CHANNEL = 'C0123ABCDE';
const DISCORD_CHANNEL = '123456789012345678';
/** A short minute: a read every 150 ms, the entry looked at every 20 ms. */
const FAST = { readIntervalMs: 150, lookMs: 20 } as const;
const NOTES = { 'notes/Home.md': '# Home\n\n[[Checkout]]\n', 'notes/Checkout.md': '[[Payment form]]\n', 'notes/Payment form.md': '' };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 60_000);

interface Sources {
  readonly s: NotesStack;
  readonly slack: FakeSlack;
  readonly discord: FakeDiscord;
  /** What smurg host hands over from now on. */
  connect(entry: ConnectorsEntry | null): void;
  readonly audit: AuditEntry[];
  /** Every `sticky.changed` Leo (a Viewer) was told that carried the sources. */
  readonly told: SourceState[][];
}

const slackEntry = (over: Partial<NonNullable<ConnectorsEntry['slack']>> = {}): NonNullable<ConnectorsEntry['slack']> => ({ token: SLACK_TOKEN, channel: CHANNEL, connectedAt: 0, ...over });
const discordEntry = (over: Partial<NonNullable<ConnectorsEntry['discord']>> = {}): NonNullable<ConnectorsEntry['discord']> => ({ token: DISCORD_TOKEN, channel: DISCORD_CHANNEL, connectedAt: 0, ...over });

async function fakes(): Promise<{ slack: FakeSlack; discord: FakeDiscord }> {
  const slack = await startFakeSlack(SLACK_TOKEN);
  cleanups.push(() => slack.close());
  const discord = await startFakeDiscord(DISCORD_TOKEN);
  cleanups.push(() => discord.close());
  slack.channels.set(CHANNEL, []);
  discord.channels.set(DISCORD_CHANNEL, []);
  slack.users.set('U0MEI00001', { display_name: 'Mei Chen', real_name: 'Mei C.' });
  slack.users.set('U0LEO00001', { real_name: 'Leo  ​Lin\n' });
  return { slack, discord };
}

async function start(entry: ConnectorsEntry | null, options: Partial<NotesOptions> & { readonly with?: { slack: FakeSlack; discord: FakeDiscord } } = {}): Promise<Sources> {
  const { slack, discord } = options.with ?? (await fakes());
  let handed = entry;
  const s = await startNotes({
    files: NOTES,
    ...options,
    sticky: { ...options.sticky, sources: FAST },
    connectors: () => handed,
    outsideBaseUrls: { slack: slack.url, discord: discord.url },
  });
  const audit: AuditEntry[] = [];
  s.t.ctx.audit.subscribe((item) => audit.push(item));
  const told: SourceState[][] = [];
  s.leo.conn.on('sticky.changed', (payload: PayloadOf<'sticky.changed'>) => {
    if (payload.sources !== undefined) told.push([...payload.sources]);
  });
  return {
    s,
    slack,
    discord,
    connect: (next) => {
      handed = next;
    },
    audit,
    told,
  };
}

/** sticky.json as the daemon last wrote it. */
async function stored(s: NotesStack): Promise<{ cursors: Record<string, { channel: string; after: string }>; feedback: Feedback[] }> {
  return JSON.parse(await readFile(join(s.t.ctx.config.workspaceStateDir, 'sticky.json'), 'utf8')) as { cursors: Record<string, { channel: string; after: string }>; feedback: Feedback[] };
}

const cursorOf = async (s: NotesStack, source: 'slack' | 'discord'): Promise<string | null> => (await stored(s)).cursors[source]?.after ?? null;
const feedback = (s: NotesStack): readonly Feedback[] => s.service.feedback.list({}).feedback;
const states = async (s: NotesStack): Promise<SourceState[]> => [...(await s.leo.conn.request('sticky.list', {})).sources];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Whether the daemon logged `message`, with a field whose value is `value` when given. */
const logged = (s: NotesStack, message: string, value?: string): boolean =>
  s.logs.some((line) => line.message === message && (value === undefined || Object.values(line.fields).includes(value)));

async function firstRead(r: Sources, source: 'slack' | 'discord'): Promise<string> {
  let cursor: string | null = null;
  await waitFor(async () => (cursor = await cursorOf(r.s, source)) !== null, { timeoutMs: 10_000, what: `the first read of ${source}` });
  return cursor as unknown as string;
}

async function feedbackCount(s: NotesStack, count: number, what: string): Promise<void> {
  await waitFor(() => feedback(s).length >= count, { timeoutMs: 10_000, what });
}

describe('the outside sources: Slack and Discord read from the host’s computer (DESIGN 0.8.0 D6)', { timeout: 60_000 }, () => {
  it('Slack: the first read keeps only where the channel is; then each message of a person becomes waiting feedback on Home, named by users.info; bots, events and empty messages are skipped', async () => {
    const { slack, discord } = await fakes();
    slack.post(CHANNEL, { user: 'U0MEI00001', text: 'Written before the connection' });
    slack.post(CHANNEL, { user: 'U0LEO00001', text: 'Also before' });
    const last = slack.post(CHANNEL, { bot_id: 'B0BOT00001', subtype: 'bot_message', text: 'A bot, the newest' });
    const r = await start({ slack: slackEntry() }, { with: { slack, discord } });
    // The first read: one request for the newest message, nothing becomes feedback, the cursor is the newest message.
    expect(await firstRead(r, 'slack')).toBe(last);
    expect(slack.requests[0]).toMatchObject({ path: 'conversations.history', params: { channel: CHANNEL, limit: '1' }, authorized: true });
    await sleep(400);
    expect(feedback(r.s)).toEqual([]);
    expect(feedback(r.s).some((entry) => entry.text === 'Written before the connection')).toBe(false);

    const leoTold: Feedback[] = [];
    r.s.leo.conn.on('sticky.feedback.updated', (payload) => {
      if ('feedback' in payload) leoTold.push(payload.feedback);
    });
    slack.post(CHANNEL, { user: 'U0MEI00001', text: 'Bigger pictures on the checkout page, please.' });
    slack.post(CHANNEL, { bot_id: 'B0BOT00001', subtype: 'bot_message', text: 'Deploy finished' });
    slack.post(CHANNEL, { user: 'U0LEO00001', subtype: 'channel_join', text: '<@U0LEO00001> has joined the channel' });
    slack.post(CHANNEL, { user: 'U0LEO00001', text: '' });
    slack.post(CHANNEL, { user: 'U0LEO00001', text: ' ​ \n ' });
    const newest = slack.post(CHANNEL, { user: 'U0LEO00001', text: 'And a price filter.' });
    await feedbackCount(r.s, 2, 'the two messages of people');
    await waitFor(async () => (await cursorOf(r.s, 'slack')) === newest, { what: 'the cursor at the newest message looked at' });
    expect(feedback(r.s)).toMatchObject([
      { note: 'Home', text: 'Bigger pictures on the checkout page, please.', author: { kind: 'outside', source: 'slack', name: 'Mei Chen', externalId: 'U0MEI00001' }, status: 'waiting' },
      // users.info's real_name, nothing unseen, white space collapsed.
      { note: 'Home', text: 'And a price filter.', author: { kind: 'outside', source: 'slack', name: 'Leo Lin', externalId: 'U0LEO00001' }, status: 'waiting' },
    ]);
    expect(feedback(r.s).every((entry) => entry.cut === undefined && entry.cleaned === undefined)).toBe(true);
    // Every member is told, a Viewer too.
    await waitFor(() => leoTold.length === 2, { what: 'Leo told of both' });
    // Every later read asks for what came after the cursor, with the token, never more often than the minute.
    const history = slack.requests.filter((request) => request.path === 'conversations.history');
    expect(history.slice(1).every((request) => request.params['oldest'] !== undefined && request.params['inclusive'] === 'false' && request.authorized)).toBe(true);
    for (let i = 1; i < history.length; i++) expect((history[i] as { at: number }).at - (history[i - 1] as { at: number }).at).toBeGreaterThanOrEqual(FAST.readIntervalMs - 20);
    // A name is asked for once per person (kept).
    slack.post(CHANNEL, { user: 'U0MEI00001', text: 'One more.' });
    await feedbackCount(r.s, 3, 'the third');
    expect(slack.requests.filter((request) => request.path === 'users.info').map((request) => request.params['user'])).toEqual(['U0MEI00001', 'U0LEO00001']);
    // Audited by the system, with the source and the outside id, and the whole text.
    expect(r.audit.filter((entry) => entry.action === 'sticky.feedback.create')[0]).toMatchObject({
      actor: { kind: 'system' },
      outcome: 'ok',
      detail: { note: 'Home', outsideSource: 'slack', outsideId: 'U0MEI00001', writtenBy: 'Mei Chen', feedback: 'Bigger pictures on the checkout page, please.' },
    });
    expect(await states(r.s)).toEqual([{ source: 'slack', state: 'reading' }]);
    // Nothing reached an agent.
    expect(r.s.fakes.agents.log.of('send')).toEqual([]);
  });

  it('Discord: the first read keeps only where the channel is; then a person’s messages become feedback oldest first, named by their global name or user name; bots, webhooks, joins and empty texts are skipped', async () => {
    const { slack, discord } = await fakes();
    discord.post(DISCORD_CHANNEL, { author: { id: '200000000000000001', username: 'mei' }, content: 'From before the connection' });
    const r = await start({ discord: discordEntry() }, { with: { slack, discord } });
    const cursor = await firstRead(r, 'discord');
    expect(discord.requests[0]).toMatchObject({ path: `channels/${DISCORD_CHANNEL}/messages`, params: { limit: '1' }, authorized: true });
    expect(discord.requests[0]?.userAgent).toMatch(/^DiscordBot \(https:\/\/smurg\.ai, \d+\.\d+\.\d+\)$/);
    expect(feedback(r.s)).toEqual([]);

    discord.post(DISCORD_CHANNEL, { author: { id: '200000000000000001', username: 'mei', global_name: 'Mei Chen' }, content: 'First, about [[Checkout]].' });
    discord.post(DISCORD_CHANNEL, { author: { id: '300000000000000001', username: 'buildbot', bot: true }, content: 'Build passed' });
    discord.post(DISCORD_CHANNEL, { author: { id: '400000000000000001', username: 'hook' }, webhook_id: '400000000000000001', content: 'From a webhook' });
    discord.post(DISCORD_CHANNEL, { author: { id: '200000000000000002', username: 'leo_d' }, type: 7, content: '' });
    discord.post(DISCORD_CHANNEL, { author: { id: '200000000000000002', username: 'leo_d', global_name: null }, content: '' });
    discord.post(DISCORD_CHANNEL, { author: { id: '200000000000000002', username: 'leo_d', global_name: null }, content: 'Second, a reply.', type: 19 });
    await feedbackCount(r.s, 2, 'the two messages of people');
    expect(feedback(r.s)).toMatchObject([
      { note: 'Checkout', text: 'First, about [[Checkout]].', author: { kind: 'outside', source: 'discord', name: 'Mei Chen', externalId: '200000000000000001' } },
      { note: 'Home', text: 'Second, a reply.', author: { kind: 'outside', source: 'discord', name: 'leo_d', externalId: '200000000000000002' } },
    ]);
    const after = discord.requests.slice(1).map((request) => request.params['after']);
    expect(after[0]).toBe(cursor);
    expect(discord.requests.slice(1).every((request) => request.params['limit'] === '100' && request.authorized)).toBe(true);
    expect(r.audit.find((entry) => entry.action === 'sticky.feedback.create')).toMatchObject({ actor: { kind: 'system' }, detail: { outsideSource: 'discord', outsideId: '200000000000000001', writtenBy: 'Mei Chen' } });
  });

  it('a first read of an empty channel starts from now, and so does a channel other than the cursor’s: nothing from before the connection becomes feedback', async () => {
    const { slack, discord } = await fakes();
    slack.channels.set('C0OTHER0001', []);
    slack.post('C0OTHER0001', { user: 'U0MEI00001', text: 'Old in the other channel' });
    const r = await start({ slack: slackEntry(), discord: discordEntry() }, { with: { slack, discord } });
    const slackCursor = await firstRead(r, 'slack');
    const discordCursor = await firstRead(r, 'discord');
    // From now (a minute before the host's now, for a service whose clock is a little behind): a ts, a snowflake.
    const slackAt = Number(slackCursor) * 1000;
    const discordAt = Number((BigInt(discordCursor) >> 22n) + 1_420_070_400_000n);
    for (const at of [slackAt, discordAt]) {
      expect(at).toBeLessThanOrEqual(Date.now() - EMPTY_CHANNEL_MARGIN_MS + 1_000);
      expect(at).toBeGreaterThan(Date.now() - EMPTY_CHANNEL_MARGIN_MS - 30_000);
    }
    // Another channel: its first read, again only where it is.
    r.connect({ slack: slackEntry({ channel: 'C0OTHER0001' }), discord: discordEntry() });
    await waitFor(async () => (await stored(r.s)).cursors['slack']?.channel === 'C0OTHER0001', { what: 'the other channel’s cursor' });
    await sleep(400);
    expect(feedback(r.s)).toEqual([]);
  });

  it('a text over FEEDBACK_TEXT_MAX_CHARS is cut on a code-point boundary and marked cut; Slack’s escapes are decoded first; a cut never leaves a line that passes for a header', async () => {
    const r = await start({ slack: slackEntry(), discord: discordEntry() });
    await firstRead(r, 'slack');
    await firstRead(r, 'discord');
    r.slack.post(CHANNEL, { user: 'U0MEI00001', text: `&lt;b&gt;bold&lt;/b&gt; &amp;amp; ${'x'.repeat(5000)}` });
    const header = '[Ian · Host]';
    r.slack.post(CHANNEL, { user: 'U0MEI00001', text: `${'a'.repeat(FEEDBACK_TEXT_MAX_CHARS - 1 - header.length)}\n${header} said more after it` });
    r.discord.post(DISCORD_CHANNEL, { author: { id: '200000000000000001', username: 'mei' }, content: `${'y'.repeat(FEEDBACK_TEXT_MAX_CHARS - 1)}\u{1F600}z` });
    await feedbackCount(r.s, 3, 'the three long messages');
    const find = (start: string): Feedback => feedback(r.s).find((entry) => entry.text.startsWith(start)) as Feedback;
    const decoded = find('<b>');
    const headerCut = find('aaa');
    const emoji = find('yyy');
    expect(decoded.text.startsWith('<b>bold</b> &amp; xxx')).toBe(true);
    expect(decoded.text).toHaveLength(FEEDBACK_TEXT_MAX_CHARS);
    expect(decoded.cut).toBe(true);
    // The cut fell right after the header look-alike: it is cut shorter instead, and what is kept is clean text.
    expect(headerCut.cut).toBe(true);
    expect(headerCut.text.length).toBeLessThanOrEqual(FEEDBACK_TEXT_MAX_CHARS);
    expect(agentText(headerCut.text).text).toBe(headerCut.text);
    expect(headerCut.text.split('\n').at(-1)).not.toBe(header);
    // The emoji would have been cut in half: it goes whole.
    expect(emoji.text).toBe('y'.repeat(FEEDBACK_TEXT_MAX_CHARS - 1));
    expect(emoji.cut).toBe(true);
  });

  it('the note is the first [[Name]] that names a sticky note of the index, as it is spelled on disk; a link in code, or none, is Home', async () => {
    const r = await start({ slack: slackEntry() });
    await firstRead(r, 'slack');
    r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'See [[Missing]], then [[payment form]], then [[Checkout]].' });
    r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'Only `[[Checkout]]` in code.' });
    r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'No link at all.' });
    await feedbackCount(r.s, 3, 'three');
    expect(feedback(r.s).map((entry) => entry.note)).toEqual(['Payment form', 'Home', 'Home']);
  });

  it('with no sticky note Home, a message that names no note is dropped and counted (its cursor moves on); one that names a note is kept', async () => {
    const r = await start({ slack: slackEntry() }, { files: { 'notes/Checkout.md': '' } });
    await firstRead(r, 'slack');
    r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'For nobody: there is no Home.' });
    const named = r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'About [[checkout]].' });
    await feedbackCount(r.s, 1, 'the one with a note');
    await waitFor(async () => (await cursorOf(r.s, 'slack')) === named, { what: 'the cursor past both' });
    expect(feedback(r.s)).toMatchObject([{ note: 'Checkout', text: 'About [[checkout]].' }]);
    expect(r.s.service.sources.droppedWithoutHome()).toBe(1);
    expect(logged(r.s, 'an outside message was dropped: there is no sticky note Home')).toBe(true);
    await sleep(400);
    expect(r.s.service.sources.droppedWithoutHome()).toBe(1);
  });

  it('a message written before the channel was connected (its connectedAt) is looked at and never taken, also when the cursor is older', async () => {
    const r = await start({ slack: slackEntry() });
    await firstRead(r, 'slack');
    // Disconnected and connected again later: what was written in between is from before this connection.
    const old = r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'While it was not connected.' });
    r.connect({ slack: slackEntry({ connectedAt: Date.now() + 5_000 }) });
    await waitFor(async () => (await cursorOf(r.s, 'slack')) === old, { what: 'the old message looked at' });
    const later = `${Math.floor((Date.now() + 10_000) / 1000)}.000100`;
    r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'After the connection.', ts: later });
    await feedbackCount(r.s, 1, 'the later one');
    expect(feedback(r.s).map((entry) => entry.text)).toEqual(['After the connection.']);
  });

  it('a cursor survives a restart: the next start reads on after it, never a first read again, and nothing is taken twice', async () => {
    const stateDir = await createTempRunDir();
    cleanups.push(() => removeTempRunDir(stateDir));
    const both = await fakes();
    const workspaceId = 'ws_test_restart_sources';
    const first = await start({ slack: slackEntry(), discord: discordEntry() }, { with: both, stateDir, workspaceId });
    await firstRead(first, 'slack');
    await firstRead(first, 'discord');
    both.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'Before the restart (Slack).' });
    both.discord.post(DISCORD_CHANNEL, { author: { id: '200000000000000001', username: 'mei' }, content: 'Before the restart (Discord).' });
    await feedbackCount(first.s, 2, 'both before the restart');
    await first.s.t.daemon.stop('test restart');
    // Written while the host was stopped: read by the next start.
    both.slack.post(CHANNEL, { user: 'U0LEO00001', text: 'While stopped (Slack).' });
    both.discord.post(DISCORD_CHANNEL, { author: { id: '200000000000000002', username: 'leo_d' }, content: 'While stopped (Discord).' });
    const slackBefore = both.slack.requests.length;
    const discordBefore = both.discord.requests.length;
    const second = await start({ slack: slackEntry(), discord: discordEntry() }, { with: both, stateDir, workspaceId, root: first.s.root });
    await feedbackCount(second.s, 4, 'the two written while stopped');
    // (The two sources are read side by side: their order among each other is the order the reads ended in.)
    expect(feedback(second.s).map((entry) => entry.text).sort()).toEqual(['Before the restart (Discord).', 'Before the restart (Slack).', 'While stopped (Discord).', 'While stopped (Slack).']);
    expect(both.slack.requests.slice(slackBefore).filter((request) => request.path === 'conversations.history').every((request) => request.params['oldest'] !== undefined)).toBe(true);
    expect(both.discord.requests.slice(discordBefore).every((request) => request.params['after'] !== undefined)).toBe(true);
    await sleep(400);
    expect(feedback(second.s)).toHaveLength(4);
    // Stopped before the state dir is removed (this file's cleanups run before the stack's).
    await second.s.t.daemon.stop('test end');
  });

  it('a 429 is honoured: no request before its Retry-After (and the body’s retry_after for Discord) has passed, and the source keeps reading', async () => {
    const r = await start({ slack: slackEntry(), discord: discordEntry() });
    await firstRead(r, 'slack');
    await firstRead(r, 'discord');
    r.slack.answerNext({ status: 429, headers: { 'retry-after': '1' }, body: { ok: false, error: 'ratelimited' } });
    r.discord.answerNext({ status: 429, headers: { 'retry-after': '1' }, body: { message: 'You are being rate limited.', retry_after: 1.4, global: false } });
    const slackAt = r.slack.requests.length;
    const discordAt = r.discord.requests.length;
    r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'After a wait (Slack).' });
    r.discord.post(DISCORD_CHANNEL, { author: { id: '200000000000000001', username: 'mei' }, content: 'After a wait (Discord).' });
    await feedbackCount(r.s, 2, 'both after their wait');
    const limitedSlack = r.slack.requests.findIndex((request, index) => index >= slackAt && request.forced);
    const nextSlack = r.slack.requests[limitedSlack + 1] as { at: number };
    expect(nextSlack.at - (r.slack.requests[limitedSlack] as { at: number }).at).toBeGreaterThanOrEqual(1_000 - 30);
    const limitedDiscord = r.discord.requests.findIndex((request, index) => index >= discordAt && request.forced);
    const nextDiscord = r.discord.requests[limitedDiscord + 1] as { at: number };
    expect(nextDiscord.at - (r.discord.requests[limitedDiscord] as { at: number }).at).toBeGreaterThanOrEqual(1_400 - 30);
    // A wait is no failure: the state stayed `reading`.
    expect(r.told.flat().some((state) => state.state === 'failing')).toBe(false);
    expect(await states(r.s)).toEqual([
      { source: 'slack', state: 'reading' },
      { source: 'discord', state: 'reading' },
    ]);
  });

  it('a token the service refuses, and a channel the bot may not read, are `failing` with their own text, told to every member; a read that goes through again is `reading`', async () => {
    const r = await start({ slack: slackEntry({ token: 'xoxb-' + '1111111111111-2222222222222-NotTheRightOne' }), discord: discordEntry({ token: 'NOT0the0right.discord-token_0123456789' }) });
    await waitFor(async () => (await states(r.s)).every((state) => state.state === 'failing'), { what: 'both failing' });
    const failing = await states(r.s);
    expect(failing.map((state) => [state.source, state.problem?.text.id])).toEqual([
      ['slack', 'sticky.source.tokenRefused'],
      ['discord', 'sticky.source.tokenRefused'],
    ]);
    expect(failing[0]?.problem?.fallback).toBe('The bot token was refused. Connect the channel again with smurg connect and a bot token that works.');
    expect(r.slack.requests.every((request) => !request.authorized)).toBe(true);
    // Connected again with the right tokens, but the bot is in no such channel: no access.
    r.slack.channels.delete(CHANNEL);
    r.connect({ slack: slackEntry(), discord: discordEntry({ channel: '999999999999999999' }) });
    await waitFor(async () => (await states(r.s)).every((state) => state.problem?.text.id === 'sticky.source.noAccess'), { what: 'no access, both' });
    // Every member is told each change (Leo, a Viewer, connected after the start: from the reconnection on).
    await waitFor(() => r.told.some((told) => told.every((state) => state.problem?.text.id === 'sticky.source.noAccess')), { what: 'Leo told' });
    // The bot added to the channel: the next read goes through (a first read) and the source reads.
    r.slack.channels.set(CHANNEL, []);
    r.slack.answerNext({ status: 200, body: { ok: false, error: 'not_in_channel' } });
    await waitFor(async () => (await states(r.s))[0]?.state === 'reading', { timeoutMs: 10_000, what: 'Slack reading again' });
    expect((await states(r.s))[0]).toEqual({ source: 'slack', state: 'reading' });
    expect(logged(r.s, 'outside source not read', 'not_in_channel')).toBe(true);
  });

  it('a redirect is refused: the token never follows it, the other server gets no request, and the source is `failing` (an answer that could not be read)', async () => {
    const other = await startFakeSlack(SLACK_TOKEN);
    cleanups.push(() => other.close());
    other.channels.set(CHANNEL, []);
    const r = await start({ slack: slackEntry() });
    await firstRead(r, 'slack');
    r.slack.answerNext({ redirect: `${other.url}/conversations.history?channel=${CHANNEL}` });
    await waitFor(async () => (await states(r.s))[0]?.state === 'failing', { what: 'failing after the redirect' });
    expect((await states(r.s))[0]?.problem?.text.id).toBe('sticky.source.badAnswer');
    await sleep(300);
    expect(other.requests).toEqual([]);
    expect(logged(r.s, 'outside source not read', 'redirect')).toBe(true);
    // The next read is the service's own again.
    await waitFor(async () => (await states(r.s))[0]?.state === 'reading', { what: 'reading again' });
  });

  it('a body over the cap is refused unread: no feedback, the cursor stays, and the next read asks for fewer messages', async () => {
    const r = await start({ slack: slackEntry() });
    const cursor = await firstRead(r, 'slack');
    r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'Behind a large answer.' });
    r.slack.answerNext({ bytes: SOURCE_BODY_MAX_BYTES + 1 });
    await waitFor(async () => (await states(r.s))[0]?.state === 'failing', { what: 'failing after the large answer' });
    expect((await states(r.s))[0]?.problem?.text.id).toBe('sticky.source.badAnswer');
    expect(await cursorOf(r.s, 'slack')).toBe(cursor);
    await feedbackCount(r.s, 1, 'the message, by the next read');
    const large = r.slack.requests.findIndex((request) => request.forced);
    expect(r.slack.requests[large]?.params['limit']).toBe('100');
    expect(r.slack.requests[large + 1]?.params['limit']).toBe('50');
  });

  it('nothing is requested while no channel is connected; a source connected while the host shares is read and told; disconnected, it is told gone and asked nothing more', async () => {
    const r = await start(null);
    await sleep(500);
    expect(r.slack.requests).toEqual([]);
    expect(r.discord.requests).toEqual([]);
    expect(await states(r.s)).toEqual([]);
    r.connect({ slack: slackEntry() });
    await firstRead(r, 'slack');
    expect(r.told[0]).toEqual([{ source: 'slack', state: 'reading' }]);
    expect(await states(r.s)).toEqual([{ source: 'slack', state: 'reading' }]);
    expect(r.discord.requests).toEqual([]);
    r.connect(null);
    await waitFor(() => r.told.at(-1)?.length === 0, { what: 'told the source is gone' });
    const asked = r.slack.requests.length;
    await sleep(500);
    expect(r.slack.requests).toHaveLength(asked);
    expect(await states(r.s)).toEqual([]);
  });

  it('a channel id that fails its pattern, and a token of another form, are `failing` before anything is fetched: the fake servers get no request', async () => {
    const r = await start({ slack: slackEntry({ channel: 'C0123/../x' }), discord: discordEntry({ channel: '12345678901234567a' }) });
    await waitFor(async () => (await states(r.s)).length === 2, { what: 'both told' });
    expect((await states(r.s)).map((state) => [state.source, state.state, state.problem?.text.id])).toEqual([
      ['slack', 'failing', 'sticky.source.channelInvalid'],
      ['discord', 'failing', 'sticky.source.channelInvalid'],
    ]);
    // A person's token, and a token with a line break in it.
    r.connect({ slack: slackEntry({ token: 'xoxp-' + '1111111111111-2222222222222-APersonsToken' }), discord: discordEntry({ token: `${DISCORD_TOKEN}\r\nX-Other: 1` }) });
    await waitFor(async () => (await states(r.s)).every((state) => state.problem?.text.id === 'sticky.source.tokenInvalid'), { what: 'both tokens refused' });
    await sleep(400);
    expect(r.slack.requests).toEqual([]);
    expect(r.discord.requests).toEqual([]);
    expect((await stored(r.s)).cursors).toEqual({});
  });

  it('the outside budgets (D4.5): a person whose budget is full stops the read at their message until they have room; while the budget of everyone outside is full no request is made', async () => {
    const r = await start({ slack: slackEntry(), discord: discordEntry() }, { sticky: { feedbackLimits: { waitingPerOutsider: 2, waitingFromOutside: 3 } } });
    await firstRead(r, 'slack');
    await firstRead(r, 'discord');
    r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'a1' });
    const a2 = r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'a2' });
    r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'a3' });
    r.slack.post(CHANNEL, { user: 'U0LEO00001', text: 'b1' });
    await waitFor(async () => (await states(r.s))[0]?.state === 'waiting-for-room', { what: 'Slack waiting for room' });
    expect(feedback(r.s).map((entry) => entry.text)).toEqual(['a1', 'a2']);
    // The read stopped at a3: the cursor is a2, and b1 waits behind it.
    expect(await cursorOf(r.s, 'slack')).toBe(a2);
    const asked = r.slack.requests.length;
    await sleep(500);
    // While Mei has her 2, nothing is asked of Slack (the next message is hers).
    expect(r.slack.requests).toHaveLength(asked);
    expect(r.told.flat().some((state) => state.source === 'slack' && state.state === 'waiting-for-room')).toBe(true);
    // One of hers is rejected: room; the read goes on from a3.
    const a1 = feedback(r.s)[0] as Feedback;
    await r.s.mei.conn.request('sticky.feedback.reject', { feedbackId: a1.id });
    await waitFor(() => feedback(r.s).filter((entry) => entry.status === 'waiting').length === 3, { what: 'a3 and b1' });
    expect(feedback(r.s).filter((entry) => entry.status === 'waiting').map((entry) => entry.text)).toEqual(['a2', 'a3', 'b1']);
    await waitFor(async () => (await states(r.s))[0]?.state === 'reading', { what: 'Slack reading' });
    // Three wait from outside: everyone's budget is full. Discord asks nothing while it is.
    const discordAsked = r.discord.requests.length;
    r.discord.post(DISCORD_CHANNEL, { author: { id: '200000000000000009', username: 'zoe' }, content: 'z1' });
    await waitFor(async () => (await states(r.s))[1]?.state === 'waiting-for-room', { what: 'Discord waiting for room' });
    await sleep(400);
    expect(r.discord.requests.length).toBeLessThanOrEqual(discordAsked + 1);
    const stopped = r.discord.requests.length;
    await sleep(400);
    expect(r.discord.requests).toHaveLength(stopped);
    expect(feedback(r.s).some((entry) => entry.text === 'z1')).toBe(false);
    // Room again: Discord reads z1.
    await r.s.mei.conn.request('sticky.feedback.reject', { feedbackId: (feedback(r.s).find((entry) => entry.text === 'b1') as Feedback).id });
    await waitFor(() => feedback(r.s).some((entry) => entry.text === 'z1'), { what: 'z1 read' });
    // Members' feedback is not counted against the outside budgets (nor the other way round).
    await r.s.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'A Viewer still gives feedback.' });
  });

  it('a token is in no log line, no audit entry, no state file and nothing a member is told, whatever happened to the reads', async () => {
    const r = await start({ slack: slackEntry(), discord: discordEntry() });
    await firstRead(r, 'slack');
    await firstRead(r, 'discord');
    r.slack.answerNext({ status: 429, headers: { 'retry-after': '0' }, body: { ok: false, error: 'ratelimited' } }, { redirect: `${r.slack.url}/x` }, { status: 500, body: {} });
    r.discord.answerNext({ status: 500, body: {} }, { bytes: SOURCE_BODY_MAX_BYTES + 10 });
    r.slack.post(CHANNEL, { user: 'U0MEI00001', text: 'Kept' });
    r.discord.post(DISCORD_CHANNEL, { author: { id: '200000000000000001', username: 'mei' }, content: 'Kept too' });
    await feedbackCount(r.s, 2, 'both');
    const wrong = 'xoxb-' + '1111111111111-2222222222222-NotTheRightOne';
    r.connect({ slack: slackEntry({ token: wrong }), discord: discordEntry({ channel: 'x/../y' }) });
    await waitFor(async () => (await states(r.s))[0]?.state === 'failing', { what: 'failing' });
    const told: unknown[] = [];
    r.s.leo.conn.on('sticky.changed', (payload) => told.push(payload));
    told.push(await r.s.leo.conn.request('sticky.list', {}), await r.s.leo.conn.request('sticky.feedback.list', {}));
    await r.s.t.daemon.stop('test end');
    const stateDir = r.s.t.ctx.config.workspaceStateDir;
    const files = await Promise.all((await readdir(stateDir)).filter((name) => name.endsWith('.json') || name.endsWith('.jsonl')).map((name) => readFile(join(stateDir, name), 'utf8')));
    const everything = [JSON.stringify(r.s.logs), JSON.stringify(r.audit), JSON.stringify(told), ...files].join('\n');
    expect(files.length).toBeGreaterThan(2);
    for (const secret of [SLACK_TOKEN, DISCORD_TOKEN, wrong, 'FakeTokenForTestsOnly', 'NotTheRightOne']) expect(everything.includes(secret), secret).toBe(false);
    // And the environment holds none (what agent sessions inherit, besides the file).
    expect(Object.values(process.env).some((value) => value?.includes('FakeTokenForTestsOnly') === true)).toBe(false);
  });

  it('a base URL other than https, or http on 127.0.0.1, is refused before the daemon starts: a token never goes anywhere else', async () => {
    for (const slack of ['http://example.com', 'http://127.0.0.1.example.com', 'ftp://127.0.0.1', 'https://user:pw@slack.example', 'not a url']) {
      await expect(createTestDaemon({ outsideBaseUrls: { slack } }), slack).rejects.toThrow(/base URL/);
    }
    await expect(createTestDaemon({ outsideBaseUrls: { discord: 'http://localhost:1' } })).rejects.toThrow(/base URL/);
  });
});
