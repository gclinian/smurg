// What the `smurg` executable is made of (DESIGN v0.5.0 §6): nothing that exists for tests is reachable from the
// CLI's entry point. The runtime import graph is followed from packages/cli/src/main.ts through the CLI's own files
// and through the workspace packages it imports (@smurg/daemon, @smurg/protocol, by their `exports` maps): no file of
// packages/daemon/src/testing (the test harness, the in-memory relay, the stand-in `claude`), of
// packages/daemon/src/core/fakes (the in-memory services) or of packages/protocol/src/testing (the entity builders) is
// in it. The single executable is bundled from the same entry point, so what is not in this graph is not in a release.
// (The daemon's own composition test checks its entry points from inside that package; this one starts where the
// executable starts.)
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
const ENTRY = join(REPO, 'packages/cli/src/main.ts');

/** The workspace packages whose sources the graph is followed into, by package name. */
const WORKSPACE_PACKAGES: Readonly<Record<string, string>> = {
  '@smurg/daemon': 'packages/daemon',
  '@smurg/protocol': 'packages/protocol',
};

/** Test-only code: reaching any of it from the entry point fails. */
const TEST_ONLY_DIRS = ['packages/daemon/src/testing/', 'packages/daemon/src/core/fakes/', 'packages/protocol/src/testing/', 'packages/cli/test/', 'packages/daemon/test/'];
const TEST_ONLY_SPECIFIERS = ['@smurg/daemon/testing', '@smurg/daemon/fakes', '@smurg/protocol/testing', '@smurg/protocol/locale/test-table'];

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

const exportsCache = new Map<string, Record<string, unknown>>();

/** The source file a workspace specifier (`@smurg/daemon/mcp`) names, by that package's `exports`; null: not one of ours. */
async function workspaceFile(specifier: string): Promise<string | null> {
  const name = Object.keys(WORKSPACE_PACKAGES).find((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
  if (name === undefined) return null;
  const dir = join(REPO, WORKSPACE_PACKAGES[name] as string);
  let exports = exportsCache.get(name);
  if (exports === undefined) {
    exports = (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }).exports;
    exportsCache.set(name, exports);
  }
  const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
  const target = exports[subpath];
  if (typeof target !== 'string') throw new Error(`${specifier} is not an export of ${name}`);
  return resolve(dir, target);
}

interface Graph {
  /** Repository-relative paths of every source file reached. */
  readonly files: Set<string>;
  /** Every non-relative specifier seen (workspace packages included). */
  readonly specifiers: Set<string>;
}

async function runtimeImportGraph(entry: string): Promise<Graph> {
  const files = new Set<string>();
  const specifiers = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    const rel = relative(REPO, file);
    if (files.has(rel)) continue;
    files.add(rel);
    for (const specifier of runtimeImports(await readFile(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier));
        continue;
      }
      specifiers.add(specifier);
      const target = await workspaceFile(specifier);
      if (target !== null) queue.push(target);
    }
  }
  return { files, specifiers };
}

describe('what the smurg executable is made of', () => {
  it('nothing test-only is reachable from packages/cli/src/main.ts: not the daemon\'s test harness and stand-in claude, not the in-memory fakes, not the protocol\'s builders', async () => {
    const graph = await runtimeImportGraph(ENTRY);
    // The walk really crossed the packages: the dispatcher and its commands, the daemon, the two session entry points.
    for (const reached of [
      'packages/cli/src/cli/run.ts',
      'packages/cli/src/commands/attach.ts',
      'packages/cli/src/commands/host.ts',
      'packages/cli/src/commands/stop.ts',
      'packages/daemon/src/index.ts',
      'packages/daemon/src/daemon.ts',
      'packages/daemon/src/local/control-server.ts',
      'packages/daemon/src/hooks/hook-cli.ts',
      'packages/daemon/src/mcp/coord-server.ts',
      'packages/protocol/src/index.ts',
    ]) {
      expect(graph.files.has(reached), reached).toBe(true);
    }
    expect(graph.files.size).toBeGreaterThan(150);
    for (const dir of TEST_ONLY_DIRS) expect([...graph.files].filter((file) => file.startsWith(dir)), dir).toEqual([]);
    expect([...graph.specifiers].filter((specifier) => TEST_ONLY_SPECIFIERS.includes(specifier))).toEqual([]);
    // Nothing reached is a test file or a fixture by its name either.
    expect([...graph.files].filter((file) => /\.test\.tsx?$|\.fixture\.ts$|(?:^|\/)fake-[^/]*$/.test(file))).toEqual([]);
  });

  it('the walk itself: it sees every runtime form of an import, skips type-only ones, and would find the fakes behind a package export', async () => {
    const source = [
      "import type { A } from './type-only.ts';",
      "import  type {\n  A2,\n} from './type-only-spaced.ts';",
      "export type { B } from './type-only-too.ts';",
      "import { type C } from './kept-by-verbatim.ts';",
      "import {\n  d,\n  e,\n} from './multi-line.ts';",
      "import * as f from 'node:net';",
      "import './side-effect.ts';",
      "export { g } from './re-export.ts';",
      "const h = await import('@smurg/daemon/hook-cli');",
    ].join('\n');
    expect(runtimeImports(source).sort()).toEqual(['./kept-by-verbatim.ts', './multi-line.ts', './re-export.ts', './side-effect.ts', '@smurg/daemon/hook-cli', 'node:net']);
    expect(relative(REPO, (await workspaceFile('@smurg/daemon/fakes')) as string)).toBe('packages/daemon/src/core/fakes/index.ts');
    expect(relative(REPO, (await workspaceFile('@smurg/daemon/testing')) as string)).toBe('packages/daemon/src/testing/index.ts');
    expect(relative(REPO, (await workspaceFile('@smurg/protocol/i18n')) as string)).toBe('packages/protocol/src/i18n/index.ts');
    expect(await workspaceFile('ws')).toBeNull();
    // A graph that starts in a test does reach them: the check is not vacuous.
    const fromATest = await runtimeImportGraph(join(REPO, 'packages/cli/test/stop-status.test.ts'));
    expect([...fromATest.files].some((file) => file.startsWith('packages/daemon/src/core/fakes/'))).toBe(true);
    expect([...fromATest.files].some((file) => file.startsWith('packages/daemon/src/testing/'))).toBe(true);
  });
});
