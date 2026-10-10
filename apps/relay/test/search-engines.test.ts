// The web app's host is not for search results: the product page and the docs are another site (apps/site), and what
// this host serves is an app's shell, a login page and an API. So every answer says `X-Robots-Tag: noindex`: the
// static files through apps/web/public/_headers, the Worker's own through src/lib/http.ts. And /robots.txt is a real
// file that lets crawlers in: a crawler has to fetch a page to read that header, and without the file the app's shell
// would answer /robots.txt as HTML, which a crawler reads as "no rules".
//
// Here: the two files as they are in apps/web/public, and a local relay that serves a web build made of them (the
// production Worker and the real static-assets layer; 127.0.0.1 only).
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAY_PATHS, RELAY_WORKER_FIRST_PATTERNS } from '@smurg/protocol/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rootHeaderLines, webDistProblem } from '../scripts/ensure-web-dist.ts';
import { startLocalRelay, type LocalRelay } from '../test-support/index.ts';

const WEB_PUBLIC = fileURLToPath(new URL('../../web/public', import.meta.url));
const INDEX = '<!doctype html><html><head><title>smurg</title><script type="module" crossorigin src="/assets/index-test.js"></script></head><body><div id="root"></div></body></html>\n';

let dir: string | undefined;
let relay: LocalRelay | undefined;

beforeAll(async () => {
  // A web build's shape with the real _headers and robots.txt of apps/web/public (vite copies public/ into a build).
  dir = mkdtempSync(join(tmpdir(), 'smurg-relay-search-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets', 'index-test.js'), 'export {};\n');
  for (const file of ['_headers', 'robots.txt']) copyFileSync(join(WEB_PUBLIC, file), join(dir, file));
  relay = await startLocalRelay({ webDist: dir });
});

afterAll(async () => {
  await relay?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

async function get(path: string): Promise<Response> {
  if (relay === undefined) throw new Error('no relay');
  return (await relay.fetch(path, { redirect: 'manual' })) as unknown as Response;
}

describe('the web app’s host and search engines', () => {
  it('the web app’s files: _headers says noindex for every path, and robots.txt lets every crawler in', () => {
    const headers = readFileSync(join(WEB_PUBLIC, '_headers'), 'utf8');
    // Under the `/*` rule, which covers the shell at /, every route of the app and every file; nowhere else.
    expect(rootHeaderLines(headers)).toContain('X-Robots-Tag: noindex');
    expect(headers.match(/X-Robots-Tag/gi)).toHaveLength(1);
    const robots = readFileSync(join(WEB_PUBLIC, 'robots.txt'), 'utf8');
    expect(robots.split('\n').filter((line) => line !== '' && !line.startsWith('#'))).toEqual(['User-agent: *', 'Allow: /']);
    // Nothing is kept from crawlers (that would hide the header), and there is no sitemap: nothing is to be listed.
    expect(robots).not.toMatch(/^\s*(?:Disallow|Sitemap)\s*:/im);
    // The build this test serves is one the deploy would accept (its security headers are the real file's).
    expect(webDistProblem(dir)).toBeNull();
  });

  it('the app’s shell says noindex at /, at every route of the app and at an unknown path, and so does every file', async () => {
    for (const path of ['/', '/join/ws_AbCdEfGh_-0123456', '/w/some-workspace/console', '/no-such-page', '/sitemap.xml', '/favicon.ico']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex');
      expect(await res.text(), path).toBe(INDEX);
    }
    const script = await get('/assets/index-test.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('/robots.txt is the file, as text, not the app’s shell: crawlers may fetch everything', async () => {
    const res = await get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(readFileSync(join(WEB_PUBLIC, 'robots.txt'), 'utf8'));
    // No Worker runs for it (it is a static file: the relay's quota is for the relay).
    const first: readonly string[] = RELAY_WORKER_FIRST_PATTERNS;
    const path: string = '/robots.txt';
    expect(first.some((pattern) => (pattern.endsWith('/*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path))).toBe(false);
  });

  it('the Worker’s own answers say noindex too: the login page of the CLI, the health check, the API, its errors and the public keys', async () => {
    for (const [path, status, type] of [
      [RELAY_PATHS.device, 200, /^text\/html/],
      [RELAY_PATHS.healthz, 200, /^text\/plain/],
      [RELAY_PATHS.loginOptions, 200, /^application\/json/],
      [RELAY_PATHS.me, 401, /^application\/json/],
      ['/api/does-not-exist', 404, /^application\/json/],
      [RELAY_PATHS.jwks, 200, /^application\/json/],
    ] as const) {
      const res = await get(path);
      expect(res.status, path).toBe(status);
      expect(res.headers.get('content-type'), path).toMatch(type);
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex');
    }
  });
});
