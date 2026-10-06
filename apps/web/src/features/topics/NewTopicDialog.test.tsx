// "New topic" (DESIGN §5.12 item 18): the folder field, the roles, and the Claude Code project settings confirmation.
import { SmurgError, type HostState, type Role, type Topic } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { FAKE_HASH, buildAgentSession, buildTopic } from '@smurg/protocol/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import { NewTopicDialog } from './NewTopicDialog.tsx';
import { admitAs, settle, topicConnection } from './testing/support.tsx';
import { decidePayload, neededAcks, trustReady, type ConfigFile, type TrustState } from './TrustBlock.tsx';

const UNDECIDED: HostState = { account: { state: 'ok', sessions: 0 }, mainProjectSettings: 'ignored' };
const SETTINGS: ConfigFile = {
  path: '.claude/settings.json',
  hash: FAKE_HASH,
  decision: null,
  changed: false,
  text: '{ "hooks": {} }',
  runs: ['pnpm lint --fix'],
  permissions: ['Bash(pnpm test:*)'],
  env: [{ name: 'ANTHROPIC_BASE_URL', flagged: true }],
  otherKeys: ['model'],
  scripts: [],
  needsAck: ['credentials', 'allows-tools'],
};

async function setup(options: { role?: Role; topics?: Topic[]; host?: HostState } = {}) {
  const world = { role: options.role ?? ('agent' as Role), topics: options.topics ?? [], ...(options.host ? { host: options.host } : {}) };
  const conn = topicConnection(world);
  const context = createTestWorkspace({ conn, admit: false });
  const openColumn = vi.fn();
  context.session.commands.handle('openColumn', openColumn);
  admitAs(conn, world);
  await settle();
  const onClose = vi.fn();
  render(
    <WorkspaceTestProviders context={context}>
      <NewTopicDialog onClose={onClose} />
    </WorkspaceTestProviders>,
  );
  const dialog = screen.getByRole('dialog', { name: 'New topic' });
  const field = (name: string | RegExp): HTMLInputElement => within(dialog).getByLabelText(name) as HTMLInputElement;
  const start = (): HTMLButtonElement => within(dialog).getByRole('button', { name: 'Start discussion' }) as HTMLButtonElement;
  return { ...context, conn, openColumn, onClose, dialog, field, start };
}

