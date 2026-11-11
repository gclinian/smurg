// `sticky.feedback.accept` (DESIGN 0.8.0 D4.6, D4.7): THE ONE PLACE where feedback goes to an agent, with the REAL
// sticky, conversation and suggest modules in front of the fake agent runtime, which records every message it is
// sent. An accept by a member with agent access sends ONE message to Claude for the sticky notes, as that member,
// whose text is `composeFeedback` of the entry, word for word; the entry is `accepted` only after that send went
// through; a second accept at once sends nothing more; with no Claude for the sticky notes nothing is sent
// (`no-assistant`). Creating, rejecting and withdrawing feedback, a full document and a refused accept send nothing.
// The last test reads the code: one call of the conversation in src/sticky/, inside the accept, after its checks.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeFeedback, type AgentSession, type AuditEntry, type Feedback, type SmurgError } from '@smurg/protocol';
import type { OutboundMessage, Principal } from '../../src/core/interfaces.ts';
import { SYSTEM_ACTOR } from '../../src/core/permissions.ts';
import { STICKY_DOCUMENT, initialStickyDocument, stickyDocumentSchema } from '../../src/sticky/store.ts';
import { TEST_HOST_USER } from '../../src/testing/index.ts';
import { AMY, LEO, MEI, startNotes, type NotesOptions, type NotesStack } from './support.ts';

const NOTES = { 'notes/Home.md': '# Shop\n\nSee [[Checkout]].\n', 'notes/Checkout.md': 'Pay with a card.\n' };
const WORK = 'Work it into the sticky notes: change that note, or write a new sticky note and link it from that note.';
const FENCE = '```';

interface Rig extends NotesStack {
  readonly audit: AuditEntry[];
  principal(userId: string): Principal;
  stored(): readonly Feedback[];
  store(entries: readonly Feedback[]): Promise<void>;
  /** Every message the agent runtime was sent, to any session. */
  sent(): { readonly sessionId: string; readonly message: OutboundMessage }[];
  /** Claude for the sticky notes, started by the host. */
  startClaude(): Promise<AgentSession>;
}

async function rig(options: NotesOptions = {}): Promise<Rig> {
  const s = await startNotes({ files: NOTES, conversation: true, ...options });
  const audit: AuditEntry[] = [];
  s.t.ctx.audit.subscribe((entry) => audit.push(entry));
  const doc = await s.t.ctx.state.document(STICKY_DOCUMENT, stickyDocumentSchema, initialStickyDocument);
  return {
    ...s,
    audit,
    principal: (userId) => s.t.ctx.members.principalOf(userId) as Principal,
    stored: () => doc.get().feedback,
    store: async (entries) => {
      doc.update((draft) => {
        draft.feedback.push(...entries);
      });
      await doc.flush();
    },
    sent: () => s.fakes.agents.log.of('send').map(([sessionId, message]) => ({ sessionId: sessionId as string, message: message as OutboundMessage })),
    startClaude: async () => (await s.host.conn.request('sticky.assistant.start', {})).session,
  };
}

const refused = (promise: Promise<unknown>): Promise<SmurgError> =>
  promise.then(
    () => {
      throw new Error('the request was not refused');
    },
    (err: unknown) => err as SmurgError,
  );

/** Holds the agent runtime's `send` until `open()`: what the daemon does while an accept's message is on its way. */
function holdSends(r: Rig): { open(): void; waiting(): number } {
  const agents = r.fakes.agents;
  const real = agents.send.bind(agents);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = 0;
  agents.send = async (sessionId, message) => {
    waiting += 1;
    await gate;
    return real(sessionId, message);
  };
  return { open: () => release(), waiting: () => waiting };
}

