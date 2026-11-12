// The sticky notes in Traditional Chinese (DESIGN 0.8.0 D7): the list's words, the open note's, the pages without a
// note, what a member does with the open note (Read / Edit, Add a sticky note, Ask Claude), and the feedback under it
// (D7.8: the box, Accept and Reject, Withdraw, "What Claude gets", "Show N earlier", the counts, the group of notes
// that are gone), and "Build this" (D5.3). A note's name is a file's name and is never translated: `Home` is Home in
// both languages (D1.1).
import { SmurgError, type Feedback } from '@smurg/protocol';
import { ClientRequestError } from '@smurg/protocol/client';
import { msg } from '@smurg/protocol/i18n';
import { buildTopic } from '@smurg/protocol/testing';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { describeError } from '../../lib/errors.ts';
import { formatDateTime } from '../../lib/format.ts';
import { T0, makeAgentLock } from '../../testing/fixtures.ts';
import { useTestLocale } from '../../testing/locale.ts';
import { notePath, openNotes } from './test-support.tsx';

useTestLocale('zh-TW');

const disposers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
});

async function shown(options: Parameters<typeof openNotes>[0] = {}) {
  const view = openNotes(options);
  disposers.push(() => view.session.dispose());
  await view.settle();
  return view;
}

const list = (): HTMLElement => screen.getByRole('complementary', { name: 'All sticky notes' });
const note = (): HTMLElement => screen.getByRole('main', { name: 'Open sticky note' });

