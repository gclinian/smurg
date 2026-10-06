// "My own Claude Code rules" (DESIGN §2.11 as changed by OWNER-DECISIONS Q7 = B): the allow rules of the host's own
// Claude Code settings apply to agents here; the host is told once which they are. Information only: nothing on the
// page decides anything, and having the list on screen is all it takes for the inbox item to leave.
import { SmurgError } from '@smurg/protocol';
import { buildInboxItem } from '@smurg/protocol/testing';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupHostRules, type HostRule } from './host-rules.ts';
import { foundSentence } from './HostRulesSection.tsx';
import { defaultFixture, renderConsole, settle } from './test-support.tsx';

const RULES: HostRule[] = [
  { rule: 'Bash(npm run *)', source: 'user' },
  { rule: 'Bash(git status)', source: 'user' },
  { rule: 'mcp__mail', source: 'project' },
  { rule: 'WebFetch(domain:example.test)', source: 'managed' },
];

const section = async (): Promise<HTMLElement> => (await screen.findByRole('heading', { level: 2, name: 'My own Claude Code rules' })).closest('section') as HTMLElement;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the host\'s own Claude Code rules (pure)', () => {
  it('groups the rules by where they come from, the host\'s own file first, and leaves out empty groups', () => {
    expect(groupHostRules(RULES)).toEqual([
      { source: 'user', rules: ['Bash(npm run *)', 'Bash(git status)'] },
      { source: 'project', rules: ['mcp__mail'] },
      { source: 'managed', rules: ['WebFetch(domain:example.test)'] },
    ]);
    expect(groupHostRules([])).toEqual([]);
  });

  it('says how many kinds of commands run without asking, in the daemon\'s own words', () => {
    expect(foundSentence(4)).toBe('Your own Claude Code settings allow 4 kinds of commands without asking. Agents here run them without asking too.');
    expect(foundSentence(1)).toBe('Your own Claude Code settings allow 1 kind of commands without asking. Agents here run them without asking too.');
  });
});

