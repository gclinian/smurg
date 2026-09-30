// `smurg host <folder> [--relay URL] [--role R] [--expires D] [--max-uses N] [--name N] [--web-origin URL]
//  [--no-keep-awake] [--no-browser] [--no-guest-subscription-login] [--no-bash-attribution]`
// (SPEC R1, §6, §11; ARCHITECTURE §8): shares a folder from this machine. The two `--no-…` switches turn off the guests'
// subscription login process (config.sessions.guestSubscriptionLogin, §11 D-12) and the Bash activity hook
// (config.activity.attributeBashEdits, §11 D-13); the summary explains both when on and echoes them when off.
//
//  1. validates the folder (exists, a directory, not the home directory, not a parent of — or inside — the state dir)
//     and refuses a folder that is already being shared;
//  2. logs in to the relay when there is no working session (browser loopback login; the browser is opened only when
//     CliIo.openUrl allows it, never with --no-browser / SMURG_NO_BROWSER, see cli/io.ts browserBlock);
//  3. claims the folder's workspace id at the relay (kept in workspaces.json, so members and the audit log survive);
//  4. runs the daemon in the foreground with DEFAULT_FEATURE_MODULES and keeps the machine awake;
//  5. prints the host's own link, a guest invite (role / expiry / uses), the daemon key fingerprint to compare out of
//     band, the onboarding warnings of SPEC §11 and the keep-awake status — invite links go to the terminal only, never
//     to the log file;
//  6. tells the host when the relay link drops or recovers, when the relay refuses the host's login (and picks up a
//     renewed login from credentials.json without a restart), when that login is about to expire and when a state
//     file cannot be written (reviews REL-08, CLI-03, CLI-10, REL-14);
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
  isStubService,
  type Daemon,
  type FeatureModule,
  type HostSocketFactory,
  type IdentityKeySource,
  type LocalControlModule,
  type LogFields,
  type Logger,
  type PowerService,
  type PowerStatus,
  type SandboxPreflight,
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
import { builtInRelayNotice, pickRelay, relayApi, relayDefaultText, relayOriginOf, relayProblem, type RelaySource } from '../relay/relay.ts';
import { loadCredentials, type StoredSession } from '../state/credentials.ts';
import { homeDirOf } from '../state/paths.ts';
import { stateProblem } from '../state/private-file.ts';
import { loadWorkspaces, newWorkspaceId, rememberSharedFolder, sharedFolderFor, type WorkspaceBook } from '../state/workspaces.ts';
import { NativeExtractionError, ensureSeaNative } from '../sea/native.ts';
import { powerState } from '../cli/power-text.ts';
import { say, type CommandContext } from './context.ts';

/** `smurg host --help`; the --relay default depends on the built-in relay (../relay/default-relay.ts). */
export function hostUsage(): string {
  return `用法：smurg host <資料夾> [選項]

  分享這台電腦上的一個專案資料夾，並印出邀請連結。smurg host 會一直在前景執行，按 Ctrl-C 或在另一個終端機
  執行 smurg stop 停止分享。
  --relay 網址        relay 的網址（${relayDefaultText()}）
  --role 角色        邀請連結的角色：runner（可執行 agent）、editor（可編輯，預設）、viewer（旁觀）
  --expires 期限      邀請連結的有效期限，例如 30m、12h、7d（預設 7d，最長 365d）
  --max-uses 次數     邀請連結可以使用的次數（預設不限）
  --name 名稱         工作區顯示的名稱（預設：資料夾名稱）
  --web-origin 網址   邀請連結指向的網頁（預設：relay 本身；本機開發可用 http://localhost:5173）
  --no-keep-awake     分享期間不防止電腦睡眠
  --no-browser        需要登入 relay 時不自動開啟瀏覽器，只顯示網址（SMURG_NO_BROWSER=1 也一樣）
  --no-guest-subscription-login
                      不讓組員用 Claude 訂閱帳號登入（預設開放：smurg 在組員的沙盒裡另外執行 claude auth login，
                      登入期間只有這個登入程序可以在這台電腦上開網路埠）；關閉後組員只能用自己的 API key
  --no-bash-attribution
                      agent 執行 shell 指令時不通知 smurg（預設會通知指令的開始與結束，不含指令內容）；關閉後
                      agent 用 shell 指令改的檔案，在活動動態裡顯示為「外部程式」
`;
}