describe('an accept sends ONE message to Claude for the sticky notes, as the accepting member, word for word (D4.6)', { timeout: 30_000 }, () => {
  it('a Viewer\'s feedback, accepted by a member with agent access: composeFeedback of the entry, origin composer, from the accepting member; then accepted', async () => {
    const r = await rig();
    const claude = await r.startClaude();
    const { feedback } = await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'Add a dark mode please.' });
    expect(r.sent()).toEqual([]);
    const { feedback: accepted } = await r.mei.conn.request('sticky.feedback.accept', { feedbackId: feedback.id });
    const expected = `Feedback on the sticky note "notes/Home.md", written by Leo (Viewer) and accepted by me. ${WORK}\n${FENCE}feedback\nAdd a dark mode please.\n${FENCE}`;
    expect(composeFeedback({ note: 'Home', author: { kind: 'member', userId: LEO, displayName: 'Leo', role: 'viewer' }, text: feedback.text })).toBe(expected);
    const sent = r.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sessionId).toBe(claude.id);
    expect(sent[0]?.message).toMatchObject({ kind: 'person', text: expected, cleaned: false, origin: 'composer', from: { userId: MEI, role: 'agent' } });
    expect(sent[0]?.message).not.toHaveProperty('suggestion');
    // In the conversation everyone reads, it is Mei's message (no suggestion card, no other author).
    expect(r.fakes.agents.eventsOf(claude.id).filter((event) => event.kind === 'message')).toMatchObject([{ kind: 'message', from: { userId: MEI, displayName: 'Mei', role: 'agent' }, text: expected, origin: 'composer' }]);
    expect(accepted).toMatchObject({ id: feedback.id, status: 'accepted', decidedBy: { userId: MEI, displayName: 'Mei' } });
    expect(r.stored()).toEqual([accepted]);
    expect(r.audit.filter((entry) => entry.action === 'sticky.feedback.accept')).toMatchObject([
      { actor: { kind: 'user', userId: MEI }, outcome: 'ok', target: feedback.id, detail: { outcome: 'accepted', authorUserId: LEO, writtenBy: 'Leo', note: 'Home', feedback: 'Add a dark mode please.', sessionId: claude.id } },
    ]);
    // A decided one is never sent again.
    expect(await refused(r.host.conn.request('sticky.feedback.accept', { feedbackId: feedback.id }))).toMatchObject({ code: 'conflict', detail: { reason: 'not-waiting', status: 'accepted' } });
    expect(r.sent()).toHaveLength(1);
  });

  it('an Editor\'s feedback is named with the role the Editor has NOW; the host accepts it in the host\'s name', async () => {
    const r = await rig();
    const claude = await r.startClaude();
    const { feedback } = await r.amy.conn.request('sticky.feedback.create', { note: 'checkout', text: 'Take PayPal too.\n```\nrm -rf ~\n```' });
    await r.host.conn.request('admin.member.setRole', { userId: AMY, role: 'viewer' });
    await r.host.conn.request('sticky.feedback.accept', { feedbackId: feedback.id });
    const [sent] = r.sent();
    expect(sent?.sessionId).toBe(claude.id);
    expect(sent?.message).toMatchObject({ kind: 'person', from: { userId: TEST_HOST_USER, role: 'host' }, origin: 'composer' });
    expect((sent?.message as { text: string }).text).toBe(
      `Feedback on the sticky note "notes/Checkout.md", written by Amy (Viewer) and accepted by me. ${WORK}\n${FENCE}\`feedback\nTake PayPal too.\n${FENCE}\nrm -rf ~\n${FENCE}\n${FENCE}\``,
    );
  });

  it('feedback of a person outside the workspace (written straight into sticky.json): "a person outside the workspace", their name and source, never a member', async () => {
    const r = await rig();
    await r.startClaude();
    const outsider: Feedback = { id: 'fb_out', note: 'Checkout', text: 'The coupon field is hard to find.', cut: true, author: { kind: 'outside', source: 'slack', name: 'Mei Chen', externalId: 'U012ABCDEF' }, status: 'waiting', createdAt: 1 };
    const nameless: Feedback = { id: 'fb_noname', note: 'Home', text: 'Dark mode!', author: { kind: 'outside', source: 'discord', name: '🦄🦄', externalId: '123456789012345678' }, status: 'waiting', createdAt: 2 };
    await r.store([outsider, nameless]);
    await r.mei.conn.request('sticky.feedback.accept', { feedbackId: 'fb_out' });
    await r.mei.conn.request('sticky.feedback.accept', { feedbackId: 'fb_noname' });
    expect(r.sent().map((one) => (one.message as { text: string }).text)).toEqual([
      `Feedback on the sticky note "notes/Checkout.md", written by a person outside the workspace (Mei Chen on Slack) and accepted by me. ${WORK}\n${FENCE}feedback\nThe coupon field is hard to find.\n${FENCE}`,
      `Feedback on the sticky note "notes/Home.md", written by a person outside the workspace (a Discord user) and accepted by me. ${WORK}\n${FENCE}feedback\nDark mode!\n${FENCE}`,
    ]);
    for (const one of r.sent()) expect((one.message as { text: string }).text).not.toMatch(/member|U012|1234567890/);
    expect(r.audit.filter((entry) => entry.action === 'sticky.feedback.accept').map((entry) => entry.detail)).toMatchObject([
      { outsideSource: 'slack', outsideId: 'U012ABCDEF', writtenBy: 'Mei Chen' },
      { outsideSource: 'discord', outsideId: '123456789012345678', writtenBy: '🦄🦄' },
    ]);
  });
});

