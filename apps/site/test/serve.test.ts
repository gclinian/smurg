// The site as Cloudflare serves it: wrangler.jsonc as it is (its custom build writes dist/ first), the Worker in a
// local workerd behind the real static-assets layer (run_worker_first, html_handling, not_found_handling, _headers),
// through wrangler's createTestHarness, the runtime `wrangler dev` uses. 127.0.0.1 only; nothing is deployed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestHarness } from 'wrangler';
import { registerOwnChildren } from '../../../packages/daemon/src/testing/run-registry.ts';
import { INSTALL_SCRIPT, REPOSITORY } from '../src/routes.ts';
import { SITE_ROOT, readPublic, testSite } from './html.ts';

let harness: TestHarness | undefined;

beforeAll(async () => {
  const { createTestHarness } = await import('wrangler');
  harness = createTestHarness({ root: SITE_ROOT, workers: [{ configPath: './wrangler.jsonc' }] });
  try {
    await harness.listen();
    // workerd outlives a test worker that dies: the run's registry ends it after the run (run-registry.ts).
    await registerOwnChildren('/bin/workerd ');
  } catch (error) {
    await harness.close().catch(() => undefined);
    harness = undefined;
    throw error;
  }
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/** A request as a browser on `url` would send it; redirects are returned, not followed. */
async function get(url: string): Promise<Response> {
  if (harness === undefined) throw new Error('no harness');
  return (await harness.fetch(url, { redirect: 'manual' })) as unknown as Response;
}

/** A file of the site the tests build (the same inputs as the custom build that wrote dist/ for this workerd). */
function file(path: string): Buffer {
  const data = testSite().files.get(path);
  if (data === undefined) throw new Error(`no ${path} in the site`);
  return data;
}

/** The security headers _headers sets for every path. */
const HEADERS = (() => {
  const block = /^\/\*\n((?:[ \t]+.+\n)+)/m.exec(readPublic('_headers'))?.[1] ?? '';
  return [...block.matchAll(/^[ \t]+([A-Za-z-]+): (.+)$/gm)].map((m) => [m[1] as string, m[2] as string] as const);
})();

function expectSecurityHeaders(response: Response, what: string): void {
  expect(HEADERS.map(([name]) => name)).toEqual(expect.arrayContaining(['Content-Security-Policy', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']));
  for (const [name, value] of HEADERS) expect(response.headers.get(name), `${what}: ${name}`).toBe(value);
}

describe('smurg.ai in workerd', () => {
  it('serves the home pages, the docs and the license pages of both languages as built, with the security headers', async () => {
    for (const [path, page] of [
      ['/', 'index.html'],
      ['/zh-TW/', 'zh-TW/index.html'],
      ['/docs/', 'docs/index.html'],
      ['/docs/hosting/', 'docs/hosting/index.html'],
      ['/docs/joining/', 'docs/joining/index.html'],
      ['/docs/changelog/', 'docs/changelog/index.html'],
      ['/license/', 'license/index.html'],
      ['/zh-TW/docs/', 'zh-TW/docs/index.html'],
      ['/zh-TW/docs/hosting/', 'zh-TW/docs/hosting/index.html'],
      ['/zh-TW/docs/joining/', 'zh-TW/docs/joining/index.html'],
      ['/zh-TW/docs/changelog/', 'zh-TW/docs/changelog/index.html'],
      ['/zh-TW/license/', 'zh-TW/license/index.html'],
    ] as const) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(/^text\/html/);
      expectSecurityHeaders(response, path);
      expect(Buffer.from(await response.arrayBuffer()).equals(file(page)), path).toBe(true);
    }
  });

  it('serves the stylesheet, the script, the icon and the notices with their types, cache times and the same headers', async () => {
    for (const [path, type, cache] of [
      ['/style.css', /^text\/css/, 'public, max-age=3600'],
      ['/copy.js', /javascript/, 'public, max-age=3600'],
      ['/favicon.svg', /^image\/svg\+xml/, 'public, max-age=86400'],
      ['/third-party-notices.txt', /^text\/plain; charset=utf-8$/, 'public, max-age=3600'],
      ['/robots.txt', /^text\/plain/, null],
      ['/sitemap.xml', /xml/, null],
    ] as const) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(type);
      if (cache !== null) expect(response.headers.get('cache-control'), path).toBe(cache);
      expectSecurityHeaders(response, path);
      expect(Buffer.from(await response.arrayBuffer()).equals(file(path.slice(1))), path).toBe(true);
    }
  });

  it('adds the trailing slash and drops index.html (html_handling)', async () => {
    for (const [path, to] of [
      ['/zh-TW', '/zh-TW/'],
      ['/index.html', '/'],
      ['/zh-TW/index.html', '/zh-TW/'],
      ['/docs', '/docs/'],
      ['/docs/hosting', '/docs/hosting/'],
      ['/docs/hosting/index.html', '/docs/hosting/'],
      ['/license', '/license/'],
      ['/zh-TW/docs', '/zh-TW/docs/'],
      ['/zh-TW/docs/hosting', '/zh-TW/docs/hosting/'],
      ['/zh-TW/license', '/zh-TW/license/'],
    ] as const) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBeGreaterThanOrEqual(301);
      expect(response.status, path).toBeLessThanOrEqual(308);
      expect(new URL(response.headers.get('location') ?? '', 'https://smurg.ai').pathname, path).toBe(to);
    }
  });

  it('runs the Worker for /install.sh: 302 to the newest release’s installer on downloads.smurg.ai', async () => {
    const response = await get('https://smurg.ai/install.sh');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(INSTALL_SCRIPT);
    expect(INSTALL_SCRIPT).toBe('https://downloads.smurg.ai/latest/install.sh');
  });

  it('runs the Worker for /github and /source: 302 to the source repository', async () => {
    for (const path of ['/github', '/source']) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(302);
      expect(response.headers.get('location'), path).toBe(REPOSITORY);
    }
    expect(REPOSITORY).toBe('https://github.com/gclinian/smurg');
  });

  it('answers unknown paths with the 404 page of their language (English under /docs/, Chinese under /zh-TW/), status 404', async () => {
    for (const [path, page] of [
      ['/no-such-page', '404.html'],
      ['/install', '404.html'],
      ['/github/', '404.html'],
      ['/github/x', '404.html'],
      ['/_headers', '404.html'],
      ['/docs/HOSTING.md', '404.html'],
      ['/docs/.env', '404.html'],
      ['/docs/research/relay.md', '404.html'],
      ['/zh-TW/no-such-page', 'zh-TW/404.html'],
      ['/zh-TW/docs/HOSTING.md', 'zh-TW/404.html'],
      ['/zh-TW/docs/no-such-page/', 'zh-TW/404.html'],
    ] as const) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(404);
      expect(Buffer.from(await response.arrayBuffer()).equals(file(page)), path).toBe(true);
    }
  });

  it('still sends a www.smurg.ai request that reaches the Worker to smurg.ai (301, path and query kept)', async () => {
    // In production www.smurg.ai is not a route of this Worker: the zone Redirect Rule answers it before any Worker
    // runs (wrangler.jsonc). The Worker's own www branch is defence in depth for a www request that does reach it.
    for (const [from, to] of [['https://www.smurg.ai/install.sh?x=1', 'https://smurg.ai/install.sh?x=1']] as const) {
      const response = await get(from);
      expect(response.status, from).toBe(301);
      expect(response.headers.get('location'), from).toBe(to);
    }
  });

  it('answers a www.smurg.ai page or unknown path from the static assets, without running the Worker', async () => {
    // The quota trade-off of wrangler.jsonc: a page view or a 404 costs no Worker request, so the Worker could not
    // redirect these even if www reached it. In production it does not: the zone Redirect Rule sends every www path
    // to the apex before any Worker (README.md, "Deploying"), and the pages name their canonical URL anyway.
    for (const [path, page] of [
      ['https://www.smurg.ai/', 'index.html'],
      ['https://www.smurg.ai/docs/hosting/', 'docs/hosting/index.html'],
    ] as const) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(file(page)), path).toBe(true);
    }
    const missing = await get('https://www.smurg.ai/no-such-page');
    expect(missing.status).toBe(404);
    expect(Buffer.from(await missing.arrayBuffer()).equals(file('404.html'))).toBe(true);
  });
});
