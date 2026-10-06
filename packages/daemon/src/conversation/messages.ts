// What people send to an agent (ARCHITECTURE §5.9): `session.message.send`, and `sendAs`, the door other modules use
// for a person's text (`topic.revise`, `report.followUp`).
//
// Nothing a person without agent access writes reaches an agent unseen: a member holding `session.drive` sends a
// MESSAGE; anyone else's text becomes a SUGGESTION, which reaches the agent only when a member with agent access
// accepts it. The text that is stored, shown and sent is made here, once, before either exists (`agentText`, or
// `composeRevise` for "Ask the agent to revise"). The runner frames it with the header that names its author.
import { MESSAGE_TEXT_MAX_CHARS, SmurgError, composeRevise, type AgentSession, type Suggestion } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { MessageOrigin, Principal, Req, UserId } from '../core/interfaces.ts';
import { principalCan } from '../core/permissions.ts';
import { keptMentions, storeMentions, takeMentionTokens } from './mentions.ts';
import { actingMember, cleanPersonText, requireOpenSession } from './session-facts.ts';

export interface SendAsInput {
  readonly sessionId: string;
  readonly text: string;
  readonly origin: MessageOrigin;
  readonly mentions?: readonly UserId[];
  readonly target?: 'spec' | 'plan';
  readonly quote?: { readonly heading?: string; readonly text: string };
  readonly topicId?: string;
  readonly itemId?: string;
}

export class Messages {
  private readonly ctx: DaemonContext;

  constructor(ctx: DaemonContext) {
    this.ctx = ctx;
  }

  /** `session.message.send`: an agent session that is not ended, its topic not archived; `session.drive`. */
  async send(input: Req<'session.message.send'>, principal: Principal): Promise<{ readonly messageId: string }> {
    actingMember(this.ctx, principal);
    if (!principalCan(principal, 'session.drive')) throw new AuthorizationError(undefined, { reason: 'capability' });
    const session = requireOpenSession(this.ctx, input.sessionId);
    const text = cleanPersonText(input.text);
    return this.deliver(principal, session, text, input.origin ?? 'composer', input.mentions);
  }

  async sendAs(principal: Principal, input: SendAsInput): Promise<{ readonly messageId: string } | { readonly suggestion: Suggestion }> {
    actingMember(this.ctx, principal);
    const session = requireOpenSession(this.ctx, input.sessionId);
    const text = this.compose(input);
    if (principalCan(principal, 'session.drive')) return this.deliver(principal, session, text, input.origin, input.mentions);
    if (!principalCan(principal, 'suggest.create')) throw new AuthorizationError(undefined, { reason: 'capability' });
    // Not a member with agent access: a suggestion. The suggest module applies the mention rule to it.
    const suggestion = await this.ctx.services.suggestions.create(
      {
        sessionId: session.id,
        text: text.text,
        cleaned: text.cleaned,
        origin: input.origin,
        ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
        ...(input.mentions === undefined ? {} : { mentions: [...input.mentions] }),
      },
      principal,
    );
    return { suggestion };
  }

  /** The ONE text of a `sendAs`: what a card shows is what an accept sends. */
  private compose(input: SendAsInput): { readonly text: string; readonly cleaned: boolean } {
    if (input.target === undefined) return cleanPersonText(input.text);
    const composed = composeRevise({ target: input.target, text: input.text, ...(input.quote === undefined ? {} : { quote: input.quote }) }, MESSAGE_TEXT_MAX_CHARS);
    if (composed.ok) return { text: composed.text, cleaned: composed.cleaned };
    throw new SmurgError(composed.reason === 'blank' ? 'bad_request' : 'too_large', msg('session.text.invalid'), { reason: composed.reason });
  }

  private async deliver(
    principal: Principal,
    session: AgentSession,
    text: { readonly text: string; readonly cleaned: boolean },
    origin: MessageOrigin,
    mentions: readonly UserId[] | undefined,
  ): Promise<{ readonly messageId: string }> {
    const kept = keptMentions(this.ctx, text.text, mentions, principal.userId);
    takeMentionTokens(this.ctx, principal.userId, kept.length);
    const sent = await this.ctx.services.agents.send(session.id, {
      kind: 'person',
      from: principal,
      text: text.text,
      cleaned: text.cleaned,
      origin,
      ...(kept.length === 0 ? {} : { mentions: kept.map((member) => member.userId) }),
    });
    storeMentions(this.ctx, { from: principal, kept, target: { kind: 'session', sessionId: session.id }, anchor: { seq: sent.seq }, text: text.text });
    return { messageId: sent.messageId };
  }
}
