import { act, render, screen } from '@testing-library/react';
import { MAIN_ROOT } from '@smurg/protocol';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTestProviders, createTestWorkspace } from '../testing/services.tsx';
import { NoCommandHandlerError, createCommandBus, type CommandMap } from './commands.ts';
import { useCommand, useCommandHandler, useCommandObserver } from './workspace/context.tsx';

const file = { root: MAIN_ROOT, path: 'src/app.ts' };

describe('command bus', () => {
  it('runs the one registered handler with the typed payload', async () => {
    const bus = createCommandBus();
    const handler = vi.fn();
    bus.handle('openFile', handler);
    await bus.dispatch('openFile', { file, line: 12 });
    expect(handler).toHaveBeenCalledWith({ file, line: 12 });
    expect(bus.has('openFile')).toBe(true);
  });

  it('rejects a command nobody handles', async () => {
    const bus = createCommandBus();
    await expect(bus.dispatch('newTopic', {})).rejects.toBeInstanceOf(NoCommandHandlerError);
  });

  it('a newer handler replaces the older one; the older dispose does not remove the newer', async () => {
    const bus = createCommandBus();
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = bus.handle('download', first);
    bus.handle('download', second);
    disposeFirst();
    await bus.dispatch('download', { file, zip: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('observers see the command before the handler and never break it', async () => {
    const onObserverError = vi.fn();
    const bus = createCommandBus({ onObserverError });
    const order: string[] = [];
    bus.observe('showPanel', () => order.push('observer'));
    bus.observe('showPanel', () => {
      throw new Error('boom');
    });
    bus.handle('showPanel', () => {
      order.push('handler');
    });
    await bus.dispatch('showPanel', { panel: 'conflicts' });
    expect(order).toEqual(['observer', 'handler']);
    expect(onObserverError).toHaveBeenCalledOnce();
  });

  it('propagates the handler failure to the dispatcher', async () => {
    const bus = createCommandBus();
    bus.handle('startUpload', () => Promise.reject(new Error('disk full')));
    await expect(bus.dispatch('startUpload', { root: MAIN_ROOT, targetDir: '', source: { kind: 'files', files: [] } })).rejects.toThrow('disk full');
  });

  it('whenHandled resolves once a command has a handler: at once when it has one, else when one registers', async () => {
    const bus = createCommandBus();
    let resolved = false;
    const waiting = bus.whenHandled('openFile').then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    // Another command's handler does not wake it.
    bus.handle('download', () => {});
    await Promise.resolve();
    expect(resolved).toBe(false);
    const seen: CommandMap['openFile'][] = [];
    bus.handle('openFile', (payload) => void seen.push(payload));
    await waiting;
    expect(resolved).toBe(true);
    // The pattern of openInCodeMode: wait for the editor, then ask it.
    await bus.whenHandled('openFile');
    await bus.dispatch('openFile', { file, line: 3 });
    expect(seen).toEqual([{ file, line: 3 }]);
  });

  it('the commands of the shell are typed: a column target, a mode, a place in code mode', async () => {
    const bus = createCommandBus();
    const seen: unknown[] = [];
    bus.handle('openColumn', (payload) => void seen.push(payload));
    bus.handle('setMode', (payload) => void seen.push(payload));
    bus.handle('openInCodeMode', (payload) => void seen.push(payload));
    bus.handle('newSession', (payload) => void seen.push(payload));
    await bus.dispatch('openColumn', { target: { kind: 'report', topicId: 't1', itemId: 'cart-api' }, side: true, anchor: { cardId: 'q_1' } });
    await bus.dispatch('setMode', { mode: 'code' });
    await bus.dispatch('openInCodeMode', { root: MAIN_ROOT, file: 'src/app.ts', line: 12, sessionId: 's1' });
    await bus.dispatch('newSession', { kind: 'terminal' });
    expect(seen).toHaveLength(4);
  });

  it('hooks: a feature registers a handler, another dispatches, unmount unregisters', async () => {
    const context = createTestWorkspace();
    const seen: CommandMap['openFile'][] = [];
    const observed = vi.fn();
    function Editor() {
      useCommandHandler('openFile', (payload) => {
        seen.push(payload);
      });
      return null;
    }
    function Tree() {
      const openFile = useCommand('openFile');
      useCommandObserver('openFile', observed);
      return (
        <button type="button" onClick={() => void openFile({ file })}>
          open
        </button>
      );
    }
    function Harness() {
      const [editor, setEditor] = useState(true);
      return (
        <>
          {editor ? <Editor /> : null}
          <Tree />
          <button type="button" onClick={() => setEditor(false)}>
            unmount
          </button>
        </>
      );
    }
    render(
      <WorkspaceTestProviders context={context}>
        <Harness />
      </WorkspaceTestProviders>,
    );
    await act(async () => screen.getByText('open').click());
    expect(seen).toEqual([{ file }]);
    expect(observed).toHaveBeenCalledOnce();
    act(() => screen.getByText('unmount').click());
    expect(context.session.commands.has('openFile')).toBe(false);
  });
});
