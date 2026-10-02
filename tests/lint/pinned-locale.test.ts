// Every test names the language it runs in (DESIGN A.10): nothing under test may read the machine's language by
// accident. A developer's machine set to Traditional Chinese (macOS without LANG: the CLI and the installer read
// AppleLanguages) and a CI runner set to `C` must run the same assertions. Four pins, checked on the source text:
//   1. web unit tests: the setup file applies English around every test; only `*.zh-TW.test.tsx` pins zh-TW;
//   2. browser tests: every browser context is created with an explicit `locale`;
//   3. a test that starts the real CLI or the installer says SMURG_LANG (or builds its environment with the CLI test
//      helper that does);
//   4. a test that reads the relay's HTML pages over HTTP sends an explicit Accept-Language.
import { describe, expect, it } from 'vitest';
import { isTestFile, read, repoFiles } from './tree.ts';

const testFiles = repoFiles().filter((path) => /\.(ts|tsx|mjs)$/.test(path) && isTestFile(path) && !path.startsWith('tests/lint/'));

/** The text of the call that starts at `open` (the index of its `(`), up to the matching `)`. */
function callText(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

describe('every test pins its language', () => {
  it('finds the test files', () => {
    expect(testFiles.length).toBeGreaterThan(250);
  });

  it('web unit tests: English is applied around every test, and only *.zh-TW.test.tsx files pin zh-TW', () => {
    const setup = read('apps/web/src/testing/setup.ts');
    expect(setup).toMatch(/beforeEach\(\(\) => \{[^}]*applyLocale\(TEST_LOCALE\)/s);
    expect(setup).toMatch(/afterEach\(\(\) => \{[^}]*applyLocale\(TEST_LOCALE\)/s);
    expect(read('apps/web/src/testing/locale.ts')).toContain("export const TEST_LOCALE: Locale = 'en';");
    const pins = repoFiles().filter((path) => /^apps\/web\/.*\.(ts|tsx)$/.test(path) && /useTestLocale\(\s*'zh-TW'\s*\)/.test(read(path)));
    const allowed = (path: string): boolean => /\.zh-TW\.test\.tsx$/.test(path) || path === 'apps/web/src/testing/locale.ts' || path === 'apps/web/src/testing/setup.ts';
    expect(pins.filter((path) => !allowed(path))).toEqual([]);
    // Each feature panel and the app shell have their zh-TW suite.
    expect(pins.filter((path) => /\.zh-TW\.test\.tsx$/.test(path)).length).toBeGreaterThanOrEqual(9);
  });

  it('browser tests: every browser context names its locale', () => {
    const hits: string[] = [];
    let contexts = 0;
    for (const path of testFiles) {
      const text = read(path);
      for (const call of text.matchAll(/\.newContext\(/g)) {
        contexts += 1;
        const args = callText(text, (call.index as number) + '.newContext'.length);
        if (!/\blocale\b/.test(args)) hits.push(`${path}:${text.slice(0, call.index).split('\n').length}: newContext${args.slice(0, 80)}`);
      }
    }
    expect(hits).toEqual([]);
    expect(contexts).toBeGreaterThanOrEqual(8);
    // The relay's browser helper cannot create a context without one.
    expect(read('apps/relay/test/chrome.ts')).toContain('newContext(options: { locale: string })');
  });

  it('a test that starts the real CLI or the installer sets SMURG_LANG', () => {
    const startsCli = /\bCLI_MAIN\b|cli\/src\/main\.ts|SMURG_SEA_BINARY|new URL\('[./]*scripts\/install\.sh'/;
    const spawns = /\b(?:spawn|spawnSync|execFile|execFileSync|exec)\(/;
    // isolatedEnv() / testIo() are packages/cli/test/helpers.ts: both set SMURG_LANG=en.
    const pinned = /SMURG_LANG|\bisolatedEnv\(|\btestIo\(/;
    const candidates = testFiles.filter((path) => {
      const text = read(path);
      return startsCli.test(text) && spawns.test(text);
    });
    expect(candidates.length).toBeGreaterThanOrEqual(10);
    expect(candidates.filter((path) => !pinned.test(read(path)))).toEqual([]);
    const helpers = read('packages/cli/test/helpers.ts');
    expect(helpers).toContain("export const TEST_LANG = 'en';");
    expect(helpers).toMatch(/export function isolatedEnv\([^)]*\)[^{]*\{[\s\S]*?SMURG_LANG: TEST_LANG/);
    expect(helpers).toContain('env: { SMURG_LANG: TEST_LANG, ...options.env }');
    expect(read('packages/cli/test/setup-no-browser.ts')).toContain("process.env['SMURG_LANG'] = 'en';");
  });

  it('a test that reads the relay’s pages over HTTP sends Accept-Language', () => {
    const readsPages = /RELAY_PATHS\.(?:device|devStart)\b/;
    const candidates = testFiles.filter((path) => {
      const text = read(path);
      return readsPages.test(text) && /\bfetch\(/.test(text) && !path.startsWith('apps/relay/test/');
    });
    expect(candidates.filter((path) => !/accept-language/i.test(read(path)))).toEqual([]);
    expect(candidates).toContain('tests/e2e/test/device-login.test.ts');
    // The relay's own tests go through one helper that always sends the header.
    const browser = read('apps/relay/test/browser.ts');
    expect(browser).toMatch(/ACCEPT_ENGLISH/);
    expect(browser).toMatch(/accept-language/i);
  });
});
