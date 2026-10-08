// The conversations store (src/lib/stores/conversations.ts): folding events into render items, the window and its
// reading rules (P0-API §4.2), streaming deltas, card updates and the lifecycle around a Welcome. The store is bound
// to a FakeConnection by hand (no other store is needed), with a scheduler the test advances.
import { describe, expect, it } from 'vitest';
import { CARDS_GET_MAX, DELTA_REWATCH_MIN_MS, EVENTS_PAGE_MAX, SmurgError, type ConversationEvent, type ResultInputOf } from '@smurg/protocol';
import { buildAgentSession, buildEvent, buildEvents, buildPermission, buildQuestion, buildSuggestion, FAKE_NOW } from '@smurg/protocol/testing';
import type { StoreContext } from '../../lib/stores/base.ts';
import {
  MISSING_CARDS_DELAY_MS,
  WINDOW_KEEP,
  WINDOW_TRIM_ABOVE,
  createConversationsArea,
  foldEvents,
  selectCardGone,
  selectCardSeq,
  selectChangedFiles,
  selectOpenCards,
  type Conversation,
  type ReadsItem,
  type RenderItem,
  type TextItem,
  type ToolItem,
} from '../../lib/stores/conversations.ts';
import { FakeConnection } from '../../testing/fake-connection.ts';
import { makeWelcome } from '../../testing/fixtures.ts';
import { createManualScheduler } from '../../testing/services.tsx';

const SID = 'sess_a';
const tick = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

type WatchReply = ResultInputOf<'session.watch'>;
type HistoryReply = ResultInputOf<'session.history'>;

function watchReply(events: ConversationEvent[] = [], overrides: Partial<WatchReply> = {}): WatchReply {
  return {
    session: buildAgentSession({ id: SID }),
    events,
    firstSeq: events[0]?.seq ?? 0,
    nextSeq: (events.at(-1)?.seq ?? 0) + 1,
    hasEarlier: false,
    hasMore: false,
    streaming: [],
    questions: [],
    permissions: [],
    suggestions: [],
    moreCards: [],
    ...overrides,
  };
}

function historyReply(events: ConversationEvent[] = [], overrides: Partial<HistoryReply> = {}): HistoryReply {
  return { events, hasEarlier: false, hasMore: false, questions: [], permissions: [], suggestions: [], moreCards: [], ...overrides };
}

/** `count` line events from `firstSeq`. */
function lines(firstSeq: number, count: number): ConversationEvent[] {
  return Array.from({ length: count }, (_, index) => buildEvent('line', { seq: firstSeq + index }));
}

function setup() {
  const conn = new FakeConnection();
  const scheduler = createManualScheduler(FAKE_NOW);
  const errors: unknown[] = [];
  const { store, lifecycle } = createConversationsArea();
  const ctx: StoreContext = {
    conn,
    role: () => 'host',
    userId: () => 'dev:host',
    generation: () => 1,
    scheduler,
    reportError: (_area, error) => errors.push(error),
  };
  const unbind = lifecycle.bind(ctx);
  conn.start();
  conn.admit(makeWelcome({ role: 'host' }));
  const conversation = (): Conversation => {
    const found = store.getState().conversations.get(SID);
    if (!found) throw new Error('not watched');
    return found;
  };
  /** Watches SID and answers the first page. */
  const open = async (events: ConversationEvent[] = [], overrides: Partial<WatchReply> = {}, live = true): Promise<() => void> => {
    const release = store.watch(SID, { live });
    conn.respond('session.watch', watchReply(events, overrides));
    await tick();
    return release;
  };
  return { conn, scheduler, store, lifecycle, errors, unbind, conversation, open };
}

const kinds = (items: readonly RenderItem[]): string[] => items.map((item) => item.kind);

