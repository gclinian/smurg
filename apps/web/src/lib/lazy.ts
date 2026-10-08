// The only way to load the heavy libraries: dynamic imports that Vite turns into separate chunks, fetched the first
// time an editor or a terminal is shown. scripts/check-chunks.ts fails the build if Monaco or xterm ever reaches the
// entry chunk (e.g. through a static import of lib/monaco.ts or lib/xterm.ts).
//
// Through loadChunk (lib/chunks.ts) like every chunk: a load that fails rejects with a ChunkLoadError that says why
// (the web app was deployed again, the network is gone), and the editor and the terminal show the notice for it.
import { loadChunk } from './chunks.ts';

type MonacoModule = typeof import('./monaco.ts');
type XtermModule = typeof import('./xterm.ts');

let monacoPromise: Promise<MonacoModule> | null = null;
let xtermPromise: Promise<XtermModule> | null = null;

/** Monaco (slim entry points + editor worker + smurg defaults), loaded once. */
export function loadMonaco(): Promise<MonacoModule> {
  monacoPromise ??= loadChunk(() => import('./monaco.ts')).catch((error: unknown) => {
    // Not kept: a later call asks again (a browser that keeps the failed import answers the same until a reload).
    monacoPromise = null;
    throw error;
  });
  return monacoPromise;
}

/** xterm.js with the web-links and unicode11 addons, loaded once. */
export function loadXterm(): Promise<XtermModule> {
  xtermPromise ??= loadChunk(() => import('./xterm.ts')).catch((error: unknown) => {
    xtermPromise = null;
    throw error;
  });
  return xtermPromise;
}
