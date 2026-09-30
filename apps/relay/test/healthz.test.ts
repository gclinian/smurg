// The Worker in local workerd: /healthz reaches the Worker before static assets, unknown relay routes are 404 JSON
// (not the SPA shell), everything else is the SPA, and every relay response is uncacheable.
import { RELAY_PATHS } from '@smurg/protocol/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalRelay, type LocalRelay } from '../test-support/index.ts';

let relay: LocalRelay;

beforeAll(async () => {
  relay = await startLocalRelay();
});

afterAll(async () => {
  await relay?.stop();
});

describe('relay Worker routing', () => {
  it('answers 200 on /healthz', async () => {
    const res = await relay.fetch(RELAY_PATHS.healthz);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('ok\n');
  });

  it('answers 404 JSON for unknown relay routes instead of the SPA shell', async () => {
    for (const path of ['/api/does-not-exist', '/auth/gitlab/login', '/ws/short/client', '/ws/AbCdEfGh_-0123456/admin']) {
      const res = await relay.fetch(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: 'not_found' });
    }
  });

  it('serves the SPA for every other path', async () => {
    const res = await relay.fetch('/w/some-workspace/console');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
  });

  it('rejects wrong methods', async () => {
    expect((await relay.fetch(RELAY_PATHS.devToken)).status).toBe(405);
    expect((await relay.fetch(RELAY_PATHS.workspaces)).status).toBe(405);
    expect((await relay.fetch(RELAY_PATHS.me, { method: 'POST' })).status).toBe(405);
  });
});
