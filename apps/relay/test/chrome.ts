// System Chrome through playwright-core for the relay's real-browser tests (headless, a fresh temporary profile per
// launch; no browser download, no cookie import; no network beyond loopback, temp files in TMPDIR: the launch options
// of apps/web/e2e/chrome.ts).
//
// playwright-core is pinned once, as a devDependency of @smurg/web (ARCHITECTURE §1): the relay borrows that copy
// instead of adding a second entry to the lockfile, and types only the few calls its tests make.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromeLaunchOptions, type ChromeLaunchOptions } from '../../web/e2e/chrome.ts';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
];

/** System Chrome, or null: the browser tests skip themselves without one (as apps/web/e2e does). */
export function systemChrome(): string | null {
  return CHROME_PATHS.find((path) => existsSync(path)) ?? null;
}

export interface ConsoleMessage {
  type(): string;
  text(): string;
}

export interface Page {
  goto(url: string): Promise<unknown>;
  url(): string;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  waitForURL(url: (url: URL) => boolean, options?: { timeout?: number }): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  on(event: 'console', listener: (message: ConsoleMessage) => void): void;
}

export interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

export interface Browser {
  newContext(): Promise<BrowserContext>;
  close(): Promise<void>;
}

interface Chromium {
  launch(options: ChromeLaunchOptions): Promise<Browser>;
}

/** Launches system Chrome headless. Its temporary profile and temp files live under TMPDIR; close() removes the profile. */
export async function launchChrome(executablePath: string): Promise<Browser> {
  const fromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
  const module = (await import(pathToFileURL(fromWeb.resolve('playwright-core')).href)) as { chromium?: Chromium; default?: { chromium: Chromium } };
  const chromium = module.chromium ?? module.default?.chromium;
  if (!chromium) throw new Error('playwright-core: no chromium export');
  return chromium.launch(chromeLaunchOptions(executablePath));
}
