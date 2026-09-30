// `@smurg/relay/testing`: run the real relay (local workerd through wrangler's createTestHarness) inside a test.
//
//   const relay = await startLocalRelay({ tap: true });
//   const alice = await relay.devLogin('alice');
//   const workspaceId = await relay.createWorkspace(alice.token);
//   const host = connectRelaySocket(wsHostUrl(relay.origin, workspaceId), { token: alice.token });
//   …
//   await relay.stop();
//
// Hermetic: a random 127.0.0.1 port, a fresh Ed25519 signing key per relay, every var and secret passed explicitly
// (values from apps/relay/.dev.vars or the process environment are always overridden), no OAuth provider unless the
// test configures one. The harness runs workerd itself; stop() shuts it down. This module spawns no processes; the
// workerd processes the harness starts are registered with the test run (packages/daemon/src/testing/run-registry.ts,
// dependency-free), which ends them after the run if the test's worker died before stop().
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAY_PATHS, relayHttpUrl } from '@smurg/protocol/relay';
import type { TestHarness } from 'wrangler';
import { registerOwnChildren } from '../../../packages/daemon/src/testing/run-registry.ts';
import { ensureWebDist } from '../scripts/ensure-web-dist.ts';
import { generateSigningKey } from '../scripts/signing-key.ts';
import type { RelayVars } from '../src/lib/config.ts';
import { ROOM_DEBUG_PATH, type RoomInspection } from '../src/rooms/inspection.ts';
import { startTapCollector, type RelayTap } from './tap-collector.ts';

export { findPlaintext, MIN_MARKER_BYTES, type PlaintextEncoding } from './plaintext.ts';
export {
  RelaySocket,
  RelayUpgradeError,
  connectRelaySocket,
  type RelaySocketClosed,
  type RelaySocketFrame,
  type RelaySocketOptions,
} from './relay-socket.ts';
export type { RelayTap, TapFrame } from './tap-collector.ts';
export type { RoomInspection } from '../src/rooms/inspection.ts';
/** A fresh Ed25519 private JWK (JSON), e.g. for a relay started with `secrets.RELAY_SIGNING_KEY`. */
export { generateSigningKey } from '../scripts/signing-key.ts';

const RELAY_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

type VarName = Exclude<keyof RelayVars, 'RELAY_SIGNING_KEY' | 'GITHUB_CLIENT_SECRET' | 'GOOGLE_CLIENT_SECRET'>;
type SecretName = 'RELAY_SIGNING_KEY' | 'GITHUB_CLIENT_SECRET' | 'GOOGLE_CLIENT_SECRET';

export type StartLocalRelayOptions = {
  /** Start a local tap collector and point RELAY_TAP_URL at it (R3 byte recording). */
  tap?: boolean;
  /**
   * Var overrides, e.g. `{ HOST_TIMEOUT_MS: '3000' }`, `{ DEV_LOGIN: '0' }`, or a mock IdP's endpoints.
   * RELAY_ISSUER and ALLOWED_ORIGINS default to the relay's own origin.
   */
  vars?: Partial<Record<VarName, string>>;
  /** Secret overrides. RELAY_SIGNING_KEY defaults to a key generated for this relay only. */
  secrets?: Partial<Record<SecretName, string>>;
  /**
   * Serve THIS directory (a `vite build` of apps/web) as the SPA instead of apps/web/dist, exactly as the production
   * Worker serves its assets: the relay's wrangler config is copied into a temp file whose `assets.directory` points
   * here. For browser tests of the BUILT app; apps/web/dist is neither read nor created.
   */
  webDist?: string;
};

export type DevSession = { token: string; userId: string; displayName: string };

