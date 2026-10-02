// The agents panel (SPEC R4, R7 「agent 面板」, goal 2 「所有組員都能即時看到每個 agent 在改什麼」): a tab for EVERY
// session of the workspace — everyone may watch — with who opened it, kind, status and where it runs; the terminal
// (xterm.js, loaded lazily); session creation and ending. Every session runs as the host (protocol v2): the host and
// 可使用 agent open sessions and type into any of them. The focused session (sessions.focus) is shared with the
// suggestions panel below, which shows the composer to editors and the queue of suggestions to those who may type.
//
// Closing an ended session's tab (ARCHITECTURE §9): everyone may close the tab of a session that ENDED, in their own
// panel only (closed-sessions.ts: remembered in this browser while the daemon still lists the session; nothing is
// sent, the other members keep the tab). A running session is never closed here: ending it stays the explicit
// 「結束 session」 / 「強制終止」 of those who may.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionInfo } from '@smurg/protocol';
import { useStore } from '../../lib/store.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import { useCapabilities, useCommandHandler, useCommands, useStores } from '../../lib/workspace/context.tsx';
import { Badge, Banner, Button, EmptyState, Panel, Spinner } from '../../ui/index.ts';
import { IconAgent, IconPlus, IconTerminal } from '../../ui/icons.tsx';
import { createClosedSessions } from './closed-sessions.ts';
import { EndSessionDialog } from './EndSessionDialog.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';
import { SessionTabs, type SessionTabsHandle } from './SessionTabs.tsx';
import { SessionView } from './SessionView.tsx';
import { statusLabel, tabLabel } from './session-info.ts';
import { t } from './strings.ts';
import './agents.css';

export type AgentsPanelProps = Record<never, never>;

/** Terminals kept alive for the most recently shown tabs; older ones are released (memory) and re-attach on show. */
export const KEEP_TERMINALS = 6;

