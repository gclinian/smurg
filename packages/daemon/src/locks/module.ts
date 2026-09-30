// Feature module of src/locks/ (ARCHITECTURE §7.2, §7.5): human and agent file locks (lock.*), presence (presence.*)
// and the activity feed (activity.*) (SPEC R7, R8, R11, D14).
// Slots: `locks` (LockManager), `presence` (PresenceService), `activity` (ActivityFeed).
//
// It is the first module of DEFAULT_FEATURE_MODULES: hooks, files, docs and sessions consult the lock state, and its
// kick / leave listeners drop a member's locks before later modules react to the same event. Nothing here can fail
// at daemon start except opening activity.jsonl (a state-dir problem that stops the daemon anyway).
import { join } from 'node:path';
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import { ActivityLogFile } from './activity-log.ts';
import { ActivityFeedImpl } from './activity.ts';
import { registerLockHandlers, type LockModuleParts } from './handlers.ts';
import { canonicalFileRef } from './keys.ts';
import { LockManagerImpl } from './lock-manager.ts';
import { PresenceServiceImpl } from './presence.ts';

/** The concrete services of each daemon (tests compose several daemons in one process). */
const partsByContext = new WeakMap<DaemonContext, LockModuleParts>();

function partsOf(ctx: DaemonContext): LockModuleParts {
  const parts = partsByContext.get(ctx);
  if (!parts) throw new Error('the locks module was registered without create()');
  return parts;
}

export const locksModule: FeatureModule = {
  name: 'locks',
  create: (ctx) => {
    const log = ctx.log.child({ module: 'locks' });
    const locks = new LockManagerImpl({
      clock: ctx.clock,
      bus: ctx.bus,
      audit: ctx.audit,
      log,
      settings: () => ctx.settings.get(),
      canonicalize: (ref) => canonicalFileRef(ctx, ref),
    });
    const presence = new PresenceServiceImpl({ clock: ctx.clock, log, hub: ctx.hub, members: ctx.members });
    const activity = new ActivityFeedImpl({
      clock: ctx.clock,
      log,
      audit: ctx.audit,
      hub: ctx.hub,
      members: ctx.members,
      locks: () => locks,
      sessions: () => ctx.services.sessions,
      file: new ActivityLogFile(join(ctx.state.dir, 'activity.jsonl'), { log }),
      attributeBashEdits: ctx.config.activity.attributeBashEdits,
    });
    partsByContext.set(ctx, { locks, presence, activity });
    return { locks, presence, activity };
  },
  register: (router, ctx) => registerLockHandlers(router, ctx, partsOf(ctx)),
  start: async (ctx) => {
    await partsOf(ctx).activity.start();
  },
  stop: async (ctx) => {
    const parts = partsByContext.get(ctx);
    if (!parts) return;
    parts.locks.stop();
    parts.presence.stop();
    try {
      await parts.activity.stop();
    } catch (err) {
      ctx.log.error('activity log close failed', { module: 'locks', error: err instanceof Error ? err.name : 'unknown' });
    }
  },
};
