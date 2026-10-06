// The conversation column as a whole (DESIGN §5.5, UX §4): watching, the rows of the list, streaming text, tool
// lines, the status bar, the strip and its menus, anchors and history.
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MAIN_ROOT, SmurgError, type ConversationEvent } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildEvent, buildPermission, buildPlan, buildQuestion, buildWorkItem, FAKE_NOW } from '@smurg/protocol/testing';
import type { CommandMap } from '../../lib/commands.ts';
import { MOUNT_LIMIT } from './EventList.tsx';
import { AMY, IAN, MEI, SID, openConversation, settle, updateSession } from './test-support.tsx';

const line = (seq: number): ConversationEvent => ({ ...buildEvent('line', { seq }), text: msg('conversation.started.free', { name: 'Ian' }), fallback: 'Ian opened this session' });
const file = (path: string) => ({ root: MAIN_ROOT, path });

function conversation(): ConversationEvent[] {
  return [
    line(1),
    buildEvent('message', { seq: 2, messageId: 'm_1', from: { ...MEI, role: 'agent' }, text: 'Add a test for the **empty** cart' }),
    buildEvent('delivery', { seq: 3, messageId: 'm_1', state: 'started' }),
    buildEvent('turn.started', { seq: 4, turnId: 't_1' }),
    buildEvent('text', { seq: 5, turnId: 't_1', blockId: 'b_1', text: "I'll add the test next to the existing ones." }),
    buildEvent('tool.started', { seq: 6, turnId: 't_1', toolUseId: 'tu_1', tool: { name: 'Edit', verb: 'edit', target: 'src/cart.test.ts', file: file('src/cart.test.ts') } }),
    buildEvent('tool.finished', { seq: 7, turnId: 't_1', toolUseId: 'tu_1', ok: true, result: { additions: 12, deletions: 1, body: { kind: 'diff', text: '@@ -1,2 +1,3 @@\n context\n-old\n+new\n+more', truncated: false } } }),
    buildEvent('tool.started', { seq: 8, turnId: 't_1', toolUseId: 'tu_2', tool: { name: 'Bash', verb: 'run', target: 'pnpm test cart' } }),
    buildEvent('tool.finished', { seq: 9, turnId: 't_1', toolUseId: 'tu_2', ok: false, result: { exitCode: 1, durationMs: 11_000, body: { kind: 'output', text: '1 failed', truncated: true } } }),
    buildEvent('turn.finished', { seq: 10, turnId: 't_1', outcome: 'interrupted', stoppedBy: IAN, durationMs: 20_000 }),
  ];
}

const statusBar = (): HTMLElement => document.querySelector('.conv-status') as HTMLElement;
/** A time on a whole second: the app's clock ticks on whole seconds, so a wait that starts here counts 1, 2, 3 with it. */
const WHOLE_SECOND = 1_790_000_010_000;
/** What a screen reader hears of the status bar: its live regions (the state; the account's state or a refusal). */
const spoken = (): string[] => within(statusBar()).getAllByRole('status').map((node) => node.textContent ?? '');
const openDetails = (details: HTMLDetailsElement): void => {
  details.open = true;
  fireEvent(details, new Event('toggle'));
};

describe('conversation column: watching', () => {
  it('watches the session with streaming while the column is on screen, without while it is hidden, and unwatches when it goes', async () => {
    const view = await openConversation({ events: conversation() });
    expect(view.conn.requestsOf('session.watch')[0]?.payload).toEqual({ sessionId: SID, live: true });

    view.column.set({ visible: false });
    await settle();
    expect(view.conn.lastRequest('session.watch')?.payload).toMatchObject({ sessionId: SID, live: false, haveSeq: 10 });
    expect(view.conn.notificationsOf('session.unwatch')).toHaveLength(0);

    view.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(view.conn.notificationsOf('session.unwatch').map((notification) => notification.payload)).toEqual([{ sessionId: SID }]);
  });

  it('is a silent log named by its session; a first page that fails can be tried again', async () => {
    const view = await openConversation();
    const log = screen.getByRole('log', { name: 'Conversation: Claude (Ian)' });
    expect(log.getAttribute('aria-live')).toBe('off');
    view.unmount();

    const failing = await openConversation();
    // The channel is established again and this time the daemon refuses the watch.
    act(() => failing.stores.conversations.watch('sess_b'));
    act(() => {
      failing.conn.fail('session.watch', new SmurgError('not_found', 'That session was not found.'));
    });
    await settle();
    expect(failing.stores.conversations.getState().conversations.get('sess_b')?.status).toBe('error');
  });
});

