// What the topic screens say about a plan and its items, as pure functions (DESIGN §5.12 item 20).
import { buildPlan, buildReportSummary, buildTopic, buildWorkItem } from '@smurg/protocol/testing';
import type { WorkItem } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { makeMember } from '../../testing/fixtures.ts';
import {
  agentAccessNames,
  andList,
  assignablePeople,
  assignHint,
  handEditsLine,
  itemActions,
  itemBadge,
  itemNames,
  itemNumbers,
  loads,
  planFile,
  planSummary,
  progressLine,
  specFile,
  specOpenQuestions,
  specSections,
  splitLine,
  startsByItselfLines,
  unmergedDependencies,
  waitingForLine,
} from './model.ts';

const IAN = { userId: 'dev:host', displayName: 'Ian' };
const MEI = { userId: 'dev:mei', displayName: 'Mei' };
const item = (id: string, number: number, overrides: Partial<WorkItem> = {}): WorkItem => buildWorkItem({ id, number, title: `Item ${id}`, ...overrides });
const noSession = (): undefined => undefined;

describe('lists inside a sentence', () => {
  it('joins names the way English does', () => {
    expect(andList([])).toBe('');
    expect(andList(['Ian'])).toBe('Ian');
    expect(andList(['Ian', 'Mei'])).toBe('Ian and Mei');
    expect(andList(['1', '2', '3'])).toBe('1, 2, and 3');
  });
});

