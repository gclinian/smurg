// Catalog ids that exist on the wire (packages/protocol/src/i18n/messages) and that nothing in the daemon produces,
// with the package that would. wire-texts.test.ts accepts exactly these as unused; with SMURG_RELEASE_GATE=1 it
// accepts none. It was EMPTY from the release composition of 0.5.0 to 0.5.2; while 0.6.0 was being built it held the
// ids of DESIGN 0.6.0 Appendix B.1 that protocol 5 has (step S1) and a later step of that build produced (empty again
// since S5).
//
// The ids of the enumerated families (`permissionMode.*`, `report.outcome.*`, `attention.*`, …) are reached through
// their helpers (permissionModeRef, reportOutcomeRef, attentionRef) and are never listed.
import type { MessageId } from '@smurg/protocol/i18n';

const BY_PACKAGE: Readonly<Record<string, readonly MessageId[]>> = {
};

/** id → the package that will produce it. */
export const PENDING_WIRE_TEXTS: ReadonlyMap<string, string> = new Map(
  Object.entries(BY_PACKAGE).flatMap(([owner, ids]) => ids.map((id) => [id, owner] as const)),
);
