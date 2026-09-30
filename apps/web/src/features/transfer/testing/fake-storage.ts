// TEST ONLY. Simulated browser storage for the download writers: an OPFS directory with sync access handles that can
// run out of quota the way Chromium did in the research (F37: write() returned 2^32 − 8 and the file stopped growing,
// no exception), short writes, thrown QuotaExceededError, and a save-picker handle.
import type { OpfsDirectoryLike, OpfsEnv, OpfsFileHandleLike, SaveHandleLike, SyncAccessHandleLike, WritableLike } from '../engine/writers.ts';

export const BOGUS_WRITE_COUNT = 4_294_967_288;

interface StoredFile {
  data: Uint8Array;
  size: number;
  lastModified: number;
  open: boolean;
}

export interface FakeOpfsOptions {
  /** What navigator.storage.estimate() reports. */
  quota?: number;
  usage?: number;
  /** Total bytes the "disk" accepts; beyond that writes silently fail (bogus count, file stops growing). */
  capacity?: number;
  /** Every write stores this many bytes fewer and reports the true (short) count. */
  shortBy?: number;
  /** Throw a QuotaExceededError instead of the silent failure. */
  throwOnFull?: boolean;
  now?: () => number;
}

export class FakeOpfs implements OpfsEnv {
  readonly files = new Map<string, StoredFile>();
  readonly options: FakeOpfsOptions;
  writes = 0;

  constructor(options: FakeOpfsOptions = {}) {
    this.options = options;
  }

  private used(): number {
    let total = 0;
    for (const file of this.files.values()) total += file.size;
    return total;
  }

  estimate(): Promise<{ quota?: number; usage?: number }> {
    return Promise.resolve({ quota: this.options.quota ?? 10 * 1024 ** 3, usage: this.options.usage ?? this.used() });
  }

  directory(): Promise<OpfsDirectoryLike> {
    const fs = this;
    const now = this.options.now ?? Date.now;
    const dir: OpfsDirectoryLike = {
      getFileHandle(name, options) {
        let file = fs.files.get(name);
        if (!file) {
          if (!options?.create) return Promise.reject(new DOMException('not found', 'NotFoundError'));
          file = { data: new Uint8Array(0), size: 0, lastModified: now(), open: false };
          fs.files.set(name, file);
        }
        const stored = file;
        const handle: OpfsFileHandleLike = {
          createSyncAccessHandle() {
            if (stored.open) return Promise.reject(new DOMException('locked', 'NoModificationAllowedError'));
            stored.open = true;
            return Promise.resolve(fs.access(stored, now));
          },
          getFile() {
            const blob = new Blob([stored.data.slice(0, stored.size)]);
            return Promise.resolve(Object.assign(blob, { lastModified: stored.lastModified }));
          },
        };
        return Promise.resolve(handle);
      },
      removeEntry(name) {
        const file = fs.files.get(name);
        if (!file) return Promise.reject(new DOMException('not found', 'NotFoundError'));
        if (file.open) return Promise.reject(new DOMException('in use', 'NoModificationAllowedError'));
        fs.files.delete(name);
        return Promise.resolve();
      },
      async *entries() {
        for (const name of [...fs.files.keys()]) yield [name, { kind: 'file' }] as [string, { kind: string }];
      },
    };
    return Promise.resolve(dir);
  }

  private access(file: StoredFile, now: () => number): SyncAccessHandleLike {
    const fs = this;
    const grow = (size: number): void => {
      if (file.data.byteLength >= size) return;
      const next = new Uint8Array(Math.max(size, file.data.byteLength * 2));
      next.set(file.data);
      file.data = next;
    };
    return {
      write(buffer, { at }) {
        fs.writes++;
        const capacity = fs.options.capacity ?? Number.POSITIVE_INFINITY;
        const others = fs.used() - file.size;
        if (others + Math.max(file.size, at + buffer.byteLength) > capacity) {
          if (fs.options.throwOnFull) throw new DOMException('quota', 'QuotaExceededError');
          return BOGUS_WRITE_COUNT; // F37: no exception, a bogus count, the file does not grow
        }
        const stored = Math.max(0, buffer.byteLength - (fs.options.shortBy ?? 0));
        grow(at + stored);
        file.data.set(buffer.subarray(0, stored), at);
        file.size = Math.max(file.size, at + stored);
        file.lastModified = now();
        return stored;
      },
      truncate(size) {
        grow(size);
        if (size < file.size) file.data.fill(0, size);
        file.size = size;
      },
      flush() {},
      getSize: () => file.size,
      close() {
        file.open = false;
      },
    };
  }

  content(name: string): Uint8Array | null {
    const file = this.files.get(name);
    return file ? file.data.slice(0, file.size) : null;
  }
}

export class FakeSaveHandle implements SaveHandleLike {
  data = new Uint8Array(0);
  size = 0;
  aborted = 0;
  closed = 0;
  /** Throw QuotaExceededError once this many bytes are exceeded. */
  capacity = Number.POSITIVE_INFINITY;

  createWritable(): Promise<WritableLike> {
    const handle = this;
    let pending = new Uint8Array(0);
    let pendingSize = 0;
    const grow = (size: number): void => {
      if (pending.byteLength >= size) return;
      const next = new Uint8Array(Math.max(size, pending.byteLength * 2));
      next.set(pending);
      pending = next;
    };
    return Promise.resolve({
      write({ position, data }) {
        if (position + data.byteLength > handle.capacity) return Promise.reject(new DOMException('quota', 'QuotaExceededError'));
        grow(position + data.byteLength);
        pending.set(data, position);
        pendingSize = Math.max(pendingSize, position + data.byteLength);
        return Promise.resolve();
      },
      truncate(size) {
        grow(size);
        pendingSize = size;
        return Promise.resolve();
      },
      close() {
        handle.data = pending.slice(0, pendingSize);
        handle.size = pendingSize;
        handle.closed++;
        return Promise.resolve();
      },
      abort() {
        handle.aborted++;
        return Promise.resolve();
      },
    });
  }

  getFile(): Promise<{ size: number }> {
    return Promise.resolve({ size: this.size });
  }
}
