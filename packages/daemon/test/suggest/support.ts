// TEST ONLY: a daemon with the real suggest module and a recording stand-in for the session registry and the agent
// runtime: it knows which agent sessions exist and who opened them, and records every message the suggest module
// sends to one (AgentSessions.send: the single path of suggestion text to an agent).
import { SmurgError, type AgentSession, type SessionInfo } from '@smurg/protocol';
import type { FeatureModule } from '../../src/core/context.ts';
import { buildAgentSession, buildTerminalSession } from '../../src/core/fakes/build.ts';
import type { AgentSessions, OutboundMessage, SessionManager, UserTeardown } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';

/** One accepted suggestion as the agent got it. */
export interface PasteCall {
  readonly sessionId: string;
  readonly text: string;
  /** Who accepted it. */
  readonly by: string | null;
  /** Its author, under whose name the agent reads it. */
  readonly author: string | null;
  readonly modified: boolean;
}

/** Only what the suggest module uses; everything else throws. */
export class RecordingSessions {
  readonly sessions = new Map<string, SessionInfo>();
  readonly pastes: PasteCall[] = [];

  add(id: string, ownerUserId: string, ownerName = ownerUserId.slice(ownerUserId.indexOf(':') + 1)): AgentSession {
    const info = buildAgentSession({ id, openedBy: { userId: ownerUserId, displayName: ownerName }, title: `Claude (${ownerName})`, status: 'running', createdAt: Date.now() });
    this.sessions.set(id, info);
    return info;
  }

  addTerminal(id: string, ownerUserId: string): SessionInfo {
    const info = buildTerminalSession({ id, openedBy: { userId: ownerUserId, displayName: ownerUserId.slice(ownerUserId.indexOf(':') + 1) }, createdAt: Date.now() });
    this.sessions.set(id, info);
    return info;
  }

  exit(id: string): SessionInfo {
    const info = this.sessions.get(id);
    if (!info || info.kind !== 'agent') throw new Error('unknown');
    const ended: AgentSession = { ...info, status: 'ended', endedAt: Date.now(), endReason: 'ended' };
    this.sessions.set(id, ended);
    return ended;
  }

  get(sessionId: string): SessionInfo | null {
    return this.sessions.get(sessionId) ?? null;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()];
  }

  /** The core's kick / leave teardown calls these. */
  async teardownUser(): Promise<UserTeardown> {
    return { ended: [], handedOver: [], cleared: [] };
  }
  async stopAll(): Promise<void> {}

  /** AgentSessions.send, as the real runtime answers it: refused once the session ended. */
  async send(sessionId: string, message: OutboundMessage): Promise<{ readonly messageId: string; readonly seq: number }> {
    const info = this.sessions.get(sessionId);
    if (!info || info.kind !== 'agent' || info.status === 'ended') throw new SmurgError('conflict', undefined, { reason: 'ended' });
    if (message.kind !== 'person' || message.suggestion === undefined) throw new Error('the suggest module sends accepted suggestions only');
    this.pastes.push({ sessionId, text: message.text, by: message.suggestion.acceptedBy.userId, author: message.from.userId, modified: message.suggestion.modified });
    return { messageId: `m_${this.pastes.length}`, seq: this.pastes.length };
  }
}

export function recordingSessionsModule(fake: RecordingSessions): FeatureModule {
  return {
    name: 'test-recording-sessions',
    create: () => ({ sessions: fake as unknown as SessionManager, agents: fake as unknown as AgentSessions }),
    register: () => toDisposable(() => {}),
  };
}
