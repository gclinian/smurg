// `smurg host` and the state of the workspace it opens (0.5.1; DESIGN A7, B4, C), through the real command on folders
// that PUBLISHED versions of smurg really wrote (packages/daemon/test/fixtures/published/, copied by
// ./published-fixture.ts and then damaged here), in both languages.
//
// Where this comes from: 0.5.0 refused the state 0.4.0 had written (the owner's own update), and for EVERY refused
// state file the terminal had one text that ended in "move the folder away" (W/FOUND-U6, W/FOUND-REAL t01, t08): for
// an older file, a newer file, a wrong mode and a cut-off file alike. Moving the folder throws away the members, the
// invite links and the daemon's key. Now:
//   - the owner's own case, word for word: a folder 0.4.0 wrote, `smurg host`: it starts, ONE line, the two links;
//   - a clean start prints exactly what it printed before (the two links and nothing else);
//   - every kind and cause of refusal has its own text, which names the file and the reason itself, says that
//     nothing was changed (and nothing was: the folder is compared byte for byte), and never says "move" except as
//     the last resort of an unreadable file, after what that costs, with a target that cannot nest;
//   - an older state file that was put back is said, with what it undoes; a `<workspace id>.old*` folder beside the
//     one that is opened is said once; a known teammate's page or smurg of another protocol version that was turned
//     away is said once per run and direction.
// The words themselves, for the causes a test cannot make in a real folder without root, are in host-state-words.test.ts.
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_MODULES, silentLogger, systemClock, type Daemon } from '@smurg/daemon';
import { MemoryRelay, TestIdentityIssuer, createTempDir, createTempRunDir, removeTempDir, removeTempRunDir, waitFor } from '@smurg/daemon/testing';
import { PROTOCOL_VERSION, daemonKeyFingerprint, equalBytes, formatFingerprintForDisplay, type AdmitContext } from '@smurg/protocol';
import { readPinnedDaemonKey } from '@smurg/protocol/node';
import { admitConnection } from '../../daemon/src/net/admission.ts';
import { formatFailure } from '../src/cli/errors.ts';
import { runAttach } from '../src/commands/attach.ts';
import { commandContext } from '../src/commands/context.ts';
import { runHost } from '../src/commands/host.ts';
import { formatTime } from '../src/commands/host-state.ts';
import { saveSession } from '../src/state/credentials.ts';
import { hostLogPath, statePaths, workspaceStateDir } from '../src/state/paths.ts';
import { rememberSharedFolder } from '../src/state/workspaces.ts';
import type { UpdateNoticeDeps } from '../src/update/notice.ts';
import { CLI_VERSION } from '../src/version.ts';
import { browserOpening, startFakeRelay, type FakeRelay } from './fake-relay.ts';
import { echoSessions } from './fixtures/echo-sessions.ts';
import { makeDirs, testIo, type TestIo } from './helpers.ts';
import { PUBLISHED_FIXTURES, copyPublishedFixture, type FixtureCopy } from './published-fixture.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

type Lang = 'en' | 'zh-TW';
const LANGS: readonly Lang[] = ['en', 'zh-TW'];
/** The host of both fixtures. */
const HOST = { userId: 'dev:host', displayName: 'host', provider: 'dev' as const };
/** The terminal's clock (the date in the last resort's example). */
const NOW = new Date(2026, 9, 8, 14, 5, 7).getTime();
const NOW_NAME = '20261008-140507';
const GUIDE: Readonly<Record<Lang, string>> = { en: 'https://smurg.ai/docs/hosting/#9-updating-and-removing', 'zh-TW': 'https://smurg.ai/zh-TW/docs/hosting/#9-更新與移除' };

interface Shared {
  readonly copy: FixtureCopy;
  readonly env: Record<string, string>;
  readonly relay: FakeRelay;
  readonly memory: MemoryRelay;
  readonly issuer: TestIdentityIssuer;
}

/** What a published smurg left on a host's computer, on a copy, with this test's relay as the folder's relay. */
async function onFixture(version: '0.4.0' | '0.5.0'): Promise<Shared> {
  const root = await createTempRunDir();
  cleanups.push(() => removeTempRunDir(root));
  const copy = copyPublishedFixture(version, 'stopped', root);
  const base = await createTempDir('cli');
  cleanups.push(() => removeTempDir(base));
  const home = join(base, 'home');
  await mkdir(home, { recursive: true });
  const relay = await startFakeRelay();
  cleanups.push(() => relay.close());
  relay.loginAs = HOST;
  const env = { HOME: home, SMURG_HOME: copy.hostHome };
  const paths = statePaths(env);
  // The fixture's own workspaces.json names the relay it was made with; the folder's workspace at THIS relay is the same one.
  await rememberSharedFolder(paths, { folder: copy.project, relay: relay.origin, workspaceId: copy.workspaceId, createdAt: 1 });
  const token = 'stored.host-token-for-test';
  relay.tokens.set(token, HOST);
  await saveSession(paths, relay.origin, { token, tokenType: 'Bearer', expiresIn: 7 * 24 * 3600, user: HOST }, NOW);
  return { copy, env, relay, memory: new MemoryRelay(copy.workspaceId), issuer: new TestIdentityIssuer(relay.origin, generateKeyPairSync('ed25519'), systemClock) };
}

interface Terminal {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  /** Whether the daemon started (the two links were printed). */
  readonly started: boolean;
}

/** SMURG_SHOW_TERMINAL=<file>: every terminal of this file is appended to it (how the report of a release shows them). */
function show(title: string, lang: Lang, terminal: Terminal): void {
  const file = process.env['SMURG_SHOW_TERMINAL'];
  if (file === undefined || file === '') return;
  appendFileSync(file, `===== ${title} [${lang}] (exit ${terminal.code})\n--- stderr\n${terminal.err}--- stdout\n${terminal.out}\n`);
}

/**
 * `smurg host <the fixture's folder>` with the RELEASE composition, as the dispatcher runs it (a failure is printed as
 * `smurg: ...` on stderr). A host that started is stopped after `during`.
 */
