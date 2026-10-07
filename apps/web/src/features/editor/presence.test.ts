import { afterEach, describe, expect, it } from 'vitest';
import type { PresenceAgent } from '@smurg/protocol';
import { agentsAtWorkOnly, editorPresenceCss, participantsOf } from './presence.ts';

const human = (name: string, userId: string, color = '#3b82f6', selection: unknown = null) => ({ user: { name, color, kind: 'human', userId }, selection });
const agent = (name: string, color = '#f59e0b') => ({ user: { name, color, kind: 'agent', userId: 'dev:host' }, selection: { anchor: {}, head: {} } });

afterEach(() => {
  for (const node of document.querySelectorAll('style[data-test-presence]')) node.remove();
});

/** Applies the CSS the way the editor does (textContent of a <style>) and returns the parsed rules. */
function applyCss(css: string): CSSStyleRule[] {
  const style = document.createElement('style');
  style.dataset['testPresence'] = '';
  style.textContent = css;
  document.head.appendChild(style);
  return [...(style.sheet?.cssRules ?? [])] as CSSStyleRule[];
}

describe('remote cursors: names and colours for people AND agents', () => {
  it('cursor CSS escaping: a member named like a CSS / HTML injection cannot break out of its label', () => {
    const states = new Map<number, Record<string, unknown>>([
      [101, human('"}body{display:none}*{color:red}', 'dev:mallory', 'red;}body{display:none')],
      [102, human('</style><script>window.__pwned=1</script>', 'dev:eve')],
      [103, human('\\"; } .ui-dialog { display: none } /*', 'dev:trudy')],
      [104, human('line\nbreak{}\u0000\u007f', 'dev:nl')],
      [105, agent('Claude (Ian)')],
      [106, human('自己', 'dev:self')],
    ]);
    const css = editorPresenceCss(states, 106);
    const rules = applyCss(css);
    expect(rules.length).toBeGreaterThan(0);
    // Every rule the stylesheet contains targets y-monaco's per-client classes, nothing else on the page.
    for (const rule of rules) expect(rule.selectorText).toMatch(/^\.yRemoteSelection(Head)?-(101|102|103|104|105)(:hover)?(::after)?$/);
    expect(css).not.toContain('</style');
    expect(document.querySelector('script')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    // An invalid colour falls back to a neutral one instead of injecting declarations.
    expect(css).toContain('.yRemoteSelection-101{background-color:#88888840}');
    // The label is a CSS string: the names survive as text, with their quotes escaped.
    const label = rules.find((rule) => rule.selectorText === '.yRemoteSelectionHead-105::after');
    expect(label?.style.getPropertyValue('content')).toContain('Claude (Ian)');
    // Our own client gets no remote cursor.
    expect(css).not.toContain('-106');
  });

  it('a caret name shows after a change, then fades; only the client that changed gets it back', () => {
    const states = new Map<number, Record<string, unknown>>([
      [7, human('Amy', 'dev:amy')],
      [8, human('Bob', 'dev:bob')],
    ]);
    const before = editorPresenceCss(states, 1, new Map([[7, 1], [8, 1]]));
    expect(before).toContain('.yRemoteSelectionHead-7::after{content:"Amy"');
    expect(before).toMatch(/yRemoteSelectionHead-7::after\{[^}]*animation:smurg-cursor-label-b 2\.5s ease-in forwards/);
    // Amy moved: her label's animation switches (and so restarts); Bob's stays what it was (still faded).
    const after = editorPresenceCss(states, 1, new Map([[7, 2], [8, 1]]));
    expect(after).toMatch(/yRemoteSelectionHead-7::after\{[^}]*animation:smurg-cursor-label-a /);
    expect(after).toMatch(/yRemoteSelectionHead-8::after\{[^}]*animation:smurg-cursor-label-b /);
    // Hovering the caret shows the name again.
    expect(after).toContain('.yRemoteSelectionHead-8:hover::after{animation:none;opacity:1}');
  });

  it('agents are drawn with a dashed caret and labelled "Claude (Ian)"', () => {
    const css = editorPresenceCss(new Map([[7, agent('Claude (Ian)')]]), 1);
    expect(css).toContain('.yRemoteSelectionHead-7{border-left-style:dashed}');
    expect(css).toContain('"Claude (Ian)"');
  });

  it('participants: everyone but me (my other tab included), people before agents, one entry per person', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, human('Amy', 'dev:amy')],
      [2, human('Amy', 'dev:amy', '#3b82f6', { anchor: {}, head: {} })], // Amy's second tab, with a cursor
      [3, human('Me', 'dev:me')], // my other tab
      [4, agent('Claude (Ian)')],
      [5, { user: { name: '', color: '#000000' } }],
      [6, { nothing: true }],
      [9, human('Me', 'dev:me')], // this client
    ]);
    const list = participantsOf(states, 9, 'dev:me');
    expect(list.map((p) => [p.name, p.kind, p.clientId])).toEqual([
      ['Amy', 'human', 2],
      ['Claude (Ian)', 'agent', 4],
    ]);
  });

  it('an agent that does not work is not "also in this file": its caret and its entry go, a working agent stays', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, human('Amy', 'dev:amy')],
      [4, agent('Claude (Ian)', '#f59e0b')],
      [5, agent('Claude (Ian)', '#22c55e')],
      [9, human('Me', 'dev:me')],
    ]);
    // The host's presence list: one session per colour (the daemon gives every agent session its own).
    const presence = (first: PresenceAgent['status'], second: PresenceAgent['status']): PresenceAgent[] => [
      { sessionId: 's_1', ownerUserId: 'dev:host', displayName: 'Claude (Ian)', color: '#f59e0b', status: first },
      { sessionId: 's_2', ownerUserId: 'dev:host', displayName: 'Claude (Ian)', color: '#22c55e', status: second },
    ];
    const shown = (agents: readonly PresenceAgent[]): number[] => participantsOf(agentsAtWorkOnly(states, agents), 9, 'dev:me').map((p) => p.clientId);

    expect(shown(presence('running', 'waiting-permission'))).toEqual([1, 4, 5]);
    // The first session's turn ended (idle), the second one's item is done: neither is in the file any more.
    expect(shown(presence('idle', 'waiting-permission'))).toEqual([1, 5]);
    expect(shown(presence('idle', 'done'))).toEqual([1]);
    expect(shown(presence('stalled', 'failed'))).toEqual([1]);
    // Their carets are not drawn either.
    const css = editorPresenceCss(agentsAtWorkOnly(states, presence('idle', 'running')), 9);
    expect(css).not.toContain('yRemoteSelectionHead-4');
    expect(css).toContain('.yRemoteSelectionHead-5{border-left-style:dashed}');
    expect(css).toContain('yRemoteSelectionHead-1');

    // A topic's sessions: the presence list and the caret name an agent alike, after its work item or its topic
    // (`Claude (Checkout)`, protocol `agentSessionName`). The colour is what tells two sessions apart, in any case
    // of its letters.
    const topic = new Map<number, Record<string, unknown>>([
      [1, human('Amy', 'dev:amy')],
      [4, { user: { name: 'Claude (Checkout)', color: '#F59E0B', kind: 'agent', userId: 'dev:mei' }, selection: { anchor: {}, head: {} } }],
      [5, { user: { name: 'Claude (Cart API)', color: '#22c55e', kind: 'agent', userId: 'dev:host' }, selection: { anchor: {}, head: {} } }],
    ]);
    const topicPresence = (first: PresenceAgent['status'], second: PresenceAgent['status']): PresenceAgent[] => [
      { sessionId: 's_1', ownerUserId: 'dev:mei', displayName: 'Claude (Checkout)', color: '#f59e0b', status: first },
      { sessionId: 's_2', ownerUserId: 'dev:host', displayName: 'Claude (Cart API)', color: '#22c55e', status: second },
    ];
    const shownOf = (agents: readonly PresenceAgent[]): number[] => participantsOf(agentsAtWorkOnly(topic, agents), 9, 'dev:me').map((p) => p.clientId);
    expect(shownOf(topicPresence('idle', 'running'))).toEqual([1, 5]);
    expect(shownOf(topicPresence('running', 'done'))).toEqual([1, 4]);
    expect(shownOf(topicPresence('idle', 'done'))).toEqual([1]);

    // An agent the presence list does not know (the list has not arrived, another colour) is left as it is.
    expect(shown([])).toEqual([1, 4, 5]);
    expect(shown([{ sessionId: 's_3', ownerUserId: 'dev:host', displayName: 'Claude (Ian)', color: '#000000', status: 'idle' }])).toEqual([1, 4, 5]);
    // Two sessions that cannot be told apart: the caret stays while one of them works.
    const twins: PresenceAgent[] = [
      { sessionId: 's_1', ownerUserId: 'dev:host', displayName: 'Claude (Ian)', color: '#f59e0b', status: 'idle' },
      { sessionId: 's_9', ownerUserId: 'dev:host', displayName: 'Claude (Ian)', color: '#f59e0b', status: 'running' },
    ];
    expect(shown(twins)).toEqual([1, 4, 5]);
  });
});
