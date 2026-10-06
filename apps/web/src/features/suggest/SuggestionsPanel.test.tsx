// The suggestion flow per role (SPEC R6; ARCHITECTURE §5.6; protocol v2): a composer for editors, the author's list
// (edit / withdraw while pending, the outcome afterwards), the queue beside the terminal for everyone who may type into
// the session — the host and members with agent access, on ANY session (accept, edit then accept, reject with a reason) —,
// notices to the author, the editor's selection action, and NO auto-accept anywhere.
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, type Role, type SessionInfo, type Suggestion } from '@smurg/protocol';
import { HOST_USER, makeSession, makeSuggestion } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { SuggestionsPanel } from './index.tsx';


const hostSession = makeSession({ id: 'sess_host', openedBy: { userId: HOST_USER, displayName: 'Ian' }, title: 'Claude' });
const amySession = makeSession({ id: 'sess_amy', openedBy: { userId: 'dev:amy', displayName: 'Amy' }, title: 'my Claude', createdAt: 2 });

async function renderPanel(role: Role, options: { sessions?: SessionInfo[]; suggestions?: Suggestion[]; focus?: string } = {}) {
  const result = renderInWorkspace(<SuggestionsPanel />, { role });
  await act(async () => {
    result.conn.respond('session.list', { sessions: options.sessions ?? [hostSession], hasMore: false });
    result.conn.respond('suggest.list', { suggestions: options.suggestions ?? [], hasMore: false });
  });
  await act(async () => {
    result.stores.sessions.focus(options.focus ?? 'sess_host');
  });
  return result;
}

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Suggestions' });

