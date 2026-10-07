// The language menu on every screen, and the live switch: the route tree re-mounts in the chosen language, nothing
// reloads, the connection is the same one.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LOCALE_STORAGE_KEY } from '@smurg/protocol/locale';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PENDING_INVITE_KEY_PREFIX } from '../boot/capture-invite.ts';
import { getLocale, localeCookieValue } from '../lib/locale.ts';
import { WORKSPACE_ID, makeInvite, makeWelcome } from '../testing/fixtures.ts';
import { createTestServices, type TestServices } from '../testing/services.tsx';
import { App } from './App.tsx';

/** Opens the language menu (a globe button named in the current language) and picks a language by its own name. */
async function chooseLanguage(name: 'English' | '繁體中文', menuLabel: 'Language' | '語言' = 'Language'): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: menuLabel }));
  await userEvent.click(within(screen.getByRole('menu', { name: menuLabel })).getByRole('menuitemradio', { name }));
}

function open(path: string, options: Parameters<typeof createTestServices>[0] = {}): TestServices {
  const services = createTestServices({ path, ...options });
  render(<App services={services} />);
  return services;
}

// The workspace page loads its shell and every feature's dialogs lazily. A test may end before such an import has
// finished; testing/setup.ts waits for it after every test. Without that the import finishes after this file's last
// test, in a worker that is closing, and what React or jsdom then says is cut off with the worker ("Closing rpc while
// onUserConsoleLog was pending": the whole unit project exited 1 with every test green, once in a few runs).
afterAll(async () => {
  const late: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void late.push(String(args[0]).slice(0, 80)));
  await vi.dynamicImportSettled();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  spy.mockRestore();
  expect(late).toEqual([]);
});

describe('language menu', () => {
  it('lists the two languages, each in itself with its own lang attribute, and marks the current one', async () => {
    open('/', { user: null });
    await userEvent.click(await screen.findByRole('button', { name: 'Language' }));
    const items = within(screen.getByRole('menu', { name: 'Language' })).getAllByRole('menuitemradio');
    expect(items.map((item) => [item.textContent, item.getAttribute('aria-checked'), item.querySelector('[lang]')?.getAttribute('lang')])).toEqual([
      ['English', 'true', 'en'],
      ['繁體中文', 'false', 'zh-Hant-TW'],
    ]);
  });

  it('switches the landing page without a reload and remembers the choice (storage + the cookie for the relay pages)', async () => {
    open('/', { user: null });
    expect(await screen.findByRole('heading', { name: 'Log in', level: 2 })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');

    await chooseLanguage('繁體中文');
    expect(await screen.findByRole('heading', { name: '登入', level: 2 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Log in' })).toBeNull();
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-TW');
    expect(localeCookieValue(document.cookie)).toBe('zh-TW');

    // The menu itself is now named in Chinese; English is still called "English".
    await chooseLanguage('English', '語言');
    expect(await screen.findByRole('heading', { name: 'Log in', level: 2 })).toBeTruthy();
    expect(getLocale()).toBe('en');
  });

  it('is on the screens that have no top bar: not found, login for a join, an incomplete invite, connecting, a refused connection', async () => {
    const notFound = open('/nowhere');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    await chooseLanguage('繁體中文');
    expect(await screen.findByRole('heading', { name: '找不到這個頁面' })).toBeTruthy();
    await chooseLanguage('English', '語言');

    // /join without the fragment: the "incomplete link" page.
    act(() => notFound.router.navigate(`/join/${WORKSPACE_ID}`));
    expect(await screen.findByRole('heading', { name: 'The invite link is incomplete' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Language' })).toBeTruthy();
  });

  it('join: the login step and the confirmation follow the switch; the invite survives it', async () => {
    const services = createTestServices({ path: `/join/${WORKSPACE_ID}`, user: null });
    services.sessionStorage.setItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID, makeInvite().fragment);
    render(<App services={services} />);
    expect(await screen.findByRole('heading', { name: 'Log in to join the workspace' })).toBeTruthy();
    await chooseLanguage('繁體中文');
    expect(await screen.findByRole('heading', { name: '登入後加入工作區' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '使用 GitHub 登入' })).toBeTruthy();
    // Nothing was connected and the invite is still waiting in the tab's storage.
    expect(services.connections).toHaveLength(0);
    expect(services.sessionStorage.getItem(PENDING_INVITE_KEY_PREFIX + WORKSPACE_ID)).not.toBeNull();
  });

  it('workspace: the connecting screen, the top bar and a refusal all carry the menu; the switch keeps the one connection', async () => {
    const services = open(`/w/${WORKSPACE_ID}`);
    await waitFor(() => expect(services.connections).toHaveLength(1), { timeout: 15_000 });
    const { conn } = services.connections[0]!;
    expect(await screen.findByRole('heading', { name: 'Connecting to the workspace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Language' })).toBeTruthy();

    act(() => conn.admit(makeWelcome({ role: 'editor' })));
    const topbar = await screen.findByRole('banner', { name: 'Workspace' }, { timeout: 15_000 });
    expect(within(topbar).getByText('Editor')).toBeTruthy();
    expect(within(topbar).getByText('Host: Ian')).toBeTruthy();

    await userEvent.click(within(topbar).getByRole('button', { name: 'Language' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: '繁體中文' }));
    const zhTopbar = await screen.findByRole('banner', { name: '工作區' }, { timeout: 15_000 });
    expect(within(zhTopbar).getByText('可編輯')).toBeTruthy();
    expect(within(zhTopbar).getByText('主人：Ian')).toBeTruthy();
    expect(within(zhTopbar).getByRole('status').textContent).toContain('已連線');
    // Same session, same connection: the manager handed the re-mounted page the one it already had.
    expect(services.connections).toHaveLength(1);
    expect(conn.getState().kind).toBe('online');

    act(() => conn.setState({ kind: 'closed', reason: 'kicked', daemonReason: 'kicked' }));
    const ended = await screen.findByTestId('connection-ended-screen');
    expect(ended.textContent).toContain('你已被移出工作區');
    await userEvent.click(within(ended).getByRole('button', { name: '語言' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'English' }));
    expect((await screen.findByTestId('connection-ended-screen')).textContent).toContain('You were removed from the workspace');
  });

  it('the key-mismatch warning keeps its own action first in the tab order; the language menu is the last control of the card', async () => {
    const services = open(`/w/${WORKSPACE_ID}`);
    await waitFor(() => expect(services.connections).toHaveLength(1), { timeout: 15_000 });
    act(() => services.connections[0]!.conn.setState({ kind: 'key-mismatch', mode: 'device', detail: 'fingerprint' }));
    const warning = await screen.findByRole('alertdialog', { name: 'Security warning: connection refused' });
    const buttons = within(warning).getAllByRole('button');
    expect(buttons.map((button) => button.textContent || button.getAttribute('aria-label'))).toEqual(['Back to home', 'Language']);
  });
});
