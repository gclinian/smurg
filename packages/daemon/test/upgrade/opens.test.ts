// What a PUBLISHED smurg wrote opens (docs/ARCHITECTURE.md: everything a published smurg wrote is read by every later
// version; nothing is reset, nothing is dropped without a word).
//
// For each fixture under test/fixtures/published/ (written by the real code of that version): a copy, the clock at the
// fixture's instant, and the daemon of this tree started on it. 0.5.0 refused the 0.4.0 fixture at state.json
// ("settings.maxLiveAgents: Invalid input: expected number, received undefined; …") and told the host to move the
// folder away: run in a tree of tag v0.5.0, every test of the 0.4.0 fixture here fails with exactly that refusal.
//
// The expectations are of two kinds, on purpose. What a file HELD is read from the copy before the start, by this
// test, as plain JSON (never through the daemon's schemas). What that MEANS for people is written out below as the
// fixture's story (who was removed, which device was revoked, which link was used up): a daemon that agrees with
// itself and is wrong does not pass.
import { readFile, readdir, stat } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { toHex } from '@smurg/protocol';
import { readPinnedDaemonKey } from '@smurg/protocol/node';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultMaxLiveAgents } from '../../src/core/config.ts';
import { DAEMON_VERSION } from '../../src/daemon.ts';
import type { TestDaemon } from '../../src/testing/index.ts';
import { deviceKeyOf, freshKey, inviteIdHexOfLink, knock, publicKeyIn, startOn } from './daemon-on.ts';
import { PUBLISHED_VERSIONS, STAMP_NAME, copyOf, keptCopyName, ledgerOf, mtimesOf, readJson, sha256Of, snapshotOf, type FixtureCopy, type FixtureVariantName, type PublishedVersion, type StoredState } from './fixture.ts';

let running: TestDaemon | null = null;
const copies: FixtureCopy[] = [];

afterEach(async () => {
  await running?.cleanup().catch(() => {});
  running = null;
  for (const copy of copies.splice(0)) await copy.remove().catch(() => {});
});

async function fresh(version: PublishedVersion, variant: FixtureVariantName = 'stopped'): Promise<FixtureCopy> {
  const copy = await copyOf(version, variant);
  copies.push(copy);
  return copy;
}
async function start(copy: FixtureCopy): Promise<TestDaemon> {
  running = await startOn(copy);
  return running;
}
async function stop(): Promise<void> {
  await running?.cleanup();
  running = null;
}

/** Every `<name>.json` directly in the workspace folder, parsed as plain JSON, with the bytes it had. */
async function storedDocuments(copy: FixtureCopy): Promise<Map<string, { readonly value: unknown; readonly bytes: Buffer }>> {
  const out = new Map<string, { value: unknown; bytes: Buffer }>();
  for (const name of (await readdir(copy.workspaceDir)).sort()) {
    if (!name.endsWith('.json') || name === STAMP_NAME) continue;
    const bytes = await readFile(join(copy.workspaceDir, name));
    out.set(name.slice(0, -'.json'.length), { value: JSON.parse(bytes.toString('utf8')), bytes });
  }
  return out;
}

/** What phase 1 of the running daemon's start read: every declared document that existed, in today's shape. */
function loadedOf(t: TestDaemon): ReadonlyMap<string, { readonly value: unknown; readonly upgradedFrom: string | null }> {
  return t.daemon.internals.folder.loaded;
}

// =====================================================================================================================
// What each fixture's files must become. The only shapes that differ from today's are 0.4.0's state.json and
// suggestions.json (DESIGN A3, A4); everything else every published smurg wrote is today's shape as it is.
// =====================================================================================================================

/** The values the step from 0.4.0 adds to the settings: constants of the step (the closed side), and this machine's default. */
const SETTINGS_ADDED_FROM_V040 = { maxLiveAgents: defaultMaxLiveAgents(totalmem()), escalateAfterMs: 300_000, agentMcp: false } as const;

