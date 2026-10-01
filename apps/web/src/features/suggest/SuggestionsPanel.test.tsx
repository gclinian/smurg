// The suggestion flow per role (SPEC R6; ARCHITECTURE §5.6; protocol v2): a composer for editors, the author's list
// (edit / withdraw while pending, the outcome afterwards), the queue beside the terminal for everyone who may type into
// the session — the host and 可使用 agent members, on ANY session (accept, edit then accept, reject with a reason) —,
// notices to the author, the editor's selection action, and NO auto-accept anywhere.
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, type Role, type SessionInfo, type Suggestion } from '@smurg/protocol';
import { HOST_USER, makeSession, makeSuggestion } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { SuggestionsPanel } from './index.tsx';

const hostSession = makeSession({ id: 'sess_host', ownerUserId: HOST_USER, ownerName: 'Ian', title: 'Claude' });
const amySession = makeSession({ id: 'sess_amy', ownerUserId: 'dev:amy', ownerName: 'Amy', title: '我的 Claude', createdAt: 2 });

async function renderPanel(role: Role, options: { sessions?: SessionInfo[]; suggestions?: Suggestion[]; focus?: string } = {}) {
  const result = renderInWorkspace(<SuggestionsPanel />, { role });
  await act(async () => {
    result.conn.respond('session.list', { sessions: options.sessions ?? [hostSession] });
    result.conn.respond('suggest.list', { suggestions: options.suggestions ?? [] });
  });
  await act(async () => {
    result.stores.sessions.focus(options.focus ?? 'sess_host');
  });
  return result;
}

const panel = (): HTMLElement => screen.getByRole('region', { name: '建議' });

describe('composer: an editor suggests', () => {
  it('an editor proposes text; it waits for the host or a 可使用 agent member, never goes into the session', async () => {
    const { conn } = await renderPanel('editor');
    const box = screen.getByLabelText('給 Ian 開的「Claude」的建議');
    expect(screen.getByText('建議會先進入等待清單；主人或「可使用 agent」的成員採用後，才會送進 session。')).toBeTruthy();
    fireEvent.change(box, { target: { value: '請先幫 parseConfig 補上測試' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '送出建議' }));
    });
    expect(conn.lastRequest('suggest.create')?.payload).toEqual({ sessionId: 'sess_host', text: '請先幫 parseConfig 補上測試' });
    await act(async () => {
      conn.respond('suggest.create', { suggestion: makeSuggestion({ sessionId: 'sess_host', text: '請先幫 parseConfig 補上測試' }) });
    });
    expect(screen.getByText('已送出建議，等待主人或「可使用 agent」的成員決定。')).toBeTruthy();
    expect((screen.getByLabelText('給 Ian 開的「Claude」的建議') as HTMLTextAreaElement).value).toBe('');
    // Nothing reached the session itself.
    expect(conn.notificationsOf('exec.input')).toEqual([]);
    // It is listed as mine, pending.
    const mine = within(panel()).getByRole('region', { name: '我提出的建議' });
    expect(mine.textContent).toContain('等待決定');
  });

  it('Ctrl+Enter sends; blank text is refused before anything is sent', async () => {
    const { conn } = await renderPanel('editor');
    const box = screen.getByLabelText('給 Ian 開的「Claude」的建議');
    fireEvent.change(box, { target: { value: '   ' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    });
    expect(conn.requestsOf('suggest.create')).toHaveLength(0);
    fireEvent.change(box, { target: { value: '跑一下 lint' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    });
    expect(conn.lastRequest('suggest.create')?.payload.text).toBe('跑一下 lint');
  });

  it('a viewer watches but cannot propose (told why)', async () => {
    await renderPanel('viewer');
    expect(screen.queryByRole('button', { name: '送出建議' })).toBeNull();
    expect(screen.getByText(/你的角色是「旁觀」/)).toBeTruthy();
  });

  it('an ended session takes no more suggestions', async () => {
    await renderPanel('editor', { sessions: [{ ...hostSession, status: 'exited' }] });
    expect(screen.queryByRole('button', { name: '送出建議' })).toBeNull();
    expect(screen.getByText('這個 session 已結束，不能再提出建議。')).toBeTruthy();
  });
});

