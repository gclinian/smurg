import * as Y from 'yjs';
import { z } from 'zod';
import { colorSchema, displayNameSchema, userIdSchema } from './primitives.ts';

// Awareness (presence) state validation for `doc.awareness` (yjs-monaco.md Q1 and verification item V5).
//
// The daemon decodes every awareness update, keeps only the `selection` a client sent, validates it with the strict
// schema below, normalises it through Yjs and re-encodes the state with the daemon's own `user`. Without the strict
// schema, payloads such as `{item:{client:1,clock:-5}}` pass a loose check and make
// Y.createAbsolutePositionFromRelativePosition throw on every peer (y-monaco calls it without try/catch).

/** Name of the one Y.Text in every document's Y.Doc (`doc.getText(DOC_TEXT_NAME)`). */
export const DOC_TEXT_NAME = 'content';

const yUintSchema = z.int().min(0);
const yIdSchema = z.strictObject({ client: yUintSchema, clock: yUintSchema });

/**
 * JSON form of a Y.RelativePosition inside the document's root Y.Text (`tname` = DOC_TEXT_NAME). Either `item` or
 * `tname` must be present; `type` (a nested type id) is never valid because the text is a root type; `assoc` is 0 or
 * -1 as produced by Yjs.
 */
export const relativePositionSchema = z
  .strictObject({
    type: z.null().optional(),
    tname: z.literal(DOC_TEXT_NAME).nullable().optional(),
    item: yIdSchema.nullable().optional(),
    assoc: z.int().min(-1).max(0).optional(),
  })
  .refine((position) => position.item != null || position.tname != null, 'item or tname required');
export type RelativePositionJson = z.infer<typeof relativePositionSchema>;

/** y-monaco's selection state: `{ anchor, head }` or null. */
export const awarenessSelectionSchema = z
  .strictObject({ anchor: relativePositionSchema, head: relativePositionSchema })
  .nullable();
export type AwarenessSelection = z.infer<typeof awarenessSelectionSchema>;

/** Normalised RelativePosition JSON, as Yjs itself serialises it (every field present). */
export type NormalizedRelativePosition = {
  type: null;
  tname: string | null;
  item: { client: number; clock: number } | null;
  assoc: number;
};

/**
 * Validates a RelativePosition received from a peer and normalises it through Yjs, because Yjs treats an absent
 * field (`undefined`) differently from `null`. Returns null when the value is not acceptable.
 */
export function sanitizeRelativePosition(value: unknown): NormalizedRelativePosition | null {
  const parsed = relativePositionSchema.safeParse(value);
  if (!parsed.success) return null;
  const normalized = Y.createRelativePositionFromJSON(parsed.data);
  return JSON.parse(JSON.stringify(normalized)) as NormalizedRelativePosition;
}

/**
 * Validates a peer's selection. Returns `{ ok: true, selection }` (selection may be null = no cursor) or
 * `{ ok: false }` when the value must be dropped.
 */
export function sanitizeAwarenessSelection(
  value: unknown,
): { ok: true; selection: { anchor: NormalizedRelativePosition; head: NormalizedRelativePosition } | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, selection: null };
  const parsed = awarenessSelectionSchema.safeParse(value);
  if (!parsed.success || parsed.data === null) return parsed.success ? { ok: true, selection: null } : { ok: false };
  const anchor = sanitizeRelativePosition(parsed.data.anchor);
  const head = sanitizeRelativePosition(parsed.data.head);
  if (anchor === null || head === null) return { ok: false };
  return { ok: true, selection: { anchor, head } };
}

export const AWARENESS_USER_KINDS = ['human', 'agent'] as const;

/**
 * The `user` field of every awareness state, always written by the daemon from its own view of the member
 * (a peer cannot claim to be the host or `Claude (Ian)`).
 */
export const awarenessUserSchema = z.strictObject({
  name: displayNameSchema,
  color: colorSchema,
  kind: z.enum(AWARENESS_USER_KINDS),
  userId: userIdSchema,
});
export type AwarenessUser = z.infer<typeof awarenessUserSchema>;

/** An awareness state as the daemon re-encodes it: `{ user, selection }`. */
export const awarenessStateSchema = z.strictObject({
  user: awarenessUserSchema,
  selection: awarenessSelectionSchema,
});
export type AwarenessState = z.infer<typeof awarenessStateSchema>;
