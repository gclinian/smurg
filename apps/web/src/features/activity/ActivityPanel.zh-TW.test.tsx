// The activity feed and the conflict panel in Traditional Chinese: their own strings, and the host's sentences
// (activity entries, a notice smurg wrote) rendered from their message references in the viewer's language.
import { MAIN_ROOT } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HOST_USER, makeActivity, makeConflict } from '../../testing/fixtures.ts';
import { useTestLocale } from '../../testing/locale.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { ActivityPanel, ConflictsPanel } from './index.tsx';

useTestLocale('zh-TW');

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await act(flush);
};
const BOB = { kind: 'user' as const, userId: 'dev:bob', displayName: 'Bob' };

describe('activity feed in zh-TW', () => {
  it("labels are Traditional Chinese and the host's sentences are rendered in it, with the English summary as the fallback only", async () => {
    const view = renderInWorkspace(<ActivityPanel />, { role: 'editor' });
    view.conn.respond('activity.list', {
      events: [
        makeActivity({ id: 'a_1', at: Date.now(), actor: BOB, kind: 'human.edit', file: { root: MAIN_ROOT, path: 'README.md' }, text: msg('activity.humanEdit', { name: 'Bob', path: 'README.md' }), summary: 'Bob edited README.md' }),
        makeActivity({ id: 'a_2', at: Date.now() - 1_000, actor: { kind: 'system' }, kind: 'external.change', text: { id: 'activity.fromANewerHost' }, summary: 'A sentence only a newer host knows' }),
      ],
    });
    await settle();
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    const [first, second] = screen.getAllByRole('listitem');
    expect(within(first!).getByText('編輯')).toBeTruthy();
    expect(within(first!).getByText('Bob 編輯了 README.md')).toBeTruthy();
    expect(within(first!).queryByText('Bob edited README.md')).toBeNull();
    expect(within(first!).getByRole('button', { name: '開啟 README.md' })).toBeTruthy();
    expect(within(second!).getByText('外部程式')).toBeTruthy();
    expect(within(second!).getByText('A sentence only a newer host knows')).toBeTruthy();
    expect(screen.getByLabelText('篩選活動')).toBeTruthy();

    act(() =>
      view.conn.emit('activity.notify', {
        notification: { id: 'n_1', at: Date.now(), from: { kind: 'system' }, msg: msg('notify.claudeVersionTooOld', { version: '2.0.1', minVersion: '2.1.0' }), fallback: 'Note: Claude Code 2.0.1 is older.' },
      }),
    );
    const region = screen.getByRole('region', { name: '給你的通知' });
    expect(within(region).getByText('smurg 通知你')).toBeTruthy();
    expect(within(region).getByText(/^注意：Claude Code 2\.0\.1 低於 smurg 驗證過的最低版本 2\.1\.0/)).toBeTruthy();
    expect(within(region).getByRole('button', { name: '知道了' })).toBeTruthy();
  });
});

describe('conflict panel in zh-TW', () => {
  it('names who changed the file and who was editing, joined the Chinese way', async () => {
    const view = renderInWorkspace(<ConflictsPanel />, { role: 'editor' });
    view.conn.respond('doc.conflict.list', {
      conflicts: [
        makeConflict({
          id: 'conf_1',
          file: { root: MAIN_ROOT, path: 'src/app.ts' },
          source: { kind: 'agent', sessionId: 'sess_1', ownerUserId: HOST_USER, displayName: 'Claude (Ian)' },
          humans: [
            { userId: 'dev:amy', displayName: 'Amy' },
            { userId: 'dev:bob', displayName: 'Bob' },
          ],
          hunks: [{ humanText: 'a\n', agentText: 'b\n', baseText: '', startLine: 12 }],
        }),
      ],
    });
    await settle();
    const card = screen.getByRole('article', { name: 'src/app.ts' });
    expect(within(card).getByText('待處理')).toBeTruthy();
    expect(card.textContent).toContain('和Amy、Bob正在編輯的內容重疊');
    expect(within(card).getByRole('table', { name: '第 12 行起' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: '保留編輯中的內容' })).toBeTruthy();
  });
});