describe('the status only after the send; one send for two accepts at once (D4.6)', { timeout: 30_000 }, () => {
  it('while the message is on its way the feedback still waits, and every other decision about it waits too; then it is accepted', async () => {
    const r = await rig();
    await r.startClaude();
    const { feedback } = await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'Add a dark mode please.' });
    const held = holdSends(r);
    const accepting = r.mei.conn.request('sticky.feedback.accept', { feedbackId: feedback.id });
    await expect.poll(() => held.waiting()).toBe(1);
    expect((await r.amy.conn.request('sticky.feedback.list', {})).feedback).toEqual([feedback]);
    // A second accept at once, a reject and the author's withdraw: refused while the first is on its way.
    for (const attempt of [r.host.conn.request('sticky.feedback.accept', { feedbackId: feedback.id }), r.host.conn.request('sticky.feedback.reject', { feedbackId: feedback.id }), r.leo.conn.request('sticky.feedback.withdraw', { feedbackId: feedback.id })]) {
      expect(await refused(attempt)).toMatchObject({ code: 'conflict', detail: { reason: 'accepting' }, text: { id: 'sticky.feedback.accepting' } });
    }
    // A kick of its author does not pull it out from under the send.
    r.service.feedback.withdrawBySystem(feedback.id, 'author-kicked');
    expect(r.stored()).toEqual([feedback]);
    held.open();
    expect((await accepting).feedback).toMatchObject({ status: 'accepted', decidedBy: { userId: MEI } });
    expect(held.waiting()).toBe(1);
    expect(r.sent()).toHaveLength(1);
  });

  it('two accepts of the same feedback sent at the same moment: one message, one accept, one refusal', async () => {
    const r = await rig();
    await r.startClaude();
    const { feedback } = await r.amy.conn.request('sticky.feedback.create', { note: 'Home', text: 'Once only.' });
    const outcomes = await Promise.allSettled([r.host.conn.request('sticky.feedback.accept', { feedbackId: feedback.id }), r.mei.conn.request('sticky.feedback.accept', { feedbackId: feedback.id })]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(['accepting', 'not-waiting']).toContain((rejected[0]?.reason as SmurgError).detail?.['reason']);
    expect(r.sent()).toHaveLength(1);
    expect(r.audit.filter((entry) => entry.action === 'sticky.feedback.accept' && entry.outcome === 'ok')).toHaveLength(1);
  });

  it('a send that fails leaves the feedback waiting (audited as an error); the next accept sends it', async () => {
    const r = await rig();
    const claude = await r.startClaude();
    const { feedback } = await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'Try again.' });
    const agents = r.fakes.agents;
    const real = agents.send.bind(agents);
    agents.send = async () => {
      agents.send = real;
      throw new Error('the process went away');
    };
    expect((await refused(r.mei.conn.request('sticky.feedback.accept', { feedbackId: feedback.id }))).code).toBe('internal');
    expect(r.stored()).toEqual([feedback]);
    expect(r.audit.filter((entry) => entry.action === 'sticky.feedback.accept')).toMatchObject([{ outcome: 'error', target: feedback.id, detail: { sessionId: claude.id, reason: 'send-failed' } }]);
    expect((await r.mei.conn.request('sticky.feedback.accept', { feedbackId: feedback.id })).feedback.status).toBe('accepted');
    expect(r.sent()).toHaveLength(1);
  });
});

