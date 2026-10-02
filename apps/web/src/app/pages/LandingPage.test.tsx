import { screen } from '@testing-library/react';
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
