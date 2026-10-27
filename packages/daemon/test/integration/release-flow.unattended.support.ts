// The shared plan, people and helpers of the 0.7.0 acceptance test of a plan that runs by itself (DESIGN 0.7.0 D22),
// whose cases are two files that vitest runs side by side (0.7.0 verify: one file of 19 cases took 356 to 522 s under
// load, close to the gate's 10-minute part): release-flow.unattended.test.ts (the merge queue S3, keeping it running
// S6) and release-flow.unattended-decisions.test.ts (what needs a person, and the end: S4).
import { expect } from 'vitest';
import { MAIN_ROOT, type PlanInfo, type WorkItem } from '@smurg/protocol';
import type { FakeClaudeStep } from '../../src/testing/index.ts';
import { AMY, IAN, MEI, inboxItem, inboxWithout, waitFor, type Flow } from './release-flow.support.ts';

export const SLUG = 'checkout';
export const SPEC_PATH = `specs/${SLUG}/SPEC.md`;
export const PLAN_PATH = `specs/${SLUG}/PLAN.md`;
export const reportPath = (id: string): string => `specs/${SLUG}/reports/${id}.md`;

export const SPEC = ['# Checkout', '', '## Goal', 'Buying a book takes one page.', '', '## Decisions', '- Cards only.', '', '## Scope', 'Cart, receipt, page.', '', '## Out of scope', 'Invoices.', '', '## Behaviour', 'One page.', '', '## Open questions', 'None.', ''].join('\n');

export interface PlanItemText {
  readonly id: string;
  readonly title: string;
  readonly touches: string;
  readonly dependsOn?: string;
}
export const THREE: readonly PlanItemText[] = [
  { id: 'cart-api', title: 'Cart API', touches: 'src/cart/**' },
  { id: 'receipt-email', title: 'Receipt email', touches: 'src/receipt/**' },
  { id: 'checkout-page', title: 'Checkout page', touches: 'src/checkout/**', dependsOn: 'cart-api' },
];
export function planText(items: readonly PlanItemText[]): string {
  const body = items.flatMap((item, index) => [`### ${index + 1}. ${item.title}`, `- id: ${item.id}`, ...(item.dependsOn === undefined ? [] : [`- depends on: ${item.dependsOn}`]), '- size: m', `- touches: ${item.touches}`, '', `The ${item.title}.`, '']);
  return ['# Plan: Checkout', '', '<!-- smurg:plan v1 -->', '', ...body, '<!-- smurg:plan end -->', ''].join('\n');
}

export function report(id: string, title: string, done = `The work of ${title}.`, outcome: 'complete' | 'partial' = 'complete'): string {
  return [
    `# Result report: ${title}`,
    '',
    `<!-- smurg:report v1 item=${id} -->`,
    `- outcome: ${outcome}`,
    '',
    '## What was done',
    done,
    '',
    '## Why it was done this way',
    'As the spec decided.',
    '',
    '## How it was verified',
    '- [x] `pnpm test`: 3 tests passed',
    ...(outcome === 'complete' ? [] : ['- [ ] Manual check in the browser: not verified: no browser in this session']),
    '',
    '## What to watch out for',
    'Nothing special.',
    '',
  ].join('\n');
}

export const PNPM_TEST: FakeClaudeStep = { tool: 'Bash', input: { command: 'pnpm test' }, result: '3 tests passed' };
export const handIn = (id: string, title: string, done?: string): FakeClaudeStep[] => [
  PNPM_TEST,
  { tool: 'Write', input: { file_path: reportPath(id), content: report(id, title, done) } },
  { tool: 'mcp__smurg__check_report', input: {} },
  { text: `${title} is done.` },
];
export const write = (path: string, content: string): FakeClaudeStep => ({ tool: 'Write', input: { file_path: path, content } });

