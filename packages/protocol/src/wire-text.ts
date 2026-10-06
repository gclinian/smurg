// Sentences the daemon originates for people (ARCHITECTURE §1 "Languages"): a wire catalog reference with its English
// rendering next to it. One builder, so every module clips the same way and a line, a notice, a plan error and a
// preflight blocker all pass their schemas.
import { renderEnglish, type MessageRef } from './i18n/index.ts';
import type { WireText } from './schema/conversation.ts';
import { FALLBACK_TEXT_MAX_CHARS } from './schema/limits.ts';

function clipLine(text: string, max: number): string {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  if (line.length <= max) return line;
  let end = max - 1;
  const code = line.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${line.slice(0, end)}…`;
}

/** `{ text: ref, fallback: <its English rendering, one line, clipped> }`. `ref` comes from `msg(...)`. */
export function wireText(ref: MessageRef): WireText {
  return { text: ref, fallback: clipLine(renderEnglish(ref), FALLBACK_TEXT_MAX_CHARS) };
}

/** A system line of a conversation (`AgentSessions.append`). */
export function lineEvent(ref: MessageRef): { kind: 'line'; text: MessageRef; fallback: string } {
  return { kind: 'line', ...wireText(ref) };
}

/** A notice of a conversation; `action`: what the notice offers. */
export function noticeEvent(
  level: 'info' | 'warning' | 'error',
  ref: MessageRef,
  action?: 'restart-agent' | 'retry',
): { kind: 'notice'; level: 'info' | 'warning' | 'error'; text: MessageRef; fallback: string; action?: 'restart-agent' | 'retry' } {
  return action === undefined ? { kind: 'notice', level, ...wireText(ref) } : { kind: 'notice', level, ...wireText(ref), action };
}
