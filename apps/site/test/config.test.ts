// wrangler.jsonc, read by wrangler itself: where the site is served, and which requests run the Worker. Every request
// that runs the Worker counts against the account's daily Workers Free quota, which the shared relay uses too
// (docs/RELEASING.md §8), so the Worker runs first only for its own redirect paths.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';
import { REDIRECTS, WORKER_PATHS } from '../src/routes.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const config = unstable_readConfig({ config: join(ROOT, 'wrangler.jsonc'), env: '' }, { hideWarnings: true });

function files(dir = PUBLIC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [relative(PUBLIC, path).split('\\').join('/')];
  });
}

/** A run_worker_first pattern as wrangler matches it: `*` is any run of characters. */
function matches(pattern: string, path: string): boolean {
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`).test(path);
}

describe('wrangler.jsonc', () => {
  it('is the smurg-site Worker on the custom domain smurg.ai only (www is the zone Redirect Rule, never a route)', () => {
    expect(config.name).toBe('smurg-site');
    expect(config.main).toMatch(/[/\\]src[/\\]index\.ts$/);
    // The same date as apps/relay (<= the workerd of the repo's wrangler).
    const relay = unstable_readConfig({ config: join(ROOT, '..', 'relay', 'wrangler.jsonc'), env: '' }, { hideWarnings: true });
    expect(config.compatibility_date).toBe(relay.compatibility_date);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    // Exactly the routes deployed on 2026-10-01. www.smurg.ai is the owner's proxied DNS record and the zone Redirect
    // Rule (www -> https://smurg.ai/<path>, 301): a www custom domain here would take that record over on deploy.
    expect(config.routes).toEqual([{ pattern: 'smurg.ai', custom_domain: true }]);
  });

  it('serves public/ with a real 404 page and trailing-slash handling', () => {
    expect(resolve(ROOT, config.assets?.directory ?? '')).toBe(PUBLIC);
    expect(config.assets?.binding).toBe('ASSETS');
    expect(config.assets?.not_found_handling).toBe('404-page');
    expect(config.assets?.html_handling).toBe('auto-trailing-slash');
  });

  it('runs the Worker first only for its redirect paths (src/routes.ts WORKER_PATHS)', () => {
    expect(config.assets?.run_worker_first).toEqual([...WORKER_PATHS]);
    for (const path of [...REDIRECTS.keys(), '/docs/HOSTING.md', '/docs/research/relay.md']) {
      expect(WORKER_PATHS.some((pattern) => matches(pattern, path)), path).toBe(true);
    }
    // Every pattern is needed: none is covered by another (wrangler refuses redundant patterns).
    for (const pattern of WORKER_PATHS) {
      expect(WORKER_PATHS.filter((other) => other !== pattern && matches(other, pattern.replace('*', 'x'))), pattern).toEqual([]);
    }
  });

  it('never runs the Worker for a page, the stylesheet, the script or the icon', () => {
    const served = files().filter((path) => !path.startsWith('_'));
    expect(served.length).toBeGreaterThan(5);
    for (const path of served) {
      const urls = [`/${path}`];
      if (path === 'index.html') urls.push('/');
      if (path.endsWith('/index.html')) urls.push(`/${path.slice(0, -'index.html'.length)}`);
      for (const url of urls) expect(WORKER_PATHS.filter((pattern) => matches(pattern, url)), url).toEqual([]);
    }
  });

  it('is documented in README.md: the redirect table, the quota rule and the www Redirect Rule', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    for (const path of ['/install.sh', '/github', '/docs', '/docs/<file>']) expect(readme, path).toContain(`\`${path}\``);
    expect(readme).toContain('run_worker_first');
    expect(readme).toContain('Redirect Rule');
  });
});
