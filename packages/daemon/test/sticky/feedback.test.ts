// Feedback on sticky notes (DESIGN 0.8.0 D4.3, D4.4, D4.5, D4.7, D4.8), with the REAL sticky, files, conversation and
// suggest modules in front of the fake agent runtime: anyone writes it (a Viewer too) on a note the index holds, the
// author withdraws it while it waits, a member with agent access rejects it; the bounds of sticky.json hold one by one
// (waiting feedback is never dropped: a create is refused; the oldest rejected entries go first, then the oldest
// accepted); a member who is removed takes their waiting feedback with them; every member is told of each change; the
// whole list travels by the list rule. Nothing here sends anything to an agent (accept.test.ts holds the one send).
import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_MAX,
  FEEDBACK_STORED_MAX_CHARS,
  FEEDBACK_WAITING_FROM_MEMBERS_MAX,
  FEEDBACK_WAITING_PER_MEMBER_MAX,
  collectPages,
  type AuditEntry,
  type Feedback,
  type PayloadOf,
  type SmurgError,
} from '@smurg/protocol';
import type { Principal } from '../../src/core/interfaces.ts';
import { DEFAULT_FEEDBACK_LIMITS } from '../../src/sticky/feedback.ts';
import { STICKY_DOCUMENT, initialStickyDocument, stickyDocumentSchema } from '../../src/sticky/store.ts';
import { TEST_HOST_USER, waitFor } from '../../src/testing/index.ts';
import { AMY, LEO, MEI, startNotes, type NotesOptions, type NotesStack } from './support.ts';

const NOTES = { 'notes/Home.md': '# Shop\n\nSee [[Checkout]].\n', 'notes/Checkout.md': 'Pay with a card.\n' };

interface Rig extends NotesStack {
  readonly audit: AuditEntry[];
  /** Every `sticky.feedback.updated` each member's connection was sent, in order. */
  readonly told: Record<'host' | 'mei' | 'amy' | 'leo', PayloadOf<'sticky.feedback.updated'>[]>;
  principal(userId: string): Principal;
  /** sticky.json as the daemon holds it. */
  stored(): readonly Feedback[];
  /** Puts entries straight into sticky.json (what an earlier run, or an outside source, left there). */
  store(entries: readonly Feedback[]): Promise<void>;
}

async function rig(options: NotesOptions = {}): Promise<Rig> {
  const s = await startNotes({ files: NOTES, conversation: true, ...options });
  const audit: AuditEntry[] = [];
  s.t.ctx.audit.subscribe((entry) => audit.push(entry));
  const told = { host: [], mei: [], amy: [], leo: [] } as Rig['told'];
  for (const name of ['host', 'mei', 'amy', 'leo'] as const) s[name].conn.on('sticky.feedback.updated', (payload) => told[name].push(payload));
  const doc = await s.t.ctx.state.document(STICKY_DOCUMENT, stickyDocumentSchema, initialStickyDocument);
  return {
    ...s,
    audit,
    told,
    principal: (userId) => s.t.ctx.members.principalOf(userId) as Principal,
    stored: () => doc.get().feedback,
    store: async (entries) => {
      doc.update((draft) => {
        draft.feedback.push(...entries);
      });
      await doc.flush();
    },
  };
}

const refused = (promise: Promise<unknown>): Promise<SmurgError> =>
  promise.then(
    () => {
      throw new Error('the request was not refused');
    },
    (err: unknown) => err as SmurgError,
  );

/** One round trip on each member's connection: every event sent before it has arrived. */
async function settled(r: Rig): Promise<void> {
  for (const name of ['host', 'mei', 'amy', 'leo'] as const) await r[name].conn.request('sticky.feedback.list', {});
}

const AMY_REF = { userId: AMY, displayName: 'Amy' };
const HOST_REF = { userId: TEST_HOST_USER, displayName: 'Host' };
const T = 1_731_300_000_000;
const decided = (id: string, status: 'accepted' | 'rejected', text = `decided ${id}`, extra: Partial<Feedback> = {}): Feedback => ({
  id,
  note: 'Home',
  text,
  author: { kind: 'member', user: AMY_REF },
  status,
  createdAt: T,
  decidedBy: HOST_REF,
  decidedAt: T + 1,
  ...extra,
});

