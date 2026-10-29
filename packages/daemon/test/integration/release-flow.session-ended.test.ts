// The check of 6f42b50 (W/verify/last7/hold, E2 and E3; fix8), in the RELEASE composition with the stand-in `claude`
// (release-flow.support.ts): the session of a held item is ended ("End session" in its conversation menu, by Mei or by
// the host).
//
//   V20 smurg merged version 1; Mei paused the plan and wrote to its agent, whose turn made version 2 (a draft, waiting
//       for the pause); the turn of her second message was stopped, or ended on an API error; then she ended the
//       session. 6f42b50 forgot that turn (D2 of fix7 read `merged` from version 1), and once the plan went on smurg
//       merged version 2 by itself, although its later turn did not finish (D6 row 6): only "Merge it as it is" merges it
//       now, and nothing waits for a continue the ended session can no longer take. Controls (fix7's D2 and D1 stay as
//       they were): a later turn of a merged item that ends on an API error, and a message a restart left undelivered,
//       each followed by "End session"; the host's merge after such a turn broke, then "End session", or smurg's
//       continue whose turn changes nothing.
//   V21 a later turn of a merged item edits files and is stopped, then the session is ended. With smurg merging the
//       hold became 'edited' and offered only Continue, which the daemon refuses ('no-session'): it escalated, and the
//       topic never settled; with the host merging nobody had a hold or a row at all. Now the item's carers have the
//       hold (whoever merges), the wire says that its session has ended (`autoMerge.sessionEnded`: the foot offers the
//       worktree's "Request merge" instead of Continue), the request is the host's row, and the host's merge settles the
//       topic.
//   V22 (the check of 13591fb, W/verify/last8/hold, F1; fix9) V21's "Request merge", then the host REJECTS it. The
//       rejected request became the item's current one: with smurg merging it was held 'rejected', whose only answer
//       ("Ask the agent to fix it") the daemon refuses ('no-session'); with the host merging nobody had a hold or a row;
//       and the topic never settled. That reject is the decision now: the item stays on its merged request, the change
//       stays in the worktree and holds nothing, and the topic settles (ready, announced once; the check; complete),
//       whoever merges, in the folder's own git and in smurg's history. Controls: the approve still settles in smurg's
//       history (V21 tells it in the folder's git); the worktree changes again after the reject: the 'edited' hold is
//       back.
//   V23 (fix9, the same decision in the other order) the host rejects a later version of a merged item while its
//       session is there, then Mei ends the session: held 'rejected' for an answer no session can give (smurg merging),
//       or nobody's row (the host merging), for good. The reject is the decision once the session has ended: as V22.
//   The check of 85d2bfc (W/verify/last9/hold, the lead's G1-G3; fix10), in V22's story: after the reject, a write git
//       does not count (the same bytes, a file .gitignore excludes) held the item 'edited' again for a moment, a row
//       for Mei, "Ready to check" announced again, also after the check (G1); a hard death inside the host's reject
//       left topics.json on the merged request while worktrees.json still had the request waiting, and the foot's
//       "Request merge" then left that request pending on the complete topic for good (G2: the start tracks it again;
//       a normal start takes nothing); while the commit of Mei's "Request merge" was in flight the worktree counted as
//       holding nothing (`unmerged`), and the topic could say "Ready to check" for that moment (G3; V22 counts "ready"
//       from the end of the session).
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, type PlanInfo, type WorkItem } from '@smurg/protocol';
import type { FakeClaudeStep } from '../../src/testing/index.ts';
import type { ReportServiceImpl } from '../../src/topics/report-service.ts';
import type { GitRunner } from '../../src/worktree/git.ts';
import { MEI, audited, inboxItem, refusal, startFlow, waitFor, type Flow } from './release-flow.support.ts';

