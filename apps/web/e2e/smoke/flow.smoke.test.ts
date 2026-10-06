// The owner's whole flow in real browsers (DESIGN §9.5 item 4; docs/ACCEPTANCE.md rows T1.3, T4.3, T7.1): the BUILT
// app served by the real local relay, a real daemon on the release composition (flow-env.ts), the scripted stand-in
// `claude` with the real `smurg hook` / `smurg mcp` commands, and four people in headless system Chrome, each in a
// context of their own:
//
//   Ian  the Host                 English               1440 x 900
//   Mei  Agent access             Traditional Chinese   1280 x 900
//   Amy  Editor                   English               1280 x 900
//   Leo  Viewer                   English               1100 x 700
//
// The tests are the steps of the story, in the order the design tells it; each one asserts what the four people SEE
// on their own pages, and what the ones who may not act cannot do. Every step waits for a condition; nothing sleeps.
// The one thing that takes real time is the question nobody answers: it waits the shortest time a host can set (one
// minute) before the others may answer it.
//
// With SMURG_SMOKE_SHOTS=<folder> every step writes one numbered picture per person (`NN-step--person.png`).
//
// The SCENARIO below is the whole "model": a turn is chosen by a pattern on the message smurg (or a person) sent.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FakeClaudeScenario } from '../../../../packages/daemon/src/testing/index.ts';
import { FLOW_HOST, startFlowEnv, type FlowEnv } from './flow-env.ts';
import { STEP_MS, cjkTexts, explainFailures, joinAs, joinAsHost, openDrawer, systemChrome, toCodeMode, toSessionsView, waitUntil } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

/** Where the pictures go; empty: none are taken. */
const SHOTS = process.env['SMURG_SMOKE_SHOTS'] ?? '';

/** The `smurg` command as sessions run it in development: the agents' hooks and the `smurg` MCP server are real. */
const CLI_MAIN = fileURLToPath(new URL('../../../../packages/cli/src/main.ts', import.meta.url));

const TOPIC = 'Checkout';
const SLUG = 'checkout';
const SPEC_PATH = `specs/${SLUG}/SPEC.md`;
const PLAN_PATH = `specs/${SLUG}/PLAN.md`;
const reportPath = (itemId: string): string => `specs/${SLUG}/reports/${itemId}.md`;

const FIRST_MESSAGE = 'We want the checkout on one page instead of three steps.';

const APP_BEFORE = 'export const title = "Bookshop";\n';
const APP_BY_CART = 'export const title = "Bookshop with a cart";\n';
const APP_BY_RECEIPT = 'export const title = "Bookshop with receipts";\n';
const APP_RESOLVED = 'export const title = "Bookshop with a cart and receipts";\n';

const SPEC = [
  '# Checkout',
  '',
  '## Goal',
  'Buying a book takes one page instead of three steps.',
  '',
  '## Decisions',
  '- Payment: cards only.',
  '- The cart is kept on the server.',
  '',
  '## Scope',
  'Cart, payment, receipt.',
  '',
  '## Out of scope',
  'Invoices.',
  '',
  '## Open questions',
  'None.',
  '',
].join('\n');

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
const SPLIT_REASON = 'Mei knows the cart and the mail code.';
/** The plan after the topic was complete and one more thing was asked for: a fourth work item. */
const PLAN_MORE = PLAN.replace('<!-- smurg:plan end -->', ['### 4. Gift receipt', '- id: gift-receipt', '- size: s', '- touches: src/gift/**', '', 'Print a receipt without prices.', '', '<!-- smurg:plan end -->'].join('\n'));
const ONE_MORE = 'One more thing: add a work item for a gift receipt.';
const PNPM_BUILD = { tool: 'Bash', input: { command: 'pnpm build' }, result: 'built in 2 s' } as const;

const AMY_TYPED = 'Amy: gift wrapping can wait.';
const MEI_TYPED = 'Mei: so can the loyalty points.';
const IAN_ASKS = 'Please add gift cards to what is out of scope.';
const AMY_REVISE = 'Please say that coupons are not part of it.';

const AMY_SPEC_EDIT = 'Amy: gift receipts are out of scope too.';
const FOLLOW_UP = 'Why is it partial?';
const FOLLOW_UP_ANSWER = 'The browser check needs a display, and this session has none.';
const TOTAL_TS = 'export const total = (prices: number[]): number => prices.reduce((a, b) => a + b, 0);\n';

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

const MAIL = {
  question: 'Which mail service sends the receipt?',
  header: 'Mail',
  multiSelect: false,
  options: [
    { label: 'The SMTP relay we have', description: 'No new account.' },
    { label: 'A new mail provider', description: 'Better delivery reports, one more bill.' },
  ],
};
/** A command of the kind a topic can always allow. */
const PNPM_TEST = { tool: 'Bash', input: { command: 'pnpm test' }, suggest: { toolName: 'Bash', ruleContent: 'pnpm test *' }, result: '3 tests passed' } as const;
/** A command that downloads and runs code: it can be allowed once, never always. */
const PNPM_ADD = { tool: 'Bash', input: { command: 'pnpm add -D vitest' }, suggest: { toolName: 'Bash', ruleContent: 'pnpm add *' }, result: 'added 1 package' } as const;

const PAYMENT = {
  question: 'How do people pay?',
  header: 'Payment',
  multiSelect: false,
  options: [
    { label: 'Cards only', description: 'One provider, the one we have.' },
    { label: 'Cards and invoices', description: 'More work: invoices need an address form.' },
  ],
};
const CART = {
  question: 'Where is the cart kept?',
  header: 'Cart',
  multiSelect: false,
  options: [
    { label: 'On the server', description: 'Survives a reload. Every change of the cart needs a request.' },
    { label: 'In the browser', description: 'Simpler. Lost when the browser forgets it.' },
  ],
};

/** What the "model" does. A turn is chosen by a pattern on the message smurg (or a person) sent. */
const SCENARIO: FakeClaudeScenario = {
  turns: [
    // ---- the discussion: two questions in one card, then the first draft of the spec
    {
      match: 'one page',
      once: true,
      steps: [
        { text: 'Two things to decide before I write the spec.', deltas: ['Two things to decide ', 'before I write ', 'the spec.'], deltaMs: 40 },
        { tool: 'AskUserQuestion', input: { questions: [PAYMENT, CART] } },
        { tool: 'Write', input: { file_path: SPEC_PATH, content: SPEC } },
        { text: 'The first draft of the spec is ready.' },
      ],
    },
    // ---- asked for a change while two people type in the spec: the edit waits its turn
    {
      match: 'gift cards to what is out of scope',
      steps: [
        { tool: 'Edit', input: { file_path: SPEC_PATH, old_string: 'Invoices.', new_string: 'Invoices. Gift cards.' } },
        { tool: 'mcp__smurg__wait_for_lock', input: { file_path: SPEC_PATH, timeout_seconds: 18 } },
        { tool: 'mcp__smurg__wait_for_lock', input: { file_path: SPEC_PATH, timeout_seconds: 18 } },
        { tool: 'Edit', input: { file_path: SPEC_PATH, old_string: 'Invoices.', new_string: 'Invoices. Gift cards.' } },
        { text: 'Gift cards are out of scope now.' },
      ],
    },
    // ---- the revision Amy asked for
    { match: 'coupons', steps: [{ tool: 'Edit', input: { file_path: SPEC_PATH, old_string: 'Gift cards.', new_string: 'Gift cards. Coupons.' } }, { text: 'Coupons are out of scope now.' }] },
    // ---- "Generate plan": the plan, checked with smurg's tool, and who could be responsible
    {
      match: 'Then call check_plan',
      steps: [
        { tool: 'Write', input: { file_path: PLAN_PATH, content: PLAN } },
        { tool: 'mcp__smurg__check_plan', input: {} },
        { tool: 'mcp__smurg__propose_split', input: { items: [{ id: 'cart-api', person: 'Mei' }, { id: 'checkout-page', person: 'Ian' }, { id: 'receipt-email', person: 'Mei' }], reason: SPLIT_REASON } },
        { text: 'The plan has three work items.' },
      ],
    },
    // ---- work item 1: edits in its worktree are automatic, commands ask; a partial report
    {
      match: 'Start work item 1 ',
      steps: [
        { text: 'I start with the total.' },
        { tool: 'Write', input: { file_path: 'src/cart/total.ts', content: TOTAL_TS } },
        { tool: 'Edit', input: { file_path: 'src/app.ts', old_string: APP_BEFORE, new_string: APP_BY_CART } },
        PNPM_TEST,
        PNPM_ADD,
        PNPM_TEST,
        { tool: 'Write', input: { file_path: reportPath('cart-api'), content: report('cart-api', 'Cart API', 'partial') } },
        { tool: 'mcp__smurg__check_report', input: {} },
        { text: 'The cart is done; one check could not run.' },
      ],
    },
    // ---- work item 3: a question at once; then it stops without a report, twice; it goes on when told
    {
      match: 'Start work item 3 ',
      steps: [
        { tool: 'AskUserQuestion', input: { questions: [MAIL] } },
        { tool: 'Edit', input: { file_path: 'src/app.ts', old_string: APP_BEFORE, new_string: APP_BY_RECEIPT } },
        { text: 'I changed the title.' },
      ],
    },
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
    // ---- work item 2 (starts when 1 is merged): its command is of the kind the topic allows by then
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
    { match: 'Why is it partial', steps: [{ text: FOLLOW_UP_ANSWER }] },
    // ---- after the topic was complete: one more work item; its session waits at a command when smurg restarts
    {
      match: 'work item for a gift receipt',
      steps: [{ tool: 'Write', input: { file_path: PLAN_PATH, content: PLAN_MORE } }, { tool: 'mcp__smurg__check_plan', input: {} }, { text: 'The plan has a fourth work item.' }],
    },
    { match: 'Start work item 4 ', steps: [{ tool: 'Write', input: { file_path: 'src/gift/receipt.ts', content: 'export const gift = true;\n' } }, PNPM_BUILD, { text: 'never said' }] },
    { steps: [{ text: 'Noted.' }] },
  ],
};

/** After the restart: whatever the session of item 4 is told next, it asks for its command again (and waits). */
const SCENARIO_AFTER_RESTART: FakeClaudeScenario = { turns: [{ steps: [PNPM_BUILD, { text: 'never said either' }] }] };
/** After its process was killed: whatever it is told next, it finishes the item. */
const SCENARIO_AFTER_KILL: FakeClaudeScenario = {
  turns: [
    {
      steps: [
        { tool: 'Write', input: { file_path: reportPath('gift-receipt'), content: report('gift-receipt', 'Gift receipt', 'complete') } },
        { tool: 'mcp__smurg__check_report', input: {} },
        { text: 'The gift receipt is done.' },
      ],
    },
  ],
};

interface Person {
  readonly name: 'Ian' | 'Mei' | 'Amy' | 'Leo';
  readonly page: Page;
}

