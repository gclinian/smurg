// The words of `smurg host` about a workspace's state (src/commands/host-state.ts; 0.5.1, DESIGN A7, B4, C), for what
// host-state-file.test.ts cannot make in a real folder: a file of another user (that takes root), the errno of a disk
// that fails, a socket or a device in a file's place, a path that needs quoting, a stamp that names an older smurg, and
// the pieces around them (the upgrade line's variants, the folders set aside, the refused peers held until the links
// are printed). Each refusal is the daemon's own error (StateFileError, as its contract gives it) through the same
// function the command uses, in both languages.
import { execFileSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_MODULES, LOG_UNSAFE_CHARACTER, STAMP_FILE, StateFileError } from '@smurg/daemon';
import { createTempDir, removeTempDir } from '@smurg/daemon/testing';
import { formatFailure } from '../src/cli/errors.ts';
import { foldersSetAside, oldFolderNotice, shellWord, shown, stateFileProblem, upgradeNotice, wasStamped, watchRefusedPeers, watchSmurgTracked, type FileLook, type RefusalContext } from '../src/commands/host-state.ts';
import { SET_ASIDE_DOCUMENTS } from '../src/i18n/en.ts';
import { m, renderText, type Text } from '../src/i18n/index.ts';
import { CLI_VERSION } from '../src/version.ts';
import { testIo } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

type Lang = 'en' | 'zh-TW';
const WS = 'ws_x0ero8pS70bWM5G4VbZ1NA';
const DIR = `/home/ian/.smurg/workspaces/${WS}`;
const NOW = new Date(2026, 9, 8, 14, 5, 7).getTime();
const ME = 501;
/** Where the one-line notices send the host: HOSTING 9.2 (what an update keeps, and a copy put back) and 9.4 (the folder moved away). */
const GUIDE_KEPT = { en: 'https://smurg.ai/docs/hosting/#92-after-an-update-what-your-workspace-keeps', 'zh-TW': 'https://smurg.ai/zh-TW/docs/hosting/#92-更新之後工作區保留了什麼' } as const;
const GUIDE_BACK = {
  en: 'https://smurg.ai/docs/hosting/#94-if-you-moved-the-state-folder-away-because-smurg-050-told-you-to',
  'zh-TW': 'https://smurg.ai/zh-TW/docs/hosting/#94-如果你照-smurg-050-的指示把狀態資料夾移走了',
} as const;

/** What the file system would say about each path (nothing: the path is not there). */
function context(looks: Readonly<Record<string, FileLook>> = {}, more: Partial<RefusalContext> = {}): RefusalContext {
  return { io: testIo({ env: { HOME: '/nonexistent' }, now: () => NOW }), workspaceId: WS, workspaceDir: DIR, lookAt: async (path) => looks[path] ?? null, ownUid: ME, ...more };
}
const file = (uid: number, mode = 0o600): FileLook => ({ uid, mode, kind: 'file' });

/** What the terminal says about `refusal`: `smurg: <message>` and the hint's lines. */
async function said(refusal: StateFileError, lang: Lang, ctx: RefusalContext = context()): Promise<string> {
  return formatFailure(await stateFileProblem(refusal, ctx), lang).text;
}
const lines = (text: string): string[] => text.trimEnd().split('\n');

describe('insecure, owner: who owns the file, and no chmod', () => {
  const refusal = (paths: readonly string[]): StateFileError => new StateFileError({ kind: 'insecure', cause: 'owner', path: paths[0] as string, paths, message: 'state file is owned by another user' });

  it('root by name (one `sudo smurg host` leaves root\'s files), anyone else by number', async () => {
    const state = `${DIR}/state.json`;
    expect(await said(refusal([state]), 'en', context({ [state]: file(0) }))).toBe(
      `smurg: A file of this workspace's state belongs to another user, not to you (root): ${state}\n` +
        '  Nothing was changed.\n' +
        '  smurg uses only state files that belong to you, and chmod does not change who owns a file. If you ever ran smurg with sudo, that is where it comes from. The owner or an administrator of this computer gives it back to you (chown); then run smurg host again.\n',
    );
    expect(await said(refusal([state]), 'zh-TW', context({ [state]: file(0) }))).toBe(
      `smurg：這個工作區有一個狀態檔屬於其他使用者，不是你的（root）：${state}\n` +
        '  沒有更動任何東西。\n' +
        '  smurg 只使用屬於你自己的狀態檔，chmod 也不會改變檔案的擁有者。如果你曾經用 sudo 執行 smurg，這個檔案就是那時候留下的。請檔案的擁有者或這台電腦的管理員把它交還給你（chown），再執行一次 smurg host。\n',
    );
    expect(lines(await said(refusal([state]), 'en', context({ [state]: file(502) })))[0]).toBe(`smurg: A file of this workspace's state belongs to another user, not to you (user ID 502): ${state}`);
    expect(lines(await said(refusal([state]), 'zh-TW', context({ [state]: file(502) })))[0]).toBe(`smurg：這個工作區有一個狀態檔屬於其他使用者，不是你的（使用者 ID 502）：${state}`);
    // The file went away, or is this user's by now: no owner is claimed.
    expect(lines(await said(refusal([state]), 'en'))[0]).toBe(`smurg: A file of this workspace's state belongs to another user, not to you: ${state}`);
    expect(lines(await said(refusal([state]), 'en', context({ [state]: file(ME) })))[0]).toBe(`smurg: A file of this workspace's state belongs to another user, not to you: ${state}`);
  });

  it('several: the first with its owner, then all of them; never a chmod, never a move', async () => {
    const paths = [`${DIR}/identity.key`, `${DIR}/state.json`, `${DIR}/topics.json`];
    const en = await said(refusal(paths), 'en', context({ [paths[0] as string]: file(0) }));
    expect(lines(en)[0]).toBe(`smurg: 3 files of this workspace's state belong to another user, not to you; the first (root): ${paths[0]}`);
    expect(lines(en).at(-1)).toBe(`  All of them: ${paths.join(', ')}`);
    const zh = await said(refusal(paths), 'zh-TW', context({ [paths[0] as string]: file(0) }));
    expect(lines(zh)[0]).toBe(`smurg：這個工作區有 3 個狀態檔屬於其他使用者，不是你的；第一個（root）：${paths[0]}`);
    expect(lines(zh).at(-1)).toBe(`  全部是：${paths.join('、')}`);
    for (const text of [en, zh]) expect(text).not.toMatch(/chmod 600|\bmv\b|sudo chown/);
  });
});

