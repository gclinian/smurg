// A document on its own inside a column (standalone.tsx) and the holds that keep it open (doc-holds.ts): what the
// spec and plan columns of the sessions view mount (DESIGN §5.4).
import { DOC_TEXT_NAME, MAIN_ROOT, fileRefKey, type FileRef } from '@smurg/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChunkLoadError } from '../../lib/chunks.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { docHoldsFor, selectEditorDocs } from './doc-holds.ts';
import { EditorEngineContext } from './engine.ts';
import { EditorArea } from './index.tsx';
import { DOCUMENT_TEXT_INTERVAL_MS, StandaloneDocument, useDocumentText, useHeldDocument } from './standalone.tsx';
import { createFakeEngine } from './testing/fake-engine.ts';
import { bridgeDocs, testUser } from './testing/test-room.ts';

const SPEC: FileRef = { root: MAIN_ROOT, path: 'specs/checkout/SPEC.md' };
const TEXT = '# Checkout\n\nOne page.\n';
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/** A column that shows the document's text and, on request, its editor; beside it the editor area of code mode. */
function Column({ file, startEditing = false }: { file: FileRef | null; startEditing?: boolean }) {
  const held = useHeldDocument(file);
  const text = useDocumentText(held?.session);
  const [editing, setEditing] = useState(startEditing);
  return (
    <div>
      <output data-testid="text">{text ?? '(none)'}</output>
      <button type="button" onClick={() => setEditing((on) => !on)}>
        toggle editing
      </button>
      {held !== null && editing ? <StandaloneDocument held={held} active /> : null}
    </div>
  );
}

function setup(options: { column?: boolean; startEditing?: boolean; role?: 'editor' | 'viewer' } = {}) {
  const fake = createFakeEngine();
  function Page() {
    const [shown, setShown] = useState(options.column !== false);
    return (
      <EditorEngineContext.Provider value={fake.loader}>
        <button type="button" onClick={() => setShown((on) => !on)}>
          toggle column
        </button>
        {shown ? <Column file={SPEC} startEditing={options.startEditing === true} /> : null}
        <EditorArea />
      </EditorEngineContext.Provider>
    );
  }
  const ctx = renderInWorkspace(<Page />, { role: options.role ?? 'editor' });
  const bridge = bridgeDocs(ctx.conn, testUser('Amy', 'dev:amy'), undefined, { canWrite: options.role !== 'viewer' });
  bridge.addFile(SPEC, TEXT);
  disposers.push(() => ctx.session.dispose());
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await flush();
        bridge.pump();
      });
    }
  };
  return { ...ctx, fake, bridge, settle, holds: docHoldsFor(ctx.stores.docs) };
}

describe('a document held by a column', () => {
  it('is opened without becoming a tab of the editor, and closed again when the column goes', async () => {
    // The page renders with the workspace admitted: the hold's doc.open is answered by the bridge.
    const view = setup({ column: false });
    await view.settle();
    fireEvent.click(screen.getByRole('button', { name: 'toggle column' }));
    await view.settle();
    expect(view.conn.requestsOf('doc.open').map((request) => request.payload.file)).toEqual([SPEC]);
    expect(view.stores.docs.getState().docs.has(fileRefKey(SPEC))).toBe(true);
    expect(view.stores.docs.getState().activeKey).toBeNull();
    expect(view.holds.isColumnOnly(fileRefKey(SPEC))).toBe(true);
    expect(selectEditorDocs(view.stores.docs.getState(), view.holds.getState())).toEqual([]);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByText('No open files')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'toggle column' }));
    expect(view.stores.docs.getState().docs.has(fileRefKey(SPEC))).toBe(false);
    expect(view.conn.notificationsOf('doc.close')).toHaveLength(1);
  });

  it('gives the rendered view the live text: nothing before the first sync, then every change, not more often than the interval', async () => {
    const view = setup({ column: false });
    await view.settle();
    fireEvent.click(screen.getByRole('button', { name: 'toggle column' }));
    expect(screen.getByTestId('text').textContent).toBe('(none)');
    await view.settle();
    expect(screen.getByTestId('text').textContent).toBe(TEXT);
    const room = view.bridge.rooms.get(fileRefKey(SPEC));
    // Someone else (the room is the host's side) appends a line.
    act(() => {
      const text = room?.doc.getText(DOC_TEXT_NAME);
      text?.insert(text.length, 'Cards only.\n');
    });
    await view.settle();
    await waitFor(() => expect(screen.getByTestId('text').textContent).toBe(`${TEXT}Cards only.\n`), { timeout: DOCUMENT_TEXT_INTERVAL_MS * 10 });
  });

  it('opening the same file in the editor adopts it: one document, a tab, and the column leaving does not close it', async () => {
    const view = setup({ column: false });
    await view.settle();
    fireEvent.click(screen.getByRole('button', { name: 'toggle column' }));
    await view.settle();
    await act(async () => {
      await view.session.commands.dispatch('openFile', { file: SPEC });
    });
    await view.settle();
    expect(view.conn.requestsOf('doc.open')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /SPEC\.md/ })).toBeTruthy();
    expect(view.holds.isColumnOnly(fileRefKey(SPEC))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'toggle column' }));
    expect(view.stores.docs.getState().docs.has(fileRefKey(SPEC))).toBe(true);
    expect(view.conn.notificationsOf('doc.close')).toHaveLength(0);
  });

  it('a file that was a tab before the column came stays a tab and is never closed by the column', async () => {
    const view = setup({ column: false });
    await view.settle();
    await act(async () => {
      await view.session.commands.dispatch('openFile', { file: SPEC });
    });
    await view.settle();
    fireEvent.click(screen.getByRole('button', { name: 'toggle column' }));
    await view.settle();
    expect(view.conn.requestsOf('doc.open')).toHaveLength(1);
    expect(view.holds.isColumnOnly(fileRefKey(SPEC))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'toggle column' }));
    expect(view.stores.docs.getState().docs.has(fileRefKey(SPEC))).toBe(true);
  });

  it('two holds of one file are one document; the last release closes it', async () => {
    const view = setup({ column: false });
    await view.settle();
    let first = (): void => {};
    let second = (): void => {};
    act(() => {
      first = view.holds.hold(SPEC);
      second = view.holds.hold(SPEC);
    });
    await view.settle();
    expect(view.conn.requestsOf('doc.open')).toHaveLength(1);
    act(() => first());
    expect(view.stores.docs.getState().docs.has(fileRefKey(SPEC))).toBe(true);
    act(() => {
      second();
      second();
    });
    expect(view.stores.docs.getState().docs.has(fileRefKey(SPEC))).toBe(false);
  });
});

