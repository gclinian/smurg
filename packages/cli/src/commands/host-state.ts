// What `smurg host` says about the state of the workspace it opens (0.5.1; ARCHITECTURE §7.1).
//
// Until 0.5.0 every refusal of a workspace's state had ONE text, and it advised moving the workspace's folder away:
// for a file an older smurg wrote (the owner's own update from 0.4.0), for one a newer smurg wrote, for a file with
// the wrong mode and for one cut in half alike. Moving the folder throws away the members, the invite links and the
// daemon's key. Now the daemon reads what every published smurg wrote and says WHY it refuses the rest
// (StateFileError of @smurg/daemon: its kind, cause and reason, every refused path, the problems, the writer the
// folder's stamp names, the copies kept before an upgrade), and this module words it:
//
//   newer            last shared with a newer smurg: `smurg update`. When that has nothing newer (asked as `smurg
//                    update` asks): written by a smurg this computer cannot get; the file and the stamp are named.
//   insecure         by cause. mode: ONE `chmod 600` for every listed path, and that others could read them until
//                    now. owner: who owns it, no chmod. symlink, not-a-file: what is there, no command.
//   cannot-open      the file and the errno in words.
//   other-workspace  that, and nothing to run.
//   unreadable       what is wrong; with an unknown writer FIRST "if a newer smurg was ever used here, run smurg
//                    update"; the newest kept copy AFTER what putting it back undoes; as the LAST resort a new
//                    workspace, after what that costs, with a `mv` whose target carries the date and time.
//                    A file the host can set aside ALONE (StateFileError.canSetAside: the daemon vouches for it,
//                    document by document) gets THAT way instead of the last resort: what the file holds, that
//                    setting it aside loses only that, and the `mv` of the one file to a dated name beside it. The
//                    last resort is then not printed at all: nobody gives up the members, the invite links and the
//                    daemon's key for a file of read marks (0.5.1, sceptic V5-1).
//
// Each text names the file and the reason itself and says that nothing was changed. "Move the folder away" exists in
// the last resort of `unreadable` alone, and its target is a name that is not there when the text is made: the old
// example (`mv X X.old`) put the folder INSIDE X.old the second time.
//
// "Nothing was changed." is said of a start that only READ (StateFileError.phase 1). A refusal that came while the
// start was WRITING (phase 2: the stamp is there, a kept copy or an upgraded document may be) says what a failed write
// has always said instead: smurg host did not start, and nothing in the workspace was changed or reset.
//
// Every name and path in these texts comes from the disk or is built on one that does, and is SHOWN escaped (`shown`:
// the escaping the daemon gives the problems of a file); as a word of a command it is written so that a shell reads
// the path back and the terminal gets no control character (`shellWord`).
//
// Also here, each ONE line of `smurg host`: a start that upgraded what an earlier smurg wrote, or found an OLDER file
// put back (Daemon.upgraded / putBack); a folder named `<workspace id>.old*` beside the one that is opened (0.5.0's
// advice, followed); a peer of another protocol version that was turned away (once per run and direction, only for a
// peer the daemon knows: anyone who ever held an invite link can make the daemon answer `version`).
//
// And, before any of it, the words for the folder's own entry in workspaces.json that this smurg cannot read
// (state/workspaces.ts lookUpSharedFolder): `smurg host` stops there, because going on meant a NEW workspace for a
// folder that has one (its members, invite links and daemon key left behind without a word).
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { LOG_UNSAFE_CHARACTER, STAMP_FILE, type Daemon, type StateFileError } from '@smurg/daemon';
import { CliError } from '../cli/errors.ts';
import type { CliIo } from '../cli/io.ts';
import { SET_ASIDE_DOCUMENTS, type SetAsideDocument } from '../i18n/en.ts';
import { m, type MessageId, type Text } from '../i18n/index.ts';
import type { StatePaths } from '../state/paths.ts';
import type { UnreadSharedEntry } from '../state/workspaces.ts';
import type { UpdateNoticeDeps } from '../update/notice.ts';
import { lookUpOwnVersion } from '../update/version-advice.ts';
import { compareVersions, parseVersion } from '../update/versions.ts';
import { CLI_VERSION } from '../version.ts';

const UNSAFE = new RegExp(LOG_UNSAFE_CHARACTER.source, 'g');

