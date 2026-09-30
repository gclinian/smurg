import { toBase64Url } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../testing/services.tsx';
import { makeInvite } from '../../testing/fixtures.ts';
import { clearPendingInvite, parsePendingFragment, pendingInviteKey, readPendingInvite } from './pending-invite.ts';

const WS = 'ws_pending_test_00001';

describe('pending invite: strict parsing (ARCHITECTURE §4.1)', () => {
  it('accepts exactly k and s as canonical 43-character base64url values, in either order', () => {
    const { fragment, fingerprint, secret } = makeInvite();
    const parsed = parsePendingFragment(fragment);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect([...parsed.invite.fingerprint]).toEqual([...fingerprint]);
    expect([...parsed.invite.secret]).toEqual([...secret]);
    const [k, s] = fragment.split('&');
    expect(parsePendingFragment(`${s}&${k}`).kind).toBe('ok');
  });

  it('rejects everything that is not exactly what the host printed', () => {
    const { fragment } = makeInvite();
    const [k, s] = fragment.split('&') as [string, string];
    const kValue = k.slice(2);
    const sValue = s.slice(2);
    const bad = [
      '',
      k,
      s,
      `${fragment}&x=1`,
      `${fragment}&k=${kValue}`,
      `${k}&s=${sValue}=`,
      `${k}&s=${sValue.slice(1)}`,
      `${k}&s=${sValue}A`,
      `${k}&s=${sValue.slice(0, -1)}%41`,
      `K=${kValue}&${s}`,
      `${k}&&${s}`,
      `${k};${s}`,
      `${k}&s=${sValue.slice(0, -1)}+`,
      `${k}&s=${toBase64Url(new Uint8Array(31))}`,
      `k=${kValue} &${s}`,
    ];
    for (const fragmentText of bad) {
      expect(parsePendingFragment(fragmentText).kind, JSON.stringify(fragmentText)).toBe('invalid');
    }
  });

  it('is "none" when nothing was captured', () => {
    expect(parsePendingFragment(null)).toEqual({ kind: 'none' });
    expect(readPendingInvite(new MemoryStorage(), WS)).toEqual({ kind: 'none' });
  });

  it('reads from and clears the tab storage', () => {
    const storage = new MemoryStorage();
    const { fragment } = makeInvite();
    storage.setItem(pendingInviteKey(WS), fragment);
    expect(readPendingInvite(storage, WS).kind).toBe('ok');
    clearPendingInvite(storage, WS);
    expect(storage.getItem(pendingInviteKey(WS))).toBeNull();
    expect(readPendingInvite(storage, WS).kind).toBe('none');
  });

  it('keeps invites of different workspaces apart', () => {
    const storage = new MemoryStorage();
    storage.setItem(pendingInviteKey(WS), makeInvite().fragment);
    expect(readPendingInvite(storage, 'ws_other_workspace_0001').kind).toBe('none');
  });
});
