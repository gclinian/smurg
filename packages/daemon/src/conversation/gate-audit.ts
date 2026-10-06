// The tool gate's refusals in the audit log (ARCHITECTURE §7.7; DESIGN §3.14 `permission.auto-deny`). An agent that
// keeps trying a tool its session does not have would write one entry per try; the log gets ONE entry per session,
// gate row and minute, with a count. An entry is written when its minute is over, when the session's turn ends, when
// the session ends and when the daemon stops, whichever comes first.
import type { DaemonContext } from '../core/context.ts';
import type { DaemonEvents } from '../core/interfaces.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import { shownToolName } from './permission-card.ts';

export const GATE_AUDIT_WINDOW_MS = 60_000;
/** Tool names one entry lists at most. */
const TOOLS_MAX = 8;
/** Windows held at most (a flood of sessions): beyond it the oldest is written out early. */
const WINDOWS_MAX = 1_000;

interface Window {
  readonly sessionId: string;
  readonly row: string;
  readonly startedAt: number;
  count: number;
  readonly tools: Set<string>;
  path?: string;
}

export class GateAudit {
  private readonly ctx: DaemonContext;
  private readonly windowMs: number;
  private readonly windows = new Map<string, Window>();

  constructor(ctx: DaemonContext, windowMs = GATE_AUDIT_WINDOW_MS) {
    this.ctx = ctx;
    this.windowMs = windowMs;
  }

  /** `agent.tool.gate`: the gate refused a tool call. */
  denied(event: DaemonEvents['agent.tool.gate']): void {
    const now = this.ctx.clock.now();
    const key = `${event.sessionId}\u0000${event.row}`;
    let window = this.windows.get(key);
    if (window !== undefined && now - window.startedAt >= this.windowMs) {
      this.write(key, window);
      window = undefined;
    }
    if (window === undefined) {
      if (this.windows.size >= WINDOWS_MAX) {
        const oldest = this.windows.entries().next().value;
        if (oldest !== undefined) this.write(oldest[0], oldest[1]);
      }
      window = { sessionId: event.sessionId, row: event.row, startedAt: now, count: 0, tools: new Set() };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.tools.size < TOOLS_MAX) window.tools.add(shownToolName(event.tool));
    // A path relative to a root as the gate reports it; never an absolute host path.
    if (window.path === undefined && event.path !== undefined && !event.path.startsWith('/')) window.path = event.path;
  }

  /** Writes the entries whose minute is over (the sweep). */
  flushDue(): void {
    const now = this.ctx.clock.now();
    for (const [key, window] of [...this.windows]) if (now - window.startedAt >= this.windowMs) this.write(key, window);
  }

  /** Writes the entries of one session (its turn or the session ended), or of all (stop). */
  flush(sessionId?: string): void {
    for (const [key, window] of [...this.windows]) if (sessionId === undefined || window.sessionId === sessionId) this.write(key, window);
  }

  private write(key: string, window: Window): void {
    this.windows.delete(key);
    this.ctx.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'permission.auto-deny',
      outcome: 'denied',
      target: window.sessionId,
      detail: { sessionId: window.sessionId, row: window.row, count: window.count, tools: [...window.tools], ...(window.path === undefined ? {} : { path: window.path }) },
    });
  }
}
