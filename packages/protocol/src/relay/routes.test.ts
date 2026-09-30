import { describe, expect, it } from 'vitest';
import {
  RELAY_DEV_PROXY_PREFIXES,
  RELAY_PATHS,
  RELAY_WORKER_FIRST_PATTERNS,
  RelayUrlError,
  authCallbackPath,
  authLoginPath,
  isLocalHostname,
  isWorkspaceId,
  loginOptionsUrl,
  matchTunnelPath,
  relayHttpUrl,
  relayOrigin,
  tunnelPath,
  wsClientUrl,
  wsHostUrl,
  xferClientUrl,
  xferHostUrl,
} from './routes.ts';

const WS = 'AbCdEfGh_-012345';

/** wrangler `run_worker_first` semantics for the patterns we use: exact path, or "<prefix>/*". */
function workerFirst(pathname: string): boolean {
  return RELAY_WORKER_FIRST_PATTERNS.some((p) => (p.endsWith('/*') ? pathname.startsWith(p.slice(0, -1)) : pathname === p));
}

describe('tunnel URLs', () => {
  it('builds wss URLs from an https relay', () => {
    expect(wsHostUrl('https://smurg.app', WS)).toBe(`wss://smurg.app/ws/${WS}/host`);
    expect(wsClientUrl('https://smurg.app/', WS)).toBe(`wss://smurg.app/ws/${WS}/client`);
    expect(xferHostUrl(new URL('https://relay.smurg.app'), WS)).toBe(`wss://relay.smurg.app/xfer/${WS}/host`);
    expect(xferClientUrl('https://smurg.app:8443', WS)).toBe(`wss://smurg.app:8443/xfer/${WS}/client`);
  });

  it('allows plain ws only for local development hosts', () => {
    expect(wsClientUrl('http://127.0.0.1:8787', WS)).toBe(`ws://127.0.0.1:8787/ws/${WS}/client`);
    expect(wsHostUrl('http://localhost:8787', WS)).toBe(`ws://localhost:8787/ws/${WS}/host`);
    expect(wsHostUrl('http://[::1]:8787', WS)).toBe(`ws://[::1]:8787/ws/${WS}/host`);
    expect(() => wsHostUrl('http://smurg.app', WS)).toThrow(RelayUrlError);
    expect(() => wsHostUrl('http://192.168.1.10:8787', WS)).toThrow(RelayUrlError);
  });

  it('refuses relay URLs with credentials, paths, queries, fragments or other schemes', () => {
    for (const bad of [
      'https://user:pw@smurg.app',
      'https://smurg.app/prefix',
      'https://smurg.app/?x=1',
      'https://smurg.app/#frag',
      'ftp://smurg.app',
      'wss://smurg.app',
      'not a url',
    ]) {
      expect(() => relayOrigin(bad)).toThrow(RelayUrlError);
    }
  });

  it('refuses invalid workspace ids', () => {
    for (const bad of ['short', 'x'.repeat(65), 'has space in the id!', '../../etc/passwd000', 'ünïcode-ünïcode-1']) {
      expect(isWorkspaceId(bad)).toBe(false);
      expect(() => wsClientUrl('https://smurg.app', bad)).toThrow(RelayUrlError);
    }
    expect(isWorkspaceId(WS)).toBe(true);
    expect(isWorkspaceId('x'.repeat(64))).toBe(true);
  });
});

describe('matchTunnelPath', () => {
  it('matches exactly the four tunnel routes', () => {
    expect(matchTunnelPath(`/ws/${WS}/host`)).toEqual({ kind: 'ws', workspaceId: WS, role: 'host' });
    expect(matchTunnelPath(`/xfer/${WS}/client`)).toEqual({ kind: 'xfer', workspaceId: WS, role: 'client' });
    expect(matchTunnelPath(tunnelPath('ws', WS, 'client'))).toEqual({ kind: 'ws', workspaceId: WS, role: 'client' });
  });

  it('rejects near misses', () => {
    for (const bad of [
      `/ws/${WS}/host/`,
      `/ws/${WS}/admin`,
      `/ws/${WS}`,
      `/api/${WS}/host`,
      `/ws/short/host`,
      `/ws/${WS}%2F/host`,
      `//ws/${WS}/host`,
      `/WS/${WS}/host`,
    ]) {
      expect(matchTunnelPath(bad)).toBeNull();
    }
  });
});

describe('fixed paths', () => {
  it('builds auth paths for the supported providers only', () => {
    expect(authLoginPath('github')).toBe('/auth/github/login');
    expect(authCallbackPath('google')).toBe('/auth/google/callback');
    expect(() => authLoginPath('dev' as 'github')).toThrow(RelayUrlError);
  });

  it('builds absolute http URLs', () => {
    expect(relayHttpUrl('https://smurg.app', RELAY_PATHS.identityToken)).toBe('https://smurg.app/api/identity-token');
    expect(relayHttpUrl('http://localhost:8787', RELAY_PATHS.jwks)).toBe('http://localhost:8787/.well-known/jwks.json');
    expect(() => relayHttpUrl('https://smurg.app', 'api/me')).toThrow(RelayUrlError);
    expect(() => relayHttpUrl('https://smurg.app', '//evil.example/x')).toThrow(RelayUrlError);
  });

  it('builds the login-options URL on the relay origin only', () => {
    expect(RELAY_PATHS.loginOptions).toBe('/api/login-options');
    expect(loginOptionsUrl('https://smurg.app')).toBe('https://smurg.app/api/login-options');
    expect(loginOptionsUrl(new URL('http://localhost:8787/'))).toBe('http://localhost:8787/api/login-options');
    for (const bad of ['http://smurg.app', 'https://smurg.app/prefix', 'https://user:pw@smurg.app', 'not a url']) {
      expect(() => loginOptionsUrl(bad), bad).toThrow(RelayUrlError);
    }
  });

  it('routes every relay endpoint to the Worker before static assets', () => {
    const paths = [
      ...Object.values(RELAY_PATHS),
      authLoginPath('github'),
      authCallbackPath('google'),
      tunnelPath('ws', WS, 'host'),
      tunnelPath('xfer', WS, 'client'),
    ];
    for (const path of paths) expect(workerFirst(path), path).toBe(true);
    for (const spa of ['/', '/join/abc', '/w/abc', '/w/abc/console', '/assets/index.js', '/wsx']) {
      expect(workerFirst(spa), spa).toBe(false);
    }
  });

  it('proxies the same prefixes from the web dev server', () => {
    const asPrefix = RELAY_WORKER_FIRST_PATTERNS.map((p) => (p.endsWith('/*') ? p.slice(0, -1) : p));
    expect([...RELAY_DEV_PROXY_PREFIXES].sort()).toEqual([...asPrefix].sort());
  });
});

describe('isLocalHostname', () => {
  it('knows exactly the loopback names', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', '::1', 'relay.localhost', 'LOCALHOST']) {
      expect(isLocalHostname(h), h).toBe(true);
    }
    for (const h of ['smurg.app', 'localhost.evil.example', '127.0.0.2', '0.0.0.0', 'mylocalhost']) {
      expect(isLocalHostname(h), h).toBe(false);
    }
  });
});
