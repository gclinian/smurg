// SPEC R1 acceptance (every request for a path outside the shared folder, symlinks and `..` included, is refused and
// recorded), through the real file.*,
// file.upload.* and file.download.* handlers (ARCHITECTURE §7.4), plus the path safety table of transfer.md §1.8.
// The "secret" outside the share is a fake file this test creates in its own temp directory.
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type AuditEntry, type FileRef } from '@smurg/protocol';
import type { TransferConnection } from '@smurg/protocol/client';
import type { TestClient } from '../../src/testing/index.ts';
import { MiB, auditEntries, rawRequest, settleError, startFilesDaemon, type FilesTest } from './helpers.ts';

const SECRET = 'FAKE-SECRET-OUTSIDE-THE-SHARE-R1-2';
const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

let ft: FilesTest;
let outside: string;
let amy: TestClient;
let host: TestClient;
let amyXfer: TransferConnection;

beforeEach(async () => {
  ft = await startFilesDaemon({
    project: { files: { 'README.md': '# hi\n', 'src/app.ts': 'x\n', 'src/deep/keep.txt': 'keep\n', 'in-share/target.txt': 'ok\n' } },
    files: { watch: false },
  });
  outside = join(dirname(ft.t.root), 'outside');
  await mkdir(join(outside, 'sub'), { recursive: true });
  await writeFile(join(outside, 'secret.txt'), SECRET);
  await writeFile(join(outside, 'sub', 'inner.txt'), SECRET);
  const root = ft.t.root;
  await symlink('../outside', join(root, 'link-out')); // a directory link out of the share
  await symlink('../outside/secret.txt', join(root, 'link-secret')); // a file link out of the share
  await symlink('../../../outside', join(root, 'src/deep/up')); // a nested link that climbs out
  await symlink(join(outside, 'secret.txt'), join(root, 'abs-link')); // an absolute link target
  await symlink('in-share/target.txt', join(root, 'good-link')); // stays inside: allowed
  host = await ft.t.connectHost();
  amy = await ft.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
  amyXfer = await amy.transfer();
});

afterEach(async () => {
  await ft.t.cleanup();
});

async function outsideUnchanged(): Promise<void> {
  expect((await readdir(outside)).sort()).toEqual(['secret.txt', 'sub']);
  expect(await readdir(join(outside, 'sub'))).toEqual(['inner.txt']);
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(SECRET);
}

const denialsOf = (entries: AuditEntry[], userId: string): AuditEntry[] =>
  entries.filter((e) => e.action === 'path.denied' && e.outcome === 'denied' && e.actor.kind === 'user' && e.actor.userId === userId);