describe('insecure, mode: one command for every path', () => {
  it('each path is ONE word of the command, whatever characters it has; the mode is the one found', async () => {
    const dir = "/home/ian/My Files/it's here/.smurg/workspaces/ws_a";
    const paths = [`${dir}/state.json`, `${dir}/audit.jsonl`];
    const refusal = new StateFileError({ kind: 'insecure', cause: 'mode', mode: 0o604, path: paths[0] as string, paths, message: 'state file mode 604 grants group/other access' });
    const en = await said(refusal, 'en', context({}, { workspaceDir: dir }));
    expect(lines(en)[0]).toBe(`smurg: 2 files of this workspace's state are open to other users of this computer; the first (mode 604): ${paths[0]}`);
    expect(lines(en).at(-1)).toBe(`  chmod 600 '/home/ian/My Files/it'\\''s here/.smurg/workspaces/ws_a/state.json' '/home/ian/My Files/it'\\''s here/.smurg/workspaces/ws_a/audit.jsonl'`);
    // One file: "it", and the mode the file has when the refusal carries none.
    const one = new StateFileError({ kind: 'insecure', cause: 'mode', path: `${DIR}/state.json`, message: 'state file grants group/other access' });
    expect(await said(one, 'en', context({ [`${DIR}/state.json`]: file(ME, 0o660) }))).toBe(
      `smurg: A file of this workspace's state is open to other users of this computer (mode 660): ${DIR}/state.json\n` +
        '  Nothing was changed.\n' +
        "  Until now, other users of this computer could read or change it (a workspace's state holds the daemon's key and the keys of its invite links). Make it yours alone, then run smurg host again:\n" +
        `  chmod 600 ${DIR}/state.json\n`,
    );
    expect(await said(one, 'zh-TW', context({ [`${DIR}/state.json`]: file(ME, 0o660) }))).toBe(
      `smurg：這個工作區有一個狀態檔，這台電腦的其他使用者也能存取（權限 660）：${DIR}/state.json\n` +
        '  沒有更動任何東西。\n' +
        '  在這之前，這台電腦的其他使用者可以讀取或更動這個檔案（工作區的狀態裡有 daemon 金鑰和邀請連結的金鑰）。請改成只有你自己能存取，再執行一次 smurg host：\n' +
        `  chmod 600 ${DIR}/state.json\n`,
    );
  });

  it('shellWord: a shell reads the word back as the path it was', () => {
    for (const path of ['/plain/path-1.2_3@x', '/with space/a', "/it's/a", '/a"b', '/a$HOME`id`', '/a;rm -rf b', '/a\\b', '/工作區/狀態', '/a*?[b]', "/'''"]) {
      expect(execFileSync('/bin/sh', ['-c', `printf %s ${shellWord(path)}`], { encoding: 'utf8' }), path).toBe(path);
    }
    expect(shellWord('/plain/path-1.2_3@x')).toBe('/plain/path-1.2_3@x');
    expect(shellWord('/with space/a')).toBe("'/with space/a'");
  });

  it('shellWord: a path with a character that acts on a terminal is written without it ($\'…\' of bash and zsh), and the shell still reads the path back', () => {
    const paths = ['/a\nb', '/a\tb', '/a\u001b[2J\u001b]0;pwned\u0007b', "/it's\u001b/a\\b", '/a\u202eb/工作區', '/a\u0085b\u00adc\ufeffd', '/a\u001bab'];
    for (const path of paths) {
      const word = shellWord(path);
      expect(LOG_UNSAFE_CHARACTER.test(word), JSON.stringify(word)).toBe(false);
      expect(word.startsWith("$'") && word.endsWith("'"), word).toBe(true);
      expect(execFileSync('/bin/bash', ['-c', `printf %s ${word}`], { encoding: 'utf8' }), JSON.stringify(path)).toBe(path);
    }
    expect(shellWord('/a\u001b[2Jb')).toBe("$'/a\\x1b[2Jb'");
    expect(shellWord('/a\u202eb')).toBe("$'/a\\xe2\\x80\\xaeb'");
  });
});

describe('insecure, a symlink or something that is no file: what is there, and no command', () => {
  it('names what is in the file\'s place', async () => {
    const path = `${DIR}/sessions.json`;
    const refusal = new StateFileError({ kind: 'insecure', cause: 'not-a-file', path, message: 'state file is not a regular file' });
    const found: readonly [FileLook['kind'], string, string][] = [
      ['directory', 'a folder', '一個資料夾'],
      ['fifo', 'a named pipe (FIFO)', '一個具名管道（FIFO）'],
      ['socket', 'a socket', '一個 socket'],
      ['device', 'a device', '一個裝置檔'],
      ['other', 'something that is not a regular file', '不是一般檔案的東西'],
    ];
    for (const [kind, english, chinese] of found) {
      const ctx = context({ [path]: { uid: ME, mode: 0o600, kind } });
      expect(lines(await said(refusal, 'en', ctx))[0]).toBe(`smurg: Where a file of this workspace's state belongs there is ${english}: ${path}`);
      expect(lines(await said(refusal, 'zh-TW', ctx))[0]).toBe(`smurg：這個工作區的狀態檔該在的位置上，是${chinese}：${path}`);
    }
    // It is gone, or a file by now: nothing is guessed.
    expect(lines(await said(refusal, 'en'))[0]).toBe(`smurg: Where a file of this workspace's state belongs there is something that is not a regular file: ${path}`);
  });

  it('several of them: the first, then all', async () => {
    const paths = [`${DIR}/sessions.json`, `${DIR}/inbox.json`];
    const notFiles = new StateFileError({ kind: 'insecure', cause: 'not-a-file', path: paths[0] as string, paths, message: 'state file is not a regular file' });
    const ctx = context({ [paths[0] as string]: { uid: ME, mode: 0o700, kind: 'directory' } });
    expect(await said(notFiles, 'en', ctx)).toBe(
      `smurg: In 2 places where files of this workspace's state belong there is something else; in the first, a folder: ${paths[0]}\n` +
        '  Nothing was changed.\n' +
        '  smurg reads only a regular file there. smurg host starts when the file itself is back in that place.\n' +
        `  All of them: ${paths.join(', ')}\n`,
    );
    expect(lines(await said(notFiles, 'zh-TW', ctx))[0]).toBe(`smurg：這個工作區有 2 個狀態檔該在的位置上是別的東西；第一個是一個資料夾：${paths[0]}`);
    const links = new StateFileError({ kind: 'insecure', cause: 'symlink', path: paths[0] as string, paths, message: 'state file is a symlink' });
    expect(await said(links, 'en')).toBe(
      `smurg: 2 files of this workspace's state are symbolic links, and smurg follows no link in its state folder; the first: ${paths[0]}\n` +
        '  Nothing was changed.\n' +
        '  smurg host starts when the file itself is in that place: a regular file that belongs to you, mode 600.\n' +
        `  All of them: ${paths.join(', ')}\n`,
    );
    expect(lines(await said(links, 'zh-TW'))[0]).toBe(`smurg：這個工作區有 2 個狀態檔是符號連結（symlink），smurg 不會跟著狀態資料夾裡的連結走；第一個：${paths[0]}`);
  });
});

