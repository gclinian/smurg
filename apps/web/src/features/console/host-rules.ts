// "My own Claude Code rules" (DESIGN §2.11 as changed by OWNER-DECISIONS Q7 = B; ARCHITECTURE §5.8
// `admin.hostRules.*`): the allow rules of the host's own Claude Code settings APPLY to agent sessions here, because
// every session runs as the host. smurg takes no decision about them: the host is told once which rules they are.
// `admin.hostRules.get` reads the rules agent sessions last reported; `admin.hostRules.seen` says the list was on
// the host's screen, which is all it takes for the inbox item to leave (no extra click).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResultOf } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { useCan, useConnection, useStores } from '../../lib/workspace/context.tsx';
import { useChangeSignal } from './use-change-signal.ts';

export type HostRule = ResultOf<'admin.hostRules.get'>['rules'][number];
export type HostRuleSource = HostRule['source'];

/** The order the sources are shown in: the host's own file first. */
export const HOST_RULE_SOURCE_ORDER: readonly HostRuleSource[] = ['user', 'project', 'local', 'managed'];

export function groupHostRules(rules: readonly HostRule[]): { readonly source: HostRuleSource; readonly rules: readonly string[] }[] {
  return HOST_RULE_SOURCE_ORDER.map((source) => ({ source, rules: rules.filter((rule) => rule.source === source).map((rule) => rule.rule) })).filter((group) => group.rules.length > 0);
}

export interface HostRulesState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly rules: readonly HostRule[];
  /** The host was shown this list before. */
  readonly seen: boolean;
  readonly error: string | null;
}

export interface HostRulesApi extends HostRulesState {
  reload(): Promise<void>;
  /** The list is on the host's screen: tells the daemon once per list (nothing is sent when it was seen already). */
  markSeen(): void;
}

const IDLE: HostRulesState = Object.freeze({ status: 'idle', rules: [], seen: true, error: null });

/**
 * The host's own rules. Read when mounted (`active`), again when the daemon's `host-rules` inbox item comes or goes
 * (the rules changed) and after a channel that is not a resume. Nothing for anyone but the host.
 */
export function useHostRules(active = true): HostRulesApi {
  const conn = useConnection();
  const stores = useStores();
  const isHost = useCan('admin');
  const [state, setState] = useState<HostRulesState>(IDLE);
  const generation = useStore(stores.workspace, (workspace) => workspace.generation);
  // The daemon's `host-rules` item comes back when the rules changed (null while the inbox has not loaded).
  const waiting = useStore(stores.inbox, (inbox) => (inbox.status === 'ready' ? String([...inbox.items.values()].some((item) => item.kind === 'attention' && item.subject === 'host-rules')) : null));
  const run = useRef(0);
  /** The list `admin.hostRules.seen` was sent for (a new list is told again). */
  const told = useRef<readonly HostRule[] | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++run.current;
    setState((previous) => ({ ...previous, status: previous.status === 'ready' ? 'ready' : 'loading', error: null }));
    try {
      const { rules, seen } = await conn.request('admin.hostRules.get', {});
      if (run.current === mine) setState({ status: 'ready', rules, seen, error: null });
    } catch (failure) {
      if (run.current === mine) setState((previous) => ({ ...previous, status: 'error', error: describeError(failure) }));
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

  useChangeSignal(active && isHost ? waiting : null, () => void reload());

  const { status, rules, seen } = state;
  const markSeen = useCallback((): void => {
    if (status !== 'ready' || seen || rules.length === 0 || told.current === rules) return;
    told.current = rules;
    conn.request('admin.hostRules.seen', {}).then(
      () => setState((previous) => (previous.rules === rules ? { ...previous, seen: true } : previous)),
      () => {
        // Not told: the next time the list is on screen tries again.
        if (told.current === rules) told.current = null;
      },
    );
  }, [conn, status, seen, rules]);

  return { ...state, reload, markSeen };
}
