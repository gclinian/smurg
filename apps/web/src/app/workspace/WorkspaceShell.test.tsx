// The workspace shell (DESIGN §5.1, AD-12; UX §1, §2, §11, §12): the mode is a route, both views stay mounted, the
// commands that move between them, the overlays, the tab's title, F6, and the empty states of the right side.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAIN_ROOT, type InboxItem, type Role, type SessionInfo, type Topic } from '@smurg/protocol';
import { buildInboxItem, buildTopic } from '@smurg/protocol/testing';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CommandMap } from '../../lib/commands.ts';
import { createSlotRegistry, type FeatureSlots } from '../../lib/slots.ts';
import { useCommandHandler } from '../../lib/workspace/context.tsx';
import { CART, DISCUSSION, FREE, PROBES, TERMINAL, TOPIC } from '../../features/columns/test-support.tsx';
import { WORKSPACE_ID, makeConflict, makeWelcome } from '../../testing/fixtures.ts';
import { createTestServices } from '../../testing/services.tsx';
import { answerLoads } from '../../testing/stores.ts';
import { ToastProvider } from '../../ui/index.ts';
import { useRoute } from '../navigation.tsx';
import { AppServicesProvider } from '../services.tsx';
import { topicNoticeTarget } from './useWorkspaceNotices.ts';
import WorkspaceRoute from './WorkspaceRoute.tsx';

const SESSIONS_PATH = `/w/${WORKSPACE_ID}`;
const CODE_PATH = `/w/${WORKSPACE_ID}/code`;

function Routed({ slots }: { slots: readonly FeatureSlots[] }) {
  const route = useRoute();
  if (route.name !== 'workspace' && route.name !== 'code' && route.name !== 'console') return <p>{`elsewhere: ${route.name}`}</p>;
  return (
    <WorkspaceRoute
      key={route.workspaceId}
      workspaceId={route.workspaceId}
      view={route.name === 'workspace' ? 'sessions' : route.name}
      {...(route.name === 'console' && route.section !== undefined ? { section: route.section } : {})}
      slots={REGISTRIES.get(slots) ?? REGISTRIES.set(slots, createSlotRegistry(slots)).get(slots)!}
    />
  );
}
const REGISTRIES = new Map<readonly FeatureSlots[], ReturnType<typeof createSlotRegistry>>();
const DEFAULT_SLOTS: readonly FeatureSlots[] = [PROBES];

interface OpenOptions {
  path?: string;
  role?: Role;
  slots?: readonly FeatureSlots[];
  sessions?: readonly SessionInfo[];
  topics?: readonly Topic[];
  inbox?: readonly InboxItem[];
}

