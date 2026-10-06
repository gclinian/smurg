// T topics flow (docs/ACCEPTANCE.md "T topics flow"; DESIGN §9.3 P12), through the REAL relay: the release composition
// of the daemon on a real git repository, the real `smurg hook` / `smurg mcp` commands, the scripted stand-in for
// Claude Code (never a `claude` of this computer), and SDK clients for Ian (Host), Mei (Agent access), Amy (Editor),
// Leo (Viewer) and Noa (Agent access, who joins late).
//
// What each step of the topic does is proven where the modules meet (packages/daemon/test/integration/
// release-flow.*.test.ts, whose scenarios this file reuses). Here the point is what CROSSES THE WIRE:
//
//   - every member's client ends with the same picture: conversations, cards, topic, plan, sessions (`agree`);
//   - a member who reloads, a member who joins late and a client that was behind catch up with `session.watch`,
//     `session.history` and `session.cards.get`, the inbox and the lists, to exactly what the others hold;
//   - a restart of the host's smurg is survived by the clients: the same connections come back by themselves and
//     continue from what they hold, open cards are withdrawn at every client, "Continue all" goes on;
//   - nothing of it is readable at the relay, no frame comes near the relay's limit, and the number of frames the
//     whole flow sends through the relay is measured (DESIGN §9.5 item 6).
//
// The steps are ONE story in order: each `it` continues where the one before stopped.
import { randomBytes } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS_PAGE_MAX_BYTES, MAX_RELAY_FRAME, type AgentSession, type ConversationEvent, type PlanInfo } from '@smurg/protocol';
import type { FakeClaudeScenario, FakeClaudeStep } from '@smurg/daemon/testing';
import { findPlaintext } from '@smurg/relay/testing';
import {
  agentSessions,
  audited,
  comparableSession,
  eventOf,
  everythingAgentsReceived,
  inboxItem,
  inboxWithout,
  itemOf,
  kinds,
  launches,
  member,
  permissionAt,
  planIs,
  questionAt,
  refusal,
  sessionReady,
  statusIs,
  suggestionAt,
  told,
  topicIs,
  turnsFinished,
  type Member,
  type Picture,
} from '../src/flow.ts';
import { startStack, waitUntil, type Stack } from '../src/harness.ts';

const SLUG = 'checkout';
const SPEC_PATH = `specs/${SLUG}/SPEC.md`;
const PLAN_PATH = `specs/${SLUG}/PLAN.md`;
const reportPath = (itemId: string): string => `specs/${SLUG}/reports/${itemId}.md`;

/** A unique marker of well over 16 bytes (shorter ones occur in ciphertext by chance): text the relay must never be able to read. */
const marker = (label: string): string => `smurg-flow-${label}-${randomBytes(12).toString('hex')}`;
const M = {
  toAgent: marker('MESSAGE-TO-AGENT'),
  agentText: marker('AGENT-TEXT'),
  question: marker('QUESTION'),
  comment: marker('COMMENT'),
  note: marker('NOTE'),
  spec: marker('SPEC'),
  suggestion: marker('SUGGESTION'),
  command: marker('COMMAND'),
  report: marker('REPORT'),
  longNotes: marker('LONG-NOTES'),
};

const APP_BEFORE = 'export const title = "Bookshop";\n';
const APP_BY_CART = 'export const title = "Bookshop with a cart";\n';
const APP_BY_RECEIPT = 'export const title = "Bookshop with receipts";\n';
const APP_RESOLVED = 'export const title = "Bookshop with a cart and receipts";\n';

const SPEC = ['# Checkout', '', '## Goal', `Buying a book takes one page. ${M.spec}`, '', '## Decisions', '- Payment: cards only.', '', '## Out of scope', 'Invoices.', '', '## Open questions', 'None.', ''].join('\n');
const SPEC_REVISED = SPEC.replace('Invoices.', 'Invoices. Coupons.');
const PLAN = [
  '# Plan: Checkout',
  '',
  'Three work items. 1 and 3 can start at once; 2 needs 1.',
  '',
  '<!-- smurg:plan v1 -->',
  '',
  '### 1. Cart API',
  '- id: cart-api',
  '- size: m',
  '- touches: src/cart/**',
  '',
  'Compute the total in one module.',
  '',
  '### 2. Checkout page',
  '- id: checkout-page',
  '- depends on: cart-api',
  '- size: l',
  '- touches: src/checkout/**',
  '',
  'Put cart and payment on one page.',
  '',
  '### 3. Receipt email',
  '- id: receipt-email',
  '- size: s',
  '- touches: src/receipt/**',
  '',
  'Send a receipt after the payment.',
  '',
  '<!-- smurg:plan end -->',
  '',
].join('\n');

function report(itemId: string, title: string, outcome: 'complete' | 'partial', extra = ''): string {
  return [
    `# Result report: ${title}`,
    '',
    `<!-- smurg:report v1 item=${itemId} -->`,
    `- outcome: ${outcome}`,
    '',
    '## What was done',
    `The work of ${title}.${extra}`,
    '',
    '## Why it was done this way',
    'As the spec decided.',
    '',
    '## How it was verified',
    '- [x] `pnpm test`: 3 tests passed',
    ...(outcome === 'partial' ? ['- [ ] Manual check in the browser: not verified: no browser in this session'] : []),
    '',
    '## What to watch out for',
    outcome === 'partial' ? 'The page was never opened in a browser.' : 'Nothing special.',
    '',
  ].join('\n');
}
const reportSteps = (itemId: string, title: string, outcome: 'complete' | 'partial', extra = ''): FakeClaudeStep[] => [
  { tool: 'Write', input: { file_path: reportPath(itemId), content: report(itemId, title, outcome, extra) } },
  { tool: 'mcp__smurg__check_report', input: {} },
  { text: `${title} is done.` },
];

const PAYMENT = { question: `How do people pay? ${M.question}`, header: 'Payment', multiSelect: false, options: [{ label: 'Cards only', description: 'One provider.' }, { label: 'Cards and invoices', description: 'More work.' }] };
const PNPM_TEST: FakeClaudeStep = { tool: 'Bash', input: { command: `pnpm test --tag ${M.command}` }, suggest: { toolName: 'Bash', ruleContent: 'pnpm test *' }, result: '3 tests passed' };

/** A long conversation: blocks of about 150 KiB each, more than one page of them (the page rule is 2 MiB). */
const LONG_BLOCKS = 16;
const LONG_BLOCK_CHARS = 150 * 1024;
function longBlock(index: number): string {
  const lines: string[] = [`Notes, part ${index + 1} of ${LONG_BLOCKS}. ${index === 0 ? M.longNotes : ''}`];
  let size = lines[0]?.length ?? 0;
  for (let line = 0; size < LONG_BLOCK_CHARS; line++) {
    const text = `Part ${index + 1}, line ${line}: the checkout keeps the cart, the payment and the receipt on one page.`;
    lines.push(text);
    size += text.length + 1;
  }
  return lines.join('\n');
}

