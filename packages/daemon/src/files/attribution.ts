// Best-effort attribution of file changes (ARCHITECTURE §7.3 `file.changed` "with best-effort attribution").
//
// The watcher sees WHAT changed, never WHO. Whoever is about to change a file through the daemon (FileService
// mutations, upload commits, doc autosaves, a granted agent lock) announces it with expect(); a watcher event for that
// path inside the window is attributed to that actor. Expectations are not consumed by the first event: one write
// can reach FSEvents / inotify as several callbacks, and an unattributed echo of our own write would be logged as an
// "external change". The price is that a genuinely external change inside the window is attributed to the announcer.
//
// When several announcements cover a path (an agent's edit of a file, then a member's rename of the folder that
// holds it), the NEWEST one is the writer: the watcher reports late, and its report of the folder's new content must
// not be taken for the agent's earlier write, whose window is still open.
//
// The same class remembers who last modified each file (FileEntry.lastModifiedBy, the tree badge). Both maps are
// bounded: this is bookkeeping, never an authority.
import type { Actor, RootRef } from '@smurg/protocol';
import type { Clock } from '../core/lifecycle.ts';
import { looseKey } from './util.ts';

interface Expectation {
  readonly by: Actor;
  readonly until: number;
  /** Also covers everything below the path (directory rename / delete / upload plan). */
  readonly subtree: boolean;
  /** The order of the announcements: a higher number was announced later. */
  readonly order: number;
}

export interface AttributionOptions {
  readonly clock: Clock;
  readonly maxExpectations?: number;
  readonly maxModified?: number;
}

export class ChangeAttribution {
  private readonly clock: Clock;
  private readonly maxExpectations: number;
  private readonly maxModified: number;
  private readonly expectations = new Map<string, Expectation>();
  private announced = 0;
  /** Insertion order = recency (re-inserted on every update): the oldest entry is evicted first. */
  private readonly modified = new Map<string, Actor>();

  constructor(options: AttributionOptions) {
    this.clock = options.clock;
    this.maxExpectations = options.maxExpectations ?? 20_000;
    this.maxModified = options.maxModified ?? 50_000;
  }

  expect(root: RootRef, path: string, by: Actor, ttlMs: number, subtree = false): void {
    const key = looseKey(root, path);
    const now = this.clock.now();
    const until = now + Math.max(0, ttlMs);
    const existing = this.expectations.get(key);
    const order = ++this.announced;
    this.expectations.delete(key);
    // A shorter expectation of the same actor must not cut a longer one short (agent lock TTL vs. 5 s default): the
    // longer window stays, announced again now.
    const same = existing !== undefined && sameActor(existing.by, by);
    this.expectations.set(key, { by, until: same && existing.until > until ? existing.until : until, subtree: subtree || (same && existing.subtree), order });
    if (this.expectations.size > this.maxExpectations) this.prune(now);
  }

  /**
   * The actor that announced a change of `path` (or of an ancestor, for subtree announcements), if still valid: of
   * all the announcements that cover the path, the one made last.
   */
  attribute(root: RootRef, path: string): Actor | undefined {
    const now = this.clock.now();
    const key = looseKey(root, path);
    let newest: Expectation | undefined;
    const consider = (candidate: Expectation | undefined, needsSubtree: boolean): void => {
      if (candidate === undefined || candidate.until < now || (needsSubtree && !candidate.subtree)) return;
      if (newest === undefined || candidate.order > newest.order) newest = candidate;
    };
    consider(this.expectations.get(key), false);
    let cut = key.lastIndexOf('/');
    const colon = key.indexOf(':', key.startsWith('wt:') ? 3 : 0);
    while (cut > colon) {
      consider(this.expectations.get(key.slice(0, cut)), true);
      cut = key.lastIndexOf('/', cut - 1);
    }
    consider(this.expectations.get(key.slice(0, colon + 1)), true);
    return newest?.by;
  }

  recordModified(root: RootRef, path: string, by: Actor): void {
    const key = looseKey(root, path);
    this.modified.delete(key);
    this.modified.set(key, by);
    if (this.modified.size > this.maxModified) {
      const oldest = this.modified.keys().next();
      if (!oldest.done) this.modified.delete(oldest.value);
    }
  }

  lastModifiedBy(root: RootRef, path: string): Actor | null {
    return this.modified.get(looseKey(root, path)) ?? null;
  }

  /** The path (and, for directories, everything below it) is gone. */
  forget(root: RootRef, path: string, subtree: boolean): void {
    const key = looseKey(root, path);
    this.modified.delete(key);
    if (!subtree) return;
    const prefix = `${key}/`;
    for (const candidate of [...this.modified.keys()]) if (candidate.startsWith(prefix)) this.modified.delete(candidate);
  }

  private prune(now: number): void {
    for (const [key, value] of this.expectations) if (value.until < now) this.expectations.delete(key);
    // Still too many live ones (a flood of announcements): drop the oldest.
    while (this.expectations.size > this.maxExpectations) {
      const oldest = this.expectations.keys().next();
      if (oldest.done) break;
      this.expectations.delete(oldest.value);
    }
  }
}

export function sameActor(a: Actor, b: Actor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'user' && b.kind === 'user') return a.userId === b.userId;
  if (a.kind === 'agent' && b.kind === 'agent') return a.sessionId === b.sessionId;
  return true;
}
