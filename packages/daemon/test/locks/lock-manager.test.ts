// LockManager decisions in isolation (SPEC R8 / D14, ARCHITECTURE §7.5): a ManualClock and scheduler make idle and
// TTL behaviour deterministic. The same decisions over the wire are in r8.locks.test.ts.
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, type FileRef } from '@smurg/protocol';
import { silentLogger } from '../../src/core/logger.ts';
import { TypedEventBus } from '../../src/core/bus.ts';
import { LOCK_CAP_REASON, OUTSIDE_ROOT_REASON, agentHeldReason, humanHeldReason } from '../../src/hooks/deny-text.ts';
import { LockManagerImpl } from '../../src/locks/lock-manager.ts';
import { AMY, BOB, RecordingAudit, cleoAgent, editorPrincipal, flushMicrotasks, hostPrincipal, ianAgent, lockHarness, main, worktree } from './support.ts';

const FILE = main('src/app.ts');

describe('human edit lock', () => {
  it('shared human lock with two humans: taken on the first edit, shared, and every agent is refused with both names', () => {
    const { locks, changes } = lockHarness();
    const first = locks.touchHuman(FILE, AMY);
    expect(first).toMatchObject({ ok: true, acquired: true, lock: { kind: 'human', holders: [{ userId: 'dev:amy', displayName: 'Amy' }] } });
    const second = locks.touchHuman(FILE, BOB);
    expect(second).toMatchObject({ ok: true, acquired: false });
    expect(second.ok && second.lock.holders.map((h) => h.displayName)).toEqual(['Amy', 'Bob']);
    expect(changes.map((c) => c.reason)).toEqual(['acquired', 'holder-joined']);
    const refused = locks.requestAgent(ianAgent(FILE));
    expect(refused.granted).toBe(false);
    expect(!refused.granted && refused.reason).toBe(humanHeldReason(['Amy', 'Bob']));
    expect(humanHeldReason(['Amy', 'Bob'])).toBe('This file is being edited by Amy, Bob. Work on other files first, or try again later.');
    expect(!refused.granted && refused.holder).toMatchObject({ kind: 'human' });
  });

  it('refreshes on every edit; the holder drops out after humanLockIdleMs without one, and the lock ends with the last holder', () => {
    const { locks, timers, changes, audit } = lockHarness({ settings: { humanLockIdleMs: 30_000 } });
    locks.touchHuman(FILE, AMY);
    timers.advance(20_000);
    locks.touchHuman(FILE, AMY); // refresh
    timers.advance(20_000);
    expect(locks.get(FILE)).not.toBeNull(); // 20 s after the last edit
    timers.advance(10_000);
    expect(locks.get(FILE)).toBeNull();
    const last = changes.at(-1);
    expect(last).toMatchObject({ lock: null, reason: 'idle', previous: { kind: 'human' } });
    expect(audit.entries.filter((e) => e.action === 'lock.release').at(-1)).toMatchObject({ actor: { kind: 'system' }, detail: { kind: 'human', reason: 'idle' } });
  });

  it('an idle holder leaves a shared lock while the other keeps it', () => {
    const { locks, timers, changes } = lockHarness({ settings: { humanLockIdleMs: 10_000 } });
    locks.touchHuman(FILE, AMY);
    timers.advance(5_000);
    locks.touchHuman(FILE, BOB);
    timers.advance(6_000); // Amy idle for 11 s, Bob for 6 s
    const lock = locks.get(FILE);
    expect(lock?.kind === 'human' && lock.holders.map((h) => h.userId)).toEqual(['dev:bob']);
    expect(changes.at(-1)).toMatchObject({ reason: 'idle', lock: { kind: 'human' } });
    timers.advance(4_000);
    expect(locks.get(FILE)).toBeNull();
  });

  it('the idle release happens by itself, without anybody asking (one timer for the earliest deadline)', () => {
    const { locks, timers, changes } = lockHarness({ settings: { humanLockIdleMs: 2_000 } });
    locks.touchHuman(FILE, AMY);
    expect(timers.pending).toBe(1);
    timers.advance(2_010);
    expect(changes.at(-1)).toMatchObject({ lock: null, reason: 'idle' });
    expect(timers.pending).toBe(0);
  });

  it('setting changed live: a lower humanLockIdleMs releases idle holders at once, a higher one keeps them longer', () => {
    const lowered = lockHarness({ settings: { humanLockIdleMs: 30_000 } });
    lowered.locks.touchHuman(FILE, AMY);
    lowered.timers.advance(10_000);
    lowered.settings.humanLockIdleMs = 5_000;
    lowered.locks.settingsChanged();
    expect(lowered.changes.at(-1)).toMatchObject({ lock: null, reason: 'idle' });

    const raised = lockHarness({ settings: { humanLockIdleMs: 5_000 } });
    raised.locks.touchHuman(FILE, AMY);
    raised.timers.advance(3_000);
    raised.settings.humanLockIdleMs = 60_000;
    raised.locks.settingsChanged();
    raised.timers.advance(10_000);
    expect(raised.locks.get(FILE)).not.toBeNull();
    raised.timers.advance(50_000);
    expect(raised.locks.get(FILE)).toBeNull();
  });

  it('"Let the agent go first": a holder who yields leaves; when the last one does, the lock is gone and agents may edit', () => {
    const { locks, audit, changes } = lockHarness();
    locks.touchHuman(FILE, AMY);
    locks.touchHuman(FILE, BOB);
    locks.leaveHuman(FILE, 'dev:amy', 'yield');
    expect(changes.at(-1)).toMatchObject({ reason: 'holder-left', lock: { holders: [{ userId: 'dev:bob' }] } });
    expect(locks.requestAgent(ianAgent(FILE)).granted).toBe(false);
    locks.leaveHuman(FILE, 'dev:bob', 'closed');
    expect(changes.at(-1)).toMatchObject({ reason: 'released', lock: null });
    expect(audit.entries.filter((e) => e.action === 'lock.release').map((e) => e.detail?.['reason'])).toEqual(['yield', 'closed']);
    expect(locks.requestAgent(ianAgent(FILE)).granted).toBe(true);
  });

  it('continued typing is announced at most every touchPublishIntervalMs', () => {
    const { locks, timers, changes, clock } = lockHarness();
    locks.touchHuman(FILE, AMY);
    for (let i = 0; i < 10; i++) {
      timers.advance(100);
      locks.touchHuman(FILE, AMY);
    }
    expect(changes.map((c) => c.reason)).toEqual(['acquired']);
    timers.advance(2_000);
    locks.touchHuman(FILE, AMY);
    expect(changes.map((c) => c.reason)).toEqual(['acquired', 'touched']);
    const lock = locks.get(FILE);
    expect(lock?.kind === 'human' && lock.holders[0]?.lastActivityAt).toBe(clock.now());
  });

  it('a human edit is refused while an agent holds the file', () => {
    const { locks } = lockHarness();
    locks.requestAgent(ianAgent(FILE));
    expect(locks.touchHuman(FILE, AMY)).toMatchObject({ ok: false, lock: { kind: 'agent', agentName: 'Claude (Ian)' } });
  });

  it('leaveAllHuman / releaseAllForUser drop a kicked member everywhere', () => {
    const { locks } = lockHarness();
    locks.touchHuman(main('a.txt'), AMY);
    locks.touchHuman(main('b.txt'), AMY);
    locks.touchHuman(main('b.txt'), BOB);
    locks.releaseAllForUser('dev:amy');
    expect(locks.get(main('a.txt'))).toBeNull();
    const b = locks.get(main('b.txt'));
    expect(b?.kind === 'human' && b.holders.map((h) => h.userId)).toEqual(['dev:bob']);
  });
});

