// What `smurg attach` needs from a connection to a workspace, whether it runs over the host's local control socket
// (no Noise, the host's OS account is the credential) or through the relay with the CLI's device key (Noise, pins):
// typed requests, one-way messages, events, and how the connection ends.
import type { PayloadInputOf, ResultOf, Welcome } from '@smurg/protocol';
import type { EventHandler, InteractiveEventType, InteractiveNotifyType, InteractiveRequestType, RequestOptions } from '@smurg/protocol/client';

/** Why a connection ended for good; `message` is zh-TW for the person. */
export interface ChannelEnd {
  readonly reason: 'stopped' | 'kicked' | 'revoked' | 'role-changed' | 'disconnected' | 'closed' | 'rejected' | 'key-mismatch' | 'protocol-error';
  readonly message: string;
}

/** Transient state of a relay connection (the local socket has none). */
export type ChannelStatus = 'online' | 'host-offline' | 'reconnecting';

export interface WorkspaceChannel {
  readonly kind: 'local' | 'relay';
  /** The admission this connection started with. */
  readonly welcome: Welcome;
  request<T extends InteractiveRequestType>(type: T, payload: PayloadInputOf<T>, options?: RequestOptions): Promise<ResultOf<T>>;
  notify<T extends InteractiveNotifyType>(type: T, payload: PayloadInputOf<T>): boolean;
  on<T extends InteractiveEventType>(type: T, handler: EventHandler<T>): () => void;
  /** Runs once when the connection ends for good (immediately if it already has). */
  onEnd(listener: (end: ChannelEnd) => void): () => void;
  /** A later admission that did NOT resume: per-channel state (attached sessions) is gone and must be re-created. */
  onRestart(listener: () => void): () => void;
  onStatus(listener: (status: ChannelStatus) => void): () => void;
  close(): void;
}

/** zh-TW text for a channel.closed reason. */
export function closedMessage(reason: string): string {
  switch (reason) {
    case 'stopped':
      return '主人已停止分享（smurg stop）。';
    case 'kicked':
      return '你已被主人移出這個工作區。';
    case 'revoked':
      return '這台裝置的金鑰已被撤銷。';
    case 'role-changed':
      return '你的角色已變更，請重新連線。';
    case 'protocol-error':
      return '連線因通訊協定錯誤被中斷。';
    default:
      return '連線已中斷。';
  }
}
