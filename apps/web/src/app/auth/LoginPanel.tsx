// Login buttons (GitHub, Google) and, only when the relay reports it, the dev-only login form.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { DEV_USER_PATTERN, type LoginOptions } from '../../lib/relay/auth.ts';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Input } from '../../ui/index.ts';
import { useAppServices } from '../services.tsx';

export interface LoginPanelProps {
  /** Where the person comes back to after logging in (an in-app path, never with a fragment). */
  returnPath: string;
}

export function LoginPanel({ returnPath }: LoginPanelProps) {
  const { auth, router } = useAppServices();
  const [options, setOptions] = useState<LoginOptions | null>(null);

  useEffect(() => {
    let alive = true;
    auth.loginOptions().then(
      (value) => {
        if (alive) setOptions(value);
      },
      () => {
        if (alive) setOptions({ providers: ['github', 'google'], dev: false });
      },
    );
    return () => {
      alive = false;
    };
  }, [auth]);

  const providers = options?.providers ?? ['github', 'google'];
  return (
    <div className="app-login">
      <div className="app-login__providers">
        {providers.includes('github') ? (
          <Button variant="primary" onClick={() => router.assignExternal(auth.loginUrl('github', returnPath))}>
            {tApp('login.github')}
          </Button>
        ) : null}
        {providers.includes('google') ? (
          <Button variant="secondary" onClick={() => router.assignExternal(auth.loginUrl('google', returnPath))}>
            {tApp('login.google')}
          </Button>
        ) : null}
      </div>
      {options !== null && providers.length === 0 && !options.dev ? (
        <Banner tone="warning" live="status">
          {tApp('login.none')}
        </Banner>
      ) : null}
      {options?.dev ? <DevLoginForm returnPath={returnPath} /> : null}
    </div>
  );
}

function DevLoginForm({ returnPath }: { returnPath: string }) {
  const { auth, router } = useAppServices();
  const [user, setUser] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const name = user.trim();
    if (!DEV_USER_PATTERN.test(name)) {
      setError(tApp('login.dev.invalid'));
      return;
    }
    router.assignExternal(auth.devLoginUrl(name, displayName, returnPath));
  };

  return (
    <form className="app-login__dev" onSubmit={submit} aria-labelledby={titleId} data-testid="dev-login-form">
      <h3 id={titleId}>{tApp('login.dev.title')}</h3>
      <Banner tone="warning" live="none">
        {tApp('login.dev.note')}
      </Banner>
      <div className="app-login__dev-fields">
        <Input
          label={tApp('login.dev.user')}
          hint={tApp('login.dev.userHint')}
          error={error ?? undefined}
          value={user}
          autoComplete="username"
          spellCheck={false}
          onChange={(event) => {
            setUser(event.currentTarget.value);
            setError(null);
          }}
        />
        <Input label={tApp('login.dev.displayName')} value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} />
      </div>
      <Button type="submit" variant="secondary">
        {tApp('login.dev.submit')}
      </Button>
    </form>
  );
}
