// The handler check `model-offered` (DESIGN 0.6.0 D4): a model named by `session.create`, `session.model.set`,
// `topic.create`, `topic.agent.set` or `plan.start` must be a value of the list the host's agent offers right now. No
// host allowlist (the owner's decision 4): the agent's own list is the rule. null (or absent) is the host's default and
// always passes.
import { SmurgError, type AgentHostState } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { isStubService } from '../core/stubs.ts';

/** Why `model` is refused with this list, or null when it may be chosen. */
export function modelRefusal(model: string | null | undefined, agent: AgentHostState): SmurgError | null {
  if (model === null || model === undefined) return null;
  // While the list is not known nothing can be checked: refused, and the person tries again in a moment.
  if (!agent.modelsKnown) return new SmurgError('conflict', msg('session.model.notKnown'), { reason: 'models-not-known' });
  if (!agent.models.some((entry) => entry.value === model)) return new SmurgError('bad_request', msg('session.model.notOffered', { model }), { reason: 'model-not-offered' });
  return null;
}

/** [model-offered]: throws the refusal (see modelRefusal). Without the agent runtime nothing is offered. */
export function requireModelOffered(ctx: DaemonContext, model: string | null | undefined): void {
  if (model === null || model === undefined) return;
  const agents = ctx.services.agents;
  const agent: AgentHostState = isStubService(agents) ? { models: [], modelsKnown: false, hostDefault: null, autoMode: 'ok', asksNothing: 'ok' } : agents.hostAgentState();
  const refusal = modelRefusal(model, agent);
  if (refusal !== null) throw refusal;
}