/**
 * What the "model" does. A turn is chosen by a pattern on the message smurg (or a person) sent; `onContinue` is what a
 * work item's session does when smurg tells it to go on (it differs per phase of the story, so the story swaps it).
 */
function scenario(onContinue: FakeClaudeStep[], extra: NonNullable<FakeClaudeScenario['turns']> = []): FakeClaudeScenario {
  return {
    turns: [
      ...extra,
      // ---- the discussion
      { match: 'one page', once: true, steps: [{ tool: 'AskUserQuestion', input: { questions: [PAYMENT] } }, { tool: 'Write', input: { file_path: SPEC_PATH, content: SPEC } }, { text: `The first draft of the spec is ready. ${M.agentText}` }] },
      { match: 'coupons', steps: [{ tool: 'Edit', input: { file_path: SPEC_PATH, old_string: 'Invoices.', new_string: 'Invoices. Coupons.' } }, { text: 'Coupons are out of scope now.' }] },
      { match: 'Then call check_plan', steps: [{ tool: 'Write', input: { file_path: PLAN_PATH, content: PLAN } }, { tool: 'mcp__smurg__check_plan', input: {} }, { text: 'The plan has three work items.' }] },
      // ---- work item 1: edits in its worktree, then a command that asks (and waits for a person)
      {
        match: 'Start work item 1 ',
        steps: [
          { tool: 'Write', input: { file_path: 'src/cart/total.ts', content: 'export const total = (prices: number[]): number => prices.reduce((a, b) => a + b, 0);\n' } },
          { tool: 'Edit', input: { file_path: 'src/app.ts', old_string: APP_BEFORE, new_string: APP_BY_CART } },
          PNPM_TEST,
          ...reportSteps('cart-api', 'Cart API', 'partial', ` ${M.report}`),
        ],
      },
      // ---- work item 2 (starts when 1 is merged): the same kind of command is not asked any more
      { match: 'Start work item 2 ', steps: [PNPM_TEST, { tool: 'Write', input: { file_path: 'src/checkout/page.ts', content: 'export const page = "checkout";\n' } }, ...reportSteps('checkout-page', 'Checkout page', 'complete')] },
      // ---- work item 3: stops without a report, twice
      { match: 'Start work item 3 ', steps: [{ tool: 'Edit', input: { file_path: 'src/app.ts', old_string: APP_BEFORE, new_string: APP_BY_RECEIPT } }, { text: 'I changed the title.' }] },
      { match: 'You stopped without the result report', steps: [{ text: 'I am not sure what is missing.' }] },
      { match: 'Continue the work item', steps: onContinue },
      { match: 'conflict markers', steps: [{ tool: 'Write', input: { file_path: 'src/app.ts', content: APP_RESOLVED } }, ...reportSteps('receipt-email', 'Receipt email', 'complete', ' The title names both now.')] },
      { steps: [{ text: 'ok' }] },
    ],
  };
}
const CART_GOES_ON: FakeClaudeStep[] = [PNPM_TEST, ...reportSteps('cart-api', 'Cart API', 'partial', ` ${M.report}`)];
const RECEIPT_GOES_ON: FakeClaudeStep[] = [PNPM_TEST, ...reportSteps('receipt-email', 'Receipt email', 'complete')];

/** Every file and folder under `dir` with its size and the time it was last written, sorted: equal lists = nothing was written. */
async function onDisk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name);
      const stat = await lstat(full);
      out.push(`${full.slice(dir.length)} ${stat.isDirectory() ? 'dir' : stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) await walk(full);
    }
  };
  await walk(dir);
  return out;
}

/** What two members must agree on, small enough to compare every 50 ms (a conversation by its length and last event). */
function outline(picture: Picture): string {
  return JSON.stringify({ ...picture, conversations: Object.fromEntries(Object.entries(picture.conversations).map(([id, events]) => [id, `${events.length} events, last ${JSON.stringify(events.at(-1) ?? null).length} bytes at seq ${events.at(-1)?.seq ?? 0}`])) });
}

/**
 * Every member holds the same picture as the first one (after what is on its way has arrived): the conversations
 * event for event, every card in its newest state, the topic, the plan, the sessions.
 */
async function agree(members: readonly Member[], what: string): Promise<void> {
  const [first, ...others] = members as [Member, ...Member[]];
  for (const one of members) await one.settled();
  await waitUntil(() => others.every((other) => outline(other.picture()) === outline(first.picture())), 20_000, `${members.map((one) => one.name).join(', ')} to hold the same picture ${what}`).catch(() => {});
  // (The first difference by its path: a diff of two pictures with megabytes of conversation in them says nothing.)
  for (const other of others) expect(firstDifference(other.picture(), first.picture(), other.name, first.name), `${other.name} holds what ${first.name} holds ${what}`).toBeNull();
}

/** Where two values differ first, as a sentence; null when they are equal (an absent property equals an undefined one). */
function firstDifference(a: unknown, b: unknown, nameA: string, nameB: string, path = 'picture'): string | null {
  if (Object.is(a, b)) return null;
  const short = (value: unknown): string => {
    const json = JSON.stringify(value) ?? String(value);
    return json.length > 300 ? `${json.slice(0, 300)}… (${json.length} characters)` : json;
  };
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return `${path}: ${nameA} has ${short(a)}, ${nameB} has ${short(b)}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      const inner = firstDifference(a[index], b[index], nameA, nameB, `${path}[${index}]`);
      if (inner !== null) return inner;
    }
    return a.length === b.length ? null : `${path}: ${nameA} has ${a.length} entries, ${nameB} has ${b.length}; the first one more is ${short(a.length > b.length ? a[b.length] : b[a.length])}`;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const inner = firstDifference(left[key], right[key], nameA, nameB, `${path}.${key}`);
    if (inner !== null) return inner;
  }
  return null;
}

