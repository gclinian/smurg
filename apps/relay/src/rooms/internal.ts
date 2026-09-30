// Contract between the Worker and its Durable Objects. Only the Worker can reach a Durable Object, and it always
// replaces these headers with values taken from a verified session; the room still re-validates them (fail closed).
import {
  RELAY_USER_ID_PATTERN,
  isWorkspaceId,
  relayAvatarUrlSchema,
  relayDisplayNameSchema,
  type RelayTunnelRole,
} from '@smurg/protocol/relay';

export const ROOM_HEADERS = {
  role: 'x-smurg-role',
  userId: 'x-smurg-user',
  /** encodeURIComponent(displayName): header values must be ByteStrings. */
  displayName: 'x-smurg-name',
  avatarUrl: 'x-smurg-avatar',
  workspaceId: 'x-smurg-workspace',
  /** TransferDO only: the owner the Worker read from the WorkspaceDO. */
  verifiedOwner: 'x-smurg-verified-owner',
} as const;

export type Admission = {
  role: RelayTunnelRole;
  userId: string;
  displayName: string;
  avatarUrl?: string;
  workspaceId: string;
  verifiedOwner: string | null;
};

export function readAdmission(headers: Headers): Admission | null {
  const role = headers.get(ROOM_HEADERS.role);
  const userId = headers.get(ROOM_HEADERS.userId) ?? '';
  const workspaceId = headers.get(ROOM_HEADERS.workspaceId) ?? '';
  const displayName = decodeHeader(headers.get(ROOM_HEADERS.displayName));
  const avatarUrl = decodeHeader(headers.get(ROOM_HEADERS.avatarUrl));
  const verifiedOwner = headers.get(ROOM_HEADERS.verifiedOwner);
  if (role !== 'host' && role !== 'client') return null;
  if (!RELAY_USER_ID_PATTERN.test(userId) || !isWorkspaceId(workspaceId)) return null;
  if (displayName === null || !relayDisplayNameSchema.safeParse(displayName).success) return null;
  if (verifiedOwner !== null && !RELAY_USER_ID_PATTERN.test(verifiedOwner)) return null;
  const admission: Admission = { role, userId, displayName, workspaceId, verifiedOwner };
  if (avatarUrl !== null) {
    if (!relayAvatarUrlSchema.safeParse(avatarUrl).success) return null;
    admission.avatarUrl = avatarUrl;
  }
  return admission;
}

function decodeHeader(value: string | null): string | null {
  if (value === null) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