describe('cannot-open: the file and the errno in words; never a new workspace', () => {
  const refusal = (errno: string | undefined, paths: readonly string[] = [`${DIR}/state.json`]): StateFileError =>
    new StateFileError({ kind: 'cannot-open', path: paths[0] as string, paths, message: 'cannot open the state file', ...(errno === undefined ? {} : { errno }) });

  it('says each errno in words, with the code; a code it has no words for as it is; anything else is not shown', async () => {
    const words: readonly [string | undefined, string, string][] = [
      ['EACCES', 'permission denied, EACCES', '沒有權限，EACCES'],
      ['EPERM', 'the system does not permit it, EPERM', '系統不允許，EPERM'],
      ['EIO', 'read or write error; the disk may be failing, EIO', '讀寫發生錯誤，磁碟可能有問題，EIO'],
      ['ENOSPC', 'no space left on the disk, ENOSPC', '磁碟空間不足，ENOSPC'],
      ['EDQUOT', 'the disk quota is used up, EDQUOT', '磁碟配額已用完，EDQUOT'],
      ['EROFS', 'the file system is read-only, EROFS', '檔案系統是唯讀的，EROFS'],
      ['EISDIR', 'it is a folder, EISDIR', '它是一個資料夾，EISDIR'],
      ['ENOTDIR', 'a part of its path is not a folder, ENOTDIR', '路徑裡有一段不是資料夾，ENOTDIR'],
      ['EMFILE', 'too many open files, EMFILE', '開啟的檔案太多，EMFILE'],
      ['ENFILE', 'too many open files, ENFILE', '開啟的檔案太多，ENFILE'],
      ['EBUSY', 'the file is in use, EBUSY', '檔案正在使用中，EBUSY'],
      ['ENOENT', 'it is not there, ENOENT', '找不到，ENOENT'],
      ['EEXIST', 'a file of that name is already there, EEXIST', '已經有同名的檔案，EEXIST'],
      ['ELOOP', 'too many symbolic links, ELOOP', '符號連結太多層，ELOOP'],
      ['ENAMETOOLONG', 'the path is too long, ENAMETOOLONG', '路徑太長，ENAMETOOLONG'],
      ['ESTALE', 'ESTALE', 'ESTALE'],
      ['unknown', 'the system gave no reason', '系統沒有說明原因'],
      [undefined, 'the system gave no reason', '系統沒有說明原因'],
      // Not a code of the system: never printed.
      ['E\u001b[31mVIL', 'the system gave no reason', '系統沒有說明原因'],
      ['rm -rf /', 'the system gave no reason', '系統沒有說明原因'],
    ];
    for (const [errno, english, chinese] of words) {
      expect(lines(await said(refusal(errno), 'en'))[0], String(errno)).toBe(`smurg: A file of this workspace's state could not be opened or written (${english}): ${DIR}/state.json`);
      expect(lines(await said(refusal(errno), 'zh-TW'))[0], String(errno)).toBe(`smurg：這個工作區有一個狀態檔無法開啟或寫入（${chinese}）：${DIR}/state.json`);
    }
  });

  it('a file of root that this user may not open (after `sudo smurg host`): says whose it is; several: all of them', async () => {
    const paths = [`${DIR}/state.json`, `${DIR}/audit.jsonl`];
    const ctx = context({ [paths[0] as string]: file(0) });
    expect(await said(refusal('EACCES', paths), 'en', ctx)).toBe(
      `smurg: 2 files of this workspace's state could not be opened or written; the first (permission denied, EACCES): ${paths[0]}\n` +
        '  smurg host did not start, and nothing in the workspace was changed or reset: its members, invite links, keys and settings are as they were.\n' +
        '  The file belongs to another user (root). If you ever ran smurg with sudo, that is where it comes from: the owner or an administrator of this computer gives it back to you (chown).\n' +
        '  When the file can be opened and written again, run smurg host again.\n' +
        `  All of them: ${paths.join(', ')}\n`,
    );
    expect(await said(refusal('EACCES', paths), 'zh-TW', ctx)).toBe(
      `smurg：這個工作區有 2 個狀態檔無法開啟或寫入；第一個（沒有權限，EACCES）：${paths[0]}\n` +
        '  smurg host 沒有啟動，工作區裡的東西沒有被更動或重設：成員、邀請連結、金鑰和設定都和原來一樣。\n' +
        '  這個檔案屬於其他使用者（root）。如果你曾經用 sudo 執行 smurg，它就是那時候留下的：請檔案的擁有者或這台電腦的管理員把它交還給你（chown）。\n' +
        '  等這個檔案可以開啟和寫入之後，再執行一次 smurg host。\n' +
        `  全部是：${paths.join('、')}\n`,
    );
    // The stamp or a kept copy that could not be WRITTEN (phase 2): the same words, the same promise, no move.
    for (const path of [`${DIR}/${STAMP_FILE}`, `${DIR}/state.json.before-upgrade-from-0.4.0`]) {
      for (const lang of ['en', 'zh-TW'] as const) {
        const text = await said(refusal('ENOSPC', [path]), lang);
        expect(text).toContain(path);
        expect(text).not.toMatch(/\bmv\b|new workspace|新的工作區/);
      }
    }
  });
});

describe('newer: the writer is named only when the stamp names a newer smurg', () => {
  it('a stamp whose shapes are higher and whose name is not: "a newer smurg", and the stamp is quoted as it is', async () => {
    const refusal = new StateFileError({ kind: 'newer', path: DIR, message: 'this workspace folder was last written by a newer smurg', writtenBy: '0.5.0' });
    const ctx = context({}, { update: { executable: null, version: '0.5.1' } });
    expect(await said(refusal, 'en', ctx)).toBe(
      `smurg: This workspace was last shared with a newer smurg than this one (this is 0.5.1), and this smurg cannot read what it wrote: ${DIR}\n` +
        '  Nothing was changed.\n' +
        '  Run smurg update, then smurg host again. If smurg update says that this is the latest version, the folder was last written by a smurg this computer cannot get that way: share it with the smurg that wrote it.\n' +
        `  The stamp that names its writer: ${DIR}/written-by.json (it says smurg 0.5.0).\n`,
    );
    for (const lang of ['en', 'zh-TW'] as const) expect(await said(refusal, lang, ctx)).not.toMatch(/\bmv\b|new workspace|新的工作區/);
  });
});