describe('agent lock', () => {
  it('R8.3 when two agents change the same file at once the later one is blocked — with the holder named', () => {
    const { locks } = lockHarness();
    expect(locks.requestAgent(ianAgent(FILE)).granted).toBe(true);
    const later = locks.requestAgent(cleoAgent(FILE));
    expect(later.granted).toBe(false);
    expect(!later.granted && later.reason).toBe(agentHeldReason('Claude (Ian)'));
    expect(!later.granted && later.holder).toMatchObject({ kind: 'agent', sessionId: 'ses_ian', ownerUserId: 'dev:ian' });
  });

  it('expires after agentLockTimeoutMs (lazily and by its timer), and the same session asking again gets a fresh TTL', () => {
    const { locks, timers, changes, audit, clock } = lockHarness({ settings: { agentLockTimeoutMs: 60_000 } });
    const granted = locks.requestAgent(ianAgent(FILE));
    expect(granted.granted && granted.lock.expiresAt - granted.lock.acquiredAt).toBe(60_000);
    timers.advance(50_000);
    const again = locks.requestAgent(ianAgent(FILE));
    expect(again.granted && again.lock.expiresAt).toBe(clock.now() + 60_000);
    timers.advance(59_000);
    expect(locks.get(FILE)).not.toBeNull();
    timers.advance(1_010);
    expect(changes.at(-1)).toMatchObject({ lock: null, reason: 'expired' });
    expect(audit.entries.at(-1)).toMatchObject({ action: 'lock.release', actor: { kind: 'system' }, detail: { reason: 'expired' } });
  });

  it('R8.2 released by PostToolUse, and — when the owner rejects the permission prompt (no Post event) — by the next UserPromptSubmit, PreToolUse, Stop, SessionEnd or the TTL', () => {
    const post = lockHarness();
    post.locks.requestAgent(ianAgent(FILE));
    post.locks.releaseAgent('ses_ian', FILE);
    expect(post.changes.at(-1)).toMatchObject({ lock: null, reason: 'released' });

    for (const reason of ['prompt', 'stop', 'session-ended'] as const) {
      const h = lockHarness();
      h.locks.requestAgent(ianAgent(FILE));
      h.locks.markAwaitingApproval('ses_ian', FILE); // PermissionRequest: the prompt is on screen
      h.timers.advance(5_000);
      expect(h.locks.get(FILE)?.kind).toBe('agent'); // still held while the owner decides
      h.locks.releaseAllForSession('ses_ian', reason);
      expect(h.locks.get(FILE)).toBeNull();
      expect(h.changes.at(-1)?.reason).toBe(reason === 'session-ended' ? 'session-ended' : 'released');
    }

    const nextPre = lockHarness();
    nextPre.locks.requestAgent(ianAgent(FILE));
    nextPre.locks.markAwaitingApproval('ses_ian', FILE);
    expect(nextPre.locks.requestAgent(ianAgent(main('other.ts'))).granted).toBe(true);
    expect(nextPre.locks.get(FILE)).toBeNull();
    expect(nextPre.locks.list().map((l) => l.file.path)).toEqual(['other.ts']);

    const ttl = lockHarness({ settings: { agentLockTimeoutMs: 60_000 } });
    ttl.locks.requestAgent(ianAgent(FILE));
    ttl.locks.markAwaitingApproval('ses_ian', FILE);
    ttl.timers.advance(60_010);
    expect(ttl.changes.at(-1)).toMatchObject({ lock: null, reason: 'expired' });
  });

  it('releaseAgent only releases the calling session’s lock', () => {
    const { locks } = lockHarness();
    locks.requestAgent(ianAgent(FILE));
    locks.releaseAgent('ses_cleo', FILE);
    locks.releaseAgent('ses_cleo');
    expect(locks.get(FILE)?.kind).toBe('agent');
    locks.releaseAgent('ses_ian');
    expect(locks.get(FILE)).toBeNull();
  });

  it('lock outside the session root refused (and the root itself)', () => {
    const { locks } = lockHarness();
    const wtFile: FileRef = { root: worktree('wt_other'), path: 'src/app.ts' };
    const outside = locks.requestAgent(ianAgent(wtFile));
    expect(outside).toMatchObject({ granted: false, holder: null });
    expect(!outside.granted && outside.reason).toBe(OUTSIDE_ROOT_REASON);
    const fromWorktree = locks.requestAgent(ianAgent(FILE, 'ses_wt', worktree('wt_mine')));
    expect(fromWorktree.granted).toBe(false);
    expect(locks.requestAgent(ianAgent(main(''))).granted).toBe(false);
    expect(locks.list()).toEqual([]);
    const inside = locks.requestAgent(ianAgent({ root: worktree('wt_mine'), path: 'a.ts' }, 'ses_wt', worktree('wt_mine')));
    expect(inside.granted).toBe(true);
  });

  it('lock cap per session: a forged PreToolUse flood holds one file at a time and gets at most 60 grants a minute', () => {
    const { locks, timers } = lockHarness();
    for (let i = 0; i < 60; i++) {
      expect(locks.requestAgent(ianAgent(main(`f${i}.ts`))).granted).toBe(true);
      expect(locks.list()).toHaveLength(1); // the previous one was released
    }
    const capped = locks.requestAgent(ianAgent(main('f60.ts')));
    expect(capped).toMatchObject({ granted: false, holder: null });
    expect(!capped.granted && capped.reason).toBe(LOCK_CAP_REASON);
    expect(locks.list()).toHaveLength(0);
    // Another session is not affected; the capped one gets grants again a minute later.
    expect(locks.requestAgent(cleoAgent(main('f60.ts'))).granted).toBe(true);
    timers.advance(60_000);
    expect(locks.requestAgent(ianAgent(main('f61.ts'))).granted).toBe(true);
  });

  it('settings changed live: the TTL of a held agent lock follows agentLockTimeoutMs', () => {
    const { locks, settings, timers, changes } = lockHarness({ settings: { agentLockTimeoutMs: 600_000 } });
    locks.requestAgent(ianAgent(FILE));
    timers.advance(10_000);
    settings.agentLockTimeoutMs = 5_000;
    locks.settingsChanged();
    expect(locks.get(FILE)).toBeNull();
    expect(changes.at(-1)).toMatchObject({ reason: 'expired' });
  });
});

