// The sticky module's service (DESIGN 0.8.0 D2, D3.5, D4, D5): the index of the notes and what members do with it,
// the one Claude for the sticky notes of the workspace, the feedback on the notes (feedback.ts; its one send to an
// agent is accept.ts) and "Build this" (build.ts). No other module calls it (no service slot): its handlers and its
// bus listeners are its only callers.
//
//   sticky.list             one list-rule page of the index (`sources` stays empty until the outside sources come)
//   sticky.changed          what changed in the index, to every member who may read files
//   sticky.create           a new, empty note, written as the caller through the file service (its audit entry and
//                           activity name the person); `notes/` is made when it is missing
//   sticky.assistant.start  the running notes session, or one started now for the caller
//   sticky.feedback.*       feedback.ts (create, withdraw, reject, list) and accept.ts (accept)
//   sticky.spec, .build     build.ts: the text a topic's spec would be made of, and the topic made from it
//
// Every NoteInfo members are told holds the note's `builds` (the topics made from it that are there, the newest 8,
// D2.4): the index knows nothing of them; this service adds them to what the index lists and announces, and announces
// a note again when it was built and when a topic made from it is deleted.
//
// Writes of one workspace run one at a time (`serial`): two creates of `Home` and `home`, two presses of "Start
// Claude", or two builds of one note, never interleave their checks and their writes. What waited its turn checks again what may have changed
// meanwhile (the folder, the notes, the caller's membership and role).
import { readdir } from 'node:fs/promises';
import {
  MAIN_ROOT,
  NOTES_DIR,
  NOTES_MAX,
  SmurgError,
  can,
  foldNoteName,
  isSessionOver,
  noteNameOf,
  noteNameProblem,
  notePath,
  rootRefKey,
  takeListPage,
  type AgentSession,
  type NoteInfo,
  type NoteNameProblem,
  type PayloadOf,
  type ResultInputOf,
} from '@smurg/protocol';
import { msg, type NoteNameRule } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { PersistentDocument, Principal } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import { isStubService } from '../core/stubs.ts';
import { FeedbackAccept } from './accept.ts';
import { NoteBuilder } from './build.ts';
import { FeedbackService, type FeedbackLimits } from './feedback.ts';
import { NoteIndex, lookAtNotesFolder, type IndexChange } from './index.ts';
import { notesRolePrompt } from './prompts.ts';
import { STICKY_DOCUMENT, initialStickyDocument, stickyDocumentSchema, type StickyDocument } from './store.ts';

export interface StickyModuleOptions {
  /** The quiet period after a change in `notes/` before the index reads again (default 500 ms, as the topics' files). */
  readonly fileDebounceMs?: number;
  /** The bounds of the feedback (D4.5; default the protocol's: 20 waiting per member, 300 from members, 1000, 2 Mi). */
  readonly feedbackLimits?: Partial<FeedbackLimits>;
}

export const DEFAULT_STICKY_DEBOUNCE_MS = 500;

/** The rule a person is told for each reason a name is refused (`sticky.name.invalid`, D1.2). */
const NAME_RULES: Readonly<Record<NoteNameProblem, NoteNameRule>> = {
  'not-string': 'unseen',
  empty: 'length',
  'too-long': 'length',
  markup: 'markup',
  'white-space': 'space',
  unseen: 'unseen',
  'not-nfc': 'unseen',
  'dot-name': 'edge',
  edge: 'edge',
  // A run of more than MARK_RUN_MAX combining marks is the only name left that checkRelPath refuses.
  path: 'unseen',
  'host-only': 'reserved',
  // Every name the rules above let through is a topic name too; kept for the day one is not.
  'topic-name': 'unseen',
};

