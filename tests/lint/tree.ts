// Shared by the lint tests: the repository's text files, read from the file system (never from git: a copy of the
// tree without .git, such as the Linux VM's, runs the same checks).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

/** Directories that are not source: dependencies, build output, tool state, local worktrees. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.tools', '.xdg', '.wrangler', '.git', 'coverage', '.claude', '.smurg', '.vite', '.turbo']);
/** What a lint reads as text. */
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.html', '.css', '.sh', '.yml', '.yaml', '.txt', '.svg', '.toml', '']);
/** Generated or vendored text nobody writes by hand. */
const SKIPPED_FILES = new Set(['pnpm-lock.yaml', 'packages/cli/THIRD-PARTY-NOTICES.txt', 'apps/web/public/third-party-notices.txt', 'apps/relay/worker-configuration.d.ts']);

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats === undefined) continue;
    if (stats.isDirectory()) {
      if (!SKIPPED_DIRS.has(name)) walk(path, out);
      continue;
    }
    if (!stats.isFile() || stats.size > 2_000_000) continue;
    const rel = relative(REPO_ROOT, path).split(sep).join('/');
    if (SKIPPED_FILES.has(rel) || rel.startsWith('packages/protocol/test-vectors/')) continue;
    if (!TEXT_EXTENSIONS.has(extension(name))) continue;
    // A file without an extension is text only when it is one of the known names.
    if (extension(name) === '' && !/^(LICENSE|NOTICE|\.gitignore|\.npmrc|\.editorconfig)$/.test(name)) continue;
    out.push(rel);
  }
}

let cached: readonly string[] | undefined;

/** Every text file of the tree, as repository-relative POSIX paths, sorted. */
export function repoFiles(): readonly string[] {
  if (cached === undefined) {
    const out: string[] = [];
    walk(REPO_ROOT, out);
    cached = out;
  }
  return cached;
}

export function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

/** Han, Bopomofo, CJK punctuation (U+3000-303F) and full-width forms (U+FF00-FFEF): DESIGN A.11. */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3100, 0x312f], // Bopomofo
  [0x3400, 0x4dbf], // Han, extension A
  [0x4e00, 0x9fff], // Han
  [0xf900, 0xfaff], // Han, compatibility
  [0xff00, 0xffef], // full-width and half-width forms
];
// Built from code points so that this file itself holds none of the characters it looks for.
export const CJK = new RegExp(`[${CJK_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join('')}]`, 'u');

/** A test file: its content is data, its titles are prose. */
export function isTestFile(path: string): boolean {
  return (
    /\.test\.tsx?$/.test(path) ||
    /(^|\/)(test|e2e|testing|test-support|fixtures|__fixtures__)\//.test(path) ||
    /\.fixture\.ts$/.test(path) ||
    path.endsWith('/test-table.ts')
  );
}
