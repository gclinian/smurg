// `smurg login [--relay URL] [--dev-user NAME] [--no-browser]` and `smurg logout [--relay URL] [--all]`: the CLI's
// relay session (bearer token in credentials.json, 0600), through the relay's device-code login (../relay/login.ts).
import { booleanOption, parseArgs, stringOption } from '../cli/args.ts';
import { usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import { devLogin, deviceLogin } from '../relay/login.ts';
import { builtInRelayNotice, chooseRelay, pickRelay, relayDefaultText } from '../relay/relay.ts';
import { loadCredentials, removeSessions, saveSession } from '../state/credentials.ts';
import { m, type Text } from '../i18n/index.ts';
import { say, type CommandContext } from './context.ts';

/** `smurg login --help`; the --relay default depends on the built-in relay (../relay/default-relay.ts). */
export function loginUsage(): Text {
  return m('usage.login', { relayDefault: relayDefaultText() });
}

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
  say(ctx, m('login.done', { origin, name: session.user.displayName, userId: session.user.userId }));
  return EXIT.ok;
}

export async function runLogout(argv: readonly string[], ctx: CommandContext): Promise<number> {
  const args = parseArgs(argv, { options: { relay: { kind: 'string' }, all: { kind: 'boolean' }, help: { kind: 'boolean', short: 'h' } } });
  if (args.options['help']) {
    say(ctx, m('usage.logout'));
    return EXIT.ok;
  }
  if (args.options['all'] === true) {
    if (stringOption(args, 'relay') !== undefined) throw usageError(m('logout.allAndRelay'));
    const count = await removeSessions(ctx.paths, 'all');
    say(ctx, count > 0 ? m('logout.all', { count }) : m('logout.allNone'));
    return EXIT.ok;
  }
  const origin = chooseRelay(stringOption(args, 'relay'), ctx.io, await loadCredentials(ctx.paths));
  const count = await removeSessions(ctx.paths, origin);
  say(ctx, count > 0 ? m('logout.done', { origin }) : m('logout.none', { origin }));
  return EXIT.ok;
}
