// TEST ONLY. The harness every daemon engineer uses:
//
//   const t = await createTestDaemon({ modules: [filesModule] });
//   const amy = await t.connect({ userId: 'dev:amy', role: 'editor' });   // real invite + real Noise handshake
//   const { entries } = await amy.conn.request('file.tree', { root: MAIN_ROOT, path: '' });
//   await t.cleanup();                                                     // clients, daemon, temp dirs
//
// The daemon runs with a temp state dir, a temp shared folder (optionally a git repo), the in-memory relay and a
// test identity issuer (EdDSA tokens verified by the daemon exactly like the relay's). Clients are the REAL client
// SDK (Connection / TransferConnection) with in-memory device keys and pins.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseInviteUrl, type GuestRole, type HostSettings, type Role, type Welcome } from '@smurg/protocol';
import {
  Connection,
  TransferConnection,
  createMemoryDeviceKeyProvider,
  createMemoryPinStore,
  type ConnectionOptions,
  type TransferConnectionOptions,
} from '@smurg/protocol/client';
import { DEFAULT_FEATURE_MODULES, createDaemon, type Daemon } from '../daemon.ts';
import type { AgentsConfig, LimitsConfig, SessionLaunchConfig, TimingConfig } from '../core/config.ts';
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import type { PowerService } from '../core/interfaces.ts';
import { ShiftableClock, type Clock } from '../core/lifecycle.ts';
import { silentLogger, type Logger } from '../core/logger.ts';
import { SYSTEM_PRINCIPAL } from '../core/permissions.ts';
import { MEMORY_RELAY_ORIGIN, MemoryRelay, TestIdentityIssuer, type RelayUser } from './memory-relay.ts';
import { createTempDir, createTempProject, createTempRunDir, removeTempDir, removeTempRunDir, type TempProjectOptions } from './temp.ts';

export const TEST_HOST_USER = 'dev:host';
export const TEST_HOST_NAME = 'Host';

export interface TestDaemonOptions {
  /** An existing folder to share; default: a fresh temp project (see `project`). */
  readonly root?: string;
  /**
   * The daemon's state dir, owned (and removed) by the caller; its sockets are then in `<stateDir>/run`, as in
   * production, where `smurg status / attach / stop` look for them (SMURG_HOME = stateDir). It must be short
   * (createTempRunDir()). Default: a temp dir, with the sockets in a separate short run dir.
   */
  readonly stateDir?: string;
  /** Files / git for the default temp project. */
  readonly project?: TempProjectOptions;
  readonly settings?: Partial<HostSettings>;
  readonly modules?: readonly FeatureModule[];
  /** Default: real time with an offset tests can advance (ShiftableClock). */
  readonly clock?: Clock;
  readonly timing?: Partial<TimingConfig>;
  readonly limits?: Partial<LimitsConfig>;
  /**
   * The agent runtime's limits and timers (`ctx.config.agents`). A test of anything that waits (escalation of a
   * question, a permission request or a report; parking) sets `escalationSweepMs` (and what else it needs) small and
   * moves time with `t.advanceClock(...)`: modules compare with `ctx.clock.now()` and look again on a real timer.
   */
  readonly agents?: Partial<AgentsConfig>;
  /**
   * Session launch inputs (claudePath, selfCommand, version policy). `hostHome` defaults to the test's
   * fake home, never the developer's.
   *
   * Without `selfCommand` (the default) no agent session can start (`session.hooks.notConfigured`, before `claude` is
   * even looked for). A test that passes `selfCommand` with the production sessions module MUST name its `claude`
   * too: `claudePath` of the stand-in (installFakeClaude) or of the real binary under test with the fake API.
   * createTestDaemon refuses the combination that would look on PATH and find the developer's own Claude Code.
   */
  readonly sessions?: Partial<SessionLaunchConfig>;
  readonly log?: Logger;
  readonly power?: PowerService;
  readonly workspaceId?: string;
}

export interface ConnectTestClientOptions {
  readonly userId: string;
  readonly displayName?: string;
  /** Role of the invite (host: the host's own invite, bound to the host user). Default 'editor'. */
  readonly role?: Role;
  /** Use this invite URL instead of creating one. */
  readonly inviteUrl?: string;
  /** Wait until online (default true). */
  readonly waitOnline?: boolean;
  readonly connection?: Partial<Omit<ConnectionOptions, 'relay' | 'workspaceId' | 'deviceKeys' | 'pins'>>;
}

