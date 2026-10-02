// The file tree (SPEC R7 file tree, R8 lock badges, R9 tree switching; ARCHITECTURE §5.2): one lazily loaded tree per root
// — the root the WorktreeSwitcher selected (files store `activeRoot`) — kept fresh by file.changed (the files store
// re-lists loaded folders). Create / rename / delete with confirmation, a context menu, full keyboard navigation
// (WAI-ARIA tree), downloads and uploads through the command bus (the transfer feature does the transfer; a drop is
// collected SYNCHRONOUSLY in the drop handler, lib/drop.ts). Everything that writes is hidden from viewers; the daemon
// enforces it anyway.
//
// Handles the `revealFile` command.
import {
  baseNameOfRelPath,
  fileRefKey,
  isSmurgError,
  lockOfError,
  rootRefEquals,
  rootRefKey,
  type FileEntry,
  type FileRef,
  type LockInfo,
  type RootRef,
  type SessionInfo,
  type WorktreeInfo,
} from '@smurg/protocol';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { NoCommandHandlerError, type CommandMap, type CommandName, type UploadSource } from '../../lib/commands.ts';
import { collectDrop } from '../../lib/drop.ts';
import { describeError } from '../../lib/errors.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectActiveDoc } from '../../lib/stores/docs.ts';
import { selectActiveRoot, selectDir } from '../../lib/stores/files.ts';
import { selectWorktreeList, worktreeLabel } from '../../lib/stores/worktrees.ts';
import { useCapabilities, useCommandHandler, useCommands, useMember, useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, EmptyState, IconButton, Menu, Panel, Spinner, useToast, type MenuItem } from '../../ui/index.ts';
import {
  IconAgent,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconEdit,
  IconEye,
  IconFile,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconLink,
  IconLock,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUnlock,
  IconUpload,
} from '../../ui/icons.tsx';
import { ContextMenu } from './ContextMenu.tsx';
import { DeleteDialog, NameDialog, type NameDialogMode } from './dialogs.tsx';
import { ForceReleaseDialog, useCanForceRelease } from './ForceReleaseDialog.tsx';
import { formatList } from '../../lib/format.ts';
import { t } from './strings.ts';
import { ancestorsOf, entryBadges, flattenTree, isEntryWritable, peopleUsing, targetDirOf, type EntryBadge, type TreeRow } from './tree-model.ts';
import { useNow } from './use-now.ts';
import './files.css';

/** No props: everything comes from the workspace hooks (useStores().files, useCommand('openFile'), …). */
export type FilesPanelProps = Record<never, never>;

type DialogState =
  | { readonly kind: 'name'; readonly mode: NameDialogMode }
  | { readonly kind: 'delete'; readonly entry: FileEntry }
  | { readonly kind: 'force-release'; readonly file: FileRef; readonly lock: LockInfo };

const NO_EXPANDED: ReadonlySet<string> = new Set();

