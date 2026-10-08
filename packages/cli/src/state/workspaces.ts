// `~/.smurg/workspaces.json` (ARCHITECTURE §7.1 "folder path → workspaceId"): the workspaces this machine hosts (one
// per shared folder and relay, so `smurg host` keeps its members, devices and audit log across runs) and the ones it
// joined as a guest (so `smurg attach --workspace <id>` knows the relay later).
//
// This file is the ONLY link from a shared folder to its workspace id: read as empty, `smurg host` gives the folder a
// new workspace (new members, new invite links, a new daemon key), exactly as moving the workspace's state away does.
// So a file this smurg cannot read is a refusal that changes nothing (./private-file.ts versionedRecord; 0.5.1, DESIGN
// B5): a `version` above 1 says a newer smurg wrote it (`smurg update`), anything else that it is not in its format.
// 0.4.0 and 0.5.0 are published with the old behaviour (an unknown version read as empty and written over), so the
// `version` of this file can never be raised without those two losing it: a later smurg adds optional fields only.
//
// An ENTRY this smurg cannot read (a workspace id in another form, a folder path longer than it takes, something that
// is no object) is not used and is never dropped: every write puts it back exactly as it was, at its place among the
// others, and the command says once how many there are (./private-file.ts reportUnreadEntries). Until 0.5.0 it was
// skipped without a word and gone at the next write. A list that is there and is no list refuses the file.
//
// "Not used" has one exception, for the folder such an entry is FOR: `smurg host <folder>` found no entry it could
// read and gave the folder a NEW workspace (the silent reset this file's first paragraph is about). `lookUpSharedFolder`
// therefore also says when an entry that cannot be read names the folder (`unread`), and `smurg host` stops there.
import { randomBytes } from 'node:crypto';
import { isWorkspaceId } from '@smurg/protocol/relay';
import type { StatePaths } from './paths.ts';
import { isRecord, listField, numberField, readPrivateJson, reportUnreadEntries, stringField, versionedRecord, writePrivateJson } from './private-file.ts';

const WHAT = 'workspaces' as const;

export interface SharedFolder {
  /** realpath of the shared folder. */
  readonly folder: string;
  readonly relay: string;
  readonly workspaceId: string;
  readonly createdAt: number;
}

export interface JoinedWorkspace {
  readonly workspaceId: string;
  readonly relay: string;
  readonly name: string | null;
  readonly joinedAt: number;
  /**
   * The origin of the workspace's web app when it is not the relay itself (the invite link pointed elsewhere: a
   * development setup). `smurg attach` names the workspace's address there for agent conversations.
   */
  readonly web?: string;
}

export interface WorkspaceBook {
  readonly shared: readonly SharedFolder[];
  readonly joined: readonly JoinedWorkspace[];
}

/** One item of a list as the file holds it: an entry this smurg reads, or what stands there, kept as it is. */
type Slot<T> = { readonly entry: T } | { readonly kept: unknown };

/** The file as it is written back: every item of both lists in its place. */
interface BookFile {
  readonly shared: readonly Slot<SharedFolder>[];
  readonly joined: readonly Slot<JoinedWorkspace>[];
}

function entriesOf<T>(slots: readonly Slot<T>[]): T[] {
  return slots.flatMap((slot) => ('entry' in slot ? [slot.entry] : []));
}

function sharedFolderOf(item: unknown): SharedFolder | null {
  if (!isRecord(item)) return null;
  const folder = stringField(item, 'folder', 4096);
  const relay = stringField(item, 'relay', 2048);
  const workspaceId = stringField(item, 'workspaceId', 64);
  const createdAt = numberField(item, 'createdAt');
  return folder && relay && workspaceId && isWorkspaceId(workspaceId) && createdAt !== null ? { folder, relay, workspaceId, createdAt } : null;
}

function joinedWorkspaceOf(item: unknown): JoinedWorkspace | null {
  if (!isRecord(item)) return null;
  const workspaceId = stringField(item, 'workspaceId', 64);
  const relay = stringField(item, 'relay', 2048);
  const joinedAt = numberField(item, 'joinedAt');
  const name = typeof item['name'] === 'string' ? item['name'].slice(0, 256) : null;
  const web = originField(item, 'web');
  return workspaceId && isWorkspaceId(workspaceId) && relay && joinedAt !== null ? { workspaceId, relay, name, joinedAt, ...(web ? { web } : {}) } : null;
}

function slotsOf<T>(items: readonly unknown[], read: (item: unknown) => T | null): Slot<T>[] {
  return items.map((item) => {
    const entry = read(item);
    return entry === null ? { kept: item } : { entry };
  });
}

async function readBook(paths: StatePaths): Promise<BookFile> {
  // No file: nothing was shared or joined yet. A file this smurg cannot read: refused (never an empty list).
  const raw = versionedRecord(await readPrivateJson(paths.workspaces, WHAT), paths.workspaces, WHAT, 1);
  if (raw === null) return { shared: [], joined: [] };
  const file: BookFile = {
    shared: slotsOf(listField(raw, 'shared', paths.workspaces, WHAT), sharedFolderOf),
    joined: slotsOf(listField(raw, 'joined', paths.workspaces, WHAT), joinedWorkspaceOf),
  };
  reportUnreadEntries(paths, WHAT, paths.workspaces, file.shared.length + file.joined.length - entriesOf(file.shared).length - entriesOf(file.joined).length);
  return file;
}