const SLUG = 'checkout';
const SPEC_PATH = `specs/${SLUG}/SPEC.md`;
const PLAN_PATH = `specs/${SLUG}/PLAN.md`;
const REPORT_PATH = `specs/${SLUG}/reports/cart-api.md`;
const SPEC = ['# Checkout', '', '## Goal', 'Buying a book takes one page.', '', '## Decisions', '- Cards only.', '', '## Scope', 'Cart, receipt, page.', '', '## Out of scope', 'Invoices.', '', '## Behaviour', 'One page.', '', '## Open questions', 'None.', ''].join('\n');
const PLAN = ['# Plan: Checkout', '', '<!-- smurg:plan v1 -->', '', '### 1. Cart API', '- id: cart-api', '- size: m', '- touches: src/cart/**', '', 'The Cart API.', '', '<!-- smurg:plan end -->', ''].join('\n');
function report(done: string): string {
  return ['# Result report: Cart API', '', '<!-- smurg:report v1 item=cart-api -->', '- outcome: complete', '', '## What was done', done, '', '## Why it was done this way', 'As the spec decided.', '', '## How it was verified', '- [x] `pnpm test`: 3 tests passed', '', '## What to watch out for', 'Nothing special.', ''].join('\n');
}
const write = (path: string, content: string): FakeClaudeStep => ({ tool: 'Write', input: { file_path: path, content } });
const handIn = (done: string): FakeClaudeStep[] => [{ tool: 'Bash', input: { command: 'pnpm test' }, result: '3 tests passed' }, write(REPORT_PATH, report(done)), { tool: 'mcp__smurg__check_report', input: {} }, { text: 'Cart API is done.' }];
const ONE_TEXT = 'export const total = 1;\n';
const FIRST = { match: 'Start work item 1 ', steps: [write('src/cart/total.ts', ONE_TEXT), ...handIn('The work of Cart API.')] };
const CENTS_TEXT = 'export const total = 100; // cents\n';
/** What the agent does when it goes on with Mei's message: the totals in cents, a new version. */
const ANSWER: FakeClaudeStep[] = [write('src/cart/total.ts', CENTS_TEXT), ...handIn('Totals in cents.')];
const OBJECTION = 'Wait, do not merge this: the totals must be in cents.';
const ROUNDING = 'And round the totals to whole cents.';
const ERROR: FakeClaudeStep[] = [{ thinking: true, ms: 1_500 }, { text: 'API Error: overloaded', apiError: 'overloaded' }, { result: { subtype: 'success', is_error: true, terminal_reason: 'api_error' } }];
const FILES = { 'README.md': '# Bookshop\n', 'src/app.ts': 'export const title = "Bookshop";\n' };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const planOf = async (flow: Flow, topicId: string): Promise<PlanInfo> => (await flow.leo.conn.request('plan.get', { topicId })).plan as PlanInfo;
const itemOf = async (flow: Flow, topicId: string): Promise<WorkItem> => (await planOf(flow, topicId)).items.find((candidate) => candidate.id === 'cart-api') as WorkItem;
async function itemIs(flow: Flow, topicId: string, fits: (item: WorkItem) => boolean, what: string, timeoutMs = 60_000): Promise<WorkItem> {
  await waitFor(async () => fits(await itemOf(flow, topicId)), { timeoutMs, what });
  return itemOf(flow, topicId);
}
const inMain = async (flow: Flow, path: string): Promise<string> => Buffer.from((await flow.ian.conn.request('file.read', { file: { root: MAIN_ROOT, path } })).content).toString('utf8');
const phaseOf = (flow: Flow, topicId: string): string | undefined => flow.d.ctx.services.topics.get(topicId)?.phase;
const statusOf = (flow: Flow, sessionId: string): string | undefined => flow.d.ctx.services.agents.get(sessionId)?.status;
const lineIds = async (flow: Flow, sessionId: string): Promise<string[]> => (await flow.ian.conn.request('session.watch', { sessionId })).events.flatMap((event) => (event.kind === 'line' ? [event.text.id] : []));

/**
 * worktrees.json as a hard death inside the host's reject leaves it (0.7.0 fix10, W/verify/last9/hold H8): the request
 * still waits there, while topics.json already has the reject's own write (the item back on its merged request).
 */
async function rejectNotWritten(stateDir: string, requestId: string): Promise<void> {
  const names = (await readdir(stateDir, { recursive: true })).map(String).filter((name) => name === 'worktrees.json' || name.endsWith('/worktrees.json'));
  expect(names).toHaveLength(1);
  const path = join(stateDir, names[0] as string);
  const doc = JSON.parse(await readFile(path, 'utf8')) as { merges: { id: string; status: string; decidedAt?: number; rejectReason?: string }[] };
  const merge = doc.merges.find((entry) => entry.id === requestId);
  expect(merge?.status).toBe('rejected');
  if (merge === undefined) return;
  merge.status = 'pending';
  delete merge.decidedAt;
  delete merge.rejectReason;
  await writeFile(path, JSON.stringify(doc), { mode: 0o600 });
}

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

/** Started; version 1 merged (by smurg, or by the host's Merge…); its agent's process parked. */
async function merged(flow: Flow, merging: 'auto' | 'host'): Promise<{ topicId: string; sessionId: string }> {
  const topicId = await started(flow);
  const done = await itemIs(flow, topicId, (item) => item.state === 'done' && item.merge !== undefined, 'item 1\'s report');
  if (merging === 'host') await flow.ian.conn.request('worktree.merge.approve', { requestId: done.merge?.requestId as string });
  await itemIs(flow, topicId, (item) => item.merged !== undefined && (merging === 'auto' ? item.merged.by === 'smurg' : item.merged.by !== 'smurg'), 'version 1 to merge');
  await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check' });
  const sessionId = done.sessionId as string;
  await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the merged item\'s process to be parked' });
  return { topicId, sessionId };
}

/** Mei writes to the item's agent, and its turn runs. */
async function message(flow: Flow, sessionId: string, text: string): Promise<void> {
  await flow.mei.conn.request('session.message.send', { sessionId, text });
  await waitFor(() => statusOf(flow, sessionId) === 'running', { timeoutMs: 20_000, what: `the turn of "${text}"` });
}

/** The person ends the item's session ("End session"). */
async function endSession(flow: Flow, sessionId: string, by: 'mei' | 'ian'): Promise<void> {
  await flow[by].conn.request('session.end', { sessionId });
  await waitFor(() => statusOf(flow, sessionId) === 'ended', { timeoutMs: 20_000, what: 'the session to end' });
}

