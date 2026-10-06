// The strip of columns and the frame around what a column shows (UX §2, §11; DESIGN §5.4, §5.12 item 24).
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Topic } from '@smurg/protocol';
import { buildTopic } from '@smurg/protocol/testing';
import { lazy } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FeatureSlots } from '../../lib/slots.ts';
import { WorkspaceTestProviders, createTestWorkspace, renderInWorkspace } from '../../testing/services.tsx';
import { ColumnStrip, SideColumn } from './index.tsx';
import { CART, DISCUSSION, FREE, PROBES, TERMINAL, TOPIC, loadWorkspace } from './test-support.tsx';

const session = (id: string) => ({ kind: 'session', sessionId: id }) as const;

async function mount(options: { slots?: readonly FeatureSlots[]; shown?: boolean; role?: 'host' | 'agent' | 'editor' | 'viewer'; topics?: readonly Topic[] } = {}) {
  const onLastClosed = vi.fn();
  const view = renderInWorkspace(<ColumnStrip shown={options.shown ?? true} empty={<p>nothing is open</p>} onLastClosed={onLastClosed} />, {
    role: options.role ?? 'host',
    slots: options.slots ?? [PROBES],
  });
  await loadWorkspace(view, options.topics === undefined ? {} : { topics: options.topics });
  return { ...view, onLastClosed, open: (...args: Parameters<typeof view.stores.columns.open>) => act(() => view.stores.columns.open(...args)) };
}

const column = (name: string | RegExp): HTMLElement => screen.getByRole('region', { name });
/** The open columns, left to right, by name. (The toast region is a region too: columns are found by what they are.) */
const columnNames = (): (string | null)[] => [...document.querySelectorAll('[data-column-id]')].map((element) => element.getAttribute('aria-label'));
const body = (id: string): HTMLElement => screen.getByTestId(`body-${id}`);
/** The plan column of the one topic: named with its topic. */
const PLAN = 'Plan · Checkout redesign';

