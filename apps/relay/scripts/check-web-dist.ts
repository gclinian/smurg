// Run by the `build` script before `wrangler deploy --dry-run`: the relay Worker serves apps/web/dist as the SPA, so
// a missing build, or the stand-in page that `pnpm dev:relay` and the tests create, must never be bundled.
//   node scripts/check-web-dist.ts
import { WEB_DIST, webDistProblem } from './ensure-web-dist.ts';

const problem = webDistProblem();
if (problem !== null) {
  const why = {
    'stand-in': 'holds the development stand-in page, not a web build',
    missing: 'does not exist',
    'no-index': 'has no index.html',
    'no-headers': "has no _headers with a Content-Security-Policy (frame-ancestors 'none') for /* (apps/web/public/_headers)",
    'no-hsts': 'has no Strict-Transport-Security with a max-age of at least a year (31536000) in _headers (apps/web/public/_headers)',
    'manifest-served': 'would serve .vite/manifest.json (.assetsignore must list .vite; apps/web/public/.assetsignore)',
  }[problem];
  console.error(`check-web-dist: ${WEB_DIST} ${why}. Build the web app first: pnpm --filter @smurg/web build (or: pnpm build).`);
  process.exit(1);
}