describe('the sticky notes in zh-TW', () => {
  it('the list and the open note: the tree\'s name, "Not linked", the links\' titles, the lock line; Home stays Home', async () => {
    const view = await shown();
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(within(list()).getByRole('tree', { name: '從 Home 開始的便利貼' })).toBeTruthy();
    expect(within(list()).getByRole('treeitem', { name: 'Home' })).toBeTruthy();
    const notLinked = within(list()).getByRole('heading', { level: 2, name: '未連結' });
    expect(notLinked.getAttribute('title')).toBe('從 Home 出發，沒有任何一張便利貼連到這些。');
    const card = within(note()).getByRole('article', { name: 'Home' });
    expect(within(card).getByRole('link', { name: 'Checkout' }).getAttribute('title')).toBe('開啟便利貼「Checkout」');
    expect((card.querySelector('a.md-wiki--missing') as HTMLElement).textContent).toBe('Refunds （還沒寫）');
    act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Home.md' }, lock: makeAgentLock('notes/Home.md') }));
    expect(within(note()).getByRole('status').textContent).toBe('Claude 正在寫這張便利貼。');
  });

  it('the pages without a note, for a member who may write and for a Viewer', async () => {
    await shown({ notes: [] });
    expect(within(list()).getByText('還沒有便利貼。')).toBeTruthy();
    expect(within(note()).getByRole('heading', { level: 2, name: '從一張便利貼開始' })).toBeTruthy();
    expect(note().textContent).toContain('每張便利貼都從第一張 Home 長出來：在便利貼裡用 [[名稱]] 連到下一張。');
    expect(within(note()).getByRole('button', { name: '寫第一張便利貼' })).toBeTruthy();
    cleanup();
    await shown({ path: notePath('Refunds') });
    expect(note().textContent).toContain('這張便利貼還沒寫。');
    expect(within(note()).getByRole('button', { name: '寫這張便利貼' })).toBeTruthy();
    cleanup();
    await shown({ role: 'viewer', notes: [] });
    expect(note().textContent).toContain('還沒有便利貼。可以編輯的成員會寫下第一張。');
    cleanup();
    await shown({ role: 'viewer', path: notePath('Refunds') });
    expect(note().textContent).toContain('可以編輯的成員可以寫它。');
    expect(within(note()).queryByRole('button')).toBeNull();
  });

  it('an empty note, a note that cannot be read, a fold twin', async () => {
    const view = await shown({ notes: [{ name: 'Home', links: ['Broken'] }, { name: 'Broken', links: [], unreadable: true }, { name: 'home', links: [], shadowed: true }], texts: { Home: '' } });
    expect(note().textContent).toContain('這張便利貼是空的。');
    expect(within(list()).getByRole('treeitem', { name: 'Broken，無法讀取' })).toBeTruthy();
    expect(within(list()).getByRole('treeitem', { name: 'home，沒有讀取：和「Home」同名' })).toBeTruthy();
    view.navigate(notePath('Broken'));
    await view.settle();
    expect(within(note()).getByText('smurg 無法讀取這張便利貼的檔案。')).toBeTruthy();
  });

  it('what a member does with the open note: Read / Edit, "Add a sticky note" and its dialog, the line after it, "Ask Claude"', async () => {
    const view = await shown({ onAskClaude: () => {} });
    const tools = within(note()).getByRole('group', { name: '這張便利貼可以做的事' });
    expect(within(tools).getByRole('radiogroup', { name: '便利貼的檢視方式' })).toBeTruthy();
    expect(within(tools).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['閱讀', '編輯']);
    expect(within(tools).getByRole('button', { name: '就這張便利貼問 Claude' })).toBeTruthy();
    await userEvent.click(within(tools).getByRole('button', { name: '新增便利貼' }));
    const dialog = screen.getByRole('dialog', { name: '新增便利貼' });
    expect(dialog.textContent).toContain('一張新的空白便利貼。它的連結會加在「Home」的最後。');
    view.conn.handle('sticky.create', ({ name }) => ({ note: { name, links: [] } }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: '新便利貼的名稱' }), 'Refunds');
    await userEvent.click(within(dialog).getByRole('button', { name: '新增' }));
    await view.settle();
    expect(within(note()).getByRole('status').textContent).toBe('「Refunds」的連結已加在「Home」的最後。');
    // While Claude holds the note's lock, nothing is written into it: the page says so.
    act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Home.md' }, lock: makeAgentLock('notes/Home.md') }));
    act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Home.md' }, lock: null }));
    await userEvent.click(within(tools).getByRole('button', { name: '新增便利貼' }));
    const again = screen.getByRole('dialog', { name: '新增便利貼' });
    await userEvent.type(within(again).getByRole('textbox', { name: '新便利貼的名稱' }), 'Coupons');
    view.conn.handle('sticky.create', ({ name }) => {
      act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Home.md' }, lock: makeAgentLock('notes/Home.md') }));
      return { note: { name, links: [] } };
    });
    await userEvent.click(within(again).getByRole('button', { name: '新增' }));
    await view.settle();
    expect(within(note()).getByText('沒有加上「Coupons」的連結：「Home」現在不能修改。在有便利貼連到「Coupons」之前，它會列在「未連結」下面。')).toBeTruthy();
    // A note the list has under Home: only that the link was not added (review S4-R4).
    act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Home.md' }, lock: null }));
    await userEvent.click(within(tools).getByRole('button', { name: '新增便利貼' }));
    const third = screen.getByRole('dialog', { name: '新增便利貼' });
    await userEvent.type(within(third).getByRole('textbox', { name: '新便利貼的名稱' }), 'Checkout');
    view.conn.handle('sticky.create', () => {
      act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Home.md' }, lock: makeAgentLock('notes/Home.md') }));
      throw new SmurgError('conflict', msg('sticky.create.exists', { name: 'Checkout' }), { reason: 'exists' });
    });
    await userEvent.click(within(third).getByRole('button', { name: '新增' }));
    await view.settle();
    expect(within(note()).getByText('沒有加上「Checkout」的連結：「Home」現在不能修改。')).toBeTruthy();
  });

  it('the feedback under a note: the box and its line, an outside author\'s place, Accept / Reject / Withdraw, "What Claude gets", the earlier ones and their decisions, the counts, the notes that are gone, a refusal and "Start Claude"', async () => {
    const vic = { kind: 'member', user: { userId: 'dev:vic', displayName: 'Vic' } } as const;
    const amy = { kind: 'member', user: { userId: 'dev:amy', displayName: 'Amy' } } as const;
    const mei = { userId: 'dev:mei', displayName: 'Mei' };
    const feedback: Feedback[] = [
      { id: 'fb_a', note: 'Home', text: '多一點圖片。', author: vic, status: 'waiting', createdAt: T0 },
      { id: 'fb_o', note: 'Home', text: '優惠碼的欄位很難找。', author: { kind: 'outside', source: 'discord', name: 'Mei Chen', externalId: '123456789012345678' }, status: 'waiting', createdAt: T0 + 1 },
      { id: 'fb_mine', note: 'Home', text: '我的意見。', author: amy, status: 'waiting', createdAt: T0 + 2 },
      { id: 'fb_ok', note: 'Home', text: '價格寫清楚。', author: vic, status: 'accepted', decidedBy: mei, decidedAt: T0 + 60_000, createdAt: T0 },
      { id: 'fb_no', note: 'Home', text: '深色模式。', author: vic, status: 'rejected', decidedBy: mei, decidedAt: T0 + 120_000, rejectReason: '今年不做', createdAt: T0 },
      { id: 'fb_gone', note: 'Old ideas', text: '保留禮物卡。', author: vic, status: 'waiting', createdAt: T0 },
    ];
    const view = await shown({ role: 'host', feedback });
    const part = within(note()).getByRole('region', { name: '意見' });
    const box = within(part).getByRole('textbox', { name: '對「Home」提出意見' });
    expect(document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent).toBe('工作區裡的每個人都看得到。要等「可使用 agent」的成員採用，它才會交給 Claude。');
    expect(within(part).getByRole('button', { name: '提出意見' })).toBeTruthy();
    const entries = [...part.querySelectorAll<HTMLElement>(':scope > ul > li')];
    expect(entries.map((entry) => within(entry).queryAllByRole('button').map((button) => button.textContent))).toEqual([
      ['採用', '不採用'],
      ['採用', '不採用'],
      ['採用', '不採用', '撤回'],
    ]);
    // An outside author: the name and where they wrote.
    expect(entries[1]?.querySelector('.sticky-fb__head')?.textContent).toBe(`Mei Chen來自 Discord${formatDateTime(T0 + 1)}`);
    expect(within(entries[0] as HTMLElement).getByText('Claude 會收到什麼').tagName).toBe('SUMMARY');
    expect(within(entries[0] as HTMLElement).getByText('按下「採用」，這段文字會以你的訊息送給便利貼的 Claude 一次。')).toBeTruthy();
    // The earlier ones, folded, with their decisions in feedback's own words.
    expect(within(part).getByText('顯示較早的 2 則').tagName).toBe('SUMMARY');
    expect([...part.querySelectorAll(':scope > details > ul > li .sticky-fb__decision')].map((line) => line.textContent)).toEqual([
      `Mei 不採用，${formatDateTime(T0 + 120_000)}：「今年不做」`,
      `Mei 已採用，${formatDateTime(T0 + 60_000)}`,
    ]);
    // The counts on the rows, and the notes that are gone.
    expect(within(list()).getByRole('treeitem', { name: 'Home，3 則意見等待處理' })).toBeTruthy();
    const gone = within(list()).getByRole('heading', { level: 2, name: '已經不在的便利貼上的意見' });
    expect(gone.getAttribute('title')).toBe('現在沒有這些名稱的便利貼，但上面的意見還在等待處理。');
    expect(within(list()).getByRole('treeitem', { name: 'Old ideas，1 則意見等待處理' })).toBeTruthy();
    // Reject asks why.
    await userEvent.click(within(entries[0] as HTMLElement).getByRole('button', { name: '不採用' }));
    expect(within(entries[0] as HTMLElement).getByRole('textbox', { name: '為什麼？（選填，每個人都看得到）' })).toBeTruthy();
    expect(within(entries[0] as HTMLElement).getByRole('button', { name: '取消' })).toBeTruthy();
    await userEvent.click(within(entries[0] as HTMLElement).getByRole('button', { name: '取消' }));
    // Accept with Claude for the sticky notes not running: the host's words and "Start Claude".
    const noAssistant = new SmurgError('conflict', msg('sticky.feedback.noAssistant'), { reason: 'no-assistant' });
    view.conn.handle('sticky.feedback.accept', () => {
      throw noAssistant;
    });
    await userEvent.click(within(entries[0] as HTMLElement).getByRole('button', { name: '採用' }));
    await view.settle();
    expect(within(entries[0] as HTMLElement).getByRole('alert').textContent).toBe(describeError(noAssistant));
    expect(describeError(noAssistant)).toBe('便利貼的 Claude 沒有在執行。請先啟動它：採用的意見會交給它');
    expect(within(entries[0] as HTMLElement).getByRole('button', { name: '啟動 Claude' })).toBeTruthy();
    // A refused feedback: its own sentence around the host's words.
    const full = new SmurgError('conflict', msg('sticky.feedback.full'), { reason: 'feedback-full', bound: 'members' });
    view.conn.handle('sticky.feedback.create', () => {
      throw full;
    });
    await userEvent.type(box, '再一則。');
    await userEvent.click(within(part).getByRole('button', { name: '提出意見' }));
    await view.settle();
    expect(within(part.querySelector('.sticky-feedback__box') as HTMLElement).getByRole('alert').textContent).toBe(`你的意見沒有送出：${describeError(full)}`);
  });

  it('the feedback that could not be loaded, and an outside message that was cut, in zh-TW', async () => {
    const failure = new SmurgError('conflict', msg('sticky.feedback.notFound'), { reason: 'unknown-feedback' });
    await shown({ role: 'viewer', feedbackError: failure });
    const part = within(note()).getByRole('region', { name: '意見' });
    expect(within(part).getByRole('alert').textContent).toBe(`無法載入意見：${describeError(failure)}`);
    expect(within(part).getByRole('button', { name: '重試' })).toBeTruthy();
    cleanup();
    await shown({
      role: 'viewer',
      feedback: [{ id: 'fb_cut', note: 'Home', text: '很長的訊息的開頭', cut: true, cleaned: true, author: { kind: 'outside', source: 'slack', name: 'Mei Chen', externalId: 'U012ABCDEF' }, status: 'waiting', createdAt: T0 }],
    });
    const entry = within(note()).getByRole('region', { name: '意見' }).querySelector(':scope > ul > li') as HTMLElement;
    expect([...entry.querySelectorAll('.sticky-fb__note')].map((line) => line.textContent)).toEqual(['這則訊息比較長：只保留了開頭。', '已移除看不見的字元。']);
    expect(entry.querySelector('.sticky-fb__source')?.textContent).toBe('來自 Slack');
  });
});

