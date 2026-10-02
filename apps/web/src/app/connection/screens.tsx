// Full-page connection screens. The key-mismatch warning is SPEC R3.2's "show a warning" (a hard gate): a blocking,
// plain-language explanation that the connection was refused and what to do. Nothing behind it is rendered, and
// nothing on it retries the connection.
//
// Every full page (join, login, connecting, key mismatch, rejected, closed, not found) carries the language menu in
// the corner of its card: these screens have no top bar, and a person who cannot read the page must be able to
// switch. It is the LAST element of the card, so the screen's own action stays the first tab stop.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { ConnectionState } from '@smurg/protocol/client';
import type { ConnectionView } from '../../lib/connection/status.ts';
import { tConn } from '../../strings/connection.ts';
import { tApp } from '../../strings/app.ts';
import { Button, LanguageMenu, Spinner, cx } from '../../ui/index.ts';
import { IconAlertCircle, IconCloudOff, IconShieldAlert } from '../../ui/icons.tsx';
import { LoginPanel } from '../auth/LoginPanel.tsx';
import { useAppServices } from '../services.tsx';

export function FullPage({ children, tone = 'neutral', labelledBy, describedBy, role, testId }: {
  children: ReactNode;
  tone?: 'neutral' | 'danger' | 'warning';
  labelledBy?: string;
  describedBy?: string;
  role?: 'alertdialog' | 'main';
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A blocking screen takes focus, so keyboard and screen-reader users land on the explanation.
    if (role === 'alertdialog') ref.current?.focus();
  }, [role]);
  return (
    <div className="app-fullpage">
      <div
        ref={ref}
        className={cx('app-fullpage__card', `app-fullpage__card--${tone}`)}
        role={role}
        aria-modal={role === 'alertdialog' ? true : undefined}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={role === 'alertdialog' ? -1 : undefined}
        data-testid={testId}
      >
        {children}
        <div className="app-fullpage__language">
          <LanguageMenu size="sm" />
        </div>
      </div>
    </div>
  );
}

function HomeButton({ variant = 'secondary' }: { variant?: 'primary' | 'secondary' }) {
  const { router } = useAppServices();
  return (
    <Button variant={variant} onClick={() => router.navigate('/')}>
      {tConn('action.home')}
    </Button>
  );
}

/** R3.2: the relay presented a different host key; the connection was refused. */
export function KeyMismatchScreen({ state }: { state: Extract<ConnectionState, { kind: 'key-mismatch' }> }) {
  const titleId = useId();
  const bodyId = useId();
  return (
    <FullPage tone="danger" role="alertdialog" labelledBy={titleId} describedBy={bodyId} testId="key-mismatch-screen">
      <div className="app-fullpage__icon app-fullpage__icon--danger">
        <IconShieldAlert size={32} />
      </div>
      <h1 id={titleId}>{tConn('keyMismatch.title')}</h1>
      <div id={bodyId} className="app-fullpage__body">
        <p>{tConn('keyMismatch.lead')}</p>
        <p>
          <strong>{tConn('keyMismatch.refused')}</strong>
        </p>
        <p>{tConn('keyMismatch.causes')}</p>
      </div>
      <h2 className="app-fullpage__subtitle">{tConn('keyMismatch.whatToDo')}</h2>
      <ol className="app-fullpage__steps">
        <li>{tConn('keyMismatch.step1')}</li>
        <li>{tConn('keyMismatch.step2')}</li>
        <li>{tConn('keyMismatch.step3')}</li>
      </ol>
      <p className="app-fullpage__technical">
        {tConn('keyMismatch.technical', {
          detail: state.detail === 'fingerprint' ? tConn('keyMismatch.detail.fingerprint') : tConn('keyMismatch.detail.unauthenticated'),
          mode: state.mode === 'invite' ? tConn('keyMismatch.mode.invite') : tConn('keyMismatch.mode.device'),
        })}
      </p>
      <div className="app-fullpage__actions">
        <HomeButton variant="primary" />
      </div>
    </FullPage>
  );
}

/** Kicked, rejected, revoked, no trust, storage error, closed: why, and the one thing to do next. */
export function ConnectionEndedScreen({ view, state, onReconnect }: { view: ConnectionView; state: ConnectionState; onReconnect?: () => void }) {
  const titleId = useId();
  const bodyId = useId();
  const reloadable = state.kind === 'rejected' && (state.reason === 'version' || state.reason === 'identity-invalid' || state.reason === 'unknown');
  return (
    <FullPage tone={view.tone === 'danger' ? 'danger' : 'warning'} role="alertdialog" labelledBy={titleId} describedBy={bodyId} testId="connection-ended-screen">
      <div className={cx('app-fullpage__icon', view.tone === 'danger' && 'app-fullpage__icon--danger')}>
        <IconAlertCircle size={32} />
      </div>
      <h1 id={titleId}>{view.title}</h1>
      <p id={bodyId} className="app-fullpage__body">
        {view.body}
      </p>
      <div className="app-fullpage__actions">
        {onReconnect ? (
          <Button variant="primary" onClick={onReconnect}>
            {tConn('action.reconnect')}
          </Button>
        ) : null}
        {reloadable ? (
          <Button variant="secondary" onClick={() => window.location.reload()}>
            {tConn('action.reload')}
          </Button>
        ) : null}
        <HomeButton variant={onReconnect ? 'secondary' : 'primary'} />
      </div>
    </FullPage>
  );
}

export function LoginRequiredScreen({ returnPath, view }: { returnPath: string; view: ConnectionView }) {
  const titleId = useId();
  return (
    <FullPage tone="warning" role="main" labelledBy={titleId} testId="login-required-screen">
      <h1 id={titleId}>{view.title ?? tApp('login.title')}</h1>
      <p className="app-fullpage__body">{view.body ?? tApp('login.lead')}</p>
      <LoginPanel returnPath={returnPath} />
    </FullPage>
  );
}

/** Before the first admission: what is happening, and a clear "Host offline" if the host is away. */
export function ConnectingScreen({ view, title }: { view: ConnectionView; title: string }) {
  const titleId = useId();
  const offline = view.kind === 'host-offline' || view.kind === 'relay-unreachable';
  return (
    <FullPage role="main" labelledBy={titleId} testId="connecting-screen">
      <div className="app-fullpage__icon">{offline ? <IconCloudOff size={32} /> : <Spinner size={28} decorative />}</div>
      <h1 id={titleId}>{offline ? view.label : title}</h1>
      <p className="app-fullpage__body" role="status" data-connection-view={view.kind}>
        {view.detail}
      </p>
    </FullPage>
  );
}
