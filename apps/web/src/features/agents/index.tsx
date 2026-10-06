// The "Terminal" tab of code mode's drawer (DESIGN §5.6): a tab for every plain terminal of the workspace (an agent
// session is a conversation and has no PTY: it is a column, never a tab here). Everyone may watch; who opened a
// terminal, its status and where it runs are on one line above it; the terminal itself is xterm.js, loaded when one
// is first shown. Every terminal runs as the host: the host and members with agent access open terminals and type
// into any of them.
//
// In the sessions view the same terminal is a column (TerminalColumn.tsx, registered in slots.tsx).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalSession } from '@smurg/protocol';
import { useStore } from '../../lib/store.ts';
import { isTerminalSession } from '../../lib/stores/sessions.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import { useCapabilities, useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, EmptyState, Panel, Spinner, Tabs } from '../../ui/index.ts';
import { IconPlus, IconTerminal } from '../../ui/icons.tsx';
import { AttachDialog } from './AttachDialog.tsx';
import { EndSessionDialog } from './EndSessionDialog.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';
import { statusLabel, tabLabel } from './session-info.ts';
import { t } from './strings.ts';
import { TerminalView } from './TerminalView.tsx';
import './agents.css';

export type TerminalPanelProps = Record<never, never>;

/** Terminals kept alive for the most recently shown tabs; older ones are released (memory) and attach again on show. */
export const KEEP_TERMINALS = 6;

/** Tab order: running terminals oldest first (new tabs appear at the end), ended ones after them. */
export function orderTerminals(sessions: Iterable<TerminalSession>): TerminalSession[] {
  return [...sessions].sort((a, b) => Number(a.status === 'exited') - Number(b.status === 'exited') || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function TerminalPanel(_props: TerminalPanelProps) {
  const stores = useStores();
  const caps = useCapabilities();
  const userId = useStore(stores.workspace, selectUserId);
  const sessionsState = useStore(stores.sessions);
  const canCreate = caps.canCreateSession;

  // While a full resync reloads the list, keep showing the last one: the terminals stay mounted and attach again from
  // their offsets instead of being torn down and repainted from a snapshot.
  const lastList = useRef<TerminalSession[]>([]);
  const list = useMemo(() => {
    if (sessionsState.status === 'ready' || sessionsState.sessions.size > 0 || sessionsState.status === 'error') {
      const merged = new Map<string, TerminalSession>();
      for (const session of sessionsState.sessions.values()) if (isTerminalSession(session)) merged.set(session.id, session);
      if (sessionsState.status !== 'ready') for (const session of lastList.current) if (!merged.has(session.id)) merged.set(session.id, session);
      return orderTerminals(merged.values());
    }
    return lastList.current;
  }, [sessionsState]);
  useEffect(() => {
    if (sessionsState.status === 'ready') lastList.current = list;
  }, [sessionsState.status, list]);

  const [chosen, setChosen] = useState<string | null>(null);
  const selected = list.find((session) => session.id === chosen) ?? list[0] ?? null;
  const selectedId = selected?.id ?? null;

  const [recent, setRecent] = useState<readonly string[]>([]);
  useEffect(() => {
    if (selectedId === null) return;
    setRecent((previous) => (previous[0] === selectedId ? previous : [selectedId, ...previous.filter((id) => id !== selectedId)].slice(0, KEEP_TERMINALS)));
  }, [selectedId]);

  const [newOpen, setNewOpen] = useState(false);
  const [ending, setEnding] = useState<{ session: TerminalSession; mode: 'end' | 'terminate' } | null>(null);
  const [attaching, setAttaching] = useState<TerminalSession | null>(null);

  // Everyone sees the button; an editor or a viewer is told in the dialog why they cannot open a terminal.
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
      <Tabs
        label={t('tabs.label')}
        className="agents-tabs"
        size="sm"
        keepMounted
        value={selectedId ?? ''}
        onChange={setChosen}
        items={list.map((session) => ({
          id: session.id,
          label: (
            <span className="agents-tab" data-status={session.status}>
              <span className="agents-tab__dot" aria-hidden="true" />
              <span className="agents-tab__title">{tabLabel(session)}</span>
              <span className="ui-visually-hidden">{statusLabel(session)}</span>
            </span>
          ),
          panel: (
            <TerminalView
              session={session}
              selfUserId={userId}
              active={session.id === selectedId}
              keepTerminal={recent.includes(session.id) || session.id === selectedId}
              onEnd={(target) => setEnding({ session: target, mode: 'end' })}
              onTerminate={(target) => setEnding({ session: target, mode: 'terminate' })}
              onAttach={setAttaching}
            />
          ),
        }))}
      />
    );
  }

  return (
    <Panel title={t('title')} icon={<IconTerminal />} actions={actions} className="agents-panel">
      {body}
      <NewSessionDialog
        kind="terminal"
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(session) => {
          setNewOpen(false);
          setChosen(session.id);
        }}
      />
      <EndSessionDialog session={ending?.session ?? null} mode={ending?.mode ?? 'end'} onClose={() => setEnding(null)} />
      {attaching !== null ? <AttachDialog session={attaching} isHost={caps.isHost} relayOrigin={window.location.origin} onClose={() => setAttaching(null)} /> : null}
    </Panel>
  );
}
