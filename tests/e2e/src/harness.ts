// The acceptance-test stack (ARCHITECTURE §10): the REAL relay (local workerd through @smurg/relay/testing, with the
// R3 byte tap), the REAL daemon (createDaemon with the production host sockets, JWKS verification of the relay's
// identity tokens, node:crypto Noise suite) and REAL headless clients (the client SDK's Connection over Node's
// WebSocket, bearer dev login, the browser's noble suite).
//
//   const stack = await startStack({ projectFiles: { 'README.md': '# hi' } });
//   const amy = await stack.join({ name: 'amy', role: 'editor' });   // real invite (made by the host over E2E)
//   await amy.conn.request('lock.list', {});
//   stack.pauseHost();                                                // the host's laptop goes to sleep
//   await stack.stop();                                               // clients, daemon, relay (if owned), temp dirs
//
// Everything a stack starts is stopped by stop(), in reverse order; nothing touches ~/.smurg (the state dir is a
// temp directory) and no process is spawned (workerd belongs to wrangler's harness, which stop() closes).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createDaemon, DEFAULT_FEATURE_MODULES, silentLogger, type Daemon, type FeatureModule, type LimitsConfig, type Logger, type SessionLaunchConfig, type TimingConfig } from '@smurg/daemon';
import { createTempRunDir, isolatedGitEnv, removeTempRunDir } from '@smurg/daemon/testing';
import { parseInviteUrl, type AuditEntry, type GuestRole, type HostSettings, type Welcome } from '@smurg/protocol';
import {
  Connection,
  RelayApi,
  TransferConnection,
  createMemoryDeviceKeyProvider,
  createMemoryPinStore,
  waitForState,
  type ConnectionOptions,
  type ConnectionState,
  type TransferConnectionOptions,
} from '@smurg/protocol/client';
import { startLocalRelay, type DevSession, type LocalRelay, type RelayTap } from '@smurg/relay/testing';
import { HostLinkGate } from './host-link.ts';
import { createTempDir, removeTempDir, writeTree, type ProjectEntry } from './temp.ts';
import { WireLog, recordingWebSocket } from './wire.ts';

export const HOST_LOGIN = 'host';
export const HOST_DISPLAY_NAME = 'Host';

/** Reconnect backoff for test clients: production shape, shorter delays so rejection paths finish quickly. */
export const TEST_BACKOFF = Object.freeze({ baseMs: 100, maxMs: 2_000 });

export interface StackOptions {
  /** Files of the shared folder: relative path → content, or `{ symlink: target }`. */
  readonly projectFiles?: Readonly<Record<string, ProjectEntry>>;
  /** Files in a sibling folder that is NOT shared (targets for escape attempts), available as `stack.outside`. */
  readonly outsideFiles?: Readonly<Record<string, ProjectEntry>>;
  /**
   * Make the shared folder a git repository (R9 worktrees): `git init -b main`, add and commit `projectFiles`, with an
   * isolated HOME and no global/system git config (the developer's git settings are never read or written).
   */
  readonly git?: boolean;
  readonly settings?: Partial<HostSettings>;
  /** Reuse a relay started by the test file (not stopped by stop()). Default: a relay of its own. */
  readonly relay?: LocalRelay;
  /** Only for a relay of its own: record every frame (default true). */
  readonly tap?: boolean;
  /** Default: DEFAULT_FEATURE_MODULES, i.e. exactly what production composes. */
  readonly modules?: readonly FeatureModule[];
  readonly timing?: Partial<TimingConfig>;
  readonly limits?: Partial<LimitsConfig>;
  /** Session launch inputs (selfCommand, claudePath, testGuestEnv, …); hostHome is always the stack's fake home. */
  readonly sessions?: Partial<Omit<SessionLaunchConfig, 'hostHome'>>;
  /** Daemon logger (default silent). */
  readonly log?: Logger;
}

/** One person's device: a relay login, a device key and a pin store that survive across Connection instances. */
export interface StackDevice {
  readonly name: string;
  readonly session: DevSession;
  readonly api: RelayApi;
  readonly deviceKeys: ReturnType<typeof createMemoryDeviceKeyProvider>;
  readonly pins: ReturnType<typeof createMemoryPinStore>;
}

export interface StateRecord {
  readonly at: number;
  readonly state: ConnectionState;
}

export interface StackClient {
  readonly name: string;
  readonly userId: string;
  readonly device: StackDevice;
  readonly conn: Connection;
  /** Every state the connection went through, with Date.now(). */
  readonly states: readonly StateRecord[];
  readonly welcome: Welcome | null;
  /** Resolves with the first (current or future) state that matches; rejects on another terminal state. */
  waitFor(predicate: (state: ConnectionState) => boolean, timeoutMs?: number): Promise<ConnectionState>;
  /** A new Connection from the same device (key + pins). */
  reconnect(options?: Omit<JoinOptions, 'name' | 'device' | 'role'>): Promise<StackClient>;
  /** The transfer socket of this device (device mode, TransferDO). */
  transfer(options?: Partial<TransferConnectionOptions>): Promise<TransferConnection>;
  close(): void;
}

