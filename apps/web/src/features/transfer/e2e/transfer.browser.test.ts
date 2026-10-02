// @vitest-environment node
// Transfers in a real browser: the real relay (local workerd, TransferDO), the real daemon (files module, real disk
// check, staging, commit), this app on the Vite dev server and system Chrome headless (fresh context, dev login).
// What only a real browser proves: the transfer Worker loads the device key the page created from IndexedDB itself,
// runs its own Noise handshake on /xfer, reads File slices and hashes with WebCrypto inside the Worker, and stages a
// download in OPFS with a sync access handle. Skipped where no system Chrome is installed.
//
// The web e2e stack (apps/web/e2e/stack.ts) is imported at run time only: the web tsc program excludes e2e/ (it
// pulls in Node-only harness code), so this file declares the few members it uses.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface WebStackLike {
  readonly browser: Browser;
  readonly webOrigin: string;
  readonly stack: {
    readonly workspaceId: string;
    readonly root: string;
    readonly hostClient: { readonly conn: { request(type: 'admin.settings.set' | 'file.stat', payload: Record<string, unknown>): Promise<unknown> } };
  };
  invite(origin?: string): Promise<string>;
  stop(): Promise<void>;
}
interface StackModule {
  startWebStack(options: { tmpDir: string }): Promise<WebStackLike>;
}

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'].find((p) => existsSync(p)) ?? null;
const STACK_MODULE = fileURLToPath(new URL('../../../../e2e/stack.ts', import.meta.url));
const MiB = 1024 * 1024;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const execFileAsync = promisify(execFile);
/** Size of the scaled R7.2 run (MiB); SMURG_R72_MIB=10240 for the full 10 GB. */
const R72_MIB = Math.max(1, Number(process.env['SMURG_R72_MIB'] ?? '512') || 512);

/** The same deterministic bytes in the page and here. */
function pattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + ((i >>> 12) & 0xff) + 7) & 0xff;
  return bytes;
}

/**
 * RSS of the Chrome processes this test process started (its descendants whose command names Chrome). Read-only: the
 * process table is only read, never used to signal anything (ARCHITECTURE §0).
 */
async function chromeRssBytes(): Promise<number> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], { maxBuffer: 16 * MiB });
  const rows = stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssKiB: Number(m[3]), command: m[4] ?? '' }));
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const mine = new Set<number>();
  const queue = [process.pid];
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    for (const child of children.get(pid) ?? []) {
      if (mine.has(child)) continue;
      mine.add(child);
      queue.push(child);
    }
  }
  return rows.filter((row) => mine.has(row.pid) && /chrom/i.test(row.command)).reduce((sum, row) => sum + row.rssKiB * 1024, 0);
}

async function joinWorkspace(page: Page, env: WebStackLike, user: string): Promise<void> {
  await page.goto(await env.invite());
  await page.getByTestId('join-login').waitFor({ timeout: 60_000 });
  await page.getByLabel('Account name').fill(user);
  await page.getByRole('button', { name: 'Log in with a development account' }).click();
  // The join page's explicit "Join" (an invite link never joins on page load).
  await page.getByTestId('join-confirm').waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.waitForURL(`${env.webOrigin}/w/${env.stack.workspaceId}`, { timeout: 60_000 });
  await page.getByRole('banner', { name: 'Workspace' }).getByText('Connected').waitFor({ timeout: 60_000 });
}

