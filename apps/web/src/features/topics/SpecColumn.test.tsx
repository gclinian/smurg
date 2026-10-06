// The spec column (DESIGN §5.4, §5.12 item 19): Read with the renderer, Edit with the collaborative editor, the
// revise box, "Generate plan" with its one confirmation, and the discussion's status line.
import { SmurgError, type Role, type SessionInfo, type Topic } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildSuggestion, buildTopic } from '@smurg/protocol/testing';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderInColumn } from '../../testing/columns.tsx';
import { T0, makeAgentSession, makeHumanLock } from '../../testing/fixtures.ts';
import { EditorEngineContext } from '../editor/engine.ts';
import { createFakeEngine } from '../editor/testing/fake-engine.ts';
import { bridgeDocs, testUser } from '../editor/testing/test-room.ts';
import { clearAskDrafts } from './AskBox.tsx';
import { specFile } from './model.ts';
import SpecColumn from './SpecColumn.tsx';
import { IAN, MEI, admitAs, settle, topicConnection } from './testing/support.tsx';

const SPEC = ['# Checkout', '', 'One page instead of three.', '', '## Goal', '', 'Buying takes one page.', '', '## Payments', '', 'Cards only.', ''].join('\n');
const DISCUSSION = makeAgentSession({ id: 'sess_d', purpose: 'discussion', topicId: 'tp_1', topicName: 'Checkout', title: undefined, status: 'idle' });
const withSpec = (overrides: Partial<Topic> = {}): Topic => buildTopic({ phase: 'spec', discussionSessionId: 'sess_d', spec: { exists: true }, ...overrides });

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  clearAskDrafts();
});

async function setup(options: { role?: Role; topic?: Topic; text?: string | null; sessions?: SessionInfo[] } = {}) {
  const topic = options.topic ?? withSpec();
  const world = { role: options.role ?? 'agent', topics: [topic], sessions: options.sessions ?? [DISCUSSION] };
  const conn = topicConnection(world);
  const fake = createFakeEngine();
  const view = renderInColumn(
    <EditorEngineContext.Provider value={fake.loader}>
      <SpecColumn topicId={topic.id} />
    </EditorEngineContext.Provider>,
    { target: { kind: 'spec', topicId: topic.id }, conn, admit: false },
  );
  const openColumn = vi.fn();
  view.session.commands.handle('openColumn', openColumn);
  const bridge = bridgeDocs(conn, testUser('Tester', 'dev:tester'), undefined, { canWrite: world.role !== 'viewer' });
  if (options.text !== null) bridge.addFile(specFile(topic), options.text ?? SPEC);
  disposers.push(() => view.session.dispose());
  admitAs(conn, world);
  const pump = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        bridge.pump();
      });
    }
  };
  await pump();
  return { ...view, conn, fake, openColumn, pump };
}

describe('the spec column: before a draft exists', () => {
  it('says so and lets a member with agent access ask for the first draft', async () => {
    const { conn, openColumn } = await setup({ topic: buildTopic({ discussionSessionId: 'sess_d' }) });
    expect(screen.getByText('No spec yet')).toBeTruthy();
    expect(screen.getByText('Discuss with the agent first; it writes the first draft.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent to write the spec now' }));
    expect(conn.lastRequest('topic.spec.request')?.payload).toEqual({ topicId: 'tp_1' });
    // The foot says what the discussion is doing and opens it beside this column.
    expect(screen.getByText('Discussion: Claude is idle.')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open the discussion' })[0] as HTMLElement);
    expect(openColumn).toHaveBeenCalledWith({ target: { kind: 'session', sessionId: 'sess_d' }, side: true });
    expect(conn.requestsOf('doc.open')).toHaveLength(0);
  });

  it('an editor reads the same sentence without the button', async () => {
    await setup({ role: 'editor', topic: buildTopic({ discussionSessionId: 'sess_d' }) });
    expect(screen.getByText('No spec yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask the agent to write the spec now' })).toBeNull();
  });
});

