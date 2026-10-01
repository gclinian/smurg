// The Worker's routing, called directly with a stand-in ASSETS binding (test/serve.test.ts runs the same Worker in
// workerd behind the real static-assets layer).
import { describe, expect, it } from 'vitest';
import worker from '../src/index.ts';
import { DOCS, DOCS_FILE_BASE, INSTALL_SCRIPT, REPOSITORY, type Env } from '../src/routes.ts';

/** A stand-in for the static-assets binding: records what reached it. */
function assets(): Env & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    ASSETS: {
      fetch: async (request: Request) => {
        seen.push(request.url);
        return new Response('asset', { status: 200 });
      },
    },
  };
}

async function get(url: string, env = assets()): Promise<Response> {
  return worker.fetch(new Request(url, { redirect: 'manual' }), env);
}

describe('smurg.ai worker', () => {
  it('302s /install.sh to the latest release install script on GitHub, query ignored', async () => {
    expect(INSTALL_SCRIPT).toBe('https://github.com/gclinian/smurg/releases/latest/download/install.sh');
    for (const path of ['/install.sh', '/install.sh?x=1']) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(302);
      expect(response.headers.get('location'), path).toBe(INSTALL_SCRIPT);
      // "latest" moves with every release: a short cache.
      expect(response.headers.get('cache-control'), path).toBe('public, max-age=300');
    }
  });

  it('302s /github and /docs (with or without a trailing slash, query ignored)', async () => {
    expect(REPOSITORY).toBe('https://github.com/gclinian/smurg');
    expect(DOCS).toBe('https://github.com/gclinian/smurg/tree/main/docs');
    for (const path of ['/github', '/github/', '/github?x=1']) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(302);
      expect(response.headers.get('location'), path).toBe(REPOSITORY);
    }
    for (const path of ['/docs', '/docs/', '/docs?x=1']) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(302);
      expect(response.headers.get('location'), path).toBe(DOCS);
    }
  });

  it('302s /docs/<file> to that file in the docs folder', async () => {
    expect(DOCS_FILE_BASE).toBe('https://github.com/gclinian/smurg/blob/main/docs/');
    for (const [path, file] of [
      ['/docs/HOSTING.md', 'HOSTING.md'],
      ['/docs/JOINING.md', 'JOINING.md'],
      ['/docs/research/', 'research'],
      ['/docs/research/relay.md', 'research/relay.md'],
    ] as const) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(302);
      expect(response.headers.get('location'), path).toBe(`${DOCS_FILE_BASE}${file}`);
    }
  });

  it('forwards only plain docs paths; anything else goes to the assets (the 404 page)', async () => {
    const env = assets();
    const paths = ['/docs/.git/config', '/docs/%2e%2e/x', '/docs/a%20b', '/docs/a//b', '/docs/.env', '/docs/x/../../y'];
    for (const path of paths) {
      const response = await get(`https://smurg.ai${path}`, env);
      expect(response.status, path).toBe(200);
    }
    expect(env.seen).toHaveLength(paths.length);
  });

  it('301s every www path that reaches it to the apex over https, keeping path and query', async () => {
    // Defence in depth: www.smurg.ai is not a route of this Worker (the zone Redirect Rule answers it first).
    for (const [from, to] of [
      ['https://www.smurg.ai/', 'https://smurg.ai/'],
      ['https://www.smurg.ai/zh-TW/?a=1&b=2', 'https://smurg.ai/zh-TW/?a=1&b=2'],
      ['http://www.smurg.ai/install.sh', 'https://smurg.ai/install.sh'],
      ['https://www.smurg.ai:8443/x', 'https://smurg.ai/x'],
    ] as const) {
      const response = await get(from);
      expect(response.status, from).toBe(301);
      expect(response.headers.get('location'), from).toBe(to);
    }
  });

  it('never redirects to another host (no open redirect through the path)', async () => {
    for (const url of [
      'https://www.smurg.ai//evil.example/x',
      'https://www.smurg.ai/%2F%2Fevil.example',
      'https://www.smurg.ai/\\evil.example',
      'https://smurg.ai/docs//evil.example',
      'https://smurg.ai/docs/%2F%2Fevil.example',
    ]) {
      const response = await get(url);
      const location = response.headers.get('location');
      if (location === null) continue; // handed to the assets
      const host = new URL(location).host;
      expect(['smurg.ai', 'github.com'], url).toContain(host);
    }
  });

  it('hands every other request to the static assets, unchanged', async () => {
    const env = assets();
    const paths = ['/', '/zh-TW/', '/style.css', '/install', '/install.sh/', '/githubx', '/documentation', '/no-such-page'];
    for (const path of paths) {
      const response = await get(`https://smurg.ai${path}`, env);
      expect(response.status, path).toBe(200);
    }
    expect(env.seen).toEqual(paths.map((path) => `https://smurg.ai${path}`));
  });

  it('redirects carry no body and basic headers', async () => {
    const response = await get('https://smurg.ai/install.sh');
    expect(await response.text()).toBe('');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