describe('folding events into render items', () => {
  it('keeps a person message with its latest delivery, folds smurg messages, and hides a turn that simply completed', () => {
    const events: ConversationEvent[] = [
      buildEvent('line', { seq: 1 }),
      buildEvent('message', { seq: 2, messageId: 'm_1' }),
      buildEvent('delivery', { seq: 3, messageId: 'm_1', state: 'queued' }),
      buildEvent('delivery', { seq: 4, messageId: 'm_1', state: 'started' }),
      buildEvent('turn.started', { seq: 5 }),
      buildEvent('text', { seq: 6 }),
      buildEvent('turn.finished', { seq: 7 }),
      buildEvent('smurg', { seq: 8, messageId: 'm_2' }),
      buildEvent('notice', { seq: 9 }),
    ];
    const items = foldEvents(events);
    expect(kinds(items)).toEqual(['line', 'message', 'text', 'smurg', 'notice']);
    expect(items[1]).toMatchObject({ kind: 'message', key: 'm:2', seq: 2, delivery: 'started' });
    expect(items[3]).toMatchObject({ kind: 'smurg', delivery: null });
  });

  it('shows the end of a turn only when it was stopped or failed', () => {
    const stopped = buildEvent('turn.finished', { seq: 2, outcome: 'interrupted', stoppedBy: { userId: 'dev:mei', displayName: 'Mei' } });
    expect(kinds(foldEvents([buildEvent('turn.started', { seq: 1 }), stopped]))).toEqual(['turn-end']);
    for (const outcome of ['error', 'max-turns', 'budget'] as const) {
      expect(kinds(foldEvents([buildEvent('turn.finished', { seq: 1, outcome })]))).toEqual(['turn-end']);
    }
    expect(foldEvents([buildEvent('turn.finished', { seq: 1, outcome: 'completed' })])).toEqual([]);
  });

  it('joins consecutive text blocks of one turn and starts a new piece after a tool', () => {
    const events: ConversationEvent[] = [
      buildEvent('text', { seq: 1, blockId: 'b_1' }),
      buildEvent('text', { seq: 2, blockId: 'b_2' }),
      buildEvent('tool.started', { seq: 3 }),
      buildEvent('tool.finished', { seq: 4 }),
      buildEvent('text', { seq: 5, blockId: 'b_3' }),
      buildEvent('text', { seq: 6, blockId: 'b_4', turnId: 't_2' }),
    ];
    const items = foldEvents(events);
    expect(kinds(items)).toEqual(['text', 'tool', 'text', 'text']);
    expect((items[0] as TextItem).blocks.map((block) => block.blockId)).toEqual(['b_1', 'b_2']);
    expect(items[1]).toMatchObject({ kind: 'tool', key: 'u:tu_1', toolUseId: 'tu_1', finished: { ok: true } });
    // Only the first piece of the agent after something else leads ("Claude" and the time).
    expect(items.map((item) => ('lead' in item ? item.lead : null))).toEqual([true, false, false, false]);
  });

  it('a tool that still runs has no result; a result whose call is before the window shows nothing', () => {
    const running = foldEvents([buildEvent('tool.started', { seq: 1, toolUseId: 'tu_9' })]);
    expect(running[0]).toMatchObject({ kind: 'tool', finished: null });
    expect(foldEvents([buildEvent('tool.finished', { seq: 1, toolUseId: 'tu_gone' })])).toEqual([]);
  });

  it('a tool without a result is running only while its turn has not ended', () => {
    const started = buildEvent('tool.started', { seq: 2, turnId: 't_1', toolUseId: 'tu_1' });
    const open = foldEvents([buildEvent('turn.started', { seq: 1, turnId: 't_1' }), started]);
    expect(open[0]).toMatchObject({ kind: 'tool', running: true, finished: null });
    const stopped = foldEvents([buildEvent('turn.started', { seq: 1, turnId: 't_1' }), started, buildEvent('turn.finished', { seq: 3, turnId: 't_1', outcome: 'interrupted' })], [], open);
    expect(stopped[0]).toMatchObject({ kind: 'tool', running: false, finished: null });
    // The change is a change: the row renders again.
    expect(stopped[0]).not.toBe(open[0]);
  });

  it('turns a run of file reads of one turn into one line, and leaves a single read alone', () => {
    const read = (seq: number, id: string, path: string, turnId = 't_1'): ConversationEvent =>
      buildEvent('tool.started', { seq, toolUseId: id, turnId, tool: { name: 'Read', verb: 'read', target: path, file: { root: { kind: 'main' }, path } } });
    const events: ConversationEvent[] = [
      read(1, 'r1', 'src/cart/a.ts'),
      buildEvent('tool.finished', { seq: 2, toolUseId: 'r1', result: {} }),
      read(3, 'r2', 'src/cart/b.ts'),
      read(4, 'r3', 'src/cart/c.ts'),
      buildEvent('tool.started', { seq: 5, toolUseId: 'e1' }),
      read(6, 'r4', 'src/cart/d.ts'),
      read(7, 'r5', 'src/cart/e.ts', 't_2'),
    ];
    const items = foldEvents(events);
    expect(kinds(items)).toEqual(['reads', 'tool', 'tool', 'tool']);
    const reads = items[0] as ReadsItem;
    expect(reads.key).toBe('r:r1');
    expect(reads.tools.map((tool) => tool.toolUseId)).toEqual(['r1', 'r2', 'r3']);
    expect(reads.tools[0]?.finished?.ok).toBe(true);
    // The read of another turn does not join the one before it.
    expect((items[2] as ToolItem).toolUseId).toBe('r4');
    expect((items[3] as ToolItem).toolUseId).toBe('r5');
  });

  it("nests a subagent's tools, text and streaming block under its task", () => {
    const events: ConversationEvent[] = [
      buildEvent('tool.started', { seq: 1, toolUseId: 'task_1', tool: { name: 'Task', verb: 'task', target: 'Look for the cart code' } }),
      buildEvent('tool.started', { seq: 2, toolUseId: 'g1', parentToolUseId: 'task_1', tool: { name: 'Grep', verb: 'search', target: 'cartTotal' } }),
      buildEvent('tool.finished', { seq: 3, toolUseId: 'g1', result: { matches: 7 } }),
      buildEvent('text', { seq: 4, blockId: 'b_sub', parentToolUseId: 'task_1' }),
      buildEvent('text', { seq: 5, blockId: 'b_top' }),
    ];
    const items = foldEvents(events, [{ blockId: 'b_live', turnId: 't_1', parentToolUseId: 'task_1' }]);
    expect(kinds(items)).toEqual(['tool', 'text']);
    const task = items[0] as ToolItem;
    expect(kinds(task.children)).toEqual(['tool', 'text', 'streaming']);
    expect(task.children[2]).toMatchObject({ kind: 'streaming', blockId: 'b_live', key: 's:b_live' });
    // A subagent whose task is before the window stays at the top level.
    expect(kinds(foldEvents([buildEvent('text', { seq: 9, parentToolUseId: 'task_gone' })]))).toEqual(['text']);
  });

  it('puts the blocks that stream now after everything, and cards, pointers and lines where they appeared', () => {
    const events: ConversationEvent[] = [buildEvent('card', { seq: 1, card: 'permission', id: 'pr_1' }), buildEvent('pointer', { seq: 2 }), buildEvent('text', { seq: 3 })];
    const items = foldEvents(events, [{ blockId: 'b_live', turnId: 't_1' }]);
    expect(kinds(items)).toEqual(['card', 'pointer', 'text', 'streaming']);
    expect(items[0]).toMatchObject({ kind: 'card', key: 'c:1', card: 'permission', id: 'pr_1' });
    expect(items[3]).toMatchObject({ seq: 4, lead: false });
  });

  it('keeps the identity of every item nothing changed in, and of an unchanged list', () => {
    const events = [buildEvent('message', { seq: 1 }), buildEvent('text', { seq: 2, blockId: 'b_1' }), buildEvent('tool.started', { seq: 3 })];
    const first = foldEvents(events);
    expect(foldEvents(events, [], first)).toBe(first);
    const more = [...events, buildEvent('tool.finished', { seq: 4 }), buildEvent('delivery', { seq: 5, messageId: 'm_1', state: 'completed' })];
    const second = foldEvents(more, [], first);
    expect(second).not.toBe(first);
    expect(second[1]).toBe(first[1]);
    // The message got a delivery and the tool its result: those two are new objects.
    expect(second[0]).not.toBe(first[0]);
    expect(second[2]).not.toBe(first[2]);
  });

  it('an event replaced under its seq (redaction) changes only its own item', () => {
    const events = [buildEvent('text', { seq: 1, turnId: 't_1' }), buildEvent('message', { seq: 2 }), buildEvent('text', { seq: 3, turnId: 't_2' })];
    const first = foldEvents(events);
    const redacted = [events[0] as ConversationEvent, buildEvent('notice', { seq: 2, text: { id: 'conversation.redacted', params: { by: 'Ian' } }, fallback: 'Ian removed a message' }), events[2] as ConversationEvent];
    const second = foldEvents(redacted, [], first);
    expect(kinds(second)).toEqual(['text', 'notice', 'text']);
    expect(second[0]).toBe(first[0]);
    expect(second[2]).toBe(first[2]);
  });
});

