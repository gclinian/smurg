// SPEC R6 with the REAL suggest and sessions modules composed as in production (DEFAULT_FEATURE_MODULES): an editor
// suggests text for the host's real terminal session (a PTY running /bin/sh); nothing of it reaches the PTY until the
// session owner accepts, and then exactly the accepted (or the owner's edited) text runs there.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isSmurgError } from '@smurg/protocol';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { recorder, sleep, terminalText } from './support.ts';

let t: TestDaemon | null = null;
const savedShell = process.env['SHELL'];

beforeAll(() => {
  // The host's session runs the host's $SHELL: a plain POSIX shell here, whatever the developer uses.
  process.env['SHELL'] = '/bin/sh';
});

afterAll(() => {
  if (savedShell === undefined) delete process.env['SHELL'];
  else process.env['SHELL'] = savedShell;
});

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

describe('suggest + sessions (real modules, real PTY)', { timeout: 120_000 }, () => {
  it('擁有者確認之前，建議內容完全不會進入 agent session — then the accepted text, or the owner\'s edited version, runs in the owner\'s PTY', async () => {
    t = await createTestDaemon();
    const d = t;
    const host = await d.connectHost();
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const updates = recorder(amy.conn, 'suggest.updated');

    const { session } = await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 100, rows: 30 });
    expect(session).toMatchObject({ ownerUserId: d.hostUserId, sandboxed: false, status: 'running' });
    const screen = terminalText(host.conn, session.id);
    await host.conn.request('session.attach', { sessionId: session.id });
    // The shell is up (its own output), so anything that would reach it would show.
    host.conn.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode('echo READY-$((1+1))\r') });
    await waitFor(() => screen.text().includes('READY-2'), { timeoutMs: 20_000, what: 'the shell to run' });

    const marker = `SUGGEST${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const { suggestion } = await amy.conn.request('suggest.create', { sessionId: session.id, text: `echo ${marker}-$((6*7))` });
    expect(suggestion).toMatchObject({ status: 'pending', author: { userId: 'dev:amy' } });
    // Only the owner decides: the author cannot accept her own suggestion into someone else's session.
    const refused = await amy.conn.request('suggest.accept', { suggestionId: suggestion.id }).catch((e: unknown) => e);
    expect(isSmurgError(refused) && refused.code).toBe('forbidden');
    await sleep(1_000);
    expect(screen.text()).not.toContain(marker);

    // The owner accepts: the text goes into the PTY (as the owner) and runs.
    const { suggestion: accepted } = await host.conn.request('suggest.accept', { suggestionId: suggestion.id });
    expect(accepted.status).toBe('accepted');
    await waitFor(() => screen.text().includes(`${marker}-42`), { timeoutMs: 15_000, what: 'the accepted suggestion to run' });
    await waitFor(() => updates.some((u) => u.suggestion.id === suggestion.id && u.suggestion.status === 'accepted'), { what: 'the author told' });

    // R6.2: the owner edits before accepting; only the edited text reaches the PTY.
    const second = `SECOND${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const edited = `EDITED${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const { suggestion: other } = await amy.conn.request('suggest.create', { sessionId: session.id, text: `echo ${second}` });
    await sleep(500);
    expect(screen.text()).not.toContain(second);
    const { suggestion: modified } = await host.conn.request('suggest.accept', { suggestionId: other.id, text: `echo ${edited}-$((2+3))` });
    expect(modified).toMatchObject({ status: 'accepted-modified', finalText: `echo ${edited}-$((2+3))` });
    await waitFor(() => screen.text().includes(`${edited}-5`), { timeoutMs: 15_000, what: 'the edited suggestion to run' });
    expect(screen.text()).not.toContain(second);

    // R6.3: who, what, how and when are in the host's audit log.
    const audit = await host.conn.request('admin.audit.query', { limit: 200 });
    const create = audit.entries.find((e) => e.action === 'suggest.create' && e.detail?.['text'] === `echo ${marker}-$((6*7))`);
    expect(create?.actor).toMatchObject({ kind: 'user', userId: 'dev:amy' });
    expect(audit.entries.some((e) => e.action === 'suggest.accept' && e.actor.kind === 'user' && e.actor.userId === d.hostUserId && e.detail?.['finalText'] === `echo ${edited}-$((2+3))`)).toBe(true);
  });
});
