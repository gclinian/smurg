// The trust gate for project-level Claude Code settings as the host sees it (DESIGN §2.9, ARCHITECTURE §5.8
// `admin.claudeConfig.*`): the pure part (what a root's files do, what needs a tick, what a decision sends) and the
// hook that reads `admin.claudeConfig.get` and sends `admin.claudeConfig.decide`.
//
// What is trusted is a file CONTENT (path + hash). A decision names the hashes that were on screen: the daemon
// refuses it when a file changed meanwhile (`claudeConfig.changed`), and the list is then read again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { collectPages, rootRefKey, type ClaudeConfigFile, type ResultOf, type RootRef } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { useCan, useConnection, useStores } from '../../lib/workspace/context.tsx';
import { useChangeSignal } from './use-change-signal.ts';

export type ClaudeConfigRoot = ResultOf<'admin.claudeConfig.get'>['roots'][number];
export type ClaudeConfigAck = ClaudeConfigFile['needsAck'][number];
export type ClaudeConfigDecision = 'trust' | 'ignore';

/** The order the ticks are shown in. */
export const ACK_ORDER: readonly ClaudeConfigAck[] = ['credentials', 'allows-tools'];

/** How one file stands: decided for this content, changed since a decision about another content, or never decided. */
export type FileStanding = 'trusted' | 'ignored' | 'changed' | 'new';

export function fileStanding(file: Pick<ClaudeConfigFile, 'decision' | 'changed'>): FileStanding {
  if (file.decision === 'trust') return 'trusted';
  if (file.decision === 'ignore') return 'ignored';
  return file.changed ? 'changed' : 'new';
}

/** A root has something the host has not decided (a new file, or a content that changed after a decision). */
export function needsDecision(root: ClaudeConfigRoot): boolean {
  return root.files.some((file) => file.decision === null);
}

/** The ticks "Use them" needs for this root: every group one of its files asks for, in the fixed order. */
export function acksNeeded(root: ClaudeConfigRoot): ClaudeConfigAck[] {
  const needed = new Set(root.files.flatMap((file) => file.needsAck));
  return ACK_ORDER.filter((ack) => needed.has(ack));
}

/** "Use them" is possible: there is a file, and every needed tick is set. */
export function canTrust(root: ClaudeConfigRoot, ticked: ReadonlySet<ClaudeConfigAck>): boolean {
  return root.files.length > 0 && acksNeeded(root).every((ack) => ticked.has(ack));
}

/**
 * A decision that is HELD, not sent: a form that contains the review (the New topic dialog) keeps it and sends it
 * with its own submit, before it does what it is for.
 */
export interface ClaudeConfigChoice {
  readonly decision: ClaudeConfigDecision;
  readonly ticked: ReadonlySet<ClaudeConfigAck>;
}

/** What a form starts with: the cautious answer, nothing ticked. */
export const CAUTIOUS_CHOICE: ClaudeConfigChoice = Object.freeze({ decision: 'ignore', ticked: new Set<ClaudeConfigAck>() });

/** Whether a held choice can be sent as it stands: "Run without them" always, "Use them" with every needed tick. */
export function choiceReady(root: ClaudeConfigRoot, choice: ClaudeConfigChoice): boolean {
  return choice.decision === 'ignore' || canTrust(root, choice.ticked);
}

/** The decision about everything of a root that is on screen: its files by path and hash, and the ticks that count. */
export function decidePayload(
  root: ClaudeConfigRoot,
  decision: ClaudeConfigDecision,
  ticked: ReadonlySet<ClaudeConfigAck>,
): { root: RootRef; files: { path: string; hash: string }[]; decision: ClaudeConfigDecision; acknowledged: ClaudeConfigAck[] } {
  return {
    root: root.root,
    files: root.files.map((file) => ({ path: file.path, hash: file.hash })),
    decision,
    acknowledged: decision === 'trust' ? acksNeeded(root).filter((ack) => ticked.has(ack)) : [],
  };
}

