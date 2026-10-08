// /join/:workspaceId — invite acceptance, exactly as ARCHITECTURE §4.1:
//   1. boot/capture-invite.ts already moved the fragment into sessionStorage and out of the address bar (before
//      anything else ran, and so before any login redirect);
//   2. parse it strictly (pending-invite.ts);
//   3. log in if needed (the return URL carries no fragment; the invite waits in sessionStorage);
//   4. ask: nothing is connected until the person clicks "Join" (any web page can send a logged-in
//      visitor to an invite link; joining on page load handed the visitor's relay identity to whoever made the link
//      and made them a member of that workspace without a click);
//   5. connect in invite mode; the SDK verifies the daemon key against `k` and PERSISTS THE PIN before it proves the
//      invite (msg3), so the next visit reconnects in device mode;
//   6. once admitted, forget the invite and open the workspace on the same connection.
// A daemon key that differs from an earlier pin is never accepted silently: the person must confirm the new link.
//
// When the invite is forgotten: joined, turned down by the person, or refused in a way that ends the link. It is KEPT
// (in this tab's storage) through a refusal the screen answers with "Reload the page" (the host's smurg and this page
// do not fit, the login could not be verified, a key a newer page wrote: lib/connection/status.ts reloadIsAWayOut):
// such a refusal used up nothing, so the reload asks "Join?" again and the same link lets the person in. By then the
// host's key is pinned (step 5), and the pin is the invite's own, so the SDK tries this browser's device key first
// and falls back to the invite when the host does not know the device.
import { useEffect, useId, useRef, useState } from 'react';
import { daemonKeyFingerprint, equalBytes } from '@smurg/protocol';
import { isTerminalState, type ConnectionState, type InviteTrust, type RelayUser } from '@smurg/protocol/client';
import { loadChunk } from '../../lib/chunks.ts';
import { describeConnection, reloadIsAWayOut } from '../../lib/connection/status.ts';
import { describeError } from '../../lib/errors.ts';
import { clearPendingInvite, readPendingInvite } from '../../lib/invite/pending-invite.ts';
import { useStore } from '../../lib/store.ts';
import type { WorkspaceHandle, WorkspaceManager } from '../../lib/workspace/manager.ts';
import { routePath } from '../../lib/router.ts';
import { tApp } from '../../strings/app.ts';
import { tJoin } from '../../strings/join.ts';
import { Banner, Button } from '../../ui/index.ts';
import { IconKey } from '../../ui/icons.tsx';
import { LoginPanel } from '../auth/LoginPanel.tsx';
import { ConnectingScreen, ConnectionEndedScreen, FullPage, KeyMismatchScreen, LoginRequiredScreen } from '../connection/screens.tsx';
import { useAppServices } from '../services.tsx';
import { bootCapture } from '../../boot/capture-invite.ts';

type Step =
  | { readonly kind: 'reading' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'login'; readonly error: string | null }
  | { readonly kind: 'confirm-key-change'; readonly invite: InviteTrust }
  /** Step 4: logged in and the link is well formed; waits for the person's click. */
  | { readonly kind: 'confirm-join'; readonly invite: InviteTrust; readonly user: RelayUser; readonly preferInvite: boolean }
  | { readonly kind: 'connect'; readonly invite: InviteTrust; readonly preferInvite: boolean };

