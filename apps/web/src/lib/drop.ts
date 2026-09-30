// Collects what a drag-and-drop carries into an UploadSource for the `startUpload` command (transfer.md §1.9).
// MUST be called synchronously inside the `drop` handler: after the first await the DataTransfer is emptied.
//
//   onDrop={(event) => { event.preventDefault(); const source = collectDrop(event.dataTransfer);
//                        if (source) void startUpload({ root, targetDir, source }); }}
import type { UploadSource } from './commands.ts';

type ItemWithHandle = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };

export function collectDrop(dataTransfer: DataTransfer | null): Extract<UploadSource, { kind: 'drop' }> | null {
  if (!dataTransfer) return null;
  const entries: FileSystemEntry[] = [];
  const handles: Promise<FileSystemHandle | null>[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue;
    // Chromium only; keeps a handle that can be stored for resuming after a reload.
    const withHandle = item as ItemWithHandle;
    if (typeof withHandle.getAsFileSystemHandle === 'function') handles.push(withHandle.getAsFileSystemHandle().catch(() => null));
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  if (entries.length === 0 && handles.length === 0) return null;
  return { kind: 'drop', entries, handles };
}
