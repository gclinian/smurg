// A minimal stand-in for a browser: a cookie jar (host-only, no path scoping needed here), manual redirects and form
// POSTs. The real-browser tests are in cli-login.browser.test.ts.

export type Hop = { url: string; status: number; location: string | null; setCookies: string[]; method: string };

export type NavigateOptions = {
  /** Follow 3xx redirects (default true). */
  follow?: boolean;
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
    { follow = true, stopAt }: NavigateOptions,
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
      if (!follow || location === null || res.status < 300 || res.status >= 400) return { res, url: current, body };
      current = new URL(location, current).href;
      request = { method: 'GET' };
      if (stopAt !== undefined && current.startsWith(stopAt)) return { res, url: current, body };
    }
    throw new Error('too many redirects');
  }
}
