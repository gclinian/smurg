// Who is in a document, from its awareness states (SPEC R7, presence): people AND agents appear as participants with a
// name, a colour and a cursor; an agent is named "Claude (Ian)" by the daemon. Every `user` field is written by the
// daemon (a peer cannot choose its name), but names still end up in generated CSS and in the DOM, so they are treated
// as untrusted text: escaped in CSS (lib/presence-css.ts), rendered as React text (never HTML).
import { compareText } from '../../lib/format.ts';
import { presenceCss, safeColor } from '../../lib/presence-css.ts';

export interface Participant {
  readonly clientId: number;
  readonly name: string;
  readonly color: string;
  readonly kind: 'human' | 'agent';
  readonly userId: string | null;
  /** Has a cursor in the text. */
  readonly hasCursor: boolean;
}

interface RawUser {
  readonly name?: unknown;
  readonly color?: unknown;
  readonly kind?: unknown;
  readonly userId?: unknown;
}

type AwarenessStates = ReadonlyMap<number, Readonly<Record<string, unknown>> | null | undefined>;

function userOf(state: Readonly<Record<string, unknown>> | null | undefined): RawUser | null {
  const user = state?.['user'];
  return typeof user === 'object' && user !== null ? (user as RawUser) : null;
}

/** Everyone except this client, one entry per awareness client (a person with two tabs appears once). */
export function participantsOf(states: AwarenessStates, selfClientId: number, selfUserId: string | null): Participant[] {
  const byPerson = new Map<string, Participant>();
  for (const [clientId, state] of states) {
    if (clientId === selfClientId || !Number.isSafeInteger(clientId)) continue;
    const user = userOf(state);
    if (!user || typeof user.name !== 'string' || user.name.trim() === '') continue;
    const userId = typeof user.userId === 'string' ? user.userId : null;
    const kind = user.kind === 'agent' ? 'agent' : 'human';
    // My own other tab is not "someone else"; an agent of mine is.
    if (kind === 'human' && userId !== null && userId === selfUserId) continue;
    const selection = state?.['selection'];
    const participant: Participant = {
      clientId,
      name: user.name,
      color: safeColor(user.color),
      kind,
      userId,
      hasCursor: typeof selection === 'object' && selection !== null,
    };
    const key = kind === 'agent' ? `agent:${clientId}` : `human:${userId ?? clientId}`;
    const existing = byPerson.get(key);
    if (!existing || (!existing.hasCursor && participant.hasCursor)) byPerson.set(key, participant);
  }
  return [...byPerson.values()].sort((a, b) => (a.kind === b.kind ? compareText(a.name, b.name) : a.kind === 'agent' ? 1 : -1));
}

/**
 * The stylesheet for y-monaco's remote selections of one document: colours and name labels (lib/presence-css.ts), and
 * agents' carets drawn dashed so "Claude (Ian)" is recognisable without reading the label.
 */
export function editorPresenceCss(states: AwarenessStates, selfClientId: number, changes?: ReadonlyMap<number, number>): string {
  let css = presenceCss(states as ReadonlyMap<number, { readonly user?: RawUser } | null | undefined>, selfClientId, changes);
  for (const [clientId, state] of states) {
    if (clientId === selfClientId || !Number.isSafeInteger(clientId)) continue;
    if (userOf(state)?.kind !== 'agent') continue;
    css += `.yRemoteSelectionHead-${clientId}{border-left-style:dashed}\n`;
  }
  return css;
}
