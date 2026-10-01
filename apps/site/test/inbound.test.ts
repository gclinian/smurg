// Links into the site from the rest of the repository: the CLI's messages and help, the web app, the installer, the
// README and the published docs point at pages of smurg.ai (and at headings of the docs). Each must exist in the
// site as built, so that renaming a heading in the docs, or a page here, cannot silently break them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDIRECTS } from '../src/routes.ts';
import { REPO_ROOT, parsePage, testSite } from './html.ts';

/** What users see (internal documents such as docs/RELEASING.md name deliberately missing pages in their checks). */
const SOURCES = ['README.md', 'CHANGELOG.md', 'docs/HOSTING.md', 'docs/JOINING.md', 'scripts/install.sh', 'apps/web/index.html', 'apps/web/src', 'packages/cli/src', 'packages/daemon/src'];
// The path is ASCII; a #fragment may hold the letters of a Chinese heading id.
const SITE_URL = /https:\/\/smurg\.ai(\/[A-Za-z0-9\-._~/%?=&]*)?(#[\p{L}\p{M}\p{N}\-_]*)?/gu;

function files(path: string): string[] {
  const full = join(REPO_ROOT, path);
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name === 'test' || /\.test\.tsx?$/.test(name)) return [];
    const child = join(full, name);
    if (statSync(child).isDirectory()) return files(relative(REPO_ROOT, child));
    return /\.(ts|tsx|md|sh|html)$/.test(name) ? [relative(REPO_ROOT, child)] : [];
  });
}

describe('links into the site from the rest of the repository', () => {
  it('every https://smurg.ai/… URL in the CLI, the web app, the installer, the README and the docs is a page of the site (and its #heading exists)', () => {
    const site = testSite().files;
    const found: string[] = [];
    for (const file of SOURCES.flatMap(files)) {
      for (const match of readFileSync(join(REPO_ROOT, file), 'utf8').matchAll(SITE_URL)) {
        const path = (match[1] ?? '/').replace(/[.,;:?]+$/, '');
        const fragment = match[2] ?? '';
        const where = `${file}: ${match[0]}`;
        found.push(where);
        if (REDIRECTS.has(path)) continue;
        const page = path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1);
        expect(site.has(page), where).toBe(true);
        if (fragment.length > 1) expect(parsePage(site.get(page)?.toString('utf8') ?? '').ids(), where).toContain(fragment.slice(1));
      }
    }
    // The CLI's links to the guides at least (packages/cli/src: host, relay, attach, licenses).
    expect(found.filter((where) => where.startsWith('packages/cli/src')).length).toBeGreaterThan(3);
  });
});
