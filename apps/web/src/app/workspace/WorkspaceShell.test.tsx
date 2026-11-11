// The workspace shell (DESIGN §5.1, AD-12; UX §1, §2, §11, §12): the mode is a route, both views stay mounted, the
// commands that move between them, the overlays, the tab's title, F6, and the empty states of the right side.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAIN_ROOT, SmurgError, type AgentSession, type ConversationEvent, type InboxItem, type NoteInfo, type Role, type SessionInfo, type Topic } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildAgentSession, buildEvent, buildInboxItem, buildTopic } from '@smurg/protocol/testing';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CommandMap } from '../../lib/commands.ts';
import { createSlotRegistry, type FeatureSlots } from '../../lib/slots.ts';
import { useCommandHandler } from '../../lib/workspace/context.tsx';
import { CART, DISCUSSION, FREE, IAN, PROBES, TERMINAL, TOPIC } from '../../features/columns/test-support.tsx';
import { slots as conversationSlots } from '../../features/conversation/slots.tsx';
import { watchReply } from '../../features/conversation/test-support.tsx';
import { WORKSPACE_ID, makeConflict, makeEntry, makeWelcome } from '../../testing/fixtures.ts';
import { createTestServices } from '../../testing/services.tsx';
import { answerLoads } from '../../testing/stores.ts';
import { ToastProvider } from '../../ui/index.ts';
import { KEY_STEP } from '../../ui/split-resize.ts';
import { useRoute } from '../navigation.tsx';
import { AppServicesProvider } from '../services.tsx';
import { NOTES_CHAT_DEFAULT_PX, NOTES_TREE_DEFAULT_PX } from './layout-limits.ts';
import { topicNoticeTarget } from './useWorkspaceNotices.ts';
import WorkspaceRoute from './WorkspaceRoute.tsx';

const SESSIONS_PATH = `/w/${WORKSPACE_ID}`;
const CODE_PATH = `/w/${WORKSPACE_ID}/code`;
const NOTES_PATH = `/w/${WORKSPACE_ID}/notes`;