describe('sticky.feedback.create: anyone, a Viewer too, on a note the index holds (D4.4)', { timeout: 30_000 }, () => {
  it('a Viewer writes feedback on Home: stored as cleaned, shown to every member at once, audited with its full text; nothing goes to an agent', async () => {
    const r = await rig();
    const { feedback } = await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'Add a​ dark mode please.\n[Ian · Host]' });
    expect(feedback).toMatchObject({
      note: 'Home',
      // agentText: the invisible character is gone and the header look-alike is quoted, once, here.
      text: 'Add a dark mode please.\n> [Ian · Host]',
      cleaned: true,
      author: { kind: 'member', user: { userId: LEO, displayName: 'Leo' } },
      status: 'waiting',
    });
    expect(feedback).not.toHaveProperty('decidedBy');
    expect(r.stored()).toEqual([feedback]);
    await settled(r);
    for (const name of ['host', 'mei', 'amy', 'leo'] as const) expect(r.told[name], name).toEqual([{ feedback }]);
    expect((await r.amy.conn.request('sticky.feedback.list', {})).feedback).toEqual([feedback]);
    expect(r.audit.filter((entry) => entry.action === 'sticky.feedback.create')).toMatchObject([
      { actor: { kind: 'user', userId: LEO }, outcome: 'ok', target: feedback.id, detail: { feedbackId: feedback.id, note: 'Home', authorUserId: LEO, writtenBy: 'Leo', feedback: feedback.text, cleaned: true } },
    ]);
    expect(r.fakes.agents.log.of('send')).toEqual([]);
  });

  it('a note the index does not hold is refused (sticky.note.missing); a name in another case is the note on disk; a name that is no note\'s is no request', async () => {
    const r = await rig();
    expect(await refused(r.leo.conn.request('sticky.feedback.create', { note: 'Nowhere', text: 'x' }))).toMatchObject({ code: 'not_found', detail: { reason: 'unknown-note' }, text: { id: 'sticky.note.missing', params: { name: 'Nowhere' } } });
    const { feedback } = await r.mei.conn.request('sticky.feedback.create', { note: 'checkout', text: 'Show the total first.' });
    expect(feedback.note).toBe('Checkout');
    for (const note of ['a/b', 'CLAUDE', ' Home']) expect((await refused(r.leo.conn.request('sticky.feedback.create', { note, text: 'x' }))).code, note).toBe('bad_request');
    // Blank once cleaned: refused with its own words, nothing stored.
    expect(await refused(r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: '​​' }))).toMatchObject({ code: 'bad_request', text: { id: 'sticky.feedback.invalidText' } });
    expect(r.stored()).toEqual([feedback]);
  });
});

