// Whether an agent is at work right now. The host's presence list keeps the file an agent touched last for as long as
// its session lives (an idle discussion, a work item that is done), so "working on <file>" is said only while the
// agent runs a turn or waits inside one.
import type { AgentStatus, FileRef, PresenceAgent } from '@smurg/protocol';

export function agentAtWork(status: AgentStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'waiting-answer' || status === 'waiting-permission';
}

/** The file the agent works on now: nothing while it does not work, whatever the presence list still holds. */
export function currentFileOf(agent: PresenceAgent): FileRef | undefined {
  return agentAtWork(agent.status) ? agent.activeFile : undefined;
}
