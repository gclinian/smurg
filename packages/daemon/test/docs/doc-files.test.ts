// Which files open as documents, and how their bytes survive an edit (ARCHITECTURE §5.3 doc.open, §7.5): CRLF, lone
// CR and BOM round trips; binary, UTF-16, invalid UTF-8 and oversized files refused; a file deleted or replaced by
// something binary after open is never overwritten.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, MAX_DOC_BYTES, isSmurgError } from '@smurg/protocol';
import { createDocsModule } from '../../src/docs/module.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { DocClient, destroyDocClients, sleep } from './helpers.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  try {
    destroyDocClients();
  } finally {
    await t?.cleanup();
    t = null;
  }
});

const BOM = '﻿';

describe('doc.open: text formats', { timeout: 30_000 }, () => {
  it('CRLF / CR / BOM round trips: LF-only Y.Text, the file keeps its line endings and BOM after an edit', async () => {
    const cases = [
      { path: 'crlf.txt', content: 'a\r\nb\r\n', meta: { eol: 'CRLF', bom: false, mixedEol: false }, after: 'a\r\nb\r\nadded\r\n' },
      { path: 'cr.txt', content: 'a\rb\r', meta: { eol: 'CR', bom: false, mixedEol: false }, after: 'a\rb\radded\r' },
      { path: 'bom.txt', content: `${BOM}x\ny\n`, meta: { eol: 'LF', bom: true, mixedEol: false }, after: `${BOM}x\ny\nadded\n` },
      { path: 'bom-crlf.txt', content: `${BOM}中文\r\n😀\r\n`, meta: { eol: 'CRLF', bom: true, mixedEol: false }, after: `${BOM}中文\r\n😀\r\nadded\r\n` },
      // Mixed: normalised to the majority (CRLF) on the first save; the client was told (mixedEol).
      { path: 'mixed.txt', content: 'a\r\nb\nc\r\n', meta: { eol: 'CRLF', bom: false, mixedEol: true }, after: 'a\r\nb\r\nc\r\nadded\r\n' },
    ] as const;
    t = await createTestDaemon({ project: { files: Object.fromEntries(cases.map((c) => [c.path, c.content])) }, modules: [createDocsModule()] });
    const amyConn = await t.connect({ userId: 'dev:amy', role: 'editor' });
    for (const c of cases) {
      const client = await DocClient.open(amyConn.conn, { root: MAIN_ROOT, path: c.path });
      await waitFor(() => client.synced, { what: `sync ${c.path}` });
      expect(client.opened.meta).toEqual(c.meta);
      expect(client.text.toString()).not.toMatch(/[\r﻿]/);
      client.text.insert(client.text.length, 'added\n');
      await waitFor(async () => (await readFile(join(t!.root, c.path), 'utf8')) === c.after, { what: `round trip ${c.path}` });
    }
  });

  it('refuses binary, UTF-16, invalid UTF-8 and oversized files (too_large / bad_request)', async () => {
    const big = Buffer.alloc(MAX_DOC_BYTES + 1, 0x61);
    t = await createTestDaemon({
      project: {
        files: {
          'image.png': Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x00, 0x00),
          'utf16.txt': Uint8Array.of(0xff, 0xfe, 0x61, 0x00, 0x62, 0x00),
          'big5.txt': Uint8Array.of(0xa4, 0xa4, 0xa4, 0xe5, 0x0a),
          'huge.txt': big,
          'exactly-max.txt': Buffer.alloc(MAX_DOC_BYTES, 0x62),
          dir: Uint8Array.of(),
        },
      },
      modules: [createDocsModule()],
    });
    await rm(join(t.root, 'dir'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(t.root, 'dir'));
    const amy = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const open = (path: string): Promise<unknown> => amy.conn.request('doc.open', { file: { root: MAIN_ROOT, path } }).catch((e: unknown) => e);
    const outcome = (e: unknown): string => (isSmurgError(e) ? `${e.code}:${String(e.detail?.['reason'])}` : 'opened');
    expect(outcome(await open('image.png'))).toBe('bad_request:binary');
    expect(outcome(await open('utf16.txt'))).toBe('bad_request:utf16-or-utf32-bom');
    expect(outcome(await open('big5.txt'))).toBe('bad_request:invalid-utf8');
    expect(outcome(await open('huge.txt'))).toBe('too_large:too-large');
    expect(outcome(await open('dir'))).toBe('bad_request:not-a-file');
    expect(outcome(await open('missing.txt'))).toBe('not_found:undefined');
    expect(outcome(await open('exactly-max.txt'))).toBe('opened');
  });

  it('a file deleted or turned binary after open is never recreated or overwritten; it resumes when text comes back', async () => {
    t = await createTestDaemon({ project: { files: { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'two\n' } }, modules: [createDocsModule()] });
    const amyConn = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const a = await DocClient.open(amyConn.conn, { root: MAIN_ROOT, path: 'a.txt' });
    const b = await DocClient.open(amyConn.conn, { root: MAIN_ROOT, path: 'b.txt' });
    await waitFor(() => a.synced && b.synced, { what: 'sync' });
    const pathA = join(t.root, 'a.txt');
    const pathB = join(t.root, 'b.txt');

    await rm(pathA);
    await writeFile(pathB, Uint8Array.of(0x00, 0x01, 0x02));
    t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'a.txt', change: 'unlink' }, { path: 'b.txt', change: 'change' }] });
    await sleep(100);
    a.text.insert(0, 'edited ');
    b.text.insert(0, 'edited ');
    await sleep(800);
    await expect(readFile(pathA)).rejects.toThrow();
    expect([...(await readFile(pathB))]).toEqual([0, 1, 2]);

    // The file comes back as text (git checkout): the unsaved edit merges with it and is saved.
    await writeFile(pathA, 'one\ntwo\nthree\nrestored\n');
    t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'a.txt', change: 'add' }] });
    await waitFor(async () => (await readFile(pathA, 'utf8').catch(() => '')) === 'edited one\ntwo\nthree\nrestored\n', { what: 'restored file merged and saved' });
    expect(a.text.toString()).toBe('edited one\ntwo\nthree\nrestored\n');
  });
});
