import { MAIN_ROOT, lockedError, type ConflictRecord, type Role } from '@smurg/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CommandMap } from '../../lib/commands.ts';
import { HOST_USER, T0, makeAgentLock, makeConflict } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { ConflictsPanel } from './index.tsx';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const AGENT = { kind: 'agent' as const, sessionId: 'sess_1', ownerUserId: HOST_USER, displayName: 'Claude（Ian）' };

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
  it('agent 透過 Bash 修改有人正在編輯的檔案時，人打的內容不會遺失；重疊部分出現在衝突面板 — the web panel names the file, who was involved, and shows both texts side by side', async () => {
    const view = renderConflicts({ conflicts: [conflictOn('src/app.ts', { hunksOmitted: 2 })] });
    await view.settle();
    const card = view.card('src/app.ts');
    expect(within(card).getByText('待處理')).toBeTruthy();
    expect(card.textContent).toContain('Claude（Ian）在');
    expect(card.textContent).toContain('和Amy、Bob正在編輯的內容重疊');
    expect(card.textContent).toContain('檔案裡保留的是編輯中的內容');
    const table = within(card).getByRole('table', { name: '第 12 行起' });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['行號', '編輯中的內容（目前保留）', 'Claude（Ian）的版本']);
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
    expect(within(card).getByText('另有 2 處重疊沒有列出；「查看完整版本」可以看到另一方寫入的全部內容。')).toBeTruthy();
    // What it was before, on demand.
    expect(within(card).getByText('修改前的內容')).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: '開啟檔案' }));
    await view.settle();
    expect(view.opened).toEqual([{ file: { root: MAIN_ROOT, path: 'src/app.ts' } }]);
  });

  it('conflict actions call the right requests: 「保留編輯中的內容」 dismisses, 「套用」 applies the agent version only after confirming', async () => {
    const view = renderConflicts({ conflicts: [conflictOn('a.ts'), conflictOn('b.ts', { createdAt: T0 - 1_000 })] });
    await view.settle();

    fireEvent.click(within(view.card('a.ts')).getByRole('button', { name: '保留編輯中的內容' }));
    await view.settle();
    expect(view.conn.requestsOf('doc.conflict.resolve').map((r) => r.payload)).toEqual([{ conflictId: 'conf_a_ts', action: 'dismiss' }]);
    view.conn.respond('doc.conflict.resolve', { conflict: conflictOn('a.ts', { status: 'dismissed' }) });
    await view.settle();
    // Resolved: moved to the collapsed 「已處理」 list, without actions.
    expect(screen.getByText('已處理的衝突（1）')).toBeTruthy();
    expect(within(view.card('a.ts')).getByText('已保留編輯中的內容')).toBeTruthy();
    expect(within(view.card('a.ts')).queryByRole('button', { name: '保留編輯中的內容' })).toBeNull();

    // Apply: a confirmation first; cancelling sends nothing.
    fireEvent.click(within(view.card('b.ts')).getByRole('button', { name: '套用這個版本…' }));
    let confirm = screen.getByRole('alertdialog', { name: '要套用Claude（Ian）的版本嗎？' });
    expect(confirm.textContent).toContain('2 KB');
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }));
    expect(view.conn.requestsOf('doc.conflict.resolve')).toHaveLength(1);

    // An agent holds the file right now: refused, and the toast names it.
    fireEvent.click(within(view.card('b.ts')).getByRole('button', { name: '套用這個版本…' }));
    confirm = screen.getByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: '套用' }));
    await view.settle();
    expect(view.conn.lastRequest('doc.conflict.resolve')?.payload).toEqual({ conflictId: 'conf_b_ts', action: 'apply-agent-version' });
    view.conn.fail('doc.conflict.resolve', lockedError(makeAgentLock('b.ts'), 'locked'));
    expect(await screen.findByText('Claude（Ian）正在修改這個檔案，請稍後再試。')).toBeTruthy();

    fireEvent.click(within(view.card('b.ts')).getByRole('button', { name: '套用這個版本…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '套用' }));
    await view.settle();
    view.conn.respond('doc.conflict.resolve', { conflict: conflictOn('b.ts', { status: 'applied' }) });
    await view.settle();
    expect(within(view.card('b.ts')).getByText('已套用另一方的版本')).toBeTruthy();
    expect(screen.getByText('沒有待處理的衝突')).toBeTruthy();
    expect(view.conn.requestsOf('doc.conflict.resolve').map((r) => r.payload.action)).toEqual(['dismiss', 'apply-agent-version', 'apply-agent-version']);
  });

  it('only roles that can write get the actions: a viewer reads the conflict and the full version, nothing more', async () => {
    const view = renderConflicts({ role: 'viewer', conflicts: [conflictOn('src/app.ts')] });
    await view.settle();
    const card = view.card('src/app.ts');
    expect(within(card).queryByRole('button', { name: '保留編輯中的內容' })).toBeNull();
    expect(within(card).queryByRole('button', { name: '套用這個版本…' })).toBeNull();
    expect(within(card).getByRole('button', { name: '查看完整版本' })).toBeTruthy();
  });

  it('a guest cannot resolve a conflict on a host-only file (the host can)', async () => {
    const guest = renderConflicts({ conflicts: [conflictOn('.claude/settings.json')] });
    await guest.settle();
    expect(within(guest.card('.claude/settings.json')).queryByRole('button', { name: '保留編輯中的內容' })).toBeNull();
    expect(within(guest.card('.claude/settings.json')).getByText('這個檔案只有主人可以修改，衝突也只有主人可以處理。')).toBeTruthy();
    guest.unmount();
    const host = renderConflicts({ role: 'host', conflicts: [conflictOn('.claude/settings.json')] });
    await host.settle();
    expect(within(host.card('.claude/settings.json')).getByRole('button', { name: '保留編輯中的內容' })).toBeTruthy();
  });

  it('live: a new doc.conflict appears at once, a status update (upsert by id) moves it to the resolved list', async () => {
    const view = renderConflicts();
    await view.settle();
    expect(screen.getByText('沒有待處理的衝突')).toBeTruthy();
    act(() => view.conn.emit('doc.conflict', { conflict: conflictOn('src/live.ts') }));
    expect(view.card('src/live.ts')).toBeTruthy();
    expect(screen.queryByText('沒有待處理的衝突')).toBeNull();
    act(() => view.conn.emit('doc.conflict', { conflict: conflictOn('src/live.ts', { status: 'dismissed' }) }));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText('已處理的衝突（1）')).toBeTruthy();
  });

  it('the full version comes from doc.conflict.get; names and texts are shown as text, never as markup', async () => {
    const injected = conflictOn('src/x.ts', {
      source: { ...AGENT, displayName: 'Claude（<img src=x onerror=alert(1)>）' },
      humans: [{ userId: 'dev:eve', displayName: '</td><script>window.__pwned=1</script>' }],
      hunks: [{ humanText: '<b>人</b>\n', agentText: '<i>agent</i>\n', baseText: '', startLine: 1 }],
    });
    const view = renderConflicts({ conflicts: [injected] });
    await view.settle();
    const card = view.card('src/x.ts');
    expect(card.textContent).toContain('</td><script>window.__pwned=1</script>');
    expect(within(card).getByText('<b>人</b>')).toBeTruthy();
    expect(document.querySelector('script, img, b, i')).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: '查看完整版本' }));
    await view.settle();
    expect(view.conn.lastRequest('doc.conflict.get')?.payload).toEqual({ conflictId: injected.id });
    view.conn.respond('doc.conflict.get', { conflict: injected, agentVersion: new TextEncoder().encode('<script>window.__pwned=2</script>\n完整的 agent 版本 🙂\n') });
    await view.settle();
    const dialog = screen.getByRole('dialog', { name: 'Claude（<img src=x onerror=alert(1)>）寫入的完整版本' });
    expect(dialog.querySelector('pre')?.textContent).toBe('<script>window.__pwned=2</script>\n完整的 agent 版本 🙂\n');
    expect(document.querySelector('script, img')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