/** Runs async work one at a time, in arrival order. */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class StickyServiceImpl {
  private readonly ctx: DaemonContext;
  readonly index: NoteIndex;
  /** The feedback on the notes (D4): kept, shown, rejected, withdrawn; it reaches no agent there. */
  readonly feedback: FeedbackService;
  /** Accepting feedback: the one send of feedback to an agent (D4.6). */
  readonly acceptor: FeedbackAccept;
  /** "Build this" (D5): the spec of a note, and the topic made from it. */
  readonly builder: NoteBuilder;
  private readonly serial = new Serial();
  private doc: PersistentDocument<StickyDocument> | null = null;

  constructor(ctx: DaemonContext, options: StickyModuleOptions = {}) {
    this.ctx = ctx;
    this.index = new NoteIndex(ctx, { debounceMs: options.fileDebounceMs ?? DEFAULT_STICKY_DEBOUNCE_MS }, (change) => this.announce(change));
    this.feedback = new FeedbackService(ctx, { index: this.index, document: () => this.requireDoc(), ...(options.feedbackLimits === undefined ? {} : { limits: options.feedbackLimits }) });
    this.acceptor = new FeedbackAccept(ctx, { feedback: this.feedback, assistant: () => this.assistant() });
    this.builder = new NoteBuilder(ctx, {
      index: this.index,
      document: () => this.requireDoc(),
      serial: (work) => this.serial.run(work),
      buildsChanged: (name) => this.announceBuilt(name),
    });
  }

  /**
   * The bus listeners: changes on disk of the main workspace, saves of the editor, a watcher that may have missed some;
   * a topic deleted (the note it was made from is told again without it).
   */
  attach(): Disposable {
    const stack = new DisposableStack();
    const main = rootRefKey(MAIN_ROOT);
    stack.add(this.ctx.bus.on('topic.removed', (event) => this.announceTopicGone(event.topicId)));
    stack.add(
      this.ctx.bus.on('file.changed', (event) => {
        if (rootRefKey(event.root) === main) this.index.onChanged(event.changes.map((change) => change.path));
      }),
    );
    stack.add(
      this.ctx.bus.on('doc.saved', (event) => {
        if (rootRefKey(event.file.root) === main) this.index.onChanged([event.file.path]);
      }),
    );
    stack.add(
      this.ctx.bus.on('file.watch-error', (event) => {
        if (rootRefKey(event.root) === main) this.index.onWatcherError();
      }),
    );
    stack.add(this.feedback.attach());
    return stack;
  }

  /** The module's start: `sticky.json` is opened (written from its first version when missing), the notes are listed. */
  async start(): Promise<void> {
    this.doc = await this.ctx.state.document(STICKY_DOCUMENT, stickyDocumentSchema, initialStickyDocument);
    await this.index.load();
  }

  async stop(): Promise<void> {
    await this.index.stop();
    await this.serial.run(async () => {});
    await this.doc?.flush().catch((err: unknown) => {
      this.ctx.log.error('sticky.json not written', { module: 'sticky', error: err instanceof Error ? err.name : 'unknown' });
    });
  }

  /** `sticky.list`: one page of the index by the list rule, in its order. */
  list(payload: PayloadOf<'sticky.list'>): ResultInputOf<'sticky.list'> {
    const page = takeListPage(this.index.list().map((note) => this.withBuilds(note)), payload.after, (note) => note.name);
    return { notes: page.items, hasMore: page.hasMore, truncated: this.index.truncated(), sources: [] };
  }

  /**
   * `sticky.create` (D2.5): as the caller and one at a time, makes `notes` when it is missing (a `notes` there must be
   * a real folder of that name), refuses a name that folds equal to a note's in a fresh listing and a note more than
   * the index lists (NOTES_MAX), and creates the empty file through the file service, which refuses it when it exists.
   * The index reads it at once, and the reply is what the index holds: never a note the index does not list.
   */
  async create(payload: PayloadOf<'sticky.create'>, principal: Principal): Promise<{ readonly note: NoteInfo }> {
    const problem = noteNameProblem(payload.name);
    if (problem !== null) throw new SmurgError('bad_request', msg('sticky.name.invalid', { rule: NAME_RULES[problem] }), { reason: 'invalid-name', problem });
    const name = payload.name;
    return this.serial.run(async () => {
      const files = this.ctx.services.files;
      // A look that failed (an I/O error, the folder replaced meanwhile) throws here: nothing is written on a guess.
      let folder = await lookAtNotesFolder(this.ctx);
      if (folder.kind === 'missing') {
        try {
          await files.create({ file: { root: MAIN_ROOT, path: NOTES_DIR }, kind: 'dir' }, principal);
        } catch (err) {
          // Someone made it meanwhile: it is looked at below like any folder that was there.
          if (!(err instanceof SmurgError && err.code === 'conflict' && err.detail?.['reason'] === 'exists')) throw err;
        }
        folder = await lookAtNotesFolder(this.ctx);
      }
      // A file, a symlink or `Notes` on a disk that ignores case: no sticky note is written through it.
      if (folder.kind !== 'real') throw new SmurgError('conflict', msg('file.notADirectory'), { reason: 'not-a-directory' });
      // The fresh listing: a listing that fails throws, so no create goes on without it.
      const names = await notesIn(folder.realPath);
      const key = foldNoteName(name);
      const twin = names.find((existing) => foldNoteName(existing) === key);
      if (twin !== undefined) throw existsError(twin);
      if (names.length >= NOTES_MAX) throw fullError();
      try {
        await files.create({ file: { root: MAIN_ROOT, path: notePath(name) }, kind: 'file' }, principal);
      } catch (err) {
        if (err instanceof SmurgError && err.code === 'conflict' && err.detail?.['reason'] === 'exists') throw existsError(name);
        throw err;
      }
      await this.index.refreshNow();
      // Files written meanwhile by others (Claude, git, an editor) can still push it past NOTES_MAX: the file is there,
      // the index does not list it, and so the reply holds no note.
      const note = this.index.find(name);
      if (note === null) throw fullError();
      return { note: this.withBuilds(note) };
    });
  }

  /**
   * `sticky.assistant.start` (D3.5): the one agent session of purpose `notes` that has not ended, or a new one, opened
   * by the caller, nobody responsible, in the main workspace, with the host's default model; audited `session.create`
   * with its purpose. The agent runtime refuses it at its own limits (`session.limit.agents`). No id is kept: the
   * session list says which session it is.
   */
  async startAssistant(principal: Principal): Promise<AgentSession> {
    return this.serial.run(async () => {
      const running = this.assistant();
      if (running !== null) return running;
      if (principal.kind !== 'user' || principal.userId === null || principal.actor.kind !== 'user') throw new AuthorizationError(undefined, { reason: 'not-a-member' });
      // The member's CURRENT role, as a free session's start asks it: this press may have waited its turn behind a
      // create or another start, and a member removed or demoted meanwhile was torn down with nothing of this to hand
      // over. (The router checked the role when the message arrived.)
      const member = this.ctx.members.active(principal.userId);
      if (member === null) throw new AuthorizationError(undefined, { reason: 'not-a-member' });
      if (!can(member.role, 'session.create')) throw new AuthorizationError(undefined, { reason: 'capability' });
      if (this.ctx.stopping.aborted) throw new SmurgError('conflict', msg('daemon.stopping'), { reason: 'stopping' });
      const ctx = this.ctx;
      const session = await ctx.services.agents.start({
        purpose: 'notes',
        openedBy: principal,
        responsible: null,
        workspace: { mode: 'main' },
        modeChoice: null,
        model: null,
        rolePrompt: ({ smurgTag }) => notesRolePrompt({ smurgTag }),
        opening: msg('conversation.started.notes', { name: principal.actor.displayName }),
      });
      const trust = isStubService(ctx.services.projectTrust) ? null : ctx.services.projectTrust;
      ctx.audit.record({
        actor: principal.actor,
        action: 'session.create',
        outcome: 'ok',
        target: session.id,
        detail: {
          sessionId: session.id,
          kind: 'agent',
          purpose: 'notes',
          root: rootRefKey(MAIN_ROOT),
          mode: session.permissionMode,
          model: null,
          projectSettings: { state: trust?.state(MAIN_ROOT) ?? 'none', files: trust?.hashes(MAIN_ROOT) ?? [] },
          hostRules: isStubService(ctx.services.hostRules) ? 0 : ctx.services.hostRules.applied().length,
        },
      });
      return session;
    });
  }

  /** Claude for the sticky notes: the agent session of purpose `notes` that has not ended, or null. */
  assistant(): AgentSession | null {
    return this.ctx.services.agents.list().find((session) => session.purpose === 'notes' && !isSessionOver(session)) ?? null;
  }

  /** sticky.json, once the module started (a request before that is refused, never answered from nothing). */
  private requireDoc(): PersistentDocument<StickyDocument> {
    if (this.doc === null) throw new SmurgError('internal', undefined, { reason: 'not-started' });
    return this.doc;
  }

  private announce(change: IndexChange): void {
    this.ctx.hub.broadcast('sticky.changed', { upserted: change.upserted.map((note) => this.withBuilds(note)), removed: [...change.removed], truncated: change.truncated });
  }

  /**
   * A note as members see it: what the index holds, with the topics made from it that are there (a shadowed one has
   * none). `gone`: a topic being deleted right now, no longer one of them.
   */
  private withBuilds(note: NoteInfo, gone?: string): NoteInfo {
    if (note.shadowed === true || this.doc === null) return note;
    const builds = this.builder.buildsOf(note.name, gone);
    return builds.length === 0 ? note : { ...note, builds };
  }

  /** A note was built (D5.2): every member is told its NoteInfo with the new topic. */
  private announceBuilt(name: string): void {
    const note = this.index.find(name);
    if (note === null) return;
    this.ctx.hub.broadcast('sticky.changed', { upserted: [this.withBuilds(note)], removed: [], truncated: this.index.truncated() });
  }

  /**
   * A topic is being deleted (the bus tells of it before the topics module lets it go): when it was made from a note,
   * every member is told that note's NoteInfo without it, so an older topic that is there takes its place in the
   * newest eight at once, not at the note's next change. The record stays (D5.2).
   */
  private announceTopicGone(topicId: string): void {
    if (this.doc === null) return;
    const name = this.builder.noteOf(topicId);
    const note = name === null ? null : this.index.find(name);
    if (note === null || note.shadowed === true) return;
    this.ctx.hub.broadcast('sticky.changed', { upserted: [this.withBuilds(note, topicId)], removed: [], truncated: this.index.truncated() });
  }

}

/** The names of the notes in a fresh listing of the real `notes/` (rejects when it cannot be listed). */
async function notesIn(folder: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(folder)) {
    const name = noteNameOf(`${NOTES_DIR}/${entry}`);
    if (name !== null) names.push(name);
  }
  return names;
}

function existsError(name: string): SmurgError {
  return new SmurgError('conflict', msg('sticky.create.exists', { name }), { reason: 'exists' });
}

function fullError(): SmurgError {
  return new SmurgError('conflict', msg('sticky.create.full', { max: NOTES_MAX }), { reason: 'full' });
}
