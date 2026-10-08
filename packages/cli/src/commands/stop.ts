// `smurg stop [--workspace W]` and `smurg status [--workspace W]`: through the daemon's control socket (ARCHITECTURE
// §8). stop asks the daemon to stop (it closes every channel with `stopped`, ends the terminals and the agents'
// processes; agent sessions stay and come back idle at the next `smurg host`), waits until its socket is gone, and
// says how many agent sessions are paused. status shows what `smurg host` no longer prints at the start (owner
// decision 2026-10-01): the relay, the daemon key fingerprint, keep-awake, the switch of ARCHITECTURE §11 D-13 as the
// daemon runs with it, where the log is; and what the daemon knows about agents: Claude Code on this computer (from
// its last check), the agent sessions by state, the topics and how many are paused, whether the folder's Claude Code
// project settings are confirmed, and how many of the host's own allow rules apply to agent sessions.
//
// A smurg host of ANOTHER VERSION (0.5.1, DESIGN B1: alive behind its control socket, its answer not readable by this
// command; channel/discover.ts). `status` names it with what is known (the workspace and folder when workspaces.json
// remembers the socket) and exits with EXIT.otherVersion, never with "nothing is being shared". `stop` still asks it to
// stop: the request `{ v: 1, op: 'stop' }` is the same in every published version, and after an installer replaced
// the executable this command is the only `smurg` there is. It then waits for the socket to go, as for any daemon.
import { readFile } from 'node:fs/promises';
import { runPathsFor } from '@smurg/daemon';
import { parseArgs, stringOption } from '../cli/args.ts';
import { CliError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import { agentsPausedNotice, claudeState } from '../cli/agents-text.ts';
import { powerState } from '../cli/power-text.ts';
import { ctlAsk } from '../channel/local-channel.ts';
import { ctlPathFor, findDaemonToStop, hintedWorkspace, probeDaemon, probeDaemons, type RunningDaemon, type UnreadableDaemon } from '../channel/discover.ts';
import { DEFAULT_RELAY_URL } from '../relay/default-relay.ts';
import { hostLogPath } from '../state/paths.ts';
import { loadWorkspaces, type WorkspaceBook } from '../state/workspaces.ts';
import { CLI_VERSION } from '../version.ts';
import { m, wireError, type MessageId, type Text } from '../i18n/index.ts';
import { say, type CommandContext } from './context.ts';

export const STOP_WAIT_MS = 30_000;

/**
 * Asks the daemon behind a control socket to stop (the control socket's `stop`); a refusal is shown in this terminal's
 * language. Returns whether the daemon confirmed: false when no readable answer came (a daemon of another version may
 * stop all the same: the caller waits for its socket to go).
 */
export async function requestStop(daemon: { readonly ctlPath: string }): Promise<boolean> {
  const outcome = await ctlAsk(daemon.ctlPath, { v: 1, op: 'stop' });
  // Gone between the look and the request: it is not running, which is what was asked for.
  if (outcome.kind !== 'answer') return outcome.kind === 'nothing';
  if (!outcome.response.ok) throw new CliError(m('stop.refused', { reason: wireError(outcome.response.error) }));
  return outcome.response.op === 'stop';
}

/**
 * Returns when the daemon's control socket is gone (it closes last: the daemon is fully stopped), or fails after
 * `waitMs`. A socket that is alive and cannot be read (another version) is still running.
 */
export async function waitUntilStopped(ctx: CommandContext, daemon: { readonly ctlPath: string }, waitMs = STOP_WAIT_MS, timedOut?: () => CliError): Promise<void> {
  const deadline = ctx.io.now() + waitMs;
  while ((await probeDaemon(daemon.ctlPath, 1_000)).kind !== 'none') {
    if (ctx.io.now() > deadline) throw timedOut?.() ?? new CliError(m('stop.timeout', { seconds: Math.round(waitMs / 1000) }), { hint: m('stop.timeout.hint') });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Test seams. */
export interface StopDeps {
  /** How long a running `smurg host` may take to stop. Default: STOP_WAIT_MS. */
  readonly stopWaitMs?: number;
}

/** `smurg stop` for a host of another version: the same request, and what happened is told without its status. */
async function stopOtherVersion(ctx: CommandContext, daemon: UnreadableDaemon, waitMs: number): Promise<number> {
  say(ctx, m('stop.otherVersion.asking', { current: CLI_VERSION, ...(daemon.workspaceId !== null ? { workspaceId: daemon.workspaceId } : {}) }));
  await requestStop(daemon);
  await waitUntilStopped(ctx, daemon, waitMs, () => new CliError(m('stop.otherVersion.failed', { seconds: Math.round(waitMs / 1000) }), { hint: m('stop.otherVersion.failed.hint') }));
  say(ctx, m('host.stopped'));
  return EXIT.ok;
}

export async function runStop(argv: readonly string[], ctx: CommandContext, deps: StopDeps = {}): Promise<number> {
  const args = parseArgs(argv, { options: { workspace: { kind: 'string' }, help: { kind: 'boolean', short: 'h' } } });
  if (args.options['help']) {
    say(ctx, m('usage.stop'));
    return EXIT.ok;
  }
  const waitMs = deps.stopWaitMs ?? STOP_WAIT_MS;
  const found = await findDaemonToStop(ctx.paths, stringOption(args, 'workspace'), ctx.io.cwd);
  if (found.kind === 'unreadable') return stopOtherVersion(ctx, found.daemon, waitMs);
  const daemon = found.daemon;
  await requestStop(daemon);
  say(ctx, m('stop.stopping', { workspaceId: daemon.status.workspaceId }));
  await waitUntilStopped(ctx, daemon, waitMs);
  say(ctx, m('host.stopped'));
  // The agent sessions the daemon had when it was asked: their agents ended with it, the conversations stay.
  const paused = agentsPausedNotice(daemon.status.agents);
  if (paused !== null) say(ctx, paused);
  return EXIT.ok;
}

const RELAY_STATES: Readonly<Record<string, MessageId>> = {
  online: 'status.relay.online',
  connecting: 'status.relay.connecting',
  waiting: 'status.relay.waiting',
  'auth-rejected': 'status.relay.authRejected',
  replaced: 'status.relay.replaced',
  stopped: 'status.relay.stopped',
  none: 'status.relay.none',
};

/** A relay link's state in words; a state this build does not know is shown as it is. */
function relayState(state: string): Text {
  return Object.hasOwn(RELAY_STATES, state) ? { id: RELAY_STATES[state] as MessageId } : state;
}

async function pidOf(ctx: CommandContext, workspaceId: string): Promise<string | null> {
  try {
    const text = await readFile(runPathsFor(ctx.paths.runDir, workspaceId).pid, 'utf8');
    return /^\d{1,10}$/.test(text.trim()) ? text.trim() : null;
  } catch {
    return null;
  }
}

async function describe(ctx: CommandContext, daemon: RunningDaemon, book: WorkspaceBook): Promise<Text> {
  const status = daemon.status;
  const entry = book.shared.find((shared) => shared.workspaceId === status.workspaceId);
  // The daemon's own relay (null: none); a daemon that does not say it: the remembered folder's relay.
  const relay = status.relayUrl !== undefined ? status.relayUrl : (entry?.relay ?? null);
  const pid = await pidOf(ctx, status.workspaceId);
  return m('status.workspace', {
    workspaceId: status.workspaceId,
    stopping: status.stopped,
    ...(entry ? { folder: entry.folder } : {}),
    ...(relay === null ? {} : { relay }),
    builtIn: relay !== null && relay === DEFAULT_RELAY_URL,
    interactive: relayState(status.relay.interactive),
    transfer: relayState(status.relay.transfer),
    connections: status.connections,
    onlineMembers: status.onlineMembers,
    ...(status.fingerprint !== undefined ? { fingerprint: status.fingerprint } : {}),
    power: powerState(status.power),
    // The switch of `smurg host` (ARCHITECTURE §11 D-13) as the daemon runs with it; docs/HOSTING.md explains it.
    ...(status.switches !== undefined ? { bashAttribution: status.switches.attributeBashEdits } : {}),
    // Agents (each line only when the daemon says something about it; Claude Code always: "not checked yet").
    claude: claudeState(status.claude),
    ...(status.agents !== undefined ? { agents: m('status.agents', status.agents) } : {}),
    ...(status.topics !== undefined ? { topics: m('status.topics', status.topics) } : {}),
    ...(status.projectSettings !== undefined ? { projectSettings: m('status.projectSettings', { trust: status.projectSettings }) } : {}),
    ...(status.hostRules !== undefined ? { hostRules: m('status.hostRules', status.hostRules) } : {}),
    logPath: hostLogPath(ctx.paths, status.workspaceId),
    ...(pid ? { pid } : {}),
  });
}

/** What `smurg status` says about a host of another version: what is known of it, and how to stop it. */
function describeOtherVersion(daemon: UnreadableDaemon): Text {
  return m('status.otherVersion', {
    current: CLI_VERSION,
    why: daemon.why,
    socket: daemon.ctlPath,
    ...(daemon.workspaceId !== null ? { workspaceId: daemon.workspaceId } : {}),
    ...(daemon.folder !== null ? { folder: daemon.folder } : {}),
  });
}

export async function runStatus(argv: readonly string[], ctx: CommandContext): Promise<number> {
  const args = parseArgs(argv, { options: { workspace: { kind: 'string' }, help: { kind: 'boolean', short: 'h' } } });
  if (args.options['help']) {
    say(ctx, m('usage.status'));
    return EXIT.ok;
  }
  const flag = stringOption(args, 'workspace');
  // The workspace list only adds the folder and the remembered relay to what a daemon says: a list that cannot be
  // read (damaged, or written by a newer smurg) is said in one line after the daemons, and nothing is hidden for it.
  let book: WorkspaceBook = { shared: [], joined: [] };
  let bookProblem: CliError | null = null;
  try {
    book = await loadWorkspaces(ctx.paths);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    bookProblem = err;
  }
  let running: readonly RunningDaemon[];
  let unreadable: readonly UnreadableDaemon[];
  if (flag !== undefined) {
    const hinted = (await hintedWorkspace(ctx.paths, flag, ctx.io.cwd)) as string;
    const folder = book.shared.find((shared) => shared.workspaceId === hinted)?.folder ?? null;
    const probe = await probeDaemon(ctlPathFor(ctx.paths, hinted), 3_000, { workspaceId: hinted, folder });
    running = probe.kind === 'running' ? [probe.daemon] : [];
    unreadable = probe.kind === 'unreadable' ? [probe.daemon] : [];
  } else {
    ({ running, unreadable } = await probeDaemons(ctx.paths));
  }
  if (running.length === 0 && unreadable.length === 0) {
    say(ctx, flag !== undefined ? m('status.noneFor', { workspaceId: flag }) : m('status.none'));
    if (bookProblem !== null) say(ctx, m('status.bookUnreadable', { problem: bookProblem.text, ...(bookProblem.hint !== undefined ? { hint: bookProblem.hint } : {}) }));
    return EXIT.notRunning;
  }
  for (const daemon of running) say(ctx, await describe(ctx, daemon, book));
  for (const daemon of unreadable) say(ctx, describeOtherVersion(daemon));
  if (bookProblem !== null) say(ctx, m('status.bookUnreadable', { problem: bookProblem.text, ...(bookProblem.hint !== undefined ? { hint: bookProblem.hint } : {}) }));
  // A share this command cannot read is neither "all shown" (0) nor "nothing is shared" (3).
  return unreadable.length > 0 ? EXIT.otherVersion : EXIT.ok;
}
