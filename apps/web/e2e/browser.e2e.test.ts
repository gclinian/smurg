// @vitest-environment node
// Acceptance tests of the web UI in a real browser (docs/ACCEPTANCE.md R1.3b, R3.2b): the real relay and daemon, the
// app on the Vite dev server, system Chrome (headless, fresh contexts). Skipped when no system Chrome is installed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import type { ViteDevServer } from 'vite';
import { startMaliciousRelay, type MaliciousRelay } from '../../../tests/e2e/src/mitm-relay.ts';
import { freePort, startWeb, startWebStack, systemChrome, type WebStack } from './stack.ts';

const PENDING_PREFIX = 'smurg.pendingInvite.';
/** Noise FINISH (msg3, the proof of the invite): a substituting relay must never see one (ARCHITECTURE §4). */
const FINISH = 0x03;

async function devLogin(page: Page, origin: string, user: string): Promise<void> {
  await page.goto(`${origin}/`);
  await page.getByTestId('dev-login-form').waitFor({ timeout: 30_000 });
  await page.getByLabel('Account name').fill(user);
  await page.getByRole('button', { name: 'Log in with a development account' }).click();
  await page.getByRole('button', { name: 'Log out' }).waitFor({ timeout: 30_000 });
}

async function pinOf(page: Page, workspaceId: string): Promise<'none' | 'pinned'> {
  return page.evaluate(async (ws) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smurg-keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!db.objectStoreNames.contains('daemon-pins')) return 'none';
    return new Promise<'none' | 'pinned'>((resolve) => {
      const get = db.transaction('daemon-pins').objectStore('daemon-pins').get(ws);
      get.onsuccess = () => resolve(get.result === undefined ? 'none' : 'pinned');
      get.onerror = () => resolve('none');
    });
  }, workspaceId);
}

async function expectKeyMismatchWarning(page: Page): Promise<void> {
  const warning = page.getByTestId('key-mismatch-screen');
  await warning.waitFor({ timeout: 60_000 });
  expect(await warning.getAttribute('role')).toBe('alertdialog');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('key-mismatch-screen');
  const text = (await warning.textContent()) ?? '';
  expect(text).toContain('Security warning: connection refused');
  expect(text).toContain('this connection was refused');
  expect(text).toContain('Ask the host to make a new invite link');
  // Nothing of the workspace is rendered behind it, and nothing offers to connect anyway.
  expect(await page.getByRole('banner', { name: 'Workspace' }).count()).toBe(0);
  expect(await page.getByRole('button', { name: /Retry|Reconnect/ }).count()).toBe(0);
}

function noFinishSent(mitm: MaliciousRelay): void {
  expect(mitm.attempts.length).toBeGreaterThan(0);
  for (const attempt of mitm.attempts) expect(attempt.clientFrames.some((frame) => frame[0] === FINISH)).toBe(false);
}


/** The join page's explicit "Join" (an invite link never joins on page load). */
async function confirmJoin(page: Page): Promise<void> {
  await page.getByTestId('join-confirm').waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Join', exact: true }).click();
}

