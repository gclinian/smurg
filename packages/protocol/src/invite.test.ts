import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NOISE_PROLOGUE_TAG } from './constants.ts';
import { concatBytes, fromHex, toBase64Url, toHex, utf8Encode } from './bytes.ts';
import {
  InviteLinkError,
  buildInviteFragment,
  buildInviteUrl,
  buildNoisePrologue,
  daemonKeyFingerprint,
  deriveInviteKeys,
  formatFingerprintForDisplay,
  generateInviteSecret,
  handshakeModeFromByte,
  inviteWebOrigin,
  parseInviteFragment,
  parseInviteUrl,
} from './invite.ts';

const WS = 'ws_test_0123456789';
const SECRET = new Uint8Array(32).map((_, i) => i);
const DAEMON_PUB = new Uint8Array(32).map((_, i) => 0xa0 + i);

describe('derivations (ARCHITECTURE §4.1)', () => {
  it('k = BLAKE2s-256(label ‖ daemon key), cross-checked with OpenSSL', () => {
    const k = daemonKeyFingerprint(DAEMON_PUB);
    const openssl = createHash('blake2s256').update(utf8Encode('smurg/v1 daemon static key fingerprint')).update(DAEMON_PUB).digest();
    expect(toHex(k)).toBe(openssl.toString('hex'));
    expect(toHex(k)).toBe('df08a1fca48fd408825de0881c7fd87689b89199659c3f1051d19a1c7cafcee2');
    expect(toBase64Url(k)).toHaveLength(43);
  });

  it('inviteId and psk are keyed BLAKE2s of fixed labels (known answers, equal to the verified spike)', () => {
    const { inviteId, psk } = deriveInviteKeys(SECRET);
    expect(toHex(inviteId)).toBe('3da756c20f8526607260f2e1147b2249');
    expect(toHex(psk)).toBe('97f7fec6bbece2c88902cbbb5cb39014cd89688a86f2651202a58fc2f38a139f');
    expect(inviteId).toHaveLength(16);
    expect(psk).toHaveLength(32);
  });

  it('rejects secrets and keys of the wrong size', () => {
    expect(() => deriveInviteKeys(new Uint8Array(31))).toThrow(RangeError);
    expect(() => daemonKeyFingerprint(new Uint8Array(33))).toThrow(RangeError);
  });

  it('generates distinct 32-byte secrets', () => {
    const a = generateInviteSecret();
    expect(a).toHaveLength(32);
    expect(toHex(a)).not.toBe(toHex(generateInviteSecret()));
  });

  it('formats a safety number for humans', () => {
    expect(formatFingerprintForDisplay(daemonKeyFingerprint(DAEMON_PUB))).toBe('df08 a1fc a48f d408 825d');
  });
});

describe('invite fragment', () => {
  const fragment = buildInviteFragment(DAEMON_PUB, SECRET);
  const [kPart, sPart] = fragment.split('&') as [string, string];

  it('round-trips, with or without "#", in either order', () => {
    const expected = { fingerprint: daemonKeyFingerprint(DAEMON_PUB), secret: SECRET };
    expect(parseInviteFragment(fragment)).toEqual(expected);
    expect(parseInviteFragment(`#${fragment}`)).toEqual(expected);
    expect(parseInviteFragment(`${sPart}&${kPart}`)).toEqual(expected);
  });

  const k = kPart.slice(2);
  const s = sPart.slice(2);
  const nonCanonical = s.slice(0, 42) + String.fromCharCode(s.charCodeAt(42) ^ 1);
  it.each([
    ['empty', ''],
    ['missing s', `k=${k}`],
    ['missing k', `s=${s}`],
    ['extra parameter', `k=${k}&s=${s}&x=1`],
    ['duplicate k', `k=${k}&k=${k}&s=${s}`],
    ['empty value', `k=&s=${s}`],
    ['no "="', `k&s=${s}`],
    ['padding', `k=${k}=&s=${s}`],
    ['short value', `k=${k.slice(1)}&s=${s}`],
    ['long value', `k=${k}A&s=${s}`],
    ['standard base64 alphabet', `k=${k.replace(/_/g, '/').replace(/-/g, '+')}&s=${s.replace(/./, '+')}`],
    ['percent-encoded', `k=${k.slice(0, 40)}%41${k.slice(41)}&s=${s}`],
    ['non-canonical trailing bits', `k=${k}&s=${nonCanonical}`],
    ['trailing "&"', `k=${k}&s=${s}&`],
    ['uppercase key', `K=${k}&s=${s}`],
  ])('rejects %s', (_name, text) => {
    expect(() => parseInviteFragment(text)).toThrow(InviteLinkError);
  });
});

