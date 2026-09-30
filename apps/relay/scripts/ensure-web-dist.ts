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

const STAND_IN = `<!doctype html>
<html lang="zh-Hant-TW">
  <head><meta charset="UTF-8" /><title>smurg</title></head>
  <body>
    <p>尚未建置網頁介面。請執行 <code>pnpm --filter @smurg/web build</code>，或使用 <code>pnpm dev:web</code>（http://localhost:5173）。</p>
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

export type WebDistProblem = 'missing' | 'stand-in' | 'no-index' | 'no-headers' | 'manifest-served';

/**
 * Why `dir` cannot be deployed as the SPA, or null when it looks like a real `vite build`. Fail closed on the security
 * headers too (review SEC-E-04): the SPA's Content-Security-Policy / frame protection come from `_headers` (from
 * apps/web/public), and the build manifest must not be served (`.assetsignore` lists `.vite`).
 */
export function webDistProblem(dir: string = WEB_DIST): WebDistProblem | null {
  if (!existsSync(dir)) return 'missing';
  if (existsSync(join(dir, STAND_IN_MARKER))) return 'stand-in';
  if (!existsSync(join(dir, 'index.html'))) return 'no-index';
  const headers = existsSync(join(dir, '_headers')) ? readFileSync(join(dir, '_headers'), 'utf8') : '';
  if (!/^\/\*[ \t]*$/m.test(headers) || !/^[ \t]+Content-Security-Policy:[^\n]*frame-ancestors 'none'/im.test(headers)) return 'no-headers';
  if (existsSync(join(dir, '.vite'))) {
    const ignored = existsSync(join(dir, '.assetsignore')) ? readFileSync(join(dir, '.assetsignore'), 'utf8').split(/\r?\n/).map((line) => line.trim()) : [];
    if (!ignored.includes('.vite') && !ignored.includes('.vite/')) return 'manifest-served';
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && ensureWebDist()) {
  console.log(`ensure-web-dist: created a stand-in SPA in ${WEB_DIST}`);
}
