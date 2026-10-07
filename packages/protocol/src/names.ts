// Names that are stored and shown to everyone have ONE language-neutral spelling (docs/GLOSSARY.md): they are made
// here, by the daemon, and never translated by a client.
import { agentSafeName } from './agent-text.ts';
import { renderEnglish, msg, type MessageRef } from './i18n/index.ts';
import { normalized } from './normalize.ts';
import { RELAY_DISPLAY_NAME_MAX_CHARS } from './relay/frames.ts';
import type { AgentStatus, SessionInfo } from './schema/entities.ts';

/** The text around the label: `Claude (` + `)`. */
const AGENT_NAME_WRAPPER_CHARS = 'Claude ()'.length;

/** Cuts `text` to `max` UTF-16 units without splitting a surrogate pair; ends with an ellipsis when cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\u2026`;
}

/**
 * How the agent of a session appears everywhere (Actor.displayName, LockInfo.agentName, PresenceAgent.displayName, the
 * activity feed, the audit log, git commits): `Claude (<label>)`. The label follows the session: the topic's name for
 * a discussion (`Claude (Checkout)`), the item's title for an execution session (`Claude (Cart API)`), the opener's
 * display name for a free session (`Claude (Ian)`). Callers pass the label through `agentSafeName` first when a model
 * will read the name. The label is clipped so the result always fits displayNameSchema. The ONLY function that spells it.
 */
export function agentDisplayName(label: string): string {
  return `Claude (${clip(label, RELAY_DISPLAY_NAME_MAX_CHARS - AGENT_NAME_WRAPPER_CHARS)})`;
}

/**
 * THE name of one agent session, wherever the agent itself is named: `presence.state`, its caret in a document, a
 * lock it holds, the activity feed, the audit log. One function of the session, so every place that shows the same
 * agent shows one name and a client can match them: the work item's title, else the topic's name, else the display
 * name of the member who opened the session, made safe for a model to read.
 */
export function agentSessionName(session: { readonly item?: { readonly title: string } | undefined; readonly topicName?: string | undefined; readonly openedBy: { readonly userId: string; readonly displayName: string } }): string {
  return agentDisplayName(agentSafeName(session.item?.title ?? session.topicName ?? session.openedBy.displayName, session.openedBy.userId));
}

/**
 * Whether an agent session is at work right now: starting, in a turn, or waiting inside one for an answer or a
 * permission. Only then has it a "current file" and a caret in a document; between turns (`idle`, `done`, `stalled`,
 * `failed`) the session lives on and works on nothing.
 */
export function isAgentAtWork(status: AgentStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'waiting-answer' || status === 'waiting-permission';
}

/**
 * The ENGLISH default title of a session nobody named: `Claude (Ian)` / `Terminal (Ian)`. SessionInfo.title is only
 * what a person gave; a client shows the default in the viewer's language (`sessionTitleRef` below).
 * This helper is for fixed-English text (MCP results, logs).
 */
export function defaultSessionTitle(kind: 'agent' | 'terminal', openerName: string): string {
  return renderEnglish(kind === 'agent' ? msg('session.title.agent', { owner: openerName }) : msg('session.title.terminal', { owner: openerName }));
}

/**
 * The name of a session nobody named (`SessionInfo.title` is absent), as a reference each client renders in the
 * viewer's language: `Terminal (Ian)`; a free agent session `Claude (Ian)`; a topic's discussion `Discussion`; a work
 * item's session `2 · Payment form` (from `AgentSession.item`). The web, the CLI and the daemon's own fixed-English
 * texts all name a session through this one function.
 */
export function sessionTitleRef(session: Pick<SessionInfo, 'kind' | 'openedBy'> & { readonly purpose?: 'discussion' | 'item' | 'free'; readonly item?: { readonly number: number; readonly title: string } }): MessageRef {
  if (session.kind === 'terminal') return msg('session.title.terminal', { owner: session.openedBy.displayName });
  if (session.purpose === 'discussion') return msg('session.title.discussion');
  if (session.purpose === 'item' && session.item !== undefined) return msg('session.title.item', { number: session.item.number, title: session.item.title });
  return msg('session.title.agent', { owner: session.openedBy.displayName });
}

/** The first characters of a first message as a FREE session's title (`AgentSession.title` when none was typed). */
export const FIRST_MESSAGE_TITLE_CHARS = 40;
export function titleFromFirstMessage(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return clip(line, FIRST_MESSAGE_TITLE_CHARS);
}

// ---------------------------------------------------------------------------------------------------------------
// Topic slugs
// ---------------------------------------------------------------------------------------------------------------

const SLUG_MAX_CHARS = 48;
/** A name must give at least this many slug characters; else the slug is `topic-<n>`. */
const SLUG_MIN_CHARS = 3;

/**
 * The folder name a topic's name gives (`specs/<slug>`): lower-case ASCII letters and digits, everything else a
 * hyphen, at most 48 characters. When the name gives fewer than three slug characters (as a Chinese name does) the
 * slug is `topic-<n>` with the smallest number that `taken` does not hold. A derived slug is returned even when it is
 * taken: the daemon refuses it (`topic.slugTaken` / `topic.folderExists`) and the member changes the field.
 */
export function slugFromName(name: string, taken: Iterable<string> = []): string {
  const ascii = normalized(name, 'NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const slug = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/g, '');
  if (slug.replaceAll('-', '').length >= SLUG_MIN_CHARS) return slug;
  const used = new Set(taken);
  for (let n = 1; ; n += 1) {
    const candidate = `topic-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
