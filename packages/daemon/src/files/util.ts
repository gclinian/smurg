// Small helpers shared by the files module: keys for best-effort per-path bookkeeping, audit labels, a bounded
// parallel map (so a 10,000-entry listing does not open 10,000 fs requests at once) and zh-TW formatting.
import { sep } from 'node:path';
import { foldPathName, normalized, relPathSegments, rootRefKey, type FileRef, type RootRef } from '@smurg/protocol';

/**
 * Key for attribution and "known directory" bookkeeping. Folded like a case-insensitive file system folds names
 * (foldPathName): `README.md` and `readme.md` are one entry on APFS, and a request may use either spelling. On a
 * case-sensitive file system two different files can share a key; that only merges two best-effort badges.
 */
export function looseKey(root: RootRef, path: string): string {
  return `${rootRefKey(root)}:${relPathSegments(normalized(path, 'NFC')).map(foldPathName).join('/')}`;
}

/** `main:src/app.ts` / `wt:<id>:src/app.ts`: the audit target convention of PathGuard. */
export function refLabel(ref: FileRef): string {
  return `${rootRefKey(ref.root)}:${ref.path}`;
}

/** An OS path relative to a root, with POSIX separators (the wire form). */
export function toPosix(rel: string): string {
  return sep === '/' ? rel : rel.split(sep).join('/');
}

/** `parent/name` for valid relative paths (`""` is the root). */
export function joinRel(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

/** Runs `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
