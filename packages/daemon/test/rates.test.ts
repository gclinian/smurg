// Rates (ARCHITECTURE §5.9 "Rates"): per-member token buckets. Counts cap what is stored; rates cap what one member
// can make everyone else's browser and the relay carry. The Router takes one token before the handler of a type
// whose registry entry names a bucket; handlers take `mention` tokens themselves. A refusal is `rate_limited`,
// audited like every refusal and counted against the connection's denial budget.
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_NOTIFY_PER_MINUTE, MESSAGE_REGISTRY, MESSAGE_TYPES, RATE_BUCKETS, RATE_LIMITS_PER_MINUTE, SmurgError } from '@smurg/protocol';
import { ManualClock } from '../src/core/lifecycle.ts';
import { RATE_BUCKET_SIZES, TokenBucketLimiter } from '../src/core/rates.ts';
import { createTestDaemon, type TestClient, type TestDaemon } from '../src/testing/index.ts';
import { createProbe } from './fixtures/probe-module.ts';
import { REQUEST_SAMPLES } from './fixtures/request-samples.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; reason: unknown; bucket: unknown }> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof SmurgError)) throw new Error('expected a SmurgError');
  return { code: error.code, reason: error.detail?.['reason'], bucket: error.detail?.['bucket'] };
}

describe('TokenBucketLimiter', () => {
  it('holds the per-minute size, refuses beyond it, and refills continuously', () => {
    const clock = new ManualClock(1_000_000);
    const rates = new TokenBucketLimiter(clock);
    expect(RATE_BUCKET_SIZES).toEqual({ vote: 30, comment: 10, suggestion: 10, mention: 20, 'agent-notify': 10 });
    expect(RATE_BUCKET_SIZES).toEqual({ ...RATE_LIMITS_PER_MINUTE, 'agent-notify': AGENT_NOTIFY_PER_MINUTE });
    for (let i = 0; i < 10; i++) expect(rates.take('comment', 'dev:amy')).toBe(true);
    expect(rates.take('comment', 'dev:amy')).toBe(false);
    // 10 per minute is one every six seconds.
    clock.advance(5_999);
    expect(rates.take('comment', 'dev:amy')).toBe(false);
    clock.advance(1);
    expect(rates.take('comment', 'dev:amy')).toBe(true);
    expect(rates.take('comment', 'dev:amy')).toBe(false);
    // However long nobody asks, a bucket never holds more than its size.
    clock.advance(3_600_000);
    for (let i = 0; i < 10; i++) expect(rates.take('comment', 'dev:amy')).toBe(true);
    expect(rates.take('comment', 'dev:amy')).toBe(false);
  });

  it('keeps one bucket per name and key', () => {
    const rates = new TokenBucketLimiter(new ManualClock(1));
    for (let i = 0; i < 10; i++) expect(rates.take('comment', 'dev:amy')).toBe(true);
    expect(rates.take('comment', 'dev:amy')).toBe(false);
    expect(rates.take('comment', 'dev:bob')).toBe(true);
    expect(rates.take('suggestion', 'dev:amy')).toBe(true);
    expect(rates.take('agent-notify', 'ses_1')).toBe(true);
  });

  it('takes several tokens at once or none: a refused take leaves the bucket as it was', () => {
    const rates = new TokenBucketLimiter(new ManualClock(1));
    expect(rates.take('mention', 'dev:amy', 15)).toBe(true);
    expect(rates.take('mention', 'dev:amy', 6)).toBe(false);
    expect(rates.take('mention', 'dev:amy', 5)).toBe(true);
    expect(rates.take('mention', 'dev:amy')).toBe(false);
    // More than the bucket can ever hold, nothing, a fraction below zero: refused.
    expect(rates.take('mention', 'dev:bob', 21)).toBe(false);
    expect(rates.take('mention', 'dev:bob', 0)).toBe(false);
    expect(rates.take('mention', 'dev:bob', -1)).toBe(false);
    expect(rates.take('mention', 'dev:bob', Number.NaN)).toBe(false);
    expect(rates.take('mention', 'dev:bob', 20)).toBe(true);
  });

  it('require() throws rate_limited with the bucket; sizes can be set for a test', () => {
    const rates = new TokenBucketLimiter(new ManualClock(1), { vote: 1 });
    rates.require('vote', 'dev:amy');
    let thrown: unknown;
    try {
      rates.require('vote', 'dev:amy');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SmurgError);
    expect(thrown).toMatchObject({ code: 'rate_limited', detail: { reason: 'rate-limited', bucket: 'vote' } });
    expect((thrown as SmurgError).toPayload().message).toBe('You are doing this too often. Wait a moment and try again.');
  });
});

