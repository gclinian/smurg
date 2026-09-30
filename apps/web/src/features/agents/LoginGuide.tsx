// The login guide beside a logged-out agent session (SPEC R4 「登入引導」, ARCHITECTURE §7.6 "Login guide", §11 D-12,
// claude-hooks.md §1.6). What it tells a guest is deliberately plain and honest:
//  - a guest's Claude subscription login cannot run inside their agent's sandbox (no listening socket). The daemon runs
//    a dedicated LOGIN PROCESS for them instead (session kind 'login', `claude auth login` in their own sandbox, seen
//    by nobody else): 「用 Claude 訂閱登入」 starts it and shows its terminal with the steps (LoginProcess.tsx) — offered
//    unless the host switched it off (PublicSettings.guestSubscriptionLogin false: then one sentence says why and only
//    the API key is offered; undefined is an older daemon that does not say, so both are offered);
//  - or their own API key, which is only ever sent with session.create for that one session (a new session replaces
//    this one): the field is a password field, kept in this component's memory only, never stored or logged;
//  - the host can technically read the guest's credentials; a key with a spending limit is recommended; 「離開」
//    deletes the temporary directory (a mere disconnect does not).
// The host's own (unsandboxed) session logs in the usual way, with /login in its terminal.
// The login state comes from the daemon (`claude auth status --json` in the session's environment), re-checked on
// request with session.loginStatus.
import { useId, useState, type FormEvent } from 'react';
import { errorReasonOf, isSmurgError, type LoginState, type PayloadInputOf, type SessionInfo } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { selectSettings } from '../../lib/stores/workspace.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, IconButton, Input, useToast } from '../../ui/index.ts';
import { IconClose, IconKey, IconShieldAlert, IconTerminal } from '../../ui/icons.tsx';
import { DEFAULT_TERMINAL_SIZE, apiKeyProblem } from './new-session.ts';
import { describeSessionError } from './session-info.ts';
import { t } from './strings.ts';

export interface LoginCheck {
  readonly login: LoginState;
  /** The session.login value the check was made against (a newer value from the daemon wins). */
  readonly against: LoginState;
}

/** What the panel shows: the latest re-check when the daemon has not reported anything newer since. */
export function effectiveLogin(session: Pick<SessionInfo, 'login'>, check: LoginCheck | null): LoginState {
  return check !== null && check.against === session.login ? check.login : session.login;
}

export interface LoginGuideProps {
  readonly session: SessionInfo;
  readonly check: LoginCheck | null;
  onChecked(check: LoginCheck): void;
  onHide(): void;
  /** A new session was opened with the guest's API key (it replaces this one), or the login process to show. */
  onReplaced(session: SessionInfo): void;
}

/**
 * Starts the guest's own login process (session kind 'login'), or finds the one already running (one per guest).
 * Resolves with the session to show.
 */
export async function startLoginProcess(sessions: ReturnType<typeof useStores>['sessions'], ownerUserId: string): Promise<SessionInfo> {
  const running = (): SessionInfo | undefined =>
    [...sessions.getState().sessions.values()].find((s) => s.kind === 'login' && s.ownerUserId === ownerUserId && s.status !== 'exited');
  const existing = running();
  if (existing) return existing;
  try {
    return await sessions.create({ kind: 'login', workspace: { mode: 'main' }, cols: DEFAULT_TERMINAL_SIZE.cols, rows: DEFAULT_TERMINAL_SIZE.rows });
  } catch (error) {
    // Already running (another tab of this guest started it): show that one.
    if (isSmurgError(error) && errorReasonOf(error) === 'login-running') {
      if (!running()) await sessions.reload().catch(() => {});
      const found = running();
      if (found) return found;
    }
    throw error;
  }
}

