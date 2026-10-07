// The conversation column in Traditional Chinese: the strip, the rows, the three cards, the status bar and the
// composer speak zh-TW (role labels and the daemon's lines from the wire catalogue), and what people and agents
// wrote stays as it was written.
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SmurgError, type ConversationEvent } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildEvent, buildPermission, buildQuestion, buildSuggestion, FAKE_NOW } from '@smurg/protocol/testing';
import { useTestLocale } from '../../testing/locale.ts';
import { AMY, IAN, MEI, SID, openConversation, settle } from './test-support.tsx';

useTestLocale('zh-TW');

const events: ConversationEvent[] = [
  { ...buildEvent('line', { seq: 1 }), text: msg('conversation.started.free', { name: 'Ian' }), fallback: 'Ian opened this session' },
  buildEvent('message', { seq: 2, messageId: 'm_1', from: { ...AMY, role: 'editor' }, text: 'Use the session store', suggestion: { id: 'sg_0', acceptedBy: IAN, modified: false } }),
  buildEvent('turn.started', { seq: 3, turnId: 't_1' }),
  buildEvent('text', { seq: 4, turnId: 't_1', blockId: 'b_1', text: 'I will look at the cart first.' }),
  buildEvent('tool.started', { seq: 5, turnId: 't_1', toolUseId: 'tu_1', tool: { name: 'Bash', verb: 'run', target: 'pnpm test' } }),
  buildEvent('card', { seq: 6, card: 'question', id: 'q_1' }),
  buildEvent('card', { seq: 7, card: 'permission', id: 'pr_1' }),
  buildEvent('card', { seq: 8, card: 'suggestion', id: 'sg_1' }),
];

