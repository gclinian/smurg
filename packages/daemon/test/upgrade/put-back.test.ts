// A kept copy put back (DESIGN A7, A9; the security critic's probe P1).
//
// Before a start writes an upgraded document it keeps the file as it was beside it
// (`state.json.before-upgrade-from-0.4.0`). The copy is there to READ what the workspace held. A host who puts it
// back in the place of state.json gets the membership of the day of the upgrade: this smurg takes it for what 0.4.0
// left, upgrades it again, and everything decided since is undone: every kick, every revoked link, every role
// change, every use of a link. That is NOT prevented (the host owns the folder, and after a damaged state.json it may
// be what the host wants). It is SAID: Daemon.putBack is true, the log says what it means, and `smurg host` prints
// it. This test is the documentation of what it undoes.
import { copyFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryLogger } from '../../src/core/logger.ts';
import type { TestDaemon } from '../../src/testing/index.ts';
import { clockAt, deviceKeyOf, freshKey, knock, startOn } from './daemon-on.ts';
import { STAMP_NAME, copyOf, keptCopyName, ledgerOf, readJson, type FixtureCopy, type StoredState } from './fixture.ts';

const DAY = 24 * 60 * 60 * 1000;
let running: TestDaemon | null = null;
const copies: FixtureCopy[] = [];

afterEach(async () => {
  await running?.cleanup().catch(() => {});
  running = null;
  for (const copy of copies.splice(0)) await copy.remove().catch(() => {});
});
async function stop(): Promise<void> {
  await running?.cleanup();
  running = null;
}

describe('a kept copy put back after later decisions', { timeout: 60_000 }, () => {
  it('is said to be put back, and undoes every kick, revoked link, role change and used-up link since (documented, not prevented)', async () => {
    const copy = await copyOf('0.4.0');
    copies.push(copy);
    const ledger = ledgerOf('0.4.0');
    const link = (label: string): string => ledger.invites[label]?.url as string;
    const kept = join(copy.workspaceDir, keptCopyName('state', '0.4.0'));
    const gina = await deviceKeyOf(copy, 'gina');
    const carol = await deviceKeyOf(copy, 'carol');
    const zed = freshKey();

    // ---- The day of the upgrade.
    let t = (running = await startOn(copy));
    expect(t.daemon.upgraded.map((entry) => entry.document)).toEqual(['state', 'suggestions']);
    expect(t.daemon.putBack).toBe(false);
    const keptBytes = await readFile(kept);
    const keptMtime = (await stat(kept)).mtimeMs;

    // ---- Weeks of ordinary use. A new person uses the one-time link for Agent access; the host (in the console, as
    // the host does it) later removes them, removes Gina (an Editor since 0.4.0), revokes a link that was never used
    // and makes Carol a Viewer.
    expect(knock(t, { userId: 'dev:zed', key: zed, link: link('unused-agent-1use') })).toBe('in as agent');
    const host = await t.connectHost();
    await host.conn.request('admin.member.kick', { userId: 'dev:zed' });
    await host.conn.request('admin.member.kick', { userId: 'dev:gina' });
    await host.conn.request('admin.invite.revoke', { inviteId: ledger.invites['unused-editor-3uses']?.id as string });
    await host.conn.request('admin.member.setRole', { userId: 'dev:carol', role: 'viewer' });
    host.close();
    const decided = (): void => {
      expect(knock(t, { userId: 'dev:gina', key: gina }), 'Gina, removed').toBe('refused: device-revoked');
      expect(knock(t, { userId: 'dev:zed', key: zed }), 'Zed, removed').toBe('refused: device-revoked');
      expect(knock(t, { userId: 'dev:mallory', key: freshKey(), link: link('unused-agent-1use') }), 'the used-up link').toBe('refused: invite-invalid');
      expect(knock(t, { userId: 'dev:mallory', key: freshKey(), link: link('unused-editor-3uses') }), 'the revoked link').toBe('refused: invite-invalid');
      expect(knock(t, { userId: 'dev:carol', key: carol }), 'Carol, now a Viewer').toBe('in as viewer');
    };
    decided();
    await stop();
    const decidedState = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
    expect(decidedState.members.find((member) => member.userId === 'dev:gina')?.status).toBe('kicked');

    // ---- An ordinary restart keeps every one of those decisions, and nothing is "put back".
    t = running = await startOn(copy);
    expect(t.daemon.putBack).toBe(false);
    expect(t.daemon.upgraded).toEqual([]);
    decided();
    await stop();

    // ---- Three days later (the links of the fixture's story live for a week) the host puts the kept copy in the
    // place of state.json.
    await copyFile(kept, join(copy.workspaceDir, 'state.json'));
    const log = createMemoryLogger();
    const clock = clockAt(copy.at + 3 * DAY);
    const putBackAt = clock.now();
    t = running = await startOn(copy, { log, clock });

    // It is SAID: the terminal line is made of these two, and the host's log has the sentence.
    expect(t.daemon.putBack).toBe(true);
    expect(t.daemon.upgraded).toEqual([{ document: 'state', from: '0.4.0', copy: kept }]);
    expect(t.daemon.internals.folder.stamp).toMatchObject({ shapes: 1 });
    const said = log.lines.filter((line) => line.level === 'warn' && /OLDER state file was put back/.test(line.message));
    expect(said).toHaveLength(1);
    expect(said[0]?.message).toMatch(/kicks, revoked devices and links, role changes, used-up links/);
    expect(said[0]?.fields).toMatchObject({ documents: 'state' });
    // The copy itself is never written over: it still is the file of the day of the upgrade.
    expect((await readFile(kept)).equals(keptBytes)).toBe(true);
    expect((await stat(kept)).mtimeMs).toBe(keptMtime);
    expect(await readJson(join(copy.workspaceDir, STAMP_NAME))).toMatchObject({ shapes: 1 });

    // ---- What it undoes. Every line below was refused (or was a Viewer) a moment ago.
    expect(knock(t, { userId: 'dev:gina', key: gina }), 'Gina is back, with the key the host revoked').toBe('in as editor');
    expect(knock(t, { userId: 'dev:carol', key: carol }), 'Carol has Agent access again').toBe('in as agent');
    expect(knock(t, { userId: 'dev:mallory', key: freshKey(), link: link('unused-agent-1use') }), 'a stranger gets Agent access through the link Zed used up').toBe('in as agent');
    expect(knock(t, { userId: 'dev:trudy', key: freshKey(), link: link('unused-editor-3uses') }), 'a stranger gets in through the link the host revoked').toBe('in as editor');
    // And what was added since is gone too: the workspace of that day never heard of Zed.
    expect(t.ctx.members.get('dev:zed')).toBeNull();
    expect(knock(t, { userId: 'dev:zed', key: zed })).toBe('refused: device-revoked');
    // No audit entry says that a kick was undone (the audit actions are a closed list of the wire): since the copy
    // was put back the log holds the start's own entries and the knocks above, and the line on the host's terminal
    // and in the host's log is all there is.
    await t.ctx.audit.flush();
    const since = (await t.ctx.audit.query({ limit: 500 })).filter((entry) => entry.at >= putBackAt);
    expect(since.length).toBeGreaterThan(0);
    expect(since.filter((entry) => /^(member|device)\.|^invite\.revoke$|^settings\./.test(entry.action))).toEqual([]);
  });
});
