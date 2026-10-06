// One plain terminal as it is shown (a column of the sessions view, a tab of code mode's Terminal drawer): one line
// that says who opened it, whether it runs and where, the few actions, and the terminal itself. Every session runs
// as the host, on the host's computer: the host and members with agent access type into any terminal; everyone else
// watches. A running terminal is ended by the member who opened it, or terminated by the host.
import { useState } from 'react';
import { isSessionOver, type TerminalSession } from '@smurg/protocol';
import { drivesSession } from '../../lib/capabilities.ts';
import { useStore } from '../../lib/store.ts';
import { sessionTitle } from '../../lib/stores/sessions.ts';
import { useCapabilities, useStores } from '../../lib/workspace/context.tsx';
import { Badge, Button, IconButton } from '../../ui/index.ts';
import { IconEye, IconInfo, IconMinus, IconPlus, IconTerminal, IconTrash } from '../../ui/icons.tsx';
import { SessionTerminal } from './SessionTerminal.tsx';
import { branchOf, openedByLabel, openerName, statusLabel, whereLabel } from './session-info.ts';
import { t } from './strings.ts';

export interface TerminalViewProps {
  readonly session: TerminalSession;
  readonly selfUserId: string | null;
  /** Shown right now (the chosen tab, a column on screen): the terminal attaches only then. */
  readonly active: boolean;
  /** Whether this view keeps a live terminal (the most recently shown ones do; the others are released). */
  readonly keepTerminal: boolean;
  onEnd(session: TerminalSession): void;
  onTerminate(session: TerminalSession): void;
  onAttach(session: TerminalSession): void;
}

export function TerminalView({ session, selfUserId, active, keepTerminal, onEnd, onTerminate, onAttach }: TerminalViewProps) {
  const stores = useStores();
  const caps = useCapabilities();
  const worktrees = useStore(stores.worktrees, (state) => state.worktrees);
  const isOwner = selfUserId !== null && session.openedBy.userId === selfUserId;
  const driving = drivesSession(caps, session);
  const [scaled, setScaled] = useState(false);
  const [details, setDetails] = useState(false);
  const exited = isSessionOver(session);

  const opener = openedByLabel(session, selfUserId);
  const where = whereLabel(session, worktrees, selfUserId);
  const branch = branchOf(session, worktrees);
  const infoRows: readonly (readonly [string, string])[] = [
    [t('info.owner'), openerName(session, selfUserId)],
    [t('info.status'), statusLabel(session)],
    [t('info.where'), where + (branch ? ` · ${branch}` : '')],
    [t('info.runsAs'), t('runsAs.value')],
    [t('info.viewers'), t('viewers', { count: session.attached })],
  ];
  const statusBadge = <Badge tone={exited ? 'neutral' : session.status === 'running' ? 'success' : 'info'}>{statusLabel(session)}</Badge>;

  return (
    <div className="agents-session" data-session-id={session.id}>
      <div className="agents-session__bar">
        {/* One line; the rest behind "Details". */}
        <div className="agents-summary" aria-label={t('info.label', { title: sessionTitle(session) })} role="group">
          {statusBadge}
          <span className="agents-summary__item" title={opener}>
            {opener}
          </span>
          <span className="agents-summary__item agents-summary__where" title={branch ?? where}>
            {where}
          </span>
          {!driving && !exited ? (
            <Badge tone="neutral">
              <IconEye size={12} /> {t('terminal.watchOnly')}
            </Badge>
          ) : null}
        </div>
        <div className="agents-session__actions">
          <IconButton size="sm" label={t('action.attach')} icon={<IconTerminal />} onClick={() => onAttach(session)} />
          <IconButton size="sm" label={t('action.details')} icon={<IconInfo />} pressed={details} aria-expanded={details} onClick={() => setDetails((value) => !value)} />
          {/* Everyone: draws the PTY-sized terminal smaller, never reflowed. */}
          <IconButton size="sm" label={scaled ? t('action.unscale') : t('action.scale')} icon={scaled ? <IconPlus /> : <IconMinus />} pressed={scaled} onClick={() => setScaled((value) => !value)} />
          {isOwner && !exited ? (
            <Button size="sm" variant="ghost" icon={<IconTrash />} aria-label={t('action.end')} title={t('action.end')} onClick={() => onEnd(session)}>
              {t('action.endShort')}
            </Button>
          ) : null}
          {!isOwner && caps.isHost && !exited ? (
            <Button size="sm" variant="ghost" icon={<IconTrash />} onClick={() => onTerminate(session)}>
              {t('action.terminate')}
            </Button>
          ) : null}
        </div>
      </div>

      {details ? (
        <div className="agents-session__details">
          <dl className="agents-info" aria-label={t('info.detailsLabel', { title: sessionTitle(session) })}>
            {infoRows.map(([term, value]) => (
              <div key={term} className="agents-info__item">
                <dt>{t('info.term', { label: term })}</dt>
                <dd>{term === t('info.status') ? statusBadge : value}</dd>
              </div>
            ))}
          </dl>
          {!driving && !exited ? <p className="agents-session__hint">{t('terminal.readOnly', { owner: session.openedBy.displayName })}</p> : null}
        </div>
      ) : null}
      {exited ? <p className="agents-session__note">{t('terminal.exited')}</p> : null}

      <div className="agents-session__stage">
        <div className="agents-session__layout">
          {keepTerminal ? (
            <SessionTerminal session={session} isOwner={isOwner} canType={driving} active={active} scaled={scaled} />
          ) : (
            <p className="agents-session__note">{t('notice.pausedKeepAlive')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
