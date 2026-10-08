// Finding the running `smurg host` a command means: `--workspace <id>`, else the hosted workspace whose folder
// contains the current directory, else the only daemon answering in the run dir. Each daemon's control socket is
// `<state>/run/<short>.ctl` (ARCHITECTURE §7.1). Nothing is ever signalled: a daemon is asked over its socket.
//
// What is behind a control socket has three answers (0.5.1, DESIGN B1; `probeDaemon`): nothing (the connect failed), a
// daemon whose status this command read, or a daemon that is alive and whose answer this command cannot read, which is
// a smurg host of ANOTHER VERSION sharing there. The third is never "nothing is running": `status` names it (its own
// exit code), `stop` still asks it to stop, `host`, `update` and `uninstall` treat the folder as shared and say why
// they stop, and `attach` says at once that another version is sharing.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SocketPathError, runPathsFor, type CtlStatus } from '@smurg/daemon';
import { isWorkspaceId } from '@smurg/protocol/relay';
import { CliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import { m } from '../i18n/index.ts';
import type { StatePaths } from '../state/paths.ts';
import { loadWorkspaces, sharedFolderContaining, type WorkspaceBook } from '../state/workspaces.ts';
import { ctlAsk, type UnreadableHost } from './local-channel.ts';

export interface RunningDaemon {
  readonly ctlPath: string;
  readonly status: CtlStatus;
  /** The origin of the web app the daemon's links point to; null: it has none (no relay). */
  readonly webOrigin: string | null;
}

/** A daemon that is alive behind its control socket and whose answer this command cannot read: another version's. */
export interface UnreadableDaemon {
  readonly ctlPath: string;
  readonly why: Exclude<UnreadableHost, 'message'>;
  /** The workspace this socket belongs to, when the caller asked for one or workspaces.json names it; else null. */
  readonly workspaceId: string | null;
  /** The shared folder of that workspace as workspaces.json remembers it; else null. */
  readonly folder: string | null;
}

export type DaemonProbe =
  | { readonly kind: 'none' }
  | { readonly kind: 'running'; readonly daemon: RunningDaemon }
  | { readonly kind: 'unreadable'; readonly daemon: UnreadableDaemon };

/** Everything that holds a control socket in the run dir. */
export interface Daemons {
  readonly running: readonly RunningDaemon[];
  readonly unreadable: readonly UnreadableDaemon[];
}

export function ctlPathFor(paths: StatePaths, workspaceId: string): string {
  if (!isWorkspaceId(workspaceId)) throw usageError(m('state.workspaceId', { id: workspaceId }));
  try {
    return runPathsFor(paths.runDir, workspaceId).ctl;
  } catch (err) {
    if (err instanceof SocketPathError) throw new CliError(m('state.socketPathTooLong', { path: paths.runDir }), { hint: m('state.socketPathTooLong.hint') });
    throw err;
  }
}

/**
 * What is behind `ctlPath`: nothing, a daemon whose status was read, or a daemon of another version (alive: the
 * connect succeeded, or hung; unreadable: no status this command can read came back within `timeoutMs`).
 */
export async function probeDaemon(ctlPath: string, timeoutMs = 3_000, known: { readonly workspaceId?: string | null; readonly folder?: string | null } = {}): Promise<DaemonProbe> {
  const outcome = await ctlAsk(ctlPath, { v: 1, op: 'status' }, timeoutMs);
  if (outcome.kind === 'nothing') return { kind: 'none' };
  const unreadable = (why: UnreadableDaemon['why']): DaemonProbe => ({ kind: 'unreadable', daemon: { ctlPath, why, workspaceId: known.workspaceId ?? null, folder: known.folder ?? null } });
  if (outcome.kind === 'unreadable') return unreadable(outcome.why);
  const response = outcome.response;
  // A refusal of `status`, or the answer to another request: not something a daemon this command knows sends.
  if (!response.ok || response.op !== 'status') return unreadable('not-understood');
  return { kind: 'running', daemon: { ctlPath, status: response.status, webOrigin: response.webOrigin ?? null } };
}

/** The workspace list for naming things only: a list that cannot be read names nothing (it is never written here). */
async function bookForNames(paths: StatePaths): Promise<WorkspaceBook> {
  return loadWorkspaces(paths).catch(() => ({ shared: [], joined: [] }));
}

/**
 * Every daemon holding a control socket in the run dir: the ones whose status was read, and the ones of another
 * version (named by workspace and folder when workspaces.json remembers the workspace of that socket).
 */
export async function probeDaemons(paths: StatePaths): Promise<Daemons> {
  let names: string[];
  try {
    names = await readdir(paths.runDir);
  } catch {
    return { running: [], unreadable: [] };
  }
  const sockets = names.filter((name) => /^[A-Za-z0-9]{12}\.ctl$/.test(name)).map((name) => join(paths.runDir, name));
  const probes = await Promise.all(sockets.map((ctlPath) => probeDaemon(ctlPath)));
  const running: RunningDaemon[] = [];
  let unreadable: UnreadableDaemon[] = [];
  for (const probe of probes) {
    if (probe.kind === 'running') running.push(probe.daemon);
    else if (probe.kind === 'unreadable') unreadable.push(probe.daemon);
  }
  if (unreadable.length > 0) {
    // The socket's name is a hash of the workspace id: only a workspace this state dir remembers can be named.
    const book = await bookForNames(paths);
    unreadable = unreadable.map((daemon) => {
      const entry = book.shared.find((shared) => {
        try {
          return runPathsFor(paths.runDir, shared.workspaceId).ctl === daemon.ctlPath;
        } catch {
          return false;
        }
      });
      return entry ? { ...daemon, workspaceId: entry.workspaceId, folder: entry.folder } : daemon;
    });
  }
  return { running, unreadable };
}

/** How a daemon of another version is named to the person: its workspace when known, else its socket's file name. */
export function unreadableLabel(daemon: UnreadableDaemon): string {
  return daemon.workspaceId ?? daemon.ctlPath.slice(daemon.ctlPath.lastIndexOf('/') + 1);
}

/**
 * The workspace a host-side command is about: `--workspace`, else the shared folder containing `cwd`, else null (the
 * caller decides what "no hint" means). `withoutBook`: a workspaces.json that cannot be read gives no hint instead of
 * stopping the command (`smurg stop` and `smurg status` must work without it: they find the daemons by their sockets).
 */
export async function hintedWorkspace(paths: StatePaths, flag: string | undefined, cwd: string, options: { readonly withoutBook?: boolean } = {}): Promise<string | null> {
  if (flag !== undefined) {
    if (!isWorkspaceId(flag)) throw usageError(m('state.workspaceId', { id: flag }));
    return flag;
  }
  const entry = sharedFolderContaining(options.withoutBook ? await bookForNames(paths) : await loadWorkspaces(paths), cwd);
  return entry?.workspaceId ?? null;
}

/** The one daemon `smurg stop` addresses (readable or of another version), or an error for the person. */
export async function findDaemonToStop(paths: StatePaths, flag: string | undefined, cwd: string): Promise<Exclude<DaemonProbe, { kind: 'none' }>> {
  const hinted = await hintedWorkspace(paths, flag, cwd, { withoutBook: true });
  if (hinted !== null) {
    const probe = await probeDaemon(ctlPathFor(paths, hinted), 3_000, { workspaceId: hinted });
    if (probe.kind !== 'none') return probe;
    if (flag !== undefined) throw new CliError(m('discover.notRunningFor', { workspaceId: hinted }), { exitCode: EXIT.notRunning });
  }
  const found = await probeDaemons(paths);
  const all: Exclude<DaemonProbe, { kind: 'none' }>[] = [...found.running.map((daemon) => ({ kind: 'running' as const, daemon })), ...found.unreadable.map((daemon) => ({ kind: 'unreadable' as const, daemon }))];
  if (all.length === 1) return all[0] as (typeof all)[number];
  if (all.length === 0) throw new CliError(m('discover.notRunning'), { exitCode: EXIT.notRunning });
  throw usageError(m('discover.several'), m('discover.several.hint', { ids: [...found.running.map((d) => d.status.workspaceId), ...found.unreadable.map(unreadableLabel)] }));
}
