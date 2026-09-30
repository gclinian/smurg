// One tab of the agents panel: who owns the session, what it is, whether it runs, where (main workspace or which
// worktree) and whether it is sandboxed; the terminal; and, for the owner of a logged-out agent, the login guide.
import { useEffect, useState } from 'react';
import type { SessionInfo } from '@smurg/protocol';
import { useStore } from '../../lib/store.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Badge, Banner, Button, IconButton } from '../../ui/index.ts';
import { useWorkbenchLayout } from '../../lib/workspace/layout.tsx';
import { IconEye, IconInfo, IconKey, IconMaximize, IconMinimize, IconMinus, IconPlus, IconRefresh, IconTerminal, IconTrash } from '../../ui/icons.tsx';
import { AttachDialog } from './AttachDialog.tsx';
import { LoginGuide, effectiveLogin, type LoginCheck } from './LoginGuide.tsx';
import { LoginProcess } from './LoginProcess.tsx';
import { SessionTerminal } from './SessionTerminal.tsx';
import { branchOf, kindLabel, ownerLabel, sandboxLabel, statusLabel, whereLabel } from './session-info.ts';
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
  /** A session opened to replace this one (API-key login). */
  onReplaced(session: SessionInfo): void;
}

export function SessionView({ session, selfUserId, isHost, active, keepTerminal, onEnd, onTerminate, onReplaced }: SessionViewProps) {
  const stores = useStores();
  const worktrees = useStore(stores.worktrees, (state) => state.worktrees);
  const isOwner = selfUserId !== null && session.ownerUserId === selfUserId;
  const [scaled, setScaled] = useState(false);
  const [check, setCheck] = useState<LoginCheck | null>(null);
  const [guideHidden, setGuideHidden] = useState(false);
  const [checking, setChecking] = useState(false);
  const [details, setDetails] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const layout = useWorkbenchLayout();

  const login = effectiveLogin(session, check);
  const exited = session.status === 'exited';
  const needsLogin = session.kind === 'agent' && !exited && login === 'logged-out';
  const showGuide = isOwner && needsLogin && !guideHidden;

  // A new "logged out" report from the daemon shows the guide again.
  useEffect(() => {
    if (session.login === 'logged-out') setGuideHidden(false);
  }, [session.login]);

  const checkLogin = async (): Promise<void> => {
    setChecking(true);
    const against = session.login;
    try {
      setCheck({ login: await stores.sessions.loginStatus(session.id), against });
    } catch {
      setCheck({ login: 'unknown', against });
    } finally {
      setChecking(false);
    }
  };

  const infoRows: readonly (readonly [string, string])[] = [
    [t('info.owner'), ownerLabel(session, selfUserId)],
    [t('info.kind'), kindLabel(session)],
    [t('info.status'), statusLabel(session)],
    [t('info.where'), whereLabel(session, worktrees, selfUserId) + (branchOf(session, worktrees) ? ` · ${branchOf(session, worktrees)}` : '')],
    [t('info.sandbox'), sandboxLabel(session)],
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
          <span className="agents-summary__item" title={ownerLabel(session, selfUserId)}>
            {ownerLabel(session, selfUserId)}
          </span>
          <span className="agents-summary__item agents-summary__where" title={branchOf(session, worktrees) ?? where}>
            {where}
          </span>
          {!isOwner && !exited ? (
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
          {isOwner && needsLogin && guideHidden ? (
            <Button size="sm" variant="secondary" icon={<IconKey />} onClick={() => setGuideHidden(false)}>
              {t('action.loginGuide')}
            </Button>
          ) : null}
          {isOwner && session.kind === 'agent' && !exited && login === 'unknown' ? (
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
          {isOwner && !exited && session.kind === 'login' ? (
            // Cancelling one's own login needs no confirmation: nothing is lost, it can be started again.
            <Button size="sm" variant="ghost" icon={<IconTrash />} onClick={() => void stores.sessions.end(session.id).catch(() => {})}>
              {t('loginProcess.cancel')}
            </Button>
          ) : isOwner && !exited ? (
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
          {!isOwner && !exited ? <p className="agents-session__hint">{t('terminal.readOnly', { owner: session.ownerName })}</p> : null}
        </div>
      ) : null}
      {exited && session.kind !== 'login' ? <p className="agents-session__note">{t('terminal.exited')}</p> : null}
      {!isOwner && needsLogin ? (
        <Banner tone="info" live="none">
          {t('login.watcher', { owner: session.ownerName })}
        </Banner>
      ) : null}

      {session.kind === 'login' ? (
        <div className="agents-session__stage">
          <LoginProcess session={session} isOwner={isOwner} active={active} keepTerminal={keepTerminal} scaled={scaled} onFocus={onReplaced} />
        </div>
      ) : (
        <div className="agents-session__stage" data-guide={showGuide || undefined}>
          {/* The guide sits beside the terminal, or above it in a narrow panel — never over it (WEB-02): its first step
              is 「點一下終端機」 (the host's /login) or the login process of its own. */}
          <div className="agents-session__layout">
            {keepTerminal ? (
              <SessionTerminal session={session} isOwner={isOwner} active={active} scaled={scaled} />
            ) : (
              <p className="agents-session__note">{t('notice.pausedKeepAlive')}</p>
            )}
            {showGuide ? (
              <LoginGuide session={session} check={check} onChecked={setCheck} onHide={() => setGuideHidden(true)} onReplaced={onReplaced} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
