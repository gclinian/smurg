// The complete cacophony corpus (944 vectors: every pattern, psk modifier and suite) through the production state
// machine, plus the negative control that proves the harness can fail.
import { describe, expect, it } from 'vitest';
import { VECTOR_FILES, loadVectorFile } from './testing/load-vectors.ts';
import { runNoiseVector, runNoiseVectors } from './testing/vectors.ts';

const { vectors, sha256 } = loadVectorFile('cacophony.txt');

describe('cacophony vectors', () => {
  it('is the published file, unmodified', () => {
    expect(sha256).toBe(VECTOR_FILES['cacophony.txt'].sha256);
    expect(vectors).toHaveLength(VECTOR_FILES['cacophony.txt'].count);
  });

  it('all 944 vectors pass byte for byte (handshake + transport ciphertexts, handshake hash)', { timeout: 180_000 }, async () => {
    const stats = await runNoiseVectors(vectors);
    expect(stats.failures).toEqual([]);
    expect({ pass: stats.pass, skip: stats.skip, fail: stats.fail }).toEqual({ pass: 944, skip: 0, fail: 0 });
    // The two protocols smurg actually runs are among them.
    expect(stats.passedNames.has('Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s')).toBe(true);
    expect(stats.passedNames.has('Noise_XX_25519_ChaChaPoly_BLAKE2s')).toBe(true);
  });

  it('negative control: a tampered PSK (on both sides) no longer reproduces the XXpsk3 vector', async () => {
    const original = vectors.find((v) => v.protocol_name === 'Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s');
    expect(original).toBeDefined();
    expect(await runNoiseVector(original!)).toEqual({ outcome: 'pass' });
    const tampered = structuredClone(original!);
    const psk = tampered.init_psks![0]!;
    tampered.init_psks = [(psk.startsWith('ff') ? '00' : 'ff') + psk.slice(2)];
    tampered.resp_psks = [...tampered.init_psks];
    const result = await runNoiseVector(tampered);
    expect(result.outcome).toBe('fail');
  });

  it('negative control: a tampered prologue on one side fails', async () => {
    const original = vectors.find((v) => v.protocol_name === 'Noise_XX_25519_ChaChaPoly_BLAKE2s')!;
    const tampered = structuredClone(original);
    tampered.resp_prologue = `${tampered.resp_prologue}00`;
    const result = await runNoiseVector(tampered).catch((err: unknown) => ({ outcome: 'fail' as const, detail: String(err) }));
    expect(result.outcome).toBe('fail');
  });
});
