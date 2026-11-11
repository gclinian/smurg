// `sticky.feedback.accept` (DESIGN 0.8.0 D4.6): THE ONLY PLACE where feedback on a sticky note goes to an agent.
//
// A member with `session.drive` accepts a waiting feedback; the daemon then sends ONE message to Claude for the
// sticky notes (the one agent session of purpose `notes` that has not ended), with `ConversationService.send`, as
// the accepting member, origin `composer`: the text of the pure `composeFeedback({ note, author, text })` of
// @smurg/protocol, the same function the notes view shows before the click ("What Claude gets"). So what that
// member accepts is, character for character, what Claude gets, quoted, in their own name (ARCHITECTURE §2 rule 6,
// case d). The entry becomes `accepted` only after that send went through; a second accept of the same entry while
// one is on its way is refused. Creating, rejecting and withdrawing feedback send nothing (feedback.ts); there is no
// other call of the conversation in src/sticky/ (test/sticky/accept.test.ts reads the code to hold that).
import { SmurgError, composeFeedback, type AgentSession, type Feedback, type PayloadOf } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { Principal } from '../core/interfaces.ts';
import { ACCEPTING, NOT_WAITING, type FeedbackService } from './feedback.ts';

export class FeedbackAccept {
  private readonly ctx: DaemonContext;
  private readonly feedback: FeedbackService;
  private readonly assistant: () => AgentSession | null;

  constructor(ctx: DaemonContext, deps: { readonly feedback: FeedbackService; readonly assistant: () => AgentSession | null }) {
    this.ctx = ctx;
    this.feedback = deps.feedback;
    this.assistant = deps.assistant;
  }

  async accept(input: PayloadOf<'sticky.feedback.accept'>, principal: Principal): Promise<Feedback> {
    const entry = this.feedback.require(input.feedbackId);
    // session.drive (the router checked it when the request came; asked again of the member as they are now), and only
    // while the feedback waits, and only once at a time.
    const by = this.feedback.driverOf(principal);
    if (entry.status !== 'waiting') throw NOT_WAITING(entry);
    if (this.feedback.accepting.has(entry.id)) throw ACCEPTING(entry);
    const author = this.feedback.authorForAgent(entry);
    if (author === null) {
      // Its author is no longer a member: their waiting feedback goes with them (D4.5), and nothing is sent.
      this.feedback.withdrawBySystem(entry.id, 'author-removed');
      throw NOT_WAITING({ id: entry.id, status: 'withdrawn' });
    }
    const assistant = this.assistant();
    if (assistant === null) {
      throw new SmurgError('conflict', msg('sticky.feedback.noAssistant'), { reason: 'no-assistant', feedbackId: entry.id });
    }
    const text = composeFeedback({ note: entry.note, author, text: entry.text });
    this.feedback.accepting.add(entry.id);
    try {
      // THE ONE SEND: a message of the accepting member to Claude for the sticky notes that quotes the feedback.
      await this.ctx.services.conversation.send({ sessionId: assistant.id, text, origin: 'composer' }, principal);
    } catch (err) {
      this.feedback.accepting.delete(entry.id);
      if (!(err instanceof AuthorizationError)) {
        this.ctx.audit.record({
          actor: principal.actor,
          action: 'sticky.feedback.accept',
          outcome: 'error',
          target: entry.id,
          detail: { feedbackId: entry.id, note: entry.note, sessionId: assistant.id, reason: err instanceof SmurgError ? String(err.detail?.['reason'] ?? err.code) : 'send-failed' },
        });
      }
      this.feedback.afterFailedAccept(entry.id);
      throw err;
    }
    this.feedback.accepting.delete(entry.id);
    return this.feedback.markAccepted(entry.id, by, principal.actor, assistant.id);
  }
}
