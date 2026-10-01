// smurg.ai, the product page: a Worker next to the static files in public/. The static assets answer every request
// themselves (the pages, the security headers of public/_headers, the nearest 404.html for unknown paths); this Worker
// runs only for the redirect paths (wrangler.jsonc `assets.run_worker_first`), answers the redirects of src/routes.ts
// and hands anything else that reaches it to the assets.
// Only the default export here: workerd treats every named export of the entry module as an entrypoint.
import { route, type Env } from './routes.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request) ?? env.ASSETS.fetch(request);
  },
};
