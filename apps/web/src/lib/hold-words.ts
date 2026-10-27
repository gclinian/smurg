// Why smurg did not merge a work item it merges by itself (DESIGN 0.7.0 D9): the short words of a hold, in the viewer's
// language, for every place that says it (the plan's badge and banner, the report's foot, the inbox row, the
// conversation's next-step card). Composed from the wire's fields; nothing parses a sentence the daemon wrote.
//
//   holdText('partial')                                   → "not complete (partial)"
//   holdText('conflict', { people: [{ path, by, outside }] }) → "it conflicts with Mei's change of src/a.ts"
import { AUTO_MERGE_REASONS_OF_STATE, type AutoMergeInfo, type AutoMergeReason } from '@smurg/protocol';
import { tStores } from '../strings/stores.ts';
import { formatAnd } from './format.ts';

/** The reasons a hold can carry (AUTO_MERGE_REASONS_OF_STATE.held): the words exist for exactly these. */
export type HeldReason =
  | 'partial' | 'blocked' | 'check-failed' | 'not-verified' | 'report-invalid' | 'rejected' | 'stopped'
  | 'policy' | 'local-changes' | 'in-the-way' | 'staged' | 'branch' | 'history-changed' | 'merge-failed' | 'by-hand' | 'undo-interrupted'
  | 'conflict' | 'stale-report' | 'asked' | 'git-busy';

const HELD: ReadonlySet<AutoMergeReason> = new Set(AUTO_MERGE_REASONS_OF_STATE.held);
const isHeld = (reason: AutoMergeReason): reason is HeldReason => HELD.has(reason);

/** The parts of a hold the words may name: who wrote to the agent, whose change the conflict is against. */
export type HoldFacts = Partial<Pick<AutoMergeInfo, 'people' | 'asked'>>;

/**
 * The short words of a hold. `byHand`: the names of the people who edited the item's files by hand, when the caller
 * knows them (the report's changes say so; the plan and the inbox do not). A reason that is not a hold's (a wait, a
 * resolve) gets the words of the hold it would become: "it does not merge cleanly", else "smurg cannot merge it".
 */
export function holdText(reason: AutoMergeReason, facts: HoldFacts = {}, byHand: readonly string[] = []): string {
  if (!isHeld(reason)) return tStores(reason === 'markers' ? 'hold.conflict' : 'hold.merge-failed');
  switch (reason) {
    case 'conflict': {
      const change = facts.people?.[0];
      if (change === undefined) return tStores('hold.conflict');
      if (change.outside || change.by.length === 0) return tStores('hold.conflict.outside', { path: change.path });
      return tStores('hold.conflict.people', { path: change.path, names: formatAnd(change.by.map((user) => user.displayName)) });
    }
    case 'asked':
      return facts.asked === undefined ? tStores('hold.asked.unnamed') : tStores('hold.asked', { name: facts.asked.displayName });
    case 'by-hand':
      return byHand.length === 0 ? tStores('hold.by-hand.unnamed') : tStores('hold.by-hand', { names: formatAnd([...byHand]) });
    default:
      return tStores(`hold.${reason as Exclude<HeldReason, 'conflict' | 'asked' | 'by-hand'>}`);
  }
}