describe('conversation column: the rows', () => {
  it('shows a person message with role, time and Markdown; the agent with its name once; a stopped turn', async () => {
    await openConversation({ events: conversation() });
    const log = screen.getByRole('log');
    expect(within(log).getByText('Ian opened this session', { exact: false })).toBeTruthy();

    const message = log.querySelector('.conv-msg') as HTMLElement;
    expect(within(message).getByText('Mei')).toBeTruthy();
    expect(within(message).getByText('Agent access')).toBeTruthy();
    expect(message.querySelector('strong')?.textContent).toBe('empty');
    // Mei's message in Ian's column is not "mine".
    expect(message.className).not.toContain('conv-msg--me');

    expect(within(log).getAllByText('Claude')).toHaveLength(1);
    expect(within(log).getByText("I'll add the test next to the existing ones.")).toBeTruthy();
    expect(within(log).getByText('Ian stopped the agent', { exact: false })).toBeTruthy();
  });

  it('marks an accepted suggestion, removed hidden characters, a queued message, and my own messages', async () => {
    await openConversation({
      role: 'agent',
      events: [
        buildEvent('message', { seq: 1, messageId: 'm_1', from: { ...AMY, role: 'editor' }, text: 'Use the session store', cleaned: true, suggestion: { id: 'sg_1', acceptedBy: IAN, modified: true } }),
        buildEvent('message', { seq: 2, messageId: 'm_2', from: { ...MEI, role: 'agent' }, text: 'And @Amy checks it', origin: 'selection' }),
        buildEvent('delivery', { seq: 3, messageId: 'm_2', state: 'queued' }),
        buildEvent('smurg', { seq: 4, messageId: 'm_3', purpose: 'generate-plan', by: IAN, text: '[smurg k7f2]\nWrite the plan.' }),
      ],
    });
    const [first, second] = [...screen.getByRole('log').querySelectorAll<HTMLElement>('.conv-msg')] as [HTMLElement, HTMLElement];
    expect(first.textContent).toContain('suggestion, edited and accepted by Ian');
    expect(first.textContent).toContain('Hidden characters were removed');
    expect(second.className).toContain('conv-msg--me');
    expect(second.textContent).toContain('from a selection in the editor');
    expect(second.textContent).toContain('Claude reads it when it starts again');
    expect(second.querySelector('.md-mention')?.textContent).toBe('@Amy');
    // What smurg told the agent is one folded line.
    const smurg = screen.getByRole('log').querySelector('details.conv-smurg') as HTMLDetailsElement;
    expect(smurg.open).toBe(false);
    expect(smurg.querySelector('summary')?.textContent).toContain('smurg told Claude, asked by Ian');
  });

  it('a tool line names the verb, the target and the result, and opens to the diff or the output', async () => {
    const view = await openConversation({ events: conversation() });
    const opened: CommandMap['openInCodeMode'][] = [];
    view.session.commands.handle('openInCodeMode', (payload) => {
      opened.push(payload);
    });
    const [edit, run] = [...screen.getByRole('log').querySelectorAll<HTMLDetailsElement>('details.conv-tool')] as [HTMLDetailsElement, HTMLDetailsElement];

    expect(edit.querySelector('summary')?.textContent).toContain('Edited');
    expect(edit.querySelector('summary')?.textContent).toContain('src/cart.test.ts');
    expect(edit.querySelector('.conv-tool__adds')?.textContent).toBe('+12');
    expect(edit.querySelector('.conv-tool__dels')?.textContent).toBe('−1');
    // The body is built when the line is first opened.
    expect(edit.querySelector('.conv-diff')).toBeNull();
    openDetails(edit);
    const diff = within(edit).getByLabelText('Changes to src/cart.test.ts');
    expect(diff.querySelectorAll('.conv-diff__line--add')).toHaveLength(2);
    expect(diff.querySelectorAll('.conv-diff__line--del')).toHaveLength(1);
    fireEvent.click(within(edit).getByRole('button', { name: 'Open in editor' }));
    expect(opened).toEqual([{ root: MAIN_ROOT, file: 'src/cart.test.ts', sessionId: SID }]);

    expect(run.getAttribute('data-state')).toBe('failed');
    expect(run.querySelector('summary')?.textContent).toContain('Ran');
    expect(run.querySelector('summary')?.textContent).toContain('exit 1');
    openDetails(run);
    expect(run.querySelector('.conv-tool__out')?.textContent).toBe('1 failed');
    expect(within(run).getByText('The rest was cut off.')).toBeTruthy();
    // A command has no file to open.
    expect(within(run).queryByRole('button', { name: 'Open in editor' })).toBeNull();
  });

  it('folds a run of reads into one line, shows a running tool, and nests a subagent under its task', async () => {
    await openConversation({
      session: { status: 'running', runningSince: FAKE_NOW },
      events: [
        buildEvent('turn.started', { seq: 1, turnId: 't_1' }),
        ...['a', 'b', 'c'].flatMap((name, index) => [
          buildEvent('tool.started', { seq: 2 + index * 2, turnId: 't_1', toolUseId: `r_${name}`, tool: { name: 'Read', verb: 'read', target: `src/cart/${name}.ts`, file: file(`src/cart/${name}.ts`) } }),
          buildEvent('tool.finished', { seq: 3 + index * 2, turnId: 't_1', toolUseId: `r_${name}`, ok: true, result: {} }),
        ]),
        buildEvent('tool.started', { seq: 8, turnId: 't_1', toolUseId: 'task_1', tool: { name: 'Task', verb: 'task', target: 'Look for the cart rules' } }),
        buildEvent('tool.started', { seq: 9, turnId: 't_1', toolUseId: 'g_1', parentToolUseId: 'task_1', tool: { name: 'Grep', verb: 'search', target: 'cart' } }),
        buildEvent('text', { seq: 10, turnId: 't_1', blockId: 'b_sub', parentToolUseId: 'task_1', text: 'Found the rules.' }),
      ],
    });
    const lines = [...screen.getByRole('log').querySelectorAll<HTMLDetailsElement>('.conv-row > .conv-agent > details.conv-tool, .conv-row > details.conv-tool')];
    expect(lines).toHaveLength(2);
    const [reads, task] = lines as [HTMLDetailsElement, HTMLDetailsElement];
    expect(reads.querySelector('summary')?.textContent).toContain('Read');
    expect(reads.querySelector('summary')?.textContent).toContain('3 files in src/cart');
    openDetails(reads);
    expect([...reads.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['src/cart/a.ts', 'src/cart/b.ts', 'src/cart/c.ts']);

    // A subagent at work is open: its pieces are under its line, without a second "Claude".
    expect(task.open).toBe(true);
    expect(task.querySelector('summary')?.textContent).toContain('Subagent working');
    expect(task.querySelector('summary')?.textContent).toContain('2 steps');
    const nested = task.querySelector('.conv-tool__children') as HTMLElement;
    expect(within(nested).getByText('Found the rules.')).toBeTruthy();
    expect(nested.querySelector('details.conv-tool summary')?.textContent).toContain('Searching');
    expect(within(nested).queryByText('Claude')).toBeNull();
  });

  it('a notice offers its action to those who may take it, while it still makes sense', async () => {
    const events = [
      { ...buildEvent('notice', { seq: 1, level: 'error', action: 'retry' }), text: msg('notice.processExited', { code: 1 }), fallback: "The agent's process ended unexpectedly (exit code 1)." } as ConversationEvent,
      { ...buildEvent('notice', { seq: 2, level: 'warning', action: 'restart-agent' }), text: msg('conversation.agent.restarting'), fallback: 'The agent starts again with the new settings at its next message.' } as ConversationEvent,
    ];
    const view = await openConversation({ session: { status: 'failed' }, events });
    const log = screen.getByRole('log');
    expect(within(log).getByText("The agent's process ended unexpectedly (exit code 1).")).toBeTruthy();
    fireEvent.click(within(log).getByRole('button', { name: 'Try again' }));
    expect(view.conn.lastRequest('session.retry')?.payload).toEqual({ sessionId: SID });
    fireEvent.click(within(log).getByRole('button', { name: "Restart this session's agent now" }));
    expect(view.conn.lastRequest('session.restart')?.payload).toEqual({ sessionId: SID });
    // Once the session runs again, "Try again" is gone.
    updateSession(view, { status: 'running' });
    expect(within(log).queryByRole('button', { name: 'Try again' })).toBeNull();
    view.unmount();

    await openConversation({ role: 'editor', session: { status: 'failed' }, events });
    expect(within(screen.getByRole('log')).queryByRole('button')).toBeNull();
  });

  it("a work item's failed session is tried again through its plan, from the notice and from the status bar: smurg then tells the agent to go on", async () => {
    const events = [{ ...buildEvent('notice', { seq: 1, level: 'error', action: 'retry' }), text: msg('notice.processExited', { code: -1 }), fallback: "The agent's process ended unexpectedly (exit code -1)." } as ConversationEvent];
    const view = await openConversation({ session: { status: 'failed', purpose: 'item', topicId: 't_1', topicName: 'Checkout', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, attempt: 1 }, events });
    fireEvent.click(within(screen.getByRole('log')).getByRole('button', { name: 'Try again' }));
    expect(view.conn.lastRequest('plan.item.retry')?.payload).toEqual({ topicId: 't_1', itemId: 'cart-api' });
    fireEvent.click(within(statusBar()).getByRole('button', { name: 'Try again' }));
    expect(view.conn.requestsOf('plan.item.retry')).toHaveLength(2);
    // Never the bare restart of the process: the item would stay "running" with an agent nobody told to go on.
    expect(view.conn.requestsOf('session.retry')).toHaveLength(0);
  });
});

/**
 * The three commands a conversation sends to the console feature (the host's dialogs are the console's): what was
 * dispatched, newest last. The conversation never opens a dialog of another feature by itself.
 */
function hostCommands(view: Awaited<ReturnType<typeof openConversation>>): { [K in 'redactEvent' | 'reviewProjectSettings' | 'showHostRules']?: CommandMap[K] }[] {
  const seen: { [K in 'redactEvent' | 'reviewProjectSettings' | 'showHostRules']?: CommandMap[K] }[] = [];
  const bus = view.session.commands;
  bus.handle('redactEvent', (payload) => void seen.push({ redactEvent: payload }));
  bus.handle('reviewProjectSettings', (payload) => void seen.push({ reviewProjectSettings: payload }));
  bus.handle('showHostRules', (payload) => void seen.push({ showHostRules: payload }));
  return seen;
}

describe('conversation column: what only the host has', () => {
  it('"Remove this entry" on a message, on agent text, on a tool call and on its result asks for the confirmation with that event', async () => {
    const view = await openConversation({ role: 'host', events: conversation() });
    const asked = hostCommands(view);
    const log = screen.getByRole('log');
    fireEvent.click(within(log.querySelector('.conv-msg') as HTMLElement).getByRole('button', { name: 'Remove this entry…' }));
    expect(asked.at(-1)).toEqual({ redactEvent: { sessionId: SID, seq: 2 } });
    fireEvent.click(within(log.querySelector('.conv-agent__text') as HTMLElement).getByRole('button', { name: 'Remove this entry…' }));
    expect(asked.at(-1)).toEqual({ redactEvent: { sessionId: SID, seq: 5 } });
    const run = [...log.querySelectorAll<HTMLDetailsElement>('details.conv-tool')][1] as HTMLDetailsElement;
    openDetails(run);
    fireEvent.click(within(run).getByRole('button', { name: 'Remove this entry…' }));
    expect(asked.at(-1)).toEqual({ redactEvent: { sessionId: SID, seq: 8 } });
    fireEvent.click(within(run).getByRole('button', { name: 'Remove its result…' }));
    expect(asked.at(-1)).toEqual({ redactEvent: { sessionId: SID, seq: 9 } });
    expect(asked).toHaveLength(4);

    // The replacement arrives under the same seq: the output is gone, the entry says who removed it.
    act(() =>
      view.conn.emit('session.events', {
        sessionId: SID,
        events: [{ ...buildEvent('notice', { seq: 9, level: 'info' }), text: msg('conversation.redacted'), fallback: 'The host removed this entry.' } as ConversationEvent],
      }),
    );
    expect(within(log).getByText('The host removed this entry.')).toBeTruthy();
    expect(log.textContent).not.toContain('1 failed');
    // Its turn is over: the call without a result does not read as running.
    expect([...log.querySelectorAll('details.conv-tool')][1]?.textContent).not.toContain('running');
    view.unmount();

    await openConversation({ role: 'agent', events: conversation() });
    expect(screen.queryByRole('button', { name: 'Remove this entry…' })).toBeNull();
  });

  it('reviews the project settings from the notice about them, and reads the own rules from the permission dialog', async () => {
    const events = [
      { ...buildEvent('notice', { seq: 1, level: 'warning', action: 'restart-agent' }), text: msg('session.projectSettings.untrusted'), fallback: "The host has not confirmed this folder's Claude Code project settings." } as ConversationEvent,
    ];
    const view = await openConversation({ role: 'host', events });
    const asked = hostCommands(view);
    fireEvent.click(within(screen.getByRole('log')).getByRole('button', { name: 'Review the project settings' }));
    expect(asked.at(-1)).toEqual({ reviewProjectSettings: { root: MAIN_ROOT } });
    expect(within(screen.getByRole('log')).getByRole('button', { name: "Restart this session's agent now" })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Permission mode: Asks before edits and commands' }));
    act(() => {
      view.conn.respond('session.rules.get', { rules: [], host: { state: 'applied', rules: ['Bash(git status)', 'Bash(ls *)'] } });
    });
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'What this session may do without asking' });
    expect(within(dialog).getByText(/agents here run 2 kinds of commands without asking/)).toBeTruthy();
    expect(within(dialog).getByText(/Nothing is always allowed here/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show them' }));
    expect(asked.at(-1)).toEqual({ showHostRules: {} });
    view.unmount();

    // A member with agent access reads the sentence and may restart; reviewing is the host's.
    await openConversation({ role: 'agent', events });
    expect(within(screen.getByRole('log')).queryByRole('button', { name: 'Review the project settings' })).toBeNull();
    expect(within(screen.getByRole('log')).getByRole('button', { name: "Restart this session's agent now" })).toBeTruthy();
  });
});

describe('conversation column: streaming', () => {
  it('shows text as it streams, says that Claude is writing, and ends the block with its text event', async () => {
    const view = await openConversation({ session: { status: 'running', runningSince: FAKE_NOW }, events: [buildEvent('turn.started', { seq: 1, turnId: 't_1' })] });
    act(() => view.conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 0, text: '', thinking: true }));
    expect(screen.getByText('Claude is thinking…')).toBeTruthy();
    expect(statusBar().textContent).toContain('Claude is thinking');

    act(() => view.conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 0, text: 'Then the ' }));
    act(() => view.conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 9, text: 'test is wrong' }));
    const streaming = screen.getByRole('log').querySelector('.conv-agent--streaming') as HTMLElement;
    expect(streaming.textContent).toContain('Then the test is wrong');
    expect(streaming.querySelector('.conv-caret')).toBeTruthy();
    expect(screen.queryByText('Claude is thinking…')).toBeNull();
    expect(statusBar().textContent).toContain('Claude is writing');

    act(() => view.conn.emit('session.events', { sessionId: SID, events: [buildEvent('text', { seq: 2, turnId: 't_1', blockId: 'b_1', text: 'Then the test is wrong, not the page.' })] }));
    expect(screen.getByRole('log').querySelector('.conv-agent--streaming')).toBeNull();
    expect(screen.getByText('Then the test is wrong, not the page.')).toBeTruthy();
    expect(statusBar().textContent).toContain('Claude is working');
  });
});

