// What the verification of the 0.7.0 review's fixes found (W/verify: safe, run, diff, left), in the RELEASE
// composition with the stand-in `claude` (release-flow.support.ts): each case where a verifier showed smurg merging a
// version a person had objected to, waiting for ever with nobody told, or telling people something false, now with what
// it does instead:
//
//   V1  a person's message to a done item's parked agent, and smurg host stops before its turn opens: the version is
//       held for its carers (it merged after the start), and their Continue delivers the message first
//   V2  a person's turn to a done item that ENDS while the stop waits for work under way: held, not merged
//   V3  a person saves a file in a merged item's checkout: a decision for its carers ("Merged; a later change is not
//       merged"), the topic is not "ready"; Continue makes the change a version, which merges
//   V4  a later turn of a merged item changes a file with a command only: that change becomes a version and merges (it
//       stayed in the checkout, the topic "executing" for good, nobody told)
//   V5  a command changes a file after check_report in the same turn: the agent is asked once to verify again first
//   V6  a new version of an item merged before, held because its report was not checked again: "Merge it as it is"
//       settles it (it was refused for every item merged before)
//   V7  an Editor's follow-up suggestion on a merged item is a decision: amber for whom it waits for, counted in the
//       plan's waitingFor, escalated after the waiting time, and the topic is ready only once it is decided
//   V8  smurg host stops while an armed item is being started: the item starts after the restart (it was disarmed with
//       "smurg is stopping on the host")
//   V9  in smurg's own history, a restart that cuts a merged item's talk-only turn leaves the topic ready (its checkout
//       was taken for one holding unmerged work until a merge view looked, and the item held)
//   V10 a restart cuts a turn after its check_report and changed nothing after it: the agent is told the restart is why
//       it checks again, not that it changed files
//   V11 (the last check, F1) a message a restart left in a done item's session without a process: "Merge it as it is"
//       is refused with the reason (it made the item wait "busy" for ever, its message never delivered, nobody told),
//       the plan says so, and Continue delivers the message first
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, type PlanInfo, type WorkItem } from '@smurg/protocol';
import type { FakeClaudeStep } from '../../src/testing/index.ts';
import { MEI, audited, inboxItem, refusal, startFlow, told, waitFor, type Flow } from './release-flow.support.ts';

