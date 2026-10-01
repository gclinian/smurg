import { SmurgError, type InviteInfo } from '@smurg/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_PAGE_SIZE } from '../../lib/stores/admin.ts';
import { T0 } from '../../testing/fixtures.ts';
import { auditDetailRows } from './audit-labels.ts';
import { GIB } from './settings-form.ts';
import { DAY, SETTINGS, containsString, defaultFixture, makeAudit, renderConsole } from './test-support.tsx';

const section = async (name: RegExp | string): Promise<HTMLElement> => (await screen.findByRole('heading', { level: 2, name })).closest('section') as HTMLElement;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('host console: invites', () => {
  const SECRET_URL = 'https://smurg.app/join/ws_web_test_workspace_0001#k=kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk&s=SECRETsecretSECRETsecretSECRETsecretSECRETs';

  it('creates an invite with role, expiry and number of uses; the link is shown once with a copy button and a warning, and is kept nowhere after the dialog closes', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const log = vi.spyOn(console, 'log');
    const view = renderConsole();
    const invites = await section('邀請連結');
    const roles = within(invites).getByLabelText('角色') as HTMLSelectElement;
    expect([...roles.options].map((option) => option.textContent)).toEqual(['可使用 agent', '可編輯', '旁觀']);
    fireEvent.change(roles, { target: { value: 'agent' } });
    expect(within(invites).getByText('可以開 agent 和終端機（在你的電腦上、用你的 Claude 帳號執行），也可以在任何 session 裡直接輸入。')).toBeTruthy();
    fireEvent.change(within(invites).getByLabelText('有效期限'), { target: { value: '1d' } });
    fireEvent.change(within(invites).getByLabelText('可使用次數'), { target: { value: '3' } });
    fireEvent.click(within(invites).getByRole('button', { name: '建立邀請連結' }));
    // 「可使用 agent」: the risk first, nothing created before the host confirms.
    const risk = screen.getByRole('alertdialog', { name: '建立「可使用 agent」的邀請連結？' });
    expect(within(risk).getByTestId('role-risk-text').textContent).toBe(
      '可使用 agent 的人可以請 agent 在你的電腦上執行任何指令、讀取你家目錄裡的檔案，並使用你的 Claude 帳號。只開給你完全信任的人。',
    );
    expect(view.conn.requestsOf('admin.invite.create')).toHaveLength(0);
    fireEvent.click(within(risk).getByRole('button', { name: '我了解，建立邀請連結' }));
    expect(view.conn.lastRequest('admin.invite.create')?.payload).toEqual({ role: 'agent', expiresInSec: 86_400, maxUses: 3 });

    const invite: InviteInfo = { id: 'inv_new', role: 'agent', createdAt: Date.now(), expiresAt: Date.now() + DAY, maxUses: 3, uses: 0, revoked: false };
    view.fixture.invites = [...view.fixture.invites, invite];
    await act(async () => {
      view.conn.respond('admin.invite.create', { invite, url: SECRET_URL });
    });
    const dialog = screen.getByRole('dialog', { name: '邀請連結已建立' });
    expect((within(dialog).getByLabelText('邀請連結') as HTMLInputElement).value).toBe(SECRET_URL);
    expect(within(dialog).getByText('角色「可使用 agent」，1 天後到期，可以使用 3 次。')).toBeTruthy();
    expect(within(dialog).getByText(/只透過私人管道/)).toBeTruthy();
    expect(within(dialog).getByText(/只會顯示這一次/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '複製邀請連結' }));
    });
    expect(writeText).toHaveBeenCalledWith(SECRET_URL);
    // A stray Escape does not throw the link away.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '邀請連結已建立' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '我已經複製好了' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain('SECRETsecret');
    for (const [name, store] of Object.entries(view.stores)) {
      expect(containsString((store as { getState(): unknown }).getState(), 'SECRETsecret'), name).toBe(false);
    }
    expect(log.mock.calls.flat().some((value) => containsString(value, 'SECRETsecret'))).toBe(false);
    // The list shows the new invite (reloaded after creation), with its uses left.
    await waitFor(() => expect(within(invites).getByText('已用 0 次，剩 3 次')).toBeTruthy());
  });

  it('an 「可使用 agent」 invite cancelled at the risk step is never created; editor and viewer invites need no confirmation', async () => {
    const view = renderConsole();
    const invites = await section('邀請連結');
    fireEvent.change(within(invites).getByLabelText('角色'), { target: { value: 'agent' } });
    fireEvent.click(within(invites).getByRole('button', { name: '建立邀請連結' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.requestsOf('admin.invite.create')).toHaveLength(0);
    fireEvent.change(within(invites).getByLabelText('角色'), { target: { value: 'viewer' } });
    fireEvent.click(within(invites).getByRole('button', { name: '建立邀請連結' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.lastRequest('admin.invite.create')?.payload).toMatchObject({ role: 'viewer' });
  });

  it('validates the number of uses and sends none for an unlimited invite', async () => {
    const view = renderConsole();
    const invites = await section('邀請連結');
    const uses = within(invites).getByLabelText('可使用次數');
    const create = within(invites).getByRole('button', { name: '建立邀請連結' }) as HTMLButtonElement;
    for (const bad of ['0', '-1', '1.5', 'abc', '10001']) {
      fireEvent.change(uses, { target: { value: bad } });
      expect(within(invites).getByText('請輸入 1 到 10000 之間的整數，或留空。')).toBeTruthy();
      expect(create.disabled).toBe(true);
    }
    fireEvent.change(uses, { target: { value: '' } });
    fireEvent.click(create);
    expect(view.conn.lastRequest('admin.invite.create')?.payload).toEqual({ role: 'editor', expiresInSec: 7 * 86_400 });
    await act(async () => {
      view.conn.fail('admin.invite.create', new SmurgError('forbidden', '只有主人可以建立邀請'));
    });
    expect(within(invites).getByText('無法建立邀請連結：只有主人可以建立邀請')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists invites with uses left and revokes one', async () => {
    const view = renderConsole();
    const invites = await section('邀請連結');
    const row = (await within(invites).findByText('已用 2 次，剩 3 次')).closest('tr') as HTMLElement;
    expect(within(row).getByText('可編輯')).toBeTruthy();
    expect(within(row).getByText('有效')).toBeTruthy();
    // The revoked one is behind a toggle.
    expect(within(invites).queryByText('已撤銷')).toBeNull();
    fireEvent.click(within(invites).getByRole('button', { name: '顯示已失效的邀請（1）' }));
    expect(within(invites).getByText('已撤銷')).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: /^撤銷 .* 建立的「可編輯」邀請$/ }));
    expect(view.conn.lastRequest('admin.invite.revoke')?.payload).toEqual({ inviteId: 'inv_active' });
    view.fixture.invites = view.fixture.invites.map((invite) => (invite.id === 'inv_active' ? { ...invite, revoked: true } : invite));
    await act(async () => {
      view.conn.respond('admin.invite.revoke', {});
    });
    expect(await screen.findByText('已撤銷邀請連結，它不能再用來加入。')).toBeTruthy();
    await waitFor(() => expect(within(invites).getAllByText('已撤銷')).toHaveLength(2));
    expect(within(invites).queryByRole('button', { name: /^撤銷 / })).toBeNull();
  });
});

