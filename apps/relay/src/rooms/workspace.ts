// WorkspaceDO: one per workspace id. Interactive traffic (editing, terminals, presence), host liveness, and the
// workspace's owner record: only the owner may open host sockets (here and, via getOwner, on the TransferDO).
import { RELAY_USER_ID_PATTERN, isWorkspaceId } from '@smurg/protocol/relay';
import { errorResponse } from '../lib/http.ts';
import type { Admission } from './internal.ts';
import { KV, RelayRoom } from './room.ts';

const KV_CREATED_AT = 'createdAt';

export type ClaimResult = 'created' | 'owned' | 'taken';

export class WorkspaceDO extends RelayRoom {
  protected readonly source = 'WorkspaceDO';
  protected readonly watchHost = true;

  /** POST /api/workspaces: the first caller becomes the owner; the owner may repeat the claim. */
  async claim(workspaceId: string, userId: string): Promise<ClaimResult> {
    if (!isWorkspaceId(workspaceId) || !RELAY_USER_ID_PATTERN.test(userId)) throw new TypeError('invalid claim');
    const owner = this.kv.get<string>(KV.owner);
    if (owner === undefined) {
      this.kv.put(KV.owner, userId);
      this.kv.put(KV.workspaceId, workspaceId);
      this.kv.put(KV_CREATED_AT, Date.now());
      return 'created';
    }
    return owner === userId ? 'owned' : 'taken';
  }

  async getOwner(): Promise<string | null> {
    return this.kv.get<string>(KV.owner) ?? null;
  }

  protected admit(admission: Admission): Response | null {
    const owner = this.kv.get<string>(KV.owner);
    // Unclaimed ids are refused for clients too, so arbitrary ids cannot be used to create relay state.
    if (owner === undefined) return errorResponse(404, 'unknown_workspace');
    if (admission.role === 'host' && admission.userId !== owner) return errorResponse(403, 'not_owner');
    return null;
  }
}