describe.skipIf(systemChrome() === null)('web UI in a real browser (relay + daemon + Vite + system Chrome)', () => {
  let env: WebStack;
  const mitmPort = { first: 0, device: 0 };
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    mitmPort.first = await freePort();
    mitmPort.device = await freePort();
    env = await startWebStack({
      tmpDir: process.env['TMPDIR'] ?? '/tmp',
      extraOrigins: [`http://localhost:${mitmPort.first}`, `http://localhost:${mitmPort.device}`],
    });
  }, 180_000);

  afterAll(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
    await env?.stop();
  }, 60_000);

  async function newContext(): Promise<BrowserContext> {
    // English, explicitly: the app's language never depends on the machine that runs the test.
    const context = await env.browser.newContext({ locale: 'en-US' });
    cleanups.push(() => context.close());
    return context;
  }

  it('within 10 seconds of the host disconnecting, the interface of every guest shows offline — the web UI shows "Host offline" (real browser, after joining through a real invite)', async () => {
    const page = await (await newContext()).newPage();
    const invite = await env.invite();
    const fragment = invite.split('#')[1] ?? '';
    const secretValue = /(?:^|&)s=([^&]+)/.exec(fragment)?.[1] ?? '';
    expect(secretValue).toHaveLength(43);

    // The invite link, opened while logged out: the fragment leaves the address bar at once and waits in the tab.
    await page.goto(invite);
    await page.getByTestId('join-login').waitFor({ timeout: 60_000 });
    expect(page.url()).not.toContain('#');
    expect(await page.evaluate((key) => sessionStorage.getItem(key), `${PENDING_PREFIX}${env.stack.workspaceId}`)).toBe(fragment);

    // Log in through the relay (a full navigation away and back); no request ever carries the secret.
    const urls: string[] = [];
    page.on('request', (request) => urls.push(request.url()));
    await page.getByLabel('Account name').fill('amy');
    await page.getByRole('button', { name: 'Log in with a development account' }).click();
    // Back from the login: nothing joins without the explicit "Join".
    await confirmJoin(page);
    await page.waitForURL(`${env.webOrigin}/w/${env.stack.workspaceId}`, { timeout: 60_000 });
    await page.getByRole('banner', { name: 'Workspace' }).locator('[data-connection-view="online"]').filter({ hasText: 'Connected' }).waitFor({ timeout: 60_000 });
    expect(urls.some((url) => url.includes(secretValue) || url.includes('#'))).toBe(false);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), `${PENDING_PREFIX}${env.stack.workspaceId}`)).toBeNull();
    expect(await pinOf(page, env.stack.workspaceId)).toBe('pinned');

    // The host's laptop goes to sleep (its socket stays open and silent).
    const pausedAt = Date.now();
    env.stack.pauseHost();
    try {
      await page.getByTestId('host-offline-banner').waitFor({ timeout: 15_000 });
      const shownAfter = Date.now() - pausedAt;
      console.info(`[R1.3b] web UI showed "Host offline" ${shownAfter} ms after the host paused`);
      expect(shownAfter).toBeLessThan(10_000);
      expect(await page.getByRole('banner', { name: 'Workspace' }).textContent()).toContain('Host offline');
      // Not frozen: the workbench still responds.
      await page.getByRole('tab', { name: 'Conflicts' }).click();
      expect(await page.getByRole('tab', { name: 'Conflicts' }).getAttribute('aria-selected')).toBe('true');
    } finally {
      env.stack.resumeHost();
    }
    await page.getByTestId('host-offline-banner').waitFor({ state: 'detached', timeout: 60_000 });

    // A reload reconnects in device mode from IndexedDB (no invite needed any more).
    await page.reload();
    await page.getByRole('banner', { name: 'Workspace' }).locator('[data-connection-view="online"]').filter({ hasText: 'Connected' }).waitFor({ timeout: 60_000 });
  }, 180_000);

  it('when the relay replaces the daemon public key with its own, the client refuses the connection and shows a warning — the web warning screen (real browser, first contact)', async () => {
    const mitm = await startMaliciousRelay({ upstream: env.relay.origin, workspaceId: env.stack.workspaceId, substitution: { kind: 'blind' } });
    cleanups.push(() => mitm.close());
    const origin = `http://localhost:${mitmPort.first}`;
    const front: ViteDevServer = await startWeb({ port: mitmPort.first, upstream: mitm.origin, bearerFromCookie: true, cacheDir: `${process.env['TMPDIR'] ?? '/tmp'}/vite-cache-mitm` });
    cleanups.push(() => front.close());

    const page = await (await newContext()).newPage();
    // Logged in through the honest front end (same host name, so the session cookie is shared).
    await devLogin(page, env.webOrigin, 'vic');
    const listInvites = async () => (await env.stack.hostClient.conn.request('admin.invite.list', {})).invites;
    const before = new Set((await listInvites()).map((invite) => invite.id));
    await page.goto(await env.invite(origin));
    await confirmJoin(page);

    await expectKeyMismatchWarning(page);
    noFinishSent(mitm);
    expect(await pinOf(page, env.stack.workspaceId)).toBe('none');
    // The invite was never used: the attacker could not prove it to the daemon.
    const fresh = (await listInvites()).filter((invite) => !before.has(invite.id));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.uses).toBe(0);
  }, 180_000);

  it('when the relay replaces the daemon public key with its own, the client refuses the connection and shows a warning — the web warning screen (real browser, reconnect of a browser that pinned the real key)', async () => {
    const origin = `http://localhost:${mitmPort.device}`;
    // First through an honest front end on this origin: join, pin the real daemon key.
    let front: ViteDevServer = await startWeb({ port: mitmPort.device, upstream: env.relay.origin, cacheDir: `${process.env['TMPDIR'] ?? '/tmp'}/vite-cache-device` });
    const page = await (await newContext()).newPage();
    await devLogin(page, origin, 'dora');
    await page.goto(await env.invite(origin));
    await confirmJoin(page);
    await page.getByRole('banner', { name: 'Workspace' }).locator('[data-connection-view="online"]').filter({ hasText: 'Connected' }).waitFor({ timeout: 60_000 });
    expect(await pinOf(page, env.stack.workspaceId)).toBe('pinned');
    await front.close();

    // Then the same origin (same IndexedDB, same pin) is served through a relay that substitutes the key.
    const mitm = await startMaliciousRelay({ upstream: env.relay.origin, workspaceId: env.stack.workspaceId, substitution: { kind: 'blind' } });
    cleanups.push(() => mitm.close());
    front = await startWeb({ port: mitmPort.device, upstream: mitm.origin, bearerFromCookie: true, cacheDir: `${process.env['TMPDIR'] ?? '/tmp'}/vite-cache-device` });
    cleanups.push(() => front.close());
    await page.reload();

    await expectKeyMismatchWarning(page);
    noFinishSent(mitm);
    expect(await pinOf(page, env.stack.workspaceId)).toBe('pinned');
  }, 180_000);
});
