// The composition root (ARCHITECTURE §7.2): builds the DaemonContext, fills every feature service slot (a module's
// implementation or a stub), registers handlers, and owns the lifecycle.
//
//   const daemon = await createDaemon({ config, relay: { token }, modules: DEFAULT_FEATURE_MODULES });
//                                         // PHASE 1 reads and checks the whole workspace folder and writes nothing
//                                         // (a refusal is a StateFileError with its kind); PHASE 2 writes: the stamp,
//                                         // kept copies and upgraded documents, the key and state.json of a new
//                                         // workspace, the logs (core/workspace-folder.ts). daemon.upgraded / .putBack
//   await daemon.start();                 // keep-awake, identity keys, modules, host invite, relay links
//   console.log(daemon.hostInviteUrl);
//   await daemon.stop();                  // channel.closed{stopped} → relay links closed → modules stopped (reverse)
//                                         // → handlers disposed → keep-awake released → logs flushed
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { SmurgError, daemonKeyFingerprint, formatFingerprintForDisplay, shortTextSchema, type ChannelPurpose, type NoiseSuite, type Welcome, type WorkspaceInfo } from '@smurg/protocol';
import { ensurePrivateDirectory, loadOrCreateDaemonIdentity, nodeCryptoSuite, type LoadedStaticKey } from '@smurg/protocol/node';
import { relayHttpUrl, wsHostUrl, xferHostUrl } from '@smurg/protocol/relay';
import { registerAdminHandlers } from './admin/handlers.ts';
import { InviteServiceImpl } from './admin/invites.ts';
import { MemberDirectoryImpl } from './admin/members.ts';
import { SettingsServiceImpl } from './admin/settings.ts';
import { conversationModule } from './conversation/module.ts';
import { docsModule } from './docs/module.ts';
import { filesModule } from './files/module.ts';
import { hooksModule } from './hooks/module.ts';
import { inboxModule } from './inbox/module.ts';
import { localControlModule } from './local/module.ts';
import { locksModule } from './locks/module.ts';
import { sessionsModule } from './sessions/module.ts';
import { suggestModule } from './suggest/module.ts';
import { topicsModule } from './topics/module.ts';
import { worktreeModule } from './worktree/module.ts';
import daemonPackage from '../package.json' with { type: 'json' };
import { JsonlAuditLog } from './core/audit.ts';
import { AuditTextStore } from './core/audit-text.ts';
import { TypedEventBus } from './core/bus.ts';
import { resolveConfig, type DaemonConfig, type DaemonConfigInput } from './core/config.ts';
import type { DaemonContext, FeatureModule } from './core/context.ts';
import { HubImpl } from './core/hub.ts';
import {
  FEATURE_SERVICE_NAMES,
  LOCAL_DEVICE_ID,
  type DaemonLifecycle,
  type DaemonStatus,
  type FeatureServiceName,
  type FeatureServices,
  type LocalAttachInput,
  type LocalAttachment,
  type PowerService,
  type WorkspaceDescriptor,
} from './core/interfaces.ts';
import { DisposableStack, systemClock, type Clock } from './core/lifecycle.ts';
import { createLineLogger, type Logger } from './core/logger.ts';
import { SYSTEM_ACTOR } from './core/permissions.ts';
import { TokenBucketLimiter } from './core/rates.ts';
import { RouterImpl } from './core/router.ts';
import { FileStateStore, StateFileError, type DocumentDeclaration } from './core/state-store.ts';
import { createStubService, isStubService } from './core/stubs.ts';
import { readWorkspaceFolder, writeWorkspaceFolder, type FolderReading, type UpgradedDocument } from './core/workspace-folder.ts';
import { STATE_DOCUMENT, stateDocument, type workspaceStateSchema } from './core/workspace-state.ts';
import { ChannelServer } from './net/channel-server.ts';
import { wsHostSocketFactory, type HostSocketFactory } from './net/host-socket.ts';
import { IdentityVerifier, jwksKeySource, staticKeySource, type IdentityKeySource } from './net/identity.ts';
import { LOCAL_CHANNEL_VIA, LocalChannel } from './local/local-channel.ts';
import { RelayLink } from './net/relay-connection.ts';
import { PathGuardImpl } from './workspace/path-guard.ts';
import { KeepAwake } from './workspace/power.ts';
import { RootRegistryImpl } from './workspace/roots.ts';
import { prepareShare } from './workspace/share.ts';
import { acquireShareLock } from './workspace/share-lock.ts';

