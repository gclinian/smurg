// What a PUBLISHED smurg left behind opens in the new one: the upgrade with REAL executables (0.5.1, DESIGN E2 and
// E-tests; docs/RELEASING.md runs it before every release with the executable of every published version `smurg update`
// can start from). Opt-in, beside sea-update.test.ts. From the repository's root:
//
//   SMURG_PREVIOUS_BINARIES=/path/to/v0.4.0/smurg-darwin-arm64:/path/to/v0.5.0/smurg-darwin-arm64:/path/to/v0.5.1/smurg-darwin-arm64:/path/to/v0.5.2/smurg-darwin-arm64:/path/to/v0.6.0/smurg-darwin-arm64 \
//   SMURG_SEA_BINARY=packages/cli/dist/smurg-darwin-arm64 \
//     pnpm --filter @smurg/cli exec vitest run test/sea-upgrade.test.ts
//
//   SMURG_PREVIOUS_BINARIES  one or more published executables (downloaded from https://downloads.smurg.ai/v<X.Y.Z>/ and
//                            checked against that version's SHA256SUMS), separated by ":";
//   SMURG_SEA_BINARY         the executable of this tree (scripts/build-sea.sh).
// A path that is not absolute is read from the repository's root, whatever folder the runner is in (`pnpm --filter …
// exec` runs vitest in packages/cli). What a run does with the two variables is decided in ./sea-binaries.ts and held
// by sea-upgrade-asked.test.ts; a release must not pass because this did not run:
//   - without both it is SKIPPED, and one line on stderr says so (written when this file is loaded, outside any test
//     body, so that every reporter shows it); with SMURG_RELEASE_GATE=1 that is a FAILURE;
//   - with only one of the two it FAILS and names the missing one;
//   - a named file that is not an executable FAILS with one plain sentence, before anything is started.
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
//   6. the OLD executable shares the folder once more (0.6.0, DESIGN D2): it refuses what the new one wrote, before it
//      connects anywhere, with its own words (0.5.1, 0.5.2 and 0.6.0: "Nothing was changed.", "Run smurg update, then
//      smurg host again."), and the workspace's state folder is byte for byte what it was;
//   7. a state file that other users can read is refused by the new executable (run in Traditional Chinese): the text
//      names the file and the one chmod, never "move", and the file is as it was.
// 0.6.0 (DESIGN D6, D13): every published smurg's state.json needs the step to 0.6.0 (workspaces switch to auto mode,
// the owner's decision), so for each of them the upgrade line AND the line about auto mode are printed, the old file
// is kept, and the stamp names shapes 2. 0.7.0 (DESIGN 0.7.0 D4): every published state.json, 0.6.0's included, needs
// the step from 0.6.0 too (automatic merging, the owner's words of 2026-10-26): the old file is kept under the name of
// the first step that ran, the stamp names shapes 3, and after the upgrade line `smurg host` prints the line about
// auto mode only for what 0.5.2 or an older smurg wrote (0.6.0's workspaces are in auto mode already), then, for
// every published smurg, ONE line about automatic merging (DESIGN 0.7.0 D18, `host.mergesAuto`).
// The relay is the fake relay of these tests (the relay never reads a frame, and its own source did not change between
// 0.4.0 and 0.5.0): logins and the workspace claim are its HTTP API; the NEW host's relay links are tunnelled to an
// in-memory relay so that the test can reach it as the host's console does. Only processes this test started are ever
// signalled, by their recorded pid.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { chmod, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '@smurg/daemon';
import { MemoryRelay, TestIdentityIssuer, waitFor } from '@smurg/daemon/testing';
import { deriveInviteKeys, parseInviteUrl } from '@smurg/protocol';
import { RelayWorkspaceChannel } from '../src/channel/relay-channel.ts';
import { statePaths, workspaceStateDir } from '../src/state/paths.ts';
import { startFakeRelay, type FakeRelay } from './fake-relay.ts';
import { isolatedEnv, makeDirs } from './helpers.ts';
import { upgradePlan } from './sea-binaries.ts';

const PLAN = upgradePlan();
const NEW = PLAN.kind === 'run' ? PLAN.next : null;
const PREVIOUS = PLAN.kind === 'run' ? PLAN.previous : [];

// Loud on purpose, and OUTSIDE any test body: the default reporter shows nothing of a skipped test (a file that is
// silently skipped reads as "covered"), so the line goes to stderr when the file is loaded.
if (PLAN.kind === 'skipped') process.stderr.write(`\n${PLAN.line}\n\n`);
if (PLAN.kind === 'failed') process.stderr.write(`\n${PLAN.problems.map((problem) => `[sea-upgrade] ${problem}`).join('\n')}\n\n`);