/** The topic is ready, the check is accepted, and it is complete. */
/**
 * The phase may move with git's look at a worktree, which only the reports' sweep announces (every 15 ms here): it runs
 * now, so the members were told "Ready to check" before Mei acts on it (0.7.0 release: on a loaded machine the check
 * came first, and the topic went from executing to complete as announced).
 */
function announced(flow: Flow): void {
  (flow.d.ctx.services.reports as ReportServiceImpl).sweep();
}

async function checked(flow: Flow, topicId: string): Promise<void> {
  await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check' });
  announced(flow);
  await flow.mei.conn.request('topic.check', { topicId });
  expect(phaseOf(flow, topicId)).toBe('complete');
}

describe('0.7.0 fix8: the session of a held item is ended (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  for (const cut of ['stop', 'error'] as const) {
    it(`V20 smurg merges: version 2 waits for the paused plan, the turn of Mei's next message ${cut === 'stop' ? 'is stopped' : 'ends on an API error'}, Mei ends the session and the plan goes on: held for its carers, never merged by smurg; "Merge it as it is" merges it`, async () => {
      const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging: 'auto' }, agents: { parkAfterMs: 1_000 } });
      await flow.claude.setScenario({ turns: [FIRST, { match: 'must be in cents', steps: ANSWER }, { match: 'round the totals', steps: cut === 'stop' ? [{ wait: 'interrupt' }, ...ANSWER] : ERROR }, { steps: [{ text: 'ok' }] }] });
      const { topicId, sessionId } = await merged(flow, 'auto');
      await flow.mei.conn.request('plan.pause', { topicId });
      await message(flow, sessionId, OBJECTION);
      await itemIs(flow, topicId, (item) => item.report?.version === 2 && item.merge?.status === 'draft' && item.autoMerge?.reason === 'paused', 'version 2 to wait for the paused plan');
      await waitFor(() => statusOf(flow, sessionId) !== 'running', { timeoutMs: 30_000, what: 'the turn of version 2 to end' });
      await message(flow, sessionId, ROUNDING);
      if (cut === 'stop') await flow.mei.conn.request('session.interrupt', { sessionId });
      await waitFor(() => statusOf(flow, sessionId) !== 'running', { timeoutMs: 30_000, what: 'the later turn to end' });
      await endSession(flow, sessionId, 'mei');
      await flow.mei.conn.request('plan.resume', { topicId });
      // Held for its carers: its later turn did not finish, and nothing continues it (the wire says its session ended).
      const held = await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held', 'version 2 to be held for its carers', 30_000);
      expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped', sessionEnded: true });
      await inboxItem(flow.mei, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api' && entry.waiting, 'Mei\'s decision');
      // (the merge queue's passes and the sweep: nothing merges it by itself, nothing waits for a continue)
      await sleep(3_000);
      expect((await itemOf(flow, topicId)).merge?.status).toBe('draft');
      expect(await inMain(flow, 'src/cart/total.ts')).toBe(ONE_TEXT);
      expect(phaseOf(flow, topicId)).toBe('executing');
      expect(await refusal(flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' }))).toMatchObject({ code: 'conflict', reason: 'no-session' });
      flow.advance(6 * 60_000);
      await sleep(1_500);
      expect((await lineIds(flow, sessionId)).filter((id) => id.startsWith('conversation.continued'))).toEqual([]);
      await flow.mei.conn.request('plan.item.release', { topicId, itemId: 'cart-api', version: 2 });
      await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === CENTS_TEXT, { timeoutMs: 60_000, what: 'version 2 to merge' });
      expect((await itemOf(flow, topicId)).merged?.by).toBe('smurg');
      await checked(flow, topicId);
    });
  }

  it('V20 control, smurg merges: a later turn of a merged item ends on an API error (smurg\'s continue owed), then Mei ends the session: the topic settles and no continue goes out', async () => {
    const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging: 'auto' }, agents: { parkAfterMs: 1_000 } });
    await flow.claude.setScenario({ turns: [FIRST, { match: 'must be in cents', steps: ERROR }, { steps: [{ text: 'ok' }] }] });
    const { topicId, sessionId } = await merged(flow, 'auto');
    await message(flow, sessionId, OBJECTION);
    await waitFor(() => statusOf(flow, sessionId) !== 'running', { timeoutMs: 30_000, what: 'the turn to break' });
    await itemIs(flow, topicId, (item) => item.autoMerge?.reason === 'busy', 'smurg\'s continue to be waited for', 20_000);
    await endSession(flow, sessionId, 'mei');
    await itemIs(flow, topicId, (item) => item.autoMerge === undefined, 'the wait to end with the session', 20_000);
    await checked(flow, topicId);
    flow.advance(61_000);
    await sleep(1_500);
    expect((await lineIds(flow, sessionId)).filter((id) => id.startsWith('conversation.continued'))).toEqual([]);
    expect(await inMain(flow, 'src/cart/total.ts')).toBe(ONE_TEXT);
  });

  it('V20 control, smurg merges: a message to a merged item\'s parked session that a restart left undelivered (held for it), then Mei ends the session: the hold ends and the topic settles', async () => {
    const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging: 'auto' }, agents: { parkAfterMs: 1_000 } });
    await flow.claude.setScenario({ turns: [FIRST, { match: 'must be in cents', steps: ANSWER }, { steps: [{ text: 'ok' }] }] });
    const { topicId, sessionId } = await merged(flow, 'auto');
    await flow.mei.conn.request('session.message.send', { sessionId, text: OBJECTION });
    await flow.restart();
    const held = await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held', 'the merged item to be held for the message', 30_000);
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped', undelivered: true });
    expect(held.autoMerge?.sessionEnded).toBeUndefined();
    await endSession(flow, sessionId, 'mei');
    await itemIs(flow, topicId, (item) => item.autoMerge === undefined, 'the hold to end with the session', 20_000);
    await checked(flow, topicId);
  });

  for (const after of ['end', 'nothing-new'] as const) {
    it(`V20 control, the host merges: the turn of Mei's message ends on an API error while version 1 is a draft, then the host's Merge… of it, ${after === 'end' ? 'then Mei ends the session: the topic settles and no continue goes out' : 'then smurg\'s continue, whose turn changes nothing: ready once, and the review completes it'}`, async () => {
      const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging: 'host' }, agents: { parkAfterMs: 1_000 } });
      await flow.claude.setScenario({ turns: [FIRST, { match: 'must be in cents', steps: ERROR }, { match: 'Continue the work item', steps: [{ text: 'The totals stay as they are.' }] }, { steps: [{ text: 'ok' }] }] });
      const topicId = await started(flow);
      const done = await itemIs(flow, topicId, (item) => item.state === 'done' && item.merge?.status === 'draft', 'item 1\'s report');
      const sessionId = done.sessionId as string;
      await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the item\'s process to be parked' });
      await message(flow, sessionId, OBJECTION);
      await waitFor(() => statusOf(flow, sessionId) !== 'running', { timeoutMs: 30_000, what: 'the turn to break' });
      await flow.ian.conn.request('worktree.merge.approve', { requestId: done.merge?.requestId as string });
      await itemIs(flow, topicId, (item) => item.merged !== undefined, 'the host\'s merge of version 1');
      await sleep(1_500);
      expect(phaseOf(flow, topicId)).toBe('executing');
      if (after === 'end') {
        await endSession(flow, sessionId, 'mei');
        await checked(flow, topicId);
        flow.advance(61_000);
        await sleep(1_500);
        expect((await lineIds(flow, sessionId)).filter((id) => id.startsWith('conversation.continued'))).toEqual([]);
      } else {
        const phases: string[] = [];
        flow.d.ctx.bus.on('topic.changed', ({ topic, previous }: { readonly topic: { readonly id: string; readonly phase: string }; readonly previous: { readonly phase: string } | null }) => {
          if (topic.id === topicId && previous?.phase !== topic.phase) phases.push(topic.phase);
        });
        flow.advance(61_000);
        await waitFor(async () => (await lineIds(flow, sessionId)).includes('conversation.continued.error'), { timeoutMs: 30_000, what: 'smurg\'s continue' });
        await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check' });
        announced(flow);
        await flow.mei.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 });
        await waitFor(() => phaseOf(flow, topicId) === 'complete', { timeoutMs: 30_000, what: 'the reviewed topic to be complete' });
        expect(phases.filter((phase) => phase === 'ready')).toHaveLength(1);
      }
      expect(await inMain(flow, 'src/cart/total.ts')).toBe(ONE_TEXT);
    });
  }

  for (const merging of ['auto', 'host'] as const) {
    for (const by of ['mei', 'ian'] as const) {
      it(`V21 ${merging === 'auto' ? 'smurg merges' : 'the host merges each item'}: a later turn of a merged item writes half of a change and Mei stops it, then ${by === 'mei' ? 'Mei' : 'the host'} ends the session: held for its carers ("Request merge", not Continue), and the host's merge of the request settles the topic`, async () => {
        const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging }, agents: { parkAfterMs: 1_000 } });
        await flow.claude.setScenario({ turns: [FIRST, { match: 'must be in cents', steps: [write('src/cart/total.ts', CENTS_TEXT), { wait: 'interrupt' }, ...handIn('Totals in cents.')] }, { steps: [{ text: 'ok' }] }] });
        const { topicId, sessionId } = await merged(flow, merging);
        await message(flow, sessionId, OBJECTION);
        const worktreeId = (await itemOf(flow, topicId)).worktreeId as string;
        await waitFor(async () => (await flow.ian.conn.request('file.read', { file: { root: { kind: 'worktree', worktreeId }, path: 'src/cart/total.ts' } }).then((read) => Buffer.from(read.content).toString('utf8'), () => '')) === CENTS_TEXT, { timeoutMs: 30_000, what: 'the turn to write' });
        await flow.mei.conn.request('session.interrupt', { sessionId });
        await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held' && item.autoMerge.reason === 'stopped', 'held for the stopped turn', 30_000);
        await endSession(flow, sessionId, by);
        // What the turn wrote is in the worktree and in no version: the carers' hold, which no Continue can answer.
        const held = await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held' && item.autoMerge.reason === 'edited', 'the half-done change to be held for its carers', 30_000);
        expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'edited', sessionEnded: true });
        expect(held.merge?.status).toBe('merged');
        await inboxItem(flow.mei, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api' && entry.waiting, 'Mei\'s decision');
        expect(phaseOf(flow, topicId)).toBe('executing');
        expect(await refusal(flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' }))).toMatchObject({ code: 'conflict', reason: 'no-session' });
        // Mei's "Request merge": the host's row, and the hold ends.
        const { request } = await flow.mei.conn.request('worktree.merge.request', { worktreeId });
        expect(request.status).toBe('pending');
        await itemIs(flow, topicId, (item) => item.autoMerge === undefined, 'the hold to end with the request', 20_000);
        await inboxItem(flow.ian, (entry) => entry.kind === 'merge', 'the host\'s merge row');
        expect(await inMain(flow, 'src/cart/total.ts')).toBe(ONE_TEXT);
        await flow.ian.conn.request('worktree.merge.approve', { requestId: request.id });
        await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === CENTS_TEXT, { timeoutMs: 30_000, what: 'the half-done change to merge' });
        await checked(flow, topicId);
      });
    }
  }

  /** V21's story up to the 'edited' hold after "End session" (Mei ends it): where things stand, and the phases since. */
  async function heldAfterEnd(flow: Flow, merging: 'auto' | 'host'): Promise<{ topicId: string; worktreeId: string; mergedId: string; phases: string[]; sinceEnd: number }> {
    await flow.claude.setScenario({ turns: [FIRST, { match: 'must be in cents', steps: [write('src/cart/total.ts', CENTS_TEXT), { wait: 'interrupt' }, ...handIn('Totals in cents.')] }, { steps: [{ text: 'ok' }] }] });
    const { topicId, sessionId } = await merged(flow, merging);
    const phases: string[] = [];
    flow.d.ctx.bus.on('topic.changed', ({ topic, previous }: { readonly topic: { readonly id: string; readonly phase: string }; readonly previous: { readonly phase: string } | null }) => {
      if (topic.id === topicId && previous?.phase !== topic.phase) phases.push(topic.phase);
    });
    await message(flow, sessionId, OBJECTION);
    const before = await itemOf(flow, topicId);
    const worktreeId = before.worktreeId as string;
    const mergedId = before.merge?.requestId as string;
    await waitFor(async () => (await inWorktree(flow, worktreeId)) === CENTS_TEXT, { timeoutMs: 30_000, what: 'the turn to write' });
    await flow.mei.conn.request('session.interrupt', { sessionId });
    await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held' && item.autoMerge.reason === 'stopped', 'held for the stopped turn', 30_000);
    const sinceEnd = phases.length;
    await endSession(flow, sessionId, 'mei');
    await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held' && item.autoMerge.reason === 'edited' && item.autoMerge.sessionEnded === true, 'the half-done change to be held for its carers', 30_000);
    return { topicId, worktreeId, mergedId, phases, sinceEnd };
  }

  /** heldAfterEnd, then Mei's "Request merge" of what the worktree holds: the request, pending, and where things stand. */
  async function requestedAfterEnd(flow: Flow, merging: 'auto' | 'host'): Promise<{ topicId: string; worktreeId: string; requestId: string; mergedId: string; phases: string[]; sinceEnd: number }> {
    const held = await heldAfterEnd(flow, merging);
    const { request } = await flow.mei.conn.request('worktree.merge.request', { worktreeId: held.worktreeId });
    expect(request.status).toBe('pending');
    await itemIs(flow, held.topicId, (item) => item.autoMerge === undefined && item.merge?.requestId === request.id, 'the hold to end with the request', 20_000);
    return { ...held, requestId: request.id };
  }
  const inWorktree = async (flow: Flow, worktreeId: string): Promise<string> =>
    flow.ian.conn.request('file.read', { file: { root: { kind: 'worktree', worktreeId }, path: 'src/cart/total.ts' } }).then((read) => Buffer.from(read.content).toString('utf8'), () => '');
  const decisionsWaiting = async (flow: Flow): Promise<number> =>
    [...(await flow.mei.inbox()), ...(await flow.ian.inbox())].filter((entry) => entry.kind === 'decision' && entry.itemId === 'cart-api' && entry.waiting).length;

  for (const history of ['folder', 'smurg'] as const) {
    for (const merging of ['auto', 'host'] as const) {
      it(`V22 ${merging === 'auto' ? 'smurg merges' : 'the host merges each item'}, ${history === 'folder' ? 'the folder\'s own git' : 'smurg\'s history'}: after "End session", Mei's "Request merge" of the half-done change, and the host rejects it: the item stays merged, nothing holds it, the change stays in the worktree, and the topic settles`, async () => {
        const flow = await startFlow({ files: FILES, git: history === 'folder', settings: { permissionMode: 'auto', merging }, agents: { parkAfterMs: 1_000 } });
        const { topicId, worktreeId, requestId, mergedId, phases, sinceEnd } = await requestedAfterEnd(flow, merging);
        await flow.ian.conn.request('worktree.merge.reject', { requestId });
        // The reject is the decision: the item stays on its merged request, and nothing holds it.
        await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check after the reject' });
        const after = await itemOf(flow, topicId);
        expect(after.merge).toMatchObject({ requestId: mergedId, status: 'merged' });
        expect(after.autoMerge).toBeUndefined();
        expect(await decisionsWaiting(flow)).toBe(0);
        expect((await flow.ian.conn.request('worktree.merge.list', {})).requests.find((entry) => entry.id === requestId)?.status).toBe('rejected');
        // (the merge queue's passes and the sweep: the topic stays ready, nothing is held again)
        flow.advance(70_000);
        await sleep(2_000);
        expect(phaseOf(flow, topicId)).toBe('ready');
        expect((await itemOf(flow, topicId)).autoMerge).toBeUndefined();
        expect((await audited(flow, 'worktree.merge.held')).filter((entry) => (entry.detail?.['reason'] ?? null) === 'rejected')).toEqual([]);
        // Nothing is deleted: the change stays in the worktree, and main never got it.
        expect(await inMain(flow, 'src/cart/total.ts')).toBe(ONE_TEXT);
        expect(await inWorktree(flow, worktreeId)).toBe(CENTS_TEXT);
        await checked(flow, topicId);
        // (ready once from the end of the session on: also not for the moment the commit of Mei's "Request merge" is in
        // flight, before the merge queue holds the half-done change; 0.7.0 fix10)
        expect(phases.slice(sinceEnd)).toEqual(['ready', 'complete']);
        await sleep(1_500);
        expect(await inWorktree(flow, worktreeId)).toBe(CENTS_TEXT);
        expect(await inMain(flow, 'src/cart/total.ts')).toBe(ONE_TEXT);
      });
    }
  }

  for (const merging of ['auto', 'host'] as const) {
    it(`V22 control, ${merging === 'auto' ? 'smurg merges' : 'the host merges each item'}, smurg's history: the host approves Mei's "Request merge" after "End session": the change merges and the topic settles`, async () => {
      const flow = await startFlow({ files: FILES, git: false, settings: { permissionMode: 'auto', merging }, agents: { parkAfterMs: 1_000 } });
      const { topicId, requestId } = await requestedAfterEnd(flow, merging);
      await flow.ian.conn.request('worktree.merge.approve', { requestId });
      await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === CENTS_TEXT, { timeoutMs: 30_000, what: 'the half-done change to merge' });
      expect((await itemOf(flow, topicId)).merge).toMatchObject({ requestId, status: 'merged' });
      await checked(flow, topicId);
    });

    it(`V22 control, ${merging === 'auto' ? 'smurg merges' : 'the host merges each item'}: after the host's reject, the worktree changes again: the 'edited' hold is back, and a new "Request merge" and the host's merge settle the topic`, async () => {
      const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging }, agents: { parkAfterMs: 1_000 } });
      const { topicId, worktreeId, requestId } = await requestedAfterEnd(flow, merging);
      await flow.ian.conn.request('worktree.merge.reject', { requestId });
      await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check after the reject' });
      const ROUNDED = 'export const total = 100; // whole cents\n';
      await flow.ian.conn.request('file.write', { file: { root: { kind: 'worktree', worktreeId }, path: 'src/cart/total.ts' }, content: bytes(ROUNDED) });
      const held = await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held' && item.autoMerge.reason === 'edited', 'the hold to come back', 30_000);
      expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'edited', sessionEnded: true });
      expect(phaseOf(flow, topicId)).toBe('executing');
      const again = (await flow.mei.conn.request('worktree.merge.request', { worktreeId })).request;
      await itemIs(flow, topicId, (item) => item.autoMerge === undefined, 'the hold to end with the new request', 20_000);
      await flow.ian.conn.request('worktree.merge.approve', { requestId: again.id });
      await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === ROUNDED, { timeoutMs: 30_000, what: 'the new change to merge' });
      await checked(flow, topicId);
    });
  }

  /**
   * Holds every commit the worktree module makes from now on until `release`, after it cleared the tree's `dirty` mark
   * and staged the tree, before `git write-tree`: the moment a commit is in flight, made certain.
   */
  function holdCommits(flow: Flow): { readonly reached: Promise<void>; release(): void; restore(): void } {
    const manager = flow.d.ctx.services.worktrees as unknown as { readonly runner: GitRunner | null; readonly available?: { readonly git?: GitRunner } };
    const runners = new Set<GitRunner>([manager.runner, manager.available?.git].filter((runner): runner is GitRunner => runner !== null && runner !== undefined));
    let reached: () => void = () => {};
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const undo: (() => void)[] = [];
    for (const runner of runners) {
      const run = runner.run;
      runner.run = (options) => (options.args[0] === 'write-tree' ? (reached(), gate.then(() => run.call(runner, options))) : run.call(runner, options));
      undo.push(() => {
        runner.run = run;
      });
    }
    expect(runners.size).toBeGreaterThan(0);
    return { reached: atGate, release: () => release(), restore: () => undo.forEach((step) => step()) };
  }

  for (const merging of ['auto', 'host'] as const) {
    it(`V22 control, ${merging === 'auto' ? 'smurg merges' : 'the host merges each item'}: while the commit of Mei's "Request merge" after "End session" is in flight, the half-done change still counts as unmerged work, and the topic does not say ready`, async () => {
      const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging }, agents: { parkAfterMs: 1_000 } });
      const { topicId, worktreeId, phases, sinceEnd } = await heldAfterEnd(flow, merging);
      const worktrees = flow.d.ctx.services.worktrees;
      const held = holdCommits(flow);
      try {
        const requested = flow.mei.conn.request('worktree.merge.request', { worktreeId });
        await held.reached;
        // (the commit cleared `dirty` and the branch head is still the merged commit: what the last look found counts
        // until git finds the tree clean; 85d2bfc: nothing unmerged, and the topic could say "Ready to check")
        for (let look = 0; look < 10; look++) {
          expect(worktrees.unmerged(topicId).map((worktree) => worktree.id)).toEqual([worktreeId]);
          expect(phaseOf(flow, topicId)).toBe('executing');
          await sleep(50);
        }
        held.release();
        const { request } = await requested;
        expect(request.status).toBe('pending');
        await itemIs(flow, topicId, (item) => item.autoMerge === undefined && item.merge?.requestId === request.id, 'the hold to end with the request', 20_000);
        await flow.ian.conn.request('worktree.merge.approve', { requestId: request.id });
        await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === CENTS_TEXT, { timeoutMs: 30_000, what: 'the half-done change to merge' });
        await checked(flow, topicId);
        expect(phases.slice(sinceEnd)).toEqual(['ready', 'complete']);
      } finally {
        held.release();
        held.restore();
      }
    });

    it(`V22 control, ${merging === 'auto' ? 'smurg merges' : 'the host merges each item'}: after the host's reject, a save git does not count (the same bytes, a file .gitignore excludes) holds nothing: the topic stays ready, nobody gets a row, nothing is announced again; also after the check`, async () => {
      const flow = await startFlow({ files: { ...FILES, '.gitignore': '*.log\n' }, settings: { permissionMode: 'auto', merging }, agents: { parkAfterMs: 1_000 } });
      const { topicId, worktreeId, requestId, phases, sinceEnd } = await requestedAfterEnd(flow, merging);
      await flow.ian.conn.request('worktree.merge.reject', { requestId });
      await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check after the reject' });
      const heldEdited = async (): Promise<number> => (await audited(flow, 'worktree.merge.held')).filter((entry) => (entry.detail?.['reason'] ?? null) === 'edited').length;
      const heldBefore = await heldEdited();
      // Right after each write and once git has looked at it (the look comes 2 s after the last write): no hold, the
      // same phase. (85d2bfc: held 'edited' with a row for Mei until the look, "Ready to check" announced again)
      const quiet = async (phase: string, what: string): Promise<void> => {
        for (let look = 0; look < 12; look++) {
          expect((await itemOf(flow, topicId)).autoMerge, what).toBeUndefined();
          expect(phaseOf(flow, topicId), what).toBe(phase);
          expect(await decisionsWaiting(flow), what).toBe(0);
          await sleep(250);
        }
      };
      const saves = async (phase: string): Promise<void> => {
        await flow.ian.conn.request('file.write', { file: { root: { kind: 'worktree', worktreeId }, path: 'src/cart/total.ts' }, content: bytes(CENTS_TEXT) });
        await quiet(phase, `the same bytes saved (${phase})`);
        await flow.ian.conn.request('file.write', { file: { root: { kind: 'worktree', worktreeId }, path: 'debug.log' }, content: bytes('x\n') });
        await quiet(phase, `a file git ignores (${phase})`);
      };
      await saves('ready');
      expect(phases.slice(sinceEnd)).toEqual(['ready']);
      await checked(flow, topicId);
      await saves('complete');
      expect(phases.slice(sinceEnd)).toEqual(['ready', 'complete']);
      expect(await heldEdited()).toBe(heldBefore);
      expect(await inMain(flow, 'src/cart/total.ts')).toBe(ONE_TEXT);
      expect(await inWorktree(flow, worktreeId)).toBe(CENTS_TEXT);
    });

    it(`V22 after a restart, ${merging === 'auto' ? 'smurg merges' : 'the host merges each item'}: a normal start keeps the waiting request and the reject as they were; after a hard death inside the host's reject (topics.json written, worktrees.json not yet) the item tracks the request that still waits, and the host's answer to it settles the topic`, async () => {
      const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging }, agents: { parkAfterMs: 1_000 } });
      const { topicId, worktreeId, requestId, mergedId } = await requestedAfterEnd(flow, merging);
      const requests = async (): Promise<string[]> =>
        (await flow.ian.conn.request('worktree.merge.list', {})).requests
          .filter((entry) => entry.worktreeId === worktreeId)
          .map((entry) => `${entry.id === requestId ? 'R2' : entry.id === mergedId ? 'v1' : entry.id}:${entry.status}`)
          .sort();
      // A normal start while the request waits: it is the item's, as before.
      await flow.restart();
      await itemIs(flow, topicId, (item) => item.merge?.requestId === requestId && item.merge.status === 'pending', 'the request to be the item\'s after the start', 30_000);
      await flow.ian.conn.request('worktree.merge.reject', { requestId });
      await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check after the reject' });
      // A normal start after the reject: the item stays on its merged request, and no request is taken.
      await flow.restart();
      await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check after the start' });
      expect((await itemOf(flow, topicId)).merge).toMatchObject({ requestId: mergedId, status: 'merged' });
      expect(await requests()).toEqual(['R2:rejected', 'v1:merged']);
      // The torn write: topics.json has the item back on its merged request (the reject's own write), worktrees.json
      // still has the request waiting (the death came before the reject was written there).
      await flow.stop();
      await rejectNotWritten(flow.stateDir, requestId);
      await flow.restart();
      const phases: string[] = [];
      flow.d.ctx.bus.on('topic.changed', ({ topic, previous }: { readonly topic: { readonly id: string; readonly phase: string }; readonly previous: { readonly phase: string } | null }) => {
        if (topic.id === topicId && previous?.phase !== topic.phase) phases.push(topic.phase);
      });
      // (85d2bfc: the item stayed on its merged request, held 'edited' with a row for Mei, and her "Request merge" left
      // this request waiting on the complete topic for good)
      const tracked = await itemIs(flow, topicId, (item) => item.merge?.requestId === requestId && item.merge.status === 'pending', 'the item to track the request that still waits', 30_000);
      expect(tracked.autoMerge).toBeUndefined();
      expect(await decisionsWaiting(flow)).toBe(0);
      await inboxItem(flow.ian, (entry) => entry.kind === 'merge', 'the host\'s merge row');
      expect(phaseOf(flow, topicId)).toBe('executing');
      await flow.ian.conn.request('worktree.merge.reject', { requestId });
      await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check after the reject' });
      expect((await itemOf(flow, topicId)).merge).toMatchObject({ requestId: mergedId, status: 'merged' });
      await checked(flow, topicId);
      expect(await requests()).toEqual(['R2:rejected', 'v1:merged']);
      expect(phases.filter((phase) => phase === 'ready')).toHaveLength(1);
      expect(await inMain(flow, 'src/cart/total.ts')).toBe(ONE_TEXT);
      expect(await inWorktree(flow, worktreeId)).toBe(CENTS_TEXT);
    });
  }

  for (const merging of ['auto', 'host'] as const) {
    it(`V23 ${merging === 'auto' ? 'smurg merges' : 'the host merges each item'}: the host rejects version 2 of a merged item while its session is there, then Mei ends the session: the item goes back to its merged request, nothing holds it, version 2 stays in the worktree, and the topic settles`, async () => {
      const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging }, agents: { parkAfterMs: 1_000 } });
      await flow.claude.setScenario({ turns: [FIRST, { match: 'must be in cents', steps: ANSWER }, { steps: [{ text: 'ok' }] }] });
      const { topicId, sessionId } = await merged(flow, merging);
      const mergedId = (await itemOf(flow, topicId)).merge?.requestId as string;
      // (smurg would merge version 2 at once: the paused plan keeps it a draft for the host's reject)
      if (merging === 'auto') await flow.mei.conn.request('plan.pause', { topicId });
      await message(flow, sessionId, OBJECTION);
      const v2 = await itemIs(flow, topicId, (item) => item.report?.version === 2 && item.merge?.status === 'draft', 'version 2 as a draft');
      await waitFor(() => statusOf(flow, sessionId) !== 'running', { timeoutMs: 30_000, what: 'the turn of version 2 to end' });
      await flow.ian.conn.request('worktree.merge.reject', { requestId: v2.merge?.requestId as string });
      if (merging === 'auto') await flow.mei.conn.request('plan.resume', { topicId });
      // While the session is there, the reject is its carers' to answer (smurg merging: "Ask the agent to fix it").
      await itemIs(flow, topicId, (item) => item.merge?.status === 'rejected' && (merging === 'host' || item.autoMerge?.reason === 'rejected'), 'version 2 to be rejected');
      expect(phaseOf(flow, topicId)).toBe('executing');
      await endSession(flow, sessionId, 'mei');
      await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check after the end' });
      const after = await itemOf(flow, topicId);
      expect(after.merge).toMatchObject({ requestId: mergedId, status: 'merged' });
      expect(after.autoMerge).toBeUndefined();
      expect(await decisionsWaiting(flow)).toBe(0);
      expect(await inMain(flow, 'src/cart/total.ts')).toBe(ONE_TEXT);
      expect(await inWorktree(flow, after.worktreeId as string)).toBe(CENTS_TEXT);
      await checked(flow, topicId);
    });
  }
});
