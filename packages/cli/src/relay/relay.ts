// Which relay a command talks to, and the relay HTTP API with the CLI's credentials. The relay is trusted to say who
// logged in and to forward ciphertext, nothing else (ARCHITECTURE §2).
import { RelayApi, isRelayApiError, type ClientWebSocketConstructor, type RelayAuth, type RelayFetch } from '@smurg/protocol/client';
import { RelayUrlError, relayOrigin } from '@smurg/protocol/relay';
import { CliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import type { CliIo } from '../cli/io.ts';
import { m, type Text } from '../i18n/index.ts';
import type { RelayAction, UrlSubject } from '../i18n/en.ts';
import type { Credentials } from '../state/credentials.ts';
import { DEFAULT_RELAY_URL } from './default-relay.ts';

/**
 * The origin of a relay (or web app) URL: https, or http only on a local hostname. A usage error otherwise, which names
 * where the URL came from (`subject`).
 */
export function relayOriginOf(text: string, subject: UrlSubject = 'flag'): string {
  try {
    return relayOrigin(text).origin;
  } catch (err) {
    if (err instanceof RelayUrlError) throw usageError(m('relay.badUrl', { subject, url: text }), m(subject === 'web-origin' ? 'relay.badWebOrigin.hint' : 'relay.badUrl.hint'));
    throw err;
  }
}

/** Where the relay of a command came from. */
export type RelaySource = 'flag' | 'env' | 'login' | 'built-in';

export interface ChosenRelay {
  readonly origin: string;
  readonly source: RelaySource;
}

/**
 * --relay, then $SMURG_RELAY_URL, then the relay of the last login, then the built-in DEFAULT_RELAY_URL (the project's
 * hosted relay, ./default-relay.ts) when there is one. While there is none (null), a command without a relay fails
 * closed with a hint: a guessed domain would receive the host's login and every invite link printed for it
 *.
 */
export function pickRelay(flag: string | undefined, io: CliIo, credentials: Credentials, builtIn: string | null = DEFAULT_RELAY_URL): ChosenRelay {
  if (flag !== undefined) return { origin: relayOriginOf(flag), source: 'flag' };
  const env = io.env['SMURG_RELAY_URL'];
  if (env !== undefined && env !== '') return { origin: relayOriginOf(env, 'env'), source: 'env' };
  if (credentials.defaultRelay !== null) return { origin: relayOriginOf(credentials.defaultRelay, 'credentials'), source: 'login' };
  if (builtIn !== null) return { origin: relayOriginOf(builtIn, 'built-in'), source: 'built-in' };
  throw usageError(m('relay.none'), m('relay.none.hint'));
}

/** pickRelay's origin. */
export function chooseRelay(flag: string | undefined, io: CliIo, credentials: Credentials, builtIn: string | null = DEFAULT_RELAY_URL): string {
  return pickRelay(flag, io, credentials, builtIn).origin;
}

/** What `--relay` defaults to, for the commands' --help ("default: ..."). */
export function relayDefaultText(builtIn: string | null = DEFAULT_RELAY_URL): Text {
  return builtIn === null ? m('relay.default.none') : m('relay.default.builtIn', { url: builtIn });
}

/** Said before a command talks to the built-in relay, so nobody uses it without knowing (and knowing the way out). */
export function builtInRelayNotice(origin: string): Text {
  return m('relay.builtInNotice', { origin });
}

export function relayApi(io: CliIo, origin: string, auth: RelayAuth): RelayApi {
  return new RelayApi({
    relayUrl: origin,
    auth,
    ...(io.fetch ? { fetch: io.fetch as unknown as RelayFetch } : {}),
    ...(io.WebSocket ? { WebSocket: io.WebSocket as unknown as ClientWebSocketConstructor } : {}),
  });
}

/** A relay failure as the person should read it; `action` is what the request was for. */
export function relayProblem(err: unknown, origin: string, action: RelayAction): CliError {
  if (isRelayApiError(err)) {
    if (err.status === 0) return new CliError(m('relay.unreachable', { origin, action }), { hint: m('relay.unreachable.hint'), cause: err });
    if (err.status === 401) return new CliError(m('relay.loginInvalid', { origin }), { exitCode: EXIT.auth, hint: m('relay.loginInvalid.hint'), cause: err });
    return new CliError(m('relay.refused', { origin, status: err.status, code: err.code, action }), { cause: err });
  }
  return new CliError(m('relay.failed', { action, name: err instanceof Error ? err.name : 'unknown' }), { cause: err });
}
