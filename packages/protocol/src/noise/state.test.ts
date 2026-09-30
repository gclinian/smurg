// State-machine properties the vectors do not cover: fail-closed poisoning, turn discipline, nonce handling,
// low-order keys, configuration errors.
import { describe, expect, it } from 'vitest';
import { EMPTY_BYTES, utf8Encode } from '../bytes.ts';
import { NoiseError } from './errors.ts';
import { resolveHandshakePattern } from './patterns.ts';
import { CipherState, HandshakeState } from './state.ts';
import { chachaPolyNonce, nobleSuite, x25519KeyPair, type NoiseKeyPair } from './suite.ts';
import { ALL_HANDSHAKE_PATTERNS } from './testing/all-patterns.ts';

const XX = resolveHandshakePattern('XX');
const XXpsk3 = resolveHandshakePattern('XXpsk3');

function pair(opts: { pattern?: typeof XX; psk?: Uint8Array; initiatorKey?: NoiseKeyPair } = {}) {
  const pattern = opts.pattern ?? XX;
  const psks = opts.psk ? [opts.psk] : [];
  const i = new HandshakeState({ suite: nobleSuite, pattern, initiator: true, s: opts.initiatorKey ?? x25519KeyPair(), psks });
  const r = new HandshakeState({ suite: nobleSuite, pattern, initiator: false, s: x25519KeyPair(), psks });
  return { i, r };
}

describe('patterns', () => {
  it('resolves XX and XXpsk3 exactly as the spec defines them', () => {
    expect(XX.messages).toEqual([['e'], ['e', 'ee', 's', 'es'], ['s', 'se']]);
    expect(XXpsk3.name).toBe('XXpsk3');
    expect(XXpsk3.messages).toEqual([['e'], ['e', 'ee', 's', 'es'], ['s', 'se', 'psk']]);
    expect(resolveHandshakePattern('XXpsk0+psk3', ALL_HANDSHAKE_PATTERNS).messages[0]).toEqual(['psk', 'e']);
  });

  it.each(['IK', 'XXpsk4', 'XXpskx', 'XXpsk3+', 'toString', '__proto__', 'xx'])('rejects %s in the production table', (name) => {
    expect(() => resolveHandshakePattern(name)).toThrow(NoiseError);
  });
});