describe('the spec column: Read', () => {
  it('renders the document’s text section by section and shows where it lives', async () => {
    await setup();
    const article = screen.getByRole('article', { name: 'The spec' });
    expect(within(article).getByRole('heading', { name: 'Checkout' })).toBeTruthy();
    expect(within(article).getByRole('heading', { name: 'Payments' })).toBeTruthy();
    expect(within(article).getByText('Cards only.')).toBeTruthy();
    expect(screen.getByText('specs/checkout/SPEC.md')).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Read' }) as HTMLInputElement).getAttribute('aria-checked')).toBe('true');
  });

  it('"Ask the agent to revise" on a section sends the text with the quoted section to the discussion', async () => {
    const { conn } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent to revise "Payments"' }));
    expect(screen.getByText('About the section "Payments"')).toBeTruthy();
    const box = screen.getByRole('textbox', { name: 'What should the agent change?' });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'Add Apple Pay later.' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(conn.lastRequest('topic.revise')?.payload).toEqual({ topicId: 'tp_1', target: 'spec', text: 'Add Apple Pay later.', quote: { heading: 'Payments', text: '## Payments\n\nCards only.' } });
    await act(async () => {
      conn.respond('topic.revise', { messageId: 'm_1' });
    });
    expect(await screen.findByText('Sent to the discussion.')).toBeTruthy();
    // The box closes and the status line is back.
    expect(screen.queryByRole('textbox', { name: 'What should the agent change?' })).toBeNull();
    expect(screen.getByText('Discussion: Claude is idle.')).toBeTruthy();
  });

  it('an editor’s text becomes a suggestion, and the box says so before it is sent', async () => {
    const { conn } = await setup({ role: 'editor' });
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent to revise' }));
    expect(screen.getByText('Goes to Ian and Mei as a suggestion: your role cannot message agents.')).toBeTruthy();
    const box = screen.getByRole('textbox', { name: 'What should the agent change?' });
    fireEvent.change(box, { target: { value: 'Mention refunds.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    expect(conn.lastRequest('topic.revise')?.payload).toEqual({ topicId: 'tp_1', target: 'spec', text: 'Mention refunds.' });
    await act(async () => {
      conn.respond('topic.revise', { suggestion: buildSuggestion({ origin: 'revise', sessionId: 'sess_d' }) });
    });
    expect(await screen.findByText('Sent as a suggestion to Ian and Mei.')).toBeTruthy();
  });

  it('a refusal stays under the box with the text; a closed discussion offers the restart', async () => {
    const { conn, stores } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent to revise' }));
    const box = screen.getByRole('textbox', { name: 'What should the agent change?' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Keep this text.' } });
    // The Enter that picks an input-method candidate is not a send.
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(conn.requestsOf('topic.revise')).toHaveLength(0);
    fireEvent.keyDown(box, { key: 'Enter' });
    await act(async () => {
      conn.fail('topic.revise', new SmurgError('conflict', msg('topic.noDiscussion')));
    });
    expect(screen.getByText(/^Not sent: This topic's discussion is closed\. Restart the discussion to go on\./)).toBeTruthy();
    expect(box.value).toBe('Keep this text.');
    fireEvent.click(screen.getByRole('button', { name: 'Restart discussion' }));
    const { topicDialogs } = await import('./dialogs.ts');
    expect(topicDialogs(stores).getState()).toEqual({ kind: 'restart', topicId: 'tp_1' });
  });

  it('says who asked for the agent’s last change and opens the discussion at that edit', async () => {
    const at = new Date().setHours(14, 5, 0, 0);
    const { openColumn } = await setup({ topic: withSpec({ spec: { exists: true, lastAgentChange: { sessionId: 'sess_d', seq: 42, at, askedBy: MEI } } }) });
    expect(screen.getByText(/Changed by Claude at 14:05, asked by Mei/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show in the discussion' }));
    expect(openColumn).toHaveBeenCalledWith({ target: { kind: 'session', sessionId: 'sess_d' }, side: true, anchor: { seq: 42 } });
  });

  it('a viewer reads: no Edit, no revise box, no "Generate plan"', async () => {
    await setup({ role: 'viewer' });
    expect(screen.getByRole('heading', { name: 'Goal' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Ask the agent to revise' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Ask the agent to revise "/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate plan' })).toBeNull();
  });
});

describe('the spec column: Edit', () => {
  it('mounts the collaborative editor on the same document the first time Edit is shown', async () => {
    const { fake, pump, conn } = await setup();
    expect(fake.editors).toHaveLength(0);
    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
    await pump();
    await waitFor(() => expect(fake.bindings).toHaveLength(1));
    expect(fake.bindings[0]?.ytext.toString()).toBe(SPEC);
    expect(screen.getByRole('group', { name: 'Editor for specs/checkout/SPEC.md' })).toBeTruthy();
    // One document for both views: reading did not open a second one.
    expect(conn.requestsOf('doc.open')).toHaveLength(1);
  });
});

describe('the spec column: Generate plan', () => {
  it('nothing odd: asks the agent at once and opens the plan beside the spec', async () => {
    const { conn, openColumn } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Generate plan' }));
    expect(conn.lastRequest('plan.generate')?.payload).toEqual({ topicId: 'tp_1' });
    await act(async () => {
      conn.respond('plan.generate', {});
    });
    expect(openColumn).toHaveBeenCalledWith({ target: { kind: 'plan', topicId: 'tp_1' }, side: true });
  });

  it('asks once when someone is typing, the spec lists open questions or a question is open', async () => {
    const text = `${SPEC}\n## Open questions\n\n- Do prices include tax?\n- Which carriers?\n`;
    const { conn } = await setup({ text, sessions: [{ ...DISCUSSION, status: 'waiting-answer' }] });
    act(() => conn.emit('lock.state', { file: specFile(withSpec()), lock: makeHumanLock('specs/checkout/SPEC.md', IAN) }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate plan' }));
    expect(conn.requestsOf('plan.generate')).toHaveLength(0);
    const dialog = screen.getByRole('alertdialog', { name: 'Generate the plan now?' });
    expect(within(dialog).getByText('Ian is editing the spec now.')).toBeTruthy();
    expect(within(dialog).getByText('The spec lists 2 open questions.')).toBeTruthy();
    expect(within(dialog).getByText('A question is open in the discussion.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate plan' }));
    expect(conn.requestsOf('plan.generate')).toHaveLength(1);
  });

  it('reads "Update plan" once a plan exists, and says why when the daemon refuses', async () => {
    const { conn } = await setup({ topic: withSpec({ phase: 'plan', plan: { ...withSpec().plan, exists: true, valid: true, items: 2 } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Update plan' }));
    await act(async () => {
      conn.fail('plan.generate', new SmurgError('conflict', msg('topic.noDiscussion')));
    });
    expect(await screen.findByText("Could not ask for the plan: This topic's discussion is closed. Restart the discussion to go on.")).toBeTruthy();
  });
});

describe('the spec column: the discussion’s status line', () => {
  it.each([
    [{ status: 'running', runningSince: T0 } as const, /^Discussion: Claude is working · /],
    [{ status: 'waiting-answer' } as const, /^Discussion: Claude asks a question\.$/],
    [{ status: 'waiting-permission' } as const, /^Discussion: Claude asks for permission\.$/],
    [{ status: 'failed' } as const, /^Discussion: the session failed\.$/],
  ])('%#', async (session, text) => {
    await setup({ sessions: [{ ...DISCUSSION, ...session }] });
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('a lost discussion can be restarted from here; an archived topic only says so', async () => {
    const lost = await setup({ topic: withSpec({ discussion: 'lost' }), sessions: [{ ...DISCUSSION, status: 'ended', endedAt: T0, endReason: 'ended' }] });
    expect(screen.getByText('The discussion of this topic is closed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart discussion' })).toBeTruthy();
    lost.unmount();
    await setup({ topic: withSpec({ archived: true }) });
    await settle();
    expect(screen.queryByRole('button', { name: 'Ask the agent to revise' })).toBeNull();
  });
});