const SLUG = 'checkout';
const SPEC_PATH = `specs/${SLUG}/SPEC.md`;
const PLAN_PATH = `specs/${SLUG}/PLAN.md`;
const reportPath = (id: string): string => `specs/${SLUG}/reports/${id}.md`;
const SPEC = ['# Checkout', '', '## Goal', 'Buying a book takes one page.', '', '## Decisions', '- Cards only.', '', '## Scope', 'Cart, receipt, page.', '', '## Out of scope', 'Invoices.', '', '## Behaviour', 'One page.', '', '## Open questions', 'None.', ''].join('\n');
const PLAN = ['# Plan: Checkout', '', '<!-- smurg:plan v1 -->', '', '### 1. Cart API', '- id: cart-api', '- size: m', '- touches: src/cart/**', '', 'The Cart API.', '', '<!-- smurg:plan end -->', ''].join('\n');
function report(done = 'The work of Cart API.'): string {
  return ['# Result report: Cart API', '', '<!-- smurg:report v1 item=cart-api -->', '- outcome: complete', '', '## What was done', done, '', '## Why it was done this way', 'As the spec decided.', '', '## How it was verified', '- [x] `pnpm test`: 3 tests passed', '', '## What to watch out for', 'Nothing special.', ''].join('\n');
}
const PNPM_TEST: FakeClaudeStep = { tool: 'Bash', input: { command: 'pnpm test' }, result: '3 tests passed' };
const CHECK: FakeClaudeStep = { tool: 'mcp__smurg__check_report', input: {} };
const write = (path: string, content: string): FakeClaudeStep => ({ tool: 'Write', input: { file_path: path, content } });
const handIn = (done?: string): FakeClaudeStep[] => [PNPM_TEST, write(reportPath('cart-api'), report(done)), CHECK, { text: 'Cart API is done.' }];
const FIRST = { match: 'Start work item 1 ', steps: [write('src/cart/total.ts', 'export const total = 1;\n'), ...handIn()] };
/** The turn `verify-again` starts: the agent runs its checks again and checks the same report (it changes nothing). */
const VERIFIED = { match: 'after your report was last checked', steps: [PNPM_TEST, CHECK, { text: 'Verified again.' }] };
const UNATTENDED = { settings: { permissionMode: 'auto' as const, merging: 'auto' as const } };
const FILES = { 'README.md': '# Bookshop\n', 'src/app.ts': 'export const title = "Bookshop";\n' };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const planOf = async (flow: Flow, topicId: string): Promise<PlanInfo> => (await flow.leo.conn.request('plan.get', { topicId })).plan as PlanInfo;
const itemOf = async (flow: Flow, topicId: string): Promise<WorkItem> => (await planOf(flow, topicId)).items.find((candidate) => candidate.id === 'cart-api') as WorkItem;
async function itemIs(flow: Flow, topicId: string, fits: (item: WorkItem) => boolean, what: string, timeoutMs = 60_000): Promise<WorkItem> {
  await waitFor(async () => fits(await itemOf(flow, topicId)), { timeoutMs, what });
  return itemOf(flow, topicId);
}
const inMain = async (flow: Flow, path: string): Promise<string> => Buffer.from((await flow.ian.conn.request('file.read', { file: { root: MAIN_ROOT, path } })).content).toString('utf8');
const merges = async (flow: Flow): Promise<number> => (await audited(flow, 'worktree.merge.auto')).filter((entry) => entry.outcome === 'ok').length;
const phaseOf = (flow: Flow, topicId: string): string | undefined => flow.d.ctx.services.topics.get(topicId)?.phase;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Mei creates the topic, Ian writes its spec and its one-item plan, Mei is responsible for the item and presses Start. */
async function started(flow: Flow): Promise<string> {
  const created = await flow.mei.conn.request('topic.create', { name: 'Checkout' });
  const topicId = created.topic.id;
  await flow.ian.conn.request('file.write', { file: { root: MAIN_ROOT, path: SPEC_PATH }, content: bytes(SPEC) });
  await flow.ian.conn.request('file.write', { file: { root: MAIN_ROOT, path: PLAN_PATH }, content: bytes(PLAN) });
  await waitFor(async () => (await planOf(flow, topicId))?.items.length === 1, { what: 'the plan to parse' });
  await flow.mei.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: MEI });
  const { preflight } = await flow.mei.conn.request('plan.preflight', { topicId });
  await flow.mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash });
  return topicId;
}

/** Started, merged by smurg, and the topic ready to check. */
async function mergedAndReady(flow: Flow): Promise<{ topicId: string; item: WorkItem }> {
  const topicId = await started(flow);
  const item = await itemIs(flow, topicId, (candidate) => candidate.merged?.by === 'smurg', 'smurg to merge item 1');
  await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check' });
  return { topicId, item };
}