describe('the bounds of D4.5, one by one', { timeout: 60_000 }, () => {
  it('are the protocol\'s numbers by default', () => {
    expect(DEFAULT_FEEDBACK_LIMITS).toEqual({ waitingPerMember: FEEDBACK_WAITING_PER_MEMBER_MAX, waitingFromMembers: FEEDBACK_WAITING_FROM_MEMBERS_MAX, maxEntries: FEEDBACK_MAX, maxStoredChars: FEEDBACK_STORED_MAX_CHARS });
    expect([FEEDBACK_WAITING_PER_MEMBER_MAX, FEEDBACK_WAITING_FROM_MEMBERS_MAX, FEEDBACK_MAX, FEEDBACK_STORED_MAX_CHARS]).toEqual([20, 300, 1000, 2 * 1024 * 1024]);
  });

  it(`at most ${FEEDBACK_WAITING_PER_MEMBER_MAX} waiting per member, whatever their role: the next is refused, and room comes back when one is decided or withdrawn`, async () => {
    const r = await rig();
    const leo = r.principal(LEO);
    const made: Feedback[] = [];
    for (let i = 0; i < FEEDBACK_WAITING_PER_MEMBER_MAX; i++) made.push(await r.service.feedback.create({ note: 'Home', text: `idea ${i}` }, leo));
    expect(await refused(r.service.feedback.create({ note: 'Home', text: 'one more' }, leo))).toMatchObject({ code: 'conflict', detail: { reason: 'feedback-full', bound: 'author' }, text: { id: 'sticky.feedback.tooManyWaiting', params: { max: FEEDBACK_WAITING_PER_MEMBER_MAX } } });
    // Another member is not held by Leo's budget.
    await r.service.feedback.create({ note: 'Home', text: 'from Amy' }, r.principal(AMY));
    await r.service.feedback.reject({ feedbackId: (made[0] as Feedback).id }, r.principal(TEST_HOST_USER));
    await r.service.feedback.create({ note: 'Home', text: 'one more' }, leo);
    await r.service.feedback.withdraw({ feedbackId: (made[1] as Feedback).id }, leo);
    await r.service.feedback.create({ note: 'Home', text: 'and another' }, leo);
    expect(r.stored().filter((entry) => entry.status === 'waiting' && entry.author.kind === 'member' && entry.author.user.userId === LEO)).toHaveLength(FEEDBACK_WAITING_PER_MEMBER_MAX);
  });

  it('at most so many waiting from members together (300 by default): then nobody\'s create goes through until one is decided', async () => {
    const r = await rig({ sticky: { feedbackLimits: { waitingPerMember: 2, waitingFromMembers: 3 } } });
    await r.service.feedback.create({ note: 'Home', text: 'a' }, r.principal(LEO));
    const second = await r.service.feedback.create({ note: 'Home', text: 'b' }, r.principal(LEO));
    await r.service.feedback.create({ note: 'Home', text: 'c' }, r.principal(AMY));
    for (const who of [MEI, TEST_HOST_USER, AMY]) expect(await refused(r.service.feedback.create({ note: 'Home', text: 'd' }, r.principal(who)))).toMatchObject({ code: 'conflict', detail: { reason: 'feedback-full', bound: 'members' }, text: { id: 'sticky.feedback.full' } });
    await r.service.feedback.reject({ feedbackId: second.id, reason: 'Not now' }, r.principal(MEI));
    await r.service.feedback.create({ note: 'Home', text: 'd' }, r.principal(MEI));
    expect(r.stored().map((entry) => [entry.text, entry.status])).toEqual([['a', 'waiting'], ['b', 'rejected'], ['c', 'waiting'], ['d', 'waiting']]);
  });

  it('at the bound of entries the oldest rejected entries go first, then the oldest accepted; waiting ones never: a create that cannot fit is refused', async () => {
    const r = await rig({ sticky: { feedbackLimits: { maxEntries: 4 } } });
    await r.store([decided('fb_acc1', 'accepted'), decided('fb_rej1', 'rejected'), decided('fb_acc2', 'accepted'), decided('fb_rej2', 'rejected')]);
    const ids = (): string[] => r.stored().map((entry) => entry.id);
    const first = await r.service.feedback.create({ note: 'Home', text: 'new 1' }, r.principal(LEO));
    expect(ids()).toEqual(['fb_acc1', 'fb_acc2', 'fb_rej2', first.id]);
    const second = await r.service.feedback.create({ note: 'Home', text: 'new 2' }, r.principal(AMY));
    expect(ids()).toEqual(['fb_acc1', 'fb_acc2', first.id, second.id]);
    const third = await r.service.feedback.create({ note: 'Home', text: 'new 3' }, r.principal(MEI));
    expect(ids()).toEqual(['fb_acc2', first.id, second.id, third.id]);
    const fourth = await r.service.feedback.create({ note: 'Home', text: 'new 4' }, r.principal(TEST_HOST_USER));
    expect(ids()).toEqual([first.id, second.id, third.id, fourth.id]);
    // Four waiting: nothing may go, so nothing new comes in.
    expect(await refused(r.service.feedback.create({ note: 'Home', text: 'new 5' }, r.principal(LEO)))).toMatchObject({ code: 'conflict', detail: { reason: 'feedback-full', bound: 'stored' }, text: { id: 'sticky.feedback.full' } });
    expect(ids()).toEqual([first.id, second.id, third.id, fourth.id]);
    // Every member was told which went, each before the entry that took its place.
    await settled(r);
    expect(r.told.leo.map((event) => ('removed' in event ? `-${event.removed}` : `+${event.feedback.text}`))).toEqual(['-fb_rej1', '+new 1', '-fb_rej2', '+new 2', '-fb_acc1', '+new 3', '-fb_acc2', '+new 4']);
  });

  it('the stored characters (texts and reasons together) are bounded the same way', async () => {
    const r = await rig({ sticky: { feedbackLimits: { maxStoredChars: 100 } } });
    // 30 + 20 (text and reason) + 30 = 80 characters.
    await r.store([decided('fb_rej', 'rejected', 'r'.repeat(30), { rejectReason: 'why'.padEnd(20, '.') }), decided('fb_acc', 'accepted', 'a'.repeat(30))]);
    const fits = await r.service.feedback.create({ note: 'Home', text: 'x'.repeat(20) }, r.principal(LEO));
    expect(r.stored().map((entry) => entry.id)).toEqual(['fb_rej', 'fb_acc', fits.id]);
    // 21 more would make 121: the rejected one (50) goes, and nothing else.
    const next = await r.service.feedback.create({ note: 'Home', text: 'y'.repeat(21) }, r.principal(AMY));
    expect(r.stored().map((entry) => entry.id)).toEqual(['fb_acc', fits.id, next.id]);
    // 71 + 60 = 131, and 101 even without the accepted one: refused, and nothing is dropped for it.
    expect(await refused(r.service.feedback.create({ note: 'Home', text: 'z'.repeat(60) }, r.principal(MEI)))).toMatchObject({ detail: { reason: 'feedback-full', bound: 'stored' } });
    expect(r.stored().map((entry) => entry.id)).toEqual(['fb_acc', fits.id, next.id]);
  });
});

