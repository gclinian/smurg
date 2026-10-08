// THE way a part of the page is loaded later: every `import()` of a chunk under src/ is the argument of
// `loadChunk(() => import(…))` or `lazyChunk(() => import(…))`, and every Worker is started through `startWorker`
// (lib/chunks.test.tsx fails for one that is not).
//
// Why one way. The relay serves the web app as files named after their content. A tab that stays open across a deploy
// of the web app asks, the first time it shows a column, a dialog, the editor or a terminal, for a file of the build
// it was loaded from; that file may be gone, and the relay answers an address it has no file for with the page itself
// (text/html), which the browser refuses as a script. Left alone, the failed import empties the page (a lazy route),
// leaves a column that "crashed" with a Retry that cannot work, or does nothing at all (a dialog that never opens).
// Here a failed load becomes ONE named error, ChunkLoadError, that says why:
//
//   'gone'     the server answers the page itself (or "not found") for the file: the web app was deployed again;
//   'offline'  the request for the file fails: no network, or the server cannot be reached;
//   'failed'   anything else: the file is there, or the answer is an error (a server that broke, a proxy's own
//              error page, whatever it is written in), which says nothing about an update.
//
// The reason is asked of the server (one request for the file the browser named, past every cache), never guessed:
// "smurg was updated" is only said when it was. Who shows it: ui/Boundary.tsx (a slot), app/PageBoundary.tsx (a
// route), the editor and the terminal (their own place), and the workspace's banner for a failure that has no place
// of its own (`reportChunkFailure`: a dialog's chunk, a menu's).
//
// A Worker's script is a file of the same build and goes with the same deploy, but its load is not an import: the
// browser fires an `error` event at the Worker and nothing rejects. `startWorker` turns that event into the same
// named error, so a Worker whose file is gone is said with the same notice (the transfers panel in its place; the
// editor's Worker, which has none, in the banner).
//
// The cure is always a reload. A browser keeps a failed import for as long as the page lives (run in Chrome 155: the
// same import() fails again after the file is served fine, after a dropped connection and after being offline), so
// nothing here offers to "try again".
import { lazy } from 'react';
import { entryScripts, isHtml } from './page-build.ts';
import { createStore, type ReadableStore } from './store.ts';

export type ChunkFailure = 'gone' | 'offline' | 'failed';

export class ChunkLoadError extends Error {
  override readonly name = 'ChunkLoadError';
  readonly reason: ChunkFailure;

  /** `cause`: what the import() rejected with. */
  constructor(reason: ChunkFailure, cause: unknown) {
    super(`a part of the page could not be loaded (${reason})`, { cause });
    this.reason = reason;
  }
}

export function isChunkLoadError(error: unknown): error is ChunkLoadError {
  return error instanceof ChunkLoadError;
}

// ---------------------------------------------------------------------------------------------------------------
// Why the file did not come
// ---------------------------------------------------------------------------------------------------------------

/** Says why an import() failed. Must not throw for long: a rejection counts as 'failed'. */
export type ChunkProbe = (error: unknown) => Promise<ChunkFailure>;

