// Which relay a command talks to, and the relay HTTP API with the CLI's credentials. The relay is trusted to say who
// logged in and to forward ciphertext, nothing else (ARCHITECTURE §2).
import { RelayApi, isRelayApiError, type ClientWebSocketConstructor, type RelayAuth, type RelayFetch } from '@smurg/protocol/client';
import { RelayUrlError, relayOrigin } from '@smurg/protocol/relay';
import { CliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import type { CliIo } from '../cli/io.ts';
import type { Credentials } from '../state/credentials.ts';
import { DEFAULT_RELAY_URL } from './default-relay.ts';

/**
 * The origin of a relay (or web app) URL: https, or http only on a local hostname. A usage error in zh-TW otherwise.
 */
export function relayOriginOf(text: string, what = '--relay', hint = 'relay 網址只能是 https 的網站根網址（本機開發可用 http://localhost:8787）。'): string {
  try {
    return relayOrigin(text).origin;
  } catch (err) {
    if (err instanceof RelayUrlError) throw usageError(`${what} 的網址不正確：${text}`, hint);
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
 * closed with a zh-TW hint: a guessed domain would receive the host's login and every invite link printed for it
 * (CLI-12).
 */
export function pickRelay(flag: string | undefined, io: CliIo, credentials: Credentials, builtIn: string | null = DEFAULT_RELAY_URL): ChosenRelay {
  if (flag !== undefined) return { origin: relayOriginOf(flag), source: 'flag' };
  const env = io.env['SMURG_RELAY_URL'];
  if (env !== undefined && env !== '') return { origin: relayOriginOf(env, 'SMURG_RELAY_URL'), source: 'env' };
  if (credentials.defaultRelay !== null) return { origin: relayOriginOf(credentials.defaultRelay, 'credentials.json 裡的 relay'), source: 'login' };
  if (builtIn !== null) return { origin: relayOriginOf(builtIn, 'smurg 內建的公用 relay'), source: 'built-in' };
  throw usageError(
    '沒有指定 relay',
    '請用 --relay <網址> 指定要使用的 relay（或設定環境變數 SMURG_RELAY_URL）；登入過一次之後會記住。這個 smurg 沒有內建的公用 relay' +
      '（說明：https://smurg.ai/docs/hosting/；本機開發：http://localhost:8787）。',
  );
}

/** pickRelay's origin. */
export function chooseRelay(flag: string | undefined, io: CliIo, credentials: Credentials, builtIn: string | null = DEFAULT_RELAY_URL): string {
  return pickRelay(flag, io, credentials, builtIn).origin;
}

/** What `--relay` defaults to, for the commands' --help (「預設：…」). */
export function relayDefaultText(builtIn: string | null = DEFAULT_RELAY_URL): string {
  return builtIn === null ? '預設：SMURG_RELAY_URL，或上次登入的 relay；沒有內建的預設 relay' : `預設：SMURG_RELAY_URL、上次登入的 relay，或內建的公用 relay ${builtIn}`;
}

/** Said before a command talks to the built-in relay, so nobody uses it without knowing (and knowing the way out). */
export function builtInRelayNotice(origin: string): string {
  return `使用 smurg 內建的公用 relay：${origin}（要用其他 relay：--relay <網址> 或 SMURG_RELAY_URL）`;
}

export function relayApi(io: CliIo, origin: string, auth: RelayAuth): RelayApi {
  return new RelayApi({
    relayUrl: origin,
    auth,
    ...(io.fetch ? { fetch: io.fetch as unknown as RelayFetch } : {}),
    ...(io.WebSocket ? { WebSocket: io.WebSocket as unknown as ClientWebSocketConstructor } : {}),
  });
}

/** A relay failure as the person should read it. */
export function relayProblem(err: unknown, origin: string, doing: string): CliError {
  if (isRelayApiError(err)) {
    if (err.status === 0) return new CliError(`無法連線到 relay（${origin}），${doing}失敗`, { hint: '請確認網路連線與 relay 網址。', cause: err });
    if (err.status === 401) return new CliError(`relay 的登入已失效（${origin}）`, { exitCode: EXIT.auth, hint: '請執行 smurg login 重新登入。', cause: err });
    return new CliError(`relay 拒絕了請求（${origin}，HTTP ${err.status}，${err.code}），${doing}失敗`, { cause: err });
  }
  return new CliError(`${doing}失敗（${err instanceof Error ? err.name : 'unknown'}）`, { cause: err });
}
