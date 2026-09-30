// The audit log (R11): append-only JSONL (0600), strictly increasing `at`, newest-first paging, live feed only to
// the host, and it never contains sensitive payloads (file contents, keys, tokens, invite secrets, API keys).
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type AuditEntry } from '@smurg/protocol';
import { JsonlAuditLog, auditDetailForMessage, sanitizeAuditDetail } from '../src/core/audit.ts';
import { ManualClock } from '../src/core/lifecycle.ts';
import { silentLogger } from '../src/core/logger.ts';
import { SYSTEM_ACTOR } from '../src/core/permissions.ts';
import { createTempDir, createTestDaemon, removeTempDir, waitFor, type TestDaemon } from '../src/testing/index.ts';
import { createProbe } from './fixtures/probe-module.ts';

let t: TestDaemon | null = null;
let base: string | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
  if (base) await removeTempDir(base);
  base = null;
});

describe('JsonlAuditLog', () => {
  it('assigns strictly increasing times even with a frozen clock, pages newest first, survives a reopen', async () => {
    base = await createTempDir('audit');
    const path = join(base, 'audit.jsonl');
    const clock = new ManualClock(1_760_000_000_000);
    const log = await JsonlAuditLog.open(path, { clock, log: silentLogger, pageMax: 500 });
    for (let i = 0; i < 25; i++) log.record({ actor: SYSTEM_ACTOR, action: 'settings.change', outcome: 'ok', target: `t${i}` });
    const first = await log.query({ limit: 10 });
    expect(first.map((e) => e.target)).toEqual(['t24', 't23', 't22', 't21', 't20', 't19', 't18', 't17', 't16', 't15']);
    const second = await log.query({ limit: 10, before: (first.at(-1) as AuditEntry).at });
    expect(second.map((e) => e.target)).toEqual(['t14', 't13', 't12', 't11', 't10', 't9', 't8', 't7', 't6', 't5']);
    const all = await log.query({ limit: 500 });
    expect(all).toHaveLength(25);
    for (let i = 1; i < all.length; i++) expect((all[i - 1] as AuditEntry).at).toBeGreaterThan((all[i] as AuditEntry).at);
    await log.close();
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600');
    const reopened = await JsonlAuditLog.open(path, { clock, log: silentLogger, pageMax: 500 });
    const next = reopened.record({ actor: SYSTEM_ACTOR, action: 'settings.change', outcome: 'ok' });
    expect(next.at).toBeGreaterThan((all[0] as AuditEntry).at);
    await reopened.close();
  });

  it('skips a torn last line after a crash', async () => {
    base = await createTempDir('audit');
    const path = join(base, 'audit.jsonl');
    const log = await JsonlAuditLog.open(path, { clock: new ManualClock(), log: silentLogger, pageMax: 500 });
    log.record({ actor: SYSTEM_ACTOR, action: 'settings.change', outcome: 'ok' });
    await log.flush();
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, '{"id":"au_x","at":');
    expect(await log.query()).toHaveLength(1);
    await log.close();
  });

  it('after a restart, the first entry is not glued onto a torn last line (REL-02)', async () => {
    base = await createTempDir('audit');
    const path = join(base, 'audit.jsonl');
    const clock = new ManualClock(1_760_000_000_000);
    const first = await JsonlAuditLog.open(path, { clock, log: silentLogger, pageMax: 500 });
    first.record({ actor: SYSTEM_ACTOR, action: 'settings.change', outcome: 'ok', target: 'before' });
    await first.close();
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, '{"id":"au_x","at":1760000000001,"actor":{"kind":"'); // the daemon died mid-append
    const reopened = await JsonlAuditLog.open(path, { clock, log: silentLogger, pageMax: 500 });
    reopened.record({ actor: { kind: 'user', userId: 'dev:amy', displayName: 'Amy' }, action: 'auth.connect', outcome: 'ok', target: 'after' });
    await reopened.flush();
    expect((await reopened.query({ limit: 10 })).map((e) => e.target)).toEqual(['after', 'before']);
    await reopened.close();
  });

  it('keeps an entry whose append failed and writes it with the next one (REL-14)', async () => {
    base = await createTempDir('audit');
    const path = join(base, 'audit.jsonl');
    const log = await JsonlAuditLog.open(path, { clock: new ManualClock(1_760_000_000_000), log: silentLogger, pageMax: 500 });
    // Stand-in for ENOSPC / EIO on the open handle: the next append fails once.
    const handle = (log as unknown as { handle: { appendFile: (text: string, enc: string) => Promise<void> } }).handle;
    const real = handle.appendFile.bind(handle);
    let fail = true;
    handle.appendFile = async (text, enc) => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      }
      return real(text, enc);
    };
    log.record({ actor: SYSTEM_ACTOR, action: 'member.kick', outcome: 'ok', target: 'dev:amy' });
    await log.flush();
    log.record({ actor: SYSTEM_ACTOR, action: 'settings.change', outcome: 'ok', target: 'next' });
    await log.flush();
    expect((await log.query({ limit: 10 })).map((e) => e.target)).toEqual(['next', 'dev:amy']);
    await log.close();
  });

  it('sanitises detail: bytes become sizes, secret-bearing keys are replaced, prototype keys dropped', () => {
    const detail = sanitizeAuditDetail({
      content: new TextEncoder().encode('FILE-CONTENT'),
      apiKey: 'sk-ant-SECRET',
      nested: { identityToken: 'a.b.c', url: 'https://x/join/w#k=a&s=SECRET', keep: 'visible' },
      data: new Uint8Array(10),
      ['__proto__']: { polluted: true },
      text: 'suggestion text is allowed (R6)',
    });
    expect(detail).toEqual({
      content: { bytes: 12 },
      apiKey: '[redacted]',
      nested: { identityToken: '[redacted]', url: '[redacted]', keep: 'visible' },
      data: { bytes: 10 },
      text: 'suggestion text is allowed (R6)',
    });
    expect(auditDetailForMessage('file.write', { file: { root: MAIN_ROOT, path: 'a' }, content: new Uint8Array(3) })).toEqual({ type: 'file.write', payload: '[redacted]' });
    expect(auditDetailForMessage('session.create', { kind: 'agent', apiKey: 'sk-SECRET' })).toEqual({ type: 'session.create', payload: '[redacted]' });
    expect(auditDetailForMessage('lock.release', { file: { root: MAIN_ROOT, path: 'a' } })).toEqual({ type: 'lock.release', file: { root: { kind: 'main' }, path: 'a' } });
  });
});

