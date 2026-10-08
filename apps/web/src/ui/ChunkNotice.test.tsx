// What the page says when a part of it could not be loaded, in a slot, in a silent slot (through the workspace's
// banner) and for a failure that was only reported; and that a slot that really crashed keeps its own words.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChunkLoadError, page, reportChunkFailure } from '../lib/chunks.ts';
import { ChunkFailureBanner, ChunkNotice, SlotBoundary } from './index.ts';

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

describe('the notice for a part of the page that did not load', () => {
  it('the file is gone: "smurg was updated", what a reload does, and the reload', async () => {
    render(<ChunkNotice error={new ChunkLoadError('gone', null)} />);
    const notice = screen.getByRole('alert');
    expect(notice.textContent).toBe('smurg was updatedReload to get the new page; if the host has not updated yet, the page will say so.Reload the page');
    await userEvent.click(within(notice).getByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the network is gone: says offline, says nothing about an update', () => {
    render(<ChunkNotice error={new ChunkLoadError('offline', null)} />);
    const notice = screen.getByRole('alert');
    expect(notice.textContent).toContain('This part of the page could not be loaded');
    expect(notice.textContent).toContain('The browser is offline or cannot reach the smurg server. When the connection is back, reload the page.');
    expect(notice.textContent).not.toMatch(/updated/);
    expect(within(notice).getByRole('button', { name: 'Reload the page' })).toBeTruthy();
  });

  it('something else: says only that it could not be loaded', () => {
    render(<ChunkNotice error={new ChunkLoadError('failed', null)} />);
    const notice = screen.getByRole('alert');
    expect(notice.textContent).toContain('This part of the page could not be loaded');
    expect(notice.textContent).toContain('Reload the page to load it again.');
    expect(notice.textContent).not.toMatch(/updated|offline/);
  });
});

describe('a slot whose chunk did not come', () => {
  it('shows the notice in its place, with the reload and without "Show again" (a failed import stays failed)', () => {
    render(
      <>
        <p>still here</p>
        <SlotBoundary name="Terminal (amy)">
          <Throws error={new ChunkLoadError('gone', new TypeError('Failed to fetch dynamically imported module'))} />
        </SlotBoundary>
        <ChunkFailureBanner />
      </>,
    );
    const alerts = screen.getAllByRole('alert');
    // In the slot, and only there: it has a place of its own.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain('smurg was updated');
    expect(alerts[0]?.textContent).not.toContain('cannot be shown');
    expect(screen.queryByRole('button', { name: 'Show again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    expect(screen.getByText('still here')).toBeTruthy();
  });

  it('silent: the slot itself still shows nothing, and the banner of the workspace says it, once for several', async () => {
    const { container } = render(
      <>
        <div data-testid="banners">
          <ChunkFailureBanner />
        </div>
        <div data-testid="overlays">
          <SlotBoundary name="topics" silent>
            <Throws error={new ChunkLoadError('gone', null)} />
          </SlotBoundary>
          <SlotBoundary name="console" silent>
            <Throws error={new ChunkLoadError('gone', null)} />
          </SlotBoundary>
        </div>
      </>,
    );
    expect(within(container).getByTestId('overlays').textContent).toBe('');
    const banner = await screen.findByRole('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(banner.textContent).toContain('smurg was updated');
    expect(banner.textContent).toContain('Reload to get the new page; if the host has not updated yet, the page will say so.');
    await userEvent.click(within(banner).getByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('silent, and the network is gone: the banner says offline, not updated', async () => {
    render(
      <>
        <ChunkFailureBanner />
        <SlotBoundary name="agents" silent>
          <Throws error={new ChunkLoadError('offline', null)} />
        </SlotBoundary>
      </>,
    );
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('The browser is offline or cannot reach the smurg server.');
    expect(banner.textContent).not.toMatch(/updated/);
  });

  it('a slot that really crashed keeps its own words, and a silent one that crashed says nothing anywhere', () => {
    render(
      <>
        <ChunkFailureBanner />
        <SlotBoundary name="1 · Cart API">
          <Throws error={new Error('boom')} />
        </SlotBoundary>
        <SlotBoundary name="conversation" silent>
          <Throws error={new Error('boom')} />
        </SlotBoundary>
      </>,
    );
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain('1 · Cart API cannot be shown');
    expect(screen.getByRole('button', { name: 'Show again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload the page' })).toBeNull();
  });
});

describe('the banner for failures without a place of their own', () => {
  it('shows nothing while there is none, then the reported failure; an update outranks the rest', async () => {
    const { container } = render(<ChunkFailureBanner />);
    expect(container.textContent).toBe('');
    reportChunkFailure(new ChunkLoadError('failed', null));
    expect((await screen.findByRole('alert')).textContent).toContain('Reload the page to load it again.');
    reportChunkFailure(new ChunkLoadError('gone', null));
    expect((await screen.findByText(/if the host has not updated yet/)).closest('[role="alert"]')?.textContent).toContain('smurg was updated');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
