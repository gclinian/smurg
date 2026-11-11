// "Build this" (DESIGN 0.8.0 D5): `sticky.spec` composes, as the caller, the text a topic's spec would be made of (the
// note and the notes it links to directly, decoded as doc.open decodes them, within 256 KiB), and `sticky.build`
// composes it again, refuses another hash, checks what it can before anything is made, then makes a REAL topic (the
// topics module, its discussion started by the fake agent runtime), records the build, writes SPEC.md and a PLAN.md of
// one work item through the real file service as the caller, and starts nothing.
import { createHash } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  NOTE_BUILDS_MAX,
  NOTE_INFO_BUILDS_MAX,
  NOTE_MAX_BYTES,
  SPEC_FROM_NOTES_MAX_BYTES,
  SmurgError,
  TOPICS_MAX,
  TOPIC_SLUG_MAX_CHARS,
  TOPIC_SLUG_PATTERN,
  type AuditEntry,
  type NoteBuild,
} from '@smurg/protocol';
import { render } from '@smurg/protocol/i18n';
import type { Principal } from '../../src/core/interfaces.ts';
import { TEST_HOST_USER, waitFor } from '../../src/testing/index.ts';
import { BUILD_ITEM_ID, BUILD_SLUG_SUFFIX_MAX, buildPlanText, composeSpecFromNotes, freeSlug } from '../../src/sticky/build.ts';
import { STICKY_DOCUMENT, initialStickyDocument, stickyDocumentSchema } from '../../src/sticky/store.ts';
import { parsePlan } from '../../src/topics/plan-format.ts';
import { AMY, LEO, MEI, startNotes, type NotesStack } from './support.ts';

const refused = (promise: Promise<unknown>): Promise<SmurgError> =>
  promise.then(
    () => {
      throw new Error('the request was not refused');
    },
    (err: unknown) => err as SmurgError,
  );

const sha256 = (text: string): string => createHash('sha256').update(new TextEncoder().encode(text)).digest('hex');
const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const withBom = (text: string): Uint8Array => new Uint8Array([...BOM, ...new TextEncoder().encode(text)]);

const NOTES = {
  // CRLF line ends, a link in a code span (not followed), a link to a note not written, a link back to itself.
  'notes/Checkout.md': 'Coupons are checked at the till.\r\nSee [[Payment form]] and [[Refunds]], back to [[checkout]].\r\n`[[Hidden]]` is code.\r\n\r\n',
  // A byte order mark.
  'notes/Payment form.md': withBom('Card or cash.\n'),
  'notes/Hidden.md': 'Not linked.\n',
  'notes/Home.md': '- [[Checkout]]\n',
};

/** The text of Checkout's spec, word for word (D5.1). */
const CHECKOUT_SPEC = [
  'Built from the sticky note "notes/Checkout.md".',
  '',
  'Coupons are checked at the till.',
  'See [[Payment form]] and [[Refunds]], back to [[checkout]].',
  '`[[Hidden]]` is code.',
  '',
  '## Linked sticky note "notes/Payment form.md"',
  '',
  'Card or cash.',
  '',
  '## Linked sticky note "notes/Refunds.md"',
  '',
  'This sticky note is not written yet.',
  '',
  'Other sticky notes are not part of this spec.',
  '',
].join('\n');

async function notes(options: Parameters<typeof startNotes>[0] = {}): Promise<NotesStack> {
  return startNotes({ topics: true, files: NOTES, ...options });
}

async function audit(s: NotesStack, action: string): Promise<AuditEntry[]> {
  const { entries } = await s.host.conn.request('admin.audit.query', { limit: 500 });
  return entries.filter((entry) => entry.action === action).reverse();
}

async function stored(s: NotesStack): Promise<readonly NoteBuild[]> {
  return (await s.t.ctx.state.document(STICKY_DOCUMENT, stickyDocumentSchema, initialStickyDocument)).get().builds;
}

function principal(s: NotesStack, userId: string): Principal {
  return s.t.ctx.members.principalOf(userId) as Principal;
}

async function build(s: NotesStack, note = 'Checkout'): Promise<string> {
  const { hash } = await s.mei.conn.request('sticky.spec', { note });
  return (await s.mei.conn.request('sticky.build', { note, hash })).topicId;
}

