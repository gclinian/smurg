// The handlers of `session.message.send`, `question.*` and `permission.decide` (ARCHITECTURE §5.9; the registry's
// checks in brackets). The Router has checked the capability and taken the rate token of the message type (`vote`,
// `comment`); everything else is the service's: is it an agent session and still open, is the card still open, may
// THIS member submit or decide, which mentions count. A refusal thrown as AuthorizationError is audited by the Router
// (`authz.denied`), once.
import type { DaemonContext } from '../core/context.ts';
import type { Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import type { ConversationServiceImpl } from './conversation-service.ts';

export function registerConversationHandlers(router: Router, _ctx: DaemonContext, service: ConversationServiceImpl): Disposable {
  const stack = new DisposableStack();

  // [session.drive] agent-session, session-open, mentions-checked
  stack.add(router.handle('session.message.send', (payload, req) => service.send(payload, req.principal)));

  // [discuss] question-open
  stack.add(
    router.handle('question.vote', (payload, req) => {
      service.vote(payload, req.principal);
      return {};
    }),
  );
  // [discuss] question-open, mentions-checked
  stack.add(router.handle('question.comment', (payload, req) => service.comment(payload, req.principal)));
  // [discuss] question-open, question-may-submit
  stack.add(router.handle('question.submit', async (payload, req) => ({ question: await service.submit(payload, req.principal) })));
  // [discuss] question-open, question-decider-or-host
  stack.add(
    router.handle('question.remind', (payload, req) => {
      service.remind(payload, req.principal);
      return {};
    }),
  );
  // [discuss] question-decider-or-host (a notify)
  stack.add(router.on('question.seen', (payload, req) => service.seen(payload.questionId, req.principal)));

  // [session.drive] permission-open, permission-may-decide. The caller gets their own copy (the host's has `path`).
  stack.add(router.handle('permission.decide', async (payload, req) => ({ request: await service.decide(payload, req.principal) })));

  return stack;
}