// 0.6.0's default for a new workspace is auto mode, and 0.7.0's merges by itself (release-flow.support.ts says the
// host's merge and "asks before commands" for the stories of 0.6.0).
export const UNATTENDED = { settings: { permissionMode: 'auto' as const, merging: 'auto' as const } };
export const APP_BEFORE = 'export const title = "Bookshop";\n';
export const FILES = { 'README.md': '# Bookshop\n', 'src/app.ts': APP_BEFORE };

export const planOf = async (flow: Flow, topicId: string): Promise<PlanInfo> => (await flow.leo.conn.request('plan.get', { topicId })).plan as PlanInfo;
export const itemOf = async (flow: Flow, topicId: string, id: string): Promise<WorkItem> => (await planOf(flow, topicId)).items.find((candidate) => candidate.id === id) as WorkItem;
export async function itemIs(flow: Flow, topicId: string, id: string, fits: (item: WorkItem) => boolean, what: string, timeoutMs = 60_000): Promise<WorkItem> {
  await waitFor(async () => fits(await itemOf(flow, topicId, id)), { timeoutMs, what });
  return itemOf(flow, topicId, id);
}
export const mergedBySmurg = (flow: Flow, topicId: string, id: string): Promise<WorkItem> => itemIs(flow, topicId, id, (item) => item.merged?.by === 'smurg', `smurg to merge ${id}`);
export const inMain = async (flow: Flow, path: string): Promise<string> => Buffer.from((await flow.ian.conn.request('file.read', { file: { root: MAIN_ROOT, path } })).content).toString('utf8');

/** Mei creates the topic, Ian writes its spec and plan, Mei assigns and presses Start. Returns the topic and when Start was pressed. */
export async function started(flow: Flow, items: readonly PlanItemText[] = THREE): Promise<{ topicId: string; at: number }> {
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
export async function nobodyIsAsked(flow: Flow): Promise<void> {
  for (const person of [flow.ian, flow.mei, flow.amy, flow.leo]) {
    const items = await person.inbox();
    expect(items.filter((entry) => entry.kind === 'report' || entry.kind === 'merge' || entry.waiting), person.name).toEqual([]);
  }
}

export const CLEAN: FakeClaudeStep[][] = [
  [write('src/cart/total.ts', 'export const total = 1;\n'), ...handIn('cart-api', 'Cart API')],
  [write('src/receipt/send.ts', 'export const send = 1;\n'), ...handIn('receipt-email', 'Receipt email')],
  [write('src/checkout/page.ts', 'export const page = 1;\n'), ...handIn('checkout-page', 'Checkout page')],
];

/** Nobody waits for anything any more, and every member, Viewers included, is told the topic is ready to check. */
export async function readyForEveryone(flow: Flow, topicId: string): Promise<void> {
  for (const person of [flow.ian, flow.mei, flow.amy, flow.leo]) await inboxItem(person, (entry) => entry.kind === 'ready' && entry.topicId === topicId, 'the topic ready to check', 60_000);
  const row = (await flow.leo.inbox()).find((entry) => entry.kind === 'ready');
  expect(row).toMatchObject({ waiting: false, target: { kind: 'result', topicId }, excerpt: 'Checkout' });
  for (const person of [flow.ian, flow.mei, flow.amy, flow.leo]) expect((await person.inbox()).filter((entry) => entry.waiting), person.name).toEqual([]);
}

/** Amy checks the result: the topic is complete, and the ready rows leave. */
export async function checked(flow: Flow, topicId: string): Promise<void> {
  const { topic } = await flow.amy.conn.request('topic.check', { topicId });
  expect(topic).toMatchObject({ phase: 'complete', checked: { by: { userId: AMY } } });
  await inboxWithout(flow.leo, (entry) => entry.kind === 'ready', 'the ready row');
}

export const Q = { question: 'Which payment provider?', header: 'Provider', multiSelect: false, options: [{ label: 'Cards', description: 'Plain.' }, { label: 'A wallet', description: 'More work.' }] };