describe('sticky.spec: the text a spec would be made of (D5.1)', { timeout: 60_000 }, () => {
  it('is composed word for word from the note and the notes it links to, read as the caller and decoded as doc.open decodes them (CRLF, a byte order mark, a linked note not written)', async () => {
    const s = await notes();
    const spec = await s.mei.conn.request('sticky.spec', { note: 'Checkout' });
    expect(spec.text).toBe(CHECKOUT_SPEC);
    expect(spec.hash).toBe(sha256(CHECKOUT_SPEC));
    // The names whose text is in it: the note first; a link back to itself, a note not written and a link in code are not.
    expect(spec.notes).toEqual(['Checkout', 'Payment form']);
    // Asked in another spelling, it is the same note (D1.3); the host reads the same text.
    expect(await s.host.conn.request('sticky.spec', { note: 'checkout' })).toEqual(spec);
    // The pure function says the same.
    expect(composeSpecFromNotes({ name: 'Checkout', text: 'Coupons are checked at the till.\nSee [[Payment form]] and [[Refunds]], back to [[checkout]].\n`[[Hidden]]` is code.\n\n' }, [{ name: 'Payment form', text: 'Card or cash.\n' }, { name: 'Refunds', missing: true }])).toBe(CHECKOUT_SPEC);
  });

  it('an empty note says so, a path with a double quote is a JSON string, and a note that links to nothing ends at once', async () => {
    const s = await notes({ files: { ...NOTES, 'notes/Q "quoted".md': '', 'notes/Alone.md': 'Just this.' } });
    expect((await s.mei.conn.request('sticky.spec', { note: 'Q "quoted"' })).text).toBe('Built from the sticky note "notes/Q \\"quoted\\".md".\n\nThis sticky note is empty.\n\nOther sticky notes are not part of this spec.\n');
    expect((await s.mei.conn.request('sticky.spec', { note: 'Alone' })).text).toBe('Built from the sticky note "notes/Alone.md".\n\nJust this.\n\nOther sticky notes are not part of this spec.\n');
  });

  it('a note the index does not hold is not_found; a linked note larger than 64 KiB or one that cannot be read is refused by its name, and nothing of a file a link leads to is shown', async () => {
    const s = await notes({
      files: { ...NOTES, '.envrc': 'export TOKEN=secret-of-the-host\n', 'notes/Big.md': 'b'.repeat(NOTE_MAX_BYTES + 1), 'notes/Broken.md': Uint8Array.of(0xff, 0xfe, 0x41), 'notes/A.md': 'See [[Big]].', 'notes/B.md': 'See [[Secret]].', 'notes/C.md': 'See [[Broken]].', 'notes/D.md': 'See [[Twin]].' },
      prepare: async (root) => {
        await symlink(join(root, '.envrc'), join(root, 'notes', 'Secret.md'));
        await link(join(root, '.envrc'), join(root, 'notes', 'Twin.md'));
      },
    });
    expect(await refused(s.mei.conn.request('sticky.spec', { note: 'Nowhere' }))).toMatchObject({ code: 'not_found', text: { id: 'sticky.note.missing', params: { name: 'Nowhere' } } });
    const big = await refused(s.mei.conn.request('sticky.spec', { note: 'A' }));
    expect(big).toMatchObject({ code: 'too_large', detail: { reason: 'note-oversized', note: 'Big' }, text: { id: 'sticky.spec.oversized', params: { name: 'Big', maxKiB: NOTE_MAX_BYTES / 1024 } } });
    expect(render('en', big.text)).toBe('The sticky note Big is larger than 64 KiB, so it cannot go into a spec.');
    // The host may read .envrc, but a note that is a symlink or a hard link to it is no note's text, for the host too
    // (the index's rules): a spec is read by every member.
    for (const who of [s.host, s.mei]) {
      for (const [note, name] of [['B', 'Secret'], ['D', 'Twin']] as const) {
        const secret = await refused(who.conn.request('sticky.spec', { note }));
        expect(secret).toMatchObject({ code: 'conflict', detail: { reason: 'note-unreadable', note: name }, text: { id: 'sticky.spec.unreadable', params: { name } } });
        expect(JSON.stringify(secret)).not.toContain('secret-of-the-host');
      }
    }
    expect(await refused(s.mei.conn.request('sticky.spec', { note: 'C' }))).toMatchObject({ code: 'conflict', text: { id: 'sticky.spec.unreadable', params: { name: 'Broken' } } });
    // The note itself, too large: refused by its own name.
    expect(await refused(s.mei.conn.request('sticky.spec', { note: 'Big' }))).toMatchObject({ code: 'too_large', text: { id: 'sticky.spec.oversized', params: { name: 'Big' } } });
  });

  it('the whole text is at most 256 KiB: exactly that is answered, one byte more is refused, never cut', async () => {
    const block = 'x'.repeat(60 * 1024);
    const files = { 'notes/Home.md': 'Read [[A]], [[B]], [[C]], [[D]] and [[E]].', 'notes/A.md': block, 'notes/B.md': block, 'notes/C.md': block, 'notes/D.md': block, 'notes/E.md': 'y' };
    const s = await startNotes({ topics: true, files });
    const small = await s.mei.conn.request('sticky.spec', { note: 'Home' });
    const room = SPEC_FROM_NOTES_MAX_BYTES - new TextEncoder().encode(small.text).byteLength;
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThan(NOTE_MAX_BYTES);
    await writeFile(join(s.root, 'notes', 'E.md'), 'y'.repeat(1 + room));
    const full = await s.mei.conn.request('sticky.spec', { note: 'Home' });
    expect(new TextEncoder().encode(full.text).byteLength).toBe(SPEC_FROM_NOTES_MAX_BYTES);
    expect(full.notes).toEqual(['Home', 'A', 'B', 'C', 'D', 'E']);
    await writeFile(join(s.root, 'notes', 'E.md'), 'y'.repeat(2 + room));
    const over = await refused(s.mei.conn.request('sticky.spec', { note: 'Home' }));
    expect(over).toMatchObject({ code: 'too_large', detail: { reason: 'spec-too-large' }, text: { id: 'sticky.spec.tooLarge', params: { maxKiB: 256 } } });
  });

  it('is for a member who may start sessions: an Editor and a Viewer are refused', async () => {
    const s = await notes();
    for (const who of [s.amy, s.leo]) {
      expect((await refused(who.conn.request('sticky.spec', { note: 'Checkout' }))).code).toBe('forbidden');
      expect((await refused(who.conn.request('sticky.build', { note: 'Checkout', hash: sha256(CHECKOUT_SPEC) }))).code).toBe('forbidden');
    }
    expect(s.t.ctx.services.topics.list({}).topics).toEqual([]);
  });
});

