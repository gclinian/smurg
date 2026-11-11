// The sticky module's service (DESIGN 0.8.0 D2, D3.5): the index of the notes and what members do with it, and the one
// Claude for the sticky notes of the workspace. No other module calls it (no service slot): its handlers and its bus
// listeners are its only callers.
//
//   sticky.list             one list-rule page of the index (`sources` stays empty until the outside sources come)
//   sticky.changed          what changed in the index, to every member who may read files
//   sticky.create           a new, empty note, written as the caller through the file service (its audit entry and
//                           activity name the person); `notes/` is made when it is missing
//   sticky.assistant.start  the running notes session, or one started now for the caller
//
// Writes of one workspace run one at a time (`serial`): two creates of `Home` and `home`, or two presses of "Start
// Claude", never interleave their checks and their writes.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAIN_ROOT,
  NOTES_DIR,
  SmurgError,
  foldNoteName,
  isSessionOver,
  noteNameOf,
  noteNameProblem,
  notePath,
  rootRefKey,
  takeListPage,
  type AgentSession,
  type NoteInfo,
  type PayloadOf,
  type ResultInputOf,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { PersistentDocument, Principal } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import { isStubService } from '../core/stubs.ts';
import { INDEX_READER, NoteIndex, type IndexChange } from './index.ts';
import { notesRolePrompt } from './prompts.ts';
import { STICKY_DOCUMENT, initialStickyDocument, stickyDocumentSchema, type StickyDocument } from './store.ts';

export interface StickyModuleOptions {
  /** The quiet period after a change in `notes/` before the index reads again (default 500 ms, as the topics' files). */
  readonly fileDebounceMs?: number;
}

export const DEFAULT_STICKY_DEBOUNCE_MS = 500;

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
  private readonly serial = new Serial();
  private doc: PersistentDocument<StickyDocument> | null = null;

  constructor(ctx: DaemonContext, options: StickyModuleOptions = {}) {
    this.ctx = ctx;
    this.index = new NoteIndex(ctx, { debounceMs: options.fileDebounceMs ?? DEFAULT_STICKY_DEBOUNCE_MS }, (change) => this.announce(change));
  }

  /** The bus listeners: changes on disk of the main workspace, saves of the editor, a watcher that may have missed some. */
  attach(): Disposable {
    const stack = new DisposableStack();
    const main = rootRefKey(MAIN_ROOT);
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
    const page = takeListPage(this.index.list(), payload.after, (note) => note.name);
    return { notes: page.items, hasMore: page.hasMore, truncated: this.index.truncated(), sources: [] };
  }

  /**
   * `sticky.create` (D2.5): as the caller and one at a time, makes `notes` when it is missing (a `notes` there must be
   * a real folder of that name), refuses a name that folds equal to a note's in a fresh listing, and creates the empty
   * file through the file service, which refuses it when it exists. The index reads it at once.
   */
  async create(payload: PayloadOf<'sticky.create'>, principal: Principal): Promise<{ readonly note: NoteInfo }> {
    const problem = noteNameProblem(payload.name);
    if (problem !== null) throw new SmurgError('bad_request', msg('sticky.name.invalid'), { reason: 'invalid-name', problem });
    const name = payload.name;
    return this.serial.run(async () => {
      const files = this.ctx.services.files;
      let folder = await this.folder();
      if (folder === 'missing') {
        try {
          await files.create({ file: { root: MAIN_ROOT, path: NOTES_DIR }, kind: 'dir' }, principal);
        } catch (err) {
          // Someone made it meanwhile: it is looked at below like any folder that was there.
          if (!(err instanceof SmurgError && err.code === 'conflict' && err.detail?.['reason'] === 'exists')) throw err;
        }
        folder = await this.folder();
      }
      // A file, a symlink or `Notes` on a disk that ignores case: no sticky note is written through it.
      if (folder !== 'real') throw new SmurgError('conflict', msg('file.notADirectory'), { reason: 'not-a-directory' });
      const twin = await this.noteFolding(name);
      if (twin !== null) throw existsError(twin);
      try {
        await files.create({ file: { root: MAIN_ROOT, path: notePath(name) }, kind: 'file' }, principal);
      } catch (err) {
        if (err instanceof SmurgError && err.code === 'conflict' && err.detail?.['reason'] === 'exists') throw existsError(name);
        throw err;
      }
      await this.index.refreshNow();
      return { note: this.index.find(name) ?? { name, links: [] } };
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

  private announce(change: IndexChange): void {
    this.ctx.hub.broadcast('sticky.changed', { upserted: [...change.upserted], removed: [...change.removed], truncated: change.truncated });
  }

  /**
   * `real`: `notes` is a real folder of that very name at the top of the main workspace (as the index reads it);
   * `missing`: nothing is there; `other`: something else is (a file, a symlink, `Notes` on a disk that ignores case).
   */
  private async folder(): Promise<'real' | 'missing' | 'other'> {
    try {
      const resolved = await this.ctx.paths.resolve({ root: MAIN_ROOT, path: NOTES_DIR }, { principal: INDEX_READER, finalSymlink: 'self', audit: false });
      if (!resolved.exists) return 'missing';
      return resolved.identity?.kind === 'dir' && resolved.name === NOTES_DIR ? 'real' : 'other';
    } catch {
      return 'other';
    }
  }

  /** The note whose name folds equal to `name` in a fresh listing of `notes/`, by its name on disk, or null. */
  private async noteFolding(name: string): Promise<string | null> {
    const key = foldNoteName(name);
    const entries = await readdir(join(this.ctx.roots.main.realPath, NOTES_DIR)).catch(() => [] as string[]);
    for (const entry of entries) {
      const existing = noteNameOf(`${NOTES_DIR}/${entry}`);
      if (existing !== null && foldNoteName(existing) === key) return existing;
    }
    return null;
  }
}

function existsError(name: string): SmurgError {
  return new SmurgError('conflict', msg('sticky.create.exists', { name }), { reason: 'exists' });
}
