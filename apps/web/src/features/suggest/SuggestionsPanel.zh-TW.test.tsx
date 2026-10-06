// The suggestions panel in Traditional Chinese: the composer, the queue, the author's list with the reason smurg
// closed a suggestion, and the selection header, which is the same in every language.
import { MAIN_ROOT, type Role, type Suggestion } from '@smurg/protocol';
import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HOST_USER, makeSession, makeSuggestion } from '../../testing/fixtures.ts';
import { useTestLocale } from '../../testing/locale.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { SuggestionsPanel } from './index.tsx';

useTestLocale('zh-TW');

const hostSession = makeSession({ id: 'sess_host', openedBy: { userId: HOST_USER, displayName: 'Ian' }, title: 'Claude' });

async function renderPanel(role: Role, suggestions: Suggestion[] = []) {
  const result = renderInWorkspace(<SuggestionsPanel />, { role });
  await act(async () => {
    result.conn.respond('session.list', { sessions: [hostSession], hasMore: false });
    result.conn.respond('suggest.list', { suggestions, hasMore: false });
  });
  await act(async () => {
    result.stores.sessions.focus('sess_host');
  });
  return result;
}

describe('suggestions panel in zh-TW', () => {
  it('an editor sees the composer and their own suggestions in Traditional Chinese; the selection header stays path:lines', async () => {
    const closed = makeSuggestion({ id: 'sug_c', sessionId: 'sess_host', text: 'too late', status: 'rejected', closedReason: 'session-ended', resolvedAt: 5 });
    const { session } = await renderPanel('editor', [closed]);
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    const panel = screen.getByRole('region', { name: '建議' });
    expect(within(panel).getByText('建議會先進入等待清單；主人或「可使用 agent」的成員採用後，才會送進 session。')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: '送出建議' })).toBeTruthy();
    const mine = within(panel).getByRole('region', { name: '我提出的建議' });
    expect(mine.textContent).toContain('已拒絕');
    expect(mine.textContent).toContain('原因：這個 session 已結束');
    await act(async () => {
      await session.commands.dispatch('sendSelectionAsSuggestion', { file: { root: MAIN_ROOT, path: 'src/app.ts' }, startLine: 10, endLine: 12, text: 'const a = 1;', sessionId: 'sess_host' });
    });
    const box = screen.getByLabelText('給 Ian 開的「Claude」的建議') as HTMLTextAreaElement;
    expect(box.value.startsWith('src/app.ts:10-12\n')).toBe(true);
    expect(screen.getByText('附上的程式碼：src/app.ts 第 10–12 行')).toBeTruthy();
  });

  it('the host sees the queue in Traditional Chinese', async () => {
    await renderPanel('host', [makeSuggestion({ id: 'sug_a', sessionId: 'sess_host' })]);
    const queue = screen.getByRole('region', { name: '等待你決定的建議（1）' });
    expect(within(queue).getByRole('article', { name: 'Amy 提出' })).toBeTruthy();
    for (const name of ['採用', '修改後採用', '拒絕']) expect(within(queue).getByRole('button', { name })).toBeTruthy();
  });
});
