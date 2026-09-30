// Share preparation and configuration: the daemon only creates `.smurg/` inside the shared folder (and excludes it
// from git), and refuses locations that would expose its own state or the whole home directory. Also the Claude Code
// version policy of config.sessions (minimum, verified versions, verdict).
import { readFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_MIN_VERSION, CLAUDE_VERIFIED_VERSIONS, claudeVersionVerdict, compareClaudeVersions, parseClaudeVersion, resolveConfig } from '../src/core/config.ts';
import { ShareError, prepareShare } from '../src/workspace/share.ts';
import { createTempDir, createTempProject, removeTempDir } from '../src/testing/temp.ts';

let base: string;

beforeEach(async () => {
  base = await createTempDir('share');
});

afterEach(async () => {
  await removeTempDir(base);
});

describe('prepareShare', () => {
  it('creates .smurg (0700) and excludes it from git once, without touching .gitignore', async () => {
    const project = await createTempProject(base, 'p', { files: { 'a.txt': 'a', '.gitignore': 'node_modules\n' }, git: true });
    const first = await prepareShare(project, join(base, 'state'), { homeDir: join(base, 'home') });
    expect(first).toMatchObject({ realPath: project, name: 'p', isGitRepo: true });
    expect(((await stat(join(project, '.smurg'))).mode & 0o777).toString(8)).toBe('700');
    await prepareShare(project, join(base, 'state'), { homeDir: join(base, 'home') });
    const exclude = await readFile(join(project, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line === '/.smurg/')).toHaveLength(1);
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toBe('node_modules\n');
  });

  it('works for folders that are not git repositories', async () => {
    const project = await createTempProject(base, 'plain', { files: { 'x.txt': 'x' } });
    expect(await prepareShare(project, join(base, 'state'), { homeDir: join(base, 'home') })).toMatchObject({ isGitRepo: false });
  });

  it('refuses the file system root, the home directory, and any overlap with the state directory', async () => {
    const home = join(base, 'home');
    await mkdir(join(home, '.smurg'), { recursive: true });
    await expect(prepareShare('/', join(base, 'state'), { homeDir: home })).rejects.toBeInstanceOf(ShareError);
    await expect(prepareShare(home, join(base, 'state'), { homeDir: home })).rejects.toThrow(/home directory/);
    await expect(prepareShare(home, join(home, '.smurg'), { homeDir: join(base, 'other') })).rejects.toThrow(/state directory must not be inside/);
    const state = join(base, 'st');
    await mkdir(join(state, 'project'), { recursive: true });
    await expect(prepareShare(join(state, 'project'), state, { homeDir: home })).rejects.toThrow(/inside the daemon state/);
    await expect(prepareShare(join(base, 'missing'), join(base, 'state'), { homeDir: home })).rejects.toThrow(/does not exist/);
  });

  it('refuses a folder that CONTAINS the home, with the state dir elsewhere (SMURG_HOME outside the home, CLI-04)', async () => {
    const t = join(base, 't');
    const home = join(t, 'home-h1');
    await mkdir(join(home, '.ssh'), { recursive: true });
    const stateDir = join(base, 'elsewhere', 'state'); // not inside the share: the old check let this through
    await expect(prepareShare(t, stateDir, { homeDir: home, homesParents: [] })).rejects.toThrow(/contains the home directory/);
    await expect(stat(join(t, '.smurg'))).rejects.toMatchObject({ code: 'ENOENT' }); // refused before touching it
    // A project inside the home is fine.
    const project = await createTempProject(home, 'proj', { files: { 'a.txt': 'a' } });
    expect(await prepareShare(project, stateDir, { homeDir: home, homesParents: [] })).toMatchObject({ realPath: project });
  });

  it("refuses a folder that contains the accounts' homes (/Users, /home), even when the host's home is elsewhere", async () => {
    const machine = join(base, 'machine');
    const homes = join(machine, 'Users');
    await mkdir(join(homes, 'bob', '.ssh'), { recursive: true });
    const options = { homeDir: join(base, 'my-home'), homesParents: [homes] };
    await expect(prepareShare(machine, join(base, 'state'), options)).rejects.toThrow(/contains the home directories/);
    await expect(prepareShare(homes, join(base, 'state'), options)).rejects.toThrow(/contains the home directories/);
    const shared = await createTempProject(homes, 'Shared', { files: { 'a.txt': 'a' } }); // like /Users/Shared/proj
    expect(await prepareShare(shared, join(base, 'state'), options)).toMatchObject({ realPath: shared });
  });
});