/** The defaults of the two switches (ARCHITECTURE §11 D-12, D-13; the daemon's own defaults are the same). */
export const HOST_SWITCH_DEFAULTS = Object.freeze({ guestSubscriptionLogin: true, attributeBashEdits: true });

const ROLE_NAMES: Readonly<Record<GuestRole, string>> = { runner: '可執行 agent', editor: '可編輯', viewer: '旁觀' };
const DEFAULT_EXPIRES = '7d';
/** daemon.stop() reasons this command uses itself (the daemon's own 'start-failed' included). */
const INTERNAL_STOP_START_FAILED = 'start-failed';
const INTERNAL_STOP_SUMMARY_FAILED = 'summary-failed';
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
  const path = join(ctx.paths.logsDir, `${workspaceId}.log`);
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

/** A daemon start failure as the person should read it. */
function daemonProblem(err: unknown, logPath: string): CliError {
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
  if (err instanceof StateFileError) return new CliError('工作區的狀態檔損毀，daemon 拒絕啟動', { hint: `詳細原因請看紀錄檔 ${logPath}`, cause: err });
  if (err instanceof SocketPathError) return new CliError('smurg 狀態目錄的路徑太長，Unix socket 放不下', { hint: '請把 SMURG_HOME 設成較短的路徑。', cause: err });
  const named = err as { name?: unknown; code?: unknown };
  if (named?.name === 'ControlSocketError' && named.code === 'daemon-running') {
    return new CliError('這個工作區已經有 smurg host 在執行', { hint: '用 smurg status 查看，或 smurg stop 停止。', cause: err });
  }
  if (named?.name === 'ControlSocketError') return new CliError('無法建立 daemon 的控制 socket', { hint: `詳細原因請看紀錄檔 ${logPath}`, cause: err });
  return new CliError(`daemon 無法啟動（${err instanceof Error ? err.name : 'unknown'}）`, { hint: `詳細原因請看紀錄檔 ${logPath}`, cause: err });
}

