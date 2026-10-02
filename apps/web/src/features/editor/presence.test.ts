import { afterEach, describe, expect, it } from 'vitest';
import { editorPresenceCss, participantsOf } from './presence.ts';

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
});