describe('resolveConfig', () => {
  const valid = { stateDir: '/tmp/s', shareDir: '/tmp/p', workspaceId: 'ws_test_0123456789', hostUserId: 'dev:host', hostName: 'Host' };

  it('fills defaults and derives the workspace state dir', () => {
    const config = resolveConfig({ ...valid, relayUrl: 'https://relay.example/ignored-path' });
    expect(config.workspaceStateDir).toBe('/tmp/s/workspaces/ws_test_0123456789');
    expect(config.relayUrl).toBe('https://relay.example');
    expect(config.webOrigin).toBe('https://relay.example');
    expect(config.identityIssuer).toBe('https://relay.example');
    expect(config.timing.relayPingIntervalMs).toBe(2_000);
    expect(config.timing.pongWatchdogMs).toBe(6_000);
    expect(config.timing.presenceHeartbeatMs).toBe(3_000);
    expect(config.limits.maxFailedHandshakesPerConn).toBe(5);
    expect(config.defaultSettings.diskReservePercent).toBe(5);
  });

  it('puts the sockets in <stateDir>/run by default and refuses a run dir whose socket paths macOS would truncate', () => {
    const config = resolveConfig(valid);
    expect(config.runDir).toBe('/tmp/s/run');
    expect(config.runPaths.hook).toMatch(/^\/tmp\/s\/run\/[A-Za-z0-9]{12}\.hook$/);
    expect(config.runPaths.ctl).toMatch(/^\/tmp\/s\/run\/[A-Za-z0-9]{12}\.ctl$/);
    expect(() => resolveConfig({ ...valid, stateDir: `/${'s'.repeat(100)}` })).toThrow(/socket path/);
    expect(resolveConfig({ ...valid, stateDir: `/${'s'.repeat(100)}`, runDir: '/tmp/r' }).runDir).toBe('/tmp/r');
  });

  it('session launch seams: defaults, absolute paths only, and a test-only guest env that no real relay accepts', () => {
    const config = resolveConfig(valid);
    expect(config.sessions).toEqual({
      hostHome: null,
      claudePath: null,
      claudeMinVersion: '2.1.220',
      claudeVerifiedVersions: ['2.1.220', '2.1.283'],
      selfCommand: null,
      testGuestEnv: null,
      guestSubscriptionLogin: true,
    });
    // ARCHITECTURE §11 D-12 / D-13 switches: on by default, booleans only.
    expect(config.activity).toEqual({ attributeBashEdits: true });
    expect(resolveConfig({ ...valid, sessions: { guestSubscriptionLogin: false }, activity: { attributeBashEdits: false } })).toMatchObject({ sessions: { guestSubscriptionLogin: false }, activity: { attributeBashEdits: false } });
    expect(() => resolveConfig({ ...valid, sessions: { guestSubscriptionLogin: 'no' as unknown as boolean } })).toThrow(/guestSubscriptionLogin/);
    expect(() => resolveConfig({ ...valid, activity: { attributeBashEdits: 0 as unknown as boolean } })).toThrow(/attributeBashEdits/);
    const local = resolveConfig({ ...valid, relayUrl: 'http://127.0.0.1:8787', sessions: { hostHome: '/tmp/fake-home', testGuestEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } } });
    expect(local.sessions.testGuestEnv).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' });
    expect(() => resolveConfig({ ...valid, relayUrl: 'https://smurg.app', sessions: { testGuestEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } } })).toThrow(/local relay only/);
    expect(() => resolveConfig({ ...valid, sessions: { testGuestEnv: { 'bad-name': 'x' } } })).toThrow();
    expect(() => resolveConfig({ ...valid, sessions: { hostHome: 'relative' } })).toThrow();
    expect(() => resolveConfig({ ...valid, sessions: { selfCommand: { file: 'node', args: [] } } })).toThrow();
  });

  it('Claude Code version config: sorted, de-duplicated verified list; malformed values and a minimum above every verified version are refused', () => {
    const config = resolveConfig({ ...valid, sessions: { claudeMinVersion: '2.1.250', claudeVerifiedVersions: ['2.1.283', '2.1.250', '2.1.283', '2.1.9'] } });
    expect(config.sessions.claudeMinVersion).toBe('2.1.250');
    expect(config.sessions.claudeVerifiedVersions).toEqual(['2.1.9', '2.1.250', '2.1.283']);
    expect(Object.isFrozen(config.sessions.claudeVerifiedVersions)).toBe(true);
    expect(() => resolveConfig({ ...valid, sessions: { claudeVerifiedVersions: [] } })).toThrow(/at least one/);
    expect(() => resolveConfig({ ...valid, sessions: { claudeVerifiedVersions: ['2.1'] } })).toThrow(/MAJOR.MINOR.PATCH/);
    expect(() => resolveConfig({ ...valid, sessions: { claudeVerifiedVersions: ['v2.1.283'] } })).toThrow(/MAJOR.MINOR.PATCH/);
    expect(() => resolveConfig({ ...valid, sessions: { claudeMinVersion: '2.1.283-beta' } })).toThrow(/MAJOR.MINOR.PATCH/);
    expect(() => resolveConfig({ ...valid, sessions: { claudeMinVersion: '2.1.300' } })).toThrow(/newer than every verified version/);
  });

  it.each([
    [{ stateDir: 'relative' }],
    [{ runDir: 'relative' }],
    [{ shareDir: 'relative' }],
    [{ workspaceId: 'short' }],
    [{ hostName: '  ' }],
    [{ relayUrl: 'ftp://x' }],
    [{ timing: { pongWatchdogMs: 0 } }],
    [{ timing: { reconnectJitter: 1.5 } }],
    [{ limits: { maxPendingHandshakes: -1 } }],
    [{ defaultSettings: { diskReservePercent: 101 } }],
  ])('rejects %j', (override) => {
    expect(() => resolveConfig({ ...valid, ...override } as never)).toThrow();
  });
});

