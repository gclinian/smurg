// Response helpers. Every relay response is uncacheable and nosniff; HTML pages also get a CSP that allows no
// script at all and no framing (the only pages the relay renders are /device, the CLI login confirmation, "continue"
// pages and error pages).

const BASE_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function headersWith(extra: Record<string, string>, cookies: readonly string[] = []): Headers {
  const headers = new Headers({ ...BASE_HEADERS, ...extra });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return headers;
}

export function jsonResponse(body: unknown, status = 200, cookies: readonly string[] = []): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: headersWith({ 'content-type': 'application/json; charset=utf-8' }, cookies),
  });
}

/** Machine-readable error: `{ error: <code>, message }`. */
export function errorResponse(status: number, error: string, message?: string): Response {
  return jsonResponse(message === undefined ? { error } : { error, message }, status);
}

export function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: headersWith({ 'content-type': 'text/plain; charset=utf-8' }) });
}

export type HtmlOptions = {
  /**
   * `same-origin` for a page whose forms POST back to the relay: under `no-referrer` browsers send `Origin: null` with
   * a form POST (Fetch "append a request Origin header"), and the relay needs the real Origin to refuse cross-site
   * submissions. Other origins still get no referrer. Default `no-referrer`.
   */
  referrerPolicy?: 'no-referrer' | 'same-origin';
};

export function htmlResponse(html: string, status = 200, cookies: readonly string[] = [], options: HtmlOptions = {}): Response {
  // X-Frame-Options next to frame-ancestors for browsers that predate CSP 2 (clickjacking of /device's 「允許」).
  const extra: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': HTML_CSP, 'x-frame-options': 'DENY' };
  if (options.referrerPolicy !== undefined) extra['referrer-policy'] = options.referrerPolicy;
  return new Response(html, { status, headers: headersWith(extra, cookies) });
}

export function redirectResponse(location: string, cookies: readonly string[] = []): Response {
  return new Response(null, { status: 302, headers: headersWith({ location }, cookies) });
}

export function emptyResponse(status = 204, cookies: readonly string[] = []): Response {
  return new Response(null, { status, headers: headersWith({}, cookies) });
}

export const MAX_JSON_BODY_BYTES = 4096;

export type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

/**
 * Reads a small JSON request body. Requires `content-type: application/json`, which a cross-site HTML form cannot
 * send (a second CSRF barrier next to the Origin check). With `optional`, an empty body yields `undefined`.
 */
export async function readJsonBody(req: Request, { optional = false } = {}): Promise<BodyResult> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_JSON_BODY_BYTES) {
    return { ok: false, response: errorResponse(413, 'too_large') };
  }
  const text = await req.text();
  if (text.length > MAX_JSON_BODY_BYTES) return { ok: false, response: errorResponse(413, 'too_large') };
  if (text === '' && optional) return { ok: true, value: undefined };
  const type = req.headers.get('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    return { ok: false, response: errorResponse(415, 'unsupported_media_type', 'expected application/json') };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: errorResponse(400, 'bad_request', 'body is not JSON') };
  }
}

export type FormResult = { ok: true; value: URLSearchParams } | { ok: false; response: Response };

/** Reads a small `application/x-www-form-urlencoded` body (the relay's own HTML forms). */
export async function readFormBody(req: Request): Promise<FormResult> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_JSON_BODY_BYTES) {
    return { ok: false, response: errorResponse(413, 'too_large') };
  }
  const type = req.headers.get('content-type') ?? '';
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(type)) {
    return { ok: false, response: errorResponse(415, 'unsupported_media_type', 'expected a form') };
  }
  const text = await req.text();
  if (text.length > MAX_JSON_BODY_BYTES) return { ok: false, response: errorResponse(413, 'too_large') };
  return { ok: true, value: new URLSearchParams(text) };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
