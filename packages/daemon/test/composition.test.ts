// The composition root: feature modules fill service slots (one provider per slot, stubs otherwise), the production
// list names every feature area exactly once, the core drives per-member teardown (kick / leave / demotion) through
// whatever SessionManager is plugged in, a failed start undoes itself, the core's state document cannot be opened by
// modules, and the entry points Claude Code runs inside sessions are exported without the daemon.
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_FEATURE_MODULES } from '../src/daemon.ts';
import type { FeatureModule } from '../src/core/context.ts';
import { FEATURE_SERVICE_NAMES, type FeatureServices, type PowerService, type PowerStatus } from '../src/core/interfaces.ts';
import { isStubService } from '../src/core/stubs.ts';
import { toDisposable } from '../src/core/lifecycle.ts';
import { ManualClock } from '../src/core/lifecycle.ts';
import { silentLogger } from '../src/core/logger.ts';
import { SYSTEM_PRINCIPAL } from '../src/core/permissions.ts';
import { IdentityVerifier, jwksKeySource } from '../src/net/identity.ts';
import { MEMORY_RELAY_ORIGIN, TestIdentityIssuer } from '../src/testing/memory-relay.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../src/testing/index.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

function fakeSessions(calls: string[]): FeatureModule {
  return {
    name: 'fake-sessions',
    create: () => ({
      sessions: {
        killAllForUser: async (userId: string, reason: string) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          calls.push(`kill:${userId}:${reason}`);
        },
        removeGuestDir: async (userId: string) => {
          calls.push(`rm:${userId}`);
        },
      } as unknown as FeatureServices['sessions'],
    }),
    register: () => toDisposable(() => {}),
  };
}

describe('per-member teardown', () => {
  it('kick through the console waits for sessions and the guest dir before answering', async () => {
    const calls: string[] = [];
    t = await createTestDaemon({ modules: [fakeSessions(calls)] });
    const host = await t.connectHost();
    await t.connect({ userId: 'dev:rita', role: 'runner' });
    await host.conn.request('admin.member.kick', { userId: 'dev:rita' });
    expect(calls).toEqual(['kill:dev:rita:kicked', 'rm:dev:rita']);
  });

  it('a kick from any other path still ends the sessions', async () => {
    const calls: string[] = [];
    t = await createTestDaemon({ modules: [fakeSessions(calls)] });
    await t.connect({ userId: 'dev:rita', role: 'runner' });
    t.ctx.members.kick('dev:rita', SYSTEM_PRINCIPAL);
    await waitFor(() => calls.length === 2, { what: 'teardown' });
    expect(calls).toEqual(['kill:dev:rita:kicked', 'rm:dev:rita']);
  });

  it('leaving ends the sessions; a demotion ends them only when the new role cannot own sessions', async () => {
    const calls: string[] = [];
    t = await createTestDaemon({ modules: [fakeSessions(calls)] });
    const host = await t.connectHost();
    const rita = await t.connect({ userId: 'dev:rita', role: 'runner' });
    await t.connect({ userId: 'dev:eddie', role: 'editor' });
    await host.conn.request('admin.member.setRole', { userId: 'dev:eddie', role: 'viewer' });
    expect(calls).toEqual([]);
    await host.conn.request('admin.member.setRole', { userId: 'dev:rita', role: 'editor' });
    expect(calls).toEqual(['kill:dev:rita:role-changed', 'rm:dev:rita']);
    calls.length = 0;
    await waitFor(() => rita.conn.getState().kind === 'online');
    await rita.conn.request('channel.leave', {});
    expect(calls).toEqual(['kill:dev:rita:left', 'rm:dev:rita']);
  });
});