async function smurgHost(shared: Shared, lang: Lang, title: string, options: { readonly update?: UpdateNoticeDeps; readonly during?: (daemon: Daemon, io: TestIo) => Promise<void> | void } = {}): Promise<Terminal> {
  const io = testIo({ env: { ...shared.env, SMURG_LANG: lang }, openUrl: browserOpening, now: () => NOW });
  const ctx = commandContext(io);
  let ready: (daemon: Daemon) => void = () => {};
  const started = new Promise<Daemon>((resolve) => {
    ready = resolve;
  });
  const done = runHost([shared.copy.project, '--relay', shared.relay.origin, '--no-keep-awake'], ctx, {
    daemon: { socketFactory: shared.memory.hostSocketFactory(), identityKeys: { get: (kid: string) => (kid === shared.issuer.kid ? shared.issuer.publicKey : null), refresh: async () => {} } },
    onReady: (daemon) => ready(daemon),
    ...(options.update ? { update: options.update } : {}),
  }).catch((err: unknown) => {
    const failure = formatFailure(err, ctx.lang);
    io.stderr.write(failure.text);
    return failure.exitCode as number;
  });
  let ended = false;
  void done.then(() => {
    ended = true;
  });
  cleanups.push(async () => {
    if (!ended) io.signal('SIGTERM');
    await done;
  });
  const daemon = await Promise.race([started, done.then(() => null)]);
  if (daemon !== null) {
    await waitFor(() => (io.out().match(/\/join\//g) ?? []).length === 2, { what: 'the two links' });
    await options.during?.(daemon, io);
    io.signal('SIGTERM');
  }
  const terminal = { code: await done, out: io.out(), err: io.err(), started: daemon !== null };
  show(title, lang, terminal);
  return terminal;
}

/** The agent sessions the 0.5.0 fixture holds: a stop says how many are paused (as it has since 0.5.0). */
const PAUSED_050 = 30;

/**
 * The start summary and the stop, exactly as `smurg host` has printed them before 0.5.1: the two links and nothing
 * else (and, at the stop, how many agent sessions are paused when there are any).
 */
function cleanStart(lang: Lang, out: string, paused = 0): string {
  const [hostLink, inviteLink] = out.match(/https?:\/\/\S+\/join\/\S+/g) ?? [];
  return lang === 'en'
    ? [
        '',
        'smurg is sharing "project"',
        '',
        'Your link (for you only):',
        `  ${hostLink}`,
        '',
        'Link for your teammates (send it to them privately; valid for 7 days):',
        `  ${inviteLink}`,
        '',
        'Press Ctrl-C to stop sharing.',
        '',
        'Received SIGTERM; stopping the share...',
        'Stopped sharing.',
        ...(paused > 0 ? [`${paused} agent sessions are paused. They continue when you share this folder again.`] : []),
        '',
      ].join('\n')
    : [
        '',
        'smurg 正在分享「project」',
        '',
        '你的連結（只給你自己用）：',
        `  ${hostLink}`,
        '',
        '給組員的連結（用私訊傳給他們，7 天內有效）：',
        `  ${inviteLink}`,
        '',
        '按 Ctrl-C 停止分享。',
        '',
        '收到 SIGTERM，正在停止分享…',
        '已停止分享。',
        ...(paused > 0 ? [`${paused} 個 agent session 已暫停，下次分享這個資料夾時會繼續。`] : []),
        '',
      ].join('\n');
}

/** The daemon's own lines on stderr (errors of the log are shown there too) and what the command said after them. */
function stderrOf(terminal: Terminal): { readonly log: string[]; readonly said: string } {
  const lines = terminal.err.split('\n');
  const log = lines.filter((line) => /^\d{4}-\d{2}-\d{2}T\S+Z (?:error|warn|info) /.test(line));
  return { log, said: lines.filter((line) => !log.includes(line)).join('\n') };
}

/**
 * Everything below `dir`, byte for byte: every name with its kind, its mode and (a file) the SHA-256 of its bytes or
 * (a link) where it points. Two equal pictures: nothing was created, removed, renamed, chmod-ed or written.
 */
async function picture(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (path: string, name: string): Promise<void> => {
    const st = await lstat(path);
    const mode = (st.mode & 0o7777).toString(8);
    if (st.isSymbolicLink()) out[name] = `link ${mode} -> ${await readlink(path)}`;
    else if (st.isDirectory()) {
      out[`${name}/`] = `dir ${mode}`;
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), `${name}/${entry}`);
    } else {
      // A file this user may not read (a test of exactly that) is still there with its mode and size.
      const bytes = await readFile(path).catch(() => null);
      out[name] = `file ${mode} ${st.size} ${bytes === null ? 'unreadable' : createHash('sha256').update(bytes).digest('hex')}`;
    }
  };
  await walk(dir, '.');
  return out;
}

/** The workspace's folder and the launch files of its sessions: what a refused start must leave as it is. */
async function pictureOf(copy: FixtureCopy): Promise<unknown> {
  return { workspace: await picture(copy.workspaceDir), sessions: await picture(join(copy.hostHome, 'sessions')) };
}

async function editJson(path: string, change: (value: Record<string, unknown>) => void): Promise<void> {
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  change(value);
  await writeFile(path, JSON.stringify(value));
}

/** A released single executable of `version`, with a downloads site whose latest version is `latest` (the tests run from source). */
function released(version: string, latest: string): UpdateNoticeDeps {
  return { executable: '/nonexistent/bin/smurg', version, fetch: (async () => new Response(`${latest}\n`, { status: 200 })) as typeof globalThis.fetch };
}

// ---- the texts, word for word

const UNCHANGED: Readonly<Record<Lang, string>> = { en: 'Nothing was changed.', 'zh-TW': '沒有更動任何東西。' };
const MAYBE_NEWER: Readonly<Record<Lang, string>> = {
  en: 'First: if a newer smurg was ever used on this computer, run smurg update, then smurg host again.',
  'zh-TW': '第一步：如果這台電腦曾經用過較新版的 smurg，請執行 smurg update，再執行一次 smurg host。',
};
/** The last resort: what it costs FIRST, then the example (`command`), which is the last line of the text. */
const lastResort = (lang: Lang, command: string): string =>
  lang === 'en'
    ? "The last resort is a new workspace. It costs: this workspace's members and invite links (your teammates join again with a new link), its topics, conversations and audit log, " +
      'and the daemon\'s key (teammates who joined before will see "The host computer\'s key has changed": tell them the new key fingerprint that smurg status shows through another channel, in person or by phone); ' +
      "and smurg no longer knows the worktrees it kept (their folders stay in the shared folder's .smurg/worktrees, with work that is not merged)." +
      `\n  If you accept that, move this workspace's folder away and run smurg host again:\n  ${command}`
    : '最後的辦法是建立新的工作區。代價是：這個工作區的成員和邀請連結（組員要用新的邀請連結重新加入）、主題、對話和操作紀錄，' +
      '還有 daemon 金鑰（加入過的組員會看到「主人的電腦金鑰和之前不同」：請把 smurg status 顯示的新金鑰指紋用其他管道（當面、電話）告訴他們）；' +
      'smurg 也不再認得它保留的 worktree（它們的資料夾還在分享資料夾的 .smurg/worktrees 裡，連同還沒合併的工作）。' +
      `\n  如果你接受這些代價，把這個工作區的資料夾移到別處，再執行一次 smurg host：\n  ${command}`;
/** A file that is not there (`missing`). */
const NOTHING_MADE: Readonly<Record<Lang, string>> = {
  en: 'Nothing was changed, and smurg made no new file in its place. If the file was moved or renamed by hand, put it back.',
  'zh-TW': '沒有更動任何東西，smurg 也沒有另外建立新的檔案。如果這個檔案是被手動移走或改名的，請把它放回來。',
};
/** `smurg: <message>` and its hint lines, as the dispatcher prints a failure. */
const failure = (lang: Lang, message: string, hint: readonly string[]): string => `${lang === 'en' ? 'smurg: ' : 'smurg：'}${message}\n  ${hint.join('\n  ')}\n`;

// ---- the owner's own case

describe('smurg host on the folder smurg 0.4.0 left (the owner\'s own update)', () => {
  it('starts: ONE line says what was carried over, then the two links; the old files are kept beside the new ones; a second start says nothing', async () => {
    for (const lang of LANGS) {
      const shared = await onFixture('0.4.0');
      const ws = shared.copy.workspaceDir;
      const old = { state: await readFile(join(ws, 'state.json')), suggestions: await readFile(join(ws, 'suggestions.json')) };
      let members: string[] = [];
      const first = await smurgHost(shared, lang, 'an upgrading start (the folder 0.4.0 left)', {
        during: (daemon) => {
          expect(daemon.workspaceId).toBe(shared.copy.workspaceId);
          expect(daemon.upgraded.map((entry) => [entry.document, entry.from])).toEqual([['state', '0.4.0'], ['suggestions', '0.4.0']]);
          expect(daemon.putBack).toBe(false);
          members = daemon.ctx.members.list().map((member) => `${member.userId} ${member.role}`);
        },
      });
      expect(first.started).toBe(true);
      expect(first.code).toBe(0);
      const line =
        lang === 'en'
          ? `This workspace was last shared with smurg 0.4.0: its members, invite links and settings were carried over. What changed: ${GUIDE.en}`
          : `這個工作區上次是用 smurg 0.4.0 分享的：成員、邀請連結和設定都已沿用。有哪些改變：${GUIDE['zh-TW']}`;
      // The whole terminal: the one line, then exactly the start summary of every other start.
      expect(first.out).toBe(`${line}\n${cleanStart(lang, first.out)}`);
      // The fixture holds no shared folder: its two worktree folders are not there, and the daemon says so twice. Nothing else.
      expect(stderrOf(first).log.filter((entry) => !entry.includes('could not watch a root'))).toEqual([]);
      expect(stderrOf(first).said).toBe('');
      // The members 0.4.0 had are the members now (the host, three editors, a viewer, three with agent access).
      expect(members).toEqual(expect.arrayContaining(['dev:host host', 'dev:amy editor', 'dev:bob viewer', 'dev:carol agent', 'dev:ivan agent']));
      expect(members).toHaveLength(8);
      // The files as they were are kept beside the upgraded ones, byte for byte and private; the stamp names the shapes.
      expect((await readFile(join(ws, 'state.json.before-upgrade-from-0.4.0'))).equals(old.state)).toBe(true);
      expect((await readFile(join(ws, 'suggestions.json.before-upgrade-from-0.4.0'))).equals(old.suggestions)).toBe(true);
      expect((await lstat(join(ws, 'state.json.before-upgrade-from-0.4.0'))).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(join(ws, 'written-by.json'), 'utf8'))).toMatchObject({ shapes: 1 });
      // The host log gets the same line (in English: the log is not translated).
      expect(await readFile(hostLogPath(statePaths(shared.env), shared.copy.workspaceId), 'utf8')).toContain('This workspace was last shared with smurg 0.4.0: its members, invite links and settings were carried over.');

      // A second start upgrades nothing and prints exactly what a start has always printed.
      const second = await smurgHost(shared, lang, 'a clean start (the same folder, a second time)', { during: (daemon) => expect(daemon.upgraded).toEqual([]) });
      expect(second.out).toBe(cleanStart(lang, second.out));
      expect(stderrOf(second).said).toBe('');
      expect((await readdir(ws)).filter((name) => name.includes('.before-upgrade-from-')).sort()).toEqual(['state.json.before-upgrade-from-0.4.0', 'suggestions.json.before-upgrade-from-0.4.0']);
    }
  }, 120_000);

  it('the folder smurg 0.5.0 left needs no step: exactly the two links, no line, no copy', async () => {
    for (const lang of LANGS) {
      const shared = await onFixture('0.5.0');
      const t = await smurgHost(shared, lang, 'a clean start (the folder 0.5.0 left)', { during: (daemon) => expect(daemon.upgraded).toEqual([]) });
      expect(t.code).toBe(0);
      expect(t.out).toBe(cleanStart(lang, t.out, PAUSED_050));
      expect(stderrOf(t).said).toBe('');
      expect((await readdir(shared.copy.workspaceDir)).filter((name) => name.includes('.before-upgrade-from-'))).toEqual([]);
    }
  }, 120_000);
});

