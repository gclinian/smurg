// Feature module of src/topics/ (ARCHITECTURE §7.2, §5.10): topics, their plans and result reports. Slots: `topics`
// (TopicService), `plans` (PlanService), `reports` (ReportService). It talks to sessions only through AgentSessions
// and the bus, to worktrees through WorktreeManager, and to the conversation through ConversationService.
//
// It comes after `worktree`, `sessions`, `conversation` and `suggest` in the module list (start() asks them about
// what a restart left) and stops BEFORE `sessions` (nothing may be started while the sessions go down).
import { rootRefKey, MAIN_ROOT } from '@smurg/protocol';
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import type { DaemonEvents } from '../core/interfaces.ts';
import { DisposableStack, toDisposable } from '../core/lifecycle.ts';
import { isStubService } from '../core/stubs.ts';
import { TopicsCore, type TopicsOptions } from './core.ts';
import { registerTopicHandlers } from './handlers.ts';
import { PlanServiceImpl } from './plan-service.ts';
import { ReportServiceImpl } from './report-service.ts';
import { Scheduler } from './scheduler.ts';
import { reportsDocument, topicsDocument } from './store.ts';
import { TopicServiceImpl } from './topic-service.ts';

export type TopicsModuleOptions = Partial<TopicsOptions>;

interface Parts {
  readonly core: TopicsCore;
  readonly topics: TopicServiceImpl;
  readonly plans: PlanServiceImpl;
  readonly reports: ReportServiceImpl;
  readonly scheduler: Scheduler;
}

