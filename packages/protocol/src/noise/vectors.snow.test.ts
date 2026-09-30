// The complete snow corpus (408 vectors, including XXpsk0+psk3 and other psk placements) through the production
// state machine.
import { describe, expect, it } from 'vitest';
import { VECTOR_FILES, loadVectorFile } from './testing/load-vectors.ts';
import { runNoiseVectors } from './testing/vectors.ts';

const { vectors, sha256 } = loadVectorFile('snow.txt');

describe('snow vectors', () => {
  it('is the published file, unmodified', () => {
    expect(sha256).toBe(VECTOR_FILES['snow.txt'].sha256);
    expect(vectors).toHaveLength(VECTOR_FILES['snow.txt'].count);
  });

  it('all 408 vectors pass byte for byte', { timeout: 180_000 }, async () => {
    const stats = await runNoiseVectors(vectors);
    expect(stats.failures).toEqual([]);
    expect({ pass: stats.pass, skip: stats.skip, fail: stats.fail }).toEqual({ pass: 408, skip: 0, fail: 0 });
    expect(stats.passedNames.has('Noise_XXpsk0+psk3_25519_ChaChaPoly_BLAKE2s')).toBe(true);
    expect(stats.passedNames.has('Noise_XX_25519_ChaChaPoly_BLAKE2s')).toBe(true);
  });
});
