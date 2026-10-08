// The transfers panel and the startUpload / download commands, with the real TransferManager running behind an
// in-process stand-in for the Worker (same message protocol) and a fake daemon.
import { MAIN_ROOT, type DiskReport } from '@smurg/protocol';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, setChunkProbe } from '../../lib/chunks.ts';
import { createTestWorkspace, WorkspaceTestProviders } from '../../testing/services.tsx';
import { render } from '@testing-library/react';
import { transferClientFor, type WorkerLike } from './client/transfer-client.ts';
import { createMemoryJournal } from './engine/journal.ts';
import { syntheticBytes } from './engine/synthetic-source.ts';
import { TransfersPanel } from './index.tsx';
import { InProcessWorker, type InProcessWorkerOptions } from './testing/in-process-worker.ts';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function fileOf(name: string, bytes: Uint8Array<ArrayBuffer>, relative?: string): File {
  const file = new File([bytes], name, { lastModified: 1_780_000_000_000 });
  if (relative) Object.defineProperty(file, 'webkitRelativePath', { value: relative });
  return file;
}

function setup(options: InProcessWorkerOptions & { role?: 'editor' | 'viewer' } = {}) {
  const context = createTestWorkspace({ role: options.role ?? 'editor' });
  const worker = new InProcessWorker(options);
  worker.daemon.put(MAIN_ROOT, 'in', 'dir');
  const saved: { url: string; name: string }[] = [];
  const blobs = new Map<string, Blob>();
  let n = 0;
  const client = transferClientFor(context.session, {
    createWorker: () => worker,
    save: (url, name) => saved.push({ url, name }),
    createObjectURL: (blob) => {
      const url = `blob:test/${++n}`;
      blobs.set(url, blob);
      return url;
    },
    revokeObjectURL: (url) => blobs.delete(url),
  });
  const view = render(
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
  return { ...context, ...view, worker, client, saved, blobs, settle };
}

const items = (): HTMLElement[] => screen.queryAllByTestId('transfer-item');

/** A Worker whose script never ran: it takes messages and answers none, and the browser fires `error` at it. */
class DeadWorker implements WorkerLike {
  readonly received: unknown[] = [];
  private readonly errorListeners = new Set<(event: Event) => void>();
  addEventListener(type: 'message' | 'error', listener: ((event: MessageEvent) => void) | ((event: Event) => void)): void {
    if (type === 'error') this.errorListeners.add(listener as (event: Event) => void);
  }
  postMessage(message: unknown): void {
    this.received.push(message);
  }
  terminate(): void {}
  fail(event: Event = new Event('error')): void {
    for (const listener of [...this.errorListeners]) listener(event);
  }
}

function setupDead() {
  const context = createTestWorkspace({ role: 'editor' });
  const worker = new DeadWorker();
  transferClientFor(context.session, { createWorker: () => worker });
  render(
    <WorkspaceTestProviders context={context}>
      <TransfersPanel />
    </WorkspaceTestProviders>,
  );
  return { ...context, worker, panel: screen.getByRole('region', { name: 'Uploads and downloads' }) };
}

/**
 * Exact byte equality of large buffers. `toEqual` compares a Uint8Array element by element through vitest's generic
 * equality: ~4 s for 3 MiB on an idle machine, and five times that in the full gate (it made this file time out). This
 * checks the same thing (same length, every byte) in milliseconds and names the first differing offset.
 */
function expectSameBytes(actual: Uint8Array | 'dir' | undefined, expected: Uint8Array): void {
  expect(actual, 'no bytes').toBeInstanceOf(Uint8Array);
  const a = actual as Uint8Array;
  expect(a.byteLength).toBe(expected.byteLength);
  if (Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)) === 0) return;
  let at = 0;
  while (a[at] === expected[at]) at++;
  expect.fail(`bytes differ first at offset ${at}: ${a[at]} instead of ${expected[at]}`);
}

