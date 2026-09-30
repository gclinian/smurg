// TEST ONLY (Node). Loads the published vector files copied verbatim into packages/protocol/test-vectors/:
//   cacophony.txt  haskell-cryptography/cacophony@master/vectors/cacophony.txt  (944 vectors)
//                  sha256 3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae
//   snow.txt       mcginty/snow@main/tests/vectors/snow.txt                     (408 vectors)
//                  sha256 69da433305fd045f6c9f01b656662a389d022688986fd39fbe7af009cd402fd3
// Both were downloaded on 2026-09-27 for docs/research/noise.md and re-verified against GitHub by its verifier.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NoiseVector } from './vectors.ts';

export const VECTOR_FILES = {
  'cacophony.txt': { sha256: '3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae', count: 944 },
  'snow.txt': { sha256: '69da433305fd045f6c9f01b656662a389d022688986fd39fbe7af009cd402fd3', count: 408 },
} as const;

export type VectorFileName = keyof typeof VECTOR_FILES;

export function loadVectorFile(name: VectorFileName): { vectors: NoiseVector[]; sha256: string } {
  const raw = readFileSync(new URL(`../../../test-vectors/${name}`, import.meta.url));
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const parsed = JSON.parse(raw.toString('utf8')) as { vectors: NoiseVector[] };
  return { vectors: parsed.vectors, sha256 };
}
