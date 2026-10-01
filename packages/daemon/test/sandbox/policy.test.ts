// The pure policy builder (src/sandbox/policy.ts): the generated srt configuration for main-workspace mode and
// worktree mode, the Linux variant, and every contradiction it must refuse. A small model of srt's documented rule
// order (deny regions → allow carve-outs → nested denies again; writes: allow roots → deny) evaluates the policy for
// paths that cannot exist on a test machine (a share at /srv/proj, outside every broad region); the real-srt tests in
// r5.sandbox.test.ts cover the same properties for paths that do exist.
import { isHostOnlyPath } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import {
  DARWIN_BROAD_DENY_READ,
  HOST_ONLY_DIR_NAMES,
  HOST_ONLY_FILE_NAMES,
  LINUX_BROAD_DENY_READ,
  PolicyError,
  buildBaseConfig,
  buildSessionPolicy,
  isAtOrUnder,
  isStrictlyUnder,
  readCarveOutProblem,
  type SessionPolicy,
  type SessionPolicyInput,
} from '../../src/sandbox/policy.ts';
import { loadSrt } from '../../src/sandbox/runtime.ts';

// ---- a model of srt's macOS semantics (sandbox-manager.js / macos-sandbox-utils.js 0.0.77) ----

function globRegex(pattern: string, denyTail: boolean): RegExp {
  const body = pattern
    .replace(/[.^$+{}()|\\]/g, '\\$&')
    .replace(/\*\*\//g, '__GS__')
    .replace(/\*/g, '[^/]*')
    .replace(/__GS__/g, '(.*/)?');
  return new RegExp(`^${body}${denyTail ? '(/.*)?' : ''}$`);
}
const isGlob = (entry: string): boolean => /[*?[\]]/.test(entry);
const matchesDeny = (entry: string, path: string): boolean => (isGlob(entry) ? globRegex(entry, true).test(path) : isAtOrUnder(path, entry));

function canRead(policy: SessionPolicy, path: string): boolean {
  const { denyRead, allowRead } = policy.perSession.filesystem;
  let readable = !denyRead.some((d) => matchesDeny(d, path));
  if (allowRead.some((a) => isAtOrUnder(path, a))) readable = true;
  const late = denyRead.filter((d) => isGlob(d) || allowRead.some((a) => !isGlob(a) && isStrictlyUnder(d, a)));
  if (late.some((d) => matchesDeny(d, path))) readable = false;
  return readable;
}

function canWrite(policy: SessionPolicy, path: string): boolean {
  const { allowWrite, denyWrite } = policy.perSession.filesystem;
  return allowWrite.some((w) => isAtOrUnder(path, w)) && !denyWrite.some((d) => matchesDeny(d, path));
}

// ---- fixtures ----

const HOME = '/Users/host';
const STATE = '/Users/host/.smurg';
const SHARE = '/Users/host/projects/app';
const CLAUDE = '/Users/host/.local/share/claude/versions/2.1.220';
const HOOK = '/Users/host/.smurg/run/abcdefghijkl.hook';

function mainInput(overrides: Partial<SessionPolicyInput> = {}): SessionPolicyInput {
  return {
    platform: 'darwin',
    hostHome: HOME,
    stateDir: STATE,
    shareDir: SHARE,
    worktreesDir: `${SHARE}/.smurg/worktrees`,
    mode: 'main',
    rootPath: SHARE,
    guestDir: `${STATE}/guests/ws_1/alice`,
    settingsDir: `${STATE}/sessions/ses_1`,
    readOnlyPaths: [`${SHARE}/data`],
    extraReadPaths: [CLAUDE],
    selfCommandPaths: [],
    shareGitObjectsDir: null,
    extraDenyRead: [],
    extraDenyWrite: [],
    hookSocketPath: HOOK,
    envNames: ['PATH', 'HOME', 'ANTHROPIC_API_KEY'],
    ...overrides,
  };
}

const SRV = '/srv/proj';
const WT = `${SRV}/.smurg/worktrees/wt1`;

function worktreeInput(overrides: Partial<SessionPolicyInput> = {}): SessionPolicyInput {
  return mainInput({
    shareDir: SRV,
    worktreesDir: `${SRV}/.smurg/worktrees`,
    mode: 'worktree',
    rootPath: WT,
    readOnlyPaths: [`${SRV}/data`],
    shareGitObjectsDir: `${SRV}/.git/objects`,
    // what the sessions module passes in worktree mode (interfaces.ts SandboxSpec)
    extraDenyRead: [SRV, `${SRV}/.smurg/worktrees`],
    extraDenyWrite: [SRV, `${SRV}/.smurg/worktrees`],
    ...overrides,
  });
}

describe('buildSessionPolicy — main-workspace mode (macOS)', () => {
  const policy = buildSessionPolicy(mainInput());
  const fs = policy.perSession.filesystem;

  it('denies the host home, other users, volumes, temp regions, the daemon state dir and <share>/.smurg for reading', () => {
    expect(fs.denyRead).toEqual(expect.arrayContaining([...DARWIN_BROAD_DENY_READ, HOME, STATE, `${SHARE}/.smurg`]));
  });

  it('hides ancestor memory files and the host-personal Claude files of the share at any depth', () => {
    expect(fs.denyRead).toEqual(
      expect.arrayContaining([`${HOME}/CLAUDE.md`, `${HOME}/.claude`, `${HOME}/projects/CLAUDE.md`, '/CLAUDE.md', `${SHARE}/**/.claude/settings.local.json`, `${SHARE}/**/CLAUDE.local.md`]),
    );
  });

  it('allows reading exactly the root, the guest dir, the settings dir, the hook socket, the shared dirs and the claude binary', () => {
    expect(fs.allowRead).toEqual([SHARE, `${STATE}/guests/ws_1/alice`, `${STATE}/sessions/ses_1`, HOOK, `${SHARE}/data`, CLAUDE]);
  });

  it('allows writing only the root and the guest dir', () => {
    expect(fs.allowWrite).toEqual([SHARE, `${STATE}/guests/ws_1/alice`]);
    expect(policy.writeRoots).toEqual(fs.allowWrite);
  });

  it('denies writing every host-only path of §5.2 at any depth, the shared dirs and the settings dir', () => {
    for (const name of [...HOST_ONLY_DIR_NAMES, ...HOST_ONLY_FILE_NAMES]) {
      expect(fs.denyWrite).toContain(`${SHARE}/${name}`);
      expect(fs.denyWrite).toContain(`${SHARE}/**/${name}`);
    }
    expect(fs.denyWrite).toEqual(expect.arrayContaining([`${SHARE}/data`, `${STATE}/sessions/ses_1`, '/tmp/claude', '/private/tmp/claude']));
  });

  it('keeps the login-override variables out, except those the session sets on purpose', () => {
    const names = policy.perSession.credentials.envVars.map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'SSH_AUTH_SOCK']));
    expect(names).not.toContain('ANTHROPIC_API_KEY');
    expect(policy.perSession.credentials.envVars.every((v) => v.mode === 'deny')).toBe(true);
    expect(policy.perSession.allowPty).toBe(true);
  });

  it('evaluates as intended under srt’s rule order', () => {
    expect(canRead(policy, `${SHARE}/src/a.ts`)).toBe(true);
    expect(canRead(policy, `${SHARE}/.git/config`)).toBe(true);
    expect(canRead(policy, `${SHARE}/.smurg/worktrees/wt1/x`)).toBe(false);
    expect(canRead(policy, `${SHARE}/.claude/settings.json`)).toBe(true);
    expect(canRead(policy, `${SHARE}/.claude/settings.local.json`)).toBe(false);
    expect(canRead(policy, `${SHARE}/pkg/CLAUDE.local.md`)).toBe(false);
    // direnv's .envrc: hidden from guest agents as PathGuard hides it from guest people (review SEC-D-03).
    expect(canRead(policy, `${SHARE}/.envrc`)).toBe(false);
    expect(canRead(policy, `${SHARE}/pkg/deep/.envrc`)).toBe(false);
    expect(canRead(policy, `${SHARE}/pkg/envrc.md`)).toBe(true);
    expect(canRead(policy, `${HOME}/.ssh/id_ed25519`)).toBe(false);
    expect(canRead(policy, `${HOME}/.claude/CLAUDE.md`)).toBe(false);
    expect(canRead(policy, `${STATE}/guests/ws_1/bob/secret`)).toBe(false);
    expect(canRead(policy, `${STATE}/workspaces/ws_1/identity.key`)).toBe(false);
    expect(canRead(policy, `${STATE}/guests/ws_1/alice/home/x`)).toBe(true);
    expect(canRead(policy, `${STATE}/sessions/ses_1/settings.json`)).toBe(true);
    expect(canRead(policy, `${STATE}/sessions/ses_2/settings.json`)).toBe(false);
    expect(canRead(policy, '/Users/other/x')).toBe(false);
    expect(canWrite(policy, `${SHARE}/src/a.ts`)).toBe(true);
    expect(canWrite(policy, `${SHARE}/.claude/settings.json`)).toBe(false);
    expect(canWrite(policy, `${SHARE}/sub/deep/.vscode/settings.json`)).toBe(false);
    expect(canWrite(policy, `${SHARE}/.git/hooks/pre-commit`)).toBe(false);
    expect(canWrite(policy, `${SHARE}/data/x.csv`)).toBe(false);
    expect(canWrite(policy, `${STATE}/sessions/ses_1/settings.json`)).toBe(false);
    expect(canWrite(policy, `${STATE}/guests/ws_1/alice/tmp/x`)).toBe(true);
    expect(canWrite(policy, `${HOME}/x`)).toBe(false);
  });
});

