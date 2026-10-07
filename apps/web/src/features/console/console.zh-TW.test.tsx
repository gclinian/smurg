// The host console in Traditional Chinese: a handful of strings of each section, the role labels from the wire
// catalogue, the risk confirmation of agent access, a host refusal rendered from its message reference, and the parts
// v0.5.0 added (the new session model, the Claude Code project settings, the host's own rules, the dialogs that say
// what goes with a member, the removal of a conversation entry, the names of the whole audit vocabulary).
import { AUDIT_ACTIONS, SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTestLocale } from '../../testing/locale.ts';
import { auditActionLabel } from './audit-labels.ts';
import ConsoleOverlays from './ConsoleOverlays.tsx';
import { consoleDialogs } from './dialogs.ts';
import { defaultFixture, makeConfigFile, renderConsole, renderWithConsoleData, topicFixture } from './test-support.tsx';

useTestLocale('zh-TW');

/** Han characters: what every zh-TW label of the console holds. */
const HAN = /[一-鿿]/;

describe('host console in zh-TW', () => {
  it('the page, its sections and the role labels are Traditional Chinese', async () => {
    renderConsole();
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(await screen.findByRole('heading', { level: 1, name: '主人控制台' })).toBeTruthy();
    expect(screen.getByText('主人必讀的安全提醒')).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 2, name: '成員（3）' })).toBeTruthy();
    for (const name of ['所有 session（2）', '待處理的建議（0）', '合併請求', '邀請連結', 'Claude Code 專案設定', '我自己的 Claude Code 規則', '設定', '操作紀錄']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    const role = (await screen.findByLabelText('Amy 的角色')) as HTMLSelectElement;
    expect([...role.options].map((option) => option.textContent)).toEqual(['可使用 agent', '可編輯', '旁觀']);
    expect(screen.getByText('amy-laptop（終端機）')).toBeTruthy();
    // The audit headers are built per render, so they follow the language too.
    expect(screen.getByRole('columnheader', { name: '結果' })).toBeTruthy();
    expect(await screen.findByText('權限不足被拒絕')).toBeTruthy();
    // Whose Claude account a group may use (OWNER-DECISIONS Q6), among the security notes.
    expect(screen.getByText(/^這裡的 agent 使用你的 Claude Code 登入。個人的 Pro 或 Max 訂閱只供你自己使用/)).toBeTruthy();
    // No English label of the page is left: every nav button holds Chinese.
    for (const button of within(screen.getByRole('navigation', { name: '控制台區塊' })).getAllByRole('button')) expect(button.textContent).toMatch(HAN);
  });

  it('agent access is confirmed with the risk in plain words, for a member and for an invite', async () => {
    const view = renderConsole();
    fireEvent.change(await screen.findByLabelText('Bob 的角色'), { target: { value: 'agent' } });
    const dialog = screen.getByRole('alertdialog', { name: '把 Bob 的角色改成「可使用 agent」？' });
    expect(within(dialog).getByTestId('role-risk-text').textContent).toBe(
      '可使用 agent 的人可以請 agent 在你的電腦上執行任何指令、讀取你家目錄裡的檔案，並使用你的 Claude 帳號。只開給你完全信任的人。',
    );
    expect(view.conn.requestsOf('admin.member.setRole')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: '我了解，變更角色' }));
    expect(view.conn.lastRequest('admin.member.setRole')?.payload).toEqual({ userId: 'dev:bob', role: 'agent' });
    // The host's refusal is a message reference: shown in the viewer's language, not as the English that came with it.
    await act(async () => {
      view.conn.fail('admin.member.setRole', new SmurgError('not_found', msg('member.notFound'), { reason: 'unknown-member' }));
    });
    expect(screen.getByText(/^無法變更 Bob 的角色：.*成員/)).toBeTruthy();
    expect(screen.queryByText(/That member was not found/)).toBeNull();

    const invites = (await screen.findByRole('heading', { level: 2, name: '邀請連結' })).closest('section') as HTMLElement;
    expect(within(invites).getByText('新成員可以讀到這個工作區先前的所有對話，包括已封存主題的對話。')).toBeTruthy();
    fireEvent.change(within(invites).getByLabelText('角色'), { target: { value: 'agent' } });
    fireEvent.click(within(invites).getByRole('button', { name: '建立邀請連結' }));
    expect(screen.getByRole('alertdialog', { name: '建立「可使用 agent」的邀請連結？' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '我了解，建立邀請連結' })).toBeTruthy();
  });

  it('the sessions of a topic: topic, kind, status and responsible person, and what a kick takes along', async () => {
    renderConsole({ fixture: topicFixture() });
    const table = (await screen.findByText('2 · Payment form')).closest('table') as HTMLElement;
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['名稱', '主題', '類型', '狀態', '負責人', '開啟的人', '位置', '操作']);
    const item = within(table).getByText('2 · Payment form').closest('tr') as HTMLElement;
    expect([...item.querySelectorAll('td')].slice(1, 5).map((cell) => cell.textContent)).toEqual(['Checkout', '工作項目（第 2 次）', '沒寫報告就停下了', 'Amy']);
    const free = within(table).getByText('try the parser').closest('tr') as HTMLElement;
    expect([...free.querySelectorAll('td')].slice(1, 5).map((cell) => cell.textContent)).toEqual(['未分主題', 'agent session', '執行中', '無']);
    // The discussion is named by the wire catalogue.
    expect(within(table).getByRole('button', { name: '終止 Ian 開的「討論」' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '踢出 Amy' }));
    const kick = screen.getByRole('alertdialog', { name: '踢出 Amy？' });
    expect(within(kick).getByText('Amy 開的所有終端機和未分主題的 session 立即終止（目前 2 個）。')).toBeTruthy();
    expect(within(kick).getByText(/^Amy 開始的主題 session（討論和工作項目）會停止並改由你接手/)).toBeTruthy();
    expect(within(kick).getByText(/^Amy 設定的東西會移除：他設為一律允許的指令類型/)).toBeTruthy();
    fireEvent.click(within(kick).getByRole('button', { name: '取消' }));

    fireEvent.change(screen.getByLabelText('Amy 的角色'), { target: { value: 'viewer' } });
    const demote = screen.getByRole('alertdialog', { name: '把 Amy 的角色改成「旁觀」？' });
    expect(within(demote).getByText('Amy 開始的主題 session（討論和工作項目）改由你接手，並繼續執行（目前 1 個）。')).toBeTruthy();
    expect(within(demote).getByText(/^「旁觀」只能觀看：Amy 在未回答選擇題上的投票會移除/)).toBeTruthy();
  });

  it('the Claude Code project settings and the host\'s own rules', async () => {
    const fixture = defaultFixture();
    fixture.claudeConfig = [
      {
        root: { kind: 'main' },
        state: 'ignored',
        files: [
          makeConfigFile({ env: [{ name: 'ANTHROPIC_BASE_URL', flagged: true }, { name: 'NODE_OPTIONS', flagged: false, programs: true }], needsAck: ['credentials', 'incomplete'], cut: { omitted: 3, shortened: 1 } }),
          makeConfigFile({ path: '.claude', runs: [], otherKeys: ['.claude/agents/reviewer.md'], scripts: [], cut: { omitted: 2, shortened: 0 } }),
        ],
      },
    ];
    fixture.hostRules = { rules: [{ rule: 'Bash(npm run *)', source: 'user' }], seen: false };
    const view = renderConsole({ fixture, section: 'host-rules' });
    const claude = (await screen.findByRole('heading', { level: 2, name: 'Claude Code 專案設定' })).closest('section') as HTMLElement;
    expect(await within(claude).findByText('你還沒有決定這份內容。這個資料夾裡的 agent session 目前不會載入這些設定。')).toBeTruthy();
    expect(within(claude).getByRole('heading', { level: 3, name: /^主工作區/ }).textContent).toContain('等你決定');
    expect(within(claude).getByText('會執行的指令')).toBeTruthy();
    expect(within(claude).getByText('可能把你的登入資訊送到其他伺服器')).toBeTruthy();
    expect(within(claude).getByText('會改變執行的程式')).toBeTruthy();
    // What a list leaves out, as one line without a gap between the sentences.
    expect(within(claude).getByText('還有 3 項沒有列在下面。下面有 1 項沒有顯示完整。決定之前，請先讀檔案本身（在最下面）。')).toBeTruthy();
    // The rest of what Claude Code loads from the folder.
    const loaded = within(claude).getByText('.claude/ 裡的其他內容').closest('li') as HTMLElement;
    expect(within(loaded).getByText('Claude Code 也會載入這個資料夾的 agent、skill、指令和規則。它們自己就能執行指令、允許工具。這些檔案只要有變動，就會再問你一次。')).toBeTruthy();
    expect(within(loaded).getByText('還有 2 項沒有列在下面。決定之前，請先在你的電腦上讀這些檔案本身。')).toBeTruthy();
    expect(within(within(loaded).getByText('會載入的檔案').parentElement as HTMLElement).getByText('.claude/agents/reviewer.md')).toBeTruthy();
    expect(within(loaded).getByText('顯示每個檔案和它的 SHA-256')).toBeTruthy();
    const use = within(claude).getByRole('button', { name: '使用' }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.click(within(claude).getByLabelText('這些設定可能把我的 Claude 登入資訊送到其他伺服器（有標記的變數，或提供 API 金鑰的指令）。'));
    expect(use.disabled).toBe(true);
    fireEvent.click(within(claude).getByLabelText('上面的清單沒有列出全部內容。我已經讀過檔案本身。'));
    expect(use.disabled).toBe(false);
    expect(within(claude).getByRole('button', { name: '不載入' })).toBeTruthy();

    const rules = (await screen.findByRole('heading', { level: 2, name: '我自己的 Claude Code 規則' })).closest('section') as HTMLElement;
    // The daemon's own sentence, in the viewer's language.
    expect(await within(rules).findByText('你自己的 Claude Code 設定允許 1 類指令不經詢問就執行，這裡的 agent 也會直接執行')).toBeTruthy();
    expect(within(rules).getByRole('region', { name: '你的使用者設定（~/.claude/settings.json）' })).toBeTruthy();
    await waitFor(() => expect(view.conn.requestsOf('admin.hostRules.seen')).toHaveLength(1));
  });

  it('the settings of agents, the account notice, and the confirmation before a conversation entry is removed', async () => {
    const page = renderConsole();
    const sessions = (await screen.findByRole('heading', { level: 2, name: '所有 session（2）' })).closest('section') as HTMLElement;
    expect(await within(sessions).findByText('你的 Claude 帳號：沒有回報任何問題。')).toBeTruthy();
    // The daemon's one notice about a personal subscription (OWNER-DECISIONS Q6), in its own words, in Chinese.
    act(() => page.conn.emit('activity.notify', { notification: { id: 'n_sub', at: Date.now(), from: { kind: 'system' }, msg: msg('notice.personalSubscription'), fallback: 'Agents here use your personal Claude subscription.' } }));
    expect(within(sessions).getByText(/^這裡的 agent 使用你個人的 Claude 訂閱。/)).toBeTruthy();
    expect(within(sessions).getByRole('button', { name: '知道了' })).toBeTruthy();
    act(() => page.conn.emit('session.host', { account: { state: 'usage-limit', sessions: 2 }, mainProjectSettings: 'none' }));
    expect(within(sessions).getByText('你的 Claude 帳號已達用量上限。')).toBeTruthy();
    expect(within(sessions).getByText('有 2 個 agent session 在等。')).toBeTruthy();
    const settings = (await screen.findByRole('heading', { level: 2, name: '設定' })).closest('section') as HTMLElement;
    expect(await within(settings).findByLabelText('同時執行的工作項目數量')).toBeTruthy();
    expect(within(settings).getByLabelText('等多久之後也詢問其他人（分鐘）')).toBeTruthy();
    expect(within(settings).getByRole('checkbox', { name: 'agent 可以使用我自己的和這個專案的 MCP 伺服器' })).toBeTruthy();

    const view = renderWithConsoleData(<ConsoleOverlays />, { fixture: topicFixture() });
    await waitFor(() => expect(view.stores.sessions.getState().sessions.has('sess_disc')).toBe(true));
    act(() => consoleDialogs(view.stores).open({ kind: 'redact', sessionId: 'sess_disc', seq: 9 }));
    const dialog = screen.getByRole('alertdialog', { name: '移除這則內容？' });
    // What will stand in its place is the daemon's sentence, in Chinese.
    expect(within(dialog).getByText('所有人會在原處看到「主人已移除這則內容」。儲存在你電腦上的對話紀錄也會一併修改。')).toBeTruthy();
    // What else keeps a copy, and what removes it.
    expect(within(dialog).getByText('只會移除這一則。選擇題、權限請求、建議、收件夾項目和報告的追問各自留著的那一份，要刪除主題才會一併移除。操作紀錄會保留傳給 agent 的完整文字。')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '移除內容' })).toBeTruthy();
  });

  it('the project settings: a script that is named but not there yet, and commands whose files smurg cannot follow', async () => {
    const fixture = defaultFixture();
    fixture.claudeConfig = [
      {
        root: { kind: 'main' },
        state: 'ignored',
        files: [
          makeConfigFile({
            runs: ['hook Stop: sh "$SCRIPT"', '^ smurg cannot follow which files the command above runs'],
            scripts: [
              { path: 'scripts/lint.sh', hash: 'b'.repeat(64) },
              { path: 'scripts/new.sh', hash: '0'.repeat(64), absent: true },
            ],
            needsAck: ['incomplete'],
            unfollowed: 1,
          }),
        ],
      },
    ];
    renderConsole({ fixture, section: 'claude-config' });
    const claude = (await screen.findByRole('heading', { level: 2, name: 'Claude Code 專案設定' })).closest('section') as HTMLElement;
    expect(await within(claude).findByText('smurg 無法得知這些指令裡有 1 個會執行哪些檔案：只有列出的腳本受到保護。決定之前，請先讀檔案本身（在最下面）。')).toBeTruthy();
    const marked = within(claude).getByText('有提到，但檔案還不存在').closest('li') as HTMLElement;
    expect(marked.textContent).toBe('scripts/new.sh有提到，但檔案還不存在');
    expect(within(claude).getByText('指令提到但還沒有檔案的路徑，和其他腳本一樣受到保護；之後有檔案出現在那裡，會再問你一次。')).toBeTruthy();
  });

  it('every action of the audit vocabulary has a Chinese name of its own', () => {
    const labels = AUDIT_ACTIONS.map((action) => auditActionLabel(action));
    for (const [index, action] of AUDIT_ACTIONS.entries()) {
      expect(labels[index], action).not.toBe(action);
      expect(labels[index], action).toMatch(HAN);
    }
    expect(new Set(labels).size).toBe(AUDIT_ACTIONS.length);
    expect(auditActionLabel('session.handover')).toBe('session 改由主人接手');
    expect(auditActionLabel('transcript.redact')).toBe('移除對話內容');
  });
});
