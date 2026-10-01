// Review attack F1 and F2 against the REAL srt on this machine (macOS Seatbelt, Linux bubblewrap), spawned through
// node-pty like a session (helpers.ts: a fake host home, probes print markers only).
//
// F1: a guest who can write the share makes `ev*il/.git`, `brack[et]/.mcp.json` or a directory whose name holds a
// control character. On Linux the walk for existing nested host-only entries (service.ts nestedHostOnlyPaths) used to
// hand such a path to the policy, which refused it, and with it EVERY later guest session in that root. Now: every
// guest's session starts; macOS still denies every such entry by pattern; Linux denies the control-character ones
// literally and names the ones srt cannot be given (glob characters, a name that is not UTF-8) in the log, since guests
// can write those (ARCHITECTURE §12).
//
// F2 (Linux): a guest sandbox holds at most config'd tasks, counted inside its own user namespace, so the limit does
// not depend on what the host user runs and cannot be raised from inside. No fork bomb: a few dozen `sleep`s.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSandboxModule } from '../../src/sandbox/module.ts';
import { createSandboxFixture, isDarwin, isLinux, marker, printWarningsOnFailure, probe, q, results, runWrapped, sandboxPlatform, type SandboxFixture } from './helpers.ts';

const execFileAsync = promisify(execFile);
const TIMEOUT = 120_000;

/** Directory names a guest can make, with the host-only entry planted in each. */
const PLANTED: readonly { readonly key: string; readonly dir: string; readonly entry: string }[] = [
  { key: 'star', dir: 'ev*il', entry: '.git/config' },
  { key: 'bracket', dir: 'brack[et]', entry: '.mcp.json' },
  { key: 'question', dir: 'wh?', entry: '.vscode/tasks.json' },
  { key: 'control', dir: 'ctl\u0001x', entry: '.git/config' },
  { key: 'newline', dir: 'nl\nline', entry: '.claude/settings.json' },
  { key: 'sane', dir: 'sane', entry: '.vscode/tasks.json' },
];
/** Linux only (APFS refuses such names): a directory whose name is not UTF-8, reached in the probe by a shell glob. */
const NOT_UTF8 = Buffer.from([0xff, 0x2d, 0x64, 0x69, 0x72]); // "\xff-dir"
const PRIVATE = marker('HOST-PRIVATE');

