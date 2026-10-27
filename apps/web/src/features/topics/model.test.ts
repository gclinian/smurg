// What the topic screens say about a plan and its items, as pure functions (DESIGN §5.12 item 20).
import { buildPlan, buildReportSummary, buildTopic, buildWorkItem } from '@smurg/protocol/testing';
import type { WorkItem } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { makeMember } from '../../testing/fixtures.ts';
import {
  agentAccessNames,
  assignablePeople,
  decidersOf,
  dependentsOf,
  assignHint,
  handEditsLine,
  itemActions,
  itemBadge,
  itemNames,
  itemNumbers,
  loads,
  planFile,
  planHeadline,
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
const AMY = { userId: 'dev:amy', displayName: 'Amy' };
const item = (id: string, number: number, overrides: Partial<WorkItem> = {}): WorkItem => buildWorkItem({ id, number, title: `Item ${id}`, ...overrides });
const noSession = (): undefined => undefined;

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
    // A follow-up, then the review: the reviewer took the version as it is, so the item is reviewed.
    [item('a', 1, { state: 'reviewed', report: buildReportSummary({ state: 'reviewed', review: { by: IAN, at: 20, version: 1 } }), changesAsked: { by: IAN, at: 10 }, merge: { requestId: 'mr', status: 'draft', ready: true } }), 'Reviewed · waits for the host to merge', 'success', false],
    // The review, then a follow-up: the message still asks for something.
    [item('a', 1, { state: 'reviewed', report: buildReportSummary({ state: 'reviewed', review: { by: IAN, at: 20, version: 1 } }), changesAsked: { by: IAN, at: 30 } }), 'Changes asked by Ian', 'info', false],
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

  it('an item whose dependencies are all reviewed waits only for the host’s merge, when the host merges them (0.7.0: R-SAFE S17)', () => {
    const waiting = buildPlan({
      items: [
        item('a', 1, { state: 'reviewed', merging: 'host', merge: { requestId: 'm1', status: 'draft', ready: true } }),
        item('b', 2, { state: 'reviewed', merging: 'host', merge: { requestId: 'm2', status: 'pending', ready: true } }),
        item('c', 3, { state: 'waiting', armed: true, dependsOn: ['a', 'b'] }),
      ],
    });
    expect(itemBadge(waiting.items[2] as WorkItem, waiting).text).toBe('Waits for the host to merge 1 and 2');
    // On purpose (0.7.0): a reviewed dependency that smurg merges is waiting, held or resolving, not the host's.
    const auto = buildPlan({ items: waiting.items.map((one) => (one.id === 'c' ? one : { ...one, merging: 'auto' as const })) });
    expect(itemBadge(auto.items[2] as WorkItem, auto).text).toBe('Waits for 1 and 2');
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

  it('a report that changed after its review asks for the review again: the item is not counted as reviewed, nor offered to merge', () => {
    const draft = { requestId: 'm', status: 'draft', ready: false } as const;
    const reviewed = item('a', 1, { state: 'reviewed', report: buildReportSummary({ state: 'reviewed' }), merge: { requestId: 'm0', status: 'merged', ready: false }, attempt: 1 });
    const changed = item('b', 2, { state: 'reviewed', report: buildReportSummary({ state: 'changed-after-review', version: 2 }), merge: draft, attempt: 1 });
    // A reviewed report whose file can no longer be read does not stand either (the daemon counts by the report's state).
    const unreadable = item('c', 3, { state: 'reviewed', report: buildReportSummary({ state: 'invalid' }), merge: draft, attempt: 1 });
    const plan = buildPlan({ items: [reviewed, changed, unreadable, item('d', 4, { state: 'waiting', armed: true, dependsOn: ['b'] })] });
    const summary = planSummary(plan, noSession);
    expect(summary).toMatchObject({ total: 4, reviewed: 1, merged: 1, toReview: 1, waitPerson: 1, notStarted: 1 });
    expect(summary.reviewedNotMerged).toEqual([]);
    expect(progressLine(summary)).toBe('1 report to review · 1 waits for a person · 1 not started · 1 merged');
    expect(itemBadge(unreadable, plan)).toMatchObject({ text: 'The report cannot be read', waitsForPerson: true });
    // What waits for it waits for more than the host's merge.
    expect(itemBadge(plan.items[3] as WorkItem, plan).text).toBe('Waits for 2');
  });

  it('says who the plan waits for, and for how long', () => {
    const now = 1_000_000;
    const plan = buildPlan({
      waitingFor: [
        { user: IAN, questions: 1, permissions: 0, reports: 0, decisions: 0, since: now - 6 * 60_000 },
        { user: MEI, questions: 0, permissions: 2, reports: 1, decisions: 0, since: now - 40_000 },
      ],
    });
    // The same age, in the same form, as the card, the status bar and the inbox row of that wait.
    expect(waitingForLine(plan, now)).toBe('Ian 1 question (6 min) · Mei 2 permission requests and 1 report (40 sec)');
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

describe('work items smurg merges by itself (protocol 6, DESIGN 0.7.0 D19)', () => {
  const T = 1_780_000_000_000;
  const wait = (reason: 'queued' | 'paused' | 'busy' | 'asked' | 'typing' | 'git-busy' | 'behind' | 'retry', extra: Record<string, unknown> = {}) => ({ state: 'waiting' as const, reason, since: T, tries: 0, hostOnly: false, escalated: false, ...extra });
  const hold = (reason: string, extra: Record<string, unknown> = {}) => ({ state: 'held' as const, reason, since: T, tries: 0, hostOnly: ['policy', 'local-changes', 'in-the-way', 'staged', 'branch', 'git-busy', 'history-changed', 'merge-failed', 'by-hand', 'undo-interrupted'].includes(reason), escalated: false, ...extra }) as WorkItem['autoMerge'];
  const done = (overrides: Partial<WorkItem> = {}): WorkItem => item('a', 1, { state: 'done', attempt: 1, merging: 'auto', report: buildReportSummary(), ...overrides });
  const planOf = (one: WorkItem) => buildPlan({ items: [one, item('b', 2, { state: 'waiting', armed: true, dependsOn: ['a'], waitsFor: ['a'] })] });
  const badge = (one: WorkItem, options = {}) => itemBadge(one, planOf(one), undefined, options);

  it('the itemBadge table: merged, waits, resolves, held, left out, undone', () => {
    expect(badge(done({ merged: { at: T, by: 'smurg' } })).text).toBe('Merged');
    expect(badge(done({ state: 'reviewed', merged: { at: T, by: 'smurg' }, report: buildReportSummary({ state: 'reviewed', review: { by: IAN, at: T, version: 1 } }) })).text).toBe('Merged · reviewed');
    expect(badge(done()).text).toBe('Merging…');
    expect(badge(done({ autoMerge: wait('queued') })).text).toBe('Merging…');
    expect(badge(done({ autoMerge: wait('behind') })).text).toBe('Merging…');
    expect(badge(done({ autoMerge: wait('busy') })).text).toBe('Running');
    expect(badge(done({ autoMerge: wait('asked', { asked: MEI }) })).text).toBe('Changes asked by Mei');
    expect(badge(done({ autoMerge: wait('paused') })).text).toBe('Waits to merge: the plan is paused');
    expect(badge(done({ autoMerge: wait('git-busy') })).text).toBe('Waits to merge: git is busy in the main workspace');
    expect(badge(done({ autoMerge: wait('typing', { paths: ['src/a.ts'] }) })).text).toBe('Waits to merge: a file is being edited');
    expect(badge(done({ autoMerge: wait('typing', { paths: ['src/a.ts'] }) }), { editing: () => ['Amy'] }).text).toBe('Waits to merge: Amy is editing');
    expect(badge(done({ autoMerge: { state: 'resolving', reason: 'conflict', since: T, tries: 1, hostOnly: false, escalated: false } })).text).toBe('Bringing its work up to date');
    expect(badge(done({ autoMerge: { state: 'resolving', reason: 'stale-report', since: T, tries: 0, hostOnly: false, escalated: false } })).text).toBe('Checking its report again');
    expect(badge(done({ autoMerge: hold('partial') })).text).toBe('Not merged: not complete (partial)');
    expect(badge(done({ autoMerge: hold('check-failed') })).text).toBe('Not merged: a check failed');
    expect(badge(done({ autoMerge: hold('policy') })).text).toBe('Not merged: it changes files only the host may merge');
    expect(badge(done({ autoMerge: hold('asked', { asked: AMY }) })).text).toBe('Not merged: Amy wrote to the agent after its report');
    expect(badge(done({ autoMerge: hold('conflict', { people: [{ path: 'src/a.ts', by: [AMY], outside: false }] }) })).text).toBe("Not merged: it conflicts with Amy's change of src/a.ts");
    expect(badge(done({ autoMerge: hold('conflict', { people: [{ path: 'src/a.ts', by: [], outside: true }] }) })).text).toBe('Not merged: it conflicts with a change of src/a.ts made outside smurg');
    expect(badge(done({ autoMerge: hold('by-hand') })).text).toBe('Not merged: files of it were edited by hand');
    expect(badge(done({ autoMerge: hold('partial') })).waitsForPerson).toBe(true);
    // (0.7.0 verify: an item whose version is merged said "Not merged" beside "1 of 2 merged" and its Undo; what waits is
    // a later change of it)
    const merged = { merged: { at: T, by: 'smurg' as const }, merge: { requestId: 'mr_1', status: 'merged' as const, ready: false } };
    expect(badge(done({ ...merged, autoMerge: hold('edited') })).text).toBe('Merged; a later change is not merged: its worktree holds changes that were never merged');
    expect(badge(done({ ...merged, autoMerge: hold('stopped') })).text).toBe('Merged; a later change is not merged: its last turn did not finish');
    expect(badge(done({ ...merged, autoMerge: wait('paused') })).text).toBe('Merged; a later change waits: the plan is paused');
    expect(badge(done({ leftOut: { by: MEI, at: T } })).text).toBe('Left out');
    expect(badge(item('a', 1, { undone: { by: IAN, at: T } })).text).toBe('Undone');
    expect(badge(done({ waiting: 'question' })).text).toBe('Waiting for an answer');
    expect(badge(done({ waiting: 'permission' })).text).toBe('Waiting for permission');
    // A held item that ran directly in the folder (D10): no `merging`, the same words.
    expect(badge(item('a', 1, { state: 'done', attempt: 1, report: buildReportSummary({ outcome: 'blocked' }), autoMerge: hold('blocked') })).text).toBe('Not merged: not complete (blocked)');
  });

  it('what waits for a held item waits for a decision; for one that merges or resolves, plainly', () => {
    const held = planOf(done({ autoMerge: hold('partial') }));
    expect(itemBadge(held.items[1] as WorkItem, held).text).toBe('Waits for a decision on 1');
    const merging = planOf(done({ autoMerge: wait('queued') }));
    expect(itemBadge(merging.items[1] as WorkItem, merging).text).toBe('Waits for 1');
  });

  it('the plan counts merges and decisions, and the host is led only to what it merges itself', () => {
    const plan = buildPlan({
      items: [
        done({ id: 'a', merged: { at: T, by: 'smurg' }, merge: { requestId: 'm1', status: 'merged', ready: false } }),
        done({ id: 'b', number: 2, state: 'reviewed', autoMerge: hold('partial'), report: buildReportSummary({ state: 'reviewed', review: { by: IAN, at: T, version: 1 } }), merge: { requestId: 'm2', status: 'draft', ready: true } }),
        item('c', 3, { state: 'stopped', attempt: 1, merging: 'auto', leftOut: { by: MEI, at: T } }),
        item('d', 4, { state: 'waiting', armed: true, dependsOn: ['b'], waitsFor: ['b'] }),
      ],
    });
    const summary = planSummary(plan, noSession);
    expect(summary).toMatchObject({ auto: true, merged: 1, decisions: 1, leftOut: 1, toReview: 0, notStarted: 1 });
    expect(summary.reviewedNotMerged).toEqual([]);
    expect(planHeadline(summary)).toBe('1 of 4 merged');
    expect(progressLine(summary)).toBe('1 waits for a decision · 1 not started');
    expect(planHeadline(planSummary(buildPlan({ items: [item('a', 1, { state: 'reviewed', merging: 'host', report: buildReportSummary({ state: 'reviewed' }) })] }), noSession))).toBe('1 of 1 reviewed');
    expect(waitingForLine({ waitingFor: [{ user: MEI, questions: 0, permissions: 0, reports: 0, decisions: 2, since: T }] }, T)).toMatch(/^Mei 2 decisions \(/);
  });

  it('who decides a held item: the host for its holds, the responsible person with agent access, else agent access', () => {
    const members = [makeMember({ ...IAN, role: 'host' }), makeMember({ ...MEI, role: 'agent' }), makeMember({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' })];
    expect(decidersOf({ autoMerge: hold('partial'), responsible: { ...MEI, source: 'chosen' } }, members)).toBe('Mei');
    expect(decidersOf({ autoMerge: hold('policy'), responsible: { ...MEI, source: 'chosen' } }, members)).toBe('Ian');
    expect(decidersOf({ autoMerge: { ...(hold('partial') as NonNullable<WorkItem['autoMerge']>), escalated: true }, responsible: { ...MEI, source: 'chosen' } }, members)).toBe('Ian and Mei');
    expect(decidersOf({ autoMerge: hold('partial'), responsible: { userId: 'dev:amy', displayName: 'Amy', source: 'chosen' } }, members)).toBe('Ian and Mei');
  });

  it('a row offers "Leave it out…" until it is merged, and "Undo…" once it is, where smurg keeps history', () => {
    const one = done({ autoMerge: hold('partial') });
    expect(itemActions(one, planOf(one))).toMatchObject({ leaveOut: true, undo: false });
    const merged = done({ merged: { at: T, by: 'smurg' } });
    expect(itemActions(merged, planOf(merged))).toMatchObject({ leaveOut: false, undo: true });
    const direct = item('a', 1, { state: 'done', attempt: 1, merged: { at: T, by: IAN } });
    expect(itemActions(direct, planOf(direct)).undo).toBe(false);
    expect(itemActions(item('a', 1), planOf(item('a', 1))).leaveOut).toBe(false);
  });

  it('dependentsOf follows the plan transitively', () => {
    const plan = buildPlan({ items: [item('a', 1), item('b', 2, { dependsOn: ['a'] }), item('c', 3, { dependsOn: ['b'] }), item('d', 4)] });
    expect(dependentsOf(plan, 'a').map((one) => one.id)).toEqual(['b', 'c']);
    expect(dependentsOf(plan, 'd')).toEqual([]);
  });
});
