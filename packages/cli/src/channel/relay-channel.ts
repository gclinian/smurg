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
import { stateProblem } from '../state/private-file.ts';
import { closedMessage, type ChannelEnd, type ChannelStatus, type WorkspaceChannel } from './channel.ts';

const ONLINE_TIMEOUT_MS = 30_000;
/**
 * The relay says at once when the host is not connected: joining gives up after this long in host-offline instead of
 * the whole online timeout (CLI-14). A host that is just reconnecting is back well within it.
 */
export const HOST_OFFLINE_GIVE_UP_MS = 5_000;

/** Pins as files under the state dir (hex file names: case-insensitive file systems, ARCHITECTURE §4.2). */
export function filePinStore(stateDir: string): PinStore {
  return {
    get: (workspaceId) => readPinnedDaemonKey(stateDir, workspaceId),
    pin: (workspaceId, key, options) => pinDaemonKey(stateDir, workspaceId, key, options ?? {}),
  };
}

/** The zh-TW explanation of a terminal connection state. */
export function describeTerminalState(state: ConnectionState): ChannelEnd {
  switch (state.kind) {
    case 'key-mismatch':
      return {
        reason: 'key-mismatch',
        message:
          '警告：對方的金鑰和邀請連結（或上次記錄）不符，可能有人（例如 relay）冒充主人。已中止連線，沒有送出任何資料。請用其他管道向主人確認 daemon 金鑰指紋。',
      };
    case 'rejected': {
      const text: Record<string, string> = {
        'invite-invalid': '邀請連結無效、已過期或已用完，請向主人索取新的連結。',
        'device-revoked': '這台裝置的金鑰已被撤銷（可能被移出工作區），請向主人索取新的邀請連結。',
        'device-other-account':
          '這台裝置先前用另一個帳號加入過這個工作區，不能改用現在登入的帳號連線。請用原本的帳號重新登入（smurg login），或改用另一個 SMURG_HOME。',
        'identity-invalid': 'relay 的身分權杖驗證失敗，請重新登入後再試。',
        kicked: '你已被主人移出這個工作區。',
        version: 'smurg 版本和主人的不相容，請更新。',
        aborted: '主人不認得這個邀請連結，請確認連結是否完整。',
        unknown: '主人拒絕了連線。',
      };
      return { reason: 'rejected', message: text[state.reason] ?? '主人拒絕了連線。' };
    }
    case 'closed': {
      const text: Record<string, string> = {
        local: '連線已關閉。',
        kicked: '你已被主人移出這個工作區。',
        revoked: '這台裝置的金鑰已被撤銷。',
        'login-required': 'relay 的登入已失效，請執行 smurg login 重新登入。',
        'relay-refused': 'relay 拒絕了連線。',
        'no-trust': '沒有這個工作區的邀請連結，也沒有記錄過主人的金鑰：請用 --invite 提供邀請連結。',
        'storage-error': '無法讀寫這台裝置的金鑰或記錄的主人金鑰（~/.smurg 的權限？）。',
      };
      const daemonReason = state.daemonReason;
      if (daemonReason !== undefined) return { reason: daemonReason === 'kicked' ? 'kicked' : 'closed', message: closedMessage(daemonReason) };
      return { reason: state.reason === 'kicked' ? 'kicked' : state.reason === 'revoked' ? 'revoked' : 'closed', message: text[state.reason] ?? '連線已關閉。' };
    }
    default:
      return { reason: 'closed', message: '連線已關閉。' };
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

  private constructor(conn: Connection, welcome: Welcome) {
    this.conn = conn;
    this.welcome = welcome;
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
      throw stateProblem(err, '這台裝置的金鑰（device.key）');
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
      return new RelayWorkspaceChannel(conn, welcome);
    } catch (err) {
      offline.stop();
      const state = conn.getState();
      conn.close();
      if (state.kind === 'key-mismatch' || state.kind === 'rejected' || state.kind === 'closed') {
        const end = describeTerminalState(state);
        throw new CliError(end.message, { exitCode: state.kind === 'closed' && state.reason === 'login-required' ? EXIT.auth : EXIT.failure, cause: err });
      }
      if (state.kind === 'host-offline') throw new CliError('主人目前離線（smurg host 沒有在執行，或主人的電腦在睡眠）。', { cause: err });
      if (state.kind === 'relay-unreachable') throw new CliError('無法連線到 relay。', { hint: '請確認網路連線與 relay 網址。', cause: err });
      throw new CliError('連線逾時，無法加入工作區。', { cause: err });
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

  private onState(state: ConnectionState): void {
    if (this.ended) return;
    const stopped = state.kind === 'host-offline' && state.reason === 'stopped';
    if (state.kind === 'key-mismatch' || state.kind === 'rejected' || state.kind === 'closed' || stopped) {
      // The host ran `smurg stop`: its sessions are gone, so an attach ends (the SDK itself would wait for the host).
      this.ended = stopped ? { reason: 'stopped', message: closedMessage('stopped') } : describeTerminalState(state);
      for (const listener of [...this.endListeners]) listener(this.ended);
      this.endListeners.clear();
      return;
    }
    const status: ChannelStatus | null = state.kind === 'online' ? 'online' : state.kind === 'host-offline' ? 'host-offline' : state.kind === 'idle' ? null : 'reconnecting';
    if (status !== null) for (const listener of [...this.statusListeners]) listener(status);
  }
}
