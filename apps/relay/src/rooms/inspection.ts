// Shape returned by the rooms' `inspect()` RPC. Kept free of Worker imports so Node test code can use the type.
import type { RelayHostOfflineReason } from '@smurg/protocol/relay';

export type RoomInspection = {
  source: 'WorkspaceDO' | 'TransferDO';
  /** Changes whenever the object is re-created (after hibernation or eviction). */
  bootedAt: number;
  workspaceId: string | null;
  owner: string | null;
  hostStatus: 'online' | 'offline';
  hostEpoch: number;
  hostOfflineReason: RelayHostOfflineReason | null;
  hostLastSeen: number | null;
  clients: { conn: number; userId: string; lastSeen: number }[];
  alarm: number | null;
  nextConn: number | null;
};

/** Dev-only route (DEV_LOGIN=1 and a local hostname) that returns a room's RoomInspection; used by the tests. */
export const ROOM_DEBUG_PATH = '/api/debug/room';