export async function loadWorkspaces(paths: StatePaths): Promise<WorkspaceBook> {
  const file = await readBook(paths);
  return { shared: entriesOf(file.shared), joined: entriesOf(file.joined) };
}

/** An http(s) origin exactly as `URL.origin` spells it (it is shown to the person as part of an address), else null. */
function originField(record: Record<string, unknown>, key: string): string | null {
  const text = stringField(record, key, 2048);
  if (text === null) return null;
  try {
    const url = new URL(text);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === text ? text : null;
  } catch {
    return null;
  }
}

/** An entry as it is written, or the kept item exactly as it was read. */
function written<T>(slots: readonly Slot<T>[]): unknown[] {
  return slots.map((slot) => ('entry' in slot ? slot.entry : slot.kept));
}

async function save(paths: StatePaths, file: BookFile): Promise<void> {
  await writePrivateJson(paths.workspaces, { version: 1, shared: written(file.shared), joined: written(file.joined) }, WHAT);
}

/** A fresh workspace id: `ws_` + 128 random bits (base64url). */
export function newWorkspaceId(): string {
  return `ws_${randomBytes(16).toString('base64url')}`;
}

export function sharedFolderFor(book: WorkspaceBook, folder: string, relay: string): SharedFolder | null {
  return book.shared.find((entry) => entry.folder === folder && entry.relay === relay) ?? null;
}

/** The fields of a shared folder's entry, in the order the file has them. */
export type SharedFolderField = 'folder' | 'relay' | 'workspaceId' | 'createdAt';

/** An item of `shared` that this smurg cannot read and that is the entry of one folder at one relay. */
export interface UnreadSharedEntry {
  /** Its place in the file's `shared` list, counted from 1. */
  readonly place: number;
  /** The fields that are not there in a form this smurg reads: names of ours, never anything the file holds. */
  readonly fields: readonly SharedFolderField[];
}

export interface SharedFolderLookup {
  /** The entry of this folder and relay, when this smurg can read it. */
  readonly entry: SharedFolder | null;
  /**
   * Without such an entry: the first item of `shared` this smurg could NOT read that is this folder's own. It is one
   * when it names exactly this folder and does not name another relay (a `relay` that cannot be read may be this one).
   * An item that names no folder that can be compared (no object, no text there) is nobody's own: it is kept and
   * counted (reportUnreadEntries), as every entry this smurg cannot read.
   */
  readonly unread: UnreadSharedEntry | null;
}

function unreadFields(item: Record<string, unknown>): SharedFolderField[] {
  const workspaceId = stringField(item, 'workspaceId', 64);
  const readable: Readonly<Record<SharedFolderField, boolean>> = {
    folder: stringField(item, 'folder', 4096) !== null,
    relay: stringField(item, 'relay', 2048) !== null,
    workspaceId: workspaceId !== null && isWorkspaceId(workspaceId),
    createdAt: numberField(item, 'createdAt') !== null,
  };
  return (['folder', 'relay', 'workspaceId', 'createdAt'] as const).filter((field) => !readable[field]);
}

/** What workspaces.json says about `folder` shared through `relay` (one read of the file). */
export async function lookUpSharedFolder(paths: StatePaths, folder: string, relay: string): Promise<SharedFolderLookup> {
  const file = await readBook(paths);
  const entry = sharedFolderFor({ shared: entriesOf(file.shared), joined: [] }, folder, relay);
  if (entry !== null) return { entry, unread: null };
  for (const [index, slot] of file.shared.entries()) {
    if ('entry' in slot || !isRecord(slot.kept) || slot.kept['folder'] !== folder) continue;
    const itsRelay = stringField(slot.kept, 'relay', 2048);
    if (itsRelay !== null && itsRelay !== relay) continue;
    return { entry: null, unread: { place: index + 1, fields: unreadFields(slot.kept) } };
  }
  return { entry: null, unread: null };
}

/** The hosted workspace whose folder contains `dir` (the deepest one), whatever the relay. */
export function sharedFolderContaining(book: WorkspaceBook, dir: string): SharedFolder | null {
  let best: SharedFolder | null = null;
  for (const entry of book.shared) {
    const inside = dir === entry.folder || dir.startsWith(entry.folder.endsWith('/') ? entry.folder : `${entry.folder}/`);
    if (inside && (best === null || entry.folder.length > best.folder.length)) best = entry;
  }
  return best;
}

export async function rememberSharedFolder(paths: StatePaths, entry: SharedFolder): Promise<void> {
  const file = await readBook(paths);
  // The entry of this folder and relay is replaced (the new one goes to the end); what could not be read stays put.
  const shared = file.shared.filter((slot) => !('entry' in slot && slot.entry.folder === entry.folder && slot.entry.relay === entry.relay));
  await save(paths, { shared: [...shared, { entry }], joined: file.joined });
}

export async function rememberJoined(paths: StatePaths, entry: JoinedWorkspace): Promise<void> {
  const file = await readBook(paths);
  const joined = file.joined.filter((slot) => !('entry' in slot && slot.entry.workspaceId === entry.workspaceId));
  await save(paths, { shared: file.shared, joined: [...joined, { entry }] });
}