describe('watching a session', () => {
  it('asks for the newest page, then holds the session, the folded items and the cards', async () => {
    const { conn, store, conversation } = setup();
    const release = store.watch(SID);
    expect(conversation()).toMatchObject({ status: 'loading', items: [], firstSeq: 0, nextSeq: 1 });
    expect(conn.requestsOf('session.watch').map((request) => request.payload)).toEqual([{ sessionId: SID, live: true }]);
    const events = buildEvents(['line', 'message', 'card']);
    conn.respond('session.watch', watchReply(events, { questions: [buildQuestion()], hasEarlier: true }));
    await tick();
    expect(conversation()).toMatchObject({ status: 'ready', error: null, firstSeq: 1, nextSeq: 4, hasEarlier: true, pagedIn: false, catchingUp: false });
    expect(conversation().session?.id).toBe(SID);
    expect(kinds(conversation().items)).toEqual(['line', 'message', 'card']);
    expect(conversation().questions.get('q_1')?.status).toBe('open');
    release();
  });

  it('shares one watch between holders and tells the daemon only when the last one is gone', async () => {
    const { conn, store, scheduler, open } = setup();
    const first = await open(buildEvents(['line']));
    const second = store.watch(SID);
    expect(conn.requestsOf('session.watch')).toHaveLength(1);
    first();
    first();
    scheduler.advance(0);
    expect(store.getState().conversations.has(SID)).toBe(true);
    expect(conn.notificationsOf('session.unwatch')).toHaveLength(0);
    second();
    scheduler.advance(0);
    expect(store.getState().conversations.has(SID)).toBe(false);
    expect(conn.notificationsOf('session.unwatch').map((n) => n.payload)).toEqual([{ sessionId: SID }]);
  });

  it('a column that becomes hidden watches again without streaming, and with it again when it shows', async () => {
    const { conn, store, scheduler, open, conversation } = setup();
    let release = await open(buildEvents(['line', 'message']), { streaming: [{ turnId: 't_1', blockId: 'b_1', text: 'So far' }] });
    expect(conversation().streaming).toHaveLength(1);
    // What a React effect does when `visible` changes: release, then watch again in the same task.
    release();
    release = store.watch(SID, { live: false });
    scheduler.advance(0);
    expect(conn.notificationsOf('session.unwatch')).toHaveLength(0);
    expect(conn.lastRequest('session.watch')?.payload).toEqual({ sessionId: SID, live: false, haveSeq: 2 });
    conn.respond('session.watch', watchReply([], { nextSeq: 3, hasEarlier: true, streaming: [{ turnId: 't_1', blockId: 'b_1', text: 'So far, more' }] }));
    await tick();
    // A hidden column holds no streaming blocks and ignores deltas.
    expect(conversation().streaming).toEqual([]);
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 0, text: 'x' });
    expect(conversation().streaming).toEqual([]);
    expect(kinds(conversation().items)).toEqual(['line', 'message']);

    release();
    release = store.watch(SID, { live: true });
    expect(conn.lastRequest('session.watch')?.payload).toEqual({ sessionId: SID, live: true, haveSeq: 2 });
    conn.respond('session.watch', watchReply([], { nextSeq: 3, hasEarlier: true, streaming: [{ turnId: 't_1', blockId: 'b_1', text: 'So far, more' }] }));
    await tick();
    expect(store.streamText(SID, 'b_1')).toBe('So far, more');
    expect(kinds(conversation().items)).toEqual(['line', 'message', 'streaming']);
    release();
  });

  it('two holders: the session streams while one of them is on screen', async () => {
    const { conn, store, open } = setup();
    const hidden = await open(buildEvents(['line']), {}, false);
    expect(conn.lastRequest('session.watch')?.payload).toEqual({ sessionId: SID, live: false });
    const shown = store.watch(SID, { live: true });
    expect(conn.lastRequest('session.watch')?.payload).toEqual({ sessionId: SID, live: true, haveSeq: 1 });
    conn.respond('session.watch', watchReply([], { nextSeq: 2 }));
    await tick();
    shown();
    expect(conn.lastRequest('session.watch')?.payload).toEqual({ sessionId: SID, live: false, haveSeq: 1 });
    hidden();
  });

  it('a failed first watch is an error the column can try again; a lost connection is not', async () => {
    const { conn, store, conversation, errors } = setup();
    store.watch(SID);
    conn.fail('session.watch', new SmurgError('not_found', 'no such session'));
    await tick();
    expect(conversation().status).toBe('error');
    expect(conversation().error).toBeTruthy();
    const again = store.reload(SID);
    expect(conversation().status).toBe('loading');
    conn.respond('session.watch', watchReply(buildEvents(['line'])));
    await again;
    expect(conversation().status).toBe('ready');
    expect(errors).toEqual([]);

    // A new logical channel fails what was pending; the store's load() watches again.
    const other = setup();
    other.store.watch(SID);
    other.conn.admit(makeWelcome({ role: 'host', channelId: 'ch_2' }));
    await tick();
    expect(other.conversation().status).toBe('loading');
    await other.lifecycle.load();
    expect(other.conn.pendingOf('session.watch')).toHaveLength(1);
  });
});