describe('unreadable: the writer, the kind of file, the copy', () => {
  it('a folder a NEWER smurg of the same shapes stamped: update first, by name; one this smurg stamped: no such line', async () => {
    const path = `${DIR}/topics.json`;
    const refusal = (writtenBy: string): StateFileError => new StateFileError({ kind: 'unreadable', reason: 'no-known-shape', path, message: 'state file does not match its schema', problems: ['topics.0.phase: Invalid option'], writtenBy });
    const ctx = context({}, { update: { executable: null, version: '0.5.1' } });
    const newer = lines(await said(refusal('0.5.3'), 'en', ctx));
    expect(newer[0]).toBe(`smurg: A file of this workspace's state is not in a form that smurg 0.5.1 or an earlier published smurg wrote: ${path}`);
    expect(newer.slice(1, 4)).toEqual([
      '  What does not fit: topics.0.phase: Invalid option',
      '  Nothing was changed.',
      '  First: this folder was last written by smurg 0.5.3, which is newer than this one. Run smurg update, then smurg host again.',
    ]);
    expect(lines(await said(refusal('0.5.3'), 'zh-TW', ctx))[3]).toBe('  第一步：這個資料夾上次是 smurg 0.5.3 寫的，它比這個 smurg 新。請執行 smurg update，再執行一次 smurg host。');
    const same = lines(await said(refusal('0.5.1'), 'en', ctx));
    expect(same.slice(1, 3)).toEqual(['  What does not fit: topics.0.phase: Invalid option', '  Nothing was changed.']);
    expect(same[3]).toMatch(/^ {2}The last resort is a new workspace\. It costs: /);
    // The example's target carries the date and the time, and it is the last line.
    expect(same.at(-1)).toBe(`  mv ${DIR} ${DIR}.old-20261008-140507`);
  });

  it('the daemon\'s key that is not a key (it is never replaced), and the copy of a file that holds no members', async () => {
    const key = new StateFileError({ kind: 'unreadable', reason: 'no-known-shape', path: `${DIR}/identity.key`, message: 'key file must be exactly 32 bytes', problems: ['(file): not exactly 32 bytes'] });
    expect(lines(await said(key, 'en')).slice(0, 4)).toEqual([
      `smurg: A file of this workspace's state is not in a form that smurg ${CLI_VERSION} or an earlier published smurg wrote: ${DIR}/identity.key`,
      '  What does not fit: (file): not exactly 32 bytes',
      '  Nothing was changed.',
      '  First: if a newer smurg was ever used on this computer, run smurg update, then smurg host again.',
    ]);
    const at = new Date(2026, 9, 1, 9, 30).getTime();
    const suggestions = new StateFileError({
      kind: 'unreadable',
      reason: 'not-json',
      path: `${DIR}/suggestions.json`,
      message: 'state file is not valid JSON',
      writtenBy: '0.5.0',
      copies: [
        { path: `${DIR}/suggestions.json.before-upgrade-from-0.4.0`, from: '0.4.0', at },
        { path: `${DIR}/suggestions.json.before-upgrade-from-0.3.0`, from: '0.3.0', at: at - 1000 },
      ],
    });
    // What putting it back undoes FIRST, then the newest copy's name and date. No members in this file: no word of kicks.
    expect(lines(await said(suggestions, 'en'))[2]).toBe(
      '  smurg kept a copy of this file as it was before an upgrade, for reading what it held. Putting it back replaces everything recorded in this file since then. The newest copy: suggestions.json.before-upgrade-from-0.4.0, kept 2026/10/01 09:30.',
    );
    expect(lines(await said(suggestions, 'zh-TW'))[2]).toBe(
      '  smurg 在升級前保留了這個檔案當時的副本，用來查看它當時的內容。把它放回去，這個檔案在那之後記下的東西都會被它取代。最新的副本：suggestions.json.before-upgrade-from-0.4.0，保留於 2026/10/01 09:30。',
    );
  });

  it('the last resort\'s target is a name that is not there: the next free one when the date and time are taken', async () => {
    const refusal = new StateFileError({ kind: 'unreadable', reason: 'not-json', path: `${DIR}/state.json`, message: 'state file is not valid JSON', writtenBy: '0.5.0' });
    const taken = { uid: ME, mode: 0o700, kind: 'directory' as const };
    const ctx = context({ [`${DIR}.old-20261008-140507`]: taken, [`${DIR}.old-20261008-140507-2`]: taken });
    expect(lines(await said(refusal, 'en', ctx)).at(-1)).toBe(`  mv ${DIR} ${DIR}.old-20261008-140507-3`);
    // A folder whose path needs quoting: each of the two is one word.
    const spaced = '/home/ian/smurg home/workspaces/ws_a';
    expect(lines(await said(refusal, 'zh-TW', context({}, { workspaceDir: spaced }))).at(-1)).toBe(`  mv '${spaced}' '${spaced}.old-20261008-140507'`);
  });
});

