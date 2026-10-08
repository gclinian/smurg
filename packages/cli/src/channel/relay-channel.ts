// Joining a workspace through the relay with the CLI's device key (SPEC R3; ARCHITECTURE §4, §4.2): the client SDK's
// Connection, with the device key in `<state>/device.key` and verified daemon keys pinned in `<state>/pins/` (both 0600
// in the 0700 state dir), node:crypto for the AEAD, and the relay bearer session. First contact needs the invite link
// (its `k` is checked against the daemon's key before anything is sent, and the key is pinned); later connections use
// the pinned key only. A different daemon key is never accepted silently: that is the relay-MITM warning of SPEC R3.
import type { PayloadInputOf, ResultOf, Welcome } from '@smurg/protocol';
import {
  Connection,
  staticDeviceKeyProvider,
  type ConnectionRelay,
  type ConnectionState,
  type EventHandler,
  type InteractiveEventType,
  type InteractiveNotifyType,
  type InteractiveRequestType,
  type InviteTrust,
  type PinStore,
  type RequestOptions,
} from '@smurg/protocol/client';
import { loadOrCreateCliDeviceKey, nodeCryptoSuite, pinDaemonKey, readPinnedDaemonKey } from '@smurg/protocol/node';
import { CliError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import { m, type MessageId, type Text } from '../i18n/index.ts';
import { stateProblem } from '../state/private-file.ts';
import { closedMessage, type ChannelEnd, type ChannelStatus, type WorkspaceChannel } from './channel.ts';

const ONLINE_TIMEOUT_MS = 30_000;
/**
 * The relay says at once when the host is not connected: joining gives up after this long in host-offline instead of
 * the whole online timeout. A host that is just reconnecting is back well within it.
 */
export const HOST_OFFLINE_GIVE_UP_MS = 5_000;

/** Pins as files under the state dir (hex file names: case-insensitive file systems, ARCHITECTURE §4.2). */
export function filePinStore(stateDir: string): PinStore {
  return {
    get: (workspaceId) => readPinnedDaemonKey(stateDir, workspaceId),
    pin: (workspaceId, key, options) => pinDaemonKey(stateDir, workspaceId, key, options ?? {}),
  };
}

const REJECTED: Readonly<Record<string, MessageId>> = {
  'invite-invalid': 'channel.rejected.inviteInvalid',
  'device-revoked': 'channel.rejected.deviceRevoked',
  'device-other-account': 'channel.rejected.deviceOtherAccount',
  'identity-invalid': 'channel.rejected.identityInvalid',
  kicked: 'channel.closed.kicked',
  version: 'channel.rejected.version',
  aborted: 'channel.rejected.aborted',
  unknown: 'channel.rejected.unknown',
};

const CLOSED: Readonly<Record<string, MessageId>> = {
  local: 'channel.closed.local',
  kicked: 'channel.closed.kicked',
  revoked: 'channel.closed.revoked',
  'login-required': 'channel.closed.loginRequired',
  'relay-refused': 'channel.closed.relayRefused',
  'no-trust': 'channel.closed.noTrust',
  'storage-error': 'channel.closed.storageError',
};

const lookup = (table: Readonly<Record<string, MessageId>>, key: string, otherwise: MessageId): Text => ({ id: Object.hasOwn(table, key) ? (table[key] as MessageId) : otherwise });

/** What a terminal connection state means for the person. */
export function describeTerminalState(state: ConnectionState): ChannelEnd {
  switch (state.kind) {
    case 'key-mismatch':
      // 'device': the pinned key (no new invite); the host may have started over with new workspace keys (HOSTING §5.1).
      return { reason: 'key-mismatch', message: m(state.mode === 'device' ? 'channel.keyMismatch.device' : 'channel.keyMismatch.invite') };
    case 'rejected':
      return { reason: 'rejected', message: lookup(REJECTED, state.reason, 'channel.rejected.unknown') };
    case 'closed': {
      const daemonReason = state.daemonReason;
      if (daemonReason !== undefined) return { reason: daemonReason === 'kicked' ? 'kicked' : 'closed', message: closedMessage(daemonReason) };
      return { reason: state.reason === 'kicked' ? 'kicked' : state.reason === 'revoked' ? 'revoked' : 'closed', message: lookup(CLOSED, state.reason, 'channel.closed.local') };
    }
    default:
      return { reason: 'closed', message: m('channel.closed.local') };
  }
}

export interface RelayChannelOptions {
  readonly relay: ConnectionRelay;
  readonly workspaceId: string;
  readonly stateDir: string;
  readonly invite: InviteTrust | null;
  /** The person accepted a fresh invite after a key-mismatch warning: the invite's key replaces the pin. */
  readonly preferInvite?: boolean;
  readonly deviceName: string;
  readonly onlineTimeoutMs?: number;
  readonly hostOfflineGiveUpMs?: number;
  /**
   * What to say after the host refused this command with `version` (the refusal names no side: the command looks up
   * whether a newer smurg is published, update/version-advice.ts). Never rejects. Absent: the text that names both sides.
   */
  readonly versionRefused?: () => Promise<Text>;
}

/** Rejects once `conn` has been host-offline for `ms` without a break; `stop()` ends the watch. */
function hostOfflineFor(conn: Connection, ms: number): { readonly gaveUp: Promise<never>; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail: (err: Error) => void = () => {};
  const gaveUp = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  gaveUp.catch(() => undefined);
  const unsubscribe = conn.subscribe((state) => {
    if (state.kind === 'host-offline') {
      timer ??= setTimeout(() => fail(new Error('host offline')), ms);
    } else if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  });
  return {
    gaveUp,
    stop: () => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export class RelayWorkspaceChannel implements WorkspaceChannel {
  readonly kind = 'relay' as const;
  readonly welcome: Welcome;
  private readonly conn: Connection;
  private readonly endListeners = new Set<(end: ChannelEnd) => void>();
  private readonly restartListeners = new Set<() => void>();
  private readonly statusListeners = new Set<(status: ChannelStatus) => void>();
  private ended: ChannelEnd | null = null;
  /** A `version` refusal is being worded (a lookup of at most a few seconds); the end is announced when it is. */
  private ending = false;
  private readonly versionRefused: (() => Promise<Text>) | undefined;

  private constructor(conn: Connection, welcome: Welcome, versionRefused: (() => Promise<Text>) | undefined) {
    this.conn = conn;
    this.welcome = welcome;
    this.versionRefused = versionRefused;
    let first = true;
    conn.onWelcome((_welcome, { resumed }) => {
      if (first) {
        first = false;
        return;
      }
      if (!resumed) for (const listener of [...this.restartListeners]) listener();
    });
    conn.subscribe((state) => this.onState(state));
  }

  static async open(options: RelayChannelOptions): Promise<RelayWorkspaceChannel> {
    let keyPair;
    try {
      keyPair = (await loadOrCreateCliDeviceKey(options.stateDir)).keyPair;
    } catch (err) {
      throw stateProblem(err, 'device-key');
    }
    const conn = new Connection({
      relay: options.relay,
      workspaceId: options.workspaceId,
      deviceKeys: staticDeviceKeyProvider(keyPair),
      pins: filePinStore(options.stateDir),
      invite: options.invite,
      ...(options.preferInvite ? { preferInvite: true } : {}),
      clientKind: 'cli',
      deviceName: options.deviceName,
      suite: nodeCryptoSuite,
    });
    conn.start();
    const offline = hostOfflineFor(conn, options.hostOfflineGiveUpMs ?? HOST_OFFLINE_GIVE_UP_MS);
    try {
      const welcome = await Promise.race([conn.whenOnline({ timeoutMs: options.onlineTimeoutMs ?? ONLINE_TIMEOUT_MS }), offline.gaveUp]);
      offline.stop();
      return new RelayWorkspaceChannel(conn, welcome, options.versionRefused);
    } catch (err) {
      offline.stop();
      const state = conn.getState();
      conn.close();
      if (state.kind === 'key-mismatch' || state.kind === 'rejected' || state.kind === 'closed') {
        const end = describeTerminalState(state);
        // `version`: who has to update is not in the refusal; the command asks what `smurg update` asks.
        if (state.kind === 'rejected' && state.reason === 'version' && options.versionRefused) throw new CliError(await options.versionRefused(), { cause: err });
        throw new CliError(end.message, { exitCode: state.kind === 'closed' && state.reason === 'login-required' ? EXIT.auth : EXIT.failure, cause: err });
      }
      if (state.kind === 'host-offline') throw new CliError(m('channel.hostOffline'), { cause: err });
      if (state.kind === 'relay-unreachable') throw new CliError(m('channel.relayUnreachable'), { hint: m('relay.unreachable.hint'), cause: err });
      throw new CliError(m('channel.timeout'), { cause: err });
    }
  }

  request<T extends InteractiveRequestType>(type: T, payload: PayloadInputOf<T>, options?: RequestOptions): Promise<ResultOf<T>> {
    return this.conn.request(type, payload, options);
  }

  notify<T extends InteractiveNotifyType>(type: T, payload: PayloadInputOf<T>): boolean {
    return this.conn.notify(type, payload, { whenDisconnected: 'drop' });
  }

  on<T extends InteractiveEventType>(type: T, handler: EventHandler<T>): () => void {
    return this.conn.on(type, handler);
  }

  onEnd(listener: (end: ChannelEnd) => void): () => void {
    const ended = this.ended;
    if (ended) {
      queueMicrotask(() => listener(ended));
      return () => {};
    }
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  onRestart(listener: () => void): () => void {
    this.restartListeners.add(listener);
    return () => this.restartListeners.delete(listener);
  }

  onStatus(listener: (status: ChannelStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  close(): void {
    this.conn.close();
  }

  private finish(end: ChannelEnd): void {
    if (this.ended) return;
    this.ended = end;
    for (const listener of [...this.endListeners]) listener(end);
    this.endListeners.clear();
  }

  private onState(state: ConnectionState): void {
    if (this.ended || this.ending) return;
    const stopped = state.kind === 'host-offline' && state.reason === 'stopped';
    if (state.kind === 'key-mismatch' || state.kind === 'rejected' || state.kind === 'closed' || stopped) {
      // The host came back as another smurg version (a reconnect refused with `version`, a terminal state): the end
      // waits for the words that say who has to update.
      if (state.kind === 'rejected' && state.reason === 'version' && this.versionRefused) {
        this.ending = true;
        const fallback = describeTerminalState(state);
        void this.versionRefused().then(
          (message) => this.finish({ reason: 'rejected', message }),
          () => this.finish(fallback),
        );
        return;
      }
      // The host ran `smurg stop`: its sessions are gone, so an attach ends (the SDK itself would wait for the host).
      this.finish(stopped ? { reason: 'stopped', message: closedMessage('stopped') } : describeTerminalState(state));
      return;
    }
    const status: ChannelStatus | null = state.kind === 'online' ? 'online' : state.kind === 'host-offline' ? 'host-offline' : state.kind === 'idle' ? null : 'reconnecting';
    if (status !== null) for (const listener of [...this.statusListeners]) listener(status);
  }
}
