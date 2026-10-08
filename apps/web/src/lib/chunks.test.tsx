// A part of the page that is loaded later (a column, a dialog, Monaco, xterm) and the three ways its file can fail to
// come: the web app was deployed again and the file is gone (the relay answers the page itself), the network is
// gone, or something else. And the rule that keeps it so: no import() of a chunk under src/ goes around the helper.
import { render, screen } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Suspense, type ComponentType, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ChunkLoadError, browserChunkProbe, chunkAddressIn, chunkFailures, isChunkLoadError, lazyChunk, loadChunk, reportChunkFailure, setChunkProbe, startWorker, worstChunkFailure, type WorkerEvents } from './chunks.ts';
import { SlotBoundary } from '../ui/Boundary.tsx';

const ORIGIN = 'https://app.smurg.test';
/** What Chrome says when the file of a dynamic import did not come as a script. */
const CHROME = (url: string): TypeError => new TypeError(`Failed to fetch dynamically imported module: ${url}`);

describe('which file a failed import names', () => {
  it("reads the address out of the browser's message, and only an address of this origin", () => {
    expect(chunkAddressIn(CHROME(`${ORIGIN}/assets/TerminalColumn-9wZLbPSu.js`), ORIGIN)).toBe(`${ORIGIN}/assets/TerminalColumn-9wZLbPSu.js`);
    // Firefox.
    expect(chunkAddressIn(new TypeError(`error loading dynamically imported module: ${ORIGIN}/assets/Workbench-LryUXbHp.js`), ORIGIN)).toBe(`${ORIGIN}/assets/Workbench-LryUXbHp.js`);
    // The build's own loader, for a stylesheet a chunk needs.
    expect(chunkAddressIn(new Error('Unable to preload CSS for /assets/Workbench-DntWAQjO.css'), ORIGIN)).toBe(`${ORIGIN}/assets/Workbench-DntWAQjO.css`);
    // Safari names no file; another origin's address is never asked.
    expect(chunkAddressIn(new TypeError('Importing a module script failed.'), ORIGIN)).toBeNull();
    expect(chunkAddressIn(CHROME('https://elsewhere.test/assets/x.js'), ORIGIN)).toBeNull();
    expect(chunkAddressIn(new Error('boom'), ORIGIN)).toBeNull();
    expect(chunkAddressIn('not an error', ORIGIN)).toBeNull();
    expect(chunkAddressIn(undefined, ORIGIN)).toBeNull();
  });
});

