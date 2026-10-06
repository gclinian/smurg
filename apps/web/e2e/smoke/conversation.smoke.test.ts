// A conversation with an agent in real browsers (DESIGN §5.11 `conversation.smoke`): the BUILT app served by the real
// relay, a daemon composing the release's modules, the scripted stand-in `claude`
// (packages/daemon/src/testing/fake-claude.mjs: no Claude Code, no account, no network) and system Chrome driven
// headless in fresh contexts, one per member: the host (English), a member with agent access (Traditional Chinese),
// an Editor and a viewer. Every step waits for a condition.
//
// What only the real stack proves about the conversation column:
//   - a session without a topic opens from "New" and its first message reaches the agent; the agent's text, its tool
//     line and its permission request show for everyone, and only those who may answer have the buttons;
//   - a question's votes are live in every browser, the decider submits, the card settles everywhere and the agent
//     goes on with the answer;
//   - an Editor's message is a suggestion: a card for everyone, accepted by a member with agent access (on a page in
//     Traditional Chinese), and only then a message to the agent (this replaces the R6 parts of the old smokes);
//   - Stop ends the agent's turn and the conversation says who stopped it; a viewer has no box to write in.
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversationModule } from '../../../../packages/daemon/src/conversation/module.ts';
import { docsModule } from '../../../../packages/daemon/src/docs/module.ts';
import { filesModule } from '../../../../packages/daemon/src/files/module.ts';
import { hooksModule } from '../../../../packages/daemon/src/hooks/module.ts';
import { inboxModule } from '../../../../packages/daemon/src/inbox/module.ts';
import { localControlModule } from '../../../../packages/daemon/src/local/module.ts';
import { locksModule } from '../../../../packages/daemon/src/locks/module.ts';
import { sessionsModule } from '../../../../packages/daemon/src/sessions/module.ts';
import { suggestModule } from '../../../../packages/daemon/src/suggest/module.ts';
import { installFakeClaude, type FakeClaude, type FakeClaudeScenario } from '../../../../packages/daemon/src/testing/index.ts';
import { topicsModule } from '../../../../packages/daemon/src/topics/module.ts';
import { worktreeModule } from '../../../../packages/daemon/src/worktree/module.ts';
import { STEP_MS, cjkTexts, explainFailures, joinAs, joinAsHost, startSmoke, systemChrome, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

const FIRST = 'Add a test for the empty cart';

/** The "model": a turn is chosen by a pattern on the message a person sent. */
const SCENARIO: FakeClaudeScenario = {
  turns: [
    {
      match: 'empty cart',
      once: true,
      steps: [
        { text: "I'll look at the cart first.", deltas: ["I'll look ", 'at the cart ', 'first.'], deltaMs: 40 },
        { tool: 'Read', input: { file_path: 'src/cart.ts' }, ask: false, result: 'export const cart = [];' },
        { tool: 'Bash', input: { command: 'pnpm test cart' }, ask: true, suggest: { toolName: 'Bash', ruleContent: 'pnpm test *' }, result: '3 passed' },
        {
          tool: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Where is the cart kept?',
                header: 'Cart',
                multiSelect: false,
                options: [
                  { label: 'On the server', description: 'Survives a reload.' },
                  { label: 'In the browser', description: 'Simpler.' },
                ],
              },
            ],
          },
        },
        { text: 'The cart stays where you decided. The test is written.' },
      ],
    },
    { match: 'session store', steps: [{ text: 'Noted: the session store.' }] },
    { match: 'wait here', steps: [{ text: 'Working on it.' }, { wait: 'interrupt' }] },
    { steps: [{ text: 'Noted.' }] },
  ],
};

