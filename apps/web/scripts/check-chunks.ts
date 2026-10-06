// Build guard (runs after `vite build`): Monaco and xterm.js must never be part of what the first page load
// downloads, nor of what the sessions view (the main screen of a workspace) loads: they come with code mode, an
// editor column or a terminal column, when one is first shown (DESIGN §5.1). It follows the STATIC imports in
// dist/.vite/manifest.json from the entry chunk, and from the workspace route's chunk, and scans every reachable
// chunk for code that only Monaco or xterm contain. Other lazy chunks (dynamic imports) may contain them.
//
//   node scripts/check-chunks.ts [distDir]   prints the chunk table; exit 1 if the rule is broken (default: ./dist)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

interface ManifestChunk {
  file: string;
  name?: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}

const DIST = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../dist', import.meta.url));
/** The lazy chunk of a workspace's shell: the sessions view and everything it imports statically. */
const WORKSPACE_ROUTE = 'src/app/workspace/WorkspaceRoute.tsx';
const MANIFEST = join(DIST, '.vite', 'manifest.json');

/** Strings that exist only in the bundled library (checked against a real build of each). */
const FORBIDDEN: readonly { readonly library: string; readonly markers: readonly string[] }[] = [
  { library: 'monaco-editor', markers: ['MonacoEnvironment', 'editorWorkerService'] },
  { library: '@xterm/xterm', markers: ['xterm-helper-textarea', 'xterm-accessibility'] },
];

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function main(): number {
  if (!existsSync(MANIFEST)) {
    console.error(`check-chunks: ${MANIFEST} not found (run vite build with build.manifest: true)`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, ManifestChunk>;
  const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry);
  if (entries.length === 0) {
    console.error('check-chunks: no entry chunk in the manifest');
    return 1;
  }
  const closure = (roots: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const visit = (key: string): void => {
      if (seen.has(key)) return;
      seen.add(key);
      for (const next of manifest[key]?.imports ?? []) visit(next);
    };
    for (const root of roots) visit(root);
    return seen;
  };
  const initial = closure(entries.map(([key]) => key));
  if (manifest[WORKSPACE_ROUTE] === undefined) {
    console.error(`check-chunks: no chunk for ${WORKSPACE_ROUTE} in the manifest (the workspace route moved, or is no longer loaded lazily): update this guard`);
    return 1;
  }
  const sessionsView = closure([WORKSPACE_ROUTE]);

  let failed = false;
  let initialBytes = 0;
  let initialGzip = 0;
  let sessionsBytes = 0;
  let sessionsGzip = 0;
  const rows: string[] = [];
  for (const [key, chunk] of Object.entries(manifest)) {
    const path = join(DIST, chunk.file);
    if (!existsSync(path)) continue;
    const content = readFileSync(path);
    const size = statSync(path).size;
    const gz = gzipSync(content).length;
    const isInitial = initial.has(key);
    const isSessions = !isInitial && sessionsView.has(key);
    if (isInitial) {
      initialBytes += size;
      initialGzip += gz;
    }
    if (isSessions) {
      sessionsBytes += size;
      sessionsGzip += gz;
    }
    if (isInitial || isSessions) {
      const text = content.toString('utf8');
      for (const { library, markers } of FORBIDDEN) {
        const hit = markers.find((marker) => text.includes(marker));
        if (hit) {
          failed = true;
          console.error(`check-chunks: ${library} is in the ${isInitial ? 'initial load' : 'sessions view'} (${chunk.file} contains "${hit}"): load it with import() (src/lib/lazy.ts)`);
        }
      }
    }
    rows.push(`${isInitial ? 'initial ' : isSessions ? 'sessions' : 'lazy    '}  ${kib(size).padStart(12)}  ${kib(gz).padStart(11)} gz  ${chunk.file}${chunk.src ? `  (${chunk.src})` : ''}`);
  }
  rows.sort();
  console.log(rows.join('\n'));
  console.log(`initial load: ${kib(initialBytes)} (${kib(initialGzip)} gzip) in ${initial.size} chunk(s)`);
  console.log(`sessions view, on top of it: ${kib(sessionsBytes)} (${kib(sessionsGzip)} gzip)`);
  if (failed) return 1;
  console.log('check-chunks: ok (Monaco and xterm are neither in the initial load nor in the sessions view)');
  return 0;
}

process.exitCode = main();
