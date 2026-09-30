import { z } from 'zod';
import {
  CHUNK_HASH_BYTES,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  MSGPACK_MAX_BIN_LENGTH,
  UPLOAD_HASHES_PAGE_MAX,
} from '../../constants.ts';
import { errorPayloadSchema } from '../../errors.ts';
import { diskReportSchema, fileEntrySchema, reasonTextSchema } from '../entities.ts';
import { DOWNLOAD_SKIPPED_MAX, UPLOAD_PLAN_MAX_ENTRIES } from '../limits.ts';
import { entryPathSchema, fileRefSchema, pathSegmentSchema, rootRefSchema } from '../paths.ts';
import { byteCountSchema, bytesSchema, etagSchema, fileTimeMsSchema, indexSchema, opaqueIdSchema } from '../primitives.ts';
import { emptyPayloadSchema } from './channel.ts';

// file.upload.* / file.download.* on the transfer channel (ARCHITECTURE §5.2, transfer.md §1.3–§1.6). Every message
// of a transfer, including begin, commit and acks, travels on the transfer socket: there is no ordering across
// sockets. Ack window: TRANSFER_WINDOW_CHUNKS un-acknowledged chunks per transfer.

export const UPLOAD_CONFLICT_POLICIES = ['fail', 'overwrite', 'rename'] as const;
export const uploadConflictPolicySchema = z.enum(UPLOAD_CONFLICT_POLICIES);

const chunkSizeSchema = z.int().min(MIN_CHUNK_SIZE).max(MAX_CHUNK_SIZE);
const chunkHashSchema = bytesSchema({ exact: CHUNK_HASH_BYTES });

/** A file needs its size (for the batch disk check); a directory has none. */
export const uploadPlanEntrySchema = z
  .strictObject({ path: entryPathSchema, kind: z.enum(['file', 'dir']), size: byteCountSchema.optional() })
  .refine((entry) => (entry.kind === 'file') === (entry.size !== undefined), 'files need a size, directories none');

/** Folder drops: one disk check for the whole batch; creates every directory (also empty ones). */
export const fileUploadPlanPayloadSchema = z.strictObject({
  root: rootRefSchema,
  entries: z.array(uploadPlanEntrySchema).min(1).max(UPLOAD_PLAN_MAX_ENTRIES),
  onConflict: uploadConflictPolicySchema,
});
export const fileUploadPlanResultSchema = z.strictObject({
  disk: diskReportSchema,
  /** entries that `onConflict: 'rename'` moved to a free name */
  renamed: z.array(z.strictObject({ from: entryPathSchema, to: entryPathSchema })).max(UPLOAD_PLAN_MAX_ENTRIES),
});

/**
 * Starts or resumes an upload. Resume by `uploadId`, or by identity (user, root, path, size, lastModified,
 * chunkSize). `lastModified` is the browser's `File.lastModified` (epoch ms).
 */
export const fileUploadBeginPayloadSchema = z.strictObject({
  root: rootRefSchema,
  path: entryPathSchema,
  size: byteCountSchema,
  chunkSize: chunkSizeSchema,
  lastModified: fileTimeMsSchema,
  uploadId: opaqueIdSchema.optional(),
  onConflict: uploadConflictPolicySchema.optional(),
});
/**
 * `chunkCount` = ceil(size / chunkSize) (0 for an empty file). `have` is a bitmap of stored chunks, bit `i & 7` of
 * byte `i >> 3`. `received` = number of stored chunks.
 */
export const fileUploadBeginResultSchema = z.strictObject({
  uploadId: opaqueIdSchema,
  chunkCount: indexSchema,
  have: bytesSchema({ max: MSGPACK_MAX_BIN_LENGTH }),
  received: indexSchema,
  resumed: z.boolean(),
  disk: diskReportSchema,
});