describe('force release (host)', () => {
  it('force release audited: releases a human or an agent lock; refused for anyone but the host', () => {
    const { locks, audit, changes } = lockHarness();
    locks.requestAgent(ianAgent(FILE));
    let refused: unknown = null;
    try {
      locks.forceRelease(FILE, editorPrincipal());
    } catch (err) {
      refused = err;
    }
    expect(refused).toMatchObject({ code: 'forbidden' });
    expect(locks.get(FILE)).not.toBeNull();
    const released = locks.forceRelease(FILE, hostPrincipal());
    expect(released).toMatchObject({ kind: 'agent', sessionId: 'ses_ian' });
    expect(changes.at(-1)).toMatchObject({ lock: null, reason: 'forced' });
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'lock.force-release',
      outcome: 'ok',
      actor: { kind: 'user', userId: 'dev:host' },
      target: 'main:src/app.ts',
      detail: { kind: 'agent', sessionId: 'ses_ian', holder: 'Claude (Ian)' },
    });
    locks.touchHuman(FILE, AMY);
    expect(locks.forceRelease(FILE, hostPrincipal())).toMatchObject({ kind: 'human' });
    expect(audit.entries.at(-1)).toMatchObject({ action: 'lock.force-release', detail: { kind: 'human', holders: ['Amy'] } });
    expect(locks.forceRelease(FILE, hostPrincipal())).toBeNull();
  });
});

