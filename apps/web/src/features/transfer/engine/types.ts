// What the transfer engine (in the Worker) reports about each job, and how it describes failures. The engine never
// formats text for people: it reports structured facts (a disk report, a daemon error code and reason, the local
// cause) and the UI turns them into zh-TW (ui/describe.ts). Everything here is structured-cloneable.
import type { DiskReport, ErrorPayload, RootRef } from '@smurg/protocol';
import type { TransferStatus } from '../../../lib/stores/transfers.ts';

export type JobKind = 'upload' | 'download';

/** Why a job is not running although it is not finished. */
export type PauseCause =
  /** The person paused it. */
  | 'user'
  /** The transfer socket is not online; the job resumes by itself when it is. */
  | 'offline'
  /** The page was reloaded: the files must be chosen again (or their handles re-authorised) to continue. */
  | 'reload';

export type UploadConflictPolicy = 'fail' | 'overwrite' | 'rename';

export type TransferFailure =
  /** The host's disk check refused (R7 「磁碟空間不足時，上傳在開始前就被拒絕」): the numbers for the message. */
  | { readonly kind: 'disk'; readonly disk: DiskReport | null; readonly midway: boolean }
  /** The daemon refused (permission, lock, path, name conflict, …). */
  | { readonly kind: 'daemon'; readonly error: ErrorPayload }
  /** The local file changed while it was uploaded (two versions would be mixed). */
  | { readonly kind: 'source-changed'; readonly path: string }
  /** The local file cannot be read any more (moved, deleted, permission lost). */
  | { readonly kind: 'source-unreadable'; readonly path: string }
  /** The transfer connection ended for good (kicked, revoked, key mismatch, login needed). */
  | { readonly kind: 'connection-ended'; readonly state: string }
  /** The person answered 「取消」 to a name conflict. */
  | { readonly kind: 'conflict-declined'; readonly paths: readonly string[] }
  /** Download: the browser storage cannot hold it (OPFS quota, a short write, or above the in-memory limit). */
  | { readonly kind: 'storage'; readonly reason: 'quota' | 'short-write' | 'size-mismatch' | 'too-large-for-memory' | 'write-failed'; readonly neededBytes: number | null; readonly availableBytes: number | null }
  /** The file on the host changed during a resumed download (etag mismatch). */
  | { readonly kind: 'changed-on-host' }
  /** Anything else (a bug, an unexpected exception). */
  | { readonly kind: 'internal'; readonly message: string };

/** One file of an upload that did not make it. */
export interface FileFailure {
  readonly path: string;
  readonly failure: TransferFailure;
}

export interface ConflictQuestion {
  /** The names that already exist on the host (at most 100 listed). */
  readonly paths: readonly string[];
  /** More names than listed. */
  readonly more: number;
}

/** How a finished download was saved. */
export type SavedAs = 'picker' | 'opfs' | 'memory';

export interface DownloadOutcome {
  readonly savedAs: SavedAs;
  /** Zip entries left out or stored empty (`open:ENOENT` = in the zip with 0 bytes). */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  /** The zip needed ZIP64: macOS's built-in extractor may report an error. */
  readonly zip64: boolean;
  readonly totalBytes: number;
}

export interface JobSnapshot {
  readonly id: string;
  readonly kind: JobKind;
  readonly name: string;
  readonly root: RootRef;
  /** Upload: the target directory. Download: the file or folder. */
  readonly path: string;
  readonly totalBytes: number | null;
  readonly doneBytes: number;
  readonly files: number | null;
  readonly filesDone: number;
  readonly status: TransferStatus;
  readonly pause: PauseCause | null;
  /** Upload: checking what the host already has (re-hashing locally) rather than sending. */
  readonly verifying: boolean;
  /** Smoothed transfer rate (bytes per second) while running, else 0. */
  readonly bytesPerSecond: number;
  readonly failure: TransferFailure | null;
  /** Upload files that failed (the others were uploaded). */
  readonly fileFailures: readonly FileFailure[];
  /** Names left out while collecting the drop (invalid, unreadable, duplicate). */
  readonly rejected: readonly { readonly path: string; readonly problem: string }[];
  /** Waiting for the person to choose what to do with existing names. */
  readonly conflict: ConflictQuestion | null;
  readonly download: DownloadOutcome | null;
  readonly startedAt: number;
}

export const MAX_LISTED_CONFLICTS = 100;
