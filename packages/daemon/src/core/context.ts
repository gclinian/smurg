// The DaemonContext every module receives, and the FeatureModule shape feature engineers export.
//
//   // src/files/module.ts
//   export const filesModule: FeatureModule = {
//     name: 'files',
//     create: (ctx) => ({ files: new FileServiceImpl(ctx) }),
//     register: (router, ctx) => registerFileHandlers(router, ctx),   // returns a Disposable
//   };
//
// Tests pass modules to createTestDaemon({ modules: [filesModule] }); production composes DEFAULT_FEATURE_MODULES
// (src/daemon.ts). A service slot no module fills keeps its stub (internal "not implemented: <Service>").
import type {
  AuditLog,
  DaemonLifecycle,
  EventBus,
  FeatureServices,
  Hub,
  InviteService,
  MemberDirectory,
  PathGuard,
  PowerService,
  RootRegistry,
  Router,
  SettingsService,
  StateStore,
  WorkspaceDescriptor,
} from './interfaces.ts';
import type { DaemonConfig } from './config.ts';
import type { Clock, Disposable } from './lifecycle.ts';
import type { Logger } from './logger.ts';

export interface DaemonContext {
  readonly config: DaemonConfig;
  readonly workspace: WorkspaceDescriptor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly bus: EventBus;
  readonly state: StateStore;
  readonly audit: AuditLog;
  readonly hub: Hub;
  readonly router: Router;
  readonly roots: RootRegistry;
  readonly paths: PathGuard;
  readonly members: MemberDirectory;
  readonly invites: InviteService;
  readonly settings: SettingsService;
  readonly power: PowerService;
  /** Filled before any module's register() runs; call other services lazily (from methods), never in create(). */
  readonly services: FeatureServices;
  /** Aborted when stop() begins: long operations (merges, zips, waits) should give up. */
  readonly stopping: AbortSignal;
  /** stop / status / local attach, for the control-socket module (src/local/). */
  readonly lifecycle: DaemonLifecycle;
}

export interface FeatureModule {
  /** Unique, e.g. 'files', 'docs', 'locks', 'sessions', 'sandbox', 'hooks', 'suggest', 'worktree'. */
  readonly name: string;
  /**
   * Builds the services this module implements (a slot may be filled by exactly one module). Runs once, in module
   * order, before any register(). Must not call other services.
   */
  create?(ctx: DaemonContext): Partial<FeatureServices> | Promise<Partial<FeatureServices>>;
  /** Registers handlers and bus listeners. Everything it sets up must be undone by the returned Disposable. */
  register(router: Router, ctx: DaemonContext): Disposable;
  /** After every module registered (open sockets, start watchers). Failing aborts daemon start. */
  start?(ctx: DaemonContext): Promise<void>;
  /** Reverse module order during stop(), after channels were closed with `stopped`. Must not throw. */
  stop?(ctx: DaemonContext): Promise<void>;
}
