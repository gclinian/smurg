// `smurg stop [--workspace W]` and `smurg status [--workspace W]`: through the daemon's control socket (ARCHITECTURE
// §8). stop asks the daemon to stop (it closes every channel with `stopped`, ends the sessions and removes the guests'
// temp dirs), then waits until its socket is gone. status shows what `smurg host` no longer prints at the start (owner
// decision 2026-10-01): the relay, the daemon key fingerprint, keep-awake, the guest sandbox, the three switches of
// ARCHITECTURE §11 D-12 / D-13 / D-14 as the daemon runs with them, and where the log is.
import { readFile } from 'node:fs/promises';
import { runPathsFor, type CtlStatus } from '@smurg/daemon';
import { parseArgs, stringOption } from '../cli/args.ts';
import { CliError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import { powerState } from '../cli/power-text.ts';
import { ctlRequest } from '../channel/local-channel.ts';
import { daemonAt, findRunningDaemon, hintedWorkspace, runningDaemons, ctlPathFor, type RunningDaemon } from '../channel/discover.ts';
import { DEFAULT_RELAY_URL } from '../relay/default-relay.ts';
import { hostLogPath } from '../state/paths.ts';
import { loadWorkspaces } from '../state/workspaces.ts';
import { say, type CommandContext } from './context.ts';

export const STOP_USAGE = `用法：smurg stop [--workspace 工作區ID]

  停止分享：中斷所有連線、結束所有 session、刪除客人的暫存目錄。
  不指定工作區時，停止目前資料夾所分享的工作區，或唯一一個正在分享的工作區。
`;

export const STATUS_USAGE = `用法：smurg status [--workspace 工作區ID]

  顯示正在分享的工作區狀態：資料夾、relay 與連線、daemon 金鑰指紋、防止睡眠、客人沙盒、smurg host 的三項設定、
  紀錄檔的位置。各項的意思：https://smurg.ai/docs/hosting/#7-狀態與停止
`;

const STOP_WAIT_MS = 30_000;

export async function runStop(argv: readonly string[], ctx: CommandContext): Promise<number> {
  const args = parseArgs(argv, { options: { workspace: { kind: 'string' }, help: { kind: 'boolean', short: 'h' } } });
  if (args.options['help']) {
    say(ctx, STOP_USAGE);
    return EXIT.ok;
  }
  const daemon = await findRunningDaemon(ctx.paths, stringOption(args, 'workspace'), ctx.io.cwd);
  const response = await ctlRequest(daemon.ctlPath, { v: 1, op: 'stop', reason: 'smurg stop' });
  if (!response.ok) throw new CliError(`smurg host 拒絕停止：${response.error.message}`);
  say(ctx, `正在停止分享工作區 ${daemon.status.workspaceId}…`);
  const deadline = ctx.io.now() + STOP_WAIT_MS;
  while ((await daemonAt(daemon.ctlPath, 1_000)) !== null) {
    if (ctx.io.now() > deadline) throw new CliError('smurg host 在 30 秒內沒有停止', { hint: '請查看執行 smurg host 的終端機。' });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  say(ctx, '已停止分享。');
  return EXIT.ok;
}

function relayState(state: string): string {
  switch (state) {
    case 'online':
      return '已連線';
    case 'connecting':
      return '連線中';
    case 'waiting':
      return '等待重新連線';
    case 'auth-rejected':
      return 'relay 拒絕了主人的登入（請執行 smurg login 重新登入）';
    case 'replaced':
      return '被另一個主人連線取代';
    case 'stopped':
      return '已停止';
    case 'none':
      return '未使用';
    default:
      return state;
  }
}

async function pidOf(ctx: CommandContext, workspaceId: string): Promise<string | null> {
  try {
    const text = await readFile(runPathsFor(ctx.paths.runDir, workspaceId).pid, 'utf8');
    return /^\d{1,10}$/.test(text.trim()) ? text.trim() : null;
  } catch {
    return null;
  }
}

function sandboxState(sandbox: NonNullable<CtlStatus['sandbox']> | null): string {
  if (sandbox === null) return '尚未檢查';
  if (sandbox.ok) return '可用';
  return `無法使用（${sandbox.reason ?? '原因不明'}），runner 角色的組員不能在這台電腦上開 session（處理方法：https://smurg.ai/docs/hosting/#8-疑難排解）`;
}

/** The switches of `smurg host` (ARCHITECTURE §11 D-12, D-13, D-14) as the daemon runs with them; docs/HOSTING.md §5 explains them. */
function switchStates(switches: NonNullable<CtlStatus['switches']>, isGitRepo: boolean | undefined): string[] {
  const noWorktree = !switches.guestMainWorkspace && isGitRepo === false ? '；這個資料夾不是 git repository，客人目前無法開 session' : '';
  return [
    `  組員的 Claude 訂閱登入：${switches.guestSubscriptionLogin ? '開放' : '已關閉（--no-guest-subscription-login）'}`,
    `  客人的主工作區 session：${switches.guestMainWorkspace ? '已開放' : '未開放（客人只能用自己的 worktree）'}${noWorktree}`,
    `  agent 的 shell 指令通知：${switches.attributeBashEdits ? '開啟' : '已關閉（--no-bash-attribution）'}`,
  ];
}

async function describe(ctx: CommandContext, daemon: RunningDaemon): Promise<string> {
  const status = daemon.status;
  const book = await loadWorkspaces(ctx.paths);
  const entry = book.shared.find((shared) => shared.workspaceId === status.workspaceId);
  // The daemon's own relay (null: none); a daemon of an older build does not say it (the remembered folder's relay then).
  const relay = status.relayUrl !== undefined ? status.relayUrl : (entry?.relay ?? null);
  const builtIn = relay !== null && relay === DEFAULT_RELAY_URL ? '（smurg 內建的公用 relay）' : '';
  const pid = await pidOf(ctx, status.workspaceId);
  const power = powerState(status.power);
  return [
    `工作區 ${status.workspaceId}${status.stopped ? '（正在停止）' : ''}`,
    ...(entry ? [`  資料夾：${entry.folder}`] : []),
    `  relay：${relay === null ? '' : `${relay}${builtIn}，`}互動連線 ${relayState(status.relay.interactive)}，檔案傳輸 ${relayState(status.relay.transfer)}`,
    `  連線數：${status.connections}，線上成員：${status.onlineMembers}`,
    ...(status.fingerprint !== undefined ? [`  daemon 金鑰指紋：${status.fingerprint}`] : []),
    `  防止睡眠：${power}`,
    ...(status.sandbox !== undefined ? [`  客人沙盒：${sandboxState(status.sandbox)}`] : []),
    ...(status.switches !== undefined ? switchStates(status.switches, status.isGitRepo) : []),
    `  紀錄檔：${hostLogPath(ctx.paths, status.workspaceId)}`,
    ...(pid ? [`  daemon 行程：${pid}`] : []),
  ].join('\n');
}

export async function runStatus(argv: readonly string[], ctx: CommandContext): Promise<number> {
  const args = parseArgs(argv, { options: { workspace: { kind: 'string' }, help: { kind: 'boolean', short: 'h' } } });
  if (args.options['help']) {
    say(ctx, STATUS_USAGE);
    return EXIT.ok;
  }
  const flag = stringOption(args, 'workspace');
  let daemons: RunningDaemon[];
  if (flag !== undefined) {
    const hinted = (await hintedWorkspace(ctx.paths, flag, ctx.io.cwd)) as string;
    const one = await daemonAt(ctlPathFor(ctx.paths, hinted));
    daemons = one ? [one] : [];
  } else {
    daemons = await runningDaemons(ctx.paths);
  }
  if (daemons.length === 0) {
    say(ctx, flag !== undefined ? `工作區 ${flag} 沒有正在執行的 smurg host。` : '目前沒有正在分享的工作區。');
    return EXIT.notRunning;
  }
  for (const daemon of daemons) say(ctx, await describe(ctx, daemon));
  return EXIT.ok;
}
