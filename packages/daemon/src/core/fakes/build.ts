// TEST ONLY. Builders of valid protocol 4 entities with sensible defaults, for the fakes and for every package's
// tests: `buildQuestion({ sessionId })`, `buildTopic({ phase: 'plan' })`. Each result passes its wire schema. The pure
// ones live in `@smurg/protocol/testing` (the web app and the CLI use the same ones) and are re-exported here; the two
// below build daemon-internal values.
import type { HookSessionRegistration, LaunchProfile } from '../interfaces.ts';

export {
  FAKE_COMMIT,
  FAKE_HASH,
  FAKE_HOST,
  FAKE_NOW,
  buildAgentSession,
  buildEvent,
  buildEvents,
  buildInboxItem,
  buildMergeRequest,
  buildPermission,
  buildPlan,
  buildQuestion,
  buildReport,
  buildReportSummary,
  buildSuggestion,
  buildTerminalSession,
  buildTopic,
  buildWorkItem,
  buildWorktree,
  type Overrides,
} from '@smurg/protocol/testing';

/** The tool list of an execution or free session, as a profile would give it (the names, not the verified list). */
export const FAKE_TOOLS: readonly string[] = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'AskUserQuestion']);

/** A hook registration of a free session opened by a member (`pathRights: 'member'`); override what a test is about. */
export function buildHookRegistration(
  base: Pick<HookSessionRegistration, 'sessionId' | 'ownerUserId' | 'agentName' | 'root'> & Partial<HookSessionRegistration>,
): HookSessionRegistration {
  return { purpose: 'free', pathRights: 'member', tools: FAKE_TOOLS, ...base };
}

/** What the sessions module asks the hooks module to write: Claude Code's default mode, smurg's own MCP server only. */
export function buildLaunchProfile(overrides?: Partial<LaunchProfile>): LaunchProfile {
  return { mode: 'default', tools: FAKE_TOOLS, allow: [], ask: [], deny: [], strictMcp: true, settingSources: 'all', rolePrompt: '', ...overrides };
}
