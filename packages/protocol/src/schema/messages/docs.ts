import { z } from 'zod';
import { conflictRecordSchema, lockInfoSchema } from '../entities.ts';
import {
  CONFLICT_AGENT_VERSION_MAX_BYTES,
  DOC_AWARENESS_MAX_BYTES,
  DOC_SYNC_MAX_BYTES,
  LIST_MAX_ITEMS,
} from '../limits.ts';
import { entryRefSchema, fileRefSchema } from '../paths.ts';
import { bytesSchema, epochMsSchema, opaqueIdSchema, sha256HexSchema } from '../primitives.ts';
import { emptyPayloadSchema } from './channel.ts';

// doc.* — collaborative documents over Yjs (ARCHITECTURE §5.3, yjs-monaco.md Q1). The daemon holds one Y.Doc and one
// Awareness per open (root, path); `doc.sync` / `doc.awareness` carry exactly the bytes y-protocols produces.

export const docOpenPayloadSchema = z.strictObject({ file: entryRefSchema });

export const DOC_EOLS = ['LF', 'CRLF', 'CR'] as const;
/** How the file looks on disk; the Y.Text is always LF without BOM, and the daemon re-applies these on save. */
export const docMetaSchema = z.strictObject({ eol: z.enum(DOC_EOLS), bom: z.boolean(), mixedEol: z.boolean() });

/**
 * After `doc.open.ok` the daemon sends sync step 1 and an awareness snapshot as `doc.sync` / `doc.awareness`.
 * A client whose replica has another `epoch` must drop it (otherwise the text is duplicated).
 */
export const docOpenResultSchema = z.strictObject({
  docId: opaqueIdSchema,
  epoch: opaqueIdSchema,
  canEdit: z.boolean(),
  lock: lockInfoSchema.optional(),
  meta: docMetaSchema,
});

/** The daemon re-created the Y.Doc: drop the local replica and re-sync. */
export const docResetPayloadSchema = z.strictObject({ docId: opaqueIdSchema, epoch: opaqueIdSchema });

/** A y-protocols sync message (step 1, step 2 or update). Content from members without file.write is dropped. */
export const docSyncPayloadSchema = z.strictObject({
  docId: opaqueIdSchema,
  data: bytesSchema({ min: 1, max: DOC_SYNC_MAX_BYTES }),
});

/** A y-protocols awareness update; the daemon validates selections (awareness.ts) and rewrites `user`. */
export const docAwarenessPayloadSchema = z.strictObject({
  docId: opaqueIdSchema,
  data: bytesSchema({ min: 1, max: DOC_AWARENESS_MAX_BYTES }),
});

export const docClosePayloadSchema = z.strictObject({ docId: opaqueIdSchema });

export const docSavedPayloadSchema = z.strictObject({
  docId: opaqueIdSchema,
  file: fileRefSchema,
  hash: sha256HexSchema,
  at: epochMsSchema,
});

/**
 * 'file-unavailable': the open file was moved, deleted, or replaced by something the editor cannot
 * hold (binary, too large, a link out of the share) on disk. The daemon keeps the text not yet saved as a conflict
 * record (doc.conflict), so clients must not say it was discarded.
 */
export const DOC_REJECT_REASONS = ['agent-locked', 'read-only', 'forbidden', 'file-unavailable'] as const;
/** The client must resync and drop its local change. */
export const docRejectedPayloadSchema = z.strictObject({
  docId: opaqueIdSchema,
  reason: z.enum(DOC_REJECT_REASONS),
  lock: lockInfoSchema.optional(),
});

export const docConflictPayloadSchema = z.strictObject({ conflict: conflictRecordSchema });

export const docConflictListPayloadSchema = emptyPayloadSchema;
export const docConflictListResultSchema = z.strictObject({
  conflicts: z.array(conflictRecordSchema).max(LIST_MAX_ITEMS),
});

export const CONFLICT_RESOLVE_ACTIONS = ['dismiss', 'apply-agent-version'] as const;
export const docConflictResolvePayloadSchema = z.strictObject({
  conflictId: opaqueIdSchema,
  action: z.enum(CONFLICT_RESOLVE_ACTIONS),
});
export const docConflictResolveResultSchema = z.strictObject({ conflict: conflictRecordSchema });

/**
 * (Addition) The full text the agent/process wrote, as UTF-8 bytes: it can be as large as a whole document, which
 * exceeds msgpack's 1 MiB string limit, so it is not inline in ConflictRecord.
 */
export const docConflictGetPayloadSchema = z.strictObject({ conflictId: opaqueIdSchema });
export const docConflictGetResultSchema = z.strictObject({
  conflict: conflictRecordSchema,
  agentVersion: bytesSchema({ max: CONFLICT_AGENT_VERSION_MAX_BYTES }),
});