function formatDuration(seconds: number): string {
  if (seconds % 604_800 === 0) return `${seconds / 604_800} 週`;
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

function powerText(status: PowerStatus): string {
  if (status.active) return `${powerState(status)}。注意：闔上筆電螢幕仍然會進入睡眠。`;
  return `${powerState(status)}。電腦睡眠時組員會看到「主人已離線」。`;
}

function parseRole(text: string | undefined): GuestRole {
  if (text === undefined) return 'editor';
  if (text === 'runner' || text === 'editor' || text === 'viewer') return text;
  if (text === 'host') throw usageError('邀請連結不能是主人角色（host）', '可用的角色：runner、editor、viewer。');
  throw usageError(`不認得的角色「${text}」`, '可用的角色：runner（可執行 agent）、editor（可編輯）、viewer（旁觀）。');
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
      'guest-subscription-login': { kind: 'boolean' },
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
  // ARCHITECTURE §11 D-12 / D-13: both on unless the host switches them off (`--no-…`; `--x --no-x` is refused).
  const switches: HostSwitches = {
    guestSubscriptionLogin: booleanOption(args, 'guest-subscription-login') ?? HOST_SWITCH_DEFAULTS.guestSubscriptionLogin,
    attributeBashEdits: booleanOption(args, 'bash-attribution') ?? HOST_SWITCH_DEFAULTS.attributeBashEdits,
  };
  const webOriginFlag = stringOption(args, 'web-origin');
  // The same rule as for a relay: https, or http on a local hostname (the link carries the invite secret).
  const webOrigin =
    webOriginFlag === undefined ? undefined : relayOriginOf(webOriginFlag, '--web-origin', '網頁網址只能是 https 的網站根網址（本機開發可用 http://localhost:5173）。');
  const folder = await validateFolder(ctx, args.positionals[0] as string);

  const relay = pickRelay(stringOption(args, 'relay'), io, await loadCredentials(ctx.paths));
  const origin = relay.origin;
  const existing = sharedFolderFor(await loadWorkspaces(ctx.paths), folder, origin);
  const workspaceId = existing?.workspaceId ?? newWorkspaceId();
  // Before any login: a folder that is already shared needs no browser.
  if (await daemonAt(ctlPathFor(ctx.paths, workspaceId))) {
    throw new CliError('這個資料夾已經在分享中', { hint: '用 smurg status 查看，或 smurg stop 停止。' });
  }
  await refuseOverlappingShare(ctx, folder);
  if (relay.source === 'built-in') say(ctx, builtInRelayNotice(origin));
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
        sessions: { selfCommand: selfCommand(), guestSubscriptionLogin: switches.guestSubscriptionLogin },
        activity: { attributeBashEdits: switches.attributeBashEdits },
      },
      relay: { token: session.token, ...(deps.daemon?.socketFactory ? { socketFactory: deps.daemon.socketFactory } : {}) },
      ...(deps.daemon?.identityKeys ? { identityKeys: deps.daemon.identityKeys } : {}),
      modules,
      log: log.logger,
      power,
      homeDir: homeDirOf(io.env),
    });
  } catch (err) {
    await log.close();
    throw daemonProblem(err, log.path);
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
  const stoppingListener = daemon.ctx.bus.on('daemon.stopping', ({ reason }) => {
    // A failed start stops the daemon itself; this command reports that failure on its own.
    if (stopping !== null || reason === INTERNAL_STOP_START_FAILED || reason === INTERNAL_STOP_SUMMARY_FAILED) return;
    stopping = { source: 'control', reason };
    stopStartedAt = io.now();
    say(ctx, '\n收到停止要求（smurg stop），正在停止分享…');
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
    throw daemonProblem(err, log.path);
  }

  if (stopping === null) {
    try {
      // What the daemon runs with (not merely what was asked for) is what the host is told.
      const inForce: HostSwitches = { guestSubscriptionLogin: daemon.config.sessions.guestSubscriptionLogin, attributeBashEdits: daemon.config.activity.attributeBashEdits };
      printSummary(ctx, daemon, { origin, relaySource: relay.source, webOrigin: daemon.config.webOrigin, folder, role, expiresInSec, maxUses, userId: user.userId, logPath: log.path, switches: inForce });
    } catch (err) {
      await daemon.stop(INTERNAL_STOP_SUMMARY_FAILED).catch(() => {});
      await cleanup();
      throw err instanceof CliError ? err : new CliError('無法建立邀請連結', { cause: err });
    }
    // Keep-awake that is lost later (the inhibitor exited, e.g. no logind session) is told here, not only in the log.
    let keptAwake = daemon.status().power.active;
    powerWatch = setInterval(() => {
      const power = daemon.status().power;
      if (keptAwake && !power.active && stopping === null) say(ctx, `\n⚠ 防止睡眠已失效：${powerState(power)}。電腦睡眠時組員會看到「主人已離線」。`);
      keptAwake = power.active;
    }, POWER_WATCH_MS);
    powerWatch.unref?.();
    relayWatch = watchRelay(ctx, daemon, { origin, userId: user.userId, session }, () => stopping !== null, deps.credentialsWatchMs ?? CREDENTIALS_WATCH_MS);
    deps.onReady?.(daemon);
    // Not awaited: the summary is out; the guest sandbox check (a real sandboxed self-test) reports when it is done.
    void reportGuestSandbox(ctx, daemon, () => stopping !== null);
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

/** Linux fixes the host can run themselves (the refusal text itself is written for guests). */
export function sandboxFix(reason: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'linux') return [];
  if (reason === 'apparmor-userns') {
    return [
      '  Ubuntu 24.04 以上的修正方法（只放寬 bubblewrap，建議）：',
      "    printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile smurg-bwrap /usr/bin/bwrap flags=(unconfined) {\\n  userns,\\n}\\n' | sudo tee /etc/apparmor.d/smurg-bwrap >/dev/null",
      '    sudo apparmor_parser -r /etc/apparmor.d/smurg-bwrap',
      '  或（放寬整台電腦的限制，不建議）：sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
      '  修正後重新執行 smurg host。',
    ];
  }
  if (reason === 'dependency-missing') {
    // The daemon gives this reason both for a missing program and for a bubblewrap older than 0.8 (no
    // --disable-userns / --chmod, sandbox/checks.ts checkBwrapFeatures): installing does not help the second case.
    return [
      '  修正方法（Ubuntu / Debian）：sudo apt-get install bubblewrap socat ripgrep，然後重新執行 smurg host。',
      '  bubblewrap 需要 0.8 以上的版本（用 bwrap --version 查看）：Ubuntu 24.04、Debian 12 以上內建的版本即可；Ubuntu 22.04 內建的 0.6 太舊，',
      '  需要更新作業系統或另外安裝較新的 bubblewrap。',
    ];
  }
  return [];
}

/**
 * CLI-02 (SPEC R5): the host learns right after the start, not second-hand from a refused guest, whether runner
 * guests can open sessions here. The daemon's sandbox check is the same one a guest session goes through.
 */
export async function reportGuestSandbox(ctx: CommandContext, daemon: Daemon, stopped: () => boolean): Promise<void> {
  const sandbox = daemon.ctx.services.sandbox;
  if (isStubService(sandbox)) return; // a daemon without the sandbox module (tests)
  let result: SandboxPreflight;
  try {
    result = await sandbox.preflight();
  } catch {
    result = { ok: false, reason: 'preflight-error' };
  }
  if (stopped()) return;
  if (result.ok) {
    say(ctx, '客人沙盒：可用（runner 角色的組員可以在這台電腦上開 session，並且只能存取分享的資料夾）。');
    return;
  }
  say(
    ctx,
    [
      `⚠ 客人沙盒：無法使用（${result.reason}）。${result.detail ?? ''}`,
      ...sandboxFix(result.reason),
      '  在修好之前，runner 角色的組員無法在這台電腦上開 session；其他功能（檔案、共同編輯、你自己的 session）不受影響。',
    ].join('\n'),
  );
}

/** The two switches of `smurg host` (config.sessions.guestSubscriptionLogin, config.activity.attributeBashEdits). */
export interface HostSwitches {
  readonly guestSubscriptionLogin: boolean;
  readonly attributeBashEdits: boolean;
}

/**
 * What the two switches mean for the host (ARCHITECTURE §11 D-12, D-13), in the start summary: a switch left at its
 * default is explained (what it lets happen on this machine, and how to turn it off); a switch turned off is echoed.
 */
export function switchLines(switches: HostSwitches): string[] {
  const lines = ['■ 組員的 Claude 登入與 agent 的 shell 指令'];
  if (switches.guestSubscriptionLogin) {
    lines.push(
      '  · 組員可以用自己的 Claude 訂閱帳號登入：smurg 會在那位組員的沙盒裡另外執行一個登入程序（claude auth login，',
      '    最多 10 分鐘）。登入期間，這個登入程序可以在這台電腦上開一個網路埠，等待登入完成；除了它之外，組員的程式',
      '    （agent、終端機）都不能開網路埠。登入程序讀不到分享的資料夾，也連不到這台電腦上的其他服務。',
      '    不想開放的話，停止分享後加上 --no-guest-subscription-login 重新執行，組員就只能用自己的 API key 登入。',
    );
  } else {
    lines.push('  · 組員的 Claude 訂閱登入：已關閉（--no-guest-subscription-login）。組員只能用自己的 API key 登入。');
  }
  if (switches.attributeBashEdits) {
    lines.push(
      '  · 每個 agent（包括你自己的）執行 shell 指令時，會通知這台電腦上的 smurg 指令何時開始、何時結束（不含指令內容',
      '    和輸出），這樣 agent 用 shell 指令改的檔案，在活動動態裡會標示是哪個 agent 改的。',
      '    不想要的話，停止分享後加上 --no-bash-attribution 重新執行。',
    );
  } else {
    lines.push('  · agent 的 shell 指令通知：已關閉（--no-bash-attribution）。agent 用 shell 指令改的檔案，在活動動態裡顯示為「外部程式」。');
  }
  return lines;
}

function printSummary(
  ctx: CommandContext,
  daemon: Daemon,
  s: {
    origin: string;
    relaySource: RelaySource;
    webOrigin: string;
    folder: string;
    role: GuestRole;
    expiresInSec: number;
    maxUses: number | undefined;
    userId: string;
    logPath: string;
    switches: HostSwitches;
  },
): void {
  const principal = daemon.ctx.members.principalOf(s.userId);
  if (!principal) throw new CliError('找不到主人的成員資料，無法建立邀請連結');
  const { invite, url } = daemon.ctx.invites.create({ role: s.role, expiresInSec: s.expiresInSec, ...(s.maxUses !== undefined ? { maxUses: s.maxUses } : {}) }, principal);
  const hostUrl = daemon.hostInviteUrl;
  const info = daemon.ctx.workspace.info;
  const expiresAt = invite.expiresAt ?? ctx.io.now() + s.expiresInSec * 1000;
  // Everything below goes to the terminal only (never the log): the links carry their one-time secrets.
  say(
    ctx,
    [
      '',
      `smurg：開始分享「${info.name}」`,
      `  資料夾：${s.folder}`,
      `  工作區：${daemon.workspaceId}（relay：${s.origin}${s.relaySource === 'built-in' ? '，smurg 內建的公用 relay' : ''}）`,
      ...(s.webOrigin !== s.origin ? [`  網頁：${s.webOrigin}`] : []),
      '',
      '■ 你自己的連結（主人專用，只能使用一次，7 天內有效；不要分享給別人）',
      `  ${hostUrl ?? '（無法建立）'}`,
      '',
      `■ 邀請組員的連結（角色：${ROLE_NAMES[s.role]}；有效期限：${formatDuration(s.expiresInSec)}，到 ${formatTime(expiresAt)}；可使用次數：${s.maxUses === undefined ? '不限' : `${s.maxUses} 次`}）`,
      `  ${url}`,
      '  連結裡 # 之後的部分就是密鑰，請用私訊傳給組員，不要貼在公開的地方。',
      '',
      `■ daemon 金鑰指紋：${daemon.fingerprint}`,
      '  組員第一次加入時可以用其他管道（當面、電話）和你核對這組指紋，確認沒有人冒充你。',
      '',
      '⚠ 分享前請先了解：',
      '  1. 你自己的 Claude Code session 不在沙盒裡，而且會讀到組員寫入或修改的檔案。檔案裡可能藏有要 agent 執行的指示',
      '     （prompt injection）。請保留 Claude Code 的權限確認，不要自動核准，並留意最近被組員修改過的檔案。',
      '  2. 組員在這台電腦上執行 agent 時，他們的 Claude 登入憑證會存放在這台電腦上（用訂閱帳號或 API key 登入都一樣），',
      '     技術上你讀得到。請組員使用有花費上限的 API key；組員離開或被移出時，smurg 會登出並刪除他們的暫存目錄。',
      '  3. 組員只能在 smurg host 執行、而且這台電腦連線時使用這個工作區。',
      '',
      ...switchLines(s.switches),
      '',
      `防止睡眠：${powerText(daemon.status().power)}`,
      `daemon 紀錄檔：${s.logPath}（不含邀請連結）`,
      '按 Ctrl-C，或在另一個終端機執行 smurg stop，即可停止分享。',
      '',
    ].join('\n'),
  );
}