/** One person's device: login, device key and pins survive across Connection instances. */
export interface TestDevice {
  readonly user: RelayUser;
  readonly api: ReturnType<MemoryRelay['apiFor']>;
  readonly deviceKeys: ReturnType<typeof createMemoryDeviceKeyProvider>;
  readonly pins: ReturnType<typeof createMemoryPinStore>;
}

export interface TestClient {
  readonly userId: string;
  readonly device: TestDevice;
  readonly conn: Connection;
  readonly welcome: Welcome | null;
  /** A new interactive Connection from the same device (device mode unless `inviteUrl` is given). */
  reconnect(options?: { readonly inviteUrl?: string; readonly waitOnline?: boolean; readonly connection?: ConnectTestClientOptions['connection'] }): Promise<TestClient>;
  /** The transfer socket of the same device (device mode). */
  transfer(options?: Partial<Omit<TransferConnectionOptions, 'relay' | 'workspaceId' | 'deviceKeys' | 'pins'>>): Promise<TransferConnection>;
  close(): void;
}

export interface TestDaemon {
  readonly daemon: Daemon;
  readonly ctx: DaemonContext;
  readonly relay: MemoryRelay;
  readonly issuer: TestIdentityIssuer;
  readonly clock: Clock;
  readonly root: string;
  readonly stateDir: string;
  /** Short dir for the daemon's Unix sockets (config.runDir). */
  readonly runDir: string;
  readonly workspaceId: string;
  readonly hostUserId: string;
  /** Moves the daemon's (and the token issuer's) time forward; only with the default ShiftableClock. */
  advanceClock(ms: number): void;
  /** A fresh invite link (created as the system, i.e. without going through admin handlers). */
  createInvite(role: GuestRole, options?: { readonly maxUses?: number; readonly expiresInSec?: number }): string;
  connect(options: ConnectTestClientOptions): Promise<TestClient>;
  /** Connect the host with their own invite. */
  connectHost(options?: Omit<ConnectTestClientOptions, 'userId' | 'role'>): Promise<TestClient>;
  cleanup(): Promise<void>;
}

