// Unit tests of the small core pieces: logical-channel bookkeeping (the daemon half of the resume contract), the
// router's per-message role check and error mapping, stubs, the event bus, backoff, the line logger's quoting.
import { TokenBucketLimiter } from '../src/core/rates.ts';
import { describe, expect, it } from 'vitest';
import { EDIT_TOOL_NAMES, SmurgError, isEditTool, type ClientEnvelope } from '@smurg/protocol';
import { EDIT_TOOL_NAMES as HOOK_EDIT_TOOL_NAMES } from '../src/hooks/wire.ts';
import { JsonlAuditLog } from '../src/core/audit.ts';
import { TypedEventBus } from '../src/core/bus.ts';
import type { ClientConnection, MemberRecord } from '../src/core/interfaces.ts';
import { ManualClock } from '../src/core/lifecycle.ts';
import { LogicalChannel } from '../src/core/logical-channel.ts';
import { LOG_UNSAFE_CHARACTER, createLineLogger, createMemoryLogger, quoteForLog, silentLogger } from '../src/core/logger.ts';
import { RouterImpl, type ReplySink } from '../src/core/router.ts';
import { createStubService, isStubService } from '../src/core/stubs.ts';
import { PathDeniedError } from '../src/core/errors.ts';
import { TokenBucket, backoffDelay } from '../src/net/rate-limit.ts';
import { createTempDir, removeTempDir } from '../src/testing/temp.ts';
import { join } from 'node:path';

