// N sticky notes: feedback (DESIGN 0.8.0 D4), through the REAL relay: the release composition of the daemon, the real
// `smurg hook` / `smurg mcp` commands and the scripted stand-in for Claude Code (never a `claude` of this computer),
// with SDK clients for the host, Mei (Agent access), Amy (an Editor) and Vic (a Viewer).
//
//   - a Viewer and an Editor give feedback on sticky notes; every member is told of it at once; it reaches no agent:
//     everything any agent process was given holds none of its text;
//   - neither of them, nor anyone else without agent access, can accept or reject it;
//   - a member with agent access accepts both: Claude for the sticky notes is told exactly the accepts' messages, under
//     her own header, each `composeFeedback` of its entry, and nothing else;
//   - a rejected one and a withdrawn one never reach it; the audit log names every step; the relay reads none of it.
//
// The steps are ONE story in order: each `it` continues where the one before stopped.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeFeedback, type AgentSession, type Feedback } from '@smurg/protocol';
import { findPlaintext } from '@smurg/relay/testing';
import { audited, everythingAgentsReceived, member, refusal, sessionReady, told, type Member } from '../src/flow.ts';
import { startStack, waitUntil, type Stack } from '../src/harness.ts';

/** A unique marker of well over 16 bytes: text the relay must never be able to read, and no agent before an accept. */
const marker = (label: string): string => `smurg-notes-${label}-${randomBytes(12).toString('hex')}`;
const M = {
  viewer: marker('VIEWER-FEEDBACK'),
  editor: marker('EDITOR-FEEDBACK'),
  rejected: marker('REJECTED-FEEDBACK'),
  withdrawn: marker('WITHDRAWN-FEEDBACK'),
  reason: marker('REJECT-REASON'),
};

let stack: Stack;
let host: Member;
let mei: Member;
let amy: Member;
let vic: Member;
let everyone: Member[];
let claude: AgentSession;
const made: Record<'viewer' | 'editor' | 'rejected' | 'withdrawn', Feedback> = {} as never;

const step = (title: string, run: () => Promise<void>): void => {
  it(title, run, 60_000);
};

/** Every `sticky.feedback.updated` a member's connection was sent (its listener is attached when they join). */
const updates = new Map<string, unknown[]>();
function listen(who: Member): Member {
  const list: unknown[] = [];
  updates.set(who.name, list);
  who.conn.on('sticky.feedback.updated', (payload) => list.push(payload));
  return who;
}
const updatesOf = (who: Member): unknown[] => updates.get(who.name) ?? [];

