// The file an agent works on right now. An agent has one only while it is at work (the protocol's `isAgentAtWork`:
// starting, in a turn, or waiting inside one): the host's presence list carries `activeFile` only then. The same rule
// is applied here to the status the entry carries, so a list that is a moment older than the session's state never
// shows a file under an agent that is idle, done or stopped.
import { isAgentAtWork, type FileRef, type PresenceAgent } from '@smurg/protocol';

/** The file the agent works on now: nothing while it does not work. */
export function currentFileOf(agent: PresenceAgent): FileRef | undefined {
  return isAgentAtWork(agent.status) ? agent.activeFile : undefined;
}
