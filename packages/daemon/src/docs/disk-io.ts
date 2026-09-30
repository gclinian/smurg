// Guarded disk I/O for documents. PathGuard is asked again before EVERY read and write (ARCHITECTURE §7.4): a guest
// can swap a parent directory for a symlink at any time, and the daemon is not sandboxed (yjs-monaco.md V2). A read
// additionally requires the path to resolve to the SAME real file the room was opened for: anything else (a link
// swapped in, even one that stays inside the share) is a different file and must not flow into this document.
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { SmurgError, type FileRef } from '@smurg/protocol';
import { isPathDeniedError } from '../core/errors.ts';
import type { FileIdentity, PathGuard, Principal } from '../core/interfaces.ts';

export type DiskRead =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array; readonly identity: FileIdentity; readonly hash: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'denied'; readonly reason: string }
  | { readonly kind: 'too-large' };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Reads the document's file: resolve (containment, same real path), open O_NOFOLLOW + fstat (PathGuard.openRead), read
 * at most `maxBytes`. File-system states become a DiskRead; only unexpected errors throw. Never audits (the caller
 * decides whether a denial is news).
 */
export async function readDocFile(paths: PathGuard, ref: FileRef, realPath: string, principal: Principal, maxBytes: number): Promise<DiskRead> {
  const options = { principal, mustExist: true, audit: false } as const;
  try {
    const resolved = await paths.resolve(ref, options);
    if (resolved.realPath !== realPath) return { kind: 'denied', reason: 'changed' };
    if (resolved.identity === null || resolved.identity.kind !== 'file') return { kind: 'missing' };
    if (resolved.identity.size > maxBytes) return { kind: 'too-large' };
    const file = await paths.openRead(resolved, options);
    try {
      const bytes = await readBounded(file.handle, file.identity.size, maxBytes);
      if (bytes === null) return { kind: 'too-large' };
      return { kind: 'ok', bytes, identity: file.identity, hash: sha256Hex(bytes) };
    } finally {
      await file.close();
    }
  } catch (err) {
    if (isPathDeniedError(err)) return { kind: 'denied', reason: err.reason };
    if (err instanceof SmurgError && (err.code === 'not_found' || err.code === 'bad_request')) return { kind: 'missing' };
    throw err;
  }
}

/** The whole file, or null when it holds more than `maxBytes` (it may have grown since fstat). */
export async function readBounded(handle: FileHandle, size: number, maxBytes: number): Promise<Uint8Array | null> {
  const buffer = Buffer.alloc(Math.min(size, maxBytes) + 1);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  if (filled > maxBytes) return null;
  if (filled < buffer.length) return new Uint8Array(buffer.buffer, buffer.byteOffset, filled);
  // Grew past its fstat size but is still under the limit: read the rest.
  const chunks: Buffer[] = [buffer.subarray(0, filled)];
  let total = filled;
  for (;;) {
    const chunk = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) return null;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks);
}

/** Whether `principal` may write `ref` (host-only, read-only, hidden), without auditing the probe. */
export async function mayWrite(paths: PathGuard, ref: FileRef, principal: Principal): Promise<boolean> {
  try {
    await paths.resolve(ref, { principal, forWrite: true, audit: false });
    return true;
  } catch (err) {
    if (isPathDeniedError(err) || err instanceof SmurgError) return false;
    throw err;
  }
}