describe('the window', () => {
  it('appends live events, replaces an event that comes again under its seq, and ignores a session nobody watches', async () => {
    const { conn, open, conversation, store } = setup();
    await open(buildEvents(['line', 'message']));
    conn.emit('session.events', { sessionId: SID, events: [buildEvent('turn.started', { seq: 3 }), buildEvent('text', { seq: 4 })] });
    expect(conversation()).toMatchObject({ firstSeq: 1, nextSeq: 5 });
    expect(kinds(conversation().items)).toEqual(['line', 'message', 'text']);
    const before = conversation().items;

    // The same event again changes nothing; a redacted copy replaces the old one.
    conn.emit('session.events', { sessionId: SID, events: [buildEvent('text', { seq: 4 })] });
    expect(conversation().items).toBe(before);
    conn.emit('session.events', { sessionId: SID, events: [buildEvent('notice', { seq: 2, text: { id: 'conversation.redacted', params: { by: 'Ian' } }, fallback: 'Ian removed a message' })] });
    expect(kinds(conversation().items)).toEqual(['line', 'notice', 'text']);
    expect(conversation().nextSeq).toBe(5);

    conn.emit('session.events', { sessionId: 'sess_other', events: [buildEvent('line', { seq: 1 })] });
    expect(store.getState().conversations.size).toBe(1);
  });

  it('an event beyond a gap waits until the missing ones were read', async () => {
    const { conn, open, conversation } = setup();
    await open(buildEvents(['line', 'message']));
    conn.emit('session.events', { sessionId: SID, events: [buildEvent('line', { seq: 5 }), buildEvent('line', { seq: 6 })] });
    expect(conversation()).toMatchObject({ nextSeq: 3, catchingUp: true });
    expect(conn.lastRequest('session.history')?.payload).toEqual({ sessionId: SID, afterSeq: 2, limit: EVENTS_PAGE_MAX });
    conn.respond('session.history', historyReply(lines(3, 2)));
    await tick();
    expect(conversation()).toMatchObject({ nextSeq: 7, catchingUp: false });
    expect(conversation().events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(conn.requestsOf('session.history')).toHaveLength(1);
  });

  it('a watch reply with haveSeq continues the window, or replaces it with the newest page', async () => {
    const { conn, open, conversation, lifecycle } = setup();
    await open(lines(1, 3), { hasEarlier: false });
    lifecycle.onResumed?.();
    expect(conn.lastRequest('session.watch')?.payload).toEqual({ sessionId: SID, live: true, haveSeq: 3 });
    // Meanwhile an event arrived live; the reply repeats it and brings one more.
    conn.emit('session.events', { sessionId: SID, events: lines(4, 1) });
    conn.respond('session.watch', watchReply(lines(4, 2), { hasEarlier: true }));
    await tick();
    expect(conversation().events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    // The window's own "load earlier" is not the reply's (which is about the page it sent).
    expect(conversation().hasEarlier).toBe(false);

    // An empty page: current. "Load earlier" stays what it was.
    lifecycle.onResumed?.();
    conn.respond('session.watch', watchReply([], { nextSeq: 6, hasEarlier: true }));
    await tick();
    expect(conversation()).toMatchObject({ firstSeq: 1, nextSeq: 6, hasEarlier: false });

    // Far behind: the newest page does not begin after haveSeq and replaces the window.
    lifecycle.onResumed?.();
    conn.respond('session.watch', watchReply(lines(5_000, 3), { hasEarlier: true }));
    await tick();
    expect(conversation()).toMatchObject({ firstSeq: 5_000, nextSeq: 5_003, hasEarlier: true, pagedIn: false });
    expect(conversation().events).toHaveLength(3);
  });

  it('follows hasMore with afterSeq until the column is current', async () => {
    const { conn, open, conversation, lifecycle } = setup();
    await open(lines(1, 2));
    lifecycle.onResumed?.();
    conn.respond('session.watch', watchReply(lines(3, 2), { hasMore: true }));
    await tick();
    expect(conversation().catchingUp).toBe(true);
    expect(conn.lastRequest('session.history')?.payload).toEqual({ sessionId: SID, afterSeq: 4, limit: EVENTS_PAGE_MAX });
    conn.respond('session.history', historyReply(lines(5, 2), { hasMore: true }));
    await tick();
    expect(conn.lastRequest('session.history')?.payload).toEqual({ sessionId: SID, afterSeq: 6, limit: EVENTS_PAGE_MAX });
    // A live event that arrives during the catch-up waits its turn.
    conn.emit('session.events', { sessionId: SID, events: lines(9, 1) });
    conn.respond('session.history', historyReply(lines(7, 2)));
    await tick();
    expect(conversation().events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(conversation().catchingUp).toBe(false);
  });

  it('loads earlier pages on top of the window and drops them when the reader is back at the end', async () => {
    const { conn, store, open, conversation } = setup();
    await open(lines(2_001, 500), { hasEarlier: true });
    const loading = store.loadEarlier(SID);
    expect(conversation().loadingEarlier).toBe(true);
    // A second call while one is on its way asks for nothing more.
    void store.loadEarlier(SID);
    expect(conn.requestsOf('session.history').map((request) => request.payload)).toEqual([{ sessionId: SID, beforeSeq: 2_001, limit: EVENTS_PAGE_MAX }]);
    conn.respond('session.history', historyReply(lines(1_501, 500), { hasEarlier: true, questions: [buildQuestion({ id: 'q_old', status: 'answered' })] }));
    await loading;
    expect(conversation()).toMatchObject({ firstSeq: 1_501, nextSeq: 2_501, hasEarlier: true, loadingEarlier: false, pagedIn: true });
    expect(conversation().questions.has('q_old')).toBe(true);

    const again = store.loadEarlier(SID);
    conn.respond('session.history', historyReply(lines(1_001, 500), { hasEarlier: true }));
    await again;
    expect(conversation().events).toHaveLength(1_500);

    store.dropEarlier(SID);
    expect(conversation()).toMatchObject({ firstSeq: 2_501 - WINDOW_KEEP, nextSeq: 2_501, hasEarlier: true, pagedIn: false });
    expect(conversation().events).toHaveLength(WINDOW_KEEP);
    // Nothing earlier: nothing is asked.
    const { conn: conn2, store: store2, open: open2 } = setup();
    await open2(lines(1, 3));
    await store2.loadEarlier(SID);
    expect(conn2.requestsOf('session.history')).toHaveLength(0);
  });

  it('cuts a long live window back while the reader is at the end, never one the reader paged in', async () => {
    const { conn, open, conversation, store } = setup();
    await open(lines(1, 500));
    for (let first = 501; first <= WINDOW_TRIM_ABOVE; first += 50) conn.emit('session.events', { sessionId: SID, events: lines(first, 50) });
    expect(conversation().events).toHaveLength(WINDOW_TRIM_ABOVE);
    conn.emit('session.events', { sessionId: SID, events: lines(WINDOW_TRIM_ABOVE + 1, 1) });
    expect(conversation().events).toHaveLength(WINDOW_KEEP);
    expect(conversation()).toMatchObject({ firstSeq: WINDOW_TRIM_ABOVE + 2 - WINDOW_KEEP, hasEarlier: true });

    const loading = store.loadEarlier(SID);
    conn.respond('session.history', historyReply(lines(conversation().firstSeq - 500, 500), { hasEarlier: true }));
    await loading;
    conn.emit('session.events', { sessionId: SID, events: lines(conversation().nextSeq, 60) });
    expect(conversation().events).toHaveLength(WINDOW_KEEP + 500 + 60);
  });

  it('finds an anchor in the window or reads earlier pages until it has it', async () => {
    const { conn, store, open, conversation } = setup();
    await open([...lines(1_001, 3), buildEvent('card', { seq: 1_004, card: 'permission', id: 'pr_1' })], { hasEarlier: true });
    expect(selectCardSeq(conversation(), 'pr_1')).toBe(1_004);
    await expect(store.showAnchor(SID, { cardId: 'pr_1' })).resolves.toBe(1_004);
    await expect(store.showAnchor(SID, { seq: 1_002 })).resolves.toBe(1_002);
    // An event that does not exist yet is not searched for backwards.
    await expect(store.showAnchor(SID, { seq: 9_999 })).resolves.toBeNull();
    expect(conn.requestsOf('session.history')).toHaveLength(0);

    const finding = store.showAnchor(SID, { cardId: 'q_old' });
    await tick();
    conn.respond('session.history', historyReply(lines(501, 500), { hasEarlier: true }));
    await tick();
    conn.respond('session.history', historyReply([...lines(1, 499), buildEvent('card', { seq: 500, card: 'question', id: 'q_old' })], { hasEarlier: false }));
    await expect(finding).resolves.toBe(500);

    await expect(store.showAnchor(SID, { cardId: 'nope' })).resolves.toBeNull();
    await expect(store.showAnchor('sess_unknown', { seq: 1 })).resolves.toBeNull();
  });
});

describe('streaming deltas', () => {
  it('appends text outside the state, tells the listeners, and ends the block with its text event', async () => {
    const { conn, store, open, conversation } = setup();
    await open(buildEvents(['message', 'turn.started']));
    const heard: string[] = [];
    const off = store.onStream(SID, (blockId) => heard.push(blockId));
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 0, text: 'Hello' });
    const listed = conversation();
    expect(listed.streaming).toEqual([{ blockId: 'b_1', turnId: 't_1' }]);
    expect(kinds(listed.items)).toEqual(['message', 'streaming']);
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 5, text: ', world' });
    // More text is not a change of the store's state.
    expect(conversation()).toBe(listed);
    expect(store.streamText(SID, 'b_1')).toBe('Hello, world');
    expect(heard).toEqual(['b_1', 'b_1']);

    conn.emit('session.events', { sessionId: SID, events: [buildEvent('text', { seq: 3, blockId: 'b_1', text: 'Hello, world.' })] });
    expect(conversation().streaming).toEqual([]);
    expect(kinds(conversation().items)).toEqual(['message', 'text']);
    expect(store.streamText(SID, 'b_1')).toBe('');
    off();
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_2', offset: 0, text: 'x' });
    expect(heard).toHaveLength(2);
  });

  it('a delta sent again from an earlier offset adds only what is new', async () => {
    const { conn, store, open } = setup();
    await open(buildEvents(['turn.started']));
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 0, text: 'abc' });
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 1, text: 'bcde' });
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 0, text: 'ab' });
    expect(store.streamText(SID, 'b_1')).toBe('abcde');
  });

  it('a gap stops the block and watches again at most once in DELTA_REWATCH_MIN_MS', async () => {
    const { conn, store, scheduler, open, conversation } = setup();
    await open(buildEvents(['turn.started']));
    scheduler.advance(DELTA_REWATCH_MIN_MS);
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 0, text: 'abc' });
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 10, text: 'xyz' });
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 13, text: '!' });
    expect(store.streamText(SID, 'b_1')).toBe('abc');
    expect(conn.requestsOf('session.watch')).toHaveLength(2);
    expect(conn.lastRequest('session.watch')?.payload).toEqual({ sessionId: SID, live: true, haveSeq: 1 });
    conn.respond('session.watch', watchReply([], { nextSeq: 2, streaming: [{ turnId: 't_1', blockId: 'b_1', text: 'abc and the rest' }] }));
    await tick();
    expect(store.streamText(SID, 'b_1')).toBe('abc and the rest');

    // Another gap right away: the next watch waits for the interval, however many gaps follow.
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 99, text: '?' });
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_2', offset: 4, text: '?' });
    expect(conn.requestsOf('session.watch')).toHaveLength(2);
    scheduler.advance(DELTA_REWATCH_MIN_MS - 1);
    expect(conn.requestsOf('session.watch')).toHaveLength(2);
    scheduler.advance(1);
    expect(conn.requestsOf('session.watch')).toHaveLength(3);
    // The block whose beginning was missed is listed but holds nothing until the watch answers.
    expect(conversation().streaming.map((block) => block.blockId)).toEqual(['b_1', 'b_2']);
    expect(store.streamText(SID, 'b_2')).toBe('');
  });

  it('thinking makes no block and lasts until the next delta or event of that turn', async () => {
    const { conn, open, conversation } = setup();
    await open(buildEvents(['turn.started']));
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_think', offset: 0, text: '', thinking: true });
    expect(conversation()).toMatchObject({ thinkingTurnId: 't_1', streaming: [] });
    const same = conversation();
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_think', offset: 0, text: '', thinking: true });
    expect(conversation()).toBe(same);
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_1', offset: 0, text: 'So' });
    expect(conversation()).toMatchObject({ thinkingTurnId: null, streaming: [{ blockId: 'b_1' }] });

    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_think', offset: 0, text: '', thinking: true });
    expect(conversation().thinkingTurnId).toBe('t_1');
    conn.emit('session.events', { sessionId: SID, events: [buildEvent('tool.started', { seq: 2, turnId: 't_1' })] });
    expect(conversation().thinkingTurnId).toBeNull();
  });

  it("a subagent's block carries its task from the first delta; a finished turn ends every block of it", async () => {
    const { conn, open, conversation, store } = setup();
    await open([buildEvent('turn.started', { seq: 1 }), buildEvent('tool.started', { seq: 2, toolUseId: 'task_1', tool: { name: 'Task', verb: 'task', target: 'Explore' } })]);
    conn.emit('session.delta', { sessionId: SID, turnId: 't_1', blockId: 'b_sub', offset: 0, text: 'Looking', parentToolUseId: 'task_1' });
    expect(conversation().streaming).toEqual([{ blockId: 'b_sub', turnId: 't_1', parentToolUseId: 'task_1' }]);
    expect(kinds((conversation().items[0] as ToolItem).children)).toEqual(['streaming']);
    conn.emit('session.events', { sessionId: SID, events: [buildEvent('turn.finished', { seq: 3, outcome: 'interrupted' })] });
    expect(conversation().streaming).toEqual([]);
    expect(store.streamText(SID, 'b_sub')).toBe('');
  });
});

