import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { applyLocale } from '../../lib/locale.ts';
import { createTestServices, renderApp } from '../../testing/services.tsx';

describe('landing page footer', () => {
  it('links the guides, the source code and the license, and this origin’s third-party notices (plain links, not app routes)', async () => {
    renderApp(createTestServices({ path: '/', user: null }));
    const docs = await screen.findByRole('link', { name: 'Docs' });
    expect(docs.getAttribute('href')).toBe('https://smurg.ai/docs/');
    expect(screen.getByRole('link', { name: 'Source code' }).getAttribute('href')).toBe('https://github.com/gclinian/smurg');
    expect(screen.getByRole('link', { name: 'License' }).getAttribute('href')).toBe('https://smurg.ai/license/');
    expect(screen.getByRole('link', { name: 'Third-party notices' }).getAttribute('href')).toBe('/third-party-notices.txt');
    expect(screen.getByRole('contentinfo').textContent).not.toMatch(/proprietary|all rights reserved/i);
  });

  it('the guides and the license page follow the language', async () => {
    applyLocale('zh-TW');
    renderApp(createTestServices({ path: '/', user: null }));
    expect((await screen.findByRole('link', { name: '說明文件' })).getAttribute('href')).toBe('https://smurg.ai/zh-TW/docs/');
    expect(screen.getByRole('link', { name: '授權條款' }).getAttribute('href')).toBe('https://smurg.ai/zh-TW/license/');
    expect(screen.getByRole('link', { name: '原始碼' }).getAttribute('href')).toBe('https://github.com/gclinian/smurg');
  });
});

describe('landing page: what this browser keeps of unsent texts (review R4-08)', () => {
  const A = 'ws_landing_test_workspace_a';
  const B = 'ws_landing_test_workspace_b';
  const keep = (): void => {
    for (const id of [A, B]) window.localStorage.setItem(`smurg.drafts.${id}`, JSON.stringify([['sess_1', { text: 'const key = 1;', source: null }]]));
    // A convenience that says nothing about the project stays.
    window.localStorage.setItem(`smurg.columns.${A}`, '{}');
  };

  it('logging out deletes the drafts of every workspace, once the logout has succeeded (review R2-D, third round)', async () => {
    keep();
    const services = createTestServices({ path: '/' });
    // The request is on its way: nothing is deleted yet.
    let answer: (() => void) | null = null;
    services.auth.logout = () => new Promise<void>((resolve) => (answer = resolve));
    // A workspace page was left a moment ago: its session is still held for a while.
    services.manager.acquire(A).release();
    expect(services.manager.peek(A)).not.toBeNull();
    const view = renderApp(services);
    await userEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(window.localStorage.getItem(`smurg.drafts.${A}`)).not.toBeNull();
    (answer as unknown as () => void)();
    await waitFor(() => expect(window.localStorage.getItem(`smurg.drafts.${A}`)).toBeNull());
    expect(window.localStorage.getItem(`smurg.drafts.${B}`)).toBeNull();
    expect(window.localStorage.getItem(`smurg.columns.${A}`)).toBe('{}');
    // And no session of this page outlives the login: nothing is left that could write a draft back.
    expect(services.manager.peek(A)).toBeNull();
    view.unmount();
  });

  it('a logout that fails deletes nothing: the person is still logged in, with their unsent texts', async () => {
    keep();
    const services = createTestServices({ path: '/' });
    let failed = false;
    services.auth.logout = () => {
      failed = true;
      return Promise.reject(new Error('offline'));
    };
    const view = renderApp(services);
    await userEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(failed).toBe(true));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(window.localStorage.getItem(`smurg.drafts.${A}`)).toContain('const key = 1;');
    expect(window.localStorage.getItem(`smurg.drafts.${B}`)).toContain('const key = 1;');
    view.unmount();
  });

  it('taking a workspace off the list of recent ones deletes its drafts, and only its', async () => {
    keep();
    const services = createTestServices({ path: '/' });
    services.recent.remember({ id: A, name: 'project-a' });
    services.recent.remember({ id: B, name: 'project-b' });
    renderApp(services);
    const row = (await screen.findByText('project-a')).closest('li') as HTMLElement;
    await userEvent.click(row.querySelector('button') as HTMLButtonElement);
    expect(window.localStorage.getItem(`smurg.drafts.${A}`)).toBeNull();
    expect(window.localStorage.getItem(`smurg.drafts.${B}`)).not.toBeNull();
  });
});

