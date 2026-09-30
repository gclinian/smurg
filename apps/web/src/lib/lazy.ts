// The only way to load the heavy libraries: dynamic imports that Vite turns into separate chunks, fetched the first
// time an editor or a terminal is shown. scripts/check-chunks.ts fails the build if Monaco or xterm ever reaches the
// entry chunk (e.g. through a static import of lib/monaco.ts or lib/xterm.ts).

type MonacoModule = typeof import('./monaco.ts');
type XtermModule = typeof import('./xterm.ts');

let monacoPromise: Promise<MonacoModule> | null = null;
let xtermPromise: Promise<XtermModule> | null = null;

/** Monaco (slim entry points + editor worker + smurg defaults), loaded once. */
export function loadMonaco(): Promise<MonacoModule> {
  monacoPromise ??= import('./monaco.ts').catch((error: unknown) => {
    monacoPromise = null; // a failed chunk load (network) may be retried
    throw error;
  });
  return monacoPromise;
}

/** xterm.js with the web-links and unicode11 addons, loaded once. */
export function loadXterm(): Promise<XtermModule> {
  xtermPromise ??= import('./xterm.ts').catch((error: unknown) => {
    xtermPromise = null;
    throw error;
  });
  return xtermPromise;
}
