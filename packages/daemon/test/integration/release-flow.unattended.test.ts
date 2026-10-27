// The 0.7.0 acceptance test (DESIGN 0.7.0 D22), built from the understanding report's measurements (U1's twelve cases,
// `measure.test.ts`): the RELEASE composition (every real module, real git, the real `smurg hook` / `smurg mcp`) with
// the stand-in `claude` (release-flow.support.ts), in a workspace that merges by itself (a new workspace's default)
// and in auto mode (0.6.0's default). One plan, three items, one dependency:
//
//   1 cart-api   2 receipt-email   3 checkout-page (depends on cart-api)        Mei starts it; Ian is the host
//
// What 0.6.0 measured (U1 M1): a team that left after Start found its plan stopped 1.2 s later and still stopped eight
// hours later, and a clean three-item plan needed six presses (three reviews, three merges). Here nobody presses
// anything after Start. This step (S3) holds the cases of the merge queue: M1 and M8 converge with no person, M9 with
// the host away, M2 a conflict between two items resolved by the item's own agent, M13 a conflict with a member's
// saved edit (smurg's own history) held for the carers with the member's name, M14 a resolve turn that only rewrites
// the report verified again once, M16 a restart in the middle of a resolve turn. The others (the decisions, a restart's
// continues, the slots) come with S4 and S6.
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, type PlanInfo, type WorkItem } from '@smurg/protocol';
import type { FakeClaudeStep } from '../../src/testing/index.ts';
import { AMY, IAN, MEI, audited, startFlow, told, waitFor, type Flow } from './release-flow.support.ts';

const SLUG = 'checkout';
const SPEC_PATH = `specs/${SLUG}/SPEC.md`;
const PLAN_PATH = `specs/${SLUG}/PLAN.md`;
const reportPath = (id: string): string => `specs/${SLUG}/reports/${id}.md`;

const SPEC = ['# Checkout', '', '## Goal', 'Buying a book takes one page.', '', '## Decisions', '- Cards only.', '', '## Scope', 'Cart, receipt, page.', '', '## Out of scope', 'Invoices.', '', '## Behaviour', 'One page.', '', '## Open questions', 'None.', ''].join('\n');

interface PlanItemText {
  readonly id: string;
  readonly title: string;
  readonly touches: string;
  readonly dependsOn?: string;
}
const THREE: readonly PlanItemText[] = [
  { id: 'cart-api', title: 'Cart API', touches: 'src/cart/**' },
  { id: 'receipt-email', title: 'Receipt email', touches: 'src/receipt/**' },
  { id: 'checkout-page', title: 'Checkout page', touches: 'src/checkout/**', dependsOn: 'cart-api' },
];
function planText(items: readonly PlanItemText[]): string {
  const body = items.flatMap((item, index) => [`### ${index + 1}. ${item.title}`, `- id: ${item.id}`, ...(item.dependsOn === undefined ? [] : [`- depends on: ${item.dependsOn}`]), '- size: m', `- touches: ${item.touches}`, '', `The ${item.title}.`, '']);
  return ['# Plan: Checkout', '', '<!-- smurg:plan v1 -->', '', ...body, '<!-- smurg:plan end -->', ''].join('\n');
}

function report(id: string, title: string, done = `The work of ${title}.`): string {
  return [
    `# Result report: ${title}`,
    '',
    `<!-- smurg:report v1 item=${id} -->`,
    '- outcome: complete',
    '',
    '## What was done',
    done,
    '',
    '## Why it was done this way',
    'As the spec decided.',
    '',
    '## How it was verified',
    '- [x] `pnpm test`: 3 tests passed',
    '',
    '## What to watch out for',
    'Nothing special.',
    '',
  ].join('\n');
}

const PNPM_TEST: FakeClaudeStep = { tool: 'Bash', input: { command: 'pnpm test' }, result: '3 tests passed' };
const handIn = (id: string, title: string, done?: string): FakeClaudeStep[] => [
  PNPM_TEST,
  { tool: 'Write', input: { file_path: reportPath(id), content: report(id, title, done) } },
  { tool: 'mcp__smurg__check_report', input: {} },
  { text: `${title} is done.` },
];
const write = (path: string, content: string): FakeClaudeStep => ({ tool: 'Write', input: { file_path: path, content } });

