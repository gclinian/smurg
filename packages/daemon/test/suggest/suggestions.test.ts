// SPEC R6 / D2 over the real wire (SDK clients, in-memory relay, real router and audit log), with a recording
// stand-in for the session registry and the agent runtime: who may suggest, who decides, what reaches the agent (the
// single AgentSessions.send of the module) and when, what the audit log keeps, and what survives a restart.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEntry, Suggestion } from '@smurg/protocol';
import { createDaemon, type Daemon } from '../../src/daemon.ts';
import { AUDIT_FULL_TEXT_HEAD_CHARS } from '../../src/core/interfaces.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { createSuggestModule } from '../../src/suggest/module.ts';
import { ACCEPT_AFTER_EDIT_MS, type SuggestionServiceImpl } from '../../src/suggest/suggestion-service.ts';
import { MEMORY_RELAY_ORIGIN, TEST_HOST_NAME, TEST_HOST_USER, createTestDaemon, settle, waitFor, type TestClient, type TestDaemon } from '../../src/testing/index.ts';
import { RecordingSessions, recordingSessionsModule } from './support.ts';

interface Stack {
  readonly t: TestDaemon;
  readonly fake: RecordingSessions;
  readonly service: SuggestionServiceImpl;
  readonly host: TestClient;
  readonly amy: TestClient;
  readonly bob: TestClient;
}

let t: TestDaemon | null = null;
let restarted: Daemon | null = null;

afterEach(async () => {
  await restarted?.stop();
  restarted = null;
  await t?.cleanup();
  t = null;
}, 60_000);

/** Host, Amy (Agent access, owns ses_amy) and Bob (editor). */
async function start(limits: Parameters<typeof createSuggestModule>[0] = {}): Promise<Stack> {
  const fake = new RecordingSessions();
  t = await createTestDaemon({ modules: [recordingSessionsModule(fake), createSuggestModule(limits)] });
  const host = await t.connectHost();
  const amy = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'agent' });
  const bob = await t.connect({ userId: 'dev:bob', displayName: 'Bob', role: 'editor' });
  fake.add('ses_amy', 'dev:amy', 'Amy');
  fake.add('ses_host', TEST_HOST_USER, TEST_HOST_NAME);
  return { t, fake, service: t.ctx.services.suggestions as SuggestionServiceImpl, host, amy, bob };
}

async function settleError(promise: Promise<unknown>): Promise<{ code: string; reason?: string; message: string } | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string; detail?: Record<string, unknown> };
    const reason = e.detail?.['reason'];
    return { code: e.code ?? 'unknown', message: e.message ?? '', ...(typeof reason === 'string' ? { reason } : {}) };
  }
}

async function auditOf(s: Stack, action: string): Promise<AuditEntry[]> {
  const { entries } = await s.host.conn.request('admin.audit.query', { limit: 500 });
  return entries.filter((entry) => entry.action === action);
}

describe('who may suggest', { timeout: 60_000 }, () => {
  it('a viewer cannot suggest (refused by capability and audited)', async () => {
    const s = await start();
    const vera = await s.t.connect({ userId: 'dev:vera', role: 'viewer' });
    const refused = await settleError(vera.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'please' }));
    expect(refused).toMatchObject({ code: 'forbidden' });
    const denied = (await auditOf(s, 'authz.denied')).filter((entry) => entry.target === 'suggest.create');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ actor: { userId: 'dev:vera' }, detail: { reason: 'capability' } });
    expect(s.service.pending()).toEqual([]);
  });

  it('suggestions go to agent sessions, one\'s own included; a terminal takes none (suggest.terminal)', async () => {
    const s = await start();
    // What matters is who may drive, not whose session it is: an Agent access member may still write a suggestion.
    await s.amy.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'note to self' });
    await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'from an editor' });
    await s.host.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'from the host' });
    await s.amy.conn.request('suggest.create', { sessionId: 'ses_host', text: 'from an agent member' });
    expect(s.service.pending()).toHaveLength(4);
    expect(s.service.pending().map((item) => item.origin)).toEqual(['composer', 'composer', 'composer', 'composer']);
    s.fake.addTerminal('ses_term', 'dev:amy');
    expect(await settleError(s.bob.conn.request('suggest.create', { sessionId: 'ses_term', text: 'ls' }))).toMatchObject({ code: 'bad_request', reason: 'not-an-agent', message: 'Suggestions go to agent sessions, not to terminals.' });
    expect(s.service.pending()).toHaveLength(4);
  });

  it('unknown or ended sessions cannot receive suggestions', async () => {
    const s = await start();
    expect(await settleError(s.bob.conn.request('suggest.create', { sessionId: 'ses_nope', text: 'x' }))).toMatchObject({ code: 'not_found' });
    s.fake.exit('ses_amy');
    expect(await settleError(s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'x' }))).toMatchObject({ code: 'conflict', reason: 'session-ended' });
  });
});

