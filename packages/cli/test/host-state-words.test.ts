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
import { STAMP_FILE, StateFileError } from '@smurg/daemon';
import { createTempDir, removeTempDir } from '@smurg/daemon/testing';
import { formatFailure } from '../src/cli/errors.ts';
import { foldersSetAside, oldFolderNotice, shellWord, stateFileProblem, upgradeNotice, wasStamped, watchRefusedPeers, type FileLook, type RefusalContext } from '../src/commands/host-state.ts';
import { renderText, type Text } from '../src/i18n/index.ts';
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
    for (const path of ['/plain/path-1.2_3@x', '/with space/a', "/it's/a", '/a"b', '/a$HOME`id`', '/a;rm -rf b', '/a\nb', '/a\\b', '/工作區/狀態', '/a*?[b]', "/'''"]) {
      expect(execFileSync('/bin/sh', ['-c', `printf %s ${shellWord(path)}`], { encoding: 'utf8' }), path).toBe(path);
    }
    expect(shellWord('/plain/path-1.2_3@x')).toBe('/plain/path-1.2_3@x');
    expect(shellWord('/with space/a')).toBe("'/with space/a'");
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

describe('the one line of a start that upgraded, or found an older file put back', () => {
  const copy = (name: string, from: string): { document: string; from: string; copy: string } => ({ document: name, from, copy: `${DIR}/${name}.json.before-upgrade-from-${from}` });
  const show = (text: Text | null, lang: Lang): string | null => (text === null ? null : renderText(lang, text));

  it('nothing upgraded: nothing; one step: the smurg it names; several steps: an earlier smurg; always ONE line', () => {
    expect(upgradeNotice({ upgraded: [], putBack: false })).toBeNull();
    expect(upgradeNotice({ upgraded: [], putBack: true })).toBeNull();
    const one = upgradeNotice({ upgraded: [copy('suggestions', '0.4.0')], putBack: false });
    expect(show(one, 'en')).toBe('This workspace was last shared with smurg 0.4.0: its members, invite links and settings were carried over. What changed: https://smurg.ai/docs/hosting/#9-updating-and-removing');
    const mixed = upgradeNotice({ upgraded: [copy('state', '0.4.0'), copy('topics', '0.5.0')], putBack: false });
    expect(show(mixed, 'en')).toBe('This workspace was last shared with an earlier smurg: its members, invite links and settings were carried over. What changed: https://smurg.ai/docs/hosting/#9-updating-and-removing');
    expect(show(mixed, 'zh-TW')).toBe('這個工作區上次是用較早版本的 smurg 分享的：成員、邀請連結和設定都已沿用。有哪些改變：https://smurg.ai/zh-TW/docs/hosting/#9-更新與移除');
    // A step's name that is no version is not printed.
    expect(show(upgradeNotice({ upgraded: [copy('state', 'legacy')], putBack: false }), 'en')).toContain('last shared with an earlier smurg:');
    for (const text of [one, mixed]) for (const lang of ['en', 'zh-TW'] as const) expect(show(text, lang)).not.toContain('\n');
  });

  it('put back: state.json undoes kicks and revocations; another file only what that file recorded', () => {
    const other = upgradeNotice({ upgraded: [copy('suggestions', '0.4.0')], putBack: true });
    expect(show(other, 'en')).toBe(
      'Warning: an OLDER suggestions.json was put back into this workspace and upgraded again: what it holds replaces everything recorded there since. Guide: https://smurg.ai/docs/hosting/#9-updating-and-removing',
    );
    expect(show(other, 'zh-TW')).toBe('⚠ 較舊的 suggestions.json 被放回這個工作區，並且重新升級了：這個檔案在那之後記下的東西，都被它的內容取代。說明：https://smurg.ai/zh-TW/docs/hosting/#9-更新與移除');
    const both = upgradeNotice({ upgraded: [copy('state', '0.4.0'), copy('suggestions', '0.4.0')], putBack: true });
    expect(show(both, 'en')).toMatch(/^Warning: an OLDER state\.json, suggestions\.json was put back into this workspace and upgraded again\. Everything decided since it was written is undone: people removed since are members again/);
    expect(show(both, 'zh-TW')).toMatch(/^⚠ 較舊的 state\.json、suggestions\.json 被放回這個工作區/);
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
    expect(renderText('en', oldFolderNotice(found) as Text)).toBe(
      `An earlier state folder of this workspace lies beside the one in use: ${found[0]} (and 2 more). smurg does not use it. If you moved it away because smurg 0.5.0 told you to after an update, the guide says how to go back to it: https://smurg.ai/docs/hosting/#9-updating-and-removing`,
    );
    expect(renderText('zh-TW', oldFolderNotice(found.slice(0, 1)) as Text)).toBe(
      `這個工作區之前的狀態資料夾還放在旁邊：${found[0]}。smurg 不會使用它。如果你是在更新後照 smurg 0.5.0 的指示把它移開的，說明文件有換回去的方法：https://smurg.ai/zh-TW/docs/hosting/#9-更新與移除`,
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
    expect(told).toEqual([told[0], 'peer-older: \nA page or smurg older than this smurg was turned away. The teammate reloads the page or updates smurg; if you run your own relay, deploy it again.']);
    watch.dispose();
    expect(listeners.size).toBe(0);
  });
});
