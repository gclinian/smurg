// R6 against a REAL terminal: the real sessions module runs /bin/sh in a PTY, the owner turns it into `cat -v`
// (echo off), so every byte the PTY receives comes back visibly (ESC as ^[). We watch three places at once:
// the single paste function (SessionManager.pasteSuggestion), every raw write into any PTY (PtySession.input /
// writeRaw), and the terminal output two clients receive.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Principal } from '../../src/core/interfaces.ts';
import { PtySession } from '../../src/sessions/pty-session.ts';
import { createSuggestModule } from '../../src/suggest/module.ts';
import { ACCEPT_AFTER_EDIT_MS } from '../../src/suggest/suggestion-service.ts';
import { sanitizeSuggestionForPaste } from '../../src/suggest/sanitize.ts';
import { TEST_HOST_USER, createTestDaemon, type TestClient, type TestDaemon } from '../../src/testing/index.ts';
import { OutputCollector, sleep, testSessionsModule, typeInto, waitUntil, type TestSessions } from './session-support.ts';

let t: TestDaemon | null = null;
let sessions: TestSessions | null = null;
let rawWrites: string[] = [];
const spies: MockInstance[] = [];

beforeEach(() => {
  rawWrites = [];
  const decoder = new TextDecoder();
  spies.push(
    vi.spyOn(PtySession.prototype, 'input').mockImplementation(function (this: PtySession, key: string, data: Uint8Array) {
      rawWrites.push(decoder.decode(data));
      return originalInput.call(this, key, data);
    }),
    vi.spyOn(PtySession.prototype, 'writeRaw').mockImplementation(function (this: PtySession, data: string) {
      rawWrites.push(data);
      return originalWriteRaw.call(this, data);
    }),
  );
}, 60_000);

const originalInput = PtySession.prototype.input;
const originalWriteRaw = PtySession.prototype.writeRaw;

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await t?.cleanup();
  t = null;
  await sessions?.cleanup();
  sessions = null;
}, 60_000);

interface Terminal {
  readonly host: TestClient;
  readonly bob: TestClient;
  readonly sessionId: string;
  readonly owner: OutputCollector;
  readonly watcher: OutputCollector;
  readonly paste: MockInstance;
}

/** The host's terminal, running `cat -v` with echo off and bracketed paste enabled; Bob (editor) watches it. */
async function catTerminal(): Promise<Terminal> {
  sessions = await testSessionsModule();
  t = await createTestDaemon({ modules: [sessions.module, createSuggestModule()] });
  const host = await t.connectHost();
  const bob = await t.connect({ userId: 'dev:bob', displayName: 'Bob', role: 'editor' });
  const { session } = await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 120, rows: 40 });
  const owner = new OutputCollector(host.conn, session.id);
  await owner.attach(true);
  const watcher = new OutputCollector(bob.conn, session.id);
  await watcher.attach(false);
  // Like Claude Code, the program asks for bracketed pastes (DECSET 2004): the paste function brackets only then,
  // as a real terminal does.
  // The shell prints CAT-READY itself, after `stty -echo` and right before it becomes cat. The typed command line is
  // echoed by the terminal (echo is still on then), but it spells the word with an octal escape, so "CAT-READY" can
  // only come from the printf having run. Typing a probe and looking for it was wrong: while echo was still on, the
  // terminal echoed the probe at once, and on a busy machine the test went on before the shell had run anything
  // (the paste then arrived before bracketed paste was switched on, and the test timed out).
  typeInto(host.conn, session.id, "printf '\\033[?2004h'; stty -echo; printf 'CAT-REA\\104Y\\n'; exec cat -v\r");
  await waitUntil(() => owner.output.includes('CAT-READY'), 'cat -v to run');
  const paste = vi.spyOn(t.ctx.services.sessions, 'pasteSuggestion');
  spies.push(paste);
  return { host, bob, sessionId: session.id, owner, watcher, paste };
}

const count = (text: string, part: string): number => text.split(part).length - 1;