describe('the queue beside the terminal (the host and 可使用 agent, any session)', () => {
  const fromAmy = makeSuggestion({ id: 'sug_a', sessionId: 'sess_host', text: '請先補上測試', createdAt: 1 });
  const fromBob = makeSuggestion({ id: 'sug_b', sessionId: 'sess_host', author: { userId: 'dev:bob', displayName: 'Bob' }, text: '順便更新 README', createdAt: 2 });
  const fromCat = makeSuggestion({ id: 'sug_c', sessionId: 'sess_host', author: { userId: 'dev:cat', displayName: 'Cat' }, text: '改用 pnpm', createdAt: 3 });

  it('shows proposer, time and text for each pending suggestion, oldest first', async () => {
    await renderPanel('host', { suggestions: [fromBob, fromAmy, fromCat] });
    const queue = within(panel()).getByRole('region', { name: '等待你決定的建議（3）' });
    const items = within(queue).getAllByRole('article');
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual(['Amy 提出', 'Bob 提出', 'Cat 提出']);
    expect(items[0]!.textContent).toContain('請先補上測試');
    expect(items[0]!.querySelector('time')?.getAttribute('datetime')).toBe(new Date(1).toISOString());
  });

  it('accept sends the id and the text the owner saw (SEC-D-01); the daemon pastes exactly that text as the owner', async () => {
    const { conn } = await renderPanel('host', { suggestions: [fromAmy] });
    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: '採用' }));
    });
    // Not only the id: an edit by the author between the owner's reading and the click must not reach the session.
    expect(conn.lastRequest('suggest.accept')?.payload).toEqual({ suggestionId: 'sug_a', text: fromAmy.text });
    await act(async () => {
      conn.respond('suggest.accept', { suggestion: { ...fromAmy, status: 'accepted', resolvedAt: 5 } });
    });
    expect(screen.getByText('已採用 Amy 的建議，內容已送進 session。')).toBeTruthy();
    expect(within(panel()).getByText('目前沒有等待你處理的建議。')).toBeTruthy();
    // The browser never wrote the text into the PTY itself.
    expect(conn.notificationsOf('exec.input')).toEqual([]);
  });

  it('edit then accept sends the edited text (accepted-modified)', async () => {
    const { conn } = await renderPanel('host', { suggestions: [fromAmy] });
    fireEvent.click(within(panel()).getByRole('button', { name: '修改後採用' }));
    fireEvent.change(within(panel()).getByLabelText('修改建議內容'), { target: { value: '請先補上 parseConfig 的測試' } });
    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: '採用修改後的內容' }));
    });
    expect(conn.lastRequest('suggest.accept')?.payload).toEqual({ suggestionId: 'sug_a', text: '請先補上 parseConfig 的測試' });
  });

  it('reject asks for an optional reason and sends it', async () => {
    const { conn } = await renderPanel('host', { suggestions: [fromAmy, fromBob] });
    const [first] = within(panel()).getAllByRole('button', { name: '拒絕' });
    fireEvent.click(first!);
    fireEvent.change(within(panel()).getByLabelText('拒絕原因（選填，會告訴提出者）'), { target: { value: '  這部分我自己來 ' } });
    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: '確認拒絕' }));
    });
    expect(conn.lastRequest('suggest.reject')?.payload).toEqual({ suggestionId: 'sug_a', reason: '這部分我自己來' });
    await act(async () => {
      conn.respond('suggest.reject', { suggestion: { ...fromAmy, status: 'rejected', rejectReason: '這部分我自己來', resolvedAt: 9 } });
    });
    const [second] = within(panel()).getAllByRole('button', { name: '拒絕' });
    fireEvent.click(second!);
    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: '確認拒絕' }));
    });
    expect(conn.lastRequest('suggest.reject')?.payload).toEqual({ suggestionId: 'sug_b' });
  });

  it("a 可使用 agent member decides on suggestions to the HOST's session too: no composer, the queue, accept sends the text", async () => {
    const fromErin = makeSuggestion({ id: 'sug_e', sessionId: 'sess_host', author: { userId: 'dev:erin', displayName: 'Erin' }, text: 'echo hi' });
    const { conn } = await renderPanel('agent', { suggestions: [fromErin] });
    expect(screen.queryByRole('button', { name: '送出建議' })).toBeNull();
    const queue = within(panel()).getByRole('region', { name: '等待你決定的建議（1）' });
    expect(queue.textContent).toContain('主人和「可使用 agent」的成員都可以處理');
    await act(async () => {
      fireEvent.click(within(queue).getByRole('button', { name: '採用' }));
    });
    expect(conn.lastRequest('suggest.accept')?.payload).toEqual({ suggestionId: 'sug_e', text: 'echo hi' });
  });

  it('points to pending suggestions on other sessions', async () => {
    const other = makeSession({ id: 'sess_host2', title: '第二個', createdAt: 5 });
    const onOther = makeSuggestion({ id: 'sug_o', sessionId: 'sess_host2' });
    const { stores } = await renderPanel('host', { sessions: [hostSession, other, amySession], suggestions: [onOther, makeSuggestion({ id: 'sug_amy', sessionId: 'sess_amy' })] });
    expect(within(panel()).getByText('其他 session 還有 2 則建議等待處理。')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: '前往查看' }));
    });
    expect(stores.sessions.getState().focusedId).toBe('sess_host2');
  });
});

