// Work that stopped and has no card (ARCHITECTURE §7.9 "Attention"): the facts the topics module knows, derived from
// its state like everything else in the inbox. The inbox copies them into items as they are; `id` is stable, so an
// item keeps its key (`attention:<subject>:<id>`) while the fact lasts.
//
//   item-stalled      an execution session stopped without a report (or was interrupted)
//   item-failed       an item's session failed
//   item-stopped      an item's session was ended on purpose
//                       → the item's responsible person; nobody assigned: the member who started it; else the host;
//                         like a decision (0.7.0 review), also the host and every member with agent access once it has
//                         waited `escalateAfterMs`, or at once when its one recipient has been offline
//                         `escalateOfflineMs`. Not while smurg continues the item by itself (DESIGN 0.7.0 D15: a usage
//                         limit, a broken turn, a crash, a failed snapshot): nobody is asked for what smurg does.
//   item-not-started  an armed item could not start, or was disarmed → the member who started it and the host
//   plan-paused       the plan is paused (one per topic): a person pressed "Pause" (0.7.0), or a restart of the host's
//                     smurg interrupted an item that runs directly in the shared folder (until 0.6.0 every restart
//                     paused a topic with armed or interrupted items); `count`: what waits for "Continue all"
//                       → the host and every member with agent access
//   discussion-lost   the topic's discussion ended or failed for good → the host and the topic's creator
//
// An item a person left out (0.7.0, DESIGN D11) needs nobody: it has no fact. What waits for an item (`unblocks`, D9)
// is read from the plan by the inbox (derive.ts), as for its decisions, questions and permission requests.
import { agentAccessMembers, can, decisionRecipients, hostOf, type ColumnTarget } from '@smurg/protocol';
import type { AttentionFact, UserId } from '../core/interfaces.ts';
import { autoContinueOwed } from './auto-merge-verdict.ts';
import { itemKey, type TopicsCore } from './core.ts';
import type { StoredItem, StoredTopic } from './store.ts';

/** Items of a paused plan that wait for "Continue all": armed ones, and sessions a restart interrupted. */
export function pausedItems(topic: StoredTopic): StoredItem[] {
  return topic.items.filter((item) => item.armed || (item.state === 'stalled' && item.stalledBy === 'restart'));
}

/**
 * Who an item that stopped is for (its `item-stalled`, `item-failed` or `item-stopped` fact), or null when it has no
 * such fact: its carers, and once it has waited too long or its one carer is away, the host and every member with agent
 * access too (0.7.0 review: an agent that could not finish is a decision; it reached only its responsible person and
 * never escalated). The plan's `waitingFor` counts it from the same answer.
 */
export function stoppedItemRecipients(core: TopicsCore, topic: StoredTopic, item: StoredItem, now = core.ctx.clock.now()): UserId[] | null {
  if (topic.archived || item.leftOut !== undefined) return null;
  if (item.state !== 'stalled' && item.state !== 'failed' && item.state !== 'stopped') return null;
  // (smurg continues it by itself: nobody is asked, D15; the host's account row says a usage limit)
  if (item.state !== 'stopped' && autoContinueOwed(item)) return null;
  const members = core.ctx.members.routing();
  const host = hostOf(members);
  const active = new Set(members.map((member) => member.userId));
  const unique = (ids: readonly (UserId | null | undefined)[]): UserId[] => [...new Set(ids.filter((id): id is UserId => typeof id === 'string' && active.has(id)))];
  // Who looks after the item: its responsible person while they may still discuss; else who started it; else the host.
  const responsible = core.responsibleOf(topic, item);
  const responsibleRole = members.find((member) => member.userId === responsible)?.role;
  const keeper = unique([responsibleRole !== undefined && can(responsibleRole, 'discuss') ? responsible : null]);
  const starter = unique([item.startedBy?.userId]);
  const carers = keeper.length > 0 ? keeper : starter.length > 0 ? starter : unique([host]);
  // (escalated once, it stays so while the item stays where it stopped: a carer who comes back does not take the row
  // from the others again, 0.7.0 verify)
  const key = itemKey(topic.id, item.id);
  const remembered = core.stoppedEscalated.get(key);
  if (remembered !== undefined && remembered !== item.since) core.stoppedEscalated.delete(key);
  const away = carers.length === 1 && core.offlineFor(carers[0] as UserId, now) >= core.ctx.config.agents.escalateOfflineMs;
  if (remembered !== item.since && now - item.since < core.ctx.settings.get().escalateAfterMs && !away) return carers;
  core.stoppedEscalated.set(key, item.since);
  return unique([...carers, ...decisionRecipients({ hostOnly: false, escalated: true }, { responsible }, members)]);
}

export function attentionFacts(core: TopicsCore): AttentionFact[] {
  const members = core.ctx.members.routing();
  const host = hostOf(members);
  const active = new Set(members.map((member) => member.userId));
  const unique = (ids: readonly (UserId | null | undefined)[]): UserId[] => [...new Set(ids.filter((id): id is UserId => typeof id === 'string' && active.has(id)))];
  const facts: AttentionFact[] = [];
  const now = core.ctx.clock.now();

  for (const topic of core.topics()) {
    if (topic.archived) continue;
    const plan: ColumnTarget = { kind: 'plan', topicId: topic.id };

    for (const item of topic.items) {
      if (item.leftOut !== undefined) continue;
      const label = { number: item.number, title: item.title };
      const base = { id: `${topic.id}.${item.id}`, at: item.since, topicId: topic.id, itemId: item.id, item: label, excerpt: '' };
      const session: ColumnTarget = item.sessionId === undefined ? plan : { kind: 'session', sessionId: item.sessionId };
      const withSession = item.sessionId === undefined ? {} : { sessionId: item.sessionId };
      const stopped = stoppedItemRecipients(core, topic, item, now);

      if (stopped !== null) {
        if (item.state === 'stalled') facts.push({ ...base, ...withSession, subject: 'item-stalled', recipients: stopped, target: session });
        else if (item.state === 'failed') facts.push({ ...base, ...withSession, subject: 'item-failed', recipients: stopped, target: session });
        else facts.push({ ...base, ...withSession, subject: 'item-stopped', recipients: stopped, target: plan });
      } else if (item.state === 'not-started' && (item.disarmed !== undefined || item.startError !== undefined)) {
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
