// `smurg login [--relay URL] [--dev-user NAME] [--no-browser]` and `smurg logout [--relay URL] [--all]`: the CLI's
// relay session (bearer token in credentials.json, 0600), through the relay's device-code login (../relay/login.ts).
import { booleanOption, parseArgs, stringOption } from '../cli/args.ts';
import { usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import { devLogin, deviceLogin } from '../relay/login.ts';
import { builtInRelayNotice, chooseRelay, pickRelay, relayDefaultText } from '../relay/relay.ts';
import { loadCredentials, removeSessions, saveSession } from '../state/credentials.ts';
import { say, type CommandContext } from './context.ts';

/** `smurg login --help`; the --relay default depends on the built-in relay (./relay/default-relay.ts). */
export function loginUsage(): string {
  return `用法：smurg login [--relay 網址] [--dev-user 名稱] [--no-browser]

  登入 relay：smurg 印出一個網址和一組代碼。在任何裝置（電腦或手機）的瀏覽器打開網址，登入你的帳號
  （公用 relay 用 Google），輸入代碼並按「允許」。透過 SSH 使用時也一樣，不需要其他設定。
  登入資料存在 ~/.smurg/credentials.json（權限 0600）。
  --relay 網址        relay 的網址（${relayDefaultText()}）
  --dev-user 名稱     只限本機開發：用 relay 的開發用登入（relay 必須在 localhost）
  --no-browser        不自動用這台電腦的瀏覽器打開網址（透過 SSH 或沒有桌面時本來就不會）
`;
}

export const LOGOUT_USAGE = `用法：smurg logout [--relay 網址] [--all]

  忘記這台電腦上的 relay 登入資料。--all 忘記所有 relay 的登入。
`;

export async function runLogin(argv: readonly string[], ctx: CommandContext): Promise<number> {
  const args = parseArgs(argv, {
    options: { relay: { kind: 'string' }, 'dev-user': { kind: 'string' }, browser: { kind: 'boolean' }, help: { kind: 'boolean', short: 'h' } },
  });
  if (args.options['help']) {
    say(ctx, loginUsage());
    return EXIT.ok;
  }
  const devUser = stringOption(args, 'dev-user');
  const relay = pickRelay(stringOption(args, 'relay'), ctx.io, await loadCredentials(ctx.paths));
  const origin = relay.origin;
  if (relay.source === 'built-in') say(ctx, builtInRelayNotice(origin));
  const session =
    devUser !== undefined ? await devLogin(ctx, origin, devUser) : await deviceLogin(ctx, origin, { noBrowser: booleanOption(args, 'browser') === false });
  await saveSession(ctx.paths, origin, session, ctx.io.now());
  say(ctx, `已登入 ${origin}：${session.user.displayName}（${session.user.userId}）`);
  return EXIT.ok;
}

export async function runLogout(argv: readonly string[], ctx: CommandContext): Promise<number> {
  const args = parseArgs(argv, { options: { relay: { kind: 'string' }, all: { kind: 'boolean' }, help: { kind: 'boolean', short: 'h' } } });
  if (args.options['help']) {
    say(ctx, LOGOUT_USAGE);
    return EXIT.ok;
  }
  if (args.options['all'] === true) {
    if (stringOption(args, 'relay') !== undefined) throw usageError('--all 和 --relay 不能同時使用');
    const count = await removeSessions(ctx.paths, 'all');
    say(ctx, count > 0 ? `已登出所有 relay（${count} 個）。` : '這台電腦上沒有任何 relay 登入資料。');
    return EXIT.ok;
  }
  const origin = chooseRelay(stringOption(args, 'relay'), ctx.io, await loadCredentials(ctx.paths));
  const count = await removeSessions(ctx.paths, origin);
  say(ctx, count > 0 ? `已登出 ${origin}。` : `沒有 ${origin} 的登入資料。`);
  return EXIT.ok;
}