describe('no auto-accept anywhere (SPEC R6 「沒有自動採用選項」)', () => {
  for (const role of ['host', 'agent', 'editor', 'viewer'] as const) {
    it(`${role}: no checkbox, switch or option that would accept suggestions automatically`, async () => {
      const pending = makeSuggestion({ id: 'sug_p', sessionId: role === 'host' ? 'sess_host' : 'sess_amy', author: { userId: 'dev:bob', displayName: 'Bob' } });
      await renderPanel(role, { sessions: [hostSession, amySession], suggestions: [pending], focus: role === 'host' ? 'sess_host' : 'sess_amy' });
      expect(within(panel()).queryAllByRole('checkbox')).toEqual([]);
      expect(within(panel()).queryAllByRole('switch')).toEqual([]);
      expect(panel().textContent).not.toMatch(/自動/);
    });
  }
});

describe("the author's own suggestions", () => {
  it('while pending they can be edited or withdrawn', async () => {
    const mine = makeSuggestion({ id: 'sug_m', sessionId: 'sess_host', text: '原本的建議' });
    const { conn } = await renderPanel('editor', { suggestions: [mine] });
    const list = within(panel()).getByRole('region', { name: '我提出的建議' });
    fireEvent.click(within(list).getByRole('button', { name: '編輯' }));
    fireEvent.change(within(list).getByLabelText('修改我的建議'), { target: { value: '改過的建議' } });
    await act(async () => {
      fireEvent.click(within(list).getByRole('button', { name: '儲存修改' }));
    });
    expect(conn.lastRequest('suggest.edit')?.payload).toEqual({ suggestionId: 'sug_m', text: '改過的建議' });
    await act(async () => {
      conn.respond('suggest.edit', { suggestion: { ...mine, text: '改過的建議' } });
    });
    await act(async () => {
      fireEvent.click(within(list).getByRole('button', { name: '撤回' }));
    });
    expect(conn.lastRequest('suggest.withdraw')?.payload).toEqual({ suggestionId: 'sug_m' });
    await act(async () => {
      conn.respond('suggest.withdraw', { suggestion: { ...mine, text: '改過的建議', status: 'withdrawn', resolvedAt: 3 } });
    });
    expect(list.textContent).toContain('已撤回');
    expect(within(list).queryByRole('button', { name: '編輯' })).toBeNull();
  });

  it('afterwards they show the outcome: the text actually sent, or the reason for a rejection', async () => {
    const modified = makeSuggestion({ id: 'sug_1', sessionId: 'sess_host', text: '原文', status: 'accepted-modified', finalText: '主人修改後的內容', resolvedAt: 5 });
    const rejected = makeSuggestion({ id: 'sug_2', sessionId: 'sess_host', text: '另一則', status: 'rejected', rejectReason: '已經做過了', resolvedAt: 6, createdAt: 2 });
    await renderPanel('editor', { suggestions: [modified, rejected] });
    const list = within(panel()).getByRole('region', { name: '我提出的建議' });
    expect(list.textContent).toContain('修改後採用');
    expect(list.textContent).toContain('實際送出的內容：');
    expect(list.textContent).toContain('主人修改後的內容');
    expect(list.textContent).toContain('已拒絕');
    expect(list.textContent).toContain('原因：已經做過了');
    expect(within(list).queryByRole('button', { name: '撤回' })).toBeNull();
  });

  it('the author is notified when someone decides — not for what was already decided before', async () => {
    const pending = makeSuggestion({ id: 'sug_n', sessionId: 'sess_host', text: '請補測試' });
    const old = makeSuggestion({ id: 'sug_old', sessionId: 'sess_host', text: '舊的', status: 'accepted', resolvedAt: 1 });
    const { conn } = await renderPanel('editor', { suggestions: [pending, old] });
    expect(screen.queryByText(/你的建議已/)).toBeNull();
    await act(async () => {
      conn.emit('suggest.updated', { suggestion: { ...pending, status: 'rejected', rejectReason: '先不用', resolvedAt: 7 } });
    });
    const notices = within(screen.getByRole('region', { name: '通知' }));
    expect(notices.getByText('你的建議被拒絕了')).toBeTruthy();
    expect(notices.getByText(/原因：先不用/)).toBeTruthy();
    const second = makeSuggestion({ id: 'sug_n2', sessionId: 'sess_host', text: '第二則' });
    await act(async () => {
      conn.emit('suggest.updated', { suggestion: second });
    });
    await act(async () => {
      conn.emit('suggest.updated', { suggestion: { ...second, status: 'accepted-modified', finalText: '改寫', resolvedAt: 8 } });
    });
    expect(notices.getByText('你的建議已修改後採用')).toBeTruthy();
  });
});

