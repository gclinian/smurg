// The conversations of the agent sessions this browser has in a column (DESIGN §5.3, §5.5; ARCHITECTURE §5.9).
//
// A conversation is an append-only log of events with a sequence number, read as a WINDOW (never the whole log), plus
// the cards its events point to (questions, permission requests, suggestions: entities that change after they
// appeared) and the text blocks that are streaming right now.
//
//   const release = conversations.watch(sessionId, { live: column.visible });   // ref-counted; a hidden column: live false
//   const conversation = useStore(conversations, (state) => state.conversations.get(sessionId));
//   conversation.items            // the FOLDED list React renders: messages, agent text, tools, cards, lines …
//   conversations.streamText(sessionId, blockId)                                // the text of a streaming block …
//   conversations.onStream(sessionId, (blockId) => …)                            // … and its changes, outside React state
//   release();                                                                   // closing the column unwatches
//
// What the store guarantees:
//   - the window is contiguous: an event that arrives beyond a gap waits until the missing ones were fetched;
//   - an event that arrives again under a `seq` the window has REPLACES the old one (redaction);
//   - the session is watched again after EVERY Welcome, resumed ones too (streaming deltas are volatile), with
//     `haveSeq`, so the reply continues the window or replaces it (P0-API §4.2 rule 1);
//   - a card the window holds as open that such a reply does not carry was settled meanwhile: it is read again, so a
//     column that stayed open through a disconnect never keeps a decided or withdrawn card with its buttons;
//   - a delta beyond what a block holds stops that block until its `text` event; the session is watched again at
//     most once in DELTA_REWATCH_MIN_MS (rule 5);
//   - items keep their identity between folds while nothing in them changed, so a memoised row does not render again;
//   - streaming text never changes the store's state: only the LIST of streaming blocks does.
import {
  CARDS_GET_MAX,
  DELTA_REWATCH_MIN_MS,
  EVENTS_PAGE_MAX,
  isEditTool,
  type AgentSession,
  type CardKind,
  type CardRef,
  type ConversationEvent,
  type ConversationEventOf,
  type FileRef,
  type PayloadInputOf,
  type PayloadOf,
  type PermissionRequest,
  type Question,
  type ResultOf,
  type StreamingBlock,
  type Suggestion,
  type ToolView,
} from '@smurg/protocol';
import { isClientRequestError } from '@smurg/protocol/client';
import { describeError } from '../errors.ts';
import { createStore, type ReadableStore } from '../store.ts';
import type { AreaLifecycle, LoadStatus, StoreContext } from './base.ts';
import { compareIds } from '../format.ts';

// ---------------------------------------------------------------------------------------------------------------
// Render items: what the event list shows, folded from the events (DESIGN §5.3)
// ---------------------------------------------------------------------------------------------------------------

export type Delivery = ConversationEventOf<'delivery'>['state'];

interface ItemBase {
  /** Stable between folds: React's key, and the key of the remembered height. */
  readonly key: string;
  /** The `seq` of the item's first event: where an anchor finds it, and its place in the order. */
  readonly seq: number;
  readonly at: number;
}

/** What a person sent (also an accepted suggestion: `event.suggestion`). */
export interface MessageItem extends ItemBase {
  readonly kind: 'message';
  readonly event: ConversationEventOf<'message'>;
  /** The latest `delivery` of the message inside the window; null: none seen. */
  readonly delivery: Delivery | null;
}

/** What smurg itself told the agent: one folded line. */
export interface SmurgItem extends ItemBase {
  readonly kind: 'smurg';
  readonly event: ConversationEventOf<'smurg'>;
  readonly delivery: Delivery | null;
}

/** Consecutive finished text blocks of one turn, between tools. */
export interface TextItem extends ItemBase {
  readonly kind: 'text';
  readonly turnId: string;
  readonly blocks: readonly ConversationEventOf<'text'>[];
  /** The first piece of the agent after something else: the row shows "Claude" and the time. */
  readonly lead: boolean;
}

/** A text block that streams right now (its text: `streamText`). */
export interface StreamingItem extends ItemBase {
  readonly kind: 'streaming';
  readonly turnId: string;
  readonly blockId: string;
  readonly lead: boolean;
}

/** A tool call with its result; a subagent's (Task) own pieces nest under it. */
export interface ToolItem extends ItemBase {
  readonly kind: 'tool';
  readonly turnId: string;
  readonly toolUseId: string;
  readonly tool: ToolView;
  readonly started: ConversationEventOf<'tool.started'>;
  /** Null while it runs, and when it never got a result (its turn was stopped, or the host removed the result). */
  readonly finished: ConversationEventOf<'tool.finished'> | null;
  /** No result yet and its turn has not ended: the line says "Running". */
  readonly running: boolean;
  readonly children: readonly AgentPiece[];
  readonly lead: boolean;
}

/** Two or more consecutive file reads of one turn: one line that expands to the list. */
export interface ReadsItem extends ItemBase {
  readonly kind: 'reads';
  readonly turnId: string;
  readonly tools: readonly ToolItem[];
  readonly lead: boolean;
}

/** Where a card appeared; the entity is in the conversation's `questions` / `permissions` / `suggestions`. */
export interface CardItem extends ItemBase {
  readonly kind: 'card';
  readonly card: CardKind;
  readonly id: string;
}

/** "The spec / plan / report changed here": the next-step card. */
export interface PointerItem extends ItemBase {
  readonly kind: 'pointer';
  readonly event: ConversationEventOf<'pointer'>;
}

export interface LineItem extends ItemBase {
  readonly kind: 'line';
  readonly event: ConversationEventOf<'line'>;
}

export interface NoticeItem extends ItemBase {
  readonly kind: 'notice';
  readonly event: ConversationEventOf<'notice'>;
}

/** A turn that did not simply complete: stopped, failed, out of turns or budget. */
export interface TurnEndItem extends ItemBase {
  readonly kind: 'turn-end';
  readonly event: ConversationEventOf<'turn.finished'>;
}

/** What the agent itself produced (these can nest under a subagent's tool). */
export type AgentPiece = TextItem | StreamingItem | ToolItem | ReadsItem;
export type RenderItem = MessageItem | SmurgItem | AgentPiece | CardItem | PointerItem | LineItem | NoticeItem | TurnEndItem;

/** A streaming block as the list knows it (no text). */
export interface StreamingRef {
  readonly blockId: string;
  readonly turnId: string;
  readonly parentToolUseId?: string;
}

const isAgentPiece = (item: RenderItem): item is AgentPiece => item.kind === 'text' || item.kind === 'streaming' || item.kind === 'tool' || item.kind === 'reads';

type Draft =
  | { kind: 'message'; event: ConversationEventOf<'message'> }
  | { kind: 'smurg'; event: ConversationEventOf<'smurg'> }
  | { kind: 'text'; turnId: string; blocks: ConversationEventOf<'text'>[] }
  | { kind: 'streaming'; block: StreamingRef; seq: number; at: number }
  | ToolDraft
  | { kind: 'card'; event: ConversationEventOf<'card'> }
  | { kind: 'pointer'; event: ConversationEventOf<'pointer'> }
  | { kind: 'line'; event: ConversationEventOf<'line'> }
  | { kind: 'notice'; event: ConversationEventOf<'notice'> }
  | { kind: 'turn-end'; event: ConversationEventOf<'turn.finished'> };

