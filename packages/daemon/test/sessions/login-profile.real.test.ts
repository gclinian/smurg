// ARCHITECTURE §11 D-12, compared at the level of the generated Seatbelt profiles (REAL srt, macOS): the profile of a
// guest's Claude login process and the profile of an agent session of the same guest, both as the real sessions
// module has them wrapped. The login process may have exactly one right the agent session does not: its TCP listen
// (LOOPBACK_LISTEN_LINES). Everything else it gets is the same or less:
//   * network section: identical except the listen lines (the proxy port: outbound only, the hook socket);
//   * process rules: srt's `(allow process-exec)` plus, for the login only, the exec allow-list (a restriction);
//   * srt's environment words: identical;
//   * every read allow of the login is the guest dir, its daemon-owned working directory or the claude binary, all of
//     which the agent session may read too; every write allow is the guest dir (the agent's is the guest dir and the
//     share). The read / write model itself is compared path by path in test/sandbox/policy.test.ts (a model of srt's
//     rule order: the login reads and writes nothing an agent session cannot).
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SandboxSpec, WrappedCommand } from '../../src/core/interfaces.ts';
import { LOOPBACK_LISTEN_LINES, SRT_NETWORK_HEADER, SRT_PROCESS_EXEC_LINE, parseDarwinWrapped } from '../../src/sandbox/harden.ts';
import { createTempDir, removeTempDir } from '../../src/testing/index.ts';
import { TEST_CONN, startRealStack, type RealStack } from './real-stack.ts';

const TIMEOUT = 180_000;

interface Parsed {
  readonly profile: string;
  readonly envWords: string;
}

function parse(wrapped: WrappedCommand): Parsed {
  const command = wrapped.args[1] as string;
  const at = command.indexOf('exec /usr/bin/env ');
  const parsed = parseDarwinWrapped(`env ${command.slice(at + 'exec /usr/bin/env '.length).replace(' -D SMURG_TTY="$SMURG_TTY"', '')}`, '/bin/bash');
  return { profile: parsed.profile, envWords: parsed.envWords };
}

function networkSection(profile: string): string[] {
  const lines = profile.split('\n');
  const start = lines.indexOf(SRT_NETWORK_HEADER);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '') end++;
  return lines.slice(start + 1, end);
}

/** The filters of every rule that starts with `head` (multi-line rules: the indented lines up to the message). */
function filtersOf(profile: string, head: string): string[] {
  const lines = profile.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== head) continue;
    for (i++; i < lines.length && (lines[i] as string).startsWith('  ') && !(lines[i] as string).startsWith('  (with message'); i++) out.push((lines[i] as string).trim());
  }
  return out;
}

