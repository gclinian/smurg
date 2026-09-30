// @vitest-environment node
// Path collection from a drop (FileSystemEntry trees) and from a picker (webkitRelativePath). transfer.md §1.9.
import { describe, expect, it } from 'vitest';
import type { UploadSource } from '../../../lib/commands.ts';
import { collectUploadSource } from './collect.ts';

type FakeEntry = FakeFile | FakeDir;
interface FakeFile {
  readonly name: string;
  readonly isFile: true;
  readonly isDirectory: false;
  file(success: (file: File) => void, failure?: (error: unknown) => void): void;
}
interface FakeDir {
  readonly name: string;
  readonly isFile: false;
  readonly isDirectory: true;
  createReader(): { readEntries(success: (entries: FakeEntry[]) => void, failure?: (error: unknown) => void): void };
}

let readEntriesCalls = 0;

function file(name: string, content = name, options: { fail?: boolean } = {}): FakeFile {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(success, failure) {
      if (options.fail) queueMicrotask(() => failure?.(new DOMException('gone', 'NotFoundError')));
      else queueMicrotask(() => success(new File([content], name, { lastModified: 1_780_000_000_000 })));
    },
  };
}

/** Lists its children in batches of `batch` (Chromium: 100), like the real API: only an empty batch means done. */
function dir(name: string, children: FakeEntry[], batch = 2): FakeDir {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let at = 0;
      return {
        readEntries(success) {
          readEntriesCalls++;
          const next = children.slice(at, at + batch);
          at += next.length;
          queueMicrotask(() => success(next));
        },
      };
    },
  };
}

const drop = (...entries: FakeEntry[]): UploadSource => ({ kind: 'drop', entries: entries as unknown as FileSystemEntry[], handles: [] });

describe('collectUploadSource — drops', () => {
  it('keeps the folder structure, empty folders included, and reads every batch of readEntries until it is empty', async () => {
    readEntriesCalls = 0;
    const tree = dir('proj', [
      file('a.txt'),
      dir('sub', [dir('deeper', [file('c.txt')]), file('b.txt'), file('d.txt'), file('e.txt')]),
      dir('empty', []),
      dir('中文', [file('檔案.md')]),
      file('z.txt'),
    ]);
    const collected = await collectUploadSource(drop(tree, file('top.txt')));

    expect(collected.items.map((item) => `${item.kind}:${item.path}`)).toEqual([
      'dir:proj',
      'file:proj/a.txt',
      'dir:proj/sub',
      'dir:proj/sub/deeper',
      'file:proj/sub/deeper/c.txt',
      'file:proj/sub/b.txt',
      'file:proj/sub/d.txt',
      'file:proj/sub/e.txt',
      'dir:proj/empty',
      'dir:proj/中文',
      'file:proj/中文/檔案.md',
      'file:proj/z.txt',
      'file:top.txt',
    ]);
    expect(collected.topNames).toEqual(['proj', 'top.txt']);
    expect(collected.fileCount).toBe(8);
    expect(collected.totalBytes).toBe(['a.txt', 'c.txt', 'b.txt', 'd.txt', 'e.txt', '檔案.md', 'z.txt', 'top.txt'].reduce((n, s) => n + new TextEncoder().encode(s).byteLength, 0));
    // proj has 5 children in batches of 2 → 3 batches + the empty one; sub 4 → 2 + 1; deeper, empty, 中文 → 1 + 1 / 0 + 1 / 1 + 1.
    expect(readEntriesCalls).toBe(4 + 3 + 2 + 1 + 2);
    expect(collected.rejected).toEqual([]);
  });

  it('normalises macOS NFD names to NFC (folders and files) and keeps the content', async () => {
    const nfdCafe = 'café';
    const tree = dir(nfdCafe, [file(`${nfdCafe}.txt`, 'menu')]);
    const collected = await collectUploadSource(drop(tree));
    expect(collected.items.map((item) => item.path)).toEqual(['café', 'café/café.txt']);
    for (const item of collected.items) expect(item.path).toBe(item.path.normalize('NFC'));
    expect(collected.items[1]?.path).not.toBe(`${nfdCafe}/${nfdCafe}.txt`);
    const picked = collected.items[1];
    expect(picked?.kind === 'file' ? await picked.file.text() : null).toBe('menu');
  });

  it('reports NFC twins (two spellings of one name, possible on Linux) instead of sending a colliding batch', async () => {
    const collected = await collectUploadSource(drop(dir('d', [file('café.txt', '1'), file('café.txt', '2')])));
    expect(collected.items.map((item) => item.path)).toEqual(['d', 'd/café.txt']);
    expect(collected.rejected).toEqual([{ path: 'd/café.txt', problem: 'duplicate' }]);
  });

  it('reports names the host would refuse and files that cannot be read, and still collects the rest', async () => {
    const collected = await collectUploadSource(
      drop(dir('p', [file('ok.txt'), file('back\\slash.txt'), file('ctl\u0007.txt'), file('gone.txt', 'x', { fail: true }), dir('bad‮', [file('inside.txt')])])),
    );
    expect(collected.items.map((item) => item.path)).toEqual(['p', 'p/ok.txt']);
    expect(collected.rejected).toEqual([
      { path: 'p/back\\slash.txt', problem: 'backslash' },
      { path: 'p/ctl\u0007.txt', problem: 'control-character' },
      { path: 'p/gone.txt', problem: 'unreadable' },
      { path: 'p/bad‮', problem: 'bidi-character' },
    ]);
  });

  it('keeps the top-level FileSystemHandles of a Chromium drop by name (for resuming after a reload)', async () => {
    const handle = { kind: 'directory', name: 'proj' } as unknown as FileSystemHandle;
    const collected = await collectUploadSource({
      kind: 'drop',
      entries: [dir('proj', [file('a.txt')])] as unknown as FileSystemEntry[],
      handles: [Promise.resolve(handle), Promise.reject(new Error('no handle'))],
    });
    expect([...collected.handles.keys()]).toEqual(['proj']);
  });
});

describe('collectUploadSource — pickers', () => {
  it('uses webkitRelativePath of <input webkitdirectory> (NFC), and the plain name for single files', async () => {
    const inFolder = new File(['x'], 'b.txt');
    Object.defineProperty(inFolder, 'webkitRelativePath', { value: 'proj/sub/b.txt' });
    const nfd = new File(['y'], 'café.txt');
    Object.defineProperty(nfd, 'webkitRelativePath', { value: 'proj/café.txt' });
    const single = new File(['z'], 'single.txt');
    const collected = await collectUploadSource({ kind: 'files', files: [inFolder, nfd, single] });
    expect(collected.items.map((item) => item.path)).toEqual(['proj/sub/b.txt', 'proj/café.txt', 'single.txt']);
    expect(collected.topNames).toEqual(['proj', 'single.txt']);
    expect(collected.fileCount).toBe(3);
  });
});