describe('cards', () => {
  it('applies the small changes of a question to the card it holds', async () => {
    const { conn, open, conversation } = setup();
    await open(buildEvents(['card']), { questions: [buildQuestion({ eligible: 3 })] });
    const vote = { userId: 'dev:amy', displayName: 'Amy', part: 0, options: [1], at: FAKE_NOW };
    conn.emit('question.changed', { sessionId: SID, questionId: 'q_1', vote });
    conn.emit('question.changed', { sessionId: SID, questionId: 'q_1', vote: { ...vote, options: [0], at: FAKE_NOW + 1 } });
    conn.emit('question.changed', { sessionId: SID, questionId: 'q_1', vote: { userId: 'dev:mei', displayName: 'Mei', part: 0, other: 'Both', at: FAKE_NOW } });
    expect(conversation().questions.get('q_1')?.votes).toEqual([
      { ...vote, options: [0], at: FAKE_NOW + 1 },
      { userId: 'dev:mei', displayName: 'Mei', part: 0, other: 'Both', at: FAKE_NOW },
    ]);
    conn.emit('question.changed', { sessionId: SID, questionId: 'q_1', voteRemoved: { userId: 'dev:mei', part: 0 }, eligible: 2, deciderSeenAt: FAKE_NOW + 5 });
    const comment = { id: 'c_1', from: { userId: 'dev:amy', displayName: 'Amy' }, text: 'A plus a cache', at: FAKE_NOW };
    conn.emit('question.changed', { sessionId: SID, questionId: 'q_1', comment });
    conn.emit('question.changed', { sessionId: SID, questionId: 'q_1', comment });
    expect(conversation().questions.get('q_1')).toMatchObject({ eligible: 2, deciderSeenAt: FAKE_NOW + 5, comments: [comment] });
    expect(conversation().questions.get('q_1')?.votes).toHaveLength(1);
  });

  it('reads the whole card when a change names one the window does not hold', async () => {
    const { conn, open, conversation } = setup();
    await open();
    conn.emit('question.changed', { sessionId: SID, questionId: 'q_7', eligible: 4 });
    expect(conn.lastRequest('session.cards.get')?.payload).toEqual({ sessionId: SID, cards: [{ kind: 'question', id: 'q_7' }] });
    conn.respond('session.cards.get', { questions: [buildQuestion({ id: 'q_7', eligible: 4 })], permissions: [], suggestions: [], moreCards: [] });
    await tick();
    expect(conversation().questions.get('q_7')?.eligible).toBe(4);
  });

  it('replaces a card by its update, for watched sessions only', async () => {
    const { conn, open, conversation, store } = setup();
    await open(buildEvents(['card']), { questions: [buildQuestion()], permissions: [buildPermission()], suggestions: [buildSuggestion()] });
    conn.emit('question.updated', { question: buildQuestion({ status: 'withdrawn', withdrawn: { reason: 'stopped', at: FAKE_NOW } }) });
    conn.emit('permission.updated', { request: buildPermission({ status: 'allowed', decision: { by: { userId: 'dev:mei', displayName: 'Mei' }, at: FAKE_NOW } }) });
    conn.emit('suggest.updated', { suggestion: buildSuggestion({ status: 'rejected', resolvedAt: FAKE_NOW }) });
    expect(conversation().questions.get('q_1')?.status).toBe('withdrawn');
    expect(conversation().permissions.get('pr_1')?.status).toBe('allowed');
    expect(conversation().suggestions.get('sg_1')?.status).toBe('rejected');
    expect(selectOpenCards(conversation())).toEqual([]);

    conn.emit('permission.updated', { request: buildPermission({ id: 'pr_x', sessionId: 'sess_other' }) });
    expect(store.getState().conversations.size).toBe(1);
  });

  it('asks for the cards a page named but did not carry, at most CARDS_GET_MAX at a time', async () => {
    const { conn, open, conversation } = setup();
    const refs = Array.from({ length: CARDS_GET_MAX + 2 }, (_, index) => ({ kind: 'permission' as const, id: `pr_${index}` }));
    await open(buildEvents(['line']), { moreCards: refs });
    expect(conn.lastRequest('session.cards.get')?.payload.cards).toHaveLength(CARDS_GET_MAX);
    conn.respond('session.cards.get', { questions: [], permissions: refs.slice(0, CARDS_GET_MAX).map((ref) => buildPermission({ id: ref.id })), suggestions: [], moreCards: [] });
    await tick();
    expect(conn.lastRequest('session.cards.get')?.payload.cards.map((card) => card.id)).toEqual([`pr_${CARDS_GET_MAX}`, `pr_${CARDS_GET_MAX + 1}`]);
    conn.respond('session.cards.get', { questions: [], permissions: refs.slice(CARDS_GET_MAX).map((ref) => buildPermission({ id: ref.id })), suggestions: [], moreCards: [] });
    await tick();
    expect(conversation().permissions.size).toBe(CARDS_GET_MAX + 2);
    expect(conn.requestsOf('session.cards.get')).toHaveLength(2);
  });

  it('asks for a card whose event arrived but whose entity did not, after a moment', async () => {
    const { conn, open, scheduler, conversation } = setup();
    await open();
    conn.emit('session.events', { sessionId: SID, events: [buildEvent('card', { seq: 1, card: 'permission', id: 'pr_1' }), buildEvent('card', { seq: 2, card: 'suggestion', id: 'sg_1' })] });
    conn.emit('permission.updated', { request: buildPermission() });
    scheduler.advance(MISSING_CARDS_DELAY_MS);
    expect(conn.lastRequest('session.cards.get')?.payload).toEqual({ sessionId: SID, cards: [{ kind: 'suggestion', id: 'sg_1' }] });
    conn.respond('session.cards.get', { questions: [], permissions: [], suggestions: [buildSuggestion()], moreCards: [] });
    await tick();
    expect(conversation().suggestions.has('sg_1')).toBe(true);
  });

  // A conversation's log holds where a card was; the card's content is kept apart on the host, and bounded (a session
  // keeps its newest settled cards; and a host may set cards.json or suggestions.json aside, 0.5.1). The host answers
  // a request for such a card without an error and without the card. The page used to wait for it for ever
  // ("Loading this card…").
  describe('a card whose content the host no longer keeps', () => {
    const empty = { questions: [], permissions: [], suggestions: [], moreCards: [] };
    const cardEvents = (count: number): ConversationEvent[] => Array.from({ length: count }, (_, index) => buildEvent('card', { seq: index + 1, card: 'permission', id: `pr_${index}` }));

    it('is asked for once; the answer neither carries nor names it: the store says it is not kept, and does not ask again', async () => {
      const { conn, open, scheduler, conversation } = setup();
      await open([buildEvent('card', { seq: 1, card: 'question', id: 'q_old' }), buildEvent('card', { seq: 2, card: 'suggestion', id: 'sg_1' })]);
      expect(selectCardGone(conversation(), 'question', 'q_old')).toBe(false);
      scheduler.advance(MISSING_CARDS_DELAY_MS);
      expect(conn.lastRequest('session.cards.get')?.payload.cards).toEqual([{ kind: 'question', id: 'q_old' }, { kind: 'suggestion', id: 'sg_1' }]);
      conn.respond('session.cards.get', { ...empty, suggestions: [buildSuggestion()] });
      await tick();
      expect(selectCardGone(conversation(), 'question', 'q_old')).toBe(true);
      expect(selectCardGone(conversation(), 'suggestion', 'sg_1')).toBe(false);
      expect(conversation().suggestions.has('sg_1')).toBe(true);

      // The next card event makes the store look again: what it knows to be gone is not asked for a second time.
      conn.emit('session.events', { sessionId: SID, events: [buildEvent('card', { seq: 3, card: 'permission', id: 'pr_new' })] });
      scheduler.advance(MISSING_CARDS_DELAY_MS);
      expect(conn.requestsOf('session.cards.get')).toHaveLength(2);
      expect(conn.lastRequest('session.cards.get')?.payload.cards).toEqual([{ kind: 'permission', id: 'pr_new' }]);
    });

    it('a card the answer names as waiting for its turn is not gone, and one that did not fit is asked for again', async () => {
      const { conn, open, scheduler, conversation } = setup();
      await open(cardEvents(2));
      scheduler.advance(MISSING_CARDS_DELAY_MS);
      conn.respond('session.cards.get', { ...empty, permissions: [buildPermission({ id: 'pr_0' })], moreCards: [{ kind: 'permission', id: 'pr_1' }] });
      await tick();
      expect(selectCardGone(conversation(), 'permission', 'pr_1')).toBe(false);
      expect(conn.lastRequest('session.cards.get')?.payload.cards).toEqual([{ kind: 'permission', id: 'pr_1' }]);
      conn.respond('session.cards.get', { ...empty, permissions: [buildPermission({ id: 'pr_1' })] });
      await tick();
      expect(conversation().permissions.size).toBe(2);
      expect(selectCardGone(conversation(), 'permission', 'pr_1')).toBe(false);
    });

    it('many of them (the host set the cards aside) are all found out in one go, twenty at a time, and the asking ends', async () => {
      const { conn, open, scheduler, conversation } = setup();
      const count = CARDS_GET_MAX * 2 + 3;
      await open(cardEvents(count));
      scheduler.advance(MISSING_CARDS_DELAY_MS);
      for (let round = 0; round < 3; round++) {
        expect(conn.requestsOf('session.cards.get')).toHaveLength(round + 1);
        conn.respond('session.cards.get', empty);
        await tick();
      }
      expect(conn.requestsOf('session.cards.get')).toHaveLength(3);
      expect(conn.requestsOf('session.cards.get').map((request) => request.payload.cards.length)).toEqual([CARDS_GET_MAX, CARDS_GET_MAX, 3]);
      for (let index = 0; index < count; index++) expect(selectCardGone(conversation(), 'permission', `pr_${index}`), String(index)).toBe(true);
    });

    it('a host that names the same cards again and again without sending one is not asked for ever', async () => {
      const { conn, open, scheduler } = setup();
      await open(cardEvents(2));
      scheduler.advance(MISSING_CARDS_DELAY_MS);
      conn.respond('session.cards.get', { ...empty, moreCards: [{ kind: 'permission', id: 'pr_0' }, { kind: 'permission', id: 'pr_1' }] });
      await tick();
      expect(conn.requestsOf('session.cards.get')).toHaveLength(1);
    });

    it('a card this page still holds as open: its stale copy goes with the answer, so no button points at nothing', async () => {
      const { conn, open, lifecycle, conversation } = setup();
      await open([buildEvent('card', { seq: 1, card: 'question', id: 'q_1' })], { questions: [buildQuestion()] });
      expect(conversation().questions.get('q_1')?.status).toBe('open');
      // The host stopped, set the cards aside and shares again: the watch after it carries no open card.
      lifecycle.reset();
      await lifecycle.load();
      conn.respond('session.watch', watchReply([], { firstSeq: 0, nextSeq: 2 }));
      await tick();
      expect(conn.lastRequest('session.cards.get')?.payload.cards).toEqual([{ kind: 'question', id: 'q_1' }]);
      conn.respond('session.cards.get', empty);
      await tick();
      expect(conversation().questions.has('q_1')).toBe(false);
      expect(selectCardGone(conversation(), 'question', 'q_1')).toBe(true);
      expect(selectOpenCards(conversation())).toEqual([]);
    });

    it('a fresh channel (the host started again) forgets what the host before said, and the cards are asked for again', async () => {
      const { conn, open, scheduler, lifecycle, conversation } = setup();
      await open(cardEvents(1));
      scheduler.advance(MISSING_CARDS_DELAY_MS);
      conn.respond('session.cards.get', empty);
      await tick();
      expect(selectCardGone(conversation(), 'permission', 'pr_0')).toBe(true);
      // The host put the file back and shares again: the window is continued by an empty page.
      lifecycle.reset();
      expect(selectCardGone(conversation(), 'permission', 'pr_0')).toBe(false);
      await lifecycle.load();
      conn.respond('session.watch', watchReply([], { firstSeq: 0, nextSeq: 2 }));
      await tick();
      scheduler.advance(MISSING_CARDS_DELAY_MS);
      expect(conn.requestsOf('session.cards.get')).toHaveLength(2);
      conn.respond('session.cards.get', { ...empty, permissions: [buildPermission({ id: 'pr_0' })] });
      await tick();
      expect(conversation().permissions.has('pr_0')).toBe(true);
      expect(selectCardGone(conversation(), 'permission', 'pr_0')).toBe(false);
    });

    it('on an earlier page too: a card event without its content is asked for after a moment', async () => {
      const { conn, open, scheduler, store, conversation } = setup();
      await open([buildEvent('line', { seq: 5 })], { hasEarlier: true });
      const earlier = store.loadEarlier(SID);
      conn.respond('session.history', historyReply([buildEvent('card', { seq: 4, card: 'question', id: 'q_old' })]));
      await earlier;
      scheduler.advance(MISSING_CARDS_DELAY_MS);
      expect(conn.lastRequest('session.cards.get')?.payload.cards).toEqual([{ kind: 'question', id: 'q_old' }]);
      conn.respond('session.cards.get', empty);
      await tick();
      expect(selectCardGone(conversation(), 'question', 'q_old')).toBe(true);
    });
  });

  it('lists the cards that wait, oldest first, and the files the session changed, newest first', async () => {
    const { open, conversation } = setup();
    const edit = (seq: number, id: string, path: string): ConversationEvent => buildEvent('tool.started', { seq, toolUseId: id, tool: { name: 'Edit', verb: 'edit', target: path, file: { root: { kind: 'main' }, path } } });
    await open(
      [
        edit(1, 'e1', 'src/a.ts'),
        buildEvent('tool.finished', { seq: 2, toolUseId: 'e1' }),
        edit(3, 'e2', 'src/b.ts'),
        buildEvent('tool.finished', { seq: 4, toolUseId: 'e2' }),
        edit(5, 'e3', 'src/a.ts'),
        buildEvent('tool.finished', { seq: 6, toolUseId: 'e3' }),
        edit(7, 'e4', 'src/failed.ts'),
        buildEvent('tool.finished', { seq: 8, toolUseId: 'e4', ok: false }),
        buildEvent('tool.started', { seq: 9, toolUseId: 'rd', tool: { name: 'Read', verb: 'read', target: 'src/c.ts', file: { root: { kind: 'main' }, path: 'src/c.ts' } } }),
      ],
      {
        questions: [buildQuestion({ askedAt: FAKE_NOW + 10 }), buildQuestion({ id: 'q_done', status: 'answered' })],
        permissions: [buildPermission({ askedAt: FAKE_NOW + 5 })],
      },
    );
    expect(selectOpenCards(conversation())).toEqual([
      { kind: 'permission', id: 'pr_1', askedAt: FAKE_NOW + 5 },
      { kind: 'question', id: 'q_1', askedAt: FAKE_NOW + 10 },
    ]);
    expect(selectChangedFiles(conversation()).map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('around a Welcome, and the requests', () => {
  it('watches every open session again after a resumed Welcome and after a full resync, with what it has', async () => {
    const { conn, store, open, lifecycle, conversation } = setup();
    await open(lines(1, 4));
    const other = store.watch('sess_b', { live: false });
    conn.respond('session.watch', watchReply([], { session: buildAgentSession({ id: 'sess_b' }) }));
    await tick();
    lifecycle.onResumed?.();
    expect(conn.pendingOf('session.watch').map((request) => request.payload)).toEqual([
      { sessionId: SID, live: true, haveSeq: 4 },
      { sessionId: 'sess_b', live: false },
    ]);
    // A full resync: the connection fails what was pending, reset() keeps the windows on screen, load() watches.
    conn.admit(makeWelcome({ role: 'host', channelId: 'ch_2' }));
    lifecycle.reset();
    await lifecycle.load();
    expect(conversation().events).toHaveLength(4);
    expect(conn.pendingOf('session.watch').map((request) => request.payload.sessionId)).toEqual([SID, 'sess_b']);
    other();
  });

  it('a card it holds as open that a later watch reply does not carry was settled while it was away: it is read again (the column stayed open through a restart)', async () => {
    const { conn, open, lifecycle, conversation } = setup();
    const cards = [
      buildEvent('card', { seq: 1, card: 'question', id: 'q_1' }),
      buildEvent('card', { seq: 2, card: 'permission', id: 'pr_1' }),
      buildEvent('card', { seq: 3, card: 'suggestion', id: 'sg_1' }),
      buildEvent('card', { seq: 4, card: 'permission', id: 'pr_2' }),
      buildEvent('card', { seq: 5, card: 'permission', id: 'pr_3' }),
      buildEvent('card', { seq: 6, card: 'question', id: 'q_old' }),
    ];
    await open(cards, {
      questions: [buildQuestion(), buildQuestion({ id: 'q_old', status: 'answered' })],
      permissions: [buildPermission(), buildPermission({ id: 'pr_2' }), buildPermission({ id: 'pr_3' })],
      suggestions: [buildSuggestion()],
    });
    expect(selectOpenCards(conversation()).map((card) => card.id).sort()).toEqual(['pr_1', 'pr_2', 'pr_3', 'q_1']);

    // The connection was away while the host's smurg restarted: the question was answered, one permission request
    // and the suggestion were withdrawn. pr_2 is still open (the reply carries it), pr_3 is named in moreCards.
    lifecycle.onResumed?.();
    expect(conn.lastRequest('session.watch')?.payload).toEqual({ sessionId: SID, live: true, haveSeq: 6 });
    conn.respond('session.watch', watchReply([], { firstSeq: 0, nextSeq: 7, permissions: [buildPermission({ id: 'pr_2' })], moreCards: [{ kind: 'permission', id: 'pr_3' }] }));
    await tick();
    // Read: every card held as open or pending that the reply neither carries nor names, and the named one. Not the
    // card it carried, not the one that was settled before.
    const asked = conn.requestsOf('session.cards.get').flatMap((request) => request.payload.cards.map((card) => `${card.kind}:${card.id}`));
    expect(asked.sort()).toEqual(['permission:pr_1', 'permission:pr_3', 'question:q_1', 'suggestion:sg_1']);
    for (const request of conn.pendingOf('session.cards.get')) {
      const ids = new Set(request.payload.cards.map((card) => card.id));
      request.resolve({
        questions: ids.has('q_1') ? [buildQuestion({ status: 'answered' })] : [],
        permissions: [...(ids.has('pr_1') ? [buildPermission({ status: 'withdrawn' })] : []), ...(ids.has('pr_3') ? [buildPermission({ id: 'pr_3' })] : [])],
        suggestions: ids.has('sg_1') ? [buildSuggestion({ status: 'withdrawn' })] : [],
        moreCards: [],
      });
    }
    await tick();
    expect(conversation().questions.get('q_1')?.status).toBe('answered');
    expect(conversation().permissions.get('pr_1')?.status).toBe('withdrawn');
    expect(conversation().suggestions.get('sg_1')?.status).toBe('withdrawn');
    expect(selectOpenCards(conversation()).map((card) => card.id).sort()).toEqual(['pr_2', 'pr_3']);
  });

  it('the same after a full resync whose reply replaces the window, and nothing is read when every open card is carried', async () => {
    const { conn, open, lifecycle, conversation } = setup();
    await open([buildEvent('card', { seq: 1, card: 'permission', id: 'pr_1' }), ...lines(2, 3)], { permissions: [buildPermission()] });
    conn.admit(makeWelcome({ role: 'host', channelId: 'ch_2' }));
    lifecycle.reset();
    await lifecycle.load();
    // A reply that carries the card: nothing to read.
    conn.respond('session.watch', watchReply([], { firstSeq: 0, nextSeq: 5, permissions: [buildPermission()] }));
    await tick();
    expect(conn.requestsOf('session.cards.get')).toHaveLength(0);
    // The next one replaces the window with a newer page; the card's event is no longer in it, the card is still held.
    lifecycle.onResumed?.();
    conn.respond('session.watch', watchReply(lines(40, 3), { hasEarlier: true }));
    await tick();
    expect(conn.lastRequest('session.cards.get')?.payload).toEqual({ sessionId: SID, cards: [{ kind: 'permission', id: 'pr_1' }] });
    conn.respond('session.cards.get', { questions: [], permissions: [buildPermission({ status: 'denied' })], suggestions: [], moreCards: [] });
    await tick();
    expect(selectOpenCards(conversation())).toEqual([]);
  });

  it('keeps the session current from session.state', async () => {
    const { conn, open, conversation } = setup();
    await open();
    conn.emit('session.state', { session: buildAgentSession({ id: SID, status: 'running', runningSince: FAKE_NOW }) });
    expect(conversation().session).toMatchObject({ status: 'running', runningSince: FAKE_NOW });
  });

  it('sends a message, votes, comments, submits, reminds, marks seen and decides', async () => {
    const { conn, store, open, conversation } = setup();
    await open(buildEvents(['card']), { questions: [buildQuestion()], permissions: [buildPermission()] });
    conn.handle('session.message.send', () => ({ messageId: 'm_9' }));
    await expect(store.send(SID, 'Add the test', { mentions: ['dev:mei'], origin: 'selection' })).resolves.toBe('m_9');
    await store.send(SID, 'And run it', { mentions: [] });
    expect(conn.requestsOf('session.message.send').map((request) => request.payload)).toEqual([
      { sessionId: SID, text: 'Add the test', mentions: ['dev:mei'], origin: 'selection' },
      { sessionId: SID, text: 'And run it' },
    ]);

    conn.handle('question.vote', () => ({}));
    await store.vote('q_1', 0, { options: [1] });
    await store.vote('q_1', 0, { other: 'Both' });
    expect(conn.requestsOf('question.vote').map((request) => request.payload)).toEqual([
      { questionId: 'q_1', part: 0, options: [1] },
      { questionId: 'q_1', part: 0, other: 'Both' },
    ]);

    conn.handle('question.comment', () => ({ commentId: 'c_1' }));
    await store.comment('q_1', '@Mei please submit', ['dev:mei']);
    await store.comment('q_1', 'Fine with A');
    expect(conn.requestsOf('question.comment').map((request) => request.payload)).toEqual([
      { questionId: 'q_1', text: '@Mei please submit', mentions: ['dev:mei'] },
      { questionId: 'q_1', text: 'Fine with A' },
    ]);

    conn.handle('question.remind', () => ({}));
    await store.remind('q_1');
    store.seen('q_1');
    expect(conn.notificationsOf('question.seen').map((n) => n.payload)).toEqual([{ questionId: 'q_1' }]);

    const answered = buildQuestion({ status: 'answered', answer: { parts: [{ options: [0] }], note: 'Keep it simple', by: { userId: 'dev:host', displayName: 'Host' }, at: FAKE_NOW, tally: [[0, 0, 0]] } });
    conn.handle('question.submit', () => ({ question: answered }));
    await store.submit('q_1', [{ options: [0] }], 'Keep it simple');
    expect(conn.lastRequest('question.submit')?.payload).toEqual({ questionId: 'q_1', answers: [{ options: [0] }], note: 'Keep it simple' });
    expect(conversation().questions.get('q_1')?.status).toBe('answered');

    const allowed = buildPermission({ status: 'allowed', decision: { by: { userId: 'dev:host', displayName: 'Host' }, at: FAKE_NOW, always: 'topic' } });
    conn.handle('permission.decide', () => ({ request: allowed }));
    await store.decide('pr_1', { decision: 'allow-always', scope: 'topic' });
    expect(conn.lastRequest('permission.decide')?.payload).toEqual({ requestId: 'pr_1', decision: 'allow-always', scope: 'topic' });
    expect(conversation().permissions.get('pr_1')?.status).toBe('allowed');
  });

  it('a suggestion settles with the reply of its request, for a watched session only', async () => {
    const { store, open, conversation } = setup();
    await open([buildEvent('card', { seq: 1, card: 'suggestion', id: 'sg_1' })], { suggestions: [buildSuggestion({ id: 'sg_1', sessionId: SID })] });
    store.applySuggestion(buildSuggestion({ id: 'sg_1', sessionId: SID, status: 'rejected' }));
    expect(conversation().suggestions.get('sg_1')?.status).toBe('rejected');
    store.applySuggestion(buildSuggestion({ id: 'sg_9', sessionId: 'sess_other' }));
    expect(store.getState().conversations.size).toBe(1);
  });

  it('unbinds its listeners', () => {
    const { conn, unbind } = setup();
    expect(conn.listenerCount('session.events')).toBe(1);
    unbind();
    for (const type of ['session.events', 'session.delta', 'session.state', 'question.updated', 'question.changed', 'permission.updated', 'suggest.updated'] as const) {
      expect(conn.listenerCount(type)).toBe(0);
    }
  });
});
