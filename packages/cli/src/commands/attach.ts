// `smurg attach [session] [--workspace W] [--invite -|URL] [--relay URL] [--no-browser] [--accept-new-key]` (SPEC R4, ARCHITECTURE §8):
//  - a `smurg host` of that workspace runs on this machine → attach through its control socket, as the host;
//  - otherwise → join through the relay with the CLI device key (first time: an invite; later: the pinned daemon key).
// The invite link carries its secret after `#`: it is read from a prompt (`--invite -`, not echoed) or SMURG_INVITE,
// so it stays out of argv (`ps`) and shell history; a link given on the command line still works, with a warning.
// Without a session it lists the sessions; with one it takes over the terminal (attach/attach-session.ts).
// `smurg attach` is a terminal for TERMINAL sessions. An agent session is a conversation (no PTY): the list shows it
// with its topic, status and title and says where conversations open (the workspace's address in the web app), and
// naming one as the session to attach is refused with that sentence (exit 2). No terminal client for conversations.
// An invite whose daemon key differs from the key this device pinned for the workspace (the host started over with new
// workspace keys, HOSTING §5.1 / §8 — or someone poses as the host) is explained and used only after the person's
// explicit yes at a terminal or --accept-new-key (the web app asks the same question).
// A `smurg host` of ANOTHER smurg version on this machine (0.5.1, DESIGN B1/B2): its control socket is alive and this
// command cannot read its answer, or the attach succeeds and a later message cannot be decoded. Both end the command at
// once with "another version of smurg is sharing here: stop it and start it again" (channel/local-channel.ts).
// A member refused through the relay with `version` learns who has to act from what `smurg update` would find
// (update/version-advice.ts, DESIGN B3): the refusal itself carries nothing but that word.
import { hostname } from 'node:os';
import {
  InviteLinkError,
  can,
  collectPages,
  daemonKeyFingerprint,
  equalBytes,
  formatFingerprintForDisplay,
  parseInviteUrl,
  type AgentSession,
  type AgentStatus,
  type SessionInfo,
  type TerminalSession,
} from '@smurg/protocol';
import type { ConnectionRelay } from '@smurg/protocol/client';
import { readPinnedDaemonKey } from '@smurg/protocol/node';
import { booleanOption, parseArgs, stringOption } from '../cli/args.ts';
import { clipColumn, padColumn } from '../cli/columns.ts';
import { CliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import type { WorkspaceChannel } from '../channel/channel.ts';
import { ctlPathFor, hintedWorkspace, probeDaemon, probeDaemons, unreadableLabel } from '../channel/discover.ts';
import { LocalWorkspaceChannel, otherVersionAttachError } from '../channel/local-channel.ts';
import { RelayWorkspaceChannel } from '../channel/relay-channel.ts';
import { ensureSession } from '../relay/login.ts';
import { DEFAULT_RELAY_URL } from '../relay/default-relay.ts';
import { builtInRelayNotice, pickRelay, relayApi, relayOriginOf, workspaceAddress } from '../relay/relay.ts';
import { loadCredentials, sessionFor } from '../state/credentials.ts';
import { loadWorkspaces, rememberJoined, type JoinedWorkspace } from '../state/workspaces.ts';
import type { UpdateNoticeDeps } from '../update/notice.ts';
import { versionRefusalAdvice } from '../update/version-advice.ts';
import { attachSession, readOnlyNotice, sessionTitle, signalExitCode, type AttachOutcome } from '../attach/attach-session.ts';
import { localeIsUtf8 } from '../attach/output-filter.ts';
import { m, renderText, type Locale, type MessageId, type Text } from '../i18n/index.ts';
import { say, tr, type CommandContext } from './context.ts';

/** `smurg attach --help`; the --relay default depends on the built-in relay (../relay/default-relay.ts). */
export function attachUsage(): Text {
  return m('usage.attach', { relayDefault: DEFAULT_RELAY_URL === null ? m('attach.relayDefault.none') : m('attach.relayDefault.builtIn', { url: DEFAULT_RELAY_URL }) });
}

/** Tests inject the relay transport (an in-memory relay); production uses RelayApi with the stored session. */
export interface AttachDeps {
  readonly relayFor?: (origin: string) => Promise<ConnectionRelay>;
  /** The seams of the lookup after a `version` refusal (the executable, its version, fetch, the timeout). */
  readonly update?: UpdateNoticeDeps;
}

/** The name this device has in the host's member list: one spelling for every language (docs/GLOSSARY.md). */
export function deviceName(host: string = hostname()): string {
  const name = host.replace(/\.local$/, '').slice(0, 64);
  return name === '' ? 'smurg CLI' : `smurg CLI (${name})`;
}

function statusText(s: TerminalSession): Text {
  if (s.status === 'exited') return m('attach.status.exited', { exitCode: s.exitCode ?? 0 });
  return m(s.status === 'starting' ? 'attach.status.starting' : 'attach.status.running');
}

/** An agent session's status in the list (the words of the web app's session list, docs/GLOSSARY.md). */
const AGENT_STATUS: Readonly<Record<AgentStatus, MessageId>> = {
  starting: 'attach.status.starting',
  running: 'attach.status.running',
  'waiting-answer': 'attach.agent.waitingAnswer',
  'waiting-permission': 'attach.agent.waitingPermission',
  idle: 'attach.agent.idle',
  stalled: 'attach.agent.stalled',
  done: 'attach.agent.done',
  failed: 'attach.agent.failed',
  ended: 'attach.agent.ended',
};

/** The sessions `smurg attach` attaches to: terminals. An agent session is a conversation, not a PTY. */
export function terminalSessions(sessions: readonly SessionInfo[]): TerminalSession[] {
  return sessions.filter((session): session is TerminalSession => session.kind === 'terminal');
}

/** The agent sessions, a topic's sessions together (topics in the order they first appear), free sessions last. */
export function agentSessions(sessions: readonly SessionInfo[]): AgentSession[] {
  const agents = sessions.filter((session): session is AgentSession => session.kind === 'agent');
  const topics = new Map<string, number>();
  for (const session of agents) if (session.topicId !== undefined && !topics.has(session.topicId)) topics.set(session.topicId, topics.size);
  const rank = (session: AgentSession): number => (session.topicId === undefined ? topics.size : (topics.get(session.topicId) as number));
  return [...agents].sort((a, b) => rank(a) - rank(b));
}

/** The line that says where agent conversations open; `webUrl` is the workspace's address there (null: not known). */
export function browserSentence(webUrl: string | null): Text {
  return m('attach.agents.browser', webUrl === null ? {} : { url: webUrl });
}

/**
 * Column widths (terminal cells) of the two tables; the headers of both catalogs are spaced to them. `id` is the length
 * of a session id (`ses_` and 32 hex digits): narrower, every row would stand four cells to the right of its header.
 */
const COLUMNS = Object.freeze({ number: 4, id: 36, kind: 8, owner: 12, status: 10, agentStatus: 24, topic: 24 });

/**
 * What `smurg attach` prints without a session: the terminals, numbered (a number picks one), then the agent sessions
 * with status, topic and title, then how to attach and where conversations open.
 */
export function formatSessionList(sessions: readonly SessionInfo[], me: string, lang: Locale, webUrl: string | null = null): string {
  const tr = (text: Text): string => renderText(lang, text);
  const row = (cells: readonly (readonly [string, number])[], last: string): string => `${cells.map(([text, width]) => padColumn(text, width)).join('  ')}  ${last}`;
  const terminals = terminalSessions(sessions);
  const agents = agentSessions(sessions);
  if (terminals.length === 0 && agents.length === 0) return tr(m('attach.list.empty'));
  const lines: string[] = [];
  if (terminals.length === 0) lines.push(tr(m('attach.list.noTerminals')));
  else {
    lines.push(tr(m('attach.list.header')));
    terminals.forEach((s, i) => {
      const owner = s.openedBy.userId === me ? tr(m('attach.owner.you', { name: s.openedBy.displayName })) : s.openedBy.displayName;
      lines.push(
        row(
          [
            [String(i + 1), COLUMNS.number],
            [s.id, COLUMNS.id],
            [tr(m('attach.kind.terminal')), COLUMNS.kind],
            [owner, COLUMNS.owner],
            [tr(statusText(s)), COLUMNS.status],
          ],
          tr(sessionTitle(s)),
        ),
      );
    });
  }
  if (agents.length > 0) {
    lines.push('', tr(m('attach.agents.heading')), tr(m('attach.agents.header')));
    for (const s of agents) {
      const topic = s.topicName ?? tr(m('attach.agents.noTopic'));
      lines.push(
        row(
          [
            [s.id, COLUMNS.id],
            [tr({ id: AGENT_STATUS[s.status] }), COLUMNS.agentStatus],
            [clipColumn(topic, COLUMNS.topic), COLUMNS.topic],
          ],
          tr(sessionTitle(s)),
        ),
      );
    }
  }
  lines.push('');
  if (terminals.length > 0) lines.push(tr(m('attach.list.footer')));
  if (agents.length > 0) lines.push(tr(browserSentence(webUrl)));
  return lines.join('\n');
}

/**
 * `2` (a terminal's number in the list), a full id, or a unique id prefix. The id may be an agent session's: the caller
 * says where conversations open instead of attaching.
 */
export function pickSession(sessions: readonly SessionInfo[], wanted: string): SessionInfo {
  if (/^\d{1,4}$/.test(wanted)) {
    const byIndex = terminalSessions(sessions)[Number(wanted) - 1];
    if (byIndex) return byIndex;
  }
  const exact = sessions.find((s) => s.id === wanted);
  if (exact) return exact;
  const prefixed = sessions.filter((s) => s.id.startsWith(wanted));
  if (prefixed.length === 1) return prefixed[0] as SessionInfo;
  if (prefixed.length > 1) throw usageError(m('attach.pick.ambiguous', { wanted }));
  throw usageError(m('attach.pick.notFound', { wanted }), m('attach.pick.notFound.hint'));
}

interface Target {
  readonly kind: 'local' | 'relay';
  readonly workspaceId: string;
  readonly ctlPath?: string;
  readonly relay?: string;
  readonly invite?: { readonly fingerprint: Uint8Array; readonly secret: Uint8Array };
  /**
   * The origin of the workspace's web app, where agent conversations open: what the local daemon names (null: it has
   * none, no relay); for a join through the relay the invite link's origin, else the one remembered from the first
   * join, else the relay itself (which serves the web app).
   */
  readonly webOrigin: string | null;
}

async function resolveTarget(ctx: CommandContext, flags: { workspace?: string; invite?: string; relay?: string }): Promise<Target> {
  const credentials = await loadCredentials(ctx.paths);
  if (flags.invite !== undefined) {
    let parsed;
    try {
      parsed = parseInviteUrl(flags.invite);
    } catch (err) {
      if (err instanceof InviteLinkError) throw usageError(m('attach.invite.bad'), m('attach.invite.bad.hint'));
      throw err;
    }
    if (flags.workspace !== undefined && flags.workspace !== parsed.workspaceId) throw usageError(m('attach.invite.otherWorkspace'));
    // The invite's origin is the web origin, which is the relay in production (the relay serves the web app).
    const relay = flags.relay !== undefined ? relayOriginOf(flags.relay) : relayOriginOf(parsed.origin, 'invite');
    return { kind: 'relay', workspaceId: parsed.workspaceId, relay, invite: { fingerprint: parsed.fingerprint, secret: parsed.secret }, webOrigin: parsed.origin };
  }
  const relayTarget = (workspaceId: string, relay: string, joined: JoinedWorkspace | undefined): Target => ({ kind: 'relay', workspaceId, relay, webOrigin: joined?.web ?? relay });
  const hinted = await hintedWorkspace(ctx.paths, flags.workspace, ctx.io.cwd);
  if (hinted !== null) {
    const ctlPath = ctlPathFor(ctx.paths, hinted);
    const local = await probeDaemon(ctlPath);
    if (local.kind === 'running') return { kind: 'local', workspaceId: hinted, ctlPath, webOrigin: local.daemon.webOrigin };
    // A smurg host of another version shares this workspace here: said at once, and never taken for "not running on
    // this computer" (which would go on to join this machine's own workspace through the relay).
    if (local.kind === 'unreadable') throw otherVersionAttachError(local.daemon.why);
    const joined = (await loadWorkspaces(ctx.paths)).joined.find((j) => j.workspaceId === hinted);
    if (flags.relay !== undefined) return relayTarget(hinted, relayOriginOf(flags.relay), joined);
    if (joined !== undefined) return relayTarget(hinted, joined.relay, joined);
    // Neither the flag nor a remembered join: SMURG_RELAY_URL, the last login, or the built-in relay.
    const chosen = pickRelay(undefined, ctx.io, credentials);
    if (chosen.source === 'built-in') say(ctx, builtInRelayNotice(chosen.origin));
    return relayTarget(hinted, chosen.origin, undefined);
  }
  const { running, unreadable } = await probeDaemons(ctx.paths);
  if (running.length + unreadable.length > 1) {
    throw usageError(m('attach.several'), m('attach.several.hint', { ids: [...running.map((d) => d.status.workspaceId), ...unreadable.map(unreadableLabel)] }));
  }
  if (running.length === 1) {
    const only = running[0] as (typeof running)[number];
    return { kind: 'local', workspaceId: only.status.workspaceId, ctlPath: only.ctlPath, webOrigin: only.webOrigin };
  }
  // The only share on this computer is a smurg host of another version: that is the one this command means.
  if (unreadable.length === 1) throw otherVersionAttachError((unreadable[0] as (typeof unreadable)[number]).why);
  const joined = (await loadWorkspaces(ctx.paths)).joined;
  if (joined.length === 1) {
    const only = joined[0] as (typeof joined)[number];
    return relayTarget(only.workspaceId, flags.relay !== undefined ? relayOriginOf(flags.relay) : only.relay, only);
  }
  throw usageError(m('attach.noTarget'), m('attach.noTarget.hint'));
}

/**
 * Logins are kept per origin. An invite link carries the WEB origin, which is the relay itself in production but not
 * in development (Vite on :5173 in front of the relay on :8787): say so before a login starts for an origin the person
 * has never used while they are logged in elsewhere.
 */
async function explainLoginOrigin(ctx: CommandContext, origin: string): Promise<void> {
  const credentials = await loadCredentials(ctx.paths);
  const now = ctx.io.now();
  if (sessionFor(credentials, origin, now)) return;
  const others = Object.keys(credentials.relays).filter((o) => o !== origin && sessionFor(credentials, o, now) !== null);
  if (others.length === 0) return;
  say(ctx, m('attach.loginOrigin', { others, origin, first: others[0] as string }));
}

/** What `smurg attach` says when the invite's daemon key is not the one this device pinned. */
export function keyChangeNotice(pinned: string, invited: string): Text {
  return m('attach.keyChange', { pinned, invited });
}

/**
 * Verification M1: the invite names another daemon key than the pin of this workspace. Never accepted silently (SPEC
 * R3): the person reads why and both fingerprints, then answers y at a terminal or passed --accept-new-key; only then
 * the connection prefers the invite (its key is verified against the invite's `k` and replaces the pin). Returns
 * whether to prefer the invite; throws when the person did not confirm (nothing was sent, the pin is unchanged).
 */
async function confirmNewHostKey(ctx: CommandContext, target: Target, accept: boolean): Promise<boolean> {
  const invite = target.invite;
  if (target.kind !== 'relay' || invite === undefined) return false;
  // An unreadable pin is the connection's to report (storage-error), as it is without an invite.
  const pinned = await readPinnedDaemonKey(ctx.paths.stateDir, target.workspaceId).catch(() => null);
  if (pinned === null) return false;
  const pinnedFingerprint = daemonKeyFingerprint(pinned);
  if (equalBytes(pinnedFingerprint, invite.fingerprint)) return false;
  ctx.io.stderr.write(`${tr(ctx, keyChangeNotice(formatFingerprintForDisplay(pinnedFingerprint), formatFingerprintForDisplay(invite.fingerprint)))}\n`);
  if (accept) {
    ctx.io.stderr.write(tr(ctx, m('attach.keyChange.accepted')));
    return true;
  }
  const answer = await ctx.io.readLine(tr(ctx, m('attach.keyChange.question')));
  if (answer !== null && /^(?:y|yes)$/i.test(answer)) return true;
  throw new CliError(m('attach.keyChange.cancelled'), { hint: m(answer === null ? 'attach.keyChange.cancelled.noTerminal' : 'attach.keyChange.cancelled.hint') });
}

async function openChannel(ctx: CommandContext, target: Target, deps: AttachDeps, noBrowser: boolean, acceptNewKey: boolean): Promise<WorkspaceChannel> {
  if (target.kind === 'local') return LocalWorkspaceChannel.open(target.ctlPath as string, { deviceName: deviceName() });
  const origin = target.relay as string;
  const preferInvite = await confirmNewHostKey(ctx, target, acceptNewKey);
  if (!deps.relayFor) await explainLoginOrigin(ctx, origin);
  const relay = deps.relayFor
    ? await deps.relayFor(origin)
    : relayApi(ctx.io, origin, { kind: 'bearer', token: (await ensureSession(ctx, origin, { interactive: true, noBrowser })).session.token });
  const channel = await RelayWorkspaceChannel.open({
    relay,
    workspaceId: target.workspaceId,
    stateDir: ctx.paths.stateDir,
    invite: target.invite ?? null,
    ...(preferInvite ? { preferInvite: true } : {}),
    deviceName: deviceName(),
    versionRefused: () => versionRefusalAdvice(ctx.io, deps.update),
  });
  // The web app's origin is remembered only when it is not the relay itself (a development setup: Vite in front).
  const web = target.webOrigin !== null && target.webOrigin !== origin ? { web: target.webOrigin } : {};
  await rememberJoined(ctx.paths, { workspaceId: target.workspaceId, relay: origin, name: channel.welcome.workspace.name, joinedAt: ctx.io.now(), ...web });
  return channel;
}

/**
 * The invite link: `--invite -` asks for it (not echoed), else SMURG_INVITE, else a link given on the command line,
 * which works but leaves the secret in `ps` and the shell history (SPEC R3: the link is the trust anchor).
 */
export async function inviteLink(ctx: CommandContext, flag: string | undefined, workspace?: string): Promise<string | undefined> {
  if (flag === '-') {
    const typed = await ctx.io.readSecret(tr(ctx, m('attach.invite.prompt')));
    if (typed === null) throw usageError(m('attach.invite.none'), m('attach.invite.none.hint'));
    return typed;
  }
  if (flag !== undefined) {
    ctx.io.stderr.write(tr(ctx, m('attach.invite.onCommandLine')));
    return flag;
  }
  const env = ctx.io.env['SMURG_INVITE']?.trim();
  if (env === undefined || env === '') return undefined;
  // A link left in the environment must not get in the way of another workspace named with --workspace.
  if (workspace !== undefined) {
    try {
      if (parseInviteUrl(env).workspaceId !== workspace) return undefined;
    } catch {
      return undefined;
    }
  }
  return env;
}

export function exitCodeOf(outcome: AttachOutcome): number {
  switch (outcome.kind) {
    case 'detached':
      return EXIT.ok;
    case 'exited':
      return Number.isInteger(outcome.exitCode) && outcome.exitCode >= 0 && outcome.exitCode <= 255 ? outcome.exitCode : EXIT.failure;
    case 'signal':
      return signalExitCode(outcome.signal);
    case 'ended':
      return EXIT.failure;
  }
}

export async function runAttach(argv: readonly string[], ctx: CommandContext, deps: AttachDeps = {}): Promise<number> {
  const args = parseArgs(argv, {
    options: {
      workspace: { kind: 'string' },
      invite: { kind: 'string' },
      relay: { kind: 'string' },
      browser: { kind: 'boolean' },
      'accept-new-key': { kind: 'boolean' },
      help: { kind: 'boolean', short: 'h' },
    },
    positionals: [m('arg.session')],
  });
  if (args.options['help']) {
    say(ctx, attachUsage());
    return EXIT.ok;
  }
  const wanted = args.positionals[0];
  const terminal = ctx.io.terminal;
  if (wanted !== undefined && !terminal.isTTY) throw usageError(m('attach.needsTerminal'));
  const invite = await inviteLink(ctx, stringOption(args, 'invite'), stringOption(args, 'workspace'));
  const flags = {
    ...(stringOption(args, 'workspace') !== undefined ? { workspace: stringOption(args, 'workspace') as string } : {}),
    ...(invite !== undefined ? { invite } : {}),
    ...(stringOption(args, 'relay') !== undefined ? { relay: stringOption(args, 'relay') as string } : {}),
  };
  const target = await resolveTarget(ctx, flags);
  const channel = await openChannel(ctx, target, deps, booleanOption(args, 'browser') === false, booleanOption(args, 'accept-new-key') === true);
  try {
    const me = channel.welcome.member.userId;
    // `session.list` follows the list rule: read every page.
    const listed = await collectPages(async (after) => {
      const page = await channel.request('session.list', after === undefined ? {} : { after });
      return { items: page.sessions, hasMore: page.hasMore };
    }, (session) => session.id);
    const webUrl = target.webOrigin === null ? null : workspaceAddress(target.webOrigin, target.workspaceId);
    if (wanted === undefined) {
      const name = channel.welcome.workspace.name;
      say(ctx, target.kind === 'local' ? m('attach.list.workspace.local', { name, workspaceId: target.workspaceId }) : m('attach.list.workspace.relay', { name, workspaceId: target.workspaceId, relay: target.relay as string }));
      say(ctx, formatSessionList(listed, me, ctx.lang, webUrl));
      return EXIT.ok;
    }
    const session = pickSession(listed, wanted);
    const title = sessionTitle(session);
    // A conversation has no PTY to attach to: say where it opens (the same sentence as under the list).
    if (session.kind === 'agent') throw usageError(m('attach.agents.notTerminal', { title }), browserSentence(webUrl));
    if (session.status === 'exited') throw new CliError(m('attach.sessionExited', { title, exitCode: session.exitCode ?? 0 }));
    const isOwner = session.openedBy.userId === me;
    say(ctx, m(isOwner ? 'attach.attaching.own' : 'attach.attaching.other', { title, owner: session.openedBy.displayName }));
    if (!can(channel.welcome.member.role, 'session.drive')) say(ctx, readOnlyNotice(session));
    const outcome = await attachSession({ channel, session, terminal, io: ctx.io, lang: ctx.lang, utf8: localeIsUtf8(ctx.io.env) });
    return exitCodeOf(outcome);
  } finally {
    channel.close();
  }
}
