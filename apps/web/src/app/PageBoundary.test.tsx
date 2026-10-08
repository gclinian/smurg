// The boundary around the routes. Before it, a route whose chunk did not come emptied the page: a tab that was loaded
// before the web app was deployed again, sitting on the landing or the join page, went blank at the first click into
// a workspace (React unmounts everything when nothing catches). Here the workspace route's chunk does not come.
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChunkLoadError, page, setChunkProbe } from '../lib/chunks.ts';
import { WORKSPACE_ID } from '../testing/fixtures.ts';
import { createTestServices } from '../testing/services.tsx';
import { AppServicesProvider } from './services.tsx';
import { App } from './App.tsx';
import { PageBoundary } from './PageBoundary.tsx';

// What a browser does with a chunk the relay answers with the page itself: the import rejects.
vi.mock('./workspace/WorkspaceRoute.tsx', () => {
  throw new TypeError('Failed to fetch dynamically imported module: http://localhost:3000/assets/WorkspaceRoute-BdgRFkCq.js');
});

function Throws({ error }: { error: unknown }): null {
  throw error;
}

let reload: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a route whose chunk does not come', () => {
  it('the workspace page of a tab from before a deploy: the page says that smurg was updated and offers the reload, it is not empty; going back shows the page that is loaded', async () => {
    setChunkProbe(() => Promise.resolve('gone'));
    const services = createTestServices({ path: '/', user: null });
    const { container } = render(<App services={services} />);
    expect(await screen.findByRole('heading', { name: 'Log in', level: 2 })).toBeTruthy();

    act(() => services.router.navigate(`/w/${WORKSPACE_ID}`));
    const notice = await screen.findByTestId('page-not-loaded', undefined, { timeout: 15_000 });
    expect(container.textContent).not.toBe('');
    expect(notice.getAttribute('role')).toBe('alertdialog');
    expect(within(notice).getByRole('heading', { name: 'smurg was updated' })).toBeTruthy();
    expect(notice.textContent).toContain('Reload to get the new page; if the host has not updated yet, the page will say so.');
    // A person who cannot read the page can switch the language here too.
    expect(within(notice).getByRole('button', { name: 'Language' })).toBeTruthy();
    await userEvent.click(within(notice).getByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalledTimes(1);
    // Nothing connected for a page that never loaded.
    expect(services.connections).toHaveLength(0);

    // The landing page is in the entry chunk: it still works.
    act(() => services.router.navigate('/'));
    expect(await screen.findByRole('heading', { name: 'Log in', level: 2 })).toBeTruthy();
    expect(screen.queryByTestId('page-not-loaded')).toBeNull();
    // And the workspace still does not: the same words again, never an empty page.
    act(() => services.router.navigate(`/w/${WORKSPACE_ID}/code`));
    expect(await screen.findByTestId('page-not-loaded')).toBeTruthy();
  });
});

describe('the boundary by itself', () => {
  function inApp(children: React.ReactNode, resetKey = 'a') {
    return (
      <AppServicesProvider services={createTestServices()}>
        <PageBoundary resetKey={resetKey}>{children}</PageBoundary>
      </AppServicesProvider>
    );
  }

  it('the network is gone: says offline, not updated', () => {
    render(inApp(<Throws error={new ChunkLoadError('offline', null)} />));
    const notice = screen.getByTestId('page-not-loaded');
    expect(notice.textContent).toContain('This part of the page could not be loaded');
    expect(notice.textContent).toContain('The browser is offline or cannot reach the smurg server. When the connection is back, reload the page.');
    expect(notice.textContent).not.toMatch(/updated/);
    expect(within(notice).getByRole('button', { name: 'Reload the page' })).toBeTruthy();
  });

  it('anything else that reaches it is said plainly, with the reload: never an empty page', async () => {
    const { container } = render(inApp(<Throws error={new Error('a bug')} />));
    const crashed = screen.getByTestId('page-crashed');
    expect(within(crashed).getByRole('heading', { name: 'This page stopped working' })).toBeTruthy();
    expect(crashed.textContent).toContain('Something went wrong on this page. Reload the page to go on.');
    expect(container.textContent).not.toMatch(/updated|offline/);
    await userEvent.click(within(crashed).getByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('lets go when the person goes to another page, and only then', () => {
    let fail = true;
    function Sometimes() {
      if (fail) throw new ChunkLoadError('gone', null);
      return <p>the page</p>;
    }
    const view = render(inApp(<Sometimes />, 'a'));
    expect(screen.getByTestId('page-not-loaded')).toBeTruthy();
    fail = false;
    view.rerender(inApp(<Sometimes />, 'a'));
    expect(screen.getByTestId('page-not-loaded')).toBeTruthy();
    view.rerender(inApp(<Sometimes />, 'b'));
    expect(screen.getByText('the page')).toBeTruthy();
    expect(screen.queryByTestId('page-not-loaded')).toBeNull();
  });
});
