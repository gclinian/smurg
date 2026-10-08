// The cards of every agent session: questions and permission requests (ARCHITECTURE §5.9, §7.1). The conversation log
// holds a `card` event where a card appeared; the ENTITY, with its votes, comments and decision, lives here.
//
// On disk: one `cards.json` per session, in the session's private directory next to its transcript
// (AgentSessions.storageDir), 0600, written whole and atomically by one serialized writer per session (changes of one
// tick, and changes made while a write runs, coalesce into the next write). It goes with the transcript when a topic
// is deleted (AgentSessions.forget). A small state document, `cards`, lists the sessions that have such a file, so the
// module can load them when it starts: every read of ConversationService is synchronous, and a late joiner reads the
// cards of ended sessions and archived topics too.
//
// A session keeps every open card and its newest settled ones (count and size bounded, oldest settled first): the
// file is rewritten on every vote, so its size is what a vote costs.
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { opaqueIdSchema, permissionRequestSchema, questionSchema, type PermissionRequest, type Question } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { PersistentDocument } from '../core/interfaces.ts';
import { declareDocument, readPrivateJson, writePrivateFileAtomic } from '../core/state-store.ts';
import { isStubService } from '../core/stubs.ts';

export const CARDS_FILE = 'cards.json';
export const CARDS_INDEX_DOCUMENT = 'cards';
export const CARDS_VERSION = 1;
/** Sessions the index names at most (the oldest go first; their cards are then not loaded after a restart). */
const INDEX_SESSIONS_MAX = 20_000;
/** A hard bound of one file, far above what the limits below keep. */
const FILE_CARDS_MAX = 10_000;

const storedCardSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('question'), question: questionSchema }),
  z.strictObject({ kind: z.literal('permission'), request: permissionRequestSchema }),
]);
/** A card as it is kept: a question, or a permission request in the HOST's copy (with `path`). */
export type Card = z.infer<typeof storedCardSchema>;

export const cardsFileSchema = z.strictObject({
  version: z.literal(CARDS_VERSION),
  sessionId: opaqueIdSchema,
  cards: z.array(storedCardSchema).max(FILE_CARDS_MAX),
});

const cardsIndexSchema = z.strictObject({
  version: z.literal(CARDS_VERSION),
  sessions: z.array(opaqueIdSchema).max(INDEX_SESSIONS_MAX),
});
type CardsIndex = z.infer<typeof cardsIndexSchema>;
/** cards.json of the workspace folder (the index; new in 0.5.0). Declared by the conversation module. */
export const cardsIndexDocument = declareDocument({ name: CARDS_INDEX_DOCUMENT, schema: cardsIndexSchema, init: (): CardsIndex => ({ version: CARDS_VERSION, sessions: [] }), canSetAside: true });

export interface CardsLimits {
  /** Settled cards kept per session (open ones are always kept). */
  readonly maxSettledPerSession: number;
  /** Characters of one session's cards.json; beyond it the oldest settled cards go. */
  readonly maxSessionChars: number;
}

export const DEFAULT_CARDS_LIMITS: CardsLimits = Object.freeze({ maxSettledPerSession: 500, maxSessionChars: 16 * 1024 * 1024 });

interface SessionCards {
  readonly sessionId: string;
  cards: Card[];
  /** The session's private directory (resolved at the first write); `false`: the runtime gave none, memory only. */
  dir: string | false | null;
  dirty: boolean;
  failed: boolean;
  /** The session was forgotten: nothing is written any more. */
  gone: boolean;
  writing: Promise<void> | null;
}

export function cardId(card: Card): string {
  return card.kind === 'question' ? card.question.id : card.request.id;
}

export function cardIsOpen(card: Card): boolean {
  return card.kind === 'question' ? card.question.status === 'open' : card.request.status === 'open';
}

export class CardsStore {
  private readonly ctx: DaemonContext;
  private readonly limits: CardsLimits;
  private readonly sessions = new Map<string, SessionCards>();
  /** card id → its session. A card id is unique in the workspace (the runner's request id). */
  private readonly owners = new Map<string, string>();
  private readonly open = new Set<string>();
  private index: PersistentDocument<CardsIndex> | null = null;