describe('the editor of a held document, on its own', () => {
  it('is a labelled group without a tab or a close button, bound to the same text people type in', async () => {
    const view = setup({ column: false, startEditing: true });
    await view.settle();
    fireEvent.click(screen.getByRole('button', { name: 'toggle column' }));
    await view.settle();
    await waitFor(() => expect(view.fake.bindings).toHaveLength(1));
    expect(screen.getByRole('group', { name: 'Editor for specs/checkout/SPEC.md' })).toBeTruthy();
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(view.fake.bindings[0]?.ytext.toString()).toBe(TEXT);
    await waitFor(() => expect(view.fake.editors.at(-1)?.readOnly).toBe(false));
    // A spec is prose in a narrow column: its long lines wrap.
    expect(view.fake.editors.at(-1)?.wrap).toBe(true);
    // Typing in the column's editor is what the rendered view shows.
    act(() => view.fake.bindings[0]?.ytext.insert(0, '> draft\n\n'));
    await waitFor(() => expect(screen.getByTestId('text').textContent).toBe(`> draft\n\n${TEXT}`), { timeout: DOCUMENT_TEXT_INTERVAL_MS * 10 });
  });

  it('a viewer’s editor is read-only', async () => {
    const view = setup({ column: false, startEditing: true, role: 'viewer' });
    await view.settle();
    fireEvent.click(screen.getByRole('button', { name: 'toggle column' }));
    await view.settle();
    await waitFor(() => expect(view.fake.bindings).toHaveLength(1));
    expect(view.fake.editors.at(-1)?.readOnly).toBe(true);
  });

  it('a file deleted under the column: it says so, offers to create it again here, and has no tab to close', async () => {
    const view = setup({ column: false, startEditing: true });
    await view.settle();
    fireEvent.click(screen.getByRole('button', { name: 'toggle column' }));
    await view.settle();
    await waitFor(() => expect(view.fake.bindings).toHaveLength(1));
    act(() => view.conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: SPEC.path, change: 'unlink', by: { kind: 'user', userId: 'dev:mei', displayName: 'Mei' } }] }));
    expect(screen.getByText('This file was deleted by Mei')).toBeTruthy();
    expect(screen.getByText('What is shown here can no longer be saved. You can create the file again from this content.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create again from this content' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close tab' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});

// The editor's code is a chunk of its own (Monaco, y-monaco). When it does not come, the document says why with the
// words every part of the page uses for that (lib/chunks.ts, ui/ChunkNotice.tsx), and offers the reload.
describe('the editor whose chunk does not come', () => {
  function Page({ loader }: { loader: () => Promise<never> }) {
    return (
      <EditorEngineContext.Provider value={loader}>
        <Column file={SPEC} startEditing />
      </EditorEngineContext.Provider>
    );
  }
  async function open(error: unknown) {
    const ctx = renderInWorkspace(<Page loader={() => Promise.reject(error)} />, { role: 'editor' });
    const bridge = bridgeDocs(ctx.conn, testUser('Amy', 'dev:amy'));
    bridge.addFile(SPEC, TEXT);
    disposers.push(() => ctx.session.dispose());
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await flush();
        bridge.pump();
      });
    }
  }

  it('the web app was deployed again: "smurg was updated", the reload, and no Retry that cannot work', async () => {
    await open(new ChunkLoadError('gone', new TypeError('Failed to fetch dynamically imported module')));
    const notice = await within(screen.getByLabelText('Editor for specs/checkout/SPEC.md')).findByRole('alert');
    expect(notice.textContent).toContain('smurg was updated');
    expect(notice.textContent).toContain('Reload to get the new page; if the host has not updated yet, the page will say so.');
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('the network is gone: says offline, not updated', async () => {
    await open(new ChunkLoadError('offline', null));
    const notice = await within(screen.getByLabelText('Editor for specs/checkout/SPEC.md')).findByRole('alert');
    expect(notice.textContent).toContain('The browser is offline or cannot reach the smurg server.');
    expect(notice.textContent).not.toMatch(/updated/);
  });

  it('any other failure of the editor keeps its own words and its Retry', async () => {
    await open(new Error('the engine broke'));
    const notice = await within(screen.getByLabelText('Editor for specs/checkout/SPEC.md')).findByRole('alert');
    expect(notice.textContent).toContain('The editor failed to load. Check your network and try again.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