describe('buildSessionPolicy — worktree mode with the share outside every broad region (/srv/proj)', () => {
  const policy = buildSessionPolicy(worktreeInput());
  const fs = policy.perSession.filesystem;

  it('denies the main share and the worktrees dir for reading, carving out the worktree, .git/objects and the shared dirs', () => {
    expect(fs.denyRead).toEqual(expect.arrayContaining([SRV, `${SRV}/.smurg/worktrees`]));
    expect(fs.allowRead).toEqual(expect.arrayContaining([WT, `${SRV}/.git/objects`, `${SRV}/data`]));
    expect(fs.allowRead).not.toContain(SRV);
    expect(fs.allowRead).not.toContain(`${SRV}/.git`);
  });

  it('writes only the worktree and the guest dir; denies that would contain the worktree are dropped, not applied', () => {
    expect(fs.allowWrite).toEqual([WT, `${STATE}/guests/ws_1/alice`]);
    for (const deny of fs.denyWrite) expect(isAtOrUnder(WT, deny), deny).toBe(false);
    expect(policy.dropped).toEqual(expect.arrayContaining([SRV, `${SRV}/.smurg/worktrees`]));
    expect(fs.denyWrite).toEqual(expect.arrayContaining([`${WT}/.git`, `${WT}/**/.git`, `${WT}/**/.claude`]));
  });

  it('R9.1 / R9.2 under srt’s rule order: no main workspace, no sibling, shared dirs read-only', () => {
    expect(canRead(policy, `${SRV}/README.md`)).toBe(false);
    expect(canRead(policy, `${SRV}/.git/config`)).toBe(false);
    expect(canRead(policy, `${SRV}/.git/objects/ab/cdef`)).toBe(true);
    expect(canRead(policy, `${SRV}/.smurg/worktrees/wt2/src/a.ts`)).toBe(false);
    expect(canRead(policy, `${SRV}/.smurg/uploads/partial`)).toBe(false);
    expect(canRead(policy, `${WT}/src/a.ts`)).toBe(true);
    expect(canRead(policy, `${SRV}/data/dataset.csv`)).toBe(true);
    expect(canWrite(policy, `${SRV}/data/dataset.csv`)).toBe(false);
    expect(canWrite(policy, `${SRV}/README.md`)).toBe(false);
    expect(canWrite(policy, `${SRV}/.smurg/worktrees/wt2/x`)).toBe(false);
    expect(canWrite(policy, `${WT}/src/a.ts`)).toBe(true);
    expect(canWrite(policy, `${WT}/.git/config`)).toBe(false);
    expect(canWrite(policy, `${WT}/.git/objects/info/alternates`)).toBe(false);
  });
});

