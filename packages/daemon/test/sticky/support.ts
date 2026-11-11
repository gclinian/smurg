// TEST ONLY: a test daemon with the REAL files and locks modules (the watcher on a real folder, the file service) and
// the REAL sticky module, fakes for everything else, and four members over real connections. What the Viewer's
// connection was sent of `sticky.changed` is collected: every member who may read files gets it.
import { afterEach } from 'vitest';
import type { PayloadOf } from '@smurg/protocol';
import { fakesModule } from '../../src/core/fakes/index.ts';
import { createFilesModule } from '../../src/files/module.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createStickyModule } from '../../src/sticky/module.ts';
import type { StickyServiceImpl } from '../../src/sticky/service.ts';
import { createTempDir, createTempProject, createTestDaemon, removeTempDir, waitFor, type TestClient, type TestDaemon } from '../../src/testing/index.ts';

export const MEI = 'dev:mei';
export const AMY = 'dev:amy';
export const LEO = 'dev:leo';

export interface NotesStack {
  readonly t: TestDaemon;
  /** The shared folder. */
  readonly root: string;
  readonly service: StickyServiceImpl;
  /** The host, Mei (Agent access), Amy (an Editor), Leo (a Viewer). */
  readonly host: TestClient;
  readonly mei: TestClient;
  readonly amy: TestClient;
  readonly leo: TestClient;
  /** Every `sticky.changed` Leo's connection was sent, in order. */
  readonly changes: PayloadOf<'sticky.changed'>[];
  /** Waits until the index has made one more listing than `before` (after a change on disk), and a little longer for the event. */
  listed(before: number, what: string): Promise<void>;
}

export interface NotesOptions {
  /** Files of the shared folder before the daemon starts (relative path → content). */
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  /** What else is done to the folder before the daemon starts (symlinks, hard links). */
  readonly prepare?: (root: string) => Promise<void>;
  /** false: no file watcher (only what the daemon is told reaches the index). */
  readonly watch?: boolean;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 60_000);

export async function startNotes(options: NotesOptions = {}): Promise<NotesStack> {
  const scratch = await createTempDir('sticky');
  cleanups.push(() => removeTempDir(scratch));
  const root = await createTempProject(scratch, 'project', { files: options.files ?? {} });
  await options.prepare?.(root);
  const sticky = createStickyModule({ fileDebounceMs: 30 });
  const t = await createTestDaemon({ root, modules: [locksModule, createFilesModule({ watch: options.watch ?? true }), fakesModule({ handlers: true }), sticky] });
  cleanups.push(() => t.cleanup());
  const service = sticky.serviceOf(t.ctx) as StickyServiceImpl;
  const host = await t.connectHost();
  const mei = await t.connect({ userId: MEI, displayName: 'Mei', role: 'agent' });
  const amy = await t.connect({ userId: AMY, displayName: 'Amy', role: 'editor' });
  const leo = await t.connect({ userId: LEO, displayName: 'Leo', role: 'viewer' });
  const changes: PayloadOf<'sticky.changed'>[] = [];
  leo.conn.on('sticky.changed', (payload) => changes.push(payload));
  return {
    t,
    root,
    service,
    host,
    mei,
    amy,
    leo,
    changes,
    listed: async (before, what) => {
      await waitFor(() => service.index.listings() > before, { timeoutMs: 10_000, what });
      // The event goes out with the listing; one round trip on Leo's connection is enough for it to arrive.
      await leo.conn.request('sticky.list', {});
    },
  };
}
