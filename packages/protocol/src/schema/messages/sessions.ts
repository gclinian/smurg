import { z } from 'zod';
import {
  loginStateSchema,
  sessionInfoSchema,
  sessionKindSchema,
  terminalColsSchema,
  terminalRowsSchema,
} from '../entities.ts';
import {
  EXEC_INPUT_MAX_BYTES,
  EXEC_OUTPUT_MAX_BYTES,
  IMPORT_CONFIG_FILE_MAX_BYTES,
  IMPORT_CONFIG_MAX_FILES,
  IMPORT_CONFIG_TOTAL_MAX_BYTES,
  LIST_MAX_ITEMS,
  TERMINAL_ATTACH_MAX_BYTES,
} from '../limits.ts';
import { entryPathSchema, relPathSegments } from '../paths.ts';
import { apiKeySchema, byteCountSchema, bytesSchema, opaqueIdSchema, shortTextSchema } from '../primitives.ts';
import { emptyPayloadSchema } from './channel.ts';

// session.* and exec.* (ARCHITECTURE §5.5, pty-packaging.md). Terminal output is addressed by absolute byte offset.
// exec.* and file.* never share types or handlers (future two-way sync).

/** Main workspace, or a worktree: a new one, or `worktreeId` of a kept one to continue in (R9). */
export const sessionWorkspaceSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('main') }),
  z.strictObject({ mode: z.literal('worktree'), worktreeId: opaqueIdSchema.optional() }),
]);

/**
 * The caller's role decides the sandbox (host → unsandboxed, runner → sandboxed); a client never chooses it.
 * `apiKey` (sensitive): the guest's own key, sandboxed sessions only; held in daemon memory for that session,
 * injected only into that PTY's environment, never persisted, logged or audited.
 * `kind: 'login'` (addition, ARCHITECTURE §11 D-12): the caller's own Claude subscription login, guests only. The
 * daemon decides the command, its arguments, environment and directory; `workspace` must be `main` and `apiKey` absent.
 */
export const sessionCreatePayloadSchema = z.strictObject({
  kind: sessionKindSchema,
  workspace: sessionWorkspaceSchema,
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
  title: shortTextSchema.optional(),
  apiKey: apiKeySchema.optional(),
});
export const sessionCreateResultSchema = z.strictObject({ session: sessionInfoSchema });

export const sessionListPayloadSchema = emptyPayloadSchema;
export const sessionListResultSchema = z.strictObject({ sessions: z.array(sessionInfoSchema).max(LIST_MAX_ITEMS) });

/** Runs `claude auth status --json` in the session's environment. */
export const sessionLoginStatusPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema });
export const sessionLoginStatusResultSchema = z.strictObject({ login: loginStateSchema });

/**
 * `haveOffset`: the client still holds output up to this offset (a raw `delta` is possible if no resize happened
 * since). `cols`/`rows` (addition, both or neither): the client's viewport; for the owner this drives the PTY size
 * (pty-packaging.md resize policy `owner`), for everyone else it is ignored.
 */
export const sessionAttachPayloadSchema = z
  .strictObject({
    sessionId: opaqueIdSchema,
    haveOffset: byteCountSchema.optional(),
    cols: terminalColsSchema.optional(),
    rows: terminalRowsSchema.optional(),
  })
  .refine((p) => (p.cols === undefined) === (p.rows === undefined), 'cols and rows go together');

/**
 * `snapshot`: a serialized terminal (paint after a reset); `delta`: raw output since `haveOffset`. Live `exec.output`
 * continues at `nextOffset`.
 */
export const sessionAttachResultSchema = z.strictObject({
  session: sessionInfoSchema,
  mode: z.enum(['snapshot', 'delta']),
  data: bytesSchema({ max: TERMINAL_ATTACH_MAX_BYTES }),
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
  nextOffset: byteCountSchema,
});

export const sessionDetachPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema });

export const sessionEndPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema, keepWorktree: z.boolean().optional() });
export const sessionEndResultSchema = emptyPayloadSchema;

export const sessionStatePayloadSchema = z.strictObject({ session: sessionInfoSchema });

/** Paths a guest may import into their own config dir: CLAUDE.md, commands/**, skills/** (SPEC R4). */
export function isImportableConfigPath(path: string): boolean {
  const segments = relPathSegments(path);
  if (segments.length === 1) return segments[0] === 'CLAUDE.md';
  return segments.length >= 2 && (segments[0] === 'commands' || segments[0] === 'skills');
}

const importConfigPathSchema = entryPathSchema.refine(
  isImportableConfigPath,
  'only CLAUDE.md, commands/** and skills/** can be imported',
);

/**
 * Writes into the caller's own guest config dir (sensitive: the files are the user's personal configuration). At most
 * IMPORT_CONFIG_TOTAL_MAX_BYTES of content per request (one Envelope is at most MAX_APP_MESSAGE): clients batch a
 * bigger import into several requests, and the daemon writes each request's files all or none.
 */
export const sessionImportConfigPayloadSchema = z.strictObject({
  files: z
    .array(z.strictObject({ relPath: importConfigPathSchema, content: bytesSchema({ max: IMPORT_CONFIG_FILE_MAX_BYTES }) }))
    .min(1)
    .max(IMPORT_CONFIG_MAX_FILES)
    .refine(
      (files) => files.reduce((total, file) => total + file.content.byteLength, 0) <= IMPORT_CONFIG_TOTAL_MAX_BYTES,
      `at most ${IMPORT_CONFIG_TOTAL_MAX_BYTES} bytes of content per request`,
    ),
});
export const sessionImportConfigResultSchema = z.strictObject({
  written: z.array(importConfigPathSchema).max(IMPORT_CONFIG_MAX_FILES),
});

/** PTY output starting at absolute byte `offset`. */
export const execOutputPayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  offset: byteCountSchema,
  data: bytesSchema({ min: 1, max: EXEC_OUTPUT_MAX_BYTES }),
});

/** Keystrokes / paste from the session owner. */
export const execInputPayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  data: bytesSchema({ min: 1, max: EXEC_INPUT_MAX_BYTES }),
});

/**
 * c→d from the owner: resize the PTY. d→c (addition): the PTY was resized; viewers render at exactly this size.
 * Sent in stream order with exec.output, so a viewer applies it between the right bytes.
 */
export const execResizePayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
});
