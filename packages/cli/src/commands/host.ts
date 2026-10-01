// `smurg host <folder> [--relay URL] [--role R] [--expires D] [--max-uses N] [--name N] [--web-origin URL]
//  [--no-keep-awake] [--no-browser] [--no-bash-attribution]`
// (SPEC R1, §6, §11; ARCHITECTURE §8): shares a folder from this machine. `--no-bash-attribution` turns off the Bash
// activity hook (config.activity.attributeBashEdits, §11 D-13). `--role agent` makes the printed link a 「可使用 agent」
// invite (§11 D-15: its members open sessions that run as this machine's user, with the host's Claude login).
//
// The terminal shows only what the host uses or must act on (owner decision 2026-10-01): the two links. What the
// switch means, the SPEC §11 warnings, the fingerprint and keep-awake are explained in docs/HOSTING.md
// (https://smurg.ai/docs/hosting/, named in --help), and `smurg status` shows their state on this machine (stop.ts).
//
//  1. validates the folder (exists, a directory, not the home directory, not a parent of — or inside — the state dir)
//     and refuses a folder that is already being shared;
//  2. logs in to the relay when there is no working session (relay/login.ts ensureSession);
//  3. claims the folder's workspace id at the relay (kept in workspaces.json, so members and the audit log survive);
//  4. runs the daemon in the foreground with DEFAULT_FEATURE_MODULES and keeps the machine awake;
//  5. prints the workspace's name, the host's own link and a guest invite (its expiry, and its role and use limit when
//     the host chose them) — the links go to the terminal only, never to the log file; then, only when it happens,
//     a one-line notice the host must act on: keep-awake refused at the start;
//  6. tells the host when the relay link drops or recovers, when the relay refuses the host's login (and picks up a
//     renewed login from credentials.json without a restart), when that login is about to expire, when a state file
//     cannot be written (reviews REL-08, CLI-03, CLI-10, REL-14) and when keep-awake is lost (CLI-13);
//  7. stops gracefully on Ctrl-C / SIGTERM / SIGHUP or `smurg stop` (another Ctrl-C within 2 s is ignored, a later one
//     leaves at once; CLI-06).
import { createWriteStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FEATURE_MODULES,
  HOMES_PARENTS,
  KeepAwake,
  ShareError,
  ShareLockError,
  StateFileError,
  SocketPathError,
  createDaemon,
  createLineLogger,
  type Daemon,
  type FeatureModule,
  type HostSocketFactory,
  type IdentityKeySource,
  type LocalControlModule,
  type LogFields,
  type Logger,
  type PowerService,
  type PowerStatus,
} from '@smurg/daemon';
import { INVITE_EXPIRES_IN_SEC_MAX, INVITE_MAX_USES_MAX, type GuestRole } from '@smurg/protocol';
import { isRelayApiError } from '@smurg/protocol/client';
import { KeyFileError, ensurePrivateDirectory } from '@smurg/protocol/node';
import { booleanOption, parseArgs, parseCount, parseDuration, stringOption } from '../cli/args.ts';
import { CliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import type { CliSignal } from '../cli/io.ts';
import { ctlPathFor, daemonAt, runningDaemons } from '../channel/discover.ts';
import { ensureSession } from '../relay/login.ts';
import { pickRelay, relayApi, relayDefaultText, relayOriginOf, relayProblem } from '../relay/relay.ts';
import { loadCredentials, type StoredSession } from '../state/credentials.ts';
import { homeDirOf, hostLogPath, workspaceStateDir } from '../state/paths.ts';
import { stateProblem } from '../state/private-file.ts';
import { loadWorkspaces, newWorkspaceId, rememberSharedFolder, sharedFolderFor, type WorkspaceBook } from '../state/workspaces.ts';
import { NativeExtractionError, ensureSeaNative } from '../sea/native.ts';
import { powerState } from '../cli/power-text.ts';
import { say, type CommandContext } from './context.ts';

/** `smurg host --help`; the --relay default depends on the built-in relay (../relay/default-relay.ts). */
export function hostUsage(): string {
  return `用法：smurg host <資料夾> [選項]

  分享這台電腦上的一個專案資料夾，印出兩個連結：你自己的，和給組員的。smurg host 會一直在前景執行，按 Ctrl-C
  或在另一個終端機執行 smurg stop 停止分享。金鑰指紋、設定與紀錄檔的位置：smurg status。
  --relay 網址        relay 的網址（${relayDefaultText()}）
  --role 角色        給組員的連結的角色：agent（可使用 agent）、editor（可編輯，預設）、viewer（旁觀）
                      可使用 agent 的組員開的 session 以你的身分在這台電腦上執行、用你的 Claude 登入，
                      也能在任何 session 裡輸入：只給你完全信任的人
  --expires 期限      給組員的連結的有效期限，例如 30m、12h、7d（預設 7d，最長 365d）
  --max-uses 次數     給組員的連結可以使用的次數（預設不限）
  --name 名稱         工作區顯示的名稱（預設：資料夾名稱）
  --web-origin 網址   連結指向的網頁（預設：relay 本身；本機開發可用 http://localhost:5173）
  --no-keep-awake     分享期間不防止電腦睡眠
  --no-browser        需要登入 relay 時不自動開啟瀏覽器，只顯示網址（SMURG_NO_BROWSER=1 也一樣）
  --no-bash-attribution
                      agent 執行 shell 指令時不通知 smurg（預設通知）

  分享前必讀：https://smurg.ai/docs/hosting/#4-分享前必讀
  「可使用 agent」角色與 --no-bash-attribution 的意思與風險：https://smurg.ai/docs/hosting/#5-可使用-agent角色與-agent-的-shell-指令
`;
}

/** The default of the switch (ARCHITECTURE §11 D-13; the daemon's own default is the same). */
export const HOST_SWITCH_DEFAULTS = Object.freeze({ attributeBashEdits: true });

const ROLE_NAMES: Readonly<Record<GuestRole, string>> = { agent: '可使用 agent', editor: '可編輯', viewer: '旁觀' };
const DEFAULT_ROLE: GuestRole = 'editor';
const DEFAULT_EXPIRES = '7d';
/** daemon.stop() reason when the summary (the invite link) could not be made; only for the log. */
const STOP_SUMMARY_FAILED = 'summary-failed';
const MIN_EXPIRES_SEC = 60;
/** How often the host command looks at the keep-awake status after the start. */
const POWER_WATCH_MS = 2_000;
/** How often the host command re-reads credentials.json for a renewed relay login (reviews REL-08 / CLI-03). */
const CREDENTIALS_WATCH_MS = 5_000;
/** A relay login is renewed before sharing, and the host is reminded while sharing, when it has less left than this. */
export const HOST_SESSION_MIN_VALIDITY_MS = 24 * 3600_000;
/** A dropped relay link is told only when it has not come back within this time (brief blips are not news). */
const LINK_DOWN_NOTICE_MS = 3_000;
/** After the first Ctrl-C, further ones are ignored this long (the stop is running); later ones leave at once (CLI-06). */
const SECOND_SIGNAL_GRACE_MS = 2_000;

/** Test seams for the daemon (the in-memory relay, a test identity issuer, fewer modules, no caffeinate). */
export interface HostDeps {
  readonly daemon?: {
    readonly socketFactory?: HostSocketFactory;
    readonly identityKeys?: IdentityKeySource;
    readonly modules?: readonly FeatureModule[];
    readonly power?: PowerService;
  };
  /** Called once the summary is printed. */
  readonly onReady?: (daemon: Daemon) => void;
  /** TEST ONLY: how often credentials.json is re-read (default CREDENTIALS_WATCH_MS). */
  readonly credentialsWatchMs?: number;
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** The realpath of a folder that may be shared, or a zh-TW refusal. */
export async function validateFolder(ctx: CommandContext, folderArg: string): Promise<string> {
  const absolute = resolve(ctx.io.cwd, folderArg);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    throw usageError(`找不到資料夾：${folderArg}`);
  }
  if (!(await stat(real)).isDirectory()) throw usageError(`${folderArg} 不是資料夾`);
  if (real === '/') throw usageError('不能分享整個檔案系統（/），請指定專案資料夾');
  const home = await realpath(homeDirOf(ctx.io.env)).catch(() => null);
  if (home !== null && real === home) throw usageError('不能分享整個家目錄，請指定專案資料夾', `例如：smurg host ${join(home, 'my-project')}`);
  // CLI-04: a folder that CONTAINS a home directory exposes ~/.ssh, ~/.aws, … to every member (the daemon refuses it too).
  const containsHome = home !== null && isInside(home, real);
  let containsHomes = false;
  for (const homes of HOMES_PARENTS) {
    const homesReal = await realpath(homes).catch(() => null);
    if (homesReal !== null && isInside(homesReal, real)) containsHomes = true;
  }
  if (containsHome || containsHomes) {
    throw usageError('不能分享包含家目錄的資料夾', `家目錄裡有 SSH 金鑰、登入資料等私人檔案，組員會全部看得到。請分享專案資料夾本身${home !== null ? `，例如：smurg host ${join(home, 'my-project')}` : ''}`);
  }
  const stateDir = await realpath(ctx.paths.stateDir).catch(() => resolve(ctx.paths.stateDir));
  if (isInside(stateDir, real)) throw usageError(`不能分享這個資料夾：smurg 的狀態目錄（${ctx.paths.stateDir}）在它裡面`, '狀態目錄裡有金鑰與登入資料，不能讓組員看到。請分享專案資料夾本身。');
  if (isInside(real, stateDir)) throw usageError('不能分享 smurg 狀態目錄裡的資料夾');
  return real;
}

/** Keep-awake that tells the host command when the daemon released it: the last step of daemon.stop(). */
class HostPower implements PowerService {
  private readonly inner: PowerService;
  private resolveReleased: () => void = () => {};
  readonly released: Promise<void>;

  constructor(inner: PowerService) {
    this.inner = inner;
    this.released = new Promise((resolve) => {
      this.resolveReleased = resolve;
    });
  }

  start(): Promise<PowerStatus> {
    return this.inner.start();
  }

  async stop(): Promise<void> {
    try {
      await this.inner.stop();
    } finally {
      this.resolveReleased();
    }
  }

  status(): PowerStatus {
    return this.inner.status();
  }
}

/** How a session runs `smurg hook` / `smurg mcp`: this binary (SEA), or node + this CLI's main.ts (source). */
export function selfCommand(): { file: string; args: string[] } {
  let sea = false;
  try {
    const mod = process.getBuiltinModule?.('node:sea') as { isSea?: () => boolean } | undefined;
    sea = mod?.isSea?.() === true;
  } catch {
    sea = false;
  }
  if (sea) return { file: process.execPath, args: [] };
  return { file: process.execPath, args: [fileURLToPath(new URL('../main.ts', import.meta.url))] };
}

function tee(a: Logger, b: Logger): Logger {
  return {
    debug: (m: string, f?: LogFields) => {
      a.debug(m, f);
      b.debug(m, f);
    },
    info: (m: string, f?: LogFields) => {
      a.info(m, f);
      b.info(m, f);
    },
    warn: (m: string, f?: LogFields) => {
      a.warn(m, f);
      b.warn(m, f);
    },
    error: (m: string, f?: LogFields) => {
      a.error(m, f);
      b.error(m, f);
    },
    child: (fields: LogFields) => tee(a.child(fields), b.child(fields)),
  };
}

/** The daemon's log: everything from info up to `<state>/logs/<workspace>.log` (0600), errors also to stderr. */
async function openLog(ctx: CommandContext, workspaceId: string): Promise<{ logger: Logger; path: string; close(): Promise<void> }> {
  try {
    await ensurePrivateDirectory(ctx.paths.logsDir);
  } catch (err) {
    throw stateProblem(err, '紀錄檔目錄');
  }
  const path = hostLogPath(ctx.paths, workspaceId);
  const stream = createWriteStream(path, { flags: 'a', mode: 0o600 });
  stream.on('error', () => undefined);
  const file = createLineLogger({ level: 'info', write: (line) => stream.write(`${line}\n`) });
  const console = createLineLogger({ level: 'error', write: (line) => ctx.io.stderr.write(`${line}\n`) });
  return {
    logger: tee(file, console),
    path,
    close: () => new Promise<void>((done) => stream.end(() => done())),
  };
}

/**
 * A state file the daemon refuses (review F3): written by another smurg version (protocol 2 has no compatibility with
 * earlier state, ARCHITECTURE §11 D-15) or not in the expected format. The daemon logged which file and why; there is
 * no migration: the way forward is a fresh workspace state.
 */
function stateFileProblem(err: unknown, logPath: string, workspaceDir: string): CliError {
  return new CliError('這個工作區的狀態檔是別的 smurg 版本寫的，或不是預期的格式，daemon 拒絕啟動', {
    hint:
      `哪個檔案、什麼原因記在紀錄檔 ${logPath}。\n  ` +
      `要重新分享：先把 ${workspaceDir} 移到別的地方（例如 mv "${workspaceDir}" "${workspaceDir}.old"），再執行一次 smurg host。` +
      '這會建立新的工作區狀態：之前的成員和邀請連結都不再有效，組員要用新的邀請連結重新加入。\n  ' +
      'daemon 金鑰也會換新，加入過的組員會看到「主人的電腦金鑰和之前不同」：請把 smurg status 顯示的新金鑰指紋用其他管道（當面、電話）告訴他們。',
    cause: err,
  });
}

/** A daemon start failure as the person should read it. */
function daemonProblem(err: unknown, logPath: string, workspaceDir: string): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof ShareError) {
    const text: Record<string, string> = {
      'the shared folder does not exist': '找不到要分享的資料夾',
      'the shared folder is not a directory': '要分享的不是資料夾',
      'the file system root cannot be shared': '不能分享整個檔案系統',
      'the whole home directory cannot be shared': '不能分享整個家目錄',
      'the daemon state directory must not be inside the shared folder': 'smurg 的狀態目錄在要分享的資料夾裡面',
      'the shared folder must not be inside the daemon state directory': '不能分享 smurg 狀態目錄裡的資料夾',
      '.smurg in the shared folder is not a directory': '資料夾裡的 .smurg 不是資料夾，請先移走它',
      'a folder that contains the home directory cannot be shared': '不能分享包含家目錄的資料夾',
      'a folder that contains the home directories cannot be shared': '不能分享包含使用者家目錄的資料夾',
    };
    return new CliError(text[err.message] ?? `無法分享這個資料夾（${err.message}）`, { exitCode: EXIT.usage, cause: err });
  }
  if (err instanceof ShareLockError) {
    // CLI-05: one daemon per folder, whatever its relay or state dir (the daemon's lock in <folder>/.smurg).
    return new CliError(err.reason === 'ancestor-shared' ? '這個資料夾的上層資料夾已經在分享中' : '這個資料夾已經在分享中（可能是另一個 relay 或另一個 smurg 狀態目錄）', {
      hint: '同一個資料夾同時只能由一個 smurg host 分享。用 smurg status 查看，或先停止另一個分享。',
      cause: err,
    });
  }
  if (err instanceof KeyFileError) return stateProblem(err, 'daemon 的金鑰或狀態目錄');
  if (err instanceof StateFileError) return stateFileProblem(err, logPath, workspaceDir);
  if (err instanceof SocketPathError) return new CliError('smurg 狀態目錄的路徑太長，Unix socket 放不下', { hint: '請把 SMURG_HOME 設成較短的路徑。', cause: err });
  const named = err as { name?: unknown; code?: unknown };
  if (named?.name === 'ControlSocketError' && named.code === 'daemon-running') {
    return new CliError('這個工作區已經有 smurg host 在執行', { hint: '用 smurg status 查看，或 smurg stop 停止。', cause: err });
  }
  if (named?.name === 'ControlSocketError') return new CliError('無法建立 daemon 的控制 socket', { hint: `詳細原因請看紀錄檔 ${logPath}`, cause: err });
  return new CliError(`daemon 無法啟動（${err instanceof Error ? err.name : 'unknown'}）`, { hint: `詳細原因請看紀錄檔 ${logPath}`, cause: err });
}

