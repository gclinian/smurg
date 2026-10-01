// Request routing for everything the Worker serves before static assets (RELAY_WORKER_FIRST_PATTERNS).
import {
  RELAY_AUTH_PROVIDERS,
  RELAY_PATHS,
  authCallbackPath,
  authLoginPath,
  matchTunnelPath,
} from '@smurg/protocol/relay';
import { handleCreateWorkspace, handleIdentityToken, handleJwks, handleRoomDebug } from './api.ts';
import { handleDeviceDebug, handleDevicePage, handleDeviceStart, handleDeviceToken } from './auth/device.ts';
import { SigningKeyError, signingKeys } from './auth/keys.ts';
import { handleCallback, handleDevStart, handleDevToken, handleLogin, handleLoginOptions, handleLogout, handleMe } from './auth/routes.ts';
import type { RequestContext } from './context.ts';
import { RelayConfigError, parseRelayConfig, parseRoomConfig, type RelayConfig } from './lib/config.ts';
import { DEVICE_DEBUG_PATH } from './lib/device.ts';
import { errorResponse, textResponse } from './lib/http.ts';
import { postTap } from './lib/tap.ts';
import { ROOM_DEBUG_PATH } from './rooms/inspection.ts';
import { handleTunnel } from './tunnel.ts';

const configCache = new WeakMap<object, RelayConfig>();

function relayConfig(env: Env): RelayConfig {
  let config = configCache.get(env);
  if (!config) {
    config = parseRelayConfig(env);
    configCache.set(env, config);
  }
  return config;
}

export async function handleRequest(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  tapRequest(req, url, env, exec);
  if (url.pathname === RELAY_PATHS.healthz) {
    return req.method === 'GET' || req.method === 'HEAD' ? textResponse('ok\n') : errorResponse(405, 'method_not_allowed');
  }

  let config: RelayConfig;
  try {
    config = relayConfig(env);
  } catch (error) {
    console.error(`relay configuration: ${error instanceof RelayConfigError ? error.message : 'invalid'}`);
    return errorResponse(500, 'server_misconfigured');
  }
  const ctx: RequestContext = { req, url, env, config, keys: () => signingKeys(env.RELAY_SIGNING_KEY) };
  try {
    return await route(ctx);
  } catch (error) {
    if (error instanceof SigningKeyError) {
      console.error(`relay signing key: ${error.message}`);
      return errorResponse(500, 'server_misconfigured');
    }
    console.error(`relay: unhandled error on ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
    return errorResponse(500, 'internal');
  }
}

async function route(ctx: RequestContext): Promise<Response> {
  const path = ctx.url.pathname;
  const tunnel = matchTunnelPath(path);
  if (tunnel) return handleTunnel(ctx, tunnel);
  switch (path) {
    case RELAY_PATHS.jwks:
      return handleJwks(ctx);
    case RELAY_PATHS.me:
      return handleMe(ctx);
    case RELAY_PATHS.loginOptions:
      return handleLoginOptions(ctx);
    case RELAY_PATHS.workspaces:
      return handleCreateWorkspace(ctx);
    case RELAY_PATHS.identityToken:
      return handleIdentityToken(ctx);
    case RELAY_PATHS.devStart:
      return handleDevStart(ctx);
    case RELAY_PATHS.devToken:
      return handleDevToken(ctx);
    case RELAY_PATHS.device:
      return handleDevicePage(ctx);
    case RELAY_PATHS.deviceStart:
      return handleDeviceStart(ctx);
    case RELAY_PATHS.deviceToken:
      return handleDeviceToken(ctx);
    case RELAY_PATHS.logout:
      return handleLogout(ctx);
    case ROOM_DEBUG_PATH:
      return handleRoomDebug(ctx);
    case DEVICE_DEBUG_PATH:
      return handleDeviceDebug(ctx);
  }
  for (const provider of RELAY_AUTH_PROVIDERS) {
    if (path === authLoginPath(provider)) return handleLogin(ctx, provider);
    if (path === authCallbackPath(provider)) return handleCallback(ctx, provider);
  }
  return errorResponse(404, 'not_found');
}

/** TEST-ONLY (R3): the request line and headers of every request, i.e. what the relay sees before any frame. */
function tapRequest(req: Request, url: URL, env: Env, exec: ExecutionContext): void {
  const tapUrl = parseRoomConfig(env).tapUrl;
  if (!tapUrl) return;
  const meta = JSON.stringify({ method: req.method, url: req.url, headers: Object.fromEntries(req.headers) });
  exec.waitUntil(
    postTap(
      tapUrl,
      {
        source: 'worker',
        direction: 'request',
        role: 'none',
        conn: 0,
        kind: 'request',
        workspaceId: matchTunnelPath(url.pathname)?.workspaceId ?? '',
        seq: 0,
      },
      meta,
    ),
  );
}
