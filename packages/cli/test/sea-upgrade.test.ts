// What a PUBLISHED smurg left behind opens in the new one: the upgrade with REAL executables (0.5.1, DESIGN E2 and
// E-tests; docs/RELEASING.md runs it before every release with the executable of every published version `smurg update`
// can start from). Opt-in, beside sea-update.test.ts:
//
//   SMURG_PREVIOUS_BINARIES=/path/to/smurg-0.4.0:/path/to/smurg-0.5.0 \
//   SMURG_SEA_BINARY=packages/cli/dist/smurg-darwin-arm64 \
//     pnpm --filter @smurg/cli exec vitest run test/sea-upgrade.test.ts
//
//   SMURG_PREVIOUS_BINARIES  one or more published executables (downloaded from https://downloads.smurg.ai/v<X.Y.Z>/ and
//                            checked against that version's SHA256SUMS), separated by ":";
//   SMURG_SEA_BINARY         the executable of this tree (scripts/build-sea.sh).
// Without both it is SKIPPED, and says so loudly: a release must not pass because this did not run.
//
// For EACH old executable, in a scratch HOME / SMURG_HOME / cache of its own (never the real ~/.smurg or ~/.local/bin):
//   1. the old executable logs in to the ONE local relay of this file with the dev login (`smurg login --dev-user`),
//   2. shares a scratch folder (`smurg host`): it makes the workspace, the daemon key, and the teammates' invite link,
//   3. says its daemon key fingerprint (`smurg status`), and stops (`smurg stop`);
//   4. the NEW executable shares the same folder with the same state: the same workspace id, the same key fingerprint,
//      the old invite is in the list the host's console gets (`admin.invite.list`), and, when the old executable's
//      files needed a step (0.4.0), the one-line upgrade notice appears, the old state.json is kept beside the new one
//      byte for byte, and the stamp names the shapes; when they needed none (0.5.0), nothing of that appears;
//   5. the new executable stops;
//   6. a state file that other users can read is refused by the new executable (run in Traditional Chinese): the text
//      names the file and the one chmod, never "move", and the file is as it was.
// The relay is the fake relay of these tests (the relay never reads a frame, and its own source did not change between
// 0.4.0 and 0.5.0): logins and the workspace claim are its HTTP API; the NEW host's relay links are tunnelled to an
// in-memory relay so that the test can reach it as the host's console does. Only processes this test started are ever
// signalled, by their recorded pid.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { chmod, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '@smurg/daemon';
import { MemoryRelay, TestIdentityIssuer, waitFor } from '@smurg/daemon/testing';
import { deriveInviteKeys, parseInviteUrl } from '@smurg/protocol';
import { RelayWorkspaceChannel } from '../src/channel/relay-channel.ts';
import { statePaths, workspaceStateDir } from '../src/state/paths.ts';
import { startFakeRelay, type FakeRelay } from './fake-relay.ts';
import { isolatedEnv, makeDirs } from './helpers.ts';

const NEW = process.env['SMURG_SEA_BINARY'] ? resolve(process.env['SMURG_SEA_BINARY']) : null;
const PREVIOUS = (process.env['SMURG_PREVIOUS_BINARIES'] ?? '')
  .split(delimiter)
  .filter((path) => path !== '')
  .map((path) => resolve(path));
const READY = NEW !== null && PREVIOUS.length > 0;

const SKIPPED =
  '[sea-upgrade] SKIPPED: the upgrade from the published executables was NOT tested. It needs SMURG_PREVIOUS_BINARIES (one or more published smurg executables, separated by ":") and SMURG_SEA_BINARY (the build of this tree). See the top of packages/cli/test/sea-upgrade.test.ts.';

// Loud on purpose: a run without the variables reports this test as skipped WITH the reason (a file that is silently
// skipped reads as "covered"), and prints the line where the runner shows a test's output.
describe.skipIf(READY)('the upgrade with real executables', () => {
  it('NOT TESTED without SMURG_PREVIOUS_BINARIES and SMURG_SEA_BINARY', (context) => {
    console.warn(`\n${SKIPPED}\n`);
    context.skip(SKIPPED);
  });
});