export interface JoinOptions {
  /** Dev login name (`dev:<name>`); letters, digits, `._-`. */
  readonly name: string;
  /** Role of the fresh invite the host creates (default 'editor'); ignored when `invite` is given. */
  readonly role?: GuestRole;
  /** Use this invite link instead of a fresh one; null: no invite at all (a device that relies on its pin). */
  readonly invite?: string | null;
  /** An existing device (same key and pins), e.g. to come back after a kick. */
  readonly device?: StackDevice;
  /** Wait until online (default true). With false the client is returned as soon as it started. */
  readonly waitOnline?: boolean;
  /** Extra Connection options (preferInvite, suite, clientKind, …). */
  readonly connection?: Partial<Omit<ConnectionOptions, 'relay' | 'workspaceId' | 'deviceKeys' | 'pins' | 'invite'>>;
}

export interface Stack {
  readonly relay: LocalRelay;
  readonly tap: RelayTap | undefined;
  readonly daemon: Daemon;
  readonly workspaceId: string;
  /** Realpath of the shared folder. */
  readonly root: string;
  /** Realpath of a sibling folder that is not shared. */
  readonly outside: string;
  readonly stateDir: string;
  /** A fake home of the host (config.sessions.hostHome): tests never point the daemon at the developer's home. */
  readonly homeDir: string;
  /** Short directory of the daemon's Unix sockets (config.runDir; socket paths must fit 103 bytes). */
  readonly runDir: string;
  readonly host: DevSession;
  /** The host, joined with their own single-use invite over the real relay (admin requests go through it). */
  readonly hostClient: StackClient;
  /** Every invite link issued in this stack so far (the host's own first): they carry secrets the relay must never see. */
  readonly invitesIssued: readonly string[];
  /** Frames the daemon's host sockets and every client socket sent / received. */
  readonly wire: WireLog;
  readonly hostLink: HostLinkGate;
  /** Dev login (cached per name). */
  login(name: string): Promise<DevSession>;
  /** A fresh device for `name` (new key, empty pins). */
  newDevice(name: string): Promise<StackDevice>;
  /** A fresh invite made by the host through `admin.invite.create` (the real E2E path). */
  createInvite(role: GuestRole, options?: { readonly maxUses?: number; readonly expiresInSec?: number }): Promise<string>;
  join(options: JoinOptions): Promise<StackClient>;
  /** The daemon's audit log (flushed first), newest first. */
  audit(limit?: number): Promise<AuditEntry[]>;
  /** The host's laptop goes to sleep: the daemon stops sending and answering, its sockets stay open. */
  pauseHost(): void;
  resumeHost(): void;
  stop(): Promise<void>;
}

