// The plan column by state (DESIGN §5.4, §5.12 item 20): no plan, being written, unreadable, before the start,
// executing, paused, complete; who is responsible; what the topic always allows.
import { SmurgError, type PlanInfo, type Role, type SessionInfo, type Topic, type WorkItem } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildPlan, buildReportSummary, buildTopic, buildWorkItem } from '@smurg/protocol/testing';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderInColumn } from '../../testing/columns.tsx';
import { T0, makeAgentSession } from '../../testing/fixtures.ts';
import { clearAskDrafts } from './AskBox.tsx';
import { topicDialogs } from './dialogs.ts';
import PlanColumn from './PlanColumn.tsx';
import { AMY, IAN, MEI, admitAs, settle, topicConnection } from './testing/support.tsx';

const planOf = (topic: Partial<Topic['plan']> = {}): Topic['plan'] => ({ ...buildTopic().plan, exists: true, valid: true, items: 3, ...topic });
const TOPIC = buildTopic({ phase: 'plan', discussionSessionId: 'sess_d', spec: { exists: true }, plan: planOf() });
const item = (id: string, number: number, overrides: Partial<WorkItem> = {}): WorkItem => buildWorkItem({ id, number, title: id === 'cart-api' ? 'Cart API' : id === 'payment-form' ? 'Payment form' : 'Checkout page', summary: `About ${id}.`, ...overrides });
const BEFORE: PlanInfo = buildPlan({
  items: [
    item('cart-api', 1, { responsible: { ...IAN, source: 'agent' } }),
    item('payment-form', 2, { size: 's', responsible: { ...MEI, source: 'agent' } }),
    item('checkout-page', 3, { size: 'l', dependsOn: ['cart-api', 'payment-form'], responsible: { ...MEI, source: 'smurg' } }),
  ],
  split: { source: 'agent', reason: 'Cart and receipt share the order model.' },
});

afterEach(() => clearAskDrafts());

async function setup(options: { role?: Role; topic?: Topic; plan?: PlanInfo | null; sessions?: SessionInfo[] } = {}) {
  const topic = options.topic ?? TOPIC;
  const world = { role: options.role ?? 'agent', topics: [topic], plans: { [topic.id]: options.plan === undefined ? BEFORE : options.plan }, sessions: options.sessions ?? [] };
  const conn = topicConnection(world);
  const view = renderInColumn(<PlanColumn topicId={topic.id} />, { target: { kind: 'plan', topicId: topic.id }, conn, admit: false });
  const openColumn = vi.fn();
  view.session.commands.handle('openColumn', openColumn);
  admitAs(conn, world);
  await settle();
  return { ...view, conn, openColumn, dialog: () => topicDialogs(view.stores).getState() };
}

const row = (title: string): HTMLElement => screen.getByText(title).closest('li') as HTMLElement;

describe('the plan column: before a plan exists', () => {
  it('offers to generate it from the spec, and opens the spec beside it', async () => {
    const { conn, openColumn } = await setup({ topic: buildTopic({ phase: 'spec', spec: { exists: true } }), plan: null });
    expect(screen.getByText('No plan yet')).toBeTruthy();
    expect(screen.getByText('Generate it from the spec.')).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'File' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open spec' }));
    expect(openColumn).toHaveBeenCalledWith({ target: { kind: 'spec', topicId: 'tp_1' }, side: true });
    fireEvent.click(screen.getByRole('button', { name: 'Generate plan' }));
    expect(conn.lastRequest('plan.generate')?.payload).toEqual({ topicId: 'tp_1' });
  });

  it('an editor cannot generate it; without a spec nobody can', async () => {
    const editor = await setup({ role: 'editor', topic: buildTopic({ phase: 'spec', spec: { exists: true } }), plan: null });
    expect(screen.queryByRole('button', { name: 'Generate plan' })).toBeNull();
    editor.unmount();
    await setup({ topic: buildTopic(), plan: null });
    expect(screen.getByText('A plan is generated from the spec, and there is no spec yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate plan' })).toBeNull();
  });

  it('opens in "Claude is writing the plan…" while the agent writes it', async () => {
    const { conn } = await setup({ topic: buildTopic({ phase: 'spec', spec: { exists: true }, plan: { ...buildTopic().plan, generating: true } }), plan: null });
    expect(screen.getByText('Claude is writing the plan…')).toBeTruthy();
    expect(screen.queryByText('No plan yet')).toBeNull();
    // The plan arrives by itself when the turn ends.
    act(() => {
      conn.emit('topic.updated', { topic: TOPIC });
      conn.emit('plan.updated', { plan: BEFORE });
    });
    expect(screen.getByText('3 work items')).toBeTruthy();
    expect(screen.queryByText('Claude is writing the plan…')).toBeNull();
  });
});