// ---- every kind and cause of refusal

interface Refusal {
  readonly fixture: '0.4.0' | '0.5.0';
  /** Makes the problem in the copy. */
  readonly damage: (copy: FixtureCopy) => Promise<void>;
  /** The lookup `smurg update` does, when the text depends on it. */
  readonly update?: UpdateNoticeDeps;
  /** What the daemon logs about it (kind and so on), as fields of its one line. */
  readonly logged: readonly string[];
  /** What the terminal says, per language: the message and the lines of the hint. */
  readonly says: (copy: FixtureCopy, lang: Lang, said: string) => { readonly message: string; readonly hint: readonly string[] };
  /** Whether the text may show a `mv` (the last resort of an unreadable file, and nowhere else). */
  readonly lastResort: boolean;
  /** Undoes what a temp-folder cleanup cannot remove. */
  readonly restore?: (copy: FixtureCopy) => Promise<void>;
}

const mv = (copy: FixtureCopy): string => `mv ${copy.workspaceDir} ${copy.workspaceDir}.old-${NOW_NAME}`;
const stampOf = (copy: FixtureCopy): string => join(copy.workspaceDir, 'written-by.json');
const newerStamp = (copy: FixtureCopy): Promise<void> => writeFile(stampOf(copy), JSON.stringify({ smurg: '0.9.0', shapes: 2, at: 1 }), { mode: 0o600 });
/** `x` and 31 combining acute accents: a path 0.4.0 accepted and 0.5.x refuses (more than 30 marks in a row). */
const MARK_RUN = `x${String.fromCodePoint(0x301).repeat(31)}`;
const notRoot = process.getuid?.() !== 0;

