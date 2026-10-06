// Feature module of src/files/ (ARCHITECTURE §7.2): file.* on the interactive channel (R1, R7), uploads and
// downloads on the transfer channel (R7, D15), and the file watcher.
// Slots: `files` (FileService), `uploads` (UploadService), `downloads` (DownloadService).
//
// `filesModule` is what DEFAULT_FEATURE_MODULES composes; createFilesModule() exists for tests that need a seam
// (a simulated disk through `statfs`, a short upload TTL, a small tree limit). One module object may serve several
// daemons in one process (tests, e2e), so every piece of state lives per DaemonContext, never in the closure.
import type { Actor } from '@smurg/protocol';
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import type { Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import { isStubService } from '../core/stubs.ts';
import type { StatfsFunction } from './disk.ts';
import { DownloadServiceImpl } from './download.ts';
import { EXPECT_CHANGE_TTL_MS, FileServiceImpl } from './file-service.ts';
import { registerFileHandlers } from './handlers.ts';
import { UploadServiceImpl } from './upload.ts';
import { FileWatcher, type WatcherOptions } from './watcher.ts';

export interface FilesModuleOptions {
  /** Disk statistics for the upload disk rule (default fs.statfs). Tests simulate a nearly full disk with it. */
  readonly statfs?: StatfsFunction;
  /** Partial uploads untouched for this long are removed (default 48 h). */
  readonly uploadTtlMs?: number;
  /** How often abandoned partial uploads are swept (default hourly). */
  readonly sweepIntervalMs?: number;
  /** Planned-but-not-begun upload bytes stay reserved this long (default 30 min). */
  readonly planReservationTtlMs?: number;
  /** Entries per file.tree result (default and maximum 10,000). */
  readonly treeMaxEntries?: number;
  /** false: no file watcher (tests of other areas that do not want FSEvents). Default true. */
  readonly watch?: boolean;
  readonly watcher?: WatcherOptions;
}

/** Everything one daemon's files module owns (tests reach it through filesInstanceOf). */
export interface FilesInstance {
  readonly files: FileServiceImpl;
  readonly uploads: UploadServiceImpl;
  readonly downloads: DownloadServiceImpl;
  readonly watcher: FileWatcher | null;
}

const instances = new WeakMap<DaemonContext, FilesInstance>();

/** The files module's services of a running daemon (tests, diagnostics). */
export function filesInstanceOf(ctx: DaemonContext): FilesInstance | null {
  return instances.get(ctx) ?? null;
}

function agentActor(ctx: DaemonContext, sessionId: string, ownerUserId: string): Actor | null {
  // The agent is named as its session names it (`Claude (<topic>)`, `Claude (<work item>)`, `Claude (<opener>)`): the
  // name the lock and the audit log already carry, so the activity feed never calls the same agent something else. A
  // session the registry does not know (or no registry) gets the default name after its owner.
  const sessions = ctx.services.sessions;
  const registered = isStubService(sessions) ? null : sessions.agentActor(sessionId);
  const agentName = registered !== null && registered.kind === 'agent' ? registered.displayName : undefined;
  // Only the actor (who to attribute a change to) is read here; no right is taken from this principal.
  return ctx.members.agentPrincipal(sessionId, ownerUserId, { ...(agentName === undefined ? {} : { agentName }), pathRights: 'member' })?.actor ?? null;
}

export function createFilesModule(options: FilesModuleOptions = {}): FeatureModule {
  const instanceOf = (ctx: DaemonContext): FilesInstance => {
    const instance = instances.get(ctx);
    if (!instance) throw new Error('files module used before create()');
    return instance;
  };
  return {
    name: 'files',

    create(ctx) {
      const files = new FileServiceImpl(ctx, options.treeMaxEntries !== undefined ? { treeMaxEntries: options.treeMaxEntries } : {});
      const uploads = new UploadServiceImpl(ctx, files, {
        ...(options.statfs ? { statfs: options.statfs } : {}),
        ...(options.uploadTtlMs !== undefined ? { ttlMs: options.uploadTtlMs } : {}),
        ...(options.sweepIntervalMs !== undefined ? { sweepIntervalMs: options.sweepIntervalMs } : {}),
        ...(options.planReservationTtlMs !== undefined ? { planReservationTtlMs: options.planReservationTtlMs } : {}),
      });
      const downloads = new DownloadServiceImpl(ctx);
      const watcher = options.watch === false ? null : new FileWatcher(ctx, files, options.watcher ?? {});
      instances.set(ctx, { files, uploads, downloads, watcher });
      return { files, uploads, downloads };
    },

    register(router: Router, ctx: DaemonContext): Disposable {
      const { files, uploads, downloads } = instanceOf(ctx);
      const stack = new DisposableStack();
      stack.add(registerFileHandlers(router, ctx));
      // Transfer connections have no resume: their uploads stay resumable, their downloads end.
      stack.add(
        ctx.bus.on('conn.closed', ({ conn }) => {
          if (conn.purpose !== 'transfer') return;
          uploads.onConnectionClosed(conn.id);
          downloads.cancelAllForConnection(conn.id);
        }),
      );
      // Agent edits: a granted agent lock announces the coming write (the watcher attributes it to the agent), the
      // Post event names the agent as the file's last modifier (tree badge, R11 "recently changed by…").
      stack.add(
        ctx.bus.on('agent.tool.pre', (event) => {
          if (event.outcome !== 'granted' || event.file === null) return;
          const actor = agentActor(ctx, event.sessionId, event.ownerUserId);
          if (actor) files.expectChange(event.file, actor, ctx.settings.get().agentLockTimeoutMs + EXPECT_CHANGE_TTL_MS);
        }),
      );
      stack.add(
        ctx.bus.on('agent.tool.post', (event) => {
          if (!event.ok || event.file === null) return;
          const actor = agentActor(ctx, event.sessionId, event.ownerUserId);
          if (!actor) return;
          files.expectChange(event.file, actor);
          files.attribution.recordModified(event.file.root, event.file.path, actor);
        }),
      );
      stack.add(
        ctx.bus.on('agent.file-changed', (event) => {
          const actor = agentActor(ctx, event.sessionId, event.ownerUserId);
          if (!actor) return;
          if (event.change === 'unlink') files.attribution.forget(event.file.root, event.file.path, false);
          else files.attribution.recordModified(event.file.root, event.file.path, actor);
        }),
      );
      return stack;
    },

    async start(ctx) {
      const { files, uploads, watcher } = instanceOf(ctx);
      await files.start();
      await uploads.start();
      await watcher?.start();
    },

    async stop(ctx) {
      const instance = instances.get(ctx);
      if (!instance) return;
      await instance.watcher?.stop().catch(() => {});
      instance.downloads.stopAll();
      await instance.uploads.stop().catch(() => {});
    },
  };
}

export const filesModule: FeatureModule = createFilesModule();