/** Hashes of stored chunks, paged (32 bytes per chunk; at most UPLOAD_HASHES_PAGE_MAX per page). */
export const fileUploadHashesPayloadSchema = z.strictObject({
  uploadId: opaqueIdSchema,
  from: indexSchema,
  count: z.int().min(1).max(UPLOAD_HASHES_PAGE_MAX),
});
export const fileUploadHashesResultSchema = z.strictObject({
  hashes: bytesSchema({ max: UPLOAD_HASHES_PAGE_MAX * CHUNK_HASH_BYTES }).refine(
    (bytes) => bytes.byteLength % CHUNK_HASH_BYTES === 0,
    `length must be a multiple of ${CHUNK_HASH_BYTES}`,
  ),
});

/** `hash` = SHA-256(data). Rejected unless this connection began or resumed the upload. */
export const fileUploadChunkPayloadSchema = z.strictObject({
  uploadId: opaqueIdSchema,
  index: indexSchema,
  hash: chunkHashSchema,
  data: bytesSchema({ min: 1, max: MAX_CHUNK_SIZE }),
});
export const fileUploadChunkResultSchema = z.strictObject({ index: indexSchema });

/** `rootHash = SHA-256(u64be size ‖ u32be chunkSize ‖ h0 … hn-1)` */
export const fileUploadCommitPayloadSchema = z.strictObject({ uploadId: opaqueIdSchema, rootHash: chunkHashSchema });
export const fileUploadCommitResultSchema = z.strictObject({ entry: fileEntrySchema });

export const fileUploadAbortPayloadSchema = z.strictObject({ uploadId: opaqueIdSchema });
export const fileUploadAbortResultSchema = emptyPayloadSchema;

/**
 * A single file (resumable with `offset` + `ifMatch`), or a folder as a streamed zip (`zip: true`, never resumable,
 * so `offset`/`ifMatch` are refused with it). `path: ""` zips the whole root.
 */
export const fileDownloadBeginPayloadSchema = z
  .strictObject({
    file: fileRefSchema,
    zip: z.boolean().optional(),
    offset: byteCountSchema.optional(),
    ifMatch: etagSchema.optional(),
  })
  .refine((p) => p.zip !== true || (p.offset === undefined && p.ifMatch === undefined), {
    message: 'zip downloads are not resumable',
    path: ['offset'],
  });
export const fileDownloadBeginResultSchema = z.strictObject({
  downloadId: opaqueIdSchema,
  /** file name to save as (e.g. `report.pdf`, `data.zip`) */
  name: pathSegmentSchema,
  /** absent for zips (size unknown until the end) */
  size: byteCountSchema.optional(),
  etag: etagSchema.optional(),
  zip: z.boolean(),
});

export const fileDownloadChunkPayloadSchema = z.strictObject({
  downloadId: opaqueIdSchema,
  index: indexSchema,
  offset: byteCountSchema,
  data: bytesSchema({ min: 1, max: MAX_CHUNK_SIZE }),
});

/** Grants one chunk of credit. */
export const fileDownloadAckPayloadSchema = z.strictObject({ downloadId: opaqueIdSchema, index: indexSchema });

export const downloadSkipSchema = z.strictObject({ path: entryPathSchema, reason: reasonTextSchema });

/**
 * Last message of a download. `skipped` lists zip entries left out or stored empty (special files, escaping
 * symlinks, `open:ENOENT`); `zip64` warns that macOS's extractor may report an error. `error` (addition) is set when
 * the download failed after `begin.ok`; the received data is then incomplete.
 */
export const fileDownloadEndPayloadSchema = z.strictObject({
  downloadId: opaqueIdSchema,
  totalBytes: byteCountSchema,
  skipped: z.array(downloadSkipSchema).max(DOWNLOAD_SKIPPED_MAX),
  zip64: z.boolean(),
  error: errorPayloadSchema.optional(),
});

export const fileDownloadCancelPayloadSchema = z.strictObject({ downloadId: opaqueIdSchema });
