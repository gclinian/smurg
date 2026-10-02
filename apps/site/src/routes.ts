// The redirects of smurg.ai, apart from the Worker entry (src/index.ts): workerd treats every named export of the
// entry module as an entrypoint, so constants and helpers live here, where the tests and the build import them too.
//
//   /install.sh          302  https://downloads.smurg.ai/latest/install.sh (the newest release's installer, whose
//                             base URL is pinned to that release's downloads.smurg.ai/v<X.Y.Z>/; it checks SHA256SUMS)
//   /github, /source     302  https://github.com/gclinian/smurg (the source repository; for short mentions such as
//                             the installer's and the CLI's output: the pages link to GitHub directly)
//   www.smurg.ai/<path>  301  https://smurg.ai/<path>  (query kept; defence in depth, see below)
//
// Everything else is a static file of dist/ (scripts/build.ts: public/ plus the docs pages generated from the
// repository): /, /zh-TW/, /docs/…, /zh-TW/docs/…, /license/, /zh-TW/license/, /third-party-notices.txt and the 404
// pages.
//
// The Worker runs only for the paths in WORKER_PATHS (wrangler.jsonc `assets.run_worker_first`, kept equal by
// test/config.test.ts). Everything else, the pages, the stylesheet, the script, the icon and the 404 page for unknown
// paths, is answered by the static assets without it, so it costs no Worker request. www.smurg.ai is not a route of
// this Worker: the zone Redirect Rule sends every www path to https://smurg.ai/<path> before any Worker runs
// (wrangler.jsonc; README.md, "Deploying"). The www branch below only answers a www request that reaches the Worker
// anyway (defence in depth).

export const CANONICAL_HOST = 'smurg.ai';
/** The release downloads (Cloudflare R2 behind a custom domain; docs/RELEASING.md). */
export const DOWNLOADS = 'https://downloads.smurg.ai';
/** The newest release's installer: `curl -fsSL https://smurg.ai/install.sh | sh` runs it. */
export const INSTALL_SCRIPT = `${DOWNLOADS}/latest/install.sh`;

/** The source repository (MIT). */
export const REPOSITORY = 'https://github.com/gclinian/smurg';

/** Exact paths that redirect; 302 so the targets can change without stale browser caches. */
export const REDIRECTS: ReadonlyMap<string, string> = new Map([
  ['/install.sh', INSTALL_SCRIPT],
  ['/github', REPOSITORY],
  ['/source', REPOSITORY],
]);

/** The `run_worker_first` patterns (wrangler.jsonc): every redirect path above, nothing else. */
export const WORKER_PATHS: readonly string[] = ['/install.sh', '/github', '/source'];

/** The static-assets binding (wrangler.jsonc `assets.binding`). */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

// Redirect responses never reach the assets, so they carry their own (body-less) headers.
function redirect(location: string, status: 301 | 302, cacheSeconds: number): Response {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      'Cache-Control': `public, max-age=${cacheSeconds}`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** The redirect for this request, or null when the static assets should answer it. */
export function route(request: Request): Response | null {
  const url = new URL(request.url);

  if (url.hostname === `www.${CANONICAL_HOST}`) {
    // Change the host of the parsed URL rather than resolving the path against the apex: a path like `//evil.example`
    // would resolve to another host (an open redirect).
    const target = new URL(url.href);
    target.protocol = 'https:';
    target.hostname = CANONICAL_HOST;
    target.port = '';
    target.hash = '';
    return redirect(target.href, 301, 86_400);
  }

  const location = REDIRECTS.get(url.pathname);
  if (location !== undefined) return redirect(location, 302, 300);

  return null;
}
