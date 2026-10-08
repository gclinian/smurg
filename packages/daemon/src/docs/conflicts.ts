// The conflict panel's records (ARCHITECTURE §5.3, §7.1 conflicts.json). A ConflictRecord holds the overlapping hunks
// (human text kept, agent text and base, each ≤ 64 KiB); the agent's FULL version can be a whole 5 MiB document, so
// it lives in its own 0600 file under the workspace's private `conflicts/` dir and is served by doc.conflict.get.
//
// Bounded: the newest MAX_CONFLICTS_KEPT records are kept (resolved ones are dropped first), and agent versions are
// cached in memory up to CACHE_MAX_BYTES (the rest is read from disk on demand).
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { conflictRecordSchema, type ConflictRecord } from '@smurg/protocol';
import { z } from 'zod';
import type { PersistentDocument, StateStore } from '../core/interfaces.ts';
import type { Logger } from '../core/logger.ts';
import { declareDocument } from '../core/state-store.ts';

export const MAX_CONFLICTS_KEPT = 200;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;

const conflictsDocumentSchema = z.strictObject({
  conflicts: z.array(conflictRecordSchema).max(MAX_CONFLICTS_KEPT),
});
type ConflictsDocument = z.infer<typeof conflictsDocumentSchema>;

/** conflicts.json (no `version` key; the same shape since 0.4.0). Declared by the docs module. */
export const conflictsDocument = declareDocument({ name: 'conflicts', schema: conflictsDocumentSchema, init: (): ConflictsDocument => ({ conflicts: [] }), canSetAside: true });

/** File name of an agent version: hex of the id (ids are case-sensitive, APFS is not). */
function versionFileName(id: string): string {
  return `${Buffer.from(id, 'utf8').toString('hex')}.bin`;
}

export class ConflictStore {
  private readonly log: Logger;
  private document: PersistentDocument<ConflictsDocument> | null = null;
  private dir: string | null = null;
  private readonly cache = new Map<string, Uint8Array>();
  private cacheBytes = 0;
  private readonly writes = new Set<Promise<void>>();

  constructor(log: Logger) {
    this.log = log;
  }

  async open(state: StateStore): Promise<void> {
    this.document = await state.document(conflictsDocument.name, conflictsDocument.schema, conflictsDocument.init);
    this.dir = await state.privateDir('conflicts');
  }

  get ready(): boolean {
    return this.document !== null && this.dir !== null;
  }

  list(): ConflictRecord[] {
    return this.document ? [...this.document.get().conflicts] : [];
  }

  get(id: string): ConflictRecord | null {
    return this.document?.get().conflicts.find((c) => c.id === id) ?? null;
  }

  /** Persists the record (pruning old ones) and writes the agent version (0600) in the background. */
  add(record: ConflictRecord, agentVersion: Uint8Array): ConflictRecord {
    const document = this.requireDocument();
    const removed: string[] = [];
    document.update((draft) => {
      draft.conflicts.push(record);
      while (draft.conflicts.length > MAX_CONFLICTS_KEPT) {
        const resolved = draft.conflicts.findIndex((c) => c.status !== 'open');
        const [dropped] = draft.conflicts.splice(resolved === -1 ? 0 : resolved, 1);
        if (dropped) removed.push(dropped.id);
      }
    });
    this.remember(record.id, agentVersion);
    this.track(this.writeVersion(record.id, agentVersion));
    for (const id of removed) {
      this.forget(id);
      this.track(unlink(join(this.dir as string, versionFileName(id))).catch(() => {}));
    }
    return record;
  }

  setStatus(id: string, status: ConflictRecord['status']): ConflictRecord | null {
    const document = this.requireDocument();
    let updated: ConflictRecord | null = null;
    document.update((draft) => {
      const record = draft.conflicts.find((c) => c.id === id);
      if (record) {
        record.status = status;
        updated = { ...record };
      }
    });
    return updated;
  }

  async version(id: string): Promise<Uint8Array | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    if (!this.dir || !this.get(id)) return null;
    try {
      const bytes = new Uint8Array(await readFile(join(this.dir, versionFileName(id))));
      this.remember(id, bytes);
      return bytes;
    } catch {
      return null;
    }
  }

  /** Waits for pending file writes and the record document. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.writes]);
    await this.document?.flush();
  }

  private requireDocument(): PersistentDocument<ConflictsDocument> {
    if (!this.document || !this.dir) throw new Error('conflict store not open');
    return this.document;
  }

  private async writeVersion(id: string, bytes: Uint8Array): Promise<void> {
    try {
      await writeFile(join(this.dir as string, versionFileName(id)), bytes, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      this.log.error('could not store a conflict version', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private track(promise: Promise<void>): void {
    this.writes.add(promise);
    void promise.finally(() => this.writes.delete(promise));
  }

  private remember(id: string, bytes: Uint8Array): void {
    this.forget(id);
    this.cache.set(id, bytes);
    this.cacheBytes += bytes.byteLength;
    // Evict the oldest entries (Map iteration order = insertion order).
    for (const [key, value] of this.cache) {
      if (this.cacheBytes <= CACHE_MAX_BYTES || key === id) break;
      this.cache.delete(key);
      this.cacheBytes -= value.byteLength;
    }
  }

  private forget(id: string): void {
    const bytes = this.cache.get(id);
    if (!bytes) return;
    this.cache.delete(id);
    this.cacheBytes -= bytes.byteLength;
  }
}