const REFUSALS: Readonly<Record<string, Refusal>> = {
  'newer, by the folder\'s stamp; smurg update cannot be asked: both sentences, the file and the stamp': {
    fixture: '0.4.0',
    damage: newerStamp,
    logged: ['kind=newer', 'writtenBy=0.9.0'],
    lastResort: false,
    says: (copy, lang) =>
      lang === 'en'
        ? {
            message: `This workspace was last shared with smurg 0.9.0, a newer smurg than this one (this is ${CLI_VERSION}), and this smurg cannot read what it wrote: ${copy.workspaceDir}`,
            hint: [
              UNCHANGED.en,
              'Run smurg update, then smurg host again. If smurg update says that this is the latest version, the folder was last written by a smurg this computer cannot get that way: share it with the smurg that wrote it.',
              `The stamp that names its writer: ${stampOf(copy)} (it says smurg 0.9.0).`,
            ],
          }
        : {
            message: `這個工作區上次是用 smurg 0.9.0 分享的，它比這個 smurg（${CLI_VERSION}）新，這個 smurg 讀不了它寫的東西：${copy.workspaceDir}`,
            hint: [
              UNCHANGED['zh-TW'],
              '請執行 smurg update，再執行一次 smurg host。如果 smurg update 說已經是最新版本，表示上次寫入這個資料夾的 smurg 是這台電腦用 smurg update 拿不到的版本：請用寫入它的那個 smurg 來分享。',
              `記下是哪個版本寫的檔案：${stampOf(copy)}（上面寫的是 smurg 0.9.0）。`,
            ],
          },
  },
  'newer, and a newer smurg is published: run smurg update': {
    fixture: '0.4.0',
    damage: newerStamp,
    update: released('0.5.1', '0.9.0'),
    logged: ['kind=newer'],
    lastResort: false,
    says: (copy, lang) =>
      lang === 'en'
        ? {
            message: `This workspace was last shared with smurg 0.9.0, a newer smurg than this one (this is 0.5.1), and this smurg cannot read what it wrote: ${copy.workspaceDir}`,
            hint: [UNCHANGED.en, 'Run smurg update (version 0.9.0 is available), then smurg host again.'],
          }
        : {
            message: `這個工作區上次是用 smurg 0.9.0 分享的，它比這個 smurg（0.5.1）新，這個 smurg 讀不了它寫的東西：${copy.workspaceDir}`,
            hint: [UNCHANGED['zh-TW'], '請執行 smurg update（已經有 0.9.0 版），再執行一次 smurg host。'],
          },
  },
  'newer, and smurg update has nothing newer: written by a smurg this computer cannot get; the file and the stamp': {
    fixture: '0.4.0',
    damage: newerStamp,
    update: released('0.5.1', '0.5.1'),
    logged: ['kind=newer'],
    lastResort: false,
    says: (copy, lang) =>
      lang === 'en'
        ? {
            message: `This workspace was last shared with smurg 0.9.0, a newer smurg than this one (this is 0.5.1), and this smurg cannot read what it wrote: ${copy.workspaceDir}`,
            hint: [
              UNCHANGED.en,
              'smurg update cannot help: 0.5.1 is the latest published version. This folder was last written by a smurg this computer cannot get that way (a build that was never published, or a folder copied from another computer): share it with the smurg that wrote it.',
              `The stamp that names its writer: ${stampOf(copy)} (it says smurg 0.9.0).`,
            ],
          }
        : {
            message: `這個工作區上次是用 smurg 0.9.0 分享的，它比這個 smurg（0.5.1）新，這個 smurg 讀不了它寫的東西：${copy.workspaceDir}`,
            hint: [
              UNCHANGED['zh-TW'],
              'smurg update 幫不上忙：0.5.1 已經是發佈過的最新版本。上次寫入這個資料夾的 smurg 是這台電腦用 smurg update 拿不到的版本（沒有發佈過的版本，或是從別台電腦複製來的資料夾）：請用寫入它的那個 smurg 來分享。',
              `記下是哪個版本寫的檔案：${stampOf(copy)}（上面寫的是 smurg 0.9.0）。`,
            ],
          },
  },
  'newer, by a document\'s version, in a folder without a stamp': {
    fixture: '0.4.0',
    damage: (copy) => editJson(join(copy.workspaceDir, 'state.json'), (state) => void (state['version'] = 2)),
    logged: ['kind=newer'],
    lastResort: false,
    says: (copy, lang) =>
      lang === 'en'
        ? {
            message: `This workspace was last shared with a newer smurg than this one (this is ${CLI_VERSION}), and this smurg cannot read what it wrote: ${join(copy.workspaceDir, 'state.json')}`,
            hint: [
              UNCHANGED.en,
              'Run smurg update, then smurg host again. If smurg update says that this is the latest version, the folder was last written by a smurg this computer cannot get that way: share it with the smurg that wrote it.',
              `The folder has no usable stamp that names its writer (${stampOf(copy)}).`,
            ],
          }
        : {
            message: `這個工作區上次是用比這個 smurg（${CLI_VERSION}）更新的版本分享的，這個 smurg 讀不了它寫的東西：${join(copy.workspaceDir, 'state.json')}`,
            hint: [
              UNCHANGED['zh-TW'],
              '請執行 smurg update，再執行一次 smurg host。如果 smurg update 說已經是最新版本，表示上次寫入這個資料夾的 smurg 是這台電腦用 smurg update 拿不到的版本：請用寫入它的那個 smurg 來分享。',
              `這個資料夾裡沒有可用的檔案記下是哪個版本寫的（${stampOf(copy)}）。`,
            ],
          },
  },
  'insecure, mode: ONE chmod for every such file, and that others could read them until now': {
    fixture: '0.4.0',
    damage: async (copy) => {
      await chmod(join(copy.workspaceDir, 'state.json'), 0o644);
      await chmod(join(copy.workspaceDir, 'audit.jsonl'), 0o640);
    },
    logged: ['kind=insecure', 'cause=mode'],
    lastResort: false,
    says: (copy, lang) => {
      const command = `chmod 600 ${join(copy.workspaceDir, 'audit.jsonl')} ${join(copy.workspaceDir, 'state.json')}`;
      return lang === 'en'
        ? {
            message: `2 files of this workspace's state are open to other users of this computer; the first (mode 640): ${join(copy.workspaceDir, 'audit.jsonl')}`,
            hint: [
              UNCHANGED.en,
              `Until now, other users of this computer could read or change them (a workspace's state holds the daemon's key and the keys of its invite links). Make them yours alone, then run smurg host again:\n  ${command}`,
            ],
          }
        : {
            message: `這個工作區有 2 個狀態檔，這台電腦的其他使用者也能存取；第一個（權限 640）：${join(copy.workspaceDir, 'audit.jsonl')}`,
            hint: [UNCHANGED['zh-TW'], `在這之前，這台電腦的其他使用者可以讀取或更動這些檔案（工作區的狀態裡有 daemon 金鑰和邀請連結的金鑰）。請改成只有你自己能存取，再執行一次 smurg host：\n  ${command}`],
          };
    },
  },
  'insecure, symlink: what is there, no command': {
    fixture: '0.4.0',
    damage: async (copy) => {
      await rename(join(copy.workspaceDir, 'suggestions.json'), join(copy.workspaceDir, 'suggestions.real.json'));
      await symlink(join(copy.workspaceDir, 'suggestions.real.json'), join(copy.workspaceDir, 'suggestions.json'));
    },
    logged: ['kind=insecure', 'cause=symlink'],
    lastResort: false,
    says: (copy, lang) =>
      lang === 'en'
        ? {
            message: `A file of this workspace's state is a symbolic link, and smurg follows no link in its state folder: ${join(copy.workspaceDir, 'suggestions.json')}`,
            hint: [UNCHANGED.en, 'smurg host starts when the file itself is in that place: a regular file that belongs to you, mode 600.'],
          }
        : {
            message: `這個工作區有一個狀態檔是符號連結（symlink），smurg 不會跟著狀態資料夾裡的連結走：${join(copy.workspaceDir, 'suggestions.json')}`,
            hint: [UNCHANGED['zh-TW'], '把檔案本身放在那個位置（屬於你自己的一般檔案，權限 600），smurg host 就能啟動。'],
          },
  },
  'insecure, not a file: what is there, no command': {
    fixture: '0.4.0',
    damage: async (copy) => {
      await rm(join(copy.workspaceDir, 'worktrees.json'));
      await mkdir(join(copy.workspaceDir, 'worktrees.json'), { mode: 0o700 });
    },
    logged: ['kind=insecure', 'cause=not-a-file'],
    lastResort: false,
    says: (copy, lang) =>
      lang === 'en'
        ? {
            message: `Where a file of this workspace's state belongs there is a folder: ${join(copy.workspaceDir, 'worktrees.json')}`,
            hint: [UNCHANGED.en, 'smurg reads only a regular file there. smurg host starts when the file itself is back in that place.'],
          }
        : {
            message: `這個工作區的狀態檔該在的位置上，是一個資料夾：${join(copy.workspaceDir, 'worktrees.json')}`,
            hint: [UNCHANGED['zh-TW'], 'smurg 在那裡只讀一般檔案。把檔案本身放回那個位置，smurg host 就能啟動。'],
          },
  },
  ...(notRoot
    ? {
        'cannot-open: the file and the errno in words, never a new workspace': {
          fixture: '0.4.0',
          damage: (copy) => chmod(join(copy.workspaceDir, 'suggestions.json'), 0o000),
          restore: (copy) => chmod(join(copy.workspaceDir, 'suggestions.json'), 0o600),
          logged: ['kind=cannot-open', 'errno=EACCES'],
          lastResort: false,
          says: (copy, lang) =>
            lang === 'en'
              ? {
                  message: `A file of this workspace's state could not be opened or written (permission denied, EACCES): ${join(copy.workspaceDir, 'suggestions.json')}`,
                  hint: [
                    'smurg host did not start, and nothing in the workspace was changed or reset: its members, invite links, keys and settings are as they were.',
                    'When the file can be opened and written again, run smurg host again.',
                  ],
                }
              : {
                  message: `這個工作區有一個狀態檔無法開啟或寫入（沒有權限，EACCES）：${join(copy.workspaceDir, 'suggestions.json')}`,
                  hint: ['smurg host 沒有啟動，工作區裡的東西沒有被更動或重設：成員、邀請連結、金鑰和設定都和原來一樣。', '等這個檔案可以開啟和寫入之後，再執行一次 smurg host。'],
                },
        } satisfies Refusal,
      }
    : {}),
  'other-workspace: that, and nothing to run': {
    fixture: '0.4.0',
    // (the workspace id of the 0.5.0 fixture: a folder copied from another workspace's)
    damage: (copy) => editJson(join(copy.workspaceDir, 'state.json'), (state) => void (state['workspaceId'] = 'ws_n8MKlviIItx2COhFvmlwCw')),
    logged: ['kind=other-workspace'],
    lastResort: false,
    says: (copy, lang) =>
      lang === 'en'
        ? {
            message: `The state file in the folder of workspace ${copy.workspaceId} names another workspace: ${join(copy.workspaceDir, 'state.json')}`,
            hint: [UNCHANGED.en, "The folder was copied from another workspace's, or mixed up with it. smurg does not use it, and no command repairs this: put this workspace's own folder back in its place."],
          }
        : {
            message: `工作區 ${copy.workspaceId} 的資料夾裡，狀態檔寫的是另一個工作區：${join(copy.workspaceDir, 'state.json')}`,
            hint: [UNCHANGED['zh-TW'], '這個資料夾是從另一個工作區複製來的，或是和它弄混了。smurg 不會使用它，也沒有指令可以修好：請把這個工作區自己的資料夾放回原位。'],
          },
  },
  'unreadable, not JSON (a file cut in half), writer unknown: update first; the last resort after its cost': {
    fixture: '0.4.0',
    damage: async (copy) => truncate(join(copy.workspaceDir, 'state.json'), Math.floor((await lstat(join(copy.workspaceDir, 'state.json'))).size / 2)),
    logged: ['kind=unreadable', 'why=not-json'],
    lastResort: true,
    says: (copy, lang) =>
      lang === 'en'
        ? {
            message: `A file of this workspace's state is damaged: it is not valid JSON (it may be empty or cut off): ${join(copy.workspaceDir, 'state.json')}`,
            hint: [UNCHANGED.en, MAYBE_NEWER.en, lastResort('en', mv(copy))],
          }
        : {
            message: `這個工作區有一個狀態檔已損毀：它不是有效的 JSON（可能是空的，或只寫了一半）：${join(copy.workspaceDir, 'state.json')}`,
            hint: [UNCHANGED['zh-TW'], MAYBE_NEWER['zh-TW'], lastResort('zh-TW', mv(copy))],
          },
  },
  'unreadable, no shape any published smurg wrote: the problems by their place in the file, never a value': {
    fixture: '0.5.0',
    damage: (copy) =>
      editJson(join(copy.workspaceDir, 'state.json'), (state) => {
        (state['settings'] as Record<string, unknown>)['allowedDomains'] = ['secret-domain.example'];
        ((state['members'] as Record<string, unknown>[])[1] as Record<string, unknown>)['role'] = 'runner';
      }),
    logged: ['kind=unreadable', 'why=no-known-shape'],
    lastResort: true,
    says: (copy, lang, said) => {
      // The problems are the daemon's own words (places in the document and the rule each breaks): taken as said, checked below.
      const problems = /^ {2}(?:What does not fit: |不符合的地方：)(.*)$/m.exec(said)?.[1] ?? '(no problems line)';
      return lang === 'en'
        ? {
            message: `A file of this workspace's state is not in a form that smurg ${CLI_VERSION} or an earlier published smurg wrote: ${join(copy.workspaceDir, 'state.json')}`,
            hint: [`What does not fit: ${problems}`, UNCHANGED.en, MAYBE_NEWER.en, lastResort('en', mv(copy))],
          }
        : {
            message: `這個工作區有一個狀態檔的格式，不是 smurg ${CLI_VERSION} 或更早發佈的任何版本寫的：${join(copy.workspaceDir, 'state.json')}`,
            hint: [`不符合的地方：${problems}`, UNCHANGED['zh-TW'], MAYBE_NEWER['zh-TW'], lastResort('zh-TW', mv(copy))],
          };
    },
  },
  'unreadable, state.json missing beside the key: nothing was created': {
    fixture: '0.4.0',
    damage: (copy) => rm(join(copy.workspaceDir, 'state.json')),
    logged: ['kind=unreadable', 'why=missing'],
    lastResort: true,
    says: (copy, lang) =>
      lang === 'en'
        ? {
            message: `The state file of this workspace is not there, although other files of the workspace are: ${join(copy.workspaceDir, 'state.json')}`,
            hint: [NOTHING_MADE.en, MAYBE_NEWER.en, lastResort('en', mv(copy))],
          }
        : {
            message: `這個工作區的狀態檔不見了，可是工作區的其他檔案還在：${join(copy.workspaceDir, 'state.json')}`,
            hint: [NOTHING_MADE['zh-TW'], MAYBE_NEWER['zh-TW'], lastResort('zh-TW', mv(copy))],
          },
  },
  'unreadable, the daemon\'s key missing beside state.json: no new key was made': {
    fixture: '0.4.0',
    damage: (copy) => rm(join(copy.workspaceDir, 'identity.key')),
    logged: ['kind=unreadable', 'why=missing'],
    lastResort: true,
    says: (copy, lang) =>
      lang === 'en'
        ? {
            message: `The daemon's key of this workspace is not there, although its state file is: ${join(copy.workspaceDir, 'identity.key')}`,
            hint: [NOTHING_MADE.en, MAYBE_NEWER.en, lastResort('en', mv(copy))],
          }
        : {
            message: `這個工作區的 daemon 金鑰不見了，可是它的狀態檔還在：${join(copy.workspaceDir, 'identity.key')}`,
            hint: [NOTHING_MADE['zh-TW'], MAYBE_NEWER['zh-TW'], lastResort('zh-TW', mv(copy))],
          },
  },
  'unreadable, a value 0.4.0 accepted and this smurg refuses: the entry and the rule; no "newer smurg" (the writer is older)': {
    fixture: '0.4.0',
    damage: (copy) => editJson(join(copy.workspaceDir, 'state.json'), (state) => void ((state['settings'] as Record<string, unknown>)['sharedDirs'] = [MARK_RUN])),
    logged: ['kind=unreadable', 'why=carried-value-refused'],
    lastResort: true,
    says: (copy, lang) =>
      lang === 'en'
        ? {
            message: `A state file that an earlier smurg wrote holds a value that smurg ${CLI_VERSION} does not accept: ${join(copy.workspaceDir, 'state.json')}`,
            hint: ['What does not fit: settings.sharedDirs.0: invalid relative path: mark-run', UNCHANGED.en, lastResort('en', mv(copy))],
          }
        : {
            message: `較早版本的 smurg 寫的狀態檔裡，有一個值是 smurg ${CLI_VERSION} 不接受的：${join(copy.workspaceDir, 'state.json')}`,
            hint: ['不符合的地方：settings.sharedDirs.0: invalid relative path: mark-run', UNCHANGED['zh-TW'], lastResort('zh-TW', mv(copy))],
          },
  },
};

