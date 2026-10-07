// Presence (SPEC R7 presence, R11 members online; ARCHITECTURE §5.4): who is here, on how many connections, looking at which
// file, and one entry per running agent session `Claude (<owner>)` with a stable colour. `presence.state` is a full
// snapshot, coalesced: a burst of changes (a reconnect storm, someone clicking through files) becomes one broadcast
// per coalesceMs. Every newly opened interactive connection gets the current snapshot directly, so a client never
// waits for the next change to learn who is here (also after a resume: queued snapshots are not replayed to
// disconnected channels, they would be stale).
import { LIST_MAX_ITEMS, agentSessionName, fileRefKey, isAgentAtWork, type FileRef, type PayloadInputOf, type PresenceAgent, type SessionInfo } from '@smurg/protocol';
import type { ClientConnection, Hub, MemberDirectory, PresenceService, UserId } from '../core/interfaces.ts';
import type { Clock } from '../core/lifecycle.ts';
import type { Logger } from '../core/logger.ts';
import { isReadableOnBothThemes, pickAgentColor } from './colors.ts';
import { isHiddenFromGuests } from './keys.ts';
import { realTimers, type Timers } from './timers.ts';

type PresenceState = PayloadInputOf<'presence.state'>;

/** Default coalescing window of presence.state broadcasts. */
export const PRESENCE_COALESCE_MS = 150;

export interface PresenceDeps {
  readonly clock: Clock;
  readonly log: Logger;
  readonly hub: Pick<Hub, 'broadcast' | 'send' | 'connections'>;
  readonly members: Pick<MemberDirectory, 'list' | 'toMember'>;
  readonly timers?: Timers;
  readonly coalesceMs?: number;
}

interface ActiveFile {
  readonly userId: UserId;
  readonly file: FileRef | null;
  readonly at: number;
}

export class PresenceServiceImpl implements PresenceService {
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly hub: PresenceDeps['hub'];
  private readonly members: PresenceDeps['members'];
  private readonly timers: Timers;
  private readonly coalesceMs: number;
  /** presence.update per interactive connection id. */
  private readonly active = new Map<string, ActiveFile>();
  /** Per connection: the number of the latest presence.update begun (handlers resolve paths asynchronously). */
  private readonly updateTokens = new Map<string, number>();
  private readonly agents = new Map<string, PresenceAgent>();
  private cancelBroadcast: (() => void) | null = null;
  private stopped = false;

  constructor(deps: PresenceDeps) {
    this.clock = deps.clock;
    this.log = deps.log;
    this.hub = deps.hub;
    this.members = deps.members;
    this.timers = deps.timers ?? realTimers;
    this.coalesceMs = deps.coalesceMs ?? PRESENCE_COALESCE_MS;
  }

  snapshot(): PresenceState {
    const members = this.members.list().slice(0, LIST_MAX_ITEMS).map((record) => {
      const connections = this.hub.connections({ userId: record.userId, purpose: 'interactive' });
      const activeFile = this.activeFileOf(record.userId, connections);
      return { ...this.members.toMember(record), connections: connections.length, ...(activeFile ? { activeFile } : {}) };
    });
    const agents = [...this.agents.values()].slice(0, LIST_MAX_ITEMS).map((agent) => ({ ...agent }));
    return { members, agents };
  }

  /** presence.update (the handler ran the file through PathGuard). A hidden path is never announced. */
  update(conn: ClientConnection, activeFile: FileRef | null): void {
    if (conn.purpose !== 'interactive' || !conn.isOpen) return;
    const file = activeFile !== null && !isHiddenFromGuests(activeFile) ? { root: activeFile.root, path: activeFile.path } : null;
    const previous = this.active.get(conn.id);
    this.active.set(conn.id, { userId: conn.userId, file, at: this.clock.now() });
    if (!sameFile(previous?.file ?? null, file)) this.changed();
  }

  /**
   * presence.update handlers await PathGuard, so two updates of one connection can finish out of order: take a token
   * before resolving and apply with updateIfLatest(), which drops a result an update begun later has superseded.
   */
  beginUpdate(conn: ClientConnection): number {
    const token = (this.updateTokens.get(conn.id) ?? 0) + 1;
    this.updateTokens.set(conn.id, token);
    return token;
  }

  updateIfLatest(conn: ClientConnection, token: number, activeFile: FileRef | null): void {
    if (this.updateTokens.get(conn.id) !== token) return;
    this.update(conn, activeFile);
  }

  /** Adds or updates an agent. Without `activeFile` the agent keeps the file it had. */
  setAgent(agent: PresenceAgent): void {
    this.putAgent(agent, agent.activeFile);
  }

  removeAgent(sessionId: string): void {
    if (this.agents.delete(sessionId)) this.changed();
  }

