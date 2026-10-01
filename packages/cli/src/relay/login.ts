// CLI login to a relay (ARCHITECTURE §6, decided 2026-10-01):
//  - device code (RFC 8628 style): ask the relay to start a login (POST /auth/device/start), print its /device page and
//    the short user code, open that page in this machine's browser when CliIo.openUrl allows it (never over SSH, never
//    with --no-browser; the code is never put into the URL: a link carrying a code is what a phisher would send), and
//    poll POST /auth/device/token every `interval` seconds (5 s more after each `slow_down`) until the person, logged in
//    to the relay in any browser, entered the code and pressed 「允許」. Nothing comes back to this machine from the
//    browser, so the same works over SSH without a port-forward. Ctrl-C ends the wait.
//  - dev: `--dev-user NAME` uses the relay's DEV-ONLY login, and only for a relay on a local hostname (the relay also
//    refuses it elsewhere; refusing here too means the CLI never even asks a remote relay for it).
// The token goes to credentials.json (0600) and nowhere else; the device code stays in memory.
import { isRelayApiError, type RelayApi, type RelaySession, type RelayUser } from '@smurg/protocol/client';
import { DEVICE_LOGIN_SLOW_DOWN_SECONDS, deviceLoginPageUrl, isLocalHostname, type RelayDeviceStart } from '@smurg/protocol/relay';
import { CliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import type { CliIo, CliSignal } from '../cli/io.ts';
import { loadCredentials, saveSession, sessionFor, type StoredSession } from '../state/credentials.ts';
import type { StatePaths } from '../state/paths.ts';
import { relayApi, relayProblem } from './relay.ts';

export interface LoginContext {
  readonly io: CliIo;
  readonly paths: StatePaths;
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
  io.stdout.write(`在任何裝置（電腦或手機）打開：\n  ${page}\n輸入代碼：${start.userCode}   （${minutes} 分鐘內有效）\n`);
  // The polling starts at once; the opener (it may take a moment) only decides which lines come next.
  const opened = options.noBrowser ? Promise.resolve(false) : io.openUrl(page).catch(() => false);
  void opened.then((yes) => {
    io.stdout.write(`${yes ? '（已經用這台電腦的瀏覽器打開上面的網址）\n' : ''}等待你在瀏覽器裡按「允許」…（按 Ctrl-C 取消）\n`);
  });
  return waitForApproval(io, api, start, origin);
}

function startProblem(err: unknown, origin: string): CliError {
  if (isRelayApiError(err) && err.status === 429) {
    return new CliError('這個網路在 10 分鐘內開始了太多次登入', { exitCode: EXIT.auth, hint: '請過幾分鐘再執行一次。', cause: err });
  }
  if (isRelayApiError(err) && (err.status === 404 || err.status === 405)) {
    return new CliError(`這個 relay 還不支援用代碼登入（${origin}）`, { exitCode: EXIT.auth, hint: '請提供 relay 的人更新 relay，或改用與它同時發佈的 smurg 版本。', cause: err });
  }
  return relayProblem(err, origin, '登入');
}

/** Polls until the login is allowed, denied or expired, or until Ctrl-C (SIGINT, SIGTERM and SIGHUP all end it). */
async function waitForApproval(io: CliIo, api: RelayApi, start: RelayDeviceStart, origin: string): Promise<RelaySession> {
  const abort = new AbortController();
  const offs = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) =>
    io.onSignal(signal, () => abort.abort(new CliError('已取消登入', { exitCode: SIGNAL_EXIT[signal] }))),
  );
  const cancelled = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }));
  cancelled.catch(() => undefined);
  const expired = (cause?: unknown) =>
    new CliError('代碼已過期，登入沒有完成', { exitCode: EXIT.auth, hint: '請重新執行，並在 10 分鐘內到瀏覽器輸入代碼、按「允許」。', cause });
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
        if (!isRelayApiError(err)) throw err instanceof CliError ? err : relayProblem(err, origin, '登入');
        if (err.status === 400 && err.code === 'authorization_pending') {
          unreachable = false;
          continue;
        }
        if (err.status === 400 && err.code === 'slow_down') {
          interval += DEVICE_LOGIN_SLOW_DOWN_SECONDS;
          continue;
        }
        if (err.status === 400 && err.code === 'access_denied') {
          throw new CliError('登入被拒絕：瀏覽器裡按了「拒絕」', {
            exitCode: EXIT.auth,
            hint: '如果不是你自己按的，可能有別人拿到了這組代碼；請重新執行，並且只在你自己的瀏覽器輸入代碼。',
            cause: err,
          });
        }
        if (err.status === 400 && err.code === 'expired_token') throw expired(err);
        // The network or the relay is briefly away: keep asking until the code expires.
        if (err.status === 0 || err.status >= 500) {
          if (!unreachable) io.stdout.write(`（暫時無法連線到 relay（${origin}），會繼續重試）\n`);
          unreachable = true;
          continue;
        }
        throw relayProblem(err, origin, '登入');
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
    throw usageError('--dev-user 只能用在本機的 relay（localhost、127.0.0.1、[::1] 或 *.localhost）', `目前的 relay 是 ${origin}；請改用 smurg login，在瀏覽器裡用這個 relay 提供的方式登入（公用 relay：Google）。`);
  }
  if (!DEV_USER.test(user)) throw usageError('--dev-user 的名稱只能包含英數字、「.」「_」「-」，最多 64 個字元');
  try {
    return await relayApi(ctx.io, origin, { kind: 'cookie' }).devLogin(user);
  } catch (err) {
    if (isRelayApiError(err) && err.status === 404) {
      throw new CliError(`這個 relay 沒有開啟開發用登入（${origin}）`, { exitCode: EXIT.auth, hint: '開發用登入需要 relay 以 DEV_LOGIN=1 執行（pnpm dev:relay）。' });
    }
    throw relayProblem(err, origin, '開發用登入');
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
     * long as it shares, and a token that expires midway locks every member out; reviews REL-08 / CLI-03).
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
      if (!(isRelayApiError(err) && err.status === 401)) throw relayProblem(err, origin, '確認登入狀態');
    }
  }
  if (!options.interactive) {
    throw new CliError(`尚未登入 relay（${origin}）`, { exitCode: EXIT.auth, hint: `請先執行 smurg login --relay ${origin}` });
  }
  io.stdout.write(
    expiringSoon
      ? `relay 的登入快要到期，先重新登入（分享期間登入到期的話，組員會無法連線）。\n`
      : stored
        ? `relay 的登入已過期，請重新登入。\n`
        : `尚未登入 relay，先進行登入。\n`,
  );
  const session = await deviceLogin(ctx, origin, options.noBrowser === undefined ? {} : { noBrowser: options.noBrowser });
  const saved = await saveSession(paths, origin, session, io.now());
  return { session: saved, user: session.user };
}
