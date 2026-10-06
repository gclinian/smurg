// The left column of the sessions view (UX §3, §7, §11; DESIGN §5.12 items 1–9): the inbox, the session tree, the
// rail, the "New" control and the filter; the banners and the notices they give the rest of the screen.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SmurgError } from '@smurg/protocol';
import { buildAgentSession, buildInboxItem, buildPlan, buildReportSummary, buildTopic, buildWorkItem } from '@smurg/protocol/testing';
import { describe, expect, it, vi } from 'vitest';
import { InboxPreview } from './InboxList.tsx';
import { InboxNotices, ShellBanners } from './Notices.tsx';
import { CART, DISCUSSION, FREE, IAN, MEI, PAY, SEARCH, TERMINAL, TOPIC, mountSidebar } from './test-support.tsx';

const NOW = Date.now();
const ago = (minutes: number): number => NOW - minutes * 60_000;

const INBOX = [
  buildInboxItem('question', { excerpt: 'Where should the cart total be computed?', topicId: 'tp_1', voted: 3, eligible: 4, at: ago(6) }),
  buildInboxItem('permission', { key: 'permission:pr_1', excerpt: 'pnpm test --filter cart', sessionId: 's_free', anchor: { cardId: 'pr_1' }, target: { kind: 'session', sessionId: 's_free' }, at: ago(1), unread: false }),
  buildInboxItem('report', { at: ago(12) }),
  buildInboxItem('mention', { from: { kind: 'user', ...MEI }, excerpt: 'A plus a cache would cover it', topicId: 'tp_1', at: ago(4) }),
];

const inboxSection = (): HTMLElement => screen.getByRole('region', { name: 'Inbox' });
const sessionsSection = (): HTMLElement => screen.getByRole('region', { name: 'Sessions' });
const treeitem = (name: string | RegExp): HTMLElement => screen.getByRole('treeitem', { name });
/** A row of the topic "Checkout redesign" (the other topic has a Spec and a Plan row too). */
const inCheckout = (name: string | RegExp): HTMLElement => within(treeitem(/^Checkout redesign/)).getByRole('treeitem', { name });