describe('R6 flow', { timeout: 60_000 }, () => {
  it('R6.1 before a member who drives the session confirms, no suggestion text enters the agent session — nothing reaches the paste function before a member who may drive the session accepts', async () => {
    const s = await start();
    const vera = await s.t.connect({ userId: 'dev:vera', role: 'viewer' });
    const marker = `MARK-${Math.random().toString(36).slice(2)}`;
    const { suggestion } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: `請看一下 ${marker}` });
    expect(suggestion).toMatchObject({ status: 'pending', author: { userId: 'dev:bob', displayName: 'Bob' } });
    await s.bob.conn.request('suggest.edit', { suggestionId: suggestion.id, text: `請再看一下 ${marker}` });
    // Nobody who may not drive sessions (§11 D-15: the host and Agent access may) can push it through: the author (an
    // editor), a viewer.
    for (const who of [s.bob, vera]) {
      expect(await settleError(who.conn.request('suggest.accept', { suggestionId: suggestion.id }))).toMatchObject({ code: 'forbidden' });
      expect(await settleError(who.conn.request('suggest.accept', { suggestionId: suggestion.id, text: 'hijacked' }))).toMatchObject({ code: 'forbidden' });
    }
    await settle(10);
    expect(s.fake.pastes).toEqual([]);
    // Refusals were audited (the router's authz.denied), and none of them changed the suggestion.
    expect((await auditOf(s, 'authz.denied')).filter((entry) => entry.target === 'suggest.accept')).toHaveLength(4);
    expect(s.service.pending().map((item) => item.id)).toEqual([suggestion.id]);

    // The owner has had the edited text in front of her for a while (a plain accept right after an edit is refused:
    // see 'SEC-D-01' below).
    s.t.advanceClock(ACCEPT_AFTER_EDIT_MS);
    const { suggestion: accepted } = await s.amy.conn.request('suggest.accept', { suggestionId: suggestion.id });
    expect(accepted).toMatchObject({ status: 'accepted', finalText: `請再看一下 ${marker}` });
    // The agent reads it as a message of its AUTHOR, under a header that names who accepted it.
    expect(s.fake.pastes).toEqual([{ sessionId: 'ses_amy', text: `請再看一下 ${marker}`, by: 'dev:amy', author: 'dev:bob', modified: false }]);
    // Once decided, never again.
    expect(await settleError(s.amy.conn.request('suggest.accept', { suggestionId: suggestion.id }))).toMatchObject({ code: 'conflict', reason: 'not-pending' });
    expect(s.fake.pastes).toHaveLength(1);
  });

  it('R6.2 the text can be changed before it is accepted — only the edited text reaches the session (accepted-modified)', async () => {
    const s = await start();
    const { suggestion } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'ORIGINAL: 刪掉所有測試' });
    const { suggestion: accepted } = await s.amy.conn.request('suggest.accept', { suggestionId: suggestion.id, text: 'EDITED: 修好失敗的測試' });
    expect(accepted).toMatchObject({ status: 'accepted-modified', text: 'ORIGINAL: 刪掉所有測試', finalText: 'EDITED: 修好失敗的測試' });
    expect(s.fake.pastes.map((paste) => paste.text)).toEqual(['EDITED: 修好失敗的測試']);
  });

  it('an edit between the owner\'s review and the accept never reaches the session unseen', async () => {
    const s = await start();
    const { suggestion } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'echo REVIEWED-MARKER' });
    const reviewed = (await s.amy.conn.request('suggest.list', { sessionId: 'ses_amy' })).suggestions.find((item) => item.id === suggestion.id);
    expect(reviewed?.text).toBe('echo REVIEWED-MARKER');
    // The author edits right before the owner clicks Accept on what she reviewed.
    await s.bob.conn.request('suggest.edit', { suggestionId: suggestion.id, text: 'echo UNREVIEWED-MARKER' });
    // A plain accept (it does not say which text) is refused, audited, and nothing is pasted.
    expect(await settleError(s.amy.conn.request('suggest.accept', { suggestionId: suggestion.id }))).toMatchObject({ code: 'conflict', reason: 'suggestion-changed' });
    expect(s.fake.pastes).toEqual([]);
    expect((await auditOf(s, 'suggest.accept')).filter((entry) => entry.outcome === 'denied')).toMatchObject([{ target: suggestion.id, detail: { reason: 'suggestion-changed' } }]);
    expect(s.service.pending().map((item) => item.id)).toEqual([suggestion.id]);
    // An accept that names the text the owner saw pastes exactly that text, whatever the author did meanwhile.
    const { suggestion: accepted } = await s.amy.conn.request('suggest.accept', { suggestionId: suggestion.id, text: 'echo REVIEWED-MARKER' });
    expect(accepted).toMatchObject({ status: 'accepted-modified', text: 'echo UNREVIEWED-MARKER', finalText: 'echo REVIEWED-MARKER' });
    expect(s.fake.pastes.map((paste) => paste.text)).toEqual(['echo REVIEWED-MARKER']);

    // Naming the current text is a plain (unmodified) accept.
    const { suggestion: second } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'echo first' });
    await s.bob.conn.request('suggest.edit', { suggestionId: second.id, text: 'echo second' });
    const { suggestion: same } = await s.amy.conn.request('suggest.accept', { suggestionId: second.id, text: 'echo second' });
    expect(same).toMatchObject({ status: 'accepted', finalText: 'echo second' });
    // Long after an edit, a plain accept takes the current text (the owner has been shown it since).
    const { suggestion: third } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'echo x' });
    await s.bob.conn.request('suggest.edit', { suggestionId: third.id, text: 'echo y' });
    s.t.advanceClock(ACCEPT_AFTER_EDIT_MS);
    expect((await s.amy.conn.request('suggest.accept', { suggestionId: third.id })).suggestion).toMatchObject({ status: 'accepted', finalText: 'echo y' });
    expect(s.fake.pastes.map((paste) => paste.text)).toEqual(['echo REVIEWED-MARKER', 'echo second', 'echo y']);
  });

  it('R6.3 the audit log records the author, the text, the outcome and the time', async () => {
    const s = await start();
    const long = `${'長'.repeat(3_000)} END-OF-LONG-TEXT`;
    const a = (await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: long })).suggestion;
    const b = (await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'reject me' })).suggestion;
    const c = (await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'withdraw me' })).suggestion;
    const d = (await s.host.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'modify me' })).suggestion;
    await s.bob.conn.request('suggest.edit', { suggestionId: c.id, text: 'withdraw me (edited)' });
    await s.amy.conn.request('suggest.accept', { suggestionId: a.id });
    await s.amy.conn.request('suggest.reject', { suggestionId: b.id, reason: '不需要' });
    await s.bob.conn.request('suggest.withdraw', { suggestionId: c.id });
    await s.amy.conn.request('suggest.accept', { suggestionId: d.id, text: 'modified by the owner' });

    const created = await auditOf(s, 'suggest.create');
    expect(created).toHaveLength(4);
    // Proposer, content and time. The entry keeps the first characters, the text's SHA-256 and its length; the WHOLE
    // text (beyond the 2,000-character cut of ordinary audit strings) is in the full-text store under that hash, so
    // a member who loops suggestions cannot rotate role changes out of the core log.
    const head = `${long.slice(0, AUDIT_FULL_TEXT_HEAD_CHARS)}…`;
    const createdA = created.find((entry) => entry.target === a.id);
    expect(createdA).toMatchObject({ actor: { kind: 'user', userId: 'dev:bob', displayName: 'Bob' }, outcome: 'ok', detail: { authorUserId: 'dev:bob', sessionId: 'ses_amy', text: head, textChars: long.length } });
    expect(createdA?.at).toBeGreaterThan(0);
    expect(await s.t.ctx.audit.fullText(createdA?.detail?.['textSha256'] as string)).toBe(long);

    const accepted = (await auditOf(s, 'suggest.accept')).find((entry) => entry.target === a.id);
    expect(accepted).toMatchObject({ actor: { userId: 'dev:amy' }, detail: { authorUserId: 'dev:bob', authorName: 'Bob', outcome: 'accepted', text: head, finalText: head, finalTextChars: long.length } });
    expect(accepted?.detail?.['finalTextSha256']).toBe(createdA?.detail?.['textSha256']);
    expect(accepted?.detail?.['resolvedAt']).toBeGreaterThanOrEqual(accepted?.detail?.['createdAt'] as number);
    const modified = (await auditOf(s, 'suggest.accept')).find((entry) => entry.target === d.id);
    expect(modified).toMatchObject({ detail: { authorUserId: TEST_HOST_USER, outcome: 'accepted-modified', text: 'modify me', finalText: 'modified by the owner' } });
    const rejected = (await auditOf(s, 'suggest.reject')).find((entry) => entry.target === b.id);
    expect(rejected).toMatchObject({ actor: { userId: 'dev:amy' }, detail: { authorUserId: 'dev:bob', outcome: 'rejected', text: 'reject me', rejectReason: '不需要' } });
    const edited = (await auditOf(s, 'suggest.edit')).find((entry) => entry.target === c.id);
    expect(edited).toMatchObject({ actor: { userId: 'dev:bob' }, detail: { text: 'withdraw me (edited)' } });
    const withdrawn = (await auditOf(s, 'suggest.withdraw')).find((entry) => entry.target === c.id);
    expect(withdrawn).toMatchObject({ actor: { userId: 'dev:bob' }, detail: { outcome: 'withdrawn', text: 'withdraw me (edited)' } });
    // Every entry carries its time.
    for (const entry of [...created, accepted, rejected, edited, withdrawn]) expect(typeof entry?.at).toBe('number');
  });

  it('suggest.updated reaches the author and every member who may decide it (the host, Agent access), and nobody else', async () => {
    const s = await start();
    const carl = await s.t.connect({ userId: 'dev:carl', role: 'editor' });
    const dora = await s.t.connect({ userId: 'dev:dora', role: 'agent' });
    const seen = new Map<string, Suggestion[]>();
    for (const [name, client] of [['host', s.host], ['amy', s.amy], ['bob', s.bob], ['carl', carl], ['dora', dora]] as const) {
      seen.set(name, []);
      client.conn.on('suggest.updated', (payload) => seen.get(name)?.push(payload.suggestion));
    }
    const { suggestion } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'hello' });
    await s.amy.conn.request('suggest.reject', { suggestionId: suggestion.id });
    await waitFor(() => ['bob', 'amy', 'host', 'dora'].every((name) => (seen.get(name)?.length ?? 0) >= 2), { what: 'suggest.updated' });
    await settle(20);
    expect(seen.get('amy')?.map((item) => item.status)).toEqual(['pending', 'rejected']);
    // Dora did not open the session: she may decide it all the same (session.drive), so she is told.
    expect(seen.get('dora')?.map((item) => item.status)).toEqual(['pending', 'rejected']);
    expect(seen.get('carl')).toEqual([]);
    // suggest.list follows the same rule.
    expect((await carl.conn.request('suggest.list', {})).suggestions).toEqual([]);
    expect((await dora.conn.request('suggest.list', {})).suggestions.map((item) => item.id)).toEqual([suggestion.id]);
    expect((await s.bob.conn.request('suggest.list', { sessionId: 'ses_amy' })).suggestions.map((item) => item.id)).toEqual([suggestion.id]);
    expect((await s.amy.conn.request('suggest.list', {})).suggestions.map((item) => item.id)).toEqual([suggestion.id]);
    expect((await s.host.conn.request('suggest.list', {})).suggestions.map((item) => item.id)).toEqual([suggestion.id]);
  });

  it('who accepts (§11 D-15): any member who may drive sessions (the host, Agent access), on ANY session; the author (an editor) and a viewer are refused (audited), and nothing is pasted', async () => {
    const s = await start();
    const carl = await s.t.connect({ userId: 'dev:carl', role: 'agent' });
    const vera = await s.t.connect({ userId: 'dev:vera', role: 'viewer' });
    const { suggestion } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'accept me' });
    for (const who of [s.bob, vera]) {
      expect(await settleError(who.conn.request('suggest.accept', { suggestionId: suggestion.id }))).toMatchObject({ code: 'forbidden' });
      expect(await settleError(who.conn.request('suggest.accept', { suggestionId: suggestion.id, text: 'hijacked' }))).toMatchObject({ code: 'forbidden' });
      expect(await settleError(who.conn.request('suggest.reject', { suggestionId: suggestion.id }))).toMatchObject({ code: 'forbidden' });
    }
    // Even a caller that skips the router (the service checks again).
    const bobPrincipal = s.t.ctx.members.principalOf('dev:bob');
    if (!bobPrincipal) throw new Error('bob');
    expect(await settleError(s.service.accept({ suggestionId: suggestion.id }, bobPrincipal))).toMatchObject({ code: 'forbidden', reason: 'capability' });
    expect(s.fake.pastes).toEqual([]);
    // The refusals that came through the router are audited (the direct call above had no request to audit).
    const denied = (await auditOf(s, 'authz.denied')).filter((entry) => entry.target === 'suggest.accept' || entry.target === 'suggest.reject');
    expect(denied.map((entry) => (entry.actor.kind === 'user' ? entry.actor.userId : '')).sort()).toEqual(['dev:bob', 'dev:bob', 'dev:bob', 'dev:vera', 'dev:vera', 'dev:vera']);
    // Carl did not open Amy's session, and still decides it: he may type into it anyway.
    expect((await carl.conn.request('suggest.accept', { suggestionId: suggestion.id })).suggestion).toMatchObject({ status: 'accepted' });
    expect(s.fake.pastes).toEqual([{ sessionId: 'ses_amy', text: 'accept me', by: 'dev:carl', author: 'dev:bob', modified: false }]);
    expect((await auditOf(s, 'suggest.accept')).find((entry) => entry.target === suggestion.id && entry.outcome === 'ok')).toMatchObject({ actor: { userId: 'dev:carl' } });
    // The host decides suggestions on a member's session too.
    const { suggestion: second } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'host decides' });
    expect((await s.host.conn.request('suggest.reject', { suggestionId: second.id, reason: '主人拒絕' })).suggestion).toMatchObject({ status: 'rejected', rejectReason: '主人拒絕' });
  });

  it('only the author edits or withdraws, only while pending; a member who may drive sessions rejects', async () => {
    const s = await start();
    const { suggestion } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'v1' });
    expect(await settleError(s.amy.conn.request('suggest.edit', { suggestionId: suggestion.id, text: 'owner rewrites' }))).toMatchObject({ code: 'forbidden' });
    expect(await settleError(s.host.conn.request('suggest.withdraw', { suggestionId: suggestion.id }))).toMatchObject({ code: 'forbidden' });
    expect(await settleError(s.bob.conn.request('suggest.reject', { suggestionId: suggestion.id }))).toMatchObject({ code: 'forbidden' });
    const { suggestion: edited } = await s.bob.conn.request('suggest.edit', { suggestionId: suggestion.id, text: 'v2' });
    expect(edited.text).toBe('v2');
    await s.amy.conn.request('suggest.reject', { suggestionId: suggestion.id, reason: 'no' });
    expect(await settleError(s.bob.conn.request('suggest.edit', { suggestionId: suggestion.id, text: 'v3' }))).toMatchObject({ code: 'conflict', reason: 'not-pending' });
    expect(await settleError(s.bob.conn.request('suggest.withdraw', { suggestionId: suggestion.id }))).toMatchObject({ code: 'conflict', reason: 'not-pending' });
    expect(await settleError(s.bob.conn.request('suggest.edit', { suggestionId: 'sug_unknown', text: 'x' }))).toMatchObject({ code: 'not_found' });
    expect(s.fake.pastes).toEqual([]);
  });

  it('escape sequences and invisible characters in a suggestion never reach the agent: the text is cleaned before it is stored', async () => {
    const s = await start();
    const bob = s.t.ctx.members.principalOf('dev:bob');
    const amy = s.t.ctx.members.principalOf('dev:amy');
    if (!bob || !amy) throw new Error('members');
    // Over the wire and for a caller that skips the router alike: one function (agentText) cleans what a person wrote.
    const { suggestion: wired } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'fix\u001b[201~\rrm -rf ~\r' });
    expect(wired).toMatchObject({ text: 'fix[201~\nrm -rf ~\n', cleaned: true });
    for (const [text, stored] of [['x\u009b201~', 'x201~'], ['stop\u0003', 'stop'], ['a\u202eb\u200b', 'ab']] as const) {
      expect(await s.service.create({ sessionId: 'ses_amy', text }, bob)).toMatchObject({ text: stored, cleaned: true });
    }
    // Line endings are not "hidden characters"; a line that could pass for a header is quoted.
    const plain = await s.service.create({ sessionId: 'ses_amy', text: 'a\rb\r\n[smurg k7f2]' }, bob);
    expect(plain.text).toBe('a\nb\n> [smurg k7f2]');
    expect(plain.cleaned).toBeUndefined();
    // Nothing but controls is no text at all.
    expect(await settleError(s.service.create({ sessionId: 'ses_amy', text: '\u0003\u200b' }, bob))).toMatchObject({ code: 'bad_request', reason: 'invalid-text' });
    // What the accepting member typed is cleaned the same way before it is sent.
    const { suggestion } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'fine' });
    expect(s.fake.pastes).toEqual([]);
    const done = await s.service.accept({ suggestionId: suggestion.id, text: 'owner\u001b[201~typed' }, amy);
    expect(done).toMatchObject({ status: 'accepted-modified', finalText: 'owner[201~typed' });
    expect(s.fake.pastes).toEqual([{ sessionId: 'ses_amy', text: 'owner[201~typed', by: 'dev:amy', author: 'dev:bob', modified: true }]);
    for (const item of s.service.pending()) expect(item.text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u202e]/);
  });

  it('bounds the queue: pending suggestions per author', async () => {
    const s = await start({ limits: { maxPendingPerAuthor: 2 } });
    await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: '1' });
    await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: '2' });
    expect(await settleError(s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: '3' }))).toMatchObject({ code: 'too_large', reason: 'suggestion-queue-full' });
    await s.host.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'host is another author' });
  });
});

