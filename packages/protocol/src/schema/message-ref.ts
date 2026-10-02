import { z } from 'zod';
import {
  MESSAGE_ID_MAX_CHARS,
  MESSAGE_ID_PATTERN,
  MESSAGE_PARAM_LIST_ITEM_MAX_CHARS,
  MESSAGE_PARAM_LIST_MAX_ITEMS,
  MESSAGE_PARAM_MAX_KEYS,
  MESSAGE_PARAM_NAME_MAX_CHARS,
  MESSAGE_PARAM_STRING_MAX_CHARS,
  type MessageRef,
} from '../i18n/define.ts';

// The wire shape of a message reference (`@smurg/protocol/i18n`): "message `id` with these parameters". The receiver
// renders it in the viewer's language (`render(locale, ref)`), and falls back to the English text that travels next to
// it. The schema bounds the shape only; whether the id exists and the parameters fit is decided by `render`.
//
// Imports nothing from ../errors.ts (errors.ts uses this schema for `error.text`): the three forbidden record keys are
// repeated here, and message-ref.test.ts checks them against FORBIDDEN_RECORD_KEYS.
const FORBIDDEN_PARAM_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export const messageParamValueSchema = z.union([
  z.string().max(MESSAGE_PARAM_STRING_MAX_CHARS),
  z.number().refine((value) => Number.isFinite(value), 'not a finite number'),
  z.boolean(),
  z.array(z.string().max(MESSAGE_PARAM_LIST_ITEM_MAX_CHARS)).max(MESSAGE_PARAM_LIST_MAX_ITEMS),
]);

export const messageParamsSchema = z
  .record(z.string().min(1).max(MESSAGE_PARAM_NAME_MAX_CHARS), messageParamValueSchema)
  .refine((params) => Object.keys(params).length <= MESSAGE_PARAM_MAX_KEYS, `at most ${MESSAGE_PARAM_MAX_KEYS} parameters`)
  .refine((params) => Object.keys(params).every((name) => !FORBIDDEN_PARAM_NAMES.has(name)), 'forbidden key');

export const messageRefSchema = z.strictObject({
  id: z.string().min(1).max(MESSAGE_ID_MAX_CHARS).regex(MESSAGE_ID_PATTERN, 'not a message id'),
  params: messageParamsSchema.optional(),
});

export type { MessageParamValue, MessageParams, MessageRef } from '../i18n/define.ts';

// Compile-time: what the schema parses is a MessageRef, and a MessageRef fits a field typed by the schema.
type Parsed = z.infer<typeof messageRefSchema>;
const _parsedIsRef = (value: Parsed): MessageRef => value;
const _refIsParsed = (value: MessageRef): Parsed => value;
void _parsedIsRef;
void _refIsParsed;
