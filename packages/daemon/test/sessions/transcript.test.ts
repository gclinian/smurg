// The conversation log on disk (DESIGN §2.4): append-only JSONL segments, THE page rule, redaction, trimming, a torn
// last line, private files.
import { appendFile, lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS_PAGE_MAX, EVENTS_PAGE_MAX_BYTES, conversationEventSchema, encodedSize, lineEvent, noticeEvent, type ConversationEventInput } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { Transcript } from '../../src/sessions/agent/transcript.ts';
import { createTempDir, removeTempDir } from '../../src/testing/index.ts';

let scratch: string | null = null;
afterEach(async () => {
  if (scratch) await removeTempDir(scratch);
  scratch = null;
});

const OPTIONS = { segmentBytes: 8 * 1024 * 1024, flushMs: 5, flushBytes: 64 * 1024 };
const text = (n: number, size = 10): ConversationEventInput => ({ kind: 'text', turnId: 't_1', blockId: `b_${n}`, text: `${n}:`.padEnd(size, 'x') });

async function open(options: Partial<typeof OPTIONS> = {}): Promise<{ dir: string; transcript: Transcript }> {
  scratch ??= await createTempDir('transcript');
  const dir = join(scratch, 'log');
  return { dir, transcript: await Transcript.open(dir, { ...OPTIONS, ...options }) };
}