// 0.6.0's default for a new workspace is auto mode, and 0.7.0's merges by itself (release-flow.support.ts says the
// host's merge and "asks before commands" for the stories of 0.6.0).
const UNATTENDED = { settings: { permissionMode: 'auto' as const, merging: 'auto' as const } };
const APP_BEFORE = 'export const title = "Bookshop";\n';
const FILES = { 'README.md': '# Bookshop\n', 'src/app.ts': APP_BEFORE };

const planOf = async (flow: Flow, topicId: string): Promise<PlanInfo> => (await flow.leo.conn.request('plan.get', { topicId })).plan as PlanInfo;
const itemOf = async (flow: Flow, topicId: string, id: string): Promise<WorkItem> => (await planOf(flow, topicId)).items.find((candidate) => candidate.id === id) as WorkItem;
async function itemIs(flow: Flow, topicId: string, id: string, fits: (item: WorkItem) => boolean, what: string, timeoutMs = 60_000): Promise<WorkItem> {
  await waitFor(async () => fits(await itemOf(flow, topicId, id)), { timeoutMs, what });
  return itemOf(flow, topicId, id);
}
const mergedBySmurg = (flow: Flow, topicId: string, id: string): Promise<WorkItem> => itemIs(flow, topicId, id, (item) => item.merged?.by === 'smurg', `smurg to merge ${id}`);
const inMain = async (flow: Flow, path: string): Promise<string> => Buffer.from((await flow.ian.conn.request('file.read', { file: { root: MAIN_ROOT, path } })).content).toString('utf8');

/** Mei creates the topic, Ian writes its spec and plan, Mei assigns and presses Start. Returns the topic and when Start was pressed. */
async function started(flow: Flow, items: readonly PlanItemText[] = THREE): Promise<{ topicId: string; at: number }> {
  const created = await flow.mei.conn.request('topic.create', { name: 'Checkout' });
  const topicId = created.topic.id;
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  await flow.ian.conn.request('file.write', { file: { root: MAIN_ROOT, path: SPEC_PATH }, content: bytes(SPEC) });
  await flow.ian.conn.request('file.write', { file: { root: MAIN_ROOT, path: PLAN_PATH }, content: bytes(planText(items)) });
  await waitFor(async () => (await planOf(flow, topicId))?.items.length === items.length, { what: 'the plan to parse' });
  for (const item of items) await flow.mei.conn.request('plan.assign', { topicId, itemId: item.id, userId: item.id === 'receipt-email' ? IAN : MEI });
  const { preflight } = await flow.mei.conn.request('plan.preflight', { topicId });
  expect(preflight.merging).toMatchObject({ workspace: 'auto', proposed: 'auto' });
  const at = Date.now();
  await flow.mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash });
  return { topicId, at };
}

/** Nothing waits for anybody: no report to review, no merge for the host, nothing amber. */
async function nobodyIsAsked(flow: Flow): Promise<void> {
  for (const person of [flow.ian, flow.mei, flow.amy, flow.leo]) {
    const items = await person.inbox();
    expect(items.filter((entry) => entry.kind === 'report' || entry.kind === 'merge' || entry.waiting), person.name).toEqual([]);
  }
}

const CLEAN: FakeClaudeStep[][] = [
  [write('src/cart/total.ts', 'export const total = 1;\n'), ...handIn('cart-api', 'Cart API')],
  [write('src/receipt/send.ts', 'export const send = 1;\n'), ...handIn('receipt-email', 'Receipt email')],
  [write('src/checkout/page.ts', 'export const page = 1;\n'), ...handIn('checkout-page', 'Checkout page')],
];

