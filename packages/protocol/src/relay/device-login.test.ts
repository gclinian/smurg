import { describe, expect, it } from 'vitest';
import {
  DEVICE_CODE_PATTERN,
  DEVICE_TOKEN_ERRORS,
  DEVICE_USER_CODE_ALPHABET,
  formatDeviceUserCode,
  normalizeDeviceUserCode,
  relayDeviceStartSchema,
} from './device-login.ts';

const SECRET = 'A'.repeat(42) + 'g';

describe('device user codes (RFC 8628 §6.1)', () => {
  it('uses the base-20 consonant alphabet: no vowels, no digits, nothing that reads as another character', () => {
    expect(DEVICE_USER_CODE_ALPHABET).toBe('BCDFGHJKLMNPQRSTVWXZ');
    expect(new Set(DEVICE_USER_CODE_ALPHABET).size).toBe(20);
    expect(DEVICE_USER_CODE_ALPHABET).not.toMatch(/[AEIOUY0-9]/);
  });

  it('accepts what a person types: any case, with or without the hyphen, spaces, full-width input', () => {
    for (const typed of ['WDJB-MJHT', 'wdjb-mjht', 'WDJBMJHT', 'wdjbmjht', ' wdjb mjht ', 'WDJB – MJHT', 'ＷＤＪＢ－ＭＪＨＴ', 'w-d-j-b-m-j-h-t', 'WDJB\tMJHT']) {
      expect(normalizeDeviceUserCode(typed), typed).toBe('WDJBMJHT');
    }
  });

  it('refuses anything that is not eight letters of the alphabet', () => {
    for (const typed of ['', 'WDJB-MJH', 'WDJB-MJHTX', 'WDJA-MJHT', 'WDJB-MJH1', 'WDJB_MJHT', 'WDJB.MJHT', 'WDJB-MJHT\u0000', 'Ｗ'.repeat(70), 'ẞDJB-MJHT']) {
      expect(normalizeDeviceUserCode(typed), JSON.stringify(typed)).toBeNull();
    }
  });

  it('formats a normalised code as XXXX-XXXX and refuses anything else', () => {
    expect(formatDeviceUserCode('WDJBMJHT')).toBe('WDJB-MJHT');
    expect(() => formatDeviceUserCode('WDJB-MJHT')).toThrow(RangeError);
    expect(() => formatDeviceUserCode('wdjbmjht')).toThrow(RangeError);
  });
});

describe('device codes and the start response', () => {
  it('a device code is the normalised user code and a 256-bit base64url secret', () => {
    expect(DEVICE_CODE_PATTERN.exec(`WDJBMJHT.${SECRET}`)?.slice(1)).toEqual(['WDJBMJHT', SECRET]);
    for (const bad of [`WDJB-MJHT.${SECRET}`, `wdjbmjht.${SECRET}`, `WDJBMJHT.${SECRET}x`, `WDJBMJHT.${SECRET.slice(1)}`, `WDJBMJHT${SECRET}`, `WDJBMJHT.${SECRET.slice(1)}=`]) {
      expect(DEVICE_CODE_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('parses the relay start response strictly', () => {
    const ok = { deviceCode: `WDJBMJHT.${SECRET}`, userCode: 'WDJB-MJHT', verificationUri: 'https://app.smurg.ai/device', expiresIn: 600, interval: 5 };
    expect(relayDeviceStartSchema.parse(ok)).toEqual(ok);
    for (const bad of [
      { ...ok, userCode: 'WDJBMJHT' },
      { ...ok, userCode: 'wdjb-mjht' },
      { ...ok, verificationUri: 'https://app.smurg.ai/device?code=WDJBMJHT' },
      { ...ok, verificationUri: 'https://app.smurg.ai/device#WDJBMJHT' },
      { ...ok, verificationUri: 'javascript:alert(1)' },
      { ...ok, interval: 0 },
      { ...ok, expiresIn: -1 },
      { ...ok, extra: true },
    ]) {
      expect(relayDeviceStartSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('names exactly the token errors the CLI understands', () => {
    expect([...DEVICE_TOKEN_ERRORS]).toEqual(['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_request']);
  });
});
