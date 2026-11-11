// Which agent sessions are confined is asked in ONE place (DESIGN 0.8.0 D3.2): `confinedPurpose(purpose)` of
// packages/protocol/src/tools.ts, true for a topic's discussion and for Claude for the sticky notes. Before 0.8.0 the
// code asked `purpose === 'discussion'` wherever it meant "this session is confined" (the hook's read checks, gate row
// G5, the automatic deny of every permission request, the fixed mode, the launch profile): a second confined purpose
// that one such place missed would fail open there.
//
// So no source of packages/*/src or apps/web/src compares a value with the literal 'discussion' (=== !== == != or a
// `case`) except at the places listed here, each of which really means a topic's discussion (or no purpose at all),
// each with its reason. A new comparison fails until it is listed with its reason, or asks confinedPurpose instead.
// Test files are not read: what they compare decides nothing at run time.
import { describe, expect, it } from 'vitest';
import { read, repoFiles } from './tree.ts';

interface Place {
  /** Repository-relative path. */
  readonly file: string;
  /** Text of the line that holds the comparison (a part of it that names the place). */
  readonly code: string;
  /** Why it means a topic's discussion and not "confined". */
  readonly why: string;
}

const PLACES: readonly Place[] = [
  // ---- packages/protocol
  { file: 'packages/protocol/src/tools.ts', code: "return purpose === 'discussion' || purpose === 'notes';", why: 'confinedPurpose itself: the one place that says which purposes are confined' },
  { file: 'packages/protocol/src/names.ts', code: "if (session.purpose === 'discussion') return msg('session.title.discussion');", why: "a topic's discussion is named Discussion" },
  { file: 'packages/protocol/src/routing.ts', code: "if (session.purpose === 'discussion') return false;", why: "nobody ends a topic's discussion (its topic is archived, or the discussion restarted)" },
  { file: 'packages/protocol/src/schema/entities.ts', code: "(s.purpose === 'discussion' || s.purpose === 'item') === (s.topicId !== undefined)", why: 'the sessions of a topic (a discussion, a work item) have its id; a free and a notes session none' },
  // ---- packages/daemon: the gate, the profile, the MCP tools
  { file: 'packages/daemon/src/hooks/tool-gate.ts', code: "if (session.purpose === 'discussion') {", why: "row G6: a discussion writes its topic's SPEC.md and PLAN.md (the notes' G13 is its own branch)" },
  { file: 'packages/daemon/src/sessions/agent/profiles.ts', code: "if (purpose === 'discussion') allow.push(...files);", why: "the allow rules of a discussion's two files, from its topic's slug" },
  { file: 'packages/daemon/src/hooks/mcp-tools.ts', code: "session.purpose === 'discussion') return 'Discussion';", why: "a topic's discussion is named Discussion to other agents" },
  { file: 'packages/daemon/src/hooks/mcp-tools.ts', code: "if (context.purpose !== 'discussion') return { ok: false", why: "check_plan is a tool of a topic's discussion only" },
  { file: 'packages/daemon/src/hooks/mcp-tools.ts', code: "if (context.purpose !== 'discussion') throw new McpToolError", why: "propose_split is a tool of a topic's discussion only" },
  // ---- packages/daemon: sessions
  { file: 'packages/daemon/src/sessions/agent/agent-sessions.ts', code: "const ofTopic = input.purpose === 'discussion' || input.purpose === 'item';", why: 'the sessions that need a topic to start' },
  { file: 'packages/daemon/src/sessions/agent/agent-sessions.ts', code: "if (input.purpose === 'discussion' && input.item !== undefined)", why: "a topic's discussion has no work item" },
  { file: 'packages/daemon/src/sessions/agent/store.ts', code: "rest.purpose !== 'discussion' && mode === 'ask-all'", why: "the step from 0.5.0's agent-sessions.json: 0.5.x had no other confined purpose, and a step is never changed" },
  { file: 'packages/daemon/src/sessions/session-manager.ts', code: "if (session.purpose === 'discussion') throw new AuthorizationError(msg('session.end.discussion')", why: "nobody ends a topic's discussion" },
  { file: 'packages/daemon/src/core/fakes/agents.ts', code: "const ofTopic = input.purpose === 'discussion' || input.purpose === 'item';", why: 'the fake keeps the real start rule: the sessions that need a topic' },
  { file: 'packages/daemon/src/core/fakes/agents.ts', code: "if (input.purpose === 'discussion' && input.item !== undefined)", why: "the fake keeps the real start rule: a topic's discussion has no work item" },
  { file: 'packages/daemon/src/core/fakes/sessions.ts', code: "session.purpose === 'discussion') throw new SmurgError('forbidden', msg('session.end.discussion')", why: "the fake keeps the real rule: nobody ends a topic's discussion" },
  // ---- packages/daemon: topics
  { file: 'packages/daemon/src/topics/module.ts', code: "event.session.purpose === 'discussion' && event.session.status === 'failed'", why: "a topic's discussion failed while it wrote the spec or the plan" },
  { file: 'packages/daemon/src/topics/plan-service.ts', code: "if (mcp.purpose !== 'discussion' || mcp.topic === undefined", why: "the plan tools answer a topic's discussion" },
  { file: 'packages/daemon/src/topics/topic-service.ts', code: "session.purpose !== 'discussion' || session.topicId === undefined) return;", why: "what a topic follows of its own discussion session" },
  // ---- apps/web
  { file: 'apps/web/src/features/console/SessionsSection.tsx', code: "if (session.purpose === 'discussion') return t('sessions.purpose.discussion');", why: "the console's kind column names a topic's discussion" },
  { file: 'apps/web/src/features/console/SessionsSection.tsx', code: "? confirming.purpose === 'discussion'", why: "the confirmation of terminating a topic's session says what the discussion's end costs its topic" },
  { file: 'apps/web/src/features/conversation/Composer.tsx', code: "const inTopic = session.purpose === 'discussion' && session.topicName !== undefined", why: 'the box names a discussion with its topic' },
  { file: 'apps/web/src/features/conversation/StatusBar.tsx', code: "if (session.purpose === 'discussion' && session.topicId !== undefined) {", why: "a topic's discussion offers to write the spec and to start a fresh conversation" },
  { file: 'apps/web/src/features/sidebar/tree-model.ts', code: "const discussions = own.filter((session) => session.purpose === 'discussion');", why: "the Discussion row of a topic's group" },
  { file: 'apps/web/src/features/topics/shared.tsx', code: "where === 'discussion' ? t('sent.discussion') : t('sent.item')", why: "no purpose: where a revision request was sent (a topic's discussion or a work item)" },
  { file: 'apps/web/src/lib/columns/describe.ts', code: "session.purpose === 'discussion' && (session.title ?? '').trim() === ''", why: "a narrow column names a topic's discussion by its topic" },
];

