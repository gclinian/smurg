// The composition root (ARCHITECTURE §7.2): builds the DaemonContext, fills every feature service slot (a module's
// implementation or a stub), registers handlers, and owns the lifecycle.
//
//   const daemon = await createDaemon({ config, relay: { token }, modules: DEFAULT_FEATURE_MODULES });
//   await daemon.start();                 // keep-awake, identity keys, modules, host invite, relay links
//   console.log(daemon.hostInviteUrl);
//   await daemon.stop();                  // channel.closed{stopped} → relay links closed → modules stopped (reverse)
//                                         // → handlers disposed → keep-awake released → logs flushed
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SmurgError, daemonKeyFingerprint, formatFingerprintForDisplay, shortTextSchema, type ChannelPurpose, type NoiseSuite, type Welcome, type WorkspaceInfo } from '@smurg/protocol';
import { ensurePrivateDirectory, loadOrCreateDaemonIdentity, nodeCryptoSuite } from '@smurg/protocol/node';
import { relayHttpUrl, wsHostUrl, xferHostUrl } from '@smurg/protocol/relay';
import { registerAdminHandlers } from './admin/handlers.ts';
import { InviteServiceImpl } from './admin/invites.ts';
import { MemberDirectoryImpl } from './admin/members.ts';
import { SettingsServiceImpl } from './admin/settings.ts';
import { docsModule } from './docs/module.ts';
import { filesModule } from './files/module.ts';
import { hooksModule } from './hooks/module.ts';
import { localControlModule } from './local/module.ts';
import { locksModule } from './locks/module.ts';
import { sandboxModule } from './sandbox/module.ts';
import { sessionsModule } from './sessions/module.ts';
import { suggestModule } from './suggest/module.ts';
import { worktreeModule } from './worktree/module.ts';
import daemonPackage from '../package.json' with { type: 'json' };
import { JsonlAuditLog } from './core/audit.ts';
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
import { RouterImpl } from './core/router.ts';
import { FileStateStore } from './core/state-store.ts';
import { createStubService } from './core/stubs.ts';
import { STATE_DOCUMENT, initialWorkspaceState, workspaceStateSchema } from './core/workspace-state.ts';
import { ChannelServer } from './net/channel-server.ts';
import { wsHostSocketFactory, type HostSocketFactory } from './net/host-socket.ts';
import { IdentityVerifier, jwksKeySource, staticKeySource, type IdentityKeySource } from './net/identity.ts';
import { LocalChannel } from './local/local-channel.ts';
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
 * `modules`). Every area is listed already: its owner replaces the body of `src/<area>/module.ts` and never edits
 * this list. Tests that want a subset pass modules to createTestDaemon directly.
 *
 * Order. create() runs in this order but may not call other services, so the order matters for the rest:
 * register() and start() run in this order, stop() in reverse (after every channel was closed with `stopped`), and
 * bus listeners fire in registration order. Providers others depend on come first, so they are up before their users
 * start and still up while their users stop:
 *  - locks (LockManager, presence, activity): in-memory state that hooks, files, docs and sessions consult; its
 *    kick / leave listeners drop human locks before later modules react to the same event;
 *  - sandbox: preflight before any guest process can be wrapped;
 *  - hooks: the hook socket listens before any session starts, and closes only after sessions are gone, so a dying
 *    session's Stop / SessionEnd hooks are still answered (and its agent locks released);
 *  - files (watcher, uploads, downloads), then docs: docs builds on file events and flushes dirty documents in its
 *    stop() while the watcher is still running;
 *  - worktree: kept worktrees are registered as roots before a session may be started in one;
 *  - sessions: after everything it launches with; its stop() (end every session, remove guest dirs) runs before
 *    worktree, hooks, sandbox and locks stop;
 *  - suggest: accept pastes into a session, so it stops (no more pastes) before sessions do;
 *  - local: the control socket opens last (a local `smurg attach` never sees a half-started daemon). Its module stops
 *    first, but the socket itself closes only when the registrations are disposed (after every module stopped), so
 *    `smurg stop` sees it go when the daemon is done (it answers status with stopped: true meanwhile).
 */