/**
 * The one line `smurg host` prints when this start upgraded what an earlier smurg wrote (DESIGN A7 and C: "this
 * workspace was last shared with smurg X (or an earlier smurg); members, invite links and settings were carried
 * over; the guide's address"). The words themselves are in the catalog (`host.upgraded`) and are held word for word,
 * in both languages, by host-state-file.test.ts; here it is the real executable that has to say them.
 */
const UPGRADE_NOTICE = /last shared with (?:smurg \d+\.\d+\.\d+|an earlier smurg).*carried over/i;

/** SMURG_SHOW_TERMINAL=<file>: what the new executable printed is appended to it (for a release's report). */
function show(title: string, host: Host): void {
  const file = process.env['SMURG_SHOW_TERMINAL'];
  if (file === undefined || file === '') return;
  appendFileSync(file, `===== ${title}\n--- stderr\n${host.err()}--- stdout\n${host.out()}\n`);
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function smurg(bin: string, args: readonly string[], env: Record<string, string>, cwd: string): Promise<Outcome> {
  return new Promise((done) => {
    execFile(bin, args, { env, cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
  });
}

interface Host {
  readonly out: () => string;
  readonly err: () => string;
  readonly alive: () => boolean;
  readonly exited: Promise<number | null>;
}

/** `smurg host <folder>` in the foreground of a child process; ended at the test's end if it is still there. */
function startHost(bin: string, folder: string, relay: string, env: Record<string, string>): Host {
  const child: ChildProcess = spawn(bin, ['host', folder, '--relay', relay, '--no-keep-awake'], { env, cwd: folder, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 1 || pid === process.pid) throw new Error('smurg host did not start');
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  let alive = true;
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  void exited.then(() => {
    alive = false;
  });
  cleanups.push(async () => {
    // Only the process this test spawned, by its recorded pid.
    if (alive) process.kill(pid as number, 'SIGTERM');
    await Promise.race([exited, new Promise((done) => setTimeout(done, 15_000))]);
    if (alive) process.kill(pid as number, 'SIGKILL');
  });
  return { out: () => out, err: () => err, alive: () => alive, exited };
}

/** Waits for the two links of the start summary; a host that ended instead fails with everything it said. */
async function linksOf(host: Host, who: string): Promise<{ hostLink: string; inviteLink: string; workspaceId: string }> {
  await waitFor(() => (host.out().match(/\/join\//g) ?? []).length >= 2 || !host.alive(), { timeoutMs: 120_000, what: `the start summary of ${who}` });
  if (!host.alive()) throw new Error(`${who}: smurg host ended (exit code ${await host.exited}) instead of sharing.\n--- stderr ---\n${host.err()}\n--- stdout ---\n${host.out()}`);
  const links = host.out().match(/https?:\/\/\S+\/join\/\S+/g) ?? [];
  const workspaceId = (/\/join\/(ws_[A-Za-z0-9_-]+)#/.exec(links[0] as string) as RegExpExecArray)[1] as string;
  return { hostLink: links[0] as string, inviteLink: links[1] as string, workspaceId };
}

const fingerprintOf = (status: string): string | null => /Daemon key fingerprint: ([0-9a-f ]+)\n/.exec(status)?.[1] ?? null;
const versionOf = (banner: string): string | null => /^smurg (\S+) \(/.exec(banner)?.[1] ?? null;

describe.skipIf(!READY)('the upgrade with real executables: what each published smurg left behind opens in the new one (SMURG_PREVIOUS_BINARIES, SMURG_SEA_BINARY)', () => {
  // ONE relay for every old executable and for the new one.
  let relay: FakeRelay;
  beforeAll(async () => {
    relay = await startFakeRelay();
  });
  afterAll(async () => {
    await relay?.close();
  });

  for (const old of PREVIOUS) {
    it(`${basename(dirname(old))}/${basename(old)}: logs in, shares a folder, makes an invite and stops; the new executable shares the same folder as the same workspace`, async () => {
      const bin = NEW as string;
      const dirs = await makeDirs();
      cleanups.push(() => dirs.cleanup());
      const env = isolatedEnv(dirs, { SMURG_CACHE_DIR: join(dirs.home, 'cache') });
      const project = await realpath(dirs.project);
      await writeFile(join(project, 'notes.txt'), 'hello\n');

      const oldVersion = versionOf((await smurg(old, ['--version'], env, dirs.home)).stdout);
      const newVersion = versionOf((await smurg(bin, ['--version'], env, dirs.home)).stdout);
      expect(oldVersion, `${old} --version`).toMatch(/^\d+\.\d+\.\d+/);
      expect(newVersion, `${bin} --version`).toMatch(/^\d+\.\d+\.\d+/);
      console.info(`[sea-upgrade] ${oldVersion} -> ${newVersion}`);

      // ---- the old executable: login, share, the invite, the fingerprint, stop
      const login = await smurg(old, ['login', '--relay', relay.origin, '--dev-user', 'host'], env, dirs.home);
      expect(`${login.stdout}${login.stderr}`).toContain('dev:host');
      expect(login.code).toBe(0);
      const before = startHost(old, project, relay.origin, env);
      const made = await linksOf(before, `smurg ${oldVersion}`);
      const oldStatus = await smurg(old, ['status'], env, project);
      expect(oldStatus.stdout).toContain(`Workspace ${made.workspaceId}`);
      const fingerprint = fingerprintOf(oldStatus.stdout);
      expect(fingerprint, oldStatus.stdout).not.toBeNull();
      const stopped = await smurg(old, ['stop'], env, project);
      expect(stopped.stdout).toContain('Stopped sharing.');
      expect(await before.exited).toBe(0);

      // What it left: the workspace's state, with the invite of the link it printed (the daemon stores the id derived
      // from the link's secret, never the secret).
      const paths = statePaths(env);
      const stateDir = workspaceStateDir(paths, made.workspaceId);
      const oldState = await readFile(join(stateDir, 'state.json'));
      const keyIdHex = Buffer.from(deriveInviteKeys(parseInviteUrl(made.inviteLink).secret).inviteId).toString('hex');
      const invite = (JSON.parse(oldState.toString('utf8')) as { invites: { id: string; keyIdHex: string; role: string; revoked: boolean }[] }).invites.find((record) => record.keyIdHex === keyIdHex);
      expect(invite, 'the invite of the printed link in the old state.json').toMatchObject({ role: 'editor', revoked: false });
      const filesBefore = (await readdir(stateDir)).sort();
      expect(filesBefore).toContain('identity.key');

      // ---- the new executable on the same folder and state
      const memory = new MemoryRelay(made.workspaceId);
      const issuer = new TestIdentityIssuer(relay.origin, generateKeyPairSync('ed25519'), systemClock);
      relay.tunnel(memory, issuer);
      const after = startHost(bin, project, relay.origin, env);
      const shared = await linksOf(after, `smurg ${newVersion} on what smurg ${oldVersion} left`);
      expect(shared.workspaceId).toBe(made.workspaceId);
      const newStatus = await smurg(bin, ['status'], env, project);
      expect(newStatus.code).toBe(0);
      expect(fingerprintOf(newStatus.stdout)).toBe(fingerprint);
      // The same daemon key is also what the new links carry (`k`).
      expect(Buffer.from(parseInviteUrl(shared.hostLink).fingerprint).equals(Buffer.from(parseInviteUrl(made.inviteLink).fingerprint))).toBe(true);

      // The invite is listed: asked as the host's console asks, through the new daemon's relay link.
      await waitFor(() => memory.hostOnline('ws'), { timeoutMs: 30_000, what: 'the new daemon at the (tunnelled) relay' });
      const console_ = await makeDirs();
      cleanups.push(() => console_.cleanup());
      const hostInvite = parseInviteUrl(shared.hostLink);
      const channel = await RelayWorkspaceChannel.open({
        relay: memory.apiFor({ userId: 'dev:host', displayName: 'host' }, issuer),
        workspaceId: made.workspaceId,
        stateDir: console_.stateDir,
        invite: { fingerprint: hostInvite.fingerprint, secret: hostInvite.secret },
        deviceName: 'sea upgrade',
      });
      cleanups.push(() => channel.close());
      expect(channel.welcome.member.role).toBe('host');
      const { invites } = await channel.request('admin.invite.list', {});
      expect(invites.map((listed) => listed.id)).toContain((invite as { id: string }).id);
      expect(invites.find((listed) => listed.id === (invite as { id: string }).id)).toMatchObject({ role: 'editor', revoked: false });
      channel.close();

      // What the daemon's part of the upgrade left (DESIGN A5, A9): the old file kept byte for byte when a step ran,
      // nothing kept when none was needed, and the stamp of the smurg that wrote the folder last.
      const copies = (await readdir(stateDir)).filter((name) => name.includes('.before-upgrade-from-')).sort();
      const stepRan = (oldVersion as string).startsWith('0.4.');
      if (stepRan) {
        expect(copies).toContain('state.json.before-upgrade-from-0.4.0');
        expect((await readFile(join(stateDir, 'state.json.before-upgrade-from-0.4.0'))).equals(oldState)).toBe(true);
        expect((await lstat(join(stateDir, 'state.json.before-upgrade-from-0.4.0'))).mode & 0o777).toBe(0o600);
      } else {
        expect(copies).toEqual([]);
      }
      const stamp = JSON.parse(await readFile(join(stateDir, 'written-by.json'), 'utf8')) as { smurg: unknown; shapes: unknown };
      expect(stamp.shapes).toBe(1);
      expect(typeof stamp.smurg).toBe('string');

      // The command's part (DESIGN A7, C; step K3B): the upgrade is said in ONE line when a step ran, never otherwise.
      const noticeLines = after
        .out()
        .split('\n')
        .filter((line) => UPGRADE_NOTICE.test(line));
      if (stepRan) {
        expect(noticeLines, `the one-line upgrade notice in what smurg host printed:\n${after.out()}`).toHaveLength(1);
        // The owner's own case: it starts, ONE line, the two links. The line names the smurg that wrote the folder.
        expect(noticeLines[0]).toContain(`last shared with smurg ${(oldVersion as string).replace(/-.*$/, '')}:`);
        expect(after.out().startsWith(`${noticeLines[0]}\n\nsmurg is sharing "`), after.out()).toBe(true);
      } else {
        // Nothing but what a start has always printed.
        expect(noticeLines, after.out()).toEqual([]);
        expect(after.out().startsWith('\nsmurg is sharing "'), after.out()).toBe(true);
      }
      expect(after.err(), 'the new executable said nothing on stderr').toBe('');

      const end = await smurg(bin, ['stop'], env, project);
      expect(end.stdout).toContain('Stopped sharing.');
      expect(await after.exited).toBe(0);
      show(`smurg ${newVersion} (${basename(bin)}) on the folder smurg ${oldVersion} left`, after);

      // ---- a refusal, as the real executable words it (here in Traditional Chinese): a state file that other users
      // of the computer can read. The text names the file and the one command; nothing is changed; no "move".
      const stateFile = join(stateDir, 'state.json');
      const stateNow = await readFile(stateFile);
      await chmod(stateFile, 0o644);
      const refused = await smurg(bin, ['host', project, '--relay', relay.origin, '--no-keep-awake'], { ...env, SMURG_LANG: 'zh-TW' }, project);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain(`smurg：這個工作區有一個狀態檔，這台電腦的其他使用者也能存取（權限 644）：${stateFile}\n  沒有更動任何東西。\n`);
      expect(refused.stderr.endsWith(`再執行一次 smurg host：\n  chmod 600 ${stateFile}\n`), refused.stderr).toBe(true);
      expect(refused.stderr).not.toMatch(/\bmv\b/);
      // The whole terminal: no raw line of the daemon's log (a line that starts with a timestamp) above the words.
      expect(`${refused.stdout}\n${refused.stderr}`).not.toMatch(/^\d{4}-\d{2}-\d{2}T/m);
      expect((await readFile(stateFile)).equals(stateNow)).toBe(true);
      expect((await lstat(stateFile)).mode & 0o777).toBe(0o644);
      await chmod(stateFile, 0o600);
    }, 600_000);
  }
});