  constructor(ctx: DaemonContext, limits: Partial<CardsLimits> = {}) {
    this.ctx = ctx;
    this.limits = Object.freeze({ ...DEFAULT_CARDS_LIMITS, ...limits });
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------

  /** Opens the index and loads the cards of every session it names that still exists. */
  async start(): Promise<void> {
    this.index = await this.ctx.state.document(cardsIndexDocument.name, cardsIndexDocument.schema, cardsIndexDocument.init);
    if (isStubService(this.ctx.services.agents)) return;
    const stale: string[] = [];
    for (const sessionId of this.index.get().sessions) {
      if (this.sessions.has(sessionId)) continue;
      if (!(await this.load(sessionId))) stale.push(sessionId);
    }
    if (stale.length > 0) {
      const gone = new Set(stale);
      this.index.update((draft) => {
        draft.sessions = draft.sessions.filter((id) => !gone.has(id));
      });
    }
  }

  /** Everything changed so far is on disk (or logged as not written). Never throws. */
  async flush(): Promise<void> {
    for (const session of this.sessions.values()) if (session.failed && !session.gone) this.schedule(session);
    await Promise.all([...this.sessions.values()].map((session) => session.writing ?? Promise.resolve()));
    await this.index?.flush().catch((err: unknown) => {
      this.ctx.log.error('cards index write failed', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
    });
  }

  // ---- reads (the stored objects: callers never change them, they `put` a new one) ---------------------------------

  get(id: string): Card | null {
    const sessionId = this.owners.get(id);
    if (sessionId === undefined) return null;
    return this.sessions.get(sessionId)?.cards.find((card) => cardId(card) === id) ?? null;
  }

  question(id: string): Question | null {
    const card = this.get(id);
    return card?.kind === 'question' ? card.question : null;
  }

  permission(id: string): PermissionRequest | null {
    const card = this.get(id);
    return card?.kind === 'permission' ? card.request : null;
  }

  /** The cards of one session, in the order they appeared. */
  ofSession(sessionId: string): readonly Card[] {
    return this.sessions.get(sessionId)?.cards ?? [];
  }

  /** Every open card, oldest first. */
  openCards(): Card[] {
    const out: Card[] = [];
    for (const id of this.open) {
      const card = this.get(id);
      if (card !== null) out.push(card);
    }
    return out.sort((a, b) => askedAt(a) - askedAt(b));
  }

  openQuestions(): Question[] {
    return this.openCards().flatMap((card) => (card.kind === 'question' ? [card.question] : []));
  }

  openPermissions(): PermissionRequest[] {
    return this.openCards().flatMap((card) => (card.kind === 'permission' ? [card.request] : []));
  }

  // ---- writes ------------------------------------------------------------------------------------------------------

  /** Adds a card, or replaces the one with its id. */
  put(card: Card): void {
    const id = cardId(card);
    const sessionId = card.kind === 'question' ? card.question.sessionId : card.request.sessionId;
    let session = this.sessions.get(sessionId);
    if (session === undefined) {
      session = { sessionId, cards: [], dir: null, dirty: false, failed: false, gone: false, writing: null };
      this.sessions.set(sessionId, session);
      this.remember(sessionId);
    }
    const at = session.cards.findIndex((existing) => cardId(existing) === id);
    if (at === -1) session.cards.push(card);
    else session.cards[at] = card;
    this.owners.set(id, sessionId);
    if (cardIsOpen(card)) this.open.add(id);
    else this.open.delete(id);
    if (at === -1) this.pruneCount(session);
    this.schedule(session);
  }

  /** The sessions are gone for good (their topic was deleted): their cards go from memory; the files go with the transcripts. */
  dropSessions(sessionIds: readonly string[]): void {
    const gone = new Set(sessionIds);
    for (const sessionId of gone) {
      const session = this.sessions.get(sessionId);
      if (session === undefined) continue;
      session.gone = true;
      for (const card of session.cards) {
        this.owners.delete(cardId(card));
        this.open.delete(cardId(card));
      }
      this.sessions.delete(sessionId);
    }
    this.index?.update((draft) => {
      draft.sessions = draft.sessions.filter((id) => !gone.has(id));
    });
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  private remember(sessionId: string): void {
    this.index?.update((draft) => {
      if (draft.sessions.includes(sessionId)) return;
      draft.sessions.push(sessionId);
      if (draft.sessions.length > INDEX_SESSIONS_MAX) draft.sessions.splice(0, draft.sessions.length - INDEX_SESSIONS_MAX);
    });
  }

  private pruneCount(session: SessionCards): void {
    let settled = session.cards.reduce((count, card) => count + (cardIsOpen(card) ? 0 : 1), 0);
    if (settled <= this.limits.maxSettledPerSession) return;
    session.cards = session.cards.filter((card) => {
      if (settled <= this.limits.maxSettledPerSession || cardIsOpen(card)) return true;
      settled -= 1;
      this.owners.delete(cardId(card));
      return false;
    });
  }

  /** The file's text; when it is too large the oldest settled cards go first (open ones never). */
  private serialize(session: SessionCards): string {
    let text = JSON.stringify({ version: CARDS_VERSION, sessionId: session.sessionId, cards: session.cards });
    while (text.length > this.limits.maxSessionChars) {
      const at = session.cards.findIndex((card) => !cardIsOpen(card));
      if (at === -1) break;
      this.owners.delete(cardId(session.cards[at] as Card));
      session.cards.splice(at, 1);
      text = JSON.stringify({ version: CARDS_VERSION, sessionId: session.sessionId, cards: session.cards });
    }
    return text;
  }

  private schedule(session: SessionCards): void {
    session.dirty = true;
    if (session.writing !== null) return;
    session.writing = this.writeLoop(session).finally(() => {
      session.writing = null;
    });
  }

  private async writeLoop(session: SessionCards): Promise<void> {
    // The changes of this tick become one write.
    await Promise.resolve();
    while (session.dirty && !session.gone) {
      session.dirty = false;
      try {
        await this.write(session);
        session.failed = false;
      } catch (err) {
        if (session.gone) return;
        // The cards stay in memory and in force; the next change (or flush) writes the whole file again.
        session.failed = true;
        this.ctx.log.error('cards.json write failed', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
        return;
      }
    }
  }

  private async write(session: SessionCards): Promise<void> {
    if (session.dir === false) return;
    if (session.dir === null) {
      try {
        session.dir = await this.ctx.services.agents.storageDir(session.sessionId);
      } catch (err) {
        // The runtime has no directory for this session (it is gone, or a test runs without disk): memory only.
        session.dir = false;
        this.ctx.log.warn('no storage directory for a session; its cards are kept in memory only', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
        return;
      }
    }
    if (session.gone) return;
    await mkdir(session.dir, { recursive: true, mode: 0o700 });
    const text = this.serialize(session);
    if (session.gone) return;
    await writePrivateFileAtomic(join(session.dir, CARDS_FILE), session.dir, text);
  }

  /** Loads one session's cards.json. False: the session or the file is gone (the index forgets it). */
  private async load(sessionId: string): Promise<boolean> {
    const agents = this.ctx.services.agents;
    if (agents.get(sessionId) === null) return false;
    let dir: string;
    try {
      dir = await agents.storageDir(sessionId);
    } catch {
      return false;
    }
    const path = join(dir, CARDS_FILE);
    let raw: unknown;
    try {
      raw = await readPrivateJson(path);
    } catch (err) {
      this.ctx.log.error('cards.json could not be read; this session starts without its earlier cards', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
      await rename(path, `${path}.unreadable`).catch(() => {});
      return true;
    }
    if (raw === null) return false;
    const parsed = cardsFileSchema.safeParse(raw);
    if (!parsed.success || parsed.data.sessionId !== sessionId) {
      // Never guessed at and never silently rewritten: the file is kept aside for the host.
      this.ctx.log.error('cards.json is not valid; kept aside, this session starts without its earlier cards', { module: 'conversation' });
      await rename(path, `${path}.invalid`).catch(() => {});
      return true;
    }
    const session: SessionCards = { sessionId, cards: parsed.data.cards, dir, dirty: false, failed: false, gone: false, writing: null };
    this.sessions.set(sessionId, session);
    for (const card of session.cards) {
      this.owners.set(cardId(card), sessionId);
      if (cardIsOpen(card)) this.open.add(cardId(card));
    }
    return true;
  }
}

function askedAt(card: Card): number {
  return card.kind === 'question' ? card.question.askedAt : card.request.askedAt;
}