describe('the registry', () => {
  it('names a bucket for exactly these requests', () => {
    const rated = Object.fromEntries(MESSAGE_TYPES.filter((type) => MESSAGE_REGISTRY[type].rate !== null).map((type) => [type, MESSAGE_REGISTRY[type].rate]));
    expect(rated).toEqual({
      'question.vote': 'vote',
      'question.comment': 'comment',
      'suggest.create': 'suggestion',
      'topic.revise': 'suggestion',
      'report.followUp': 'suggestion',
    });
    // `mention` is the handlers' bucket: no type names it.
    expect(RATE_BUCKETS).toEqual(['vote', 'comment', 'suggestion', 'mention']);
    expect(Object.values(rated)).not.toContain('mention');
  });
});

describe('the Router', () => {
  async function start(): Promise<{ probe: ReturnType<typeof createProbe>; eddie: TestClient; rita: TestClient; vera: TestClient }> {
    const probe = createProbe();
    t = await createTestDaemon({ modules: [probe.module] });
    const eddie = await t.connect({ userId: 'dev:eddie', role: 'editor' });
    const rita = await t.connect({ userId: 'dev:rita', role: 'agent' });
    const vera = await t.connect({ userId: 'dev:vera', role: 'viewer' });
    return { probe, eddie, rita, vera };
  }

  it('lets a member vote 30 times a minute; the next vote is rate_limited, never reaches the handler, and is audited', async () => {
    const { probe, eddie, rita } = await start();
    const daemon = t as TestDaemon;
    for (let i = 0; i < 30; i++) expect((await codeOf(eddie.conn.request('question.vote', REQUEST_SAMPLES['question.vote']))).reason).toBe('probe-reached');
    for (let i = 0; i < 3; i++) {
      expect(await codeOf(eddie.conn.request('question.vote', REQUEST_SAMPLES['question.vote']))).toEqual({ code: 'rate_limited', reason: 'rate-limited', bucket: 'vote' });
    }
    expect(probe.count('question.vote', 'dev:eddie')).toBe(30);
    // Another member has a bucket of their own; another bucket of the same member is untouched.
    expect((await codeOf(rita.conn.request('question.vote', REQUEST_SAMPLES['question.vote']))).reason).toBe('probe-reached');
    expect((await codeOf(eddie.conn.request('question.comment', REQUEST_SAMPLES['question.comment']))).reason).toBe('probe-reached');

    await daemon.ctx.audit.flush();
    const denied = (await daemon.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'authz.denied');
    expect(denied).toHaveLength(3);
    for (const entry of denied) {
      expect(entry).toMatchObject({ outcome: 'denied', target: 'question.vote', actor: { kind: 'user', userId: 'dev:eddie' }, detail: { type: 'question.vote', reason: 'rate-limited', bucket: 'vote', role: 'editor' } });
    }

    // Half a minute later half the bucket is back.
    daemon.advanceClock(30_000);
    for (let i = 0; i < 15; i++) expect((await codeOf(eddie.conn.request('question.vote', REQUEST_SAMPLES['question.vote']))).reason).toBe('probe-reached');
    expect((await codeOf(eddie.conn.request('question.vote', REQUEST_SAMPLES['question.vote']))).code).toBe('rate_limited');
  });

  it('suggestions, revisions and follow-ups share one bucket of 10 a minute', async () => {
    const { probe, eddie } = await start();
    const send = (type: 'suggest.create' | 'topic.revise' | 'report.followUp'): Promise<{ code: string; reason: unknown; bucket: unknown }> => codeOf(eddie.conn.request(type, REQUEST_SAMPLES[type] as never));
    for (let i = 0; i < 4; i++) expect((await send('suggest.create')).reason).toBe('probe-reached');
    for (let i = 0; i < 3; i++) expect((await send('topic.revise')).reason).toBe('probe-reached');
    for (let i = 0; i < 3; i++) expect((await send('report.followUp')).reason).toBe('probe-reached');
    for (const type of ['suggest.create', 'topic.revise', 'report.followUp'] as const) {
      expect(await send(type)).toEqual({ code: 'rate_limited', reason: 'rate-limited', bucket: 'suggestion' });
    }
    expect(probe.count('suggest.create') + probe.count('topic.revise') + probe.count('report.followUp')).toBe(10);
  });

  it('a request the role may not send is refused as forbidden and takes no token', async () => {
    const { probe, vera } = await start();
    const daemon = t as TestDaemon;
    for (let i = 0; i < 12; i++) expect((await codeOf(vera.conn.request('question.comment', REQUEST_SAMPLES['question.comment']))).code).toBe('forbidden');
    expect(probe.count('question.comment')).toBe(0);
    // Had the 12 refusals taken tokens, the bucket (10) would be empty now.
    expect(daemon.ctx.rates.take('comment', 'dev:vera', 10)).toBe(true);
  });

  it('a handler\'s own bucket (mentions) answers rate_limited too, and the refusal is audited with its bucket', async () => {
    const { probe, eddie } = await start();
    const daemon = t as TestDaemon;
    probe.overrides.set('question.comment', (_payload, userId) => {
      daemon.ctx.rates.require('mention', userId, 12);
      return { commentId: 'c_1' };
    });
    expect(await eddie.conn.request('question.comment', REQUEST_SAMPLES['question.comment'])).toEqual({ commentId: 'c_1' });
    expect(await codeOf(eddie.conn.request('question.comment', REQUEST_SAMPLES['question.comment']))).toEqual({ code: 'rate_limited', reason: 'rate-limited', bucket: 'mention' });
    await daemon.ctx.audit.flush();
    const denied = (await daemon.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'authz.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ target: 'question.comment', detail: { type: 'question.comment', reason: 'rate-limited', bucket: 'mention' } });
  });

  it('rate refusals count against the connection like every refusal: a flood ends the logical channel', async () => {
    const probe = createProbe();
    t = await createTestDaemon({ modules: [probe.module], limits: { maxDenialsPerConnPerMinute: 8 } });
    const eddie = await t.connect({ userId: 'dev:eddie', role: 'editor' });
    const firstChannel = eddie.welcome?.channelId;
    const results = await Promise.allSettled(Array.from({ length: 60 }, () => eddie.conn.request('question.comment', REQUEST_SAMPLES['question.comment'])));
    const limited = results.filter((result) => result.status === 'rejected' && (result.reason as { code?: string }).code === 'rate_limited').length;
    expect(probe.count('question.comment')).toBe(10);
    expect(limited).toBeGreaterThanOrEqual(8);
    expect(limited).toBeLessThanOrEqual(9);
    await t.ctx.audit.flush();
    const entries = await t.ctx.audit.query({ limit: 200 });
    expect(entries.some((entry) => entry.action === 'authz.denied' && entry.detail?.['reason'] === 'too-many-denials')).toBe(true);
    await eddie.conn.whenOnline({ timeoutMs: 10_000 });
    expect(eddie.conn.welcome?.channelId).not.toBe(firstChannel);
  });
});