describe('composer: an editor suggests', () => {
  it('an editor proposes text; it waits for the host or a member with agent access, never goes into the session', async () => {
    const { conn } = await renderPanel('editor');
    const box = screen.getByLabelText('Suggestion for "Claude", opened by Ian');
    expect(screen.getByText('A suggestion waits in the queue first. It is sent into the session only after the host or a member with agent access accepts it.')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'Add tests for parseConfig first' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    });
    expect(conn.lastRequest('suggest.create')?.payload).toEqual({ sessionId: 'sess_host', text: 'Add tests for parseConfig first' });
    await act(async () => {
      conn.respond('suggest.create', { suggestion: makeSuggestion({ sessionId: 'sess_host', text: 'Add tests for parseConfig first' }) });
    });
    expect(screen.getByText('Suggestion sent. The host or a member with agent access decides on it.')).toBeTruthy();
    expect((screen.getByLabelText('Suggestion for "Claude", opened by Ian') as HTMLTextAreaElement).value).toBe('');
    // Nothing reached the session itself.
    expect(conn.notificationsOf('exec.input')).toEqual([]);
    // It is listed as mine, pending.
    const mine = within(panel()).getByRole('region', { name: 'My suggestions' });
    expect(mine.textContent).toContain('Waiting');
  });

  it('Ctrl+Enter sends; blank text is refused before anything is sent', async () => {
    const { conn } = await renderPanel('editor');
    const box = screen.getByLabelText('Suggestion for "Claude", opened by Ian');
    fireEvent.change(box, { target: { value: '   ' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    });
    expect(conn.requestsOf('suggest.create')).toHaveLength(0);
    fireEvent.change(box, { target: { value: 'run lint' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    });
    expect(conn.lastRequest('suggest.create')?.payload.text).toBe('run lint');
  });

  it('a viewer watches but cannot propose (told why)', async () => {
    await renderPanel('viewer');
    expect(screen.queryByRole('button', { name: 'Send suggestion' })).toBeNull();
    expect(screen.getByText('As a viewer you can watch sessions but cannot make suggestions.')).toBeTruthy();
  });

  it('an ended session takes no more suggestions', async () => {
    await renderPanel('editor', { sessions: [{ ...hostSession, status: 'exited' }] });
    expect(screen.queryByRole('button', { name: 'Send suggestion' })).toBeNull();
    expect(screen.getByText('This session has ended, so it takes no more suggestions.')).toBeTruthy();
  });
});

describe('the queue beside the terminal (the host and members with agent access, any session)', () => {
  const fromAmy = makeSuggestion({ id: 'sug_a', sessionId: 'sess_host', text: 'Add the tests first', createdAt: 1 });
  const fromBob = makeSuggestion({ id: 'sug_b', sessionId: 'sess_host', author: { userId: 'dev:bob', displayName: 'Bob' }, text: 'Update the README too', createdAt: 2 });
  const fromCat = makeSuggestion({ id: 'sug_c', sessionId: 'sess_host', author: { userId: 'dev:cat', displayName: 'Cat' }, text: 'Switch to pnpm', createdAt: 3 });

  it('shows proposer, time and text for each pending suggestion, oldest first', async () => {
    await renderPanel('host', { suggestions: [fromBob, fromAmy, fromCat] });
    const queue = within(panel()).getByRole('region', { name: 'Suggestions waiting for your decision (3)' });
    const items = within(queue).getAllByRole('article');
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual(['From Amy', 'From Bob', 'From Cat']);
    expect(items[0]!.textContent).toContain('Add the tests first');
    expect(items[0]!.querySelector('time')?.getAttribute('datetime')).toBe(new Date(1).toISOString());
  });

  it('accept sends the id and the text the owner saw; the daemon pastes exactly that text as the owner', async () => {
    const { conn } = await renderPanel('host', { suggestions: [fromAmy] });
    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: 'Accept' }));
    });
    // Not only the id: an edit by the author between the owner's reading and the click must not reach the session.
    expect(conn.lastRequest('suggest.accept')?.payload).toEqual({ suggestionId: 'sug_a', text: fromAmy.text });
    await act(async () => {
      conn.respond('suggest.accept', { suggestion: { ...fromAmy, status: 'accepted', resolvedAt: 5 } });
    });
    expect(screen.getByText('Accepted the suggestion from Amy. It was sent into the session.')).toBeTruthy();
    expect(within(panel()).getByText('No suggestions are waiting for you.')).toBeTruthy();
    // The browser never wrote the text into the PTY itself.
    expect(conn.notificationsOf('exec.input')).toEqual([]);
  });

  it('edit then accept sends the edited text (accepted-modified)', async () => {
    const { conn } = await renderPanel('host', { suggestions: [fromAmy] });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Edit and accept' }));
    fireEvent.change(within(panel()).getByLabelText('Edit the suggestion'), { target: { value: 'Add the tests for parseConfig first' } });
    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: 'Accept the edited text' }));
    });
    expect(conn.lastRequest('suggest.accept')?.payload).toEqual({ suggestionId: 'sug_a', text: 'Add the tests for parseConfig first' });
  });

  it('reject asks for an optional reason and sends it', async () => {
    const { conn } = await renderPanel('host', { suggestions: [fromAmy, fromBob] });
    const [first] = within(panel()).getAllByRole('button', { name: 'Reject' });
    fireEvent.click(first!);
    fireEvent.change(within(panel()).getByLabelText('Reason for rejecting (optional; the author sees it)'), { target: { value: '  I will do this part myself ' } });
    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: 'Confirm rejection' }));
    });
    expect(conn.lastRequest('suggest.reject')?.payload).toEqual({ suggestionId: 'sug_a', reason: 'I will do this part myself' });
    await act(async () => {
      conn.respond('suggest.reject', { suggestion: { ...fromAmy, status: 'rejected', rejectReason: 'I will do this part myself', resolvedAt: 9 } });
    });
    const [second] = within(panel()).getAllByRole('button', { name: 'Reject' });
    fireEvent.click(second!);
    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: 'Confirm rejection' }));
    });
    expect(conn.lastRequest('suggest.reject')?.payload).toEqual({ suggestionId: 'sug_b' });
  });

  it("a member with agent access decides on suggestions to the HOST's session too: no composer, the queue, accept sends the text", async () => {
    const fromErin = makeSuggestion({ id: 'sug_e', sessionId: 'sess_host', author: { userId: 'dev:erin', displayName: 'Erin' }, text: 'echo hi' });
    const { conn } = await renderPanel('agent', { suggestions: [fromErin] });
    expect(screen.queryByRole('button', { name: 'Send suggestion' })).toBeNull();
    const queue = within(panel()).getByRole('region', { name: 'Suggestions waiting for your decision (1)' });
    expect(queue.textContent).toContain('The host and members with agent access can decide.');
    await act(async () => {
      fireEvent.click(within(queue).getByRole('button', { name: 'Accept' }));
    });
    expect(conn.lastRequest('suggest.accept')?.payload).toEqual({ suggestionId: 'sug_e', text: 'echo hi' });
  });

  it('points to pending suggestions on other sessions', async () => {
    const other = makeSession({ id: 'sess_host2', title: 'second', createdAt: 5 });
    const onOther = makeSuggestion({ id: 'sug_o', sessionId: 'sess_host2' });
    const { stores } = await renderPanel('host', { sessions: [hostSession, other, amySession], suggestions: [onOther, makeSuggestion({ id: 'sug_amy', sessionId: 'sess_amy' })] });
    expect(within(panel()).getByText('2 suggestions are waiting in other sessions.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: 'Go to them' }));
    });
    expect(stores.sessions.getState().focusedId).toBe('sess_host2');
  });
});

