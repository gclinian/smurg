import { RelayApi, RelayApiError } from '@smurg/protocol/client';
import { describe, expect, it, vi } from 'vitest';
import { createRelayAuthClient, type OptionsFetch } from './auth.ts';
import { SESSION_HINT_COOKIE, SESSION_HINT_MAX_AGE_S, createSessionHint } from './session-hint.ts';

function relayWith(status: number, body: unknown, calls: string[] = []): RelayApi {
  return new RelayApi({
    relayUrl: 'http://localhost:5173',
    auth: { kind: 'cookie' },
    fetch: async (url) => {
      calls.push(String(url));
      return { status, text: async () => JSON.stringify(body) };
    },
  });
}

/** document.cookie's semantics, as far as the hint uses them: set / replace by name, Max-Age=0 deletes. */
class CookieJar {
  readonly jar = new Map<string, string>();
  readonly written: string[] = [];
  get cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  set cookie(line: string) {
    this.written.push(line);
    const [pair, ...attributes] = line.split(';').map((part) => part.trim());
    const [name, value] = (pair ?? '').split('=') as [string, string];
    if (attributes.some((attribute) => attribute === 'Max-Age=0')) this.jar.delete(name);
    else this.jar.set(name, value);
  }
  has(): boolean {
    return this.jar.get(SESSION_HINT_COOKIE) === '1';
  }
}

