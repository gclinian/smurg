import { MAIN_ROOT, SmurgError, fileRefKey, type FileRef, type LockInfo, type Role } from '@smurg/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandMap } from '../../lib/commands.ts';
import { T0, makeAgentLock, makeSession, makeWelcome } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { EditorEngineContext } from './engine.ts';
import { EditorArea } from './index.tsx';
import { createFakeEngine } from './testing/fake-engine.ts';
import { bridgeDocs, testUser } from './testing/test-room.ts';

const FILE: FileRef = { root: MAIN_ROOT, path: 'src/app.ts' };
const TEXT = 'const greeting = "你好";\nconsole.log(greeting)\n';
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function renderEditor(options: { role?: Role; userId?: string } = {}) {
  const fake = createFakeEngine();
  const ctx = renderInWorkspace(
    <EditorEngineContext.Provider value={fake.loader}>
      <EditorArea />
    </EditorEngineContext.Provider>,
    { role: options.role ?? 'editor' },
  );
  const user = testUser(ctx.stores.workspace.getState().member?.displayName ?? 'Amy', ctx.stores.workspace.getState().member?.userId ?? 'dev:amy');
  const bridge = bridgeDocs(ctx.conn, user, undefined, { canWrite: options.role !== 'viewer' });
  // The connection ends when the test does: the doc-session registry disposes every replica (awareness timers).
  disposers.push(() => ctx.session.dispose());
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await flush();
        bridge.pump();
      });
    }
  };
  const open = async (payload: CommandMap['openFile'] = { file: FILE }): Promise<void> => {
    await act(async () => {
      await ctx.session.commands.dispatch('openFile', payload);
    });
    await settle();
  };
  return { ...ctx, fake, bridge, settle, open, editor: () => fake.editors.at(-1) };
}

function lockState(file: FileRef, lock: LockInfo | null) {
  return { file, lock };
}