// ARCHITECTURE §11 D-12: the guest's Claude login process. Its root is the guest's home; it gets the guest dir only.
describe('buildSessionPolicy — login mode (the guest\'s Claude login process, D-12)', () => {
  const GUEST = `${STATE}/guests/ws_1/alice`;
  const loginInput = (overrides: Partial<SessionPolicyInput> = {}): SessionPolicyInput =>
    mainInput({ mode: 'login', rootPath: `${GUEST}/home`, readOnlyPaths: [], envNames: ['PATH', 'HOME'], ...overrides });

  it('reads and writes the guest dir only; the share (wherever it is), the worktrees, the host home and the state dir are denied', () => {
    for (const share of [SHARE, SRV]) {
      const policy = buildSessionPolicy(loginInput({ shareDir: share, worktreesDir: `${share}/.smurg/worktrees` }));
      expect(policy.writeRoots).toEqual([GUEST]);
      expect(policy.perSession.filesystem.allowRead).toEqual([GUEST, `${STATE}/sessions/ses_1`, CLAUDE]);
      expect(policy.perSession.filesystem.denyRead).toEqual(expect.arrayContaining([share, `${share}/.smurg/worktrees`, HOME, STATE]));
      for (const path of [`${GUEST}/home/x`, `${GUEST}/cfg/.credentials.json`]) {
        expect(canRead(policy, path), path).toBe(true);
        expect(canWrite(policy, path), path).toBe(true);
      }
      for (const path of [`${share}/README.md`, `${share}/.smurg/worktrees/wt1/a`, `${HOME}/.ssh/id_ed25519`, `${STATE}/workspaces/ws_1/state.json`, `${STATE}/guests/ws_1/bob/cfg/.credentials.json`]) {
        expect(canRead(policy, path), path).toBe(false);
        expect(canWrite(policy, path), path).toBe(false);
      }
      expect(canRead(policy, `${STATE}/sessions/ses_1/x`)).toBe(true);
      expect(canWrite(policy, `${STATE}/sessions/ses_1/x`)).toBe(false);
      expect(canRead(policy, HOOK)).toBe(false); // it runs no hook
    }
  });

  it('reads and writes nothing that an agent session of the same guest (main-workspace mode) cannot: the one extra right is the listen of the hardening step', () => {
    for (const share of [SHARE, SRV]) {
      const login = buildSessionPolicy(loginInput({ shareDir: share, worktreesDir: `${share}/.smurg/worktrees`, extraReadPaths: [CLAUDE] }));
      const agent = buildSessionPolicy(mainInput({ shareDir: share, worktreesDir: `${share}/.smurg/worktrees`, rootPath: share, readOnlyPaths: [], extraReadPaths: [CLAUDE] }));
      const ancestors = (p: string): string[] => {
        const out: string[] = [];
        for (let d = p; d !== '/'; d = d.slice(0, d.lastIndexOf('/')) || '/') out.push(d);
        return [...out, '/'];
      };
      const probes = new Set<string>([
        ...[share, `${GUEST}/home`, `${STATE}/sessions/ses_1`].flatMap(ancestors).flatMap((dir) => ['CLAUDE.md', 'CLAUDE.local.md', '.claude/settings.json'].map((name) => `${dir === '/' ? '' : dir}/${name}`)),
        `${share}/README.md`, `${share}/.claude/settings.local.json`, `${share}/.envrc`, `${share}/.git/config`, `${share}/.smurg/worktrees/wt1/a`,
        `${HOME}/.ssh/id_ed25519`, `${STATE}/workspaces/ws_1/state.json`, `${STATE}/guests/ws_1/bob/cfg/.credentials.json`, HOOK,
        `${GUEST}/home/x`, `${GUEST}/cfg/.credentials.json`, `${STATE}/sessions/ses_1/settings.json`, `${CLAUDE}`,
        '/etc/hosts', '/usr/bin/true', '/private/tmp/x', '/Volumes/disk/x', '/Users/other/x', '/opt/x/CLAUDE.md',
      ]);
      for (const path of probes) {
        if (canRead(login, path)) expect(canRead(agent, path), `the login reads ${path}, an agent session cannot`).toBe(true);
        if (canWrite(login, path)) expect(canWrite(agent, path), `the login writes ${path}, an agent session cannot`).toBe(true);
      }
      expect(canRead(login, '/CLAUDE.md')).toBe(false);
      expect(canRead(login, `${share.slice(0, share.lastIndexOf('/'))}/CLAUDE.md`)).toBe(false);
    }
  });

  it.each<[string, Partial<SessionPolicyInput>]>([
    ['a root outside the guest dir (the share)', { rootPath: SHARE }],
    ['the guest dir itself as root', { rootPath: `${STATE}/guests/ws_1/alice` }],
    ['a shared read-only dir', { readOnlyPaths: [`${SHARE}/data`] }],
    ['a smurg command path', { selfCommandPaths: ['/opt/smurg/bin/smurg'] }],
    ['a read carve-out inside the share', { extraReadPaths: [`${SHARE}/tool`] }],
    ['a settings dir inside the guest dir', { settingsDir: `${STATE}/guests/ws_1/alice/s` }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => buildSessionPolicy(loginInput(overrides))).toThrow(PolicyError);
  });
});

