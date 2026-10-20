// The release composition, the whole story of ONE topic (DESIGN §3.7, §4, §7 S3 / S4 / S20 / S21; OWNER-BRIEF 1–6):
// the real topics, conversation, suggestion, inbox, worktree, docs, files, locks, hooks and agent-runtime modules
// together on a real git repository, the real `smurg hook` and `smurg mcp` commands, and the stand-in `claude`
// (release-flow.support.ts). Ian is the host, Mei has agent access, Amy is an Editor, Leo a Viewer. Every step is
// asserted from what the four RECEIVE (events, cards, inbox items, the audit log) and from the files and git.
//
// What only this composition proves (REQUESTS-P12 "never run together yet"): the topics module with the real runner
// and hook server (role prompts, the tool gate per kind of session, `check_plan` / `propose_split` / `check_report`
// over the MCP command, `agent.turn.finished` with its edits and messages, the slots), with the real conversation
// module (`sendAs` for "Ask the agent to revise" and follow-ups, a topic's remembered rule answering a request), with
// the real worktree module and git (the checkpoint commit, the pin, item worktrees, drafts, a conflict resolved by the
// agent) and with the real inbox (reports, merges, attention items).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type AgentSession, type ConversationEvent, type PlanInfo, type Topic } from '@smurg/protocol';
import type { FakeClaudeScenario, FakeClaudeStep } from '../../src/testing/index.ts';
import { DocClient, destroyDocClients } from '../docs/helpers.ts';
import { AMY, IAN, LEO, MEI, audited, eventOf, everythingAgentsReceived, inboxItem, inboxWithout, kinds, launches, permissionAt, questionAt, refusal, startFlow, statusIs, told, turnsFinished, waitFor, type Flow, type Person } from './release-flow.support.ts';

const SLUG = 'checkout';
const SPEC_PATH = `specs/${SLUG}/SPEC.md`;
const PLAN_PATH = `specs/${SLUG}/PLAN.md`;
const reportPath = (itemId: string): string => `specs/${SLUG}/reports/${itemId}.md`;

// Texts only Amy writes: none may be in anything an agent received before a member with agent access let it.
const AMY_REVISE = 'Please say that coupons are not part of it (amy-revise-3b7e).';
const AMY_SPEC_EDIT = 'Gift cards are out of scope too (amy-spec-edit-c41d).';

const APP_BEFORE = 'export const title = "Bookshop";\n';
const APP_BY_CART = 'export const title = "Bookshop with a cart";\n';
const APP_BY_RECEIPT = 'export const title = "Bookshop with receipts";\n';
const APP_RESOLVED = 'export const title = "Bookshop with a cart and receipts";\n';

const SPEC = ['# Checkout', '', '## Goal', 'Buying a book takes one page.', '', '## Decisions', '- Payment: cards only.', '', '## Scope', 'Cart, payment, receipt.', '', '## Out of scope', 'Invoices.', '', '## Behaviour', 'One page, three sections.', '', '## Open questions', 'None.', ''].join('\n');
const SPEC_REVISED = SPEC.replace('Invoices.', 'Invoices. Coupons.');

const PLAN_BROKEN = ['# Plan: Checkout', '', '<!-- smurg:plan v1 -->', '', '### 1. Cart API', '- size: m', '', 'Compute the total in one module.', '', '<!-- smurg:plan end -->', ''].join('\n');
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

const PAYMENT = { question: 'How do people pay?', header: 'Payment', multiSelect: false, options: [{ label: 'Cards only', description: 'One provider.' }, { label: 'Cards and invoices', description: 'More work.' }] };
const PNPM_TEST = { tool: 'Bash', input: { command: 'pnpm test' }, suggest: { toolName: 'Bash', ruleContent: 'pnpm test *' }, result: '3 tests passed' } as const;

/** What the "model" does. A turn is chosen by a pattern on the message smurg (or a person) sent. */
const SCENARIO: FakeClaudeScenario = {
  turns: [
    // ---- the discussion
    {
      match: 'one page',
      once: true,
      steps: [
        { tool: 'AskUserQuestion', input: { questions: [PAYMENT] } },
        // What a discussion agent may not do: any write but its two files, any command.
        { tool: 'Write', input: { file_path: 'notes/ideas.md', content: 'An idea.\n' } },
        { tool: 'Bash', input: { command: 'ls' }, run: true },
        { tool: 'Write', input: { file_path: SPEC_PATH, content: SPEC } },
        { text: 'The first draft of the spec is ready.' },
      ],
    },
    { match: 'coupons', steps: [{ tool: 'Edit', input: { file_path: SPEC_PATH, old_string: 'Invoices.', new_string: 'Invoices. Coupons.' } }, { text: 'Coupons are out of scope now.' }] },
    {
      match: 'Then call check_plan',
      steps: [
        { tool: 'Write', input: { file_path: PLAN_PATH, content: PLAN_BROKEN } },
        { tool: 'mcp__smurg__check_plan', input: {} },
        { tool: 'Write', input: { file_path: PLAN_PATH, content: PLAN } },
        { tool: 'mcp__smurg__check_plan', input: {} },
        { tool: 'mcp__smurg__propose_split', input: { items: [{ id: 'cart-api', person: 'Mei' }, { id: 'checkout-page', person: 'ian' }, { id: 'receipt-email', person: 'Somebody Else' }], reason: 'Mei knows the cart.' } },
        { text: 'The plan has three work items.' },
      ],
    },
    // ---- work item 1: edits are automatic, a command asks, the spec cannot be changed; a partial report
    {
      match: 'Start work item 1 ',
      steps: [
        { tool: 'Write', input: { file_path: 'src/cart/total.ts', content: 'export const total = (prices: number[]): number => prices.reduce((a, b) => a + b, 0);\n' } },
        { tool: 'Edit', input: { file_path: 'src/app.ts', old_string: APP_BEFORE, new_string: APP_BY_CART } },
        { tool: 'Edit', input: { file_path: SPEC_PATH, old_string: 'One page', new_string: 'Two pages' } },
        PNPM_TEST,
        { tool: 'Write', input: { file_path: reportPath('cart-api'), content: report('cart-api', 'Cart API', 'partial') } },
        { tool: 'mcp__smurg__check_report', input: {} },
        { text: 'The cart is done; one check could not run.' },
      ],
    },
    // ---- work item 2 (starts after 1 is merged): the same kind of command is not asked any more
    {
      match: 'Start work item 2 ',
      steps: [
        PNPM_TEST,
        { tool: 'Write', input: { file_path: 'src/checkout/page.ts', content: 'export const page = "checkout";\n' } },
        { tool: 'Write', input: { file_path: reportPath('checkout-page'), content: report('checkout-page', 'Checkout page', 'complete') } },
        { tool: 'mcp__smurg__check_report', input: {} },
        { text: 'The checkout page is done.' },
      ],
    },
    // ---- work item 3: stops without a report, twice; then goes on when told
    { match: 'Start work item 3 ', steps: [{ tool: 'Edit', input: { file_path: 'src/app.ts', old_string: APP_BEFORE, new_string: APP_BY_RECEIPT } }, { text: 'I changed the title.' }] },
    { match: 'You stopped without the result report', steps: [{ text: 'I am not sure what is missing.' }] },
    {
      match: 'Continue the work item',
      steps: [
        PNPM_TEST,
        { tool: 'Write', input: { file_path: reportPath('receipt-email'), content: report('receipt-email', 'Receipt email', 'complete') } },
        { tool: 'mcp__smurg__check_report', input: {} },
        { text: 'The receipt email is done.' },
      ],
    },
    {
      match: 'conflict markers',
      steps: [
        { tool: 'Write', input: { file_path: 'src/app.ts', content: APP_RESOLVED } },
        { tool: 'Write', input: { file_path: reportPath('receipt-email'), content: report('receipt-email', 'Receipt email', 'complete', ' The title names both now.') } },
        { tool: 'mcp__smurg__check_report', input: {} },
        { text: 'The conflict is resolved.' },
      ],
    },
    { match: 'Why is it partial', steps: [{ text: 'The browser check needs a display, and this session has none.' }] },
    { steps: [{ text: 'ok' }] },
  ],
};


const lastTopic = (member: Person, topicId: string): Topic | undefined => member.got('topic.updated').filter((update) => update.topic.id === topicId).at(-1)?.topic;
const lastPlan = (member: Person, topicId: string): PlanInfo | undefined => member.got('plan.updated').filter((update) => update.plan.topicId === topicId).at(-1)?.plan;
async function topicIs(member: Person, topicId: string, fits: (topic: Topic) => boolean, what: string): Promise<Topic> {
  await waitFor(() => { const topic = lastTopic(member, topicId); return topic !== undefined && fits(topic); }, { timeoutMs: 30_000, what: `${what}, as ${member.name} is told` });
  return lastTopic(member, topicId) as Topic;
}
async function planIs(member: Person, topicId: string, fits: (plan: PlanInfo) => boolean, what: string): Promise<PlanInfo> {
  await waitFor(() => { const plan = lastPlan(member, topicId); return plan !== undefined && fits(plan); }, { timeoutMs: 30_000, what: `${what}, as ${member.name} is told` });
  return lastPlan(member, topicId) as PlanInfo;
}
const itemOf = (plan: PlanInfo | undefined, id: string) => plan?.items.find((item) => item.id === id);
const text = (path: string, flow: Flow, root = flow.root): Promise<string> => readFile(join(root, path), 'utf8');
const bytes = (content: string): Uint8Array => new TextEncoder().encode(content);

// (An editor a test left open; this hook runs before the one of release-flow.support.ts that stops the daemon.)
afterEach(() => destroyDocClients());