export function FilesPanel(_props: FilesPanelProps) {
  const stores = useStores();
  const files = stores.files;
  const caps = useCapabilities();
  const member = useMember();
  const toast = useToast();
  const commands = useCommands();
  const root = useStore(files, selectActiveRoot);
  const rootKey = rootRefKey(root);
  const filesState = useStore(files);
  const locksState = useStore(stores.locks);
  const canForceRelease = useCanForceRelease();
  const activeDoc = useStore(stores.docs, selectActiveDoc);
  const worktrees = useStore(stores.worktrees, selectWorktreeList, shallowEqual);
  const sessionsById = useStore(stores.sessions, (state) => state.sessions);
  const now = useNow(60_000);
  const writeCtx = useMemo(() => ({ canWrite: caps.can('file.write'), isHost: caps.isHost }), [caps]);

  const [expandedByRoot, setExpandedByRoot] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  const expanded = expandedByRoot.get(rootKey) ?? NO_EXPANDED;
  // Shared folders of the worktree shown (D12): symlinks listed as the read-only folders they lead to.
  const sharedDirs = useMemo(
    () => new Set(root.kind === 'worktree' ? (worktrees.find((worktree) => worktree.id === root.worktreeId)?.sharedDirs ?? []) : []),
    [root, worktrees],
  );
  const rows = useMemo(() => flattenTree(filesState, root, expanded, sharedDirs), [filesState, root, expanded, sharedDirs]);
  const entryRows = useMemo(() => rows.filter((row) => row.kind === 'entry'), [rows]);
  const rootListing = selectDir(filesState, root, '');

  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: TreeRow | null } | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const uploadTarget = useRef('');
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const idBase = useId();

  // ---- loading: the root when it is shown, every expanded folder that has no listing yet (lazy)

  useEffect(() => {
    files.loadDir(root, '').catch(() => {});
    setFocusedPath(null);
  }, [files, rootKey]);

  useEffect(() => {
    for (const row of rows) if (row.kind === 'loading') files.loadDir(root, row.path).catch(() => {});
  }, [files, root, rows]);

  const setExpanded = useCallback(
    (update: (previous: ReadonlySet<string>) => ReadonlySet<string>) =>
      setExpandedByRoot((previous) => {
        const next = new Map(previous);
        next.set(rootKey, update(previous.get(rootKey) ?? NO_EXPANDED));
        return next;
      }),
    [rootKey],
  );

  const expand = (path: string): void => {
    setExpanded((previous) => new Set([...previous, path]));
    files.loadDir(root, path).catch(() => {});
  };
  const collapse = (path: string): void => {
    setExpanded((previous) => new Set([...previous].filter((p) => p !== path)));
    // A collapsed folder is no longer kept fresh (nor its subfolders); it is listed again when reopened.
    files.forgetDir(root, path);
  };

  // ---- the focused row: roving tabindex, focus follows the state

  const effectiveFocus = focusedPath !== null && entryRows.some((row) => row.path === focusedPath) ? focusedPath : (entryRows[0]?.path ?? null);
  /** The row element of `path`, compared as data (paths may contain anything a selector would have to escape). */
  const rowNode = (path: string): HTMLElement | undefined =>
    [...(tree.current?.querySelectorAll<HTMLElement>('[data-row-path]') ?? [])].find((node) => node.dataset['rowPath'] === path);
  const focusRow = (path: string | null | undefined): void => {
    if (path === null || path === undefined) return;
    setFocusedPath(path);
    // After React rendered the row (a new file, an expanded folder). Unless something else took the focus meanwhile
    // (a dialog a menu item opened, or the one that just closed gave it back to its opener): leave it there.
    setTimeout(() => {
      const active = document.activeElement;
      if (active !== null && active !== document.body && !tree.current?.contains(active)) return;
      const node = rowNode(path);
      node?.focus();
      node?.scrollIntoView?.({ block: 'nearest' });
    }, 0);
  };

  // ---- commands

  const dispatch = <K extends CommandName>(name: K, payload: CommandMap[K]): void => {
    commands.dispatch(name, payload).catch((error: unknown) => {
      toast.show({ tone: 'danger', title: error instanceof NoCommandHandlerError ? t('error.unavailable') : describeError(error) });
    });
  };

  const openEntry = (entry: FileEntry): void => {
    if (entry.kind === 'dir') {
      if (expanded.has(entry.path)) collapse(entry.path);
      else expand(entry.path);
      return;
    }
    dispatch('openFile', { file: { root, path: entry.path } });
  };

  useCommandHandler('revealFile', async ({ file }) => {
    if (!rootRefEquals(files.getState().activeRoot, file.root)) files.setActiveRoot(file.root);
    const folders = ancestorsOf(file.path);
    setExpandedByRoot((previous) => {
      const key = rootRefKey(file.root);
      const next = new Map(previous);
      next.set(key, new Set([...(previous.get(key) ?? NO_EXPANDED), ...folders]));
      return next;
    });
    await Promise.allSettled(['', ...folders].map((dir) => files.loadDir(file.root, dir)));
    focusRow(file.path);
  });

  const describeFileError = (error: unknown): string => {
    const lock = isSmurgError(error) ? lockOfError(error) : null;
    if (lock?.kind === 'agent') return t('error.agentLocked', { agent: lock.agentName });
    if (lock?.kind === 'human') return t('error.humanLocked', { names: formatList(lock.holders.map((h) => h.displayName)) });
    return describeError(error);
  };

  const attempt = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      toast.show({ tone: 'danger', title: describeFileError(error) });
      throw error;
    }
  };

  const createEntry = (mode: Extract<NameDialogMode, { kind: 'create' }>, path: string): Promise<void> =>
    attempt(async () => {
      await files.create({ root, path }, mode.entryKind);
      if (mode.parent !== '' && !expanded.has(mode.parent)) expand(mode.parent);
      focusRow(path);
      if (mode.entryKind === 'file') dispatch('openFile', { file: { root, path } });
    });

  const renameEntry = (entry: FileEntry, to: string): Promise<void> =>
    attempt(async () => {
      await files.rename(root, entry.path, to);
      // Open tabs of the file (or of everything in the folder) follow it to the new name.
      stores.docs.followRename(root, entry.path, to);
      focusRow(to);
    });

  const deleteEntry = (entry: FileEntry): Promise<void> =>
    attempt(async () => {
      await files.delete({ root, path: entry.path });
      toast.show({ tone: 'success', title: t('toast.deleted', { name: entry.name }) });
    });

  const download = (entry: FileEntry | null): void => {
    const file: FileRef = { root, path: entry?.path ?? '' };
    dispatch('download', entry === null || entry.kind === 'dir' ? { file, zip: true } : { file });
  };

  const startUpload = (targetDir: string, source: UploadSource): void => dispatch('startUpload', { root, targetDir, source });

  const pickUpload = (targetDir: string, folder: boolean): void => {
    uploadTarget.current = targetDir;
    (folder ? folderInput : fileInput).current?.click();
  };

  const copyPath = (path: string): void => {
    navigator.clipboard?.writeText(path).then(
      () => toast.show({ tone: 'success', title: t('toast.pathCopied') }),
      () => toast.show({ tone: 'danger', title: t('toast.copyFailed') }),
    );
  };

  // ---- what may be done where

  const dirWritable = (dir: string): boolean => {
    if (dir === '') return isEntryWritable(null, '', writeCtx);
    const row = rows.find((r) => r.kind === 'entry' && r.path === dir);
    return isEntryWritable(row?.entry ?? null, dir, writeCtx);
  };

  const siblingsOf = (dir: string): string[] => selectDir(filesState, root, dir)?.entries.map((entry) => entry.name) ?? [];

  /**
   * The live lock of a path: once lock.list has answered, the locks store (kept current by lock.state) is the truth,
   * including "no lock"; before that, the lock the listing carried.
   */
  const liveLockOf = (path: string) => (locksState.status === 'ready' ? (locksState.locks.get(fileRefKey({ root, path })) ?? null) : undefined);

  const menuItems = (row: TreeRow | null): MenuItem[] => {
    const entry = row?.kind === 'entry' ? row.entry : null;
    const dir = targetDirOf(row);
    const items: MenuItem[] = [];
    if (entry && entry.kind !== 'dir') items.push({ id: 'open', label: t('action.open'), icon: <IconFileText />, onSelect: () => openEntry(entry) });
    if ((!entry || entry.kind === 'dir') && dirWritable(dir)) {
      items.push(
        { id: 'new-file', label: t('action.newFile'), icon: <IconPlus />, onSelect: () => setDialog({ kind: 'name', mode: { kind: 'create', entryKind: 'file', parent: dir } }) },
        { id: 'new-folder', label: t('action.newFolder'), icon: <IconFolder />, onSelect: () => setDialog({ kind: 'name', mode: { kind: 'create', entryKind: 'dir', parent: dir } }) },
        { id: 'upload-files', label: t('action.uploadFiles'), icon: <IconUpload />, onSelect: () => pickUpload(dir, false) },
        { id: 'upload-folder', label: t('action.uploadFolder'), icon: <IconUpload />, onSelect: () => pickUpload(dir, true) },
      );
    }
    if (entry && isEntryWritable(entry, entry.path, writeCtx)) {
      items.push(
        { id: 'rename', label: t('action.rename'), icon: <IconEdit />, hint: 'F2', onSelect: () => setDialog({ kind: 'name', mode: { kind: 'rename', entry } }) },
        { id: 'delete', label: t('action.delete'), icon: <IconTrash />, hint: 'Delete', danger: true, onSelect: () => setDialog({ kind: 'delete', entry }) },
      );
    }
    items.push({
      id: 'download',
      label: entry === null ? t('action.downloadRoot') : entry.kind === 'dir' ? t('action.downloadZip') : t('action.download'),
      icon: <IconDownload />,
      onSelect: () => download(entry),
    });
    if (entry) items.push({ id: 'copy-path', label: t('action.copyPath'), icon: <IconCopy />, onSelect: () => copyPath(entry.path) });
    // The host can break any lock (SPEC R8); the dialog names who holds it.
    const lock = entry && entry.kind !== 'dir' ? (liveLockOf(entry.path) === undefined ? (entry.lock ?? null) : liveLockOf(entry.path)) : null;
    if (entry && lock && canForceRelease) {
      items.push({ id: 'force-release', label: t('action.forceRelease'), icon: <IconUnlock />, danger: true, onSelect: () => setDialog({ kind: 'force-release', file: { root, path: entry.path }, lock }) });
    }
    if (!entry) items.push({ id: 'refresh', label: t('action.refresh'), icon: <IconRefresh />, onSelect: () => void files.loadDir(root, '', { force: true }).catch(() => {}) });
    return items;
  };

  const openMenuAtRow = (row: TreeRow): void => {
    const rect = rowNode(row.path)?.getBoundingClientRect();
    setMenu({ x: (rect?.left ?? 0) + 24, y: rect?.bottom ?? 0, row });
  };

  // ---- keyboard (WAI-ARIA tree view)

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: TreeRow): void => {
    const index = entryRows.findIndex((r) => r.path === row.path);
    const entry = row.entry;
    if (!entry) return;
    switch (event.key) {
      case 'ArrowDown':
        focusRow(entryRows[index + 1]?.path);
        break;
      case 'ArrowUp':
        focusRow(entryRows[index - 1]?.path);
        break;
      case 'Home':
        focusRow(entryRows[0]?.path);
        break;
      case 'End':
        focusRow(entryRows.at(-1)?.path);
        break;
      case 'ArrowRight':
        if (entry.kind !== 'dir') break;
        if (!row.expanded) expand(entry.path);
        else {
          const child = entryRows[index + 1];
          if (child && child.level === row.level + 1) focusRow(child.path);
        }
        break;
      case 'ArrowLeft':
        if (entry.kind === 'dir' && row.expanded) collapse(entry.path);
        else {
          const parent = ancestorsOf(entry.path).at(-1);
          if (parent !== undefined) focusRow(parent);
        }
        break;
      case 'Enter':
        openEntry(entry);
        break;
      case 'F2':
        if (!isEntryWritable(entry, entry.path, writeCtx)) return;
        setDialog({ kind: 'name', mode: { kind: 'rename', entry } });
        break;
      case 'Delete':
        if (!isEntryWritable(entry, entry.path, writeCtx)) return;
        setDialog({ kind: 'delete', entry });
        break;
      case 'ContextMenu':
        openMenuAtRow(row);
        break;
      case 'F10':
        if (!event.shiftKey) return;
        openMenuAtRow(row);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // ---- drag and drop (uploads)

  const dropDirFor = (target: EventTarget | null): string => {
    const node = target instanceof Element ? target.closest<HTMLElement>('[data-row-path]') : null;
    if (!node) return '';
    const row = rows.find((r) => r.kind === 'entry' && r.path === node.dataset['rowPath']);
    return row ? targetDirOf(row) : '';
  };

  const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files');

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(event)) return;
    // Always take the event: a file dropped next to the tree must not make the browser navigate away from the app.
    event.preventDefault();
    const dir = dropDirFor(event.target);
    const allowed = dirWritable(dir);
    event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
    setDropTarget(allowed ? dir : null);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDropTarget(null);
    const dir = dropDirFor(event.target);
    if (!dirWritable(dir)) return;
    // SYNCHRONOUSLY, before anything awaits: the browser empties the DataTransfer after this handler (transfer.md §1.9).
    const source = collectDrop(event.dataTransfer);
    if (source) startUpload(dir, source);
  };

  // ---- rendering

  const rootLabel = root.kind === 'main' ? t('root.main') : worktreeRootLabel(root, worktrees, member?.userId ?? null, sessionsById);
  const canWriteRoot = dirWritable('');
  // Where the header's "New file" / "New folder" / upload go: the folder of the row the person focused, and the root
  // until they focused one. (Not `effectiveFocus`: with nothing chosen that is the first row, only the keyboard's
  // starting point; for the host the first row is the folder `.smurg`, smurg's own.)
  const headerTarget = (): string => {
    const row = focusedPath === null ? null : (rows.find((r) => r.kind === 'entry' && r.path === focusedPath) ?? null);
    const dir = targetDirOf(row);
    return dirWritable(dir) ? dir : '';
  };

  const actions = (
    <>
      {canWriteRoot ? (
        <>
          <IconButton label={t('action.newFile')} icon={<IconPlus />} size="sm" onClick={() => setDialog({ kind: 'name', mode: { kind: 'create', entryKind: 'file', parent: headerTarget() } })} />
          <IconButton label={t('action.newFolder')} icon={<IconFolder />} size="sm" onClick={() => setDialog({ kind: 'name', mode: { kind: 'create', entryKind: 'dir', parent: headerTarget() } })} />
          <Menu
            label={t('action.upload')}
            icon={<IconUpload />}
            size="sm"
            items={[
              { id: 'files', label: t('action.uploadFiles'), onSelect: () => pickUpload(headerTarget(), false) },
              { id: 'folder', label: t('action.uploadFolder'), onSelect: () => pickUpload(headerTarget(), true) },
            ]}
          />
        </>
      ) : null}
      <IconButton label={t('action.refresh')} icon={<IconRefresh />} size="sm" onClick={() => void files.loadDir(root, '', { force: true }).catch(() => {})} />
    </>
  );

  let body;
  if (rootListing === undefined || (rootListing.status === 'loading' && rootListing.entries.length === 0)) {
    body = (
      <div className="files-status">
        <Spinner label={t('loading')} />
      </div>
    );
  } else if (rootListing.status === 'error' && rootListing.entries.length === 0) {
    body = (
      <Banner tone="danger" live="alert" actions={<Button size="sm" onClick={() => void files.loadDir(root, '', { force: true }).catch(() => {})}>{t('action.retry')}</Button>}>
        {t('error.list', { message: rootListing.error ?? '' })}
      </Banner>
    );
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        compact
        title={t('emptyRoot')}
        action={canWriteRoot ? <Button size="sm" icon={<IconPlus />} onClick={() => setDialog({ kind: 'name', mode: { kind: 'create', entryKind: 'file', parent: '' } })}>{t('action.newFile')}</Button> : undefined}
      />
    );
  } else {
    body = (
      <div
        ref={tree}
        role="tree"
        aria-label={t('treeLabel', { root: rootLabel })}
        className="files-tree"
        data-drop-target={dropTarget === '' ? 'root' : undefined}
      >
        {rows.map((row, index) =>
          row.kind === 'entry' && row.entry ? (
            <TreeItem
              key={`${row.path}\u0000entry`}
              id={`${idBase}-row-${index}`}
              row={row}
              entry={row.entry}
              focused={row.path === effectiveFocus}
              active={activeDoc !== undefined && fileRefKey(activeDoc.file) === fileRefKey({ root, path: row.path })}
              dropTarget={dropTarget === row.path}
              badges={entryBadges(row.entry, { lock: liveLockOf(row.path), now, selfUserId: member?.userId ?? null, isHost: caps.isHost })}
              onFocus={() => setFocusedPath(row.path)}
              onClick={() => {
                setFocusedPath(row.path);
                if (row.entry) openEntry(row.entry);
              }}
              onKeyDown={(event) => onRowKeyDown(event, row)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setFocusedPath(row.path);
                setMenu({ x: event.clientX, y: event.clientY, row });
              }}
            />
          ) : (
            <StatusRow key={`${row.path}\u0000${row.kind}`} row={row} onRetry={() => void files.loadDir(root, row.path, { force: true }).catch(() => {})} />
          ),
        )}
      </div>
    );
  }

  return (
    <Panel title={t('title')} icon={<IconFolder />} actions={actions} className="files-panel">
      <div
        className="files-body"
        data-drop-target={dropTarget === '' ? 'root' : undefined}
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null);
        }}
        onDrop={onDrop}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, row: null });
        }}
      >
        <div className="files-root" title={rootLabel}>
          {root.kind === 'main' ? <IconFolderOpen size={12} /> : <IconAgent size={12} />}
          <span>{rootLabel}</span>
        </div>
        {body}
        {dropTarget !== null ? (
          <div className="files-drop-hint" role="status">
            {dropTarget === '' ? t('drop.hintRoot') : t('drop.hint', { folder: dropTarget })}
          </div>
        ) : null}
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const picked = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = '';
          if (picked.length > 0) startUpload(uploadTarget.current, { kind: 'files', files: picked });
        }}
      />
      <input
        ref={(node) => {
          folderInput.current = node;
          if (node) node.webkitdirectory = true;
        }}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const picked = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = '';
          if (picked.length > 0) startUpload(uploadTarget.current, { kind: 'files', files: picked });
        }}
      />
      {menu ? (
        <ContextMenu
          label={menu.row?.entry ? t('menuLabel', { name: menu.row.entry.name }) : t('menuLabelRoot')}
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.row)}
          onClose={(refocus) => {
            const row = menu.row;
            setMenu(null);
            if (refocus && row) focusRow(row.path);
          }}
        />
      ) : null}
      {dialog?.kind === 'name' ? (
        <NameDialog
          mode={dialog.mode}
          siblings={siblingsOf(dialog.mode.kind === 'rename' ? (ancestorsOf(dialog.mode.entry.path).at(-1) ?? '') : dialog.mode.parent)}
          isHost={caps.isHost}
          onSubmit={(path) => (dialog.mode.kind === 'rename' ? renameEntry(dialog.mode.entry, path) : createEntry(dialog.mode, path))}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'force-release' ? <ForceReleaseDialog file={dialog.file} lock={dialog.lock} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'delete' ? (
        <DeleteDialog
          entry={dialog.entry}
          people={peopleUsing(stores.presence.getState(), locksState, root, dialog.entry.path, member?.userId ?? null)}
          onConfirm={() => deleteEntry(dialog.entry)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </Panel>
  );
}

function worktreeRootLabel(
  root: Extract<RootRef, { kind: 'worktree' }>,
  worktrees: readonly WorktreeInfo[],
  selfUserId: string | null,
  sessions: ReadonlyMap<string, SessionInfo>,
): string {
  const worktree = worktrees.find((w) => w.id === root.worktreeId);
  return worktree ? worktreeLabel(worktree, { selfUserId, sessions }) : t('root.worktree', { name: root.worktreeId });
}

interface TreeItemProps {
  readonly id: string;
  readonly row: TreeRow;
  readonly entry: FileEntry;
  readonly focused: boolean;
  readonly active: boolean;
  readonly dropTarget: boolean;
  readonly badges: readonly EntryBadge[];
  onFocus(): void;
  onClick(): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onContextMenu(event: MouseEvent<HTMLDivElement>): void;
}

function TreeItem({ id, row, entry, focused, active, dropTarget, badges, onFocus, onClick, onKeyDown, onContextMenu }: TreeItemProps) {
  const isDir = entry.kind === 'dir';
  const labels = badges.map((badge) => badge.label).join(t('list.sentence'));
  return (
    <div
      id={id}
      role="treeitem"
      tabIndex={focused ? 0 : -1}
      aria-level={row.level}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-expanded={isDir ? row.expanded : undefined}
      aria-selected={focused}
      aria-current={active ? 'true' : undefined}
      aria-description={labels === '' ? undefined : labels}
      data-row-path={row.path}
      data-drop-target={dropTarget || undefined}
      className="files-row"
      style={{ paddingInlineStart: `calc(${row.level - 1} * 12px + var(--space-3))` }}
      onFocus={onFocus}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
    >
      <span className="files-row__twisty" aria-hidden="true">
        {isDir ? row.expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} /> : null}
      </span>
      <span className="files-row__icon" aria-hidden="true">
        {isDir ? row.expanded ? <IconFolderOpen size={14} /> : <IconFolder size={14} /> : entry.kind === 'symlink' ? <IconLink size={14} /> : <IconFile size={14} />}
      </span>
      <span className="files-row__name">{entry.name}</span>
      {badges.map((badge) => (
        // The row's aria-description already reads every badge's full sentence; these are the visual form.
        <span key={badge.kind} className={`files-badge files-badge--${badge.kind}`} title={badge.label} aria-hidden="true" data-badge={badge.kind}>
          {badge.kind === 'agent-lock' ? (
            <IconAgent size={12} />
          ) : badge.kind === 'human-lock' ? (
            <IconLock size={12} />
          ) : badge.kind === 'read-only' || badge.kind === 'host-only' ? (
            <IconEye size={12} />
          ) : (
            <span className="files-badge__dot" />
          )}
          {badge.text === '' ? null : <span className="files-badge__text">{badge.text}</span>}
        </span>
      ))}
    </div>
  );
}

function StatusRow({ row, onRetry }: { row: TreeRow; onRetry(): void }) {
  const indent = { paddingInlineStart: `calc(${row.level - 1} * 12px + var(--space-3) + 16px)` };
  switch (row.kind) {
    case 'loading':
      return (
        <div role="none" className="files-row files-row--status" style={indent}>
          <Spinner size={12} label={t('loadingFolder', { name: baseNameOfRelPath(row.path) })} />
        </div>
      );
    case 'error':
      return (
        <div role="none" className="files-row files-row--status files-row--error" style={indent}>
          <span>{t('error.folder')}</span>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            {t('action.retry')}
          </Button>
        </div>
      );
    case 'empty':
      return (
        <div role="none" className="files-row files-row--status" style={indent}>
          {t('emptyFolder')}
        </div>
      );
    default:
      return (
        <div role="none" className="files-row files-row--status" style={indent}>
          {t('truncated')}
        </div>
      );
  }
}