describe('the left column', () => {
  it('is the landmark "Inbox and sessions": the inbox above the session list, both collapsible', async () => {
    await mountSidebar({ inbox: INBOX });
    const aside = screen.getByRole('complementary', { name: 'Inbox and sessions' });
    const sections = within(aside).getAllByRole('region').map((region) => region.getAttribute('aria-labelledby') && within(region).getAllByRole('heading')[0]?.textContent);
    expect(sections.map((text) => text?.replace(/\d.*$/, ''))).toEqual(['Inbox', 'Sessions']);
    const inboxToggle = within(inboxSection()).getByRole('button', { name: /^Inbox/ });
    await userEvent.click(inboxToggle);
    expect(inboxToggle.getAttribute('aria-expanded')).toBe('false');
    // Collapsed, the header and the counts stay.
    expect(inboxToggle.textContent).toContain('2 waiting, 2 to look at');
    const sessionsToggle = within(sessionsSection()).getByRole('button', { name: 'Sessions' });
    await userEvent.click(sessionsToggle);
    expect(sessionsToggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(sessionsSection()).getByRole('button', { name: 'New' })).toBeTruthy();
  });

  it('the two counts: what agents are stopped on in amber, the rest neutral, and both in words', async () => {
    await mountSidebar({ inbox: INBOX });
    const counts = inboxSection().querySelector('.inbox-counts') as HTMLElement;
    expect(counts.querySelector('[data-count="waiting"]')?.textContent).toBe('2');
    expect(counts.querySelector('[data-count="waiting"]')?.className).toContain('ui-count--waiting');
    expect(counts.querySelector('[data-count="look"]')?.textContent).toBe('2');
    expect(counts.textContent).toContain('2 waiting, 2 to look at');
  });

  it('folded to its rail: three buttons with the counts; a button unfolds the column', async () => {
    await mountSidebar({ inbox: INBOX, collapsed: true });
    const rail = document.querySelector('.sidebar-rail') as HTMLElement;
    expect(rail.hidden).toBe(false);
    expect((document.querySelector('.sidebar-sections') as HTMLElement).hidden).toBe(true);
    expect(within(rail).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Inbox: 2 waiting, 2 to look at', 'Sessions', 'New topic']);
    expect(rail.querySelector('.sidebar-rail__count--waiting')?.textContent).toBe('2');
    await userEvent.click(within(rail).getByRole('button', { name: 'Sessions' }));
    expect((document.querySelector('.sidebar-sections') as HTMLElement).hidden).toBe(false);
    expect(rail.hidden).toBe(true);
  });

  it('the rail shows the neutral count when nothing waits, and none when the inbox is empty', async () => {
    const view = await mountSidebar({ inbox: [buildInboxItem('report')], collapsed: true });
    const rail = document.querySelector('.sidebar-rail') as HTMLElement;
    expect(rail.querySelector('.sidebar-rail__count')?.textContent).toBe('1');
    expect(rail.querySelector('.sidebar-rail__count--waiting')).toBeNull();
    act(() => view.conn.emit('inbox.changed', { upsert: [], remove: ['report:tp_1.cart-api'] }));
    expect(rail.querySelector('.sidebar-rail__count')).toBeNull();
  });
});

describe('the inbox', () => {
  it('two groups in order, a row per thing: kind, sentence, where it is, how long it waits', async () => {
    await mountSidebar({ inbox: INBOX });
    const inbox = inboxSection();
    expect(within(inbox).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Agents are waiting2', 'For you to look at2']);
    const waiting = within(inbox).getByRole('list', { name: /Agents are waiting/ });
    const rows = within(waiting).getAllByRole('listitem');
    // Oldest first.
    expect(rows.map((row) => row.querySelector('.inbox-item__title')?.textContent)).toEqual(['Where should the cart total be computed?', 'pnpm test --filter cart']);
    expect(rows[0]?.querySelector('.inbox-item__where')?.textContent).toBe('Checkout redesign › 1 · Cart API · 3 of 4 voted');
    expect(rows[0]?.querySelector('.inbox-item__age')?.textContent).toBe('6 min');
    expect(within(rows[0] as HTMLElement).getByRole('img', { name: 'Question' })).toBeTruthy();
    // A command is shown as one.
    expect(rows[1]?.querySelector('.inbox-item__title')?.className).toContain('inbox-item__title--mono');
    expect(rows[1]?.querySelector('.inbox-item__where')?.textContent).toBe('No topic › Fix flaky CI test');
    // Unread: marked, and said.
    expect(rows[0]?.hasAttribute('data-unread')).toBe(true);
    expect(rows[1]?.hasAttribute('data-unread')).toBe(false);
    expect(within(rows[0] as HTMLElement).getByRole('button').getAttribute('aria-label')).toBe('Question, new: Where should the cart total be computed?. Checkout redesign › 1 · Cart API · 3 of 4 voted. 6 min');
    const look = within(inbox).getByRole('list', { name: /For you to look at/ });
    // Newest first.
    expect(within(look).getAllByRole('listitem').map((row) => row.querySelector('.inbox-item__title')?.textContent)).toEqual(['Mei mentioned you: A plus a cache would cover it', 'Result report: 1 · Cart API']);
  });

  it('a click opens what the item is about, at its card, and marks it seen', async () => {
    const view = await mountSidebar({ inbox: INBOX });
    await userEvent.click(within(inboxSection()).getByRole('button', { name: /Where should the cart total be computed/ }));
    expect(view.opened).toHaveBeenLastCalledWith({ target: { kind: 'session', sessionId: 'sess_a' }, from: 'inbox', anchor: { cardId: 'q_1' } });
    expect(view.conn.notificationsOf('inbox.seen').map((n) => n.payload)).toEqual([{ keys: ['question:q_1'] }]);
    expect(document.querySelector('[data-inbox-key="question:q_1"]')?.hasAttribute('data-unread')).toBe(false);
    // The report opens the report column; Shift opens to the side.
    fireEvent.click(within(inboxSection()).getByRole('button', { name: /Result report: 1 · Cart API/ }), { shiftKey: true });
    expect(view.opened).toHaveBeenLastCalledWith({ target: { kind: 'report', topicId: 'tp_1', itemId: 'cart-api' }, from: 'inbox', side: true });
  });

  it('one tab stop for the list: Up, Down, Home and End move between rows; Shift+Enter opens to the side', async () => {
    const view = await mountSidebar({ inbox: INBOX });
    const buttons = [...inboxSection().querySelectorAll<HTMLButtonElement>('.inbox-item__main')];
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1]);
    act(() => buttons[0]?.focus());
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1, -1]);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(buttons[3]);
    await userEvent.keyboard('{ArrowDown}{Home}{ArrowUp}');
    expect(document.activeElement).toBe(buttons[0]);
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(view.opened).toHaveBeenLastCalledWith(expect.objectContaining({ target: { kind: 'session', sessionId: 'sess_a' }, side: true }));
    await userEvent.keyboard('{Enter}');
    expect(view.opened).toHaveBeenLastCalledWith({ target: { kind: 'session', sessionId: 'sess_a' }, from: 'inbox', anchor: { cardId: 'q_1' } });
  });

  it('the row whose target the focused column shows is the current one', async () => {
    const view = await mountSidebar({ inbox: INBOX });
    act(() => void view.stores.columns.open({ kind: 'session', sessionId: 'sess_a' }));
    const row = document.querySelector('[data-inbox-key="question:q_1"]') as HTMLElement;
    expect(row.hasAttribute('data-current')).toBe(true);
    expect(within(row).getByRole('button').getAttribute('aria-current')).toBe('true');
    expect(document.querySelector('[data-inbox-key="permission:pr_1"]')?.hasAttribute('data-current')).toBe(false);
  });

  it('a row\'s own action does its one thing without opening the item; a refusal is said', async () => {
    const stalled = buildInboxItem('attention', { topicId: 'tp_1', at: ago(4) });
    const view = await mountSidebar({ inbox: [stalled] });
    const row = document.querySelector('[data-inbox-key="attention:item-stalled:tp_1.cart-api"]') as HTMLElement;
    expect(row.querySelector('.inbox-item__title')?.textContent).toBe('1 · Cart API stopped without a report');
    await userEvent.click(within(row).getByRole('button', { name: 'Continue' }));
    expect(view.conn.lastRequest('plan.item.continue')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api' });
    expect(view.opened).not.toHaveBeenCalled();
    act(() => void view.conn.fail('plan.item.continue', new SmurgError('conflict', 'The item has no session.')));
    expect(await screen.findByText(/That did not work:/)).toBeTruthy();
  });

  it('a mention can be dismissed; an item that is already gone is not an error; what waits has no such button', async () => {
    const view = await mountSidebar({ inbox: INBOX });
    const mention = document.querySelector('[data-inbox-key="mention:nt_1"]') as HTMLElement;
    await userEvent.click(within(mention).getByRole('button', { name: 'Dismiss: Mei mentioned you: A plus a cache would cover it' }));
    expect(view.conn.lastRequest('inbox.dismiss')?.payload).toEqual({ key: 'mention:nt_1' });
    act(() => void view.conn.fail('inbox.dismiss', new SmurgError('not_found', 'This item is no longer waiting.')));
    await Promise.resolve();
    expect(screen.queryByText(/That did not work/)).toBeNull();
    expect(within(document.querySelector('[data-inbox-key="question:q_1"]') as HTMLElement).queryByRole('button', { name: /Dismiss/ })).toBeNull();
  });

  it('a feature may change the row of a kind it knows better', async () => {
    await mountSidebar({
      inbox: INBOX,
      slots: [{ feature: 'conversation', inboxRows: { question: (item, base) => ({ ...base, where: `${base.where} · live`, action: { id: 'remind', label: 'Remind', run: () => {} } }) } }],
    });
    const row = document.querySelector('[data-inbox-key="question:q_1"]') as HTMLElement;
    expect(row.querySelector('.inbox-item__where')?.textContent).toBe('Checkout redesign › 1 · Cart API · 3 of 4 voted · live');
    expect(within(row).getByRole('button', { name: 'Remind' })).toBeTruthy();
  });

  it('empty: "Nothing is waiting for you."; a viewer is told what reaches them here', async () => {
    await mountSidebar();
    expect(inboxSection().textContent).toContain('Nothing is waiting for you.');
    expect(inboxSection().textContent).not.toContain('As a viewer');
    document.body.innerHTML = '';
    await mountSidebar({ role: 'viewer' });
    expect(inboxSection().textContent).toContain('Nothing is waiting for you. As a viewer you get only mentions here.');
  });

  it('the preview of the empty right side: the first things that wait, with "Open"', async () => {
    const view = await mountSidebar({ inbox: INBOX, ui: <InboxPreview limit={1} /> });
    const preview = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(preview).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(within(preview).getByRole('button', { name: 'Open: Where should the cart total be computed?' }));
    expect(view.opened).toHaveBeenCalledWith({ target: { kind: 'session', sessionId: 'sess_a' }, from: 'inbox', anchor: { cardId: 'q_1' } });
  });

  it('the preview shows nothing while nothing is in the inbox', async () => {
    await mountSidebar({ ui: <InboxPreview /> });
    expect(screen.queryByRole('region', { name: 'Waiting for you' })).toBeNull();
  });
});

