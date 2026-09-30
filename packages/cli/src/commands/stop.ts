// `smurg stop [--workspace W]` and `smurg status [--workspace W]`: through the daemon's control socket (ARCHITECTURE
// §8). stop asks the daemon to stop (it closes every channel with `stopped`, ends the sessions and removes the guests'
// temp dirs), then waits until its socket is gone.
import { readFile } from 'node:fs/promises';
import { runPathsFor, type DaemonStatus } from '@smurg/daemon';
import { parseArgs, stringOption } from '../cli/args.ts';
import { CliError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import { powerState } from '../cli/power-text.ts';
import { ctlRequest } from '../channel/local-channel.ts';
import { daemonAt, findRunningDaemon, hintedWorkspace, runningDaemons, ctlPathFor, type RunningDaemon } from '../channel/discover.ts';
import { loadWorkspaces } from '../state/workspaces.ts';
import { say, type CommandContext } from './context.ts';

export const STOP_USAGE = `用法：smurg stop [--workspace 工作區ID]

  停止分享：中斷所有連線、結束所有 session、刪除客人的暫存目錄。
  不指定工作區時，停止目前資料夾所分享的工作區，或唯一一個正在分享的工作區。
`;

export const STATUS_USAGE = `用法：smurg status [--workspace 工作區ID]

  顯示正在分享的工作區狀態。
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

async function describe(ctx: CommandContext, daemon: RunningDaemon): Promise<string> {
  const status: DaemonStatus = daemon.status;
  const book = await loadWorkspaces(ctx.paths);
  const folder = book.shared.find((entry) => entry.workspaceId === status.workspaceId)?.folder;
  const pid = await pidOf(ctx, status.workspaceId);
  const power = powerState(status.power);
  return [
    `工作區 ${status.workspaceId}${status.stopped ? '（正在停止）' : ''}`,
    ...(folder ? [`  資料夾：${folder}`] : []),
    `  relay：互動連線 ${relayState(status.relay.interactive)}，檔案傳輸 ${relayState(status.relay.transfer)}`,
    `  連線數：${status.connections}，線上成員：${status.onlineMembers}`,
    `  防止睡眠：${power}`,
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