describe('why the file did not come: asked of the server, never guessed', () => {
  const page = new DOMParser().parseFromString('<script type="module" crossorigin src="/assets/index-CN7hUyvy.js"></script>', 'text/html');
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  const answering = (response: () => Response | Promise<Response>): typeof fetch =>
    ((input: RequestInfo | URL, init?: RequestInit) => {
      asked.push({ url: String(input), init });
      return Promise.resolve().then(response);
    }) as typeof fetch;
  const probe = (error: unknown, fetchFn: typeof fetch) => browserChunkProbe(error, { fetch: fetchFn, document: page, origin: ORIGIN, timeoutMs: 50 });
  /** What the relay answers for a file it does not have (any more): the page itself (wrangler.jsonc: single-page-application). */
  const thePageItself = (): Response => new Response('<!doctype html><html><body><div id="root"></div></body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' } });

  it('the relay answers the page itself for the file: the web app was deployed again, the file is gone', async () => {
    asked.length = 0;
    const url = `${ORIGIN}/assets/TerminalColumn-9wZLbPSu.js`;
    expect(await probe(CHROME(url), answering(thePageItself))).toBe('gone');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe(url);
    expect(asked[0]?.init).toMatchObject({ cache: 'no-store', credentials: 'omit' });
  });

  it('a server that says "not found" outright means the same', async () => {
    expect(await probe(CHROME(`${ORIGIN}/assets/a.js`), answering(() => new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })))).toBe('gone');
    expect(await probe(CHROME(`${ORIGIN}/assets/a.js`), answering(() => new Response('', { status: 410 })))).toBe('gone');
  });

  it('the fetch itself fails: offline (or the server cannot be reached), never "updated"', async () => {
    expect(await probe(CHROME(`${ORIGIN}/assets/a.js`), answering(() => Promise.reject(new TypeError('Failed to fetch'))))).toBe('offline');
    // No answer within the time limit is the same thing to the person.
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    expect(await probe(CHROME(`${ORIGIN}/assets/a.js`), hanging)).toBe('offline');
  });

  it('the file is there: something else went wrong, and the page does not claim an update or a network problem', async () => {
    const script = (): Response => new Response('export {}', { status: 200, headers: { 'content-type': 'text/javascript' } });
    expect(await probe(CHROME(`${ORIGIN}/assets/a.js`), answering(script))).toBe('failed');
    expect(await probe(CHROME(`${ORIGIN}/assets/a.js`), answering(() => new Response('oops', { status: 500, headers: { 'content-type': 'text/plain' } })))).toBe('failed');
  });

  // What a proxy or a load balancer in front of the relay sends while the relay cannot be reached, and what a server
  // sends when it broke: a page, in HTML, with an ERROR status. Nothing was updated then. Only the relay's own answer
  // for a file it does not have (the page itself, served as found) and a plain "not found" mean that (0.5.1, V4-3).
  it('an error page in HTML (a proxy\'s 503, a server\'s 500) is not "smurg was updated": the file may well be there', async () => {
    const errorPage = (status: number) => (): Response =>
      new Response(`<html><body><h1>${status} Service Temporarily Unavailable</h1></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
    for (const status of [500, 502, 503, 504, 403, 429]) {
      expect(await probe(CHROME(`${ORIGIN}/assets/a.js`), answering(errorPage(status))), String(status)).toBe('failed');
    }
    // "Not found" stays "gone" whatever the body is written in.
    expect(await probe(CHROME(`${ORIGIN}/assets/a.js`), answering(errorPage(404)))).toBe('gone');
    expect(await probe(CHROME(`${ORIGIN}/assets/a.js`), answering(errorPage(410)))).toBe('gone');
    // And the entry script asked in a file's place (a browser that names none) is judged the same way.
    expect(await probe(new TypeError('Importing a module script failed.'), answering(errorPage(503)))).toBe('failed');
  });

  it('a page the request was sent on to (a proxy\'s login page) is not the relay\'s answer for a missing file either', async () => {
    const loginPage = (): Response => {
      const response = new Response('<html><body><form>Log in</form></body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    };
    expect(await probe(CHROME(`${ORIGIN}/assets/a.js`), answering(loginPage))).toBe('failed');
    // The same page at the file's own address is the relay's answer: gone.
    expect(await probe(CHROME(`${ORIGIN}/assets/a.js`), answering(thePageItself))).toBe('gone');
    expect(thePageItself().redirected).toBe(false);
  });

  it("a browser that names no file: the page's own entry script is asked instead (a deploy replaces it too)", async () => {
    asked.length = 0;
    expect(await probe(new TypeError('Importing a module script failed.'), answering(thePageItself))).toBe('gone');
    expect(asked[0]?.url).toBe(`${ORIGIN}/assets/index-CN7hUyvy.js`);
    expect(await probe(new TypeError('Importing a module script failed.'), answering(() => Promise.reject(new TypeError('Load failed'))))).toBe('offline');
  });
});

describe('the one helper around every import() of a chunk', () => {
  it('a load that works is handed through untouched, and nothing is asked', async () => {
    let probed = 0;
    setChunkProbe(() => {
      probed += 1;
      return Promise.resolve('gone');
    });
    expect(await loadChunk(() => Promise.resolve({ value: 42 }))).toEqual({ value: 42 });
    expect(probed).toBe(0);
  });

  it('a load that fails becomes ONE named error that says why, with the browser\'s own error as its cause', async () => {
    for (const reason of ['gone', 'offline', 'failed'] as const) {
      setChunkProbe(() => Promise.resolve(reason));
      const cause = CHROME(`${ORIGIN}/assets/a.js`);
      const error = await loadChunk(() => Promise.reject(cause)).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ChunkLoadError);
      expect(isChunkLoadError(error)).toBe(true);
      expect(error).toMatchObject({ name: 'ChunkLoadError', reason, cause });
    }
  });

  it('a loader that throws at once, and a probe that fails itself, end as the named error too', async () => {
    setChunkProbe(() => Promise.resolve('offline'));
    await expect(
      loadChunk(() => {
        throw new Error('sync');
      }),
    ).rejects.toMatchObject({ name: 'ChunkLoadError', reason: 'offline' });
    setChunkProbe(() => Promise.reject(new Error('the probe broke')));
    await expect(loadChunk(() => Promise.reject(new Error('x')))).rejects.toMatchObject({ name: 'ChunkLoadError', reason: 'failed' });
  });

  it('a chunk that loads another chunk through the helper: the inner error is passed on as it is, asked once', async () => {
    let probed = 0;
    setChunkProbe(() => {
      probed += 1;
      return Promise.resolve('gone');
    });
    const inner = loadChunk(() => Promise.reject(new Error('inner')));
    const error = await loadChunk(() => inner).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({ reason: 'gone' });
    expect(await inner.catch((thrown: unknown) => thrown)).toBe(error);
    expect(probed).toBe(1);
  });
});

describe('a lazy component whose chunk does not come', () => {
  function Slot({ children, silent = false }: { children: ReactNode; silent?: boolean }) {
    return (
      <SlotBoundary name="Terminal (amy)" silent={silent}>
        <Suspense fallback={<p>loading</p>}>{children}</Suspense>
      </SlotBoundary>
    );
  }

  it('renders like React.lazy when the chunk comes', async () => {
    const Column = lazyChunk(() => Promise.resolve({ default: ({ title }: { title: string }) => <p>column {title}</p> }));
    render(
      <Slot>
        <Column title="one" />
      </Slot>,
    );
    expect(await screen.findByText('column one')).toBeTruthy();
  });

  it('throws the named error to the nearest boundary, which shows the notice for it', async () => {
    setChunkProbe(() => Promise.resolve('gone'));
    const Column = lazyChunk<ComponentType<{ title: string }>>(() => Promise.reject(CHROME(`${ORIGIN}/assets/TerminalColumn-9wZLbPSu.js`)));
    render(
      <Slot>
        <Column title="one" />
      </Slot>,
    );
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('smurg was updated');
    expect(notice.textContent).toContain('Reload to get the new page; if the host has not updated yet, the page will say so.');
    expect(notice.getAttribute('data-chunk-failure')).toBe('gone');
  });
});

describe('failures that have no place of their own on the page', () => {
  it('are kept for the banner of the workspace, each once, and the worst one decides the words', () => {
    expect(chunkFailures.getState()).toEqual([]);
    expect(worstChunkFailure([])).toBeNull();
    const offline = new ChunkLoadError('offline', null);
    const failed = new ChunkLoadError('failed', null);
    const gone = new ChunkLoadError('gone', null);
    reportChunkFailure(failed);
    reportChunkFailure(offline);
    reportChunkFailure(offline);
    expect(chunkFailures.getState()).toEqual([failed, offline]);
    expect(worstChunkFailure(chunkFailures.getState())).toBe(offline);
    reportChunkFailure(gone);
    // An update explains everything else: nothing of this page will load any more.
    expect(worstChunkFailure(chunkFailures.getState())).toBe(gone);
  });

  it('anything that is not a chunk failure is not swallowed', () => {
    expect(() => reportChunkFailure(new Error('a bug'))).toThrow('a bug');
  });
});

// A Worker's script is a file of the build like a chunk, and after a deploy it is gone like one. But nothing rejects:
// the browser fires ONE `error` event at the Worker, which names no file and carries no message. Before 0.5.1's last
// fixes the transfers panel then said "The transfer component could not start: worker error", and the editor's Worker
// said nothing at all (V4-4).
describe('a Worker whose file does not come', () => {
  /** What the page holds of a Worker: the two kinds of events the helper listens to, fired by the test. */
  class FakeWorker implements WorkerEvents {
    private readonly listeners = { message: new Set<(event: MessageEvent) => void>(), error: new Set<(event: Event) => void>() };
    addEventListener(type: 'message' | 'error', listener: ((event: MessageEvent) => void) | ((event: Event) => void)): void {
      (this.listeners[type] as Set<typeof listener>).add(listener);
    }
    says(data: unknown): void {
      for (const listener of this.listeners.message) listener(new MessageEvent('message', { data }));
    }
    fails(event: Event = new Event('error')): Event {
      for (const listener of this.listeners.error) listener(event);
      return event;
    }
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('hands back the Worker it was given to start, and lets a start that throws throw', () => {
    const worker = new FakeWorker();
    expect(startWorker(() => worker)).toBe(worker);
    expect(() =>
      startWorker((): FakeWorker => {
        throw new Error('no Worker here');
      }),
    ).toThrow('no Worker here');
  });

  it('an error before the Worker said anything, with no message: its file did not come; why is asked like for an import', async () => {
    for (const reason of ['gone', 'offline', 'failed'] as const) {
      const asked: unknown[] = [];
      setChunkProbe((error) => {
        asked.push(error);
        return Promise.resolve(reason);
      });
      const failures: ChunkLoadError[] = [];
      const worker = startWorker(() => new FakeWorker(), (error) => failures.push(error));
      const event = worker.fails();
      await settle();
      expect(asked).toEqual([event]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ name: 'ChunkLoadError', reason, cause: event });
      // One Worker, one failure: a second event of the same dead Worker asks nothing again.
      worker.fails();
      await settle();
      expect(asked).toHaveLength(1);
      expect(failures).toHaveLength(1);
    }
  });

  it("the event names no file, so the page's own entry script is asked (a deploy replaces it with every other file)", async () => {
    const page = new DOMParser().parseFromString('<script type="module" crossorigin src="/assets/index-CN7hUyvy.js"></script>', 'text/html');
    const asked: string[] = [];
    const gone = ((input: RequestInfo | URL) => {
      asked.push(String(input));
      return Promise.resolve(new Response('<!doctype html><div id="root"></div>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    }) as typeof fetch;
    expect(await browserChunkProbe(new Event('error'), { fetch: gone, document: page, origin: ORIGIN, timeoutMs: 50 })).toBe('gone');
    expect(asked).toEqual([`${ORIGIN}/assets/index-CN7hUyvy.js`]);
  });

  it('a Worker that has no place of its own on the page (the editor\'s): the failure goes to the banner of the workspace', async () => {
    setChunkProbe(() => Promise.resolve('gone'));
    const worker = startWorker(() => new FakeWorker());
    const event = worker.fails();
    await settle();
    expect(chunkFailures.getState()).toHaveLength(1);
    expect(chunkFailures.getState()[0]).toMatchObject({ reason: 'gone', cause: event });
  });

  it('a probe that fails itself still ends as the named error', async () => {
    setChunkProbe(() => Promise.reject(new Error('the probe broke')));
    const failures: ChunkLoadError[] = [];
    startWorker(() => new FakeWorker(), (error) => failures.push(error)).fails();
    await settle();
    expect(failures).toMatchObject([{ reason: 'failed' }]);
  });

  it("not a missing file: an error after the Worker spoke, and an error with a message (the Worker's own code ran and threw)", async () => {
    let probed = 0;
    setChunkProbe(() => {
      probed += 1;
      return Promise.resolve('gone');
    });
    const failures: ChunkLoadError[] = [];
    const spoke = startWorker(() => new FakeWorker(), (error) => failures.push(error));
    spoke.says({ t: 'ready' });
    spoke.fails();
    const threw = startWorker(() => new FakeWorker(), (error) => failures.push(error));
    threw.fails(new ErrorEvent('error', { message: 'Uncaught TypeError: x is not a function', filename: `${ORIGIN}/assets/transfer.worker-U9J9hu7s.js`, lineno: 1 }));
    await settle();
    expect(probed).toBe(0);
    expect(failures).toEqual([]);
    expect(chunkFailures.getState()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The rule, checked on the source
// ---------------------------------------------------------------------------------------------------------------

const SRC = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** The source without comments and without the text of strings (their quotes stay): what is left is code. */
function codeOf(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '//') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
      const quote = text[i] as string;
      out += quote;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        // A template's `${…}` holds code: kept, so an import() inside one is seen.
        if (quote === '`' && text.slice(i, i + 2) === '${') {
          out += '${';
          i += 2;
          for (let depth = 1; i < text.length && depth > 0; i += 1) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}') depth -= 1;
            out += text[i];
          }
          continue;
        }
        i += text[i] === '\\' ? 2 : 1;
      }
      out += quote;
      i += 1;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** Every `import(` of the code that is not a type (`typeof import(…)`, `import('…').Name` in a type position). */