// Only what this run is gets registered (not three suites of which two are skipped): a run that tested the upgrade
// reports its tests as passed and NOTHING as skipped, so "skipped" in a run's last lines always means "not tested".
if (PLAN.kind === 'skipped') {
  const { line } = PLAN;
  describe('the upgrade with real executables', () => {
    it('NOT TESTED without SMURG_PREVIOUS_BINARIES and SMURG_SEA_BINARY', (context) => {
      context.skip(line);
    });
  });
}

// The run was asked for (a variable is set, or this is a release's gate) and cannot be what was asked for: a failure
// with the reason as a plain sentence, never a skip and never the error of a process that could not be started.
if (PLAN.kind === 'failed') {
  const { problems } = PLAN;
  describe('the upgrade with real executables was asked for and cannot run', () => {
    it('the upgrade can be tested with what SMURG_PREVIOUS_BINARIES and SMURG_SEA_BINARY name', () => {
      throw new Error(problems.join('\n'));
    });
  });
}

/**
 * The one line `smurg host` prints when this start upgraded what an earlier smurg wrote (DESIGN A7 and C: "this
 * workspace was last shared with smurg X (or an earlier smurg); members, invite links and settings were carried
 * over; the guide's address"). The words themselves are in the catalog (`host.upgraded`) and are held word for word,
 * in both languages, by host-state-file.test.ts; here it is the real executable that has to say them.
 */
const UPGRADE_NOTICE = /last shared with (?:smurg \d+\.\d+\.\d+|an earlier smurg).*carried over/i;
/** The line of a start that switched the workspace to auto mode (DESIGN 0.6.0 D13; `host.agentsAuto`, held word for word by host-state-words.test.ts). */
const AGENTS_AUTO = /^Agents now run in auto mode: .*Guide: https:\/\/smurg\.ai\/docs\/hosting\/#52-what-agents-do-by-themselves-and-what-they-ask-first$/;
/** The line of a start that turned automatic merging on (DESIGN 0.7.0 D18; `host.mergesAuto`, held word for word by host-state-words.test.ts). */
const MERGES_AUTO = /^Work items now merge by themselves: .*Guide: https:\/\/smurg\.ai\/docs\/hosting\/#103-merging-and-what-waits-for-it$/;
/** Whether the step from 0.5.0 ran too (DESIGN 0.6.0 D13: what 0.5.2 or an older smurg wrote switches to auto mode; 0.6.0's own folder does not). */
const switchesToAutoMode = (version: string): boolean => /^0\.(4|5)\./.test(version);
/**
 * What each published smurg says of a folder 0.6.0 wrote (recorded with the published executables, 2026-10-20): 0.5.1
 * and later read the stamp (`shapes` 2) and say it is a newer smurg's; 0.4.0 and 0.5.0 have no stamp reader, and their
 * strict schema refuses state.json version 2 with their one refusal text. A folder 0.7.0 wrote (stamp `shapes` 3,
 * state.json version 3) meets the same words, 0.6.0's executable among those that read the stamp (DESIGN 0.7.0 D2).
 */
function refusalWords(version: string): readonly string[] {
  if (/^0\.(4\.|5\.0$)/.test(version)) return ["This workspace's state files were written by another smurg version", 'the daemon refused to start'];
  return ['a newer smurg than this one', 'Nothing was changed.', 'Run smurg update, then smurg host again.'];
}

/** Every file of a folder, by its path inside it, with its bytes (what "byte for byte" compares). */
async function filesOf(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out.set(path, (await readFile(join(dir, path))).toString('base64'));
      else out.set(path, `<${entry.isSymbolicLink() ? 'link' : 'other'}>`);
    }
  };
  await walk('');
  return out;
}

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

