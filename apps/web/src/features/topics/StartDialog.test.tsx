// The Start dialog (DESIGN §4.5, §5.12 item 21): the checklist from plan.preflight, the pins plan.start echoes, and
// what happens when the files changed meanwhile.
import { SmurgError, type StartPreflight, type Topic } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { FAKE_HASH, buildPlan, buildTopic, buildWorkItem } from '@smurg/protocol/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { T0 } from '../../testing/fixtures.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import { StartDialog } from './StartDialog.tsx';
import { AMY, IAN, MEI, admitAs, settle, topicConnection } from './testing/support.tsx';

const TOPIC: Topic = buildTopic({
  phase: 'plan',
  spec: { exists: true },
  plan: { ...buildTopic().plan, exists: true, valid: true, items: 3 },
  rules: [{ id: 'r_1', tool: 'Bash', pattern: 'pnpm test *', scope: 'topic', addedBy: IAN, addedAt: T0 }],
});
const PLAN = buildPlan({
  items: [
    buildWorkItem({ id: 'cart-api', number: 1, title: 'Cart API' }),
    buildWorkItem({ id: 'payment-form', number: 2, title: 'Payment form' }),
    buildWorkItem({ id: 'checkout-page', number: 3, title: 'Checkout page', dependsOn: ['cart-api', 'payment-form'] }),
  ],
});

function preflight(overrides: Partial<StartPreflight> = {}): StartPreflight {
  return {
    planRevision: 7,
    specHash: FAKE_HASH,
    planHash: 'b'.repeat(64),
    startsNow: ['cart-api', 'payment-form'],
    waits: [{ itemId: 'checkout-page', for: ['cart-api', 'payment-form'] }],
    alreadyStarted: [],
    responsible: [
      { itemId: 'cart-api', user: IAN, online: true },
      { itemId: 'payment-form', user: MEI, online: true },
      { itemId: 'checkout-page', user: MEI, online: true },
    ],
    youDecide: 0,
    commit: { needed: true, branch: 'main', as: MEI, files: ['specs/checkout/SPEC.md', 'specs/checkout/PLAN.md'], alsoInFolder: [] },
    handEdits: { spec: [], plan: [] },
    invisibleCharacters: [],
    stale: false,
    openQuestion: false,
    specOpenQuestions: 0,
    editingNow: [],
    projectSettings: 'used',
    rules: TOPIC.rules,
    sharedDirs: [],
    blockers: [],
    ...overrides,
  };
}

async function setup(options: { itemIds?: string[]; role?: 'host' | 'agent' } = {}) {
  const world = { role: options.role ?? ('agent' as const), topics: [TOPIC], plans: { tp_1: PLAN } };
  const conn = topicConnection(world);
  const onClose = vi.fn();
  // A dialog opens on a person's click, in a connected workspace: admit first, then render.
  const context = createTestWorkspace({ conn, admit: false });
  const openColumn = vi.fn();
  context.session.commands.handle('openColumn', openColumn);
  admitAs(conn, world);
  await settle();
  const view = render(
    <WorkspaceTestProviders context={context}>
      <StartDialog topicId="tp_1" itemIds={options.itemIds} onClose={onClose} />
    </WorkspaceTestProviders>,
  );
  const answer = async (value: StartPreflight): Promise<void> => {
    await act(async () => {
      conn.respond('plan.preflight', { preflight: value });
    });
  };
  return { ...view, ...context, conn, onClose, openColumn, answer };
}