describe('N sticky notes: feedback, through the real relay (DESIGN 0.8.0 D4)', () => {
  beforeAll(async () => {
    stack = await startStack({
      claude: true,
      projectFiles: { 'README.md': '# Shop\n', 'notes/Home.md': '# Shop\n\nSee [[Checkout]].\n', 'notes/Checkout.md': 'Pay with a card.\n' },
    });
    host = listen(member(stack.hostClient, 'Host', 'host'));
    mei = listen(member(await stack.join({ name: 'mei', role: 'agent' }), 'Mei', 'agent'));
    amy = listen(member(await stack.join({ name: 'amy', role: 'editor' }), 'Amy', 'editor'));
    vic = listen(member(await stack.join({ name: 'vic', role: 'viewer' }), 'Vic', 'viewer'));
    everyone = [host, mei, amy, vic];
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
  }, 60_000);

  step('Mei starts Claude for the sticky notes; every member reads the index of the notes', async () => {
    claude = (await mei.conn.request('sticky.assistant.start', {})).session;
    expect(claude).toMatchObject({ purpose: 'notes', openedBy: { userId: mei.userId } });
    await sessionReady(host, claude.id);
    for (const one of everyone) expect((await one.conn.request('sticky.list', {})).notes.map((note) => note.name), one.name).toEqual(['Checkout', 'Home']);
    expect(await told(stack.claude!, claude.id)).toEqual([]);
  });

  step('a Viewer and an Editor give feedback; every member is told at once; no agent is given any of it', async () => {
    made.viewer = (await vic.conn.request('sticky.feedback.create', { note: 'Home', text: `Add a dark mode please. ${M.viewer}` })).feedback;
    made.editor = (await amy.conn.request('sticky.feedback.create', { note: 'checkout', text: `Take PayPal too.\n${M.editor}` })).feedback;
    made.rejected = (await vic.conn.request('sticky.feedback.create', { note: 'Checkout', text: `Make it pink. ${M.rejected}` })).feedback;
    made.withdrawn = (await amy.conn.request('sticky.feedback.create', { note: 'Home', text: `Never mind. ${M.withdrawn}` })).feedback;
    expect(made.viewer).toMatchObject({ note: 'Home', status: 'waiting', author: { kind: 'member', user: { userId: vic.userId, displayName: 'Vic' } } });
    expect(made.editor).toMatchObject({ note: 'Checkout', status: 'waiting', author: { kind: 'member', user: { userId: amy.userId } } });
    for (const one of everyone) {
      await waitUntil(() => updatesOf(one).length >= 4, 10_000, `the four entries at ${one.name}`);
      expect(updatesOf(one), one.name).toEqual([{ feedback: made.viewer }, { feedback: made.editor }, { feedback: made.rejected }, { feedback: made.withdrawn }]);
      expect((await one.conn.request('sticky.feedback.list', {})).feedback, one.name).toEqual([made.viewer, made.editor, made.rejected, made.withdrawn]);
    }
    const received = await everythingAgentsReceived(stack.claude!);
    for (const value of Object.values(M)) expect(received).not.toContain(value);
    expect(await told(stack.claude!, claude.id)).toEqual([]);
  });

  step('only a member with agent access decides: an Editor and a Viewer may neither accept nor reject; the author withdraws her own, and nobody else can', async () => {
    for (const one of [amy, vic]) {
      for (const type of ['sticky.feedback.accept', 'sticky.feedback.reject'] as const) expect(await refusal(one.conn.request(type, { feedbackId: made.viewer.id })), `${one.name} ${type}`).toMatchObject({ code: 'forbidden' });
    }
    expect(await refusal(vic.conn.request('sticky.feedback.withdraw', { feedbackId: made.withdrawn.id }))).toMatchObject({ code: 'forbidden' });
    expect((await amy.conn.request('sticky.feedback.withdraw', { feedbackId: made.withdrawn.id })).feedback.status).toBe('withdrawn');
    expect((await host.conn.request('sticky.feedback.reject', { feedbackId: made.rejected.id, reason: `Not this year. ${M.reason}` })).feedback).toMatchObject({ status: 'rejected', decidedBy: { userId: host.userId } });
    for (const one of everyone) await waitUntil(() => updatesOf(one).length >= 6, 10_000, `the withdrawal and the rejection at ${one.name}`);
    expect(updatesOf(vic).slice(4)).toMatchObject([{ removed: made.withdrawn.id }, { feedback: { id: made.rejected.id, status: 'rejected' } }]);
    const received = await everythingAgentsReceived(stack.claude!);
    for (const value of Object.values(M)) expect(received).not.toContain(value);
    expect(await told(stack.claude!, claude.id)).toEqual([]);
  });

  step('Mei accepts the Viewer\'s and the Editor\'s: Claude for the sticky notes is told exactly the two accepts\' messages, as Mei\'s own', async () => {
    const accepted = (await mei.conn.request('sticky.feedback.accept', { feedbackId: made.viewer.id })).feedback;
    expect(accepted).toMatchObject({ status: 'accepted', decidedBy: { userId: mei.userId, displayName: 'Mei' } });
    const first = composeFeedback({ note: 'Home', author: { kind: 'member', userId: vic.userId, displayName: 'Vic', role: 'viewer' }, text: made.viewer.text });
    await waitUntil(async () => (await told(stack.claude!, claude.id)).length === 1, 20_000, 'the first accept to reach Claude for the sticky notes');
    expect(await told(stack.claude!, claude.id)).toEqual([`[Mei · Agent access]\n${first}`]);
    // Nothing of the Editor's feedback has reached any agent yet; then Mei accepts it too.
    expect(await everythingAgentsReceived(stack.claude!)).not.toContain(M.editor);
    await mei.conn.request('sticky.feedback.accept', { feedbackId: made.editor.id });
    const second = composeFeedback({ note: 'Checkout', author: { kind: 'member', userId: amy.userId, displayName: 'Amy', role: 'editor' }, text: made.editor.text });
    await waitUntil(async () => (await told(stack.claude!, claude.id)).length === 2, 20_000, 'the second accept to reach Claude for the sticky notes');
    expect(await told(stack.claude!, claude.id)).toEqual([`[Mei · Agent access]\n${first}`, `[Mei · Agent access]\n${second}`]);
    expect(first).toBe(`Feedback on the sticky note "notes/Home.md", written by Vic (Viewer) and accepted by me. Work it into the sticky notes: change that note, or write a new sticky note and link it from that note.\n\`\`\`feedback\nAdd a dark mode please. ${M.viewer}\n\`\`\``);
    // What was rejected or withdrawn never reached it.
    const received = await everythingAgentsReceived(stack.claude!);
    for (const value of [M.rejected, M.withdrawn, M.reason]) expect(received).not.toContain(value);
    // An accepted one is never sent twice.
    expect(await refusal(host.conn.request('sticky.feedback.accept', { feedbackId: made.viewer.id }))).toMatchObject({ code: 'conflict', reason: 'not-waiting' });
    expect(await told(stack.claude!, claude.id)).toHaveLength(2);
    for (const one of everyone) {
      const list = (await one.conn.request('sticky.feedback.list', {})).feedback;
      expect(list.map((entry) => [entry.id, entry.status]), one.name).toEqual([[made.viewer.id, 'accepted'], [made.editor.id, 'accepted'], [made.rejected.id, 'rejected']]);
    }
  });

  step('the audit log names every step with who did it; the relay read none of the feedback', async () => {
    const entries = await audited(host.conn, 'sticky.feedback.create', 'sticky.feedback.accept', 'sticky.feedback.reject', 'sticky.feedback.withdraw');
    const of = (action: string): { readonly actor: unknown; readonly target?: string }[] => entries.filter((entry) => entry.action === action);
    expect(of('sticky.feedback.create').map((entry) => entry.target).sort()).toEqual([made.viewer.id, made.editor.id, made.rejected.id, made.withdrawn.id].sort());
    // Oldest first: the Viewer's, then the Editor's, each by Mei.
    expect(of('sticky.feedback.accept')).toMatchObject([
      { actor: { kind: 'user', userId: mei.userId }, target: made.viewer.id },
      { actor: { kind: 'user', userId: mei.userId }, target: made.editor.id },
    ]);
    expect(of('sticky.feedback.reject')).toMatchObject([{ actor: { kind: 'user', userId: host.userId }, target: made.rejected.id }]);
    expect(of('sticky.feedback.withdraw')).toMatchObject([{ actor: { kind: 'user', userId: amy.userId }, target: made.withdrawn.id }]);
    const tap = stack.tap;
    if (tap === undefined) throw new Error('the stack of this story records at the relay');
    await tap.waitForQuiet(500, 20_000);
    const all = tap.frames().filter((frame) => frame.workspaceId === stack.workspaceId || frame.direction === 'request');
    for (const [name, value] of Object.entries(M)) expect(findPlaintext(all, value), `marker ${name} at the relay`).toEqual([]);
  });
});