describe('a refused file the host can set aside without losing the workspace: that way is named, and the last resort is not (sceptic V5-1)', () => {
  /** What each such file holds and what setting it aside loses, word for word: [document, English, Traditional Chinese]. */
  const HOLDS: readonly (readonly [string, string, string])[] = [
    [
      'inbox',
      'It holds what each member has read or dismissed in their inbox and the mentions kept for them. Setting it aside loses only that: everything in every inbox is unread again.',
      '它記著每位成員在收件夾裡看過、移除了什麼，還有為他們保留的提及。把它移到旁邊只會失去這些：每個人收件夾裡的項目都會變回還沒看過。',
    ],
    [
      'suggestions',
      'It holds the suggestions members made to agent sessions. Setting it aside loses only those: one that still waited has to be made again.',
      '它記著成員給 agent session 的建議。把它移到旁邊只會失去這些建議：還在等的建議要重新提一次。',
    ],
    [
      'conflicts',
      "It holds the list of kept conflicts between a person's and an agent's edit of the same file. Setting it aside loses only that list: your files are not touched.",
      '它記著保留下來的衝突清單（成員和 agent 改到同一個檔案的地方）。把它移到旁邊只會失去這份清單：你的檔案不會被動到。',
    ],
    [
      'worktrees',
      "It holds smurg's record of the worktrees it made and of every merge request. Setting it aside loses only that: the worktrees' folders stay on disk (in the shared folder's .smurg/worktrees), unknown to smurg, and merge requests that waited are gone.",
      '它記著 smurg 建立的 worktree 和所有合併請求。把它移到旁邊只會失去這些紀錄：worktree 的資料夾還在磁碟上（分享資料夾的 .smurg/worktrees 裡），只是 smurg 不再認得；還在等的合併請求會消失。',
    ],
    [
      'sessions',
      'It holds which terminal sessions were running. Setting it aside loses only that: processes they left running after a crash are not ended for you.',
      '它記著有哪些終端機 session 正在執行。把它移到旁邊只會失去這份紀錄：當機之後它們留下的程序，smurg 不會替你結束。',
    ],
    [
      'host-rules',
      'It holds what smurg last saw of your own Claude Code allow rules. Setting it aside loses only that: smurg tells you about them again.',
      '它記著 smurg 上次看到的、你自己的 Claude Code 規則。把它移到旁邊只會失去這份紀錄：smurg 會再告訴你一次有哪些規則。',
    ],
    [
      'claude-trust',
      "It holds your decisions about projects' Claude Code settings. Setting it aside loses only those: agent sessions start without a project's settings until you confirm them again.",
      '它記著你對各個專案的 Claude Code 專案設定做過的決定。把它移到旁邊只會失去這些決定：在你重新確認之前，agent session 不會載入專案設定。',
    ],
    [
      'cards',
      'It holds the list of conversations that have questions and permission requests. Setting it aside loses only that: the ones asked so far are no longer shown.',
      '它記著哪些對話裡有選擇題和權限請求。把它移到旁邊只會失去這份紀錄：之前問過的不會再顯示。',
    ],
  ];
  const KEEPS = {
    en: 'This one file can be set aside without losing the workspace: its members, invite links, settings and daemon key stay. ',
    'zh-TW': '這一個檔案可以單獨移到旁邊，工作區不會因此不見：成員、邀請連結、設定和 daemon 金鑰都會留著。',
  } as const;
  const HOW = {
    en: 'To do that, move the file aside and run smurg host again (smurg makes a new, empty one in its place):',
    'zh-TW': '要這麼做，請把這個檔案移到旁邊，再執行一次 smurg host（smurg 會在原位建立一個新的空檔案）：',
  } as const;
  const cut = (document: string, more: Partial<ConstructorParameters<typeof StateFileError>[0]> = {}): StateFileError =>
    new StateFileError({ kind: 'unreadable', reason: 'not-json', path: `${DIR}/${document}.json`, message: 'state file is not valid JSON', document, canSetAside: true, writtenBy: CLI_VERSION, ...more });

  it('the read marks cut off (the sceptic\'s case), word for word: what the file holds, that only that is lost, the mv to a dated name; no last resort', async () => {
    expect(await said(cut('inbox'), 'en')).toBe(
      `smurg: A file of this workspace's state is damaged: it is not valid JSON (it may be empty or cut off): ${DIR}/inbox.json\n` +
        '  Nothing was changed.\n' +
        `  ${KEEPS.en}${HOLDS[0]?.[1]}\n` +
        `  ${HOW.en}\n` +
        `  mv ${DIR}/inbox.json ${DIR}/inbox.json.set-aside-20261008-140507\n`,
    );
    expect(await said(cut('inbox'), 'zh-TW')).toBe(
      `smurg：這個工作區有一個狀態檔已損毀：它不是有效的 JSON（可能是空的，或只寫了一半）：${DIR}/inbox.json\n` +
        '  沒有更動任何東西。\n' +
        `  ${KEEPS['zh-TW']}${HOLDS[0]?.[2]}\n` +
        `  ${HOW['zh-TW']}\n` +
        `  mv ${DIR}/inbox.json ${DIR}/inbox.json.set-aside-20261008-140507\n`,
    );
  });

  it('each of the eight documents has its own sentence, in both languages; the command is the last line, and the workspace\'s folder is never moved', async () => {
    for (const [document, english, chinese] of HOLDS) {
      for (const [lang, sentence] of [['en', english], ['zh-TW', chinese]] as const) {
        const text = lines(await said(cut(document), lang));
        expect(text.filter((line) => line === `  ${KEEPS[lang]}${sentence}`), `${document} [${lang}]`).toHaveLength(1);
        expect(text.at(-2)).toBe(`  ${HOW[lang]}`);
        expect(text.at(-1)).toBe(`  mv ${DIR}/${document}.json ${DIR}/${document}.json.set-aside-20261008-140507`);
        expect(text.join('\n'), `${document} [${lang}]`).not.toMatch(/last resort|new workspace|最後的辦法|新的工作區|\.old-/);
      }
    }
    // One sentence per document: no two are the same.
    expect(new Set(HOLDS.map(([, english]) => english)).size).toBe(HOLDS.length);
    expect(new Set(HOLDS.map(([, , chinese]) => chinese)).size).toBe(HOLDS.length);
  });

  it('with the other lines a refusal has: the problems first, "update first" for an unknown writer, a kept copy before it; and a name that is not taken', async () => {
    const at = new Date(2026, 9, 1, 9, 30).getTime();
    const refusal = cut('suggestions', {
      reason: 'no-known-shape',
      message: 'state file does not match its schema',
      problems: ['suggestions.0.origin: Invalid option'],
      writtenBy: undefined,
      copies: [{ path: `${DIR}/suggestions.json.before-upgrade-from-0.4.0`, from: '0.4.0', at }],
    });
    const taken = { uid: ME, mode: 0o600, kind: 'file' as const };
    const ctx = context({ [`${DIR}/suggestions.json.set-aside-20261008-140507`]: taken, [`${DIR}/suggestions.json.set-aside-20261008-140507-2`]: taken });
    expect(lines(await said(refusal, 'en', ctx))).toEqual([
      `smurg: A file of this workspace's state is not in a form that smurg ${CLI_VERSION} or an earlier published smurg wrote: ${DIR}/suggestions.json`,
      '  What does not fit: suggestions.0.origin: Invalid option',
      '  Nothing was changed.',
      '  First: if a newer smurg was ever used on this computer, run smurg update, then smurg host again.',
      '  smurg kept a copy of this file as it was before an upgrade, for reading what it held. Putting it back replaces everything recorded in this file since then. The newest copy: suggestions.json.before-upgrade-from-0.4.0, kept 2026/10/01 09:30.',
      `  ${KEEPS.en}${HOLDS[1]?.[1]}`,
      `  ${HOW.en}`,
      `  mv ${DIR}/suggestions.json ${DIR}/suggestions.json.set-aside-20261008-140507-3`,
    ]);
    // A path that needs quoting: each of the two is one word of the command.
    const spaced = '/home/ian/smurg home/workspaces/ws_a';
    const there = cut('inbox', { path: `${spaced}/inbox.json` });
    expect(lines(await said(there, 'zh-TW', context({}, { workspaceDir: spaced }))).at(-1)).toBe(`  mv '${spaced}/inbox.json' '${spaced}/inbox.json.set-aside-20261008-140507'`);
  });

  it('a file that cannot be set aside keeps the last resort and is never told to be moved alone: state.json, the key, a document the daemon does not vouch for', async () => {
    const refusals = [
      new StateFileError({ kind: 'unreadable', reason: 'not-json', path: `${DIR}/state.json`, message: 'state file is not valid JSON', document: 'state', writtenBy: CLI_VERSION }),
      new StateFileError({ kind: 'unreadable', reason: 'not-json', path: `${DIR}/topics.json`, message: 'state file is not valid JSON', document: 'topics', writtenBy: CLI_VERSION }),
      new StateFileError({ kind: 'unreadable', reason: 'no-known-shape', path: `${DIR}/identity.key`, message: 'key file must be exactly 32 bytes' }),
      // The daemon decides: a claim for state.json, or for a file that is no document, is not one (the error itself refuses it).
      new StateFileError({ kind: 'unreadable', reason: 'not-json', path: `${DIR}/audit.jsonl`, message: 'not valid JSON', canSetAside: true }),
    ];
    for (const refusal of refusals) {
      expect(refusal.canSetAside).toBe(false);
      for (const lang of ['en', 'zh-TW'] as const) {
        const text = await said(refusal, lang);
        expect(text).toMatch(lang === 'en' ? /The last resort is a new workspace\./ : /最後的辦法是建立新的工作區。/);
        expect(text).not.toContain('.set-aside-');
        expect(lines(text).at(-1)).toBe(`  mv ${DIR} ${DIR}.old-20261008-140507`);
      }
    }
    // Any other kind of refusal of such a document is cured where it is (a chmod, the file itself back, smurg update): never a mv.
    const open = new StateFileError({ kind: 'insecure', cause: 'mode', mode: 0o644, path: `${DIR}/inbox.json`, message: 'state file mode 644', document: 'inbox', canSetAside: true });
    expect(open.canSetAside).toBe(false);
    expect(await said(open, 'en')).not.toMatch(/\bmv\b/);
  });

  it('a document the daemon vouches for that this command has no sentence for: said in general words, still without the last resort', async () => {
    const text = lines(await said(cut('bookmarks'), 'en'));
    expect(text.slice(-3)).toEqual([
      `  ${KEEPS.en}It holds a part of the workspace's state that is neither its members nor its invite links nor its keys. Setting it aside loses only what this file holds.`,
      `  ${HOW.en}`,
      `  mv ${DIR}/bookmarks.json ${DIR}/bookmarks.json.set-aside-20261008-140507`,
    ]);
    expect(lines(await said(cut('bookmarks'), 'zh-TW')).at(-3)).toBe(`  ${KEEPS['zh-TW']}它是工作區狀態的一部分，但不是成員、邀請連結，也不是金鑰。把它移到旁邊只會失去這個檔案裡記的東西。`);
  });

  it('the sentences are the daemon\'s own list: every document it declares as one that can be set aside has a sentence here, and no other has', () => {
    const declared = DEFAULT_FEATURE_MODULES.flatMap((module) => module.documents ?? [])
      .filter((document) => document.canSetAside === true)
      .map((document) => document.name)
      .sort();
    expect(declared).toEqual(HOLDS.map(([document]) => document).sort());
    expect(declared).toEqual([...SET_ASIDE_DOCUMENTS].sort());
  });
});

