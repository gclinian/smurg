// Real-browser harness for the web acceptance tests (ARCHITECTURE §10 "Browser | apps/web/e2e"):
//
//   the REAL relay (local workerd, @smurg/relay test support) + the REAL daemon (tests/e2e harness: createDaemon with
//   the production host sockets) + THIS app served by the Vite dev server (the app's own vite.config.ts, relay routes
//   proxied, exactly the documented development setup) + system Chrome driven headless by playwright-core.
//
// localhost only, fresh browser contexts (no profile, no cookies imported), no real account. Everything started here
// is stopped by stop(). Test-only relative imports into tests/e2e and apps/relay: the harness and the MITM relay live
// there, and the web package must not depend on them at run time.
import { mkdtemp } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { createServer as createViteServer, type ProxyOptions, type ViteDevServer } from 'vite';
import { RELAY_DEV_PROXY_PREFIXES } from '@smurg/protocol/relay';
import { startLocalRelay, type LocalRelay } from '../../relay/test-support/index.ts';
import { startStack, type Stack } from '../../../tests/e2e/src/harness.ts';
import { chromeLaunchOptions, systemChrome } from './chrome.ts';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

export { systemChrome } from './chrome.ts';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no free port'))));
    });
  });
}

type ProxyReq = { getHeader(name: string): unknown; setHeader(name: string, value: string): void };

/**
 * The MITM relay forwards only the Authorization header (like a relay behind a proxy would); a browser session is a
 * cookie. This turns the cookie into the same session as a bearer token so the attacker is fully functional.
 */
function cookieToBearer(proxyReq: ProxyReq): void {
  const match = /(?:^|;\s*)(?:__Host-)?smurg_session=([^;]+)/.exec(String(proxyReq.getHeader('cookie') ?? ''));
  if (match) proxyReq.setHeader('authorization', `Bearer ${match[1]}`);
}

/** The app on the Vite dev server at http://localhost:<port>, proxying the relay routes to `upstream`. */
export async function startWeb(options: { port: number; upstream: string; bearerFromCookie?: boolean; cacheDir: string }): Promise<ViteDevServer> {
  const proxy: Record<string, ProxyOptions> = Object.fromEntries(
    RELAY_DEV_PROXY_PREFIXES.map((prefix) => [
      prefix,
      {
        target: options.upstream,
        ws: true,
        changeOrigin: false,
        ...(options.bearerFromCookie
          ? {
              configure: (server) => {
                server.on('proxyReq', (proxyReq) => cookieToBearer(proxyReq as unknown as ProxyReq));
                server.on('proxyReqWs', (proxyReq) => cookieToBearer(proxyReq as unknown as ProxyReq));
              },
            }
          : {}),
      } satisfies ProxyOptions,
    ]),
  );
  const server = await createViteServer({
    configFile: join(WEB_ROOT, 'vite.config.ts'),
    root: WEB_ROOT,
    logLevel: 'error',
    cacheDir: options.cacheDir,
    server: { host: 'localhost', port: options.port, strictPort: true, hmr: false, watch: null, proxy },
  });
  await server.listen();
  return server;
}

export interface WebStack {
  readonly relay: LocalRelay;
  readonly stack: Stack;
  readonly browser: Browser;
  /** http://localhost:<port> of the honest front end. */
  readonly webOrigin: string;
  readonly web: ViteDevServer;
  /** A new invite made by the host, pointing at `origin` (default: the honest front end). */
  invite(origin?: string): Promise<string>;
  stop(): Promise<void>;
}

export async function startWebStack(options: { tmpDir: string; extraOrigins?: readonly string[] }): Promise<WebStack> {
  const executablePath = systemChrome();
  if (!executablePath) throw new Error('no system Chrome');
  const port = await freePort();
  const webOrigin = `http://localhost:${port}`;
  const started: (() => Promise<void>)[] = [];
  try {
    // The browser's pages are on the Vite origin(s): the relay must accept their Origin for cookie sessions.
    const relay = await startLocalRelay({ tap: false, vars: { ALLOWED_ORIGINS: [webOrigin, ...(options.extraOrigins ?? [])].join(',') } });
    started.push(() => relay.stop());
    const stack = await startStack({ relay, tap: false, projectFiles: { 'README.md': '# Class project\n', 'src/app.ts': 'export const x = 1;\n' } });
    started.push(() => stack.stop());
    // A dependency-optimizer cache of its own: two test files start their stacks in parallel forks, and two Vite
    // servers optimizing into ONE cache dir race on its final rename (ENOTEMPTY), leaving both pages unloaded.
    const web = await startWeb({ port, upstream: relay.origin, cacheDir: await mkdtemp(join(options.tmpDir, 'vite-cache-')) });
    started.push(() => web.close());
    const browser = await chromium.launch(chromeLaunchOptions(executablePath));
    started.push(() => browser.close());
    return {
      relay,
      stack,
      browser,
      webOrigin,
      web,
      async invite(origin = webOrigin) {
        // The daemon prints links for the relay's origin; the web app lives on the Vite origin in this setup.
        return (await stack.createInvite('editor')).replace(relay.origin, origin);
      },
      async stop() {
        for (const stop of started.splice(0).reverse()) await stop().catch(() => {});
      },
    };
  } catch (error) {
    for (const stop of started.splice(0).reverse()) await stop().catch(() => {});
    throw error;
  }
}
