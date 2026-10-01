// DeviceLoginDO: the server-side state of the CLI's device-code login (ARCHITECTURE §6; routes in ./device.ts). One
// SQLite-backed class (the Workers Free plan has no other kind), two kinds of instances, both named by the Worker:
//
//  - `code:<USERCODE>`: one login. The user code is the name, so /device finds it from what the person typed and the
//    token endpoint from the device code (`<USERCODE>.<secret>`). The record keeps a hash of the secret, where and when
//    the login started and, once decided, the outcome and the identity of the browser session that allowed it. It is
//    deleted when the CLI collects the outcome (one-time), and by the alarm when it expires.
//  - `limit:<kind>:<hash>`: a fixed-window counter (wrong codes per account and per IP, starts per IP), deleted by the
//    alarm when its window ends.
//
// Each instance arms at most one alarm, and only while it holds data: an idle relay costs nothing. Polls write
// nothing: the time of the last poll (for `slow_down`) lives in memory; an evicted object forgets it, and the next poll
// is then simply not "too fast".
import { DurableObject } from 'cloudflare:workers';
import { DEVICE_LOGIN_SLOW_DOWN_SECONDS } from '@smurg/protocol/relay';
import { timingSafeEqualString } from '../lib/base64url.ts';
import {
  DEVICE_POLL_SLACK_MS,
  type DeviceLoginInspection,
  type DeviceLoginRecord,
  type DeviceLoginView,
  type DevicePollResult,
} from '../lib/device.ts';
import type { Identity } from './identity.ts';

const KV_LOGIN = 'login';
const KV_WINDOW = 'window';

type LimitWindow = { end: number; count: number };

export class DeviceLoginDO extends DurableObject<Env> {
  private lastPollAt: number | null = null;
  private pollIntervalMs: number | null = null;

  private get kv(): SyncKvStorage {
    return this.ctx.storage.kv;
  }

  // -------------------------------------------------------------------------------------------------------------
  // One login (`code:<USERCODE>`)
  // -------------------------------------------------------------------------------------------------------------

  /** Stores a new login under this user code; false while an unexpired one holds it (the Worker draws another code). */
  async create(record: DeviceLoginRecord): Promise<boolean> {
    const current = this.kv.get<DeviceLoginRecord>(KV_LOGIN);
    if (current !== undefined && current.expiresAt > record.createdAt) return false;
    this.kv.put(KV_LOGIN, record);
    this.lastPollAt = null;
    this.pollIntervalMs = record.interval * 1000;
    await this.ctx.storage.setAlarm(record.expiresAt);
    return true;
  }

  /** The login as the confirmation screen shows it, while it waits for a decision; null otherwise. */
  async pending(now: number): Promise<DeviceLoginView | null> {
    const record = this.live(now);
    if (record === null || record.status !== 'pending') return null;
    const { userCode, createdAt, expiresAt, ip, country, city } = record;
    return { userCode, createdAt, expiresAt, ip, country, city };
  }

  /**
   * The answer from /device, bound to the identity of the browser session that gave it. 'gone' when the login no
   * longer waits for one (decided before, collected, expired): a code is never decided twice, nor by a second account.
   */
  async decide(decision: 'allow' | 'deny', identity: Identity, now: number): Promise<'ok' | 'gone'> {
    const record = this.live(now);
    if (record === null || record.status !== 'pending') return 'gone';
    this.kv.put(KV_LOGIN, decision === 'allow' ? { ...record, status: 'approved', identity } : { ...record, status: 'denied' });
    return 'ok';
  }