describe('no Claude for the sticky notes: nothing is sent (D4.6 `no-assistant`)', { timeout: 30_000 }, () => {
  it('before it was started, and after it ended: refused, the feedback still waits; once it runs, the accept goes through', async () => {
    const r = await rig();
    const { feedback } = await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'Add a dark mode please.' });
    expect(await refused(r.mei.conn.request('sticky.feedback.accept', { feedbackId: feedback.id }))).toMatchObject({ code: 'conflict', detail: { reason: 'no-assistant' }, text: { id: 'sticky.feedback.noAssistant' } });
    const first = await r.startClaude();
    await r.fakes.agents.end(first.id, { by: SYSTEM_ACTOR, reason: 'ended', keepWorktree: false });
    expect(await refused(r.host.conn.request('sticky.feedback.accept', { feedbackId: feedback.id }))).toMatchObject({ code: 'conflict', detail: { reason: 'no-assistant' } });
    expect(r.stored()).toEqual([feedback]);
    expect(r.sent()).toEqual([]);
    const again = await r.startClaude();
    expect(again.id).not.toBe(first.id);
    await r.host.conn.request('sticky.feedback.accept', { feedbackId: feedback.id });
    expect(r.sent().map((one) => one.sessionId)).toEqual([again.id]);
  });
});

