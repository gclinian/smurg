// What the CLI says about Claude Code and the agent sessions of a workspace, from the daemon's status (the control
// socket's `status`, or the Daemon's own in `smurg host`): the lines of `smurg status` and the one line at a stop.
// The daemon reports codes and counts; the words are the CLI's catalog.
import type { CtlStatus } from '@smurg/daemon';
import { m, type Text } from '../i18n/index.ts';

/** "2.1.288 (verified with this smurg), logged in"; without a check yet (no agent session was started): says so. */
export function claudeState(claude: CtlStatus['claude']): Text {
  if (claude === undefined) return m('status.claude.notChecked');
  return m('status.claude', { ...(claude.version === null ? {} : { version: claude.version }), verdict: claude.verdict, login: claude.login });
}

/** Agent sessions that have not ended: running, waiting for a person, stopped without a report or failed, idle. */
export function liveAgentSessions(agents: CtlStatus['agents']): number {
  return agents === undefined ? 0 : agents.running + agents.waiting + agents.stalled + agents.idle;
}

/**
 * The line after "Stopped sharing." when the workspace had agent sessions: a stop ends their agents' processes, the
 * sessions and their conversations stay, and they come back idle when the folder is shared again. null: there were none.
 */
export function agentsPausedNotice(agents: CtlStatus['agents']): Text | null {
  const count = liveAgentSessions(agents);
  return count === 0 ? null : m('host.agentsPaused', { count });
}