describe('relay login client', () => {
  it('builds OAuth URLs that return to an absolute in-app URL without a fragment', () => {
    const auth = createRelayAuthClient({ relay: relayWith(200, {}), origin: 'http://localhost:5173' });
    const url = new URL(auth.loginUrl('github', '/join/ws_test_workspace_0001'));
    expect(url.origin + url.pathname).toBe('http://localhost:5173/auth/github/login');
    expect(url.searchParams.get('return_to')).toBe('http://localhost:5173/join/ws_test_workspace_0001');
    expect(() => auth.loginUrl('google', '/join/x#k=1&s=2')).toThrow();
    expect(() => auth.loginUrl('google', 'https://evil.test/')).toThrow();
    expect(() => auth.loginUrl('google', '//evil.test/')).toThrow();
  });

  it('builds the dev login URL and refuses user names the relay would refuse', () => {
    const auth = createRelayAuthClient({ relay: relayWith(200, {}), origin: 'http://localhost:5173' });
    const url = new URL(auth.devLoginUrl('amy', ' Amy 林 ', '/'));
    expect(url.pathname).toBe('/auth/dev/start');
    expect(url.searchParams.get('user')).toBe('amy');
    expect(url.searchParams.get('name')).toBe('Amy 林');
    expect(url.searchParams.get('return_to')).toBe('http://localhost:5173/');
    expect(() => auth.devLoginUrl('a b', undefined, '/')).toThrow();
  });

  /** GET /api/login-options answering `status` with `body`. */
  function optionsWith(status: number, body: unknown) {
    return vi.fn<OptionsFetch>(async () => ({ status, json: async () => body }));
  }

  it('asks the relay once, GET /api/login-options, and offers exactly what it says (no probes of the login routes)', async () => {
    const fetch = optionsWith(200, { providers: { github: false, google: true }, dev: true });
    const auth = createRelayAuthClient({ relay: relayWith(200, {}), origin: 'http://localhost:5173', fetch });
    expect(await auth.loginOptions()).toEqual({ providers: ['google'], dev: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('http://localhost:5173/api/login-options', {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    expect(await createRelayAuthClient({ relay: relayWith(200, {}), origin: 'https://smurg.app', fetch: optionsWith(200, { providers: { github: true, google: true }, dev: false }) }).loginOptions()).toEqual({
      providers: ['github', 'google'],
      dev: false,
    });
  });

  it('refuses an answer it does not understand (extra fields, a missing flag, an HTTP error, no network): the caller falls back, never to dev login', async () => {
    for (const fetch of [
      optionsWith(200, { providers: { github: true, google: true }, dev: true, githubClientId: 'x' }),
      optionsWith(200, { providers: { github: true }, dev: true }),
      optionsWith(200, { providers: { github: true, google: true }, dev: 'yes' }),
      optionsWith(404, { error: 'not_found' }),
      optionsWith(503, {}),
      vi.fn<OptionsFetch>(async () => {
        throw new TypeError('network');
      }),
    ]) {
      await expect(createRelayAuthClient({ relay: relayWith(200, {}), origin: 'http://localhost:5173', fetch }).loginOptions()).rejects.toThrow();
    }
  });

  it('me() asks nothing when no relay session can exist in this browser (a clean console for logged-out visitors), and asks once a login started', async () => {
    const cookies = new CookieJar();
    cookies.jar.set('other', 'x');
    const calls: string[] = [];
    const auth = createRelayAuthClient({ relay: relayWith(401, { error: 'unauthorized' }, calls), origin: 'http://localhost:5173', hint: createSessionHint(cookies, { secure: false }) });
    expect(await auth.me()).toBeNull();
    expect(calls).toEqual([]);
    // Starting a login (the page navigates to the relay right after) makes the next page ask: a host-wide cookie, like
    // the relay's session (a dev front end on another port of the same host sees it too).
    auth.devLoginUrl('amy', undefined, '/');
    expect(cookies.written.at(-1)).toBe(`${SESSION_HINT_COOKIE}=1; Max-Age=${SESSION_HINT_MAX_AGE_S}; Path=/; SameSite=Lax`);
    expect(await auth.me()).toBeNull();
    expect(calls).toEqual(['http://localhost:5173/api/me']);
    // …and a 401 forgets it again: the next load of a logged-out page asks nothing.
    expect(cookies.has()).toBe(false);
    expect(cookies.jar.get('other')).toBe('x');
    expect(await auth.me()).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('a session seen (logged in, a workspace admitted) keeps asking; logging out forgets it; no usable cookies always asks; Secure on https', async () => {
    const cookies = new CookieJar();
    const user = { user: { userId: 'dev:amy', displayName: 'Amy', provider: 'dev' } };
    const auth = createRelayAuthClient({ relay: relayWith(200, user), origin: 'http://localhost:5173', hint: createSessionHint(cookies, { secure: false }) });
    auth.sessionSeen();
    expect(await auth.me()).toMatchObject({ userId: 'dev:amy' });
    expect(cookies.has()).toBe(true);
    auth.loginUrl('github', '/');
    expect(cookies.has()).toBe(true);
    await auth.logout();
    expect(cookies.has()).toBe(false);

    const secure = new CookieJar();
    createSessionHint(secure, { secure: true }).set();
    expect(secure.written).toEqual([`${SESSION_HINT_COOKIE}=1; Max-Age=${SESSION_HINT_MAX_AGE_S}; Path=/; SameSite=Lax; Secure`]);

    const throwing = {
      get cookie(): string {
        throw new Error('SecurityError');
      },
      set cookie(_value: string) {
        throw new Error('SecurityError');
      },
    };
    const calls: string[] = [];
    for (const hint of [createSessionHint(throwing, { secure: false }), createSessionHint(null), createSessionHint(new CookieJar(), { secure: false, enabled: false })]) {
      hint.clear();
      expect(await createRelayAuthClient({ relay: relayWith(200, user, calls), origin: 'http://localhost:5173', hint }).me()).toMatchObject({ userId: 'dev:amy' });
    }
    expect(calls).toHaveLength(3);
  });

  it('me(): null when logged out, the user when logged in, and a rejection when the relay is down', async () => {
    const loggedOut = createRelayAuthClient({ relay: relayWith(401, { error: 'unauthorized' }), origin: 'http://localhost:5173' });
    expect(await loggedOut.me()).toBeNull();
    const loggedIn = createRelayAuthClient({
      relay: relayWith(200, { user: { userId: 'dev:amy', displayName: 'Amy', provider: 'dev' } }),
      origin: 'http://localhost:5173',
    });
    expect(await loggedIn.me()).toMatchObject({ userId: 'dev:amy' });
    const down = createRelayAuthClient({ relay: relayWith(502, { error: 'bad_gateway' }), origin: 'http://localhost:5173' });
    await expect(down.me()).rejects.toBeInstanceOf(RelayApiError);
  });
});