describe('LogicalChannel', () => {
  const make = (maxEntries = 100, maxBytes = 1_000_000) => new LogicalChannel('ch_1', 'dev:amy', 'dev1', 0, { maxEntries, maxBytes });

  it('sequences, trims on ack and resumes only inside the kept range', () => {
    const channel = make();
    for (let i = 0; i < 5; i++) channel.push(channel.nextSeq(), new Uint8Array([i]));
    expect(channel.d2cSeq).toBe(5);
    channel.trim(2);
    expect(channel.pendingAfter(0).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(channel.canResumeFrom(2)).toBe(true);
    expect(channel.canResumeFrom(5)).toBe(true);
    expect(channel.canResumeFrom(6)).toBe(false); // the client claims more than was ever sent
    channel.trim(99); // clamped to what was sent
    expect(channel.outboxLength).toBe(0);
  });

  it('overflow drops the oldest entries and makes an older resume impossible', () => {
    const channel = make(3);
    for (let i = 0; i < 6; i++) channel.push(channel.nextSeq(), new Uint8Array(10));
    expect(channel.pendingAfter(0).map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(channel.droppedUpTo).toBe(3);
    expect(channel.canResumeFrom(2)).toBe(false);
    expect(channel.canResumeFrom(3)).toBe(true);
    const bytes = make(100, 25);
    for (let i = 0; i < 4; i++) bytes.push(bytes.nextSeq(), new Uint8Array(10));
    expect(bytes.outboxBytes).toBeLessThanOrEqual(25);
  });

  it('drops c→d duplicates by seq, tolerates gaps, never de-duplicates seq 0', () => {
    const channel = make();
    expect(channel.acceptInbound(1)).toBe(true);
    expect(channel.acceptInbound(4)).toBe(true);
    expect(channel.acceptInbound(3)).toBe(false);
    expect(channel.acceptInbound(4)).toBe(false);
    expect(channel.acceptInbound(0)).toBe(true);
    expect(channel.acceptInbound(0)).toBe(true);
  });
});

describe('RouterImpl', () => {
  async function setup(member: MemberRecord | null) {
    const base = await createTempDir('router');
    const audit = await JsonlAuditLog.open(join(base, 'audit.jsonl'), { clock: new ManualClock(), log: silentLogger, pageMax: 500 });
    const replies: { id: string; type: string; payload: unknown }[] = [];
    let protocolErrors = 0;
    let denials = 0;
    const sink: ReplySink = {
      reply: (_c, id, type, payload) => replies.push({ id, type, payload }),
      protocolError: () => protocolErrors++,
      denied: () => denials++,
    };
    const current = { member };
    const rates = new TokenBucketLimiter(new ManualClock());
    const router = new RouterImpl({ sink, members: { active: () => current.member }, audit, log: silentLogger, rates });
    const conn = { id: 'conn_1', userId: 'dev:amy' } as ClientConnection;
    const cleanup = async () => {
      await audit.close();
      await removeTempDir(base);
    };
    return { router, audit, replies, current, conn, cleanup, protocolErrors: () => protocolErrors, denials: () => denials };
  }
  const amy = (role: MemberRecord['role']): MemberRecord => ({ userId: 'dev:amy', displayName: 'Amy', role, color: '#123456', joinedAt: 0, lastSeenAt: 0, status: 'active' });
  const env = (type: string, payload: unknown): ClientEnvelope => ({ type, id: 'r1', seq: 1, payload }) as ClientEnvelope;

  it('judges every message with the role the member has NOW', async () => {
    const s = await setup(amy('editor'));
    let calls = 0;
    s.router.handle('lock.release', () => {
      calls++;
      return {};
    });
    await s.router.dispatch(s.conn, env('lock.release', { file: { root: { kind: 'main' }, path: 'a' } }));
    s.current.member = amy('viewer');
    await s.router.dispatch(s.conn, env('lock.release', { file: { root: { kind: 'main' }, path: 'a' } }));
    s.current.member = null;
    await s.router.dispatch(s.conn, env('lock.release', { file: { root: { kind: 'main' }, path: 'a' } }));
    expect(calls).toBe(1);
    expect(s.replies.map((r) => r.type === 'error' ? (r.payload as { code: string }).code : r.type)).toEqual(['lock.release.ok', 'forbidden', 'unauthorized']);
    expect((await s.audit.query()).map((e) => e.action)).toEqual(['authz.denied', 'authz.denied']);
    // Every refusal counts against the connection's denial budget (security review F5).
    expect(s.denials()).toBe(2);
    await s.cleanup();
  });

  it('maps handler errors: path denials and forbidden are audited once, unknown errors become internal, missing handlers answer internal / not-implemented', async () => {
    const s = await setup(amy('host'));
    s.router.handle('file.stat', () => {
      throw new PathDeniedError('outside-root', 'x');
    });
    s.router.handle('file.read', () => {
      throw new SmurgError('forbidden');
    });
    s.router.handle('lock.list', () => {
      throw new Error('/Users/host/secret/path leaked?');
    });
    await s.router.dispatch(s.conn, env('file.stat', { root: { kind: 'main' }, path: 'x' }));
    await s.router.dispatch(s.conn, env('file.read', { file: { root: { kind: 'main' }, path: 'x' } }));
    await s.router.dispatch(s.conn, env('lock.list', {}));
    await s.router.dispatch(s.conn, env('file.tree', { root: { kind: 'main' }, path: '' }));
    const codes = s.replies.map((r) => (r.payload as { code: string; message: string; detail?: Record<string, unknown>; text?: { id: string } }));
    expect(codes.map((c) => c.code)).toEqual(['path_denied', 'forbidden', 'internal', 'internal']);
    expect(codes[2]?.message).not.toContain('/Users');
    expect(codes[3]).toMatchObject({ detail: { reason: 'not-implemented', service: 'file.tree' }, text: { id: 'error.default.internal' } });
    // Every error the router answers carries a message reference; the fallback text is English.
    expect(codes.map((c) => c.text?.id)).toEqual(['path.outsideRoot', 'error.default.forbidden', 'error.default.internal', 'error.default.internal']);
    expect((await s.audit.query()).map((e) => e.action).sort()).toEqual(['authz.denied', 'path.denied']);
    expect(s.denials()).toBe(2); // the path denial and the forbidden; internal errors are not refusals
    expect(() => s.router.handle('file.stat', () => ({}) as never)).toThrow(/already registered/);
    expect(() => s.router.handle('file.changed' as never, () => ({}) as never)).toThrow(/not a request type/);
    await s.cleanup();
  });

  it('runs afterReply hooks after the .ok went out', async () => {
    const s = await setup(amy('host'));
    const order: string[] = [];
    s.router.handle('lock.list', (_p, ctx) => {
      ctx.afterReply(() => order.push(`after:${s.replies.length}`));
      return { locks: [] };
    });
    await s.router.dispatch(s.conn, env('lock.list', {}));
    expect(order).toEqual(['after:1']);
    await s.cleanup();
  });
});

describe('stubs, bus, rate limits', () => {
  it('stubs throw internal / not-implemented naming the service and are not thenables', async () => {
    const files = createStubService('files');
    expect(isStubService(files)).toBe(true);
    let stubError: unknown = null;
    try {
      files.lastModifiedBy({ root: { kind: 'main' }, path: 'a' });
    } catch (err) {
      stubError = err;
    }
    expect(stubError).toMatchObject({ code: 'internal', detail: { reason: 'not-implemented', service: 'FileService' } });
    await expect((async () => files.tree({ root: { kind: 'main' }, path: '' }, null as never))()).rejects.toMatchObject({ code: 'internal' });
    await expect(Promise.resolve(files)).resolves.toBe(files);
  });

  it('the bus keeps delivering when a listener throws', () => {
    const log = createMemoryLogger();
    const bus = new TypedEventBus(log);
    const seen: string[] = [];
    bus.on('member.left', () => {
      throw new Error('boom');
    });
    bus.on('member.left', (e) => seen.push(e.userId));
    const once = bus.once('member.left', (e) => seen.push(`once:${e.userId}`));
    bus.emit('member.left', { userId: 'dev:a', by: { kind: 'system' } });
    bus.emit('member.left', { userId: 'dev:b', by: { kind: 'system' } });
    once.dispose();
    expect(seen).toEqual(['dev:a', 'once:dev:a', 'dev:b']);
    expect(log.lines.filter((l) => l.level === 'error')).toHaveLength(2);
  });

  it('token bucket and jittered backoff', () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ perMinute: 2, clock });
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
    clock.advance(30_000);
    expect(bucket.take()).toBe(true);
    const options = { baseMs: 500, maxMs: 30_000, jitter: 0.3 };
    expect(backoffDelay(0, options, () => 0.5)).toBe(500);
    expect(backoffDelay(3, options, () => 0.5)).toBe(4_000);
    expect(backoffDelay(30, options, () => 0.5)).toBe(30_000);
    expect(backoffDelay(0, options, () => 0)).toBe(350);
  });

  it('the line logger writes one line per call and no character a terminal could act on, whatever a value holds (a guest-made directory name, review attack F1)', () => {
    const lines: string[] = [];
    const log = createLineLogger({ write: (line) => lines.push(line), now: () => 0 });
    const name = '/p/a\nfake 2026 error "x"\u001b[2J\u007f\u009b2J\u009d52;c;Y2xpcA==\u009c\u0085\u2028\u202e\u2066b/.git';
    log.warn(`message ${name}`, { path: name, plain: '/p/ok/.git', n: 3 });
    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    // nothing below U+0020, DEL, C1, a line separator or a bidirectional control is left raw
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    expect(line.startsWith('1970-01-01T00:00:00.000Z warn "message /p/a\\nfake 2026 error \\"x\\"\\u001b[2J\\u007f\\u009b2J')).toBe(true);
    expect(line.endsWith(' plain=/p/ok/.git n=3')).toBe(true);
    // the quoted value is still JSON and reads back exactly
    const quoted = /path=("(?:[^"\\]|\\.)*")/.exec(line)?.[1] as string;
    expect(JSON.parse(quoted)).toBe(name);
    expect(quoteForLog('/p/ü/.git')).toBe('"/p/ü/.git"');
  });

  it('invisible formatting characters in a logged name are escaped too, so a guest-made name cannot look like another', () => {
    const invisible = ['\u00ad', '\u061c', '\u180e', '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u2060', '\u2061', '\u2062', '\u2063', '\u2064', '\ufeff'];
    for (const c of invisible) {
      const name = `/p/se${c}cret/.envrc`;
      const quoted = quoteForLog(name);
      expect(quoted, `U+${c.charCodeAt(0).toString(16)}`).not.toContain(c);
      expect(quoted).toContain(`\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
      expect(JSON.parse(quoted)).toBe(name);
      expect(LOG_UNSAFE_CHARACTER.test(name)).toBe(true);
    }
    // Ordinary letters of any script stay as they are.
    expect(quoteForLog('/p/日本語/ü/.git')).toBe('"/p/日本語/ü/.git"');
    expect(LOG_UNSAFE_CHARACTER.test('/p/日本語/ü/.git')).toBe(false);
  });
});

describe('one list of edit tools', () => {
  it('the hook command (which may not load @smurg/protocol: it stays tiny) names exactly the protocol\'s edit tools', () => {
    // The tool gate takes the agent lock for these; a permission card shows a diff for these; one list, checked here.
    expect([...HOOK_EDIT_TOOL_NAMES]).toEqual([...EDIT_TOOL_NAMES]);
    for (const name of HOOK_EDIT_TOOL_NAMES) expect(isEditTool(name)).toBe(true);
  });
});