describe('T topics flow: one topic through the real relay, five SDK clients and the stand-in claude', { timeout: 240_000 }, () => {
  let stack: Stack;
  let ian: Member;
  let mei: Member;
  let amy: Member;
  let leo: Member;
  let noa: Member;
  let startedAt = 0;
  let failed = false;
  // What the story names as it goes.
  let topicId = '';
  let discussionId = '';
  let cartId = '';
  let receiptId = '';
  let pageId = '';
  let notesId = '';
  let amySuggestionId = '';
  let cartRequestId = '';
  let longConversation = { received: 0, receivedBytes: 0 };
  /** Connections this story closed on purpose (a reload): every other one must still be the one it began with. */
  const closedOnPurpose: Member[] = [];

  /** A step of the story: it needs the steps before it. */
  const step = (title: string, body: () => Promise<void>, timeoutMs?: number): void => {
    it(title, { ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) }, async () => {
      expect(failed, 'an earlier step of the story failed: this one cannot run on its own').toBe(false);
      failed = true;
      await body();
      failed = false;
    });
  };
  const text = (path: string, root = stack.root): Promise<string> => readFile(join(root, path), 'utf8');
  const everyone = (): Member[] => [ian, mei, amy, leo];

  beforeAll(async () => {
    stack = await startStack({
      git: true,
      hostLogin: 'ian',
      projectFiles: { 'README.md': '# Bookshop\n', 'src/app.ts': APP_BEFORE },
      claude: scenario(CART_GOES_ON),
      // How many work items may hold an agent process at once defaults from the machine's memory (2 on a small one):
      // fixed, so the same sessions run on every machine.
      settings: { maxLiveAgents: 8 },
    });
    startedAt = Date.now();
    ian = member(stack.hostClient, 'Ian', 'host');
    mei = member(await stack.join({ name: 'mei', role: 'agent' }), 'Mei', 'agent');
    amy = member(await stack.join({ name: 'amy', role: 'editor' }), 'Amy', 'editor');
    leo = member(await stack.join({ name: 'leo', role: 'viewer' }), 'Leo', 'viewer');
    for (const one of everyone()) await one.sync();
  });

  afterAll(async () => {
    await stack?.stop();
  });

  step('a topic from its creation to its plan: the discussion, a question with votes and a comment, the spec, a revision an Editor asked for, the plan: the same at every client', async () => {
    expect(await refusal(amy.conn.request('topic.create', { name: 'Mine' }))).toMatchObject({ code: 'forbidden' });
    const created = await mei.conn.request('topic.create', { name: 'Checkout', firstMessage: `We want the checkout on one page. ${M.toAgent}` });
    topicId = created.topic.id;
    discussionId = created.session.id;
    expect(created.topic).toMatchObject({ name: 'Checkout', slug: SLUG, phase: 'discussing', createdBy: { userId: mei.userId }, discussionSessionId: discussionId });
    for (const one of everyone()) await one.watch(discussionId);
    for (const one of everyone()) await topicIs(one, topicId, (topic) => topic.discussionSessionId === discussionId, 'the new topic');

    // ---- the agent's question is a card at every client; votes and a comment travel as small changes
    const payment = await questionAt(leo, (question) => question.sessionId === discussionId && question.status === 'open', 'the question of the discussion');
    expect(payment).toMatchObject({ decider: { userId: mei.userId }, parts: [{ header: 'Payment', text: PAYMENT.question }] });
    for (const one of everyone()) await questionAt(one, (question) => question.id === payment.id, 'the question card');
    expect(await refusal(leo.conn.request('question.vote', { questionId: payment.id, part: 0, options: [0] }))).toMatchObject({ code: 'forbidden' });
    await ian.conn.request('question.vote', { questionId: payment.id, part: 0, options: [0] });
    await amy.conn.request('question.vote', { questionId: payment.id, part: 0, options: [1] });
    const { commentId } = await amy.conn.request('question.comment', { questionId: payment.id, text: `@Leo invoices matter to schools. ${M.comment}`, mentions: [leo.userId] });
    for (const one of everyone()) await questionAt(one, (question) => question.id === payment.id && question.votes.length === 2 && question.comments.some((comment) => comment.id === commentId), 'both votes and the comment');
    expect(await inboxItem(leo, (item) => item.kind === 'mention', 'the mention')).toMatchObject({ sessionId: discussionId, from: { kind: 'user', userId: amy.userId }, anchor: { cardId: payment.id } });
    expect(await inboxItem(mei, (item) => item.key === `question:${payment.id}`, 'the question she decides')).toMatchObject({ kind: 'question', waiting: true });
    // Nothing of the votes and the comment reached the agent; the decider's answer does.
    expect(await everythingAgentsReceived(stack.claude!)).not.toContain(M.comment);
    const { question: answered } = await mei.conn.request('question.submit', { questionId: payment.id, answers: [{ options: [0] }], note: `Keep it simple. ${M.note}` });
    expect(answered).toMatchObject({ status: 'answered', answer: { parts: [{ options: [0] }], by: { userId: mei.userId }, tally: [[1, 1, 0]] } });
    for (const one of everyone()) await questionAt(one, (question) => question.id === payment.id && question.status === 'answered', 'the answered question');

    // ---- the first draft of the spec: written by the agent on the host's computer, announced to everyone
    await turnsFinished(leo, discussionId, 1);
    await statusIs(leo, discussionId, 'idle');
    for (const one of everyone()) await topicIs(one, topicId, (topic) => topic.phase === 'spec', 'the first draft');
    expect(await text(SPEC_PATH)).toBe(SPEC);
    await eventOf(leo, discussionId, (event) => event.kind === 'pointer' && event.target === 'spec', "the spec's next-step card");
    expect(kinds(leo.events(discussionId))).toEqual(['line', 'message', 'delivery', 'delivery', 'turn.started', 'card:question', 'tool.started', 'tool.finished', 'text', 'turn.finished', 'delivery', 'pointer']);
    expect(await told(stack.claude!, discussionId)).toEqual([`[Mei · Agent access]\nWe want the checkout on one page. ${M.toAgent}`]);

    // ---- Amy (an Editor) asks for a revision: a suggestion card for everyone; accepted by Mei it is Amy's message
    const revise = await amy.conn.request('topic.revise', { topicId, target: 'spec', text: `Please say that coupons are not part of it. ${M.suggestion}` });
    if (!('suggestion' in revise)) throw new Error("an Editor's revise must be a suggestion");
    for (const one of everyone()) await suggestionAt(one, (suggestion) => suggestion.id === revise.suggestion.id && suggestion.status === 'pending', 'the suggestion card');
    expect(await inboxItem(mei, (item) => item.kind === 'suggestion', 'the revision Amy asked for')).toMatchObject({ sessionId: discussionId, from: { kind: 'user', userId: amy.userId }, alsoFor: [{ userId: ian.userId }] });
    expect(await everythingAgentsReceived(stack.claude!)).not.toContain(M.suggestion);
    expect(await refusal(amy.conn.request('suggest.accept', { suggestionId: revise.suggestion.id }))).toMatchObject({ code: 'forbidden' });
    await mei.conn.request('suggest.accept', { suggestionId: revise.suggestion.id });
    await turnsFinished(leo, discussionId, 2);
    await statusIs(leo, discussionId, 'idle');
    expect((await told(stack.claude!, discussionId)).at(-1)).toMatch(new RegExp(`^\\[Amy · Editor, suggestion accepted by Mei\\]\\n[^]*${M.suggestion}$`));
    expect(await text(SPEC_PATH)).toBe(SPEC_REVISED);
    await inboxWithout(mei, (item) => item.kind === 'suggestion', 'the accepted suggestion');

    // ---- "Generate plan"; who is responsible
    expect(await refusal(amy.conn.request('plan.generate', { topicId }))).toMatchObject({ code: 'forbidden' });
    await mei.conn.request('plan.generate', { topicId });
    await turnsFinished(leo, discussionId, 3);
    await statusIs(leo, discussionId, 'idle');
    for (const one of everyone()) await planIs(one, topicId, (plan) => plan.items.length === 3, 'the plan');
    expect(await text(PLAN_PATH)).toBe(PLAN);
    await mei.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: mei.userId });
    await mei.conn.request('plan.assign', { topicId, itemId: 'checkout-page', userId: amy.userId });
    const assigned = (await mei.conn.request('plan.assign', { topicId, itemId: 'receipt-email', userId: ian.userId })).plan;
    expect(assigned.items.map((item) => `${item.number} ${item.id} ${item.state} [${item.dependsOn.join(',')}] ${item.responsible?.displayName}`)).toEqual(['1 cart-api not-started [] Mei', '2 checkout-page not-started [cart-api] Amy', '3 receipt-email not-started [] Ian']);
    for (const one of everyone()) await planIs(one, topicId, (plan) => itemOf(plan, 'receipt-email')?.responsible?.userId === ian.userId, 'who is responsible');

    // ---- through the relay, four clients hold the same picture; and it is the one the daemon answers a fresh reader with
    await agree(everyone(), 'after the plan');
    expect((await leo.conn.request('session.watch', { sessionId: discussionId })).events).toEqual(leo.events(discussionId));
    expect((await leo.conn.request('plan.get', { topicId })).plan).toEqual(leo.plan(topicId));
    expect((await leo.conn.request('topic.list', {})).topics).toEqual([leo.topic(topicId)]);
  });

  step('Start: one session per work item in its own worktree; a permission card, an item that stops without a report and a pending suggestion reach the members they are for', async () => {
    const { preflight } = await mei.conn.request('plan.preflight', { topicId });
    expect(preflight).toMatchObject({ startsNow: ['cart-api', 'receipt-email'], waits: [{ itemId: 'checkout-page', for: ['cart-api'] }], blockers: [] });
    expect(await refusal(amy.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash }))).toMatchObject({ code: 'forbidden' });
    const started = (await mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash })).plan;
    expect(started.items.map((item) => `${item.id} ${item.state}${item.armed ? ' armed' : ''}`)).toEqual(['cart-api running', 'checkout-page waiting armed', 'receipt-email running']);
    cartId = itemOf(started, 'cart-api')?.sessionId as string;
    receiptId = itemOf(started, 'receipt-email')?.sessionId as string;
    for (const one of everyone()) for (const id of [cartId, receiptId]) await one.watch(id);
    expect(await stack.git(['log', '-1', '--format=%s%n%an'])).toBe('smurg: spec and plan of checkout\nMei');

    // ---- work item 1 edits its own checkout without a card and asks before its command: the card is at every
    // client, the inbox item at the member who is responsible for the item (and may allow)
    const asked = await permissionAt(leo, (request) => request.sessionId === cartId && request.status === 'open', 'the command of work item 1');
    cartRequestId = asked.id;
    expect(asked).toMatchObject({ tool: 'Bash', what: 'command', command: `pnpm test --tag ${M.command}`, alwaysRule: { tool: 'Bash', pattern: 'pnpm test *' } });
    for (const one of everyone()) await permissionAt(one, (request) => request.id === asked.id && request.status === 'open', 'the permission card');
    const permissionItem = await inboxItem(mei, (item) => item.key === `permission:${asked.id}`, 'the request of her item');
    expect(permissionItem).toMatchObject({ kind: 'permission', topicId, itemId: 'cart-api', sessionId: cartId, unread: true });
    expect((await ian.inbox()).some((item) => item.key === permissionItem.key)).toBe(false);
    expect(await refusal(amy.conn.request('permission.decide', { requestId: asked.id, decision: 'allow' }))).toMatchObject({ code: 'forbidden' });
    expect(await text('src/app.ts')).toBe(APP_BEFORE);

    // ---- work item 3 stops without a report: nudged once by smurg, then it needs its responsible person, Ian
    for (const one of everyone()) await planIs(one, topicId, (plan) => itemOf(plan, 'receipt-email')?.state === 'stalled', 'work item 3 stalled');
    await statusIs(leo, receiptId, 'stalled');
    // (The events of a session travel in batches, a moment after a state that says the same: wait for the events.)
    await turnsFinished(leo, receiptId, 2);
    await waitUntil(() => leo.events(receiptId).at(-1)?.kind === 'delivery', 10_000, 'the end of the second turn of work item 3');
    expect(kinds(leo.events(receiptId))).toEqual(['line', 'smurg', 'delivery', 'delivery', 'turn.started', 'tool.started', 'tool.finished', 'text', 'turn.finished', 'delivery', 'line', 'smurg', 'delivery', 'turn.started', 'text', 'turn.finished', 'delivery']);
    expect(await inboxItem(ian, (item) => item.kind === 'attention' && item.subject === 'item-stalled', 'the stalled item')).toMatchObject({ topicId, itemId: 'receipt-email', sessionId: receiptId });
    expect((await mei.inbox()).some((item) => item.kind === 'attention')).toBe(false);

    // ---- Amy writes to the discussion: a suggestion that stays pending for now (for Ian and Mei to settle)
    const { suggestion } = await amy.conn.request('suggest.create', { sessionId: discussionId, text: 'Please also think of gift cards.' });
    amySuggestionId = suggestion.id;
    for (const one of everyone()) await suggestionAt(one, (held) => held.id === suggestion.id && held.status === 'pending', "Amy's suggestion");
    const suggestionItem = await inboxItem(mei, (item) => item.kind === 'suggestion', "Amy's suggestion");
    expect(suggestionItem).toMatchObject({ sessionId: discussionId, alsoFor: [{ userId: ian.userId }] });
    // Mei has looked at both.
    mei.conn.notify('inbox.seen', { keys: [permissionItem.key, suggestionItem.key] });
    await waitUntil(async () => (await mei.inbox()).every((item) => !item.unread), 10_000, "Mei's inbox to be read");

    await agree(everyone(), 'while the work items run');
    // What each client folded from `inbox.changed` is the inbox the daemon lists for it.
    for (const one of everyone()) expect(one.inboxHeld().map((item) => `${item.key} ${item.unread}`).sort(), `${one.name}'s inbox`).toEqual((await one.inbox()).map((item) => `${item.key} ${item.unread}`).sort());
  });

  step('a member who reloads and a member who joins late read what everyone holds: the lists, the conversations with their open cards, the inbox with its marks', async () => {
    // ---- Mei reloads the page: a new connection of the same device (no invite: the pinned key), an empty client
    const before = (await mei.inbox()).map((item) => `${item.key} ${item.unread}`).sort();
    expect(before).toHaveLength(2);
    closedOnPurpose.push(mei);
    mei.client.close();
    const again = member(await mei.client.reconnect(), 'Mei', 'agent');
    expect(again.conn).not.toBe(mei.conn);
    mei = again;
    await mei.sync();
    for (const id of [discussionId, cartId, receiptId]) await mei.watch(id);
    await agree([leo, mei], 'after her reload');
    // Her open card is in the page of the watch; her inbox is as she left it, read marks included.
    expect(mei.permissions().find((request) => request.id === cartRequestId)).toMatchObject({ status: 'open' });
    expect(mei.inboxHeld().map((item) => `${item.key} ${item.unread}`).sort()).toEqual(before);

    // ---- Noa joins the workspace now, with agent access: nothing was ever sent to her
    noa = member(await stack.join({ name: 'noa', role: 'agent' }), 'Noa', 'agent');
    await noa.sync();
    expect(noa.topic(topicId)).toEqual(leo.topic(topicId));
    expect(noa.plan(topicId)).toEqual(leo.plan(topicId));
    for (const id of [discussionId, cartId, receiptId]) await noa.watch(id);
    await agree([leo, noa], 'after she joined');
    // A card that was settled long before she came is hers to read with the events that point to it.
    expect(noa.questions().map((question) => `${question.status} ${question.votes.length} votes ${question.comments.length} comment`)).toEqual(['answered 2 votes 1 comment']);
    // What waits for "the host and every member with agent access" waits for her too, from her first list on: the
    // pending suggestion in the discussion nobody is responsible for. The request of Mei's item is Mei's alone.
    expect(noa.inboxHeld().map((item) => item.kind)).toEqual(['suggestion']);
    expect(noa.inboxHeld()[0]).toMatchObject({ sessionId: discussionId, anchor: { cardId: amySuggestionId }, unread: true });
    expect((await mei.inbox()).find((item) => item.kind === 'suggestion')).toMatchObject({ unread: false, alsoFor: [{ userId: ian.userId }, { userId: noa.userId }] });
    // She has agent access, so the daemon lets her do what the role may do, like any member who was there before.
    expect(await refusal(noa.conn.request('topic.revise', { topicId, target: 'plan', text: '' }))).toMatchObject({ code: 'bad_request' });
  });

  step('a long conversation: the live batches and the pages stay far below the relay\'s frame limit; a client that was away reads forward, a late reader reads back, page by page', async () => {
    const { session } = await mei.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, title: 'Notes' });
    notesId = session.id;
    await sessionReady(ian, notesId);
    for (const one of [ian, mei, amy, leo]) await one.watch(notesId);
    // Amy looks away (her column is closed): she holds the first line only.
    amy.conn.notify('session.unwatch', { sessionId: notesId });
    const amyHad = amy.events(notesId).length;
    expect(amyHad).toBeGreaterThan(0);

    await stack.claude!.setScenario(scenario(CART_GOES_ON, [{ match: 'long notes', steps: Array.from({ length: LONG_BLOCKS }, (_, index) => ({ text: longBlock(index) })) }]));
    const framesBefore = stack.tap?.frames().length ?? 0;
    await mei.conn.request('session.message.send', { sessionId: notesId, text: 'Please write the long notes.' });
    await turnsFinished(leo, notesId, 1, 120_000);
    await statusIs(leo, notesId, 'idle');
    await stack.claude!.setScenario(scenario(CART_GOES_ON));
    const whole = leo.events(notesId);
    const blocks = whole.filter((event): event is Extract<ConversationEvent, { kind: 'text' }> => event.kind === 'text');
    expect(blocks).toHaveLength(LONG_BLOCKS);
    for (const [index, block] of blocks.entries()) expect(block.text).toBe(longBlock(index));
    const wholeBytes = Buffer.byteLength(JSON.stringify(whole));
    expect(wholeBytes).toBeGreaterThan(EVENTS_PAGE_MAX_BYTES);
    await agree([leo, ian, mei], 'after the long turn');
    // Live, the events came in several batches (a batch closes at 512 KiB), never as one message.
    expect(leo.got('session.events').filter((batch) => batch.sessionId === notesId).length).toBeGreaterThan(Math.floor(wholeBytes / (512 * 1024)));

    // ---- Amy comes back with what she holds: the reply continues her window with ONE page, and says there is more
    expect(amy.events(notesId)).toHaveLength(amyHad);
    const haveSeq = amy.events(notesId).at(-1)?.seq as number;
    const firstPage = await amy.conn.request('session.watch', { sessionId: notesId, haveSeq });
    expect(firstPage).toMatchObject({ firstSeq: haveSeq + 1, hasMore: true });
    expect(firstPage.events.length).toBeLessThan(whole.length - amyHad);
    expect(Buffer.byteLength(JSON.stringify(firstPage.events))).toBeLessThanOrEqual(EVENTS_PAGE_MAX_BYTES);
    amy.conn.notify('session.unwatch', { sessionId: notesId });
    await amy.watch(notesId); // the same request, then `session.history { afterSeq }` until nothing is after
    expect(amy.events(notesId)).toEqual(whole);

    // ---- Noa opens it for the first time: the NEWEST page, and "load earlier" back to the first line
    await noa.watch(notesId);
    const newest = noa.events(notesId);
    expect(newest.at(-1)).toEqual(whole.at(-1));
    expect(newest[0]?.seq).toBeGreaterThan(1);
    expect(Buffer.byteLength(JSON.stringify(newest))).toBeLessThanOrEqual(EVENTS_PAGE_MAX_BYTES);
    expect(await noa.readBack(notesId, 4)).toBeGreaterThan(1);
    expect(noa.events(notesId)).toEqual(whole);
    await agree([leo, amy, noa], 'after reading the long conversation');

    // ---- what that was on the wire: the largest frame of a 2.4 MiB conversation is about one page, a quarter of the limit
    await stack.tap?.waitForQuiet(300, 20_000);
    const frames = (stack.tap?.frames() ?? []).slice(framesBefore).filter((frame) => frame.direction !== 'request');
    const largest = Math.max(...frames.map((frame) => frame.data.length));
    const incoming = frames.filter((frame) => frame.direction === 'in');
    longConversation = { received: incoming.length, receivedBytes: incoming.reduce((sum, frame) => sum + frame.data.length, 0) };
    expect(largest).toBeGreaterThan(256 * 1024);
    expect(largest).toBeLessThanOrEqual(EVENTS_PAGE_MAX_BYTES + 64 * 1024);
    expect(largest).toBeLessThan(MAX_RELAY_FRAME / 2);
  });

  step('the host\'s smurg stops and starts again: every client comes back by itself and catches up from what it holds; open cards are withdrawn at every client, the plan is paused until "Continue all"', async () => {
    const members = [ian, mei, amy, leo, noa];
    const connections = members.map((one) => one.conn);
    const launchesBefore = await launches(stack.claude!);
    const heldBefore = new Map(members.map((one) => [one.name, Object.fromEntries(one.watching().map((id) => [id, one.events(id).length]))]));
    expect(mei.permissions().find((request) => request.id === cartRequestId)).toMatchObject({ status: 'open' });

    // ---- "smurg stop" on the host's computer: every client learns that the host is away; nothing is written after
    const marks = members.map((one) => one.client.states.length);
    await stack.stopDaemon();
    for (const one of members) await one.client.waitFor((state) => state.kind === 'host-offline', 20_000);
    const left = { state: await onDisk(stack.stateDir), folder: await onDisk(stack.root) };
    expect(left.state.some((line) => line.includes('topics.json'))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await onDisk(stack.stateDir)).toEqual(left.state);
    expect(await onDisk(stack.root)).toEqual(left.folder);
    expect(await stack.agentProcesses()).toEqual([]);

    // ---- "smurg host" again: the same connections, the same devices, no new invite
    await stack.startDaemon();
    for (const one of members) await one.client.waitFor((state) => state.kind === 'online', 30_000);
    expect(members.map((one) => one.conn)).toEqual(connections);
    for (const [index, one] of members.entries()) {
      const since = one.client.states.slice(marks[index]).map((record) => record.state.kind);
      expect(since, `${one.name}'s connection`).toContain('host-offline');
      expect(since.at(-1), `${one.name}'s connection`).toBe('online');
      for (const kind of since) expect(['host-offline', 'connecting', 'handshaking', 'online'], `${one.name}'s connection was ${kind}`).toContain(kind);
    }
    // No process survived the stop, and the start started none.
    expect(await stack.agentProcesses()).toEqual([]);
    expect(await launches(stack.claude!)).toBe(launchesBefore);

    // ---- every client reads the lists again and watches again with what it holds: its windows are CONTINUED
    for (const one of members) await one.sync();
    for (const one of members) {
      for (const [id, count] of Object.entries(heldBefore.get(one.name) ?? {})) expect(one.events(id).length, `${one.name}'s window of ${id}`).toBeGreaterThanOrEqual(count);
    }
    for (const one of members) {
      expect(one.topic(topicId), `the topic at ${one.name}`).toMatchObject({ phase: 'executing', discussion: 'live', plan: { paused: true, items: 3, started: 3 } });
      expect(one.plan(topicId)?.items.map((item) => `${item.id} ${item.state}${item.stalledBy === undefined ? '' : ` by ${item.stalledBy}`}${item.armed ? ' armed' : ''}`), `the plan at ${one.name}`).toEqual(['cart-api stalled by restart', 'checkout-page waiting armed', 'receipt-email stalled by agent']);
      // The card that was open when the host stopped: withdrawn, at the client that held it as open too.
      expect(one.permissions().find((request) => request.id === cartRequestId), `the card at ${one.name}`).toMatchObject({ status: 'withdrawn', withdrawn: { reason: 'restarted' } });
      expect(one.suggestions().find((suggestion) => suggestion.id === amySuggestionId), `the suggestion at ${one.name}`).toMatchObject({ status: 'pending' });
      expect(one.events(cartId).slice(-3), `the end of work item 1's conversation at ${one.name}`).toMatchObject([{ kind: 'turn.finished', outcome: 'interrupted' }, { kind: 'delivery' }, { kind: 'line', text: { id: 'conversation.interrupted.restart' } }]);
    }
    await agree(members, 'after the restart');

    // ---- and it is what a client that reads everything from nothing gets (Leo opens a second tab)
    const tab = member(await leo.client.reconnect(), 'Leo (second tab)', 'viewer');
    await tab.sync();
    for (const id of leo.watching()) {
      await tab.watch(id);
      await tab.readBack(id);
    }
    await agree([leo, tab], 'read from nothing');
    tab.client.close();

    // ---- the inbox: the withdrawn request is gone, the pause is new, what Mei had read is still read
    const paused = await inboxItem(mei, (item) => item.kind === 'attention' && item.subject === 'plan-paused', 'the paused plan');
    expect(paused).toMatchObject({ unread: true, topicId, target: { kind: 'plan', topicId } });
    const meiInbox = await mei.inbox();
    expect(meiInbox.some((item) => item.kind === 'permission')).toBe(false);
    expect(meiInbox.find((item) => item.kind === 'suggestion')).toMatchObject({ unread: false });
    await inboxItem(noa, (item) => item.subject === 'plan-paused', 'the paused plan');
    expect(mei.inboxHeld().map((item) => item.key).sort()).toEqual(meiInbox.map((item) => item.key).sort());
    expect(await refusal(mei.conn.request('permission.decide', { requestId: cartRequestId, decision: 'allow' }))).toMatchObject({ code: 'conflict', reason: 'settled' });

    // ---- "Continue all": the interrupted session goes on in its own conversation and asks again, with a NEW card
    expect(await refusal(amy.conn.request('plan.resume', { topicId }))).toMatchObject({ code: 'forbidden' });
    const resumed = (await mei.conn.request('plan.resume', { topicId })).plan;
    expect(resumed.paused).toBe(false);
    const askedAgain = await permissionAt(leo, (request) => request.sessionId === cartId && request.status === 'open', 'the command, asked again');
    expect(askedAgain.id).not.toBe(cartRequestId);
    for (const one of members) await permissionAt(one, (request) => request.id === askedAgain.id, 'the new card');
    expect(await inboxItem(mei, (item) => item.key === `permission:${askedAgain.id}`, 'the request, asked again')).toMatchObject({ unread: true });
    for (const one of [mei, noa]) await inboxWithout(one, (item) => item.subject === 'plan-paused', 'the pause');
    const cartLaunches = (await stack.claude!.echoed()).filter((entry) => entry.kind === 'argv' && entry.session === cartId).map((entry) => entry.value as string[]);
    expect(cartLaunches.map((argv) => (argv.includes('--resume') ? 'resume' : 'new'))).toEqual(['new', 'resume']);
    cartRequestId = askedAgain.id;
  });

  step('reports and reviews, merges by the host, a conflict the agent resolves, the topic complete: in the end every client, the late one too, holds the same picture', async () => {
    const members = [ian, mei, amy, leo, noa];

    // ---- "always allow pnpm test in every session of this topic"; work item 1 finishes with a partial report
    expect((await mei.conn.request('permission.decide', { requestId: cartRequestId, decision: 'allow-always', scope: 'topic' })).request).toMatchObject({ status: 'allowed', decision: { by: { userId: mei.userId }, always: 'topic' } });
    for (const one of members) await topicIs(one, topicId, (topic) => topic.rules.length === 1, "the topic's remembered rule");
    // The rule is the TOPIC's: every session of the topic counts it, at every client, also the sessions nobody touched.
    for (const one of members) await waitUntil(() => [discussionId, cartId, receiptId].every((id) => (one.session(id) as AgentSession | undefined)?.ruleCount === 1), 10_000, `the rule in every session of the topic, as ${one.name} is told`);
    expect((ian.session(notesId) as AgentSession).ruleCount).toBe(0);
    for (const one of members) await planIs(one, topicId, (plan) => itemOf(plan, 'cart-api')?.report?.state === 'to-review', 'the report of work item 1');
    await eventOf(leo, cartId, (event) => event.kind === 'pointer' && event.target === 'report', "the report's card in the item's conversation");
    const report1 = (await leo.conn.request('report.get', { topicId, itemId: 'cart-api' })).report;
    expect(report1).toMatchObject({ version: 1, outcome: 'partial', state: 'to-review', reviewers: [{ userId: mei.userId }], checks: { passed: 1, notVerified: 1 } });
    expect(report1.sections.done).toContain(M.report);
    expect(await inboxItem(mei, (item) => item.kind === 'report', 'the report of her item')).toMatchObject({ topicId, itemId: 'cart-api', outcome: 'partial' });
    expect(await refusal(amy.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(mei.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 }))).toMatchObject({ code: 'conflict', reason: 'unfinished' });
    await mei.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1, acknowledgeUnfinished: true });
    const cartDraft = report1.changes?.requestId as string;

    // ---- the reviewed change is in the host's inbox; he merges; the item that waited starts by itself
    expect(await inboxItem(ian, (item) => item.key === `merge:${cartDraft}` && item.ready === true, 'the change to merge')).toMatchObject({ itemId: 'cart-api', unblocks: [2] });
    expect(await refusal(mei.conn.request('worktree.merge.approve', { requestId: cartDraft }))).toMatchObject({ code: 'forbidden' });
    expect((await ian.conn.request('worktree.merge.approve', { requestId: cartDraft })).request).toMatchObject({ status: 'merged' });
    expect(await text('src/app.ts')).toBe(APP_BY_CART);
    await statusIs(leo, cartId, 'ended');
    const running = await planIs(leo, topicId, (plan) => itemOf(plan, 'checkout-page')?.sessionId !== undefined, 'work item 2 started');
    pageId = itemOf(running, 'checkout-page')?.sessionId as string;
    for (const one of members) await one.watch(pageId);
    // Its command is of the kind the topic always allows: no card at any client.
    for (const one of members) await planIs(one, topicId, (plan) => itemOf(plan, 'checkout-page')?.report?.state === 'to-review', 'the report of work item 2');
    await eventOf(leo, pageId, (event) => event.kind === 'pointer' && event.target === 'report', "the report's card of work item 2");
    expect(leo.permissions().filter((request) => request.sessionId === pageId)).toEqual([]);
    // Amy, an Editor, is responsible for it: the report is hers to review.
    expect(await inboxItem(amy, (item) => item.kind === 'report', 'the report of her item')).toMatchObject({ itemId: 'checkout-page', outcome: 'complete' });
    await amy.conn.request('report.review', { topicId, itemId: 'checkout-page', version: 1 });
    const pageDraft = (await leo.conn.request('report.get', { topicId, itemId: 'checkout-page' })).report.changes?.requestId as string;
    await inboxItem(ian, (item) => item.key === `merge:${pageDraft}` && item.ready === true, 'the change of work item 2');
    expect((await ian.conn.request('worktree.merge.approve', { requestId: pageDraft })).request).toMatchObject({ status: 'merged' });
    await statusIs(leo, pageId, 'ended');

    // ---- "Continue" for work item 3 (it stopped without a report before the restart): its process starts again, in
    // its own conversation, with the topic's rule among its own allow rules: its command asks nobody
    await stack.claude!.setScenario(scenario(RECEIPT_GOES_ON));
    await ian.conn.request('plan.item.continue', { topicId, itemId: 'receipt-email' });
    for (const one of members) await planIs(one, topicId, (plan) => itemOf(plan, 'receipt-email')?.report?.state === 'to-review', 'the report of work item 3');
    expect(leo.permissions().filter((request) => request.sessionId === receiptId)).toEqual([]);
    const receiptStarts = (await stack.claude!.echoed()).filter((entry) => entry.session === receiptId && (entry.kind === 'argv' || entry.kind === 'settings'));
    expect(receiptStarts.filter((entry) => entry.kind === 'argv').map((entry) => ((entry.value as string[]).includes('--resume') ? 'resume' : 'new'))).toEqual(['new', 'resume']);
    expect((receiptStarts.filter((entry) => entry.kind === 'settings').at(-1)?.value as { permissions?: { allow?: string[] } }).permissions?.allow).toContain('Bash(pnpm test *)');
    expect((await audited(ian.conn, 'agent.command')).filter((entry) => entry.target === receiptId).map((entry) => entry.detail)).toMatchObject([{ sessionId: receiptId, verb: 'run', why: 'unasked', command: `pnpm test --tag ${M.command}` }]);
    await ian.conn.request('report.review', { topicId, itemId: 'receipt-email', version: 1 });

    // ---- its change conflicts with what work item 1 merged: smurg merges, the agent resolves, a new report
    const receiptDraft = (await leo.conn.request('report.get', { topicId, itemId: 'receipt-email' })).report.changes?.requestId as string;
    expect((await ian.conn.request('worktree.merge.approve', { requestId: receiptDraft })).request).toMatchObject({ status: 'conflict', conflictFiles: ['src/app.ts'] });
    for (const one of members) await planIs(one, topicId, (plan) => itemOf(plan, 'receipt-email')?.merge?.status === 'conflict', 'the conflict in the plan');
    await mei.conn.request('plan.item.resolve', { topicId, itemId: 'receipt-email' });
    for (const one of members) await planIs(one, topicId, (plan) => itemOf(plan, 'receipt-email')?.report?.version === 2, 'the report after the conflict was resolved');
    await eventOf(leo, receiptId, (event) => event.kind === 'pointer' && event.target === 'report' && event.version === 2, "the new report's card");
    const resolved = (await leo.conn.request('report.get', { topicId, itemId: 'receipt-email' })).report;
    expect(resolved).toMatchObject({ version: 2, state: 'changed-after-review' });
    await ian.conn.request('report.review', { topicId, itemId: 'receipt-email', version: 2 });
    const resolvedDraft = resolved.changes?.requestId as string;
    await inboxItem(ian, (item) => item.key === `merge:${resolvedDraft}` && item.ready === true, 'the resolved change');
    expect((await ian.conn.request('worktree.merge.approve', { requestId: resolvedDraft })).request).toMatchObject({ status: 'merged' });
    expect(await text('src/app.ts')).toBe(APP_RESOLVED);
    await statusIs(leo, receiptId, 'ended');
    expect(await stack.git(['status', '--porcelain'])).toBe('');

    // ---- every item is reviewed and merged: the topic is complete, at every client
    for (const one of members) expect((await topicIs(one, topicId, (topic) => topic.phase === 'complete', 'the complete topic')).plan).toMatchObject({ items: 3, started: 3, reviewed: 3, merged: 3, paused: false });
    await waitUntil(async () => (await leo.conn.request('worktree.list', {})).worktrees.length === 0, 30_000, 'every item worktree to be gone');
    await agree(members, 'in the end');
    // The picture is the daemon's: the lists and every conversation as it answers them now.
    const plan = (await leo.conn.request('plan.get', { topicId })).plan as PlanInfo;
    expect(plan.items.map((item) => `${item.id} ${item.state} ${item.merge?.status} ${item.report?.state}`)).toEqual(['cart-api reviewed merged reviewed', 'checkout-page reviewed merged reviewed', 'receipt-email reviewed merged reviewed']);
    for (const one of members) {
      expect(one.plan(topicId), `the plan at ${one.name}`).toEqual(plan);
      expect(one.inboxHeld().map((item) => item.key).sort(), `${one.name}'s inbox`).toEqual((await one.inbox()).map((item) => item.key).sort());
    }
    const sessions = agentSessions((await leo.conn.request('session.list', { topicId })).sessions) as AgentSession[];
    expect(sessions.map((session) => `${session.purpose} ${session.itemId ?? ''} ${session.status}`)).toEqual(['discussion  idle', 'item cart-api ended', 'item receipt-email ended', 'item checkout-page ended']);
    for (const one of members) for (const session of sessions) expect(comparableSession(one.session(session.id) as AgentSession), `the session ${session.id} at ${one.name}`).toEqual(comparableSession(session));
    for (const id of [discussionId, cartId, receiptId, pageId]) expect((await noa.conn.request('session.watch', { sessionId: id })).events, `the conversation ${id}`).toEqual(noa.events(id));
    // Of what Amy wrote, the agents were given the revision Mei accepted and nothing else.
    const received = await everythingAgentsReceived(stack.claude!);
    expect(received).toContain(M.suggestion);
    expect(received).not.toContain(M.comment);
    expect(received).not.toContain('gift cards');
  });

  step('what the relay carried: nothing of the conversations is readable there, no frame comes near its limit, no connection was cut; the frames per minute of the whole flow', async () => {
    const tap = stack.tap;
    if (tap === undefined) throw new Error('the stack of this flow records at the relay');
    await tap.waitForQuiet(500, 20_000);
    const minutes = (Date.now() - startedAt) / 60_000;
    const all = tap.frames().filter((frame) => frame.workspaceId === stack.workspaceId || frame.direction === 'request');
    const frames = all.filter((frame) => frame.direction !== 'request');

    // ---- every marker crossed the relay inside what the clients were sent (so it was there to be found) ...
    const atLeo = JSON.stringify(leo.picture());
    for (const [name, value] of Object.entries(M)) {
      if (name === 'report') continue; // a report's text is read on demand (`report.get`): asked for and checked above
      expect(atLeo, `marker ${name} reached a client`).toContain(value);
    }
    // ... and the relay saw none of it, in any encoding: not in a frame, not in a request.
    for (const [name, value] of Object.entries(M)) expect(findPlaintext(all, value), `marker ${name} at the relay`).toEqual([]);
    for (const name of ['Checkout', SPEC_PATH, 'cart-api', 'Cart API']) expect(frames.some((frame) => frame.data.includes(name)), `"${name}" at the relay`).toBe(false);

    // ---- the limits: the largest frame of the whole flow is the page of the long conversation
    const largest = Math.max(...frames.map((frame) => frame.data.length));
    expect(largest).toBeLessThanOrEqual(EVENTS_PAGE_MAX_BYTES + 64 * 1024);
    expect(largest).toBeLessThan(MAX_RELAY_FRAME / 2);
    // Without the long conversation nothing is larger than a few dozen KiB (the flow's own frames are small).
    const room = await stack.relay.inspect('ws', stack.workspaceId);
    expect(room.hostStatus).toBe('online');
    expect(room.clients.map((client) => client.userId).sort()).toEqual([amy, ian, leo, mei, noa].map((one) => one.userId).sort());
    // No connection was refused, cut or given up: every client is the connection it began with (Mei's second one:
    // she reloaded on purpose), and was never anything but on its way, online, or waiting for the host.
    for (const one of [ian, mei, amy, leo, noa]) {
      const states = one.client.states.map((record) => record.state.kind);
      for (const kind of states) expect(['idle', 'connecting', 'handshaking', 'online', 'host-offline'], `${one.name}'s connection was ${kind}`).toContain(kind);
      expect(states.at(-1)).toBe('online');
    }
    expect(closedOnPurpose).toHaveLength(1);

    // ---- the measurement (DESIGN §9.5 item 6): frames the relay RECEIVED (what a hosted relay is billed by)
    const received = frames.filter((frame) => frame.direction === 'in');
    const fromHost = received.filter((frame) => frame.role === 'host');
    const measured = {
      seconds: Math.round(minutes * 60),
      received: received.length,
      fromHost: fromHost.length,
      fromClients: received.length - fromHost.length,
      sent: frames.length - received.length,
      receivedBytes: received.reduce((sum, frame) => sum + frame.data.length, 0),
      requests: all.length - frames.length,
      largestFrameBytes: largest,
      receivedPerMinute: Math.round(received.length / minutes),
      // The step with the long conversation by itself (five clients, 2.4 MiB of text read live, forward and backward).
      longConversation,
    };
    // Printed (a reporter that shows the output of passing tests prints it) and, with SMURG_FLOW_MEASURE=<file>, written there.
    console.info(`[topic-flow] ${JSON.stringify(measured)}`);
    const measureFile = process.env['SMURG_FLOW_MEASURE'];
    if (measureFile !== undefined && measureFile !== '') await writeFile(measureFile, `${JSON.stringify(measured, null, 2)}\n`);
    expect(measured.received).toBeGreaterThan(200);
    expect(measured.fromHost).toBeGreaterThan(measured.fromClients);

    // ---- the host stops sharing: no agent process is left behind
    await stack.stopDaemon();
    await waitUntil(async () => (await stack.agentProcesses()).length === 0, 20_000, 'every agent process to be gone after the stop');
  });
});
