// Where released executables are, and how `smurg update` (and `smurg host`'s update notice) reads that site:
//
//   <base>/latest/VERSION                       "X.Y.Z\n": the newest published version
//   <base>/v<X.Y.Z>/SHA256SUMS                  sha256 of every file of that version
//   <base>/v<X.Y.Z>/smurg-<darwin|linux>-<arm64|x64>
//
// (the layout scripts/publish-downloads.ts uploads; docs/RELEASING.md). <base> is https://downloads.smurg.ai, or
// $SMURG_INSTALL_BASE_URL (tests and mirrors): the variable scripts/install.sh reads, under the same rule: https, or
// http only for 127.0.0.1 / localhost. The installer's value names ONE version's folder (…/v0.2.0); here it is the site
// above it, so a trailing `/v<X.Y.Z>` or `/latest` is dropped and the same value works for both.
//
// Redirects are followed by hand, never away from the scheme of <base> (install.sh's `--proto-redir`). Nothing here
// sends anything about this machine but the request itself, and nothing here words a download failure: the commands turn
// a DownloadError into what the person reads.
import { usageError } from '../cli/errors.ts';
import { m } from '../i18n/index.ts';
import { parseVersion } from './versions.ts';

export const DEFAULT_DOWNLOADS_URL = 'https://downloads.smurg.ai';
export const DOWNLOADS_ENV = 'SMURG_INSTALL_BASE_URL';
export const INSTALL_COMMAND = 'curl -fsSL https://smurg.ai/install.sh | sh';

export type FetchLike = typeof globalThis.fetch;

export interface DownloadsBase {
  /** Without a trailing slash. */
  readonly url: string;
  readonly scheme: 'https' | 'http';
}

const LOCAL_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];
const MAX_REDIRECTS = 5;

function allowedUrl(url: URL, scheme: 'https' | 'http' | null): 'https' | 'http' | null {
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return scheme === null || scheme === 'https' ? 'https' : null;
  if (url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname)) return scheme === null || scheme === 'http' ? 'http' : null;
  return null;
}

/** The downloads site of this run, or a usage error for a value install.sh would refuse too. */
export function downloadsBase(env: Readonly<Record<string, string | undefined>>): DownloadsBase {
  const override = env[DOWNLOADS_ENV];
  const text = (override !== undefined && override !== '' ? override : DEFAULT_DOWNLOADS_URL).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw usageError(m('downloads.notUrl', { text }), m('downloads.notUrl.hint', { env: DOWNLOADS_ENV, default: DEFAULT_DOWNLOADS_URL }));
  }
  const scheme = allowedUrl(url, null);
  if (scheme === null) throw usageError(m('downloads.notHttps', { text }), m('downloads.notHttps.hint', { env: DOWNLOADS_ENV }));
  if (/[^A-Za-z0-9:/._~%-]/.test(text) || url.search !== '' || url.hash !== '') throw usageError(m('downloads.badCharacters', { text }));
  return { url: text.replace(/\/(?:latest|v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(?:-[0-9A-Za-z.-]{1,40})?)$/, ''), scheme };
}

export type DownloadFailure = 'network' | 'timeout' | 'http' | 'redirect' | 'too-large' | 'incomplete' | 'not-a-version';

export class DownloadError extends Error {
  readonly kind: DownloadFailure;
  readonly url: string;
  /** The HTTP status of an `http` failure. */
  readonly status: number | undefined;

  constructor(kind: DownloadFailure, url: string, options: { readonly status?: number; readonly cause?: unknown } = {}) {
    super(`${kind}: ${url}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DownloadError';
    this.kind = kind;
    this.url = url;
    this.status = options.status;
  }
}

export interface RequestOptions {
  readonly fetch?: FetchLike;
  /** Ends the request: the caller's timeout, a Ctrl-C. */
  readonly signal: AbortSignal;
  /**
   * Ask for the bytes as they are stored (`Accept-Encoding: identity`): the executable, whose Content-Length is then
   * the size of what arrives. The small text files may come compressed (the site serves SHA256SUMS with brotli).
   */
  readonly identity?: boolean;
}

function isTimeout(err: unknown, signal: AbortSignal): boolean {
  const reason: unknown = signal.aborted ? signal.reason : err;
  return typeof reason === 'object' && reason !== null && (reason as { name?: unknown }).name === 'TimeoutError';
}

/** What went wrong with a request, as a DownloadError; an abort that is not a timeout (Ctrl-C) passes through. */
export function asDownloadError(err: unknown, url: string, signal: AbortSignal): unknown {
  if (err instanceof DownloadError) return err;
  if (isTimeout(err, signal)) return new DownloadError('timeout', url, { cause: err });
  if (signal.aborted) return signal.reason ?? err;
  return new DownloadError('network', url, { cause: err });
}

/**
 * GET `<base>/<path>`: the 200 response with its body unread. Redirects stay on the scheme of the base (and an http
 * base stays on this machine); anything else is a DownloadError.
 */
export async function download(base: DownloadsBase, path: string, options: RequestOptions): Promise<Response> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const first = `${base.url}/${path}`;
  let current = first;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        redirect: 'manual',
        signal: options.signal,
        headers: { accept: '*/*', ...(options.identity ? { 'accept-encoding': 'identity' } : {}) },
      });
    } catch (err) {
      throw asDownloadError(err, first, options.signal);
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (location !== null) {
      await response.body?.cancel().catch(() => {});
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new DownloadError('redirect', first);
      }
      if (allowedUrl(next, base.scheme) === null) throw new DownloadError('redirect', first);
      current = next.href;
      continue;
    }
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel().catch(() => {});
      throw new DownloadError('http', first, { status: response.status });
    }
    return response;
  }
  throw new DownloadError('redirect', first);
}

/** A small text file (VERSION, SHA256SUMS): at most `maxBytes`, UTF-8. */
export async function downloadText(base: DownloadsBase, path: string, maxBytes: number, options: RequestOptions): Promise<string> {
  const url = `${base.url}/${path}`;
  const response = await download(base, path, options);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > maxBytes) throw new DownloadError('too-large', url);
      chunks.push(chunk);
    }
  } catch (err) {
    throw asDownloadError(err, url, options.signal);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `<base>/latest/VERSION`: the newest published version (`X.Y.Z`), validated. */
export async function latestVersion(base: DownloadsBase, options: RequestOptions): Promise<string> {
  const text = (await downloadText(base, 'latest/VERSION', 256, options)).trim();
  if (parseVersion(text) === null) throw new DownloadError('not-a-version', `${base.url}/latest/VERSION`);
  return text;
}

/** The release asset of a platform (`smurg-darwin-arm64`), the name scripts/install.sh picks; null: none is built. */
export function targetName(platform: string, arch: string): string | null {
  if (platform !== 'darwin' && platform !== 'linux') return null;
  if (arch !== 'arm64' && arch !== 'x64') return null;
  return `smurg-${platform}-${arch}`;
}

/** The sha256 SHA256SUMS lists for `name` (`<hex>  <name>` or `<hex> *<name>`), or null. */
export function sha256Of(sums: string, name: string): string | null {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line);
    if (match !== null && match[2] === name) return match[1] as string;
  }
  return null;
}

/** A signal that aborts when `signal` does, or after `ms` (reason: a TimeoutError). */
export function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}
