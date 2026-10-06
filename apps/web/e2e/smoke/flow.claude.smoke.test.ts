// One short pass of the flow with REAL Claude Code in the browser (DESIGN §9.5 item 3, §5.11): the BUILT app served by
// the real relay, a daemon on the release composition, and the real `claude` binary in structured mode instead of the
// scripted stand-in: a session without a topic, its first message, a tool, a permission request answered by a member
// with agent access, a question answered by the host, the agent's last words.
//
// NEVER anyone's account: the binary talks only to the repository's fake Anthropic API on 127.0.0.1
// (packages/daemon/test/hooks/mock-anthropic.ts) with a dummy key, in an environment built from nothing (a temporary
// HOME, CLAUDE_CONFIG_DIR and TMPDIR): exactly the harness of the daemon's own real-Claude suites
// (packages/daemon/test/hooks/claude-harness.ts). Nothing is billed and nothing leaves the machine.
//
// Opt-in: it runs only when SMURG_TEST_CLAUDE_BIN names a verified Claude Code (2.1.288 or newer, an absolute path).
// Without the variable it is SKIPPED, loudly: CI and the Linux VM have no `claude`, and no run may ever pick up the
// `claude` (and the login) a developer happens to have on PATH.
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_MODULES } from '../../../../packages/daemon/src/index.ts';
import { createSessionsModule } from '../../../../packages/daemon/src/sessions/module.ts';
import { MOCK_API_KEY, findClaude, isolatedEnv, seedClaudeTrust } from '../../../../packages/daemon/test/hooks/claude-harness.ts';
import { startMockAnthropic, type MockAnthropic, type MockStep } from '../../../../packages/daemon/test/hooks/mock-anthropic.ts';
import { STEP_MS, explainFailures, joinAs, joinAsHost, startSmoke, systemChrome, waitUntil, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

const configured = process.env['SMURG_TEST_CLAUDE_BIN'] ?? '';
// Only the binary the variable names: a `claude` on PATH is somebody's own, and is not looked for.
const found = configured === '' ? { binary: null, reason: 'SMURG_TEST_CLAUDE_BIN is not set (it must name a verified Claude Code, 2.1.288 or newer)' } : await findClaude();
const claude = found.binary;
if (claude === null) console.warn(`[flow.claude.smoke] SKIPPED: ${found.reason}. The flow with the stand-in claude is flow.smoke.test.ts.`);
else console.info(`[flow.claude.smoke] running against Claude Code ${claude.version} (${claude.path}) and the fake Anthropic API`);

const SHOTS = process.env['SMURG_SMOKE_SHOTS'] ?? '';
/** The `smurg` command as sessions run it in development: the real binary calls the real `smurg hook` and `smurg mcp`. */
const CLI_MAIN = fileURLToPath(new URL('../../../../packages/cli/src/main.ts', import.meta.url));

const FIRST = 'Add a test for the empty cart';
const COMMAND = 'touch cart.test.ts';
const LAST = 'The cart stays where you decided. The test file is there.';
const QUESTION = {
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
};

describe.skipIf(chrome === null || claude === null)(`one pass of the flow with the real claude (${claude ? `Claude Code ${claude.version}` : 'no claude'}, fake Anthropic API) in real browsers`, () => {
  let env: SmokeEnv;
  let mock: MockAnthropic;
  let host: Page;
  let mei: Page;
  let step = 0;

  beforeAll(async () => {
    if (SHOTS !== '') await mkdir(SHOTS, { recursive: true });
    const binary = claude as NonNullable<typeof claude>;
    // The agent's whole environment: built from nothing, under one scratch folder of this run.
    const base = await mkdtemp(join(process.env['TMPDIR'] as string, 'flow-claude-'));
    for (const sub of ['home', 'cfg', 'tmp']) await mkdir(join(base, sub), { recursive: true, mode: 0o700 });
    const selfCommand = { file: process.execPath, args: [CLI_MAIN] };
    // The fake API's address is known after the stack (its script names files of the project): read at each start.
    let mockUrl = 'http://127.0.0.1:9';
    const sessions = createSessionsModule({ hostEnv: () => isolatedEnv(base, mockUrl), launch: { claudePath: binary.path, selfCommand } });
    env = await startSmoke({
      stack: {
        git: true,
        projectFiles: { 'README.md': '# Bookshop\n', 'src/cart.ts': 'export const cart = [];\n' },
        // The release composition, with the sessions module given the isolated environment and the binary under test.
        modules: DEFAULT_FEATURE_MODULES.map((module) => (module.name === 'sessions' ? sessions : module)),
        sessions: { claudePath: binary.path, selfCommand },
      },
    });
    const root = env.stack.root;
    const tool = (name: string, input: Record<string, unknown>): MockStep => ({ tools: [{ name, input }] });
    // What the "model" answers, turn by turn: a read, a command, a question, its last words.
    mock = await startMockAnthropic([tool('Read', { file_path: join(root, 'src/cart.ts') }), tool('Bash', { command: COMMAND, description: 'create the test file' }), tool('AskUserQuestion', QUESTION), { text: LAST }]);
    mockUrl = mock.url;
    // What a host's own Claude Code config already has: the folder trusted, the (dummy) key approved.
    await seedClaudeTrust({ cfgDir: join(base, 'cfg'), cwd: root, apiKey: MOCK_API_KEY });
    host = await env.newPage({ width: 1440, height: 900 });
    await joinAsHost(host, env);
    mei = await env.newPage({ width: 1280, height: 900 });
    await joinAs(mei, env, 'Mei', 'agent');
  }, 300_000);

  afterAll(async () => {
    await env?.stop();
    await mock?.close();
  }, 120_000);

  explainFailures(() => env);

  const column = (page: Page): Locator => page.locator('.app-shell__view:not([hidden]) [data-column-id^="session:"]');
  const log = (page: Page): Locator => column(page).getByRole('log');
  const shot = async (name: string): Promise<void> => {
    step += 1;
    if (SHOTS === '') return;
    for (const [who, page] of [['host', host], ['mei', mei]] as const) await page.screenshot({ path: join(SHOTS, `claude-${String(step).padStart(2, '0')}-${name}--${who}.png`) });
  };

  it('a session without a topic on the real binary: the message, a tool, a permission request, a question and its answer', async () => {
    await host.getByRole('button', { name: 'New', exact: true }).click();
    await host.getByRole('menuitem', { name: 'New session' }).click();
    const dialog = host.getByRole('dialog', { name: 'New session' });
    await dialog.getByLabel('What should Claude do first? (optional)').fill(FIRST);
    await dialog.getByRole('button', { name: 'Open' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });
    await log(host).getByText(FIRST).first().waitFor({ timeout: STEP_MS });
    await mei.getByRole('treeitem', { name: new RegExp(FIRST) }).first().click();

    // A tool the session may use without asking: the read shows as a line, for both.
    for (const page of [host, mei]) {
      const read = log(page).locator('details.conv-tool', { hasText: 'src/cart.ts' });
      await read.waitFor({ timeout: 120_000 });
      expect(await read.locator('summary').textContent()).toContain('Read');
    }

    // A command asks: the card shows it whole; Mei (agent access) allows it once, and it really runs.
    const request = (page: Page): Locator => column(page).locator('.conv-card--permission:not(.ui-card--settled)');
    for (const page of [host, mei]) await expect.poll(() => request(page).locator('.conv-perm__cmd').textContent(), { timeout: 120_000 }).toBe(COMMAND);
    await column(host).getByRole('status').filter({ hasText: 'Claude is waiting for permission' }).waitFor({ timeout: STEP_MS });
    await shot('permission-request');
    await request(mei).getByRole('button', { name: 'Allow once' }).click();
    await column(host).getByText(/Allowed once by Mei/).waitFor({ timeout: STEP_MS });
    await waitUntil(async () => (await readFile(join(env.stack.root, 'cart.test.ts'), 'utf8').then(() => true, () => false)), 120_000, 'the allowed command to have run in the shared folder');

    // The question: Mei votes, the host (who opened the session) decides.
    const question = (page: Page): Locator => column(page).getByRole('region', { name: 'Question from Claude' });
    await question(host).getByText('Where is the cart kept?').waitFor({ timeout: 120_000 });
    await question(mei).getByRole('radio', { name: /On the server/ }).click();
    await question(host).getByText('1 of 2 voted').waitFor({ timeout: STEP_MS });
    await shot('question');
    await question(host).getByRole('radio', { name: /On the server/ }).click();
    await question(host).getByRole('button', { name: 'Submit answer' }).click();
    for (const page of [host, mei]) await column(page).getByText('Answered: On the server').waitFor({ timeout: STEP_MS });

    // The agent goes on with the answer and finishes its turn.
    for (const page of [host, mei]) await log(page).getByText(LAST).waitFor({ timeout: 120_000 });
    await column(host).getByRole('status').filter({ hasText: 'Claude is idle.' }).waitFor({ timeout: STEP_MS });
    await shot('answered');

    // What the model was told about its tool calls: the read, the command that ran, and the answer the people chose.
    const results = mock.toolResults();
    expect(results.map((result) => result.isError)).toEqual([false, false, false]);
    expect(results[0]?.text).toContain('export const cart = [];');
    expect(results[2]?.text).toContain('On the server');
    // Every request of the binary went to the fake API, with the dummy key and nothing else.
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.requests.filter((one) => one.kind === 'messages').every((one) => one.credential)).toBe(true);
    for (const page of [host, mei]) expect(env.problemsOf(page).pageErrors).toEqual([]);
  }, 600_000);
});