describe('New topic: the form', () => {
  it('fills the folder from the name, keeps it editable, and starts the discussion with the first message', async () => {
    const { conn, field, start, openColumn, onClose } = await setup();
    expect(document.activeElement).toBe(field('Name'));
    expect(start().disabled).toBe(true);
    fireEvent.change(field('Name'), { target: { value: 'Checkout redesign' } });
    expect(field(/^Folder for the spec and the plan/).value).toBe('checkout-redesign');
    expect(screen.getByText(/SPEC\.md and PLAN\.md will be files in specs\/checkout-redesign\//)).toBeTruthy();
    fireEvent.change(field(/^What do you want to build/), { target: { value: 'One page instead of three steps.' } });
    fireEvent.click(start());
    expect(conn.lastRequest('topic.create')?.payload).toEqual({ name: 'Checkout redesign', slug: 'checkout-redesign', firstMessage: 'One page instead of three steps.' });
    await act(async () => {
      conn.respond('topic.create', {
        topic: buildTopic({ id: 'tp_9', name: 'Checkout redesign', slug: 'checkout-redesign', discussionSessionId: 'sess_new' }),
        session: buildAgentSession({ id: 'sess_new', purpose: 'discussion', topicId: 'tp_9', topicName: 'Checkout redesign' }),
      });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openColumn).toHaveBeenCalledWith({ target: { kind: 'session', sessionId: 'sess_new' } });
  });

  it('a name without Latin letters gets "topic-<n>", with the reason; a folder someone typed is kept', async () => {
    const { field, conn, start } = await setup({ topics: [buildTopic({ slug: 'topic-1' })] });
    fireEvent.change(field('Name'), { target: { value: '結帳流程改版' } });
    expect(field(/^Folder/).value).toBe('topic-2');
    expect(screen.getByText(/The folder name uses Latin letters; the topic keeps its own name\./)).toBeTruthy();
    fireEvent.change(field(/^Folder/), { target: { value: 'checkout' } });
    fireEvent.change(field('Name'), { target: { value: '結帳流程改版 v2' } });
    expect(field(/^Folder/).value).toBe('checkout');
    fireEvent.change(field(/^Folder/), { target: { value: 'Check Out' } });
    expect(screen.getByText('Use lower-case letters, digits and hyphens, starting with a letter or a digit.')).toBeTruthy();
    expect(start().disabled).toBe(true);
    fireEvent.change(field(/^Folder/), { target: { value: 'checkout' } });
    fireEvent.click(start());
    // No first message was typed: none is sent.
    expect(conn.lastRequest('topic.create')?.payload).toEqual({ name: '結帳流程改版 v2', slug: 'checkout' });
  });

  it('a refusal about the folder stands under its field and the dialog stays open; any other one is a banner', async () => {
    const { conn, field, start, onClose, dialog } = await setup();
    fireEvent.change(field('Name'), { target: { value: 'Checkout' } });
    fireEvent.click(start());
    await act(async () => {
      conn.fail('topic.create', new SmurgError('conflict', msg('topic.folderExists', { path: 'specs/checkout' })));
    });
    expect(onClose).not.toHaveBeenCalled();
    const error = within(dialog).getByText('The folder specs/checkout already exists. Choose another name.');
    expect(error.id).toBe(`${field(/^Folder/).id}-error`);
    fireEvent.change(field(/^Folder/), { target: { value: 'checkout-2' } });
    expect(within(dialog).queryByText('The folder specs/checkout already exists. Choose another name.')).toBeNull();
    fireEvent.click(start());
    await act(async () => {
      conn.fail('topic.create', new SmurgError('conflict', msg('topic.limit', { max: 200 })));
    });
    expect(within(dialog).getByText(/^The topic was not created: This workspace already has 200 topics\./)).toBeTruthy();
  });
});

describe('New topic: who may start one', () => {
  it('an editor and a viewer get the explanation instead of the form', async () => {
    const editor = await setup({ role: 'editor' });
    expect(within(editor.dialog).getByText(/^With the role Editor you cannot start a topic: starting one opens an agent session on the host's computer\./)).toBeTruthy();
    expect(within(editor.dialog).queryByLabelText('Name')).toBeNull();
    fireEvent.click(within(editor.dialog).getByRole('button', { name: 'Close' }));
    expect(editor.onClose).toHaveBeenCalled();
  });

  it('a viewer reads what a viewer can do', async () => {
    const viewer = await setup({ role: 'viewer' });
    expect(within(viewer.dialog).getByText(/^With the role Viewer you cannot start a topic\. When the host or a member with agent access starts one/)).toBeTruthy();
  });
});

describe('New topic: the Claude Code project settings', () => {
  it('a member who is not the host is told the session runs without them until the host confirms', async () => {
    const { dialog, conn } = await setup({ role: 'agent', host: UNDECIDED });
    expect(within(dialog).getByText("The host has not confirmed this folder's Claude Code project settings. The discussion will run without them and without the project's CLAUDE.md until Ian confirms.")).toBeTruthy();
    expect(conn.requestsOf('admin.claudeConfig.get')).toHaveLength(0);
  });

  it('the host confirms inside the dialog: what the files do, the ticks "Use them" needs, then the decision before the topic', async () => {
    const { dialog, conn, field, start } = await setup({ role: 'host', host: UNDECIDED });
    expect(within(dialog).getByText("Reading the folder's Claude Code project settings…")).toBeTruthy();
    await act(async () => {
      conn.respond('admin.claudeConfig.get', { roots: [{ root: { kind: 'main' }, state: 'ignored', files: [SETTINGS] }], hasMore: false });
    });
    const trust = within(dialog).getByRole('group', { name: 'This folder has Claude Code project settings' });
    expect(within(trust).getByText('pnpm lint --fix')).toBeTruthy();
    expect(within(trust).getByText('Bash(pnpm test:*)')).toBeTruthy();
    expect(within(trust).getByText('ANTHROPIC_BASE_URL')).toBeTruthy();
    expect(within(trust).getByText('can send your Claude login to another server')).toBeTruthy();
    expect(within(trust).getByText(/These commands run as you, on your computer, whenever an agent works here\./)).toBeTruthy();
    // The cautious choice is the default.
    expect((within(trust).getByRole('radio', { name: /^Run without them/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(trust).getByRole('button', { name: 'Show the files' }));
    expect(within(trust).getByRole('region', { name: '.claude/settings.json' }).textContent).toContain('{ "hooks": {} }');

    fireEvent.change(field('Name'), { target: { value: 'Checkout' } });
    fireEvent.click(within(trust).getByRole('radio', { name: 'Use them' }));
    expect(start().disabled).toBe(true);
    fireEvent.click(within(trust).getByRole('checkbox', { name: 'I see that these settings can send my Claude login to another server.' }));
    fireEvent.click(within(trust).getByRole('checkbox', { name: 'I see that these settings let agents run tools without asking.' }));
    expect(start().disabled).toBe(false);
    fireEvent.click(start());
    expect(conn.lastRequest('admin.claudeConfig.decide')?.payload).toEqual({
      root: { kind: 'main' },
      files: [{ path: '.claude/settings.json', hash: FAKE_HASH }],
      decision: 'trust',
      acknowledged: ['credentials', 'allows-tools'],
    });
    expect(conn.requestsOf('topic.create')).toHaveLength(0);
    await act(async () => {
      conn.respond('admin.claudeConfig.decide', {});
    });
    expect(conn.lastRequest('topic.create')?.payload).toEqual({ name: 'Checkout', slug: 'checkout' });
  });

  it('"Run without them" needs no tick; a decision that is refused stops before the topic is created', async () => {
    const { dialog, conn, field, start } = await setup({ role: 'host', host: UNDECIDED });
    await act(async () => {
      conn.respond('admin.claudeConfig.get', { roots: [{ root: { kind: 'main' }, state: 'ignored', files: [SETTINGS] }], hasMore: false });
    });
    fireEvent.change(field('Name'), { target: { value: 'Checkout' } });
    fireEvent.click(start());
    expect(conn.lastRequest('admin.claudeConfig.decide')?.payload).toMatchObject({ decision: 'ignore', acknowledged: [] });
    await act(async () => {
      conn.fail('admin.claudeConfig.decide', new SmurgError('conflict', msg('topic.notStarted')));
    });
    expect(within(dialog).getByText(/^The Claude Code settings could not be confirmed: /)).toBeTruthy();
    expect(conn.requestsOf('topic.create')).toHaveLength(0);
  });

  it('nothing undecided: no block, the topic is created directly', async () => {
    const { dialog, conn } = await setup({ role: 'host', host: UNDECIDED });
    await act(async () => {
      conn.respond('admin.claudeConfig.get', { roots: [{ root: { kind: 'main' }, state: 'used', files: [{ ...SETTINGS, decision: 'trust' }] }], hasMore: false });
    });
    expect(within(dialog).queryByRole('group', { name: 'This folder has Claude Code project settings' })).toBeNull();
  });
});

describe('the trust choice', () => {
  const state = (overrides: Partial<TrustState> = {}): TrustState => ({ files: [SETTINGS], choice: 'trust', acknowledged: [], ...overrides });
  it('"Use them" is ready only with every tick the files need', () => {
    expect(neededAcks([SETTINGS, { ...SETTINGS, path: '.mcp.json', needsAck: ['allows-tools'] }])).toEqual(['credentials', 'allows-tools']);
    expect(trustReady(state())).toBe(false);
    expect(trustReady(state({ acknowledged: ['credentials'] }))).toBe(false);
    expect(trustReady(state({ acknowledged: ['allows-tools', 'credentials'] }))).toBe(true);
    expect(trustReady(state({ choice: 'ignore' }))).toBe(true);
    expect(decidePayload(state({ choice: 'ignore', acknowledged: ['credentials'] })).acknowledged).toEqual([]);
  });
});