/** Undecided roots first, the main workspace before worktrees: what waits for the host is on top. */
export function sortRoots(roots: readonly ClaudeConfigRoot[]): ClaudeConfigRoot[] {
  const rank = (root: ClaudeConfigRoot): number => (needsDecision(root) ? 0 : 2) + (root.root.kind === 'main' ? 0 : 1);
  return [...roots].sort((a, b) => rank(a) - rank(b) || (rootRefKey(a.root) < rootRefKey(b.root) ? -1 : 1));
}

export interface ClaudeConfigState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly roots: readonly ClaudeConfigRoot[];
  /** A sentence for the host when the list could not be read. */
  readonly error: string | null;
}

export interface ClaudeConfigApi extends ClaudeConfigState {
  reload(): Promise<void>;
  /** Sends the decision and reads the list again (also after a refusal: the files changed). Rejects with the refusal. */
  decide(root: ClaudeConfigRoot, decision: ClaudeConfigDecision, ticked: ReadonlySet<ClaudeConfigAck>): Promise<void>;
}

const IDLE: ClaudeConfigState = Object.freeze({ status: 'idle', roots: [], error: null });

/**
 * The host's view of every root's project settings. Read when mounted (`active`), again when the daemon says a
 * trust state moved (the main root's state in `session.host`, the host's `project-settings` inbox items) and after
 * a channel that is not a resume. Does nothing for anyone but the host: the daemon refuses `admin.*` anyway.
 */
export function useClaudeConfig(active = true): ClaudeConfigApi {
  const conn = useConnection();
  const stores = useStores();
  const isHost = useCan('admin');
  const [state, setState] = useState<ClaudeConfigState>(IDLE);
  const generation = useStore(stores.workspace, (workspace) => workspace.generation);
  // What the daemon tells every member about the main folder, and the roots it says wait for the host: when either
  // moves, a file or a decision changed somewhere (null while the store has not loaded: see useChangeSignal).
  const mainState = useStore(stores.host, (host) => (host.status === 'ready' ? (host.host?.mainProjectSettings ?? '') : null));
  const waiting = useStore(stores.inbox, (inbox) =>
    inbox.status === 'ready'
      ? [...inbox.items.values()]
          .filter((item) => item.kind === 'attention' && item.subject === 'project-settings')
          .map((item) => item.key)
          .sort()
          .join('\n')
      : null,
  );
  const run = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++run.current;
    setState((previous) => ({ ...previous, status: previous.status === 'ready' ? 'ready' : 'loading', error: null }));
    try {
      const roots = await collectPages(
        async (after) => {
          const page = await conn.request('admin.claudeConfig.get', after === undefined ? {} : { after });
          return { items: page.roots, hasMore: page.hasMore };
        },
        (root) => rootRefKey(root.root),
      );
      if (run.current === mine) setState({ status: 'ready', roots, error: null });
    } catch (failure) {
      if (run.current === mine) setState((previous) => ({ status: 'error', roots: previous.roots, error: describeError(failure) }));
    }
  }, [conn]);

  useEffect(() => {
    if (!active || !isHost) {
      run.current++;
      setState(IDLE);
      return;
    }
    void reload();
  }, [active, isHost, reload, generation]);

  const enabled = active && isHost;
  useChangeSignal(enabled && mainState !== null && waiting !== null ? `${mainState}\n${waiting}` : null, () => void reload());

  const decide = useCallback(
    async (root: ClaudeConfigRoot, decision: ClaudeConfigDecision, ticked: ReadonlySet<ClaudeConfigAck>): Promise<void> => {
      try {
        await conn.request('admin.claudeConfig.decide', decidePayload(root, decision, ticked));
      } finally {
        // A refusal means the content on screen is not the file's any more: show what is there now.
        await reload();
      }
    },
    [conn, reload],
  );

  return { ...state, reload, decide };
}