describe('EditorArea: tabs, lazy editor, collaborative binding', () => {
  it('opens a file in a tab and binds the editor only after the first sync, with the daemon’s text', async () => {
    const view = renderEditor();
    view.bridge.addFile(FILE, TEXT);
    expect(screen.getByText('沒有開啟的檔案')).toBeTruthy();
    await view.open();
    expect(screen.getByRole('tab', { name: /app\.ts/ }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(view.fake.bindings).toHaveLength(1));
    const editor = view.editor();
    expect(editor?.model?.text).toBe(TEXT);
    expect(view.fake.bindings[0]?.ytext.toString()).toBe(TEXT);
    await waitFor(() => expect(editor?.readOnly).toBe(false));
    // Remote cursor styles live in a per-document <style>.
    expect(document.head.querySelector('style[data-smurg-presence]')).not.toBeNull();
  });

  it('agent 正在修改的檔案，所有人的編輯器暫時唯讀並顯示提示；完成後自動恢復可編輯 — the web banner and read-only editor', async () => {
    const view = renderEditor();
    view.bridge.addFile(FILE, TEXT);
    await view.open();
    const editor = view.editor();
    await waitFor(() => expect(editor?.readOnly).toBe(false));

    act(() => view.conn.emit('lock.state', lockState(FILE, makeAgentLock(FILE.path))));
    expect(screen.getByText('Claude（Ian）正在修改，暫時無法輸入')).toBeTruthy();
    expect(editor?.readOnly).toBe(true);
    expect(editor?.readOnlyMessage).toBe('Claude（Ian）正在修改，暫時無法輸入');
    expect(screen.getByRole('tab', { name: /app\.ts/ }).querySelector('[aria-label="Claude（Ian）正在修改"]')).not.toBeNull();

    // The agent finished (PostToolUse): editable again without anyone clicking anything.
    act(() => view.conn.emit('lock.state', lockState(FILE, null)));
    expect(screen.queryByText('Claude（Ian）正在修改，暫時無法輸入')).toBeNull();
    expect(editor?.readOnly).toBe(false);
    expect(editor?.readOnlyMessage).toBeNull();
  });

  it('agent 正在修改的檔案…完成後自動恢復可編輯 — also when the lock is announced under another spelling of the open file', async () => {
    const view = renderEditor();
    view.bridge.addFile(FILE, TEXT);
    view.conn.respond('lock.list', { locks: [] });
    await view.open();
    const editor = view.editor();
    await waitFor(() => expect(editor?.readOnly).toBe(false));
    // A case-insensitive host: the agent's hook locked 「SRC/App.ts」, the same file.
    const other: FileRef = { root: MAIN_ROOT, path: 'SRC/App.ts' };
    act(() => view.conn.emit('lock.state', lockState(other, { ...makeAgentLock(other.path), file: other })));
    expect(editor?.readOnly).toBe(true);
    expect(screen.getByText('Claude（Ian）正在修改，暫時無法輸入')).toBeTruthy();
    act(() => view.conn.emit('lock.state', lockState(other, null)));
    expect(editor?.readOnly).toBe(false);
    expect(screen.queryByText('Claude（Ian）正在修改，暫時無法輸入')).toBeNull();
  });

  it('while I hold the human edit lock it shows who shares it and 「讓 agent 先改」 sends lock.release', async () => {
    const view = renderEditor();
    view.bridge.addFile(FILE, TEXT);
    await view.open();
    view.conn.handle('lock.release', () => ({}));
    const shared: LockInfo = {
      kind: 'human',
      file: FILE,
      holders: [
        { userId: 'dev:amy', displayName: 'Amy', lastActivityAt: T0 },
        { userId: 'dev:bob', displayName: 'Bob', lastActivityAt: T0 },
      ],
      acquiredAt: T0,
    };
    act(() => view.conn.emit('lock.state', lockState(FILE, shared)));
    expect(screen.getByText(/你和Bob正在編輯這個檔案/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '讓 agent 先改' }));
    await waitFor(() => expect(view.conn.requestsOf('lock.release')).toHaveLength(1));
    expect(view.conn.requestsOf('lock.release')[0]?.payload).toEqual({ file: FILE });

    // Someone else's lock: named, no release button (lock.release is for holders only).
    act(() => view.conn.emit('lock.state', lockState(FILE, { ...shared, holders: [{ userId: 'dev:bob', displayName: 'Bob', lastActivityAt: T0 }] })));
    expect(screen.getByText(/Bob正在編輯這個檔案/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '讓 agent 先改' })).toBeNull();
  });

  it('a viewer is always read-only and gets no 「送到 agent」 or lock actions', async () => {
    const view = renderEditor({ role: 'viewer' });
    view.bridge.addFile(FILE, TEXT);
    await view.open();
    await waitFor(() => expect(view.fake.bindings).toHaveLength(1));
    const editor = view.editor();
    expect(editor?.readOnly).toBe(true);
    expect(editor?.readOnlyMessage).toBe('這個檔案對你是唯讀的');
    act(() => view.conn.emit('lock.state', lockState(FILE, makeAgentLock(FILE.path))));
    act(() => view.conn.emit('lock.state', lockState(FILE, null)));
    expect(editor?.readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: /送到 agent/ })).toBeNull();
    expect(editor?.actions.has('smurg.sendToAgent')).toBe(false);
  });

  it('doc.rejected drops the local change and explains why', async () => {
    const view = renderEditor();
    const room = view.bridge.addFile(FILE, TEXT);
    await view.open();
    await waitFor(() => expect(view.fake.bindings).toHaveLength(1));
    act(() => view.conn.emit('doc.rejected', { docId: room.id, reason: 'agent-locked', lock: makeAgentLock(FILE.path) }));
    expect(screen.getByText('Claude（Ian）正在修改這個檔案，你剛才輸入的內容沒有被接受。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(screen.queryByText('Claude（Ian）正在修改這個檔案，你剛才輸入的內容沒有被接受。')).toBeNull();

    // 'read-only': the replica is replaced, so the editor gets a new model bound to a fresh Y.Doc.
    act(() => view.conn.emit('doc.rejected', { docId: room.id, reason: 'read-only' }));
    expect(screen.getByText('這個檔案是唯讀的，你的修改已被捨棄。')).toBeTruthy();
    await view.settle();
    await waitFor(() => expect(view.fake.bindings).toHaveLength(2));
    expect(view.fake.bindings[0]?.destroyed).toBe(true);
    expect(view.fake.models[0]?.disposed).toBe(true);
    expect(view.fake.bindings[1]?.ytext.toString()).toBe(TEXT);
  });

  it('refuses binary / oversized / non-UTF-8 files with the reason and a download offer', async () => {
    const view = renderEditor();
    const downloads: CommandMap['download'][] = [];
    view.session.commands.handle('download', (payload) => {
      downloads.push(payload);
    });
    const cases: [SmurgError, string][] = [
      [new SmurgError('bad_request', '這是二進位檔案，無法在編輯器中開啟', { reason: 'binary' }), '這是二進位檔案，無法在編輯器中開啟。'],
      [new SmurgError('too_large', '檔案超過 5 MiB，無法在編輯器中開啟', { reason: 'too-large' }), '這個檔案超過 5 MB，無法在編輯器中開啟。'],
      [new SmurgError('bad_request', '檔案不是有效的 UTF-8 文字', { reason: 'invalid-utf8' }), '這個檔案不是 UTF-8 文字，無法在編輯器中開啟。'],
    ];
    for (const [index, [error, message]] of cases.entries()) {
      const file = { root: MAIN_ROOT, path: `data/file-${index}.bin` };
      view.conn.handle('doc.open', () => {
        throw error;
      });
      await view.open({ file });
      const panel = screen.getByRole('tabpanel');
      expect(within(panel).getByText(message)).toBeTruthy();
      fireEvent.click(within(panel).getByRole('button', { name: '下載檔案' }));
      await waitFor(() => expect(downloads).toHaveLength(index + 1));
      expect(downloads[index]).toEqual({ file });
    }
    expect(view.fake.editors).toHaveLength(0);
  });

  it('shows the mixed line-ending notice once and the file’s line ending', async () => {
    const view = renderEditor();
    view.bridge.addFile(FILE, TEXT, { meta: { eol: 'CRLF', bom: true, mixedEol: true } });
    await view.open();
    expect(screen.getByText('這個檔案混用了不同的換行符號，第一次自動儲存時會統一成 CRLF（Windows）。')).toBeTruthy();
    expect(screen.getByText('換行：CRLF（Windows）')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(screen.queryByText(/混用了不同的換行符號/)).toBeNull();
  });

  it('autosave indicator follows doc.saved (there is no save button)', async () => {
    const view = renderEditor();
    const room = view.bridge.addFile(FILE, TEXT);
    await view.open();
    await waitFor(() => expect(view.fake.bindings).toHaveLength(1));
    act(() => view.fake.bindings[0]?.ytext.insert(0, '// 新的一行\n'));
    expect(screen.getByText('儲存中…')).toBeTruthy();
    await view.settle();
    act(() => view.conn.emit('doc.saved', { docId: room.id, file: FILE, hash: 'b'.repeat(64), at: T0 }));
    expect(screen.getByText(/^已自動儲存（/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /儲存/ })).toBeNull();
  });

  it('「送到 agent」: the selection (with its path and line range) goes through the command bus to a session', async () => {
    const view = renderEditor({ role: 'editor' });
    view.bridge.addFile(FILE, TEXT);
    const sent: CommandMap['sendSelectionAsSuggestion'][] = [];
    view.session.commands.handle('sendSelectionAsSuggestion', (payload) => {
      sent.push(payload);
    });
    act(() => {
      view.conn.emit('session.state', { session: makeSession({ id: 'sess_ian', ownerUserId: 'dev:host', ownerName: 'Ian', title: 'Claude' }) });
      view.conn.emit('session.state', { session: makeSession({ id: 'sess_term', kind: 'terminal', ownerUserId: 'dev:host', ownerName: 'Ian', title: 'zsh' }) });
    });
    await view.open();
    await waitFor(() => expect(view.fake.bindings).toHaveLength(1));
    const editor = view.editor();
    act(() => editor?.select({ startLine: 2, startColumn: 1, endLine: 2, endColumn: 22 }, 'console.log(greeting)'));
    fireEvent.click(screen.getByRole('button', { name: '送到 agent' }));
    const menu = screen.getByRole('menu');
    // Terminals are never offered (pasted code would run as shell commands).
    expect(within(menu).queryByText(/zsh/)).toBeNull();
    // One click sends it as a suggestion (SPEC R6 「一鍵」, review SPEC-08); the draft is the second choice.
    expect(within(menu).getByRole('menuitem', { name: '先寫進給 Ian 開的「Claude」的建議草稿' })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: '作為建議送給 Ian 開的「Claude」' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    // The file and line range with the selected code; the suggest feature quotes it under the path.
    expect(sent[0]).toEqual({ file: FILE, startLine: 2, endLine: 2, sessionId: 'sess_ian', text: 'console.log(greeting)', mode: 'send' });
    // The editor's context menu offers the same action.
    expect(editor?.actions.get('smurg.sendToAgent')?.needsSelection).toBe(true);
  });

  it('openFile with a line reveals it once the document is bound', async () => {
    const view = renderEditor();
    view.bridge.addFile(FILE, TEXT);
    await view.open({ file: FILE, line: 2, column: 5 });
    await waitFor(() => expect(view.editor()?.revealed).toEqual([{ line: 2, column: 5 }]));
  });

  it('closing a tab closes the document (doc.close) and disposes its editor', async () => {
    const view = renderEditor();
    view.bridge.addFile(FILE, TEXT);
    await view.open();
    await waitFor(() => expect(view.fake.bindings).toHaveLength(1));
    const tab = screen.getByRole('tab', { name: /app\.ts/ });
    fireEvent.keyDown(tab, { key: 'Delete' });
    expect(view.conn.notificationsOf('doc.close')).toHaveLength(1);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(view.editor()?.disposed).toBe(true);
    expect(view.fake.bindings[0]?.destroyed).toBe(true);
  });

  it('the host can force-release a lock from the banner, after a confirmation that names the holder; others cannot (WEB-04)', async () => {
    const guest = renderEditor({ role: 'editor' });
    guest.bridge.addFile(FILE, TEXT);
    await guest.open();
    act(() => guest.conn.emit('lock.state', lockState(FILE, makeAgentLock(FILE.path))));
    expect(screen.getByText('Claude（Ian）正在修改，暫時無法輸入')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '強制釋放' })).toBeNull();
    guest.unmount();

    const host = renderEditor({ role: 'host' });
    host.bridge.addFile(FILE, TEXT);
    await host.open();
    act(() => host.conn.emit('lock.state', lockState(FILE, makeAgentLock(FILE.path))));
    host.conn.handle('lock.forceRelease', () => ({}));
    fireEvent.click(screen.getByRole('button', { name: '強制釋放' }));
    const dialog = screen.getByRole('alertdialog', { name: '要強制釋放「app.ts」的鎖嗎？' });
    expect(dialog.textContent).toContain('Claude（Ian）正在修改這個檔案');
    expect(host.conn.requestsOf('lock.forceRelease')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: '強制釋放' }));
    await waitFor(() => expect(host.conn.requestsOf('lock.forceRelease').map((r) => r.payload)).toEqual([{ file: FILE }]));
  });

  it('a file deleted while open: read-only with the reason, no 「等待主人電腦回應」, and it can be re-created from the tab (WEB-01)', async () => {
    const view = renderEditor();
    view.bridge.addFile(FILE, TEXT);
    await view.open();
    const editor = view.editor();
    await waitFor(() => expect(editor?.readOnly).toBe(false));
    act(() => view.fake.bindings[0]?.ytext.insert(0, '- [ ] 寫報告\n'));
    act(() =>
      view.conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: FILE.path, change: 'unlink', by: { kind: 'user', userId: 'dev:mei', displayName: '陳美玲' } }] }),
    );
    expect(screen.getByText('這個檔案已被陳美玲刪除')).toBeTruthy();
    expect(editor?.readOnly).toBe(true);
    expect(editor?.readOnlyMessage).toBe('這個檔案已經不在原來的位置，無法再輸入');
    expect(screen.getByRole('tab', { name: /app\.ts/ }).querySelector('[aria-label="已刪除或移走"]')).not.toBeNull();
    // The daemon refuses edits of a vanished file as 'read-only': the removed notice explains it, not 「這個檔案是唯讀的」.
    act(() => view.conn.emit('doc.rejected', { docId: view.bridge.rooms.get(fileRefKey(FILE))?.id ?? 'doc_x', reason: 'read-only' }));
    expect(screen.queryByText('這個檔案是唯讀的，你的修改已被捨棄。')).toBeNull();
    expect(screen.queryByText(/正在等待主人電腦回應/)).toBeNull();
    // The rejection dropped the replica: nothing is written before the fresh one has the daemon's text again.
    expect((screen.getByRole('button', { name: '用這些內容重新建立' }) as HTMLButtonElement).disabled).toBe(true);
    await view.settle();

    const created: unknown[] = [];
    const written: { path: string; content: string }[] = [];
    view.conn.handle('file.create', ({ file, kind }) => {
      created.push({ file, kind });
      return { entry: { name: 'app.ts', path: file.path, kind: 'file', size: 0, mtime: T0 } };
    });
    view.conn.handle('file.write', ({ file, content }) => {
      written.push({ path: file.path, content: new TextDecoder().decode(content) });
      return { entry: { name: 'app.ts', path: file.path, kind: 'file', size: content.byteLength, mtime: T0 }, hash: 'a'.repeat(64) };
    });
    fireEvent.click(screen.getByRole('button', { name: '用這些內容重新建立' }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(created).toEqual([{ file: FILE, kind: 'file' }]);
    expect(written[0]).toEqual({ path: FILE.path, content: `- [ ] 寫報告\n${TEXT}` });
  });

  it('a file renamed by someone else while open: the tab offers the new place (WEB-01)', async () => {
    const view = renderEditor();
    view.bridge.addFile(FILE, TEXT);
    const moved: FileRef = { root: MAIN_ROOT, path: 'src/main.ts' };
    view.bridge.addFile(moved, TEXT);
    await view.open();
    const mei = { kind: 'user', userId: 'dev:mei', displayName: '陳美玲' } as const;
    act(() => view.conn.emit('activity.event', { event: { id: 'act_9', at: T0, actor: mei, kind: 'file.rename', file: moved, summary: `重新命名 ${FILE.path} → ${moved.path}` } }));
    act(() => view.conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: FILE.path, change: 'unlink' }] }));
    expect(screen.getByText('這個檔案已被陳美玲移到「src/main.ts」')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '開啟新位置' }));
    await view.settle();
    expect(screen.getByRole('tab', { name: /main\.ts/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: /app\.ts/ })).toBeNull();
  });

  it('text typed while the host was down that cannot be merged is offered back, not discarded (REL-07)', async () => {
    const view = renderEditor();
    const room = view.bridge.addFile(FILE, TEXT);
    await view.open();
    await waitFor(() => expect(view.fake.bindings).toHaveLength(1));
    // Typed while the host was unreachable: never delivered. The daemon comes back with a new epoch and other text.
    act(() => view.fake.bindings[0]?.ytext.insert(0, '// 我離線時寫的\n'));
    view.bridge.dropChannel();
    room.reset(`// 主人改過\n${TEXT}`);
    act(() => view.conn.admit(makeWelcome({ role: 'editor', channelId: 'ch_2' }), { resumed: false }));
    await view.settle();
    expect(await screen.findByText('你有修改還沒存到主人電腦')).toBeTruthy();
    expect(screen.getByText(/查看我的版本/).closest('details')?.textContent).toContain('// 我離線時寫的');
    expect(room.text).toBe(`// 主人改過\n${TEXT}`);
    fireEvent.click(screen.getByRole('button', { name: '用我的版本取代' }));
    await view.settle();
    expect(room.text).toBe(`// 我離線時寫的\n${TEXT}`);
    expect(screen.queryByText('你有修改還沒存到主人電腦')).toBeNull();
  });
});
