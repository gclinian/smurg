// 「匯入個人設定」 planning (SPEC R4): where each picked file goes, what is skipped and why, and the split of a big
// import into session.importConfig requests under the per-request caps.
import { describe, expect, it } from 'vitest';
import { IMPORT_CONFIG_FILE_MAX_BYTES, IMPORT_CONFIG_MAX_FILES, IMPORT_CONFIG_TOTAL_MAX_BYTES, getMessageSpec } from '@smurg/protocol';
import { IMPORT_MAX_TOTAL_BYTES, IMPORT_MAX_TOTAL_FILES, importPathFor, importTooBig, screenImport, splitImport } from './import-config.ts';

const MiB = 1024 * 1024;

describe('import: where picked files go', () => {
  it('CLAUDE.md goes to the config root; a picked folder becomes commands/ or skills/ whatever its name', () => {
    expect(importPathFor('claude-md', { name: 'my-notes.md' })).toBe('CLAUDE.md');
    expect(importPathFor('commands', { name: 'review.md', webkitRelativePath: 'my-commands/review.md' })).toBe('commands/review.md');
    expect(importPathFor('commands', { name: 'x.md', webkitRelativePath: 'cmds/git/x.md' })).toBe('commands/git/x.md');
    expect(importPathFor('skills', { name: 'SKILL.md', webkitRelativePath: 'skills/pdf/SKILL.md' })).toBe('skills/pdf/SKILL.md');
    expect(importPathFor('skills', { name: 'loose.md' })).toBe('skills/loose.md');
  });

  it('skips system clutter and paths the daemon would refuse; a later pick of the same path wins', () => {
    const { accepted, skipped } = screenImport([
      { relPath: 'CLAUDE.md', size: 10 },
      { relPath: 'commands/.DS_Store', size: 1 },
      { relPath: 'skills/pdf/._SKILL.md', size: 1 },
      { relPath: 'commands/big.md', size: IMPORT_CONFIG_FILE_MAX_BYTES + 1 },
      { relPath: 'settings.json', size: 5 },
      { relPath: 'commands/../../etc/x', size: 5 },
      { relPath: 'CLAUDE.md', size: 20 },
    ]);
    expect(accepted).toEqual([{ relPath: 'CLAUDE.md', size: 20 }]);
    expect(skipped).toEqual([
      { relPath: 'commands/.DS_Store', reason: 'system' },
      { relPath: 'skills/pdf/._SKILL.md', reason: 'system' },
      { relPath: 'commands/big.md', reason: 'too-large' },
      { relPath: 'settings.json', reason: 'not-allowed' },
      { relPath: 'commands/../../etc/x', reason: 'not-allowed' },
    ]);
  });
});

describe('import: split under the size cap (each request all or none)', () => {
  it('keeps each request under the file-count cap', () => {
    const files = Array.from({ length: IMPORT_CONFIG_MAX_FILES * 2 + 3 }, (_, i) => ({ relPath: `commands/c${i}.md`, size: 10 }));
    const batches = splitImport(files);
    expect(batches.map((batch) => batch.length)).toEqual([IMPORT_CONFIG_MAX_FILES, IMPORT_CONFIG_MAX_FILES, 3]);
    expect(batches.flat()).toEqual(files); // in order, nothing lost or repeated
  });

  it('keeps each request under the byte cap', () => {
    const files = Array.from({ length: 20 }, (_, i) => ({ relPath: `skills/s/${i}.md`, size: IMPORT_CONFIG_FILE_MAX_BYTES }));
    const batches = splitImport(files);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(batch.reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(IMPORT_CONFIG_TOTAL_MAX_BYTES);
    expect(batches.flat()).toEqual(files);
    // 7 files of 1 MiB fit one request; the 8th starts the next.
    expect(batches[0]).toHaveLength(Math.floor(IMPORT_CONFIG_TOTAL_MAX_BYTES / IMPORT_CONFIG_FILE_MAX_BYTES));
  });

  it('every request it plans is a valid session.importConfig payload', () => {
    const spec = getMessageSpec('session.importConfig');
    const files = Array.from({ length: 30 }, (_, i) => ({ relPath: `commands/c${i}.md`, size: 512 * 1024, content: new Uint8Array(512 * 1024) }));
    for (const batch of splitImport(files)) {
      expect(spec?.payload.safeParse({ files: batch.map(({ relPath, content }) => ({ relPath, content })) }).success).toBe(true);
    }
  });

  it('refuses a file over the per-file cap (it must have been screened out) and guards against huge picks', () => {
    expect(() => splitImport([{ size: IMPORT_CONFIG_FILE_MAX_BYTES + 1 }])).toThrow(RangeError);
    expect(splitImport([])).toEqual([]);
    expect(importTooBig([{ size: 1 }])).toBe(false);
    expect(importTooBig(Array.from({ length: IMPORT_MAX_TOTAL_FILES + 1 }, () => ({ size: 1 })))).toBe(true);
    expect(importTooBig([{ size: IMPORT_MAX_TOTAL_BYTES - MiB }, { size: 2 * MiB }])).toBe(true);
  });
});