describe.skipIf(chrome === null)('the whole flow in real browsers: Ian (Host), Mei (Agent access, Traditional Chinese), Amy (Editor), Leo (Viewer)', () => {
  let env: FlowEnv;
  let ian: Page;
  let mei: Page;
  let amy: Page;
  let leo: Page;
  let people: Person[] = [];
  let topicId = '';
  let discussionId = '';
  let startedAt = 0;
  let step = 0;

  beforeAll(async () => {
    if (SHOTS !== '') await mkdir(SHOTS, { recursive: true });
    env = await startFlowEnv({
      projectFiles: {
        'README.md': '# Bookshop\n\nA small shop for books.\n',
        'src/app.ts': APP_BEFORE,
        // Project-level Claude Code settings: nothing of them is used until the host has confirmed them.
        '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Bash(rm -rf *)'] }, env: { NODE_ENV: 'test' } }, null, 2),
      },
      scenario: SCENARIO,
      selfCommand: { file: process.execPath, args: [CLI_MAIN] },
      // The shortest waiting time a host can set: a question nobody answers reaches the others after one minute.
      // People who typed in a file keep it for ten minutes: only "Let the agent go first" hands it over in this story.
      settings: { escalateAfterMs: 60_000, humanLockIdleMs: 600_000 },
    });
    startedAt = Date.now();
    ian = await env.newPage({ width: 1440, height: 900 });
    await joinAsHost(ian, env, FLOW_HOST);
    mei = await env.newPage({ width: 1280, height: 900, locale: 'zh-TW' });
    await joinAs(mei, env, 'Mei', 'agent');
    amy = await env.newPage({ width: 1280, height: 900 });
    await joinAs(amy, env, 'Amy', 'editor');
    leo = await env.newPage({ width: 1100, height: 700 });
    await joinAs(leo, env, 'Leo', 'viewer');
    people = [
      { name: 'Ian', page: ian },
      { name: 'Mei', page: mei },
      { name: 'Amy', page: amy },
      { name: 'Leo', page: leo },
    ];
  }, 300_000);

  afterAll(async () => {
    await env?.stop();
  }, 120_000);

  explainFailures(() => env);

  // A failed step also leaves a picture of every page as it was then.
  beforeEach(({ onTestFailed, task }) => {
    onTestFailed(async () => {
      if (SHOTS === '') return;
      const name = task.name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60);
      for (const person of people) await person.page.screenshot({ path: join(SHOTS, `FAILED-${name}--${person.name.toLowerCase()}.png`) }).catch(() => {});
    });
  });

  // ---- what the steps share -------------------------------------------------------------------------------------------

  /** One picture per person of the step that just happened (only with SMURG_SMOKE_SHOTS). */
  const shots = async (name: string, of: readonly Person[] = people): Promise<void> => {
    step += 1;
    if (SHOTS === '') return;
    const number = String(step).padStart(2, '0');
    for (const person of of) {
      // Two frames: what the last event changed is painted.
      await person.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await person.page.screenshot({ path: join(SHOTS, `${number}-${name}--${person.name.toLowerCase()}.png`) });
    }
  };

  /** The view of the workspace that is on screen (the other one is mounted and hidden). */
  const view = (page: Page): Locator => page.locator('.app-shell__view:not([hidden])');
  /** A column of the sessions view by its id: `session:<id>`, `spec:<topic>`, `plan:<topic>`, `report:<topic>:<item>`, `changes:<request>`. */
  const column = (page: Page, id: string): Locator => view(page).locator(`[data-column-id="${id}"]`);
  /** A row of the session list by the same ids (a work item's row: `item:<topic>:<item>`). */
  const row = (page: Page, id: string): Locator => page.locator(`aside.sidebar [data-tree-id="${id}"] > .ui-tree__row`);
  /** Opens a row of the session list: in the focused column, or with `side` in a column of its own beside it. */
  const openRow = async (page: Page, id: string, options: { readonly side?: boolean } = {}): Promise<Locator> => {
    // A complete topic folds by itself in the list; a person unfolds it to get at its rows (and it stays unfolded).
    const folded = page.locator(`aside.sidebar [data-tree-id="topic:${topicId}"][aria-expanded="false"] > .ui-tree__row`);
    if (!(await row(page, id).isVisible()) && (await folded.count()) > 0) await folded.click();
    await row(page, id).click(options.side ? { modifiers: ['Shift'] } : {});
    const opened = column(page, id);
    await opened.waitFor({ timeout: STEP_MS });
    return opened;
  };
  /** The rows of a member's inbox (the left column), by kind. */
  const inbox = (page: Page, kind?: string): Locator => page.locator(`aside.sidebar .inbox-item${kind === undefined ? '' : `[data-kind="${kind}"]`}`);
  const inboxTitles = (page: Page): Promise<string[]> => page.locator('aside.sidebar .inbox-item .inbox-item__title').allTextContents();
  /** A toast with this text on a page; the promise is made BEFORE the step that causes it, and awaited after. */
  const toast = (page: Page, text: string | RegExp): Promise<void> => page.locator('.ui-toast__title', { hasText: text }).first().waitFor({ timeout: STEP_MS });
  /** Closes the toasts of a page (they sit over the foot of the rightmost column for six seconds). */
  const dismissToasts = async (page: Page): Promise<void> => {
    // In the page, in one go: a toast that leaves by itself meanwhile is not a button to wait for.
    await page.evaluate(() => {
      for (const close of document.querySelectorAll<HTMLButtonElement>('.ui-toast button[aria-label]')) close.click();
    });
    await expect.poll(() => page.locator('.ui-toast').count(), { timeout: STEP_MS }).toBe(0);
  };
  /** The phase badge of the topic in a member's session list. */
  const phase = (page: Page): Locator => page.locator(`aside.sidebar .ui-tree__row[data-group$="${topicId}"] .topic__phase`);
  const fileText = (path: string): Promise<string> => readFile(join(env.stack.root, path), 'utf8').catch(() => '');
  const discussion = (page: Page): Locator => column(page, `session:${discussionId}`);

  // =====================================================================================================================
  // New topic
  // =====================================================================================================================

  it('New topic: Ian confirms the folder\'s Claude Code project settings in the dialog, and the discussion opens for everyone', async () => {
    // Before anything: the folder's project settings wait for the host, and only for the host.
    await inbox(ian, 'attention').filter({ hasText: 'Claude Code project settings wait for the host' }).waitFor({ timeout: STEP_MS });
    await mei.locator('aside.sidebar [data-inbox-empty]').waitFor({ timeout: STEP_MS });
    await leo.getByText('Nothing is waiting for you. As a viewer you get only mentions here.').waitFor({ timeout: STEP_MS });

    // Who can start a topic: an Editor and a Viewer are told why not.
    for (const [person, sentence] of [
      [amy, /^With the role Editor you cannot start a topic/],
      [leo, /^With the role Viewer you cannot start a topic\./],
    ] as const) {
      await person.getByRole('button', { name: 'New', exact: true }).click();
      await person.getByRole('menuitem', { name: 'New topic' }).click();
      const refused = person.getByRole('dialog', { name: 'New topic' });
      await refused.getByText(sentence).waitFor({ timeout: STEP_MS });
      expect(await refused.getByRole('textbox').count()).toBe(0);
      await refused.getByRole('button', { name: 'Close' }).first().click();
      await refused.waitFor({ state: 'detached', timeout: STEP_MS });
    }

    await ian.getByRole('button', { name: 'New', exact: true }).click();
    await ian.getByRole('menuitem', { name: 'New topic' }).click();
    const dialog = ian.getByRole('dialog', { name: 'New topic' });
    await dialog.getByLabel('Name').fill(TOPIC);
    await expect.poll(() => dialog.getByLabel(/^Folder for the spec and the plan/).inputValue(), { timeout: STEP_MS }).toBe(SLUG);
    await dialog.getByLabel(/^What do you want to build/).fill(FIRST_MESSAGE);
    // The review of the folder's settings is part of the dialog: nothing starts until the host has chosen.
    const review = dialog.getByRole('group', { name: 'This folder has Claude Code project settings' });
    await review.waitFor({ timeout: STEP_MS });
    await review.getByText('.claude/settings.json').first().waitFor({ timeout: STEP_MS });
    await review.getByRole('radio', { name: 'Use them' }).click();
    for (const tick of await review.getByRole('checkbox').all()) await tick.check();
    await shots('new-topic-dialog', [{ name: 'Ian', page: ian }]);
    const told = [mei, amy, leo].map((page) => toast(page, page === mei ? `有新主題開始了：${TOPIC}` : `A new topic was started: ${TOPIC}`));
    await dialog.getByRole('button', { name: 'Start discussion' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });
    await Promise.all(told);

    const topic = env.stack.daemon.ctx.services.topics.list({}).topics.find((one) => one.name === TOPIC);
    topicId = topic?.id ?? '';
    discussionId = topic?.discussionSessionId ?? '';
    expect(topicId).not.toBe('');
    expect(discussionId).not.toBe('');

    // Ian's column opened by itself; the settings left his inbox; the others open the discussion from their lists.
    await discussion(ian).getByRole('log').getByText(FIRST_MESSAGE).first().waitFor({ timeout: STEP_MS });
    await expect.poll(async () => (await inboxTitles(ian)).filter((title) => title.includes('project settings')), { timeout: STEP_MS }).toEqual([]);
    for (const page of [mei, amy, leo]) {
      await dismissToasts(page);
      await openRow(page, `session:${discussionId}`);
      await discussion(page).getByRole('log').getByText(FIRST_MESSAGE).first().waitFor({ timeout: STEP_MS });
    }
    // The topic's fixed rows are there from its creation.
    await row(leo, `spec:${topicId}`).getByText('not written yet').waitFor({ timeout: STEP_MS });
    await row(leo, `plan:${topicId}`).getByText('no plan yet').waitFor({ timeout: STEP_MS });
  }, 300_000);

  // =====================================================================================================================
  // The discussion: two questions in one card
  // =====================================================================================================================

  const QUESTION = { en: 'Question from Claude', zh: 'Claude 的選擇題' } as const;
  const question = (page: Page): Locator => discussion(page).getByRole('region', { name: page === mei ? QUESTION.zh : QUESTION.en });

  it('the agent asks two questions in one card; the open vote is in the inboxes of Mei and Amy', async () => {
    for (const page of [ian, amy, leo]) {
      await discussion(page).getByRole('log').getByText('Two things to decide before I write the spec.').waitFor({ timeout: STEP_MS });
      const card = question(page);
      await card.getByText('Question 1 of 2').waitFor({ timeout: STEP_MS });
      await card.getByText('Question 2 of 2').waitFor({ timeout: STEP_MS });
      await card.getByText(PAYMENT.question).first().waitFor({ timeout: STEP_MS });
      await card.getByText(CART.question).first().waitFor({ timeout: STEP_MS });
      await card.getByText('0 of 3 voted').waitFor({ timeout: STEP_MS });
    }
    await question(mei).getByText('第 2 題，共 2 題').waitFor({ timeout: STEP_MS });
    await question(mei).getByText('3 人中 0 人已投票').waitFor({ timeout: STEP_MS });

    // Who decides, in the words of the one who looks.
    await question(ian).getByText(/You decide: nobody is assigned to this session, and you opened it\./).waitFor({ timeout: STEP_MS });
    await question(amy).getByText(/Ian decides: nobody is assigned to this session\. Your vote and comments are visible to everyone\./).waitFor({ timeout: STEP_MS });
    await question(mei).getByText(/由 Ian 決定：這個 session 沒有指派負責人。/).waitFor({ timeout: STEP_MS });
    await question(leo).getByText('You are watching. Viewers do not vote. Ian decides.').waitFor({ timeout: STEP_MS });
    // A viewer has nothing to choose, nothing to write and nothing to submit.
    expect(await question(leo).getByRole('radio').count()).toBe(0);
    expect(await question(leo).getByRole('combobox').count()).toBe(0);
    expect(await question(leo).getByRole('button', { name: /Submit/ }).count()).toBe(0);
    expect(await discussion(leo).getByRole('combobox').count()).toBe(0);
    await discussion(leo).getByText('As a viewer you can watch this session. You cannot send messages, make suggestions or vote.').waitFor({ timeout: STEP_MS });
    // Only the decider (and nobody else yet) can submit.
    await question(ian).getByRole('button', { name: 'Submit answers' }).waitFor({ timeout: STEP_MS });
    for (const page of [mei, amy]) expect(await question(page).locator('.conv-card__actions button').count()).toBe(0);

    // The inboxes: the question at the one who decides, the open vote at the others who may vote, nothing at the viewer.
    await inbox(ian, 'question').filter({ hasText: PAYMENT.question }).waitFor({ timeout: STEP_MS });
    await inbox(amy, 'vote').filter({ hasText: `Vote: ${PAYMENT.question}` }).waitFor({ timeout: STEP_MS });
    await inbox(amy, 'vote').filter({ hasText: /0 of 3 voted · Ian decides/ }).waitFor({ timeout: STEP_MS });
    await inbox(mei, 'vote').filter({ hasText: `投票：${PAYMENT.question}` }).waitFor({ timeout: STEP_MS });
    expect(await inbox(leo).count()).toBe(0);
    await shots('question-two-parts');
  }, 300_000);

  const COMMENT = 'do we still owe invoices to the library customers?';

  it('three votes, a comment with a mention, Ian adds the comment to the note, breaks a tie and submits', async () => {
    const vote = async (page: Page, part: string, option: RegExp): Promise<void> => {
      const group = question(page).getByRole('radiogroup', { name: page === mei ? `你的投票：${part}` : `Your vote: ${part}` });
      // The radio is checked by the vote the host's smurg stored, not by the click itself.
      await group.getByRole('radio', { name: option }).click();
      await expect.poll(() => group.getByRole('radio', { name: option }).isChecked(), { timeout: STEP_MS }).toBe(true);
    };
    // Mei and Amy agree about the payment and disagree about the cart.
    await vote(mei, PAYMENT.question, /Cards only/);
    await vote(mei, CART.question, /On the server/);
    await question(ian).getByText('1 of 3 voted').waitFor({ timeout: STEP_MS });
    // Whoever has voted on every part is no longer asked to; the others' rows count on.
    await expect.poll(() => inbox(mei, 'vote').count(), { timeout: STEP_MS }).toBe(0);
    await inbox(amy, 'vote').filter({ hasText: /1 of 3 voted · Ian decides/ }).waitFor({ timeout: STEP_MS });
    await vote(amy, PAYMENT.question, /Cards only/);
    await vote(amy, CART.question, /In the browser/);
    // Every vote shows in every browser as it is cast, the viewer's too.
    for (const page of [ian, amy, leo]) await question(page).getByText('2 of 3 voted').waitFor({ timeout: STEP_MS });
    await question(mei).getByText('3 人中 2 人已投票').waitFor({ timeout: STEP_MS });
    await expect.poll(() => question(leo).locator('.conv-q-opt', { hasText: 'Cards only' }).locator('.conv-q-opt__count').textContent(), { timeout: STEP_MS }).toBe('2');
    await expect.poll(() => inbox(amy, 'vote').count(), { timeout: STEP_MS }).toBe(0);

    // Amy asks Leo in a comment: a mention is the one thing a viewer gets in the inbox. Leo is not looking at the
    // discussion just now (a mention of someone who has the card on screen is read at once).
    await leo.getByRole('button', { name: /^Close column: Discussion/ }).click();
    await discussion(leo).waitFor({ state: 'detached', timeout: STEP_MS });
    const box = question(amy).getByRole('combobox', { name: 'Add a comment' });
    await box.click();
    await amy.keyboard.type('@Le');
    await question(amy).getByRole('option', { name: /Leo · Viewer/ }).waitFor({ timeout: STEP_MS });
    await amy.keyboard.press('Enter');
    await amy.keyboard.type(COMMENT);
    await expect.poll(() => box.inputValue(), { timeout: STEP_MS }).toBe(`@Leo ${COMMENT}`);
    await question(amy).getByRole('button', { name: 'Comment', exact: true }).click();
    for (const page of [ian, amy, mei]) await question(page).locator('.conv-thread__text', { hasText: COMMENT }).waitFor({ timeout: STEP_MS });
    // The mention waits in Leo's inbox; opening it shows the card it is about, and then it is gone.
    await inbox(leo, 'mention').filter({ hasText: `Amy mentioned you: @Leo ${COMMENT}` }).waitFor({ timeout: STEP_MS });
    await shots('mention-in-the-viewers-inbox', [{ name: 'Leo', page: leo }]);
    await inbox(leo, 'mention').locator('.inbox-item__main').click();
    await question(leo).locator('.conv-thread__text', { hasText: COMMENT }).waitFor({ timeout: STEP_MS });
    await expect.poll(() => inbox(leo).count(), { timeout: STEP_MS }).toBe(0);
    // Comments are for the team: only the decider can pass one on, in the note.
    expect(await question(amy).getByRole('button', { name: 'Add to the note' }).count()).toBe(0);
    expect(await question(leo).getByRole('button', { name: 'Add to the note' }).count()).toBe(0);
    await question(ian).locator('.conv-thread__item', { hasText: COMMENT }).getByRole('button', { name: 'Add to the note' }).click();
    const note = question(ian).getByRole('textbox', { name: 'Note for Claude (optional)' });
    await expect.poll(() => note.inputValue(), { timeout: STEP_MS }).toBe(`Amy: @Leo ${COMMENT}`);

    // The payment has a leading option, prefilled as the answer; the cart is tied, and the decider is told.
    const card = question(ian);
    await card.locator('.conv-q-opt', { hasText: 'Cards only' }).getByText('Leading').waitFor({ timeout: STEP_MS });
    await card.locator('.conv-q__submit', { hasText: PAYMENT.question }).getByText('Cards only').waitFor({ timeout: STEP_MS });
    await card.locator('.conv-q__submit', { hasText: CART.question }).getByText('No answer chosen yet').waitFor({ timeout: STEP_MS });
    await card.getByText('The vote is tied. Choose the answer yourself.').waitFor({ timeout: STEP_MS });
    expect(await card.getByRole('button', { name: 'Submit answers' }).isDisabled()).toBe(true);
    await shots('votes-comment-tie');

    // The decider's click sets his vote and the answer: the tie is broken.
    await vote(ian, PAYMENT.question, /Cards only/);
    await vote(ian, CART.question, /On the server/);
    await card.getByText('All 3 voted').waitFor({ timeout: STEP_MS });
    await card.locator('.conv-q__submit', { hasText: CART.question }).getByText('On the server').waitFor({ timeout: STEP_MS });
    await inbox(ian, 'question').filter({ hasText: /All 3 voted/ }).waitFor({ timeout: STEP_MS });
    await question(leo).getByText('All 3 voted').waitFor({ timeout: STEP_MS });

  }, 300_000);

  const NEXT_SPEC = 'The spec draft is ready. Next: edit it together or ask for changes. When it is right:';
  const spec = (page: Page): Locator => column(page, `spec:${topicId}`);

  it('Ian submits: the agent gets the answers and the note; the spec appears with its next-step card, and everyone gets the toast', async () => {
    const card = question(ian);
    // Everyone is told when the first draft of the spec is there; the watchers start before the answer goes out.
    const told = people.map(({ page }) => toast(page, page === mei ? `${TOPIC}：spec 初稿好了` : `${TOPIC}: the spec draft is ready`));
    await card.getByRole('button', { name: 'Submit answers' }).click();

    // The card settles in every browser: the answers, who submitted, and the note that went to the agent with them.
    for (const page of [ian, amy, leo]) {
      const settled = question(page);
      await settled.getByText('Answered: Cards only').waitFor({ timeout: STEP_MS });
      await settled.getByText('Answered: On the server').waitFor({ timeout: STEP_MS });
      await settled.getByText(/^submitted by Ian, /).waitFor({ timeout: STEP_MS });
      await settled.getByText(`Note for Claude: Amy: @Leo ${COMMENT}`).waitFor({ timeout: STEP_MS });
    }
    await question(mei).getByText('已回答：Cards only').waitFor({ timeout: STEP_MS });
    await question(mei).getByText('已回答：On the server').waitFor({ timeout: STEP_MS });
    // The question and the open vote left every inbox.
    for (const { page } of people) await expect.poll(() => inbox(page).count(), { timeout: STEP_MS }).toBe(0);
    // What the agent received: the two answers, the tally and the note, and nothing of the comment thread besides.
    await waitUntil(async () => (await fileText(SPEC_PATH)) === SPEC, STEP_MS, 'the agent wrote SPEC.md');
    const received = (await env.claude.echoed()).filter((entry) => entry.kind === 'stdin').map((entry) => JSON.stringify(entry.value)).join('\n');
    expect(received).toContain('Cards only');
    expect(received).toContain('On the server');
    expect(received).toContain(`Amy: @Leo ${COMMENT}`);
    await Promise.all(told);
    await shots('spec-ready-toast');
    for (const { page } of people) await dismissToasts(page);

    for (const page of [ian, amy, leo]) {
      await discussion(page).getByRole('log').getByText('The first draft of the spec is ready.').waitFor({ timeout: STEP_MS });
      await discussion(page).locator('.conv-next[data-target="spec"]').getByText(NEXT_SPEC).waitFor({ timeout: STEP_MS });
    }
    const next = (page: Page): Locator => discussion(page).locator('.conv-next[data-target="spec"]');
    // Who can go on: the host and the member with agent access have the button, the others read who has it.
    await next(ian).getByRole('button', { name: 'Generate plan' }).waitFor({ timeout: STEP_MS });
    await next(mei).getByRole('button', { name: '產生計畫' }).waitFor({ timeout: STEP_MS });
    for (const page of [amy, leo]) {
      await next(page).getByText('Ian and Mei can generate the plan.').waitFor({ timeout: STEP_MS });
      expect(await next(page).getByRole('button', { name: 'Generate plan' }).count()).toBe(0);
    }
    // The topic's phase and its Spec row follow the file.
    for (const page of [ian, amy, leo]) {
      await phase(page).getByText('Spec', { exact: true }).waitFor({ timeout: STEP_MS });
      await row(page, `spec:${topicId}`).getByText('draft').waitFor({ timeout: STEP_MS });
    }

    // "Open spec" opens it beside the discussion, rendered; the toast's "Open" would do the same.
    await next(ian).getByRole('button', { name: 'Open spec' }).click();
    await next(mei).getByRole('button', { name: '開啟 spec' }).click();
    await next(amy).getByRole('button', { name: 'Open spec' }).click();
    await next(leo).getByRole('button', { name: 'Open spec' }).click();
    for (const { page } of people) {
      await spec(page).getByRole('heading', { name: 'Out of scope' }).waitFor({ timeout: STEP_MS });
      await spec(page).getByText('Invoices.').waitFor({ timeout: STEP_MS });
      // The discussion stayed: a link inside a column opens to the side.
      await discussion(page).waitFor({ timeout: STEP_MS });
    }
    await spec(ian).getByText(SPEC_PATH).waitFor({ timeout: STEP_MS });
    await shots('discussion-and-spec');
  }, 300_000);

  // =====================================================================================================================
  // The spec: people edit it together, the agent takes its turn, an Editor asks for a revision
  // =====================================================================================================================

  /** The last column's close button (the same in every language). */
  const closeColumn = async (page: Page, id: string): Promise<void> => {
    await column(page, id).locator('.col-head__actions button').last().click();
    await column(page, id).waitFor({ state: 'detached', timeout: STEP_MS });
  };
  /** Types into the collaborative editor of a spec column, at the end of the document. */
  const typeAtEnd = async (page: Page, text: string): Promise<void> => {
    const editor = spec(page).locator('.monaco-editor').first();
    await editor.waitFor({ timeout: STEP_MS });
    await spec(page).locator('.editor-doc__monaco[data-bound]').waitFor({ timeout: STEP_MS });
    await editor.locator('textarea, [role="textbox"]').first().focus();
    // The end of the document, as the editor binds it on the machine the browser runs on.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await page.keyboard.type(text);
  };

  it('Amy and Mei edit the spec together while the agent waits its turn', async () => {
    // A viewer reads: there is no "Edit" for him, and a sentence says who can.
    expect(await spec(leo).getByRole('radio', { name: 'Edit' }).count()).toBe(0);
    await spec(leo).getByText('Viewers read. Editing needs the role Editor or above.').waitFor({ timeout: STEP_MS });
    expect(await spec(leo).getByRole('button', { name: /^Ask the agent to revise/ }).count()).toBe(0);
    expect(await spec(leo).getByRole('button', { name: 'Generate plan' }).count()).toBe(0);

    await spec(amy).getByRole('radio', { name: 'Edit' }).click();
    await typeAtEnd(amy, `\n## Notes\n\n${AMY_TYPED}\n`);
    await spec(mei).getByRole('radio', { name: '編輯' }).click();
    // Mei's editor has Amy's lines before she types below them.
    await spec(mei).locator('.monaco-editor .view-lines', { hasText: AMY_TYPED }).waitFor({ timeout: STEP_MS });
    await typeAtEnd(mei, `${MEI_TYPED}\n`);
    // One document: each sees the other's text as it is typed, and the two who read see both.
    await spec(amy).locator('.monaco-editor .view-lines', { hasText: MEI_TYPED }).waitFor({ timeout: STEP_MS });
    for (const page of [ian, leo]) {
      await spec(page).getByRole('heading', { name: 'Notes' }).waitFor({ timeout: STEP_MS });
      await spec(page).getByText(AMY_TYPED).waitFor({ timeout: STEP_MS });
      await spec(page).getByText(MEI_TYPED).waitFor({ timeout: STEP_MS });
    }
    // While they type, the file is theirs: the editors say so.
    await spec(amy).getByText('You and Mei are editing this file (a shared edit lock), so agents cannot change it for now.').waitFor({ timeout: STEP_MS });

    // Ian asks the agent for a change meanwhile: its edit is not made, and the conversation says what it waits for.
    const box = discussion(ian).getByRole('combobox', { name: 'Message Claude · Discussion' });
    await box.fill(IAN_ASKS);
    await box.press('Enter');
    for (const page of [ian, amy, leo]) await discussion(page).getByText(/^Claude waits to edit specs\/checkout\/SPEC\.md: Amy(,| and) Mei are typing in it\.$/).waitFor({ timeout: STEP_MS });
    await discussion(mei).getByText(new RegExp(`Claude 正在等待編輯 ${SPEC_PATH.replaceAll('.', '\\.')}`)).waitFor({ timeout: STEP_MS });
    expect(await fileText(SPEC_PATH)).not.toContain('Gift cards.');
    await shots('coedit-agent-waits');

    // Both let the agent go first: its change arrives in every editor and every reader's page; what they typed stays.
    await spec(amy).getByRole('button', { name: 'Let the agent go first' }).click();
    await spec(mei).getByRole('button', { name: '讓 agent 先改' }).click();
    await discussion(ian).getByRole('log').getByText('Gift cards are out of scope now.').waitFor({ timeout: STEP_MS });
    for (const page of [ian, leo]) await spec(page).getByText('Invoices. Gift cards.').waitFor({ timeout: STEP_MS });
    for (const page of [amy, mei]) await spec(page).locator('.monaco-editor .view-lines', { hasText: 'Invoices. Gift cards.' }).waitFor({ timeout: STEP_MS });
    await waitUntil(async () => {
      const text = await fileText(SPEC_PATH);
      return text.includes('Invoices. Gift cards.') && text.includes(AMY_TYPED) && text.includes(MEI_TYPED);
    }, STEP_MS, 'SPEC.md to hold the two hand edits and the agent\'s change');
    await spec(amy).getByRole('radio', { name: 'Read' }).click();
    await spec(mei).getByRole('radio', { name: '閱讀' }).click();
    // In the Read view: the editor Amy just left is still mounted (hidden) and holds the same line, as one piece of
    // text or as two, depending on whether the agent's caret had been drawn in it when the editor was hidden.
    await spec(amy).getByRole('article').getByText('Invoices. Gift cards.').waitFor({ timeout: STEP_MS });
    await shots('coedit-agent-edited');
  }, 300_000);

  const SUGGESTION = { en: /^Suggestion from Amy/, zh: /^Amy 的建議/ } as const;
  const suggestion = (page: Page): Locator => discussion(page).getByRole('region', { name: page === mei ? SUGGESTION.zh : SUGGESTION.en });

  it('Amy asks for a revision: a suggestion for everyone to see, accepted by Mei, and only then a message to the agent', async () => {
    await spec(amy).getByRole('button', { name: 'Ask the agent to revise', exact: true }).click();
    await spec(amy).getByText('Goes to Ian and Mei as a suggestion: your role cannot message agents.').waitFor({ timeout: STEP_MS });
    await spec(amy).getByRole('textbox', { name: 'What should the agent change?' }).fill(AMY_REVISE);
    const sent = toast(amy, 'Sent as a suggestion to Ian and Mei.');
    await spec(amy).getByRole('button', { name: 'Send suggestion' }).click();
    await sent;
    await dismissToasts(amy);

    // The card is in the discussion for everyone; who can settle it has the buttons.
    for (const page of [ian, amy, leo]) await suggestion(page).getByText(AMY_REVISE).waitFor({ timeout: STEP_MS });
    await suggestion(amy).getByRole('button', { name: 'Withdraw' }).waitFor({ timeout: STEP_MS });
    expect(await suggestion(amy).getByRole('button', { name: 'Accept', exact: true }).count()).toBe(0);
    expect(await suggestion(leo).getByRole('button').count()).toBe(0);
    await suggestion(ian).getByRole('button', { name: 'Accept', exact: true }).waitFor({ timeout: STEP_MS });
    // It waits in the inboxes of the two who can accept it, and nothing of it has reached the agent.
    await inbox(ian, 'suggestion').filter({ hasText: /Amy: About SPEC\.md:\s+Please say that coupons/ }).waitFor({ timeout: STEP_MS });
    await inbox(ian, 'suggestion').filter({ hasText: /Checkout › Discussion · you or Mei/ }).waitFor({ timeout: STEP_MS });
    await inbox(mei, 'suggestion').filter({ hasText: AMY_REVISE }).waitFor({ timeout: STEP_MS });
    expect(await inbox(amy).count()).toBe(0);
    expect((await env.claude.echoed()).map((entry) => JSON.stringify(entry.value)).join('\n')).not.toContain(AMY_REVISE);
    await shots('revision-suggested');

    // Mei opens it from her inbox and accepts it (her page is in Traditional Chinese).
    await inbox(mei, 'suggestion').locator('.inbox-item__main').click();
    await suggestion(mei).getByText(AMY_REVISE).waitFor({ timeout: STEP_MS });
    await suggestion(mei).getByRole('button', { name: '採用', exact: true }).click();

    // Now it is Amy's message, marked as a suggestion and by whom it was accepted; the agent changes the spec.
    for (const page of [ian, amy, leo]) {
      const message = discussion(page).getByRole('log').locator('.conv-msg', { hasText: AMY_REVISE });
      await message.waitFor({ timeout: STEP_MS });
      expect(await message.textContent()).toMatch(/suggestion, accepted by Mei/);
      await discussion(page).getByRole('log').getByText('Coupons are out of scope now.').waitFor({ timeout: STEP_MS });
    }
    for (const { page } of people) await spec(page).getByRole('article').getByText('Invoices. Gift cards. Coupons.').waitFor({ timeout: STEP_MS });
    // The spec says who asked for the agent's last change.
    await spec(leo).getByText(/Changed by Claude at \d\d:\d\d, asked by Amy/).waitFor({ timeout: STEP_MS });
    for (const page of [ian, mei]) await expect.poll(() => inbox(page, 'suggestion').count(), { timeout: STEP_MS }).toBe(0);
    await shots('revision-accepted');
  }, 300_000);

  // =====================================================================================================================
  // The plan
  // =====================================================================================================================

  const plan = (page: Page): Locator => column(page, `plan:${topicId}`);
  const item = (page: Page, itemId: string): Locator => plan(page).locator(`.plan-item[data-item="${itemId}"]`);

  it('Generate plan: the agent\'s plan and its proposed split; one item is given to someone else', async () => {
    // An Editor and a Viewer cannot ask for the plan.
    for (const page of [amy, leo]) expect(await spec(page).getByRole('button', { name: 'Generate plan' }).count()).toBe(0);

    const told = people.map(({ page }) => toast(page, page === mei ? `${TOPIC}：計畫好了` : `${TOPIC}: the plan is ready`));
    await spec(mei).getByRole('button', { name: '產生計畫' }).click();
    // Mei's plan column opened beside the spec; the others are told, with "Open".
    await plan(mei).getByText('3 個工作項目').waitFor({ timeout: STEP_MS });
    await Promise.all(told);
    await shots('plan-ready-toast');
    await ian.locator('.ui-toast', { hasText: `${TOPIC}: the plan is ready` }).getByRole('button', { name: 'Open' }).click();
    for (const page of [amy, leo]) {
      await dismissToasts(page);
      await closeColumn(page, `session:${discussionId}`);
      await openRow(page, `plan:${topicId}`, { side: true });
    }
    for (const { page } of people) await dismissToasts(page);
    await waitUntil(async () => (await fileText(PLAN_PATH)) === PLAN, STEP_MS, 'the agent wrote PLAN.md');

    for (const page of [ian, amy, leo]) {
      await plan(page).getByText('3 work items').waitFor({ timeout: STEP_MS });
      await plan(page).getByText('2 can start now · 1 waits for others').waitFor({ timeout: STEP_MS });
      await plan(page).getByText(`Claude suggests this split among the people with agent access who are here: "${SPLIT_REASON}"`, { exact: false }).waitFor({ timeout: STEP_MS });
      await item(page, 'cart-api').getByText('Ready to start').waitFor({ timeout: STEP_MS });
      await item(page, 'checkout-page').getByText('Waits for 1').waitFor({ timeout: STEP_MS });
      await item(page, 'receipt-email').getByText('Ready to start').waitFor({ timeout: STEP_MS });
    }
    // The split as the agent proposed it: Mei the cart and the receipt, Ian the page.
    await item(ian, 'cart-api').getByRole('button', { name: 'Mei · suggested' }).waitFor({ timeout: STEP_MS });
    await item(ian, 'checkout-page').getByRole('button', { name: 'Ian (you) · suggested' }).waitFor({ timeout: STEP_MS });
    await item(ian, 'receipt-email').getByRole('button', { name: 'Mei · suggested' }).waitFor({ timeout: STEP_MS });
    // Who is not allowed to change it reads it: no menu, no mode switch, no Start.
    for (const page of [amy, leo]) {
      expect(await item(page, 'checkout-page').getByRole('button', { name: /suggested/ }).count()).toBe(0);
      await item(page, 'checkout-page').locator('.plan-who', { hasText: 'Ian · suggested' }).waitFor({ timeout: STEP_MS });
      expect(await plan(page).getByRole('radio', { name: 'No one assigned: everyone watches' }).count()).toBe(0);
      expect(await plan(page).getByRole('button', { name: /^Start \d+ items?$/ }).count()).toBe(0);
      await plan(page).getByText('Ian and Mei can start the plan.', { exact: false }).waitFor({ timeout: STEP_MS });
    }

    // Ian gives the checkout page to Amy: an Editor can be responsible; commands stay with Ian and Mei.
    await item(ian, 'checkout-page').getByRole('button', { name: 'Ian (you) · suggested' }).click();
    await ian.getByRole('menu', { name: 'Responsible for item 2: Ian. Change' }).locator('[data-menu-item="dev:Amy"]').click();
    for (const page of [ian, amy, leo]) {
      await item(page, 'checkout-page').locator('.plan-who', { hasText: 'Amy' }).waitFor({ timeout: STEP_MS });
      await item(page, 'checkout-page').getByText('Amy reviews the report and votes. Commands are allowed by Ian and Mei.').waitFor({ timeout: STEP_MS });
    }
    await item(mei, 'checkout-page').locator('.plan-who', { hasText: 'Amy' }).waitFor({ timeout: STEP_MS });
    await shots('plan-split-changed');
  }, 300_000);

  // =====================================================================================================================
  // Start
  // =====================================================================================================================

  let cartId = '';
  let receiptId = '';
  const itemSessionId = (itemId: string): string => env.stack.daemon.ctx.services.plans.get(topicId)?.items.find((one) => one.id === itemId)?.sessionId ?? '';
  const session = (page: Page, sessionId: string): Locator => column(page, `session:${sessionId}`);
  /** The columns a page shows, left to right. */
  const openColumns = (page: Page): Promise<string[]> => view(page).locator('[data-column-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-column-id') ?? ''));
  /** Makes a page show exactly these columns, side by side in this order. */
  const showOnly = async (page: Page, ids: readonly string[]): Promise<void> => {
    for (const id of await openColumns(page)) await closeColumn(page, id);
    for (const [index, id] of ids.entries()) await openRow(page, id, { side: index > 0 });
  };

  it('the Start dialog names the hand edits and the commit; Ian presses Start', async () => {
    // The button and the dialog's title say one number: what starts now (the third item waits for the first).
    await plan(ian).getByRole('button', { name: 'Start 2 items' }).click();
    const dialog = ian.getByRole('dialog', { name: 'Start 2 items' });
    const line = (id: string): Locator => dialog.locator(`.start-line[data-line="${id}"]`);
    await expect.poll(() => line('starts').textContent(), { timeout: STEP_MS }).toContain('2 items start now: 1 · Cart API and 3 · Receipt email.');
    expect(await line('waits').textContent()).toContain('2 · Checkout page starts by itself when 1 · Cart API is merged, if the spec and the plan are still what you see now.');
    expect(await line('responsible').textContent()).toContain('Responsible: Mei 2 · Amy 1.');
    // The commit is named before it is made: which files, where, as whom.
    expect(await line('commit').textContent()).toContain("smurg commits SPEC.md and PLAN.md to the branch main of the host's folder, as you.");
    // What people typed into the spec themselves is named, with who typed it; the changes can be read right here.
    const edits = (await line('handEdits').textContent()) ?? '';
    expect(edits).toMatch(/^Edited by hand since the last Start: /);
    expect(edits).toMatch(/Amy \(SPEC\.md, \d\d:\d\d\)/);
    expect(edits).toMatch(/Mei \(SPEC\.md, \d\d:\d\d\)/);
    await line('handEdits').getByRole('button', { name: 'Show the changes' }).click();
    await dialog.getByText(`+${AMY_TYPED}`).waitFor({ timeout: STEP_MS });
    expect(await line('settings').textContent()).toContain("The folder's Claude Code project settings are confirmed: agents read CLAUDE.md.");
    await shots('start-dialog', [{ name: 'Ian', page: ian }]);

    const head = await env.git(['rev-parse', 'HEAD']);
    const started = toast(ian, 'Started 2 items.');
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });
    // The toast says what happened: two sessions started, the third item starts by itself.
    await started;
    await ian.locator('.ui-toast', { hasText: 'Started 2 items.' }).getByText('1 more item starts by itself later.').waitFor({ timeout: STEP_MS });

    // The commit smurg made: the two files, as Ian, with who edited them by hand.
    await waitUntil(async () => (await env.git(['rev-parse', 'HEAD'])) !== head, STEP_MS, 'the checkpoint commit');
    const [subject, author, ...editedBy] = (await env.git(['log', '-1', '--format=%s%n%an%n%(trailers:key=Edited-by,valueonly)'])).split('\n').filter((entry) => entry !== '');
    expect(subject).toBe(`smurg: spec and plan of ${SLUG}`);
    expect(author).toBe('Ian');
    expect([...editedBy].sort()).toEqual(['Amy', 'Mei']);
    expect((await env.git(['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()).toEqual([PLAN_PATH, SPEC_PATH]);

    // Two items run, each in a worktree of its own; the third waits for the first.
    for (const page of [ian, amy, leo]) {
      await item(page, 'checkout-page').getByText('Waits for 1').waitFor({ timeout: STEP_MS });
      await phase(page).getByText('Executing', { exact: true }).waitFor({ timeout: STEP_MS });
    }
    await waitUntil(() => itemSessionId('cart-api') !== '' && itemSessionId('receipt-email') !== '', STEP_MS, 'the sessions of items 1 and 3');
    cartId = itemSessionId('cart-api');
    receiptId = itemSessionId('receipt-email');
    for (const { page } of people) {
      await row(page, `session:${cartId}`).waitFor({ timeout: STEP_MS });
      await row(page, `session:${receiptId}`).waitFor({ timeout: STEP_MS });
    }
    // Ian pressed Start with the plan on screen: it is pinned from that moment, so his first click on an item's
    // session opens beside the plan instead of replacing it.
    await plan(ian).getByRole('button', { name: /^Unpin column: Plan/ }).waitFor({ timeout: STEP_MS });
    await openRow(ian, `session:${cartId}`);
    expect(await openColumns(ian)).toContain(`plan:${topicId}`);
  }, 300_000);

  const openPermission = (page: Page, sessionId: string): Locator => session(page, sessionId).locator('.conv-card--permission:not(.ui-card--settled)');
  const openQuestion = (page: Page, sessionId: string): Locator => session(page, sessionId).locator('.conv-card--question:not(.ui-card--settled)');

  it('T4.3 three members watch three sessions side by side', async () => {
    const three = [`session:${discussionId}`, `session:${cartId}`, `session:${receiptId}`];
    for (const page of [ian, mei, amy]) await showOnly(page, three);
    for (const page of [ian, mei, amy]) {
      // Three columns, left to right, none over another and all inside the window.
      expect(await openColumns(page)).toEqual(three);
      const boxes = [];
      for (const id of three) boxes.push(await column(page, id).boundingBox());
      const width = page.viewportSize()?.width ?? 0;
      for (const [index, box] of boxes.entries()) {
        expect(box).not.toBeNull();
        expect(box?.width ?? 0).toBeGreaterThan(240);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width + 1);
        if (index > 0) expect(box?.x ?? 0).toBeGreaterThanOrEqual((boxes[index - 1]?.x ?? 0) + (boxes[index - 1]?.width ?? 0) - 1);
      }
      // Each column is its own live conversation: the discussion at rest, item 1 asking to run a command, item 3 asking a question.
      await discussion(page).getByRole('log').getByText('The plan has three work items.').waitFor({ timeout: STEP_MS });
      await session(page, cartId).getByRole('log').getByText('I start with the total.').waitFor({ timeout: STEP_MS });
      await expect.poll(() => openPermission(page, cartId).locator('.conv-perm__cmd').textContent(), { timeout: STEP_MS }).toBe('pnpm test');
      await openQuestion(page, receiptId).getByText(MAIL.question).waitFor({ timeout: STEP_MS });
    }
    // Where each session works, and who is responsible, is in its header.
    await session(ian, cartId).getByText('Responsible: Mei').waitFor({ timeout: STEP_MS });
    await session(ian, cartId).getByText(`Started from plan item 1 in the worktree smurg/${SLUG}/cart-api`).waitFor({ timeout: STEP_MS });

    // The command that waits at its permission card does not read as running, in either language.
    for (const [page, words] of [
      [ian, ['Command', 'waiting']],
      [amy, ['Command', 'waiting']],
      [mei, ['指令', '等待許可']],
    ] as const) {
      const line = session(page, cartId).locator('details.conv-tool', { hasText: 'pnpm test' });
      await expect.poll(() => line.getAttribute('data-state'), { timeout: STEP_MS }).toBe('waiting');
      const summary = (await line.locator('summary').textContent()) ?? '';
      for (const word of words) expect(summary).toContain(word);
      expect(summary).not.toMatch(/Running|running|正在執行|執行中/);
    }
    // One wait, one number: the card and the status bar under it count the same seconds, read in the same instant.
    for (let sample = 0; sample < 3; sample++) {
      const [card, bar] = await session(ian, cartId).evaluate((column) => {
        const seconds = (text: string | null | undefined): string => (text ?? '').match(/\d+ (?:sec|min)/)?.[0] ?? '';
        return [seconds(column.querySelector('.conv-card--permission:not(.ui-card--settled) .ui-card__meta')?.textContent), seconds(column.querySelector('.conv-status__age')?.textContent)];
      });
      expect(card).not.toBe('');
      expect(bar).toBe(card);
      await ian.waitForTimeout(700);
    }
    // An Editor's composer in a narrow column still names its session: the whole placeholder fits the box.
    for (const [id, name] of [
      [cartId, 'Suggest to Claude · 1 · Cart API'],
      [receiptId, 'Suggest to Claude · 3 · Receipt email'],
    ] as const) {
      const box = session(amy, id).getByRole('combobox', { name });
      const fits = await box.evaluate((node) => {
        const field = node as HTMLTextAreaElement;
        const style = getComputedStyle(field);
        const pen = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
        pen.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return pen.measureText(field.placeholder).width <= field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      });
      expect(fits, name).toBe(true);
      // The button beside it shows its icon and keeps its name.
      await session(amy, id).getByRole('button', { name: 'Send suggestion' }).waitFor({ timeout: STEP_MS });
    }
    await shots('three-sessions-side-by-side', people.filter((person) => person.page !== leo));

    // A vote in one column shows in the same column of the two others at once; the other columns do not move.
    await openQuestion(amy, receiptId).getByRole('radio', { name: /The SMTP relay we have/ }).click();
    await openQuestion(ian, receiptId).getByText('1 of 3 voted').waitFor({ timeout: STEP_MS });
    await openQuestion(mei, receiptId).getByText('3 人中 1 人已投票').waitFor({ timeout: STEP_MS });
    for (const page of [ian, mei, amy]) expect(await openPermission(page, cartId).count()).toBe(1);

    // Leo opens the three sessions late: each conversation is complete, from its first line to what is open now.
    await showOnly(leo, three);
    await discussion(leo).getByRole('log').getByText('Coupons are out of scope now.').waitFor({ timeout: STEP_MS });
    await session(leo, cartId).getByRole('log').getByText('I start with the total.').waitFor({ timeout: STEP_MS });
    await session(leo, cartId).locator('details.conv-tool', { hasText: 'src/cart/total.ts' }).waitFor({ timeout: STEP_MS });
    await expect.poll(() => openPermission(leo, cartId).locator('.conv-perm__cmd').textContent(), { timeout: STEP_MS }).toBe('pnpm test');
    await openQuestion(leo, receiptId).getByText('1 of 3 voted').waitFor({ timeout: STEP_MS });
    await openQuestion(leo, receiptId).getByText('You are watching. Viewers do not vote. Mei decides.').waitFor({ timeout: STEP_MS });
    // He can stop nothing and answer nothing.
    for (const id of [cartId, receiptId]) {
      expect(await session(leo, id).getByRole('button', { name: 'Stop' }).count()).toBe(0);
      expect(await session(leo, id).getByRole('combobox').count()).toBe(0);
    }
    expect(await openPermission(leo, cartId).getByRole('button').count()).toBe(0);
    await shots('three-sessions-opened-late', [{ name: 'Leo', page: leo }]);
  }, 300_000);

  it('Amy edits the spec: the item that waited is disarmed, and Mei starts it again', async () => {
    await showOnly(amy, [`spec:${topicId}`, `plan:${topicId}`]);
    await spec(amy).getByRole('radio', { name: 'Edit' }).click();
    await typeAtEnd(amy, `${AMY_SPEC_EDIT}\n`);

    // The item that had not started will not start by itself any more, and says why.
    for (const page of [amy, leo, ian]) {
      if (page !== amy) await openRow(page, `plan:${topicId}`, { side: true });
      await item(page, 'checkout-page').getByText('The plan changed: Start again').waitFor({ timeout: STEP_MS });
      await item(page, 'checkout-page').getByText('The spec or the plan changed since Start. This item did not start.', { exact: false }).waitFor({ timeout: STEP_MS });
    }
    // The member who pressed Start (Ian, who is also the host) is told in his inbox, with the way to start it again.
    await inbox(ian, 'attention').filter({ hasText: '2 · Checkout page did not start' }).waitFor({ timeout: STEP_MS });
    await inbox(ian, 'attention').locator('[data-inbox-action="start-again"]').waitFor({ timeout: STEP_MS });
    for (const page of [mei, amy, leo]) expect(await inbox(page, 'attention').count()).toBe(0);
    // An Editor and a Viewer cannot start it again.
    for (const page of [amy, leo]) expect(await item(page, 'checkout-page').getByRole('button', { name: 'Start again' }).count()).toBe(0);
    // Nothing of what Amy typed reached an agent.
    expect((await env.claude.echoed()).map((entry) => JSON.stringify(entry.value)).join('\n')).not.toContain('gift receipts');
    await shots('spec-edited-item-disarmed');

    // Mei starts it again from the plan (she has agent access): the dialog shows who edited what, and the commit.
    await showOnly(mei, [`plan:${topicId}`, `session:${cartId}`, `session:${receiptId}`]);
    await item(mei, 'checkout-page').getByText('計畫有變動：請重新開始').waitFor({ timeout: STEP_MS });
    await item(mei, 'checkout-page').getByRole('button', { name: '重新開始' }).click();
    const dialog = mei.getByRole('dialog', { name: '開始 1 個項目' });
    const line = (id: string): Locator => dialog.locator(`.start-line[data-line="${id}"]`);
    // What the dialog lists (in Traditional Chinese): nothing starts now, item 2 waits for item 1, the two running
    // items are not touched, the spec is committed again as her, and the plan is older than the spec.
    await expect.poll(() => line('waits').textContent(), { timeout: STEP_MS }).toContain('2 · Checkout page');
    expect(await line('already').textContent()).toContain('1 · Cart API');
    expect(await line('already').textContent()).toContain('3 · Receipt email');
    expect(await line('commit').textContent()).toContain('SPEC.md');
    await line('stale').waitFor({ timeout: STEP_MS });
    await shots('start-again-dialog', [{ name: 'Mei', page: mei }]);
    await dialog.getByRole('button', { name: '開始', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });

    for (const page of [amy, leo, ian]) await item(page, 'checkout-page').getByText('Waits for 1').waitFor({ timeout: STEP_MS });
    await expect.poll(() => inbox(ian, 'attention').count(), { timeout: STEP_MS }).toBe(0);
    // The spec as Amy left it is committed again, as Mei, who confirmed it.
    expect(await env.git(['log', '-1', '--format=%s%n%an'])).toBe(`smurg: spec and plan of ${SLUG}\nMei`);
    expect(await env.git(['show', '--name-only', '--format=', 'HEAD'])).toBe(SPEC_PATH);
    expect(await env.git(['show', 'HEAD:' + SPEC_PATH])).toContain(AMY_SPEC_EDIT);
    await spec(amy).getByRole('radio', { name: 'Read' }).click();
  }, 300_000);

  // =====================================================================================================================
  // Permission requests
  // =====================================================================================================================

  it('a permission card: Amy cannot answer, Mei allows once; pnpm add cannot be always allowed; pnpm test is allowed in every session of this topic', async () => {
    // The first request of item 1 has been waiting since the start: for Mei, who is responsible, in her inbox.
    await inbox(mei, 'permission').filter({ hasText: 'pnpm test' }).waitFor({ timeout: STEP_MS });
    await showOnly(amy, [`session:${cartId}`, `plan:${topicId}`]);
    const amyCard = openPermission(amy, cartId);
    await amyCard.getByText('Waiting for Mei (responsible), the host or a member with agent access. Your role cannot allow this.').waitFor({ timeout: STEP_MS });
    expect(await amyCard.getByRole('button').count()).toBe(0);
    expect(await inbox(amy, 'permission').count()).toBe(0);
    await openPermission(leo, cartId).getByText(/Your role cannot allow this\./).waitFor({ timeout: STEP_MS });
    // The host could answer too, and is told whose it is.
    await openPermission(ian, cartId).getByText("It is in Mei's inbox (responsible). You can answer too: the host and members with agent access may.").waitFor({ timeout: STEP_MS });
    await openPermission(ian, cartId).getByText('"This kind" is: commands that start with pnpm test. It also covers the same command after Claude changes the files it runs.').waitFor({ timeout: STEP_MS });
    await shots('permission-card');

    // Mei allows it once: the card settles for everyone, and the same command will ask again.
    await openPermission(mei, cartId).getByRole('button', { name: '允許一次' }).click();
    for (const page of [ian, amy, leo]) await session(page, cartId).getByText(/^Allowed once by Mei, /).first().waitFor({ timeout: STEP_MS });

    // pnpm add downloads and runs code: "Always allow this kind" is not offered, and the card says why.
    for (const page of [ian, amy, leo]) await expect.poll(() => openPermission(page, cartId).locator('.conv-perm__cmd').textContent(), { timeout: STEP_MS }).toBe('pnpm add -D vitest');
    await openPermission(ian, cartId).getByText('pnpm add downloads and runs code: it cannot be always allowed.').waitFor({ timeout: STEP_MS });
    expect(await openPermission(ian, cartId).getByRole('button', { name: 'Always allow this kind' }).count()).toBe(0);
    const meiCard = openPermission(mei, cartId);
    await meiCard.getByText('pnpm add 會下載並執行程式碼：不能設為一律允許。').waitFor({ timeout: STEP_MS });
    expect(await meiCard.getByRole('button', { name: '一律允許這類' }).count()).toBe(0);
    await shots('permission-cannot-always');
    await meiCard.getByRole('button', { name: '允許一次' }).click();

    // pnpm test again: this time Mei allows the kind, for every session of this topic.
    for (const page of [ian, amy, leo]) await expect.poll(() => openPermission(page, cartId).locator('.conv-perm__cmd').textContent(), { timeout: STEP_MS }).toBe('pnpm test');
    await expect.poll(() => openPermission(mei, cartId).locator('.conv-perm__cmd').textContent(), { timeout: STEP_MS }).toBe('pnpm test');
    await openPermission(mei, cartId).getByRole('radiogroup', { name: '「一律允許」的範圍' }).getByRole('radio', { name: '在這個主題的所有 session' }).check();
    await shots('permission-always-in-topic', [{ name: 'Mei', page: mei }]);
    await openPermission(mei, cartId).getByRole('button', { name: '一律允許這類' }).click();
    for (const page of [ian, amy, leo]) {
      await session(page, cartId).getByText(/^Allowed, and always for .*pnpm test.* in every session of this topic, by Mei, /).waitFor({ timeout: STEP_MS });
      await session(page, cartId).getByText(/^Mei always allows .*pnpm test.* in every session of this topic/).waitFor({ timeout: STEP_MS });
    }
    // The plan lists what the topic allows from now on.
    for (const page of [amy, leo, ian]) await plan(page).getByText('pnpm test *').first().waitFor({ timeout: STEP_MS });
    await expect.poll(() => inbox(mei, 'permission').count(), { timeout: STEP_MS }).toBe(0);
  }, 300_000);

  // =====================================================================================================================
  // A question nobody answers
  // =====================================================================================================================

  it('Mei does not answer a question: after the waiting time Ian submits for her', async () => {
    // It is Mei's to decide (she is responsible for item 3), and it has been in her inbox since the start.
    await inbox(mei, 'question').filter({ hasText: MAIL.question }).waitFor({ timeout: STEP_MS });
    await showOnly(amy, [`session:${receiptId}`, `plan:${topicId}`]);
    await openQuestion(amy, receiptId).getByText('Mei decides (responsible for this session). Your vote and comments are visible to everyone.').waitFor({ timeout: STEP_MS });

    // One minute after it was asked (the waiting time of this workspace) it reaches the host: the card says so to
    // everyone, and it is in Ian's inbox as a question he may answer for her.
    await openQuestion(ian, receiptId).getByText(/^Mei decides and has not answered for \d+ (sec|min)\. You can submit for them\./).waitFor({ timeout: 150_000 });
    for (const page of [amy, leo]) await openQuestion(page, receiptId).getByText(/^Mei has not answered for \d+ (sec|min)\.$/).waitFor({ timeout: STEP_MS });
    await inbox(ian, 'question').filter({ hasText: MAIL.question }).filter({ hasText: /Mei has not answered for/ }).waitFor({ timeout: STEP_MS });
    expect(await openQuestion(amy, receiptId).getByRole('button', { name: /Submit/ }).count()).toBe(0);
    await shots('question-escalated');

    // The answer is prefilled with the leading option (Amy's vote); Ian submits it for Mei.
    const card = openQuestion(ian, receiptId);
    await card.locator('.conv-q__submit').getByText('The SMTP relay we have').waitFor({ timeout: STEP_MS });
    await card.getByRole('button', { name: 'Submit for Mei' }).click();
    for (const page of [ian, amy, leo]) {
      await session(page, receiptId).getByText('Answered: The SMTP relay we have').waitFor({ timeout: STEP_MS });
      await session(page, receiptId).getByText(/^submitted by Ian for Mei, /).waitFor({ timeout: STEP_MS });
    }
    await session(mei, receiptId).getByText('已回答：The SMTP relay we have').waitFor({ timeout: STEP_MS });
    for (const page of [ian, mei]) await expect.poll(() => inbox(page, 'question').count(), { timeout: STEP_MS }).toBe(0);
  }, 400_000);

  // =====================================================================================================================
  // An agent that stops without a report
  // =====================================================================================================================

  it('an agent stops without a report: smurg nudges it once, then it is in the inbox of the responsible person', async () => {
    for (const page of [ian, amy, leo]) {
      const log = session(page, receiptId).getByRole('log');
      await log.getByText('I changed the title.').waitFor({ timeout: STEP_MS });
      await log.getByText('smurg asked Claude for the result report').waitFor({ timeout: STEP_MS });
      await log.getByText('I am not sure what is missing.').waitFor({ timeout: STEP_MS });
      await session(page, receiptId).getByRole('status').filter({ hasText: 'Stopped without a report.' }).waitFor({ timeout: STEP_MS });
      await item(page, 'receipt-email').getByText('Stopped without a report').waitFor({ timeout: STEP_MS });
    }
    // It waits for Mei, who is responsible; the host is not asked, and an Editor and a Viewer have nothing to press.
    await inbox(mei, 'attention').filter({ hasText: '3 · Receipt email 沒寫報告就停下了' }).waitFor({ timeout: STEP_MS });
    expect(await inbox(ian, 'attention').count()).toBe(0);
    for (const page of [amy, leo]) {
      expect(await session(page, receiptId).getByRole('button', { name: 'Continue' }).count()).toBe(0);
      expect(await item(page, 'receipt-email').getByRole('button', { name: 'Continue' }).count()).toBe(0);
    }
    await shots('stopped-without-a-report');

    // "Continue" from Mei's inbox: the agent runs pnpm test without asking anyone (the topic allows it) and reports.
    await inbox(mei, 'attention').locator('[data-inbox-action]').click();
    for (const page of [ian, amy, leo]) {
      const log = session(page, receiptId).getByRole('log');
      await log.getByText('Mei asked the agent to continue').waitFor({ timeout: STEP_MS });
      await log.getByText('The receipt email is done.').waitFor({ timeout: STEP_MS });
      await expect.poll(async () => log.locator('details.conv-tool', { hasText: 'pnpm test' }).locator('summary').textContent(), { timeout: STEP_MS }).toContain('Ran');
      expect(await session(page, receiptId).locator('.conv-card--permission').count()).toBe(0);
      await item(page, 'receipt-email').getByText('Report to review').waitFor({ timeout: STEP_MS });
    }
    await expect.poll(() => inbox(mei, 'attention').count(), { timeout: STEP_MS }).toBe(0);
  }, 300_000);

  // =====================================================================================================================
  // Result reports, reviews, merges
  // =====================================================================================================================

  const reportOf = (page: Page, itemId: string): Locator => column(page, `report:${topicId}:${itemId}`);
  /** The newest next-step card of a session's column (the one that still offers its step). */
  const nextCard = (page: Page, sessionId: string, target: string): Locator => session(page, sessionId).locator(`.conv-next[data-target="${target}"][data-latest]`);
  /**
   * Ian opens a change from his inbox: the row leads to the item's result report (never to the bare changes). He
   * presses "Merge…" there, gets the complete diff in a dialog, and merges it into the main workspace. A merge that
   * goes through closes the dialog; one that stops on a conflict leaves it open (`conflict`).
   */
  const mergeFromInbox = async (itemId: string, what: string, options: { readonly conflict?: boolean } = {}): Promise<{ report: Locator; review: Locator }> => {
    await inbox(ian, 'merge').filter({ hasText: `Reviewed, ready to merge: ${what}` }).locator('.inbox-item__main').click();
    const report = reportOf(ian, itemId);
    await report.getByRole('heading', { name: 'What to watch out for' }).waitFor({ timeout: STEP_MS });
    expect((await openColumns(ian)).filter((one) => one.startsWith('changes:'))).toEqual([]);
    // (Toasts sit over the foot of the rightmost column.)
    await dismissToasts(ian);
    await report.getByRole('button', { name: 'Merge…' }).click();
    const review = ian.getByRole('dialog', { name: /^Changes on smurg\// });
    await review.getByRole('button', { name: 'Merge into the main workspace' }).click();
    await review.getByRole('button', { name: 'Confirm merge' }).click();
    if (options.conflict !== true) await review.waitFor({ state: 'detached', timeout: STEP_MS });
    return { report, review };
  };
  const closeReport = (itemId: string): Promise<void> => closeColumn(ian, `report:${topicId}:${itemId}`);

  it('a result report marked partial, a follow-up, and "I\'ve reviewed this"', async () => {
    // The report's card closes the item's conversation and says who reviews it.
    for (const page of [ian, amy, leo]) {
      await showOnly(page, [`session:${cartId}`]);
      const card = nextCard(page, cartId, 'report');
      await card.getByText('The result report of 1 · Cart API is written.').waitFor({ timeout: STEP_MS });
      await card.getByText('Mei reviews it.').waitFor({ timeout: STEP_MS });
      await card.getByRole('button', { name: 'Open report' }).click();
      await reportOf(page, 'cart-api').getByRole('heading', { name: 'How it was verified' }).waitFor({ timeout: STEP_MS });
    }
    // It waits in Mei's inbox, with its outcome and its checks; she opens it from there.
    await showOnly(mei, [`session:${cartId}`]);
    await inbox(mei, 'report').filter({ hasText: '結果報告：1 · Cart API' }).locator('.inbox-item__main').click();
    await reportOf(mei, 'cart-api').locator('.report-checks').waitFor({ timeout: STEP_MS });
    for (const page of [ian, amy, leo]) expect(await inbox(page, 'report').count()).toBe(0);

    for (const page of [ian, amy, leo]) {
      const report = reportOf(page, 'cart-api');
      // The outcome stands beside the title; the checks are counted; unfinished work is not hidden.
      await report.locator('.col-head').getByText('Partial', { exact: true }).waitFor({ timeout: STEP_MS });
      await report.getByText('1 passed · 1 not verified').waitFor({ timeout: STEP_MS });
      await report.getByText('Waiting for Mei', { exact: true }).waitFor({ timeout: STEP_MS });
      for (const heading of ['What was done', 'Why it was done this way', 'How it was verified', 'What to watch out for', 'Changes']) await report.getByRole('heading', { name: heading }).waitFor({ timeout: STEP_MS });
      await report.getByText('The page was never opened in a browser.').waitFor({ timeout: STEP_MS });
      // Its changes: the files of the item's worktree, each with its diff.
      const files = report.getByRole('list', { name: 'Changed files' });
      await files.getByRole('button', { name: /src\/cart\/total\.ts/ }).waitFor({ timeout: STEP_MS });
      await files.getByRole('button', { name: /src\/app\.ts/ }).waitFor({ timeout: STEP_MS });
      // Only its reviewer has "I've reviewed this".
      expect(await report.getByRole('button', { name: "I've reviewed this" }).count()).toBe(0);
      // A Viewer has no box to ask in, and is not told there is one.
      await report.getByText(`Mei is responsible for this item and reviews this report. ${page === leo ? 'Everyone can read it.' : 'Everyone can read it and ask follow-ups.'}`, { exact: true }).waitFor({ timeout: STEP_MS });
    }
    const amyFiles = reportOf(amy, 'cart-api').getByRole('list', { name: 'Changed files' });
    await amyFiles.getByRole('button', { name: /src\/app\.ts/ }).click();
    await amyFiles.getByRole('region', { name: 'Diff of src/app.ts' }).getByText('Bookshop with a cart').waitFor({ timeout: STEP_MS });
    // A viewer reads it and can ask nothing; an Editor's follow-up would be a suggestion.
    expect(await reportOf(leo, 'cart-api').getByRole('textbox').count()).toBe(0);
    await reportOf(amy, 'cart-api').getByRole('textbox', { name: 'Suggest a question or a change' }).waitFor({ timeout: STEP_MS });
    await shots('report-partial');

    // Mei asks about the result: the question goes to the item's session, and the answer appears in the report.
    const ask = reportOf(mei, 'cart-api').getByRole('textbox', { name: '追問這個結果，或告訴 Claude 要改什麼' });
    await ask.fill(FOLLOW_UP);
    await reportOf(mei, 'cart-api').getByRole('button', { name: '送出', exact: true }).click();
    for (const page of [ian, amy, leo]) {
      const thread = reportOf(page, 'cart-api').locator('.report-thread');
      await thread.getByText(FOLLOW_UP).waitFor({ timeout: STEP_MS });
      await thread.getByText(FOLLOW_UP_ANSWER).waitFor({ timeout: STEP_MS });
      await session(page, cartId).getByRole('log').locator('.conv-msg', { hasText: FOLLOW_UP }).getByText('about a result report').waitFor({ timeout: STEP_MS });
    }
    await reportOf(mei, 'cart-api').locator('.report-thread').getByText(FOLLOW_UP_ANSWER).waitFor({ timeout: STEP_MS });
    await shots('report-follow-up');

    // "I've reviewed this": the work is unfinished, so smurg asks once before it counts.
    await dismissToasts(mei);
    await reportOf(mei, 'cart-api').getByRole('button', { name: '我已看過' }).click();
    await reportOf(mei, 'cart-api').getByText(/要把還沒完成的工作標成已看過嗎？/).waitFor({ timeout: STEP_MS });
    await reportOf(mei, 'cart-api').getByRole('button', { name: '標成已看過' }).click();
    for (const page of [amy, leo]) {
      await reportOf(page, 'cart-api').locator('.report__facts').getByText(/Reviewed by Mei, \d\d:\d\d/).waitFor({ timeout: STEP_MS });
      await reportOf(page, 'cart-api').getByText(/Reviewed by Mei at \d\d:\d\d\. The change is in the host's inbox, ready to merge\./).waitFor({ timeout: STEP_MS });
    }
    await reportOf(ian, 'cart-api').getByText(/Reviewed by Mei at \d\d:\d\d\. The change is ready for you to merge\./).waitFor({ timeout: STEP_MS });
    await expect.poll(() => inbox(mei, 'report').filter({ hasText: '1 · Cart API' }).count(), { timeout: STEP_MS }).toBe(0);
  }, 300_000);

  it('the change is in Ian\'s inbox, ready to merge; Ian merges it, and the item that waited for it starts by itself', async () => {
    // Only the host has it, and it says what waits for it.
    await inbox(ian, 'merge').filter({ hasText: 'Reviewed, ready to merge: 1 · Cart API' }).waitFor({ timeout: STEP_MS });
    await inbox(ian, 'merge').filter({ hasText: 'item 2 waits for it' }).waitFor({ timeout: STEP_MS });
    for (const page of [mei, amy, leo]) expect(await inbox(page, 'merge').count()).toBe(0);
    for (const page of [amy, leo]) {
      await showOnly(page, [`plan:${topicId}`]);
      await item(page, 'cart-api').getByText('Reviewed · waits for the host to merge').waitFor({ timeout: STEP_MS });
      await item(page, 'checkout-page').getByText('Waits for the host to merge 1').waitFor({ timeout: STEP_MS });
      expect(await reportOf(page, 'cart-api').getByRole('button', { name: 'Merge…' }).count()).toBe(0);
    }
    await showOnly(ian, [`plan:${topicId}`]);
    await shots('ready-to-merge');

    // The row leads to the report: the outcome, the check that was not verified and what to watch out for are what
    // the host reads before the merge.
    const { report: merging } = await mergeFromInbox('cart-api', '1 · Cart API');
    await waitUntil(async () => (await fileText('src/cart/total.ts')) === TOTAL_TS && (await fileText('src/app.ts')) === APP_BY_CART, STEP_MS, "item 1's change in the main workspace");
    // What the report says of a merged item: it is finished, and questions go to the discussion.
    await merging.locator('.col-head').getByText('Partial', { exact: true }).waitFor({ timeout: STEP_MS });
    await merging.getByText(/Reviewed by Mei at \d\d:\d\d\. Merged into the main workspace/).waitFor({ timeout: STEP_MS });
    await merging.getByText('This item is merged and its session has ended. Ask in the discussion.').waitFor({ timeout: STEP_MS });
    await expect.poll(() => inbox(ian, 'merge').count(), { timeout: STEP_MS }).toBe(0);
    await closeReport('cart-api');

    // Item 1 is finished; item 2 started by itself, in a worktree that has what item 1 merged.
    for (const page of [ian, amy, leo]) {
      await item(page, 'cart-api').getByText('Reviewed · merged').waitFor({ timeout: STEP_MS });
      await plan(page).getByText('1 of 3 reviewed').waitFor({ timeout: STEP_MS });
    }
    await waitUntil(() => itemSessionId('checkout-page') !== '', STEP_MS, 'the session of item 2');
    const pageId = itemSessionId('checkout-page');
    for (const { page } of people) await row(page, `session:${pageId}`).waitFor({ timeout: STEP_MS });

    // Its `pnpm test` asked nobody: the topic allows that kind since Mei said so. Amy, an Editor, is responsible:
    // the report is hers to review.
    for (const page of [ian, amy, leo]) {
      await openRow(page, `session:${pageId}`, { side: true });
      const log = session(page, pageId).getByRole('log');
      await log.getByText('The checkout page is done.').waitFor({ timeout: STEP_MS });
      await expect.poll(async () => log.locator('details.conv-tool', { hasText: 'pnpm test' }).locator('summary').textContent(), { timeout: STEP_MS }).toContain('Ran');
      expect(await session(page, pageId).locator('.conv-card--permission').count()).toBe(0);
      await session(page, pageId).getByText('Responsible: Amy').waitFor({ timeout: STEP_MS });
      await nextCard(page, pageId, 'report').getByText('Amy reviews it.').waitFor({ timeout: STEP_MS });
    }
    expect(await inbox(mei, 'permission').count()).toBe(0);
    await inbox(amy, 'report').filter({ hasText: 'Result report: 2 · Checkout page' }).locator('.inbox-item__main').click();
    const amyReport = reportOf(amy, 'checkout-page');
    await amyReport.getByText('Waiting for your review').waitFor({ timeout: STEP_MS });
    await amyReport.locator('.col-head').getByText('Complete', { exact: true }).waitFor({ timeout: STEP_MS });
    // The outcome stands whole beside the title, also in a narrow column: the title gives way, not the badge.
    expect(await amyReport.locator('.col-head__extra').evaluate((extra) => extra.scrollWidth <= extra.clientWidth && extra.clientWidth > 0)).toBe(true);
    await shots('item-2-report-for-the-editor', [{ name: 'Amy', page: amy }]);
    await dismissToasts(amy);
    await amyReport.getByRole('button', { name: "I've reviewed this" }).click();
    await amyReport.getByText(/Reviewed by Amy at \d\d:\d\d\. The change is in the host's inbox, ready to merge\./).waitFor({ timeout: STEP_MS });
    // She cannot merge; Ian can.
    expect(await amyReport.getByRole('button', { name: 'Merge…' }).count()).toBe(0);
    await mergeFromInbox('checkout-page', '2 · Checkout page');
    await waitUntil(async () => (await fileText('src/checkout/page.ts')).includes('checkout'), STEP_MS, "item 2's change in the main workspace");
    await closeReport('checkout-page');
    for (const page of [ian, amy, leo]) await plan(page).getByText('2 of 3 reviewed').waitFor({ timeout: STEP_MS });
  }, 300_000);

  it('a merge conflict: "Ask the agent to resolve"', async () => {
    // Item 3 changed the line item 1 changed. Mei reviews its report; the change is ready for Ian.
    await showOnly(mei, [`plan:${topicId}`, `session:${receiptId}`]);
    await inbox(mei, 'report').filter({ hasText: '結果報告：3 · Receipt email' }).locator('.inbox-item__main').click();
    await dismissToasts(mei);
    // With this review every report has been reviewed: the topic is complete for the first time, and everyone is told.
    const told = people.map(({ page }) => toast(page, page === mei ? `${TOPIC}：所有項目都看過了，主題已完成。` : `${TOPIC}: every item is reviewed. The topic is complete.`));
    await reportOf(mei, 'receipt-email').getByRole('button', { name: '我已看過' }).click();
    await Promise.all(told);
    for (const { page } of people) await dismissToasts(page);
    await inbox(ian, 'merge').filter({ hasText: 'Reviewed, ready to merge: 3 · Receipt email' }).waitFor({ timeout: STEP_MS });

    // Ian's merge stops on the conflict: nothing reached the main workspace, and every page says where it stands.
    const { report: conflicted, review } = await mergeFromInbox('receipt-email', '3 · Receipt email', { conflict: true });
    await review.getByText('The merge was aborted and the main workspace is unchanged. Files in conflict:', { exact: false }).first().waitFor({ timeout: STEP_MS });
    await review.getByText('src/app.ts').first().waitFor({ timeout: STEP_MS });
    expect(await fileText('src/app.ts')).toBe(APP_BY_CART);
    // The dialog says the item's agent can resolve it, and where that is asked: Ian closes it and is there.
    await review.getByText(/its agent can resolve the conflict: "Ask the agent to resolve" is in the item's result report/).waitFor({ timeout: STEP_MS });
    await review.getByRole('button', { name: 'Close', exact: true }).last().click();
    await review.waitFor({ state: 'detached', timeout: STEP_MS });
    // The row of the request that conflicted leads to the same report, and the way on is there: the host can ask
    // the agent to resolve, or try the merge again.
    const conflictRow = inbox(ian, 'merge').filter({ hasText: '3 · Receipt email' }).filter({ hasText: 'Conflict' });
    await conflictRow.locator('.inbox-item__main').click();
    await expect.poll(() => conflictRow.getAttribute('data-current'), { timeout: STEP_MS }).toBe('');
    expect((await openColumns(ian)).filter((one) => one.startsWith('changes:'))).toEqual([]);
    await conflicted.getByText(/Reviewed by Mei at \d\d:\d\d\. The merge stopped on a conflict\./).waitFor({ timeout: STEP_MS });
    await conflicted.getByRole('button', { name: 'Ask the agent to resolve' }).waitFor({ timeout: STEP_MS });
    await conflicted.getByRole('button', { name: 'Merge…' }).waitFor({ timeout: STEP_MS });
    for (const page of [ian, amy, leo]) {
      await item(page, 'receipt-email').getByText('Reviewed · merge conflict').waitFor({ timeout: STEP_MS });
    }
    // Who may ask the agent: the host and the member with agent access.
    await item(ian, 'receipt-email').getByRole('button', { name: 'Ask the agent to resolve' }).waitFor({ timeout: STEP_MS });
    for (const page of [amy, leo]) expect(await item(page, 'receipt-email').getByRole('button', { name: 'Ask the agent to resolve' }).count()).toBe(0);
    for (const page of [ian, amy, leo]) await openRow(page, `session:${receiptId}`, { side: true });
    await shots('merge-conflict');

    // Mei asks the agent: smurg merges the main workspace into the item's worktree, the agent resolves, and reports again.
    await item(mei, 'receipt-email').getByRole('button', { name: '請 agent 解決衝突' }).click();
    for (const page of [ian, amy, leo]) {
      const log = session(page, receiptId).getByRole('log');
      await log.getByText('Mei asked the agent to resolve the merge conflict').waitFor({ timeout: STEP_MS });
      await log.getByText('smurg merged the main workspace into this worktree: 1 file has conflicts').waitFor({ timeout: STEP_MS });
      await log.getByText('The conflict is resolved.').waitFor({ timeout: STEP_MS });
      // The report changed after it was reviewed: it must be read again, and the topic is not complete any more.
      await item(page, 'receipt-email').getByText('Changed after the review').waitFor({ timeout: STEP_MS });
      await phase(page).getByText('Executing', { exact: true }).waitFor({ timeout: STEP_MS });
      // The plan counts it as the list on the left does: two of three reviewed, one report to review again.
      await plan(page).getByText('2 of 3 reviewed').waitFor({ timeout: STEP_MS });
      await plan(page).getByText('1 report to review · 2 merged').waitFor({ timeout: STEP_MS });
    }
    await inbox(mei, 'report').filter({ hasText: '結果報告：3 · Receipt email' }).waitFor({ timeout: STEP_MS });
    // The request that conflicted is gone (the resolved work is a new one); nothing is in Ian's inbox until the review,
    // and the plan does not lead him to merge a version nobody has reviewed.
    await expect.poll(() => inbox(ian, 'merge').count(), { timeout: STEP_MS }).toBe(0);
    expect(await plan(ian).getByRole('button', { name: 'Open the next one to merge' }).count()).toBe(0);
    await closeReport('receipt-email');
    await shots('conflict-resolved-by-the-agent');
  }, 300_000);

  it('all reviewed: the topic is complete', async () => {
    const told = people.map(({ page }) => toast(page, page === mei ? `${TOPIC}：所有項目都看過了，主題已完成。` : `${TOPIC}: every item is reviewed. The topic is complete.`));
    await reportOf(mei, 'receipt-email').getByText('The title names both now.', { exact: false }).waitFor({ timeout: STEP_MS });
    await dismissToasts(mei);
    await reportOf(mei, 'receipt-email').getByRole('button', { name: '我已看過' }).click();
    await Promise.all(told);
    for (const page of [ian, amy, leo]) {
      await phase(page).getByText('Complete', { exact: true }).waitFor({ timeout: STEP_MS });
      await plan(page).getByText('Topic complete').waitFor({ timeout: STEP_MS });
      await plan(page).getByText("Every result report has been reviewed. Not merged yet: 3 · Receipt email (in the host's inbox).").waitFor({ timeout: STEP_MS });
      await plan(page).getByText('3 of 3 reviewed').waitFor({ timeout: STEP_MS });
    }
    await shots('topic-complete');
    for (const { page } of people) await dismissToasts(page);

    // The last change merges cleanly now: the title names both.
    await mergeFromInbox('receipt-email', '3 · Receipt email');
    await waitUntil(async () => (await fileText('src/app.ts')) === APP_RESOLVED, STEP_MS, 'the resolved change in the main workspace');
    await closeReport('receipt-email');
    for (const page of [ian, amy, leo]) {
      await plan(page).getByText('Every result report has been reviewed.', { exact: true }).waitFor({ timeout: STEP_MS });
      for (const id of ['cart-api', 'checkout-page', 'receipt-email']) await item(page, id).getByText('Reviewed · merged').waitFor({ timeout: STEP_MS });
    }
    expect(await env.git(['status', '--porcelain'])).toBe('');
    for (const { page } of people) await expect.poll(() => inbox(page).count(), { timeout: STEP_MS }).toBe(0);
  }, 300_000);

  // =====================================================================================================================
  // Code mode and back
  // =====================================================================================================================

  /** The text of the file on screen in code mode's editor (the sessions view's own editors are mounted too, and hidden). */
  const editorOf = (page: Page): Locator => view(page).locator('.editor-doc__monaco[data-bound]:visible .view-lines');

  it('T7.1 the mode switch keeps both sides', async () => {
    // The sessions view as Ian leaves it: two columns, a message he has typed and not sent, and a place in the plan's file.
    await showOnly(ian, [`session:${discussionId}`, `plan:${topicId}`]);
    const composer = discussion(ian).getByRole('combobox', { name: 'Message Claude · Discussion' });
    await composer.fill(ONE_MORE);
    await plan(ian).getByRole('radio', { name: 'File' }).click();
    await plan(ian).locator('.monaco-editor .view-lines', { hasText: '# Plan: Checkout' }).waitFor({ timeout: STEP_MS });
    const columnsBefore = await openColumns(ian);
    const address = ian.url();
    await shots('before-code-mode', [{ name: 'Ian', page: ian }]);

    // Code mode: the file tree, the merged file in the editor, the discussion beside it, the drawer on "Conflicts".
    await toCodeMode(ian);
    expect(ian.url()).toBe(`${address}/code`);
    await ian.getByRole('treeitem', { name: 'src' }).first().click();
    await ian.getByRole('treeitem', { name: 'app.ts' }).first().click();
    await editorOf(ian).getByText('Bookshop with a cart and receipts').waitFor({ timeout: STEP_MS });
    const chooser = ian.getByRole('combobox', { name: 'Session shown beside the editor' });
    const label = (await chooser.locator('option').allTextContents()).find((text) => text.includes('Discussion')) ?? '';
    await chooser.selectOption({ label });
    // The session beside the editor is the same kind of column as in the sessions view.
    const beside = ian.locator(`.col--code[data-column-id="session:${discussionId}"]`);
    await beside.getByRole('log').getByText('The plan has three work items.').waitFor({ timeout: STEP_MS });
    // The message he typed in the sessions view is the same draft here: one session, one box.
    await expect.poll(() => beside.getByRole('combobox', { name: 'Message Claude · Discussion' }).inputValue(), { timeout: STEP_MS }).toBe(ONE_MORE);
    await openDrawer(ian);
    await ian.getByRole('tab', { name: 'Conflicts', exact: true }).click();
    expect(await ian.getByRole('tab', { name: 'Conflicts', exact: true }).getAttribute('aria-selected')).toBe('true');
    await shots('code-mode', [{ name: 'Ian', page: ian }]);

    // Back: the same columns in the same order, the draft, and the plan still on its file. Nothing was loaded again.
    await toSessionsView(ian);
    expect(ian.url()).toBe(address);
    expect(await openColumns(ian)).toEqual(columnsBefore);
    expect(await composer.inputValue()).toBe(ONE_MORE);
    expect(await plan(ian).getByRole('radio', { name: 'File' }).isChecked()).toBe(true);
    await plan(ian).locator('.monaco-editor .view-lines', { hasText: '# Plan: Checkout' }).waitFor({ timeout: STEP_MS });

    // And code mode again is as he left it: the file open in the editor, the session beside it, the drawer's tab.
    await toCodeMode(ian);
    await editorOf(ian).getByText('Bookshop with a cart and receipts').waitFor({ timeout: STEP_MS });
    expect(await chooser.inputValue()).not.toBe('');
    await beside.getByRole('log').getByText('The plan has three work items.').waitFor({ timeout: STEP_MS });
    expect(await ian.getByRole('tab', { name: 'Conflicts', exact: true }).getAttribute('aria-selected')).toBe('true');
    await toSessionsView(ian);
    await plan(ian).getByRole('radio', { name: 'Items' }).click();

    // A viewer has the switch too: he reads the code, and his columns are there when he comes back.
    const leoColumns = await openColumns(leo);
    await toCodeMode(leo);
    await leo.getByRole('treeitem', { name: 'src' }).first().click();
    await leo.getByRole('treeitem', { name: 'app.ts' }).first().click();
    await editorOf(leo).getByText('Bookshop with a cart and receipts').waitFor({ timeout: STEP_MS });
    await toSessionsView(leo);
    expect(await openColumns(leo)).toEqual(leoColumns);
  }, 300_000);

  // =====================================================================================================================
  // One more work item; smurg restarts on the host's computer; a process dies
  // =====================================================================================================================

  let giftId = '';

  it('one more work item after the topic was complete: the plan grows and Ian starts it', async () => {
    // The draft that survived the mode switch is sent now.
    await discussion(ian).getByRole('combobox', { name: 'Message Claude · Discussion' }).press('Enter');
    await discussion(ian).getByRole('log').getByText('The plan has a fourth work item.').waitFor({ timeout: STEP_MS });
    for (const page of [ian, amy, leo]) {
      await showOnly(page, [`plan:${topicId}`]);
      await item(page, 'gift-receipt').getByText('Ready to start').waitFor({ timeout: STEP_MS });
      // The topic is not complete any more: three of four items are reviewed.
      await phase(page).getByText('Executing', { exact: true }).waitFor({ timeout: STEP_MS });
      await plan(page).getByText('3 of 4 reviewed').waitFor({ timeout: STEP_MS });
      for (const id of ['cart-api', 'checkout-page', 'receipt-email']) await item(page, id).getByText('Reviewed · merged').waitFor({ timeout: STEP_MS });
    }
    await plan(ian).getByRole('button', { name: 'Start 1 more item' }).click();
    const dialog = ian.getByRole('dialog', { name: 'Start 1 item' });
    await expect.poll(() => dialog.locator('.start-line[data-line="starts"]').textContent(), { timeout: STEP_MS }).toContain('1 item starts now: 4 · Gift receipt.');
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });
    await waitUntil(() => itemSessionId('gift-receipt') !== '', STEP_MS, 'the session of item 4');
    giftId = itemSessionId('gift-receipt');

    // Its command is not of a kind the topic allows: it asks, and waits.
    for (const page of [ian, amy, leo]) {
      await openRow(page, `session:${giftId}`, { side: true });
      await expect.poll(() => openPermission(page, giftId).locator('.conv-perm__cmd').textContent(), { timeout: STEP_MS }).toBe('pnpm build');
      await item(page, 'gift-receipt').getByText('Waiting for permission').waitFor({ timeout: STEP_MS });
    }
    await showOnly(mei, [`plan:${topicId}`, `session:${giftId}`]);
    await expect.poll(() => openPermission(mei, giftId).locator('.conv-perm__cmd').textContent(), { timeout: STEP_MS }).toBe('pnpm build');
  }, 300_000);

  const restartBanner = (page: Page): Locator => page.locator('[data-banner="restart"]');

  it('smurg restarts on the host\'s computer: everything is readable, the plan is paused, and "Continue all" goes on', async () => {
    // Amy and Leo also have older things on screen: they must read the same after the restart.
    await openRow(amy, `session:${discussionId}`, { side: true });
    await openRow(leo, `session:${cartId}`, { side: true });
    await env.setScenario(SCENARIO_AFTER_RESTART);

    await env.restartDaemon();

    // Every browser finds the host again by itself, and says what happened and who can go on.
    await restartBanner(ian).getByText("smurg was restarted on the host's computer. 1 item is paused.").waitFor({ timeout: 120_000 });
    await restartBanner(mei).getByText('主人電腦上的 smurg 重新啟動了。1 個項目已暫停。').waitFor({ timeout: 120_000 });
    for (const page of [amy, leo]) {
      await expect.poll(() => restartBanner(page).textContent(), { timeout: 120_000 }).toMatch(/^smurg was restarted on the host's computer\. .+ paused\. The host or a member with agent access can continue them\.$/);
      expect(await page.getByRole('button', { name: 'Continue all' }).count()).toBe(0);
    }
    // The plan is paused: nothing in it runs, and its item says why it stopped.
    for (const page of [ian, amy, leo]) {
      await plan(page).getByText("smurg was restarted on the host's computer").waitFor({ timeout: STEP_MS });
      await item(page, 'gift-receipt').getByText('Paused: smurg was restarted').waitFor({ timeout: STEP_MS });
      // The conversation is there as it was; the card nobody answered says what became of it.
      const log = session(page, giftId).getByRole('log');
      await log.getByText('Started from plan item 4 in the worktree', { exact: false }).waitFor({ timeout: STEP_MS });
      await log.locator('details.conv-tool', { hasText: 'src/gift/receipt.ts' }).waitFor({ timeout: STEP_MS });
      await session(page, giftId).getByText('Not answered: smurg was restarted. Claude asks again when the session continues.').waitFor({ timeout: STEP_MS });
      await log.getByText("smurg was restarted on the host's computer. The agent's turn was interrupted.").waitFor({ timeout: STEP_MS });
      expect(await openPermission(page, giftId).count()).toBe(0);
      // The command never ran: its line does not say it did, and the session says why it stands still.
      const build = log.locator('details.conv-tool', { hasText: 'pnpm build' });
      expect(await build.getAttribute('data-state')).toBe('unfinished');
      expect(await build.locator('summary').textContent()).toContain('not finished');
      await session(page, giftId).getByRole('status').filter({ hasText: 'Paused: smurg was restarted.' }).waitFor({ timeout: STEP_MS });
    }
    await plan(amy).getByText('Nothing in this plan runs until it is continued. Ian and Mei can continue it.').waitFor({ timeout: STEP_MS });
    // What was said and decided before the restart reads as before: the discussion with its answered question, an
    // ended item's conversation with its settled cards.
    await discussion(amy).getByRole('log').getByText(FIRST_MESSAGE).first().waitFor({ timeout: STEP_MS });
    await discussion(amy).getByText('Answered: Cards only').waitFor({ timeout: STEP_MS });
    await discussion(amy).getByRole('log').getByText('The plan has a fourth work item.').waitFor({ timeout: STEP_MS });
    await session(leo, cartId).getByRole('log').getByText('I start with the total.').waitFor({ timeout: STEP_MS });
    await session(leo, cartId).getByText(/^Allowed once by Mei, /).first().waitFor({ timeout: STEP_MS });
    // It is in the inbox of the one who pressed Start, with the way on.
    await inbox(ian, 'attention').filter({ hasText: 'smurg was restarted: 1 item is paused' }).waitFor({ timeout: STEP_MS });
    await shots('after-the-restart');

    // "Continue all": the session goes on in the same conversation and asks for its command again, on a new card.
    await ian.locator('.sidebar-banner, .app-shell').getByRole('button', { name: 'Continue all' }).first().click();
    for (const page of [ian, amy, leo]) {
      await restartBanner(page).waitFor({ state: 'detached', timeout: STEP_MS });
      await expect.poll(() => openPermission(page, giftId).locator('.conv-perm__cmd').textContent(), { timeout: STEP_MS }).toBe('pnpm build');
      await item(page, 'gift-receipt').getByText('Waiting for permission').waitFor({ timeout: STEP_MS });
    }
    await restartBanner(mei).waitFor({ state: 'detached', timeout: STEP_MS });
    await expect.poll(() => inbox(ian, 'attention').count(), { timeout: STEP_MS }).toBe(0);
    // The stand-in was started again for the SAME conversation (what Claude Code calls --resume).
    const launches = (await env.claude.echoed()).filter((entry) => entry.kind === 'argv' && entry.session === giftId).map((entry) => entry.value as string[]);
    expect(launches.length).toBe(2);
    expect(launches[1]).toContain('--resume');
  }, 400_000);

  it('a session\'s process is killed: "Try again" continues it, and the last item is reviewed and merged', async () => {
    await env.setScenario(SCENARIO_AFTER_KILL);
    expect(await env.killAgentOf(giftId)).toBe(1);

    // Everyone sees that it failed; the card it had open says why it will never be answered.
    for (const page of [ian, amy, leo]) {
      await session(page, giftId).getByRole('status').filter({ hasText: 'The agent stopped with an error.' }).waitFor({ timeout: STEP_MS });
      await session(page, giftId).getByText('Not answered: the agent stopped with an error.').waitFor({ timeout: STEP_MS });
      await item(page, 'gift-receipt').getByText('Failed', { exact: true }).waitFor({ timeout: STEP_MS });
    }
    await inbox(ian, 'attention').filter({ hasText: "4 · Gift receipt: the agent's process failed" }).waitFor({ timeout: STEP_MS });
    for (const page of [amy, leo]) {
      expect(await session(page, giftId).getByRole('button', { name: 'Try again' }).count()).toBe(0);
      expect(await item(page, 'gift-receipt').getByRole('button', { name: 'Try again' }).count()).toBe(0);
    }
    await shots('process-killed');

    // "Try again": the same conversation goes on, and this time the item is finished.
    await session(ian, giftId).locator('.conv-status').getByRole('button', { name: 'Try again' }).click();
    for (const page of [ian, amy, leo]) {
      await session(page, giftId).getByRole('log').getByText('The gift receipt is done.').waitFor({ timeout: STEP_MS });
      await item(page, 'gift-receipt').getByText('Report to review').waitFor({ timeout: STEP_MS });
    }
    await expect.poll(() => inbox(ian, 'attention').count(), { timeout: STEP_MS }).toBe(0);

    // Ian is responsible for it: he reviews its report and merges it. Everything is done.
    const told = people.map(({ page }) => toast(page, page === mei ? `${TOPIC}：所有項目都看過了，主題已完成。` : `${TOPIC}: every item is reviewed. The topic is complete.`));
    await inbox(ian, 'report').filter({ hasText: 'Result report: 4 · Gift receipt' }).locator('.inbox-item__main').click();
    await dismissToasts(ian);
    await reportOf(ian, 'gift-receipt').getByRole('button', { name: "I've reviewed this" }).click();
    await Promise.all(told);
    for (const { page } of people) await dismissToasts(page);
    await mergeFromInbox('gift-receipt', '4 · Gift receipt');
    await waitUntil(async () => (await fileText('src/gift/receipt.ts')).includes('gift'), STEP_MS, "item 4's change in the main workspace");
    await closeReport('gift-receipt');
    for (const page of [ian, amy, leo]) {
      await phase(page).getByText('Complete', { exact: true }).waitFor({ timeout: STEP_MS });
      await plan(page).getByText('4 of 4 reviewed').waitFor({ timeout: STEP_MS });
      await plan(page).getByText('Every result report has been reviewed.', { exact: true }).waitFor({ timeout: STEP_MS });
    }
    expect(await env.git(['status', '--porcelain'])).toBe('');
    await shots('everything-done');
  }, 400_000);

  // =====================================================================================================================
  // The viewer
  // =====================================================================================================================

  it('Leo saw all of it and could do none of it', async () => {
    // Everything of the topic opens for him: the discussion, the spec, the plan, a report.
    await showOnly(leo, [`session:${discussionId}`, `spec:${topicId}`, `plan:${topicId}`]);
    await openRow(leo, `session:${giftId}`, { side: true });
    await discussion(leo).getByRole('log').getByText('The plan has a fourth work item.').waitFor({ timeout: STEP_MS });
    await spec(leo).getByText(AMY_SPEC_EDIT).waitFor({ timeout: STEP_MS });
    await session(leo, giftId).getByRole('log').getByText('The gift receipt is done.').waitFor({ timeout: STEP_MS });
    // In all of it there is nothing he can press that acts on an agent, a file, the plan or a merge, and no box to write in.
    const columns = view(leo).locator('[data-column-id]');
    const acting = /^(Stop|Send|Send suggestion|Comment|Allow once|Always allow this kind|Deny|Submit|Accept|Reject|Withdraw|Generate plan|Update plan|Ask the agent|Start|Continue|Try again|I've reviewed this|Review instead|Merge|Request merge|Archive topic|Add a kind|Suggest again|Let the agent go first|Remind)/;
    expect(await columns.getByRole('button', { name: acting }).allTextContents()).toEqual([]);
    expect(await columns.getByRole('combobox').count()).toBe(0);
    expect(await columns.getByRole('textbox').count()).toBe(0);
    expect(await spec(leo).getByRole('radio', { name: 'Edit' }).count()).toBe(0);
    await shots('the-viewer-at-the-end', [{ name: 'Leo', page: leo }]);
    // "New" tells him why not, for each of its three entries.
    for (const [entry, dialogName] of [
      ['New topic', 'New topic'],
      ['New session', 'New session'],
      ['Terminal', 'New terminal'],
    ] as const) {
      await leo.getByRole('button', { name: 'New', exact: true }).click();
      await leo.getByRole('menuitem', { name: entry, exact: true }).click();
      const dialog = leo.getByRole('dialog', { name: dialogName });
      await dialog.waitFor({ timeout: STEP_MS });
      expect(await dialog.getByRole('textbox').count()).toBe(0);
      expect(await dialog.getByRole('button', { name: /^(Open|Start discussion)$/ }).count()).toBe(0);
      await leo.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached', timeout: STEP_MS });
    }
    // His inbox held one thing in the whole story: the mention. And the host's audit log has nothing he did to the
    // work: no request of his changed a session, a topic, a plan, a report, a file or a merge.
    expect(await inbox(leo).count()).toBe(0);
    await env.stack.daemon.ctx.audit.flush();
    const byLeo = (await env.stack.daemon.ctx.audit.query({ limit: 2_000 })).filter((entry) => entry.actor.kind === 'user' && entry.actor.userId === 'dev:Leo' && entry.outcome === 'ok');
    expect(byLeo.map((entry) => entry.action).filter((action) => /^(session|topic|plan|report|permission|question|suggest|worktree|file|doc|lock|scheduler|spec)\./.test(action))).toEqual([]);
  }, 300_000);

  it('nothing in the pages failed on the way; how long the flow took and what it sent through the relay', async () => {
    // The English pages never showed a Chinese character of the interface (what Mei wrote would be allowed: she wrote none).
    for (const page of [ian, amy, leo]) expect(await cjkTexts(page)).toEqual([]);
    expect(env.allProblems).toEqual([]);

    // DESIGN §9.5 item 6: the frames of the whole flow through the local relay, as its tap counted them, from the
    // start of the relay to here: four browsers joining, the whole story (one minute of it is the question nobody
    // answers), one restart of the host's smurg. What a hosted relay is billed by are the frames it RECEIVES.
    const seconds = (Date.now() - env.startedAt) / 1000;
    const frames = env.frames();
    const measure = {
      seconds: Math.round(seconds),
      storySeconds: Math.round((Date.now() - startedAt) / 1000),
      framesIn: frames.in,
      framesInFromHost: frames.inFromHost,
      framesInFromBrowsers: frames.inFromClients,
      framesOut: frames.out,
      bytesIn: frames.inBytes,
      httpRequests: frames.requests,
      framesInPerMinute: Math.round(frames.in / (seconds / 60)),
      browsers: people.length,
    };
    console.info(`[flow] ${JSON.stringify(measure)}`);
    if (SHOTS !== '') await writeFile(join(SHOTS, 'flow-measure.json'), `${JSON.stringify(measure, null, 2)}\n`);
    expect(frames.in).toBeGreaterThan(0);
  }, 120_000);
});