describe('HandshakeState', () => {
  it('completes XX, agrees on h and transport keys, and learns both static keys', async () => {
    const a = x25519KeyPair();
    const { i, r } = pair({ initiatorKey: a });
    await r.readMessage(await i.writeMessage());
    await i.readMessage(await r.writeMessage());
    expect(await r.readMessage(await i.writeMessage(utf8Encode('hello')))).toEqual(utf8Encode('hello'));
    const ik = i.split();
    const rk = r.split();
    expect(ik.handshakeHash).toEqual(rk.handshakeHash);
    expect(rk.remoteStatic).toEqual(a.publicKey);
    expect(rk.recv.decryptWithAd(EMPTY_BYTES, ik.send.encryptWithAd(EMPTY_BYTES, utf8Encode('x')))).toEqual(utf8Encode('x'));
  });

  it('enforces turns and single use', async () => {
    const { i, r } = pair();
    await expect(r.writeMessage()).rejects.toMatchObject({ code: 'state' });
    await expect(i.readMessage(new Uint8Array(32))).rejects.toMatchObject({ code: 'state' });
    await r.readMessage(await i.writeMessage());
    await i.readMessage(await r.writeMessage());
    await r.readMessage(await i.writeMessage());
    await expect(i.writeMessage()).rejects.toMatchObject({ code: 'state', message: /complete/ });
    expect(() => new HandshakeState({ suite: nobleSuite, pattern: XX, initiator: true }).split()).toThrow(/not complete/);
  });

  it('is poisoned by any failure: a later call throws even with valid input', async () => {
    const { i, r } = pair();
    const msg1 = await i.writeMessage();
    const bad = msg1.slice(0, 10);
    await expect(r.readMessage(bad)).rejects.toMatchObject({ code: 'short' });
    await expect(r.readMessage(msg1)).rejects.toMatchObject({ code: 'state', message: /already failed/ });
  });

  it('refuses a concurrent call while an async DH is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const inner = x25519KeyPair();
    const slow: NoiseKeyPair = { publicKey: inner.publicKey, dh: async (pk) => (await gate, inner.dh(pk)) };
    const i = new HandshakeState({ suite: nobleSuite, pattern: XX, initiator: true, s: slow });
    const r = new HandshakeState({ suite: nobleSuite, pattern: XX, initiator: false, s: x25519KeyPair() });
    await r.readMessage(await i.writeMessage());
    await i.readMessage(await r.writeMessage());
    const first = i.writeMessage(); // msg3 needs `se` with the slow static key
    await expect(i.writeMessage()).rejects.toMatchObject({ code: 'state', message: /concurrent/ });
    release();
    await expect(first).resolves.toBeInstanceOf(Uint8Array);
  });

  it('wraps a DH failure (low-order point) as NoiseError("dh") and fails closed', async () => {
    const { i, r } = pair();
    await r.readMessage(await i.writeMessage());
    const msg2 = await r.writeMessage();
    const lowOrder = msg2.slice();
    lowOrder.fill(0, 0, 32); // the responder's ephemeral becomes u = 0
    await expect(i.readMessage(lowOrder)).rejects.toMatchObject({ code: 'dh' });
  });

  it('rejects wrong PSK configuration', () => {
    expect(() => new HandshakeState({ suite: nobleSuite, pattern: XXpsk3, initiator: true })).toThrow(/needs 1 psk/);
    expect(() => new HandshakeState({ suite: nobleSuite, pattern: XXpsk3, initiator: true, psks: [new Uint8Array(31)] })).toThrow(/32 bytes/);
    expect(() => new HandshakeState({ suite: nobleSuite, pattern: XX, initiator: true, psks: [new Uint8Array(32)] })).toThrow(/needs 0/);
  });

  it('a psk-mode msg1 is authenticated (48 bytes, tag over h(prologue)); plain XX msg1 is not (32 bytes)', async () => {
    const psk = new Uint8Array(32).fill(7);
    const withPsk = pair({ pattern: XXpsk3, psk });
    const msg1 = await withPsk.i.writeMessage();
    expect(msg1).toHaveLength(48);
    const tampered = msg1.slice();
    tampered[40] = (tampered[40] as number) ^ 1;
    await expect(withPsk.r.readMessage(tampered)).rejects.toMatchObject({ code: 'decrypt' });
    const plain = pair();
    expect(await plain.i.writeMessage()).toHaveLength(32);
  });

  it('a wrong PSK is detected by the responder at msg3', async () => {
    const i = new HandshakeState({ suite: nobleSuite, pattern: XXpsk3, initiator: true, s: x25519KeyPair(), psks: [new Uint8Array(32).fill(1)] });
    const r = new HandshakeState({ suite: nobleSuite, pattern: XXpsk3, initiator: false, s: x25519KeyPair(), psks: [new Uint8Array(32).fill(2)] });
    await r.readMessage(await i.writeMessage());
    await i.readMessage(await r.writeMessage());
    await expect(r.readMessage(await i.writeMessage())).rejects.toMatchObject({ code: 'decrypt' });
  });

  it('why XX and not IK for reconnects: a recorded IK msg1 is accepted again by a fresh responder (noise.md V9)', async () => {
    const IK = resolveHandshakePattern('IK', ALL_HANDSHAKE_PATTERNS);
    const daemon = x25519KeyPair();
    const init = new HandshakeState({ suite: nobleSuite, pattern: IK, initiator: true, s: x25519KeyPair(), rs: daemon.publicKey });
    const msg1 = await init.writeMessage(utf8Encode('file.write /etc/x'));
    for (let n = 0; n < 2; n++) {
      const resp = new HandshakeState({ suite: nobleSuite, pattern: IK, initiator: false, s: daemon });
      expect(await resp.readMessage(msg1)).toEqual(utf8Encode('file.write /etc/x'));
    }
  });
});

describe('CipherState', () => {
  it('fails closed at nonce 2^53-1 and encodes nonces as LE64', () => {
    const cs = new CipherState(nobleSuite, new Uint8Array(32).fill(3));
    (cs as unknown as { n: number }).n = Number.MAX_SAFE_INTEGER - 1;
    cs.encryptWithAd(EMPTY_BYTES, utf8Encode('last'));
    expect(() => cs.encryptWithAd(EMPTY_BYTES, utf8Encode('one too many'))).toThrow(/nonce exhausted/);
    for (const n of [0, 1, 0xffffffff, 0x1_0000_0000, 0x1_2345_6789_abcd, Number.MAX_SAFE_INTEGER]) {
      const want = new Uint8Array(12);
      new DataView(want.buffer).setBigUint64(4, BigInt(n), true);
      expect(chachaPolyNonce(n)).toEqual(want);
    }
    expect(() => chachaPolyNonce(-1)).toThrow(RangeError);
    expect(() => chachaPolyNonce(2 ** 53)).toThrow(RangeError);
  });

  it('does not advance the nonce on a failed decryption', () => {
    const key = new Uint8Array(32).fill(5);
    const send = new CipherState(nobleSuite, key);
    const recv = new CipherState(nobleSuite, key.slice());
    const c0 = send.encryptWithAd(EMPTY_BYTES, utf8Encode('a'));
    const bad = c0.slice();
    bad[0] = (bad[0] as number) ^ 1;
    expect(() => recv.decryptWithAd(EMPTY_BYTES, bad)).toThrow(NoiseError);
    expect(recv.nonce).toBe(0);
    expect(recv.decryptWithAd(EMPTY_BYTES, c0)).toEqual(utf8Encode('a'));
    expect(recv.nonce).toBe(1);
  });
});
