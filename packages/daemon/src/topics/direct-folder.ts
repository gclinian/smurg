// The one-agent hold of the shared folder (DESIGN 0.6.0 D15, "One agent holds the folder"). Without the git program,
// work items run directly in the shared folder, and at most ONE direct item's session runs a turn there at a time:
// the agents of one folder would see each other's half-done work, a shell change is attributed to an agent only while
// exactly one session has a command running, and an edit lock lasts one tool call.
//
//  - The scheduler starts a direct item only while the folder is free and no session waits for it (`isFree`). That
//    item holds the folder from its first turn until the end of the turn after which its report is registered (or it
//    stalls, stops, fails or ends: `firstRunOver` / `ended`).
//  - Every LATER turn of a direct item's session (a person's message, a report follow-up, Continue, the message of a
//    Retry) needs the folder: AgentSessions asks `mayRunTurn` before it writes the message to the process. While the
//    answer is no, the message waits in the session's queue and the session waits here, oldest first. The holder of a
//    later turn keeps the folder until that turn is over (`idle`).
//  - When the folder is free again, a waiting session takes it first (its queued messages are written: `released`);
//    only when nobody waits may a queued item start (`free`: the scheduler runs).
// Free agent sessions of people are not held (as before): the hold is the work items'.
import type { DirectFolderGate } from '../core/interfaces.ts';
import type { Logger } from '../core/logger.ts';

interface Holder {
  /** `<topic id>/<item id>`: the item holds the folder, whichever of its sessions runs (a retry makes a new one). */
  readonly key: string;
  sessionId: string | null;
  /** Its first run: held until its report is registered, not merely until a turn ends. */
  untilReport: boolean;
  /** A turn was granted and has not been said to be over. */
  busy: boolean;
}

export interface DirectFolderHooks {
  /** The folder went to this waiting session: write what waits in it (AgentSessions.releaseHeld). */
  released(sessionId: string): void;
  /** The folder is free and nobody waits: a queued direct item may start (the scheduler runs). */
  free(): void;
  readonly log: Logger;
}

export class DirectFolder implements DirectFolderGate {
  private holder: Holder | null = null;
  private readonly waiters: { readonly key: string; readonly sessionId: string }[] = [];
  private readonly hooks: DirectFolderHooks;

  constructor(hooks: DirectFolderHooks) {
    this.hooks = hooks;
  }

  static key(topicId: string, itemId: string): string {
    return `${topicId}/${itemId}`;
  }

  /** Nothing holds the folder and no session waits for it: a queued direct item may start now. */
  isFree(): boolean {
    return this.holder === null && this.waiters.length === 0;
  }

  /** Who holds the folder now (null: nobody), and who waits, oldest first (tests, the log). */
  state(): { readonly holder: string | null; readonly waiting: readonly string[] } {
    return { holder: this.holder?.key ?? null, waiting: this.waiters.map((waiter) => waiter.key) };
  }

  /** The scheduler starts a direct item (only while `isFree`): it holds the folder for its first run. */
  takeForStart(key: string): void {
    if (!this.isFree()) throw new Error('the shared folder is not free');
    this.holder = { key, sessionId: null, untilReport: true, busy: true };
  }

  mayRunTurn(session: { readonly sessionId: string; readonly topicId: string; readonly itemId: string }): boolean {
    const key = DirectFolder.key(session.topicId, session.itemId);
    const holder = this.holder;
    if (holder !== null && holder.key === key) {
      holder.sessionId = session.sessionId;
      holder.busy = true;
      return true;
    }
    if (holder === null && (this.waiters.length === 0 || this.waiters[0]?.key === key)) {
      if (this.waiters[0]?.key === key) this.waiters.shift();
      this.holder = { key, sessionId: session.sessionId, untilReport: false, busy: true };
      return true;
    }
    if (!this.waiters.some((waiter) => waiter.key === key)) this.waiters.push({ key, sessionId: session.sessionId });
    return false;
  }

  idle(sessionId: string): void {
    const holder = this.holder;
    if (holder === null || holder.sessionId !== sessionId) return;
    holder.busy = false;
    if (!holder.untilReport) this.release();
  }

  /** The item's first run is over (its report was registered, or it stalled): the folder goes once its turn is. */
  firstRunOver(key: string): void {
    const holder = this.holder;
    if (holder === null || holder.key !== key) return;
    holder.untilReport = false;
    if (!holder.busy) this.release();
  }

  /** The item stopped, failed, ended or was disarmed: it holds the folder no more and waits no more. */
  ended(key: string): void {
    const at = this.waiters.findIndex((waiter) => waiter.key === key);
    if (at !== -1) this.waiters.splice(at, 1);
    if (this.holder?.key === key) this.release();
  }

  private release(): void {
    this.holder = null;
    const next = this.waiters.shift();
    if (next === undefined) {
      this.hooks.free();
      return;
    }
    this.holder = { key: next.key, sessionId: next.sessionId, untilReport: false, busy: true };
    this.hooks.log.debug('the shared folder went to a waiting work item', { module: 'topics', item: next.key });
    try {
      this.hooks.released(next.sessionId);
    } catch (err) {
      this.hooks.log.warn('a waiting work item could not be given the shared folder', { module: 'topics', item: next.key, error: err instanceof Error ? err.name : 'unknown' });
      this.release();
    }
  }
}