describe('the column strip', () => {
  it('shows what it was given while nothing is open', async () => {
    await mount();
    expect(screen.getByText('nothing is open')).toBeTruthy();
    expect(columnNames()).toEqual([]);
  });

  it('a column is a region named by its title, with the title as its h2, the topic\'s name and the status in words', async () => {
    const view = await mount();
    view.open(session('s_cart'));
    const cart = column('1 · Cart API');
    expect(within(cart).getByRole('heading', { level: 2, name: '1 · Cart API' })).toBeTruthy();
    expect(within(cart).getByText('Checkout redesign')).toBeTruthy();
    expect(within(cart).getByRole('img', { name: 'Waiting for an answer' })).toBeTruthy();
    expect(cart.getAttribute('data-kind')).toBe('conversation');
    // The body is the registered component, with the props of its kind.
    expect(body('session:s_cart').getAttribute('data-props')).toBe('{"sessionId":"s_cart"}');
    expect(body('session:s_cart').getAttribute('data-kind')).toBe('conversation');
  });

  it('each kind of thing gets the component of its kind', async () => {
    const view = await mount();
    view.open(session('s_term'));
    view.open({ kind: 'spec', topicId: 't1' }, { side: true });
    view.open({ kind: 'plan', topicId: 't1' }, { side: true });
    view.open({ kind: 'report', topicId: 't1', itemId: 'cart-api' }, { side: true });
    expect(body('session:s_term').getAttribute('data-kind')).toBe('terminal');
    expect(column('Terminal (Ian)').getAttribute('data-kind')).toBe('terminal');
    expect(body('spec:t1').getAttribute('data-props')).toBe('{"topicId":"t1"}');
    expect(body('plan:t1').getAttribute('data-kind')).toBe('plan');
    expect(body('report:t1:cart-api').getAttribute('data-props')).toBe('{"topicId":"t1","itemId":"cart-api"}');
    // The work item names the report (from its session: the plan is not loaded).
    expect(column('Result report: 1 · Cart API · Checkout redesign')).toBeTruthy();
    expect(columnNames()).toEqual(['Terminal (Ian)', 'Spec · Checkout redesign', 'Plan · Checkout redesign', 'Result report: 1 · Cart API · Checkout redesign']);
    expect(screen.getAllByRole('separator')).toHaveLength(3);
    expect(screen.getAllByRole('separator')[0]?.getAttribute('aria-label')).toBe('Drag or use the arrow keys to resize Terminal (Ian)');
  });

  it('the spec, the plan and a report are named with their topic: two plan columns of two topics have different region names', async () => {
    const view = await mount({ topics: [TOPIC, buildTopic({ id: 't2', name: 'Search filters', phase: 'plan' })] });
    view.open({ kind: 'plan', topicId: 't1' });
    view.open({ kind: 'plan', topicId: 't2' }, { side: true });
    view.open({ kind: 'spec', topicId: 't2' }, { side: true });
    view.open({ kind: 'report', topicId: 't1', itemId: 'cart-api' }, { side: true });
    expect(columnNames()).toEqual(['Plan · Checkout redesign', 'Plan · Search filters', 'Spec · Search filters', 'Result report: 1 · Cart API · Checkout redesign']);
    // The title on screen stays the mock's word; the name tells the two apart wherever it is said: the region, its
    // buttons, the divider behind it.
    const second = column('Plan · Search filters');
    expect(within(second).getByRole('heading', { level: 2 }).textContent).toBe('Plan');
    expect(within(second).getByRole('button', { name: 'Close column: Plan · Search filters' })).toBeTruthy();
    expect(within(column('Plan · Checkout redesign')).getByRole('button', { name: 'Pin column: Plan · Checkout redesign' })).toBeTruthy();
    expect(screen.getAllByRole('separator').map((separator) => separator.getAttribute('aria-label')).slice(0, 2)).toEqual([
      'Drag or use the arrow keys to resize Plan · Checkout redesign',
      'Drag or use the arrow keys to resize Plan · Search filters',
    ]);
  });

  it('a discussion is named with its topic, so two discussions can be told apart', async () => {
    const view = await mount();
    view.open(session('s_disc'));
    const discussion = column('Discussion · Checkout redesign');
    expect(discussion.hasAttribute('data-discussion')).toBe(true);
    expect(within(discussion).getByRole('heading', { level: 2 }).textContent).toBe('Discussion');
  });

  it('a kind nothing registered shows a placeholder, and the frame still works', async () => {
    const view = await mount({ slots: [] });
    view.open(session('s_term'));
    const terminal = column('Terminal (Ian)');
    expect(terminal.textContent).toContain('Terminal (Ian) cannot be shown here');
    expect(terminal.querySelector('[data-column-placeholder="terminal"]')).toBeTruthy();
    await userEvent.click(within(terminal).getByRole('button', { name: 'Close column: Terminal (Ian)' }));
    expect(screen.getByText('nothing is open')).toBeTruthy();
  });

  it('a lazy component shows a spinner first, then itself', async () => {
    type PlanComponent = NonNullable<NonNullable<FeatureSlots['columns']>['plan']>;
    let resolve: (module: { default: PlanComponent }) => void = () => {};
    const LazyPlan = lazy(() => new Promise<{ default: PlanComponent }>((done) => (resolve = done)));
    const view = await mount({ slots: [{ feature: 'lazy', columns: { plan: LazyPlan } }] });
    view.open({ kind: 'plan', topicId: 't1' });
    expect(within(column(PLAN)).getByRole('status').textContent).toContain(`Loading ${PLAN}`);
    await act(async () => {
      resolve({ default: PROBES.columns?.plan as PlanComponent });
      await Promise.resolve();
    });
    expect(await screen.findByTestId('body-plan:t1')).toBeTruthy();
  });

  it('a body that crashes is contained in its column', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken = (): never => {
      throw new Error('boom');
    };
    const view = await mount({ slots: [{ feature: 'broken', columns: { terminal: Broken, conversation: PROBES.columns!.conversation! } }] });
    view.open(session('s_term'));
    view.open(session('s_cart'), { side: true });
    expect(within(column('Terminal (Ian)')).getByRole('alert').textContent).toContain('Terminal (Ian) cannot be shown');
    expect(body('session:s_cart')).toBeTruthy();
    error.mockRestore();
  });
});

