// Names that are stored and shown to everyone have ONE language-neutral spelling (docs/GLOSSARY.md): they are made
// here, by the daemon, and never translated by a client.
import { renderEnglish, msg } from './i18n/index.ts';
import { RELAY_DISPLAY_NAME_MAX_CHARS } from './relay/frames.ts';

/** The text around the owner's name: `Claude (` + `)`. */
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
 * How the agent of a session opened by `ownerDisplayName` appears everywhere (Actor.displayName, LockInfo.agentName,
 * PresenceAgent.displayName, the activity feed, the audit log, git commits): `Claude (Ian)`. The owner's name is
 * clipped so the result always fits displayNameSchema (a maximal owner name plus the wrapper would not).
 */
export function agentDisplayName(ownerDisplayName: string): string {
  return `Claude (${clip(ownerDisplayName, RELAY_DISPLAY_NAME_MAX_CHARS - AGENT_NAME_WRAPPER_CHARS)})`;
}

/**
 * The ENGLISH default title of a session nobody named: `Claude (Ian)` / `Terminal (Ian)`. SessionInfo.title is only
 * what the opener typed; a client shows the default in the viewer's language (`session.title.agent` /
 * `session.title.terminal` of `@smurg/protocol/i18n`). This helper is for fixed-English text (MCP results, logs).
 */
export function defaultSessionTitle(kind: 'agent' | 'terminal', ownerName: string): string {
  return renderEnglish(kind === 'agent' ? msg('session.title.agent', { owner: ownerName }) : msg('session.title.terminal', { owner: ownerName }));
}
