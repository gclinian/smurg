import { WORKSPACE_ID_PATTERN } from '@smurg/protocol/relay';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../testing/services.tsx';
import { makeInvite } from '../testing/fixtures.ts';
import {
  JOIN_PATH_PATTERN,
  MAX_CAPTURED_FRAGMENT_CHARS,
  PENDING_INVITE_KEY_PREFIX,
  captureInviteFragment,
  clearInMemoryInvite,
  peekInMemoryInvite,
  type CaptureEnvironment,
} from './capture-invite.ts';

const WS = 'ws_capture_test_000001';

function env(url: string, storage: Pick<Storage, 'setItem'> | null = new MemoryStorage()) {
  const parsed = new URL(url, 'https://smurg.test');
  const location = { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
  const calls: string[] = [];
  const environment: CaptureEnvironment = {
    location,
    history: {
      state: { kept: true },
      replaceState(_data, _unused, next) {
        calls.push(String(next));
        const u = new URL(String(next), 'https://smurg.test');
        Object.assign(location, { pathname: u.pathname, search: u.search, hash: u.hash });
      },
    },
    sessionStorage: storage,
  };
  return { environment, location, calls, storage };
}

describe('invite fragment capture (ARCHITECTURE §4.1)', () => {
  it('copies the fragment of /join/<id> into sessionStorage and removes it from the address bar', () => {
    const { fragment } = makeInvite();
    const storage = new MemoryStorage();
    const { environment, location, calls } = env(`/join/${WS}#${fragment}`, storage);
    const result = captureInviteFragment(environment);
    expect(result).toEqual({ kind: 'captured', workspaceId: WS, persisted: true });
    expect(storage.getItem(PENDING_INVITE_KEY_PREFIX + WS)).toBe(fragment);
    expect(location.hash).toBe('');
    expect(calls).toEqual([`/join/${WS}`]);
  });

  it('works on the real browser globals: afterwards window.location has no fragment', () => {
    const { fragment } = makeInvite();
    window.history.replaceState(null, '', `/join/${WS}?utm=x#${fragment}`);
    expect(window.location.hash).not.toBe('');
    const result = captureInviteFragment({ location: window.location, history: window.history, sessionStorage: window.sessionStorage });
    expect(result.kind).toBe('captured');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('#');
    expect(window.location.search).toBe('?utm=x');
    expect(window.sessionStorage.getItem(PENDING_INVITE_KEY_PREFIX + WS)).toBe(fragment);
    window.history.replaceState(null, '', '/');
  });

  it('strips a fragment on every other route without keeping it', () => {
    const storage = new MemoryStorage();
    const { environment, location } = env(`/w/${WS}#k=abc&s=def`, storage);
    expect(captureInviteFragment(environment)).toEqual({ kind: 'stripped' });
    expect(location.hash).toBe('');
    expect(storage.length).toBe(0);
  });

  it('does nothing without a fragment', () => {
    const { environment, calls } = env(`/join/${WS}`);
    expect(captureInviteFragment(environment)).toEqual({ kind: 'none' });
    expect(calls).toEqual([]);
  });

  it('never stores an oversized fragment (but still removes it)', () => {
    const storage = new MemoryStorage();
    const { environment, location } = env(`/join/${WS}#${'k'.repeat(MAX_CAPTURED_FRAGMENT_CHARS + 1)}`, storage);
    expect(captureInviteFragment(environment)).toEqual({ kind: 'stripped' });
    expect(storage.length).toBe(0);
    expect(location.hash).toBe('');
  });

  it('keeps the fragment in memory when sessionStorage refuses it, and still strips the URL', () => {
    const throwing = { setItem: vi.fn(() => { throw new Error('QuotaExceededError'); }) };
    const { fragment } = makeInvite();
    const { environment, location } = env(`/join/${WS}#${fragment}`, throwing);
    expect(captureInviteFragment(environment)).toEqual({ kind: 'captured', workspaceId: WS, persisted: false });
    expect(peekInMemoryInvite(WS)).toBe(fragment);
    expect(location.hash).toBe('');
    clearInMemoryInvite(WS);
    expect(peekInMemoryInvite(WS)).toBeNull();
  });

  it('uses the same workspace id rule as @smurg/protocol (the module may not import it)', () => {
    const samples = ['a'.repeat(15), 'a'.repeat(16), 'a'.repeat(64), 'a'.repeat(65), 'ws_ok-ID_0123456789', 'ws.bad.dot.1234567', 'ws/bad/slash/12345', '中文中文中文中文中文中文中文中文'];
    for (const id of samples) {
      expect(JOIN_PATH_PATTERN.test(`/join/${id}`), id).toBe(WORKSPACE_ID_PATTERN.test(id));
    }
  });
});