describe('R6 with a real PTY', { timeout: 60_000 }, () => {
  it('R6.1 before a member who drives the session confirms, no suggestion text enters the agent session', async () => {
    const term = await catTerminal();
    const marker = `SUGG${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const { suggestion } = await term.bob.conn.request('suggest.create', { sessionId: term.sessionId, text: `please fix ${marker}` });
    await term.bob.conn.request('suggest.edit', { suggestionId: suggestion.id, text: `please fix ${marker} now` });
    // The owner's own keystrokes keep flowing meanwhile; the suggestion does not.
    typeInto(term.host.conn, term.sessionId, 'OWNER-TYPING\r');
    await waitUntil(() => term.owner.output.includes('OWNER-TYPING'), 'owner input');
    await sleep(1_000);
    expect(term.paste).not.toHaveBeenCalled();
    expect(rawWrites.join('')).not.toContain(marker);
    expect(term.owner.output).not.toContain(marker);
    expect(term.watcher.output).not.toContain(marker);

    // The owner has had the edited text in front of him for a while (a plain accept right after an edit is refused).
    t?.advanceClock(ACCEPT_AFTER_EDIT_MS);
    await term.host.conn.request('suggest.accept', { suggestionId: suggestion.id });
    await waitUntil(() => term.owner.output.includes(`${marker} now^[[201~`), 'the accepted suggestion in the PTY');
    // Exactly one paste, as the owner, as a bracketed paste followed by Enter.
    expect(term.paste).toHaveBeenCalledTimes(1);
    expect(term.paste.mock.calls[0]?.[0]).toBe(term.sessionId);
    expect((term.paste.mock.calls[0]?.[2] as Principal).userId).toBe(TEST_HOST_USER);
    const pasted = rawWrites.findIndex((write) => write.includes(marker));
    expect(rawWrites[pasted]).toBe(`\u001b[200~please fix ${marker} now\u001b[201~`);
    await waitUntil(() => rawWrites.slice(pasted + 1).includes('\r'), 'Enter after the paste');
    expect(term.owner.output).toContain(`^[[200~please fix ${marker} now^[[201~`);
    await waitUntil(() => term.watcher.output.includes(marker), 'viewers see it too');
  }, 60_000);

  it('R6.2 the text can be changed before it is accepted', async () => {
    const term = await catTerminal();
    const original = `ORIG${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const edited = `EDIT${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const { suggestion } = await term.bob.conn.request('suggest.create', { sessionId: term.sessionId, text: `delete tests ${original}` });
    const { suggestion: accepted } = await term.host.conn.request('suggest.accept', { suggestionId: suggestion.id, text: `fix tests ${edited}` });
    expect(accepted.status).toBe('accepted-modified');
    await waitUntil(() => term.owner.output.includes(`fix tests ${edited}^[[201~`), 'the edited text in the PTY');
    await sleep(200);
    expect(rawWrites.join('')).not.toContain(original);
    expect(term.owner.output).not.toContain(original);
  }, 60_000);

  it('escape-sequence injection in a suggestion cannot break out of the paste (real PTY)', async () => {
    const term = await catTerminal();
    // What the protocol lets through: a literal "[201~" (no ESC), tabs and newlines stay inside ONE paste.
    const { suggestion } = await term.bob.conn.request('suggest.create', { sessionId: term.sessionId, text: 'AAA[201~BBB\tCCC\nDDD' });
    const before = count(term.owner.output, '^[[201~');
    await term.host.conn.request('suggest.accept', { suggestionId: suggestion.id });
    await waitUntil(() => term.owner.output.includes('DDD^[[201~'), 'the paste');
    expect(term.owner.output).toContain('^[[200~AAA[201~BBB\tCCC');
    expect(count(term.owner.output, '^[[201~') - before).toBe(1);

    // What a bypass would carry: ESC [ 201 ~, Ctrl-C, OSC and CSI. Our layer strips it (sanitize, as accept does),
    // and so does the paste function itself when it gets the raw text.
    const hostPrincipal = t?.ctx.members.principalOf(TEST_HOST_USER) as Principal;
    const attack = 'X1\u001b[201~\u0003INJECTED\u001b]0;pwn\u0007\u009b2J\rEND1';
    const mark = count(term.owner.output, '^[[201~');
    t?.ctx.services.sessions.pasteSuggestion(term.sessionId, sanitizeSuggestionForPaste(attack), hostPrincipal);
    await waitUntil(() => term.owner.output.includes('END1^[[201~'), 'the sanitised paste');
    t?.ctx.services.sessions.pasteSuggestion(term.sessionId, attack.replace('X1', 'X2').replace('END1', 'END2'), hostPrincipal);
    await waitUntil(() => term.owner.output.includes('END2^[[201~'), 'the raw paste');
    expect(count(term.owner.output, '^[[201~') - mark).toBe(2);
    for (const write of rawWrites.filter((w) => w.includes('INJECTED'))) {
      expect(write.startsWith('\u001b[200~')).toBe(true);
      expect(write.endsWith('\u001b[201~')).toBe(true);
      expect(count(write, '\u001b')).toBe(2);
      expect(write).not.toMatch(/[\u0003\u0007\u009b]/);
    }
    // Ctrl-C never arrived: cat is still alive and reading.
    typeInto(term.host.conn, term.sessionId, 'STILL-ALIVE\r');
    await waitUntil(() => term.owner.output.includes('STILL-ALIVE'), 'cat to survive');
  }, 60_000);
});
