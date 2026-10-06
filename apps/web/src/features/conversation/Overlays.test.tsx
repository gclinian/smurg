// Next-step cards, the dialogs about a session, "Send to agent" from the editor, and what the feature registers in
// the shell (slots.tsx).
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, type ConversationEvent } from '@smurg/protocol';
import { buildAgentSession, buildEvent, buildPlan, buildReportSummary, buildSuggestion, buildTopic, buildWorkItem } from '@smurg/protocol/testing';
import { capabilitiesForRole } from '../../lib/capabilities.ts';
import type { CommandMap } from '../../lib/commands.ts';
import { makeMember } from '../../testing/fixtures.ts';
import ConversationOverlays from './Overlays.tsx';
import { slots } from './slots.tsx';
import { AMY, IAN, MEI, SID, openConversation, settle } from './test-support.tsx';

const TOPIC = { purpose: 'discussion' as const, topicId: 't_1', topicName: 'Checkout', modeFixed: true };
const pointer = (seq: number, target: 'spec' | 'plan' | 'report', itemId?: string): ConversationEvent => buildEvent('pointer', { seq, target, topicId: 't_1', ...(itemId === undefined ? {} : { itemId }) });

function recordCommands(view: Awaited<ReturnType<typeof openConversation>>) {
  const columns: CommandMap['openColumn'][] = [];
  const code: CommandMap['openInCodeMode'][] = [];
  view.session.commands.handle('openColumn', (payload) => {
    columns.push(payload);
  });
  view.session.commands.handle('openInCodeMode', (payload) => {
    code.push(payload);
  });
  return { columns, code };
}

describe('next-step cards', () => {
  it('the newest spec pointer offers "Generate plan" to members with agent access and opens the plan beside the conversation', async () => {
    const view = await openConversation({ role: 'agent', session: TOPIC, events: [pointer(1, 'spec'), buildEvent('line', { seq: 2 }), pointer(3, 'spec')] });
    const { columns } = recordCommands(view);
    act(() => view.conn.emit('topic.updated', { topic: buildTopic({ id: 't_1', phase: 'spec' }) }));
    const cards = [...document.querySelectorAll<HTMLElement>('.conv-next')];
    expect(cards).toHaveLength(2);
    const [older, latest] = cards as [HTMLElement, HTMLElement];
    // An older pointer is a quiet line that still opens the spec.
    expect(older.textContent).toBe('Open spec');
    expect(latest.textContent).toContain('The spec draft is ready. Next: edit it together or ask for changes. When it is right:');
    fireEvent.click(within(latest).getByRole('button', { name: 'Open spec' }));
    expect(columns).toEqual([{ target: { kind: 'spec', topicId: 't_1' }, side: true }]);

    fireEvent.click(within(latest).getByRole('button', { name: 'Generate plan' }));
    expect(view.conn.lastRequest('plan.generate')?.payload).toEqual({ topicId: 't_1' });
    act(() => {
      view.conn.respond('plan.generate', {});
    });
    await settle();
    expect(columns.at(-1)).toEqual({ target: { kind: 'plan', topicId: 't_1' }, side: true });
  });

  it('the others read who can generate the plan; a plan and a report lead to their columns', async () => {
    const view = await openConversation({ role: 'editor', session: TOPIC, events: [pointer(1, 'spec'), pointer(2, 'plan'), pointer(3, 'report', 'cart-api')] });
    const { columns } = recordCommands(view);
    act(() => {
      view.conn.emit('topic.updated', { topic: buildTopic({ id: 't_1', phase: 'spec' }) });
      view.conn.emit('plan.updated', {
        plan: buildPlan({ topicId: 't_1', items: [buildWorkItem({ id: 'cart-api', number: 1, title: 'Cart API', state: 'done', report: buildReportSummary({ reviewers: [MEI] }) })] }),
      });
    });
    const [spec, plan, report] = [...document.querySelectorAll<HTMLElement>('.conv-next')] as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(spec).queryByRole('button', { name: 'Generate plan' })).toBeNull();
    expect(spec.textContent).toContain('Ian and Mei can generate the plan.');
    expect(plan.textContent).toContain('The plan is ready. Next: check who is responsible, then start.');
    fireEvent.click(within(plan).getByRole('button', { name: 'Open plan' }));
    expect(report.textContent).toContain('The result report of 1 · Cart API is written.');
    expect(report.textContent).toContain('Mei reviews it.');
    fireEvent.click(within(report).getByRole('button', { name: 'Open report' }));
    expect(columns).toEqual([
      { target: { kind: 'plan', topicId: 't_1' }, side: true },
      { target: { kind: 'report', topicId: 't_1', itemId: 'cart-api' }, side: true },
    ]);
  });
});

