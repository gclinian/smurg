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
import { AutoMerger } from './auto-merge.ts';
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
  readonly merger: AutoMerger;
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
      // The merge queue (DESIGN 0.7.0 D8): smurg merges the work items that are in order.
      const merger = new AutoMerger(ctx, core);
      scheduler.attach(reports);
      plans.attach(reports);
      plans.attachMerger(merger);
      reports.attachMerger(merger);
      core.requestSchedule = () => scheduler.request();
      // "I've checked the result" finishes the topic's merged items at once (DESIGN 0.7.0 D13).
      topics.attachFinish(() => scheduler.finishPending());
      built.set(ctx, { core, topics, plans, reports, scheduler, merger });
      return { topics, plans, reports };
    },
    register: (router, ctx) => {
      const parts = built.get(ctx);
      if (!parts) return toDisposable(() => {});
      const { core, topics, plans, reports, scheduler, merger } = parts;
      const stack = new DisposableStack();
      /** The status each item session last had, as the merge queue was told. */
      const itemStatuses = new Map<string, string>();
      stack.add(registerTopicHandlers(router, { topics, plans, reports }));
      const log = (what: string) => (err: unknown) => ctx.log.error(what, { module: 'topics', error: err instanceof Error ? err.name : 'unknown' });

      // ---- the two files of a topic ----
      stack.add(ctx.bus.on('activity.recorded', (event) => topics.onActivity(event.entry)));
      stack.add(
        ctx.bus.on('file.changed', (event) => {
          if (rootRefKey(event.root) !== rootRefKey(MAIN_ROOT)) return;
          for (const change of event.changes) topics.onFileChanged({ root: event.root, path: change.path });
          // A file in the way of a merge may have been moved or committed (the merge queue looks again, D8).
          if (core.started) merger.onFiles(event.root, event.changes.map((change) => change.path));
        }),
      );
      // Typing in the editor: every save is a hand edit of whoever typed (the feed's entry is one per person and minute).
      stack.add(ctx.bus.on('doc.human-edit', (event) => topics.onHumanEdit(event)));
      stack.add(ctx.bus.on('doc.saved', (event) => topics.onDocSaved(event)));
      stack.add(ctx.bus.on('agent.tool.pre', (event) => topics.onToolPre(event)));

      // ---- sessions ----
      stack.add(
        ctx.bus.on('agent.turn.started', (event) => {
          // (in hand from its start: the plan never reads the item as idle between the turn's end and its handling)
          if (!ctx.stopping.aborted) reports.onTurnStarted(event);
          scheduler.onTurnStarted(event.sessionId);
        }),
      );
      stack.add(
        ctx.bus.on('agent.turn.finished', (event: DaemonEvents['agent.turn.finished']) => {
          // The host's smurg is stopping: the agent runtime (which stops after this module) ends every running turn as
          // `interrupted`. That is not a person's stop and nothing may be decided from it now: what the turn left is
          // looked at when smurg starts again (Scheduler.noteStop marked it; afterRestart: `stalled` by `restart`, or the
          // version held for its carers).
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
          // An item's session became idle, or its card closed: its merge may be in order now (a change of its status;
          // every event of a turn moves the session too).
          if (core.started && event.session.kind === 'agent' && event.session.purpose === 'item' && itemStatuses.get(event.session.id) !== event.session.status) {
            itemStatuses.set(event.session.id, event.session.status);
            merger.request();
          }
        }),
      );
      stack.add(
        ctx.bus.on('session.exited', (event) => {
          reports.onSessionExited(event.session.id);
          topics.onSession(event.session, true);
          scheduler.onSessionExited(event.session, event.reason);
          itemStatuses.delete(event.session.id);
          if (core.started) merger.request();
        }),
      );
      stack.add(ctx.bus.on('agent.process', (event) => scheduler.onProcess(event)));
      // The account works again: what a usage limit stopped is continued (DESIGN 0.7.0 D15).
      stack.add(ctx.bus.on('account.changed', (event) => event.account.state === 'ok' && scheduler.onAccount()));

      // ---- what a plan waits for ----
      stack.add(
        ctx.bus.on('merge.changed', (event) => {
          scheduler.onMerge(event.request);
          // An undo this module did not make itself (one a crash had cut short, recorded by the worktree module).
          if (event.request.undone !== undefined) plans.onUndone(event.request);
          merger.onMerge(event.request);
          if (core.started) merger.request();
        }),
      );
      stack.add(
        ctx.bus.on('worktree.changed', (event) => {
          if (event.worktree === null) scheduler.onWorktreeRemoved(event.worktreeId);
        }),
      );
      // The folder became a git repository while it is shared, or stopped being one (the worktree module looked).
      stack.add(
        ctx.bus.on('workspace.git', (event) => {
          core.setVersioned(event.isGitRepo);
          if (core.started) merger.onGit();
        }),
      );
      // (a card that closed may be the one an item's merge waited for)
      stack.add(
        ctx.bus.on('question.changed', () => {
          if (!core.started) return;
          core.publishAll();
          merger.request();
        }),
      );
      stack.add(
        ctx.bus.on('permission.changed', () => {
          if (!core.started) return;
          core.publishAll();
          merger.request();
        }),
      );
      stack.add(ctx.bus.on('suggestion.changed', (event) => reports.onSuggestion(event.suggestion)));
      // A plan paused or continued, a topic archived: the merge queue looks again.
      stack.add(ctx.bus.on('topic.changed', () => core.started && merger.request()));
      // Someone stopped typing in a file a merge waits for.
      stack.add(ctx.bus.on('lock.changed', (event) => core.started && merger.onLock(event.file, event.lock)));
      stack.add(
        ctx.bus.on('settings.changed', (event) => {
          if (!core.started) return;
          // DESIGN 0.7.0 D3: the workspace's merging setting turned to the host's: every started item is the host's for
          // good; either way every plan says it again and the merge queue looks.
          if (event.settings.merging !== event.previous.merging) {
            merger.settingSaysHost('setting');
            core.publishAll();
            merger.request();
          }
          if (event.settings.maxLiveAgents === event.previous.maxLiveAgents) return;
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
      const { core, reports, scheduler, merger } = parts;
      await core.open();
      // DESIGN 0.7.0 D3: while the workspace says the host merges, no pin says smurg's (a crash between state.json and
      // topics.json when the setting turned is repaired here).
      merger.settingSaysHost('start');
      // (Set, not announced: every topic is announced below, once the restart is looked at.) What the share found at
      // `.git`, with no git process: asking the worktree module (`mainState`) would look for the git program when the
      // folder has no `.git`, and DESIGN 0.6.0 D14 looks for it lazily, never at the start of sharing (on a Mac
      // without the Command Line Tools, /usr/bin/git puts an install prompt on the host's screen). `workspace.git`
      // keeps it current afterwards.
      core.versioned = ctx.workspace.info.isGitRepo;
      // What a crash between two records left out of step (a merge the item never heard of, a session no item names).
      await scheduler.reconcile();
      // An undo the worktree module recorded after a crash, whose items here still say they are merged (DESIGN 0.7.0 D14).
      await parts.plans.reconcileUndone();
      // After a restart of the host's smurg: interrupted items are stalled, the pause a person pressed stays, what is armed
      // is checked; nothing goes on before `goOn` (DESIGN 0.7.0 D15).
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
    },
    // DESIGN 0.7.0 D15 (R-SAFE S16): what goes on by itself begins only now, once `smurg host` has said what it is.
    goOn: async (ctx) => {
      const parts = built.get(ctx);
      if (!parts || !parts.core.started) return;
      const { scheduler, merger } = parts;
      // The interrupted items are told to continue, and the scheduler starts what is armed.
      await scheduler.goOn();
      // Items whose agent was bringing their work up to date when smurg stopped (D8), then the merge queue.
      await merger.takeUp();
      merger.begin();
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
        // The later turns of items with a version that the stop is about to cut (0.7.0 review): looked at after the start.
        parts.scheduler.noteStop();
        await parts.core.flush();
      } catch (err) {
        ctx.log.error('topics stop failed', { module: 'topics', error: err instanceof Error ? err.name : 'unknown' });
      }
    },
  };
}

export const topicsModule: FeatureModule = createTopicsModule();
