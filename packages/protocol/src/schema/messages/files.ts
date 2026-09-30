import { z } from 'zod';
import { actorSchema, fileEntrySchema } from '../entities.ts';
import { FILE_CHANGES_MAX, FILE_CONTENT_MAX_BYTES, FILE_TREE_MAX_DEPTH, FILE_TREE_MAX_ENTRIES } from '../limits.ts';
import { entryPathSchema, entryRefSchema, fileRefSchema, relPathSchema, rootRefSchema } from '../paths.ts';
import { bytesSchema, sha256HexSchema } from '../primitives.ts';
import { emptyPayloadSchema } from './channel.ts';

// file.* on the interactive channel (ARCHITECTURE §5.2). Text editing is doc.*; file.write is for small
// non-collaborative writes and is refused with `locked` while the file has any lock.

/** `depth` 1 = direct children (the default when absent). */
export const fileTreePayloadSchema = z.strictObject({
  root: rootRefSchema,
  path: relPathSchema,
  depth: z.int().min(1).max(FILE_TREE_MAX_DEPTH).optional(),
});
/** `truncated` (addition): more than FILE_TREE_MAX_ENTRIES entries exist; ask for subdirectories one by one. */
export const fileTreeResultSchema = z.strictObject({
  entries: z.array(fileEntrySchema).max(FILE_TREE_MAX_ENTRIES),
  truncated: z.boolean(),
});

export const fileStatPayloadSchema = fileRefSchema;
export const fileStatResultSchema = z.strictObject({ entry: fileEntrySchema });

export const fileCreatePayloadSchema = z.strictObject({ file: entryRefSchema, kind: z.enum(['file', 'dir']) });
export const fileCreateResultSchema = z.strictObject({ entry: fileEntrySchema });

export const fileRenamePayloadSchema = z.strictObject({
  root: rootRefSchema,
  from: entryPathSchema,
  to: entryPathSchema,
});
export const fileRenameResultSchema = z.strictObject({ entry: fileEntrySchema });

export const fileDeletePayloadSchema = z.strictObject({ file: entryRefSchema });
export const fileDeleteResultSchema = emptyPayloadSchema;

/** Reads at most `maxBytes` (default and cap FILE_CONTENT_MAX_BYTES); bigger files go through downloads. */
export const fileReadPayloadSchema = z.strictObject({
  file: entryRefSchema,
  maxBytes: z.int().min(0).max(FILE_CONTENT_MAX_BYTES).optional(),
});
/**
 * `hash` is the SHA-256 (hex) of the returned `content`. When `truncated` is false that is the whole file, and the
 * hash can be sent back as `file.write.ifMatchHash`.
 */
export const fileReadResultSchema = z.strictObject({
  content: bytesSchema({ max: FILE_CONTENT_MAX_BYTES }),
  hash: sha256HexSchema,
  truncated: z.boolean(),
});

export const fileWritePayloadSchema = z.strictObject({
  file: entryRefSchema,
  content: bytesSchema({ max: FILE_CONTENT_MAX_BYTES }),
  /** refuse with `conflict` unless the file's current SHA-256 equals this */
  ifMatchHash: sha256HexSchema.optional(),
});
export const fileWriteResultSchema = z.strictObject({ entry: fileEntrySchema, hash: sha256HexSchema });

export const FILE_CHANGE_KINDS = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const;
export const fileChangeSchema = z.strictObject({
  path: entryPathSchema,
  change: z.enum(FILE_CHANGE_KINDS),
  by: actorSchema.optional(),
});
export const fileChangedPayloadSchema = z.strictObject({
  root: rootRefSchema,
  changes: z.array(fileChangeSchema).min(1).max(FILE_CHANGES_MAX),
});
