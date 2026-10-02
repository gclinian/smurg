// Links into the site from the rest of the repository: the CLI's messages and help, the web app, the relay's pages,
// the installer, the READMEs and the published docs of both languages point at pages of smurg.ai (and at headings of
// the docs). Each must exist in the site as built, so that renaming a heading in the docs, or a page here, cannot
// silently break them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDIRECTS } from '../src/routes.ts';
import { REPO_ROOT, parsePage, testSite } from './html.ts';

/**
 * What users see, in both languages: the READMEs, the changelogs, the guides, the installer, the web app (its catalogs
 * are under src/) and the CLI (its catalogs are packages/cli/src/i18n/). Internal documents such as docs/RELEASING.md
 * name deliberately missing pages in their checks, so they are not here.
 */
const SOURCES = [
  'README.md',
  'README.zh-TW.md',
  'CHANGELOG.md',
  'docs/HOSTING.md',
  'docs/JOINING.md',
  'docs/zh-TW',
  'scripts/install.sh',
  'apps/web/index.html',
  'apps/web/src',
  'packages/cli/src',
  'packages/daemon/src',
  'packages/protocol/src',
  'apps/relay/src',
];
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
  it('every https://smurg.ai/… URL in the CLI, the web app, the relay, the installer, the READMEs and the guides is a page of the site (and its #heading exists)', () => {
    const site = testSite().files;
    const found: string[] = [];
    const broken: string[] = [];
    for (const file of SOURCES.flatMap(files)) {
      for (const match of readFileSync(join(REPO_ROOT, file), 'utf8').matchAll(SITE_URL)) {
        const path = (match[1] ?? '/').replace(/[.,;:?]+$/, '');
        const fragment = match[2] ?? '';
        const where = `${file}: ${match[0]}`;
        found.push(where);
        if (REDIRECTS.has(path)) continue;
        const page = path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1);
        if (!site.has(page)) broken.push(`${where}: no such page`);
        else if (fragment.length > 1 && !parsePage(site.get(page)?.toString('utf8') ?? '').ids().includes(fragment.slice(1))) broken.push(`${where}: the page has no such heading`);
      }
    }
    // All at once, so that one run names every link to fix (a heading id is its language's: /docs/… has the English
    // headings, /zh-TW/docs/… the Chinese ones).
    expect(broken).toEqual([]);
    // The CLI's links to the guides at least (packages/cli/src: host, relay, attach, licenses).
    expect(found.filter((where) => where.startsWith('packages/cli/src')).length).toBeGreaterThan(3);
    // Both languages' guides are linked from somewhere.
    expect(found.some((where) => where.includes('https://smurg.ai/zh-TW/docs/'))).toBe(true);
    expect(found.some((where) => where.includes('https://smurg.ai/docs/'))).toBe(true);
  });

  it('a Chinese document never sends its reader to an English guide page, nor an English one to a Chinese page', () => {
    const wrong: string[] = [];
    for (const file of ['README.md', 'README.zh-TW.md', 'CHANGELOG.md', 'docs/HOSTING.md', 'docs/JOINING.md', ...files('docs/zh-TW')]) {
      const chinese = file === 'README.zh-TW.md' || file.startsWith('docs/zh-TW/');
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      // The released sections of the changelogs are history: they keep the addresses of their time.
      const current = file.endsWith('CHANGELOG.md') ? text.slice(0, text.search(/^## \[\d/m)) : text;
      for (const match of current.matchAll(SITE_URL)) {
        const path = match[1] ?? '/';
        if (!/^\/(?:zh-TW\/)?(?:docs|license)\//.test(path)) continue;
        // A sentence that names both languages' addresses lists the two side by side.
        const line = current.split('\n').find((l) => l.includes(match[0])) ?? '';
        if (line.includes('https://smurg.ai/docs/') && line.includes('https://smurg.ai/zh-TW/docs/')) continue;
        if (path.startsWith('/zh-TW/') !== chinese) wrong.push(`${file}: ${match[0]}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
