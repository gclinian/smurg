// The whole thing, as the owner met it.
//
// The owner updated their own computer from 0.4.0 and ran `smurg host .` in the folder they had always shared. 0.5.0
// answered "state file does not match its schema (settings.maxLiveAgents: Invalid input: expected number, received
// undefined; settings.escalateAfterMs: …; settings.agentMcp: …)" and the command advised moving the workspace's state
// folder away: the members, the invite links and the daemon's key with it. Run in a tree of tag v0.5.0, the first test
// here fails with exactly that sentence.
//
// `createDaemon` is called as `smurg host` calls it (packages/cli/src/commands/host.ts): the host's ~/.smurg, the
// shared folder, the workspace id that ~/.smurg/workspaces.json names for that folder, the account of the saved relay
// login, the release's modules, no run folder of its own (the sockets live in ~/.smurg/run), a fake home. Three things
// differ, each because this is a test: the relay is an in-memory one (no network); the clock stands at the fixture's
// instant (its invite links live for a week); and no command for `smurg hook` is configured, so that no agent process
// can ever be started (the 0.5.0 fixture holds agent sessions; a test must never start the machine's own `claude`).
import { generateKeyPairSync } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { parseInviteUrl, toHex } from '@smurg/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultMaxLiveAgents } from '../../src/core/config.ts';
import { createMemoryLogger } from '../../src/core/logger.ts';
import { DAEMON_VERSION, DEFAULT_FEATURE_MODULES, createDaemon, type Daemon } from '../../src/daemon.ts';
import { MEMORY_RELAY_ORIGIN, MemoryRelay, TestIdentityIssuer, createTempDir, removeTempDir } from '../../src/testing/index.ts';
import { clockAt } from './daemon-on.ts';
import { STAMP_NAME, copyOf, keptCopyName, ledgerOf, readJson, sha256Of, type FixtureCopy, type StoredState } from './fixture.ts';

const cleanups: (() => Promise<void>)[] = [];
let daemon: Daemon | null = null;