  /**
   * The CLI's poll, with the hash of its device code's secret (compared in constant time). The outcome of a decided
   * login is handed out once: the record is deleted with it. A poll with a wrong secret changes nothing (not even the
   * poll timing of the real CLI).
   */
  async poll(secretHash: string, now: number): Promise<DevicePollResult> {
    const record = this.live(now);
    if (record === null || !timingSafeEqualString(secretHash, record.secretHash)) return { status: 'expired' };
    if (record.status === 'pending') {
      const previous = this.lastPollAt;
      this.lastPollAt = now;
      const interval = this.pollIntervalMs ?? record.interval * 1000;
      if (previous !== null && now - previous < interval - DEVICE_POLL_SLACK_MS) {
        // RFC 8628 §3.5: the client adds 5 s to its interval for this and every later poll; so does the relay.
        this.pollIntervalMs = interval + DEVICE_LOGIN_SLOW_DOWN_SECONDS * 1000;
        return { status: 'slow_down' };
      }
      return { status: 'pending' };
    }
    // Delete first, synchronously: nothing can read the outcome a second time.
    this.kv.delete(KV_LOGIN);
    await this.clear();
    return record.status === 'approved' && record.identity !== undefined ? { status: 'approved', identity: record.identity } : { status: 'denied' };
  }

  private live(now: number): DeviceLoginRecord | null {
    const record = this.kv.get<DeviceLoginRecord>(KV_LOGIN);
    return record !== undefined && record.expiresAt > now ? record : null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // A counter (`limit:<kind>:<hash>`)
  // -------------------------------------------------------------------------------------------------------------

  /** The end of the window when `max` events were counted in it already (the caller is refused until then), else null. */
  async blockedUntil(max: number, now: number): Promise<number | null> {
    const window = this.kv.get<LimitWindow>(KV_WINDOW);
    return window !== undefined && window.end > now && window.count >= max ? window.end : null;
  }

  /**
   * Counts one event unless the window is full: null when counted, else the window's end (and nothing is written, so a
   * refused caller costs no write).
   */
  async take(max: number, windowMs: number, now: number): Promise<number | null> {
    const window = this.kv.get<LimitWindow>(KV_WINDOW);
    if (window !== undefined && window.end > now && window.count >= max) return window.end;
    const fresh = window === undefined || window.end <= now;
    const end = fresh ? now + windowMs : window.end;
    this.kv.put(KV_WINDOW, { end, count: fresh ? 1 : window.count + 1 });
    if (fresh) await this.ctx.storage.setAlarm(end);
    return null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Both
  // -------------------------------------------------------------------------------------------------------------

  /** At expiry or the end of the window: delete everything, unless something newer still needs the alarm. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const login = this.kv.get<DeviceLoginRecord>(KV_LOGIN);
    const window = this.kv.get<LimitWindow>(KV_WINDOW);
    const next = Math.min(login !== undefined && login.expiresAt > now ? login.expiresAt : Infinity, window !== undefined && window.end > now ? window.end : Infinity);
    if (next !== Infinity) {
      await this.ctx.storage.setAlarm(next);
      return;
    }
    await this.clear();
  }

  private async clear(): Promise<void> {
    this.lastPollAt = null;
    this.pollIntervalMs = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** TEST ONLY, through the dev-only debug route: what this instance stores (never the secret's hash). */
  async inspect(): Promise<DeviceLoginInspection> {
    const login = this.kv.get<DeviceLoginRecord>(KV_LOGIN);
    const window = this.kv.get<LimitWindow>(KV_WINDOW);
    return {
      login:
        login === undefined
          ? null
          : {
              userCode: login.userCode,
              createdAt: login.createdAt,
              expiresAt: login.expiresAt,
              ip: login.ip,
              country: login.country,
              city: login.city,
              status: login.status,
              userId: login.identity?.userId ?? null,
            },
      window: window ?? null,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  /** TEST ONLY, through the dev-only debug route: the login expires now, as if its ten minutes had passed. */
  async expireNow(): Promise<void> {
    const login = this.kv.get<DeviceLoginRecord>(KV_LOGIN);
    if (login === undefined) return;
    const now = Date.now();
    this.kv.put(KV_LOGIN, { ...login, expiresAt: now });
    await this.ctx.storage.setAlarm(now);
  }
}
