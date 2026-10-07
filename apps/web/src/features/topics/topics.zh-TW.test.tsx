// The topic screens in Traditional Chinese: the plan's badges and sentences, the Start dialog's lines, a report's
// headings and the New topic dialog are composed from the zh-TW table; names and numbers are joined the zh-TW way;
// what people and agents wrote stays as written.
import type { PlanInfo, StartPreflight, Topic } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { FAKE_HASH, buildPlan, buildReport, buildReportSummary, buildTopic, buildWorkItem } from '@smurg/protocol/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatAnd } from '../../lib/format.ts';
import { renderInColumn } from '../../testing/columns.tsx';
import { useTestLocale } from '../../testing/locale.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import { itemBadge } from './model.ts';
import { NewTopicDialog } from './NewTopicDialog.tsx';
import PlanColumn from './PlanColumn.tsx';
import ReportColumn from './ReportColumn.tsx';
import { startLines } from './start-model.ts';
import { IAN, MEI, admitAs, settle, topicConnection } from './testing/support.tsx';

useTestLocale('zh-TW');

const TOPIC: Topic = buildTopic({ name: '結帳流程改版', slug: 'topic-1', phase: 'plan', spec: { exists: true }, plan: { ...buildTopic().plan, exists: true, valid: true, items: 3 } });
const PLAN: PlanInfo = buildPlan({
  items: [
    buildWorkItem({ id: 'cart-api', number: 1, title: '購物車 API', summary: '把金額計算集中到單一模組。', responsible: { ...IAN, source: 'agent' } }),
    buildWorkItem({ id: 'payment-form', number: 2, title: '付款表單', size: 's', responsible: { ...MEI, source: 'agent' } }),
    buildWorkItem({ id: 'checkout-page', number: 3, title: '結帳頁', size: 'l', dependsOn: ['cart-api', 'payment-form'] }),
  ],
  split: { source: 'smurg' },
});

