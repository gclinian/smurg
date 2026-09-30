// The observable state of a Connection / TransferConnection. Every state the UI must tell apart is its own kind:
// "relay unreachable" is not "host offline" (ARCHITECTURE §4 "Liveness"), and a key mismatch is not a rejection.
import type { HandshakeMode } from '../invite.ts';
import type { ChannelClosedReason } from './message-types.ts';
import type { VerdictRejectReason, Welcome } from '../schema/handshake.ts';

/** Why the next connection attempt is delayed (state `connecting` with `retryAt`). */
export type RetryCause =
  /** The handshake did not finish within HANDSHAKE_DEADLINE_MS. */
  | 'timeout'
  /** The daemon answered the generic cleartext ABORT (rate limit, unknown invite, …). */
  | 'aborted'
  /** The daemon is busy (authenticated verdict). */
  | 'busy'
  /** Unexpected frames, an undecodable message or an integrity failure on the established channel. */
  | 'protocol'
  /** The relay says the host is online but the daemon has been silent too long: start over. */
  | 'stalled'
  /** The daemon closed the channel after changing our role: reconnect to learn the new one. */
  | 'role-changed';

export type RelayUnreachableCause = 'open-failed' | 'closed' | 'watchdog' | 'no-hello' | 'bye' | 'relay-error';

export type HostOfflineReason =
  /** The relay said so (`hello{host:false}` or `host.offline`). */
  | 'relay'
  /** Nothing from the daemon for CLIENT_OFFLINE_THRESHOLD_MS although the relay said nothing (R1). */
  | 'silence'
  /** The daemon announced `channel.closed{stopped}` (the host ran `smurg stop`). */
  | 'stopped';

/** Authenticated refusals from the daemon's verdict, plus the two client-side conclusions. */
export type ConnectionRejectReason =
  | Exclude<VerdictRejectReason, 'busy'>
  /** The verdict was empty or undecodable (the daemon's admit failed). */
  | 'unknown'
  /** Invite mode: several consecutive generic ABORTs (the daemon knows no such invite). Device mode never ends here. */
  | 'aborted';

export type ConnectionCloseReason =
  /** close() was called. */
  | 'local'
  /** The daemon removed this member (channel.closed{kicked}, or the relay's bye 4003). */
  | 'kicked'
  /** The daemon revoked this device (channel.closed{revoked}). */
  | 'revoked'
  /** The relay session is missing or expired: log in again. */
  | 'login-required'
  /** The relay refused the request for another reason (e.g. an Origin not on its allow-list). */
  | 'relay-refused'
  /** No pinned daemon key and no invite: this client cannot know whom to trust. */
  | 'no-trust'
  /** The device key or the pin store failed. */
  | 'storage-error';

export type ConnectionState =
  /** Created, start() not called yet. */
  | { readonly kind: 'idle' }
  /** Opening the relay socket, or (with `retryAt`) waiting to retry after a transient failure. */
  | {
      readonly kind: 'connecting';
      readonly attempt: number;
      readonly retryAt: number | null;
      readonly cause: RetryCause | null;
    }
  /** The host is online; identity token + Noise handshake in progress. */
  | { readonly kind: 'handshaking'; readonly mode: HandshakeMode; readonly attempt: number }
  /** Admitted. `resumed = false`: the application must resync (reload tree, re-open docs, re-attach sessions). */
  | { readonly kind: 'online'; readonly welcome: Welcome; readonly resumed: boolean }
  /** 「主人已離線」. The connection comes back by itself when the host does. */
  | { readonly kind: 'host-offline'; readonly reason: HostOfflineReason; readonly since: number }
  /** The relay cannot be reached; a retry is scheduled at `retryAt`. */
  | { readonly kind: 'relay-unreachable'; readonly attempt: number; readonly retryAt: number; readonly cause: RelayUnreachableCause }
  /** TERMINAL. The peer did not prove the expected daemon key: possible relay MITM (SPEC R3 warning). */
  | { readonly kind: 'key-mismatch'; readonly mode: HandshakeMode; readonly detail: 'fingerprint' | 'unauthenticated' }
  /** TERMINAL. The daemon refused this client. */
  | { readonly kind: 'rejected'; readonly reason: ConnectionRejectReason }
  /** TERMINAL. */
  | { readonly kind: 'closed'; readonly reason: ConnectionCloseReason; readonly daemonReason?: ChannelClosedReason };

export type ConnectionStateKind = ConnectionState['kind'];

export function isTerminalState(state: ConnectionState): boolean {
  return state.kind === 'key-mismatch' || state.kind === 'rejected' || state.kind === 'closed';
}