describe('smurg host on a workspace folder it refuses: one text per kind and cause, in both languages, and nothing is changed', () => {
  it.each(Object.entries(REFUSALS))('%s', async (title, refusal) => {
    const shared = await onFixture(refusal.fixture);
    const { copy } = shared;
    await refusal.damage(copy);
    if (refusal.restore) cleanups.push(() => (refusal.restore as (copy: FixtureCopy) => Promise<void>)(copy));
    const before = await pictureOf(copy);
    for (const lang of LANGS) {
      const t = await smurgHost(shared, lang, title, refusal.update ? { update: refusal.update } : {});
      expect(t.started).toBe(false);
      expect(t.code).toBe(1);
      expect(t.out).toBe('');
      // The daemon logged the refusal once, with its kind (errors of the log reach the terminal too) ...
      const { log, said } = stderrOf(t);
      expect(log).toHaveLength(1);
      expect(log[0]).toContain('error "workspace state refused; the daemon does not start" error=StateFileError');
      for (const field of refusal.logged) expect(log[0]).toContain(field);
      // ... and the command says what it is and what to do, word for word.
      const expected = refusal.says(copy, lang, said);
      expect(said).toBe(failure(lang, expected.message, expected.hint));
      // "Move the folder away" is the last resort of an unreadable file and of nothing else.
      expect(/\bmv\b/.test(said)).toBe(refusal.lastResort);
      if (!refusal.lastResort) expect(said).not.toMatch(/new workspace|新的工作區/);
      // Never a value from the file.
      expect(t.err).not.toContain('secret-domain.example');
    }
    // Nothing was changed: the workspace's folder and the sessions' launch files are byte for byte what they were.
    expect(await pictureOf(copy)).toEqual(before);
  }, 120_000);

  it('the problems of a file in no known shape name places and rules (the daemon\'s words), at most eight, then "and N more"', async () => {
    const shared = await onFixture('0.5.0');
    await editJson(join(shared.copy.workspaceDir, 'state.json'), (state) => {
      (state['settings'] as Record<string, unknown>)['allowedDomains'] = ['secret-domain.example'];
      for (const member of state['members'] as Record<string, unknown>[]) member['role'] = 'runner';
    });
    const said = stderrOf(await smurgHost(shared, 'en', 'unreadable: more problems than are shown')).said;
    const line = /^ {2}What does not fit: (.*)$/m.exec(said)?.[1] ?? '';
    expect(line).toMatch(/^members\.0\.role: /);
    expect(line).toMatch(/; and \d+ more$/);
    expect(line.split('; ').length).toBe(9); // eight problems and the count of the rest
    expect(said).not.toContain('runner');
    expect(said).not.toContain('secret-domain.example');
  }, 120_000);

  it('insecure, owner (every file of the folder is another user\'s): who cannot be fixed with chmod, and every such file is named', async () => {
    const shared = await onFixture('0.4.0');
    const { copy } = shared;
    // Only root can make a file another user's. The daemon's checked open (core/private-file.ts) asks whose the file
    // is: for THAT question this user is somebody else; everything else of the command sees the real user.
    const self = process.getuid?.() ?? 0;
    vi.spyOn(process, 'getuid').mockImplementation(() => ((new Error().stack ?? '').includes('/daemon/src/core/private-file.ts') ? self + 1 : self));
    const files = ['identity.key', 'audit.jsonl', 'activity.jsonl', 'state.json', 'conflicts.json', 'worktrees.json', 'sessions.json', 'suggestions.json'].map((name) => join(copy.workspaceDir, name));
    const before = await pictureOf(copy);
    for (const lang of LANGS) {
      const t = await smurgHost(shared, lang, 'insecure, owner');
      const { log, said } = stderrOf(t);
      expect(log).toHaveLength(1);
      expect(log[0]).toContain('kind=insecure');
      expect(log[0]).toContain('cause=owner');
      expect(said).toBe(
        lang === 'en'
          ? failure('en', `8 files of this workspace's state belong to another user, not to you; the first: ${files[0]}`, [
              UNCHANGED.en,
              'smurg uses only state files that belong to you, and chmod does not change who owns a file. If you ever ran smurg with sudo, that is where they come from. The owner or an administrator of this computer gives them back to you (chown); then run smurg host again.',
              `All of them: ${files.join(', ')}`,
            ])
          : failure('zh-TW', `這個工作區有 8 個狀態檔屬於其他使用者，不是你的；第一個：${files[0]}`, [
              UNCHANGED['zh-TW'],
              'smurg 只使用屬於你自己的狀態檔，chmod 也不會改變檔案的擁有者。如果你曾經用 sudo 執行 smurg，這些檔案就是那時候留下的。請檔案的擁有者或這台電腦的管理員把它們交還給你（chown），再執行一次 smurg host。',
              `全部是：${files.join('、')}`,
            ]),
      );
      expect(said).not.toMatch(/\bmv\b|chmod 600/);
    }
    expect(await pictureOf(copy)).toEqual(before);
  }, 120_000);

  it('the one chmod the text names cures every listed file: the next smurg host starts', async () => {
    const shared = await onFixture('0.5.0');
    const { copy } = shared;
    for (const name of ['state.json', 'topics.json', 'audit.jsonl']) await chmod(join(copy.workspaceDir, name), 0o644);
    const said = stderrOf(await smurgHost(shared, 'en', 'insecure, mode: three files')).said;
    const command = /^ {2}(chmod 600 .*)$/m.exec(said)?.[1] ?? '';
    expect(command).toBe(`chmod 600 ${['audit.jsonl', 'state.json', 'topics.json'].map((name) => join(copy.workspaceDir, name)).join(' ')}`);
    execFileSync('/bin/sh', ['-c', command]);
    const again = await smurgHost(shared, 'en', 'after the chmod');
    expect(again.started).toBe(true);
    expect(again.out).toBe(cleanStart('en', again.out, PAUSED_050));
  }, 120_000);
});

