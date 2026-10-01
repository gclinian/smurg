// The agents panel (SPEC R4, R7 「agent 面板」, goal 2 「所有組員都能即時看到每個 agent 在改什麼」): a tab for EVERY
// session of the workspace — everyone may watch — with who opened it, kind, status and where it runs; the terminal
// (xterm.js, loaded lazily); session creation and ending. Every session runs as the host (protocol v2): the host and
// 可使用 agent open sessions and type into any of them. The focused session (sessions.focus) is shared with the
// suggestions panel below, which shows the composer to editors and the queue of suggestions to those who may type.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionInfo } from '@smurg/protocol';
import { useStore } from '../../lib/store.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import { useCapabilities, useCommandHandler, useCommands, useStores } from '../../lib/workspace/context.tsx';
import { Badge, Banner, Button, EmptyState, Panel, Spinner, Tabs } from '../../ui/index.ts';
import { IconAgent, IconPlus, IconTerminal } from '../../ui/icons.tsx';
import { EndSessionDialog } from './EndSessionDialog.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';
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
  const list = useMemo(() => {
    if (sessionsState.status === 'ready' || sessionsState.sessions.size > 0 || sessionsState.status === 'error') {
      const merged = new Map(sessionsState.sessions);
      if (sessionsState.status !== 'ready') for (const session of lastList.current) if (!merged.has(session.id)) merged.set(session.id, session);
      return orderSessions(merged.values());
    }
    return lastList.current;
  }, [sessionsState]);
  useEffect(() => {
    if (sessionsState.status === 'ready') lastList.current = list;
  }, [sessionsState.status, list]);

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

  // Everyone sees the button; an editor or a viewer is told in the dialog why they cannot open a session.
  const actions = (
    <Button size="sm" variant="ghost" icon={<IconPlus />} onClick={() => setNewOpen(true)}>
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
      <Tabs<string>
        label={t('tabs.label')}
        size="sm"
        className="agents-tabs"
        keepMounted
        value={selectedId ?? ''}
        onChange={(id) => stores.sessions.focus(id)}
        items={list.map((session) => {
          const pending = pendingBySession[session.id] ?? 0;
          return {
            id: session.id,
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
