import { z } from 'zod';
import {
  loginStateSchema,
  sessionInfoSchema,
  sessionKindSchema,
  terminalColsSchema,
  terminalRowsSchema,
} from '../entities.ts';
import { EXEC_INPUT_MAX_BYTES, EXEC_OUTPUT_MAX_BYTES, LIST_MAX_ITEMS, TERMINAL_ATTACH_MAX_BYTES } from '../limits.ts';
import { byteCountSchema, bytesSchema, opaqueIdSchema, shortTextSchema } from '../primitives.ts';
import { emptyPayloadSchema } from './channel.ts';

// session.* and exec.* (ARCHITECTURE §5.5, pty-packaging.md). Terminal output is addressed by absolute byte offset.
// exec.* and file.* never share types or handlers (future two-way sync).

/** Main workspace, or a worktree: a new one, or `worktreeId` of a kept one to continue in (R9). */
export const sessionWorkspaceSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('main') }),
  z.strictObject({ mode: z.literal('worktree'), worktreeId: opaqueIdSchema.optional() }),
]);

/**
 * Needs `session.create` (host, Agent access). The session runs like the host's own whoever opens it (ARCHITECTURE §11
 * D-15): the host's OS user, unsandboxed, the host's environment and Claude Code login; the caller becomes its owner
 * (attribution). (Protocol 1's `apiKey` and kind `login` are gone.)
 */
export const sessionCreatePayloadSchema = z.strictObject({
  kind: sessionKindSchema,
  workspace: sessionWorkspaceSchema,
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
  title: shortTextSchema.optional(),
});
export const sessionCreateResultSchema = z.strictObject({ session: sessionInfoSchema });

export const sessionListPayloadSchema = emptyPayloadSchema;
export const sessionListResultSchema = z.strictObject({ sessions: z.array(sessionInfoSchema).max(LIST_MAX_ITEMS) });

/** Runs `claude auth status --json` in the session's environment. */
export const sessionLoginStatusPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema });
export const sessionLoginStatusResultSchema = z.strictObject({ login: loginStateSchema });

/**
 * `haveOffset`: the client still holds output up to this offset (a raw `delta` is possible if no resize happened
 * since). `cols`/`rows` (addition, both or neither): the client's viewport; for the owner (the member who opened the
 * session) this drives the PTY size (pty-packaging.md resize policy `owner`), for everyone else it is ignored, also
 * for the other members who may type into it (`session.drive`).
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

/** PTY output starting at absolute byte `offset`. */
export const execOutputPayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  offset: byteCountSchema,
  data: bytesSchema({ min: 1, max: EXEC_OUTPUT_MAX_BYTES }),
});

/** Keystrokes / paste from a member who may drive the session (`session.drive`: any session). */
export const execInputPayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  data: bytesSchema({ min: 1, max: EXEC_INPUT_MAX_BYTES }),
});

/**
 * c→d from the owner (the member who opened the session): resize the PTY. d→c (addition): the PTY was resized; viewers render at exactly this size.
 * Sent in stream order with exec.output, so a viewer applies it between the right bytes.
 */
export const execResizePayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
});