describe('invite URL', () => {
  it('builds the documented shape and parses it back', () => {
    const url = buildInviteUrl('https://smurg.app', WS, DAEMON_PUB, SECRET);
    expect(url).toBe(`https://smurg.app/join/${WS}#k=3wih_KSP1AiCXeCIHH_Ydom4kZllnD8QUdGaHHyvzuI&s=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`);
    expect(parseInviteUrl(url)).toEqual({
      origin: 'https://smurg.app',
      workspaceId: WS,
      fingerprint: daemonKeyFingerprint(DAEMON_PUB),
      secret: SECRET,
    });
  });

  it('allows http only for local hostnames', () => {
    expect(buildInviteUrl('http://localhost:5173', WS, DAEMON_PUB, SECRET)).toMatch(/^http:\/\/localhost:5173\/join\//);
    expect(parseInviteUrl(buildInviteUrl('http://127.0.0.1:8787', WS, DAEMON_PUB, SECRET)).origin).toBe('http://127.0.0.1:8787');
    expect(() => buildInviteUrl('http://smurg.app', WS, DAEMON_PUB, SECRET)).toThrow(InviteLinkError);
  });

  it.each([
    ['origin with a path', 'https://smurg.app/x'],
    ['origin with credentials', 'https://user:pw@smurg.app'],
    ['origin with a query', 'https://smurg.app?x=1'],
    ['not a URL', 'smurg.app'],
    ['javascript URL', 'javascript:alert(1)'],
  ])('rejects %s', (_name, origin) => {
    expect(() => inviteWebOrigin(origin)).toThrow(InviteLinkError);
  });

  it('rejects invalid workspace ids when building', () => {
    for (const bad of ['short', '../../../etc/passwd', 'ws with spaces 0123', 'x'.repeat(65)]) {
      expect(() => buildInviteUrl('https://smurg.app', bad, DAEMON_PUB, SECRET)).toThrow(InviteLinkError);
    }
  });

  it.each([
    ['http for a public host', (u: string) => u.replace('https://', 'http://')],
    ['a trailing slash', (u: string) => u.replace('#', '/#')],
    ['a query', (u: string) => u.replace('#', '?ref=1#')],
    ['another path', (u: string) => u.replace('/join/', '/w/')],
    ['a nested path', (u: string) => u.replace('/join/', '/x/join/')],
    ['no fragment', (u: string) => u.slice(0, u.indexOf('#'))],
    ['a percent-encoded workspace id', (u: string) => u.replace('/join/w', '/join/%77')],
    ['credentials', (u: string) => u.replace('https://', 'https://a:b@')],
  ])('parse rejects %s', (_name, mutate) => {
    const url = mutate(buildInviteUrl('https://smurg.app', WS, DAEMON_PUB, SECRET));
    expect(() => parseInviteUrl(url)).toThrow(InviteLinkError);
  });
});

describe('Noise prologue', () => {
  it('is "smurg-noise/1" ‖ 0x00 ‖ len ‖ workspaceId ‖ mode ‖ inviteId', () => {
    const { inviteId } = deriveInviteKeys(SECRET);
    const expected = concatBytes(utf8Encode(NOISE_PROLOGUE_TAG), new Uint8Array([0, WS.length]), utf8Encode(WS), new Uint8Array([1]), inviteId);
    expect(buildNoisePrologue(WS, 'invite', inviteId)).toEqual(expected);
    expect(toHex(buildNoisePrologue(WS, 'invite', inviteId))).toBe(
      '736d7572672d6e6f6973652f31001277735f746573745f30313233343536373839013da756c20f8526607260f2e1147b2249',
    );
    expect(buildNoisePrologue(WS, 'device')).toEqual(concatBytes(utf8Encode(NOISE_PROLOGUE_TAG), fromHex('0012'), utf8Encode(WS), fromHex('02')));
  });

  it('requires the invite id exactly in invite mode', () => {
    const { inviteId } = deriveInviteKeys(SECRET);
    expect(() => buildNoisePrologue(WS, 'invite')).toThrow(RangeError);
    expect(() => buildNoisePrologue(WS, 'invite', inviteId.subarray(1))).toThrow(RangeError);
    expect(() => buildNoisePrologue(WS, 'device', inviteId)).toThrow(RangeError);
    expect(() => buildNoisePrologue('bad id', 'device')).toThrow(RangeError);
    expect(() => buildNoisePrologue(WS, 'other' as 'device')).toThrow(RangeError);
  });

  it('maps mode bytes strictly', () => {
    expect(handshakeModeFromByte(1)).toBe('invite');
    expect(handshakeModeFromByte(2)).toBe('device');
    expect(handshakeModeFromByte(0)).toBeNull();
    expect(handshakeModeFromByte(3)).toBeNull();
    expect(handshakeModeFromByte(undefined)).toBeNull();
  });
});
