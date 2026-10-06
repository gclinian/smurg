// topic.*, plan.*, report.* handlers (ARCHITECTURE §5.10; the registry's checks in brackets). The Router has checked
// the caller's capability; every check a registry entry names (`topic-open`, `topic-archived`, `plan-pins`,
// `rule-form`, `responsible-eligible`, `report-may-review`, and through ConversationService.sendAs `drive-or-suggest`,
// `suggestion-limit`, `mentions-checked`) is made INSIDE the service, so it holds for every caller of that service,
// not only for this file.
import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import type { PlanServiceImpl } from './plan-service.ts';
import type { ReportServiceImpl } from './report-service.ts';
import type { TopicServiceImpl } from './topic-service.ts';

export function registerTopicHandlers(router: Router, services: { readonly topics: TopicServiceImpl; readonly plans: PlanServiceImpl; readonly reports: ReportServiceImpl }): Disposable {
  const { topics, plans, reports } = services;
  const stack = new DisposableStack();

  // ---- topic.* ----
  // [session.create] the slug is free, the folder does not exist yet
  stack.add(router.handle('topic.create', (payload, req) => topics.create(payload, req.principal)));
  // [session.view] one list-rule page
  stack.add(router.handle('topic.list', (payload) => topics.list(payload)));
  // [session.drive] topic-open
  stack.add(router.handle('topic.rename', async (payload, req) => ({ topic: await topics.rename(payload, req.principal) })));
  // [session.create] unmerged worktrees need `deleteUnmerged`
  stack.add(router.handle('topic.archive', async (payload, req) => ({ topic: await topics.archive(payload, req.principal) })));
  // [admin] topic-archived, no pending merge request
  stack.add(
    router.handle('topic.delete', async (payload, req) => {
      await topics.delete(payload, req.principal);
      return {};
    }),
  );
  // [session.create] topic-open
  stack.add(router.handle('topic.discussion.restart', (payload, req) => topics.restartDiscussion(payload, req.principal)));
  // [suggest.create] topic-open, drive-or-suggest, suggestion-limit, mentions-checked
  stack.add(router.handle('topic.revise', (payload, req) => topics.revise(payload, req.principal)));
  // [session.drive] topic-open
  stack.add(
    router.handle('topic.spec.request', async (payload, req) => {
      await topics.requestSpec(payload, req.principal);
      return {};
    }),
  );
  // [session.drive] topic-open, rule-form
  stack.add(router.handle('topic.rule.add', async (payload, req) => ({ topic: await topics.addRule(payload, req.principal) })));
  stack.add(router.handle('topic.rule.remove', async (payload, req) => ({ topic: await topics.removeRule(payload, req.principal) })));

  // ---- plan.* ----
  // [session.drive] topic-open, a spec exists, the discussion is live
  stack.add(
    router.handle('plan.generate', async (payload, req) => {
      await plans.generate(payload, req.principal);
      return {};
    }),
  );
  // [session.view] null while no plan has parsed
  stack.add(
    router.handle('plan.get', (payload) => {
      if (topics.get(payload.topicId) === null) throw new SmurgError('not_found', msg('topic.notFound'), { reason: 'unknown-topic' });
      return { plan: plans.get(payload.topicId) };
    }),
  );
  stack.add(router.handle('plan.mode.set', async (payload, req) => ({ plan: await plans.setMode(payload, req.principal) })));
  // [session.drive] topic-open, responsible-eligible
  stack.add(router.handle('plan.assign', async (payload, req) => ({ plan: await plans.assign(payload, req.principal) })));
  stack.add(router.handle('plan.suggest', async (payload, req) => ({ plan: await plans.suggest(payload, req.principal) })));
  // [session.create] topic-open
  stack.add(router.handle('plan.preflight', async (payload, req) => ({ preflight: await plans.preflight(payload, req.principal) })));
  // [session.create] topic-open, plan-pins
  stack.add(router.handle('plan.start', async (payload, req) => ({ plan: await plans.start(payload, req.principal) })));
  // [session.view] topic-open
  stack.add(router.handle('plan.changes', (payload, req) => plans.changes(payload, req.principal)));
  stack.add(router.handle('plan.resume', async (payload, req) => ({ plan: await plans.resume(payload, req.principal) })));
  stack.add(router.handle('plan.item.retry', async (payload, req) => ({ plan: await plans.retryItem(payload, req.principal) })));
  stack.add(
    router.handle('plan.item.continue', async (payload, req) => {
      await plans.continueItem(payload, req.principal);
      return {};
    }),
  );
  stack.add(
    router.handle('plan.item.resolve', async (payload, req) => {
      await plans.resolveItem(payload, req.principal);
      return {};
    }),
  );

  // ---- report.* ----
  // [session.view]
  stack.add(
    router.handle('report.get', (payload) => {
      const report = reports.get(payload.topicId, payload.itemId);
      if (report === null) throw new SmurgError('not_found', msg('report.none'), { reason: 'no-report' });
      return { report };
    }),
  );
  // [suggest.create] topic-open, drive-or-suggest, suggestion-limit, mentions-checked
  stack.add(router.handle('report.followUp', (payload, req) => reports.followUp(payload, req.principal)));
  // [discuss] topic-open, report-may-review
  stack.add(router.handle('report.review', async (payload, req) => ({ report: await reports.review(payload, req.principal) })));

  return stack;
}
