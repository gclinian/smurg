// R7.3 in a real browser, over the real relay's TransferDO (docs/ACCEPTANCE.md R7.3: it was proven at daemon level and
// in the web engine against a fake daemon only): the built app, loaded through a TCP proxy in front of the real relay
// (drop-proxy.ts), uploads a file of a few tens of MiB from code mode's Transfers tab; half-way the proxy cuts the transfer
// socket like a network would. The transfer Worker connects again on its own, asks what arrived and sends only the
// rest: the file on the host is byte-identical, and far less than the whole file went up after the drop.
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDropProxy, type DropProxy } from './drop-proxy.ts';
import { joinAs, startSmoke, systemChrome, toCodeMode, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

const MiB = 1024 * 1024;
const SIZE = 40 * MiB + 12_345;
/** The transfer socket is cut once this much went up through it (more than half of the file). */
const DROP_AFTER = 24 * MiB;

function pattern(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + ((i >>> 12) & 0xff) + 7) & 0xff;
  return bytes;
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(chrome === null)('R7.3 an upload over the real relay survives a dropped transfer socket (built app, TCP proxy, system Chrome)', () => {
  let proxy: DropProxy;
  let env: SmokeEnv;
  const source = join(process.env['TMPDIR'] as string, 'r73-upload.bin');

  beforeAll(async () => {
    proxy = await startDropProxy();
    env = await startSmoke({
      frontOrigin: proxy.origin,
      // The pages' origin is the proxy's: the relay accepts its cookie sessions from there.
      relayVars: { ALLOWED_ORIGINS: proxy.origin },
      stack: {
        projectFiles: { 'README.md': '# Class project\n' },
        // This machine's disk may be nearly full: the default reserve would refuse the upload (R7.4 doing its job).
        settings: { diskReserveBytes: 0, diskReservePercent: 0 },
      },
    });
    proxy.setUpstream(Number(new URL(env.relay.origin).port));
    await writeFile(source, pattern(SIZE));
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
    await proxy?.close();
    await rm(source, { force: true });
  }, 60_000);

  it('an upload cut off midway continues where it stopped after reconnecting — the transfer socket is dropped mid-upload; the upload resumes on a new socket and completes with identical content', async () => {
    const page = await env.newPage();
    await joinAs(page, env, 'uma', 'editor');
    proxy.dropTransferAfter(DROP_AFTER);
    // Uploads are code mode's: the Transfers tab of its drawer.
    await toCodeMode(page);
    await page.getByRole('tab', { name: 'Transfers' }).click();
    await page.locator('input[type=file][multiple][hidden]').first().setInputFiles(source);
    const row = page.getByTestId('transfer-item').filter({ hasText: 'r73-upload.bin' }).first();
    await row.and(page.locator('[data-status=done]')).waitFor({ timeout: 180_000 });

    // Identical on the host.
    expect(sha(await readFile(join(env.stack.root, 'r73-upload.bin')))).toBe(sha(pattern(SIZE)));
    // It really was cut half-way, and a new transfer socket finished it…
    expect(proxy.dropped).toBe(true);
    const cut = proxy.transfers.find((t) => t.dropped);
    expect(cut?.bytesUp).toBeGreaterThanOrEqual(DROP_AFTER);
    expect(cut?.bytesUp).toBeLessThan(SIZE);
    const after = proxy.transfers.filter((t) => t.afterDrop);
    expect(after.length).toBeGreaterThan(0);
    // …by sending only what had not arrived: far less than the whole file went up after the drop (a restart would
    // send all of it again), and together with what went before, all of it.
    const resent = after.reduce((sum, t) => sum + t.bytesUp, 0);
    console.info(`[R7.3 web] ${(SIZE / MiB).toFixed(1)} MiB: cut after ${((cut?.bytesUp ?? 0) / MiB).toFixed(1)} MiB, ${(resent / MiB).toFixed(1)} MiB sent after the drop on ${after.length} new transfer socket(s)`);
    expect(resent).toBeLessThan(SIZE - 8 * MiB);
    expect(resent + (cut?.bytesUp ?? 0)).toBeGreaterThanOrEqual(SIZE);
    expect(env.problemsOf(page).pageErrors).toEqual([]);
  }, 300_000);
});
