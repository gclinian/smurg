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
//   V9  in smurg's own history, a restart that cuts a merged item's talk-only turn: its checkout is not taken for one
//       holding unmerged work (it was, until a merge view looked, and the item held). Since 0.7.0 fix6 the cut turn
//       itself holds the item for its carers (the question was never answered); Continue's answer changes nothing, and
//       the topic is ready with nothing held
//   V10 a restart cuts a turn after its check_report and changed nothing after it: the agent is told the restart is why
//       it checks again, not that it changed files
//   V11 (the last check, F1) a message a restart left in a done item's session without a process: "Merge it as it is"
//       is refused with the reason (it made the item wait "busy" for ever, its message never delivered, nobody told),
//       the plan says so, and Continue delivers the message first
//   V12 (the check of 76114a1, H1) a report follow-up a restart left undelivered, and the host's own Merge… of the
//       version it objects to (with and without "I've reviewed this" first): the merge stands, the item is held for its
//       carers with the message still in its session, and their Continue delivers it and merges what it asked for (the
//       topic said "executing" for good with nobody told, or the session ended and Continue was refused)
//   V13 (the check of 76114a1, H2) a message to a merged item's parked agent, then a restart, in the folder's git and in
//       smurg's own history: held for its carers, the topic is not ready to check; Continue delivers it and its version
//       merges (the topic said ready, and "I've checked the result" ended the session with the message in it)
//   V14 (the check of d374e39, M1) a merged item's session during the turn that answers a person's message: "I've
//       reviewed this", the host's Merge… (smurg merging, or the host merging each item) and Continue after a restart
//       and a review do not end it; the turn finishes and its version merges (the session was ended 'merged' in the
//       middle of the turn, the answer never became a version, and the topic turned complete with nobody told)
//   V15 (the check of d374e39, S1) a message a restart left undelivered when the host merges each item (sent after the
//       host's merge, or a report follow-up before it) and when the host turns automatic merging off while the item is
//       held: held for its carers, the topic not ready, the check refused; Continue delivers it and the host merges its
//       version (the topic said ready, or "executing" for good, with nobody told)
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, type PlanInfo, type WorkItem } from '@smurg/protocol';
import type { FakeClaudeStep } from '../../src/testing/index.ts';
import { IAN, MEI, audited, inboxItem, refusal, startFlow, told, waitFor, type Flow } from './release-flow.support.ts';

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

// The check of 76114a1 (W/verify/last3/hold, findings 1 and 2; fix4): a message a restart left undelivered was lost, or
// waited for good with nobody told, once the version it objected to was merged.
const CENTS = { match: 'must be in cents', steps: [write('src/cart/total.ts', 'export const total = 100; // cents\n'), ...handIn('Totals in cents.')] };
const OBJECTION = 'Wait, do not merge this: the totals must be in cents.';