describe('conversation column in zh-TW', () => {
  it('a member with agent access reads and answers in Chinese', async () => {
    await openConversation({
      role: 'agent',
      session: { status: 'waiting-permission', waitingSince: FAKE_NOW, responsible: MEI },
      events,
      reply: {
        questions: [buildQuestion({ id: 'q_1', sessionId: SID, decider: MEI, eligible: 3, votes: [{ ...AMY, part: 0, options: [0], at: FAKE_NOW }] })],
        permissions: [buildPermission({ id: 'pr_1', sessionId: SID })],
        suggestions: [buildSuggestion({ id: 'sg_1', sessionId: SID, author: AMY })],
      },
    });
    const strip = screen.getByRole('group', { name: '這個 session 的資訊' });
    expect(within(strip).getByRole('button', { name: '負責人：Mei（你）' })).toBeTruthy();
    expect(within(strip).getByText('主工作區')).toBeTruthy();
    expect(within(strip).getByText('編輯和執行指令前都先問')).toBeTruthy();
    expect(within(strip).getByRole('button', { name: '停止' })).toBeTruthy();

    const log = screen.getByRole('log', { name: '對話：Claude (Ian)' });
    expect(within(log).getByText('Ian 開啟了這個 session', { exact: false })).toBeTruthy();
    const message = log.querySelector('.conv-msg') as HTMLElement;
    expect(message.textContent).toContain('可編輯');
    expect(message.textContent).toContain('建議，由 Ian 採用');
    // What people and agents wrote is never translated.
    expect(message.textContent).toContain('Use the session store');
    expect(within(log).getByText('I will look at the cart first.')).toBeTruthy();
    // The command waits at its permission card (below): its line does not say that it runs.
    expect(log.querySelector('details.conv-tool summary')?.textContent).toContain('指令');
    expect(log.querySelector('details.conv-tool summary')?.textContent).toContain('等待許可');
    expect(log.querySelector('details.conv-tool summary')?.textContent).not.toContain('執行');

    const question = document.getElementById('conv-card-q_1') as HTMLElement;
    expect(within(question).getByRole('heading', { name: 'Claude 的選擇題' })).toBeTruthy();
    expect(question.textContent).toContain('3 人中 1 人已投票');
    expect(within(question).getByRole('radiogroup', { name: '你的投票' })).toBeTruthy();
    expect(question.textContent).toContain('領先');
    expect(question.textContent).toContain('由你決定：你是這個 session 的負責人。');
    expect(question.textContent).toContain('留言是給團隊看的，Claude 不會讀。');
    expect(within(question).getByRole('button', { name: '送出答案' })).toBeTruthy();
    expect(within(question).getByRole('textbox', { name: '給 Claude 的備註（選填）' })).toBeTruthy();
    expect(question.textContent).toContain('Where is the cart kept?');

    const permission = document.getElementById('conv-card-pr_1') as HTMLElement;
    expect(within(permission).getByRole('heading', { name: 'Claude 請求許可執行指令' })).toBeTruthy();
    expect(within(permission).getByRole('button', { name: '允許一次' })).toBeTruthy();
    expect(within(permission).getByRole('button', { name: '一律允許這類' })).toBeTruthy();
    fireEvent.click(within(permission).getByRole('button', { name: '拒絕' }));
    expect(within(permission).getByRole('textbox', { name: 'Claude 應該改做什麼？（選填）' })).toBeTruthy();
    expect(permission.textContent).toContain('它在你的收件夾裡：你是負責人。');
    expect(permission.querySelector('.conv-perm__cmd')?.textContent).toBe('pnpm test');

    const suggestion = document.getElementById('conv-card-sg_1') as HTMLElement;
    expect(within(suggestion).getByRole('heading', { name: 'Amy 的建議' })).toBeTruthy();
    expect(within(suggestion).getByRole('button', { name: '採用' })).toBeTruthy();
    expect(within(suggestion).getByRole('button', { name: '修改後採用' })).toBeTruthy();

    const status = document.querySelector('.conv-status') as HTMLElement;
    expect(status.textContent).toContain('Claude 正在等待許可');
    expect(within(status).getByRole('button', { name: '顯示' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '傳訊息給 Claude · Claude (Ian)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '傳送' })).toBeTruthy();
  });

  it('sentences in one line stand without a gap, a turn-end line has no full stop before its time, and waiting counts beside the sentence', async () => {
    const view = await openConversation({
      role: 'agent',
      session: { status: 'stalled', purpose: 'item', topicId: 't_1', topicName: 'Checkout', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, attempt: 1 },
      events: [buildEvent('turn.started', { seq: 1, turnId: 't_1' }), buildEvent('turn.finished', { seq: 2, turnId: 't_1', outcome: 'interrupted', stoppedBy: IAN, durationMs: 2_000 })],
    });
    const status = document.querySelector('.conv-status') as HTMLElement;
    const sentences = (): string[] => within(status).getAllByRole('status').map((node) => node.textContent ?? '');
    // The same words as the plan's badge and the inbox row ("stopped without a report").
    expect(sentences()[0]).toBe('沒寫報告就停下了。');

    act(() => view.conn.emit('session.host', { account: { state: 'usage-limit', sessions: 1 }, mainProjectSettings: 'none' }));
    fireEvent.click(within(status).getByRole('button', { name: '繼續' }));
    act(() => {
      view.conn.fail('plan.item.continue', new SmurgError('conflict', 'not now'));
    });
    await settle();
    // Two sentences of one line: a full-width full stop is followed by the next sentence, not by a space.
    expect(sentences()[1]).toMatch(/^主人的 Claude 帳號已達用量上限。沒有成功：/);
    for (const sentence of sentences()) expect(sentence).not.toContain('。 ');

    const line = screen.getByRole('log').querySelector('.conv-sys[data-outcome="interrupted"]') as HTMLElement;
    expect(line.textContent).toMatch(/^Ian 停止了 agent · /);

    // While it waits, the sentence is what is spoken; the age stands beside it.
    act(() => view.conn.emit('session.state', { session: { ...view.agentSession, status: 'waiting-permission', waitingSince: Date.now() - 6 * 60_000 - 5_000 } }));
    expect(sentences()[0]).toBe('Claude 正在等待許可');
    expect(status.querySelector('.conv-status__age')?.textContent).toBe('· 6 分鐘');
  });

  it('a sentence that follows another inside a card or a notice stands without a gap too (review R2-C, third round)', async () => {
    // Whoever decides a question nobody has voted on yet: nearly every new question, for its decider.
    const nobody = await openConversation({
      role: 'agent',
      session: { status: 'waiting-answer', waitingSince: FAKE_NOW, responsible: MEI },
      events: [buildEvent('card', { seq: 1, card: 'question', id: 'q_1' })],
      reply: { questions: [buildQuestion({ id: 'q_1', sessionId: SID, decider: MEI, eligible: 3, votes: [] })] },
    });
    const who = (): string => (document.getElementById('conv-card-q_1') as HTMLElement).querySelector('.conv-card__who')?.textContent ?? '';
    expect(who()).toBe('由你決定：你是這個 session 的負責人。還沒有人投票，你仍然可以選擇並送出。');
    nobody.unmount();

    const tied = await openConversation({
      role: 'agent',
      session: { status: 'waiting-answer', waitingSince: FAKE_NOW, responsible: MEI },
      events: [buildEvent('card', { seq: 1, card: 'question', id: 'q_1' })],
      reply: {
        questions: [
          buildQuestion({
            id: 'q_1',
            sessionId: SID,
            decider: MEI,
            eligible: 3,
            votes: [
              { ...AMY, part: 0, options: [0], at: FAKE_NOW },
              { ...IAN, part: 0, options: [1], at: FAKE_NOW },
            ],
          }),
        ],
      },
    });
    expect(who()).toBe('由你決定：你是這個 session 的負責人。票數相同，請你自己選擇答案。');
    tied.unmount();

    // A notice whose action only the host may take, read by someone else: the notice, then who can.
    await openConversation({
      role: 'agent',
      session: { status: 'failed', retryHostOnly: true },
      events: [{ ...buildEvent('notice', { seq: 1, level: 'error', action: 'retry' }), text: msg('notice.processExited', { code: 1 }), fallback: "The agent's process ended unexpectedly (exit code 1)." } as ConversationEvent],
    });
    expect(screen.getByRole('log').querySelector('.conv-notice')?.textContent).toContain('agent 的程序意外結束（結束代碼 1）只有主人可以再試一次。');
  });

  it('a permission request that smurg\u2019s own gate asked for says why in Chinese, not in the English sentence the daemon sent', async () => {
    const english = "smurg asks because this folder's Claude Code project settings run scripts, and smurg cannot tell whether this command leaves them alone.";
    for (const [gate, sentence] of [
      ['writes-settings-script', 'smurg 會先問，是因為這個指令會更動這個資料夾的 Claude Code 專案設定所執行的腳本所在的位置（腳本本身，或放腳本的資料夾）。這些腳本會以主人的身分執行。'],
      ['may-reach-settings-script', 'smurg 會先問，是因為這個資料夾的 Claude Code 專案設定會執行腳本，而 smurg 無法確定這個指令不會動到它們。'],
    ] as const) {
      const view = await openConversation({
        role: 'host',
        session: { status: 'waiting-permission', waitingSince: FAKE_NOW },
        events: [buildEvent('card', { seq: 1, card: 'permission', id: 'pr_1' })],
        reply: { permissions: [buildPermission({ id: 'pr_1', sessionId: SID, command: 'make build', gate, reason: english })] },
      });
      const card = document.getElementById('conv-card-pr_1') as HTMLElement;
      expect(card.querySelector('.conv-card__who--gate')?.textContent, gate).toBe(sentence);
      expect(card.textContent).not.toContain('smurg asks because');
      expect(card.textContent).not.toContain('Claude Code 的理由');
      view.unmount();
    }
  });

  it('an Editor suggests and a viewer watches, in Chinese', async () => {
    const editor = await openConversation({ role: 'editor', events: events.slice(0, 2) });
    expect(screen.getByRole('combobox', { name: '向 Claude 提出建議 · Claude (Ian)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '送出建議' })).toBeTruthy();
    // Two names read "Ian 和 Mei": a space sets the Chinese word apart from Latin names (the house style).
    expect(screen.getByText('會以建議的形式送給 Ian 和 Mei，採用之後才會送給 agent。')).toBeTruthy();
    editor.unmount();

    await openConversation({ role: 'viewer', session: { status: 'ended', endedAt: FAKE_NOW } });
    expect(screen.getByText('這個 session 已結束，不再接受訊息。')).toBeTruthy();
    expect(screen.getByText('這個 session 已結束。')).toBeTruthy();
  });
});
