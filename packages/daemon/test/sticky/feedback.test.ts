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
  FEEDBACK_TEXT_MAX_CHARS,
  FEEDBACK_WAITING_FROM_MEMBERS_MAX,
  FEEDBACK_WAITING_FROM_OUTSIDE_MAX,
  FEEDBACK_WAITING_PER_MEMBER_MAX,
  FEEDBACK_WAITING_PER_OUTSIDER_MAX,
  collectPages,
  feedbackStoredChars,
  type AuditEntry,
  type Feedback,
  type PayloadOf,
  type SmurgError,
} from '@smurg/protocol';
import { AUDIT_FULL_TEXT_HEAD_CHARS, type Principal } from '../../src/core/interfaces.ts';
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

  it(`the text is bounded once it is cleaned: ${FEEDBACK_TEXT_MAX_CHARS} characters that need no cleaning are stored; fewer that grow past it when a header look-alike is quoted are refused, and nothing is stored`, async () => {
    const r = await rig();
    const full = 'a'.repeat(FEEDBACK_TEXT_MAX_CHARS);
    const { feedback } = await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: full });
    expect(feedback.text).toBe(full);
    // The wire takes these 3,999 characters; agentText puts "> " in front of the first line, which makes 4,001.
    const header = '[Ian · Host]\n';
    const grows = `${header}${'b'.repeat(FEEDBACK_TEXT_MAX_CHARS - 1 - header.length)}`;
    expect(grows).toHaveLength(FEEDBACK_TEXT_MAX_CHARS - 1);
    expect(await refused(r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: grows }))).toMatchObject({ code: 'bad_request', detail: { reason: 'invalid-text' }, text: { id: 'sticky.feedback.invalidText' } });
    expect(r.stored()).toEqual([feedback]);
  });

  it('a long feedback is audited whole, as a suggestion is: the entry keeps its head, its length and its hash, and the full-text store holds every character; so does the decision on it', async () => {
    const r = await rig();
    // Longer than the head an audit entry keeps, and than the 2,000 characters of an ordinary audit string.
    const long = Array.from({ length: 200 }, (_, i) => `Idea ${String(i).padStart(3, '0')}: a dark mode.`).join(' ').slice(0, 3_000);
    expect(long.length).toBeGreaterThan(Math.max(AUDIT_FULL_TEXT_HEAD_CHARS, 2_000));
    const { feedback } = await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: long });
    expect(feedback.text).toBe(long);
    await r.mei.conn.request('sticky.feedback.reject', { feedbackId: feedback.id, reason: 'Not this year' });
    const head = `${long.slice(0, AUDIT_FULL_TEXT_HEAD_CHARS)}…`;
    for (const action of ['sticky.feedback.create', 'sticky.feedback.reject'] as const) {
      const entries = r.audit.filter((entry) => entry.action === action);
      expect(entries, action).toHaveLength(1);
      expect(entries[0]?.detail, action).toMatchObject({ feedback: head, feedbackChars: long.length });
      expect(await r.t.ctx.audit.fullText(entries[0]?.detail?.['feedbackSha256'] as string), action).toBe(long);
    }
  });
});

