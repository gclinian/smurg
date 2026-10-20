// The strip of an agent session's column, protocol 5 (DESIGN 0.6.0 D9, D18): the mode Claude Code really runs (and
// a warning chip with why when it differs from the one smurg asked for), the model of the agent's latest turn, the
// model dialog (also from a notice's "Choose a model"), and the mode dialog whose first choice follows the topic or
// the workspace.
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SmurgError, type ConversationEvent } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildEvent, buildTopic } from '@smurg/protocol/testing';
import { makeHostState, makeWelcome } from '../../testing/fixtures.ts';
import { SID, openConversation, settle, updateSession } from './test-support.tsx';

const strip = (): HTMLElement => screen.getByRole('group', { name: 'About this session' });

async function open(scene: Parameters<typeof openConversation>[0] = {}) {
  const view = await openConversation(scene);
  act(() => view.conn.emit('session.host', makeHostState()));
  return view;
}

describe('the strip: the model', () => {
  it("names the model of the agent's latest turn by its list name, else the chosen one, else the host's default", async () => {
    const view = await open();
    expect(within(strip()).getByRole('button', { name: 'Model: The host\'s default (claude-opus-5-5)' }).textContent).toBe("The host's default");
    updateSession(view, { model: 'sonnet' });
    expect(within(strip()).getByRole('button', { name: 'Model: Sonnet (sonnet)' }).textContent).toBe('Sonnet');
    updateSession(view, { model: 'sonnet', modelInUse: 'claude-sonnet-5-5' });
    expect(within(strip()).getByRole('button', { name: 'Model: Sonnet (claude-sonnet-5-5)' })).toBeTruthy();
    // A model the list does not know runs: the chosen one is named, the title names what runs.
    updateSession(view, { model: 'opus', modelInUse: 'claude-sonnet-5-5[1m]' });
    expect(within(strip()).getByRole('button', { name: 'Model: Sonnet (claude-sonnet-5-5[1m])' })).toBeTruthy();
    updateSession(view, { model: null, modelInUse: 'claude-unlisted-9' });
    expect(within(strip()).getByRole('button', { name: "Model: The host's default (claude-unlisted-9)" })).toBeTruthy();
  });

  it('the host and members with agent access change it from the strip, from the next turn on; others only read it', async () => {
    const view = await open({ role: 'agent' });
    fireEvent.click(within(strip()).getByRole('button', { name: /^Model:/ }));
    const dialog = screen.getByRole('dialog', { name: 'Model of this session' });
    expect(within(dialog).getByText("A change applies from the agent's next turn.")).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Model' }), { target: { value: 'fable' } });
    expect(view.conn.lastRequest('session.model.set')?.payload).toEqual({ sessionId: SID, model: 'fable' });
    act(() => {
      view.conn.respond('session.model.set', { session: { ...view.agentSession, model: 'fable' } });
    });
    await settle();
    expect(within(dialog).getByText('On some plans this model is billed to usage credits, and Claude Code does not ask first here.')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Model' }), { target: { value: '' } });
    expect(view.conn.lastRequest('session.model.set')?.payload).toEqual({ sessionId: SID, model: null });
    act(() => {
      view.conn.fail('session.model.set', new SmurgError('conflict', msg('session.model.refused', { model: 'x' })));
    });
    await settle();
    expect(within(dialog).getByText(/^That did not work: Claude Code refused to switch to x/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Model of this session' })).toBeNull();
    view.unmount();

    await open({ role: 'editor', session: { model: 'sonnet' } });
    expect(within(strip()).queryByRole('button', { name: /^Model:/ })).toBeNull();
    expect(within(strip()).getByText('Sonnet')).toBeTruthy();
  });

  it('a notice that the model was refused offers "Choose a model", which opens the model dialog', async () => {
    const refused = { ...buildEvent('notice', { seq: 1, level: 'error', action: 'choose-model' }), text: msg('notice.modelRefused', { model: 'Fable' }), fallback: 'Claude Code could not use the model Fable.' } as ConversationEvent;
    await open({ role: 'agent', events: [refused] });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a model' }));
    expect(screen.getByRole('dialog', { name: 'Model of this session' })).toBeTruthy();
    // Nobody but the host and members with agent access may change it: no button for an editor.
  });

  it('no "Choose a model" for an editor', async () => {
    const refused = { ...buildEvent('notice', { seq: 1, level: 'error', action: 'choose-model' }), text: msg('notice.modelRefused', { model: 'Fable' }), fallback: 'x' } as ConversationEvent;
    await open({ role: 'editor', events: [refused] });
    expect(screen.queryByRole('button', { name: 'Choose a model' })).toBeNull();
  });
});

describe('the strip: what really runs', () => {
  it('the mode chip names what Claude Code runs; a warning chip says it differs, and why', async () => {
    const view = await open({ session: { permissionMode: 'auto' } });
    expect(within(strip()).getByRole('button', { name: 'Permission mode: Auto: runs what a check allows' })).toBeTruthy();
    expect(within(strip()).queryByText(/^Claude Code runs it as/)).toBeNull();
    updateSession(view, { permissionMode: 'auto', modeInUse: 'ask-commands', modeFallback: 'model-no-auto' });
    expect(within(strip()).getByRole('button', { name: 'Permission mode: Asks before commands' })).toBeTruthy();
    const warning = within(strip()).getByText('Claude Code runs it as: Asks before commands');
    expect(warning.closest('[title]')?.getAttribute('title')).toBe('The model of this session cannot use auto mode.');
    updateSession(view, { permissionMode: 'ask-nothing', modeInUse: 'auto', modeFallback: 'ask-nothing-off' });
    expect(within(strip()).getByText('Claude Code runs it as: Auto: runs what a check allows').closest('[title]')?.getAttribute('title')).toBe(
      "The host's Claude Code settings do not allow running without asking.",
    );
    // The same mode again: no warning.
    updateSession(view, { permissionMode: 'auto', modeInUse: 'auto', modeFallback: undefined });
    expect(within(strip()).queryByText(/^Claude Code runs it as/)).toBeNull();
  });
});

describe('the strip: the mode dialog', () => {
  it('"Workspace default (…)" comes first and is checked while the session follows; choosing it sends null', async () => {
    const view = await open({ role: 'agent', session: { permissionMode: 'auto', modeChoice: null } });
    fireEvent.click(within(strip()).getByRole('button', { name: /^Permission mode:/ }));
    const dialog = screen.getByRole('dialog', { name: 'What this session may do without asking' });
    const radios = within(dialog).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => radio.parentElement?.textContent?.trim())).toEqual([
      'Workspace default (Auto: runs what a check allows)',
      'Auto: runs what a check allows',
      'Asks before commands',
      'Asks before edits and commands',
    ]);
    expect(radios[0]?.checked).toBe(true);
    expect(within(dialog).getByText("Auto mode checks commands with extra requests to Claude, which may count toward the host's usage.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Asks before commands' }));
    expect(view.conn.lastRequest('session.mode.set')?.payload).toEqual({ sessionId: SID, mode: 'ask-commands' });
    act(() => {
      view.conn.respond('session.mode.set', { session: { ...view.agentSession, permissionMode: 'ask-commands', modeChoice: 'ask-commands' } });
    });
    await settle();
    expect((within(dialog).getByRole('radio', { name: 'Asks before commands' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Workspace default (Auto: runs what a check allows)' }));
    expect(view.conn.lastRequest('session.mode.set')?.payload).toEqual({ sessionId: SID, mode: null });
  });

  it("a work item's session follows its topic's setting", async () => {
    const view = await open({ role: 'agent', session: { purpose: 'item', topicId: 'tp_1', topicName: 'Checkout', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, attempt: 1, permissionMode: 'ask-commands' } });
    act(() => view.conn.emit('topic.updated', { topic: buildTopic({ id: 'tp_1', agent: { model: null, permissionMode: 'ask-commands' } }) }));
    fireEvent.click(within(strip()).getByRole('button', { name: /^Permission mode:/ }));
    const dialog = screen.getByRole('dialog', { name: 'What this session may do without asking' });
    expect(within(dialog).getByRole('radio', { name: "This topic's setting (Asks before commands)" })).toHaveProperty('checked', true);
  });

  it('while the workspace asks for nothing, the dialog says a stricter mode can be chosen', async () => {
    const view = await open({ role: 'agent', session: { permissionMode: 'ask-nothing' } });
    act(() => view.conn.emit('channel.settingsUpdated', { settings: { ...makeWelcome().settings, permissionMode: 'ask-nothing' } }));
    fireEvent.click(within(strip()).getByRole('button', { name: /^Permission mode:/ }));
    const dialog = screen.getByRole('dialog', { name: 'What this session may do without asking' });
    expect(within(dialog).getByRole('radio', { name: 'Workspace default (Asks for nothing)' })).toBeTruthy();
    expect(within(dialog).queryByRole('radio', { name: 'Asks for nothing' })).toBeNull();
    expect(within(dialog).getByText("The host lets this workspace's agents ask for nothing. You can choose a stricter mode for this session.")).toBeTruthy();
  });
});
