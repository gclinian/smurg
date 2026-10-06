// The pending list of v0.5.0 (DESIGN §9.3 P12, §9.4): what is skipped while the release is being built, each entry
// with the package that brings it back. Phase 0 (the foundation) removed the behaviour these pointed at (agent
// sessions in a PTY, suggestions pasted into a PTY); the packages named here put its replacement in place, and the
// integration engineer (P12) empties the list. With SMURG_RELEASE_GATE=1 a non-empty list fails the lint.
//
// The daemon's own suites keep their part next to them: packages/daemon/test/fixtures/pending-v050.ts (modules and
// service slots) and packages/daemon/test/fixtures/wire-text-owners.ts (catalog ids nothing produces yet).

export const RELEASE_GATE = process.env['SMURG_RELEASE_GATE'] === '1';

export type Package = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9' | 'P10' | 'P11' | 'P12';

export interface PendingAcceptanceRef {
  /** The test file as docs/ACCEPTANCE.md spells it. */
  readonly file: string;
  /** One title of that file (the file itself still exists); absent: the whole file is gone. */
  readonly title?: string;
  /** Who writes the test that replaces it; P11 points the document's row at it. */
  readonly owner: Package;
  readonly why: string;
}

/** References of docs/ACCEPTANCE.md to tests that were deleted with the behaviour they covered. */
export const PENDING_ACCEPTANCE_REFS: readonly PendingAcceptanceRef[] = [
  {
    file: 'daemon/suggest/r6.pty.test.ts',
    owner: 'P2',
    why: 'R6 over a real PTY: an accepted suggestion is now a message to an agent session (AgentSessions.send), never a paste',
  },
  {
    file: 'daemon/integration/suggest-sessions.test.ts',
    owner: 'P2',
    why: 'the suggest module with the real PTY session manager: suggestions go to conversations now',
  },
  {
    file: 'daemon/sessions/launch.test.ts',
    title: "an agent an Agent access member opens is launched exactly like the host's, and is attributed to her: `Claude (Carol)`,",
    owner: 'P1',
    why: 'agent sessions are no longer PTYs: the agent runtime (runner, profiles, launch check) has its own suite',
  },
];

export interface PendingTestPart {
  /** What the test passes to isPendingPart(). */
  readonly id: string;
  /** The test file that skips this part. */
  readonly where: string;
  /** Who brings it back. */
  readonly owner: Package;
  readonly why: string;
}

/**
 * Parts of cross-package tests (tests/e2e, the web smokes) that are skipped: each drove a suggestion into a TERMINAL
 * and read it back from the PTY. Protocol 4 sends suggestions to agent sessions only, and those need the agent
 * runtime (P1) and the conversation module (P2) in the composition, then the conversation column (P8).
 */
export const PENDING_TEST_PARTS: readonly PendingTestPart[] = [
  {
    id: 'e2e:r11.console#R6',
    where: 'tests/e2e/test/r11.console.test.ts',
    owner: 'P12',
    why: 'the suggest.* audit entries of R6 need an agent session to suggest to (P1 runtime, P2 conversation); the other R4-R9 entries are still checked',
  },
  {
    id: 'e2e:r11.console#agent-actions',
    where: 'tests/e2e/test/r11.console.test.ts',
    owner: 'P12',
    why: 'the audit actions protocol 4 added (messages to agents, questions, permission answers, topics, plans, reports) are written by modules that are not composed yet; the scenario grows by them at integration',
  },
];

/** Whether a part of a test waits for its package (never for the release gate). */
export function isPendingPart(id: string): boolean {
  if (RELEASE_GATE) return false;
  return PENDING_TEST_PARTS.some((entry) => entry.id === id);
}

/** Whether a reference of the document waits for its package (never for the release gate). */
export function isPendingAcceptanceRef(file: string, title?: string): boolean {
  if (RELEASE_GATE) return false;
  return PENDING_ACCEPTANCE_REFS.some((entry) => entry.file === file && (entry.title === undefined || (title !== undefined && entry.title.includes(title))));
}