describe.skipIf(chrome === null)('a conversation with an agent in real browsers (built app, real relay, real daemon, the stand-in claude)', () => {
  let env: SmokeEnv;
  let claude: FakeClaude;
  let host: Page;
  let mei: Page;
  let amy: Page;

  beforeAll(async () => {
    claude = await installFakeClaude(await mkdtemp(join(process.env['TMPDIR'] as string, 'conversation-claude-')), SCENARIO);
    env = await startSmoke({
      stack: {
        git: true,
        projectFiles: { 'README.md': '# Bookshop\n', 'src/cart.ts': 'export const cart = [];\n' },
        // The release's module list (DESIGN §9.3 P12), composed here until the daemon's default list has it.
        modules: [locksModule, hooksModule, filesModule, docsModule, worktreeModule, sessionsModule, conversationModule, suggestModule, topicsModule, inboxModule, localControlModule],
        sessions: { claudePath: claude.path, selfCommand: { file: '/usr/bin/true', args: [] } },
      },
    });
    host = await env.newPage({ width: 1440, height: 900 });
    await joinAsHost(host, env);
    mei = await env.newPage({ width: 1280, height: 900, locale: 'zh-TW' });
    await joinAs(mei, env, 'mei', 'agent');
    amy = await env.newPage({ width: 1280, height: 900 });
    await joinAs(amy, env, 'amy', 'editor');
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  /** The session's column on a page, whatever language its name is in (the title is the first message). */
  const column = (page: Page): Locator => page.getByRole('region', { name: new RegExp(FIRST) });
  const log = (page: Page): Locator => column(page).getByRole('log');
  /** Opens the session from the list on the left. */
  const openFromList = async (page: Page): Promise<void> => {
    await page.getByRole('treeitem', { name: new RegExp(FIRST) }).first().click();
    await log(page).waitFor({ timeout: STEP_MS });
  };

  it('a session without a topic: the first message reaches the agent; its text, tool line and permission request show for everyone, and those who may answer do', async () => {
    await host.getByRole('button', { name: 'New', exact: true }).click();
    await host.getByRole('menuitem', { name: 'New session' }).click();
    const dialog = host.getByRole('dialog', { name: 'New session' });
    await dialog.getByLabel('What should Claude do first? (optional)').fill(FIRST);
    await dialog.getByRole('button', { name: 'Open' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });

    // The column opened by itself; the host's own message, then the agent.
    await log(host).getByText(FIRST).first().waitFor({ timeout: STEP_MS });
    await log(host).getByText("I'll look at the cart first.").waitFor({ timeout: STEP_MS });
    const read = log(host).locator('details.conv-tool', { hasText: 'src/cart.ts' });
    await read.waitFor({ timeout: STEP_MS });
    expect(await read.locator('summary').textContent()).toContain('Read');

    // The permission request: the command whole, the buttons for the host.
    const request = column(host).getByRole('region', { name: 'Claude asks for permission to run a command' });
    await request.waitFor({ timeout: STEP_MS });
    expect(await request.locator('.conv-perm__cmd').textContent()).toBe('pnpm test cart');
    await request.getByRole('button', { name: 'Allow once' }).waitFor({ timeout: STEP_MS });
    await column(host).getByRole('status').filter({ hasText: 'Claude is waiting for permission' }).waitFor({ timeout: STEP_MS });
    // "Always allow this kind" names the kind in words.
    await request.getByText(/commands that start with pnpm test/).waitFor({ timeout: STEP_MS });

    // An Editor reads the same card and who can answer; there is nothing to press.
    await openFromList(amy);
    const amyRequest = column(amy).getByRole('region', { name: 'Claude asks for permission to run a command' });
    await amyRequest.getByText(/Your role cannot allow this\./).waitFor({ timeout: STEP_MS });
    expect(await amyRequest.getByRole('button').count()).toBe(0);

    // A member with agent access answers, on a page in Traditional Chinese: the card settles in every browser.
    await openFromList(mei);
    const meiRequest = column(mei).getByRole('region', { name: 'Claude 請求許可執行指令' });
    await meiRequest.getByRole('button', { name: '允許一次' }).click();
    await column(host).getByText(/Allowed once by mei/i).waitFor({ timeout: STEP_MS });
    await column(amy).getByText(/Allowed once by mei/i).waitFor({ timeout: STEP_MS });
    const ran = log(host).locator('details.conv-tool', { hasText: 'pnpm test cart' });
    await ran.waitFor({ timeout: STEP_MS });
    await expect.poll(async () => ran.locator('summary').textContent(), { timeout: STEP_MS }).toContain('Ran');
  }, 240_000);

  it('a question: every vote shows in every browser as it is cast, the decider submits, and the agent goes on', async () => {
    const question = (page: Page, name: string): Locator => column(page).getByRole('region', { name });
    const hostCard = question(host, 'Question from Claude');
    await hostCard.getByText('Where is the cart kept?').waitFor({ timeout: STEP_MS });
    // The host opened the session and nobody is assigned: the host decides.
    await hostCard.getByText(/You decide: nobody is assigned to this session, and you opened it\./).waitFor({ timeout: STEP_MS });

    await question(amy, 'Question from Claude').getByRole('radio', { name: /In the browser/ }).click();
    await hostCard.getByText(/1 of 3 voted/).waitFor({ timeout: STEP_MS });
    await question(mei, 'Claude 的選擇題').getByRole('radio', { name: /On the server/ }).click();
    await hostCard.getByText(/2 of 3 voted/).waitFor({ timeout: STEP_MS });
    // One vote each: nothing leads, the decider is told.
    await hostCard.getByText('The vote is tied. Choose the answer yourself.').waitFor({ timeout: STEP_MS });
    // Mei, who voted, sees Amy's vote too, in her language.
    await question(mei, 'Claude 的選擇題').getByText(/3 人中 2 人已投票/).waitFor({ timeout: STEP_MS });

    // The decider's click sets the vote and the answer.
    await hostCard.getByRole('radio', { name: /On the server/ }).click();
    await hostCard.getByText(/All 3 voted/).waitFor({ timeout: STEP_MS });
    await hostCard.getByText(/Answer to submit/).waitFor({ timeout: STEP_MS });
    await hostCard.getByRole('button', { name: 'Submit answer' }).click();

    for (const page of [host, amy]) await column(page).getByText('Answered: On the server').waitFor({ timeout: STEP_MS });
    await column(mei).getByText('已回答：On the server').waitFor({ timeout: STEP_MS });
    await log(host).getByText('The cart stays where you decided. The test is written.').waitFor({ timeout: STEP_MS });
    await column(host).getByRole('status').filter({ hasText: 'Claude is idle.' }).waitFor({ timeout: STEP_MS });
  }, 240_000);

  it("an Editor's message is a suggestion: a card for everyone, accepted by a member with agent access, and only then a message to the agent", async () => {
    const box = amy.getByRole('combobox', { name: new RegExp(`^Suggest to Claude · ${FIRST}`) });
    await column(amy).getByText(/Goes to .* as a suggestion\. It reaches the agent only when accepted\./).waitFor({ timeout: STEP_MS });
    await box.fill('Use the session store for the cart');
    await box.press('Enter');
    await column(amy).getByText('Suggestion sent.').waitFor({ timeout: STEP_MS });

    // Her own card: she may edit or withdraw it, not accept it.
    const own = column(amy).getByRole('region', { name: /Suggestion from amy/i });
    await own.getByText('Use the session store for the cart').waitFor({ timeout: STEP_MS });
    await own.getByRole('button', { name: 'Withdraw' }).waitFor({ timeout: STEP_MS });
    expect(await own.getByRole('button', { name: 'Accept', exact: true }).count()).toBe(0);
    // Nothing reached the agent yet.
    expect(await log(host).getByText('Noted: the session store.').count()).toBe(0);

    // Mei accepts it on her page (Traditional Chinese): the page shows no untranslated card label.
    const card = column(mei).getByRole('region', { name: /amy 的建議/i });
    await card.getByText('Use the session store for the cart').waitFor({ timeout: STEP_MS });
    await card.getByRole('button', { name: '採用', exact: true }).click();

    // Now it is Amy's message to the agent, marked as a suggestion and by whom it was accepted; the agent answers.
    const message = log(host).locator('.conv-msg', { hasText: 'Use the session store for the cart' });
    await message.waitFor({ timeout: STEP_MS });
    expect(await message.textContent()).toMatch(/suggestion, accepted by mei/i);
    await log(host).getByText('Noted: the session store.').waitFor({ timeout: STEP_MS });
    await log(amy).getByText('Noted: the session store.').waitFor({ timeout: STEP_MS });
    await column(mei).getByText(/mei 已採用/i).waitFor({ timeout: STEP_MS });
  }, 240_000);

  it('Stop ends the turn and the conversation says who stopped it; a viewer watches without a box; the English page shows no Chinese', async () => {
    const box = host.getByRole('combobox', { name: new RegExp(`^Message Claude · ${FIRST}`) });
    await box.fill('Please wait here');
    await box.press('Enter');
    await log(host).getByText('Working on it.').waitFor({ timeout: STEP_MS });
    await column(host).getByRole('button', { name: 'Stop' }).click();
    await log(host).getByText(/stopped the agent\./).first().waitFor({ timeout: STEP_MS });
    await column(host).getByRole('status').filter({ hasText: 'Claude is idle.' }).waitFor({ timeout: STEP_MS });

    const leo = await env.newPage({ width: 1100, height: 800 });
    await joinAs(leo, env, 'leo', 'viewer');
    await openFromList(leo);
    await column(leo).getByText('As a viewer you can watch this session. You cannot send messages, make suggestions or vote.').waitFor({ timeout: STEP_MS });
    expect(await column(leo).getByRole('combobox').count()).toBe(0);
    // The whole conversation is there for someone who joined late.
    await log(leo).getByText("I'll look at the cart first.").waitFor({ timeout: STEP_MS });
    await column(leo).getByText('Answered: On the server').waitFor({ timeout: STEP_MS });

    expect(await cjkTexts(host)).toEqual([]);
    for (const page of [host, mei, amy, leo]) expect(env.problemsOf(page).pageErrors).toEqual([]);
  }, 240_000);
});