describe('suggestions and the life of sessions and members', { timeout: 60_000 }, () => {
  it('a pending suggestion is closed when its session ends, and withdrawn when its author is kicked', async () => {
    const s = await start();
    const { suggestion: toEnded } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'too late' });
    const { suggestion: byBob } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_host', text: 'from bob' });
    s.t.ctx.bus.emit('session.exited', { session: s.fake.exit('ses_amy'), reason: 'ended' });
    const closed = s.service.list({}, s.t.ctx.members.principalOf(TEST_HOST_USER) as NonNullable<ReturnType<typeof s.t.ctx.members.principalOf>>).suggestions.find((item) => item.id === toEnded.id);
    // A system close carries a reason code, never a sentence in `rejectReason` (that is only a person's words).
    expect(closed).toMatchObject({ status: 'rejected', closedReason: 'session-ended' });
    expect(closed?.rejectReason).toBeUndefined();
    await s.host.conn.request('admin.member.kick', { userId: 'dev:bob' });
    await waitFor(() => s.service.pending().length === 0, { what: 'bob\'s suggestion to be withdrawn' });
    const withdrawn = (await auditOf(s, 'suggest.withdraw')).find((entry) => entry.target === byBob.id);
    expect(withdrawn).toMatchObject({ actor: { kind: 'system' }, detail: { reason: 'author-kicked', outcome: 'withdrawn' } });
    const hostPrincipal = s.t.ctx.members.principalOf(TEST_HOST_USER) as NonNullable<ReturnType<typeof s.t.ctx.members.principalOf>>;
    expect(s.service.list({}, hostPrincipal).suggestions.find((item) => item.id === byBob.id)).toMatchObject({ status: 'withdrawn', closedReason: 'author-kicked' });
    expect(s.fake.pastes).toEqual([]);
  });

  it('suggestions survive a daemon restart (still pending while the session runs; closed once it is gone)', async () => {
    const s = await start();
    const { suggestion: pending } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'survive me' });
    const { suggestion: orphan } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_host', text: 'my session will be gone' });
    const { suggestion: done } = await s.bob.conn.request('suggest.create', { sessionId: 'ses_amy', text: 'decided before' });
    await s.amy.conn.request('suggest.accept', { suggestionId: done.id, text: 'decided and edited' });
    await s.t.daemon.stop();
    // suggestions.json holds them (0600, validated on load).
    const file = await readFile(join(s.t.ctx.state.dir, 'suggestions.json'), 'utf8');
    expect(file).toContain('survive me');

    const again = new RecordingSessions();
    again.add('ses_amy', 'dev:amy', 'Amy'); // (a session the stand-in still reports running)
    restarted = await createDaemon({
      config: { stateDir: s.t.stateDir, runDir: s.t.runDir, shareDir: s.t.root, workspaceId: s.t.workspaceId, hostUserId: TEST_HOST_USER, hostName: TEST_HOST_NAME, relayUrl: MEMORY_RELAY_ORIGIN, webOrigin: MEMORY_RELAY_ORIGIN, keepAwake: false },
      relay: { token: 'test-host-token', socketFactory: s.t.relay.hostSocketFactory() },
      identityKeys: { get: (kid) => (kid === s.t.issuer.kid ? s.t.issuer.publicKey : null), refresh: async () => {} },
      modules: [recordingSessionsModule(again), createSuggestModule()],
      clock: s.t.clock,
      log: silentLogger,
      homeDir: join(dirname(s.t.stateDir), 'home'),
      random: () => 0.5,
    });
    await restarted.start();
    const service = restarted.ctx.services.suggestions;
    const host = restarted.ctx.members.principalOf(TEST_HOST_USER);
    const amy = restarted.ctx.members.principalOf('dev:amy');
    if (!host || !amy) throw new Error('members');
    const all = new Map(service.list({}, host).suggestions.map((item) => [item.id, item]));
    expect(all.get(pending.id)).toMatchObject({ status: 'pending', text: 'survive me', author: { userId: 'dev:bob' } });
    expect(all.get(orphan.id)).toMatchObject({ status: 'rejected', closedReason: 'session-ended' });
    expect(all.get(orphan.id)?.rejectReason).toBeUndefined();
    expect(all.get(done.id)).toMatchObject({ status: 'accepted-modified', finalText: 'decided and edited' });
    // And the pending one can still be decided, through the one paste function.
    await service.accept({ suggestionId: pending.id }, amy);
    expect(again.pastes).toEqual([{ sessionId: 'ses_amy', text: 'survive me', by: 'dev:amy', author: 'dev:bob', modified: false }]);
  });
});

