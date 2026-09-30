// Best-effort attribution of file changes (ARCHITECTURE §7.3 `file.changed` "with best-effort attribution").
//
// The watcher sees WHAT changed, never WHO. Whoever is about to change a file through the daemon (FileService
// mutations, upload commits, doc autosaves, a granted agent lock) announces it with expect(); a watcher event for that
// path inside the window is attributed to that actor. Expectations are not consumed by the first event: one write
// can reach FSEvents / inotify as several callbacks, and an unattributed echo of our own write would be logged as an
// "external change". The price is that a genuinely external change inside the window is attributed to the announcer.
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
    // A shorter expectation of the same actor must not cut a longer one short (agent lock TTL vs. 5 s default).
    if (existing && existing.until > until && sameActor(existing.by, by)) return;
    this.expectations.delete(key);
    this.expectations.set(key, { by, until, subtree: subtree || (existing?.subtree === true && sameActor(existing.by, by)) });
    if (this.expectations.size > this.maxExpectations) this.prune(now);
  }

  /** The actor that announced a change of `path` (or of an ancestor, for subtree announcements), if still valid. */
  attribute(root: RootRef, path: string): Actor | undefined {
    const now = this.clock.now();
    const key = looseKey(root, path);
    const exact = this.expectations.get(key);
    if (exact && exact.until >= now) return exact.by;
    // Ancestors, nearest first.
    let cut = key.lastIndexOf('/');
    const colon = key.indexOf(':', key.startsWith('wt:') ? 3 : 0);
    while (cut > colon) {
      const ancestor = this.expectations.get(key.slice(0, cut));
      if (ancestor && ancestor.subtree && ancestor.until >= now) return ancestor.by;
      cut = key.lastIndexOf('/', cut - 1);
    }
    const rootLevel = this.expectations.get(key.slice(0, colon + 1));
    if (rootLevel && rootLevel.subtree && rootLevel.until >= now) return rootLevel.by;
    return undefined;
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