describe('the release composition: one topic from the discussion to the archive, four people', { timeout: 480_000 }, () => {
  it('discussion, spec, revision, plan, split, Start, items in worktrees, reports, reviews, merges, a conflict, complete, archive', async () => {
    const flow = await startFlow({
      files: {
        'README.md': '# Bookshop\n',
        'src/app.ts': APP_BEFORE,
        // Project-level Claude Code settings: nothing of them is used until the host has confirmed them.
        '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Bash(rm -rf *)'] } }),
      },
    });
    await flow.claude.setScenario(SCENARIO);
    const { ian, mei, amy, leo } = flow;
    const everyone = [ian, mei, amy, leo];

    // ================================================================================================================
    // The folder's Claude Code settings wait for the host; he confirms them
    // ================================================================================================================
    const settingsItem = await inboxItem(ian, (item) => item.kind === 'attention' && item.subject === 'project-settings', 'the project settings');
    expect(settingsItem).toMatchObject({ waiting: true, target: { kind: 'console', section: 'claude-config' } });
    expect(await mei.inbox()).toEqual([]);
    expect(await refusal(mei.conn.request('admin.claudeConfig.get', {}))).toMatchObject({ code: 'forbidden' });
    const config = (await ian.conn.request('admin.claudeConfig.get', {})).roots.find((entry) => entry.root.kind === 'main');
    expect(config).toMatchObject({ state: 'ignored', files: [{ path: '.claude/settings.json', decision: null, permissions: ['deny: Bash(rm -rf *)'] }] });
    await ian.conn.request('admin.claudeConfig.decide', { root: MAIN_ROOT, files: (config?.files ?? []).map((file) => ({ path: file.path, hash: file.hash })), decision: 'trust', acknowledged: config?.files.flatMap((file) => file.needsAck) ?? [] });
    await inboxWithout(ian, (item) => item.key === settingsItem.key, 'the confirmed project settings');
    expect(await leo.conn.request('session.host.get', {})).toMatchObject({ mainProjectSettings: 'used', account: { state: 'ok' } });

    // ================================================================================================================
    // Mei creates the topic: the folder, the discussion session with its role prompt
    // ================================================================================================================
    expect(await refusal(amy.conn.request('topic.create', { name: 'Mine' }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(leo.conn.request('topic.create', { name: 'Mine' }))).toMatchObject({ code: 'forbidden' });
    const created = await mei.conn.request('topic.create', { name: 'Checkout', firstMessage: 'We want the checkout on one page.' });
    const topicId = created.topic.id;
    const discussionId = created.session.id;
    expect(created.topic).toMatchObject({ name: 'Checkout', slug: SLUG, phase: 'discussing', archived: false, versioned: true, createdBy: { userId: MEI }, discussionSessionId: discussionId, discussion: 'live', spec: { exists: false }, plan: { exists: false, mode: 'assigned', paused: false, items: 0 }, rules: [] });
    expect(created.session).toMatchObject({ kind: 'agent', purpose: 'discussion', topicId, topicName: 'Checkout', openedBy: { userId: MEI }, responsible: null, modeFixed: true, projectSettings: 'used' });
    for (const member of everyone) await member.watch(discussionId);
    for (const member of everyone) await topicIs(member, topicId, (topic) => topic.discussionSessionId === discussionId, 'the new topic');
    expect((await leo.conn.request('topic.list', {})).topics.map((topic) => topic.id)).toEqual([topicId]);
    expect((await leo.conn.request('session.list', { topicId })).sessions.map((session) => session.id)).toEqual([discussionId]);

    // ================================================================================================================
    // The discussion: a question, what the agent may not do, the first draft of the spec
    // ================================================================================================================
    const payment = await questionAt(leo, (question) => question.sessionId === discussionId && question.status === 'open', 'the question of the discussion');
    expect(payment).toMatchObject({ decider: { userId: MEI }, parts: [{ header: 'Payment', text: PAYMENT.question }] });
    // While it is open the Start dialog would say so (there is no plan yet: the dialog's other facts come later).
    await amy.conn.request('question.vote', { questionId: payment.id, part: 0, options: [0] });
    await mei.conn.request('question.submit', { questionId: payment.id, answers: [{ options: [0] }] });
    await turnsFinished(leo, discussionId, 1);
    await statusIs(leo, discussionId, 'idle');
    // (The events of a session travel in batches, a moment after a state that says the same: wait for the last one.)
    await eventOf(leo, discussionId, (event) => event.kind === 'pointer' && event.target === 'spec', "the spec's next-step card");
    // What everyone saw of the turn. The tool gate refused the two things a discussion agent may not do, with a sentence
    // the agent reads; the write of its own file needed no card.
    const draftTurn = leo.events(discussionId);
    expect(kinds(draftTurn)).toEqual(['line', 'message', 'delivery', 'delivery', 'turn.started', 'card:question', 'tool.started', 'tool.finished', 'tool.started', 'tool.finished', 'tool.started', 'tool.finished', 'text', 'turn.finished', 'delivery', 'pointer']);
    const finished = draftTurn.filter((event): event is Extract<ConversationEvent, { kind: 'tool.finished' }> => event.kind === 'tool.finished');
    expect(finished.map((event) => event.ok)).toEqual([false, false, true]);
    expect(finished[0]?.result.body).toMatchObject({ text: expect.stringContaining('A discussion session writes only SPEC.md and PLAN.md in specs/checkout/.') });
    expect(finished[1]?.result.body).toMatchObject({ text: expect.stringContaining('This session does not have the tool Bash.') });
    await expect(text('notes/ideas.md', flow)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await text(SPEC_PATH, flow)).toBe(SPEC);
    // The spec's next-step card: a pointer at the end of the turn; the phase follows the file.
    expect(draftTurn.at(-1)).toMatchObject({ kind: 'pointer', target: 'spec', topicId });
    const drafted = await topicIs(leo, topicId, (topic) => topic.phase === 'spec', 'the first draft');
    const specEdit = draftTurn.find((event) => event.kind === 'tool.started' && event.tool.file?.path === SPEC_PATH);
    expect(drafted.spec).toMatchObject({ exists: true, changedBy: { kind: 'agent', sessionId: discussionId, displayName: 'Claude (Checkout)' }, lastAgentChange: { sessionId: discussionId, seq: specEdit?.seq, askedBy: { userId: MEI } } });
    expect(drafted.handEdits).toEqual({ spec: [], plan: [] });
    // The gate's refusals are in the audit log, one entry per row.
    expect((await audited(flow, 'permission.auto-deny')).map((entry) => entry.detail)).toMatchObject([{ sessionId: discussionId, row: 'G6', tools: ['Write'], path: 'notes/ideas.md' }, { sessionId: discussionId, row: 'G2', tools: ['Bash'] }]);
    // What the discussion agent was started with: its role prompt, and Mei's first message under her header.
    const prompts = (await flow.claude.echoed()).filter((entry) => entry.kind === 'role-prompt' && entry.session === discussionId).map((entry) => String(entry.value));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("You are the discussion agent of one topic in a shared smurg workspace. The topic's files are in specs/checkout/.");
    expect(prompts[0]).toContain('You can write only specs/checkout/SPEC.md and specs/checkout/PLAN.md.');
    expect(prompts[0]).toContain('<!-- smurg:plan v1 -->');
    expect(await told(flow, discussionId)).toEqual(['[Mei · Agent access]\nWe want the checkout on one page.']);

    // ================================================================================================================
    // Amy asks the agent to revise the spec: a suggestion; accepted by Mei it is Amy's message
    // ================================================================================================================
    const revise = await amy.conn.request('topic.revise', { topicId, target: 'spec', text: AMY_REVISE, quote: { heading: 'Out of scope', text: 'Invoices.' } });
    if (!('suggestion' in revise)) throw new Error("an Editor's revise must be a suggestion");
    const composed = `About SPEC.md, section "Out of scope":\n\`\`\`text\nInvoices.\n\`\`\`\n${AMY_REVISE}`;
    expect(revise.suggestion).toMatchObject({ sessionId: discussionId, status: 'pending', origin: 'revise', topicId, author: { userId: AMY }, text: composed });
    await eventOf(leo, discussionId, (event) => event.kind === 'card' && event.card === 'suggestion' && event.id === revise.suggestion.id, 'the suggestion card in the discussion');
    expect(await inboxItem(mei, (item) => item.kind === 'suggestion', 'the revision Amy asked for')).toMatchObject({ topicId, sessionId: discussionId, from: { kind: 'user', userId: AMY }, count: 1, alsoFor: [{ userId: IAN }] });
    expect(await everythingAgentsReceived(flow)).not.toContain('amy-');
    expect((await mei.conn.request('suggest.accept', { suggestionId: revise.suggestion.id })).suggestion).toMatchObject({ status: 'accepted' });
    await turnsFinished(leo, discussionId, 2);
    await statusIs(leo, discussionId, 'idle');
    expect((await told(flow, discussionId)).at(-1)).toBe(`[Amy · Editor, suggestion accepted by Mei]\n${composed}`);
    expect(await text(SPEC_PATH, flow)).toBe(SPEC_REVISED);
    // The spec says who asked for the agent's last change: Amy. Still no hand edit: the agent wrote it.
    const revised = await topicIs(leo, topicId, (topic) => topic.spec.lastAgentChange?.askedBy?.userId === AMY, 'the revised spec');
    expect(revised.handEdits).toEqual({ spec: [], plan: [] });
    // (The pointer is an event of the session: it travels in a batch, a moment after the topic's own update.)
    await waitFor(() => leo.events(discussionId).filter((event) => event.kind === 'pointer').length >= 2, { what: "the revised spec's next-step card at the Viewer" });
    expect(leo.events(discussionId).filter((event) => event.kind === 'pointer')).toHaveLength(2);
    await inboxWithout(mei, (item) => item.kind === 'suggestion', 'the accepted suggestion');

    // ================================================================================================================
    // "Generate plan": the agent writes PLAN.md, checks it with smurg's tool, proposes who is responsible
    // ================================================================================================================
    expect(await refusal(amy.conn.request('plan.generate', { topicId }))).toMatchObject({ code: 'forbidden' });
    expect((await leo.conn.request('plan.get', { topicId })).plan).toBeNull();
    const beforePlan = leo.events(discussionId).length;
    await mei.conn.request('plan.generate', { topicId });
    await topicIs(leo, topicId, (topic) => topic.plan.generating, '"Claude is writing the plan"');
    await turnsFinished(leo, discussionId, 3);
    await statusIs(leo, discussionId, 'idle');
    const planned = await topicIs(leo, topicId, (topic) => topic.phase === 'plan' && !topic.plan.generating, 'the plan');
    await eventOf(leo, discussionId, (event) => event.kind === 'pointer' && event.target === 'plan', "the plan's next-step card");
    // The generate turn as everyone saw it: smurg's own message (folded in the conversation), the broken plan the
    // agent's own check refused with the line, the fixed plan, the split, and the plan's next-step card.
    const planTurn = leo.events(discussionId).slice(beforePlan);
    expect(kinds(planTurn)).toEqual(['line', 'smurg', 'delivery', 'turn.started', 'tool.started', 'tool.finished', 'tool.started', 'tool.finished', 'tool.started', 'tool.finished', 'tool.started', 'tool.finished', 'tool.started', 'tool.finished', 'text', 'turn.finished', 'delivery', 'pointer']);
    expect(planTurn[0]).toMatchObject({ text: { id: 'conversation.planRequested', params: { name: 'Mei' } } });
    expect(planTurn[1]).toMatchObject({ kind: 'smurg', purpose: 'generate-plan', by: { userId: MEI }, text: expect.stringContaining('People who can be responsible right now: Ian, Mei.') });
    const checks = planTurn.filter((event): event is Extract<ConversationEvent, { kind: 'tool.finished' }> => event.kind === 'tool.finished').map((event) => (event.result.body?.kind === 'text' ? event.result.body.text : ''));
    expect(JSON.parse(checks[1] as string)).toMatchObject({ ok: false, errors: [{ line: 5, message: expect.stringContaining('- id: <id>') }] });
    expect(JSON.parse(checks[3] as string)).toMatchObject({ ok: true, items: 3, warnings: [] });
    expect(JSON.parse(checks[4] as string)).toMatchObject({ ok: true, assigned: 2, unknownPeople: 1 });
    expect(planTurn.at(-1)).toMatchObject({ kind: 'pointer', target: 'plan', topicId });
    expect((await told(flow, discussionId)).at(-1)).toMatch(/^\[smurg [a-z0-9]{4}\]\nRead specs\/checkout\/SPEC\.md as it is now/);
    expect(await text(PLAN_PATH, flow)).toBe(PLAN);
    // The plan as the daemon read it, and the agent under ONE name in everything it changed.
    expect(planned.plan).toMatchObject({ exists: true, valid: true, generating: false, stale: false, mode: 'assigned', items: 3, started: 0, changedBy: { kind: 'agent', displayName: 'Claude (Checkout)' } });
    expect(planned.spec.changedBy).toMatchObject({ kind: 'agent', displayName: 'Claude (Checkout)' });
    const plan1 = (await leo.conn.request('plan.get', { topicId })).plan as PlanInfo;
    expect(plan1).toMatchObject({ revision: 1, mode: 'assigned', paused: false, split: { source: 'agent', reason: 'Mei knows the cart.' }, warnings: [], waitingFor: [] });
    expect(plan1.items.map((item) => `${item.number} ${item.id} ${item.state} ${item.size} [${item.dependsOn.join(',')}] ${item.responsible?.displayName}/${item.responsible?.source}`)).toEqual([
      '1 cart-api not-started m [] Mei/agent', // as the agent proposed
      '2 checkout-page not-started l [cart-api] Ian/agent', // "ian": matched whatever the case
      '3 receipt-email not-started s [] Mei/smurg', // the agent named nobody smurg knows: smurg's even split
    ]);
    for (const member of everyone) expect(lastPlan(member, topicId)).toEqual(plan1);

    // ================================================================================================================
    // Who is responsible: one item reassigned; "no assignment, everyone watches"; then assigned again
    // ================================================================================================================
    expect(await refusal(amy.conn.request('plan.assign', { topicId, itemId: 'checkout-page', userId: AMY }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(mei.conn.request('plan.assign', { topicId, itemId: 'checkout-page', userId: LEO }))).toMatchObject({ code: 'bad_request', reason: 'not-eligible' });
    // An Editor can be chosen by hand: she reviews the report and votes; commands are allowed by Ian or Mei.
    expect(itemOf((await mei.conn.request('plan.assign', { topicId, itemId: 'checkout-page', userId: AMY })).plan, 'checkout-page')?.responsible).toEqual({ userId: AMY, displayName: 'Amy', source: 'chosen' });
    const watched = (await mei.conn.request('plan.mode.set', { topicId, mode: 'everyone' })).plan;
    expect(watched.mode).toBe('everyone');
    expect(watched.items.map((item) => item.responsible)).toEqual([null, null, null]);
    expect(watched.split).toBeUndefined();
    await planIs(leo, topicId, (plan) => plan.mode === 'everyone', '"no one assigned: everyone watches"');
    // With nobody assigned the member who presses Start decides the questions of every session she starts.
    expect((await mei.conn.request('plan.preflight', { topicId })).preflight).toMatchObject({ youDecide: 3, responsible: [{ itemId: 'cart-api', user: null }, { itemId: 'checkout-page', user: null }, { itemId: 'receipt-email', user: null }] });
    // Assigned again, by hand: Mei the cart, Amy the page, Ian the receipt.
    await mei.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: MEI });
    await mei.conn.request('plan.assign', { topicId, itemId: 'checkout-page', userId: AMY });
    const assigned = (await mei.conn.request('plan.assign', { topicId, itemId: 'receipt-email', userId: IAN })).plan;
    expect(assigned.mode).toBe('assigned');
    expect(assigned.items.map((item) => `${item.id} ${item.responsible?.displayName}/${item.responsible?.source}`)).toEqual(['cart-api Mei/chosen', 'checkout-page Amy/chosen', 'receipt-email Ian/chosen']);
    expect((await audited(flow, 'plan.assign', 'plan.mode')).map((entry) => `${entry.action} ${JSON.stringify(entry.detail)}`)).toEqual([
      `plan.assign ${JSON.stringify({ topicId, itemId: 'checkout-page', userId: AMY })}`,
      `plan.mode ${JSON.stringify({ topicId, mode: 'everyone' })}`,
      `plan.assign ${JSON.stringify({ topicId, itemId: 'cart-api', userId: MEI })}`,
      `plan.assign ${JSON.stringify({ topicId, itemId: 'checkout-page', userId: AMY })}`,
      `plan.assign ${JSON.stringify({ topicId, itemId: 'receipt-email', userId: IAN })}`,
    ]);

    // ================================================================================================================
    // Start: the dialog says what it will do; the spec and plan are committed and pinned; items run in worktrees
    // ================================================================================================================
    // Ian fixes a word in the spec by hand first: the dialog names him, the commit too.
    const SPEC_BY_IAN = SPEC_REVISED.replace('Buying a book takes one page.', 'Buying a book takes one page, not three.');
    await ian.conn.request('file.write', { file: { root: MAIN_ROOT, path: SPEC_PATH }, content: bytes(SPEC_BY_IAN) });
    await topicIs(leo, topicId, (topic) => topic.handEdits.spec.length === 1 && topic.plan.stale, 'the hand edit of the spec');
    expect(lastTopic(leo, topicId)).toMatchObject({ handEdits: { spec: [{ by: { userId: IAN, displayName: 'Ian' } }], plan: [] }, spec: { changedBy: { kind: 'user', userId: IAN } }, plan: { stale: true } });
    // Amy fixes one too, TYPING in the editor as a browser does (a shared document, saved by smurg): named as well.
    const amyEditor = await DocClient.open(amy.conn, { root: MAIN_ROOT, path: SPEC_PATH });
    await waitFor(() => amyEditor.synced && amyEditor.text.toString() === SPEC_BY_IAN, { what: "the spec in Amy's editor" });
    const SPEC_AT_START = SPEC_BY_IAN.replace('Cart, payment, receipt.', 'Cart, payment and receipt.');
    amyEditor.text.delete(SPEC_BY_IAN.indexOf('payment, receipt.') + 'payment'.length, 1);
    amyEditor.text.insert(SPEC_BY_IAN.indexOf('payment, receipt.') + 'payment'.length, ' and');
    await waitFor(async () => (await text(SPEC_PATH, flow)) === SPEC_AT_START, { what: "the autosave of Amy's typing" });
    await topicIs(leo, topicId, (topic) => topic.handEdits.spec.length === 2 && topic.spec.changedBy?.kind === 'user' && topic.spec.changedBy.userId === AMY, "Amy's typing as a hand edit");
    expect(lastTopic(leo, topicId)).toMatchObject({ handEdits: { spec: [{ by: { userId: IAN } }, { by: { userId: AMY, displayName: 'Amy' } }], plan: [] }, plan: { stale: true } });
    expect(await refusal(amy.conn.request('plan.preflight', { topicId }))).toMatchObject({ code: 'forbidden' });
    const headBefore = await flow.git(['rev-parse', 'HEAD']);
    const { preflight } = await mei.conn.request('plan.preflight', { topicId });
    expect(preflight).toMatchObject({
      planRevision: 1,
      startsNow: ['cart-api', 'receipt-email'],
      waits: [{ itemId: 'checkout-page', for: ['cart-api'] }],
      alreadyStarted: [],
      responsible: [{ itemId: 'cart-api', user: { userId: MEI }, online: true }, { itemId: 'checkout-page', user: { userId: AMY }, online: true }, { itemId: 'receipt-email', user: { userId: IAN }, online: true }],
      youDecide: 1,
      commit: { needed: true, branch: 'main', as: { userId: MEI }, files: [SPEC_PATH, PLAN_PATH], alsoInFolder: [] },
      handEdits: { spec: [{ by: { userId: IAN } }, { by: { userId: AMY } }], plan: [] },
      stale: true,
      openQuestion: false,
      specOpenQuestions: 0,
      projectSettings: 'used',
      rules: [],
      blockers: [],
    });
    // A Start with pins that are not what the files say now is refused (the dialog reloads).
    expect(await refusal(mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: 'f'.repeat(64), planHash: preflight.planHash }))).toMatchObject({ code: 'conflict', reason: 'plan-changed' });
    expect(await refusal(amy.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash }))).toMatchObject({ code: 'forbidden' });
    expect(await flow.git(['rev-parse', 'HEAD'])).toBe(headBefore);
    const launchesBefore = await launches(flow);
    const started = (await mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash })).plan;

    // ---- the checkpoint commit: exactly the two files, as Mei, with who edited them by hand
    expect(await flow.git(['log', '-1', '--format=%s%n%an%n%(trailers:key=Edited-by,valueonly)'])).toBe('smurg: spec and plan of checkout\nMei\nIan\nAmy');
    expect((await flow.git(['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()).toEqual([PLAN_PATH, SPEC_PATH]);
    expect(await flow.git(['rev-parse', 'HEAD~1'])).toBe(headBefore);
    expect(await flow.git(['status', '--porcelain'])).toBe('');
    const pinned = await flow.git(['rev-parse', 'HEAD']);
    expect((await audited(flow, 'spec.commit', 'plan.start')).map((entry) => `${entry.action} ${entry.outcome} ${entry.actor.kind === 'user' ? entry.actor.userId : entry.actor.kind}`)).toEqual([`spec.commit ok ${MEI}`, `plan.start ok ${MEI}`]);
    expect((await audited(flow, 'plan.start'))[0]?.detail).toMatchObject({ itemIds: ['cart-api', 'checkout-page', 'receipt-email'], planRevision: 1, commit: pinned, committed: true });
    await topicIs(leo, topicId, (topic) => topic.phase === 'executing' && topic.handEdits.spec.length === 0, 'the started topic');

    // ---- one agent session per item that can start, each in its own worktree; the dependent item waits
    expect(started.items.map((item) => `${item.id} ${item.state} ${item.armed ? 'armed' : '-'} by ${item.startedBy?.displayName} waits for [${(item.waitsFor ?? []).join(',')}]`)).toEqual([
      'cart-api running - by Mei waits for []',
      'checkout-page waiting armed by Mei waits for [cart-api]',
      'receipt-email running - by Mei waits for []',
    ]);
    expect(started.slots).toMatchObject({ inUse: 2 });
    const cartId = itemOf(started, 'cart-api')?.sessionId as string;
    const receiptId = itemOf(started, 'receipt-email')?.sessionId as string;
    const cartWt = itemOf(started, 'cart-api')?.worktreeId as string;
    const receiptWt = itemOf(started, 'receipt-email')?.worktreeId as string;
    expect(itemOf(started, 'checkout-page')?.sessionId).toBeUndefined();
    expect((await leo.conn.request('worktree.list', {})).worktrees).toMatchObject([
      { id: cartWt, ownerUserId: MEI, branch: 'smurg/checkout/cart-api', topicId, itemId: 'cart-api' },
      { id: receiptWt, ownerUserId: MEI, branch: 'smurg/checkout/receipt-email', topicId, itemId: 'receipt-email' },
    ]);
    const sessions = (await leo.conn.request('session.list', { topicId })).sessions as AgentSession[];
    expect(sessions.map((session) => `${session.purpose} ${session.itemId ?? ''} ${session.item?.number ?? ''} ${session.responsible?.displayName ?? '-'} ${session.permissionMode} ${session.branch ?? ''}`)).toEqual([
      'discussion   - ask-all ',
      'item cart-api 1 Mei ask-commands smurg/checkout/cart-api',
      'item receipt-email 3 Ian ask-commands smurg/checkout/receipt-email',
    ]);
    expect((await audited(flow, 'scheduler.start')).map((entry) => entry.detail)).toMatchObject([
      { topicId, itemId: 'cart-api', sessionId: cartId, worktreeId: cartWt, attempt: 1, startedBy: MEI, commit: pinned },
      { topicId, itemId: 'receipt-email', sessionId: receiptId, worktreeId: receiptWt, attempt: 1, startedBy: MEI, commit: pinned },
    ]);
    for (const member of everyone) for (const id of [cartId, receiptId]) await member.watch(id);
    const cartRoot = flow.d.ctx.roots.get({ kind: 'worktree', worktreeId: cartWt })?.realPath as string;
    const receiptRoot = flow.d.ctx.roots.get({ kind: 'worktree', worktreeId: receiptWt })?.realPath as string;
    // Each checkout holds the spec and the plan exactly as they were pinned.
    expect(await text(SPEC_PATH, flow, cartRoot)).toBe(SPEC_AT_START);
    expect(await text(PLAN_PATH, flow, receiptRoot)).toBe(PLAN);

    // ================================================================================================================
    // Work item 1: edits in its worktree are automatic, the spec is not its to change, a command asks its responsible
    // person; "always allow pnpm test in every session of this topic"
    // ================================================================================================================
    const asked = await permissionAt(leo, (request) => request.sessionId === cartId && request.status === 'open', 'the command of work item 1');
    expect(asked).toMatchObject({ tool: 'Bash', what: 'command', command: 'pnpm test', root: { kind: 'worktree', worktreeId: cartWt }, hostOnly: false, alwaysRule: { tool: 'Bash', pattern: 'pnpm test *' } });
    // Mei is responsible for the item and may allow: the request is hers alone.
    const askedItem = await inboxItem(mei, (item) => item.key === `permission:${asked.id}`, 'the request of her item');
    expect(askedItem).toMatchObject({ kind: 'permission', topicId, itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, sessionId: cartId, excerpt: 'pnpm test' });
    expect(askedItem.alsoFor).toBeUndefined();
    expect((await ian.inbox()).some((item) => item.key === `permission:${asked.id}`)).toBe(false);
    // What ran before the card, without one: two edits in the worktree. What did not: the edit of the spec.
    const cartSoFar = leo.events(cartId);
    expect(cartSoFar.filter((event) => event.kind === 'card')).toHaveLength(1);
    const cartTools = cartSoFar.filter((event): event is Extract<ConversationEvent, { kind: 'tool.finished' }> => event.kind === 'tool.finished');
    expect(cartTools.map((event) => event.ok)).toEqual([true, true, false]);
    expect(cartTools[2]?.result.body).toMatchObject({ text: expect.stringContaining("A work item's session does not change its topic's SPEC.md or PLAN.md.") });
    expect(await text('src/cart/total.ts', flow, cartRoot)).toContain('export const total');
    expect(await text('src/app.ts', flow, cartRoot)).toBe(APP_BY_CART);
    expect(await text(SPEC_PATH, flow, cartRoot)).toBe(SPEC_AT_START);
    // Nothing of it is in the main workspace: the work is in the item's own checkout.
    expect(await text('src/app.ts', flow)).toBe(APP_BEFORE);
    await expect(text('src/cart/total.ts', flow)).rejects.toMatchObject({ code: 'ENOENT' });
    // The item's agent was started with its own role prompt and smurg's first message.
    const cartPrompt = (await flow.claude.echoed()).filter((entry) => entry.kind === 'role-prompt' && entry.session === cartId).map((entry) => String(entry.value));
    expect(cartPrompt).toHaveLength(1);
    expect(cartPrompt[0]).toContain('You are the agent for ONE work item of a topic in a shared smurg workspace: the item with the id cart-api in');
    expect(cartPrompt[0]).toContain('Your working directory is a checkout of your own on the branch smurg/checkout/cart-api.');
    expect(cartPrompt[0]).toContain('<!-- smurg:report v1 item=cart-api -->');
    expect((await told(flow, cartId))[0]).toMatch(/^\[smurg [a-z0-9]{4}\]\nStart work item 1 \(id cart-api\)\. Its title and description are in specs\/checkout\/PLAN\.md\. Responsible for this item: Mei\.$/);
    expect(await launches(flow)).toBe(launchesBefore + 2);

    // ---- "always allow this kind in every session of this topic"
    expect(await refusal(amy.conn.request('permission.decide', { requestId: asked.id, decision: 'allow-always', scope: 'topic' }))).toMatchObject({ code: 'forbidden' });
    expect((await mei.conn.request('permission.decide', { requestId: asked.id, decision: 'allow-always', scope: 'topic' })).request).toMatchObject({ status: 'allowed', decision: { by: { userId: MEI }, always: 'topic' } });
    const ruled = await topicIs(leo, topicId, (topic) => topic.rules.length === 1, "the topic's remembered rule");
    expect(ruled.rules).toMatchObject([{ tool: 'Bash', pattern: 'pnpm test *', scope: 'topic', addedBy: { userId: MEI } }]);
    await eventOf(leo, cartId, (event) => event.kind === 'line' && event.text.id === 'conversation.rule.added.topic', 'the line about the rule');
    expect((await audited(flow, 'topic.rule.add')).map((entry) => entry.detail)).toMatchObject([{ topicId, rule: 'Bash(pnpm test *)' }]);

    // ---- the item finishes its turn with a checked report: a version, a draft of its changes, the reviewer's inbox
    await turnsFinished(leo, cartId, 1);
    await waitFor(() => leo.got('report.updated').some((update) => update.itemId === 'cart-api'), { timeoutMs: 30_000, what: 'the report of work item 1' });
    await eventOf(leo, cartId, (event) => event.kind === 'pointer' && event.target === 'report', "the report's card in the item's conversation");
    const cartEvents = leo.events(cartId);
    expect(kinds(cartEvents)).toEqual([
      'line', // started from plan item 1
      'smurg', // start-item
      'delivery',
      'delivery',
      'turn.started',
      'tool.started', // Write src/cart/total.ts: no card
      'tool.finished',
      'tool.started', // Edit src/app.ts: no card
      'tool.finished',
      'tool.started', // Edit SPEC.md: refused by the gate
      'tool.finished',
      'tool.started', // pnpm test
      'card:permission',
      'line', // "Mei always allows Bash(pnpm test *) in every session of this topic"
      'tool.finished',
      'tool.started', // Write the report
      'tool.finished',
      'tool.started', // check_report
      'tool.finished',
      'text',
      'turn.finished',
      'delivery',
      'pointer', // the report
    ]);
    expect(cartEvents.at(-1)).toMatchObject({ kind: 'pointer', target: 'report', topicId, itemId: 'cart-api', version: 1 });
    for (const member of [ian, mei, amy]) expect(member.events(cartId)).toEqual(cartEvents);
    expect(leo.got('report.updated').filter((update) => update.itemId === 'cart-api')).toMatchObject([{ topicId, report: { version: 1, outcome: 'partial', state: 'to-review', reviewers: [{ userId: MEI }], checks: { passed: 1, notVerified: 1 } } }]);
    const report1 = (await leo.conn.request('report.get', { topicId, itemId: 'cart-api' })).report;
    expect(report1).toMatchObject({
      version: 1,
      outcome: 'partial',
      state: 'to-review',
      file: { root: { kind: 'worktree', worktreeId: cartWt }, path: reportPath('cart-api') },
      sections: { done: 'The work of Cart API.', why: 'As the spec decided.', verified: [{ text: '`pnpm test`: 3 tests passed', passed: true }, { text: 'Manual check in the browser', passed: false, note: 'no browser in this session' }], watchOut: 'The page was never opened in a browser.' },
      changes: { files: 3, byHand: [] },
      questions: [],
    });
    // The report's changes are a draft merge request every member can read, the Viewer too.
    const cartDraft = report1.changes?.requestId as string;
    expect((await leo.conn.request('worktree.merge.list', {})).requests).toMatchObject([{ id: cartDraft, worktreeId: cartWt, status: 'draft', reviewed: false, topicId, itemId: 'cart-api', message: 'smurg: work item 1 (cart-api)' }]);
    expect((await leo.conn.request('worktree.merge.diff', { requestId: cartDraft })).files.map((file) => `${file.status} ${file.path}`).sort()).toEqual([`added ${reportPath('cart-api')}`, 'added src/cart/total.ts', 'modified src/app.ts']);
    // It waits for its reviewer, and the plan says so.
    expect(await inboxItem(mei, (item) => item.kind === 'report', 'the report of her item')).toMatchObject({ key: `report:${topicId}.cart-api`, unread: true, waiting: false, topicId, itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, target: { kind: 'report', topicId, itemId: 'cart-api' }, outcome: 'partial', checks: { passed: 1, notVerified: 1 } });
    expect((await ian.inbox()).some((item) => item.kind === 'report')).toBe(false);
    const afterReport = await planIs(leo, topicId, (plan) => itemOf(plan, 'cart-api')?.state === 'done', 'work item 1 done');
    expect(itemOf(afterReport, 'cart-api')).toMatchObject({ state: 'done', report: { version: 1, outcome: 'partial', state: 'to-review' }, merge: { requestId: cartDraft, status: 'draft', ready: false } });
    expect(afterReport.waitingFor).toMatchObject([{ user: { userId: MEI }, questions: 0, permissions: 0, reports: 1 }]);
    expect((await audited(flow, 'report.register')).map((entry) => entry.detail)).toMatchObject([{ topicId, itemId: 'cart-api', version: 1, sessionId: cartId, outcome: 'partial', requestId: cartDraft }]);

    // ================================================================================================================
    // Work item 3 stopped without a report: nudged once, then it needs its responsible person
    // ================================================================================================================
    const stalled = await planIs(leo, topicId, (plan) => itemOf(plan, 'receipt-email')?.state === 'stalled', 'work item 3 stalled');
    expect(itemOf(stalled, 'receipt-email')).toMatchObject({ state: 'stalled', stalledBy: 'agent', responsible: { userId: IAN } });
    await statusIs(leo, receiptId, 'stalled');
    await turnsFinished(leo, receiptId, 2);
    await waitFor(() => leo.events(receiptId).at(-1)?.kind === 'delivery', { what: 'the end of the nudged turn of work item 3 at the Viewer' });
    const receiptEvents = leo.events(receiptId);
    expect(kinds(receiptEvents)).toEqual(['line', 'smurg', 'delivery', 'delivery', 'turn.started', 'tool.started', 'tool.finished', 'text', 'turn.finished', 'delivery', 'line', 'smurg', 'delivery', 'turn.started', 'text', 'turn.finished', 'delivery']);
    expect(receiptEvents[10]).toMatchObject({ kind: 'line', text: { id: 'conversation.nudge.report' } });
    expect(receiptEvents[11]).toMatchObject({ kind: 'smurg', purpose: 'nudge-report', text: 'You stopped without the result report. If you need a decision, ask it with AskUserQuestion. If you are finished, write the report and call check_report.' });
    // Ian is responsible for the item: the attention item is his, not Mei's (who started it) and not Amy's.
    const stalledItem = await inboxItem(ian, (item) => item.kind === 'attention' && item.subject === 'item-stalled', 'the stalled item');
    expect(stalledItem).toMatchObject({ key: `attention:item-stalled:${topicId}.receipt-email`, waiting: true, unread: true, topicId, itemId: 'receipt-email', item: { number: 3, title: 'Receipt email' }, sessionId: receiptId, target: { kind: 'session', sessionId: receiptId } });
    expect((await mei.inbox()).some((item) => item.kind === 'attention')).toBe(false);
    expect(await amy.inbox()).toEqual([]);
    expect((await told(flow, receiptId)).map((message) => message.replace(/^\[smurg [a-z0-9]{4}\]\n/, ''))).toEqual([
      'Start work item 3 (id receipt-email). Its title and description are in specs/checkout/PLAN.md. Responsible for this item: Ian.',
      'You stopped without the result report. If you need a decision, ask it with AskUserQuestion. If you are finished, write the report and call check_report.',
    ]);

    // ================================================================================================================
    // Amy edits the spec after Start: what waited is disarmed, nothing of her text reaches an agent; Mei arms it again
    // ================================================================================================================
    const launchesBeforeEdit = await launches(flow);
    // She types in the editor she already typed in before the Start, seconds ago. (The activity feed has one "edited"
    // entry per person and file per minute; the topic knows the hand edit all the same: the next Start must name her.)
    const SPEC_BY_AMY = SPEC_AT_START.replace('Invoices. Coupons.', `Invoices. Coupons. ${AMY_SPEC_EDIT}`);
    expect(amyEditor.text.toString()).toBe(SPEC_AT_START);
    amyEditor.text.insert(SPEC_AT_START.indexOf('Invoices. Coupons.') + 'Invoices. Coupons.'.length, ` ${AMY_SPEC_EDIT}`);
    await waitFor(async () => (await text(SPEC_PATH, flow)) === SPEC_BY_AMY, { what: "the autosave of Amy's edit" });
    const disarmed = await planIs(leo, topicId, (plan) => itemOf(plan, 'checkout-page')?.disarmed !== undefined, 'the disarmed item');
    expect(itemOf(disarmed, 'checkout-page')).toMatchObject({ state: 'not-started', armed: false, disarmed: 'plan-changed', startError: { text: { id: 'plan.item.disarmed.changed' } } });
    expect((await audited(flow, 'scheduler.disarm')).map((entry) => entry.detail)).toMatchObject([{ topicId, itemId: 'checkout-page', reason: 'plan-changed', startedBy: MEI }]);
    expect(await topicIs(leo, topicId, (topic) => topic.handEdits.spec.length === 1 && topic.spec.changedBy?.kind === 'user', "Amy's hand edit")).toMatchObject({ handEdits: { spec: [{ by: { userId: AMY, displayName: 'Amy' } }], plan: [] }, spec: { changedBy: { kind: 'user', userId: AMY } }, plan: { stale: true } });
    // In the feed and the audit log her typing in this file is still one entry for the minute.
    expect((await leo.conn.request('activity.list', { limit: 500 })).events.filter((event) => event.kind === 'human.edit' && event.actor.kind === 'user' && event.actor.userId === AMY && event.file?.path === SPEC_PATH)).toHaveLength(1);
    // She closes the editor (her lock on the file goes with it).
    amyEditor.close();
    // The member who pressed Start and the host are told; "Show the changes" shows what changed since the Start.
    for (const member of [mei, ian]) expect(await inboxItem(member, (item) => item.kind === 'attention' && item.subject === 'item-not-started', 'the item that will not start')).toMatchObject({ waiting: true, topicId, itemId: 'checkout-page', target: { kind: 'plan', topicId } });
    const changes = await leo.conn.request('plan.changes', { topicId });
    expect(changes.files.map((file) => file.target)).toEqual(['spec']);
    expect(changes.files[0]?.diff).toContain(`+Invoices. Coupons. ${AMY_SPEC_EDIT}`);
    // Nothing of it reached an agent: no session started, the running items keep the copy they started from, and the
    // text is in nothing any agent process was given.
    expect(await launches(flow)).toBe(launchesBeforeEdit);
    expect(await text(SPEC_PATH, flow, cartRoot)).toBe(SPEC_AT_START);
    expect(await text(SPEC_PATH, flow, receiptRoot)).toBe(SPEC_AT_START);
    expect(await everythingAgentsReceived(flow)).not.toContain('amy-spec-edit');
    // Nobody can write the spec copy or the report inside an item's worktree: not an Editor, not Mei, not the host.
    for (const member of [amy, mei, ian]) {
      expect(await refusal(member.conn.request('file.write', { file: { root: { kind: 'worktree', worktreeId: cartWt }, path: SPEC_PATH }, content: bytes('mine\n') }))).toMatchObject({ code: 'path_denied' });
      expect(await refusal(member.conn.request('file.write', { file: { root: { kind: 'worktree', worktreeId: cartWt }, path: reportPath('cart-api') }, content: bytes('mine\n') }))).toMatchObject({ code: 'path_denied' });
    }
    // An Editor cannot arm it; Mei sees who edited what in the dialog and presses Start for that one item.
    const again = (await mei.conn.request('plan.preflight', { topicId, itemIds: ['checkout-page'] })).preflight;
    expect(again).toMatchObject({ startsNow: [], waits: [{ itemId: 'checkout-page', for: ['cart-api'] }], alreadyStarted: ['cart-api', 'receipt-email'], commit: { needed: true, as: { userId: MEI } }, handEdits: { spec: [{ by: { userId: AMY } }], plan: [] }, rules: [{ pattern: 'pnpm test *' }], blockers: [] });
    expect(await refusal(amy.conn.request('plan.start', { topicId, itemIds: ['checkout-page'], planRevision: again.planRevision, specHash: again.specHash, planHash: again.planHash }))).toMatchObject({ code: 'forbidden' });
    const rearmed = (await mei.conn.request('plan.start', { topicId, itemIds: ['checkout-page'], planRevision: again.planRevision, specHash: again.specHash, planHash: again.planHash })).plan;
    expect(itemOf(rearmed, 'checkout-page')).toMatchObject({ state: 'waiting', armed: true, waitsFor: ['cart-api'], startedBy: { userId: MEI } });
    expect(itemOf(rearmed, 'checkout-page')?.disarmed).toBeUndefined();
    expect(await flow.git(['log', '-1', '--format=%s%n%an%n%(trailers:key=Edited-by,valueonly)'])).toBe('smurg: spec and plan of checkout\nMei\nAmy');
    expect(await flow.git(['show', '--name-only', '--format=', 'HEAD'])).toBe(SPEC_PATH);
    for (const member of [mei, ian]) await inboxWithout(member, (item) => item.kind === 'attention' && item.subject === 'item-not-started', 'the armed item');
    expect(await launches(flow)).toBe(launchesBeforeEdit);

    // ================================================================================================================
    // "Continue" for work item 3: its command is of the kind the topic always allows, so nobody is asked
    // ================================================================================================================
    expect(await refusal(amy.conn.request('plan.item.continue', { topicId, itemId: 'receipt-email' }))).toMatchObject({ code: 'forbidden' });
    await ian.conn.request('plan.item.continue', { topicId, itemId: 'receipt-email' });
    await waitFor(() => leo.got('report.updated').some((update) => update.itemId === 'receipt-email'), { timeoutMs: 30_000, what: 'the report of work item 3' });
    await eventOf(leo, receiptId, (event) => event.kind === 'pointer' && event.target === 'report', "the report's card of work item 3");
    const continued = leo.events(receiptId).slice(receiptEvents.length);
    // No card: the daemon answered the request itself with the topic's rule (what a click on "Always allow" would send).
    expect(kinds(continued)).toEqual(['line', 'smurg', 'delivery', 'turn.started', 'tool.started', 'tool.finished', 'tool.started', 'tool.finished', 'tool.started', 'tool.finished', 'text', 'turn.finished', 'delivery', 'pointer']);
    expect(continued[0]).toMatchObject({ text: { id: 'conversation.continueRequested', params: { name: 'Ian' } } });
    expect(continued[1]).toMatchObject({ kind: 'smurg', purpose: 'continue-item', by: { userId: IAN } });
    expect((await audited(flow, 'permission.auto')).map((entry) => entry.detail)).toMatchObject([{ sessionId: receiptId, tool: 'Bash', answer: 'topic-rule', topicId, rule: 'Bash(pnpm test *)' }]);
    expect(leo.got('permission.updated').filter((update) => update.request.sessionId === receiptId)).toEqual([]);
    await inboxWithout(ian, (item) => item.key === stalledItem.key, 'the item that goes on');
    expect(await inboxItem(ian, (item) => item.kind === 'report', 'the report of his item')).toMatchObject({ key: `report:${topicId}.receipt-email`, outcome: 'complete', checks: { passed: 1, notVerified: 0 } });
    await planIs(leo, topicId, (plan) => itemOf(plan, 'receipt-email')?.state === 'done', 'work item 3 done');

    // ================================================================================================================
    // The report of work item 1: a follow-up question, "I've reviewed this", the host merges, what waited starts
    // ================================================================================================================
    // ---- a follow-up: Mei's is a message to the item's session; Amy's is a suggestion (rejected here)
    const followUp = await mei.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: 'Why is it partial?' });
    if (!('messageId' in followUp)) throw new Error("a follow-up of a member with agent access must be a message");
    await turnsFinished(leo, cartId, 2);
    const answeredReport = (await leo.conn.request('report.get', { topicId, itemId: 'cart-api' })).report;
    expect(answeredReport.questions).toMatchObject([{ from: { userId: MEI }, text: 'Why is it partial?', answer: { text: 'The browser check needs a display, and this session has none.' } }]);
    expect(answeredReport).toMatchObject({ version: 1, state: 'to-review' });
    expect((await told(flow, cartId)).at(-1)).toBe('[Mei · Agent access]\nWhy is it partial?');
    expect(leo.events(cartId).find((event) => event.kind === 'message')).toMatchObject({ messageId: followUp.messageId, from: { userId: MEI }, origin: 'follow-up' });
    const amyAsks = await amy.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: 'Please also open it in a browser (amy-follow-up-55d0).' });
    if (!('suggestion' in amyAsks)) throw new Error("an Editor's follow-up must be a suggestion");
    expect(amyAsks.suggestion).toMatchObject({ sessionId: cartId, origin: 'follow-up', topicId, itemId: 'cart-api', status: 'pending' });
    // Mei is responsible for the session: the suggestion is hers alone to settle.
    expect((await inboxItem(mei, (item) => item.kind === 'suggestion', "Amy's follow-up")).alsoFor).toBeUndefined();
    await mei.conn.request('suggest.reject', { suggestionId: amyAsks.suggestion.id });
    await inboxItem(amy, (item) => item.kind === 'result', 'the result of her follow-up');
    expect((await leo.conn.request('report.get', { topicId, itemId: 'cart-api' })).report.questions).toHaveLength(1);

    // ---- "I've reviewed this": the reviewer only; unfinished work only on purpose
    expect(await refusal(leo.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(amy.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 }))).toMatchObject({ code: 'forbidden', reason: 'not-reviewer' });
    expect(await refusal(ian.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 }))).toMatchObject({ code: 'forbidden', reason: 'not-reviewer' });
    expect(await refusal(mei.conn.request('report.review', { topicId, itemId: 'cart-api', version: 2 }))).toMatchObject({ code: 'conflict', reason: 'report-changed' });
    expect(await refusal(mei.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 }))).toMatchObject({ code: 'conflict', reason: 'unfinished', id: 'report.unfinished' });
    expect((await mei.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1, acknowledgeUnfinished: true })).report).toMatchObject({ state: 'reviewed', review: { by: { userId: MEI }, version: 1 } });
    await inboxWithout(mei, (item) => item.kind === 'report', 'the reviewed report');
    const reviewed = await planIs(leo, topicId, (plan) => itemOf(plan, 'cart-api')?.merge?.ready === true, 'work item 1 reviewed, ready to merge');
    expect(itemOf(reviewed, 'cart-api')).toMatchObject({ state: 'reviewed', report: { state: 'reviewed' }, merge: { requestId: cartDraft, status: 'draft', ready: true } });
    // ---- the reviewed draft is in the host's inbox by itself, and says what waits for it
    const mergeItem = await inboxItem(ian, (item) => item.kind === 'merge', 'the change to merge');
    expect(mergeItem).toMatchObject({ key: `merge:${cartDraft}`, unread: true, waiting: false, topicId, itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, target: { kind: 'changes', requestId: cartDraft }, ready: true, unblocks: [2], conflict: false });
    expect((await mei.inbox()).some((item) => item.kind === 'merge')).toBe(false);
    expect(await refusal(mei.conn.request('worktree.merge.approve', { requestId: cartDraft }))).toMatchObject({ code: 'forbidden' });

    // ---- the host merges: the item is finished, and the item that waited for it starts by itself
    const launchesBeforeMerge = await launches(flow);
    expect((await ian.conn.request('worktree.merge.approve', { requestId: cartDraft })).request).toMatchObject({ id: cartDraft, status: 'merged', reviewed: true, topicId, itemId: 'cart-api' });
    expect(await text('src/cart/total.ts', flow)).toContain('export const total');
    expect(await text('src/app.ts', flow)).toBe(APP_BY_CART);
    expect(await text(reportPath('cart-api'), flow)).toBe(report('cart-api', 'Cart API', 'partial'));
    await inboxWithout(ian, (item) => item.key === mergeItem.key, 'the merged change');
    await statusIs(leo, cartId, 'ended');
    expect((await leo.conn.request('session.list', { topicId })).sessions.find((session) => session.id === cartId)).toMatchObject({ status: 'ended', endReason: 'merged' });
    await waitFor(() => leo.got('worktree.removed').some((update) => update.worktreeId === cartWt), { timeoutMs: 30_000, what: "the finished item's worktree to go" });
    // Its conversation and its report stay readable; a follow-up now points to the discussion.
    expect((await leo.conn.request('session.watch', { sessionId: cartId })).events.length).toBeGreaterThan(20);
    expect((await leo.conn.request('report.get', { topicId, itemId: 'cart-api' })).report).toMatchObject({ state: 'reviewed', version: 1 });
    expect(await refusal(mei.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: 'One more thing' }))).toMatchObject({ code: 'conflict', reason: 'closed', id: 'report.closed' });

    const running2 = await planIs(leo, topicId, (plan) => itemOf(plan, 'checkout-page')?.sessionId !== undefined, 'work item 2 started');
    const pageId = itemOf(running2, 'checkout-page')?.sessionId as string;
    const pageWt = itemOf(running2, 'checkout-page')?.worktreeId as string;
    expect(itemOf(running2, 'cart-api')).toMatchObject({ state: 'reviewed', merge: { status: 'merged' } });
    expect(itemOf(running2, 'cart-api')?.worktreeId).toBeUndefined();
    for (const member of everyone) await member.watch(pageId);
    await waitFor(async () => (await launches(flow, pageId)) === 1, { timeoutMs: 30_000, what: 'the process of work item 2' });
    expect(await launches(flow)).toBe(launchesBeforeMerge + 1);
    const pageRoot = flow.d.ctx.roots.get({ kind: 'worktree', worktreeId: pageWt })?.realPath as string;
    // Its checkout is the main workspace as it is now: what item 1 merged, and the spec with Amy's sentence, which Mei
    // confirmed when she pressed Start again.
    expect(await text('src/cart/total.ts', flow, pageRoot)).toContain('export const total');
    expect(await text(SPEC_PATH, flow, pageRoot)).toBe(SPEC_BY_AMY);

    // ---- work item 2: Amy (an Editor) is responsible. Its `pnpm test` is not asked at all: the session was started
    // with the topic's rule in its settings.
    await waitFor(() => leo.got('report.updated').some((update) => update.itemId === 'checkout-page'), { timeoutMs: 30_000, what: 'the report of work item 2' });
    await eventOf(leo, pageId, (event) => event.kind === 'pointer' && event.target === 'report', "the report's card of work item 2");
    expect(leo.events(pageId).filter((event) => event.kind === 'card')).toEqual([]);
    expect(leo.got('permission.updated').filter((update) => update.request.sessionId === pageId)).toEqual([]);
    expect((await audited(flow, 'permission.auto'))).toHaveLength(1);
    const pageSettings = (await flow.claude.echoed()).find((entry) => entry.kind === 'settings' && entry.session === pageId)?.value as { permissions?: { allow?: string[] } };
    expect(pageSettings.permissions?.allow).toContain('Bash(pnpm test *)');
    expect((await told(flow, pageId))[0]).toMatch(/Start work item 2 \(id checkout-page\)\. .* Responsible for this item: Amy\.$/);
    // The report is in Amy's inbox; she reviews it; the host merges.
    expect(await inboxItem(amy, (item) => item.kind === 'report', 'the report of her item')).toMatchObject({ topicId, itemId: 'checkout-page', outcome: 'complete' });
    expect((await amy.conn.request('report.review', { topicId, itemId: 'checkout-page', version: 1 })).report).toMatchObject({ state: 'reviewed', review: { by: { userId: AMY } } });
    const pageDraft = (await leo.conn.request('report.get', { topicId, itemId: 'checkout-page' })).report.changes?.requestId as string;
    await inboxItem(ian, (item) => item.key === `merge:${pageDraft}` && item.ready === true, "the change of work item 2");
    expect((await ian.conn.request('worktree.merge.approve', { requestId: pageDraft })).request).toMatchObject({ status: 'merged' });
    await statusIs(leo, pageId, 'ended');
    expect(await text('src/checkout/page.ts', flow)).toBe('export const page = "checkout";\n');

    // ================================================================================================================
    // A merge conflict: work item 3 changed the line work item 1 changed. smurg merges, the agent resolves
    // ================================================================================================================
    const receiptDraft = (await leo.conn.request('report.get', { topicId, itemId: 'receipt-email' })).report.changes?.requestId as string;
    expect((await ian.conn.request('report.review', { topicId, itemId: 'receipt-email', version: 1 })).report).toMatchObject({ state: 'reviewed' });
    const conflicted = (await ian.conn.request('worktree.merge.approve', { requestId: receiptDraft })).request;
    expect(conflicted).toMatchObject({ id: receiptDraft, status: 'conflict', conflictFiles: ['src/app.ts'], reviewed: true });
    // Nothing of it reached the main workspace; the host's inbox keeps the request, marked; the plan says so.
    expect(await text('src/app.ts', flow)).toBe(APP_BY_CART);
    expect(await inboxItem(ian, (item) => item.key === `merge:${receiptDraft}`, 'the conflicted change')).toMatchObject({ kind: 'merge', conflict: true, ready: false, itemId: 'receipt-email' });
    await planIs(leo, topicId, (plan) => itemOf(plan, 'receipt-email')?.merge?.status === 'conflict', 'the conflict in the plan');
    expect(await refusal(amy.conn.request('plan.item.resolve', { topicId, itemId: 'receipt-email' }))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(mei.conn.request('plan.item.resolve', { topicId, itemId: 'cart-api' }))).toMatchObject({ code: 'conflict', reason: 'no-conflict' });

    // ---- "Resolve": smurg merges the main workspace into the item's checkout and tells the agent which files to fix
    const beforeResolve = leo.events(receiptId).length;
    await mei.conn.request('plan.item.resolve', { topicId, itemId: 'receipt-email' });
    await waitFor(() => leo.got('report.updated').some((update) => update.itemId === 'receipt-email' && update.report.version === 2), { timeoutMs: 30_000, what: 'the report after the conflict was resolved' });
    await eventOf(leo, receiptId, (event) => event.kind === 'pointer' && event.target === 'report' && event.version === 2, "the new report's card");
    const resolveTurn = leo.events(receiptId).slice(beforeResolve);
    expect(kinds(resolveTurn)).toEqual(['line', 'line', 'smurg', 'delivery', 'turn.started', 'tool.started', 'tool.finished', 'tool.started', 'tool.finished', 'tool.started', 'tool.finished', 'text', 'turn.finished', 'delivery', 'pointer']);
    expect(resolveTurn[0]).toMatchObject({ text: { id: 'conversation.resolveRequested', params: { name: 'Mei' } } });
    expect(resolveTurn[1]).toMatchObject({ text: { id: 'conversation.conflict.merged', params: { count: 1 } } });
    expect(resolveTurn[2]).toMatchObject({ kind: 'smurg', purpose: 'resolve-conflict', by: { userId: MEI }, text: 'smurg merged the main workspace into your checkout. These files have conflict markers: ["src/app.ts"]. Resolve them, verify again, update the report and call check_report. Do not run git.' });
    expect(await text('src/app.ts', flow, receiptRoot)).toBe(APP_RESOLVED);
    // ---- a NEW draft (the conflicted request is gone), and the report asks for its review again
    const resolvedReport = (await leo.conn.request('report.get', { topicId, itemId: 'receipt-email' })).report;
    expect(resolvedReport).toMatchObject({ version: 2, state: 'changed-after-review', outcome: 'complete', review: { by: { userId: IAN }, version: 1 } });
    const resolvedDraft = resolvedReport.changes?.requestId as string;
    expect(resolvedDraft).not.toBe(receiptDraft);
    const requests = (await leo.conn.request('worktree.merge.list', {})).requests;
    expect(requests.find((request) => request.id === receiptDraft)).toBeUndefined();
    expect(requests.find((request) => request.id === resolvedDraft)).toMatchObject({ status: 'draft', reviewed: false, itemId: 'receipt-email' });
    await inboxWithout(ian, (item) => item.key === `merge:${receiptDraft}`, 'the conflicted request');
    expect(await inboxItem(ian, (item) => item.kind === 'report', 'the report to review again')).toMatchObject({ itemId: 'receipt-email', unread: true });
    // The resolution is a commit with two parents: the item's own work and the main workspace it was merged with.
    const resolvedCommit = requests.find((request) => request.id === resolvedDraft)?.commit as string;
    expect((await flow.git(['rev-list', '--parents', '-n', '1', resolvedCommit])).split(' ')).toHaveLength(3);
    expect((await flow.git(['rev-list', '--parents', '-n', '1', resolvedCommit])).split(' ')[2]).toBe(await flow.git(['rev-parse', 'HEAD']));

    // ---- reviewed again; the host's approve is clean now
    expect(await refusal(ian.conn.request('report.review', { topicId, itemId: 'receipt-email', version: 1 }))).toMatchObject({ code: 'conflict', reason: 'report-changed' });
    expect((await ian.conn.request('report.review', { topicId, itemId: 'receipt-email', version: 2 })).report).toMatchObject({ state: 'reviewed', review: { by: { userId: IAN }, version: 2 } });
    expect(await inboxItem(ian, (item) => item.key === `merge:${resolvedDraft}`, 'the resolved change')).toMatchObject({ ready: true, conflict: false });
    expect((await ian.conn.request('worktree.merge.approve', { requestId: resolvedDraft })).request).toMatchObject({ status: 'merged' });
    expect(await text('src/app.ts', flow)).toBe(APP_RESOLVED);
    expect(await text(reportPath('receipt-email'), flow)).toBe(report('receipt-email', 'Receipt email', 'complete', ' The title names both now.'));
    await statusIs(leo, receiptId, 'ended');
    expect(await flow.git(['status', '--porcelain'])).toBe('');
    expect((await audited(flow, 'plan.item.resolve')).map((entry) => entry.detail)).toMatchObject([{ topicId, itemId: 'receipt-email', sessionId: receiptId, conflicted: 1 }]);

    // ================================================================================================================
    // Every item is reviewed: the topic is complete. Archive
    // ================================================================================================================
    const complete = await topicIs(leo, topicId, (topic) => topic.phase === 'complete', 'the complete topic');
    expect(complete.plan).toMatchObject({ items: 3, started: 3, reviewed: 3, merged: 3, paused: false });
    await waitFor(async () => (await leo.conn.request('worktree.list', {})).worktrees.length === 0, { timeoutMs: 30_000, what: 'every item worktree to be gone' });
    for (const member of everyone) expect((await member.inbox()).filter((item) => item.kind !== 'result')).toEqual([]);
    expect((await leo.conn.request('plan.get', { topicId })).plan?.items.map((item) => `${item.id} ${item.state} ${item.merge?.status} ${item.report?.state}`)).toEqual(['cart-api reviewed merged reviewed', 'checkout-page reviewed merged reviewed', 'receipt-email reviewed merged reviewed']);
    // The topic gets a better name: the folder keeps its slug, every session of the topic carries the new name.
    expect(await refusal(amy.conn.request('topic.rename', { topicId, name: 'Checkout on one page' }))).toMatchObject({ code: 'forbidden' });
    expect((await mei.conn.request('topic.rename', { topicId, name: 'Checkout on one page' })).topic).toMatchObject({ name: 'Checkout on one page', slug: SLUG });
    await topicIs(leo, topicId, (topic) => topic.name === 'Checkout on one page', 'the renamed topic');
    await waitFor(async () => (await leo.conn.request('session.list', { topicId })).sessions.every((session) => session.kind === 'agent' && session.topicName === 'Checkout on one page'), { what: 'the sessions to carry the new name' });
    expect(await text(SPEC_PATH, flow)).toBe(SPEC_BY_AMY);
    expect(await refusal(amy.conn.request('topic.archive', { topicId, archived: true }))).toMatchObject({ code: 'forbidden' });
    expect((await mei.conn.request('topic.archive', { topicId, archived: true })).topic).toMatchObject({ archived: true, phase: 'complete' });
    await topicIs(leo, topicId, (topic) => topic.archived, 'the archived topic');
    await statusIs(leo, discussionId, 'ended');
    expect((await leo.conn.request('session.list', { topicId })).sessions.map((session) => `${session.kind === 'agent' ? session.purpose : ''} ${session.status} ${session.endReason}`)).toEqual(['discussion ended archived', 'item ended merged', 'item ended merged', 'item ended merged']);
    expect((await leo.conn.request('topic.list', {})).topics).toEqual([]);
    expect((await leo.conn.request('topic.list', { archived: true })).topics.map((topic) => topic.id)).toEqual([topicId]);
    // An archived topic is read-only: no message, no revision, no start.
    expect(await refusal(mei.conn.request('session.message.send', { sessionId: discussionId, text: 'One more thing' }))).toMatchObject({ code: 'conflict' });
    expect(await refusal(mei.conn.request('topic.revise', { topicId, target: 'spec', text: 'One more thing' }))).toMatchObject({ code: 'conflict', reason: 'archived' });
    expect(await refusal(mei.conn.request('plan.generate', { topicId }))).toMatchObject({ code: 'conflict', reason: 'archived' });
    // Every process the story started is gone with its session.
    await waitFor(async () => (await flow.processes()).length === 0, { timeoutMs: 20_000, what: 'every agent process to be gone' });

    // ================================================================================================================
    // In the end: the audit log, what an agent received of Amy's words, what the Viewer saw and could not do
    // ================================================================================================================
    const actions = new Set((await audited(flow)).map((entry) => entry.action));
    for (const action of ['topic.create', 'topic.archive', 'topic.rule.add', 'plan.generate', 'plan.assign', 'plan.mode', 'plan.start', 'plan.item.continue', 'plan.item.resolve', 'scheduler.start', 'scheduler.disarm', 'spec.commit', 'report.register', 'report.review', 'smurg.message', 'permission.auto', 'permission.auto-deny', 'claude-config.decide']) {
      expect(actions, `the audit log has ${action}`).toContain(action);
    }
    expect((await audited(flow, 'report.review')).map((entry) => `${entry.actor.kind === 'user' ? entry.actor.userId : ''} ${String(entry.detail?.['itemId'])} v${String(entry.detail?.['version'])}${entry.detail?.['acknowledgedUnfinished'] === true ? ' unfinished' : ''}`)).toEqual([
      `${MEI} cart-api v1 unfinished`,
      `${AMY} checkout-page v1`,
      `${IAN} receipt-email v1`,
      `${IAN} receipt-email v2`,
    ]);
    // Of what Amy wrote, the agents were given: the revision Mei accepted. The spec sentence only as a file in the
    // checkout of the item Mei started after it; the rejected follow-up never.
    const received = await everythingAgentsReceived(flow);
    expect(received).toContain('amy-revise-3b7e');
    expect(received).not.toContain('amy-spec-edit');
    expect(received).not.toContain('amy-follow-up');
    // Nothing a person or an agent wrote is in a role prompt (S20): the three prompts hold the slug, ids, branches.
    const rolePrompts = (await flow.claude.echoed()).filter((entry) => entry.kind === 'role-prompt').map((entry) => String(entry.value)).join('\n');
    for (const written of ['Bookshop', 'Buying a book', 'Compute the total', 'Cart API', 'Mei', 'Amy', 'Ian']) expect(rolePrompts).not.toContain(written);
    // The Viewer was told everything every member is told about the topic: the same updates the host got.
    for (const type of ['topic.updated', 'plan.updated', 'report.updated', 'worktree.merge.updated', 'worktree.removed'] as const) expect(leo.got(type), `${type} at the Viewer`).toEqual(ian.got(type));
    for (const id of [discussionId, cartId, receiptId, pageId]) expect(leo.events(id)).toEqual(ian.events(id));
    expect((await leo.conn.request('session.watch', { sessionId: discussionId })).events).toEqual(leo.events(discussionId));
    // ... and every request of his that would change something was refused.
    for (const attempt of [
      leo.conn.request('topic.rename', { topicId, name: 'Mine' }),
      leo.conn.request('topic.archive', { topicId, archived: false }),
      leo.conn.request('topic.delete', { topicId }),
      leo.conn.request('topic.discussion.restart', { topicId }),
      leo.conn.request('topic.revise', { topicId, target: 'spec', text: 'me too' }),
      leo.conn.request('topic.spec.request', { topicId }),
      leo.conn.request('topic.rule.add', { topicId, tool: 'Bash', pattern: 'pnpm lint *' }),
      leo.conn.request('topic.rule.remove', { topicId, ruleId: 'rl_x' }),
      leo.conn.request('plan.generate', { topicId }),
      leo.conn.request('plan.mode.set', { topicId, mode: 'everyone' }),
      leo.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: LEO }),
      leo.conn.request('plan.suggest', { topicId }),
      leo.conn.request('plan.preflight', { topicId }),
      leo.conn.request('plan.start', { topicId, planRevision: 1, specHash: 'a'.repeat(64), planHash: 'a'.repeat(64) }),
      leo.conn.request('plan.resume', { topicId }),
      leo.conn.request('plan.item.retry', { topicId, itemId: 'cart-api' }),
      leo.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' }),
      leo.conn.request('plan.item.resolve', { topicId, itemId: 'cart-api' }),
      leo.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: 'me too' }),
      leo.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 }),
      leo.conn.request('worktree.merge.request', { worktreeId: cartWt }),
      leo.conn.request('worktree.merge.approve', { requestId: cartDraft }),
      leo.conn.request('worktree.merge.reject', { requestId: cartDraft }),
      leo.conn.request('file.write', { file: { root: MAIN_ROOT, path: SPEC_PATH }, content: bytes('mine\n') }),
      leo.conn.request('admin.claudeConfig.get', {}),
    ]) {
      expect(await refusal(attempt)).toMatchObject({ code: 'forbidden' });
    }
    expect(await text(SPEC_PATH, flow)).toBe(SPEC_BY_AMY);

    // ================================================================================================================
    // The host deletes the archived topic: smurg's records and the conversations go, the files of the project stay
    // ================================================================================================================
    expect(await refusal(mei.conn.request('topic.delete', { topicId }))).toMatchObject({ code: 'forbidden' });
    await ian.conn.request('topic.delete', { topicId });
    for (const member of everyone) await waitFor(() => member.got('topic.removed').some((update) => update.topicId === topicId), { what: `the removed topic at ${member.name}` });
    expect((await leo.conn.request('topic.list', { archived: true })).topics).toEqual([]);
    expect((await leo.conn.request('session.list', {})).sessions).toEqual([]);
    for (const id of [discussionId, cartId, receiptId, pageId]) expect(await refusal(leo.conn.request('session.watch', { sessionId: id }))).toMatchObject({ code: 'not_found' });
    expect(await refusal(leo.conn.request('plan.get', { topicId }))).toMatchObject({ code: 'not_found' });
    expect(await refusal(leo.conn.request('report.get', { topicId, itemId: 'cart-api' }))).toMatchObject({ code: 'not_found' });
    expect((await audited(flow, 'topic.rename', 'topic.delete')).map((entry) => `${entry.action} ${entry.actor.kind === 'user' ? entry.actor.userId : ''} ${String(entry.detail?.['name'])} ${String(entry.detail?.['sessions'] ?? '')}`.trim())).toEqual([`topic.rename ${MEI} Checkout on one page`, `topic.delete ${IAN} Checkout on one page 4`]);
    // What the work produced is the project's: the spec, the plan, the reports, the code, and git's history.
    expect(await text(SPEC_PATH, flow)).toBe(SPEC_BY_AMY);
    expect(await text(PLAN_PATH, flow)).toBe(PLAN);
    expect(await text(reportPath('checkout-page'), flow)).toBe(report('checkout-page', 'Checkout page', 'complete'));
    expect(await text('src/app.ts', flow)).toBe(APP_RESOLVED);
    expect(await flow.git(['status', '--porcelain'])).toBe('');
    // The transcripts are gone from the host's disk with the topic.
    const { readdir } = await import('node:fs/promises');
    const transcripts = join(flow.d.ctx.config.workspaceStateDir, 'transcripts');
    expect(await readdir(transcripts).catch(() => [])).toEqual([]);
  });
});