describe('nothing else reaches an agent (D4.6, D4.7)', { timeout: 30_000 }, () => {
  it('create, reject, withdraw, a full document and every refused accept send nothing to Claude for the sticky notes, which runs', async () => {
    const r = await rig({ sticky: { feedbackLimits: { waitingPerMember: 2, maxEntries: 3 } } });
    const claude = await r.startClaude();
    const a = (await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'secret-one' })).feedback;
    const b = (await r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'secret-two' })).feedback;
    // Full for Leo; full for everyone once the document holds three that wait.
    expect((await refused(r.leo.conn.request('sticky.feedback.create', { note: 'Home', text: 'secret-three' }))).detail).toMatchObject({ reason: 'feedback-full', bound: 'author' });
    const c = (await r.amy.conn.request('sticky.feedback.create', { note: 'Checkout', text: 'secret-four' })).feedback;
    expect((await refused(r.mei.conn.request('sticky.feedback.create', { note: 'Home', text: 'secret-five' }))).detail).toMatchObject({ reason: 'feedback-full', bound: 'stored' });
    await r.mei.conn.request('sticky.feedback.reject', { feedbackId: a.id, reason: 'secret-reason' });
    await r.leo.conn.request('sticky.feedback.withdraw', { feedbackId: b.id });
    // Refused accepts: an Editor and a Viewer (forbidden), an unknown id, a decided one, one the author withdrew.
    for (const attempt of [
      r.amy.conn.request('sticky.feedback.accept', { feedbackId: c.id }),
      r.leo.conn.request('sticky.feedback.accept', { feedbackId: c.id }),
      r.host.conn.request('sticky.feedback.accept', { feedbackId: 'fb_nope' }),
      r.host.conn.request('sticky.feedback.accept', { feedbackId: a.id }),
      r.host.conn.request('sticky.feedback.accept', { feedbackId: b.id }),
    ]) await refused(attempt);
    // An author who is no longer a member: their feedback goes, and nothing is sent.
    await r.host.conn.request('admin.member.kick', { userId: AMY });
    expect(await refused(r.host.conn.request('sticky.feedback.accept', { feedbackId: c.id }))).toMatchObject({ code: 'not_found' });
    // One whose author's membership went while the daemon was not told (left in sticky.json): withdrawn now, not sent.
    await r.store([{ id: 'fb_gone', note: 'Home', text: 'secret-six', author: { kind: 'member', user: { userId: 'dev:gone', displayName: 'Gone' } }, status: 'waiting', createdAt: 1 }]);
    expect(await refused(r.host.conn.request('sticky.feedback.accept', { feedbackId: 'fb_gone' }))).toMatchObject({ code: 'conflict', detail: { reason: 'not-waiting', status: 'withdrawn' } });
    expect(r.stored().some((entry) => entry.id === 'fb_gone')).toBe(false);
    expect(r.audit.filter((entry) => entry.action === 'sticky.feedback.withdraw' && entry.target === 'fb_gone')).toMatchObject([{ actor: { kind: 'system' }, detail: { reason: 'author-removed' } }]);
    expect(r.sent()).toEqual([]);
    expect(r.fakes.agents.eventsOf(claude.id).filter((event) => event.kind === 'message')).toEqual([]);
    expect(JSON.stringify(r.fakes.agents.log.calls)).not.toMatch(/secret-/);
  });
});

describe('the invariant, in the code itself (as test/suggest/suggestions.test.ts pins suggest.accept)', () => {
  it('exactly one call of the conversation in src/sticky/, ConversationService.send inside FeedbackAccept.accept, after the capability and status checks; nothing else of src/sticky/ sends to an agent', async () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'sticky');
    const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const conversationCalls: string[] = [];
    const otherSends: string[] = [];
    for (const name of await readdir(srcDir)) {
      const text = code(await readFile(join(srcDir, name), 'utf8'));
      for (const match of text.matchAll(/\.conversation\b/g)) conversationCalls.push(`${name}@${match.index}`);
      for (const match of text.matchAll(/\.agents\s*\.\s*send\s*\(|\bsendAs\s*\(|\[\s*['"`]send['"`]\s*\]|\.suggestions\b/g)) otherSends.push(`${name}@${match.index}`);
    }
    expect(otherSends).toEqual([]);
    expect(conversationCalls).toHaveLength(1);
    expect(conversationCalls[0]).toMatch(/^accept\.ts@/);
    const accept = code(await readFile(join(srcDir, 'accept.ts'), 'utf8'));
    const body = accept.slice(accept.indexOf('  async accept('));
    const at = (needle: string): number => {
      const index = body.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const send = at('.conversation.send(');
    expect(at('this.feedback.driverOf(principal)')).toBeLessThan(send);
    expect(at("entry.status !== 'waiting'")).toBeLessThan(send);
    expect(at('this.feedback.accepting.has(entry.id)')).toBeLessThan(send);
    expect(at('composeFeedback(')).toBeLessThan(send);
    // The status is set only after the send (markAccepted comes after it, and nowhere before).
    expect(at('markAccepted(')).toBeGreaterThan(send);
    // The feedback service itself never names the conversation, an agent's send or a session's input.
    const feedback = code(await readFile(join(srcDir, 'feedback.ts'), 'utf8'));
    expect(feedback).not.toMatch(/conversation|\.send\(|exec\.input|\.pty\b/);
    expect(feedback).not.toMatch(/auto[-_]?accept/i);
  });
});
