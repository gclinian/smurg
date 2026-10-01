import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createTestServices, renderApp } from '../../testing/services.tsx';

describe('landing page footer', () => {
  it('links the guides and smurg license on smurg.ai and this origin’s third-party notices (plain links, not app routes)', async () => {
    renderApp(createTestServices({ path: '/', user: null }));
    const docs = await screen.findByRole('link', { name: '說明文件' });
    expect(docs.getAttribute('href')).toBe('https://smurg.ai/docs/');
    expect(screen.getByRole('link', { name: '授權條款' }).getAttribute('href')).toBe('https://smurg.ai/license/');
    expect(screen.getByRole('link', { name: '第三方軟體授權聲明' }).getAttribute('href')).toBe('/third-party-notices.txt');
    expect(screen.getByRole('contentinfo').textContent).not.toMatch(/github|open source|開源|Apache/i);
  });
});