describe('0.7.0 acceptance: a plan runs to its end by itself (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('M1 walk away after Start: every item merges by itself, what waited starts from the merged state, nobody is asked anything', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: CLEAN[0] as FakeClaudeStep[] },
        { match: 'Start work item 2 ', steps: CLEAN[1] as FakeClaudeStep[] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId, at } = await started(flow);
    for (const id of ['cart-api', 'receipt-email', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    const took = Date.now() - at;
    // Everything is in the folder; the dependent item was started from the merged state.
    expect(await inMain(flow, 'src/cart/total.ts')).toBe('export const total = 1;\n');
    expect(await inMain(flow, 'src/receipt/send.ts')).toBe('export const send = 1;\n');
    expect(await inMain(flow, 'src/checkout/page.ts')).toBe('export const page = 1;\n');
    const page = await itemOf(flow, topicId, 'checkout-page');
    expect(Buffer.from((await flow.ian.conn.request('file.read', { file: { root: { kind: 'worktree', worktreeId: page.worktreeId as string }, path: 'src/cart/total.ts' } })).content).toString('utf8')).toBe('export const total = 1;\n');
    // Each merge is the host's standing consent applied by smurg: author Ian, committer smurg, the trailer.
    const log = (await flow.git(['log', '--merges', '--format=%an|%cn|%(trailers:key=Merged-by,valueonly,separator=;)'])).split('\n').filter(Boolean);
    expect(log).toHaveLength(3);
    for (const line of log) expect(line).toBe("Ian|smurg|smurg (automatic merging, the host's setting)");
    const merges = (await audited(flow, 'worktree.merge.auto')).filter((entry) => entry.outcome === 'ok');
    expect(merges.map((entry) => [entry.actor.kind, entry.detail?.['consent'], entry.detail?.['onBehalfOf']])).toEqual([
      ['system', 'host-setting', IAN],
      ['system', 'host-setting', IAN],
      ['system', 'host-setting', IAN],
    ]);
    // Nobody pressed anything, and nobody is asked anything: the reviews are marks, the merges are done.
    expect(await audited(flow, 'report.review', 'worktree.merge.approve')).toEqual([]);
    await nobodyIsAsked(flow);
    const topic = (await flow.leo.conn.request('topic.list', {})).topics.find((candidate) => candidate.id === topicId);
    expect(topic?.plan).toMatchObject({ items: 3, started: 3, merged: 3, reviewed: 0 });
    // (0.6.0: after Start the plan stopped, 1.2 s later, until six presses; here it is merged whole in seconds)
    expect(took).toBeLessThan(120_000);
  });

  it('M8 each clean, complete item merges as soon as its report is in, the oldest report first', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    // The second item takes a moment longer, so the order of the reports is known.
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: CLEAN[0] as FakeClaudeStep[] },
        { match: 'Start work item 2 ', steps: [{ sleep: 1_500 }, ...(CLEAN[1] as FakeClaudeStep[])] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    for (const id of ['cart-api', 'receipt-email', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    const plan = await planOf(flow, topicId);
    const times = plan.items.map((item) => ({ id: item.id, report: item.report?.writtenAt ?? 0, merged: item.merged?.at ?? 0 }));
    const order = (key: 'report' | 'merged'): string[] => [...times].sort((a, b) => a[key] - b[key]).map((item) => item.id);
    expect(order('merged')).toEqual(order('report'));
    for (const item of times) expect(item.merged - item.report, item.id).toBeLessThan(30_000);
  });

  it('M9 the host is not online: everything that is in order merges all the same, on the host\'s standing consent', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: CLEAN[0] as FakeClaudeStep[] },
        { match: 'Start work item 2 ', steps: CLEAN[1] as FakeClaudeStep[] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    flow.ian.client.close();
    for (const id of ['cart-api', 'receipt-email', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    const log = (await flow.git(['log', '--merges', '--format=%an|%cn'])).split('\n').filter(Boolean);
    expect(log).toEqual(['Ian|smurg', 'Ian|smurg', 'Ian|smurg']);
  });

  it('M2 two items change the same line: the second is brought up to date by smurg, its own agent resolves and verifies, and it merges; nobody is asked', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    const both = 'export const title = "Bookshop with a cart and receipts";\n';
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [write('src/app.ts', 'export const title = "Bookshop with a cart";\n'), ...handIn('cart-api', 'Cart API')] },
        { match: 'Start work item 2 ', steps: [write('src/app.ts', 'export const title = "Bookshop with receipts";\n'), ...handIn('receipt-email', 'Receipt email')] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        // Whichever is merged second resolves (the message names the one merged before it).
        { match: 'merged before yours: 1 \\(id cart-api\\)', steps: [write('src/app.ts', both), ...handIn('receipt-email', 'Receipt email', 'The receipt, and both titles.')] },
        { match: 'merged before yours: 2 \\(id receipt-email\\)', steps: [write('src/app.ts', both), ...handIn('cart-api', 'Cart API', 'The cart, and both titles.')] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    for (const id of ['cart-api', 'receipt-email', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    expect(await inMain(flow, 'src/app.ts')).toBe(both);
    // One of them conflicted once, and was brought up to date and resolved by its own agent (no person asked it).
    const tries = (await audited(flow, 'worktree.merge.auto')).filter((entry) => entry.outcome === 'error' && entry.detail?.['reason'] === 'conflict');
    expect(tries).toHaveLength(1);
    const resolved = tries[0]?.detail?.['itemId'] as string;
    const sessionId = (await itemOf(flow, topicId, resolved)).sessionId as string;
    expect(await told(flow, sessionId)).toEqual(expect.arrayContaining([expect.stringContaining('These files have conflict markers: ["src/app.ts"]. Other work items were merged before yours:')]));
    expect((await itemOf(flow, topicId, resolved)).report?.version).toBe(2);
    expect(await audited(flow, 'plan.item.resolve', 'worktree.merge.approve', 'report.review')).toEqual([]);
    await nobodyIsAsked(flow);
  });

  it('M14 a resolve turn that only rewrites the report is asked once to verify again, and merges after a turn that checks it', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    const both = 'export const title = "Bookshop with a cart and receipts";\n';
    // The resolving agent writes the same report again and does not check it: that version was checked before its change.
    const unchecked = (id: string, title: string): FakeClaudeStep[] => [write('src/app.ts', both), { tool: 'Write', input: { file_path: reportPath(id), content: report(id, title) } }, { text: 'Resolved.' }];
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [write('src/app.ts', 'export const title = "Bookshop with a cart";\n'), ...handIn('cart-api', 'Cart API')] },
        { match: 'Start work item 2 ', steps: [write('src/app.ts', 'export const title = "Bookshop with receipts";\n'), ...handIn('receipt-email', 'Receipt email')] },
        { match: 'merged before yours: 1 \\(id cart-api\\)', steps: unchecked('receipt-email', 'Receipt email') },
        { match: 'merged before yours: 2 \\(id receipt-email\\)', steps: unchecked('cart-api', 'Cart API') },
        { match: 'Verify again', steps: [PNPM_TEST, { tool: 'mcp__smurg__check_report', input: {} }, { text: 'Checked again.' }] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow, THREE.slice(0, 2));
    for (const id of ['cart-api', 'receipt-email']) await mergedBySmurg(flow, topicId, id);
    expect(await inMain(flow, 'src/app.ts')).toBe(both);
    const resolved = (await audited(flow, 'worktree.merge.auto')).find((entry) => entry.outcome === 'error' && entry.detail?.['reason'] === 'conflict')?.detail?.['itemId'] as string;
    const sessionId = (await itemOf(flow, topicId, resolved)).sessionId as string;
    const said = await told(flow, sessionId);
    expect(said.filter((text) => text.includes('You changed files after your report was last checked. Verify again'))).toHaveLength(1);
    await nobodyIsAsked(flow);
  });

  it('M14 a turn asked to verify again that does not check its report is a decision for the item\'s carers, and nothing of it merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    const both = 'export const title = "Bookshop with a cart and receipts";\n';
    const unchecked = (id: string, title: string): FakeClaudeStep[] => [write('src/app.ts', both), { tool: 'Write', input: { file_path: reportPath(id), content: report(id, title) } }, { text: 'Resolved.' }];
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [write('src/app.ts', 'export const title = "Bookshop with a cart";\n'), ...handIn('cart-api', 'Cart API')] },
        { match: 'Start work item 2 ', steps: [write('src/app.ts', 'export const title = "Bookshop with receipts";\n'), ...handIn('receipt-email', 'Receipt email')] },
        { match: 'merged before yours: 1 \\(id cart-api\\)', steps: unchecked('receipt-email', 'Receipt email') },
        { match: 'merged before yours: 2 \\(id receipt-email\\)', steps: unchecked('cart-api', 'Cart API') },
        { match: 'Verify again', steps: [{ text: 'It is fine as it is.' }] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow, THREE.slice(0, 2));
    await waitFor(async () => (await planOf(flow, topicId)).items.some((item) => item.autoMerge?.reason === 'stale-report' && item.autoMerge.state === 'held'), { timeoutMs: 60_000, what: 'the hold' });
    const held = (await planOf(flow, topicId)).items.find((item) => item.autoMerge?.state === 'held') as WorkItem;
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stale-report', hostOnly: false });
    expect(held.merged).toBeUndefined();
    expect(await inMain(flow, 'src/app.ts')).not.toBe(both);
    expect((await audited(flow, 'worktree.merge.held')).map((entry) => entry.detail?.['reason'])).toEqual(['stale-report']);
  });

  it('M16 smurg host restarts in the middle of a resolve turn: the resolve is asked again after the restart\'s line, no new try, and it merges with nobody asked', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    const both = 'export const title = "Bookshop with a cart and receipts";\n';
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [write('src/app.ts', 'export const title = "Bookshop with a cart";\n'), ...handIn('cart-api', 'Cart API')] },
        { match: 'Start work item 2 ', steps: [write('src/app.ts', 'export const title = "Bookshop with receipts";\n'), ...handIn('receipt-email', 'Receipt email')] },
        // The first resolve turn is still working when the host's smurg stops.
        { match: 'merged before yours', once: true, steps: [{ sleep: 60_000 }, { text: 'never' }] },
        { match: 'merged before yours: 1 \\(id cart-api\\)', steps: [write('src/app.ts', both), ...handIn('receipt-email', 'Receipt email', 'Both titles.')] },
        { match: 'merged before yours: 2 \\(id receipt-email\\)', steps: [write('src/app.ts', both), ...handIn('cart-api', 'Cart API', 'Both titles.')] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow, THREE.slice(0, 2));
    await waitFor(async () => (await planOf(flow, topicId)).items.some((item) => item.autoMerge?.state === 'resolving'), { timeoutMs: 60_000, what: 'one item to resolve' });
    const resolving = (await planOf(flow, topicId)).items.find((item) => item.autoMerge?.state === 'resolving') as WorkItem;
    const sessionId = resolving.sessionId as string;
    await waitFor(async () => (await told(flow, sessionId)).some((text) => text.includes('merged before yours')), { timeoutMs: 30_000, what: 'the resolve message' });
    expect(resolving.autoMerge).toMatchObject({ reason: 'conflict', tries: 1 });
    await flow.restart();
    for (const id of ['cart-api', 'receipt-email']) await mergedBySmurg(flow, topicId, id);
    expect(await inMain(flow, 'src/app.ts')).toBe(both);
    // The restart's line, then the same request again; still one try.
    await flow.leo.watch(sessionId);
    expect(flow.leo.events(sessionId).some((event) => event.kind === 'line' && event.text.id === 'conversation.continued.restart')).toBe(true);
    expect((await told(flow, sessionId)).filter((text) => text.includes('merged before yours'))).toHaveLength(2);
    expect((await audited(flow, 'worktree.merge.auto')).filter((entry) => entry.outcome === 'error' && entry.detail?.['reason'] === 'conflict')).toHaveLength(1);
    await nobodyIsAsked(flow);
  });
});