describe.runIf(PLAN.kind === 'run')('the upgrade with real executables: what each published smurg left behind opens in the new one (SMURG_PREVIOUS_BINARIES, SMURG_SEA_BINARY)', () => {
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

      // What the daemon's part of the upgrade left (DESIGN A5, A9; 0.6.0 D6): the old state.json kept byte for byte,
      // named after the first step that ran (0.4.0 for what 0.4.0 wrote, 0.6.0 for what 0.6.0 wrote, else 0.5.0), and the
      // stamp of the smurg that wrote the folder last, with today's shapes.
      const copies = (await readdir(stateDir)).filter((name) => name.includes('.before-upgrade-from-')).sort();
      const from = (oldVersion as string).startsWith('0.4.') ? '0.4.0' : (oldVersion as string).startsWith('0.6.') ? '0.6.0' : '0.5.0';
      expect(copies).toContain(`state.json.before-upgrade-from-${from}`);
      expect((await readFile(join(stateDir, `state.json.before-upgrade-from-${from}`))).equals(oldState)).toBe(true);
      expect((await lstat(join(stateDir, `state.json.before-upgrade-from-${from}`))).mode & 0o777).toBe(0o600);
      const stamp = JSON.parse(await readFile(join(stateDir, 'written-by.json'), 'utf8')) as { smurg: unknown; shapes: unknown };
      expect(stamp.shapes).toBe(3);
      expect(typeof stamp.smurg).toBe('string');
      expect((JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')) as { version: unknown; settings: { permissionMode: unknown; merging: unknown } })).toMatchObject({ version: 3, settings: { permissionMode: 'auto', merging: 'auto' } });

      // The command's part (DESIGN A7, C; step K3B; 0.6.0 D13; 0.7.0 D18): the upgrade in ONE line, naming the smurg
      // that last wrote the folder, then ONE line about auto mode (what 0.5.2 or an older smurg wrote), then ONE line
      // about automatic merging, then the start as always.
      const lines = after.out().split('\n');
      const noticeLines = lines.filter((line) => UPGRADE_NOTICE.test(line));
      const autoLines = lines.filter((line) => AGENTS_AUTO.test(line));
      const mergeLines = lines.filter((line) => MERGES_AUTO.test(line));
      const toAutoMode = switchesToAutoMode(oldVersion as string);
      expect(noticeLines, `the one-line upgrade notice in what smurg host printed:\n${after.out()}`).toHaveLength(1);
      expect(autoLines, `the line about auto mode in what smurg host printed:\n${after.out()}`).toHaveLength(toAutoMode ? 1 : 0);
      expect(mergeLines, `the line about automatic merging in what smurg host printed:\n${after.out()}`).toHaveLength(1);
      expect(noticeLines[0]).toContain(`last shared with smurg ${(oldVersion as string).replace(/-.*$/, '')}:`);
      const found = [noticeLines[0], ...(toAutoMode ? [autoLines[0]] : []), mergeLines[0]];
      expect(after.out().startsWith(`${found.join('\n\n')}\n\nsmurg is sharing "`), after.out()).toBe(true);
      expect(after.err(), 'the new executable said nothing on stderr').toBe('');

      const end = await smurg(bin, ['stop'], env, project);
      expect(end.stdout).toContain('Stopped sharing.');
      expect(await after.exited).toBe(0);
      show(`smurg ${newVersion} (${basename(bin)}) on the folder smurg ${oldVersion} left`, after);

      // ---- the OLD executable once more, on what the new one wrote (DESIGN 0.6.0 D2): refused before it connects,
      // and the workspace's state folder is byte for byte what it was.
      const stateBefore = await filesOf(stateDir);
      const oldAgain = startHost(old, project, relay.origin, env);
      await waitFor(() => !oldAgain.alive() || (oldAgain.out().match(/\/join\//g) ?? []).length >= 2, { timeoutMs: 120_000, what: `smurg ${oldVersion} to refuse or start` });
      if (oldAgain.alive()) throw new Error(`smurg ${oldVersion} shared a folder smurg ${newVersion} wrote:\n${oldAgain.out()}`);
      const code = await oldAgain.exited;
      const said = `${oldAgain.out()}${oldAgain.err()}`;
      console.info(`[sea-upgrade] smurg ${oldVersion} on what smurg ${newVersion} wrote: exit ${String(code)}\n${said}`);
      expect(code, said).not.toBe(0);
      for (const words of refusalWords(oldVersion as string)) expect(said, oldVersion as string).toContain(words);
      expect(await filesOf(stateDir)).toEqual(stateBefore);
      // What the share's `.smurg` holds afterwards: what 0.6.0 left (its .gitignore); the refusing start's lock is gone.
      const smurgDir = [...(await filesOf(join(project, '.smurg'))).keys()].sort();
      console.info(`[sea-upgrade] what the share's .smurg holds after smurg ${oldVersion}: ${JSON.stringify(smurgDir)}`);
      expect(smurgDir).toEqual(['.gitignore']);

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
