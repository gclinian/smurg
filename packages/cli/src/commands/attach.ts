// `smurg attach [session] [--workspace W] [--invite -|URL] [--relay URL] [--no-browser]` (SPEC R4, ARCHITECTURE §8):
//  - a `smurg host` of that workspace runs on this machine → attach through its control socket, as the host;
//  - otherwise → join through the relay with the CLI device key (first time: an invite; later: the pinned daemon key).
// The invite link carries its secret after `#`: it is read from a prompt (`--invite -`, not echoed) or SMURG_INVITE,
// so it stays out of argv (`ps`) and shell history; a link given on the command line still works, with a warning.
// Without a session it lists the sessions; with one it takes over the terminal (attach/attach-session.ts).
import { hostname } from 'node:os';
import { InviteLinkError, parseInviteUrl, type SessionInfo } from '@smurg/protocol';
import type { ConnectionRelay } from '@smurg/protocol/client';
import { booleanOption, parseArgs, stringOption } from '../cli/args.ts';
import { CliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import type { WorkspaceChannel } from '../channel/channel.ts';
import { ctlPathFor, daemonAt, hintedWorkspace, runningDaemons } from '../channel/discover.ts';
import { LocalWorkspaceChannel } from '../channel/local-channel.ts';
import { RelayWorkspaceChannel } from '../channel/relay-channel.ts';
import { ensureSession } from '../relay/login.ts';
import { DEFAULT_RELAY_URL } from '../relay/default-relay.ts';
import { builtInRelayNotice, pickRelay, relayApi, relayOriginOf } from '../relay/relay.ts';
import { loadCredentials, sessionFor } from '../state/credentials.ts';
import { loadWorkspaces, rememberJoined } from '../state/workspaces.ts';
import { attachSession, readOnlyNotice, signalExitCode, type AttachOutcome } from '../attach/attach-session.ts';
import { localeIsUtf8 } from '../attach/output-filter.ts';
import { say, type CommandContext } from './context.ts';

/** `smurg attach --help`; the --relay default depends on the built-in relay (../relay/default-relay.ts). */
export function attachUsage(): string {
  const relayDefault = DEFAULT_RELAY_URL === null ? '邀請連結的網址或上次使用的 relay' : `邀請連結的網址、上次使用的 relay，或內建的公用 relay ${DEFAULT_RELAY_URL}`;
  return `用法：smurg attach [session] [--workspace 工作區ID] [--invite -|邀請連結] [--relay 網址] [--no-browser]

  把 agent session 接到這個終端機。不指定 session 時列出所有 session。
  session 可以是列表中的編號、session ID 或 ID 的開頭。
  這台電腦正在分享該工作區時（smurg host），直接以主人身分接上；否則透過 relay 以這台電腦的裝置金鑰加入。
  --invite -          第一次加入別人的工作區：執行後貼上主人給的邀請連結（不會顯示在畫面上）。
                      也可以把連結放在環境變數 SMURG_INVITE。只有第一次需要，之後用 --workspace 即可。
                      直接把連結寫在命令列（--invite 連結）也可以，但連結裡的密鑰會留在 shell 的歷史紀錄，
                      執行期間也會出現在程序列表（ps）裡。
  --workspace ID      指定工作區（預設：目前資料夾所分享的工作區，或唯一一個）
  --relay 網址        relay 的網址（預設：${relayDefault}）
  --no-browser        需要登入 relay 時不自動開啟瀏覽器，只顯示網址（SMURG_NO_BROWSER=1 也一樣）

  接上之後：按 Ctrl-] 離開（session 繼續執行）。只有 session 的擁有者可以輸入，其他人是唯讀。
`;
}

/** Tests inject the relay transport (an in-memory relay); production uses RelayApi with the stored session. */
export interface AttachDeps {
  readonly relayFor?: (origin: string) => Promise<ConnectionRelay>;
}

function deviceName(): string {
  const host = hostname().replace(/\.local$/, '').slice(0, 64);
  return `smurg CLI（${host || '這台電腦'}）`;
}

function statusText(s: SessionInfo): string {
  if (s.status === 'exited') return `已結束（${s.exitCode ?? 0}）`;
  return s.status === 'starting' ? '啟動中' : '執行中';
}

export function formatSessionList(sessions: readonly SessionInfo[], me: string): string {
  if (sessions.length === 0) return '這個工作區目前沒有 session。';
  const lines = ['編號  session ID                        類型      擁有者        狀態        標題'];
  sessions.forEach((s, i) => {
    // 'login' (§11 D-12): the member's own Claude login process; the daemon lists it to its owner only.
    const kind = s.kind === 'agent' ? 'agent' : s.kind === 'login' ? '登入程序' : '終端機';
    const owner = s.ownerUserId === me ? `${s.ownerName}（你）` : s.ownerName;
    lines.push(`${String(i + 1).padEnd(4)}  ${s.id.padEnd(32)}  ${kind.padEnd(8)}  ${owner.padEnd(12)}  ${statusText(s).padEnd(10)}  ${s.title}`);
  });
  lines.push('', '用 smurg attach <編號或 session ID> 接上。');
  return lines.join('\n');
}

/** `2`, a full id, or a unique id prefix. */
export function pickSession(sessions: readonly SessionInfo[], wanted: string): SessionInfo {
  if (/^\d{1,4}$/.test(wanted)) {
    const index = Number(wanted) - 1;
    const byIndex = sessions[index];
    if (byIndex) return byIndex;
  }
  const exact = sessions.find((s) => s.id === wanted);
  if (exact) return exact;
  const prefixed = sessions.filter((s) => s.id.startsWith(wanted));
  if (prefixed.length === 1) return prefixed[0] as SessionInfo;
  if (prefixed.length > 1) throw usageError(`「${wanted}」符合多個 session，請輸入更長的 ID`);
  throw usageError(`找不到 session「${wanted}」`, '不指定 session 執行 smurg attach 可以列出所有 session。');
}

interface Target {
  readonly kind: 'local' | 'relay';
  readonly workspaceId: string;
  readonly ctlPath?: string;
  readonly relay?: string;
  readonly invite?: { readonly fingerprint: Uint8Array; readonly secret: Uint8Array };
}

async function resolveTarget(ctx: CommandContext, flags: { workspace?: string; invite?: string; relay?: string }): Promise<Target> {
  const credentials = await loadCredentials(ctx.paths);
  if (flags.invite !== undefined) {
    let parsed;
    try {
      parsed = parseInviteUrl(flags.invite);
    } catch (err) {
      if (err instanceof InviteLinkError) throw usageError('邀請連結不正確', '請完整複製主人給的連結（包含 # 之後的部分）。');
      throw err;
    }
    if (flags.workspace !== undefined && flags.workspace !== parsed.workspaceId) throw usageError('--workspace 和邀請連結的工作區不一致');
    // The invite's origin is the web origin, which is the relay in production (the relay serves the web app).
    const relay = flags.relay !== undefined ? relayOriginOf(flags.relay) : relayOriginOf(parsed.origin, '邀請連結');
    return { kind: 'relay', workspaceId: parsed.workspaceId, relay, invite: { fingerprint: parsed.fingerprint, secret: parsed.secret } };
  }
  const hinted = await hintedWorkspace(ctx.paths, flags.workspace, ctx.io.cwd);
  if (hinted !== null) {
    const ctlPath = ctlPathFor(ctx.paths, hinted);
    if (await daemonAt(ctlPath)) return { kind: 'local', workspaceId: hinted, ctlPath };
    const joined = (await loadWorkspaces(ctx.paths)).joined.find((j) => j.workspaceId === hinted);
    if (flags.relay !== undefined) return { kind: 'relay', workspaceId: hinted, relay: relayOriginOf(flags.relay) };
    if (joined !== undefined) return { kind: 'relay', workspaceId: hinted, relay: joined.relay };
    // Neither the flag nor a remembered join: SMURG_RELAY_URL, the last login, or the built-in relay.
    const chosen = pickRelay(undefined, ctx.io, credentials);
    if (chosen.source === 'built-in') say(ctx, builtInRelayNotice(chosen.origin));
    return { kind: 'relay', workspaceId: hinted, relay: chosen.origin };
  }
  const running = await runningDaemons(ctx.paths);
  if (running.length === 1) {
    const only = running[0] as (typeof running)[number];
    return { kind: 'local', workspaceId: only.status.workspaceId, ctlPath: only.ctlPath };
  }
  if (running.length > 1) throw usageError('這台電腦有多個工作區正在分享，請用 --workspace 指定', `正在分享：${running.map((d) => d.status.workspaceId).join('、')}`);
  const joined = (await loadWorkspaces(ctx.paths)).joined;
  if (joined.length === 1) {
    const only = joined[0] as (typeof joined)[number];
    return { kind: 'relay', workspaceId: only.workspaceId, relay: flags.relay !== undefined ? relayOriginOf(flags.relay) : only.relay };
  }
  throw usageError('不知道要接上哪個工作區', '第一次加入請用 --invite -（執行後貼上邀請連結）；之後可以用 --workspace <工作區ID>。');
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
  say(
    ctx,
    [
      `注意：這台電腦登入過 ${others.join('、')}，但還沒有登入 ${origin}（登入是依網址分開記錄的）。`,
      `  如果 ${origin} 只是同一個 relay 的網頁（例如本機開發時的網頁伺服器），可以按 Ctrl-C，加上 --relay ${others[0]} 再執行一次；`,
      `  否則請先執行  smurg login --relay ${origin}  。`,
    ].join('\n'),
  );
}

async function openChannel(ctx: CommandContext, target: Target, deps: AttachDeps, noBrowser: boolean): Promise<WorkspaceChannel> {
  if (target.kind === 'local') return LocalWorkspaceChannel.open(target.ctlPath as string, { deviceName: deviceName() });
  const origin = target.relay as string;
  if (!deps.relayFor) await explainLoginOrigin(ctx, origin);
  const relay = deps.relayFor
    ? await deps.relayFor(origin)
    : relayApi(ctx.io, origin, { kind: 'bearer', token: (await ensureSession(ctx, origin, { interactive: true, noBrowser })).session.token });
  const channel = await RelayWorkspaceChannel.open({ relay, workspaceId: target.workspaceId, stateDir: ctx.paths.stateDir, invite: target.invite ?? null, deviceName: deviceName() });
  await rememberJoined(ctx.paths, { workspaceId: target.workspaceId, relay: origin, name: channel.welcome.workspace.name, joinedAt: ctx.io.now() });
  return channel;
}

/**
 * The invite link: `--invite -` asks for it (not echoed), else SMURG_INVITE, else a link given on the command line,
 * which works but leaves the secret in `ps` and the shell history (SPEC R3: the link is the trust anchor).
 */
export async function inviteLink(ctx: CommandContext, flag: string | undefined, workspace?: string): Promise<string | undefined> {
  if (flag === '-') {
    const typed = await ctx.io.readSecret('請貼上主人給的邀請連結（不會顯示在畫面上），然後按 Enter：');
    if (typed === null) throw usageError('沒有收到邀請連結', '請重新執行，貼上完整的連結（包含 # 之後的部分）後按 Enter。');
    return typed;
  }
  if (flag !== undefined) {
    ctx.io.stderr.write(
      '注意：寫在命令列上的邀請連結（含密鑰）會留在 shell 的歷史紀錄，執行期間也會出現在程序列表（ps）裡。' +
        '下次請改用 --invite -（執行後貼上連結）或環境變數 SMURG_INVITE；加入過一次之後只需要 --workspace。\n',
    );
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
    options: { workspace: { kind: 'string' }, invite: { kind: 'string' }, relay: { kind: 'string' }, browser: { kind: 'boolean' }, help: { kind: 'boolean', short: 'h' } },
    positionals: ['session'],
  });
  if (args.options['help']) {
    say(ctx, attachUsage());
    return EXIT.ok;
  }
  const wanted = args.positionals[0];
  const terminal = ctx.io.terminal;
  if (wanted !== undefined && !terminal.isTTY) throw usageError('smurg attach 需要在終端機中執行（標準輸入和輸出都必須是終端機）');
  const invite = await inviteLink(ctx, stringOption(args, 'invite'), stringOption(args, 'workspace'));
  const flags = {
    ...(stringOption(args, 'workspace') !== undefined ? { workspace: stringOption(args, 'workspace') as string } : {}),
    ...(invite !== undefined ? { invite } : {}),
    ...(stringOption(args, 'relay') !== undefined ? { relay: stringOption(args, 'relay') as string } : {}),
  };
  const target = await resolveTarget(ctx, flags);
  const channel = await openChannel(ctx, target, deps, booleanOption(args, 'browser') === false);
  try {
    const me = channel.welcome.member.userId;
    const { sessions } = await channel.request('session.list', {});
    if (wanted === undefined) {
      say(ctx, `工作區「${channel.welcome.workspace.name}」（${target.workspaceId}，${target.kind === 'local' ? '本機' : `透過 relay ${target.relay as string}`}）`);
      say(ctx, formatSessionList(sessions, me));
      return EXIT.ok;
    }
    const session = pickSession(sessions, wanted);
    if (session.status === 'exited') throw new CliError(`session「${session.title}」已經結束（結束代碼 ${session.exitCode ?? 0}）`);
    const isOwner = session.ownerUserId === me;
    say(ctx, `接上 session「${session.title}」（${session.ownerName}${isOwner ? '，你的 session' : ''}）。按 Ctrl-] 離開。`);
    if (!isOwner) say(ctx, readOnlyNotice(session));
    const outcome = await attachSession({ channel, session, terminal, io: ctx.io, utf8: localeIsUtf8(ctx.io.env) });
    return exitCodeOf(outcome);
  } finally {
    channel.close();
  }
}