describe('the release composition: more work items than agents may run at once', { timeout: 240_000 }, () => {
  it('with two agents allowed, the third item waits for a free agent and gets the place of the first session that is idle; a message to the parked session resumes it', async () => {
    const flow = await startFlow({ files: { 'README.md': '# Bookshop\n' }, settings: { maxLiveAgents: 2 } });
    const three = ['# Plan: Checkout', '', '<!-- smurg:plan v1 -->', '', '### 1. Cart API', '- id: cart-api', '', 'The cart.', '', '### 2. Payment form', '- id: payment-form', '', 'The form.', '', '### 3. Receipt email', '- id: receipt-email', '', 'The receipt.', '', '<!-- smurg:plan end -->', ''].join('\n');
    const done = (itemId: string, title: string): FakeClaudeStep[] => [
      { tool: 'Write', input: { file_path: reportPath(itemId), content: report(itemId, title, 'complete') } },
      { tool: 'mcp__smurg__check_report', input: {} },
      { text: `${title} is done.` },
    ];
    await flow.claude.setScenario({
      turns: [
        { match: 'one page', once: true, steps: [{ tool: 'Write', input: { file_path: SPEC_PATH, content: SPEC } }, { text: 'The first draft of the spec is ready.' }] },
        { match: 'Then call check_plan', steps: [{ tool: 'Write', input: { file_path: PLAN_PATH, content: three } }, { tool: 'mcp__smurg__check_plan', input: {} }, { text: 'Three items.' }] },
        // Item 1 waits for a person until it is allowed, then finishes; item 2 waits for a person the whole time.
        { match: 'Start work item 1 ', steps: [PNPM_TEST, ...done('cart-api', 'Cart API')] },
        { match: 'Start work item 2 ', steps: [{ tool: 'Bash', input: { command: 'pnpm build' } }, { text: 'never said' }] },
        { match: 'Start work item 3 ', steps: done('receipt-email', 'Receipt email') },
        { match: 'What did you do', steps: [{ text: 'I wrote the cart.' }] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { ian, mei, leo } = flow;
    const created = await mei.conn.request('topic.create', { name: 'Checkout', firstMessage: 'We want the checkout on one page.' });
    const topicId = created.topic.id;
    await leo.watch(created.session.id);
    await turnsFinished(leo, created.session.id, 1);
    await statusIs(leo, created.session.id, 'idle');
    await mei.conn.request('plan.generate', { topicId });
    await planIs(leo, topicId, (plan) => plan.items.length === 3, 'the plan');
    await turnsFinished(leo, created.session.id, 2);
    const { preflight } = await mei.conn.request('plan.preflight', { topicId });
    expect(preflight).toMatchObject({ startsNow: ['cart-api', 'payment-form', 'receipt-email'], waits: [], blockers: [] });
    await mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash });

    // ---- two start, the third is queued: "Waiting for a free agent: 2 of 2 in use, 2 wait for a person"
    const full = await planIs(leo, topicId, (plan) => plan.slots.inUse === 2 && plan.slots.waitingForPeople === 2, 'both agents in use, both waiting for a person');
    expect(full.items.map((item) => `${item.id} ${item.state}${item.armed ? ' armed' : ''}`)).toEqual(['cart-api running', 'payment-form running', 'receipt-email queued armed']);
    expect(full.slots).toEqual({ inUse: 2, max: 2, waitingForPeople: 2 });
    const cartId = itemOf(full, 'cart-api')?.sessionId as string;
    const formId = itemOf(full, 'payment-form')?.sessionId as string;
    expect(itemOf(full, 'receipt-email')?.sessionId).toBeUndefined();
    expect((await leo.conn.request('worktree.list', {})).worktrees.map((worktree) => worktree.itemId)).toEqual(['cart-api', 'payment-form']);
    for (const id of [cartId, formId]) await leo.watch(id);
    expect(await launches(flow)).toBe(3);

    // ---- item 1 is allowed, finishes with its report, and is idle: its process is given up for the item that waits
    const asked = await permissionAt(leo, (request) => request.sessionId === cartId && request.status === 'open', 'the command of work item 1');
    await mei.conn.request('permission.decide', { requestId: asked.id, decision: 'allow' });
    const started = await planIs(leo, topicId, (plan) => itemOf(plan, 'receipt-email')?.sessionId !== undefined, 'the third item started');
    const receiptId = itemOf(started, 'receipt-email')?.sessionId as string;
    await leo.watch(receiptId);
    await waitFor(() => leo.got('report.updated').some((update) => update.itemId === 'receipt-email'), { timeoutMs: 30_000, what: 'the report of work item 3' });
    const after = await planIs(leo, topicId, (plan) => itemOf(plan, 'receipt-email')?.state === 'done', 'work item 3 done');
    expect(after.items.map((item) => `${item.id} ${item.state}`)).toEqual(['cart-api done', 'payment-form running', 'receipt-email done']);
    // The first session kept its place in the list and its conversation; it holds no process any more, and no line
    // in its conversation makes a fuss about it.
    const hex = (id: string): string => Buffer.from(id, 'utf8').toString('hex');
    await waitFor(async () => !(await flow.processes()).some((line) => line.includes(hex(cartId))), { timeoutMs: 20_000, what: 'the process of the idle first session to be given up' });
    expect((await flow.processes()).some((line) => line.includes(hex(formId)))).toBe(true);
    expect((await leo.conn.request('session.list', { topicId })).sessions.find((session) => session.id === cartId)).toMatchObject({ status: 'done' });
    expect(leo.events(cartId).some((event) => event.kind === 'line' && event.text.id === 'conversation.agent.restarting')).toBe(false);
    expect(await launches(flow)).toBe(4);

    // ---- a question about its result goes to the parked session: the same Claude conversation is resumed
    await ian.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: 'What did you do?' });
    await waitFor(async () => ((await leo.conn.request('report.get', { topicId, itemId: 'cart-api' })).report.questions[0]?.answer?.text ?? '') === 'I wrote the cart.', { timeoutMs: 30_000, what: 'the answer of the resumed session' });
    const cartStarts = (await flow.claude.echoed()).filter((entry) => entry.kind === 'argv' && entry.session === cartId).map((entry) => (entry.value as string[]).includes('--resume'));
    expect(cartStarts).toEqual([false, true]);
    expect((await told(flow, cartId)).at(-1)).toBe('[Ian · Host]\nWhat did you do?');
  });
});
