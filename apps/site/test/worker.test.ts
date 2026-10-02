// The Worker's routing, called directly with a stand-in ASSETS binding (test/serve.test.ts runs the same Worker in
// workerd behind the real static-assets layer).
import { describe, expect, it } from 'vitest';
import worker from '../src/index.ts';
import { DOWNLOADS, INSTALL_SCRIPT, REDIRECTS, REPOSITORY, WORKER_PATHS, type Env } from '../src/routes.ts';

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
  it('302s /install.sh to the newest release’s installer on downloads.smurg.ai, query ignored', async () => {
    expect(DOWNLOADS).toBe('https://downloads.smurg.ai');
    expect(INSTALL_SCRIPT).toBe('https://downloads.smurg.ai/latest/install.sh');
    for (const path of ['/install.sh', '/install.sh?x=1']) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(302);
      expect(response.headers.get('location'), path).toBe(INSTALL_SCRIPT);
      // "latest" moves with every release: a short cache (the same as latest/install.sh's own Cache-Control).
      expect(response.headers.get('cache-control'), path).toBe('public, max-age=300');
    }
  });

  it('302s /github and /source to the source repository on GitHub, query ignored', async () => {
    expect(REPOSITORY).toBe('https://github.com/gclinian/smurg');
    for (const path of ['/github', '/source', '/github?x=1']) {
      const response = await get(`https://smurg.ai${path}`);
      expect(response.status, path).toBe(302);
      expect(response.headers.get('location'), path).toBe(REPOSITORY);
      expect(response.headers.get('cache-control'), path).toBe('public, max-age=300');
    }
  });

  it('has those redirects and nothing else: no docs redirects (the docs are pages of the site)', () => {
    expect([...REDIRECTS]).toEqual([
      ['/install.sh', 'https://downloads.smurg.ai/latest/install.sh'],
      ['/github', 'https://github.com/gclinian/smurg'],
      ['/source', 'https://github.com/gclinian/smurg'],
    ]);
    expect(WORKER_PATHS).toEqual(['/install.sh', '/github', '/source']);
  });

  it('hands /docs and every other request to the static assets, unchanged', async () => {
    const env = assets();
    const paths = ['/', '/zh-TW/', '/style.css', '/install', '/install.sh/', '/github/', '/github/gclinian', '/source/', '/docs', '/docs/', '/docs/hosting/', '/zh-TW/docs/hosting/', '/docs/HOSTING.md', '/license/', '/third-party-notices.txt', '/no-such-page'];
    for (const path of paths) {
      const response = await get(`https://smurg.ai${path}`, env);
      expect(response.status, path).toBe(200);
    }
    expect(env.seen).toEqual(paths.map((path) => `https://smurg.ai${path}`));
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

  it('never redirects to another host than smurg.ai, downloads.smurg.ai and github.com (no open redirect through the path)', async () => {
    for (const url of [
      'https://www.smurg.ai//evil.example/x',
      'https://www.smurg.ai/%2F%2Fevil.example',
      'https://www.smurg.ai/\\evil.example',
      'https://smurg.ai//evil.example',
      'https://smurg.ai/install.sh//evil.example',
      'https://smurg.ai/%2F%2Fevil.example/install.sh',
      'https://smurg.ai/github//evil.example',
      'https://www.smurg.ai/github',
    ]) {
      const response = await get(url);
      const location = response.headers.get('location');
      if (location === null) continue; // handed to the assets
      expect(['smurg.ai', 'downloads.smurg.ai', 'github.com'], url).toContain(new URL(location).host);
      // And on GitHub only ever the repository itself.
      if (new URL(location).host === 'github.com') expect(location, url).toBe(REPOSITORY);
    }
  });

  it('redirects carry no body and basic headers', async () => {
    const response = await get('https://smurg.ai/install.sh');
    expect(await response.text()).toBe('');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