describe('the Start dialog', () => {
  it('lists what a Start does before anything starts, and Start echoes the pins the list showed', async () => {
    const { conn, onClose, answer } = await setup();
    expect(conn.lastRequest('plan.preflight')?.payload).toEqual({ topicId: 'tp_1' });
    const loading = screen.getByRole('dialog', { name: 'Start' });
    expect(within(loading).getByText('Checking what a Start would do…')).toBeTruthy();
    expect((within(loading).getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);

    await answer(preflight());
    // The title counts what starts now, like the button of the plan that opened it; the third item waits.
    const dialog = screen.getByRole('dialog', { name: 'Start 2 items' });
    expect(within(dialog).getByText('2 items start now: 1 · Cart API and 2 · Payment form.')).toBeTruthy();
    expect(within(dialog).getByText(/^3 · Checkout page starts by itself when 1 · Cart API and 2 · Payment form are merged/)).toBeTruthy();
    expect(within(dialog).getByText('Responsible: Ian 1 · Mei 2.')).toBeTruthy();
    expect(within(dialog).getByText("smurg commits SPEC.md and PLAN.md to the branch main of the host's folder, as you.")).toBeTruthy();
    expect(within(dialog).getByText("The folder's Claude Code project settings are confirmed: agents read CLAUDE.md.")).toBeTruthy();
    // What the topic always allows is part of the list and can be changed here.
    expect(within(dialog).getByText('pnpm test *')).toBeTruthy();
    expect(within(dialog).getByText('Everything else asks first.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Add a kind' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect(conn.lastRequest('plan.start')?.payload).toEqual({ topicId: 'tp_1', planRevision: 7, specHash: FAKE_HASH, planHash: 'b'.repeat(64) });
    await act(async () => {
      conn.respond('plan.start', { plan: PLAN });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // The toast says what happened: two sessions started, the third item starts by itself.
    expect(await screen.findByText('Started 2 items.')).toBeTruthy();
    expect(screen.getByText('1 more item starts by itself later.')).toBeTruthy();
    expect(screen.queryByText(/Started 3 items/)).toBeNull();
  });

  it('when everything a Start arms waits for another item, the title counts what it arms and the toast says nothing started yet', async () => {
    const { conn, answer } = await setup();
    await answer(preflight({ startsNow: [], waits: [{ itemId: 'checkout-page', for: ['cart-api', 'payment-form'] }], alreadyStarted: ['cart-api', 'payment-form'] }));
    const dialog = screen.getByRole('dialog', { name: 'Start 1 item' });
    expect(within(dialog).getByText('No item starts now.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await act(async () => {
      conn.respond('plan.start', { plan: PLAN });
    });
    expect(await screen.findByText('1 item starts by itself later.')).toBeTruthy();
    expect(screen.queryByText(/^Started/)).toBeNull();
  });

  it('"Start this one" asks about that item only and starts only it', async () => {
    const { conn, answer } = await setup({ itemIds: ['cart-api'] });
    expect(conn.lastRequest('plan.preflight')?.payload).toEqual({ topicId: 'tp_1', itemIds: ['cart-api'] });
    await answer(preflight({ startsNow: ['cart-api'], waits: [], responsible: [{ itemId: 'cart-api', user: null, online: false }], youDecide: 1 }));
    const dialog = screen.getByRole('dialog', { name: 'Start 1 item' });
    expect(within(dialog).getByText('You will decide the questions of 1 session.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect(conn.lastRequest('plan.start')?.payload).toMatchObject({ topicId: 'tp_1', itemIds: ['cart-api'], planRevision: 7 });
  });

  it('a blocker is read first and disables Start', async () => {
    const { answer } = await setup();
    await answer(preflight({ blockers: [{ text: msg('plan.start.noGit'), fallback: 'Not a git repository.' }], commit: null }));
    const dialog = screen.getByRole('dialog');
    const lines = within(dialog).getAllByRole('listitem');
    expect(lines[0]?.getAttribute('data-tone')).toBe('danger');
    expect(lines[0]?.textContent).toContain('Cannot start: Work items run in git worktrees, and this folder is not a git repository yet.');
    expect((within(dialog).getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hand edits offer "Show the changes" (plan.changes) inside the dialog', async () => {
    const { conn, answer } = await setup();
    await answer(preflight({ handEdits: { spec: [{ by: AMY, at: new Date().setHours(14, 12, 0, 0) }], plan: [] } }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Edited by hand since the last Start: Amy (SPEC.md, 14:12).')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show the changes' }));
    expect(conn.lastRequest('plan.changes')?.payload).toEqual({ topicId: 'tp_1' });
    await act(async () => {
      conn.respond('plan.changes', { files: [{ target: 'spec', diff: '@@ -1 +1 @@\n-Cards only.\n+Cards and wallets.\n', truncated: false }] });
    });
    const diff = within(dialog).getByRole('group', { name: 'Changes of SPEC.md' });
    expect(diff.textContent).toContain('+Cards and wallets.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hide the changes' }));
    expect(within(dialog).queryByRole('group', { name: 'Changes of SPEC.md' })).toBeNull();
  });

  it('a stale plan offers "Update plan first": the dialog closes and the agent is asked', async () => {
    const { conn, onClose, answer } = await setup();
    await answer(preflight({ stale: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Update plan first' }));
    expect(onClose).toHaveBeenCalled();
    expect(conn.lastRequest('plan.generate')?.payload).toEqual({ topicId: 'tp_1' });
  });

  it('when the files changed after the list was shown, nothing starts and the list is loaded again', async () => {
    const { conn, onClose, answer } = await setup();
    await answer(preflight());
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await act(async () => {
      conn.fail('plan.start', new SmurgError('conflict', msg('plan.start.changed'), { reason: 'plan-changed' }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('The spec or the plan changed while this was open. Nothing was started. Look at the list again before you start.')).toBeTruthy();
    expect(conn.requestsOf('plan.preflight')).toHaveLength(2);
    await answer(preflight({ planRevision: 8, startsNow: ['cart-api'], waits: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(conn.lastRequest('plan.start')?.payload).toMatchObject({ planRevision: 8 });
  });

  it('any other refusal stays in the dialog with its reason', async () => {
    const { conn, onClose, answer } = await setup();
    await answer(preflight());
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await act(async () => {
      conn.fail('plan.start', new SmurgError('conflict', msg('plan.start.commit.busy')));
    });
    expect(screen.getByText(/^Nothing was started: The spec and the plan could not be committed: git is in the middle of another operation/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a failed check can be tried again; the host is led to the shared directories setting', async () => {
    const { conn, answer, openColumn, onClose } = await setup({ role: 'host' });
    await act(async () => {
      conn.fail('plan.preflight', new SmurgError('conflict', msg('topic.archived')));
    });
    expect(screen.getByText('Could not check the plan: This topic is archived. Restore it to continue.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await answer(preflight({ sharedDirs: ['node_modules'] }));
    expect(screen.getByText('Each item gets a fresh checkout. Shared into every checkout: node_modules.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Shared directories' }));
    expect(onClose).toHaveBeenCalled();
    expect(openColumn).toHaveBeenCalledWith({ target: { kind: 'console', section: 'settings' } });
  });
});