/** A topics module with seams (the file debounce, the number of fixes in a row). Production uses topicsModule. */
export function createTopicsModule(options: TopicsModuleOptions = {}): FeatureModule {
  const built = new WeakMap<DaemonContext, Parts>();
  return {
    name: 'topics',
    documents: [topicsDocument, reportsDocument],
    create: (ctx) => {
      const core = new TopicsCore(ctx, options);
      const scheduler = new Scheduler(ctx, core);
      const topics = new TopicServiceImpl(ctx, core);
      const plans = new PlanServiceImpl(ctx, core, topics, scheduler);
      const reports = new ReportServiceImpl(ctx, core, scheduler);
      scheduler.attach(reports);
      plans.attach(reports);
      core.requestSchedule = () => scheduler.request();
      built.set(ctx, { core, topics, plans, reports, scheduler });
      return { topics, plans, reports };
    },
    register: (router, ctx) => {
      const parts = built.get(ctx);
      if (!parts) return toDisposable(() => {});
      const { core, topics, plans, reports, scheduler } = parts;
      const stack = new DisposableStack();
      stack.add(registerTopicHandlers(router, { topics, plans, reports }));
      const log = (what: string) => (err: unknown) => ctx.log.error(what, { module: 'topics', error: err instanceof Error ? err.name : 'unknown' });

      // ---- the two files of a topic ----
      stack.add(ctx.bus.on('activity.recorded', (event) => topics.onActivity(event.entry)));
      stack.add(
        ctx.bus.on('file.changed', (event) => {
          if (rootRefKey(event.root) !== rootRefKey(MAIN_ROOT)) return;
          for (const change of event.changes) topics.onFileChanged({ root: event.root, path: change.path });
        }),
      );
      // Typing in the editor: every save is a hand edit of whoever typed (the feed's entry is one per person and minute).
      stack.add(ctx.bus.on('doc.human-edit', (event) => topics.onHumanEdit(event)));
      stack.add(ctx.bus.on('doc.saved', (event) => topics.onDocSaved(event)));
      stack.add(ctx.bus.on('agent.tool.pre', (event) => topics.onToolPre(event)));

      // ---- sessions ----
      stack.add(ctx.bus.on('agent.turn.started', (event) => scheduler.onTurnStarted(event.sessionId)));
      stack.add(
        ctx.bus.on('agent.turn.finished', (event: DaemonEvents['agent.turn.finished']) => {
          // The host's smurg is stopping: the agent runtime (which stops after this module) ends every running turn as
          // `interrupted`. That is not a person's stop and nothing may be decided from it now: what the turn left is
          // looked at when smurg starts again (Scheduler.afterRestart: `stalled` by `restart`, the plan paused).
          if (!core.started || ctx.stopping.aborted) return;
          const hit = core.bySession(event.sessionId);
          if (hit === null) return;
          if (hit.item === null) void core.serialize(`discussion:${hit.topic.id}`, () => plans.onDiscussionTurn(event)).catch(log('discussion turn not handled'));
          else void reports.onItemTurn(event).catch(log('item turn not handled'));
        }),
      );
      stack.add(
        ctx.bus.on('session.updated', (event) => {
          topics.onSession(event.session, false);
          if (event.session.kind === 'agent' && event.session.purpose === 'discussion' && event.session.status === 'failed' && event.session.topicId !== undefined && core.started && core.generating.delete(event.session.topicId)) {
            core.publish(event.session.topicId);
          }
          scheduler.onSessionUpdated(event.session);
        }),
      );
      stack.add(
        ctx.bus.on('session.exited', (event) => {
          topics.onSession(event.session, true);
          scheduler.onSessionExited(event.session, event.reason);
        }),
      );
      stack.add(ctx.bus.on('agent.process', (event) => scheduler.onProcess(event)));

      // ---- what a plan waits for ----
      stack.add(ctx.bus.on('merge.changed', (event) => scheduler.onMerge(event.request)));
      stack.add(
        ctx.bus.on('worktree.changed', (event) => {
          if (event.worktree === null) scheduler.onWorktreeRemoved(event.worktreeId);
        }),
      );
      stack.add(ctx.bus.on('question.changed', () => core.started && core.publishAll()));
      stack.add(ctx.bus.on('permission.changed', () => core.started && core.publishAll()));
      stack.add(ctx.bus.on('suggestion.changed', (event) => reports.onSuggestion(event.suggestion)));
      stack.add(
        ctx.bus.on('settings.changed', (event) => {
          if (!core.started || event.settings.maxLiveAgents === event.previous.maxLiveAgents) return;
          core.publishAll();
          scheduler.request();
        }),
      );

      // ---- members: who reviews and who is told follows who is there (the teardown itself calls memberRemoved) ----
      const membersChanged = (): void => {
        if (!core.started) return;
        // After the listeners of this event (the member directory and the teardown have then settled).
        setImmediate(() => {
          try {
            reports.refreshReviewers();
            core.publishAll();
            core.publishAttention();
            scheduler.request();
          } catch (err) {
            log('members change not applied')(err);
          }
        });
      };
      for (const name of ['member.joined', 'member.left', 'member.kicked', 'member.role-changed'] as const) stack.add(ctx.bus.on(name, membersChanged));

      stack.add(reports.startSweep());
      stack.defer(() => topics.stop());
      return stack;
    },
    start: async (ctx) => {
      const parts = built.get(ctx);
      if (!parts) return;
      const { core, reports, scheduler } = parts;
      await core.open();
      const worktrees = ctx.services.worktrees;
      if (!isStubService(worktrees)) core.versioned = await worktrees.mainState().then((main) => main.isRepo, () => false);
      // What a crash between two records left out of step (a merge the item never heard of, a session no item names).
      await scheduler.reconcile();
      // After a restart of the host's smurg nothing runs by itself: interrupted items are stalled, plans are paused.
      await scheduler.afterRestart();
      for (const topic of core.topics()) {
        if (topic.archived) {
          core.publish(topic.id);
          continue;
        }
        await core.refreshFiles(topic.id).catch((err: unknown) => ctx.log.error('topic files not read', { module: 'topics', topic: topic.id, error: err instanceof Error ? err.name : 'unknown' }));
      }
      reports.refreshReviewers();
      core.publishAttention();
      // An item that was merged and reviewed when smurg went away, and whose session or worktree is still there.
      await scheduler.finishPending();
      scheduler.request();
    },
    stop: async (ctx) => {
      const parts = built.get(ctx);
      if (!parts) return;
      try {
        parts.topics.stop();
        parts.reports.stopSweep();
        // What is under way (the end of a turn being looked at, an item being finished) writes the records: it ends
        // before they are flushed, so nothing is written after this module has stopped.
        await parts.core.idle();
        await parts.core.flush();
      } catch (err) {
        ctx.log.error('topics stop failed', { module: 'topics', error: err instanceof Error ? err.name : 'unknown' });
      }
    },
  };
}

export const topicsModule: FeatureModule = createTopicsModule();
