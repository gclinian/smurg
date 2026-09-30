// The interactive case the lock design depends on (claude-hooks.md §8 gotcha 2, verified there on both versions): the
// owner REJECTS the permission prompt of an agent edit. Claude Code then fires no PostToolUse, no
// PostToolUseFailure and no Stop; the next event is the UserPromptSubmit of the owner's next prompt, and that is where
// the daemon releases the lock. Driven through a real PTY (node-pty, as the daemon runs sessions) against the mock
// Anthropic API; the host variant of the session settings keeps the permission prompt (defaultMode 'default').
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAIN_ROOT } from '@smurg/protocol';
import * as pty from 'node-pty';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonEvents } from '../../src/core/interfaces.ts';
import { TEST_HOST_USER } from '../../src/testing/index.ts';
import { findClaude, isolatedEnv, killSpawnedGroup, MOCK_API_KEY, ownProcessGroup, startClaudeDaemon, type ClaudeDaemon } from './claude-harness.ts';
import { registerAgent } from './helpers.ts';
import { startMockAnthropic } from './mock-anthropic.ts';

const found = await findClaude();
const claude = found.binary;
if (claude === null) console.warn(`\n[claude-tui] SKIPPED — ${found.reason}\n`);
else console.log(`[claude-tui] running against Claude Code ${claude.version} (${claude.path})`);
const V = claude === null ? 'no claude' : `Claude Code ${claude.version}`;

// ANSI / OSC / control sequences (the spike's tui.py); the TUI positions text with cursor moves, so screens are
// compared with all whitespace removed (claude-hooks.md gotcha 12).
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMNOPZc]|[\x00-\x08\x0b-\x1f\x7f]/g;
const squash = (text: string): string => text.replace(ANSI, '').replace(/\s+/g, '');

class Screen {
  private raw = '';
  private mark = 0;
  readonly child: pty.IPty;
  exited = false;

  constructor(child: pty.IPty) {
    this.child = child;
    child.onData((data) => {
      this.raw += data;
    });
    child.onExit(() => {
      this.exited = true;
    });
  }

  text(): string {
    return squash(this.raw);
  }

  /** Waits for `pattern` in the (squashed) output after the previous match. */
  async expect(pattern: RegExp, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = this.text();
      const match = pattern.exec(text.slice(this.mark));
      if (match) {
        this.mark += match.index + match[0].length;
        return;
      }
      if (Date.now() > deadline || this.exited) throw new Error(`the TUI never showed ${what}; last screen text: ${text.slice(-600)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async type(text: string, pauseMs = 400): Promise<void> {
    this.child.write(text);
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
}

async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(claude === null)(`interactive session (${V}, real PTY, mock Anthropic API)`, () => {
  let env: ClaudeDaemon;

  beforeAll(async () => {
    env = await startClaudeDaemon({ 'free.txt': 'free text\n' });
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it(`lock released after a rejected permission prompt (next prompt): no Post event and no Stop after "No", the owner's next prompt releases it (${V})`, async () => {
    const free = join(env.root, 'free.txt');
    const session = registerAgent(env.hooks, { userId: TEST_HOST_USER, name: 'Host' }, { sandboxed: false });
    const files = await env.hooks.writeSessionFiles(session.sessionId);
    const guest = await env.guestDir('tui');
    // A configured Claude Code (theme chosen) so the first screen is the prompt; trust + key approval from the writer.
    await writeFile(join(guest, 'cfg', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }));
    await env.hooks.seedGuestClaudeConfig({ cfgDir: join(guest, 'cfg'), cwd: env.root, apiKey: MOCK_API_KEY });
    const mock = await startMockAnthropic([
      { tools: [{ name: 'Read', input: { file_path: free } }] },
      { tools: [{ name: 'Edit', input: { file_path: free, old_string: 'free', new_string: 'EDITED' } }] },
      { text: 'TURN-DONE' },
    ]);
    const pres: DaemonEvents['agent.tool.pre'][] = [];
    const posts: DaemonEvents['agent.tool.post'][] = [];
    const subscriptions = [env.daemon.ctx.bus.on('agent.tool.pre', (e) => pres.push(e)), env.daemon.ctx.bus.on('agent.tool.post', (e) => posts.push(e))];
    const own = await ownProcessGroup();
    const child = pty.spawn(claude?.path ?? '', [...files.claudeArgs], {
      name: 'xterm-256color',
      cols: 140,
      rows: 45,
      cwd: env.root,
      env: isolatedEnv(guest, mock.url, { ...session.env, COLORTERM: 'truecolor' }),
    });
    const screen = new Screen(child);
    try {
      await screen.expect(/shortcuts/, 60_000, 'the prompt ("? for shortcuts")');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await screen.type('please edit free.txt');
      await screen.type('\r');
      await screen.expect(/Doyouwanttomakethisedit/, 60_000, 'the edit permission prompt');
      await until(() => env.fakes.locks.awaitingApproval.has(`${session.sessionId}|main:free.txt`), 10_000, 'PermissionRequest');
      expect(pres.map((e) => `${e.file?.path}:${e.outcome}`)).toEqual(['free.txt:granted']);
      // (The first prompt's own UserPromptSubmit released nothing yet: only what comes after the prompt counts.)
      const releasesBefore = env.fakes.locks.calls.filter((c) => c.op === 'releaseAllForSession').length;
      // The owner rejects the edit (Esc). 2.1.220 then shows "User rejected update to free.txt"; other versions may
      // word it differently, so the wait is only a pacing aid (the assertions below do not depend on it).
      await screen.type('\x1b', 500);
      await screen.expect(/rejected/i, 15_000, 'the rejection').catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(env.fakes.locks.get({ root: MAIN_ROOT, path: 'free.txt' })?.kind).toBe('agent');
      expect(posts).toEqual([]);
      expect(env.fakes.locks.calls.filter((c) => c.op === 'releaseAllForSession').length).toBe(releasesBefore);
      // The owner's next prompt: UserPromptSubmit releases the lock.
      const released = (): boolean => env.fakes.locks.get({ root: MAIN_ROOT, path: 'free.txt' }) === null;
      await screen.type('second prompt');
      await screen.type('\r');
      // Under load a keystroke can land before the input box is back; one more Enter submits the typed prompt.
      await until(released, 20_000, 'the lock to be released by the next prompt').catch(async () => {
        await screen.type('\r');
        await until(released, 20_000, 'the lock to be released by the next prompt');
      });
      expect(env.fakes.locks.calls.filter((c) => c.op === 'releaseAllForSession').slice(releasesBefore)[0]).toEqual({ op: 'releaseAllForSession', sessionId: session.sessionId, reason: 'prompt' });
      expect(await readFile(free, 'utf8')).toBe('free text\n');
      await screen.expect(/TURN-DONE/, 30_000, 'the answer to the second prompt');
      await screen.type('/exit');
      await screen.type('\r');
      await until(() => screen.exited, 20_000, 'claude to exit').catch(() => {});
      console.log(`[claude-tui ${claude?.version}] rejected prompt: lock held after "No", released by UserPromptSubmit; exited by itself: ${screen.exited}`);
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
      // Only the PTY child this test spawned (its own session and process group), and only if it is still there.
      if (!screen.exited) killSpawnedGroup(child.pid, own);
      await mock.close();
      env.hooks.unregisterSession(session.sessionId);
    }
  }, 240_000);
});
