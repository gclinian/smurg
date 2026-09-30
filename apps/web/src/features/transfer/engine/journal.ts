// The upload journal: what a reload needs to resume an upload (SPEC R7 「可續傳」). Kept in the Worker's own IndexedDB
// database (not the key database: its object stores are fixed by the protocol package).
//
// The daemon resumes a partial upload by uploadId OR by identity (user, root, path, size, lastModified, chunkSize),
// so the journal is small: the job, the chunk size, and per file its final target path (after a planned rename), its
// identity and whether it is committed. Resuming re-hashes locally what the daemon already holds (FileUpload.verify).
import { rootRefSchema, type RootRef } from '@smurg/protocol';
import type { UploadConflictPolicy } from './types.ts';

export interface JournalFile {
  /** Path relative to the job's target directory (how the person's selection names it). */
  readonly path: string;
  /** Final path in the root (after the plan's renames). */
  readonly target: string;
  readonly size: number;
  readonly lastModified: number;
  readonly uploadId?: string;
  readonly done: boolean;
}

export interface JournalRecord {
  readonly v: 1;
  readonly jobId: string;
  readonly workspaceId: string;
  readonly root: RootRef;
  readonly targetDir: string;
  readonly name: string;
  readonly chunkSize: number;
  readonly policy: UploadConflictPolicy;
  readonly createdAt: number;
  readonly dirs: readonly string[];
  readonly files: readonly JournalFile[];
  /** Top-level handles of a Chromium drop (structured-cloneable there); absent elsewhere. */
  readonly handles?: Readonly<Record<string, FileSystemHandle>>;
}

export interface UploadJournal {
  put(record: JournalRecord): Promise<void>;
  list(workspaceId: string): Promise<JournalRecord[]>;
  remove(jobId: string): Promise<void>;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Records read back are checked before use: an old format or a damaged record is ignored, never trusted. */
export function isJournalRecord(value: unknown): value is JournalRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<JournalRecord>;
  if (r.v !== 1 || !isString(r.jobId) || !isString(r.workspaceId) || !isString(r.targetDir) || !isString(r.name)) return false;
  if (!rootRefSchema.safeParse(r.root).success || !isCount(r.chunkSize) || !isCount(r.createdAt)) return false;
  if (r.policy !== 'fail' && r.policy !== 'overwrite' && r.policy !== 'rename') return false;
  if (!Array.isArray(r.dirs) || !r.dirs.every(isString) || !Array.isArray(r.files)) return false;
  return r.files.every(
    (f: Partial<JournalFile>) =>
      typeof f === 'object' && f !== null && isString(f.path) && isString(f.target) && isCount(f.size) && isCount(f.lastModified) && typeof f.done === 'boolean' && (f.uploadId === undefined || isString(f.uploadId)),
  );
}

export function createMemoryJournal(): UploadJournal & { readonly records: ReadonlyMap<string, JournalRecord> } {
  const records = new Map<string, JournalRecord>();
  return {
    records,
    put: (record) => {
      records.set(record.jobId, structuredClone(record));
      return Promise.resolve();
    },
    list: (workspaceId) => Promise.resolve([...records.values()].filter((r) => r.workspaceId === workspaceId).map((r) => structuredClone(r))),
    remove: (jobId) => {
      records.delete(jobId);
      return Promise.resolve();
    },
  };
}

export const TRANSFER_DB_NAME = 'smurg-transfers';
const STORE = 'uploads';

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** The journal on IndexedDB (Worker or page). Rejects when IndexedDB is unavailable (private windows). */
export async function openIndexedDbJournal(factory: IDBFactory = indexedDB): Promise<UploadJournal> {
  const open = factory.open(TRANSFER_DB_NAME, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'jobId' });
  };
  const db = await promised(open);
  const tx = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
  return {
    async put(record) {
      try {
        await promised(tx('readwrite').put(record));
      } catch (error) {
        // Handles are not cloneable in every engine (DataCloneError): keep the journal without them.
        if (record.handles === undefined) throw error;
        const { handles: _dropped, ...rest } = record;
        await promised(tx('readwrite').put(rest));
      }
    },
    async list(workspaceId) {
      const all = (await promised(tx('readonly').getAll())) as unknown[];
      return all.filter(isJournalRecord).filter((r) => r.workspaceId === workspaceId);
    },
    async remove(jobId) {
      await promised(tx('readwrite').delete(jobId));
    },
  };
}