  /** The colour an agent session is shown in, or null (e.g. for DocService.setAgentPresence). */
  agentColor(sessionId: string): string | null {
    return this.agents.get(sessionId)?.color ?? null;
  }

  /**
   * session.created / session.updated: an agent session appears under its name (`agentSessionName`: the same name its
   * caret has in a document) for as long as it lives. Its current file is the file of the turn that runs: when the
   * session is no longer at work (the turn ended, it stalled or failed) the file goes, and the next turn starts
   * without one.
   */
  sessionChanged(session: SessionInfo): void {
    if (session.kind !== 'agent') return;
    if (session.status === 'ended') {
      this.removeAgent(session.id);
      return;
    }
    const existing = this.agents.get(session.id);
    this.putAgent(
      {
        sessionId: session.id,
        ownerUserId: session.openedBy.userId,
        displayName: agentSessionName(session),
        color: existing?.color ?? pickAgentColor(session.id, this.colorsInUse(session.id)),
        status: session.status,
      },
      isAgentAtWork(session.status) ? undefined : null,
    );
  }

  /** The agent's current file (its last granted PreToolUse); null clears it. Not set for an agent that is not at work. */
  setAgentActiveFile(sessionId: string, file: FileRef | null): void {
    const agent = this.agents.get(sessionId);
    if (agent) this.putAgent(agent, file !== null && !isAgentAtWork(agent.status) ? null : file);
  }

  connectionOpened(conn: ClientConnection): void {
    if (conn.purpose !== 'interactive') return;
    try {
      this.hub.send(conn, 'presence.state', this.snapshot());
    } catch (err) {
      this.log.error('presence snapshot failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
    this.changed();
  }

  connectionClosed(conn: ClientConnection): void {
    this.active.delete(conn.id);
    this.updateTokens.delete(conn.id);
    if (conn.purpose === 'interactive') this.changed();
  }

  /** Something presence shows changed: one broadcast after the coalescing window. */
  changed(): void {
    if (this.stopped || this.cancelBroadcast !== null) return;
    this.cancelBroadcast = this.timers.setTimeout(() => {
      this.cancelBroadcast = null;
      this.broadcastNow();
    }, this.coalesceMs);
  }

  stop(): void {
    this.stopped = true;
    this.cancelBroadcast?.();
    this.cancelBroadcast = null;
  }

  /** `activeFile`: undefined keeps the current one, null clears it. */
  private putAgent(agent: PresenceAgent, activeFile: FileRef | null | undefined): void {
    const existing = this.agents.get(agent.sessionId);
    // Stable: an agent keeps the colour it got first; an unreadable one is replaced by a palette colour.
    const color = existing?.color ?? (isReadableOnBothThemes(agent.color) ? agent.color : pickAgentColor(agent.sessionId, this.colorsInUse(agent.sessionId)));
    const file = activeFile === undefined ? (existing?.activeFile ?? null) : activeFile;
    const next: PresenceAgent = {
      sessionId: agent.sessionId,
      ownerUserId: agent.ownerUserId,
      displayName: agent.displayName,
      color,
      status: agent.status,
      ...(file !== null && !isHiddenFromGuests(file) ? { activeFile: { root: file.root, path: file.path } } : {}),
    };
    this.agents.set(agent.sessionId, next);
    if (!existing || JSON.stringify(existing) !== JSON.stringify(next)) this.changed();
  }

  private broadcastNow(): void {
    if (this.stopped) return;
    try {
      // Only to connected channels: a snapshot queued for a disconnected one would be stale when it resumes, and
      // connectionOpened() sends a fresh one then.
      this.hub.broadcast('presence.state', this.snapshot(), { filter: (recipient) => recipient.conn !== null });
    } catch (err) {
      this.log.error('presence broadcast failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  /** The most recent non-null file among the user's open interactive connections. */
  private activeFileOf(userId: UserId, connections: readonly ClientConnection[]): FileRef | null {
    let best: ActiveFile | null = null;
    for (const conn of connections) {
      const entry = this.active.get(conn.id);
      if (!entry || entry.userId !== userId || entry.file === null) continue;
      if (best === null || entry.at >= best.at) best = entry;
    }
    return best?.file ?? null;
  }

  private colorsInUse(exceptSessionId: string): Set<string> {
    const used = new Set<string>();
    for (const member of this.members.list()) used.add(member.color.toLowerCase());
    for (const agent of this.agents.values()) if (agent.sessionId !== exceptSessionId) used.add(agent.color.toLowerCase());
    return used;
  }
}

function sameFile(a: FileRef | null, b: FileRef | null): boolean {
  if (a === null || b === null) return a === b;
  return fileRefKey(a) === fileRefKey(b);
}