/** 「7 天」, 「12 小時」, 「30 分鐘」 (in days rather than weeks: --expires is written in days). */
function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小時`;
  if (seconds % 60 === 0) return `${seconds / 60} 分鐘`;
  return `${seconds} 秒`;
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseRole(text: string | undefined): GuestRole {
  if (text === undefined) return 'editor';
  if (text === 'agent' || text === 'editor' || text === 'viewer') return text;
  if (text === 'host') throw usageError('邀請連結不能是主人角色（host）', '可用的角色：agent、editor、viewer。');
  throw usageError(`不認得的角色「${text}」`, '可用的角色：agent（可使用 agent）、editor（可編輯）、viewer（旁觀）。');
}

function parseName(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  // eslint-disable-next-line no-control-regex
  if (trimmed.length === 0 || trimmed.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) throw usageError('--name 必須是 1 到 80 個字元、不含控制字元');
  return trimmed;
}

export async function runHost(argv: readonly string[], ctx: CommandContext, deps: HostDeps = {}): Promise<number> {
  const args = parseArgs(argv, {
    options: {
      relay: { kind: 'string' },
      role: { kind: 'string' },
      expires: { kind: 'string' },
      'max-uses': { kind: 'string' },
      name: { kind: 'string' },
      'web-origin': { kind: 'string' },
      'keep-awake': { kind: 'boolean' },
      browser: { kind: 'boolean' },
      'bash-attribution': { kind: 'boolean' },
      help: { kind: 'boolean', short: 'h' },
    },
    positionals: ['資料夾'],
    minPositionals: 1,
  });
  if (args.options['help']) {
    say(ctx, hostUsage());
    return EXIT.ok;
  }
  const { io } = ctx;
  const role = parseRole(stringOption(args, 'role'));
  const expiresInSec = parseDuration(stringOption(args, 'expires') ?? DEFAULT_EXPIRES, '--expires 的期限');
  if (expiresInSec < MIN_EXPIRES_SEC || expiresInSec > INVITE_EXPIRES_IN_SEC_MAX) throw usageError('--expires 必須在 1 分鐘到 365 天之間');
  const maxUsesText = stringOption(args, 'max-uses');
  const maxUses = maxUsesText === undefined ? undefined : parseCount(maxUsesText, '--max-uses ', 1, INVITE_MAX_USES_MAX);
  const name = parseName(stringOption(args, 'name'));
  const keepAwake = booleanOption(args, 'keep-awake') !== false;
  // ARCHITECTURE §11 D-13: on unless the host switches it off (`--no-bash-attribution`; `--x --no-x` is refused).
  const attributeBashEdits = booleanOption(args, 'bash-attribution') ?? HOST_SWITCH_DEFAULTS.attributeBashEdits;
  const webOriginFlag = stringOption(args, 'web-origin');
  // The same rule as for a relay: https, or http on a local hostname (the link carries the invite secret).
  const webOrigin =
    webOriginFlag === undefined ? undefined : relayOriginOf(webOriginFlag, '--web-origin', '網頁網址只能是 https 的網站根網址（本機開發可用 http://localhost:5173）。');
  const folder = await validateFolder(ctx, args.positionals[0] as string);

  const origin = pickRelay(stringOption(args, 'relay'), io, await loadCredentials(ctx.paths)).origin;
  const existing = sharedFolderFor(await loadWorkspaces(ctx.paths), folder, origin);
  const workspaceId = existing?.workspaceId ?? newWorkspaceId();
  // Before any login: a folder that is already shared needs no browser.
  if (await daemonAt(ctlPathFor(ctx.paths, workspaceId))) {
    throw new CliError('這個資料夾已經在分享中', { hint: '用 smurg status 查看，或 smurg stop 停止。' });
  }
  await refuseOverlappingShare(ctx, folder);
  // No notice for the built-in relay here (owner decision 2026-10-01: the start shows only the links): a login names
  // the relay it opens, and `smurg status` names the relay of a running share.
  const { session, user } = await ensureSession(ctx, origin, {
    interactive: true,
    noBrowser: booleanOption(args, 'browser') === false,
    minValidityMs: HOST_SESSION_MIN_VALIDITY_MS,
  });
  try {
    await relayApi(io, origin, { kind: 'bearer', token: session.token }).claimWorkspace(workspaceId);
  } catch (err) {
    if (isRelayApiError(err) && err.status === 409) {
      throw new CliError(`工作區 ID ${workspaceId} 已被 relay 上的其他帳號使用`, { hint: `這個資料夾之前是用別的帳號分享的；目前登入的是 ${user.displayName}（${user.userId}）。` });
    }
    throw relayProblem(err, origin, '建立工作區');
  }
  if (!existing) await rememberSharedFolder(ctx.paths, { folder, relay: origin, workspaceId, createdAt: io.now() });

  // The single executable's native parts (node-pty, the file watcher, …) are extracted and verified before the daemon
  // loads any of them; running from source this does nothing.
  try {
    ensureSeaNative();
  } catch (err) {
    if (err instanceof NativeExtractionError) throw new CliError(`smurg 執行檔內建的原生模組無法使用（${err.message}）`, { hint: '請確認快取目錄可以寫入（可用 SMURG_CACHE_DIR 指定），或重新下載 smurg。', cause: err });
    throw err;
  }
  const log = await openLog(ctx, workspaceId);
  const modules = deps.daemon?.modules ?? DEFAULT_FEATURE_MODULES;
  const power = new HostPower(deps.daemon?.power ?? new KeepAwake({ enabled: keepAwake, log: log.logger.child({ module: 'power' }) }));
  let daemon: Daemon;
  try {
    daemon = await createDaemon({
      config: {
        stateDir: ctx.paths.stateDir,
        shareDir: folder,
        workspaceId,
        hostUserId: user.userId,
        hostName: user.displayName,
        relayUrl: origin,
        ...(webOrigin !== undefined ? { webOrigin } : {}),
        keepAwake,
        ...(name !== undefined ? { workspaceName: name } : {}),
        sessions: { selfCommand: selfCommand() },
        activity: { attributeBashEdits },
      },
      relay: { token: session.token, ...(deps.daemon?.socketFactory ? { socketFactory: deps.daemon.socketFactory } : {}) },
      ...(deps.daemon?.identityKeys ? { identityKeys: deps.daemon.identityKeys } : {}),
      modules,
      log: log.logger,
      power,
      homeDir: homeDirOf(io.env),
    });
  } catch (err) {
    // createDaemon logged why (the state it refused, review F3); the log is flushed before the hint names it.
    await log.close();
    throw daemonProblem(err, log.path, workspaceStateDir(ctx.paths, workspaceId));
  }

  // Stop requests: a signal (Ctrl-C, SIGTERM, a closed terminal) or `smurg stop` on the control socket.
  let stopping: { readonly source: 'signal' | 'control'; readonly reason: string } | null = null;
  let stopStartedAt = 0;
  let wake: () => void = () => {};
  const stopRequested = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const onSignal = (signal: CliSignal): void => {
    if (stopping !== null) {
      // CLI-06: a double Ctrl-C is usually one impatient key press; leaving in the middle of ending the sessions'
      // processes is what can leave them stopped. Only a later Ctrl-C leaves at once.
      if (io.now() - stopStartedAt < SECOND_SIGNAL_GRACE_MS) {
        say(ctx, '正在停止分享（結束 session、清理暫存目錄），請稍候…');
        return;
      }
      say(ctx, '\n再次收到中斷訊號，立即結束（daemon 可能沒有完整停止）。');
      io.exit(EXIT.interrupted);
      return;
    }
    stopStartedAt = io.now();
    stopping = { source: 'signal', reason: signal };
    say(ctx, `\n收到 ${signal}，正在停止分享…`);
    wake();
  };
  const unsubscribe = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => io.onSignal(signal, () => onSignal(signal)));
  // Stops are told apart by what this command knows, never by the reason text (verification F-2: anyone who reaches
  // the control socket used to choose it, and 'start-failed' / 'summary-failed' passed for this command's own stops,
  // so the daemon stopped while the host's terminal still said 「按 Ctrl-C 停止分享」). Every daemon stop this command
  // did not start itself is a stop request; while the daemon is still starting it is told once the start returned (a
  // failed start stops the daemon too, and that failure is reported instead).
  let selfStop = false;
  let starting = true;
  const announceControlStop = (): void => say(ctx, '\n收到停止要求（smurg stop），正在停止分享…');
  const stoppingListener = daemon.ctx.bus.on('daemon.stopping', () => {
    if (stopping !== null || selfStop) return;
    stopping = { source: 'control', reason: 'control' };
    stopStartedAt = io.now();
    if (!starting) announceControlStop();
    wake();
  });
  let powerWatch: ReturnType<typeof setInterval> | undefined;
  let relayWatch: { dispose(): void } | undefined;
  const cleanup = async (): Promise<void> => {
    if (powerWatch !== undefined) clearInterval(powerWatch);
    relayWatch?.dispose();
    for (const off of unsubscribe) off();
    stoppingListener.dispose();
    // The control socket closes just after the rest of the daemon stopped (src/local/module.ts in @smurg/daemon):
    // `smurg stop` in another terminal returns when it is gone, so this process ends right after.
    await Promise.all(modules.map((m) => ('whenClosed' in m ? (m as LocalControlModule).whenClosed() : undefined)));
    await log.close();
  };

  try {
    await daemon.start();
  } catch (err) {
    await cleanup();
    throw daemonProblem(err, log.path, workspaceStateDir(ctx.paths, workspaceId));
  }
  starting = false;
  if ((stopping as { readonly source: 'signal' | 'control' } | null)?.source === 'control') announceControlStop();

  if (stopping === null) {
    try {
      printSummary(ctx, daemon, { role, expiresInSec, maxUses, userId: user.userId });
    } catch (err) {
      selfStop = true;
      await daemon.stop(STOP_SUMMARY_FAILED).catch(() => {});
      await cleanup();
      throw err instanceof CliError ? err : new CliError('無法建立邀請連結', { cause: err });
    }
    // Keep-awake the system refused at the start (polkit over SSH, no systemd-inhibit): one line, after the links.
    // Switched off with --no-keep-awake (reason 'disabled') is the host's own choice: nothing to tell.
    const startPower = daemon.status().power;
    if (!startPower.active && startPower.reason !== 'disabled') say(ctx, `\n${keepAwakeNotice(startPower)}`);
    // Keep-awake that is lost later (the inhibitor exited, e.g. no logind session) is told here, not only in the log.
    let keptAwake = startPower.active;
    powerWatch = setInterval(() => {
      const power = daemon.status().power;
      if (keptAwake && !power.active && stopping === null) say(ctx, `\n⚠ 防止睡眠已失效：${powerState(power)}。電腦睡眠時組員會看到「主人已離線」。`);
      keptAwake = power.active;
    }, POWER_WATCH_MS);
    powerWatch.unref?.();
    relayWatch = watchRelay(ctx, daemon, { origin, userId: user.userId, session }, () => stopping !== null, deps.credentialsWatchMs ?? CREDENTIALS_WATCH_MS);
    deps.onReady?.(daemon);
  }

  await stopRequested;
  const how = stopping as unknown as { source: 'signal' | 'control'; reason: string };
  if (how.source === 'signal') await daemon.stop(how.reason);
  else await power.released; // daemon.stop() is already running (started from the control socket); keep-awake is its last step
  await cleanup();
  say(ctx, '已停止分享。');
  return EXIT.ok;
}

/**
 * CLI-05: a folder inside, or around, a folder that a running `smurg host` of this state dir shares, whatever the
 * relay. The daemon's own lock (`<folder>/.smurg/daemon-lock.json`) also covers other state dirs sharing the same
 * folder or one of its ancestors.
 */
async function refuseOverlappingShare(ctx: CommandContext, folder: string): Promise<void> {
  const running = await runningDaemons(ctx.paths);
  if (running.length === 0) return;
  const book: WorkspaceBook = await loadWorkspaces(ctx.paths);
  for (const daemon of running) {
    for (const entry of book.shared.filter((e) => e.workspaceId === daemon.status.workspaceId)) {
      if (!isInside(folder, entry.folder) && !isInside(entry.folder, folder)) continue;
      const what =
        entry.folder === folder
          ? '這個資料夾已經在分享中'
          : isInside(folder, entry.folder)
            ? `這個資料夾的上層資料夾（${entry.folder}）已經在分享中`
            : `這個資料夾裡的 ${entry.folder} 已經在分享中`;
      throw new CliError(what, { hint: `同一份檔案同時只能由一個 smurg host 分享（工作區 ${daemon.status.workspaceId}，relay ${entry.relay}）。用 smurg status 查看，或先用 smurg stop --workspace ${daemon.status.workspaceId} 停止它。` });
    }
  }
}

interface RelayWatchTarget {
  readonly origin: string;
  readonly userId: string;
  readonly session: StoredSession;
}

/**
 * Reviews REL-08 / CLI-03 / CLI-10 / REL-14: what the daemon only logged is told on the host's terminal — the relay
 * link dropping and coming back, the relay refusing the host's login (members cannot connect until the host logs in
 * again), a login that is about to expire, and a state file the disk refuses. A renewed login (`smurg login` in another
 * terminal writes credentials.json) is handed to the running daemon (Daemon.updateRelayToken): no restart, no new links.
 */
export function watchRelay(ctx: CommandContext, daemon: Daemon, target: RelayWatchTarget, stopped: () => boolean, intervalMs: number): { dispose(): void } {
  let token = target.session.token;
  let expiresAt = target.session.expiresAt;
  let expiryWarned = false;
  let otherAccountWarned: string | null = null;
  let shown: 'online' | 'down' | 'auth' = 'online';
  let downTimer: ReturnType<typeof setTimeout> | undefined;
  const loginHint = `smurg login --relay ${target.origin}`;
  const tell = (text: string): void => {
    if (!stopped()) say(ctx, text);
  };
  const cancelDownNotice = (): void => {
    if (downTimer !== undefined) clearTimeout(downTimer);
    downTimer = undefined;
  };
  const onLink = daemon.ctx.bus.on('relay.link', ({ purpose, state }) => {
    if (purpose !== 'interactive') return; // the transfer link follows the same login and network: one notice is enough
    if (state === 'online') {
      cancelDownNotice();
      if (shown !== 'online') tell('✓ 已重新連上 relay，組員可以再次連線。');
      shown = 'online';
    } else if (state === 'auth-rejected') {
      cancelDownNotice();
      if (shown !== 'auth') {
        tell(`\n⚠ relay 拒絕了這台電腦的登入（登入已過期或已失效），組員目前無法連線。\n  請在另一個終端機執行 ${loginHint}；smurg host 會自動改用新的登入並重新連線，不必重新分享。`);
      }
      shown = 'auth';
    } else if (state === 'waiting' && shown === 'online' && downTimer === undefined) {
      downTimer = setTimeout(() => {
        downTimer = undefined;
        if (shown !== 'online') return;
        shown = 'down';
        tell('\n⚠ 與 relay 的連線中斷，組員暫時無法連線；正在自動重新連線…');
      }, LINK_DOWN_NOTICE_MS);
      downTimer.unref?.();
    }
    // 'connecting' changes nothing that was told; 'replaced' is logged as an error by the daemon (stderr).
  });
  const unsaved = new Set<string>();
  const onState = daemon.ctx.bus.on('state.write', ({ document, ok }) => {
    if (!ok) {
      const first = unsaved.size === 0;
      unsaved.add(document);
      if (first) {
        tell(
          '\n⚠ 無法寫入 smurg 的狀態檔（磁碟已滿或沒有權限？）。剛才的變更（例如踢人、改角色、撤銷邀請）現在有效，' +
            '但在寫入成功之前停止分享的話，重新啟動後會消失；smurg 會持續重試。',
        );
      }
    } else if (unsaved.delete(document) && unsaved.size === 0) {
      tell('✓ smurg 的狀態檔已重新寫入成功。');
    }
  });
  let busy = false;
  const poll = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      let stored: StoredSession | undefined;
      try {
        stored = (await loadCredentials(ctx.paths)).relays[target.origin];
      } catch {
        stored = undefined; // an unreadable file: keep the current login
      }
      const now = ctx.io.now();
      if (stored !== undefined && stored.token !== token && stored.expiresAt > now) {
        if (stored.userId !== target.userId) {
          // The workspace belongs to the account that claimed it: another account's token would be refused anyway.
          if (otherAccountWarned !== stored.token) tell(`\n⚠ ${target.origin} 的新登入是另一個帳號（${stored.displayName}），這個工作區屬於原本的帳號，smurg host 不會改用它。`);
          otherAccountWarned = stored.token;
        } else {
          token = stored.token;
          expiresAt = stored.expiresAt;
          expiryWarned = false;
          daemon.updateRelayToken(token);
          tell('已改用新的 relay 登入。');
        }
      }
      if (!expiryWarned && expiresAt - now < HOST_SESSION_MIN_VALIDITY_MS) {
        expiryWarned = true;
        tell(`\n⚠ relay 的登入將在 ${formatTime(expiresAt)} 到期，到期後組員無法連線。請在另一個終端機執行 ${loginHint}；smurg host 會自動改用新的登入。`);
      }
    })().finally(() => {
      busy = false;
    });
  }, intervalMs);
  poll.unref?.();
  return {
    dispose: () => {
      clearInterval(poll);
      cancelDownNotice();
      onLink.dispose();
      onState.dispose();
    },
  };
}

/** Keep-awake that is not in force although the host did not switch it off (linux-binary F5): one line. */
function keepAwakeNotice(status: PowerStatus): string {
  return `⚠ 防止睡眠：${powerState(status)}。電腦睡眠時組員會看到「主人已離線」。`;
}

/** 「給組員的連結（用私訊傳給他們，7 天內有效）：」: the expiry always, the use limit and the role only when chosen. */
export function inviteHeading(role: GuestRole, expiresInSec: number, maxUses: number | undefined): string {
  const terms = ['用私訊傳給他們', `${formatDuration(expiresInSec)}內有效`];
  if (maxUses !== undefined) terms.push(`可以使用 ${maxUses} 次`);
  if (role !== DEFAULT_ROLE) terms.push(`角色：${ROLE_NAMES[role]}`);
  return `給組員的連結（${terms.join('，')}）：`;
}

/**
 * The start summary (owner decision 2026-10-01): the workspace's name, the two links, how to stop. Nothing else: the
 * rest is in docs/HOSTING.md and `smurg status`. The links carry their one-time secrets: the terminal only, never the
 * log.
 */
function printSummary(ctx: CommandContext, daemon: Daemon, s: { role: GuestRole; expiresInSec: number; maxUses: number | undefined; userId: string }): void {
  const principal = daemon.ctx.members.principalOf(s.userId);
  if (!principal) throw new CliError('找不到主人的成員資料，無法建立邀請連結');
  const { url } = daemon.ctx.invites.create({ role: s.role, expiresInSec: s.expiresInSec, ...(s.maxUses !== undefined ? { maxUses: s.maxUses } : {}) }, principal);
  say(
    ctx,
    [
      '',
      `smurg 正在分享「${daemon.ctx.workspace.info.name}」`,
      '',
      '你的連結（只給你自己用）：',
      `  ${daemon.hostInviteUrl ?? '（無法建立）'}`,
      '',
      inviteHeading(s.role, s.expiresInSec, s.maxUses),
      `  ${url}`,
      '',
      '按 Ctrl-C 停止分享。',
    ].join('\n'),
  );
}