async function open(options: OpenOptions = {}) {
  const services = createTestServices({ path: options.path ?? SESSIONS_PATH });
  render(
    <AppServicesProvider services={services}>
      <ToastProvider>
        <Routed slots={options.slots ?? DEFAULT_SLOTS} />
      </ToastProvider>
    </AppServicesProvider>,
  );
  await waitFor(() => expect(services.connections).toHaveLength(1));
  const { conn } = services.connections[0]!;
  act(() => conn.admit(makeWelcome({ role: options.role ?? 'host' })));
  await act(async () => {
    answerLoads(conn, {
      'session.list': { sessions: options.sessions ?? [DISCUSSION, CART, FREE, TERMINAL], hasMore: false },
      'topic.list': { topics: options.topics ?? [TOPIC], hasMore: false },
      'inbox.list': { items: options.inbox ?? [], hasMore: false },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  const session = services.manager.peek(WORKSPACE_ID)!;
  const dispatch = <K extends keyof CommandMap>(name: K, payload: CommandMap[K]) => act(async () => void (await session.commands.dispatch(name, payload)));
  return { services, conn, session, stores: session.stores, dispatch, path: () => services.router.getState().pathname };
}

const view = (name: 'sessions' | 'code'): HTMLElement => document.querySelector(`.app-shell__view[data-view="${name}"]`) as HTMLElement;
const topbar = (): HTMLElement => screen.getByRole('banner', { name: 'Workspace' });
const modeLink = (name: string | RegExp): HTMLElement => within(within(topbar()).getByRole('group', { name: 'Mode' })).getByRole('link', { name });
const columnNames = (): (string | null)[] => [...view('sessions').querySelectorAll('[data-column-id]')].map((element) => element.getAttribute('aria-label'));
const isShown = (element: HTMLElement): boolean => !element.hidden && !element.hasAttribute('inert');

describe('the workspace shell: the mode is a route and both views stay mounted', () => {
  it('/w/:id is the sessions view: the main screen, with one layout toggle for the left column', async () => {
    await open();
    expect(isShown(view('sessions'))).toBe(true);
    expect(view('code').hidden).toBe(true);
    expect(view('code').hasAttribute('inert')).toBe(true);
    // Code mode's chunk is not loaded until code mode is shown.
    expect(view('code').childElementCount).toBe(0);
    expect(modeLink('Sessions').getAttribute('aria-current')).toBe('page');
    expect(modeLink('Code mode').hasAttribute('aria-current')).toBe(false);
    expect(modeLink('Code mode').getAttribute('href')).toBe(CODE_PATH);
    const toggles = within(topbar()).getByRole('group', { name: 'Layout' });
    expect(within(toggles).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Show or hide the inbox and the session list']);
    expect(document.querySelector('.app-shell')?.getAttribute('data-mode')).toBe('sessions');
  });

  it('the switch changes the route; the hidden view keeps everything it had', async () => {
    const mounts = vi.fn();
    const Counting = () => {
      useEffect(() => {
        mounts('mount');
        return () => mounts('unmount');
      }, []);
      return <p>conversation body</p>;
    };
    const { path, dispatch } = await open({ slots: [{ feature: 'counting', columns: { conversation: Counting } }] });
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_cart' } });
    expect(mounts.mock.calls).toEqual([['mount']]);

    await userEvent.click(modeLink('Code mode'));
    expect(path()).toBe(CODE_PATH);
    expect(await screen.findByRole('main', { name: 'Editor' }, { timeout: 15_000 })).toBeTruthy();
    expect(isShown(view('code'))).toBe(true);
    expect(view('sessions').hidden).toBe(true);
    expect(view('sessions').hasAttribute('inert')).toBe(true);
    expect(modeLink('Code mode').getAttribute('aria-current')).toBe('page');
    // The column is still there, hidden: nothing was unmounted, no draft is lost.
    expect(columnNames()).toEqual(['1 · Cart API']);
    expect(mounts.mock.calls).toEqual([['mount']]);
    // Code mode has its three toggles.
    const toggles = within(topbar()).getByRole('group', { name: 'Layout' });
    expect(within(toggles).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Show or hide files',
      'Show or hide activity, transfers and terminal',
      'Show or hide the session beside the editor',
    ]);
    expect(screen.getByRole('tablist', { name: 'Activity, transfers and terminal' })).toBeTruthy();
    expect(within(screen.getByRole('tablist', { name: 'Activity, transfers and terminal' })).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Activity', 'Conflicts', 'Transfers', 'Terminal']);

    await userEvent.click(modeLink('Sessions'));
    expect(path()).toBe(SESSIONS_PATH);
    expect(isShown(view('sessions'))).toBe(true);
    // Code mode stays mounted behind it.
    expect(view('code').hidden).toBe(true);
    expect(within(view('code')).getByRole('main', { name: 'Editor', hidden: true })).toBeTruthy();
    expect(mounts.mock.calls).toEqual([['mount']]);
  }, 30_000);

  it('a reload keeps the mode: /w/:id/code opens code mode, with the sessions view mounted behind it', async () => {
    await open({ path: CODE_PATH });
    expect(await screen.findByRole('main', { name: 'Editor' }, { timeout: 15_000 })).toBeTruthy();
    expect(isShown(view('code'))).toBe(true);
    expect(view('sessions').hidden).toBe(true);
    expect(within(view('sessions')).getByRole('complementary', { name: 'Inbox and sessions', hidden: true })).toBeTruthy();
    expect(modeLink('Code mode').getAttribute('aria-current')).toBe('page');
  }, 30_000);

  it('while code mode is on screen the "Sessions" segment carries the two inbox counts; in the sessions view it does not', async () => {
    const inbox = [buildInboxItem('question'), buildInboxItem('permission'), buildInboxItem('report')];
    const { conn, dispatch } = await open({ inbox });
    expect(modeLink('Sessions').querySelector('.inbox-counts')).toBeNull();
    await dispatch('setMode', { mode: 'code' });
    const sessions = modeLink('Sessions: 2 waiting, 1 to look at');
    expect(sessions.querySelector('[data-count="waiting"]')?.textContent).toBe('2');
    expect(sessions.querySelector('[data-count="look"]')?.textContent).toBe('1');
    act(() => conn.emit('inbox.changed', { upsert: [], remove: ['question:q_1', 'permission:pr_1', 'report:tp_1.cart-api'] }));
    expect(modeLink('Sessions').querySelector('.inbox-counts')).toBeNull();
  }, 30_000);

  it('open conflicts are counted on the "Code mode" segment while the sessions view is on screen', async () => {
    const { conn } = await open();
    expect(modeLink('Code mode').querySelector('.ui-count')).toBeNull();
    act(() => conn.emit('doc.conflict', { conflict: makeConflict() }));
    expect(modeLink('Code mode: 1 open conflict').querySelector('.ui-count')?.textContent).toBe('1');
  });

  it('the browser tab says how many things agents are stopped on', async () => {
    const { conn } = await open({ inbox: [buildInboxItem('question'), buildInboxItem('permission'), buildInboxItem('report')] });
    expect(document.title).toBe('(2 waiting) class-project · smurg');
    act(() => conn.emit('inbox.changed', { upsert: [], remove: ['question:q_1', 'permission:pr_1'] }));
    expect(document.title).toBe('class-project · smurg');
  });

  it('the layout toggle folds the left column to its rail and the fold is remembered in this browser', async () => {
    await open();
    const toggle = within(topbar()).getByRole('button', { name: 'Show or hide the inbox and the session list' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const pane = screen.getByRole('complementary', { name: 'Inbox and sessions' }).closest('.ui-split__pane') as HTMLElement;
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(pane.style.width).toBe('44px');
    expect((document.querySelector('.sidebar-rail') as HTMLElement).hidden).toBe(false);
    expect(JSON.parse(window.localStorage.getItem('smurg.layout') as string)).toMatchObject({ left: false, inbox: true, sessions: true });
    // A rail button brings the column back.
    await userEvent.click(within(document.querySelector('.sidebar-rail') as HTMLElement).getByRole('button', { name: /^Inbox:/ }));
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(pane.style.width).toBe('288px');
  });
});

describe('the workspace shell: commands', () => {
  it('openColumn shows a thing in a column; a row of the session list does the same', async () => {
    const { dispatch, stores } = await open();
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_cart' } });
    expect(columnNames()).toEqual(['1 · Cart API']);
    await dispatch('openColumn', { target: { kind: 'spec', topicId: 't1' }, side: true });
    expect(columnNames()).toEqual(['1 · Cart API', 'Spec']);
    await userEvent.click(screen.getByText('Fix flaky CI test'));
    // Replaces what the focused column showed.
    expect(columnNames()).toEqual(['1 · Cart API', 'Fix flaky CI test']);
    expect(stores.columns.getState().focusedId).toBe('session:s_free');
    // The anchor travels to the body.
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_cart' }, from: 'inbox', anchor: { cardId: 'q_1' } });
    expect(within(screen.getByTestId('body-session:s_cart')).getByRole('button', { name: 'anchor q_1' })).toBeTruthy();
  });

  it('the plan of a topic that is executing is pinned when it is opened; another plan is not', async () => {
    const spec = buildTopic({ id: 't2', name: 'Search filters', phase: 'spec' });
    const { dispatch, stores } = await open({ topics: [TOPIC, spec] });
    await dispatch('openColumn', { target: { kind: 'plan', topicId: 't1' } });
    await dispatch('openColumn', { target: { kind: 'plan', topicId: 't2' }, side: true });
    expect(stores.columns.getState().columns.map((column) => [column.id, column.pinned])).toEqual([['plan:t1', true], ['plan:t2', false]]);
  });

  it('from code mode, openColumn comes back to the sessions view; a console section is its own page', async () => {
    const { dispatch, path } = await open({ path: CODE_PATH });
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_free' } });
    expect(path()).toBe(SESSIONS_PATH);
    expect(isShown(view('sessions'))).toBe(true);
    expect(columnNames()).toEqual(['Fix flaky CI test']);
    await dispatch('openColumn', { target: { kind: 'console', section: 'claude-config' } });
    expect(path()).toBe(`/w/${WORKSPACE_ID}/console/claude-config`);
    expect(await screen.findByRole('main', { name: 'Host console' })).toBeTruthy();
  }, 30_000);

  it('setMode switches the route, once', async () => {
    const { dispatch, path, services } = await open();
    await dispatch('setMode', { mode: 'code' });
    expect(path()).toBe(CODE_PATH);
    await dispatch('setMode', { mode: 'code' });
    expect(services.router.entries.filter((entry) => entry === CODE_PATH)).toHaveLength(1);
    await dispatch('setMode', { mode: 'sessions' });
    expect(path()).toBe(SESSIONS_PATH);
  }, 30_000);

  it('openInCodeMode: code mode on that root with the file open, the session beside the editor, and the way back', async () => {
    const { dispatch, path, stores, session } = await open();
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_cart' } });
    const opened = vi.fn();
    session.commands.observe('openFile', opened);
    const root = { kind: 'worktree', worktreeId: 'wt_1' } as const;
    // Not awaited inside act(): the command finishes only when the editor exists, and the editor mounts only when
    // React may render code mode's chunk.
    act(() => void session.commands.dispatch('openInCodeMode', { root, file: 'src/cart.ts', line: 12, sessionId: 's_cart' }).catch(() => {}));
    expect(path()).toBe(CODE_PATH);
    expect(stores.files.getState().activeRoot).toEqual(root);
    expect(stores.columns.getState().code).toEqual({ sessionId: 's_cart', origin: { root, sessionId: 's_cart', path: 'src/cart.ts' } });
    // The editor was asked once it existed (its chunk loads with code mode).
    await waitFor(() => expect(opened).toHaveBeenCalledWith({ file: { root, path: 'src/cart.ts' }, line: 12 }), { timeout: 15_000 });
    // The same session is beside the editor, with the body of a column of its kind.
    const side = within(view('code')).getByRole('region', { name: '1 · Cart API' });
    expect(within(side).getByTestId('body-session:s_cart').getAttribute('data-place')).toBe('code');
    // "Opened from … · Back to the session".
    const origin = view('code').querySelector('[data-code-origin]') as HTMLElement;
    expect(origin.textContent).toContain('Opened from 1 · Cart API');
    await userEvent.click(within(origin).getByRole('button', { name: 'Back to the session' }));
    expect(path()).toBe(SESSIONS_PATH);
    expect(stores.columns.getState()).toMatchObject({ focusedId: 'session:s_cart', code: { origin: null } });
    expect(view('code').querySelector('[data-code-origin]')).toBeNull();
  }, 30_000);

  it('openInCodeMode without a file or a session only changes the root and the mode', async () => {
    const { dispatch, path, stores } = await open();
    await dispatch('openInCodeMode', { root: MAIN_ROOT });
    expect(path()).toBe(CODE_PATH);
    expect(stores.columns.getState().code).toEqual({ sessionId: null, origin: { root: MAIN_ROOT } });
    await screen.findByRole('main', { name: 'Editor' }, { timeout: 15_000 });
    const origin = view('code').querySelector('[data-code-origin]') as HTMLElement;
    expect(origin.textContent).toContain('Opened from the sessions view');
    await userEvent.click(within(origin).getByRole('button', { name: 'Back to the session' }));
    expect(path()).toBe(SESSIONS_PATH);
  }, 30_000);

  it('showPanel brings a panel of code mode into view', async () => {
    const { dispatch } = await open({ path: CODE_PATH });
    await screen.findByRole('main', { name: 'Editor' }, { timeout: 15_000 });
    const toggle = (name: string): HTMLElement => within(topbar()).getByRole('button', { name });
    expect(toggle('Show or hide activity, transfers and terminal').getAttribute('aria-pressed')).toBe('false');
    await dispatch('showPanel', { panel: 'terminal' });
    expect(toggle('Show or hide activity, transfers and terminal').getAttribute('aria-pressed')).toBe('true');
    expect(within(view('code')).getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true');
    await dispatch('showPanel', { panel: 'conflicts' });
    expect(within(view('code')).getByRole('tab', { name: 'Conflicts' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.click(toggle('Show or hide the session beside the editor'));
    expect(toggle('Show or hide the session beside the editor').getAttribute('aria-pressed')).toBe('false');
    await dispatch('showPanel', { panel: 'session' });
    expect(toggle('Show or hide the session beside the editor').getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(toggle('Show or hide files'));
    await dispatch('showPanel', { panel: 'files' });
    expect(toggle('Show or hide files').getAttribute('aria-pressed')).toBe('true');
  }, 30_000);
});

describe('the workspace shell: overlays, focus, empty states, notices', () => {
  it('an overlay a feature registered is mounted once, in both modes, and can handle a command', async () => {
    const mounts = vi.fn();
    const asked = vi.fn();
    const TopicDialogs = () => {
      useCommandHandler('newTopic', asked);
      useEffect(() => {
        mounts('mount');
        return () => mounts('unmount');
      }, []);
      return null;
    };
    const { dispatch } = await open({ slots: [{ feature: 'topics', overlays: [TopicDialogs] }] });
    await userEvent.click(within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', { name: 'New' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'New topic' }));
    expect(asked).toHaveBeenCalledOnce();
    await dispatch('setMode', { mode: 'code' });
    await dispatch('newTopic', {});
    expect(asked).toHaveBeenCalledTimes(2);
    expect(mounts.mock.calls).toEqual([['mount']]);
  }, 30_000);

  it('an overlay that crashes takes nothing with it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken = (): never => {
      throw new Error('boom');
    };
    await open({ slots: [{ feature: 'broken', overlays: [Broken] }] });
    expect(screen.getByRole('complementary', { name: 'Inbox and sessions' })).toBeTruthy();
    // Nothing is said either: an overlay shows nothing by itself.
    expect(document.querySelector('.ui-slot-error')).toBeNull();
    error.mockRestore();
  });

  it('F6 and Shift+F6 move between the regions: inbox, session list, each column in order', async () => {
    const { dispatch } = await open();
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_cart' } });
    await dispatch('openColumn', { target: { kind: 'plan', topicId: 't1' }, side: true });
    const inbox = within(screen.getByRole('region', { name: 'Inbox' })).getByRole('button', { name: 'Inbox' });
    const sessions = within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', { name: 'Sessions' });
    const title = (name: string): HTMLElement => within(screen.getByRole('region', { name })).getByRole('heading', { level: 2 });
    act(() => inbox.focus());
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(sessions);
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(title('1 · Cart API'));
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(title('Plan'));
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(inbox);
    await userEvent.keyboard('{Shift>}{F6}{/Shift}');
    expect(document.activeElement).toBe(title('Plan'));
    // From inside a region F6 goes on from that region.
    act(() => screen.getByRole('treeitem', { name: /^1 · Cart API/ }).focus());
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(title('1 · Cart API'));
  });

  it('after the last column is closed the focus goes back to the session list', async () => {
    const { dispatch } = await open();
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_cart' } });
    await userEvent.click(screen.getByRole('button', { name: 'Close column: 1 · Cart API' }));
    expect(document.activeElement?.getAttribute('role')).toBe('treeitem');
    expect(document.activeElement?.closest('[role="tree"]')).toBeTruthy();
  });

  it('a workspace without topics or sessions: "Start with a topic" and the four steps', async () => {
    const asked: string[] = [];
    const Dialogs = () => {
      useCommandHandler('newTopic', () => void asked.push('topic'));
      useCommandHandler('newSession', ({ kind }) => void asked.push(kind));
      return null;
    };
    await open({ sessions: [], topics: [], slots: [{ feature: 'dialogs', overlays: [Dialogs] }] });
    const main = screen.getByRole('main', { name: 'Open columns' });
    expect(within(main).getByRole('heading', { level: 2, name: 'Start with a topic' })).toBeTruthy();
    expect(within(main).getAllByRole('listitem').map((step) => step.querySelector('.app-steps__t')?.textContent)).toEqual(['Discuss', 'Spec', 'Plan', 'Execute and review']);
    await userEvent.click(within(main).getByRole('button', { name: 'New topic' }));
    await userEvent.click(within(main).getByRole('button', { name: 'or open a single session without a topic' }));
    expect(asked).toEqual(['topic', 'agent']);
  });

  it('an Editor or a Viewer of an empty workspace is told where a topic will appear', async () => {
    await open({ sessions: [], topics: [], role: 'editor' });
    const main = screen.getByRole('main', { name: 'Open columns' });
    expect(main.textContent).toContain('When the host or a member with agent access starts a topic, it appears on the left.');
    expect(within(main).queryByRole('button', { name: 'New topic' })).toBeNull();
  });

  it('topics exist and nothing is open: "Nothing is open", how to open, and the first things that wait', async () => {
    const { conn } = await open({ inbox: [buildInboxItem('question', { excerpt: 'Where is the cart kept?', sessionId: 's_cart', target: { kind: 'session', sessionId: 's_cart' } })] });
    const main = screen.getByRole('main', { name: 'Open columns' });
    expect(within(main).getByRole('heading', { level: 2, name: 'Nothing is open' })).toBeTruthy();
    expect(main.textContent).toContain('Shift+click (or Shift+Enter) opens it to the side');
    await userEvent.click(within(within(main).getByRole('region', { name: 'Waiting for you' })).getByRole('button', { name: /^Open/ }));
    expect(columnNames()).toEqual(['1 · Cart API']);
    expect(conn.notificationsOf('inbox.seen').map((n) => n.payload)).toEqual([{ keys: ['question:q_1'] }]);
  });

  it('what a change of a topic tells everyone is a toast with "Open"', async () => {
    const { conn } = await open();
    act(() => conn.emit('topic.updated', { topic: { ...TOPIC, phase: 'complete' } }));
    const toast = (await screen.findByText('Checkout redesign: every item is reviewed. The topic is complete.')).closest('.ui-toast') as HTMLElement;
    await userEvent.click(within(toast).getByRole('button', { name: 'Open' }));
    expect(columnNames()).toEqual(['Plan']);
    // A topic somebody else started.
    act(() => conn.emit('topic.updated', { topic: buildTopic({ id: 't9', name: 'Dark mode', createdBy: { userId: 'dev:mei', displayName: 'Mei' } }) }));
    expect(await screen.findByText('A new topic was started: Dark mode')).toBeTruthy();
    // My own new topic needs no toast.
    act(() => conn.emit('topic.updated', { topic: buildTopic({ id: 't10', name: 'Mine', createdBy: { userId: 'dev:host', displayName: 'Ian' } }) }));
    expect(screen.queryByText('A new topic was started: Mine')).toBeNull();
  });

  it('"Open" on a topic\'s notice shows its discussion, its spec or its plan', () => {
    expect(topicNoticeTarget({ kind: 'started', topicId: 't1' }, 's_disc')).toEqual({ kind: 'session', sessionId: 's_disc' });
    expect(topicNoticeTarget({ kind: 'started', topicId: 't1' }, undefined)).toEqual({ kind: 'spec', topicId: 't1' });
    expect(topicNoticeTarget({ kind: 'spec-ready', topicId: 't1' }, 's_disc')).toEqual({ kind: 'spec', topicId: 't1' });
    for (const kind of ['plan-ready', 'plan-updated', 'complete'] as const) expect(topicNoticeTarget({ kind, topicId: 't1' }, 's_disc')).toEqual({ kind: 'plan', topicId: 't1' });
  });

  it('the banners of the sessions view are above its columns', async () => {
    const { conn } = await open();
    act(() => conn.emit('session.host', { account: { state: 'logged-out', sessions: 1 }, mainProjectSettings: 'none' }));
    expect(view('sessions').querySelector('[data-banner="account"]')?.textContent).toContain("The host's Claude Code is logged out");
  });

  it('the console route keeps the top bar; neither mode is the current page there', async () => {
    await open({ path: `/w/${WORKSPACE_ID}/console/audit` });
    expect(await screen.findByRole('main', { name: 'Host console' })).toBeTruthy();
    expect(modeLink('Sessions').hasAttribute('aria-current')).toBe(false);
    expect(modeLink('Code mode').hasAttribute('aria-current')).toBe(false);
    expect(within(topbar()).getByRole('link', { name: 'Host console' }).getAttribute('aria-current')).toBe('page');
    expect(within(topbar()).queryByRole('group', { name: 'Layout' })).toBeNull();
  });
});