describe('the dialogs about a session', () => {
  it('"Rename session…" of the column\'s menu renames it for everyone', async () => {
    const view = await openConversation({ role: 'host', beside: <ConversationOverlays /> });
    act(() => view.column.menuItems().find((item) => item.id === 'rename')?.onSelect());
    const dialog = await screen.findByRole('dialog', { name: 'Rename this session' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: '  Cart work ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(view.conn.lastRequest('session.rename')?.payload).toEqual({ sessionId: SID, title: 'Cart work' });
    act(() => {
      view.conn.respond('session.rename', { session: { ...view.agentSession, title: 'Cart work' } });
    });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"End session…" asks first, and for a free session in a worktree whether to keep the worktree', async () => {
    const view = await openConversation({ role: 'host', session: { root: { kind: 'worktree', worktreeId: 'wt_1' }, branch: 'smurg/ian/cart' }, beside: <ConversationOverlays /> });
    act(() => view.column.menuItems().find((item) => item.id === 'end')?.onSelect());
    const dialog = await screen.findByRole('alertdialog', { name: 'End Claude (Ian)?' });
    expect(dialog.textContent).toContain('The agent stops and the session takes no more messages. The conversation stays readable.');
    const keep = within(dialog).getByRole('checkbox', { name: /Keep its worktree/ }) as HTMLInputElement;
    expect(keep.checked).toBe(true);
    fireEvent.click(keep);
    fireEvent.click(within(dialog).getByRole('button', { name: 'End session' }));
    expect(view.conn.lastRequest('session.end')?.payload).toEqual({ sessionId: SID, keepWorktree: false });
  });

  it('a session row\'s context menu offers what the member may do', () => {
    const env = (role: 'host' | 'agent' | 'editor', userId: string) => ({ stores: {} as never, commands: {} as never, capabilities: capabilitiesForRole(role), member: makeMember({ userId, role }) });
    const free = buildAgentSession({ id: SID, openedBy: IAN, responsible: MEI });
    const menu = slots.menus?.session;
    expect(menu?.(free, env('host', IAN.userId)).map((item) => item.id)).toEqual(['conversation.rename', 'conversation.end']);
    // Responsible for it: Mei may end it.
    expect(menu?.(free, env('agent', MEI.userId)).map((item) => item.id)).toEqual(['conversation.rename', 'conversation.end']);
    expect(menu?.(buildAgentSession({ id: SID, openedBy: IAN }), env('agent', MEI.userId)).map((item) => item.id)).toEqual(['conversation.rename']);
    expect(menu?.(free, env('editor', AMY.userId))).toEqual([]);
    // A topic's discussion is never ended here; an ended session and a terminal have nothing.
    expect(menu?.(buildAgentSession({ id: SID, purpose: 'discussion', topicId: 't_1' }), env('host', IAN.userId)).map((item) => item.id)).toEqual(['conversation.rename']);
    expect(menu?.(buildAgentSession({ id: SID, status: 'ended', endedAt: 1 }), env('host', IAN.userId))).toEqual([]);
    expect(slots.feature).toBe('conversation');
    expect(slots.columns?.conversation).toBeDefined();
    expect(slots.overlays).toHaveLength(1);
  });
});

describe('"Send to agent" from the editor', () => {
  const selection = { file: { root: MAIN_ROOT, path: 'src/cart.ts' }, startLine: 3, endLine: 4, text: 'const a = 1;\nconst b = 2;' };

  it('puts the quoted lines into that session\'s composer, beside the editor, to complete first', async () => {
    const view = await openConversation({ role: 'host', beside: <ConversationOverlays /> });
    const { code } = recordCommands(view);
    await act(async () => {
      await view.session.commands.whenHandled('sendSelectionAsSuggestion');
      await view.session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: SID });
    });
    const box = screen.getByRole('combobox', { name: 'Message Claude · Claude (Ian)' }) as HTMLTextAreaElement;
    expect(box.value).toBe('src/cart.ts:3-4\n```\nconst a = 1;\nconst b = 2;\n```\n');
    expect(document.activeElement).toBe(box);
    expect(screen.getByRole('button', { name: 'src/cart.ts, lines 3–4' })).toBeTruthy();
    expect(code).toEqual([{ root: MAIN_ROOT, sessionId: SID }]);

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(view.conn.lastRequest('session.message.send')?.payload).toEqual({ sessionId: SID, text: box.value, origin: 'selection' });
  });

  it('sent at once it is a message from a member with agent access and a suggestion with its source from an Editor', async () => {
    const host = await openConversation({ role: 'host', beside: <ConversationOverlays /> });
    await act(async () => {
      await host.session.commands.whenHandled('sendSelectionAsSuggestion');
      void host.session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: SID, mode: 'send' });
    });
    expect(host.conn.lastRequest('session.message.send')?.payload).toMatchObject({ sessionId: SID, origin: 'selection' });
    host.unmount();

    const editor = await openConversation({ role: 'editor', beside: <ConversationOverlays /> });
    await act(async () => {
      await editor.session.commands.whenHandled('sendSelectionAsSuggestion');
      void editor.session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: SID, mode: 'send' });
    });
    expect(editor.conn.lastRequest('suggest.create')?.payload).toEqual({
      sessionId: SID,
      text: 'src/cart.ts:3-4\n```\nconst a = 1;\nconst b = 2;\n```',
      source: { file: selection.file, startLine: 3, endLine: 4 },
    });
    act(() => {
      editor.conn.respond('suggest.create', { suggestion: buildSuggestion({ sessionId: SID, author: AMY }) });
    });
    await settle();
    expect(screen.getByText('Sent to Claude (Ian).')).toBeTruthy();
  });

  it('a viewer is told that they cannot; a session that is gone is said so', async () => {
    const viewer = await openConversation({ role: 'viewer', beside: <ConversationOverlays /> });
    await act(async () => {
      await viewer.session.commands.whenHandled('sendSelectionAsSuggestion');
      await viewer.session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: SID });
    });
    expect(screen.getByText('As a viewer you cannot send text to an agent.')).toBeTruthy();
    viewer.unmount();

    const host = await openConversation({ role: 'host', beside: <ConversationOverlays /> });
    await act(async () => {
      await host.session.commands.whenHandled('sendSelectionAsSuggestion');
      await host.session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: 'sess_gone' });
    });
    expect(screen.getByText('That session no longer exists.')).toBeTruthy();
  });
});
