// The test pin of the language. src/testing/setup.ts sets English before EVERY test (nothing under test may read
// navigator.languages, a cookie or localStorage implicitly). A zh-TW suite (`*.zh-TW.test.tsx`) calls
// `useTestLocale('zh-TW')` once at the top of the file, or inside a `describe` to pin only that block.
import { beforeEach } from 'vitest';
import { applyLocale, type Locale } from '../lib/locale.ts';

/** English, the default of every test. */
export const TEST_LOCALE: Locale = 'en';

/** Pins the language of the tests of this file (top level) or of the enclosing `describe`. */
export function useTestLocale(locale: Locale): void {
  // Registered after the setup file's own beforeEach, so it runs after the reset to English.
  beforeEach(() => {
    applyLocale(locale);
  });
}