describe('files and people', () => {
  it('the spec and the plan are files of the main workspace under specs/<slug>', () => {
    const topic = buildTopic({ slug: 'checkout' });
    expect(specFile(topic)).toEqual({ root: { kind: 'main' }, path: 'specs/checkout/SPEC.md' });
    expect(planFile(topic)).toEqual({ root: { kind: 'main' }, path: 'specs/checkout/PLAN.md' });
  });

  it('names the people with agent access (the host first) and who can be made responsible', () => {
    const members = [makeMember({ ...MEI, role: 'agent' }), makeMember({ userId: 'dev:vic', displayName: 'Vic', role: 'viewer' }), makeMember({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' }), makeMember({ ...IAN, role: 'host' })];
    expect(agentAccessNames(members)).toBe('Ian and Mei');
    expect(agentAccessNames([])).toBe('the host');
    expect(assignablePeople(members).map((member) => member.displayName)).toEqual(['Ian', 'Mei', 'Amy']);
    expect(assignHint(makeMember({ ...MEI, role: 'agent' }), 2)).toBe('Agent access · 2 items');
    expect(assignHint(makeMember({ role: 'editor' }), 1)).toBe('Editor · 1 item');
  });

  it('counts the load per responsible person, items still in the plan only', () => {
    const plan = buildPlan({
      items: [
        item('a', 1, { responsible: { ...IAN, source: 'agent' } }),
        item('b', 2, { responsible: { ...MEI, source: 'smurg' } }),
        item('c', 3, { responsible: { ...IAN, source: 'chosen' } }),
        item('gone', 0, { inPlan: false, responsible: { ...MEI, source: 'chosen' } }),
        item('d', 4),
      ],
    });
    expect([...loads(plan).values()].map((entry) => [entry.user.displayName, entry.count])).toEqual([
      ['Ian', 2],
      ['Mei', 1],
    ]);
    expect(splitLine(plan)).toBe('Ian 2 · Mei 1');
  });
});

describe('work items', () => {
  const plan = buildPlan({
    items: [item('a', 1), item('b', 2), item('c', 3, { dependsOn: ['a', 'b'] })],
    slots: { inUse: 8, max: 8, waitingForPeople: 5 },
  });

  it('names items by number and by label, in plan order, leaving out ids the plan no longer has', () => {
    expect(itemNumbers(plan, ['b', 'a', 'nope'])).toBe('1 and 2');
    expect(itemNames(plan, ['a', 'c'])).toBe('1 · Item a and 3 · Item c');
  });

  it('an item waits for what it depends on and is not merged; the daemon’s own list wins', () => {
    expect(unmergedDependencies(plan, plan.items[2] as WorkItem)).toEqual(['a', 'b']);
    const merged = buildPlan({ items: [item('a', 1, { state: 'reviewed', merge: { requestId: 'mr', status: 'merged', ready: false } }), item('b', 2), item('c', 3, { dependsOn: ['a', 'b'] })] });
    expect(unmergedDependencies(merged, merged.items[2] as WorkItem)).toEqual(['b']);
    expect(unmergedDependencies(merged, item('x', 4, { dependsOn: ['a', 'b'], waitsFor: ['a'] }))).toEqual(['a']);
  });

  it.each([
    [item('a', 1), 'Ready to start', 'neutral', false],
    [item('c', 3, { dependsOn: ['a', 'b'] }), 'Waits for 1 and 2', 'neutral', false],
    [item('c', 3, { state: 'waiting', dependsOn: ['a', 'b'] }), 'Waits for 1 and 2', 'neutral', false],
    [item('a', 1, { state: 'queued', armed: true }), 'Waiting for a free agent: 8 of 8 in use, 5 wait for a person', 'neutral', false],
    [item('a', 1, { state: 'running' }), 'Running', 'info', false],
    [item('a', 1, { state: 'stalled', stalledBy: 'agent' }), 'Stopped without a report', 'warning', true],
    [item('a', 1, { state: 'stalled', stalledBy: 'restart' }), 'Paused: smurg was restarted', 'warning', true],
    [item('a', 1, { state: 'stalled', stalledBy: 'stopped' }), 'Stopped by a person, no report', 'warning', true],
    [item('a', 1, { state: 'stalled', stalledBy: 'error' }), 'Stopped on an error, no report', 'warning', true],
    [item('a', 1, { state: 'done', report: buildReportSummary() }), 'Report to review', 'success', false],
    [item('a', 1, { state: 'done', report: buildReportSummary({ outcome: 'partial' }) }), 'Report to review · partial', 'warning', false],
    [item('a', 1, { state: 'done', report: buildReportSummary({ state: 'invalid' }) }), 'The report cannot be read', 'danger', true],
    [item('a', 1, { state: 'done', report: buildReportSummary(), changesAsked: { by: IAN, at: 1 } }), 'Changes asked by Ian', 'info', false],
    [item('a', 1, { state: 'reviewed', report: buildReportSummary({ state: 'reviewed' }) }), 'Reviewed', 'success', false],
    [item('a', 1, { state: 'reviewed', report: buildReportSummary({ state: 'reviewed' }), merge: { requestId: 'mr', status: 'draft', ready: true } }), 'Reviewed · waits for the host to merge', 'success', false],
    [item('a', 1, { state: 'reviewed', report: buildReportSummary({ state: 'reviewed' }), merge: { requestId: 'mr', status: 'merged', ready: false } }), 'Reviewed · merged', 'success', false],
    [item('a', 1, { state: 'reviewed', report: buildReportSummary({ state: 'reviewed' }), merge: { requestId: 'mr', status: 'conflict', ready: true } }), 'Reviewed · merge conflict', 'danger', true],
    [item('a', 1, { state: 'reviewed', report: buildReportSummary({ state: 'changed-after-review' }) }), 'Changed after the review', 'warning', false],
    [item('a', 1, { state: 'failed' }), 'Failed', 'danger', true],
    [item('a', 1, { state: 'stopped' }), 'Session ended', 'neutral', true],
    [item('a', 1, { disarmed: 'plan-changed' }), 'The plan changed: Start again', 'warning', true],
    [item('a', 1, { disarmed: 'starter-removed' }), 'The person who started it left: Start again', 'warning', true],
    [item('a', 1, { disarmed: 'start-failed' }), 'Could not start', 'danger', true],
  ] as const)('the badge of %#', (workItem, text, tone, waitsForPerson) => {
    const badge = itemBadge(workItem, plan);
    expect(badge.text).toBe(text);
    expect(badge.tone).toBe(tone);
    expect(badge.waitsForPerson).toBe(waitsForPerson);
  });

  it('a running item says which kind of waiting its session is in', () => {
    const running = item('a', 1, { state: 'running' });
    expect(itemBadge(running, plan, { status: 'waiting-answer' }).text).toBe('Waiting for an answer');
    expect(itemBadge(running, plan, { status: 'waiting-permission' }).text).toBe('Waiting for permission');
    expect(itemBadge(running, plan, { status: 'running' }).text).toBe('Running');
  });

  it('an item whose dependencies are all reviewed waits only for the host’s merge', () => {
    const waiting = buildPlan({
      items: [
        item('a', 1, { state: 'reviewed', merge: { requestId: 'm1', status: 'draft', ready: true } }),
        item('b', 2, { state: 'reviewed', merge: { requestId: 'm2', status: 'pending', ready: true } }),
        item('c', 3, { state: 'waiting', armed: true, dependsOn: ['a', 'b'] }),
      ],
    });
    expect(itemBadge(waiting.items[2] as WorkItem, waiting).text).toBe('Waits for the host to merge 1 and 2');
  });

  it('what a row offers follows the item’s state', () => {
    expect(itemActions(item('a', 1), plan)).toMatchObject({ start: true, startAgain: false, retry: false, continue: false, session: null, report: false });
    expect(itemActions(plan.items[2] as WorkItem, plan).start).toBe(false);
    expect(itemActions(item('a', 1, { armed: true }), plan).start).toBe(false);
    expect(itemActions(item('a', 1, { disarmed: 'plan-changed' }), plan)).toMatchObject({ start: false, startAgain: true });
    expect(itemActions(item('a', 1, { state: 'failed', sessionId: 's1' }), plan)).toMatchObject({ retry: true, session: 's1' });
    expect(itemActions(item('a', 1, { state: 'stopped' }), plan).retry).toBe(true);
    expect(itemActions(item('a', 1, { state: 'stalled', stalledBy: 'agent' }), plan).continue).toBe(true);
    expect(itemActions(item('a', 1, { state: 'done', report: buildReportSummary() }), plan).report).toBe(true);
    expect(itemActions(item('a', 1, { state: 'reviewed', merge: { requestId: 'm', status: 'conflict', ready: true } }), plan).resolve).toBe(true);
    expect(itemActions(item('gone', 0, { inPlan: false }), plan).start).toBe(false);
  });
});

describe('the plan as a whole', () => {
  it('before the start: how many can start and how many wait', () => {
    const plan = buildPlan({ items: [item('a', 1), item('b', 2), item('c', 3, { dependsOn: ['a'] })] });
    const summary = planSummary(plan, noSession);
    expect(summary).toMatchObject({ total: 3, started: false, canStart: 2, waitsOthers: 1, startable: ['a', 'b', 'c'] });
  });

  it('while executing: reviewed, to review, waiting for a person, running, not started, merged', () => {
    const plan = buildPlan({
      items: [
        item('a', 1, { state: 'running', sessionId: 's1', attempt: 1 }),
        item('b', 2, { state: 'running', sessionId: 's2', attempt: 1 }),
        item('c', 3, { state: 'done', report: buildReportSummary(), attempt: 1 }),
        item('d', 4, { state: 'stalled', stalledBy: 'agent', attempt: 1 }),
        item('e', 5, { state: 'waiting', armed: true, dependsOn: ['a'] }),
        item('f', 6, { state: 'reviewed', merge: { requestId: 'm', status: 'merged', ready: false }, attempt: 1 }),
        item('g', 7, { state: 'reviewed', merge: { requestId: 'm2', status: 'draft', ready: true }, attempt: 1 }),
        item('gone', 0, { inPlan: false, state: 'running' }),
      ],
    });
    const summary = planSummary(plan, (workItem) => (workItem.id === 'b' ? { status: 'waiting-answer' } : undefined));
    expect(summary).toMatchObject({ total: 7, started: true, reviewed: 2, merged: 1, toReview: 1, waitPerson: 2, running: 1, notStarted: 1 });
    expect(summary.reviewedNotMerged.map((workItem) => workItem.id)).toEqual(['g']);
    expect(progressLine(summary)).toBe('1 report to review · 2 wait for a person · 1 running · 1 not started · 1 merged');
    expect(startsByItselfLines(plan)).toEqual(['Item 5 starts by itself when 1 is merged.']);
  });

  it('says who the plan waits for, and for how long', () => {
    const now = 1_000_000;
    const plan = buildPlan({
      waitingFor: [
        { user: IAN, questions: 1, permissions: 0, reports: 0, since: now - 6 * 60_000 },
        { user: MEI, questions: 0, permissions: 2, reports: 1, since: now - 40_000 },
      ],
    });
    expect(waitingForLine(plan, now)).toBe('Ian 1 question (6 minutes) · Mei 2 permission requests and 1 report (40 seconds)');
    expect(waitingForLine(buildPlan(), now)).toBe('');
  });
});

describe('the spec', () => {
  it('cuts the text at its ## headings, not inside a code fence, and gives the text back', () => {
    const text = ['# Checkout', '', 'Lead.', '', '## Goal', 'One page.', '', '```md', '## not a heading', '```', '', '## Open questions ##', '- Tax?'].join('\n');
    const sections = specSections(text);
    expect(sections.map((section) => section.heading)).toEqual([null, 'Goal', 'Open questions']);
    expect(sections[1]?.text).toContain('## not a heading');
    expect(sections.map((section) => section.text).join('\n')).toBe(text);
    expect(specSections('## Only\nText').map((section) => section.heading)).toEqual(['Only']);
    expect(specSections('')).toEqual([]);
  });

  it('counts the open questions the way the Start preflight does', () => {
    expect(specOpenQuestions('## Open questions\n- Tax?\n- Shipping?\n\n## Next\n- not this')).toBe(2);
    expect(specOpenQuestions('## Open questions\n\n- None\n')).toBe(0);
    expect(specOpenQuestions('## Open questions\nNothing.')).toBe(0);
    expect(specOpenQuestions('## Open questions\nWe still have to decide on tax.')).toBe(1);
    expect(specOpenQuestions('## Goal\n- a list')).toBe(0);
  });
});

describe('hand edits', () => {
  it('lists who edited the two files by hand, newest first; a change outside smurg is named as such', () => {
    const at = (hour: number, minute: number): number => new Date(2026, 9, 5, hour, minute).getTime();
    const line = handEditsLine({ spec: [{ by: { userId: 'dev:mei', displayName: 'Mei' }, at: at(14, 3) }, { by: { userId: 'dev:amy', displayName: 'Amy' }, at: at(14, 12) }], plan: [{ by: 'outside', at: at(13, 0) }] }, at(15, 0));
    expect(line).toBe('Amy (SPEC.md, 14:12), Mei (SPEC.md, 14:03), and a program outside smurg (PLAN.md, 13:00)');
    // An edit of an earlier day carries its date.
    expect(handEditsLine({ spec: [{ by: 'outside', at: at(14, 3) }], plan: [] }, at(15, 0) + 86_400_000)).not.toBe('a program outside smurg (SPEC.md, 14:03)');
  });
});