/** Tab order: running sessions oldest first (new tabs appear at the end), ended ones after them. */
export function orderSessions(sessions: Iterable<SessionInfo>): SessionInfo[] {
  return [...sessions].sort((a, b) => Number(a.status === 'exited') - Number(b.status === 'exited') || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * The tab shown after the tab of `closingId` is closed: the one already shown when that is another tab, else the
 * neighbour to the right, else the one to the left; null when no tab is left.
 */
export function tabAfterClose(tabs: readonly { readonly id: string }[], closingId: string, selectedId: string | null): string | null {
  const index = tabs.findIndex((tab) => tab.id === closingId);
  if (index < 0 || closingId !== selectedId) return selectedId;
  return (tabs[index + 1] ?? tabs[index - 1])?.id ?? null;
}

export function AgentsPanel(_props: AgentsPanelProps) {
  const stores = useStores();
  const commands = useCommands();
  const caps = useCapabilities();
  const userId = useStore(stores.workspace, selectUserId);
  const sessionsState = useStore(stores.sessions);
  const canCreate = caps.canCreateSession;

  // While a full resync reloads the list, keep showing the last one: the terminals stay mounted and re-attach from
  // their offsets instead of being torn down and repainted from a snapshot.
  const lastList = useRef<SessionInfo[]>([]);
  const known = useMemo(() => {
    if (sessionsState.status === 'ready' || sessionsState.sessions.size > 0 || sessionsState.status === 'error') {
      const merged = new Map(sessionsState.sessions);
      if (sessionsState.status !== 'ready') for (const session of lastList.current) if (!merged.has(session.id)) merged.set(session.id, session);
      return orderSessions(merged.values());
    }
    return lastList.current;
  }, [sessionsState]);
  useEffect(() => {
    if (sessionsState.status === 'ready') lastList.current = known;
  }, [sessionsState.status, known]);

  // The tabs: every session but the ENDED ones whose tab this person closed (a closed id never hides a session that
  // runs). Once the daemon's own list no longer has a closed session as an ended one, its id is forgotten.
  const workspaceId = useStore(stores.workspace, (state) => state.workspace?.id ?? null);
  const closedSessions = useMemo(() => createClosedSessions(workspaceId), [workspaceId]);
  const closed = useStore(closedSessions);
  const list = useMemo(() => known.filter((session) => !(session.status === 'exited' && closed.has(session.id))), [known, closed]);
  useEffect(() => {
    if (sessionsState.status === 'ready') closedSessions.retain({ has: (id) => sessionsState.sessions.get(id)?.status === 'exited' });
  }, [sessionsState.status, sessionsState.sessions, closedSessions]);
  // A closed session that is given the focus afterwards (the focusSession command, another panel) is asked for by
  // name: its tab is shown again. Done as the focus changes, before the next render, so that the render never sees a
  // focused session without a tab (it would hand the focus to the first tab).
  useEffect(() => {
    let previous = stores.sessions.getState().focusedId;
    return stores.sessions.subscribe(() => {
      const focused = stores.sessions.getState().focusedId;
      if (focused === previous) return;
      previous = focused;
      if (focused !== null && closedSessions.getState().has(focused)) closedSessions.reopen(focused);
    });
  }, [stores, closedSessions]);

  // Pending suggestions waiting for a decision this member may make (session.drive: any session), per session.
  const suggestionMap = useStore(stores.suggestions, (state) => state.suggestions);
  const canDecide = caps.canDrive;
  const pendingBySession = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!canDecide) return counts;
    for (const suggestion of suggestionMap.values()) {
      if (suggestion.status !== 'pending' || !sessionsState.sessions.has(suggestion.sessionId)) continue;
      counts[suggestion.sessionId] = (counts[suggestion.sessionId] ?? 0) + 1;
    }
    return counts;
  }, [suggestionMap, sessionsState.sessions, canDecide]);

  const selected = list.find((session) => session.id === sessionsState.focusedId) ?? list[0] ?? null;
  const selectedId = selected?.id ?? null;
  // Nothing focused yet (or the focused session is gone): the shown tab becomes the focused one. Only then — a render
  // that happened before a new focus (a session just created and focused) must not take the focus back.
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    const focused = stores.sessions.getState().focusedId;
    if (selectedId !== null && (focused === null || !listRef.current.some((session) => session.id === focused))) stores.sessions.focus(selectedId);
  }, [selectedId, stores]);

  const [recent, setRecent] = useState<readonly string[]>([]);
  useEffect(() => {
    if (selectedId === null) return;
    setRecent((previous) => (previous[0] === selectedId ? previous : [selectedId, ...previous.filter((id) => id !== selectedId)].slice(0, KEEP_TERMINALS)));
  }, [selectedId]);

  useCommandHandler('focusSession', ({ sessionId }) => {
    stores.sessions.focus(sessionId);
    commands.dispatch('showPanel', { panel: 'agents' }).catch(() => {
      // the layout may not be there (tests, other hosts)
    });
  });

  const [newOpen, setNewOpen] = useState(false);
  const [ending, setEnding] = useState<{ session: SessionInfo; mode: 'end' | 'terminate' } | null>(null);

  const tabsRef = useRef<SessionTabsHandle>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  /** The tab that was just closed: once it is gone, the keyboard focus goes to the tab shown now. */
  const refocusAfter = useRef<string | null>(null);
  const closeTab = (sessionId: string): void => {
    // The session as the store has it NOW: only an ended session's tab is closed, whatever was rendered.
    const session = stores.sessions.getState().sessions.get(sessionId) ?? list.find((candidate) => candidate.id === sessionId);
    if (session?.status !== 'exited') return;
    refocusAfter.current = sessionId;
    // The neighbour first, then the tab goes: the closed session is never the focused one (see the reopening above).
    if (sessionId === selectedId) stores.sessions.focus(tabAfterClose(list, sessionId, selectedId));
    closedSessions.close(sessionId);
  };
  useEffect(() => {
    const closedId = refocusAfter.current;
    if (closedId === null || list.some((session) => session.id === closedId)) return;
    refocusAfter.current = null;
    // The control that was used is gone with the tab. Without any tab left: 「新增 session」.
    if (selectedId === null || tabsRef.current?.focusTab(selectedId) !== true) newButtonRef.current?.focus();
  });

  // Everyone sees the button; an editor or a viewer is told in the dialog why they cannot open a session.
  const actions = (
    <Button ref={newButtonRef} size="sm" variant="ghost" icon={<IconPlus />} onClick={() => setNewOpen(true)}>
      {t('action.new')}
    </Button>
  );

  let body;
  if (list.length === 0) {
    if (sessionsState.status === 'loading' || sessionsState.status === 'idle') {
      body = (
        <div className="agents-empty" role="status">
          <Spinner size={14} decorative />
          <span>{t('loading')}</span>
        </div>
      );
    } else if (sessionsState.status === 'error') {
      body = (
        <Banner tone="warning" live="status">
          {t('loadError', { message: sessionsState.error ?? '' })}
        </Banner>
      );
    } else {
      body = (
        <EmptyState
          compact
          icon={<IconTerminal />}
          title={t('empty.title')}
          description={canCreate ? t('empty.canCreate') : t('empty.cannotCreate')}
          action={
            canCreate ? (
              <Button size="sm" variant="primary" icon={<IconPlus />} onClick={() => setNewOpen(true)}>
                {t('action.new')}
              </Button>
            ) : undefined
          }
        />
      );
    }
  } else {
    body = (
      <SessionTabs
        ref={tabsRef}
        label={t('tabs.label')}
        closeHint={t('tab.closeHint')}
        value={selectedId ?? ''}
        onChange={(id) => stores.sessions.focus(id)}
        onClose={closeTab}
        items={list.map((session) => {
          const pending = pendingBySession[session.id] ?? 0;
          return {
            id: session.id,
            // Only an ended session's tab can be closed.
            ...(session.status === 'exited' ? { closeLabel: t('tab.close', { title: tabLabel(session) }) } : {}),
            label: (
              <span className="agents-tab" data-status={session.status}>
                <span className="agents-tab__dot" aria-hidden="true" />
                <span className="agents-tab__title">{tabLabel(session)}</span>
                <span className="ui-visually-hidden">{statusLabel(session)}</span>
              </span>
            ),
            badge:
              pending > 0 ? (
                <Badge tone="info" title={t('tab.pending', { count: pending })}>
                  {pending}
                </Badge>
              ) : undefined,
            panel: (
              <SessionView
                session={session}
                selfUserId={userId}
                isHost={caps.isHost}
                active={session.id === selectedId}
                keepTerminal={recent.includes(session.id) || session.id === selectedId}
                onEnd={(target) => setEnding({ session: target, mode: 'end' })}
                onTerminate={(target) => setEnding({ session: target, mode: 'terminate' })}
                onClose={(target) => closeTab(target.id)}
              />
            ),
          };
        })}
      />
    );
  }

  return (
    <Panel title={t('title')} icon={<IconAgent />} actions={actions} className="agents-panel">
      {body}
      <NewSessionDialog open={newOpen} onClose={() => setNewOpen(false)} onCreated={(session) => {
        setNewOpen(false);
        stores.sessions.focus(session.id);
      }} />
      <EndSessionDialog session={ending?.session ?? null} mode={ending?.mode ?? 'end'} onClose={() => setEnding(null)} />
    </Panel>
  );
}