describe('sticky.build: a topic made from a sticky note, nothing started (D5.2–D5.5)', { timeout: 60_000 }, () => {
  it('makes the topic as the caller, records the build, writes SPEC.md and a PLAN.md of one work item, audits it, and starts nothing but the discussion, which is kept', async () => {
    const s = await notes();
    const { hash } = await s.mei.conn.request('sticky.spec', { note: 'Checkout' });
    const changesBefore = s.changes.length;
    const { topicId } = await s.mei.conn.request('sticky.build', { note: 'Checkout', hash });
    const topic = s.t.ctx.services.topics.get(topicId);
    expect(topic).toMatchObject({ name: 'Checkout', slug: 'checkout', createdBy: { userId: MEI, displayName: 'Mei' }, discussion: 'live' });
    // The spec is the text the member read, byte for byte; the plan is one work item named after the note.
    expect(await readFile(join(s.root, 'specs', 'checkout', 'SPEC.md'), 'utf8')).toBe(CHECKOUT_SPEC);
    const plan = await readFile(join(s.root, 'specs', 'checkout', 'PLAN.md'), 'utf8');
    expect(plan).toBe(buildPlanText('Checkout'));
    await waitFor(() => (s.t.ctx.services.plans.get(topicId)?.items.length ?? 0) === 1, { timeoutMs: 10_000, what: 'the topic to read its plan' });
    expect(s.t.ctx.services.plans.get(topicId)?.items.map((item) => [item.id, item.title, item.state])).toEqual([[BUILD_ITEM_ID, 'Checkout', 'not-started']]);
    await waitFor(() => s.t.ctx.services.topics.get(topicId)?.spec.exists === true, { timeoutMs: 10_000, what: 'the topic to see its spec' });
    // The record, as soon as the topic exists; every member is told the note's topics.
    expect(await stored(s)).toEqual([{ note: 'Checkout', topicId, by: { userId: MEI, displayName: 'Mei' }, at: expect.any(Number), hash }]);
    expect((await s.leo.conn.request('sticky.list', {})).notes.find((note) => note.name === 'Checkout')).toEqual({ name: 'Checkout', links: ['Payment form', 'Refunds', 'checkout'], builds: [topicId] });
    expect(s.changes.slice(changesBefore)).toContainEqual({ upserted: [{ name: 'Checkout', links: ['Payment form', 'Refunds', 'checkout'], builds: [topicId] }], removed: [], truncated: false });
    // The audit: the build, the topic and both files are Mei's.
    const builds = await audit(s, 'sticky.build');
    expect(builds.map((entry) => [entry.actor, entry.outcome, entry.target, entry.detail])).toEqual([
      [{ kind: 'user', userId: MEI, displayName: 'Mei' }, 'ok', topicId, { note: 'Checkout', topicId, slug: 'checkout', specHash: hash, notes: ['Checkout', 'Payment form'] }],
    ]);
    expect((await audit(s, 'topic.create')).map((entry) => entry.actor)).toEqual([{ kind: 'user', userId: MEI, displayName: 'Mei' }]);
    expect((await audit(s, 'file.write')).map((entry) => [entry.target, entry.actor.kind === 'user' ? entry.actor.userId : null])).toEqual([
      ['main:specs/checkout/SPEC.md', MEI],
      ['main:specs/checkout/PLAN.md', MEI],
    ]);
    // Nothing started: the one agent session is the topic's discussion (D5.5), still there; no work item, no Start.
    const starts = s.fakes.agents.log.of('start').map(([input]) => (input as { purpose: string }).purpose);
    expect(starts).toEqual(['discussion']);
    const discussion = s.t.ctx.services.agents.get(topic?.discussionSessionId as string);
    expect(discussion?.status).not.toBe('ended');
    for (const action of ['plan.start', 'scheduler.start', 'plan.item.retry']) expect(await audit(s, action), action).toEqual([]);
    expect(s.t.ctx.services.topics.get(topicId)?.phase).not.toBe('executing');
  });

  it('refuses another hash (the note or a linked note changed): no topic, no folder, no record; the new text has a new hash', async () => {
    const s = await notes();
    const { hash } = await s.mei.conn.request('sticky.spec', { note: 'Checkout' });
    await writeFile(join(s.root, 'notes', 'Payment form.md'), 'Card only.\n');
    const changed = await refused(s.mei.conn.request('sticky.build', { note: 'Checkout', hash }));
    expect(changed).toMatchObject({ code: 'conflict', detail: { reason: 'note-changed' }, text: { id: 'sticky.build.noteChanged' } });
    expect(s.t.ctx.services.topics.list({}).topics).toEqual([]);
    await expect(stat(join(s.root, 'specs'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stored(s)).toEqual([]);
    expect(await audit(s, 'sticky.build')).toEqual([]);
    const fresh = await s.mei.conn.request('sticky.spec', { note: 'Checkout' });
    expect(fresh.hash).not.toBe(hash);
    expect(fresh.text).toContain('Card only.');
    expect((await s.mei.conn.request('sticky.build', { note: 'Checkout', hash: fresh.hash })).topicId).toMatch(/^tp_/);
  });

  it('a second build of the same note gets its own topic and folder (-2), and the note names both, the newest first', async () => {
    const s = await notes();
    const first = await build(s);
    const second = await build(s);
    expect(s.t.ctx.services.topics.get(second)).toMatchObject({ name: 'Checkout', slug: 'checkout-2' });
    expect(await readFile(join(s.root, 'specs', 'checkout-2', 'SPEC.md'), 'utf8')).toBe(CHECKOUT_SPEC);
    expect((await s.leo.conn.request('sticky.list', {})).notes.find((note) => note.name === 'Checkout')?.builds).toEqual([second, first]);
    // Two builds sent at once wait for each other: two topics, two slugs.
    const { hash } = await s.mei.conn.request('sticky.spec', { note: 'Checkout' });
    const both = await Promise.all([s.mei.conn.request('sticky.build', { note: 'Checkout', hash }), s.host.conn.request('sticky.build', { note: 'Checkout', hash })]);
    expect(both.map(({ topicId }) => s.t.ctx.services.topics.get(topicId)?.slug).sort()).toEqual(['checkout-3', 'checkout-4']);
  });

  it('a sticky note with a Chinese name: the topic and the work item carry the name, the slug is topic-<n>', async () => {
    const s = await startNotes({ topics: true, files: { 'notes/結帳流程.md': '優惠券在櫃台檢查。\n' } });
    const first = await build(s, '結帳流程');
    expect(s.t.ctx.services.topics.get(first)).toMatchObject({ name: '結帳流程', slug: 'topic-1' });
    await waitFor(() => (s.t.ctx.services.plans.get(first)?.items.length ?? 0) === 1, { timeoutMs: 10_000, what: 'the plan' });
    expect(s.t.ctx.services.plans.get(first)?.items[0]?.title).toBe('結帳流程');
    const second = await build(s, '結帳流程');
    expect(s.t.ctx.services.topics.get(second)?.slug).toBe('topic-2');
    expect(await readFile(join(s.root, 'specs', 'topic-1', 'SPEC.md'), 'utf8')).toBe('Built from the sticky note "notes/結帳流程.md".\n\n優惠券在櫃台檢查。\n\nOther sticky notes are not part of this spec.\n');
  });

  it('never a slug whose folder in specs/ is there (a deleted topic keeps its folder); when -2 to -9 are all taken, slug-unavailable and nothing is made', async () => {
    const s = await notes({ files: { ...NOTES, 'specs/checkout/SPEC.md': 'An old topic.\n' } });
    expect(s.t.ctx.services.topics.get(await build(s))?.slug).toBe('checkout-2');
    for (let n = 3; n <= BUILD_SLUG_SUFFIX_MAX; n += 1) await mkdir(join(s.root, 'specs', `checkout-${n}`));
    const { hash } = await s.mei.conn.request('sticky.spec', { note: 'Checkout' });
    const unavailable = await refused(s.mei.conn.request('sticky.build', { note: 'Checkout', hash }));
    expect(unavailable).toMatchObject({ code: 'conflict', detail: { reason: 'slug-unavailable' }, text: { id: 'sticky.build.slugUnavailable', params: { slug: 'checkout' } } });
    expect(s.t.ctx.services.topics.list({}).topics).toHaveLength(1);
    expect(await stored(s)).toHaveLength(1);
    expect((await readdir(join(s.root, 'specs'))).sort()).toEqual(['checkout', 'checkout-2', 'checkout-3', 'checkout-4', 'checkout-5', 'checkout-6', 'checkout-7', 'checkout-8', 'checkout-9']);
  });

  it('never the slug of a stored topic whose folder is gone, nor one a folder in specs/ has under another case: both count as taken, and the build goes on to -2', async () => {
    // A stored topic keeps its slug after its folder was removed (topic.create would refuse it as slug-taken).
    const s = await notes();
    const first = await build(s);
    await rm(join(s.root, 'specs', 'checkout'), { recursive: true });
    const second = await build(s);
    expect(s.t.ctx.services.topics.get(second)).toMatchObject({ name: 'Checkout', slug: 'checkout-2' });
    expect(await readFile(join(s.root, 'specs', 'checkout-2', 'SPEC.md'), 'utf8')).toBe(CHECKOUT_SPEC);
    expect(s.t.ctx.services.topics.get(first)?.slug).toBe('checkout');
    expect((await audit(s, 'sticky.build')).map((entry) => [entry.outcome, entry.detail?.['slug']])).toEqual([
      ['ok', 'checkout'],
      ['ok', 'checkout-2'],
    ]);
    // A folder `specs/Checkout` is `specs/checkout` on a disk that ignores case: the names are folded before they count.
    const t = await notes({ files: { ...NOTES, 'specs/Checkout/SPEC.md': 'Another topic.\n' } });
    expect(t.t.ctx.services.topics.get(await build(t))?.slug).toBe('checkout-2');
    expect((await readdir(join(t.root, 'specs'))).sort()).toEqual(['Checkout', 'checkout-2']);
  });

  it('a free slug: the name gives it, a suffix shortens a long one to stay a slug, folded names count as taken', () => {
    expect(freeSlug('Payment form', new Set())).toBe('payment-form');
    expect(freeSlug('Payment form', new Set(['payment-form', 'payment-form-2']))).toBe('payment-form-3');
    const long = 'Abcdefghij '.repeat(7).trim();
    const base = freeSlug(long, new Set()) as string;
    expect(base.length).toBe(TOPIC_SLUG_MAX_CHARS);
    for (const slug of [freeSlug(long, new Set([base])), freeSlug(long, new Set([base, `${base.slice(0, TOPIC_SLUG_MAX_CHARS - 2).replace(/-+$/, '')}-2`]))]) {
      expect(slug).toMatch(TOPIC_SLUG_PATTERN);
      expect((slug as string).length).toBeLessThanOrEqual(TOPIC_SLUG_MAX_CHARS);
    }
    expect(freeSlug('Home', new Set(['home', ...Array.from({ length: BUILD_SLUG_SUFFIX_MAX - 1 }, (_, i) => `home-${i + 2}`)]))).toBeNull();
    expect(freeSlug('購物車', new Set(['topic-1']))).toBe('topic-2');
    // The plan a build writes parses to its one item, whatever the name.
    const parsed = parsePlan(buildPlanText('Q3 plan (draft)'));
    expect(parsed.ok && parsed.items.map((item) => [item.id, item.title])).toEqual([[BUILD_ITEM_ID, 'Q3 plan (draft)']]);
  });

  it(`refuses before anything is made at the topic limit (${TOPICS_MAX}) and at the agent sessions' limit, which topic.create would meet with its discussion`, async () => {
    const s = await notes({ agents: { maxAgentSessions: 1 } });
    // One session alive (Claude for the sticky notes): the topic's discussion would be one too many.
    await s.mei.conn.request('sticky.assistant.start', {});
    const { hash } = await s.mei.conn.request('sticky.spec', { note: 'Checkout' });
    expect(await refused(s.mei.conn.request('sticky.build', { note: 'Checkout', hash }))).toMatchObject({ code: 'conflict', detail: { reason: 'agent-limit' }, text: { id: 'session.limit.agents', params: { max: 1 } } });
    expect(s.t.ctx.services.topics.list({}).topics).toEqual([]);
    await expect(stat(join(s.root, 'specs'))).rejects.toMatchObject({ code: 'ENOENT' });

    const t = await notes();
    const host = principal(t, TEST_HOST_USER);
    for (let n = 0; n < TOPICS_MAX; n += 1) await t.t.ctx.services.topics.create({ name: `Topic ${n}`, slug: `topic-${n}` }, host);
    await t.t.ctx.services.topics.archive({ topicId: (t.t.ctx.services.topics.list({}).topics[0] as { id: string }).id, archived: true }, host);
    // Every slug taken too: the topic limit is checked first (an archived topic counts), so the refusal names it.
    for (const slug of ['checkout', ...Array.from({ length: BUILD_SLUG_SUFFIX_MAX - 1 }, (_, i) => `checkout-${i + 2}`)]) await mkdir(join(t.root, 'specs', slug), { recursive: true });
    const atLimit = await t.mei.conn.request('sticky.spec', { note: 'Checkout' });
    expect(await refused(t.mei.conn.request('sticky.build', { note: 'Checkout', hash: atLimit.hash }))).toMatchObject({ code: 'conflict', detail: { reason: 'topic-limit' }, text: { id: 'topic.limit', params: { max: TOPICS_MAX } } });
    expect(await stored(t)).toEqual([]);
    expect(await readdir(join(t.root, 'specs', 'checkout'))).toEqual([]);
    expect(t.t.ctx.services.topics.list({}).topics).toHaveLength(TOPICS_MAX - 1);
  }, 120_000);

  it('a build that waited its turn makes nothing for a member who lost agent access meanwhile', async () => {
    const s = await notes();
    const mei = principal(s, MEI);
    const { hash } = await s.mei.conn.request('sticky.spec', { note: 'Checkout' });
    await s.host.conn.request('admin.member.setRole', { userId: MEI, role: 'editor' });
    expect(await refused(s.service.builder.build({ note: 'Checkout', hash }, mei))).toMatchObject({ code: 'forbidden', detail: { reason: 'capability' } });
    expect(s.t.ctx.services.topics.list({}).topics).toEqual([]);
  });

  it('a step that fails after the topic exists leaves the topic and its record, names the step, and is audited (D5.4)', async () => {
    const s = await notes();
    const files = s.t.ctx.services.files;
    const write = files.write.bind(files);
    // SPEC.md: the disk is full.
    const spy = vi.spyOn(files, 'write').mockImplementationOnce(async () => {
      throw new SmurgError('insufficient_disk');
    });
    const { hash } = await s.mei.conn.request('sticky.spec', { note: 'Checkout' });
    const failed = await refused(s.mei.conn.request('sticky.build', { note: 'Checkout', hash }));
    expect(failed).toMatchObject({ code: 'insufficient_disk', detail: { reason: 'failed-at', step: 'spec' }, text: { id: 'sticky.build.failedAt', params: { step: 'spec' } } });
    // The steps run one after the other and stop at the first that fails: the words say that PLAN.md is missing too.
    expect(render('en', failed.text)).toBe('The topic was made and is in the sessions view, but neither its SPEC.md nor its PLAN.md was written.');
    expect(render('zh-TW', failed.text)).toBe('主題已經建立，可以在 session 畫面找到，但它的 SPEC.md 和 PLAN.md 都沒有寫入');
    const topicId = String(failed.detail?.['topicId']);
    expect(s.t.ctx.services.topics.get(topicId)).toMatchObject({ name: 'Checkout', slug: 'checkout' });
    expect((await stored(s)).map((record) => record.topicId)).toEqual([topicId]);
    expect((await s.leo.conn.request('sticky.list', {})).notes.find((note) => note.name === 'Checkout')?.builds).toEqual([topicId]);
    expect(await readdir(join(s.root, 'specs', 'checkout'))).toEqual([]);
    expect((await audit(s, 'sticky.build')).map((entry) => [entry.outcome, entry.detail?.['step'], entry.detail?.['reason']])).toEqual([['error', 'spec', 'insufficient_disk']]);

    // PLAN.md: SPEC.md is there, the plan is not.
    spy.mockImplementation(async (input, who) => {
      if (input.file.path.endsWith('/PLAN.md')) throw new SmurgError('internal');
      return write(input, who);
    });
    const second = await refused(s.mei.conn.request('sticky.build', { note: 'Checkout', hash }));
    expect(second).toMatchObject({ code: 'internal', detail: { reason: 'failed-at', step: 'plan' }, text: { id: 'sticky.build.failedAt', params: { step: 'plan' } } });
    expect(render('en', second.text)).toBe('The topic was made and is in the sessions view, with its SPEC.md, but its PLAN.md was not written.');
    expect(render('zh-TW', second.text)).toBe('主題已經建立，可以在 session 畫面找到，SPEC.md 也寫好了，但它的 PLAN.md 沒有寫入');
    expect(await readdir(join(s.root, 'specs', 'checkout-2'))).toEqual(['SPEC.md']);
    expect(s.t.ctx.services.topics.get(String(second.detail?.['topicId']))?.slug).toBe('checkout-2');
    spy.mockRestore();
  });

  it('the record is the first step after the topic exists: when it fails, neither SPEC.md nor PLAN.md is written, and the words say so (D5.4)', async () => {
    const s = await notes();
    const document = await s.t.ctx.state.document(STICKY_DOCUMENT, stickyDocumentSchema, initialStickyDocument);
    const spy = vi.spyOn(document, 'update').mockImplementationOnce(() => {
      throw new SmurgError('internal');
    });
    const { hash } = await s.mei.conn.request('sticky.spec', { note: 'Checkout' });
    const failed = await refused(s.mei.conn.request('sticky.build', { note: 'Checkout', hash }));
    spy.mockRestore();
    expect(failed).toMatchObject({ code: 'internal', detail: { reason: 'failed-at', step: 'record' }, text: { id: 'sticky.build.failedAt', params: { step: 'record' } } });
    expect(render('en', failed.text)).toBe(
      'The topic was made and is in the sessions view, but smurg could not record on the sticky note that it was built from it, and neither its SPEC.md nor its PLAN.md was written.',
    );
    expect(render('zh-TW', failed.text)).toBe('主題已經建立，可以在 session 畫面找到，但 smurg 沒有在便利貼上記下這個主題是從它建立的，它的 SPEC.md 和 PLAN.md 也都沒有寫入');
    const topicId = String(failed.detail?.['topicId']);
    expect(s.t.ctx.services.topics.get(topicId)).toMatchObject({ name: 'Checkout', slug: 'checkout' });
    expect(await stored(s)).toEqual([]);
    expect(await readdir(join(s.root, 'specs', 'checkout'))).toEqual([]);
    expect((await audit(s, 'sticky.build')).map((entry) => [entry.outcome, entry.detail?.['step']])).toEqual([['error', 'record']]);
  });

  it(`keeps at most ${NOTE_BUILDS_MAX} records, the oldest goes first; a note names its newest ${NOTE_INFO_BUILDS_MAX} topics that are there, past the records of topics that are gone`, async () => {
    const s = await notes();
    const host = principal(s, TEST_HOST_USER);
    // Nine topics that are there. The other records name topics that are not (deleted): no note names those (D5.4,
    // "the note shows the topic"), so they never hide an older topic that is there.
    const there: string[] = [];
    for (let n = 0; n < 9; n += 1) there.push((await s.t.ctx.services.topics.create({ name: `Old ${n}`, slug: `old-${n}` }, host)).topic.id);
    const document = await s.t.ctx.state.document(STICKY_DOCUMENT, stickyDocumentSchema, initialStickyDocument);
    const by = { userId: LEO, displayName: 'Leo' };
    // Checkout's records 2, 4 … 18 name the nine topics; every other record names a topic that is gone.
    const topicOf = (n: number): string => (n % 2 === 0 && n >= 2 && n <= 18 ? (there[n / 2 - 1] as string) : `tp_gone${n}`);
    document.update((draft) => {
      draft.builds = Array.from({ length: NOTE_BUILDS_MAX }, (_, n) => ({ note: n % 2 === 0 ? 'Checkout' : 'Home', topicId: topicOf(n), by, at: n, hash: 'a'.repeat(64) }));
    });
    const topicId = await build(s);
    const records = await stored(s);
    expect(records).toHaveLength(NOTE_BUILDS_MAX);
    expect(records[0]?.topicId).toBe('tp_gone1');
    expect(records.at(-1)?.topicId).toBe(topicId);
    const listed = (await s.leo.conn.request('sticky.list', {})).notes;
    // The newest eight that are there: the new topic, then the newest seven of the nine, past 90 records of topics gone.
    expect(listed.find((note) => note.name === 'Checkout')?.builds).toEqual([topicId, ...there.slice(2).reverse()]);
    // Every record of Home names a topic that is gone: Home names none.
    expect(listed.find((note) => note.name === 'Home')).toEqual({ name: 'Home', links: ['Checkout'] });
    // A note of the same name in another case is the same note's builds (D1.3); a note nobody built has none.
    expect(s.service.builder.buildsOf('checkout')[0]).toBe(topicId);
    expect(listed.find((note) => note.name === 'Hidden')).toEqual({ name: 'Hidden', links: [] });
  });

  it('a topic that is deleted is no topic of its note any more: every member is told the note again without it, and an older one comes back into the newest 8; an archived one stays', async () => {
    const s = await notes();
    const ids: string[] = [];
    // Nine builds (checkout … checkout-9): one more than a note names.
    for (let n = 0; n <= NOTE_INFO_BUILDS_MAX; n += 1) ids.push(await build(s));
    const builds = async (): Promise<readonly string[] | undefined> => (await s.leo.conn.request('sticky.list', {})).notes.find((note) => note.name === 'Checkout')?.builds;
    expect(await builds()).toEqual(ids.slice(1).reverse());
    const newest = ids.at(-1) as string;
    // Archived, it is still a topic made from the note.
    await s.host.conn.request('topic.archive', { topicId: newest, archived: true });
    expect(await builds()).toEqual(ids.slice(1).reverse());
    const before = s.changes.length;
    await s.host.conn.request('topic.delete', { topicId: newest });
    // Leo's round trip: what was told to Leo before it has arrived.
    expect(await builds()).toEqual(ids.slice(0, -1).reverse());
    expect(s.changes.slice(before)).toEqual([{ upserted: [{ name: 'Checkout', links: ['Payment form', 'Refunds', 'checkout'], builds: ids.slice(0, -1).reverse() }], removed: [], truncated: false }]);
    // The record stays (at most 200, the oldest dropped, D5.2); the topic is only no longer named.
    expect((await stored(s)).map((record) => record.topicId)).toEqual(ids);
  }, 120_000);

  it('the builds survive a change of the note: the index announces the note with its topics', async () => {
    const s = await notes();
    const topicId = await build(s);
    const before = s.service.index.listings();
    await writeFile(join(s.root, 'notes', 'Checkout.md'), 'Only [[Home]] now.\n');
    await s.listed(before, 'the change of Checkout');
    await waitFor(() => s.changes.some((change) => change.upserted.some((note) => note.name === 'Checkout' && note.links.length === 1)), { timeoutMs: 10_000, what: 'the change to be told' });
    expect(s.changes.at(-1)?.upserted).toEqual([{ name: 'Checkout', links: ['Home'], builds: [topicId] }]);
    // Nobody else's actions are Amy's or Leo's.
    expect((await audit(s, 'sticky.build')).every((entry) => entry.actor.kind === 'user' && ![AMY, LEO].includes(entry.actor.userId))).toBe(true);
  });
});