describe('the session list', () => {
  it('is a tree: topics with their phase as groups, their fixed rows and sessions inside, "No topic" last', async () => {
    await mountSidebar();
    const tree = screen.getByRole('tree', { name: 'Sessions by topic' });
    expect(within(tree).getAllByRole('treeitem').filter((item) => item.getAttribute('aria-level') === '1').map((item) => item.getAttribute('aria-label'))).toEqual([
      'Checkout redesign, Executing',
      'Search filters, Discussing',
      'No topic',
    ]);
    const checkout = treeitem('Checkout redesign, Executing');
    expect(within(checkout).getAllByRole('treeitem').map((item) => item.querySelector('.srow__title')?.textContent)).toEqual(['Discussion', 'Spec', 'Plan', '1 · Cart API', '2 · Payment form']);
    // A row says its status, who is responsible and what else there is to know, in words.
    expect(treeitem(/^1 · Cart API/).getAttribute('aria-label')).toBe('1 · Cart API, Waiting for an answer, Responsible: Ian');
    expect(treeitem(/^Discussion/).getAttribute('aria-label')).toBe('Discussion, Idle, No one is responsible: everyone watches');
    expect(inCheckout(/^Plan/).getAttribute('aria-label')).toBe('Plan, 0 of 6 reviewed');
    expect(within(treeitem(/^Search filters/)).getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'))).toEqual(['Spec, not written yet', 'Plan, no plan yet']);
    expect(treeitem('Terminal (Ian)')).toBeTruthy();
    // A tree item holds no control.
    expect(tree.querySelectorAll('button, a, input')).toHaveLength(0);
    expect(within(treeitem(/^1 · Cart API/)).getByRole('img', { name: 'Waiting for an answer' })).toBeTruthy();
  });

  it('a click opens the row in the focused column; Shift+click and Shift+Enter open it to the side', async () => {
    const view = await mountSidebar();
    await userEvent.click(screen.getByText('1 · Cart API'));
    expect(view.opened).toHaveBeenLastCalledWith({ target: { kind: 'session', sessionId: 'sess_a' }, from: 'row' });
    fireEvent.click(within(inCheckout(/^Spec/)).getByText('Spec'), { shiftKey: true });
    expect(view.opened).toHaveBeenLastCalledWith({ target: { kind: 'spec', topicId: 'tp_1' }, from: 'row', side: true });
    act(() => inCheckout(/^Plan/).focus());
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(view.opened).toHaveBeenLastCalledWith({ target: { kind: 'plan', topicId: 'tp_1' }, from: 'row', side: true });
    await userEvent.keyboard('{Enter}');
    expect(view.opened).toHaveBeenLastCalledWith({ target: { kind: 'plan', topicId: 'tp_1' }, from: 'row' });
  });

  it('the mark that appears on hover opens to the side without activating the row', async () => {
    const view = await mountSidebar();
    const side = treeitem(/^2 · Payment form/).querySelector('.srow__side') as HTMLElement;
    expect(side.getAttribute('aria-hidden')).toBe('true');
    await userEvent.click(side);
    expect(view.opened).toHaveBeenCalledTimes(1);
    expect(view.opened).toHaveBeenLastCalledWith({ target: { kind: 'session', sessionId: 's_pay' }, from: 'row', side: true });
  });

  it('shows what is open in a column, what the focused column shows, and what is new since this browser looked', async () => {
    const view = await mountSidebar();
    act(() => {
      view.stores.columns.open({ kind: 'session', sessionId: 'sess_a' });
      view.stores.columns.open({ kind: 'plan', topicId: 'tp_1' }, { side: true });
    });
    const row = (name: RegExp): HTMLElement => inCheckout(name).querySelector('.ui-tree__row') as HTMLElement;
    expect(row(/^1 · Cart API/).hasAttribute('data-open-in')).toBe(true);
    expect(row(/^Plan/).hasAttribute('data-open-in')).toBe(true);
    expect(row(/^2 · Payment form/).hasAttribute('data-open-in')).toBe(false);
    expect(inCheckout(/^Plan/).getAttribute('aria-selected')).toBe('true');
    expect(treeitem(/^1 · Cart API/).getAttribute('aria-selected')).toBe('false');
    expect(treeitem(/^1 · Cart API/).getAttribute('aria-label')).toContain('open in a column');
    // Something noteworthy happens in a session nobody has open: its row turns bold, and says so.
    act(() => view.conn.emit('session.state', { session: { ...PAY, noteworthyAt: Date.now() + 60_000 } }));
    expect(row(/^2 · Payment form/).hasAttribute('data-unread')).toBe(true);
    expect(treeitem(/^2 · Payment form/).getAttribute('aria-label')).toContain('something happened since you last looked');
  });

  it('an unfolded topic with a plan gets its plan: one row per work item, a report mark that opens the report', async () => {
    const items = [
      buildWorkItem({ id: 'cart-api', number: 1, title: 'Cart API', state: 'running', sessionId: 'sess_a', attempt: 1 }),
      buildWorkItem({ id: 'pay', number: 2, title: 'Payment form', state: 'done', sessionId: 's_pay', attempt: 1, report: buildReportSummary() }),
      buildWorkItem({ id: 'receipt', number: 3, title: 'Receipt email', state: 'waiting', responsible: { ...MEI, source: 'agent' } }),
    ];
    const view = await mountSidebar({ plans: { tp_1: buildPlan({ topicId: 'tp_1', items }) } });
    expect(view.conn.requestsOf('plan.get').map((request) => request.payload)).toEqual([{ topicId: 'tp_1' }]);
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /^3 · Receipt email/ })).toBeTruthy());
    expect(treeitem(/^3 · Receipt email/).getAttribute('aria-label')).toBe('3 · Receipt email, Waiting for another item, Responsible: Mei');
    expect(treeitem(/^2 · Payment form/).getAttribute('aria-label')).toContain('its result report waits for review');
    // An item that has not started opens the plan.
    await userEvent.click(screen.getByText('3 · Receipt email'));
    expect(view.opened).toHaveBeenLastCalledWith({ target: { kind: 'plan', topicId: 'tp_1' }, from: 'row' });
    await userEvent.click(treeitem(/^2 · Payment form/).querySelector('.srow__report') as HTMLElement);
    expect(view.opened).toHaveBeenLastCalledWith({ target: { kind: 'report', topicId: 'tp_1', itemId: 'pay' }, from: 'row', side: true });
  });

  it('a folded topic says how many of its rows wait, with the most urgent status; the fold is remembered', async () => {
    const view = await mountSidebar();
    await userEvent.click(screen.getByText('Checkout redesign'));
    const checkout = treeitem(/^Checkout redesign/);
    expect(checkout.getAttribute('aria-expanded')).toBe('false');
    expect(checkout.getAttribute('aria-label')).toBe('Checkout redesign, Executing, 1 waiting');
    expect(checkout.querySelector('.topic__wait')?.textContent).toContain('1 waiting');
    expect(within(checkout).getByRole('img', { name: 'Waiting for an answer' })).toBeTruthy();
    expect(view.stores.columns.getState().groupOpen).toEqual({ 'topic:tp_1': false });
    // Right unfolds it again; unfolded, the rows say it themselves.
    act(() => checkout.focus());
    await userEvent.keyboard('{ArrowRight}');
    expect(checkout.getAttribute('aria-expanded')).toBe('true');
    expect(checkout.querySelector('.topic__wait')).toBeNull();
  });

  it('the filter: All, Mine, Waiting', async () => {
    const view = await mountSidebar();
    const filter = within(sessionsSection()).getByRole('radiogroup', { name: 'Show' });
    expect(within(filter).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['All', 'Mine', 'Waiting']);
    await userEvent.click(within(filter).getByRole('radio', { name: 'Waiting' }));
    expect(view.stores.columns.getState().filter).toBe('waiting');
    expect(screen.getAllByRole('treeitem').filter((item) => item.getAttribute('aria-level') === '2').map((item) => item.querySelector('.srow__title')?.textContent)).toEqual(['1 · Cart API', 'Fix flaky CI test']);
    await userEvent.click(within(filter).getByRole('radio', { name: 'Mine' }));
    expect(screen.getAllByRole('treeitem').filter((item) => item.getAttribute('aria-level') === '2').map((item) => item.querySelector('.srow__title')?.textContent)).toEqual(['Discussion', '1 · Cart API', 'Terminal (Ian)']);
  });

  it('a filter that hides everything says so; a workspace without anything says "No topics yet."', async () => {
    const view = await mountSidebar({ sessions: [DISCUSSION], topics: [TOPIC] });
    act(() => view.stores.columns.setFilter('waiting'));
    expect(sessionsSection().textContent).toContain('Nothing matches this filter.');
    document.body.innerHTML = '';
    await mountSidebar({ sessions: [], topics: [] });
    expect(sessionsSection().textContent).toContain('No topics yet.');
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('the context menu of a row: Open, Open to the side, and what the features add', async () => {
    const renamed = vi.fn();
    const view = await mountSidebar({
      slots: [
        { feature: 'conversation', menus: { session: (session) => (session.kind === 'agent' ? [{ id: 'rename', label: 'Rename', onSelect: () => renamed(session.id) }] : []) } },
        { feature: 'agents', menus: { session: () => [{ id: 'end', label: 'End session', danger: true, onSelect: () => {} }] } },
      ],
    });
    fireEvent.contextMenu(screen.getByText('1 · Cart API'), { clientX: 30, clientY: 200 });
    const menu = screen.getByRole('menu', { name: 'Actions for 1 · Cart API' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Open', 'Open to the side', 'Rename', 'End session']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    expect(renamed).toHaveBeenCalledWith('sess_a');
    expect(screen.queryByRole('menu')).toBeNull();
    // The focus is back on the row the menu was for.
    expect(document.activeElement).toBe(treeitem(/^1 · Cart API/));
    // By keyboard, and for a row that is not a session: only the shell's own items.
    act(() => inCheckout(/^Spec/).focus());
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    const specMenu = screen.getByRole('menu', { name: 'Actions for Spec' });
    expect(within(specMenu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Open', 'Open to the side']);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(view.opened).toHaveBeenLastCalledWith({ target: { kind: 'spec', topicId: 'tp_1' }, from: 'row', side: true });
  });

  it('a topic\'s "More actions": watch its running sessions side by side, and what the features add', async () => {
    const archive = vi.fn();
    const view = await mountSidebar({ slots: [{ feature: 'topics', menus: { topic: (topic) => [{ id: 'archive', label: 'Archive topic', onSelect: () => archive(topic.id) }] } }] });
    await userEvent.click(treeitem(/^Checkout redesign/).querySelector('.topic__more') as HTMLElement);
    // The mark is not the row: the topic did not fold.
    expect(treeitem(/^Checkout redesign/).getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'Actions for Checkout redesign' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Watch its running sessions side by side', 'Archive topic']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Watch its running sessions side by side' }));
    expect(view.opened.mock.calls.map(([payload]) => payload)).toEqual([
      { target: { kind: 'session', sessionId: 'sess_a' }, from: 'row' },
      { target: { kind: 'session', sessionId: 's_pay' }, from: 'row', side: true },
    ]);
    // A topic without a running item cannot be watched; "No topic" has no menu.
    fireEvent.contextMenu(screen.getByText('Search filters'), { clientX: 1, clientY: 1 });
    expect(screen.getByRole('menuitem', { name: 'Watch its running sessions side by side' }).getAttribute('aria-disabled')).toBe('true');
    await userEvent.keyboard('{Escape}');
    fireEvent.contextMenu(screen.getByText('No topic'), { clientX: 1, clientY: 1 });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(treeitem('No topic').querySelector('.topic__more')).toBeNull();
  });

  it('"Show archived topics" fetches them; unfolding one looks its sessions up', async () => {
    const view = await mountSidebar();
    const old = buildTopic({ id: 'tp_0', name: 'Old checkout', archived: true, spec: { exists: true } });
    await userEvent.click(within(sessionsSection()).getByRole('button', { name: 'Show archived topics' }));
    expect(view.conn.lastRequest('topic.list')?.payload).toEqual({ archived: true });
    await act(async () => {
      view.conn.respond('topic.list', { topics: [old], hasMore: false });
      await Promise.resolve();
    });
    const archived = await screen.findByRole('treeitem', { name: 'Archived: Old checkout' });
    expect(archived.getAttribute('aria-expanded')).toBe('false');
    expect(within(sessionsSection()).queryByRole('button', { name: 'Show archived topics' })).toBeNull();
    await userEvent.click(screen.getByText('Old checkout'));
    expect(view.conn.lastRequest('session.list')?.payload).toEqual({ topicId: 'tp_0' });
    await act(async () => {
      view.conn.respond('session.list', { sessions: [buildAgentSession({ id: 's_old', purpose: 'discussion', topicId: 'tp_0', status: 'ended' })], hasMore: false });
      await Promise.resolve();
    });
    expect(within(archived).getAllByRole('treeitem').map((item) => item.querySelector('.srow__title')?.textContent)).toEqual(['Spec', 'Discussion']);
  });
});

describe('"New"', () => {
  it('one control: New topic, New session, Terminal; each asks its feature', async () => {
    const view = await mountSidebar();
    const calls: string[] = [];
    view.session.commands.handle('newTopic', () => void calls.push('topic'));
    view.session.commands.handle('newSession', ({ kind }) => void calls.push(kind));
    for (const name of ['New topic', 'New session', 'Terminal']) {
      await userEvent.click(within(sessionsSection()).getByRole('button', { name: 'New' }));
      const menu = screen.getByRole('menu', { name: 'New topic, session or terminal' });
      expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['New topic', 'New session', 'Terminal']);
      await userEvent.click(within(menu).getByRole('menuitem', { name }));
    }
    expect(calls).toEqual(['topic', 'agent', 'terminal']);
  });

  it('stays for every role (the dialog explains who may); a build without the feature says so', async () => {
    await mountSidebar({ role: 'viewer' });
    await userEvent.click(within(sessionsSection()).getByRole('button', { name: 'New' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'New topic' }));
    expect(await screen.findByText('This cannot be opened in this build of smurg.')).toBeTruthy();
  });

  it('the rail\'s "New topic" asks for the same dialog', async () => {
    const view = await mountSidebar({ collapsed: true });
    const asked = vi.fn();
    view.session.commands.handle('newTopic', asked);
    await userEvent.click(screen.getByRole('button', { name: 'New topic' }));
    expect(asked).toHaveBeenCalledOnce();
  });
});

describe('banners above the columns', () => {
  const paused = { ...TOPIC, plan: { ...TOPIC.plan, paused: true } };
  const pausedRow = buildInboxItem('attention', { key: 'attention:plan-paused:tp_1', subject: 'plan-paused', topicId: 'tp_1', itemId: undefined, item: undefined, sessionId: undefined, count: 4, excerpt: 'Checkout redesign', target: { kind: 'plan', topicId: 'tp_1' } });

  it('after a restart of the host\'s smurg: how many items are paused, and "Continue all" for members with agent access', async () => {
    const view = await mountSidebar({ ui: <ShellBanners />, role: 'agent', topics: [paused, { ...SEARCH, plan: { ...TOPIC.plan, paused: true } }], inbox: [pausedRow] });
    const banner = document.querySelector('[data-banner="restart"]') as HTMLElement;
    expect(banner.textContent).toBe("smurg was restarted on the host's computer. 4 items are paused.");
    await userEvent.click(screen.getByRole('button', { name: 'Continue all' }));
    expect(view.conn.requestsOf('plan.resume').map((request) => request.payload).sort((a, b) => a.topicId.localeCompare(b.topicId))).toEqual([{ topicId: 'tp_1' }, { topicId: 'tp_2' }]);
    // Continued: the banner leaves with the topics' state.
    act(() => {
      view.conn.emit('topic.updated', { topic: TOPIC });
      view.conn.emit('topic.updated', { topic: SEARCH });
    });
    expect(document.querySelector('[data-banner="restart"]')).toBeNull();
  });

  it('a member who cannot continue is told who can; without the count the banner counts topics', async () => {
    await mountSidebar({ ui: <ShellBanners />, role: 'viewer', topics: [paused] });
    const banner = document.querySelector('[data-banner="restart"]') as HTMLElement;
    expect(banner.textContent).toBe("smurg was restarted on the host's computer. The plan of 1 topic is paused. The host or a member with agent access can continue them.");
    expect(screen.queryByRole('button', { name: 'Continue all' })).toBeNull();
  });

  it('a refused "Continue all" is said', async () => {
    const view = await mountSidebar({ ui: <ShellBanners />, topics: [paused] });
    await userEvent.click(screen.getByRole('button', { name: 'Continue all' }));
    act(() => void view.conn.fail('plan.resume', new SmurgError('conflict', 'nope')));
    expect(await screen.findByText(/Could not continue:/)).toBeTruthy();
  });

  it('the state of the host\'s Claude account', async () => {
    const view = await mountSidebar({ ui: <ShellBanners /> });
    expect(document.querySelector('[data-banner="account"]')).toBeNull();
    act(() => view.conn.emit('session.host', { account: { state: 'usage-limit', sessions: 4 }, mainProjectSettings: 'none' }));
    expect(document.querySelector('[data-banner="account"]')?.textContent).toBe("The host's Claude account reached a usage limit. Agents wait until it resets. 4 sessions wait.");
    act(() => view.conn.emit('session.host', { account: { state: 'logged-out', sessions: 0 }, mainProjectSettings: 'none' }));
    expect(document.querySelector('[data-banner="account"]')?.textContent).toBe("The host's Claude Code is logged out, so agents cannot work. Only the host can log in again.");
    act(() => view.conn.emit('session.host', { account: { state: 'ok', sessions: 0 }, mainProjectSettings: 'none' }));
    expect(document.querySelector('[data-banner="account"]')).toBeNull();
  });
});

describe('a new "agents are waiting" item', () => {
  const arrival = buildInboxItem('permission', { key: 'permission:pr_9', excerpt: 'pnpm lint', sessionId: 's_free', anchor: { cardId: 'pr_9' }, target: { kind: 'session', sessionId: 's_free' } });

  it('is announced politely and, when its session is in no column, shown as a toast with "Open"; the focus does not move', async () => {
    const view = await mountSidebar({ ui: <InboxNotices sessionsShown /> });
    const live = document.querySelector('[data-inbox-announcer]') as HTMLElement;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');
    const before = document.activeElement;
    act(() => view.conn.emit('inbox.changed', { upsert: [arrival], remove: [] }));
    expect(live.textContent).toBe('New in your inbox, an agent is waiting: pnpm lint. No topic › Fix flaky CI test');
    expect(document.activeElement).toBe(before);
    const toast = await screen.findByText('An agent is waiting: pnpm lint');
    await userEvent.click(within(toast.closest('.ui-toast') as HTMLElement).getByRole('button', { name: 'Open' }));
    expect(view.opened).toHaveBeenCalledWith({ target: { kind: 'session', sessionId: 's_free' }, from: 'inbox', anchor: { cardId: 'pr_9' } });
  });

  it('no toast while its session is in a column of the sessions view; always one in code mode', async () => {
    const view = await mountSidebar({ ui: <InboxNotices sessionsShown /> });
    act(() => void view.stores.columns.open({ kind: 'session', sessionId: 's_free' }));
    act(() => view.conn.emit('inbox.changed', { upsert: [arrival], remove: [] }));
    expect(document.querySelector('[data-inbox-announcer]')?.textContent).toContain('pnpm lint');
    expect(screen.queryByText('An agent is waiting: pnpm lint')).toBeNull();

    document.body.innerHTML = '';
    const code = await mountSidebar({ ui: <InboxNotices sessionsShown={false} /> });
    act(() => void code.stores.columns.open({ kind: 'session', sessionId: 's_free' }));
    act(() => code.conn.emit('inbox.changed', { upsert: [arrival], remove: [] }));
    expect(await screen.findByText('An agent is waiting: pnpm lint')).toBeTruthy();
  });

  it('what does not stop an agent is not announced', async () => {
    const view = await mountSidebar({ ui: <InboxNotices sessionsShown /> });
    act(() => view.conn.emit('inbox.changed', { upsert: [buildInboxItem('report')], remove: [] }));
    expect(document.querySelector('[data-inbox-announcer]')?.textContent).toBe('');
    expect(screen.queryByText(/An agent is waiting/)).toBeNull();
  });
});

// Keep the unused fixtures referenced (they document the sample workspace).
void [CART, FREE, TERMINAL, IAN];
