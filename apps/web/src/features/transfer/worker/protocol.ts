// Messages between the page and the transfer Worker. The page only posts File objects (structured clone, transfer.md
// F20) and, in Chromium, FileSystemHandles; it receives snapshots, finished download Blobs and the socket state. The
// Worker owns the TransferConnection, the hashing, the encryption and every byte of file data.
import type { FileRef, RootRef } from '@smurg/protocol';
import type { ManagerEvent, MeasureRequest, TransferManager } from '../engine/manager.ts';
import type { UploadConflictPolicy } from '../engine/types.ts';
import type { UploadItem } from '../engine/upload-job.ts';
import type { SaveHandleLike } from '../engine/writers.ts';

export interface WireItem {
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly file?: File;
}

export type ToWorker =
  | { readonly t: 'init'; readonly workspaceId: string; readonly deviceName: string }
  | {
      readonly t: 'upload';
      readonly id: string;
      readonly root: RootRef;
      readonly targetDir: string;
      readonly name: string;
      readonly items: readonly WireItem[];
      readonly rejected: readonly { readonly path: string; readonly problem: string }[];
      readonly handles?: Readonly<Record<string, FileSystemHandle>>;
    }
  | { readonly t: 'resume-upload'; readonly id: string; readonly items: readonly WireItem[] }
  | { readonly t: 'download'; readonly id: string; readonly file: FileRef; readonly zip: boolean; readonly name: string; readonly picker?: FileSystemFileHandle }
  | { readonly t: 'pause' | 'resume' | 'retry' | 'cancel' | 'forget'; readonly id: string }
  | { readonly t: 'answer'; readonly id: string; readonly policy: UploadConflictPolicy | null }
  | { readonly t: 'measure'; readonly request: MeasureRequest }
  | { readonly t: 'dispose' };

export type FromWorker =
  | ManagerEvent
  | { readonly t: 'ready' }
  /** The Worker cannot run transfers here (no IndexedDB, so no access to this browser's device key). */
  | { readonly t: 'fatal'; readonly reason: 'no-indexeddb' | 'init-failed'; readonly message: string }
  | { readonly t: 'disposed' };

const toItems = (items: readonly WireItem[]): UploadItem[] => items.map((item) => (item.file ? { path: item.path, kind: item.kind, file: item.file } : { path: item.path, kind: item.kind }));

/** Applies one page message to the manager (everything but init / dispose, which the Worker entry handles). */
export function dispatchToManager(manager: TransferManager, message: ToWorker): void {
  switch (message.t) {
    case 'upload':
      manager.upload({
        id: message.id,
        root: message.root,
        targetDir: message.targetDir,
        name: message.name,
        items: toItems(message.items),
        rejected: message.rejected,
        ...(message.handles ? { handles: message.handles } : {}),
      });
      return;
    case 'resume-upload':
      manager.resumeUpload(message.id, toItems(message.items));
      return;
    case 'download':
      manager.download({
        id: message.id,
        file: message.file,
        zip: message.zip,
        name: message.name,
        ...(message.picker ? { picker: message.picker as unknown as SaveHandleLike } : {}),
      });
      return;
    case 'pause':
      manager.pause(message.id);
      return;
    case 'resume':
      manager.resume(message.id);
      return;
    case 'retry':
      manager.retry(message.id);
      return;
    case 'cancel':
      void manager.cancel(message.id);
      return;
    case 'forget':
      manager.forget(message.id);
      return;
    case 'answer':
      manager.answer(message.id, message.policy);
      return;
    case 'measure':
      manager.measure(message.request);
      return;
    case 'init':
    case 'dispose':
      return;
  }
}
