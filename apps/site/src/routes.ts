// The redirects of smurg.ai, apart from the Worker entry (src/index.ts): workerd treats every named export of the
// entry module as an entrypoint, so constants and helpers live here, where the tests import them too.
//
//   /install.sh          302  the latest release's install.sh on GitHub (it downloads from GitHub, checks SHA256SUMS)
//   /github              302  the repository
//   /docs                302  the repository's docs folder
//   /docs/<file>         302  that file in the repository's docs folder (plain names only)
//   www.smurg.ai/<path>  301  https://smurg.ai/<path>  (query kept)
//
// The Worker runs only for the paths in WORKER_PATHS (wrangler.jsonc `assets.run_worker_first`, kept equal by
// test/config.test.ts). Everything else, the pages, the stylesheet, the script, the icon and the 404 page for unknown
// paths, is answered by the static assets without it, so it costs no Worker request. www.smurg.ai on those paths is
// redirected by a Cloudflare Redirect Rule on the zone (README.md, "Deploying"); the www branch below covers the
// redirect paths, which do reach the Worker.

export const CANONICAL_HOST = 'smurg.ai';
export const REPOSITORY = 'https://github.com/gclinian/smurg';
export const INSTALL_SCRIPT = `${REPOSITORY}/releases/latest/download/install.sh`;
export const DOCS = `${REPOSITORY}/tree/main/docs`;
/** Prefix of a file in the docs folder. */
export const DOCS_FILE_BASE = `${REPOSITORY}/blob/main/docs/`;

/** Exact paths that redirect; 302 so the targets can change without stale browser caches. */
export const REDIRECTS: ReadonlyMap<string, string> = new Map([
  ['/install.sh', INSTALL_SCRIPT],
  ['/github', REPOSITORY],
  ['/github/', REPOSITORY],
  ['/docs', DOCS],
  ['/docs/', DOCS],
]);

/**
 * The `run_worker_first` patterns (wrangler.jsonc): every redirect path above, and everything under /docs/. wrangler
 * refuses a pattern that another one already covers, so `/docs/` is left to `/docs/*`.
 */
export const WORKER_PATHS: readonly string[] = ['/install.sh', '/github', '/github/', '/docs', '/docs/*'];

/**
 * A path under /docs/ that is forwarded to GitHub: plain names only. No segment starts with a dot (so no `..`, no
 * `.git`), no empty segment, no percent-encoding.
 */
const DOCS_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

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

  if (url.pathname.startsWith('/docs/')) {
    const file = url.pathname.slice('/docs/'.length).replace(/\/$/, '');
    if (DOCS_FILE.test(file)) return redirect(`${DOCS_FILE_BASE}${file}`, 302, 300);
  }

  return null;
}
