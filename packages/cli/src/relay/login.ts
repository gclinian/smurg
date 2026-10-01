// CLI login to a relay (relay.md §1.4, ARCHITECTURE §6):
//  - loopback: listen on 127.0.0.1:<random>, open the relay's /auth/cli/start in the browser (a confirmation page with
//    the same confirmation code this command prints), receive /callback?code&state, exchange code + PKCE verifier for
//    a bearer session token (POST /auth/cli/token);
//  - dev: `--dev-user NAME` uses the relay's DEV-ONLY login, and only for a relay on a local hostname (the relay also
//    refuses it elsewhere; refusing here too means the CLI never even asks a remote relay for it).
// The token goes to credentials.json (0600) and nowhere else.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCliLoginRequest, isRelayApiError, parseCliCallback, type CliLoginProvider, type RelaySession, type RelayUser } from '@smurg/protocol/client';
import { isLocalHostname } from '@smurg/protocol/relay';
import { CliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import type { CliIo } from '../cli/io.ts';
import { loadCredentials, saveSession, sessionFor, type StoredSession } from '../state/credentials.ts';
import type { StatePaths } from '../state/paths.ts';
import { relayApi, relayProblem } from './relay.ts';

export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface LoginContext {
  readonly io: CliIo;
  readonly paths: StatePaths;
}

export interface LoginOptions {
  readonly provider?: 'github' | 'google';
  /** Do not try to open a browser; only print the URL. */
  readonly noBrowser?: boolean;
  readonly timeoutMs?: number;
}

const DEV_USER = /^[A-Za-z0-9._-]{1,64}$/;

function overSsh(env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env['SSH_CONNECTION'] || env['SSH_CLIENT'] || env['SSH_TTY']);
}

function page(title: string, text: string): string {
  const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>${escape(title)}</title><body style="font-family:system-ui,sans-serif;margin:3rem"><h1>${escape(title)}</h1><p>${escape(text)}</p></body></html>`;
}

function reply(res: ServerResponse, status: number, title: string, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    // The callback URL carries the code: never hand it to another origin.
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(page(title, text));
}

/** Waits for the relay's redirect to the loopback listener; resolves with the code. */
function waitForCallback(server: Server, state: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CliError('等待瀏覽器登入逾時', { exitCode: EXIT.auth, hint: '請重新執行 smurg login。' }));
    }, timeoutMs);
    timer.unref?.();
    let done = false;
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      if (done) {
        reply(res, 410, 'smurg', '這個登入已經完成，可以關閉這個分頁。');
        return;
      }
      if (req.method !== 'GET') {
        reply(res, 405, 'smurg', '不支援的請求。');
        return;
      }
      const result = parseCliCallback(req.url ?? '', state);
      if (!result.ok && (result.error === 'bad_callback' || result.error === 'state_mismatch')) {
        // Not our relay's redirect (another page poking the port, a stale tab): ignore it and keep waiting.
        reply(res, 400, 'smurg 登入', '這不是這次登入的回應，請回到終端機重新執行 smurg login。');
        return;
      }
      done = true;
      clearTimeout(timer);
      if (result.ok) {
        reply(res, 200, 'smurg 登入完成', '已經登入，可以關閉這個分頁並回到終端機。');
        resolve(result.code);
      } else {
        reply(res, 400, 'smurg 登入失敗', '登入沒有完成，請回到終端機再試一次。');
        reject(new CliError(`登入失敗（${result.error}）`, { exitCode: EXIT.auth }));
      }
    });
  });
}

async function listenLoopback(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
  });
  return { server, port: (server.address() as AddressInfo).port };
}

/** The browser flow; resolves with the relay session (not yet saved). */
export async function loopbackLogin(ctx: LoginContext, origin: string, options: LoginOptions = {}): Promise<RelaySession> {
  const { io } = ctx;
  const { server, port } = await listenLoopback();
  try {
    const request = createCliLoginRequest({ relayUrl: origin, port, ...(options.provider ? { provider: options.provider as CliLoginProvider } : {}) });
    // Listen for the callback BEFORE the browser is opened: a fast browser may be back before the opener returns.
    const callback = waitForCallback(server, request.state, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    callback.catch(() => undefined);
    io.stdout.write(`請在瀏覽器中完成登入 relay（${origin}）：\n  ${request.url}\n`);
    // The relay's confirmation page shows the same code (review SEC-E-03): only continue there when they match.
    io.stdout.write(`確認碼：${request.confirmCode}（瀏覽器頁面上顯示同一組確認碼時才按「繼續」）\n`);
    if (overSsh(io.env)) {
      // The relay sends the browser back to 127.0.0.1:<port> of the machine the browser runs on.
      io.stdout.write(
        `（這個終端機是透過 SSH 連進來的：登入完成時瀏覽器會回到「瀏覽器所在電腦」的 127.0.0.1:${port}。` +
          `請先在你面前的電腦執行  ssh -N -L ${port}:127.0.0.1:${port} <這台電腦>  ，再用那台電腦的瀏覽器打開上面的網址。）\n`,
      );
    }
    const manual = '（沒有自動開啟瀏覽器，請自己用瀏覽器打開上面的網址）\n';
    if (options.noBrowser) io.stdout.write(manual);
    else {
      void io.openUrl(request.url).then(
        (opened) => {
          if (!opened) io.stdout.write(manual);
        },
        () => io.stdout.write(manual),
      );
    }
    io.stdout.write('等待登入完成…\n');
    const code = await callback;
    try {
      return await relayApi(io, origin, { kind: 'cookie' }).exchangeCliCode(code, request.codeVerifier);
    } catch (err) {
      throw relayProblem(err, origin, '登入');
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
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
 * A working session for `origin`: the stored one if the relay still accepts it, otherwise a new browser login
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
  const session = await loopbackLogin(ctx, origin, options);
  const saved = await saveSession(paths, origin, session, io.now());
  return { session: saved, user: session.user };
}