describe('composition', () => {
  it('refuses two providers for one service', async () => {
    const a: FeatureModule = { name: 'a', create: () => ({ files: {} as FeatureServices['files'] }), register: () => toDisposable(() => {}) };
    const b: FeatureModule = { name: 'b', create: () => ({ files: {} as FeatureServices['files'] }), register: () => toDisposable(() => {}) };
    await expect(createTestDaemon({ modules: [a, b] })).rejects.toThrow(/provided by both a and b/);
  });

  it('a failed start undoes itself: keep-awake released, handlers disposed', async () => {
    const events: string[] = [];
    const power: PowerService = {
      start: async (): Promise<PowerStatus> => {
        events.push('power.start');
        return { active: true, mechanism: 'none', pid: null, reason: null };
      },
      stop: async () => {
        events.push('power.stop');
      },
      status: () => ({ active: false, mechanism: 'none', pid: null, reason: null }),
    };
    const failing: FeatureModule = {
      name: 'failing',
      register: () => toDisposable(() => events.push('disposed')),
      start: async () => {
        throw new Error('cannot start');
      },
    };
    await expect(createTestDaemon({ modules: [failing], power })).rejects.toThrow('cannot start');
    expect(events).toEqual(['power.start', 'disposed', 'power.stop']);
  });

  it("modules cannot open the core's state document", async () => {
    t = await createTestDaemon();
    await expect(t.ctx.state.document('state', z.object({}), () => ({}))).rejects.toThrow(/reserved/);
    // A name no composed module uses (the suggest module owns `suggestions` with its own schema).
    const own = await t.ctx.state.document('feature-own-test', z.object({ items: z.array(z.string()) }), () => ({ items: [] }));
    expect(own.get()).toEqual({ items: [] });
  });
});

describe('DEFAULT_FEATURE_MODULES', () => {
  // The order is explained next to the list in src/daemon.ts: providers first, the control socket last.
  const AREAS = ['locks', 'sandbox', 'hooks', 'files', 'docs', 'worktree', 'sessions', 'suggest', 'local'];

  it('lists every feature module exactly once, in dependency order', () => {
    const names = DEFAULT_FEATURE_MODULES.map((module) => module.name);
    for (const area of AREAS) expect(names.filter((name) => name === area), area).toHaveLength(1);
    expect(names).toEqual(AREAS);
    expect(new Set(DEFAULT_FEATURE_MODULES).size).toBe(DEFAULT_FEATURE_MODULES.length);
    expect(Object.isFrozen(DEFAULT_FEATURE_MODULES)).toBe(true);
  });

  // Review SPEC-11: acceptance tests that skip when a service is a stub would stay green if a module dropped out of
  // the composition. This fails instead.
  it('the default composition provides a real (non-stub) implementation of every feature service', async () => {
    const t = await createTestDaemon();
    try {
      const stubs = FEATURE_SERVICE_NAMES.filter((name) => isStubService(t.ctx.services[name]));
      expect(stubs).toEqual([]);
    } finally {
      await t.cleanup();
    }
  }, 60_000);
});