describe('withdraw and reject send nothing (D4.7)', { timeout: 30_000 }, () => {
  it('only the author withdraws, while it waits: removed at once (the audit keeps it), told as gone to every member', async () => {
    const r = await rig();
    const { feedback } = await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'Add a dark mode please.' });
    for (const other of [r.host, r.mei, r.amy]) expect((await refused(other.conn.request('sticky.feedback.withdraw', { feedbackId: feedback.id }))).code).toBe('forbidden');
    expect(r.audit.filter((entry) => entry.action === 'authz.denied' && entry.target === 'sticky.feedback.withdraw')).toHaveLength(3);
    const { feedback: withdrawn } = await r.leo.conn.request('sticky.feedback.withdraw', { feedbackId: feedback.id });
    expect(withdrawn).toEqual({ ...feedback, status: 'withdrawn' });
    expect(r.stored()).toEqual([]);
    expect((await r.host.conn.request('sticky.feedback.list', {})).feedback).toEqual([]);
    await settled(r);
    for (const name of ['host', 'mei', 'amy', 'leo'] as const) expect(r.told[name].at(-1), name).toEqual({ removed: feedback.id });
    expect(r.audit.filter((entry) => entry.action === 'sticky.feedback.withdraw')).toMatchObject([{ actor: { kind: 'user', userId: LEO }, target: feedback.id, detail: { outcome: 'withdrawn', feedback: 'Add a dark mode please.', authorUserId: LEO } }]);
    expect(await refused(r.leo.conn.request('sticky.feedback.withdraw', { feedbackId: feedback.id }))).toMatchObject({ code: 'not_found', text: { id: 'sticky.feedback.notFound' } });
    expect(r.fakes.agents.log.of('send')).toEqual([]);
  });

  it('a member with agent access rejects it with a reason; an Editor or a Viewer may not; a decided one cannot be withdrawn or decided again', async () => {
    const r = await rig();
    const { feedback } = await r.amy.conn.request('sticky.feedback.create', { note: 'Checkout', text: 'Take PayPal too.' });
    for (const other of [r.amy, r.leo]) expect((await refused(other.conn.request('sticky.feedback.reject', { feedbackId: feedback.id }))).code).toBe('forbidden');
    const { feedback: rejected } = await r.mei.conn.request('sticky.feedback.reject', { feedbackId: feedback.id, reason: 'Not this year' });
    expect(rejected).toMatchObject({ id: feedback.id, status: 'rejected', decidedBy: { userId: MEI, displayName: 'Mei' }, rejectReason: 'Not this year' });
    expect(typeof rejected.decidedAt).toBe('number');
    await settled(r);
    expect(r.told.leo.at(-1)).toEqual({ feedback: rejected });
    for (const attempt of [r.amy.conn.request('sticky.feedback.withdraw', { feedbackId: feedback.id }), r.host.conn.request('sticky.feedback.reject', { feedbackId: feedback.id }), r.host.conn.request('sticky.feedback.accept', { feedbackId: feedback.id })]) {
      expect(await refused(attempt)).toMatchObject({ code: 'conflict', detail: { reason: 'not-waiting', status: 'rejected' }, text: { id: 'sticky.feedback.notWaiting' } });
    }
    expect(r.audit.filter((entry) => entry.action === 'sticky.feedback.reject')).toMatchObject([{ actor: { kind: 'user', userId: MEI }, detail: { outcome: 'rejected', feedback: 'Take PayPal too.', rejectReason: 'Not this year' } }]);
    expect(r.fakes.agents.log.of('send')).toEqual([]);
  });
});

