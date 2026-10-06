// The topic screens of v0.5.0 in a real browser (DESIGN §5.11 `topics.smoke`): the BUILT app served by the real
// relay, a daemon composing the release's modules on a git repository, the scripted stand-in `claude`
// (packages/daemon/src/testing/fake-claude.mjs: no Claude Code, no account, no network), and system Chrome driven
// headless in fresh contexts. Every step waits for a condition.
//
// What only the real stack proves about a topic:
//   - "New topic" creates the folder and the discussion; the first draft of the spec the agent writes shows in the
//     spec column, rendered, and the same document is the collaborative editor a second member reads live;
//   - the plan column reads PLAN.md as the daemon parsed it; who is responsible is changed from the row; an Editor's
//     "Ask the agent to revise" arrives as a suggestion;
//   - the Start dialog lists what the daemon would do (the commit, what waits) and Start runs the item in its own
//     worktree; the agent's checked report shows in the report column with its changes; "I've reviewed this" and the
//     host's "Merge…" finish the item, and the item that waited for it starts by itself.
//
// The scenario below is the whole "model": a turn is chosen by a pattern on the message smurg (or a person) sent.
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFakeClaude, type FakeClaude, type FakeClaudeScenario } from '../../../../packages/daemon/src/testing/index.ts';
import { STEP_MS, explainFailures, joinAs, joinAsHost, startSmoke, systemChrome, waitUntil, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

/** The `smurg` command as sessions run it in development: the agents' hooks and the `smurg` MCP server (check_plan, check_report) are real. */
const CLI_MAIN = fileURLToPath(new URL('../../../../packages/cli/src/main.ts', import.meta.url));

const SLUG = 'checkout-redesign';
const SPEC = ['# Checkout redesign', '', 'Buying a book takes one page instead of three steps.', '', '## Goal', '', 'People pay by card and get a receipt by email.', '', '## Payments', '', 'Cards only.', ''].join('\n');
const PLAN = [
  '# Plan: Checkout redesign',
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
  '<!-- smurg:plan end -->',
  '',
].join('\n');
const REPORT = [
  '# Result report: Cart API',
  '',
  '<!-- smurg:report v1 item=cart-api -->',
  '- outcome: complete',
  '',
  '## What was done',
  'The cart total is computed in `src/cart/total.ts`.',
  '',
  '## Why it was done this way',
  'One place computes the total, as the spec decided.',
  '',
  '## How it was verified',
  '- [x] `pnpm test cart`: 3 tests passed',
  '- [ ] Manual check in the browser: not verified: no browser in this session',
  '',
  '## What to watch out for',
  'Stock is not checked yet.',
  '',
].join('\n');

/** What the "model" does: the spec on the first message, the plan when smurg asks for it, an item with its checked report. */
const SCENARIO: FakeClaudeScenario = {
  turns: [
    {
      match: 'Start work item 1 ',
      steps: [
        { tool: 'Write', input: { file_path: 'src/cart/total.ts', content: 'export const total = (prices: number[]): number => prices.reduce((a, b) => a + b, 0);\n' } },
        { tool: 'Write', input: { file_path: `specs/${SLUG}/reports/cart-api.md`, content: REPORT } },
        { tool: 'mcp__smurg__check_report', input: {} },
        { text: 'The cart total is done; the report is written.' },
      ],
    },
    { match: 'Start work item 2 ', steps: [{ text: 'Starting on the checkout page.' }, { wait: 'interrupt' }] },
    {
      match: 'Then call check_plan',
      steps: [{ tool: 'Write', input: { file_path: `specs/${SLUG}/PLAN.md`, content: PLAN } }, { tool: 'mcp__smurg__check_plan', input: {} }, { text: 'The plan has two work items.' }],
    },
    { match: 'one page', once: true, steps: [{ tool: 'Write', input: { file_path: `specs/${SLUG}/SPEC.md`, content: SPEC } }, { text: 'I wrote the first draft of the spec.' }] },
    { steps: [{ text: 'Noted.' }] },
  ],
};

describe.skipIf(chrome === null)('a topic from start to finish in a real browser (built app, real relay, real daemon, the stand-in claude)', () => {
  let env: SmokeEnv;
  let host: Page;
  let amy: Page;
  let claude: FakeClaude;

  beforeAll(async () => {
    claude = await installFakeClaude(await mkdtemp(join(process.env['TMPDIR'] as string, 'topics-claude-')), SCENARIO);
    env = await startSmoke({
      stack: {
        git: true,
        projectFiles: { 'README.md': '# Bookshop\n', 'src/app.ts': 'export const x = 1;\n' },
        sessions: { claudePath: claude.path, selfCommand: { file: process.execPath, args: [CLI_MAIN] } },
      },
    });
    host = await env.newPage({ width: 1500, height: 900 });
    await joinAsHost(host, env);
    amy = await env.newPage({ width: 1300, height: 900 });
    await joinAs(amy, env, 'amy', 'editor');
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  const column = (page: Page, name: string | RegExp) => page.getByRole('region', { name });
  const treeRow = (page: Page, name: string | RegExp) => page.getByRole('treeitem', { name }).first();

  it('New topic: the folder follows the name; the discussion starts and the agent writes the first draft of the spec', async () => {
    await host.getByRole('button', { name: 'New', exact: true }).click();
    await host.getByRole('menuitem', { name: 'New topic' }).click();
    const dialog = host.getByRole('dialog', { name: 'New topic' });
    await dialog.getByLabel('Name').fill('Checkout redesign');
    await expect.poll(() => dialog.getByLabel(/^Folder for the spec and the plan/).inputValue(), { timeout: STEP_MS }).toBe(SLUG);
    await dialog.getByLabel(/^What do you want to build/).fill('Checkout on one page instead of three steps.');
    await dialog.getByRole('button', { name: 'Start discussion' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });

    // The topic is in the session list with its fixed rows; the draft makes the phase "Spec".
    await treeRow(host, /^Spec/).waitFor({ timeout: STEP_MS });
    await waitUntil(async () => (await readFile(join(env.stack.root, 'specs', SLUG, 'SPEC.md'), 'utf8').catch(() => '')) === SPEC, STEP_MS, 'the agent wrote SPEC.md');
    await treeRow(host, /^Spec/).click();
    const spec = column(host, 'Spec');
    await spec.getByRole('heading', { name: 'Payments' }).waitFor({ timeout: STEP_MS });
    await spec.getByText('Cards only.').waitFor({ timeout: STEP_MS });
    await spec.getByText(`specs/${SLUG}/SPEC.md`).waitFor({ timeout: STEP_MS });
  }, 240_000);

  it('the spec is one collaborative document: what the host types in Edit shows in the editor\'s Read view', async () => {
    await treeRow(amy, /^Spec/).click();
    const reading = column(amy, 'Spec');
    await reading.getByText('Cards only.').waitFor({ timeout: STEP_MS });

    const spec = column(host, 'Spec');
    await spec.getByRole('radio', { name: 'Edit' }).click();
    const editor = spec.getByRole('group', { name: `Editor for specs/${SLUG}/SPEC.md` });
    await editor.locator('.monaco-editor').first().waitFor({ timeout: STEP_MS });
    await editor.locator('.monaco-editor textarea, .monaco-editor [role="textbox"]').first().focus();
    // Wherever the caret is: a section of its own.
    await host.keyboard.type('## Out of scope\n\nCoupons.\n\n');
    await reading.getByRole('heading', { name: 'Out of scope' }).waitFor({ timeout: STEP_MS });
    await reading.getByText('Coupons.').waitFor({ timeout: STEP_MS });
    await spec.getByRole('radio', { name: 'Read' }).click();
    await spec.getByRole('article', { name: 'The spec' }).getByText('Coupons.').waitFor({ timeout: STEP_MS });
  }, 240_000);

  it('Generate plan opens the plan beside the spec; the items are the daemon\'s reading of PLAN.md', async () => {
    await column(host, 'Spec').getByRole('button', { name: 'Generate plan' }).click();
    const plan = column(host, 'Plan');
    await plan.getByText('2 work items').waitFor({ timeout: STEP_MS });
    const items = plan.getByRole('list', { name: 'Work items' }).getByRole('listitem');
    await expect.poll(() => items.count(), { timeout: STEP_MS }).toBe(2);
    await items.nth(0).getByText('Ready to start').waitFor({ timeout: STEP_MS });
    await items.nth(1).getByText('Waits for 1').waitFor({ timeout: STEP_MS });
    await plan.getByText('1 can start now · 1 waits for others').waitFor({ timeout: STEP_MS });
    expect(await readFile(join(env.stack.root, 'specs', SLUG, 'PLAN.md'), 'utf8')).toBe(PLAN);
  }, 240_000);

  it('an editor reads the plan and asks the agent to revise: it arrives as a suggestion', async () => {
    await treeRow(amy, /^Plan/).click();
    const plan = column(amy, 'Plan');
    await plan.getByText('2 work items').waitFor({ timeout: STEP_MS });
    expect(await plan.getByRole('button', { name: /^Start/ }).count()).toBe(0);
    await plan.getByRole('button', { name: 'Ask the agent to revise' }).click();
    const box = plan.getByRole('textbox', { name: 'What should the agent change?' });
    await box.fill('Please add an item for the receipt email.');
    await plan.getByRole('button', { name: 'Send suggestion' }).click();
    await amy.getByText(/^Sent as a suggestion to /).waitFor({ timeout: STEP_MS });
  }, 240_000);

  it('the Start dialog says what a Start does; Start runs item 1 in its own worktree and its checked report arrives', async () => {
    const plan = column(host, 'Plan');
    // The button and the dialog's title say one number: what starts now (the second item waits for the first).
    await plan.getByRole('button', { name: /^Start 1 item$/ }).click();
    const dialog = host.getByRole('dialog', { name: /^Start 1 item$/ });
    await dialog.getByText(/^1 item starts now: 1 · Cart API\.$/).waitFor({ timeout: STEP_MS });
    await dialog.getByText(/^2 · Checkout page starts by itself when 1 · Cart API is merged/).waitFor({ timeout: STEP_MS });
    await dialog.getByText(/smurg commits SPEC\.md and PLAN\.md to the branch main of the host's folder, as you\./).waitFor({ timeout: STEP_MS });
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });

    const first = plan.getByRole('list', { name: 'Work items' }).getByRole('listitem').nth(0);
    await first.getByText('Report to review').waitFor({ timeout: STEP_MS });
    await first.getByRole('button', { name: 'Report' }).click();
    const report = column(host, /^Result report: 1 · Cart API/);
    for (const heading of ['What was done', 'Why it was done this way', 'How it was verified', 'What to watch out for']) await report.getByRole('heading', { name: heading }).waitFor({ timeout: STEP_MS });
    await report.getByText('1 passed · 1 not verified').waitFor({ timeout: STEP_MS });
    // The changes of the item's worktree, with the file the agent wrote.
    const files = report.getByRole('list', { name: 'Changed files' });
    await files.getByRole('button', { name: /src\/cart\/total\.ts/ }).click();
    await files.getByRole('region', { name: 'Diff of src/cart/total.ts' }).waitFor({ timeout: STEP_MS });
  }, 300_000);

  it('"I\'ve reviewed this", then the host\'s "Merge…": the item is finished and the one that waited starts by itself', async () => {
    const report = column(host, /^Result report: 1 · Cart API/);
    await report.getByRole('button', { name: "I've reviewed this" }).click();
    await report.getByText(/^Reviewed by .+ The change is ready for you to merge\.$/).waitFor({ timeout: STEP_MS });
    await report.getByRole('button', { name: 'Merge…' }).click();
    const review = host.getByRole('dialog', { name: /^Changes on smurg\// });
    await review.getByRole('button', { name: 'Merge into the main workspace' }).click();
    await review.getByRole('button', { name: 'Confirm merge' }).click();
    await review.waitFor({ state: 'detached', timeout: STEP_MS });
    await waitUntil(async () => (await readFile(join(env.stack.root, 'src', 'cart', 'total.ts'), 'utf8').catch(() => '')).includes('total'), STEP_MS, "the item's change is in the main workspace");

    const items = column(host, 'Plan').getByRole('list', { name: 'Work items' }).getByRole('listitem');
    await items.nth(0).getByText('Reviewed · merged').waitFor({ timeout: STEP_MS });
    await items.nth(1).getByText('Running').waitFor({ timeout: STEP_MS });
    await column(host, 'Plan').getByText('1 of 2 reviewed').waitFor({ timeout: STEP_MS });
    // The editor's plan followed without a reload.
    await column(amy, 'Plan').getByText('1 of 2 reviewed').waitFor({ timeout: STEP_MS });
  }, 300_000);

  it('nothing in the pages failed on the way', () => {
    expect(env.allProblems).toEqual([]);
  });
});
