// Catalog ids that exist on the wire (packages/protocol/src/i18n/messages) and that nothing in the daemon produces,
// with the package that would. wire-texts.test.ts accepts exactly these as unused; with SMURG_RELEASE_GATE=1 it
// accepts none. It was EMPTY from the release composition of 0.5.0 to 0.5.2; while 0.6.0 is being built it holds the
// ids of DESIGN 0.6.0 Appendix B.1 that protocol 5 has (step S1) and a later step of that build produces.
//
// The ids of the enumerated families (`permissionMode.*`, `report.outcome.*`, `attention.*`, …) are reached through
// their helpers (permissionModeRef, reportOutcomeRef, attentionRef) and are never listed.
import type { MessageId } from '@smurg/protocol/i18n';

const BY_PACKAGE: Readonly<Record<string, readonly MessageId[]>> = {
  // 0.6.0 S3, models (DESIGN D7): Claude Code refuses or substitutes a model.
  'S3 models': ['session.model.refused', 'notice.modelRefused', 'notice.modelSubstituted'],
  // 0.6.0 S4, permissions (DESIGN D9, D10): auto mode's own check, and a mode Claude Code does not run.
  'S4 permissions': ['conversation.autoMode.blocked', 'notice.autoUnavailable.model', 'notice.autoUnavailable.settings', 'notice.asksNothingRefused'],
  // 0.6.0 S5, no git (DESIGN D14, D15): items that run directly in the folder, and smurg's own history.
  'S5 no git': [
    'conversation.started.itemDirect',
    'conversation.ended.reviewed',
    'conversation.direct.waits',
    'plan.start.directUnconfirmed',
    'plan.start.directHostOnly',
    'plan.start.historyChanged',
    'worktree.unavailable.unchecked',
    'worktree.hidden.tooLarge',
    'worktree.hidden.changed',
    'worktree.hidden.unknown',
    'worktree.hidden.gone',
    'worktree.hidden.noSpace',
  ],
};

/** id → the package that will produce it. */
export const PENDING_WIRE_TEXTS: ReadonlyMap<string, string> = new Map(
  Object.entries(BY_PACKAGE).flatMap(([owner, ids]) => ids.map((id) => [id, owner] as const)),
);