/** The daemon's version: its package.json (every package of a release carries the release's X.Y.Z, docs/RELEASING.md §4). */
export const DAEMON_VERSION: string = daemonPackage.version;

/**
 * Feature modules composed in production (and by createTestDaemon / the e2e startStack when a test passes no
 * `modules`): the release composition, every feature area exactly once (DESIGN §9.3; test/composition.test.ts
 * transcribes the order). Tests that want a subset pass modules to createTestDaemon directly.
 *
 * Order. create() runs in this order but may not call other services, so the order matters for the rest:
 * register() and start() run in this order, stop() in reverse (after every channel was closed with `stopped`), and
 * bus listeners fire in registration order. Providers others depend on come first, so they are up before their users
 * start and still up while their users stop:
 *  - locks (LockManager, presence, activity): in-memory state that hooks, files, docs and sessions consult; its
 *    kick / leave listeners drop human locks before later modules react to the same event;
 *  - hooks: the hook socket listens before any session starts, and closes only after sessions are gone, so a dying
 *    session's Stop / SessionEnd hooks are still answered (and its agent locks released);
 *  - files (watcher, uploads, downloads), then docs: docs builds on file events and flushes dirty documents in its
 *    stop() while the watcher is still running;
 *  - worktree: kept worktrees are registered as roots before a session may be started in one;
 *  - sessions (terminals, the agent runtime, the trust gate, the host's own rules): after everything it launches
 *    with; its stop() (end every terminal, park every agent process as "daemon stop") runs before worktree, hooks
 *    and locks stop, and after everything below it stopped;
 *  - conversation: its start() asks the agent runtime which sessions still exist and where their cards are, so it
 *    starts after sessions; it stops (open cards withdrawn, nothing more sent to an agent) before the runtime does;
 *  - suggest: its start() asks the registry which agent sessions still exist and closes the suggestions of the
 *    others; an accepted suggestion is a message to an agent session, so it stops (no more messages) before the
 *    runtime does;
 *  - topics (topics, plans, reports, the scheduler): its start() asks worktree, sessions, conversation and suggest
 *    what a restart left; it stops before sessions, so nothing is started while the sessions go down;
 *  - inbox: derived from all of the above; its start() takes the first full view once they have loaded their state
 *    (from then on it drops the "seen" marks of items that are not there);
 *  - local: the control socket opens last (a local `smurg attach` never sees a half-started daemon). Its module stops
 *    first, but the socket itself closes only when the registrations are disposed (after every module stopped), so
 *    `smurg stop` sees it go when the daemon is done (it answers status with stopped: true meanwhile).
 */
export const DEFAULT_FEATURE_MODULES: readonly FeatureModule[] = Object.freeze([
  locksModule,
  hooksModule,
  filesModule,
  docsModule,
  worktreeModule,
  sessionsModule,
  conversationModule,
  suggestModule,
  topicsModule,
  inboxModule,
  localControlModule,
]);

/**
 * Every document of the workspace folder a daemon with these modules declares: the core's `state` first, then each
 * module's (FeatureModule.documents), in module order. Phase 1 of a start reads and checks exactly these.
 */
export function declaredDocuments(config: Pick<DaemonConfig, 'workspaceId' | 'defaultSettings'>, modules: readonly FeatureModule[] = DEFAULT_FEATURE_MODULES): readonly DocumentDeclaration[] {
  return [stateDocument(config.workspaceId, config.defaultSettings), ...modules.flatMap((module) => module.documents ?? [])];
}

export interface DaemonOptions {
  readonly config: DaemonConfigInput;
  /** Relay access for the host sockets. Without it (or without config.relayUrl) the daemon opens no relay link. */
  readonly relay?: { readonly token: string; readonly socketFactory?: HostSocketFactory };
  /** Identity-token verification keys; default: the relay's JWKS. */
  readonly identityKeys?: IdentityKeySource;
  readonly modules?: readonly FeatureModule[];
  readonly clock?: Clock;
  readonly log?: Logger;
  /** Noise suite (default: node:crypto AEAD). */
  readonly suite?: NoiseSuite;
  /** Keep-awake implementation (default: caffeinate / systemd-inhibit when config.keepAwake). */
  readonly power?: PowerService;
  /**
   * The host's home directory (default: os.homedir()): refused as a share, and the default of
   * config.sessions.hostHome (every session's HOME). Tests pass a temporary fake home.
   */
  readonly homeDir?: string;
  readonly random?: () => number;
}