interface Upgrades {
  /** The documents a start upgrades, with the published version whose shape the file has. */
  readonly from: Readonly<Record<string, string>>;
  /** What a stored document must be once it is loaded: the file as it was, and exactly this on top. */
  expected(name: string, stored: unknown): unknown;
}
const UPGRADES: Readonly<Record<PublishedVersion, Upgrades>> = {
  '0.4.0': {
    from: { state: '0.4.0', suggestions: '0.4.0' },
    expected(name, stored) {
      if (name === 'state') {
        const state = stored as { settings: Record<string, unknown> };
        return { ...state, settings: { ...state.settings, ...SETTINGS_ADDED_FROM_V040 } };
      }
      if (name === 'suggestions') {
        const document = stored as { suggestions: Record<string, unknown>[] };
        return { ...document, suggestions: document.suggestions.map((entry) => ({ ...entry, origin: 'source' in entry ? 'selection' : 'composer' })) };
      }
      return stored;
    },
  },
  '0.5.0': { from: {}, expected: (_name, stored) => stored },
};

// =====================================================================================================================
// The story of each fixture (its README and ledger.json), as far as the door is concerned
// =====================================================================================================================

interface Story {
  /** `devices/<label>` whose key is a registered, unrevoked device of an active member: the role they come in with. */
  readonly in: Readonly<Record<string, { readonly userId: string; readonly role: string }>>;
  /** The member who uses the command (`cli-member/device.key`). */
  readonly cliMember: { readonly userId: string; readonly role: string };
  /** Members who were removed, with the label of the device they had. */
  readonly removed: Readonly<Record<string, string>>;
  /** Revoked devices of people who are still members (they came back on another device). */
  readonly revokedDevices: Readonly<Record<string, string>>;
  /** Devices that never got in. */
  readonly strangers: readonly string[];
  /** Ledger links a new person can still use, with the role they give and how many more people each admits (null: no limit). */
  readonly usable: Readonly<Record<string, { readonly role: string; readonly left: number | null }>>;
  /** Ledger links that must stay refused: used up, revoked, expired. */
  readonly dead: Readonly<Record<string, 'used-up' | 'revoked' | 'expired'>>;
  /** A link made before the removals that still has room: a removed member must not come back through it. */
  readonly linkFromBeforeTheRemovals: string;
}

const STORIES: Readonly<Record<PublishedVersion, Story>> = {
  '0.4.0': {
    in: {
      'host-console': { userId: 'dev:host', role: 'host' },
      amy: { userId: 'dev:amy', role: 'editor' },
      'amy-phone': { userId: 'dev:amy', role: 'editor' },
      bob: { userId: 'dev:bob', role: 'viewer' },
      carol: { userId: 'dev:carol', role: 'agent' },
      dave: { userId: 'dev:dave', role: 'agent' },
      'frank-phone': { userId: 'dev:frank', role: 'editor' },
      gina: { userId: 'dev:gina', role: 'editor' },
    },
    cliMember: { userId: 'dev:ivan', role: 'agent' },
    removed: { 'dev:erin': 'erin' },
    revokedDevices: { 'frank-laptop': 'dev:frank' },
    strangers: ['mallory'],
    usable: {
      'unused-editor-3uses': { role: 'editor', left: 3 },
      'unused-viewer-nolimit-30d': { role: 'viewer', left: null },
      'unused-agent-1use': { role: 'agent', left: 1 },
      'multi-editor-5uses': { role: 'editor', left: 3 },
    },
    dead: {
      'bob-viewer-1use': 'used-up',
      'carol-agent-1use': 'used-up',
      'dave-agent-1use': 'used-up',
      'ivan-agent-cli-1use': 'used-up',
      'frank-editor-rejoin-1use': 'used-up',
      'gina-viewer-2uses-then-revoked': 'revoked',
      'revoked-unused-editor': 'revoked',
      'expired-editor-8s': 'expired',
    },
    linkFromBeforeTheRemovals: 'multi-editor-5uses',
  },
  '0.5.0': {
    in: {
      host: { userId: 'dev:host', role: 'host' },
      amy: { userId: 'dev:amy', role: 'editor' },
      'amy-2': { userId: 'dev:amy', role: 'editor' },
      bob: { userId: 'dev:bob', role: 'viewer' },
      dave: { userId: 'dev:dave', role: 'agent' },
      'frank-2': { userId: 'dev:frank', role: 'editor' },
      gina: { userId: 'dev:gina', role: 'editor' },
      kate: { userId: 'dev:kate', role: 'agent' },
      leo: { userId: 'dev:leo', role: 'viewer' },
      mei: { userId: 'dev:mei', role: 'agent' },
      noa: { userId: 'dev:noa', role: 'agent' },
      olga: { userId: 'dev:olga', role: 'viewer' },
      quinn: { userId: 'dev:quinn', role: 'editor' },
      ruth: { userId: 'dev:ruth', role: 'agent' },
    },
    cliMember: { userId: 'github:12345', role: 'agent' },
    removed: { 'dev:erin': 'erin', 'dev:pete': 'pete', 'dev:sam': 'sam' },
    revokedDevices: { frank: 'dev:frank' },
    strangers: ['mallory', 'mallory-2', 'mallory-3'],
    usable: {
      'unused-editor-3uses': { role: 'editor', left: 3 },
      'unused-viewer-nolimit-30d': { role: 'viewer', left: null },
      'unused-agent-1use': { role: 'agent', left: 1 },
      'cli-member-agent-1use': { role: 'agent', left: 1 },
      'agents-3uses': { role: 'agent', left: 1 },
      'multi-editor-5uses': { role: 'editor', left: 2 },
    },
    dead: {
      'bob-viewer-1use': 'used-up',
      'kate-agent-1use': 'used-up',
      'dave-agent-1use': 'used-up',
      'ruth-agent-1use': 'used-up',
      'frank-editor-rejoin-1use': 'used-up',
      'sam-agent-1use': 'used-up',
      'gina-viewer-2uses-then-revoked': 'revoked',
      'revoked-unused-editor': 'revoked',
      'expired-editor-6s': 'expired',
    },
    linkFromBeforeTheRemovals: 'multi-editor-5uses',
  },
};