export const DEFAULT_FEATURE_MODULES: readonly FeatureModule[] = Object.freeze([
  locksModule,
  sandboxModule,
  hooksModule,
  filesModule,
  docsModule,
  worktreeModule,
  sessionsModule,
  suggestModule,
  localControlModule,
]);

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
   * config.sessions.hostHome (the region guest sandboxes may not read). Tests pass a temporary fake home.
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
   * at once when the relay refused the old one (link state 'auth-rejected', bus event 'relay.link'; review REL-08).
   */
  updateRelayToken(token: string): void;
  /** For the testing harness and the local control socket. */
  readonly internals: {
    readonly hub: HubImpl;
    readonly channelServer: ChannelServer;
    readonly members: MemberDirectoryImpl;
    readonly invites: InviteServiceImpl;
    readonly links: ReadonlyMap<ChannelPurpose, RelayLink>;
    readonly identityKeys: IdentityKeySource;
    /** `store.unsaved()`: state documents the disk currently refuses (review REL-14). */
    readonly store: FileStateStore;
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
  // The platform decides per-platform defaults (config.sessions.guestMainWorkspace: off on Linux, §11 D-14).
  const config = resolveConfig(
    {
      ...options.config,
      sessions: { ...options.config.sessions, hostHome: options.config.sessions?.hostHome ?? options.homeDir ?? homedir() },
    },
    { platform },
  );
  const clock = options.clock ?? systemClock;
  const log = options.log ?? createLineLogger();

  // ~/.smurg must be private: refuse (never chmod) a directory other users can read.
  await ensurePrivateDirectory(config.stateDir);
  // The sockets (control, hook) live here; a group/other-accessible run dir is refused like the state dir.
  await ensurePrivateDirectory(config.runDir);
  const share = await prepareShare(config.shareDir, config.stateDir, options.homeDir === undefined ? {} : { homeDir: options.homeDir });
  // One daemon per folder, whatever state dir or relay the other one uses (review CLI-05). Held until stop().
  const shareLock = await acquireShareLock({ shareRealPath: share.realPath, runDir: config.runDir, workspaceId: config.workspaceId });
  let store: FileStateStore;
  let identity: Awaited<ReturnType<typeof loadOrCreateDaemonIdentity>>;
  let state: Awaited<ReturnType<typeof store.coreDocument<typeof workspaceStateSchema>>>;
  let audit: JsonlAuditLog;
  try {
    store = await FileStateStore.open(config.workspaceStateDir, log.child({ module: 'state' }));
    identity = await loadOrCreateDaemonIdentity(config.workspaceStateDir);
    state = await store.coreDocument(STATE_DOCUMENT, workspaceStateSchema, () => initialWorkspaceState(config.workspaceId, config.defaultSettings));
    if (state.get().workspaceId !== config.workspaceId) throw new Error('state.json belongs to another workspace');
    audit = await JsonlAuditLog.open(join(config.workspaceStateDir, 'audit.jsonl'), {
      clock,
      log: log.child({ module: 'audit' }),
      pageMax: config.limits.auditPageMax,
      maxBytes: config.limits.auditMaxBytes,
      deniedPerActorPerMinute: config.limits.auditDeniedPerActorPerMinute,
    });
  } catch (err) {
    await shareLock.release();
    throw err;
  }
  try {
    const bus = new TypedEventBus(log.child({ module: 'bus' }));
    // A state document the disk refuses (and its recovery) reaches the host's terminal through the bus.
    const stateHealth = store.onHealthChange((event) => bus.emit('state.write', event));
    const roots = await RootRegistryImpl.create(share.realPath, state, clock);
    const paths = new PathGuardImpl({ roots, audit, platform });
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
    // (admission). Without it the guest-dir retention (§11 D-9: not connected for 7 days) removed the dir of a member
    // who had stayed connected for more than 7 days whenever one of their reconnects coincided with the sweep
    // (finish-gate, 2026-09-29: a relay-link blip is enough).
    const lastSeen = bus.on('conn.closed', ({ conn }) => members.touch(conn.userId, conn.deviceId, clock.now()));
    const router = new RouterImpl({ sink: hub, members, audit, log: log.child({ module: 'router' }) });
    hub.setRouter(router);
    const settings = new SettingsServiceImpl({
      state,
      audit,
      bus,
      mainRealPath: roots.main.realPath,
      guestSubscriptionLogin: config.sessions.guestSubscriptionLogin,
      guestMainWorkspace: config.sessions.guestMainWorkspace,
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

    const services = {} as { -readonly [K in FeatureServiceName]: FeatureServices[K] };
    for (const name of FEATURE_SERVICE_NAMES) (services as Record<FeatureServiceName, unknown>)[name] = createStubService(name);
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
      services,
      stopping: stopping.signal,
      lifecycle,
    });

    const modules = options.modules ?? DEFAULT_FEATURE_MODULES;
    const names = new Set<string>();
    const provided = new Map<FeatureServiceName, string>();
    for (const module of modules) {
      if (names.has(module.name)) throw new Error(`feature module ${module.name} is listed twice`);
      names.add(module.name);
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
      // a demotion, a revoked invite would be undone), so say so loudly (review REL-14).
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

    /** The host's own machine, through the control socket: same hub, router and audit as a relay client. */
    const attachLocal = (input: LocalAttachInput): LocalAttachment => {
      if (!started || stopped) throw new SmurgError('unauthorized', undefined, { reason: 'not-running' });
      const member = members.active(input.userId);
      if (input.userId !== config.hostUserId || member?.role !== 'host') {
        audit.record({ actor: SYSTEM_ACTOR, action: 'auth.rejected', outcome: 'denied', target: input.userId, detail: { reason: 'local-not-host', mode: 'local' } });
        throw new SmurgError('forbidden', undefined, { reason: 'local-not-host' });
      }
      const admission = hub.prepareAdmission({ purpose: 'interactive', userId: member.userId, deviceId: LOCAL_DEVICE_ID, resume: input.resume });
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
        detail: { mode: 'local', purpose: 'interactive', resumed: admission.resumed, clientKind: 'cli' },
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

    const daemon: Daemon = {
      ctx,
      config,
      workspaceId: config.workspaceId,
      daemonPublicKey: identity.keyPair.publicKey.slice(),
      fingerprint,
      get hostInviteUrl() {
        return hostInviteUrl;
      },
      internals: { hub, channelServer, members, invites, links, identityKeys, store },

      async start(): Promise<void> {
        if (started || stopped) return;
        started = true;
        try {
          await startAll();
        } catch (err) {
          // Half-started (keep-awake child, timers, modules): undo everything before reporting the failure.
          log.error('daemon start failed', { error: err instanceof Error ? err.name : 'unknown' });
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
        };
      },
    };
    daemonRef = daemon;
    return daemon;
  } catch (err) {
    // Nothing was started yet; release what is open so a failed composition leaves no handle behind.
    await audit.close().catch(() => {});
    await shareLock.release();
    throw err;
  }
}
