// TEST ONLY: a daemon with the real suggest module and a recording stand-in for the SessionManager: it knows which
// sessions run and who owns them, and records every call of pasteSuggestion (the single function that writes
// suggestion text into a PTY). Real-PTY checks live in r6.pty.test.ts.
import type { SessionInfo } from '@smurg/protocol';
import type { FeatureModule } from '../../src/core/context.ts';
import { AuthorizationError } from '../../src/core/errors.ts';
import type { Principal, SessionManager } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';

export interface PasteCall {
  readonly sessionId: string;
  readonly text: string;
  readonly by: string | null;
}

/** Only what the suggest module uses; everything else throws. */
export class RecordingSessions {
  readonly sessions = new Map<string, SessionInfo>();
  readonly pastes: PasteCall[] = [];

  add(id: string, ownerUserId: string, ownerName = ownerUserId.slice(ownerUserId.indexOf(':') + 1)): SessionInfo {
    const info: SessionInfo = {
      id,
      kind: 'agent',
      ownerUserId,
      ownerName,
      title: `Claude（${ownerName}）`,
      sandboxed: false,
      root: { kind: 'main' },
      status: 'running',
      cols: 80,
      rows: 24,
      createdAt: Date.now(),
      login: 'logged-in',
      attached: 0,
    };
    this.sessions.set(id, info);
    return info;
  }

  exit(id: string): SessionInfo {
    const info = this.sessions.get(id);
    if (!info) throw new Error('unknown');
    const exited: SessionInfo = { ...info, status: 'exited', endedAt: Date.now() };
    this.sessions.set(id, exited);
    return exited;
  }

  get(sessionId: string): SessionInfo | null {
    return this.sessions.get(sessionId) ?? null;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()];
  }

  /** The core's kick / leave teardown calls these. */
  async killAllForUser(): Promise<void> {}
  async removeGuestDir(): Promise<void> {}
  async stopAll(): Promise<void> {}

  /** Like the real one: the owner only, a running session only. */
  pasteSuggestion(sessionId: string, text: string, acceptedBy: Principal): void {
    const info = this.sessions.get(sessionId);
    if (!info || info.status === 'exited') throw new Error('session gone');
    if (acceptedBy.userId !== info.ownerUserId) throw new AuthorizationError(undefined, { reason: 'not-owner:session' });
    this.pastes.push({ sessionId, text, by: acceptedBy.userId });
  }
}

export function recordingSessionsModule(fake: RecordingSessions): FeatureModule {
  return {
    name: 'test-recording-sessions',
    create: () => ({ sessions: fake as unknown as SessionManager }),
    register: () => toDisposable(() => {}),
  };
}