describe('the invariant, in the code itself', () => {
  it('exactly one call of AgentSessions.send exists in the suggest module, inside SuggestionService.accept, and there is no auto-accept', async () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
    const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const calls: string[] = [];
    for (const name of await readdir(join(srcDir, 'suggest'))) {
      const text = code(await readFile(join(srcDir, 'suggest', name), 'utf8'));
      for (const match of text.matchAll(/\.agents\s*\.\s*send\s*\(|\[\s*['"`]send['"`]\s*\]/g)) calls.push(`suggest/${name}@${match.index}`);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^suggest\/suggestion-service\.ts@/);
    const service = code(await readFile(join(srcDir, 'suggest', 'suggestion-service.ts'), 'utf8'));
    const acceptBody = service.slice(service.indexOf('  async accept('), service.indexOf('  async reject('));
    expect(acceptBody).toContain('.agents.send(');
    expect(acceptBody.indexOf('this.requireDriver(')).toBeGreaterThan(-1);
    expect(acceptBody.indexOf('this.requireDriver(')).toBeLessThan(acceptBody.indexOf('.agents.send('));
    expect(acceptBody.indexOf("stored.status !== 'pending'")).toBeLessThan(acceptBody.indexOf('.agents.send('));
    // Nothing of the suggest module reaches a PTY any more, and no switch, flag or setting accepts on anyone's behalf.
    for (const file of await readdir(join(srcDir, 'suggest'))) {
      const text = code(await readFile(join(srcDir, 'suggest', file), 'utf8'));
      expect(text).not.toMatch(/auto[-_]?accept/i);
      expect(text).not.toMatch(/pasteSuggestion|\.pty\b|exec\.input/);
    }
  });
});
