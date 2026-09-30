// The invite fragment captured at startup (boot/capture-invite.ts), read back and parsed STRICTLY with the
// protocol's parser: exactly `k` and `s`, each once, each 43 characters of canonical base64url for 32 bytes. Anything
// else is rejected, never repaired (a "fixed" link could point at a key the host never printed).
import { parseInviteFragment } from '@smurg/protocol';
import type { InviteTrust } from '@smurg/protocol/client';
import { PENDING_INVITE_KEY_PREFIX, clearInMemoryInvite, peekInMemoryInvite } from '../../boot/capture-invite.ts';

export type PendingInvite =
  | { readonly kind: 'none' }
  /** A fragment was there but is not a valid invite. */
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok'; readonly invite: InviteTrust };

export type InviteStorage = Pick<Storage, 'getItem' | 'removeItem'>;

export function pendingInviteKey(workspaceId: string): string {
  return PENDING_INVITE_KEY_PREFIX + workspaceId;
}

export function parsePendingFragment(fragment: string | null): PendingInvite {
  if (fragment === null) return { kind: 'none' };
  try {
    const { fingerprint, secret } = parseInviteFragment(fragment);
    return { kind: 'ok', invite: { fingerprint, secret } };
  } catch {
    return { kind: 'invalid' };
  }
}

export function readPendingInvite(storage: InviteStorage | null, workspaceId: string): PendingInvite {
  let stored: string | null = null;
  try {
    stored = storage?.getItem(pendingInviteKey(workspaceId)) ?? null;
  } catch {
    stored = null;
  }
  return parsePendingFragment(stored ?? peekInMemoryInvite(workspaceId));
}

/** Forget the invite (joined, refused, or abandoned): the secret should not outlive its use. */
export function clearPendingInvite(storage: InviteStorage | null, workspaceId: string): void {
  clearInMemoryInvite(workspaceId);
  try {
    storage?.removeItem(pendingInviteKey(workspaceId));
  } catch {
    // Storage unavailable: nothing was stored there either.
  }
}