export function JoinPage({ workspaceId }: { workspaceId: string }) {
  const services = useAppServices();
  const { auth, pins, sessionStorage, router, manager } = services;
  const [step, setStep] = useState<Step>({ kind: 'reading' });

  // Steps 2–3 (and the key-change check), once per workspace id.
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const pending = readPendingInvite(sessionStorage, workspaceId);
      if (pending.kind === 'invalid') {
        clearPendingInvite(sessionStorage, workspaceId);
        setStep({ kind: 'invalid' });
        return;
      }
      if (pending.kind === 'none') {
        // Already joined in this browser (a reload of /join after success, or an old link): go to the workspace.
        const pinned = await pins.get(workspaceId).catch(() => null);
        if (!alive) return;
        if (pinned !== null) router.navigate(routePath({ name: 'workspace', workspaceId }), { replace: true });
        else setStep({ kind: 'missing' });
        return;
      }
      let user: RelayUser | null;
      try {
        user = await auth.me();
      } catch (error) {
        if (alive) setStep({ kind: 'login', error: describeError(error) });
        return;
      }
      if (!alive) return;
      if (user === null) {
        setStep({ kind: 'login', error: null });
        return;
      }
      const pinned = await pins.get(workspaceId).catch(() => null);
      if (!alive) return;
      if (pinned !== null && !equalBytes(daemonKeyFingerprint(pinned), pending.invite.fingerprint)) {
        setStep({ kind: 'confirm-key-change', invite: pending.invite });
        return;
      }
      setStep({ kind: 'confirm-join', invite: pending.invite, user, preferInvite: false });
    };
    void run();
    return () => {
      alive = false;
    };
  }, [workspaceId, auth, pins, sessionStorage, router]);

  const returnPath = routePath({ name: 'join', workspaceId });
  switch (step.kind) {
    case 'reading':
      return <ConnectingScreen view={{ ...describeConnection({ kind: 'idle' }), detail: tJoin('reading') }} title={tJoin('title')} />;
    case 'invalid':
      return <Problem title={tJoin('invalid.title')} body={tJoin('invalid.body')} />;
    case 'missing':
      return <Problem title={tJoin('missing.title')} body={tJoin('missing.body')} />;
    case 'login':
      return <JoinLogin returnPath={returnPath} error={step.error} memoryOnly={bootCapture.kind === 'captured' && !bootCapture.persisted} />;
    case 'confirm-key-change':
      return (
        <KeyChangeConfirm
          // Confirming the new key is itself a click on this invite: it counts as the explicit "Join" of step 4.
          onConfirm={() => setStep({ kind: 'connect', invite: step.invite, preferInvite: true })}
          onCancel={() => {
            clearPendingInvite(sessionStorage, workspaceId);
            router.navigate('/');
          }}
        />
      );
    case 'confirm-join':
      return (
        <JoinConfirm
          workspaceId={workspaceId}
          user={step.user}
          onJoin={() => setStep({ kind: 'connect', invite: step.invite, preferInvite: step.preferInvite })}
          onCancel={() => {
            clearPendingInvite(sessionStorage, workspaceId);
            router.navigate('/');
          }}
        />
      );
    case 'connect':
      return <JoinConnect workspaceId={workspaceId} invite={step.invite} preferInvite={step.preferInvite} manager={manager} />;
  }
}

/**
 * Step 4: an explicit "Join". The host's name and the role are only known after the handshake, so the page says what
 * IS known: the workspace id, that the link came from someone else, and which identity the host will see.
 */
