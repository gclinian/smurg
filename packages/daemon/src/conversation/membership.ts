// What goes with a member (ARCHITECTURE §3 "When a member goes"; DESIGN §3.9). Called by the core's teardown, FIRST,
// for a kick, a leave, and a role change that took `session.create`, `session.drive` or `discuss` away:
//
//   - their votes leave every open question                       (kicked, left, or no longer holding `discuss`)
//   - the always-allowed kinds they added to sessions are removed  (kicked, left, or no longer holding `session.drive`)
//   - a permission mode they chose goes back to following its topic and the workspace, ONLY when it is looser than
//     what the session would follow without it (the same; DESIGN 0.6.0 D12: a stricter choice stays, 0.5.2 put back
//     whatever they set)
//   - a model they chose that may bill usage credits goes back to the host's default (the same; DESIGN 0.6.0 D12: the
//     host would keep paying for a choice of someone who no longer has agent access); any other model stays
//   - their messages that are still queued in the daemon are dropped (the same)
//   - a running turn that still holds an undelivered message of a KICKED member is stopped
//
// The lines about removed rules and a reset mode or model are AgentSessions' own (`setRules` / `setMode` / `setModel`
// by the system); the `session.handover` audit entry is the core's, from what this returns. Topic rules, a topic's
// agent settings and armed items are the topics module's part.
import { can, effectivePermissionMode, isLooserMode, ruleString, type AgentSession, type Role, type SessionModeChoice } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { ConversationRemoval, MemberChange, UserId } from '../core/interfaces.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { mayBillUsageCredits } from '../sessions/agent/models.ts';
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
        if (facts !== null && facts.modeChangedBy === userId && session.modeChoice !== null && isLooserMode(session.modeChoice, followed(ctx, session))) {
          modesReset.push(session.id);
          // By the system: AgentSessions writes `conversation.mode.reset`; the session follows again.
          track(agents.setMode(session.id, null, SYSTEM_ACTOR));
        }
        if (facts !== null && facts.modelChangedBy === userId && session.model !== null && billsUsageCredits(ctx, session.model)) {
          // By the system: AgentSessions writes `conversation.model.reset`; the session runs on the host's default.
          track(agents.setModel(session.id, null, SYSTEM_ACTOR));
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

/** The mode a session would run with without its own choice: its topic's (a work item), else the workspace's. */
function followed(ctx: DaemonContext, session: AgentSession): ReturnType<typeof effectivePermissionMode> {
  let topic: SessionModeChoice | null = null;
  if (session.purpose === 'item' && session.topicId !== undefined && !isStubService(ctx.services.topics)) {
    try {
      topic = ctx.services.topics.agent(session.topicId)?.permissionMode ?? null;
    } catch {
      topic = null;
    }
  }
  return effectivePermissionMode({ purpose: session.purpose, session: null, topic, workspace: ctx.settings.get().permissionMode });
}

/**
 * Whether this model may bill usage credits: its entry of the host agent's list says so (`billing`, DESIGN 0.6.0 D4);
 * a model the list does not hold (not known yet, or gone from it) by its name, as the list's own rule reads names.
 */
export function billsUsageCredits(ctx: DaemonContext, model: string): boolean {
  const entry = ctx.services.agents.hostAgentState().models.find((candidate) => candidate.value === model);
  return entry === undefined ? mayBillUsageCredits([model]) : entry.billing === 'usage-credits';
}