describe('the bounds of D4.5, one by one', { timeout: 60_000 }, () => {
  it('are the protocol\'s numbers by default', () => {
    // 0.8.0 S8 (DESIGN 0.8.0 D4.5, D6.3): the outside budgets came with the sources, 20 per person outside and 200
    // from outside together.
    expect(DEFAULT_FEEDBACK_LIMITS).toEqual({
      waitingPerMember: FEEDBACK_WAITING_PER_MEMBER_MAX,
      waitingFromMembers: FEEDBACK_WAITING_FROM_MEMBERS_MAX,
      maxEntries: FEEDBACK_MAX,
      maxStoredChars: FEEDBACK_STORED_MAX_CHARS,
      waitingPerOutsider: FEEDBACK_WAITING_PER_OUTSIDER_MAX,
      waitingFromOutside: FEEDBACK_WAITING_FROM_OUTSIDE_MAX,
    });
    expect([FEEDBACK_WAITING_PER_MEMBER_MAX, FEEDBACK_WAITING_FROM_MEMBERS_MAX, FEEDBACK_MAX, FEEDBACK_STORED_MAX_CHARS, FEEDBACK_WAITING_PER_OUTSIDER_MAX, FEEDBACK_WAITING_FROM_OUTSIDE_MAX]).toEqual([20, 300, 1000, 2 * 1024 * 1024, 20, 200]);
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

  it('a reason given with a reject counts too: the oldest decided entries make room for it as for a text (never a waiting one, never the entry rejected), each told as gone first', async () => {
    const r = await rig({ sticky: { feedbackLimits: { maxStoredChars: 100 } } });
    await r.store([decided('fb_acc', 'accepted', 'a'.repeat(20)), decided('fb_rej', 'rejected', 'r'.repeat(20))]);
    const leos = await r.service.feedback.create({ note: 'Home', text: 'x'.repeat(30) }, r.principal(LEO));
    const amys = await r.service.feedback.create({ note: 'Home', text: 'y'.repeat(25) }, r.principal(AMY));
    // 95 characters; a reason of 10 makes 105: the rejected entry (20) goes, and nothing else.
    const rejected = await r.service.feedback.reject({ feedbackId: leos.id, reason: 'Not now...' }, r.principal(MEI));
    expect(rejected).toMatchObject({ id: leos.id, status: 'rejected', rejectReason: 'Not now...' });
    expect(r.stored().map((entry) => [entry.id, entry.status])).toEqual([['fb_acc', 'accepted'], [leos.id, 'rejected'], [amys.id, 'waiting']]);
    // 85; a reason of 40 makes 125: Leo's rejected entry (40) goes, the oldest rejected, before the accepted one.
    await r.service.feedback.reject({ feedbackId: amys.id, reason: 'n'.repeat(40) }, r.principal(TEST_HOST_USER));
    expect(r.stored().map((entry) => [entry.id, entry.status])).toEqual([['fb_acc', 'accepted'], [amys.id, 'rejected']]);
    expect(r.stored().reduce((sum, entry) => sum + feedbackStoredChars(entry), 0)).toBe(85);
    await settled(r);
    expect(r.told.leo.map((event) => ('removed' in event ? `-${event.removed}` : `+${event.feedback.id}:${event.feedback.status}`))).toEqual([
      `+${leos.id}:waiting`,
      `+${amys.id}:waiting`,
      '-fb_rej',
      `+${leos.id}:rejected`,
      `-${leos.id}`,
      `+${amys.id}:rejected`,
    ]);
  });

  it('a reject whose reason cannot fit (only waiting feedback is left) is refused and changes nothing; without a reason it goes through', async () => {
    const r = await rig({ sticky: { feedbackLimits: { maxStoredChars: 100 } } });
    const one = await r.service.feedback.create({ note: 'Home', text: 'x'.repeat(50) }, r.principal(LEO));
    const two = await r.service.feedback.create({ note: 'Home', text: 'y'.repeat(45) }, r.principal(AMY));
    expect(await refused(r.service.feedback.reject({ feedbackId: one.id, reason: 'Not now' }, r.principal(MEI)))).toMatchObject({ code: 'conflict', detail: { reason: 'feedback-full', bound: 'stored' }, text: { id: 'sticky.feedback.full' } });
    expect(r.stored()).toEqual([one, two]);
    expect(r.audit.filter((entry) => entry.action === 'sticky.feedback.reject')).toEqual([]);
    expect(await r.service.feedback.reject({ feedbackId: one.id }, r.principal(MEI))).toMatchObject({ id: one.id, status: 'rejected' });
    expect(r.stored().map((entry) => [entry.id, entry.status, entry.rejectReason])).toEqual([[one.id, 'rejected', undefined], [two.id, 'waiting', undefined]]);
  });

  it(`at the real bound: a reject with a reason when sticky.json holds ${FEEDBACK_STORED_MAX_CHARS} characters but five makes room, instead of failing`, async () => {
    const r = await rig();
    // Rejected entries of 4,000 characters (the last shorter), then Leo's waiting 1,000: five under the bound.
    const filler = FEEDBACK_STORED_MAX_CHARS - 5 - 1_000;
    const old = Array.from({ length: Math.ceil(filler / FEEDBACK_TEXT_MAX_CHARS) }, (_, i) =>
      decided(`fb_${String(i).padStart(4, '0')}`, 'rejected', 'd'.repeat(Math.min(FEEDBACK_TEXT_MAX_CHARS, filler - i * FEEDBACK_TEXT_MAX_CHARS))),
    );
    await r.store(old);
    const { feedback } = await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'w'.repeat(1_000) });
    const total = (): number => r.stored().reduce((sum, entry) => sum + feedbackStoredChars(entry), 0);
    expect(total()).toBe(FEEDBACK_STORED_MAX_CHARS - 5);
    const reason = 'We will not add a dark mode this year.';
    const { feedback: rejected } = await r.mei.conn.request('sticky.feedback.reject', { feedbackId: feedback.id, reason });
    expect(rejected).toMatchObject({ id: feedback.id, status: 'rejected', rejectReason: reason });
    expect(r.stored().map((entry) => entry.id)).toEqual([...old.slice(1).map((entry) => entry.id), feedback.id]);
    expect(total()).toBe(FEEDBACK_STORED_MAX_CHARS - 5 + reason.length - FEEDBACK_TEXT_MAX_CHARS);
  });
});

