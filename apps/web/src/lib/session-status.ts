// How a session, a work item, a topic's phase and an inbox kind are named and drawn, in one place: the session list,
// a column's header, the plan, the console and the conversation's status bar all say "Waiting for an answer" with the
// same glyph (UX §3.2; DESIGN §5.12 item 8). The words are the web catalogue's (`stores.status.*`, `stores.phase.*`,
// `stores.kind.*`); the shapes are ui/StatusGlyph and ui/KindIcon.
import type { AgentSession, InboxKind, SessionInfo, TopicPhase, WorkItem } from '@smurg/protocol';
import { tStores } from '../strings/stores.ts';
import type { GlyphStatus } from '../ui/StatusGlyph.tsx';
import type { Tone } from '../ui/Feedback.tsx';

const AGENT_GLYPH: Readonly<Record<AgentSession['status'], GlyphStatus>> = {
  starting: 'running',
  running: 'running',
  'waiting-answer': 'question',
  'waiting-permission': 'permission',
  idle: 'idle',
  stalled: 'stalled',
  done: 'done',
  failed: 'failed',
  ended: 'ended',
};

/** The glyph of an agent session. A terminal has no status glyph (the list shows the terminal icon): null. */
export function sessionGlyph(session: SessionInfo): GlyphStatus | null {
  return session.kind === 'agent' ? AGENT_GLYPH[session.status] : null;
}

const ITEM_GLYPH: Readonly<Record<WorkItem['state'], GlyphStatus>> = {
  'not-started': 'todo',
  waiting: 'blocked',
  queued: 'blocked',
  running: 'running',
  stalled: 'stalled',
  done: 'done',
  reviewed: 'done',
  failed: 'failed',
  stopped: 'ended',
};

/** The glyph of a work item that has no session to show (not started, waiting for another item) or whose state says more. */
export function itemGlyph(item: Pick<WorkItem, 'state'>): GlyphStatus {
  return ITEM_GLYPH[item.state];
}

/** "Waiting for an answer": the name of a glyph, in the viewer's language. */
export function statusLabel(status: GlyphStatus): string {
  return tStores(`status.${status}`);
}

/**
 * How urgent a status is for a collapsed topic's one glyph (UX §3.2): failed, waiting for permission, waiting for an
 * answer, stopped without a report, running, idle; the rest never leads.
 */
const URGENCY: readonly GlyphStatus[] = ['failed', 'permission', 'question', 'stalled', 'running', 'idle', 'done', 'blocked', 'todo', 'ended'];
export function mostUrgent(statuses: readonly GlyphStatus[]): GlyphStatus | null {
  let best: GlyphStatus | null = null;
  for (const status of statuses) if (best === null || URGENCY.indexOf(status) < URGENCY.indexOf(best)) best = status;
  return best;
}

/** A person must act (amber): the "Waiting" filter of the session list and a collapsed topic's count. */
export function waitsForPerson(status: GlyphStatus | null): boolean {
  return status === 'question' || status === 'permission' || status === 'stalled' || status === 'failed';
}

/** "Discussing", "Spec", "Plan", "Executing", "Complete". */
export function phaseLabel(phase: TopicPhase): string {
  return tStores(`phase.${phase}`);
}

const PHASE_TONE: Readonly<Record<TopicPhase, Tone>> = { discussing: 'neutral', spec: 'neutral', plan: 'info', executing: 'info', complete: 'success' };
export function phaseTone(phase: TopicPhase): Tone {
  return PHASE_TONE[phase];
}

/** "Permission request": the name of an inbox item's (and a card's) kind. */
export function kindLabel(kind: InboxKind): string {
  return tStores(`kind.${kind}`);
}
