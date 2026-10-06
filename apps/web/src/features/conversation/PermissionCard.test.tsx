// The permission card by who looks at it (UX §5.2, DESIGN §5.12 item 14): what is asked is shown whole, the host
// and members with agent access answer, "Always allow this kind" asks where, a kind that cannot be remembered says
// why, everyone else reads who can.
import { act, fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, SmurgError, settledError, type ConversationEvent, type PermissionRequest } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildEvent, buildPermission, FAKE_NOW } from '@smurg/protocol/testing';
import { IAN, MEI, SID, openConversation, settle, type Scene } from './test-support.tsx';

const CARD: ConversationEvent[] = [buildEvent('card', { seq: 1, card: 'permission', id: 'pr_1' })];

async function openPermission(request: Partial<PermissionRequest>, scene: Scene = {}) {
  const view = await openConversation({
    session: { status: 'waiting-permission', waitingSince: FAKE_NOW, ...scene.session },
    events: CARD,
    ...scene,
    reply: { permissions: [buildPermission({ id: 'pr_1', sessionId: SID, askedAt: Date.now() - 40_000, ...request })] },
  });
  return { ...view, card: document.getElementById('conv-card-pr_1') as HTMLElement };
}

describe('permission card: those who may answer', () => {
  it('shows the command whole and allows it once', async () => {
    const view = await openPermission({ command: 'pnpm test cart --reporter=verbose', reason: 'It runs the tests.' }, { role: 'agent', session: { responsible: MEI } });
    const { card } = view;
    expect(within(card).getByRole('heading', { level: 3, name: 'Claude asks for permission to run a command' })).toBeTruthy();
    expect(card.textContent).toContain('waiting 40 sec');
    expect(card.querySelector('.conv-perm__cmd')?.textContent).toBe('pnpm test cart --reporter=verbose');
    expect(card.textContent).toContain('In the main workspace');
    expect(card.textContent).toContain("Claude Code's reason: It runs the tests.");
    expect(card.textContent).toContain('It is in your inbox: you are responsible.');
    // The focus never starts on a button of the card.
    expect(document.activeElement?.tagName).not.toBe('BUTTON');

    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    expect(view.conn.lastRequest('permission.decide')?.payload).toEqual({ requestId: 'pr_1', decision: 'allow' });
    act(() => {
      view.conn.respond('permission.decide', { request: buildPermission({ id: 'pr_1', sessionId: SID, status: 'allowed', decision: { by: MEI, at: FAKE_NOW } }) });
    });
    await settle();
    const settled = document.getElementById('conv-card-pr_1') as HTMLElement;
    expect(settled.className).toContain('ui-card--settled');
    expect(settled.textContent).toMatch(/Allowed once by Mei, /);
    expect(within(settled).queryByRole('button')).toBeNull();
  });

  it('"Always allow this kind" says what the kind is and asks where: this session, or every session of the topic', async () => {
    const view = await openPermission({}, { role: 'host', session: { purpose: 'item', topicId: 't_1', topicName: 'Checkout', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, attempt: 1, responsible: MEI } });
    const { card } = view;
    expect(card.textContent).toContain('"This kind" is: commands that start with pnpm test. It also covers the same command after Claude changes the files it runs.');
    expect(card.textContent).toContain("It is in Mei's inbox (responsible). You can answer too");
    const scope = within(card).getByRole('radiogroup', { name: 'Where "always" applies' });
    expect((within(scope).getByRole('radio', { name: 'in this session' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(scope).getByRole('radio', { name: 'in every session of this topic' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Always allow this kind' }));
    expect(view.conn.lastRequest('permission.decide')?.payload).toEqual({ requestId: 'pr_1', decision: 'allow-always', scope: 'topic' });
    act(() => {
      view.conn.respond('permission.decide', {
        request: buildPermission({ id: 'pr_1', sessionId: SID, status: 'allowed', decision: { by: IAN, at: FAKE_NOW, always: 'topic' } }),
      });
    });
    await settle();
    expect(document.getElementById('conv-card-pr_1')?.textContent).toMatch(/Allowed, and always for Bash\(pnpm test \*\) in every session of this topic, by Ian, /);
  });

  it('a free session has no topic to allow for; a kind that cannot be remembered says why', async () => {
    const free = await openPermission({}, { role: 'agent' });
    expect(within(free.card).queryByRole('radiogroup')).toBeNull();
    expect(free.card.textContent).toContain('It is in the inbox of the host and of every member with agent access.');
    fireEvent.click(within(free.card).getByRole('button', { name: 'Always allow this kind' }));
    expect(free.conn.lastRequest('permission.decide')?.payload).toEqual({ requestId: 'pr_1', decision: 'allow-always', scope: 'session' });
    free.unmount();

    const add = await openPermission({ command: 'pnpm add left-pad', alwaysRule: undefined, noAlways: 'fetches-code' }, { role: 'agent' });
    expect(within(add.card).queryByRole('button', { name: 'Always allow this kind' })).toBeNull();
    expect(add.card.textContent).toContain('pnpm add downloads and runs code: it cannot be always allowed.');
    add.unmount();

    const node = await openPermission({ command: 'node build.js', alwaysRule: undefined, noAlways: 'interpreter' }, { role: 'agent' });
    expect(node.card.textContent).toContain('node can run any code: it cannot be always allowed.');
  });

  it('Deny opens one optional line that the agent reads', async () => {
    const view = await openPermission({}, { role: 'host' });
    const { card } = view;
    fireEvent.click(within(card).getByRole('button', { name: 'Deny' }));
    expect(view.conn.requestsOf('permission.decide')).toHaveLength(0);
    const reason = within(card).getByRole('textbox', { name: 'What should Claude do instead? (optional)' });
    fireEvent.change(reason, { target: { value: 'Run only the cart tests' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Deny' }));
    expect(view.conn.lastRequest('permission.decide')?.payload).toEqual({ requestId: 'pr_1', decision: 'deny', message: 'Run only the cart tests' });
    act(() => {
      view.conn.respond('permission.decide', {
        request: buildPermission({ id: 'pr_1', sessionId: SID, status: 'denied', decision: { by: IAN, at: FAKE_NOW, message: 'Run only the cart tests' } }),
      });
    });
    await settle();
    expect(document.getElementById('conv-card-pr_1')?.textContent).toMatch(/Denied by Ian, .*: "Run only the cart tests"/);
  });

  it('an edit shows its diff, another tool its whole input, and hidden characters are made visible', async () => {
    const edit = await openPermission(
      { tool: 'Edit', what: 'edit', command: undefined, file: { root: MAIN_ROOT, path: 'src/cart.ts' }, change: { text: '--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1,1 +1,1 @@\n-old\n+new' }, alwaysRule: undefined, noAlways: 'no-suggestion' },
      { role: 'host' },
    );
    expect(within(edit.card).getByRole('heading', { name: 'Claude asks for permission to edit a file' })).toBeTruthy();
    expect(edit.card.textContent).toContain('src/cart.ts');
    const diff = within(edit.card).getByLabelText('Changes to src/cart.ts');
    expect(diff.querySelectorAll('.conv-diff__line--add')).toHaveLength(1);
    expect(edit.card.textContent).toContain('This kind of request cannot be always allowed.');
    edit.unmount();

    const other = await openPermission({ tool: 'mcp__db__query', what: 'other', command: undefined, input: '{\n  "sql": "select 1"\n}', alwaysRule: undefined, noAlways: 'no-suggestion' }, { role: 'host' });
    expect(within(other.card).getByRole('heading', { name: 'Claude asks for permission to use mcp__db__query' })).toBeTruthy();
    expect(within(other.card).getByLabelText('What mcp__db__query was given').textContent).toBe('{\n  "sql": "select 1"\n}');
    other.unmount();

    const hidden = await openPermission({ command: `echo safe${String.fromCharCode(0x202e)}${String.fromCharCode(0x1b)}[2K` }, { role: 'host' });
    expect(hidden.card.querySelector('.conv-perm__cmd')?.textContent).toBe(`echo safe${String.fromCharCode(0x27e6)}U+202E${String.fromCharCode(0x27e7)}${String.fromCharCode(0x241b)}[2K`);
  });

  it('a file that is busy keeps the card open and says so; an answer that came second is told who was first', async () => {
    const view = await openPermission({}, { role: 'host' });
    fireEvent.click(within(view.card).getByRole('button', { name: 'Allow once' }));
    act(() => {
      view.conn.fail('permission.decide', new SmurgError('locked', msg('permission.fileBusy', { holders: ['Amy'] })));
    });
    await settle();
    expect(view.card.textContent).toContain('Not allowed yet: Amy is typing in that file.');
    expect((within(view.card).getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(within(view.card).getByRole('button', { name: 'Allow once' }));
    act(() => {
      view.conn.fail('permission.decide', settledError({ card: { kind: 'permission', id: 'pr_1' }, sessionId: SID, status: 'allowed', by: MEI }));
    });
    await settle();
    expect(view.card.textContent).toContain('Mei already allowed this.');
  });
});

describe('permission card: the others', () => {
  it('an Editor and a viewer read the command and who can answer', async () => {
    const editor = await openPermission({}, { role: 'editor', session: { responsible: MEI } });
    expect(editor.card.querySelector('.conv-perm__cmd')?.textContent).toBe('pnpm test');
    expect(within(editor.card).queryByRole('button')).toBeNull();
    expect(editor.card.textContent).toContain('Waiting for Mei (responsible), the host or a member with agent access. Your role cannot allow this.');
    editor.unmount();

    const viewer = await openPermission({}, { role: 'viewer' });
    expect(within(viewer.card).queryByRole('button')).toBeNull();
    expect(viewer.card.textContent).toContain('Waiting for the host or a member with agent access. Your role cannot allow this.');
  });

  it('a request only the host can allow: a member with agent access reads that, the host answers and sees the path', async () => {
    const outside = { tool: 'Read', what: 'outside' as const, command: undefined, outside: true as const, hostOnly: true, alwaysRule: undefined, noAlways: 'host-only' as const };
    const mei = await openPermission(outside, { role: 'agent' });
    expect(within(mei.card).getByRole('heading', { name: 'Claude asks for permission to use a file outside the workspace' })).toBeTruthy();
    expect(mei.card.textContent).toContain('a file outside the workspace');
    expect(within(mei.card).queryByRole('button')).toBeNull();
    expect(mei.card.textContent).toContain('Only the host can allow this: it reaches beyond the shared project.');
    mei.unmount();

    const host = await openPermission({ ...outside, path: '/Users/ian/.npmrc' }, { role: 'host' });
    expect(host.card.textContent).toContain('/Users/ian/.npmrc');
    expect(host.card.textContent).toContain('Only you, the host, can allow this');
    expect(host.card.textContent).toContain('What only the host can allow cannot be always allowed.');
    expect(within(host.card).getByRole('button', { name: 'Allow once' })).toBeTruthy();
    expect(within(host.card).queryByRole('button', { name: 'Always allow this kind' })).toBeNull();
  });

  it('once escalated it says who has not answered; a withdrawn request says why', async () => {
    const escalated = await openPermission({ askedAt: Date.now() - 6 * 60_000 - 5_000, escalatedAt: Date.now() }, { role: 'host', session: { responsible: MEI } });
    expect(escalated.card.textContent).toContain('Mei has not answered for 6 min.');
    escalated.unmount();

    const withdrawn = await openPermission({ status: 'withdrawn', withdrawn: { reason: 'ended', at: FAKE_NOW } }, { role: 'host' });
    expect(withdrawn.card.textContent).toContain('Not answered: the session ended.');
    expect(withdrawn.card.querySelector('.conv-perm__cmd')?.textContent).toBe('pnpm test');
  });
});