/**
 * A name or a path as it is SHOWN in a sentence: every character that could act on a terminal instead of being read
 * (the C0 and C1 controls, DEL, the bidirectional controls, the invisible formatting characters: the daemon's own
 * list for its log, LOG_UNSAFE_CHARACTER) is written as `\u{…}`, exactly as the daemon writes the problems of a file.
 * Everything this module prints that comes from the disk goes through here: a folder's name beside the workspace's
 * own (anything can be in a name), the paths and names of a refusal, the stamp's version, the problems once more.
 * A path as a word of a COMMAND is `shellWord`'s.
 */
export function shown(text: string): string {
  return text.replace(UNSAFE, (ch) => `\\u{${(ch.codePointAt(0) as number).toString(16)}}`);
}

/** What only the file system says about a refused path: whose it is and what is there. */
export interface FileLook {
  readonly uid: number;
  readonly mode: number;
  readonly kind: 'file' | 'directory' | 'symlink' | 'fifo' | 'socket' | 'device' | 'other';
}

/** lstat as far as the words need it; null when the path cannot be looked at. */
async function lookAtPath(path: string): Promise<FileLook | null> {
  try {
    const st = await lstat(path);
    const kind = st.isSymbolicLink()
      ? 'symlink'
      : st.isFile()
        ? 'file'
        : st.isDirectory()
          ? 'directory'
          : st.isFIFO()
            ? 'fifo'
            : st.isSocket()
              ? 'socket'
              : st.isBlockDevice() || st.isCharacterDevice()
                ? 'device'
                : 'other';
    return { uid: st.uid, mode: st.mode & 0o777, kind };
  } catch {
    return null;
  }
}

export interface RefusalContext {
  /** The environment and the update lookup's network (`newer`), the clock (the date in the last resort's example). */
  readonly io: CliIo;
  readonly workspaceId: string;
  /** `<state dir>/workspaces/<workspace id>`. */
  readonly workspaceDir: string;
  /** The seams of the lookup `smurg update` does (this executable, its version, fetch). */
  readonly update?: UpdateNoticeDeps;
  /** TEST ONLY: what the file system says about a path (another user's file takes root to make). */
  readonly lookAt?: (path: string) => Promise<FileLook | null>;
  /** TEST ONLY: this user's id. */
  readonly ownUid?: number | null;
}

