// The transfers panel in Traditional Chinese: the empty state, a finished upload with its counted texts, and the
// host's disk refusal (described from the numbers of the report, in the language of the viewer).
import { MAIN_ROOT, type DiskReport } from '@smurg/protocol';
import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTestLocale } from '../../testing/locale.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import { transferClientFor } from './client/transfer-client.ts';
import { createMemoryJournal } from './engine/journal.ts';
import { syntheticBytes } from './engine/synthetic-source.ts';
import { TransfersPanel } from './index.tsx';
import { InProcessWorker } from './testing/in-process-worker.ts';

useTestLocale('zh-TW');

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function setup() {
  const context = createTestWorkspace({ role: 'editor' });
  const worker = new InProcessWorker({ journal: createMemoryJournal() });
  worker.daemon.put(MAIN_ROOT, 'in', 'dir');
  transferClientFor(context.session, { createWorker: () => worker, save: () => {}, createObjectURL: () => 'blob:test/1', revokeObjectURL: () => {} });
  render(
    <WorkspaceTestProviders context={context}>
      <TransfersPanel />
    </WorkspaceTestProviders>,
  );
  const settle = async (predicate: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 8_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await act(flush);
    }
  };
  return { ...context, worker, settle };
}

const items = (): HTMLElement[] => screen.queryAllByTestId('transfer-item');

describe('the transfers panel in zh-TW', () => {
  it('shows the empty state and a finished upload in Traditional Chinese', async () => {
    const s = setup();
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(screen.getByRole('region', { name: '上傳與下載' })).toBeTruthy();
    expect(screen.getByText('目前沒有傳輸')).toBeTruthy();

    await act(() => s.session.commands.dispatch('startUpload', { root: MAIN_ROOT, targetDir: 'in', source: { kind: 'files', files: [new File([syntheticBytes(4, 0, 5000)], 'a.bin')] } }));
    await s.settle(() => items()[0]?.dataset['status'] === 'done', 'the upload');
    const row = items()[0] as HTMLElement;
    expect(row.textContent).toContain('上傳：a.bin');
    expect(within(row).getByText('完成')).toBeTruthy();
    expect(within(row).getByText('上傳到 in')).toBeTruthy();
    expect(within(row).getByRole('progressbar', { name: 'a.bin 的進度' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: '移除：a.bin' })).toBeTruthy();
    expect(screen.getByText('0 個傳輸進行中')).toBeTruthy();
    expect(screen.getByRole('button', { name: '清除已完成' })).toBeTruthy();
  });

  it('describes the disk refusal of the host in Traditional Chinese', async () => {
    const s = setup();
    const refuse = (requestedBytes: number): DiskReport => ({
      totalBytes: 460 * 1024 ** 3,
      availableBytes: 20 * 1024 ** 3,
      reserveBytes: 23 * 1024 ** 3,
      pendingBytes: 0,
      requestedBytes,
      freeAfterBytes: 20 * 1024 ** 3 - requestedBytes,
      ok: false,
    });
    s.worker.daemon.disk = refuse;
    await act(() => s.session.commands.dispatch('startUpload', { root: MAIN_ROOT, targetDir: 'in', source: { kind: 'files', files: [new File([syntheticBytes(4, 0, 5000)], 'big.bin')] } }));
    await s.settle(() => items()[0]?.dataset['status'] === 'failed', 'the refusal');
    const alert = within(items()[0] as HTMLElement).getByRole('alert');
    expect(alert.textContent).toContain('主人的磁碟空間不足，上傳尚未開始');
    expect(alert.textContent).toContain('低於保留空間 23 GB（目前可用 20 GB');
    expect(within(items()[0] as HTMLElement).getByRole('button', { name: '重試：big.bin' })).toBeTruthy();
  });
});
