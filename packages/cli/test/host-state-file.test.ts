// `smurg host` on a folder whose workspace state the daemon refuses (review F3, 2026-10-02): written by another smurg
// version (protocol 2 keeps no compatibility with earlier state, ARCHITECTURE §11 D-15) or not in the expected format.
// The host's terminal says what it is and what to do, the log it points at says which file and why (paths and schema
// messages, never the values), nothing is migrated or rewritten, and the remedy it names (move the workspace's state
// dir aside, share again) works.
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_MODULES, defaultHostSettings, systemClock, type Daemon } from '@smurg/daemon';
import { MemoryRelay, TestIdentityIssuer, waitFor } from '@smurg/daemon/testing';
import { daemonKeyFingerprint, equalBytes, formatFingerprintForDisplay } from '@smurg/protocol';
import { readPinnedDaemonKey } from '@smurg/protocol/node';
import { formatFailure } from '../src/cli/errors.ts';
import { runAttach } from '../src/commands/attach.ts';
import { commandContext } from '../src/commands/context.ts';
import { runHost } from '../src/commands/host.ts';
import { saveSession } from '../src/state/credentials.ts';
import { hostLogPath, statePaths, workspaceStateDir } from '../src/state/paths.ts';
import { rememberSharedFolder } from '../src/state/workspaces.ts';
import { browserOpening, startFakeRelay } from './fake-relay.ts';
import { echoSessions } from './fixtures/echo-sessions.ts';
import { makeDirs, testIo } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

