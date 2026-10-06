// The suggestion card by who looks at it (UX §5.3, DESIGN §5.12 item 15): members with agent access accept (as it
// is, or edited) or reject; the author edits or withdraws; everyone else reads whom it waits for.
import { act, fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, settledError, type ConversationEvent, type Suggestion } from '@smurg/protocol';
import { buildEvent, buildInboxItem, buildSuggestion, FAKE_NOW } from '@smurg/protocol/testing';
import type { CommandMap } from '../../lib/commands.ts';
import { AMY, IAN, MEI, SID, openConversation, settle, type Scene } from './test-support.tsx';

const CARD: ConversationEvent[] = [buildEvent('card', { seq: 1, card: 'suggestion', id: 'sg_1' })];

async function openSuggestion(suggestion: Partial<Suggestion>, scene: Scene = {}) {
  const view = await openConversation({
    events: CARD,
    ...scene,
    reply: { suggestions: [buildSuggestion({ id: 'sg_1', sessionId: SID, author: AMY, text: 'Use the **session** store', ...suggestion })] },
  });
  return { ...view, card: document.getElementById('conv-card-sg_1') as HTMLElement };
}

describe('suggestion card', () => {
  it('a member with agent access accepts it as it is, or edits it first', async () => {
    const view = await openSuggestion({ cleaned: true }, { role: 'agent' });
    const { card } = view;
    expect(within(card).getByRole('heading', { level: 3, name: 'Suggestion from Amy' })).toBeTruthy();
    expect(card.querySelector('.conv-sug__text strong')?.textContent).toBe('session');
    expect(card.textContent).toContain('Hidden characters were removed.');
    expect(card.textContent).toContain('It reaches the agent only when someone accepts it.');
    expect(within(card).queryByRole('button', { name: 'Withdraw' })).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Edit and accept' }));
    const box = within(card).getByRole('textbox', { name: 'Your suggestion' }) as HTMLTextAreaElement;
    expect(box.value).toBe('Use the **session** store');
    fireEvent.change(box, { target: { value: 'Use the session store, with a test' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Accept this text' }));
    expect(view.conn.lastRequest('suggest.accept')?.payload).toEqual({ suggestionId: 'sg_1', text: 'Use the session store, with a test' });
    act(() => {
      const accepted = buildSuggestion({ id: 'sg_1', sessionId: SID, author: AMY, status: 'accepted-modified', decidedBy: MEI, resolvedAt: FAKE_NOW, finalText: 'Use the session store, with a test' });
      view.conn.respond('suggest.accept', { suggestion: accepted });
      view.conn.emit('suggest.updated', { suggestion: accepted });
    });
    await settle();
    // The accepted suggestion is its author's message further down; the card is one line.
    const settled = document.getElementById('conv-card-sg_1') as HTMLElement;
    expect(settled.textContent).toMatch(/Edited and accepted by Mei, /);
    expect(settled.querySelector('.conv-sug__text')).toBeNull();
  });

  it('accepts with one click, and rejects with an optional reason its author reads', async () => {
    const accept = await openSuggestion({}, { role: 'host' });
    fireEvent.click(within(accept.card).getByRole('button', { name: 'Accept' }));
    expect(accept.conn.lastRequest('suggest.accept')?.payload).toEqual({ suggestionId: 'sg_1' });
    accept.unmount();

    const view = await openSuggestion({}, { role: 'host' });
    fireEvent.click(within(view.card).getByRole('button', { name: 'Reject' }));
    fireEvent.change(within(view.card).getByRole('textbox', { name: 'Why? (optional; Amy reads it)' }), { target: { value: 'Already done' } });
    fireEvent.click(within(view.card).getByRole('button', { name: 'Reject' }));
    expect(view.conn.lastRequest('suggest.reject')?.payload).toEqual({ suggestionId: 'sg_1', reason: 'Already done' });
    act(() => {
      view.conn.fail('suggest.reject', settledError({ card: { kind: 'suggestion', id: 'sg_1' }, sessionId: SID, status: 'accepted', by: MEI }));
    });
    await settle();
    expect(view.card.textContent).toContain('Mei already decided this suggestion.');
  });

  it('its author edits or withdraws it and reads whom it waits for; everyone else only reads', async () => {
    const view = await openSuggestion({}, { role: 'editor', session: { responsible: MEI } });
    const { card } = view;
    expect(within(card).queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(card.textContent).toContain('Waiting for Mei (responsible). The host and members with agent access can accept it too.');
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(card).getByRole('textbox', { name: 'Your suggestion' }), { target: { value: 'Use the session store instead' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(view.conn.lastRequest('suggest.edit')?.payload).toEqual({ suggestionId: 'sg_1', text: 'Use the session store instead' });
    act(() => {
      view.conn.respond('suggest.edit', { suggestion: buildSuggestion({ id: 'sg_1', sessionId: SID, author: AMY, text: 'Use the session store instead' }) });
    });
    await settle();
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw' }));
    expect(view.conn.lastRequest('suggest.withdraw')?.payload).toEqual({ suggestionId: 'sg_1' });
    view.unmount();

    const viewer = await openSuggestion({}, { role: 'viewer' });
    expect(within(viewer.card).queryByRole('button')).toBeNull();
    expect(viewer.card.textContent).toContain('Waiting for the host or a member with agent access.');
  });

  it('names the code it is about, and what became of it once it is settled', async () => {
    const view = await openSuggestion({ origin: 'selection', source: { file: { root: MAIN_ROOT, path: 'src/cart.ts' }, startLine: 3, endLine: 5 } }, { role: 'viewer' });
    const opened: CommandMap['openInCodeMode'][] = [];
    view.session.commands.handle('openInCodeMode', (payload) => {
      opened.push(payload);
    });
    fireEvent.click(within(view.card).getByRole('button', { name: 'About src/cart.ts, lines 3–5' }));
    expect(opened).toEqual([{ root: MAIN_ROOT, file: 'src/cart.ts', line: 3, sessionId: SID }]);
    view.unmount();

    const rejected = await openSuggestion({ status: 'rejected', decidedBy: IAN, resolvedAt: FAKE_NOW, rejectReason: 'Already done' });
    expect(rejected.card.textContent).toMatch(/Rejected by Ian, .*: "Already done"/);
    rejected.unmount();
    const withdrawn = await openSuggestion({ status: 'withdrawn', resolvedAt: FAKE_NOW });
    expect(withdrawn.card.textContent).toContain('Withdrawn by Amy');
    withdrawn.unmount();
    const closed = await openSuggestion({ status: 'rejected', resolvedAt: FAKE_NOW, closedReason: 'topic-archived' });
    expect(closed.card.textContent).toContain('Closed: the topic was archived');
  });

  it('tells the inbox that the card was seen: the row of that author is no longer unread', async () => {
    const view = await openSuggestion({}, { role: 'host' });
    const item = buildInboxItem('suggestion', { key: 'suggestion:sg_0', sessionId: SID, unread: true, from: { kind: 'user', ...AMY }, anchor: { cardId: 'sg_0' } });
    act(() => view.conn.emit('inbox.changed', { upsert: [item], remove: [] }));
    await settle();
    expect(view.conn.notificationsOf('inbox.seen').map((notification) => notification.payload)).toEqual([{ keys: ['suggestion:sg_0'] }]);
  });
});