describe('withdraw and reject send nothing (D4.7)', { timeout: 30_000 }, () => {
  it('only the author withdraws, while it waits: removed at once (the audit keeps it), told as gone to every member', async () => {
    const r = await rig();
    const { feedback } = await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'Add a dark mode please.' });
    // The router's audited refusal of the handler's author rule (ARCHITECTURE §5.12's row): `forbidden`, reason
    // `not-owner:feedback`; the service's own check (`sticky.feedback.authorOnly`) is the second lock behind it.
    for (const other of [r.host, r.mei, r.amy]) expect(await refused(other.conn.request('sticky.feedback.withdraw', { feedbackId: feedback.id }))).toMatchObject({ code: 'forbidden', detail: { reason: 'not-owner:feedback' } });
    expect(await refused(r.service.feedback.withdraw({ feedbackId: feedback.id }, r.principal(MEI)))).toMatchObject({ code: 'forbidden', text: { id: 'sticky.feedback.authorOnly' } });
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

  it('a page after an entry that went meanwhile goes on after where it was, whichever way it went; an id the list never had starts from the first entry', async () => {
    const r = await rig({ sticky: { feedbackLimits: { maxEntries: 6 } } });
    await r.store([decided('fb_rej', 'rejected', 'old')]);
    const make = (who: string, text: string): Promise<Feedback> => r.service.feedback.create({ note: 'Home', text }, r.principal(who));
    const a = await make(LEO, 'a');
    const b = await make(LEO, 'b');
    const c = await make(AMY, 'c');
    const d = await make(AMY, 'd');
    await make(MEI, 'e');
    const after = async (id: string): Promise<string[]> => (await r.leo.conn.request('sticky.feedback.list', { after: id })).feedback.map((entry) => entry.text);
    // Withdrawn by its author: the next page starts at c, not again at the first entry.
    await r.service.feedback.withdraw({ feedbackId: b.id }, r.principal(LEO));
    expect(await after(b.id)).toEqual(['c', 'd', 'e']);
    // The entry before it went too: still after where b was.
    await r.service.feedback.withdraw({ feedbackId: a.id }, r.principal(LEO));
    expect(await after(b.id)).toEqual(['c', 'd', 'e']);
    expect(await after(a.id)).toEqual(['c', 'd', 'e']);
    // Dropped at the bound of entries (the oldest rejected, the first entry): every entry kept came after it.
    await make(MEI, 'f');
    await make(MEI, 'g');
    await make(MEI, 'h');
    expect(r.stored().map((entry) => entry.text)).toEqual(['c', 'd', 'e', 'f', 'g', 'h']);
    expect(await after('fb_rej')).toEqual(['c', 'd', 'e', 'f', 'g', 'h']);
    expect(await after(b.id)).toEqual(['c', 'd', 'e', 'f', 'g', 'h']);
    // Withdrawn by the system (Amy is kicked): after where c and d were.
    await r.host.conn.request('admin.member.kick', { userId: AMY });
    await waitFor(() => r.stored().length === 4, { what: 'Amy\'s waiting feedback to go' });
    expect(await after(d.id)).toEqual(['e', 'f', 'g', 'h']);
    expect(await after(c.id)).toEqual(['e', 'f', 'g', 'h']);
    // An id the list never had: the list rule, from the first entry.
    expect(await after('fb_nope')).toEqual(['e', 'f', 'g', 'h']);
  });

  it('an entry withdrawn between two pages of a long list: the next page goes on after it, so a reader gets every entry once, in order', async () => {
    const r = await rig();
    // 400 waiting entries of Leo's, 4,000 three-byte characters each: about 4.8 MB, more than one page.
    const entries = Array.from(
      { length: 400 },
      (_, i): Feedback => ({
        id: `fb_${String(i).padStart(4, '0')}`,
        note: 'Home',
        text: `${String(i).padStart(4, '0')}${'結'.repeat(FEEDBACK_TEXT_MAX_CHARS - 4)}`,
        author: { kind: 'member', user: { userId: LEO, displayName: 'Leo' } },
        status: 'waiting',
        createdAt: T,
      }),
    );
    await r.store(entries);
    let pages = 0;
    const withdrawn: string[] = [];
    const listed = await collectPages(async (after) => {
      pages += 1;
      const page = await r.leo.conn.request('sticky.feedback.list', after === undefined ? {} : { after });
      if (pages === 1) {
        // The last entry of the first page, then the one before it, are withdrawn before the next page is asked for.
        for (const entry of page.feedback.slice(-2).reverse()) {
          await r.leo.conn.request('sticky.feedback.withdraw', { feedbackId: entry.id });
          withdrawn.push(entry.id);
        }
      }
      return { items: page.feedback, hasMore: page.hasMore };
    }, (entry) => entry.id);
    expect(pages).toBeGreaterThan(1);
    expect(withdrawn).toHaveLength(2);
    // The first page held the two before they went; after it, every entry once.
    expect(listed.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
  });
});
