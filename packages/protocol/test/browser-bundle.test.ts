// The browser-reachable entry points really bundle for a browser (build-quality review F7). entry-boundaries.test.ts
// scans only this package's own import specifiers; this bundles the entries with esbuild for `platform: 'browser'`,
// third-party dependencies included, and fails on any Node built-in they reach and on Node-only globals left in the
// output. The Node entry is the negative control: it must be caught.
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** Marks every Node built-in import external and records it. */
function recordNodeBuiltins(found: string[]): Plugin {
  return {
    name: 'record-node-builtins',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        const bare = args.path.split('/')[0] as string;
        if (args.path.startsWith('node:') || BUILTINS.has(args.path) || BUILTINS.has(bare)) {
          found.push(args.path);
          return { path: args.path, external: true };
        }
        return undefined;
      });
    },
  };
}

/** Node-only globals a browser does not have (lib0's guarded `process.env` lookup is fine and not matched). */
const NODE_GLOBALS = [/\bBuffer\.(?:from|alloc|concat|isBuffer|byteLength)\b/, /\bsetImmediate\(/, /\b__dirname\b/, /\b__filename\b/, /\bprocess\.(?:versions|platform|nextTick|umask|pid)\b/];

async function bundle(entry: string): Promise<{ builtins: string[]; globals: string[] }> {
  const builtins: string[] = [];
  const result = await build({
    entryPoints: [resolve(SRC, entry)],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
    conditions: ['browser'],
    plugins: [recordNodeBuiltins(builtins)],
  });
  const code = result.outputFiles[0]?.text ?? '';
  return { builtins: [...new Set(builtins)].sort(), globals: NODE_GLOBALS.filter((re) => re.test(code)).map((re) => re.source) };
}

describe('browser bundles of @smurg/protocol', () => {
  it.each(['index.ts', 'client/index.ts', 'browser/index.ts', 'relay/index.ts'])('%s reaches no Node built-in and uses no Node-only global', async (entry) => {
    expect(await bundle(entry)).toEqual({ builtins: [], globals: [] });
  }, 60_000);

  it('negative control: the Node entry is caught', async () => {
    expect((await bundle('node/index.ts')).builtins).toContain('node:crypto');
  }, 60_000);
});