afterEach(async () => {
  await daemon?.stop().catch(() => {});
  daemon = null;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

interface Host {
  readonly copy: FixtureCopy;
  readonly log: ReturnType<typeof createMemoryLogger>;
  /** `smurg host <the folder>`: createDaemon, then start(). Resolves with the running daemon. */
  share(): Promise<Daemon>;
  /** `smurg stop` (or Ctrl-C). */
  stop(): Promise<void>;
}

/** The host's computer: a copy of what the published smurg left there, and the command that shares the folder again. */
async function hostOf(version: '0.4.0' | '0.5.0'): Promise<Host> {
  const copy = await copyOf(version, 'stopped');
  cleanups.push(() => copy.remove());
  const home = await createTempDir('upgrade-home');
  cleanups.push(() => removeTempDir(home));
  // What `smurg host` reads before it calls the daemon: the folder's workspace id and the saved login.
  const book = await readJson<{ shared: { folder: string; workspaceId: string }[] }>(join(copy.hostHome, 'workspaces.json'));
  const entry = book.shared.find((shared) => shared.folder === copy.project);
  if (entry === undefined) throw new Error('the copy of workspaces.json does not name the copied folder');
  const credentials = await readJson<{ defaultRelay: string; relays: Record<string, { userId: string; displayName: string }> }>(join(copy.hostHome, 'credentials.json'));
  const login = credentials.relays[credentials.defaultRelay];
  if (login === undefined) throw new Error('the copy of credentials.json holds no login for its default relay');

  const clock = clockAt(copy.at);
  const log = createMemoryLogger();
  return {
    copy,
    log,
    share: async () => {
      const relay = new MemoryRelay(entry.workspaceId);
      const issuer = new TestIdentityIssuer(MEMORY_RELAY_ORIGIN, generateKeyPairSync('ed25519'), clock);
      const created = await createDaemon({
        config: {
          stateDir: copy.hostHome,
          shareDir: copy.project,
          workspaceId: entry.workspaceId,
          hostUserId: login.userId,
          hostName: login.displayName,
          relayUrl: MEMORY_RELAY_ORIGIN,
          keepAwake: false,
          activity: { attributeBashEdits: true },
        },
        relay: { token: 'the-saved-relay-session', socketFactory: relay.hostSocketFactory() },
        identityKeys: { get: (kid) => (kid === issuer.kid ? issuer.publicKey : null), refresh: async () => {} },
        modules: DEFAULT_FEATURE_MODULES,
        log,
        homeDir: home,
        clock,
      });
      daemon = created;
      await created.start();
      return created;
    },
    stop: async () => {
      await daemon?.stop();
      daemon = null;
    },
  };
}

/**
 * A log line that says something is wrong with the workspace's state: a refusal, a stamp that cannot be used, an
 * older file put back, a write that failed. (A copy has no shared folder, so the log also holds the watcher's
 * complaints about the worktree folders the state names; those are not about the state.)
 */
const aboutTheState = (line: { readonly level: string; readonly message: string; readonly fields: Readonly<Record<string, unknown>> }): boolean =>
  line.level !== 'info' && line.level !== 'debug' && (line.fields['module'] === 'state' || /state|stamp|put back|kept copy/i.test(line.message));

const namesOf = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();
const keptIn = async (dir: string): Promise<string[]> => (await namesOf(dir)).filter((name) => name.includes('.before-upgrade-from-'));

describe('as the owner met it: `smurg host` on the folder a published smurg shared', { timeout: 90_000 }, () => {
  it('0.4.0: shared again, stopped, shared again. One upgrade, said once; the same workspace, key, members, links, settings, suggestions', async () => {
    const host = await hostOf('0.4.0');
    const dir = host.copy.workspaceDir;
    const ledger = ledgerOf('0.4.0');
    const oldState = await readFile(join(dir, 'state.json'));
    const oldSuggestions = await readFile(join(dir, 'suggestions.json'));
    const old = JSON.parse(oldState.toString('utf8')) as StoredState;
    const oldSuggestionList = (JSON.parse(oldSuggestions.toString('utf8')) as { suggestions: { id: string; text: string; status: string }[] }).suggestions;
    expect(old.settings).toEqual({ humanLockIdleMs: 45_000, agentLockTimeoutMs: 90_000, uploadChunkSize: 4_194_304, sharedDirs: ['data'], diskReserveBytes: 5_368_709_120, diskReservePercent: 3 });

    // ---- `smurg host .`, the first time with this smurg.
    const first = await host.share();

    // What the ONE line on the terminal is made of.
    expect(first.upgraded).toEqual([
      { document: 'state', from: '0.4.0', copy: join(dir, 'state.json.before-upgrade-from-0.4.0') },
      { document: 'suggestions', from: '0.4.0', copy: join(dir, 'suggestions.json.before-upgrade-from-0.4.0') },
    ]);
    expect(first.putBack).toBe(false);
    // The host's log has the same, with the file and where the old one is kept.
    expect(host.log.lines.filter((line) => line.message === 'state file upgraded').map((line) => line.fields)).toEqual(first.upgraded.map((entry) => ({ module: 'state', ...entry, putBack: false })));
    expect(host.log.lines.filter(aboutTheState)).toEqual([]);

    // The same workspace under the same key: nobody sees "the host computer's key has changed", every old link still names this daemon.
    expect(first.workspaceId).toBe('ws_x0ero8pS70bWM5G4VbZ1NA');
    expect(first.fingerprint).toBe('5521 e1d4 5f4e da2c ff81');
    expect(toHex(parseInviteUrl(first.hostInviteUrl as string).fingerprint)).toBe(toHex(parseInviteUrl(ledger.links['teamLink'] as string).fingerprint));

    // The stamp: this smurg wrote the folder last, with shapes 1.
    expect(await readJson(join(dir, STAMP_NAME))).toEqual({ smurg: DAEMON_VERSION, shapes: 1, at: expect.any(Number) });
    // The copies: the files as 0.4.0 left them, byte for byte, private.
    expect(await keptIn(dir)).toEqual(['state.json.before-upgrade-from-0.4.0', 'suggestions.json.before-upgrade-from-0.4.0']);
    expect(sha256Of(await readFile(join(dir, keptCopyName('state', '0.4.0'))))).toBe(sha256Of(oldState));
    expect(sha256Of(await readFile(join(dir, keptCopyName('suggestions', '0.4.0'))))).toBe(sha256Of(oldSuggestions));
    for (const name of [STAMP_NAME, ...(await keptIn(dir))]) expect((await stat(join(dir, name))).mode & 0o777, name).toBe(0o600);

    // The settings in force: the six the host chose under 0.4.0, and the three 0.5.0 added, closed.
    expect(first.ctx.settings.get()).toEqual({ ...old.settings, maxLiveAgents: defaultMaxLiveAgents(totalmem()), escalateAfterMs: 300_000, agentMcp: false });
    await host.stop();

    // ---- The documents on disk after that run, in the shapes this smurg (and 0.5.0) writes.
    const state = await readJson<StoredState>(join(dir, 'state.json'));
    expect(state.version).toBe(1);
    expect(state.workspaceId).toBe(old.workspaceId);
    expect(state.settings).toEqual({ ...old.settings, maxLiveAgents: defaultMaxLiveAgents(totalmem()), escalateAfterMs: 300_000, agentMcp: false });
    // Every member and every device, the removed and the revoked ones as they were.
    expect(state.members.map((member) => `${member.userId} ${member.role} ${member.status}`)).toEqual(old.members.map((member) => `${member.userId} ${member.role} ${member.status}`));
    expect(state.members.filter((member) => member.status === 'kicked').map((member) => member.userId)).toEqual(['dev:erin']);
    expect(state.devices).toEqual(old.devices);
    expect(state.devices.filter((device) => device.revoked).map((device) => device.name)).toEqual(['erin (REAL test browser)', 'frank-laptop (REAL test browser)']);
    // Every link 0.4.0 knew, unchanged (uses, limits, revoked, expiry), and the one host link this run made.
    expect(state.invites.slice(0, old.invites.length)).toEqual(old.invites);
    expect(state.invites.slice(old.invites.length).map((invite) => `${invite.role} host=${String(invite.host)} uses=${invite.uses}`)).toEqual(['host host=true uses=0']);
    const suggestions = (await readJson<{ version: number; suggestions: { id: string; text: string; status: string; origin: string }[] }>(join(dir, 'suggestions.json')));
    expect(suggestions.version).toBe(1);
    expect(suggestions.suggestions.map((entry) => `${entry.id} ${entry.status} ${entry.text}`)).toEqual(oldSuggestionList.map((entry) => `${entry.id} ${entry.status} ${entry.text}`));
    expect(suggestions.suggestions.map((entry) => entry.origin)).toEqual(['composer', 'composer', 'selection', 'composer', 'composer', 'composer', 'composer']);
    // All 193 audit lines and all 32 activity lines of 0.4.0, and what this run added after them.
    expect((await readFile(join(dir, 'audit.jsonl'), 'utf8')).split('\n').filter((line) => line.length > 0).length).toBeGreaterThan(193);
    expect((await readFile(join(dir, 'activity.jsonl'), 'utf8')).split('\n').filter((line) => line.length > 0).length).toBeGreaterThanOrEqual(32);
    const names = await namesOf(dir);
    const kept = new Map(await Promise.all((await keptIn(dir)).map(async (name) => [name, (await stat(join(dir, name))).mtimeMs] as const)));

    // ---- `smurg host .` again: nothing to upgrade, nothing to say, nothing copied.
    host.log.lines.length = 0;
    const second = await host.share();
    expect(second.upgraded).toEqual([]);
    expect(second.putBack).toBe(false);
    expect(host.log.lines.filter((line) => line.message === 'state file upgraded' || aboutTheState(line))).toEqual([]);
    expect(second.fingerprint).toBe('5521 e1d4 5f4e da2c ff81');
    expect(second.ctx.settings.get()).toEqual(state.settings);
    expect(second.ctx.members.list({ includeKicked: true }).map((member) => `${member.userId} ${member.role} ${member.status}`)).toEqual(old.members.map((member) => `${member.userId} ${member.role} ${member.status}`));
    await host.stop();
    expect(await namesOf(dir)).toEqual(names);
    for (const [name, mtimeMs] of kept) expect((await stat(join(dir, name))).mtimeMs, `${name} was not written again`).toBe(mtimeMs);
    expect(sha256Of(await readFile(join(dir, keptCopyName('state', '0.4.0'))))).toBe(sha256Of(oldState));
    // The first run's host link was never used: the second start revokes it and makes its own, as every start does.
    const again = await readJson<StoredState>(join(dir, 'state.json'));
    expect(again.invites.slice(0, old.invites.length)).toEqual(old.invites);
    expect(again.invites.slice(old.invites.length).map((invite) => `${invite.role} revoked=${String(invite.revoked)}`)).toEqual(['host revoked=true', 'host revoked=false']);
    expect(again.devices).toEqual(old.devices);
  });

  it('0.5.0: shared again, stopped, shared again. Nothing is upgraded, nothing is copied, everything it held is there', async () => {
    const host = await hostOf('0.5.0');
    const dir = host.copy.workspaceDir;
    const documents = (await namesOf(dir)).filter((name) => name.endsWith('.json'));
    expect(documents).toEqual(['agent-sessions.json', 'cards.json', 'claude-trust.json', 'conflicts.json', 'host-rules.json', 'inbox.json', 'reports.json', 'sessions.json', 'state.json', 'suggestions.json', 'topics.json', 'worktrees.json']);
    const stored = new Map(await Promise.all(documents.map(async (name) => [name.slice(0, -5), JSON.parse(await readFile(join(dir, name), 'utf8')) as unknown] as const)));
    const old = stored.get('state') as StoredState;
    // The host of this workspace had CHOSEN the three settings 0.5.0 added: an upgrade step must never be run over them.
    expect(old.settings).toMatchObject({ maxLiveAgents: 2, escalateAfterMs: 60_000, agentMcp: true });

    const first = await host.share();
    expect(first.upgraded).toEqual([]);
    expect(first.putBack).toBe(false);
    expect(host.log.lines.filter((line) => line.message === 'state file upgraded' || aboutTheState(line))).toEqual([]);
    expect(await keptIn(dir)).toEqual([]);
    // Everything it held, as this smurg read it before it changed anything: file for file what 0.5.0 wrote.
    const loaded = first.internals.folder.loaded;
    expect([...loaded.keys()].sort()).toEqual([...stored.keys()].sort());
    for (const [name, value] of stored) {
      expect(loaded.get(name)?.upgradedFrom, name).toBeNull();
      expect(loaded.get(name)?.value, `${name}.json`).toEqual(value);
    }
    expect(first.workspaceId).toBe('ws_n8MKlviIItx2COhFvmlwCw');
    expect(first.fingerprint).toBe('cb32 c31a ed6d e26a 69b9');
    expect(first.ctx.settings.get()).toEqual(old.settings);
    expect(await readJson(join(dir, STAMP_NAME))).toEqual({ smurg: DAEMON_VERSION, shapes: 1, at: expect.any(Number) });
    await host.stop();

    const state = await readJson<StoredState>(join(dir, 'state.json'));
    expect(state.settings).toEqual(old.settings);
    expect(state.members.map((member) => `${member.userId} ${member.role} ${member.status}`)).toEqual(old.members.map((member) => `${member.userId} ${member.role} ${member.status}`));
    expect(state.members.filter((member) => member.status === 'kicked').map((member) => member.userId)).toEqual(['dev:pete', 'dev:erin', 'dev:sam']);
    expect(state.devices).toEqual(old.devices);
    expect(state.devices.filter((device) => device.revoked).length).toBe(4);
    // Every link, unchanged, but the host's own unused one of the run before (revoked by this start, as by every start).
    const unusedHostLinks = old.invites.filter((invite) => invite.host && !invite.revoked && invite.uses === 0).map((invite) => invite.id);
    expect(unusedHostLinks).toEqual(['inv_lMdeWvCGYJKW9jERWhliZg']);
    expect(state.invites.slice(0, old.invites.length)).toEqual(old.invites.map((invite) => (unusedHostLinks.includes(invite.id) ? { ...invite, revoked: true } : invite)));
    // The documents no start has a reason to change are byte for byte what 0.5.0 wrote.
    for (const name of ['host-rules', 'claude-trust', 'conflicts', 'reports']) expect(await readJson(join(dir, `${name}.json`)), `${name}.json`).toEqual(stored.get(name));
    const names = await namesOf(dir);

    const second = await host.share();
    expect(second.upgraded).toEqual([]);
    expect(second.putBack).toBe(false);
    expect(second.fingerprint).toBe('cb32 c31a ed6d e26a 69b9');
    await host.stop();
    expect(await namesOf(dir)).toEqual(names);
    expect(await keptIn(dir)).toEqual([]);
  });
});