/** 2026/10/08 14:05, in this computer's time. */
export function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 20261008-140507, in this computer's time: the end of a folder name. */
function nameTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * A path as ONE word of a shell command: as it is when every character is plain, else in single quotes. A path that
 * holds a character which must not reach the terminal as it is (`shown`'s list) is written in the `$'…'` form of
 * bash, zsh and ksh instead, each such character as the bytes of its UTF-8 form (`\x1b`): the word is all printable,
 * and those shells read the path back. (A plain `sh` that is dash does not know that form; such a path is one the
 * host made themselves, with a control character in SMURG_HOME or in their home folder's name.)
 */
export function shellWord(path: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path;
  if (!LOG_UNSAFE_CHARACTER.test(path)) return `'${path.replaceAll("'", "'\\''")}'`;
  let word = '';
  for (const ch of path) {
    if (ch === '\\' || ch === "'") word += `\\${ch}`;
    else if (LOG_UNSAFE_CHARACTER.test(ch)) for (const byte of Buffer.from(ch, 'utf8')) word += `\\x${byte.toString(16).padStart(2, '0')}`;
    else word += ch;
  }
  return `$'${word}'`;
}

/** `first, second, ...` as the hint of a failure: one sentence per line. */
function lines(texts: readonly Text[]): Text {
  return m('host.lines', { lines: texts });
}

/** The stamp's writer when it IS a newer smurg than `current` (a stamp can name any version). */
function newerWriter(writtenBy: string | undefined, current: string): string | undefined {
  if (writtenBy === undefined) return undefined;
  const theirs = parseVersion(writtenBy);
  const ours = parseVersion(current);
  return theirs !== null && ours !== null && compareVersions(theirs, ours) > 0 ? shown(writtenBy) : undefined;
}

/** Who owns a file that is not this user's: root by name, anyone else by number; undefined when it cannot be said. */
function ownerOf(look: FileLook | null, ownUid: number | null): Text | undefined {
  if (look === null || look.uid === ownUid) return undefined;
  return look.uid === 0 ? m('host.owner.root') : m('host.owner.uid', { uid: look.uid });
}

const FOUND: Readonly<Record<FileLook['kind'], Extract<MessageId, `host.found.${string}`>>> = {
  directory: 'host.found.directory',
  fifo: 'host.found.fifo',
  socket: 'host.found.socket',
  device: 'host.found.device',
  // What the daemon refused as "not a file" and is one now, or a link: something changed in between; no guess.
  file: 'host.found.other',
  symlink: 'host.found.other',
  other: 'host.found.other',
};

interface Worded {
  readonly text: Text;
  readonly hint: readonly Text[];
}

/**
 * The folder's own entry in workspaces.json is one this smurg cannot read: the entry (its place in the list, the
 * fields that do not fit) and the file, that nothing was changed and no new workspace made, and what to do.
 */
export function entryUnreadProblem(unread: UnreadSharedEntry, paths: StatePaths, current: string = CLI_VERSION): CliError {
  return new CliError(m('host.entryUnread', { place: unread.place, path: shown(paths.workspaces), current }), {
    hint: lines([
      ...(unread.fields.length > 0 ? [m('host.entryUnread.fields', { fields: unread.fields })] : []),
      m('host.entryUnread.unchanged'),
      m('host.entryUnread.next', { workspacesDir: shown(join(paths.stateDir, 'workspaces')) }),
    ]),
  });
}

/** A state file the daemon refuses, as the host should read it: by kind and cause, never one text for all. */
export async function stateFileProblem(err: StateFileError, context: RefusalContext): Promise<CliError> {
  const worded = await wordRefusal(err, context);
  return new CliError(worded.text, { hint: lines(worded.hint), cause: err });
}

async function wordRefusal(err: StateFileError, context: RefusalContext): Promise<Worded> {
  const current = context.update?.version ?? CLI_VERSION;
  const look = context.lookAt ?? lookAtPath;
  const ownUid = context.ownUid !== undefined ? context.ownUid : typeof process.getuid === 'function' ? process.getuid() : null;
  const count = err.paths.length;
  // What is shown of the refusal (see `shown`); the paths themselves are used to look at the files and in commands.
  const path = shown(err.path);
  const all: readonly Text[] = count > 1 ? [m('host.refused.all', { paths: err.paths.map(shown) })] : [];
  // A start that only read left the folder byte for byte. One that was writing (phase 2) did not: never the bare
  // "Nothing was changed." for it, but what a failed write says (nothing the workspace holds was changed or reset).
  const writing = err.phase === 2;
  const unchanged = m(writing ? 'host.cannotOpen.unchanged' : 'host.unchanged');
  switch (err.kind) {
    case 'newer': {
      // What `smurg update` would find decides the advice: "run smurg update" for ever helps nobody whose folder was
      // written by a smurg that is not published (or was copied from another computer).
      const own = await lookUpOwnVersion(context.io, context.update);
      const writer = newerWriter(err.writtenBy, current);
      const stamp = m('host.newer.stamp', { stamp: shown(join(context.workspaceDir, STAMP_FILE)), ...(err.writtenBy === undefined ? {} : { writtenBy: shown(err.writtenBy) }) });
      const next: readonly Text[] =
        own.kind === 'newer-published' ? [m('host.newer.update', { latest: own.latest })] : own.kind === 'newest' ? [m('host.newer.newest', { current: own.current }), stamp] : [m('host.newer.maybe'), stamp];
      return { text: m('host.newer', { path, current, ...(writer === undefined ? {} : { writtenBy: writer }) }), hint: [unchanged, ...next] };
    }
    case 'insecure': {
      const found = await look(err.path);
      switch (err.cause) {
        case 'mode': {
          const mode = ((err.mode ?? found?.mode ?? 0) & 0o777).toString(8).padStart(3, '0');
          // ONE command for every path (the daemon looked at all of them before it refused).
          const command = `chmod 600 ${err.paths.map(shellWord).join(' ')}`;
          return { text: m('host.insecure.mode', { path, mode, count }), hint: [unchanged, m('host.insecure.mode.hint', { count, command })] };
        }
        case 'owner': {
          const owner = ownerOf(found, ownUid);
          return { text: m('host.insecure.owner', { path, count, ...(owner === undefined ? {} : { owner }) }), hint: [unchanged, m('host.insecure.owner.hint', { count }), ...all] };
        }
        case 'symlink':
          return { text: m('host.insecure.symlink', { path, count }), hint: [unchanged, m('host.insecure.symlink.hint'), ...all] };
        default:
          return {
            text: m('host.insecure.notFile', { path, count, found: m(FOUND[found?.kind ?? 'other']) }),
            hint: [unchanged, m('host.insecure.notFile.hint'), ...all],
          };
      }
    }
    case 'cannot-open': {
      // The errno is the system's own code; anything else is not shown.
      const code = err.errno !== undefined && /^[A-Z][A-Z0-9]{1,24}$/.test(err.errno) ? err.errno : 'unknown';
      // After one `sudo smurg host` the files are root's and private: the open fails with EACCES.
      const owner = ownerOf(await look(err.path), ownUid);
      return {
        text: m('host.cannotOpen', { path, count, reason: m('host.cannotOpen.reason', { code }) }),
        // Not "nothing was changed": when it is a WRITE that failed (the stamp, a kept copy, an upgraded document),
        // the stamp or a copy may already be there. Nothing the workspace holds was changed or reset.
        hint: [m('host.cannotOpen.unchanged'), ...(owner === undefined ? [] : [m('host.cannotOpen.owner', { owner })]), m('host.cannotOpen.hint'), ...all],
      };
    }
    case 'other-workspace':
      return { text: m('host.otherWorkspace', { path, workspaceId: context.workspaceId }), hint: [unchanged, m('host.otherWorkspace.hint')] };
    case 'unreadable': {
      const file = basename(err.path);
      const reason = err.reason ?? 'no-known-shape';
      const text =
        reason === 'not-json'
          ? m('host.unreadable.notJson', { path })
          : reason === 'missing'
            ? m(file === 'identity.key' ? 'host.unreadable.missingKey' : 'host.unreadable.missingState', { path })
            : reason === 'carried-value-refused'
              ? m('host.unreadable.carried', { path, current })
              : m('host.unreadable.shape', { path, current });
      const hint: Text[] = [];
      // The problems are the daemon's: paths inside the document and the rule each breaks, never a value; at most
      // eight. The daemon escapes them; they are shown through the same escaping here, whatever it did.
      if ((reason === 'no-known-shape' || reason === 'carried-value-refused') && err.problems.length > 0) hint.push(m('host.unreadable.problems', { problems: err.problems.map(shown), more: err.moreProblems }));
      hint.push(writing ? unchanged : m(reason === 'missing' ? 'host.unreadable.missing.unchanged' : 'host.unchanged'));
      // FIRST, before anything that loses something: a newer smurg may be what wrote it. (Not for a value an EARLIER
      // smurg wrote: that file's writer is known to be older.)
      if (reason !== 'carried-value-refused') {
        const writer = newerWriter(err.writtenBy, current);
        if (err.writtenBy === undefined) hint.push(m('host.unreadable.maybeNewer'));
        else if (writer !== undefined) hint.push(m('host.unreadable.writerNewer', { writtenBy: writer }));
      }
      // The newest kept copy, AFTER what putting it back undoes (the sentence itself is in that order).
      const copy = err.copies[0];
      if (copy !== undefined) hint.push(m(file === 'state.json' ? 'host.unreadable.copy.state' : 'host.unreadable.copy.other', { name: shown(basename(copy.path)), date: formatTime(copy.at) }));
      if (err.canSetAside) {
        // This ONE file can go and the workspace stays (the daemon proved it for this document): what it holds, that
        // only that is lost, and the move to a name beside it that no start reads. No last resort for such a file.
        const document: SetAsideDocument = (SET_ASIDE_DOCUMENTS as readonly string[]).includes(err.document ?? '') ? (err.document as SetAsideDocument) : 'other';
        const aside = await freeName(`${err.path}.set-aside-${nameTime(context.io.now())}`, look);
        hint.push(m('host.setAside', { document }), m('host.setAside.command', { command: `mv ${shellWord(err.path)} ${shellWord(aside)}` }));
        return { text, hint };
      }
      // The LAST resort, after what it costs.
      const target = await asideTarget(context.workspaceDir, context.io.now(), look);
      hint.push(m('host.unreadable.lastResort'), m('host.unreadable.lastResort.command', { command: `mv ${shellWord(context.workspaceDir)} ${shellWord(target)}` }));
      return { text, hint };
    }
  }
}

/**
 * Where the last resort's example moves the workspace's folder: `<folder>.old-<date>-<time>`, a name that is NOT there
 * now (`mv X Y` with a folder Y puts X inside it), with a number added when it is.
 */
async function asideTarget(workspaceDir: string, now: number, look: (path: string) => Promise<FileLook | null>): Promise<string> {
  return freeName(`${workspaceDir}.old-${nameTime(now)}`, look);
}

/** `first`, or `first-2`, `first-3`, …: the first of them that names nothing now (a `mv` never lands on, or in, something). */
async function freeName(first: string, look: (path: string) => Promise<FileLook | null>): Promise<string> {
  let target = first;
  for (let n = 2; n <= 99 && (await look(target)) !== null; n += 1) target = `${first}-${n}`;
  return target;
}

// ---- what a start found, one line each

/**
 * The ONE line of a start that upgraded what an earlier smurg wrote (Daemon.upgraded), or the warning that an OLDER
 * file was put back and upgraded again (Daemon.putBack); null when this start upgraded nothing.
 */
export function upgradeNotice(daemon: Pick<Daemon, 'upgraded' | 'putBack'>): Text | null {
  if (daemon.upgraded.length === 0) return null;
  if (daemon.putBack) {
    // state.json holds the members, devices and invite links: an older one undoes kicks and revocations.
    const names = daemon.upgraded.map((entry) => `${entry.document}.json`);
    return m(daemon.upgraded.some((entry) => entry.document === 'state') ? 'host.putBack.state' : 'host.putBack.other', { names });
  }
  // The step's name is the published smurg whose shape the file had; several steps at once: "an earlier smurg".
  const from = daemon.upgraded.every((entry) => entry.from === daemon.upgraded[0]?.from) ? daemon.upgraded[0]?.from : undefined;
  return m('host.upgraded', from !== undefined && parseVersion(from) !== null ? { from } : {});
}

/** Whether a smurg that stamps its folders (0.5.1 or later) has opened this workspace folder before. */
export async function wasStamped(workspaceDir: string): Promise<boolean> {
  try {
    await lstat(join(workspaceDir, STAMP_FILE));
    return true;
  } catch (err) {
    // Not there: never opened by such a smurg. There and not to be looked at: say nothing about it.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * The folders named `<workspace id>.old*` beside the workspace's own, by name. 0.5.0 told a host whose state it could
 * not read to `mv <folder> <folder>.old` (wrongly, after an update from 0.4.0: that folder holds the members, the
 * invite links and the daemon's key the host had); the guide names the same move for replacing the keys on purpose.
 */
export async function foldersSetAside(workspaceDir: string): Promise<readonly string[]> {
  const parent = dirname(workspaceDir);
  const prefix = `${basename(workspaceDir)}.old`;
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => join(parent, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** The one line about them (it does not say "go back": the host may have set the folder aside on purpose). */
export function oldFolderNotice(folders: readonly string[]): Text | null {
  const first = folders[0];
  // A folder's name is whatever somebody gave it: shown escaped (it was printed as it is, escape sequences and all).
  return first === undefined ? null : m('host.oldFolder', { path: shown(first), more: folders.length - 1 });
}

export type RefusedPeer = 'peer-newer' | 'peer-older';

/**
 * A peer of another protocol version that the daemon turned away, told ONCE per run and direction and only when the
 * daemon knows the peer (a registered, unrevoked device of an active member, or an invite that is usable now). Lines
 * are held until `release()` (the start summary is printed first).
 */
export function watchRefusedPeers(daemon: Pick<Daemon, 'ctx'>, tell: (direction: RefusedPeer, text: Text) => void): { release(): void; dispose(): void } {
  const told = new Set<RefusedPeer>();
  let held: RefusedPeer[] | null = [];
  const say = (direction: RefusedPeer): void => tell(direction, m(direction === 'peer-newer' ? 'host.peer.newer' : 'host.peer.older'));
  const listener = daemon.ctx.bus.on('peer.version-refused', ({ direction, known }) => {
    if (!known || told.has(direction)) return;
    told.add(direction);
    if (held !== null) held.push(direction);
    else say(direction);
  });
  return {
    release: () => {
      const waiting = held ?? [];
      held = null;
      for (const direction of waiting) say(direction);
    },
    dispose: () => listener.dispose(),
  };
}
