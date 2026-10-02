// The editor area in Traditional Chinese: the empty state, the tab and document chrome, the agent lock banner, and a
// refused doc.open explained from the reason code (the catalog of the web app, not the host's sentence).
import { MAIN_ROOT, SmurgError, type FileRef } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAgentLock } from '../../testing/fixtures.ts';
import { useTestLocale } from '../../testing/locale.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { EditorEngineContext } from './engine.ts';
import { EditorArea } from './index.tsx';
import { createFakeEngine } from './testing/fake-engine.ts';
import { bridgeDocs, testUser } from './testing/test-room.ts';

useTestLocale('zh-TW');

const FILE: FileRef = { root: MAIN_ROOT, path: 'src/app.ts' };
const TEXT = 'const greeting = "你好";\n';
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function renderEditor() {
  const fake = createFakeEngine();
  const ctx = renderInWorkspace(
    <EditorEngineContext.Provider value={fake.loader}>
      <EditorArea />
    </EditorEngineContext.Provider>,
    { role: 'editor' },
  );
  const bridge = bridgeDocs(ctx.conn, testUser('Amy', 'dev:amy'), undefined, { canWrite: true });
  disposers.push(() => ctx.session.dispose());
  const open = async (file: FileRef): Promise<void> => {
    await act(async () => {
      await ctx.session.commands.dispatch('openFile', { file });
    });
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await flush();
        bridge.pump();
      });
    }
  };
  return { ...ctx, fake, bridge, open };
}

describe('the editor area in zh-TW', () => {
  it('shows the empty state, the document chrome and the agent lock banner in Traditional Chinese', async () => {
    const view = renderEditor();
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(screen.getByRole('region', { name: '編輯器' })).toBeTruthy();
    expect(screen.getByText('沒有開啟的檔案')).toBeTruthy();

    view.bridge.addFile(FILE, TEXT);
    await view.open(FILE);
    expect(screen.getByRole('tablist', { name: '已開啟的檔案' })).toBeTruthy();
    const editor = view.fake.editors.at(-1);
    await waitFor(() => expect(editor?.readOnly).toBe(false));
    expect(screen.getByRole('button', { name: /送到 agent/ })).toBeTruthy();

    act(() => view.conn.emit('lock.state', { file: FILE, lock: makeAgentLock(FILE.path) }));
    expect(screen.getByText('Claude (Ian) 正在修改，暫時無法輸入')).toBeTruthy();
    expect(editor?.readOnlyMessage).toBe('Claude (Ian) 正在修改，暫時無法輸入');
    expect(screen.getByRole('tab', { name: /app\.ts/ }).querySelector('[aria-label="Claude (Ian) 正在修改"]')).not.toBeNull();
  });

  it('explains a refused doc.open in Traditional Chinese and offers the download', async () => {
    const view = renderEditor();
    view.conn.handle('doc.open', () => {
      throw new SmurgError('bad_request', msg('doc.binary'), { reason: 'binary' });
    });
    await view.open({ root: MAIN_ROOT, path: 'data/model.bin' });
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('這是二進位檔案，無法在編輯器中開啟。')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: '下載檔案' })).toBeTruthy();
  });
});