export type LocalRelay = {
  /** `http://127.0.0.1:<port>`: base for relayHttpUrl / wsHostUrl / wsClientUrl from @smurg/protocol/relay. */
  origin: string;
  /** `ws://127.0.0.1:<port>` */
  wsOrigin: string;
  /** JWT issuer (= origin unless overridden). */
  issuer: string;
  jwksUrl: string;
  /** The test-only private signing JWK (JSON), e.g. to start a second relay that accepts the same tokens. */
  signingKey: string;
  /** Present when started with `tap: true`. */
  tap: RelayTap | undefined;
  /** Dev-only login (needs DEV_LOGIN=1, the default here): a bearer session token for `dev:<user>`. */
  devLogin(user: string, options?: { displayName?: string }): Promise<DevSession>;
  /** POST /api/workspaces as `token`; returns the claimed (or generated) workspace id. */
  createWorkspace(token: string, workspaceId?: string): Promise<string>;
  /** POST /api/identity-token: the JWT a client forwards to the daemon inside the encrypted channel. */
  identityToken(token: string, workspaceId: string, cnf: string): Promise<string>;
  /** State of a room (its `inspect()` RPC, reached through the dev-only /api/debug/room route: needs DEV_LOGIN=1). */
  inspect(kind: 'ws' | 'xfer', workspaceId: string): Promise<RoomInspection>;
  /**
   * Forces hibernation (`webSockets: "hibernate"`): sockets stay open, in-memory state is dropped. Without
   * `workspaceId` every room that has storage is evicted.
   */
  evictDurableObjects(filter?: { workspaceId?: string; kind?: 'ws' | 'xfer' }): Promise<void>;
  /** harness.fetch: relative URLs resolve against `origin`; an absolute URL sets the hostname the Worker sees. */
  fetch: TestHarness['fetch'];
  /** Escape hatch for wrangler features not wrapped here. */
  harness: TestHarness;
  /** Stops workerd and the tap collector. Idempotent. */
  stop(): Promise<void>;
};


const ROOM_CLASS = { ws: 'WorkspaceDO', xfer: 'TransferDO' } as const;

/** Keep wrangler's metrics, logs and caches inside the repository (ARCHITECTURE §0 rule 4). */
function prepareWranglerEnvironment(): void {
  process.env['XDG_CONFIG_HOME'] ??= join(REPO_ROOT, '.xdg');
  process.env['WRANGLER_SEND_METRICS'] = 'false';
  process.env['WRANGLER_SEND_ERROR_REPORTS'] = 'false';
}

/**
 * `cnf` commitment of ARCHITECTURE §4.2: base64url(SHA-256("smurg-cnf" ‖ n ‖ deviceStaticPublicKey)). Provided for
 * tests; the product implementation belongs to @smurg/protocol.
 */
export function cnfCommitment(nonce: Uint8Array, deviceStaticPublicKey: Uint8Array): string {
  return createHash('sha256').update('smurg-cnf').update(nonce).update(deviceStaticPublicKey).digest('base64url');
}

function defaultVars(origin: string, tapUrl: string): Record<VarName, string> {
  return {
    RELAY_ISSUER: origin,
    ALLOWED_ORIGINS: origin,
    DEV_LOGIN: '1',
    RELAY_TAP_URL: tapUrl,
    HOST_TIMEOUT_MS: '6000',
    CLIENT_SWEEP_MS: '30000',
    MAX_CLIENT_SOCKETS_PER_WORKSPACE: '64',
    MAX_SOCKETS_PER_ACCOUNT: '8',
    // Providers are off unless a test points them at a mock IdP: an empty endpoint disables a provider.
    GITHUB_CLIENT_ID: '',
    GITHUB_AUTHORIZE_URL: '',
    GITHUB_TOKEN_URL: '',
    GITHUB_API_URL: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_AUTHORIZE_URL: '',
    GOOGLE_TOKEN_URL: '',
    GOOGLE_JWKS_URL: '',
    GOOGLE_ISSUER: '',
  };
}

/** JSONC → JSON: comments removed outside of strings (wrangler.jsonc has `//` in URLs inside strings). */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** A copy of wrangler.jsonc (absolute paths) that serves `webDist` as the assets directory; returns its path. */
async function configServing(webDist: string, dir: string): Promise<string> {
  const config = JSON.parse(stripJsonComments(await readFile(join(RELAY_DIR, 'wrangler.jsonc'), 'utf8'))) as Record<string, unknown>;
  delete config['$schema'];
  const main = String(config['main']);
  config['main'] = isAbsolute(main) ? main : join(RELAY_DIR, main);
  config['assets'] = { ...(config['assets'] as Record<string, unknown>), directory: resolve(webDist) };
  const path = join(dir, 'wrangler.json');
  await writeFile(path, JSON.stringify(config, null, 2));
  return path;
}