describe('a member who is removed takes their waiting feedback with them (D4.5)', { timeout: 30_000 }, () => {
  it('kicked: their waiting feedback is withdrawn by the system, audited so; what was decided stays; the others\' stays', async () => {
    const r = await rig();
    const one = (await r.amy.conn.request('sticky.feedback.create', { note: 'Home', text: 'first' })).feedback;
    const two = (await r.amy.conn.request('sticky.feedback.create', { note: 'Checkout', text: 'second' })).feedback;
    const decidedOne = (await r.amy.conn.request('sticky.feedback.create', { note: 'Home', text: 'decided' })).feedback;
    await r.host.conn.request('sticky.feedback.reject', { feedbackId: decidedOne.id });
    const leos = (await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'from Leo' })).feedback;
    await r.host.conn.request('admin.member.kick', { userId: AMY });
    await waitFor(() => r.stored().length === 2, { what: 'Amy\'s waiting feedback to go' });
    expect(r.stored().map((entry) => [entry.id, entry.status])).toEqual([[decidedOne.id, 'rejected'], [leos.id, 'waiting']]);
    const system = r.audit.filter((entry) => entry.action === 'sticky.feedback.withdraw');
    expect(system).toMatchObject([
      { actor: { kind: 'system' }, outcome: 'ok', target: one.id, detail: { reason: 'author-kicked', outcome: 'withdrawn', authorUserId: AMY, feedback: 'first' } },
      { actor: { kind: 'system' }, outcome: 'ok', target: two.id, detail: { reason: 'author-kicked', outcome: 'withdrawn', authorUserId: AMY, feedback: 'second' } },
    ]);
    // (Amy's connection was closed by the kick.)
    for (const name of ['host', 'mei', 'leo'] as const) await r[name].conn.request('sticky.feedback.list', {});
    expect(r.told.leo.slice(-2)).toEqual([{ removed: one.id }, { removed: two.id }]);
  });

  it('left the workspace: the same, with its own reason', async () => {
    const r = await rig();
    const mine = (await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'bye' })).feedback;
    await r.leo.conn.request('channel.leave', {});
    await waitFor(() => r.stored().length === 0, { what: 'Leo\'s waiting feedback to go' });
    expect(r.audit.filter((entry) => entry.action === 'sticky.feedback.withdraw')).toMatchObject([{ actor: { kind: 'system' }, target: mine.id, detail: { reason: 'author-left' } }]);
  });
});

describe('sticky.feedback.list: every entry, oldest first, by the list rule (D4.4)', { timeout: 120_000 }, () => {
  it(`${FEEDBACK_MAX} entries at the largest sticky.json holds (${FEEDBACK_STORED_MAX_CHARS} characters of three-byte text) come in several pages, all of them, in order`, async () => {
    const r = await rig();
    // The stored bound is the real bound of a list: 1000 entries of 2097 characters, about 6.3 MB of UTF-8.
    const chars = Math.floor(FEEDBACK_STORED_MAX_CHARS / FEEDBACK_MAX);
    const entries = Array.from({ length: FEEDBACK_MAX }, (_, i) => decided(`fb_${String(i).padStart(4, '0')}`, i % 2 === 0 ? 'rejected' : 'accepted', `${String(i).padStart(4, '0')}${'結'.repeat(chars - 4)}`));
    await r.store(entries);
    let pages = 0;
    const listed = await collectPages(async (after) => {
      pages += 1;
      const page = await r.leo.conn.request('sticky.feedback.list', after === undefined ? {} : { after });
      return { items: page.feedback, hasMore: page.hasMore };
    }, (entry) => entry.id);
    expect(listed.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    expect(listed[999]?.text).toBe(entries[999]?.text);
    expect(pages).toBeGreaterThan(1);
  });
});
