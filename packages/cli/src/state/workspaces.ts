// `~/.smurg/workspaces.json` (ARCHITECTURE §7.1 "folder path → workspaceId"): the workspaces this machine hosts (one
// per shared folder and relay, so `smurg host` keeps its members, devices and audit log across runs) and the ones it
// joined as a guest (so `smurg attach --workspace <id>` knows the relay later).
import { randomBytes } from 'node:crypto';
import { isWorkspaceId } from '@smurg/protocol/relay';
import type { StatePaths } from './paths.ts';
import { isRecord, numberField, readPrivateJson, stringField, writePrivateJson } from './private-file.ts';

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
}

export interface WorkspaceBook {
  readonly shared: readonly SharedFolder[];
  readonly joined: readonly JoinedWorkspace[];
}

export async function loadWorkspaces(paths: StatePaths): Promise<WorkspaceBook> {
  const raw = await readPrivateJson(paths.workspaces, WHAT);
  if (!isRecord(raw) || raw['version'] !== 1) return { shared: [], joined: [] };
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
    if (workspaceId && isWorkspaceId(workspaceId) && relay && joinedAt !== null) joined.push({ workspaceId, relay, name, joinedAt });
  }
  return { shared, joined };
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
