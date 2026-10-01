// A minimal stand-in for a browser: a cookie jar (host-only, no path scoping needed here), manual redirects, form
// POSTs and the relay's meta-refresh "continue" pages. The real-browser tests are in cli-login.browser.test.ts.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Hop = { url: string; status: number; location: string | null; setCookies: string[]; method: string };

const ENTITIES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };

/** The target of a relay page's `<meta http-equiv="refresh" content="0;url=…">`, or null. */
export function metaRefreshTarget(html: string): string | null {
  const match = /<meta http-equiv="refresh" content="0;url=([^"]*)">/.exec(html);
  return match ? (match[1] ?? '').replace(/&(amp|quot|#39|lt|gt);/g, (entity) => ENTITIES[entity] ?? entity) : null;
}

export type NavigateOptions = {
  /** Follow 3xx redirects (default true). */
  follow?: boolean;
  /** Also follow meta refreshes of HTML pages, like a browser (default false). */
  meta?: boolean;
  /** Stop before requesting a URL that starts with this. */
  stopAt?: string;
};

export class CookieBrowser {
  readonly jar = new Map<string, string>();
  readonly hops: Hop[] = [];

  /** Sent with every request, e.g. `cf-connecting-ip` (local workerd keeps a client's own value). */
  readonly headers: Record<string, string>;

  constructor(headers: Record<string, string> = {}) {
    this.headers = headers;
  }

  cookieHeader(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private store(res: Response): string[] {
    const setCookies = res.headers.getSetCookie();
    for (const line of setCookies) {
      const [pair = '', ...attributes] = line.split(/;\s*/);
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const maxAge = attributes.find((a) => a.toLowerCase().startsWith('max-age='));
      if (maxAge !== undefined && Number(maxAge.split('=')[1]) <= 0) this.jar.delete(name);
      else this.jar.set(name, pair.slice(eq + 1));
    }
    return setCookies;
  }

  /** GET `url`, following redirects until a non-redirect response or a URL starting with `stopAt`. */
  async get(url: string, options: NavigateOptions = {}): Promise<{ res: Response; url: string; body: string }> {
    return this.navigate(url, { method: 'GET' }, options);
  }

  /**
   * Submits a form like a browser on `origin` would (Origin and Sec-Fetch-Site set accordingly, `null` origin omits
   * the header), then navigates on like `get`.
   */
  async submit(
    url: string,
    fields: Record<string, string>,
    { origin, site = 'same-origin', ...options }: NavigateOptions & { origin: string | null; site?: string | null },
  ): Promise<{ res: Response; url: string; body: string }> {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (origin !== null) headers['origin'] = origin;
    if (site !== null) headers['sec-fetch-site'] = site;
    return this.navigate(url, { method: 'POST', headers, body: new URLSearchParams(fields).toString() }, options);
  }

  private async navigate(
    url: string,
    first: { method: string; headers?: Record<string, string>; body?: string },
    { follow = true, meta = false, stopAt }: NavigateOptions,
  ): Promise<{ res: Response; url: string; body: string }> {
    let current = url;
    let request = first;
    for (let i = 0; i < 10; i++) {
      const headers: Record<string, string> = { ...this.headers, ...request.headers };
      if (this.jar.size > 0) headers['cookie'] = this.cookieHeader();
      const res = await fetch(current, { method: request.method, redirect: 'manual', headers, ...(request.body ? { body: request.body } : {}) });
      const setCookies = this.store(res);
      const location = res.headers.get('location');
      const body = await res.text();
      this.hops.push({ url: current, status: res.status, location, setCookies, method: request.method });
      let next: string | null = null;
      if (follow && location !== null && res.status >= 300 && res.status < 400) next = location;
      else if (follow && meta && res.status === 200 && (res.headers.get('content-type') ?? '').startsWith('text/html')) next = metaRefreshTarget(body);
      if (next === null) return { res, url: current, body };
      current = new URL(next, current).href;
      request = { method: 'GET' };
      if (stopAt !== undefined && current.startsWith(stopAt)) return { res, url: current, body };
    }
    throw new Error('too many redirects');
  }
}

export type LoopbackListener = {
  port: number;
  /** Resolves with the query of the first request to /callback. */
  callback: Promise<URLSearchParams>;
  /** Every request target the listener received, in order. */
  readonly requests: string[];
  close(): Promise<void>;
};

/** The CLI's loopback listener (RFC 8252): 127.0.0.1, random port, one callback. */
export async function loopbackListener(): Promise<LoopbackListener> {
  let resolveCallback!: (params: URLSearchParams) => void;
  const callback = new Promise<URLSearchParams>((resolve) => {
    resolveCallback = resolve;
  });
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(req.url ?? '');
    res.end('ok');
    if (url.pathname === '/callback') resolveCallback(url.searchParams);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    callback,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