describe('the plan column: a plan smurg cannot read', () => {
  it('says where, keeps the last plan that parsed, offers the file and the agent, and has no Start', async () => {
    const broken = { ...TOPIC, plan: planOf({ valid: false, error: { line: 14, text: msg('plan.error.missingId', { line: 14 }), fallback: 'Line 14: this work item has no id.' } }) };
    const { conn } = await setup({ topic: broken });
    expect(screen.getByText('smurg cannot read the work items from PLAN.md (line 14).')).toBeTruthy();
    expect(screen.getByText(/Line 14: this work item has no id\./)).toBeTruthy();
    expect(screen.getByText(/Below is the last plan smurg could read/)).toBeTruthy();
    expect(screen.getByText('Cart API')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Start \d/ })).toBeNull();
    expect(within(row('Cart API')).queryByRole('button', { name: 'Start this one' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent to fix it' }));
    const box = screen.getByRole('textbox', { name: 'What should the agent change?' }) as HTMLTextAreaElement;
    expect(box.value).toBe('PLAN.md cannot be read as work items. Please fix it and check it again.');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(conn.lastRequest('topic.revise')?.payload).toMatchObject({ topicId: 'tp_1', target: 'plan' });

    fireEvent.click(screen.getByRole('button', { name: 'Open the file' }));
    expect((screen.getByRole('radio', { name: 'File' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
    await settle();
    expect(conn.lastRequest('doc.open')?.payload).toMatchObject({ file: { root: { kind: 'main' }, path: 'specs/checkout/PLAN.md' } });
  });
});

describe('the plan column: before the start', () => {
  it('counts what can start, shows the agent’s split with its reason, the sizes and what comes after what', async () => {
    const { dialog } = await setup();
    expect(screen.getByText('3 work items')).toBeTruthy();
    expect(screen.getByText('2 can start now · 1 waits for others')).toBeTruthy();
    expect(screen.getByText(/Claude suggests this split among the people with agent access who are here: "Cart and receipt share the order model\."/)).toBeTruthy();
    expect(screen.getByText('Ian 1')).toBeTruthy();
    expect(screen.getByText('Mei 2')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Work items' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(row('Cart API')).getByText('Ready to start')).toBeTruthy();
    expect(within(row('Cart API')).getByText('Size: medium')).toBeTruthy();
    expect(within(row('Checkout page')).getByText('Waits for 1 and 2')).toBeTruthy();
    expect(within(row('Checkout page')).getByText('after 1 and 2')).toBeTruthy();
    expect(within(row('Checkout page')).queryByRole('button', { name: 'Start this one' })).toBeNull();
    expect(screen.getByText(/Start opens one agent session per item, each in its own worktree\. Item 3 starts by itself when 1 and 2 are merged\./)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start 2 items' }));
    expect(dialog()).toEqual({ kind: 'start', topicId: 'tp_1' });
    fireEvent.click(within(row('Cart API')).getByRole('button', { name: 'Start this one' }));
    expect(dialog()).toEqual({ kind: 'start', topicId: 'tp_1', itemIds: ['cart-api'] });
  });

  it('a member with agent access changes who is responsible for an item, or nobody', async () => {
    const { conn } = await setup();
    fireEvent.click(within(row('Cart API')).getByRole('button', { name: /^Ian · suggested/ }));
    const menu = screen.getByRole('menu', { name: 'Responsible for item 1: Ian. Change' });
    const options = within(menu).getAllByRole('menuitemradio');
    const said = (option: HTMLElement): string => [option.querySelector('.ui-menu__label')?.textContent, option.querySelector('.ui-menu__hint')?.textContent].filter(Boolean).join(' | ');
    expect(options.map(said)).toEqual(['Ian | Host · 1 item', 'Mei | Agent access · 2 items', 'Amy | Editor · 0 items', 'No one: everyone watches']);
    expect(options[0]?.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(options[1] as HTMLElement);
    expect(conn.lastRequest('plan.assign')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api', userId: MEI.userId });
    await act(async () => {
      conn.respond('plan.assign', { plan: { ...BEFORE, items: BEFORE.items.map((entry) => (entry.id === 'cart-api' ? { ...entry, responsible: { ...MEI, source: 'chosen' as const } } : entry)) } });
    });
    // A chosen person is no longer "suggested"; the viewer's own name says "(you)".
    expect(within(row('Cart API')).getByRole('button', { name: 'Mei (you)' })).toBeTruthy();

    fireEvent.click(within(row('Payment form')).getByRole('button', { name: /^Mei \(you\) · suggested/ }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /No one: everyone watches/ }));
    expect(conn.lastRequest('plan.assign')?.payload).toEqual({ topicId: 'tp_1', itemId: 'payment-form', userId: null });
  });

  it('an Editor who is made responsible reviews and votes: the row says who allows commands', async () => {
    await setup({ plan: { ...BEFORE, items: [item('cart-api', 1, { responsible: { ...AMY, source: 'chosen' } })] } });
    expect(screen.getByText('Amy reviews the report and votes. Commands are allowed by Ian and Mei.')).toBeTruthy();
  });

  it('"Suggest again" and the two ways of watching', async () => {
    const { conn } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest again' }));
    expect(conn.lastRequest('plan.suggest')?.payload).toEqual({ topicId: 'tp_1' });
    const mode = screen.getByRole('radiogroup', { name: 'Who is responsible' });
    expect(within(mode).getByRole('radio', { name: 'Assigned' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(mode).getByRole('radio', { name: 'No one assigned: everyone watches' }));
    expect(conn.lastRequest('plan.mode.set')?.payload).toEqual({ topicId: 'tp_1', mode: 'everyone' });
    await act(async () => {
      conn.respond('plan.mode.set', { plan: { ...BEFORE, mode: 'everyone', items: BEFORE.items.map((entry) => ({ ...entry, responsible: null })) } });
    });
    expect(screen.getByText('Nobody is assigned. Permission requests go to Ian and Mei. Anyone but a viewer can review a report. Questions are decided by the person who presses Start.')).toBeTruthy();
    expect(within(row('Cart API')).getByRole('button', { name: 'Nobody assigned' })).toBeTruthy();
  });

  it('an editor reads the plan: static chips, no mode switch, no Start, and who can start it', async () => {
    await setup({ role: 'editor' });
    expect(screen.queryByRole('radiogroup', { name: 'Who is responsible' })).toBeNull();
    expect(screen.getByText('Assigned')).toBeTruthy();
    expect(within(row('Cart API')).queryByRole('button', { name: /Ian/ })).toBeNull();
    expect(within(row('Cart API')).getByText('Ian · suggested')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Start/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Suggest again' })).toBeNull();
    expect(screen.getByText(/^Ian and Mei can start the plan\./)).toBeTruthy();
    // An editor may ask the agent to revise (as a suggestion).
    expect(screen.getByRole('button', { name: 'Ask the agent to revise' })).toBeTruthy();
  });

  it('smurg’s own split is labelled for what it is; warnings of the plan are shown', async () => {
    await setup({ plan: { ...BEFORE, split: { source: 'smurg' }, warnings: [{ text: msg('plan.warning.overlap', { first: 1, second: 2 }), fallback: 'x' }] } });
    expect(screen.getByText(/Suggested split: an even load across the people with agent access \(sizes S \/ M \/ L\)\./)).toBeTruthy();
    expect(screen.getByText('Items 1 and 2 may change the same files and neither waits for the other.')).toBeTruthy();
  });

  it('in a folder that is not a git repository the foot says why nothing can start', async () => {
    await setup({ topic: { ...TOPIC, versioned: false } });
    expect(screen.getByText(/This folder is not a git repository yet, so work items cannot start/)).toBeTruthy();
  });
});

describe('the plan column: allowed in this topic', () => {
  const RULE = { id: 'r_1', tool: 'Bash' as const, pattern: 'pnpm test *', scope: 'topic' as const, addedBy: IAN, addedAt: T0 };

  it('lists the kinds, removes one, and adds only what can be remembered', async () => {
    const { conn } = await setup({ topic: { ...TOPIC, rules: [RULE] } });
    const rules = screen.getByRole('list', { name: 'Allowed in this topic' });
    expect(within(rules).getByText('pnpm test *')).toBeTruthy();
    fireEvent.click(within(rules).getByRole('button', { name: 'Stop allowing pnpm test *' }));
    expect(conn.lastRequest('topic.rule.remove')?.payload).toEqual({ topicId: 'tp_1', ruleId: 'r_1' });

    fireEvent.click(screen.getByRole('button', { name: 'Add a kind' }));
    const pattern = screen.getByRole('textbox', { name: 'Command' });
    fireEvent.change(pattern, { target: { value: 'bash -c *' } });
    expect(screen.getByText('This program runs whatever follows it, so it cannot be always allowed.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(pattern, { target: { value: 'pnpm add *' } });
    expect(screen.getByText('This downloads and runs code, so it cannot be always allowed.')).toBeTruthy();
    fireEvent.change(pattern, { target: { value: 'pnpm lint *' } });
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(conn.lastRequest('topic.rule.add')?.payload).toEqual({ topicId: 'tp_1', tool: 'Bash', pattern: 'pnpm lint *' });

    await act(async () => {
      conn.respond('topic.rule.add', { topic: { ...TOPIC, rules: [RULE, { ...RULE, id: 'r_2', pattern: 'pnpm lint *' }] } });
    });
    expect(within(screen.getByRole('list', { name: 'Allowed in this topic' })).getByText('pnpm lint *')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Command' })).toBeNull();
  });

  it('a website is written as its host name; an editor only reads the list', async () => {
    const agent = await setup();
    expect(screen.getByText('Nothing yet: every command asks first.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a kind' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'What to allow' }), { target: { value: 'WebFetch' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Website' }), { target: { value: 'docs.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(agent.conn.lastRequest('topic.rule.add')?.payload).toEqual({ topicId: 'tp_1', tool: 'WebFetch', pattern: 'domain:docs.example.com' });
    agent.unmount();
    await setup({ role: 'editor', topic: { ...TOPIC, rules: [RULE] } });
    expect(screen.getByText('pnpm test *')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a kind' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop allowing pnpm test *' })).toBeNull();
  });
});

describe('the plan column: executing', () => {
  const EXECUTING: Topic = { ...TOPIC, phase: 'executing', plan: planOf({ items: 6, started: 5 }) };
  const session = (id: string, itemId: string, number: number, status: SessionInfo['status']): SessionInfo =>
    makeAgentSession({ id, purpose: 'item', topicId: 'tp_1', topicName: 'Checkout', itemId, attempt: 1, item: { number, title: itemId }, title: undefined, status: status as 'idle' });
  const RUNNING: PlanInfo = buildPlan({
    items: [
      buildWorkItem({ id: 'a', number: 1, title: 'Cart API', state: 'running', sessionId: 's1', attempt: 1, responsible: { ...IAN, source: 'chosen' } }),
      buildWorkItem({ id: 'b', number: 2, title: 'Payment form', state: 'running', sessionId: 's2', attempt: 1 }),
      buildWorkItem({ id: 'c', number: 3, title: 'Receipt email', state: 'done', sessionId: 's3', attempt: 1, report: buildReportSummary({ outcome: 'partial' }) }),
      buildWorkItem({ id: 'd', number: 4, title: 'Order history', state: 'stalled', stalledBy: 'agent', sessionId: 's4', attempt: 2 }),
      buildWorkItem({ id: 'e', number: 5, title: 'Seed data', state: 'failed', sessionId: 's5', attempt: 1 }),
      buildWorkItem({ id: 'f', number: 6, title: 'Checkout page', state: 'not-started', disarmed: 'start-failed', startError: { text: msg('plan.start.worktreeLimit', { max: 20 }), fallback: 'x' }, dependsOn: [] }),
      buildWorkItem({ id: 'old', number: 0, title: 'Dropped idea', inPlan: false, state: 'stopped', sessionId: 's9', attempt: 1 }),
    ],
    waitingFor: [{ user: IAN, questions: 1, permissions: 0, reports: 0, since: Date.now() - 5.5 * 60_000 }],
  });
  const SESSIONS = [session('s1', 'a', 1, 'waiting-answer'), session('s2', 'b', 2, 'running'), session('s3', 'c', 3, 'idle'), session('s4', 'd', 4, 'stalled'), session('s5', 'e', 5, 'failed')];

  it('is the overview: progress, who is waited for, one badge per item', async () => {
    await setup({ topic: EXECUTING, plan: RUNNING, sessions: SESSIONS });
    expect(screen.getByText('0 of 6 reviewed')).toBeTruthy();
    expect(screen.getByText('1 report to review · 3 wait for a person · 1 running · 1 not started')).toBeTruthy();
    expect(screen.getByText(/^Waiting for: Ian 1 question \(6 minutes\)$/)).toBeTruthy();
    expect(within(row('Cart API')).getByText('Waiting for an answer')).toBeTruthy();
    expect(within(row('Payment form')).getByText('Running')).toBeTruthy();
    expect(within(row('Receipt email')).getByText('Report to review · partial')).toBeTruthy();
    expect(within(row('Order history')).getByText('Stopped without a report')).toBeTruthy();
    expect(within(row('Order history')).getByText('attempt 2')).toBeTruthy();
    expect(within(row('Seed data')).getByText('Failed')).toBeTruthy();
    expect(within(row('Checkout page')).getByText('Could not start')).toBeTruthy();
    expect(within(row('Checkout page')).getByText(/^Could not start: There is no room for more worktrees \(20\)/)).toBeTruthy();
    // No "Suggest again" and no explanation of the split once work runs.
    expect(screen.queryByRole('button', { name: 'Suggest again' })).toBeNull();
    const removed = screen.getByRole('region', { name: 'No longer in the plan' });
    expect(within(removed).getByText('Dropped idea')).toBeTruthy();
  });

  it('each row leads to its session and report and offers what its state allows', async () => {
    const { conn, openColumn, dialog } = await setup({ topic: EXECUTING, plan: RUNNING, sessions: SESSIONS });
    fireEvent.click(within(row('Cart API')).getByRole('button', { name: 'Session' }));
    expect(openColumn).toHaveBeenLastCalledWith({ target: { kind: 'session', sessionId: 's1' }, side: true });
    fireEvent.click(within(row('Receipt email')).getByRole('button', { name: 'Report' }));
    expect(openColumn).toHaveBeenLastCalledWith({ target: { kind: 'report', topicId: 'tp_1', itemId: 'c' }, side: true });
    fireEvent.click(within(row('Order history')).getByRole('button', { name: 'Continue' }));
    expect(conn.lastRequest('plan.item.continue')?.payload).toEqual({ topicId: 'tp_1', itemId: 'd' });
    fireEvent.click(within(row('Seed data')).getByRole('button', { name: 'Try again' }));
    expect(conn.lastRequest('plan.item.retry')?.payload).toEqual({ topicId: 'tp_1', itemId: 'e' });
    await act(async () => {
      conn.fail('plan.item.retry', new SmurgError('conflict', msg('plan.start.worktreeLimit', { max: 20 })));
    });
    expect(await screen.findByText(/^5 · Seed data: There is no room for more worktrees/)).toBeTruthy();
    fireEvent.click(within(row('Checkout page')).getByRole('button', { name: 'Start again' }));
    expect(dialog()).toEqual({ kind: 'start', topicId: 'tp_1', itemIds: ['f'] });
    expect(screen.getByRole('button', { name: 'Start 1 more item' })).toBeTruthy();
  });

  it('"Watch running sessions side by side" opens the running ones as columns', async () => {
    const { openColumn } = await setup({ topic: EXECUTING, plan: RUNNING, sessions: SESSIONS });
    fireEvent.click(screen.getByRole('button', { name: 'Watch running sessions side by side' }));
    expect(openColumn.mock.calls.map((call) => (call[0] as { target: { sessionId: string } }).target.sessionId)).toEqual(['s1', 's2']);
  });

  it('an editor sees the rows without the actions that need agent access', async () => {
    await setup({ role: 'editor', topic: EXECUTING, plan: RUNNING, sessions: SESSIONS });
    expect(within(row('Order history')).getByRole('button', { name: 'Session' })).toBeTruthy();
    expect(within(row('Order history')).queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(within(row('Seed data')).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(within(row('Checkout page')).queryByRole('button', { name: 'Start again' })).toBeNull();
  });

  it('after a restart of the host’s smurg nothing runs until "Continue all"', async () => {
    const { conn } = await setup({ topic: { ...EXECUTING, plan: planOf({ paused: true }) }, plan: { ...RUNNING, paused: true } });
    expect(screen.getByText("smurg was restarted on the host's computer")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue all' }));
    expect(conn.lastRequest('plan.resume')?.payload).toEqual({ topicId: 'tp_1' });
    const editor = await setup({ role: 'editor', topic: { ...EXECUTING, plan: planOf({ paused: true }) }, plan: { ...RUNNING, paused: true } });
    expect(within(editor.container).getByText('Nothing in this plan runs until it is continued. Ian and Mei can continue it.')).toBeTruthy();
    expect(within(editor.container).queryByRole('button', { name: 'Continue all' })).toBeNull();
  });

  it('a plan older than the spec says so, with "Update plan"', async () => {
    const { conn } = await setup({ topic: { ...EXECUTING, plan: planOf({ stale: true }) }, plan: RUNNING });
    expect(screen.getByText('The spec changed after this plan was written.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update plan' }));
    expect(conn.lastRequest('plan.generate')?.payload).toEqual({ topicId: 'tp_1' });
  });

  it('the host gets "Open the next one to merge"; a merge conflict offers the agent', async () => {
    const reviewed = buildPlan({
      items: [
        buildWorkItem({ id: 'a', number: 1, title: 'Cart API', state: 'reviewed', attempt: 1, report: buildReportSummary({ state: 'reviewed' }), merge: { requestId: 'mr_1', status: 'conflict', ready: true } }),
        buildWorkItem({ id: 'b', number: 2, title: 'Payment form', state: 'reviewed', attempt: 1, report: buildReportSummary({ state: 'reviewed' }), merge: { requestId: 'mr_2', status: 'draft', ready: true } }),
        buildWorkItem({ id: 'c', number: 3, title: 'Checkout page', state: 'waiting', armed: true, dependsOn: ['a', 'b'] }),
      ],
    });
    const { conn, openColumn } = await setup({ role: 'host', topic: EXECUTING, plan: reviewed });
    expect(within(row('Checkout page')).getByText('Waits for the host to merge 1 and 2')).toBeTruthy();
    expect(within(row('Payment form')).getByText('Reviewed · waits for the host to merge')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open the next one to merge' }));
    expect(openColumn).toHaveBeenLastCalledWith({ target: { kind: 'report', topicId: 'tp_1', itemId: 'b' }, side: true });
    fireEvent.click(within(row('Cart API')).getByRole('button', { name: 'Ask the agent to resolve' }));
    expect(conn.lastRequest('plan.item.resolve')?.payload).toEqual({ topicId: 'tp_1', itemId: 'a' });
  });
});

describe('the plan column: topic complete', () => {
  const DONE: PlanInfo = buildPlan({
    items: [
      buildWorkItem({ id: 'a', number: 1, title: 'Cart API', state: 'reviewed', attempt: 1, report: buildReportSummary({ state: 'reviewed' }), merge: { requestId: 'mr_1', status: 'merged', ready: false } }),
      buildWorkItem({ id: 'b', number: 2, title: 'Checkout page', state: 'reviewed', attempt: 1, report: buildReportSummary({ state: 'reviewed' }), merge: { requestId: 'mr_2', status: 'draft', ready: true } }),
    ],
  });
  const COMPLETE: Topic = { ...TOPIC, phase: 'complete', plan: planOf({ items: 2, started: 2, reviewed: 2, merged: 1 }) };

  it('says what is still not merged and offers to archive the topic', async () => {
    const { dialog } = await setup({ topic: COMPLETE, plan: DONE });
    expect(screen.getByText('Topic complete')).toBeTruthy();
    expect(screen.getByText("Every result report has been reviewed. Not merged yet: 2 · Checkout page (in the host's inbox).")).toBeTruthy();
    expect(screen.getByText('2 of 2 reviewed')).toBeTruthy();
    expect(screen.queryByText('Who is responsible')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask the agent to revise' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Archive topic' }));
    expect(dialog()).toEqual({ kind: 'archive', topicId: 'tp_1' });
  });

  it('an archived topic is read-only', async () => {
    await setup({ topic: { ...COMPLETE, archived: true }, plan: DONE });
    expect(screen.getAllByText('This topic is archived. Restore it to continue.').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Archive topic' })).toBeNull();
  });
});
