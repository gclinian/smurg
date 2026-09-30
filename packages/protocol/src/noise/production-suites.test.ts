// The suite OBJECTS the drivers actually use (nobleSuite in browsers, nodeCryptoSuite on the daemon and CLI) reproduce
// every published Noise_*_25519_ChaChaPoly_BLAKE2s vector, and the drivers derive exactly the protocol names the
// vectors pin.
import { describe, expect, it } from 'vitest';
import { nodeCryptoSuite } from '../node/aead.ts';
import { resolveHandshakePattern } from './patterns.ts';
import { HandshakeState } from './state.ts';
import { nobleSuite } from './suite.ts';
import { loadVectorFile } from './testing/load-vectors.ts';
import { runNoiseVectors } from './testing/vectors.ts';

const OURS = /^Noise_[A-Za-z0-9+]+_25519_ChaChaPoly_BLAKE2s$/;
const vectors = [...loadVectorFile('cacophony.txt').vectors, ...loadVectorFile('snow.txt').vectors].filter((v) => OURS.test(v.protocol_name));

describe('production suites against the vectors', () => {
  it('there are 110 Noise_*_25519_ChaChaPoly_BLAKE2s vectors, including XXpsk3 and XX', () => {
    expect(vectors).toHaveLength(110);
    expect(vectors.filter((v) => v.protocol_name === 'Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s')).toHaveLength(1);
    expect(vectors.filter((v) => v.protocol_name === 'Noise_XX_25519_ChaChaPoly_BLAKE2s').length).toBeGreaterThan(0);
  });

  it.each([
    ['nobleSuite', nobleSuite],
    ['nodeCryptoSuite', nodeCryptoSuite],
  ])('%s reproduces all of them', { timeout: 60_000 }, async (_name, suite) => {
    const stats = await runNoiseVectors(vectors, { adaptSuite: () => suite });
    expect(stats.failures).toEqual([]);
    expect(stats.pass).toBe(110);
  });

  it('the drivers use exactly the protocol names the vectors verify', () => {
    const mk = (pattern: string, psks: Uint8Array[]) =>
      new HandshakeState({ suite: nobleSuite, pattern: resolveHandshakePattern(pattern), initiator: true, psks }).protocolName;
    expect(mk('XXpsk3', [new Uint8Array(32)])).toBe('Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s');
    expect(mk('XX', [])).toBe('Noise_XX_25519_ChaChaPoly_BLAKE2s');
  });
});