describe('JsonlAuditLog bounds (security review F5, contract review C12)', () => {
  const amy = { kind: 'user', userId: 'dev:amy', displayName: 'Amy' } as const;

  it('records at most the per-actor budget of denials per minute, then one note and one summary', async () => {
    base = await createTempDir('audit');
    const path = join(base, 'audit.jsonl');
    const clock = new ManualClock(1_760_000_000_000);
    const log = await JsonlAuditLog.open(path, { clock, log: silentLogger, pageMax: 500, deniedPerActorPerMinute: 10 });
    const live: AuditEntry[] = [];
    log.subscribe((entry) => live.push(entry));
    for (let i = 0; i < 1_000; i++) log.record({ actor: amy, action: 'authz.denied', outcome: 'denied', target: 'file.write', detail: { reason: 'capability' } });
    // Other actors and other outcomes are not affected.
    log.record({ actor: SYSTEM_ACTOR, action: 'authz.denied', outcome: 'denied', target: 'x' });
    log.record({ actor: amy, action: 'auth.connect', outcome: 'ok' });
    clock.advance(61_000);
    log.record({ actor: amy, action: 'authz.denied', outcome: 'denied', target: 'file.write' }); // new window: summary first
    const entries = (await log.query({ limit: 500 })).reverse();
    const amyDenied = entries.filter((e) => e.actor.kind === 'user' && e.outcome === 'denied');
    expect(amyDenied).toHaveLength(10 + 1 + 1 + 1); // budget, the "rate limited" note, the summary, the next window's first
    expect(amyDenied[10]?.detail).toMatchObject({ rateLimited: true, limitPerMinute: 10 });
    expect(amyDenied[11]).toMatchObject({ target: 'audit-rate-limit', detail: { reason: 'audit-rate-limit', notRecorded: 989 } });
    expect(entries.some((e) => e.actor.kind === 'system')).toBe(true);
    expect(entries.some((e) => e.action === 'auth.connect')).toBe(true);
    expect(live).toHaveLength(entries.length); // the host console gets exactly what is on disk
    await log.close();
  });

  it('rotates at the size cap (0600 files) and pages through the rotated files', async () => {
    base = await createTempDir('audit');
    const path = join(base, 'audit.jsonl');
    const log = await JsonlAuditLog.open(path, { clock: new ManualClock(1_760_000_000_000), log: silentLogger, pageMax: 500, maxBytes: 8_192 });
    for (let i = 0; i < 120; i++) log.record({ actor: SYSTEM_ACTOR, action: 'settings.change', outcome: 'ok', target: `t${i}`, detail: { pad: 'x'.repeat(100) } });
    await log.flush();
    for (const file of [path, join(base, 'audit.1.jsonl'), join(base, 'audit.2.jsonl')]) {
      expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
      expect((await stat(file)).size).toBeLessThanOrEqual(8_192);
    }
    await expect(stat(join(base, 'audit.3.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    const page = await log.query({ limit: 500 });
    // Newest first and gap-free across the files that are kept; the oldest ones were rotated out.
    expect(page[0]?.target).toBe('t119');
    const numbers = page.map((e) => Number(e.target?.slice(1)));
    expect(numbers).toEqual(numbers.map((_, i) => 119 - i));
    expect(page.length).toBeGreaterThan(40);
    expect(page.length).toBeLessThan(120);
    await log.close();
    // A restart right after a rotation keeps `at` increasing.
    const reopened = await JsonlAuditLog.open(path, { clock: new ManualClock(1), log: silentLogger, pageMax: 500, maxBytes: 8_192 });
    expect(reopened.record({ actor: SYSTEM_ACTOR, action: 'settings.change', outcome: 'ok' }).at).toBeGreaterThan(page[0]?.at as number);
    await reopened.close();
  });

  it('keeps a whole suggestion text only under the keys the caller lists in fullText (R6.3)', () => {
    const text = 'x'.repeat(5_000);
    expect((sanitizeAuditDetail({ text }) as { text: string }).text).toHaveLength(2_001); // cut + ellipsis
    expect(sanitizeAuditDetail({ text, finalText: text, other: text }, ['text', 'finalText'])).toEqual({ text, finalText: text, other: `${'x'.repeat(2_000)}…` });
    // Redaction by key still wins.
    expect(sanitizeAuditDetail({ content: 'SECRET' }, ['content'])).toEqual({ content: '[redacted]' });
  });
});

describe('audit through the daemon', () => {
  it('closes a connection that keeps sending refused requests, and ends its logical channel (no replay of the flood)', async () => {
    t = await createTestDaemon({ limits: { maxDenialsPerConnPerMinute: 20 } });
    const vera = await t.connect({ userId: 'dev:vera', role: 'viewer' });
    const firstChannel = vera.welcome?.channelId;
    const results = await Promise.allSettled(
      Array.from({ length: 200 }, () => vera.conn.request('file.write', { file: { root: MAIN_ROOT, path: 'x.txt' }, content: new Uint8Array(1) })),
    );
    const forbidden = results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'forbidden').length;
    expect(forbidden).toBeLessThanOrEqual(21);
    expect(forbidden).toBeGreaterThanOrEqual(20);
    await (t as TestDaemon).ctx.audit.flush();
    const entries = await t.ctx.audit.query({ limit: 500 });
    const denials = entries.filter((e) => e.action === 'authz.denied' && e.actor.kind === 'user' && e.actor.userId === 'dev:vera');
    expect(denials.length).toBeLessThanOrEqual(22);
    expect(denials.some((e) => e.detail?.['reason'] === 'too-many-denials')).toBe(true);
    // The client came back on a NEW logical channel: nothing of the flood was replayed.
    await waitFor(() => vera.conn.getState().kind === 'online', { what: 'reconnect' });
    expect(vera.conn.welcome?.channelId).not.toBe(firstChannel);
  });

  it('never contains sensitive payloads, whether the request was allowed or denied', async () => {
    const probe = createProbe();
    t = await createTestDaemon({ modules: [probe.module] });
    const MARKER = 'SMURG-AUDIT-MARKER-7f3a9c1e5b2d';
    const bytes = new TextEncoder().encode(MARKER);
    const host = await t.connectHost();
    const vera = await t.connect({ userId: 'dev:vera', role: 'viewer' });
    const rita = await t.connect({ userId: 'dev:rita', role: 'runner' });
    const write = { file: { root: MAIN_ROOT, path: 'x.txt' }, content: bytes };
    await vera.conn.request('file.write', write).catch(() => {}); // denied
    await host.conn.request('file.write', write).catch(() => {}); // allowed (probe)
    await vera.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, cols: 80, rows: 24, apiKey: MARKER }).catch(() => {});
    await rita.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, cols: 80, rows: 24, apiKey: MARKER }).catch(() => {});
    await rita.conn.request('session.importConfig', { files: [{ relPath: 'CLAUDE.md', content: bytes }] }).catch(() => {});
    const { url } = await host.conn.request('admin.invite.create', { role: 'editor' });
    const secret = new URL(url).hash.slice(1);
    await t.ctx.audit.flush();
    const raw = await readFile(join(t.stateDir, 'workspaces', t.workspaceId, 'audit.jsonl'), 'utf8');
    for (const needle of [MARKER, Buffer.from(MARKER).toString('base64'), Buffer.from(MARKER).toString('hex'), secret, url]) expect(raw).not.toContain(needle);
    // …while the events themselves are recorded.
    expect(raw).toContain('"action":"authz.denied"');
    expect(raw).toContain('"action":"invite.create"');
  });

  it('streams admin.audit.entry to the host and to nobody else', async () => {
    t = await createTestDaemon();
    const host = await t.connectHost();
    const eddie = await t.connect({ userId: 'dev:eddie', role: 'editor' });
    const hostSeen: string[] = [];
    let eddieSeen = 0;
    host.conn.on('admin.audit.entry', (payload) => hostSeen.push(payload.entry.action));
    eddie.conn.on('admin.audit.entry', () => eddieSeen++);
    await eddie.conn.request('admin.member.list', {}).catch(() => {});
    await waitFor(() => hostSeen.includes('authz.denied'), { what: 'live audit entry' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(eddieSeen).toBe(0);
    const { entries } = await host.conn.request('admin.audit.query', { limit: 5 });
    expect(entries[0]?.action).toBe('authz.denied');
  });
});
