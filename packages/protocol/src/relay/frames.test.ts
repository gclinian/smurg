import { describe, expect, it } from 'vitest';
import { RELAY_CONTROL_MAX_CHARS } from '../constants.ts';
import { RELAY_CLOSE_CODES, truncateCloseReason, utf8ByteLength } from './close-codes.ts';
import {
  RELAY_PING,
  RELAY_PONG,
  encodeRelayControl,
  parseHostToRelayText,
  parseRelayToClientText,
  parseRelayToHostText,
  sanitizeRelayDisplayName,
  type RelayControlFrame,
} from './frames.ts';

const json = (value: unknown) => JSON.stringify(value);

describe('heartbeat literals', () => {
  it('are the exact auto-response strings', () => {
    expect(RELAY_PING).toBe('ping');
    expect(RELAY_PONG).toBe('pong');
    expect(parseRelayToClientText('pong')).toEqual({ kind: 'pong' });
    expect(parseRelayToHostText('pong')).toEqual({ kind: 'pong' });
    expect(parseHostToRelayText('ping')).toEqual({ kind: 'ping' });
  });

  it('are case- and whitespace-exact', () => {
    expect(parseRelayToClientText('PONG').kind).toBe('invalid');
    expect(parseRelayToClientText('pong\n').kind).toBe('invalid');
  });
});

