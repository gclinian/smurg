// Release versions as `smurg update` compares them: `X.Y.Z` or `X.Y.Z-<pre-release>` (the form scripts/build-sea.ts
// accepts for --version and scripts/publish-downloads.ts writes to latest/VERSION), ordered as semver orders them. A
// build from the repository says `<package version>-dev`, which is older than the release of that version.

export interface ReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The dot-separated pre-release identifiers (`rc.1` → ['rc', '1']); empty for a release. */
  readonly pre: readonly string[];
}

const VERSION = /^([0-9]{1,4})\.([0-9]{1,4})\.([0-9]{1,6})(?:-([0-9A-Za-z.-]{1,40}))?$/;

/** The parsed version, or null when `text` is not one (never guessed: no leading `v`, no build metadata). */
export function parseVersion(text: string): ReleaseVersion | null {
  const match = VERSION.exec(text);
  if (match === null) return null;
  const pre = match[4] === undefined ? [] : match[4].split('.');
  if (pre.some((part) => part === '')) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre };
}

function comparePre(a: readonly string[], b: readonly string[]): number {
  // A release is newer than any of its pre-releases.
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x === y) continue;
    const xn = /^[0-9]+$/.test(x);
    const yn = /^[0-9]+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** < 0 when `a` is older than `b`, 0 when they are the same version, > 0 when `a` is newer. */
export function compareVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePre(a.pre, b.pre);
}