describe('0.7.0 fix4: a message a restart left undelivered is never lost behind a merge (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  for (const reviewed of [false, true]) {
    it(`V12 the host merges the version a report follow-up a restart left undelivered objects to${reviewed ? ', after "I\'ve reviewed this"' : ''}: held for its carers, and Continue delivers the follow-up, whose version merges`, async () => {
      const flow = await startFlow({ files: FILES, ...UNATTENDED, agents: { parkAfterMs: 1_000 } });
      await flow.claude.setScenario({ turns: [FIRST, CENTS, { steps: [{ text: 'ok' }] }] });
      const topicId = await started(flow);
      await flow.mei.conn.request('plan.pause', { topicId });
      const done = await itemIs(flow, topicId, (item) => item.state === 'done', 'item 1\'s report');
      const sessionId = done.sessionId as string;
      await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the done item\'s process to be parked' });
      await flow.mei.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: OBJECTION });
      await flow.mei.conn.request('plan.resume', { topicId });
      await flow.restart();
      const held = await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held', 'the version to be held for its carers', 30_000);
      expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'asked', undelivered: true });
      if (reviewed) await flow.mei.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 });

      // The host's Merge… after the full diff stays the host's decision: version 1 merges.
      await flow.ian.conn.request('worktree.merge.approve', { requestId: (await itemOf(flow, topicId)).merge?.requestId as string });
      const after = await itemIs(flow, topicId, (item) => item.merged !== undefined && item.autoMerge?.state === 'held', 'the merged item to be held for the follow-up', 30_000);
      expect(after.merged?.by).toMatchObject({ userId: IAN });
      expect(after.autoMerge).toMatchObject({ state: 'held', reason: 'stopped', undelivered: true });
      await inboxItem(flow.mei, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api' && entry.waiting, 'Mei\'s decision');
      await sleep(1_500);
      // Its session stays, with the follow-up in it; the topic is not ready to check.
      expect(flow.d.ctx.services.agents.get(sessionId)?.status).not.toBe('ended');
      expect(flow.d.ctx.services.agents.facts(sessionId)).toMatchObject({ hasProcess: false, pendingMessages: 1 });
      expect(phaseOf(flow, topicId)).toBe('executing');
      expect(await refusal(flow.mei.conn.request('topic.check', { topicId }))).toMatchObject({ code: 'conflict', reason: 'not-ready' });
      await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === 'export const total = 1;\n', { timeoutMs: 30_000, what: 'version 1 in the main workspace' });

      await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
      await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === 'export const total = 100; // cents\n', { timeoutMs: 60_000, what: 'the merge of what Mei asked for' });
      await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check' });
      expect(await merges(flow)).toBe(1);
      expect((await itemOf(flow, topicId)).autoMerge).toBeUndefined();
    });
  }

  for (const git of [true, false]) {
    it(`V13 ${git ? 'the folder\'s git' : 'smurg\'s own history'}: a message to a merged item's parked agent, then a restart: held for its carers, the topic not ready; Continue delivers it, and its version merges`, async () => {
      const flow = await startFlow({ files: FILES, git, ...UNATTENDED, agents: { parkAfterMs: 1_000 } });
      await flow.claude.setScenario({ turns: [FIRST, CENTS, { steps: [{ text: 'ok' }] }] });
      const { topicId, item } = await mergedAndReady(flow);
      const sessionId = item.sessionId as string;
      await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the merged item\'s process to be parked' });
      await flow.mei.conn.request('session.message.send', { sessionId, text: OBJECTION });
      await flow.restart();
      const held = await itemIs(flow, topicId, (candidate) => candidate.autoMerge?.state === 'held', 'the merged item to be held for the message', 30_000);
      expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped', undelivered: true });
      expect(phaseOf(flow, topicId)).toBe('executing');
      await inboxItem(flow.mei, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api' && entry.waiting, 'Mei\'s decision');
      expect(await refusal(flow.mei.conn.request('topic.check', { topicId }))).toMatchObject({ code: 'conflict', reason: 'not-ready' });
      expect(flow.d.ctx.services.agents.facts(sessionId)).toMatchObject({ hasProcess: false, pendingMessages: 1 });

      await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
      await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === 'export const total = 100; // cents\n', { timeoutMs: 60_000, what: 'the merge of what Mei asked for' });
      await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check again' });
      expect(await merges(flow)).toBe(2);
      await flow.mei.conn.request('topic.check', { topicId });
    });
  }
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

  // (0.7.0 fix6, the check of bb6c323 C1: the turn the restart cut is the carers' to continue; before, nothing held the
  // item, the topic said ready, and the question was never answered)
  it('V9 smurg\'s own history: a restart that cuts a merged item\'s talk-only turn holds it for its carers; Continue\'s answer changes nothing, and its topic is ready to check with nothing held', async () => {
    const flow = await startFlow({ files: FILES, git: false, ...UNATTENDED });
    await flow.claude.setScenario({ turns: [FIRST, { match: 'why integers', steps: [{ text: 'Because ' }, { sleep: 60_000 }, { text: 'never' }] }, { steps: [{ text: 'Integers, as the spec says.' }] }] });
    const { topicId, item } = await mergedAndReady(flow);
    const sessionId = item.sessionId as string;
    await flow.mei.watch(sessionId);
    const before = flow.mei.events(sessionId).filter((event) => event.kind === 'turn.started').length;
    await flow.mei.conn.request('session.message.send', { sessionId, text: 'Just a question: why integers?' });
    await waitFor(() => flow.mei.events(sessionId).filter((event) => event.kind === 'turn.started').length > before, { timeoutMs: 30_000, what: 'the question\'s turn' });
    await flow.restart();
    const held = await itemIs(flow, topicId, (candidate) => candidate.autoMerge?.state === 'held', 'the merged item to be held for the cut turn', 30_000);
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped' });
    expect(phaseOf(flow, topicId)).toBe('executing');
    await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
    await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check after the answer' });
    await sleep(3_000);
    const after = await itemOf(flow, topicId);
    expect(after.autoMerge).toBeUndefined();
    expect(after.report?.version).toBe(1);
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

// The check of d374e39 (W/verify/last4/hold, findings 1 and 2; fix5): a merged item's session was ended in the middle of
// the turn that answered a person's message (V14), and a message a restart left undelivered was told to nobody when
// the host merges each item, or after the host turned automatic merging off (V15).
/** The turn of the objection: its agent thinks a while, then changes the totals and hands in a new version. */
const THINKING_CENTS = { match: 'must be in cents', steps: [{ thinking: true as const, ms: 3_000 }, write('src/cart/total.ts', 'export const total = 100; // cents\n'), ...handIn('Totals in cents.')] };
const CENTS_TEXT = 'export const total = 100; // cents\n';
const turnEnds = async (flow: Flow, sessionId: string): Promise<string[]> => {
  const page = await flow.ian.conn.request('session.watch', { sessionId });
  return page.events.filter((event) => event.kind === 'turn.finished').map((event) => (event as { outcome?: string }).outcome ?? '');
};

describe('0.7.0 fix5: a merged item\'s session is never ended in the middle of a turn (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('V14 a message to a merged item\'s parked agent, and "I\'ve reviewed this" while its turn runs: the turn finishes, and what it asked for merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED, agents: { parkAfterMs: 1_000 } });
    await flow.claude.setScenario({ turns: [FIRST, THINKING_CENTS, { steps: [{ text: 'ok' }] }] });
    const { topicId, item } = await mergedAndReady(flow);
    const sessionId = item.sessionId as string;
    await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the merged item\'s process to be parked' });
    await flow.mei.conn.request('session.message.send', { sessionId, text: OBJECTION });
    await waitFor(() => flow.d.ctx.services.agents.get(sessionId)?.status === 'running', { timeoutMs: 20_000, what: 'the turn of Mei\'s message' });
    await flow.mei.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 });
    // (the sweep asks again every few seconds: the session stays while the agent thinks)
    await sleep(1_500);
    expect(flow.d.ctx.services.agents.get(sessionId)?.status).not.toBe('ended');
    await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === CENTS_TEXT, { timeoutMs: 60_000, what: 'the merge of what Mei asked for' });
    await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check again' });
    expect(await turnEnds(flow, sessionId)).toEqual(['completed', 'completed']);
    await waitFor(async () => (await merges(flow)) === 2, { timeoutMs: 10_000, what: 'smurg\'s second merge in the audit' });
  });

  for (const merging of ['auto', 'host'] as const) {
    it(`V14 ${merging === 'auto' ? 'smurg merges' : 'the host merges each item'}: the host's Merge… of a reviewed version while the turn of a message to its agent runs: the turn finishes, and its version ${merging === 'auto' ? 'merges' : 'waits for the host'}`, async () => {
      const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging }, agents: { parkAfterMs: 1_000 } });
      await flow.claude.setScenario({ turns: [FIRST, THINKING_CENTS, { steps: [{ text: 'ok' }] }] });
      const topicId = await started(flow);
      if (merging === 'auto') await flow.mei.conn.request('plan.pause', { topicId });
      const done = await itemIs(flow, topicId, (candidate) => candidate.state === 'done' && candidate.merge !== undefined, 'item 1\'s report');
      const sessionId = done.sessionId as string;
      await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the done item\'s process to be parked' });
      await flow.mei.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 });
      await flow.mei.conn.request('session.message.send', { sessionId, text: OBJECTION });
      if (merging === 'auto') await flow.mei.conn.request('plan.resume', { topicId });
      await waitFor(() => flow.d.ctx.services.agents.get(sessionId)?.status === 'running', { timeoutMs: 20_000, what: 'the turn of Mei\'s message' });
      await flow.ian.conn.request('worktree.merge.approve', { requestId: (await itemOf(flow, topicId)).merge?.requestId as string });
      await itemIs(flow, topicId, (candidate) => candidate.merged?.by !== undefined && candidate.merged.by !== 'smurg', 'the host\'s merge of version 1');
      await sleep(1_500);
      expect(flow.d.ctx.services.agents.get(sessionId)?.status).not.toBe('ended');
      const two = await itemIs(flow, topicId, (candidate) => candidate.report?.version === 2, 'the version of Mei\'s message', 60_000);
      expect(await turnEnds(flow, sessionId)).toEqual(['completed', 'completed']);
      if (merging === 'host') {
        // Smurg merges nothing of it: the host's Merge… of the new version.
        await sleep(1_500);
        expect(await inMain(flow, 'src/cart/total.ts')).toBe('export const total = 1;\n');
        await flow.ian.conn.request('worktree.merge.approve', { requestId: two.merge?.requestId as string });
      }
      await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === CENTS_TEXT, { timeoutMs: 60_000, what: 'the merge of what Mei asked for' });
      await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check' });
      await waitFor(async () => (await merges(flow)) === (merging === 'auto' ? 1 : 0), { timeoutMs: 10_000, what: 'smurg\'s merges in the audit' });
    });
  }

  it('V14 a message to a merged item\'s parked agent, a restart, "I\'ve reviewed this", then Continue: the turn finishes, and what it asked for merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED, agents: { parkAfterMs: 1_000 } });
    await flow.claude.setScenario({ turns: [FIRST, THINKING_CENTS, { steps: [{ text: 'ok' }] }] });
    const { topicId, item } = await mergedAndReady(flow);
    const sessionId = item.sessionId as string;
    await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the merged item\'s process to be parked' });
    await flow.mei.conn.request('session.message.send', { sessionId, text: OBJECTION });
    await flow.restart();
    const held = await itemIs(flow, topicId, (candidate) => candidate.autoMerge?.state === 'held', 'the merged item to be held for the message', 30_000);
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped', undelivered: true });
    await flow.mei.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 });
    await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
    await waitFor(() => flow.d.ctx.services.agents.get(sessionId)?.status === 'running', { timeoutMs: 20_000, what: 'the turn of Continue' });
    await sleep(1_500);
    expect(flow.d.ctx.services.agents.get(sessionId)?.status).not.toBe('ended');
    await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === CENTS_TEXT, { timeoutMs: 60_000, what: 'the merge of what Mei asked for' });
    await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check again' });
    expect((await turnEnds(flow, sessionId)).at(-1)).toBe('completed');
    await waitFor(async () => (await merges(flow)) === 2, { timeoutMs: 10_000, what: 'smurg\'s second merge in the audit' });
  });
});

