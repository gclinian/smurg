// What an AGENT reads when smurg refuses a tool call: the PreToolUse deny reasons (Claude Code shows them to the model
// after `PreToolUse:<Tool> hook error: `, claude-hooks.md §3.4). Fixed English, whatever language the members use:
// the reader is the model, and one session has one transcript. Each text stands on its own, says what happened and
// what the agent should do instead, and has its own wording (it is not the sentence a member sees plus a suffix).
// People are named through `agentSafeName` only (the caller's job): a display name is free text from an identity
// provider.
//
// This file imports NOTHING: `smurg hook` (hook-cli.ts) loads it on every hook invocation and must start fast.

/** How many holder names a deny reason lists before it says "and N more". */
const NAMES_LISTED = 5;

/** Refusals of the hook server itself (before or instead of a decision of the gate). */
export const HOOK_DENY_REASONS = Object.freeze({
  unknownSession: 'smurg cannot tell which session this is (the session ended, or it is not registered with the workspace). Nothing can run in it.',
  ownerGone: 'The member this session runs for is no longer in the workspace. The call was blocked.',
  noTarget: 'smurg cannot tell which file this edit targets. The edit was blocked.',
  outsideRoot: "Only files inside this session's workspace can be edited, and the target is outside it. The edit was blocked.",
  otherRoot: "Only files inside this session's own workspace (or worktree) can be edited, and the target belongs to another one. The edit was blocked.",
  locksUnavailable: "smurg cannot check the file lock right now. The edit was blocked so that it cannot overwrite a teammate's changes. Try again later.",
  timeout: 'smurg could not decide about this call in time, so it was blocked. Try again later.',
  rateLimited: 'smurg received too many requests from this session in a short time. The call was blocked for now. Wait a few seconds, then try again.',
  badRequest: 'smurg could not read the request for this call. It was blocked.',
});

/** The rows of the tool gate that deny (hooks/tool-gate.ts). */
export type GateDenyRow = 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL = /^[A-Za-z0-9_.-]{1,64}$/;

/** One sentence per row of the gate, saying what the session may do instead. `slug` and `tool` are used only when they are plain. */
export function gateDenyReason(row: GateDenyRow, facts: { readonly tool?: string; readonly slug?: string } = {}): string {
  const folder = facts.slug !== undefined && SLUG.test(facts.slug) ? `specs/${facts.slug}/` : "its topic's folder";
  switch (row) {
    case 'G2':
      return `This session does not have ${facts.tool !== undefined && TOOL.test(facts.tool) ? `the tool ${facts.tool}` : 'this tool'}. Use the tools you were given.`;
    case 'G3':
      return "No agent session writes Claude Code's own configuration (.claude, .mcp.json, .git) or a script the project's settings run. Leave the file as it is and say what should change: the host changes it in their own editor.";
    case 'G4':
      return 'Only the host may change this path, and this session does not run with the host\'s rights. Leave the file as it is and say what should change.';
    case 'G5':
      return "A discussion session reads only files inside the shared project, and never the host's private files. Read a file of the project instead.";
    case 'G6':
      return `A discussion session writes only SPEC.md and PLAN.md in ${folder}. Put what you want to record into one of them.`;
    case 'G7':
      return "A work item's session does not change its topic's SPEC.md or PLAN.md. Describe what should change in your result report instead.";
  }
}

function listNames(names: readonly string[]): string {
  if (names.length <= NAMES_LISTED) return names.join(', ');
  return `${names.slice(0, NAMES_LISTED).join(', ')} and ${names.length - NAMES_LISTED} more`;
}

// ---- lock decisions (LockService.requestAgent) --------------------------------------------------------------------

/** People have the file open and are editing it. */
export function humanHeldReason(names: readonly string[]): string {
  return `This file is being edited by ${listNames(names)}. Work on other files first, or try again later.`;
}

/** Another agent holds the lock. */
export function agentHeldReason(agentName: string): string {
  return `${agentName} is changing this file. Work on other files first, or try again later.`;
}

export const OUTSIDE_ROOT_REASON = "This file is not inside this session's workspace, so it cannot be changed.";
export const INVALID_TARGET_REASON = 'A file lock cannot be requested for this path.';
export const LOCK_CAP_REASON = 'This session requested too many file locks in a short time. Try again later.';

// ---- path checks (PathGuard refused the target) -------------------------------------------------------------------

const PATH_DENIED: Readonly<Record<string, string>> = Object.freeze({
  lexical: 'The path of this edit is not valid.',
  'too-long': 'The path of this edit is too long.',
  'unknown-root': "This session's workspace or worktree no longer exists.",
  'root-changed': 'The workspace folder was moved or replaced.',
  'outside-root': 'The target resolves to a place outside the shared folder.',
  symlink: 'The target is a symbolic link, and smurg never writes through one.',
  'shared-link-tampered': 'The link to a shared directory was tampered with.',
  'read-only': 'The target is in a shared directory that is read-only in this worktree.',
  'host-only': 'Only the host may change this path.',
  hidden: 'This path is not accessible.',
  'host-private': "This is one of the host's private files.",
  'hard-link': 'The target has more than one hard link, which smurg does not allow.',
  'special-file': 'The target is a special file (a FIFO, socket or device).',
  changed: 'The target changed while smurg was checking it. Try again.',
  'not-directory': 'Part of the path is a file, not a folder.',
});

/** PathGuard refused the target with `reason` (a PathDeniedReason). */
export function pathDeniedReason(reason: string): string {
  const why = Object.hasOwn(PATH_DENIED, reason) ? (PATH_DENIED[reason] as string) : 'This path cannot be edited.';
  return `${why} The edit was blocked.`;
}

/** The path check failed with another error (`code` is its error code). */
export function pathCheckFailedReason(code: string): string {
  return `smurg could not check the target of this edit (${code}). The edit was blocked.`;
}

// ---- the `smurg hook` process itself ------------------------------------------------------------------------------

/**
 * The hook cannot get an answer from the daemon (row G1 of the gate): nothing runs, whatever the tool, and whatever
 * rule would have let it. `detail` is a short technical reason; "smurg is not reachable" keeps the text greppable.
 */
export function daemonUnreachableReason(detail: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = detail.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
  return `smurg is not reachable on the host (${clean}). Nothing can run until it is back.`;
}
