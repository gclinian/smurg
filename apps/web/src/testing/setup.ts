// vitest setup for @smurg/web (jsdom by default; a file may opt into `// @vitest-environment node`): React's act()
// environment, DOM cleanup and fresh storage between tests.
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '../strings/index.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  if (typeof document === 'undefined') return;
  cleanup();
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // storage unavailable in this environment
  }
  document.documentElement.removeAttribute('data-theme');
  document.getElementById('root')?.removeAttribute('inert');
});
