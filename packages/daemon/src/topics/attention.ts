// Work that stopped and has no card (ARCHITECTURE §5.11 "Attention"): the facts the topics module knows, derived from
// its state like everything else in the inbox. The inbox copies them into items as they are; `id` is stable, so an
// item keeps its key (`attention:<subject>:<id>`) while the fact lasts.
//
//   item-stalled      an execution session stopped without a report (or was interrupted)
//   item-failed       an item's session failed
//   item-stopped      an item's session was ended on purpose
//                       → the item's responsible person; nobody assigned: the member who started it; else the host
//   item-not-started  an armed item could not start, or was disarmed → the member who started it and the host
//   plan-paused       the host's smurg restarted and the topic has armed or interrupted items (one per topic)
//                       → the host and every member with agent access
//   discussion-lost   the topic's discussion ended or failed for good → the host and the topic's creator
import { agentAccessMembers, can, hostOf, type ColumnTarget } from '@smurg/protocol';
import type { AttentionFact, UserId } from '../core/interfaces.ts';
import type { TopicsCore } from './core.ts';
import type { StoredItem, StoredTopic } from './store.ts';

/** Items of a paused plan that wait for "Continue all": armed ones, and sessions a restart interrupted. */
export function pausedItems(topic: StoredTopic): StoredItem[] {
  return topic.items.filter((item) => item.armed || (item.state === 'stalled' && item.stalledBy === 'restart'));
}

export function attentionFacts(core: TopicsCore): AttentionFact[] {
  const members = core.ctx.members.routing();
  const host = hostOf(members);
  const active = new Set(members.map((member) => member.userId));
  const unique = (ids: readonly (UserId | null | undefined)[]): UserId[] => [...new Set(ids.filter((id): id is UserId => typeof id === 'string' && active.has(id)))];
  const facts: AttentionFact[] = [];

  for (const topic of core.topics()) {
    if (topic.archived) continue;
    const plan: ColumnTarget = { kind: 'plan', topicId: topic.id };

    for (const item of topic.items) {
      const label = { number: item.number, title: item.title };
      const base = { id: `${topic.id}.${item.id}`, at: item.since, topicId: topic.id, itemId: item.id, item: label, excerpt: '' };
      const session: ColumnTarget = item.sessionId === undefined ? plan : { kind: 'session', sessionId: item.sessionId };
      // Who looks after the item: its responsible person while they may still discuss; else who started it; else the host.
      const responsible = core.responsibleOf(topic, item);
      const responsibleRole = members.find((member) => member.userId === responsible)?.role;
      const keeper = unique([responsibleRole !== undefined && can(responsibleRole, 'discuss') ? responsible : null]);
      const starter = unique([item.startedBy?.userId]);
      const carers = keeper.length > 0 ? keeper : starter.length > 0 ? starter : unique([host]);
      const withSession = item.sessionId === undefined ? {} : { sessionId: item.sessionId };

      if (item.state === 'stalled') facts.push({ ...base, ...withSession, subject: 'item-stalled', recipients: carers, target: session });
      else if (item.state === 'failed') facts.push({ ...base, ...withSession, subject: 'item-failed', recipients: carers, target: session });
      else if (item.state === 'stopped') facts.push({ ...base, ...withSession, subject: 'item-stopped', recipients: carers, target: plan });
      else if (item.state === 'not-started' && (item.disarmed !== undefined || item.startError !== undefined)) {
        facts.push({ ...base, subject: 'item-not-started', recipients: unique([item.startedBy?.userId, host]), target: plan });
      }
    }

    if (topic.plan.paused) {
      const count = pausedItems(topic).length;
      facts.push({ subject: 'plan-paused', id: topic.id, at: topic.plan.pausedAt ?? topic.createdAt, recipients: unique(agentAccessMembers(members)), topicId: topic.id, target: plan, count, excerpt: topic.name });
    }
    if (topic.discussion === 'lost') {
      const target: ColumnTarget = topic.discussionSessionId === undefined ? { kind: 'spec', topicId: topic.id } : { kind: 'session', sessionId: topic.discussionSessionId };
      facts.push({
        subject: 'discussion-lost',
        id: topic.id,
        at: topic.lostAt ?? topic.createdAt,
        recipients: unique([host, topic.createdBy.userId]),
        topicId: topic.id,
        ...(topic.discussionSessionId === undefined ? {} : { sessionId: topic.discussionSessionId }),
        target,
        excerpt: topic.name,
      });
    }
  }
  return facts.filter((fact) => fact.recipients.length > 0);
}
