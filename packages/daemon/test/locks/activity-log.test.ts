// activity.jsonl after a crash (review REL-02): a torn last line must not swallow the next event appended.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityEvent } from '@smurg/protocol';
import { silentLogger } from '../../src/core/logger.ts';
import { ActivityLogFile } from '../../src/locks/activity-log.ts';
import { createTempDir, removeTempDir } from '../../src/testing/index.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

const event = (id: string, at: number): ActivityEvent => ({ id, at, actor: { kind: 'system' }, kind: 'external.change', summary: `event ${id}` });

describe('activity.jsonl with a torn last line (review REL-02)', () => {
  it('the first event after a restart is not glued onto the torn line: it is stored and read back', async () => {
    const dir = await createTempDir('activity-torn');
    dirs.push(dir);
    const path = join(dir, 'activity.jsonl');
    // One complete event, then a crash in the middle of writing the next one.
    await writeFile(path, `${JSON.stringify(event('ev_before', 1_000))}\n{"id":"ev_torn","at":2000,"act`, { mode: 0o600 });
    const log = new ActivityLogFile(path, { log: silentLogger });
    log.append(event('ev_after', 3_000));
    const events = await log.query({ limit: 10 });
    expect(events.map((e) => e.id)).toEqual(['ev_after', 'ev_before']);
    await log.close();
    const lines = (await readFile(path, 'utf8')).split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines.filter((l) => l.includes('ev_after'))).toEqual([JSON.stringify(event('ev_after', 3_000))]);
  });
});