export type { DaemonStatus } from './core/interfaces.ts';

export interface Daemon {
  readonly ctx: DaemonContext;
  readonly config: DaemonConfig;
  readonly workspaceId: string;
  readonly daemonPublicKey: Uint8Array;
  /** `k` formatted for display ("df08 a1fc …"). */
  readonly fingerprint: string;
  /** The host's own single-use invite link, created by start(). Contains a secret: print it, never log it. */
  readonly hostInviteUrl: string | null;
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  status(): DaemonStatus;
  /**
   * A fresh relay session token for the host sockets (the host ran `smurg login` again): used from the next upgrade,
   * at once when the relay refused the old one (link state 'auth-rejected', bus event 'relay.link').
   */
  updateRelayToken(token: string): void;
  /**
   * What this start upgraded (empty when nothing): a document that an earlier published smurg wrote in another shape
   * was read, upgraded in memory, kept as it was in `copy` and written in today's shape, before the daemon did
   * anything else. `from`: the step's name (`0.4.0`); `copy`: the absolute path of the kept copy.
   */
  readonly upgraded: readonly { readonly document: string; readonly from: string; readonly copy: string }[];
  /**
   * A step ran although the folder's stamp already named a smurg that upgrades this shape itself (0.5.1 or later): an
   * OLDER file was put back. Everything decided since that file was written (kicks, revoked devices and links, role
   * changes, used-up links) is undone by it; `smurg host` says so.
   */
  readonly putBack: boolean;
  /** For the testing harness and the local control socket. */
  readonly internals: {
    readonly hub: HubImpl;
    readonly channelServer: ChannelServer;
    readonly members: MemberDirectoryImpl;
    readonly invites: InviteServiceImpl;
    readonly links: ReadonlyMap<ChannelPurpose, RelayLink>;
    readonly identityKeys: IdentityKeySource;
    /** `store.unsaved()`: state documents the disk currently refuses. */
    readonly store: FileStateStore;
    /**
     * What phase 1 of this start read, before anything was written: the stamp, and every declared document that
     * existed, as loaded and upgraded in memory (`folder.loaded.get('state')?.value`, frozen). For tests.
     */
    readonly folder: FolderReading;
  };
}

function errnoCodeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}

function sanitizeName(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').trim().slice(0, 256);
  return shortTextSchema.safeParse(cleaned).success && cleaned.length > 0 ? cleaned : fallback;
}