describe('R1.2 every request for a path outside the shared folder (symlinks and `..` included) is refused and recorded', () => {
  it('paths outside the shared folder are refused and recorded — symlinks out of the share, through every file.* handler, for a guest and for the host', async () => {
    for (const client of [amy, host]) {
      const before = denialsOf(await auditEntries(ft.t.ctx), client.userId).length;
      const attempts: [string, () => Promise<unknown>][] = [
        ['read dir link', () => client.conn.request('file.read', { file: main('link-out/secret.txt') })],
        ['read file link', () => client.conn.request('file.read', { file: main('link-secret') })],
        ['read nested link', () => client.conn.request('file.read', { file: main('src/deep/up/secret.txt') })],
        ['read absolute link', () => client.conn.request('file.read', { file: main('abs-link') })],
        ['tree through link', () => client.conn.request('file.tree', { root: MAIN_ROOT, path: 'link-out' })],
        ['tree nested link', () => client.conn.request('file.tree', { root: MAIN_ROOT, path: 'src/deep/up/sub' })],
        ['stat through link', () => client.conn.request('file.stat', main('link-out/secret.txt'))],
        ['write through link', () => client.conn.request('file.write', { file: main('link-out/planted.txt'), content: utf8('planted') })],
        ['write over a link', () => client.conn.request('file.write', { file: main('link-secret'), content: utf8('overwritten') })],
        ['create through link', () => client.conn.request('file.create', { file: main('link-out/new-dir'), kind: 'dir' })],
        ['rename into link', () => client.conn.request('file.rename', { root: MAIN_ROOT, from: 'README.md', to: 'link-out/README.md' })],
        ['rename out of link', () => client.conn.request('file.rename', { root: MAIN_ROOT, from: 'link-out/secret.txt', to: 'stolen.txt' })],
        ['delete through link', () => client.conn.request('file.delete', { file: main('link-out/secret.txt') })],
      ];
      for (const [label, attempt] of attempts) {
        const error = await settleError(attempt());
        expect(error?.code, label).toBe('path_denied');
        expect(error?.message ?? '', label).not.toContain(SECRET);
      }
      const after = denialsOf(await auditEntries(ft.t.ctx), client.userId);
      expect(after.length - before).toBe(attempts.length);
      expect(after.slice(before).every((e) => ['outside-root', 'symlink'].includes(String(e.detail?.['reason'])))).toBe(true);
    }
    // The link that stays inside the share still works; the tree lists the escaping links as links, nothing more.
    const good = await amy.conn.request('file.read', { file: main('good-link') });
    expect(new TextDecoder().decode(good.content)).toBe('ok\n');
    await outsideUnchanged();
    await expect(lstat(join(ft.t.root, 'stolen.txt'))).rejects.toThrow();
  });

  it('paths outside the shared folder are refused and recorded — uploads and downloads (transfer channel)', async () => {
    const before = denialsOf(await auditEntries(ft.t.ctx), amy.userId).length;
    const attempts: [string, () => Promise<unknown>][] = [
      ['upload into link', () => amyXfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'link-out/planted.bin', size: 10, chunkSize: MiB, lastModified: 1 })],
      ['upload into nested link', () => amyXfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'src/deep/up/planted.bin', size: 10, chunkSize: MiB, lastModified: 1 })],
      ['upload plan through link', () => amyXfer.request('file.upload.plan', { root: MAIN_ROOT, entries: [{ path: 'link-out/dir', kind: 'dir' }], onConflict: 'fail' })],
      ['download file link', () => amyXfer.request('file.download.begin', { file: main('link-secret') })],
      ['download through dir link', () => amyXfer.request('file.download.begin', { file: main('link-out/secret.txt') })],
      ['zip through link', () => amyXfer.request('file.download.begin', { file: main('link-out'), zip: true })],
    ];
    for (const [label, attempt] of attempts) expect((await settleError(attempt()))?.code, label).toBe('path_denied');
    const after = denialsOf(await auditEntries(ft.t.ctx), amy.userId);
    expect(after.length - before).toBe(attempts.length);
    await outsideUnchanged();
  });

  it('paths outside the shared folder are refused and recorded — forged `..`, absolute and backslash paths that get past the decoder reach the handlers and are refused there too', async () => {
    const forged: [string, unknown, TransferConnection?][] = [
      ['file.read', { file: { root: MAIN_ROOT, path: '../outside/secret.txt' } }],
      ['file.read', { file: { root: MAIN_ROOT, path: 'src/../../outside/secret.txt' } }],
      ['file.read', { file: { root: MAIN_ROOT, path: '/etc/passwd' } }],
      ['file.read', { file: { root: MAIN_ROOT, path: '..\\outside\\secret.txt' } }],
      ['file.tree', { root: MAIN_ROOT, path: '..' }],
      ['file.stat', { root: MAIN_ROOT, path: '../outside' }],
      ['file.write', { file: { root: MAIN_ROOT, path: '../outside/planted.txt' }, content: utf8('x') }],
      ['file.create', { file: { root: MAIN_ROOT, path: '../outside/new' }, kind: 'dir' }],
      ['file.rename', { root: MAIN_ROOT, from: 'README.md', to: '../outside/README.md' }],
      ['file.delete', { file: { root: MAIN_ROOT, path: '../outside/secret.txt' } }],
      ['file.upload.begin', { root: MAIN_ROOT, path: '../outside/x.bin', size: 1, chunkSize: MiB, lastModified: 1 }, amyXfer],
      ['file.download.begin', { file: { root: MAIN_ROOT, path: '../outside/secret.txt' } }, amyXfer],
    ];
    const before = denialsOf(await auditEntries(ft.t.ctx), amy.userId).length;
    for (const [type, payload, transfer] of forged) {
      const answer = await rawRequest(ft.t, amy, type, payload, transfer);
      expect(answer, `${type} ${JSON.stringify(payload)}`).not.toBe('answered');
      if (answer !== 'answered') {
        expect(answer.code, type).toBe('path_denied');
        expect(answer.detail?.['reason'], type).toBe('lexical');
      }
    }
    const after = denialsOf(await auditEntries(ft.t.ctx), amy.userId);
    expect(after.length - before).toBe(forged.length);
    await outsideUnchanged();
  });
});

