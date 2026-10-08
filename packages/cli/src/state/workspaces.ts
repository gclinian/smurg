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
import { randomBytes } from 'node:crypto';
import { isWorkspaceId } from '@smurg/protocol/relay';
import type { StatePaths } from './paths.ts';
import { isRecord, numberField, readPrivateJson, stringField, versionedRecord, writePrivateJson } from './private-file.ts';

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

export async function loadWorkspaces(paths: StatePaths): Promise<WorkspaceBook> {
  // No file: nothing was shared or joined yet. A file this smurg cannot read: refused (never an empty list).
  const raw = versionedRecord(await readPrivateJson(paths.workspaces, WHAT), paths.workspaces, WHAT, 1);
  if (raw === null) return { shared: [], joined: [] };
  const shared: SharedFolder[] = [];
  for (const item of Array.isArray(raw['shared']) ? raw['shared'] : []) {
    if (!isRecord(item)) continue;
    const folder = stringField(item, 'folder', 4096);
    const relay = stringField(item, 'relay', 2048);
    const workspaceId = stringField(item, 'workspaceId', 64);
    const createdAt = numberField(item, 'createdAt');
    if (folder && relay && workspaceId && isWorkspaceId(workspaceId) && createdAt !== null) shared.push({ folder, relay, workspaceId, createdAt });
  }
  const joined: JoinedWorkspace[] = [];
  for (const item of Array.isArray(raw['joined']) ? raw['joined'] : []) {
    if (!isRecord(item)) continue;
    const workspaceId = stringField(item, 'workspaceId', 64);
    const relay = stringField(item, 'relay', 2048);
    const joinedAt = numberField(item, 'joinedAt');
    const name = typeof item['name'] === 'string' ? item['name'].slice(0, 256) : null;
    const web = originField(item, 'web');
    if (workspaceId && isWorkspaceId(workspaceId) && relay && joinedAt !== null) joined.push({ workspaceId, relay, name, joinedAt, ...(web ? { web } : {}) });
  }
  return { shared, joined };
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

async function save(paths: StatePaths, book: WorkspaceBook): Promise<void> {
  await writePrivateJson(paths.workspaces, { version: 1, shared: book.shared, joined: book.joined }, WHAT);
}

/** A fresh workspace id: `ws_` + 128 random bits (base64url). */
export function newWorkspaceId(): string {
  return `ws_${randomBytes(16).toString('base64url')}`;
}

export function sharedFolderFor(book: WorkspaceBook, folder: string, relay: string): SharedFolder | null {
  return book.shared.find((entry) => entry.folder === folder && entry.relay === relay) ?? null;
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
  const book = await loadWorkspaces(paths);
  const shared = book.shared.filter((e) => !(e.folder === entry.folder && e.relay === entry.relay));
  await save(paths, { shared: [...shared, entry], joined: book.joined });
}

export async function rememberJoined(paths: StatePaths, entry: JoinedWorkspace): Promise<void> {
  const book = await loadWorkspaces(paths);
  const joined = book.joined.filter((e) => e.workspaceId !== entry.workspaceId);
  await save(paths, { shared: book.shared, joined: [...joined, entry] });
}
