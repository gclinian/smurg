// The activity feed as pure data (tested without React): what each event kind is called, which filter shows it,
// who did it, and whether its file can be opened. The daemon writes `summary` as a whole zh-TW sentence that already
// names the actor (「Claude（Ian） 修改了 src/app.ts（Edit）」); the feed adds the structured parts around it.
import type { ActivityEvent, Actor } from '@smurg/protocol';
import { t } from './strings.ts';

export type ActivityKind = ActivityEvent['kind'];

export type FeedFilter = 'all' | 'agents' | 'people' | 'problems';

export const FEED_FILTERS: readonly FeedFilter[] = ['all', 'agents', 'people', 'problems'];

export function kindLabel(kind: ActivityKind): string {
  switch (kind) {
    case 'agent.edit':
      return t('kind.agent.edit');
    case 'human.edit':
      return t('kind.human.edit');
    case 'file.create':
      return t('kind.file.create');
    case 'file.delete':
      return t('kind.file.delete');
    case 'file.rename':
      return t('kind.file.rename');
    case 'file.upload':
      return t('kind.file.upload');
    case 'external.change':
      return t('kind.external.change');
    case 'conflict':
      return t('kind.conflict');
    case 'lock.denied':
      return t('kind.lock.denied');
    case 'merge':
      return t('kind.merge');
  }
}

/** Badge tone of a kind: problems stand out, agents are marked, the rest is neutral. */
export function kindTone(kind: ActivityKind): 'neutral' | 'info' | 'warning' | 'danger' {
  switch (kind) {
    case 'conflict':
      return 'danger';
    case 'lock.denied':
    case 'external.change':
      return 'warning';
    case 'agent.edit':
      return 'info';
    default:
      return 'neutral';
  }
}

export function filterLabel(filter: FeedFilter): string {
  switch (filter) {
    case 'all':
      return t('filter.all');
    case 'agents':
      return t('filter.agents');
    case 'people':
      return t('filter.people');
    case 'problems':
      return t('filter.problems');
  }
}

export function matchesFilter(event: ActivityEvent, filter: FeedFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'agents':
      return event.actor.kind === 'agent';
    case 'people':
      return event.actor.kind === 'user';
    case 'problems':
      return event.kind === 'conflict' || event.kind === 'lock.denied' || event.kind === 'external.change';
  }
}

/** 「Claude（Ian）」 for agents (the daemon names them after their owner), the member's name, or 「外部程式」. */
export function actorLabel(actor: Actor): string {
  return actor.kind === 'system' ? t('actor.system') : actor.displayName;
}

/**
 * An agent's change that came from a shell command (its Bash tool; ARCHITECTURE §11 D-13): the daemon attributes it to
 * that agent (`agent.edit`, the agent as actor) and marks it `via: 'bash'` (its summary reads 「Claude（Ian）透過 shell
 * 指令修改了 …」, but the wording is never what decides). The feed shows it as that agent's, with a small 「透過指令」
 * marker; the decision is the daemon's alone (an unclaimed change stays 「外部程式」, a `system` actor, no marker).
 */
export function viaShellCommand(event: ActivityEvent): boolean {
  return event.kind === 'agent.edit' && event.actor.kind === 'agent' && event.via === 'bash';
}

/** A deleted file has nothing to open; everything else opens in the editor (a folder is refused there, harmlessly). */
export function canOpenFileOf(event: ActivityEvent): boolean {
  return event.file !== undefined && event.kind !== 'file.delete';
}
