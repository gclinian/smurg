// What every piece of one conversation column shares: whose conversation it is, who is looking, who the people are,
// how a path in the text opens a file. The value changes only when one of those does, so the memoised rows of a long
// conversation do not render again because an event arrived. A piece that needs something that changes often (a card's
// entity, the session's status) reads it from the store with its own selector.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { rootRefKey, type AgentSession, type FileRef, type InboxItem, type Member, type Role, type RootRef } from '@smurg/protocol';
import { useColumn } from '../../lib/columns/context.tsx';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { selectSession } from '../../lib/stores/sessions.ts';
import { useCapabilities, useCommands, useMember, useStores } from '../../lib/workspace/context.tsx';
import type { MarkdownPaths } from '../markdown/index.ts';
// The one piece of the terminal feature the conversation shares: how a path in agent output is recognised and
// checked (DESIGN §5.5 "the existing path-links logic"). Pure functions; nothing of xterm comes with them.
import { createPathExistence, findPathCandidates, mayAskAbout, pathGateOf, resolveCandidate } from '../agents/path-links.ts';
import { usePeople, type Person } from './people.ts';

export interface ConversationEnv {
  readonly sessionId: string;
  /** Who is looking; null before the first admission. */
  readonly self: Member | null;
  readonly role: Role | null;
  readonly people: readonly Person[];
  /** Display names that are marked when a text names them with "@". */
  readonly mentionNames: readonly string[];
  /** Paths of the session's root in agent text; undefined until the session is known. */
  readonly paths: MarkdownPaths | undefined;
}

const EnvContext = createContext<ConversationEnv | null>(null);

export function useConversationEnv(): ConversationEnv {
  const env = useContext(EnvContext);
  if (!env) throw new Error('useConversationEnv() outside a conversation column');
  return env;
}

/** The agent session a column shows: from the session list, else (an archived topic's) from its own conversation. */
export function useAgentSession(sessionId: string): AgentSession | null {
  const stores = useStores();
  const listed = useStore(stores.sessions, (state) => selectSession(state, sessionId));
  const watched = useStore(stores.conversations, (state) => state.conversations.get(sessionId)?.session ?? null);
  if (listed !== undefined && listed.kind === 'agent') return listed;
  return watched;
}

/**
 * How a path in the text of this conversation becomes a button that opens the file. The text is on the screen of
 * everyone who reads the conversation, and a lookup is a request of THAT reader to the host, so reading must not turn
 * into asking:
 *   - a name the reader's role can never open (path-links.ts mayAskAbout) is not a candidate at all;
 *   - every lookup goes through the connection's gate (path-links.ts pathGateOf), shared with the other conversations
 *     and the terminals of the page: one request at a time until the host has answered one, a few at a time after
 *     that, and a refusal ends the asking for a while. What the lexical rule cannot know (a path through a file, a
 *     hard link, a link that leads to a private file) costs one refused request, not one per mention;
 *   - the Markdown renderer adds a bound per text.
 */
