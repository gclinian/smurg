// The budget of a long conversation (DESIGN §5.5 "Budget, checked by a test"), measured in system Chrome on the BUILT
// app, through the real relay, from a real daemon and the scripted stand-in `claude`:
//
//   1. a transcript of 5,000 events, 1,000 of them tool cards with bodies, OPENS in under 300 ms of scripting;
//   2. a 60 s stream at 5 deltas per second keeps every frame under 16 ms of scripting.
//
// "Scripting" is Chrome's own figure (the DevTools protocol's Performance.getMetrics `ScriptDuration`: the time the
// page spent running JavaScript), read before and after. For the stream it is read about every 200 ms, the pace the
// daemon sends coalesced deltas at: an interval that spent less than 16 ms on scripting holds no frame that spent
// more. The numbers are printed, so a run on another machine can be compared.
//
// The transcript is made the way a real one is: the agent's turn (here: scripted) writes it through the runner, the
// daemon stores it and pages it out (`session.watch`: the newest page; `session.history`: the earlier ones).
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPSession, Locator, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFakeClaude, type FakeClaude, type FakeClaudeScenario, type FakeClaudeStep } from '../../../../packages/daemon/src/testing/index.ts';
import { STEP_MS, explainFailures, joinAs, joinAsHost, startSmoke, systemChrome, waitUntil, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

/** Tool calls of the long turn; with the text blocks around them the turn is EVENTS events long. */
const TOOLS = 1_000;
const EVENTS = 5_000;
const OPEN_BUDGET_MS = 300;
const FRAME_BUDGET_MS = 16;
const STREAM_SECONDS = 60;
const DELTAS_PER_SECOND = 5;

const FIRST = 'Write the long history';
const LAST_LINE = `That was step ${TOOLS} of ${TOOLS}.`;
const OUTPUT = Array.from({ length: 12 }, (_, line) => `test ${line + 1} of 12 passed in src/cart/total.test.ts`).join('\n');

/** One step of the history: two text blocks, a tool call with its result, a third text block (5 events). */
function historySteps(): FakeClaudeStep[] {
  const steps: FakeClaudeStep[] = [];
  for (let index = 1; index <= TOOLS; index++) {
    steps.push(
      { text: `Step ${index}: I look at **src/cart/total.ts** and at what calls it.` },
      { text: `- it adds the prices\n- it rounds once, at the end\n\n\`total(prices)\` stays the one place that does.` },
      index % 2 === 0
        ? { tool: 'Bash', input: { command: `pnpm test cart --step ${index}` }, ask: false, result: OUTPUT }
        : { tool: 'Read', input: { file_path: `src/cart/part-${index}.ts` }, ask: false, result: OUTPUT },
      { text: `That was step ${index} of ${TOOLS}.` },
    );
  }
  return steps;
}

const WORDS = 'the cart total is computed in one place and rounded once at the end so that every page shows the same number '.split(' ');
/** The stream: STREAM_SECONDS × DELTAS_PER_SECOND pieces of a few words, a paragraph break now and then. */
function streamDeltas(): string[] {
  const deltas: string[] = [];
  for (let index = 0; index < STREAM_SECONDS * DELTAS_PER_SECOND; index++) {
    const words = Array.from({ length: 6 }, (_, word) => WORDS[(index * 6 + word) % (WORDS.length - 1)]).join(' ');
    deltas.push(index > 0 && index % 25 === 0 ? `.\n\n${words} ` : `${words} `);
  }
  return deltas;
}

const STREAM = streamDeltas();
const SCENARIO: FakeClaudeScenario = {
  turns: [
    { match: 'long history', once: true, steps: historySteps() },
    { match: 'stream', steps: [{ text: STREAM.join(''), deltas: STREAM, deltaMs: 1_000 / DELTAS_PER_SECOND }] },
    { steps: [{ text: 'Noted.' }] },
  ],
};

async function scriptSeconds(cdp: CDPSession): Promise<number> {
  const { metrics } = (await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] };
  return metrics.find((metric) => metric.name === 'ScriptDuration')?.value ?? 0;
}

