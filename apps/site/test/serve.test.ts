// The site as Cloudflare serves it: wrangler.jsonc as it is, the Worker in a local workerd behind the real
// static-assets layer (run_worker_first, html_handling, not_found_handling, public/_headers), through wrangler's
// createTestHarness, the runtime `wrangler dev` uses. 127.0.0.1 only; nothing is deployed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestHarness } from 'wrangler';
import { registerOwnChildren } from '../../../packages/daemon/src/testing/run-registry.ts';
import { DOCS, DOCS_FILE_BASE, INSTALL_SCRIPT, REPOSITORY } from '../src/routes.ts';
import { PUBLIC, SITE_ROOT, readPublic } from './html.ts';

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
});

afterAll(async () => {
  await harness?.close();
});

/** A request as a browser on `url` would send it; redirects are returned, not followed. */
async function get(url: string): Promise<Response> {
  if (harness === undefined) throw new Error('no harness');
  return (await harness.fetch(url, { redirect: 'manual' })) as unknown as Response;
}

/** The security headers public/_headers sets for every path. */
const HEADERS = (() => {
  const block = /^\/\*\n((?:[ \t]+.+\n)+)/m.exec(readPublic('_headers'))?.[1] ?? '';
  return [...block.matchAll(/^[ \t]+([A-Za-z-]+): (.+)$/gm)].map((m) => [m[1] as string, m[2] as string] as const);
})();

function expectSecurityHeaders(response: Response, what: string): void {
  expect(HEADERS.map(([name]) => name)).toEqual(expect.arrayContaining(['Content-Security-Policy', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']));
  for (const [name, value] of HEADERS) expect(response.headers.get(name), `${what}: ${name}`).toBe(value);
}

describe('smurg.ai in workerd', () => {
  it('serves both home pages as they are in public/, with the security headers', async () => {
    for (const [path, file] of [
      ['https://smurg.ai/', 'index.html'],
      ['https://smurg.ai/zh-TW/', 'zh-TW/index.html'],
    ] as const) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(/^text\/html/);
      expectSecurityHeaders(response, path);
      expect(await response.text(), path).toBe(readPublic(file));
    }
  });

  it('serves the stylesheet, the script and the icon with their types, cache times and the same headers', async () => {
    for (const [path, type, cache] of [
      ['/style.css', /^text\/css/, 'public, max-age=3600'],
      ['/copy.js', /javascript/, 'public, max-age=3600'],
      ['/favicon.svg', /^image\/svg\+xml/, 'public, max-age=86400'],
      ['/robots.txt', /^text\/plain/, null],
      ['/sitemap.xml', /xml/, null],
    ] as const) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(type);
      if (cache !== null) expect(response.headers.get('cache-control'), path).toBe(cache);
      expectSecurityHeaders(response, path);
      expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(join(PUBLIC, path))), path).toBe(true);
    }
  });

  it('adds the trailing slash and drops index.html (html_handling)', async () => {
    for (const [path, to] of [
      ['/zh-TW', '/zh-TW/'],
      ['/index.html', '/'],
      ['/zh-TW/index.html', '/zh-TW/'],
    ] as const) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBeGreaterThanOrEqual(301);
      expect(response.status, path).toBeLessThanOrEqual(308);
      expect(new URL(response.headers.get('location') ?? '', 'https://smurg.ai').pathname, path).toBe(to);
    }
  });

  it('runs the Worker for the redirects: /install.sh, /github, /docs and /docs/<file>', async () => {
    for (const [path, location] of [
      ['/install.sh', INSTALL_SCRIPT],
      ['/github', REPOSITORY],
      ['/github/', REPOSITORY],
      ['/docs', DOCS],
      ['/docs/', DOCS],
      ['/docs/HOSTING.md', `${DOCS_FILE_BASE}HOSTING.md`],
    ] as const) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(302);
      expect(response.headers.get('location'), path).toBe(location);
    }
  });

  it('answers unknown paths with the 404 page of their language, status 404 (served by the assets themselves)', async () => {
    for (const [path, file] of [
      ['/no-such-page', '404.html'],
      ['/install', '404.html'],
      ['/docs/.env', '404.html'],
      ['/_headers', '404.html'],
      ['/zh-TW/no-such-page', 'zh-TW/404.html'],
    ] as const) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe(readPublic(file));
    }
  });

  it('sends www.smurg.ai to smurg.ai on the paths that run the Worker (301, path and query kept)', async () => {
    for (const [from, to] of [
      ['https://www.smurg.ai/install.sh', 'https://smurg.ai/install.sh'],
      ['https://www.smurg.ai/github', 'https://smurg.ai/github'],
      ['https://www.smurg.ai/docs/HOSTING.md?x=1', 'https://smurg.ai/docs/HOSTING.md?x=1'],
    ] as const) {
      const response = await get(from);
      expect(response.status, from).toBe(301);
      expect(response.headers.get('location'), from).toBe(to);
    }
  });

  it('serves www.smurg.ai pages and unknown paths without running the Worker (a zone Redirect Rule redirects them)', async () => {
    // The quota trade-off of wrangler.jsonc: a page view or a 404 costs no Worker request, so the www -> apex redirect
    // for them is a Cloudflare Redirect Rule (README.md, "Deploying"); the pages name their canonical URL meanwhile.
    // (Not "/": the harness hands a request for exactly a custom domain's root straight to the Worker.)
    const page = await get('https://www.smurg.ai/zh-TW/');
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(readPublic('zh-TW/index.html'));
    const missing = await get('https://www.smurg.ai/no-such-page');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(readPublic('404.html'));
  });
});