describe('host console: audit log', () => {
  it('shows time, actor, action, target and outcome, newest first', async () => {
    renderConsole();
    const audit = await section('操作紀錄');
    const rows = await waitFor(() => {
      const found = within(audit).getAllByRole('row').slice(1);
      expect(found).toHaveLength(3);
      return found;
    });
    expect(within(rows[0]!).getByText('Bob')).toBeTruthy();
    expect(within(rows[0]!).getByText('權限不足被拒絕')).toBeTruthy();
    expect(within(rows[0]!).getByText('file.write')).toBeTruthy();
    expect(within(rows[0]!).getByText('拒絕')).toBeTruthy();
    expect(within(rows[0]!).getByText('forbidden-role')).toBeTruthy();
    expect(within(rows[0]!).getByRole('time').getAttribute('datetime')).toBe(new Date(T0 + 3_000).toISOString());
    expect(within(rows[2]!).getByText('連線')).toBeTruthy();
    expect(within(rows[2]!).getByText('成功')).toBeTruthy();
    expect(within(audit).getByText('沒有更舊的紀錄了。')).toBeTruthy();
  });

  it("a suggestion's entry shows who proposed what and how it was decided (R6.3, review SPEC-07)", () => {
    const rows = auditDetailRows({
      id: 'au_s',
      at: T0,
      actor: { kind: 'user', userId: 'dev:host', displayName: 'Ian' },
      action: 'suggest.accept',
      target: 'sug_1',
      outcome: 'ok',
      detail: { suggestionId: 'sug_1', authorUserId: 'dev:amy', authorName: 'Amy', outcome: 'accepted-modified', text: '請先補上測試\n再合併', finalText: '補測試', createdAt: T0 },
    });
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['提出者', 'Amy'],
      ['處理方式', '修改後採用'],
      ['建議內容', '請先補上測試\n再合併'],
      ['採用的內容', '補測試'],
    ]);
    expect(rows.find((row) => row.key === 'text')?.block).toBe(true);
  });

  it('audit paging: loads older pages with admin.audit.query {before}', async () => {
    const fixture = defaultFixture();
    fixture.audit = Array.from({ length: AUDIT_PAGE_SIZE + 20 }, (_, i) => makeAudit(i + 1));
    const view = renderConsole({ fixture });
    const audit = await section('操作紀錄');
    await waitFor(() => expect(within(audit).getByText(`已載入 ${AUDIT_PAGE_SIZE} 筆`)).toBeTruthy());
    expect(view.conn.requestsOf('admin.audit.query')[0]?.payload).toEqual({ limit: AUDIT_PAGE_SIZE });
    expect(within(audit).queryByText('src/file-20.ts')).toBeNull();

    fireEvent.click(within(audit).getByRole('button', { name: '載入較舊的紀錄' }));
    await waitFor(() => expect(within(audit).getByText(`已載入 ${AUDIT_PAGE_SIZE + 20} 筆`)).toBeTruthy());
    expect(view.conn.lastRequest('admin.audit.query')?.payload).toEqual({ limit: AUDIT_PAGE_SIZE, before: T0 + 21 * 1_000 });
    expect(within(audit).getByText('src/file-20.ts')).toBeTruthy();
    expect(within(audit).getByText('沒有更舊的紀錄了。')).toBeTruthy();
    expect(within(audit).queryByRole('button', { name: '載入較舊的紀錄' })).toBeNull();
  });

  it('shows a failure to load older entries', async () => {
    const fixture = defaultFixture();
    fixture.audit = Array.from({ length: AUDIT_PAGE_SIZE }, (_, i) => makeAudit(i + 1));
    const view = renderConsole({ fixture });
    const audit = await section('操作紀錄');
    await waitFor(() => expect(within(audit).getByRole('button', { name: '載入較舊的紀錄' })).toBeTruthy());
    view.conn.handle('admin.audit.query', () => Promise.reject(new SmurgError('internal', '讀取操作紀錄失敗')));
    fireEvent.click(within(audit).getByRole('button', { name: '載入較舊的紀錄' }));
    expect(await within(audit).findByText('無法載入較舊的紀錄：讀取操作紀錄失敗')).toBeTruthy();
  });

  it('audit live append: a new entry appears at the top', async () => {
    const view = renderConsole();
    const audit = await section('操作紀錄');
    await waitFor(() => expect(within(audit).getAllByRole('row')).toHaveLength(4));
    act(() => view.conn.emit('admin.audit.entry', { entry: makeAudit(9, { action: 'member.kick', target: 'dev:bob', actor: { kind: 'user', userId: 'dev:host', displayName: 'Ian' } }) }));
    const first = within(audit).getAllByRole('row')[1]!;
    expect(within(first).getByText('踢出成員')).toBeTruthy();
    expect(within(first).getByText('dev:bob')).toBeTruthy();
    expect(within(audit).getByText('已載入 4 筆')).toBeTruthy();
  });
});

