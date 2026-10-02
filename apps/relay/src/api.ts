// Authenticated JSON API: workspace ownership, identity tokens, the relay's public keys.
import { isWorkspaceId } from '@smurg/protocol/relay';
import { identityClaims } from './auth/identity.ts';
import { requireAuth } from './auth/session.ts';
import { IDENTITY_CNF_MEMBER, IDENTITY_TOKEN_TTL_SECONDS, identityTokenKind, signToken } from './auth/tokens.ts';
import type { RequestContext } from './context.ts';
import { randomToken } from './lib/base64url.ts';
import { devLoginEnabled } from './lib/config.ts';
import { errorResponse, isRecord, jsonResponse, readJsonBody } from './lib/http.ts';
import { CNF_PATTERN } from './lib/validate.ts';

/**
 * POST /api/workspaces [{ workspaceId? }] → 201 { workspaceId, created: true } | 200 { …, created: false } | 409.
 * Without an id the relay picks a random one (128 bits). The caller becomes the owner; only the owner may open host
 * sockets for it. Claiming an id you already own is idempotent.
 */
export async function handleCreateWorkspace(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method !== 'POST') return errorResponse(405, 'method_not_allowed');
  const auth = await requireAuth(ctx, { originCheck: true });
  if (auth instanceof Response) return auth;
  const body = await readJsonBody(ctx.req, { optional: true });
  if (!body.ok) return body.response;
  let workspaceId = randomToken(16);
  if (body.value !== undefined) {
    if (!isRecord(body.value)) return errorResponse(400, 'bad_request');
    const requested = body.value['workspaceId'];
    if (requested !== undefined) {
      if (!isWorkspaceId(requested)) return errorResponse(400, 'invalid_workspace_id', 'expected [A-Za-z0-9_-]{16,64}');
      workspaceId = requested;
    }
  }
  const result = await ctx.env.WORKSPACE.getByName(workspaceId).claim(workspaceId, auth.identity.userId);
  if (result === 'taken') return errorResponse(409, 'workspace_taken');
  return jsonResponse({ workspaceId, created: result === 'created' }, result === 'created' ? 201 : 200);
}

/**
 * POST /api/identity-token { workspaceId, cnf } → { token, expiresIn }.
 * An EdDSA JWT (typ smurg-identity+jwt, aud smurg-daemon:<workspaceId>, 5 minutes) that the client forwards inside
 * the encrypted channel. `cnf` is the blinded commitment to the device key (ARCHITECTURE §4.2): the relay never
 * learns a stable device id, and the daemon checks the commitment against the authenticated Noise static key.
 */
export async function handleIdentityToken(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method !== 'POST') return errorResponse(405, 'method_not_allowed');
  const auth = await requireAuth(ctx, { originCheck: true });
  if (auth instanceof Response) return auth;
  const body = await readJsonBody(ctx.req);
  if (!body.ok) return body.response;
  if (!isRecord(body.value)) return errorResponse(400, 'bad_request');
  const { workspaceId, cnf } = body.value;
  if (!isWorkspaceId(workspaceId)) return errorResponse(400, 'invalid_workspace_id', 'expected [A-Za-z0-9_-]{16,64}');
  if (typeof cnf !== 'string' || !CNF_PATTERN.test(cnf)) {
    return errorResponse(400, 'invalid_cnf', 'cnf must be base64url(SHA-256(...)) without padding');
  }
  const token = await signToken(await ctx.keys(), ctx.config.issuer, identityTokenKind(workspaceId), {
    ...identityClaims(auth.identity),
    cnf: { [IDENTITY_CNF_MEMBER]: cnf },
  });
  return jsonResponse({ token, expiresIn: IDENTITY_TOKEN_TTL_SECONDS });
}

/** GET /.well-known/jwks.json: public keys only (kid = RFC 7638 thumbprint). */
export async function handleJwks(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return errorResponse(405, 'method_not_allowed');
  const keys = await ctx.keys();
  return new Response(JSON.stringify(keys.jwks), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Daemons cache it; a rotated key is published next to the old one before it signs anything.
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      // The daemon checks identity-token times against the relay's clock, estimated from this header:
      // set it explicitly rather than relying on the platform to add one.
      date: new Date().toUTCString(),
    },
  });
}

/**
 * GET /api/debug/room?kind=ws|xfer&workspaceId=… → the room's inspect() result. Only when DEV_LOGIN=1 and the
 * hostname is local, otherwise 404. It goes through the Worker (not a test-held RPC stub) because a stub held by the
 * test process keeps the object referenced and makes forced hibernation time out.
 */
export async function handleRoomDebug(ctx: RequestContext): Promise<Response> {
  if (!devLoginEnabled(ctx.config, ctx.url)) return errorResponse(404, 'not_found');
  if (ctx.req.method !== 'GET') return errorResponse(405, 'method_not_allowed');
  const kind = ctx.url.searchParams.get('kind');
  const workspaceId = ctx.url.searchParams.get('workspaceId');
  if ((kind !== 'ws' && kind !== 'xfer') || !isWorkspaceId(workspaceId)) return errorResponse(400, 'bad_request');
  const namespace = kind === 'ws' ? ctx.env.WORKSPACE : ctx.env.TRANSFER;
  return jsonResponse(await namespace.getByName(workspaceId).inspect());
}
