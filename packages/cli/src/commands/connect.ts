// `smurg connect slack|discord [folder] --channel <id> [--relay URL]` and `smurg disconnect slack|discord [folder]
// [--relay URL]` (DESIGN 0.8.0 D6.2): one Slack channel and one Discord channel per shared folder's workspace, kept in
// ~/.smurg/connectors.json (../state/connectors.ts, mode 0600). The workspace is the one `smurg host <folder>` with the
// same relay shares (workspaces.json); a folder never shared from this computer is refused.
//
// The channel id is checked by its source's pattern (the daemon checks it again whenever it reads the entry), and the
// token is read without echo (`io.readSecret`: never from the command line, which `ps` and the shell history see, nor
// from the environment, which every agent session inherits), checked by its form, and written to the file only. No
// request is made to Slack or Discord here, and nothing is sent to a running daemon: `smurg host` reads the file again
// every few seconds (never through the control socket, which agent sessions can reach).
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isOutsideBotToken, isOutsideChannelId, type OutsideSource } from '@smurg/protocol';
import { parseArgs, stringOption } from '../cli/args.ts';
import { CliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import { m } from '../i18n/index.ts';
import { pickRelay } from '../relay/relay.ts';
import { connectChannel, disconnectChannel } from '../state/connectors.ts';
import { loadCredentials } from '../state/credentials.ts';
import { lookUpSharedFolder } from '../state/workspaces.ts';
import { say, tr, type CommandContext } from './context.ts';

function sourceOf(text: string): OutsideSource {
  if (text === 'slack' || text === 'discord') return text;
  throw usageError(m('connect.source.unknown', { source: text }), m('connect.source.hint'));
}

/** The shared folder (default: the working directory) and the workspace `smurg host` shares it as. */
async function workspaceOf(ctx: CommandContext, folderArg: string | undefined, relayFlag: string | undefined): Promise<{ readonly folder: string; readonly workspaceId: string }> {
  const given = folderArg ?? '.';
  let folder: string;
  try {
    folder = await realpath(resolve(ctx.io.cwd, given));
  } catch {
    throw usageError(m('host.folder.notFound', { folder: given }));
  }
  if (!(await stat(folder)).isDirectory()) throw usageError(m('host.folder.notDirectory', { folder: given }));
  const origin = pickRelay(relayFlag, ctx.io, await loadCredentials(ctx.paths)).origin;
  const known = await lookUpSharedFolder(ctx.paths, folder, origin);
  if (known.entry === null) throw new CliError(m('connect.notShared', { folder }), { hint: m('connect.notShared.hint') });
  return { folder, workspaceId: known.entry.workspaceId };
}

export async function runConnect(argv: readonly string[], ctx: CommandContext): Promise<number> {
  const args = parseArgs(argv, {
    options: { channel: { kind: 'string' }, relay: { kind: 'string' }, help: { kind: 'boolean', short: 'h' } },
    positionals: [m('arg.source'), m('arg.folder')],
    minPositionals: 1,
  });
  if (args.options['help']) {
    say(ctx, m('usage.connect'));
    return EXIT.ok;
  }
  const source = sourceOf(args.positionals[0] as string);
  const channel = stringOption(args, 'channel');
  if (channel === undefined) throw usageError(m('connect.channel.missing'), m('connect.channel.hint', { source }));
  if (!isOutsideChannelId(source, channel)) throw usageError(m('connect.channel.invalid', { source }), m('connect.channel.hint', { source }));
  const { folder, workspaceId } = await workspaceOf(ctx, args.positionals[1], stringOption(args, 'relay'));
  const typed = await ctx.io.readSecret(tr(ctx, m('connect.token.prompt', { source })));
  if (typed === null) throw new CliError(m('connect.token.missing'));
  const token = typed.trim();
  if (!isOutsideBotToken(source, token)) throw new CliError(m('connect.token.invalid', { source }), { hint: m('connect.token.hint', { source }) });
  const before = await connectChannel(ctx.paths, workspaceId, source, { token, channel, connectedAt: ctx.io.now() });
  say(ctx, m('connect.done', { source, channel, folder }));
  if (before !== null && before.channel !== channel) say(ctx, m('connect.replaced', { source, channel: before.channel }));
  return EXIT.ok;
}

export async function runDisconnect(argv: readonly string[], ctx: CommandContext): Promise<number> {
  const args = parseArgs(argv, {
    options: { relay: { kind: 'string' }, help: { kind: 'boolean', short: 'h' } },
    positionals: [m('arg.source'), m('arg.folder')],
    minPositionals: 1,
  });
  if (args.options['help']) {
    say(ctx, m('usage.disconnect'));
    return EXIT.ok;
  }
  const source = sourceOf(args.positionals[0] as string);
  const { folder, workspaceId } = await workspaceOf(ctx, args.positionals[1], stringOption(args, 'relay'));
  const gone = await disconnectChannel(ctx.paths, workspaceId, source);
  if (gone === undefined) say(ctx, m('disconnect.none', { source, folder }));
  else if (gone === null) say(ctx, m('disconnect.unread', { source, folder }));
  else say(ctx, m('disconnect.done', { source, channel: gone.channel, folder }));
  return EXIT.ok;
}
