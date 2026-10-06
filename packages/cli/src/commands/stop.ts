// `smurg stop [--workspace W]` and `smurg status [--workspace W]`: through the daemon's control socket (ARCHITECTURE
// §8). stop asks the daemon to stop (it closes every channel with `stopped`, ends the terminals and the agents'
// processes; agent sessions stay and come back idle at the next `smurg host`), waits until its socket is gone, and
// says how many agent sessions are paused. status shows what `smurg host` no longer prints at the start (owner
// decision 2026-10-01): the relay, the daemon key fingerprint, keep-awake, the switch of ARCHITECTURE §11 D-13 as the
// daemon runs with it, where the log is; and what the daemon knows about agents: Claude Code on this computer (from
// its last check), the agent sessions by state, the topics and how many are paused, whether the folder's Claude Code
// project settings are confirmed, and how many of the host's own allow rules apply to agent sessions.
import { readFile } from 'node:fs/promises';
import { runPathsFor } from '@smurg/daemon';
import { parseArgs, stringOption } from '../cli/args.ts';
import { CliError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import { agentsPausedNotice, claudeState } from '../cli/agents-text.ts';
import { powerState } from '../cli/power-text.ts';
import { ctlRequest } from '../channel/local-channel.ts';
import { daemonAt, findRunningDaemon, hintedWorkspace, runningDaemons, ctlPathFor, type RunningDaemon } from '../channel/discover.ts';
import { DEFAULT_RELAY_URL } from '../relay/default-relay.ts';
import { hostLogPath } from '../state/paths.ts';
import { loadWorkspaces } from '../state/workspaces.ts';
import { m, wireError, type MessageId, type Text } from '../i18n/index.ts';
import { say, type CommandContext } from './context.ts';

export const STOP_WAIT_MS = 30_000;

/** Asks a running daemon to stop (the control socket's `stop`); a refusal is shown in this terminal's language. */
export async function requestStop(daemon: RunningDaemon): Promise<void> {
  const response = await ctlRequest(daemon.ctlPath, { v: 1, op: 'stop' });
  if (!response.ok) throw new CliError(m('stop.refused', { reason: wireError(response.error) }));
}

/** Returns when the daemon's control socket is gone (it closes last: the daemon is fully stopped), or fails after `waitMs`. */
export async function waitUntilStopped(ctx: CommandContext, daemon: RunningDaemon, waitMs = STOP_WAIT_MS): Promise<void> {
  const deadline = ctx.io.now() + waitMs;
  while ((await daemonAt(daemon.ctlPath, 1_000)) !== null) {
    if (ctx.io.now() > deadline) throw new CliError(m('stop.timeout', { seconds: Math.round(waitMs / 1000) }), { hint: m('stop.timeout.hint') });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function runStop(argv: readonly string[], ctx: CommandContext): Promise<number> {
  const args = parseArgs(argv, { options: { workspace: { kind: 'string' }, help: { kind: 'boolean', short: 'h' } } });
  if (args.options['help']) {
    say(ctx, m('usage.stop'));
    return EXIT.ok;
  }
  const daemon = await findRunningDaemon(ctx.paths, stringOption(args, 'workspace'), ctx.io.cwd);
  await requestStop(daemon);
  say(ctx, m('stop.stopping', { workspaceId: daemon.status.workspaceId }));
  await waitUntilStopped(ctx, daemon);
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

async function describe(ctx: CommandContext, daemon: RunningDaemon): Promise<Text> {
  const status = daemon.status;
  const book = await loadWorkspaces(ctx.paths);
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

export async function runStatus(argv: readonly string[], ctx: CommandContext): Promise<number> {
  const args = parseArgs(argv, { options: { workspace: { kind: 'string' }, help: { kind: 'boolean', short: 'h' } } });
  if (args.options['help']) {
    say(ctx, m('usage.status'));
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
    say(ctx, flag !== undefined ? m('status.noneFor', { workspaceId: flag }) : m('status.none'));
    return EXIT.notRunning;
  }
  for (const daemon of daemons) say(ctx, await describe(ctx, daemon));
  return EXIT.ok;
}