describe('0.7.0 verify: a stop never lets a version merge as if nobody had asked (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('V1 a message to a parked done item, and the stop comes before its turn opens: the version is held; Continue delivers the message, and what it asked for merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED, agents: { parkAfterMs: 1_000 } });
    await flow.claude.setScenario({
      turns: [FIRST, { match: 'must be in cents', steps: [write('src/cart/total.ts', 'export const total = 100; // cents\n'), ...handIn('Totals in cents.')] }, { steps: [{ text: 'ok' }] }],
    });
    const topicId = await started(flow);
    await flow.mei.conn.request('plan.pause', { topicId });
    const done = await itemIs(flow, topicId, (item) => item.state === 'done', 'item 1\'s report');
    const sessionId = done.sessionId as string;
    await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the done item\'s process to be parked' });
    // The message starts a process for it; the stop comes at once, before a turn takes the message.
    await flow.mei.conn.request('session.message.send', { sessionId, text: 'Wait, do not merge this: the totals must be in cents.' });
    await flow.mei.conn.request('plan.resume', { topicId });
    await flow.restart();
    const held = await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held', 'the version to be held for its carers', 30_000);
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped', hostOnly: false });
    await inboxItem(flow.mei, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api', 'Mei\'s decision');
    await sleep(1_500);
    expect(await merges(flow)).toBe(0);
    expect(await inMain(flow, 'src/cart/total.ts').catch(() => 'absent')).toBe('absent');

    await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
    await itemIs(flow, topicId, (item) => item.merged?.by === 'smurg', 'the merge of what Mei asked for');
    expect(await inMain(flow, 'src/cart/total.ts')).toBe('export const total = 100; // cents\n');
    expect(await merges(flow)).toBe(1);
  });

  // The last check of ce17d71 (W/verify/last F1, h/t/x1-release-stranded.test.ts): "Merge it as it is" on V1's hold took
  // away what made the message count as stranded, and from then on the item waited "busy" for good: nothing merged,
  // nothing delivered Mei's message, no inbox had a row, and the topic never became ready.
  it('V11 a message a restart left in a done item\'s session without a process: "Merge it as it is" is refused with the reason, the plan says so, and Continue delivers the message first', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED, agents: { parkAfterMs: 1_000 } });
    await flow.claude.setScenario({
      turns: [FIRST, { match: 'must be in cents', steps: [write('src/cart/total.ts', 'export const total = 100; // cents\n'), ...handIn('Totals in cents.')] }, { steps: [{ text: 'ok' }] }],
    });
    const topicId = await started(flow);
    await flow.mei.conn.request('plan.pause', { topicId });
    const done = await itemIs(flow, topicId, (item) => item.state === 'done', 'item 1\'s report');
    const sessionId = done.sessionId as string;
    await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the done item\'s process to be parked' });
    await flow.mei.conn.request('session.message.send', { sessionId, text: 'Wait, do not merge this: the totals must be in cents.' });
    await flow.mei.conn.request('plan.resume', { topicId });
    await flow.restart();
    const held = await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held', 'the version to be held for its carers', 30_000);
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped', undelivered: true });
    expect(flow.d.ctx.services.agents.facts(sessionId)).toMatchObject({ hasProcess: false, pendingMessages: 1 });

    expect(await refusal(flow.mei.conn.request('plan.item.release', { topicId, itemId: 'cart-api', version: 1 }))).toMatchObject({ code: 'conflict', reason: 'undelivered', id: 'plan.item.release.undelivered' });
    expect((await audited(flow, 'plan.item.release')).filter((entry) => entry.outcome === 'ok')).toEqual([]);
    await sleep(1_500);
    // Still a decision of Mei's, not a wait nobody sees.
    expect((await itemOf(flow, topicId)).autoMerge).toMatchObject({ state: 'held', reason: 'stopped', undelivered: true });
    await inboxItem(flow.mei, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api' && entry.waiting, 'Mei\'s decision');
    expect(await merges(flow)).toBe(0);

    await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
    await itemIs(flow, topicId, (item) => item.merged?.by === 'smurg', 'the merge of what Mei asked for');
    expect(await inMain(flow, 'src/cart/total.ts')).toBe('export const total = 100; // cents\n');
    await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check' });
    expect((await itemOf(flow, topicId)).autoMerge).toBeUndefined();
  });

  it('V2 a person\'s turn to a done item that ends while the stop waits for work under way: the version is held, nothing merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [FIRST, { match: 'must be in cents', once: true, steps: [write('src/cart/total.ts', 'export const total = 100; // cents\n'), { sleep: 1_500 }, { text: 'Changed the totals to cents.' }] }, { steps: [{ text: 'ok' }] }],
    });
    const topicId = await started(flow);
    await flow.mei.conn.request('plan.pause', { topicId });
    const done = await itemIs(flow, topicId, (item) => item.state === 'done', 'item 1\'s report');
    const sessionId = done.sessionId as string;
    await flow.mei.watch(sessionId);
    const finished = (): number => flow.mei.events(sessionId).filter((event) => event.kind === 'tool.finished').length;
    const before = finished();
    await flow.mei.conn.request('session.message.send', { sessionId, text: 'Wait, do not merge this: the totals must be in cents.' });
    await waitFor(() => finished() > before, { timeoutMs: 30_000, what: 'the turn of Mei\'s message to write' });
    await flow.mei.conn.request('plan.resume', { topicId });
    // Work under way in the topics core when the stop comes (a snapshot of a large checkout holds `core.idle()`): the
    // turn ends meanwhile, while smurg is already stopping.
    const core = (flow.d.ctx.services.reports as unknown as { core: { serialize: (key: string, job: () => Promise<void>) => Promise<void> } }).core;
    void core.serialize('verify:under-way', () => sleep(4_000));
    const ends: boolean[] = [];
    const old = flow.d;
    const listen = old.ctx.bus.on('agent.turn.finished', (event) => {
      if (event.sessionId === sessionId) ends.push(old.ctx.stopping.aborted);
    });
    await flow.restart();
    listen.dispose();
    expect(ends).toContain(true);
    const held = await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held', 'the version to be held for its carers', 30_000);
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped' });
    expect(held.merged).toBeUndefined();
    await sleep(1_500);
    expect(await merges(flow)).toBe(0);
  });
});

