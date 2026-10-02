// The activity feed's sentences as message references (`activity.*` of `@smurg/protocol/i18n`) and the small helpers
// that keep them valid for the schemas: every parameter is clipped here (a path to PATH_SHOWN_MAX characters, at most
// SAMPLE_PATHS sample paths, at most HOLDERS_LISTED holder names), so a reference always passes messageRefSchema and
// its English rendering fits ACTIVITY_SUMMARY_MAX_CHARS after the final clip. What an agent reads (deny reasons) is
// in ../hooks/deny-text.ts.
import { ACTIVITY_SUMMARY_MAX_CHARS, displayNameSchema } from '@smurg/protocol';
import { msg, type MessageRef } from '@smurg/protocol/i18n';
import { RELAY_DISPLAY_NAME_MAX_CHARS } from '@smurg/protocol/relay';
import type { FileChangeKind } from '../core/interfaces.ts';

/** How many holder names a lock-denied entry lists (the count says how many there are). */
const HOLDERS_LISTED = 5;
/** How many changed paths a burst entry names. */
const SAMPLE_PATHS = 3;
/** Longest path shown inside a sentence. */
const PATH_SHOWN_MAX = 200;

/** Cuts `text` to `max` UTF-16 units without splitting a surrogate pair; ends with an ellipsis when cut. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\u2026`;
}

/** Control and bidi characters never go into a summary (lineText rule). */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

/** `ActivityEvent.summary`: single-line text of at most ACTIVITY_SUMMARY_MAX_CHARS. */
export function summary(text: string): string {
  return clipText(clean(text), ACTIVITY_SUMMARY_MAX_CHARS);
}

/** A path as a message parameter: `/` for the root, clipped. */
export function shownPath(path: string): string {
  return clipText(clean(path === '' ? '/' : path), PATH_SHOWN_MAX);
}

function shownName(name: string): string {
  return clipText(clean(name), RELAY_DISPLAY_NAME_MAX_CHARS);
}

function samplePaths(sample: readonly string[]): string[] {
  return sample.slice(0, SAMPLE_PATHS).map(shownPath);
}

/** A display name that passes displayNameSchema (clipped / replaced), for names that arrive from other modules. */
export function safeDisplayName(name: string, fallback: string): string {
  if (displayNameSchema.safeParse(name).success) return name;
  const cleaned = clipText(clean(name).trim(), RELAY_DISPLAY_NAME_MAX_CHARS);
  return displayNameSchema.safeParse(cleaned).success ? cleaned : fallback;
}

// ---- activity sentences -----------------------------------------------------------------------------------------

export function agentEditText(agentName: string, path: string, tool: string | null): MessageRef {
  return msg('activity.agentEdit', { agent: shownName(agentName), path: shownPath(path), ...(tool ? { tool } : {}) });
}

export function agentChangeText(agentName: string, path: string, change: FileChangeKind): MessageRef {
  return msg('activity.agentChange', { agent: shownName(agentName), path: shownPath(path), change });
}

/** An agent's change made by a shell command (Bash tool; ARCHITECTURE §11 D-13). */
export function bashChangeText(agentName: string, path: string, change: FileChangeKind): MessageRef {
  return msg('activity.agentBashChange', { agent: shownName(agentName), path: shownPath(path), change });
}

export function bashBurstText(agentName: string, count: number, sample: readonly string[]): MessageRef {
  return msg('activity.agentBashBurst', { agent: shownName(agentName), count, sample: samplePaths(sample) });
}

export function externalChangeText(path: string, change: FileChangeKind): MessageRef {
  return msg('activity.externalChange', { path: shownPath(path), change });
}

/** A change in `name`'s own worktree made by one of their sessions (a terminal, or an agent among several). */
export function worktreeChangeText(name: string, path: string, change: FileChangeKind): MessageRef {
  return msg('activity.worktreeChange', { name: shownName(name), path: shownPath(path), change });
}

export function worktreeBurstText(name: string, count: number, sample: readonly string[]): MessageRef {
  return msg('activity.worktreeBurst', { name: shownName(name), count, sample: samplePaths(sample) });
}

export function externalBurstText(count: number, sample: readonly string[]): MessageRef {
  return msg('activity.externalBurst', { count, sample: samplePaths(sample) });
}

export function humanEditText(name: string, path: string): MessageRef {
  return msg('activity.humanEdit', { name: shownName(name), path: shownPath(path) });
}

export function lockDeniedText(agentName: string, path: string | null, holderNames: readonly string[] | null, holderIsAgent: boolean): MessageRef {
  const target = path === null ? {} : { path: shownPath(path) };
  if (holderNames === null || holderNames.length === 0) return msg('activity.lockDenied', { agent: shownName(agentName), ...target });
  return msg('activity.lockDeniedHeld', {
    agent: shownName(agentName),
    ...target,
    holders: holderNames.slice(0, HOLDERS_LISTED).map(shownName),
    holderCount: holderNames.length,
    holderIsAgent,
  });
}

/** Tool names come from the hook's stdin (a claim): only a plain identifier is shown. */
export function safeToolName(tool: string): string | null {
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(tool) ? tool : null;
}
