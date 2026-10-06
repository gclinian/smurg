// Guards the dependency rules of ARCHITECTURE §1 statically, so a violation fails `pnpm check` long before a browser
// build or the relay bundle breaks:
//  - `@smurg/protocol`, `/client`, `/browser` and `/relay` run in browsers or workerd: no Node built-ins reachable.
//  - `@smurg/protocol/relay` is imported by the Worker: no crypto code, only zod and ../constants.ts.
//  - `@smurg/protocol/locale` is imported by the Worker too (the relay may import `/relay` and `/locale`, nothing
//    else of this package), by the web app and by the CLI: it imports nothing at all.
//  - `@smurg/protocol/i18n` (the wire catalog) is loaded by every client: only its own files and ../locale, no package.
// Type-only imports are ignored (they are erased before anything runs).
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = resolve(PKG_DIR, 'src');
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type[\s{])(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(STATIC_IMPORT), ...text.matchAll(DYNAMIC_IMPORT)].map((m) => m[1] as string);
}

type Graph = { files: Set<string>; bare: Map<string, Set<string>>; broken: string[] };

function importGraph(entry: string): Graph {
  const graph: Graph = { files: new Set(), bare: new Map(), broken: [] };
  const queue = [resolve(SRC_DIR, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (graph.files.has(file)) continue;
    graph.files.add(file);
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec);
        if (existsSync(target)) queue.push(target);
        else graph.broken.push(`${relative(PKG_DIR, file)} -> ${spec}`);
      } else {
        const users = graph.bare.get(spec) ?? new Set<string>();
        users.add(relative(PKG_DIR, file));
        graph.bare.set(spec, users);
      }
    }
  }
  return graph;
}

describe('browser-safe entry points', () => {
  it.each(['index.ts', 'client/index.ts', 'browser/index.ts', 'relay/index.ts', 'locale/index.ts', 'i18n/index.ts'])(
    'src/%s reaches no Node built-in',
    (entry) => {
      const graph = importGraph(entry);
      expect(graph.broken).toEqual([]);
      const offenders = [...graph.bare].filter(([spec]) => NODE_BUILTINS.has(spec) || spec.startsWith('node:'));
      expect(offenders.map(([spec, users]) => `${spec} (from ${[...users].join(', ')})`)).toEqual([]);
    },
  );
});

describe('the test builders (@smurg/protocol/testing)', () => {
  it.each(['index.ts', 'client/index.ts', 'browser/index.ts', 'node/index.ts', 'relay/index.ts', 'locale/index.ts', 'i18n/index.ts'])('src/%s does not reach testing/', (entry) => {
    const reached = [...importGraph(entry).files].map((file) => relative(SRC_DIR, file)).filter((file) => file.startsWith('testing/'));
    expect(reached).toEqual([]);
  });

  it('the builders themselves are browser-safe (the web app\'s tests load them)', () => {
    const graph = importGraph('testing/index.ts');
    expect(graph.broken).toEqual([]);
    expect([...graph.bare.keys()].filter((spec) => NODE_BUILTINS.has(spec) || spec.startsWith('node:'))).toEqual([]);
  });
});

describe('relay entry point', () => {
  it('depends on nothing but zod and ../constants.ts', () => {
    const graph = importGraph('relay/index.ts');
    expect(graph.broken).toEqual([]);
    expect([...graph.bare.keys()].filter((spec) => spec !== 'zod')).toEqual([]);
    const outside = [...graph.files]
      .map((file) => relative(SRC_DIR, file))
      .filter((file) => !file.startsWith('relay/') && file !== 'constants.ts');
    expect(outside).toEqual([]);
  });

  it('keeps constants.ts free of imports (the Worker and every browser entry load it)', () => {
    expect(specifiersOf(resolve(SRC_DIR, 'constants.ts'))).toEqual([]);
  });
});

describe('locale entry point', () => {
  it('imports nothing at all (no package, no other file)', () => {
    const graph = importGraph('locale/index.ts');
    expect(graph.broken).toEqual([]);
    expect([...graph.bare.keys()]).toEqual([]);
    expect([...graph.files].map((file) => relative(SRC_DIR, file))).toEqual(['locale/index.ts']);
  });

  it('the shared test table is plain data', () => {
    expect(specifiersOf(resolve(SRC_DIR, 'locale/test-table.ts'))).toEqual([]);
  });
});

describe('i18n entry point', () => {
  it('depends on no package and on nothing outside i18n/ and locale/', () => {
    const graph = importGraph('i18n/index.ts');
    expect(graph.broken).toEqual([]);
    expect([...graph.bare.keys()]).toEqual([]);
    const outside = [...graph.files]
      .map((file) => relative(SRC_DIR, file))
      .filter((file) => !file.startsWith('i18n/') && file !== 'locale/index.ts');
    expect(outside).toEqual([]);
  });

  it('the barrel reaches the catalog (SmurgError renders its English message from a reference) and nothing else new', () => {
    const files = [...importGraph('index.ts').files].map((file) => relative(SRC_DIR, file)).filter((file) => file.startsWith('i18n/'));
    expect(files).toContain('i18n/index.ts');
    expect(files.filter((file) => !/^i18n\/(define|format|index|messages\/[a-z]+)\.ts$/.test(file))).toEqual([]);
  });
});
