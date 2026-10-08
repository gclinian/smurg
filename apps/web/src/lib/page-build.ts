// Is the page this tab runs the one the relay serves now?
//
// The relay serves ONE web app to every host, and a tab that stays open keeps running the page it loaded. The page
// has no version number to compare (and the wire carries none), but it can ask: the document it was loaded from names
// its entry script (`<script type="module" src="/assets/index-<hash>.js">`, a name made from the content of the whole
// build), and `/` of the relay names the entry script of the page it serves now. Same name: this tab is the current
// page. Another name: the web app was deployed again after this tab loaded.
//
// Asked after a `version` refusal (which side has to act: lib/connection/status.ts) and never on a timer.

/** 'current': this tab runs the page the relay serves now. 'stale': the relay serves another one. 'unknown': it could not be asked. */
export type PageBuild = 'current' | 'stale' | 'unknown';

export interface PageBuildOptions {
  readonly fetch?: typeof fetch;
  /** The document this page was loaded from. */
  readonly document?: Document;
  readonly origin?: string;
  /** How long the relay has to answer. */
  readonly timeoutMs?: number;
}

const ASK_TIMEOUT_MS = 10_000;

/** A script's address in a page of the app is a path with a hash in its name: nothing longer is parsed. */
const SRC_MAX_CHARS = 2_048;

/** The module scripts a document names, as whole addresses, in document order (inline scripts name nothing). */
export function entryScripts(doc: Document, origin: string): string[] {
  const out: string[] = [];
  for (const script of doc.querySelectorAll('script[type="module"][src]')) {
    const src = script.getAttribute('src');
    if (src === null || src === '' || src.length > SRC_MAX_CHARS) continue;
    try {
      out.push(new URL(src, origin).href);
    } catch {
      // not an address: names nothing
    }
  }
  return out;
}

/**
 * Asks the relay for `/` past every cache (the answer must be the relay's, not this browser's memory of it) and
 * compares the entry script named there with the one this page runs. No cookie is sent: the page is the same for
 * everybody. Anything that is not a readable page (offline, an error status, a redirect, another content type, a
 * page that names no script) is 'unknown': never a guess.
 */
export async function askPageBuild(options: PageBuildOptions = {}): Promise<PageBuild> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const doc = options.document ?? (typeof document === 'undefined' ? null : document);
  const origin = options.origin ?? (typeof window === 'undefined' ? null : window.location.origin);
  if (typeof doFetch !== 'function' || doc === null || origin === null) return 'unknown';
  const mine = entryScripts(doc, origin);
  if (mine.length === 0) return 'unknown';

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? ASK_TIMEOUT_MS);
  try {
    const response = await doFetch(`${origin}/`, { cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { accept: 'text/html' }, signal: abort.signal });
    if (!response.ok || !isHtml(response)) return 'unknown';
    const theirs = entryScripts(new DOMParser().parseFromString(await response.text(), 'text/html'), origin);
    if (theirs.length === 0) return 'unknown';
    return theirs.length === mine.length && theirs.every((src, index) => src === mine[index]) ? 'current' : 'stale';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/** The answer is an HTML page (what the relay sends for `/`, and for every address it has no file for). */
export function isHtml(response: Pick<Response, 'headers'>): boolean {
  const type = (response.headers.get('content-type') ?? '').trim().toLowerCase();
  return type === 'text/html' || type.startsWith('text/html;') || type.startsWith('text/html ');
}
