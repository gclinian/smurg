// One row of a conversation that cannot be drawn must not take the column with it (review R4-03): the rows around
// it, the open cards and the composer stay, and the host can still remove the entry.
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEvent } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildEvent, buildPermission } from '@smurg/protocol/testing';
import type { CommandMap } from '../../lib/commands.ts';
import type { MarkdownProps } from '../markdown/index.ts';
import { MEI, SID, openConversation, settle } from './test-support.tsx';

/** A text no row can draw: the renderer's bounds make sure no real text does this, so the test has to. */
const BROKEN = 'a text that makes its row throw';

vi.mock('../markdown/index.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../markdown/index.ts')>();
  return {
    ...real,
    Markdown: (props: MarkdownProps) => {
      if (props.text === BROKEN) throw new Error('this row cannot be drawn');
      return <real.Markdown {...props} />;
    },
  };
});

const message = (seq: number, text: string): ConversationEvent => buildEvent('message', { seq, messageId: `m_${seq}`, from: { ...MEI, role: 'agent' }, text });

function events(): ConversationEvent[] {
  return [
    message(1, 'Before it'),
    message(2, BROKEN),
    buildEvent('turn.started', { seq: 3, turnId: 't_1' }),
    buildEvent('text', { seq: 4, turnId: 't_1', blockId: 'b_1', text: BROKEN }),
    buildEvent('text', { seq: 5, turnId: 't_1', blockId: 'b_2', text: 'A block of the same answer' }),
    buildEvent('card', { seq: 6, card: 'permission', id: 'pr_1' }),
    message(7, 'After it'),
  ];
}

const rowOf = (seq: number): HTMLElement => document.querySelector(`.conv-row[data-seq="${seq}"]`) as HTMLElement;

describe('a row that cannot be drawn', () => {
  // The rows throw on purpose: React reports each one.
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  afterEach(() => errors.mockClear());

  it('leaves the other rows, the open card and the composer, and says so in its place', async () => {
    await openConversation({ role: 'agent', events: events(), reply: { permissions: [buildPermission({ id: 'pr_1', sessionId: SID })] }, session: { status: 'waiting-permission' } });
    const log = screen.getByRole('log');
    expect(log.textContent).toContain('Before it');
    expect(log.textContent).toContain('After it');
    expect(rowOf(2).textContent).toBe('This entry cannot be shown.');
    expect(rowOf(4).textContent).toBe('This entry cannot be shown.');
    // Nothing of the column is replaced by the frame's "cannot be shown": the card can be answered, a message sent.
    expect(within(log).getByRole('button', { name: 'Allow once' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /^Message Claude/ })).toBeTruthy();
    // Only the host removes entries.
    expect(within(rowOf(2)).queryByRole('button')).toBeNull();
  });

  it('gives the host "Remove this entry" for it, and draws the row again once the entry was replaced', async () => {
    const view = await openConversation({ role: 'host', events: events(), reply: { permissions: [buildPermission({ id: 'pr_1', sessionId: SID })] } });
    const asked: CommandMap['redactEvent'][] = [];
    view.session.commands.handle('redactEvent', (payload) => void asked.push(payload));
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: 'Remove this entry…' }));
    // An agent's text of several blocks: one button per block, so each can go by itself.
    const blocks = within(rowOf(4)).getAllByRole('button', { name: 'Remove this entry…' });
    expect(blocks).toHaveLength(2);
    fireEvent.click(blocks[0] as HTMLElement);
    expect(asked).toEqual([
      { sessionId: SID, seq: 2 },
      { sessionId: SID, seq: 4 },
    ]);

    act(() => {
      view.conn.emit('session.events', { sessionId: SID, events: [{ ...buildEvent('notice', { seq: 2, level: 'info' }), text: msg('conversation.redacted'), fallback: 'The host removed this entry.' } as ConversationEvent] });
    });
    await settle();
    expect(rowOf(2).textContent).toContain('The host removed this entry.');
    expect(rowOf(2).textContent).not.toContain('This entry cannot be shown.');
    // The other one is still what it was.
    expect(rowOf(4).textContent).toContain('This entry cannot be shown.');
  });
});