describe('focus', () => {
  it('the focused column is marked and its body knows; a click or a tab into another column moves it', async () => {
    const view = await mount();
    view.open(session('s_cart'));
    view.open(session('s_free'), { side: true });
    expect(column('Fix flaky CI test').hasAttribute('data-focused')).toBe(true);
    expect(column('1 · Cart API').hasAttribute('data-focused')).toBe(false);
    expect(body('session:s_free').getAttribute('data-focused')).toBe('true');
    expect(body('session:s_cart').getAttribute('data-focused')).toBe('false');
    await userEvent.click(body('session:s_cart'));
    expect(view.stores.columns.getState().focusedId).toBe('session:s_cart');
    expect(body('session:s_cart').getAttribute('data-focused')).toBe('true');
    act(() => within(column('Fix flaky CI test')).getByRole('heading', { level: 2 }).focus());
    expect(view.stores.columns.getState().focusedId).toBe('session:s_free');
  });

  it('opening a column puts the keyboard focus on its title; opening it again does so again', async () => {
    const view = await mount();
    view.open(session('s_cart'));
    const title = within(column('1 · Cart API')).getByRole('heading', { level: 2 });
    expect(document.activeElement).toBe(title);
    view.open(session('s_free'), { side: true });
    expect(document.activeElement).toBe(within(column('Fix flaky CI test')).getByRole('heading', { level: 2 }));
    view.open(session('s_cart'));
    expect(document.activeElement).toBe(title);
  });

  it('closing moves the focus to the neighbour\'s title: right, else left; after the last column the list gets it', async () => {
    const view = await mount();
    view.open(session('s_cart'));
    view.open(session('s_free'), { side: true });
    view.open(session('s_term'), { side: true });
    await userEvent.click(within(column('Fix flaky CI test')).getByRole('button', { name: 'Close column: Fix flaky CI test' }));
    expect(document.activeElement).toBe(within(column('Terminal (Ian)')).getByRole('heading', { level: 2 }));
    // Delete on the title closes too.
    await userEvent.keyboard('{Delete}');
    expect(screen.queryByRole('region', { name: 'Terminal (Ian)' })).toBeNull();
    expect(document.activeElement).toBe(within(column('1 · Cart API')).getByRole('heading', { level: 2 }));
    expect(view.onLastClosed).not.toHaveBeenCalled();
    await userEvent.keyboard('{Delete}');
    expect(screen.getByText('nothing is open')).toBeTruthy();
    expect(view.onLastClosed).toHaveBeenCalledOnce();
  });

  it('closing never ends a session', async () => {
    const view = await mount();
    view.open(session('s_cart'));
    await userEvent.click(screen.getByRole('button', { name: 'Close column: 1 · Cart API' }));
    expect(view.conn.requestsOf('session.end')).toHaveLength(0);
    expect(view.stores.sessions.getState().sessions.has('s_cart')).toBe(true);
  });
});

