// The tool gate's refusals in the audit log (DESIGN §3.14 `permission.auto-deny`): one entry per session, gate row and
// minute, with a count, however often an agent tries.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST, MEI, auditOf, openDiscussion, openSession, startStack, waitFor } from './support.ts';

describe('permission.auto-deny', { timeout: 60_000 }, () => {
  it('one entry per session, row and minute, with a count', async () => {
    const s = await startStack();
    const discussion = await openDiscussion(s, MEI);
    const other = await openSession(s, HOST);
    for (let i = 0; i < 40; i += 1) s.fakes.agents.gateDenied(discussion.id, { tool: 'Bash', row: 'G2' });
    s.fakes.agents.gateDenied(discussion.id, { tool: 'WebFetch', row: 'G2' });
    s.fakes.agents.gateDenied(discussion.id, { tool: 'Edit', row: 'G6', path: 'src/app.ts' });
    s.fakes.agents.gateDenied(other.id, { tool: 'Edit', row: 'G3', path: '/Users/ian/project/.claude/settings.json' });
    // Nothing yet: the minute is not over and no turn ended.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await auditOf(s, 'permission.auto-deny')).toEqual([]);
    // The minute is over: the sweep writes one entry per session and row.
    s.t.advanceClock(60_000);
    await waitFor(async () => (await auditOf(s, 'permission.auto-deny')).length === 3, { what: 'the three entries' });
    const entries = await auditOf(s, 'permission.auto-deny');
    expect(entries.map((entry) => [entry.actor.kind, entry.outcome, entry.target, entry.detail?.['row'], entry.detail?.['count']])).toEqual([
      ['system', 'denied', discussion.id, 'G2', 41],
      ['system', 'denied', discussion.id, 'G6', 1],
      ['system', 'denied', other.id, 'G3', 1],
    ]);
    expect(entries[0]?.detail).toMatchObject({ sessionId: discussion.id, tools: ['Bash', 'WebFetch'] });
    expect(entries[1]?.detail).toMatchObject({ path: 'src/app.ts' });
    // An absolute path of the host never enters the log.
    expect(entries[2]?.detail?.['path']).toBeUndefined();
    // The next minute is a new entry.
    s.fakes.agents.gateDenied(discussion.id, { tool: 'Bash', row: 'G2' });
    s.t.advanceClock(60_000);
    await waitFor(async () => (await auditOf(s, 'permission.auto-deny')).length === 4, { what: 'the next minute\'s entry' });
  });

  it('the end of the turn, the end of the session and a stop of the daemon write what was counted', async () => {
    const s = await startStack();
    const session = await openSession(s, MEI);
    s.fakes.agents.startTurn(session.id);
    s.fakes.agents.gateDenied(session.id, { tool: 'Bash', row: 'G2' });
    s.fakes.agents.gateDenied(session.id, { tool: 'Bash', row: 'G2' });
    s.fakes.agents.finishTurn(session.id);
    expect((await auditOf(s, 'permission.auto-deny')).map((entry) => entry.detail?.['count'])).toEqual([2]);
    s.fakes.agents.gateDenied(session.id, { tool: 'Task', row: 'G2' });
    await s.host.conn.request('session.end', { sessionId: session.id });
    expect((await auditOf(s, 'permission.auto-deny')).map((entry) => entry.detail?.['count'])).toEqual([2, 1]);
    const last = await openSession(s, MEI);
    s.fakes.agents.gateDenied(last.id, { tool: 'Bash', row: 'G5' });
    await s.t.daemon.stop();
    // (The log is closed with the daemon: read what it wrote.)
    const written = (await readFile(join(s.t.ctx.state.dir, 'audit.jsonl'), 'utf8')).split('\n').filter((line) => line.includes('"permission.auto-deny"'));
    expect(written.map((line) => (JSON.parse(line) as { detail: { row: string } }).detail.row).sort()).toEqual(['G2', 'G2', 'G5']);
  });
});