// ---- the kept copy, the put back, the last resort

describe('a damaged state.json beside the copy an upgrade kept', () => {
  it('names the newest copy and its date AFTER what putting it back undoes; put back, the start says so and the kick since is undone', async () => {
    for (const lang of LANGS) {
      const shared = await onFixture('0.4.0');
      const { copy } = shared;
      const ws = copy.workspaceDir;
      // The update: smurg host upgrades the folder; then the host removes Gina (she was an editor under 0.4.0).
      const upgraded = await smurgHost(shared, lang, 'the upgrade, then a member is removed', {
        during: (daemon) => {
          const host = daemon.ctx.members.principalOf(HOST.userId);
          if (!host) throw new Error('no host');
          daemon.ctx.members.kick('dev:gina', host);
          expect(daemon.ctx.members.get('dev:gina')?.status).toBe('kicked');
        },
      });
      expect(upgraded.started).toBe(true);
      const kept = join(ws, 'state.json.before-upgrade-from-0.4.0');
      const keptAt = formatTime((await lstat(kept)).mtimeMs);

      // Weeks later state.json is damaged. The writer is known (this smurg stamped the folder): no "newer smurg" line.
      await truncate(join(ws, 'state.json'), 100);
      const before = await pictureOf(copy);
      const refused = await smurgHost(shared, lang, 'unreadable, with a kept copy beside it');
      expect(stderrOf(refused).said).toBe(
        lang === 'en'
          ? failure('en', `A file of this workspace's state is damaged: it is not valid JSON (it may be empty or cut off): ${join(ws, 'state.json')}`, [
              UNCHANGED.en,
              'smurg kept a copy of this file as it was before an upgrade, for reading what the workspace held. Putting it back undoes everything decided since then: ' +
                `people removed since are members again, revoked devices and revoked or used-up invite links work again, and role changes are gone. The newest copy: state.json.before-upgrade-from-0.4.0, kept ${keptAt}.`,
              lastResort('en', mv(copy)),
            ])
          : failure('zh-TW', `這個工作區有一個狀態檔已損毀：它不是有效的 JSON（可能是空的，或只寫了一半）：${join(ws, 'state.json')}`, [
              UNCHANGED['zh-TW'],
              'smurg 在升級前保留了這個檔案當時的副本，用來查看工作區當時的內容。把它放回去，會取消那之後決定的每一件事：' +
                `之後被移出的人又會是成員，已撤銷的裝置、已撤銷或已用完的邀請連結又可以使用，角色的變更也會消失。最新的副本：state.json.before-upgrade-from-0.4.0，保留於 ${keptAt}。`,
              lastResort('zh-TW', mv(copy)),
            ]),
      );
      expect(await pictureOf(copy)).toEqual(before);

      // The host puts the copy back. smurg upgrades it again and SAYS that an older file was put back, with what that undoes.
      await copyFile(kept, join(ws, 'state.json'));
      let gina: string | undefined;
      const putBack = await smurgHost(shared, lang, 'an older state.json put back', {
        during: (daemon) => {
          expect(daemon.putBack).toBe(true);
          gina = daemon.ctx.members.get('dev:gina')?.status;
        },
      });
      const warning =
        lang === 'en'
          ? 'Warning: an OLDER state.json was put back into this workspace and upgraded again. Everything decided since it was written is undone: ' +
            `people removed since are members again, revoked devices and revoked or used-up invite links work again, and role changes are gone. Guide: ${GUIDE.en}`
          : `⚠ 較舊的 state.json 被放回這個工作區，並且重新升級了。它寫入之後決定的每一件事都被取消：之後被移出的人又是成員，已撤銷的裝置、已撤銷或已用完的邀請連結又可以使用，角色的變更也消失了。說明：${GUIDE['zh-TW']}`;
      expect(putBack.out).toBe(`${warning}\n${cleanStart(lang, putBack.out)}`);
      // What it undoes (documented, not prevented): Gina is a member again.
      expect(gina).toBe('active');
    }
  }, 180_000);

  it('the last resort cannot nest: followed twice, the two folders lie side by side; the new workspace is told once about the folder set aside', async () => {
    const shared = await onFixture('0.4.0');
    const { copy } = shared;
    const ws = copy.workspaceDir;
    const parent = join(copy.hostHome, 'workspaces');
    const lastLine = (said: string): string => said.trimEnd().split('\n').at(-1)?.trim() ?? '';

    await truncate(join(ws, 'state.json'), 100);
    const first = lastLine(stderrOf(await smurgHost(shared, 'en', 'the last resort, the first time')).said);
    expect(first).toBe(`mv ${ws} ${ws}.old-${NOW_NAME}`);
    execFileSync('/bin/sh', ['-c', first]);
    expect((await readdir(parent)).sort()).toEqual([`${copy.workspaceId}.old-${NOW_NAME}`]);

    // A new workspace (what the last resort costs: the host alone, a new key). It is told ONCE that a folder was set aside.
    const fresh = await smurgHost(shared, 'en', 'a new workspace beside the folder set aside', { during: (daemon) => expect(daemon.ctx.members.list().map((member) => member.userId)).toEqual([HOST.userId]) });
    const aside = `An earlier state folder of this workspace lies beside the one in use: ${ws}.old-${NOW_NAME}. smurg does not use it. If you moved it away because smurg 0.5.0 told you to after an update, the guide says how to go back to it: ${GUIDE.en}`;
    expect(fresh.out).toBe(`${aside}\n${cleanStart('en', fresh.out)}`);
    const later = await smurgHost(shared, 'en', 'the same new workspace, a second start');
    expect(later.out).toBe(cleanStart('en', later.out));

    // The same misfortune again, at the same second of the clock: the example names ANOTHER folder that is not there.
    await truncate(join(ws, 'state.json'), 100);
    const second = lastLine(stderrOf(await smurgHost(shared, 'en', 'the last resort, a second time')).said);
    expect(second).toBe(`mv ${ws} ${ws}.old-${NOW_NAME}-2`);
    execFileSync('/bin/sh', ['-c', second]);
    expect((await readdir(parent)).sort()).toEqual([`${copy.workspaceId}.old-${NOW_NAME}`, `${copy.workspaceId}.old-${NOW_NAME}-2`]);
    // Neither is inside the other.
    expect(await readdir(join(parent, `${copy.workspaceId}.old-${NOW_NAME}`))).not.toContain(copy.workspaceId);
    expect(await readdir(join(parent, `${copy.workspaceId}.old-${NOW_NAME}`))).toContain('identity.key');
    expect(await readdir(join(parent, `${copy.workspaceId}.old-${NOW_NAME}-2`))).toContain('identity.key');
  }, 180_000);
});

