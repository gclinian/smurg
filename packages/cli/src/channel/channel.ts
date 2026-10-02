// What `smurg attach` needs from a connection to a workspace, whether it runs over the host's local control socket
// (no Noise, the host's OS account is the credential) or through the relay with the CLI's device key (Noise, pins):
// typed requests, one-way messages, events, and how the connection ends.
import type { PayloadInputOf, ResultOf, Welcome } from '@smurg/protocol';
import { m, type Text } from '../i18n/index.ts';
import type { EventHandler, InteractiveEventType, InteractiveNotifyType, InteractiveRequestType, RequestOptions } from '@smurg/protocol/client';

/** Why a connection ended for good; `message` is what the person reads (rendered where it is printed). */
export interface ChannelEnd {
  readonly reason: 'stopped' | 'kicked' | 'revoked' | 'role-changed' | 'disconnected' | 'closed' | 'rejected' | 'key-mismatch' | 'protocol-error';
  readonly message: Text;
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

/** What a channel.closed reason means for the person. */
export function closedMessage(reason: string): Text {
  switch (reason) {
    case 'stopped':
      return m('channel.closed.stopped');
    case 'kicked':
      return m('channel.closed.kicked');
    case 'revoked':
      return m('channel.closed.revoked');
    case 'role-changed':
      return m('channel.closed.roleChanged');
    case 'protocol-error':
      return m('channel.closed.protocolError');
    default:
      return m('channel.closed.other');
  }
}