interface ToolDraft {
  kind: 'tool';
  started: ConversationEventOf<'tool.started'>;
  finished: ConversationEventOf<'tool.finished'> | null;
  children: Draft[];
}

function sameRefs<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function sameItem(a: RenderItem, b: RenderItem): boolean {
  if (a.kind !== b.kind || a.key !== b.key || a.seq !== b.seq) return false;
  switch (a.kind) {
    case 'message':
    case 'smurg':
      return a.event === (b as MessageItem | SmurgItem).event && a.delivery === (b as MessageItem | SmurgItem).delivery;
    case 'text':
      return a.lead === (b as TextItem).lead && sameRefs(a.blocks, (b as TextItem).blocks);
    case 'streaming':
      return a.lead === (b as StreamingItem).lead && a.turnId === (b as StreamingItem).turnId;
    case 'tool':
      return (
        a.lead === (b as ToolItem).lead &&
        a.started === (b as ToolItem).started &&
        a.finished === (b as ToolItem).finished &&
        a.running === (b as ToolItem).running &&
        sameRefs(a.children, (b as ToolItem).children)
      );
    case 'reads':
      return a.lead === (b as ReadsItem).lead && sameRefs(a.tools, (b as ReadsItem).tools);
    case 'card':
      return a.card === (b as CardItem).card && a.id === (b as CardItem).id;
    case 'pointer':
    case 'line':
    case 'notice':
    case 'turn-end':
      return a.event === (b as PointerItem | LineItem | NoticeItem | TurnEndItem).event;
  }
}

/** Every item of a folded list by key, nested ones included (what the next fold reuses). */
function indexItems(items: readonly RenderItem[], into: Map<string, RenderItem> = new Map()): Map<string, RenderItem> {
  for (const item of items) {
    into.set(item.key, item);
    if (item.kind === 'tool') indexItems(item.children, into);
    else if (item.kind === 'reads') indexItems(item.tools, into);
  }
  return into;
}

/**
 * Folds a window of events (ascending by `seq`) and the blocks streaming now into the list React renders. `previous`
 * is the last fold of the same conversation: an item nothing changed in is returned as the same object, and an
 * unchanged list as the same array.
 */
export function foldEvents(events: readonly ConversationEvent[], streaming: readonly StreamingRef[] = [], previous: readonly RenderItem[] = []): readonly RenderItem[] {
  const top: Draft[] = [];
  const tools = new Map<string, ToolDraft>();
  const delivery = new Map<string, Delivery>();
  const endedTurns = new Set<string>();
  const containerOf = (parentToolUseId: string | undefined): Draft[] => (parentToolUseId === undefined ? top : (tools.get(parentToolUseId)?.children ?? top));

  for (const event of events) {
    switch (event.kind) {
      case 'delivery':
        delivery.set(event.messageId, event.state);
        break;
      case 'message':
      case 'smurg':
      case 'card':
      case 'pointer':
      case 'line':
      case 'notice':
        top.push({ kind: event.kind, event } as Draft);
        break;
      case 'turn.started':
        break;
      case 'turn.finished':
        endedTurns.add(event.turnId);
        // A turn that completed says nothing: the status bar and the next message do.
        if (event.outcome !== 'completed') top.push({ kind: 'turn-end', event });
        break;
      case 'text': {
        const list = containerOf(event.parentToolUseId);
        const last = list.at(-1);
        if (last?.kind === 'text' && last.turnId === event.turnId) last.blocks.push(event);
        else list.push({ kind: 'text', turnId: event.turnId, blocks: [event] });
        break;
      }
      case 'tool.started': {
        const draft: ToolDraft = { kind: 'tool', started: event, finished: null, children: [] };
        tools.set(event.toolUseId, draft);
        containerOf(event.parentToolUseId).push(draft);
        break;
      }
      case 'tool.finished': {
        // A result whose call is before the window has no view to show: it joins its call when that page is loaded.
        const draft = tools.get(event.toolUseId);
        if (draft) draft.finished = event;
        break;
      }
    }
  }
  const last = events.at(-1);
  const endSeq = (last?.seq ?? 0) + 1;
  const endAt = last?.at ?? 0;
  for (const block of streaming) containerOf(block.parentToolUseId).push({ kind: 'streaming', block, seq: endSeq, at: endAt });

  const known = indexItems(previous);
  const keep = <T extends RenderItem>(item: T): T => {
    const before = known.get(item.key);
    return before !== undefined && sameItem(before, item) ? (before as T) : item;
  };

  const build = (drafts: readonly Draft[]): RenderItem[] => {
    const out: RenderItem[] = [];
    let previousWasAgent = false;
    for (let index = 0; index < drafts.length; index++) {
      const draft = drafts[index] as Draft;
      const lead = !previousWasAgent;
      let item: RenderItem;
      switch (draft.kind) {
        case 'message':
        case 'smurg':
          item = { kind: draft.kind, key: `m:${draft.event.seq}`, seq: draft.event.seq, at: draft.event.at, event: draft.event, delivery: delivery.get(draft.event.messageId) ?? null } as MessageItem | SmurgItem;
          break;
        case 'text': {
          const first = draft.blocks[0] as ConversationEventOf<'text'>;
          item = { kind: 'text', key: `t:${first.seq}`, seq: first.seq, at: first.at, turnId: draft.turnId, blocks: draft.blocks, lead };
          break;
        }
        case 'streaming':
          item = { kind: 'streaming', key: `s:${draft.block.blockId}`, seq: draft.seq, at: draft.at, turnId: draft.block.turnId, blockId: draft.block.blockId, lead };
          break;
        case 'tool': {
          // A run of file reads of one turn becomes one line.
          let end = index;
          if (isPlainRead(draft)) {
            while (end + 1 < drafts.length && isPlainRead(drafts[end + 1] as Draft) && (drafts[end + 1] as ToolDraft).started.turnId === draft.started.turnId) end++;
          }
          if (end > index) {
            const run = drafts.slice(index, end + 1) as ToolDraft[];
            const members = run.map((member) => keep(toolItem(member, [], false, endedTurns)));
            item = { kind: 'reads', key: `r:${draft.started.toolUseId}`, seq: draft.started.seq, at: draft.started.at, turnId: draft.started.turnId, tools: members, lead };
            index = end;
          } else {
            item = toolItem(draft, build(draft.children) as AgentPiece[], lead, endedTurns);
          }
          break;
        }
        case 'card':
          item = { kind: 'card', key: `c:${draft.event.seq}`, seq: draft.event.seq, at: draft.event.at, card: draft.event.card, id: draft.event.id };
          break;
        case 'pointer':
        case 'line':
        case 'notice':
        case 'turn-end':
          item = { kind: draft.kind, key: `${draft.kind[0]}:${draft.event.seq}`, seq: draft.event.seq, at: draft.event.at, event: draft.event } as PointerItem | LineItem | NoticeItem | TurnEndItem;
          break;
      }
      const kept = keep(item);
      out.push(kept);
      previousWasAgent = isAgentPiece(kept);
    }
    return out;
  };

  const items = build(top);
  return sameRefs(items, previous) ? previous : items;
}