/** A comparison with the literal 'discussion', in any quotes, or a `case` of it. */
const COMPARISON = /[!=]=?=\s*(['"`])discussion\1|(['"`])discussion\2\s*[!=]=?=|\bcase\s+(['"`])discussion\3/;
const SOURCE = /^(?:packages\/[^/]+\/src|apps\/web\/src)\/.+\.(?:ts|tsx|mts|mjs|js)$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;

interface Found {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function comparisons(): Found[] {
  const found: Found[] = [];
  for (const file of repoFiles()) {
    if (!SOURCE.test(file) || TEST.test(file)) continue;
    const text = read(file);
    if (!text.includes('discussion')) continue;
    text.split('\n').forEach((line, index) => {
      if (COMPARISON.test(line)) found.push({ file, line: index + 1, text: line.trim() });
    });
  }
  return found;
}

describe("the confined purposes are asked through confinedPurpose, never by comparing with 'discussion' (DESIGN 0.8.0 D3.2)", () => {
  const found = comparisons();

  it('reads the sources (the places it lists exist)', () => {
    expect(found.length).toBeGreaterThanOrEqual(PLACES.length);
    for (const place of PLACES) expect(repoFiles(), place.file).toContain(place.file);
  });

  it("every comparison with 'discussion' is a listed place that means a topic's discussion; every listed place is still there, once", () => {
    const unlisted = found.filter((hit) => PLACES.filter((place) => place.file === hit.file && hit.text.includes(place.code)).length !== 1);
    expect(unlisted.map((hit) => `${hit.file}:${hit.line}: ${hit.text}\n    -> ask confinedPurpose(purpose) where this means "confined"; else list it here with its reason`)).toEqual([]);
    const stale = PLACES.filter((place) => found.filter((hit) => hit.file === place.file && hit.text.includes(place.code)).length !== 1);
    expect(stale.map((place) => `${place.file}: ${place.code} (${place.why})`)).toEqual([]);
    for (const place of PLACES) expect(place.why.length, place.code).toBeGreaterThan(10);
  });

  it('the rule itself: what counts as a comparison', () => {
    for (const line of ["if (purpose === 'discussion')", 'x !== "discussion"', "'discussion' === p", 'a == `discussion`', "  case 'discussion':"]) expect(COMPARISON.test(line), line).toBe(true);
    for (const line of ["purpose: 'discussion',", "msg('session.end.discussion')", "t('sessions.purpose.discussion')", "confinedPurpose(purpose)", "'discussion' | 'item'"]) expect(COMPARISON.test(line), line).toBe(false);
  });
});
