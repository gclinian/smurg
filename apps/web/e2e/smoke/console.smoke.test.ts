// The host console of v0.5.0 in a real browser (DESIGN §5.7, §5.11 `console.smoke`): the BUILT app served by the
// real relay, a daemon composing what production composes on a git repository whose folder carries Claude Code
// project settings, the scripted stand-in `claude` (packages/daemon/src/testing/fake-claude.mjs: no Claude Code, no
// account, no network), and system Chrome driven headless in fresh contexts. Every step waits for a condition.
//
// What only the real stack proves about the console:
//   - the nine sections of the wire are one page, and a section's address (what an inbox item of the host opens)
//     lands on that section with the focus on its heading;
//   - the trust gate: what the folder's real files do is on screen before anything is confirmed, "Use them" needs the
//     ticks, and the daemon then really uses them (and audits the decision);
//   - the three agent settings travel to the daemon and survive a reload;
//   - an agent session of the new model is in the sessions table, and the allow rules its Claude Code reported are
//     listed as information: seeing them is all it takes for the daemon to count them as seen;
//   - a member's removal names what goes with them; nobody but the host gets the console.
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFakeClaude, type FakeClaude } from '../../../../packages/daemon/src/testing/index.ts';
import { STEP_MS, explainFailures, joinAs, joinAsHost, startSmoke, systemChrome, waitUntil, workspaceOnline, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

/** With SMURG_SMOKE_SHOTS=<folder> the test also writes pictures of what it saw there (for a person to look at). */
const SHOTS = process.env['SMURG_SMOKE_SHOTS'];

/** The folder's own Claude Code settings: a hook that runs a script of the folder, a variable that can redirect the login, a rule that allows a tool. */
const PROJECT_SETTINGS = {
  hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: './scripts/lint.sh --fix' }] }] },
  env: { ANTHROPIC_BASE_URL: 'https://llm.example.test', CI: '1' },
  permissions: { allow: ['Bash(pnpm test *)'] },
};

/** What the stand-in `claude` reports as the host's own allow rules (`list_permission_rules`). */
const HOST_RULES = [
  { behavior: 'allow', source: 'userSettings', rule: 'Bash(npm run *)' },
  { behavior: 'allow', source: 'userSettings', rule: 'Bash(git status)' },
] as const;