describe('entry points Claude Code runs inside sessions', () => {
  const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
  const ENTRIES = [
    { subpath: './hook-cli', file: 'src/hooks/hook-cli.ts', exportName: 'runHookCli' },
    { subpath: './mcp', file: 'src/mcp/coord-server.ts', exportName: 'runMcpServer' },
  ] as const;

  it.each(ENTRIES)('@smurg/daemon$subpath is $file and exports $exportName', async ({ subpath, file, exportName }) => {
    const manifest = JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(manifest.exports[subpath]).toBe(`./${file}`);
    const loaded = (await import(join(PACKAGE_DIR, file))) as Record<string, unknown>;
    expect(typeof loaded[exportName]).toBe('function');
  });

  // Claude Code starts `smurg hook` once per hook event and `smurg mcp` once per session: they must start fast, so
  // nothing they load at runtime may reach the daemon or its heavy / native dependencies. Type-only imports are
  // erased and do not count; `import { type X }` does (it still loads the module under verbatimModuleSyntax).
  const FORBIDDEN_FILES = ['src/daemon.ts', 'src/index.ts', 'src/testing/'];
  const FORBIDDEN_PACKAGES = /^(?:@smurg\/daemon(?:\/|$)|node-pty$|@anthropic-ai\/sandbox-runtime|@parcel\/watcher|yjs$|y-protocols|@xterm\/)/;

  it.each(ENTRIES)('$file never loads the daemon (runtime import graph)', async ({ file }) => {
    const { files, packages } = await runtimeImportClosure(join(PACKAGE_DIR, file));
    const relativeFiles = [...files].map((path) => path.slice(PACKAGE_DIR.length));
    for (const forbidden of FORBIDDEN_FILES) expect(relativeFiles.filter((path) => path.startsWith(forbidden)), forbidden).toEqual([]);
    expect([...packages].filter((specifier) => FORBIDDEN_PACKAGES.test(specifier))).toEqual([]);
  });

  it('the import-graph reader sees every runtime form and skips type-only imports', () => {
    const source = [
      "import type { A } from './type-only.ts';",
      "import  type {\n  A2,\n} from './type-only-spaced.ts';",
      "export type { B } from './type-only-too.ts';",
      "import { type C } from './kept-by-verbatim.ts';",
      "import {\n  d,\n  e,\n} from './multi-line.ts';",
      "import * as f from 'node:net';",
      "import './side-effect.ts';",
      "export { g } from './re-export.ts';",
      "const h = await import('./dynamic.ts');",
    ].join('\n');
    expect(runtimeImports(source).sort()).toEqual(['./dynamic.ts', './kept-by-verbatim.ts', './multi-line.ts', './re-export.ts', './side-effect.ts', 'node:net']);
  });
});

/** Module specifiers a TypeScript source loads at runtime (static, re-export, side-effect and dynamic imports). */
function runtimeImports(source: string): string[] {
  // `(?!\s|type[\s{])` right after `\s+` forces it to take all the whitespace, so `import  type` stays type-only.
  const patterns = [
    /^\s*import\s+(?!\s|type[\s{])[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /^\s*export\s+(?!\s|type[\s{])[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[1] !== undefined) found.add(match[1]);
  return [...found];
}

/** Follows relative imports from `entry`; package specifiers are collected, not followed. */
async function runtimeImportClosure(entry: string): Promise<{ files: Set<string>; packages: Set<string> }> {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeImports(await readFile(file, 'utf8'))) {
      if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
      else packages.add(specifier);
    }
  }
  return { files, packages };
}

describe('jwksKeySource', () => {
  it("loads the relay's Ed25519 keys, verifies tokens with them, and keeps them when a refresh fails", async () => {
    const clock = new ManualClock(1_760_000_000_000);
    const keys = generateKeyPairSync('ed25519');
    const jwk = keys.publicKey.export({ format: 'jwk' });
    let fail = false;
    const fetchStub = (async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${MEMORY_RELAY_ORIGIN}/.well-known/jwks.json`);
      if (fail) return new Response('down', { status: 503 });
      return Response.json({ keys: [{ ...jwk, kid: 'relay-1', alg: 'EdDSA', use: 'sig' }, { kty: 'RSA', kid: 'ignored' }] });
    }) as typeof fetch;
    const source = jwksKeySource({ url: `${MEMORY_RELAY_ORIGIN}/.well-known/jwks.json`, log: silentLogger, fetch: fetchStub });
    await source.refresh();
    expect(source.size).toBe(1);
    const issuer = new TestIdentityIssuer(MEMORY_RELAY_ORIGIN, keys, clock, 'relay-1');
    const verifier = new IdentityVerifier({ keys: source, issuer: MEMORY_RELAY_ORIGIN, workspaceId: 'ws_test_jwks_000001', clock, skewMs: 60_000 });
    const token = await issuer.issue({ sub: 'dev:amy', name: 'Amy', workspaceId: 'ws_test_jwks_000001', cnf: 'a'.repeat(43) });
    expect(verifier.verify(token).ok).toBe(true);
    fail = true;
    await source.refresh();
    expect(source.get('relay-1')).not.toBeNull();
  });
});
