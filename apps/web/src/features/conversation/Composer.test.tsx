// The composer by role (UX §4, DESIGN §5.12 item 11): a message from the host and members with agent access, a
// suggestion from an Editor, a sentence for a viewer; Enter and the input-method guard; mentions; drafts.
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildSuggestion, FAKE_NOW } from '@smurg/protocol/testing';
import { AMY, IAN, MEI, PEOPLE, SID, openConversation, settle } from './test-support.tsx';

const box = (name: string): HTMLTextAreaElement => screen.getByRole('combobox', { name }) as HTMLTextAreaElement;
const problem = (): HTMLElement | null => document.querySelector('.conv-composer [role="alert"]');
const type = (field: HTMLTextAreaElement, value: string): void => {
  fireEvent.change(field, { target: { value, selectionStart: value.length } });
  field.setSelectionRange(value.length, value.length);
  fireEvent.select(field);
};

describe('composer: a member with agent access', () => {
  it('names its session, sends with Enter, makes a new line with Shift+Enter, and never sends while an input method composes', async () => {
    const view = await openConversation({ role: 'agent', session: { purpose: 'item', topicId: 't_1', topicName: 'Checkout', itemId: 'pay', item: { number: 2, title: 'Payment form' }, attempt: 1 } });
    const field = box('Message Claude · 2 · Payment form');
    expect(field.placeholder).toBe('Message Claude · 2 · Payment form');
    expect(screen.getByText('Enter to send · Shift+Enter for a new line')).toBeTruthy();

    type(field, 'Add a test');
    // Chinese is typed with Enter: the Enter that picks a candidate is not a send.
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(view.conn.requestsOf('session.message.send')).toHaveLength(0);

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(view.conn.lastRequest('session.message.send')?.payload).toEqual({ sessionId: SID, text: 'Add a test' });
    act(() => {
      view.conn.respond('session.message.send', { messageId: 'm_1' });
    });
    await settle();
    expect(field.value).toBe('');
  });

  it('"@" offers the members and fills the mentions; a text that could not be sent stays with the reason', async () => {
    const view = await openConversation({ role: 'agent' });
    const field = box('Message Claude · Claude (Ian)');
    type(field, 'Please check @a');
    const list = screen.getByRole('listbox', { name: 'People to mention' });
    expect(within(list).getAllByRole('option').map((option) => option.lastElementChild?.textContent)).toEqual(['Amy · Editor', 'Ian · Host']);
    fireEvent.keyDown(field, { key: 'Enter' });
    // Enter picked the person, it did not send.
    expect(view.conn.requestsOf('session.message.send')).toHaveLength(0);
    expect(field.value).toBe('Please check @Amy ');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(view.conn.lastRequest('session.message.send')?.payload).toEqual({ sessionId: SID, text: 'Please check @Amy ', mentions: ['dev:amy'] });
    act(() => {
      view.conn.fail('session.message.send', new SmurgError('conflict', msg('session.exited'), { reason: 'ended' }));
    });
    await settle();
    expect(field.value).toBe('Please check @Amy ');
    expect(problem()?.textContent).toContain('Not sent: ');
  });

  it('says what the agent is waiting for, refuses a blank text, and keeps the unsent text per session in this browser', async () => {
    const view = await openConversation({ role: 'host', session: { status: 'waiting-answer', waitingSince: FAKE_NOW } });
    expect(screen.getByText('Claude is waiting for the answer above and reads messages after it.')).toBeTruthy();
    const field = box('Message Claude · Claude (Ian)');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(problem()?.textContent).toBe('Write something first.');
    type(field, 'Half a thought');
    view.unmount();

    // The column is opened again (the same workspace, another mount): the text is there.
    await openConversation({ role: 'host' });
    expect(box('Message Claude · Claude (Ian)').value).toBe('Half a thought');
  });

  it('only the focused column\'s composer has the accent border', async () => {
    const view = await openConversation({ role: 'host', focused: false });
    const composer = document.querySelector('.conv-composer') as HTMLElement;
    expect(composer.className).not.toContain('conv-composer--focused');
    view.column.set({ focused: true });
    expect(composer.className).toContain('conv-composer--focused');
  });
});

describe('composer: an Editor', () => {
  it('the same box sends a suggestion and says whom it goes to', async () => {
    const view = await openConversation({ role: 'editor', session: { responsible: MEI } });
    const field = box('Suggest to Claude · Claude (Ian)');
    expect(screen.getByText('Goes to Mei as a suggestion. It reaches the agent only when accepted.')).toBeTruthy();
    type(field, 'Use the session store');
    fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    expect(view.conn.requestsOf('session.message.send')).toHaveLength(0);
    expect(view.conn.lastRequest('suggest.create')?.payload).toEqual({ sessionId: SID, text: 'Use the session store' });
    act(() => {
      view.conn.respond('suggest.create', { suggestion: buildSuggestion({ sessionId: SID, author: AMY }) });
    });
    await settle();
    expect(field.value).toBe('');
    expect(screen.getByText('Suggestion sent.')).toBeTruthy();
  });

  it('with nobody assigned it goes to everyone with agent access; a responsible Editor is told why it is still a suggestion', async () => {
    const nobody = await openConversation({ role: 'editor' });
    expect(screen.getByText('Goes to Ian and Mei as a suggestion. It reaches the agent only when accepted.')).toBeTruthy();
    nobody.unmount();

    await openConversation({ role: 'editor', session: { responsible: AMY } });
    expect(screen.getByText('Goes to Ian and Mei as a suggestion: you are responsible, but your role cannot message agents.')).toBeTruthy();
  });
});

describe('composer: no box', () => {
  it('a viewer reads one sentence; an ended session takes no more messages; an offline host disables the box', async () => {
    const viewer = await openConversation({ role: 'viewer' });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('As a viewer you can watch this session. You cannot send messages, make suggestions or vote.')).toBeTruthy();
    viewer.unmount();

    const ended = await openConversation({ role: 'host', session: { status: 'ended', endedAt: FAKE_NOW, endReason: 'ended', endedBy: IAN } });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('This session has ended. It takes no more messages.')).toBeTruthy();
    ended.unmount();

    const offline = await openConversation({ role: 'host', people: PEOPLE });
    act(() => offline.conn.hostOffline());
    expect(box('Message Claude · Claude (Ian)').disabled).toBe(true);
    expect(screen.getByText('The host is offline: nothing can be sent right now.')).toBeTruthy();
  });
});