describe.skipIf(chrome === null)('the budget of a long conversation (built app, real relay, real daemon, the stand-in claude)', () => {
  let env: SmokeEnv;
  let claude: FakeClaude;
  let host: Page;

  beforeAll(async () => {
    claude = await installFakeClaude(await mkdtemp(join(process.env['TMPDIR'] as string, 'perf-claude-')), SCENARIO);
    env = await startSmoke({
      stack: {
        git: true,
        projectFiles: { 'README.md': '# Bookshop\n' },
        sessions: { claudePath: claude.path, selfCommand: { file: '/usr/bin/true', args: [] } },
      },
    });
    host = await env.newPage({ width: 1440, height: 900 });
    await joinAsHost(host, env);
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  const column = (page: Page): Locator => page.getByRole('region', { name: new RegExp(FIRST) });
  const log = (page: Page): Locator => column(page).getByRole('log');

  it(`a transcript of ${EVENTS} events (${TOOLS} tool cards with bodies) opens in under ${OPEN_BUDGET_MS} ms of scripting`, async () => {
    // The host starts the session whose first turn writes the history.
    await host.getByRole('button', { name: 'New', exact: true }).click();
    await host.getByRole('menuitem', { name: 'New session' }).click();
    const dialog = host.getByRole('dialog', { name: 'New session' });
    await dialog.getByLabel('What should Claude do first? (optional)').fill(FIRST);
    await dialog.getByRole('button', { name: 'Open' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });

    const agents = env.stack.daemon.ctx.services.agents;
    const session = (): { id: string; lastSeq: number; status: string } | undefined => agents.list().find((one) => one.purpose === 'free');
    await waitUntil(async () => (session()?.lastSeq ?? 0) >= EVENTS && session()?.status === 'idle', 180_000, `the turn wrote ${EVENTS} events`);
    console.info(`[conversation perf] the transcript holds ${session()?.lastSeq} events`);

    // A member who was not there opens it: the newest page, folded and mounted.
    const reader = await env.newPage({ width: 1440, height: 900 });
    await joinAs(reader, env, 'mei', 'agent');
    const row = reader.getByRole('treeitem', { name: new RegExp(FIRST) }).first();
    await row.waitFor({ timeout: STEP_MS });
    const cdp = await reader.context().newCDPSession(reader);
    await cdp.send('Performance.enable');
    // Let the page settle after the join, so only the opening is measured.
    await reader.waitForTimeout(500);
    const before = await scriptSeconds(cdp);
    await row.click();
    await log(reader).getByText(LAST_LINE).waitFor({ timeout: STEP_MS });
    await reader.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const openMs = (await scriptSeconds(cdp) - before) * 1_000;

    const mounted = await log(reader).locator('.conv-row').count();
    const toolLines = await log(reader).locator('details.conv-tool').count();
    console.info(`[conversation perf] opening: ${openMs.toFixed(1)} ms of scripting, ${mounted} rows mounted, ${toolLines} tool lines among them`);
    expect(mounted).toBeGreaterThan(100);
    expect(mounted).toBeLessThanOrEqual(400);
    expect(toolLines).toBeGreaterThan(50);
    expect(openMs).toBeLessThan(OPEN_BUDGET_MS);

    // The rest of the transcript is there: scrolling to the top reads earlier pages, and the list stays a window.
    await log(reader).evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect.poll(async () => log(reader).locator('.conv-row').count(), { timeout: STEP_MS }).toBeGreaterThan(mounted);
    expect(env.problemsOf(reader).pageErrors).toEqual([]);
    await reader.context().close();
  }, 420_000);

  it(`a ${STREAM_SECONDS} s stream at ${DELTAS_PER_SECOND} deltas per second keeps every frame under ${FRAME_BUDGET_MS} ms of scripting`, async () => {
    const cdp = await host.context().newCDPSession(host);
    await cdp.send('Performance.enable');
    const box = host.getByRole('combobox', { name: new RegExp(`^Message Claude · ${FIRST}`) });
    await box.fill('Now stream');
    await box.press('Enter');
    const streaming = log(host).locator('.conv-agent--streaming');
    await streaming.waitFor({ timeout: STEP_MS });

    // Read the scripting time about every 200 ms for as long as the block streams.
    const samples: number[] = [];
    let last = await scriptSeconds(cdp);
    const started = Date.now();
    while ((await streaming.count()) > 0) {
      await host.waitForTimeout(200);
      const now = await scriptSeconds(cdp);
      samples.push((now - last) * 1_000);
      last = now;
      if (Date.now() - started > (STREAM_SECONDS + 60) * 1_000) throw new Error('the stream did not end');
    }
    const seconds = (Date.now() - started) / 1_000;
    const sorted = [...samples].sort((a, b) => a - b);
    const worst = sorted.at(-1) ?? 0;
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    console.info(`[conversation perf] stream: ${seconds.toFixed(0)} s, ${samples.length} intervals of ~200 ms; scripting per interval: median ${median.toFixed(2)} ms, worst ${worst.toFixed(2)} ms`);
    // The whole stream was watched, and its text is what was sent.
    expect(seconds).toBeGreaterThan(STREAM_SECONDS * 0.8);
    await log(host).getByText(STREAM.slice(-1)[0]?.trim().split(' ').slice(-4).join(' ') ?? '', { exact: false }).first().waitFor({ timeout: STEP_MS });
    expect(worst).toBeLessThan(FRAME_BUDGET_MS);
    expect(env.problemsOf(host).pageErrors).toEqual([]);
  }, 300_000);
});