describe('smurg host with a workspace state file the daemon refuses (review F3)', () => {
  it('says it is from another smurg version or not in the expected format, logs which file and why, migrates nothing; moving the state aside and sharing again works', async () => {
    const dirs = await makeDirs();
    cleanups.push(() => dirs.cleanup());
    const relay = await startFakeRelay();
    cleanups.push(() => relay.close());
    const env = { HOME: dirs.home, SMURG_HOME: dirs.stateDir };
    const paths = statePaths(env);
    const workspaceId = `ws_state_${Math.random().toString(36).slice(2, 14)}`;
    await rememberSharedFolder(paths, { folder: await realpath(dirs.project), relay: relay.origin, workspaceId, createdAt: 1 });
    const token = 'stored.host-token-for-test';
    relay.tokens.set(token, relay.loginAs);
    await saveSession(paths, relay.origin, { token, tokenType: 'Bearer', expiresIn: 7 * 24 * 3600, user: relay.loginAs }, Date.now());

    // A state.json of another version: a settings key and a role this build does not know (no migration, D-15).
    const wsDir = workspaceStateDir(paths, workspaceId);
    await mkdir(wsDir, { recursive: true, mode: 0o700 });
    await chmod(join(dirs.stateDir, 'workspaces'), 0o700);
    const now = Date.now();
    const old = JSON.stringify({
      version: 1,
      workspaceId,
      members: [
        { userId: relay.loginAs.userId, displayName: 'Ian', role: 'host', color: '#e11d48', joinedAt: now, lastSeenAt: now, status: 'active' },
        { userId: 'github:7', displayName: 'Carol', role: 'runner', color: '#2563eb', joinedAt: now, lastSeenAt: now, status: 'active' },
      ],
      devices: [],
      invites: [],
      settings: { ...defaultHostSettings(), allowedDomains: ['secret-domain.example'] },
      worktreeRoots: [],
    });
    await writeFile(join(wsDir, 'state.json'), old, { mode: 0o600 });

    const memory = new MemoryRelay(workspaceId);
    const issuer = new TestIdentityIssuer(relay.origin, generateKeyPairSync('ed25519'), systemClock);
    const daemonDeps = (echo: ReturnType<typeof echoSessions>) => ({
      socketFactory: memory.hostSocketFactory(),
      identityKeys: { get: (kid: string) => (kid === issuer.kid ? issuer.publicKey : null), refresh: async () => {} },
      modules: [echo.module, ...DEFAULT_FEATURE_MODULES.filter((m) => m.name === 'local')],
    });

    // 1. Refused: what the host's terminal shows.
    const io = testIo({ env, openUrl: browserOpening });
    const failure = await runHost([dirs.project, '--relay', relay.origin, '--no-keep-awake'], commandContext(io), { daemon: daemonDeps(echoSessions()), onReady: () => {} }).then(
      (code) => new Error(`host started (exit ${code})`),
      (err: unknown) => err,
    );
    const shown = formatFailure(failure);
    const logPath = hostLogPath(paths, workspaceId);
    expect(shown.exitCode).toBe(1);
    expect(shown.text).toContain('smurg：這個工作區的狀態檔是別的 smurg 版本寫的，或不是預期的格式，daemon 拒絕啟動');
    expect(shown.text).toContain(`哪個檔案、什麼原因記在紀錄檔 ${logPath}`);
    expect(shown.text).toContain(`mv "${wsDir}" "${wsDir}.old"`);
    expect(shown.text).toContain('組員要用新的邀請連結重新加入');
    expect(shown.text).toContain('加入過的組員會看到「主人的電腦金鑰和之前不同」：請把 smurg status 顯示的新金鑰指紋用其他管道');
    expect(shown.text).not.toContain('損毀');

    // 2. The log it names has the file and the reason (schema paths and messages), never the values.
    const log = await readFile(logPath, 'utf8');
    expect(log).toContain('workspace state refused');
    expect(log).toContain(join(wsDir, 'state.json'));
    expect(log).toContain('does not match its schema');
    expect(log).toContain('allowedDomains');
    expect(log).toMatch(/members\.1\.role/);
    expect(log).not.toContain('secret-domain.example');
    expect(log).not.toContain('Carol');
    // The same line reached the terminal (errors go to stderr too).
    expect(io.err()).toContain('workspace state refused');

    // 3. Nothing was migrated or rewritten.
    expect(await readFile(join(wsDir, 'state.json'), 'utf8')).toBe(old);
    // (the daemon key is loaded or created before the state is read; nothing after it was opened)
    expect((await readdir(wsDir)).filter((name) => name !== 'identity.key').sort()).toEqual(['state.json']);

    // 4. The remedy the terminal names: move the state aside and share again (a fresh workspace state).
    await rename(wsDir, `${wsDir}.old`);
    const again = testIo({ env, openUrl: browserOpening });
    let ready: (daemon: Daemon) => void = () => {};
    const started = new Promise<Daemon>((resolve) => {
      ready = resolve;
    });
    const done = runHost([dirs.project, '--relay', relay.origin, '--no-keep-awake'], commandContext(again), { daemon: daemonDeps(echoSessions()), onReady: (daemon) => ready(daemon) });
    cleanups.push(async () => {
      again.signal('SIGTERM');
      await done.catch(() => {});
    });
    const daemon = await Promise.race([started, done.then((code) => Promise.reject(new Error(`host ended early (${code}): ${again.err()}`)))]);
    expect(daemon.workspaceId).toBe(workspaceId);
    expect(daemon.ctx.members.list().map((m) => [m.displayName, m.role])).toEqual([['Ian', 'host']]);
    await waitFor(() => (again.out().match(/\/join\//g) ?? []).length === 2, { what: 'the two links' });
    expect(await readFile(join(`${wsDir}.old`, 'state.json'), 'utf8')).toBe(old);
    again.signal('SIGTERM');
    expect(await done).toBe(0);
  }, 60_000);
});

// Verification M1 (2026-10-02): the remedy above (and HOSTING §5.1 「收回之後」 step 1) keeps the workspace id and makes
// a new daemon key. A member who joined with the CLI has the old key pinned: `smurg attach --invite <new link>` used to
// abort with the impersonation warning, with no way to accept the new key. Now it explains the change as the web does
// (「主人的電腦金鑰和之前不同」, both fingerprints) and continues only with an explicit yes or --accept-new-key.
describe('a CLI member after the host started over with new workspace keys (verification M1)', () => {
  it('is told 「主人的電腦金鑰和之前不同」 with both fingerprints; nothing is sent and the pin stays without a yes; y or --accept-new-key joins and re-pins', async () => {
    const dirs = await makeDirs();
    cleanups.push(() => dirs.cleanup());
    const relay = await startFakeRelay();
    cleanups.push(() => relay.close());
    const env = { HOME: dirs.home, SMURG_HOME: dirs.stateDir };
    const paths = statePaths(env);
    const workspaceId = `ws_keyreset_${Math.random().toString(36).slice(2, 12)}`;
    await rememberSharedFolder(paths, { folder: await realpath(dirs.project), relay: relay.origin, workspaceId, createdAt: 1 });
    const token = 'stored.host-token-for-test';
    relay.tokens.set(token, relay.loginAs);
    await saveSession(paths, relay.origin, { token, tokenType: 'Bearer', expiresIn: 7 * 24 * 3600, user: relay.loginAs }, Date.now());
    const memory = new MemoryRelay(workspaceId);
    const issuer = new TestIdentityIssuer(relay.origin, generateKeyPairSync('ed25519'), systemClock);

    async function share(): Promise<{ daemon: Daemon; invite: string; stop: () => Promise<number> }> {
      const io = testIo({ env, openUrl: browserOpening });
      let ready: (d: Daemon) => void = () => {};
      const started = new Promise<Daemon>((resolve) => {
        ready = resolve;
      });
      const done = runHost([dirs.project, '--relay', relay.origin, '--no-keep-awake', '--role', 'agent'], commandContext(io), {
        daemon: {
          socketFactory: memory.hostSocketFactory(),
          identityKeys: { get: (kid: string) => (kid === issuer.kid ? issuer.publicKey : null), refresh: async () => {} },
          modules: [echoSessions().module, ...DEFAULT_FEATURE_MODULES.filter((m) => m.name === 'local')],
        },
        onReady: (d) => ready(d),
      });
      cleanups.push(async () => {
        io.signal('SIGTERM');
        await done.catch(() => {});
      });
      const daemon = await Promise.race([started, done.then((code) => Promise.reject(new Error(`host ended early (${code}): ${io.err()}`)))]);
      await waitFor(() => memory.hostOnline('ws'), { what: 'the daemon at the relay' });
      await waitFor(() => (io.out().match(/\/join\//g) ?? []).length === 2, { what: 'the two links' });
      const urls = io.out().match(/https?:\/\/\S+\/join\/\S+/g) ?? [];
      return {
        daemon,
        invite: urls[1] as string,
        stop: async () => {
          io.signal('SIGTERM');
          return done;
        },
      };
    }
    async function member(name: string): Promise<{ readonly env: Record<string, string>; readonly stateDir: string; readonly relayFor: () => Promise<ReturnType<MemoryRelay['apiFor']>> }> {
      const own = await makeDirs();
      cleanups.push(() => own.cleanup());
      return {
        env: { HOME: own.home, SMURG_HOME: own.stateDir },
        stateDir: own.stateDir,
        relayFor: async () => memory.apiFor({ userId: `dev:${name.toLowerCase()}`, displayName: name }, issuer),
      };
    }

    // 1. Share; Amy and Bob join with the CLI (their CLIs pin the daemon key).
    const first = await share();
    const amy = await member('Amy');
    const bob = await member('Bob');
    for (const m of [amy, bob]) expect(await runAttach(['--invite', first.invite], commandContext(testIo({ env: m.env })), { relayFor: m.relayFor })).toBe(0);
    const oldKey = first.daemon.daemonPublicKey;
    expect(equalBytes((await readPinnedDaemonKey(amy.stateDir, workspaceId)) as Uint8Array, oldKey)).toBe(true);

    // 2. The host starts over (HOSTING §5.1 step 1 / §8): stop, move the workspace state aside, share again.
    expect(await first.stop()).toBe(0);
    const wsDir = workspaceStateDir(paths, workspaceId);
    await rename(wsDir, `${wsDir}.old`);
    const second = await share();
    expect(second.daemon.workspaceId).toBe(workspaceId);
    expect(equalBytes(second.daemon.daemonPublicKey, oldKey)).toBe(false);
    const oldPrint = formatFingerprintForDisplay(daemonKeyFingerprint(oldKey));
    const membersOf = (): string[] => second.daemon.ctx.members.list().map((m) => m.displayName).sort();

    // 3a. With the pinned key only: the warning says what to do if the host started over.
    const pinnedOnly = testIo({ env: amy.env });
    const pinnedFailure = formatFailure(await runAttach(['--workspace', workspaceId], commandContext(pinnedOnly), { relayFor: amy.relayFor }).then((code) => new Error(`exit ${code}`), (err: unknown) => err));
    expect(pinnedFailure.text).toContain('主人電腦的金鑰和這台電腦上次記錄的不同');
    expect(pinnedFailure.text).toContain('請向主人索取新的邀請連結，用 smurg attach --invite - 加入');

    // 3b. The new link, nobody answers (no terminal) or the answer is not yes: explained, cancelled, nothing changed.
    for (const answer of [null, 'n', 'nein']) {
      const io = testIo({ env: amy.env, readLine: async () => answer });
      const failure = formatFailure(await runAttach(['--invite', second.invite], commandContext(io), { relayFor: amy.relayFor }).then((code) => new Error(`exit ${code}`), (err: unknown) => err));
      expect(io.err()).toContain('主人的電腦金鑰和之前不同');
      expect(io.err()).toContain(`上次記錄的金鑰指紋：${oldPrint}`);
      expect(io.err()).toContain(`邀請連結的金鑰指紋：${second.daemon.fingerprint}`);
      expect(io.err()).toContain('主人用 smurg status 看到的「daemon 金鑰指紋」');
      expect(failure).toMatchObject({ exitCode: 1 });
      expect(failure.text).toContain('已取消，沒有連線；這台電腦記錄的主人金鑰沒有改變。');
      expect(failure.text).toContain(answer === null ? '加上 --accept-new-key 再執行一次' : '向主人確認過金鑰指紋之後再執行一次');
      expect(equalBytes((await readPinnedDaemonKey(amy.stateDir, workspaceId)) as Uint8Array, oldKey)).toBe(true);
      expect(membersOf()).toEqual(['Ian']);
    }

    // 3c. Amy answers y at her terminal: she joins with the new link and her CLI pins the new key.
    const prompts: string[] = [];
    const yes = testIo({ env: amy.env, readLine: async (prompt) => (prompts.push(prompt), 'y') });
    expect(await runAttach(['--invite', second.invite], commandContext(yes), { relayFor: amy.relayFor })).toBe(0);
    expect(prompts).toEqual(['確認過了嗎？輸入 y 用新的連結加入，其他輸入取消：']);
    expect(yes.out()).toContain('這個工作區目前沒有 session');
    expect(equalBytes((await readPinnedDaemonKey(amy.stateDir, workspaceId)) as Uint8Array, second.daemon.daemonPublicKey)).toBe(true);
    // Later the pinned (new) key alone is enough, with no question.
    const later = testIo({ env: amy.env, readLine: async () => 'unexpected question' });
    expect(await runAttach(['--workspace', workspaceId], commandContext(later), { relayFor: amy.relayFor })).toBe(0);
    expect(later.err()).not.toContain('主人的電腦金鑰和之前不同');

    // 3d. Bob, without a terminal, after checking the fingerprint with the host: --accept-new-key.
    const flagged = testIo({ env: bob.env });
    expect(await runAttach(['--invite', second.invite, '--accept-new-key'], commandContext(flagged), { relayFor: bob.relayFor })).toBe(0);
    expect(flagged.err()).toContain('主人的電腦金鑰和之前不同');
    expect(flagged.err()).toContain('已指定 --accept-new-key：改用邀請連結的金鑰。');
    expect(equalBytes((await readPinnedDaemonKey(bob.stateDir, workspaceId)) as Uint8Array, second.daemon.daemonPublicKey)).toBe(true);
    expect(membersOf()).toEqual(['Amy', 'Bob', 'Ian']);
    expect(await second.stop()).toBe(0);
  }, 60_000);
});
