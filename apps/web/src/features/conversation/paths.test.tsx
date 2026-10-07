// Paths in a conversation's text and what a reader's browser asks the host about them (review R4-04). Reading is not
// asking: a text that names the host's private files must not put a refused request into the audit log under the name
// of everyone who has it on screen, and no text can make its readers' connections count refusals.
import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SmurgError, type ConversationEvent, type Role } from '@smurg/protocol';
import { buildEvent } from '@smurg/protocol/testing';
import { makeEntry } from '../../testing/fixtures.ts';
import { openConversation, settle } from './test-support.tsx';

const PRIVATE = ['.envrc', 'CLAUDE.local.md', '.git/hooks/pre-commit', '.git/config', '.claude/settings.local.json', 'packages/api/.envrc', '.smurg/state.json', '.GIT/config'];
const SENTENCE = `I left your ${PRIVATE.slice(0, 2).join(' and ')} alone; the hook is ${PRIVATE[2]}. See also ${PRIVATE.slice(3).join(', ')} and src/cart.ts.`;

const text = (seq: number, body: string): ConversationEvent => buildEvent('text', { seq, turnId: 't_1', blockId: `b_${seq}`, text: body });
const answer = (seq: number, body: string): ConversationEvent[] => [buildEvent('turn.started', { seq: seq - 1, turnId: 't_1' }), text(seq, body)];

/** Every path the page of `role` asks the host about, the host answering each one ("there is no such file"). */
async function asked(role: Role, events: readonly ConversationEvent[]): Promise<string[]> {
  const view = await openConversation({ role, events });
  const paths: string[] = [];
  view.conn.handle('file.stat', (ref) => {
    paths.push(ref.path);
    throw new SmurgError('not_found');
  });
  for (let round = 0; round < 12; round += 1) await settle();
  view.unmount();
  return paths;
}

describe('paths in a conversation: what a reader asks the host', () => {
  it("a host-private name in an agent's text is never asked about by a member who is not the host", async () => {
    for (const role of ['agent', 'editor', 'viewer'] as const) expect(await asked(role, answer(2, SENTENCE)), role).toEqual(['src/cart.ts']);
    // In a person's message too (an accepted suggestion is one).
    const message = buildEvent('message', { seq: 1, messageId: 'm_1', from: { userId: 'dev:mei', displayName: 'Mei', role: 'agent' }, text: SENTENCE });
    expect(await asked('editor', [message])).toEqual(['src/cart.ts']);
    // The host may open them, so the host's page asks.
    expect((await asked('host', answer(2, SENTENCE))).sort()).toEqual([...PRIVATE.filter((path) => !path.startsWith('.smurg')), 'src/cart.ts', '.smurg/state.json'].sort());
  });

  it('61 such names on one screen are not one request', async () => {
    const names = Array.from({ length: 61 }, (_, index) => `.git/a${index + 1}`).join(' ');
    expect(await asked('viewer', answer(2, names))).toEqual([]);
  });

  it('asks about one path first, then a few at a time; a path that resolves is a button', async () => {
    const view = await openConversation({ role: 'editor', events: answer(2, 'Look at src/cart.ts, src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts and src/gone.ts.') });
    await settle();
    const asked = (): string[] => view.conn.requestsOf('file.stat').map((request) => request.payload.path);
    // Seven names on the screen: one request is out. What the host says to it decides whether the others are asked.
    expect(asked()).toEqual(['src/cart.ts']);
    act(() => view.conn.respond('file.stat', { entry: makeEntry('src/cart.ts') }));
    await settle();
    expect(asked()).toEqual(['src/cart.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    act(() => {
      for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) view.conn.respond('file.stat', { entry: makeEntry(path) });
      // "There is no such file" is an answer, not a refusal: the rest is still asked.
      view.conn.fail('file.stat', new SmurgError('not_found'));
    });
    await settle();
    expect(asked()).toEqual(['src/cart.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/gone.ts']);
    act(() => {
      view.conn.respond('file.stat', { entry: makeEntry('src/e.ts') });
      view.conn.fail('file.stat', new SmurgError('not_found'));
    });
    await settle();
    expect([...document.querySelectorAll('.md-path')].map((node) => node.textContent)).toEqual(['src/cart.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/e.ts']);
  });

  it('a refused path is never asked about again, and nothing is asked for a while after a refusal', async () => {
    const view = await openConversation({ role: 'editor', events: answer(2, 'Look at src/cart.ts, src/linked.ts and src/gone.ts.') });
    await settle();
    act(() => view.conn.respond('file.stat', { entry: makeEntry('src/cart.ts') }));
    await settle();
    expect(view.conn.requestsOf('file.stat').map((request) => request.payload.path)).toEqual(['src/cart.ts', 'src/linked.ts', 'src/gone.ts']);
    act(() => {
      // A hard link, a link that leads to a private file: names nobody can know to be refused before asking.
      view.conn.fail('file.stat', new SmurgError('path_denied'));
      view.conn.fail('file.stat', new SmurgError('not_found'));
    });
    await settle();
    expect([...document.querySelectorAll('.md-path')].map((node) => node.textContent)).toEqual(['src/cart.ts']);

    // More text arrives right after the refusal: its paths stay text, nothing is asked.
    act(() => view.conn.emit('session.events', { sessionId: 'sess_a', events: [text(3, 'And src/linked.ts again, with src/other.ts.')] }));
    await settle();
    expect(view.conn.requestsOf('file.stat')).toHaveLength(3);
  });

  it('names the host refuses for a reason no spelling shows cost a reader one refused request, not one per name (review R4-04, second round)', async () => {
    // A path THROUGH a file is refused for everyone, the host included; a hard-linked file for everyone but the host.
    const through = (file: string, count: number): string => Array.from({ length: count }, (_, index) => `${file}/a${index + 1}`).join(' ');
    for (const role of ['editor', 'host'] as const) {
      const view = await openConversation({ role, events: [...answer(2, through('README.md', 32)), text(3, through('package.json', 32))] });
      await settle();
      // Two texts of 32 such names on one screen: one request is out, the other 63 wait for what the host says.
      expect(view.conn.requestsOf('file.stat').map((request) => request.payload.path), role).toEqual(['README.md/a1']);
      act(() => view.conn.fail('file.stat', new SmurgError('path_denied')));
      await settle();
      // The refusal is the answer for every name that waited, and for text that arrives right after it.
      act(() => view.conn.emit('session.events', { sessionId: 'sess_a', events: [text(4, 'See src/cart.ts and docs/README.md/x.')] }));
      await settle();
      expect(view.conn.requestsOf('file.stat'), role).toHaveLength(1);
      expect(document.querySelector('.md-path')).toBeNull();
      view.unmount();
    }
  });
});