describe('the header', () => {
  it('the pin is a toggle; a pinned column is not replaced by a click on the left', async () => {
    const view = await mount();
    view.open({ kind: 'plan', topicId: 't1' });
    const pin = within(column(PLAN)).getByRole('button', { name: `Pin column: ${PLAN}` });
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(pin);
    expect(within(column(PLAN)).getByRole('button', { name: `Unpin column: ${PLAN}` }).getAttribute('aria-pressed')).toBe('true');
    view.open(session('s_cart'));
    expect(columnNames()).toEqual([PLAN, '1 · Cart API']);
  });

  it('"More actions" has the pin, "Close the other columns" and what the body added', async () => {
    const calls: string[] = [];
    (globalThis as { __planMenu?: string[] }).__planMenu = calls;
    const view = await mount();
    view.open({ kind: 'plan', topicId: 't1' });
    view.open(session('s_cart'), { side: true });
    const plan = column(PLAN);
    await userEvent.click(within(plan).getByRole('button', { name: `More actions for ${PLAN}` }));
    const menu = screen.getByRole('menu', { name: `More actions for ${PLAN}` });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Pin column', 'Close the other columns', 'Update plan']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Update plan' }));
    expect(calls).toEqual(['t1']);
    await userEvent.click(within(plan).getByRole('button', { name: `More actions for ${PLAN}` }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Close the other columns' }));
    expect(columnNames()).toEqual([PLAN]);
    // Alone, there are no others to close.
    await userEvent.click(within(plan).getByRole('button', { name: `More actions for ${PLAN}` }));
    expect(screen.getByRole('menuitem', { name: 'Close the other columns' }).getAttribute('aria-disabled')).toBe('true');
    delete (globalThis as { __planMenu?: string[] }).__planMenu;
  });

  it('a body can put something into the header, after the title', async () => {
    const view = await mount();
    view.open({ kind: 'plan', topicId: 't1' });
    const header = column(PLAN).querySelector('.col-head') as HTMLElement;
    expect(within(header).getByText('0 of 6 reviewed')).toBeTruthy();
  });
});

describe('what the frame tells the body, and the store', () => {
  it('a fifth column is refused with one sentence', async () => {
    const view = await mount();
    view.open(session('s_cart'));
    view.open(session('s_free'), { side: true });
    view.open(session('s_term'), { side: true });
    view.open(session('s_disc'), { side: true });
    view.open({ kind: 'plan', topicId: 't1' }, { side: true });
    expect(await screen.findByText('Four columns are open. Close one first.')).toBeTruthy();
    expect(columnNames()).toHaveLength(4);
  });

  it('an anchor reaches the body of that column and is dropped when the body showed it', async () => {
    const view = await mount();
    view.open(session('s_cart'), { anchor: { cardId: 'q_1' } });
    const shown = within(body('session:s_cart')).getByRole('button', { name: 'anchor q_1' });
    await userEvent.click(shown);
    expect(view.stores.columns.getState().anchors.size).toBe(0);
    expect(within(body('session:s_cart')).queryByRole('button', { name: /anchor/ })).toBeNull();
  });

  it('a column is "visible" only while the sessions view is the mode on screen', async () => {
    const context = createTestWorkspace({ role: 'host', slots: [PROBES] });
    const ui = (shown: boolean) => (
      <WorkspaceTestProviders context={context}>
        <ColumnStrip shown={shown} empty={null} />
      </WorkspaceTestProviders>
    );
    const view = render(ui(true));
    await loadWorkspace(context);
    act(() => void context.stores.columns.open(session('s_cart')));
    expect(body('session:s_cart').getAttribute('data-visible')).toBe('true');
    view.rerender(ui(false));
    expect(body('session:s_cart').getAttribute('data-visible')).toBe('false');
    // Still mounted: nothing of its state is lost.
    expect(body('session:s_cart').getAttribute('data-place')).toBe('strip');
  });

  it('what a visible column shows is marked as seen; a hidden one marks nothing', async () => {
    const view = await mount();
    view.open(session('s_cart'));
    expect(view.stores.columns.getState().seen.session['s_cart']).toBe(CART.noteworthyAt);
    act(() => view.conn.emit('session.state', { session: { ...CART, noteworthyAt: CART.noteworthyAt + 5_000 } }));
    expect(view.stores.columns.getState().seen.session['s_cart']).toBe(CART.noteworthyAt + 5_000);
    view.open({ kind: 'spec', topicId: 't1' }, { side: true });
    act(() => view.conn.emit('topic.updated', { topic: { ...TOPIC, spec: { exists: true, changedAt: 77 } } }));
    expect(view.stores.columns.getState().seen.spec['t1']).toBe(77);

    const hidden = await mount({ shown: false });
    hidden.open(session('s_free'));
    expect(hidden.stores.columns.getState().seen.session['s_free']).toBeUndefined();
  });

  it('a session the host no longer keeps says so and offers to close the column', async () => {
    const view = await mount();
    view.open(session('s_gone'));
    const gone = column('Session');
    expect(gone.textContent).toContain("the host's computer no longer keeps its content");
    await userEvent.click(within(gone).getByRole('button', { name: 'Close column' }));
    expect(columnNames()).toEqual([]);
  });

  it('a column whose session is not known yet waits; a deleted topic says so', async () => {
    const view = renderInWorkspace(<ColumnStrip shown empty={null} />, { role: 'host', slots: [PROBES] });
    act(() => void view.stores.columns.open(session('s_cart')));
    expect(within(column('Session')).getByRole('status').textContent).toContain('Loading Session');
    await loadWorkspace(view);
    expect(column('1 · Cart API')).toBeTruthy();
    act(() => void view.stores.columns.open({ kind: 'plan', topicId: 'nope' }, { side: true }));
    expect(column('Plan').textContent).toContain('This topic was deleted');
  });

  it('the strip tells the store how many columns fit', async () => {
    const view = await mount();
    // Not measurable here: the store keeps its default of four.
    expect(view.stores.columns.getState().capacity).toBe(4);
  });
});