describe('the editor selection action (R6 「一鍵把它作為建議送進別人的 session（或直接送進自己的 session）」)', () => {
  const selection = { file: { root: MAIN_ROOT, path: 'src/app.ts' }, startLine: 10, endLine: 12, text: 'function a() {\n  return 1;\n}' };

  it("a 可使用 agent member types it into ANY session (the host's too) as a bracketed paste, with no Enter", async () => {
    const { conn, session } = await renderPanel('agent', { sessions: [hostSession, amySession] });
    await act(async () => {
      await session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: 'sess_host' });
    });
    const inputs = conn.notificationsOf('exec.input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload.sessionId).toBe('sess_host');
    const typed = new TextDecoder().decode(inputs[0]!.payload.data);
    expect(typed).toBe('\x1b[200~function a() {\r  return 1;\r}\x1b[201~');
    expect(typed.endsWith('\r')).toBe(false);
    expect(conn.requestsOf('suggest.create')).toHaveLength(0);
  });

  it("an editor's selection becomes a suggestion draft (with the code reference) — nothing is sent yet", async () => {
    const { conn, session, stores } = await renderPanel('editor', { sessions: [hostSession, amySession], focus: 'sess_amy' });
    await act(async () => {
      await session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: 'sess_host' });
    });
    expect(stores.sessions.getState().focusedId).toBe('sess_host');
    const box = screen.getByLabelText('給 Ian 開的「Claude」的建議') as HTMLTextAreaElement;
    expect(box.value).toContain('src/app.ts 第 10–12 行：');
    expect(box.value).toContain('function a() {');
    expect(screen.getByText('附上的程式碼：src/app.ts 第 10–12 行')).toBeTruthy();
    expect(conn.requestsOf('suggest.create')).toHaveLength(0);
    expect(conn.notificationsOf('exec.input')).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '送出建議' }));
    });
    expect(conn.lastRequest('suggest.create')?.payload.source).toEqual({ file: selection.file, startLine: 10, endLine: 12 });
  });

  it("one click (mode 'send') creates an editor's suggestion at once, with the code reference (SPEC-08)", async () => {
    const { conn, session } = await renderPanel('editor', { sessions: [hostSession, amySession], focus: 'sess_amy' });
    await act(async () => {
      await session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: 'sess_host', mode: 'send' });
    });
    const request = conn.lastRequest('suggest.create');
    expect(request?.payload).toMatchObject({ sessionId: 'sess_host', source: { file: selection.file, startLine: 10, endLine: 12 } });
    expect(request?.payload.text).toContain('function a() {');
    expect(conn.notificationsOf('exec.input')).toEqual([]);
  });

  it('without a session it asks which one: a 可使用 agent member pastes into any of them, an editor suggests', async () => {
    const asAgent = await renderPanel('agent', { sessions: [hostSession, amySession] });
    await act(async () => {
      await asAgent.session.commands.dispatch('sendSelectionAsSuggestion', selection);
    });
    let dialog = screen.getByRole('dialog', { name: '把選取的程式碼送到 session' });
    expect(within(dialog).getAllByRole('radio').map((choice) => choice.closest('label')?.textContent)).toEqual([
      '貼到「我的 Claude」（不會自動按 Enter）',
      '貼到「Claude」（不會自動按 Enter）',
    ]);
    fireEvent.click(within(dialog).getAllByRole('radio')[1]!);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '繼續' }));
    });
    expect(asAgent.conn.notificationsOf('exec.input').map((n) => n.payload.sessionId)).toEqual(['sess_host']);
    asAgent.unmount();

    const { conn, session } = await renderPanel('editor', { sessions: [hostSession, amySession] });
    await act(async () => {
      await session.commands.dispatch('sendSelectionAsSuggestion', selection);
    });
    dialog = screen.getByRole('dialog', { name: '把選取的程式碼送到 session' });
    const choices = within(dialog).getAllByRole('radio');
    expect(choices.map((choice) => choice.closest('label')?.textContent)).toEqual(['作為建議送給 Amy 開的「我的 Claude」', '作為建議送給 Ian 開的「Claude」']);
    fireEvent.click(choices[1]!);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '繼續' }));
    });
    expect((screen.getByLabelText('給 Ian 開的「Claude」的建議') as HTMLTextAreaElement).value).toContain('function a()');
    expect(conn.notificationsOf('exec.input')).toEqual([]);
  });

  it("a viewer cannot turn a selection into a suggestion for someone else's session", async () => {
    const { conn, session } = await renderPanel('viewer');
    await act(async () => {
      await session.commands.dispatch('sendSelectionAsSuggestion', { ...selection, sessionId: 'sess_host' });
    });
    expect(screen.getByText('你的角色不能提出建議。')).toBeTruthy();
    expect(conn.notificationsOf('exec.input')).toEqual([]);
    expect(conn.requestsOf('suggest.create')).toHaveLength(0);
  });
});
