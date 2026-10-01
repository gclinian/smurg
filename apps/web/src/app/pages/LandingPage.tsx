// "/": what smurg is, login, and the workspaces this browser opened before.
import { useEffect, useState } from 'react';
import type { RelayUser } from '@smurg/protocol/client';
import { describeError } from '../../lib/errors.ts';
import { formatRelativeTime } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { routePath } from '../../lib/router.ts';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, EmptyState, IconButton, Spinner } from '../../ui/index.ts';
import { IconClose, IconLightbulb, IconMonitor, IconShield } from '../../ui/icons.tsx';
import { LoginPanel } from '../auth/LoginPanel.tsx';
import { Link } from '../navigation.tsx';
import { useAppServices } from '../services.tsx';
import { ThemeMenu } from '../ThemeMenu.tsx';

/** The user guides and smurg's license on the product site; the web app's own third-party notices on this origin. */
const DOCS_URL = 'https://smurg.ai/docs/';
const LICENSE_URL = 'https://smurg.ai/license/';
const NOTICES_PATH = '/third-party-notices.txt';

type Me = { readonly kind: 'loading' } | { readonly kind: 'anonymous' } | { readonly kind: 'user'; readonly user: RelayUser } | { readonly kind: 'error'; readonly message: string };

export function LandingPage() {
  const { auth, recent } = useAppServices();
  const [me, setMe] = useState<Me>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const recentList = useStore(recent);

  useEffect(() => {
    let alive = true;
    setMe({ kind: 'loading' });
    auth.me().then(
      (user) => {
        if (alive) setMe(user ? { kind: 'user', user } : { kind: 'anonymous' });
      },
      (error: unknown) => {
        if (alive) setMe({ kind: 'error', message: describeError(error) });
      },
    );
    return () => {
      alive = false;
    };
  }, [auth, attempt]);

  return (
    <div className="app-landing">
      <header className="app-landing__header">
        <span className="app-wordmark">{tApp('name')}</span>
        <ThemeMenu />
      </header>
      <main className="app-landing__main" id="main">
        <section className="app-landing__intro" aria-labelledby="landing-title">
          <h1 id="landing-title">{tApp('tagline')}</h1>
          <p className="app-landing__lead">{tApp('landing.lead')}</p>
          <ul className="app-landing__points">
            <li>
              <IconShield /> {tApp('landing.points.e2e')}
            </li>
            <li>
              <IconMonitor /> {tApp('landing.points.host')}
            </li>
            <li>
              <IconLightbulb /> {tApp('landing.points.suggest')}
            </li>
          </ul>
        </section>

        <section className="app-landing__card" aria-labelledby="landing-login">
          <h2 id="landing-login">{tApp('login.title')}</h2>
          {me.kind === 'loading' ? (
            <p className="app-landing__muted">
              <Spinner size={14} decorative /> {tApp('login.checking')}
            </p>
          ) : me.kind === 'user' ? (
            <SignedIn user={me.user} onLoggedOut={() => setAttempt((n) => n + 1)} />
          ) : me.kind === 'error' ? (
            <Banner
              tone="danger"
              title={tApp('login.relayDown')}
              actions={
                <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
                  {tApp('login.retry')}
                </Button>
              }
            >
              {me.message}
            </Banner>
          ) : (
            <>
              <p className="app-landing__muted">{tApp('login.lead')}</p>
              <LoginPanel returnPath="/" />
            </>
          )}
        </section>

        <section className="app-landing__card" aria-labelledby="landing-recent">
          <h2 id="landing-recent">{tApp('landing.recent')}</h2>
          {recentList.length === 0 ? (
            <EmptyState compact title={tApp('landing.recent.empty')} />
          ) : (
            <ul className="app-recent">
              {recentList.map((item) => (
                <li key={item.id} className="app-recent__item">
                  <Link to={routePath({ name: 'workspace', workspaceId: item.id })} className="app-recent__link">
                    <span className="app-recent__name">{item.name ?? item.id}</span>
                    <span className="app-recent__meta">
                      {item.hostName ? `${item.hostName} · ` : ''}
                      {tApp('landing.recent.lastOpened', { time: formatRelativeTime(item.lastOpenedAt) })}
                    </span>
                  </Link>
                  <IconButton label={tApp('landing.recent.forget')} icon={<IconClose />} size="sm" onClick={() => recent.forget(item.id)} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="app-landing__card app-landing__help" aria-labelledby="landing-help">
          <h2 id="landing-help" className="ui-visually-hidden">
            {tApp('landing.howToJoin.title')}
          </h2>
          <div>
            <h3>{tApp('landing.howToJoin.title')}</h3>
            <p>{tApp('landing.howToJoin.body')}</p>
          </div>
          <div>
            <h3>{tApp('landing.howToHost.title')}</h3>
            <p>{tApp('landing.howToHost.body')}</p>
          </div>
        </section>
      </main>
      <footer className="app-landing__footer">
        <a href={DOCS_URL}>{tApp('landing.footer.docs')}</a>
        <a href={LICENSE_URL}>{tApp('landing.footer.license')}</a>
        {/* Served by this origin from the web build (public/third-party-notices.txt), not an in-app route. */}
        <a href={NOTICES_PATH}>{tApp('landing.footer.notices')}</a>
      </footer>
    </div>
  );
}

function SignedIn({ user, onLoggedOut }: { user: RelayUser; onLoggedOut(): void }) {
  const { auth } = useAppServices();
  const [busy, setBusy] = useState(false);
  return (
    <div className="app-landing__signed-in">
      <p>{tApp('login.signedInAs', { name: user.displayName })}</p>
      <Button
        size="sm"
        loading={busy}
        onClick={() => {
          setBusy(true);
          auth
            .logout()
            .catch(() => {})
            .finally(() => {
              setBusy(false);
              onLoggedOut();
            });
        }}
      >
        {tApp('login.logout')}
      </Button>
    </div>
  );
}