describe('host console: settings', () => {
  it('shows the current settings and saves only what changed', async () => {
    const view = renderConsole();
    const settings = await section('設定');
    const shared = (await within(settings).findByLabelText('共享資料夾（在 worktree 裡唯讀）')) as HTMLTextAreaElement;
    expect(shared.value).toBe('data');
    expect((within(settings).getByLabelText('編輯鎖閒置釋放時間（秒）') as HTMLInputElement).value).toBe('30');
    expect((within(settings).getByLabelText('保留磁碟空間（GB）') as HTMLInputElement).value).toBe('5');
    const save = within(settings).getByRole('button', { name: '儲存設定' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // No setting of a guest sandbox (protocol v2: there is none).
    expect(within(settings).queryByText(/沙盒|網域/)).toBeNull();
    fireEvent.change(shared, { target: { value: 'data\ncheckpoints/' } });
    fireEvent.change(within(settings).getByLabelText('agent 修改鎖逾時（秒）'), { target: { value: '90' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(view.conn.lastRequest('admin.settings.set')?.payload).toEqual({ sharedDirs: ['data', 'checkpoints'], agentLockTimeoutMs: 90_000 });
    await act(async () => {
      view.conn.respond('admin.settings.set', { settings: { ...SETTINGS, sharedDirs: ['data', 'checkpoints'], agentLockTimeoutMs: 90_000 } });
    });
    expect(screen.getByText('設定已儲存並立即套用。')).toBeTruthy();
    expect(shared.value).toBe('data\ncheckpoints');
    expect(save.disabled).toBe(true);
  });

  it('settings validation: every invalid field says why and nothing is sent', async () => {
    const view = renderConsole();
    const settings = await section('設定');
    await within(settings).findByLabelText('共享資料夾（在 worktree 裡唯讀）');
    fireEvent.change(within(settings).getByLabelText('共享資料夾（在 worktree 裡唯讀）'), { target: { value: '../outside' } });
    fireEvent.change(within(settings).getByLabelText('agent 修改鎖逾時（秒）'), { target: { value: '601' } });
    fireEvent.change(within(settings).getByLabelText('編輯鎖閒置釋放時間（秒）'), { target: { value: '0' } });
    fireEvent.change(within(settings).getByLabelText('保留磁碟空間（%）'), { target: { value: '150' } });
    expect(within(settings).getByText(/「\.\.\/outside」不是有效的資料夾路徑/)).toBeTruthy();
    expect(within(settings).getByText('請輸入 1 到 600 之間的數字。')).toBeTruthy();
    expect(within(settings).getByText('請輸入 1 到 3600 之間的數字。')).toBeTruthy();
    expect(within(settings).getByText('請輸入 0 到 100 之間的數字。')).toBeTruthy();
    expect(within(settings).getByText('有 4 個欄位需要修正。')).toBeTruthy();
    const save = within(settings).getByRole('button', { name: '儲存設定' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest('form')!);
    expect(view.conn.requestsOf('admin.settings.set')).toHaveLength(0);
    fireEvent.click(within(settings).getByRole('button', { name: '還原' }));
    expect(within(settings).queryByText('有 4 個欄位需要修正。')).toBeNull();
    expect((within(settings).getByLabelText('保留磁碟空間（%）') as HTMLInputElement).value).toBe('5');
  });

  it('shows the daemon’s refusal and keeps the edits', async () => {
    const view = renderConsole();
    const settings = await section('設定');
    const disk = (await within(settings).findByLabelText('保留磁碟空間（GB）')) as HTMLInputElement;
    fireEvent.change(disk, { target: { value: '20' } });
    fireEvent.click(within(settings).getByRole('button', { name: '儲存設定' }));
    expect(view.conn.lastRequest('admin.settings.set')?.payload).toEqual({ diskReserveBytes: 20 * GIB });
    await act(async () => {
      view.conn.fail('admin.settings.set', new SmurgError('bad_request', '保留空間超過磁碟大小'));
    });
    expect(within(settings).getByText('無法儲存設定：保留空間超過磁碟大小')).toBeTruthy();
    expect(disk.value).toBe('20');
  });

  it('settings are live: a change made elsewhere is re-read and shown', async () => {
    const view = renderConsole();
    const settings = await section('設定');
    const idle = (await within(settings).findByLabelText('編輯鎖閒置釋放時間（秒）')) as HTMLInputElement;
    const reads = view.conn.requestsOf('admin.settings.get').length;
    view.fixture.settings = { ...SETTINGS, humanLockIdleMs: 45_000, sharedDirs: ['data', 'models'] };
    act(() =>
      view.conn.emit('channel.settingsUpdated', {
        settings: { humanLockIdleMs: 45_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: ['data'] },
      }),
    );
    await waitFor(() => expect(idle.value).toBe('45'));
    expect(view.conn.requestsOf('admin.settings.get').length).toBe(reads + 1);
    expect((within(settings).getByLabelText('共享資料夾（在 worktree 裡唯讀）') as HTMLTextAreaElement).value).toBe('data\nmodels');
  });
});