describe('path safety table (transfer.md §1.8) at the handlers', () => {
  const refused: [string, string][] = [
    ['empty', ''],
    ['NUL', 'a\u0000b'],
    ['C0 control', 'a\u0001b'],
    ['DEL', 'a\u007fb'],
    ['escape sequence', 'a\u001b[31m'],
    ['bidi override', 'evil\u202etxt.exe'],
    ['bidi isolate', 'a\u2066b'],
    ['backslash', 'a\\b'],
    ['drive letter', 'C:/x'],
    ['absolute', '/x'],
    ['double slash', 'a//b'],
    ['trailing slash', 'a/'],
    ['dot segment', './a'],
    ['dot-dot segment', 'a/../b'],
    ['lone surrogate', 'a\ud800b'],
    ['256 UTF-16 units in one segment', 'a'.repeat(256)],
    ['128 emoji (256 UTF-16 units)', '😀'.repeat(128)],
    ['path over 4096 characters', `${'d/'.repeat(2_048)}x`],
  ];
  it.each(refused)('refuses %s (path_denied, audited)', async (_label, path) => {
    const before = denialsOf(await auditEntries(ft.t.ctx), amy.userId).length;
    const answer = await rawRequest(ft.t, amy, 'file.create', { file: { root: MAIN_ROOT, path }, kind: 'file' });
    expect(answer).not.toBe('answered');
    if (answer !== 'answered') {
      expect(answer.code).toBe('path_denied');
      expect(['lexical', 'too-long']).toContain(answer.detail?.['reason']);
    }
    expect(denialsOf(await auditEntries(ft.t.ctx), amy.userId).length - before).toBe(1);
  });

  it('refuses `.git/…` (host-only) and `.smurg/…` (hidden) as a first segment for guests, under any spelling', async () => {
    for (const [path, code] of [
      ['.git/hooks/pre-commit', 'host_only'],
      ['.GIT/config', 'host_only'],
      ['.smurg/uploads/x', 'path_denied'],
      ['.SMURG/worktrees/x', 'path_denied'],
    ] as const) {
      const error = await settleError(amy.conn.request('file.create', { file: main(path), kind: 'file' }));
      expect(error?.code, path).toBe(code);
      const upload = await settleError(amyXfer.request('file.upload.begin', { root: MAIN_ROOT, path, size: 1, chunkSize: MiB, lastModified: 1 }));
      expect(upload?.code, path).toBe(code);
    }
  });

  it('normalises to NFC and accepts long CJK names within the host limit (255 UTF-16 units on macOS)', async () => {
    const nfd = 'cafe\u0301.txt';
    const created = await amy.conn.request('file.create', { file: main(nfd), kind: 'file' });
    expect(created.entry.path).toBe('caf\u00e9.txt');
    expect(created.entry.path).toBe(nfd.normalize('NFC'));
    if (process.platform === 'darwin') {
      const cjk = '中'.repeat(255); // 765 bytes of UTF-8: fine on APFS, which counts UTF-16 units
      const long = await amy.conn.request('file.create', { file: main(cjk), kind: 'file' });
      expect(long.entry.name).toBe(cjk);
    }
    const tree = await amy.conn.request('file.tree', { root: MAIN_ROOT, path: '' });
    expect(tree.entries.map((e) => e.name)).toContain('caf\u00e9.txt');
  });
});
