import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '@smurg/protocol/client';
import { makeWelcome } from '../../testing/fixtures.ts';
import { describeConnection, secondsUntil } from './status.ts';
import { applyLocale } from '../locale.ts';

const ALL: readonly ConnectionState[] = [
  { kind: 'idle' },
  { kind: 'connecting', attempt: 1, retryAt: null, cause: null },
  { kind: 'connecting', attempt: 3, retryAt: 5_000, cause: 'timeout' },
  { kind: 'connecting', attempt: 2, retryAt: 5_000, cause: 'aborted' },
  { kind: 'connecting', attempt: 2, retryAt: 5_000, cause: 'busy' },
  { kind: 'connecting', attempt: 2, retryAt: 5_000, cause: 'protocol' },
  { kind: 'connecting', attempt: 2, retryAt: 5_000, cause: 'stalled' },
  { kind: 'connecting', attempt: 1, retryAt: 1_000, cause: 'role-changed' },
  { kind: 'handshaking', mode: 'invite', attempt: 1 },
  { kind: 'handshaking', mode: 'device', attempt: 1 },
  { kind: 'online', welcome: makeWelcome(), resumed: false },
  { kind: 'online', welcome: makeWelcome(), resumed: true },
  { kind: 'host-offline', reason: 'relay', since: 0 },
  { kind: 'host-offline', reason: 'silence', since: 0 },
  { kind: 'host-offline', reason: 'stopped', since: 0 },
  { kind: 'relay-unreachable', attempt: 2, retryAt: 9_000, cause: 'closed' },
  { kind: 'key-mismatch', mode: 'invite', detail: 'fingerprint' },
  { kind: 'key-mismatch', mode: 'device', detail: 'unauthenticated' },
  { kind: 'rejected', reason: 'invite-invalid' },
  { kind: 'rejected', reason: 'device-revoked' },
  { kind: 'rejected', reason: 'device-other-account' },
  { kind: 'rejected', reason: 'identity-invalid' },
  { kind: 'rejected', reason: 'kicked' },
  { kind: 'rejected', reason: 'version' },
  { kind: 'rejected', reason: 'unknown' },
  { kind: 'rejected', reason: 'aborted' },
  { kind: 'closed', reason: 'local' },
  { kind: 'closed', reason: 'kicked', daemonReason: 'kicked' },
  { kind: 'closed', reason: 'revoked' },
  { kind: 'closed', reason: 'login-required' },
  { kind: 'closed', reason: 'relay-refused' },
  { kind: 'closed', reason: 'no-trust' },
  { kind: 'closed', reason: 'storage-error' },
];

const TERMINAL = new Set(['key-mismatch', 'rejected', 'closed']);

const HAN = /[\u3400-\u9fff]/u;

describe('connection state → UI', () => {
  it('names every state in the viewer\'s language, and only terminal states block the UI', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      applyLocale(locale);
      for (const state of ALL) {
        const view = describeConnection(state);
        const texts = [view.label, view.detail, ...(view.blocking ? [view.title ?? '', view.body ?? ''] : [])];
        for (const text of texts) {
          expect(text.trim(), JSON.stringify(state)).not.toBe('');
          expect(HAN.test(text), `${locale} ${JSON.stringify(state)}: ${text}`).toBe(locale === 'zh-TW');
        }
        expect(view.blocking, JSON.stringify(state)).toBe(TERMINAL.has(state.kind));
      }
    }
  });

  it('host offline shows "Host offline", and relay unreachable says something DIFFERENT', () => {
    const offline = describeConnection({ kind: 'host-offline', reason: 'relay', since: 0 });
    const unreachable = describeConnection({ kind: 'relay-unreachable', attempt: 1, retryAt: 1, cause: 'watchdog' });
    expect(offline.label).toBe('Host offline');
    expect(offline.kind).toBe('host-offline');
    expect(unreachable.kind).toBe('relay-unreachable');
    expect(unreachable.label).toBe('Server unreachable');
    expect(unreachable.detail).toContain('the host is not offline');
    expect(offline.blocking).toBe(false);
    expect(unreachable.blocking).toBe(false);
  });

  it('distinguishes connecting, retrying, handshaking, role change and kicked', () => {
    expect(describeConnection({ kind: 'connecting', attempt: 1, retryAt: null, cause: null }).kind).toBe('connecting');
    expect(describeConnection({ kind: 'connecting', attempt: 2, retryAt: 10, cause: 'busy' }).kind).toBe('retrying');
    expect(describeConnection({ kind: 'handshaking', mode: 'device', attempt: 1 }).kind).toBe('handshaking');
    expect(describeConnection({ kind: 'connecting', attempt: 1, retryAt: 0, cause: 'role-changed' }).kind).toBe('role-changed');
    expect(describeConnection({ kind: 'closed', reason: 'kicked' }).kind).toBe('kicked');
    expect(describeConnection({ kind: 'rejected', reason: 'kicked' }).kind).toBe('kicked');
    expect(describeConnection({ kind: 'closed', reason: 'login-required' }).kind).toBe('login-required');
  });

  it('key mismatch is a blocking danger state explaining the refused connection', () => {
    const view = describeConnection({ kind: 'key-mismatch', mode: 'invite', detail: 'fingerprint' });
    expect(view).toMatchObject({ kind: 'key-mismatch', tone: 'danger', blocking: true });
    expect(view.title).toBe('Security warning: connection refused');
    applyLocale('zh-TW');
    expect(describeConnection({ kind: 'key-mismatch', mode: 'invite', detail: 'fingerprint' }).title).toContain('已拒絕連線');
  });

  it('counts retry seconds up, never below zero', () => {
    expect(secondsUntil(10_000, 7_100)).toBe(3);
    expect(secondsUntil(10_000, 12_000)).toBe(0);
  });
});