function dynamicImports(code: string): { index: number; before: string }[] {
  const found: { index: number; before: string }[] = [];
  for (const match of code.matchAll(/\bimport\s*\(/g)) {
    const before = code.slice(Math.max(0, match.index - 80), match.index);
    if (/\btypeof\s+$/.test(before)) continue;
    found.push({ index: match.index, before });
  }
  return found;
}

const THROUGH_THE_HELPER = /\b(?:loadChunk|lazyChunk)(?:<[^()]*>)?\(\s*(?:async\s*)?\(\)\s*=>\s*$/;

describe('no import() of a chunk goes around the helper', () => {
  const files = sourceFiles(SRC);

  it('reads the source tree', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((path) => path.endsWith(join('lib', 'chunks.ts')))).toBe(true);
  });

  it('every import() under src/ is the argument of loadChunk(() => import(…)) or lazyChunk(() => import(…))', () => {
    const bypasses: string[] = [];
    let seen = 0;
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      if (!text.includes('import(')) continue;
      const code = codeOf(text);
      for (const { index, before } of dynamicImports(code)) {
        seen += 1;
        if (THROUGH_THE_HELPER.test(before)) continue;
        const line = code.slice(0, index).split('\n').length;
        bypasses.push(`${relative(SRC, path)}:${line}: ${code.slice(index - 40 < 0 ? 0 : index - 40, index + 30).replace(/\s+/g, ' ').trim()}`);
      }
    }
    expect(bypasses, 'a chunk loaded like this fails without a word when its file is gone: use loadChunk / lazyChunk (lib/chunks.ts)').toEqual([]);
    // The lazy sites and the promise sites are all found (a scan that sees nothing proves nothing).
    expect(seen).toBeGreaterThanOrEqual(18);
  });

  it('React.lazy is used by the helper alone', () => {
    const users = files.filter((path) => /\blazy\s*\(/.test(codeOf(readFileSync(path, 'utf8')))).map((path) => relative(SRC, path));
    expect(users).toEqual([join('lib', 'chunks.ts')]);
  });

  it('the scan itself: what it counts and what it lets through', () => {
    const count = (source: string): number => dynamicImports(codeOf(source)).filter(({ before }) => !THROUGH_THE_HELPER.test(before)).length;
    expect(count("const A = lazy(() => import('./A.tsx'));")).toBe(1);
    expect(count("void import('./dialogs.tsx').then(open);")).toBe(1);
    expect(count("const p = Promise.all([loadMonaco(), import('y-monaco')]);")).toBe(1);
    expect(count("const x = `${await import('./x.ts')}`;")).toBe(1);
    expect(count("const A = lazyChunk(() => import('./A.tsx'));")).toBe(0);
    expect(count("const A = lazyChunk<Props>(() => import('./A.tsx'));")).toBe(0);
    expect(count("p ??= loadChunk(() => import('./monaco.ts'));")).toBe(0);
    expect(count("p ??= loadChunk(\n  () =>\n    import('./monaco.ts'),\n);")).toBe(0);
    // Types, comments and strings are not code.
    expect(count("type M = typeof import('./monaco.ts');")).toBe(0);
    expect(count("// lazy(() => import('./A.tsx'))\n/* import('./b.ts') */ const s = \"import('./c.ts')\";")).toBe(0);
  });
});