describe('"Build this" in zh-TW (D5.3)', () => {
  it('the button, the dialog (what it does, the notes, the warning, the text, the confirm), why it waits, and the topics made from the note', async () => {
    const view = await shown({ role: 'host', notes: [{ name: 'Home', links: ['Checkout'], builds: ['tp_1'] }, { name: 'Checkout', links: [] }] });
    act(() => view.conn.emit('topic.updated', { topic: buildTopic({ id: 'tp_1', name: 'Home', slug: 'home' }) }));
    const section = within(note()).getByRole('region', { name: '從這張便利貼建立的主題' });
    expect(within(section).getByRole('button', { name: 'Home' }).getAttribute('title')).toBe('打開主題「Home」的計畫');
    const tools = within(note()).getByRole('group', { name: '這張便利貼可以做的事' });
    view.conn.handle('sticky.spec', () => ({ text: 'Built from the sticky note "notes/Home.md".\n\n付\u200b款\n\nOther sticky notes are not part of this spec.\n', hash: 'c'.repeat(64), notes: ['Home', 'Checkout'] }));
    await userEvent.click(within(tools).getByRole('button', { name: '把它做出來' }));
    await view.settle();
    const dialog = screen.getByRole('dialog', { name: '把這張便利貼做出來' });
    expect(
      within(dialog).getByText('smurg 會用下面這段文字建立一個主題：這段文字就是主題的 spec，計畫只有一個工作項目。和每個新主題一樣，它和 Claude 的討論 session 會馬上開始。工作還不會開始：主題的計畫會在 session 畫面打開，在那裡按「開始」才會開始工作。'),
    ).toBeTruthy();
    expect(within(dialog).getByText('2 張便利貼的文字：Home 和 Checkout。')).toBeTruthy();
    expect(within(dialog).getByText('這段文字裡有你看不到的字元，它們會原樣放進 spec。')).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'spec 的文字' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '建立主題' })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    // Claude holds the note's lock: the button waits, and says why.
    act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Home.md' }, lock: makeAgentLock('notes/Home.md') }));
    const button = within(tools).getByRole('button', { name: '把它做出來' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe('要等這張便利貼的修改都存好、Claude 也沒有在寫它，才能把它做出來。');
  });

  it('a refusal in the host\'s words: the topic was not made, or it was and a later step did not go through', async () => {
    const view = await shown({ role: 'agent' });
    view.conn.handle('sticky.spec', () => ({ text: 'x\n', hash: 'c'.repeat(64), notes: ['Home'] }));
    await userEvent.click(within(note()).getByRole('button', { name: '把它做出來' }));
    await view.settle();
    const dialog = screen.getByRole('dialog', { name: '把這張便利貼做出來' });
    await userEvent.click(within(dialog).getByRole('button', { name: '建立主題' }));
    const changed = new SmurgError('conflict', msg('sticky.build.noteChanged'), { reason: 'note-changed' });
    await act(async () => {
      view.conn.fail('sticky.build', changed);
    });
    await view.settle();
    expect(within(dialog).getByRole('alert').textContent).toBe(`沒有建立主題：${describeError(changed)}`);
    expect(describeError(changed)).toContain('請看新的文字，再確認一次');
    await userEvent.click(within(dialog).getByRole('button', { name: '建立主題' }));
    await act(async () => {
      view.conn.fail('sticky.build', new SmurgError('internal', msg('sticky.build.failedAt', { step: 'plan' }), { reason: 'failed-at', step: 'plan', topicId: 'tp_3' }));
    });
    await view.settle();
    expect(within(dialog).getByRole('alert').textContent).toContain('主題已經建立，可以在 session 畫面找到，SPEC.md 也寫好了，但它的 PLAN.md 沒有寫入');
    expect(within(dialog).getByRole('button', { name: '打開主題的計畫' })).toBeTruthy();
    // The topic is made: no second confirm, only Close.
    expect(within(dialog).queryByRole('button', { name: '建立主題' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: '關閉' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('while the text is read, a text that cannot be read, and a reply that never came, in zh-TW', async () => {
    const view = await shown({ role: 'host' });
    const buildButton = (): HTMLElement => within(note()).getByRole('button', { name: '把它做出來' });
    await userEvent.click(buildButton());
    await view.settle();
    const dialog = (): HTMLElement => screen.getByRole('dialog', { name: '把這張便利貼做出來' });
    expect(within(dialog()).getByText('正在讀取便利貼…')).toBeTruthy();
    const oversized = new SmurgError('too_large', msg('sticky.spec.oversized', { name: 'Checkout', maxKiB: 64 }), { reason: 'note-oversized' });
    await act(async () => {
      view.conn.fail('sticky.spec', oversized);
    });
    await view.settle();
    expect(within(dialog()).getByRole('alert').textContent).toBe(`無法讀取這段文字：${describeError(oversized)}`);
    expect(describeError(oversized)).toBe('便利貼「Checkout」超過 64 KiB，所以不能放進 spec');
    view.conn.handle('sticky.spec', () => ({ text: 'x\n', hash: 'c'.repeat(64), notes: ['Home'] }));
    await userEvent.click(within(dialog()).getByRole('button', { name: '重試' }));
    await view.settle();
    await userEvent.click(within(dialog()).getByRole('button', { name: '建立主題' }));
    const lost = new ClientRequestError('connection-lost');
    await act(async () => {
      view.conn.fail('sticky.build', lost);
    });
    await view.settle();
    expect(within(dialog()).getByRole('alert').textContent).toBe(`${describeError(lost)}如果主題已經建立，可以在 session 畫面找到；如果沒有，請關掉這個對話框，再按一次「把它做出來」。`);
    expect(describeError(lost)).toBe('連線中斷，這個動作可能沒有完成，請重新整理後確認');
    expect(within(dialog()).queryByRole('button', { name: '建立主題' })).toBeNull();
    expect(within(dialog()).getByRole('button', { name: '關閉' })).toBeTruthy();
  });

  it('archived topics made from the note, in zh-TW: how many are not shown, the button that shows them, the mark, and a list that could not be loaded', async () => {
    const view = await shown({ role: 'viewer', notes: [{ name: 'Home', links: [], builds: ['tp_2', 'tp_1'] }] });
    act(() => view.conn.emit('topic.updated', { topic: buildTopic({ id: 'tp_1', name: 'Home', slug: 'home' }) }));
    const section = (): HTMLElement => within(note()).getByRole('region', { name: '從這張便利貼建立的主題' });
    expect(within(section()).getByText('有 1 個已封存的主題沒有顯示。')).toBeTruthy();
    await userEvent.click(within(section()).getByRole('button', { name: '顯示已封存的主題' }));
    const failure = new SmurgError('internal');
    await act(async () => {
      view.conn.fail('topic.list', failure);
    });
    await view.settle();
    expect(within(section()).getByRole('alert').textContent).toBe(`無法載入已封存的主題：${describeError(failure)}`);
    await userEvent.click(within(section()).getByRole('button', { name: '顯示已封存的主題' }));
    await act(async () => {
      view.conn.respond('topic.list', { topics: [buildTopic({ id: 'tp_2', name: 'Home', slug: 'home-2', archived: true })], hasMore: false });
    });
    await view.settle();
    expect(within(section()).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Homespecs/home-2已封存', 'Homespecs/home']);
  });

  it('the Slack and Discord channels the host connected, in zh-TW: each line and the host\'s words for why one is not read', async () => {
    const problem = { text: msg('sticky.source.channelInvalid'), fallback: 'The channel id in connectors.json does not have the form of a channel id, so smurg never reads the channel. Connect it again with smurg connect.' };
    const view = await shown({ role: 'host', list: () => ({ notes: [{ name: 'Home', links: [] }], hasMore: false, truncated: false, sources: [{ source: 'slack', state: 'reading' }, { source: 'discord', state: 'failing', problem }] }) });
    const part = screen.getByRole('region', { name: 'Slack 和 Discord' });
    // What the hint says is true: only the host is shown the part, and every member's page is sent the states (S8-SEC-1).
    expect(within(part).getByRole('heading', { name: 'Slack 和 Discord' }).getAttribute('title')).toBe('你用 smurg connect 連接的頻道。由你的電腦讀取。只有你看得到這一區，不過每個頻道的狀態也會傳送給每位成員。');
    expect(within(part).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Slack：每分鐘讀取一次新訊息。',
      'Discord：沒有讀取。connectors.json 裡的頻道 id 不是頻道 id 的格式，所以 smurg 不會讀取這個頻道。請用 smurg connect 重新連接',
    ]);
    act(() => view.conn.emit('sticky.changed', { upserted: [], removed: [], truncated: false, sources: [{ source: 'discord', state: 'waiting-for-room' }] }));
    expect(within(screen.getByRole('region', { name: 'Slack 和 Discord' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Discord：等候空間。來自外部的意見，已經有 smurg 能保留的上限那麼多在等待處理（所有人合計，或是其中一個人）；有一些被採用或不採用之後就會繼續讀取。',
    ]);
    // Home goes: a message that names no sticky note is not kept, and the host is told so.
    const noHome = '還沒有 Home 便利貼，所以沒有用 [[名稱]] 指名便利貼的訊息不會保留。';
    expect(within(screen.getByRole('region', { name: 'Slack 和 Discord' })).queryByText(noHome)).toBeNull();
    act(() => view.conn.emit('sticky.changed', { upserted: [], removed: ['Home'], truncated: false }));
    expect(within(screen.getByRole('region', { name: 'Slack 和 Discord' })).getByText(noHome)).toBeTruthy();
  });
});