describe('conversation column: the status bar', () => {
  it('says what the session waits for and leads to the open card', async () => {
    const question = buildQuestion({ id: 'q_1', sessionId: SID, decider: IAN });
    const view = await openConversation({
      session: { status: 'waiting-answer', waitingSince: FAKE_NOW },
      events: [line(1), buildEvent('card', { seq: 2, card: 'question', id: 'q_1' })],
      reply: { questions: [question] },
    });
    const status = statusBar();
    expect(status.textContent).toContain('Claude is waiting for an answer');
    expect(status.className).toContain('conv-status--wait');
    fireEvent.click(within(status).getByRole('button', { name: 'Show it' }));
    await settle();
    // The focus is on the card, never on one of its buttons.
    expect(document.activeElement?.id).toBe('conv-card-q_1');

    updateSession(view, { status: 'idle' });
    expect(status.textContent).toContain('Claude is idle.');
    updateSession(view, { status: 'done' });
    expect(status.textContent).toContain('Done. Claude answers follow-ups here and in the report.');
    updateSession(view, { status: 'failed' });
    fireEvent.click(within(status).getByRole('button', { name: 'Try again' }));
    expect(view.conn.lastRequest('session.retry')?.payload).toEqual({ sessionId: SID });
  });

  it('a screen reader hears the state once: the seconds count beside the live region, not in it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: WHOLE_SECOND });
    try {
      const view = await openConversation({ session: { status: 'running', runningSince: Date.now() }, events: [buildEvent('turn.started', { seq: 1, turnId: 't_1' })] });
      const age = (): string | null | undefined => statusBar().querySelector('.conv-status__age')?.textContent;
      expect(spoken()).toEqual(['Claude is working', '']);
      expect(age()).toBe('· 0 sec');
      for (let second = 1; second <= 5; second++) {
        act(() => void vi.advanceTimersByTime(1_000));
        expect(spoken()).toEqual(['Claude is working', '']);
        expect(age()).toBe(`· ${second} sec`);
      }
      // Nothing inside a live region is the age; the bar as a whole still reads as one line.
      expect(statusBar().querySelector('[role="status"] .conv-status__age')).toBeNull();
      expect(statusBar().textContent).toContain('Claude is working · 5 sec');

      // A change of state is what the region says next.
      updateSession(view, { status: 'idle' });
      expect(spoken()).toEqual(['Claude is idle.', '']);
      expect(age()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('one wait, one number: a new permission card and its status bar count the seconds together, from the first one', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: WHOLE_SECOND });
    try {
      const askedAt = Date.now();
      await openConversation({
        session: { status: 'waiting-permission', waitingSince: askedAt },
        events: [line(1), buildEvent('card', { seq: 2, card: 'permission', id: 'pr_1' })],
        reply: { permissions: [buildPermission({ id: 'pr_1', sessionId: SID, askedAt })] },
      });
      const card = document.getElementById('conv-card-pr_1') as HTMLElement;
      const age = (): string | null | undefined => statusBar().querySelector('.conv-status__age')?.textContent;
      for (const second of [1, 2, 3, 4]) {
        act(() => void vi.advanceTimersByTime(1_000));
        expect(age()).toBe(`· ${second} sec`);
        expect(card.textContent).toContain(`waiting ${second} sec`);
      }
      expect(spoken()[0]).toBe('Claude is waiting for permission');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an ended session says so once on screen: the status is spoken, the composer’s place shows the sentence', async () => {
    await openConversation({ session: { status: 'ended', endedAt: FAKE_NOW } });
    expect(spoken()[0]).toBe('This session has ended.');
    expect(statusBar().className).toContain('ui-visually-hidden');
    expect(screen.getByText('This session has ended. It takes no more messages.')).toBeTruthy();
  });

  it('a tool call whose turn ended without its result does not read as done or as running: "Command pnpm build · not finished"', async () => {
    const events = [
      buildEvent('turn.started', { seq: 1, turnId: 't_1' }),
      buildEvent('tool.started', { seq: 2, turnId: 't_1', toolUseId: 'tu_1', tool: { name: 'Bash', verb: 'run', target: 'pnpm build' } }),
      // The process died (or smurg was restarted) while the command's permission request was open.
      buildEvent('turn.finished', { seq: 3, turnId: 't_1', outcome: 'interrupted', durationMs: 5_000 }),
    ];
    await openConversation({ events });
    const run = within(screen.getByRole('log')).getByText('pnpm build').closest('details') as HTMLDetailsElement;
    expect(run.getAttribute('data-state')).toBe('unfinished');
    expect(run.querySelector('summary')?.textContent).toContain('Command');
    expect(run.querySelector('summary')?.textContent).toContain('not finished');
    expect(run.querySelector('summary')?.textContent).not.toMatch(/Ran|Running/);
  });

  it('a call that was refused does not read as done: "Edit of SPEC.md · failed", and a command that ran and failed did run', async () => {
    const spec = file('specs/checkout/SPEC.md');
    const events = [
      buildEvent('turn.started', { seq: 1, turnId: 't_1' }),
      // The edit was refused (people are typing in the file): nothing was edited.
      buildEvent('tool.started', { seq: 2, turnId: 't_1', toolUseId: 'tu_1', tool: { name: 'Edit', verb: 'edit', target: spec.path, file: spec } }),
      buildEvent('tool.finished', { seq: 3, turnId: 't_1', toolUseId: 'tu_1', ok: false, result: {} }),
      // A command that was denied never ran; one that came back with a code did.
      buildEvent('tool.started', { seq: 4, turnId: 't_1', toolUseId: 'tu_2', tool: { name: 'Bash', verb: 'run', target: 'pnpm add left-pad' } }),
      buildEvent('tool.finished', { seq: 5, turnId: 't_1', toolUseId: 'tu_2', ok: false, result: {} }),
      buildEvent('tool.started', { seq: 6, turnId: 't_1', toolUseId: 'tu_3', tool: { name: 'Bash', verb: 'run', target: 'pnpm test cart' } }),
      buildEvent('tool.finished', { seq: 7, turnId: 't_1', toolUseId: 'tu_3', ok: false, result: { exitCode: 1 } }),
      buildEvent('tool.started', { seq: 8, turnId: 't_1', toolUseId: 'tu_4', tool: { name: 'Write', verb: 'create', target: 'src/new.ts', file: file('src/new.ts') } }),
      buildEvent('tool.finished', { seq: 9, turnId: 't_1', toolUseId: 'tu_4', ok: false, result: {} }),
    ];
    await openConversation({ session: { status: 'running', runningSince: FAKE_NOW }, events });
    const summary = (target: string): string => within(screen.getByRole('log')).getByText(target).closest('details')?.querySelector('summary')?.textContent ?? '';
    expect(summary(spec.path)).toContain('Edit of');
    expect(summary(spec.path)).toContain('failed');
    expect(summary(spec.path)).not.toContain('Edited');
    expect(summary('pnpm add left-pad')).toContain('Command');
    expect(summary('pnpm add left-pad')).not.toContain('Ran');
    expect(summary('pnpm test cart')).toContain('Ran');
    expect(summary('pnpm test cart')).toContain('exit 1');
    expect(summary('src/new.ts')).toContain('New file');
    expect(summary('src/new.ts')).not.toContain('Created');
  });

  it('a call that waits at its permission card says so, not "Running … running"; once allowed, it runs', async () => {
    const events = [
      buildEvent('turn.started', { seq: 1, turnId: 't_1' }),
      buildEvent('tool.started', { seq: 2, turnId: 't_1', toolUseId: 'tu_1', tool: { name: 'Read', verb: 'read', target: 'src/cart.ts', file: file('src/cart.ts') } }),
      buildEvent('tool.started', { seq: 3, turnId: 't_1', toolUseId: 'tu_2', tool: { name: 'Bash', verb: 'run', target: 'pnpm test' } }),
      buildEvent('card', { seq: 4, card: 'permission', id: 'pr_1' }),
    ];
    const request = buildPermission({ id: 'pr_1', sessionId: SID, tool: 'Bash', command: 'pnpm test' });
    const view = await openConversation({ session: { status: 'waiting-permission', waitingSince: FAKE_NOW }, events, reply: { permissions: [request] } });
    const run = within(screen.getByRole('log')).getAllByText('pnpm test')[0]?.closest('details') as HTMLDetailsElement;
    expect(run.getAttribute('data-state')).toBe('waiting');
    expect(run.querySelector('summary')?.textContent).toContain('Command');
    expect(run.querySelector('.conv-tool__meta')?.textContent).toBe('waiting');
    expect(run.querySelector('summary')?.textContent).not.toMatch(/Running|running/);
    // Another call of the turn that runs beside it is not the one that waits.
    const read = within(screen.getByRole('log')).getByText('src/cart.ts').closest('details') as HTMLDetailsElement;
    expect(read.getAttribute('data-state')).toBe('running');
    expect(read.querySelector('summary')?.textContent).toContain('Reading');

    act(() => view.conn.emit('permission.updated', { request: { ...request, status: 'allowed', decision: { by: IAN, at: FAKE_NOW } } }));
    expect(run.getAttribute('data-state')).toBe('running');
    expect(run.querySelector('summary')?.textContent).toContain('Running');
    expect(run.querySelector('.conv-tool__meta')?.textContent).toBe('running');
  });

  it('a work item paused by a restart of smurg says so in its status bar, as its plan does', async () => {
    const view = await openConversation({ role: 'agent', session: { status: 'stalled', purpose: 'item', topicId: 't_1', topicName: 'Checkout', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, attempt: 1 } });
    // Until the plan is known: the plain sentence.
    expect(statusBar().textContent).toContain('Stopped without a report.');
    act(() => {
      view.conn.emit('plan.updated', { plan: buildPlan({ topicId: 't_1', items: [buildWorkItem({ id: 'cart-api', number: 1, title: 'Cart API', state: 'stalled', stalledBy: 'restart' })] }) });
    });
    expect(statusBar().textContent).toContain('Paused: smurg was restarted.');
    expect(statusBar().textContent).not.toContain('Stopped without a report.');
    expect(within(statusBar()).getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('offers what a stopped item and a host-only retry allow, and says a refusal in words', async () => {
    const view = await openConversation({ role: 'agent', session: { status: 'failed', retryHostOnly: true }, reply: { permissions: [buildPermission({ sessionId: SID })] } });
    const status = statusBar();
    // Only the host may try this one again.
    expect(within(status).queryByRole('button', { name: 'Try again' })).toBeNull();
    updateSession(view, { status: 'stalled', purpose: 'item', topicId: 't_1', topicName: 'Checkout', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, attempt: 1 });
    expect(status.textContent).toContain('Stopped without a report.');
    fireEvent.click(within(status).getByRole('button', { name: 'Continue' }));
    expect(view.conn.lastRequest('plan.item.continue')?.payload).toEqual({ topicId: 't_1', itemId: 'cart-api' });
    act(() => {
      view.conn.fail('plan.item.continue', new SmurgError('conflict', 'not now'));
    });
    await settle();
    expect(status.textContent).toContain('That did not work');
  });

  it('a discussion offers "Write the spec now" while its topic is discussing, and says the account state', async () => {
    const view = await openConversation({ role: 'agent', session: { purpose: 'discussion', topicId: 't_1', topicName: 'Checkout', modeFixed: true } });
    const { buildTopic } = await import('@smurg/protocol/testing');
    act(() => view.conn.emit('topic.updated', { topic: buildTopic({ id: 't_1', phase: 'discussing' }) }));
    const status = statusBar();
    fireEvent.click(within(status).getByRole('button', { name: 'Write the spec now' }));
    expect(view.conn.lastRequest('topic.spec.request')?.payload).toEqual({ topicId: 't_1' });
    act(() => {
      view.conn.respond('topic.spec.request', {});
    });
    await settle();

    act(() => view.conn.emit('session.host', { account: { state: 'usage-limit', sessions: 2 }, mainProjectSettings: 'none' }));
    expect(status.textContent).toContain("The host's Claude account reached a usage limit.");
    act(() => view.conn.emit('session.host', { account: { state: 'logged-out', sessions: 2 }, mainProjectSettings: 'none' }));
    expect(status.textContent).toContain("Claude Code is not logged in on the host's computer.");
    fireEvent.click(within(status).getByRole('button', { name: 'Check login again' }));
    expect(view.conn.lastRequest('session.loginStatus')?.payload).toEqual({ sessionId: SID });
  });
});

describe('conversation column: the strip and the menus', () => {
  it('a member with agent access changes who is responsible, opens the root in code mode, and stops the agent', async () => {
    const view = await openConversation({ role: 'agent', session: { status: 'running', runningSince: FAKE_NOW, responsible: MEI } });
    const opened: CommandMap['openInCodeMode'][] = [];
    view.session.commands.handle('openInCodeMode', (payload) => {
      opened.push(payload);
    });
    const strip = screen.getByRole('group', { name: 'About this session' });
    fireEvent.click(within(strip).getByRole('button', { name: 'Responsible: Mei (you)' }));
    const menu = screen.getByRole('menu', { name: 'Who is responsible for this session' });
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['Ian · Host', 'Mei · Agent access · responsible for 1 session', 'Amy · Editor', 'No one: everyone watches']);
    fireEvent.click(within(menu).getByText('No one: everyone watches'));
    expect(view.conn.lastRequest('session.responsible.set')?.payload).toEqual({ sessionId: SID, userId: null });

    fireEvent.click(within(strip).getByRole('button', { name: 'Works in the shared main workspace. Browse it in code mode' }));
    expect(opened).toEqual([{ root: MAIN_ROOT, sessionId: SID }]);

    fireEvent.click(within(strip).getByRole('button', { name: 'Stop' }));
    expect(view.conn.lastRequest('session.interrupt')?.payload).toEqual({ sessionId: SID });
  });

  it('an Editor reads the strip: no menu, no Stop', async () => {
    await openConversation({ role: 'editor', session: { status: 'running', runningSince: FAKE_NOW } });
    const strip = screen.getByRole('group', { name: 'About this session' });
    expect(within(strip).getByText('Responsible: nobody')).toBeTruthy();
    expect(within(strip).queryByRole('button', { name: /Responsible/ })).toBeNull();
    expect(within(strip).queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('the permission dialog changes the mode, lists what is always allowed with a way to remove it, and names the host\'s own rules', async () => {
    const view = await openConversation({ role: 'agent', session: { permissionMode: 'ask-commands', ruleCount: 1 } });
    fireEvent.click(screen.getByRole('button', { name: 'Permission mode: Asks before commands' }));
    const dialog = screen.getByRole('dialog', { name: 'What this session may do without asking' });
    act(() => {
      view.conn.respond('session.rules.get', {
        rules: [{ id: 'rule_1', tool: 'Bash', pattern: 'pnpm test *', scope: 'session', addedBy: MEI, addedAt: FAKE_NOW }],
        host: { state: 'applied', rules: ['Bash(git status)'] },
      });
    });
    await settle();
    expect(within(dialog).getByText('Bash(pnpm test *)')).toBeTruthy();
    expect(within(dialog).getByText('this session · allowed by Mei')).toBeTruthy();
    expect(within(dialog).getByText(/agents here run 1 kind of command without asking/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show them' }));
    expect(within(dialog).getByText('Bash(git status)')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Asks before edits and commands' }));
    expect(view.conn.lastRequest('session.mode.set')?.payload).toEqual({ sessionId: SID, mode: 'ask-all' });
    act(() => {
      view.conn.respond('session.mode.set', { session: { ...view.agentSession, permissionMode: 'ask-all', ruleCount: 1 } });
    });
    await settle();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Bash(pnpm test *)' }));
    expect(view.conn.lastRequest('session.rule.remove')?.payload).toEqual({ sessionId: SID, ruleId: 'rule_1' });
  });

  it('a discussion says its fixed mode; "More actions" has Rename, and End only where the member may end it', async () => {
    const discussion = await openConversation({ role: 'host', session: { purpose: 'discussion', topicId: 't_1', topicName: 'Checkout', modeFixed: true } });
    expect(screen.getByRole('button', { name: /A discussion cannot do more/ })).toBeTruthy();
    expect(discussion.column.menuItems().map((item) => item.id)).toEqual(['rename']);
    discussion.unmount();

    const free = await openConversation({ role: 'host' });
    expect(free.column.menuItems().map((item) => item.id)).toEqual(['rename', 'end']);
    free.unmount();

    // Mei did not open it and is not responsible: she may rename, not end.
    const mei = await openConversation({ role: 'agent' });
    expect(mei.column.menuItems().map((item) => item.id)).toEqual(['rename']);
    mei.unmount();

    const amy = await openConversation({ role: 'editor' });
    expect(amy.column.menuItems()).toEqual([]);
  });

  it('an item\'s later attempt says so in the header', async () => {
    const view = await openConversation({ session: { purpose: 'item', topicId: 't_1', topicName: 'Checkout', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, attempt: 2 } });
    expect(within(view.column.header).getByText('Attempt 2')).toBeTruthy();
  });
});

describe('conversation column: a long conversation and anchors', () => {
  it(`mounts the newest ${MOUNT_LIMIT} items and shows older ones when asked`, async () => {
    const events = Array.from({ length: MOUNT_LIMIT + 50 }, (_, index) => line(index + 1));
    await openConversation({ events });
    const log = screen.getByRole('log');
    expect(log.querySelectorAll('.conv-row')).toHaveLength(MOUNT_LIMIT);
    fireEvent.click(within(log).getByRole('button', { name: 'Load earlier messages' }));
    expect(log.querySelectorAll('.conv-row')).toHaveLength(MOUNT_LIMIT + 50);
    expect(within(log).getByText('This is the start of the conversation.')).toBeTruthy();
  });

  it('reads an earlier page from the host when the window has no more', async () => {
    const view = await openConversation({ events: [line(11), line(12)], reply: { hasEarlier: true } });
    const log = screen.getByRole('log');
    fireEvent.click(within(log).getByRole('button', { name: 'Load earlier messages' }));
    expect(view.conn.lastRequest('session.history')?.payload).toMatchObject({ sessionId: SID, beforeSeq: 11 });
    expect(within(log).getByText('Loading earlier messages…')).toBeTruthy();
    act(() => {
      view.conn.respond('session.history', { events: [line(9), line(10)], hasEarlier: false, hasMore: false, questions: [], permissions: [], suggestions: [], moreCards: [] });
    });
    await settle();
    expect(log.querySelectorAll('.conv-row')).toHaveLength(4);
  });

  it('an inbox item leads to its card: history is read until the window holds it, the card gets the focus, the frame is told', async () => {
    const question = buildQuestion({ id: 'q_old', sessionId: SID, decider: IAN });
    const view = await openConversation({ events: [line(11), line(12)], reply: { hasEarlier: true } });
    view.column.anchor({ cardId: 'q_old' });
    await settle();
    expect(view.conn.lastRequest('session.history')?.payload).toMatchObject({ beforeSeq: 11 });
    act(() => {
      view.conn.respond('session.history', {
        events: [buildEvent('card', { seq: 10, card: 'question', id: 'q_old' })],
        hasEarlier: false,
        hasMore: false,
        questions: [question],
        permissions: [],
        suggestions: [],
        moreCards: [],
      });
    });
    await settle();
    const card = document.getElementById('conv-card-q_old') as HTMLElement;
    expect(document.activeElement).toBe(card);
    expect(card.hasAttribute('data-flash')).toBe(true);
    expect(view.column.anchorsShown()).toBe(1);
  });

  it('says "New activity" when something arrives while the reader is not at the end', async () => {
    const view = await openConversation({ events: [line(1), line(2)] });
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1_000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
    log.scrollTop = 300;
    fireEvent.scroll(log);
    expect(screen.queryByRole('button', { name: 'New activity' })).toBeNull();
    act(() => view.conn.emit('session.events', { sessionId: SID, events: [line(3)] }));
    // Nothing that arrives by itself moves a list someone is reading.
    expect(log.scrollTop).toBe(300);
    fireEvent.click(screen.getByRole('button', { name: 'New activity' }));
    expect(log.scrollTop).toBe(1_000);
    expect(screen.queryByRole('button', { name: 'New activity' })).toBeNull();
  });
});