describe('host console: my own Claude Code rules', () => {
  it('without rules the section says so, asks nothing and tells the daemon nothing', async () => {
    const view = renderConsole({ section: 'host-rules' });
    const rules = await section();
    expect(await within(rules).findByText('No allow rules of your own Claude Code settings were found. The list fills in when an agent session starts.')).toBeTruthy();
    await settle();
    expect(view.conn.requestsOf('admin.hostRules.seen')).toHaveLength(0);
    expect(within(rules).queryByRole('button')).toBeNull();
  });

  it('opened from the inbox item: the rules are listed by source, the page says they APPLY, and seeing them is all it takes (no decision, no button)', async () => {
    const fixture = defaultFixture();
    fixture.hostRules = { rules: RULES, seen: false };
    const item = buildInboxItem('attention', { key: 'attention:host-rules:workspace', subject: 'host-rules', waiting: false, target: { kind: 'console', section: 'host-rules' }, excerpt: '' });
    fixture.inbox = [item];
    const view = renderConsole({ fixture, section: 'host-rules' });
    const rules = await section();
    expect(await within(rules).findByText('Your own Claude Code settings allow 4 kinds of commands without asking. Agents here run them without asking too.')).toBeTruthy();
    expect(within(rules).getByText(/^Every agent session here runs as you, with your Claude Code settings: what the rules below allow runs without a permission request/)).toBeTruthy();
    expect(within(rules).getByText(/What a discussion agent may do stays limited by smurg, whatever the rules say\.$/)).toBeTruthy();
    const user = within(rules).getByRole('region', { name: 'Your user settings (~/.claude/settings.json)' });
    expect(within(user).getAllByRole('listitem').map((entry) => entry.textContent)).toEqual(['Bash(npm run *)', 'Bash(git status)']);
    expect(within(within(rules).getByRole('region', { name: "The project's settings (.claude/settings.json)" })).getByText('mcp__mail')).toBeTruthy();
    expect(within(within(rules).getByRole('region', { name: 'Managed settings (set by an administrator)' })).getByText('WebFetch(domain:example.test)')).toBeTruthy();
    expect(within(rules).queryByRole('region', { name: "The project's local settings (.claude/settings.local.json)" })).toBeNull();
    // Information only (OWNER-DECISIONS Q7): no "ask anyway", no "keep my rules", nothing to press.
    expect(within(rules).queryByRole('button')).toBeNull();
    expect(rules.textContent).not.toMatch(/ask anyway|keep my rules/i);

    // The list was on the host's screen: the daemon is told once.
    await waitFor(() => expect(view.conn.requestsOf('admin.hostRules.seen')).toHaveLength(1));
    expect(view.conn.lastRequest('admin.hostRules.seen')?.payload).toEqual({});
    // The daemon takes the inbox item away; the list is read again and is "seen" now: nothing more is sent.
    fixture.hostRules = { rules: RULES, seen: true };
    await act(async () => {
      view.conn.respond('admin.hostRules.seen', {});
      view.conn.emit('inbox.changed', { upsert: [], remove: [item.key] });
    });
    await settle();
    expect(view.conn.requestsOf('admin.hostRules.seen')).toHaveLength(1);
    expect(within(rules).getByText('Bash(git status)')).toBeTruthy();
  });

  it('a list the host has not scrolled to does not count as seen; when it comes into view it does', async () => {
    // jsdom has no IntersectionObserver: a stand-in the test drives.
    const observers: { callback: IntersectionObserverCallback; nodes: Element[] }[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private readonly entry: { callback: IntersectionObserverCallback; nodes: Element[] };
        constructor(callback: IntersectionObserverCallback) {
          this.entry = { callback, nodes: [] };
          observers.push(this.entry);
        }
        observe(node: Element): void {
          this.entry.nodes.push(node);
        }
        disconnect(): void {
          this.entry.nodes = [];
        }
      },
    );
    const fixture = defaultFixture();
    fixture.hostRules = { rules: RULES, seen: false };
    // The console was opened at its top (no section in the route).
    const view = renderConsole({ fixture });
    const rules = await section();
    await within(rules).findByText('Bash(git status)');
    await settle();
    expect(view.conn.requestsOf('admin.hostRules.seen')).toHaveLength(0);

    const list = rules.querySelector('.console-host-rules') as HTMLElement;
    const observer = observers.find((entry) => entry.nodes.includes(list));
    expect(observer).toBeDefined();
    act(() => observer?.callback([{ isIntersecting: true, target: list } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    await waitFor(() => expect(view.conn.requestsOf('admin.hostRules.seen')).toHaveLength(1));
  });

  it('rules the host was shown before are listed without telling the daemon again; new rules bring the note back', async () => {
    const fixture = defaultFixture();
    fixture.hostRules = { rules: RULES.slice(0, 1), seen: true };
    const view = renderConsole({ fixture, section: 'host-rules' });
    const rules = await section();
    expect(await within(rules).findByText('Your own Claude Code settings allow 1 kind of commands without asking. Agents here run them without asking too.')).toBeTruthy();
    await settle();
    expect(view.conn.requestsOf('admin.hostRules.seen')).toHaveLength(0);

    // An agent session reported a new set: the daemon puts the item back, the page reads the list again and says "seen".
    fixture.hostRules = { rules: RULES, seen: false };
    const item = buildInboxItem('attention', { key: 'attention:host-rules:workspace', subject: 'host-rules', waiting: false, target: { kind: 'console', section: 'host-rules' }, excerpt: '' });
    act(() => view.conn.emit('inbox.changed', { upsert: [item], remove: [] }));
    expect(await within(rules).findByText('mcp__mail')).toBeTruthy();
    await waitFor(() => expect(view.conn.requestsOf('admin.hostRules.seen')).toHaveLength(1));
  });

  it('a list that cannot be read says so and can be tried again; a "seen" that failed is sent again with the next look', async () => {
    const fixture = defaultFixture();
    // The daemon fails the first read (the fixture is read at request time).
    let failing = true;
    Object.defineProperty(fixture, 'hostRules', {
      get: () => {
        if (failing) throw new SmurgError('internal');
        return { rules: RULES, seen: false };
      },
    });
    const view = renderConsole({ fixture, section: 'host-rules' });
    const rules = await section();
    expect(await within(rules).findByText('Could not read your rules: Something went wrong on the host.')).toBeTruthy();
    expect(view.conn.requestsOf('admin.hostRules.seen')).toHaveLength(0);
    failing = false;
    fireEvent.click(within(rules).getByRole('button', { name: 'Reload' }));
    expect(await within(rules).findByText('Bash(git status)')).toBeTruthy();
    expect(within(rules).queryByText(/^Could not read your rules/)).toBeNull();

    // The daemon did not take the "seen": the list stays as it is, and the next time it is read it is told again.
    await waitFor(() => expect(view.conn.requestsOf('admin.hostRules.seen')).toHaveLength(1));
    await act(async () => {
      view.conn.fail('admin.hostRules.seen', new SmurgError('internal'));
    });
    const item = buildInboxItem('attention', { key: 'attention:host-rules:workspace', subject: 'host-rules', waiting: false, target: { kind: 'console', section: 'host-rules' }, excerpt: '' });
    act(() => view.conn.emit('inbox.changed', { upsert: [item], remove: [] }));
    await waitFor(() => expect(view.conn.requestsOf('admin.hostRules.seen')).toHaveLength(2));
  });
});