export function LoginGuide({ session, check, onChecked, onHide, onReplaced }: LoginGuideProps) {
  const stores = useStores();
  const toast = useToast();
  const headingId = useId();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  // The guest's API key: component state only (memory), cleared as soon as it was used.
  const [apiKey, setApiKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [relaunching, setRelaunching] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const settings = useStore(stores.workspace, selectSettings);
  // Only an explicit false switches it off: undefined is a daemon that does not say (offer both; it refuses if off).
  const subscriptionAllowed = settings?.guestSubscriptionLogin !== false;

  const startSubscription = async (): Promise<void> => {
    setStarting(true);
    setStartError(null);
    try {
      onReplaced(await startLoginProcess(stores.sessions, session.ownerUserId));
    } catch (error) {
      const view = describeSessionError(error);
      setStartError(`${view.title}：${view.message}${view.hint ? ` ${view.hint}` : ''}`);
    } finally {
      setStarting(false);
    }
  };

  const recheck = async (): Promise<void> => {
    setChecking(true);
    setCheckError(null);
    const against = session.login;
    try {
      const login = await stores.sessions.loginStatus(session.id);
      // Logged in: the guide closes itself (the parent stops showing it), so the answer is told as a notice.
      if (login === 'logged-in') toast.show({ tone: 'success', title: t('login.result.loggedIn') });
      onChecked({ login, against });
    } catch (error) {
      setCheckError(describeError(error));
    } finally {
      setChecking(false);
    }
  };

  const relaunch = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const key = apiKey.trim();
    if (key === '' || apiKeyProblem(key) !== null) {
      setKeyError(t('new.apiKey.invalid'));
      return;
    }
    setKeyError(null);
    setRelaunching(true);
    const inWorktree = session.root.kind === 'worktree';
    const workspace: PayloadInputOf<'session.create'>['workspace'] =
      session.root.kind === 'worktree' ? { mode: 'worktree', worktreeId: session.root.worktreeId } : { mode: 'main' };
    const running = session.status !== 'exited';
    try {
      // A worktree has one session at a time: end this logged-out one first, KEEPING the worktree, so the new one
      // continues in it. In the main workspace the new session starts first, so a refusal loses nothing.
      if (inWorktree && running) await stores.sessions.end(session.id, { keepWorktree: true });
      const created = await stores.sessions.create({ kind: 'agent', workspace, cols: session.cols, rows: session.rows, title: session.title, apiKey: key });
      setApiKey('');
      if (!inWorktree && running) {
        await stores.sessions.end(session.id).catch(() => {
          toast.show({ tone: 'warning', title: t('login.key.oldStillRunning') });
        });
      }
      toast.show({ tone: 'success', title: t('login.key.done') });
      onReplaced(created);
    } catch (error) {
      const view = describeSessionError(error);
      setKeyError(`${view.title}：${view.message}${view.hint ? ` ${view.hint}` : ''}`);
    } finally {
      setRelaunching(false);
    }
  };

  const guest = session.sandboxed;
  const result = check !== null && check.against === session.login ? check.login : null;

  return (
    <aside className="agents-login" aria-labelledby={headingId}>
      <header className="agents-login__header">
        <h3 id={headingId} className="agents-login__title">
          {t('login.title')}
        </h3>
        <IconButton label={t('login.hide')} icon={<IconClose />} size="sm" onClick={onHide} />
      </header>
      <div className="agents-login__body">
        <p>{guest ? t('login.lead') : t('login.hostLead')}</p>

        {guest ? (
          <Banner tone="warning" live="none" icon={<IconShieldAlert />} title={t('login.warning.title')}>
            <p>{t('login.warning.host')}</p>
            <p>{t('login.warning.leave')}</p>
          </Banner>
        ) : null}

        {!guest ? (
          <section className="agents-login__method">
            <h4>{t('login.sub.title')}</h4>
            <ol className="agents-login__steps">
              <li>{t('login.sub.step1')}</li>
              <li>{t('login.sub.step2')}</li>
              <li>{t('login.sub.step3')}</li>
              <li>{t('login.sub.step4')}</li>
              <li>{t('login.sub.step5')}</li>
            </ol>
          </section>
        ) : subscriptionAllowed ? (
          <section className="agents-login__method" data-testid="login-subscription">
            <h4>{t('login.guestSub.title')}</h4>
            <p>{t('login.guestSub.lead')}</p>
            <Button variant="primary" size="sm" icon={<IconTerminal />} loading={starting} onClick={() => void startSubscription()}>
              {t('login.guestSub.start')}
            </Button>
            {startError !== null ? (
              <p role="alert" className="agents-login__error">
                {startError}
              </p>
            ) : null}
            <p className="agents-login__note">{t('login.sub.browserNote')}</p>
          </section>
        ) : (
          <p className="agents-login__note" data-testid="login-subscription-off">
            {t('login.guestSub.off')}
          </p>
        )}

        {guest ? (
          <section className="agents-login__method">
            <h4>{subscriptionAllowed ? t('login.key.title') : t('login.key.titleOnly')}</h4>
            <p>{t('login.key.lead')}</p>
            <form className="agents-login__key" onSubmit={(event) => void relaunch(event)} autoComplete="off">
              <Input
                label={t('new.apiKey.label')}
                type="password"
                name="smurg-session-api-key"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                data-1p-ignore=""
                data-lpignore="true"
                data-bwignore=""
                data-form-type="other"
                value={apiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
                hint={t('new.apiKey.hint')}
                error={keyError ?? undefined}
              />
              <p className="agents-login__note">{t('login.key.limit')}</p>
              <Button type="submit" variant="secondary" size="sm" icon={<IconKey />} loading={relaunching} disabled={apiKey.trim() === ''}>
                {t('login.key.submit')}
              </Button>
            </form>
          </section>
        ) : null}

        <div className="agents-login__check">
          <Button size="sm" variant="primary" loading={checking} onClick={() => void recheck()}>
            {t('login.recheck')}
          </Button>
          <p role="status" className="agents-login__result">
            {checkError !== null
              ? checkError
              : result === 'logged-in'
                ? t('login.result.loggedIn')
                : result === 'logged-out'
                  ? t('login.result.loggedOut')
                  : result === 'unknown'
                    ? t('login.result.unknown')
                    : ''}
          </p>
        </div>
      </div>
    </aside>
  );
}