function JoinConfirm({ workspaceId, user, onJoin, onCancel }: { workspaceId: string; user: RelayUser; onJoin(): void; onCancel(): void }) {
  const titleId = useId();
  const bodyId = useId();
  return (
    <FullPage role="main" labelledBy={titleId} describedBy={bodyId} testId="join-confirm">
      <h1 id={titleId}>{tJoin('confirm.title')}</h1>
      <div id={bodyId} className="app-fullpage__body">
        <p>{tJoin('confirm.lead')}</p>
        <dl className="app-join-facts">
          <div>
            <dt>{tJoin('confirm.workspace')}</dt>
            <dd>
              <code>{workspaceId}</code>
            </dd>
          </div>
          <div>
            <dt>{tJoin('confirm.identity')}</dt>
            <dd>{tJoin('confirm.identityValue', { name: user.displayName, provider: providerLabel(user.provider) })}</dd>
          </div>
        </dl>
        <p>{tJoin('confirm.shared')}</p>
        <p>
          <strong>{tJoin('confirm.ask')}</strong>
        </p>
      </div>
      <div className="app-fullpage__actions">
        <Button variant="primary" onClick={onJoin}>
          {tJoin('confirm.join')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {tJoin('confirm.cancel')}
        </Button>
      </div>
    </FullPage>
  );
}

function providerLabel(provider: RelayUser['provider']): string {
  switch (provider) {
    case 'github':
      return 'GitHub';
    case 'google':
      return 'Google';
    default:
      return tJoin('confirm.providerDev');
  }
}

function Problem({ title, body }: { title: string; body: string }) {
  const { router } = useAppServices();
  const titleId = useId();
  return (
    <FullPage tone="warning" role="main" labelledBy={titleId} testId="join-problem">
      <h1 id={titleId}>{title}</h1>
      <p className="app-fullpage__body">{body}</p>
      <div className="app-fullpage__actions">
        <Button variant="primary" onClick={() => router.navigate('/')}>
          {tApp('notFound.home')}
        </Button>
      </div>
    </FullPage>
  );
}

function JoinLogin({ returnPath, error, memoryOnly }: { returnPath: string; error: string | null; memoryOnly: boolean }) {
  const titleId = useId();
  return (
    <FullPage role="main" labelledBy={titleId} testId="join-login">
      <h1 id={titleId}>{tJoin('login.title')}</h1>
      <p className="app-fullpage__body">{tJoin('login.body')}</p>
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
      {memoryOnly ? (
        <Banner tone="warning" live="none">
          {tJoin('storageMemory')}
        </Banner>
      ) : null}
      <LoginPanel returnPath={returnPath} />
    </FullPage>
  );
}

function KeyChangeConfirm({ onConfirm, onCancel }: { onConfirm(): void; onCancel(): void }) {
  const titleId = useId();
  const bodyId = useId();
  return (
    <FullPage tone="warning" role="alertdialog" labelledBy={titleId} describedBy={bodyId} testId="key-change-confirm">
      <div className="app-fullpage__icon">
        <IconKey size={32} />
      </div>
      <h1 id={titleId}>{tJoin('keyChange.title')}</h1>
      <div id={bodyId} className="app-fullpage__body">
        <p>{tJoin('keyChange.lead')}</p>
        <p>{tJoin('keyChange.reason')}</p>
        <p>
          <strong>{tJoin('keyChange.ask')}</strong>
        </p>
      </div>
      <div className="app-fullpage__actions">
        <Button variant="primary" onClick={onCancel}>
          {tJoin('keyChange.cancel')}
        </Button>
        <Button variant="secondary" onClick={onConfirm}>
          {tJoin('keyChange.confirm')}
        </Button>
      </div>
    </FullPage>
  );
}

/** Step 4–5: one connection in invite mode, shared with the workspace page afterwards. */
function JoinConnect({ workspaceId, invite, preferInvite, manager }: { workspaceId: string; invite: InviteTrust; preferInvite: boolean; manager: WorkspaceManager }) {
  const { router, sessionStorage, recent, keyStorage } = useAppServices();
  const [handle, setHandle] = useState<WorkspaceHandle | null>(null);
  const done = useRef(false);

  useEffect(() => {
    const acquired = manager.acquire(workspaceId, { invite, preferInvite });
    setHandle(acquired);
    // Fetch the workspace chunk while the handshake runs, so the hand-over after admission is immediate. A chunk that
    // does not come is said by the workspace route itself, which asks for it again (app/PageBoundary.tsx).
    void loadChunk(() => import('../workspace/WorkspaceRoute.tsx')).catch(() => {});
    return () => acquired.release();
  }, [manager, workspaceId, invite, preferInvite]);

  const connection = handle?.session.connection ?? null;
  const state = useStore(
    handle ? handle.session.stores.connection : IDLE_SOURCE,
  );

  useEffect(() => {
    if (!connection || done.current) return;
    if (state.kind === 'online') {
      done.current = true;
      // Admitted: the daemon key is pinned and the invite was used. The secret has no further purpose here.
      clearPendingInvite(sessionStorage, workspaceId);
      const welcome = state.welcome;
      recent.remember({ id: workspaceId, name: welcome.workspace.name, hostName: welcome.workspace.hostName });
      router.navigate(routePath({ name: 'workspace', workspaceId }), { replace: true });
      return;
    }
    if (!isTerminalState(state)) return;
    // Logging in again, or leaving the page, is not a refusal.
    if (state.kind === 'closed' && (state.reason === 'login-required' || state.reason === 'local')) return;
    // Nothing was used up and the screen says "Reload the page": the reload needs the invite to ask "Join?" again.
    // (The key storage notes a newer page's record before the connection ends on it: read here, it is already there.)
    if (reloadIsAWayOut(state, { newerKeyRecord: keyStorage.getState().newerRecord })) return;
    // Refused for good (key mismatch, invalid invite, kicked, …): the link cannot be used again.
    clearPendingInvite(sessionStorage, workspaceId);
  }, [state, connection, sessionStorage, workspaceId, recent, router, keyStorage]);

  return <JoinStatus state={state} workspaceId={workspaceId} />;
}

const IDLE_STATE: ConnectionState = { kind: 'idle' };
const IDLE_SOURCE = { getState: () => IDLE_STATE, subscribe: () => () => {} };

function JoinStatus({ state, workspaceId }: { state: ConnectionState; workspaceId: string }) {
  const view = describeConnection(state);
  if (state.kind === 'key-mismatch') return <KeyMismatchScreen state={state} />;
  if (view.kind === 'login-required') return <LoginRequiredScreen view={view} returnPath={routePath({ name: 'join', workspaceId })} />;
  if (view.blocking) return <ConnectionEndedScreen view={view} state={state} />;
  if (state.kind === 'online') return <ConnectingScreen view={{ ...view, detail: tJoin('done') }} title={tJoin('connecting.title')} />;
  if (state.kind === 'host-offline') return <ConnectingScreen view={{ ...view, detail: tJoin('connecting.hostOffline') }} title={tJoin('connecting.title')} />;
  return <ConnectingScreen view={view} title={tJoin('connecting.title')} />;
}
