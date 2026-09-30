// WebSocket tunnels: /ws/<id>/(host|client) → WorkspaceDO, /xfer/<id>/(host|client) → TransferDO.
// The Worker authenticates (and applies the Origin allow-list to cookie sessions); the room enforces ownership, caps
// and everything that needs its state.
import type { RelayTunnelRoute } from '@smurg/protocol/relay';
import { requireAuth } from './auth/session.ts';
import type { RequestContext } from './context.ts';
import { errorResponse } from './lib/http.ts';
import { ROOM_HEADERS } from './rooms/internal.ts';

export async function handleTunnel(ctx: RequestContext, route: RelayTunnelRoute): Promise<Response> {
  if (ctx.req.method !== 'GET') return errorResponse(405, 'method_not_allowed');
  if (ctx.req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return errorResponse(426, 'upgrade_required');
  // Browsers cannot put a bearer token on a WebSocket, so they use the cookie, which needs the Origin check
  // (cross-site WebSocket hijacking). CLI and daemon use bearer tokens.
  const auth = await requireAuth(ctx, { originCheck: true });
  if (auth instanceof Response) return auth;
  const { identity } = auth;

  let verifiedOwner: string | null = null;
  if (route.kind === 'xfer') {
    const owner = await ctx.env.WORKSPACE.getByName(route.workspaceId).getOwner();
    if (owner === null) return errorResponse(404, 'unknown_workspace');
    if (route.role === 'host' && owner !== identity.userId) return errorResponse(403, 'not_owner');
    verifiedOwner = owner;
  }

  const headers = new Headers(ctx.req.headers);
  // Credentials never reach the Durable Object, and nothing named like our internal headers survives from the client.
  headers.delete('cookie');
  headers.delete('authorization');
  for (const name of [...headers.keys()]) if (name.startsWith('x-smurg-')) headers.delete(name);
  headers.set(ROOM_HEADERS.role, route.role);
  headers.set(ROOM_HEADERS.userId, identity.userId);
  headers.set(ROOM_HEADERS.displayName, encodeURIComponent(identity.displayName));
  headers.set(ROOM_HEADERS.workspaceId, route.workspaceId);
  if (identity.avatarUrl) headers.set(ROOM_HEADERS.avatarUrl, encodeURIComponent(identity.avatarUrl));
  if (verifiedOwner !== null) headers.set(ROOM_HEADERS.verifiedOwner, verifiedOwner);

  const namespace = route.kind === 'ws' ? ctx.env.WORKSPACE : ctx.env.TRANSFER;
  return namespace.getByName(route.workspaceId).fetch(new Request(ctx.req.url, { method: 'GET', headers }));
}