export interface ChunkProbeEnv {
  readonly fetch?: typeof fetch;
  /** The document this page was loaded from (it names the entry script). */
  readonly document?: Document;
  readonly origin?: string;
  readonly timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 8_000;

/** A browser's message for a failed import is a sentence and an address: nothing longer is looked at. */
const MESSAGE_LOOKED_AT = 2_000;
/** What ends a word of that message. */
const BETWEEN_WORDS = new Set([' ', '\t', '\n', '\r', '"', "'", '<', '>']);
/** What a sentence may put right behind an address. */
const AFTER_AN_ADDRESS = new Set(['.', ',', ')']);
const FILE_ENDINGS = ['.js', '.mjs', '.css'] as const;

/**
 * The file a failed import names, as an address of this origin; null when the browser's message names none (Safari)
 * or names another origin. Chrome: "Failed to fetch dynamically imported module: <address>"; Firefox: "error loading
 * dynamically imported module: <address>"; the build's loader, for a stylesheet: "Unable to preload CSS for <path>".
 * (Words are cut by hand, one pass over a bounded text: no expression that could be tried again from every character.)
 */
export function chunkAddressIn(error: unknown, origin: string): string | null {
  const message = (error instanceof Error ? error.message : '').slice(0, MESSAGE_LOOKED_AT);
  let start = 0;
  for (let i = 0; i <= message.length; i += 1) {
    if (i < message.length && !BETWEEN_WORDS.has(message[i] as string)) continue;
    let end = i;
    while (end > start && AFTER_AN_ADDRESS.has(message[end - 1] as string)) end -= 1;
    const word = message.slice(start, end);
    start = i + 1;
    const named = word.startsWith('http://') || word.startsWith('https://') || (word.startsWith('/') && FILE_ENDINGS.some((ending) => word.endsWith(ending)));
    if (!named) continue;
    try {
      const url = new URL(word, origin);
      return url.origin === origin ? url.href : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Asks the server for the file the import named (where the browser names none: this page's own entry script, which a
 * deploy replaces together with every chunk), past every cache and without cookies.
 */
export async function browserChunkProbe(error: unknown, env: ChunkProbeEnv = {}): Promise<ChunkFailure> {
  const doFetch = env.fetch ?? globalThis.fetch;
  const doc = env.document ?? (typeof document === 'undefined' ? null : document);
  const origin = env.origin ?? (typeof window === 'undefined' ? null : window.location.origin);
  if (typeof doFetch !== 'function' || origin === null) return 'failed';
  const address = chunkAddressIn(error, origin) ?? (doc === null ? undefined : entryScripts(doc, origin)[0]);
  if (address === undefined) return 'failed';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), env.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const response = await doFetch(address, { cache: 'no-store', credentials: 'omit', signal: abort.signal });
    // Only the headers are wanted: a chunk that IS there can be megabytes (Monaco).
    void response.body?.cancel().catch(() => {});
    return answersGone(response) ? 'gone' : 'failed';
  } catch {
    return 'offline';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Does this answer for a file of the app say that the file is gone? Two answers do: "not found" outright, and the
 * relay's own answer for an address it has no file for, which is the page itself, served as found at that very
 * address (text/html, an OK status, no redirect). Any other page in HTML is not that: an ERROR status (a 503 of a
 * proxy in front of the relay, a 500), or a page the request was sent on to (a proxy's login page). The file may
 * well be there then, and nothing was updated.
 */
function answersGone(response: Pick<Response, 'status' | 'ok' | 'redirected' | 'headers'>): boolean {
  if (response.status === 404 || response.status === 410) return true;
  return response.ok && !response.redirected && isHtml(response);
}

let probe: ChunkProbe = browserChunkProbe;

/** Replaces how the reason is found out (tests: no unit test asks a network); null puts the browser's way back. */
export function setChunkProbe(next: ChunkProbe | null): void {
  probe = next ?? browserChunkProbe;
}

// ---------------------------------------------------------------------------------------------------------------
// The helper
// ---------------------------------------------------------------------------------------------------------------

/**
 * Wraps one `import()` of a chunk: `loadChunk(() => import('./monaco.ts'))`. What the import resolves to is handed
 * through; a rejection becomes a ChunkLoadError that says why (its `cause` is the browser's own error).
 */
export function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(load())).catch(async (error: unknown) => {
    // A chunk that loads another one through this helper: already named, already asked.
    if (error instanceof ChunkLoadError) throw error;
    throw await named(error);
  });
}

/** What did not load, as the named error that says why (asked of the server; a probe that fails itself: 'failed'). */
async function named(cause: unknown): Promise<ChunkLoadError> {
  let reason: ChunkFailure;
  try {
    reason = await probe(cause);
  } catch {
    reason = 'failed';
  }
  return new ChunkLoadError(reason, cause);
}

/**
 * A component in a chunk of its own, for a slot, a route or a dialog: `lazyChunk(() => import('./PlanColumn.tsx'))`
 * (the default export is the component). React.lazy behind the helper: it suspends while the chunk is on its way and
 * throws the ChunkLoadError to the nearest error boundary when it does not come.
 */
export const lazyChunk: typeof lazy = (load) => lazy(() => loadChunk(load));

// ---------------------------------------------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------------------------------------------

/** What the helper listens to on a Worker (the browser's, or a test's stand-in). */
export interface WorkerEvents {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: Event) => void): void;
}

/**
 * Starts one Worker of the app: `startWorker(() => new Worker(new URL('./x.worker.ts', import.meta.url), …))`, or
 * with the class a `?worker` import gives. The Worker is handed back as it is.
 *
 * When its file does not come, the browser fires ONE `error` event at the Worker: a bare event that names no file
 * and carries no message, before the Worker has said anything. That is taken for what it is, why is asked like for
 * an import (the event names no file, so the page's own entry script is asked: a deploy replaces it together with
 * every other file), and the named error goes to `onFileFailure`: the place that shows this Worker's work, or,
 * for a Worker that has none (the editor's), the workspace's banner.
 *
 * Not a missing file, and left to whoever started the Worker: an error after the Worker spoke, and an error with a
 * message (an ErrorEvent: its script was there, ran and threw).
 */
export function startWorker<W extends WorkerEvents>(create: () => W, onFileFailure: (error: ChunkLoadError) => void = reportChunkFailure): W {
  const worker = create();
  let spoke = false;
  let asked = false;
  worker.addEventListener('message', () => {
    spoke = true;
  });
  worker.addEventListener('error', (event) => {
    if (spoke || asked || saysWhatBroke(event)) return;
    asked = true;
    void named(event).then(onFileFailure);
  });
  return worker;
}

/** An `error` event that carries a message is a script that ran and threw (an ErrorEvent), not a file that did not come. */
function saysWhatBroke(event: Event): boolean {
  const message = (event as Partial<ErrorEvent>).message;
  return typeof message === 'string' && message !== '';
}

// ---------------------------------------------------------------------------------------------------------------
// Failures without a place of their own
// ---------------------------------------------------------------------------------------------------------------

const reported = createStore<readonly ChunkLoadError[]>([]);

/**
 * The chunk failures that have no place of their own on the page (a dialog that would have opened, a menu's action,
 * an overlay that renders nothing, the editor's Worker): the workspace shows ONE banner for them (ui/ChunkNotice.tsx).
 */
export const chunkFailures: ReadableStore<readonly ChunkLoadError[]> = reported;

/**
 * Hands a failure to the workspace's banner: `void loadChunk(() => import(…)).then(open).catch(reportChunkFailure)`.
 * Anything that is not a chunk failure is thrown on (a bug stays loud).
 */
export function reportChunkFailure(error: unknown): void {
  if (!(error instanceof ChunkLoadError)) throw error;
  reported.setState((previous) => (previous.includes(error) ? previous : [...previous, error]));
}

/** Forgets what was reported (a test's end; a page never needs it: the cure is a reload). */
export function resetChunkFailures(): void {
  reported.setState([]);
}

const SEVERITY: Readonly<Record<ChunkFailure, number>> = { failed: 0, offline: 1, gone: 2 };

/** The failure whose words are shown when several were reported: an update explains every other one. */
export function worstChunkFailure(failures: readonly ChunkLoadError[]): ChunkLoadError | null {
  let worst: ChunkLoadError | null = null;
  for (const failure of failures) if (worst === null || SEVERITY[failure.reason] > SEVERITY[worst.reason]) worst = failure;
  return worst;
}

/** The one thing that helps. Its own object so a test can watch it (jsdom cannot navigate). */
export const page = {
  reload(): void {
    window.location.reload();
  },
};