afterEach(() => {
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

describe('TransfersPanel', () => {
  it('shows an empty state until something is transferred', () => {
    setup();
    expect(screen.getByText('No transfers right now')).toBeTruthy();
  });

  it('files or folders dragged onto the file tree keep their folder structure — a folder picked through the files panel uploads with its structure and shows its progress', async () => {
    const s = setup();
    const a = syntheticBytes(1, 0, 2000);
    const b = syntheticBytes(2, 0, 1500);
    await act(() =>
      s.session.commands.dispatch('startUpload', { root: MAIN_ROOT, targetDir: 'in', source: { kind: 'files', files: [fileOf('a.txt', a, 'proj/a.txt'), fileOf('b.txt', b, 'proj/sub/b.txt')] } }),
    );
    await s.settle(() => items()[0]?.dataset['status'] === 'done', 'the upload to finish');
    const row = items()[0] as HTMLElement;
    expect(within(row).getByText('proj')).toBeTruthy();
    expect(within(row).getByText('Upload to in')).toBeTruthy();
    expect(within(row).getByText('2 of 2 files')).toBeTruthy();
    expect(within(row).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    expect(s.worker.daemon.get(MAIN_ROOT, 'in/proj/sub/b.txt')).toEqual(b);
    // The app-wide store (tree badges, the drawer count) follows the Worker's reports.
    const [job] = [...s.stores.transfers.getState().jobs.values()];
    expect(job).toMatchObject({ kind: 'upload', status: 'done', doneBytes: 3500, totalBytes: 3500, files: 2 });
  });

  it('asks before replacing a name that exists, and uploads after "Overwrite"', async () => {
    const s = setup();
    s.worker.daemon.put(MAIN_ROOT, 'in/a.txt', new Uint8Array([1]));
    const content = syntheticBytes(3, 0, 100);
    await act(() => s.session.commands.dispatch('startUpload', { root: MAIN_ROOT, targetDir: 'in', source: { kind: 'files', files: [fileOf('a.txt', content)] } }));
    await s.settle(() => screen.queryByRole('alertdialog') !== null, 'the conflict dialog');
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('in/a.txt')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Overwrite' }));
    await s.settle(() => items()[0]?.dataset['status'] === 'done', 'the upload to finish');
    expect(s.worker.daemon.get(MAIN_ROOT, 'in/a.txt')).toEqual(content);
  });

  it('with too little disk space an upload is refused before it starts, not halfway — the refusal is shown with the numbers', async () => {
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
    await act(() => s.session.commands.dispatch('startUpload', { root: MAIN_ROOT, targetDir: 'in', source: { kind: 'files', files: [fileOf('big.bin', syntheticBytes(4, 0, 5000))] } }));
    await s.settle(() => items()[0]?.dataset['status'] === 'failed', 'the refusal');
    const alert = within(items()[0] as HTMLElement).getByRole('alert');
    expect(alert.textContent).toContain("The host's disk does not have enough space, so the upload did not start");
    expect(alert.textContent).toContain('the reserved 23 GB');
    expect(alert.textContent).toContain('20 GB available now');
    expect(s.worker.links[0]?.requestsOf('file.upload.chunk')).toHaveLength(0);
  });

  it('downloads a file through the Worker and hands the browser the result (no save picker in this browser)', async () => {
    const s = setup();
    const content = syntheticBytes(5, 0, 600 * 1024);
    s.worker.daemon.put(MAIN_ROOT, 'in/r.bin', content);
    await act(() => s.session.commands.dispatch('download', { file: { root: MAIN_ROOT, path: 'in/r.bin' } }));
    await s.settle(() => s.saved.length === 1, 'the download to be saved');
    expect(s.saved[0]?.name).toBe('r.bin');
    const blob = s.blobs.get(s.saved[0]?.url as string);
    expectSameBytes(new Uint8Array(await (blob as Blob).arrayBuffer()), content);
    const row = items()[0] as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Save file: r.bin' }));
    expect(s.saved).toHaveLength(2);
  });

  it('asks the save picker first where the browser has one, and cancels quietly when the person closes it', async () => {
    const s = setup();
    s.worker.daemon.put(MAIN_ROOT, 'in/r.bin', syntheticBytes(6, 0, 100));
    let asked = 0;
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = () => {
      asked++;
      return Promise.reject(new DOMException('closed', 'AbortError'));
    };
    await act(() => s.session.commands.dispatch('download', { file: { root: MAIN_ROOT, path: 'in/r.bin' } }));
    await act(flush);
    expect(asked).toBe(1);
    expect(items()).toHaveLength(0);
    expect(s.worker.received.some((m) => m.t === 'download')).toBe(false);
  });

  it('lists the zip entries the host left out and warns about ZIP64', async () => {
    const s = setup();
    s.worker.daemon.put(MAIN_ROOT, 'in/proj', 'dir');
    s.worker.daemon.zips.set(s.worker.daemon.key(MAIN_ROOT, 'in/proj'), { bytes: syntheticBytes(7, 0, 1000), skipped: [{ path: 'gone.txt', reason: 'open:ENOENT' }], zip64: true });
    await act(() => s.session.commands.dispatch('download', { file: { root: MAIN_ROOT, path: 'in/proj' }, zip: true }));
    await s.settle(() => items()[0]?.dataset['status'] === 'done', 'the zip download');
    const row = items()[0] as HTMLElement;
    expect(within(row).getByText('1 item was left out of the zip or added as an empty file')).toBeTruthy();
    expect(within(row).getByText(/Added to the zip, but empty/)).toBeTruthy();
    expect(within(row).getByText(/ZIP64/)).toBeTruthy();
  });

  it('pauses and resumes an upload from the panel', async () => {
    const s = setup({ link: { ackChunks: 'manual' } });
    await act(() =>
      s.session.commands.dispatch('startUpload', { root: MAIN_ROOT, targetDir: 'in', source: { kind: 'files', files: [fileOf('big.bin', syntheticBytes(8, 0, 6 * 1024 * 1024))] } }),
    );
    await s.settle(() => (s.worker.links[0]?.heldChunks.length ?? 0) === 4, 'four chunks in flight');
    fireEvent.click(screen.getByRole('button', { name: 'Pause: big.bin' }));
    s.worker.links[0]?.setAckMode('auto');
    await s.settle(() => screen.queryByRole('button', { name: 'Resume: big.bin' }) !== null, 'the resume button');
    fireEvent.click(screen.getByRole('button', { name: 'Resume: big.bin' }));
    await s.settle(() => items()[0]?.dataset['status'] === 'done', 'the upload to finish');
  });

  it('after a reload shows the interrupted upload and continues it with the same files chosen again', async () => {
    const journal = createMemoryJournal();
    const content = syntheticBytes(9, 0, 3 * 1024 * 1024);
    // A previous page: its upload stopped after the first chunks (the Worker went away with the page).
    const first = setup({ journal, link: { ackChunks: 'manual' } });
    await act(() => first.session.commands.dispatch('startUpload', { root: MAIN_ROOT, targetDir: 'in', source: { kind: 'files', files: [fileOf('big.bin', content)] } }));
    await first.settle(() => (first.worker.links[0]?.heldChunks.length ?? 0) === 3, 'chunks in flight');
    first.worker.links[0]?.releaseChunks(1);
    await act(() => first.worker.manager?.dispose() ?? Promise.resolve());
    first.unmount();

    const s = setup({ journal, daemon: first.worker.daemon });
    await s.settle(() => items().length === 1, 'the interrupted upload');
    const row = items()[0] as HTMLElement;
    expect(within(row).getByText('Interrupted by a page reload; choose the same files again to continue')).toBeTruthy();
    const input = s.container.querySelector('input[type=file][multiple]') as HTMLInputElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Choose the files to continue: big.bin' }));
    Object.defineProperty(input, 'files', { value: [fileOf('big.bin', content)], configurable: true });
    fireEvent.change(input);
    await s.settle(() => items()[0]?.dataset['status'] === 'done', 'the resumed upload');
    expectSameBytes(s.worker.daemon.get(MAIN_ROOT, 'in/big.bin'), content);
    expect(s.worker.links[0]?.requestsOf('file.upload.hashes').length).toBeGreaterThan(0);
  });

  it('keeps running while the panel is gone (navigation inside the app) and shows the result when it comes back', async () => {
    const s = setup({ link: { ackChunks: 'manual' } });
    const content = syntheticBytes(10, 0, 6 * 1024 * 1024);
    await act(() => s.session.commands.dispatch('startUpload', { root: MAIN_ROOT, targetDir: 'in', source: { kind: 'files', files: [fileOf('nav.bin', content)] } }));
    await s.settle(() => (s.worker.links[0]?.heldChunks.length ?? 0) === 4, 'chunks in flight');
    s.unmount(); // e.g. the person opened the host console
    s.worker.links[0]?.setAckMode('auto');
    await s.settle(() => s.worker.daemon.get(MAIN_ROOT, 'in/nav.bin') !== undefined, 'the upload to finish without a panel');
    expect(s.worker.terminated).toBe(false);
    render(
      <WorkspaceTestProviders context={s}>
        <TransfersPanel />
      </WorkspaceTestProviders>,
    );
    await s.settle(() => items()[0]?.dataset['status'] === 'done', 'the finished job in the new panel');
    expect(s.worker.received.filter((m) => m.t === 'init')).toHaveLength(1); // the same Worker, not a new one
  });

  // The transfer Worker's script is a file of the build. After a deploy it is gone like a chunk, and the browser says
  // so with an `error` event that names nothing. The panel said "The transfer component could not start: worker
  // error", with nothing about an update or a reload, and a dropped file went nowhere (0.5.1, V4-4).
  it('the Worker\'s file is gone after a deploy: the panel says "smurg was updated" with Reload in its place, and an upload that is tried says the same', async () => {
    setChunkProbe(() => Promise.resolve('gone'));
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    const s = setupDead();
    act(() => s.worker.fail());
    const notice = await within(s.panel).findByRole('alert');
    expect(notice.getAttribute('data-chunk-failure')).toBe('gone');
    expect(notice.textContent).toBe('smurg was updatedReload to get the new page; if the host has not updated yet, the page will say so.Reload the page');
    expect(s.panel.textContent).not.toContain('worker error');
    expect(s.panel.textContent).not.toContain('could not start');
    // The panel has nothing else to show: no invitation to drop files that would go nowhere.
    expect(within(s.panel).queryByText('No transfers right now')).toBeNull();

    // A file dropped on the tree all the same: the same words where the person is looking, with the same way out.
    await act(() => s.session.commands.dispatch('startUpload', { root: MAIN_ROOT, targetDir: 'in', source: { kind: 'files', files: [fileOf('a.txt', new Uint8Array(1))] } }));
    const toast = document.querySelector('.ui-toast') as HTMLElement;
    expect(within(toast).getByText('smurg was updated')).toBeTruthy();
    expect(within(toast).getByText('Reload to get the new page; if the host has not updated yet, the page will say so.')).toBeTruthy();
    expect(toast.textContent).not.toContain('worker error');
    // Nothing was handed to the dead Worker, and no transfer sits in the list waiting for ever.
    expect(s.worker.received.some((m) => (m as { t?: string }).t === 'upload')).toBe(false);
    expect(s.stores.transfers.getState().jobs.size).toBe(0);
    // A download says it too.
    await act(() => s.session.commands.dispatch('download', { file: { root: MAIN_ROOT, path: 'in/r.bin' } }));
    expect(document.querySelectorAll('.ui-toast')).toHaveLength(2);
    expect(s.worker.received.some((m) => (m as { t?: string }).t === 'download')).toBe(false);

    fireEvent.click(within(toast).getByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.click(within(notice).getByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalledTimes(2);
    reload.mockRestore();
  });

  it('the Worker\'s file did not come for another reason: offline is said to be that, and a file that is there is not called an update', async () => {
    const words = {
      offline: 'This part of the page could not be loadedThe browser is offline or cannot reach the smurg server. When the connection is back, reload the page.Reload the page',
      failed: 'This part of the page could not be loadedReload the page to load it again.Reload the page',
    } as const;
    for (const reason of ['offline', 'failed'] as const) {
      setChunkProbe(() => Promise.resolve(reason));
      const s = setupDead();
      act(() => s.worker.fail());
      const notice = await within(s.panel).findByRole('alert');
      expect(notice.getAttribute('data-chunk-failure')).toBe(reason);
      expect(notice.textContent).toBe(words[reason]);
      expect(s.panel.textContent).not.toContain('updated');
      cleanup();
    }
  });

  it("the Worker's own code that ran and threw is not a missing file: the panel keeps its words for that", async () => {
    let probed = 0;
    setChunkProbe(() => {
      probed += 1;
      return Promise.resolve('gone');
    });
    const s = setupDead();
    act(() => s.worker.fail(new ErrorEvent('error', { message: 'Uncaught TypeError: x is not a function' })));
    await act(flush);
    expect(within(s.panel).getByText('The transfer component could not start: worker error')).toBeTruthy();
    expect(s.panel.querySelector('[data-chunk-failure]')).toBeNull();
    expect(probed).toBe(0);
  });

  it('explains when this browser window cannot run transfers (no IndexedDB for the device key)', async () => {
    const s = setup({ fatal: 'no-indexeddb' });
    await s.settle(() => screen.queryByText(/cannot use IndexedDB/) !== null, 'the explanation');
    await act(() => s.session.commands.dispatch('startUpload', { root: MAIN_ROOT, targetDir: 'in', source: { kind: 'files', files: [fileOf('a.txt', new Uint8Array(1))] } }));
    expect(s.worker.received.some((m) => m.t === 'upload')).toBe(false);
  });
});