describe('0.7.0 acceptance: a conflict with a person\'s change is a person\'s decision (smurg\'s own history)', { timeout: 300_000 }, () => {
  it('M13 Amy saves a change of the line an item also changes: the item is held for its carers with her name, and nothing of it merges', async () => {
    const flow = await startFlow({ files: { 'README.md': '# Shop\n', 'config.txt': 'title: Shop\nprice: 10\nfooter: (c) 2026\n' }, git: false, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        // The agent works for a moment (Amy saves her change meanwhile), then changes the price line too.
        { match: 'Start work item 1 ', steps: [{ sleep: 2_000 }, write('config.txt', 'title: Shop\nprice: 12\nfooter: (c) 2026\n'), ...handIn('cart-api', 'Cart API')] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow, THREE.slice(0, 1));
    await itemIs(flow, topicId, 'cart-api', (item) => item.state === 'running', 'the item to run');
    const amys = 'title: Shop\nprice: 15 (Amy: agreed with the client)\nfooter: (c) 2026\n';
    await flow.amy.conn.request('file.write', { file: { root: MAIN_ROOT, path: 'config.txt' }, content: new TextEncoder().encode(amys) });
    const held = await itemIs(flow, topicId, 'cart-api', (item) => item.autoMerge?.state === 'held', 'the item to be held');
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'conflict', tries: 0, hostOnly: false, people: [{ path: 'config.txt', by: [{ userId: AMY, displayName: 'Amy' }], outside: false }] });
    expect(held.merged).toBeUndefined();
    expect(await inMain(flow, 'config.txt')).toBe(amys);
    const entry = (await audited(flow, 'worktree.merge.held'))[0];
    expect(entry?.detail).toMatchObject({ itemId: 'cart-api', reason: 'conflict', people: [{ path: 'config.txt', by: [AMY], outside: false }], tries: 0 });
    // smurg did not ask the agent to resolve over her line.
    expect((await told(flow, held.sessionId as string)).some((text) => text.includes('conflict markers'))).toBe(false);
  });
});