function usePaths(sessionId: string, root: RootRef | null): MarkdownPaths | undefined {
  const stores = useStores();
  const commands = useCommands();
  const { isHost } = useCapabilities();
  const rootKey = root === null ? null : rootRefKey(root);
  return useMemo<MarkdownPaths | undefined>(() => {
    if (root === null) return undefined;
    const viewer = { isHost };
    const gate = pathGateOf(stores.files);
    const existence = createPathExistence({ lookup: () => undefined, stat: (ref) => gate.stat(ref, viewer), now: () => Date.now() });
    /** The file a candidate names, when this reader may ask about it. */
    const askable = (candidate: { readonly path: string }): FileRef | null => {
      const ref = resolveCandidate(root, candidate);
      return ref !== null && mayAskAbout(ref.path, viewer) ? ref : null;
    };
    return {
      find: (text) =>
        findPathCandidates(text)
          .filter((candidate) => askable(candidate) !== null)
          .map((candidate) => ({ start: candidate.start, end: candidate.end, text: candidate.text })),
      async resolve(match) {
        const candidate = findPathCandidates(match.text)[0];
        if (candidate === undefined) return null;
        const ref = askable(candidate);
        if (ref === null || (await existence.check(ref)) !== 'file') return null;
        return {
          label: ref.path,
          open: () => {
            void commands
              .dispatch('openInCodeMode', { root: ref.root, file: ref.path, sessionId, ...(candidate.line === undefined ? {} : { line: candidate.line }) })
              .catch(() => {
                // code mode is not there (a test, a host without it): the path stays a path
              });
          },
        };
      },
    };
    // The root's key says everything about `root`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootKey, sessionId, stores, commands, isHost]);
}

export function ConversationEnvProvider({ sessionId, root, children }: { sessionId: string; root: RootRef | null; children: ReactNode }) {
  const self = useMember();
  const people = usePeople();
  const paths = usePaths(sessionId, root);
  const mentionNames = useMemo(() => people.map((person) => person.displayName), [people]);
  const env = useMemo<ConversationEnv>(
    () => ({ sessionId, self, role: self?.role ?? null, people, mentionNames, paths }),
    [sessionId, self, people, mentionNames, paths],
  );
  return <EnvContext.Provider value={env}>{children}</EnvContext.Provider>;
}

/**
 * Runs a request a control started and keeps what the control needs to show: `busy` while it runs, and the sentence
 * of a failure until the next try. The caller decides what a particular refusal means (`onError` returns true when it
 * handled it).
 */
export function useAction(onError?: (error: unknown) => boolean): { readonly busy: boolean; readonly error: string | null; run(action: () => Promise<unknown>): Promise<boolean>; clear(): void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const handler = useRef(onError);
  handler.current = onError;
  return {
    busy,
    error,
    clear: () => setError(null),
    async run(action) {
      setBusy(true);
      setError(null);
      try {
        await action();
        return true;
      } catch (failure) {
        if (alive.current && handler.current?.(failure) !== true) setError(describeError(failure));
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
  };
}

/** Whether `ref`'s element is on screen inside a column that is shown (no observer: whenever the column is shown). */
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const column = useColumn();
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || !column.visible) {
      setSeen(false);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) setSeen(entry.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, column.visible]);
  return seen;
}

/**
 * The unread inbox items that are about a card, by key: what `inbox.seen` is told once the card is on screen. A
 * suggestion's row is one per author and session, so it is found by its author.
 */
export function inboxKeysOfCard(items: Iterable<InboxItem>, card: { readonly sessionId: string; readonly cardId: string; readonly authorId?: string }): string[] {
  const keys: string[] = [];
  for (const item of items) {
    if (!item.unread || item.sessionId !== card.sessionId) continue;
    const sameCard = item.anchor?.cardId === card.cardId;
    const sameAuthor = item.kind === 'suggestion' && card.authorId !== undefined && item.from?.kind === 'user' && item.from.userId === card.authorId;
    if (sameCard || sameAuthor) keys.push(item.key);
  }
  return keys;
}

/** Tells the inbox that the member has the card on screen (its row is no longer bold). */
export function useMarkSeen(ref: RefObject<Element | null>, card: { readonly sessionId: string; readonly cardId: string; readonly authorId?: string }, open: boolean): boolean {
  const stores = useStores();
  const onScreen = useOnScreen(ref);
  const keys = useStore(
    stores.inbox,
    (state) => (open && onScreen ? inboxKeysOfCard(state.items.values(), card).join('\n') : ''),
  );
  useEffect(() => {
    if (keys !== '') stores.inbox.seen(keys.split('\n'));
  }, [keys, stores]);
  return onScreen;
}

/** What the cards and the composer read of the session: the facts that change rarely (never its status or counters). */
export interface SessionFacts {
  readonly responsibleId: string | null;
  readonly responsibleName: string | null;
  readonly openedById: string;
  readonly openedByName: string;
  readonly purpose: AgentSession['purpose'];
  readonly topicId: string | undefined;
  readonly itemId: string | undefined;
  readonly branch: string | undefined;
  readonly ended: boolean;
}

function factsOf(session: AgentSession | null | undefined): SessionFacts | null {
  if (session === null || session === undefined) return null;
  return {
    responsibleId: session.responsible?.userId ?? null,
    responsibleName: session.responsible?.displayName ?? null,
    openedById: session.openedBy.userId,
    openedByName: session.openedBy.displayName,
    purpose: session.purpose,
    topicId: session.topicId,
    itemId: session.itemId,
    branch: session.branch,
    ended: session.status === 'ended',
  };
}

const sameFacts = (a: SessionFacts | null, b: SessionFacts | null): boolean => a === b || (a !== null && b !== null && (Object.keys(a) as (keyof SessionFacts)[]).every((key) => a[key] === b[key]));

/** The session's slow facts; the same object until one of them changes. Null before the session is known. */
export function useSessionFacts(sessionId: string): SessionFacts | null {
  const stores = useStores();
  const listed = useStore(
    stores.sessions,
    (state) => {
      const session = selectSession(state, sessionId);
      return factsOf(session !== undefined && session.kind === 'agent' ? session : null);
    },
    sameFacts,
  );
  const watched = useStore(stores.conversations, (state) => factsOf(state.conversations.get(sessionId)?.session), sameFacts);
  return listed ?? watched;
}
