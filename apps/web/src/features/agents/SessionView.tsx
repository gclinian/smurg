// One tab of the agents panel: who opened the session, what it is, whether it runs, where (main workspace or which
// worktree); the terminal. Every session runs as the host — the host's computer, the host's Claude account (protocol
// v2) — so the host and members with 「可使用 agent」 type into any of them; editors suggest below; viewers watch.
import { useState } from 'react';
import type { SessionInfo } from '@smurg/protocol';
import { drivesSession } from '../../lib/capabilities.ts';
import { useStore } from '../../lib/store.ts';
import { useCapabilities, useStores } from '../../lib/workspace/context.tsx';
import { Badge, Banner, Button, IconButton, useToast } from '../../ui/index.ts';
import { useWorkbenchLayout } from '../../lib/workspace/layout.tsx';
import { IconEye, IconInfo, IconMaximize, IconMinimize, IconMinus, IconPlus, IconRefresh, IconTerminal, IconTrash } from '../../ui/icons.tsx';
import { AttachDialog } from './AttachDialog.tsx';
import { SessionTerminal } from './SessionTerminal.tsx';
import { branchOf, effectiveLogin, kindLabel, openedByLabel, statusLabel, whereLabel, type LoginCheck } from './session-info.ts';
import { t } from './strings.ts';

export interface SessionViewProps {
  readonly session: SessionInfo;
  readonly selfUserId: string | null;
  readonly isHost: boolean;
  readonly active: boolean;
  /** Whether this tab keeps a live terminal (the most recently shown tabs do; the others are released). */
  readonly keepTerminal: boolean;
  onEnd(session: SessionInfo): void;
  onTerminate(session: SessionInfo): void;
}

