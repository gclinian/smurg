// vitest setup for @smurg/web (jsdom by default; a file may opt into `// @vitest-environment node`): React's act()
// environment, the pinned language (English; a zh-TW suite calls useTestLocale('zh-TW')), DOM cleanup and fresh
// storage between tests.
import { cleanup } from '@testing-library/react';
import { LOCALE_COOKIE } from '@smurg/protocol/locale';
import { afterEach, beforeEach } from 'vitest';
import { applyLocale } from '../lib/locale.ts';
import '../strings/index.ts';
import { TEST_LOCALE } from './locale.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  applyLocale(TEST_LOCALE);
});

afterEach(() => {
  applyLocale(TEST_LOCALE);
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
