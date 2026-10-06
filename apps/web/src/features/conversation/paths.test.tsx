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

async function asked(role: Role, events: readonly ConversationEvent[]): Promise<string[]> {
  const view = await openConversation({ role, events });
  await settle();
  const paths = view.conn.requestsOf('file.stat').map((request) => request.payload.path);
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

  it('a path that resolves is a button; one that is refused is never asked about again, and nothing is asked for a while after a refusal', async () => {
    const view = await openConversation({ role: 'editor', events: answer(2, 'Look at src/cart.ts, src/linked.ts and src/gone.ts.') });
    await settle();
    const requests = view.conn.requestsOf('file.stat');
    expect(requests.map((request) => request.payload.path)).toEqual(['src/cart.ts', 'src/linked.ts', 'src/gone.ts']);
    act(() => {
      view.conn.respond('file.stat', { entry: makeEntry('src/cart.ts') });
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
});
