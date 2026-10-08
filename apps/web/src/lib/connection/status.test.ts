import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '@smurg/protocol/client';
import { makeWelcome } from '../../testing/fixtures.ts';
import { describeConnection, reloadIsAWayOut, secondsUntil } from './status.ts';
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

  // A `version` refusal says nothing but that word. Which side has to act is told from what the page can find out:
  // whether the relay serves another page by now (lib/page-build.ts).
  describe('a version refusal: which side has to act', () => {
    const refused: ConnectionState = { kind: 'rejected', reason: 'version' };

    it('the relay serves another page: this tab is from before an update, and the cure is Reload', () => {
      const view = describeConnection(refused, { pageBuild: 'stale' });
      expect(view).toMatchObject({ kind: 'rejected', blocking: true, title: 'This tab is from before an update' });
      expect(view.body).toBe('smurg was updated while this tab was open, and the tab still runs the page from before. Reload the page to get the new one.');
    });

    it("this tab runs the current page: the host's smurg is the older side, and the text says what the host does and that this page is reloaded afterwards", () => {
      const view = describeConnection(refused, { pageBuild: 'current' });
      expect(view.title).toBe("The host's smurg is older than this page");
      expect(view.body).toBe('The host stops sharing, runs smurg update and shares again (a host who runs their own relay deploys the relay again). Then reload this page.');
    });

    it('the relay could not be asked: both steps, the reload first', () => {
      for (const facts of [{ pageBuild: 'unknown' } as const, {}, undefined]) {
        const view = describeConnection(refused, facts);
        expect(view.title).toBe('Incompatible versions');
        expect(view.body).toBe(
          "This page and smurg on the host's computer are not compatible. Reload the page. If the page says this again, the host's smurg is older than the page: the host stops sharing, runs smurg update and shares again (a host who runs their own relay deploys the relay again); then reload this page.",
        );
      }
    });

    it('while the relay is being asked the page says so, and says nothing it may have to take back', () => {
      const view = describeConnection(refused, { pageBuild: 'checking' });
      expect(view.title).toBe('Incompatible versions');
      expect(view.body).toBe('Checking whether this tab runs the newest page…');
    });

    it('in both languages every answer has its own words, and none tells the person there is nothing to do', () => {
      for (const locale of ['en', 'zh-TW'] as const) {
        applyLocale(locale);
        const bodies = (['stale', 'current', 'unknown', 'checking'] as const).map((pageBuild) => {
          const view = describeConnection(refused, { pageBuild });
          for (const text of [view.title ?? '', view.body ?? '', view.detail]) {
            expect(text.trim()).not.toBe('');
            expect(HAN.test(text), `${locale} ${pageBuild}: ${text}`).toBe(locale === 'zh-TW');
          }
          return view.body as string;
        });
        expect(new Set(bodies).size).toBe(4);
        // Every answer that is final names the reload.
        for (const body of bodies.slice(0, 3)) expect(body).toMatch(locale === 'en' ? /[Rr]eload/ : /重新整理/);
        for (const body of bodies) expect(body).not.toMatch(/nothing to do|do nothing|不需要做|不用做/);
      }
    });

    it('the facts change nothing for any other state', () => {
      for (const state of ALL) {
        if (state.kind === 'rejected' && state.reason === 'version') continue;
        expect(describeConnection(state, { pageBuild: 'stale' }), JSON.stringify(state)).toEqual(describeConnection(state));
      }
    });
  });

  // The key store stopped at a record a newer page wrote (packages/protocol/src/browser/key-stores.ts: 'newer-record').
  // The engine only knows "the storage failed"; the page knows why and says the one thing that helps.
  describe("the browser's key was written by a newer page", () => {
    const closed: ConnectionState = { kind: 'closed', reason: 'storage-error' };

    it('says so, says that nothing was changed, and tells the person to reload', () => {
      const view = describeConnection(closed, { newerKeyRecord: true });
      expect(view).toMatchObject({ kind: 'closed', blocking: true, title: "This browser's smurg key was written by a newer page" });
      expect(view.body).toBe('A newer smurg page stored the key this browser uses for this workspace, in a form this tab cannot read. Nothing was changed. Reload the page to get the newer one.');
      applyLocale('zh-TW');
      const zh = describeConnection(closed, { newerKeyRecord: true });
      expect(zh.title).toContain('金鑰');
      expect(zh.body).toContain('重新整理');
      expect(zh.body).not.toBe(describeConnection(closed).body);
    });

    it('any other storage failure keeps its own words, and the fact changes nothing for any other state', () => {
      expect(describeConnection(closed, { newerKeyRecord: false }).title).toBe('Cannot read or write the device key');
      expect(describeConnection(closed).title).toBe('Cannot read or write the device key');
      for (const state of ALL) {
        if (state.kind === 'closed' && state.reason === 'storage-error') continue;
        expect(describeConnection(state, { newerKeyRecord: true }), JSON.stringify(state)).toEqual(describeConnection(state));
      }
    });
  });

  // Read by the ended screen (the "Reload the page" button) and by the join page (which keeps the invite through
  // exactly these refusals: app/pages/JoinPage.test.tsx).
  describe('for which ended states a reload is a way out', () => {
    it('refused for its version, a login the host could not verify, a refusal without a reason; and a key a newer page wrote', () => {
      const yes = ALL.filter((state) => reloadIsAWayOut(state)).map((state) => `${state.kind}/${'reason' in state ? state.reason : ''}`);
      expect(yes).toEqual(['rejected/identity-invalid', 'rejected/version', 'rejected/unknown']);
      // What the page found out about the version changes the words, never whether a reload is offered.
      for (const pageBuild of ['stale', 'current', 'unknown', 'checking'] as const) expect(reloadIsAWayOut({ kind: 'rejected', reason: 'version' }, { pageBuild })).toBe(true);
      // The storage failed: only when it stopped at a newer page's record does a reload get the page that reads it.
      expect(reloadIsAWayOut({ kind: 'closed', reason: 'storage-error' })).toBe(false);
      expect(reloadIsAWayOut({ kind: 'closed', reason: 'storage-error' }, { newerKeyRecord: false })).toBe(false);
      expect(reloadIsAWayOut({ kind: 'closed', reason: 'storage-error' }, { newerKeyRecord: true })).toBe(true);
    });

    it('never for a refusal that ends the link or the membership, and never while the connection is still trying', () => {
      for (const state of ALL) {
        if (state.kind === 'rejected' && (state.reason === 'version' || state.reason === 'identity-invalid' || state.reason === 'unknown')) continue;
        if (state.kind === 'closed' && state.reason === 'storage-error') continue;
        expect(reloadIsAWayOut(state, { newerKeyRecord: true, pageBuild: 'stale' }), JSON.stringify(state)).toBe(false);
      }
    });
  });

  it('counts retry seconds up, never below zero', () => {
    expect(secondsUntil(10_000, 7_100)).toBe(3);
    expect(secondsUntil(10_000, 12_000)).toBe(0);
  });
});
