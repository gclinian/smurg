// wrangler refuses to start (dev server, createTestHarness) when `assets.directory` (../web/dist) does not exist.
// During development the SPA is served by Vite, so a missing web build must not block the relay: this creates a
// one-page stand-in that says how to get the real one; `vite build` replaces it (emptyOutDir). The stand-in carries
// a marker file, and the `build` script (scripts/check-web-dist.ts) refuses to bundle a stand-in: after one test run
// in a fresh checkout, a deployable bundle must still never ship the placeholder page as the SPA.
//   node scripts/ensure-web-dist.ts          (also imported by test/global-setup.ts and startLocalRelay)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
/** Present only in the stand-in; `vite build` empties the directory. */
export const STAND_IN_MARKER = '.smurg-stand-in';

/** The sentence of the stand-in page; `deploy.ts --check` and the web smoke tests recognise the stand-in by it. */
export const STAND_IN_TEXT = 'The web app has not been built yet.';

const STAND_IN = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>smurg</title></head>
  <body>
    <p>${STAND_IN_TEXT} Run <code>pnpm --filter @smurg/web build</code>, or use <code>pnpm dev:web</code> (http://localhost:5173).</p>
  </body>
</html>
`;

/** Creates the stand-in only when there is no web build at all; returns whether it did. */
export function ensureWebDist(): boolean {
  if (existsSync(WEB_DIST)) return false;
  mkdirSync(WEB_DIST, { recursive: true });
  writeFileSync(join(WEB_DIST, STAND_IN_MARKER), 'This directory holds a stand-in, not a web build. Run: pnpm --filter @smurg/web build\n');
  writeFileSync(join(WEB_DIST, 'index.html'), STAND_IN);
  return true;
}

export type WebDistProblem = 'missing' | 'stand-in' | 'no-index' | 'no-headers' | 'no-hsts' | 'manifest-served';

/** HSTS lifetime the web app's `_headers` must send at least: one year (the same line as apps/site/public/_headers). */
export const HSTS_MIN_MAX_AGE = 31_536_000;

/**
 * The `max-age` of a `Strict-Transport-Security` value when it is at least HSTS_MIN_MAX_AGE, else null. Neither
 * `includeSubDomains` nor `preload` is asked for (the zone's other hostnames are not this Worker's to commit).
 */
export function hstsMaxAge(value: string): number | null {
  const match = /(?:^|;)\s*max-age\s*=\s*"?(\d+)"?\s*(?:;|$)/i.exec(value);
  const maxAge = match === null ? Number.NaN : Number(match[1]);
  return maxAge >= HSTS_MIN_MAX_AGE ? maxAge : null;
}

/**
 * The header lines (`Name: value`, indentation removed) of the `/*` rule in a Cloudflare `_headers` file: the
 * indented lines under a line that is exactly `/*`, up to the next rule. Only that rule covers `/` and every SPA
 * route; a header under another rule (say `/assets/*`) does not protect the page.
 */
export function rootHeaderLines(headers: string): string[] {
  const lines: string[] = [];
  let inRoot = false;
  for (const line of headers.split(/\r?\n/)) {
    if (/^[ \t]+\S/.test(line)) {
      if (inRoot) lines.push(line.trim());
    } else if (line.trim() !== '' && !line.trimStart().startsWith('#')) {
      inRoot = line.trim() === '/*';
    }
  }
  return lines;
}

/**
 * Why `dir` cannot be deployed as the SPA, or null when it looks like a real `vite build`. Fail closed on the security
 * headers too: the SPA's Content-Security-Policy / frame protection come from `_headers` (from
 * apps/web/public), so does its Strict-Transport-Security (at least a year: the relay is a custom domain of a zone
 * that is not HSTS-preloaded, docs/RELEASING.md §2), and the build manifest must not be served (`.assetsignore` lists
 * `.vite`).
 */
export function webDistProblem(dir: string = WEB_DIST): WebDistProblem | null {
  if (!existsSync(dir)) return 'missing';
  if (existsSync(join(dir, STAND_IN_MARKER))) return 'stand-in';
  if (!existsSync(join(dir, 'index.html'))) return 'no-index';
  const root = rootHeaderLines(existsSync(join(dir, '_headers')) ? readFileSync(join(dir, '_headers'), 'utf8') : '');
  if (!root.some((line) => /^Content-Security-Policy:.*frame-ancestors 'none'/i.test(line))) return 'no-headers';
  const hsts = root.find((line) => /^Strict-Transport-Security:/i.test(line))?.replace(/^Strict-Transport-Security:\s*/i, '');
  if (hsts === undefined || hstsMaxAge(hsts) === null) return 'no-hsts';
  if (existsSync(join(dir, '.vite'))) {
    const ignored = existsSync(join(dir, '.assetsignore')) ? readFileSync(join(dir, '.assetsignore'), 'utf8').split(/\r?\n/).map((line) => line.trim()) : [];
    if (!ignored.includes('.vite') && !ignored.includes('.vite/')) return 'manifest-served';
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && ensureWebDist()) {
  console.log(`ensure-web-dist: created a stand-in SPA in ${WEB_DIST}`);
}
