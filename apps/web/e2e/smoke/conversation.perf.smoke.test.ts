// The budget of a long conversation (DESIGN §5.5 "Budget, checked by a test"), measured in system Chrome on the BUILT
// app, through the real relay, from a real daemon and the scripted stand-in `claude`:
//
//   1. a transcript of 5,000 events, 1,000 of them tool cards with bodies, OPENS in under 300 ms of scripting;
//   2. a 60 s stream at 5 deltas per second keeps every frame under 16 ms of scripting;
//   3. 400 messages of the dearest text that stays inside its own budget (lex.ts) are shown at once, as written, and
//      formatted while the page is idle: no task longer than 200 ms after a frame showed them, and the page answers
//      a click meanwhile (review R4-03, fourth round: they were one task of 22 s).
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

/** How many of the dearest texts, and the longest task their formatting may be (Chrome's own figure of a "long task"). */
const HARD = 400;
const LONG_TASK_BUDGET_MS = 200;
/** A click while texts are being formatted is answered within this (a slice is one text of about 70 ms here). */
const CLICK_BUDGET_MS = 500;
const HARD_FIRST = 'Write four hundred hard texts';
/**
 * The dearest text that stays inside its own budget: one paragraph as long as a paragraph may be, a web address and
 * what the lexer takes back from its end one character at a time. ONE step of about 70 ms, and the longest step of a
 * parse is forgiven (a pause of the machine looks the same), so the text is formatted and never remembered as slow.
 */
const hardText = (index: number): string => `Hard text ${index} of ${HARD} http://a.a${')'.repeat(15_900)}`;
/** A turn as an agent's turns are: it reads a file, it says something, and again; every text is a row of its own. */
function hardSteps(): FakeClaudeStep[] {
  const steps: FakeClaudeStep[] = [];
  for (let index = 1; index <= HARD; index++) steps.push({ tool: 'Read', input: { file_path: `src/cart/part-${index}.ts` }, ask: false, result: 'ok' }, { text: hardText(index) });
  return steps;
}