describe('relay -> client frames', () => {
  it('parses hello, host.online, host.offline and bye', () => {
    const frames = [
      { t: 'hello', conn: 1, host: false },
      { t: 'host.online' },
      { t: 'host.offline', reason: 'timeout' },
      { t: 'host.offline', reason: 'closed' },
      { t: 'bye', code: 4000, reason: 'heartbeat timeout' },
      { t: 'bye', code: 1009, reason: '' },
    ];
    for (const frame of frames) {
      expect(parseRelayToClientText(json(frame))).toEqual({ kind: 'control', frame });
    }
  });

  it('rejects frames meant for the host, unknown types and extra keys', () => {
    for (const frame of [
      { t: 'peer.open', conn: 1, userId: 'dev:amy', displayName: 'Amy' },
      { t: 'surprise' },
      { t: 'host.online', extra: true },
      { t: 'hello', conn: 1, host: 'online' },
      { t: 'hello', conn: 0, host: true },
      { t: 'hello', conn: 2 ** 32, host: true },
      { t: 'host.offline', reason: 'sleeping' },
      { t: 'bye', code: 4002, reason: 'x' },
    ]) {
      const parsed = parseRelayToClientText(json(frame));
      expect(parsed.kind).toBe('invalid');
    }
  });

  it('rejects non-JSON and oversized text before parsing', () => {
    expect(parseRelayToClientText('{not json')).toMatchObject({ kind: 'invalid', reason: 'not-json' });
    expect(parseRelayToClientText('"x"'.padEnd(RELAY_CONTROL_MAX_CHARS + 1, ' '))).toMatchObject({
      kind: 'invalid',
      reason: 'too-large',
    });
  });

  it('rejects a __proto__ key instead of ignoring it', () => {
    expect(parseRelayToClientText('{"t":"host.online","__proto__":{"polluted":true}}').kind).toBe('invalid');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('relay -> host frames', () => {
  it('parses peer.open (with and without avatar), peer.close and bye', () => {
    const frames = [
      { t: 'peer.open', conn: 3, userId: 'github:12345', displayName: 'Ian 林', avatarUrl: 'https://avatars.example/u/1' },
      { t: 'peer.open', conn: 4, userId: 'google:110248495921238986420', displayName: 'Amy' },
      { t: 'peer.open', conn: 5, userId: 'dev:bob', displayName: 'bob' },
      { t: 'peer.close', conn: 3 },
      { t: 'bye', code: 4001, reason: 'replaced by newer host connection' },
    ];
    for (const frame of frames) {
      expect(parseRelayToHostText(json(frame))).toEqual({ kind: 'control', frame });
    }
  });

  it('rejects malformed identities', () => {
    const base = { t: 'peer.open', conn: 1, userId: 'dev:amy', displayName: 'Amy' };
    for (const patch of [
      { userId: 'amy' },
      { userId: 'github:abc' },
      { userId: 'github:0123' },
      { userId: 'dev:has space' },
      { userId: 'mastodon:1' },
      { displayName: '' },
      { displayName: '   ' },
      { displayName: 'evil‮gnp.exe' },
      { displayName: 'line\nbreak' },
      { displayName: 'x'.repeat(257) },
      { avatarUrl: 'http://avatars.example/u/1' },
      { avatarUrl: 'javascript:alert(1)' },
      { avatarUrl: 'https://user:pw@avatars.example/u/1' },
    ]) {
      expect(parseRelayToHostText(json({ ...base, ...patch })).kind).toBe('invalid');
    }
  });

  it('rejects frames meant for clients', () => {
    expect(parseRelayToHostText(json({ t: 'hello', conn: 1, host: true })).kind).toBe('invalid');
  });
});

describe('host -> relay frames', () => {
  it('parses peer.kick and bounds the reason to 123 bytes of UTF-8', () => {
    const ok = { t: 'peer.kick', conn: 9, reason: '已被主人移出工作區' };
    expect(parseHostToRelayText(json(ok))).toEqual({ kind: 'control', frame: ok });
    // 41 CJK characters = 123 bytes (fits), 42 = 126 bytes (does not)
    expect(parseHostToRelayText(json({ ...ok, reason: '踢'.repeat(41) })).kind).toBe('control');
    expect(parseHostToRelayText(json({ ...ok, reason: '踢'.repeat(42) })).kind).toBe('invalid');
    expect(parseHostToRelayText(json({ t: 'peer.kick', conn: 9 })).kind).toBe('invalid');
  });
});

describe('encodeRelayControl', () => {
  it('round-trips through the direction parsers', () => {
    const hello: RelayControlFrame = { t: 'hello', conn: 12, host: true };
    expect(parseRelayToClientText(encodeRelayControl(hello))).toEqual({ kind: 'control', frame: hello });
    const kick: RelayControlFrame = { t: 'peer.kick', conn: 12, reason: 'kicked' };
    expect(parseHostToRelayText(encodeRelayControl(kick))).toEqual({ kind: 'control', frame: kick });
  });

  it('refuses to put an invalid frame on the wire', () => {
    expect(() => encodeRelayControl({ t: 'hello', conn: 0, host: true })).toThrow();
    expect(() =>
      encodeRelayControl({ t: 'bye', code: RELAY_CLOSE_CODES.kicked, reason: 'x'.repeat(124) }),
    ).toThrow();
  });
});

describe('truncateCloseReason / sanitizeRelayDisplayName', () => {
  it('cuts close reasons at 123 bytes without splitting a code point', () => {
    const cut = truncateCloseReason('界'.repeat(50));
    expect(utf8ByteLength(cut)).toBe(123);
    expect(cut).toBe('界'.repeat(41));
    const emoji = truncateCloseReason('a' + '😀'.repeat(40));
    expect(utf8ByteLength(emoji)).toBeLessThanOrEqual(123);
    expect(emoji.endsWith('\uD83D')).toBe(false);
    expect(truncateCloseReason('short')).toBe('short');
  });

  it('produces names that the schema accepts', () => {
    const cleaned = sanitizeRelayDisplayName('  ‮evil\u0007 Name‏  ', 'fallback');
    expect(cleaned).toBe('evil Name');
    expect(sanitizeRelayDisplayName('\u0000‮', 'octocat')).toBe('octocat');
    expect(sanitizeRelayDisplayName('名'.repeat(300), 'x')).toHaveLength(256);
    const frame = { t: 'peer.open', conn: 1, userId: 'github:1', displayName: cleaned };
    expect(parseRelayToHostText(json(frame)).kind).toBe('control');
  });
});
