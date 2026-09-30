// session.importConfig (SPEC R4 「匯入個人設定」; ARCHITECTURE §5.5): a guest copies their own CLAUDE.md, commands/**
// and skills/** into THEIR guest config dir. Validation is lexical and PathGuard-style (the same lexical layer as every
// client path), sizes are capped again here, names that a case-insensitive file system would fold together are
// refused (one file would silently replace the other), and the files are written all or none. The write itself runs
// in the guest store's quarantine (guest-store.ts): no symlink planted in the guest's tree is ever followed.
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  IMPORT_CONFIG_FILE_MAX_BYTES,
  IMPORT_CONFIG_MAX_FILES,
  IMPORT_CONFIG_TOTAL_MAX_BYTES,
  SmurgError,
  foldPathName,
  isImportableConfigPath,
  relPathSegments,
} from '@smurg/protocol';
import { ensureRealDir } from './guest-store.ts';

export interface ImportFile {
  readonly relPath: string;
  readonly content: Uint8Array;
}

function refuse(reason: string, message: string): SmurgError {
  return new SmurgError('bad_request', message, { reason });
}

/** Validates a whole request before anything is written. `lexical` is PathGuard.lexical (throws on a bad path). */
export function validateImport(files: readonly ImportFile[], lexical: (path: unknown) => string): ImportFile[] {
  if (files.length === 0 || files.length > IMPORT_CONFIG_MAX_FILES) throw refuse('import-count', '匯入的檔案數量不正確');
  let total = 0;
  const folded = new Map<string, string>();
  const out: ImportFile[] = [];
  for (const file of files) {
    const relPath = lexical(file.relPath);
    if (relPath !== file.relPath || !isImportableConfigPath(relPath)) throw refuse('import-path', '只能匯入 CLAUDE.md、commands/ 與 skills/ 內的檔案');
    if (file.content.byteLength > IMPORT_CONFIG_FILE_MAX_BYTES) throw refuse('import-size', '單一檔案太大');
    total += file.content.byteLength;
    if (total > IMPORT_CONFIG_TOTAL_MAX_BYTES) throw refuse('import-size', '匯入的內容太大，請分批匯入');
    const segments = relPathSegments(relPath);
    // Our own temp-file names are reserved inside the config dir.
    if (segments.some((segment) => segment.includes('.smurg-'))) throw refuse('import-path', '檔名不可包含 .smurg-');
    const key = segments.map(foldPathName).join('/');
    if (folded.has(key)) throw refuse('import-duplicate', '有兩個檔名在不分大小寫的檔案系統上相同');
    folded.set(key, relPath);
    out.push({ relPath, content: file.content });
  }
  // A path may not be both a file and a directory of another path ("commands/a" and "commands/a/b.md").
  for (const key of folded.keys()) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (folded.has(parts.slice(0, i).join('/'))) throw refuse('import-duplicate', '檔案與資料夾名稱衝突');
    }
  }
  return out;
}

/**
 * Writes validated files into `cfgDir` (a quarantined guest config dir: nobody else can write it meanwhile). Every
 * directory component is made a real directory (planted symlinks and files are replaced, not followed); files are
 * staged as temp files first and renamed into place only when all of them were written.
 */
export async function writeImport(cfgDir: string, files: readonly ImportFile[]): Promise<string[]> {
  const staged: { tmp: string; target: string }[] = [];
  try {
    for (const file of files) {
      const segments = relPathSegments(file.relPath);
      let dir = cfgDir;
      for (const segment of segments.slice(0, -1)) dir = await ensureRealDir(dir, segment);
      const name = segments[segments.length - 1] as string;
      const tmp = join(dir, `.${name}.smurg-${randomBytes(6).toString('hex')}.tmp`);
      const handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      staged.push({ tmp, target: join(dir, name) });
      try {
        await handle.writeFile(file.content);
      } finally {
        await handle.close();
      }
    }
  } catch (err) {
    await Promise.all(staged.map((entry) => unlink(entry.tmp).catch(() => {})));
    throw err;
  }
  for (const entry of staged) {
    const existing = await lstat(entry.target).catch(() => null);
    if (existing?.isDirectory()) await rm(entry.target, { recursive: true, force: true });
    await rename(entry.tmp, entry.target);
  }
  return files.map((file) => file.relPath);
}
