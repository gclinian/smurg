// Is the page this tab runs the one the relay serves now? Asked after a `version` refusal (which side has to act) and
// after a part of the page failed to load. The index.html texts are as `vite build` writes them.
import { describe, expect, it } from 'vitest';
import { askPageBuild, entryScripts } from './page-build.ts';

const ORIGIN = 'https://app.smurg.test';

function indexHtml(entry: string, extra = ''): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>smurg</title>
    <script type="module" crossorigin src="${entry}"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-DkQ1x2y3.css">${extra}
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;
}

function documentOf(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function answering(html: string, init: { status?: number; type?: string } = {}): { fetch: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fake = ((input: RequestInfo | URL, requestInit?: RequestInit) => {
    calls.push({ url: String(input), init: requestInit });
    return Promise.resolve(new Response(html, { status: init.status ?? 200, headers: { 'content-type': init.type ?? 'text/html; charset=utf-8' } }));
  }) as typeof fetch;
  return { fetch: fake, calls };
}

describe('the entry scripts a page names', () => {
  it('the module scripts of the document, as whole addresses of the origin', () => {
    expect(entryScripts(documentOf(indexHtml('/assets/index-BX3k9aQe.js')), ORIGIN)).toEqual([`${ORIGIN}/assets/index-BX3k9aQe.js`]);
    expect(entryScripts(documentOf('<html><head></head><body><div id="root"></div></body></html>'), ORIGIN)).toEqual([]);
    // Inline scripts and classic scripts are not the app.
    expect(entryScripts(documentOf('<script>var a = 1</script><script src="/x.js"></script><script type="module" src="/assets/a.js"></script>'), ORIGIN)).toEqual([`${ORIGIN}/assets/a.js`]);
  });
});

describe('asking the relay which page it serves now', () => {
  const mine = documentOf(indexHtml('/assets/index-BX3k9aQe.js'));

  it('asks for / of its own origin, past every cache, and sends no credentials it does not need', async () => {
    const relay = answering(indexHtml('/assets/index-BX3k9aQe.js'));
    await askPageBuild({ fetch: relay.fetch, document: mine, origin: ORIGIN });
    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0]?.url).toBe(`${ORIGIN}/`);
    expect(relay.calls[0]?.init).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' });
  });

  it('the same entry script: this tab runs the current page', async () => {
    expect(await askPageBuild({ fetch: answering(indexHtml('/assets/index-BX3k9aQe.js')).fetch, document: mine, origin: ORIGIN })).toBe('current');
  });

  it('another entry script: this tab is from before an update', async () => {
    expect(await askPageBuild({ fetch: answering(indexHtml('/assets/index-Zz91LmNo.js')).fetch, document: mine, origin: ORIGIN })).toBe('stale');
  });

  it('cannot ask (offline, a server error, something that is not the page, a page without a script): unknown, never a guess', async () => {
    const failing = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
    expect(await askPageBuild({ fetch: failing, document: mine, origin: ORIGIN })).toBe('unknown');
    expect(await askPageBuild({ fetch: answering('Bad gateway', { status: 502 }).fetch, document: mine, origin: ORIGIN })).toBe('unknown');
    expect(await askPageBuild({ fetch: answering('{"ok":true}', { type: 'application/json' }).fetch, document: mine, origin: ORIGIN })).toBe('unknown');
    expect(await askPageBuild({ fetch: answering('<html><body>maintenance</body></html>').fetch, document: mine, origin: ORIGIN })).toBe('unknown');
    // This document names no script (it cannot happen in the app; then nothing can be compared).
    expect(await askPageBuild({ fetch: answering(indexHtml('/assets/index-BX3k9aQe.js')).fetch, document: documentOf('<div id="root"></div>'), origin: ORIGIN })).toBe('unknown');
  });

  it('an answer that never comes ends as unknown after the time limit', async () => {
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    expect(await askPageBuild({ fetch: hanging, document: mine, origin: ORIGIN, timeoutMs: 20 })).toBe('unknown');
  });
});
