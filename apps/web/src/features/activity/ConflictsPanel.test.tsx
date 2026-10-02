import { MAIN_ROOT, agentDisplayName, lockedError, type ConflictRecord, type Role } from '@smurg/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CommandMap } from '../../lib/commands.ts';
import { HOST_USER, T0, makeAgentLock, makeConflict } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { ConflictsPanel } from './index.tsx';


const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const AGENT = { kind: 'agent' as const, sessionId: 'sess_1', ownerUserId: HOST_USER, displayName: 'Claude (Ian)' };

function conflictOn(path: string, overrides: Partial<ConflictRecord> = {}): ConflictRecord {
  return makeConflict({
    id: `conf_${path.replace(/[^A-Za-z0-9]/g, '_')}`,
    file: { root: MAIN_ROOT, path },
    source: AGENT,
    humans: [
      { userId: 'dev:amy', displayName: 'Amy' },
      { userId: 'dev:bob', displayName: 'Bob' },
    ],
    hunks: [
      {
        humanText: 'function greet() {\n  return "你好，艾咪 👋";\n}\n',
        agentText: 'function greet() {\n  return "Hello";\n  // agent 加的註解 ✅\n}\n',
        baseText: 'function greet() {\n  return "hi";\n}\n',
        startLine: 12,
      },
    ],
    agentVersionBytes: 2048,
    ...overrides,
  });
}