// ---- the folder 0.5.0's advice left

describe('a folder named <workspace id>.old* beside the one that is opened (0.5.0\'s advice, followed)', () => {
  it('is said in ONE line at the first start of this smurg on the folder, with the guide\'s address, and not again', async () => {
    for (const lang of LANGS) {
      const shared = await onFixture('0.5.0');
      const ws = shared.copy.workspaceDir;
      // What `mv <folder> <folder>.old` left under 0.5.0: the old state beside the new one. (And once more, later.)
      await mkdir(`${ws}.old`, { mode: 0o700 });
      await writeFile(join(`${ws}.old`, 'state.json'), '{}', { mode: 0o600 });
      await mkdir(`${ws}.old2`, { mode: 0o700 });
      // A file of that name is no folder set aside.
      await writeFile(`${ws}.old-notes.txt`, 'x', { mode: 0o600 });
      const oldPicture = await picture(`${ws}.old`);

      const first = await smurgHost(shared, lang, 'a <workspace id>.old folder beside the one that is opened');
      const line =
        lang === 'en'
          ? `An earlier state folder of this workspace lies beside the one in use: ${ws}.old (and 1 more). smurg does not use it. If you moved it away because smurg 0.5.0 told you to after an update, the guide says how to go back to it: ${GUIDE.en}`
          : `這個工作區之前的狀態資料夾還放在旁邊：${ws}.old（另外還有 1 個）。smurg 不會使用它。如果你是在更新後照 smurg 0.5.0 的指示把它移開的，說明文件有換回去的方法：${GUIDE['zh-TW']}`;
      expect(first.out).toBe(`${line}\n${cleanStart(lang, first.out, PAUSED_050)}`);
      expect(await picture(`${ws}.old`)).toEqual(oldPicture);
      expect(await readFile(hostLogPath(statePaths(shared.env), shared.copy.workspaceId), 'utf8')).toContain('An earlier state folder of this workspace lies beside the one in use');

      const second = await smurgHost(shared, lang, 'the same, a second start');
      expect(second.out).toBe(cleanStart(lang, second.out, PAUSED_050));
    }
  }, 120_000);
});

describe('the way back to the folder 0.5.0 told the host to move away', () => {
  it('the old folder is moved back: smurg host upgrades it, says so in one line, and the members and the daemon key of 0.4.0 are there again', async () => {
    const shared = await onFixture('0.4.0');
    const ws = shared.copy.workspaceDir;
    const keyOf = (out: string): string => /#k=([A-Za-z0-9_-]+)&/.exec(out)?.[1] ?? '(no link)';
    // The daemon key 0.4.0's teammates have pinned: the one in every invite link 0.4.0 made.
    const ledger = JSON.parse(await readFile(join(PUBLISHED_FIXTURES, '0.4.0', 'ledger.json'), 'utf8')) as { invites: Record<string, { url: string }> };
    const oldKey = keyOf((Object.values(ledger.invites)[0] as { url: string }).url);

    // What the host did under 0.5.0 (its advice): the folder moved away, then a new workspace under the same id.
    await rename(ws, `${ws}.old`);
    const fresh = await smurgHost(shared, 'en', "0.5.0's advice followed: a new workspace beside the old folder", {
      during: (daemon) => expect(daemon.ctx.members.list().map((member) => member.userId)).toEqual([HOST.userId]),
    });
    expect(fresh.out).toBe(
      `An earlier state folder of this workspace lies beside the one in use: ${ws}.old. smurg does not use it. If you moved it away because smurg 0.5.0 told you to after an update, the guide says how to go back to it: ${GUIDE.en}\n${cleanStart('en', fresh.out)}`,
    );
    expect(keyOf(fresh.out)).not.toBe(oldKey);

    // The way back: stop sharing (done), set the new folder aside under a name that is not `.old*`, move the old one back.
    await rename(ws, `${ws}.new-workspace`);
    await rename(`${ws}.old`, ws);
    let members: string[] = [];
    const back = await smurgHost(shared, 'en', 'the old folder moved back', {
      during: (daemon) => {
        expect(daemon.putBack).toBe(false);
        members = daemon.ctx.members.list().map((member) => member.userId);
      },
    });
    // ONE line: the upgrade (this folder was last shared with 0.4.0). Nothing about a folder set aside: there is none.
    expect(back.out).toBe(`This workspace was last shared with smurg 0.4.0: its members, invite links and settings were carried over. What changed: ${GUIDE.en}\n${cleanStart('en', back.out)}`);
    expect(keyOf(back.out)).toBe(oldKey);
    expect(members).toEqual(expect.arrayContaining(['dev:host', 'dev:amy', 'dev:bob', 'dev:carol', 'dev:ivan']));
    expect(members).toHaveLength(8);
  }, 120_000);
});

// ---- a peer of another protocol version

/** msgpack of `{ protocolVersion: n }` (0 <= n < 128): all that is read of a hello of another version. */
const helloOf = (protocolVersion: number): Uint8Array => Uint8Array.from([0x81, 0xa0 | 15, ...Buffer.from('protocolVersion', 'utf8'), protocolVersion]);

/** A device that finished the handshake and says another protocol version: the daemon's own admission answers it. */
function knock(daemon: Daemon, publicKeyHex: string, protocolVersion: number): void {
  const { members, invites, hub } = daemon.internals;
  const ctx: AdmitContext = { mode: 'device', clientStaticKey: Uint8Array.from(Buffer.from(publicKeyHex, 'hex')), helloPayload: helloOf(protocolVersion), handshakeHash: new Uint8Array(32) };
  const result = admitConnection(ctx, 'interactive', { userId: 'dev:somebody', displayName: 'Somebody' }, {
    invites,
    members,
    hub,
    identity: { verify: () => ({ ok: false, reason: 'malformed' }) } as never,
    settings: daemon.ctx.settings,
    audit: daemon.ctx.audit,
    bus: daemon.ctx.bus,
    clock: daemon.ctx.clock,
    log: silentLogger,
    limits: daemon.ctx.config.limits,
    workspace: () => daemon.ctx.workspace.info,
    requestKeyRefresh: () => {},
  });
  expect(result.admitted).toBeNull();
}

