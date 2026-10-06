// Catalog ids that exist on the wire (packages/protocol/src/i18n/messages) and that nothing in the daemon produces,
// with the package that would. wire-texts.test.ts accepts exactly these as unused; with SMURG_RELEASE_GATE=1 it
// accepts none. The list is EMPTY since the release composition (every id is produced, or was deleted from the
// catalog in both languages); it stays as the one place where an id may wait while a later version is being built.
//
// The ids of the enumerated families (`permissionMode.*`, `report.outcome.*`, `attention.*`, …) are reached through
// their helpers (permissionModeRef, reportOutcomeRef, attentionRef) and are never listed.
import type { MessageId } from '@smurg/protocol/i18n';

const BY_PACKAGE: Readonly<Record<string, readonly MessageId[]>> = {};

/** id → the package that will produce it. */
export const PENDING_WIRE_TEXTS: ReadonlyMap<string, string> = new Map(
  Object.entries(BY_PACKAGE).flatMap(([owner, ids]) => ids.map((id) => [id, owner] as const)),
);
