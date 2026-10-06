// What the conversation module tells a MODEL (ARCHITECTURE §1 "Languages": text for the model is fixed English and
// lives in the daemon). Each sentence is the refusal Claude Code hands to the agent as the result of the tool call the
// agent wanted to make, so it says what the agent should do instead. Names go through agentSafeName; a person's own
// words went through agentText before they get here.
import { AGENT_ROLE_NAMES, agentSafeName, type Role } from '@smurg/protocol';

/** A discussion session asked for anything but a question (the tool gate has normally refused it already). */
export const DISCUSSION_NO_TOOLS =
  "This session only reads the project, writes the topic's SPEC.md and PLAN.md, and asks the team. This tool does not run here. Ask the team with AskUserQuestion, or say in the conversation what you need.";

/** A write to Claude Code's own configuration, or to a file the host confirmed for it. */
export const HOST_EDITS_CONFIG =
  'The host edits these files themselves. No agent writes .claude/**, .mcp.json, .git/** or a file the host confirmed for Claude Code. Leave the file as it is and say in the conversation what should change.';

/** A command, a diff or an input that is too large to show whole to the person who would allow it. */
export const TOO_LARGE_TO_SHOW =
  'Nobody was asked: this step is too large to show whole to the person who would allow it. Split it into smaller steps (a shorter command, a smaller edit) and try again.';

/** The request cannot be shown at all (its content is not text). */
export const NOT_SHOWABLE = 'Nobody was asked: this step cannot be shown to the person who would allow it. Do it another way.';

/** The same request id was raised twice. */
export const DUPLICATE_REQUEST = 'This request was already answered. Continue without repeating it.';

/** The session has no record any more (it ended while the request was on its way). */
export const SESSION_GONE = 'This session has ended. Nothing more runs here.';

export interface Denier {
  readonly userId: string;
  readonly displayName: string;
  readonly role: Role;
}

/**
 * What the agent reads when a person denies a request: who denied it and, when they wrote one, their line (already
 * cleaned with agentText).
 */
export function deniedByPerson(person: Denier, message?: string): string {
  const who = `${agentSafeName(person.displayName, person.userId)} (${AGENT_ROLE_NAMES[person.role]})`;
  if (message === undefined) return `${who} did not allow this. Do not try it again in another way; continue without it, or ask what to do instead.`;
  return `${who} did not allow this and says what to do instead:\n${message}`;
}