describe('code mode\'s session column', () => {
  it('offers the agent sessions, the ones still going first; the chosen one is remembered and shown with the same body', async () => {
    const view = renderInWorkspace(<SideColumn shown />, { role: 'host', slots: [PROBES] });
    await loadWorkspace(view, { sessions: [DISCUSSION, CART, FREE, TERMINAL, { ...FREE, id: 's_done', title: 'An old one', status: 'ended' }] });
    const region = screen.getByRole('region', { name: 'Session beside the editor' });
    expect(region.textContent).toContain('No session beside the editor');
    const select = within(region).getByRole('combobox', { name: 'Session shown beside the editor' });
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'No session',
      '1 · Cart API · Checkout redesign',
      'Discussion · Checkout redesign',
      'Fix flaky CI test',
      'An old one',
    ]);
    await userEvent.selectOptions(select, 's_cart');
    expect(view.stores.columns.getState().code.sessionId).toBe('s_cart');
    const cart = screen.getByRole('region', { name: '1 · Cart API' });
    expect(body('session:s_cart').getAttribute('data-place')).toBe('code');
    expect(body('session:s_cart').getAttribute('data-visible')).toBe('true');
    // No pin and no close: it is the one column of code mode.
    expect(within(cart).queryByRole('button', { name: /Close column|Pin column/ })).toBeNull();
    await userEvent.selectOptions(within(cart).getByRole('combobox', { name: 'Session shown beside the editor' }), '');
    expect(view.stores.columns.getState().code.sessionId).toBeNull();
  });

  it('is not "visible" while the sessions view is on screen; a session that is gone falls back to the empty state', async () => {
    const view = renderInWorkspace(<SideColumn shown={false} />, { role: 'host', slots: [PROBES] });
    await loadWorkspace(view);
    act(() => view.stores.columns.setCodeSession('s_free'));
    expect(body('session:s_free').getAttribute('data-visible')).toBe('false');
    act(() => view.stores.columns.setCodeSession('s_nope'));
    expect(screen.getByRole('region', { name: 'Session beside the editor' })).toBeTruthy();
  });

  it('without any agent session it says where to start one', async () => {
    const view = renderInWorkspace(<SideColumn shown />, { role: 'host' });
    await loadWorkspace(view, { sessions: [TERMINAL], topics: [] });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session beside the editor' }).textContent).toContain('There is no agent session yet'));
  });
});
