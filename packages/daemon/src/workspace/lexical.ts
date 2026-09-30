// The lexical layer of PathGuard (ARCHITECTURE §7.4), run before any filesystem call: the protocol's checkRelPath
// (NUL / control / bidi characters, backslashes, drive letters, absolute paths, empty / '.' / '..' segments, lone
// surrogates, NFC) plus the host platform's limits: Linux counts NAME_MAX in UTF-8 bytes, APFS in UTF-16 units
// (transfer.md §1.8), and the joined absolute path must fit PATH_MAX or every fs call fails with ENAMETOOLONG.
import { checkRelPath } from '@smurg/protocol';
import { PathDeniedError } from '../core/errors.ts';

const encoder = new TextEncoder();

export interface PlatformLimits {
  /** Longest path segment: bytes of UTF-8 (Linux) or UTF-16 units (macOS, checked by the protocol already). */
  readonly segmentBytes: number | null;
  /** Longest absolute path in bytes (PATH_MAX including the terminating NUL). */
  readonly pathBytes: number;
}

export function platformLimits(platform: NodeJS.Platform = process.platform): PlatformLimits {
  return platform === 'linux' ? { segmentBytes: 255, pathBytes: 4_095 } : { segmentBytes: null, pathBytes: 1_023 };
}

/** A printable stand-in for an invalid path in audit targets (never the raw bytes of something hostile). */
export function describeTarget(input: unknown): string {
  if (typeof input !== 'string') return `<${typeof input}>`;
  const clipped = input.length > 512 ? `${input.slice(0, 512)}…` : input;
  return JSON.stringify(clipped).slice(1, -1);
}

/** Validates a client/hook-supplied relative path; returns the NFC form or throws PathDeniedError. */
export function checkLexicalPath(input: unknown, limits: PlatformLimits, options: { readonly allowRoot?: boolean } = {}): string {
  const result = checkRelPath(input, options);
  if (!result.ok) {
    const reason = result.problem === 'too-long' || result.problem === 'segment-too-long' ? 'too-long' : 'lexical';
    throw new PathDeniedError(reason, describeTarget(input));
  }
  if (limits.segmentBytes !== null && result.path !== '') {
    for (const segment of result.path.split('/')) {
      if (encoder.encode(segment).length > limits.segmentBytes) throw new PathDeniedError('too-long', describeTarget(input));
    }
  }
  return result.path;
}

/** The joined absolute path fits the platform's PATH_MAX. */
export function checkAbsoluteLength(absPath: string, limits: PlatformLimits, target: string): void {
  if (encoder.encode(absPath).length > limits.pathBytes) throw new PathDeniedError('too-long', target);
}
