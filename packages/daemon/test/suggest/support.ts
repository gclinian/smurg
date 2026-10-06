// TEST ONLY: a daemon with the real suggest module (and the real conversation module beside it) over fakes for the
// agent runtime and the rest: the fake runtime knows which agent sessions exist and records every message it is sent
// (AgentSessions.send: the single path of suggestion text to an agent).
import type { AgentSession, SessionInfo } from '@smurg/protocol';
import { buildAgentSession, type Fakes } from '../../src/core/fakes/index.ts';
import type { SuggestionModuleOptions, SuggestionServiceImpl } from '../../src/suggest/suggestion-service.ts';
import type { TestClient, TestDaemon } from '../../src/testing/index.ts';
import { startDaemon, type StackOptions } from '../conversation/support.ts';

/** One accepted suggestion as the agent got it. */
export interface SentSuggestion {
  readonly sessionId: string;
  readonly text: string;
  /** Who accepted it. */
  readonly by: string | null;
  /** Its author, under whose name the agent reads it. */
  readonly author: string | null;
  readonly modified: boolean;
}

export interface SuggestStack {
  readonly t: TestDaemon;
  readonly fakes: Fakes;
  readonly service: SuggestionServiceImpl;
  readonly host: TestClient;
  /** Amy, Agent access; she opened `ses_amy`. */
  readonly amy: TestClient;
  /** Bob, an Editor. */
  readonly bob: TestClient;
}

/** An agent session the (fake) runtime knows, with a fixed id. */
export function agentSession(id: string, ownerUserId: string, ownerName: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return buildAgentSession({ id, openedBy: { userId: ownerUserId, displayName: ownerName }, status: 'idle', ...overrides });
}

/** The sessions every suggest test starts with. */
export function seedSessions(fakes: Fakes, hostUserId: string, hostName: string): void {
  fakes.agents.adopt(agentSession('ses_amy', 'dev:amy', 'Amy'));
  fakes.agents.adopt(agentSession('ses_host', hostUserId, hostName));
}

/** Host, Amy (Agent access, opened ses_amy) and Bob (editor); the sessions `ses_amy` and `ses_host` exist. */
export async function startSuggest(suggest: SuggestionModuleOptions = {}, options: StackOptions = {}): Promise<SuggestStack> {
  const { t, fakes } = await startDaemon({ ...options, suggest, seed: options.seed ?? ((seeded, ctx) => seedSessions(seeded, ctx.members.hostUserId(), 'Host')) });
  const host = await t.connectHost();
  const amy = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'agent' });
  const bob = await t.connect({ userId: 'dev:bob', displayName: 'Bob', role: 'editor' });
  return { t, fakes, service: t.ctx.services.suggestions as SuggestionServiceImpl, host, amy, bob };
}

/** Every accepted suggestion the agent of a session was sent, oldest first. Anything else it was sent fails the test. */
export function sentTo(s: Pick<SuggestStack, 'fakes'>, sessionId: string): SentSuggestion[] {
  return s.fakes.agents.sentTo(sessionId).map((message) => {
    if (message.kind !== 'person' || message.suggestion === undefined) throw new Error('the suggest module sends accepted suggestions only');
    return { sessionId, text: message.text, by: message.suggestion.acceptedBy.userId, author: message.from.userId, modified: message.suggestion.modified };
  });
}

/** Everything any agent was sent. */
export function everythingSent(s: Pick<SuggestStack, 'fakes'>): SentSuggestion[] {
  return (s.fakes.agents.list() as SessionInfo[]).flatMap((session) => sentTo(s, session.id));
}