function Routed({ slots }: { slots: readonly FeatureSlots[] }) {
  const route = useRoute();
  if (route.name !== 'workspace' && route.name !== 'code' && route.name !== 'console' && route.name !== 'notes') return <p>{`elsewhere: ${route.name}`}</p>;
  return (
    <WorkspaceRoute
      key={route.workspaceId}
      workspaceId={route.workspaceId}
      view={route.name === 'workspace' ? 'sessions' : route.name}
      {...(route.name === 'console' && route.section !== undefined ? { section: route.section } : {})}
      {...(route.name === 'notes' && route.note !== undefined ? { note: route.note } : {})}
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
  /** The index of the sticky notes the host answers with (asked for when the sticky notes are first shown). */
  notes?: readonly NoteInfo[];
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
  conn.handle('sticky.list', () => ({ notes: [...(options.notes ?? [])], hasMore: false, truncated: false, sources: [] }));
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

const view = (name: 'notes' | 'sessions' | 'code'): HTMLElement => document.querySelector(`.app-shell__view[data-view="${name}"]`) as HTMLElement;
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

// DESIGN 0.8.0 D7.1, D7.2: a third view, at /w/:id/notes[/:name], mounted the first time it is shown.
describe('the workspace shell: the sticky notes, a third view', () => {
  it('three mode links, Sticky notes first; the sticky notes are not loaded until they are shown, then mounted once, with no layout toggles', async () => {
    const { conn, path } = await open({ notes: [{ name: 'Home', links: [] }] });
    expect(within(within(topbar()).getByRole('group', { name: 'Mode' })).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Sticky notes', NOTES_PATH],
      ['Sessions', SESSIONS_PATH],
      ['Code mode', CODE_PATH],
    ]);
    expect(modeLink('Sticky notes').getAttribute('title')).toBe('Sticky notes: small notes that link to each other, grown from Home');
    // Not shown yet: nothing of it is mounted, and the index was not asked for.
    expect(view('notes').hidden).toBe(true);
    expect(view('notes').childElementCount).toBe(0);
    expect(conn.requestsOf('sticky.list')).toHaveLength(0);

    await userEvent.click(modeLink('Sticky notes'));
    expect(path()).toBe(NOTES_PATH);
    expect(await screen.findByRole('main', { name: 'Open sticky note' }, { timeout: 15_000 })).toBeTruthy();
    expect(isShown(view('notes'))).toBe(true);
    expect(view('sessions').hidden).toBe(true);
    expect(view('sessions').hasAttribute('inert')).toBe(true);
    expect(modeLink('Sticky notes').getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('.app-shell')?.getAttribute('data-mode')).toBe('notes');
    expect(screen.getByRole('complementary', { name: 'All sticky notes' })).toBeTruthy();
    expect(within(topbar()).queryByRole('group', { name: 'Layout' })).toBeNull();
    // The panes' widths are remembered under their own keys (smurg.pane.*), never in smurg.layout (review S3-T2).
    const separators = screen.getAllByRole('separator');
    expect(separators.map((separator) => separator.getAttribute('aria-label'))).toEqual([
      'Drag or use the arrow keys to resize All sticky notes',
      'Drag or use the arrow keys to resize Claude for the sticky notes',
    ]);
    act(() => separators[0]!.focus());
    await userEvent.keyboard('{ArrowRight}');
    act(() => separators[1]!.focus());
    await userEvent.keyboard('{ArrowRight}');
    expect(window.localStorage.getItem('smurg.pane.notes-tree')).toBe(String(NOTES_TREE_DEFAULT_PX + KEY_STEP));
    expect(window.localStorage.getItem('smurg.pane.notes-chat')).toBe(String(NOTES_CHAT_DEFAULT_PX - KEY_STEP));
    expect(window.localStorage.getItem('smurg.layout')).toBeNull();
    await waitFor(() => expect(conn.requestsOf('sticky.list')).toHaveLength(1));
    const mounted = document.querySelector('.app-notes');

    // To code mode and back to the sessions view: the sticky notes stay mounted, hidden and inert.
    await userEvent.click(modeLink('Code mode'));
    expect(await screen.findByRole('main', { name: 'Editor' }, { timeout: 15_000 })).toBeTruthy();
    expect(view('notes').hidden).toBe(true);
    expect(view('notes').hasAttribute('inert')).toBe(true);
    await userEvent.click(modeLink('Sessions'));
    expect(path()).toBe(SESSIONS_PATH);
    await userEvent.click(modeLink('Sticky notes'));
    expect(isShown(view('notes'))).toBe(true);
    expect(document.querySelector('.app-notes')).toBe(mounted);
    expect(conn.requestsOf('sticky.list')).toHaveLength(1);
    expect(window.localStorage.getItem('smurg.layout')).toBeNull();
  }, 30_000);

  it('the mode link and setMode lead back to the sticky note last open in this page', async () => {
    const { dispatch, path } = await open({ path: `${NOTES_PATH}/Ideas` });
    expect(await screen.findByRole('heading', { level: 2, name: 'Ideas' }, { timeout: 15_000 })).toBeTruthy();
    await dispatch('setMode', { mode: 'sessions' });
    expect(path()).toBe(SESSIONS_PATH);
    // Hidden, the sticky notes keep the note they showed.
    expect(within(view('notes')).getByRole('heading', { level: 2, name: 'Ideas', hidden: true })).toBeTruthy();
    expect(modeLink('Sticky notes').getAttribute('href')).toBe(`${NOTES_PATH}/Ideas`);
    await dispatch('setMode', { mode: 'notes' });
    expect(path()).toBe(`${NOTES_PATH}/Ideas`);
    expect(modeLink('Sticky notes').getAttribute('aria-current')).toBe('page');
  }, 30_000);

  it('hidden, the sticky notes never take the address: a note that comes to be written in another spelling is only remembered', async () => {
    const { conn, dispatch, path } = await open({ path: `${NOTES_PATH}/Reviews`, notes: [{ name: 'Home', links: [] }] });
    expect(await screen.findByRole('heading', { level: 2, name: 'Reviews' }, { timeout: 15_000 })).toBeTruthy();
    await dispatch('setMode', { mode: 'sessions' });
    expect(path()).toBe(SESSIONS_PATH);
    // Somebody writes notes/reviews.md meanwhile: the index lists it, under the name on disk (review S3-R2).
    act(() => conn.emit('sticky.changed', { upserted: [{ name: 'reviews', links: [] }], removed: [], truncated: false }));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(path()).toBe(SESSIONS_PATH);
    expect(isShown(view('sessions'))).toBe(true);
    expect(view('notes').hidden).toBe(true);
    // The way back leads to the note as it is on disk.
    expect(modeLink('Sticky notes').getAttribute('href')).toBe(`${NOTES_PATH}/reviews`);
    await userEvent.click(modeLink('Sticky notes'));
    expect(path()).toBe(`${NOTES_PATH}/reviews`);
    expect(within(view('notes')).getByRole('heading', { level: 2, name: 'reviews' })).toBeTruthy();
  }, 30_000);

  it('a reload keeps the note: /w/:id/notes/:name opens the sticky notes at that note, the sessions view mounted behind', async () => {
    await open({ path: `${NOTES_PATH}/${encodeURIComponent('Payment form')}` });
    expect(await screen.findByRole('heading', { level: 2, name: 'Payment form' }, { timeout: 15_000 })).toBeTruthy();
    expect(isShown(view('notes'))).toBe(true);
    expect(within(view('sessions')).getByRole('complementary', { name: 'Inbox and sessions', hidden: true })).toBeTruthy();
    expect(view('code').childElementCount).toBe(0);
  }, 30_000);

  it('a login from a sticky note returns to the sticky notes without the note\'s name: the relay\'s login is never told a name', async () => {
    // A note's name is project text, and the relay's login keeps where it returns to (SECURITY.md, "What the relay
    // operator sees"; review S3-SEC-1): the way back is the notes view, which opens at Home.
    const { services, conn } = await open({ path: `${NOTES_PATH}/${encodeURIComponent('Payment form')}` });
    act(() => conn.setState({ kind: 'closed', reason: 'login-required' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Log in with Google' }));
    const login = new URL(services.router.assigned[0]!);
    expect(new URL(login.searchParams.get('return_to')!).pathname).toBe(NOTES_PATH);
    expect(services.router.assigned[0]).not.toMatch(/Payment/i);
  }, 30_000);

  it('F6 and Shift+F6 move between the list of sticky notes, the open note and Claude\'s pane; the skip link leads to the note', async () => {
    await open({ path: NOTES_PATH, notes: [{ name: 'Home', links: [] }] });
    const home = await screen.findByRole('treeitem', { name: 'Home' }, { timeout: 15_000 });
    const name = screen.getByRole('heading', { level: 2, name: 'Home' });
    // Claude's pane is the third stop since it has something to say (BUILD-PLAN S4, DESIGN 0.8.0 D7.7): until then the
    // right pane was empty and F6 went from the note back to the list.
    const claude = within(view('notes')).getByRole('heading', { level: 2, name: 'Claude for the sticky notes' });
    act(() => home.focus());
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(name);
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(claude);
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(home);
    await userEvent.keyboard('{Shift>}{F6}{/Shift}');
    expect(document.activeElement).toBe(claude);
    await userEvent.keyboard('{Shift>}{F6}{/Shift}');
    expect(document.activeElement).toBe(name);
    expect(within(view('notes')).getByRole('link', { name: 'Skip to the sticky note' }).getAttribute('href')).toBe('#notes-main');
  }, 30_000);
});

describe('the workspace shell: Claude for the sticky notes, on the right of the sticky notes (DESIGN 0.8.0 D7.7)', () => {
  const NOTES_SESSION = buildAgentSession({ id: 's_notes', purpose: 'notes', modeFixed: true, openedBy: IAN, createdAt: 5 });
  const ENDED = buildAgentSession({ id: 's_notes_old', purpose: 'notes', modeFixed: true, openedBy: IAN, createdAt: 1, status: 'ended' });
  const HOME: NoteInfo[] = [{ name: 'Home', links: ['Ideas'] }, { name: 'Ideas', links: [] }];
  const pane = (): HTMLElement => view('notes').querySelector('.app-notes__chat') as HTMLElement;
  /** The real conversation feature in the column (its composer is what each role is shown). */
  const REAL: readonly FeatureSlots[] = [conversationSlots];

  /** The sticky notes at Home, once their chunk is there. */
  async function shownNotes(options: OpenOptions) {
    const opened = await open(options);
    await screen.findByRole('main', { name: 'Open sticky note' }, { timeout: 15_000 });
    return opened;
  }

  async function withClaude(role: Role, sessions: readonly SessionInfo[] = [NOTES_SESSION], events: readonly ConversationEvent[] = []) {
    const opened = await shownNotes({ path: NOTES_PATH, role, notes: HOME, sessions, slots: REAL });
    opened.conn.handle('session.watch', ({ sessionId }) => watchReply(sessions.find((session) => session.id === sessionId) as AgentSession, events));
    return opened;
  }

  it('a spinner until the session list is loaded; with no Claude for the sticky notes, "Start Claude" for a member who may start sessions, and its conversation once started', async () => {
    const { conn } = await shownNotes({ path: NOTES_PATH, role: 'host', notes: HOME, sessions: [] });
    const title = await within(pane()).findByRole('heading', { level: 2, name: 'Claude for the sticky notes' }, { timeout: 15_000 });
    expect(title.hasAttribute('data-region-focus')).toBe(true);
    expect(pane().textContent).toContain('Claude helps you write and order the sticky notes. It reads the project and writes only sticky notes, which everyone sees at once.');
    // A new channel: the session list is loaded again, and until it is the pane offers nothing.
    act(() => conn.admit(makeWelcome({ role: 'host', channelId: 'ch_2' })));
    expect(within(pane()).getByText('Loading Claude for the sticky notes…')).toBeTruthy();
    expect(within(pane()).queryByRole('button')).toBeNull();
    await act(async () => {
      answerLoads(conn, { 'session.list': { sessions: [], hasMore: false } });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await userEvent.click(within(pane()).getByRole('button', { name: 'Start Claude' }));
    expect(conn.requestsOf('sticky.assistant.start').map((request) => request.payload)).toEqual([{}]);
    await act(async () => {
      conn.respond('sticky.assistant.start', { session: NOTES_SESSION });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    // The column of that session, keyed by its id: its body is told where it stands.
    const column = within(pane()).getByRole('region', { name: 'Sticky notes' });
    expect(column.getAttribute('data-column-id')).toBe('session:s_notes');
    expect(within(column).getByTestId('body-session:s_notes').getAttribute('data-place')).toBe('notes');
    expect(within(column).getByTestId('body-session:s_notes').getAttribute('data-visible')).toBe('true');
  }, 30_000);

  it('only an ended one: "Start Claude again"; a member who may not start sessions is told who can; a refusal is said', async () => {
    const { conn } = await shownNotes({ path: NOTES_PATH, role: 'host', notes: HOME, sessions: [ENDED] });
    await within(pane()).findByRole('heading', { level: 2, name: 'Claude for the sticky notes' }, { timeout: 15_000 });
    expect(pane().textContent).toContain('Claude for the sticky notes has ended.');
    conn.handle('sticky.assistant.start', () => {
      throw new SmurgError('conflict', msg('session.limit.agents', { max: 8 }), { reason: 'limit' });
    });
    await userEvent.click(within(pane()).getByRole('button', { name: 'Start Claude again' }));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(within(pane()).getByRole('alert').textContent).toMatch(/^Claude was not started: /);
    cleanup();
    for (const role of ['editor', 'viewer'] as const) {
      await shownNotes({ path: NOTES_PATH, role, notes: HOME, sessions: [] });
      await within(pane()).findByRole('heading', { level: 2, name: 'Claude for the sticky notes' }, { timeout: 15_000 });
      expect(pane().textContent, role).toContain('A member with agent access can start it.');
      expect(within(pane()).queryByRole('button'), role).toBeNull();
      cleanup();
    }
  }, 60_000);

  it('a running one is its conversation, with the composer\'s own words: a message for the host, a suggestion for an Editor, no box for a Viewer', async () => {
    await withClaude('host', [ENDED, NOTES_SESSION]);
    expect(await within(pane()).findByRole('combobox', { name: 'Message Claude · Sticky notes' }, { timeout: 15_000 })).toBeTruthy();
    cleanup();
    await withClaude('editor');
    expect(await within(pane()).findByRole('combobox', { name: 'Suggest to Claude · Sticky notes' }, { timeout: 15_000 })).toBeTruthy();
    expect(pane().textContent).toContain('as a suggestion. It reaches the agent only when accepted.');
    cleanup();
    await withClaude('viewer');
    expect(await within(pane()).findByText('As a viewer you can watch this session. You cannot send messages, make suggestions or vote.', {}, { timeout: 15_000 })).toBeTruthy();
    expect(within(pane()).queryByRole('combobox')).toBeNull();
  }, 60_000);

  it('"Ask Claude about this sticky note" puts its link and a space into the box of Claude\'s conversation, which takes the focus; a Viewer has no such button', async () => {
    await withClaude('editor');
    const box = (await within(pane()).findByRole('combobox', { name: 'Suggest to Claude · Sticky notes' }, { timeout: 15_000 })) as HTMLTextAreaElement;
    await userEvent.click(within(view('notes')).getByRole('button', { name: 'Ask Claude about this sticky note' }));
    expect(box.value).toBe('[[Home]] ');
    expect(document.activeElement).toBe(box);
    // What was in the box stays: the link goes under it.
    await userEvent.type(box, 'What is missing here?');
    await userEvent.click(within(screen.getByRole('treeitem', { name: 'Ideas' })).getByText('Ideas'));
    await within(view('notes')).findByRole('heading', { level: 2, name: 'Ideas' });
    await userEvent.click(await within(view('notes')).findByRole('button', { name: 'Ask Claude about this sticky note' }));
    expect(box.value).toBe('[[Home]] What is missing here?\n\n[[Ideas]] ');
    cleanup();
    await withClaude('viewer');
    await within(pane()).findByText('As a viewer you can watch this session. You cannot send messages, make suggestions or vote.', {}, { timeout: 15_000 });
    expect(within(view('notes')).queryByRole('button', { name: 'Ask Claude about this sticky note' })).toBeNull();
  }, 60_000);

  it('a sticky note\'s file named in Claude\'s text opens that note while the sticky notes are on screen; any other file, and the same file from another view, open in code mode', async () => {
    const said = [buildEvent('turn.started', { seq: 1, turnId: 't_1' }), buildEvent('text', { seq: 2, turnId: 't_1', blockId: 'b_2', text: 'I wrote notes/Ideas.md and linked it from Home.' })];
    const { conn, path, dispatch, session } = await withClaude('host', [NOTES_SESSION], said);
    conn.handle('file.stat', (ref) => ({ entry: makeEntry(ref.path) }));
    const link = await within(pane()).findByRole('button', { name: /notes\/Ideas\.md/ }, { timeout: 15_000 });
    await userEvent.click(link);
    expect(path()).toBe(`${NOTES_PATH}/Ideas`);
    expect(document.querySelector('.app-shell')?.getAttribute('data-mode')).toBe('notes');
    expect(await within(view('notes')).findByRole('heading', { level: 2, name: 'Ideas' })).toBeTruthy();
    expect(view('code').childElementCount).toBe(0);
    // A file that is no sticky note's (notes/CLAUDE.md is never one) opens in code mode, as before.
    const opened = vi.fn();
    session.commands.observe('openFile', opened);
    act(() => void session.commands.dispatch('openInCodeMode', { root: MAIN_ROOT, file: 'notes/CLAUDE.md', sessionId: 's_notes' }).catch(() => {}));
    expect(path()).toBe(CODE_PATH);
    await waitFor(() => expect(opened).toHaveBeenCalledWith({ file: { root: MAIN_ROOT, path: 'notes/CLAUDE.md' } }), { timeout: 15_000 });
    // From code mode (or the sessions view) a note's file is a file like any other.
    await dispatch('setMode', { mode: 'sessions' });
    act(() => void session.commands.dispatch('openInCodeMode', { root: MAIN_ROOT, file: 'notes/Ideas.md', sessionId: 's_notes' }).catch(() => {}));
    expect(path()).toBe(CODE_PATH);
    await waitFor(() => expect(opened).toHaveBeenCalledWith({ file: { root: MAIN_ROOT, path: 'notes/Ideas.md' } }), { timeout: 15_000 });
  }, 60_000);
});

describe('the workspace shell: commands', () => {
  it('openColumn shows a thing in a column; a row of the session list does the same', async () => {
    const { dispatch, stores } = await open();
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_cart' } });
    expect(columnNames()).toEqual(['1 · Cart API']);
    await dispatch('openColumn', { target: { kind: 'spec', topicId: 't1' }, side: true });
    expect(columnNames()).toEqual(['1 · Cart API', 'Spec · Checkout redesign']);
    await userEvent.click(screen.getByText('Fix flaky CI test'));
    // Replaces what the focused column showed.
    expect(columnNames()).toEqual(['1 · Cart API', 'Fix flaky CI test']);
    expect(stores.columns.getState().focusedId).toBe('session:s_free');
    // The anchor travels to the body.
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_cart' }, from: 'inbox', anchor: { cardId: 'q_1' } });
    expect(within(screen.getByTestId('body-session:s_cart')).getByRole('button', { name: 'anchor q_1' })).toBeTruthy();
  });

  it('openColumn with `inPlaceOf` shows a thing in the place of a column that is open, and opens nothing when that column is gone (review R6-01)', async () => {
    const { dispatch, stores } = await open();
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_cart' } });
    await dispatch('openColumn', { target: { kind: 'report', topicId: 't1', itemId: 'cart-api' }, from: 'inbox' });
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_free' }, side: true });
    const ids = (): string[] => stores.columns.getState().columns.map((column) => column.id);
    expect(ids()).toEqual(['session:s_cart', 'report:t1:cart-api', 'session:s_free']);
    // The column in the middle becomes the changes; the focus stays where the person put it meanwhile.
    await dispatch('openColumn', { target: { kind: 'changes', requestId: 'mr_1' }, inPlaceOf: { kind: 'report', topicId: 't1', itemId: 'cart-api' } });
    expect(ids()).toEqual(['session:s_cart', 'changes:mr_1', 'session:s_free']);
    expect(stores.columns.getState().focusedId).toBe('session:s_free');
    // The column was closed before the answer came: nothing opens.
    await dispatch('openColumn', { target: { kind: 'changes', requestId: 'mr_2' }, inPlaceOf: { kind: 'report', topicId: 't1', itemId: 'receipt' } });
    expect(ids()).toEqual(['session:s_cart', 'changes:mr_1', 'session:s_free']);
  });

  it('the plan of a topic that is executing is pinned when it is opened; another plan is not', async () => {
    const spec = buildTopic({ id: 't2', name: 'Search filters', phase: 'spec' });
    const { dispatch, stores } = await open({ topics: [TOPIC, spec] });
    await dispatch('openColumn', { target: { kind: 'plan', topicId: 't1' } });
    await dispatch('openColumn', { target: { kind: 'plan', topicId: 't2' }, side: true });
    expect(stores.columns.getState().columns.map((column) => [column.id, column.pinned])).toEqual([['plan:t1', true], ['plan:t2', false]]);
  });

  it('a plan column that is open when its topic starts executing is pinned at that moment: the first row click opens beside it', async () => {
    const planned: Topic = { ...TOPIC, phase: 'plan' };
    const { dispatch, stores, conn } = await open({ topics: [planned] });
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_disc' } });
    await dispatch('openColumn', { target: { kind: 'plan', topicId: 't1' }, side: true });
    const pinned = (): boolean | undefined => stores.columns.getState().columns.find((column) => column.id === 'plan:t1')?.pinned;
    expect(pinned()).toBe(false);
    // Start is pressed with the plan on screen (by this member or by anyone else).
    act(() => conn.emit('topic.updated', { topic: TOPIC }));
    expect(pinned()).toBe(true);
    expect(stores.columns.getState().focusedId).toBe('plan:t1');
    await userEvent.click(screen.getByText('1 · Cart API'));
    expect(stores.columns.getState().columns.map((column) => column.id)).toEqual(['session:s_disc', 'plan:t1', 'session:s_cart']);
    // Only that moment pins: unpinned by hand, it stays so while the topic goes on executing.
    act(() => stores.columns.setPinned('plan:t1', false));
    act(() => conn.emit('topic.updated', { topic: { ...TOPIC, plan: { ...TOPIC.plan, started: 1 } } }));
    expect(pinned()).toBe(false);
    // A topic that executes again after it was complete (one more work item) pins its plan again.
    act(() => conn.emit('topic.updated', { topic: { ...TOPIC, phase: 'complete' } }));
    expect(pinned()).toBe(false);
    act(() => conn.emit('topic.updated', { topic: TOPIC }));
    expect(pinned()).toBe(true);
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

describe('the workspace shell: "Agents ask for nothing" (DESIGN 0.6.0 D13)', () => {
  it.each(['host', 'agent', 'editor', 'viewer'] as const)('the %s sees the badge beside the name while the host lets agents ask for nothing', async (role) => {
    const { conn } = await open({ role });
    expect(within(topbar()).queryByText('Agents ask for nothing')).toBeNull();
    act(() => conn.emit('channel.settingsUpdated', { settings: { ...makeWelcome().settings, permissionMode: 'ask-nothing' } }));
    const badge = within(topbar()).getByText('Agents ask for nothing');
    expect(badge.closest('[title]')?.getAttribute('title')).toBe(
      "The host lets this workspace's agents run commands as the host with no check by Claude Code and no question from smurg; only smurg's fixed limits stay.",
    );
    act(() => conn.emit('channel.settingsUpdated', { settings: { ...makeWelcome().settings, permissionMode: 'auto' } }));
    expect(within(topbar()).queryByText('Agents ask for nothing')).toBeNull();
  });
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
    expect(document.activeElement).toBe(title('Plan · Checkout redesign'));
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(inbox);
    await userEvent.keyboard('{Shift>}{F6}{/Shift}');
    expect(document.activeElement).toBe(title('Plan · Checkout redesign'));
    // From inside a region F6 goes on from that region.
    act(() => screen.getByRole('treeitem', { name: /^1 · Cart API/ }).focus());
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(title('1 · Cart API'));
  });

  it('with the left column folded to its rail, F6 lands on the rail once, then on the columns', async () => {
    const { dispatch } = await open();
    await dispatch('openColumn', { target: { kind: 'session', sessionId: 's_cart' } });
    await userEvent.click(within(topbar()).getByRole('button', { name: 'Show or hide the inbox and the session list' }));
    const rail = within(document.querySelector('.sidebar-rail') as HTMLElement).getByRole('button', { name: /^Inbox:/ });
    const title = within(screen.getByRole('region', { name: '1 · Cart API' })).getByRole('heading', { level: 2 });
    act(() => rail.focus());
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(title);
    await userEvent.keyboard('{F6}');
    expect(document.activeElement).toBe(rail);
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
    // 0.7.0 (on purpose, DESIGN D19): the last step says that smurg merges by itself, the workspace's setting.
    expect(within(main).getAllByRole('listitem').map((step) => step.querySelector('.app-steps__t')?.textContent)).toEqual(['Discuss', 'Spec', 'Plan', 'Run and check']);
    expect(within(main).getByText('One session per item; smurg merges what its report says is complete and verified. Check the result at the end.')).toBeTruthy();
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
    expect(columnNames()).toEqual(['Plan · Checkout redesign']);
    // A topic somebody else started.
    act(() => conn.emit('topic.updated', { topic: buildTopic({ id: 't9', name: 'Dark mode', createdBy: { userId: 'dev:mei', displayName: 'Mei' } }) }));
    expect(await screen.findByText('A new topic was started: Dark mode')).toBeTruthy();
    // My own new topic needs no toast.
    act(() => conn.emit('topic.updated', { topic: buildTopic({ id: 't10', name: 'Mine', createdBy: { userId: 'dev:host', displayName: 'Ian' } }) }));
    expect(screen.queryByText('A new topic was started: Mine')).toBeNull();
  });

  it('protocol 6: a topic ready to check, and its checked result, are toasts whose "Open" shows the Result', async () => {
    const { conn } = await open();
    act(() => conn.emit('topic.updated', { topic: { ...TOPIC, phase: 'executing' } }));
    act(() => conn.emit('topic.updated', { topic: { ...TOPIC, phase: 'ready' } }));
    // (0.7.0 review: a topic is ready when every item is merged, left out or undone; the words said "merged" only)
    const toast = (await screen.findByText('Checkout redesign: every item is merged, left out or undone. Ready to check.')).closest('.ui-toast') as HTMLElement;
    await userEvent.click(within(toast).getByRole('button', { name: 'Open' }));
    expect(columnNames()).toContain('Result · Checkout redesign');
    act(() => conn.emit('topic.updated', { topic: { ...TOPIC, phase: 'complete', checked: { by: { userId: 'dev:mei', displayName: 'Mei' }, at: 1 } } }));
    expect(await screen.findByText('Checkout redesign: the result was checked. The topic is complete.')).toBeTruthy();
  });

  it('"Open" on a topic\'s notice shows its discussion, its spec or its plan', () => {
    expect(topicNoticeTarget({ kind: 'started', topicId: 't1' }, 's_disc')).toEqual({ kind: 'session', sessionId: 's_disc' });
    expect(topicNoticeTarget({ kind: 'started', topicId: 't1' }, undefined)).toEqual({ kind: 'spec', topicId: 't1' });
    expect(topicNoticeTarget({ kind: 'spec-ready', topicId: 't1' }, 's_disc')).toEqual({ kind: 'spec', topicId: 't1' });
    for (const kind of ['plan-ready', 'plan-updated', 'complete'] as const) expect(topicNoticeTarget({ kind, topicId: 't1' }, 's_disc')).toEqual({ kind: 'plan', topicId: 't1' });
    for (const kind of ['ready', 'checked'] as const) expect(topicNoticeTarget({ kind, topicId: 't1' }, 's_disc')).toEqual({ kind: 'result', topicId: 't1' });
  });

  it('the banners of the sessions view are above its columns', async () => {
    const { conn } = await open();
    act(() => conn.emit('session.host', { account: { state: 'logged-out', sessions: 1 }, mainProjectSettings: 'none', agent: { models: [], modelsKnown: false, hostDefault: null, autoMode: 'ok', asksNothing: 'ok' }, work: { history: 'folder' } }));
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