describe('Claude Code version policy (ARCHITECTURE §7.6)', () => {
  const policy = resolveConfig({ stateDir: '/tmp/s', shareDir: '/tmp/p', workspaceId: 'ws_test_0123456789', hostUserId: 'dev:host', hostName: 'Host' }).sessions;

  it('the minimum is the oldest verified version, 2.1.220, and both 2.1.220 and 2.1.283 are verified', () => {
    expect(CLAUDE_MIN_VERSION).toBe('2.1.220');
    expect(CLAUDE_VERIFIED_VERSIONS).toEqual(['2.1.220', '2.1.283']);
    expect(policy.claudeMinVersion).toBe(CLAUDE_VERIFIED_VERSIONS[0]);
  });

  it('both verified versions start without a warning', () => {
    expect(claudeVersionVerdict('2.1.220 (Claude Code)\n', policy)).toEqual({ ok: true, version: '2.1.220', warning: null });
    expect(claudeVersionVerdict('2.1.283 (Claude Code)\n', policy)).toEqual({ ok: true, version: '2.1.283', warning: null });
  });

  it('refuse guest sessions below the minimum (fail closed)', () => {
    expect(claudeVersionVerdict('2.1.219 (Claude Code)', policy)).toEqual({ ok: false, version: '2.1.219', reason: 'below-minimum' });
    expect(claudeVersionVerdict('2.0.999 (Claude Code)', policy)).toEqual({ ok: false, version: '2.0.999', reason: 'below-minimum' });
    expect(claudeVersionVerdict('1.99.500 (Claude Code)', policy)).toEqual({ ok: false, version: '1.99.500', reason: 'below-minimum' });
  });

  it('output that carries no readable version is refused as well (fail closed)', () => {
    for (const output of ['', '\n', 'claude: command not found', 'v2.1.283', '2.1', '2.1.283-beta.1 (Claude Code)', 'Warning: x\n2.1.283 (Claude Code)', '02.1.283', '9999999999.1.1']) {
      expect(claudeVersionVerdict(output, policy), JSON.stringify(output)).toEqual({ ok: false, version: null, reason: 'unrecognized' });
    }
  });

  it('warn - not refuse - on versions newer than the newest verified one', () => {
    expect(claudeVersionVerdict('2.1.284 (Claude Code)', policy)).toEqual({ ok: true, version: '2.1.284', warning: 'newer-than-verified' });
    expect(claudeVersionVerdict('2.2.0', policy)).toEqual({ ok: true, version: '2.2.0', warning: 'newer-than-verified' });
    expect(claudeVersionVerdict('3.0.0 (Claude Code)', policy)).toEqual({ ok: true, version: '3.0.0', warning: 'newer-than-verified' });
  });

  it('a version between two verified ones that is not listed starts with a warning too', () => {
    expect(claudeVersionVerdict('2.1.250 (Claude Code)', policy)).toEqual({ ok: true, version: '2.1.250', warning: 'unverified' });
  });

  it('compares numerically, not as strings', () => {
    expect(compareClaudeVersions('2.1.220', '2.1.283')).toBeLessThan(0);
    expect(compareClaudeVersions('2.1.1000', '2.1.283')).toBeGreaterThan(0);
    expect(compareClaudeVersions('2.10.0', '2.9.999')).toBeGreaterThan(0);
    expect(compareClaudeVersions('2.1.283', '2.1.283')).toBe(0);
    expect(parseClaudeVersion('  2.1.283(Claude Code)')).toBe('2.1.283');
    expect(claudeVersionVerdict('2.1.1000', policy)).toEqual({ ok: true, version: '2.1.1000', warning: 'newer-than-verified' });
  });
});
