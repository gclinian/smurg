// CLI login to a relay (ARCHITECTURE §6, decided 2026-10-01):
//  - device code (RFC 8628 style): ask the relay to start a login (POST /auth/device/start), print its /device page and
//    the short user code, open that page in this machine's browser when CliIo.openUrl allows it (never over SSH, never
//    with --no-browser; the code is never put into the URL: a link carrying a code is what a phisher would send), and
//    poll POST /auth/device/token every `interval` seconds (5 s more after each `slow_down`) until the person, logged in
//    to the relay in any browser, entered the code and approved the request. Nothing comes back to this machine from the
//    browser, so the same works over SSH without a port-forward. Ctrl-C ends the wait.
//  - dev: `--dev-user NAME` uses the relay's DEV-ONLY login, and only for a relay on a local hostname (the relay also
//    refuses it elsewhere; refusing here too means the CLI never even asks a remote relay for it).
// The token goes to credentials.json (0600) and nowhere else; the device code stays in memory.
import { isRelayApiError, type RelayApi, type RelaySession, type RelayUser } from '@smurg/protocol/client';
import { DEVICE_LOGIN_SLOW_DOWN_SECONDS, deviceLoginPageUrl, isLocalHostname, type RelayDeviceStart } from '@smurg/protocol/relay';
import { CliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import type { CliIo, CliSignal } from '../cli/io.ts';
import { m, renderText, type Locale } from '../i18n/index.ts';
import { loadCredentials, saveSession, sessionFor, type StoredSession } from '../state/credentials.ts';
import type { StatePaths } from '../state/paths.ts';
import { relayApi, relayProblem } from './relay.ts';

export interface LoginContext {
  readonly io: CliIo;
  readonly paths: StatePaths;
  readonly lang: Locale;
}

export interface LoginOptions {
  /** Do not try to open this machine's browser; only print the page and the code. */
  readonly noBrowser?: boolean;
}

const DEV_USER = /^[A-Za-z0-9._-]{1,64}$/;

/** Exit codes of a login ended by a signal (as `smurg attach` uses them). */
const SIGNAL_EXIT: Readonly<Record<CliSignal, number>> = { SIGINT: EXIT.interrupted, SIGTERM: 143, SIGHUP: 129 };

/** The device-code login; resolves with the relay session (not yet saved). */
export async function deviceLogin(ctx: LoginContext, origin: string, options: LoginOptions = {}): Promise<RelaySession> {
  const { io } = ctx;
  const api = relayApi(io, origin, { kind: 'cookie' });
  let start: RelayDeviceStart;
  try {
    start = await api.startDeviceLogin();
  } catch (err) {
    throw startProblem(err, origin);
  }
  // Built here, not taken from the answer: the page the person opens is the relay this command talks to.
  const page = deviceLoginPageUrl(origin);
  const minutes = Math.max(1, Math.floor(start.expiresIn / 60));
  io.stdout.write(renderText(ctx.lang, m('login.open', { page, code: start.userCode, minutes })));
  // The polling starts at once; the opener (it may take a moment) only decides which lines come next.
  const opened = options.noBrowser ? Promise.resolve(false) : io.openUrl(page).catch(() => false);
  void opened.then((yes) => {
    io.stdout.write(`${yes ? renderText(ctx.lang, m('login.opened')) : ''}${renderText(ctx.lang, m('login.waiting'))}`);
  });
  return waitForApproval(ctx, api, start, origin);
}

function startProblem(err: unknown, origin: string): CliError {
  if (isRelayApiError(err) && err.status === 429) {
    return new CliError(m('login.tooMany'), { exitCode: EXIT.auth, hint: m('login.tooMany.hint'), cause: err });
  }
  if (isRelayApiError(err) && (err.status === 404 || err.status === 405)) {
    return new CliError(m('login.unsupported', { origin }), { exitCode: EXIT.auth, hint: m('login.unsupported.hint'), cause: err });
  }
  return relayProblem(err, origin, 'login');
}

/** Polls until the login is allowed, denied or expired, or until Ctrl-C (SIGINT, SIGTERM and SIGHUP all end it). */
async function waitForApproval(ctx: LoginContext, api: RelayApi, start: RelayDeviceStart, origin: string): Promise<RelaySession> {
  const { io } = ctx;
  const abort = new AbortController();
  const offs = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) =>
    io.onSignal(signal, () => abort.abort(new CliError(m('login.cancelled'), { exitCode: SIGNAL_EXIT[signal] }))),
  );
  const cancelled = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }));
  cancelled.catch(() => undefined);
  const expired = (cause?: unknown) =>
    new CliError(m('login.expired'), { exitCode: EXIT.auth, hint: m('login.expired.hint'), cause });
  try {
    const deadline = io.now() + start.expiresIn * 1000;
    let interval = start.interval;
    let unreachable = false;
    for (;;) {
      await Promise.race([pause(io, interval * 1000, abort.signal), cancelled]);
      if (io.now() >= deadline) throw expired();
      try {
        return await Promise.race([api.pollDeviceLogin(start.deviceCode), cancelled]);
      } catch (err) {
        if (!isRelayApiError(err)) throw err instanceof CliError ? err : relayProblem(err, origin, 'login');
        if (err.status === 400 && err.code === 'authorization_pending') {
          unreachable = false;
          continue;
        }
        if (err.status === 400 && err.code === 'slow_down') {
          interval += DEVICE_LOGIN_SLOW_DOWN_SECONDS;
          continue;
        }
        if (err.status === 400 && err.code === 'access_denied') {
          throw new CliError(m('login.denied'), { exitCode: EXIT.auth, hint: m('login.denied.hint'), cause: err });
        }
        if (err.status === 400 && err.code === 'expired_token') throw expired(err);
        // The network or the relay is briefly away: keep asking until the code expires.
        if (err.status === 0 || err.status >= 500) {
          if (!unreachable) io.stdout.write(renderText(ctx.lang, m('login.retrying', { origin })));
          unreachable = true;
          continue;
        }
        throw relayProblem(err, origin, 'login');
      }
    }
  } finally {
    for (const off of offs) off();
  }
}

