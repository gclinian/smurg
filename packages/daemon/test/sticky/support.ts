// TEST ONLY: a test daemon with the REAL files and locks modules (the watcher on a real folder, the file service) and
// the REAL sticky module, fakes for everything else, and four members over real connections. What the Viewer's
// connection was sent of `sticky.changed` is collected: every member who may read files gets it. With
// `conversation: true` (the feedback, DESIGN 0.8.0 D4) the conversation and suggest modules are the real ones too, in
// front of the FAKE agent runtime, which records every message it is sent (`fakes.agents.log.of('send')`). With
// `topics: true` ("Build this", DESIGN 0.8.0 D5) the topics module is the real one too, so a build makes a real topic
// whose discussion the fake runtime starts, and the topic reads the files the build wrote.
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { PayloadOf } from '@smurg/protocol';
import type { AgentsConfig } from '../../src/core/config.ts';
import type { ConnectorsEntry } from '../../src/core/interfaces.ts';
import type { FeatureModule } from '../../src/core/context.ts';
import { fakesModule, fakesOf, type Fakes } from '../../src/core/fakes/index.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { createConversationModule } from '../../src/conversation/module.ts';
import { createMemoryLogger } from '../../src/core/logger.ts';
import { createFilesModule } from '../../src/files/module.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createStickyModule } from '../../src/sticky/module.ts';
import type { StickyModuleOptions, StickyServiceImpl } from '../../src/sticky/service.ts';
import { createSuggestModule } from '../../src/suggest/module.ts';
import { createTopicsModule } from '../../src/topics/module.ts';
import { createTempDir, createTempProject, createTestDaemon, removeTempDir, waitFor, type TestClient, type TestDaemon } from '../../src/testing/index.ts';

export const MEI = 'dev:mei';
export const AMY = 'dev:amy';
export const LEO = 'dev:leo';

export interface NotesStack {
  readonly t: TestDaemon;
  /** The shared folder. */
  readonly root: string;
  readonly service: StickyServiceImpl;
  /** The fakes of every slot this daemon did not get a real module for (the agent runtime among them). */
  readonly fakes: Fakes;
  /** The host, Mei (Agent access), Amy (an Editor), Leo (a Viewer). */
  readonly host: TestClient;
  readonly mei: TestClient;
  readonly amy: TestClient;
  readonly leo: TestClient;
  /** Every `sticky.changed` Leo's connection was sent, in order. */
  readonly changes: PayloadOf<'sticky.changed'>[];
  /** What the daemon logged (the index says there when a listing or a read failed and is tried again). */
  readonly logs: ReturnType<typeof createMemoryLogger>['lines'];
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
  /** The real conversation and suggest modules in front of the fake agent runtime (an accept's message is real). */
  readonly conversation?: boolean;
  /** The sticky module's own options (the bounds of the feedback). */
  readonly sticky?: Omit<StickyModuleOptions, 'fileDebounceMs'>;
  /** The real topics module (and its plans and reports) in front of the fake agent runtime. */
  readonly topics?: boolean;
  /** The agent runtime's limits (`ctx.config.agents`: `maxAgentSessions`). */
  readonly agents?: Partial<AgentsConfig>;
  /** The Slack and Discord channels smurg host would hand over (DESIGN 0.8.0 D6.2), and the fake servers they are on. */
  readonly connectors?: () => ConnectorsEntry | null;
  readonly outsideBaseUrls?: { readonly slack?: string; readonly discord?: string };
  /** A state dir and a shared folder of an earlier start (a restart): owned by the caller, kept as they are. */
  readonly stateDir?: string;
  readonly root?: string;
  readonly workspaceId?: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 60_000);

export async function startNotes(options: NotesOptions = {}): Promise<NotesStack> {
  const scratch = await createTempDir('sticky');
  cleanups.push(() => removeTempDir(scratch));
  const root = options.root ?? (await createTempProject(scratch, 'project', { files: options.files ?? {} }));
  if (options.root === undefined) await options.prepare?.(root);
  const sticky = createStickyModule({ ...options.sticky, fileDebounceMs: 30 });
  const log = createMemoryLogger();
  const real: FeatureModule[] = [
    ...(options.conversation === true ? [conversationSeed, createConversationModule(), createSuggestModule()] : []),
    ...(options.topics === true ? [createTopicsModule({ fileDebounceMs: 10 })] : []),
  ];
  const except = [...(options.conversation === true ? (['conversation', 'suggestions'] as const) : []), ...(options.topics === true ? (['topics', 'plans', 'reports'] as const) : [])];
  const fakes = fakesModule({ handlers: true, ...(except.length === 0 ? {} : { except }) });
  const t = await createTestDaemon({
    root,
    log,
    modules: [locksModule, createFilesModule({ watch: options.watch ?? true }), fakes, ...real, sticky],
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    ...(options.connectors === undefined ? {} : { connectors: options.connectors }),
    ...(options.outsideBaseUrls === undefined ? {} : { outsideBaseUrls: options.outsideBaseUrls }),
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
  });
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
    fakes: fakesOf(t.ctx),
    host,
    mei,
    amy,
    leo,
    changes,
    logs: log.lines,
    listed: async (before, what) => {
      await waitFor(() => service.index.listings() > before, { timeoutMs: 10_000, what });
      // The event goes out with the listing; one round trip on Leo's connection is enough for it to arrive.
      await leo.conn.request('sticky.list', {});
    },
  };
}

/** Where the fake agent runtime keeps a session's private directory: the real conversation module keeps cards there. */
const conversationSeed: FeatureModule = {
  name: 'test-seed',
  register: () => toDisposable(() => {}),
  start: async (ctx) => {
    fakesOf(ctx).agents.storageRoot = join(ctx.state.dir, 'transcripts');
  },
};
