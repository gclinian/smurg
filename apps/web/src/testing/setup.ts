// vitest setup for @smurg/web (jsdom by default; a file may opt into `// @vitest-environment node`): React's act()
// environment, the pinned language (English; a zh-TW suite calls useTestLocale('zh-TW')), DOM cleanup, fresh
// storage, a Markdown renderer that remembers nothing between tests, and no lazy import left on its way.
import { act, cleanup } from '@testing-library/react';
import { LOCALE_COOKIE } from '@smurg/protocol/locale';
import { afterEach, beforeEach, vi } from 'vitest';
import { forgetParses } from '../features/markdown/lex.ts';
import { resetChunkFailures, setChunkProbe } from '../lib/chunks.ts';
import { applyLocale } from '../lib/locale.ts';
import '../strings/index.ts';
import { TEST_LOCALE } from './locale.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  applyLocale(TEST_LOCALE);
});

// A part of the page that fails to load asks the server why (lib/chunks.ts). No unit test asks a network: here the
// answer is "something else went wrong" unless the test sets its own (setChunkProbe).
beforeEach(() => {
  setChunkProbe(() => Promise.resolve('failed'));
});

afterEach(() => {
  applyLocale(TEST_LOCALE);
  // What the Markdown renderer remembers of earlier texts and of the page's time is one test's, not the next one's.
  forgetParses();
  resetChunkFailures();
  if (typeof document === 'undefined') return;
  cleanup();
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.cookie = `${LOCALE_COOKIE}=; Path=/; Max-Age=0`;
  } catch {
    // storage unavailable in this environment
  }
  document.documentElement.removeAttribute('data-theme');
  document.getElementById('root')?.removeAttribute('inert');
});

// Registered last, so it runs FIRST after a test (hooks of one kind run in the reverse of their order), while what
// the test mounted is still there. A page loads parts of itself lazily (the workspace shell, a feature's dialogs and
// columns), and a test may end before such an import has. No test ends while one is on its way: it would finish
// during the next test, or, after a file's last test, in a worker that is closing, where whatever React or jsdom
// then says is cut off with the worker (vitest: "Closing rpc while onUserConsoleLog was pending", and the run fails
// with every test green).
afterEach(async () => {
  if (typeof document === 'undefined') await vi.dynamicImportSettled();
  else await act(async () => vi.dynamicImportSettled());
});