describe('the conversation log', () => {
  it('seq starts at 1 without gaps, events are one JSON line each with v: 1, files are private, and a reopened log continues where it stopped', async () => {
    const { dir, transcript } = await open();
    expect(transcript.lastSeq).toBe(0);
    expect((await transcript.page({ newest: true })).events).toEqual([]);
    const first = transcript.append(lineEvent(msg('conversation.started.free', { name: 'Ian' })), 1_000);
    transcript.append(text(2), 1_001);
    transcript.append({ kind: 'card', card: 'question', id: 'q_1' }, 1_002, true);
    expect(first).toMatchObject({ seq: 1, at: 1_000, kind: 'line' });
    // Readable before anything reached the disk.
    expect((await transcript.page({ newest: true })).events.map((event) => event.seq)).toEqual([1, 2, 3]);
    await transcript.flush();
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect(await readdir(dir)).toEqual(['events-000001.jsonl']);
    expect((await lstat(join(dir, 'events-000001.jsonl'))).mode & 0o777).toBe(0o600);
    const lines = (await readFile(join(dir, 'events-000001.jsonl'), 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => [line['v'], line['seq'], line['kind']])).toEqual([[1, 1, 'line'], [1, 2, 'text'], [1, 3, 'card']]);
    const page = await transcript.page({ newest: true });
    expect(page).toMatchObject({ firstSeq: 1, nextSeq: 4, hasEarlier: false, hasMore: false, cardRefs: [{ kind: 'question', id: 'q_1' }] });
    expect(page.bytes).toBe(encodedSize(page.events));
    for (const event of page.events) expect(conversationEventSchema.safeParse(event).success).toBe(true);
    await transcript.close();
    const again = await Transcript.open(dir, OPTIONS);
    expect(again.lastSeq).toBe(3);
    expect(again.append(text(4), 2_000).seq).toBe(4);
    expect((await again.page({ after: 2 })).events.map((event) => event.seq)).toEqual([3, 4]);
    await again.close();
  });

  it('THE page rule: at most `limit` (≤ 500) events and 2 MiB, at least one; after / before / newest; hasEarlier and hasMore, also for an empty page', async () => {
    const { transcript } = await open();
    for (let n = 1; n <= 1_200; n++) transcript.append(text(n), n);
    const newest = await transcript.page({ newest: true });
    expect(newest.events).toHaveLength(EVENTS_PAGE_MAX);
    expect(newest).toMatchObject({ firstSeq: 701, nextSeq: 1_201, hasEarlier: true, hasMore: false });
    const after = await transcript.page({ after: 100 }, 50);
    expect(after.events.map((event) => event.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 101 + i));
    expect(after).toMatchObject({ hasEarlier: true, hasMore: true });
    const before = await transcript.page({ before: 11 }, 500);
    expect(before.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(before).toMatchObject({ hasEarlier: false, hasMore: true });
    // An empty page asked with `after`: events exist at or before it; asked with `before`: at or after it.
    expect(await transcript.page({ after: 1_200 })).toMatchObject({ events: [], firstSeq: 0, nextSeq: 1_201, hasEarlier: true, hasMore: false });
    expect(await transcript.page({ before: 1 })).toMatchObject({ events: [], firstSeq: 0, hasEarlier: false, hasMore: true });
    expect((await transcript.page({ after: 0 }, 5_000)).events).toHaveLength(EVENTS_PAGE_MAX);
    // Bytes: large events close a page early, but one event always fits.
    const big = await open();
    scratch = scratch as string;
    const large = await Transcript.open(join(scratch, 'big'), OPTIONS);
    for (let n = 1; n <= 12; n++) large.append(text(n, 250 * 1024), n);
    const bounded = await large.page({ after: 0 });
    expect(bounded.events.length).toBeGreaterThanOrEqual(1);
    expect(bounded.events.length).toBeLessThan(12);
    expect(bounded.bytes).toBeLessThanOrEqual(EVENTS_PAGE_MAX_BYTES);
    expect(bounded.hasMore).toBe(true);
    const tail = await large.page({ newest: true });
    expect(tail.events.at(-1)?.seq).toBe(12);
    expect(tail.hasEarlier).toBe(true);
    await large.close();
    await big.transcript.close();
    await transcript.close();
  });

  it('a new segment starts when the current one is full; paging crosses segments; get() finds one event', async () => {
    const { dir, transcript } = await open({ segmentBytes: 2_000 });
    for (let n = 1; n <= 60; n++) transcript.append(text(n, 100), n);
    await transcript.flush();
    const files = (await readdir(dir)).sort();
    expect(files.length).toBeGreaterThan(3);
    expect(files[0]).toBe('events-000001.jsonl');
    expect((await transcript.page({ after: 0 }, 500)).events.map((event) => event.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect((await transcript.page({ before: 31 }, 5)).events.map((event) => event.seq)).toEqual([26, 27, 28, 29, 30]);
    expect(await transcript.get(17)).toMatchObject({ seq: 17, kind: 'text' });
    expect(await transcript.get(61)).toBeNull();
    await transcript.close();
    // Reopened: the first seq of every segment is known from its first line.
    const again = await Transcript.open(dir, { ...OPTIONS, segmentBytes: 2_000 });
    expect(again.lastSeq).toBe(60);
    expect((await again.page({ after: 20 }, 3)).events.map((event) => event.seq)).toEqual([21, 22, 23]);
    await again.close();
  });

  it('redaction rewrites the one segment with the event replaced under the same seq and time; nothing else changes', async () => {
    const { dir, transcript } = await open({ segmentBytes: 1_500 });
    for (let n = 1; n <= 30; n++) transcript.append(text(n, 100), 1_000 + n);
    await transcript.flush();
    const before = new Map<string, string>();
    for (const name of await readdir(dir)) before.set(name, await readFile(join(dir, name), 'utf8'));
    const replaced = await transcript.redact(7, noticeEvent('info', msg('conversation.redacted')));
    expect(replaced).toMatchObject({ seq: 7, at: 1_007, kind: 'notice', text: { id: 'conversation.redacted' } });
    expect(await transcript.get(7)).toEqual(replaced);
    expect(await transcript.redact(999, noticeEvent('info', msg('conversation.redacted')))).toBeNull();
    let changed = 0;
    for (const name of await readdir(dir)) {
      const now = await readFile(join(dir, name), 'utf8');
      if (now !== before.get(name)) changed += 1;
      expect(now).not.toContain('"7:xxxx');
      expect((await lstat(join(dir, name))).mode & 0o777).toBe(0o600);
    }
    expect(changed).toBe(1);
    expect((await readdir(dir)).some((name) => name.endsWith('.tmp'))).toBe(false);
    // The log goes on after it, and a reopened log has the replacement.
    expect(transcript.append(text(31), 2_000).seq).toBe(31);
    await transcript.close();
    const again = await Transcript.open(dir, { ...OPTIONS, segmentBytes: 1_500 });
    expect(await again.get(7)).toEqual(replaced);
    expect(again.lastSeq).toBe(31);
    await again.close();
  });

  it('trimming unlinks the oldest whole segments, never the newest and never one that holds a protected seq; the page then starts at what is kept', async () => {
    const { dir, transcript } = await open({ segmentBytes: 1_500 });
    for (let n = 1; n <= 40; n++) transcript.append(text(n, 100), n);
    await transcript.flush();
    const segments = (await readdir(dir)).length;
    expect(await transcript.trim(transcript.bytes, [])).toBe(false);
    // Seq 12 is the event of an open card: its segment and everything after it stay.
    expect(await transcript.trim(1, [12])).toBe(true);
    const kept = (await transcript.page({ after: 0 }, 500)).events.map((event) => event.seq);
    expect(kept[0]).toBeLessThanOrEqual(12);
    expect(kept[0]).toBeGreaterThan(1);
    expect(kept.at(-1)).toBe(40);
    expect((await readdir(dir)).length).toBeLessThan(segments);
    expect(await transcript.page({ before: kept[0] as number })).toMatchObject({ events: [], hasEarlier: false });
    expect(await transcript.trim(1, [])).toBe(true);
    expect((await readdir(dir)).length).toBe(1);
    expect(transcript.append(text(41), 41).seq).toBe(41);
    await transcript.close();
  });

  it('a torn last line (the daemon died mid-write) is dropped at open; a line that is not an event is skipped', async () => {
    const { dir, transcript } = await open();
    transcript.append(text(1), 1);
    transcript.append(text(2), 2);
    await transcript.close();
    await appendFile(join(dir, 'events-000001.jsonl'), '{"v":1,"seq":3,"at":3,"kind":"text","turnId":"t_1","blo');
    const again = await Transcript.open(dir, OPTIONS);
    expect(again.lastSeq).toBe(2);
    expect(again.append(text(3), 3).seq).toBe(3);
    await again.flush();
    await appendFile(join(dir, 'events-000001.jsonl'), 'garbage that is a whole line\n');
    await again.close();
    const third = await Transcript.open(dir, OPTIONS);
    expect((await third.page({ after: 0 })).events.map((event) => event.seq)).toEqual([1, 2, 3]);
    await third.remove();
    await expect(lstat(dir)).rejects.toThrow();
  });
});
