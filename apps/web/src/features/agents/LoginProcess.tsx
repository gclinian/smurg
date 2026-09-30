// A guest's own Claude subscription login (ARCHITECTURE §11 D-12, session kind 'login'): the daemon runs the fixed
// `claude auth login` in the guest's sandbox; only its owner sees it, attaches to it and types into it. This view puts
// the steps above its terminal — open the link it shows in YOUR OWN browser, log in, paste the code here — keeps the
// honest notice that the host can technically read the credential, and when the process ends asks the daemon again
// whether the guest's agent is logged in (session.loginStatus) and says what to do next: nothing to restart, the next
// prompt of the running agent uses the new login.
import { useEffect, useRef, useState } from 'react';
import type { LoginState, SessionInfo } from '@smurg/protocol';
import { useStore } from '../../lib/store.ts';
import { plainSessionTitle } from '../../lib/stores/sessions.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, Spinner } from '../../ui/index.ts';
import { IconRefresh, IconShieldAlert } from '../../ui/icons.tsx';
import { startLoginProcess } from './LoginGuide.tsx';
import { SessionTerminal } from './SessionTerminal.tsx';
import { describeSessionError } from './session-info.ts';
import { t } from './strings.ts';

export interface LoginProcessProps {
  readonly session: SessionInfo;
  readonly isOwner: boolean;
  readonly active: boolean;
  readonly keepTerminal: boolean;
  readonly scaled: boolean;
  /** Show another session (the agent to go back to, or a new login process). */
  onFocus(session: SessionInfo): void;
}

type Outcome =
  | { readonly kind: 'checking' }
  | { readonly kind: 'logged-in'; readonly agent: SessionInfo | null }
  | { readonly kind: 'not-logged-in' }
  | { readonly kind: 'unknown' };

/** The owner's agent sessions that run now, newest first: the ones the new login is for. */
function runningAgentsOf(sessions: ReadonlyMap<string, SessionInfo>, ownerUserId: string): SessionInfo[] {
  return [...sessions.values()].filter((s) => s.kind === 'agent' && s.ownerUserId === ownerUserId && s.status !== 'exited').sort((a, b) => b.createdAt - a.createdAt);
}

export function LoginProcess({ session, isOwner, active, keepTerminal, scaled, onFocus }: LoginProcessProps) {
  const stores = useStores();
  const all = useStore(stores.sessions, (state) => state.sessions);
  const exited = session.status === 'exited';
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const checked = useRef(false);

  // When the login process ended by itself: ask the daemon again (the running agents use the new credential from
  // their next prompt; the daemon re-checks them too and reports it with session.state).
  useEffect(() => {
    if (!exited || !isOwner || checked.current || session.endReason === 'ended' || session.endReason === 'terminated') return;
    checked.current = true;
    const agents = runningAgentsOf(stores.sessions.getState().sessions, session.ownerUserId);
    if (agents.length === 0) {
      setOutcome(session.exitCode === 0 ? { kind: 'logged-in', agent: null } : { kind: 'not-logged-in' });
      return;
    }
    setOutcome({ kind: 'checking' });
    void Promise.all(agents.map((agent) => stores.sessions.loginStatus(agent.id).then((login): [SessionInfo, LoginState] => [agent, login]).catch((): [SessionInfo, LoginState] => [agent, 'unknown']))).then((results) => {
      const loggedIn = results.find(([, login]) => login === 'logged-in');
      if (loggedIn) setOutcome({ kind: 'logged-in', agent: loggedIn[0] });
      else if (results.some(([, login]) => login === 'logged-out')) setOutcome({ kind: 'not-logged-in' });
      else setOutcome({ kind: 'unknown' });
    });
  }, [exited, isOwner, session.endReason, session.exitCode, session.ownerUserId, stores]);

  const retry = async (): Promise<void> => {
    setRetrying(true);
    setRetryError(null);
    try {
      onFocus(await startLoginProcess(stores.sessions, session.ownerUserId));
    } catch (error) {
      const view = describeSessionError(error);
      setRetryError(`${view.title}：${view.message}${view.hint ? ` ${view.hint}` : ''}`);
    } finally {
      setRetrying(false);
    }
  };

  // The agent to go back to: the one the check found, else the newest running one (the daemon may have reported it).
  const backTo = outcome?.kind === 'logged-in' ? (outcome.agent ? (all.get(outcome.agent.id) ?? outcome.agent) : (runningAgentsOf(all, session.ownerUserId)[0] ?? null)) : null;

  let result = null;
  if (exited && isOwner) {
    if (session.endReason === 'ended') result = <Banner tone="neutral" live="status">{t('loginProcess.cancelled')}</Banner>;
    else if (session.endReason === 'terminated') result = <Banner tone="warning" live="status">{t('loginProcess.timedOut')}</Banner>;
    else if (outcome === null || outcome.kind === 'checking')
      result = (
        <p className="agents-loginproc__checking" role="status">
          <Spinner size={14} decorative /> {t('loginProcess.checking')}
        </p>
      );
    else if (outcome.kind === 'logged-in')
      result = (
        <Banner
          tone="success"
          live="status"
          title={t('loginProcess.done')}
          actions={
            backTo ? (
              <Button size="sm" variant="primary" onClick={() => onFocus(backTo)}>
                {t('loginProcess.back', { title: plainSessionTitle(backTo) })}
              </Button>
            ) : undefined
          }
        >
          {backTo ? t('loginProcess.doneNext', { title: plainSessionTitle(backTo) }) : t('loginProcess.doneNoSession')}
        </Banner>
      );
    else
      result = (
        <Banner tone="warning" live="status">
          {outcome.kind === 'not-logged-in' ? t('loginProcess.notDone', { code: session.exitCode ?? '?' }) : t('loginProcess.unknown', { code: session.exitCode ?? '?' })}
        </Banner>
      );
  }

  return (
    <div className="agents-loginproc" data-testid="login-process">
      <div className="agents-loginproc__guide">
        <h3 className="agents-loginproc__title">{t('loginProcess.title')}</h3>
        {!exited ? (
          <ol className="agents-login__steps">
            <li>{t('loginProcess.step1')}</li>
            <li>{t('loginProcess.step2')}</li>
            <li>{t('loginProcess.step3')}</li>
            <li>{t('loginProcess.step4')}</li>
          </ol>
        ) : null}
        {result}
        {exited && isOwner && outcome?.kind !== 'logged-in' && outcome?.kind !== 'checking' ? (
          <div className="agents-loginproc__retry">
            <Button size="sm" variant="secondary" icon={<IconRefresh />} loading={retrying} onClick={() => void retry()}>
              {t('loginProcess.retry')}
            </Button>
            {retryError !== null ? (
              <p role="alert" className="agents-login__error">
                {retryError}
              </p>
            ) : null}
          </div>
        ) : null}
        <p className="agents-loginproc__private">
          <IconShieldAlert size={14} aria-hidden="true" /> {t('loginProcess.private')} {t('login.warning.host')}
        </p>
      </div>
      {keepTerminal ? (
        <SessionTerminal session={session} isOwner={isOwner} active={active} scaled={scaled} />
      ) : (
        <p className="agents-session__note">{t('notice.pausedKeepAlive')}</p>
      )}
    </div>
  );
}
