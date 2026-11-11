// sticky.* handlers (ARCHITECTURE §5.12, DESIGN 0.8.0 D2.4, D2.5, D3.5, D4.4, D5; registry checks in brackets). Every
// capability is the router's, checked against the caller's CURRENT role before the handler runs.
import type { Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import { memberAuthorOf } from './feedback.ts';
import type { StickyServiceImpl } from './service.ts';

export function registerStickyHandlers(router: Router, service: StickyServiceImpl): Disposable {
  const stack = new DisposableStack();
  // [file.read]: one list-rule page of the index.
  stack.add(router.handle('sticky.list', (payload) => service.list(payload)));
  // [file.write] path-guard, host-only-paths: through the file service, as the caller.
  stack.add(router.handle('sticky.create', (payload, req) => service.create(payload, req.principal)));
  // [session.create]: the running Claude for the sticky notes, or one started for the caller.
  stack.add(router.handle('sticky.assistant.start', async (_payload, req) => ({ session: await service.startAssistant(req.principal) })));

  // Feedback (D4.4). [feedback.give] (a Viewer too): on a note the index holds; it reaches no agent.
  stack.add(router.handle('sticky.feedback.create', async (payload, req) => ({ feedback: await service.feedback.create(payload, req.principal) })));
  // (author) feedback-author-waiting: the author rule here with req.requireOwner (audited authz.denied), and again in the
  // service. An outside author's feedback has no member who wrote it: nobody withdraws it (a reviewer rejects it).
  stack.add(
    router.handle('sticky.feedback.withdraw', async (payload, req) => {
      const entry = service.feedback.get(payload.feedbackId);
      if (entry !== null) req.requireOwner(memberAuthorOf(entry), 'feedback');
      return { feedback: await service.feedback.withdraw(payload, req.principal) };
    }),
  );
  // [session.drive] feedback-waiting. accept is the only road of feedback to an agent (accept.ts: one message of the
  // accepting member to Claude for the sticky notes); reject sends nothing.
  stack.add(router.handle('sticky.feedback.accept', async (payload, req) => ({ feedback: await service.acceptor.accept(payload, req.principal) })));
  stack.add(router.handle('sticky.feedback.reject', async (payload, req) => ({ feedback: await service.feedback.reject(payload, req.principal) })));
  // [file.read]: one list-rule page of every feedback kept.
  stack.add(router.handle('sticky.feedback.list', (payload) => service.feedback.list(payload)));

  // Build this (D5). [session.create] path-guard: the note and the notes it links to, read as the caller.
  stack.add(router.handle('sticky.spec', (payload, req) => service.builder.spec(payload, req.principal)));
  // [session.create] path-guard, host-only-paths: the topic and its two files, as the caller; it starts nothing.
  stack.add(router.handle('sticky.build', (payload, req) => service.builder.build(payload, req.principal)));
  return stack;
}