/** A real client SDK Connection that joined `daemon` through a real invite and Noise handshake. */
export function connectTestClient(daemon: TestDaemon, options: ConnectTestClientOptions): Promise<TestClient> {
  return daemon.connect(options);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The production sessions module (the one of DEFAULT_FEATURE_MODULES): it has no launch seam but the config. */
const PRODUCTION_SESSIONS_MODULE = DEFAULT_FEATURE_MODULES.find((module) => module.name === 'sessions');

export async function createTestDaemon(options: TestDaemonOptions = {}): Promise<TestDaemon> {
  // No test starts the machine's real `claude` with the developer's login: with the production sessions module a
  // null `claudePath` means "the first claude on PATH".
  if (
    (options.sessions?.selfCommand ?? null) !== null &&
    (options.sessions?.claudePath ?? null) === null &&
    (options.modules ?? DEFAULT_FEATURE_MODULES).some((module) => module === PRODUCTION_SESSIONS_MODULE)
  ) {
    throw new Error('createTestDaemon: sessions.selfCommand without sessions.claudePath would start the first `claude` on PATH (the developer\'s own). Pass the stand-in: sessions.claudePath = (await installFakeClaude(dir)).path');
  }
  const base = await createTempDir('daemon');
  const clients: TestClient[] = [];
  let runDir: string | null = null;
  try {
    const stateDir = options.stateDir ?? join(base, 'state');
    runDir = options.stateDir ? join(options.stateDir, 'run') : await createTempRunDir();
    const root = options.root ?? (await createTempProject(base, 'project', options.project ?? {}));
    const workspaceId = options.workspaceId ?? `ws_test_${randomBytes(9).toString('base64url')}`;
    const clock = options.clock ?? new ShiftableClock();
    const relay = new MemoryRelay(workspaceId);
    const issuer = new TestIdentityIssuer(MEMORY_RELAY_ORIGIN, generateKeyPairSync('ed25519'), clock);
    const daemon = await createDaemon({
      config: {
        stateDir,
        runDir,
        shareDir: root,
        workspaceId,
        hostUserId: TEST_HOST_USER,
        hostName: TEST_HOST_NAME,
        relayUrl: MEMORY_RELAY_ORIGIN,
        webOrigin: MEMORY_RELAY_ORIGIN,
        keepAwake: false,
        ...(options.settings ? { defaultSettings: options.settings } : {}),
        ...(options.timing ? { timing: options.timing } : {}),
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.agents ? { agents: options.agents } : {}),
        ...(options.sessions ? { sessions: options.sessions } : {}),
      },
      relay: { token: 'test-host-token', socketFactory: relay.hostSocketFactory() },
      identityKeys: {
        get: (kid) => (kid === issuer.kid ? issuer.publicKey : null),
        refresh: async () => {},
      },
      ...(options.modules ? { modules: options.modules } : {}),
      clock,
      log: options.log ?? silentLogger,
      homeDir: join(base, 'home'),
      ...(options.power ? { power: options.power } : {}),
      random: () => 0.5,
    });
    await daemon.start();
    await waitUntil(() => relay.hostOnline('ws') && relay.hostOnline('xfer'), 5_000, 'the daemon to reach the in-memory relay');

    const newDevice = (user: RelayUser): TestDevice => ({
      user,
      api: relay.apiFor(user, issuer),
      deviceKeys: createMemoryDeviceKeyProvider(),
      pins: createMemoryPinStore(),
    });

    const open = async (
      device: TestDevice,
      inviteUrl: string | null,
      waitOnline: boolean,
      extra: ConnectTestClientOptions['connection'] = {},
    ): Promise<TestClient> => {
      const invite = inviteUrl ? parseInviteUrl(inviteUrl) : null;
      const conn = new Connection({
        relay: device.api,
        workspaceId,
        deviceKeys: device.deviceKeys,
        pins: device.pins,
        invite: invite ? { fingerprint: invite.fingerprint, secret: invite.secret } : null,
        clientKind: 'web',
        deviceName: 'Test client',
        random: () => 0.5,
        backoff: { baseMs: 20, maxMs: 200 },
        ...extra,
      });
      conn.start();
      const welcome = waitOnline ? await conn.whenOnline({ timeoutMs: 10_000 }) : null;
      const client: TestClient = {
        userId: device.user.userId,
        device,
        conn,
        welcome,
        reconnect: (more = {}) => open(device, more.inviteUrl ?? null, more.waitOnline ?? true, more.connection),
        transfer: async (more = {}) => {
          const transfer = new TransferConnection({
            relay: device.api,
            workspaceId,
            deviceKeys: device.deviceKeys,
            pins: device.pins,
            clientKind: 'web',
            deviceName: 'Test transfer',
            random: () => 0.5,
            backoff: { baseMs: 20, maxMs: 200 },
            ...more,
          });
          transfer.start();
          await transfer.whenOnline({ timeoutMs: 10_000 });
          clients.push({ ...client, close: () => transfer.close() });
          return transfer;
        },
        close: () => conn.close(),
      };
      clients.push(client);
      return client;
    };

    const harness: TestDaemon = {
      daemon,
      ctx: daemon.ctx,
      relay,
      issuer,
      clock,
      root,
      stateDir,
      runDir,
      workspaceId,
      hostUserId: TEST_HOST_USER,
      advanceClock: (ms) => {
        if (!(clock instanceof ShiftableClock)) throw new Error('advanceClock needs the default ShiftableClock');
        clock.advance(ms);
      },
      createInvite: (role, more = {}) => daemon.ctx.invites.create({ role, maxUses: more.maxUses ?? 1, ...(more.expiresInSec ? { expiresInSec: more.expiresInSec } : {}) }, SYSTEM_PRINCIPAL).url,
      connect: async (connectOptions) => {
        const role = connectOptions.role ?? 'editor';
        const user: RelayUser = { userId: connectOptions.userId, displayName: connectOptions.displayName ?? connectOptions.userId.slice(connectOptions.userId.indexOf(':') + 1) };
        const inviteUrl =
          connectOptions.inviteUrl ??
          (role === 'host' ? daemon.internals.invites.createHostInvite().url : harness.createInvite(role as GuestRole));
        return open(newDevice(user), inviteUrl, connectOptions.waitOnline ?? true, connectOptions.connection);
      },
      connectHost: (more = {}) => harness.connect({ ...more, userId: TEST_HOST_USER, displayName: TEST_HOST_NAME, role: 'host' }),
      cleanup: async () => {
        for (const client of clients) {
          try {
            client.close();
          } catch {
            // already closed
          }
        }
        await daemon.stop();
        await removeTempDir(base);
        if (!options.stateDir) await removeTempRunDir(runDir as string);
      },
    };
    return harness;
  } catch (err) {
    await removeTempDir(base).catch(() => {});
    if (runDir !== null && !options.stateDir) await removeTempRunDir(runDir).catch(() => {});
    throw err;
  }
}
