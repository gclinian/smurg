// What goes with a member (ARCHITECTURE §3 "When a member goes"; DESIGN §3.9). Called by the core's teardown, FIRST,
// for a kick, a leave, and a role change that took `session.create`, `session.drive` or `discuss` away:
//
//   - their votes leave every open question                       (kicked, left, or no longer holding `discuss`)
//   - the always-allowed kinds they added to sessions are removed  (kicked, left, or no longer holding `session.drive`)
//   - a permission mode they loosened returns to its default       (the same)
//   - their messages that are still queued in the daemon are dropped (the same)
//   - a running turn that still holds an undelivered message of a KICKED member is stopped
//
// The lines about removed rules and a reset mode are AgentSessions' own (`setRules` / `setMode` by the system); the
// `session.handover` audit entry is the core's, from what this returns. Topic rules and armed items are the topics
// module's part.
import { can, defaultPermissionMode, ruleString, type Role } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { ConversationRemoval, MemberChange, UserId } from '../core/interfaces.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import type { Questions } from './questions.ts';

export function removeMember(ctx: DaemonContext, questions: Questions, userId: UserId, change: MemberChange, to: Role | undefined, track: (work: Promise<unknown>) => void): ConversationRemoval {
  const gone = change !== 'role-changed' || to === undefined;
  const losesDiscuss = gone || !can(to, 'discuss');
  const losesDrive = gone || !can(to, 'session.drive');
  const votes = losesDiscuss ? questions.removeVotesOf(userId) : 0;
  const rules: string[] = [];
  const modesReset: string[] = [];
  let messages = 0;
  const agents = ctx.services.agents;
  if (!isStubService(agents)) {
    if (losesDrive) {
      for (const session of agents.list()) {
        if (session.status === 'ended') continue;
        const own = agents.rules(session.id);
        const theirs = own.filter((rule) => rule.addedBy.userId === userId);
        if (theirs.length > 0) {
          rules.push(...theirs.map((rule) => ruleString(rule)));
          // By the system: AgentSessions writes `conversation.rule.removed.member` per rule and restarts the process without them.
          track(agents.setRules(session.id, own.filter((rule) => rule.addedBy.userId !== userId), SYSTEM_ACTOR));
        }
        const facts = agents.facts(session.id);
        if (facts !== null && facts.modeChangedBy === userId) {
          modesReset.push(session.id);
          // By the system: AgentSessions writes `conversation.mode.reset`.
          track(agents.setMode(session.id, defaultPermissionMode(facts.purpose, facts.root), SYSTEM_ACTOR));
        }
      }
      for (const cancelled of agents.cancelQueued(userId)) messages += cancelled.messageIds.length;
    }
    // A message already written to a running process cannot be recalled: a kicked member's undelivered one stops that turn.
    if (change === 'kicked') for (const sessionId of agents.holdingUndelivered(userId)) track(agents.interrupt(sessionId, SYSTEM_ACTOR));
  }
  // Whoever decides and whoever counts as eligible may have changed with them.
  questions.refresh();
  return { rules, modesReset, votes, messages };
}