describe.skipIf(CHROME === null)('transfers in a real browser (Worker + IndexedDB device key + Noise + TransferDO + daemon)', () => {
  let env: WebStackLike;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    const { startWebStack } = (await import(STACK_MODULE)) as StackModule;
    env = await startWebStack({ tmpDir: process.env['TMPDIR'] ?? '/tmp' });
    // This machine's disk is nearly full: the default 5 % reserve would refuse every upload (R7.4 does its job).
    await env.stack.hostClient.conn.request('admin.settings.set', { diskReserveBytes: 0, diskReservePercent: 0 });
    context = await env.browser.newContext({ locale: 'en-US', acceptDownloads: true });
    page = await context.newPage();
    await joinWorkspace(page, env, 'amy');
  }, 240_000);

  afterAll(async () => {
    await context?.close().catch(() => {});
    await env?.stop();
  }, 60_000);

  it('the transfer Worker uploads a folder (empty folder included) and downloads it back — file through OPFS, folder as zip', async () => {
    const size = 9 * MiB + 123;
    const result = await page.evaluate(
      async ({ workspaceId, size }) => {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i++) bytes[i] = (i * 31 + ((i >>> 12) & 0xff) + 7) & 0xff;
        const worker = new Worker('/src/features/transfer/worker/transfer.worker.ts', { type: 'module' });
        const events: { t: string; id?: string; snapshot?: { id: string; status: string; failure: unknown; download: unknown }; state?: string; blob?: Blob }[] = [];
        const waiters: (() => void)[] = [];
        worker.addEventListener('message', (m) => {
          events.push(m.data);
          for (const wake of waiters.splice(0)) wake();
        });
        const waitFor = async <T>(pick: () => T | undefined, ms: number, what: string): Promise<T> => {
          const deadline = Date.now() + ms;
          for (;;) {
            const found = pick();
            if (found !== undefined) return found;
            if (Date.now() > deadline) throw new Error(`timeout: ${what}; last events ${JSON.stringify(events.slice(-4).map((e) => ({ t: e.t, s: e.snapshot?.status, f: e.snapshot?.failure, state: e.state })))}`);
            await new Promise<void>((resolve) => {
              waiters.push(resolve);
              setTimeout(resolve, 200);
            });
          }
        };
        const finished = (id: string) => () => events.find((e) => e.t === 'job' && e.snapshot?.id === id && ['done', 'failed', 'cancelled'].includes(e.snapshot.status))?.snapshot;
        worker.postMessage({ t: 'init', workspaceId, deviceName: 'e2e' });
        const ready = await waitFor(() => events.find((e) => e.t === 'ready' || e.t === 'fatal'), 30_000, 'worker ready');
        if (ready.t === 'fatal') return { fatal: JSON.stringify(ready) };

        const big = new File([bytes], 'big.bin', { lastModified: 1_780_000_000_000 });
        const small = new File(['你好，smurg'], '中文.txt', { lastModified: 1_780_000_000_000 });
        worker.postMessage({
          t: 'upload',
          id: 'up1',
          root: { kind: 'main' },
          targetDir: '',
          name: 'drop',
          items: [
            { path: 'drop', kind: 'dir' },
            { path: 'drop/empty', kind: 'dir' },
            { path: 'drop/big.bin', kind: 'file', file: big },
            { path: 'drop/中文.txt', kind: 'file', file: small },
          ],
          rejected: [],
        });
        const upload = await waitFor(finished('up1'), 120_000, 'upload');

        worker.postMessage({ t: 'download', id: 'dl1', file: { root: { kind: 'main' }, path: 'drop/big.bin' }, zip: false, name: 'big.bin' });
        const out = await waitFor(() => events.find((e) => e.t === 'output' && e.id === 'dl1'), 120_000, 'file download');
        const back = new Uint8Array(await (out.blob as Blob).arrayBuffer());
        const same = back.length === size && back.every((b, i) => b === bytes[i]);
        const fileDownload = await waitFor(finished('dl1'), 10_000, 'file download snapshot');

        worker.postMessage({ t: 'download', id: 'dl2', file: { root: { kind: 'main' }, path: 'drop' }, zip: true, name: 'drop.zip' });
        const zipOut = await waitFor(() => events.find((e) => e.t === 'output' && e.id === 'dl2'), 120_000, 'zip download');
        const zip = new Uint8Array(await (zipOut.blob as Blob).arrayBuffer());
        const zipText = new TextDecoder('latin1').decode(zip);

        worker.postMessage({ t: 'dispose' });
        await waitFor(() => events.find((e) => e.t === 'disposed'), 10_000, 'dispose');
        return {
          fatal: null,
          upload,
          same,
          downloadedBytes: back.length,
          fileDownload,
          zipMagic: [zip[0], zip[1], zip[2], zip[3]],
          zipNames: ['big.bin', 'empty/', '中文.txt'].map((name) => zipText.includes(new TextDecoder('latin1').decode(new TextEncoder().encode(name)))),
          linkStates: [...new Set(events.filter((e) => e.t === 'link').map((e) => e.state))],
        };
      },
      { workspaceId: env.stack.workspaceId, size },
    );

    expect(result.fatal).toBeNull();
    expect(result.upload).toMatchObject({ status: 'done', failure: null });
    // On the host: the structure, the empty folder, the exact bytes.
    expect(sha(await readFile(join(env.stack.root, 'drop/big.bin')))).toBe(sha(pattern(size)));
    expect(await readFile(join(env.stack.root, 'drop/中文.txt'), 'utf8')).toBe('你好，smurg');
    expect((await stat(join(env.stack.root, 'drop/empty'))).isDirectory()).toBe(true);
    // Back in the browser, byte for byte, staged in OPFS by the Worker (no save picker in a Worker-driven download).
    expect(result.downloadedBytes).toBe(size);
    expect(result.same).toBe(true);
    expect(result.fileDownload).toMatchObject({ status: 'done', download: { savedAs: 'opfs' } });
    expect(result.zipMagic).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(result.zipNames).toEqual([true, true, true]);
    // Its own socket and Noise handshake, separate from the page's interactive connection.
    expect(result.linkStates).toEqual(expect.arrayContaining(['handshaking', 'online']));
  }, 240_000);

  it('while a 10 GB file uploads, browser memory stays stable and other people’s typing and terminals show no noticeable delay — scaled down (512 MiB by default) from a synthetic source in real Chrome', async () => {
    // Scaled so the shared test run stays short and the host's staging area small; SMURG_R72_MIB=10240 runs the full
    // size (the host needs that much free disk above its reserve). The dev page dev/measure.html does the same by hand.
    const size = R72_MIB * MiB;
    const baseline = await chromeRssBytes();
    const rss: number[] = [];
    const rtt: number[] = [];
    let stop = false;
    // Another person's requests while the upload runs (what typing and terminals wait for).
    const probe = (async () => {
      while (!stop) {
        const t0 = performance.now();
        await env.stack.hostClient.conn.request('file.stat', { root: { kind: 'main' }, path: '' });
        rtt.push(performance.now() - t0);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    })();
    const sampler = (async () => {
      while (!stop) {
        rss.push(await chromeRssBytes());
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    })();
    let result: { measured: { bytes: number; durationMs: number; bytesPerSecond: number; maxBufferedAmount: number; peakBytesInFlight: number; status: string } | null; drift: number[]; fatal: string | null };
    try {
      result = await page.evaluate(
        async ({ workspaceId, size }) => {
          const worker = new Worker('/src/features/transfer/worker/transfer.worker.ts', { type: 'module' });
          const drift: number[] = [];
          let expected = performance.now() + 50;
          const timer = setInterval(() => {
            const now = performance.now();
            drift.push(Math.max(0, now - expected));
            expected = now + 50;
          }, 50);
          const outcome = await new Promise<{ measured: never | null; fatal: string | null }>((resolve) => {
            worker.addEventListener('message', (m) => {
              const data = m.data as { t: string; result?: never; message?: string };
              if (data.t === 'ready') worker.postMessage({ t: 'measure', request: { id: 'm1', root: { kind: 'main' }, path: 'measure.bin', size, seed: 3, finalize: 'abort' } });
              if (data.t === 'fatal') resolve({ measured: null, fatal: data.message ?? 'fatal' });
              if (data.t === 'measured') resolve({ measured: data.result ?? null, fatal: null });
            });
            worker.postMessage({ t: 'init', workspaceId, deviceName: 'e2e-measure' });
          });
          clearInterval(timer);
          worker.postMessage({ t: 'dispose' });
          return { ...outcome, drift };
        },
        { workspaceId: env.stack.workspaceId, size },
      );
    } finally {
      stop = true;
      await Promise.allSettled([probe, sampler]);
    }
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    const p95 = (values: number[]) => sorted(values)[Math.floor(values.length * 0.95)] ?? 0;
    const peakRss = Math.max(baseline, ...rss);
    console.info(
      `[R7.2 scaled] ${size / MiB} MiB in ${Math.round(result.measured?.durationMs ?? 0)} ms (${Math.round((result.measured?.bytesPerSecond ?? 0) / MiB)} MiB/s); ` +
        `Chrome RSS baseline ${Math.round(baseline / MiB)} MiB, peak ${Math.round(peakRss / MiB)} MiB, samples ${rss.map((r) => Math.round(r / MiB)).join(',')}; ` +
        `max bufferedAmount ${result.measured?.maxBufferedAmount}; peak chunk bytes in flight ${result.measured?.peakBytesInFlight}; ` +
        `other client's file.stat p95 ${Math.round(p95(rtt))} ms max ${Math.round(Math.max(0, ...rtt))} ms (${rtt.length}); page timer drift p95 ${Math.round(p95(result.drift))} ms max ${Math.round(Math.max(0, ...result.drift))} ms`,
    );
    expect(result.fatal).toBeNull();
    expect(result.measured).toMatchObject({ bytes: size, status: 'done' });
    // Flow control: the window (≤ 16 MiB of chunks unacknowledged) and the bufferedAmount guard (8 MiB, may overshoot
    // by one chunk and its framing).
    expect(result.measured?.peakBytesInFlight).toBeLessThanOrEqual(16 * MiB);
    expect(result.measured?.maxBufferedAmount).toBeLessThanOrEqual(16 * MiB);
    // Memory stays flat: the whole Chrome tree grows by far less than the data that went through it.
    expect(peakRss - baseline).toBeLessThan(384 * MiB);
    // No noticeable delay for the others (generous bounds: a shared, loaded machine).
    expect(rtt.length).toBeGreaterThan(3);
    expect(p95(rtt)).toBeLessThan(1_000);
    expect(p95(result.drift)).toBeLessThan(500);
    // Nothing is left on the host (finalize: abort).
    expect(existsSync(join(env.stack.root, 'measure.bin'))).toBe(false);
  }, Math.max(240_000, R72_MIB * 60)); // ≥ 17 MiB/s on a loaded machine

  it('the R7.2 measurement page (dev/measure.html) runs end to end and reports its numbers (small size here)', async () => {
    const measurePage = await context.newPage();
    try {
      await measurePage.goto(`${env.webOrigin}/src/features/transfer/dev/measure.html?ws=${env.stack.workspaceId}&gib=0.05&path=dev-measure.bin&autostart=1&probe=1`);
      await measurePage.waitForFunction(() => document.body.dataset['measureState'] === 'done' || document.body.dataset['measureState'] === 'failed', undefined, { timeout: 120_000 });
      const report = (await measurePage.evaluate(() => (window as unknown as { __smurgMeasure: unknown }).__smurgMeasure)) as {
        state: string;
        error: string | null;
        engine: { bytes: number; status: string } | null;
        interactiveRttMs: { samples: number };
        timerDriftMs: { samples: number };
      };
      expect(report.error).toBeNull();
      expect(report.state).toBe('done');
      expect(report.engine).toMatchObject({ bytes: Math.round(0.05 * 1024 * MiB), status: 'done' });
      expect(report.timerDriftMs.samples).toBeGreaterThan(0);
      expect(existsSync(join(env.stack.root, 'dev-measure.bin'))).toBe(false);
    } finally {
      await measurePage.close();
    }
  }, 180_000);

  it('the save-picker writer works inside a dedicated Worker (createWritable on a FileSystemFileHandle; an OPFS handle stands in for the picker, which headless Chrome cannot show)', async () => {
    const result = await page.evaluate(async (origin) => {
      const code = `
        import { PickerWriter } from '${origin}/src/features/transfer/engine/writers.ts';
        self.onmessage = async () => {
          try {
            const root = await navigator.storage.getDirectory();
            const handle = await root.getFileHandle('picker-writer-check.bin', { create: true });
            const writer = new PickerWriter(handle);
            await writer.prepare(500000);
            await writer.write(0, new Uint8Array(300000).fill(1));
            await writer.write(300000, new Uint8Array(200000).fill(2));
            const out = await writer.finish(500000);
            const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
            await root.removeEntry('picker-writer-check.bin');
            postMessage({ ok: true, kind: out.kind, size: bytes.length, first: bytes[0], last: bytes[499999], inWorker: typeof document === 'undefined' });
          } catch (error) {
            postMessage({ ok: false, error: String(error) });
          }
        };`;
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const worker = new Worker(url, { type: 'module' });
      const answer = await new Promise<Record<string, unknown>>((resolve) => {
        worker.onmessage = (m) => resolve(m.data as Record<string, unknown>);
        worker.onerror = (e) => resolve({ ok: false, error: e.message });
        worker.postMessage('go');
      });
      worker.terminate();
      URL.revokeObjectURL(url);
      return answer;
    }, env.webOrigin);
    expect(result).toEqual({ ok: true, kind: 'saved', size: 500000, first: 1, last: 2, inWorker: true });
  }, 120_000);

  it('the app: a file picked in the files panel is uploaded through the Worker, shown in the transfers panel, and a second upload of the same name asks first', async () => {
    const content = Buffer.from(pattern(5 * MiB + 7));
    await page.getByRole('tab', { name: 'Transfers' }).click();
    const input = page.locator('input[type=file][multiple][hidden]').first();
    await input.setInputFiles({ name: 'report.bin', mimeType: 'application/octet-stream', buffer: content });
    const row = page.getByTestId('transfer-item').filter({ hasText: 'report.bin' }).first();
    await row.and(page.locator('[data-status=done]')).waitFor({ timeout: 120_000 });
    expect(sha(await readFile(join(env.stack.root, 'report.bin')))).toBe(sha(content));

    await input.setInputFiles({ name: 'report.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('second version') });
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor({ timeout: 60_000 });
    expect(await dialog.textContent()).toContain('report.bin');
    await dialog.getByRole('button', { name: 'Keep both (rename automatically)' }).click();
    await page.locator('[data-testid=transfer-item][data-status=done]').nth(1).waitFor({ timeout: 120_000 });
    expect(await readFile(join(env.stack.root, 'report (1).bin'), 'utf8')).toBe('second version');
    expect(sha(await readFile(join(env.stack.root, 'report.bin')))).toBe(sha(content));
  }, 240_000);
});
