// What a smurg executable says about itself without being run, so that a release can be checked on any machine
// (docs/RELEASING.md §4): only the executable of the machine at hand can run there, and a release assembled by hand
// (§4.3) must not mix in an executable of another version or of another Node.js.
//
//  - The build marker `smurg-build-version=X.Y.Z;`: scripts/build-sea.ts writes it as a comment at the top of the
//    program, and a Node single executable keeps the program's text as it is.
//  - The Node.js release: every Node.js release build carries its own download URL
//    `https://nodejs.org/download/release/vX.Y.Z/` (process.release). The third-party notices of a release name the
//    same Node.js (`node@X.Y.Z (the Node.js runtime)`, the section scripts/build-sea.ts fills in with its LICENSE).
//
// scripts/release-assets.sh looks for the same two strings with grep; scripts/publish-downloads.ts and
// scripts/build-sea.ts use this module.
import { createReadStream } from 'node:fs';

export const BUILD_MARKER_PREFIX = 'smurg-build-version=';
/** The marker of a build of `version` (the text scripts/build-sea.ts writes into the program). */
export const buildMarker = (version: string): string => `${BUILD_MARKER_PREFIX}${version};`;
export const NODE_RELEASE_URL_PREFIX = 'https://nodejs.org/download/release/v';

export interface ExecutableMarkers {
  /** Every version a build marker names (sorted, without duplicates): exactly one for an executable of build-sea. */
  readonly buildVersions: readonly string[];
  /** Every Node.js release whose download URL is in it (sorted, without duplicates): exactly one for a Node release build. */
  readonly nodeVersions: readonly string[];
}

const BUILD_PREFIX = Buffer.from(BUILD_MARKER_PREFIX, 'latin1');
const NODE_PREFIX = Buffer.from(NODE_RELEASE_URL_PREFIX, 'latin1');
/** Longer than any match (prefix + version + terminator): a chunk keeps this much of the previous one. */
const OVERLAP = 128;

function collect(data: Buffer, prefix: Buffer, pattern: RegExp, into: Set<string>): void {
  for (let at = data.indexOf(prefix); at >= 0; at = data.indexOf(prefix, at + 1)) {
    const match = pattern.exec(data.subarray(at + prefix.length, at + prefix.length + 72).toString('latin1'));
    if (match !== null) into.add(match[1] as string);
  }
}

/** The markers in `data` (a whole file, or a chunk that may cut a marker at either end: those are not counted). */
export function scanMarkers(data: Buffer): ExecutableMarkers {
  const builds = new Set<string>();
  const nodes = new Set<string>();
  collect(data, BUILD_PREFIX, /^([0-9A-Za-z.-]{1,60});/, builds);
  collect(data, NODE_PREFIX, /^([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6})\//, nodes);
  return { buildVersions: [...builds].sort(), nodeVersions: [...nodes].sort() };
}

/** The markers of a file, read in chunks (an executable is about 120 MiB). */
export async function markersOfFile(path: string): Promise<ExecutableMarkers> {
  const builds = new Set<string>();
  const nodes = new Set<string>();
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
    // The end of the previous chunk again: a marker cut in two is found whole here (one found twice is still one).
    const data = Buffer.concat([tail, chunk as Buffer]);
    const found = scanMarkers(data);
    for (const version of found.buildVersions) builds.add(version);
    for (const version of found.nodeVersions) nodes.add(version);
    tail = data.subarray(Math.max(0, data.length - OVERLAP));
  }
  return { buildVersions: [...builds].sort(), nodeVersions: [...nodes].sort() };
}

/** The problems of one executable that must be smurg `version`: its build marker, and that it is one Node.js release. */
export function markerProblems(name: string, markers: ExecutableMarkers, version: string): string[] {
  const problems: string[] = [];
  const built = markers.buildVersions;
  if (built.length === 0) problems.push(`${name} has no build marker (${buildMarker(version)}): not built by scripts/build-sea.sh --version ${version}`);
  else if (built.length !== 1 || built[0] !== version) problems.push(`${name} was built as smurg ${built.join(' and ')}, not ${version}`);
  if (markers.nodeVersions.length === 0) problems.push(`${name}: no ${NODE_RELEASE_URL_PREFIX}X.Y.Z/ in it, so it is not a Node.js release build`);
  else if (markers.nodeVersions.length > 1) problems.push(`${name} names several Node.js releases (${markers.nodeVersions.join(', ')})`);
  return problems;
}

/**
 * All executables must be built on the same Node.js release, and the notices must carry that release's LICENSE.
 * `nodes`: executable name → its one Node.js version (executables with none or several are reported by markerProblems).
 */
export function nodeAgreementProblems(nodes: ReadonlyMap<string, string>, noticesNode: string | null): string[] {
  const versions = [...new Set(nodes.values())].sort();
  if (versions.length > 1) {
    return [`the executables are built on different Node.js releases: ${[...nodes].map(([name, node]) => `${name} ${node}`).join(', ')}`];
  }
  if (versions.length === 1 && noticesNode !== null && versions[0] !== noticesNode) {
    return [`the executables are Node.js ${versions[0] as string}, but THIRD-PARTY-NOTICES.txt has the LICENSE of Node.js ${noticesNode} (not the notices of these builds)`];
  }
  return [];
}

/** `node X.Y.Z` at the end of `smurg --version` (`smurg 0.1.0 (protocol v1, daemon 0.1.0, node 22.23.3)`), or null. */
export function nodeOfVersionLine(line: string): string | null {
  return /[ (]node ([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6})\)$/.exec(line.trim())?.[1] ?? null;
}
