// TEST ONLY. Runs Noise JSON test vectors (cacophony / snow format) through the production HandshakeState.
// Not reachable from any package entry point.
import { EMPTY_BYTES, equalBytes, fromHex, toHex } from '../../bytes.ts';
import { resolveHandshakePattern } from '../patterns.ts';
import { HandshakeState, type TransportKeys } from '../state.ts';
import type { NoiseSuite } from '../suite.ts';
import { ALL_HANDSHAKE_PATTERNS, ONE_WAY_PATTERNS } from './all-patterns.ts';
import { vectorKeyPair, vectorSuite } from './all-suites.ts';

export interface NoiseVector {
  protocol_name: string;
  init_prologue: string;
  resp_prologue: string;
  init_static?: string;
  init_ephemeral: string;
  init_remote_static?: string;
  init_psks?: string[];
  resp_static?: string;
  resp_ephemeral?: string;
  resp_remote_static?: string;
  resp_psks?: string[];
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
}

export type VectorOutcome = { outcome: 'pass' } | { outcome: 'skip' | 'fail'; detail: string };

export interface VectorRunOptions {
  /** Replaces the suite built from the protocol name (e.g. to put node:crypto AEAD behind the same DH and hash). */
  adaptSuite?: (suite: NoiseSuite, parts: { dh: string; cipher: string; hash: string }) => NoiseSuite;
}

const NAME_RE = /^Noise_([A-Za-z0-9+]+)_([^_]+)_([^_]+)_([^_]+)$/;

export function parseProtocolName(name: string): { pattern: string; dh: string; cipher: string; hash: string } | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  return { pattern: m[1] as string, dh: m[2] as string, cipher: m[3] as string, hash: m[4] as string };
}

export async function runNoiseVector(vector: NoiseVector, options: VectorRunOptions = {}): Promise<VectorOutcome> {
  const parts = parseProtocolName(vector.protocol_name);
  if (!parts) return { outcome: 'skip', detail: 'unparsed protocol name' };
  const base = vectorSuite(parts.dh, parts.cipher, parts.hash);
  if (!base) return { outcome: 'skip', detail: 'unknown suite' };
  const suite = options.adaptSuite ? options.adaptSuite(base, parts) : base;
  let pattern;
  try {
    pattern = resolveHandshakePattern(parts.pattern, ALL_HANDSHAKE_PATTERNS);
  } catch {
    return { outcome: 'skip', detail: 'unknown pattern' };
  }
  const keyPair = (hex?: string) => (hex ? vectorKeyPair(parts.dh, fromHex(hex)) : undefined);
  const keys = (list?: string[]) => (list ?? []).map(fromHex);
  const init = new HandshakeState({
    suite,
    pattern,
    initiator: true,
    prologue: fromHex(vector.init_prologue),
    s: keyPair(vector.init_static),
    e: keyPair(vector.init_ephemeral),
    rs: vector.init_remote_static ? fromHex(vector.init_remote_static) : undefined,
    psks: keys(vector.init_psks),
  });
  const resp = new HandshakeState({
    suite,
    pattern,
    initiator: false,
    prologue: fromHex(vector.resp_prologue),
    s: keyPair(vector.resp_static),
    e: keyPair(vector.resp_ephemeral),
    rs: vector.resp_remote_static ? fromHex(vector.resp_remote_static) : undefined,
    psks: keys(vector.resp_psks),
  });
  // The name our code derives must be the vector's exact protocol name (it is hashed into h at initialisation).
  if (init.protocolName !== vector.protocol_name) return { outcome: 'fail', detail: `protocol name ${init.protocolName}` };
  const oneWay = ONE_WAY_PATTERNS.has(pattern.name.replace(/psk.*$/, ''));
  let initKeys: TransportKeys | null = null;
  let respKeys: TransportKeys | null = null;
  for (const [i, message] of vector.messages.entries()) {
    const payload = fromHex(message.payload);
    const fromInitiator = oneWay || i % 2 === 0;
    let ciphertext: Uint8Array;
    let roundTrip: Uint8Array;
    if (!initKeys || !respKeys) {
      const [writer, reader] = fromInitiator ? [init, resp] : [resp, init];
      ciphertext = await writer.writeMessage(payload);
      roundTrip = await reader.readMessage(ciphertext);
      if (init.isComplete && resp.isComplete) {
        initKeys = init.split();
        respKeys = resp.split();
        if (vector.handshake_hash && toHex(initKeys.handshakeHash) !== vector.handshake_hash) {
          return { outcome: 'fail', detail: 'handshake_hash' };
        }
        if (!equalBytes(initKeys.handshakeHash, respKeys.handshakeHash)) return { outcome: 'fail', detail: 'h mismatch' };
      }
    } else {
      const [send, recv] = fromInitiator ? [initKeys.send, respKeys.recv] : [respKeys.send, initKeys.recv];
      ciphertext = send.encryptWithAd(EMPTY_BYTES, payload);
      roundTrip = recv.decryptWithAd(EMPTY_BYTES, ciphertext);
    }
    if (toHex(ciphertext) !== message.ciphertext) return { outcome: 'fail', detail: `message ${i} ciphertext` };
    if (!equalBytes(roundTrip, payload)) return { outcome: 'fail', detail: `message ${i} payload` };
  }
  return { outcome: 'pass' };
}

export interface VectorStats {
  total: number;
  pass: number;
  skip: number;
  fail: number;
  /** Every vector that did not pass (skipped ones included, prefixed with "skip"). */
  failures: string[];
  passedNames: Set<string>;
}

export async function runNoiseVectors(vectors: readonly NoiseVector[], options: VectorRunOptions = {}): Promise<VectorStats> {
  const stats: VectorStats = { total: vectors.length, pass: 0, skip: 0, fail: 0, failures: [], passedNames: new Set() };
  for (const vector of vectors) {
    let result: VectorOutcome;
    try {
      result = await runNoiseVector(vector, options);
    } catch (err) {
      result = { outcome: 'fail', detail: String(err) };
    }
    stats[result.outcome]++;
    if (result.outcome === 'pass') stats.passedNames.add(vector.protocol_name);
    else stats.failures.push(`${result.outcome} ${vector.protocol_name}: ${result.detail}`);
  }
  return stats;
}
