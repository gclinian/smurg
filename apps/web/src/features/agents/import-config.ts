// 「匯入個人設定」 (SPEC R4): the guest's own CLAUDE.md, commands/** and skills/** are copied into their guest config
// dir on the host with session.importConfig. One request carries at most IMPORT_CONFIG_MAX_FILES files of at most
// IMPORT_CONFIG_FILE_MAX_BYTES and IMPORT_CONFIG_TOTAL_MAX_BYTES in total (one Envelope is ≤ 8 MiB); a bigger import is
// split, and the daemon writes each request all or none. Pure planning here; reading and sending is in the dialog.
import {
  IMPORT_CONFIG_FILE_MAX_BYTES,
  IMPORT_CONFIG_MAX_FILES,
  IMPORT_CONFIG_TOTAL_MAX_BYTES,
  isImportableConfigPath,
  isValidRelPath,
} from '@smurg/protocol';

export type ImportGroup = 'claude-md' | 'commands' | 'skills';

export interface ImportCandidate {
  /** Where it goes in the guest's config dir: `CLAUDE.md`, `commands/…`, `skills/…`. */
  readonly relPath: string;
  readonly size: number;
}

export type SkipReason = 'too-large' | 'not-allowed' | 'system' | 'unreadable';

export interface SkippedFile {
  readonly relPath: string;
  readonly reason: SkipReason;
}

/** Everything one dialog may send at once (a guard against picking a huge folder by mistake). */
export const IMPORT_MAX_TOTAL_FILES = 2_000;
export const IMPORT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);

/**
 * Where a picked file goes. `webkitRelativePath` is `<picked folder>/<rest>`: the picked folder's own name is replaced
 * by the group's (a folder called `my-commands` still lands in `commands/`). A single CLAUDE.md pick is `CLAUDE.md`.
 */
export function importPathFor(group: ImportGroup, file: { readonly name: string; readonly webkitRelativePath?: string }): string {
  if (group === 'claude-md') return 'CLAUDE.md';
  const relative = file.webkitRelativePath && file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name;
  const segments = relative.split('/').filter((segment) => segment !== '');
  const rest = segments.length > 1 ? segments.slice(1) : segments;
  return `${group === 'commands' ? 'commands' : 'skills'}/${rest.join('/')}`;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Refuses what the daemon would refuse anyway (and OS clutter); later picks of the same path replace earlier ones. */
export function screenImport<T extends ImportCandidate>(candidates: readonly T[]): { accepted: T[]; skipped: SkippedFile[] } {
  const byPath = new Map<string, T>();
  const skipped: SkippedFile[] = [];
  for (const candidate of candidates) {
    const name = baseName(candidate.relPath);
    if (SYSTEM_FILES.has(name) || name.startsWith('._')) {
      skipped.push({ relPath: candidate.relPath, reason: 'system' });
      continue;
    }
    if (!isValidRelPath(candidate.relPath) || !isImportableConfigPath(candidate.relPath)) {
      skipped.push({ relPath: candidate.relPath, reason: 'not-allowed' });
      continue;
    }
    if (candidate.size > IMPORT_CONFIG_FILE_MAX_BYTES) {
      skipped.push({ relPath: candidate.relPath, reason: 'too-large' });
      continue;
    }
    byPath.delete(candidate.relPath);
    byPath.set(candidate.relPath, candidate);
  }
  return { accepted: [...byPath.values()], skipped };
}

/**
 * Splits files into requests: each ≤ IMPORT_CONFIG_MAX_FILES files and ≤ IMPORT_CONFIG_TOTAL_MAX_BYTES of content,
 * in order. Files over the per-file cap must have been screened out before (they are refused here too).
 */
export function splitImport<T extends { readonly size: number }>(files: readonly T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const file of files) {
    if (file.size > IMPORT_CONFIG_FILE_MAX_BYTES) throw new RangeError('a file over the per-file import limit');
    if (current.length > 0 && (current.length >= IMPORT_CONFIG_MAX_FILES || bytes + file.size > IMPORT_CONFIG_TOTAL_MAX_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function importTooBig(files: readonly { readonly size: number }[]): boolean {
  return files.length > IMPORT_MAX_TOTAL_FILES || files.reduce((total, file) => total + file.size, 0) > IMPORT_MAX_TOTAL_BYTES;
}