describe('the topic screens in zh-TW', () => {
  it('the plan column', async () => {
    const world = { role: 'agent' as const, topics: [TOPIC], plans: { tp_1: PLAN } };
    const conn = topicConnection(world);
    renderInColumn(<PlanColumn topicId="tp_1" />, { target: { kind: 'plan', topicId: 'tp_1' }, conn, admit: false });
    admitAs(conn, world);
    await settle();
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(screen.getByText('3 個工作項目')).toBeTruthy();
    expect(screen.getByText('2 個現在可以開始 · 1 個要等其他項目')).toBeTruthy();
    expect(screen.getByText('誰負責')).toBeTruthy();
    expect(screen.getByRole('radio', { name: '不指派：大家一起看' })).toBeTruthy();
    expect(screen.getByText(/^建議的分工：讓可使用 agent 的人平均分擔/)).toBeTruthy();
    const page = screen.getByText('結帳頁').closest('li') as HTMLElement;
    expect(within(page).getByText('等待 1 和 2')).toBeTruthy();
    expect(within(page).getByText('在 1 和 2 之後')).toBeTruthy();
    expect(within(page).getByText('大小：大')).toBeTruthy();
    expect(screen.getByRole('button', { name: '開始 2 個項目' })).toBeTruthy();
    expect(screen.getByText(/項目 3 會在 1 和 2 都合併後自動開始。/)).toBeTruthy();
    expect(screen.getByText('這個主題一律允許')).toBeTruthy();
    // What a person wrote is not translated.
    expect(screen.getByText('把金額計算集中到單一模組。')).toBeTruthy();
  });

  it('a plan smurg cannot read: what is wrong, then what is shown below, without a gap after full-width punctuation (review R2-C)', async () => {
    const broken: Topic = { ...TOPIC, plan: { ...TOPIC.plan, valid: false, error: { text: msg('plan.error.noBlock'), fallback: 'PLAN.md has no work item block (the two smurg:plan marker lines).' } } };
    const world = { role: 'agent' as const, topics: [broken], plans: { tp_1: PLAN } };
    const conn = topicConnection(world);
    renderInColumn(<PlanColumn topicId="tp_1" />, { target: { kind: 'plan', topicId: 'tp_1' }, conn, admit: false });
    admitAs(conn, world);
    await settle();
    expect(screen.getByText(/下面是 smurg 最後一次讀得懂的計畫。/).textContent).toContain('PLAN.md 裡沒有工作項目區塊（兩行 smurg:plan 標記）。下面是 smurg 最後一次讀得懂的計畫。檔案修正之前，任何項目都不能開始。');
  });

  it('badges and lists', () => {
    expect(formatAnd(['Ian', 'Mei', 'Amy'])).toBe('Ian、Mei 和 Amy');
    expect(itemBadge(buildWorkItem({ state: 'stalled', stalledBy: 'agent' }), PLAN).text).toBe('沒寫報告就停下了');
    expect(itemBadge(buildWorkItem({ state: 'done', report: buildReportSummary({ outcome: 'partial' }) }), PLAN).text).toMatch(/^報告待看 · /);
    expect(itemBadge(buildWorkItem({ state: 'queued', armed: true }), { ...PLAN, slots: { inUse: 8, max: 8, waitingForPeople: 5 } }).text).toBe('等待空閒的 agent：8 個裡有 8 個使用中，5 個在等人處理');
  });

  it('the Start dialog’s lines', () => {
    const preflight: StartPreflight = {
      planRevision: 1,
      specHash: FAKE_HASH,
      planHash: FAKE_HASH,
      startsNow: ['cart-api', 'payment-form'],
      waits: [{ itemId: 'checkout-page', for: ['cart-api', 'payment-form'] }],
      alreadyStarted: [],
      responsible: [
        { itemId: 'cart-api', user: IAN, online: true },
        { itemId: 'payment-form', user: MEI, online: false },
      ],
      youDecide: 1,
      commit: { needed: true, branch: 'main', as: MEI, files: [], alsoInFolder: ['specs/topic-1/notes.txt'] },
      handEdits: { spec: [], plan: [] },
      invisibleCharacters: ['spec'],
      stale: true,
      openQuestion: false,
      specOpenQuestions: 2,
      editingNow: [],
      projectSettings: 'ignored',
      rules: [],
      sharedDirs: [],
      blockers: [{ text: msg('plan.start.invalid'), fallback: 'Fix PLAN.md before you start.' }],
    };
    const text = startLines(preflight, PLAN, MEI.userId).map((line) => line.text);
    expect(text).toEqual([
      '開始前請先修正 PLAN.md',
      '2 個項目現在開始：1 · 購物車 API 和 2 · 付款表單。',
      '3 · 結帳頁 會在 1 · 購物車 API 和 2 · 付款表單 都合併後自動開始，前提是 spec 和計畫還是你現在看到的內容。',
      '負責人：Ian 1 · Mei 1。',
      'Mei 目前離線：他負責的項目會開始，然後等他。',
      '這 1 個 session 的選擇題會由你決定。',
      'smurg 會以你的身分，把 SPEC.md 和 PLAN.md 提交到主人資料夾的 main 分支。資料夾裡還有、但不會提交的檔案：specs/topic-1/notes.txt。',
      'SPEC.md 裡有你看不到的字元。開始之前請先看變更。',
      'spec 在這份計畫寫好之後有變動。',
      'spec 裡列了 2 個未決事項。',
      '主人還沒確認這個資料夾的 Claude Code 專案設定：agent 不會讀 CLAUDE.md。',
      '每個項目都在自己全新的 worktree 裡進行，沒有共享任何資料夾，所以 agent 會先安裝需要的東西。',
    ]);
  });

  it('a result report: the catalogue’s headings over what the agent wrote', async () => {
    const executing = { ...TOPIC, phase: 'executing' as const };
    const world = { role: 'host' as const, topics: [executing], plans: { tp_1: buildPlan({ items: [buildWorkItem({ state: 'done', attempt: 1, report: buildReportSummary({ reviewers: [IAN] }) })] }) } };
    const conn = topicConnection(world);
    conn.handle('report.get', () => ({ report: buildReport({ reviewers: [IAN], sections: { done: 'The cart endpoints.', why: 'As decided.', verified: [{ text: 'pnpm test', passed: true }], watchOut: 'Nothing.' } }) }));
    const view = renderInColumn(<ReportColumn topicId="tp_1" itemId="cart-api" />, { target: { kind: 'report', topicId: 'tp_1', itemId: 'cart-api' }, conn, admit: false });
    admitAs(conn, world);
    await settle(4);
    for (const heading of ['做了什麼', '為什麼這樣做', '怎麼驗證的', '要注意什麼', '變更']) expect(screen.getByRole('heading', { level: 3, name: heading })).toBeTruthy();
    expect(within(view.column.header).getByText('完成')).toBeTruthy();
    expect(screen.getByText('The cart endpoints.')).toBeTruthy();
    expect(screen.getByText('等你看')).toBeTruthy();
    expect(screen.getByText('1 項通過 · 0 項未驗證')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '追問這個結果，或告訴 Claude 要改什麼' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '我已看過' })).toBeTruthy();
    expect(screen.getByText('這個項目沒有變更任何檔案。')).toBeTruthy();
  });

  it('the New topic dialog: a Chinese name keeps its name and gets a Latin folder', async () => {
    const world = { role: 'agent' as const, topics: [] };
    const conn = topicConnection(world);
    const context = createTestWorkspace({ conn, admit: false });
    admitAs(conn, world);
    await settle();
    render(
      <WorkspaceTestProviders context={context}>
        <NewTopicDialog onClose={() => {}} />
      </WorkspaceTestProviders>,
    );
    const dialog = screen.getByRole('dialog', { name: '新增主題' });
    fireEvent.change(within(dialog).getByLabelText('名稱'), { target: { value: '結帳流程改版' } });
    expect((within(dialog).getByLabelText(/^spec 與計畫的資料夾/) as HTMLInputElement).value).toBe('topic-1');
    expect(within(dialog).getByText(/資料夾名稱使用英文字母；主題會保留自己的名稱。/)).toBeTruthy();
    expect(within(dialog).getByText(/^開始主題會開啟它的討論 session/)).toBeTruthy();
    // The sentence about a personal subscription is the host's.
    expect(within(dialog).queryByText(/個人的 Claude 訂閱/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '開始討論' }));
    expect(conn.lastRequest('topic.create')?.payload).toEqual({ name: '結帳流程改版', slug: 'topic-1' });
    await act(async () => {
      conn.fail('topic.create', new (await import('@smurg/protocol')).SmurgError('conflict', msg('topic.folderExists', { path: 'specs/topic-1' })));
    });
    expect(within(dialog).getByText('資料夾 specs/topic-1 已經存在，請換一個名稱')).toBeTruthy();
  });

  it('the New topic dialog tells the host whose use a personal subscription is for', async () => {
    const world = { role: 'host' as const, topics: [] };
    const conn = topicConnection(world);
    const context = createTestWorkspace({ conn, admit: false });
    admitAs(conn, world);
    await settle();
    render(
      <WorkspaceTestProviders context={context}>
        <NewTopicDialog onClose={() => {}} />
      </WorkspaceTestProviders>,
    );
    const dialog = screen.getByRole('dialog', { name: '新增主題' });
    expect(within(dialog).getByText('個人的 Claude 訂閱（Pro 或 Max）只供你自己使用。有其他人在這裡使用 agent 時，請改用 API 金鑰、Team 或 Enterprise 方案。')).toBeTruthy();
  });
});
