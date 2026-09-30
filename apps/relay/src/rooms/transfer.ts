// TransferDO: one per workspace id, file chunks only. A separate object and a separate host socket keep multi-MiB
// frames from queueing in front of keystrokes and terminal output (relay.md V14). No host-liveness alarm here; the
// WorkspaceDO owns that.
import { errorResponse } from '../lib/http.ts';
import type { Admission } from './internal.ts';
import { RelayRoom } from './room.ts';

export class TransferDO extends RelayRoom {
  protected readonly source = 'TransferDO';
  protected readonly watchHost = false;

  /**
   * The owner record lives in the WorkspaceDO; the Worker reads it (getOwner RPC) and passes it along. A request
   * without it is refused, so a routing mistake cannot open an unchecked host socket.
   */
  protected admit(admission: Admission): Response | null {
    if (admission.verifiedOwner === null) return errorResponse(403, 'not_owner');
    if (admission.role === 'host' && admission.userId !== admission.verifiedOwner) return errorResponse(403, 'not_owner');
    return null;
  }
}