describe.skipIf(chrome === null)('the host console in a real browser (built app, real relay, real daemon, the stand-in claude)', () => {
  let env: SmokeEnv;
  let host: Page;
  let claude: FakeClaude;

  beforeAll(async () => {
    claude = await installFakeClaude(await mkdtemp(join(process.env['TMPDIR'] as string, 'console-claude-')), { rules: HOST_RULES });
    env = await startSmoke({
      stack: {
        git: true,
        projectFiles: {
          'README.md': '# Class project\n',
          'src/app.ts': 'export const x = 1;\n',
          '.claude/settings.json': `${JSON.stringify(PROJECT_SETTINGS, null, 2)}\n`,
          'scripts/lint.sh': '#!/bin/sh\nexit 0\n',
        },
        // The agent runtime starts this instead of Claude Code; its hook command only has to exist.
        sessions: { claudePath: claude.path, selfCommand: { file: '/usr/bin/true', args: [] } },
      },
    });
    host = await env.newPage();
    await joinAsHost(host, env);
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  /** A picture of one section (or of what is on screen), when pictures were asked for. */
  async function shot(page: Page, name: string, section?: string): Promise<void> {
    if (SHOTS === undefined || SHOTS === '') return;
    await mkdir(SHOTS, { recursive: true });
    const path = join(SHOTS, `console-${name}.png`);
    if (section === undefined) await page.screenshot({ path });
    else await page.locator(`#console-${section}`).screenshot({ path });
  }

  const consoleUrl = (section?: string): string => `${env.origin}/w/${env.stack.workspaceId}/console${section === undefined ? '' : `/${section}`}`;
  const sectionOf = (page: Page, heading: string | RegExp) => page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: heading }) });

  /** Opens the console at a section by its address, as an inbox item of the host does. */
  async function openConsoleAt(section?: string): Promise<void> {
    await host.goto(consoleUrl(section));
    await workspaceOnline(host);
    await host.getByRole('heading', { level: 1, name: 'Host console' }).waitFor({ timeout: STEP_MS });
  }

  it('one page with the nine sections of the wire; a section\'s address opens that section with the focus on its heading', async () => {
    await host.getByRole('link', { name: 'Host console' }).click();
    await host.waitForURL(consoleUrl(), { timeout: STEP_MS });
    await host.getByRole('heading', { level: 2, name: /^Members \(1\)$/ }).waitFor({ timeout: STEP_MS });
    const headings = await host.getByRole('heading', { level: 2 }).allTextContents();
    expect(headings.map((text) => text.replace(/ \(\d+\)$/, ''))).toEqual([
      'Members',
      'All sessions',
      'Pending suggestions',
      'Merge requests',
      'Invite links',
      'Claude Code project settings',
      'My own Claude Code rules',
      'Settings',
      'Audit log',
    ]);
    // Whose Claude account a group may use (OWNER-DECISIONS Q6) is among the notes the host always sees.
    await host.getByText(/A personal Pro or Max subscription is for your own use/).waitFor({ timeout: STEP_MS });
    await shot(host, 'top');

    for (const [section, heading] of [
      ['host-rules', 'My own Claude Code rules'],
      ['claude-config', 'Claude Code project settings'],
      ['sessions', /^All sessions/],
    ] as const) {
      await openConsoleAt(section);
      await host.waitForFunction((id) => document.activeElement?.id === `console-${id}-title`, section, { timeout: STEP_MS });
      expect(await host.evaluate(() => document.activeElement?.textContent ?? '')).toMatch(heading);
      // The section is on screen, not somewhere below the fold.
      const box = await host.locator(`#console-${section}`).boundingBox();
      expect(box).not.toBeNull();
      expect(box?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(900);
    }
  }, 240_000);

  it("the trust gate: the folder's Claude Code settings show everything they do, \"Use them\" needs the ticks, and the daemon then uses them", async () => {
    const trust = env.stack.daemon.ctx.services.projectTrust;
    expect(trust.state({ kind: 'main' })).toBe('ignored');

    await openConsoleAt('claude-config');
    const section = sectionOf(host, 'Claude Code project settings');
    // What the real file does, read by the daemon: the hook's command whole, the rule, the variables.
    await section.getByText('hook PostToolUse: ./scripts/lint.sh --fix').waitFor({ timeout: STEP_MS });
    await section.getByText('allow: Bash(pnpm test *)').waitFor({ timeout: STEP_MS });
    const flagged = section.locator('li').filter({ hasText: 'ANTHROPIC_BASE_URL' });
    await flagged.getByText('can send your login to another server').waitFor({ timeout: STEP_MS });
    expect(await section.locator('li').filter({ hasText: /^CI$/ }).count()).toBe(1);
    // The script the hook calls is part of what is confirmed.
    await section.getByText('scripts/lint.sh', { exact: true }).waitFor({ timeout: STEP_MS });
    await section.getByText('You have not decided about this content yet. Agent sessions in this folder run without these settings.').waitFor({ timeout: STEP_MS });
    await section.getByText(/^The commands below run as you, on your computer, whenever an agent works in this folder\./).waitFor({ timeout: STEP_MS });
    // The raw file is one click away.
    await section.getByText('Show .claude/settings.json').click();
    expect(await section.locator('details[open] pre').textContent()).toContain('"ANTHROPIC_BASE_URL": "https://llm.example.test"');

    // Nothing is trusted before the host ticked what the content needs.
    const use = section.getByRole('button', { name: 'Use them' });
    expect(await use.isDisabled()).toBe(true);
    await section.getByLabel('These settings can send my Claude login to another server (a marked variable, or a command that supplies the API key).').check();
    expect(await use.isDisabled()).toBe(true);
    await section.getByLabel('These settings let agents run commands, edit files or call MCP tools without asking.').check();
    expect(await use.isDisabled()).toBe(false);
    expect(trust.state({ kind: 'main' })).toBe('ignored');
    await shot(host, 'claude-config-undecided', 'claude-config');

    await use.click();
    await section.getByText('Agent sessions in this folder use these settings.').waitFor({ timeout: STEP_MS });
    await section.getByText('In use', { exact: true }).waitFor({ timeout: STEP_MS });
    expect(trust.state({ kind: 'main' })).toBe('used');
    await shot(host, 'claude-config-used', 'claude-config');
    // While the content is in use the script it calls is the host's alone to change through smurg.
    expect(trust.protectedPaths({ kind: 'main' }).has('scripts/lint.sh')).toBe(true);
    await waitUntil(async () => (await env.stack.audit(50)).some((entry) => entry.action === 'claude-config.decide' && entry.outcome === 'ok'), STEP_MS, 'the decision in the audit log');

    // The decision holds across a reload, and the host can take it back without a tick.
    await openConsoleAt('claude-config');
    await sectionOf(host, 'Claude Code project settings').getByText('Agent sessions in this folder use these settings.').waitFor({ timeout: STEP_MS });
    await sectionOf(host, 'Claude Code project settings').getByRole('button', { name: 'Run without them' }).click();
    await sectionOf(host, 'Claude Code project settings').getByText("Agent sessions in this folder run without these settings and without the project's CLAUDE.md.").waitFor({ timeout: STEP_MS });
    expect(trust.state({ kind: 'main' })).toBe('ignored');
    // The audit section of the same page names the action in words.
    await sectionOf(host, 'Audit log').getByText('Decided on Claude Code project settings').first().waitFor({ timeout: STEP_MS });
  }, 240_000);

  it('the agent settings travel to the daemon and survive a reload: work items at once, the waiting time, the MCP switch', async () => {
    await openConsoleAt('settings');
    const settings = sectionOf(host, 'Settings');
    const live = settings.getByLabel('Work items running at the same time');
    await live.waitFor({ timeout: STEP_MS });
    const mcp = settings.getByRole('checkbox', { name: "Agents may use my own and this project's MCP servers" });
    expect(await mcp.isChecked()).toBe(false);
    await live.fill('3');
    await settings.getByLabel('Waiting time before others are asked (minutes)').fill('2');
    await mcp.check();
    await shot(host, 'settings', 'settings');
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await host.getByText('Settings saved and applied.').waitFor({ timeout: STEP_MS });
    expect(env.stack.daemon.ctx.settings.get()).toMatchObject({ maxLiveAgents: 3, escalateAfterMs: 120_000, agentMcp: true });

    await openConsoleAt('settings');
    const again = sectionOf(host, 'Settings');
    await host.waitForFunction(() => (document.querySelector('#console-settings input[inputmode="numeric"]') as HTMLInputElement | null)?.value === '3', undefined, { timeout: STEP_MS });
    expect(await again.getByLabel('Waiting time before others are asked (minutes)').inputValue()).toBe('2');
    expect(await again.getByRole('checkbox', { name: "Agents may use my own and this project's MCP servers" }).isChecked()).toBe(true);
    // Out of range is refused in the form: nothing reaches the daemon.
    await again.getByLabel('Work items running at the same time').fill('99');
    await again.getByText('Enter a whole number from 2 to 32.').waitFor({ timeout: STEP_MS });
    expect(await again.getByRole('button', { name: 'Save settings' }).isDisabled()).toBe(true);
    expect(env.stack.daemon.ctx.settings.get().maxLiveAgents).toBe(3);
  }, 240_000);

  it('an agent session is in the sessions table with its kind, status and responsible person; the rules its Claude Code reported are listed, and seeing them counts', async () => {
    const hostRules = env.stack.daemon.ctx.services.hostRules;
    // The host opens a session without a topic (over the wire, as the "New session" dialog does): the stand-in claude
    // starts and reports the host's own allow rules.
    const { session } = await env.stack.hostClient.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, title: 'try the parser' });
    expect(session.kind).toBe('agent');
    await waitUntil(() => hostRules.view().rules.length === HOST_RULES.length, STEP_MS, 'the rules the stand-in claude reported');
    expect(hostRules.view().seen).toBe(false);

    await openConsoleAt('sessions');
    const row = sectionOf(host, /^All sessions/).locator('tr').filter({ hasText: 'try the parser' });
    await row.waitFor({ timeout: STEP_MS });
    const cells = await row.locator('td').allTextContents();
    // Name | Topic | Kind | Status | Responsible | Opened by | Location | action
    expect(cells[1]).toBe('No topic');
    expect(cells[2]).toBe('Agent session');
    expect(['Starting', 'Running', 'Idle']).toContain(cells[3]);
    expect(cells[4]).toBe('Nobody');
    expect(cells[6]).toBe('Main workspace');
    await sectionOf(host, /^All sessions/).getByText('Your Claude account: no problem reported.').waitFor({ timeout: STEP_MS });
    await shot(host, 'sessions', 'sessions');
    // The page was opened at its sessions section: the rules further down were not asked for, so not "seen" yet
    // unless they happen to be on screen; asking for them by their address is.
    await openConsoleAt('host-rules');
    const rules = sectionOf(host, 'My own Claude Code rules');
    await rules.getByText('Your own Claude Code settings allow 2 kinds of commands without asking. Agents here run them without asking too.').waitFor({ timeout: STEP_MS });
    const user = rules.getByRole('region', { name: 'Your user settings (~/.claude/settings.json)' });
    expect((await user.getByRole('listitem').allTextContents()).sort()).toEqual(['Bash(git status)', 'Bash(npm run *)']);
    // Information only (OWNER-DECISIONS Q7): nothing to decide, nothing to press.
    expect(await rules.getByRole('button').count()).toBe(0);
    await shot(host, 'host-rules', 'host-rules');
    await waitUntil(() => hostRules.view().seen, STEP_MS, 'the daemon to count the rules as seen');

    // One click ends the session without a topic (SPEC R11), and the row goes behind "ended".
    await openConsoleAt('sessions');
    await host.getByRole('button', { name: 'Terminate "try the parser", opened by Host' }).click();
    await host.getByText('Terminated "try the parser", opened by Host.').waitFor({ timeout: STEP_MS });
    await waitUntil(() => env.stack.daemon.ctx.services.sessions.get(session.id)?.status === 'ended', STEP_MS, 'the agent session to end');
  }, 240_000);

  it('removing a member names what goes with them before the host confirms; nobody but the host gets the console', async () => {
    const mei = await env.newPage();
    await joinAs(mei, env, 'mei', 'agent');
    // A member with agent access has no console: the link is not there, and the address explains itself.
    expect(await mei.getByRole('link', { name: 'Host console' }).count()).toBe(0);
    await mei.goto(consoleUrl('claude-config'));
    await mei.getByText('Only the host can use the console').first().waitFor({ timeout: STEP_MS });
    expect(await mei.getByRole('heading', { level: 2 }).count()).toBe(0);

    await openConsoleAt('members');
    await host.getByRole('button', { name: /^Remove mei$/i }).click();
    const dialog = host.getByRole('alertdialog', { name: /Remove mei\?/i });
    await dialog.waitFor({ timeout: STEP_MS });
    const text = (await dialog.textContent()) ?? '';
    expect(text).toMatch(/Every terminal and every session without a topic that mei opened ends at once \(0 sessions right now\)\./i);
    expect(text).toMatch(/The topic sessions mei started \(discussions and work items\) are stopped and pass to you/i);
    expect(text).toMatch(/What mei put in place is removed: the kinds of commands they always allowed/i);
    expect(text).toMatch(/The keys of all devices of mei are revoked\./i);
    await shot(host, 'kick-dialog');
    await dialog.getByRole('button', { name: /^Remove mei$/i }).click();
    const ended = mei.getByTestId('connection-ended-screen');
    await ended.waitFor({ timeout: STEP_MS });
    expect(await ended.textContent()).toContain('You were removed from the workspace');

    // The invite form says what a new member gets to read, before a link exists.
    await sectionOf(host, 'Invite links').getByText('A new member can read every earlier conversation of this workspace, the ones of archived topics included.').waitFor({ timeout: STEP_MS });
    // Nothing the pages did was an error of the page (a refused admin request is an answer on the channel).
    expect(env.problemsOf(host).pageErrors).toEqual([]);
    expect(env.problemsOf(mei).pageErrors).toEqual([]);
  }, 240_000);
});