describe.each(PUBLISHED_VERSIONS)('what smurg %s wrote opens', { timeout: 60_000 }, (version) => {
  const upgrades = UPGRADES[version];
  const story = STORIES[version];
  const ledger = ledgerOf(version);
  const linkOf = (label: string): string => {
    const entry = ledger.invites[label];
    if (entry === undefined) throw new Error(`the ledger of ${version} has no invite ${label}`);
    return entry.url;
  };

  it.each(['stopped', 'running'] as const)('the documents as loaded and upgraded hold what the files held (%s)', async (variant) => {
    const copy = await fresh(version, variant);
    const stored = await storedDocuments(copy);
    expect(stored.size).toBeGreaterThanOrEqual(5);
    const t = await start(copy);

    const loaded = loadedOf(t);
    // Every document the published version left is one this smurg declares and read: none is passed over.
    expect([...loaded.keys()].sort()).toEqual([...stored.keys()].sort());
    for (const [name, file] of stored) {
      const document = loaded.get(name);
      expect(document?.upgradedFrom ?? null, `${name}.json: the shape the file had`).toBe(upgrades.from[name] ?? null);
      expect(document?.value, `${name}.json as loaded`).toEqual(upgrades.expected(name, file.value));
    }
    // What the terminal line is made of.
    expect(t.daemon.upgraded).toEqual(Object.entries(upgrades.from).map(([document, from]) => ({ document, from, copy: join(copy.workspaceDir, keptCopyName(document, from)) })));
    expect(t.daemon.putBack).toBe(false);
  });

  it('the same workspace under the same key: the id, the daemon key every member pinned, the settings the host chose', async () => {
    const copy = await fresh(version);
    const before = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
    const t = await start(copy);
    expect(t.daemon.workspaceId).toBe(copy.workspaceId);
    // The pins teammates hold (written by the published version's own client code) still name this daemon.
    const pins = [copy.cliMemberHome, ...Object.keys(story.in).map((label) => join(copy.devices, label))];
    for (const home of pins) expect(toHex((await readPinnedDaemonKey(home, copy.workspaceId)) as Uint8Array), `the pin in ${home}`).toBe(toHex(t.daemon.daemonPublicKey));
    // Every setting the host chose is the one in force; what the step adds is closed (agents get no MCP servers of the host's).
    expect(t.ctx.settings.get()).toEqual({ ...(version === '0.4.0' ? SETTINGS_ADDED_FROM_V040 : {}), ...before.settings });
    if (version === '0.4.0') expect(t.ctx.settings.get().agentMcp).toBe(false);
    // Every member with their role and status, removed ones included.
    for (const member of before.members) expect(t.ctx.members.get(member.userId), member.userId).toMatchObject({ role: member.role, status: member.status, displayName: member.displayName });
    expect(before.members.filter((member) => member.status === 'kicked').map((member) => member.userId).sort()).toEqual(Object.keys(story.removed).sort());
  });

  describe('at the door (admitConnection), with the keys and links the people of the fixture really held', () => {
    it('every member comes back in on their own device, with their role and no invite', async () => {
      const copy = await fresh(version);
      const t = await start(copy);
      for (const [label, who] of Object.entries(story.in)) expect(knock(t, { userId: who.userId, key: await deviceKeyOf(copy, label) }), label).toBe(`in as ${who.role}`);
      expect(knock(t, { userId: story.cliMember.userId, key: await publicKeyIn(copy.cliMemberHome), clientKind: 'cli' }), 'the member who uses the command').toBe(`in as ${story.cliMember.role}`);
    });

    it('a removed member stays out: with their old key, with their old key and a link that still has room, and with a new key and a link from before they were removed', async () => {
      const copy = await fresh(version);
      const stored = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
      const t = await start(copy);
      const oldLink = linkOf(story.linkFromBeforeTheRemovals);
      const usesBefore = t.ctx.invites.get(ledger.invites[story.linkFromBeforeTheRemovals]?.id as string)?.uses;
      expect(Object.keys(story.removed).length).toBeGreaterThan(0);
      for (const [userId, label] of Object.entries(story.removed)) {
        const key = await deviceKeyOf(copy, label);
        // The fixture really holds this: a removed member whose device is revoked.
        expect(stored.members.find((member) => member.userId === userId)?.status, userId).toBe('kicked');
        expect(stored.devices.find((device) => device.publicKeyHex === toHex(key)), label).toMatchObject({ userId, revoked: true });
        expect(knock(t, { userId, key }), `${userId}, old key`).toBe('refused: device-revoked');
        expect(knock(t, { userId, key, link: oldLink }), `${userId}, old key, a link with room`).toBe('refused: device-revoked');
        expect(knock(t, { userId, key: freshKey(), link: oldLink }), `${userId}, new key, a link from before the removal`).toBe('refused: kicked');
        expect(knock(t, { userId, key: freshKey() }), `${userId}, new key, no link`).toBe('refused: device-revoked');
        expect(t.ctx.members.get(userId)?.status).toBe('kicked');
      }
      // None of these attempts used the link up for the people it was made for.
      expect(t.ctx.invites.get(ledger.invites[story.linkFromBeforeTheRemovals]?.id as string)?.uses).toBe(usesBefore);
    });

    it('a revoked device stays out, also when its owner is a member again on another device; a device that never joined stays out', async () => {
      const copy = await fresh(version);
      const stored = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
      const t = await start(copy);
      expect(Object.keys(story.revokedDevices).length).toBeGreaterThan(0);
      for (const [label, userId] of Object.entries(story.revokedDevices)) {
        const key = await deviceKeyOf(copy, label);
        expect(stored.devices.find((device) => device.publicKeyHex === toHex(key)), label).toMatchObject({ userId, revoked: true });
        expect(stored.members.find((member) => member.userId === userId)?.status, userId).toBe('active');
        expect(knock(t, { userId, key }), label).toBe('refused: device-revoked');
        // Not through a link either: a revoked key is refused before the invite is looked at.
        expect(knock(t, { userId, key, link: linkOf(story.linkFromBeforeTheRemovals) }), `${label} with a link`).toBe('refused: device-revoked');
      }
      for (const label of story.strangers) {
        const key = await deviceKeyOf(copy, label);
        expect(stored.devices.some((device) => device.publicKeyHex === toHex(key)), label).toBe(false);
        expect(knock(t, { userId: `dev:${label}`, key }), label).toBe('refused: device-revoked');
      }
      // The whole list of revoked devices in the file is still the whole list of revoked devices.
      const revoked = stored.devices.filter((device) => device.revoked).map((device) => device.deviceId).sort();
      expect(revoked.length).toBe(Object.keys(story.removed).length + Object.keys(story.revokedDevices).length);
      expect(stored.devices.map((device) => device.userId).filter((userId, index, all) => all.indexOf(userId) === index).flatMap((userId) => t.daemon.internals.members.devicesOf(userId)).filter((device) => device.revoked).map((device) => device.deviceId).sort()).toEqual(revoked);
    });

    it('used-up, revoked and expired links stay refused, and nobody is added by trying', async () => {
      const copy = await fresh(version);
      const stored = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
      const t = await start(copy);
      const membersBefore = t.ctx.members.list({ includeKicked: true }).length;
      for (const [label, why] of Object.entries(story.dead)) {
        const link = linkOf(label);
        // The fixture really holds this link in this state, at the fixture's instant.
        const record = stored.invites.find((invite) => invite.keyIdHex === inviteIdHexOfLink(link));
        expect(record, label).toBeDefined();
        const state = record?.revoked ? 'revoked' : record?.expiresAt !== undefined && record.expiresAt <= copy.at ? 'expired' : record?.maxUses !== undefined && record.uses >= record.maxUses ? 'used-up' : 'usable';
        expect(state, label).toBe(why);
        expect(knock(t, { userId: `dev:stranger-${label}`, key: freshKey(), link }), label).toBe('refused: invite-invalid');
        expect(t.ctx.invites.get(record?.id as string), label).toMatchObject({ uses: record?.uses, revoked: record?.revoked });
      }
      expect(t.ctx.members.list({ includeKicked: true }).length).toBe(membersBefore);
      // Every dead link of the file is covered, except those whose secret nobody wrote down (the host's own links).
      const deadInFile = stored.invites.filter((invite) => invite.revoked || (invite.expiresAt !== undefined && invite.expiresAt <= copy.at) || (invite.maxUses !== undefined && invite.uses >= invite.maxUses));
      const inLedger = new Set(Object.values(ledger.invites).map((entry) => entry.id));
      expect(deadInFile.filter((invite) => inLedger.has(invite.id)).length).toBe(Object.keys(story.dead).length);
    });

    it('an unused link, and a link with uses left, admit a new person with the link\'s role, as many as it has left and no more', async () => {
      const copy = await fresh(version);
      const stored = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
      const t = await start(copy);
      let person = 0;
      for (const [label, { role, left }] of Object.entries(story.usable)) {
        const link = linkOf(label);
        const record = stored.invites.find((invite) => invite.keyIdHex === inviteIdHexOfLink(link));
        expect(record, label).toMatchObject({ role, revoked: false });
        expect(record?.maxUses === undefined ? null : record.maxUses - record.uses, `${label}: uses left in the file`).toBe(left);
        for (let i = 0; i < (left ?? 2); i++) {
          const userId = `dev:new-${++person}`;
          expect(knock(t, { userId, key: freshKey(), link }), `${label}, person ${i + 1}`).toBe(`in as ${role}`);
          expect(t.ctx.members.get(userId)).toMatchObject({ role, status: 'active' });
        }
        if (left !== null) expect(knock(t, { userId: `dev:late-${label}`, key: freshKey(), link }), `${label}, one too many`).toBe('refused: invite-invalid');
        expect(t.ctx.invites.get(record?.id as string)?.uses, label).toBe((record?.uses as number) + (left ?? 2));
      }
    });
  });

  it('the suggestions are carried: every one, with its text, its author, its state and what it was written about', async () => {
    const copy = await fresh(version);
    const stored = (await readJson<{ suggestions: Record<string, unknown>[] }>(join(copy.workspaceDir, 'suggestions.json'))).suggestions;
    expect(stored.length).toBeGreaterThanOrEqual(7);
    const t = await start(copy);
    const loaded = (loadedOf(t).get('suggestions')?.value as { suggestions: Record<string, unknown>[] }).suggestions;
    expect(loaded.map((entry) => entry['id'])).toEqual(stored.map((entry) => entry['id']));
    for (const [index, before] of stored.entries()) {
      const { origin, ...rest } = loaded[index] as Record<string, unknown>;
      expect(rest, String(before['id'])).toEqual(Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'origin')));
      // 0.4.0 knew two ways to write a suggestion: about a selection of code, or in the box below a session.
      expect(origin, String(before['id'])).toBe(before['origin'] ?? ('source' in before ? 'selection' : 'composer'));
    }
    if (version === '0.4.0') expect(loaded.map((entry) => entry['origin'])).toEqual(['composer', 'composer', 'selection', 'composer', 'composer', 'composer', 'composer']);
    await stop();
    // On disk after the start, in today's shape: still every one of them (a start closes a suggestion whose session is
    // gone; it never removes one).
    const after = (await readJson<{ suggestions: Record<string, unknown>[] }>(join(copy.workspaceDir, 'suggestions.json'))).suggestions;
    expect(after.map((entry) => `${String(entry['id'])}|${String(entry['text'])}|${String(entry['origin'])}`)).toEqual(loaded.map((entry) => `${String(entry['id'])}|${String(entry['text'])}|${String(entry['origin'])}`));
  });

  it('what was still pending when the daemon died (running): the step leaves it pending; the start then closes it as every start does', async () => {
    const copy = await fresh(version, 'running');
    const stored = (await readJson<{ suggestions: { id: string; status: string }[] }>(join(copy.workspaceDir, 'suggestions.json'))).suggestions;
    const pending = stored.filter((entry) => entry.status === 'pending').map((entry) => entry.id);
    expect(pending.length).toBeGreaterThanOrEqual(2);
    const t = await start(copy);
    const loaded = (loadedOf(t).get('suggestions')?.value as { suggestions: { id: string; status: string }[] }).suggestions;
    expect(loaded.filter((entry) => entry.status === 'pending').map((entry) => entry.id)).toEqual(pending);
  });

  it('the kept copies are byte for byte the old files, private, and only where a step ran; the stamp names this smurg', async () => {
    const copy = await fresh(version);
    const stored = await storedDocuments(copy);
    const t = await start(copy);
    const names = await readdir(copy.workspaceDir);
    expect(names.filter((name) => name.includes('.before-upgrade-from-')).sort()).toEqual(Object.entries(upgrades.from).map(([document, from]) => keptCopyName(document, from)).sort());
    for (const [document, from] of Object.entries(upgrades.from)) {
      const path = join(copy.workspaceDir, keptCopyName(document, from));
      const kept = await readFile(path);
      expect(sha256Of(kept), `${document}: the kept copy`).toBe(sha256Of(stored.get(document)?.bytes as Buffer));
      expect(kept.equals(stored.get(document)?.bytes as Buffer)).toBe(true);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      // The document itself is in today's shape on disk now, in this start (not at its next change).
      expect(await readJson(join(copy.workspaceDir, `${document}.json`)), `${document}.json on disk`).not.toEqual(stored.get(document)?.value);
    }
    expect(await readJson(join(copy.workspaceDir, STAMP_NAME))).toEqual({ smurg: DAEMON_VERSION, shapes: 1, at: expect.any(Number) });
    expect((await stat(join(copy.workspaceDir, STAMP_NAME))).mode & 0o777).toBe(0o600);
    expect(Math.abs((await readJson<{ at: number }>(join(copy.workspaceDir, STAMP_NAME))).at - copy.at)).toBeLessThan(60_000);
    expect(t.daemon.internals.folder.stamp).toBeNull(); // no published smurg before this one stamped a folder
  });

  it('a second start runs no step, writes no document again because of an upgrade and makes no second copy', async () => {
    const copy = await fresh(version);
    await start(copy);
    await stop();
    const names = (await readdir(copy.workspaceDir)).sort();
    const keptNames = names.filter((name) => name.includes('.before-upgrade-from-'));
    const keptBefore = new Map(await Promise.all(keptNames.map(async (name) => [name, { bytes: await readFile(join(copy.workspaceDir, name)), mtimeMs: (await stat(join(copy.workspaceDir, name))).mtimeMs }] as const)));
    const mtimesBefore = await mtimesOf(copy.workspaceDir);
    const onDisk = await storedDocuments(copy);

    const again = await start(copy);
    expect(again.daemon.upgraded).toEqual([]);
    expect(again.daemon.putBack).toBe(false);
    expect([...loadedOf(again).entries()].filter(([, document]) => document.upgradedFrom !== null).map(([name]) => name)).toEqual([]);
    // What the first start wrote is what the second one read: today's shapes, file for file.
    for (const [name, file] of onDisk) expect(loadedOf(again).get(name)?.value, `${name}.json`).toEqual(file.value);
    expect(again.daemon.internals.folder.stamp).toMatchObject({ smurg: DAEMON_VERSION, shapes: 1 });
    await stop();

    expect((await readdir(copy.workspaceDir)).sort()).toEqual(names);
    for (const [name, before] of keptBefore) {
      expect((await readFile(join(copy.workspaceDir, name))).equals(before.bytes), name).toBe(true);
      expect((await stat(join(copy.workspaceDir, name))).mtimeMs, `${name} was not written again`).toBe(before.mtimeMs);
    }
    // A document that a step upgraded and that no start has a reason of its own to write was not written again.
    // (state.json is written by every start: the host's new link.)
    const mtimesAfter = await mtimesOf(copy.workspaceDir);
    for (const document of Object.keys(upgrades.from).filter((name) => name !== 'state')) expect(mtimesAfter[`${document}.json`], `${document}.json was not written again`).toBe(mtimesBefore[`${document}.json`]);
  });

  it('what is kept beside the documents is all still there after a start: every audit and activity line, kept conflict versions, interrupted uploads', async () => {
    const copy = await fresh(version);
    const auditBefore = await readFile(join(copy.workspaceDir, 'audit.jsonl'));
    const activityBefore = await readFile(join(copy.workspaceDir, 'activity.jsonl'));
    const kept = async (folder: string): Promise<string[]> => (await readdir(join(copy.workspaceDir, folder)).catch(() => [])).sort();
    const conflictsBefore = await kept('conflicts');
    const uploadsBefore = await kept('uploads');
    // 0.5.0: the conversations of the agent sessions (segments of events, the cards that were open), by session.
    const transcriptsBefore = await snapshotOf(join(copy.workspaceDir, 'transcripts'));
    const segments = Object.keys(transcriptsBefore).filter((name) => /\/events-\d{6}\.jsonl$/.test(name));
    const segmentsBefore = new Map(await Promise.all(segments.map(async (name) => [name, await readFile(join(copy.workspaceDir, 'transcripts', name))] as const)));
    if (version !== '0.4.0') expect(segments.length).toBeGreaterThanOrEqual(10);
    expect(conflictsBefore.length).toBeGreaterThanOrEqual(3);
    expect(uploadsBefore.filter((name) => name.endsWith('.json')).length).toBeGreaterThanOrEqual(1);

    const t = await start(copy);
    // Through the daemon's own reader: every entry the published version wrote, none skipped as unreadable.
    const ids = new Set<string>();
    for (let before: number | undefined; ; ) {
      const page = await t.ctx.audit.query({ limit: 500, ...(before === undefined ? {} : { before }) });
      for (const entry of page) ids.add(entry.id);
      if (page.length < 500) break;
      before = page[page.length - 1]?.at;
    }
    const storedIds = auditBefore.toString('utf8').split('\n').filter((line) => line.length > 0).map((line) => (JSON.parse(line) as { id: string }).id);
    expect(storedIds.length).toBeGreaterThanOrEqual(190);
    expect(storedIds.filter((id) => !ids.has(id))).toEqual([]);
    await stop();

    // Append-only: what was there is still the beginning of the file, byte for byte.
    expect((await readFile(join(copy.workspaceDir, 'audit.jsonl'))).subarray(0, auditBefore.length).equals(auditBefore)).toBe(true);
    expect((await readFile(join(copy.workspaceDir, 'activity.jsonl'))).subarray(0, activityBefore.length).equals(activityBefore)).toBe(true);
    expect(await kept('conflicts')).toEqual(conflictsBefore);
    // An upload that was interrupted is kept for its sender to resume: manifest, journal and part (a manifest this
    // smurg could not read would have been deleted with its part at the start).
    expect(await kept('uploads')).toEqual(uploadsBefore);
    // No conversation is gone and none was rewritten: every file is still there, every segment still begins with
    // the events it held (a start may add to a conversation, e.g. that its process is gone).
    const transcriptsAfter = await snapshotOf(join(copy.workspaceDir, 'transcripts'));
    expect(Object.keys(transcriptsBefore).filter((name) => !(name in transcriptsAfter))).toEqual([]);
    for (const [name, before] of segmentsBefore) expect((await readFile(join(copy.workspaceDir, 'transcripts', name))).subarray(0, before.length).equals(before), name).toBe(true);
  });
});
