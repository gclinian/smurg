// The flow in Traditional Chinese, in real browsers (DESIGN §9.5 item 4, its last sentence; docs/ACCEPTANCE.md row
// T8.2): the BUILT app served by the real relay, a daemon on the release composition, the scripted stand-in `claude`
// with the real `smurg hook` / `smurg mcp` commands. The short path of the owner's flow on a page in Traditional
// Chinese, with a topic named in Chinese: New topic → the agent's question → the spec → the plan → Start → a
// permission request → the result report → "I've reviewed this" → the merge → the topic is complete.
//
// Two people: the host on a zh-TW page does all of it; Amy (an Editor) watches on an English page and votes. At every
// stop the Chinese page must hold no label nobody translated, and the English page no Chinese character besides what
// the people and the agent wrote themselves (the checks of the language smokes, on the screens of the flow).
//
// With SMURG_SMOKE_SHOTS=<folder> every stop writes a numbered picture of both pages.
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFakeClaude, type FakeClaudeScenario } from '../../../../packages/daemon/src/testing/index.ts';
import { STEP_MS, cjkTexts, explainFailures, joinAs, joinAsHost, startSmoke, systemChrome, untranslatedTexts, waitUntil, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

const SHOTS = process.env['SMURG_SMOKE_SHOTS'] ?? '';
/** The `smurg` command as sessions run it in development: the agents' hooks and the `smurg` MCP server are real. */
const CLI_MAIN = fileURLToPath(new URL('../../../../packages/cli/src/main.ts', import.meta.url));

// ---- what the people and the agent write: all of it Chinese, none of it the interface's own text
const TOPIC = '結帳流程改版';
/** A name without Latin letters gets a numbered folder; the topic keeps its name. */
const SLUG = 'topic-1';
const FIRST_MESSAGE = '我們要把結帳改成一頁完成。';
const QUESTION = { question: '付款方式要支援哪些？', header: '付款', multiSelect: false, options: [{ label: '只收信用卡', description: '沿用現有的金流。' }, { label: '信用卡和發票', description: '要多做一個地址表單。' }] };
const SAYS = {
  ask: '寫 spec 之前，有一件事要先決定。',
  spec: 'spec 初稿寫好了。',
  plan: '計畫有兩個工作項目。',
  cart: '購物車做好了。',
  page: '結帳頁面做好了。',
};
const SPEC = ['# 結帳流程改版', '', '## 目標', '買書只要一頁就能完成。', '', '## 決定', '- 付款：只收信用卡。', '', '## 待確認的問題', '無。', ''].join('\n');
const PLAN = [
  '# 計畫：結帳流程改版',
  '',
  '<!-- smurg:plan v1 -->',
  '',
  '### 1. 購物車金額',
  '- id: cart-total',
  '- size: m',
  '- touches: src/cart/**',
  '',
  '把總金額的計算集中在一個模組。',
  '',
  '### 2. 結帳頁面',
  '- id: checkout-page',
  '- depends on: cart-total',
  '- size: l',
  '- touches: src/checkout/**',
  '',
  '把購物車和付款放在同一頁。',
  '',
  '<!-- smurg:plan end -->',
  '',
].join('\n');
// (The title line and the headings of a report file are a fixed format in English; what is said under them is the agent's.)
const report = (itemId: string, title: string): string =>
  [`# Result report: ${title}`, '', `<!-- smurg:report v1 item=${itemId} -->`, '- outcome: complete', '', '## What was done', `${title}完成了。`, '', '## Why it was done this way', '照 spec 的決定做。', '', '## How it was verified', '- [x] 測試全部通過', '', '## What to watch out for', '沒有特別要注意的事。', ''].join('\n');
/** Everything Chinese that people or the agent wrote: what the English page may show. */
const WRITTEN = [TOPIC, FIRST_MESSAGE, QUESTION.question, QUESTION.header, ...QUESTION.options.flatMap((option) => [option.label, option.description]), ...Object.values(SAYS), ...SPEC.split('\n'), ...PLAN.split('\n'), ...report('x', '購物車金額').split('\n'), ...report('x', '結帳頁面').split('\n'), '購物車金額', '結帳頁面'].filter((line) => line.trim() !== '');

/**
 * What is Latin on a page in Traditional Chinese without being untranslated: the terms the zh-TW catalogue keeps as
 * they are (docs/GLOSSARY.md), the product's and the agent's names, and what this test itself made: account names,
 * the folder, paths, commands, tool names, branches, the worktree's and the session's ids.
 */
const LATIN_OK: readonly (string | RegExp)[] = [
  'smurg', 'Claude', 'session', 'spec', 'agent', 'worktree', 'code', 'Claude Code', 'CLAUDE.md', 'SPEC.md', 'PLAN.md', 'README.md', 'Markdown', 'git', 'main',
  'host', 'Host', 'Amy', 'project', SLUG, 'cart-total', 'checkout-page', 'pnpm test', 'Bash', 'check_plan', 'check_report', 'propose_split',
  // The message of the commit smurg makes for a work item (git's own record, in English).
  /smurg: work item \d+ \([\w-]+\)/g,
  /specs\/[\w./-]*/g, /src\/[\w./-]*/g, /smurg\/[\w./-]+/g, /\b[0-9a-f]{7,40}\b/g, /\b(?:ses|tp|mr|wt|rq)_[\w-]+/g, /\b[SML]\b/g,
];

/**
 * Not interface text: what smurg itself wrote to an agent (a message between programs, always English; folded away in
 * the conversation), and the lines of a diff (the files' own text).
 */
const NOT_INTERFACE = '.conv-smurg__text, .worktree-diff__text';

const SCENARIO: FakeClaudeScenario = {
  turns: [
    {
      match: 'Start work item 1 ',
      steps: [
        { tool: 'Write', input: { file_path: 'src/cart/total.ts', content: 'export const total = 1;\n' } },
        { tool: 'Bash', input: { command: 'pnpm test' }, suggest: { toolName: 'Bash', ruleContent: 'pnpm test *' }, result: '3 passed' },
        { tool: 'Write', input: { file_path: `specs/${SLUG}/reports/cart-total.md`, content: report('cart-total', '購物車金額') } },
        { tool: 'mcp__smurg__check_report', input: {} },
        { text: SAYS.cart },
      ],
    },
    {
      match: 'Start work item 2 ',
      steps: [
        { tool: 'Write', input: { file_path: 'src/checkout/page.ts', content: 'export const page = 1;\n' } },
        { tool: 'Write', input: { file_path: `specs/${SLUG}/reports/checkout-page.md`, content: report('checkout-page', '結帳頁面') } },
        { tool: 'mcp__smurg__check_report', input: {} },
        { text: SAYS.page },
      ],
    },
    { match: 'Then call check_plan', steps: [{ tool: 'Write', input: { file_path: `specs/${SLUG}/PLAN.md`, content: PLAN } }, { tool: 'mcp__smurg__check_plan', input: {} }, { text: SAYS.plan }] },
    {
      steps: [{ text: SAYS.ask }, { tool: 'AskUserQuestion', input: { questions: [QUESTION] } }, { tool: 'Write', input: { file_path: `specs/${SLUG}/SPEC.md`, content: SPEC } }, { text: SAYS.spec }],
    },
  ],
};

describe.skipIf(chrome === null)('the flow in Traditional Chinese, in real browsers (built app, real relay, real daemon, the stand-in claude)', () => {
  let env: SmokeEnv;
  let host: Page;
  let amy: Page;
  let step = 0;

  beforeAll(async () => {
    if (SHOTS !== '') await mkdir(SHOTS, { recursive: true });
    const claude = await installFakeClaude(await mkdtemp(join(process.env['TMPDIR'] as string, 'flow-zh-claude-')), SCENARIO);
    env = await startSmoke({
      stack: {
        git: true,
        projectFiles: { 'README.md': '# Bookshop\n', 'src/app.ts': 'export const x = 1;\n' },
        sessions: { claudePath: claude.path, selfCommand: { file: process.execPath, args: [CLI_MAIN] } },
      },
    });
    host = await env.newPage({ width: 1440, height: 900, locale: 'zh-TW' });
    await joinAsHost(host, env);
    amy = await env.newPage({ width: 1280, height: 900 });
    await joinAs(amy, env, 'Amy', 'editor');
  }, 300_000);

  afterAll(async () => {
    await env?.stop();
  }, 120_000);

  explainFailures(() => env);

  const view = (page: Page): Locator => page.locator('.app-shell__view:not([hidden])');
  const column = (page: Page, idPrefix: string): Locator => view(page).locator(`[data-column-id^="${idPrefix}"]`);
  const inbox = (page: Page, kind: string): Locator => page.locator(`aside.sidebar .inbox-item[data-kind="${kind}"]`);
  const dismissToasts = async (page: Page): Promise<void> => {
    await page.evaluate(() => {
      for (const close of document.querySelectorAll<HTMLButtonElement>('.ui-toast button[aria-label]')) close.click();
    });
    await expect.poll(() => page.locator('.ui-toast').count(), { timeout: STEP_MS }).toBe(0);
  };
  /** One stop of the flow: both pages are checked for the other language, and photographed. */
  const stop = async (name: string): Promise<void> => {
    step += 1;
    expect(await untranslatedTexts(host, LATIN_OK, NOT_INTERFACE), `untranslated text on the Chinese page (${name})`).toEqual([]);
    expect(await cjkTexts(amy, WRITTEN), `Chinese interface text on the English page (${name})`).toEqual([]);
    if (SHOTS === '') return;
    for (const [who, page] of [['host-zh', host], ['amy-en', amy]] as const) await page.screenshot({ path: join(SHOTS, `${String(step).padStart(2, '0')}-${name}--${who}.png`) });
  };

  it('T8.2 the flow in Traditional Chinese', async () => {
    expect(await host.locator('html').getAttribute('lang')).toBe('zh-Hant-TW');
    await stop('first-run');

    // ---- New topic, named in Chinese: the folder gets a Latin name and the dialog says why.
    await host.getByRole('button', { name: '新增', exact: true }).click();
    await host.getByRole('menuitem', { name: '新增主題' }).click();
    const dialog = host.getByRole('dialog', { name: '新增主題' });
    await dialog.getByLabel('名稱').fill(TOPIC);
    await expect.poll(() => dialog.getByLabel(/^spec 與計畫的資料夾/).inputValue(), { timeout: STEP_MS }).toBe(SLUG);
    await dialog.getByText('資料夾名稱使用英文字母；主題會保留自己的名稱。', { exact: false }).waitFor({ timeout: STEP_MS });
    await dialog.getByLabel(/^想做什麼？/).fill(FIRST_MESSAGE);
    await stop('new-topic-dialog');
    await dialog.getByRole('button', { name: '開始討論' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });

    // ---- The discussion: the agent's question, a vote from the English page, the host's answer.
    const discussion = column(host, 'session:');
    const question = discussion.getByRole('region', { name: 'Claude 的選擇題' });
    await question.getByText(QUESTION.question).waitFor({ timeout: STEP_MS });
    await question.getByText('由你決定：這個 session 沒有指派負責人，而它是你開的。', { exact: false }).waitFor({ timeout: STEP_MS });
    // Amy finds the topic under its Chinese name and votes.
    await dismissToasts(amy);
    await amy.getByRole('treeitem', { name: /^Discussion/ }).first().click();
    const amyQuestion = column(amy, 'session:').getByRole('region', { name: 'Question from Claude' });
    await amyQuestion.getByRole('radio', { name: new RegExp(QUESTION.options[0]?.label ?? '') }).click();
    await question.getByText('2 人中 1 人已投票').waitFor({ timeout: STEP_MS });
    await stop('question');
    await question.getByRole('radio', { name: new RegExp(QUESTION.options[0]?.label ?? '') }).click();
    await question.getByRole('button', { name: '送出答案' }).click();
    await discussion.getByText(`已回答：${QUESTION.options[0]?.label ?? ''}`).waitFor({ timeout: STEP_MS });
    await waitUntil(async () => (await readFile(join(env.stack.root, 'specs', SLUG, 'SPEC.md'), 'utf8').catch(() => '')) === SPEC, STEP_MS, 'the agent wrote SPEC.md into the numbered folder');

    // ---- The spec, with its next-step card; "Generate plan".
    const next = discussion.locator('.conv-next[data-target="spec"][data-latest]');
    await next.getByText('spec 初稿完成了。', { exact: false }).waitFor({ timeout: STEP_MS });
    await dismissToasts(host);
    await next.getByRole('button', { name: '開啟 spec' }).click();
    const spec = column(host, 'spec:');
    await spec.getByRole('heading', { name: '目標' }).waitFor({ timeout: STEP_MS });
    await stop('spec');
    await spec.getByRole('button', { name: '產生計畫' }).click();
    const plan = column(host, 'plan:');
    await plan.getByText('2 個工作項目').waitFor({ timeout: STEP_MS });
    await plan.getByText('1 個現在可以開始 · 1 個要等其他項目').waitFor({ timeout: STEP_MS });
    await plan.locator('.plan-item[data-item="cart-total"]').getByText('可以開始').waitFor({ timeout: STEP_MS });
    await plan.locator('.plan-item[data-item="checkout-page"]').getByText('等待 1').waitFor({ timeout: STEP_MS });
    await dismissToasts(host);
    await stop('plan');
    // The plan stays (it is pinned from the Start on); the discussion and the spec make room for what comes.
    for (const prefix of ['session:', 'spec:']) await column(host, prefix).locator('.col-head__actions button').last().click();
    await expect.poll(() => view(host).locator('[data-column-id]').count(), { timeout: STEP_MS }).toBe(1);

    // ---- Start: the dialog in Chinese, then the item's session and its permission request.
    // The button and the dialog's title say one number: what starts now.
    await plan.getByRole('button', { name: '開始 1 個項目' }).click();
    const start = host.getByRole('dialog', { name: '開始 1 個項目' });
    await expect.poll(() => start.locator('.start-line[data-line="starts"]').textContent(), { timeout: STEP_MS }).toContain('1 個項目現在開始：1 · 購物車金額。');
    expect(await start.locator('.start-line[data-line="commit"]').textContent()).toContain('smurg 會以你的身分，把 SPEC.md 和 PLAN.md 提交到主人資料夾的 main 分支。');
    await stop('start-dialog');
    await start.getByRole('button', { name: '開始', exact: true }).click();
    await start.waitFor({ state: 'detached', timeout: STEP_MS });
    await inbox(host, 'permission').filter({ hasText: 'pnpm test' }).locator('.inbox-item__main').click();
    const card = view(host).locator('.conv-card--permission:not(.ui-card--settled)');
    await expect.poll(() => card.locator('.conv-perm__cmd').textContent(), { timeout: STEP_MS }).toBe('pnpm test');
    await dismissToasts(host);
    await stop('permission-request');
    await card.getByRole('button', { name: '允許一次' }).click();

    // ---- The result report: opened from the inbox, reviewed, merged; the item that waited starts by itself.
    await inbox(host, 'report').filter({ hasText: '結果報告：1 · 購物車金額' }).locator('.inbox-item__main').click();
    const reportColumn = column(host, 'report:');
    for (const heading of ['做了什麼', '為什麼這樣做', '怎麼驗證的', '要注意什麼', '變更']) await reportColumn.getByRole('heading', { name: heading }).waitFor({ timeout: STEP_MS });
    await reportColumn.getByText('等你看').waitFor({ timeout: STEP_MS });
    await dismissToasts(host);
    await stop('report');
    await reportColumn.getByRole('button', { name: '我已看過' }).click();
    // The change is in the host's inbox by itself; its row leads to the report, and the report's button shows the
    // complete diff before the merge.
    await inbox(host, 'merge').filter({ hasText: '已看過，可以合併：1 · 購物車金額' }).locator('.inbox-item__main').click();
    expect(await view(host).locator('[data-column-id^="changes:"]').count()).toBe(0);
    await dismissToasts(host);
    await reportColumn.getByRole('button', { name: '合併…' }).click();
    const changes = host.getByRole('dialog', { name: /的變更$/ });
    await changes.getByRole('button', { name: '合併到主工作區' }).waitFor({ timeout: STEP_MS });
    await stop('changes-to-merge');
    await changes.getByRole('button', { name: '合併到主工作區' }).click();
    await changes.getByRole('button', { name: '確認合併' }).click();
    await changes.waitFor({ state: 'detached', timeout: STEP_MS });
    await waitUntil(async () => (await readFile(join(env.stack.root, 'src', 'cart', 'total.ts'), 'utf8').catch(() => '')).includes('total'), STEP_MS, "item 1's change in the main workspace");

    // ---- The second item reports by itself; reviewed and merged, the topic is complete.
    await inbox(host, 'report').filter({ hasText: '結果報告：2 · 結帳頁面' }).locator('.inbox-item__main').click();
    const second = view(host).locator('[data-column-id$=":checkout-page"]');
    await second.getByRole('button', { name: '我已看過' }).click();
    await host.locator('.ui-toast__title', { hasText: `${TOPIC}：所有項目都看過了，主題已完成。` }).first().waitFor({ timeout: STEP_MS });
    await inbox(host, 'merge').filter({ hasText: '已看過，可以合併：2 · 結帳頁面' }).locator('.inbox-item__main').click();
    await dismissToasts(host);
    await second.getByRole('button', { name: '合併…' }).click();
    const lastChanges = host.getByRole('dialog', { name: /的變更$/ });
    await lastChanges.getByRole('button', { name: '合併到主工作區' }).click();
    await lastChanges.getByRole('button', { name: '確認合併' }).click();
    await lastChanges.waitFor({ state: 'detached', timeout: STEP_MS });
    await waitUntil(async () => (await readFile(join(env.stack.root, 'src', 'checkout', 'page.ts'), 'utf8').catch(() => '')).includes('page'), STEP_MS, "item 2's change in the main workspace");
    await host.locator('aside.sidebar .topic__phase').getByText('已完成', { exact: true }).waitFor({ timeout: STEP_MS });
    await dismissToasts(host);
    // The plan (pinned while its topic was executing, so it stayed) says so; the English page follows.
    await column(host, 'plan:').getByText('主題完成').waitFor({ timeout: STEP_MS });
    await column(host, 'plan:').getByText('2 / 2 已看過').waitFor({ timeout: STEP_MS });
    await dismissToasts(amy);
    await amy.locator('aside.sidebar .topic__phase').getByText('Complete', { exact: true }).waitFor({ timeout: STEP_MS });
    await stop('topic-complete');

    expect(env.allProblems).toEqual([]);
  }, 600_000);
});
