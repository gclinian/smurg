// Finding the running `smurg host` a command means: `--workspace <id>`, else the hosted workspace whose folder
// contains the current directory, else the only daemon answering in the run dir. Each daemon's control socket is
// `<state>/run/<short>.ctl` (ARCHITECTURE §7.1). Nothing is ever signalled: a daemon is asked over its socket.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SocketPathError, runPathsFor, type CtlStatus } from '@smurg/daemon';
import { isWorkspaceId } from '@smurg/protocol/relay';
import { CliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import type { StatePaths } from '../state/paths.ts';
import { loadWorkspaces, sharedFolderContaining } from '../state/workspaces.ts';
import { ctlRequest } from './local-channel.ts';

export interface RunningDaemon {
  readonly ctlPath: string;
  readonly status: CtlStatus;
}

export function ctlPathFor(paths: StatePaths, workspaceId: string): string {
  if (!isWorkspaceId(workspaceId)) throw usageError(`工作區 ID 不正確：${workspaceId}`);
  try {
    return runPathsFor(paths.runDir, workspaceId).ctl;
  } catch (err) {
    if (err instanceof SocketPathError) throw new CliError(`smurg 的狀態目錄路徑太長，Unix socket 放不下：${paths.runDir}`, { hint: '請把 SMURG_HOME 設成較短的路徑。' });
    throw err;
  }
}

/** The status of the daemon behind `ctlPath`, or null when nothing answers there. */
export async function daemonAt(ctlPath: string, timeoutMs = 3_000): Promise<RunningDaemon | null> {
  try {
    const response = await ctlRequest(ctlPath, { v: 1, op: 'status' }, timeoutMs);
    if (!response.ok || response.op !== 'status') return null;
    return { ctlPath, status: response.status };
  } catch {
    return null;
  }
}

/** Every daemon answering on a control socket in the run dir. */
export async function runningDaemons(paths: StatePaths): Promise<RunningDaemon[]> {
  let names: string[];
  try {
    names = await readdir(paths.runDir);
  } catch {
    return [];
  }
  const found = await Promise.all(names.filter((name) => /^[A-Za-z0-9]{12}\.ctl$/.test(name)).map((name) => daemonAt(join(paths.runDir, name))));
  return found.filter((d): d is RunningDaemon => d !== null);
}

/**
 * The workspace a host-side command is about: `--workspace`, else the shared folder containing `cwd`, else null (the
 * caller decides what "no hint" means).
 */
export async function hintedWorkspace(paths: StatePaths, flag: string | undefined, cwd: string): Promise<string | null> {
  if (flag !== undefined) {
    if (!isWorkspaceId(flag)) throw usageError(`工作區 ID 不正確：${flag}`);
    return flag;
  }
  const entry = sharedFolderContaining(await loadWorkspaces(paths), cwd);
  return entry?.workspaceId ?? null;
}

/** The one running daemon a host-side command addresses, or a zh-TW error. */
export async function findRunningDaemon(paths: StatePaths, flag: string | undefined, cwd: string): Promise<RunningDaemon> {
  const hinted = await hintedWorkspace(paths, flag, cwd);
  if (hinted !== null) {
    const daemon = await daemonAt(ctlPathFor(paths, hinted));
    if (daemon) return daemon;
    if (flag !== undefined) throw new CliError(`工作區 ${hinted} 沒有正在執行的 smurg host`, { exitCode: EXIT.notRunning });
  }
  const running = await runningDaemons(paths);
  if (running.length === 1) return running[0] as RunningDaemon;
  if (running.length === 0) throw new CliError('沒有正在執行的 smurg host', { exitCode: EXIT.notRunning });
  throw usageError('有多個工作區正在分享，請用 --workspace 指定', `正在分享的工作區：${running.map((d) => d.status.workspaceId).join('、')}`);
}