describe('one lock per file, whatever the spelling', () => {
  it('two spellings of one file share a lock (case and Unicode normalisation)', () => {
    const { locks } = lockHarness();
    locks.touchHuman(main('Docs/README.md'), AMY);
    expect(locks.get(main('docs/readme.md'))).toMatchObject({ kind: 'human', file: { path: 'Docs/README.md' } });
    expect(locks.requestAgent(ianAgent(main('DOCS/ReadMe.MD'))).granted).toBe(false);
    // NFD spelling of the same name (é = e + U+0301).
    locks.touchHuman(main('café.txt'), AMY);
    expect(locks.requestAgent(ianAgent(main('café.txt'))).granted).toBe(false);
    // Different files stay independent.
    expect(locks.requestAgent(ianAgent(main('Docs/README.txt'))).granted).toBe(true);
  });

  it('two spellings of one file share a lock (symlink): a lock taken under the alias moves to the file once it is known', async () => {
    const canonical = new Map([['main:link.md', main('README.md')]]);
    const { locks, changes } = lockHarness({ canonicalize: async (ref) => canonical.get(`main:${ref.path}`) ?? ref });
    locks.touchHuman(main('link.md'), AMY);
    await flushMicrotasks();
    expect(locks.get(main('README.md'))).toMatchObject({ kind: 'human', file: { path: 'link.md' } });
    const refused = locks.requestAgent(ianAgent(main('README.md')));
    expect(!refused.granted && refused.reason).toContain('Amy');
    // An agent lock on the target is seen through the alias too.
    locks.leaveHuman(main('link.md'), 'dev:amy', 'closed');
    expect(changes.at(-1)).toMatchObject({ lock: null });
    expect(locks.requestAgent(ianAgent(main('README.md'))).granted).toBe(true);
    expect(locks.touchHuman(main('link.md'), BOB)).toMatchObject({ ok: false, lock: { kind: 'agent' } });
  });

  it('two locks taken under two spellings before they were known to be one file: the earlier one stays', async () => {
    const canonical = new Map([['main:link.md', main('README.md')]]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { locks, changes, timers } = lockHarness({
      canonicalize: async (ref) => {
        if (ref.path === 'link.md') await gate;
        return canonical.get(`main:${ref.path}`) ?? ref;
      },
    });
    locks.touchHuman(main('link.md'), AMY); // resolution still pending
    timers.advance(10);
    expect(locks.requestAgent(ianAgent(main('README.md'))).granted).toBe(true); // not known to be the same file yet
    release();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(locks.get(main('README.md'))).toMatchObject({ kind: 'human' });
    expect(locks.get(main('link.md'))).toMatchObject({ kind: 'human' });
    expect(changes.at(-1)).toMatchObject({ file: { path: 'README.md' }, previous: { kind: 'agent' }, lock: { kind: 'human' }, reason: 'released' });
  });

  it('resolveSpelling() lets a request act on the file a new spelling names', async () => {
    const { locks } = lockHarness({ canonicalize: async (ref) => (ref.path === 'alias.md' ? main('README.md') : ref) });
    locks.touchHuman(main('README.md'), AMY);
    await locks.resolveSpelling(main('alias.md'));
    expect(locks.get(main('alias.md'))).toMatchObject({ kind: 'human' });
  });
});

describe('queries for the coordination MCP tools', () => {
  it('whoIsEditing names the humans or the agent', () => {
    const { locks } = lockHarness();
    expect(locks.whoIsEditing(FILE)).toEqual({ humans: [], agent: null });
    locks.touchHuman(FILE, AMY);
    expect(locks.whoIsEditing(FILE).humans.map((h) => h.displayName)).toEqual(['Amy']);
    locks.leaveHuman(FILE, 'dev:amy', 'closed');
    locks.requestAgent(ianAgent(FILE));
    expect(locks.whoIsEditing(FILE)).toMatchObject({ humans: [], agent: { agentName: 'Claude (Ian)' } });
  });

  it('wait-for-lock: resolves null once the file is free, with the lock at a bounded timeout, or when aborted', async () => {
    const { locks, timers } = lockHarness();
    expect(await locks.waitForRelease(FILE, { timeoutMs: 1_000 })).toBeNull(); // free already
    locks.touchHuman(FILE, AMY);
    const freed = locks.waitForRelease(FILE, { timeoutMs: 10_000 });
    locks.leaveHuman(FILE, 'dev:amy', 'yield');
    expect(await freed).toBeNull();

    locks.requestAgent(ianAgent(FILE));
    const timedOut = locks.waitForRelease(FILE, { timeoutMs: 5_000 });
    timers.advance(5_000);
    expect(await timedOut).toMatchObject({ kind: 'agent' });

    const huge = locks.waitForRelease(FILE, { timeoutMs: 10 * 60_000 }); // capped at 120 s
    timers.advance(59_000); // the agent lock's TTL (60 s) ends first
    expect(await huge).toBeNull();

    locks.touchHuman(FILE, AMY);
    const controller = new AbortController();
    const aborted = locks.waitForRelease(FILE, { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    expect(await aborted).toMatchObject({ kind: 'human' });
  });

  it('stop() answers every pending wait and stops the timer', async () => {
    const { locks, timers } = lockHarness();
    locks.touchHuman(FILE, AMY);
    const waiting = locks.waitForRelease(FILE, { timeoutMs: 60_000 });
    locks.stop();
    expect(await waiting).toMatchObject({ kind: 'human' });
    expect(timers.pending).toBe(0);
  });

  it('list() returns every lock, oldest first', () => {
    const { locks, timers } = lockHarness();
    locks.touchHuman(main('a.txt'), AMY);
    timers.advance(10);
    locks.requestAgent(ianAgent(main('b.txt')));
    expect(locks.list().map((l) => [l.kind, l.file.path])).toEqual([
      ['human', 'a.txt'],
      ['agent', 'b.txt'],
    ]);
    expect(locks.list().every((l) => l.file.root.kind === MAIN_ROOT.kind)).toBe(true);
  });
});

describe('a wall clock that steps', () => {
  it('stepped back an hour, the agent-lock TTL and the human idle timeout still run out on time (they are durations)', () => {
    let wall = 1_760_000_000_000;
    let mono = 5_000;
    const tick = (ms: number): void => {
      wall += ms;
      mono += ms;
    };
    const locks = new LockManagerImpl({
      clock: { now: () => wall, monotonic: () => mono },
      bus: new TypedEventBus(silentLogger),
      audit: new RecordingAudit(),
      log: silentLogger,
      settings: () => ({ humanLockIdleMs: 30_000, agentLockTimeoutMs: 60_000 }),
      timers: { setTimeout: () => () => {} }, // expiry is checked lazily here
    });
    expect(locks.requestAgent(ianAgent(FILE)).granted).toBe(true);
    wall -= 3_600_000; // NTP (or the person) sets the clock back an hour
    tick(59_000);
    expect(locks.get(FILE)?.kind).toBe('agent');
    tick(1_500);
    expect(locks.get(FILE)).toBeNull();
    expect(locks.touchHuman(FILE, AMY).ok).toBe(true);
    wall -= 3_600_000;
    tick(29_000);
    expect(locks.get(FILE)?.kind).toBe('human');
    tick(1_500);
    expect(locks.get(FILE)).toBeNull();
  });
});