describe.runIf(sandboxPlatform)('guest-made odd names in the share (review attack F1, real srt)', () => {
  let f: SandboxFixture;

  beforeAll(async () => {
    f = await createSandboxFixture({ files: { 'README.md': 'project readme\n' } });
    for (const { dir, entry } of PLANTED) {
      const path = join(f.share, dir, entry);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'host\n');
      // a host-private file (hidden from guests at any depth, srt's `**/CLAUDE.local.md`) next to it
      await writeFile(join(f.share, dir, 'CLAUDE.local.md'), `${PRIVATE}\n`);
    }
    if (isLinux) {
      const dir = Buffer.concat([Buffer.from(`${f.share}/`), NOT_UTF8]);
      await mkdir(Buffer.concat([dir, Buffer.from('/.git')]), { recursive: true });
      await writeFile(Buffer.concat([dir, Buffer.from('/.git/config')]), 'host\n');
      await writeFile(Buffer.concat([dir, Buffer.from('/CLAUDE.local.md')]), `${PRIVATE}\n`);
    }
  }, TIMEOUT);

  afterEach((context) => printWarningsOnFailure(f, context));

  afterAll(async () => {
    await f?.cleanup();
  }, TIMEOUT);

  it('every guest’s session still starts; what is denied is denied, what cannot be is named in the log', async () => {
    const script = [
      ...PLANTED.flatMap(({ key, dir, entry }) => [
        probe(`w-${key}`, `echo guest >> ${q(join(f.share, dir, entry))}`),
        probe(`ordinary-${key}`, `echo guest > ${q(join(f.share, dir, 'ordinary.txt'))} && rm ${q(join(f.share, dir, 'ordinary.txt'))}`),
        probe(`r-${key}`, `cat ${q(join(f.share, dir, 'CLAUDE.local.md'))}`),
      ]),
      ...(isLinux
        ? [probe('w-not-utf8', `for d in ${q(f.share)}/*-dir; do echo guest >> "$d/.git/config"; done`), probe('r-not-utf8', `for d in ${q(f.share)}/*-dir; do cat "$d/CLAUDE.local.md"; done`)]
        : []),
      'echo "@@started=yes@@"',
    ].join('\n');
    for (const guestName of ['alice', 'bob']) {
      const guest = await f.guest(guestName);
      const wrapped = await f.sandbox.wrap(f.spec({ command: script, guest, settingsDir: await f.settingsDir(`ses_odd_${guestName}`, '{}\n') }));
      const run = await runWrapped(wrapped);
      const r = results(run.output);
      expect(run.exitCode, guestName).toBe(0);
      expect(r['started'], guestName).toBe('yes');
      // macOS: Seatbelt's `<root>/**/<name>` patterns match whatever the directory is called. Linux: bubblewrap binds
      // each existing entry srt can be given read-only; a glob character in its path cannot be (srt drops the deny).
      const writable = new Set(isDarwin ? [] : ['star', 'bracket', 'question']);
      for (const { key } of PLANTED) {
        expect(r[`w-${key}`], `${guestName} ${key}`).toBe(writable.has(key) ? 'ok' : 'denied');
        expect(r[`ordinary-${key}`], `${guestName} ${key} ordinary file`).toBe('ok');
        // srt expands its read-deny globs itself, with whatever characters a name holds
        expect(r[`r-${key}`], `${guestName} ${key} host-private file`).toBe('denied');
      }
      // Linux, a name that is not UTF-8: neither smurg nor srt can name what is below it (ARCHITECTURE §12)
      if (isLinux) expect({ write: r['w-not-utf8'], read: r['r-not-utf8'] }, guestName).toEqual({ write: 'ok', read: 'ok' });
      expect(run.output, guestName).not.toContain(PRIVATE); // probes print markers only, never what they read
    }
    for (const { key, dir, entry } of PLANTED) {
      const content = await readFile(join(f.share, dir, entry), 'utf8');
      if (isDarwin || !['star', 'bracket', 'question'].includes(key)) expect(content, key).toBe('host\n');
    }
    expect((await f.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'sandbox.refused')).toEqual([]);
    const named = f.warnings().filter((line) => line.includes('guests can write this host-only entry'));
    if (isDarwin) {
      expect(named).toEqual([]);
    } else {
      // once per daemon (two sessions above), each entry with its reason; the path quoted, so it cannot forge a line
      expect(named).toHaveLength(4);
      for (const key of ['star', 'bracket', 'question']) {
        const { dir, entry } = PLANTED.find((planted) => planted.key === key) as { dir: string; entry: string };
        const path = join(f.share, dir, entry.split('/')[0] as string);
        expect(named.filter((line) => line.includes(`path=${JSON.stringify(path)} why=glob-characters`)), key).toHaveLength(1);
      }
      expect(named.filter((line) => line.includes(`path=${JSON.stringify(`${f.share}/�-dir/.git`)} why=not-utf8`))).toHaveLength(1);
      expect(named.join('\n')).not.toContain('ctl');
      expect(named.join('\n')).not.toContain('sane');
    }
  }, TIMEOUT);
});

describe.runIf(isLinux)('Linux: the task limit of a guest sandbox (review attack F2, real bubblewrap)', () => {
  let f: SandboxFixture;
  const LIMIT = 32;

  beforeAll(async () => {
    f = await createSandboxFixture({ module: createSandboxModule({ linuxTaskLimit: LIMIT }) });
  }, TIMEOUT);

  afterEach((context) => printWarningsOnFailure(f, context));

  afterAll(async () => {
    await f?.cleanup();
  }, TIMEOUT);

  it('counts the sandbox’s own tasks only (the host user already has more), and cannot be raised from inside', async () => {
    // The host user's tasks right now (this test runner alone has dozens of threads): more than the sandbox's limit,
    // so a limit counted for the whole user would let the sandbox start nothing at all.
    const { stdout } = await execFileAsync('ps', ['-L', '-u', String(process.getuid?.()), '--no-headers']);
    expect(stdout.trim().split('\n').length).toBeGreaterThan(LIMIT);
    // dash gives up at the first failed fork ("Cannot fork"), so the last number printed is how many it started.
    const starter = `/bin/sh -c 'n=0; while [ $n -lt 48 ]; do /bin/sleep 5 & n=$((n+1)); echo "@@started=$n@@"; done' 2>/dev/null`;
    const script = [
      'echo "@@soft=$(ulimit -Su)@@"',
      'echo "@@hard=$(ulimit -Hu)@@"',
      probe('raise', 'ulimit -u 100000'),
      starter,
    ].join('\n');
    const guest = await f.guest('alice');
    const run = await runWrapped(await f.sandbox.wrap(f.spec({ command: script, guest, settingsDir: await f.settingsDir('ses_tasks', '{}\n') })));
    const r = results(run.output);
    expect(r).toMatchObject({ soft: String(LIMIT), hard: String(LIMIT), raise: 'denied' });
    const started = Number(r['started']);
    // bwrap's init, srt's two network bridges, the shells and the sleeps share the limit
    expect(started).toBeGreaterThanOrEqual(LIMIT - 12);
    expect(started).toBeLessThan(LIMIT);
  }, TIMEOUT);
});
