// "Rename session…" and "End session…" of a session row load the dialogs' code when they are chosen. A menu item has
// no place on the page to say that the code did not come: before, the click did nothing, without a word. Now the
// failure goes to the workspace's banner (lib/chunks.ts reportChunkFailure, ui/ChunkNotice.tsx).
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildAgentSession } from '@smurg/protocol/testing';
import { capabilitiesForRole } from '../../lib/capabilities.ts';
import { chunkFailures, setChunkProbe } from '../../lib/chunks.ts';
import { makeMember } from '../../testing/fixtures.ts';
import { ChunkFailureBanner } from '../../ui/index.ts';
import { slots } from './slots.tsx';

// (Not from test-support.tsx: it loads the dialogs with the column, and here their chunk never comes.)
const IAN = { userId: 'dev:ian', displayName: 'Ian' };
const SID = 's_0000000000000001';

// What a browser does with a chunk the relay answers with the page itself: the import rejects.
vi.mock('./dialogs.tsx', () => {
  throw new TypeError('Failed to fetch dynamically imported module: http://localhost:3000/assets/dialogs-BfeSlUi5.js');
});

describe("a session row's dialogs whose chunk does not come", () => {
  it('choosing "Rename session…" says so in the banner of the workspace instead of doing nothing', async () => {
    setChunkProbe(() => Promise.resolve('gone'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<ChunkFailureBanner />);
    const env = { stores: {} as never, commands: {} as never, capabilities: capabilitiesForRole('host'), member: makeMember({ userId: IAN.userId, role: 'host' }) };
    const items = slots.menus?.session?.(buildAgentSession({ id: SID, openedBy: IAN }), env) ?? [];
    expect(items.map((item) => item.id)).toEqual(['conversation.rename', 'conversation.end']);
    expect(chunkFailures.getState()).toEqual([]);

    items[0]?.onSelect?.();
    await waitFor(() => expect(chunkFailures.getState()).toHaveLength(1));
    expect(chunkFailures.getState()[0]).toMatchObject({ name: 'ChunkLoadError', reason: 'gone' });
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('smurg was updated');
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();

    // The other item asks for the same chunk: still one banner.
    items[1]?.onSelect?.();
    await waitFor(() => expect(chunkFailures.getState().length).toBeGreaterThanOrEqual(1));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