function randomWorkspaceId(): string {
  return `ws_e2e_${randomBytes(12).toString('base64url')}`;
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const cleanups: (() => Promise<void> | void)[] = [];
  const runCleanups = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'stack cleanup failed');
  };

  try {
    const base = await createTempDir('stack');
    cleanups.push(() => removeTempDir(base));
    const root = join(base, 'project');
    const outside = join(base, 'outside');
    const stateDir = join(base, 'state');
    const homeDir = join(base, 'home');
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    const runDir = await createTempRunDir();
    cleanups.push(() => removeTempRunDir(runDir));
    await writeTree(root, options.projectFiles ?? { 'README.md': '# e2e\n' });
    await writeTree(outside, options.outsideFiles ?? { 'secret.txt': 'outside the share\n' });
    if (options.git) await initGitRepo(root, join(base, '.git-home'));

    let relay: LocalRelay;
    if (options.relay) {
      relay = options.relay;
    } else {
      relay = await startLocalRelay({ tap: options.tap ?? true });
      cleanups.push(() => relay.stop());
    }

    const sessions = new Map<string, Promise<DevSession>>();
    const login = (name: string): Promise<DevSession> => {
      let session = sessions.get(name);
      if (!session) {
        session = relay.devLogin(name, { displayName: name === HOST_LOGIN ? HOST_DISPLAY_NAME : name.charAt(0).toUpperCase() + name.slice(1) });
        sessions.set(name, session);
      }
      return session;
    };

    const host = await login(HOST_LOGIN);
    const workspaceId = await relay.createWorkspace(host.token, randomWorkspaceId());
    const wire = new WireLog();
    const hostLink = new HostLinkGate(wire);

    const daemon = await createDaemon({
      config: {
        stateDir,
        runDir,
        shareDir: root,
        workspaceId,
        hostUserId: host.userId,
        hostName: host.displayName,
        relayUrl: relay.origin,
        webOrigin: relay.origin,
        // caffeinate would keep the developer's machine awake; keep-awake is not what these tests measure.
        keepAwake: false,
        ...(options.settings ? { defaultSettings: options.settings } : {}),
        ...(options.timing ? { timing: options.timing } : {}),
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.sessions ? { sessions: options.sessions } : {}),
      },
      relay: { token: host.token, socketFactory: hostLink.factory },
      homeDir,
      modules: options.modules ?? DEFAULT_FEATURE_MODULES,
      log: options.log ?? silentLogger,
    });
    cleanups.push(() => daemon.stop('test-stopped'));
    // A paused host is woken up before it is stopped, so its sockets really close.
    cleanups.push(() => hostLink.resume());
    await daemon.start();
    await waitUntil(async () => {
      const [ws, xfer] = await Promise.all([relay.inspect('ws', workspaceId), relay.inspect('xfer', workspaceId)]);
      return ws.hostStatus === 'online' && xfer.hostStatus === 'online';
    }, 15_000, 'the daemon to be online at the relay (ws and xfer)');

    const clients: { close(): void }[] = [];
    cleanups.push(() => {
      for (const client of clients.splice(0)) {
        try {
          client.close();
        } catch {
          // already closed
        }
      }
    });

    const newDevice = async (name: string): Promise<StackDevice> => {
      const session = await login(name);
      return {
        name,
        session,
        api: new RelayApi({ relayUrl: relay.origin, auth: { kind: 'bearer', token: session.token }, WebSocket: recordingWebSocket(wire, name) }),
        deviceKeys: createMemoryDeviceKeyProvider(),
        pins: createMemoryPinStore(),
      };
    };

    const open = async (device: StackDevice, invite: string | null, waitOnline: boolean, extra: JoinOptions['connection'] = {}): Promise<StackClient> => {
      const parsed = invite === null ? null : parseInviteUrl(invite);
      const conn = new Connection({
        relay: device.api,
        workspaceId,
        deviceKeys: device.deviceKeys,
        pins: device.pins,
        invite: parsed ? { fingerprint: parsed.fingerprint, secret: parsed.secret } : null,
        clientKind: 'web',
        deviceName: `${device.name} e2e browser`,
        backoff: TEST_BACKOFF,
        ...extra,
      });
      const states: StateRecord[] = [{ at: Date.now(), state: conn.getState() }];
      conn.subscribe((state) => states.push({ at: Date.now(), state }));
      clients.push(conn);
      const client: StackClient = {
        name: device.name,
        userId: device.session.userId,
        device,
        conn,
        states,
        get welcome() {
          return conn.welcome;
        },
        waitFor: (predicate, timeoutMs = 15_000) => waitForState(conn, predicate, { timeoutMs }),
        reconnect: (more = {}) => open(device, more.invite === undefined ? null : more.invite, more.waitOnline ?? true, more.connection),
        transfer: async (more = {}) => {
          const transfer = new TransferConnection({
            relay: device.api,
            workspaceId,
            deviceKeys: device.deviceKeys,
            pins: device.pins,
            clientKind: 'web',
            deviceName: `${device.name} e2e transfer`,
            backoff: TEST_BACKOFF,
            ...more,
          });
          clients.push(transfer);
          transfer.start();
          await transfer.whenOnline({ timeoutMs: 15_000 });
          return transfer;
        },
        close: () => conn.close(),
      };
      conn.start();
      if (waitOnline) await conn.whenOnline({ timeoutMs: 15_000 });
      return client;
    };

    const hostInvite = daemon.hostInviteUrl;
    if (!hostInvite) throw new Error('the daemon did not create the host invite');
    const invitesIssued: string[] = [hostInvite];
    const hostClient = await open(await newDevice(HOST_LOGIN), hostInvite, true);

    const stack: Stack = {
      relay,
      tap: relay.tap,
      daemon,
      workspaceId,
      root: daemon.ctx.workspace.shareRealPath,
      outside,
      stateDir,
      homeDir,
      runDir,
      host,
      hostClient,
      invitesIssued,
      wire,
      hostLink,
      login,
      newDevice,
      async createInvite(role, more = {}) {
        const { url } = await hostClient.conn.request('admin.invite.create', {
          role,
          maxUses: more.maxUses ?? 1,
          ...(more.expiresInSec === undefined ? {} : { expiresInSec: more.expiresInSec }),
        });
        invitesIssued.push(url);
        return url;
      },
      async join(joinOptions) {
        const device = joinOptions.device ?? (await newDevice(joinOptions.name));
        const invite = joinOptions.invite !== undefined ? joinOptions.invite : await stack.createInvite(joinOptions.role ?? 'editor');
        return open(device, invite, joinOptions.waitOnline ?? true, joinOptions.connection);
      },
      audit: async (limit = 500) => {
        await daemon.ctx.audit.flush();
        return daemon.ctx.audit.query({ limit });
      },
      pauseHost: () => hostLink.pause(),
      resumeHost: () => hostLink.resume(),
      stop: runCleanups,
    };
    return stack;
  } catch (error) {
    await runCleanups().catch(() => undefined);
    throw error;
  }
}

const execFileAsync = promisify(execFile);

async function initGitRepo(dir: string, home: string): Promise<void> {
  await mkdir(home, { recursive: true });
  const env = isolatedGitEnv(home);
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  await execFileAsync('git', ['add', '-A'], { cwd: dir, env });
  await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'initial'], { cwd: dir, env });
}

/** Polls `check` every 50 ms until it holds; rejects after `timeoutMs`. */
export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