export async function createDaemon(options: DaemonOptions): Promise<Daemon> {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux') throw new Error(`smurg hosts run on macOS and Linux only (this is ${platform})`);
  const config = resolveConfig({
    ...options.config,
    memoryBytes: options.config.memoryBytes ?? totalmem(),
    sessions: { ...options.config.sessions, hostHome: options.config.sessions?.hostHome ?? options.homeDir ?? homedir() },
  });
  const clock = options.clock ?? systemClock;
  const log = options.log ?? createLineLogger();

  // ~/.smurg must be private: refuse (never chmod) a directory other users can read.
  await ensurePrivateDirectory(config.stateDir);
  // The sockets (control, hook) live here; a group/other-accessible run dir is refused like the state dir.
  await ensurePrivateDirectory(config.runDir);
  const share = await prepareShare(config.shareDir, config.stateDir, options.homeDir === undefined ? {} : { homeDir: options.homeDir });
  // One daemon per folder, whatever state dir or relay the other one uses. Held until stop().
  const shareLock = await acquireShareLock({ shareRealPath: share.realPath, runDir: config.runDir, workspaceId: config.workspaceId });
  const modules = options.modules ?? DEFAULT_FEATURE_MODULES;
  const stateLog = log.child({ module: 'state' });
  /** Every refusal of any file is logged with the file and the reason (messages are ours: paths and zod's own texts, never a value). */
  const logRefusal = (err: unknown): void => {
    const known = err instanceof StateFileError;
    log.error('workspace state refused; the daemon does not start', {
      error: err instanceof Error ? err.name : 'unknown',
      ...(known ? { kind: err.kind, file: err.path } : {}),
      ...(known && err.cause !== undefined ? { cause: err.cause } : {}),
      ...(known && err.errno !== undefined ? { errno: err.errno } : {}),
      ...(known && err.reason !== undefined ? { why: err.reason } : {}),
      ...(known && err.paths.length > 1 ? { files: err.paths.join(' ') } : {}),
      ...(known && err.writtenBy !== undefined ? { writtenBy: err.writtenBy } : {}),
      reason: known || (err instanceof Error && err.name === 'KeyFileError') ? (err as Error).message : errnoCodeOf(err),
    });
  };

  // ---- PHASE 1: only reads (core/workspace-folder.ts). The stamp; owner, mode and kind of the key, the logs and every
  // declared document; the key; every declared document that exists, upgraded in memory. No key is created, no log
  // is opened, no folder is made and no module code has run. A refusal leaves the workspace folder byte for byte.
  let reading: FolderReading;
  const documents = declaredDocuments(config, modules);
  const coreDocument = documents[0] as ReturnType<typeof stateDocument>;
  try {
    const moduleNames = new Set<string>();
    for (const module of modules) {
      if (moduleNames.has(module.name)) throw new Error(`feature module ${module.name} is listed twice`);
      moduleNames.add(module.name);
    }
    reading = await readWorkspaceFolder({
      dir: config.workspaceStateDir,
      log: stateLog,
      documents,
      env: { memoryBytes: options.config.memoryBytes ?? totalmem() },
      smurg: DAEMON_VERSION,
      workspaceId: config.workspaceId,
    });
  } catch (err) {
    if (err instanceof StateFileError || (err instanceof Error && err.name === 'KeyFileError')) logRefusal(err);
    else log.error('daemon composition failed', { error: err instanceof Error ? err.name : 'unknown', reason: errnoCodeOf(err) });
    await shareLock.release();
    throw err;
  }

  // ---- PHASE 2: writes, only now that phase 1 accepted everything. In this order: the folder (a new workspace), the
  // stamp, for every upgraded document its kept copy and then the document; then everything a start does: the key and
  // the first state.json of a new folder, the logs, ensureHost, prune, the modules.
  let store: FileStateStore;
  let identity: { readonly keyPair: LoadedStaticKey['keyPair'] };
  let state: Awaited<ReturnType<typeof store.coreDocument<typeof workspaceStateSchema>>>;
  let audit: JsonlAuditLog;
  let upgraded: readonly UpgradedDocument[];
  try {
    const written = await writeWorkspaceFolder(reading, { log: stateLog, clock });
    store = written.store;
    upgraded = written.upgraded;
    if (upgraded.length > 0 && reading.putBack) {
      log.warn('an OLDER state file was put back into this workspace folder and upgraded again: everything decided since it was written (kicks, revoked devices and links, role changes, used-up links) is undone', {
        documents: upgraded.map((entry) => entry.document).join(' '),
        stamp: reading.stamp?.smurg ?? 'unknown',
      });
    }
    // The key is created only with the first state.json of a NEW folder; an existing folder's key was read in phase 1.
    identity = reading.keyPair !== null ? { keyPair: reading.keyPair } : await loadOrCreateDaemonIdentity(config.workspaceStateDir);
    state = await store.coreDocument(STATE_DOCUMENT, coreDocument.schema, coreDocument.init);
    if (state.get().workspaceId !== config.workspaceId) {
      throw new StateFileError({ kind: 'other-workspace', path: join(config.workspaceStateDir, 'state.json'), message: 'state file belongs to another workspace' });
    }
    // Full texts (messages, suggestions, commands, notes) rotate in their own files, never the core log.
    const auditTexts = await AuditTextStore.open(join(config.workspaceStateDir, 'audit-text.jsonl'), {
      clock,
      log: log.child({ module: 'audit' }),
      maxBytes: config.limits.auditTextMaxBytes,
    });
    audit = await JsonlAuditLog.open(join(config.workspaceStateDir, 'audit.jsonl'), {
      clock,
      log: log.child({ module: 'audit' }),
      pageMax: config.limits.auditPageMax,
      maxBytes: config.limits.auditMaxBytes,
      deniedPerActorPerMinute: config.limits.auditDeniedPerActorPerMinute,
      hostUserId: config.hostUserId,
      texts: auditTexts,
    }).catch(async (err: unknown) => {
      await auditTexts.close();
      throw err;
    });
  } catch (err) {
    // The host is sent to the log for the reason (review F3): say which file and why.
    logRefusal(err);
    await shareLock.release();
    throw err;
  }
  try {
    const bus = new TypedEventBus(log.child({ module: 'bus' }));
    // A state document the disk refuses (and its recovery) reaches the host's terminal through the bus.
    const stateHealth = store.onHealthChange((event) => bus.emit('state.write', event));
    const roots = await RootRegistryImpl.create(share.realPath, state, clock);
    // The service slots exist before PathGuard does: it asks the trust gate (once its module is composed) which files
    // of a root are host-only for writes right now.
    const services = {} as { -readonly [K in FeatureServiceName]: FeatureServices[K] };
    for (const name of FEATURE_SERVICE_NAMES) (services as Record<FeatureServiceName, unknown>)[name] = createStubService(name);
    const paths = new PathGuardImpl({
      roots,
      audit,
      platform,
      protectedPaths: (root) => (isStubService(services.projectTrust) ? new Set<string>() : services.projectTrust.protectedPaths(root)),
    });
    const members = new MemberDirectoryImpl({ state, audit, bus, clock, log: log.child({ module: 'members' }), hostUserId: config.hostUserId, hostName: config.hostName });
    members.ensureHost();
    const hub = new HubImpl({
      clock,
      log: log.child({ module: 'hub' }),
      bus,
      timing: config.timing,
      limits: config.limits,
      roleOf: (userId) => members.roleOf(userId),
      audit,
      actorOf: (userId) => {
        const member = members.get(userId);
        return { kind: 'user', userId, displayName: member?.displayName ?? userId.slice(userId.indexOf(':') + 1) };
      },
    });
    members.setHub(hub);
    // "Last seen" is the last moment a member was CONNECTED: the end of a connection counts, not only its start
    // (admission), so the console's "last seen" of a member who stayed connected for days is not their first connect.
    const lastSeen = bus.on('conn.closed', ({ conn }) => members.touch(conn.userId, conn.deviceId, clock.now()));
    const rates = new TokenBucketLimiter(clock);
    const router = new RouterImpl({ sink: hub, members, audit, log: log.child({ module: 'router' }), rates });
    hub.setRouter(router);
    const settings = new SettingsServiceImpl({
      state,
      audit,
      bus,
      mainRealPath: roots.main.realPath,
    });
    const invites = new InviteServiceImpl({
      state,
      audit,
      clock,
      workspaceId: config.workspaceId,
      webOrigin: config.webOrigin,
      hostUserId: config.hostUserId,
      daemonPublicKey: identity.keyPair.publicKey,
    });
    invites.prune();
    const power = options.power ?? new KeepAwake({ enabled: config.keepAwake, log: log.child({ module: 'power' }) });

    const hostMember = members.active(config.hostUserId);
    const info: WorkspaceInfo = {
      id: config.workspaceId,
      name: sanitizeName(config.workspaceName ?? share.name, 'workspace'),
      hostUserId: config.hostUserId,
      hostName: hostMember?.displayName ?? config.hostName,
      platform,
      isGitRepo: share.isGitRepo,
    };
    const fingerprint = formatFingerprintForDisplay(daemonKeyFingerprint(identity.keyPair.publicKey));
    const workspace: WorkspaceDescriptor = Object.freeze({ info: Object.freeze(info), shareRealPath: share.realPath, daemonPublicKey: identity.keyPair.publicKey.slice(), fingerprint });

    const stopping = new AbortController();
    // Bound to the Daemon object below (it exists before any module can call these).
    let daemonRef: Daemon | null = null;
    const lifecycle: DaemonLifecycle = Object.freeze({
      stop: (reason?: string) => (daemonRef as Daemon).stop(reason),
      status: () => (daemonRef as Daemon).status(),
      attachLocal: (input: LocalAttachInput) => attachLocal(input),
    });
    const ctx: DaemonContext = Object.freeze({
      config,
      workspace,
      clock,
      log,
      bus,
      state: store,
      audit,
      hub,
      router,
      roots,
      paths,
      members,
      invites,
      settings,
      power,
      rates,
      services,
      stopping: stopping.signal,
      lifecycle,
    });

    const provided = new Map<FeatureServiceName, string>();
    for (const module of modules) {
      const created = (await module.create?.(ctx)) ?? {};
      for (const [key, value] of Object.entries(created)) {
        const name = key as FeatureServiceName;
        if (!FEATURE_SERVICE_NAMES.includes(name)) throw new Error(`feature module ${module.name} provides an unknown service ${key}`);
        if (provided.has(name)) throw new Error(`service ${name} is provided by both ${provided.get(name)} and ${module.name}`);
        if (value === undefined) continue;
        provided.set(name, module.name);
        (services as Record<FeatureServiceName, unknown>)[name] = value;
      }
    }

    const registrations = new DisposableStack();
    registrations.add(registerAdminHandlers(router, ctx));
    for (const module of modules) registrations.add(module.register(router, ctx));

    const identityKeys =
      options.identityKeys ??
      (config.relayUrl ? jwksKeySource({ url: relayHttpUrl(config.relayUrl, '/.well-known/jwks.json'), log: log.child({ module: 'identity' }), now: () => clock.now() }) : staticKeySource(new Map()));
    let lastKeyRefresh = 0;
    const requestKeyRefresh = (): void => {
      const now = clock.now();
      if (now - lastKeyRefresh < config.timing.identityKeyMinRefreshGapMs) return;
      lastKeyRefresh = now;
      void identityKeys.refresh();
    };
    const identityVerifier = new IdentityVerifier({ keys: identityKeys, issuer: config.identityIssuer, workspaceId: config.workspaceId, clock, skewMs: config.timing.identityClockSkewMs });
    const channelServer = new ChannelServer({
      workspaceId: config.workspaceId,
      staticKey: identity.keyPair,
      suite: options.suite ?? nodeCryptoSuite,
      invites,
      members,
      hub,
      audit,
      clock,
      log: log.child({ module: 'channels' }),
      timing: config.timing,
      limits: config.limits,
      admission: { members, identity: identityVerifier, settings, bus, workspace: () => workspace.info, requestKeyRefresh },
    });

    const links = new Map<ChannelPurpose, RelayLink>();
    if (options.relay && config.relayUrl) {
      const socketFactory = options.relay.socketFactory ?? wsHostSocketFactory();
      for (const purpose of ['interactive', 'transfer'] as const) {
        const link = new RelayLink({
          url: purpose === 'interactive' ? wsHostUrl(config.relayUrl, config.workspaceId) : xferHostUrl(config.relayUrl, config.workspaceId),
          token: options.relay.token,
          label: purpose === 'interactive' ? 'ws' : 'xfer',
          socketFactory,
          timing: config.timing,
          clock,
          log: log.child({ module: 'relay' }),
          ...(options.random ? { random: options.random } : {}),
          handlers: {
            online: () => {},
            offline: () => channelServer.linkDown(purpose),
            peerOpen: (frame) => channelServer.peerOpen(purpose, frame),
            peerClose: (conn) => channelServer.peerClose(purpose, conn),
            frame: (conn, payload) => channelServer.frame(purpose, conn, payload),
            replaced: () => log.error('another host connection replaced this daemon at the relay; stopped using it', { link: purpose }),
            stateChanged: (state, detail) =>
              bus.emit('relay.link', {
                purpose,
                state,
                ...(detail.reason === undefined ? {} : { reason: detail.reason }),
                ...(detail.status === undefined ? {} : { status: detail.status }),
              }),
          },
        });
        links.set(purpose, link);
        channelServer.bindLink(purpose, link);
      }
    }

    let started = false;
    let stopped = false;
    let hostInviteUrl: string | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;

    const startAll = async (): Promise<void> => {
      await power.start();
      await Promise.race([identityKeys.refresh(), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
      lastKeyRefresh = clock.now();
      refreshTimer = setInterval(() => {
        lastKeyRefresh = clock.now();
        void identityKeys.refresh();
      }, config.timing.identityKeyRefreshMs);
      refreshTimer.unref();
      hub.start();
      for (const module of modules) await module.start?.(ctx);
      hostInviteUrl = invites.createHostInvite().url;
      await store.flush();
      for (const link of links.values()) link.start();
      log.info('daemon started', { workspace: config.workspaceId, relay: config.relayUrl ?? 'none' });
    };

    const stopAll = async (reason: string): Promise<void> => {
      stopping.abort();
      bus.emit('daemon.stopping', { reason });
      hub.closeAll('stopped');
      channelServer.stop();
      for (const link of links.values()) link.stop();
      for (const module of [...modules].reverse()) {
        try {
          await module.stop?.(ctx);
        } catch (err) {
          log.error('module stop failed', { module: module.name, error: err instanceof Error ? err.name : 'unknown' });
        }
      }
      try {
        registrations.dispose();
      } catch (err) {
        log.error('handler disposal failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
      if (refreshTimer !== undefined) clearInterval(refreshTimer);
      hub.stopTimers();
      await power.stop();
      // Every unsaved document gets one more attempt; what still cannot be written is lost at the next start (a kick,
      // a demotion, a revoked invite would be undone), so say so loudly.
      await store.flush().catch((err: unknown) => {
        const unsaved = store.unsaved();
        log.error('STATE NOT SAVED: changes since the last successful write (kicks, role changes, revoked invites or devices) will be lost at the next start', {
          documents: unsaved.map((u) => `${u.name}:${u.error}`).join(',') || 'unknown',
          error: errnoCodeOf(err),
        });
      });
      lastSeen.dispose();
      store.close();
      stateHealth();
      await audit.close();
      // Last: the folder may be hosted again only when this daemon wrote everything it had.
      await shareLock.release();
      log.info('daemon stopped', { workspace: config.workspaceId });
    };

    /**
     * The host's own machine, through the control socket: same hub and router as a relay client, but the router lets
     * only what `smurg attach` sends through (local/local-channel.ts LOCAL_CHANNEL_TYPES: the socket authenticates the
     * host's OS account, which every session runs as), the hub sends it unasked only what `smurg attach` consumes
     * (LOCAL_CHANNEL_RECEIVES: no audit feed, no host notices), and every audit entry it causes says
     * `via: 'control-socket'`.
     */
    const attachLocal = (input: LocalAttachInput): LocalAttachment => {
      if (!started || stopped) throw new SmurgError('unauthorized', undefined, { reason: 'not-running' });
      const member = members.active(input.userId);
      if (input.userId !== config.hostUserId || member?.role !== 'host') {
        audit.record({ actor: SYSTEM_ACTOR, action: 'auth.rejected', outcome: 'denied', target: input.userId, detail: { via: LOCAL_CHANNEL_VIA, reason: 'local-not-host', mode: 'local' } });
        throw new SmurgError('forbidden', undefined, { reason: 'local-not-host' });
      }
      const admission = hub.prepareAdmission({ purpose: 'interactive', userId: member.userId, deviceId: LOCAL_DEVICE_ID, resume: input.resume, local: true });
      const channel = new LocalChannel({ send: (bytes) => input.send(bytes), close: () => input.close() });
      const connection = hub.attach({
        channel,
        admission,
        relayConn: null,
        userId: member.userId,
        deviceId: LOCAL_DEVICE_ID,
        clientKind: 'cli',
        deviceName: sanitizeName(input.deviceName, 'smurg CLI'),
        mode: 'local',
        control: { kick: () => channel.close(), bufferedAmount: () => 0 },
      });
      if (!connection) throw new SmurgError('unauthorized', undefined, { reason: 'not-admitted' });
      audit.record({
        actor: { kind: 'user', userId: member.userId, displayName: member.displayName },
        action: 'auth.connect',
        outcome: 'ok',
        target: LOCAL_DEVICE_ID,
        detail: { via: LOCAL_CHANNEL_VIA, mode: 'local', purpose: 'interactive', resumed: admission.resumed, clientKind: 'cli' },
      });
      const welcome: Welcome = {
        channelId: admission.channelId,
        resumed: admission.resumed,
        member: { ...members.toMember(member), online: true },
        workspace: workspace.info,
        settings: settings.public(),
        serverTime: clock.now(),
      };
      return {
        connection,
        welcome,
        open: () => channel.open(),
        receive: (bytes) => channel.deliver(bytes),
        end: () => channel.remoteClosed(),
      };
    };

    /** What `smurg status` shows about agents, from the modules that are composed (a stub contributes nothing). */
    const agentStatus = (): Pick<DaemonStatus, 'claude' | 'agents' | 'topics' | 'projectSettings' | 'hostRules'> => {
      const out: { -readonly [K in 'claude' | 'agents' | 'topics' | 'projectSettings' | 'hostRules']?: DaemonStatus[K] } = {};
      try {
        if (!isStubService(services.agents)) {
          // Claude Code as the agent runtime last found it (absent until its first check: `smurg status` says so).
          const claude = services.agents.claude();
          if (claude !== null) out.claude = claude;
          const counts = { running: 0, waiting: 0, stalled: 0, idle: 0 };
          for (const session of services.agents.list()) {
            if (session.status === 'running' || session.status === 'starting') counts.running += 1;
            else if (session.status === 'waiting-answer' || session.status === 'waiting-permission') counts.waiting += 1;
            else if (session.status === 'stalled' || session.status === 'failed') counts.stalled += 1;
            else if (session.status === 'idle' || session.status === 'done') counts.idle += 1;
          }
          out.agents = counts;
        }
        if (!isStubService(services.topics)) {
          const topics: { plan: { paused: boolean } }[] = [];
          for (let after: string | undefined; ; ) {
            const page = services.topics.list(after === undefined ? {} : { after });
            topics.push(...page.topics);
            const last = page.topics.at(-1);
            if (!page.hasMore || last === undefined) break;
            after = last.id;
          }
          out.topics = { total: topics.length, paused: topics.filter((topic) => topic.plan.paused).length };
        }
        if (!isStubService(services.projectTrust)) out.projectSettings = services.projectTrust.state(roots.main.ref);
        if (!isStubService(services.hostRules)) out.hostRules = { count: services.hostRules.applied().length };
      } catch (err) {
        log.error('agent status unavailable', { error: err instanceof Error ? err.name : 'unknown' });
      }
      return out;
    };

    const daemon: Daemon = {
      ctx,
      config,
      workspaceId: config.workspaceId,
      daemonPublicKey: identity.keyPair.publicKey.slice(),
      fingerprint,
      get hostInviteUrl() {
        return hostInviteUrl;
      },
      upgraded,
      putBack: upgraded.length > 0 && reading.putBack,
      internals: { hub, channelServer, members, invites, links, identityKeys, store, folder: reading },

      async start(): Promise<void> {
        if (started || stopped) return;
        started = true;
        try {
          await startAll();
        } catch (err) {
          // Half-started (keep-awake child, timers, modules): undo everything before reporting the failure.
          log.error('daemon start failed', {
            error: err instanceof Error ? err.name : 'unknown',
            ...(err instanceof StateFileError ? { kind: err.kind, file: err.path, reason: err.message } : {}),
          });
          await daemon.stop('start-failed');
          throw err;
        }
      },

      async stop(reason = 'stopped'): Promise<void> {
        if (stopped) return;
        stopped = true;
        await stopAll(reason);
      },

      updateRelayToken(token: string): void {
        for (const link of links.values()) link.setToken(token);
      },

      status(): DaemonStatus {
        return {
          workspaceId: config.workspaceId,
          started,
          stopped,
          relay: { interactive: links.get('interactive')?.state ?? 'none', transfer: links.get('transfer')?.state ?? 'none' },
          connections: hub.connections().length,
          onlineMembers: hub.onlineUserIds().size,
          power: power.status(),
          handshakes: { ...channelServer.stats },
          fingerprint,
          relayUrl: config.relayUrl,
          switches: { attributeBashEdits: config.activity.attributeBashEdits },
          isGitRepo: workspace.info.isGitRepo,
          ...agentStatus(),
        };
      },
    };
    daemonRef = daemon;
    return daemon;
  } catch (err) {
    // Nothing was started yet; release what is open so a failed composition leaves no handle behind. The host's
    // terminal points at the log for the reason: at least which error it was.
    log.error('daemon composition failed', { error: err instanceof Error ? err.name : 'unknown', reason: err instanceof StateFileError ? err.message : errnoCodeOf(err) });
    await audit.close().catch(() => {});
    await shareLock.release();
    throw err;
  }
}