/** Waits `ms` (CliIo.delay in tests), or rejects as soon as `signal` aborts. */
function pause(io: CliIo, ms: number, signal: AbortSignal): Promise<void> {
  if (io.delay) return io.delay(ms);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** The relay's DEV-ONLY login; refused for any relay that is not on a local hostname. */
export async function devLogin(ctx: LoginContext, origin: string, user: string): Promise<RelaySession> {
  if (!isLocalHostname(new URL(origin).hostname)) {
    throw usageError(m('login.devUserLocalOnly'), m('login.devUserLocalOnly.hint', { origin }));
  }
  if (!DEV_USER.test(user)) throw usageError(m('login.devUserName'));
  try {
    return await relayApi(ctx.io, origin, { kind: 'cookie' }).devLogin(user);
  } catch (err) {
    if (isRelayApiError(err) && err.status === 404) {
      throw new CliError(m('login.devDisabled', { origin }), { exitCode: EXIT.auth, hint: m('login.devDisabled.hint') });
    }
    throw relayProblem(err, origin, 'dev-login');
  }
}

export interface VerifiedSession {
  readonly session: StoredSession;
  readonly user: RelayUser;
}

/**
 * A working session for `origin`: the stored one if the relay still accepts it, otherwise a new device-code login
 * (`interactive`) or a login error.
 */
export async function ensureSession(
  ctx: LoginContext,
  origin: string,
  options: LoginOptions & {
    readonly interactive: boolean;
    /**
     * A stored session that expires sooner than this counts as missing (`smurg host`: the daemon uses the token for as
     * long as it shares, and a token that expires midway locks every member out).
     */
    readonly minValidityMs?: number;
  },
): Promise<VerifiedSession> {
  const { io, paths } = ctx;
  const credentials = await loadCredentials(paths);
  const stored = sessionFor(credentials, origin, io.now() + (options.minValidityMs ?? 0));
  const expiringSoon = stored === null && sessionFor(credentials, origin, io.now()) !== null;
  if (stored) {
    try {
      const user = await relayApi(io, origin, { kind: 'bearer', token: stored.token }).me();
      return { session: stored, user };
    } catch (err) {
      if (!(isRelayApiError(err) && err.status === 401)) throw relayProblem(err, origin, 'verify');
    }
  }
  if (!options.interactive) {
    throw new CliError(m('login.required', { origin }), { exitCode: EXIT.auth, hint: m('login.required.hint', { origin }) });
  }
  io.stdout.write(renderText(ctx.lang, m(expiringSoon ? 'login.expiringSoon' : stored ? 'login.hasExpired' : 'login.first')));
  const session = await deviceLogin(ctx, origin, options.noBrowser === undefined ? {} : { noBrowser: options.noBrowser });
  const saved = await saveSession(paths, origin, session, io.now());
  return { session: saved, user: session.user };
}
