// Where system Chrome lives (playwright-core downloads no browser), and how every test launches it. Its own module so
// that a vitest globalSetup can ask without loading the browser-test harness (relay, daemon, Vite) into vitest's main
// process. apps/relay's browser tests launch Chrome with the same options (apps/relay/test/chrome.ts).
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
];

/**
 * System Chrome, or null: the browser tests skip themselves without one.
 *
 * `SMURG_TEST_CHROME=<absolute path>` names the browser instead, for a machine that has a Chrome or a Chromium of the
 * same kind somewhere else (Google ships no Chrome for Linux on arm64: there a "Chrome for Testing" build that is
 * already on the machine can run the browser tests). Nothing is ever downloaded, and a path that does not exist is
 * "no Chrome" (the tests skip, loudly), never a silent fall back to another browser.
 */
export function systemChrome(): string | null {
  const named = process.env['SMURG_TEST_CHROME'];
  if (named !== undefined && named !== '') return isAbsolute(named) && existsSync(named) ? named : null;
  return CHROME_PATHS.find((path) => existsSync(path)) ?? null;
}

/**
 * Host names the test browser may resolve: the loopback names and literals the tests use. Everything else fails
 * name resolution inside Chrome.
 */
const LOOPBACK_HOSTS = ['localhost', '*.localhost', '127.0.0.1', '[::1]'];

export interface ChromeLaunchOptions {
  executablePath: string;
  headless: true;
  args: string[];
  env: Record<string, string>;
}

/**
 * Launch options that keep a test's Chrome inside the test (gate-stability, 2026-09-29):
 *   - no network beyond loopback: even with playwright's `--disable-component-update`, a fresh profile of Chrome 153
 *     downloaded its "Model Manifest" component from Google's servers during the relay's login tests. Every name except
 *     the loopback ones fails to resolve (`--host-resolver-rules`; IP literals are matched too, hence 127.0.0.1);
 *   - its temp files in the test's TMPDIR: on macOS Chrome ignores TMPDIR and writes to the per-user temp dir
 *     (`com.google.Chrome.chrome_chrome_url_fetcher_.*` was left there once per gate run). Chrome reads
 *     MAC_CHROMIUM_TMPDIR instead; the projects' TMPDIR is removed by their global teardown.
 * The profile itself is playwright's (a fresh one per launch under TMPDIR, removed by close()).
 */
export function chromeLaunchOptions(executablePath: string): ChromeLaunchOptions {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env['MAC_CHROMIUM_TMPDIR'] = tmpdir();
  const rules = ['MAP * ~NOTFOUND', ...LOOPBACK_HOSTS.map((host) => `EXCLUDE ${host}`)].join(', ');
  return { executablePath, headless: true, args: [`--host-resolver-rules=${rules}`], env };
}