const STREAM = streamDeltas();
const SCENARIO: FakeClaudeScenario = {
  turns: [
    { match: 'long history', once: true, steps: historySteps() },
    { match: 'hard texts', once: true, steps: hardSteps() },
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

  it(`${HARD} messages that each stay inside their own budget are formatted while the page is idle: no task over ${LONG_TASK_BUDGET_MS} ms once they are on screen, and a click is answered meanwhile`, async () => {
    const agents = env.stack.daemon.ctx.services.agents;
    const before = new Set(agents.list().map((one) => one.id));
    await host.getByRole('button', { name: 'New', exact: true }).click();
    await host.getByRole('menuitem', { name: 'New session' }).click();
    const dialog = host.getByRole('dialog', { name: 'New session' });
    await dialog.getByLabel('What should Claude do first? (optional)').fill(HARD_FIRST);
    await dialog.getByRole('button', { name: 'Open' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });
    const session = (): { lastSeq: number; status: string } | undefined => agents.list().find((one) => !before.has(one.id));
    await waitUntil(async () => (session()?.lastSeq ?? 0) >= HARD && session()?.status === 'idle', 180_000, `the turn wrote ${HARD} texts`);

    // A member who was not there opens it. Chrome reports every task longer than 50 ms from here on.
    const reader = await env.newPage({ width: 1440, height: 900 });
    await joinAs(reader, env, 'lin', 'agent');
    const row = reader.getByRole('treeitem', { name: new RegExp(HARD_FIRST) }).first();
    await row.waitFor({ timeout: STEP_MS });
    await reader.evaluate(() => {
      const tasks: [number, number][] = [];
      (window as unknown as { smurgLongTasks: [number, number][] }).smurgLongTasks = tasks;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push([entry.startTime, entry.duration]);
      }).observe({ entryTypes: ['longtask'] });
    });
    await reader.waitForTimeout(500);
    const hardLog = reader.getByRole('region', { name: new RegExp(HARD_FIRST) }).getByRole('log');
    const seen = (): Promise<{ texts: number; rows: number; waiting: number; formatted: number; notes: number; lastWaits: boolean; now: number }> =>
      hardLog.evaluate((node) => {
        const texts = [...node.querySelectorAll('.conv-agent__text .md-body')];
        return {
          texts: texts.length,
          rows: node.querySelectorAll('.conv-row').length,
          waiting: node.querySelectorAll('.md-plain[data-why="later"]').length,
          formatted: node.querySelectorAll('.md-body a.md-link').length,
          notes: node.querySelectorAll('.md-note').length,
          lastWaits: texts.at(-1)?.querySelector('.md-plain[data-why="later"]') != null,
          now: performance.now(),
        };
      });
    /** A frame showed what is mounted now: the page's clock at that moment. */
    const frameShown = (): Promise<number> => reader.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))));
    /** Waits until nothing waits, and says the longest task between `from` and then. */
    const formatted = async (from: number, label: string): Promise<number> => {
      await expect.poll(async () => (await seen()).waiting, { timeout: 240_000, interval: 250 }).toBe(0);
      const until = (await seen()).now;
      const tasks = (await reader.evaluate(() => (window as unknown as { smurgLongTasks: [number, number][] }).smurgLongTasks)).filter(([start]) => start >= from && start <= until);
      const longest = Math.max(0, ...tasks.map(([, duration]) => duration));
      console.info(`[conversation perf] hard texts, ${label}: all formatted ${((until - from) / 1_000).toFixed(1)} s after their frame; ${tasks.length} tasks over 50 ms, the longest ${longest.toFixed(0)} ms`);
      return longest;
    };

    await row.click();
    await hardLog.getByText(`Hard text ${HARD} of ${HARD} `, { exact: false }).waitFor({ timeout: STEP_MS });
    let from = await frameShown();
    const first = await seen();
    console.info(`[conversation perf] hard texts: ${first.texts} texts in ${first.rows} rows on the first frame, ${first.waiting} of them wait to be formatted`);
    // The newest page is on screen, as written; most of it waits (each text costs about a third of the page's share).
    expect(first.texts).toBeGreaterThan(60);
    expect(first.rows).toBeGreaterThan(first.texts);
    expect(first.waiting).toBeGreaterThan(first.texts / 2);
    expect(first.notes).toBe(0);

    // A click while they are being formatted is answered while texts still wait, in the time of a slice or two (the
    // page's own clock: from the moment the browser had the press to the menu being in the document); the text on
    // screen did not wait for the others.
    await reader.evaluate(() => {
      const click = { pressed: 0, answered: 0 };
      (window as unknown as { smurgClick: typeof click }).smurgClick = click;
      window.addEventListener('pointerdown', (event) => (click.pressed = event.timeStamp), { capture: true, once: true });
      new MutationObserver((_, observer) => {
        if (document.querySelector('[data-testid="language-menu-menu"]') === null) return;
        click.answered = performance.now();
        observer.disconnect();
      }).observe(document.body, { childList: true, subtree: true });
    });
    await reader.getByTestId('language-menu').first().click();
    await reader.getByTestId('language-menu-menu').waitFor({ timeout: STEP_MS });
    const during = await seen();
    const click = await reader.evaluate(() => (window as unknown as { smurgClick: { pressed: number; answered: number } }).smurgClick);
    console.info(`[conversation perf] hard texts: a click was answered after ${(click.answered - click.pressed).toFixed(0)} ms, ${during.waiting} texts still waiting`);
    expect(during.waiting).toBeGreaterThan(0);
    expect(click.pressed).toBeGreaterThan(0);
    expect(click.answered - click.pressed).toBeLessThan(CLICK_BUDGET_MS);
    expect(during.lastWaits).toBe(false);
    await reader.keyboard.press('Escape');

    expect(await formatted(from, `the newest ${first.texts}`)).toBeLessThan(LONG_TASK_BUDGET_MS);

    // The earlier pages, until all of them are mounted: each is shown as written and formatted the same way.
    for (let mounted = first.texts; mounted < HARD; ) {
      await hardLog.evaluate((node) => {
        node.scrollTop = 0;
      });
      await expect.poll(async () => (await seen()).texts, { timeout: STEP_MS }).toBeGreaterThan(mounted);
      from = await frameShown();
      mounted = (await seen()).texts;
      expect(await formatted(from, `${mounted} texts mounted`)).toBeLessThan(LONG_TASK_BUDGET_MS);
    }
    const last = await seen();
    console.info(`[conversation perf] hard texts: ${last.texts} texts, ${last.formatted} formatted, ${last.notes} shown as written with a note`);
    expect(last.texts).toBe(HARD);
    // Formatted, not given up on: a text that ran out of time on a slow machine has a note, and those are few.
    expect(last.formatted).toBeGreaterThan(HARD * 0.9);
    expect(env.problemsOf(reader).pageErrors).toEqual([]);
    await reader.context().close();
  }, 900_000);
});
