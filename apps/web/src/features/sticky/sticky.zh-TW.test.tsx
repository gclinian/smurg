// The sticky notes in Traditional Chinese (DESIGN 0.8.0 D7): the list's words, the open note's, the pages without a
// note. A note's name is a file's name and is never translated: `Home` is Home in both languages (D1.1).
import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAgentLock } from '../../testing/fixtures.ts';
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
    await shown({ notes: [{ name: 'Home', links: ['Broken'] }, { name: 'Broken', links: [], unreadable: true }, { name: 'home', links: [], shadowed: true }], texts: { Home: '' } });
    expect(note().textContent).toContain('這張便利貼是空的。');
    expect(within(list()).getByRole('treeitem', { name: 'Broken，無法讀取' })).toBeTruthy();
    expect(within(list()).getByRole('treeitem', { name: 'home，沒有讀取：和「Home」同名' })).toBeTruthy();
  });
});