const subpathOf = (filter: string): string => JSON.parse(/^\(subpath ("(?:[^"\\]|\\.)*")\)$/.exec(filter)?.[1] ?? '""') as string;

describe.runIf(process.platform === 'darwin')('D-12 the login process profile vs an agent session profile of the same guest (real srt, macOS)', () => {
  let stack: RealStack | undefined;
  let scratch: string | undefined;
  let agent: { spec: SandboxSpec; parsed: Parsed } | undefined;
  let login: { spec: SandboxSpec; parsed: Parsed } | undefined;

  beforeAll(async () => {
    scratch = await createTempDir('login-profile');
    const claudePath = join(scratch, 'bin', 'claude');
    await mkdir(join(scratch, 'bin'), { recursive: true });
    await writeFile(claudePath, '#!/bin/bash\ncase "$1" in --version) echo "2.1.283 (Claude Code)"; exit 0 ;; esac\nif [ "$1" = auth ] && [ "$2" = status ]; then echo \'{"loggedIn":false}\'; exit 1; fi\nexec /bin/cat\n');
    await chmod(claudePath, 0o755);
    const s = await startRealStack({ claudePath });
    stack = s;
    const captured: { spec: SandboxSpec; wrapped: WrappedCommand }[] = [];
    const sandbox = s.daemon.ctx.services.sandbox;
    const original = sandbox.wrap.bind(sandbox);
    (sandbox as { wrap: typeof sandbox.wrap }).wrap = async (spec) => {
      const wrapped = await original(spec);
      captured.push({ spec, wrapped });
      return wrapped;
    };
    const carol = s.member('dev:carol', 'Carol', 'runner');
    const a = await s.sessions.create({ kind: 'agent', workspace: { mode: 'main' }, cols: 80, rows: 24 }, TEST_CONN, carol);
    const l = await s.sessions.create({ kind: 'login', workspace: { mode: 'main' }, cols: 80, rows: 24 }, TEST_CONN, carol);
    // The agent's own process (its command carries the session settings), not a helper such as `claude auth status`.
    const agentWrap = captured.find((c) => c.spec.loginProcess !== true && c.spec.command.includes("'--settings'") && !c.spec.command.includes("'auth'"));
    const loginWrap = captured.find((c) => c.spec.loginProcess === true);
    if (!agentWrap || !loginWrap) throw new Error(`wraps not captured: ${captured.map((c) => c.spec.command.slice(-60)).join(' | ')}`);
    agent = { spec: agentWrap.spec, parsed: parse(agentWrap.wrapped) };
    login = { spec: loginWrap.spec, parsed: parse(loginWrap.wrapped) };
    await s.sessions.end({ sessionId: l.id }, carol);
    await s.sessions.end({ sessionId: a.id }, carol);
  }, TIMEOUT);

  afterAll(async () => {
    await stack?.cleanup();
    if (scratch) await removeTempDir(scratch);
  }, TIMEOUT);

  it('network: the same section plus the TCP listen lines; no bind / inbound rule for the agent at all', () => {
    const a = networkSection(agent!.parsed.profile);
    const l = networkSection(login!.parsed.profile);
    expect(l).toEqual([...LOOPBACK_LISTEN_LINES, ...a]);
    expect(a.filter((line) => /network-(bind|inbound) \(local (ip|tcp|udp)/.test(line))).toEqual([]);
    expect(a.filter((line) => /network-outbound \(remote ip/.test(line))).toHaveLength(1);
    for (const profile of [agent!.parsed.profile, login!.parsed.profile]) {
      const outside = profile.split('\n').filter((line) => /\((?:allow|deny) network/.test(line) && !networkSection(profile).includes(line));
      expect(outside).toEqual([]);
    }
  });

  it('processes: the agent may exec anything srt allows; the login only its allow-list (a restriction, not a right)', () => {
    const a = agent!.parsed.profile.split('\n').filter((line) => line.includes('process-exec'));
    const l = login!.parsed.profile.split('\n').filter((line) => line.includes('process-exec'));
    expect(a).toEqual([SRT_PROCESS_EXEC_LINE]);
    expect(l.slice(0, 2)).toEqual([SRT_PROCESS_EXEC_LINE, '(deny process-exec)']);
    expect(l).toHaveLength(3);
    expect(login!.parsed.profile.endsWith(l[2] as string)).toBe(true);
  });

  it('environment: srt\'s env words are the same; the login\'s spawn environment has no hook token or socket', () => {
    expect(login!.parsed.envWords).toBe(agent!.parsed.envWords);
    expect(Object.keys(login!.spec.env).filter((name) => /^SMURG_(HOOK|SESSION_TOKEN)/.test(name))).toEqual([]);
    expect(Object.keys(agent!.spec.env)).toEqual(expect.arrayContaining(['SMURG_HOOK_SOCKET', 'SMURG_SESSION_TOKEN']));
  });

  it('files: every read and write carve-out of the login is one the agent session has (or inside its guest dir / working directory)', () => {
    const s = stack!;
    const guestDir = s.sessions.guestPaths('dev:carol').root;
    const loginReads = filtersOf(login!.parsed.profile, '(allow file-read*').map(subpathOf);
    const agentReads = filtersOf(agent!.parsed.profile, '(allow file-read*').map(subpathOf);
    for (const path of loginReads) {
      const ok = agentReads.includes(path) || path === guestDir || path === login!.spec.settingsDir;
      expect(ok, `the login may read ${path}`).toBe(true);
    }
    expect(loginReads).not.toContain(s.share);
    const loginWrites = filtersOf(login!.parsed.profile, '(allow file-write*').map(subpathOf);
    const agentWrites = filtersOf(agent!.parsed.profile, '(allow file-write*').map(subpathOf);
    for (const path of loginWrites) expect(agentWrites, `the login may write ${path}`).toContain(path);
    expect(loginWrites).toContain(guestDir);
    expect(loginWrites).not.toContain(s.share);
    // The share is denied for reading and writing as a whole; the agent's ancestor memory files are denied too.
    const loginReadDenies = filtersOf(login!.parsed.profile, '(deny file-read*').map(subpathOf);
    expect(loginReadDenies).toEqual(expect.arrayContaining([s.share, s.home, s.stateDir, '/CLAUDE.md', '/.claude', join(s.home, 'projects', 'CLAUDE.md')]));
  });
});