export async function startLocalRelay(options: StartLocalRelayOptions = {}): Promise<LocalRelay> {
  prepareWranglerEnvironment();
  if (options.webDist === undefined) ensureWebDist();
  const configDir = options.webDist === undefined ? null : await mkdtemp(join(tmpdir(), 'smurg-relay-config-'));
  const configPath = configDir === null ? './wrangler.jsonc' : await configServing(options.webDist as string, configDir);
  const { createTestHarness } = await import('wrangler');
  const collector = options.tap ? await startTapCollector() : undefined;
  const signingKey = options.secrets?.RELAY_SIGNING_KEY ?? (await generateSigningKey());
  const secrets: Record<SecretName, string> = {
    GITHUB_CLIENT_SECRET: '',
    GOOGLE_CLIENT_SECRET: '',
    ...options.secrets,
    RELAY_SIGNING_KEY: signingKey,
  };
  const varsFor = (origin: string) => ({ ...defaultVars(origin, collector?.url ?? ''), ...options.vars });

  // The issuer must equal the URL clients use (OAuth redirect URIs are built from it), and the port is only known
  // after listen(): start, then update the vars; the URL stays the same (relay.md V23).
  const harness = createTestHarness({
    root: RELAY_DIR,
    workers: [{ configPath, env: 'dev', vars: varsFor('http://127.0.0.1'), secrets }],
  });
  let origin: string;
  try {
    const first = await harness.listen();
    origin = first.url.origin;
    await harness.update((current) => ({
      ...current,
      workers: current.workers.map((worker) => ('configPath' in worker ? { ...worker, vars: varsFor(origin) } : worker)),
    }));
    const second = await harness.listen();
    if (second.url.origin !== origin) throw new Error(`relay URL changed after update: ${origin} -> ${second.url.origin}`);
    await registerOwnChildren('/bin/workerd ');
  } catch (error) {
    await harness.close().catch(() => undefined);
    await collector?.close();
    if (configDir !== null) await rm(configDir, { recursive: true, force: true });
    throw error;
  }

  const issuer = varsFor(origin).RELAY_ISSUER;
  const worker = () => harness.getWorker();
  let stopping: Promise<void> | undefined;

  const postJson = async (path: string, token: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(relayHttpUrl(origin, path), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${path} -> HTTP ${res.status} ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  };

  const evictOne = async (className: string, target: { name: string } | { id: string }) => {
    // Eviction fails while outbound fetches (tap posts) are still in flight (relay.md verification): retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await worker().evictDurableObject(className, { ...target, webSockets: 'hibernate' });
        return;
      } catch (error) {
        if (attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  };

  return {
    origin,
    wsOrigin: origin.replace(/^http/, 'ws'),
    issuer,
    jwksUrl: relayHttpUrl(origin, RELAY_PATHS.jwks),
    signingKey,
    tap: collector,
    harness,
    async devLogin(user, loginOptions) {
      const res = await fetch(relayHttpUrl(origin, RELAY_PATHS.devToken), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user, ...(loginOptions?.displayName ? { displayName: loginOptions.displayName } : {}) }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`dev login for ${user} -> HTTP ${res.status} ${text}`);
      const body = JSON.parse(text) as { token: string; user: { userId: string; displayName: string } };
      return { token: body.token, userId: body.user.userId, displayName: body.user.displayName };
    },
    async createWorkspace(token, workspaceId) {
      const body = await postJson(RELAY_PATHS.workspaces, token, workspaceId === undefined ? {} : { workspaceId });
      return String(body['workspaceId']);
    },
    async identityToken(token, workspaceId, cnf) {
      const body = await postJson(RELAY_PATHS.identityToken, token, { workspaceId, cnf });
      return String(body['token']);
    },
    async inspect(kind, workspaceId) {
      const url = new URL(relayHttpUrl(origin, ROOM_DEBUG_PATH));
      url.searchParams.set('kind', kind);
      url.searchParams.set('workspaceId', workspaceId);
      const res = await fetch(url);
      const text = await res.text();
      if (!res.ok) throw new Error(`inspect ${kind}/${workspaceId} -> HTTP ${res.status} ${text} (needs DEV_LOGIN=1)`);
      return JSON.parse(text) as RoomInspection;
    },
    async evictDurableObjects(filter) {
      await collector?.waitForQuiet(100);
      const kinds = filter?.kind ? [filter.kind] : (['ws', 'xfer'] as const);
      for (const kind of kinds) {
        const className = ROOM_CLASS[kind];
        const targets = filter?.workspaceId
          ? [{ name: filter.workspaceId }]
          : (await worker().listDurableObjectIds(className)).map((id) => ({ id }));
        for (const target of targets) await evictOne(className, target);
      }
    },
    fetch: ((...args: Parameters<TestHarness['fetch']>) => harness.fetch(...args)) as TestHarness['fetch'],
    stop() {
      stopping ??= (async () => {
        try {
          await harness.close();
        } finally {
          await collector?.close();
          if (configDir !== null) await rm(configDir, { recursive: true, force: true });
        }
      })();
      return stopping;
    },
  };
}