function isPlainRead(draft: Draft): draft is ToolDraft {
  return draft.kind === 'tool' && draft.started.tool.verb === 'read' && draft.children.length === 0;
}

function toolItem(draft: ToolDraft, children: readonly AgentPiece[], lead: boolean, endedTurns: ReadonlySet<string>): ToolItem {
  const { started } = draft;
  return {
    kind: 'tool',
    key: `u:${started.toolUseId}`,
    seq: started.seq,
    at: started.at,
    turnId: started.turnId,
    toolUseId: started.toolUseId,
    tool: started.tool,
    started,
    finished: draft.finished,
    running: draft.finished === null && !endedTurns.has(started.turnId),
    children,
    lead,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------------

export interface Conversation {
  readonly sessionId: string;
  /** `loading` until the first page arrived; `error` when the first watch failed. */
  readonly status: LoadStatus;
  /** A sentence in the language of the moment it was made, when status is 'error'. */
  readonly error: string | null;
  /** The session as the last watch reply or `session.state` gave it; null before the first page. */
  readonly session: AgentSession | null;
  /** The window: ascending, contiguous by `seq`. */
  readonly events: readonly ConversationEvent[];
  readonly items: readonly RenderItem[];
  /** The `seq` of the first event of the window; 0 while it is empty. */
  readonly firstSeq: number;
  /** The `seq` the next event will have; 1 for an empty conversation. */
  readonly nextSeq: number;
  /** Events exist before the window ("load earlier"). */
  readonly hasEarlier: boolean;
  readonly loadingEarlier: boolean;
  /** Earlier pages were loaded on top of the newest window (the reader went up): the window is not trimmed. */
  readonly pagedIn: boolean;
  /** Events exist after the window and are being fetched (a reconnect far behind, an event beyond a gap). */
  readonly catchingUp: boolean;
  readonly questions: ReadonlyMap<string, Question>;
  readonly permissions: ReadonlyMap<string, PermissionRequest>;
  readonly suggestions: ReadonlyMap<string, Suggestion>;
  /**
   * The cards the host answered it no longer keeps, as `kind:id`: asked for by name (`session.cards.get`), and the
   * answer neither carried the card nor named it as waiting for its turn. A conversation's log holds where a card
   * was; its content is kept apart on the host and bounded, and a host may have set that file aside. Read through
   * `selectCardGone`: the card's place says so instead of waiting for content that will not come.
   */
  readonly cardsGone: ReadonlySet<string>;
  /** The blocks streaming right now, in the order they began. */
  readonly streaming: readonly StreamingRef[];
  /** The turn the agent thinks in: a thinking delta arrived and nothing of that turn since. */
  readonly thinkingTurnId: string | null;
}

export interface ConversationsState {
  /** By session id: the sessions something on this page watches. */
  readonly conversations: ReadonlyMap<string, Conversation>;
}

export const INITIAL_CONVERSATIONS_STATE: ConversationsState = Object.freeze({ conversations: new Map() });

const EMPTY_MAP: ReadonlyMap<string, never> = new Map<string, never>();
const EMPTY_SET: ReadonlySet<never> = new Set<never>();

function emptyConversation(sessionId: string): Conversation {
  return {
    sessionId,
    status: 'loading',
    error: null,
    session: null,
    events: [],
    items: [],
    firstSeq: 0,
    nextSeq: 1,
    hasEarlier: false,
    loadingEarlier: false,
    pagedIn: false,
    catchingUp: false,
    questions: EMPTY_MAP,
    permissions: EMPTY_MAP,
    suggestions: EMPTY_MAP,
    cardsGone: EMPTY_SET,
    streaming: [],
    thinkingTurnId: null,
  };
}

/** While the reader is at the end the window keeps at most this many events … */
export const WINDOW_TRIM_ABOVE = 1_500;
/** … and is cut back to this many (the rest is behind "load earlier"). */
export const WINDOW_KEEP = 1_000;
/** How many pages `showAnchor` reads backwards before it gives up. */
export const ANCHOR_PAGES_MAX = 40;
/** How long a card event may wait for its entity before the store asks for it (`session.cards.get`). */
export const MISSING_CARDS_DELAY_MS = 400;

export type WatchOptions = { readonly live?: boolean };

export type QuestionAnswerInput = PayloadInputOf<'question.submit'>['answers'][number];
export type VoteInput = { readonly options: readonly number[] } | { readonly other: string };
export type PermissionDecision = Omit<PayloadInputOf<'permission.decide'>, 'requestId'>;

export interface ConversationsStore extends ReadableStore<ConversationsState> {
  /**
   * Watches a session for as long as the returned function was not called. Several holders share one watch; the
   * session streams (`session.delta`) while at least one holder is `live` (default true).
   */
  watch(sessionId: string, options?: WatchOptions): () => void;
  /** Watches again now (the "Try again" of a failed first load). */
  reload(sessionId: string): Promise<void>;
  /** One page before the window (`session.history`); nothing when there is none or one is on its way. */
  loadEarlier(sessionId: string): Promise<void>;
  /** The reader is back at the end: what was paged in goes again. */
  dropEarlier(sessionId: string): void;
  /**
   * Makes sure the window holds the anchor (a card's event, or the event of `seq`), reading earlier pages when it is
   * older than the window. Resolves with the `seq` to scroll to, or null when the conversation does not have it.
   */
  showAnchor(sessionId: string, anchor: { readonly cardId?: string; readonly seq?: number }): Promise<number | null>;
  /** The text a streaming block holds right now ('' for an unknown block). */
  streamText(sessionId: string, blockId: string): string;
  /** Called with the block id whenever a streaming block of the session got more text (or new text from a watch). */
  onStream(sessionId: string, listener: (blockId: string) => void): () => void;

  // ---- the conversation's own requests (the requests ABOUT a session, stop / retry / who is responsible / the
  // permission mode, are the sessions store's)
  /** session.drive: a message to the agent. Resolves with the message id. */
  send(sessionId: string, text: string, options?: { readonly mentions?: readonly string[]; readonly origin?: 'composer' | 'selection' }): Promise<string>;

  // ---- cards (discuss: vote, comment, submit, remind, seen; session.drive: decide)
  vote(questionId: string, part: number, vote: VoteInput): Promise<void>;
  comment(questionId: string, text: string, mentions?: readonly string[]): Promise<void>;
  submit(questionId: string, answers: readonly QuestionAnswerInput[], note?: string): Promise<void>;
  remind(questionId: string): Promise<void>;
  /** The decider (or the host) has the card on screen. */
  seen(questionId: string): void;
  decide(requestId: string, decision: PermissionDecision): Promise<void>;
  /**
   * A suggestion as a request of the suggestions store answered it (accept, reject, edit, withdraw): the card of a
   * watched session settles with the reply, without waiting for `suggest.updated`.
   */
  applySuggestion(suggestion: Suggestion): void;
}

// ---- selectors

export const selectConversation = (state: ConversationsState, sessionId: string): Conversation | undefined => state.conversations.get(sessionId);

/** The cards of a conversation that wait for someone, oldest first: what the status bar leads to. */
export function selectOpenCards(conversation: Conversation): { readonly kind: 'question' | 'permission'; readonly id: string; readonly askedAt: number }[] {
  const open: { kind: 'question' | 'permission'; id: string; askedAt: number }[] = [];
  for (const question of conversation.questions.values()) if (question.status === 'open') open.push({ kind: 'question', id: question.id, askedAt: question.askedAt });
  for (const request of conversation.permissions.values()) if (request.status === 'open') open.push({ kind: 'permission', id: request.id, askedAt: request.askedAt });
  return open.sort((a, b) => a.askedAt - b.askedAt || compareIds(a.id, b.id));
}

/** The host no longer keeps this card's content, and this page holds none: what the card's place in the conversation says. */
export function selectCardGone(conversation: Conversation | undefined, kind: CardRef['kind'], id: string): boolean {
  if (conversation === undefined || !conversation.cardsGone.has(cardKey({ kind, id }))) return false;
  return !(kind === 'question' ? conversation.questions : kind === 'permission' ? conversation.permissions : conversation.suggestions).has(id);
}

/** The `seq` of the event where a card appeared, when the window holds it. */
export function selectCardSeq(conversation: Conversation, cardId: string): number | null {
  for (const event of conversation.events) if (event.kind === 'card' && event.id === cardId) return event.seq;
  return null;
}

/**
 * The files the session's edit tools changed (inside the window), newest change first, each once: code mode's
 * "Changed by this session" list.
 */
export function selectChangedFiles(conversation: Conversation): FileRef[] {
  const finished = new Map<string, boolean>();
  for (const event of conversation.events) if (event.kind === 'tool.finished') finished.set(event.toolUseId, event.ok);
  const seen = new Set<string>();
  const files: FileRef[] = [];
  for (let index = conversation.events.length - 1; index >= 0; index--) {
    const event = conversation.events[index] as ConversationEvent;
    if (event.kind !== 'tool.started' || event.tool.file === undefined) continue;
    if (!isEditTool(event.tool.name) && event.tool.verb !== 'edit' && event.tool.verb !== 'create') continue;
    if (finished.get(event.toolUseId) !== true) continue;
    const key = JSON.stringify(event.tool.file);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(event.tool.file);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------------------------
// The area
// ---------------------------------------------------------------------------------------------------------------

interface StreamBuffer {
  readonly turnId: string;
  readonly parentToolUseId: string | undefined;
  text: string;
  /** A delta arrived beyond what the block holds: nothing more is appended until its `text` event or a new watch. */
  stalled: boolean;
}

/** What the store keeps per watched session outside its (immutable) state. */
interface Entry {
  readonly holders: Set<{ live: boolean }>;
  /** What the daemon was last told. */
  live: boolean;
  readonly buffers: Map<string, StreamBuffer>;
  readonly streamListeners: Set<(blockId: string) => void>;
  /** Events that arrived beyond a gap, by `seq`. */
  readonly pending: Map<number, ConversationEvent>;
  /** The newest watch request: an older reply is still merged, but only the newest one sets the streaming blocks. */
  ticket: number;
  catchUp: Promise<void> | null;
  earlier: Promise<void> | null;
  lastRewatchAt: number;
  rewatchTimer: unknown;
  releaseTimer: unknown;
  cardsTimer: unknown;
  readonly cardsAsked: Set<string>;
}

type EventsPage = Pick<ResultOf<'session.history'>, 'events' | 'questions' | 'permissions' | 'suggestions' | 'moreCards'>;

function withCards<V extends { readonly id: string }>(map: ReadonlyMap<string, V>, cards: readonly V[]): ReadonlyMap<string, V> {
  if (cards.length === 0) return map;
  const next = new Map(map);
  for (const card of cards) next.set(card.id, card);
  return next;
}

const cardKey = (card: CardRef): string => `${card.kind}:${card.id}`;

export function createConversationsArea(): { store: ConversationsStore; lifecycle: AreaLifecycle } {
  const state = createStore<ConversationsState>(INITIAL_CONVERSATIONS_STATE);
  const entries = new Map<string, Entry>();
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('conversations store is not bound to a connection');
    return ctx;
  };

  const get = (sessionId: string): Conversation | undefined => state.getState().conversations.get(sessionId);

  /** Applies `change` to a conversation that is still watched; folds again when the events or the blocks changed. */
  const update = (sessionId: string, change: (conversation: Conversation) => Conversation): void => {
    state.setState((previous) => {
      const before = previous.conversations.get(sessionId);
      if (before === undefined) return previous;
      let after = change(before);
      if (after === before) return previous;
      if (after.events !== before.events || after.streaming !== before.streaming) {
        const items = foldEvents(after.events, after.streaming, before.items);
        if (items !== after.items) after = { ...after, items };
      }
      const conversations = new Map(previous.conversations);
      conversations.set(sessionId, after);
      return { conversations };
    });
  };

  const notifyStream = (entry: Entry, blockId: string): void => {
    for (const listener of [...entry.streamListeners]) {
      try {
        listener(blockId);
      } catch (error) {
        ctx?.reportError('conversations', error);
      }
    }
  };

  // ---- the window

  /** The window with `events` (ascending, contiguous) merged in: same `seq` replaces, the rest extends an end. */
  const mergeEvents = (conversation: Conversation, events: readonly ConversationEvent[]): Conversation => {
    if (events.length === 0) return conversation;
    if (conversation.events.length === 0) {
      return { ...conversation, events: [...events], firstSeq: (events[0] as ConversationEvent).seq, nextSeq: (events.at(-1) as ConversationEvent).seq + 1 };
    }
    const bySeq = new Map<number, ConversationEvent>();
    let changed = false;
    const before: ConversationEvent[] = [];
    const after: ConversationEvent[] = [];
    for (const event of events) {
      if (event.seq < conversation.firstSeq) before.push(event);
      else if (event.seq >= conversation.nextSeq) after.push(event);
      else bySeq.set(event.seq, event);
    }
    // Only pieces that touch the window: a page that would leave a hole is not merged here (see applyWatch).
    const touchesStart = before.length > 0 && (before.at(-1) as ConversationEvent).seq === conversation.firstSeq - 1;
    const touchesEnd = after.length > 0 && (after[0] as ConversationEvent).seq === conversation.nextSeq;
    let window: readonly ConversationEvent[] = conversation.events;
    if (bySeq.size > 0) {
      window = conversation.events.map((event) => {
        const copy = bySeq.get(event.seq);
        if (copy === undefined || sameEvent(copy, event)) return event;
        changed = true;
        return copy;
      });
      if (!changed) window = conversation.events;
    }
    if (touchesStart) window = [...before, ...window];
    if (touchesEnd) window = [...window, ...after];
    if (window === conversation.events) return conversation;
    return { ...conversation, events: window, firstSeq: (window[0] as ConversationEvent).seq, nextSeq: (window.at(-1) as ConversationEvent).seq + 1 };
  };

  /** Events of the window end blocks and the "thinking" mark; a finished turn ends all of its blocks. */
  const settleStreaming = (entry: Entry, conversation: Conversation, events: readonly ConversationEvent[]): Conversation => {
    if (conversation.streaming.length === 0 && conversation.thinkingTurnId === null) return conversation;
    const endedBlocks = new Set<string>();
    const endedTurns = new Set<string>();
    let thinkingTurnId = conversation.thinkingTurnId;
    for (const event of events) {
      if (event.kind === 'text') endedBlocks.add(event.blockId);
      if (event.kind === 'turn.finished') endedTurns.add(event.turnId);
      if (thinkingTurnId !== null && 'turnId' in event && event.turnId === thinkingTurnId) thinkingTurnId = null;
    }
    let streaming = conversation.streaming;
    if (endedBlocks.size > 0 || endedTurns.size > 0) {
      const kept = streaming.filter((block) => !endedBlocks.has(block.blockId) && !endedTurns.has(block.turnId));
      if (kept.length !== streaming.length) {
        for (const block of streaming) if (!kept.includes(block)) entry.buffers.delete(block.blockId);
        streaming = kept;
      }
    }
    if (streaming === conversation.streaming && thinkingTurnId === conversation.thinkingTurnId) return conversation;
    return { ...conversation, streaming, thinkingTurnId };
  };

  /** While the reader is at the end, the window is cut back so a long live session does not grow without bound. */
  const trimmed = (conversation: Conversation, force = false): Conversation => {
    if (conversation.pagedIn && !force) return conversation;
    if (conversation.events.length <= (force ? WINDOW_KEEP : WINDOW_TRIM_ABOVE)) return conversation.pagedIn ? { ...conversation, pagedIn: false } : conversation;
    const events = conversation.events.slice(-WINDOW_KEEP);
    return { ...conversation, events, firstSeq: (events[0] as ConversationEvent).seq, hasEarlier: true, pagedIn: false };
  };

  const applyCards = (conversation: Conversation, page: Pick<EventsPage, 'questions' | 'permissions' | 'suggestions'>): Conversation => {
    const questions = withCards(conversation.questions, page.questions);
    const permissions = withCards(conversation.permissions, page.permissions);
    const suggestions = withCards(conversation.suggestions, page.suggestions);
    if (questions === conversation.questions && permissions === conversation.permissions && suggestions === conversation.suggestions) return conversation;
    return { ...conversation, questions, permissions, suggestions };
  };

  /** Appends what waited beyond a gap and has become contiguous. */
  const drainPending = (entry: Entry, conversation: Conversation): Conversation => {
    if (entry.pending.size === 0) return conversation;
    const ready: ConversationEvent[] = [];
    let seq = conversation.nextSeq;
    for (;;) {
      const event = entry.pending.get(seq);
      if (event === undefined) break;
      ready.push(event);
      entry.pending.delete(seq);
      seq++;
    }
    for (const waiting of [...entry.pending.keys()]) if (waiting < seq) entry.pending.delete(waiting);
    return ready.length === 0 ? conversation : mergeEvents(conversation, ready);
  };

  // ---- cards the page named but did not carry

  /**
   * The host answered a request for these cards without them: it no longer keeps them. Remembered (the place of each
   * says so, and none is asked for again), and a copy this page still held goes: the host would not know the card a
   * button of it names.
   */
  const withCardsGone = (conversation: Conversation, gone: readonly CardRef[]): Conversation => {
    if (gone.length === 0) return conversation;
    const cardsGone = new Set(conversation.cardsGone);
    const held = { question: conversation.questions, permission: conversation.permissions, suggestion: conversation.suggestions };
    for (const card of gone) {
      cardsGone.add(cardKey(card));
      if (!held[card.kind].has(card.id)) continue;
      const without = new Map<string, never>(held[card.kind] as ReadonlyMap<string, never>);
      without.delete(card.id);
      held[card.kind] = without;
    }
    return { ...conversation, cardsGone, questions: held.question, permissions: held.permission, suggestions: held.suggestion };
  };

  const fetchCards = async (sessionId: string, entry: Entry, cards: readonly CardRef[]): Promise<void> => {
    let rest = cards.filter((card) => !entry.cardsAsked.has(cardKey(card)));
    for (const card of rest) entry.cardsAsked.add(cardKey(card));
    try {
      while (rest.length > 0) {
        const asked = rest.slice(0, CARDS_GET_MAX);
        const reply = await context().conn.request('session.cards.get', { sessionId, cards: asked });
        if (entries.get(sessionId) !== entry) return;
        // An asked card the answer neither carries nor names (as one that did not fit) is not kept on the host any more.
        const answered = new Set<string>(reply.moreCards.map(cardKey));
        for (const card of reply.questions) answered.add(cardKey({ kind: 'question', id: card.id }));
        for (const card of reply.permissions) answered.add(cardKey({ kind: 'permission', id: card.id }));
        for (const card of reply.suggestions) answered.add(cardKey({ kind: 'suggestion', id: card.id }));
        const gone = asked.filter((card) => !answered.has(cardKey(card)));
        update(sessionId, (conversation) => withCardsGone(applyCards(conversation, reply), gone));
        // What did not fit comes back named again; never ask for the same slice forever.
        const more = reply.moreCards.filter((card) => asked.some((one) => cardKey(one) === cardKey(card)) || rest.some((one) => cardKey(one) === cardKey(card)));
        rest = [...more, ...rest.slice(CARDS_GET_MAX).filter((card) => !more.some((one) => cardKey(one) === cardKey(card)))];
        // Go on while an answer brings something: a card, or the knowledge that one is gone.
        if (reply.questions.length + reply.permissions.length + reply.suggestions.length === 0 && gone.length === 0) break;
      }
    } catch (error) {
      if (!isClientRequestError(error)) ctx?.reportError('conversations', error);
    } finally {
      for (const card of cards) entry.cardsAsked.delete(cardKey(card));
    }
  };

  /**
   * A card event whose entity never arrived (an update lost with a connection, or a card whose content the host no
   * longer keeps) is asked for after a moment.
   */
  const scheduleMissingCards = (sessionId: string, entry: Entry): void => {
    const c = context();
    if (entry.cardsTimer !== null) return;
    entry.cardsTimer = c.scheduler.setTimeout(() => {
      entry.cardsTimer = null;
      const conversation = get(sessionId);
      if (entries.get(sessionId) !== entry || conversation === undefined) return;
      const missing: CardRef[] = [];
      for (const event of conversation.events) {
        if (event.kind !== 'card') continue;
        const has = event.card === 'question' ? conversation.questions.has(event.id) : event.card === 'permission' ? conversation.permissions.has(event.id) : conversation.suggestions.has(event.id);
        // What the host said it no longer keeps is not asked for again.
        if (!has && !conversation.cardsGone.has(cardKey({ kind: event.card, id: event.id }))) missing.push({ kind: event.card, id: event.id });
      }
      if (missing.length > 0) void fetchCards(sessionId, entry, missing);
    }, MISSING_CARDS_DELAY_MS);
  };

  // ---- reading

  const applyPage = (sessionId: string, entry: Entry, page: EventsPage, merge: (conversation: Conversation) => Conversation): void => {
    update(sessionId, (conversation) => {
      let next = merge(conversation);
      next = applyCards(next, page);
      next = settleStreaming(entry, next, page.events);
      next = drainPending(entry, next);
      return trimmed(next);
    });
    if (page.moreCards.length > 0) void fetchCards(sessionId, entry, page.moreCards);
    if (page.events.some((event) => event.kind === 'card')) scheduleMissingCards(sessionId, entry);
  };

  /** Reads forward from the end of the window until nothing is after it (`hasMore` after a reconnect; a gap). */
  const catchUp = (sessionId: string, entry: Entry): Promise<void> => {
    if (entry.catchUp) return entry.catchUp;
    const run = async (): Promise<void> => {
      update(sessionId, (conversation) => (conversation.catchingUp ? conversation : { ...conversation, catchingUp: true }));
      try {
        for (;;) {
          const conversation = get(sessionId);
          if (entries.get(sessionId) !== entry || conversation === undefined) return;
          const reply = await context().conn.request('session.history', { sessionId, afterSeq: conversation.nextSeq - 1, limit: EVENTS_PAGE_MAX });
          if (entries.get(sessionId) !== entry) return;
          applyPage(sessionId, entry, reply, (current) => mergeEvents(current, reply.events));
          if (!reply.hasMore || reply.events.length === 0) return;
        }
      } catch (error) {
        if (!isClientRequestError(error)) ctx?.reportError('conversations', error);
      } finally {
        entry.catchUp = null;
        if (entries.get(sessionId) === entry) update(sessionId, (conversation) => (conversation.catchingUp ? { ...conversation, catchingUp: false } : conversation));
      }
    };
    entry.catchUp = run();
    return entry.catchUp;
  };

  const effectiveLive = (entry: Entry): boolean => [...entry.holders].some((holder) => holder.live);

  const setStreaming = (entry: Entry, conversation: Conversation, blocks: readonly StreamingBlock[]): Conversation => {
    entry.buffers.clear();
    for (const block of blocks) entry.buffers.set(block.blockId, { turnId: block.turnId, parentToolUseId: block.parentToolUseId, text: block.text, stalled: false });
    const refs: StreamingRef[] = blocks.map((block) => {
      const before = conversation.streaming.find((one) => one.blockId === block.blockId);
      return before ?? { blockId: block.blockId, turnId: block.turnId, ...(block.parentToolUseId === undefined ? {} : { parentToolUseId: block.parentToolUseId }) };
    });
    return sameRefs(refs, conversation.streaming) ? conversation : { ...conversation, streaming: refs };
  };

  const requestWatch = async (sessionId: string): Promise<void> => {
    const entry = entries.get(sessionId);
    const before = get(sessionId);
    if (entry === undefined || before === undefined) return;
    const c = context();
    const haveSeq = before.events.length > 0 ? before.nextSeq - 1 : undefined;
    const live = effectiveLive(entry);
    entry.live = live;
    entry.lastRewatchAt = c.scheduler.now();
    const ticket = ++entry.ticket;
    let reply: ResultOf<'session.watch'>;
    try {
      reply = await c.conn.request('session.watch', { sessionId, live, ...(haveSeq === undefined ? {} : { haveSeq }) });
    } catch (error) {
      if (entries.get(sessionId) !== entry || ticket !== entry.ticket) return;
      // The connection went: the next Welcome watches again.
      if (isClientRequestError(error)) return;
      if (get(sessionId)?.status === 'loading') update(sessionId, (conversation) => ({ ...conversation, status: 'error', error: describeError(error) }));
      else c.reportError('conversations', error);
      return;
    }
    if (entries.get(sessionId) !== entry) return;
    const newest = ticket === entry.ticket;
    applyPage(sessionId, entry, reply, (conversation) => {
      // Continue or replace (P0-API §4.2 rule 1): an empty page, or one that begins right after what was asked for,
      // continues the window; anything else is the newest page and replaces it.
      const continues = haveSeq !== undefined && conversation.events.length > 0 && (reply.events.length === 0 || reply.firstSeq === haveSeq + 1);
      let next: Conversation;
      if (continues) {
        next = mergeEvents(conversation, reply.events);
      } else {
        for (const seq of [...entry.pending.keys()]) if (seq < reply.nextSeq) entry.pending.delete(seq);
        next = { ...conversation, events: reply.events, firstSeq: reply.firstSeq, nextSeq: reply.nextSeq, hasEarlier: reply.hasEarlier, pagedIn: false };
      }
      next = { ...next, status: 'ready', error: null, session: reply.session };
      // Only the newest answer knows what streams NOW; a hidden column holds no blocks.
      if (newest) {
        next = setStreaming(entry, next, live ? reply.streaming : []);
        if (!live && next.thinkingTurnId !== null) next = { ...next, thinkingTurnId: null };
      }
      return next;
    });
    if (newest) for (const block of reply.streaming) notifyStream(entry, block.blockId);
    if (reply.hasMore) void catchUp(sessionId, entry);
    if (newest) readSettledCards(sessionId, entry, reply);
    // The window may hold card events without their content although this page brought none (it continued the
    // window after a fresh channel, which forgot which cards the host no longer keeps).
    scheduleMissingCards(sessionId, entry);
  };

  /**
   * A watch reply carries every OPEN card of its session, or names it in `moreCards`. A card this window still holds
   * as open (or a suggestion as pending) that the reply neither carries nor names was answered, decided or withdrawn
   * while this client was not told: the connection was away, the host's smurg was started again. A column that stayed
   * open would go on showing it with its buttons, so it is read (P0-API §4.2; the rule of `tests/e2e/src/flow.ts`).
   */
  const readSettledCards = (sessionId: string, entry: Entry, reply: ResultOf<'session.watch'>): void => {
    const conversation = get(sessionId);
    if (conversation === undefined) return;
    const carried = new Set<string>(reply.moreCards.map(cardKey));
    for (const card of reply.questions) carried.add(cardKey({ kind: 'question', id: card.id }));
    for (const card of reply.permissions) carried.add(cardKey({ kind: 'permission', id: card.id }));
    for (const card of reply.suggestions) carried.add(cardKey({ kind: 'suggestion', id: card.id }));
    const settled: CardRef[] = [];
    const look = (kind: CardRef['kind'], cards: Iterable<{ readonly id: string; readonly status: string }>, waiting: string): void => {
      for (const card of cards) if (card.status === waiting && !carried.has(cardKey({ kind, id: card.id }))) settled.push({ kind, id: card.id });
    };
    look('question', conversation.questions.values(), 'open');
    look('permission', conversation.permissions.values(), 'open');
    look('suggestion', conversation.suggestions.values(), 'pending');
    if (settled.length > 0) void fetchCards(sessionId, entry, settled);
  };

  /** Watch again because a delta did not fit: at most once per session in DELTA_REWATCH_MIN_MS. */
  const rewatchForDeltas = (sessionId: string, entry: Entry): void => {
    const c = context();
    if (entry.rewatchTimer !== null) return;
    const wait = entry.lastRewatchAt + DELTA_REWATCH_MIN_MS - c.scheduler.now();
    if (wait <= 0) {
      void requestWatch(sessionId);
      return;
    }
    entry.rewatchTimer = c.scheduler.setTimeout(() => {
      entry.rewatchTimer = null;
      if (entries.get(sessionId) === entry) void requestWatch(sessionId);
    }, wait);
  };

  const watchAll = (): void => {
    for (const sessionId of entries.keys()) void requestWatch(sessionId);
  };

  // ---- events from the daemon

  const onEvents = ({ sessionId, events }: PayloadOf<'session.events'>): void => {
    const entry = entries.get(sessionId);
    const conversation = get(sessionId);
    if (entry === undefined || conversation === undefined || conversation.status !== 'ready') return;
    const fits: ConversationEvent[] = [];
    let expected = conversation.events.length === 0 ? null : conversation.nextSeq;
    for (const event of events) {
      if (expected === null || event.seq <= expected) {
        fits.push(event);
        if (expected === null) expected = event.seq + 1;
        else if (event.seq === expected) expected++;
      } else {
        entry.pending.set(event.seq, event);
      }
    }
    if (fits.length > 0) applyPage(sessionId, entry, { events: fits, questions: [], permissions: [], suggestions: [], moreCards: [] }, (current) => mergeEvents(current, fits));
    if (entry.pending.size > 0) void catchUp(sessionId, entry);
  };

  const onDelta = (delta: PayloadOf<'session.delta'>): void => {
    const entry = entries.get(delta.sessionId);
    const conversation = get(delta.sessionId);
    if (entry === undefined || conversation === undefined || conversation.status !== 'ready' || !entry.live) return;
    if (delta.thinking === true) {
      if (conversation.thinkingTurnId !== delta.turnId) update(delta.sessionId, (current) => ({ ...current, thinkingTurnId: delta.turnId }));
      return;
    }
    let buffer = entry.buffers.get(delta.blockId);
    if (buffer === undefined) {
      // A block this window never saw begin. Its first delta starts it; a later one means the beginning was missed.
      buffer = { turnId: delta.turnId, parentToolUseId: delta.parentToolUseId, text: '', stalled: false };
      entry.buffers.set(delta.blockId, buffer);
      const ref: StreamingRef = { blockId: delta.blockId, turnId: delta.turnId, ...(delta.parentToolUseId === undefined ? {} : { parentToolUseId: delta.parentToolUseId }) };
      update(delta.sessionId, (current) => ({ ...current, streaming: [...current.streaming, ref], thinkingTurnId: null }));
    } else if (conversation.thinkingTurnId !== null) {
      update(delta.sessionId, (current) => ({ ...current, thinkingTurnId: null }));
    }
    if (buffer.stalled) return;
    const held = buffer.text.length;
    if (delta.offset > held) {
      buffer.stalled = true;
      rewatchForDeltas(delta.sessionId, entry);
      return;
    }
    // A delta sent again from an earlier offset (the runner repeats what reached nobody) adds only what is new.
    const fresh = delta.text.slice(held - delta.offset);
    if (fresh.length === 0) return;
    buffer.text += fresh;
    notifyStream(entry, delta.blockId);
  };

  const sessionOfQuestion = (questionId: string): string | null => {
    for (const conversation of state.getState().conversations.values()) if (conversation.questions.has(questionId)) return conversation.sessionId;
    return null;
  };

  const onQuestionChanged = (change: PayloadOf<'question.changed'>): void => {
    const entry = entries.get(change.sessionId);
    const conversation = get(change.sessionId);
    if (entry === undefined || conversation === undefined) return;
    const question = conversation.questions.get(change.questionId);
    if (question === undefined) {
      // A change of a card this window does not hold yet: read the whole card.
      void fetchCards(change.sessionId, entry, [{ kind: 'question', id: change.questionId }]);
      return;
    }
    let votes = question.votes;
    if (change.voteRemoved !== undefined) {
      const removed = change.voteRemoved;
      votes = votes.filter((vote) => !(vote.userId === removed.userId && vote.part === removed.part));
    }
    if (change.vote !== undefined) {
      const added = change.vote;
      votes = [...votes.filter((vote) => !(vote.userId === added.userId && vote.part === added.part)), added];
    }
    const added = change.comment;
    const comments = added === undefined || question.comments.some((comment) => comment.id === added.id) ? question.comments : [...question.comments, added];
    const next: Question = {
      ...question,
      votes,
      comments,
      ...(change.eligible === undefined ? {} : { eligible: change.eligible }),
      ...(change.deciderSeenAt === undefined ? {} : { deciderSeenAt: change.deciderSeenAt }),
    };
    update(change.sessionId, (current) => ({ ...current, questions: withCards(current.questions, [next]) }));
  };

  const upsertCard = <K extends 'questions' | 'permissions' | 'suggestions'>(sessionId: string, field: K, card: Conversation[K] extends ReadonlyMap<string, infer V> ? V : never): void => {
    update(sessionId, (conversation) => ({ ...conversation, [field]: withCards(conversation[field] as ReadonlyMap<string, { id: string }>, [card as { id: string }]) }));
  };

  // ---- the store

  const drop = (sessionId: string, entry: Entry): void => {
    const c = context();
    if (entry.rewatchTimer !== null) c.scheduler.clearTimeout(entry.rewatchTimer);
    if (entry.cardsTimer !== null) c.scheduler.clearTimeout(entry.cardsTimer);
    entries.delete(sessionId);
    state.setState((previous) => {
      if (!previous.conversations.has(sessionId)) return previous;
      const conversations = new Map(previous.conversations);
      conversations.delete(sessionId);
      return { conversations };
    });
    try {
      c.conn.notify('session.unwatch', { sessionId }, { whenDisconnected: 'drop' });
    } catch {
      // a closed connection watches nothing
    }
  };

  const store: ConversationsStore = {
    getState: state.getState,
    subscribe: state.subscribe,

    watch(sessionId, options = {}) {
      const c = context();
      const holder = { live: options.live !== false };
      let entry = entries.get(sessionId);
      if (entry === undefined) {
        entry = {
          holders: new Set(),
          live: holder.live,
          buffers: new Map(),
          streamListeners: new Set(),
          pending: new Map(),
          ticket: 0,
          catchUp: null,
          earlier: null,
          lastRewatchAt: 0,
          rewatchTimer: null,
          releaseTimer: null,
          cardsTimer: null,
          cardsAsked: new Set(),
        };
        entries.set(sessionId, entry);
        entry.holders.add(holder);
        state.setState((previous) => ({ conversations: new Map(previous.conversations).set(sessionId, emptyConversation(sessionId)) }));
        void requestWatch(sessionId);
      } else {
        entry.holders.add(holder);
        if (entry.releaseTimer !== null) {
          c.scheduler.clearTimeout(entry.releaseTimer);
          entry.releaseTimer = null;
        }
        if (effectiveLive(entry) !== entry.live) void requestWatch(sessionId);
      }
      const held = entry;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.holders.delete(holder);
        if (entries.get(sessionId) !== held) return;
        if (held.holders.size > 0) {
          if (effectiveLive(held) !== held.live) void requestWatch(sessionId);
          return;
        }
        // A column that only changes how it watches (visible ⇄ hidden) releases and watches again in one go: wait
        // for the end of this task before telling the daemon.
        if (held.releaseTimer !== null) return;
        held.releaseTimer = c.scheduler.setTimeout(() => {
          held.releaseTimer = null;
          if (entries.get(sessionId) === held && held.holders.size === 0) drop(sessionId, held);
        }, 0);
      };
    },

    async reload(sessionId) {
      if (!entries.has(sessionId)) return;
      update(sessionId, (conversation) => (conversation.status === 'error' ? { ...conversation, status: 'loading', error: null } : conversation));
      await requestWatch(sessionId);
    },

    loadEarlier(sessionId) {
      const entry = entries.get(sessionId);
      const conversation = get(sessionId);
      if (entry === undefined || conversation === undefined || conversation.status !== 'ready' || !conversation.hasEarlier || conversation.events.length === 0) return Promise.resolve();
      if (entry.earlier) return entry.earlier;
      const run = async (): Promise<void> => {
        update(sessionId, (current) => ({ ...current, loadingEarlier: true }));
        try {
          const beforeSeq = (get(sessionId) as Conversation).firstSeq;
          const reply = await context().conn.request('session.history', { sessionId, beforeSeq, limit: EVENTS_PAGE_MAX });
          if (entries.get(sessionId) !== entry) return;
          update(sessionId, (current) => {
            // The window moved meanwhile (a newest page replaced it): this page no longer touches it.
            const merged = mergeEvents(current, reply.events);
            const joined = merged !== current || reply.events.length === 0;
            const next = applyCards(joined ? { ...merged, hasEarlier: reply.hasEarlier, pagedIn: merged.pagedIn || reply.events.length > 0 } : merged, reply);
            return next;
          });
          if (reply.moreCards.length > 0) void fetchCards(sessionId, entry, reply.moreCards);
          if (reply.events.some((event) => event.kind === 'card')) scheduleMissingCards(sessionId, entry);
        } finally {
          entry.earlier = null;
          if (entries.get(sessionId) === entry) update(sessionId, (current) => (current.loadingEarlier ? { ...current, loadingEarlier: false } : current));
        }
      };
      entry.earlier = run();
      return entry.earlier;
    },

    dropEarlier(sessionId) {
      update(sessionId, (conversation) => (conversation.pagedIn ? trimmed(conversation, true) : conversation));
    },

    async showAnchor(sessionId, anchor) {
      const find = (conversation: Conversation): number | null => {
        if (anchor.cardId !== undefined) {
          const seq = selectCardSeq(conversation, anchor.cardId);
          if (seq !== null) return seq;
        }
        if (anchor.seq !== undefined && conversation.events.length > 0 && anchor.seq >= conversation.firstSeq && anchor.seq < conversation.nextSeq) return anchor.seq;
        return null;
      };
      for (let page = 0; page <= ANCHOR_PAGES_MAX; page++) {
        const conversation = get(sessionId);
        if (conversation === undefined || conversation.status !== 'ready') return null;
        const found = find(conversation);
        if (found !== null) return found;
        // Only what is older than the window can still be read; a `seq` after it does not exist (yet).
        if (!conversation.hasEarlier) return null;
        if (anchor.cardId === undefined && anchor.seq !== undefined && anchor.seq >= conversation.nextSeq) return null;
        const firstSeq = conversation.firstSeq;
        await store.loadEarlier(sessionId);
        if (get(sessionId)?.firstSeq === firstSeq) return null;
      }
      return null;
    },

    streamText(sessionId, blockId) {
      return entries.get(sessionId)?.buffers.get(blockId)?.text ?? '';
    },

    onStream(sessionId, listener) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return () => {};
      entry.streamListeners.add(listener);
      return () => {
        entry.streamListeners.delete(listener);
      };
    },

    async send(sessionId, text, options = {}) {
      const payload: PayloadInputOf<'session.message.send'> = {
        sessionId,
        text,
        ...(options.mentions !== undefined && options.mentions.length > 0 ? { mentions: [...options.mentions] } : {}),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      };
      return (await context().conn.request('session.message.send', payload)).messageId;
    },

    async vote(questionId, part, vote) {
      await context().conn.request('question.vote', 'other' in vote ? { questionId, part, other: vote.other } : { questionId, part, options: [...vote.options] });
    },
    async comment(questionId, text, mentions) {
      await context().conn.request('question.comment', mentions !== undefined && mentions.length > 0 ? { questionId, text, mentions: [...mentions] } : { questionId, text });
    },
    async submit(questionId, answers, note) {
      const { question } = await context().conn.request('question.submit', note === undefined ? { questionId, answers: [...answers] } : { questionId, answers: [...answers], note });
      const sessionId = sessionOfQuestion(questionId) ?? question.sessionId;
      upsertCard(sessionId, 'questions', question);
    },
    async remind(questionId) {
      await context().conn.request('question.remind', { questionId });
    },
    seen(questionId) {
      try {
        context().conn.notify('question.seen', { questionId }, { whenDisconnected: 'drop' });
      } catch {
        // a closed connection: nothing to tell
      }
    },
    async decide(requestId, decision) {
      const { request: settled } = await context().conn.request('permission.decide', { requestId, ...decision });
      upsertCard(settled.sessionId, 'permissions', settled);
    },
    applySuggestion(suggestion) {
      upsertCard(suggestion.sessionId, 'suggestions', suggestion);
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      const offs = [
        c.conn.on('session.events', onEvents),
        c.conn.on('session.delta', onDelta),
        c.conn.on('session.state', ({ session }) => {
          if (session.kind !== 'agent' || !entries.has(session.id)) return;
          update(session.id, (conversation) => (conversation.session === null ? conversation : { ...conversation, session }));
        }),
        c.conn.on('question.updated', ({ question }) => upsertCard(question.sessionId, 'questions', question)),
        c.conn.on('question.changed', onQuestionChanged),
        c.conn.on('permission.updated', ({ request: updated }) => upsertCard(updated.sessionId, 'permissions', updated)),
        c.conn.on('suggest.updated', ({ suggestion }) => upsertCard(suggestion.sessionId, 'suggestions', suggestion)),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    // A fresh logical channel forgot every watch. The windows stay on screen and are continued (or replaced) by the
    // watch that load() sends with `haveSeq`.
    reset() {
      for (const [sessionId, entry] of entries) {
        entry.pending.clear();
        entry.catchUp = null;
        entry.earlier = null;
        // Which cards the host no longer keeps was the answer of the host's smurg as it ran then: asked again.
        update(sessionId, (conversation) => (conversation.cardsGone.size === 0 ? conversation : { ...conversation, cardsGone: EMPTY_SET }));
      }
    },
    async load() {
      watchAll();
    },
    // Deltas are volatile: what streamed while the link was away is in the watch reply's `streaming`.
    onResumed() {
      watchAll();
    },
    dispose() {
      const c = ctx;
      for (const entry of entries.values()) {
        if (c && entry.rewatchTimer !== null) c.scheduler.clearTimeout(entry.rewatchTimer);
        if (c && entry.releaseTimer !== null) c.scheduler.clearTimeout(entry.releaseTimer);
        if (c && entry.cardsTimer !== null) c.scheduler.clearTimeout(entry.cardsTimer);
      }
      entries.clear();
    },
  };

  return { store, lifecycle };
}

/** Two copies of one event say the same (a replayed event is not a change). */
function sameEvent(a: ConversationEvent, b: ConversationEvent): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.seq !== b.seq || a.at !== b.at) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