describe('buildBaseConfig', () => {
  it('macOS: strict allow-list, private ranges denied, exactly the hook socket, pty, git config protected', () => {
    const base = buildBaseConfig({ platform: 'darwin', hostHome: HOME, stateDir: STATE, hookSocketPath: HOOK, allowedDomains: ['api.anthropic.com', 'api.anthropic.com', '127.0.0.1:9'] });
    expect(base.network).toEqual({
      allowedDomains: ['api.anthropic.com', '127.0.0.1:9'],
      deniedDomains: [],
      strictAllowlist: true,
      deniedResolvedAddresses: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7'],
      allowUnixSockets: [HOOK],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    });
    expect(base.filesystem).toEqual({ denyRead: [...DARWIN_BROAD_DENY_READ, HOME, STATE], allowRead: [], allowWrite: [], denyWrite: [] });
    expect(base.allowPty).toBe(true);
    expect(base.allowGitConfig).toBe(false);
    expect(base.bwrapPath).toBeUndefined();
  });

  it('Linux: absolute tool paths, every Unix socket allowed but the socket directories hidden', () => {
    const base = buildBaseConfig({ platform: 'linux', hostHome: '/home/host', stateDir: '/home/host/.smurg', hookSocketPath: '/home/host/.smurg/run/a.hook', allowedDomains: [], linuxTools: { bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', rg: '/usr/bin/rg' } });
    expect(base.network.allowAllUnixSockets).toBe(true);
    expect(base.filesystem.denyRead).toEqual(expect.arrayContaining(['/run', '/var/run', '/home', '/root', '/tmp', '/var/tmp', '/mnt', '/media', '/home/host', '/home/host/.smurg']));
    expect(base).toMatchObject({ bwrapPath: '/usr/bin/bwrap', socatPath: '/usr/bin/socat', ripgrep: { command: '/usr/bin/rg' } });
    expect(() => buildBaseConfig({ platform: 'linux', hostHome: '/home/host', stateDir: '/home/host/.smurg', hookSocketPath: '/h.hook', allowedDomains: [] })).toThrow(PolicyError);
  });

  it('Linux session policy: the Linux regions, and the hook socket readable through its tmpfs-hidden directory', () => {
    const policy = buildSessionPolicy(mainInput({ platform: 'linux', hostHome: '/home/host', stateDir: '/home/host/.smurg', shareDir: '/home/host/p', worktreesDir: '/home/host/p/.smurg/worktrees', rootPath: '/home/host/p', guestDir: '/home/host/.smurg/guests/w/a', settingsDir: '/home/host/.smurg/sessions/s', readOnlyPaths: [], extraReadPaths: [], hookSocketPath: '/home/host/.smurg/run/a.hook' }));
    expect(policy.perSession.filesystem.denyRead).toEqual(expect.arrayContaining([...LINUX_BROAD_DENY_READ]));
    expect(policy.perSession.filesystem.allowRead).toContain('/home/host/.smurg/run/a.hook');
  });

  it('srt accepts the generated configuration (its own schema)', async () => {
    const api = await loadSrt();
    const base = buildBaseConfig({ platform: 'darwin', hostHome: HOME, stateDir: STATE, hookSocketPath: HOOK, allowedDomains: ['api.anthropic.com', '*.claude.ai', '127.0.0.1:8080'] });
    expect(api.validate(base)).toBeNull();
    expect(api.validate({ ...base, ...buildSessionPolicy(worktreeInput()).perSession })).toBeNull();
  });
});

describe('buildSessionPolicy refuses what it cannot express safely', () => {
  const cases: [string, Partial<SessionPolicyInput>][] = [
    ['a glob character in the root', { shareDir: '/Users/host/p[1]', rootPath: '/Users/host/p[1]', worktreesDir: '/Users/host/p[1]/.smurg/worktrees', readOnlyPaths: [] }],
    ['a control character in a path', { extraReadPaths: ['/opt/cl\naude'] }],
    ['a relative path', { extraReadPaths: ['opt/claude'] }],
    ['a path that is not normalised', { extraReadPaths: ['/opt/../claude'] }],
    ['a guest dir outside the state dir', { guestDir: '/Users/host/guest' }],
    ['a settings dir inside the guest dir', { settingsDir: `${STATE}/guests/ws_1/alice/settings` }],
    ['a settings dir inside the root', { settingsDir: `${SHARE}/.smurg/settings` }],
    ['a shared dir outside the share', { readOnlyPaths: ['/Users/host/elsewhere'] }],
    ['main mode outside the share', { rootPath: '/Users/host/other' }],
    ['the host home as a read carve-out', { extraReadPaths: [HOME] }],
    ['a carve-out containing the host home', { extraReadPaths: ['/Users'] }],
    ['the daemon state dir as a carve-out', { extraReadPaths: [STATE] }],
    ['the file system root as a carve-out', { extraReadPaths: ['/'] }],
    ['a carve-out inside the daemon state dir', { extraReadPaths: [`${STATE}/workspaces/ws_1`] }],
    ['a deny equal to a carve-out', { extraDenyRead: [`${SHARE}/data`] }],
    ['a write deny equal to the root', { extraDenyWrite: [SHARE] }],
  ];
  it.each(cases)('refuses %s', (_label, overrides) => {
    expect(() => buildSessionPolicy(mainInput(overrides))).toThrow(PolicyError);
  });

  it('Linux: nested host-only entries are denied literally, control characters included (no Seatbelt string); a glob character, a NUL, a lone surrogate, a path outside the root, macOS and the login process are refused (review attack F1)', () => {
    const P = '/home/host/p';
    const linux = (nested: readonly string[], overrides: Partial<SessionPolicyInput> = {}): SessionPolicyInput =>
      mainInput({ platform: 'linux', hostHome: '/home/host', stateDir: '/home/host/.smurg', shareDir: P, worktreesDir: `${P}/.smurg/worktrees`, rootPath: P, guestDir: '/home/host/.smurg/guests/w/a', settingsDir: '/home/host/.smurg/sessions/s', readOnlyPaths: [], extraReadPaths: [], hookSocketPath: '/home/host/.smurg/run/a.hook', nestedHostOnlyPaths: nested, ...overrides });
    const odd = [`${P}/nl\nline/.git`, `${P}/ctl\u0001x/.claude`, `${P}/del\u007fx/.mcp.json`, `${P}/sane/.vscode`];
    const policy = buildSessionPolicy(linux(odd));
    expect(policy.perSession.filesystem.denyWrite).toEqual(expect.arrayContaining(odd));
    for (const path of odd) expect(canWrite(policy, `${path}/config`), path).toBe(false);
    expect(canWrite(policy, `${P}/nl\nline/README.md`)).toBe(true);
    // the same entries as ordinary deny paths are still refused: those reach srt from the spec, not from a walk
    expect(() => buildSessionPolicy(linux([], { extraDenyWrite: [`${P}/nl\nline/.git`] }))).toThrow(PolicyError);
    for (const bad of [`${P}/ev*il/.git`, `${P}/brack[et]/.mcp.json`, `${P}/q?/.git`, `${P}/n\u0000ul/.git`, `${P}/\uD800x/.git`, `${P}/a/../b/.git`, 'rel/.git', P, '/home/host/elsewhere/.git']) {
      expect(() => buildSessionPolicy(linux([bad])), JSON.stringify(bad)).toThrow(PolicyError);
    }
    expect(() => buildSessionPolicy(mainInput({ nestedHostOnlyPaths: [`${SHARE}/sub/.git`] }))).toThrow(/Linux agent or terminal session only/);
    expect(() => buildSessionPolicy(linux([`${P}/sub/.git`], { mode: 'login' }))).toThrow(/Linux agent or terminal session only/);
  });

  it('refuses, in worktree mode, a carve-out into the share that is not structural', () => {
    expect(() => buildSessionPolicy(worktreeInput({ extraReadPaths: [`${SRV}/src`] }))).toThrow(PolicyError);
    expect(() => buildSessionPolicy(worktreeInput({ rootPath: `${SRV}/elsewhere` }))).toThrow(PolicyError);
  });

  it('reports why smurg’s own command path cannot be exposed (the service drops such a path and the hook fails closed)', () => {
    const regions = { platform: 'darwin' as const, mode: 'worktree' as const, hostHome: HOME, stateDir: STATE, shareDir: SRV, worktreesDir: `${SRV}/.smurg/worktrees` };
    expect(readCarveOutProblem('/Users/host/src/smurg/packages', regions, false)).toBeNull();
    // dogfooding: the smurg checkout that runs the hook is (or contains) the shared folder
    expect(readCarveOutProblem('/srv', regions, false)).not.toBeNull();
    expect(readCarveOutProblem(`${SRV}/packages`, regions, false)).not.toBeNull();
  });
});

describe('host-only names match the protocol (isHostOnlyPath)', () => {
  it('every name the sandbox protects is host-only for file.* too, at the root and nested', () => {
    for (const name of [...HOST_ONLY_DIR_NAMES, ...HOST_ONLY_FILE_NAMES]) {
      expect(isHostOnlyPath(name), name).toBe(true);
      expect(isHostOnlyPath(`a/b/${name}`), name).toBe(true);
    }
  });

  it('every host-only name the protocol knows is protected by the sandbox', () => {
    const candidates = ['.claude', '.git', '.smurg', '.vscode', '.idea', '.mcp.json', '.envrc', '.github', '.npmrc', '.env', '.gitignore', '.gitattributes', '.editorconfig', '.husky', '.cursor', '.zed', '.devcontainer', '.bashrc', '.profile', 'CLAUDE.md', '.gitmodules'];
    const protectedNames = new Set([...HOST_ONLY_DIR_NAMES, ...HOST_ONLY_FILE_NAMES]);
    for (const name of candidates) if (isHostOnlyPath(name)) expect(protectedNames.has(name), name).toBe(true);
  });
});