/** Where the code makes a Worker: `new Worker(`, `new SharedWorker(`, or the class a `?worker` import gives. */
function workerStarts(text: string): number {
  const code = codeOf(text);
  let found = [...code.matchAll(/\bnew\s+(?:Shared)?Worker\s*\(/g)].length;
  // The address of an import is a string, which codeOf() empties: the names such imports give are read from the text.
  for (const match of text.matchAll(/^import\s+(\w+)\s+from\s+'[^'\n]*\?worker[^'\n]*';/gm)) {
    found += [...code.matchAll(new RegExp(`\\bnew\\s+${match[1] as string}\\s*\\(`, 'g'))].length;
  }
  return found;
}

describe('no Worker of the app is started around the helper', () => {
  const files = sourceFiles(SRC);

  it('every file under src/ that makes a Worker hands it to startWorker', () => {
    const around: string[] = [];
    const makers: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      if (!/Worker\s*\(|\?worker/.test(text) || workerStarts(text) === 0) continue;
      makers.push(relative(SRC, path));
      if (!/\bstartWorker\s*\(/.test(codeOf(text))) around.push(relative(SRC, path));
    }
    expect(around, 'a Worker started like this says nothing when its file is gone after a deploy: use startWorker (lib/chunks.ts)').toEqual([]);
    // The transfer Worker and the editor's (a scan that sees none proves nothing).
    expect(makers.sort()).toEqual([join('features', 'transfer', 'client', 'transfer-client.ts'), join('lib', 'monaco.ts')]);
  });

  it('the scan itself: what it counts', () => {
    expect(workerStarts("const w = new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' });")).toBe(1);
    expect(workerStarts("const w = new SharedWorker('/x.js');")).toBe(1);
    expect(workerStarts("import EditorWorker from 'monaco-editor/editor/editor.worker?worker';\nconst w = new EditorWorker();")).toBe(1);
    // A type, a comment, a string and a check for the class are not a start.
    expect(workerStarts("// new Worker('/x.js')\nconst s = \"new Worker('/y.js')\"; if (typeof Worker === 'undefined') throw 0; let w: Worker;")).toBe(0);
  });
});