describe('no auto-accept anywhere (SPEC R6: there is no auto-accept option)', () => {
  for (const role of ['host', 'agent', 'editor', 'viewer'] as const) {
    it(`${role}: no checkbox, switch or option that would accept suggestions automatically`, async () => {
      const pending = makeSuggestion({ id: 'sug_p', sessionId: role === 'host' ? 'sess_host' : 'sess_amy', author: { userId: 'dev:bob', displayName: 'Bob' } });
      await renderPanel(role, { sessions: [hostSession, amySession], suggestions: [pending], focus: role === 'host' ? 'sess_host' : 'sess_amy' });
      expect(within(panel()).queryAllByRole('checkbox')).toEqual([]);
      expect(within(panel()).queryAllByRole('switch')).toEqual([]);
      expect(panel().textContent).not.toMatch(/automatic|auto-accept/i);
    });
  }
});

describe("the author's own suggestions", () => {
  it('while pending they can be edited or withdrawn', async () => {
    const mine = makeSuggestion({ id: 'sug_m', sessionId: 'sess_host', text: 'the original suggestion' });
    const { conn } = await renderPanel('editor', { suggestions: [mine] });
    const list = within(panel()).getByRole('region', { name: 'My suggestions' });
    fireEvent.click(within(list).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(list).getByLabelText('Edit my suggestion'), { target: { value: 'the changed suggestion' } });
    await act(async () => {
      fireEvent.click(within(list).getByRole('button', { name: 'Save changes' }));
    });
    expect(conn.lastRequest('suggest.edit')?.payload).toEqual({ suggestionId: 'sug_m', text: 'the changed suggestion' });
    await act(async () => {
      conn.respond('suggest.edit', { suggestion: { ...mine, text: 'the changed suggestion' } });
    });
    await act(async () => {
      fireEvent.click(within(list).getByRole('button', { name: 'Withdraw' }));
    });
    expect(conn.lastRequest('suggest.withdraw')?.payload).toEqual({ suggestionId: 'sug_m' });
    await act(async () => {
      conn.respond('suggest.withdraw', { suggestion: { ...mine, text: 'the changed suggestion', status: 'withdrawn', resolvedAt: 3 } });
    });
    expect(list.textContent).toContain('Withdrawn');
    expect(within(list).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('afterwards they show the outcome: the text actually sent, or the reason for a rejection', async () => {
    const modified = makeSuggestion({ id: 'sug_1', sessionId: 'sess_host', text: 'the original', status: 'accepted-modified', finalText: 'what the host made of it', resolvedAt: 5 });
    const rejected = makeSuggestion({ id: 'sug_2', sessionId: 'sess_host', text: 'another one', status: 'rejected', rejectReason: 'Already done', resolvedAt: 6, createdAt: 2 });
    await renderPanel('editor', { suggestions: [modified, rejected] });
    const list = within(panel()).getByRole('region', { name: 'My suggestions' });
    expect(list.textContent).toContain('Accepted with edits');
    expect(list.textContent).toContain('Text that was sent:');
    expect(list.textContent).toContain('what the host made of it');
    expect(list.textContent).toContain('Rejected');
    expect(list.textContent).toContain('Reason: Already done');
    expect(within(list).queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('a suggestion smurg closed itself says why, in the viewer\'s language (closedReason; nobody\'s words)', async () => {
    const ended = makeSuggestion({ id: 'sug_c1', sessionId: 'sess_host', text: 'too late', status: 'rejected', closedReason: 'session-ended', resolvedAt: 6 });
    const pending = makeSuggestion({ id: 'sug_c2', sessionId: 'sess_host', text: 'still waiting', createdAt: 3 });
    const { conn } = await renderPanel('editor', { suggestions: [ended, pending] });
    const list = within(panel()).getByRole('region', { name: 'My suggestions' });
    expect(list.textContent).toContain('Reason: The session ended.');
    await act(async () => {
      conn.emit('suggest.updated', { suggestion: { ...pending, status: 'rejected', closedReason: 'session-ended', resolvedAt: 9 } });
    });
    const notices = within(screen.getByRole('region', { name: 'Notifications' }));
    expect(notices.getByText(/^"still waiting"\s+Reason: The session ended\.$/)).toBeTruthy();
  });

  it('the author is notified when someone decides — not for what was already decided before', async () => {
    const pending = makeSuggestion({ id: 'sug_n', sessionId: 'sess_host', text: 'Add tests' });
    const old = makeSuggestion({ id: 'sug_old', sessionId: 'sess_host', text: 'an old one', status: 'accepted', resolvedAt: 1 });
    const { conn } = await renderPanel('editor', { suggestions: [pending, old] });
    expect(screen.queryByText(/^Your suggestion was/)).toBeNull();
    await act(async () => {
      conn.emit('suggest.updated', { suggestion: { ...pending, status: 'rejected', rejectReason: 'Not now', resolvedAt: 7 } });
    });
    const notices = within(screen.getByRole('region', { name: 'Notifications' }));
    expect(notices.getByText('Your suggestion was rejected')).toBeTruthy();
    // The suggestion in quotes on its own line, then the reason.
    expect(notices.getByText(/^"Add tests"\s+Reason: Not now$/)).toBeTruthy();
    const second = makeSuggestion({ id: 'sug_n2', sessionId: 'sess_host', text: 'a second one' });
    await act(async () => {
      conn.emit('suggest.updated', { suggestion: second });
    });
    await act(async () => {
      conn.emit('suggest.updated', { suggestion: { ...second, status: 'accepted-modified', finalText: 'rewritten', resolvedAt: 8 } });
    });
    expect(notices.getByText('Your suggestion was accepted with edits')).toBeTruthy();
  });
});

describe("the editor selection action (R6: one click sends it as a suggestion into someone else's session, or straight into one's own)", () => {
  const selection = { file: { root: MAIN_ROOT, path: 'src/app.ts' }, startLine: 10, endLine: 12, text: 'function a() {\n  return 1;\n}' };

  it("a member with agent access types it into ANY session (the host's too) as a bracketed paste, with no Enter", async () => {
    const { conn, session } = await renderPanel('agent', { sessions: [hostSession, amySession] });
    await act(async () => {
      await session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: 'sess_host' });
    });
    const inputs = conn.notificationsOf('exec.input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload.sessionId).toBe('sess_host');
    const typed = new TextDecoder().decode(inputs[0]!.payload.data);
    expect(typed).toBe('\x1b[200~function a() {\r  return 1;\r}\x1b[201~');
    expect(typed.endsWith('\r')).toBe(false);
    expect(conn.requestsOf('suggest.create')).toHaveLength(0);
  });

  it("an editor's selection becomes a suggestion draft (with the code reference) — nothing is sent yet", async () => {
    const { conn, session, stores } = await renderPanel('editor', { sessions: [hostSession, amySession], focus: 'sess_amy' });
    await act(async () => {
      await session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: 'sess_host' });
    });
    expect(stores.sessions.getState().focusedId).toBe('sess_host');
    const box = screen.getByLabelText('Suggestion for "Claude", opened by Ian') as HTMLTextAreaElement;
    expect(box.value).toContain('src/app.ts:10-12\n');
    expect(box.value).toContain('function a() {');
    expect(screen.getByText('Attached code: src/app.ts, lines 10–12')).toBeTruthy();
    expect(conn.requestsOf('suggest.create')).toHaveLength(0);
    expect(conn.notificationsOf('exec.input')).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    });
    expect(conn.lastRequest('suggest.create')?.payload.source).toEqual({ file: selection.file, startLine: 10, endLine: 12 });
  });

  it("one click (mode 'send') creates an editor's suggestion at once, with the code reference", async () => {
    const { conn, session } = await renderPanel('editor', { sessions: [hostSession, amySession], focus: 'sess_amy' });
    await act(async () => {
      await session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: 'sess_host', mode: 'send' });
    });
    const request = conn.lastRequest('suggest.create');
    expect(request?.payload).toMatchObject({ sessionId: 'sess_host', source: { file: selection.file, startLine: 10, endLine: 12 } });
    expect(request?.payload.text).toContain('function a() {');
    expect(conn.notificationsOf('exec.input')).toEqual([]);
  });

  it('without a session it asks which one: a member with agent access pastes into any of them, an editor suggests', async () => {
    const asAgent = await renderPanel('agent', { sessions: [hostSession, amySession] });
    await act(async () => {
      await asAgent.session.commands.dispatch('sendSelectionAsSuggestion', selection);
    });
    let dialog = screen.getByRole('dialog', { name: 'Send the selected code to a session' });
    expect(within(dialog).getAllByRole('radio').map((choice) => choice.closest('label')?.textContent)).toEqual([
      'Paste into "my Claude" (Enter is not pressed for you)',
      'Paste into "Claude" (Enter is not pressed for you)',
    ]);
    fireEvent.click(within(dialog).getAllByRole('radio')[1]!);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    });
    expect(asAgent.conn.notificationsOf('exec.input').map((n) => n.payload.sessionId)).toEqual(['sess_host']);
    asAgent.unmount();

    const { conn, session } = await renderPanel('editor', { sessions: [hostSession, amySession] });
    await act(async () => {
      await session.commands.dispatch('sendSelectionAsSuggestion', selection);
    });
    dialog = screen.getByRole('dialog', { name: 'Send the selected code to a session' });
    const choices = within(dialog).getAllByRole('radio');
    expect(choices.map((choice) => choice.closest('label')?.textContent)).toEqual(['Send as a suggestion to "my Claude", opened by Amy', 'Send as a suggestion to "Claude", opened by Ian']);
    fireEvent.click(choices[1]!);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    });
    expect((screen.getByLabelText('Suggestion for "Claude", opened by Ian') as HTMLTextAreaElement).value).toContain('function a()');
    expect(conn.notificationsOf('exec.input')).toEqual([]);
  });

  it("a viewer cannot turn a selection into a suggestion for someone else's session", async () => {
    const { conn, session } = await renderPanel('viewer');
    await act(async () => {
      await session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: 'sess_host' });
    });
    expect(screen.getByText('Your role cannot make suggestions.')).toBeTruthy();
    expect(conn.notificationsOf('exec.input')).toEqual([]);
    expect(conn.requestsOf('suggest.create')).toHaveLength(0);
  });
});