describe('a refusal that came while the start was WRITING (phase 2) never says the bare "Nothing was changed." (sceptics V1-1, V2-2)', () => {
  const WRITTEN = {
    en: 'smurg host did not start, and nothing in the workspace was changed or reset: its members, invite links, keys and settings are as they were.',
    'zh-TW': 'smurg host 沒有啟動，工作區裡的東西沒有被更動或重設：成員、邀請連結、金鑰和設定都和原來一樣。',
  } as const;
  const BARE = { en: 'Nothing was changed', 'zh-TW': '沒有更動任何東西' } as const;
  const kept = `${DIR}/state.json.before-upgrade-from-0.4.0`;

  it('the owner\'s case: something in the way of a kept copy\'s name, found after the stamp was written', async () => {
    // The stamp is on disk by then (and, for a later document's copy, an upgraded state.json with its own copy).
    const refusal = new StateFileError({ kind: 'insecure', cause: 'symlink', path: kept, message: 'kept copy is a symlink', phase: 2 });
    expect(await said(refusal, 'en')).toBe(
      `smurg: A file of this workspace's state is a symbolic link, and smurg follows no link in its state folder: ${kept}\n` +
        `  ${WRITTEN.en}\n` +
        '  smurg host starts when the file itself is in that place: a regular file that belongs to you, mode 600.\n',
    );
    expect(await said(refusal, 'zh-TW')).toBe(
      `smurg：這個工作區有一個狀態檔是符號連結（symlink），smurg 不會跟著狀態資料夾裡的連結走：${kept}\n` +
        `  ${WRITTEN['zh-TW']}\n` +
        '  把檔案本身放在那個位置（屬於你自己的一般檔案，權限 600），smurg host 就能啟動。\n',
    );
    // The same refusal of a start that only read (phase 1, and an error that names no phase): as it always was.
    for (const phase of [1, undefined] as const) {
      const reading = new StateFileError({ kind: 'insecure', cause: 'symlink', path: kept, message: 'state file is a symlink', ...(phase === undefined ? {} : { phase }) });
      expect(lines(await said(reading, 'en'))[1]).toBe('  Nothing was changed.');
      expect(lines(await said(reading, 'zh-TW'))[1]).toBe('  沒有更動任何東西。');
    }
  });

  it('every kind and cause of phase 2: the sentence of a failed write, in both languages', async () => {
    const state = `${DIR}/state.json`;
    const refusals: readonly StateFileError[] = [
      new StateFileError({ kind: 'insecure', cause: 'symlink', path: kept, message: 'kept copy is a symlink', phase: 2 }),
      new StateFileError({ kind: 'insecure', cause: 'not-a-file', path: kept, message: 'kept copy is not a regular file', phase: 2 }),
      new StateFileError({ kind: 'insecure', cause: 'owner', path: kept, message: 'kept copy is owned by another user', phase: 2 }),
      new StateFileError({ kind: 'insecure', cause: 'mode', mode: 0o644, path: kept, message: 'kept copy mode 644 grants group/other access', phase: 2 }),
      new StateFileError({ kind: 'cannot-open', errno: 'ENOSPC', path: kept, message: 'cannot create the kept copy', phase: 2 }),
      new StateFileError({ kind: 'cannot-open', errno: 'EEXIST', path: `${kept}-99`, message: 'every name of the kept copies is taken', phase: 2 }),
      new StateFileError({ kind: 'other-workspace', path: state, message: 'state file names another workspace', phase: 2 }),
      new StateFileError({ kind: 'newer', path: state, message: 'state file was written by a newer smurg', phase: 2 }),
      new StateFileError({ kind: 'unreadable', reason: 'not-json', path: state, message: 'state file is not valid JSON', writtenBy: '0.5.1', phase: 2 }),
      new StateFileError({ kind: 'unreadable', reason: 'no-known-shape', path: state, message: 'state file does not match its schema', problems: ['members: Invalid input'], writtenBy: '0.5.1', phase: 2 }),
      new StateFileError({ kind: 'unreadable', reason: 'carried-value-refused', path: state, message: 'a carried value is refused', problems: ['settings.sharedDirs.0: invalid relative path: mark-run'], phase: 2 }),
      new StateFileError({ kind: 'unreadable', reason: 'missing', path: `${DIR}/identity.key`, message: 'the key went away', writtenBy: '0.5.1', phase: 2 }),
    ];
    const ctx = context({}, { update: { executable: null, version: '0.5.1' } });
    for (const refusal of refusals) {
      for (const lang of ['en', 'zh-TW'] as const) {
        const text = lines(await said(refusal, lang, ctx));
        const what = `${refusal.kind} ${refusal.cause ?? refusal.reason ?? refusal.errno ?? ''} [${lang}]`;
        expect(text.filter((line) => line === `  ${WRITTEN[lang]}`), what).toHaveLength(1);
        expect(text.filter((line) => line.includes(BARE[lang])), what).toEqual([]);
      }
    }
    // Phase 1 of each (the same error without the phase): the sentence it had, and for a file that could not be
    // opened the one it shares with phase 2.
    for (const refusal of refusals) {
      const reading = refusal.with({ phase: 1 });
      const text = lines(await said(reading, 'en', ctx));
      expect(text.some((line) => line.includes(BARE.en)), `${refusal.kind} in phase 1`).toBe(refusal.kind !== 'cannot-open');
    }
  });
});

