// The sticky notes in a real browser (DESIGN 0.8.0 D7.5, D7.7; BUILD-PLAN S4): the BUILT app served by the real relay,
// a daemon composing the release's modules, the scripted stand-in `claude` (packages/daemon/src/testing/fake-claude.mjs:
// no Claude Code, no account, no network) with the real `smurg` command as its hooks (so smurg's own tool gate, row
// G13, decides what Claude for the sticky notes may write), and system Chrome driven headless, two pages in two
// browser contexts, each with its language named. Every step waits for a condition.
//
// What only the real stack proves about the sticky notes:
//   - the first page: the host writes Home, and an Editor's page has it at once;
//   - Home is one shared document: what the host types in Edit is what the Editor reads, while it is typed;
//   - a link to a sticky note not written yet leads to its page, and "Write this sticky note" writes it there;
//   - "Start Claude" starts Claude for the sticky notes; both pages show its conversation (a message box for the host,
//     a suggestion box for the Editor); "Ask Claude about this sticky note" puts the note's link into the host's box;
//   - a turn of Claude that writes `notes/Ideas.md` and links it from Home (a Write and an Edit, through the gate)
//     shows the new note in both pages, in the list and in Home's text; the note's path in Claude's text opens it in
//     the notes view;
//   - feedback (DESIGN 0.8.0 D7.8, BUILD-PLAN S6): a Viewer's page gives it on a sticky note and has no Accept; it
//     reaches nobody's agent while it waits; the host's page counts it, shows what Claude gets (composeFeedback of the
//     entry, character for character) and accepts it; the stand-in's turn then changes the note, and every page shows
//     the change and the feedback decided;
//   - "Build this" (DESIGN 0.8.0 D5, BUILD-PLAN S7): the host's dialog shows exactly the text the daemon composes as
//     the host reads it; confirming makes the topic and opens its plan in the sessions view, with one work item and
//     Start; Start opens the topic's own Start dialog (cancelled here: nothing starts); SPEC.md is that text on disk;
//     the note names the topic afterwards; the Editor has no "Build this";
//   - nothing the pages did was an error of the page, the Content Security Policy included.
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeFeedback } from '@smurg/protocol';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFakeClaude, type FakeClaudeScenario } from '../../../../packages/daemon/src/testing/index.ts';
import { STEP_MS, explainFailures, joinAs, joinAsHost, startSmoke, systemChrome, toMode, waitUntil, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

/** The `smurg` command as sessions run it in development: the agent's hooks (smurg's tool gate) are real. */
const CLI_MAIN = fileURLToPath(new URL('../../../../packages/cli/src/main.ts', import.meta.url));

/** What the host types into Home: a line, and a link to a sticky note nobody wrote yet. */
const HOME_TYPED = 'Our bookshop, one sticky note at a time.\n\nNext: [[Checkout]]\n';
const IDEAS = '- Gift cards\n- A reading list per member\n';
/** What the Viewer writes about Ideas: a marker the stand-in's turn below is matched by. */
const FEEDBACK = 'Gift cards should come with gift wrapping.';

/**
 * The whole "model": asked for ideas, it writes a new sticky note and links it from Home; given the accepted feedback
 * on Ideas (the host's message that quotes it), it changes Ideas.
 */
const SCENARIO: FakeClaudeScenario = {
  turns: [
    {
      match: 'gift wrapping',
      steps: [
        { tool: 'Read', input: { file_path: 'notes/Ideas.md' } },
        { tool: 'Edit', input: { file_path: 'notes/Ideas.md', old_string: '- Gift cards\n', new_string: '- Gift cards, with gift wrapping\n' } },
        { text: 'I changed notes/Ideas.md: gift cards come with gift wrapping.' },
      ],
    },
    {
      match: 'ideas',
      steps: [
        { tool: 'Read', input: { file_path: 'notes/Home.md' } },
        { tool: 'Write', input: { file_path: 'notes/Ideas.md', content: IDEAS } },
        { tool: 'Edit', input: { file_path: 'notes/Home.md', old_string: 'Next: [[Checkout]]', new_string: 'Next: [[Checkout]]\n- [[Ideas]]' } },
        { text: 'I wrote notes/Ideas.md and linked it from Home.' },
      ],
    },
    { steps: [{ text: 'Noted.' }] },
  ],
};

describe.skipIf(chrome === null)('the sticky notes in a real browser (built app, real relay, real daemon, the stand-in claude)', () => {
  let env: SmokeEnv;
  let host: Page;
  let amy: Page;
  /** A Viewer, from the feedback's test on. */
  let vic: Page | undefined;

  beforeAll(async () => {
    const claude = await installFakeClaude(await mkdtemp(join(process.env['TMPDIR'] as string, 'notes-claude-')), SCENARIO);
    env = await startSmoke({
      stack: {
        projectFiles: { 'README.md': '# Bookshop\n' },
        sessions: { claudePath: claude.path, selfCommand: { file: process.execPath, args: [CLI_MAIN] } },
        // A person's lock on a note goes one second after the last key (the least the host may set): Claude's edit of
        // Home waits for the host's typing to end, not for the default 30 seconds.
        settings: { humanLockIdleMs: 1_000 },
      },
    });
    // Two browser contexts, each with its language named (helpers.ts newPage: `locale` on every newContext).
    host = await env.newPage({ width: 1440, height: 900, locale: 'en-US' });
    await joinAsHost(host, env);
    amy = await env.newPage({ width: 1440, height: 900, locale: 'en-US' });
    await joinAs(amy, env, 'amy', 'editor');
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  const note = (page: Page) => page.getByRole('main', { name: 'Open sticky note' });
  const list = (page: Page) => page.getByRole('complementary', { name: 'All sticky notes' });
  const claudePane = (page: Page) => page.locator('.app-shell__view[data-view="notes"] .app-notes__chat');
  const fileText = (name: string): Promise<string> => readFile(join(env.stack.root, 'notes', `${name}.md`), 'utf8').catch(() => '');

  it('the first page: the host writes Home, and the Editor\'s page has it at once', async () => {
    // Both pages were opened in a language of their own.
    expect(await host.evaluate(() => navigator.language)).toBe('en-US');
    expect(await amy.evaluate(() => navigator.language)).toBe('en-US');
    await toMode(host, 'notes');
    await toMode(amy, 'notes');
    await note(host).getByRole('heading', { level: 2, name: 'Start with one sticky note' }).waitFor({ timeout: STEP_MS });
    await note(amy).getByRole('heading', { level: 2, name: 'Start with one sticky note' }).waitFor({ timeout: STEP_MS });
    await note(host).getByRole('button', { name: 'Write the first sticky note' }).click();
    await note(host).getByRole('heading', { level: 2, name: 'Home' }).waitFor({ timeout: STEP_MS });
    await note(host).getByText('This sticky note is empty.').waitFor({ timeout: STEP_MS });
    await waitUntil(async () => (await readFile(join(env.stack.root, 'notes', 'Home.md'), 'utf8').then(() => true, () => false)), STEP_MS, 'notes/Home.md was written');
    // The Editor was told: the first page became Home.
    await note(amy).getByRole('heading', { level: 2, name: 'Home' }).waitFor({ timeout: STEP_MS });
    await list(amy).getByRole('treeitem', { name: 'Home' }).waitFor({ timeout: STEP_MS });
  }, 240_000);

  it('Home is one shared document: what the host types in Edit, the Editor reads while it is typed', async () => {
    await note(host).getByRole('radio', { name: 'Edit' }).click();
    const editor = note(host).getByRole('group', { name: 'Editor for notes/Home.md' });
    await editor.locator('.monaco-editor').first().waitFor({ timeout: STEP_MS });
    // No "Send to agent" here: Claude for the sticky notes is beside the note.
    expect(await note(host).getByRole('button', { name: /Send to agent/ }).count()).toBe(0);
    await editor.locator('.monaco-editor textarea, .monaco-editor [role="textbox"]').first().focus();
    await host.keyboard.type('Our bookshop, one sticky note at a time.');
    // The Editor reads it before the host is done.
    await note(amy).getByText('Our bookshop, one sticky note at a time.').waitFor({ timeout: STEP_MS });
    // Typed whole: a closing bracket the editor put in by itself is typed over, so the text is the same either way.
    await host.keyboard.type('\n\nNext: [[Checkout]]\n');
    await waitUntil(async () => (await fileText('Home')) === HOME_TYPED, STEP_MS, "the host's text in notes/Home.md");
    // The link to a note not written yet is drawn apart, with words.
    const link = note(amy).getByRole('link', { name: /^Checkout/ });
    await link.waitFor({ timeout: STEP_MS });
    expect(await link.getAttribute('class')).toContain('md-wiki--missing');
    expect(await link.textContent()).toContain('(not written yet)');
    await note(host).getByRole('radio', { name: 'Read' }).click();
    // The Read view (the editor stays, hidden, with the same text).
    await note(host).locator('.sticky-card__body').getByText('Our bookshop, one sticky note at a time.').waitFor({ timeout: STEP_MS });
  }, 240_000);

  it('a link to a sticky note not written yet leads to its page, and "Write this sticky note" writes it there', async () => {
    await note(amy).getByRole('link', { name: /^Checkout/ }).click();
    await amy.waitForURL(`${env.origin}/w/${env.stack.workspaceId}/notes/Checkout`, { timeout: STEP_MS });
    await note(amy).getByText('This sticky note is not written yet.').waitFor({ timeout: STEP_MS });
    await note(amy).getByRole('button', { name: 'Write this sticky note' }).click();
    await note(amy).getByText('This sticky note is empty.').waitFor({ timeout: STEP_MS });
    await waitUntil(async () => (await readFile(join(env.stack.root, 'notes', 'Checkout.md'), 'utf8').then(() => true, () => false)), STEP_MS, 'notes/Checkout.md was written');
    // Both lists grow it under Home, which links to it.
    for (const page of [host, amy]) await list(page).getByRole('tree', { name: 'Sticky notes from Home' }).getByRole('treeitem', { name: 'Checkout' }).waitFor({ timeout: STEP_MS });
    expect(await note(host).getByRole('link', { name: 'Checkout', exact: true }).getAttribute('class')).not.toContain('md-wiki--missing');
  }, 240_000);

  it('"Start Claude": both pages show the conversation of Claude for the sticky notes, a message box for the host, a suggestion box for the Editor', async () => {
    await claudePane(host).getByRole('button', { name: 'Start Claude' }).click();
    await claudePane(host).getByRole('combobox', { name: 'Message Claude · Sticky notes' }).waitFor({ timeout: STEP_MS });
    await claudePane(host).getByText(/started Claude for the sticky notes/).first().waitFor({ timeout: STEP_MS });
    await claudePane(amy).getByRole('combobox', { name: 'Suggest to Claude · Sticky notes' }).waitFor({ timeout: STEP_MS });
    expect(await claudePane(amy).getByRole('button', { name: /^Start Claude/ }).count()).toBe(0);
  }, 240_000);

  it('a turn of Claude writes notes/Ideas.md and links it from Home: both pages show the new note; its path in the conversation opens it in the notes view', async () => {
    await list(amy).getByRole('treeitem', { name: 'Home' }).locator('.sticky-row__name').first().click();
    await note(amy).getByRole('heading', { level: 2, name: 'Home' }).waitFor({ timeout: STEP_MS });
    // Nobody is typing in Home any more: Claude's edit would wait for that person's lock.
    await waitUntil(async () => (await env.stack.hostClient.conn.request('lock.list', {})).locks.length === 0, STEP_MS, 'no lock on any file');
    // "Ask Claude about this sticky note" puts the link into the host's box, which takes the focus.
    await note(host).getByRole('button', { name: 'Ask Claude about this sticky note' }).click();
    const box = claudePane(host).getByRole('combobox', { name: 'Message Claude · Sticky notes' });
    await expect.poll(() => box.inputValue(), { timeout: STEP_MS }).toBe('[[Home]] ');
    expect(await box.evaluate((element) => element === document.activeElement)).toBe(true);
    await host.keyboard.type('Please add a sticky note with ideas for later.');
    await host.keyboard.press('Enter');
    // The message is what was typed: the link shares its line with the question, so nothing of it reads as a header
    // the daemon would quote (agentText puts `> ` before a line that is only `[...]`).
    const sent = claudePane(host).locator('.conv-msg', { hasText: 'Please add a sticky note with ideas for later.' });
    await sent.waitFor({ timeout: STEP_MS });
    expect(await sent.locator('.conv-msg__bubble').innerText()).toBe('[[Home]] Please add a sticky note with ideas for later.');
    expect(await sent.locator('blockquote').count()).toBe(0);

    await waitUntil(async () => (await fileText('Ideas')) === IDEAS, STEP_MS, 'Claude wrote notes/Ideas.md');
    await waitUntil(async () => (await fileText('Home')).includes('- [[Ideas]]'), STEP_MS, 'Claude linked Ideas from Home');
    // The new note in both lists, under Home, and its link in Home's text, in both pages.
    for (const page of [host, amy]) {
      await list(page).getByRole('tree', { name: 'Sticky notes from Home' }).getByRole('treeitem', { name: 'Ideas' }).waitFor({ timeout: STEP_MS });
      const link = note(page).getByRole('link', { name: 'Ideas', exact: true });
      await link.waitFor({ timeout: STEP_MS });
      expect(await link.getAttribute('class')).not.toContain('md-wiki--missing');
    }
    // The note's path in Claude's text: a link that stays in the notes view.
    await claudePane(host).getByText('I wrote').waitFor({ timeout: STEP_MS });
    await claudePane(host).locator('button.md-path', { hasText: 'notes/Ideas.md' }).first().click();
    await host.waitForURL(`${env.origin}/w/${env.stack.workspaceId}/notes/Ideas`, { timeout: STEP_MS });
    await note(host).getByRole('heading', { level: 2, name: 'Ideas' }).waitFor({ timeout: STEP_MS });
    await note(host).getByText('A reading list per member').waitFor({ timeout: STEP_MS });
    expect(await host.locator('.app-shell').getAttribute('data-mode')).toBe('notes');
  }, 240_000);

  it('feedback: a Viewer gives it on a sticky note, the host reads what Claude gets and accepts it, and the stand-in\'s turn changes the note in every page', async () => {
    const viewer = await env.newPage({ width: 1440, height: 900, locale: 'en-US' });
    vic = viewer;
    await joinAs(viewer, env, 'vic', 'viewer');
    await toMode(viewer, 'notes');
    await list(viewer).getByRole('treeitem', { name: 'Ideas' }).locator('.sticky-row__name').first().click();
    await note(viewer).getByRole('heading', { level: 2, name: 'Ideas' }).waitFor({ timeout: STEP_MS });
    const feedbackOf = (page: Page) => note(page).getByRole('region', { name: 'Feedback' });
    // A Viewer gives feedback; nobody's page has a count for them, and they cannot accept.
    await feedbackOf(viewer).getByRole('textbox', { name: 'Give feedback on Ideas' }).fill(FEEDBACK);
    await feedbackOf(viewer).getByRole('button', { name: 'Give feedback' }).click();
    const theirs = feedbackOf(viewer).locator('li.sticky-fb', { hasText: FEEDBACK });
    await theirs.getByRole('button', { name: 'Withdraw' }).waitFor({ timeout: STEP_MS });
    expect(await feedbackOf(viewer).getByRole('button', { name: 'Accept' }).count()).toBe(0);
    expect(await viewer.locator('.app-topbar__mode .ui-count').count()).toBe(0);
    // The host's page counts what waits, on the mode link and on the note's row.
    await host.locator('.app-topbar__mode').getByRole('link', { name: 'Sticky notes: 1 piece of feedback waiting' }).waitFor({ timeout: STEP_MS });
    await list(host).getByRole('treeitem', { name: 'Ideas, 1 piece of feedback waiting' }).waitFor({ timeout: STEP_MS });
    // While it waits, nothing of it reached Claude for the sticky notes (no message of anyone holds it).
    expect(await claudePane(host).locator('.conv-msg', { hasText: FEEDBACK }).count()).toBe(0);
    // What Claude gets: composeFeedback of the entry, character for character.
    await note(host).getByRole('heading', { level: 2, name: 'Ideas' }).waitFor({ timeout: STEP_MS });
    const entry = feedbackOf(host).locator('li.sticky-fb', { hasText: FEEDBACK });
    await entry.locator('summary', { hasText: 'What Claude gets' }).click();
    const listed = (await env.stack.hostClient.conn.request('sticky.feedback.list', {})).feedback.find((one) => one.text === FEEDBACK);
    if (listed === undefined || listed.author.kind !== 'member') throw new Error('the feedback is not listed as a member\'s');
    const expected = composeFeedback({ note: 'Ideas', author: { kind: 'member', userId: listed.author.user.userId, displayName: listed.author.user.displayName, role: 'viewer' }, text: FEEDBACK });
    expect(await entry.locator('.sticky-fb__message').textContent()).toBe(expected);
    await entry.getByRole('button', { name: 'Accept' }).click();
    // The stand-in's turn (matched by the accepted message) changes the note: every page shows it.
    await waitUntil(async () => (await fileText('Ideas')).includes('- Gift cards, with gift wrapping\n'), STEP_MS, 'Claude changed notes/Ideas.md');
    for (const page of [host, viewer]) {
      await note(page).locator('.sticky-card__body').getByText('Gift cards, with gift wrapping').waitFor({ timeout: STEP_MS });
      // Decided: folded under "Show 1 earlier" with who accepted it.
      await feedbackOf(page).getByText('Show 1 earlier').waitFor({ timeout: STEP_MS });
    }
    expect(await viewer.locator('li.sticky-fb', { hasText: FEEDBACK }).getByRole('button').count()).toBe(0);
    await host.locator('.app-topbar__mode').getByRole('link', { name: 'Sticky notes', exact: true }).waitFor({ timeout: STEP_MS });
    // The host's own message to Claude quotes it.
    await claudePane(host).locator('.conv-msg', { hasText: FEEDBACK }).first().waitFor({ timeout: STEP_MS });
  }, 240_000);

  it('"Build this": the host reads the exact text of the spec and confirms; the topic\'s plan opens with Start, whose own dialog comes next; nothing starts, and the note names its topic', async () => {
    // Ideas is open in the host's page, its last change saved and nobody's lock on it.
    await note(host).getByRole('heading', { level: 2, name: 'Ideas' }).waitFor({ timeout: STEP_MS });
    await waitUntil(async () => (await env.stack.hostClient.conn.request('lock.list', {})).locks.length === 0, STEP_MS, 'no lock on any file');
    // An Editor may not start sessions: no "Build this" on their page.
    expect(await note(amy).getByRole('button', { name: 'Build this' }).count()).toBe(0);
    const button = note(host).getByRole('button', { name: 'Build this' });
    await expect.poll(() => button.isEnabled(), { timeout: STEP_MS }).toBe(true);
    await button.click();
    const dialog = host.getByRole('dialog', { name: 'Build this sticky note' });
    const text = dialog.getByRole('region', { name: 'The text of the spec' });
    await text.waitFor({ timeout: STEP_MS });
    // What the dialog shows is what the daemon composes from what the host reads: the note, decoded, word for word.
    const spec = await env.stack.hostClient.conn.request('sticky.spec', { note: 'Ideas' });
    expect(spec.text).toBe(`Built from the sticky note "notes/Ideas.md".\n\n- Gift cards, with gift wrapping\n- A reading list per member\n\nOther sticky notes are not part of this spec.\n`);
    expect(await text.textContent()).toBe(spec.text);
    await dialog
      .getByText(/its discussion session with Claude starts now\. The work does not start yet: the topic's plan opens in the sessions view, and Start there starts it\./)
      .waitFor({ timeout: STEP_MS });
    await dialog.getByRole('button', { name: 'Make the topic' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });
    // The sessions view, with the topic's plan: one work item, named after the note, and Start.
    await expect.poll(() => host.locator('.app-shell').getAttribute('data-mode'), { timeout: STEP_MS }).toBe('sessions');
    const plan = host.getByRole('region', { name: 'Plan' });
    await plan.getByText('1 work item').waitFor({ timeout: STEP_MS });
    await plan.getByRole('list', { name: 'Work items' }).getByRole('listitem').first().getByText('Ideas').first().waitFor({ timeout: STEP_MS });
    expect(await readFile(join(env.stack.root, 'specs', 'ideas', 'SPEC.md'), 'utf8')).toBe(spec.text);
    // Start is the topic's own Start dialog, with its checks: it comes next, and nothing started before it.
    await plan.getByRole('button', { name: /^Start 1 item$/ }).click();
    const start = host.getByRole('dialog', { name: /^Start 1 item$/ });
    await start.getByText(/^1 item starts now: 1 · Ideas\.$/).waitFor({ timeout: STEP_MS });
    await start.getByRole('button', { name: 'Cancel' }).click();
    await start.waitFor({ state: 'detached', timeout: STEP_MS });
    const { sessions } = await env.stack.hostClient.conn.request('session.list', {});
    expect(sessions.filter((session) => session.kind === 'agent' && session.purpose === 'item')).toEqual([]);
    // Back in the notes view, the note names the topic made from it.
    await toMode(host, 'notes');
    const builds = note(host).getByRole('region', { name: 'Topics built from this sticky note' });
    await builds.getByRole('button', { name: 'Ideas' }).waitFor({ timeout: STEP_MS });
    await builds.getByText('specs/ideas').waitFor({ timeout: STEP_MS });
  }, 240_000);

  it('nothing the pages did was an error of the page, the Content Security Policy included', () => {
    for (const page of [host, amy, ...(vic === undefined ? [] : [vic])]) {
      const problems = env.problemsOf(page);
      expect(problems.pageErrors).toEqual([]);
      expect(problems.console).toEqual([]);
    }
    expect(env.allProblems.filter((line) => /Content Security Policy/.test(line))).toEqual([]);
  });
});
