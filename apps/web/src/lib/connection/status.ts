// Maps the SDK's ConnectionState onto what the UI shows. Pure, so every state's wording and severity is unit-tested
// (src/lib/connection/status.test.ts) independently of the components that render it.
import type { ConnectionState } from '@smurg/protocol/client';
import { tConn } from '../../strings/connection.ts';

export type ConnectionTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/**
 * The UI states of ARCHITECTURE §4. `retrying` is `connecting` with a scheduled retry; `role-changed` is the
 * reconnect after the host changed our role; `kicked` merges the daemon's kick and the relay's 4003.
 */
export type ConnectionViewKind =
  | 'idle'
  | 'connecting'
  | 'retrying'
  | 'handshaking'
  | 'online'
  | 'host-offline'
  | 'relay-unreachable'
  | 'role-changed'
  | 'key-mismatch'
  | 'rejected'
  | 'kicked'
  | 'login-required'
  | 'closed';

export interface ConnectionView {
  readonly kind: ConnectionViewKind;
  readonly tone: ConnectionTone;
  /** Short label for the status pill. */
  readonly label: string;
  /** One or two sentences for banners and tooltips. */
  readonly detail: string;
  /**
   * Terminal states that replace the whole UI with an explanation (key mismatch, rejection, kick, closed). Nothing
   * else ever blocks: host-offline and relay-unreachable are banners over a UI that keeps working.
   */
  readonly blocking: boolean;
  /** Epoch ms of the next automatic retry, when one is scheduled. */
  readonly retryAt: number | null;
  /** For blocking screens: title and body. */
  readonly title?: string;
  readonly body?: string;
}

export function describeConnection(state: ConnectionState): ConnectionView {
  switch (state.kind) {
    case 'idle':
      return view('idle', 'neutral', tConn('pill.idle'), tConn('detail.connecting'));
    case 'connecting': {
      if (state.cause === 'role-changed') {
        return view('role-changed', 'info', tConn('pill.roleChanged'), tConn('detail.roleChanged'), state.retryAt);
      }
      if (state.retryAt === null && state.attempt <= 1) {
        return view('connecting', 'info', tConn('pill.connecting'), tConn('detail.connecting'));
      }
      const detail =
        state.cause === 'timeout'
          ? tConn('detail.retry.timeout')
          : state.cause === 'aborted'
            ? tConn('detail.retry.aborted')
            : state.cause === 'busy'
              ? tConn('detail.retry.busy')
              : state.cause === 'protocol'
                ? tConn('detail.retry.protocol')
                : state.cause === 'stalled'
                  ? tConn('detail.retry.stalled')
                  : tConn('detail.retry.generic');
      return view('retrying', 'warning', tConn('pill.retrying'), detail, state.retryAt);
    }
    case 'handshaking':
      return view(
        'handshaking',
        'info',
        tConn('pill.handshaking'),
        state.mode === 'invite' ? tConn('detail.handshaking.invite') : tConn('detail.handshaking.device'),
      );
    case 'online':
      return view('online', 'success', tConn('pill.online'), state.resumed ? tConn('detail.online.resumed') : tConn('detail.online'));
    case 'host-offline': {
      const detail =
        state.reason === 'stopped'
          ? tConn('detail.hostOffline.stopped')
          : state.reason === 'silence'
            ? tConn('detail.hostOffline.silence')
            : tConn('detail.hostOffline.relay');
      return view('host-offline', 'warning', tConn('pill.hostOffline'), detail);
    }
    case 'relay-unreachable':
      return view('relay-unreachable', 'danger', tConn('pill.relayUnreachable'), tConn('detail.relayUnreachable'), state.retryAt);
    case 'key-mismatch':
      return {
        ...view('key-mismatch', 'danger', tConn('pill.keyMismatch'), tConn('keyMismatch.lead')),
        blocking: true,
        title: tConn('keyMismatch.title'),
        body: tConn('keyMismatch.lead'),
      };
    case 'rejected': {
      const reason = state.reason;
      if (reason === 'kicked') {
        return blockingView('kicked', tConn('pill.kicked'), tConn('rejected.kicked.title'), tConn('rejected.kicked.body'));
      }
      const title =
        reason === 'invite-invalid'
          ? tConn('rejected.invite-invalid.title')
          : reason === 'aborted'
            ? tConn('rejected.aborted.title')
            : reason === 'device-revoked'
              ? tConn('rejected.device-revoked.title')
              : reason === 'device-other-account'
                ? tConn('rejected.device-other-account.title')
                : reason === 'identity-invalid'
                  ? tConn('rejected.identity-invalid.title')
                  : reason === 'version'
                    ? tConn('rejected.version.title')
                    : tConn('rejected.unknown.title');
      const body =
        reason === 'invite-invalid'
          ? tConn('rejected.invite-invalid.body')
          : reason === 'aborted'
            ? tConn('rejected.aborted.body')
            : reason === 'device-revoked'
              ? tConn('rejected.device-revoked.body')
              : reason === 'device-other-account'
                ? tConn('rejected.device-other-account.body')
                : reason === 'identity-invalid'
                  ? tConn('rejected.identity-invalid.body')
                  : reason === 'version'
                    ? tConn('rejected.version.body')
                    : tConn('rejected.unknown.body');
      return blockingView('rejected', tConn('pill.rejected'), title, body);
    }
    case 'closed': {
      switch (state.reason) {
        case 'kicked':
          return blockingView('kicked', tConn('pill.kicked'), tConn('closed.kicked.title'), tConn('closed.kicked.body'));
        case 'revoked':
          return blockingView('closed', tConn('pill.closed'), tConn('closed.revoked.title'), tConn('closed.revoked.body'));
        case 'login-required':
          return blockingView('login-required', tConn('pill.loginRequired'), tConn('closed.login-required.title'), tConn('closed.login-required.body'), 'warning');
        case 'relay-refused':
          return blockingView('closed', tConn('pill.closed'), tConn('closed.relay-refused.title'), tConn('closed.relay-refused.body'));
        case 'no-trust':
          return blockingView('closed', tConn('pill.closed'), tConn('closed.no-trust.title'), tConn('closed.no-trust.body'), 'warning');
        case 'storage-error':
          return blockingView('closed', tConn('pill.closed'), tConn('closed.storage-error.title'), tConn('closed.storage-error.body'));
        case 'local':
          return blockingView('closed', tConn('pill.closed'), tConn('closed.local.title'), tConn('closed.local.body'), 'neutral');
      }
    }
  }
}

function view(kind: ConnectionViewKind, tone: ConnectionTone, label: string, detail: string, retryAt: number | null = null): ConnectionView {
  return { kind, tone, label, detail, blocking: false, retryAt };
}

function blockingView(kind: ConnectionViewKind, label: string, title: string, body: string, tone: ConnectionTone = 'danger'): ConnectionView {
  return { kind, tone, label, detail: body, blocking: true, retryAt: null, title, body };
}

/** Whole seconds until `retryAt` (never negative), for "Retrying in 3 seconds.". */
export function secondsUntil(retryAt: number, now: number): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}