describe('0.7.0 fix5: a message a restart left undelivered is its carers\' decision whoever merges (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  /** Held for its carers with the message in its session: Mei's decision, the topic not ready, the check refused. */
  async function heldForTheMessage(flow: Flow, topicId: string, sessionId: string): Promise<void> {
    const held = await itemIs(flow, topicId, (candidate) => candidate.autoMerge?.state === 'held', 'the merged item to be held for the message', 30_000);
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped', undelivered: true });
    await inboxItem(flow.mei, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api' && entry.waiting, 'Mei\'s decision');
    expect(phaseOf(flow, topicId)).toBe('executing');
    expect(await refusal(flow.mei.conn.request('topic.check', { topicId }))).toMatchObject({ code: 'conflict', reason: 'not-ready' });
    expect(flow.d.ctx.services.agents.facts(sessionId)).toMatchObject({ hasProcess: false, pendingMessages: 1 });
  }

  /** Continue delivers it; its version is the host's to merge; then the topic is ready, and the check is accepted. */
  async function continuedAndMergedByTheHost(flow: Flow, topicId: string): Promise<void> {
    await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
    const two = await itemIs(flow, topicId, (candidate) => candidate.report?.version === 2 && candidate.merge?.status === 'draft', 'the version of Mei\'s message', 60_000);
    expect(two.autoMerge).toBeUndefined();
    await flow.ian.conn.request('worktree.merge.approve', { requestId: two.merge?.requestId as string });
    await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === CENTS_TEXT, { timeoutMs: 60_000, what: 'the host\'s merge of what Mei asked for' });
    await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check' });
    await flow.mei.conn.request('topic.check', { topicId });
  }

  it('V15 the host merges each item: a message to a merged item\'s parked agent, then a restart: held for its carers, the topic not ready; Continue delivers it, and the host merges its version', async () => {
    const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging: 'host' }, agents: { parkAfterMs: 1_000 } });
    await flow.claude.setScenario({ turns: [FIRST, CENTS, { steps: [{ text: 'ok' }] }] });
    const topicId = await started(flow);
    const done = await itemIs(flow, topicId, (candidate) => candidate.state === 'done' && candidate.merge !== undefined, 'item 1\'s report');
    const sessionId = done.sessionId as string;
    await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the done item\'s process to be parked' });
    await flow.ian.conn.request('worktree.merge.approve', { requestId: done.merge?.requestId as string });
    await itemIs(flow, topicId, (candidate) => candidate.merged !== undefined, 'the host\'s merge');
    await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check' });
    await flow.mei.conn.request('session.message.send', { sessionId, text: OBJECTION });
    await flow.restart();
    await heldForTheMessage(flow, topicId, sessionId);
    await continuedAndMergedByTheHost(flow, topicId);
  });

  it('V15 the host merges each item: a report follow-up a restart left undelivered, then the host\'s Merge…: held for its carers, never "executing" with nobody told; Continue delivers it', async () => {
    const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging: 'host' }, agents: { parkAfterMs: 1_000 } });
    await flow.claude.setScenario({ turns: [FIRST, CENTS, { steps: [{ text: 'ok' }] }] });
    const topicId = await started(flow);
    const done = await itemIs(flow, topicId, (candidate) => candidate.state === 'done' && candidate.merge !== undefined, 'item 1\'s report');
    const sessionId = done.sessionId as string;
    await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the done item\'s process to be parked' });
    await flow.mei.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: OBJECTION });
    await flow.restart();
    await flow.ian.conn.request('worktree.merge.approve', { requestId: (await itemOf(flow, topicId)).merge?.requestId as string });
    await itemIs(flow, topicId, (candidate) => candidate.merged !== undefined, 'the host\'s merge');
    await heldForTheMessage(flow, topicId, sessionId);
    await continuedAndMergedByTheHost(flow, topicId);
  });

  it('V15 the host turns automatic merging off while a merged item is held for a message a restart left undelivered: the hold and Mei\'s decision stay, the topic is not ready; Continue delivers it, and the host merges its version', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED, agents: { parkAfterMs: 1_000 } });
    await flow.claude.setScenario({ turns: [FIRST, CENTS, { steps: [{ text: 'ok' }] }] });
    const { topicId, item } = await mergedAndReady(flow);
    const sessionId = item.sessionId as string;
    await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the merged item\'s process to be parked' });
    await flow.mei.conn.request('session.message.send', { sessionId, text: OBJECTION });
    await flow.restart();
    await heldForTheMessage(flow, topicId, sessionId);
    await flow.ian.conn.request('admin.settings.set', { merging: 'host' });
    await waitFor(async () => (await itemOf(flow, topicId)).merging === 'host', { timeoutMs: 10_000, what: 'the item to be the host\'s to merge' });
    // (a pass of the merge queue runs on the change; the hold is still there after it)
    await sleep(2_000);
    await heldForTheMessage(flow, topicId, sessionId);
    await continuedAndMergedByTheHost(flow, topicId);
    expect(await merges(flow)).toBe(1);
  });
});