function renderConflicts(options: { role?: Role; conflicts?: ConflictRecord[] } = {}) {
  const view = renderInWorkspace(<ConflictsPanel />, { role: options.role ?? 'editor' });
  const opened: CommandMap['openFile'][] = [];
  view.session.commands.handle('openFile', (payload) => {
    opened.push(payload);
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await act(flush);
  };
  view.conn.respond('doc.conflict.list', { conflicts: options.conflicts ?? [] });
  const card = (path: string) => screen.getByRole('article', { name: path });
  return { ...view, opened, settle, card };
}

describe('ConflictsPanel: the human text and the agent version side by side', () => {
  it('when an agent changes a file through Bash while someone is editing it, what the person typed is not lost; the overlapping part appears in the conflict panel — the web panel names the file, who was involved, and shows both texts side by side', async () => {
    const view = renderConflicts({ conflicts: [conflictOn('src/app.ts', { hunksOmitted: 2 })] });
    await view.settle();
    const card = view.card('src/app.ts');
    expect(within(card).getByText('Open')).toBeTruthy();
    expect(card.textContent).toContain(` by ${AGENT.displayName}, overlapping edits in progress by Amy, Bob.`);
    expect(card.textContent).toContain(`The file keeps the text being edited. The version written by ${AGENT.displayName} is on the right.`);
    const table = within(card).getByRole('table', { name: 'From line 12' });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Line number', 'Text being edited (kept for now)', `Version by ${AGENT.displayName}`]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => [...row.querySelectorAll('td')].map((td) => td.textContent))).toEqual([
      ['12', 'function greet() {', 'function greet() {'],
      ['13', '  return "你好，艾咪 👋";', '  return "Hello";'],
      ['', '', '  // agent 加的註解 ✅'],
      ['14', '}', '}'],
    ]);
    // Changed lines are marked on both sides; unchanged ones are not.
    expect(rows[1]?.querySelector('.conflict-diff__cell--human')?.hasAttribute('data-changed')).toBe(true);
    expect(rows[1]?.querySelector('.conflict-diff__cell--agent')?.hasAttribute('data-changed')).toBe(true);
    expect(rows[0]?.querySelector('[data-changed]')).toBeNull();
    expect(within(card).getByText('2 more overlaps are not listed. "View full version" shows everything the other side wrote.')).toBeTruthy();
    // What it was before, on demand.
    expect(within(card).getByText('Text before the change')).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'Open file' }));
    await view.settle();
    expect(view.opened).toEqual([{ file: { root: MAIN_ROOT, path: 'src/app.ts' } }]);
  });

  it('conflict actions call the right requests: "Keep the text being edited" dismisses, "Apply" applies the agent version only after confirming', async () => {
    const view = renderConflicts({ conflicts: [conflictOn('a.ts'), conflictOn('b.ts', { createdAt: T0 - 1_000 })] });
    await view.settle();

    fireEvent.click(within(view.card('a.ts')).getByRole('button', { name: 'Keep the text being edited' }));
    await view.settle();
    expect(view.conn.requestsOf('doc.conflict.resolve').map((r) => r.payload)).toEqual([{ conflictId: 'conf_a_ts', action: 'dismiss' }]);
    view.conn.respond('doc.conflict.resolve', { conflict: conflictOn('a.ts', { status: 'dismissed' }) });
    await view.settle();
    // Resolved: moved to the collapsed list of resolved conflicts, without actions.
    expect(screen.getByText('Resolved conflicts (1)')).toBeTruthy();
    expect(within(view.card('a.ts')).getByText('Kept the text being edited')).toBeTruthy();
    expect(within(view.card('a.ts')).queryByRole('button', { name: 'Keep the text being edited' })).toBeNull();

    // Apply: a confirmation first; cancelling sends nothing.
    fireEvent.click(within(view.card('b.ts')).getByRole('button', { name: 'Apply this version…' }));
    let confirm = screen.getByRole('alertdialog', { name: `Apply the version written by ${AGENT.displayName}?` });
    expect(confirm.textContent).toContain('2 KB');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(view.conn.requestsOf('doc.conflict.resolve')).toHaveLength(1);

    // An agent holds the file right now: refused, and the toast names it.
    fireEvent.click(within(view.card('b.ts')).getByRole('button', { name: 'Apply this version…' }));
    confirm = screen.getByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Apply' }));
    await view.settle();
    expect(view.conn.lastRequest('doc.conflict.resolve')?.payload).toEqual({ conflictId: 'conf_b_ts', action: 'apply-agent-version' });
    view.conn.fail('doc.conflict.resolve', lockedError(makeAgentLock('b.ts'), 'locked'));
    expect(await screen.findByText(`${agentDisplayName('Ian')} is changing this file. Try again in a moment.`)).toBeTruthy();

    fireEvent.click(within(view.card('b.ts')).getByRole('button', { name: 'Apply this version…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply' }));
    await view.settle();
    view.conn.respond('doc.conflict.resolve', { conflict: conflictOn('b.ts', { status: 'applied' }) });
    await view.settle();
    expect(within(view.card('b.ts')).getByText('Applied the other version')).toBeTruthy();
    expect(screen.getByText('No open conflicts')).toBeTruthy();
    expect(view.conn.requestsOf('doc.conflict.resolve').map((r) => r.payload.action)).toEqual(['dismiss', 'apply-agent-version', 'apply-agent-version']);
  });

  it('a change by an outside program reads as a sentence, and one line number is not a range', async () => {
    const view = renderConflicts({ conflicts: [conflictOn('notes.md', { source: { kind: 'system' }, humans: [], hunksOmitted: 1 })] });
    await view.settle();
    const card = view.card('notes.md');
    expect(card.textContent).toContain(' by an outside program, overlapping edits in progress.');
    expect(within(card).getByRole('columnheader', { name: 'Version by an outside program' })).toBeTruthy();
    expect(within(card).getByText('1 more overlap is not listed. "View full version" shows everything the other side wrote.')).toBeTruthy();
  });

  it('only roles that can write get the actions: a viewer reads the conflict and the full version, nothing more', async () => {
    const view = renderConflicts({ role: 'viewer', conflicts: [conflictOn('src/app.ts')] });
    await view.settle();
    const card = view.card('src/app.ts');
    expect(within(card).queryByRole('button', { name: 'Keep the text being edited' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Apply this version…' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'View full version' })).toBeTruthy();
  });

  it('a guest cannot resolve a conflict on a host-only file (the host can)', async () => {
    const guest = renderConflicts({ conflicts: [conflictOn('.claude/settings.json')] });
    await guest.settle();
    expect(within(guest.card('.claude/settings.json')).queryByRole('button', { name: 'Keep the text being edited' })).toBeNull();
    expect(within(guest.card('.claude/settings.json')).getByText('Only the host can change this file, so only the host can resolve this conflict.')).toBeTruthy();
    guest.unmount();
    const host = renderConflicts({ role: 'host', conflicts: [conflictOn('.claude/settings.json')] });
    await host.settle();
    expect(within(host.card('.claude/settings.json')).getByRole('button', { name: 'Keep the text being edited' })).toBeTruthy();
  });

  it('live: a new doc.conflict appears at once, a status update (upsert by id) moves it to the resolved list', async () => {
    const view = renderConflicts();
    await view.settle();
    expect(screen.getByText('No open conflicts')).toBeTruthy();
    act(() => view.conn.emit('doc.conflict', { conflict: conflictOn('src/live.ts') }));
    expect(view.card('src/live.ts')).toBeTruthy();
    expect(screen.queryByText('No open conflicts')).toBeNull();
    act(() => view.conn.emit('doc.conflict', { conflict: conflictOn('src/live.ts', { status: 'dismissed' }) }));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText('Resolved conflicts (1)')).toBeTruthy();
  });

  it('the full version comes from doc.conflict.get; names and texts are shown as text, never as markup', async () => {
    const injected = conflictOn('src/x.ts', {
      source: { ...AGENT, displayName: 'Claude (<img src=x onerror=alert(1)>)' },
      humans: [{ userId: 'dev:eve', displayName: '</td><script>window.__pwned=1</script>' }],
      hunks: [{ humanText: '<b>人</b>\n', agentText: '<i>agent</i>\n', baseText: '', startLine: 1 }],
    });
    const view = renderConflicts({ conflicts: [injected] });
    await view.settle();
    const card = view.card('src/x.ts');
    expect(card.textContent).toContain('</td><script>window.__pwned=1</script>');
    expect(within(card).getByText('<b>人</b>')).toBeTruthy();
    expect(document.querySelector('script, img, b, i')).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'View full version' }));
    await view.settle();
    expect(view.conn.lastRequest('doc.conflict.get')?.payload).toEqual({ conflictId: injected.id });
    view.conn.respond('doc.conflict.get', { conflict: injected, agentVersion: new TextEncoder().encode('<script>window.__pwned=2</script>\n完整的 agent 版本 🙂\n') });
    await view.settle();
    const dialog = screen.getByRole('dialog', { name: 'Full version written by Claude (<img src=x onerror=alert(1)>)' });
    expect(dialog.querySelector('pre')?.textContent).toBe('<script>window.__pwned=2</script>\n完整的 agent 版本 🙂\n');
    expect(document.querySelector('script, img')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
