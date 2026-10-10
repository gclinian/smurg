// wrangler.jsonc, read by wrangler itself: where the site is served, what is built before a deploy, and which requests
// run the Worker. Every request that runs the Worker counts against the account's daily Workers Free quota, which the
// shared relay uses too (docs/RELEASING.md), so the Worker runs first only for its own redirects.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';
import { REDIRECTS, WORKER_PATHS } from '../src/routes.ts';
import { DIST, SITE_ROOT, testSite } from './html.ts';

const config = unstable_readConfig({ config: join(SITE_ROOT, 'wrangler.jsonc'), env: '' }, { hideWarnings: true });

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
    const relay = unstable_readConfig({ config: join(SITE_ROOT, '..', 'relay', 'wrangler.jsonc'), env: '' }, { hideWarnings: true });
    expect(config.compatibility_date).toBe(relay.compatibility_date);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    // Exactly one route, the apex. www.smurg.ai is the maintainer's proxied DNS record and the zone Redirect
    // Rule (www -> https://smurg.ai/<path>, 301): a www custom domain here would take that record over on deploy.
    expect(config.routes).toEqual([{ pattern: 'smurg.ai', custom_domain: true }]);
  });

  it('builds dist/ before every deploy, dry run and dev session, with this checkout’s scripts/build.ts', () => {
    // wrangler runs the command from its own working directory: the path goes through SMURG_ROOT, and the shell
    // stops with a message when scripts/env.sh was not sourced.
    expect(config.build.command).toBe('node "${SMURG_ROOT:?run source scripts/env.sh first}/apps/site/scripts/build.ts"');
    expect(config.build.cwd).toBeUndefined();
  });

  it('serves the built dist/ with a real 404 page and trailing-slash handling', () => {
    expect(resolve(SITE_ROOT, config.assets?.directory ?? '')).toBe(DIST);
    expect(config.assets?.binding).toBe('ASSETS');
    expect(config.assets?.not_found_handling).toBe('404-page');
    expect(config.assets?.html_handling).toBe('auto-trailing-slash');
    // dist/ is build output: the repository's .gitignore keeps it out of git.
    expect(readFileSync(join(SITE_ROOT, '..', '..', '.gitignore'), 'utf8')).toMatch(/^dist\/$/m);
  });

  it('runs the Worker first only for its redirects: /install.sh, /github and /source (src/routes.ts WORKER_PATHS)', () => {
    expect(config.assets?.run_worker_first).toEqual([...WORKER_PATHS]);
    expect(WORKER_PATHS).toEqual(['/install.sh', '/github', '/source']);
    expect([...REDIRECTS.keys()]).toEqual([...WORKER_PATHS]);
    for (const path of REDIRECTS.keys()) expect(WORKER_PATHS.some((pattern) => matches(pattern, path)), path).toBe(true);
  });

  it('never runs the Worker for a page, a doc, the stylesheet, the script, the icon or the notices', () => {
    const served = [...testSite().files.keys()].filter((path) => !path.startsWith('_'));
    expect(served.length).toBeGreaterThan(18);
    for (const path of served) {
      const urls = [`/${path}`];
      if (path === 'index.html') urls.push('/');
      if (path.endsWith('/index.html')) urls.push(`/${path.slice(0, -'index.html'.length)}`, `/${path.slice(0, -'/index.html'.length)}`);
      for (const url of urls) expect(WORKER_PATHS.filter((pattern) => matches(pattern, url)), url).toEqual([]);
    }
  });

  it('is documented in README.md: the paths, the build, the quota rule, the www Redirect Rule and what search engines are told', () => {
    const readme = readFileSync(join(SITE_ROOT, 'README.md'), 'utf8');
    for (const path of ['/install.sh', '/github', '/source', '/docs/', '/docs/quick-start/', '/docs/hosting/', '/docs/joining/', '/docs/changelog/', '/license/', '/zh-TW/docs/', '/zh-TW/docs/quick-start/', '/zh-TW/docs/hosting/', '/zh-TW/docs/joining/', '/zh-TW/docs/changelog/', '/zh-TW/license/', '/third-party-notices.txt', '/sitemap.xml', '/robots.txt', '/llms.txt', '/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/zh-tw']) {
      expect(readme, path).toContain(`\`${path}\``);
    }
    // … and, under "Being found", what a search result is made of and where each part is written.
    expect(readme).toContain('\n## Being found\n');
    for (const word of ['run_worker_first', 'Redirect Rule', 'scripts/build.ts', 'SMURG_SITE_THIRD_PARTY_NOTICES', 'SMURG_SITE_ALLOW_PLACEHOLDER', 'hreflang', 'https://github.com/gclinian/smurg', 'public/_redirects', 'application/ld+json', 'X-Robots-Tag: noindex', 'data-nosnippet', '<lastmod>', 'Search Console', 'pnpm --filter @smurg/site run icons']) {
      expect(readme, word).toContain(word);
    }
    // Nothing of the time the source was private.
    expect(readme).not.toMatch(/private|proprietary|<COPYRIGHT HOLDER>/i);
  });
});