export function SessionView({ session, selfUserId, isHost, active, keepTerminal, onEnd, onTerminate }: SessionViewProps) {
  const stores = useStores();
  const caps = useCapabilities();
  const toast = useToast();
  const worktrees = useStore(stores.worktrees, (state) => state.worktrees);
  const isOwner = selfUserId !== null && session.ownerUserId === selfUserId;
  const driving = drivesSession(caps, session);
  const [scaled, setScaled] = useState(false);
  const [check, setCheck] = useState<LoginCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [details, setDetails] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const layout = useWorkbenchLayout();

  const login = effectiveLogin(session, check);
  const exited = session.status === 'exited';
  const loggedOut = session.kind === 'agent' && !exited && login === 'logged-out';

  // session.loginStatus needs session.drive: the host and 可使用 agent re-check (the host's Claude login).
  const checkLogin = async (): Promise<void> => {
    setChecking(true);
    const against = session.login;
    try {
      const result = await stores.sessions.loginStatus(session.id);
      setCheck({ login: result, against });
      toast.show({
        tone: result === 'logged-in' ? 'success' : 'info',
        title: result === 'logged-in' ? t('login.result.loggedIn') : result === 'logged-out' ? t('login.result.loggedOut') : t('login.result.unknown'),
      });
    } catch {
      setCheck({ login: 'unknown', against });
    } finally {
      setChecking(false);
    }
  };

  const opener = openedByLabel(session, selfUserId);
  const infoRows: readonly (readonly [string, string])[] = [
    [t('info.owner'), opener],
    [t('info.kind'), kindLabel(session)],
    [t('info.status'), statusLabel(session)],
    [t('info.where'), whereLabel(session, worktrees, selfUserId) + (branchOf(session, worktrees) ? ` · ${branchOf(session, worktrees)}` : '')],
    [t('info.runsAs'), t('runsAs.value')],
    [t('info.viewers'), t('viewers', { count: session.attached })],
  ];

  const statusBadge = <Badge tone={exited ? 'neutral' : session.status === 'running' ? 'success' : 'info'}>{statusLabel(session)}</Badge>;
  const where = whereLabel(session, worktrees, selfUserId);
  return (
    <div className="agents-session" data-session-id={session.id}>
      <div className="agents-session__bar">
        {/* One line (review WEB-02: the header took ~100 px of a 6-row terminal); the rest behind 「詳細資訊」. */}
        <div className="agents-summary" aria-label={t('info.label', { title: session.title })} role="group">
          {statusBadge}
          <span className="agents-summary__item" title={opener}>
            {opener}
          </span>
          <span className="agents-summary__item agents-summary__where" title={branchOf(session, worktrees) ?? where}>
            {where}
          </span>
          {!driving && !exited ? (
            <Badge tone="neutral">
              <IconEye size={12} /> {t('terminal.watchOnly')}
            </Badge>
          ) : null}
        </div>
        <div className="agents-session__actions">
          <IconButton size="sm" label={t('action.attach')} icon={<IconTerminal />} onClick={() => setAttaching(true)} />
          <IconButton
            size="sm"
            label={t('action.details')}
            icon={<IconInfo />}
            pressed={details}
            aria-expanded={details}
            onClick={() => setDetails((value) => !value)}
          />
          {layout !== null ? (
            <IconButton
              size="sm"
              label={layout.agentsWide ? t('action.restoreWidth') : t('action.maximize')}
              icon={layout.agentsWide ? <IconMinimize /> : <IconMaximize />}
              pressed={layout.agentsWide}
              onClick={() => layout.toggle('agentsWide')}
            />
          ) : null}
          {driving && session.kind === 'agent' && login === 'unknown' ? (
            <Button size="sm" variant="ghost" icon={<IconRefresh />} loading={checking} onClick={() => void checkLogin()}>
              {t('login.check')}
            </Button>
          ) : null}
          {/* Everyone (the owner's second window too, while the other one drives the size): draws the PTY-sized
              terminal smaller, never reflowed (LEAD-01). */}
          <IconButton
            size="sm"
            label={scaled ? t('action.unscale') : t('action.scale')}
            icon={scaled ? <IconPlus /> : <IconMinus />}
            pressed={scaled}
            onClick={() => setScaled((value) => !value)}
          />
          {isOwner && !exited ? (
            <Button size="sm" variant="ghost" icon={<IconTrash />} onClick={() => onEnd(session)}>
              {t('action.end')}
            </Button>
          ) : null}
          {!isOwner && isHost && !exited ? (
            <Button size="sm" variant="ghost" icon={<IconTrash />} onClick={() => onTerminate(session)}>
              {t('action.terminate')}
            </Button>
          ) : null}
        </div>
      </div>

      {attaching ? (
        <AttachDialog session={session} isHost={isHost} relayOrigin={window.location.origin} onClose={() => setAttaching(false)} />
      ) : null}
      {details ? (
        <div className="agents-session__details">
          <dl className="agents-info" aria-label={t('info.detailsLabel', { title: session.title })}>
            {infoRows.map(([term, value]) => (
              <div key={term} className="agents-info__item">
                <dt>{term}</dt>
                <dd>{term === t('info.status') ? statusBadge : value}</dd>
              </div>
            ))}
          </dl>
          {!driving && !exited ? (
            <p className="agents-session__hint">
              {caps.can('suggest.create') ? t('terminal.readOnly', { owner: session.ownerName }) : t('terminal.readOnlyViewer', { owner: session.ownerName })}
            </p>
          ) : null}
        </div>
      ) : null}
      {exited ? <p className="agents-session__note">{t('terminal.exited')}</p> : null}
      {loggedOut ? (
        <Banner
          tone="info"
          live="none"
          actions={
            driving ? (
              <Button size="sm" variant="secondary" icon={<IconRefresh />} loading={checking} onClick={() => void checkLogin()}>
                {t('login.recheck')}
              </Button>
            ) : undefined
          }
        >
          {isHost ? t('login.notice.host') : t('login.notice.member')}
        </Banner>
      ) : null}

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