describe('every name and path from the disk is shown escaped, as the daemon escapes the problems of a file (sceptic V1-4)', () => {
  /** Clear the screen, set the window's title, ring the bell. */
  const ESC = '\u001b[2J\u001b]0;pwned\u0007';
  /** Turn the rest of the line round. */
  const BIDI = '‮';
  /** No line holds a character that acts on a terminal instead of being read. */
  const safe = (text: string): void => {
    for (const line of text.split('\n')) expect(LOG_UNSAFE_CHARACTER.test(line), JSON.stringify(line)).toBe(false);
  };

  it('shown(): the characters the daemon\'s log treats as unsafe become \\u{…}; everything else stays, and so does a text that was escaped before', () => {
    expect(shown(`a${ESC}b${BIDI}c`)).toBe('a\\u{1b}[2J\\u{1b}]0;pwned\\u{7}b\\u{202e}c');
    expect(shown('a\nb\tc\u0085d­e﻿f\u007fg')).toBe('a\\u{a}b\\u{9}c\\u{85}d\\u{ad}e\\u{feff}f\\u{7f}g');
    expect(shown("/home/ian/My Files/it's/工作區/狀態.json")).toBe("/home/ian/My Files/it's/工作區/狀態.json");
    expect(shown(shown(`a${ESC}${BIDI}`))).toBe(shown(`a${ESC}${BIDI}`));
  });

  it('a folder set aside beside the workspace\'s own: its name, in both languages', () => {
    const notice = oldFolderNotice([`${DIR}.old${ESC}${BIDI}`, `${DIR}.old2`]) as Text;
    for (const lang of ['en', 'zh-TW'] as const) {
      const text = renderText(lang, notice);
      safe(text);
      expect(text).toContain(`${DIR}.old\\u{1b}[2J\\u{1b}]0;pwned\\u{7}\\u{202e}`);
    }
  });

  it('a refusal: its path, every path of "All of them", the stamp and the version it names, a kept copy\'s name, the problems', async () => {
    const dir = `/home/ian/.smurg${ESC}/workspaces/${WS}${BIDI}`;
    const escaped = `/home/ian/.smurg\\u{1b}[2J\\u{1b}]0;pwned\\u{7}/workspaces/${WS}\\u{202e}`;
    const at = new Date(2026, 9, 1, 9, 30).getTime();
    const refusals: readonly StateFileError[] = [
      new StateFileError({ kind: 'insecure', cause: 'owner', path: `${dir}/state.json`, paths: [`${dir}/state.json`, `${dir}/topics.json`], message: 'state file is owned by another user' }),
      new StateFileError({ kind: 'insecure', cause: 'symlink', path: `${dir}/state.json`, paths: [`${dir}/state.json`, `${dir}/topics.json`], message: 'state file is a symlink' }),
      new StateFileError({ kind: 'insecure', cause: 'not-a-file', path: `${dir}/state.json`, paths: [`${dir}/state.json`, `${dir}/topics.json`], message: 'state file is not a regular file' }),
      new StateFileError({ kind: 'insecure', cause: 'mode', mode: 0o644, path: `${dir}/state.json`, paths: [`${dir}/state.json`, `${dir}/topics.json`], message: 'state file mode 644' }),
      new StateFileError({ kind: 'cannot-open', errno: 'EACCES', path: `${dir}/state.json`, paths: [`${dir}/state.json`, `${dir}/topics.json`], message: 'cannot open the state file' }),
      new StateFileError({ kind: 'other-workspace', path: `${dir}/state.json`, message: 'state file names another workspace' }),
      // A stamp may name anything where its version stands (a later smurg decides what it writes there).
      new StateFileError({ kind: 'newer', path: dir, message: 'this workspace folder was last written by a newer smurg', writtenBy: `9.9.9${ESC}${BIDI}` }),
      new StateFileError({
        kind: 'unreadable',
        reason: 'no-known-shape',
        path: `${dir}/state.json`,
        message: 'state file does not match its schema',
        // (the daemon escapes these itself; the command does not rely on it)
        problems: [`members.0.${ESC}: Unrecognized key`, `settings.${BIDI}x: Invalid input`],
        copies: [{ path: `${dir}/state.json.before-upgrade-from-0.4.0${BIDI}`, from: '0.4.0', at }],
      }),
      new StateFileError({ kind: 'unreadable', reason: 'not-json', path: `${dir}/inbox.json`, message: 'state file is not valid JSON' }),
      new StateFileError({ kind: 'unreadable', reason: 'missing', path: `${dir}/state.json`, message: 'state file is missing' }),
      new StateFileError({ kind: 'unreadable', reason: 'carried-value-refused', path: `${dir}/state.json`, message: 'a carried value is refused', problems: [`settings.sharedDirs.0${ESC}: invalid relative path: mark-run`] }),
    ];
    const ctx = context({ [`${dir}/state.json`]: file(0) }, { workspaceDir: dir, update: { executable: null, version: '0.5.1' } });
    for (const refusal of refusals) {
      for (const lang of ['en', 'zh-TW'] as const) {
        const text = await said(refusal, lang, ctx);
        safe(text);
        // The path is there, as it can be read.
        expect(lines(text)[0], `${refusal.kind} ${refusal.cause ?? refusal.reason ?? ''}`).toContain(`${escaped}${refusal.kind === 'newer' ? '' : `/${refusal.path.slice(dir.length + 1)}`}`);
      }
    }
    const newer = await said(refusals[6] as StateFileError, 'en', ctx);
    expect(lines(newer).at(-1)).toBe(`  The stamp that names its writer: ${escaped}/written-by.json (it says smurg 9.9.9\\u{1b}[2J\\u{1b}]0;pwned\\u{7}\\u{202e}).`);
    const shape = lines(await said(refusals[7] as StateFileError, 'en', ctx));
    expect(shape[1]).toBe('  What does not fit: members.0.\\u{1b}[2J\\u{1b}]0;pwned\\u{7}: Unrecognized key; settings.\\u{202e}x: Invalid input');
    expect(shape.find((line) => line.includes('The newest copy:'))).toContain('The newest copy: state.json.before-upgrade-from-0.4.0\\u{202e}, kept 2026/10/01 09:30.');
    expect(lines(await said(refusals[0] as StateFileError, 'en', ctx)).at(-1)).toBe(`  All of them: ${escaped}/state.json, ${escaped}/topics.json`);
  });

  it('a path as a word of a command the text names (chmod, mv): no such character, and the shell reads each word back as the path', async () => {
    const dir = `/home/ian/it's${ESC}/workspaces/${WS}${BIDI}`;
    const paths = [`${dir}/state.json`, `${dir}/audit.jsonl`];
    const mode = new StateFileError({ kind: 'insecure', cause: 'mode', mode: 0o644, path: paths[0] as string, paths, message: 'state file mode 644' });
    const chmod = lines(await said(mode, 'en', context({}, { workspaceDir: dir }))).at(-1) as string;
    safe(chmod);
    expect(chmod.startsWith('  chmod 600 ')).toBe(true);
    // `printf '%s\n' <the words>`: what a shell makes of the two words is the two paths.
    const words = chmod.slice('  chmod 600 '.length);
    expect(execFileSync('/bin/bash', ['-c', `printf '%s\\0' ${words}`], { encoding: 'utf8' }).split('\0').slice(0, -1)).toEqual(paths);
    const cut = new StateFileError({ kind: 'unreadable', reason: 'not-json', path: paths[0] as string, message: 'state file is not valid JSON', writtenBy: '0.5.0' });
    const mv = lines(await said(cut, 'zh-TW', context({}, { workspaceDir: dir }))).at(-1) as string;
    safe(mv);
    expect(execFileSync('/bin/bash', ['-c', `printf '%s\\0' ${mv.trim().slice('mv '.length)}`], { encoding: 'utf8' }).split('\0').slice(0, -1)).toEqual([dir, `${dir}.old-20261008-140507`]);
  });
});

describe('the one line of a start that upgraded, or found an older file put back', () => {
  const copy = (name: string, from: string): { document: string; from: string; copy: string } => ({ document: name, from, copy: `${DIR}/${name}.json.before-upgrade-from-${from}` });
  const show = (text: Text | null, lang: Lang): string | null => (text === null ? null : renderText(lang, text));

  it('nothing upgraded: nothing; one step: the smurg it names; several steps: an earlier smurg; always ONE line', () => {
    expect(upgradeNotice({ upgraded: [], putBack: false })).toBeNull();
    expect(upgradeNotice({ upgraded: [], putBack: true })).toBeNull();
    const one = upgradeNotice({ upgraded: [copy('suggestions', '0.4.0')], putBack: false });
    expect(show(one, 'en')).toBe(`This workspace was last shared with smurg 0.4.0: its members, invite links and settings were carried over. What changed: ${GUIDE_KEPT.en}`);
    const mixed = upgradeNotice({ upgraded: [copy('state', '0.4.0'), copy('topics', '0.5.0')], putBack: false });
    expect(show(mixed, 'en')).toBe(`This workspace was last shared with an earlier smurg: its members, invite links and settings were carried over. What changed: ${GUIDE_KEPT.en}`);
    expect(show(mixed, 'zh-TW')).toBe(`這個工作區上次是用較早版本的 smurg 分享的：成員、邀請連結和設定都已沿用。有哪些改變：${GUIDE_KEPT['zh-TW']}`);
    // A step's name that is no version is not printed.
    expect(show(upgradeNotice({ upgraded: [copy('state', 'legacy')], putBack: false }), 'en')).toContain('last shared with an earlier smurg:');
    for (const text of [one, mixed]) for (const lang of ['en', 'zh-TW'] as const) expect(show(text, lang)).not.toContain('\n');
  });

  it('put back: state.json undoes kicks and revocations; another file only what that file recorded', () => {
    const other = upgradeNotice({ upgraded: [copy('suggestions', '0.4.0')], putBack: true });
    expect(show(other, 'en')).toBe(
      `Warning: an OLDER suggestions.json was put back into this workspace and upgraded again: what it holds replaces everything recorded there since. Guide: ${GUIDE_KEPT.en}`,
    );
    expect(show(other, 'zh-TW')).toBe(`⚠ 較舊的 suggestions.json 被放回這個工作區，並且重新升級了：這個檔案在那之後記下的東西，都被它的內容取代。說明：${GUIDE_KEPT['zh-TW']}`);
    // state.json among them: what is undone, AND who is locked out (whoever joined since, the links made since: sceptic V3-3).
    const both = upgradeNotice({ upgraded: [copy('state', '0.4.0'), copy('suggestions', '0.4.0')], putBack: true });
    expect(show(both, 'en')).toBe(
      'Warning: an OLDER state.json, suggestions.json was put back into this workspace and upgraded again. Everything decided since it was written is undone: ' +
        'people removed since are members again, revoked devices and revoked or used-up invite links work again, and role changes are gone; ' +
        `whoever joined since is no longer a member, and invite links made since no longer work. Guide: ${GUIDE_KEPT.en}`,
    );
    expect(show(both, 'zh-TW')).toBe(
      '⚠ 較舊的 state.json、suggestions.json 被放回這個工作區，並且重新升級了。它寫入之後決定的每一件事都被取消：之後被移出的人又是成員，已撤銷的裝置、已撤銷或已用完的邀請連結又可以使用，角色的變更也消失了；' +
        `之後才加入的人不再是成員，之後建立的邀請連結也不能用了。說明：${GUIDE_KEPT['zh-TW']}`,
    );
    for (const text of [other, both]) for (const lang of ['en', 'zh-TW'] as const) expect(show(text, lang)).not.toContain('\n');
  });
});

