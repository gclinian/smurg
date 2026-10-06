// The pending list of v0.5.0 (DESIGN §9.3 P12, §9.4): what is skipped while the release is being built, each entry
// with the package (or the step of the integration, P12A to P12G) that brings it back. Phase 0 (the foundation)
// removed the behaviour these pointed at (agent sessions in a PTY, suggestions pasted into a PTY); the packages put
// its replacement in place, and the integration empties the list. With SMURG_RELEASE_GATE=1 a non-empty list fails
// the lint.
//
// What is left (2026-10-07, after the integration step P12C): nothing. The relay-level flow of a topic is in the tree
// (tests/e2e/test/t.topic-flow.test.ts), and the audit scenario of tests/e2e/test/r11.console.test.ts drives agent
// sessions and a topic with the stand-in claude: both lists are empty, and no test asks for a pending part.
//
// The daemon's own suites keep their part next to them: packages/daemon/test/fixtures/pending-v050.ts (modules and
// service slots) and packages/daemon/test/fixtures/wire-text-owners.ts (catalog ids nothing produces yet).

export const RELEASE_GATE = process.env['SMURG_RELEASE_GATE'] === '1';

export type Package = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9' | 'P10' | 'P11' | 'P12' | `P12${'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'}`;

/** What an `owner` must look like (the two lints that read the lists check it). */
export const OWNER = /^P(?:[1-9]|1[01]|12[A-G]?)$/;

export interface PendingAcceptanceRef {
  /** The test file as docs/ACCEPTANCE.md spells it. */
  readonly file: string;
  /** One title of that file (the file itself still exists); absent: the whole file is gone. */
  readonly title?: string;
  /** Who writes the test that replaces it; P11 points the document's row at it. */
  readonly owner: Package;
  readonly why: string;
}

/** References of docs/ACCEPTANCE.md to tests that are not in the tree (deleted with their behaviour, or not written yet). */
export const PENDING_ACCEPTANCE_REFS: readonly PendingAcceptanceRef[] = [];

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
 * Parts of cross-package tests that are skipped. (The three parts of the web smokes that drove a suggestion into a
 * TERMINAL were deleted, not revived: a terminal takes no suggestion in protocol 4. The two parts of tests/e2e
 * r11.console came back with the integration: its scenario suggests to, and acts on, an agent session.)
 */
export const PENDING_TEST_PARTS: readonly PendingTestPart[] = [];

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