describe('a page or smurg of another protocol version that the daemon turned away', () => {
  it('a known teammate\'s: ONE line per run and direction on the host\'s terminal; a removed member\'s or a stranger\'s: nothing', async () => {
    const shared = await onFixture('0.5.0');
    const state = JSON.parse(await readFile(join(shared.copy.workspaceDir, 'state.json'), 'utf8')) as { devices: { userId: string; publicKeyHex: string; revoked: boolean }[] };
    const amy = state.devices.find((device) => device.userId === 'dev:amy' && !device.revoked)?.publicKeyHex as string;
    const erin = state.devices.find((device) => device.userId === 'dev:erin' && device.revoked)?.publicKeyHex as string;
    expect([amy, erin].every((key) => /^[0-9a-f]{64}$/.test(key))).toBe(true);
    for (const lang of LANGS) {
      const newer =
        lang === 'en'
          ? "Warning: a teammate's page or smurg is newer than this smurg and was turned away. Stop sharing, run smurg update, then share again."
          : '⚠ 有組員的網頁或 smurg 比這個 smurg 新，連線被拒絕了。請停止分享，執行 smurg update，再重新分享。';
      const older =
        lang === 'en'
          ? 'A page or smurg older than this smurg was turned away. The teammate reloads the page or updates smurg; if you run your own relay, deploy it again.'
          : '有一個比這個 smurg 舊的網頁或 smurg 被拒絕連線。請組員重新整理網頁或更新 smurg；如果你用的是自己架的 relay，請重新部署它。';
      const t = await smurgHost(shared, lang, 'peers of another protocol version are turned away', {
        during: async (daemon, io) => {
          // Erin was removed under 0.5.0 and still has the daemon's key; a stranger never joined. Whatever they say: nothing.
          knock(daemon, erin, PROTOCOL_VERSION + 1);
          knock(daemon, 'ee'.repeat(32), 99);
          knock(daemon, erin, PROTOCOL_VERSION - 1);
          expect(io.out()).not.toContain(newer);
          expect(io.out()).not.toContain(older);
          // Amy's browser runs a newer page (twice), then an older one (twice).
          knock(daemon, amy, PROTOCOL_VERSION + 1);
          knock(daemon, amy, PROTOCOL_VERSION + 1);
          knock(daemon, amy, PROTOCOL_VERSION - 1);
          knock(daemon, amy, PROTOCOL_VERSION - 1);
        },
      });
      // Under the links, each ONCE (as the other notices of a running share: a blank line, then the sentence), then the stop.
      const clean = cleanStart(lang, t.out, PAUSED_050);
      const stopAt = clean.indexOf(lang === 'en' ? '\nReceived SIGTERM' : '\n收到 SIGTERM');
      expect(t.out).toBe(`${clean.slice(0, stopAt)}\n${newer}\n\n${older}\n${clean.slice(stopAt)}`);
    }
  }, 120_000);
});

// Verification M1 (2026-10-02): HOSTING §5.1 (the steps after taking agent access back, step 1) replaces the workspace's
// keys on purpose: the workspace's folder is moved away, the workspace id stays and the daemon key is new. A member who
// joined with the CLI has the old key pinned: `smurg attach --invite <new link>` used to abort with the impersonation
// warning, with no way to accept the new key. Now it explains the change as the web does (the key-change notice, both
// fingerprints) and continues only with an explicit yes or --accept-new-key.
describe('a CLI member after the host started over with new workspace keys (verification M1)', () => {
  it('is told that the host computer\'s key has changed, with both fingerprints; nothing is sent and the pin stays without a yes; y or --accept-new-key joins and re-pins', async () => {
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

    async function share(): Promise<{ daemon: Daemon; invite: string; out: () => string; stop: () => Promise<number> }> {
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
        out: () => io.out(),
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

    // 2. The host starts over (HOSTING §5.1 step 1): stop, move the workspace state aside, share again.
    expect(await first.stop()).toBe(0);
    const wsDir = workspaceStateDir(paths, workspaceId);
    await rename(wsDir, `${wsDir}.old`);
    const second = await share();
    expect(second.daemon.workspaceId).toBe(workspaceId);
    expect(equalBytes(second.daemon.daemonPublicKey, oldKey)).toBe(false);
    // The new workspace's first start names the folder that was set aside, in words that fit a host who did it on purpose.
    expect(second.out()).toContain(`An earlier state folder of this workspace lies beside the one in use: ${wsDir}.old. smurg does not use it.`);
    expect(basename(`${wsDir}.old`)).toBe(`${workspaceId}.old`);
    const oldPrint = formatFingerprintForDisplay(daemonKeyFingerprint(oldKey));
    const membersOf = (): string[] => second.daemon.ctx.members.list().map((m) => m.displayName).sort();

    // 3a. With the pinned key only: the warning says what to do if the host started over.
    const pinnedOnly = testIo({ env: amy.env });
    const pinnedFailure = formatFailure(await runAttach(['--workspace', workspaceId], commandContext(pinnedOnly), { relayFor: amy.relayFor }).then((code) => new Error(`exit ${code}`), (err: unknown) => err), 'en');
    expect(pinnedFailure.text).toContain("the key of the host's computer differs from the one this computer recorded last time");
    expect(pinnedFailure.text).toContain('ask them for a new invite link, join with smurg attach --invite -');

    // 3b. The new link, nobody answers (no terminal) or the answer is not yes: explained, cancelled, nothing changed.
    for (const answer of [null, 'n', 'nein']) {
      const io = testIo({ env: amy.env, readLine: async () => answer });
      const failed = formatFailure(await runAttach(['--invite', second.invite], commandContext(io), { relayFor: amy.relayFor }).then((code) => new Error(`exit ${code}`), (err: unknown) => err), 'en');
      expect(io.err()).toContain("The host computer's key has changed");
      expect(io.err()).toContain(`Key fingerprint recorded last time: ${oldPrint}`);
      expect(io.err()).toContain(`Key fingerprint in the invite link: ${second.daemon.fingerprint}`);
      expect(io.err()).toContain('"daemon key fingerprint" the host');
      expect(failed).toMatchObject({ exitCode: 1 });
      expect(failed.text).toContain('Cancelled; nothing was connected, and the host key this computer recorded is unchanged.');
      expect(failed.text).toContain(answer === null ? 'run the command again with --accept-new-key' : 'Run the command again after you confirmed the key fingerprint with the host');
      expect(equalBytes((await readPinnedDaemonKey(amy.stateDir, workspaceId)) as Uint8Array, oldKey)).toBe(true);
      expect(membersOf()).toEqual(['Ian']);
    }

    // 3c. Amy answers y at her terminal: she joins with the new link and her CLI pins the new key.
    const prompts: string[] = [];
    const yes = testIo({ env: amy.env, readLine: async (prompt) => (prompts.push(prompt), 'y') });
    expect(await runAttach(['--invite', second.invite], commandContext(yes), { relayFor: amy.relayFor })).toBe(0);
    expect(prompts).toEqual(['Did you confirm it? Type y to join with the new link, anything else to cancel: ']);
    expect(yes.out()).toContain('This workspace has no sessions.');
    expect(equalBytes((await readPinnedDaemonKey(amy.stateDir, workspaceId)) as Uint8Array, second.daemon.daemonPublicKey)).toBe(true);
    // Later the pinned (new) key alone is enough, with no question.
    const later = testIo({ env: amy.env, readLine: async () => 'unexpected question' });
    expect(await runAttach(['--workspace', workspaceId], commandContext(later), { relayFor: amy.relayFor })).toBe(0);
    expect(later.err()).not.toContain("The host computer's key has changed");

    // 3d. Bob, without a terminal, after checking the fingerprint with the host: --accept-new-key.
    const flagged = testIo({ env: bob.env });
    expect(await runAttach(['--invite', second.invite, '--accept-new-key'], commandContext(flagged), { relayFor: bob.relayFor })).toBe(0);
    expect(flagged.err()).toContain("The host computer's key has changed");
    expect(flagged.err()).toContain("--accept-new-key was given: using the invite link's key.");
    expect(equalBytes((await readPinnedDaemonKey(bob.stateDir, workspaceId)) as Uint8Array, second.daemon.daemonPublicKey)).toBe(true);
    expect(membersOf()).toEqual(['Amy', 'Bob', 'Ian']);
    expect(await second.stop()).toBe(0);
  }, 60_000);
});