describe('the folders set aside beside a workspace\'s own, and whether a stamping smurg opened it before', () => {
  it('only FOLDERS named <workspace id>.old*, by name; a stamp that is there (whatever it holds) means "opened before"', async () => {
    const base = await createTempDir('aside');
    cleanups.push(() => removeTempDir(base));
    const dir = join(base, 'workspaces', WS);
    await mkdir(dir, { recursive: true });
    expect(await foldersSetAside(dir)).toEqual([]);
    expect(oldFolderNotice([])).toBeNull();
    for (const name of [`${WS}.old2`, `${WS}.old`, `${WS}.old-20261008-140507`, `${WS}x.old`, 'ws_other.old', `${WS}.new`]) await mkdir(join(base, 'workspaces', name));
    await writeFile(join(base, 'workspaces', `${WS}.old.txt`), 'x');
    await symlink(dir, join(base, 'workspaces', `${WS}.old-link`));
    const found = await foldersSetAside(dir);
    expect(found).toEqual([`${WS}.old`, `${WS}.old-20261008-140507`, `${WS}.old2`].map((name) => join(base, 'workspaces', name)));
    // What the folder holds is said (sceptic V3-6), and the address is the part of the guide about going back (V3-5).
    expect(renderText('en', oldFolderNotice(found) as Text)).toBe(
      `An earlier state folder of this workspace lies beside the one in use: ${found[0]} (and 2 more). smurg does not use it. If you moved it away because smurg 0.5.0 told you to after an update, it still holds the members, invite links and daemon key you had before, and the guide says how to go back to it: ${GUIDE_BACK.en}`,
    );
    expect(renderText('zh-TW', oldFolderNotice(found.slice(0, 1)) as Text)).toBe(
      `這個工作區之前的狀態資料夾還放在旁邊：${found[0]}。smurg 不會使用它。如果你是在更新後照 smurg 0.5.0 的指示把它移開的，你原本的成員、邀請連結和 daemon 金鑰都還在裡面，說明文件有換回去的方法：${GUIDE_BACK['zh-TW']}`,
    );
    // A workspace whose folders cannot be listed: nothing to say.
    expect(await foldersSetAside(join(base, 'nowhere', WS))).toEqual([]);

    expect(await wasStamped(dir)).toBe(false);
    expect(await wasStamped(join(base, 'nowhere', WS))).toBe(false);
    await writeFile(join(dir, STAMP_FILE), 'not even JSON');
    expect(await wasStamped(dir)).toBe(true);
  });
});

describe('a peer of another protocol version: once per run and direction, only a known one, after the links', () => {
  it('holds what it hears until it is released, then tells at once; an unknown peer is never told', () => {
    type Refused = { direction: 'peer-newer' | 'peer-older'; peerProtocol: number; known: boolean };
    const listeners = new Set<(event: Refused) => void>();
    const daemon = {
      ctx: {
        bus: {
          on: (_event: string, listener: (event: Refused) => void) => {
            listeners.add(listener);
            return { dispose: () => void listeners.delete(listener) };
          },
        },
      },
    } as unknown as Parameters<typeof watchRefusedPeers>[0];
    const emit = (direction: Refused['direction'], known: boolean): void => {
      for (const listener of [...listeners]) listener({ direction, peerProtocol: direction === 'peer-newer' ? 5 : 3, known });
    };
    const told: string[] = [];
    const watch = watchRefusedPeers(daemon, (direction, text) => told.push(`${direction}: ${renderText('en', text)}`));

    // While the daemon starts (teammates' open tabs reconnect at once): heard, not yet said.
    emit('peer-newer', false);
    emit('peer-newer', true);
    emit('peer-newer', true);
    expect(told).toEqual([]);
    watch.release();
    expect(told).toEqual(["peer-newer: \nWarning: a teammate's page or smurg is newer than this smurg and was turned away. Stop sharing, run smurg update, then share again."]);
    // Later: at once, each direction once.
    emit('peer-older', false);
    expect(told).toHaveLength(1);
    emit('peer-older', true);
    emit('peer-older', true);
    emit('peer-newer', true);
    // Whose page or smurg it was: a teammate's (sceptic V3-7; the line is said only for a peer the daemon knows).
    expect(told).toEqual([told[0], "peer-older: \nA teammate's page or smurg is older than this smurg and was turned away. That teammate reloads the page or updates smurg; if you run your own relay, deploy it again."]);
    watch.dispose();
    expect(listeners.size).toBe(0);
  });
});

describe('a repository that tracks smurg\'s own .smurg folder (0.5.2): once per run, after the links', () => {
  it('holds what it hears until it is released, then tells at once; never twice', () => {
    const listeners = new Set<(event: { count: number }) => void>();
    const names: string[] = [];
    const daemon = {
      ctx: {
        bus: {
          on: (event: string, listener: (event: { count: number }) => void) => {
            names.push(event);
            listeners.add(listener);
            return { dispose: () => void listeners.delete(listener) };
          },
        },
      },
    } as unknown as Parameters<typeof watchSmurgTracked>[0];
    const emit = (): void => {
      for (const listener of [...listeners]) listener({ count: 1 });
    };
    const told: string[] = [];
    const watch = watchSmurgTracked(daemon, (text) => told.push(renderText('en', text)));
    expect(names).toEqual(['worktree.smurg-tracked']);
    // The daemon looks while it starts: heard, said after the links.
    emit();
    expect(told).toEqual([]);
    watch.release();
    expect(told).toEqual(["\nsmurg's own .smurg folder is committed in this repository: run `git rm -r --cached .smurg` in the shared folder and commit."]);
    emit();
    expect(told).toHaveLength(1);
    expect(renderText('zh-TW', m('host.smurgTracked'))).toBe('\nsmurg 自己的 .smurg 資料夾已經被提交到這個儲存庫：請在分享的資料夾裡執行 `git rm -r --cached .smurg` 並提交。');
    watch.dispose();
    expect(listeners.size).toBe(0);

    // Heard only after the links: said at once.
    const later: string[] = [];
    const second = watchSmurgTracked(daemon, (text) => later.push(renderText('en', text)));
    second.release();
    emit();
    expect(later).toHaveLength(1);
    second.dispose();
  });
});