describe('0.7.0 verify: what a merged item\'s checkout holds is never left without anyone told (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('V3 a person saves a file in a merged item\'s checkout: a decision for its carers, the topic not ready; Continue makes it a version, which merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({ turns: [FIRST, { match: 'Continue the work item', steps: [PNPM_TEST, CHECK, { text: 'Checked: the notes are fine.' }] }, VERIFIED, { steps: [{ text: 'ok' }] }] });
    const { topicId, item } = await mergedAndReady(flow);
    const worktree = { kind: 'worktree' as const, worktreeId: item.worktreeId as string };
    await flow.mei.conn.request('file.write', { file: { root: worktree, path: 'src/cart/NOTES.md' }, content: bytes('Mei: rounding is to the cent.\n') });
    const held = await itemIs(flow, topicId, (candidate) => candidate.autoMerge?.state === 'held', 'the merged item to be held for the saved file', 30_000);
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'edited', hostOnly: false });
    expect(phaseOf(flow, topicId)).toBe('executing');
    await inboxItem(flow.mei, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api' && entry.waiting, 'Mei\'s decision');
    expect((await planOf(flow, topicId)).waitingFor.find((entry) => entry.user.userId === MEI)).toMatchObject({ decisions: 1 });

    await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
    await waitFor(async () => (await inMain(flow, 'src/cart/NOTES.md').catch(() => '')) === 'Mei: rounding is to the cent.\n', { timeoutMs: 60_000, what: 'Mei\'s file to merge' });
    await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check again' });
  });

  it('V4 a later turn of a merged item changes a file with a command only: the change becomes a version and merges, and the topic is ready again', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        FIRST,
        { match: 'Rename the total', once: true, steps: [{ tool: 'Bash', input: { command: "printf 'export const sum = 1;\\n' > src/cart/total.ts" }, run: true }, { text: 'Renamed.' }] },
        VERIFIED,
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId, item } = await mergedAndReady(flow);
    await flow.mei.conn.request('session.message.send', { sessionId: item.sessionId as string, text: 'Rename the total to sum.' });
    await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === 'export const sum = 1;\n', { timeoutMs: 60_000, what: 'the command\'s change to merge' });
    await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check again' });
    expect((await itemOf(flow, topicId)).report?.version).toBe(2);
  });

  it('V5 a command changes a file after check_report in the same turn: the agent is asked once to verify again, and only then it merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        {
          match: 'Start work item 1 ',
          steps: [
            write('src/cart/total.ts', 'export const total = 1;\n'),
            PNPM_TEST,
            write(reportPath('cart-api'), report()),
            CHECK,
            { tool: 'Bash', input: { command: "printf 'export const total = 2; // after the checks\\n' > src/cart/total.ts" }, run: true },
            { text: 'Cart API is done.' },
          ],
        },
        VERIFIED,
        { steps: [{ text: 'ok' }] },
      ],
    });
    const topicId = await started(flow);
    const merged = await itemIs(flow, topicId, (item) => item.merged?.by === 'smurg', 'the merge after the agent verified again');
    expect((await told(flow, merged.sessionId as string)).filter((text) => text.includes('after your report was last checked'))).toHaveLength(1);
    expect(await inMain(flow, 'src/cart/total.ts')).toBe('export const total = 2; // after the checks\n');
  });

  it('V6 a new version of an item merged before, held because its report was not checked again: "Merge it as it is" settles it', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        FIRST,
        // A follow-up: the agent changes a file and does not check its report again; asked to verify, it only talks.
        { match: 'Add a discount', once: true, steps: [write('src/cart/discount.ts', 'export const discount = 1;\n'), { text: 'Added.' }] },
        { match: 'after your report was last checked', steps: [{ text: 'It is fine.' }] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await mergedAndReady(flow);
    await flow.mei.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: 'Add a discount.' });
    const held = await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held' && item.autoMerge.reason === 'stale-report', 'version 2 to be held');
    expect(held.report?.version).toBe(2);
    expect(held.merge?.status).toBe('draft');
    await flow.mei.conn.request('plan.item.release', { topicId, itemId: 'cart-api', version: 2 });
    await waitFor(async () => (await inMain(flow, 'src/cart/discount.ts').catch(() => '')) === 'export const discount = 1;\n', { timeoutMs: 60_000, what: 'version 2 to merge' });
    await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check again' });
  });

  it('V7 an Editor\'s follow-up suggestion on a merged item is a decision: it waits for Mei, escalates, and the topic is ready once she decides it', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({ turns: [FIRST, { steps: [{ text: 'ok' }] }] });
    const { topicId } = await mergedAndReady(flow);
    const sent = await flow.amy.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: 'Should the total round to the cent?' });
    expect('suggestion' in sent).toBe(true);
    const row = await inboxItem(flow.mei, (entry) => entry.kind === 'suggestion' && entry.itemId === 'cart-api', 'Mei\'s suggestion row');
    expect(row.waiting).toBe(true);
    await waitFor(() => phaseOf(flow, topicId) === 'executing', { timeoutMs: 10_000, what: 'the topic to have work again' });
    expect((await planOf(flow, topicId)).waitingFor.find((entry) => entry.user.userId === MEI)).toMatchObject({ decisions: 1 });
    expect((await flow.ian.inbox()).some((entry) => entry.kind === 'suggestion')).toBe(false);
    // The waiting time of a decision goes by: the host (and every member with agent access) has it too.
    flow.advance(flow.d.ctx.settings.get().escalateAfterMs + 1_000);
    const escalated = await inboxItem(flow.ian, (entry) => entry.kind === 'suggestion' && entry.itemId === 'cart-api', 'Ian\'s copy of the suggestion');
    expect(escalated).toMatchObject({ waiting: true, escalated: true, waitsFor: { userId: MEI } });
    expect(phaseOf(flow, topicId)).toBe('executing');

    const suggestionId = (sent as { suggestion: { id: string } }).suggestion.id;
    await flow.mei.conn.request('suggest.reject', { suggestionId });
    await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check once it was decided' });
    expect((await planOf(flow, topicId)).waitingFor).toEqual([]);
  });
});

