// Catalog ids that exist on the wire (packages/protocol/src/i18n/messages) and that nothing in the daemon produces,
// with the package that would. wire-texts.test.ts accepts exactly these as unused; with SMURG_RELEASE_GATE=1 it
// accepts none. It was EMPTY from the release composition of 0.5.0 to 0.5.2, and again after 0.6.0's S5; while 0.7.0
// is being built it holds the ids of DESIGN 0.7.0 Appendix B.1 that protocol 6 has (step S1) and a later step of that
// build produces (BUILD-PLAN.md names the step; it takes its ids out of this list).
//
// The ids of the enumerated families (`permissionMode.*`, `report.outcome.*`, `attention.*`, …) are reached through
// their helpers (permissionModeRef, reportOutcomeRef, attentionRef) and are never listed.
import type { MessageId } from '@smurg/protocol/i18n';

const BY_PACKAGE: Readonly<Record<string, readonly MessageId[]>> = {
  // (0.7.0 S3, the merge queue, produces its four lines; also `conversation.continued.restart` for an item whose agent
  // was resolving when smurg stopped, D8, and `conversation.ended.checked` from the finish rule of D12.)
  // 0.7.0 S4, decisions and the end (DESIGN D9, D10, D11, D13).
  'S4 decisions and the end': [
    'conversation.released',
    'conversation.removePathsRequested',
    'conversation.ended.leftOut',
    'topic.check.notReady',
    'plan.item.leaveOut.merged',
    'plan.item.accept.notHeld',
    'plan.item.release.notHeld',
    'plan.item.removePaths.notHeld',
  ],
  // 0.7.0 S5, undo (DESIGN D14).
  'S5 undo': ['conversation.ended.undone', 'undo.changed', 'undo.notOk', 'undo.unavailable.direct', 'undo.unavailable.notFound', 'activity.undo'],
  // 0.7.0 S6, keeping it running (DESIGN D15).
  'S6 keeping it running': ['conversation.continued.usageLimit', 'conversation.continued.error', 'conversation.continued.crash', 'conversation.continued.snapshot'],
};

/** id → the package that will produce it. */
export const PENDING_WIRE_TEXTS: ReadonlyMap<string, string> = new Map(
  Object.entries(BY_PACKAGE).flatMap(([owner, ids]) => ids.map((id) => [id, owner] as const)),
);