describe('0.7.0 verify: a restart tells nobody anything false (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('V8 smurg host stops while an armed item is being started: it starts after the restart, and nobody is told it could not', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({ turns: [FIRST, { steps: [{ text: 'ok' }] }] });
    const created = await flow.mei.conn.request('topic.create', { name: 'Checkout' });
    const topicId = created.topic.id;
    await flow.ian.conn.request('file.write', { file: { root: MAIN_ROOT, path: SPEC_PATH }, content: bytes(SPEC) });
    await flow.ian.conn.request('file.write', { file: { root: MAIN_ROOT, path: PLAN_PATH }, content: bytes(PLAN) });
    await waitFor(async () => (await planOf(flow, topicId))?.items.length === 1, { what: 'the plan to parse' });
    await flow.mei.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: MEI });
    const { preflight } = await flow.mei.conn.request('plan.preflight', { topicId });
    // The stop comes while the item is being started: its checkout is being made (its clone holds acquireForItem).
    const old = flow.d;
    let stopping: Promise<void> | null = null;
    const listen = old.ctx.bus.on('plan.changed', (event) => {
      if (stopping === null && event.plan.items.some((item) => item.id === 'cart-api' && item.state === 'queued')) stopping = sleep(30).then(() => flow.restart());
    });
    // (Start answers when its first pass is over: the stop may cut the answer)
    void flow.mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash }).catch(() => {});
    await waitFor(() => stopping !== null, { timeoutMs: 30_000, what: 'the item to be queued' });
    await stopping;
    listen.dispose();
    await itemIs(flow, topicId, (item) => item.merged?.by === 'smurg', 'the item to start, finish and merge after the restart');
    for (const member of [flow.ian, flow.mei]) expect((await member.inbox()).some((entry) => entry.kind === 'attention' && entry.subject === 'item-not-started')).toBe(false);
    expect((await audited(flow, 'scheduler.disarm')).length).toBe(0);
  });

  it('V9 smurg\'s own history: a restart that cuts a merged item\'s talk-only turn leaves its topic ready to check, with nothing held', async () => {
    const flow = await startFlow({ files: FILES, git: false, ...UNATTENDED });
    await flow.claude.setScenario({ turns: [FIRST, { match: 'why integers', steps: [{ text: 'Because ' }, { sleep: 60_000 }, { text: 'never' }] }, { steps: [{ text: 'Integers, as the spec says.' }] }] });
    const { topicId, item } = await mergedAndReady(flow);
    const sessionId = item.sessionId as string;
    await flow.mei.watch(sessionId);
    const before = flow.mei.events(sessionId).filter((event) => event.kind === 'turn.started').length;
    await flow.mei.conn.request('session.message.send', { sessionId, text: 'Just a question: why integers?' });
    await waitFor(() => flow.mei.events(sessionId).filter((event) => event.kind === 'turn.started').length > before, { timeoutMs: 30_000, what: 'the question\'s turn' });
    await flow.restart();
    await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check after the restart' });
    await sleep(3_000);
    const after = await itemOf(flow, topicId);
    expect(after.autoMerge).toBeUndefined();
    expect(phaseOf(flow, topicId)).toBe('ready');
    expect((await flow.mei.inbox()).some((entry) => entry.kind === 'decision')).toBe(false);
  });

  it('V10 a restart cuts a turn after its check_report that changed nothing after it: the agent is told the restart is why it checks again', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', once: true, steps: [write('src/cart/total.ts', 'export const total = 1;\n'), PNPM_TEST, write(reportPath('cart-api'), report()), CHECK, { sleep: 60_000 }, { text: 'never' }] },
        VERIFIED,
        { steps: [{ text: 'ok' }] },
      ],
    });
    const topicId = await started(flow);
    const running = await itemIs(flow, topicId, (item) => item.state === 'running' && item.sessionId !== undefined, 'item 1 to run');
    const sessionId = running.sessionId as string;
    const worktree = { kind: 'worktree' as const, worktreeId: running.worktreeId as string };
    await waitFor(async () => (await flow.ian.conn.request('file.read', { file: { root: worktree, path: reportPath('cart-api') } }).catch(() => null)) !== null, { timeoutMs: 30_000, what: 'the report to be written' });
    // (its check_report follows at once; then the agent works on, and the stop cuts the turn)
    await sleep(1_500);
    await flow.restart();
    await itemIs(flow, topicId, (item) => item.merged?.by === 'smurg', 'the merge after the agent checked again');
    const words = await told(flow, sessionId);
    expect(words.filter((text) => text.includes('You changed files'))).toEqual([]);
    expect(words.filter((text) => text.includes('smurg was restarted while you worked'))).toHaveLength(1);
  });
});
